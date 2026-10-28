from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta

from . import capture, store

_LOGGER = logging.getLogger(__name__)

TICK_S = 10
DAILY_GRACE_MIN = 120  # a missed daily shot is still taken up to 2 h late
RETRY_GAP_MIN = 5


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def current_slot(series: dict, now: datetime) -> str | None:
    """Return the key of the capture slot open right now, if any."""
    date = now.strftime("%Y-%m-%d")
    minute = now.hour * 60 + now.minute
    if series["mode"] == "daily":
        open_slots = [
            t for t in series["times"]
            if 0 <= minute - _minutes(t) < DAILY_GRACE_MIN
        ]
        return f"{date}@{open_slots[-1]}" if open_slots else None
    start, end = _minutes(series["activeFrom"]), _minutes(series["activeTo"])
    in_window = start <= minute <= end if start <= end else (minute >= start or minute <= end)
    if not in_window:
        return None
    return f"{date}#{minute // series['intervalMin']}"


def next_capture(series: dict, now: datetime, state: dict) -> datetime | None:
    """Best-effort time of the next scheduled shot (for display)."""
    if not series["enabled"]:
        return None
    slot_state = state.get("slots", {}).get(series["id"], {})
    probe = now.replace(second=0, microsecond=0)
    for _ in range(2 * 24 * 60):
        slot = current_slot(series, probe)
        if slot and slot != slot_state.get("slot"):
            return max(probe, now)
        if slot and slot == slot_state.get("slot") and not slot_state.get("done"):
            return max(probe, now)
        probe += timedelta(minutes=1)
    return None


