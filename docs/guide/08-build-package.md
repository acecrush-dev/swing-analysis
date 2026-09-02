---
title: Build & Package (Windows / macOS / Linux)
---

# Build & Package

AceCrush Swing-Analysis ships as a native desktop bundle on all three platforms. The Electron
renderer is `electron-vite`; the distribution tooling is `electron-builder`;
the Python backend is bundled via PyInstaller.

## TL;DR

```bash
npm install
npm run pack:mac        # macOS .dmg + .zip (current arch)
npm run pack:win        # Windows NSIS .exe (must run on Windows)
npm run pack:linux      # Linux AppImage + .deb (must run on Linux)
```

Outputs land in `release/` (`AceCrush Swing-Analysis-0.1.0-mac-arm64.dmg` etc).

## Cross-platform build matrix

PyInstaller bundles the **host's** Python interpreter, so each target needs a
build on that OS:

| Target binary        | Build host              | Output                                  |
|----------------------|-------------------------|-----------------------------------------|
| `swing-backend`      | macOS (x64 or arm64)    | `<dist>/swing-backend`                  |
| `swing-backend.exe`  | Windows (x64)           | `<dist>/swing-backend.exe`              |
| `swing-backend`      | Linux (x64)             | `<dist>/swing-backend`                  |

Cross-compiling is **not** supported. Use GitHub Actions matrix builds
(`macos-latest`, `windows-latest`, `ubuntu-latest`) to produce all three from
one workflow.

## What gets bundled

- `out/**` — Electron main / preload / renderer (electron-vite output)
- `backend/dist/swing-backend(.exe)` — PyInstaller one-file Python sidecar
- `backend/models/**` — MediaPipe / RTMDet / RTMPose ONNX weights (~162 MiB)
- `build/icon.{png,ico,icns}` — application icon

The bundled binary lives at `<resourcesPath>/backend/swing-backend(.exe)`
inside the packaged app; `process.resourcesPath/models/` points at the bundled
weights. The main process passes `--models-dir` and `--data-dir` explicitly so
the spawn survives both dev and packaged layouts.

## dev vs packaged sidecar launch

`src/main/index.ts` decides at runtime via `app.isPackaged`:

- **dev** → `python -m backend.service --port 0 --data-dir <X> --models-dir backend/models`
- **packaged** → `<resources>/backend/swing-backend(.exe) --port 0 --data-dir <userData>/backend-data --models-dir <resources>/models`

The data dir default also pivots:

- **dev** → `<repoRoot>/backend/data`
- **packaged** → `app.getPath('userData')/backend-data` (per-user; survives reinstalls)

User can override either via the Settings panel (`output_dir`); changes apply
on the next launch because the sidecar reads `--data-dir` once at spawn.

## CI workflow (sketch)

```yaml
# .github/workflows/release.yml
jobs:
  mac:
    runs-on: macos-latest
    steps: [checkout, lfs-pull, setup-node, setup-python, pip pyinstaller,
            npm ci, npm run pack:mac, upload-artifact]
  win:
    runs-on: windows-latest
    # ... npm run pack:win
  linux:
    runs-on: ubuntu-latest
    # ... npm run pack:linux
```

## Code signing / notarization (production)

- **Windows**: NSIS produces unsigned `.exe` by default. Users see SmartScreen.
  Fix by providing `win.certificateFile` + `CSC_KEY_PASSWORD` env vars.
- **macOS**: `hardenedRuntime: true` is on. For real distribution also set
  `mac.identity`, `CSC_LINK`, `CSC_KEY_PASSWORD`, and run
  `electron-builder notarize` (uses `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`).
  Without notarization Gatekeeper shows "unidentified developer" on first launch.
- **Linux**: AppImage / deb are unsigned by default. Users will need to
  `chmod +x` the AppImage on first download; `dpkg -i` works after trusting
  the apt source.

## Files added in this change

| Path                                             | Purpose                                |
|--------------------------------------------------|----------------------------------------|
| `build/icon.{png,ico,icns}`                      | Platform-specific app icons            |
| `build/entitlements.mac.plist`                   | macOS hardened-runtime exceptions      |
| `backend/launcher.py`                            | PyInstaller entry point                |
| `scripts/generate-icons.js`                      | Cross-platform icon regen              |
| `scripts/build-python-bundle.js`                 | PyInstaller one-file wrapper           |
| `src/main/index.ts` (edited)                     | dev vs packaged spawn + icon           |
| `src/main/panels.ts` (edited)                    | panel-window icon                      |
| `src/main/settings.ts` (edited)                  | packaged defaultDataDir                |
| `src/renderer/{index,clips,log}.html` (edited)  | favicon + Swing-Analysis titles        |
| `package.json` (edited)                          | electron-builder config + scripts      |
| `.gitignore` (edited)                            | track built icons but ignore artefacts |
