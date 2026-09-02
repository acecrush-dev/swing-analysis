import { contextBridge, ipcRenderer, webUtils } from 'electron';

export type ExportResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// Plan 004 — F12-style detachable panels.
// The shape of these payloads (snapshot / action) is defined in the
// renderer at src/renderer/src/api/panels.ts. The preload boundary
// keeps them loosely typed because we're not bundling any new
// runtime deps; the renderer side does the narrowing.

contextBridge.exposeInMainWorld('api', {
  pickVideo: () => ipcRenderer.invoke('pick-video') as Promise<string | null>,
  getServiceInfo: () => ipcRenderer.invoke('get-service-info') as Promise<string | null>,
  // Drag-and-drop helper — Electron 32+ removed `File.path` for security,
  // so we have to go through webUtils.getPathForFile in the preload
  // context to recover the absolute path that the user actually dropped.
  getDroppedFilePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // Fallback for older Electron builds
      return (file as any).path ?? '';
    }
  },
  exportPackage: (jobId: string | null) =>
    ipcRenderer.invoke('export-package', jobId) as Promise<ExportResult>,
  openExternal: (url: string) =>
    ipcRenderer.invoke('open-external', url) as Promise<boolean>,
  openOutputDir: (jobId: string) =>
    ipcRenderer.invoke('open-output-dir', jobId) as Promise<
      { ok: true; path: string } | { ok: false; error: string }
    >,
  showAbout: () => ipcRenderer.invoke('show-about') as Promise<void>,
  clearOutputDir: () => ipcRenderer.invoke('clear-output-dir') as Promise<
    { ok: true; path: string; deleted_count: number; cleared_job_ids: string[] }
    | { ok: false; error: string }
  >,
  onMenuEvent: (channel: string, cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // ── plan 004: panel windows ────────────────────────────────────
  openPanel: (kind: 'clips' | 'log') =>
    ipcRenderer.invoke('panel:open', kind) as Promise<{ ok: boolean; error?: string }>,
  closePanel: (kind: 'clips' | 'log') =>
    ipcRenderer.invoke('panel:close', kind) as Promise<{ ok: boolean }>,
  panelIsOpen: () => ipcRenderer.invoke('panel:is-open') as Promise<{ clips: boolean; log: boolean }>,
  getPanelState: () => ipcRenderer.invoke('panel:get-state') as Promise<unknown>,
  pushPanelState: (snap: unknown) => { ipcRenderer.send('panel:push-state', snap); },
  sendPanelAction: (action: unknown) => { ipcRenderer.send('panel:action-request', action); },
  onPanelState: (cb: (s: unknown) => void) => {
    const handler = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('panel:state', handler);
    return () => ipcRenderer.removeListener('panel:state', handler);
  },
  onPanelAction: (cb: (a: unknown) => void) => {
    const handler = (_e: unknown, a: unknown) => cb(a);
    ipcRenderer.on('panel:action', handler);
    return () => ipcRenderer.removeListener('panel:action', handler);
  },
});