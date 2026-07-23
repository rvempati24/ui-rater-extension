#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -n "${PYTHON:-}" ]; then
  UI_RATER_PYTHON=$PYTHON
elif [ -x "$REPO_DIR/.venv/bin/python" ]; then
  UI_RATER_PYTHON="$REPO_DIR/.venv/bin/python"
else
  UI_RATER_PYTHON=python3
fi

"$UI_RATER_PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else "UI Rater requires Python 3.9+")'
exec "$UI_RATER_PYTHON" "$@"
