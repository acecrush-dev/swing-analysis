import { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItemConstructorOptions } from 'electron';
import { join, resolve as resolvePath } from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, statSync, createWriteStream, mkdirSync, rmSync, unlinkSync, readFileSync } from 'node:fs';
import {
  openPanel,
  closePanel,
  closeAllPanels,
  isPanelOpen,
  panelOpenState,
  broadcastPanelState,
  getPanelCachedState,
  forwardPanelAction,
  setPanelActionSink,
  type PanelKind,
} from './panels';
import { loadSettings, saveSettings, defaultDataDir, setActiveDataDir, activeData } from './settings';
import * as busy from './busy';

interface ServiceInfo { host: string; port: number; url: string; }

class PythonSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private info: ServiceInfo | null = null;
  private command: string;
  private baseArgs: string[];
  private cwd?: string;

  constructor(command: string, baseArgs: string[], cwd?: string) {
    this.command = command;
    this.baseArgs = baseArgs;
    this.cwd = cwd;
  }

  baseUrl(): string | null { return this.info?.url ?? null; }

  async start(timeoutMs = 15000): Promise<ServiceInfo> {
    if (this.info) return this.info;
    if (process.env.SWING_SERVICE_URL) {
      this.info = this.parseUrl(process.env.SWING_SERVICE_URL);
      console.log('[sidecar] attach to', this.info.url);
      return this.info;
    }
    const args = [
      ...this.baseArgs,
      '--port', '0',
      '--data-dir', activeData(),
      '--models-dir', MODELS_DIR,
    ];
    console.log('[sidecar] spawning:', this.command, args.join(' '));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new Error('sidecar 启动超时 (15s)'));
      }, timeoutMs);
      const spawnOpts = this.cwd ? { cwd: this.cwd } : {};
      this.proc = spawn(this.command, args, spawnOpts);
      const onLine = (chunk: Buffer) => {
        const s = chunk.toString();
        for (const line of s.split(/\r?\n/)) {
          if (line.startsWith('SWING_SERVICE_URL=')) {
            clearTimeout(timer);
            this.info = this.parseUrl(line.split('=', 2)[1].trim());
            console.log('[sidecar] up at', this.info.url);
            resolve(this.info);
          }
        }
      };
      this.proc!.stdout.on('data', onLine);
      this.proc!.stderr.on('data', (b) => process.stderr.write('[svc] ' + b.toString()));
      this.proc!.on('exit', (code) => {
        if (!this.info) {
          clearTimeout(timer);
          reject(new Error(`sidecar 进程退出 code=${code}`));
        }
      });
    });
  }

  kill() {
    const proc = this.proc; // local binding: TS narrows `this.proc` poorly across the try blocks
    if (proc && !proc.killed) {
      if (typeof proc.pid === 'number') {
        try { process.kill(-proc.pid); } catch {}
      }
      try { proc.kill(); } catch {}
    }
    this.proc = null;
    this.info = null;
  }

  private parseUrl(url: string): ServiceInfo {
    const u = new URL(url);
    return { host: u.hostname, port: Number(u.port || 0), url: url.replace(/\/$/, '') };
  }
}

const repoRoot = join(__dirname, '..', '..');

// ── Sidecar launch strategy ────────────────────────────────────────
// In dev: spawn the venv python with `python -m backend.service`.
// In packaged: spawn the PyInstaller one-file bundle produced by
// `scripts/build-python-bundle.js` and copied into resources/backend/
// by electron-builder (see package.json → build.extraResources).
//
// We always pass --models-dir explicitly: in dev models live in
// backend/models/ under the repo; in packaged they're in
// process.resourcesPath/models/. Defaulting the CLI arg to "next to
// __file__" works in dev (Python's __file__) but fails in the bundled
// binary where __file__ points into the temp extraction — so we set it.
//
// Mac/Linux/python3 / Windows/.exe — only the dev path needs the .exe
// search; everything else is the same Python interpreter.
interface SidecarLaunchSpec {
  command: string;
  baseArgs: string[];
  cwd?: string;
}

