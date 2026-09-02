/**
 * Plan 004 — main-window side of the panel bridge.
 *
 * Subscribes to `panel:action` so the App can react when the user
 * clicks something in a detached panel, and pushes a debounced
 * snapshot to the main process whenever the snapshot reference changes.
 *
 * `closed` actions update the local `panelOpen` flag so the docked
 * UI can flip back from "占位行" to the full component. The remaining
 * actions are forwarded to `onAction` for App.tsx to handle (typically
 * by setting the same React state the docked ClipsBar would have).
 */

import { useEffect, useRef, useState } from 'react';
import type { PanelAction, PanelStateSnapshot, PanelKind } from '../api/panels';

export interface PanelOpenState { clips: boolean; log: boolean; }

const EMPTY_OPEN: PanelOpenState = { clips: false, log: false };

export function usePanelSync(
  snapshot: PanelStateSnapshot,
  onAction?: (a: PanelAction) => void,
): { panelOpen: PanelOpenState } {
  const [panelOpen, setPanelOpen] = useState<PanelOpenState>(EMPTY_OPEN);
  // Keep the latest onAction in a ref so the IPC subscription doesn't
  // need to re-attach when the parent re-renders with a new closure.
  const actionRef = useRef(onAction);
  useEffect(() => { actionRef.current = onAction; }, [onAction]);

  useEffect(() => {
    if (!window.api?.onPanelAction) return;
    const off = window.api.onPanelAction((a) => {
      if (a && a.type === 'closed') {
        const k = (a as { kind: PanelKind }).kind;
        setPanelOpen((p) => ({ ...p, [k]: false }));
        return;
      }
      actionRef.current?.(a);
    });
    return () => off();
  }, []);

  useEffect(() => {
    // Initial pull — covers the case where the user re-opens the app
    // with a panel already open (e.g. panel crashed and was re-spawned
    // by HMR, or panel survived a renderer reload).
    if (window.api?.panelIsOpen) {
      window.api.panelIsOpen()
        .then((s) => { if (s) setPanelOpen(s); })
        .catch(() => { /* ignore */ });
    }
  }, []);

  useEffect(() => {
    if (!window.api?.pushPanelState) return;
    // 100ms trailing debounce — collapses bursts of pose.progress
    // updates into a single snapshot push. The snapshot itself is
    // already a stable reference (App.tsx wraps it in useMemo), so we
    // only push when its identity changes.
    let timer: ReturnType<typeof setTimeout> | null = null;
    timer = setTimeout(() => {
      try { window.api.pushPanelState(snapshot); } catch { /* */ }
    }, 100);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [snapshot]);

  return { panelOpen };
}
