#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一挥拍分析脚本 (swing detection + skeleton overlay + clip extraction).

合并 segment_swing.py (挥拍检测 + clip 抽取) 和 gen_skeleton_anim.py
(skeleton 绘制) 的功能,但默认用 MediaPipe 一次性输出 33 关键点 —
wrist 喂给 OnlineSegmenter 切 swing,完整 33 点喂给 skel-clips 画骨架。

输出 (按 flag 灵活组合):
  --save-clips   → clips/clip_NNN.mp4        (原始切出来的 clip)
  --skel-clips   → clips/clip_NNN_skel.mp4   (clip 上叠加 33 点 skeleton)
  --viz-full     → viz.mp4                   (整段视频画 skeleton + 粉红周期框 + 底部状态方波)
  始终输出      → segments.json              (挥拍元数据, 用离线 segment_cycles 兜底)

用法:
    # 只抽原始 clip (默认行为)
    python3 analyze_swing.py --save-clips

    # 同时抽带 skeleton 的 clip
    python3 analyze_swing.py --save-clips --skel-clips

    # 加整段 viz
    python3 analyze_swing.py --save-clips --viz-full

    # 调参
    python3 analyze_swing.py --save-clips --v-swing 0.15 --min-peak 0.4

注: RTMDet + RTMPose 流水线 (精度更高但更慢) 仍可用原 gen_skeleton_anim.py,
    本脚本统一用 MediaPipe (33 点, 一次推理同时给 wrist + skeleton).
