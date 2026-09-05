---
title: Build & Package (Windows / macOS / Linux)
---

# Build & Package

AceCrush Swing-Analysis ships as a native desktop bundle on all three platforms. The Electron
renderer is `electron-vite`; the distribution tooling is `electron-builder`;
the Python backend is bundled via PyInstaller.

## TL;DR

```bash
pnpm install
pnpm pack:mac        # macOS .dmg + .zip (current arch)
pnpm pack:win        # Windows NSIS .exe (must run on Windows)
pnpm pack:linux      # Linux AppImage + .deb (must run on Linux)
```

Outputs land in `release/` (`AceCrush Swing-Analysis-0.1.0-mac-arm64.dmg` etc).

## Cross-platform build matrix

PyInstaller bundles the **host's** Python interpreter, so each target needs a
build on that OS — cross-compiling is **not** supported. The build mode also
differs by host:

| Target binary                  | Build host              | PyInstaller mode | Output                                              |
|--------------------------------|-------------------------|------------------|-----------------------------------------------------|
| `swing-backend` (Mach-O)       | macOS x64 or arm64      | `--onefile`      | `backend/dist/swing-backend`                        |
| `swing-backend-win/` (tree)    | Windows x64             | `--onedir`       | `backend/dist/swing-backend-win/swing-backend.exe`  |
| `swing-backend` (ELF)          | Linux x64               | `--onefile`      | `backend/dist/swing-backend`                        |

**Why Windows uses `--onedir` (not `--onefile`):** `--onefile` extracts the
full bundle (~300 MiB) to a temp dir on every launch and triggers Defender
scans of the extraction. Cold-start was 20–40s — which exceeded the sidecar's
15s timeout and broke packaged startup. `--onedir` runs the `.exe` in place
(3–5s startup, far fewer AV false positives). The NSIS installer grows by
~150 MiB; we accept that trade for "download → install → double-click → it
works."

## What gets bundled

