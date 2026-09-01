# 06 · Algorithm

The cutting pipeline is `v2.1`. This chapter explains *what* each phase
does, *why* v2 exists at all, and *which* parameters matter most for
tuning. The implementation in `backend/core/segment_swing.py` is the
source of truth — read it for the line-level details.

## Why v2?

v1 had three concrete bugs on real footage (`fdl.mp4`, ~9.4 minutes):

| Bug | Symptom | Root cause |
| --- | --- | --- |
| **a** | One swing split into `[windup]+[hit]` | The "rest" threshold (≥ N frames below `v_rest`) fired on the pause at the top of the windup |
| **b** | Phantom speed spikes (~0.74) during stillness | Cross-gap differencing over a ring buffer of lost-detection frames |
| **c** | Hit timestamp landed on the windup rotation, not the contact | Using y-axis speed only — horizontal forehand motion is invisible |

v2 fixes all three.

## Two-pass design

```
                  Pass 1  (online, sequential read)
                  ────────────────────────────────
   video  ──▶  MediaPipe Pose  ──▶  EMA(x,y)  ──▶  v2D speed  ──▶  OnlineSegmenter
                                                                    │
                                                                    ├─ on emit → background clip extraction
                                                                    └─ on emit → WS `segment.emitted`

                  Pass 1.5  (offline, post Pass 1)
                  ────────────────────────────────
   raw (x,y)  ──▶  bridge_gaps (≤max_lost)  ──▶  EMA  ──▶  v2D  ──▶  segment_cycles
                                                                            │
                                                                            └─ emit `segments.json`
```

