import { EventLogList } from './EventLogList';
import { Tooltip } from './Tooltip';
import { useI18n } from '../i18n';

interface Props {
  jobId: string | null;
  logLines: string[];
  onClearLog: () => void;
  // Plan 004 — F12-style detachable event-log panel. When detached,
  // the inline log list collapses to a slim placeholder row that
  // offers a 📍 收回 button. The action toolbar (viz / downloads /
  // export / delete) used to live in this panel's footer but moved
  // up to the left column between ProgressPanel and ClipsBar so it
  // sits next to the artifacts it controls.
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

// Pure log panel now. The viz / download / open-dir / export / delete
// toolbar used to be the footer of this panel but moved to
// `ResultsActionsBar` (left column, between ProgressPanel and
// ClipsBar). Keeps this panel scoped to what it always should have
// been: just the event-log list + its clear / detach controls.
export function ResultsPanel({
  logLines, onClearLog,
  logDetached, onDetachLog, onRecallLog,
}: Props) {
  const { t } = useI18n();
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
    </div>
  );
}
