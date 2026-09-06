/**
 * StatusBar — fixed bottom strip in the main window showing per-model
 * loading state. IDENTICAL for both backends (plan 008: the frontend
 * has no awareness of the backend choice) — only the data source
 * differs:
 *
 *   python → sidecar `sidecar:status` IPC (500 ms /api/status poll,
 *            forwarded to whichever window is active) + one stat of the
 *            models directory for the size hints (`get-model-sizes`).
 *   ts     → renderer-side modelLoader subscription (state + probed
 *            byte sizes).
 *
 * Layout: one row — three model dots (green ready / pulsing yellow
 * loading / red failed / grey pending) + size hints + a neutral
 * readiness label on the right. No backend name, no version, no log
 * strip (the 📜 Event log panel already covers logs).
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

export function StatusBar() {
  const [backendMode, setBackendMode] = useState<'python' | 'ts' | null>(null);

  useEffect(() => {
    void window.api?.getBackendMode().then(setBackendMode);
  }, []);

  // ── python data: sidecar status stream + model sizes via IPC ────────
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  useEffect(() => {
    if (backendMode !== 'python') return;
    const api = window.api;
    if (!api) return;
    const offStatus = api.onSidecarStatus((snap) => {
      setStatus(snap as StatusSnapshot);
    });
    return () => { offStatus(); };
  }, [backendMode]);

  const [pySizes, setPySizes] = useState<Partial<Record<ModelName, number>>>({});
  useEffect(() => {
    if (backendMode !== 'python') return;
    const api = window.api;
    if (!api?.getModelSizes) return;
    void api.getModelSizes().then((raw) => {
      const map: Partial<Record<ModelName, number>> = {};
      for (const [name, size] of Object.entries(raw ?? {})) {
        if (name.startsWith('rtmdet')) map.rtmdet = size;
        else if (name.startsWith('rtmpose')) map.rtmpose = size;
        else if (name.startsWith('pose_landmarker')) map.mediapipe = size;
      }
      setPySizes(map);
    }).catch(() => { /* sizes are cosmetic — stay absent on failure */ });
  }, [backendMode]);

  // ── ts data: renderer-side loader ────────────────────────────────────
  const [tsState, setTsState] = useState<Record<ModelName, { state: ModelState; bytes?: number; error?: string }>>({
    rtmdet: { state: 'pending' }, rtmpose: { state: 'pending' }, mediapipe: { state: 'pending' },
  });
  useEffect(() => {
    if (backendMode !== 'ts') return;
    const off = subscribeModels(setTsState);
    void loadAllModels();
    return off;
  }, [backendMode]);

  // ── unified view model ────────────────────────────────────────────────
  const isTs = backendMode === 'ts';
  const modelState = (m: ModelName): ModelState =>
    isTs ? tsState[m].state : (status?.models?.[m] ?? 'pending');
  const modelBytes = (m: ModelName): number | undefined =>
    isTs ? tsState[m].bytes : pySizes[m];
  const failedModel: ModelName | undefined = MODELS.find((m) => modelState(m) === 'failed');
  const allReady = MODELS.every((m) => modelState(m) === 'ready');
  const anyFailed = !!failedModel;
  const readiness = allReady ? 'ready' : (anyFailed ? 'failed' : 'loading');
  // Failure detail text only exists in ts (the loader captures the
  // message); python failures surface via the sidecar log instead.
  const failedDetail = isTs && failedModel ? tsState[failedModel].error : undefined;

  const containerStyle: React.CSSProperties = {
    flex: '0 0 auto',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-elev)',
    color: 'var(--text)',
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 11,
    padding: '6px 12px 6px',
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

  return (
    <div style={containerStyle}>
      <style>{`@keyframes swing-status-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }`}</style>

      <div style={stripStyle}>
        {MODELS.map((m) => (
          <span key={m} style={itemStyle}>
            <span style={dot(modelState(m))} />
            <span style={labelStyle}>{m}</span>
            {modelBytes(m) != null && (
              <span style={{ ...muted, fontSize: 10 }}>
                {(modelBytes(m)! / 1024 / 1024).toFixed(0)} MiB
              </span>
            )}
          </span>
        ))}
        <span style={{ ...muted, marginLeft: 'auto' }}>{readiness}</span>
      </div>

      {failedDetail && (
        <div style={{ marginTop: 4, overflow: 'hidden', color: '#ef5b5b' }}>
          <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {failedModel}: {failedDetail}
          </div>
        </div>
      )}
    </div>
  );
}
