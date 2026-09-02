import type { SwingClient } from '../api/client';
import { EventLogList } from './EventLogList';
import { Tooltip } from './Tooltip';
import { useI18n } from '../i18n';

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
  // clipsAvailable is retained in props for backwards-compat — the
  // 📁 clips/ link was replaced by the "📁 打开目录" button which
  // surfaces viz.mp4 + segments.json + the whole clips/ tree together.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  clipsAvailable?: boolean;
  // Plan 004 — F12-style detachable event-log panel. When detached,
  // the inline log list collapses to a slim placeholder row that
  // offers a 📍 收回 button. Footer (viz / downloads / delete) is
  // untouched in either mode.
  logDetached?: boolean;
  onDetachLog?: () => void;
  onRecallLog?: () => void;
}

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

export function ResultsPanel({
  client, jobId, logLines, onClearLog, onDeleteJob, onExportPackage,
  vizMode, onToggleViz,
  vizAvailable, segmentsJsonAvailable,
  logDetached, onDetachLog, onRecallLog,
}: Props) {
  const { t } = useI18n();
  const hasJob = !!jobId;
  return (
    <div style={{
      flex: 1, overflow: 'auto', padding: 12, borderTop: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', minHeight: 0, color: 'var(--text)',
      background: 'var(--bg)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 6 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>{t('log.title')}</h3>
        <div style={{ display: 'flex', gap: 4 }}>
          {!logDetached && (
            <>
              <Tooltip text={t('btn.clearLog')}>
                <button
                  onClick={onClearLog}
                  disabled={logLines.length === 0}
                  style={{
                    ...ICON_BTN,
                    background: 'transparent',
                    color: logLines.length === 0 ? 'var(--text-dim)' : 'var(--text-muted)',
                    cursor: logLines.length === 0 ? 'default' : 'pointer',
                  }}
                >
                  🗑
                </button>
              </Tooltip>
              <Tooltip text={t('btn.detach')}>
                <button
                  onClick={onDetachLog}
                  style={ICON_BTN}
                >
                  ↗
                </button>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {logDetached ? (
        <div
          style={{
            minHeight: 36,
            border: '1px dashed var(--border)',
            borderRadius: 4,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 10px', gap: 8,
            color: 'var(--text-muted)', fontSize: 12, userSelect: 'none',
            background: 'var(--bg-alt)',
          }}
        >
          <span>{t('log.detachedPlaceholder')}</span>
          <Tooltip text={t('btn.recall')}>
            <button
              onClick={onRecallLog}
              style={ICON_BTN}
            >
              📍
            </button>
          </Tooltip>
        </div>
      ) : (
        <EventLogList logLines={logLines} />
      )}

      {/* Footer: viz playback toggle + download links + delete-job */}
      <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <Tooltip text={vizAvailable ? t('viz.play') : t('viz.unavailable')}>
          <button
            onClick={onToggleViz}
            disabled={!vizAvailable}
            style={{
              ...ICON_BTN,
              background: vizMode ? 'var(--accent)' : 'var(--bg-elev)',
              color: vizMode ? 'var(--accent-fg)' : (vizAvailable ? 'var(--text)' : 'var(--text-dim)'),
              border: '1px solid ' + (vizMode ? 'var(--accent)' : 'var(--border)'),
              fontWeight: vizMode ? 'bold' : 'normal',
              cursor: vizAvailable ? 'pointer' : 'default',
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
              onClick={async () => {
                const r = await window.api?.openOutputDir?.(jobId);
                if (r && !r.ok) {
                  // eslint-disable-next-line no-alert
                  alert(t('btn.openDir.fail') + r.error);
                }
              }}
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
    </div>
  );
}
