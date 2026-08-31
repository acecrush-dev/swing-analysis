# 06 · 算法原理

切分管线是 `ace-crush-lab` 的 v2.1。本章讲每一阶段做什么、v2 为何存
在、哪些参数调起来最有效。`backend/core/segment_swing.py` 是真理之源
—— 逐行细节看那里。

## v2 的来历

v1 在真实录像 (`fdl.mp4`,约 9.4 分钟) 上有三个具体 bug:

| Bug | 症状 | 根因 |
| --- | --- | --- |
| **a** | 一次挥拍切成 `[引拍]+[击球]` | "静止" 阈值 (≥ N 帧低于 `v_rest`) 在引拍顶端停顿时误触发 |
| **b** | 静止期假速度尖峰 (~0.74) | wrist 漏检恢复帧用环形 buffer 跨空洞做差分 |
| **c** | 击球时间戳落在引拍转体上,不是击球瞬间 | 只用 y 轴速度 —— 水平前挥根本看不到 |

v2 三个全修了。

## 两阶段设计

```
                  Pass 1  (在线,顺序读流)
                  ────────────────────────────────
   视频  ──▶  MediaPipe Pose  ──▶  EMA(x,y)  ──▶  2D 速度  ──▶  OnlineSegmenter
                                                                  │
                                                                  ├─ emit 时 → 后台抽 clip
                                                                  └─ emit 时 → WS `segment.emitted`

                  Pass 1.5  (离线,Pass 1 完跑)
                  ────────────────────────────────
   原始 (x,y)  ──▶  bridge_gaps (≤max_lost)  ──▶  EMA  ──▶  2D 速度  ──▶  segment_cycles
                                                                              │
                                                                              └─ 写 segments.json
```

为什么两阶段?Pass 1 必须顺序读 (MediaPipe VIDEO 模式有状态 —— 每帧的
ROI 跟踪依赖上一帧),但**正确的**切分需要"看未来" (漏检区间到底有多
长、挥拍到底从哪开始)。Pass 1 给用户即时反馈;Pass 1.5 给权威最终结果。

## Pass 1 — OnlineSegmenter

```python
class OnlineSegmenter:
    def update(self, frame_idx: int, v: Optional[float]) -> Optional[SwingSegment]:
        ...
```

- 状态:`active`、`run_start`、`run_end`、`peak_v`、`peak_frame`、
  `gap_count`
- 每帧:
  1. 若 `v > v_swing` 且之前 inactive,看上一段 run 已经 inactive 多久,
     若 > `gap_merge_sec` 就 emit
  2. 若 `v > v_swing`,延展当前 run;更新 peak
  3. 若 `v <= v_swing` 且之前 active,开始计 gap
  4. 若 `v <= v_swing` 且 gap 超 `gap_merge_sec`,emit
- 流末调 `flush(last_frame_idx)`,把还没关的 run 用 `buf_after` 帧补
  上再 emit

精度比 Pass 1.5 低 (无漏检分类、无未知间隔处理),但每次 emit 都是真实
的段。

## Pass 1.5 — segment_cycles

离线函数,接完整速度数组,吐最终 segments。核心思想:**两种间隔**。

| 间隔类型 | 怎么识别 | 合并阈值 |
| --- | --- | --- |
| **推断为休息** | 区间里有速度样本,全低于 `v_swing` | `gap_merge_sec` (默认 1.5s) |
| **漏检** | 没有速度样本 (整段 wrist 全丢) | `max_bridge_sec` (默认 1.5s) |

为什么分两类?fdl.mp4 上,**真实**动作间隔 ≥ 3s,**单次**动作里的停顿
(发球抛球)≤ 1s。混在一起用同一阈值,要么把多次动作链成一长段,要么把一
次动作切两半。两个阈值独立控制。

然后:

- 丢弃 `peak_v < min_peak` 的周期 (过滤非挥拍:捡球、走位回中)
- 丢弃时长 < `min_dur` 的周期
- 时长 > `max_dur` 的周期保留但标 `over_long: true`(通常意味着两次挥
  拍被链起来)
- 每个存活的周期,算四个相位:
  - `ready`:`active_start_frame` 前的 buffer
  - `windup`:`active_start_frame` → 击球窗口
  - `contact`:击球瞬间 (peak-speed 帧) ± 0.12s
  - `follow_through`:击球窗口结束 → `active_end_frame`

## 调参指南

> 下列数字来自 30fps 网球录像 fdl.mp4。按你的素材、帧率、选手风格调。

| 目标 | 参数 | 方向 |
| --- | --- | --- |
| 捕获被丢的慢速挥拍 | `--min-peak` | **调低** (0.20 → 0.10) |
| 跳掉小动作 (捡球) | `--min-peak` | **调高** (0.40 → 0.50) |
| 把相邻两次挥拍链一起 | `--gap-merge` | **调高** (2.0 → 3.0) |
| 把慢节奏挥拍切两半 | `--gap-merge` | **调低** (1.0 → 0.6) |
| 处理长段漏检 | `--max-bridge` | **调高** (2.5) |
| 漏检合并太激进 | `--max-bridge` | **调低** (0.8) |
| 降低速度信号噪声 | `--smooth-alpha` | **调低** (0.4 → 0.5) |
| 跟手快速手腕翻动 | `--smooth-alpha` | **调高** (0.8) |
| 不要那么多 clip 头尾 buffer | `--buf-before` / `--buf-after` | **调低** (0.5) |
| 只处理视频前段 | `--max-frames` | 任一非零值 |

影响最大的是 `--min-peak` 和 `--gap-merge`。它们处理最常见的切错。

## "算法" 究竟是什么?

`backend/core/segment_swing.py` (952 行)。公开 API:

```python
# 信号处理
bridge_gaps(series, valid, max_lost) -> List[Optional[float]]
ema_smooth(series, alpha) -> List[Optional[float]]
compute_velocity_2d(xs, ys, fps) -> List[Optional[float]]

# 切分
segment_cycles(v, fps, *, v_swing, gap_merge_sec, max_bridge_sec,
               min_peak, min_dur, max_dur, buf_before, buf_after) -> List[SwingSegment]

# 流式
class OnlineSegmenter: ...
class PoseRunner: ...            # 包装 MediaPipe
def extract_one_clip(in_path, seg, clips_dir, fps, w, h): ...
def phase_timeline(seg, fps) -> List[Tuple[str, int, int]]: ...
```

`backend/service/pipeline.py` 是唯一调用方。如果上游 `ace-crush-lab`
加新函数 (比如 `dedup_overlapping` 或 `score_swing_quality`),拷进来
就行;其它地方不用知道。

## 同步上游

```bash
# 看上游变化
git -C /path/to/ace-crush-lab log --oneline app/scripts/segment_swing.py

# 拉指定 upstream commit
cp /path/to/ace-crush-lab/app/scripts/segment_swing.py backend/core/segment_swing.py
git add backend/core/segment_swing.py
git commit -m "vendor: sync segment_swing.py from upstream @ <hash>"
```

完事。不用审"本地有没有人偷偷改过",因为文件就是 verbatim 提交的。