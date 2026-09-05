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
  const result = landmarker.detectForVideo(video, tsMs);
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

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
  });
}