"""

import argparse
import json
import math
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np

# 从 segment_swing 复用: 离线切分、EMA/速度、在线 emit、单段抽 clip、ProgressBar
import segment_swing as ss
WRIST_R = ss.WRIST_R
WRIST_L = ss.WRIST_L

# 从 gen_skeleton_anim 复用: 33 点 skeleton 拓扑 + 配色
import gen_skeleton_anim as gsa
MP_SKELETON_33 = gsa.MP_SKELETON_33
LEFT_IDS = gsa.LEFT_IDS
RIGHT_IDS = gsa.RIGHT_IDS


# ═══════════════════════════ MediaPipe Pose: 一次推理返回 33 点 ═══════════════════════════

class MediaPipePoseRunner:
    """MediaPipe Tasks PoseLandmarker (VIDEO mode),返回 33 点 [(x,y,vis), ...] or None."""

    def __init__(self, task_path: Path):
        import mediapipe as mp
        if not task_path.exists():
            raise FileNotFoundError(f"MediaPipe task 不存在: {task_path}")
        print(f"    MediaPipe task: {task_path.name}", flush=True)
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

    def detect_33(self, frame: np.ndarray, ts_ms: int) -> Optional[List[Tuple[float, float, float]]]:
        """返回 33 个关键点 (x, y, vis) 归一化坐标, 失败 None."""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        res = self.detector.detect_for_video(mp_img, ts_ms)
        if not res or not res.pose_landmarks:
            return None
        lms = res.pose_landmarks[0]
        return [(float(lm.x), float(lm.y),
                 float(getattr(lm, "visibility", 0.0) or 0.0)) for lm in lms]


# ═══════════════════════════ Skeleton 绘制 (33 点) ═══════════════════════════

# MediaPipe 33 点分组 (左/右/中) 用于配色
LEFT_IDS  = {11, 13, 15, 23, 25, 27, 29, 31}
RIGHT_IDS = {12, 14, 16, 24, 26, 28, 30, 32}
COLOR_LEFT  = (0, 0, 255)
COLOR_RIGHT = (0, 255, 255)
COLOR_CENTER = (0, 255, 0)


def _kp_color(idx: int) -> Tuple[int, int, int]:
    if idx in LEFT_IDS: return COLOR_LEFT
    if idx in RIGHT_IDS: return COLOR_RIGHT
    return COLOR_CENTER


def draw_skeleton_33(canvas: np.ndarray, kps: List[Tuple[float, float, float]],
                     conf_thresh: float = 0.20) -> None:
    """在 canvas 上画 33 点骨架. 原地修改."""
    h, w = canvas.shape[:2]
    line_thresh = max(0.05, conf_thresh * 0.5)
    for i1, i2 in MP_SKELETON_33:
        _, _, c1 = kps[i1]
        _, _, c2 = kps[i2]
        if not ((c1 > line_thresh and c2 > line_thresh) or
                (max(c1, c2) > conf_thresh and min(c1, c2) > line_thresh)):
            continue
        x1, y1 = int(kps[i1][0] * w), int(kps[i1][1] * h)
        x2, y2 = int(kps[i2][0] * w), int(kps[i2][1] * h)
        cv2.line(canvas, (x1, y1), (x2, y2), _kp_color(i1), 2, cv2.LINE_AA)
    for idx, (x, y, conf) in enumerate(kps):
        if conf <= conf_thresh:
            continue
        cx, cy = int(x * w), int(y * h)
        cv2.circle(canvas, (cx, cy), 4, _kp_color(idx), -1, cv2.LINE_AA)
        cv2.circle(canvas, (cx, cy), 4, (0, 0, 0), 1, cv2.LINE_AA)


# ═══════════════════════════ 带 skeleton 的 clip 抽取 (后台线程) ═══════════════════════════

def extract_skel_clip(in_path: Path, seg: ss.SwingSegment,
                      keypoints_per_frame: List[Optional[List[Tuple[float, float, float]]]],
                      clips_dir: Path, fps: float, width: int, height: int) -> None:
    """从内存中的 keypoints 抽带 skeleton overlay 的 clip."""
    clip_path = clips_dir / f"clip_{seg.seg_id:03d}_skel.mp4"
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
            kps = keypoints_per_frame[frame_no] if frame_no < len(keypoints_per_frame) else None
            if kps is not None:
                draw_skeleton_33(frame, kps)
            writer.write(frame)
            n_written += 1
        frame_no += 1
    writer.release()
    cap.release()
    span = seg.end_frame - seg.start_frame + 1
    mark = "✓" if n_written == span else ("△" if n_written > 0 else "✗")
    print(f"  {mark} {clip_path.name}: 帧 {seg.start_frame}-{seg.end_frame}"
          f" ({span}f, 写入 {n_written})  peak={seg.peak_velocity:.3f}  dur={seg.duration_sec:.2f}s",
          flush=True)


# ═══════════════════════════ 整段 viz 渲染 (Pass 2) ═══════════════════════════

def render_full_viz(in_path: Path, segments: List[ss.SwingSegment],
                    keypoints_per_frame: List[Optional[List[Tuple[float, float, float]]]],
                    out_dir: Path, fps: float, width: int, height: int,
                    render_frames: int) -> None:
    """整段视频 viz: skeleton + 粉红周期框 + 底部状态方波. (segments 用在线 emit 的即可)"""
    viz_path = out_dir / 'viz.mp4'
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(str(viz_path), fourcc, fps, (width, height))
    if not writer.isOpened():
        print(f"  ✗ {viz_path.name} 打开失败", flush=True)
        return

    # phase 查表
    frame_phase: dict = {}
    for seg in segments:
        for name, ps, pe in ss.phase_timeline(seg, fps):
            for f in range(ps, pe + 1):
                frame_phase[f] = (name, seg.seg_id)

    cap = cv2.VideoCapture(str(in_path))
    if not cap.isOpened():
        print(f"  ✗ 重新打开 {in_path} 失败", flush=True)
        writer.release()
        return

    print(f"\n[viz] 重读视频, 渲染 skeleton + 挥拍标记...", flush=True)
    progress = ss.ProgressBar(total=render_frames, label="[viz]")
    fidx = 0
    try:
        while fidx < render_frames:
            ok, frame = cap.read()
            if not ok:
                break
            canvas = frame.copy()
            kps = keypoints_per_frame[fidx] if fidx < len(keypoints_per_frame) else None
            if kps is not None:
                draw_skeleton_33(canvas, kps)
            # 粉红周期窄条 (30px, 贴底)
            for seg in segments:
                if seg.start_frame <= fidx <= seg.end_frame:
                    x1 = int(seg.start_frame / max(render_frames, 1) * width)
                    x2 = int(seg.end_frame / max(render_frames, 1) * width)
                    cv2.rectangle(canvas, (x1, height - 60), (x2, height - 30), (255, 0, 255), 3)
            # 底部状态方波 (20px, 贴底)
            ph = frame_phase.get(fidx)
            if ph is not None:
                name, sid = ph
                color = ss.PHASE_COLORS.get(name, (180, 180, 180))
                cv2.rectangle(canvas, (0, height - 25), (width, height - 5), color, -1)
                cv2.putText(canvas, f"#{sid} {name}  frame={fidx + 1}",
                            (10, height - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.5,
                            (255, 255, 255), 1, cv2.LINE_AA)
            else:
                cv2.rectangle(canvas, (0, height - 25), (width, height - 5), (60, 60, 60), -1)
                cv2.putText(canvas, f"idle  frame={fidx + 1}", (10, height - 9),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1, cv2.LINE_AA)
            writer.write(canvas)
            progress.update(fidx + 1)
            fidx += 1
    finally:
        cap.release()
        writer.release()
        progress.close()
    print(f"  ✓ {viz_path}", flush=True)


# ═══════════════════════════ 主流程 ═══════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description='统一挥拍分析 (swing detect + skeleton overlay + clip extraction)',
    )
    parser.add_argument('--file', '-f', default='fdl.mp4', help='输入视频')
    # 2026-08-28 user-direct：默认切到 lite 模型 (5.7MB),与 Flutter assets/models/pose_landmarker.task
    # 同源 (assets 版是 scripts/pose_landmarker_lite.task 的同 md5 链接);heavy (30MB) 是历史遗留
    parser.add_argument('--task', default='pose_landmarker_lite.task', help='MediaPipe task 文件 (默认 lite; Flutter 端用 assets/models/pose_landmarker.task)')
    parser.add_argument('--out-dir', default=None, help='输出目录 (默认 swing_segmenter/)')
    parser.add_argument('--max-frames', type=int, default=0)
    parser.add_argument('--skip', type=int, default=1)

    # 输出模式
    parser.add_argument('--save-clips', action='store_true', help='抽原始 clip mp4')
    parser.add_argument('--skel-clips', action='store_true', help='抽带 skeleton overlay 的 clip mp4')
    parser.add_argument('--viz-full', action='store_true', help='生成整段视频 viz (skeleton + 标记)')

    # Swing 参数
    parser.add_argument('--v-swing', type=float, default=0.10)
    parser.add_argument('--gap-merge', type=float, default=1.5, help='静止间隔合并阈值 (秒)')
    parser.add_argument('--max-bridge', type=float, default=1.5, help='漏检空洞合并阈值 (秒)')
    parser.add_argument('--min-peak', type=float, default=0.30)
    parser.add_argument('--smooth-alpha', type=float, default=0.65)
    parser.add_argument('--max-lost-frames', type=int, default=8)
    parser.add_argument('--min-dur', type=float, default=0.3)
    parser.add_argument('--max-dur', type=float, default=6.0)
    parser.add_argument('--buf-before', type=float, default=1.0)
    parser.add_argument('--buf-after', type=float, default=1.0)

    args = parser.parse_args()

    # ── Setup ──
    here = Path(__file__).parent.resolve()
    in_path = Path(args.file) if os.path.isabs(args.file) else (here / args.file)
    task_path = Path(args.task) if os.path.isabs(args.task) else (here / args.task)
    out_dir = Path(args.out_dir) if args.out_dir else (here / 'swing_segmenter')

    if not in_path.exists():
        print(f"ERROR: 视频不存在 {in_path}", file=sys.stderr); sys.exit(1)
    if not task_path.exists():
        print(f"ERROR: 模型不存在 {task_path}", file=sys.stderr); sys.exit(1)

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(in_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if total <= 0:
        print("  [info] 视频元数据无帧数, 预扫...", flush=True)
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        scanned = 0
        while True:
            ok, _ = cap.read()
            if not ok: break
            scanned += 1
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        total = scanned

    limit = total if args.max_frames <= 0 else min(total, args.max_frames)

    print(f"输入:    {in_path}")
    print(f"输出:    {out_dir}")
    print(f"视频:    {width}x{height} @ {fps:.1f}fps,  {total} 帧,  {total/fps:.1f}s"
          + (f" (处理前 {limit} 帧)" if limit < total else ""))
    print(f"参数:    v_swing={args.v_swing}  gap_merge={args.gap_merge}s  min_peak={args.min_peak}")
    print(f"输出:    save-clips={args.save_clips}  skel-clips={args.skel_clips}  viz-full={args.viz_full}")

    # ── 加载 MediaPipe ──
    print("\n加载 MediaPipe...", flush=True)
    pose = MediaPipePoseRunner(task_path)
    print("✓ MediaPipe 加载完成\n", flush=True)

    # ── Pass 1: 流式读视频, 存全 33 点 (供后续 skel-clips / viz 用) ──
    # 不在线 emit 了 — 之前 5 vs 11 不一致 + skel-clip race condition (后台读 keypoints 时主线程还没填)
    # 现在: 全部用 offline segment_cycles 一份结果, clip / segjson / viz 三者 1:1
    keypoints_per_frame: List[Optional[List[Tuple[float, float, float]]]] = [None] * limit
    n_valid = 0
    frame_idx = 0
    t0 = time.time()
    progress = ss.ProgressBar(total=limit, label="[pose]")

    try:
        skip = max(1, int(args.skip))
        while frame_idx < limit:
            ok, frame = cap.read()
            if not ok:
                break
            fidx = frame_idx
            frame_idx += 1

            if (fidx % skip) == 0:
                kps_33 = pose.detect_33(frame, int(((fidx + 1) / fps) * 1000.0))
                if kps_33 is not None:
                    keypoints_per_frame[fidx] = kps_33
                    n_valid += 1
            progress.update(frame_idx)
    except KeyboardInterrupt:
        print("\n[interrupt] Ctrl+C", flush=True)
    finally:
        cap.release()
        progress.close()

    detected_pct = 100.0 * n_valid / max(frame_idx, 1)
    print(f"  [pose] {n_valid}/{frame_idx} 帧检出 wrist ({detected_pct:.0f}%)", flush=True)

    # ── 离线 segment_cycles: 全部 wrist (x,y) 时序 → segments ──
    xs = [None] * frame_idx
    ys = [None] * frame_idx
    for i in range(frame_idx):
        kps = keypoints_per_frame[i]
        if kps is not None:
            xs[i], ys[i] = kps[WRIST_R][0], kps[WRIST_R][1]
    valid = [x is not None for x in xs]
    xb = ss.bridge_gaps(xs, valid, max_lost=args.max_lost_frames)
    yb = ss.bridge_gaps(ys, valid, max_lost=args.max_lost_frames)
    xs_s = ss.ema_smooth(xb, alpha=args.smooth_alpha)
    ys_s = ss.ema_smooth(yb, alpha=args.smooth_alpha)
    v = ss.compute_velocity_2d(xs_s, ys_s, fps=fps)

    segments = ss.segment_cycles(
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
              f"  击球@{seg.contact_timecode} peak v={seg.peak_velocity:.3f}"
              f"  dur={seg.duration_sec:.2f}s{merged_note}{over_note}", flush=True)

    # ── 用同一份 offline segments 抽 clip (raw + skel) ──
    # 保证 clip_NNN.mp4 / clip_NNN_skel.mp4 / segments.json / viz.mp4 四者 1:1 对应
    need_clips = args.save_clips or args.skel_clips
    clips_dir = out_dir / 'clips'
    if need_clips and segments:
        clips_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n[clip] 抽 {len(segments)} 段 clip (raw + skel)...", flush=True)
        for seg in segments:
            if args.save_clips:
                ss.extract_one_clip(in_path, seg, clips_dir, fps, width, height)
            if args.skel_clips:
                extract_skel_clip(in_path, seg, keypoints_per_frame, clips_dir, fps, width, height)
        print(f"  ✓ 所有 clip 已写入 {clips_dir}", flush=True)

    # ── 写 segments.json ──
    segs_data = []
    for s in segments:
        d = ss.asdict(s)
        d['peak_frame'] = s.peak_frame
        d['peak_timecode'] = s.peak_timecode
        d['phases'] = [
            {'phase': name, 'start_frame': ps, 'end_frame': pe}
            for (name, ps, pe) in ss.phase_timeline(s, fps)
        ]
        segs_data.append(d)
    json_path = out_dir / 'segments.json'
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({
            'input': str(in_path),
            'fps': fps,
            'total_frames': total,
            'processed_frames': frame_idx,
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
            },
            'segments': segs_data,
            'segment_count': len(segs_data),
        }, f, indent=2, ensure_ascii=False)

    elapsed = time.time() - t0
    print()
    print(f"✓ 完成: {len(segments)} 个挥拍周期")
    print(f"  耗时 {elapsed:.1f}s ({frame_idx/max(elapsed, 0.001):.1f} fps)")
    print(f"  JSON: {json_path}")
    if need_clips:
        print(f"  Clips: {clips_dir}")
    if args.viz_full:
        print(f"  Viz:   {out_dir / 'viz.mp4'}  (待渲染)")

    # ── 可选: Pass 2 整段 viz ──
    if args.viz_full:
        if segments:
            render_full_viz(in_path, segments, keypoints_per_frame,
                            out_dir, fps, width, height, render_frames=frame_idx)
        else:
            print("  [viz] 无 segment, 跳过", flush=True)


if __name__ == '__main__':
    main()
