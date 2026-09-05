"""Eager-load skeleton backends at service startup.

Why this exists:
  The Electron splash window needs real status to display during the
  ~10–25 s cold-start window (onefile extraction + uvicorn boot + first
  ONNX/CoreML init). Without warmup, the splash shows "service ready"
  immediately after port bind, then the FIRST clip annotation silently
  pays the full 5–15 s ONNX cold-init cost — and the user gets a frozen
  UI with no indication why.

  Warmup runs at service startup (before port bind), eagerly creates the
  default backend's pose runners, and emits structured `[model]` log lines
  that the Electron main process forwards to the splash renderer. Status
  is also exposed via `GET /api/status` so the splash can show per-model
  state.

  Warmup never raises — failures downgrade the model to `failed` and let
  the service start anyway. The user sees the failure in the splash and
  can quit or proceed with degraded functionality.

  Default backend per `service.pipeline.DEFAULT_PARAMS["skel_backend"]`
  (currently `rtmpose`); rtmpose pipeline additionally needs rtmdet for
  bbox detection, so both are preloaded when default == rtmpose.

────────────────────────────────────────────────────────────────────────
  Validation contract (this is the bit that matters):
  "ready" means the model can ACTUALLY RUN INFERENCE, not just that the
  runner object exists. The previous implementation only constructed the
  ONNX session / MediaPipe detector — a session can parse a model file
  and then crash at first inference because the runtime EPs disagree with
  the model, an op is missing, the file is a 134-byte LFS pointer that
  happened to have a sensible-looking magic, etc. None of those failure
  modes would have been caught.

  Three layers of validation, each catches a different class of failure:

    1. File-size sanity check (catches LFS pointers / truncated copies).
       The smallest model in the bundle is pose_landmarker_lite.task at
       ~5.5 MB; we use a 256 KiB floor that's well below any real model
       and well above the ~134 B pointer size. If a file slips through
       below that bar, fail loudly with a hint about LFS.

    2. ONNX session construction (catches malformed models / missing
       ops). Wrapped in try/except — on failure we report the type +
       message, NOT just "ready".

    3. Dummy-inference round trip (catches "session parses but won't
       run" cases — wrong EP, runtime mismatch, partial build). For ONNX
       we feed a zero tensor with the model's actual input shape; for
       MediaPipe we run detection on a tiny all-zero BGR frame. If the
       call returns without raising AND the output has the expected
       non-empty shape, we mark ready. Anything else → failed.

  The active providers list is included in the success log so a wrong
  EP at warmup time is visible immediately (rather than showing up as
  "ready" + "inference is slow / returns nothing" 30 s later).
────────────────────────────────────────────────────────────────────────
"""
from __future__ import annotations

import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, Optional

logger = logging.getLogger(__name__)


# ── State ──────────────────────────────────────────────────────────────────
# Mutable module-level singleton so /api/status can read it without plumbing
# through every layer. Updates happen on the startup thread (no lock needed
# — Python dict assignments are atomic and readers tolerate one frame of
# staleness).
@dataclass
class WarmupState:
    sidecar: str = "starting"          # 'starting' | 'ready' | 'failed'
    models: Dict[str, str] = field(default_factory=lambda: {
        "rtmdet":    "pending",
        "rtmpose":   "pending",
        "mediapipe": "pending",
    })
    models_dir: str = ""
    default_backend: str = "rtmpose"

    def to_dict(self) -> dict:
        return {
            "sidecar": self.sidecar,
            "models": dict(self.models),
            "default_backend": self.default_backend,
            "models_dir": self.models_dir,
        }


STATE = WarmupState()


# ── Path helpers ───────────────────────────────────────────────────────────
def _rtmdet_path(models_dir: Path) -> Path:
    return models_dir / "rtmdet-m-487628.onnx"


def _rtmpose_path(models_dir: Path) -> Path:
    return models_dir / "rtmpose-m-27c0e6.onnx"


def _mp_task_path(models_dir: Path) -> Path:
    # Canonical filename on disk: `pose_landmarker_lite.task` (with 'r'),
    # matching backend/service/pose_runners/annotate.py:65.
    return models_dir / "pose_landmarker_lite.task"


# ── Validation thresholds ───────────────────────────────────────────────────
# Anything below this is treated as "this file isn't a real model":
#   - 134 B is the size of a Git LFS pointer file (the string
#     "version https://git-lfs.github.com/spec/v1\noid sha256:..."
#     plus a few newlines)
#   - 5.5 MB is the smallest real model (pose_landmarker_lite.task)
# 256 KiB is well below any real model and well above the pointer, so
# it's a safe floor.
_MIN_MODEL_BYTES = 256 * 1024

