import type { Segment } from '../api/types';
import type { SwingClient } from '../api/client';

interface Props {
  client: SwingClient | null;
  jobId: string | null;
  segments: Segment[];
  fps: number;
  onSelect: (s: Segment) => void;
}

export function ResultsPanel({ client, jobId, segments, fps, onSelect }: Props) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12, borderTop: '1px solid #333' }}>
      <h3 style={{ margin: '0 0 8px' }}>📊 周期列表</h3>
      {!segments.length && <div style={{ opacity: 0.5 }}>（暂无）</div>}
      {segments.map((s) => (
        <div key={s.seg_id}
             onClick={() => onSelect(s)}
             style={{ padding: 8, margin: '4px 0', background: '#222', borderRadius: 4, cursor: 'pointer', fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <strong>#{s.seg_id}</strong>
            <span>{s.start_timecode} → {s.end_timecode}</span>
          </div>
          <div style={{ opacity: 0.75, marginTop: 4 }}>
            击球 @ {s.contact_timecode} · peak {s.peak_velocity.toFixed(3)} · dur {s.duration_sec.toFixed(2)}s
            {s.over_long && <span style={{ color: '#fa3', marginLeft: 6 }}>⚠ over_long</span>}
            {s.merged_intervals > 1 && <span style={{ opacity: 0.6, marginLeft: 6 }}>(合并 {s.merged_intervals} 段)</span>}
          </div>
        </div>
      ))}
      {client && jobId && segments.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          <a href={client.artifactUrl(jobId, 'segments.json')} download
             style={{ color: '#4af', marginRight: 12 }}>⬇ segments.json</a>
          <a href={client.artifactUrl(jobId, 'viz.mp4')} target="_blank" rel="noreferrer"
             style={{ color: '#4af', marginRight: 12 }}>🎬 viz.mp4</a>
          <a href={client.artifactUrl(jobId, 'clips')} target="_blank" rel="noreferrer"
             style={{ color: '#4af' }}>📁 clips/</a>
        </div>
      )}
    </div>
  );
}