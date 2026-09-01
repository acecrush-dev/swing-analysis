#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统一的骨骼动画视频生成器:RTMDet (画人框) + RTMPose / MediaPipe (画骨架)。
两个角色完全解耦,可独立加载,可任意组合:

  角色         模型文件                            用途
  ──────────  ─────────────────────────────────  ───────────────────
  --det-model  rtmdet-s-389d3a.onnx / -m-...onnx  画人框(绿框)
  --pose-model rtmpose-s-d976b6.onnx / -m-...onnx 画骨架(COCO-13)
               pose_landmarker_heavy.task          画骨架(MediaPipe 33)

四象限组合:
  1. RTMDet + RTMPose  (.onnx + .onnx)    经典流水线
  2. RTMDet + MediaPipe (.onnx + .task)    RTMDet 给框,MediaPipe 画骨架(混合)
  3. 仅 RTMDet          (.onnx + none)     只画人框,不画骨架
  4. 仅 RTMPose / MP    (none + .onnx/.task) 全帧姿态估计(没有 ROI)

不传任何模型: 优先 rtmpose-s → rtmpose-m → mediapipe heavy → full → lite 自动检测。

约束(2026-08-28 user-direct):
  1. 输入 = --file (默认 demo.mp4)   绝对不覆盖
  2. 输出 = demo_skeleton_anim.mp4
  3. 进度条 + Ctrl+C 优雅保存
  4. 用 RTMDet (画框) + RTMPose / MediaPipe (画骨架)

用法 (四象限 + 常用参数):

▌ 1. RTMDet + RTMPose   (经典 ONNX 流水线 — 需 conda test 环境含 onnxruntime)
    conda run -n test python gen_skeleton_anim.py \
        --det-model  rtmdet-s-389d3a.onnx \
        --pose-model rtmpose-s-d976b6.onnx

▌ 2. RTMDet + MediaPipe (混合 — RTMDet 给 ROI, MediaPipe 在 ROI 内画 33 点骨架)
    python3 gen_skeleton_anim.py \
        --det-model  rtmdet-s-389d3a.onnx \
        --pose-model pose_landmarker_heavy.task

▌ 3. 仅 RTMDet          (只画人框, 不画骨架 — --no-pose)
    conda run -n test python gen_skeleton_anim.py \
        --det-model rtmdet-s-389d3a.onnx --no-pose

▌ 4. 仅 RTMPose / MP    (全帧姿态估计 — 没有 ROI, 直接对整帧做姿态推理)
    4a. 仅 RTMPose (COCO-13):
        conda run -n test python gen_skeleton_anim.py \
            --pose-model rtmpose-s-d976b6.onnx
    4b. 仅 MediaPipe (33 点):
        python3 gen_skeleton_anim.py \
            --pose-model pose_landmarker_heavy.task

▌ 自动检测 (不传 --det-model / --pose-model — 按本地文件自动选用):
    conda run -n test python gen_skeleton_anim.py
    # 优先级: rtmpose-s + rtmdet-s → rtmpose-m + rtmdet-m
    #       → mediapipe pose_landmarker_heavy → _full → _lite
    # 本地有哪个就用哪个;若都没有则报错并列出期望文件名

▌ 常用参数:
    --file / -f       输入视频文件名 (默认 demo.mp4)
    --output / -o     输出视频文件名 (默认 demo_skeleton_anim.mp4, 绝不覆盖输入)
    --no-zoom         全帧输出模式 — 不做智能裁剪放大 (适合看整体动作)
    --draw-bbox       同时画出 RTMDet 绿框 + 稳定 ROI 粉框
    --max-frames N    只处理前 N 帧 (调试用, 提前截断)
    --skip N          每 N 帧采 1 帧处理 (降采样)
    --det-thresh 0.4  RTMDet 置信度阈值 (低于此分的人框丢弃)
    --det-interval N  每 N 帧跑一次 RTMDet (其余帧复用上一帧的检测结果)
    --pose-interval N 每 N 帧跑一次姿态估计 (其余帧复用上一帧关键点)

▌ 模型文件名约定 (放在脚本同目录即可):
    RTMDet  ONNX : rtmdet-s-389d3a.onnx  /  rtmdet-m-487628.onnx
    RTMPose ONNX : rtmpose-s-d976b6.onnx /  rtmpose-m-27c0e6.onnx
    MediaPipe    : pose_landmarker_heavy.task  /  _full.task  /  _lite.task
