#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
挥拍自动切分器 (swing auto-segmenter) — 完整动作周期切分。

目的(2026-08-28 user-direct):
  「修复切分算法,把每次完整的挥拍分割开。一个完整的动作,
   需要从准备到向后引拍,再向前击球,最后随挥。」

为什么改版(v1 在线 2 态状态机的问题):
  v1 触发 = 速度穿越 V_SWING,emit = 速度 < V_REST 持续 N 帧。
  三个实测缺陷(fdl.mp4):
    a. 引拍顶端的停顿(等球/调整)≥ N_REST 时误 emit → 一次动作劈成 [引拍]+[击球] 两段
    b. wrist 漏检恢复帧用 ring buffer 跨空洞差分 → 假速度尖峰 0.74(静止期误触发)
    c. 只用 y 轴速度 → 水平前挥(正手击球)信号弱,峰值落在引拍转体而非击球

v2 架构(两阶段,离线切分):
  Pass 1  顺序流式逐帧 MediaPipe Pose → 右腕 (x,y) 信号序列
          (注意: 必须顺序读流,不能 seek —— VIDEO 模式是有状态跟踪,seek 会破坏信号)
  Pass 1.5 离线切分(纯函数,可单测):
    a. 短漏检段(≤ max_lost 帧)双轴线性插值桥接 —— 运动模糊漏检不打断周期
    b. v = |Δ(x,y)|×fps (2-D 欧氏速度,EMA 平滑) —— 水平挥拍不再漏信号
    c. 活动区间 = v > V_SWING(<0.15s 的孤立尖刺=噪声丢弃)。
       不做尾部延展 —— 静止段 pose 抖动噪声(v p50≈0.06)会让任何
       v_rest 型收尾永不停尾、把区间链式粘连(踩过);慢速随挥尾巴交给 buf_after
    d. 间隔合并(核心修复) —— 区分两种间隔:
         真静止间隔(有速度样本,v<V_SWING): ≤ GAP_MERGE(1.5s) 才合并
           —— 引拍停顿/发球抛球停顿(实测 ≤1.05s)合并进同一次动作;
              动作之间的真实间隔(实测 ≥3.24s)分开
         未知间隔(整段漏检,无样本): ≤ MAX_BRIDGE(1.5s) 才合并 —— 未知≠静止
    e. 过滤:时长 < MIN_DUR 丢弃;峰值 < MIN_PEAK(0.30) 丢弃;超 MAX_DUR 保留但标记 over_long
    f. 每个周期标注 4 相位: ready(准备) / windup(引拍) / contact(击球) / follow_through(随挥)
  Pass 2  顺序重读视频 → 同时渲染 viz.mp4 + 切出 clips/clip_N.mp4(顺序读写,无 mp4 seek 误差)

fdl.mp4 实测(2026-08-28, 视觉 ground truth 对照):
  5 个完整动作全部正确切出,无多切无漏切:
    #1 正手 ~130-205 (击球~170)  #2 正手 ~374-460 (击球~450)  #3 发球 ~740-810 (触球~780)
    #4 单反 ~1100-1210 (击球~1160,2-D峰值帧吻合)  #5 单反 ~1395-1500 (击球~1475)

用法:
    # 默认:扫 fdl.mp4,只输出 JSON
    python3 segment_swing.py

    # 加可视化视频 + 切出每段 mp4
    python3 segment_swing.py --save-clips --viz-video

    # 引拍停顿特别长的选手调大合并窗口;快节奏对拉想分开调小
    python3 segment_swing.py --gap-merge 1.2

    # 滤掉慢速转身/捡球等非挥拍动作
    python3 segment_swing.py --min-peak 0.3

    # 限帧调试
    python3 segment_swing.py --max-frames 1500 --viz-video
