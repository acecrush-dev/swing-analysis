import { useEffect } from 'react';

interface Props { onClose: () => void; }

/**
 * Help panel — overlaid modal showing parameter explanations, drag-
 * and-drop usage, menu map, and quick links to docs / GitHub. Closes
 * on Esc, on the backdrop click, or on the × button.
 */
export function HelpPanel({ onClose }: Props) {
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
              <h2 style={{ margin: 0, fontSize: 18 }}>❓ 帮助 / 参数说明</h2>
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

            <Section title="🛠 用法速览">
              <ul style={{ paddingLeft: 20, margin: '6px 0' }}>
                <li><b>选视频</b>：点「📁 选择视频…」按钮，或直接把视频文件拖到窗口里。窗口在拖动过程中会变黄，提示拖入位置。</li>
                <li><b>配参数</b>：右侧「参数」面板设置切分算法参数。</li>
                <li><b>开始切分</b>：点「▶ 开始切分」。进度条和事件日志实时更新。</li>
                <li><b>预览 clip</b>：完成后底部「Clips」区会逐个冒出缩略图卡片，点击卡片左上的黄字水印标记当前正在播的 clip。</li>
                <li><b>回原视频</b>：点水印上的「↩ 回原始视频」按钮（或选周期列表里的 segment）。</li>
                <li><b>导出包</b>：菜单 File → Export Package… 把 segments.json + clips + viz.mp4 打成 zip。</li>
                <li><b>双进度条</b>：勾选「clip 叠加 RTMDet 人物框」或「clip 叠加骨架」后，进度区会出现两行 — 外层是 clip 队列（已完成/已发现），内层是当前 clip 的标注逐帧进度（每 5 帧刷新一次）。全部完成或 job 结束后两行自动收起。</li>
              </ul>
            </Section>

            <Section title="🎛 参数说明">
              <ParamTable rows={[
                ['v_swing', '切分判定阈值（手腕速度）', '越大越宽松；越小越容易切碎'],
                ['gap_merge', '两段距离多近则合并', '单位 s。相邻两段 < 该值合并为一段'],
                ['max_bridge', '间断桥接上限', '单位 s。中断超过此值视为新段'],
                ['min_peak', '波峰最小高度', '低于此值的速度峰值不算挥拍'],
                ['smooth_alpha', 'EMA 平滑系数', '越大跟随越紧；越小越滞后'],
                ['max_lost_frames', '丢失帧容忍', 'wrist 连续丢失 ≤ 此值仍桥接'],
                ['min_dur / max_dur', '段时长上下限', '单位 s。超出会被丢弃或合并'],
                ['buf_before / buf_after', '段前后缓冲', '单位 s。clip 起始/结束各延伸该值'],
                ['skip', '采样步长', '每 N 帧跑一次 pose detection'],
                ['max_frames', '最大帧数', '0 = 全跑；>0 = 只跑前 N 帧'],
                ['save_clips', '切出每段 clip mp4', '✅ 勾选才能在底部看到 clips'],
                ['viz_video', '生成整段 viz.mp4', '勾选后才能用「播放 viz.mp4」按钮'],
                ['clip_bbox', 'clip 叠加 RTMDet 人物框', '需要 save_clips 同时勾'],
                ['clip_skel', 'clip 叠加骨架', '需要 save_clips 同时勾'],
                ['skel_backend', '骨架后端', 'rtmpose（快/COCO-13）或 mediapipe（准/33 点）'],
              ]} />
            </Section>

            <Section title="🧰 菜单">
              <ul style={{ paddingLeft: 20, margin: '6px 0' }}>
                <li><b>System → Open File…</b>（Ctrl/Cmd+O）：选视频。</li>
                <li><b>System → Export Package…</b>（Ctrl/Cmd+E）：把当前 job 打成 zip。</li>
                <li><b>System → Quit</b>（Ctrl/Cmd+Q / Alt+F4）：退出。</li>
                <li><b>Help → Help Content</b>：跳到文档站 / 项目主页。</li>
                <li><b>Help → About swing-analysis</b>：软件名 + 版本信息。</li>
              </ul>
            </Section>

            <Section title="💡 提示">
              <ul style={{ paddingLeft: 20, margin: '6px 0' }}>
                <li>切分运行中「🧹 清理」按钮会自动灰掉 —— clips 还在生成。</li>
                <li>viz / segments.json / clips/ 下载链接只在文件真正写盘后才显示（HEAD 探测）。</li>
                <li>拖入非视频文件会弹错「不是视频文件（.ext）…」并保持原选择不变。</li>
                <li>暗/亮主题切换在右上角 🌙/☀️ —— 状态徽章在两种主题下都保持高对比。</li>
              </ul>
            </Section>

            <div style={{ marginTop: 16, textAlign: 'right', fontSize: 12, color: 'var(--text-dim)' }}>
              按 Esc 或点空白处关闭
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
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>名称</th>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>含义</th>
          <th style={{ textAlign: 'left', padding: '4px 6px', color: 'var(--text-muted)' }}>建议</th>
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