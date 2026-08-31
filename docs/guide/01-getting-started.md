# 01 · Getting Started

Five minutes from `git clone` to first result.

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Python | ≥ 3.10 | MediaPipe's prebuilt wheels cap out at 3.12; this machine's 3.13 works fine |
| Node.js | ≥ 18 | Electron 31 + electron-vite |
| Git | any | clone the repo |
| ffmpeg | not needed | OpenCV bundles its own codec stack |

## 1. Clone

```bash
git clone https://github.com/leochan007/swing-analysis.git
cd swing-analysis
```

## 2. Python deps

You can either use a venv or install into your system Python — the scripts
default to `python3`.

```bash
# Option A — virtualenv (recommended)
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# Option B — system-wide
pip3 install -r backend/requirements.txt
```

## 3. MediaPipe model

The model is **already in the repo** at `backend/models/pose_landmarker_lite.task`
(5.5 MB). The `scripts/fetch-model.sh` script is a fallback for the rare case
you lose it — it will copy from `ace-crush-lab` if you have it locally, or
download from MediaPipe's CDN.

```bash
bash scripts/fetch-model.sh    # should print "已就位 …"
```

## 4. Smoke test (no service)

```bash
# Use any short video you have; fdl.mp4 from ace-crush-lab is the canonical test
python3 -m backend.cli \
    --video /abs/path/to/your/video.mp4 \
    --max-frames 1500 \
    --out-dir /tmp/swing_out

# expect: ✓ 完成: 检测到 N 个完整挥拍周期 + JSON: /tmp/swing_out/segments.json
```

## 5. Run as a service

```bash
python3 -m backend.service --port 8321
# last stdout line: SWING_SERVICE_URL=http://127.0.0.1:8321
```

From another terminal:

```bash
curl http://127.0.0.1:8321/api/health
# {"status":"ok","version":"0.1.0","model_ready":true,...}
```

## 6. (Optional) Run the Electron GUI

```bash
npm install        # 200-400 MB, takes 1-3 min
npm run dev        # compiles main + preload + renderer, opens window
```

The Electron app auto-spawns the Python sidecar (it expects `python3` on
PATH or `backend/.venv/bin/python3`). If you used a venv with a different
name, edit `src/main/index.ts`'s `candidates` array.

## Where do things end up?

| Path | What's in it |
| --- | --- |
| `backend/data/service.json` | Service bind info (host/port) |
| `backend/data/jobs/<id>/segments.json` | Final result + full parameter echo |
| `backend/data/jobs/<id>/clips/clip_NNN.mp4` | Per-cycle clips (only if `save_clips=true`) |
| `backend/data/jobs/<id>/viz.mp4` | Color-coded phase video (only if `viz_video=true`) |
| `/tmp/swing_out/` | CLI `--out-dir` (whatever you set) |

All of these are gitignored. They are runtime cache; rerun rebuilds.

## Next steps

- [03 · CLI Usage](03-cli-usage.md) for every tuning parameter and what it does
- [04 · REST API](04-rest-api.md) for the wire contract
- [06 · Algorithm](06-algorithm.md) if you want to understand *why* the parameters exist