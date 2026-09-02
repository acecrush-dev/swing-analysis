/**
 * Plan 005 — callId-cancel registry for the 4 long-running IPC ops
 * (export-package / clear-output-dir / cleanup-clips / open-output-dir).
 *
 * Each handler creates an `AbortController`, registers it under the
 * callId the renderer passed in, and forwards `ac.signal.aborted`
 * into whatever the underlying work is doing. The renderer's 取消
 * button calls `window.api.cancelCall(callId)`, which sends a
 * `cancel-call` IPC over to `abortCall` here.
 *
 * One registry, all four ops — they're mutually exclusive (the busy
 * modal only allows one at a time), so a single Map is enough.
 */

const inflight = new Map<string, AbortController>();

/**
 * Mint a fresh callId. Uses `crypto.randomUUID()` which is available
 * globally in Node 19+; falls back to a Math.random()-based id for
 * very old runtimes (Electron 22 ships Node 16, but the packaged
 * app has been on Electron 32+ for a while — still, the fallback
 * is harmless if it ever fires).
 */
export function newCallId(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = (globalThis as any).crypto;
    if (c && typeof c.randomUUID === 'function') {
      return `busy-${c.randomUUID()}`;
    }
  } catch {
    /* fall through */
  }
  return `busy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create + register; the controller lives until unregisterCall fires. */
export function registerCall(callId: string): AbortController {
  const ac = new AbortController();
  inflight.set(callId, ac);
  return ac;
}

/** Drop the entry from the registry. Idempotent. */
export function unregisterCall(callId: string): void {
  inflight.delete(callId);
}

/**
 * Trigger the AbortController for `callId`. Returns true if there
 * was an entry to cancel — false means the call already finished
 * (or never existed), in which case the second 取消 click is a no-op.
 */
export function abortCall(callId: string): boolean {
  const ac = inflight.get(callId);
  if (!ac) return false;
  try { ac.abort(); } catch { /* ignore */ }
  return true;
}

/** Used by `app.on('before-quit', ...)` — wipe everything in flight. */
export function cancelAllInflight(): void {
  for (const ac of inflight.values()) {
    try { ac.abort(); } catch { /* ignore */ }
  }
  inflight.clear();
}