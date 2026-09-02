"""Clip codec helpers — H.264 preview transcoding + thumbnail generation (plan 002).

Background
----------
The pipeline writes per-clip mp4 files using `cv2.VideoWriter` with the
mp4v fourcc (MPEG-4 Part 2). Chromium's `<video>` element cannot decode
mp4v on macOS/Linux, so the Electron GUI cannot play these clips in-place.

Solution: after each clip is extracted (and optionally annotated), we
transcode the canonical `clip_NNN.mp4` (mp4v) into a sibling
`clip_NNN_h264.mp4` (H.264 + yuv420p + +faststart). The mp4v original is
kept as the canonical download artifact; the H.264 copy is what the GUI
embeds. If ffmpeg is unavailable OR the transcode fails, the clip stays
mp4v-only and the GUI falls back to seeking the original video to the
segment's start_timecode (download-only mode).

Failure mode is *deliberately non-fatal* — the segmentation pipeline must
not be coupled to ffmpeg availability. Every transcode call is wrapped in
try/except, and a failed transcode just leaves the clip as mp4v.

ffmpeg binary resolution order (see `find_ffmpeg`):
  1. `imageio_ffmpeg.get_ffmpeg_exe()` — pip wheel ships a static binary,
     works without a system ffmpeg install.
  2. `shutil.which("ffmpeg")` — fall back to whatever is on PATH.
  3. None — caller treats as "no H.264 preview available".
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Optional

import cv2


# ── ffmpeg discovery ─────────────────────────────────────────────────────
_FFMPEG_CACHE: Optional[str] = None


def find_ffmpeg() -> Optional[str]:
    """Return absolute path to an ffmpeg executable, or None if unavailable.

    Resolution order:
      1. imageio-ffmpeg pip wheel (static binary, no system install needed)
      2. `ffmpeg` on PATH (system install)
    """
    global _FFMPEG_CACHE
    if _FFMPEG_CACHE is not None:
        # cached negative (None) or positive (path) — both stable for the
        # lifetime of this Python process
        return _FFMPEG_CACHE

    try:
        import imageio_ffmpeg  # type: ignore
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and Path(exe).exists():
            _FFMPEG_CACHE = str(exe)
            return _FFMPEG_CACHE
    except Exception:  # noqa: BLE001
        pass

    on_path = shutil.which("ffmpeg")
    if on_path:
        _FFMPEG_CACHE = on_path
        return _FFMPEG_CACHE

    _FFMPEG_CACHE = None
    return None


# ── H.264 transcode ──────────────────────────────────────────────────────
def transcode_to_h264(
    src: Path,
    dst: Path,
    timeout_sec: float = 60.0,
) -> bool:
    """Transcode `src` (any ffmpeg-decodable video) to H.264 at `dst`.

    Returns True iff the output file was written and ffmpeg exited 0.
    Any failure (no ffmpeg, non-zero exit, timeout, partial output) leaves
    `dst` removed and returns False.
    """
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return False

    src = Path(src)
    dst = Path(dst)
    if not src.exists() or not src.is_file():
        return False

    # list-args (no shell) — pass `-y` to overwrite any stale dst
    cmd = [
        ffmpeg,
        "-y",
        "-i", str(src),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-an",
        str(dst),
    ]

    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired:
        dst.unlink(missing_ok=True)
        return False
    except Exception:  # noqa: BLE001
        dst.unlink(missing_ok=True)
        return False

    if proc.returncode != 0 or not dst.exists() or dst.stat().st_size == 0:
        dst.unlink(missing_ok=True)
        return False
    return True


# ── Thumbnail (lazy, cached) ─────────────────────────────────────────────
def generate_thumbnail(src: Path, dst: Path) -> bool:
    """Generate a JPEG thumbnail of the clip's mid-frame at `dst`.

    Returns True iff the JPEG was written. Caller is responsible for
    caching (i.e. only calling when dst doesn't already exist). Any
    cv2/decode failure leaves `dst` removed and returns False.
    """
    src = Path(src)
    dst = Path(dst)
    if not src.exists() or not src.is_file():
        return False

    try:
        cap = cv2.VideoCapture(str(src))
        if not cap.isOpened():
            return False
        try:
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            mid = total // 2 if total > 0 else 0
            if mid > 0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, mid)
            ok, frame = cap.read()
            if not ok or frame is None:
                # fall back to frame 0
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = cap.read()
                if not ok or frame is None:
                    return False
            ok2, buf = cv2.imencode(
                ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85]
            )
            if not ok2:
                return False
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(buf.tobytes())
            return dst.exists() and dst.stat().st_size > 0
        finally:
            cap.release()
    except Exception:  # noqa: BLE001
        try:
            dst.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
        return False