interface Props {
  state: 'idle'|'queued'|'running'|'done'|'failed'|'cancelled';
  progress: { frames: number; total: number; fps: number; eta_sec: number | null; segments_emitted: number } | null;
  segments: number;
  onStart: () => void;
  onCancel: () => void;
  disabled: boolean;
}

export function ProgressPanel({ state, progress, segments, onStart, onCancel, disabled }: Props) {
  const pct = progress && progress.total > 0 ? (100 * progress.frames / progress.total) : 0;
  const eta = (() => {
    if (!progress?.eta_sec && progress?.eta_sec !== 0) return '--:--';
    const s = Math.round(progress.eta_sec);
    if (s < 3600) return `${Math.floor(s/60)}:${s%60 < 10 ? '0' : ''}${s%60}`;
    return `${Math.floor(s/3600)}:${Math.floor((s%3600)/60)}:${s%60}`;
  })();
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {state === 'idle' || state === 'done' || state === 'failed' || state === 'cancelled' ? (
          <button onClick={onStart} disabled={disabled} style={{ padding: '6px 16px' }}>▶ 开始切分</button>
        ) : (
          <button onClick={onCancel} style={{ padding: '6px 16px' }}>⏹ 取消</button>
        )}
        <span style={{ alignSelf: 'center', padding: '4px 10px', background: stateColor(state), borderRadius: 4, fontSize: 13 }}>{stateLabel(state)}</span>
      </div>
      <div style={{ height: 8, background: '#222', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: '#4a9', transition: 'width 0.2s' }} />
      </div>
      <div style={{ fontSize: 13, opacity: 0.85 }}>
        {progress ? (
          <>
            {progress.frames}/{progress.total} ({pct.toFixed(1)}%) · {progress.fps.toFixed(1)} fps · ETA {eta} · 在线 segments={progress.segments}
          </>
        ) : state === 'done' ? <>已完成 · 共 {segments} 段</> : '等待开始…'}
      </div>
    </div>
  );
}

function stateColor(s: Props['state']): string {
  return { idle: '#444', queued: '#446', running: '#4a9', done: '#4a9', failed: '#a44', cancelled: '#666' }[s];
}
function stateLabel(s: Props['state']): string {
  return { idle: '空闲', queued: '排队中', running: '运行中', done: '完成', failed: '失败', cancelled: '已取消' }[s];
}