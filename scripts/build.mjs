#!/usr/bin/env node
// scripts/build.mjs — env-driven build orchestrator.
//
// Usage:
//   SWING_BUILD_MODE=python pnpm build:mac     # current default; PyInstaller sidecar packaged
//   SWING_BUILD_MODE=ts     pnpm build:mac     # pure TS/WASM build; no Python at all
//   SWING_BUILD_MODE=ts     pnpm build:win
//
// `SWING_BUILD_MODE` defaults to `python` (current behavior).
//
// What it does per mode:
//   python — runs clean → icons → bundle:py → vite build → electron-builder.
//            Copies backend/dist (PyInstaller bundle) + backend/models (LFS)
//            into extraResources. .env gets SWING_BACKEND=python.
//   ts     — runs clean → vite build → electron-builder.
//            Skips bundle:py (no Python bundle). Strips backend/* from
//            extraResources (no Python extras). .env gets SWING_BACKEND=ts.
//            ONNX/.task files are served from src/renderer/public/assets/models/
//            via symlinks to backend/models/ (committed there for LFS).
//
// Why not just delete the Python extraResources in ts mode permanently:
// we want one source of truth (package.json#build) so dev / CI don't
// have to remember to flip bits. Mutating a temp copy at build time and
// pointing electron-builder at it keeps package.json clean.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const mode = (process.env.SWING_BUILD_MODE || 'python').toLowerCase();
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const target =
  (targetArg && targetArg.split('=')[1]) ||
  process.argv[2] ||
  'mac';

// Everything after the target arg is forwarded to electron-builder as
// additional flags. Lets us do `--arm64`, `--x64`, `--ia32`, custom
// artifactName overrides, etc. without re-touching this script.
const ebExtraArgs = process.argv
  .slice(2)
  .filter((a, i) => a !== target && i > 0 || (targetArg && a !== targetArg));

if (!['python', 'ts'].includes(mode)) {
  console.error(`[build] SWING_BUILD_MODE must be 'python' or 'ts', got '${mode}'`);
  process.exit(1);
}
if (!['mac', 'win', 'linux', 'dir', 'all'].includes(target)) {
  console.error(`[build] target must be mac / win / linux / dir / all, got '${target}'`);
  process.exit(1);
}

console.log(`[build] mode=${mode}  target=${target}${ebExtraArgs.length ? ' extra=' + ebExtraArgs.join(' ') : ''}`);

// ── 1. .env: write the mode the built app will read at startup ───────
writeFileSync(resolve(root, '.env'), `SWING_BACKEND=${mode}\n`);
console.log(`[build] wrote .env: SWING_BACKEND=${mode}`);

// ── 2. Build a per-mode electron-builder config (mutated copy of
//       package.json#build; written to .build-tmp/ so package.json
//       itself stays clean and the source of truth is unchanged).
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
// Make a deep copy so mutating `cfg` doesn't bleed back into the
// cached pkg object.
const ebCfg = JSON.parse(JSON.stringify(pkg.build || {}));

if (mode === 'ts') {
  // Strip backend-related extras — the TS build doesn't ship Python
  // or any backend models (those live in public/assets/models/ via
  // symlinks and get bundled by Vite as part of the renderer output).
  for (const p of ['mac', 'win', 'linux']) {
    if (ebCfg[p]?.extraResources) {
      ebCfg[p].extraResources = ebCfg[p].extraResources.filter((e) => {
        return !(e && typeof e === 'object' && typeof e.from === 'string' && e.from.startsWith('backend/'));
      });
    }
  }
}

mkdirSync(resolve(root, '.build-tmp'), { recursive: true });
const tmpCfg = resolve(root, `.build-tmp/electron-builder.${mode}.${target}.json`);
writeFileSync(tmpCfg, JSON.stringify(ebCfg, null, 2));
console.log(`[build] wrote ${tmpCfg}`);

// ── 3. Build chain ──────────────────────────────────────────────────
const run = (cmd) => {
  console.log(`\n[build] $ ${cmd}\n`);
  execSync(cmd, { stdio: 'inherit', cwd: root });
};

run('npm run clean');

if (mode === 'python') {
  // icons: skip — they're git-tracked since plan-A and re-running just
  // regenerates identical bytes (with -strip). The clean step wiped
  // release/ + build/mac-icon.iconset/, but build/icon.{png,ico,icns}
  // is in git and we re-`npm run icons` only when the source logo
  // actually changes.
  //
  // bundle:py: required for python mode. Runs PyInstaller (~1-2 min on
  // a warm venv).
  run('npm run bundle:py');
} else {
  // ts mode: no sidecar, no model files in extraResources. The
  // public/assets/models/ symlinks need to be present; if they're
  // missing, recreate them so the packaged build has ONNX access.
  ensureModelSymlinks();
}

run('electron-vite build');

const ebFlags = {
  mac:   ['--mac'],
  win:   ['--win', '--x64'],
  linux: ['--linux', '--x64'],
  dir:   ['--dir'],
  all:   ['-mwl'],
}[target];

const extra = ebExtraArgs.join(' ');
run(`electron-builder ${[...ebFlags, ...ebExtraArgs].join(' ')} --config "${tmpCfg}"`);

// ── 4. Cleanup tmp config ────────────────────────────────────────────
rmSync(resolve(root, '.build-tmp'), { recursive: true, force: true });
console.log(`\n[build] done — ${target} ${mode} build complete`);

// ── helpers ───────────────────────────────────────────────────────────
function ensureModelSymlinks() {
  const publicDir = resolve(root, 'src/renderer/public/assets/models');
  const backendDir = resolve(root, 'backend/models');
  if (!existsSync(backendDir)) {
    // No models to symlink to (e.g. fresh clone without `git lfs pull`).
    // The renderer will show "failed" for each model — that's fine,
    // the user gets a clear signal to run scripts/fetch-model.sh.
    console.warn(`[build] backend/models not found — ONNX files will be missing in the build`);
    return;
  }
  mkdirSync(publicDir, { recursive: true });
  for (const f of ['rtmdet-m-487628.onnx', 'rtmpose-m-27c0e6.onnx', 'pose_landmarker_lite.task']) {
    const target = resolve(publicDir, f);
    const source = resolve(backendDir, f);
    if (existsSync(target)) continue;  // already linked
    try {
      const { symlinkSync } = require('node:fs');
      symlinkSync(source, target);
    } catch {
      // Fall back to a copy if symlinks aren't allowed.
      const { copyFileSync } = require('node:fs');
      copyFileSync(source, target);
      console.warn(`[build] copied (couldn't symlink) ${f}`);
    }
  }
  console.log(`[build] model symlinks present in ${publicDir}`);
}
