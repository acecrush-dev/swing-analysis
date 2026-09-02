import type { SwingClient } from '../api/client';
import { Tooltip } from './Tooltip';
import { useI18n } from '../i18n';

interface Props {
  client: SwingClient | null;
  jobId: string | null;
  vizMode: boolean;
  onToggleViz: () => void;
  // Same flags as ResultsPanel used to use — each is true only when
  // the backend HEAD probe confirmed the artifact exists on disk.
  // `vizAvailable` covers the canonical mp4v viz.mp4; `vizH264Available`
  // covers the sibling viz_h264.mp4 that the `<video>` element actually
  // plays (Chromium can't decode mp4v on macOS/Linux — see comment in
  // App.tsx for the full story). Gating the play button on the H.264
  // sibling keeps the user from clicking into a 0-second black viz.
  vizAvailable: boolean;
  vizH264Available: boolean;
  segmentsJsonAvailable: boolean;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  clipsAvailable?: boolean;
  onOpenDir: (jobId: string) => void;
  onExportPackage: () => void;
  onDeleteJob: () => void;
}

// Visually identical to ResultsPanel's old footer — same ICON_BTN
// sizing, same tooltip hover, same right-aligned Export / Delete
// pair (marginLeft:'auto' on Export pushes everything right of it).
// The toolbar moved out of the right column into a one-row strip
// above the ClipsBar so the action buttons sit next to the segment
// results they act on instead of dangling under the event log.
const ICON_BTN: React.CSSProperties = {
  background: 'var(--bg-elev)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
};

export function ResultsActionsBar({
  client, jobId, vizMode, onToggleViz,
  vizAvailable, vizH264Available, segmentsJsonAvailable,
  onOpenDir, onExportPackage, onDeleteJob,
}: Props) {
  const { t } = useI18n();
  const hasJob = !!jobId;
  // Gate the button on H.264 availability — viz.mp4 alone is a valid
  // download but Chromium cannot play the cv2-written mp4v codec,
  // so a viz.mp4-only state would be grey-on-but-actually-broken.
  const vizPlayable = vizAvailable && vizH264Available;
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center',
      padding: '6px 12px',
      background: 'var(--bg-alt)',
      borderTop: '1px solid var(--border)',
      borderBottom: '1px solid var(--border)',
      flexShrink: 0,
    }}>
      <Tooltip text={vizPlayable ? t('viz.play') : t('viz.unavailable')}>
        <button
          onClick={onToggleViz}
          disabled={!vizPlayable}
          style={{
            ...ICON_BTN,
            background: vizMode ? 'var(--accent)' : 'var(--bg-elev)',
            color: vizMode ? 'var(--accent-fg)' : (vizPlayable ? 'var(--text)' : 'var(--text-dim)'),
            border: '1px solid ' + (vizMode ? 'var(--accent)' : 'var(--border)'),
            fontWeight: vizMode ? 'bold' : 'normal',
            cursor: vizPlayable ? 'pointer' : 'default',
          }}
        >
          {vizMode ? '◼' : '🎬'}
        </button>
      </Tooltip>
      {client && jobId && (
        <>
          {segmentsJsonAvailable && (
            <a href={client.artifactUrl(jobId, 'segments.json')} download
               style={{ color: 'var(--link)', fontSize: 11 }}>{t('dl.segments')}</a>
          )}
          {vizAvailable && (
            <a href={client.artifactUrl(jobId, 'viz.mp4')} download
               style={{ color: 'var(--link)', fontSize: 11 }}>{t('dl.viz')}</a>
          )}
        </>
      )}
      {jobId && (
        <Tooltip text={t('btn.openDir')}>
          <button
            onClick={() => onOpenDir(jobId)}
            style={ICON_BTN}
          >
            📁
          </button>
        </Tooltip>
      )}
      <Tooltip text={hasJob ? t('btn.export.title') : t('btn.export.disabled')}>
        <button
          onClick={onExportPackage}
          disabled={!hasJob}
          style={{
            ...ICON_BTN,
            marginLeft: 'auto',
            color: hasJob ? 'var(--text)' : 'var(--text-dim)',
            cursor: hasJob ? 'pointer' : 'default',
          }}
        >
          📦
        </button>
      </Tooltip>
      <Tooltip text={hasJob ? t('btn.deleteJob.title') : t('btn.deleteJob.disabled')}>
        <button
          onClick={onDeleteJob}
          disabled={!hasJob}
          style={{
            ...ICON_BTN,
            background: hasJob ? 'var(--danger-bg)' : 'transparent',
            color: hasJob ? 'var(--danger)' : 'var(--text-dim)',
            border: '1px solid ' + (hasJob ? 'var(--danger-border)' : 'var(--border)'),
            cursor: hasJob ? 'pointer' : 'default',
          }}
        >
          🗑
        </button>
      </Tooltip>
    </div>
  );
}