"""

import argparse
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np


# ═══════════════════════════ 配置 ═══════════════════════════

DEFAULT_RTMPOSE_S = "rtmpose-s-d976b6.onnx"
DEFAULT_RTMPOSE_M = "rtmpose-m-27c0e6.onnx"
DEFAULT_RTMDET_S  = "rtmdet-s-389d3a.onnx"
DEFAULT_RTMDET_M  = "rtmdet-m-487628.onnx"
MEDIAPIPE_TASKS   = ["pose_landmarker_heavy.task", "pose_landmarker_full.task", "pose_landmarker_lite.task"]

POSE_IMG_SIZE = (192, 256)
DET_IMG_SIZE  = (640, 640)
SIMCC_SPLIT_RATIO = 2.0
PERSON_CLASS_ID = 0

COCO17_TO_13 = {0: 0, 5: 1, 6: 2, 7: 3, 8: 4, 9: 5, 10: 6,
                11: 7, 12: 8, 13: 9, 14: 10, 15: 11, 16: 12}

COCO13_SKELETON = [
    (0, 1), (0, 2), (1, 2),
    (1, 3), (3, 5), (2, 4), (4, 6),
    (1, 7), (2, 8), (7, 8),
    (7, 9), (9, 11), (8, 10), (10, 12),
]

MP_IDX = {"nose": 0,
          "l_shoulder": 11, "r_shoulder": 12,
          "l_elbow": 13, "r_elbow": 14,
          "l_wrist": 15, "r_wrist": 16,
          "l_hip": 23, "r_hip": 24,
          "l_knee": 25, "r_knee": 26,
          "l_ankle": 27, "r_ankle": 28,
          "l_heel": 29, "r_heel": 30,
          "l_foot": 31, "r_foot": 32}
LEFT_IDS  = {MP_IDX[k] for k in ["l_shoulder","l_elbow","l_wrist",
                                  "l_hip","l_knee","l_ankle","l_heel","l_foot"]}
RIGHT_IDS = {MP_IDX[k] for k in ["r_shoulder","r_elbow","r_wrist",
                                  "r_hip","r_knee","r_ankle","r_heel","r_foot"]}
MP_SKELETON_33 = [
    (11,12),(11,23),(12,24),(23,24),
    (11,13),(13,15),(12,14),(14,16),
    (23,25),(25,27),(27,29),(27,31),(29,31),
    (24,26),(26,28),(28,30),(28,32),(30,32),
    (0,11),(0,12),
]

COLOR_LEFT        = (0, 0, 255)
COLOR_RIGHT       = (0, 255, 255)
COLOR_CENTER      = (0, 255, 0)
COLOR_BBOX_DET    = (0, 255, 0)
COLOR_BBOX_STABLE = (255, 0, 255)


# ═══════════════════════════ 数据结构 + 工具 ═══════════════════════════

@dataclass
class BBox:
    x1: int; y1: int; x2: int; y2: int
    score: float = 1.0

    @property
    def w(self): return self.x2 - self.x1

    @property
    def h(self): return self.y2 - self.y1

    @property
    def cx(self): return (self.x1 + self.x2) / 2.0

    @property
    def cy(self): return (self.y1 + self.y2) / 2.0


def letterbox_resize(image: np.ndarray, new_shape: Tuple[int, int]):
    h, w = image.shape[:2]
    new_w, new_h = new_shape
    scale = min(new_w / w, new_h / h)
    rw, rh = int(w * scale), int(h * scale)
    resized = cv2.resize(image, (rw, rh))
    canvas = np.full((new_h, new_w, 3), 114, dtype=np.uint8)
    dw = (new_w - rw) // 2
    dh = (new_h - rh) // 2
    canvas[dh:dh+rh, dw:dw+rw, :] = resized
    return canvas, scale, (dw, dh)


class CenterSmoother:
    def __init__(self, alpha=0.6):
        self.alpha = float(alpha)
        self.prev = None

    def reset(self):
        self.prev = None

    def apply(self, cx, cy):
        if self.prev is None:
            self.prev = (cx, cy); return cx, cy
        pcx, pcy = self.prev
        a = self.alpha
        self.prev = (a * cx + (1 - a) * pcx, a * cy + (1 - a) * pcy)
        return self.prev


class StableBoxAutoSizer:
    def __init__(self, warmup_frames=15, expand=0.45):
        self.warmup_frames = int(warmup_frames)
        self.expand = float(expand)
        self.aspect = None
        self.aspect_samples: List[float] = []
        self.target_w = None
        self.target_h = None

    def reset(self):
        self.aspect = None
        self.aspect_samples = []
        self.target_w = None
        self.target_h = None

    def update(self, x1, y1, x2, y2, frame_w, frame_h):
        bw = max(1.0, float(x2 - x1) * (1.0 + self.expand))
        bh = max(1.0, float(y2 - y1) * (1.0 + self.expand))
        if self.aspect is None:
            a = bw / max(1e-6, bh)
            self.aspect_samples.append(float(np.clip(a, 0.2, 5.0)))
            if len(self.aspect_samples) >= self.warmup_frames:
                self.aspect = float(np.median(np.asarray(self.aspect_samples, dtype=np.float32)))
                self.aspect = float(np.clip(self.aspect, 0.3, 3.0))
        aspect = self.aspect if self.aspect is not None else (bw / max(1e-6, bh))
        need_h = max(bh, bw / max(1e-6, aspect))
        need_w = aspect * need_h
        need_w = min(need_w, frame_w * 0.98)
        need_h = min(need_h, frame_h * 0.98)
        iw = int(round(max(64.0, need_w)))
        ih = int(round(max(64.0, need_h)))
        if self.target_w is None or self.target_h is None:
            self.target_w, self.target_h = iw, ih
        else:
            self.target_w = max(self.target_w, iw)
            self.target_h = max(self.target_h, ih)
        return self.target_w, self.target_h


def fixed_box_from_center(cx, cy, fw, fh, bw, bh) -> BBox:
    x1 = int(round(cx - bw / 2.0))
    y1 = int(round(cy - bh / 2.0))
    x2 = int(round(cx + bw / 2.0))
    y2 = int(round(cy + bh / 2.0))
    x1 = max(0, min(fw - 1, x1))
    y1 = max(0, min(fh - 1, y1))
    x2 = max(0, min(fw - 1, x2))
    y2 = max(0, min(fh - 1, y2))
    if x2 <= x1: x2 = min(fw - 1, x1 + 1)
    if y2 <= y1: y2 = min(fh - 1, y1 + 1)
    return BBox(x1, y1, x2, y2, 1.0)


def enclosing_fixed_box(raw_box, stable_box, fw, fh) -> BBox:
    if (stable_box.w >= raw_box.w) and (stable_box.h >= raw_box.h):
        return stable_box
    cx = (stable_box.x1 + stable_box.x2) / 2.0
    cy = (stable_box.y1 + stable_box.y2) / 2.0
    bw = max(stable_box.w, raw_box.w)
    bh = max(stable_box.h, raw_box.h)
    return fixed_box_from_center(cx, cy, fw, fh, int(bw), int(bh))


def crop_and_letterbox(frame, box, out_w, out_h):
    h, w = frame.shape[:2]
    x1 = max(0, min(w - 1, box.x1))
    y1 = max(0, min(h - 1, box.y1))
    x2 = max(0, min(w - 1, box.x2))
    y2 = max(0, min(h - 1, box.y2))
    if x2 <= x1 or y2 <= y1:
        return np.zeros((out_h, out_w, 3), dtype=np.uint8)
    roi = frame[y1:y2, x1:x2]
    rh, rw = roi.shape[:2]
    scale = min(out_w / rw, out_h / rh)
    nw = max(1, int(round(rw * scale)))
    nh = max(1, int(round(rh * scale)))
    r = cv2.resize(roi, (nw, nh))
    canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)
    dx = (out_w - nw) // 2
    dy = (out_h - nh) // 2
    canvas[dy:dy+nh, dx:dx+nw] = r
    return canvas


# ═══════════════════════════ ONNX 模型加载 (RTMDet / RTMPose 通用) ═══════════════════════════

def _make_onnx_session(model_path: Path, skip_coreml: bool = False):
    """Build an onnxruntime InferenceSession.

    Args:
        model_path: path to .onnx file.
        skip_coreml: if True, do NOT add CoreMLExecutionProvider to the
            provider list. Use this for models whose output shapes
            CoreML EP mis-infers statically (e.g. RTMDet — see
            `CoreML static output shape ({1,1,1,8400,8400}) and inferred
            shape ({1,8400}) have different ranks` on Apple Silicon).
    """
    import onnxruntime as ort
    if not model_path.exists():
        raise FileNotFoundError(f"ONNX 模型不存在: {model_path}")
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)
    available = set(ort.get_available_providers())
    preferred = []
    if not skip_coreml and "CoreMLExecutionProvider" in available:
        preferred.append("CoreMLExecutionProvider")
    if "CUDAExecutionProvider" in available: preferred.append("CUDAExecutionProvider")
    preferred.append("CPUExecutionProvider")
    providers = [p for p in preferred if p in available]
    print(f"    ONNX [{model_path.name}]: providers={providers} threads={so.intra_op_num_threads}", flush=True)
    return ort.InferenceSession(str(model_path), sess_options=so, providers=providers)


# ═══════════════════════════ RTMDet — 只画人框 ═══════════════════════════

class RtmdetRunner:
    """RTMDet 人物检测器 (输入: 整帧 → 输出: 人物 BBox 列表)。"""
    def __init__(self, model_path: Path):
        # skip_coreml=True: CoreML EP mis-infers RTMDet's output shape
        # (`{1,1,1,8400,8400}` static vs `{1,8400}` actual) on Apple Silicon
        # and crashes mid-run. CPU EP is plenty fast for RTMDet-m anyway.
        self.session = _make_onnx_session(model_path, skip_coreml=True)

    def detect(self, frame: np.ndarray, score_thresh: float = 0.4) -> List[BBox]:
        input_name = self.session.get_inputs()[0].name
        _, _, in_h, in_w = self.session.get_inputs()[0].shape
        resized, scale, (dw, dh) = letterbox_resize(frame, (in_w, in_h))
        img = resized.astype(np.float32) / 255.0
        img = img.transpose(2, 0, 1)[None, ...]
        outputs = self.session.run(None, {input_name: img})
        boxes_raw = np.asarray(outputs[0])[0]
        labels = np.asarray(outputs[1])[0].astype(int)
        h0, w0 = frame.shape[:2]
        out: List[BBox] = []
        for det, cls in zip(boxes_raw, labels):
            if cls != PERSON_CLASS_ID: continue
            x1, y1, x2, y2, score = det.tolist()
            if float(score) < score_thresh: continue
            x1 = max(0, min(w0 - 1, int((x1 - dw) / scale)))
            y1 = max(0, min(h0 - 1, int((y1 - dh) / scale)))
            x2 = max(0, min(w0 - 1, int((x2 - dw) / scale)))
            y2 = max(0, min(h0 - 1, int((y2 - dh) / scale)))
            if x2 <= x1 or y2 <= y1: continue
            out.append(BBox(x1, y1, x2, y2, float(score)))
        return sorted(out, key=lambda b: b.score, reverse=True)


# ═══════════════════════════ RTMPose — 只画骨架 (COCO-13) ═══════════════════════════

class RtmposeRunner:
    """RTMPose 姿态估计器 (输入: ROI → 输出: COCO-13 全图归一化坐标)。"""
    def __init__(self, model_path: Path):
        self.session = _make_onnx_session(model_path)

    def pose(self, frame: np.ndarray, box: Optional[BBox] = None) -> Optional[List[Tuple[float, float, float]]]:
        """RTMPose 姿态估计。box=None → 全帧输入(用户没传 --det-model)。"""
        if box is None:
            roi = frame
        else:
            roi = frame[box.y1:box.y2, box.x1:box.x2]
        if roi.size == 0: return None
        w, h = POSE_IMG_SIZE
        resized = cv2.resize(roi, (w, h))
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        inp = np.transpose(rgb, (2, 0, 1))[None, ...]
        input_name = self.session.get_inputs()[0].name
        outputs = self.session.run(None, {input_name: inp})
        o0, o1 = outputs[0], outputs[1]
        if o0.shape[-1] < o1.shape[-1]:
            simcc_x, simcc_y = o0, o1
        else:
            simcc_x, simcc_y = o1, o0
        kps13_norm = self._decode_simcc(simcc_x, simcc_y)
        h0, w0 = frame.shape[:2]
        if box is None:
            # 全帧模式:kps 已经是原图归一化坐标,直接返回
            return [(nx, ny, conf) for (nx, ny, conf) in kps13_norm]
        bw, bh = box.w, box.h
        return [((box.x1 + nx * bw) / w0, (box.y1 + ny * bh) / h0, conf)
                for (nx, ny, conf) in kps13_norm]

    @staticmethod
    def _decode_simcc(simcc_x, simcc_y) -> List[Tuple[float, float, float]]:
        simcc_x = simcc_x[0]; simcc_y = simcc_y[0]
        H, W = POSE_IMG_SIZE[1], POSE_IMG_SIZE[0]

        def soft(x):
            x = x.astype(np.float32)
            m = float(np.max(x))
            return np.exp(x - m) / (float(np.sum(np.exp(x - m))) + 1e-8)

        def soft_argmax(prob, peak, radius=2):
            n = prob.shape[0]
            l = max(0, peak - radius); r = min(n - 1, peak + radius)
            w = prob[l:r + 1].astype(np.float64)
            s = float(w.sum())
            if s <= 1e-12: return float(peak)
            idxs = np.arange(l, r + 1, dtype=np.float64)
            return float((w * idxs).sum() / s)

        def sigmoid(x):
            x = max(-20.0, min(20.0, x))
            return 1.0 / (1.0 + np.exp(-x))

        out17 = []
        for k in range(17):
            x_prob = soft(simcc_x[k]); y_prob = soft(simcc_y[k])
            x_idx = int(np.argmax(x_prob)); y_idx = int(np.argmax(y_prob))
            conf = (sigmoid(float(simcc_x[k][x_idx])) + sigmoid(float(simcc_y[k][y_idx]))) / 2.0
            x_bin = soft_argmax(x_prob, x_idx, radius=2)
            y_bin = soft_argmax(y_prob, y_idx, radius=2)
            out17.append((float((x_bin / SIMCC_SPLIT_RATIO) / W),
                          float((y_bin / SIMCC_SPLIT_RATIO) / H), float(conf)))

        out13 = [(0.0, 0.0, 0.0)] * 13
        for i17, i13 in COCO17_TO_13.items():
            out13[i13] = out17[i17]
        return out13


# ═══════════════════════════ MediaPipe — 只画骨架 (33 点) ═══════════════════════════

class MediaPipePoseRunner:
    """MediaPipe Tasks PoseLandmarker (33 点)。"""
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

    def pose(self, frame: np.ndarray, ts_ms: int) -> Optional[List[Tuple[float, float, float]]]:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        res = self.detector.detect_for_video(mp_img, ts_ms)
        if not res or not res.pose_landmarks:
            return None
        lms = res.pose_landmarks[0]
        return [(float(lm.x), float(lm.y),
                 float(getattr(lm, "visibility", 0.0) or 0.0)) for lm in lms]


# ═══════════════════════════ 模型解析 ═══════════════════════════

def _resolve_model_arg(arg: Optional[str], here: Path) -> Optional[Path]:
    """把文件名/相对路径解析为绝对路径。None 表示不指定。"""
    if arg is None: return None
    p = Path(arg)
    if not p.is_absolute():
        p = here / p
    if not p.exists():
        raise FileNotFoundError(f"模型文件不存在: {p}")
    return p


def resolve_models(det_arg: Optional[str], pose_arg: Optional[str],
                   here: Path, no_pose: bool = False):
    """
    返回 (det_path, pose_runner_or_None, pose_kind)
      - det_path:    Path or None   (.onnx RTMDet)
      - pose_kind:   'coco13' | 'mp33' | None
      - pose_path:   (内部用,实际返回 det_path 和 (pose_runner_factory, pose_kind))
    """
    det_path = _resolve_model_arg(det_arg, here) if det_arg else None
    pose_path = _resolve_model_arg(pose_arg, here) if pose_arg else None

    # 用户显式传了 det_model → 验证 .onnx
    if det_path and det_path.suffix.lower() != ".onnx":
        raise ValueError(f"--det-model 必须是 .onnx (RTMDet),收到: {det_path.name}")

    # 用户显式传了 pose_model → 按后缀决定 pose 类型
    # 注意:不自动配对 RTMDet — 用户没传 --det-model 就走全帧 RTMPose
    # (RTMPose 本来就是整图归一化坐标,只 ROI 模式下才需要 RTMDet)
    pose_kind = None
    if pose_path:
        suf = pose_path.suffix.lower()
        if suf == ".onnx":
            pose_kind = "coco13"
        elif suf == ".task":
            pose_kind = "mp33"
        else:
            raise ValueError(f"--pose-model 后缀必须是 .onnx 或 .task,收到: {pose_path.name}")

    # 用户没指定 det_model / pose_model → 自动检测
    # 2026-08-28 user-direct: 最小模型已移入 Flutter assets (assets/models/,
    # 文件名 rtmpose-s.onnx / rtmdet-s.onnx), scripts/ 下不再留 ONNX —
    # 自动检测顺序: assets/models/ 的 -s 对 → scripts/ 旧名(兼容) → MediaPipe
    assets_models = here.parent / 'assets' / 'models'
    if det_path is None and pose_path is None:
        for pose_name, det_name in [(DEFAULT_RTMPOSE_S, DEFAULT_RTMDET_S),
                                    (DEFAULT_RTMPOSE_M, DEFAULT_RTMDET_M)]:
            p = here / pose_name; d = here / det_name
            if p.exists() and d.exists():
                pose_path = p; det_path = d; pose_kind = "coco13"
                break
        if pose_path is None:
            # assets/models/ 新名字 (-s 档)
            p2 = assets_models / 'rtmpose-s.onnx'
            d2 = assets_models / 'rtmdet-s.onnx'
            if p2.exists() and d2.exists():
                pose_path = p2; det_path = d2; pose_kind = "coco13"
        # 退化到 MediaPipe
        if pose_path is None:
            for cand in MEDIAPIPE_TASKS:
                p = here / cand
                if p.exists():
                    pose_path = p; pose_kind = "mp33"
                    break
        if pose_path is None:
            raise FileNotFoundError(
                f"找不到任何可用模型。放下列任一文件到 {here}/:\n"
                f"  ONNX:    {DEFAULT_RTMPOSE_S} + {DEFAULT_RTMDET_S} (或 -m- 系列)\n"
                f"  MediaPipe: {' / '.join(MEDIAPIPE_TASKS)}"
            )

    # --no-pose: 不加载 pose 模型
    if no_pose:
        pose_path = None
        pose_kind = None

    return det_path, pose_path, pose_kind


def _load_one(label: str, path: Path, factory):
    """加载单个模型 — 打印 文件大小 + 耗时。失败时原样抛异常让上层处理。"""
    size_mb = (os.path.getsize(path) / 1024 / 1024) if path.exists() else 0.0
    print(f'  [{label}] 加载 {path.name} ({size_mb:.1f} MB)...', flush=True)
    t0 = time.time()
    obj = factory()
    dt_ms = (time.time() - t0) * 1000.0
    print(f'  ✓ [{label}] 加载完成 ({dt_ms:.0f} ms)', flush=True)
    return obj


def build_runners(det_path: Optional[Path], pose_path: Optional[Path], pose_kind: Optional[str]):
    """构造 (det_runner, pose_runner) — 任一可为 None;带逐模型日志。"""
    det_runner = None
    if det_path is not None:
        det_runner = _load_one('RTMDet', det_path, lambda: RtmdetRunner(det_path))
    pose_runner = None
    if pose_path is not None and pose_kind is not None:
        if pose_kind == "coco13":
            pose_runner = _load_one('RTMPose', pose_path, lambda: RtmposeRunner(pose_path))
        elif pose_kind == "mp33":
            pose_runner = _load_one('MediaPipe', pose_path, lambda: MediaPipePoseRunner(pose_path))
    return det_runner, pose_runner


# ═══════════════════════════ 算法标签 (左上角 HUD) ═══════════════════════════

def _det_label(p: Optional[Path]) -> Optional[str]:
    """rtmdet-s-389d3a.onnx → 'RTMDet-S'; rtmdet-m-...onnx → 'RTMDet-M'; None → None"""
    if p is None: return None
    n = p.stem.lower()
    size = "M" if "-m-" in n else "S"
    return f"RTMDet-{size}"


def _pose_label(p: Optional[Path], kind: Optional[str]) -> Optional[str]:
    """按 kind 输出姿态算法简称;MediaPipe 系列统一标 'MediaPipe'。"""
    if p is None or kind is None: return None
    if kind == "coco13":
        size = "M" if "-m-" in p.stem.lower() else "S"
        return f"RTMPose-{size}"
    return "MediaPipe"


def build_algo_label(det_path: Optional[Path], pose_path: Optional[Path],
                     pose_kind: Optional[str], no_zoom: bool) -> str:
    """
    生成给左上角 HUD 用的算法标签字符串。组合示例:
      det + pose          → 'RTMDet-S + RTMPose-S'   /  'RTMDet-S + MediaPipe'
      仅 pose (全帧)       → 'RTMPose-M (full-frame)' /  'MediaPipe (full-frame)'
      仅 det (--no-pose)   → 'RTMDet-S (bbox only)'
    """
    det_lbl  = _det_label(det_path)
    pose_lbl = _pose_label(pose_path, pose_kind)
    if det_lbl and pose_lbl:
        return f"{det_lbl} + {pose_lbl}"
    if pose_lbl:
        suffix = "" if no_zoom else " (full-frame)"
        # MediaPipe 默认即全帧;只有 RTMPose 需要 (full-frame) 提示
        return f"{pose_lbl}{suffix}" if pose_kind == "coco13" else f"{pose_lbl}"
    if det_lbl:
        return f"{det_lbl} (bbox only)"
    return "(no algorithm)"


# ═══════════════════════════ 关键点平滑 ═══════════════════════════

class KeypointSmoother:
    def __init__(self, n_points=13, alpha=0.7, vis_thresh=0.35, hold_frames=2):
        self.n = int(n_points)
        self.alpha = float(alpha)
        self.vis_thresh = float(vis_thresh)
        self.hold = int(hold_frames)
        self.prev = None
        self.miss = [0] * self.n

    def reset(self):
        self.prev = None
        self.miss = [0] * self.n

    def apply(self, kps):
        if kps is None or len(kps) != self.n:
            self.prev = list(kps) if kps and len(kps) == self.n else None
            self.miss = [0] * self.n
            return list(kps) if kps else [(0.0, 0.0, 0.0)] * self.n
        if self.prev is None:
            self.prev = list(kps); self.miss = [0] * self.n
            return list(kps)
        out = []
        for i in range(self.n):
            nx, ny, conf = kps[i]
            px, py, pc = self.prev[i]
            if conf >= self.vis_thresh:
                out.append((self.alpha * nx + (1 - self.alpha) * px,
                            self.alpha * ny + (1 - self.alpha) * py, float(conf)))
                self.miss[i] = 0
            else:
                self.miss[i] += 1
                if self.miss[i] <= self.hold and pc >= self.vis_thresh:
                    out.append((float(px), float(py), float(pc * 0.95)))
                else:
                    out.append((0.0, 0.0, 0.0))
        self.prev = out
        return out


# ═══════════════════════════ 绘制 ═══════════════════════════

def _kp_color_coco13(idx):
    left_ids = {1, 3, 5, 7, 9, 11}; right_ids = {2, 4, 6, 8, 10, 12}
    if idx in left_ids: return COLOR_LEFT
    if idx in right_ids: return COLOR_RIGHT
    return COLOR_CENTER


def _kp_color_mp33(idx):
    if idx in LEFT_IDS: return COLOR_LEFT
    if idx in RIGHT_IDS: return COLOR_RIGHT
    return COLOR_CENTER


def _conn_color_coco13(i1, i2):
    center_pairs = {(0,1),(0,2),(1,2),(1,7),(2,8),(7,8)}
    if (i1,i2) in center_pairs or (i2,i1) in center_pairs: return COLOR_CENTER
    left_ids = {1, 3, 5, 7, 9, 11}; right_ids = {2, 4, 6, 8, 10, 12}
    if i1 in left_ids and i2 in left_ids: return COLOR_LEFT
    if i1 in right_ids and i2 in right_ids: return COLOR_RIGHT
    return COLOR_CENTER


def _conn_color_mp33(i1, i2):
    trunk = {(11,12),(11,23),(12,24),(23,24),(0,11),(0,12)}
    if (i1,i2) in trunk or (i2,i1) in trunk: return COLOR_CENTER
    if i1 in LEFT_IDS and i2 in LEFT_IDS: return COLOR_LEFT
    if i1 in RIGHT_IDS and i2 in RIGHT_IDS: return COLOR_RIGHT
    return COLOR_CENTER


def draw_skeleton(canvas, kps, kind, conf_thresh=0.20, line_thresh=None):
    """绘制骨架。conf_thresh 默认 0.20 (挥拍中手腕/肘部 conf 经常较低)。"""
    h, w = canvas.shape[:2]
    if line_thresh is None: line_thresh = max(0.05, conf_thresh * 0.5)
    skeleton = COCO13_SKELETON if kind == "coco13" else MP_SKELETON_33
    kp_color = _kp_color_coco13 if kind == "coco13" else _kp_color_mp33
    conn_color = _conn_color_coco13 if kind == "coco13" else _conn_color_mp33
    for i1, i2 in skeleton:
        _, _, c1 = kps[i1]; _, _, c2 = kps[i2]
        if not ((c1 > line_thresh and c2 > line_thresh) or
                (max(c1,c2) > conf_thresh and min(c1,c2) > line_thresh)):
            continue
        x1 = int(kps[i1][0] * w); y1 = int(kps[i1][1] * h)
        x2 = int(kps[i2][0] * w); y2 = int(kps[i2][1] * h)
        cv2.line(canvas, (x1, y1), (x2, y2), conn_color(i1, i2), 2, cv2.LINE_AA)
    for idx, (nx, ny, conf) in enumerate(kps):
        if conf <= conf_thresh: continue
        x = int(nx * w); y = int(ny * h)
        cv2.circle(canvas, (x, y), 4, kp_color(idx), -1, cv2.LINE_AA)
        cv2.circle(canvas, (x, y), 4, (0, 0, 0), 1, cv2.LINE_AA)


# ═══════════════════════════ 进度条 ═══════════════════════════

class ProgressBar:
    def __init__(self, total: int, label: str = "",
                 bar_width: int = 30, min_interval_s: float = 0.2):
        self.total = max(1, int(total))
        self.label = label
        self.bar_width = int(bar_width)
        self.min_interval = float(min_interval_s)
        self.start_t = time.time()
        self.last_t = self.start_t
        self.done = False
        self._draw(0, 0.0)

    def _fmt_eta(self, eta_s):
        if not (eta_s == eta_s) or eta_s == float("inf") or eta_s > 86400 * 30:
            return "ETA  --"
        s = max(0, int(eta_s))
        if s >= 3600:
            return f"ETA  {s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"
        return f"ETA  {s // 60}:{s % 60:02d}"

    def _draw(self, current, fps_now, force=False):
        pct = current / self.total
        filled = int(round(self.bar_width * pct))
        bar = "[" + "#" * filled + "-" * (self.bar_width - filled) + "]"
        # \r 回到行首 + \033[2K 清空整行 → 防止行变短时残留字符 (ETA 从 0:30 缩到 0:05 时)
        line = (f"\r\033[2K{self.label}  {bar}  {pct * 100:5.1f}%  "
                f"{current}/{self.total}  {fps_now:5.1f}fps  "
                + self._fmt_eta((self.total - current) / max(fps_now, 1e-6)))
        sys.stdout.write(line); sys.stdout.flush()

    def update(self, current):
        if self.done: return
        # 首帧强制画一次 — 否则 0% 之后到下次 0.1s 间隔之间可能什么都看不到
        force = (current == self.total) or (current == 1)
        now = time.time()
        if not force and (now - self.last_t) < self.min_interval: return
        elapsed = now - self.start_t
        fps_now = current / elapsed if elapsed > 0 else 0.0
        self._draw(current, fps_now, force=force)
        self.last_t = now
        if current >= self.total:
            self.done = True
            sys.stdout.write("\n"); sys.stdout.flush()

    def close(self):
        if not self.done:
            self.update(self.total)


# ═══════════════════════════ 主流程 ═══════════════════════════

def main():
    parser = argparse.ArgumentParser(description='骨骼动画视频生成器 (RTMDet 画框 + RTMPose / MediaPipe 画骨架)')
    parser.add_argument('--file',       '-f', type=str, default='demo.mp4',
                        help='输入文件名 (默认 demo.mp4)')
    parser.add_argument('--output',     '-o', type=str, default=None)
    parser.add_argument('--det-model',  '-d', type=str, default=None,
                        help='RTMDet 模型 (.onnx)。省略时按 --pose-model 自动配对')
    parser.add_argument('--pose-model', '-p', type=str, default=None,
                        help='姿态模型 (.onnx=RTMPose / .task=MediaPipe)')
    parser.add_argument('--model',      '-m', type=str, default=None,
                        help='(旧) 等价于 --pose-model,保留兼容')
    parser.add_argument('--no-pose',    action='store_true',
                        help='只画人框,不画骨架 (RTMDet 独立运行)')
    parser.add_argument('--max-frames', type=int, default=0)
    parser.add_argument('--skip',       type=int, default=1)
    parser.add_argument('--det-thresh', type=float, default=0.4)
    parser.add_argument('--det-interval',  type=int, default=1)
    parser.add_argument('--pose-interval', type=int, default=1)
    parser.add_argument('--no-zoom', action='store_true')
    parser.add_argument('--draw-bbox', action='store_true', help='画绿框(RTMDet) + 粉框(稳定 ROI)')
    args = parser.parse_args()

    here = Path(__file__).parent.resolve()
    in_path  = Path(args.file) if os.path.isabs(args.file) else (here / args.file)
    out_path = Path(args.output) if args.output else (here / 'demo_skeleton_anim.mp4')
    in_abs, out_abs = in_path.resolve(), out_path.resolve()

    if in_abs == out_abs:
        print(f'ERROR: 输入 == 输出 ({in_abs})', file=sys.stderr); sys.exit(1)
    if not in_abs.exists():
        print(f'ERROR: 输入不存在 {in_abs}', file=sys.stderr); sys.exit(1)

    # ── 解析 + 加载 ──
    # --model 向后兼容 → 转到 --pose-model
    pose_arg = args.pose_model or args.model
    try:
        det_path, pose_path, pose_kind = resolve_models(
            args.det_model, pose_arg, here, no_pose=args.no_pose)
    except (FileNotFoundError, ValueError) as e:
        print(f'ERROR: {e}', file=sys.stderr); sys.exit(1)

    print(f'输入:    {in_abs}')
    print(f'输出:    {out_abs}  (新文件,不动输入)')
    print(f'检测:    {det_path.name if det_path else "(无)"}')
    print(f'姿态:    {pose_path.name + " (" + ("COCO-13" if pose_kind == "coco13" else "MediaPipe-33") + ")" if pose_path else "(无)"}')
    print(f'模式:    {"全帧" if args.no_zoom else "智能裁剪放大 (zoom)"}')

    algo_label = build_algo_label(det_path, pose_path, pose_kind, args.no_zoom)
    print(f'左上角水印: {algo_label}')

    print('\n加载模型...', flush=True)
    _t_load0 = time.time()
    det_runner, pose_runner = build_runners(det_path, pose_path, pose_kind)
    print(f'✓ 全部模型加载完成 (总耗时 {(time.time() - _t_load0) * 1000.0:.0f} ms)\n', flush=True)

    cap = cv2.VideoCapture(str(in_abs))
    if not cap.isOpened():
        print(f'ERROR: 无法打开 {in_abs}', file=sys.stderr); sys.exit(1)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # 兜底:很多 MP4 文件 CAP_PROP_FRAME_COUNT 返回 0(OpenCV 元数据 bug),
    # 这会让 ProgressBar(total=0)→self.total=1,首帧直接跳 100% 后再也不更新。
    # 手动遍历一遍精确计数(只读不处理,几十毫秒代价)。
    if total <= 0:
        print('  [info] 视频元数据无帧数,正在预扫计数...', flush=True)
        cnt_pos = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        scanned = 0
        while True:
            ok, _ = cap.read()
            if not ok: break
            scanned += 1
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # 重置到开头,让后面主循环从头读
        total = scanned
        print(f'  [info] 预扫完成, 共 {total} 帧 (cap 位置已重置,POS={cnt_pos}→0)', flush=True)

    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    writer = cv2.VideoWriter(str(out_abs), fourcc, fps, (width, height))
    if not writer.isOpened():
        print(f'ERROR: VideoWriter 打开失败', file=sys.stderr); sys.exit(1)

    n_kps = 13 if pose_kind == "coco13" else (33 if pose_kind == "mp33" else 0)
    smoother = KeypointSmoother(n_points=n_kps, alpha=0.7, vis_thresh=0.35, hold_frames=2) \
               if n_kps else None
    center_smoother = CenterSmoother(alpha=0.6)
    auto_sizer = StableBoxAutoSizer(warmup_frames=15, expand=0.45)

    last_det_box: Optional[BBox] = None
    last_stable_box: Optional[BBox] = None
    last_kps = None

    frame_idx = 0
    processed = 0
    start_time = time.time()
    skip = max(1, int(args.skip))

    if args.max_frames > 0:
        expected_processed = min(args.max_frames, total) // skip
    else:
        expected_processed = total // skip

    backend_tag = "RTMPose" if pose_kind == "coco13" else ("MediaPipe" if pose_kind == "mp33" else "DET-ONLY")
    # 注意:这两行 print 必须在 ProgressBar 之前 —— ProgressBar 用 \r 刷新当前行,
    # 之后任何 \n 都会把 cursor 推到下一行,后续 \r 永远刷不回来 → 进度条消失。
    print(f'开始处理 {expected_processed} 帧 (输入 {total} 帧, skip={skip})...', flush=True)
    print(f'中断请按 Ctrl+C — 已处理的帧会自动落盘到输出文件', flush=True)
    progress = ProgressBar(
        total=expected_processed,
        label=f"{backend_tag}  fps={fps:.1f}  mode={'full' if args.no_zoom else 'zoom'}",
        bar_width=30, min_interval_s=0.1,
    )

    try:
        while True:
            ok, frame = cap.read()
            if not ok: break
            frame_idx += 1

            if args.max_frames > 0 and frame_idx > args.max_frames:
                print(f'  --max-frames={args.max_frames} 截断'); break

            if skip > 1 and ((frame_idx - 1) % skip) != 0:
                continue
            processed += 1
            h0, w0 = frame.shape[:2]

            # ── 1. 检测 (RTMDet) ──
            det_box: Optional[BBox] = None
            if det_runner is not None:
                do_det = (processed == 1) or (int(args.det_interval) <= 1) or \
                         (processed % int(args.det_interval) == 0)
                if do_det:
                    boxes = det_runner.detect(frame, score_thresh=float(args.det_thresh))
                    if boxes:
                        det_box = boxes[0]; last_det_box = det_box
                    else:
                        last_det_box = None
                        center_smoother.reset(); auto_sizer.reset()
                        last_stable_box = None
                else:
                    det_box = last_det_box

            # ── 2. 稳定 ROI (粉框) ──
            stable_box: Optional[BBox] = None
            if det_box is not None:
                scx, scy = center_smoother.apply(det_box.cx, det_box.cy)
                tw, th = auto_sizer.update(det_box.x1, det_box.y1,
                                           det_box.x2, det_box.y2, w0, h0)
                scb = fixed_box_from_center(scx, scy, w0, h0, tw, th)
                stable_box = enclosing_fixed_box(det_box, scb, w0, h0)
                last_stable_box = stable_box

            # ── 3. 姿态 ──
            raw_kps = None
            if pose_runner is not None:
                do_pose = (processed == 1) or (int(args.pose_interval) <= 1) or \
                          (processed % int(args.pose_interval) == 0)

                if pose_kind == "coco13":
                    if do_pose:
                        if det_box is not None:
                            # ROI 模式:用 RTMDet bbox 裁出 person ROI 再推理
                            kps = pose_runner.pose(frame, det_box)
                        else:
                            # 全帧模式:用户没传 --det-model,直接对整帧做姿态估计
                            kps = pose_runner.pose(frame, None)
                        if kps is not None: raw_kps = kps; last_kps = raw_kps
                    else:
                        raw_kps = last_kps

                elif pose_kind == "mp33":
                    # MediaPipe: 全帧 + ts
                    if do_pose:
                        ts_ms = int((frame_idx / fps) * 1000.0)
                        lms = pose_runner.pose(frame, ts_ms)
                        if lms is not None:
                            raw_kps = lms; last_kps = raw_kps
                            smoother.reset()
                        else:
                            last_kps = None
                    else:
                        raw_kps = last_kps

                    # MediaPipe 后端: 即使没 --det-model,也用 landmarks 估算稳定框
                    if raw_kps is not None and any(c > 0.3 for (_, _, c) in raw_kps):
                        bb_pts = [(x, y) for (x, y, v) in raw_kps if v >= 0.3]
                        if len(bb_pts) >= 4:
                            xs = [p[0] for p in bb_pts]; ys = [p[1] for p in bb_pts]
                            nx1, nx2 = min(xs), max(xs); ny1, ny2 = min(ys), max(ys)
                            pad = 0.05
                            cx_n = (nx1 + nx2) / 2.0; cy_n = (ny1 + ny2) / 2.0
                            bw_n = (nx2 - nx1) * (1 + 2 * pad); bh_n = (ny2 - ny1) * (1 + 2 * pad)
                            scx, scy = center_smoother.apply(cx_n, cy_n)
                            tw, th = auto_sizer.update(cx_n - bw_n/2, cy_n - bh_n/2,
                                                        cx_n + bw_n/2, cy_n + bh_n/2, 1, 1)
                            sb_norm = fixed_box_from_center(scx, scy, 1, 1, tw, th)
                            px1 = max(0, min(w0 - 1, int(round(sb_norm.x1 * w0))))
                            py1 = max(0, min(h0 - 1, int(round(sb_norm.y1 * h0))))
                            px2 = max(0, min(w0 - 1, int(round(sb_norm.x2 * w0))))
                            py2 = max(0, min(h0 - 1, int(round(sb_norm.y2 * h0))))
                            last_stable_box = BBox(px1, py1, px2, py2, 1.0)
                    else:
                        if det_runner is None:
                            center_smoother.reset(); auto_sizer.reset()
                            last_stable_box = None

            # 平滑
            if smoother is not None and raw_kps is not None:
                kps = smoother.apply(raw_kps)
            else:
                kps = None

            # ── 4. 构图输出帧 ──
            # 决定裁剪框:zoom 模式必须用 det_box (与 RTMPose 推理 ROI 一致),
            # 否则 keypoint 会错位。stable_box 只用于画粉框 (--draw-bbox)。
            zoom_box = det_box if (not args.no_zoom) else None
            if zoom_box is None or (det_runner is None and pose_kind in ("mp33", "coco13")):
                # no-zoom 模式,或没有 det 但有 MediaPipe(用 landmarks 估算的 stable_box)
                out = frame.copy()
                if args.draw_bbox and det_box is not None:
                    cv2.rectangle(out, (det_box.x1, det_box.y1),
                                  (det_box.x2, det_box.y2), COLOR_BBOX_DET, 2)
                if args.draw_bbox and last_stable_box is not None:
                    cv2.rectangle(out, (last_stable_box.x1, last_stable_box.y1),
                                  (last_stable_box.x2, last_stable_box.y2),
                                  COLOR_BBOX_STABLE, 2)
                if kps is not None and pose_kind is not None:
                    draw_skeleton(out, kps, pose_kind, conf_thresh=0.20)
            else:
                # zoom: 用 det_box 裁剪 (与 RTMPose 推理 ROI 完全一致 → keypoint 对齐)
                out = crop_and_letterbox(frame, zoom_box, width, height)
                ex1, ey1, ex2, ey2 = zoom_box.x1, zoom_box.y1, zoom_box.x2, zoom_box.y2
                bw_c = max(1, ex2 - ex1); bh_c = max(1, ey2 - ey1)
                sc = min(width / bw_c, height / bh_c)
                nw = max(1, int(round(bw_c * sc))); nh = max(1, int(round(bh_c * sc)))
                dx = (width - nw) // 2; dy = (height - nh) // 2
                if kps is not None and pose_kind is not None:
                    kps_canvas = []
                    for (nx, ny, conf) in kps:
                        # kps 是相对原图的归一化坐标
                        px_orig = nx * w0; py_orig = ny * h0
                        # 映射到 det_box 内像素 → letterbox 后画布像素
                        in_x = px_orig - ex1; in_y = py_orig - ey1
                        cn_x = (in_x / bw_c) * nw + dx
                        cn_y = (in_y / bh_c) * nh + dy
                        kps_canvas.append((cn_x / width, cn_y / height, conf))
                    draw_skeleton(out, kps_canvas, pose_kind, conf_thresh=0.20)

            # HUD — y=68 留 40px 给手机状态栏/刘海/灵动岛 (避免被系统 UI 盖住)
            hud = f'{backend_tag}  frame {frame_idx}/{total}'
            cv2.putText(out, hud, (width - 320, 68),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 2, cv2.LINE_AA)
            cv2.putText(out, hud, (width - 321, 68),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)

            # 左上角算法水印 — 标记本次生成用的是哪条算法流水线
            # 留 60px 给手机状态栏 / 刘海 / 灵动岛;挪太上会被系统 UI 盖住
            cv2.putText(out, algo_label, (10, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.60, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(out, algo_label, (10, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.60, (0, 255, 255), 1, cv2.LINE_AA)

            writer.write(out)
            progress.update(processed)

    except KeyboardInterrupt:
        print('\n[interrupt] Ctrl+C — 关闭 VideoWriter 以保证文件可读...', flush=True)
    finally:
        cap.release()
        writer.release()
        progress.close()

    elapsed = time.time() - start_time
    size = os.path.getsize(out_abs) if out_abs.exists() else 0
    ok_readback = False; rb_frames = 0
    if processed > 0 and out_abs.exists():
        try:
            rb = cv2.VideoCapture(str(out_abs))
            if rb.isOpened():
                ok_readback = True; rb_frames = int(rb.get(cv2.CAP_PROP_FRAME_COUNT))
            rb.release()
        except Exception:
            pass

    status = '[done]' if processed >= expected_processed else '[partial-saved]'
    print()
    print(f'{status} {out_abs}')
    print(f'   {size:,} bytes ({size/1024/1024:.1f} MB)')
    print(f'   {processed}/{expected_processed} 帧, 耗时 {elapsed:.1f}s '
          f'({processed/max(elapsed, 0.001):.1f} fps)')
    if processed > 0:
        if ok_readback:
            print(f'   回读校验: 视频可正常打开, 内含 {rb_frames} 帧')
        else:
            print(f'   [warn] 回读校验失败: 文件可能损坏')
    print(f'   原文件未被修改: {in_abs}  ({os.path.getsize(in_abs):,} bytes)')


if __name__ == '__main__':
    main()
