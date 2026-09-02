"""FastAPI app factory.

Endpoints:
  GET  /api/health
  POST /api/jobs                                  create job, returns {job_id}
  GET  /api/jobs/{id}                             full job info (WS reconnect resync)
  POST /api/jobs/{id}/cancel                      request cancellation
  DELETE /api/jobs/{id}                           remove + clean artifacts
  WS   /api/jobs/{id}/events                      ProgressEvent stream (with replay)
  GET  /api/videos                                stream original video (Range)
  GET  /api/artifacts/{job_id}/{path}             serve segments.json / clips / viz.mp4
  GET  /api/jobs/{id}/clips                       list clip artifacts (plan 002)
  GET  /api/jobs/{id}/clips/{seg_id}/stream       H.264 preview stream (Range)
  GET  /api/jobs/{id}/clips/{seg_id}/thumbnail.jpg lazy mid-frame JPEG
  POST /api/jobs/{id}/clips:cleanup               wipe clips/ subdir
"""
from __future__ import annotations

import mimetypes
import shutil
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from .clip_codec import generate_thumbnail
from .jobs import JobManager
from .schemas import ClipCleanupResult, ClipInfo, JobAccepted, JobCreate, JobInfo


SERVICE_VERSION = "0.1.0"
CHUNK = 1024 * 256


