# 03 · CLI 用法

`python -m backend.cli` —— 两个子命令,各自纯粹。

```
backend.cli
├── segment   从视频切出挥拍周期 (+ 可选 clip 标注)
└── annotate  对已有 clip_*.mp4 跑 RTMDet / 骨架标注 (后处理)
```

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

`segments.json` 与 `ace-crush-lab/app/scripts/segment_swing.py` 的 CLI 版
本**字节级兼容** —— 同 key、同单位、同 phase schema。

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