import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipInfo, Segment } from '../api/types';
import { ClipGrid } from './ClipGrid';
import { Tooltip } from './Tooltip';
import { toast } from './Toast';
import { useI18n } from '../i18n';

interface Props {
  clips: ClipInfo[];
  segments: Segment[];
  activeClip: ClipInfo | null;
  onSelectClip: (c: ClipInfo) => void;
  onCleanupClips: () => void;
  thumbUrl: (segId: number) => string;
  jobDone: boolean;
  saveClipsEnabled: boolean;
  // Disables the cleanup button while a segmentation job is running
  // (the API would 409 anyway, but greying out the UI is friendlier).
  jobRunning?: boolean;
  // Plan 004 — when the clips panel has been popped out into its own
  // OS window, the docked ClipsBar collapses to a slim placeholder
  // row instead of vanishing entirely (so the layout doesn't reflow).
  detached?: boolean;
  onDetach?: () => void;
  onRecall?: () => void;
}

// Sort clips by seg_id so concurrent annotations that finish out of
// order still render in pipeline order. Without this, the user sees
// e.g. clip #3, #1, #2 — confusing because seg_id is the natural
// "this is the N-th swing" ordering.
function clipsByOrder(clips: ClipInfo[]): ClipInfo[] {
  return clips.slice().sort((a, b) => a.seg_id - b.seg_id);
}

const ICON_BTN: React.CSSProperties = {
  background: 'var(--bg-elev)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
};
const ICON_BTN_DANGER: React.CSSProperties = {
  ...ICON_BTN,
  background: 'var(--danger-bg)',
  color: 'var(--danger)',
  border: '1px solid var(--danger-border)',
};

/**
 * Single-row clips bar — docked only. (The previous 📌 悬浮 in-window
 * float mode was removed: it never escaped the BrowserWindow frame,
 * which was the original user complaint that led to plan 004. The
 * ↗ detach button is now the only way to move clips off the dock.)
 *
 * Buttons are icon-only — full labels live in the `title` tooltip,
 * which `useI18n` translates.
 */
export function ClipsBar({
  clips,
  segments: segs,
  activeClip,
  onSelectClip,
  onCleanupClips,
  thumbUrl,
  jobDone,
  saveClipsEnabled,
  jobRunning,
  detached,
  onDetach,
  onRecall,
}: Props) {
  const { t } = useI18n();
  const barRef = useRef<HTMLDivElement>(null);
  const ordered = useMemo(() => clipsByOrder(clips), [clips]);

  const hasClips = ordered.length > 0;

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
    userSelect: 'none',
  };

  const bodyStyle: React.CSSProperties = {
    background: 'var(--bg-alt)',
    color: 'var(--text)',
    padding: '8px 12px 10px 12px',
    borderTop: '1px solid var(--border)',
    borderRadius: 0,
    // Cap the docked bar height — when cards wrap to many rows the
    // inner overflow:auto grows a vertical scrollbar instead of
    // pushing up the video area.
    maxHeight: 280,
    overflowY: 'auto',
  };

  const headerActions = (
    <>
      {hasClips && (
        // Clicking cleanup while a job is running no longer silently
        // no-ops — it surfaces a toast asking the user to cancel first.
        <Tooltip text={jobRunning ? t('btn.cleanupDisabled') : t('btn.cleanup')}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (jobRunning) {
                toast.warning(t('toast.cleanupCancelFirst'));
              } else {
                onCleanupClips();
              }
            }}
            style={{
              ...ICON_BTN_DANGER,
              cursor: 'pointer',
              opacity: jobRunning ? 0.5 : 1,
              marginRight: 6,
            }}
          >
            🧹
          </button>
        </Tooltip>
      )}
      <Tooltip text={t('btn.detach')}>
        <button
          onClick={(e) => { e.stopPropagation(); onDetach?.(); }}
          style={{ ...ICON_BTN, marginRight: 6 }}
        >
          ↗
        </button>
      </Tooltip>
    </>
  );

  const headerEl = (
    <div style={headerStyle}>
      <h3 style={{ margin: 0, fontSize: 13 }}>
        {t('clips.title')}{hasClips && <span style={{ opacity: 0.6 }}> ({ordered.length})</span>}
      </h3>
      <div onMouseDown={(e) => e.stopPropagation()}>{headerActions}</div>
    </div>
  );

  const gridEl = hasClips ? (
    <ClipGrid
      clips={ordered}
      segments={segs}
      activeClip={activeClip}
      onSelectClip={onSelectClip}
      thumbUrl={thumbUrl}
    />
  ) : (
    <div
      style={{
        opacity: 0.6,
        fontSize: 11,
        padding: '12px 8px',
        border: '1px dashed var(--border)',
        borderRadius: 4,
        textAlign: 'center',
        color: 'var(--text-muted)',
      }}
    >
      {jobDone
        ? (saveClipsEnabled ? t('clips.empty.doneNoSeg') : t('clips.empty.doneNoSave'))
        : (saveClipsEnabled ? t('clips.empty.running') : t('clips.empty.runningNoSave'))}
    </div>
  );

  // Plan 004 — when the clips panel is detached, the docked ClipsBar
  // collapses to a slim placeholder row so the layout stays put and
  // the user has a clear way to recall the panel back to the main
  // window.
  if (detached) {
    return (
      <div
        ref={barRef}
        style={{
          flexShrink: 0,
          background: 'var(--bg-alt)',
          borderTop: '1px solid var(--border)',
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minHeight: 36,
          color: 'var(--text-muted)',
          fontSize: 12,
          userSelect: 'none',
        }}
      >
        <span>{t('clips.detachedPlaceholder')}</span>
        <Tooltip text={t('btn.recall')}>
          <button
            onClick={() => onRecall?.()}
            style={ICON_BTN}
          >
            📍
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div ref={barRef} style={{ ...bodyStyle, flexShrink: 0 }}>
      {headerEl}
      {gridEl}
    </div>
  );
}
