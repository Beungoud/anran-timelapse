from __future__ import annotations

import json
import os
import re
import secrets
import shutil
from datetime import datetime, timedelta
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
SERIES_DIR = DATA_DIR / "series"
SETTINGS_FILE = DATA_DIR / "settings.json"
CAPTURES_LOG = DATA_DIR / "captures.jsonl"
BATTERY_LOG = DATA_DIR / "battery.jsonl"
STATE_FILE = DATA_DIR / "scheduler-state.json"

# The harness recorder probes the stream for ~20 s before writing anything,
# so shorter clips produce an empty .ts file.
MIN_GRAB_DURATION_S = 25
QUALITIES = {"AUTO", "SD", "HD", "QHD"}
MODES = {"interval", "daily"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
ID_RE = re.compile(r"^[a-z0-9-]{1,40}$")

GLOBAL_DEFAULTS = {
    "quality": "SD",
    "grabDurationSec": 30,
    "assemblyHour": 23,
    "assemblyMinute": 55,
    "batteryPollMin": 15,
    "batteryHysteresis": 5,
}

SERIES_DEFAULTS = {
    "name": "Nouvelle série",
    "enabled": True,
    "mode": "interval",
    "intervalMin": 60,
    "activeFrom": "00:00",
    "activeTo": "23:59",
    "times": ["12:00"],
    "retries": 0,
    "minBattery": 0,
    "fps": 24,
    "retentionDays": 31,
}

DEFAULT_SERIES = [
    {
        **SERIES_DEFAULTS,
        "id": "horaire",
        "name": "Horaire",
        "mode": "interval",
        "intervalMin": 60,
        "minBattery": 80,
        "fps": 12,
        "retentionDays": 31,
    },
    {
        **SERIES_DEFAULTS,
        "id": "midi",
        "name": "Midi · météo & neige",
        "mode": "daily",
        "times": ["12:00"],
        "retries": 2,
        "minBattery": 0,
        "fps": 8,
        "retentionDays": 0,
    },
]


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(path)


def _clamp(value, lo, hi, fallback):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return fallback


def _clean_global(raw: dict) -> dict:
    g = dict(GLOBAL_DEFAULTS)
    g.update({k: raw[k] for k in GLOBAL_DEFAULTS if k in raw})
    g["quality"] = g["quality"] if g["quality"] in QUALITIES else "SD"
    g["grabDurationSec"] = _clamp(g["grabDurationSec"], MIN_GRAB_DURATION_S, 120, 30)
    g["assemblyHour"] = _clamp(g["assemblyHour"], 0, 23, 23)
    g["assemblyMinute"] = _clamp(g["assemblyMinute"], 0, 59, 55)
    g["batteryPollMin"] = _clamp(g["batteryPollMin"], 5, 240, 15)
    g["batteryHysteresis"] = _clamp(g["batteryHysteresis"], 0, 20, 5)
    return g


def _clean_series(raw: dict, base: dict | None = None) -> dict:
    s = dict(SERIES_DEFAULTS)
    if base:
        s.update(base)
    s.update({k: raw[k] for k in list(SERIES_DEFAULTS) + ["id"] if k in raw})
    s["name"] = str(s["name"]).strip()[:60] or "Série"
    s["enabled"] = bool(s["enabled"])
    s["mode"] = s["mode"] if s["mode"] in MODES else "interval"
    s["intervalMin"] = _clamp(s["intervalMin"], 1, 1440, 60)
    for key, fallback in (("activeFrom", "00:00"), ("activeTo", "23:59")):
        if not TIME_RE.match(str(s[key])):
            s[key] = fallback
    times = s["times"] if isinstance(s["times"], list) else [s["times"]]
    times = sorted({str(t) for t in times if TIME_RE.match(str(t))})
    s["times"] = times or ["12:00"]
    s["retries"] = _clamp(s["retries"], 0, 5, 0)
    s["minBattery"] = _clamp(s["minBattery"], 0, 100, 0)
    s["fps"] = _clamp(s["fps"], 1, 60, 24)
    s["retentionDays"] = _clamp(s["retentionDays"], 0, 3650, 31)
    return s


def _migrate_v1(stored: dict) -> dict:
    """Convert the original flat settings into global settings + series."""
    series = [dict(s) for s in DEFAULT_SERIES]
    if stored:
        series[0]["enabled"] = bool(stored.get("enabled", True))
        series[0]["retentionDays"] = stored.get("retentionDays", 31)
    return {"global": _clean_global(stored), "series": series}


def load_settings() -> dict:
    stored = _read_json(SETTINGS_FILE, {})
    if "series" not in stored:
        settings = _migrate_v1(stored)
        _write_json(SETTINGS_FILE, settings)
        return settings
    return {
        "global": _clean_global(stored.get("global", {})),
        "series": [_clean_series(s) for s in stored.get("series", []) if s.get("id")],
    }


def save_global(changes: dict) -> dict:
    settings = load_settings()
    merged = dict(settings["global"])
    merged.update(changes)
    settings["global"] = _clean_global(merged)
    _write_json(SETTINGS_FILE, settings)
    return settings["global"]


def get_series(series_id: str) -> dict | None:
    return next((s for s in load_settings()["series"] if s["id"] == series_id), None)


def _new_id(name: str, taken: set[str]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "serie"
    candidate = slug
    while candidate in taken:
        candidate = f"{slug}-{secrets.token_hex(2)}"
    return candidate


def create_series(data: dict) -> dict:
    settings = load_settings()
    taken = {s["id"] for s in settings["series"]}
    series = _clean_series(data)
    series["id"] = _new_id(series["name"], taken)
    settings["series"].append(series)
    _write_json(SETTINGS_FILE, settings)
    return series


def update_series(series_id: str, data: dict) -> dict | None:
    settings = load_settings()
    for i, current in enumerate(settings["series"]):
        if current["id"] == series_id:
            updated = _clean_series({**data, "id": series_id}, base=current)
            settings["series"][i] = updated
            _write_json(SETTINGS_FILE, settings)
            return updated
    return None


def delete_series(series_id: str, purge: bool) -> bool:
    settings = load_settings()
    remaining = [s for s in settings["series"] if s["id"] != series_id]
    if len(remaining) == len(settings["series"]):
        return False
    settings["series"] = remaining
    _write_json(SETTINGS_FILE, settings)
    if purge and ID_RE.match(series_id):
        shutil.rmtree(SERIES_DIR / series_id, ignore_errors=True)
    return True


# --------------------------------------------------------------------------
# Scheduler state & logs
# --------------------------------------------------------------------------


def load_state() -> dict:
    return _read_json(STATE_FILE, {})


def save_state(state: dict) -> None:
    _write_json(STATE_FILE, state)


def _append_jsonl(path: Path, entry: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _read_jsonl(path: Path) -> list[dict]:
    try:
        lines = path.read_text().splitlines()
    except FileNotFoundError:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def log_capture(entry: dict) -> None:
    _append_jsonl(CAPTURES_LOG, entry)


def read_captures(limit: int = 30) -> list[dict]:
    return list(reversed(_read_jsonl(CAPTURES_LOG)[-limit:]))


def captures_since(since: datetime) -> list[dict]:
    iso = since.isoformat(timespec="seconds")
    return [c for c in _read_jsonl(CAPTURES_LOG) if c.get("ts", "") >= iso]


def log_battery(entry: dict) -> None:
    _append_jsonl(BATTERY_LOG, entry)


def read_battery(hours: int) -> list[dict]:
    iso = (datetime.now() - timedelta(hours=hours)).isoformat(timespec="seconds")
    return [b for b in _read_jsonl(BATTERY_LOG) if b.get("ts", "") >= iso]


def last_battery() -> dict | None:
    entries = _read_jsonl(BATTERY_LOG)
    return entries[-1] if entries else None


def trim_logs(keep_days: int = 60) -> None:
    iso = (datetime.now() - timedelta(days=keep_days)).isoformat(timespec="seconds")
    for path in (CAPTURES_LOG, BATTERY_LOG):
        entries = _read_jsonl(path)
        kept = [e for e in entries if e.get("ts", "") >= iso]
        if len(kept) != len(entries):
            path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in kept))


# --------------------------------------------------------------------------
# Series files
# --------------------------------------------------------------------------


def frames_dir(series_id: str) -> Path:
    return SERIES_DIR / series_id / "frames"


def videos_dir(series_id: str) -> Path:
    return SERIES_DIR / series_id / "videos"


def trash_dir(series_id: str) -> Path:
    return SERIES_DIR / series_id / "trash"


def valid_date(date: str) -> bool:
    if not DATE_RE.match(date or ""):
        return False
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def _day_dirs(series_id: str):
    root = frames_dir(series_id)
    if not root.exists():
        return
    for path in sorted(root.glob("[0-9][0-9][0-9][0-9]/[0-9][0-9]/[0-9][0-9]")):
        if path.is_dir():
            yield f"{path.parent.parent.name}-{path.parent.name}-{path.name}", path


def frame_url(series_id: str, path: Path) -> str:
    rel = path.relative_to(SERIES_DIR / series_id)
    return f"/media/{series_id}/{rel.as_posix()}"


def _frame_entry(series_id: str, date: str, path: Path) -> dict:
    stem = path.stem.split("-")[0]
    time = f"{stem[0:2]}:{stem[2:4]}:{stem[4:6]}" if len(stem) >= 6 else stem
    return {"date": date, "time": time, "name": path.name, "url": frame_url(series_id, path)}


def list_frames(series_id: str, start: str | None = None, end: str | None = None) -> list[dict]:
    frames = []
    for date, path in _day_dirs(series_id):
        if (start and date < start) or (end and date > end):
            continue
        frames.extend(_frame_entry(series_id, date, f) for f in sorted(path.glob("*.jpg")))
    return frames


def frame_paths(series_id: str, start: str | None = None, end: str | None = None) -> list[Path]:
    paths = []
    for date, path in _day_dirs(series_id):
        if (start and date < start) or (end and date > end):
            continue
        paths.extend(sorted(path.glob("*.jpg")))
    return paths


def list_days(series_id: str) -> list[dict]:
    vids = videos_dir(series_id)
    days = []
    for date, path in _day_dirs(series_id):
        count = len(list(path.glob("*.jpg")))
        if count:
            days.append({"date": date, "frames": count, "video": (vids / f"{date}.mp4").exists()})
    return list(reversed(days))


def series_stats(series_id: str) -> dict:
    total = 0
    first = last = None
    last_path = None
    for date, path in _day_dirs(series_id):
        jpgs = sorted(path.glob("*.jpg"))
        if not jpgs:
            continue
        total += len(jpgs)
        first = first or date
        last = date
        last_path = (date, jpgs[-1])
    today = datetime.now().strftime("%Y/%m/%d")
    today_dir = frames_dir(series_id) / today
    return {
        "frames": total,
        "today": len(list(today_dir.glob("*.jpg"))) if today_dir.exists() else 0,
        "firstDate": first,
        "lastDate": last,
        "lastFrame": _frame_entry(series_id, *last_path) if last_path else None,
        "videos": len(list(videos_dir(series_id).glob("*.mp4"))) if videos_dir(series_id).exists() else 0,
    }


def list_videos(series_id: str) -> list[dict]:
    root = videos_dir(series_id)
    if not root.exists():
        return []
    out = []
    for mp4 in root.glob("*.mp4"):
        if mp4.name.endswith(".tmp.mp4"):
            continue
        stat = mp4.stat()
        out.append(
            {
                "name": mp4.stem,
                "url": f"/media/{series_id}/videos/{mp4.name}?v={int(stat.st_mtime)}",
                "size": stat.st_size,
                "updatedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
            }
        )
    return sorted(out, key=lambda v: v["name"], reverse=True)


def migrate_legacy_files() -> None:
    """Move frames/videos from the single-series layout into series/horaire."""
    legacy_frames = DATA_DIR / "frames"
    legacy_videos = DATA_DIR / "timelapses"
    target = SERIES_DIR / "horaire"
    if legacy_frames.exists() and any(legacy_frames.iterdir()) and not (target / "frames").exists():
        target.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy_frames), str(target / "frames"))
    if legacy_videos.exists() and any(legacy_videos.iterdir()) and not (target / "videos").exists():
        target.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy_videos), str(target / "videos"))
    for path in (legacy_frames, legacy_videos):
        try:
            path.rmdir()
        except OSError:
            pass
