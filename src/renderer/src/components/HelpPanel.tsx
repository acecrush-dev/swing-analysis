import { useEffect } from 'react';
import { useI18n } from '../i18n';

interface Props { onClose: () => void; }

/**
 * Help panel — overlaid modal showing parameter explanations, drag-
 * and-drop usage, menu map, and quick links to docs / GitHub. Closes
 * on Esc, on the backdrop click, or on the × button.
 */
export function HelpPanel({ onClose }: Props) {
  const { t } = useI18n();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
              width: 'min(720px, calc(100vw - 48px))',
              maxHeight: 'calc(100vh - 80px)',
              overflow: 'auto',
              boxShadow: '0 20px 50px var(--shadow)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>{t('help.title')}</h2>
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
            </div>

            <Section title={t('help.section.usage')}>
              <ul style={{ paddingLeft: 20, margin: '6px 0' }}>
                <li dangerouslySetInnerHTML={{ __html: t('help.item.pickVideo') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.params') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.start') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.previewClip') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.returnOriginal') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.export') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.dualBars') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.detach') }} />
              </ul>
            </Section>

            <Section title={t('help.section.params')}>
              <ParamTable rows={[
                ['v_swing', 'Cut threshold (wrist speed)', 'Higher = looser; lower = more fragments'],
                ['gap_merge', 'Merge gap (s) between adjacent swings', 'Two segments < this apart merge'],
                ['max_bridge', 'Bridge upper bound (s)', 'A break longer than this starts a new segment'],
                ['min_peak', 'Min peak height', 'Peaks below this are not counted as swings'],
                ['smooth_alpha', 'EMA smoothing', 'Higher = tighter follow; lower = more lag'],
                ['max_lost_frames', 'Lost-frame tolerance', 'Bridges wrist losses ≤ this many frames'],
                ['min_dur / max_dur', 'Segment duration bounds', 'Out-of-range segments are dropped / merged'],
                ['buf_before / buf_after', 'Pre/post buffer (s)', 'Clip start/end extend by this much'],
                ['skip', 'Sampling step', 'Run pose detection every N frames'],
                ['max_frames', 'Max frames', '0 = all; >0 = only first N'],
                ['save_clips', 'Save per-segment clip mp4', 'Required for the clips bar'],
                ['viz_video', 'Render whole viz.mp4', 'Required for «Play viz.mp4»'],
                ['clip_bbox', 'Overlay RTMDet bbox on clips', 'Needs save_clips too'],
                ['clip_skel', 'Overlay skeleton on clips', 'Needs save_clips too'],
                ['skel_backend', 'Skeleton backend', 'rtmpose (fast / COCO-13) or mediapipe (precise / 33 pts)'],
              ]} />
            </Section>

            <Section title={t('help.section.menu')}>
              <ul style={{ paddingLeft: 20, margin: '6px 0' }}>
                <li dangerouslySetInnerHTML={{ __html: t('help.item.menu.open') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.menu.export') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.menu.quit') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.menu.help') }} />
                <li dangerouslySetInnerHTML={{ __html: t('help.item.menu.about') }} />
              </ul>
            </Section>

            <Section title={t('help.section.tips')}>
              <ul style={{ paddingLeft: 20, margin: '6px 0' }}>
                <li>{t('help.tip.cleanup')}</li>
                <li>{t('help.tip.heads')}</li>
                <li>{t('help.tip.badext')}</li>
                <li>{t('help.tip.theme')}</li>
              </ul>
            </Section>

            <div style={{ marginTop: 16, textAlign: 'right', fontSize: 12, color: 'var(--text-dim)' }}>
              {t('help.close')}
            </div>
          </div>
        </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--accent)' }}>{title}</h3>
      <div style={{ fontSize: 13, lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

function ParamTable({ rows }: { rows: [string, string, string][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 4 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>Name</th>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>Meaning</th>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>Advice</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([n, m, s]) => (
          <tr key={n} style={{ borderBottom: '1px dashed var(--border-soft)' }}>
            <td style={{ padding: '4px 6px', fontFamily: 'ui-monospace, monospace', color: 'var(--accent)' }}>{n}</td>
            <td style={{ padding: '4px 6px' }}>{m}</td>
            <td style={{ padding: '4px 6px', color: 'var(--text-muted)' }}>{s}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
