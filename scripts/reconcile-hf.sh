#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PYTHON_COMMAND=${PYTHON:-python3}
exec "$PYTHON_COMMAND" "$SCRIPT_DIR/reconcile_hf.py" "$@"
