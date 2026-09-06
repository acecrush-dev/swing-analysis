/**
 * Pose detection — wrap the modelLoader runners behind a tiny façade
 * so the pipeline orchestrator doesn't need to know which backend it's
 * talking to.
 *
 * Phase 3 ships mediapipe-only (full-frame 33-keypoint pose via
 * `detectForVideo(video, tsMs)`). RTMPose path (rtmdet bbox → rtmpose
 * inside ROI) is stubbed for Phase 4.
 *
 * Confidence threshold 0.3 mirrors the Python pipeline's `min_pose_presence_confidence`
 * = 0.5 with a small tolerance for browser mediapipe's tendency to
 * produce noisier visibility scores than the desktop build.
 */
import { getRunner } from '../modelLoader';
import type { WristFrame } from './types';

const VISIBILITY_THRESHOLD = 0.3;

// MediaPipe Pose landmark indices (matching backend/service/pose_runners/mediapipe.py).
const MP_LEFT_WRIST = 15;
const MP_RIGHT_WRIST = 16;

// plan 008 M2 — mediapipe requires `detectForVideo()` timestamps to be
// STRICTLY increasing per landmarker instance. Our landmarker is a
// singleton cached in modelLoader and reused across runs; a second Run
// restarts at ts≈0, which is ≤ the last timestamp of the previous run
// and makes mediapipe throw a packet-timestamp error. Fix: keep a
// module-level offset — whenever the incoming ts is not ahead of the
// last one we served, bump the offset so the effective timestamp keeps
// increasing. Per-run video time is preserved relative to the run start.
let mpOffset = 0;
let mpLast = -1;

function monotonicTs(tsMs: number): number {
  if (tsMs <= mpLast) {
    mpOffset += mpLast + 1 - tsMs;
  }
  mpLast = tsMs + mpOffset;
  return mpLast;
}

/** Reset the monotonic guard — call when the landmarker is recreated. */
export function resetPoseTimestamp(): void {
  mpOffset = 0;
  mpLast = -1;
}

/**
 * Detect pose on the video at the given timestamp. Returns the wrist
 * positions (in normalised [0,1] coords) for the highest-confidence
 * pose found, or null if no usable pose was returned.
 *
 * NOTE: mediapipe's `detectForVideo(video, tsMs)` requires the video
 * element's `currentTime` to be exactly the timestamp being processed.
 * Callers must `video.currentTime = tsMs; await seeked` first. The
 * pipeline orchestrator handles this.
 */
export function detectPose(video: HTMLVideoElement, tsMs: number): { leftWrist?: WristFrame['leftWrist']; rightWrist?: WristFrame['rightWrist'] } {
  const landmarker = getRunner<any>('mediapipe');
  if (!landmarker) {
    throw new Error('mediapipe runner not loaded — call modelLoader.loadAll() first');
  }
  // Effective timestamp: video time + monotonic offset (see mpOffset
  // above — keeps the singleton landmarker happy across runs).
  const result = landmarker.detectForVideo(video, monotonicTs(tsMs));
  if (!result || !result.landmarks || result.landmarks.length === 0) {
    return {};
  }
  const lms = result.landmarks[0];  // first (highest-confidence) pose
  const out: { leftWrist?: WristFrame['leftWrist']; rightWrist?: WristFrame['rightWrist'] } = {};
  const lw = lms[MP_LEFT_WRIST];
  if (lw && (lw.visibility ?? 0) >= VISIBILITY_THRESHOLD) {
    out.leftWrist = { x: lw.x, y: lw.y, visibility: lw.visibility };
  }
  const rw = lms[MP_RIGHT_WRIST];
  if (rw && (rw.visibility ?? 0) >= VISIBILITY_THRESHOLD) {
    out.rightWrist = { x: rw.x, y: rw.y, visibility: rw.visibility };
  }
  return out;
}

/**
 * Run pose detection across every sample in `samples`. Mutates `frames`
 * in-place: fills `rightWrist` / `leftWrist` slots for each entry.
 * Returns the same array (for chaining).
 *
 * Phase 3 uses mediapipe. Phase 4 will branch on `defaultBackend` and
 * additionally call rtmdet + rtmpose for higher-precision detection.
 */
