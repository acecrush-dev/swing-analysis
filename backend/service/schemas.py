"""Pydantic schemas — wire types shared by REST API and JobManager."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class JobParams(BaseModel):
    """Tuning knobs — defaults match backend.core.segment_swing main()."""
    v_swing: float = 0.10
    gap_merge: float = 1.5
    max_bridge: float = 1.5
    min_peak: float = 0.30
    smooth_alpha: float = 0.65
    max_lost_frames: int = 8
    min_dur: float = 0.3
    max_dur: float = 6.0
    buf_before: float = 1.0
    buf_after: float = 1.0
    skip: int = 1
    max_frames: int = 0
    save_clips: bool = False
    viz_video: bool = False
    # clip annotation (optional, applied after extraction per clip)
    clip_bbox: bool = False        # RTMDet bbox overlay
    clip_skel: bool = False        # pose skeleton overlay
    skel_backend: str = "rtmpose"  # "rtmpose" | "mediapipe"


class JobCreate(BaseModel):
    video_path: str = Field(..., description="Absolute path to local video file")
    params: Optional[JobParams] = None


class JobAccepted(BaseModel):
    job_id: str


class SegmentOut(BaseModel):
    seg_id: int
    start_frame: int
    end_frame: int
    active_start_frame: int
    active_end_frame: int
    contact_frame: int
    peak_velocity: float
    duration_sec: float
    total_sec: float
    start_timecode: str
    contact_timecode: str
    end_timecode: str
    over_long: bool = False
    merged_intervals: int = 1
    peak_frame: Optional[int] = None
    peak_timecode: Optional[str] = None
    phases: List[Dict[str, Any]] = Field(default_factory=list)


class JobInfo(BaseModel):
    job_id: str
    state: str  # queued | running | done | failed | cancelled
    video_path: str
    params: JobParams
    created_at: float
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    error: Optional[str] = None
    segments: List[SegmentOut] = Field(default_factory=list)
    segments_payload: Optional[Dict[str, Any]] = None  # raw segments.json contents
    queue_position: Optional[int] = None


class ProgressEvent(BaseModel):
    """WebSocket event payload."""
    type: str  # job.started | pose.progress | segment.emitted | job.completed | job.failed | job.cancelled
    job_id: str
    data: Dict[str, Any] = Field(default_factory=dict)


class ClipInfo(BaseModel):
    """Per-clip artifact manifest (plan 002)."""
    seg_id: int
    exists: bool          # clip_NNN.mp4 (mp4v canonical) present
    size_bytes: int
    playable: bool        # clip_NNN_h264.mp4 present → Chromium 内嵌可播
    annotated: bool       # clip_NNN_annotated.mp4 present
    thumb_ready: bool     # clip_NNN.thumb.jpg 已生成


class ClipCleanupResult(BaseModel):
    deleted_count: int
    freed_bytes: int