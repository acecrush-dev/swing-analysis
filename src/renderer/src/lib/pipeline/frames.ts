/**
 * Frame sampling — turn an HTMLVideoElement into a list of timestamps.
 *
 * plan 008 M2: this module no longer extracts ImageBitmaps. The bitmaps
 * had NO downstream consumer — pose.ts detects directly on the video
 * element and viz.ts re-seeks and draws itself — so holding every sampled
 * frame as a bitmap made memory grow O(video length) and OOM'd long
 * videos. Collecting timestamps only is O(1) memory regardless of
 * duration.
 *
 * Approach: prefer the modern `requestVideoFrameCallback` Chromium API
 * (zero seek overhead, precise `mediaTime` per frame). Fall back to a
 * seek loop on browsers without it (rare in Electron since Chromium is
 * the engine, but Firefox-on-Electron-forks have shown up and the seek
 * path is well-trodden).
 *
 * Why not ffmpeg.wasm here: the user's HTMLVideoElement is already in
 * memory and the codecs are native. Pulling in ffmpeg.wasm (~30 MB
 * download + ~10 s wasm init) just to demux MP4 we already have decoded
 * would be a regression.
 */
import type { WristFrame } from './types';

/**
 * Compat shape — plan 008 stripped the `bitmap` field (nothing ever
 * consumed it). Anything that only needs the timestamp keeps compiling.
 */
export interface FrameSample {
  tsMs: number;
}

export interface IterateOpts {
  fps: number;
  /** Capture every Nth frame; 1 = full rate, 2 = half rate, etc. */
  stride?: number;
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

export const HAS_RVFC = typeof window !== 'undefined'
  && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

/**
 * Core: sample the video and return the sampled timestamps (ms from
 * video start). Memory O(1) — only numbers, no frame pixels.
 */
export async function sampleTimestamps(
  video: HTMLVideoElement,
  opts: IterateOpts,
): Promise<number[]> {
  if (HAS_RVFC) return sampleViaRvfc(video, opts);
  return sampleViaSeek(video, opts);
}

/** Compat alias for the pre-008 API: timestamps wrapped as FrameSamples. */
export async function sampleFrames(
  video: HTMLVideoElement,
  opts: IterateOpts,
): Promise<FrameSample[]> {
  const tss = await sampleTimestamps(video, opts);
  return tss.map((tsMs) => ({ tsMs }));
}

// ── requestVideoFrameCallback path ────────────────────────────────────────
//
// Plays the video at native rate, calling back per painted frame. We
// record the first frame whose `mediaTime` passes each target timestamp.
// The video runs at real-time, so a 30 s clip takes ~30 s wall-clock —
// a known limitation (see plan 008 Out: WebCodecs fast path is future
// work); `stride` gives users a speed lever in the meantime.

async function sampleViaRvfc(video: HTMLVideoElement, opts: IterateOpts): Promise<number[]> {
  await waitForMetadata(video);
  const fps = opts.fps;
  const intervalMs = 1000 / fps;
  const stride = Math.max(1, opts.stride ?? 1);
  const total = Math.ceil((video.duration * 1000) / intervalMs);

  const tss: number[] = [];
  let nextTarget = 0;  // next desired mediaTime (ms)
  let cancelled = false;

  video.muted = true;  // autoplay needs muted in some envs
  video.playsInline = true;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.pause();
      video.removeEventListener('error', onError);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const onError = () => { cleanup(); reject(new Error(`video error: ${video.error?.message}`)); };
    const onAbort = () => { cancelled = true; cleanup(); reject(new DOMException('aborted', 'AbortError')); };
    video.addEventListener('error', onError);
    opts.signal?.addEventListener('abort', onAbort);

    const tick = (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
      if (cancelled) return;
      const ts = metadata.mediaTime * 1000;
      if (ts >= nextTarget) {
        tss.push(ts);
        nextTarget += intervalMs * stride;
        opts.onProgress?.(tss.length, total);
      }
      if (metadata.mediaTime >= video.duration - 0.01) {
        cleanup();
        resolve(tss);
        return;
      }
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    video.play().catch((e) => { cleanup(); reject(e); });
  });
}

// ── seek fallback ────────────────────────────────────────────────────────
//
// Slower (one seek per frame) but works in any browser. No drawing —
// seeks alone give us the timestamps.

async function sampleViaSeek(video: HTMLVideoElement, opts: IterateOpts): Promise<number[]> {
  await waitForMetadata(video);
  const fps = opts.fps;
  const intervalMs = 1000 / fps;
  const stride = Math.max(1, opts.stride ?? 1);
  const total = Math.ceil((video.duration * 1000) / intervalMs);

  const tss: number[] = [];
  for (let i = 0; i < total; i += stride) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const tsMs = i * intervalMs;
    // Seek and wait for `seeked` — the pose stage needs the video
    // settled on the frame before detectForVideo() runs on it.
    video.currentTime = tsMs / 1000;
    await waitForSeeked(video);
    tss.push(tsMs);
    opts.onProgress?.(tss.length, total);
  }
  return tss;
}

// ── helpers ─────────────────────────────────────────────────────────────
function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLoaded = () => { video.removeEventListener('loadedmetadata', onLoaded); resolve(); };
    const onError = () => { video.removeEventListener('error', onError); reject(new Error('video load failed')); };
    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
  });
}

/**
 * Convenience: turn a sample list into a WristFrame[] skeleton (all
 * slots empty) so the rest of the pipeline can index by frame without
 * conditional checks. Pose detection fills the wrist slots in-place.
 */
export function emptyWristFrames(samples: FrameSample[]): WristFrame[] {
  return samples.map((s, i) => ({
    tsMs: s.tsMs,
    frameIdx: i,
  }));
}
