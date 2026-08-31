"""CLI entry — the algorithm's other UI.

The same `backend.service.pipeline.run_pipeline` powers both this CLI and
the REST/WS service. CLI is just another way to drive it. The decoupling
is what lets Electron, browsers, mobile, or a terminal user share the
exact same cutting pipeline.

Usage:
    python -m backend.cli --video /abs/path/to/video.mp4
    python -m backend.cli --video fdl.mp4 --max-frames 1500 --save-clips --viz-video
    python -m backend.cli --video x.mp4 --out-dir my_out --v-swing 0.12
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


# ── pretty progress line ─────────────────────────────────────────────────
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


def main(argv=None) -> int:
    here = Path(__file__).resolve().parents[1]
    default_models = here / "backend" / "models"
    default_out = here / "data" / "cli_jobs"

    parser = argparse.ArgumentParser(
        prog="backend.cli",
        description="挥拍自动切分 CLI（与 REST 服务共享同一 pipeline）",
    )
    parser.add_argument(
        "--video", required=True,
        help="输入视频绝对路径（或相对路径，相对于 backend/）",
    )
    parser.add_argument("--task", default=str(default_models / "pose_landmarker_lite.task"),
                        help="MediaPipe task 模型路径")
    parser.add_argument("--out-dir", default=str(default_out),
                        help="输出目录 (含 segments.json / clips/ / viz.mp4)")
    parser.add_argument("--max-frames", type=int, default=DEFAULT_PARAMS["max_frames"],
                        help="只处理前 N 帧 (0 = 全部)")
    parser.add_argument("--skip", type=int, default=DEFAULT_PARAMS["skip"])
    parser.add_argument("--v-swing", type=float, default=DEFAULT_PARAMS["v_swing"])
    parser.add_argument("--gap-merge", type=float, default=DEFAULT_PARAMS["gap_merge"])
    parser.add_argument("--max-bridge", type=float, default=DEFAULT_PARAMS["max_bridge"])
    parser.add_argument("--min-peak", type=float, default=DEFAULT_PARAMS["min_peak"])
    parser.add_argument("--smooth-alpha", type=float, default=DEFAULT_PARAMS["smooth_alpha"])
    parser.add_argument("--max-lost-frames", type=int, default=DEFAULT_PARAMS["max_lost_frames"])
    parser.add_argument("--min-dur", type=float, default=DEFAULT_PARAMS["min_dur"])
    parser.add_argument("--max-dur", type=float, default=DEFAULT_PARAMS["max_dur"])
    parser.add_argument("--buf-before", type=float, default=DEFAULT_PARAMS["buf_before"])
    parser.add_argument("--buf-after", type=float, default=DEFAULT_PARAMS["buf_after"])
    parser.add_argument("--save-clips", action="store_true")
    parser.add_argument("--viz-video", action="store_true")
    parser.add_argument("--quiet", action="store_true", help="不打印进度条")
    args = parser.parse_args(argv)

    # ── resolve paths ──
    video = Path(args.video)
    if not video.is_absolute():
        # also try here/..
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
    }

    print(f"输入:    {video}")
    print(f"模型:    {task.name}")
    print(f"输出:    {out_dir}")
    print(f"参数:    v_swing={params['v_swing']}  gap_merge={params['gap_merge']}s  "
          f"min_peak={params['min_peak']}  save_clips={params['save_clips']}  viz={params['viz_video']}")

    progress_cb = None if args.quiet else _make_progress_printer()
    printed_segs: set = set()

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

    cancelled = {"v": False}

    def should_cancel() -> bool:
        return cancelled["v"]

    # Best-effort Ctrl+C handling: flip flag, pipeline sees it next frame.
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
            should_cancel=should_cancel,
        )
    except JobCancelled:
        print("[cancelled] 已终止", flush=True)
        return 130
    except Exception as exc:  # noqa: BLE001
        print(f"\nERROR: {exc!r}", file=sys.stderr)
        return 1

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


if __name__ == "__main__":
    sys.exit(main())