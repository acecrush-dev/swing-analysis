# swing-analysis

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
- **📦 Self-contained** — vendored algorithm + committed MediaPipe model (5.5 MB) → clone-and-run, no PyPI dance for the model
- **🎬 Native video seek** — the GUI plays the *original* video via HTTP Range, sidesteps the cv2 `mp4v` codec that Chromium cannot decode

## Quick Start

```bash
# CLI — fastest smoke test, no service needed
python3 -m backend.cli --video /abs/path/to/video.mp4 --max-frames 1500

# REST service — for Electron / browser / any client
python3 -m backend.service --port 8321
# stdout last line: SWING_SERVICE_URL=http://127.0.0.1:8321

# Electron GUI — full desktop app
npm install && npm run dev
```

## Documentation

| Chapter | Contents |
|---|---|
| [00 · Introduction](docs/guide/00-introduction.md) | What this project is, who it's for, design philosophy |
| [01 · Getting Started](docs/guide/01-getting-started.md) | Prerequisites, install, first run (CLI / REST / GUI) |
| [02 · Architecture](docs/guide/02-architecture.md) | Layered design, vendor strategy, decoupling story |
| [03 · CLI Usage](docs/guide/03-cli-usage.md) | All flags, output schema, exit codes |
| [04 · REST API](docs/guide/04-rest-api.md) | Endpoints, payloads, WebSocket event types, Range streaming |
| [05 · Electron GUI](docs/guide/05-electron-gui.md) | Sidecar lifecycle, dev workflow, UI layout |
| [06 · Algorithm](docs/guide/06-algorithm.md) | How the v2.1 cutting pipeline works under the hood |
| [07 · Troubleshooting](docs/guide/07-troubleshooting.md) | Common pitfalls and fixes |

For Chinese readers: [docs/zh/](docs/zh/index.md) — 简体中文文档镜像。

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