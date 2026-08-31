# swing-analysis

桌面网球挥拍自动切分工具 —— **算法从 ace-crush-lab 原样继承 (zero changes)，包装成可服务化的 Python 后台 + 可插拔 UI 层**。

```
┌─────────────────────────────────────────────────────┐
│ Front-ends (any of these)                            │
│  • CLI        python -m backend.cli --video …        │  ← terminal UI
│  • Electron   npm run dev    (this repo)             │  ← desktop UI
│  • Browser    http://localhost:8321                  │  ← web UI (Phase C)
│  • Mobile     same API + upload endpoint (Phase C)   │
└──────────────────────────┬──────────────────────────┘
                           │ HTTP REST + WebSocket  (127.0.0.1:8321)
┌──────────────────────────▼──────────────────────────┐
│ Python service  (FastAPI + uvicorn)                 │
│   backend/service/app.py      REST routes           │
│   backend/service/jobs.py     JobManager + WS        │
│   backend/service/pipeline.py shared run-pipeline    │
└──────────────────────────┬──────────────────────────┘
                           │  (no algorithm changes)
┌──────────────────────────▼──────────────────────────┐
│ backend/core/segment_swing.py  (vendored from        │
│ ace-crush-lab/app/scripts/segment_swing.py, byte-   │
│ for-byte — re-copy on upstream changes)             │
└─────────────────────────────────────────────────────┘
```

> 设计原则：**算法库（core）= 真理之源，传输层（REST/WS）与交互层（CLI/GUI/Web/Mobile）都解耦**。CLI 是 UI，Electron 是 UI，两者等价地驱动同一 pipeline。

---

## TL;DR — 怎么跑起来

| 目标 | 命令 | 产物落点 |
|---|---|---|
| **最快的烟雾测试 (CLI, 不开服务)** | `python3 -m backend.cli --video <绝对路径.mp4> --max-frames 1500` | `--out-dir` 指定的目录（默认 `backend/data/cli_jobs/`） |
| **后台服务 (REST + WebSocket)** | `python3 -m backend.service --port 8321` | stdout 末行 `SWING_SERVICE_URL=http://127.0.0.1:8321`；兜底 `backend/data/service.json` |
| **Electron 桌面 GUI** | `npm install && npm run dev` | 自动拉起 sidecar + 编译 main/preload/renderer + 开窗 |

任意时刻的服务端产物：`backend/data/jobs/<job_id>/segments.json`（与 `clips/`、`viz.mp4`）。

完整步骤见下文 Phase A / Phase B 两节。

---

## 目录

