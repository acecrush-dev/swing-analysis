"""PyInstaller entry — the actual script bundled into the one-file binary.

Why this exists instead of pointing PyInstaller at backend/service/__main__.py:
PyInstaller handles single-script entry points cleanly; pointing it at a
package's __main__.py also works but pulls in the package layout twice
(once as `backend.service.__main__` and once as plain `__main__`) which
messes with sys.path at runtime. A dedicated thin script that imports
the real `main` keeps the bundle predictable.

Stdout contract (must match what backend/service/__main__.py prints):
    SWING_SERVICE_URL=http://<host>:<port>
The Electron main process parses this line to discover the bound port
(`--port 0` triggers OS-assignment; we read it back from the server).
"""
from __future__ import annotations

import sys

# PyInstaller extracts bundled data into a temp dir and sys._MEIPASS points
# there. We need backend.{service,core} importable, which PyInstaller handles
# automatically when we declare them via --collect-submodules / --hidden-imports
# (see scripts/build-python-bundle.js).
from backend.service.__main__ import main

if __name__ == "__main__":
    # PyInstaller sets sys.frozen=True and sys.executable to the extracted
    # binary path. We want to bind to 127.0.0.1 by default; let the caller
    # override via env or args.
    sys.exit(main())
