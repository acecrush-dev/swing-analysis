# Model assets for the renderer (TS backend mode)

This directory holds the ONNX / MediaPipe `.task` files that the renderer
loads directly via `onnxruntime-web` + `@mediapipe/tasks-vision` when
`SWING_BACKEND=ts`.

**The symlinks in this directory are dev-only and NOT committed to git**
(they carry absolute `/Users/...` targets, which materialize as dangling
links on any other machine and kill `vite build` — its public-dir copy
`statSync`s every entry). They exist only on machines that created them.

To get them back after a fresh clone (or before a **ts-mode** build):

    pnpm models:link          # = node scripts/build.mjs link-models

which recreates the links (falling back to real copies on filesystems
without symlink support). Prerequisite: the LFS binaries must exist in
`backend/models/` first — `git lfs pull` or `bash scripts/fetch-model.sh`.
Python-mode needs none of this: those models ship via the `backend/models`
extraResources instead, so `pnpm dev` in python mode works on a bare clone.

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

If a fresh clone has no LFS binaries yet, run `bash scripts/fetch-model.sh`
(or `git lfs pull`) first, then recreate the links as described above.
