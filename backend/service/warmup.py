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


# ── Log helper ────────────────────────────────────────────────────────────
# We emit ONE line per state transition, prefixed `[model]`, so the
# Electron main process's existing stderr-forwarder pipes them straight
# into the splash's log panel without parsing.
def _emit(model: str, msg: str) -> None:
    line = f"[model] {model}: {msg}"
    print(line, file=sys.stderr, flush=True)
    logger.info(line)


# ── Single-model loaders ───────────────────────────────────────────────────
# Each is a no-raise wrapper: catches everything, sets STATE, emits a
# `[model]` log line. Returns nothing — state lives in the singleton.
def _load_rtmdet(models_dir: Path) -> None:
    STATE.models["rtmdet"] = "loading"
    _emit("rtmdet", "loading solution …")
    p = _rtmdet_path(models_dir)
    if not p.exists():
        STATE.models["rtmdet"] = "failed"
        _emit("rtmdet", f"failed: file not found ({p.name})")
        return
    try:
        from .pose_runners.rtmdet import RtmdetRunner  # noqa: WPS433 (lazy import — keep startup fast if status-only call)
        RtmdetRunner(p)  # __init__ runs ONNX session creation + CoreML/CPU provider init
        STATE.models["rtmdet"] = "ready"
        _emit("rtmdet", "ready")
    except Exception as e:  # noqa: BLE001 — we genuinely want to catch everything here
        STATE.models["rtmdet"] = "failed"
        _emit("rtmdet", f"failed: {type(e).__name__}: {e}")


def _load_rtmpose(models_dir: Path) -> None:
    STATE.models["rtmpose"] = "loading"
    _emit("rtmpose", "loading solution …")
    p = _rtmpose_path(models_dir)
    if not p.exists():
        STATE.models["rtmpose"] = "failed"
        _emit("rtmpose", f"failed: file not found ({p.name})")
        return
    try:
        from .pose_runners.rtmpose import RtmposeRunner
        RtmposeRunner(p)
        STATE.models["rtmpose"] = "ready"
        _emit("rtmpose", "ready")
    except Exception as e:  # noqa: BLE001
        STATE.models["rtmpose"] = "failed"
        _emit("rtmpose", f"failed: {type(e).__name__}: {e}")


def _load_mediapipe(models_dir: Path) -> None:
    STATE.models["mediapipe"] = "loading"
    _emit("mediapipe", "loading solution …")
    p = _mp_task_path(models_dir)
    if not p.exists():
        STATE.models["mediapipe"] = "failed"
        _emit("mediapipe", f"failed: file not found ({p.name})")
        return
    try:
        from .pose_runners.mediapipe import MediaPipePoseRunner
        MediaPipePoseRunner(p)
        STATE.models["mediapipe"] = "ready"
        _emit("mediapipe", "ready")
    except Exception as e:  # noqa: BLE001
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
