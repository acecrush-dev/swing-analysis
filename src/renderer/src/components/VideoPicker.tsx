import type { Segment } from '../api/types';
import type { SwingClient } from '../api/client';
import { useEffect, useRef } from 'react';

interface Props {
  videoPath: string | null;
  onPick: () => void;
  client: SwingClient | null;
  selectedSeg: Segment | null;
}

export function VideoPicker({ videoPath, onPick, client, selectedSeg }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (selectedSeg && videoRef.current) {
      // Parse "mm:ss.SSS" → seconds
      const tcToSec = (tc: string) => {
        const [m, rest] = tc.split(':');
        const [s] = rest.split('.');
        return Number(m) * 60 + Number(s);
      };
      videoRef.current.currentTime = tcToSec(selectedSeg.start_timecode);
      videoRef.current.play().catch(() => { /* autoplay may fail; ignore */ });
    }
  }, [selectedSeg]);

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ marginBottom: 8 }}>
        <button onClick={onPick}>📁 选择视频…</button>
        {videoPath && <span style={{ marginLeft: 12, opacity: 0.7 }}>{videoPath}</span>}
      </div>
      {videoPath && client && (
        <video
          ref={videoRef}
          controls
          preload="metadata"
          style={{ width: '100%', maxHeight: '50vh', background: '#000' }}
        >
          <source src={client.videoUrl(videoPath)} />
        </video>
      )}
    </div>
  );
}