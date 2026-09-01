# 02 · Architecture

## The four layers (with the pose-runner extension)

```
┌─────────────────────────────────────────────────────────────────┐
│  L4 · UI                                                        │
│      • Electron renderer (React, /src/renderer)                 │
│      • CLI sub-commands:  segment  /  annotate                  │
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
│  L2 · Pipeline  (the seam — composes per user flags)            │
│      • backend/service/pipeline.py            run_pipeline()    │
│      • backend/service/pose_runners/                              │
│          ├── rtmdet.py      ONNX RTMDet person detector           │
│          ├── rtmpose.py     ONNX RTMPose COCO-13 estimator        │
│          ├── mediapipe.py   MediaPipe 33-point estimator          │
│          ├── drawing.py     bbox / skeleton overlay (cv2 only)    │
│          └── annotate.py    ClipAnnotator (bbox + skel on a clip) │
└──────────────────────────────┬──────────────────────────────────┘
                               │  imports from L1 (no edits)
┌──────────────────────────────▼──────────────────────────────────┐
│  L1 · Algorithm  (the truth)                                    │
│      • backend/core/segment_swing.py  (vendored, byte-for-byte) │
│      • MediaPipe task model (5.5 MB, committed)                 │
│      • RTMDet ONNX (104 MB, committed)                          │
│      • RTMPose ONNX (52 MB, committed)                          │
└─────────────────────────────────────────────────────────────────┘
```

**The seam is between L2 and L1.** Every UI goes through `run_pipeline()`.
The algorithm is never imported by anything except the pipeline.

**Each pose-runner module is pure** — no I/O, no orchestration. The pipeline
layer (`pipeline.py`) composes them based on user flags; the CLI `annotate`
sub-command composes them standalone.

## What lives in each layer

### L1 — Algorithm (`backend/core/`)

Three vendored scripts, each independently runnable as a CLI and each
importable as a library:

| Script | Lines | Purpose | Public surface |
| --- | --- | --- | --- |
| `segment_swing.py` | 952 | v2.1 wrist-signal cut pipeline (the one `backend.cli segment` wraps) | `PoseRunner`, `OnlineSegmenter`, `segment_cycles`, `bridge_gaps`, `ema_smooth`, `compute_velocity_2d`, `extract_one_clip`, `phase_timeline`, `SwingSegment`, `_frames_to_tc` |
| `analyze_swing.py` | 450 | MediaPipe 33-point once. Wrist feeds `OnlineSegmenter`; full 33 stored per frame so clips + viz.mp4 are guaranteed 1:1 with the segments list | `MediaPipePoseRunner`, `draw_skeleton_33`, `extract_skel_clip`, `render_full_viz`, `main()` |
| `gen_skeleton_anim.py` | 1021 | RTMDet (bbox) + RTMPose / MediaPipe (skeleton) four-quadrant compositor. Optional smart-zoom ROI + stable smoother + auto-sizing | `RtmdetRunner`, `RtmposeRunner`, `MediaPipePoseRunner`, `KeypointSmoother`, `CenterSmoother`, `StableBoxAutoSizer`, `build_algo_label`, `draw_skeleton`, `resolve_models`, `build_runners` |

All three are byte-for-byte vendored — no edits inside `core/`. Drift
between this repo and the underlying source is resolved by `cp`, never by
hand-merging.

Models committed to the repo:

- `pose_landmarker_lite.task` (5.5 MB) — MediaPipe Pose model.
- `rtmdet-m-487628.onnx` (104 MB) — RTMDet person detector.
- `rtmpose-m-27c0e6.onnx` (52 MB) — RTMPose COCO-13 estimator.

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
    on_clip_annotated: Optional[Callable[[Dict], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict
```

It reproduces the Pass 1 + Pass 1.5 + Pass 2 control flow from
`core.segment_swing.main()`, replacing the stdout `ProgressBar` with a
`progress_cb` callback and the `print()` of each emitted segment with an
`on_segment` callback. If `params["clip_bbox"]` or `params["clip_skel"]` is
set, each extracted clip is post-processed by `ClipAnnotator` (L2
pose-runners module) which uses RTMDet and/or RTMPose/MediaPipe to overlay
bbox + skeleton. Returns the full `segments.json` payload as a dict.

### L2 — pose-runners (`backend/service/pose_runners/`)

Each module does one thing; pipeline / `annotate` CLI compose them.

| Module | Class / fn | Inputs | Outputs |
| --- | --- | --- | --- |
| `rtmdet.py` | `RtmdetRunner` | BGR frame | `List[BBox]` (person detections) |
| `rtmpose.py` | `RtmposeRunner` | BGR frame + optional BBox | `List[(x,y,conf)]` (COCO-13 keypoints) |
| `mediapipe.py` | `MediaPipePoseRunner` | BGR frame + ts_ms | `List[(x,y,conf)]` (33 keypoints) |
| `drawing.py` | `draw_bboxes` / `draw_skeleton_coco13` / `draw_skeleton_mp33` | canvas + payload | mutated canvas |
| `annotate.py` | `ClipAnnotator` | clip mp4 + flags | annotated mp4 |

Composition happens in:
- `pipeline.run_pipeline()` — chains `extract_one_clip` → `ClipAnnotator.annotate_clip` when `clip_bbox` or `clip_skel` is set.
- `cli.cmd_annotate()` — runs `ClipAnnotator` standalone on every `clip_*.mp4` in a directory (post-hoc).

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

When the underlying source updates one of the three vendored scripts:

```bash
cp <new-segment_swing.py>     backend/core/segment_swing.py
cp <new-analyze_swing.py>     backend/core/analyze_swing.py
cp <new-gen_skeleton_anim.py> backend/core/gen_skeleton_anim.py
git add backend/core/
git commit -m "vendor: sync from underlying source @ <hash>"
```

No merge conflicts. No "did anyone change this locally?" questions — the
files are committed verbatim.

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