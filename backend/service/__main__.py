"""`python -m backend.service` entry — runs the FastAPI app via uvicorn.

The CLI lives in `backend.cli` (run-pipeline without HTTP). Both call the same
`backend.service.pipeline.run_pipeline`. This separation keeps the wire
format (REST/WS) decoupled from the algorithm.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

import uvicorn

from .app import build_app
from .jobs import JobManager


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Swing-Analysis 后台服务")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址 (默认 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8321, help="监听端口 (默认 8321；0 = 随机)")
    parser.add_argument(
        "--models-dir",
        default=str(Path(__file__).resolve().parents[1] / "models"),
        help="MediaPipe task 模型目录",
    )
    parser.add_argument(
        "--data-dir",
        default=str(Path(__file__).resolve().parents[1] / "data"),
        help="数据目录 (jobs/ 与 service.json)",
    )
    parser.add_argument("--log-level", default="info", help="uvicorn 日志级别")
    args = parser.parse_args(argv)

    models_dir = Path(args.models_dir).resolve()
    data_dir = Path(args.data_dir).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    models_dir.mkdir(parents=True, exist_ok=True)

    jobs = JobManager(models_dir=models_dir, data_dir=data_dir)
    app = build_app(jobs=jobs, data_dir=data_dir)

    # Bind the running loop so worker threads can schedule WS broadcasts.
    @app.on_event("startup")
    async def _bind_loop() -> None:
        jobs.bind_event_loop(asyncio.get_running_loop())
        service_info = {"host": args.host, "port": args.port, "started_at": time.time()}
        (data_dir / "service.json").write_text(
            json.dumps(service_info, indent=2), encoding="utf-8"
        )

    # Bind a real port (uvicorn handles port=0) so we know what to print.
    config = uvicorn.Config(
        app, host=args.host, port=args.port, log_level=args.log_level, access_log=False
    )
    server = uvicorn.Server(config)

    # We want to know the bound port for the discovery line. uvicorn.Server
    # populates `server.servers[0].sockets[0].getsockname()` after startup.
    async def _run_and_print() -> None:
        install_task = asyncio.create_task(server.serve())
        # Wait until the server is actually serving
        while not server.started:
            await asyncio.sleep(0.05)
        # Discover the bound port
        sock = server.servers[0].sockets[0]
        bound_host, bound_port = sock.getsockname()[:2]
        # Update service.json with the real bound port
        service_info = {
            "host": bound_host,
            "port": bound_port,
            "started_at": time.time(),
        }
        (data_dir / "service.json").write_text(
            json.dumps(service_info, indent=2), encoding="utf-8"
        )
        # stdout marker line — Electron parses this
        print(f"SWING_SERVICE_URL=http://{bound_host}:{bound_port}", flush=True)
        await install_task

    try:
        asyncio.run(_run_and_print())
    except KeyboardInterrupt:
        print("\n[shutdown] Ctrl+C", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())