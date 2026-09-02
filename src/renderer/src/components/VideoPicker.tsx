import type { ClipInfo, Segment } from '../api/types';
import type { SwingClient } from '../api/client';
import { useEffect, useRef } from 'react';
import { ClipPlayer } from './ClipPlayer';
import { useI18n } from '../i18n';

interface Props {
  videoPath: string | null;
  onPick: () => void;
  client: SwingClient | null;
  selectedSeg: Segment | null;
  activeClip: ClipInfo | null;
  clipSegment: Segment | null;
  onReturnToOriginal: () => void;
  vizMode: boolean;
  videoSrc: string | null;
}

/**
 * Video picker — fills all available vertical space inside its parent
 * (the parent grid row is `1fr`; we make the picker a flex column that
 * gives the video area `flex:1`). The <video> element uses
 * object-fit:contain so it shows in full (preserves aspect ratio) and
 * never gets cropped. The controls bar always sits at the bottom of
 * the visible video so the user can pause/seek.
 */
export function VideoPicker({
  videoPath,
  onPick,
  client,
  selectedSeg,
  activeClip,
  clipSegment,
  onReturnToOriginal,
  vizMode,
  videoSrc,
}: Props) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    if (!activeClip && selectedSeg && !vizMode) {
      const tcToSec = (tc: string) => {
        const [m, rest] = tc.split(':');
        const [s] = rest.split('.');
        return Number(m) * 60 + Number(s);
      };
      videoRef.current.currentTime = tcToSec(selectedSeg.start_timecode);
      videoRef.current.play().catch(() => { /* autoplay may fail; ignore */ });
    }
  }, [selectedSeg, activeClip, vizMode]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      minHeight: 0,
      width: '100%',
    }}>
      {/* Header — fixed size, never grows */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 8,
        flex: '0 0 auto',
      }}>
        <button onClick={onPick} style={{
          background: 'var(--bg-elev)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          padding: '4px 12px',
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 13,
        }}>📁 {t('picker.pickVideo')}</button>
        {videoPath && <span style={{ opacity: 0.7, fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{videoPath}</span>}
        {vizMode && (
          <span style={{
            marginLeft: 'auto',
            background: 'var(--accent)',
            color: 'var(--accent-fg)',
            padding: '2px 8px',
            borderRadius: 3,
            fontSize: 11,
            fontWeight: 'bold',
            whiteSpace: 'nowrap',
          }}>
            ▶ {t('player.viz')}
          </span>
        )}
      </div>

      {/* Video area — fills remaining vertical space. overflow:hidden so
          a too-wide video never grows a horizontal scrollbar; the video
          itself uses object-fit:contain to scale down properly. */}
      <div style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        background: '#000',
      }}>
        {videoSrc ? (
          <video
            key={videoSrc /* re-mount on source change so currentTime resets */}
            ref={videoRef}
            controls
            preload="metadata"
            style={{
              display: 'block',
              width: '100%',
              height: '100%',
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              background: '#000',
            }}
            src={videoSrc}
          />
        ) : (
          <div style={{ color: 'var(--text-dim)', fontSize: 12, padding: 16 }}>
            {t('picker.empty')}
          </div>
        )}
        {activeClip && !vizMode && videoSrc && (
          <ClipPlayer clip={activeClip} seg={clipSegment} onReturn={onReturnToOriginal} />
        )}
      </div>
    </div>
  );
}