- [TL;DR](#tldr--怎么跑起来)
- [Phase A — Python 后台服务](#phase-a--python-后台服务)
- [Phase B — Electron TS GUI](#phase-b--electron-ts-gui)
- [产物都去哪了](#产物都去哪了)
- [API](#api)
- [故障排查](#故障排查)

---

## Phase A — Python 后台服务

CLI 与 REST 服务共享同一个 `backend.service.pipeline.run_pipeline`，所以下面任选其一就能把算法跑起来。

### 0. 前置

- Python ≥ 3.10（MediaPipe 官方 wheel 历史上止于 3.12；本机 3.13 已实测可跑）
- ffmpeg 不需要；OpenCV 自带编解码

### 1. 安装依赖 + 拉模型

```bash
# 任选其一：用 venv 或直接装到本机（脚本基于本机 python3）
python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt
# —— 或 ——
pip3 install -r backend/requirements.txt

# 把 MediaPipe task 模型就位到 backend/models/
bash scripts/fetch-model.sh    # 优先从 ace-crush-lab 拷贝；否则下载
```

### 2A. CLI（最快上手，独立于一切网络栈）

```bash
python3 -m backend.cli \
    --video /Users/leo/Documents/codes/ai/ace-crush-lab/app/scripts/fdl.mp4 \
    --max-frames 1500 \
    --out-dir /tmp/swing_out

# 输出：
#   /tmp/swing_out/segments.json
#   /tmp/swing_out/clips/clip_001.mp4  (--save-clips)
#   /tmp/swing_out/viz.mp4             (--viz-video)
```

> `python -m backend.cli` 与 `python -m backend.service` 调的是 **同一函数** (`run_pipeline`)。
> 算法在 CLI 上怎么跑，在 REST 下也怎么跑，零差异。

### 2B. REST 服务（给 Electron / 浏览器 / 任何前端用）

```bash
python3 -m backend.service --port 8321
# stdout 末行：SWING_SERVICE_URL=http://127.0.0.1:8321
# 兜底文件：backend/data/service.json
```

健康检查：
```bash
curl http://127.0.0.1:8321/api/health
# {"status":"ok","version":"0.1.0","model_ready":true, ...}
```

提交任务：
```bash
curl -X POST http://127.0.0.1:8321/api/jobs \
     -H 'Content-Type: application/json' \
     -d '{
           "video_path":"/Users/leo/Documents/codes/ai/ace-crush-lab/app/scripts/fdl.mp4",
           "params":{"max_frames":1500,"viz_video":true,"save_clips":true}
         }'
# {"job_id":"51b71ad9db8b"}
```

查状态（WS 断线重连后用这个对账）：
```bash
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b
# {"state":"done","segments":[...], "segments_payload":{...}}
```

下载产物：
```bash
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/segments.json -o seg.json
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/clips/clip_001.mp4 -o c1.mp4
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/viz.mp4 -o viz.mp4
```

Range 流（原视频给 `<video>` 拖动 seek 用）：
```bash
curl -H 'Range: bytes=0-1023' \
     'http://127.0.0.1:8321/api/videos?path=/Users/leo/Documents/codes/ai/ace-crush-lab/app/scripts/fdl.mp4'
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/25243119
```

WS 事件流（Python 客户端示例）：
```python
import asyncio, json, websockets
async def main():
    async with websockets.connect('ws://127.0.0.1:8321/api/jobs/<id>/events') as ws:
        async for msg in ws:
            print(json.loads(msg))
asyncio.run(main())
```

事件类型：`job.started` / `pose.progress` / `segment.emitted` / `job.completed` / `job.failed` / `job.cancelled`。

---

## 产物都去哪了

所有运行时产物都默认落在 `backend/` 下，`.gitignore` 已把整个 `backend/data/` 与 `backend/.venv/` 排除，不进 git。

| 路径 | 是什么 | 谁写 |
|---|---|---|
| `backend/data/service.json` | 服务启动信息（host/port/started_at） | `backend.service` 启动后写，Electron 拿不到 stdout 时兜底 |
| `backend/data/jobs/<job_id>/segments.json` | 完整结果（输入元信息 + 11 个调参 + segments[] + segment_count） | `run_pipeline()` 末写 |
| `backend/data/jobs/<job_id>/clips/clip_NNN.mp4` | 每个周期的独立 mp4 | `extract_one_clip` 后台线程（仅当 `save_clips=true`） |
| `backend/data/jobs/<job_id>/viz.mp4` | 底部相位色条标注视频 | `render_outputs()`（仅当 `viz_video=true`） |
| `backend/models/pose_landmarker_lite.task` | MediaPipe Pose 模型 | `scripts/fetch-model.sh` |
| `backend/cli_jobs/` | CLI 默认 out-dir | `python -m backend.cli` |
| `out/`、`dist/`、`node_modules/` | Electron 构建产物 | `electron-vite build` / `npm install` |

> **不要把 `backend/data/` 提交。** 它是运行时缓存，重跑任务会重建。
> **不要把 `backend/models/*.task` 提交。** 二进制文件，体积大且不跨平台；`scripts/fetch-model.sh` 会就位。

`.cc-delivery/` 目录是 planner / worker 协作的中间产物，仓库使用者不需要，也已在 `.gitignore` 里排除。

---

## Phase B — Electron TS GUI

前置：Node ≥ 18。

```bash
npm install
npm run dev
# → electron-vite 会：编译 main + preload + renderer，
#   并把 spawn PythonSidecar 进程启动；窗口打开后自动 attach。
```

GUI 操作：
1. 顶部 **「选择视频」** —— 系统 dialog 拿绝对路径（不走 HTTP 上传）
2. 右侧 **「参数」** —— 调整 v_swing / gap_merge 等，默认 = core 默认
3. **「▶ 开始切分」** —— 调 `POST /api/jobs`，打开 WS
4. 实时进度条 + ETA + 在线 segments 列表
5. 完成后点击任一周期 → 原视频 `<video>` 自动 seek 到 `start_timecode` 并播放
6. 右下角下载 `segments.json` / `clips/clip_NNN.mp4` / `viz.mp4`

> 关键决策：GUI 回回 **原视频 + timecode seek**，不依赖服务切出的 clip mp4。
> 因为 cv2 VideoWriter 的 mp4v (MPEG-4 Part 2) 编码 Chromium `<video>` 几乎解不出来；
> clip 仅作产物下载/导出用。

---

## API

| Method | Path | Body / Query | 说明 |
|---|---|---|---|
| GET    | `/api/health` | — | `{status, version, model_ready}` |
| POST   | `/api/jobs` | `{video_path, params?}` | `{job_id}` |
| GET    | `/api/jobs/{id}` | — | 完整 JobInfo（含 segments） |
| POST   | `/api/jobs/{id}/cancel` | — | `{ok}` |
| DELETE | `/api/jobs/{id}` | — | 删除 + 清产物目录 |
| WS     | `/api/jobs/{id}/events` | — | ProgressEvent 流（含历史回放） |
| GET    | `/api/videos?path=<abs>` | Range header | 原视频流（206 / 200） |
| GET    | `/api/artifacts/{id}/{rel}` | — | segments.json / clips/* / viz.mp4 |

`params` 字段（与 CLI 一致）：
`v_swing` / `gap_merge` / `max_bridge` / `min_peak` / `smooth_alpha` /
`max_lost_frames` / `min_dur` / `max_dur` / `buf_before` / `buf_after` /
`skip` / `max_frames` / `save_clips` / `viz_video`。

---

## 故障排查

- **MediaPipe 安装失败** → 降到 Python 3.12 建专用 venv；或在 README 备注本机版本
- **GUI 看不到视频** → 检查 `/api/videos` 是否 200；`accept-ranges: bytes` 是否回带
- **WS 收不到事件** → 客户端必须先 GET `/api/jobs/{id}` 对账，再考虑断网重连
- **端口被占** → `python -m backend.service --port 0` 让 OS 随机选；stdout 末行会带真实端口
- **算法结果与 CLI 不一致** → 不可能，因为走同一函数；如果发生，请对比 `segments.json` 字段

---

## 路线图（不在本次 plan）

- **Phase C** —— PyInstaller onedir 打包 sidecar + electron-builder extraResources；
  加 `POST /api/jobs/upload` (multipart) + `0.0.0.0` bind + token 鉴权；
  浏览器 + 移动端前端复用同一套 API。