/**
 * Frame extraction — turn an HTMLVideoElement into a stream of snapshots.
 *
 * Approach: prefer the modern `requestVideoFrameCallback` Chromium API
 * (zero seek overhead, precise `mediaTime` per frame). Fall back to a
 * seek-and-draw loop on browsers without it (rare in Electron since
 * Chromium is the engine, but Firefox-on-Electron-forks have shown up
 * and the seek path is well-trodden).
 *
 * Why not ffmpeg.wasm here: the user's HTMLVideoElement is already in
 * memory and the codecs are native. Pulling in ffmpeg.wasm (~30 MB
 * download + ~10 s wasm init) just to demux MP4 we already have
 * decoded would be a regression.
 *
 * Output: Promise<Frame[]> — eager, not an async iterator. The pipeline
 * orchestrator wants the full frame list before it can pick peaks;
 * materialising it once up front is simpler than passing generators
 * through every downstream step.
 */
import type { WristFrame } from './types';

export interface FrameSample {
  tsMs: number;
  /** ImageBitmap suitable for transfer to a worker or to mediapipe. */
  bitmap: ImageBitmap;
}

export interface IterateOpts {
  fps: number;
  /** Capture every Nth frame; 1 = full rate, 2 = half rate, etc. */
  stride?: number;
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

const HAS_RVFC = typeof window !== 'undefined'
  && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

export async function sampleFrames(
  video: HTMLVideoElement,
  opts: IterateOpts,
): Promise<FrameSample[]> {
  if (HAS_RVFC) return sampleViaRvfc(video, opts);
  return sampleViaSeek(video, opts);
}

// ── requestVideoFrameCallback path ────────────────────────────────────────
//
// Plays the video at native rate, calling back per painted frame. We
// grab the frames whose `mediaTime` is within `intervalMs` of the
// target timestamp. The video runs at real-time, so a 30 s clip takes
// ~30 s wall-clock; we'd want a faster seek-based path for batch
// processing, but for a single tennis swing video the user won't notice.
// For batch processing we'd want ffmpeg.wasm demux → VideoDecoder —
// noted as Phase 4 work.

async function sampleViaRvfc(video: HTMLVideoElement, opts: IterateOpts): Promise<FrameSample[]> {
  await waitForMetadata(video);
  const fps = opts.fps;
  const intervalMs = 1000 / fps;
  const stride = Math.max(1, opts.stride ?? 1);
  const total = Math.ceil((video.duration * 1000) / intervalMs);

  const samples: FrameSample[] = [];
  const canvas = createOffscreen(video.videoWidth, video.videoHeight);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  let nextTarget = 0;  // next desired mediaTime (ms)
  let lastIdx = -1;
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
        ctx.drawImage(video, 0, 0);
        // transferToImageBitmap returns a fresh bitmap the receiver can
        // own; the canvas is reset after the call.
        samples.push({ tsMs: ts, bitmap: canvas.transferToImageBitmap() });
        nextTarget += intervalMs * stride;
        opts.onProgress?.(samples.length, total);
      }
      if (metadata.mediaTime >= video.duration - 0.01) {
        cleanup();
        resolve(samples);
        return;
      }
      video.requestVideoFrameCallback(tick);
    };
    video.requestVideoFrameCallback(tick);
    video.play().catch((e) => { cleanup(); reject(e); });
  });
}

// ── seek-and-draw fallback ──────────────────────────────────────────────
//
// Slower (one I/O per frame) but works in any browser. Used as a
// fallback so a future Firefox-on-Electron or similar doesn't break.

async function sampleViaSeek(video: HTMLVideoElement, opts: IterateOpts): Promise<FrameSample[]> {
  await waitForMetadata(video);
  const fps = opts.fps;
  const intervalMs = 1000 / fps;
  const stride = Math.max(1, opts.stride ?? 1);
  const total = Math.ceil((video.duration * 1000) / intervalMs);

  const samples: FrameSample[] = [];
  const canvas = createOffscreen(video.videoWidth, video.videoHeight);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  for (let i = 0; i < total; i += stride) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const tsSec = (i * intervalMs) / 1000;
    // Seek and wait for `seeked` event before drawing — drawing a
    // mid-seek video frame produces the OLD frame, not the new one.
    video.currentTime = tsSec;
    await waitForSeeked(video);
    ctx.drawImage(video, 0, 0);
    samples.push({ tsMs: i * intervalMs, bitmap: canvas.transferToImageBitmap() });
    opts.onProgress?.(samples.length, total);
  }
  return samples;
}

// ── helpers ─────────────────────────────────────────────────────────────
function createOffscreen(w: number, h: number): OffscreenCanvas {
  // Always OffscreenCanvas — supported in every Chromium build Electron
  // ships with. Fallback to a detached HTMLCanvasElement is unnecessary
  // for our target environment.
  return new OffscreenCanvas(w, h);
}

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
 * Convenience: turn a FrameSample list into a WristFrame[] skeleton
 * (all slots empty) so the rest of the pipeline can index by frame
 * without conditional checks. Pose detection fills the wrist slots
 * in-place.
 */
export function emptyWristFrames(samples: FrameSample[]): WristFrame[] {
  return samples.map((s, i) => ({
    tsMs: s.tsMs,
    frameIdx: i,
  }));
}
