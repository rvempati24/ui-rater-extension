#!/usr/bin/env python3
"""Compatibility entrypoint for the extracted Method 3 evaluator."""

from pathlib import Path
import sys

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "packages/usability-evaluator/src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from ui_usability_evaluator.method3 import *  # noqa: F401,F403,E402
from ui_usability_evaluator.method3 import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
