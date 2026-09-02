import type { ClipProcessingState } from '../api/types';

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

const STAGE_LABEL: Record<ClipProcessingState['stage'], string> = {
  rtmdet: 'RTMDet 检测',
  pose: '姿态骨架',
  'rtmdet+pose': 'RTMDet+姿态',
};

/**
 * Progress strip. plan 003 adds two optional rows under the main one:
 *   1. Outer queue row   — `🎬 clips x/y 已完成` (done / discovered)
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
          <button onClick={onStart} disabled={disabled} style={{
            padding: '4px 12px', fontSize: 13,
            background: 'var(--bg-elev)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer',
          }}>▶ 开始切分</button>
        ) : (
          <button onClick={onCancel} style={{
            padding: '4px 12px', fontSize: 13,
            background: 'var(--bg-elev)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
          }}>⏹ 取消</button>
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
          {stateLabel(state)}
        </span>
        <span style={{ flex: 1, fontSize: 12, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, color: 'var(--text)' }}>
          <span style={{ flexShrink: 0 }}>
            {progress
              ? `${progress.frames}/${progress.total} (${pct.toFixed(1)}%) · ${progress.fps.toFixed(1)} fps · ETA ${eta} · 在线 segments=${segCount}`
              : state === 'done'
                ? `已完成 · 共 ${segments} 段`
                : '等待开始…'}
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
                  ? `🎬 clips ${done}/${discovered} 已完成${innerEntries.length > 0 ? ` · 处理中 ${innerEntries.map((e) => '#' + e.seg_id).join(' ')}` : ''}`
                  : '🎬 等待切出 clip…'}
              </span>
              <span style={{ flex: 1, height: 4, background: 'var(--bg-elev)', borderRadius: 2, overflow: 'hidden', minWidth: 60 }}>
                <span style={{ display: 'block', width: `${queuePct}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
              </span>
            </span>
          </div>

          {/* Row 3..N — one row per clip currently annotating. */}
          {innerEntries.map((entry) => {
            const labelText = `clip #${entry.seg_id} · ${STAGE_LABEL[entry.stage]} · ${
              entry.total > 0 ? `${entry.frame}/${entry.total} 帧` : `已处理 ${entry.frame} 帧`
            }${entry.total > 0 && entry.frame >= entry.total ? ' · 收尾中…' : ''}`;
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
function stateLabel(s: Props['state']): string {
  return { idle: '空闲', queued: '排队中', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' }[s];
}
