# AceCrush Swing-Analysis

[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://leochan007.github.io/swing-analysis/)
[![Docs (中文)](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](https://leochan007.github.io/swing-analysis/zh/)

[English](README.md) | **简体中文**

桌面端网球挥拍自动切分工具。把已实测验证的切分管线包装成可服务化的
Python 后端,UI 层完全可插拔。算法核 **vendored byte-for-byte** 落在
`backend/core/`,底层源更新时重拷即可。

```
┌──────────────────────────────────────────────────────────┐
│ 前端  (任选其一,全部可插拔)                              │
│  • CLI        python -m backend.cli --video …            │  ← 终端 UI
│  • Electron   npm run dev                                │  ← 桌面 UI (本仓库)
│  • Browser    http://127.0.0.1:8321                      │  ← Phase C
│  • Mobile     同 API + upload 端点                       │  ← Phase C
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP REST + WebSocket  (127.0.0.1:8321)
┌────────────────────────▼─────────────────────────────────┐
│ Python 服务  (FastAPI + uvicorn)                         │
│  service/app.py      REST 路由                            │
│  service/jobs.py     JobManager + WS 广播                │
│  service/pipeline.py 共享 run-pipeline                   │
│  cli.py              CLI 入口 —— 同一 pipeline          │
└────────────────────────┬─────────────────────────────────┘
                         │  (算法零改动)
┌────────────────────────▼─────────────────────────────────┐
│ core/  —— 三个独立 vendored 的算法                       │
│  segment_swing.py        v2.1 右手腕信号切分管线         │
│  analyze_swing.py        MediaPipe 33 点一次 + 骨架      │
│  gen_skeleton_anim.py    RTMDet + RTMPose / MediaPipe    │
│                          四象限骨架动画                  │
└──────────────────────────────────────────────────────────┘
```

> **设计原则**:算法库 (`core/`) = 真理之源;传输层 (REST/WS) 与交互层
> (CLI/GUI/Web) 全部与之解耦。**CLI 是一种 UI,Electron 也是一种 UI**,
> 两者等价地驱动同一 pipeline。

## 亮点

- **🎾 完整周期切分** —— 每个挥拍都带 ready → windup → contact → follow-through 四相位与精确时间码
- **🚀 在线 emit** —— 段随 Pass 1 流式出现,不用等整段视频处理完
- **🔌 三种可插拔 UI** —— 终端 / Electron / 未来的浏览器 / 移动端,共用同一套 REST + WebSocket
- **🎛 三种可插拔模型** —— MediaPipe Pose 负责 segmentation;RTMDet + RTMPose (或 MediaPipe) 负责可选的 clip bbox + 骨架叠加
- **📦 自包含** —— 三个 vendored 算法 + 三个模型 (~160 MB) 已入库,clone 即跑,不用为了模型去下 PyPI
- **🎬 原生视频 seek** —— GUI 用 HTTP Range 播**原始视频**,绕开 cv2 `mp4v` 编码 Chromium 解不出来的坑
- **🎞 Clip 内嵌播放 (plan 002)** —— 每段 clip 自动转一份 H.264 预览 (`clip_NNN_h264.mp4`),GUI 直接内嵌;mp4v 原件仍作 canonical 下载产物。无 ffmpeg 时 GUI 自动降级为「跳转到原视频对应 start_timecode」。
- **📊 Clip 双进度条 (plan 003)** —— 勾选「clip 叠加 RTMDet 人物框」或「clip 叠加骨架」后,GUI 的进度区扩成两行:外层是 clip 队列进度(已完成 / 已发现),内层是当前每个正在标注的 clip 的 RTMDet / 姿态 / 两者组合逐帧进度,每 5 帧刷一次。两个 flag 全关时单行进度区与改动前完全一致(零回归)。
- **↗ F12 式分离面板 (plan 004)** —— clips 列表与事件日志可弹成独立 OS 窗口(类似 Chrome DevTools 的 Undock into separate window),可拖出主程序边框、独立缩放,主窗口 ↔ 分离窗口双向状态实时同步(分离窗口里点 clip 主窗口立即播放);面板位置/尺寸跨重启记忆;原有 `📌 悬浮` 窗口内浮动模式不变。
- **🧩 模块纯粹,按 pipeline 组合** —— 切分 / 检测 / 姿态是互相独立的函数;可同跑,也可分段跑同一组 clips

## 快速开始

```bash
# CLI —— 最快烟雾测试,不用起服务
python3 -m backend.cli segment --video /abs/path/to/video.mp4 --max-frames 1500

# CLI —— 完整流水线 + clip bbox + 骨架叠加
python3 -m backend.cli segment --video /abs/match.mp4 --save-clips --clip-bbox --clip-skel

# CLI —— 对已切好的 clips 后处理标注
python3 -m backend.cli annotate --clips-dir backend/data/jobs/<id>/clips --bbox --skel

# 独立算法 CLI (在 backend/core/ 下) —— 不起服务、不包 pipeline,直接跑
# 单个阶段:
python3 backend/core/analyze_swing.py \
    --file /abs/match.mp4 --save-clips --skel-clips --viz-full
python3 backend/core/gen_skeleton_anim.py \
    --file /abs/match.mp4 --det-model rtmdet-m-487628.onnx \
    --pose-model rtmpose-m-27c0e6.onnx

# REST 服务 —— 给 Electron / 浏览器 / 任何前端用
python3 -m backend.service --port 8321
# stdout 末行: SWING_SERVICE_URL=http://127.0.0.1:8321

# Electron 桌面 GUI —— 全功能
npm install && npm run dev
```

## 三个 vendored 算法

`backend/core/` 里落了三个独立、byte-for-byte vendored 的脚本。每个都
可独立运行(不依赖服务、不依赖 Electron),也都可当库 import:

| 脚本 | 干什么 | 什么时候用它 |
| --- | --- | --- |
| `backend/core/segment_swing.py` | Pass-1 在线 + Pass-1.5 离线切分管线。单一信号:右手腕 (MediaPipe 关键点 16)。输出 `SwingSegment`,带 `ready / windup / contact / follow_through` 四相位。 | 只要切分列表,不要别的。`backend.cli segment` 包的就是它。 |
| `backend/core/analyze_swing.py` | MediaPipe 一次推理 → 33 点。wrist 喂 `segment_swing` 的 `OnlineSegmenter`,33 点按帧缓存,这样 clip 叠加 和整段 `viz.mp4` 与切分列表 1:1 对齐。 | 想要每段 clip + 整段视频都带 33 点骨架,一次跑完。 |
| `backend/core/gen_skeleton_anim.py` | RTMDet (bbox) + RTMPose / MediaPipe (骨架) 四象限合成器。可选 RTMDet 驱动的智能裁剪放大,带 ROI 稳定平滑 + 自动尺寸。 | 想做一段独立的骨架动画视频,不需要切分,只要叠加。 |

## 文档

完整双语文档站发布在
**[leochan007.github.io/swing-analysis/zh](https://leochan007.github.io/swing-analysis/zh/)**
([English](https://leochan007.github.io/swing-analysis/)) —— mkdocs +
mkdocs-material 构建,每次 push 到 `main` 自动部署到 GitHub Pages。

Markdown 源码也在仓库 [`docs/`](docs/) 下,方便离线阅读与编辑:

| 章节 | 内容 |
|---|---|
| [00 · 项目介绍](docs/zh/guide/00-introduction.md) | 这是什么、谁用、设计哲学 |
| [01 · 快速开始](docs/zh/guide/01-getting-started.md) | 前置依赖、安装、首次运行 (CLI / REST / GUI) |
| [02 · 架构](docs/zh/guide/02-architecture.md) | 分层设计、vendor 策略、解耦故事 |
| [03 · CLI 用法](docs/zh/guide/03-cli-usage.md) | `segment` / `annotate` 子命令、所有参数、输出 schema、退出码 |
| [04 · REST API](docs/zh/guide/04-rest-api.md) | 端点、payload、WebSocket 事件类型 (含 clip.annotated)、Range 流 |
| [05 · Electron GUI](docs/zh/guide/05-electron-gui.md) | sidecar 生命周期、dev 工作流、UI 布局 |
| [06 · 算法原理](docs/zh/guide/06-algorithm.md) | v2.1 两阶段切分管线 + 各模型谁用 |
| [07 · 故障排查](docs/zh/guide/07-troubleshooting.md) | 常见坑与解法 (含 onnxruntime、CoreML EP、RTMDet 动态 shape) |

英文文档:[docs/](docs/)。

## 验收 (fdl.mp4, 前 800 帧)

```
[POST /api/jobs] → job_id 51b71ad9db8b
[GET  /api/jobs/51b71ad9db8b] → state=done, segments=3
[Range bytes=0-1023 /api/videos] → 206 + Content-Range: bytes 0-1023/25243119
[segments.json keys] → input / fps / total_frames / processed_frames /
                       duration_sec / wrist_detected_pct / params /
                       segments / segment_count
```

## Clip 播放 (plan 002)

| 文件 | 作用 | 落点 |
| --- | --- | --- |
| `clip_NNN.mp4` | Canonical 下载产物。mp4v fourcc (MPEG-4 Part 2) —— Chromium 解不出 | `backend/data/jobs/<id>/clips/` |
| `clip_NNN_h264.mp4` | GUI 内嵌目标。H.264 + yuv420p + faststart,cut 完后由自带 ffmpeg 转码 | 同上 |
| `clip_NNN_annotated.mp4` | 可选 bbox + 骨架叠加 (开 `clip_bbox` / `clip_skel` 时)。仅下载,不转码 | 同上 |
| `clip_NNN.thumb.jpg` | 懒生成的中点帧 JPEG,给网格卡片当缩略图 | 同上 |

**无 ffmpeg 时** (例如 `imageio-ffmpeg` wheel 没装成功且 PATH 上也没 ffmpeg):service 留 mp4v-only,GUI 在对应卡片上标 `⚠ 原生格式 · 点击跳转原视频`,点击时降级为「原视频 seek 到 start_timecode」。mp4v 仍可通过 `GET /api/artifacts/{id}/clips/clip_NNN.mp4` 下载。

**端点**（完整参考见 [04 · REST API](docs/zh/guide/04-rest-api.md#clips-plan-002)）：

- `GET /api/jobs/{id}/clips` —— 每段 clip 元数据 (`playable` / `size_bytes` / `thumb_ready` ...)
- `GET /api/jobs/{id}/clips/{seg_id}/stream` —— H.264 预览,支持 HTTP Range (206)
- `GET /api/jobs/{id}/clips/{seg_id}/thumbnail.jpg` —— 懒生成中点帧 JPEG
- `POST /api/jobs/{id}/clips:cleanup` —— 清空 `clips/` 子目录;job 仍在 `queued`/`running` 时返回 `409`

## 许可

见 [LICENSE](LICENSE)。