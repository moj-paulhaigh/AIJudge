#!/usr/bin/env bash
# One-time setup: creates a venv and installs dependencies (macOS / Linux).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null || { echo "python3 not found. On macOS: brew install python@3.12" >&2; exit 1; }
"$PYTHON" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' \
    || { echo "Python 3.10+ is required (found $("$PYTHON" --version)). Set PYTHON=/path/to/python3.12 to choose one." >&2; exit 1; }

"$PYTHON" -m venv "$root/.venv"
"$root/.venv/bin/python" -m pip install --upgrade pip
"$root/.venv/bin/python" -m pip install -r "$root/requirements.txt"

if [ ! -f "$root/.env" ]; then
    cp "$root/.env.example" "$root/.env"
    echo "Created .env from .env.example - edit it and set AZURE_API_KEY before running."
fi