- `out/**` — Electron main / preload / renderer (electron-vite output)
- `backend/dist/swing-backend` — macOS / Linux PyInstaller one-file sidecar
- `backend/dist/swing-backend-win/swing-backend.exe` — Windows onedir sidecar
  (a directory tree: `.exe` + `_internal/` with `python*.dll`, `numpy`,
  `mediapipe` solutions, `imageio_ffmpeg`'s bundled `ffmpeg`, …)
- `backend/models/**` — MediaPipe / RTMDet / RTMPose ONNX weights (~162 MiB,
  pulled via Git LFS — see "LFS" below)
- `build/icon.{png,ico,icns}` — application icon

The packaged sidecar lives at:

- **macOS / Linux**: `<resourcesPath>/backend/swing-backend`
- **Windows**:     `<resourcesPath>/backend/swing-backend-win/swing-backend.exe`

Models land at `<resourcesPath>/models/` on every platform. The main process
passes `--models-dir` and `--data-dir` explicitly so the spawn survives both
dev and packaged layouts (and PyInstaller's frozen `__file__` pointing into
the temp extraction doesn't matter).

### LFS

`backend/models/*.onnx` is tracked by Git LFS. Without `lfs: true` on the CI
checkout, the on-disk files are 134-byte pointer text — and the packaged
build silently ships an empty models dir. Every job in `release.yml`
explicitly sets `with.lfs: true`; if you fork or copy the workflow, keep
that line.

## dev vs packaged sidecar launch

`src/main/index.ts` decides at runtime via `app.isPackaged`:

- **dev** → `python -m backend.service --port 0 --data-dir <X> --models-dir backend/models`
- **packaged macOS / Linux** → `<resources>/backend/swing-backend --port 0 --data-dir <userData>/backend-data --models-dir <resources>/models`
- **packaged Windows**     → `<resources>/backend/swing-backend-win/swing-backend.exe --port 0 --data-dir <userData>/backend-data --models-dir <resources>/models`

The packaged startup timeout is **60 seconds** (vs 15s in dev) so the macOS
onefile bundle has room to decompress on first launch. If sidecar startup
fails, the main process shows an error dialog and exits — check
`[sidecar] spawning:` in stderr/log for the exact command path it tried.

The data dir default also pivots:

- **dev** → `<repoRoot>/backend/data`
- **packaged** → `app.getPath('userData')/backend-data` (per-user; survives reinstalls)

User can override either via the Settings panel (`output_dir`); changes apply
on the next launch because the sidecar reads `--data-dir` once at spawn.

## CI workflow

`release.yml` runs **four native-OS jobs** in parallel after `resolve-tag`:

| Job              | Runner             | Steps (high-level)                                                                            |
|------------------|--------------------|-----------------------------------------------------------------------------------------------|
| `build-linux`    | `ubuntu-22.04`     | checkout(lfs) → setup-python 3.13 → setup-node → `npm ci` → `bundle:py` → `electron-builder --linux --x64` |
| `build-windows`  | `windows-latest`   | checkout(lfs) → setup-python 3.13 → setup-node → `npm ci` → `bundle:py` → `electron-builder --win --x64`   |
| `build-mac`      | `macos-latest`     | checkout(lfs) → setup-node → **pass1 (arm64)**: setup-python + bundle:py + `file backend/dist/swing-backend` evidence + `electron-builder --mac --arm64` → **pass2 (x64)**: setup-python `architecture: x64` + re-pip + re-`bundle:py` + `file ... | grep x86_64` evidence + `electron-builder --mac --x64` |

`publish-release` downloads the three `installers-*` artifacts and
`gh release create`s them on the public mirror repo. `shopt -s globstar` +
`dist/installers-*/**/*` expands every file regardless of which job produced
it.

Why each platform gets its own native runner:

- PyInstaller **cannot** cross-compile (it bundles the local Python
  interpreter, which is a native binary). Running `electron-builder --win`
  on a Linux runner used to ship a Linux ELF masquerading as a Windows
  sidecar — visible to no test, fatal at the user's first launch.
- macOS dual-arch: a single `bundle:py` pass produces *one* arch's Mach-O.
  Building `--arm64` and `--x64` from the same sidecar binary put arm64
  bytes inside the Intel `.dmg`. We now run `setup-python@v5` twice with
  different `architecture:` values and re-`pip install` + re-`bundle:py`
  between passes; the `file backend/dist/swing-backend` step proves the
  Mach-O arch in the CI log before `electron-builder` consumes it.

## First launch & unsigned artifacts

Without code-signing certificates (the default for open-source projects
without a paid Apple Developer account or Windows EV cert), users hit OS
security prompts on first launch. These are **expected**, not bugs:

- **macOS Gatekeeper** — "AceCrush Swing-Analysis.app cannot be opened because
  the developer cannot be verified." Two workarounds:
  1. Right-click (or Control-click) the app → **Open** → confirm in the
     dialog. macOS remembers the choice per app per machine.
  2. From Terminal: `xattr -cr "/Applications/AceCrush Swing-Analysis.app"`
     — strips the `com.apple.quarantine` xattr so launch behaves as if the
     app came from the App Store. Use this for CI smoke tests and bulk
     deployments where right-click is impractical.
- **macOS onefile first launch** — the sidecar binary extracts to
  `~/Library/.../T/*/swing-backend` on first run; this takes 3–8s on SSD
  and longer on spinning disk. The main process gives the sidecar a 60s
  startup window for exactly this. Subsequent launches are instant.
- **Windows SmartScreen** — "Windows protected your PC" / "Unknown publisher".
  Click **More info** → **Run anyway**. The choice is sticky per file per
  machine. SmartScreen reputation builds with download volume, so freshly
  released versions may warn more aggressively than mature ones.

If the sidecar fails to start at all (no prompt, error dialog "sidecar 启动失败"),
the issue is almost always one of:

- The LFS models are missing on disk (re-run `git lfs pull`).
- The macOS quarantine xattr is still set (use workaround above).
- Windows Defender removed/quarantined `swing-backend.exe` (check
  `Windows Security → Virus & threat protection → Protection history`).

For deeper diagnosis, run the sidecar binary directly in a terminal — it
prints its `SWING_SERVICE_URL=http://127.0.0.1:<port>` line and then serves
the API.

## Code signing

`electron-builder` picks up signing/notarization credentials from environment
variables. **Setting any subset of these is automatic — empty values silently
disable that step without breaking the build.** Configure the ones you have
in the repo's GitHub Actions secrets; the workflow already injects them into
both `build-windows` and `build-mac`:

| Secret                            | Purpose                                                                  |
|-----------------------------------|--------------------------------------------------------------------------|
| `CSC_LINK`                        | Base64 of the `.pfx` (Windows) / `.p12` (macOS) signing certificate     |
| `CSC_KEY_PASSWORD`                | Password for that certificate                                            |
| `APPLE_ID`                        | Apple ID for `xcrun notarytool`                                          |
| `APPLE_APP_SPECIFIC_PASSWORD`     | App-specific password (NOT the Apple ID password)                        |
| `APPLE_TEAM_ID`                   | 10-char Team ID from developer.apple.com                                  |

Recommended rollout order:

1. Ship unsigned artefacts first; verify the CI matrix produces three
   working installers on three runners.
2. Add `CSC_LINK` + `CSC_KEY_PASSWORD` for Windows — eliminates
   SmartScreen for repeat downloaders.
3. Add all five Apple secrets for macOS notarization — eliminates Gatekeeper.

There is no workflow change required to upgrade or downgrade signing; the
same `release.yml` works in all three states.

## Files added in this change

| Path                                             | Purpose                                |
|--------------------------------------------------|----------------------------------------|
| `build/icon.{png,ico,icns}`                      | Platform-specific app icons            |
| `build/entitlements.mac.plist`                   | macOS hardened-runtime exceptions      |
| `backend/launcher.py`                            | PyInstaller entry point                |
| `scripts/generate-icons.js`                      | Cross-platform icon regen              |
| `scripts/build-python-bundle.js`                 | PyInstaller wrapper (onefile/onedir)   |
| `src/main/index.ts` (edited)                     | dev vs packaged spawn + 60s timeout    |
| `src/main/panels.ts` (edited)                    | panel-window icon                      |
| `src/main/settings.ts` (edited)                  | packaged defaultDataDir                |
| `src/renderer/{index,clips,log}.html` (edited)  | favicon + Swing-Analysis titles        |
| `package.json` (edited)                          | electron-builder config + scripts      |
| `.github/workflows/release.yml` (edited)        | 4-job native matrix + LFS              |
| `.gitignore` (edited)                            | track built icons but ignore artefacts |
