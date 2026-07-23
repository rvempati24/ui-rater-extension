#!/usr/bin/env python3
"""Compatibility entrypoint for bundle-only Method 3 materialization."""

from pathlib import Path
import sys

PACKAGE_SRC = Path(__file__).resolve().parents[1] / "packages/usability-evaluator/src"
if str(PACKAGE_SRC) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SRC))

from ui_usability_evaluator.cli import main as evaluator_main  # noqa: E402


def main() -> int:
    return evaluator_main(["materialize", *sys.argv[1:]])


if __name__ == "__main__":
    raise SystemExit(main())
