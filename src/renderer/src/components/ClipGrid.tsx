import type { ClipInfo, Segment } from '../api/types';

interface Props {
  clips: ClipInfo[];
  segments: Segment[];
  activeClip: ClipInfo | null;
  onSelectClip: (c: ClipInfo) => void;
  thumbUrl: (segId: number) => string;
}

export function ClipGrid({ clips, segments, activeClip, onSelectClip, thumbUrl }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 10,
        padding: '4px 2px 8px 2px',
        marginTop: 6,
      }}
    >
      {clips.map((c) => {
        const seg = segments.find((s) => s.seg_id === c.seg_id);
        const isActive = activeClip?.seg_id === c.seg_id;
        const borderColor = isActive ? 'var(--accent)' : 'transparent';
        return (
          <div
            key={c.seg_id}
            onClick={() => onSelectClip(c)}
            style={{
              position: 'relative',
              flex: '0 0 auto',
              width: 200,
              padding: 6,
              background: isActive ? 'var(--bg-elev)' : 'var(--bg-alt)',
              color: 'var(--text)',
              border: `2px solid ${borderColor}`,
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              boxShadow: isActive ? '0 0 0 2px var(--accent)' : 'none',
            }}
            title={seg ? `clip #${c.seg_id} · ${seg.start_timecode} → ${seg.end_timecode}` : `clip #${c.seg_id}`}
          >
            <div
              style={{
                width: '100%',
                height: 110,
                background: '#000',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                borderRadius: 4,
              }}
            >
              <img
                src={thumbUrl(c.seg_id)}
                alt={`clip ${c.seg_id} 首帧`}
                loading="lazy"
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12 }}>
              <strong>#{c.seg_id}</strong>
              <span style={{ opacity: 0.6 }}>{(c.size_bytes / 1024).toFixed(0)} KB</span>
            </div>
            {seg ? (
              <>
                <div style={{ marginTop: 2, fontSize: 12 }}>
                  {seg.start_timecode} → {seg.end_timecode}
                </div>
                <div style={{ opacity: 0.7, marginTop: 4, fontSize: 11, lineHeight: 1.45 }}>
                  击球 @ {seg.contact_timecode} · peak {seg.peak_velocity.toFixed(3)} · dur {seg.duration_sec.toFixed(2)}s
                  {seg.over_long && <span style={{ color: 'var(--warn)', marginLeft: 6 }}>⚠ over_long</span>}
                  {seg.merged_intervals > 1 && <span style={{ opacity: 0.7, marginLeft: 6 }}>(合并 {seg.merged_intervals} 段)</span>}
                </div>
              </>
            ) : (
              <div style={{ opacity: 0.6, marginTop: 4 }}>（无 segment 元数据）</div>
            )}
            {!c.playable && (
              <div
                style={{
                  position: 'absolute', top: 10, right: 10,
                  background: 'var(--warn)', color: 'var(--accent-fg)',
                  padding: '2px 6px', borderRadius: 3,
                  fontSize: 10, fontWeight: 'bold',
                }}
              >
                ⚠ 原生格式
              </div>
            )}
            {isActive && (
              <div
                style={{
                  position: 'absolute', top: 10, left: 10,
                  background: 'var(--accent)', color: 'var(--accent-fg)',
                  padding: '2px 6px', borderRadius: 3,
                  fontSize: 10, fontWeight: 'bold',
                }}
              >
                ▶ 正在播放
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}