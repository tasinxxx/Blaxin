#!/usr/bin/env python3
"""
BLAXIN computer-use motion probe — smooth cursor travel.

Real motion, not a jump-cut: PyAutoGUI eases the cursor along the path
(default 0.5 s). One mode: --move (with a guard rail). If pyautogui or an
X display is unavailable, exits 2 with a JSON error — honest, never silent.
"""

import argparse
import json
import sys
import os

GUARD = "BLAXIN_ALLOW_PYAUTOGUI=1"
OS_ENV = "BLAXIN_PROBE_DISPLAY"


def unavailable(reason: str):
    print(json.dumps({"ok": False, "error": reason}))
    sys.exit(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--move", nargs=2, type=int, metavar=("X", "Y"))
    ap.add_argument("--duration", type=float, default=0.5)
    args = ap.parse_args()

    if not args.move:
        unavailable("no action requested")
    if os.environ.get("BLAXIN_ALLOW_PYAUTOGUI") != "1":
        unavailable(f"safety guard not set ({GUARD}) — refusing to move the cursor")

    try:
        import pyautogui  # noqa: deferred — honest failure if absent
    except Exception as e:  # pragma: no cover
        unavailable(f"pyautogui unavailable: {e}")

    if not os.environ.get(OS_ENV):
        unavailable(f"{OS_ENV} not set — refusing to act outside the probe display")

    x, y = args.move
    try:
        pyautogui.FAILSAFE = True
        pyautogui.moveTo(x, y, duration=args.duration)
        px, py = pyautogui.position()
    except Exception as e:
        unavailable(f"move failed: {e}")

    print(json.dumps({
        "ok": True,
        "requested": {"x": x, "y": y},
        "actual": {"x": px, "y": py},
        "smoothed": True,
        "durationSec": args.duration,
    }))


if __name__ == "__main__":
    main()
