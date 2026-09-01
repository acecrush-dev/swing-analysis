"""Vendored algorithm library.

Three independent entry points, each runnable as a standalone CLI and each
also importable as a library:

  segment_swing.py         — pass-1 online + pass-1.5 offline cut pipeline.
                             Single signal: right wrist (MediaPipe idx 16).
                             Emits SwingSegment objects with ready / windup /
                             contact / follow_through phases.

  analyze_swing.py         — MediaPipe once, full 33 points. Wrist feeds
                             segment_swing's OnlineSegmenter; the 33 points
                             are stored per frame so clip overlays and the
                             full-video viz.mp4 are guaranteed 1:1 with the
                             segments list.

  gen_skeleton_anim.py     — RTMDet (bbox) + RTMPose / MediaPipe (skeleton)
                             four-quadrant compositor. Optional smart-zoom
                             cropping driven by RTMDet person detection,
                             stable ROI smoother, and auto-sizing.

All three are pure algorithm code: no I/O orchestration, no transport. The
service layer (backend/service/pipeline.py) and CLI entry (backend/cli.py)
compose them per user flags. Any divergence between this repo and the
underlying algorithm source is resolved by `cp`, not by hand-merging —
do NOT edit the vendored files in place.
"""