/**
 * Plan 004 — detached clips panel app.
 *
 * Subscribes to the main window's state snapshot and renders the same
 * clip grid the docked ClipsBar uses, with the panel-specific header
 * (cleanup + recall buttons). Clicking a card sends a `select-clip`
 * action back to the main window instead of mutating local state.
 *
 * Clips are sorted by seg_id at the consumer side so concurrent
 * annotations that finish out of order still render in pipeline order.
 */

import { useMemo } from 'react';
import { SwingClient } from '../../api/client';
import type { ClipInfo } from '../../api/types';
import { ClipGrid } from '../ClipGrid';
import { useI18n } from '../../i18n';
import { usePanelSnapshot, usePanelTheme } from './usePanelSnapshot';

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

export function ClipsPanelApp() {
  const { t } = useI18n();
  const snap = usePanelSnapshot();
  usePanelTheme(snap);

  const client = useMemo(
    () => snap?.baseUrl ? new SwingClient(snap.baseUrl) : null,
    [snap?.baseUrl],
  );

  if (!snap) {
    return <Placeholder message="⏳ Waiting for main window state…" />;
  }

  const { jobId, clips, segments, activeClip, jobState, saveClipsEnabled } = snap;
  const ordered = useMemo(() => clipsByOrder(clips), [clips]);
  const hasClips = ordered.length > 0;
  const jobDone = jobState === 'done' || jobState === 'failed' || jobState === 'cancelled';
  const jobRunning = jobState === 'running' || jobState === 'queued';
  const thumbUrl = (segId: number) =>
    client && jobId ? client.clipThumbUrl(jobId, segId) : '';

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: 'system-ui',
        padding: 12,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8, userSelect: 'none',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13 }}>
          {t('clips.title')}{hasClips && <span style={{ opacity: 0.6 }}> ({ordered.length})</span>}
        </h3>
        <div style={{ display: 'flex', gap: 6 }}>
          {hasClips && (
            <button
              onClick={() => window.api?.sendPanelAction?.({ type: 'cleanup-clips' })}
              disabled={!!jobRunning}
              title={jobRunning ? t('btn.cleanupDisabled') : t('btn.cleanup')}
              style={{
                ...ICON_BTN_DANGER,
                cursor: jobRunning ? 'not-allowed' : 'pointer',
                opacity: jobRunning ? 0.5 : 1,
              }}
            >
              🧹
            </button>
          )}
          <button
            onClick={() => window.api?.closePanel?.('clips')}
            title={t('btn.recall')}
            style={ICON_BTN}
          >
            📍
          </button>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {hasClips ? (
          <ClipGrid
            clips={ordered}
            segments={segments}
            activeClip={activeClip}
            onSelectClip={(c: ClipInfo) =>
              window.api?.sendPanelAction?.({ type: 'select-clip', seg_id: c.seg_id })
            }
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
        )}
      </div>
    </div>
  );
}

function Placeholder({ message }: { message: string }) {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', fontFamily: 'system-ui', fontSize: 13,
    }}>
      {message}
    </div>
  );
}