function pickSidecarLaunch(): SidecarLaunchSpec {
  if (app.isPackaged) {
    // process.resourcesPath is `${app.getAppPath()}/..` in dev and
    // `<app>/Contents/Resources` in mac packaged apps / `<app>/resources`
    // in win/linux. Models + the swing-backend binary land here.
    const resBase = process.resourcesPath ?? join(repoRoot, 'release');
    const isWin = process.platform === 'win32';
    const exe = join(resBase, 'backend', `swing-backend${isWin ? '.exe' : ''}`);
    return {
      command: exe,
      baseArgs: [],
      cwd: undefined,
    };
  }
  const candidates = [
    join(repoRoot, 'backend', '.venv', 'bin', 'python3'),
    join(repoRoot, 'backend', '.venv', 'bin', 'python'),
  ];
  const python = candidates.find(existsSync) ?? (process.platform === 'win32' ? 'python.exe' : 'python3');
  return {
    command: python,
    baseArgs: ['-m', 'backend.service'],
    cwd: repoRoot,
  };
}

function modelsDirFor(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath ?? '', 'models');
  }
  return join(repoRoot, 'backend', 'models');
}

// Jobs/output root. The Settings panel can point this anywhere
// (userData/settings.json → `output_dir`); the built-in default is
// <repoRoot>/backend/data in dev, <userData>/backend-data in packaged
// (see defaultDataDir()). Captured ONCE here because the sidecar reads
// --data-dir only at spawn — a settings change applies on next launch,
// and the IPC handlers below must agree with where jobs actually land.
const DATA_DIR_DEFAULT = defaultDataDir();
const CONFIGURED_DATA_DIR: string | null = loadSettings().output_dir;
const DATA_DIR: string = CONFIGURED_DATA_DIR ?? DATA_DIR_DEFAULT;
setActiveDataDir(DATA_DIR);

const SIDE_LAUNCH = pickSidecarLaunch();
const MODELS_DIR = modelsDirFor();
const sidecar = new PythonSidecar(SIDE_LAUNCH.command, SIDE_LAUNCH.baseArgs, SIDE_LAUNCH.cwd);

// Resolve the Swing-Analysis app icon at runtime. In dev mode the icons live
// under <repo>/build/; electron-builder copies that directory to
// resources/build/ inside the packaged app, so production loads from
// process.resourcesPath. macOS wants an `.icns` for the window/About and
// a `.png` for the Dock (dock.setIcon goes through nativeImage which
// reads PNG; .icns paths silently fail on some Electron versions).
function appIconPath(preferPng = false): string | undefined {
  // macOS: icns is the canonical Apple icon (window title bar, Cmd+Tab
  // list, About dialog when no override is set). PNG is what
  // app.dock.setIcon consumes. Default to icns for window; pass
  // preferPng=true for the Dock path.
  const ext = preferPng ? 'png'
            : process.platform === 'darwin' ? 'icns'
            : process.platform === 'win32'  ? 'ico'
            : 'png';
  const candidates = [
    join(repoRoot, 'build', `icon.${ext}`),                          // dev
    join(process.resourcesPath ?? '', 'build', `icon.${ext}`),       // packaged
    join(repoRoot, 'build', 'icon.png'),                             // dev PNG fallback
    join(process.resourcesPath ?? '', 'build', 'icon.png'),          // packaged PNG fallback
  ];
  return candidates.find(existsSync);
}

// Set the app name early so the macOS app menu (top bar) and About
// dialog reflect the brand. AceCrush is the parent brand; Swing-Analysis
// is this specific app — the macOS app-menu slot gets the *brand* line,
// while the BrowserWindow title (separately wired below) stays as
// "Swing-Analysis" so the window caption names the actual app.
// package.json `productName` is "AceCrush Swing-Analysis" for installers.
if (process.platform === 'darwin') app.setName('AceCrush');

