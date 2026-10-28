"""Read camera battery/status from the Meari cloud without waking it.

Run with the harness directory as cwd: ``python battery_probe.py <device_id>``.
Prints one JSON object on stdout.
"""

from __future__ import annotations

import json
import logging
import os
import sys

sys.path.insert(0, os.getcwd())
logging.disable(logging.CRITICAL)

import debug  # noqa: E402  (harness entry point, provides the CLI parser)
from debug_tools.auth import _login_api_with_fallback, _prepare_auth_args  # noqa: E402
from debug_tools.bootstrap import _bootstrap_integration_modules  # noqa: E402


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def main() -> int:
    wanted = sys.argv[1] if len(sys.argv) > 1 else ""
    parser = debug.build_parser()
    args = parser.parse_args(["list"])
    _prepare_auth_args(parser, args)
    mods = _bootstrap_integration_modules()
    api = _login_api_with_fallback(mods["api"].MeariApiClient, args)

    devices = list(api.devices.values())
    dev = next((d for d in devices if str(d.get("deviceID")) == wanted), None)
    if dev is None and devices:
        dev = devices[0]
    if dev is None:
        print(json.dumps({"ok": False, "error": "aucune caméra"}))
        return 1

    sn = dev.get("snNum")
    info = api.get_battery_info(sn) or {}
    flat = {str(k): v for k, v in info.items()}
    percent = _int(flat.get("154"))
    charge = _int(flat.get("156"))
    print(
        json.dumps(
            {
                "ok": True,
                "deviceId": str(dev.get("deviceID")),
                "name": dev.get("deviceName"),
                "percent": percent if percent is not None and 0 <= percent <= 100 else None,
                "charging": charge == 1 if charge is not None else None,
                "powerType": _int(flat.get("153")),
                "remainingMin": _int(flat.get("155")),
                "status": api.get_device_status(sn),
                "raw": flat,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
