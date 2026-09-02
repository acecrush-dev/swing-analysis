interface Props {
  state: 'idle'|'queued'|'running'|'done'|'failed'|'cancelled';
  progress: { frames: number; total: number; fps: number; eta_sec: number | null; segments_emitted: number } | null;
  segments: number;
  onStart: () => void;
  onCancel: () => void;
  disabled: boolean;
}

/**
 * One-line compact progress strip. Replaces the old 3-row layout
 * (button row + horizontal bar + text row) so the rest of the UI
 * (especially ClipsBar at the bottom) stays visible.
 *
 * Layout: `[▶ 开始切分 / ⏹ 取消]  [状态徽章]  [进度文本 · 内嵌细条]`
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
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
      {state === 'idle' || state === 'done' || state === 'failed' || state === 'cancelled' ? (
        <button onClick={onStart} disabled={disabled} style={{ padding: '4px 12px', fontSize: 13 }}>
          ▶ 开始切分
        </button>
      ) : (
        <button onClick={onCancel} style={{ padding: '4px 12px', fontSize: 13 }}>
          ⏹ 取消
        </button>
      )}
      <span
        style={{
          padding: '2px 8px',
          background: stateColor(state),
          borderRadius: 3,
          fontSize: 12,
        }}
      >
        {stateLabel(state)}
      </span>
      <span style={{ flex: 1, fontSize: 12, opacity: 0.85, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{ flexShrink: 0 }}>
          {progress
            ? `${progress.frames}/${progress.total} (${pct.toFixed(1)}%) · ${progress.fps.toFixed(1)} fps · ETA ${eta} · 在线 segments=${segCount}`
            : state === 'done'
              ? `已完成 · 共 ${segments} 段`
              : '等待开始…'}
        </span>
        {/* thin inline progress bar */}
        <span style={{ flex: 1, height: 4, background: '#222', borderRadius: 2, overflow: 'hidden', minWidth: 60 }}>
          <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: '#4a9', transition: 'width 0.2s' }} />
        </span>
      </span>
    </div>
  );
}

function stateColor(s: Props['state']): string {
  return { idle: '#444', queued: '#446', running: '#4a9', done: '#4a9', failed: '#a44', cancelled: '#666' }[s];
}
function stateLabel(s: Props['state']): string {
  return { idle: '空闲', queued: '排队中', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' }[s];
}