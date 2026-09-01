# 03 · CLI Usage

`python -m backend.cli` — two sub-commands, each pure.

```
backend.cli
├── segment   从视频切出挥拍周期 (+ 可选 clip 标注)
└── annotate  对已有 clip_*.mp4 跑 RTMDet / 骨架标注 (后处理)
```

The `segment` sub-command drives the segmentation pipeline; `annotate` is
the standalone clip-enrichment step (the same logic the pipeline runs when
you pass `--clip-bbox` / `--clip-skel`).

## `segment` sub-command

### Synopsis

```bash
python3 -m backend.cli segment --video <abs-or-rel.mp4> [options]
```

### Required

| Flag | Meaning |
| --- | --- |
| `--video PATH` | Input video. Absolute or relative to CWD / repo root. |

### Common flags (with defaults)

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out-dir PATH` | `backend/data/cli_jobs/` | Where `segments.json` (and clips / viz) land |
| `--max-frames N` | `0` (all) | Stop after N frames — debugging & smoke tests |
| `--save-clips` | off | Write `out_dir/clips/clip_NNN.mp4` per cycle |
| `--viz-video` | off | Write `out_dir/viz.mp4` with colored phase bars |
| `--clip-bbox` | off | Per-clip: overlay RTMDet person bbox |
| `--clip-skel` | off | Per-clip: overlay pose skeleton |
| `--skel-backend {rtmpose,mediapipe}` | `rtmpose` | Which model draws the skeleton overlay |
| `--quiet` | off | Suppress progress / segment lines (script-friendly) |

### Tuning knobs (mirror `core.segment_swing.py`)

| Flag | Default | What it does |
| --- | --- | --- |
| `--v-swing` | `0.10` | Active-interval speed threshold (normalized width/sec) |
| `--gap-merge` | `1.5` s | Inferred-rest gaps ≤ this merge into one swing |
| `--max-bridge` | `1.5` s | Lost-detection gaps ≤ this merge (unknown ≠ rest) |
| `--min-peak` | `0.30` | Drop cycles whose peak speed is below this |
| `--smooth-alpha` | `0.65` | EMA smoothing factor (1.0 = none, 0.5 = strong) |
| `--max-lost-frames` | `8` | Linear-interpolate wrist gaps up to this many frames |
| `--min-dur` | `0.3` s | Drop cycles shorter than this |
| `--max-dur` | `6.0` s | Keep but mark cycles longer than this (`over_long: true`) |
| `--buf-before` | `1.0` s | Buffer before `active_start_frame` for clip |
| `--buf-after` | `1.0` s | Buffer after `active_end_frame` for clip |
| `--skip` | `1` | Pose sampling stride; >1 leaves intermediate frames as None |

See [06 · Algorithm](06-algorithm.md) for the meaning of each in context.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — JSON written |
| `1` | Bad input (video not found, model not found) or runtime exception |
| `130` | Cancelled by user (SIGINT / Ctrl+C) |

### Output layout

```
<out-dir>/
├── segments.json              # always
├── clips/
│   ├── clip_001.mp4           # only with --save-clips
│   ├── clip_001_annotated.mp4 # only with --clip-bbox or --clip-skel
│   ├── clip_002.mp4
│   └── ...
└── viz.mp4                    # only with --viz-video
```

`segments.json` schema is the same as what `backend/core/segment_swing.py`
emits when run standalone — same keys, same units, same phase schema.

### Examples

#### Smoke test (debug speed, don't pollute output dir)

```bash
python3 -m backend.cli segment \
    --video /abs/fdl.mp4 \
    --max-frames 60 \
    --out-dir /tmp/swing_smoke
```

#### Full run with clips + viz

```bash
python3 -m backend.cli segment \
    --video /abs/match.mp4 \
    --save-clips \
    --viz-video \
    --out-dir /Users/me/swing_out/match_2026_08_31
```

#### Full run with bbox + skeleton overlay on each clip

```bash
python3 -m backend.cli segment \
    --video /abs/match.mp4 \
    --save-clips \
    --clip-bbox \
    --clip-skel \
    --skel-backend rtmpose \
    --out-dir /Users/me/swing_out/match_annotated
# → clips/clip_001.mp4          (raw cut)
# → clips/clip_001_annotated.mp4 (bbox + skeleton overlay)
```

#### Stricter merging for a fast-paced rally

```bash
python3 -m backend.cli segment \
    --video /abs/serve.mp4 \
    --gap-merge 0.8 \
    --max-bridge 0.8 \
    --out-dir /tmp/swing_strict
