# swing-analysis

[![Docs](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://leochan007.github.io/swing-analysis/)
[![Docs (中文)](https://img.shields.io/badge/docs-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red)](https://leochan007.github.io/swing-analysis/zh/)

[English](README.md) | **简体中文**

桌面端网球挥拍自动切分工具。把已实测验证的切分管线包装成可服务化的
Python 后端，UI 层完全可插拔。算法库 **vendored byte-for-byte** 自
[`ace-crush-lab`](https://github.com/leochan007/ace-crush-lab) —— 上游修
一行，这里重拷一行，对齐零成本。

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
│ core/segment_swing.py                                    │
│  (从 ace-crush-lab/app/scripts/ 原样拷贝, byte-for-byte │
│   —— 上游更新只需重拷)                                   │
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
- **📦 自包含** —— 算法 vendored + 三个模型 (~160 MB) 已入库,clone 即跑,不用为了模型去下 PyPI
- **🎬 原生视频 seek** —— GUI 用 HTTP Range 播**原始视频**,绕开 cv2 `mp4v` 编码 Chromium 解不出来的坑
- **🧩 模块纯粹,按 pipeline 组合** —— 切分 / 检测 / 姿态是互相独立的函数;可同跑,也可分段跑同一组 clips

## 快速开始

```bash
# CLI —— 最快烟雾测试,不用起服务
python3 -m backend.cli segment --video /abs/path/to/video.mp4 --max-frames 1500

# CLI —— 完整流水线 + clip bbox + 骨架叠加
python3 -m backend.cli segment --video /abs/match.mp4 --save-clips --clip-bbox --clip-skel

# CLI —— 对已切好的 clips 后处理标注
python3 -m backend.cli annotate --clips-dir backend/data/jobs/<id>/clips --bbox --skel

# REST 服务 —— 给 Electron / 浏览器 / 任何前端用
python3 -m backend.service --port 8321
# stdout 末行: SWING_SERVICE_URL=http://127.0.0.1:8321

# Electron 桌面 GUI —— 全功能
npm install && npm run dev
```

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

## 许可

见 [LICENSE](LICENSE)。