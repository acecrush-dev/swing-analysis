# 01 · Getting Started

Five minutes from `git clone` to first result.

## Prerequisites

| Tool | Version | Why |
| --- | --- | --- |
| Python | ≥ 3.10 | MediaPipe's prebuilt wheels cap out at 3.12; 3.13 works fine |
| Node.js | ≥ 18 | Electron 31 + electron-vite |
| Git | any | clone the repo |
| **git-lfs** | **required** | `backend/models/{rtmdet,rtmpose}-m-*.onnx` (104 MB + 52 MB) are Git LFS-tracked. A plain `git clone` gives you 134-byte pointer text files, not the real binaries — the ONNX loaders will fail. Either install `git-lfs` and run `git lfs pull`, or use `scripts/fetch-model.sh` (handles both MediaPipe + LFS for you). |
| ffmpeg | optional (auto-bundled) | Needed only for clip in-GUI playback. The `imageio-ffmpeg` pip wheel ships a static ffmpeg binary — no system install required. Without ffmpeg, the Electron GUI falls back to "seek the original video to the segment start_timecode" for unplayable clips; clips remain downloadable. See [04 · REST API](04-rest-api.md#clip-playback). |
| **mediapipe** | **== 0.10.35** (pinned in `backend/requirements.txt`) | MediaPipe **1.0** wheel has a regression on Apple Silicon that aborts in `TensorsToDetectionsCalculator::Open()`. See [07 · Troubleshooting](07-troubleshooting.md#apple-silicon-metal-delegate-regression). Don't `pip install --upgrade mediapipe` without re-reading that section. |

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

## 3. Models

Three model files live under `backend/models/`, **all three are Git LFS-tracked**:

| File | Size | Source | After `git clone` you have |
| --- | --- | --- | --- |
| `pose_landmarker_lite.task` | 5.5 MB | Git LFS | 132-byte pointer text |
| `rtmdet-m-487628.onnx` | 104 MB | Git LFS | 134-byte pointer text |
| `rtmpose-m-27c0e6.onnx` | 52 MB | Git LFS | 133-byte pointer text |

`scripts/fetch-model.sh` is the all-in-one — it (a) re-downloads the MediaPipe
lite from its CDN if the real binary is missing AND LFS can't be reached,
(b) detects LFS pointer files (~130 bytes, start with
`version https://git-lfs.github.com/spec/v1`) and runs `git lfs pull` to
materialise them:

```bash
bash scripts/fetch-model.sh
# 期望输出:
#   [fetch-model] MediaPipe lite 已就位 ... (5.5M)
#   [fetch-model] 模型状态:
#     ✓ pose_landmarker_lite.task   (5.5M)
#     ✓ rtmdet-m-487628.onnx        (112M)
#     ✓ rtmpose-m-27c0e6.onnx       ( 52M)
```

If you'd rather do it manually:

```bash
brew install git-lfs        # macOS — or apt-get install git-lfs on Linux
git lfs install
git lfs pull                # materialises the *.onnx files in backend/models/
```

Symptom of a missing LFS pull: the script prints `模型文件不存在:
backend/models/rtmdet-m-487628.onnx` — but `ls -la` shows the file IS there
at 134 bytes. That's the LFS pointer text. Re-run `bash scripts/fetch-model.sh`.

## 4. Smoke test (no service)

```bash
# Use any short video you have
python3 -m backend.cli segment \
    --video /abs/path/to/your/video.mp4 \
    --max-frames 1500 \
    --out-dir /tmp/swing_out

# expect: ✓ 完成: 检测到 N 个完整挥拍周期 + JSON: /tmp/swing_out/segments.json
```

## 4b. Run a single vendored algorithm directly

The three scripts under `backend/core/` are independently runnable — no
service, no pipeline shell, no Electron. Useful when you want one stage
without the full orchestration:

```bash
# MediaPipe 33-point once → segments + skel clips + full-video viz
backend/.venv/bin/python3 backend/core/analyze_swing.py \
    --file ../../demo.mp4 \
    --save-clips --skel-clips --viz-full

# RTMDet bbox + RTMPose 13-point skeleton, four-quadrant compositor
backend/.venv/bin/python3 backend/core/gen_skeleton_anim.py \
    --file ../../demo.mp4 \
    --det-model ../models/rtmdet-m-487628.onnx \
    --pose-model ../models/rtmpose-m-27c0e6.onnx

# Just the wrist-signal cut pipeline (same as `backend.cli segment`)
backend/.venv/bin/python3 backend/core/segment_swing.py --file ../../demo.mp4 --max-frames 1500
```

See [02 · Architecture](02-architecture.md#l1--algorithm-backendcore) for what
each script is responsible for.

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