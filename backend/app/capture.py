from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

from . import store

HARNESS_DIR = Path(os.environ.get("HARNESS_DIR", "/opt/meari"))
PYTHON = os.environ.get("HARNESS_PYTHON", "python")
BATTERY_PROBE = Path(__file__).with_name("battery_probe.py")

_detected_device_id: str | None = None


def harness_present() -> bool:
    return (HARNESS_DIR / "debug.py").exists()


def _write_harness_env() -> None:
    env_file = HARNESS_DIR / ".env"
    if env_file.exists():
        return
    email = os.environ.get("MEARI_EMAIL", "")
    password = os.environ.get("MEARI_PASSWORD", "")
    if not email or not password:
        raise RuntimeError("MEARI_EMAIL/MEARI_PASSWORD manquants")
    env_file.write_text(
        "\n".join(
            [
                f"EMAIL={email}",
                f"PASSWORD={password}",
                f"COUNTRY_CODE={os.environ.get('MEARI_COUNTRY_CODE', 'FR')}",
                f"PHONE_CODE={os.environ.get('MEARI_PHONE_CODE', '33')}",
                f"PROFILE={os.environ.get('MEARI_PROFILE', 'anran')}",
            ]
        )
        + "\n"
    )
    env_file.chmod(0o600)


def device_id() -> str:
    global _detected_device_id
    env_id = os.environ.get("MEARI_DEVICE_ID", "").strip()
    if env_id:
        return env_id
    if _detected_device_id:
        return _detected_device_id
    _write_harness_env()
    proc = subprocess.run(
        [PYTHON, "debug.py", "list"],
        cwd=HARNESS_DIR,
        capture_output=True,
        text=True,
        timeout=180,
    )
    match = re.search(r"id=(\d+)", proc.stdout)
    if proc.returncode != 0 or not match:
        raise RuntimeError("Aucune caméra trouvée sur le compte")
    _detected_device_id = match.group(1)
    return _detected_device_id


# --------------------------------------------------------------------------
# Battery
# --------------------------------------------------------------------------


def read_battery() -> dict:
    """Query battery level from the cloud (does not wake the camera)."""
    try:
        _write_harness_env()
        dev = device_id()
        proc = subprocess.run(
            [PYTHON, str(BATTERY_PROBE), dev],
            cwd=HARNESS_DIR,
            capture_output=True,
            text=True,
            timeout=90,
        )
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}
    lines = [line for line in proc.stdout.splitlines() if line.startswith("{")]
    if not lines:
        return {"ok": False, "error": (proc.stderr or proc.stdout)[-300:]}
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError:
        return {"ok": False, "error": "réponse illisible"}


# --------------------------------------------------------------------------
# Capture
# --------------------------------------------------------------------------


def _probe(path: Path, entries: str, stream: bool = False) -> str:
    cmd = ["ffprobe", "-v", "error"]
    if stream:
        cmd += ["-select_streams", "v:0"]
    cmd += ["-show_entries", entries, "-of", "csv=p=0", str(path)]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    return proc.stdout.strip()


def _probe_duration(path: Path) -> float:
    try:
        return float(_probe(path, "format=duration"))
    except ValueError:
        return 0.0


def _cleanup(base: Path) -> None:
    for suffix in (".ts", ".wav", "_player.log", "_recorder.log"):
        Path(str(base) + suffix).unlink(missing_ok=True)


