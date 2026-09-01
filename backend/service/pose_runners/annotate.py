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
from typing import List, Optional

import cv2
import numpy as np

from .drawing import draw_bboxes, draw_skeleton_coco13, draw_skeleton_mp33
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
    ) -> AnnotateResult:
        """Run bbox + skeleton overlay on one clip; write to clip_out.

        Args:
          clip_in:        source mp4
          clip_out:       destination mp4 (default: `<stem>_annotated.mp4`)
          bbox:           run RTMDet per frame and draw green rectangles
          skel:           run pose estimation and draw skeleton
          skel_backend:   "rtmpose" → uses RtmposeRunner (COCO-13)
                          "mediapipe" → uses MediaPipePoseRunner (33-pt, full-frame)

        Returns AnnotateResult with `frames_processed` and `output_path`.
        """
        if clip_out is None:
            clip_out = clip_in.with_name(f"{clip_in.stem}_annotated.mp4")

        if not bbox and not skel:
            # Nothing to do — still copy input to output so downstream tooling
            # that expects a consistent set of files doesn't break.
            clip_out.write_bytes(clip_in.read_bytes())
            return AnnotateResult(clip_in, clip_out, 0, [])

        cap = cv2.VideoCapture(str(clip_in))
        if not cap.isOpened():
            raise RuntimeError(f"无法打开 clip: {clip_in}")
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

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
                    draw_bboxes(canvas, bboxes)

                if skel:
                    ts_ms = int((frames / fps) * 1000.0)
                    if skel_backend == "mediapipe":
                        kps = pose_runner.pose(canvas, ts_ms)
                        if kps is not None and len(kps) >= 33:
                            draw_skeleton_mp33(canvas, kps, _MP_33_SKELETON)
                    else:
                        # RTMPose: prefer using the top RTMDet bbox as ROI when
                        # bbox is also enabled — cheaper + more accurate.
                        roi_box = bboxes[0] if (bbox and bboxes) else None
                        kps = pose_runner.pose(canvas, roi_box)
                        if kps is not None and len(kps) >= 13:
                            draw_skeleton_coco13(canvas, kps)

                writer.write(canvas)
                frames += 1
        finally:
            cap.release()
            writer.release()
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
) -> AnnotateResult:
    """Functional entry point — convenient for one-shot calls."""
    ann = annotator or ClipAnnotator()
    return ann.annotate_clip(clip_in, out_path, bbox=bbox, skel=skel, skel_backend=skel_backend)