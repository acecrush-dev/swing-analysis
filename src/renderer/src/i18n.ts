/**
 * Tiny i18n layer — no runtime deps.
 *
 * Scope: GUI chrome only (button tooltips, panel headers, log
 * placeholder, menu labels). Backend strings and Python log lines are
 * untouched — those flow through unchanged.
 *
 * Locale resolution order:
 *   1. localStorage['swing.locale'] (if set)
 *   2. navigator.language prefix → 'zh' if starts with 'zh', else 'en'
 *
 * Add a key to both `en` and `zh` dictionaries below; missing keys
 * fall back to English, then to the key itself (so the UI never
 * crashes on a missing string).
 *
 * The module publishes a `localechange` CustomEvent on `window` when
 * the locale flips; `useI18n()` subscribes to it so components re-
 * render automatically.
 */

export type Locale = 'en' | 'zh';

const STORAGE_KEY = 'swing.locale';

const en: Record<string, string> = {
  // App shell
  'app.title': '🎾 swing-analysis',
  'app.theme.toDark': 'Current: dark mode (click to switch to light)',
  'app.theme.toLight': 'Current: light mode (click to switch to dark)',
  'app.locale.switch': 'Switch language',
  'app.help': 'Help / parameter reference',
  'app.dropHint': 'Drop a video file to load it',

  // Buttons (icon-only — full strings go to title tooltips)
  'btn.detach': 'Pop into independent OS window (drag past the main app)',
  'btn.recall': 'Recall panel to main window',
  'btn.cleanup': 'Delete all clips of this job',
  'btn.cleanupDisabled': 'Job is running — clips are still being generated',
  'btn.clearLog': 'Clear log',
  'btn.floating': 'Float in window (draggable)',
  'btn.dock': 'Dock back to position',

  // ClipsBar
  'clips.title': '🎬 Clips',
  'clips.detachedPlaceholder': '🎬 Clips popped into separate window',
  'clips.empty.runningNoSave': 'Parameter «Save each clip mp4» is off — tick it and re-run.',
  'clips.empty.running': 'Waiting for job to finish — first-frame previews will appear here.',
  'clips.empty.doneNoSave': 'Parameter «Save each clip mp4» is off — tick it and re-run.',
  'clips.empty.doneNoSeg': 'No clips generated (no segments detected). Try a video with swings.',

  // Log
  'log.title': '📜 Event log',
  'log.detachedPlaceholder': '📜 Event log popped into separate window',
  'log.empty': '(no events yet)',

  // ResultsPanel footer
  'viz.play': 'Play viz.mp4 in video area',
  'viz.exit': '◼ Exit viz',
  'viz.unavailable': 'viz.mp4 not on disk yet (job not finished or viz disabled)',
  'dl.segments': '⬇ segments.json',
  'dl.viz': '⬇ viz.mp4',
  'btn.openDir': 'Open job output directory',
  'btn.openDir.fail': 'Failed to open directory: ',
  'btn.export': 'Export',
  'btn.export.disabled': 'No active job',
  'btn.export.title': 'Zip segments.json + clips + viz.mp4',
  'btn.deleteJob': '🗑 Delete job',
  'btn.deleteJob.disabled': 'No active job',
  'btn.deleteJob.title': 'Delete the entire job (wipes clips / viz.mp4 / segments.json)',

  // HelpPanel
  'help.title': '❓ Help / parameter reference',
  'help.section.usage': '🛠 Quick reference',
  'help.item.pickVideo': '<b>Pick video</b>: click «📁 Pick video…», or drag a video file onto the window. The window flashes yellow while a drag is hovering.',
  'help.item.params': '<b>Parameters</b>: right-side «Parameters» panel tunes the segmentation algorithm.',
  'help.item.start': '<b>Start</b>: click «▶ Start». Progress bar and event log update live.',
  'help.item.previewClip': '<b>Preview clip</b>: once a job finishes, thumbnails pop in at the bottom. Click one to play.',
  'help.item.returnOriginal': '<b>Return to original</b>: click «↩ Return to original» on the watermark (or pick a segment from the list).',
  'help.item.export': '<b>Export</b>: File → Export Package… zips segments.json + clips + viz.mp4.',
  'help.item.dualBars': '<b>Dual progress bars</b>: when «clip bbox» or «clip skeleton» is on, two stacked rows appear — outer clip queue, inner per-clip annotation progress (refreshes every 5 frames).',
  'help.item.detach': '<b>Detach panels</b>: the «↗» buttons on the clips bar and event log pop them into independent OS windows (DevTools-style undock) — draggable past the main window, with bidirectional state sync. Position/size persist across restarts; «📍» recalls them.',
  'help.section.params': '🎛 Parameters',
  'help.section.menu': '🧰 Menu',
  'help.item.menu.open': '<b>System → Open File…</b> (Ctrl/Cmd+O): pick a video.',
  'help.item.menu.export': '<b>System → Export Package…</b> (Ctrl/Cmd+E): zip the current job.',
  'help.item.menu.quit': '<b>System → Quit</b> (Ctrl/Cmd+Q / Alt+F4): exit.',
  'help.item.menu.help': '<b>Help → Help Content</b>: open docs / project home.',
  'help.item.menu.about': '<b>Help → About swing-analysis</b>: name + version info.',
  'help.section.tips': '💡 Tips',
  'help.tip.cleanup': 'During a running job the «🧹» button is greyed out — clips are still being generated.',
  'help.tip.heads': 'viz / segments.json / open-dir only show once the artifact is confirmed on disk (HEAD probe).',
  'help.tip.badext': 'Dropping a non-video file shows «Not a video file (.ext)…» and keeps your current selection.',
  'help.tip.theme': '🌙/☀️ toggle in the top-right; the state badge keeps high contrast in both themes.',
  'help.close': 'Press Esc or click outside to close',

  // Misc
  'placeholder.waitSidecar': '⏳ Waiting for sidecar service…',
  'placeholder.waitMain': '⏳ Waiting for main window state…',
  'status.deleted': '🗑 job {id} deleted',
  'status.deleteFail': '✗ delete failed: {err}',
  'status.deletedBusy': 'Cannot delete a running job — cancel first',
  'status.confirmDeleteJob': 'Delete the entire job? All clips and viz.mp4 will be wiped from disk (backend/data/jobs/{id}/).',
  'status.cancelSent': '⊘  cancel request sent',
  'status.cancelFail': '✗ cancel failed: {err}',
  'status.createFail': '✗ create failed: {err}',
  'status.cleanupDone': '🧹 cleared {n} clips ({kb} KB)',
  'status.cleanupFail': '✗ cleanup failed: {err}',
  'status.confirmCleanup': 'Delete all clips of this job?',
  'status.opened': '📦 exported job package: {path}',
  'status.exportFail': 'Export failed: {err}',
  'status.noExport': 'No job to export',
  'status.noExportApi': 'Current environment does not support export (preload did not expose exportPackage)',
  'status.jobDone': '✓ job done · {n} segments',
  'status.jobFail': '✗ job failed: {err}',
  'status.jobCancel': '⊘ job cancelled',
  'status.wsReconnect': '↻ WS reconnected · state={state} · {n} segments',
  'status.dropped': '📂 dropped video: {path}',
  'status.noDropPath': 'Cannot resolve dropped file absolute path — use «Pick video…» instead',
  'status.badExt': 'Not a video file (.{ext}). Please drop a video: {list}.',
  'status.multiDrop': 'Drop one video at a time',
  'status.noFile': 'No file received',
  'status.menuOpened': '📁 menu open file: {path}',
  'status.jobStart': '▶ job {id} created · save_clips={flag}',
  'status.poseProgress': '  pose {frames}/{total} · {fps} fps · emit={emit}',
  'status.segmentEmitted': '✂ segment #{id} {start} → {end} · contact @ {contact}',
  'status.clipAnnotated': '🎯 clip #{id} annotation done',
  'status.clipGenerated': '🎬 clip #{id} generated {h264}',
  'status.h264Yes': ' (H.264 ✓)',
  'status.h264No': ' (mp4v only)',
  'status.err.createFail': 'create failed: {err}',
  'status.err.listClips': 'listClips: {err}',
  'status.err.getServiceInfo': 'getServiceInfo failed: {err}',
  'status.err.droppedPath': 'Cannot resolve dropped file absolute path — use «Pick video…» instead',
  'status.dropActive': 'Drop a video file to load it',
  'status.waitSidecar': '⏳ Waiting for sidecar service…',
  'status.outputCleared': '🧹 cleared output dir ({path}) · {n} job(s) wiped',
  'status.clearOutputFail': 'Clear output dir failed: {err}',
  'menu.file': 'File',
  'menu.openFile': 'Open File…',
  'menu.export': 'Export Package…',
  'menu.clearJob': 'Clear Current Job Dir',
  'menu.clearOutput': 'Clear Output Dir…',
  'menu.quit': 'Quit',
  'menu.help': 'Help',
  'menu.helpContent': 'Help Content',
  'menu.about': 'About swing-analysis',
  'menu.confirm.clearJob': 'Clear the directory of the current job? All clips / viz.mp4 / segments.json will be wiped from disk.',
  'menu.confirm.clearOutput': 'Clear the entire output directory? This will wipe EVERY job on disk (segments.json / clips / viz.mp4).',

  // ParamsForm
  'params.title': 'Parameters',
  'params.v_swing': 'v_swing (active threshold)',
  'params.gap_merge': 'gap_merge (true-stillness merge, s)',
  'params.max_bridge': 'max_bridge (missed-frame bridge, s)',
  'params.min_peak': 'min_peak (peak floor)',
  'params.smooth_alpha': 'smooth_alpha (EMA)',
  'params.max_lost_frames': 'max_lost_frames',
  'params.min_dur': 'min_dur (s)',
  'params.max_dur': 'max_dur (s)',
  'params.buf_before': 'buf_before (s)',
  'params.buf_after': 'buf_after (s)',
  'params.skip': 'skip (sampling step)',
  'params.max_frames': 'max_frames (0 = all)',
  'params.save_clips': 'Save each clip mp4',
  'params.viz_video': 'Render viz.mp4 (colored phase bars)',
  'params.clip_section': 'Clip annotation',
  'params.clip_bbox': 'RTMDet bbox overlay',
  'params.clip_skel': 'Pose skeleton',
  'params.skel_backend': 'Skeleton backend:',
  'params.skel_rtmpose': 'RTMPose (COCO-13)',
  'params.skel_mediapipe': 'MediaPipe (33 pts)',

  // ProgressPanel
  'progress.start': '▶ Start',
  'progress.cancel': '⊘ Cancel',
  'progress.startDisabled': 'Pick a video first',
  'progress.cancelTip': 'Send cancel request to the running job',
  'progress.eta': 'ETA {sec}s',
  'progress.frames': '{done}/{total} frames',
  'progress.fps': '{fps} fps',
  'progress.segments': '{n} segments emitted',
  'progress.queue': '🎬 clips {done}/{discovered} done',
  'progress.processingFmt': 'processing {ids}',
  'progress.waitingClip': '🎬 waiting for clips…',
  'progress.waiting': 'Waiting to start…',
  'progress.doneFmt': 'Done · {n} segments',
  'progress.annotating': 'clip #{id} · {stage} · {frame}/{total}',
  'progress.stage.rtmdet': 'RTMDet',
  'progress.stage.pose': 'pose skeleton',
  'progress.stage.rtmdet+pose': 'RTMDet+pose',

  'state.idle': 'idle',
  'state.queued': 'queued',
  'state.running': 'running',
  'state.done': 'done',
  'state.failed': 'failed',
  'state.cancelled': 'cancelled',

  // ClipPlayer
  'player.original': '↩ Original',
  'player.clip': '▶ Clip',
  'player.viz': '🎬 viz.mp4',
  'player.clipOrig': 'Clip #{id} (original codec — non-seekable)',
  'player.return': 'Return to original video',
  'player.contactAt': 'contact {tc}',

  // VideoPicker
  'picker.pickVideo': 'Pick video…',
  'picker.empty': 'Pick a video file, or pick a clip / viz to view.',

  // ClipGrid
  'grid.fallback': '(no segment metadata)',
  'grid.overLong': '⚠ over_long',
  'grid.merged': '(merged {n} intervals)',
  'grid.fmtWarn': '⚠ original codec',
  'grid.playing': '▶ playing',
  'grid.contactPeak': 'contact @ {contact} · peak {peak} · dur {dur}s',
  'grid.thumbAlt': 'clip {id} first frame',
  'grid.titleFmt': 'clip #{id} · {start} → {end}',

  // Toast kinds
  'toast.jobDone': '✓ Job done · {n} segments',
  'toast.jobFail': '✗ Job failed: {err}',
  'toast.jobCancel': '⊘ Job cancelled',
  'toast.cleanupCancelFirst': 'Please cancel the running job before clearing clips.',
  'toast.cleared': '✓ Cleared {n} clip(s) ({kb} KB)',
  'toast.deleted': '✓ Job deleted',
  'toast.deleteBusy': 'Cannot delete a {state} job — cancel or wait for it to finish first.',
  'toast.exportBusy': 'Cannot export a {state} job — cancel or wait for it to finish first.',
  'toast.cleanupBusy': 'Cannot clean clips while job is {state} — cancel or wait first.',
  'toast.cancelSent': '⊘ Cancel request sent — the job stops in a moment.',

  // Settings
  'app.settings': 'Settings',
  'settings.title': '⚙ Settings — annotation colours',
  'settings.close': 'Close',
  'settings.reset': 'Reset to defaults',
  'settings.savedNote': 'Saved automatically · applied to next job',
  'settings.outputDir': 'Jobs output directory',
  'settings.outputDir.desc': 'Where clips & job data are written (under a jobs/ subfolder). Restart the app to apply.',
  'settings.outputDir.pick': 'Choose…',
  'settings.outputDir.reset': 'Restore default',
  'settings.outputDir.saved': 'Saved — restart the app to apply.',
  'settings.outputDir.saveFailed': 'Save failed',
  'settings.outputDir.defaultTag': 'default',
  'settings.color_bbox': 'RTMDet bbox colour',
  'settings.color_bbox.desc': 'Rectangle drawn around each detected person',
  'settings.color_pose_left': 'Pose — left side',
  'settings.color_pose_left.desc': 'Left hand · arm · upper/lower leg · foot',
  'settings.color_pose_right': 'Pose — right side',
  'settings.color_pose_right.desc': 'Right hand · arm · upper/lower leg · foot',
  'settings.color_pose_body': 'Pose — body (trunk)',
  'settings.color_pose_body.desc': 'Nose / eyes / shoulders / hips etc.',
};