// macOS Dock icon — must run inside `whenReady` because `app.dock` is
// only populated then (it's null at module-init time). BrowserWindow.icon
// does NOT change the Dock image; that's why a fresh dev launch still
// shows the default Electron icon even after `icon:` is wired into the
// window constructor. Setting it explicitly covers both modes (dev +
// packaged) — packaged builds additionally have electron-builder embed
// icon.icns into the .app bundle via `mac.icon`, so removing this call
// wouldn't break the packaged path, only the dev path.
function applyDockIcon() {
  if (process.platform !== 'darwin') return;
  if (!app.dock || typeof app.dock.setIcon !== 'function') return;
  const dockIcon = appIconPath(true) ?? appIconPath(); // PNG first, fall back to icns
  if (!dockIcon) {
    console.warn('[icon] dock icon path missing; Dock will show default Electron icon');
    return;
  }
  app.dock.setIcon(dockIcon);
  console.log('[icon] dock setIcon:', dockIcon);
}

async function createWindow() {
  let info: ServiceInfo;
  try {
    info = await sidecar.start();
  } catch (e) {
    const { dialog: dlg } = await import('electron');
    dlg.showErrorBox('sidecar 启动失败', String(e));
    app.quit();
    return;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: appIconPath(),
    title: 'Swing-Analysis',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Plan 004 — pipe panel-window action requests back into the main
  // window. select-clip additionally yanks focus back to main so the
  // user sees the playback switch immediately.
  setPanelActionSink((a) => {
    if (!win.isDestroyed()) win.webContents.send('panel:action', a);
    if (a && a.type === 'select-clip') {
      if (!win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    }
  });
  win.on('closed', () => closeAllPanels());
  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }
}

app.whenReady().then(() => {
  applyDockIcon();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { busy.cancelAllInflight(); sidecar.kill(); closeAllPanels(); });
app.on('activate', () => {
  applyDockIcon(); // macOS can re-pool the Dock icon after relaunch
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// DATA_DIR is defined at module scope above (settings.json `output_dir`
// or the built-in default) so IPC handlers reconstruct per-job out_dir
// paths without round-tripping to the Python service. Matches
// backend/service/jobs.py: jobs_root = data_dir / "jobs" / job_id.

// Open the job's output directory in the OS file manager. Renderer
// supplies the job_id (UUID12 like "abc123de45f6"); we look it up under
// DATA_DIR/jobs/<id> and shell.openPath it. The path may not exist yet
// (cold start, cancelled before extraction) — in that case we create it
// so the user sees an empty folder rather than nothing.
ipcMain.handle('open-output-dir', async (_evt, jobId: string, callId: string) => {
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{4,64}$/.test(jobId)) {
    return { ok: false, error: 'invalid jobId' };
  }
  // Plan 005 — register callId-cancel. The actual IO is a mkdir + an
  // openPath call, both effectively instant on this OS; the cancel
  // button is a no-op in practice (modal will close the instant
  // openPath returns). We still register so the contract is uniform.
  const ac = busy.registerCall(callId);
  try {
    if (ac.signal.aborted) return { ok: false, error: 'cancelled' };
    const dir = join(DATA_DIR, 'jobs', jobId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(resolvePath(dir));
    if (err) return { ok: false, error: err };
    return { ok: true, path: dir };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  } finally {
    busy.unregisterCall(callId);
  }
});

ipcMain.handle('pick-video', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    defaultPath: process.cwd(),
    filters: [{ name: 'video', extensions: ['mp4', 'mov', 'm4v', 'avi'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('get-service-info', () => sidecar.baseUrl());

// ── Settings: jobs output dir ─────────────────────────────────────
// The Settings panel reads/writes via these. `set-output-dir` accepts a
// path (created if missing) or null/'' to reset to the built-in default.
// Nothing is applied to the running sidecar — spawn reads --data-dir
// once, so the panel shows a "restart to apply" note after a change.
ipcMain.handle('settings:get', () => ({
  output_dir: DATA_DIR,                     // active this session
  default_output_dir: DATA_DIR_DEFAULT,     // built-in default
  configured_output_dir: CONFIGURED_DATA_DIR, // null = using default
}));

ipcMain.handle('settings:set-output-dir', async (_evt, dir: unknown) => {
  // Reset to default
  if (dir === null || dir === undefined || dir === '') {
    if (!saveSettings({ output_dir: null })) return { ok: false, error: 'write failed' };
    return { ok: true, output_dir: DATA_DIR_DEFAULT };
  }
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: 'bad path' };
  const trimmed = dir.trim();
  try {
    mkdirSync(trimmed, { recursive: true });
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
  if (!saveSettings({ output_dir: trimmed })) return { ok: false, error: 'write failed' };
  return { ok: true, output_dir: trimmed };
});

ipcMain.handle('settings:pick-output-dir', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: true, path: null };
  return { ok: true, path: r.filePaths[0] };
});

// ── Plan 004: F12-style detachable panels ─────────────────────────
// Each panel window is its own BrowserWindow (per-kind single-instance)
// that the renderer opens via panel:open and tears down via panel:close.
// State flows one-way (renderer → main → panel via panel:state) and
// actions flow the opposite direction (panel:action → main window).
ipcMain.handle('panel:open', (_evt, kind: PanelKind) => {
  if (kind !== 'clips' && kind !== 'log') return { ok: false, error: 'bad kind' };
  const parent = BrowserWindow.fromWebContents(_evt.sender);
  if (!parent) return { ok: false, error: 'no parent window' };
  return openPanel(kind, parent);
});

ipcMain.handle('panel:close', (_evt, kind: PanelKind) => {
  if (kind !== 'clips' && kind !== 'log') return { ok: false, error: 'bad kind' };
  closePanel(kind);
  return { ok: true };
});

ipcMain.handle('panel:is-open', () => panelOpenState());

ipcMain.handle('panel:get-state', () => getPanelCachedState());

ipcMain.on('panel:push-state', (_evt, snap: unknown) => {
  broadcastPanelState(snap);
});

ipcMain.on('panel:action-request', (_evt, action: unknown) => {
  forwardPanelAction(action);
});

// Pack the current job's output dir (segments.json + clips + viz.mp4)
// into a single zip the user can hand off. Done in the main process so
// the renderer doesn't need direct fs access.
ipcMain.handle('export-package', async (_evt, jobId: string | null, callId: string) => {
  if (!jobId) return { ok: false, error: 'no active job' };
  // Use the same DATA_DIR the sidecar writes to (settings override
  // honored). The previous ad-hoc candidates were wrong for packaged
  // builds AND for any user who customised output_dir via Settings.
  const resolved = join(DATA_DIR, 'jobs', jobId);
  if (!existsSync(resolved)) return { ok: false, error: 'job 不存在或已删除' };
  // Refuse to emit an empty zip — Archive Utility reports those as
  // "cannot expand" and the user sees a broken file with no error.
  try {
    if (readdirSync(resolved).length === 0) {
      return { ok: false, error: 'job 数据为空,无法打包' };
    }
  } catch { /* fall through — archiver will surface the real error */ }

  const save = await dialog.showSaveDialog({
    title: '导出 job 包',
    defaultPath: `swing-${jobId}.zip`,
    filters: [{ name: 'zip', extensions: ['zip'] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' };

  // Plan 005 — register callId-cancel. archiver.archive.abort() does
  // NOT instantly stop the OS-level write (it's buffered), but it does
  // surface as an `error` event with code "ERR_ARCHIVE_ABORTED" /
  // message "Archive aborted", which our `archive.on('error', ...)`
  // already routes to `{ok:false, error}`. The finally block unlinks
  // the half-written zip so the user doesn't see a 0-byte / corrupted
  // file in their downloads folder.
  const ac = busy.registerCall(callId);
  let aborted = false;
  return await new Promise<{ ok: boolean; path?: string; error?: string }>(async (resolve) => {
    const finish = (r: { ok: boolean; path?: string; error?: string }) => {
      busy.unregisterCall(callId);
      // If the user cancelled, nuke the half-zipped file.
      if (aborted && save.filePath) {
        try { unlinkSync(save.filePath); } catch { /* ignore */ }
      }
      resolve(r);
    };
    try {
      // archiver 8.x is ESM-only ("type":"module"), so we can't `require()`
      // it from this CJS main process — `require('archiver')` would yield
      // the namespace object { Archiver, ZipArchive, ... }, not a callable,
      // producing "archiver is not a function". Dynamic import + class.
      const { ZipArchive } = await import('archiver');
      const out = createWriteStream(save.filePath!);
      const archive = new ZipArchive({ zlib: { level: 9 } });
      const onAbort = () => {
        aborted = true;
        try { archive.abort(); } catch { /* ignore */ }
      };
      ac.signal.addEventListener('abort', onAbort);
      out.on('close', () => finish({ ok: true, path: save.filePath! }));
      out.on('error', (e: Error) => finish({ ok: false, error: e.message }));
      archive.on('error', (e: Error) => {
        // archiver surfaces "Archive aborted" with its own message —
        // we don't want to leak that as a real failure to the user.
        if (ac.signal.aborted) finish({ ok: false, error: 'cancelled' });
        else finish({ ok: false, error: e.message });
      });
      archive.pipe(out);
      archive.directory(resolved!, jobId);
      archive.final();
    } catch (e: any) {
      finish({ ok: false, error: String(e) });
    }
  });
});

// Open any external URL in the user's default browser. Used by the
// Help → Help Content menu item.
ipcMain.handle('open-external', async (_evt, url: string) => {
  if (!/^https?:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('show-about', () => {
  dialog.showMessageBox({
    type: 'info',
    title: '关于 AceCrush Swing-Analysis',
    message: 'AceCrush Swing-Analysis',
    detail: [
      'AceCrush 品牌系列 · 网球挥拍自动切分工具',
      '',
      `版本 ${app.getVersion()}`,
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
      `Chromium ${process.versions.chrome}`,
      '',
      '项目主页: https://github.com/leochan007/swing-analysis',
    ].join('\n'),
    buttons: ['OK'],
    noLink: true,
  });
});

// Wipe the entire backend/data/jobs/ tree (i.e. the "output dir").
// Used by the System → Clear Output Dir… menu item. Returns the
// deleted job IDs so the renderer can clear matching in-memory state.
//
// Plan 005 — callId-cancel: rmSync is a single recursive syscall and
// cannot be interrupted mid-flight; we register the controller so the
// cancel signal is at least honored as a pre-check (if the user clicks
// 取消 in the few hundred ms before the syscall actually starts).
// Any deletions already made are NOT rolled back — see plan §5.
ipcMain.handle('clear-output-dir', async (_evt, _payload: unknown, callId: string) => {
  const ac = busy.registerCall(callId);
  try {
    if (ac.signal.aborted) return { ok: false, error: 'cancelled' };
    const dir = join(DATA_DIR, 'jobs');
    if (!existsSync(dir)) return { ok: true, path: dir, deleted_count: 0, cleared_job_ids: [] };
    const before = readdirSync(dir);
    const ids = before.filter((n) => /^[a-zA-Z0-9_-]{4,64}$/.test(n));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return { ok: true, path: dir, deleted_count: ids.length, cleared_job_ids: ids };
  } catch (e: any) {
    return { ok: false, error: String(e) };
  } finally {
    busy.unregisterCall(callId);
  }
});

// Plan 005 — Cleanup Clips via main-process IPC. The previous
// implementation in App.tsx called `client.delete(jobId)` directly
// (a fetch to the Python sidecar). We now route it through here so
// the cancel signal can reach the underlying fetch via AbortSignal —
// the renderer no longer needs to know the sidecar URL for cleanup.
ipcMain.handle('cleanup-clips', async (_evt, payload: { jobId: string }, callId: string) => {
  const jobId = payload?.jobId;
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{4,64}$/.test(jobId)) {
    return { ok: false, error: 'invalid jobId' };
  }
  const ac = busy.registerCall(callId);
  try {
    if (ac.signal.aborted) return { ok: false, error: 'cancelled' };
    const baseUrl = sidecar.baseUrl();
    if (!baseUrl) return { ok: false, error: 'sidecar not ready' };
    const res = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: 'DELETE',
      signal: ac.signal,
    });
    // 404 means the job is already gone — treat as success so the UI
    // can complete cleanly even if the job vanished between menu open
    // and click.
    if (!res.ok && res.status !== 404) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}${body ? `: ${body}` : ''}` };
    }
    return { ok: true };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: 'cancelled' };
    return { ok: false, error: String(e) };
  } finally {
    busy.unregisterCall(callId);
  }
});

// Plan 005 — renderer asks for a base64 data URL of the app icon to
// embed in the BusyModal. We read the PNG once and return it as a
// data: URL so the renderer doesn't have to touch the fs and the
// `<img>` element caches it for free.
ipcMain.handle('app:get-icon-data-url', () => {
  const p = appIconPath(true) ?? appIconPath();
  if (!p) return null;
  try {
    const buf = readFileSync(p);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
});

// Plan 005 — renderer's "取消" button triggers this. We just abort
// the AbortController we registered when the IPC started. Idempotent —
// a second call after the first one returns false.
ipcMain.on('cancel-call', (_evt, callId: unknown) => {
  if (typeof callId === 'string') busy.abortCall(callId);
});

// Build the application menu. Exactly two top-level menus — System
// (Open File / Export Package / Exit) and Help (docs link / About).
// Per the user's M24 spec: no Edit, no View, no Window.
//
// On macOS the FIRST menu in the template is auto-promoted to the App
// menu (label becomes the app name; system fills in About/Hide/Quit
// etc.) — that would silently rename our "System" menu to "AceCrush"
// and hide it. So on macOS we prepend an explicit App menu that carries
// those roles; System then becomes the second menu in the bar and
// keeps its label.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel: string) => () => {
    const w = BrowserWindow.getFocusedWindow();
    w?.webContents.send(channel);
  };
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    // macOS App menu — supplies the auto About/Hide/Services/Quit
    // entries so System can stay as a separately-labeled menu.
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' as const },
        { role: 'services' },
        { type: 'separator' as const },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    });
  }

  template.push({
    label: 'System',
    submenu: [
      { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: send('menu:open-file') },
      { label: 'Export Package…', accelerator: 'CmdOrCtrl+E', click: send('menu:export-package') },
      { type: 'separator' as const },
      { label: 'Clear Current Job Dir', click: send('menu:clear-job') },
      { label: 'Clear Output Dir…', click: send('menu:clear-output') },
      { type: 'separator' as const },
      { role: 'quit' as const },
    ],
  });

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Help Content',
        click: () => { shell.openExternal('https://leochan007.github.io/swing-analysis/'); },
      },
      { type: 'separator' as const },
      {
        label: '关于 AceCrush Swing-Analysis',
        click: () => ipcMain.emit('menu:about'),
      },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on('menu:about', () => {
  // Re-use the show-about handler logic (so we don't duplicate the
  // dialog message). Inlined as a tiny adapter to avoid the recursive
  // ipcMain.handle pattern.
  const w = BrowserWindow.getFocusedWindow();
  if (!w) return;
  dialog.showMessageBox(w, {
    type: 'info',
    title: '关于 AceCrush Swing-Analysis',
    message: 'AceCrush Swing-Analysis',
    detail: [
      'AceCrush 品牌系列 · 网球挥拍自动切分工具',
      '',
      `版本 ${app.getVersion()}`,
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
      `Chromium ${process.versions.chrome}`,
      '',
      '项目主页: https://github.com/leochan007/swing-analysis',
    ].join('\n'),
    buttons: ['OK'],
    noLink: true,
  });
});

app.whenReady().then(() => {
  buildMenu();
});