"""RTMDet — pure ONNX person detector.

Vendored from ace-crush-lab/app/scripts/gen_skeleton_anim.py.
Input: BGR frame (numpy H×W×3).
Output: List[BBox] sorted by score descending.

The runner is stateless across frames — call `detect(frame)` per frame.
The ONNX session is constructed once at __init__ (loads model into memory).
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np


PERSON_CLASS_ID: int = 0
"""COCO person class index — RTMDet trained on COCO labels this class as 0."""

# RTMDet-m default input (letterbox-resized before inference).
DET_IMG_SIZE: Tuple[int, int] = (640, 640)


@dataclass(frozen=True)
class BBox:
    """Axis-aligned bounding box in *original frame* pixel coordinates."""
    x1: int
    y1: int
    x2: int
    y2: int
    score: float

    @property
    def w(self) -> int: return self.x2 - self.x1
    @property
    def h(self) -> int: return self.y2 - self.y1
    @property
    def cx(self) -> float: return (self.x1 + self.x2) / 2.0
    @property
    def cy(self) -> float: return (self.y1 + self.y2) / 2.0


def _make_onnx_session(model_path: Path, *, prefer_coreml: bool = False):
    """Build an ONNX Runtime session.

    Args:
      prefer_coreml: if True, prefer CoreML EP (good for fixed-shape models
                     like RTMPose); CPU fallback otherwise. Default False
                     because RTMDet's dynamic output shapes break CoreML.
    """
    import onnxruntime as ort
    if not model_path.exists():
        raise FileNotFoundError(f"ONNX 模型不存在: {model_path}")
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)
    available = set(ort.get_available_providers())
    preferred: List[str] = []
    if prefer_coreml:
        if "CoreMLExecutionProvider" in available: preferred.append("CoreMLExecutionProvider")
        if "CUDAExecutionProvider" in available:  preferred.append("CUDAExecutionProvider")
    preferred.append("CPUExecutionProvider")
    providers = [p for p in preferred if p in available]
    print(f"    ONNX [{model_path.name}]: providers={providers} threads={so.intra_op_num_threads}", flush=True)
    return ort.InferenceSession(str(model_path), sess_options=so, providers=providers)


def _letterbox_resize(frame: np.ndarray, target: Tuple[int, int]) -> Tuple[np.ndarray, float, Tuple[int, int]]:
    """Resize frame to `target` (W, H) keeping aspect ratio with grey padding.

    Returns (resized, scale, (dw, dh)) — caller uses scale/dw/dh to map
    network outputs back to original coordinates.
    """
    h0, w0 = frame.shape[:2]
    tw, th = target
    scale = min(tw / w0, th / h0)
    new_w, new_h = int(round(w0 * scale)), int(round(h0 * scale))
    resized = cv2.resize(frame, (new_w, new_h))
    canvas = np.full((th, tw, 3), 114, dtype=frame.dtype)
    dw, dh = (tw - new_w) // 2, (th - new_h) // 2
    canvas[dh:dh + new_h, dw:dw + new_w] = resized
    return canvas, scale, (dw, dh)


class RtmdetRunner:
    """RTMDet person detector. Vendor-style: stateless `detect(frame)` interface."""

    def __init__(self, model_path: Path, score_thresh: float = 0.4):
        # RTMDet has dynamic output shapes that crash CoreML EP — force CPU.
        self.session = _make_onnx_session(model_path, prefer_coreml=False)
        self.input_name = self.session.get_inputs()[0].name
        _, _, in_h, in_w = self.session.get_inputs()[0].shape
        self.input_size: Tuple[int, int] = (in_w, in_h)
        self.score_thresh = score_thresh

    def detect(self, frame: np.ndarray) -> List[BBox]:
        """Run RTMDet on a single BGR frame; return sorted-by-score BBox list."""
        if frame is None or frame.size == 0:
            return []
        resized, scale, (dw, dh) = _letterbox_resize(frame, self.input_size)
        img = resized.astype(np.float32) / 255.0
        img = img.transpose(2, 0, 1)[None, ...]
        outputs = self.session.run(None, {self.input_name: img})
        boxes_raw = np.asarray(outputs[0])[0]
        labels = np.asarray(outputs[1])[0].astype(int)
        h0, w0 = frame.shape[:2]
        out: List[BBox] = []
        for det, cls in zip(boxes_raw, labels):
            if cls != PERSON_CLASS_ID:
                continue
            x1, y1, x2, y2, score = det.tolist()
            if float(score) < self.score_thresh:
                continue
            x1 = max(0, min(w0 - 1, int((x1 - dw) / scale)))
            y1 = max(0, min(h0 - 1, int((y1 - dh) / scale)))
            x2 = max(0, min(w0 - 1, int((x2 - dw) / scale)))
            y2 = max(0, min(h0 - 1, int((y2 - dh) / scale)))
            if x2 <= x1 or y2 <= y1:
                continue
            out.append(BBox(x1, y1, x2, y2, float(score)))
        return sorted(out, key=lambda b: b.score, reverse=True)