const zh: Record<string, string> = {
  'app.title': '🎾 swing-analysis',
  'app.theme.toDark': '当前：深色模式（点击切换到浅色）',
  'app.theme.toLight': '当前：浅色模式（点击切换到深色）',
  'app.locale.switch': '切换语言',
  'app.help': '帮助 / 参数说明',
  'app.dropHint': '拖入视频文件即可载入',

  'btn.detach': '分离为独立 OS 窗口（可拖出主程序）',
  'btn.recall': '收回面板到主窗口',
  'btn.cleanup': '删除该 job 的全部 clips',
  'btn.cleanupDisabled': '切分进行中，clips 还在生成 —— 不能清理',
  'btn.clearLog': '清空日志',
  'btn.floating': '悬浮显示（可拖动）',
  'btn.dock': '停靠回原位',

  'clips.title': '🎬 Clips',
  'clips.detachedPlaceholder': '🎬 Clips 已分离到独立窗口',
  'clips.empty.runningNoSave': '参数区未勾选「切出每段 clip mp4」——勾上后重新跑一次即可。',
  'clips.empty.running': '等待 job 完成 —— 完成后这里会显示每个 clip 的第一帧预览卡片。',
  'clips.empty.doneNoSave': '参数区未勾选「切出每段 clip mp4」——勾上后重新跑一次即可。',
  'clips.empty.doneNoSeg': '本次未生成任何 clip（可能没切到段）。重新跑一段能产生 segments 的视频试试。',

  'log.title': '📜 事件日志',
  'log.detachedPlaceholder': '📜 事件日志已分离到独立窗口',
  'log.empty': '（暂无事件）',

  'viz.play': '在视频区域播放整段 viz.mp4',
  'viz.exit': '◼ 退出 viz',
  'viz.unavailable': 'viz.mp4 不存在（job 还没完成或没勾生成 viz）',
  'dl.segments': '⬇ segments.json',
  'dl.viz': '⬇ viz.mp4',
  'btn.openDir': '在系统文件管理器中打开本 job 的输出目录',
  'btn.openDir.fail': '打开目录失败：',
  'btn.export': '📦 导出',
  'btn.export.disabled': '没有可导出的 job',
  'btn.export.title': '把当前 job 的 segments.json + clips + viz.mp4 打成 zip',
  'btn.deleteJob': '🗑 删除 job',
  'btn.deleteJob.disabled': '没有可删除的 job',
  'btn.deleteJob.title': '删除整个 job（清空所有 clips / viz.mp4 / segments.json）',

  'help.title': '❓ 帮助 / 参数说明',
  'help.section.usage': '🛠 用法速览',
  'help.item.pickVideo': '<b>选视频</b>：点「📁 选择视频…」按钮，或直接把视频文件拖到窗口里。窗口在拖动过程中会变黄，提示拖入位置。',
  'help.item.params': '<b>配参数</b>：右侧「参数」面板设置切分算法参数。',
  'help.item.start': '<b>开始切分</b>：点「▶ 开始切分」。进度条和事件日志实时更新。',
  'help.item.previewClip': '<b>预览 clip</b>：完成后底部「Clips」区会逐个冒出缩略图卡片，点击卡片左上的黄字水印标记当前正在播的 clip。',
  'help.item.returnOriginal': '<b>回原视频</b>：点水印上的「↩ 回原始视频」按钮（或选周期列表里的 segment）。',
  'help.item.export': '<b>导出包</b>：菜单 File → Export Package… 把 segments.json + clips + viz.mp4 打成 zip。',
  'help.item.dualBars': '<b>双进度条</b>：勾选「clip 叠加 RTMDet 人物框」或「clip 叠加骨架」后，进度区会出现两行 — 外层是 clip 队列（已完成/已发现），内层是当前 clip 的标注逐帧进度（每 5 帧刷新一次）。',
  'help.item.detach': '<b>分离面板</b>：Clips 条与事件日志的「↗」按钮可把它们弹成独立 OS 窗口（DevTools-style undock），可拖出主程序边框、独立缩放。分离窗口里点 clip 主窗口立即播放；主窗口切换主题/状态会实时同步过去；面板位置/尺寸跨重启保留；「📍」收回主窗口。',
  'help.section.params': '🎛 参数说明',
  'help.section.menu': '🧰 菜单',
  'help.item.menu.open': '<b>System → Open File…</b>（Ctrl/Cmd+O）：选视频。',
  'help.item.menu.export': '<b>System → Export Package…</b>（Ctrl/Cmd+E）：把当前 job 打成 zip。',
  'help.item.menu.quit': '<b>System → Quit</b>（Ctrl/Cmd+Q / Alt+F4）：退出。',
  'help.item.menu.help': '<b>Help → Help Content</b>：跳到文档站 / 项目主页。',
  'help.item.menu.about': '<b>Help → About swing-analysis</b>：软件名 + 版本信息。',
  'help.section.tips': '💡 提示',
  'help.tip.cleanup': '切分运行中「🧹」按钮会自动灰掉 —— clips 还在生成。',
  'help.tip.heads': 'viz / segments.json / 打开目录只在文件真正写盘后才显示（HEAD 探测）。',
  'help.tip.badext': '拖入非视频文件会弹错「不是视频文件（.ext）…」并保持原选择不变。',
  'help.tip.theme': '暗/亮主题切换在右上角 🌙/☀️ —— 状态徽章在两种主题下都保持高对比。',
  'help.close': '按 Esc 或点空白处关闭',

  'placeholder.waitSidecar': '⏳ 等待 sidecar 服务启动…',
  'placeholder.waitMain': '⏳ 等待主窗口状态…',
  'status.deleted': '🗑 job {id} 已删除',
  'status.deleteFail': '✗ 删除失败: {err}',
  'status.deletedBusy': '运行中的 job 不能删除，请先取消',
  'status.confirmDeleteJob': '删除整个 job？所有 clips 和 viz.mp4 都会从磁盘清空（backend/data/jobs/{id}/）。',
  'status.cancelSent': '⊘  已发送取消请求',
  'status.cancelFail': '✗ 取消失败: {err}',
  'status.createFail': '✗ 创建失败: {err}',
  'status.cleanupDone': '🧹 已清理 {n} 个 clips 文件 ({kb} KB)',
  'status.cleanupFail': '✗ 清理失败: {err}',
  'status.confirmCleanup': '删除该 job 的全部 clips？',
  'status.opened': '📦 已导出 job 包: {path}',
  'status.exportFail': '导出失败: {err}',
  'status.noExport': '没有可导出的 job',
  'status.noExportApi': '当前环境不支持导出（preload 没暴露 exportPackage）',
  'status.jobDone': '✓ job 完成 · 共 {n} 段',
  'status.jobFail': '✗ job 失败: {err}',
  'status.jobCancel': '⊘ job 取消',
  'status.wsReconnect': '↻ WS 重连 · state={state} · {n} 段',
  'status.dropped': '📂 拖入视频: {path}',
  'status.noDropPath': '无法获取拖入文件的绝对路径 —— 请改用「选择视频…」按钮',
  'status.badExt': '不是视频文件（.{ext}）。请拖入 {list} 格式的视频。',
  'status.multiDrop': '一次只能拖一个视频文件',
  'status.noFile': '没有收到文件',
  'status.menuOpened': '📁 菜单打开文件: {path}',
  'status.jobStart': '▶ job {id} 创建 · save_clips={flag}',
  'status.poseProgress': '  pose {frames}/{total} · {fps} fps · emit={emit}',
  'status.segmentEmitted': '✂ segment #{id} {start} → {end} · 击球 @ {contact}',
  'status.clipAnnotated': '🎯 clip #{id} 标注完成',
  'status.clipGenerated': '🎬 clip #{id} 生成{h264}',
  'status.h264Yes': ' (H.264 ✓)',
  'status.h264No': ' (mp4v only)',
  'status.err.createFail': '创建失败: {err}',
  'status.err.listClips': 'listClips: {err}',
  'status.err.getServiceInfo': 'getServiceInfo failed: {err}',
  'status.err.droppedPath': '无法获取拖入文件的绝对路径 —— 请改用「选择视频…」按钮',
  'status.dropActive': '拖入视频文件即可载入',
  'status.waitSidecar': '⏳ 等待 sidecar 服务启动…',
  'status.outputCleared': '🧹 已清空输出目录 ({path}) · 共 {n} 个 job',
  'status.clearOutputFail': '清空输出目录失败: {err}',
  'menu.file': '文件',
  'menu.openFile': '打开文件…',
  'menu.export': '导出包…',
  'menu.clearJob': '清空当前 job 目录',
  'menu.clearOutput': '清空输出目录…',
  'menu.quit': '退出',
  'menu.help': '帮助',
  'menu.helpContent': '帮助内容',
  'menu.about': '关于 swing-analysis',
  'menu.confirm.clearJob': '清空当前 job 所在目录？所有 clips / viz.mp4 / segments.json 都会从磁盘清空。',
  'menu.confirm.clearOutput': '清空整个输出目录？这会删除磁盘上所有 job（segments.json / clips / viz.mp4）。',

  'params.title': '参数',
  'params.v_swing': 'v_swing (活动阈值)',
  'params.gap_merge': 'gap_merge (真静止合并, s)',
  'params.max_bridge': 'max_bridge (漏检合并, s)',
  'params.min_peak': 'min_peak (峰值下限)',
  'params.smooth_alpha': 'smooth_alpha (EMA)',
  'params.max_lost_frames': 'max_lost_frames',
  'params.min_dur': 'min_dur (s)',
  'params.max_dur': 'max_dur (s)',
  'params.buf_before': 'buf_before (s)',
  'params.buf_after': 'buf_after (s)',
  'params.skip': 'skip (采样步长)',
  'params.max_frames': 'max_frames (0=全部)',
  'params.save_clips': '切出每段 clip mp4',
  'params.viz_video': '生成 viz.mp4 (彩色相位条)',
  'params.clip_section': 'clip 标注',
  'params.clip_bbox': 'RTMDet bbox 框',
  'params.clip_skel': '姿态骨架',
  'params.skel_backend': '骨架 backend:',
  'params.skel_rtmpose': 'RTMPose (COCO-13)',
  'params.skel_mediapipe': 'MediaPipe (33 点)',

  'progress.start': '▶ 开始切分',
  'progress.cancel': '⊘ 取消',
  'progress.startDisabled': '请先选个视频',
  'progress.cancelTip': '向运行中的 job 发送取消请求',
  'progress.eta': '剩余 {sec}s',
  'progress.frames': '{done}/{total} 帧',
  'progress.fps': '{fps} fps',
  'progress.segments': '已 emit {n} 段',
  'progress.queue': '🎬 clips {done}/{discovered} 已完成',
  'progress.processingFmt': '处理中 {ids}',
  'progress.waitingClip': '🎬 等待切出 clip…',
  'progress.waiting': '等待开始…',
  'progress.doneFmt': '已完成 · 共 {n} 段',
  'progress.annotating': 'clip #{id} · {stage} · {frame}/{total}',
  'progress.stage.rtmdet': 'RTMDet',
  'progress.stage.pose': '姿态骨架',
  'progress.stage.rtmdet+pose': 'RTMDet+姿态',

  'state.idle': '空闲',
  'state.queued': '排队中',
  'state.running': '运行中',
  'state.done': '完成',
  'state.failed': '失败',
  'state.cancelled': '已取消',

  'player.original': '↩ 原始',
  'player.clip': '▶ Clip',
  'player.viz': '🎬 viz.mp4',
  'player.clipOrig': 'Clip #{id}（原始编码 —— 不可拖动）',
  'player.return': '回原始视频',
  'player.contactAt': '击球 {tc}',

  'picker.pickVideo': '选择视频…',
  'picker.empty': '请选个视频文件，或选个 clip / viz 来看',

  'grid.fallback': '（无 segment 元数据）',
  'grid.overLong': '⚠ over_long',
  'grid.merged': '(合并 {n} 段)',
  'grid.fmtWarn': '⚠ 原生格式',
  'grid.playing': '▶ 正在播放',
  'grid.contactPeak': '击球 @ {contact} · peak {peak} · dur {dur}s',
  'grid.thumbAlt': 'clip {id} 首帧',
  'grid.titleFmt': 'clip #{id} · {start} → {end}',

  'toast.jobDone': '✓ Job 完成 · {n} 段',
  'toast.jobFail': '✗ Job 失败: {err}',
  'toast.jobCancel': '⊘ Job 取消',
  'toast.cleanupCancelFirst': '请先取消运行中的 job 再清理 clips。',
  'toast.cleared': '✓ 已清理 {n} 个 clips ({kb} KB)',
  'toast.deleted': '✓ Job 已删除',
  'toast.deleteBusy': '{state} 中的 job 不能删除 —— 请先取消或等完成。',
  'toast.exportBusy': '{state} 中的 job 不能导出 —— 请先取消或等完成。',
  'toast.cleanupBusy': 'job {state} 时不能清理 clips —— 请先取消或等完成。',
  'toast.cancelSent': '⊘ 已发送取消请求 —— job 即将停止。',

  'app.settings': '设置',
  'settings.title': '⚙ 设置 — 标注颜色',
  'settings.close': '关闭',
  'settings.reset': '恢复默认',
  'settings.savedNote': '自动保存 · 下次新建 job 时生效',
  'settings.outputDir': '任务输出目录',
  'settings.outputDir.desc': 'clip 与任务数据的保存位置（其下 jobs/ 子目录）。重启应用后生效。',
  'settings.outputDir.pick': '选择…',
  'settings.outputDir.reset': '恢复默认',
  'settings.outputDir.saved': '已保存，重启应用后生效。',
  'settings.outputDir.saveFailed': '保存失败',
  'settings.outputDir.defaultTag': '默认',
  'settings.color_bbox': 'RTMDet 检测框颜色',
  'settings.color_bbox.desc': '圈出每个检测到的人',
  'settings.color_pose_left': '姿态 — 左侧',
  'settings.color_pose_left.desc': '左手 · 手臂 · 大小腿 · 脚',
  'settings.color_pose_right': '姿态 — 右侧',
  'settings.color_pose_right.desc': '右手 · 手臂 · 大小腿 · 脚',
  'settings.color_pose_body': '姿态 — 躯干',
  'settings.color_pose_body.desc': '鼻 / 眼 / 肩 / 髋 等',
};

