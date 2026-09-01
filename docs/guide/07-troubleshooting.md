# 07 · Troubleshooting

## Python: `pip install mediapipe` fails

The official wheels historically capped at Python 3.12. If you're on 3.13 or
newer, `pip` will try to download a `sdist` and build locally — which often
fails because of TFLite's bazel-based build chain.

**Options**:

1. Verify your Python: `python3 --version`
2. If you're on ≥ 3.13, create a dedicated 3.12 venv:
   ```bash
   python3.12 -m venv backend/.venv
   backend/.venv/bin/pip install -r backend/requirements.txt
   ```
3. On Apple Silicon, make sure `grpcio` and `numpy` are installed *before*
   `mediapipe` (precompiled wheel constraints).

## `model_ready: false` even though the file exists

The service looks for these filenames in `backend/models/`:

- `pose_landmarker_lite.task` (preferred)
- `pose_landmarker.task` (fallback)

A 0-byte file or a file with a typo'd name will silently fail health check.
Verify:

```bash
ls -lh backend/models/
# expected: -rw-r--r--  5.5M  pose_landmarker_lite.task
```

## `/api/videos` returns 500 / blank

Two known issues, both already fixed in this repo:

| Symptom | Cause | Fix |
| --- | --- | --- |
| 500 with `'function' object has no attribute 'matches'` | Dynamic route replacement in `app.py` appended raw functions instead of APIRoute objects | The current code defines the route once with a `Request` argument; no patching |
| `<video>` shows "no video with supported format" | Chromium can't decode cv2 `mp4v` codec | The GUI plays `/api/videos` (original file) instead of the `clips/` directory — it should never reach here |

## WS receives no events

The WebSocket flow has two failure modes:

1. **Service not running on the expected port.** Verify
   `cat backend/data/service.json` — its `port` field is the truth.
2. **Wrong URL.** Browser / Electron must use `ws://`, not `http://`.
   `SwingClient.openEvents` does the substitution automatically.

If you still get nothing:

```bash
# raw WS test from Python (no framework)
python3 -c "
import asyncio, websockets, json
async def t():
    async with websockets.connect('ws://127.0.0.1:8321/api/jobs/<ID>/events') as ws:
        for _ in range(5):
            print(await ws.recv())
asyncio.run(t())
"
```

## Port already in use

```bash
# who's holding it?
lsof -nP -iTCP:8321 -sTCP:LISTEN

# tell the service to pick a free port
python3 -m backend.service --port 0
# last stdout line reveals the real port
```

If Electron is the client, it parses that stdout line automatically — you
don't need to hard-code 8321 anywhere.

## `IndexError` / `KeyError` deep inside MediaPipe

Usually means the `.task` file is corrupt or wrong version. Re-fetch:

```bash
rm backend/models/pose_landmarker_lite.task
bash scripts/fetch-model.sh
```

If the script fails to download (offline machine), copy from another
machine that has it, or extract it from a fresh `pip install mediapipe`:
it's bundled at `<venv>/lib/python3.X/site-packages/mediapipe/modules/pose_landmarker/pose_landmarker_lite.task`.

## Apple Silicon Metal delegate regression (mediapipe 1.0)

If you see an abort like this on an M-series Mac, **don't debug your
video — it's not your fault**:

```
INFO: Created TensorFlow Lite XNNPACK delegate for CPU.
W  Feedback manager requires a model with a single signature inference.
   Disabling support for feedback tensors.
F  Check failed: service_ Service is unavailable.
*** Check failure stack trace: ***
    @  ... -[DrishtiMetalHelper initWithCalculatorContext:]
    @  ... mediapipe::api2::TensorsToDetectionsCalculator::Open()
    @  ... mediapipe::CalculatorNode::OpenNode()
```

Root cause: the **mediapipe 1.0** wheel has a regression where the
`TensorsToDetectionsCalculator` graph unconditionally initialises the
Metal delegate helper during `Open()`. Apple's `DrishtiMetalHelper` then
fails an internal sanity check (`service_ Service is unavailable.`) and
aborts the process. Verified broken on Python 3.12.12 *and* 3.13.11 —
Python version is **not** the variable. Re-downloading the model (lite
or heavy) from Google's CDN does not help — the bug is in the wheel.

**Fix** (already baked into `requirements.txt`): pin `mediapipe==0.10.35`.
This is the last 0.10.x release; it does not contain the Metal-init path
and runs cleanly on M-series Mac (~125 fps on fdl.mp4, 60-frame smoke
test).

```bash
# If you accidentally upgraded past 0.10.x:
backend/.venv/bin/pip install --upgrade --force-reinstall 'mediapipe==0.10.35'

# Verify before re-running the smoke test:
backend/.venv/bin/python -c "import mediapipe; print(mediapipe.__version__)"
# expect: 0.10.35
```

**When can you un-pin?** Once MediaPipe 1.0.x fixes the
`TensorsToDetectionsCalculator::Open()` Metal-init sanity check. Track
the upstream issue and re-test with `mediapipe>=1.0`; if a 1.x release
passes the same 60-frame demo.mp4 smoke test without aborting, edit
`backend/requirements.txt` to drop the `==0.10.35` pin. Until then,
**don't `pip install --upgrade mediapipe`** without checking this
section.

## No segments detected on a clearly-action-filled video

Work the algorithm knobs in this order:

1. Lower `--min-peak` to 0.15 or 0.10 — many "missing" segments are
   actually being filtered by the peak threshold.
2. Check `--v-swing` — too high and the active interval never starts.
3. Look at `wrist_detected_pct` in the segments.json — if it's under
   30%, your footage's pose is hard for MediaPipe. Consider lighting /
   angle adjustments before tuning the algorithm.
4. As a last resort, set `--smooth-alpha 0.4` — heavy smoothing to absorb
   single-frame jitter.

See [06 · Algorithm](06-algorithm.md) for the full tuning guide.

## Segmentation explodes — one giant 30-second segment

Lower `--gap-merge` and `--max-bridge` to ~0.8 — you're chaining multiple
swings through one of the gap windows.

## Electron window is blank after `npm run dev`

1. Open DevTools (View → Toggle Developer Tools) — check the Console for
   errors.
2. Most common: the sidecar failed to spawn. Check
   `backend/data/service.json` exists and has a port.
3. If port 8321 is held by an old `python -m backend.service`, kill it:
   `pkill -f backend.service`.

## GUI can pick a video but can't start the job

`/api/jobs` returned an error. Most often it's `404 视频不存在` — Electron
sends the path returned by the OS dialog, which uses whatever separator
your OS uses. The service checks `Path.is_absolute()` — on Windows make
sure you're passing `"C:\\..."` not `"C:/..."`. (Python's `Path` is fine
with either, but the user might be typing it manually for testing.)

## How do I clean up disk usage?

```bash
# remove old job artifacts (safe — they're regeneratable)
rm -rf backend/data/jobs/

# nuke the Electron build cache
rm -rf node_modules/ out/ dist/ .electron-vite/

# nuke Python venv (rebuild in 60s)
rm -rf backend/.venv/
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
```

The MediaPipe model is committed (5.5 MB) — deleting `backend/models/`
forces `scripts/fetch-model.sh` to redownload it.