# Model assets for the renderer (TS backend mode)

This directory holds the ONNX / MediaPipe `.task` files that the renderer
loads directly via `onnxruntime-web` + `@mediapipe/tasks-vision` when
`SWING_BACKEND=ts`.

**The files in this directory are symlinks** pointing at
`backend/models/` so we don't duplicate 168 MB of weights in two places.
The symlinks resolve at runtime (Vite serves them straight through to
`/assets/models/...`), so any update in `backend/models/` is immediately
visible without re-running a script.

## Why symlinks, not copies

- **Space** — three files, ~168 MB total. Two copies would push the
  electron-builder output (which already includes both `out/renderer/`
  AND `Contents/Resources/backend/`) past 250 MB. Symlinks cost nothing.
- **Source of truth** — `backend/models/` is the LFS-tracked, Git-versioned
  copy. Anyone who runs `git lfs pull` gets the real binaries in both
  places automatically; we never need to keep the two in sync manually.

## Files expected

| Filename                    | Format    | Loader                                       |
| --------------------------- | --------- | -------------------------------------------- |
| `rtmdet-m-487628.onnx`      | ONNX      | `onnxruntime-web` → `InferenceSession`      |
| `rtmpose-m-27c0e6.onnx`     | ONNX      | `onnxruntime-web` → `InferenceSession`      |
| `pose_landmarker_lite.task` | MediaPipe | `@mediapipe/tasks-vision` → `PoseLandmarker` |

The symlinks above should already point at `backend/models/`. If a
fresh clone has dangling symlinks (LFS not pulled yet), run
`bash scripts/fetch-model.sh` (or `git lfs pull`) to materialise the
real binaries — the symlinks will resolve correctly from there.
