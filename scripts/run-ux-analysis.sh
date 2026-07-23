#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PYTHONPATH="$REPO_DIR/packages/usability-evaluator/src${PYTHONPATH:+:$PYTHONPATH}" \
  exec sh "$SCRIPT_DIR/run-python.sh" -m ui_usability_evaluator.cli \
  evaluate --condition full "$@"
