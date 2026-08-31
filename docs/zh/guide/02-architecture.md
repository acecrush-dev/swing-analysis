# 02 · 架构

## 四层

```
┌─────────────────────────────────────────────────────────────────┐
│  L4 · UI                                                        │
│      • Electron renderer (React, /src/renderer)                 │
│      • CLI 终端 (无额外依赖)                                    │
│      • (Phase C) 浏览器、移动端,任何讲 HTTP 的东西              │
└──────────────────────────────┬──────────────────────────────────┘
                               │  调到 L3
┌──────────────────────────────▼──────────────────────────────────┐
│  L3 · 服务 / 传输                                               │
│      • FastAPI app        (REST + WS + Range 流)                │
│      • JobManager         (生命周期 + WS 广播)                  │
│      • pydantic schemas   (线协议类型)                          │
└──────────────────────────────┬──────────────────────────────────┘
                               │  调到 L2
┌──────────────────────────────▼──────────────────────────────────┐
│  L2 · Pipeline  (接缝)                                          │
│      • backend/service/pipeline.py  — run_pipeline()            │
│      • 回调: progress_cb / on_segment / should_cancel           │
└──────────────────────────────┬──────────────────────────────────┘
                               │  从 L1 import (不改 L1)
┌──────────────────────────────▼──────────────────────────────────┐
│  L1 · 算法  (真理之源)                                          │
│      • backend/core/segment_swing.py  (vendored, byte-for-byte) │
│      • MediaPipe task 模型 (5.5 MB, 已入库)                     │
└─────────────────────────────────────────────────────────────────┘
```

**接缝在 L2 和 L1 之间**。每个 UI 都通过 `run_pipeline()`。算法除了被
pipeline 之外没有任何其它 import 方。

## 每层放什么

### L1 — 算法 (`backend/core/`)

- `segment_swing.py` (952 行) —— 从
  `ace-crush-lab/app/scripts/segment_swing.py` 原样 vendored。公开 API:
  `PoseRunner`、`OnlineSegmenter`、`segment_cycles`、`bridge_gaps`、
  `ema_smooth`、`compute_velocity_2d`、`extract_one_clip`、
  `phase_timeline`、`SwingSegment`、`_frames_to_tc`
- `pose_landmarker_lite.task` (5.5 MB) —— MediaPipe Pose 模型,已入库

### L2 — Pipeline (`backend/service/pipeline.py`)

唯一函数:

```python
run_pipeline(
    video_path: Path,
    task_path: Path,
    out_dir: Path,
    params: Optional[Dict] = None,
    progress_cb: Optional[Callable[[Dict], None]] = None,
    on_segment: Optional[Callable[[Dict], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict
```

复刻 `core.segment_swing.main()` 的 Pass 1 + Pass 1.5 + Pass 2 控制流,
把 stdout `ProgressBar` 换成 `progress_cb` 回调,把每段 emit 的 `print()`
换成 `on_segment` 回调。返回完整的 `segments.json` payload dict。

### L3 — 服务 / 传输 (`backend/service/`)

- `app.py` —— FastAPI 工厂;CORS 放任何 localhost 端口;health / jobs /
  events / videos / artifacts 路由
- `jobs.py` —— `JobManager` 在内存里维护 `_JobRecord` 注册表。
  `ThreadPoolExecutor(max_workers=1)` 强制单 job 并发 (MediaPipe VIDEO
  模式有状态,吃满 CPU)。每个 job 有一个事件回放缓冲 (deque, maxlen
  =1024) 给晚来的 WS 订阅者
- `schemas.py` —— `JobParams`、`JobCreate`、`JobAccepted`、`JobInfo`、
  `SegmentOut`、`ProgressEvent`。字段名跟 CLI 参数名一一对应
- `__main__.py` —— argparse + uvicorn;stdout 打 `SWING_SERVICE_URL=...`
  让 Electron 解析端口;写 `service.json` 兜底

### L4 — UI

- **CLI** (`backend/cli.py`) —— argparse 默认值从 `DEFAULT_PARAMS`,stdout
  进度打印、实时 segment 打印、SIGINT 处理器翻取消标志
- **Electron** —— 见 [05 · Electron GUI](05-electron-gui.md) 了解 sidecar
  生命周期和 renderer 组件

## Vendor 规矩

简而言之:**只有 `service/pipeline.py` 能 import `core.segment_swing`**。
将来如果某处 (比如 FastAPI app 想 peek `SwingSegment`) 要直接 import
core 里的辅助,先在 pipeline.py 暴露一个封装,再让 core re-export。这保
证 `core/` 可被未来任何实现替换。

上游 `ace-crush-lab` 更新算法时:

```bash
cp /path/to/ace-crush-lab/app/scripts/segment_swing.py backend/core/segment_swing.py
git add backend/core/segment_swing.py
git commit -m "vendor: sync segment_swing.py from upstream @ <hash>"
```

没有 merge 冲突。没有"有没有人在本地改过"的灵魂拷问。

## 并发模型

- **一次一个 job**。`ThreadPoolExecutor(max_workers=1)`。MediaPipe VIDEO
  模式有状态 (每个 `PoseLandmarker` 实例带每帧 ROI 跟踪状态),而且一个
  核心就吃满。并行既帮不上忙又会污染状态
- **WS 广播跨线程**。Worker 线程调 `loop.call_soon_threadsafe
  (self._safe_send, ws, event)` 把 send 调度到 asyncio 循环。接收端独立
  于 worker 线程,所以 WS 客户端慢/掉线都不会卡住 job 进度
- **Job 生命周期独立于 WS**。你可以提交一个 job,关掉 WS,十分钟后再打
  开,重连会先重放缓冲区 (deque, maxlen=1024),再让你 GET `/api/jobs/
  {id}` 对账

## 取消

- `POST /api/jobs/{id}/cancel` 翻 `_JobRecord` 里的 `threading.Event`
- pipeline 循环每帧查 `should_cancel()`,触发就抛 `JobCancelled` 干净
  退出。线程退出,job 状态进 `cancelled`,`out_dir` 里的部分产物留在磁盘
  方便排查
- CLI 装了 SIGINT handler,做同一件事

## 设计上**不做**的事

- **无持久队列**。Job 在内存里,服务重启就丢。磁盘产物
  (`segments.json`、clips) 保留
- **无多用户**。默认绑 `127.0.0.1`。Phase C 加 bind `0.0.0.0` + token 鉴
  权,用于 LAN 场景
- **无横向扩展**。单进程、单 job。桌面工具足够