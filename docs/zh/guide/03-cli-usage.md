# 03 · CLI 用法

`python -m backend.cli` —— 两个子命令,各自纯粹。

```
backend.cli
├── segment   从视频切出挥拍周期 (+ 可选 clip 标注)
└── annotate  对已有 clip_*.mp4 跑 RTMDet / 骨架标注 (后处理)
```

`Swing-Analysis` 是这款 app;`AceCrush` 是本 CLI 所属的大品牌。CLI
本身不带品牌字样,只跟视频打交道。UI 上的品牌分层约定见
[05 · Electron GUI](05-electron-gui.md#品牌分层约定)。

`segment` 子命令驱动切分流水线;`annotate` 是独立的 clip 增强步骤 (跟
`--clip-bbox` / `--clip-skel` 触发的是同一段逻辑)。

## `segment` 子命令

### 语法

```bash
python3 -m backend.cli segment --video <abs-or-rel.mp4> [options]
```

### 必填

| 参数 | 含义 |
| --- | --- |
| `--video PATH` | 输入视频。绝对路径或相对 (相对 CWD / 仓库根) |

### 常用参数 (含默认值)

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--out-dir PATH` | `backend/data/cli_jobs/` | `segments.json` (与 clips / viz) 落点 |
| `--max-frames N` | `0` (全部) | 处理 N 帧后停下 —— 调试 / 烟雾测试 |
| `--save-clips` | off | 每周期写 `out_dir/clips/clip_NNN.mp4` |
| `--viz-video` | off | 写 `out_dir/viz.mp4` 带彩色相位条 |
| `--clip-bbox` | off | 每个切出的 clip 上叠加 RTMDet 人物框 |
| `--clip-skel` | off | 每个切出的 clip 上叠加姿态骨架 |
| `--skel-backend {rtmpose,mediapipe}` | `rtmpose` | clip 骨架用的姿态模型 (rtmpose=COCO-13, mediapipe=33 点) |
| `--quiet` | off | 抑制进度/段打印 (适合脚本) |

### 调参 (与 `core.segment_swing.py` 一一对应)

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `--v-swing` | `0.10` | 活动区间速度阈值 (归一化宽度/秒) |
| `--gap-merge` | `1.5` 秒 | 推断为休息的间隔 ≤ 此值合并为一次挥拍 |
| `--max-bridge` | `1.5` 秒 | 漏检间隔 ≤ 此值合并 (未知 ≠ 静止) |
| `--min-peak` | `0.30` | 峰值速度低于此值的周期丢弃 |
| `--smooth-alpha` | `0.65` | EMA 平滑系数 (1.0 = 不平滑, 0.5 = 强平滑) |
| `--max-lost-frames` | `8` | ≤ 此帧数的 wrist 漏检做线性插值桥接 |
| `--min-dur` | `0.3` 秒 | 短于此值的周期丢弃 |
| `--max-dur` | `6.0` 秒 | 长于此值的周期保留但标 `over_long: true` |
| `--buf-before` | `1.0` 秒 | `active_start_frame` 前的 buffer (clip 用) |
| `--buf-after` | `1.0` 秒 | `active_end_frame` 后的 buffer (clip 用) |
| `--skip` | `1` | pose 采样步长;>1 时中间帧当 None 处理 |

每个参数背后的算法意义见 [06 · 算法原理](06-algorithm.md)。

### 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 —— JSON 写入完成 |
| `1` | 输入错 (视频/模型找不到) 或运行时异常 |
| `130` | 用户取消 (SIGINT / Ctrl+C) |

### 产物布局

```
<out-dir>/
├── segments.json              # 总有
├── clips/
│   ├── clip_001.mp4           # 仅 --save-clips
│   ├── clip_001_annotated.mp4 # 仅 --clip-bbox / --clip-skel
│   ├── clip_002.mp4
│   └── ...
└── viz.mp4                    # 仅 --viz-video
```

`segments.json` schema 跟 `backend/core/segment_swing.py` 独立跑出来的一
样 —— 同 key、同单位、同 phase schema。

### 例子

#### 烟雾测试 (看处理速度,不污染输出目录)

```bash
python3 -m backend.cli segment \
    --video /abs/fdl.mp4 \
    --max-frames 60 \
    --out-dir /tmp/swing_smoke
```

#### 完整跑 + clip + viz

```bash
python3 -m backend.cli segment \
    --video /abs/match.mp4 \
    --save-clips \
    --viz-video \
    --out-dir /Users/me/swing_out/match_2026_08_31
```

#### 完整跑 + clip + bbox + 骨架

```bash
python3 -m backend.cli segment \
    --video /abs/match.mp4 \
    --save-clips \
    --clip-bbox \
    --clip-skel \
    --skel-backend rtmpose \
    --out-dir /Users/me/swing_out/match_annotated
# → clips/clip_001.mp4          (原始切片)
# → clips/clip_001_annotated.mp4 (bbox + 骨架叠加)
```

#### 快节奏对拉想分开 (更严合并)

```bash
python3 -m backend.cli segment \
    --video /abs/serve.mp4 \
    --gap-merge 0.8 \
    --max-bridge 0.8 \
    --out-dir /tmp/swing_strict
```

## `annotate` 子命令

对目录里所有 `clip_*.mp4` 跑 RTMDet (bbox) 和/或姿态骨架叠加。独立于
切分 —— 给什么 mp4 都行。

### 语法

```bash
python3 -m backend.cli annotate --clips-dir <dir> [--bbox] [--skel] [--skel-backend {rtmpose,mediapipe}]
```

### 参数

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--clips-dir DIR` | (必填) | 扫 `clip_*.mp4` 的目录 (`_annotated.mp4` 自动跳过) |
| `--bbox` | off | 每帧画 RTMDet 人物框 |
| `--skel` | off | 每帧画姿态骨架 |
| `--skel-backend {rtmpose,mediapipe}` | `rtmpose` | 骨架用的模型 |

### 例子

#### 给已有 clips 加 bbox + 骨架

```bash
python3 -m backend.cli annotate \
    --clips-dir backend/data/jobs/<id>/clips \
    --bbox \
    --skel
# → <id>/clips/clip_001_annotated.mp4 (与原文件同目录)
```

#### 只画骨架

```bash
python3 -m backend.cli annotate \
    --clips-dir /path/to/clips \
    --skel \
    --skel-backend mediapipe
```

## 与 REST 服务的 pipeline 等价

`segment` 直接调 `run_pipeline()`。REST 服务在 `JobManager._run()` 里调
同一个函数。功能上零差异 —— 同一算法、同参数、同产物。看场景挑 UI:批
量任务用终端,客户端用 REST,探索用 GUI。

`annotate` 也单独暴露,因为 clip 增强作为**后处理**步骤很有用 —— 用不
同 flags 重跑同一组 clips,不用重新 segmentation。

## 独立 vendored 算法 CLI

`backend/core/` 下的三个脚本都能独立运行。想要单个阶段而不要全套
pipeline / 服务壳时很合适。

### `backend/core/analyze_swing.py`

统一的 MediaPipe 33 点 CLI。一次跑完视频的全 33 点,然后:

- 写 `segments.json` (跟 `segment` 同 schema)
- 加 `--save-clips` 写原始 clip
- 加 `--skel-clips` 写带骨架叠加的 clip
- 加 `--viz-full` 写整段 `viz.mp4` (骨架 + 周期条 + 底部相位方波)

```bash
backend/.venv/bin/python3 backend/core/analyze_swing.py \
    --file ../../demo.mp4 \
    --save-clips --skel-clips --viz-full
```

为什么保证与切分列表 1:1:wrist + 33 点都来自**同一帧**的 MediaPipe 推理,
切分阶段用离线 `segment_cycles()` 跑完整关键点缓冲 —— clip 序号跟
segment 序号永远对得上,跟在线/离线之间的 race 无关。

### `backend/core/gen_skeleton_anim.py`

RTMDet (bbox) + RTMPose / MediaPipe (骨架) 四象限合成器。不做切分,
纯叠加。

| 象限 | `--det-model` | `--pose-model` | 输出 |
| --- | --- | --- | --- |
| 1 | `.onnx` (RTMDet) | `.onnx` (RTMPose) | 经典 ONNX 流水线,智能裁剪 |
| 2 | `.onnx` (RTMDet) | `.task` (MediaPipe) | 混合 —— RTMDet 给 ROI,MediaPipe 给 33 点 |
| 3 | `.onnx` (RTMDet) | (无 / `--no-pose`) | 只画人框 |
| 4 | (无) | `.onnx` / `.task` | 全帧姿态,无 ROI |

```bash
# 象限 1 —— 经典 ONNX 流水线
backend/.venv/bin/python3 backend/core/gen_skeleton_anim.py \
    --file ../../demo.mp4 \
    --det-model ../models/rtmdet-m-487628.onnx \
    --pose-model ../models/rtmpose-m-27c0e6.onnx

# 象限 2 —— 混合 (RTMDet 框 + MediaPipe 33 点骨架)
backend/.venv/bin/python3 backend/core/gen_skeleton_anim.py \
    --file ../../demo.mp4 \
    --det-model ../models/rtmdet-m-487628.onnx \
    --pose-model ../models/pose_landmarker_lite.task

# 象限 4b —— MediaPipe 全帧,不用 RTMDet
backend/.venv/bin/python3 backend/core/gen_skeleton_anim.py \
    --file ../../demo.mp4 \
    --pose-model ../models/pose_landmarker_lite.task
```

输出文件名默认 `<输入>_skeleton_anim.mp4`,落在输入旁 (输入永远不被覆
盖 —— 有显式检查)。

### `backend/core/segment_swing.py`

跟 `backend.cli segment` 包的是同一份算法,直接跑。仅切分、不想要
Electron GUI 那套 clip / viz 标注时用它:

```bash
backend/.venv/bin/python3 backend/core/segment_swing.py \
    --file ../../demo.mp4 \
    --max-frames 1500 \
    --out-dir /tmp/swing_out
```

产物落在 `<out-dir>/swing_segmenter/` (脚本默认)。想要跟 REST 服务一致
的目录形状,用 `backend.cli segment` —— 它落 `backend/data/cli_jobs/<id>/`。