```

## `annotate` sub-command

Runs RTMDet (bbox) and/or pose skeleton overlay on every `clip_*.mp4` in a
directory. Independent of segmentation — works on any pre-cut clips.

### Synopsis

```bash
python3 -m backend.cli annotate --clips-dir <dir> [--bbox] [--skel] [--skel-backend {rtmpose,mediapipe}]
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--clips-dir DIR` | (required) | Directory to scan for `clip_*.mp4` (files ending in `_annotated.mp4` are skipped) |
| `--bbox` | off | Draw RTMDet person bbox on every frame |
| `--skel` | off | Draw pose skeleton on every frame |
| `--skel-backend {rtmpose,mediapipe}` | `rtmpose` | Which model provides the skeleton |

### Examples

#### Annotate already-cut clips with both overlays

```bash
python3 -m backend.cli annotate \
    --clips-dir backend/data/jobs/<id>/clips \
    --bbox \
    --skel
# → <id>/clips/clip_001_annotated.mp4 (next to the original)
```

#### Just skeleton (no bbox)

```bash
python3 -m backend.cli annotate \
    --clips-dir /path/to/clips \
    --skel \
    --skel-backend mediapipe
```

## Pipeline parity with the REST service

`segment` calls `run_pipeline()` directly. The REST service calls the same
function inside `JobManager._run()`. There is no functional divergence —
same algorithm, same parameters, same outputs. Use whichever UI matches
your context (terminal for batch jobs, REST for clients, GUI for
exploration).

`annotate` is also exposed standalone because clip enrichment is useful as
a post-hoc step — re-run it on the same clips with different flags
without re-doing segmentation.

## Standalone vendored algorithm CLIs

The three scripts in `backend/core/` are independently runnable. Useful
when you want exactly one stage without the pipeline / service shell.

### `backend/core/analyze_swing.py`

The unified MediaPipe 33-point CLI. Runs once over the video with full
keypoints, then:

- writes `segments.json` (same schema as `segment`),
- optionally writes raw clips with `--save-clips`,
- optionally writes skeleton-overlay clips with `--skel-clips`,
- optionally writes a full-video `viz.mp4` (skeleton + cycle bars + bottom
  phase square-wave) with `--viz-full`.

```bash
python3 backend/core/analyze_swing.py \
    --file /abs/match.mp4 \
    --save-clips --skel-clips --viz-full
```

Why it guarantees 1:1 with the segments list: wrist + 33 points come from
the *same* MediaPipe inference per frame, and the segmentation step uses
the offline `segment_cycles()` over the full keypoint buffer — so clip
indices and segment indices always line up regardless of clip-race
conditions.

### `backend/core/gen_skeleton_anim.py`

RTMDet (bbox) + RTMPose / MediaPipe (skeleton) four-quadrant compositor.
No swing detection — just an overlay video.

| Quadrant | `--det-model` | `--pose-model` | Output |
| --- | --- | --- | --- |
| 1 | `.onnx` (RTMDet) | `.onnx` (RTMPose) | Classic ONNX pipeline, smart-zoom |
| 2 | `.onnx` (RTMDet) | `.task` (MediaPipe) | Hybrid — RTMDet ROI + MediaPipe 33-pt |
| 3 | `.onnx` (RTMDet) | (none / `--no-pose`) | Bbox-only |
| 4 | (none) | `.onnx` / `.task` | Full-frame pose, no ROI |

```bash
# Quadrant 1 — classic ONNX pipeline
python3 backend/core/gen_skeleton_anim.py \
    --file /abs/match.mp4 \
    --det-model rtmdet-m-487628.onnx \
    --pose-model rtmpose-m-27c0e6.onnx

# Quadrant 2 — hybrid (RTMDet bbox + MediaPipe 33-point skeleton)
python3 backend/core/gen_skeleton_anim.py \
    --file /abs/match.mp4 \
    --det-model rtmdet-m-487628.onnx \
    --pose-model pose_landmarker_lite.task

# Quadrant 4b — MediaPipe full-frame, no RTMDet
python3 backend/core/gen_skeleton_anim.py \
    --file /abs/match.mp4 \
    --pose-model pose_landmarker_lite.task
```

The output filename defaults to `<input>_skeleton_anim.mp4` next to the
input (the input is never overwritten — there's an explicit check).

### `backend/core/segment_swing.py`

Same algorithm that `backend.cli segment` wraps, run directly. Use this
when you want cut-only output and don't care about the Electron GUI's
clip / viz annotations:

```bash
python3 backend/core/segment_swing.py \
    --file /abs/match.mp4 \
    --max-frames 1500 \
    --out-dir /tmp/swing_out
```

Output goes to `<out-dir>/swing_segmenter/` (default behaviour of the
standalone script). For the service / CLI-friendly output shape, use
`backend.cli segment` instead — it emits to `backend/data/cli_jobs/<id>/`
with the same shape the REST service uses.