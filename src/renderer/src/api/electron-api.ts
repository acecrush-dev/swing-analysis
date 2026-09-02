/**
 * Central declaration of the `window.api` surface that preload exposes
 * via contextBridge. Side-effect-only import: by importing this file
 * the App / panel apps get the global `window.api` typed everywhere
 * without each component redeclaring the interface.
 *
 * The shape here is what the renderer promises to call; the actual
 * runtime impl lives in src/preload/index.ts. Both sides MUST stay in
 * sync — adding a method here without adding it in the preload is a
 * silent runtime null-deref, not a compile error.
 */

import type { PanelKind, PanelStateSnapshot, PanelAction } from './panels';

declare global {
  interface Window {
    api: {
      pickVideo: () => Promise<string | null>;
      getServiceInfo: () => Promise<string | null>;
      getDroppedFilePath: (file: File) => string;
      exportPackage: (jobId: string | null) => Promise<{ ok: boolean; path?: string; error?: string }>;
      openExternal: (url: string) => Promise<boolean>;
      openOutputDir: (jobId: string) => Promise<{ ok: true; path: string } | { ok: false; error: string }>;
      showAbout: () => Promise<void>;
      onMenuEvent: (channel: string, cb: () => void) => () => void;

      // ── plan 004: F12-style detachable panels ──────────────────
      openPanel: (kind: PanelKind) => Promise<{ ok: boolean; error?: string }>;
      closePanel: (kind: PanelKind) => Promise<{ ok: boolean }>;
      panelIsOpen: () => Promise<{ clips: boolean; log: boolean }>;
      getPanelState: () => Promise<PanelStateSnapshot | null>;
      pushPanelState: (snap: PanelStateSnapshot) => void;
      sendPanelAction: (action: PanelAction) => void;
      onPanelState: (cb: (s: PanelStateSnapshot) => void) => () => void;
      onPanelAction: (cb: (a: PanelAction) => void) => () => void;

      // ── menu: clear output dir ────────────────────────────────
      clearOutputDir: () => Promise<
        { ok: true; path: string; deleted_count: number; cleared_job_ids: string[] }
        | { ok: false; error: string }
      >;

      // ── settings: jobs output dir ─────────────────────────────
      getSettings: () => Promise<{
        output_dir: string;                    // active this session
        default_output_dir: string;            // built-in default
        configured_output_dir: string | null;  // null = using default
      }>;
      setOutputDir: (dir: string | null) => Promise<
        { ok: true; output_dir: string } | { ok: false; error: string }
      >;
      pickOutputDir: () => Promise<
        { ok: true; path: string | null } | { ok: false; error: string }
      >;
    };
  }
}

// Side-effect-only: ensures the file is treated as a module so the
// `declare global` block is honoured. No exports needed.
export {};
