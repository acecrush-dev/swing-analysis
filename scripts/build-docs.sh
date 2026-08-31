#!/usr/bin/env bash
# Build the docs site locally.
#   ./scripts/build-docs.sh           # build both languages
#   ./scripts/build-docs.sh --serve   # build + start local dev server on http://127.0.0.1:8000
#
# Output goes to site/. Serve mode reloads on edit.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

if ! python3 -c "import mkdocs" 2>/dev/null; then
    echo "[build-docs] mkdocs not installed. Installing..."
    python3 -m pip install --quiet -r docs/requirements-docs.txt
fi

if [[ "${1:-}" == "--serve" ]]; then
    echo "[build-docs] starting local server on http://127.0.0.1:8000"
    exec mkdocs serve --dev-addr 127.0.0.1:8000
else
    echo "[build-docs] building both languages into site/"
    mkdocs build --clean
    echo "[build-docs] done — site/ ready"
    echo "  English:  site/index.html"
    echo "  Chinese:  site/zh/index.html"
fi