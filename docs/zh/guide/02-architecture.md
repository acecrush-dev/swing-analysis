# 02 · 架构

## 四层 (含 pose-runner 扩展)

```
┌─────────────────────────────────────────────────────────────────┐
│  L4 · UI                                                        │
│      • Electron renderer (React, /src/renderer)                 │
│      • CLI 子命令:  segment  /  annotate                         │
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
│  L2 · Pipeline  (接缝 —— 按用户 flags 组合)                     │
│      • backend/service/pipeline.py            run_pipeline()    │
│      • backend/service/pose_runners/                              │
│          ├── rtmdet.py      ONNX RTMDet 人物检测                   │
│          ├── rtmpose.py     ONNX RTMPose COCO-13 姿态估计         │
│          ├── mediapipe.py   MediaPipe 33 点姿态估计                │
│          ├── drawing.py     bbox / 骨架叠加 (纯 cv2)                │
│          └── annotate.py    ClipAnnotator (在 clip 上加 bbox+骨架)│
└──────────────────────────────┬──────────────────────────────────┘
                               │  从 L1 import (不改 L1)
┌──────────────────────────────▼──────────────────────────────────┐
│  L1 · 算法  (真理之源)                                          │
│      • backend/core/segment_swing.py  (vendored, byte-for-byte) │
│      • MediaPipe task 模型 (5.5 MB, 已入库)                     │
│      • RTMDet ONNX (104 MB, 已入库)                             │
│      • RTMPose ONNX (52 MB, 已入库)                             │
└─────────────────────────────────────────────────────────────────┘
```

**接缝在 L2 和 L1 之间**。每个 UI 都通过 `run_pipeline()`。算法除了被
pipeline 之外没有任何其它 import 方。

**每个 pose-runner 模块纯粹干净** —— 不做 I/O,不做编排。pipeline 层
(`pipeline.py`) 按用户 flags 组合它们;CLI 的 `annotate` 子命令独立组合
它们。

## 每层放什么

### L1 — 算法 (`backend/core/`)

三个 vendored 脚本,每个既能单独跑 CLI 又能当库 import:

| 脚本 | 行数 | 用途 | 公开 API |
| --- | --- | --- | --- |
| `segment_swing.py` | 952 | v2.1 右手腕信号切分管线 (`backend.cli segment` 包的就是它) | `PoseRunner`、`OnlineSegmenter`、`segment_cycles`、`bridge_gaps`、`ema_smooth`、`compute_velocity_2d`、`extract_one_clip`、`phase_timeline`、`SwingSegment`、`_frames_to_tc` |
| `analyze_swing.py` | 450 | MediaPipe 33 点一次推理。wrist 喂 `OnlineSegmenter`,完整 33 点按帧缓存,clip + viz.mp4 与切分列表 1:1 | `MediaPipePoseRunner`、`draw_skeleton_33`、`extract_skel_clip`、`render_full_viz`、`main()` |
| `gen_skeleton_anim.py` | 1021 | RTMDet (bbox) + RTMPose / MediaPipe (骨架) 四象限合成器,带可选智能裁剪 ROI + 稳定平滑 + 自动尺寸 | `RtmdetRunner`、`RtmposeRunner`、`MediaPipePoseRunner`、`KeypointSmoother`、`CenterSmoother`、`StableBoxAutoSizer`、`build_algo_label`、`draw_skeleton`、`resolve_models`、`build_runners` |

三个全是 byte-for-byte vendored —— `core/` 里**一行不改**。本仓库跟底层
源的漂移用 `cp` 解决,绝不手工 merge。

已入库的模型:

- `pose_landmarker_lite.task` (5.5 MB) —— MediaPipe Pose 模型
- `rtmdet-m-487628.onnx` (104 MB) —— RTMDet 人物检测
- `rtmpose-m-27c0e6.onnx` (52 MB) —— RTMPose COCO-13 估计器

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
    on_clip_annotated: Optional[Callable[[Dict], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict
```

复刻 `core.segment_swing.main()` 的 Pass 1 + Pass 1.5 + Pass 2 控制流,
把 stdout `ProgressBar` 换成 `progress_cb` 回调,把每段 emit 的 `print()`
换成 `on_segment` 回调。如果 `params["clip_bbox"]` 或
`params["clip_skel"]` 开了,每段抽出的 clip 会用 `ClipAnnotator`
(L2 的 pose-runners 模块) 后处理:用 RTMDet 和/或 RTMPose/MediaPipe 加
bbox 与骨架。返回完整的 `segments.json` payload dict。

### L2 — pose-runners (`backend/service/pose_runners/`)

每个模块只做一件事;pipeline / `annotate` CLI 组合它们。

| 模块 | 类/函数 | 输入 | 输出 |
| --- | --- | --- | --- |
| `rtmdet.py` | `RtmdetRunner` | BGR 帧 | `List[BBox]` (人物检测) |
| `rtmpose.py` | `RtmposeRunner` | BGR 帧 + 可选 BBox | `List[(x,y,conf)]` (COCO-13 关键点) |
| `mediapipe.py` | `MediaPipePoseRunner` | BGR 帧 + ts_ms | `List[(x,y,conf)]` (33 关键点) |
| `drawing.py` | `draw_bboxes` / `draw_skeleton_coco13` / `draw_skeleton_mp33` | canvas + payload | 改 in-place 后的 canvas |
| `annotate.py` | `ClipAnnotator` | clip mp4 + flags | 标注后的 mp4 |

组合发生在:
- `pipeline.run_pipeline()` —— `extract_one_clip` → `ClipAnnotator.annotate_clip` 串联 (开了 `clip_bbox` 或 `clip_skel`)
- `cli.cmd_annotate()` —— 对目录里所有 `clip_*.mp4` 独立跑 `ClipAnnotator` (后处理)

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

底层源更新三个 vendored 脚本时:

```bash
cp <新-segment_swing.py>     backend/core/segment_swing.py
cp <新-analyze_swing.py>     backend/core/analyze_swing.py
cp <新-gen_skeleton_anim.py> backend/core/gen_skeleton_anim.py
git add backend/core/
git commit -m "vendor: 从底层源同步 @ <hash>"
```

没有 merge 冲突。没有"有没有人在本地改过"的灵魂拷问 —— 文件就是
verbatim 提交的。

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