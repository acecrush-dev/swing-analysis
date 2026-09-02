#!/usr/bin/env node
// Regenerate build/{icon.png, icon.ico, icon.icns} from images/ace_crush_logo_green.png.
// Run via `npm run icons` (also invoked from `prepack`).
//
// Requires ImageMagick (`magick` on PATH). macOS-only step (`iconutil`)
// is skipped on other platforms with a console.warn rather than failing,
// since .icns is only consumed when building the macOS target.

const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, rmSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const source = resolve(root, 'images/ace_crush_logo_green.png');
const buildDir = resolve(root, 'build');
const iconsetDir = resolve(buildDir, 'mac-icon.iconset');

if (!existsSync(source)) {
  console.error(`[icons] source PNG not found: ${source}`);
  process.exit(1);
}

function run(file, args) {
  console.log(`[icons] ${file} ${args.join(' ')}`);
  execFileSync(file, args, { stdio: 'inherit' });
}

// 1. Master 1024×1024 PNG (Linux + general source)
if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });
run('magick', [source, '-background', 'none', '-resize', '1024x1024',
              resolve(buildDir, 'icon.png')]);

// 2. Multi-res Windows .ico
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoArgs = [source];
for (const s of icoSizes) icoArgs.push('(' + source, '-clone', '0', '-resize', `${s}x${s}`, ')');
icoArgs.push('-delete', '0', resolve(buildDir, 'icon.ico'));
run('magick', icoArgs);

// 3. macOS .icns via iconutil (skipped on non-darwin)
if (process.platform === 'darwin') {
  if (existsSync(iconsetDir)) rmSync(iconsetDir, { recursive: true, force: true });
  mkdirSync(iconsetDir, { recursive: true });
  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const s of sizes) {
    run('magick', [source, '-background', 'none', '-resize', `${s}x${s}`,
                   resolve(iconsetDir, `icon_${s}x${s}.png`)]);
  }
  // retina @2x variants
  const clones = [
    [32, 16], [64, 32], [256, 128], [512, 256], [1024, 512],
  ];
  for (const [full, half] of clones) {
    run('cp', [resolve(iconsetDir, `icon_${full}x${full}.png`),
               resolve(iconsetDir, `icon_${half}x${half}@2x.png`)]);
  }
  run('iconutil', ['-c', 'icns', iconsetDir, '-o', resolve(buildDir, 'icon.icns')]);
  rmSync(iconsetDir, { recursive: true, force: true });
} else {
  console.warn('[icons] iconutil step skipped (macOS only); run on macOS for icon.icns');
}

// 4. Renderer favicon (32×32 + 256×256)
const pubDir = resolve(root, 'src/renderer/public');
if (!existsSync(pubDir)) mkdirSync(pubDir, { recursive: true });
run('magick', [source, '-background', 'none', '-resize', '32x32',
               resolve(pubDir, 'favicon.png')]);
run('magick', [source, '-background', 'none', '-resize', '256x256',
               resolve(pubDir, 'favicon-256.png')]);

console.log('[icons] done.');
