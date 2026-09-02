#!/usr/bin/env node
// Wrap PyInstaller to produce a one-file backend binary per host platform.
//
// Output: backend/dist/swing-backend(.exe)
// Consumed by: electron-builder `extraResources` (see package.json → build)
//
// Why a Node script (not a Bash / PowerShell pair): same code runs on
// macOS / Linux / Windows runners in CI without a per-OS rewrite, and
// `npm run bundle:py` makes the build invocation obvious in package.json.
//
// Requirements:
//   - Python 3.10+ (matches backend/.venv — already 3.13 here)
//   - pip install pyinstaller in that venv (or system; not bundled
//     into requirements.txt to keep dev deps lean)
//   - backend/.venv/ for the runtime packages (mediapipe, onnxruntime,
//     opencv, fastapi, uvicorn, numpy, pydantic)
//
// Cross-build matrix (CRITICAL — each target needs its own builder):
//   platform     runs on               produces
//   macOS x64    macOS runner          swing-backend       (Mach-O)
//   macOS arm64  macOS runner (M-series) swing-backend     (arm64)
//   Windows x64  Windows runner        swing-backend.exe   (PE32+)
//   Linux x64    Linux runner          swing-backend       (ELF)
//
// You CANNOT cross-build these on a single host — PyInstaller bundles
// the local Python interpreter, which is a native binary. Use CI's
// matrix builds for the full set.
//
// Run modes:
//   node scripts/build-python-bundle.js           # builds for the current host
//   node scripts/build-python-bundle.js --check   # verifies pyinstaller + python
//                                                  on PATH without writing

const { execFileSync, spawn } = require('node:child_process');
const { existsSync, mkdirSync, statSync } = require('node:fs');
const { resolve, join, dirname } = require('node:path');

const root = resolve(__dirname, '..');
const venv = resolve(root, 'backend/.venv');
const isWin = process.platform === 'win32';
const exeSuffix = isWin ? '.exe' : '';
const distDir = resolve(root, 'backend/dist');
const bundleName = `swing-backend${exeSuffix}`;
const bundleOut = join(distDir, bundleName);

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

// Args we hand to PyInstaller:
//   --onefile       everything in a single executable (extracts to temp at run)
//   --name          output filename (no suffix on POSIX)
//   --paths         include the repo root so `import backend.*` works
//   --collect-submodules  pull every backend.{service,core}.* member
//   --hidden-import backstop for dynamic imports (mediapipe, onnxruntime
//                   load plugin .so/.dll files at runtime; PyInstaller
//                   already tracks them once they're imported once in
//                   --collect-all, but --hidden-import is the safety net)
//   --add-data      extra non-code assets if any (none today)
//   --noconfirm     overwrite dist/ without prompting
//   --clean         start fresh so stale artefacts don't leak into the build
//   --log-level WARN  keep build output short
const args = [
  '-m', 'PyInstaller',
  '--onefile',
  '--name', 'swing-backend',
  '--paths', root,
  '--collect-submodules', 'backend',
  '--collect-all', 'mediapipe',
  '--collect-all', 'onnxruntime',
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

console.log(`[bundle:py] host=${process.platform} arch=${process.arch}`);
console.log(`[bundle:py] running: ${py} ${args.join(' ')}`);
const start = Date.now();
const proc = spawn(py, args, { stdio: 'inherit' });
proc.on('exit', (code) => {
  if (code !== 0) {
    console.error(`[bundle:py] PyInstaller exited ${code}`);
    process.exit(code ?? 1);
  }
  if (!existsSync(bundleOut)) {
    console.error(`[bundle:py] expected output missing: ${bundleOut}`);
    process.exit(2);
  }
  const size = (statSync(bundleOut).size / 1024 / 1024).toFixed(1);
  console.log(`[bundle:py] ok — ${bundleOut} (${size} MiB) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log('[bundle:py] Next: `npm run pack:<platform>` will pick this up via extraResources.');
});
