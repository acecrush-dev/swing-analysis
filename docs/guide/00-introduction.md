# 00 · Introduction

## What problem does this solve?

A coach shooting match footage wants to find every forehand, backhand, and
serve in a 10-minute video, extract them as clips, and annotate what the
player did right (or wrong) at the moment of contact. Doing this by hand
takes hours. Doing it by hand *again* every time you tweak parameters takes
even longer.

`swing-analysis` automates the **finding and clipping** step. You give it a
video and (optionally) some tuning knobs; it gives you back a list of swing
cycles with phase boundaries (`ready / windup / contact / follow_through`)
and pre-cut clip MP4s.

## What it deliberately does NOT do

- **No shot-quality scoring.** This is segmentation, not analysis. Whether
  the forehand was technically correct is a separate, downstream problem
  (see [`backend/core/analyze_swing.py`](../../backend/core/analyze_swing.py) —
  it draws the 33-point skeleton and clips but does not score shots).
- **No cloud service.** Everything runs locally on your machine. The
  FastAPI service binds to `127.0.0.1` by default. Opening it up to a LAN
  is `Phase C` work.
- **No automatic model updates.** The MediaPipe Pose model is pinned
  (`pose_landmarker_lite.task`, 5.5 MB) and committed to the repo. Upgrade
  deliberately.

## Who is it for?

- Coaches / players who already have a video workflow and want to skip the
  manual clipping tedium.
- Engineers integrating the algorithm into a bigger system (e.g. an
  analysis dashboard) — they use the REST API and don't touch Electron.
- Researchers experimenting with the algorithm's parameters — they use the
  CLI to iterate quickly.

## Why the layered design?

Two principles:

1. **The algorithm library is sacred.** All three scripts in `backend/core/`
   are vendored byte-for-byte — `segment_swing.py`, `analyze_swing.py`,
   `gen_skeleton_anim.py`. Any change must come from the underlying source
   first, then be re-copied. This guarantees that any "fix" you make here
   is reproducible from a single `cp`.

2. **UIs are replaceable.** A CLI is a UI. A desktop app is a UI. A browser
   tab is a UI. They all want to do the same thing — submit a job, watch
   progress, retrieve results. The right shape is one algorithm function
   (`run_pipeline()`) callable from any of them.

This shape is what makes the GUI just a thin shell on top of the CLI. No
algorithm code in the renderer. No "I have to maintain two implementations"
debt.

## When NOT to use this

- You need real-time pose tracking (this is offline batch — Pass 1 + 1.5
  takes ~1s per frame on M-series Mac).
- You want a polished standalone skeleton animation video with smart-zoom
  cropping (no swing detection, just the overlay). Run
  `python3 backend/core/gen_skeleton_anim.py --help` directly — it's the
  same algorithm, but packaged for animation-only use.
- You want a hosted web app. This is local-first by design; Phase C sketches
  a self-hosted option but it's not built.

## What does "swing" mean here?

A complete cycle is `ready → windup → contact → follow_through`. The
algorithm uses the player's right wrist position (MediaPipe landmark 16)
over time as its primary signal: starts when wrist speed exceeds a
threshold, ends when it stops. Adjacent active intervals within 1.5s
(inferred rest) or 1.5s (inferred lost-detection) merge into one cycle;
otherwise they split.

See [06 · Algorithm](06-algorithm.md) for the full pipeline.