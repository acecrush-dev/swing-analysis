"""Drawing helpers — bbox rectangles + skeleton overlays.

No model code lives here. Just cv2 calls + colour tables.
Importable independently of the runners — useful for tests and ad-hoc
visualisation.
"""
from __future__ import annotations

from typing import Iterable, List, Sequence, Tuple

import cv2
import numpy as np

from .rtmdet import BBox
from .rtmpose import COCO13_SKELETON


# Phase colour table (BGR) — used by the viz pipeline (Pass 2 in core.render_outputs).
PHASE_COLORS = {
    "ready":          (255, 220, 120),  # light blue
    "windup":         (80, 200, 255),   # orange-yellow
    "contact":        (0, 0, 255),      # red
    "follow_through": (0, 255, 120),    # green
}


def draw_bboxes(
    frame: np.ndarray,
    bboxes: Iterable[BBox],
    *,
    color: Tuple[int, int, int] = (0, 255, 0),
    thickness: int = 2,
    label: bool = True,
) -> np.ndarray:
    """Draw axis-aligned bbox rectangles onto `frame` (mutates + returns)."""
    for b in bboxes:
        cv2.rectangle(frame, (b.x1, b.y1), (b.x2, b.y2), color, thickness)
        if label:
            cv2.putText(
                frame,
                f"person {b.score:.2f}",
                (b.x1, max(0, b.y1 - 6)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA,
            )
    return frame


def draw_skeleton_mp33(
    frame: np.ndarray,
    kps: Sequence[Tuple[float, float, float]],
    skeleton: Sequence[Tuple[int, int]],
    *,
    kp_color: Tuple[int, int, int] = (0, 255, 255),
    conn_color: Tuple[int, int, int] = (180, 180, 0),
    kp_radius: int = 4,
    conn_thick: int = 2,
    conf_thresh: float = 0.3,
) -> np.ndarray:
    """Draw a MediaPipe-33 (or any matching) skeleton.

    `kps` is in *normalized [0,1]* coords — the function multiplies by
    `frame.shape[:2]`.
    """
    h, w = frame.shape[:2]
    pts: List[Tuple[int, int, float]] = [
        (int(kp[0] * w), int(kp[1] * h), kp[2]) for kp in kps
    ]
    for i, j in skeleton:
        if i >= len(pts) or j >= len(pts):
            continue
        xi, yi, ci = pts[i]
        xj, yj, cj = pts[j]
        if ci < conf_thresh or cj < conf_thresh:
            continue
        cv2.line(frame, (xi, yi), (xj, yj), conn_color, conn_thick, cv2.LINE_AA)
    for x, y, c in pts:
        if c < conf_thresh:
            continue
        cv2.circle(frame, (x, y), kp_radius, kp_color, -1, cv2.LINE_AA)
    return frame


def draw_skeleton_coco13(
    frame: np.ndarray,
    kps: Sequence[Tuple[float, float, float]],
    *,
    kp_color: Tuple[int, int, int] = (0, 255, 255),
    conn_color: Tuple[int, int, int] = (180, 180, 0),
    kp_radius: int = 4,
    conn_thick: int = 2,
    conf_thresh: float = 0.3,
) -> np.ndarray:
    """Draw a COCO-13 skeleton using the standard RTMPose topology."""
    return draw_skeleton_mp33(
        frame, kps, COCO13_SKELETON,
        kp_color=kp_color, conn_color=conn_color,
        kp_radius=kp_radius, conn_thick=conn_thick,
        conf_thresh=conf_thresh,
    )