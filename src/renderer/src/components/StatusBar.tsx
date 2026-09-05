/**
 * StatusBar — fixed bottom strip in the main window showing model
 * loading state + a short rolling log of recent sidecar messages.
 *
 * Layout (top → bottom inside the bar):
 *   1. One-line indicator strip — sidecar dot + the three model dots +
 *      names + state text. Same visual language as the splash's
 *      status rows so the user reads it the same way.
 *   2. Log strip — last 3 stderr lines from the sidecar, truncated to
 *      fit. Auto-scrolls to newest (always shows the freshest line on
 *      the bottom; older lines above get pushed up and clipped).
 *
 * Data flow:
 *   - Subscribes to `sidecar:status` and `sidecar:log` via preload
 *     (window.api.onSidecarStatus / onSidecarLog). Main process keeps
 *     the /api/status poll running after the splash closes and
 *     redirects IPC events to whichever window is "active" (splash →
 *     main), so this component picks up updates with zero extra setup.
 *
 * Visual: matches the splash colour scheme (gray = pending, pulsing
 * yellow = loading, green = ready, red = failed) so the user's eye
 * transfers directly. CSS vars from styles.css drive the chrome
 * (border / background) so light/dark theme flips automatically.
 */
import React, { useEffect, useState } from 'react';
import {
  subscribe as subscribeModels,
  loadAll as loadAllModels,
  type ModelName,
  type ModelState,
} from '../lib/modelLoader';

type SidecarState = 'starting' | 'ready' | 'failed';

interface StatusSnapshot {
  sidecar: SidecarState;
  models: Record<ModelName, ModelState>;
  default_backend?: string;
  version?: string;
  all_ready?: boolean;
}

const MODELS: ModelName[] = ['rtmdet', 'rtmpose', 'mediapipe'];
const LOG_LINES = 3;       // height of the rolling log strip
const LOG_MAX = 60;        // rolling buffer size (chars/line)

export function StatusBar() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [backendMode, setBackendMode] = useState<'python' | 'ts' | null>(null);

  useEffect(() => {
    const api = window.api;
    if (!api) return;
    void api.getBackendMode().then(setBackendMode);
    // In ts mode the sidecar never starts, so onSidecarStatus /
    // onSidecarLog would never fire — subscribing is harmless but
    // pointless. Keep the calls so a single component works in both.
    const offStatus = api.onSidecarStatus((snap) => {
      setStatus(snap as StatusSnapshot);
    });
    const offLog = api.onSidecarLog((line) => {
      setLogs((prev) => {
        const trimmed = line.length > LOG_MAX ? line.slice(0, LOG_MAX - 1) + '…' : line;
        const next = prev.length >= LOG_LINES ? prev.slice(prev.length - LOG_LINES + 1) : prev.slice();
        next.push(trimmed);
        return next;
      });
    });
    return () => { offStatus(); offLog(); };
  }, []);

  // TS mode — render the same status dots as Python mode, but the data
  // comes from the renderer-side modelLoader instead of /api/status.
  // Eager-load all three on mount; StatusBar reflects progress live.
  const [tsState, setTsState] = useState<Record<ModelName, { state: ModelState; bytes?: number; error?: string }>>({
    rtmdet: { state: 'pending' }, rtmpose: { state: 'pending' }, mediapipe: { state: 'pending' },
  });
  useEffect(() => {
    if (backendMode !== 'ts') return;
    const off = subscribeModels(setTsState);
    void loadAllModels();
    return off;
  }, [backendMode]);

  const containerStyle: React.CSSProperties = {
    flex: '0 0 auto',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-elev)',
    color: 'var(--text)',
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 11,
    padding: '6px 12px 4px',
    userSelect: 'none',
  };

  const stripStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  };

  const itemStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  };

  const dot = (state: SidecarState | ModelState): React.CSSProperties => {
    const base: React.CSSProperties = {
      width: 8, height: 8, borderRadius: '50%',
      transition: 'background 0.25s, box-shadow 0.25s',
      flex: '0 0 auto',
    };
    if (state === 'ready')   return { ...base, background: '#5dd28a', boxShadow: '0 0 5px #5dd28a' };
    if (state === 'failed')  return { ...base, background: '#ef5b5b', boxShadow: '0 0 5px #ef5b5b' };
    if (state === 'loading') return { ...base, background: '#f0b85c', boxShadow: '0 0 5px #f0b85c', animation: 'swing-status-pulse 1s infinite' };
    return { ...base, background: '#7a8095' };  // pending / starting
  };

  const labelStyle: React.CSSProperties = { color: 'var(--text)' };
  const muted: React.CSSProperties = { color: 'var(--muted, #8d96b0)' };

  const logsStyle: React.CSSProperties = {
    marginTop: 4,
    height: LOG_LINES * 14,
    overflow: 'hidden',
    color: '#8d96b0',
    lineHeight: '14px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-end',
  };
  const emptyLogsStyle: React.CSSProperties = { ...logsStyle, fontStyle: 'italic', color: '#5a6080' };

  // ── TS backend render branch ──────────────────────────────────────────
  // Same visual as Python mode, but the dots + ready state come from
  // the renderer-side modelLoader instead of /api/status. Eager-load all
  // three on mount; subscribers see the dots light up in sequence.
  if (backendMode === 'ts') {
    const tsReady = MODELS.every((m) => tsState[m].state === 'ready');
    const failedMs = MODELS.find((m) => tsState[m].state === 'failed');
    return (
      <div style={containerStyle}>
        <style>{`@keyframes swing-status-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>
        <div style={stripStyle}>
          {MODELS.map((m) => (
            <span key={m} style={itemStyle}>
              <span style={dot(tsState[m].state)} />
              <span style={labelStyle}>{m}</span>
              {tsState[m].bytes != null && (
                <span style={{ ...muted, fontSize: 10 }}>
                  {(tsState[m].bytes! / 1024 / 1024).toFixed(0)} MiB
                </span>
              )}
            </span>
          ))}
          <span style={{ ...muted, marginLeft: 'auto' }}>
            TS backend (WASM){' · '}
            {tsReady ? 'ready' : (failedMs ? 'load failed' : 'loading')}
          </span>
        </div>
        {failedMs && (
          <div style={logsStyle}>
            <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#ef5b5b' }}>
              {failedMs}: {tsState[failedMs].error}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* Inject the pulse keyframes once. Harmless if the splash already
          defined the same name (CSS animation-name is per-document,
          both rule blocks can coexist). */}
      <style>{`@keyframes swing-status-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>

      <div style={stripStyle}>
        {MODELS.map((m) => (
          <span key={m} style={itemStyle}>
            <span style={dot(status?.models?.[m] ?? 'pending')} />
            <span style={labelStyle}>{m}</span>
          </span>
        ))}
        <span style={{ ...muted, marginLeft: 'auto' }}>
          v{status?.version ?? '…'} ·{' '}
          {status?.all_ready ? 'ready' : (status?.sidecar === 'failed' ? 'service failed' : 'warming up')}
        </span>
      </div>

      {logs.length === 0 ? (
        <div style={emptyLogsStyle}>
          {status?.all_ready ? 'no log output' : 'awaiting sidecar log …'}
        </div>
      ) : (
        <div style={logsStyle}>
          {logs.map((l, i) => (
            <div key={i} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
