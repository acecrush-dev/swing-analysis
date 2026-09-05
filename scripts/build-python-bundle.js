#!/usr/bin/env node
// Wrap PyInstaller to produce a backend binary per host platform.
//
// Outputs:
//   macOS / Linux (--onefile):  backend/dist/swing-backend            (single ELF / Mach-O)
//   Windows      (--onedir):    backend/dist/swing-backend-win/        (directory tree; .exe inside)
//
// Consumed by: electron-builder `extraResources` (see package.json → build).
//
// Why a Node script (not a Bash / PowerShell pair): same code runs on
// macOS / Linux / Windows runners in CI without a per-OS rewrite, and
// `npm run bundle:py` makes the build invocation obvious in package.json.
//
// Why Windows uses --onedir (not --onefile):
//   --onefile extracts the full bundle to a temp dir on every launch and
//   triggers Defender scans of the extraction. Cold-start was 20–40s,
//   which exceeded the sidecar's 15s timeout and broke packaged startup.
//   --onedir runs the .exe in place: 3–5s startup, vastly lower AV false
//   positives. Cost: NSIS installer grows ~150MB (acceptable trade).
//
// Why --distpath / --workpath / --specpath are explicit:
//   PyInstaller's defaults leak `./dist/` and `<name>.spec` into the
//   repo root (CWD). Pinning all three to backend/{dist,build/} keeps
//   generated artefacts under the same tree the script already manages,
//   and the post-build existence checks below match the real on-disk
//   layout instead of guessing.
//
// Requirements:
//   - Python 3.10+ (matches backend/.venv — already 3.13 here)
//   - pip install pyinstaller in that venv (or system; not bundled
//     into requirements.txt to keep dev deps lean)
//   - backend/.venv/ for the runtime packages (mediapipe, onnxruntime,
//     opencv, fastapi, uvicorn, numpy, pydantic, imageio-ffmpeg)
//
// Cross-build matrix (CRITICAL — each target needs its own builder):
//   platform     runs on               produces
//   macOS x64    macOS runner          swing-backend           (Mach-O)
//   macOS arm64  macOS runner (M-series) swing-backend         (arm64)
//   Windows x64  Windows runner        swing-backend-win/      (onedir tree)
//   Linux x64    Linux runner          swing-backend           (ELF)
//
// You CANNOT cross-build these on a single host — PyInstaller bundles
// the local Python interpreter, which is a native binary. Use CI's
// matrix builds for the full set (see .github/workflows/release.yml).
//
// Run modes:
//   node scripts/build-python-bundle.js           # builds for the current host
//   node scripts/build-python-bundle.js --check   # verifies pyinstaller + python
//                                                  on PATH without writing

