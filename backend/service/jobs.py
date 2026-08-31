"""JobManager — in-memory job registry, single-worker queue, WS event broadcast.

Why single-worker (max_workers=1)?
  MediaPipe Pose VIDEO mode eats one CPU core per job. Running two in parallel
  doesn't speed anything up and competes for cache. Queue them instead.

Event replay buffer:
  Late WS subscribers (reconnect after disconnect) want to receive past events.
  We keep an in-memory ring per job; on connect we flush, then live-stream.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Set

from fastapi import WebSocket

from .pipeline import JobCancelled, run_pipeline
from .schemas import JobInfo, JobParams, ProgressEvent


# ── job record ───────────────────────────────────────────────────────────
class _JobRecord:
    __slots__ = (
        "job_id", "state", "video_path", "task_path", "out_dir", "params",
        "created_at", "started_at", "finished_at", "error",
        "segments", "segments_payload", "_future", "_cancel_flag",
        "_events", "_ws_subs", "_lock",
    )

    def __init__(self, job_id: str, video_path: str, task_path: Path, out_dir: Path, params: JobParams):
        self.job_id = job_id
        self.state = "queued"
        self.video_path = video_path
        self.task_path = task_path
        self.out_dir = out_dir
        self.params = params
        self.created_at = time.time()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.error: Optional[str] = None
        self.segments: List[Dict] = []
        self.segments_payload: Optional[Dict] = None
        self._future: Optional[Future] = None
        self._cancel_flag = threading.Event()
        self._events: Deque[Dict] = deque(maxlen=1024)  # ring buffer for replay
        self._ws_subs: Set[WebSocket] = set()
        self._lock = threading.Lock()


    def append_event(self, event: Dict) -> None:
        with self._lock:
            self._events.append(event)


    def snapshot_events(self) -> List[Dict]:
        with self._lock:
            return list(self._events)


# ── manager ──────────────────────────────────────────────────────────────
class JobManager:
    def __init__(self, models_dir: Path, data_dir: Path):
        self._models_dir = models_dir
        self._data_dir = data_dir
        self._data_dir.mkdir(parents=True, exist_ok=True)
        self._jobs: Dict[str, _JobRecord] = {}
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="swing-job")
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._lock = threading.Lock()


    def bind_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """FastAPI calls this at startup so worker threads can schedule WS broadcasts."""
        self._loop = loop


    def _resolve_task(self) -> Path:
        cands = [
            self._models_dir / "pose_landmarker_lite.task",
            self._models_dir / "pose_landmarker.task",
        ]
        for c in cands:
            if c.exists():
                return c
        raise FileNotFoundError(
            f"未找到 MediaPipe task 模型，请放至 {self._models_dir}/pose_landmarker_lite.task"
        )


    def create(self, video_path: str, params: Optional[JobParams]) -> _JobRecord:
        job_id = uuid.uuid4().hex[:12]
        task_path = self._resolve_task()
        out_dir = self._data_dir / "jobs" / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        rec = _JobRecord(job_id, video_path, task_path, out_dir, params or JobParams())
        with self._lock:
            self._jobs[job_id] = rec
        rec._future = self._executor.submit(self._run, rec)
        return rec


    def get(self, job_id: str) -> Optional[_JobRecord]:
        return self._jobs.get(job_id)


    def list_ids(self) -> List[str]:
        return list(self._jobs.keys())


    def cancel(self, job_id: str) -> bool:
        rec = self._jobs.get(job_id)
        if rec is None:
            return False
        rec._cancel_flag.set()
        return True


    def delete(self, job_id: str) -> bool:
        rec = self._jobs.get(job_id)
        if rec is None:
            return False
        if rec.state == "running":
            return False  # refuse to delete a running job
        with self._lock:
            self._jobs.pop(job_id, None)
        # best-effort cleanup of artifacts
        import shutil
        if rec.out_dir.exists():
            shutil.rmtree(rec.out_dir, ignore_errors=True)
        return True


    def queue_position(self, job_id: str) -> Optional[int]:
        rec = self._jobs.get(job_id)
        if rec is None or rec.state != "queued":
            return None
        queued_ids = [j for j, r in self._jobs.items() if r.state == "queued"]
        try:
            return queued_ids.index(job_id) + 1
        except ValueError:
            return None


    # ── worker thread ─────────────────────────────────────────────────────
    def _run(self, rec: _JobRecord) -> None:
        rec.state = "running"
        rec.started_at = time.time()
        self._broadcast(rec, "job.started", {"video_path": rec.video_path})

        def progress_cb(d: Dict) -> None:
            self._broadcast(rec, "pose.progress", d)

        def on_segment(s: Dict) -> None:
            with rec._lock:
                rec.segments.append(s)
            self._broadcast(rec, "segment.emitted", {"segment": s})

        try:
            payload = run_pipeline(
                Path(rec.video_path),
                rec.task_path,
                rec.out_dir,
                params=rec.params.model_dump(),
                progress_cb=progress_cb,
                on_segment=on_segment,
                should_cancel=lambda: rec._cancel_flag.is_set(),
            )
            if rec._cancel_flag.is_set():
                rec.state = "cancelled"
                rec.finished_at = time.time()
                self._broadcast(rec, "job.cancelled", {})
                return

            with rec._lock:
                rec.segments_payload = payload
                rec.segments = payload.get("segments", [])
            rec.state = "done"
            rec.finished_at = time.time()
            self._broadcast(rec, "job.completed", {"segment_count": len(rec.segments)})

        except JobCancelled:
            rec.state = "cancelled"
            rec.finished_at = time.time()
            self._broadcast(rec, "job.cancelled", {})

        except Exception as exc:  # noqa: BLE001
            rec.state = "failed"
            rec.error = repr(exc)
            rec.finished_at = time.time()
            self._broadcast(rec, "job.failed", {"error": rec.error})


    # ── ws broadcast (thread-safe via call_soon_threadsafe) ──────────────
    def _broadcast(self, rec: _JobRecord, type_: str, data: Dict) -> None:
        event = ProgressEvent(type=type_, job_id=rec.job_id, data=data).model_dump()
        rec.append_event(event)
        if self._loop is None:
            return
        for ws in list(rec._ws_subs):
            asyncio.run_coroutine_threadsafe(self._safe_send(ws, event), self._loop)


    @staticmethod
    async def _safe_send(ws: WebSocket, event: Dict) -> None:
        try:
            await ws.send_json(event)
        except Exception:  # noqa: BLE001
            pass


    # ── ws subscription lifecycle ────────────────────────────────────────
    def subscribe(self, job_id: str, ws: WebSocket) -> List[Dict]:
        rec = self._jobs.get(job_id)
        if rec is None:
            return []
        rec._ws_subs.add(ws)
        return rec.snapshot_events()

    def unsubscribe(self, job_id: str, ws: WebSocket) -> None:
        rec = self._jobs.get(job_id)
        if rec is not None:
            rec._ws_subs.discard(ws)


    # ── info serialisation ──────────────────────────────────────────────
    def to_info(self, job_id: str) -> Optional[JobInfo]:
        rec = self._jobs.get(job_id)
        if rec is None:
            return None
        return JobInfo(
            job_id=rec.job_id,
            state=rec.state,
            video_path=rec.video_path,
            params=rec.params,
            created_at=rec.created_at,
            started_at=rec.started_at,
            finished_at=rec.finished_at,
            error=rec.error,
            segments=rec.segments,  # type: ignore[arg-type]
            segments_payload=rec.segments_payload,
            queue_position=self.queue_position(job_id),
        )