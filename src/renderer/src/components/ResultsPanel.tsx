import type { SwingClient } from '../api/client';

interface Props {
  client: SwingClient | null;
  jobId: string | null;
  logLines: string[];
  onClearLog: () => void;
  onDeleteJob: () => void;
  onExportPackage: () => void;
  vizMode: boolean;
  onToggleViz: () => void;
  // Each flag is true only when the backend HEAD probe confirmed the
  // artifact actually exists on disk. Hides the corresponding button /
  // link so the user can never click into a 404.
  vizAvailable: boolean;
  segmentsJsonAvailable: boolean;
  clipsAvailable: boolean;
}

export function ResultsPanel({
  client, jobId, logLines, onClearLog, onDeleteJob, onExportPackage,
  vizMode, onToggleViz,
  vizAvailable, segmentsJsonAvailable, clipsAvailable,
}: Props) {
  const hasJob = !!jobId;
  return (
    <div style={{
      flex: 1, overflow: 'auto', padding: 12, borderTop: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--text)',
      background: 'var(--bg)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>📜 事件日志</h3>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={onClearLog}
            disabled={logLines.length === 0}
            title="清空日志"
            style={{
              background: 'transparent', color: logLines.length === 0 ? 'var(--text-dim)' : 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: 3,
              padding: '1px 8px', cursor: logLines.length === 0 ? 'default' : 'pointer', fontSize: 11,
            }}
          >
            🗑 清空
          </button>
        </div>
      </div>
      <div
        style={{
          flex: 1, overflow: 'auto', fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          background: 'var(--bg-elev2)', border: '1px solid var(--border-soft)',
          borderRadius: 4, padding: 8, lineHeight: 1.5, color: 'var(--text)',
        }}
      >
        {logLines.length === 0 ? (
          <div style={{ opacity: 0.5 }}>（暂无事件）</div>
        ) : (
          logLines.map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre-wrap', opacity: i < logLines.length - 20 ? 0.6 : 1 }}>
              {line}
            </div>
          ))
        )}
      </div>

      {/* Footer: viz playback toggle + download links + delete-job */}
      <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <button
          onClick={onToggleViz}
          disabled={!vizAvailable}
          title={vizAvailable ? '在视频区域播放整段 viz.mp4' : 'viz.mp4 不存在（job 还没完成或没勾生成 viz）'}
          style={{
            background: vizMode ? 'var(--accent)' : 'var(--bg-elev)',
            color: vizMode ? 'var(--accent-fg)' : (vizAvailable ? 'var(--text)' : 'var(--text-dim)'),
            border: '1px solid ' + (vizMode ? 'var(--accent)' : 'var(--border)'),
            borderRadius: 3,
            padding: '2px 8px',
            cursor: vizAvailable ? 'pointer' : 'default',
            fontSize: 11,
            fontWeight: vizMode ? 'bold' : 'normal',
          }}
        >
          {vizMode ? '◼ 退出 viz' : '🎬 播放 viz.mp4'}
        </button>
        {client && jobId && (
          <>
            {segmentsJsonAvailable && (
              <a href={client.artifactUrl(jobId, 'segments.json')} download
                 style={{ color: 'var(--link)', fontSize: 11 }}>⬇ segments.json</a>
            )}
            {vizAvailable && (
              <a href={client.artifactUrl(jobId, 'viz.mp4')} download
                 style={{ color: 'var(--link)', fontSize: 11 }}>⬇ viz.mp4</a>
            )}
            {clipsAvailable && (
              <a href={client.artifactUrl(jobId, 'clips')} target="_blank" rel="noreferrer"
                 style={{ color: 'var(--link)', fontSize: 11 }}>📁 clips/</a>
            )}
          </>
        )}
        <button
          onClick={onExportPackage}
          disabled={!hasJob}
          title="把当前 job 的 segments.json + clips + viz.mp4 打成 zip"
          style={{
            marginLeft: 'auto',
            background: hasJob ? 'var(--bg-elev)' : 'transparent',
            color: hasJob ? 'var(--text)' : 'var(--text-dim)',
            border: '1px solid ' + (hasJob ? 'var(--border)' : 'var(--border)'),
            borderRadius: 3,
            padding: '2px 8px',
            cursor: hasJob ? 'pointer' : 'default',
            fontSize: 11,
          }}
        >
          📦 导出
        </button>
        <button
          onClick={onDeleteJob}
          disabled={!hasJob}
          title="删除整个 job（清空所有 clips / viz.mp4 / segments.json）"
          style={{
            background: hasJob ? 'var(--danger-bg)' : 'transparent',
            color: hasJob ? 'var(--danger)' : 'var(--text-dim)',
            border: '1px solid ' + (hasJob ? 'var(--danger-border)' : 'var(--border)'),
            borderRadius: 3,
            padding: '2px 8px',
            cursor: hasJob ? 'pointer' : 'default',
            fontSize: 11,
          }}
        >
          🗑 删除 job
        </button>
      </div>
    </div>
  );
}