const { execFileSync, spawn } = require('node:child_process');
const { existsSync, mkdirSync, statSync, readdirSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');

const root = resolve(__dirname, '..');
const venv = resolve(root, 'backend/.venv');
const isWin = process.platform === 'win32';
const exeSuffix = isWin ? '.exe' : '';
const distDir = resolve(root, 'backend/dist');
const workDir = resolve(root, 'backend/build/pyinstaller/work');
const specDir = resolve(root, 'backend/build/pyinstaller');

// Windows produces an onedir tree: backend/dist/swing-backend-win/<files>.
// macOS / Linux produce a single-file binary: backend/dist/swing-backend.
const onedir = isWin;
const bundleName = onedir ? 'swing-backend-win' : `swing-backend${exeSuffix}`;
const bundleOut = join(distDir, bundleName);
const bundleExeInside = isWin ? join(bundleOut, 'swing-backend.exe') : bundleOut;

function venvPy() {
  if (isWin) return join(venv, 'Scripts', 'python.exe');
  return join(venv, 'bin', 'python3');
}

function resolvePy() {
  const v = venvPy();
  if (existsSync(v)) return v;
  // Fallback for CI systems without the checked-in venv: use system python3.
  return isWin ? 'python.exe' : 'python3';
}

function check() {
  console.log('[bundle:py] --check');
  const py = resolvePy();
  let ok = true;
  try {
    const out = execFileSync(py, ['-c', 'import sys; print(sys.version)'], { encoding: 'utf8' });
    console.log(`[bundle:py] python: ${out.trim()} @ ${py}`);
  } catch (e) {
    console.error(`[bundle:py] python not found at ${py}: ${e.message}`);
    ok = false;
  }
  try {
    execFileSync(py, ['-c', 'import PyInstaller; print(PyInstaller.__version__)'], { encoding: 'utf8' });
    console.log('[bundle:py] PyInstaller: ok');
  } catch {
    console.error('[bundle:py] PyInstaller missing; install with `pip install pyinstaller` in the venv.');
    ok = false;
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--check')) check();

const py = resolvePy();
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
if (!existsSync(specDir)) mkdirSync(specDir, { recursive: true });

// Args we hand to PyInstaller:
//   --distpath/--workpath/--specpath   pin output dirs (see header comment)
//   --onefile / --onedir               onefile for mac/linux, onedir for win
//   --name                            matches the per-platform bundle name
//   --paths                           include repo root so `import backend.*` works
//   --collect-submodules              pull every backend.{service,core}.* member
//   --collect-all                     pull dynamic plugins (.so/.dll) for
//                     libraries that load them at runtime:
//                       mediapipe       — native solutions
//                       onnxruntime     — provider DLLs / dylibs
//                       imageio_ffmpeg  — bundled static ffmpeg binary
//                         (without this, imageio.get_ffmpeg_exe() returns
//                          None inside the frozen env and H.264 transcoding
//                          silently falls back to the original mp4 in the
//                          GUI — see plan 002)
//   --hidden-import                   backstop for dynamic imports
//                     (uvicorn's loop/protocol modules load via importlib)
//   --noconfirm                       overwrite dist/ without prompting
//   --clean                           start fresh so stale artefacts don't leak
//   --log-level WARN                  keep build output short
const args = [
  '-m', 'PyInstaller',
  '--distpath', distDir,
  '--workpath', workDir,
  '--specpath', specDir,
  onedir ? '--onedir' : '--onefile',
  '--name', onedir ? 'swing-backend-win' : 'swing-backend',
  '--paths', root,
  '--collect-submodules', 'backend',
  '--collect-all', 'mediapipe',
  '--collect-all', 'onnxruntime',
  '--collect-all', 'imageio_ffmpeg',
  '--hidden-import', 'uvicorn',
  '--hidden-import', 'uvicorn.logging',
  '--hidden-import', 'uvicorn.loops',
  '--hidden-import', 'uvicorn.loops.auto',
  '--hidden-import', 'uvicorn.protocols',
  '--hidden-import', 'uvicorn.protocols.http',
  '--hidden-import', 'uvicorn.protocols.http.auto',
  '--hidden-import', 'uvicorn.protocols.websockets',
  '--hidden-import', 'uvicorn.protocols.websockets.auto',
  '--hidden-import', 'uvicorn.lifespan',
  '--hidden-import', 'uvicorn.lifespan.on',
  '--noconfirm',
  '--clean',
  '--log-level', 'WARN',
  resolve(root, 'backend/launcher.py'),
];

console.log(`[bundle:py] host=${process.platform} arch=${process.arch} mode=${onedir ? 'onedir' : 'onefile'}`);
console.log(`[bundle:py] running: ${py} ${args.join(' ')}`);
const start = Date.now();
const proc = spawn(py, args, { stdio: 'inherit' });

// Sum bytes recursively under a directory (used for onedir size reporting).
function dirSizeBytes(p) {
  let total = 0;
  for (const name of readdirSync(p)) {
    const fp = join(p, name);
    const st = statSync(fp);
    if (st.isDirectory()) total += dirSizeBytes(fp);
    else total += st.size;
  }
  return total;
}

proc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[bundle:py] PyInstaller exited ${code}`);
    process.exit(code ?? 1);
  }
  // Windows onedir → check the .exe inside the tree; mac/linux onefile → check the file.
  if (!existsSync(bundleExeInside)) {
    console.error(`[bundle:py] expected output missing: ${bundleExeInside}`);
    process.exit(2);
  }
  // PyInstaller 6.x just WARNS when a --collect-all target isn't installed
  // (silent fallback → no fail → ships a stripped bundle that crashes at
  // runtime with `ModuleNotFoundError: No module named 'uvicorn'`). The
  // sizes below are the smoking gun: a real bundle with mediapipe +
  // onnxruntime + imageio_ffmpeg is ~250–400 MiB on macOS arm64. Anything
  // under ~30 MiB means a heavy dep got skipped — refuse to declare OK.
  const sizeMiB = onedir
    ? dirSizeBytes(bundleOut) / 1024 / 1024
    : statSync(bundleExeInside).size / 1024 / 1024;
  if (sizeMiB < 30) {
    console.error(`[bundle:py] bundle is suspiciously small (${sizeMiB.toFixed(1)} MiB) — likely a missing --collect-all target.`);
    console.error(`[bundle:py] Run:  ${py} -m pip install -r backend/requirements.txt`);
    console.error(`[bundle:py] Then re-run this script.`);
    process.exit(4);
  }
  if (onedir) {
    console.log(`[bundle:py] ok — ${bundleOut}/ (${sizeMiB.toFixed(1)} MiB tree) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } else {
    console.log(`[bundle:py] ok — ${bundleExeInside} (${sizeMiB.toFixed(1)} MiB) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  }
  console.log('[bundle:py] Next: `npm run pack:<platform>` will pick this up via extraResources.');
});
