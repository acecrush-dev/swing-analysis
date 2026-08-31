# 03 · CLI Usage

`python -m backend.cli` — the simplest way to run the pipeline. No service,
no socket, no Electron. Just stdin/stdout and a result on disk.

## Synopsis

```bash
python3 -m backend.cli --video <abs-or-rel.mp4> [options]
```

## Required

| Flag | Meaning |
| --- | --- |
| `--video PATH` | Input video. Absolute or relative to CWD / repo root. |

## Common flags (with defaults)

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out-dir PATH` | `backend/data/cli_jobs/` | Where `segments.json` (and clips / viz) land |
| `--max-frames N` | `0` (all) | Stop after N frames — debugging & smoke tests |
| `--save-clips` | off | Write `out_dir/clips/clip_NNN.mp4` per cycle |
| `--viz-video` | off | Write `out_dir/viz.mp4` with colored phase bars |
| `--quiet` | off | Suppress progress / segment lines (script-friendly) |

## Tuning knobs (mirror `core.segment_swing.py`)

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

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success — JSON written |
| `1` | Bad input (video not found, model not found) or runtime exception |
| `130` | Cancelled by user (SIGINT / Ctrl+C) |

## Output layout

```
<out-dir>/
├── segments.json              # always
├── clips/
│   ├── clip_001.mp4           # only with --save-clips
│   ├── clip_002.mp4
│   └── ...
└── viz.mp4                    # only with --viz-video
```

`segments.json` is byte-for-byte compatible with the CLI version of
`ace-crush-lab/app/scripts/segment_swing.py` — same keys, same units, same
phase schema.

## Examples

### Smoke test (debug speed, don't pollute output dir)

```bash
python3 -m backend.cli \
    --video /abs/fdl.mp4 \
    --max-frames 60 \
    --out-dir /tmp/swing_smoke
```

### Full run with clips + viz

```bash
python3 -m backend.cli \
    --video /abs/match.mp4 \
    --save-clips \
    --viz-video \
    --out-dir /Users/me/swing_out/match_2026_08_31
```

### Stricter merging for a fast-paced rally

```bash
python3 -m backend.cli \
    --video /abs/serve.mp4 \
    --gap-merge 0.8 \
    --max-bridge 0.8 \
    --out-dir /tmp/swing_strict
```

### Looser merging for slow swings

```bash
python3 -m backend.cli \
    --video /abs/slow.mp4 \
    --gap-merge 2.5 \
    --min-peak 0.2 \
    --out-dir /tmp/swing_loose
```

## Pipeline parity with the REST service

The CLI calls `run_pipeline()` directly. The REST service calls the same
function inside `JobManager._run()`. There is no functional divergence —
same algorithm, same parameters, same outputs. Use whichever UI matches
your context (terminal for batch jobs, REST for clients, GUI for
exploration).