export async function populateWristFrames(
  video: HTMLVideoElement,
  samples: { tsMs: number }[],
  frames: WristFrame[],
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<WristFrame[]> {
  if (!frames.length) return frames;
  const total = samples.length;
  for (let i = 0; i < samples.length; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const ts = samples[i].tsMs;
    const tsSec = ts / 1000;
    // mediapipe needs the video seeked to the exact frame; the seek path
    // is the bottleneck for Phase 3, not the model itself.
    video.currentTime = tsSec;
    await waitForSeeked(video);
    const wrist = detectPose(video, ts);
    frames[i].rightWrist = wrist.rightWrist;
    frames[i].leftWrist = wrist.leftWrist;
    if (onProgress && (i % 5 === 0 || i === total - 1)) onProgress(i + 1, total);
  }
  return frames;
}

/**
 * plan 008 M4 (perf) — single-pass live detection. Plays the video once
 * and runs detectForVideo() on every painted frame whose mediaTime has
 * passed the next sample target, so sampling + pose happen in ONE 1x
 * playback with zero seeks. The two-pass alternative (sample playback,
 * then seek-per-frame detection) capped at ~20 fps on long videos
 * because every seek re-decodes from the nearest keyframe through the
 * swing-media stream; the live pass runs at playback speed (~30 fps)
 * and cuts total pipeline wall-clock roughly in half.
 *
 * `targets` must be the sorted arithmetic sample timestamps (ms); slots
 * the playback never reaches (truncated tail) stay empty — the peak
 * picker interpolates through them.
 */
export async function populateWristFramesLive(
  video: HTMLVideoElement,
  targets: number[],
  frames: WristFrame[],
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<WristFrame[]> {
  const total = targets.length;
  if (!total) return frames;

  video.pause();
  video.muted = true;
  video.playsInline = true;
  // The runner hands us a freshly-loaded video already parked at 0 —
  // assigning currentTime=0 there fires NO seeked event in Chromium and
  // the await below would hang forever (seen as "Start does nothing").
  // Only seek when we're actually somewhere else.
  if (video.currentTime !== 0) {
    video.currentTime = 0;
    await waitForSeeked(video);
  }

  let next = 0;
  let cancelled = false;

  return new Promise<WristFrame[]>((resolve, reject) => {
    const cleanup = () => {
      try { video.pause(); } catch { /* ignore */ }
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const onError = () => { cleanup(); reject(new Error(`video error: ${video.error?.message}`)); };
    const onAbort = () => { cancelled = true; cleanup(); reject(new DOMException('aborted', 'AbortError')); };
    const onEnded = () => {
      // Playback finished — any unreached tail slots stay empty.
      cleanup();
      onProgress?.(total, total);
      resolve(frames);
    };
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort);

    const paint = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      if (cancelled) return;
      const ts = metadata.mediaTime * 1000;
      // One detection covers every sample target this painted frame
      // passed (playback hiccups can skip targets; reusing the pose is
      // far better than seeking backwards).
      if (next < total && ts >= targets[next] - 1) {
        const wrist = detectPose(video, ts);
        while (next < total && ts >= targets[next] - 1) {
          frames[next].rightWrist = wrist.rightWrist;
          frames[next].leftWrist = wrist.leftWrist;
          next++;
        }
        if (next % 5 === 0 || next === total) onProgress?.(next, total);
      }
      if (next >= total) {
        cleanup();
        onProgress?.(total, total);
        resolve(frames);
        return;
      }
      video.requestVideoFrameCallback(paint);
    };
    video.requestVideoFrameCallback(paint);
    video.play().catch((e) => { cleanup(); reject(e); });
  });
}

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    // Never hang: same-position assignments fire no `seeked` event, and
    // a stalled media element might not either — bail out after 3 s and
    // let the pipeline continue with whatever frame is on screen.
    const timer = setTimeout(() => { cleanup(); resolve(); }, 3000);
    const onSeeked = () => { cleanup(); resolve(); };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
    };
    video.addEventListener('seeked', onSeeked);
    // Not actually seeking (e.g. target == current position) → resolve
    // on the next microtask instead of waiting for an event that will
    // never come.
    queueMicrotask(() => {
      if (!video.seeking) { cleanup(); resolve(); }
    });
  });
}
