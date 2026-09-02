/**
 * Settings modal — annotation colours for the clip annotator.
 *
 * Four colour pickers, persisted to localStorage under 'swing.colors'
 * as `{ color_bbox, color_pose_left, color_pose_right, color_pose_body }`.
 * Defaults match backend/service/pipeline.py:DEFAULT_PARAMS and the
 * user's expected out-of-the-box look (pink bbox, red/yellow/green pose).
 */

import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { Tooltip } from './Tooltip';

export interface ColorSettings {
  color_bbox: string;
  color_pose_left: string;
  color_pose_right: string;
  color_pose_body: string;
}

export const DEFAULT_COLORS: ColorSettings = {
  color_bbox: 'ff69b4',
  color_pose_left: 'ff0000',
  color_pose_right: 'ffff00',
  color_pose_body: '00ff00',
};

const STORAGE_KEY = 'swing.colors';

export function loadColors(): ColorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') {
        return {
          color_bbox:        validHex(obj.color_bbox,        DEFAULT_COLORS.color_bbox),
          color_pose_left:   validHex(obj.color_pose_left,   DEFAULT_COLORS.color_pose_left),
          color_pose_right:  validHex(obj.color_pose_right,  DEFAULT_COLORS.color_pose_right),
          color_pose_body:   validHex(obj.color_pose_body,   DEFAULT_COLORS.color_pose_body),
        };
      }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_COLORS };
}

export function saveColors(c: ColorSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch { /* */ }
  // Also broadcast to the Settings panel mounted in other windows so
  // they can re-render. The other windows re-read on mount; this is
  // belt-and-suspenders for the same-window second mount.
  try { window.dispatchEvent(new CustomEvent('colorschange', { detail: c })); } catch { /* */ }
}

