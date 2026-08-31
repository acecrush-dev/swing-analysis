"""Service layer: REST + WebSocket UI (FastAPI).

`pipeline.py` here is the shared run-pipeline used by both `cli.py` and the
HTTP service. CLI is a UI; HTTP/WS is another UI. Both drive the same
algorithm in `backend.core`.
"""