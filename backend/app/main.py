from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from . import auth, capture, store
from .scheduler import next_capture, scheduler

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
_LOGGER = logging.getLogger("anran-timelapse")

FRONTEND_DIR = Path(os.environ.get("FRONTEND_DIR", "/app/public"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.DATA_DIR.mkdir(parents=True, exist_ok=True)
    auth.check_config()
    store.migrate_legacy_files()
    store.load_settings()  # migrates settings.json if needed
    scheduler.start()
    _LOGGER.info("démarré (data=%s, harness=%s)", store.DATA_DIR, capture.HARNESS_DIR)
    yield
    await scheduler.stop()


app = FastAPI(title="ANRAN Timelapse", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
# Added last = outermost: the session is decoded before AuthMiddleware runs.
app.add_middleware(auth.AuthMiddleware)
app.add_middleware(
    SessionMiddleware,
    secret_key=auth.session_secret(),
    session_cookie="anran_session",
    max_age=auth.SESSION_DAYS * 86400,
    same_site="lax",
    https_only=auth.SECURE_COOKIE,
)
app.include_router(auth.router)


class GlobalUpdate(BaseModel):
    quality: str | None = None
    grabDurationSec: int | None = None
    assemblyHour: int | None = None
    assemblyMinute: int | None = None
    batteryPollMin: int | None = None
    batteryHysteresis: int | None = None


class SeriesBody(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    mode: str | None = None
    intervalMin: int | None = None
    activeFrom: str | None = None
    activeTo: str | None = None
    times: list[str] | None = None
    retries: int | None = None
    minBattery: int | None = None
    fps: int | None = None
    retentionDays: int | None = None


class CaptureBody(BaseModel):
    series: list[str] | None = None


class AssembleBody(BaseModel):
    start: str | None = None
    end: str | None = None


def _series_or_404(series_id: str) -> dict:
    series = store.get_series(series_id)
    if series is None:
        raise HTTPException(404, "série inconnue")
    return series


def _check_date(value: str | None) -> None:
    if value is not None and not store.valid_date(value):
        raise HTTPException(400, "date invalide (AAAA-MM-JJ)")


def _series_view(series: dict, state: dict, now: datetime) -> dict:
    nxt = next_capture(series, now, state)
    return {
        **series,
        "stats": store.series_stats(series["id"]),
        "pausedByBattery": bool(state.get("batteryPaused", {}).get(series["id"])),
        "nextCaptureAt": nxt.isoformat(timespec="seconds") if nxt else None,
        "capturing": series["id"] in scheduler.capturing_series,
    }


# --------------------------------------------------------------------------
# Overview
# --------------------------------------------------------------------------


@app.get("/api/overview")
def overview() -> dict:
    now = datetime.now()
    settings = store.load_settings()
    state = store.load_state()
    day = store.captures_since(now - timedelta(hours=24))
    attempts = [c for c in day if not c.get("skipped")]
    return {
        "now": now.isoformat(timespec="seconds"),
        "harness": capture.harness_present(),
        "battery": scheduler.battery,
        "capturing": scheduler.capture_lock.locked(),
        "capturingSeries": scheduler.capturing_series,
        "assembling": scheduler.assemble_lock.locked(),
        "last24h": {
            "attempts": len(attempts),
            "ok": sum(1 for c in attempts if c.get("ok")),
            "skipped": sum(1 for c in day if c.get("skipped")),
        },
        "series": [_series_view(s, state, now) for s in settings["series"]],
        "recentCaptures": store.read_captures(25),
    }


@app.get("/api/battery")
def battery_history(hours: int = 48) -> dict:
    hours = max(1, min(24 * 60, hours))
    return {"current": scheduler.battery, "history": store.read_battery(hours)}


@app.post("/api/battery/refresh")
async def battery_refresh() -> dict:
    current = await scheduler.refresh_battery()
    if current is None:
        raise HTTPException(502, "lecture batterie impossible")
    return {"current": current}


@app.post("/api/capture")
async def capture_now(body: CaptureBody) -> dict:
    settings = store.load_settings()
    known = {s["id"] for s in settings["series"]}
    ids = body.series or [s["id"] for s in settings["series"] if s["enabled"]]
    ids = [i for i in ids if i in known]
    if not ids:
        raise HTTPException(400, "aucune série cible")
    result = await scheduler.run_capture(ids)
    if not result.get("ok") and "déjà en cours" in str(result.get("error", "")):
        raise HTTPException(409, result["error"])
    return result


# --------------------------------------------------------------------------
# Settings & series
# --------------------------------------------------------------------------


@app.get("/api/settings")
def get_settings() -> dict:
    return store.load_settings()["global"]


@app.put("/api/settings")
def put_settings(update: GlobalUpdate) -> dict:
    return store.save_global({k: v for k, v in update.model_dump().items() if v is not None})


@app.post("/api/series")
def create_series(body: SeriesBody) -> dict:
    return store.create_series({k: v for k, v in body.model_dump().items() if v is not None})


@app.get("/api/series/{series_id}")
def get_series(series_id: str) -> dict:
    series = _series_or_404(series_id)
    return _series_view(series, store.load_state(), datetime.now())


@app.put("/api/series/{series_id}")
def update_series(series_id: str, body: SeriesBody) -> dict:
    updated = store.update_series(series_id, {k: v for k, v in body.model_dump().items() if v is not None})
    if updated is None:
        raise HTTPException(404, "série inconnue")
    return updated


@app.delete("/api/series/{series_id}")
def delete_series(series_id: str, purge: bool = False) -> dict:
    if not store.delete_series(series_id, purge):
        raise HTTPException(404, "série inconnue")
    return {"ok": True}


@app.get("/api/series/{series_id}/days")
def series_days(series_id: str) -> list[dict]:
    _series_or_404(series_id)
    return store.list_days(series_id)


@app.get("/api/series/{series_id}/frames")
def series_frames(series_id: str, start: str | None = None, end: str | None = None) -> list[dict]:
    _series_or_404(series_id)
    _check_date(start)
    _check_date(end)
    return store.list_frames(series_id, start, end)


@app.delete("/api/series/{series_id}/days/{date}")
def delete_day(series_id: str, date: str) -> dict:
    _series_or_404(series_id)
    _check_date(date)
    return {"ok": True, "removed": capture.delete_day(series_id, date)}


@app.delete("/api/series/{series_id}/frames/{date}/{name}")
def delete_frame(series_id: str, date: str, name: str) -> dict:
    _series_or_404(series_id)
    _check_date(date)
    if not capture.delete_frame(series_id, date, name):
        raise HTTPException(404, "image inconnue")
    return {"ok": True}


@app.post("/api/series/{series_id}/frames/{date}/{name}/restore")
def restore_frame(series_id: str, date: str, name: str) -> dict:
    _series_or_404(series_id)
    _check_date(date)
    if not capture.restore_frame(series_id, date, name):
        raise HTTPException(404, "image introuvable dans la corbeille")
    return {"ok": True}


@app.get("/api/series/{series_id}/videos")
def series_videos(series_id: str) -> list[dict]:
    _series_or_404(series_id)
    return store.list_videos(series_id)


@app.delete("/api/series/{series_id}/videos/{name}")
def delete_video(series_id: str, name: str) -> dict:
    _series_or_404(series_id)
    if not capture.delete_video(series_id, name):
        raise HTTPException(404, "vidéo inconnue")
    return {"ok": True}


@app.post("/api/series/{series_id}/assemble")
async def assemble(series_id: str, body: AssembleBody) -> dict:
    series = _series_or_404(series_id)
    _check_date(body.start)
    _check_date(body.end)
    name = body.start if body.start and body.start == body.end else None
    result = await scheduler.run_assemble(series, body.start, body.end, name)
    if not result.get("ok"):
        raise HTTPException(400, result.get("error", "échec"))
    return result


store.SERIES_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(store.SERIES_DIR)), name="media")

if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
