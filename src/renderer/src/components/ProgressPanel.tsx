interface Props {
  state: 'idle'|'queued'|'running'|'done'|'failed'|'cancelled';
  progress: { frames: number; total: number; fps: number; eta_sec: number | null; segments_emitted: number } | null;
  segments: number;
  onStart: () => void;
  onCancel: () => void;
  disabled: boolean;
}

/**
 * One-line compact progress strip. Uses theme vars for every color so
 * it stays legible in both dark and light modes (incl. the state badge
 * which has dedicated bg + fg pairs in the theme).
 */
export function ProgressPanel({ state, progress, segments, onStart, onCancel, disabled }: Props) {
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
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
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