def grab(duration: int, quality: str) -> dict:
    """Wake the camera, record a clip and extract one JPEG into a temp file."""
    if quality not in store.QUALITIES:
        return {"ok": False, "error": f"qualité invalide: {quality}"}
    try:
        _write_harness_env()
        dev = device_id()
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": f"auth/découverte échouée: {exc}"}

    started = datetime.now()
    base = Path(tempfile.gettempdir()) / f"grab-{started.strftime('%Y%m%d%H%M%S%f')}"
    env = os.environ.copy()
    env.update({"SDL_VIDEODRIVER": "dummy", "SDL_AUDIODRIVER": "dummy", "DISPLAY": ""})
    cmd = [
        PYTHON, "debug.py", "stream",
        "--device-id", dev,
        "--duration", str(duration),
        "--quality", quality,
        "--output-file", str(base),
    ]
    ts_file = Path(str(base) + ".ts")
    try:
        proc = subprocess.run(
            cmd, cwd=HARNESS_DIR, env=env, capture_output=True, text=True,
            timeout=duration + 300,
        )
    except subprocess.TimeoutExpired:
        _cleanup(base)
        return {"ok": False, "startedAt": started, "error": "timeout du flux"}

    # rc=3 only means the harness's playback-quality verdict was "degraded";
    # the recorded .ts is still usable, so judge on the file itself.
    clip_duration = _probe_duration(ts_file) if ts_file.exists() else 0.0
    if (
        proc.returncode not in (0, 3)
        or not ts_file.exists()
        or ts_file.stat().st_size < 10000
        or clip_duration <= 0
    ):
        detail = (proc.stderr or proc.stdout or "")[-600:]
        _cleanup(base)
        return {
            "ok": False,
            "startedAt": started,
            "error": f"flux échoué (rc={proc.returncode}): {detail}",
        }

    jpg = Path(str(base) + ".jpg")
    # Late in the clip: exposure / IR have settled after the wake-up.
    offset = clip_duration * 0.7
    try:
        subprocess.run(
            [
                "ffmpeg", "-nostdin", "-y", "-ss", f"{offset:.3f}", "-i", str(ts_file),
                "-frames:v", "1", "-q:v", "2", str(jpg),
            ],
            check=True, capture_output=True, timeout=60,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        _cleanup(base)
        jpg.unlink(missing_ok=True)
        stderr = (getattr(exc, "stderr", b"") or b"").decode(errors="replace")[-300:]
        return {"ok": False, "startedAt": started, "error": f"extraction image: {stderr}"}
    finally:
        _cleanup(base)

    return {
        "ok": True,
        "startedAt": started,
        "deviceId": dev,
        "clipDuration": round(clip_duration, 2),
        "quality": quality,
        "jpg": jpg,
    }


def store_frame(jpg: Path, series_ids: list[str], when: datetime) -> list[str]:
    urls = []
    for series_id in series_ids:
        day_dir = store.frames_dir(series_id) / when.strftime("%Y/%m/%d")
        day_dir.mkdir(parents=True, exist_ok=True)
        out = day_dir / f"{when.strftime('%H%M%S')}.jpg"
        shutil.copyfile(jpg, out)
        urls.append(store.frame_url(series_id, out))
    jpg.unlink(missing_ok=True)
    return urls


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------


def _frame_size(path: Path) -> tuple[int, int]:
    out = _probe(path, "stream=width,height", stream=True)
    try:
        w, h = (int(x) for x in out.split(",")[:2])
        return w - w % 2, h - h % 2
    except ValueError:
        return 640, 360


def assemble(series_id: str, name: str, frames: list[Path], fps: int) -> dict:
    if not frames:
        return {"ok": False, "error": "aucune image sur cette période"}
    out_dir = store.videos_dir(series_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{name}.mp4"
    tmp = out_dir / f"{name}.tmp.mp4"
    # Sizes can differ (quality changes), so normalise to the latest frame.
    width, height = _frame_size(frames[-1])
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )
    with tempfile.TemporaryDirectory() as workdir:
        for i, frame in enumerate(frames):
            os.symlink(frame, Path(workdir) / f"{i:06d}.jpg")
        cmd = [
            "ffmpeg", "-nostdin", "-y",
            "-framerate", str(fps),
            "-i", str(Path(workdir) / "%06d.jpg"),
            "-vf", vf,
            "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            str(tmp),
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=3600)
        except subprocess.CalledProcessError as exc:
            tmp.unlink(missing_ok=True)
            stderr = (exc.stderr or b"").decode(errors="replace")[-400:]
            return {"ok": False, "error": f"ffmpeg: {stderr}"}
    tmp.replace(out)
    return {"ok": True, "name": name, "frames": len(frames), "size": out.stat().st_size}


def delete_day(series_id: str, date: str) -> int:
    day_dir = store.frames_dir(series_id) / date.replace("-", "/")
    removed = len(list(day_dir.glob("*.jpg"))) if day_dir.exists() else 0
    shutil.rmtree(day_dir, ignore_errors=True)
    (store.videos_dir(series_id) / f"{date}.mp4").unlink(missing_ok=True)
    return removed


def delete_video(series_id: str, name: str) -> bool:
    if not re.match(r"^[0-9A-Za-z_-]{1,40}$", name):
        return False
    path = store.videos_dir(series_id) / f"{name}.mp4"
    existed = path.exists()
    path.unlink(missing_ok=True)
    return existed


def prune_retention(series_id: str, retention_days: int) -> int:
    if retention_days <= 0:
        return 0
    removed = 0
    now = datetime.now()
    for date, path in list(store._day_dirs(series_id)):
        if (now - datetime.strptime(date, "%Y-%m-%d")).days > retention_days:
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
    root = store.frames_dir(series_id)
    if root.exists():
        for parent in sorted(root.glob("*/*"), reverse=True) + sorted(root.glob("*")):
            try:
                parent.rmdir()
            except OSError:
                pass
    return removed
