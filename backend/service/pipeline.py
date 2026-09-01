"""Shared run-pipeline — invoked by CLI and REST/WS alike.

Replicates the algorithm control-flow from `core.segment_swing.main()`,
substituting:
  - a `progress_cb` callback for the stdout `ProgressBar`
  - an `on_segment` callback for the in-line `print` of each emitted segment
  - a deterministic `out_dir` parameter (CLI passes one, REST uses job-scoped dir)
  - optional clip annotation step (RTMDet bbox + RTMPose/MediaPipe skeleton)

`backend.core.segment_swing` is **not** modified. We only import its public
helpers. If upstream changes, re-copy the file and re-run tests.

The pipeline composes (per user flags):
  core.segment_swing  → segmentation (wrist signal + cycles)
  pose_runners.annotate → optional per-clip bbox + skeleton overlay
Each step is independent; the pipeline is a thin orchestrator.
"""
from __future__ import annotations

import json
import math
import shutil
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from typing import Callable, Dict, List, Optional

import cv2

from ..core import segment_swing as core
from .pose_runners.annotate import ClipAnnotator


# ── types ────────────────────────────────────────────────────────────────
ProgressCb = Callable[[Dict], None]
SegmentCb = Callable[[Dict], None]
ClipAnnotatedCb = Callable[[Dict], None]


class JobCancelled(Exception):
    """Raised inside the pipeline loop to abort cleanly on cancellation."""


# ── defaults ─────────────────────────────────────────────────────────────
DEFAULT_PARAMS: Dict = {
    "v_swing": 0.10,
    "gap_merge": 1.5,
    "max_bridge": 1.5,
    "min_peak": 0.30,
    "smooth_alpha": 0.65,
    "max_lost_frames": 8,
    "min_dur": 0.3,
    "max_dur": 6.0,
    "buf_before": 1.0,
    "buf_after": 1.0,
    "skip": 1,
    "max_frames": 0,
    "save_clips": False,
    "viz_video": False,
    # clip annotation (optional, applied after extraction per clip)
    "clip_bbox": False,        # RTMDet bbox overlay
    "clip_skel": False,        # pose skeleton overlay
    "skel_backend": "rtmpose", # "rtmpose" | "mediapipe"
}


