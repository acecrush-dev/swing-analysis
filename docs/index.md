# 📚 swing-analysis Documentation

**English** | [简体中文](zh/index.md)

## What is this?

`swing-analysis` wraps a battle-tested tennis-swing auto-segmentation pipeline
(originally developed in [`ace-crush-lab`](https://github.com/leochan007/ace-crush-lab))
into a serviceable Python backend with a pluggable UI layer. The algorithm is
**vendored byte-for-byte** into `backend/core/segment_swing.py` — no
modifications, no surprises. When upstream improves the algorithm, you
literally `cp` the new file in.

The repository ships three deliverables:

1. **A self-contained CLI** (`python -m backend.cli`) — fastest way to verify the
   pipeline produces what you expect, no service required.
2. **A FastAPI service** (`python -m backend.service`) — REST + WebSocket over
   `127.0.0.1:8321`. Used by the Electron GUI; tomorrow, by a browser or
   mobile client.
3. **An Electron + React desktop GUI** (`npm run dev`) — the first front-end
   consumer. Owns the sidecar lifecycle, drives the user through
   *pick video → tune → watch progress → review segments → seek & download*.

## 📑 Documentation Index

| Chapter | Contents | For whom |
| --- | --- | --- |
| [00 · Introduction](guide/00-introduction.md) | Project positioning, the vendor-first decoupling story, when to use this | Everyone — start here |
| [01 · Getting Started](guide/01-getting-started.md) | Prerequisites, install, first run (CLI / REST / GUI) in under 10 minutes | New users |
| [02 · Architecture](guide/02-architecture.md) | Layered design (core / service / cli / electron), vendor strategy, lock discipline | Curious / contributors |
| [03 · CLI Usage](guide/03-cli-usage.md) | All flags, output schema, exit codes, sample invocation | Users running batch jobs |
| [04 · REST API](guide/04-rest-api.md) | Every endpoint, payload schemas, WebSocket event types, Range streaming, curl recipes | API integrators |
| [05 · Electron GUI](guide/05-electron-gui.md) | Sidecar lifecycle, dev workflow, UI layout, debugging | GUI users / contributors |
| [06 · Algorithm](guide/06-algorithm.md) | How the v2.1 two-pass cutting pipeline works under the hood (online + offline) | Algorithm tuners |
| [07 · Troubleshooting](guide/07-troubleshooting.md) | Common pitfalls and fixes | Stuck users |

## Core Idea

```
                       algorithm (truth)
                            │
                ┌───────────┴───────────┐
                │                       │
         run_pipeline()           run_pipeline()
                │                       │
        ┌───────▼───────┐       ┌───────▼───────┐
        │  CLI  entry   │       │ REST/WS entry │
        │  backend.cli  │       │ service.app   │
        └───────┬───────┘       └───────┬───────┘
                │                       │
        terminal UI              Electron / browser /
                                 mobile / curl
```

- **Vendor first.** Algorithm library is copied verbatim from upstream; no
  edits inside the vendored copy. Drift between this repo and upstream is
  resolved by `cp`, not by hand-merging.
- **Pipeline as the seam.** `run_pipeline()` is the only function that touches
  the algorithm. It takes callbacks (`progress_cb`, `on_segment`,
  `should_cancel`) instead of writing to a terminal. The HTTP service and the
  CLI both call it.
- **Plug any UI.** Want a Jupyter widget? A Streamlit page? An iOS app? They
  all speak REST + WebSocket and download artifacts from
  `/api/artifacts/<id>/...`. The algorithm doesn't know or care.

## Why "two UIs over one pipeline"?

A CLI is a UI. An HTTP service is a UI. An Electron app is a UI. They differ
in transport and rendering, but not in *what they ask the algorithm to do*.
Decoupling at this seam gives you:

- **Test the algorithm without UI noise.** Run the CLI on a fixture video and
  eyeball `segments.json`. No browser, no DevTools, no flaky WS.
- **Test the UI without re-implementing the algorithm.** The GUI is a thin
  shell: pick a video, fill a form, show progress, list segments. No
  MediaPipe or OpenCV anywhere on the renderer side.
- **Replace either side freely.** Tomorrow the CLI becomes a notebook widget;
  the Electron app becomes a Streamlit page. The algorithm stays put.

## Project layout

```
backend/
  core/segment_swing.py    ← vendored, do NOT edit
  service/
    pipeline.py            ← run_pipeline(): the seam
    jobs.py                ← JobManager + WS broadcast
    app.py                 ← FastAPI routes
    __main__.py            ← uvicorn entry
    schemas.py             ← pydantic wire types
  cli.py                   ← CLI entry (same pipeline)
  models/pose_landmarker_lite.task    ← committed, 5.5 MB
src/
  main/index.ts            ← PythonSidecar lifecycle
  preload/index.ts         ← contextBridge
  renderer/                ← React UI
scripts/fetch-model.sh     ← fallback downloader
docs/                      ← you are here
```

## Verification recipe

```bash
# 1. health
curl http://127.0.0.1:8321/api/health
# {"status":"ok","version":"0.1.0","model_ready":true,...}

# 2. submit
curl -X POST http://127.0.0.1:8321/api/jobs \
     -H 'Content-Type: application/json' \
     -d '{"video_path":"/abs/fdl.mp4","params":{"max_frames":1500}}'
# {"job_id":"51b71ad9db8b"}

# 3. poll
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b | jq '.state, (.segments|length)'
# "done"
# 3

# 4. video Range
curl -H 'Range: bytes=0-1023' \
     'http://127.0.0.1:8321/api/videos?path=/abs/fdl.mp4' -o /dev/null -D -
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/25243119

# 5. download artifacts
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/segments.json -o seg.json
```

## License

See [LICENSE](../LICENSE).