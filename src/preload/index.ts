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
  exportPackage: (jobId: string | null, callId: string) =>
    ipcRenderer.invoke('export-package', jobId, callId) as Promise<ExportResult>,
  openExternal: (url: string) =>
    ipcRenderer.invoke('open-external', url) as Promise<boolean>,
  openOutputDir: (jobId: string, callId: string) =>
    ipcRenderer.invoke('open-output-dir', jobId, callId) as Promise<
      { ok: true; path: string } | { ok: false; error: string }
    >,
  showAbout: () => ipcRenderer.invoke('show-about') as Promise<void>,
  clearOutputDir: (callId: string) => ipcRenderer.invoke('clear-output-dir', {}, callId) as Promise<
    { ok: true; path: string; deleted_count: number; cleared_job_ids: string[] }
    | { ok: false; error: string }
  >,

  // Plan 005 — new IPC for the Cleanup button on the ClipsBar; the
  // callId-cancel is forwarded to the sidecar fetch so the user can
  // 取消 mid-delete.
  cleanupClips: (jobId: string, callId: string) =>
    ipcRenderer.invoke('cleanup-clips', { jobId }, callId) as Promise<
      { ok: true } | { ok: false; error: string }
    >,

  // Plan 005 — renderer's 取消 button triggers this. Fire-and-forget
  // (ipcRenderer.send, not invoke) — we don't care about the result.
  cancelCall: (callId: string) => { ipcRenderer.send('cancel-call', callId); },

  // Plan 005 — embed app icon in the BusyModal. Returns a base64 PNG
  // data URL (or null if no icon found — caller falls back to emoji).
  getIconDataUrl: () => ipcRenderer.invoke('app:get-icon-data-url') as Promise<string | null>,
  onMenuEvent: (channel: string, cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // ── settings: jobs output dir ──────────────────────────────────
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<{
    output_dir: string;
    default_output_dir: string;
    configured_output_dir: string | null;
  }>,
  setOutputDir: (dir: string | null) =>
    ipcRenderer.invoke('settings:set-output-dir', dir) as Promise<
      { ok: true; output_dir: string } | { ok: false; error: string }
    >,
  pickOutputDir: () =>
    ipcRenderer.invoke('settings:pick-output-dir') as Promise<
      { ok: true; path: string | null } | { ok: false; error: string }
    >,

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

  // ── splash screen: live sidecar log + status stream ───────────
  // Used by the splash renderer (src/renderer/splash.tsx) to draw the
  // model-loading progress + log feed while the sidecar warms up.
  // `onSidecarLog` fires per stderr line (one print per model state
  // transition, prefixed `[model]`); `onSidecarStatus` fires on every
  // 500 ms poll of /api/status until the splash closes.
  onSidecarLog: (cb: (line: string) => void) => {
    const handler = (_e: unknown, line: string) => cb(line);
    ipcRenderer.on('sidecar:log', handler);
    return () => ipcRenderer.removeListener('sidecar:log', handler);
  },
  onSidecarStatus: (cb: (snap: unknown) => void) => {
    const handler = (_e: unknown, snap: unknown) => cb(snap);
    ipcRenderer.on('sidecar:status', handler);
    return () => ipcRenderer.removeListener('sidecar:status', handler);
  },
});