#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${PYTHON:-}" ]; then
  PYTHON_COMMAND=$PYTHON
elif [ -x "$SCRIPT_DIR/../.venv/bin/python" ]; then
  PYTHON_COMMAND="$SCRIPT_DIR/../.venv/bin/python"
else
  PYTHON_COMMAND=python3
fi
exec "$PYTHON_COMMAND" "$SCRIPT_DIR/run_agent_analysis.py" "$@"
