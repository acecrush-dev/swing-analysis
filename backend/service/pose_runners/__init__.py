"""Pose / detection runners — each module does ONE thing.

Modules:
  rtmdet      ONNX RTMDet  → List[BBox] per frame (person detection)
  rtmpose     ONNX RTMPose → 13 keypoints per ROI or full frame (COCO-13)
  mediapipe   MediaPipe .task PoseLandmarker → 33 keypoints full-frame
  drawing     draw_bboxes / draw_skeleton / colour palettes (no model code)
  annotate    run detection + pose on an existing clip mp4, overlay, write out

Design rule: each module is independent and composable. The pipeline layer
(`backend/service/pipeline.py`) chooses which ones to chain based on user
flags — but each module can also be invoked standalone (e.g. by the
`annotate` CLI sub-command for post-hoc clip enrichment).
"""
from .rtmdet import RtmdetRunner, BBox, PERSON_CLASS_ID
from .rtmpose import RtmposeRunner, COCO13_RIGHT_WRIST_IDX, COCO13_LEFT_WRIST_IDX, COCO13_SKELETON
from .mediapipe import MediaPipePoseRunner, MP_RIGHT_WRIST_IDX, MP_LEFT_WRIST_IDX
from .drawing import draw_bboxes, draw_skeleton_mp33, draw_skeleton_coco13, PHASE_COLORS
from .annotate import ClipAnnotator, annotate_clip

__all__ = [
    "RtmdetRunner", "BBox", "PERSON_CLASS_ID",
    "RtmposeRunner", "COCO13_RIGHT_WRIST_IDX", "COCO13_LEFT_WRIST_IDX", "COCO13_SKELETON",
    "MediaPipePoseRunner", "MP_RIGHT_WRIST_IDX", "MP_LEFT_WRIST_IDX",
    "draw_bboxes", "draw_skeleton_mp33", "draw_skeleton_coco13", "PHASE_COLORS",
    "ClipAnnotator", "annotate_clip",
]