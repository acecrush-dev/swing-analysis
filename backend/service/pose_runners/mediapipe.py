"""MediaPipe Tasks PoseLandmarker — 33-keypoint full-frame estimator.

Vendored from backend.core.segment_swing.PoseRunner (originally MediaPipe
example code). We re-implement here so the pipeline can pick a pose backend
(MediaPipe vs RTMPose) without importing `core` for PoseRunner — `core` is
still used for the segmentation algorithm itself, just not for the runner.
"""
from __future__ import annotations

from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np


# MediaPipe Pose 33-point indices (the same as `core.segment_swing.WRIST_R`).
MP_RIGHT_WRIST_IDX: int = 16
MP_LEFT_WRIST_IDX: int = 15


class MediaPipePoseRunner:
    """MediaPipe Tasks PoseLandmarker (VIDEO mode), 33 keypoints.

    Returns [(x, y, visibility), ...] for the 33 landmarks, or None if no
    pose is detected. Coords are normalised to [0, 1].
    """

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
        """Run MediaPipe on a BGR frame at timestamp `ts_ms` (ms since stream start)."""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb)
        res = self.detector.detect_for_video(mp_img, ts_ms)
        if not res or not res.pose_landmarks:
            return None
        lms = res.pose_landmarks[0]
        return [
            (float(lm.x), float(lm.y), float(getattr(lm, "visibility", 0.0) or 0.0))
            for lm in lms
        ]