Why two passes? Because Pass 1 must read sequentially (MediaPipe VIDEO mode
is stateful — each frame's ROI tracker depends on the previous), but the
*correct* segmentation needs to know about future frames (lost-detection
gaps, where the swing actually started, etc.). Pass 1 gives users instant
feedback; Pass 1.5 gives the authoritative final cut.

## Pass 1 — OnlineSegmenter

```python
class OnlineSegmenter:
    def update(self, frame_idx: int, v: Optional[float]) -> Optional[SwingSegment]:
        ...
```

- State: `active`, `run_start`, `run_end`, `peak_v`, `peak_frame`,
  `gap_count`
- Each frame:
  1. If `v > v_swing` and we were inactive, check whether the *previous*
     run has been inactive for > `gap_merge_sec` — if so, emit it as a
     closed segment
  2. If `v > v_swing`, extend the current run; update peak
  3. If `v <= v_swing` and we were active, start counting the gap
  4. If `v <= v_swing` and the gap exceeds `gap_merge_sec`, emit
- On stream end, `flush(last_frame_idx)` emits whatever run is still open,
  with `buf_after` frames of padding

Precision is lower than Pass 1.5 (no lost-detection classification, no
unknown-gap handling), but every emit is a real segment.

## Pass 1.5 — segment_cycles

The offline function takes the full velocity array and emits final
segments. Key idea: **two kinds of gaps**.

| Gap type | How detected | Merge threshold |
| --- | --- | --- |
| **Inferred rest** | Speed samples in the gap exist, all below `v_swing` | `gap_merge_sec` (default 1.5s) |
| **Lost detection** | No speed samples (every wrist was missed) | `max_bridge_sec` (default 1.5s) |

Why the distinction? Real gaps between swings tend to be ≥ 3s on
fdl.mp4; pauses inside one swing (e.g. the ball toss on a serve) tend to
be ≤ 1s. If you lump them together, you either chain multiple swings into
one or chop a single swing in two. The two thresholds are independent
controls.

Then:

- Drop cycles where `peak_v < min_peak` (filter out non-swing motions:
  picking up a ball, walking back to position)
- Drop cycles where duration < `min_dur`
- Mark cycles longer than `max_dur` as `over_long: true` (keep them, but
  flag — usually means two swings chained)
- For each surviving cycle, compute the four phases:
  - `ready`: buffer before `active_start_frame`
  - `windup`: `active_start_frame` → contact window
  - `contact`: ±0.12s around `contact_frame` (the peak-speed frame)
  - `follow_through`: contact window end → `active_end_frame`

## Tuning guide

> All numbers below come from fdl.mp4 with a 30 fps tennis recording. Adjust
> for your footage, frame rate, and player style.

| Goal | Knob | Direction |
| --- | --- | --- |
| Catch slow swings the algorithm is dropping | `--min-peak` | **lower** (try 0.20 → 0.10) |
| Skip small motions (picking up ball) | `--min-peak` | **higher** (try 0.40 → 0.50) |
| Chain two adjacent swings into one | `--gap-merge` | **higher** (try 2.0 → 3.0) |
| Split a slow-rhythm swing into two | `--gap-merge` | **lower** (try 1.0 → 0.6) |
| Deal with long lost-detection runs | `--max-bridge` | **higher** (try 2.5) |
| The lost-detection threshold seems too eager | `--max-bridge` | **lower** (try 0.8) |
| Reduce noise in the speed signal | `--smooth-alpha` | **lower** (try 0.4 → 0.5) |
| Track quick wrist flicks | `--smooth-alpha` | **higher** (try 0.8) |
| Don't pad clips so much | `--buf-before` / `--buf-after` | **lower** (try 0.5) |
| Process only the start of a video | `--max-frames` | any non-zero value |

The two most impactful are `--min-peak` and `--gap-merge`. They handle
the most common mis-segmentations.

## What's "the algorithm" exactly?

`backend/core/segment_swing.py` (952 lines). Exposes:

```python
# signal processing
bridge_gaps(series, valid, max_lost) -> List[Optional[float]]
ema_smooth(series, alpha) -> List[Optional[float]]
compute_velocity_2d(xs, ys, fps) -> List[Optional[float]]

# segmentation
segment_cycles(v, fps, *, v_swing, gap_merge_sec, max_bridge_sec,
               min_peak, min_dur, max_dur, buf_before, buf_after) -> List[SwingSegment]

# streaming
class OnlineSegmenter: ...
class PoseRunner: ...            # wraps MediaPipe
def extract_one_clip(in_path, seg, clips_dir, fps, w, h): ...
def phase_timeline(seg, fps) -> List[Tuple[str, int, int]]: ...
```

The pipeline in `backend/service/pipeline.py` is the only caller. If the
underlying source adds a new function (e.g. `dedup_overlapping` or
`score_swing_quality`), it lands here by copy-paste; nothing else needs
to know.

## Models at play

Three ONNX / TFLite models live under `backend/models/` (all committed):

| Model | Size | Used by | When |
| --- | --- | --- | --- |
| `pose_landmarker_lite.task` | 5.5 MB | segmentation wrist signal | always (Pass 1) |
| `rtmdet-m-487628.onnx` | 104 MB | clip bbox overlay | when `clip_bbox` (or `--bbox`) is set |
| `rtmpose-m-27c0e6.onnx` | 52 MB | clip COCO-13 skeleton | when `clip_skel` (or `--skel`) and `--skel-backend rtmpose` |

The segmentation algorithm itself (`backend/core/segment_swing.py`) only
imports the MediaPipe Pose model. RTMDet and RTMPose are exclusively used
by the `ClipAnnotator` to enrich already-cut clips — they do **not**
participate in segmentation. This keeps the algorithm library untouched
and the same vendoring rule ("re-copy on update") applies.

## Syncing from the underlying source

```bash
# Re-vendor the three algorithm scripts in one go
cp <new-segment_swing.py>     backend/core/segment_swing.py
cp <new-analyze_swing.py>     backend/core/analyze_swing.py
cp <new-gen_skeleton_anim.py> backend/core/gen_skeleton_anim.py
git add backend/core/
git commit -m "vendor: sync from underlying source @ <hash>"
```

That's it. No review of "did we accidentally change something locally",
because the files are committed verbatim.

## The other two vendored algorithms

`backend/core/` ships two more independent algorithms alongside `segment_swing.py`:

- **`analyze_swing.py`** — single-pass MediaPipe 33-point analysis. Wrist
  feeds the same `OnlineSegmenter`; the 33 points are kept per frame so
  clip overlays and full-video `viz.mp4` are guaranteed 1:1 with the
  segments list. No more "5 vs 11 segments" race between online and
  offline passes.
- **`gen_skeleton_anim.py`** — RTMDet (bbox) + RTMPose / MediaPipe
  (skeleton) four-quadrant compositor with smart-zoom cropping. Use when
  you want a polished overlay video independent of swing detection.

Both are runnable as standalone CLIs — see
[03 · CLI Usage](03-cli-usage.md#standalone-vendored-algorithm-clis) for
their flags and output shapes.