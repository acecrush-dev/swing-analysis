import type { JobParams } from '../api/types';
import { useI18n } from '../i18n';

interface Props {
  params: JobParams; onChange: (p: JobParams) => void; disabled?: boolean;
  /** plan 008 M3 — 'ts' greys out params the in-renderer pipeline can't
   *  use yet (sidecar-only knobs) with a hint tooltip. undefined/'python'
   *  keeps the form byte-identical to the pre-008 behaviour. */
  backendMode?: 'python' | 'ts';
}

interface FieldDef {
  key: keyof JobParams;
  i18nKey: string;          // i18n key for the row label, e.g. 'params.v_swing'
  step: number; min?: number; max?: number;
  /** ts-inert: this knob only affects the python sidecar pipeline. */
  tsInert?: boolean;
}

// Single source of truth for which JobParams are scalar-number fields.
// `save_clips` / `viz_video` / `clip_bbox` / `clip_skel` / `skel_backend`
// are handled separately because they need different controls.
const NUMBER_FIELDS: FieldDef[] = [
  { key: 'v_swing',         i18nKey: 'params.v_swing',         step: 0.01, min: 0, max: 1, tsInert: true },
  { key: 'gap_merge',       i18nKey: 'params.gap_merge',       step: 0.1,  min: 0 },
  { key: 'max_bridge',      i18nKey: 'params.max_bridge',      step: 0.1,  min: 0, tsInert: true },
  { key: 'min_peak',        i18nKey: 'params.min_peak',        step: 0.05, min: 0 },
  { key: 'smooth_alpha',    i18nKey: 'params.smooth_alpha',    step: 0.05, min: 0, max: 1 },
  { key: 'max_lost_frames', i18nKey: 'params.max_lost_frames', step: 1,    min: 0, tsInert: true },
  { key: 'min_dur',         i18nKey: 'params.min_dur',         step: 0.05, min: 0 },
  { key: 'max_dur',         i18nKey: 'params.max_dur',         step: 0.5,  min: 0 },
  { key: 'buf_before',      i18nKey: 'params.buf_before',      step: 0.1,  min: 0 },
  { key: 'buf_after',       i18nKey: 'params.buf_after',       step: 0.1,  min: 0 },
  { key: 'skip',            i18nKey: 'params.skip',            step: 1,    min: 1 },
  { key: 'max_frames',      i18nKey: 'params.max_frames',      step: 100,  min: 0 },
];

export function ParamsForm({ params, onChange, disabled, backendMode }: Props) {
  const { t } = useI18n();
  const isTs = backendMode === 'ts';
  return (
    <fieldset disabled={disabled} style={{ border: '1px solid #333', padding: 12, margin: 0, borderBottom: 0 }}>
      <legend style={{ padding: '0 6px' }}>⚙️ {t('params.title')}</legend>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 6, fontSize: 13 }}>
        {NUMBER_FIELDS.map((f) => {
          const label = isTs && f.tsInert
            ? (
              <span style={{ opacity: 0.5 }} title={t('params.tsInertHint')}>
                {t(f.i18nKey)} <span aria-hidden>ⓘ</span>
              </span>
            )
            : t(f.i18nKey);
          return (
            <Row key={f.key} label={label} step={f.step} min={f.min} max={f.max}
                 inputDisabled={isTs && f.tsInert}
                 inputTitle={isTs && f.tsInert ? t('params.tsInertHint') : undefined}
                 value={params[f.key] as number}
                 onChange={(v) => onChange({ ...params, [f.key]: v })} />
          );
        })}
        <label style={{ gridColumn: '1 / 3', marginTop: 4 }}>
          <input type="checkbox" checked={params.save_clips}
                 onChange={(e) => onChange({ ...params, save_clips: e.target.checked })} />
          {' '}{t('params.save_clips')}
        </label>
        <label style={{ gridColumn: '1 / 3' }}>
          <input type="checkbox" checked={params.viz_video}
                 onChange={(e) => onChange({ ...params, viz_video: e.target.checked })} />
          {' '}{t('params.viz_video')}
        </label>
        <fieldset style={{ gridColumn: '1 / 3', border: '1px solid #333', borderRadius: 4, padding: 6, marginTop: 4, opacity: isTs ? 0.5 : undefined }}>
          <legend style={{ padding: '0 4px', fontSize: 12 }} title={isTs ? t('params.tsInertHint') : undefined}>
            {t('params.clip_section')}{isTs ? ' ⓘ' : ''}
          </legend>
          <label style={{ display: 'block' }}>
            <input type="checkbox" checked={params.clip_bbox} disabled={!params.save_clips || isTs}
                   onChange={(e) => onChange({ ...params, clip_bbox: e.target.checked })} />
            {' '}{t('params.clip_bbox')}
          </label>
          <label style={{ display: 'block' }}>
            <input type="checkbox" checked={params.clip_skel} disabled={!params.save_clips || isTs}
                   onChange={(e) => onChange({ ...params, clip_skel: e.target.checked })} />
            {' '}{t('params.clip_skel')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>{t('params.skel_backend')}</span>
            <select value={params.skel_backend} disabled={!params.save_clips || !params.clip_skel || isTs}
                    onChange={(e) => onChange({ ...params, skel_backend: e.target.value as 'rtmpose' | 'mediapipe' })}
                    style={{ background: '#222', color: '#eee', border: '1px solid #444', padding: '2px 4px' }}>
              <option value="rtmpose">{t('params.skel_rtmpose')}</option>
              <option value="mediapipe">{t('params.skel_mediapipe')}</option>
            </select>
          </label>
        </fieldset>
      </div>
    </fieldset>
  );
}

function Row({ label, value, onChange, step, min, max, inputDisabled, inputTitle }: { label: React.ReactNode; value: number; onChange: (v: number) => void; step: number; min?: number; max?: number; inputDisabled?: boolean; inputTitle?: string; }) {
  return (
    <>
      <label>{label}</label>
      <input type="number" value={value} step={step} min={min} max={max} disabled={inputDisabled}
             title={inputTitle}
             onChange={(e) => onChange(Number(e.target.value))}
             style={{ background: '#222', color: '#eee', border: '1px solid #444', padding: '2px 4px' }} />
    </>
  );
}
