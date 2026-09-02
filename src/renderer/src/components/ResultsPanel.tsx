import type { SwingClient } from '../api/client';

interface Props {
  client: SwingClient | null;
  jobId: string | null;
  // Newest-last list of plain-text log lines. We push one line per
  // significant WS event so the user sees the live progress feed
  // without us cluttering the UI with clickable segment cards.
  // The clips themselves are surfaced via the bottom ClipsBar.
  logLines: string[];
  onClearLog: () => void;
}

/**
 * Right-panel "log feed" — replaces the old segments/clip 列表.
 *
 * The actual clip list is at the bottom of the window (ClipsBar with
 * thumbnail previews). This panel is now just a stream of plain-text
 * events so the user can see what's happening on the backend.
 */
export function ResultsPanel({ client, jobId, logLines, onClearLog }: Props) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12, borderTop: '1px solid #333', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>📜 事件日志</h3>
        <button
          onClick={onClearLog}
          disabled={logLines.length === 0}
          title="清空日志"
          style={{
            background: 'transparent',
            color: logLines.length === 0 ? '#555' : '#aaa',
            border: '1px solid #444',
            borderRadius: 3,
            padding: '1px 8px',
            cursor: logLines.length === 0 ? 'default' : 'pointer',
            fontSize: 11,
          }}
        >
          🗑 清空
        </button>
      </div>
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          fontSize: 11,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          background: '#0e0e0e',
          border: '1px solid #222',
          borderRadius: 4,
          padding: 8,
          lineHeight: 1.5,
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

      {client && jobId && (
        <div style={{ marginTop: 10, fontSize: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <a href={client.artifactUrl(jobId, 'segments.json')} download style={{ color: '#4af' }}>⬇ segments.json</a>
          <a href={client.artifactUrl(jobId, 'viz.mp4')} target="_blank" rel="noreferrer" style={{ color: '#4af' }}>🎬 viz.mp4</a>
          <a href={client.artifactUrl(jobId, 'clips')} target="_blank" rel="noreferrer" style={{ color: '#4af' }}>📁 clips/</a>
        </div>
      )}
    </div>
  );
}