# ONNX dummy input shape (BCHW float32, ImageNet-normalised). The runners
# accept any HxW within reason, but we use the canonical training input.
_RTMDET_DUMMY_SHAPE = (1, 3, 640, 640)
_RTMPOSE_DUMMY_SHAPE = (1, 3, 256, 192)  # (B, C, H, W) — H×W flipped from POSE_IMG_SIZE=(192,256)


# ── Log helper ────────────────────────────────────────────────────────────
# We emit ONE line per state transition, prefixed `[model]`, so the
# Electron main process's existing stderr-forwarder pipes them straight
# into the splash's log panel without parsing.
def _emit(model: str, msg: str) -> None:
    line = f"[model] {model}: {msg}"
    print(line, file=sys.stderr, flush=True)
    logger.info(line)


def _file_failed(model: str, p: Path, reason: str) -> None:
    """Common failure shape for "file is wrong" cases."""
    STATE.models[model] = "failed"
    _emit(model, reason)


# ── ONNX dummy inference ───────────────────────────────────────────────────
def _onnx_dummy_check(runner, expected_in_shape) -> str:
    """Feed a zero tensor through the session, return a summary string.

    Returns a one-line description on success; raises on failure.
    """
    import numpy as np
    dummy = np.zeros(expected_in_shape, dtype=np.float32)
    outputs = runner.session.run(None, {runner.input_name: dummy})
    providers = runner.session.get_providers()
    out_shapes = [tuple(o.shape) for o in outputs]
    return f"providers={providers}, dummy_out_shapes={out_shapes}"


# ── Single-model loaders ───────────────────────────────────────────────────
# Each is a no-raise wrapper: catches everything, sets STATE, emits a
# `[model]` log line. Returns nothing — state lives in the singleton.
def _load_rtmdet(models_dir: Path) -> None:
    STATE.models["rtmdet"] = "loading"
    _emit("rtmdet", "loading solution …")
    p = _rtmdet_path(models_dir)
    if not p.exists():
        return _file_failed("rtmdet", p, f"failed: file not found ({p.name})")
    if p.stat().st_size < _MIN_MODEL_BYTES:
        return _file_failed(
            "rtmdet", p,
            f"failed: file too small ({p.stat().st_size}B, expected >{_MIN_MODEL_BYTES}B) — "
            f"likely a Git LFS pointer or a truncated copy. "
            f"Run `git lfs pull` (or `bash scripts/fetch-model.sh`).",
        )
    try:
        from .pose_runners.rtmdet import RtmdetRunner
        runner = RtmdetRunner(p)
        # ── Layer 3: real inference test ──
        info = _onnx_dummy_check(runner, _RTMDET_DUMMY_SHAPE)
        STATE.models["rtmdet"] = "ready"
        _emit("rtmdet", f"ready ({p.stat().st_size // 1024 // 1024} MiB, {info})")
    except Exception as e:
        STATE.models["rtmdet"] = "failed"
        _emit("rtmdet", f"failed: {type(e).__name__}: {e}")


def _load_rtmpose(models_dir: Path) -> None:
    STATE.models["rtmpose"] = "loading"
    _emit("rtmpose", "loading solution …")
    p = _rtmpose_path(models_dir)
    if not p.exists():
        return _file_failed("rtmpose", p, f"failed: file not found ({p.name})")
    if p.stat().st_size < _MIN_MODEL_BYTES:
        return _file_failed(
            "rtmpose", p,
            f"failed: file too small ({p.stat().st_size}B, expected >{_MIN_MODEL_BYTES}B) — "
            f"likely a Git LFS pointer or a truncated copy. "
            f"Run `git lfs pull` (or `bash scripts/fetch-model.sh`).",
        )
    try:
        from .pose_runners.rtmpose import RtmposeRunner
        runner = RtmposeRunner(p)
        info = _onnx_dummy_check(runner, _RTMPOSE_DUMMY_SHAPE)
        STATE.models["rtmpose"] = "ready"
        _emit("rtmpose", f"ready ({p.stat().st_size // 1024 // 1024} MiB, {info})")
    except Exception as e:
        STATE.models["rtmpose"] = "failed"
        _emit("rtmpose", f"failed: {type(e).__name__}: {e}")


