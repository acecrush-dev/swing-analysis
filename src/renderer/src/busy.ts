/**
 * Plan 005 — BusyModal coordinator.
 *
 * The App owns the `busy` state via React `useState`; this module
 * just bridges the imperative "start a busy op" callsite API to that
 * setter without making the callsites aware of React internals.
 *
 * Usage from App.tsx:
 *
 *   useEffect(() => { busy.setBusyCallback(setBusy); }, []);
 *   ...
 *   const handle = busy.startBusy('export-package', t('busy.title.export-package'));
 *   const res = await window.api.exportPackage(jobId, handle.callId);
 *   handle.finish(res.ok, res.error && res.error !== 'cancelled' ? t('busy.fail', { err: res.error }) : undefined);
 *
 * The handle also exposes `setStatus(s)` if a callsite wants to surface
 * mid-op progress text (currently unused — the modal just shows
 * "Preparing…" while the op runs).
 *
 * On finish with ok=false and errMsg given, a toast.error fires
 * automatically (same UX pattern the WS `job.failed` handler uses).
 */

import type { BusyKind } from './api/busy-types';

export type BusyState = {
  kind: BusyKind;
  title: string;
  status: string;
  callId: string;
};

type SetBusyFn = (
  b: BusyState | null | ((b: BusyState | null) => BusyState | null)
) => void;

let setter: SetBusyFn = () => {};

export function setBusyCallback(fn: SetBusyFn): void {
  setter = fn;
}

export interface BusyHandle {
  callId: string;
  setStatus(s: string): void;
  /**
   * Called when the IPC resolves/rejects.
   * - ok=true → modal closes silently.
   * - ok=false with errMsg → modal closes + toast.error(errMsg) fires.
   * - ok=false WITHOUT errMsg (e.g. cancelled) → modal closes silently.
   */
  finish(ok: boolean, errMsg?: string): void;
}

export function startBusy(kind: BusyKind, title: string): BusyHandle {
  const callId = `busy-${newCallId()}`;
  const initial: BusyState = { kind, title, status: '', callId };
  setter(initial);
  return {
    callId,
    setStatus: (s: string) =>
      setter((b) => (b && b.callId === callId ? { ...b, status: s } : b)),
    finish: (ok: boolean, errMsg?: string) =>
      setter((b) => {
        if (!b || b.callId !== callId) return b;
        if (!ok && errMsg) {
          // Lazy import so this module stays side-effect-free at parse time
          // (and the toast module can be loaded after Electron's preload
          // exposes window.api in the renderer).
          void import('./components/Toast').then(({ toast }) => toast.error(errMsg));
        }
        return null;
      }),
  };
}

/**
 * Renderer's copy of `busy.newCallId`. Kept local so the renderer
 * never has to round-trip to the main process for the id (it's just
 * a UUID; collision odds are negligible).
 */
function newCallId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = (globalThis as any).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}