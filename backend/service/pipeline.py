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
import numpy as np

from ..core import segment_swing as core
from .clip_codec import transcode_to_h264
from .pose_runners.annotate import ClipAnnotator


# ── types ────────────────────────────────────────────────────────────────
ProgressCb = Callable[[Dict], None]
SegmentCb = Callable[[Dict], None]
ClipAnnotatedCb = Callable[[Dict], None]
ClipExtractedCb = Callable[[Dict], None]  # plan 002 (M13): per-clip WS push
ClipProgressCb = Callable[[Dict], None]  # plan 003: per-clip annotation stage progress


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
    "viz_video": True,
    # clip annotation (optional, applied after extraction per clip)
    "clip_bbox": False,        # RTMDet bbox overlay
    "clip_skel": False,        # pose skeleton overlay
    "skel_backend": "rtmpose", # "rtmpose" | "mediapipe"
    # Annotation colour defaults — match the GUI Settings panel
    # defaults: pink bbox, red/yellow/green pose sides.
    "color_bbox":        "ff69b4",  # hot pink
    "color_pose_left":   "ff0000",  # red
    "color_pose_right":  "ffff00",  # yellow
    "color_pose_body":   "00ff00",  # green
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
    on_clip_extracted: Optional[ClipExtractedCb] = None,
    on_clip_progress: Optional[ClipProgressCb] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict:
    """Run Pass 1 + Pass 1.5 + (optional) Pass 2 + (optional) clip annotation.

    `on_clip_progress` (plan 003) fires from inside each per-clip annotation
    thread — payload: {seg_id, stage, frame, total}. Threading note: the
    callback is responsible for crossing to the WS loop (callers wrap it).

    Returns the segments.json payload as a dict. JobCancelled is no
    longer raised on mid-run cancellation — a cancel observed during
    Pass 1 simply flips a local `cancel_observed` flag and breaks out of
    the loop, so Pass 1.5 (segments.json) and Pass 2 (viz.mp4) still
    run with whatever partial results were collected. This way the GUI
    can probe a real viz.mp4 on disk after a cancel. JobCancelled is
    kept as a class for the `except JobCancelled` arm in jobs.py to
    catch any future caller that decides to raise instead of flag.
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

    # Cancel probe — `cancel_observed` flips True the instant we notice
    # `should_cancel()`. We `break` instead of raising so Pass 1.5 + Pass
    # 2 still run with whatever frames + segments we already collected.
    # Previously a mid-Pass-1 cancel raised JobCancelled which aborted
    # before render_outputs() was reached — viz.mp4 never got written
    # and the GUI's "play viz" button stayed grey even though the rest
    # of the pipeline had real partial results worth showing.
    cancel_observed = False

    try:
        try:
            skip = max(1, int(p["skip"]))
            while frame_idx < limit:
                if should_cancel and should_cancel():
                    cancel_observed = True
                    break
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
                            on_clip_extracted,
                            on_clip_progress,
                            p.get("color_bbox"),
                            p.get("color_pose_left"),
                            p.get("color_pose_right"),
                            p.get("color_pose_body"),
                            should_cancel,
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
        # Runs on both the happy path AND on a partial cancel — we want
        # the trailing segment (if any) to be emitted so Pass 1.5 has
        # all cycles detected.
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
                        on_clip_extracted,
                        on_clip_progress,
                        p.get("color_bbox"),
                        p.get("color_pose_left"),
                        p.get("color_pose_right"),
                        p.get("color_pose_body"),
                        should_cancel,
                    )
        finally:
            # Shutdown the executor LAST (and only once). It MUST be after
            # flush() so a segment emitted by flush() can still submit.
            if clip_executor is not None:
                clip_executor.shutdown(wait=True)
    except JobCancelled:  # noqa: BLE001 — defensive; should_cancel now
        # exits the loop via `break` so this branch is usually unreachable.
        # Kept as a safety net for any future caller that raises instead
        # of flagging.
        cancel_observed = True
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

        # If viz_video was on but `render_outputs` early-returned because
        # `segments` was empty (typical of a cancel at frame 0), there's
        # no viz.mp4 on disk and the GUI's HEAD probe would still report
        # 404 → "play viz" button stays grey. Write a 1-frame black
        # placeholder so the file exists and the button can enable.
        # Real frames / phases render normally when segments is non-empty.
        if p["viz_video"]:
            viz_path = out_dir / "viz.mp4"
            if not viz_path.exists():
                _write_stub_viz(viz_path, width, height, fps)

            # Chromium's `<video>` cannot decode mp4v (MPEG-4 Visual) on
            # macOS/Linux — same root cause as the original clip playback
            # bug fixed in plan 002. The clips apply the same fix:
            # transcode to H.264 so the GUI can play it in-place. Failure
            # is non-fatal (no ffmpeg / bad source) — the mp4v original
            # stays as the canonical download and the GUI keeps the
            # download link but the in-app player simply won't play.
            viz_h264_path = out_dir / "viz_h264.mp4"
            if viz_path.exists():
                try:
                    transcode_to_h264(viz_path, viz_h264_path)
                except Exception as exc:  # noqa: BLE001
                    print(f"  ✗ viz h264 transcode failed: {exc!r}", flush=True)

    return payload


def _write_stub_viz(viz_path: Path, width: int, height: int, fps: float) -> None:
    """One-frame black placeholder so the GUI's viz probe finds a file.

    Only used when render_outputs() decided nothing to render (no
    segments produced — e.g. cancel at frame 0). Deliberately minimal:
    a valid mp4v header + one dark frame is enough for the HEAD probe
    to flip vizAvailable=true and for the <video> element to load
    without an error modal.
    """
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    safe_w, safe_h = max(int(width), 2), max(int(height), 2)
    safe_fps = max(float(fps) or 30.0, 1.0)
    writer = cv2.VideoWriter(str(viz_path), fourcc, safe_fps, (safe_w, safe_h))
    if not writer.isOpened():
        return  # best-effort; nothing else we can do here
    frame = np.zeros((safe_h, safe_w, 3), dtype=np.uint8)
    writer.write(frame)
    writer.release()


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
    on_clip_extracted: Optional[ClipExtractedCb] = None,
    on_clip_progress: Optional[ClipProgressCb] = None,
    color_bbox: Optional[str] = None,
    color_pose_left: Optional[str] = None,
    color_pose_right: Optional[str] = None,
    color_pose_body: Optional[str] = None,
    # Cooperative-cancel probe shared with run_pipeline's main loop.
    # Checked at task start, between annotation frames (via
    # ClipAnnotator.cancel_cb), and before the H.264 transcode — this is
    # what makes 取消 responsive: without it, clip_executor's
    # shutdown(wait=True) waits for every remaining annotation frame
    # (minutes of RTMPose/MediaPipe on CPU) and the GUI's cancel appears
    # to do nothing.
    should_cancel: Optional[Callable[[], bool]] = None,
) -> None:
    """Background task: extract one clip, then optionally annotate it.

    Extracted clip lives at `<clips_dir>/clip_NNN.mp4`.
    If annotation enabled: writes `<clips_dir>/clip_NNN_annotated.mp4` and
    notifies the caller via `on_clip_annotated`. Plan 003 adds
    `on_clip_progress` carrying {seg_id, stage, frame, total} payloads
    forwarded from `annotator.annotate_clip` (fired at frame=0, every 5
    frames, and once with the final count before this function returns).
    On completion (extracted + H.264 transcode attempted) fires
    `on_clip_extracted` with a ClipInfo payload so the GUI can pop a
    preview card into the bottom ClipsBar in real time (plan 002 M13).
    """
    core.extract_one_clip(video_path, seg, clips_dir, fps, width, height)

    clip_mp4 = clips_dir / f"clip_{seg.seg_id:03d}.mp4"
    if not clip_mp4.exists():
        return

    # Cancel probe #1 — queued tasks that never started exit immediately
    # so shutdown(wait=True) drains the queue in milliseconds.
    if should_cancel is not None and should_cancel():
        return

    if annotator is not None and (bbox or skel):
        try:
            # plan 003 — per-clip annotation stage progress bridge.
            def _ann_progress(stage: str, frame: int, total: int) -> None:
                if on_clip_progress is None:
                    return
                try:
                    on_clip_progress({
                        "seg_id": seg.seg_id,
                        "stage": stage,
                        "frame": frame,
                        "total": total,
                    })
                except Exception as exc:  # noqa: BLE001
                    print(f"  ✗ clip {seg.seg_id:03d} clip.progress cb failed: {exc!r}", flush=True)

            res = annotator.annotate_clip(
                clip_mp4,
                bbox=bbox,
                skel=skel,
                skel_backend=skel_backend,
                progress_cb=_ann_progress,
                color_bbox=color_bbox,
                color_pose_left=color_pose_left,
                color_pose_right=color_pose_right,
                color_pose_body=color_pose_body,
                cancel_cb=should_cancel,
            )
            if on_clip_annotated is not None:
                on_clip_annotated({
                    "seg_id": seg.seg_id,
                    "clip_in": str(clip_mp4),
                    "clip_annotated": str(res.clip_out),
                    "frames": res.frames_processed,
                    "bbox": bbox,
                    "skel": skel,
                    "skel_backend": skel_backend,
                })
        except Exception as exc:  # noqa: BLE001
            # annotation failure must not break segmentation
            print(f"  ✗ clip {seg.seg_id:03d} annotate failed: {exc!r}", flush=True)

    # Cancel probe #2 — if cancel arrived while this task ran, bail out
    # before the H.264 transcode + GUI event so shutdown(wait=True)
    # returns promptly and the job flips to `cancelled` within ~a frame.
    if should_cancel is not None and should_cancel():
        return

    # H.264 preview for Chromium <video> (plan 002). mp4v original is kept
    # as the canonical download artifact. plan 003 follow-up: when
    # annotation succeeded the in-GUI preview should mirror the overlay
    # — so transcode the annotated file when present, falling back to
    # the raw mp4v when no annotation flags were on (or annotate errored).
    # Failure is non-fatal: the clip stays mp4v-only and the GUI falls
    # back to original-video seek.
    h264_path = clips_dir / f"clip_{seg.seg_id:03d}_h264.mp4"
    annotated_mp4 = clips_dir / f"clip_{seg.seg_id:03d}_annotated.mp4"
    h264_src = annotated_mp4 if annotated_mp4.exists() else clip_mp4
    try:
        transcode_to_h264(h264_src, h264_path)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ clip {seg.seg_id:03d} h264 transcode failed: {exc!r}", flush=True)

    # Notify the GUI that this clip is now ready to preview. Fires once
    # per clip regardless of H.264 success (so the card always shows up
    # even if the transcode failed — the GUI's fallback path handles it).
    if on_clip_extracted is not None:
        try:
            on_clip_extracted({
                "seg_id": seg.seg_id,
                "exists": True,
                "size_bytes": clip_mp4.stat().st_size,
                "playable": h264_path.exists(),
                "annotated": (clips_dir / f"clip_{seg.seg_id:03d}_annotated.mp4").exists(),
                "thumb_ready": (clips_dir / f"clip_{seg.seg_id:03d}.thumb.jpg").exists(),
            })
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ clip {seg.seg_id:03d} on_clip_extracted callback failed: {exc!r}", flush=True)