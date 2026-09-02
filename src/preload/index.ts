import { contextBridge, ipcRenderer, webUtils } from 'electron';

export type ExportResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

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
  showAbout: () => ipcRenderer.invoke('show-about') as Promise<void>,
  onMenuEvent: (channel: string, cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});