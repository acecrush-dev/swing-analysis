/**
 * Plan 004 — usePanelSnapshot
 *
 * Single entry point for panel windows to subscribe to the state
 * snapshot pushed by the main window. Combines two paths so the
 * panel never sees an empty frame:
 *
 *   1. On mount, invoke `getPanelState()` to fetch the latest cached
 *      snapshot (panel may have opened between two push cycles, or
 *      did-finish-load may have fired before we attached the IPC
 *      listener).
 *   2. Subscribe to `onPanelState` for subsequent pushes.
 *
 * Returns null until the first snapshot arrives; callers render a
 * "⏳ 等待主窗口状态…" placeholder during that brief window.
 */

import { useEffect, useState } from 'react';
import type { PanelStateSnapshot } from '../../api/panels';
import { useTheme } from '../../hooks/theme';

export function usePanelSnapshot(): PanelStateSnapshot | null {
  const [snap, setSnap] = useState<PanelStateSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Initial pull — covers the case where the panel window is freshly
    // opened and we haven't received a push yet.
    if (window.api?.getPanelState) {
      window.api.getPanelState()
        .then((s) => {
          if (cancelled) return;
          if (s) setSnap(s as PanelStateSnapshot);
        })
        .catch(() => { /* ignore — placeholder will keep showing */ });
    }
    // Subscribe to subsequent pushes.
    const off = window.api?.onPanelState
      ? window.api.onPanelState((s) => { if (!cancelled) setSnap(s); })
      : () => {};
    return () => { cancelled = true; off(); };
  }, []);

  return snap;
}

/**
 * Push the snapshot's theme into the panel's own ThemeProvider. The
 * ThemeProvider applies CSS variables to *its own document*, so we
 * need to mirror the main window's theme here rather than trying to
 * share state via IPC.
 */
export function usePanelTheme(snap: PanelStateSnapshot | null): void {
  const { setTheme } = useTheme();
  useEffect(() => {
    if (snap && snap.theme) setTheme(snap.theme);
  }, [snap?.theme, setTheme]);
}