"""

import argparse
import json
import math
import os
import shutil
import threading
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

# MediaPipe Pose 33 关键点索引
WRIST_R = 16
WRIST_L = 15

Pos = Optional[Tuple[float, float]]  # (x, y) 归一化坐标,漏检为 None


# ═══════════════════════════ 数据结构 ═══════════════════════════

@dataclass
class SwingSegment:
    """一个完整挥拍周期(准备→引拍→击球→随挥)的元数据。

    帧号约定(闭区间,含两端):
      start_frame / end_frame      含 buffer 的 clip 范围(实际切视频用)
      active_start / active_end    真实运动区间(速度超阈值的部分)
      contact_frame                峰值速度帧 ≈ 击球瞬间
    """
    seg_id: int                     # 第几个挥拍(从 1 开始)
    start_frame: int                # 含 buffer_before 的起始帧
    end_frame: int                  # 含 buffer_after 的结束帧
    active_start_frame: int         # 运动开始(引拍起步)
    active_end_frame: int           # 运动结束(随挥收尾)
    contact_frame: int              # 速度峰值帧(≈击球瞬间)
    peak_velocity: float            # 峰值速度 (归一化宽度/秒)
    duration_sec: float             # 真实运动时长(active_start → active_end)
    total_sec: float                # 含 buffer 的 clip 总时长
    start_timecode: str             # mm:ss.SSS,clip 开始
    contact_timecode: str           # 击球瞬间时间码
    end_timecode: str               # clip 结束时间码
    over_long: bool = False         # 运动时长超 max_dur(保留,仅标记)
    merged_intervals: int = 1       # 该周期由几个运动区间合并而来(1=无合并)

    # 兼容 v1 字段名(下游脚本若读过 segments.json)
    @property
    def peak_frame(self) -> int:
        return self.contact_frame

    @property
    def peak_timecode(self) -> str:
        return self.contact_timecode


# ═══════════════════════════ 信号处理 ═══════════════════════════

def bridge_gaps(series: Sequence[float], valid: Sequence[bool],
                max_lost: int) -> List[Optional[float]]:
    """把长度 ≤ max_lost 的无效段线性插值桥接;更长的保留 None。

    forward swing 高速期(motion blur / 球拍遮挡)wrist 常漏检几帧,
    不桥接的话活动区间会在这里断开,把一次挥拍切成两半。
    series/valid 等长;valid[i]=False 的位置输出 None(或插值)。
    """
    out: List[Optional[float]] = [series[i] if valid[i] else None for i in range(len(series))]
    n = len(out)
    i = 0
    while i < n:
        if out[i] is not None:
            i += 1
            continue
        j = i
        while j < n and out[j] is None:
            j += 1
        if i > 0 and j < n and (j - i) <= max_lost:
            y0, y1 = out[i - 1], out[j]
            if y0 is not None and y1 is not None:
                for k in range(i, j):
                    t = (k - i + 1) / (j - i + 1)
                    out[k] = y0 + (y1 - y0) * t
        i = j
    return out


def ema_smooth(series: Sequence[Optional[float]],
               alpha: float) -> List[Optional[float]]:
    """EMA 平滑;长 None 段之后重新播种(不跨越空洞平滑,避免假速度尖峰)。"""
    out: List[Optional[float]] = []
    prev: Optional[float] = None
    for y in series:
        if y is None:
            out.append(None)
            prev = None            # 空洞后重新播种
            continue
        prev = y if prev is None else alpha * y + (1 - alpha) * prev
        out.append(prev)
    return out


def compute_velocity_2d(xs: Sequence[Optional[float]],
                        ys: Sequence[Optional[float]],
                        fps: float) -> List[Optional[float]]:
    """相邻帧 2-D 欧氏速度(归一化宽度/秒)。仅相邻两帧都有信号时定义。

    用 2-D 而非 y-only: 正手前挥主要是水平位移,y-only 信号弱,
    峰值会落在引拍转体而不是击球 (fdl.mp4 实测)。
    """
    v: List[Optional[float]] = [None] * len(xs)
    for i in range(1, len(xs)):
        x0, x1, y0, y1 = xs[i - 1], xs[i], ys[i - 1], ys[i]
        if x0 is not None and x1 is not None and y0 is not None and y1 is not None:
            v[i] = math.hypot(x1 - x0, y1 - y0) * fps
    return v


# ═══════════════════════════ 离线周期切分 ═══════════════════════════

def segment_cycles(v: List[Optional[float]], fps: float, *,
                   v_swing: float,
                   gap_merge_sec: float, max_bridge_sec: float,
                   min_peak: float, min_dur: float, max_dur: float,
                   buf_before: float, buf_after: float) -> List[SwingSegment]:
    """完整动作周期切分(纯函数,输入 2-D 速度序列,输出周期列表)。

    步骤:
      1. active = v > v_swing,取连续活动区间(长度 < min_run 的孤立尖刺=噪声丢弃)
         —— 注意不做"尾部延展": fdl.mp4 实测静止段 pose 抖动噪声 v p50≈0.06 /
         max≈0.20,任何基于 v_rest≈0.02-0.05 的延展都会在噪声里永不停尾、
         把整个间隔吞进区间 → 区间链式粘连(2026-08-28 踩过)。
         慢速随挥尾巴(v<v_swing)交给 buf_after 覆盖。
      2. 间隔合并(核心): 两种间隔区别对待 ——
           真静止间隔(gap 内有速度样本,v<v_swing): ≤ gap_merge_sec 才合并
             —— 引拍停顿/发球抛球停顿(实测 ≤1.05s)合并进同一次动作;
                动作之间的真实间隔(实测 ≥3.24s)保持分开
           未知间隔(gap 内整段漏检,无速度样本): ≤ max_bridge_sec 才合并
             —— 未知≠静止;长漏检(实测 5-6s)在动作之间,不合并
      3. 过滤 + 打包 buffer + 相位标注在 phase_timeline()
    """
    total = len(v)
    if total == 0:
        return []

    min_run = max(3, int(round(0.15 * fps)))          # <0.15s 的速度尖刺 = 噪声
    gap_frames = max(0, int(round(gap_merge_sec * fps)))
    bridge_frames = max(0, int(round(max_bridge_sec * fps)))
    min_frames = max(1, int(round(min_dur * fps)))
    max_frames = max(min_frames + 1, int(round(max_dur * fps)))
    buf_b = max(0, int(round(buf_before * fps)))
    buf_a = max(0, int(round(buf_after * fps)))

    # ── 1. 活动区间 ──
    active = [(vi is not None and vi > v_swing) for vi in v]
    runs: List[List[int]] = []                         # [start, end] 闭区间
    i = 0
    while i < total:
        if not active[i]:
            i += 1
            continue
        j = i
        while j + 1 < total and active[j + 1]:
            j += 1
        if j - i + 1 >= min_run:
            runs.append([i, j])
        i = j + 1
    if not runs:
        return []

    # ── 2. 间隔合并(真静止 vs 未知空洞) ──
    merged: List[List[int]] = [list(runs[0])]
    merge_counts: List[int] = [1]
    for s, e in runs[1:]:
        gap_lo, gap_hi = merged[-1][1] + 1, s - 1      # gap 闭区间
        gap_len = gap_hi - gap_lo + 1
        if gap_len <= 0:                               # 区间重叠,直接并
            merged[-1][1] = max(merged[-1][1], e)
            merged[-1][0] = min(merged[-1][0], s)
            merge_counts[-1] += 1
            continue
        has_sample = any(v[k] is not None for k in range(max(gap_lo, 0), min(gap_hi, total - 1) + 1))
        limit = gap_frames if has_sample else bridge_frames
        if gap_len <= limit:
            merged[-1][1] = max(merged[-1][1], e)
            merged[-1][0] = min(merged[-1][0], s)
            merge_counts[-1] += 1
        else:
            merged.append([s, e])
            merge_counts.append(1)

    # ── 4. 过滤 + 打包 ──
    segments: List[SwingSegment] = []
    for (s, e), n_merged in zip(merged, merge_counts):
        # 峰值(击球瞬间)
        peak_frame, peak_v = -1, -1.0
        for k in range(s, e + 1):
            vk = v[k]
            if vk is not None and vk > peak_v:
                peak_v, peak_frame = vk, k
        if peak_frame < 0:
            continue                                   # 全 None 的异常区间
        span = e - s + 1
        if span < min_frames:
            continue                                   # 太短 = 噪声/微动
        if min_peak > 0 and peak_v < min_peak:
            continue                                   # 峰值太低 = 非挥拍动作
        start_b = max(0, s - buf_b)
        end_b = min(total - 1, e + buf_a)
        segments.append(SwingSegment(
            seg_id=0,                                  # main() 统一编号
            start_frame=start_b,
            end_frame=end_b,
            active_start_frame=s,
            active_end_frame=e,
            contact_frame=peak_frame,
            peak_velocity=peak_v,
            duration_sec=span / fps,
            total_sec=(end_b - start_b + 1) / fps,
            start_timecode=_frames_to_tc(start_b, fps),
            contact_timecode=_frames_to_tc(peak_frame, fps),
            end_timecode=_frames_to_tc(end_b, fps),
            over_long=span > max_frames,
            merged_intervals=n_merged,
        ))

    for idx, seg in enumerate(segments, start=1):
        seg.seg_id = idx
    return segments


# ═══════════════════════════ 在线切分 (Pass 1 实时 emit) ═══════════════════════════

class OnlineSegmenter:
    """在线版 segment_cycles: 每帧调 update(),检测到 gap 超过阈值时 emit 关闭的 segment。

    与离线版差异:
      - 不做 gap 桥接 (bridge_gaps) —— 在线不知道未来 gap 长度
      - 不做"未知间隔"分类 —— 全部按"真静止"处理 (用 gap_merge_sec 单阈值)
      - close 的 segment end_frame = run_end (无 buf_after; 后续帧若启动新 run 就让出去)
      - flush() 调一次把最后未关闭的 run 用 buf_after 封口

    精度会比离线版略低 (无桥接 / 无未知间隔分类), 但 clip 能随 Pass 1 边读边出。
    """
    def __init__(self, fps: float, *, v_swing: float, gap_merge_sec: float,
                 min_peak: float, min_dur: float,
                 buf_before: float, buf_after: float):
        self.fps = fps
        self.v_swing = v_swing
        self.gap_frames = max(1, int(round(gap_merge_sec * fps)))
        self.min_peak = min_peak
        self.min_frames = max(1, int(round(min_dur * fps)))
        self.buf_b = max(0, int(round(buf_before * fps)))
        self.buf_a = max(0, int(round(buf_after * fps)))

        self.active = False
        self.run_start: Optional[int] = None
        self.run_end: Optional[int] = None
        self.peak_v = -1.0
        self.peak_frame: Optional[int] = None
        self.gap_count = 0          # 当前 run 已 inactive 多少帧
        self.closed: List[SwingSegment] = []
        self.next_seg_id = 1

    def update(self, frame_idx: int, v: Optional[float]) -> Optional[SwingSegment]:
        is_active = (v is not None) and (v > self.v_swing)
        if is_active:
            if not self.active:
                # 刚转 active: 看上一个 run 是不是该关
                if self.run_start is not None and self.gap_count > self.gap_frames:
                    seg = self._emit(frame_idx)
                    if seg is not None:
                        return seg
                # 开新 run (或延续)
                if self.run_start is None:
                    self.run_start = frame_idx
                    self.peak_v = v
                    self.peak_frame = frame_idx
                self.run_end = frame_idx
                if v > self.peak_v:
                    self.peak_v = v
                    self.peak_frame = frame_idx
            else:
                # 持续 active
                self.run_end = frame_idx
                if v > self.peak_v:
                    self.peak_v = v
                    self.peak_frame = frame_idx
            self.active = True
            self.gap_count = 0
        else:
            if self.active:
                self.active = False
                self.gap_count = 1
            elif self.run_start is not None:
                self.gap_count += 1
                if self.gap_count > self.gap_frames:
                    return self._emit(frame_idx)
        return None

    def flush(self, last_frame_idx: int) -> Optional[SwingSegment]:
        """视频结束时调用 —— 把未关闭的 run 用 buf_after 封口后 emit。"""
        if self.run_start is None or self.run_end is None:
            return None
        # 把 run_end 延伸到 min(last_frame_idx, run_end + buf_a)
        end_b = min(last_frame_idx, self.run_end + self.buf_a)
        self.run_end = end_b
        return self._emit(end_b)

    def _emit(self, frame_idx: int) -> Optional[SwingSegment]:
        if self.run_start is None or self.run_end is None:
            return None
        span = self.run_end - self.run_start + 1
        if span < self.min_frames or self.peak_v < self.min_peak:
            self._reset_run()
            return None
        start_b = max(0, self.run_start - self.buf_b)
        end_b = self.run_end
        seg = SwingSegment(
            seg_id=self.next_seg_id,
            start_frame=start_b,
            end_frame=end_b,
            active_start_frame=self.run_start,
            active_end_frame=self.run_end,
            contact_frame=self.peak_frame or self.run_start,
            peak_velocity=self.peak_v,
            duration_sec=span / self.fps,
            total_sec=(end_b - start_b + 1) / self.fps,
            start_timecode=_frames_to_tc(start_b, self.fps),
            contact_timecode=_frames_to_tc(self.peak_frame or self.run_start, self.fps),
            end_timecode=_frames_to_tc(end_b, self.fps),
        )
        self.next_seg_id += 1
        self.closed.append(seg)
        self._reset_run()
        return seg

    def _reset_run(self):
        self.run_start = None
        self.run_end = None
        self.peak_v = -1.0
        self.peak_frame = None
        self.gap_count = 0


# ═══════════════════════════ 单段 clip 抽取 (后台线程) ═══════════════════════════

def extract_one_clip(in_path: Path, seg: SwingSegment,
                     clips_dir: Path, fps: float,
                     width: int, height: int) -> None:
    """单段 clip 抽取 (供 ThreadPoolExecutor 调用)。mp4 seek 不精确,向前 5 帧补偿。"""
    clip_path = clips_dir / f"clip_{seg.seg_id:03d}.mp4"
    cap = cv2.VideoCapture(str(in_path))
    if not cap.isOpened():
        print(f"  ✗ {clip_path.name}: 无法打开 {in_path}", flush=True)
        return
    seek = max(0, seg.start_frame - 5)
    cap.set(cv2.CAP_PROP_POS_FRAMES, seek)
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(str(clip_path), fourcc, fps, (width, height))
    if not writer.isOpened():
        print(f"  ✗ {clip_path.name}: VideoWriter 打开失败", flush=True)
        cap.release()
        return
    frame_no = seek
    n_written = 0
    while frame_no <= seg.end_frame:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_no >= seg.start_frame:
            writer.write(frame)
            n_written += 1
        frame_no += 1
    writer.release()
    cap.release()
    span = seg.end_frame - seg.start_frame + 1
    mark = "✓" if n_written == span else ("△" if n_written > 0 else "✗")
    print(f"  {mark} {clip_path.name}: 帧 {seg.start_frame}-{seg.end_frame}"
          f" ({span}f, 写入 {n_written})  dur={seg.duration_sec:.2f}s"
          f"  peak={seg.peak_velocity:.3f}  {seg.start_timecode}→{seg.end_timecode}",
          flush=True)


def phase_timeline(seg: SwingSegment, fps: float) -> List[Tuple[str, int, int]]:
    """一个周期 → [(phase_name, start_frame, end_frame)] (闭区间,不重叠)。

    相位对齐 plan 016 result_page 的阶段命名:
      ready(准备) → windup(引拍) → contact(击球) → follow_through(随挥)
    """
    contact_w = max(1, int(round(0.12 * fps)))         # 击球窗口 ±0.12s
    out: List[Tuple[str, int, int]] = []
    # ready: buffer 区(运动开始前)
    if seg.start_frame <= seg.active_start_frame - 1:
        out.append(("ready", seg.start_frame, seg.active_start_frame - 1))
    # contact: 击球窗口 ±0.12s (先算,windup 收到它前一帧,相位区间不重叠)
    c_s = max(seg.active_start_frame, seg.contact_frame - contact_w)
    c_e = min(seg.active_end_frame, seg.contact_frame + contact_w)
    # windup: 运动开始 → 击球窗口前
    if seg.active_start_frame <= c_s - 1:
        out.append(("windup", seg.active_start_frame, c_s - 1))
    if c_s <= c_e:
        out.append(("contact", c_s, c_e))
    # follow_through: 击球窗口后 → 运动结束
    f_s = max(seg.active_start_frame, seg.contact_frame + contact_w + 1)
    if f_s <= seg.active_end_frame:
        out.append(("follow_through", f_s, seg.active_end_frame))
    return out


def _frames_to_tc(frames: int, fps: float) -> str:
    """frame idx → 'mm:ss.SSS' 时间码。"""
    sec = frames / fps
    m = int(sec // 60)
    s = sec - m * 60
    return f"{m:02d}:{s:06.3f}"


# ═══════════════════════════ MediaPipe Pose Runner ═══════════════════════════

class PoseRunner:
    """精简版 MediaPipe PoseLandmarker —— 只暴露右手腕 (x, y)。

    注意: VIDEO 模式是有状态跟踪 —— 必须按时间顺序逐帧喂,
    不能随机 seek(会破坏内部 ROI 跟踪,产生失真信号,实测验证过)。
    """
    def __init__(self, task_path: Path):
        import mediapipe as mp
        if not task_path.exists():
            raise FileNotFoundError(f"MediaPipe task 不存在: {task_path}")
        print(f"  MediaPipe task: {task_path.name}", flush=True)
        options = mp.tasks.vision.PoseLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(task_path)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.5,
            min_pose_presence_confidence=0.5,
            min_tracking_confidence=0.5,
        )
        self.detector = mp.tasks.vision.PoseLandmarker.create_from_options(options)
        self._mp = mp

    def detect(self, frame: np.ndarray, ts_ms: int) -> Optional[Tuple[float, float, float]]:
        """返回 (x, y, visibility) 归一化坐标,或 None(漏检/可见度过低)。"""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        res = self.detector.detect_for_video(mp_img, ts_ms)
        if not res or not res.pose_landmarks:
            return None
        lm = res.pose_landmarks[0][WRIST_R]
        vis = float(getattr(lm, 'visibility', 0.0) or 0.0)
        if vis < 0.3:
            return None
        return float(lm.x), float(lm.y), vis


# ═══════════════════════════ 进度条 (轻量) ═══════════════════════════

class ProgressBar:
    def __init__(self, total: int, label: str = ""):
        self.total = max(1, total)
        self.label = label
        self.start_t = time.time()
        self.last_t = self.start_t
        self.done = False
        self._draw(0, 0.0)

    def _draw(self, cur, fps_now):
        pct = cur / self.total
        bar_w = 30
        filled = int(round(bar_w * pct))
        bar = "[" + "#" * filled + "-" * (bar_w - filled) + "]"
        eta = (self.total - cur) / max(fps_now, 1e-6)
        # ETA 兜底: fps≈0 时 eta 会爆炸成 billions 秒 → 显示 "--" 而不是 "3296111:06:40"
        if not (eta == eta) or eta == float("inf") or eta > 86400 * 30:
            eta_s = "--"
        else:
            s = max(0, int(eta))
            eta_s = f"{s // 60}:{s % 60:02d}" if s < 3600 else f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}"
        line = (f"\r\033[2K{self.label}  {bar}  {pct * 100:5.1f}%  "
                f"{cur}/{self.total}  {fps_now:5.1f}fps  ETA {eta_s}")
        sys.stdout.write(line); sys.stdout.flush()

    def update(self, cur):
        if self.done: return
        force = (cur >= self.total)
        now = time.time()
        if not force and (now - self.last_t) < 0.1:
            return
        elapsed = now - self.start_t
        fps_now = cur / elapsed if elapsed > 0 else 0.0
        self._draw(cur, fps_now)
        self.last_t = now
        if cur >= self.total:
            self.done = True
            sys.stdout.write("\n"); sys.stdout.flush()

    def close(self):
        if not self.done: self.update(self.total)


# ═══════════════════════════ Pass 2: viz + clips 顺序渲染 ═══════════════════════════

PHASE_COLORS = {
    #                     B    G    R  (BGR for cv2)
    "ready":           (255, 220, 120),   # 浅蓝
    "windup":          (80, 200, 255),    # 橙黄
    "contact":         (0, 0, 255),       # 红
    "follow_through":  (0, 255, 120),     # 绿
}


def render_outputs(in_path: Path, segments: List[SwingSegment],
                   xs: List[Optional[float]], out_dir: Path,
                   fps: float, width: int, height: int, render_frames: int,
                   make_viz: bool, save_clips: bool = False):
    """Pass 2: 顺序重读视频一遍,渲染 viz.mp4。

    clip 抽取已移到 Pass 1 在线 (extract_one_clip 后台线程),本函数**只做 viz**。
    save_clips 参数保留兼容但忽略。
    """
    if not segments or not make_viz:
        return

    # 每帧 → (phase, seg_id) 查表
    frame_phase: Dict[int, Tuple[str, int]] = {}
    for seg in segments:
        for name, s, e in phase_timeline(seg, fps):
            for f in range(s, e + 1):
                frame_phase[f] = (name, seg.seg_id)

    viz_writer = None
    if make_viz:
        viz_path = out_dir / 'viz.mp4'
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        viz_writer = cv2.VideoWriter(str(viz_path), fourcc, fps, (width, height))
        if not viz_writer.isOpened():
            print("ERROR: viz VideoWriter 打开失败", file=sys.stderr)
            viz_writer = None

    # clip 抽取由 Pass 1 在线 + 后台线程完成,这里不再写

    cap = cv2.VideoCapture(str(in_path))
    if not cap.isOpened():
        print(f'ERROR: 重新打开 {in_path} 失败', file=sys.stderr)
        return

    print(f"\n[render] 第二 pass: viz={'✓' if make_viz else '✗'}  (clips 已由 Pass 1 在线后台抽完)", flush=True)
    progress = ProgressBar(total=min(render_frames, segments[-1].end_frame + 1),
                           label="[render]")
    frame_idx = 0
    try:
        while frame_idx < render_frames:
            ok, frame = cap.read()
            if not ok:
                break
            fidx = frame_idx                      # 0-based 信号下标
            frame_idx += 1

            need = (viz_writer is not None) or (fidx <= segments[-1].end_frame)
            if not need:
                break

            # ── viz ──
            if viz_writer is not None:
                canvas = frame.copy()
                # 黄色横线 = 手腕 y 位置
                if fidx < len(xs) and xs[fidx] is not None:
                    y_px = int(xs[fidx] * height)
                    cv2.line(canvas, (0, y_px), (width, y_px), (0, 255, 255), 2, cv2.LINE_AA)
                # 已检出周期: 粉红色窄条 + 编号 (高度 30px, 紧贴底部状态方波上方, 5px 间隙)
                bar_y0 = height - 60            # 粉红框顶
                bar_y1 = height - 30            # 粉红框底 (status bar 上方 5px)
                for seg in segments:
                    x1 = int(seg.start_frame / max(render_frames, 1) * width)
                    x2 = int(seg.end_frame / max(render_frames, 1) * width)
                    cv2.rectangle(canvas, (x1, bar_y0), (x2, bar_y1), (255, 0, 255), 3)
                    cv2.putText(canvas, f"#{seg.seg_id}", (x1 + 5, bar_y0 + 19),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 0, 255), 2, cv2.LINE_AA)
                # 底部状态方波: 20px 高, 按相位着色 (顶部让给手机状态栏/刘海)
                ph = frame_phase.get(fidx)
                if ph is not None:
                    name, sid = ph
                    color = PHASE_COLORS.get(name, (180, 180, 180))
                    cv2.rectangle(canvas, (0, height - 25), (width, height - 5), color, -1)
                    cv2.putText(canvas, f"#{sid} {name}  frame={frame_idx}",
                                (10, height - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                                (255, 255, 255), 1, cv2.LINE_AA)
                else:
                    cv2.rectangle(canvas, (0, height - 25), (width, height - 5), (60, 60, 60), -1)
                    cv2.putText(canvas, f"idle  frame={frame_idx}", (10, height - 9),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)
                viz_writer.write(canvas)

            if fidx <= segments[-1].end_frame:
                progress.update(frame_idx)

    finally:
        cap.release()
        if viz_writer is not None:
            viz_writer.release()
        progress.close()


# ═══════════════════════════ 主流程 ═══════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description='挥拍自动切分器(完整动作周期: 准备→引拍→击球→随挥)')
    parser.add_argument('--file', default='fdl.mp4',
                        help='输入视频文件名 (相对 app/scripts/ 解析,默认 fdl.mp4)')
    # 2026-08-28 user-direct：默认切到 lite (5.7MB),与 Flutter assets/models/pose_landmarker.task
    # 同源;heavy (30MB) 是历史遗留 (分析栈未用)
    parser.add_argument('--task', default='pose_landmarker_lite.task',
                        help='MediaPipe task 文件名 (.task, 默认 lite; Flutter 端用 assets/models/pose_landmarker.task)')
    parser.add_argument('--out-dir', default=None,
                        help='输出目录 (默认 swing_segmenter/)')
    parser.add_argument('--save-clips', action='store_true',
                        help='切出每个完整挥拍周期为独立 mp4 (写入 out-dir/clips/)')
    parser.add_argument('--viz-video', action='store_true',
                        help='生成可视化视频 (写 out-dir/viz.mp4)')
    parser.add_argument('--max-frames', type=int, default=0,
                        help='只处理前 N 帧(调试用)')
    parser.add_argument('--skip', type=int, default=1,
                        help='pose 帧采样步长(默认 1=逐帧;>1 时漏检帧由插值桥接)')
    parser.add_argument('--v-swing', type=float, default=0.10,
                        help='活动区间速度阈值(归一化/秒,默认 0.10;'
                             'fdl.mp4 实测静止段抖动噪声 max≈0.20 但 <3 帧即被滤)')
    parser.add_argument('--gap-merge', type=float, default=1.5,
                        help='真静止间隔 ≤ 此秒数合并为同一次完整挥拍(默认 1.5;'
                             'fdl.mp4 实测: 动作内停顿 ≤1.05s(发球抛球),'
                             '动作间间隔 ≥3.24s;停顿更长的选手调大,'
                             '快节奏对拉想分开调小)')
    parser.add_argument('--max-bridge', type=float, default=1.5,
                        help='漏检空洞(未知间隔)≤ 此秒数合并(默认 1.5;未知≠静止,'
                             '更长的空洞视为动作边界)')
    parser.add_argument('--min-peak', type=float, default=0.30,
                        help='周期峰值速度下限,低于则丢弃(默认 0.30;'
                             'fdl.mp4 实测真实动作峰值 ≥0.43,步法/捡球 ≤0.26;'
                             '慢速挥拍选手可降到 0.1-0.2)')
    parser.add_argument('--smooth-alpha', type=float, default=0.65,
                        help='EMA 平滑系数,1.0=不平滑,0.5=强平滑(默认 0.65)')
    parser.add_argument('--max-lost-frames', type=int, default=8,
                        help='wrist 漏检插值桥接上限(默认 8 帧;≤ 此长度的漏检线性插值,'
                             '更长的当真空洞,由 --max-bridge 决定是否合并)')
    parser.add_argument('--min-dur', type=float, default=0.3,
                        help='最短运动时长(秒,默认 0.3)')
    parser.add_argument('--max-dur', type=float, default=6.0,
                        help='运动时长超此秒数的周期保留但标记 over_long(默认 6.0)')
    parser.add_argument('--buf-before', type=float, default=1.0,
                        help='周期前的缓冲秒数(默认 1.0,保留准备动作)')
    parser.add_argument('--buf-after', type=float, default=1.0,
                        help='周期后的缓冲秒数(默认 1.0,保留还原)')
    args = parser.parse_args()

    here = Path(__file__).parent.resolve()
    scripts_dir = here
    in_path = Path(args.file) if os.path.isabs(args.file) else (scripts_dir / args.file)
    task_path = Path(args.task) if os.path.isabs(args.task) else (scripts_dir / args.task)
    out_dir = Path(args.out_dir) if args.out_dir else (here / 'swing_segmenter')

    if not in_path.exists():
        print(f"ERROR: 视频不存在 {in_path}", file=sys.stderr); sys.exit(1)
    if not task_path.exists():
        print(f"ERROR: 模型不存在 {task_path}", file=sys.stderr); sys.exit(1)

    # 清空旧产物 — 避免上次 run 的 segments.json / viz.mp4 / clips/ 残留
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(in_path))
    if not cap.isOpened():
        print(f"ERROR: 无法打开视频 {in_path}", file=sys.stderr); sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # 预扫帧数(防 CAP_PROP_FRAME_COUNT=0)
    if total <= 0:
        print("  [info] 视频元数据无帧数,正在预扫计数...", flush=True)
        scanned = 0
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        while True:
            ok, _ = cap.read()
            if not ok: break
            scanned += 1
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        total = scanned
        print(f"  [info] 预扫完成, 共 {total} 帧", flush=True)

    limit = total if args.max_frames <= 0 else min(total, args.max_frames)

    print(f"输入:    {in_path}")
    print(f"输出:    {out_dir}")
    print(f"视频:    {width}x{height} @ {fps:.1f}fps,  {total} 帧, {total/fps:.1f}s"
          + (f" (处理前 {limit} 帧)" if limit < total else ""))
    print(f"参数:    v_swing={args.v_swing}  gap_merge={args.gap_merge}s  "
          f"max_bridge={args.max_bridge}s  min_peak={args.min_peak}  smooth={args.smooth_alpha}")
    print(f"         min_dur={args.min_dur}s  max_dur={args.max_dur}s  min_peak={args.min_peak}  "
          f"buf_before={args.buf_before}s  buf_after={args.buf_after}s")

    # ══ Pass 1: 顺序流式逐帧 pose → wrist (x,y) 信号 + 在线切分 + 后台抽 clip ══
    print("\n加载 MediaPipe...", flush=True)
    pose = PoseRunner(task_path)
    print("✓ MediaPipe 加载完成\n", flush=True)

    n_valid = 0
    frame_idx = 0
    t0 = time.time()
    progress = ProgressBar(total=limit, label="[pose]")
    xs: List[Optional[float]] = [None] * limit
    ys: List[Optional[float]] = [None] * limit

    # 在线切分器 (Pass 1 跑的过程中就 emit 关闭的 segment)
    online_seg = OnlineSegmenter(
        fps, v_swing=args.v_swing, gap_merge_sec=args.gap_merge,
        min_peak=args.min_peak, min_dur=args.min_dur,
        buf_before=args.buf_before, buf_after=args.buf_after,
    )
    # EMA 平滑器 (在线) — 用 --smooth-alpha,跨 None 重新播种 (避免空洞后假速度尖峰)
    sa = float(args.smooth_alpha)
    sx: Optional[float] = None
    sy: Optional[float] = None
    # 前一帧的 smoothed 值,用于算 2D 速度
    px: Optional[float] = None
    py: Optional[float] = None

    # 后台抽 clip 的线程池 + 已 emit 的 segment 列表
    clip_executor: Optional[ThreadPoolExecutor] = None
    if args.save_clips:
        clip_executor = ThreadPoolExecutor(max_workers=2,
            thread_name_prefix="clip")
    online_segments: List[SwingSegment] = []

    try:
        skip = max(1, int(args.skip))
        while frame_idx < limit:
            ok, frame = cap.read()
            if not ok:
                break
            fidx = frame_idx                 # 0-based
            frame_idx += 1

            if (fidx % skip) == 0:           # 跳帧: 未采样帧留 None,由插值桥接
                det = pose.detect(frame, int(((fidx + 1) / fps) * 1000.0))
                if det is not None:
                    xs[fidx], ys[fidx] = det[0], det[1]
                    n_valid += 1
                    # 在线 EMA 平滑
                    if sx is None:
                        sx, sy = det[0], det[1]
                    else:
                        sx = sa * det[0] + (1 - sa) * sx
                        sy = sa * det[1] + (1 - sa) * sy
                else:
                    # wrist 失效 → 重置 EMA 种子
                    sx, sy = None, None
            else:
                # 跳过的帧 → 等价于失效,EMA 重置
                sx, sy = None, None

            # 在线 2D 速度
            if sx is not None and sy is not None and px is not None and py is not None:
                v_now: Optional[float] = math.hypot(sx - px, sy - py) * fps
            else:
                v_now = None
            px, py = sx, sy

            # 在线切分: emit 时立即派发后台 clip 任务
            seg = online_seg.update(fidx, v_now)
            if seg is not None:
                online_segments.append(seg)
                if clip_executor is not None:
                    clips_dir_live = out_dir / 'clips'
                    clips_dir_live.mkdir(parents=True, exist_ok=True)
                    clip_executor.submit(extract_one_clip, in_path, seg,
                                        clips_dir_live, fps, width, height)

            progress.update(frame_idx)
    except KeyboardInterrupt:
        print("\n[interrupt] Ctrl+C", flush=True)
    finally:
        cap.release()
        progress.close()

    # Pass 1 末: flush 在线切分器 (用 buf_after 封最后一个未关闭的 run)
    seg = online_seg.flush(frame_idx)
    if seg is not None:
        online_segments.append(seg)
        if clip_executor is not None:
            clips_dir_live = out_dir / 'clips'
            clip_executor.submit(extract_one_clip, in_path, seg,
                                 clips_dir_live, fps, width, height)

    detected_pct = 100.0 * n_valid / max(frame_idx, 1)
    print(f"  [pose] {n_valid}/{frame_idx} 帧检出 wrist ({detected_pct:.0f}%)", flush=True)

    # ── 等所有后台 clip 抽完 (让用户能看到 "Pass 1 跑完时 clips/ 已就绪") ──
    if clip_executor is not None:
        if online_segments:
            print(f"  [clip] 在线切出 {len(online_segments)} 段,等待 {len(online_segments)} 个后台抽 clip 完成...",
                  flush=True)
        clip_executor.shutdown(wait=True)
        print(f"  ✓ 所有 clip 已写入 {out_dir / 'clips'}", flush=True)

    # ══ Pass 1.5: 离线切分 (用更准确的算法,生成 segments.json 兜底) ══
    valid = [x is not None for x in xs]
    xb = bridge_gaps(xs, valid, max_lost=args.max_lost_frames)
    yb = bridge_gaps(ys, valid, max_lost=args.max_lost_frames)
    xs_s = ema_smooth(xb, alpha=args.smooth_alpha)
    ys_s = ema_smooth(yb, alpha=args.smooth_alpha)
    v = compute_velocity_2d(xs_s, ys_s, fps=fps)

    segments = segment_cycles(
        v, fps,
        v_swing=args.v_swing,
        gap_merge_sec=args.gap_merge, max_bridge_sec=args.max_bridge,
        min_peak=args.min_peak, min_dur=args.min_dur, max_dur=args.max_dur,
        buf_before=args.buf_before, buf_after=args.buf_after,
    )

    for seg in segments:
        merged_note = f"  ← 合并 {seg.merged_intervals} 段运动" if seg.merged_intervals > 1 else ""
        over_note = "  ⚠ 超长(over_long)" if seg.over_long else ""
        print(f"  ▶ swing #{seg.seg_id}  帧 {seg.start_frame}-{seg.end_frame}"
              f" (运动 {seg.active_start_frame}-{seg.active_end_frame})"
              f"  {seg.start_timecode}→{seg.end_timecode}"
              f"  击球@{seg.contact_timecode} peak v={seg.peak_velocity:.3f}"
              f"  dur={seg.duration_sec:.2f}s{merged_note}{over_note}", flush=True)
    if segments and any(s.over_long for s in segments):
        print("  [提示] 有超长周期: 想拆开就调小 --gap-merge,想容忍就调大 --max-dur", flush=True)

    # ══ 输出 segments.json ══
    segs_data = []
    for s in segments:
        d = asdict(s)
        d['peak_frame'] = s.peak_frame            # 兼容 v1 字段
        d['peak_timecode'] = s.peak_timecode
        d['phases'] = [
            {'phase': name, 'start_frame': ps, 'end_frame': pe}
            for (name, ps, pe) in phase_timeline(s, fps)
        ]
        segs_data.append(d)

    json_path = out_dir / 'segments.json'
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({
            'input': str(in_path),
            'fps': fps,
            'total_frames': total,
            'processed_frames': frame_idx,
            'duration_sec': total / fps,
            'wrist_detected_pct': round(detected_pct, 1),
            'params': {
                'v_swing': args.v_swing,
                'gap_merge_sec': args.gap_merge,
                'max_bridge_sec': args.max_bridge,
                'min_peak': args.min_peak,
                'min_dur': args.min_dur,
                'max_dur': args.max_dur,
                'buf_before': args.buf_before,
                'buf_after': args.buf_after,
                'smooth_alpha': args.smooth_alpha,
                'max_lost_frames': args.max_lost_frames,
                'skip': max(1, int(args.skip)),
            },
            'segments': segs_data,
            'segment_count': len(segs_data),
        }, f, indent=2, ensure_ascii=False)

    elapsed = time.time() - t0
    print()
    print(f"✓ 完成: 检测到 {len(segs_data)} 个完整挥拍周期")
    print(f"  耗时 {elapsed:.1f}s ({frame_idx/max(elapsed, 0.001):.1f} fps 处理速度)")
    print(f"  JSON: {json_path}")
    if segs_data:
        durs = [s['duration_sec'] for s in segs_data]
        peaks = [s['peak_velocity'] for s in segs_data]
        print(f"  duration_sec: min={min(durs):.2f}  median={sorted(durs)[len(durs)//2]:.2f}  max={max(durs):.2f}")
        print(f"  peak_velocity: min={min(peaks):.3f}  median={sorted(peaks)[len(peaks)//2]:.3f}  max={max(peaks):.3f}")
    if args.viz_video:
        print(f"  可视化: {out_dir / 'viz.mp4'}  (相位色条: 蓝=准备 橙=引拍 红=击球 绿=随挥)")

    # ══ Pass 2: 顺序渲染 viz + clips ══
    if args.save_clips or args.viz_video:
        render_outputs(in_path, segments, ys, out_dir, fps,
                       width, height, render_frames=frame_idx,
                       make_viz=args.viz_video, save_clips=args.save_clips)


if __name__ == '__main__':
    main()
