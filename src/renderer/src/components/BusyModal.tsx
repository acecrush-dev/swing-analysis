/**
 * Plan 005 — BusyModal
 *
 * Centred modal that blocks the rest of the UI while a long-running
 * op is in flight (export-package / clear-output-dir / cleanup-clips /
 * open-output-dir). Renders the app icon as a logo, a CSS spinner, the
 * op's localised title, an optional status line (currently always
 * shows "Preparing…"), and a 取消 button that triggers callId-cancel
 * on the main process.
 *
 * Layering:
 *   z-index 5000 → above Help/Settings panels (which use no explicit
 *   z, default 0) and above the Toast host (4000). The full-viewport
 *   scrim catches every pointer event in the main window; ESC is
 *   swallowed at the App level so this modal can't be closed by
 *   accident — the user must explicitly click 取消.
 *
 * Theme: every visible colour comes from CSS vars so light/dark flip
 * automatically. The logo image comes from main via the data URL
 * fetched at App mount; if the icon isn't available we fall back to
 * a 🎾 emoji so the modal never renders empty.
 */

import type { BusyState } from '../busy';

export interface BusyModalProps {
  busy: BusyState;
  iconUrl: string | null;
  onCancel: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export function BusyModal({ busy, iconUrl, onCancel, t }: BusyModalProps) {
  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--scrim)',
        zIndex: 5000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={busy.title}
        style={{
          background: 'var(--bg-elev)',
          color: 'var(--text)',
          border: '2px solid var(--accent)',
          borderRadius: 12,
          padding: '24px 32px',
          minWidth: 320,
          maxWidth: 480,
          boxShadow: '0 16px 48px var(--shadow)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}
      >
        {iconUrl ? (
          <img
            src={iconUrl}
            alt={t('busy.logoAlt')}
            style={{ width: 48, height: 48, display: 'block' }}
          />
        ) : (
          <div style={{ fontSize: 36, lineHeight: 1 }} aria-hidden="true">🎾</div>
        )}
        <div
          aria-hidden="true"
          style={{
            width: 36,
            height: 36,
            border: '3px solid var(--border)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'busy-spin 1.2s linear infinite',
          }}
        />
        <h3 style={{ margin: 0, fontSize: 16, textAlign: 'center' }}>{busy.title}</h3>
        <div
          style={{
            fontSize: 13,
            color: 'var(--text-dim)',
            minHeight: 18,
            textAlign: 'center',
          }}
        >
          {busy.status || t('busy.status.start')}
        </div>
        <button
          onClick={onCancel}
          autoFocus
          style={{
            background: 'var(--bg)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '8px 24px',
            cursor: 'pointer',
            fontSize: 13,
            fontFamily: 'inherit',
            marginTop: 4,
          }}
        >
          {t('busy.cancel')}
        </button>
      </div>
    </div>
  );
}