const DICTS: Record<Locale, Record<string, string>> = { en, zh };

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* localStorage may be unavailable in some sandboxes */ }
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLocale: Locale = detectLocale();

/** Substitute `{name}` placeholders in a translation string. */
function substitute(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : `{${k}}`,
  );
}

/**
 * Translate a key. Falls back: locale dict → English dict → key.
 *
 * Optional `vars` is a `{name}` substitution map applied to the
 * resolved template (e.g. `t('status.deleted', { id: 'abc' })`).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = DICTS[currentLocale] ?? en;
  let s = dict[key];
  if (s == null) s = en[key] ?? key;
  return substitute(s, vars);
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(loc: Locale): void {
  if (loc === currentLocale) return;
  currentLocale = loc;
  try { localStorage.setItem(STORAGE_KEY, loc); } catch { /* */ }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('localechange', { detail: loc }));
  }
}

export function toggleLocale(): void {
  setLocale(currentLocale === 'zh' ? 'en' : 'zh');
}

import { useEffect, useState } from 'react';

/** Hook returning a `t` that re-renders the component on locale flip. */
export function useI18n(): { t: typeof t; locale: Locale } {
  const [, setN] = useState(0);
  useEffect(() => {
    const handler = () => setN((n) => n + 1);
    window.addEventListener('localechange', handler);
    return () => window.removeEventListener('localechange', handler);
  }, []);
  return { t, locale: currentLocale };
}
