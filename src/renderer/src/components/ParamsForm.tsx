import type { JobParams } from '../api/types';

interface Props { params: JobParams; onChange: (p: JobParams) => void; disabled?: boolean; }

const FIELDS: Array<{ key: keyof JobParams; label: string; step: number; min?: number; max?: number }> = [
  { key: 'v_swing', label: 'v_swing (活动阈值)', step: 0.01, min: 0, max: 1 },
  { key: 'gap_merge', label: 'gap_merge (真静止合并, s)', step: 0.1, min: 0 },
  { key: 'max_bridge', label: 'max_bridge (漏检合并, s)', step: 0.1, min: 0 },
  { key: 'min_peak', label: 'min_peak (峰值下限)', step: 0.05, min: 0 },
  { key: 'smooth_alpha', label: 'smooth_alpha (EMA)', step: 0.05, min: 0, max: 1 },
  { key: 'max_lost_frames', label: 'max_lost_frames', step: 1, min: 0 },
  { key: 'min_dur', label: 'min_dur (s)', step: 0.05, min: 0 },
  { key: 'max_dur', label: 'max_dur (s)', step: 0.5, min: 0 },
  { key: 'buf_before', label: 'buf_before (s)', step: 0.1, min: 0 },
  { key: 'buf_after', label: 'buf_after (s)', step: 0.1, min: 0 },
  { key: 'skip', label: 'skip (采样步长)', step: 1, min: 1 },
  { key: 'max_frames', label: 'max_frames (0=全部)', step: 100, min: 0 },
];

export function ParamsForm({ params, onChange, disabled }: Props) {
  return (
    <fieldset disabled={disabled} style={{ border: '1px solid #333', padding: 12, margin: 0, borderBottom: 0 }}>
      <legend style={{ padding: '0 6px' }}>⚙️ 参数</legend>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 6, fontSize: 13 }}>
        {FIELDS.map((f) => (
          <Row key={f.key} label={f.label} step={f.step} min={f.min} max={f.max}
               value={params[f.key] as number}
               onChange={(v) => onChange({ ...params, [f.key]: v })} />
        ))}
        <label style={{ gridColumn: '1 / 3', marginTop: 4 }}>
          <input type="checkbox" checked={params.save_clips}
                 onChange={(e) => onChange({ ...params, save_clips: e.target.checked })} />
          {' '}切出每段 clip mp4
        </label>
        <label style={{ gridColumn: '1 / 3' }}>
          <input type="checkbox" checked={params.viz_video}
                 onChange={(e) => onChange({ ...params, viz_video: e.target.checked })} />
          {' '}生成 viz.mp4 (彩色相位条)
        </label>
        <fieldset style={{ gridColumn: '1 / 3', border: '1px solid #333', borderRadius: 4, padding: 6, marginTop: 4 }}>
          <legend style={{ padding: '0 4px', fontSize: 12 }}>clip 标注</legend>
          <label style={{ display: 'block' }}>
            <input type="checkbox" checked={params.clip_bbox} disabled={!params.save_clips}
                   onChange={(e) => onChange({ ...params, clip_bbox: e.target.checked })} />
            {' '}RTMDet bbox 框
          </label>
          <label style={{ display: 'block' }}>
            <input type="checkbox" checked={params.clip_skel} disabled={!params.save_clips}
                   onChange={(e) => onChange({ ...params, clip_skel: e.target.checked })} />
            {' '}姿态骨架
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.8 }}>骨架 backend:</span>
            <select value={params.skel_backend} disabled={!params.save_clips || !params.clip_skel}
                    onChange={(e) => onChange({ ...params, skel_backend: e.target.value as 'rtmpose' | 'mediapipe' })}
                    style={{ background: '#222', color: '#eee', border: '1px solid #444', padding: '2px 4px' }}>
              <option value="rtmpose">RTMPose (COCO-13)</option>
              <option value="mediapipe">MediaPipe (33 点)</option>
            </select>
          </label>
        </fieldset>
      </div>
    </fieldset>
  );
}

function Row({ label, value, onChange, step, min, max }: { label: string; value: number; onChange: (v: number) => void; step: number; min?: number; max?: number; }) {
  return (
    <>
      <label>{label}</label>
      <input type="number" value={value} step={step} min={min} max={max}
             onChange={(e) => onChange(Number(e.target.value))}
             style={{ background: '#222', color: '#eee', border: '1px solid #444', padding: '2px 4px' }} />
    </>
  );
}