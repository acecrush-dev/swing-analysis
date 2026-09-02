/**
 * Plan 004 — F12-style detachable panels (clips list + event log).
 *
 * A small, single-instance manager that lazily creates per-kind
 * `BrowserWindow`s for the clips panel and the log panel. State flows
 * are entirely mediated by the main process:
 *
 *   renderer (App.tsx)  ──push snapshot──▶  panels.ts cache ──fan-out──▶  panel windows
 *   panel window       ──action-request──▶  panels.ts sink  ──forward──▶  main window
 *
 * The manager itself is intentionally narrow: it does not know about
 * React, the SwingClient, or the schema for snapshots/actions. The
 * caller is responsible for shape, and the panel-window renderers ask
 * `getPanelCachedState` on mount so they can paint without a blank
 * frame before the next push arrives.
 */

import { BrowserWindow, screen, app } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Same icon-resolution logic as src/main/index.ts (kept inline rather
// than imported: panels.ts is loaded before main's appIconPath exists).
function panelIconPath(): string | undefined {
  const repoRoot = join(__dirname, '..', '..');
  const ext = process.platform === 'darwin' ? 'icns'
            : process.platform === 'win32'  ? 'ico'
            : 'png';
  const candidates = [
    join(repoRoot, 'build', `icon.${ext}`),
    join(process.resourcesPath ?? '', 'build', `icon.${ext}`),
  ];
  return candidates.find(existsSync);
}

export type PanelKind = 'clips' | 'log';

/** Loose shape — schema is enforced at the renderer. */
export type PanelAction = { type: string; [k: string]: unknown };

interface PanelSpec {
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
  title: string;
}

// Per-kind sizing + title. Kept here so the renderer doesn't need its
// own copy; layout values mirror the ClipsBar / ResultsPanel inline
// styles closely enough that the panels look like the docked versions.
const SPEC: Record<PanelKind, PanelSpec> = {
  clips: {
    defaultWidth: 960,
    defaultHeight: 420,
    minWidth: 360,
    minHeight: 240,
    title: '🎬 Clips — Swing-Analysis',
  },
  log: {
    defaultWidth: 620,
    defaultHeight: 520,
    minWidth: 360,
    minHeight: 280,
    title: '📜 事件日志 — Swing-Analysis',
  },
};

const panels = new Map<PanelKind, BrowserWindow>();

let cachedState: unknown = null;
let actionSink: ((a: PanelAction) => void) | null = null;

// ── bounds persistence ─────────────────────────────────────────────
// Tiny JSON file under userData. We could pull in electron-store but
// plan 004 §2 says no new deps; this is <30 lines.

interface BoundsFile {
  clips?: Electron.Rectangle;
  log?: Electron.Rectangle;
}

function boundsPath(): string {
  return join(app.getPath('userData'), 'panel-bounds.json');
}

function readBounds(): BoundsFile {
  try {
    const p = boundsPath();
    if (!existsSync(p)) return {};
    const raw = readFileSync(p, 'utf-8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    return obj as BoundsFile;
  } catch {
    // Corrupted JSON / permission denied — drop silently and fall back
    // to default placement. Never throw out of bounds helpers.
    return {};
  }
}

function writeBounds(b: BoundsFile): void {
  try {
    writeFileSync(boundsPath(), JSON.stringify(b, null, 2), 'utf-8');
  } catch {
    // Disk full / read-only — ignore. Worst case is we forget bounds
    // for one session.
  }
}

function saveKindBounds(kind: PanelKind, win: BrowserWindow): void {
  try {
    if (win.isDestroyed()) return;
    const b = win.getBounds();
    const all = readBounds();
    all[kind] = b;
    writeBounds(all);
  } catch {
    /* ignore */
  }
}

/**
 * Clamp x/y so a window last saved on a now-disconnected monitor
 * doesn't appear off-screen. Sizes that wouldn't fit are also shrunk
 * to fit the work area (rare — only happens if the user manually
 * resized below our min, which we also clamp).
 */
function clampBounds(b: Electron.Rectangle, spec: PanelSpec): Electron.Rectangle {
  try {
    const display = screen.getDisplayMatching(b);
    const wa = display.workArea;
    const width = Math.max(spec.minWidth, Math.min(b.width, wa.width));
    const height = Math.max(spec.minHeight, Math.min(b.height, wa.height));
    let x = b.x;
    let y = b.y;
    if (x < wa.x) x = wa.x;
    if (y < wa.y) y = wa.y;
    if (x + width > wa.x + wa.width) x = wa.x + wa.width - width;
    if (y + height > wa.y + wa.height) y = wa.y + wa.height - height;
    return { x, y, width, height };
  } catch {
    return { x: undefined as any, y: undefined as any, width: spec.defaultWidth, height: spec.defaultHeight };
  }
}

/**
 * Register the callback that delivers an action back to the main
 * window. Called once from createWindow() so we don't have to pass a
 * `BrowserWindow` reference around every time the panel wants to send
 * a message. The sink is also responsible for `win.show() + focus()`
 * when an action should pull attention back to the main window.
 */
export function setPanelActionSink(cb: (a: PanelAction) => void): void {
  actionSink = cb;
}

/**
 * Forward an action received from a panel window to the action sink
 * (set by the main index.ts via setPanelActionSink). The IPC channel
 * is `panel:action-request`; this just shoves it onward.
 */
export function forwardPanelAction(action: unknown): void {
  if (!action || typeof action !== 'object') return;
  const a = action as PanelAction;
  if (typeof a.type !== 'string' || a.type.length === 0) return;
  actionSink?.(a);
}

/** Push a state snapshot into the cache and out to every open panel. */
export function broadcastPanelState(snap: unknown): void {
  cachedState = snap;
  for (const win of panels.values()) {
    try {
      if (win.isDestroyed()) continue;
      win.webContents.send('panel:state', snap);
    } catch {
      // webContents may be mid-destroy during shutdown; ignore.
    }
  }
}

/** Pull the last snapshot — used when a panel mounts to avoid a flash. */
export function getPanelCachedState(): unknown {
  return cachedState;
}

/** True iff a panel of this kind currently has a live BrowserWindow. */
export function isPanelOpen(kind: PanelKind): boolean {
  const w = panels.get(kind);
  return !!w && !w.isDestroyed();
}

/** Snapshot of open-state for both kinds (used by the renderer badge). */
export function panelOpenState(): Record<PanelKind, boolean> {
  return { clips: isPanelOpen('clips'), log: isPanelOpen('log') };
}

/**
 * Open (or focus, if already open) a panel window.
 *
 * `parent` is the main BrowserWindow — passing it makes the panel
 * "child-like": it floats above the parent, is hidden when the parent
 * is minimized, and is closed when the parent is closed. This matches
 * Chrome DevTools' "Undock into separate window" + re-dock semantics
 * in terms of lifetime, even though we don't auto-re-dock.
 */
export function openPanel(kind: PanelKind, parent: BrowserWindow): { ok: boolean; error?: string } {
  if (kind !== 'clips' && kind !== 'log') return { ok: false, error: 'bad kind' };
  const existing = panels.get(kind);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return { ok: true };
  }

  const spec = SPEC[kind];
  const saved = readBounds()[kind];
  const bounds: Electron.Rectangle = saved
    ? clampBounds(saved, spec)
    : { x: undefined as any, y: undefined as any, width: spec.defaultWidth, height: spec.defaultHeight };

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    parent,
    title: spec.title,
    icon: panelIconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#1a1a1a',
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // DevTools-style: deny any window.open attempts from the panel.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    win.loadURL(rendererUrl + '/' + kind + '.html').catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[panel] loadURL failed:', e);
    });
  } else {
    win.loadFile(join(__dirname, '..', 'renderer', kind + '.html')).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[panel] loadFile failed:', e);
    });
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  // On first paint, push whatever we already cached so the panel can
  // paint immediately rather than waiting for the next renderer
  // snapshot (which is throttled to 100ms by usePanelSync).
  win.webContents.on('did-finish-load', () => {
    if (cachedState !== null) {
      try { win.webContents.send('panel:state', cachedState); } catch { /* */ }
    }
  });

  win.on('close', () => saveKindBounds(kind, win));
  win.on('closed', () => {
    panels.delete(kind);
    // Tell the main window so its UI can flip the detached flag back
    // and re-show the inline ClipsBar / log region.
    actionSink?.({ type: 'closed', kind });
  });

  panels.set(kind, win);
  return { ok: true };
}

/** Force-close a panel window (user clicked 📍 收回 / red X). */
export function closePanel(kind: PanelKind): void {
  const w = panels.get(kind);
  if (!w || w.isDestroyed()) return;
  try { w.close(); } catch { /* ignore */ }
}

/** Close every panel — called from app.before-quit + win.closed. */
export function closeAllPanels(): void {
  for (const w of panels.values()) {
    try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
  }
  panels.clear();
}