class Scheduler:
    def __init__(self) -> None:
        self.capture_lock = asyncio.Lock()
        self.assemble_lock = asyncio.Lock()
        self.battery_lock = asyncio.Lock()
        self.capturing_series: list[str] = []
        self.battery: dict | None = store.last_battery()
        self._last_battery_poll = 0.0
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self._tick()
            except Exception:
                _LOGGER.exception("scheduler tick failed")
            await asyncio.sleep(TICK_S)

    # ------------------------------------------------------------------
    # Battery
    # ------------------------------------------------------------------

    async def refresh_battery(self) -> dict | None:
        if self.battery_lock.locked():
            return self.battery
        async with self.battery_lock:
            self._last_battery_poll = time.monotonic()
            result = await asyncio.to_thread(capture.read_battery)
            if result.get("ok") and result.get("percent") is not None:
                entry = {
                    "ts": datetime.now().isoformat(timespec="seconds"),
                    "percent": result["percent"],
                    "charging": bool(result.get("charging")),
                }
                store.log_battery(entry)
                self.battery = entry
            else:
                _LOGGER.warning("lecture batterie échouée: %s", result.get("error"))
            return self.battery

    def battery_paused(self, series: dict, state: dict) -> bool:
        """Apply the series battery threshold, with hysteresis on resume."""
        paused_map = state.setdefault("batteryPaused", {})
        threshold = series["minBattery"]
        if threshold <= 0 or not self.battery:
            paused_map.pop(series["id"], None)
            return False
        percent = self.battery["percent"]
        hysteresis = store.load_settings()["global"]["batteryHysteresis"]
        was_paused = bool(paused_map.get(series["id"]))
        paused = percent < threshold + hysteresis if was_paused else percent < threshold
        if paused != was_paused:
            _LOGGER.info(
                "série %s: %s (batterie %s%%)",
                series["id"], "en pause" if paused else "reprise", percent,
            )
        if paused:
            paused_map[series["id"]] = True
        else:
            paused_map.pop(series["id"], None)
        return paused

    # ------------------------------------------------------------------
    # Main tick
    # ------------------------------------------------------------------

    async def _tick(self) -> None:
        now = datetime.now()
        settings = store.load_settings()
        g = settings["global"]
        state = store.load_state()

        if time.monotonic() - self._last_battery_poll >= g["batteryPollMin"] * 60:
            await self.refresh_battery()

        due: list[tuple[dict, str]] = []
        slots = state.setdefault("slots", {})
        for series in settings["series"]:
            if not series["enabled"]:
                continue
            slot = current_slot(series, now)
            if slot is None:
                continue
            st = slots.get(series["id"], {})
            if st.get("slot") == slot:
                if st.get("done") or st.get("attempts", 0) > series["retries"]:
                    continue
                last = datetime.fromisoformat(st["lastAttempt"])
                if now - last < timedelta(minutes=RETRY_GAP_MIN):
                    continue
            if self.battery_paused(series, state):
                slots[series["id"]] = {"slot": slot, "done": True, "skipped": True}
                store.log_capture(
                    {
                        "ts": now.isoformat(timespec="seconds"),
                        "series": [series["id"]],
                        "ok": False,
                        "skipped": True,
                        "error": f"batterie {self.battery['percent']} % < seuil {series['minBattery']} %",
                    }
                )
                continue
            due.append((series, slot))
        store.save_state(state)

        if due and not self.capture_lock.locked():
            await self._run_slots(due)

        await self._daily_jobs(now, settings)

    async def _run_slots(self, due: list[tuple[dict, str]]) -> None:
        result = await self.run_capture([s["id"] for s, _ in due])
        state = store.load_state()
        slots = state.setdefault("slots", {})
        for series, slot in due:
            st = slots.get(series["id"], {})
            attempts = st.get("attempts", 0) + 1 if st.get("slot") == slot else 1
            slots[series["id"]] = {
                "slot": slot,
                "done": bool(result.get("ok")),
                "attempts": attempts,
                "lastAttempt": datetime.now().isoformat(timespec="seconds"),
            }
        store.save_state(state)

    async def _daily_jobs(self, now: datetime, settings: dict) -> None:
        g = settings["global"]
        state = store.load_state()
        today = now.strftime("%Y-%m-%d")
        due = now.replace(hour=g["assemblyHour"], minute=g["assemblyMinute"], second=0, microsecond=0)
        if now >= due and state.get("lastAssemblyDate") != today:
            state["lastAssemblyDate"] = today
            store.save_state(state)
            for series in settings["series"]:
                if series["mode"] == "interval":
                    # Videos cover the day that just ended (or today when
                    # assembly runs late in the evening).
                    target = today if g["assemblyHour"] >= 12 else (now - timedelta(days=1)).strftime("%Y-%m-%d")
                    result = await self.run_assemble(series, start=target, end=target, name=target)
                else:
                    result = await self.run_assemble(series, name="complet")
                _LOGGER.info("assemblage auto %s: %s", series["id"], result)

        if state.get("lastRetentionDate") != today:
            state["lastRetentionDate"] = today
            store.save_state(state)
            for series in settings["series"]:
                await asyncio.to_thread(capture.empty_trash, series["id"])
                removed = await asyncio.to_thread(
                    capture.prune_retention, series["id"], series["retentionDays"]
                )
                if removed:
                    _LOGGER.info("rétention %s: %d jour(s) supprimé(s)", series["id"], removed)
            await asyncio.to_thread(store.trim_logs)

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    async def run_capture(self, series_ids: list[str]) -> dict:
        if self.capture_lock.locked():
            return {"ok": False, "error": "capture déjà en cours"}
        g = store.load_settings()["global"]
        async with self.capture_lock:
            self.capturing_series = list(series_ids)
            started = time.monotonic()
            try:
                result = await asyncio.to_thread(capture.grab, g["grabDurationSec"], g["quality"])
                frames: list[str] = []
                if result.get("ok"):
                    frames = await asyncio.to_thread(
                        capture.store_frame, result["jpg"], series_ids, result["startedAt"]
                    )
            finally:
                self.capturing_series = []
            entry = {
                "ts": datetime.now().isoformat(timespec="seconds"),
                "series": series_ids,
                "ok": bool(result.get("ok")),
                "ms": int((time.monotonic() - started) * 1000),
            }
            if frames:
                entry["frame"] = frames[0]
            if not entry["ok"]:
                entry["error"] = str(result.get("error", "inconnu"))[-300:]
            store.log_capture(entry)
        # The camera just reported in while awake: battery value is fresh.
        asyncio.create_task(self.refresh_battery())
        return {**entry, "frames": frames}

    async def run_assemble(
        self, series: dict, start: str | None = None, end: str | None = None, name: str | None = None
    ) -> dict:
        if self.assemble_lock.locked():
            return {"ok": False, "error": "assemblage déjà en cours"}
        if name is None:
            name = "complet" if not start and not end else f"{start or 'debut'}_{end or 'fin'}"
        async with self.assemble_lock:
            frames = await asyncio.to_thread(store.frame_paths, series["id"], start, end)
            return await asyncio.to_thread(capture.assemble, series["id"], name, frames, series["fps"])


scheduler = Scheduler()
