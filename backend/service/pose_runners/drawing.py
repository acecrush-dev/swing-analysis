"""Drawing helpers — bbox rectangles + skeleton overlays.

No model code lives here. Just cv2 calls + colour tables.
Importable independently of the runners — useful for tests and ad-hoc
visualisation.
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Sequence, Tuple

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


# ── Annotation colour defaults ─────────────────────────────────────────
# These are the per-element colours used by the clip annotator when
# `clip_bbox` / `clip_skel` flags are on. The defaults match what the
# user expects out-of-the-box (pink bbox, red/yellow/green pose sides).
# They can be overridden via JobParams (hex strings "rrggbb") and the
# Settings panel in the GUI persists those overrides.

DEFAULT_COLOR_BBOX        = (180, 0, 255)   # hot pink  (RGB #ff69b4)
DEFAULT_COLOR_POSE_LEFT   = (0, 0, 255)     # red       (RGB #ff0000)
DEFAULT_COLOR_POSE_RIGHT  = (0, 255, 255)   # yellow    (RGB #ffff00)
DEFAULT_COLOR_POSE_BODY   = (0, 255, 0)     # green     (RGB #00ff00)

# Keypoint → side mapping. We pick keypoints by their index in the
# normalised keypoint vector the runners emit. LEFT gets `pose_left`,
# RIGHT gets `pose_right`, anything else (head + trunk) gets `pose_body`.
#
# The BODY set is "head + trunk": nose / eyes / ears / mouth / shoulders /
# hips — exactly what the GUI Settings panel documents for «pose — body».
# So torso POINTS render green by default, and (via the connection rule
# in draw_skeleton_mp33) the four trunk lines + nose lines do too. Only
# the limbs (arms below the shoulder, legs below the hip) carry the
# red/yellow side colours.
#
# MediaPipe-33 landmark indices (subject-relative):
#   0: nose (centre)
#   1, 2, 3: left eye inner / centre / outer
#   4, 5, 6: right eye inner / centre / outer
#   7: left ear, 8: right ear
#   9: mouth-left, 10: mouth-right
#   11/12: left/right shoulder
#   13/14: left/right elbow
#   15/16: left/right wrist
#   17/18: left/right pinky
#   19/20: left/right index
#   21/22: left/right thumb
#   23/24: left/right hip
#   25/26: left/right knee
#   27/28: left/right ankle
#   29/30: left/right heel
#   31/32: left/right foot index
LEFT_IDS_MP33:  Tuple[int, ...] = (13, 15, 17, 19, 21, 25, 27, 29, 31)
RIGHT_IDS_MP33: Tuple[int, ...] = (14, 16, 18, 20, 22, 26, 28, 30, 32)
CENTER_IDS_MP33: Tuple[int, ...] = (
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,  # head: nose / eyes / ears / mouth
    11, 12, 23, 24,                    # trunk: shoulders + hips
)

# COCO-13 (RTMPose output) landmark indices:
#   0: nose
#   1/2: left/right shoulder
#   3/4: left/right elbow
#   5/6: left/right wrist
#   7/8: left/right hip
#   9/10: left/right knee
#   11/12: left/right ankle
LEFT_IDS_COCO13:  Tuple[int, ...] = (3, 5, 9, 11)
RIGHT_IDS_COCO13: Tuple[int, ...] = (4, 6, 10, 12)
CENTER_IDS_COCO13: Tuple[int, ...] = (0, 1, 2, 7, 8)  # nose + shoulders + hips


def _side_color_map_mp33(left_bgr, right_bgr, body_bgr) -> Dict[int, Tuple[int, int, int]]:
    """Build a per-keypoint → BGR colour table for MediaPipe-33."""
    out: Dict[int, Tuple[int, int, int]] = {}
    for i in LEFT_IDS_MP33:   out[i] = left_bgr
    for i in RIGHT_IDS_MP33:  out[i] = right_bgr
    for i in CENTER_IDS_MP33: out[i] = body_bgr
    return out


def _side_color_map_coco13(left_bgr, right_bgr, body_bgr) -> Dict[int, Tuple[int, int, int]]:
    """Build a per-keypoint → BGR colour table for COCO-13."""
    out: Dict[int, Tuple[int, int, int]] = {}
    for i in LEFT_IDS_COCO13:   out[i] = left_bgr
    for i in RIGHT_IDS_COCO13:  out[i] = right_bgr
    for i in CENTER_IDS_COCO13: out[i] = body_bgr
    return out


def hex_to_bgr(color: str) -> Tuple[int, int, int]:
    """Parse a "#rrggbb" or "rrggbb" string into a BGR tuple."""
    s = color.strip()
    if s.startswith("#"):
        s = s[1:]
    if len(s) != 6:
        raise ValueError(f"color must be 6-hex-digit string, got {color!r}")
    r = int(s[0:2], 16)
    g = int(s[2:4], 16)
    b = int(s[4:6], 16)
    return (b, g, r)


def draw_bboxes(
    frame: np.ndarray,
    bboxes: Iterable[BBox],
    *,
    color: Tuple[int, int, int] = DEFAULT_COLOR_BBOX,
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
    side_colors: Dict[int, Tuple[int, int, int]] | None = None,
) -> np.ndarray:
    """Draw a MediaPipe-33 (or any matching) skeleton.

    `kps` is in *normalized [0,1]* coords — the function multiplies by
    `frame.shape[:2]`.

    If `side_colors` is supplied (keypoint-index → BGR), it overrides
    `kp_color` / `conn_color` per keypoint: each keypoint circle uses
    its side colour, and each connection is coloured by the rule below.
    This is what the Settings panel drives.
    """
    h, w = frame.shape[:2]
    pts: List[Tuple[int, int, float, int]] = [
        (int(kp[0] * w), int(kp[1] * h), kp[2], idx) for idx, kp in enumerate(kps)
    ]
    # Pre-compute each keypoint's side membership. The connection colour
    # rule keeps limbs on their side colour while the whole trunk renders
    # `pose_body` (green by default) — matching the Settings panel copy:
    #   - both endpoints same side (L+L / R+R)        → that side's colour
    #     (elbow→wrist, knee→ankle, …)
    #   - centre + side (shoulder→elbow, hip→knee, …) → the side's colour
    #     (the limb takes its colour from the joint it hangs off)
    #   - centre + centre, or left + right (shoulder bar 11-12, hip bar
    #     23-24, torso side lines, nose→shoulder)     → body colour
    side_of: Dict[int, str] = {}
    if side_colors is not None:
        for k in side_colors:
            if k in LEFT_IDS_MP33:
                side_of[k] = 'L'
            elif k in RIGHT_IDS_MP33:
                side_of[k] = 'R'
            else:
                side_of[k] = 'C'
        # Shared body colour. Both ID sets always map keypoint 0 (nose)
        # to the body side, so it carries `pose_body`.
        body_color = side_colors.get(0, kp_color)

        # The connection colour resolver.
        def _conn_color(i: int, j: int):
            si, sj = side_of.get(i, 'C'), side_of.get(j, 'C')
            if si == sj:
                return side_colors[i] if si != 'C' else body_color
            if si == 'C':
                return side_colors[j]
            if sj == 'C':
                return side_colors[i]
            return body_color  # L+R trunk bridge (shoulder bar / hip bar)
    # connections
    for i, j in skeleton:
        if i >= len(pts) or j >= len(pts):
            continue
        xi, yi, ci, _ = pts[i]
        xj, yj, cj, _ = pts[j]
        if ci < conf_thresh or cj < conf_thresh:
            continue
        color = _conn_color(i, j) if side_colors is not None else conn_color
        cv2.line(frame, (xi, yi), (xj, yj), color, conn_thick, cv2.LINE_AA)
    # keypoint circles
    for x, y, c, idx in pts:
        if c < conf_thresh:
            continue
        color = side_colors.get(idx, kp_color) if side_colors else kp_color
        cv2.circle(frame, (x, y), kp_radius, color, -1, cv2.LINE_AA)
        cv2.circle(frame, (x, y), kp_radius, (0, 0, 0), 1, cv2.LINE_AA)
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
    side_colors: Dict[int, Tuple[int, int, int]] | None = None,
) -> np.ndarray:
    """Draw a COCO-13 skeleton using the standard RTMPose topology."""
    return draw_skeleton_mp33(
        frame, kps, COCO13_SKELETON,
        kp_color=kp_color, conn_color=conn_color,
        kp_radius=kp_radius, conn_thick=conn_thick,
        conf_thresh=conf_thresh,
        side_colors=side_colors,
    )
