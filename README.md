# swing-analysis

[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://leochan007.github.io/swing-analysis/)
[![Docs (中文)](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](https://leochan007.github.io/swing-analysis/zh/)

**English** | [简体中文](README.zh-CN.md)

Desktop tennis-swing auto-segmentation. Wraps a battle-tested cutting pipeline
into a serviceable Python backend with a pluggable UI — the algorithm is
**vendored byte-for-byte** from [`ace-crush-lab`](https://github.com/leochan007/ace-crush-lab)
(zero algorithm changes), so upstream fixes flow in with a single `cp`.

```
┌──────────────────────────────────────────────────────────┐
│ Front-ends  (any of these, all pluggable)                │
│  • CLI        python -m backend.cli --video …            │  ← terminal UI
│  • Electron   npm run dev                                │  ← desktop UI (this repo)
│  • Browser    http://127.0.0.1:8321                      │  ← Phase C
│  • Mobile     same API + upload endpoint                 │  ← Phase C
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP REST + WebSocket  (127.0.0.1:8321)
┌────────────────────────▼─────────────────────────────────┐
│ Python service  (FastAPI + uvicorn)                      │
│  service/app.py      REST routes                          │
│  service/jobs.py     JobManager + WS broadcast           │
│  service/pipeline.py shared run-pipeline                 │
│  cli.py              CLI entry — same pipeline           │
└────────────────────────┬─────────────────────────────────┘
                         │  (no algorithm changes)
┌────────────────────────▼─────────────────────────────────┐
│ core/segment_swing.py                                    │
│  (vendored from ace-crush-lab/app/scripts/, byte-for-    │
│   byte — re-copy on upstream changes)                    │
└──────────────────────────────────────────────────────────┘
```

> **Design rule**: the algorithm library (`core/`) is the single source of
> truth. The transport layer (REST/WS) and the interaction layer (CLI/GUI/Web)
> are both decoupled from it. CLI *is* a UI; Electron *is* a UI; they drive
> the same pipeline.

## Highlights

- **🎾 Complete-cycle segmentation** — every detected swing includes ready → windup → contact → follow-through phases with explicit timecodes
- **🚀 On-the-fly emit** — segments appear in the UI as Pass 1 streams, not after the full video is done
- **🔌 Three pluggable UIs** — terminal, Electron desktop, future browser / mobile, all sharing one REST + WebSocket contract
- **🎛 Three pluggable models** — MediaPipe Pose for segmentation; RTMDet + RTMPose (or MediaPipe) for optional clip bbox + skeleton overlays
- **📦 Self-contained** — vendored algorithm + three committed models (≈160 MB) → clone-and-run, no PyPI dance for the model
- **🎬 Native video seek** — the GUI plays the *original* video via HTTP Range, sidesteps the cv2 `mp4v` codec that Chromium cannot decode
- **🧩 Pure modules, composed at the pipeline layer** — segmentation, detection, and pose are independent functions; you can run them together, or in any order, on the same clips

## Quick Start

```bash
# CLI — fastest smoke test, no service needed
python3 -m backend.cli segment --video /abs/path/to/video.mp4 --max-frames 1500

# CLI — full pipeline with clip bbox + skeleton overlays
python3 -m backend.cli segment --video /abs/match.mp4 --save-clips --clip-bbox --clip-skel

# CLI — post-hoc annotation of already-cut clips
python3 -m backend.cli annotate --clips-dir backend/data/jobs/<id>/clips --bbox --skel

# REST service — for Electron / browser / any client
python3 -m backend.service --port 8321
# stdout last line: SWING_SERVICE_URL=http://127.0.0.1:8321

# Electron GUI — full desktop app
npm install && npm run dev
```

## Documentation

The full bilingual documentation site is published at
**[leochan007.github.io/swing-analysis](https://leochan007.github.io/swing-analysis/)**
([中文](https://leochan007.github.io/swing-analysis/zh/)) — built with
mkdocs + mkdocs-material, auto-deployed to GitHub Pages on every push to `main`.

Markdown sources also live in this repo under [`docs/`](docs/) for offline
reading and editing:

| Chapter | Contents |
|---|---|
| [00 · Introduction](docs/guide/00-introduction.md) | What this project is, who it's for, design philosophy |
| [01 · Getting Started](docs/guide/01-getting-started.md) | Prerequisites, install, first run (CLI / REST / GUI) |
| [02 · Architecture](docs/guide/02-architecture.md) | Layered design, vendor strategy, decoupling story |
| [03 · CLI Usage](docs/guide/03-cli-usage.md) | `segment` / `annotate` sub-commands, all flags, output schema, exit codes |
| [04 · REST API](docs/guide/04-rest-api.md) | Endpoints, payloads, WebSocket event types (incl. clip.annotated), Range streaming |
| [05 · Electron GUI](docs/guide/05-electron-gui.md) | Sidecar lifecycle, dev workflow, UI layout |
| [06 · Algorithm](docs/guide/06-algorithm.md) | v2.1 two-pass cutting pipeline + which model plays which role |
| [07 · Troubleshooting](docs/guide/07-troubleshooting.md) | Common pitfalls and fixes (incl. onnxruntime, CoreML EP, RTMDet dynamic shapes) |

For Chinese readers: [docs/zh/](docs/zh/) — 简体中文镜像。

## Verification (fdl.mp4, first 800 frames)

```
[POST /api/jobs] → job_id 51b71ad9db8b
[GET  /api/jobs/51b71ad9db8b] → state=done, segments=3
[Range bytes=0-1023 /api/videos] → 206 + Content-Range: bytes 0-1023/25243119
[segments.json keys] → input / fps / total_frames / processed_frames /
                       duration_sec / wrist_detected_pct / params /
                       segments / segment_count
```

## License

See [LICENSE](LICENSE).