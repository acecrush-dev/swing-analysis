import type { ClipInfo, Segment } from '../api/types';
import type { SwingClient } from '../api/client';
import { useEffect, useRef } from 'react';
import { ClipPlayer } from './ClipPlayer';

interface Props {
  videoPath: string | null;
  onPick: () => void;
  client: SwingClient | null;
  selectedSeg: Segment | null;
  // Clip overlay (plan 002). When `clipUrl` is non-null the <video> plays
  // the clip stream; when null it falls back to the original video file.
  activeClip: ClipInfo | null;
  clipUrl: string | null;
  clipSegment: Segment | null;
  onReturnToOriginal: () => void;
}

export function VideoPicker({
  videoPath,
  onPick,
  client,
  selectedSeg,
  activeClip,
  clipUrl,
  clipSegment,
  onReturnToOriginal,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Decide the <video> src: clip stream when active AND playable,
  // otherwise original (no H.264 → fall back to seek original video).
  const src = (clipUrl && activeClip?.playable)
    ? clipUrl
    : (videoPath && client ? client.videoUrl(videoPath) : null);

  useEffect(() => {
    // Seek on either path:
    //  - no active clip → original-video mode, jump to selectedSeg.start_timecode
    //  - active clip but non-playable (mp4v) → original-video mode, jump to
    //    the clicked clip's start_timecode via selectedSeg (App sets both).
    // In playable-clip mode the source is the clip stream itself, so we
    // don't seek — the clip is short and plays from 0.
    if (!videoRef.current) return;
    if (!activeClip && selectedSeg) {
      const tcToSec = (tc: string) => {
        const [m, rest] = tc.split(':');
        const [s] = rest.split('.');
        return Number(m) * 60 + Number(s);
      };
      videoRef.current.currentTime = tcToSec(selectedSeg.start_timecode);
      videoRef.current.play().catch(() => { /* autoplay may fail; ignore */ });
    }
  }, [selectedSeg, activeClip]);

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 8 }}>
        <button onClick={onPick}>📁 选择视频…</button>
        {videoPath && <span style={{ marginLeft: 12, opacity: 0.7 }}>{videoPath}</span>}
      </div>
      {src && (
        <div style={{ position: 'relative' }}>
          <video
            key={src /* re-mount on source change so currentTime resets */}
            ref={videoRef}
            controls
            preload="metadata"
            style={{
              width: '100%',
              maxHeight: '50vh',
              background: '#000',
              display: 'block',
            }}
            src={src}
          />
          {activeClip && (
            <ClipPlayer clip={activeClip} seg={clipSegment} onReturn={onReturnToOriginal} />
          )}
        </div>
      )}
    </div>
  );
}