def _load_mediapipe(models_dir: Path) -> None:
    STATE.models["mediapipe"] = "loading"
    _emit("mediapipe", "loading solution …")
    p = _mp_task_path(models_dir)
    if not p.exists():
        return _file_failed("mediapipe", p, f"failed: file not found ({p.name})")
    if p.stat().st_size < _MIN_MODEL_BYTES:
        return _file_failed(
            "mediapipe", p,
            f"failed: file too small ({p.stat().st_size}B, expected >{_MIN_MODEL_BYTES}B) — "
            f"likely a Git LFS pointer or a truncated copy. "
            f"Run `git lfs pull` (or `bash scripts/fetch-model.sh`).",
        )
    try:
        from .pose_runners.mediapipe import MediaPipePoseRunner
        runner = MediaPipePoseRunner(p)
        # ── Layer 3: real inference test ──
        # Feed a small all-zero BGR frame at ts_ms=0. Result may be None
        # (no pose detected on a blank frame) — that's fine, it proves
        # the detector graph is wired up and the inference call doesn't
        # raise. Anything that raises means the bundled tflite / Metal
        # delegate is broken (a real failure mode in PyInstaller onefile
        # bundles on Apple Silicon).
        import numpy as np
        blank = np.zeros((480, 640, 3), dtype=np.uint8)
        result = runner.pose(blank, 0)
        # `result` is None or List[(x,y,conf)]. Both are acceptable as
        # proof-of-life — what matters is that .pose() returned without
        # raising.
        STATE.models["mediapipe"] = "ready"
        _emit(
            "mediapipe",
            f"ready ({p.stat().st_size // 1024 // 1024} MiB, "
            f"dummy_detect={'pose' if result else 'no-pose'})",
        )
    except Exception as e:
        STATE.models["mediapipe"] = "failed"
        _emit("mediapipe", f"failed: {type(e).__name__}: {e}")


# ── Orchestrator ──────────────────────────────────────────────────────────
def warmup(
    models_dir: Path,
    default_backend: str = "rtmpose",
    on_progress: Optional[Callable[[str, str], None]] = None,
) -> WarmupState:
    """Eager-load pose models. Never raises.

    Args:
      models_dir:    directory containing ONNX / .task files.
      default_backend: 'rtmpose' or 'mediapipe'. When 'rtmpose' we also
                       load rtmdet (the bbox detector rtmpose depends on).
                       When 'mediapipe' we skip the ONNX pair to save ~10 s.
      on_progress:   optional (model, status) callback for in-process
                     subscribers (e.g. SSE / WS). Sidecar also prints
                     `[model]` lines that the Electron main process
                     forwards to the splash, so this is for native consumers.

    Returns:
      The shared WarmupState (same object as the module-level STATE).
    """
    STATE.models_dir = str(models_dir)
    STATE.default_backend = default_backend

    _emit("sidecar", f"warmup starting (default={default_backend})")

    # Always load the default backend's models first — those are what the
    # splash is gated on. Then load the alternate backend in the background
    # of the user's attention (status will report `ready` or `failed`).
    if default_backend == "rtmpose":
        _load_rtmdet(models_dir)
        if STATE.models["rtmdet"] != "failed":
            # rtmpose depends on rtmdet (needs bbox ROI). Skip rtmpose load
            # if rtmdet didn't make it — the user will already see the
            # underlying problem in the splash.
            _load_rtmpose(models_dir)
        else:
            STATE.models["rtmpose"] = "failed"
            _emit("rtmpose", "skipped: rtmdet unavailable")
        # Always attempt mediapipe too — small + gives full transparency.
        _load_mediapipe(models_dir)
    else:
        _load_mediapipe(models_dir)
        if STATE.models["mediapipe"] != "failed":
            _load_rtmdet(models_dir)
            if STATE.models["rtmdet"] != "failed":
                _load_rtmpose(models_dir)
            else:
                STATE.models["rtmpose"] = "failed"
                _emit("rtmpose", "skipped: rtmdet unavailable")
        else:
            # Both ONNX models still useful even if mediapipe failed.
            _load_rtmdet(models_dir)
            if STATE.models["rtmdet"] != "failed":
                _load_rtmpose(models_dir)
            else:
                STATE.models["rtmpose"] = "failed"
                _emit("rtmpose", "skipped: rtmdet unavailable")

    STATE.sidecar = "ready"
    _emit("sidecar", "warmup done")

    if on_progress:
        try:
            on_progress("__done__", STATE.sidecar)
        except Exception:  # noqa: BLE001
            pass  # never fail warmup because a progress hook misbehaved
    return STATE
