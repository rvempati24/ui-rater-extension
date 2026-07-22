#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec sh "$SCRIPT_DIR/run-python.sh" "$SCRIPT_DIR/migrate_legacy_participants.py" "$@"