function validHex(v: unknown, fallback: string): string {
  return typeof v === 'string' && /^[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

interface Props { onClose: () => void; onChange?: (c: ColorSettings) => void; }

type DirInfo = {
  output_dir: string;
  default_output_dir: string;
  configured_output_dir: string | null;
};

export function SettingsPanel({ onClose, onChange }: Props) {
  const { t } = useI18n();
  const [colors, setColors] = useState<ColorSettings>(() => loadColors());
  // Jobs output dir — persisted main-process side (userData/settings.json),
  // applied to the sidecar's --data-dir on next launch.
  const [dirInfo, setDirInfo] = useState<DirInfo | null>(null);
  const [dirNote, setDirNote] = useState<'' | 'saved' | 'failed'>('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    window.api?.getSettings?.().then(setDirInfo).catch(() => { /* non-electron env */ });
  }, []);

  const refreshDir = () => {
    window.api?.getSettings?.().then(setDirInfo).catch(() => { /* */ });
  };

  const pickOutputDir = async () => {
    try {
      const r = await window.api.pickOutputDir();
      if (!r.ok || !r.path) return; // cancelled
      const res = await window.api.setOutputDir(r.path);
      setDirNote(res.ok ? 'saved' : 'failed');
      if (res.ok) refreshDir();
    } catch { setDirNote('failed'); }
  };

  const resetOutputDir = async () => {
    try {
      const res = await window.api.setOutputDir(null);
      setDirNote(res.ok ? 'saved' : 'failed');
      if (res.ok) refreshDir();
    } catch { setDirNote('failed'); }
  };

  // Persist + bubble on every change.
  useEffect(() => {
    saveColors(colors);
    onChange?.(colors);
  }, [colors, onChange]);

  const update = (key: keyof ColorSettings, val: string) => {
    // Normalise: strip leading '#', lowercase, reject anything that isn't 6 hex.
    const v = val.replace(/^#/, '').toLowerCase();
    setColors((prev) => ({ ...prev, [key]: /^[0-9a-f]{6}$/.test(v) ? v : prev[key] }));
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-alt)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
          width: 'min(480px, calc(100vw - 48px))',
          boxShadow: '0 20px 50px var(--shadow)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>{t('settings.title')}</h2>
          <Tooltip text={t('settings.close')}>
            <button
              onClick={onClose}
              style={{
                background: 'transparent', color: 'var(--text-muted)',
                border: '1px solid var(--border)', borderRadius: 4,
                padding: '2px 10px', cursor: 'pointer', fontSize: 14,
              }}
            >
              ✕
            </button>
          </Tooltip>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* ── jobs output dir ──────────────────────────────────── */}
          <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 14, marginBottom: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 8 }}>
              📂 {t('settings.outputDir')}
              {dirInfo && dirInfo.configured_output_dir === null && (
                <span style={{
                  fontSize: 10, opacity: 0.7, border: '1px solid var(--border)',
                  borderRadius: 3, padding: '0 5px',
                }}>
                  {t('settings.outputDir.defaultTag')}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2, marginBottom: 8 }}>
              {t('settings.outputDir.desc')}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code
                title={dirInfo?.output_dir ?? ''}
                style={{
                  flex: 1, fontSize: 11, fontFamily: 'ui-monospace, monospace',
                  background: 'var(--bg-elev)', color: 'var(--text-muted)',
                  border: '1px solid var(--border)', borderRadius: 4,
                  padding: '4px 8px', overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {dirInfo?.output_dir ?? '…'}
              </code>
              <button
                onClick={pickOutputDir}
                style={{
                  background: 'var(--bg-elev)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 4,
                  padding: '4px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
                }}
              >
                📁 {t('settings.outputDir.pick')}
              </button>
              <button
                onClick={resetOutputDir}
                disabled={!dirInfo || dirInfo.configured_output_dir === null}
                style={{
                  background: 'var(--bg-elev)', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 4,
                  padding: '4px 12px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
                  opacity: dirInfo && dirInfo.configured_output_dir !== null ? 1 : 0.45,
                }}
              >
                ↺ {t('settings.outputDir.reset')}
              </button>
            </div>
            {dirNote === 'saved' && (
              <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6 }}>
                ✓ {t('settings.outputDir.saved')}
              </div>
            )}
            {dirNote === 'failed' && (
              <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 6 }}>
                ✗ {t('settings.outputDir.saveFailed')}
              </div>
            )}
          </div>

          <ColorRow
            label={t('settings.color_bbox')}
            desc={t('settings.color_bbox.desc')}
            value={colors.color_bbox}
            onChange={(v) => update('color_bbox', v)}
          />
          <ColorRow
            label={t('settings.color_pose_left')}
            desc={t('settings.color_pose_left.desc')}
            value={colors.color_pose_left}
            onChange={(v) => update('color_pose_left', v)}
          />
          <ColorRow
            label={t('settings.color_pose_right')}
            desc={t('settings.color_pose_right.desc')}
            value={colors.color_pose_right}
            onChange={(v) => update('color_pose_right', v)}
          />
          <ColorRow
            label={t('settings.color_pose_body')}
            desc={t('settings.color_pose_body.desc')}
            value={colors.color_pose_body}
            onChange={(v) => update('color_pose_body', v)}
          />
        </div>

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Tooltip text={t('settings.reset')}>
            <button
              onClick={() => setColors({ ...DEFAULT_COLORS })}
              style={{
                background: 'var(--bg-elev)', color: 'var(--text)',
                border: '1px solid var(--border)', borderRadius: 4,
                padding: '4px 12px', cursor: 'pointer', fontSize: 12,
              }}
            >
              ↺ {t('settings.reset')}
            </button>
          </Tooltip>
          <span style={{ fontSize: 11, opacity: 0.6 }}>{t('settings.savedNote')}</span>
        </div>
      </div>
    </div>
  );
}

function ColorRow({ label, desc, value, onChange }: {
  label: string; desc: string; value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 110px', gap: 10, alignItems: 'center' }}>
      <input
        type="color"
        value={'#' + value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 40, height: 32, padding: 0,
          background: 'transparent',
          border: '1px solid var(--border)', borderRadius: 4,
          cursor: 'pointer',
        }}
      />
      <div>
        <div style={{ fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{desc}</div>
      </div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={7}
        style={{
          background: 'var(--bg-elev)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 4,
          padding: '4px 8px',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          width: '100%',
        }}
      />
    </div>
  );
}
