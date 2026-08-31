# 02 · Architecture

## The four layers

```
┌─────────────────────────────────────────────────────────────────┐
│  L4 · UI                                                        │
│      • Electron renderer (React, /src/renderer)                 │
│      • CLI terminal (no extra deps)                             │
│      • (Phase C) Browser, mobile, anything that speaks HTTP     │
└──────────────────────────────┬──────────────────────────────────┘
                               │  calls into L3
┌──────────────────────────────▼──────────────────────────────────┐
│  L3 · Service / Transport                                       │
│      • FastAPI app        (REST + WS + Range streaming)         │
│      • JobManager         (lifecycle + WS broadcast)            │
│      • pydantic schemas   (wire types)                          │
└──────────────────────────────┬──────────────────────────────────┘
                               │  calls into L2
┌──────────────────────────────▼──────────────────────────────────┐
│  L2 · Pipeline  (the seam)                                      │
│      • backend/service/pipeline.py  — run_pipeline()            │
│      • callbacks: progress_cb / on_segment / should_cancel      │
└──────────────────────────────┬──────────────────────────────────┘
                               │  imports from L1 (no edits)
┌──────────────────────────────▼──────────────────────────────────┐
│  L1 · Algorithm  (the truth)                                    │
│      • backend/core/segment_swing.py  (vendored, byte-for-byte) │
│      • MediaPipe task model (5.5 MB, committed)                 │
└─────────────────────────────────────────────────────────────────┘
```

**The seam is between L2 and L1.** Every UI goes through `run_pipeline()`.
The algorithm is never imported by anything except the pipeline.

## What lives in each layer

### L1 — Algorithm (`backend/core/`)

- `segment_swing.py` (952 lines) — vendored verbatim from
  `ace-crush-lab/app/scripts/segment_swing.py`. Exposes `PoseRunner`,
  `OnlineSegmenter`, `segment_cycles`, `bridge_gaps`, `ema_smooth`,
  `compute_velocity_2d`, `extract_one_clip`, `phase_timeline`,
  `SwingSegment`, `_frames_to_tc`.
- `pose_landmarker_lite.task` (5.5 MB) — MediaPipe Pose model, committed.

### L2 — Pipeline (`backend/service/pipeline.py`)

A single function:

```python
run_pipeline(
    video_path: Path,
    task_path: Path,
    out_dir: Path,
    params: Optional[Dict] = None,
    progress_cb: Optional[Callable[[Dict], None]] = None,
    on_segment: Optional[Callable[[Dict], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict
```

It reproduces the Pass 1 + Pass 1.5 + Pass 2 control flow from
`core.segment_swing.main()`, replacing the stdout `ProgressBar` with a
`progress_cb` callback and the `print()` of each emitted segment with an
`on_segment` callback. Returns the full `segments.json` payload as a dict.

### L3 — Service / Transport (`backend/service/`)

- `app.py` — FastAPI factory; CORS for any localhost port; routes for
  health / jobs / events / videos / artifacts.
- `jobs.py` — `JobManager` keeps an in-memory registry of `_JobRecord`s.
  A `ThreadPoolExecutor(max_workers=1)` enforces single-job concurrency
  (MediaPipe VIDEO mode is stateful and CPU-bound). Each job has an event
  replay buffer (deque, maxlen=1024) for late WS subscribers.
- `schemas.py` — `JobParams`, `JobCreate`, `JobAccepted`, `JobInfo`,
  `SegmentOut`, `ProgressEvent`. Field names mirror the CLI flags exactly.
- `__main__.py` — argparse + uvicorn; prints `SWING_SERVICE_URL=...` to
  stdout so Electron can discover the bound port; writes `service.json`
  as a fallback.

### L4 — UI

- **CLI** (`backend/cli.py`) — argparse with defaults from `DEFAULT_PARAMS`,
  stdout progress line printer, real-time segment echo, SIGINT handler that
  flips a cancellation flag.
- **Electron** — see [05 · Electron GUI](05-electron-gui.md) for the
  sidecar lifecycle and renderer components.

## Vendor discipline

The rule is short: **the only thing that imports `core.segment_swing` is
`service/pipeline.py`**. If a future change requires importing a core
helper from anywhere else (e.g. the FastAPI app wants to peek at
`SwingSegment`), put the helper in `pipeline.py` first, then have core
re-export. This keeps `core/` interchangeable with any future
implementation.

When upstream `ace-crush-lab` updates the algorithm:

```bash
cp /path/to/ace-crush-lab/app/scripts/segment_swing.py backend/core/segment_swing.py
git add backend/core/segment_swing.py
git commit -m "vendor: sync segment_swing.py from upstream @ <hash>"
```

No merge conflicts. No "did anyone change this locally?" questions.

## Concurrency model

- **One job at a time.** `ThreadPoolExecutor(max_workers=1)`. MediaPipe
  VIDEO mode is stateful (each `PoseLandmarker` instance carries
  per-frame ROI tracking state) and saturates one CPU core. Parallelism
  would not help and would risk corrupting state.
- **WS broadcasts are cross-thread.** Worker thread calls
  `loop.call_soon_threadsafe(self._safe_send, ws, event)` to schedule a
  send on the asyncio loop. The receiver side is independent of the worker
  thread, so a slow / dropped WS client never blocks job progress.
- **Job lifecycle is independent of WS.** You can submit a job, close the
  WS, reopen it 10 minutes later, and reconnect will replay the buffered
  events (deque, maxlen=1024) followed by a final `GET /api/jobs/{id}` to
  reconcile.

## Cancellation

- `POST /api/jobs/{id}/cancel` flips a `threading.Event` in the
  `_JobRecord`.
- The pipeline loop checks `should_cancel()` once per frame and raises
  `JobCancelled` cleanly. The thread exits, the job state moves to
  `cancelled`, and any partial artifacts in `out_dir` are left on disk for
  inspection.
- The CLI installs a SIGINT handler that sets the same flag.

## What this design deliberately does not do

- **No persistent job queue.** Jobs live in memory; service restart loses
  them. Disk artifacts (`segments.json`, clips) survive.
- **No multi-user.** Bind address is `127.0.0.1` by default. Phase C adds
  bind-to-`0.0.0.0` + token auth for LAN scenarios.
- **No horizontal scaling.** Single-process, single-job. Adequate for a
  desktop tool.