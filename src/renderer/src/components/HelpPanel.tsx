import { useEffect } from 'react';
import { useI18n } from '../i18n';

interface Props { onClose: () => void; }

// Stable order of rows in the help table. Each ID maps to three
// i18n keys under `help.params.<id>.{name,meaning,advice}`. Adding a
// new parameter: append the ID here + three new strings in BOTH `en`
// and `zh` in i18n.ts; the table re-renders automatically.
const PARAM_ROW_IDS = [
  'v_swing',
  'gap_merge',
  'max_bridge',
  'min_peak',
  'smooth_alpha',
  'max_lost_frames',
  'min_dur_max_dur',
  'buf_before_buf_after',
  'skip',
  'max_frames',
  'save_clips',
  'viz_video',
  'clip_bbox',
  'clip_skel',
  'skel_backend',
] as const;

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

  const paramRows: [string, string, string][] = PARAM_ROW_IDS.map((id) => [
    t(`help.params.${id}.name`),
    t(`help.params.${id}.meaning`),
    t(`help.params.${id}.advice`),
  ]);

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
              <ParamTable rows={paramRows}
                          colName={t('help.params.col.name')}
                          colMeaning={t('help.params.col.meaning')}
                          colAdvice={t('help.params.col.advice')} />
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

function ParamTable({ rows, colName, colMeaning, colAdvice }: {
  rows: [string, string, string][];
  colName: string; colMeaning: string; colAdvice: string;
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 4 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>{colName}</th>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>{colMeaning}</th>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>{colAdvice}</th>
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
