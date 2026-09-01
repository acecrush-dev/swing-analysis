import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join } from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';

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
    return { host: u.hostname, port: Number(u.port), url: url.replace(/\/$/, '') };
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