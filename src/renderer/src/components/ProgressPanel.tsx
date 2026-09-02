import type { ClipProcessingState } from '../api/types';
import { useI18n } from '../i18n';
import { Tooltip } from './Tooltip';

interface Props {
  state: 'idle'|'queued'|'running'|'done'|'failed'|'cancelled';
  progress: { frames: number; total: number; fps: number; eta_sec: number | null; segments_emitted: number } | null;
  segments: number;
  onStart: () => void;
  onCancel: () => void;
  disabled: boolean;
  // plan 003 — dual clip progress bars. All optional so legacy callers
  // (or future tests) can omit them and see the single-line layout.
  clipBarsEnabled?: boolean;
  clipsDone?: number;
  clipsDiscovered?: number;
  clipProcessing?: Record<number, ClipProcessingState>;
}

/**
 * Progress strip. plan 003 adds two optional rows under the main one:
 *   1. Outer queue row   — `🎬 clips x/y done` (done / discovered)
 *   2. Inner clip rows   — at most `max_workers=2` rows, one per clip
 *                          currently in `clip.annotate_clip`, with a
 *                          frame counter and 4px progress strip.
 *
 * Both rows render ONLY when (a) the user enabled `clipBarsEnabled`, AND
 * (b) the job is running OR there are leftover entries in `clipProcessing`.
 * If the user clears both annotation flags, the panel renders the legacy
 * single-line strip with zero behavioural change.
 */
export function ProgressPanel({
  state, progress, segments,
  onStart, onCancel, disabled,
  clipBarsEnabled, clipsDone, clipsDiscovered, clipProcessing,
}: Props) {
  const { t } = useI18n();
  const pct = progress && progress.total > 0 ? (100 * progress.frames / progress.total) : 0;
  const eta = (() => {
    if (!progress?.eta_sec && progress?.eta_sec !== 0) return '--:--';
    const s = Math.round(progress.eta_sec);
    if (s < 3600) return `${Math.floor(s/60)}:${s%60 < 10 ? '0' : ''}${s%60}`;
    return `${Math.floor(s/3600)}:${Math.floor((s%3600)/60)}:${s%60 < 10 ? '0' : ''}${s%60}`;
  })();
  const segCount = progress?.segments_emitted ?? segments;
  const bg = stateBg(state);
  const fg = stateFg(state);

  // plan 003 — show clip bars when (running and enabled) or there are
  // live entries from the previous run still draining in.
  const innerEntries = clipProcessing
    ? Object.values(clipProcessing).sort((a, b) => a.seg_id - b.seg_id)
    : [];
  const showClipBars = !!clipBarsEnabled && (
    state === 'running' || innerEntries.length > 0
  );
  const done = clipsDone ?? 0;
  const discovered = clipsDiscovered ?? 0;
  const queuePct = discovered > 0 ? (100 * done / discovered) : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10 }}>
      {/* Row 1 — the original progress strip, byte-identical to the
          pre-plan-003 layout when no clip flags are on. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {state === 'idle' || state === 'done' || state === 'failed' || state === 'cancelled' ? (
          <Tooltip text={disabled ? t('progress.startDisabled') : t('progress.start')}>
            <button onClick={onStart} disabled={disabled} style={{
              padding: '4px 12px', fontSize: 13,
              background: 'var(--bg-elev)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer',
            }}>{t('progress.start')}</button>
          </Tooltip>
        ) : (
          // Cancel button — distinct danger style so it's obviously
          // clickable. The button has never been `disabled` during run
          // state; this just makes it visually unmissable.
          <Tooltip text={t('progress.cancelTip')}>
            <button onClick={onCancel} style={{
              padding: '4px 12px', fontSize: 13,
              background: 'var(--danger-bg)', color: 'var(--danger)',
              border: '1px solid var(--danger-border)', borderRadius: 4,
              cursor: 'pointer', fontWeight: 'bold',
            }}>{t('progress.cancel')}</button>
          </Tooltip>
        )}
        <span
          style={{
            padding: '2px 8px',
            background: bg,
            color: fg,
            borderRadius: 3,
            fontSize: 12,
            fontWeight: 'bold',
          }}
        >
          {stateLabel(state, t)}
        </span>
        <span style={{ flex: 1, fontSize: 12, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: 'var(--text)' }}>
          <span style={{ flexShrink: 0 }}>
            {progress
              ? `${progress.frames}/${progress.total} (${pct.toFixed(1)}%) · ${progress.fps.toFixed(1)} fps · ETA ${eta} · ${t('progress.segments', { n: segCount })}`
              : state === 'done'
                ? t('progress.doneFmt', { n: segments })
                : t('progress.waiting')}
          </span>
          <span style={{ flex: 1, height: 4, background: 'var(--bg-elev)', borderRadius: 2, overflow: 'hidden', minWidth: 60 }}>
            <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--success)', transition: 'width 0.2s' }} />
          </span>
        </span>
      </div>

      {showClipBars && (
        <>
          {/* Row 2 — outer queue bar (done / discovered). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 0 }}>
            <span style={{ flex: 1, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: 'var(--text)' }}>
              <span style={{ flexShrink: 0 }}>
                {discovered > 0
                  ? `${t('progress.queue', { done, discovered })}${innerEntries.length > 0 ? ` · ${t('progress.processingFmt', { ids: innerEntries.map((e) => '#' + e.seg_id).join(' ') })}` : ''}`
                  : t('progress.waitingClip')}
              </span>
              <span style={{ flex: 1, height: 4, background: 'var(--bg-elev)', borderRadius: 2, overflow: 'hidden', minWidth: 60 }}>
                <span style={{ display: 'block', width: `${queuePct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
              </span>
            </span>
          </div>

          {/* Row 3..N — one row per clip currently annotating. */}
          {innerEntries.map((entry) => {
            const labelText = t('progress.annotating', {
              id: entry.seg_id,
              stage: t('progress.stage.' + entry.stage),
              frame: entry.frame,
              total: entry.total,
            });
            const innerPct = entry.total > 0 ? (100 * entry.frame / entry.total) : 0;
            return (
              <div key={entry.seg_id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: 'var(--text)' }}>
                  <span style={{ flexShrink: 0 }}>{labelText}</span>
                  <span style={{ flex: 1, height: 4, background: 'var(--bg-elev)', borderRadius: 2, overflow: 'hidden', minWidth: 60 }}>
                    <span style={{ display: 'block', width: `${innerPct}%`, height: '100%', background: 'var(--warn)', transition: 'width 0.2s' }} />
                  </span>
                </span>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

// bg + fg are separate so the badge can stay legible in light mode
// (dark-mode `#444` is invisible on white).
function stateBg(s: Props['state']): string {
  return {
    idle:      'var(--state-idle-bg)',
    queued:    'var(--state-queued-bg)',
    running:   'var(--state-running-bg)',
    done:      'var(--state-done-bg)',
    failed:    'var(--state-failed-bg)',
    cancelled: 'var(--state-cancelled-bg)',
  }[s];
}
function stateFg(s: Props['state']): string {
  return {
    idle:      'var(--state-idle-fg)',
    queued:    'var(--state-queued-fg)',
    running:   'var(--state-running-fg)',
    done:      'var(--state-done-fg)',
    failed:    'var(--state-failed-fg)',
    cancelled: 'var(--state-cancelled-fg)',
  }[s];
}
function stateLabel(s: Props['state'], t: (k: string) => string): string {
  return t('state.' + s);
}
