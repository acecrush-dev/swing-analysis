import { app, BrowserWindow, ipcMain, dialog, shell, Menu, MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, statSync, createWriteStream } from 'node:fs';
// archiver ships with its own JS; no bundled types so we require it
// dynamically and treat as any.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver: any = require('archiver');

interface ServiceInfo { host: string; port: number; url: string; }

class PythonSidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private info: ServiceInfo | null = null;
  private pythonBin: string;

  constructor(pythonBin: string) { this.pythonBin = pythonBin; }

  baseUrl(): string | null { return this.info?.url ?? null; }

  async start(timeoutMs = 15000): Promise<ServiceInfo> {
    if (this.info) return this.info;
    if (process.env.SWING_SERVICE_URL) {
      this.info = this.parseUrl(process.env.SWING_SERVICE_URL);
      console.log('[sidecar] attach to', this.info.url);
      return this.info;
    }
    const repoRoot = join(__dirname, '..', '..');
    const args = ['-m', 'backend.service', '--port', '0',
                  '--data-dir', join(repoRoot, 'backend', 'data')];
    console.log('[sidecar] spawning:', this.pythonBin, args.join(' '));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new Error('sidecar 启动超时 (15s)'));
      }, timeoutMs);
      this.proc = spawn(this.pythonBin, args, { cwd: repoRoot });
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
    if (this.proc && !this.proc.killed) {
      try { process.kill(-this.proc.pid); } catch {}
      try { this.proc.kill(); } catch {}
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
const candidates = [
  join(repoRoot, 'backend', '.venv', 'bin', 'python3'),
  join(repoRoot, 'backend', '.venv', 'bin', 'python'),
];
const pythonBin = candidates.find(existsSync) ?? 'python3';

const sidecar = new PythonSidecar(pythonBin);

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
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => sidecar.kill());
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
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

// Pack the current job's output dir (segments.json + clips + viz.mp4)
// into a single zip the user can hand off. Done in the main process so
// the renderer doesn't need direct fs access.
ipcMain.handle('export-package', async (_evt, jobId: string | null) => {
  if (!jobId) return { ok: false, error: 'no active job' };
  const jobDir = join(app.getPath('userData'), '..', '..', 'backend', 'data', 'jobs', jobId);
  // Fallback: try several known roots since dev / packaged layouts differ
  const candidates = [
    jobDir,
    join(process.cwd(), 'backend', 'data', 'jobs', jobId),
  ];
  let resolved: string | null = null;
  for (const p of candidates) {
    try { if (existsSync(p)) { resolved = p; break; } } catch { /* */ }
  }
  if (!resolved) return { ok: false, error: 'job 不存在或已删除' };

  const save = await dialog.showSaveDialog({
    title: '导出 job 包',
    defaultPath: `swing-${jobId}.zip`,
    filters: [{ name: 'zip', extensions: ['zip'] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, error: 'cancelled' };

  return await new Promise<{ ok: boolean; path?: string; error?: string }>((resolve) => {
    const out = createWriteStream(save.filePath!);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', () => resolve({ ok: true, path: save.filePath! }));
    out.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
    archive.on('error', (e: Error) => resolve({ ok: false, error: e.message }));
    archive.pipe(out);
    archive.directory(resolved!, jobId);
    archive.final();
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
    title: 'About swing-analysis',
    message: 'swing-analysis',
    detail: [
      `版本 ${app.getVersion()}`,
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
      `Chromium ${process.versions.chrome}`,
      '',
      '网球挥拍自动切分工具 — 算法核心 vendored 在 backend/core/',
      '项目主页: https://github.com/leochan007/swing-analysis',
    ].join('\n'),
    buttons: ['OK'],
    noLink: true,
  });
});

// Build the application menu. Exactly two top-level menus — System
// (Open File / Export Package / Exit) and Help (docs link / About).
// Per the user's M24 spec: no Edit, no View, no Window.
//
// On macOS the FIRST menu in the template is auto-promoted to the App
// menu (label becomes the app name; system fills in About/Hide/Quit
// etc.) — that would silently rename our "System" menu to
// "swing-analysis" and hide it. So on macOS we prepend an explicit
// App menu that carries those roles; System then becomes the second
// menu in the bar and keeps its label.
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
        label: 'About swing-analysis',
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
    title: 'About swing-analysis',
    message: 'swing-analysis',
    detail: [
      `版本 ${app.getVersion()}`,
      `Electron ${process.versions.electron}`,
      `Node ${process.versions.node}`,
      `Chromium ${process.versions.chrome}`,
      '',
      '网球挥拍自动切分工具 — 算法核心 vendored 在 backend/core/',
      '项目主页: https://github.com/leochan007/swing-analysis',
    ].join('\n'),
    buttons: ['OK'],
    noLink: true,
  });
});

app.whenReady().then(() => {
  buildMenu();
});