# ── main entry ───────────────────────────────────────────────────────────
def run_pipeline(
    video_path: Path,
    task_path: Path,
    out_dir: Path,
    params: Optional[Dict] = None,
    progress_cb: Optional[ProgressCb] = None,
    on_segment: Optional[SegmentCb] = None,
    on_clip_annotated: Optional[ClipAnnotatedCb] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict:
    """Run Pass 1 + Pass 1.5 + (optional) Pass 2 + (optional) clip annotation.

    Returns the segments.json payload as a dict. Raises JobCancelled if
    should_cancel() ever returns True mid-run.
    """
    p = {**DEFAULT_PARAMS, **(params or {})}

    # ── prep output ──
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── open video ──
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频 {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if total <= 0:
        # prescan
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        scanned = 0
        while True:
            ok, _ = cap.read()
            if not ok:
                break
            scanned += 1
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        total = scanned

    limit = total if p["max_frames"] <= 0 else min(total, p["max_frames"])

    # ── Pass 1 ──
    pose = core.PoseRunner(task_path)

    xs: List[Optional[float]] = [None] * limit
    ys: List[Optional[float]] = [None] * limit
    n_valid = 0
    frame_idx = 0
    t0 = time.time()
    sa = float(p["smooth_alpha"])

    online_seg = core.OnlineSegmenter(
        fps,
        v_swing=p["v_swing"],
        gap_merge_sec=p["gap_merge"],
        min_peak=p["min_peak"],
        min_dur=p["min_dur"],
        buf_before=p["buf_before"],
        buf_after=p["buf_after"],
    )
    sx: Optional[float] = None
    sy: Optional[float] = None
    px: Optional[float] = None
    py: Optional[float] = None

    clip_executor: Optional[ThreadPoolExecutor] = None
    if p["save_clips"]:
        clip_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="clip")

    # Clip annotator — lazy-loaded only when clip_bbox or clip_skel is on.
    # Shared across all clip extraction tasks to avoid reloading ONNX
    # sessions (100+ MB) for every clip.
    annotator: Optional[ClipAnnotator] = None
    if p["save_clips"] and (p["clip_bbox"] or p["clip_skel"]):
        annotator = ClipAnnotator()

    online_segments: List[core.SwingSegment] = []

    try:
        try:
            skip = max(1, int(p["skip"]))
            while frame_idx < limit:
                if should_cancel and should_cancel():
                    raise JobCancelled("cancelled by user")
                ok, frame = cap.read()
                if not ok:
                    break
                fidx = frame_idx
                frame_idx += 1

                if (fidx % skip) == 0:
                    det = pose.detect(frame, int(((fidx + 1) / fps) * 1000.0))
                    if det is not None:
                        xs[fidx], ys[fidx] = det[0], det[1]
                        n_valid += 1
                        if sx is None:
                            sx, sy = det[0], det[1]
                        else:
                            sx = sa * det[0] + (1 - sa) * sx
                            sy = sa * det[1] + (1 - sa) * sy
                    else:
                        sx, sy = None, None
                else:
                    sx, sy = None, None

                if sx is not None and sy is not None and px is not None and py is not None:
                    v_now: Optional[float] = math.hypot(sx - px, sy - py) * fps
                else:
                    v_now = None
                px, py = sx, sy

                seg = online_seg.update(fidx, v_now)
                if seg is not None:
                    online_segments.append(seg)
                    if on_segment is not None:
                        on_segment(_seg_to_dict(seg))
                    if clip_executor is not None:
                        clips_dir = out_dir / "clips"
                        clips_dir.mkdir(parents=True, exist_ok=True)
                        clip_path = clips_dir / f"clip_{seg.seg_id:03d}.mp4"
                        clip_executor.submit(
                            _extract_and_maybe_annotate,
                            video_path, seg, clips_dir, fps, width, height,
                            annotator, p["clip_bbox"], p["clip_skel"], p["skel_backend"],
                            on_clip_annotated,
                        )

                if progress_cb is not None:
                    elapsed = max(time.time() - t0, 1e-6)
                    fps_now = frame_idx / elapsed
                    remaining = (limit - frame_idx) / max(fps_now, 1e-6)
                    if not (remaining == remaining) or remaining == float("inf") or remaining > 86400 * 30:
                        eta_s: Optional[float] = None
                    else:
                        eta_s = max(0.0, remaining)
                    progress_cb({
                        "phase": "pose",
                        "frames": frame_idx,
                        "total": limit,
                        "fps": fps_now,
                        "eta_sec": eta_s,
                        "segments_emitted": len(online_segments),
                    })
        finally:
            cap.release()

        # flush -- runs after the loop, before the executor shuts down.
        try:
            seg = online_seg.flush(frame_idx)
            if seg is not None:
                online_segments.append(seg)
                if on_segment is not None:
                    on_segment(_seg_to_dict(seg))
                if clip_executor is not None:
                    clips_dir = out_dir / "clips"
                    clips_dir.mkdir(parents=True, exist_ok=True)
                    clip_path = clips_dir / f"clip_{seg.seg_id:03d}.mp4"
                    clip_executor.submit(
                        _extract_and_maybe_annotate,
                        video_path, seg, clips_dir, fps, width, height,
                        annotator, p["clip_bbox"], p["clip_skel"], p["skel_backend"],
                        on_clip_annotated,
                    )
        finally:
            # Shutdown the executor LAST (and only once). It MUST be after
            # flush() so a segment emitted by flush() can still submit.
            if clip_executor is not None:
                clip_executor.shutdown(wait=True)
    finally:
        # Outer safety net: if the loop itself raised (e.g. JobCancelled
        # from should_cancel()) and we skipped flush() entirely, still
        # shut down the executor so it doesn't leak threads. The inner
        # flush-finally above already shut it down on the happy path;
        # shutdown() is idempotent so a second call is a no-op.
        if clip_executor is not None:
            clip_executor.shutdown(wait=True)


    detected_pct = 100.0 * n_valid / max(frame_idx, 1)

    # ── Pass 1.5 ──
    valid = [x is not None for x in xs]
    xb = core.bridge_gaps(xs, valid, max_lost=p["max_lost_frames"])
    yb = core.bridge_gaps(ys, valid, max_lost=p["max_lost_frames"])
    xs_s = core.ema_smooth(xb, alpha=p["smooth_alpha"])
    ys_s = core.ema_smooth(yb, alpha=p["smooth_alpha"])
    v = core.compute_velocity_2d(xs_s, ys_s, fps=fps)

    segments = core.segment_cycles(
        v, fps,
        v_swing=p["v_swing"],
        gap_merge_sec=p["gap_merge"],
        max_bridge_sec=p["max_bridge"],
        min_peak=p["min_peak"],
        min_dur=p["min_dur"],
        max_dur=p["max_dur"],
        buf_before=p["buf_before"],
        buf_after=p["buf_after"],
    )

    # ── segments.json ──
    segs_data = []
    for s in segments:
        d = asdict(s)
        d["peak_frame"] = s.peak_frame
        d["peak_timecode"] = s.peak_timecode
        d["phases"] = [
            {"phase": name, "start_frame": ps, "end_frame": pe}
            for (name, ps, pe) in core.phase_timeline(s, fps)
        ]
        segs_data.append(d)

    payload = {
        "input": str(video_path),
        "fps": fps,
        "total_frames": total,
        "processed_frames": frame_idx,
        "duration_sec": total / fps,
        "wrist_detected_pct": round(detected_pct, 1),
        "params": {
            "v_swing": p["v_swing"],
            "gap_merge_sec": p["gap_merge"],
            "max_bridge_sec": p["max_bridge"],
            "min_peak": p["min_peak"],
            "min_dur": p["min_dur"],
            "max_dur": p["max_dur"],
            "buf_before": p["buf_before"],
            "buf_after": p["buf_after"],
            "smooth_alpha": p["smooth_alpha"],
            "max_lost_frames": p["max_lost_frames"],
            "skip": max(1, int(p["skip"])),
        },
        "segments": segs_data,
        "segment_count": len(segs_data),
    }

    json_path = out_dir / "segments.json"
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    if progress_cb is not None:
        progress_cb({
            "phase": "done",
            "frames": frame_idx,
            "total": limit,
            "fps": frame_idx / max(time.time() - t0, 1e-6),
            "eta_sec": 0.0,
            "segments_emitted": len(online_segments),
            "segments_final": len(segs_data),
        })

    # ── Pass 2 (optional) ──
    if p["viz_video"] or p["save_clips"]:
        core.render_outputs(
            video_path, segments, ys, out_dir, fps, width, height,
            render_frames=frame_idx, make_viz=p["viz_video"],
            save_clips=p["save_clips"],
        )

    return payload


def _seg_to_dict(seg: core.SwingSegment) -> Dict:
    return {
        "seg_id": seg.seg_id,
        "start_frame": seg.start_frame,
        "end_frame": seg.end_frame,
        "active_start_frame": seg.active_start_frame,
        "active_end_frame": seg.active_end_frame,
        "contact_frame": seg.contact_frame,
        "peak_velocity": seg.peak_velocity,
        "duration_sec": seg.duration_sec,
        "total_sec": seg.total_sec,
        "start_timecode": seg.start_timecode,
        "contact_timecode": seg.contact_timecode,
        "end_timecode": seg.end_timecode,
        "over_long": seg.over_long,
        "merged_intervals": seg.merged_intervals,
    }


def _extract_and_maybe_annotate(
    video_path: Path,
    seg: core.SwingSegment,
    clips_dir: Path,
    fps: float,
    width: int,
    height: int,
    annotator: Optional[ClipAnnotator],
    bbox: bool,
    skel: bool,
    skel_backend: str,
    on_clip_annotated: Optional[ClipAnnotatedCb] = None,
) -> None:
    """Background task: extract one clip, then optionally annotate it.

    Extracted clip lives at `<clips_dir>/clip_NNN.mp4`.
    If annotation enabled: writes `<clips_dir>/clip_NNN_annotated.mp4` and
    notifies the caller via `on_clip_annotated`.
    """
    core.extract_one_clip(video_path, seg, clips_dir, fps, width, height)
    if annotator is not None and (bbox or skel):
        clip_in = clips_dir / f"clip_{seg.seg_id:03d}.mp4"
        if not clip_in.exists():
            return
        try:
            res = annotator.annotate_clip(clip_in, bbox=bbox, skel=skel, skel_backend=skel_backend)
            if on_clip_annotated is not None:
                on_clip_annotated({
                    "seg_id": seg.seg_id,
                    "clip_in": str(clip_in),
                    "clip_annotated": str(res.clip_out),
                    "frames": res.frames_processed,
                    "bbox": bbox,
                    "skel": skel,
                    "skel_backend": skel_backend,
                })
        except Exception as exc:  # noqa: BLE001
            # annotation failure must not break segmentation
            print(f"  ✗ clip {seg.seg_id:03d} annotate failed: {exc!r}", flush=True)