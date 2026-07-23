#!/usr/bin/env python3
"""Compatibility import for the extracted evaluator helpers."""

from pathlib import Path
import sys

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "packages/usability-evaluator/src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from ui_usability_evaluator.evidence import *  # noqa: F401,F403,E402
