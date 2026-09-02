"""Clip annotator — overlay RTMDet bboxes + (optionally) pose skeleton onto
an existing clip mp4 and write the result alongside the original.

This module composes:
  RtmdetRunner  (person bbox per frame)        ← only if `bbox=True`
  RtmposeRunner (13-keypoint skeleton per ROI) ← only if `skel=True`
  drawing helpers

The output filename is `<stem>_annotated.mp4` next to the input. Original
file is never modified.

Pipeline integration: `service.pipeline.run_pipeline` invokes this on each
extracted clip when the corresponding flags are set.
CLI sub-command `python -m backend.cli annotate` invokes it standalone for
post-hoc enrichment.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional

import cv2
import numpy as np

from .drawing import (
    DEFAULT_COLOR_BBOX,
    DEFAULT_COLOR_POSE_BODY,
    DEFAULT_COLOR_POSE_LEFT,
    DEFAULT_COLOR_POSE_RIGHT,
    _side_color_map_coco13,
    _side_color_map_mp33,
    draw_bboxes,
    draw_skeleton_coco13,
    draw_skeleton_mp33,
    hex_to_bgr,
)
from .mediapipe import MediaPipePoseRunner
from .rtmdet import BBox, RtmdetRunner
from .rtmpose import RtmposeRunner


@dataclass
class AnnotateResult:
    clip_in: Path
    clip_out: Path
    frames_processed: int
    issues: List[str]


# ── defaults ─────────────────────────────────────────────────────────────
_DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[2] / "models"


def _default_rtmdet_path() -> Path:
    return _DEFAULT_MODELS_DIR / "rtmdet-m-487628.onnx"


def _default_rtmpose_path() -> Path:
    return _DEFAULT_MODELS_DIR / "rtmpose-m-27c0e6.onnx"


def _default_mp_task_path() -> Path:
    return _DEFAULT_MODELS_DIR / "pose_landmarker_lite.task"


# Minimal MediaPipe-33 skeleton for the annotation path. The pipeline's
# own viz.mp4 uses the full topology from core/gen_skeleton_anim.py; we
# only need a basic one here for clip overlays.
_MP_33_SKELETON = [
    # arms
    (11, 13), (13, 15), (12, 14), (14, 16),
    # torso
    (11, 12), (11, 23), (12, 24), (23, 24),
    # legs
    (23, 25), (25, 27), (24, 26), (26, 28),
    # face-ish
    (0, 11), (0, 12),
]


class ClipAnnotator:
    """Holds loaded model sessions, runs annotation on one or many clips.

    Sessions are lazy — instantiated on first use. Same instance can be
    reused across many clips (the underlying ONNX sessions are thread-safe
    for `run()` calls).
    """

    def __init__(
        self,
        rtmdet: Optional[RtmdetRunner] = None,
        rtmpose: Optional[RtmposeRunner] = None,
        mediapipe: Optional[MediaPipePoseRunner] = None,
    ):
        self._rtmdet = rtmdet
        self._rtmpose = rtmpose
        self._mediapipe = mediapipe

    def annotate_clip(
        self,
        clip_in: Path,
        clip_out: Optional[Path] = None,
        *,
        bbox: bool = True,
        skel: bool = True,
        skel_backend: str = "rtmpose",  # "rtmpose" | "mediapipe"
        progress_cb: Optional[Callable[[str, int, int], None]] = None,
        # Annotation colours — hex strings ("rrggbb" or "#rrggbb"). Falls
        # back to DEFAULT_COLOR_* if omitted or unparseable. The renderer
        # uses per-keypoint side colouring so the left arm is `pose_left`,
        # right arm is `pose_right`, and the trunk is `pose_body`.
        color_bbox: Optional[str] = None,
        color_pose_left: Optional[str] = None,
        color_pose_right: Optional[str] = None,
        color_pose_body: Optional[str] = None,
    ) -> AnnotateResult:
        """Run bbox + skeleton overlay on one clip; write to clip_out.

        Args:
          clip_in:        source mp4
          clip_out:       destination mp4 (default: `<stem>_annotated.mp4`)
          bbox:           run RTMDet per frame and draw rectangles
          skel:           run pose estimation and draw skeleton
          skel_backend:   "rtmpose" → uses RtmposeRunner (COCO-13)
                          "mediapipe" → uses MediaPipePoseRunner (33-pt, full-frame)
          progress_cb:    optional callback `progress_cb(stage, frames_processed,
                          total_frames)`. stage ∈ {"rtmdet","pose","rtmdet+pose"}.
                          total_frames == 0 means unknown. Called once with
                          (stage, 0, total) when the writer is ready, then
                          every 5 frames, and once more with the final count
                          before returning. The callback must not raise and
                          must not block — callers wrap it in try/except.
          color_bbox:     "#rrggbb" hex string for the RTMDet rectangle.
          color_pose_left/right/body: hex strings for the three skeleton
                          sides (driven by the Settings panel in the GUI).

        Returns AnnotateResult with `frames_processed` and `output_path`.
        """
        if clip_out is None:
            clip_out = clip_in.with_name(f"{clip_in.stem}_annotated.mp4")

        if not bbox and not skel:
            # Nothing to do — still copy input to output so downstream tooling
            # that expects a consistent set of files doesn't break.
            clip_out.write_bytes(clip_in.read_bytes())
            return AnnotateResult(clip_in, clip_out, 0, [])

        # plan 003 — stage describes which annotations are enabled for THIS
        # clip. rtmdet and pose run on the same frame loop in lockstep, so
        # the stage describes the combination, not separate passes.
        stage = "rtmdet+pose" if (bbox and skel) else ("rtmdet" if bbox else "pose")

        cap = cv2.VideoCapture(str(clip_in))
        if not cap.isOpened():
            raise RuntimeError(f"无法打开 clip: {clip_in}")
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total_frames < 0:
            total_frames = 0

        # Lazy-load models on first use.
        if bbox and self._rtmdet is None:
            self._rtmdet = RtmdetRunner(_default_rtmdet_path())
        if skel:
            if skel_backend == "mediapipe":
                if self._mediapipe is None:
                    self._mediapipe = MediaPipePoseRunner(_default_mp_task_path())
                pose_runner: object = self._mediapipe
            else:
                if self._rtmpose is None:
                    self._rtmpose = RtmposeRunner(_default_rtmpose_path())
                pose_runner = self._rtmpose

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(str(clip_out), fourcc, fps, (w, h))
        if not writer.isOpened():
            cap.release()
            raise RuntimeError(f"无法写 {clip_out}")

        if progress_cb is not None:
            try:
                progress_cb(stage, 0, total_frames)
            except Exception:  # noqa: BLE001
                pass

        # Resolve the four user-configurable colours. We accept either a
        # hex string ("rrggbb" / "#rrggbb") or `None` (use the module
        # default). Anything unparseable degrades gracefully — better
        # to draw the wrong colour than to abort the whole job.
        def _hex_or_default(val, default):
            if not val:
                return default
            try:
                return hex_to_bgr(val)
            except (ValueError, TypeError):
                return default

        bbox_bgr = _hex_or_default(color_bbox, DEFAULT_COLOR_BBOX)
        left_bgr = _hex_or_default(color_pose_left,  DEFAULT_COLOR_POSE_LEFT)
        right_bgr = _hex_or_default(color_pose_right, DEFAULT_COLOR_POSE_RIGHT)
        body_bgr  = _hex_or_default(color_pose_body,  DEFAULT_COLOR_POSE_BODY)
        side_colors_mp33  = _side_color_map_mp33(left_bgr, right_bgr, body_bgr)
        side_colors_coco  = _side_color_map_coco13(left_bgr, right_bgr, body_bgr)

        frames = 0
        issues: List[str] = []
        rtmdet = self._rtmdet
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                canvas = frame

                bboxes: List[BBox] = []
                if bbox:
                    bboxes = rtmdet.detect(canvas)
                    draw_bboxes(canvas, bboxes, color=bbox_bgr)

                if skel:
                    ts_ms = int((frames / fps) * 1000.0)
                    if skel_backend == "mediapipe":
                        kps = pose_runner.pose(canvas, ts_ms)
                        if kps is not None and len(kps) >= 33:
                            draw_skeleton_mp33(
                                canvas, kps, _MP_33_SKELETON,
                                side_colors=side_colors_mp33,
                            )
                    else:
                        # RTMPose: prefer using the top RTMDet bbox as ROI when
                        # bbox is also enabled — cheaper + more accurate.
                        roi_box = bboxes[0] if (bbox and bboxes) else None
                        kps = pose_runner.pose(canvas, roi_box)
                        if kps is not None and len(kps) >= 13:
                            draw_skeleton_coco13(
                                canvas, kps,
                                side_colors=side_colors_coco,
                            )

                writer.write(canvas)
                frames += 1
                if progress_cb is not None and (frames % 5 == 0):
                    try:
                        progress_cb(stage, frames, total_frames)
                    except Exception:  # noqa: BLE001
                        pass
        finally:
            cap.release()
            writer.release()
        if progress_cb is not None:
            try:
                progress_cb(stage, frames, total_frames)
            except Exception:  # noqa: BLE001
                pass
        return AnnotateResult(clip_in, clip_out, frames, issues)


# ── public functional entry point ────────────────────────────────────────
def annotate_clip(
    clip_in: Path,
    *,
    bbox: bool = True,
    skel: bool = True,
    skel_backend: str = "rtmpose",
    out_path: Optional[Path] = None,
    annotator: Optional[ClipAnnotator] = None,
    progress_cb: Optional[Callable[[str, int, int], None]] = None,
) -> AnnotateResult:
    """Functional entry point — convenient for one-shot calls."""
    ann = annotator or ClipAnnotator()
    return ann.annotate_clip(
        clip_in, out_path, bbox=bbox, skel=skel, skel_backend=skel_backend,
        progress_cb=progress_cb,
    )