def create_app(jobs: JobManager, data_dir: Path) -> FastAPI:
    app = FastAPI(title="Swing-Analysis service", version=SERVICE_VERSION)

    # CORS — any localhost/127.0.0.1 port so vite dev server works without fuss.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── health ──────────────────────────────────────────────────────────
    @app.get("/api/health")
    def health() -> dict:
        task_ready = any(
            (jobs._models_dir / n).exists()
            for n in ("pose_landmarker_lite.task", "pose_landmarker.task")
        )
        return {
            "status": "ok",
            "version": SERVICE_VERSION,
            "model_ready": task_ready,
            "models_dir": str(jobs._models_dir),
        }

    # ── jobs ────────────────────────────────────────────────────────────
    @app.post("/api/jobs", response_model=JobAccepted)
    def create_job(req: JobCreate) -> JobAccepted:
        vp = Path(req.video_path)
        if not vp.is_absolute():
            raise HTTPException(400, "video_path 必须是绝对路径")
        if not vp.exists():
            raise HTTPException(404, f"视频不存在: {vp}")
        rec = jobs.create(str(vp), req.params)
        return JobAccepted(job_id=rec.job_id)

    @app.get("/api/jobs/{job_id}", response_model=JobInfo)
    def get_job(job_id: str) -> JobInfo:
        info = jobs.to_info(job_id)
        if info is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        return info

    @app.post("/api/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict:
        if jobs.get(job_id) is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        ok = jobs.cancel(job_id)
        return {"ok": ok}

    @app.delete("/api/jobs/{job_id}")
    def delete_job(job_id: str) -> dict:
        if jobs.get(job_id) is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        if not jobs.delete(job_id):
            raise HTTPException(409, "运行中的 job 不能删除，请先 cancel")
        return {"ok": True}

    @app.websocket("/api/jobs/{job_id}/events")
    async def job_events(ws: WebSocket, job_id: str) -> None:
        await ws.accept()
        rec = jobs.get(job_id)
        if rec is None:
            await ws.send_json({"type": "error", "data": {"error": f"job 不存在: {job_id}"}})
            await ws.close()
            return
        for ev in jobs.subscribe(job_id, ws):
            try:
                await ws.send_json(ev)
            except Exception:  # noqa: BLE001
                return
        try:
            while True:
                msg = await ws.receive_text()
                if msg == "ping":
                    await ws.send_text("pong")
        except WebSocketDisconnect:
            pass
        finally:
            jobs.unsubscribe(job_id, ws)

    # ── video streaming (Range) ────────────────────────────────────────
    @app.get("/api/videos")
    def stream_video(request: Request, path: str = Query(...)) -> StreamingResponse:
        vp = Path(path)
        if not vp.is_absolute():
            raise HTTPException(400, "path 必须是绝对路径")
        if not vp.exists() or not vp.is_file():
            raise HTTPException(404, f"视频不存在: {vp}")
        return _range_stream(vp, request)

    # ── artifacts (segments.json / clips / viz.mp4) ────────────────────
    @app.get("/api/artifacts/{job_id}/{rel_path:path}")
    def artifact(job_id: str, rel_path: str) -> FileResponse:
        rec = jobs.get(job_id)
        if rec is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        target = (rec.out_dir / rel_path).resolve()
        if not str(target).startswith(str(rec.out_dir.resolve())):
            raise HTTPException(400, "路径越界")
        if not target.exists() or not target.is_file():
            raise HTTPException(404, f"artifact 不存在: {rel_path}")
        mt, _ = mimetypes.guess_type(str(target))
        return FileResponse(target, media_type=mt or "application/octet-stream")

    # ── clips (plan 002) ───────────────────────────────────────────────
    # listing glob is `clip_[0-9][0-9][0-9].mp4` so it naturally excludes
    # `_h264`, `_annotated`, and `.thumb.*` variants (those have a
    # different suffix before .mp4 / are a different extension).
    @app.get("/api/jobs/{job_id}/clips", response_model=List[ClipInfo])
    def list_clips(job_id: str) -> List[ClipInfo]:
        rec = jobs.get(job_id)
        if rec is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        clips_dir = rec.out_dir / "clips"
        if not clips_dir.exists() or not clips_dir.is_dir():
            return []
        out: List[ClipInfo] = []
        for p in sorted(clips_dir.glob("clip_[0-9][0-9][0-9].mp4")):
            seg_id = int(p.stem.split("_")[1])
            stem_id = f"clip_{seg_id:03d}"
            out.append(
                ClipInfo(
                    seg_id=seg_id,
                    exists=True,
                    size_bytes=p.stat().st_size,
                    playable=(clips_dir / f"{stem_id}_h264.mp4").exists(),
                    annotated=(clips_dir / f"{stem_id}_annotated.mp4").exists(),
                    thumb_ready=(clips_dir / f"{stem_id}.thumb.jpg").exists(),
                )
            )
        return out

    @app.get("/api/jobs/{job_id}/clips/{seg_id}/stream")
    def stream_clip(job_id: str, seg_id: int, request: Request) -> StreamingResponse:
        rec = jobs.get(job_id)
        if rec is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        # path: numeric seg_id only — FastAPI will coerce; bad input → 422
        path = rec.out_dir / "clips" / f"clip_{seg_id:03d}_h264.mp4"
        if not path.exists() or not path.is_file():
            raise HTTPException(
                404,
                "clip 无 H.264 预览（转码不可用），请用原视频 timecode 定位",
            )
        return _range_stream(path, request)

    @app.get("/api/jobs/{job_id}/clips/{seg_id}/thumbnail.jpg")
    def clip_thumbnail(job_id: str, seg_id: int) -> FileResponse:
        rec = jobs.get(job_id)
        if rec is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        clips_dir = rec.out_dir / "clips"
        mp4 = clips_dir / f"clip_{seg_id:03d}.mp4"
        thumb = clips_dir / f"clip_{seg_id:03d}.thumb.jpg"
        if not mp4.exists() or not mp4.is_file():
            raise HTTPException(404, f"clip 不存在: seg_id={seg_id}")
        if not thumb.exists():
            ok = generate_thumbnail(mp4, thumb)
            if not ok or not thumb.exists():
                raise HTTPException(404, "缩略图生成失败")
        return FileResponse(thumb, media_type="image/jpeg")

    # Note the colon in the path — keeps `cleanup` from being mistaken
    # for a numeric seg_id by a future `GET /clips/{seg_id}` route.
    @app.post("/api/jobs/{job_id}/clips:cleanup", response_model=ClipCleanupResult)
    def cleanup_clips(job_id: str) -> ClipCleanupResult:
        rec = jobs.get(job_id)
        if rec is None:
            raise HTTPException(404, f"job 不存在: {job_id}")
        if rec.state in ("queued", "running"):
            raise HTTPException(
                409,
                f"job 状态为 {rec.state}，clips 可能仍在写入，禁止清理；请先 cancel 或等待完成",
            )
        clips_dir = rec.out_dir / "clips"
        if not clips_dir.exists() or not clips_dir.is_dir():
            return ClipCleanupResult(deleted_count=0, freed_bytes=0)
        deleted = 0
        freed = 0
        for f in clips_dir.rglob("*"):
            if f.is_file():
                try:
                    freed += f.stat().st_size
                except OSError:
                    pass
                deleted += 1
        shutil.rmtree(clips_dir, ignore_errors=True)
        return ClipCleanupResult(deleted_count=deleted, freed_bytes=freed)

    return app


# ── Range streaming ──────────────────────────────────────────────────────
def _range_stream(path: Path, request: Request) -> StreamingResponse:
    size = path.stat().st_size
    mt, _ = mimetypes.guess_type(str(path))
    media_type = mt or "application/octet-stream"
    range_header = request.headers.get("range") or request.headers.get("Range")
    if range_header:
        try:
            units, _, rest = range_header.partition("=")
            if units.strip().lower() != "bytes":
                raise ValueError
            start_s, _, end_s = rest.partition("-")
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1
            start = max(0, min(start, size - 1))
            end = max(start, min(end, size - 1))
        except ValueError:
            return JSONResponse({"error": "invalid Range"}, status_code=416)
        length = end - start + 1

        def gen():
            with path.open("rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    buf = f.read(min(CHUNK, remaining))
                    if not buf:
                        break
                    yield buf
                    remaining -= len(buf)

        headers = {
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
        }
        return StreamingResponse(gen(), status_code=206, headers=headers, media_type=media_type)

    headers = {"Accept-Ranges": "bytes", "Content-Length": str(size)}

    def full():
        with path.open("rb") as f:
            while True:
                buf = f.read(CHUNK)
                if not buf:
                    break
                yield buf

    return StreamingResponse(full(), headers=headers, media_type=media_type)


def build_app(jobs: JobManager, data_dir: Path) -> FastAPI:
    return create_app(jobs, data_dir)