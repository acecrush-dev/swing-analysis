/**
 * Plan 004 — wire types for the F12-style detachable panels (clips
 * list + event log). The schema mirrors what `App.tsx` already keeps
 * in React state; the snapshot is the same shape just with the
 * `theme` added so the panel can pick the right CSS variables
 * immediately on first paint.
 *
 * Kept as a single source of truth so the App-side emitter and the
 * panel-side subscriber agree on field names without each side having
 * to mirror the other.
 */

import type {
  ClipInfo,
  ClipProcessingState,
  JobParams,
  Segment,
} from './types';
import type { BusyState } from '../busy';

export type PanelKind = 'clips' | 'log';

export type Theme = 'dark' | 'light';

/**
 * Full state snapshot broadcast from the main window to all open
 * panels. Fields are a superset of what each panel actually consumes;
 * ClipsPanelApp ignores `logLines`, LogPanelApp ignores `clips`, etc.
 */
export interface PanelStateSnapshot {
  theme: Theme;
  baseUrl: string | null;
  jobId: string | null;
  videoPath: string | null;
  jobState: 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  saveClipsEnabled: boolean;
  clips: ClipInfo[];
  segments: Segment[];
  activeClip: ClipInfo | null;
  clipProc: Record<number, ClipProcessingState>;
  logLines: string[];
  // Reserved for future panels; keeping it here so we don't have to
  // rev the IPC shape the moment we want to add, say, a settings panel.
  params?: JobParams;
  // Plan 005 — null/undefined means "main window is idle, panel is
  // interactive"; non-null means "main window is running a long op,
  // panel should dim + intercept clicks". undefined (vs null) is
  // tolerated for older renderer builds that push a snapshot without
  // this field.
  busy?: BusyState | null;
}

/**
 * Actions sent from a panel window BACK to the main window. Discrim-
 * inated union — the actionSink in src/main/panels.ts forwards these
 * unchanged and the App.tsx handler narrows on `type`.
 */
export type PanelAction =
  | { type: 'closed'; kind: PanelKind }
  | { type: 'select-clip'; seg_id: number }
  | { type: 'clear-log' }
  | { type: 'cleanup-clips' };
