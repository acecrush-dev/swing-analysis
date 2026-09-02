"""CLI entry — the algorithm's other UI.

Two sub-commands, each pure (one does ONE thing):

  segment  — run the swing segmentation pipeline on a video
  annotate — overlay RTMDet bbox + (optional) pose skeleton on existing
             clips produced by a prior `segment` run

The segmentation pipeline (in `backend.service.pipeline.run_pipeline`) is
the same one the REST/WS service uses. This CLI is just another way to
drive it. Annotation is a separate stage that runs on already-cut clips.

Examples:
    python -m backend.cli segment --video /abs/x.mp4 --max-frames 1500
    python -m backend.cli segment --video /abs/x.mp4 --save-clips --clip-bbox --clip-skel
    python -m backend.cli annotate --clips-dir backend/data/jobs/<id>/clips --bbox --skel
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Optional

from .service.pipeline import DEFAULT_PARAMS, JobCancelled, run_pipeline


# ═════════════════════════════════════════════════════════════════════════
# `segment` sub-command
# ═════════════════════════════════════════════════════════════════════════

def _make_progress_printer(total: Optional[int] = None):
    t0 = time.time()
    last_t = t0

    def cb(d: dict) -> None:
        nonlocal last_t
        now = time.time()
        if now - last_t < 0.1 and d.get("phase") != "done":
            return
        last_t = now
        if d.get("phase") == "done":
            print(
                f"\r  ✓ done  {d['frames']}/{d['total']} frames  "
                f"emitted={d.get('segments_emitted', 0)}  "
                f"final={d.get('segments_final', 0)}",
                flush=True,
            )
            return
        pct = 100.0 * d["frames"] / max(d["total"], 1)
        eta = d.get("eta_sec")
        eta_s = (
            f"{int(eta // 60)}:{int(eta % 60):02d}"
            if eta is not None and eta < 86400 * 30
            else "--:--"
        )
        print(
            f"\r  [pose]  {d['frames']}/{d['total']}  "
            f"{pct:5.1f}%  {d['fps']:5.1f}fps  ETA {eta_s}  "
            f"segments={d.get('segments_emitted', 0)}   ",
            end="",
            flush=True,
        )

    return cb


def cmd_segment(args) -> int:
    here = Path(__file__).resolve().parents[1]
    default_models = here / "backend" / "models"
    default_out = here / "data" / "cli_jobs"

    # ── resolve paths ──
    video = Path(args.video)
    if not video.is_absolute():
        candidates = [here.parent / args.video, video.resolve()]
        for c in candidates:
            if c.exists():
                video = c
                break
    task = Path(args.task)
    if not task.is_absolute():
        task = (here / task).resolve()
    out_dir = Path(args.out_dir).resolve()
    if not video.exists():
        print(f"ERROR: 视频不存在 {video}", file=sys.stderr)
        return 1
    if not task.exists():
        print(f"ERROR: 模型不存在 {task}", file=sys.stderr)
        return 1

    params = {
        "v_swing": args.v_swing,
        "gap_merge": args.gap_merge,
        "max_bridge": args.max_bridge,
        "min_peak": args.min_peak,
        "smooth_alpha": args.smooth_alpha,
        "max_lost_frames": args.max_lost_frames,
        "min_dur": args.min_dur,
        "max_dur": args.max_dur,
        "buf_before": args.buf_before,
        "buf_after": args.buf_after,
        "skip": args.skip,
        "max_frames": args.max_frames,
        "save_clips": args.save_clips,
        "viz_video": args.viz_video,
        "clip_bbox": args.clip_bbox,
        "clip_skel": args.clip_skel,
        "skel_backend": args.skel_backend,
    }

    print(f"输入:    {video}")
    print(f"模型:    {task.name}")
    print(f"输出:    {out_dir}")
    print(f"参数:    v_swing={params['v_swing']}  gap_merge={params['gap_merge']}s  "
          f"min_peak={params['min_peak']}  save_clips={params['save_clips']}  "
          f"viz={params['viz_video']}  clip_bbox={params['clip_bbox']}  "
          f"clip_skel={params['clip_skel']}  skel={params['skel_backend']}")

    progress_cb = None if args.quiet else _make_progress_printer()
    printed_segs: set = set()
    printed_annotated: set = set()

    def on_segment(s: dict) -> None:
        if s["seg_id"] in printed_segs:
            return
        printed_segs.add(s["seg_id"])
        print(
            f"\n  ▶ swing #{s['seg_id']:>3}  帧 {s['start_frame']}-{s['end_frame']}  "
            f"{s['start_timecode']}→{s['end_timecode']}  "
            f"击球@{s['contact_timecode']} peak={s['peak_velocity']:.3f}  "
            f"dur={s['duration_sec']:.2f}s",
            flush=True,
        )

    def on_clip_annotated(d: dict) -> None:
        sid = d["seg_id"]
        if sid in printed_annotated:
            return
        printed_annotated.add(sid)
        print(
            f"\n  ◆ clip #{sid:03d} annotated → {Path(d['clip_annotated']).name}  "
            f"({d['frames']}f, bbox={d['bbox']}, skel={d['skel']}, "
            f"backend={d['skel_backend']})",
            flush=True,
        )

    cancelled = {"v": False}

    def should_cancel() -> bool:
        return cancelled["v"]

    import signal

    def _on_sigint(_sig, _frm):
        cancelled["v"] = True
        print("\n[cancel] 收到 SIGINT, 正在收尾...", flush=True)

    signal.signal(signal.SIGINT, _on_sigint)

    t0 = time.time()
    try:
        payload = run_pipeline(
            video_path=video,
            task_path=task,
            out_dir=out_dir,
            params=params,
            progress_cb=progress_cb,
            on_segment=on_segment,
            on_clip_annotated=on_clip_annotated,
            should_cancel=should_cancel,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"\nERROR: {exc!r}", file=sys.stderr)
        return 1

    # run_pipeline no longer raises JobCancelled — it returns normally
    # with whatever partial results it managed to write (segments.json
    # + a stub-or-real viz.mp4 if viz_video was on). The CLI uses its
    # own cancel flag to decide whether the run actually completed.
    if cancelled["v"]:
        segs = payload.get("segments", []) or []
        print(f"[cancelled] 收尾完成, 已写出 {len(segs)} 个已检出周期 (再跑一次可以分段完赛)",
              flush=True)
        print(f"  JSON: {out_dir / 'segments.json'}", flush=True)
        return 130

    elapsed = time.time() - t0
    print()
    print(f"✓ 完成: 检测到 {payload['segment_count']} 个完整挥拍周期")
    print(f"  耗时 {elapsed:.1f}s ({payload['processed_frames'] / max(elapsed, 1e-3):.1f} fps 处理速度)")
    print(f"  JSON: {out_dir / 'segments.json'}")
    if payload["segments"]:
        durs = [s["duration_sec"] for s in payload["segments"]]
        peaks = [s["peak_velocity"] for s in payload["segments"]]
        print(f"  duration_sec: min={min(durs):.2f}  median={sorted(durs)[len(durs) // 2]:.2f}  max={max(durs):.2f}")
        print(f"  peak_velocity: min={min(peaks):.3f}  median={sorted(peaks)[len(peaks) // 2]:.3f}  max={max(peaks):.3f}")
    return 0


# ═════════════════════════════════════════════════════════════════════════
# `annotate` sub-command  (post-hoc clip enrichment)
# ═════════════════════════════════════════════════════════════════════════

def cmd_annotate(args) -> int:
    """Run RTMDet + (optional) pose skeleton on every clip_*.mp4 in a directory.

    Independent of segmentation — runs on any mp4s you give it.
    """
    from .service.pose_runners import ClipAnnotator
    from pathlib import Path as _P

    clips_dir = _P(args.clips_dir).resolve()
    if not clips_dir.is_dir():
        print(f"ERROR: clips 目录不存在: {clips_dir}", file=sys.stderr)
        return 1

    clips = sorted(clips_dir.glob("clip_*.mp4"))
    # Skip already-annotated outputs.
    clips = [c for c in clips if "_annotated" not in c.stem]
    if not clips:
        print(f"  (no clip_*.mp4 in {clips_dir})")
        return 0

    print(f"输入 clips: {clips_dir}")
    print(f"  found {len(clips)} clip(s)")
    print(f"  bbox={args.bbox}  skel={args.skel}  skel_backend={args.skel_backend}")

    ann = ClipAnnotator()
    t0 = time.time()
    ok, fail = 0, 0
    for clip_in in clips:
        try:
            res = ann.annotate_clip(
                clip_in,
                bbox=args.bbox,
                skel=args.skel,
                skel_backend=args.skel_backend,
            )
            ok += 1
            print(f"  ✓ {clip_in.name} → {res.clip_out.name}  ({res.frames_processed}f)")
        except Exception as exc:  # noqa: BLE001
            fail += 1
            print(f"  ✗ {clip_in.name}: {exc!r}", file=sys.stderr)

    elapsed = time.time() - t0
    print(f"\n✓ annotate done: {ok} ok, {fail} failed, {elapsed:.1f}s")
    return 0 if fail == 0 else 2


# ═════════════════════════════════════════════════════════════════════════
# Argument parser
# ═════════════════════════════════════════════════════════════════════════

def _add_segment_args(p: argparse.ArgumentParser) -> None:
    here_default = Path(__file__).resolve().parents[1]
    default_models = here_default / "backend" / "models"
    default_out = here_default / "data" / "cli_jobs"
    p.add_argument("--video", required=True, help="输入视频绝对路径（或相对路径，相对于 backend/）")
    p.add_argument("--task", default=str(default_models / "pose_landmarker_lite.task"),
                   help="MediaPipe task 模型路径")
    p.add_argument("--out-dir", default=str(default_out),
                   help="输出目录 (含 segments.json / clips/ / viz.mp4)")
    p.add_argument("--max-frames", type=int, default=DEFAULT_PARAMS["max_frames"], help="只处理前 N 帧 (0 = 全部)")
    p.add_argument("--skip", type=int, default=DEFAULT_PARAMS["skip"])
    p.add_argument("--v-swing", type=float, default=DEFAULT_PARAMS["v_swing"])
    p.add_argument("--gap-merge", type=float, default=DEFAULT_PARAMS["gap_merge"])
    p.add_argument("--max-bridge", type=float, default=DEFAULT_PARAMS["max_bridge"])
    p.add_argument("--min-peak", type=float, default=DEFAULT_PARAMS["min_peak"])
    p.add_argument("--smooth-alpha", type=float, default=DEFAULT_PARAMS["smooth_alpha"])
    p.add_argument("--max-lost-frames", type=int, default=DEFAULT_PARAMS["max_lost_frames"])
    p.add_argument("--min-dur", type=float, default=DEFAULT_PARAMS["min_dur"])
    p.add_argument("--max-dur", type=float, default=DEFAULT_PARAMS["max_dur"])
    p.add_argument("--buf-before", type=float, default=DEFAULT_PARAMS["buf_before"])
    p.add_argument("--buf-after", type=float, default=DEFAULT_PARAMS["buf_after"])
    p.add_argument("--save-clips", action="store_true", help="切出每个完整挥拍周期为独立 mp4")
    p.add_argument("--viz-video", action="store_true", help="生成可视化视频 (写 out-dir/viz.mp4)")
    p.add_argument("--clip-bbox", action="store_true", help="在每个切出的 clip 上叠加 RTMDet 人物框")
    p.add_argument("--clip-skel", action="store_true", help="在每个切出的 clip 上叠加姿态骨架")
    p.add_argument("--skel-backend", choices=["rtmpose", "mediapipe"], default=DEFAULT_PARAMS["skel_backend"],
                   help="clip 骨架用的姿态模型 (rtmpose=COCO-13, mediapipe=33 点)")
    p.add_argument("--quiet", action="store_true", help="不打印进度条")


def _add_annotate_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--clips-dir", required=True, help="含 clip_*.mp4 的目录")
    p.add_argument("--bbox", action="store_true", help="叠加 RTMDet 人物框")
    p.add_argument("--skel", action="store_true", help="叠加姿态骨架")
    p.add_argument("--skel-backend", choices=["rtmpose", "mediapipe"], default="rtmpose")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="backend.cli",
        description="挥拍切分 + clip 标注 CLI（sub-commands: segment / annotate）",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_seg = sub.add_parser("segment", help="从视频切出挥拍周期 + 可选 clip 标注")
    _add_segment_args(p_seg)

    p_ann = sub.add_parser("annotate", help="对已有 clip_*.mp4 跑 RTMDet / 骨架标注")
    _add_annotate_args(p_ann)

    args = parser.parse_args(argv)

    if args.cmd == "segment":
        return cmd_segment(args)
    if args.cmd == "annotate":
        return cmd_annotate(args)
    parser.error(f"unknown cmd: {args.cmd}")
    return 1


if __name__ == "__main__":
    sys.exit(main())