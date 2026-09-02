/**
 * Plan 004 — detached event-log panel app.
 *
 * Renders the live event log pushed from the main window, with auto-
 * scroll pinned to the tail. Clearing the log sends a `clear-log`
 * action back to the main window so both sides stay in sync.
 */

import { EventLogList } from '../EventLogList';
import { useI18n } from '../../i18n';
import { usePanelSnapshot, usePanelTheme } from './usePanelSnapshot';

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

export function LogPanelApp() {
  const { t } = useI18n();
  const snap = usePanelSnapshot();
  usePanelTheme(snap);

  if (!snap) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)', fontFamily: 'system-ui', fontSize: 13,
      }}>
        ⏳ Waiting for main window state…
      </div>
    );
  }

  const { logLines } = snap;
  const empty = logLines.length === 0;

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: 'system-ui',
        padding: 12,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: 8, userSelect: 'none',
        }}
      >
        <h3 style={{ margin: 0, fontSize: 13 }}>{t('log.title')}</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => window.api?.sendPanelAction?.({ type: 'clear-log' })}
            disabled={empty}
            title={t('btn.clearLog')}
            style={{
              ...ICON_BTN,
              background: 'transparent',
              color: empty ? 'var(--text-dim)' : 'var(--text-muted)',
              cursor: empty ? 'default' : 'pointer',
            }}
          >
            🗑
          </button>
          <button
            onClick={() => window.api?.closePanel?.('log')}
            title={t('btn.recall')}
            style={ICON_BTN}
          >
            📍
          </button>
        </div>
      </div>

      <EventLogList logLines={logLines} autoScroll />
    </div>
  );
}
