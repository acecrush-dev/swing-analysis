/**
 * App settings persisted in `userData/settings.json` (main-process owned;
 * NOT localStorage — the sidecar spawn happens before any renderer exists,
 * and every panel window would otherwise carry its own copy).
 *
 * Currently one key: `output_dir` — where the backend keeps jobs
 * (`<output_dir>/jobs/<job_id>`). Default: `<repoRoot>/backend/data`.
 *
 * Lifecycle caveat: the sidecar reads `--data-dir` ONCE at spawn, so a
 * changed output_dir applies on the NEXT app launch. The main-process
 * helpers (open-output-dir / clear-output-dir) therefore use the *active*
 * value captured at startup via setActiveDataDir(), never a fresh read —
 * otherwise "reveal folder" would point somewhere jobs aren't actually
 * being written mid-session.
 */

import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface AppSettings {
  /** Configured jobs root (absolute path), or null for the built-in default. */
  output_dir: string | null;
}

const DEFAULT_SETTINGS: AppSettings = { output_dir: null };

let cachedPath: string | null = null;

function settingsPath(): string {
  if (!cachedPath) cachedPath = join(app.getPath('userData'), 'settings.json');
  return cachedPath;
}

export function loadSettings(): AppSettings {
  try {
    const p = settingsPath();
    if (existsSync(p)) {
      const obj = JSON.parse(readFileSync(p, 'utf-8'));
      if (obj && typeof obj === 'object') {
        return {
          output_dir:
            typeof obj.output_dir === 'string' && obj.output_dir.trim()
              ? obj.output_dir.trim()
              : null,
        };
      }
    }
  } catch (e) {
    console.warn('[settings] load failed:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: AppSettings): boolean {
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
    return true;
  } catch (e) {
    console.warn('[settings] save failed:', e);
    return false;
  }
}

/** Built-in jobs root — dev: <repoRoot>/backend/data; packaged: <userData>/backend-data.
 *
 * In packaged builds `__dirname` lives inside app.asar so `<repoRoot>`
 * points at a path that doesn't exist on disk. We pivot to
 * `app.getPath('userData')` which Electron resolves to a per-OS, per-user
 * writable directory keyed off the package's `productName` ("AceCrush
 * Swing-Analysis") → macOS `~/Library/Application Support/AceCrush
 * Swing-Analysis/`, Linux `~/.config/AceCrush Swing-Analysis/`, Windows
 * `%APPDATA%/AceCrush Swing-Analysis/`. The user can still override via
 * the Settings panel.
 */
export function defaultDataDir(): string {
  if (app.isPackaged) {
    return join(app.getPath('userData'), 'backend-data');
  }
  const repoRoot = join(__dirname, '..', '..');
  return join(repoRoot, 'backend', 'data');
}

// ── active (sidecar-launched-with) jobs root ─────────────────────────
let activeDataDir: string | null = null;

/** Called once at startup, right before the sidecar spawns. */
export function setActiveDataDir(dir: string): void {
  activeDataDir = dir;
}

/** The jobs root the running sidecar was launched with. */
export function activeData(): string {
  return activeDataDir ?? defaultDataDir();
}
