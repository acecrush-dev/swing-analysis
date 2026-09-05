#!/usr/bin/env node
// Wipe build artefacts before a fresh `pack:*` run.
// Idempotent — missing dirs are no-ops (rmSync force:true).
//
// Why each target:
//   backend/dist/             PyInstaller output. Cross-arch builds overwrite
//                             the same filename (`swing-backend` for mac/linux
//                             onefile, `swing-backend-win/swing-backend.exe`
//                             for win onedir), so an old arm64 binary sitting
//                             here will silently shadow a fresh x64 build of
//                             the same name on the next run.
//   backend/build/pyinstaller PyInstaller work dir. The `bundle:py` script
//                             passes `--clean` to PyInstaller which clears it
//                             at run time, but a manual edit / interrupted
//                             run can leave stale state.
//   release/                  electron-builder output (per `directories.output`
//                             in package.json). electron-builder normally
//                             wipes this before each run, but an interrupted
//                             build or `--dir` mode can leave half-written
//                             files behind.
//   out/                      electron-vite output. electron-vite's `build`
//                             re-creates it, but removing it first guarantees
//                             no stale `out/main/index.js` from a previous
//                             architecture leaks into the new asar.

const { rmSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const targets = [
  'backend/dist',
  'backend/build/pyinstaller',
  'release',
  'out',
];

let removed = 0;
for (const t of targets) {
  const abs = resolve(root, t);
  if (existsSync(abs)) {
    rmSync(abs, { recursive: true, force: true });
    console.log(`[clean] removed ${t}`);
    removed++;
  } else {
    console.log(`[clean] skip ${t} (not present)`);
  }
}
console.log(`[clean] done — ${removed}/${targets.length} removed.`);
