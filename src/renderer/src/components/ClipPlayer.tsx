import type { ClipInfo, Segment } from '../api/types';

interface Props {
  clip: ClipInfo;
  seg: Segment | null;
  onReturn: () => void;
}

/**
 * Watermark overlay shown on the video element while a clip is playing.
 * Pure overlay — the actual <video> lives in VideoPicker.
 *
 * Bright yellow text on the left so the user can never miss which clip
 * is on screen. Also visible when the clip is non-playable (mp4v) and
 * the GUI is just seeking the original video to the seg start — the
 * user should always see a "正在播放 clip #N" indicator.
 */
export function ClipPlayer({ clip, seg, onReturn }: Props) {
  const tcLine = seg
    ? `${seg.start_timecode} → ${seg.end_timecode}`
    : `clip #${clip.seg_id}`;
  const contact = seg ? ` · 击球 ${seg.contact_timecode}` : '';
  const playable = clip.playable;
  return (
    <div
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        background: 'rgba(0,0,0,0.78)',
        color: 'var(--accent)',
        padding: '8px 12px',
        borderRadius: 6,
        fontSize: 14,
        fontFamily: 'system-ui',
        fontWeight: 'bold',
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        maxWidth: 'calc(100% - 24px)',
        boxShadow: '0 2px 8px var(--shadow)',
        pointerEvents: 'auto',
      }}
    >
      <span style={{ fontSize: 16 }}>▶</span>
      <span>clip #{clip.seg_id} · {tcLine}{contact}</span>
      {!playable && (
        <span style={{
          background: 'var(--warn)',
          color: 'var(--accent-fg)',
          padding: '1px 6px',
          borderRadius: 3,
          fontSize: 11,
          fontWeight: 'bold',
        }}>
          原生格式
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onReturn(); }}
        style={{
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          border: 'none',
          borderRadius: 4,
          padding: '4px 10px',
          cursor: 'pointer',
          fontSize: 12,
          fontWeight: 'bold',
          marginLeft: 4,
        }}
      >
        ↩ 回原始视频
      </button>
    </div>
  );
}