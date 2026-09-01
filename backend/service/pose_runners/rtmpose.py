"""RTMPose — pure ONNX pose estimator (COCO-17 → COCO-13 mapping).

The COCO-17 → COCO-13 projection lives in `backend/core/gen_skeleton_anim.py`
(SimCC decoding + topology); this module is the ONNX-runtime binding that
turns it into a callable runner.

Input: BGR frame + optional BBox ROI.
Output: 13 keypoints in normalized [0,1] image coordinates (or None).

Right-wrist index in COCO-13 is 6; left-wrist is 5. See COCO13_SKELETON
for the connection topology used by draw_skeleton_coco13().
"""
from __future__ import annotations

import math
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np

from .rtmdet import BBox, _make_onnx_session


# RTMPose-m SimCC input shape.
POSE_IMG_SIZE: Tuple[int, int] = (192, 256)
SIMCC_SPLIT_RATIO: float = 2.0

# COCO-17 → COCO-13 mapping (the 17 keypoints not in 13 are dropped).
COCO17_TO_13 = {
    0: 0, 5: 1, 6: 2, 7: 3, 8: 4, 9: 5, 10: 6,
    11: 7, 12: 8, 13: 9, 14: 10, 15: 11, 16: 12,
}

# COCO-13 skeleton (parent_idx, child_idx) — used by draw_skeleton_coco13().
COCO13_SKELETON: List[Tuple[int, int]] = [
    (0, 1), (0, 2), (1, 2),
    (1, 3), (3, 5), (2, 4), (4, 6),
    (1, 7), (2, 8), (7, 8),
    (7, 9), (9, 11), (8, 10), (10, 12),
]

# Right/left wrist indices inside COCO-13 (for the swing-segmentation signal).
COCO13_RIGHT_WRIST_IDX: int = 6
COCO13_LEFT_WRIST_IDX: int = 5


class RtmposeRunner:
    """RTMPose COCO-13 estimator. Stateless across frames; session built once."""

    def __init__(self, model_path: Path):
        # RTMPose has fixed shapes (192×256 SimCC); CoreML works fine here.
        self.session = _make_onnx_session(model_path, prefer_coreml=True)
        self.input_name = self.session.get_inputs()[0].name

    def pose(self, frame: np.ndarray, box: Optional[BBox] = None) -> Optional[List[Tuple[float, float, float]]]:
        """Run RTMPose.

        Args:
          frame: BGR image.
          box:   if provided, ROI is `frame[box.y1:box.y2, box.x1:box.x2]`
                 and outputs are mapped back to full-image coords.
                 if None, the whole frame is fed and outputs are already in
                 image-normalized [0,1] coords.

        Returns: list of (x, y, conf) for the 13 keypoints (full-image
        normalized coords), or None if the ROI is empty.
        """
        if frame is None or frame.size == 0:
            return None
        if box is None:
            roi = frame
        else:
            roi = frame[box.y1:box.y2, box.x1:box.x2]
        if roi.size == 0:
            return None

        w, h = POSE_IMG_SIZE
        resized = cv2.resize(roi, (w, h))
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        inp = np.transpose(rgb, (2, 0, 1))[None, ...]
        outputs = self.session.run(None, {self.input_name: inp})
        o0, o1 = outputs[0], outputs[1]
        if o0.shape[-1] < o1.shape[-1]:
            simcc_x, simcc_y = o0, o1
        else:
            simcc_x, simcc_y = o1, o0
        kps13_norm = self._decode_simcc(simcc_x, simcc_y)

        h0, w0 = frame.shape[:2]
        if box is None:
            return [(nx, ny, conf) for (nx, ny, conf) in kps13_norm]
        bw, bh = box.w, box.h
        return [
            ((box.x1 + nx * bw) / w0, (box.y1 + ny * bh) / h0, conf)
            for (nx, ny, conf) in kps13_norm
        ]

    @staticmethod
    def _decode_simcc(simcc_x, simcc_y) -> List[Tuple[float, float, float]]:
        simcc_x = simcc_x[0]
        simcc_y = simcc_y[0]
        H, W = POSE_IMG_SIZE[1], POSE_IMG_SIZE[0]

        def soft(x):
            x = x.astype(np.float32)
            m = float(np.max(x))
            return np.exp(x - m) / (float(np.sum(np.exp(x - m))) + 1e-8)

        def soft_argmax(prob, peak, radius=2):
            n = prob.shape[0]
            l = max(0, peak - radius)
            r = min(n - 1, peak + radius)
            w = prob[l:r + 1].astype(np.float64)
            s = float(w.sum())
            if s <= 1e-12:
                return float(peak)
            idxs = np.arange(l, r + 1, dtype=np.float64)
            return float((w * idxs).sum() / s)

        def sigmoid(x):
            x = max(-20.0, min(20.0, x))
            return 1.0 / (1.0 + math.exp(-x))

        out17 = []
        for k in range(17):
            x_prob = soft(simcc_x[k])
            y_prob = soft(simcc_y[k])
            x_idx = int(np.argmax(x_prob))
            y_idx = int(np.argmax(y_prob))
            conf = (sigmoid(float(simcc_x[k][x_idx])) + sigmoid(float(simcc_y[k][y_idx]))) / 2.0
            x_bin = soft_argmax(x_prob, x_idx, radius=2)
            y_bin = soft_argmax(y_prob, y_idx, radius=2)
            out17.append((
                float((x_bin / SIMCC_SPLIT_RATIO) / W),
                float((y_bin / SIMCC_SPLIT_RATIO) / H),
                float(conf),
            ))

        out13 = [(0.0, 0.0, 0.0)] * 13
        for i17, i13 in COCO17_TO_13.items():
            out13[i13] = out17[i17]
        return out13