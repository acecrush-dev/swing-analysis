/**
 * Video output — render the original video with wrist overlay to a
 * downloadable clip.
 *
 * plan 008 M4 — streaming rewrite. The pre-008 implementation seeked to
 * every sampled frame, PNG-encoded it into ffmpeg.wasm's MEMFS, then
 * transcoded the whole PNG sequence — memory grew O(video length) and
 * long videos (>~60s) OOM'd the wasm heap. The rewrite plays the video
 * once at 1x into a canvas and pipes canvas.captureStream() through
 * MediaRecorder, so memory stays bounded regardless of duration:
 *
 *   1. <canvas> at video resolution + captureStream(fps)
 *   2. MediaRecorder, mime negotiated: mp4/avc1 → mp4 → webm/vp9 → webm
 *      (Electron 44's Chromium muxes mp4; webm is the fallback and the
 *      VizResult.extension follows what actually came out)
 *   3. requestVideoFrameCallback per painted frame: drawImage(video) +
 *      wrist circles from the nearest sampled pose frame (binary search)
 *   4. on ended/abort → recorder.stop() → Blob
 *
 * ffmpeg.wasm is no longer used HERE, but ensureFfmpeg() stays exported
 * — the ts clip cutter (tsBackend/clipCutter.ts) shares the instance.
 *
 * Loading: the @ffmpeg/core wasm + js live in public/assets/ffmpeg/ so
 * Vite serves them at /assets/ffmpeg/ (offline-safe, no CDN).
 */
import type { WristFrame } from './types';

export interface VizOpts {
  fps: number;
  /** Wrist dot colours (plan 008 — wired from Settings via paramsMap). */
  colors?: { right?: string; left?: string };
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

export interface VizResult {
  blob: Blob;
  mimeType: string;
  extension: 'mp4' | 'webm';
  durationMs: number;
}

interface SkeletonFrame {
  frameIdx: number;
  tsMs: number;
  rightWrist?: WristFrame['rightWrist'];
  leftWrist?: WristFrame['leftWrist'];
}

let _ffmpeg: any | null = null;
let _loading: Promise<void> | null = null;

/** Shared, lazily-loaded ffmpeg.wasm instance (also used by clipCutter). */
export async function ensureFfmpeg(): Promise<any> {
  if (_ffmpeg) return _ffmpeg;
  // Concurrent loadAll() calls (e.g. user clicks "Run + viz" twice)
  // would each spawn their own ffmpeg.wasm load. Coalesce via a
  // shared promise so only one load runs.
  if (!_loading) {
    _loading = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const { toBlobURL } = await import('@ffmpeg/util');
      // Resolve the core files against document.baseURI — NEVER
      // root-absolute. The packaged app loads its renderer via file://
      // where '/assets/...' would resolve to the filesystem root and
      // fail (same bug class as modelLoader's, plan 008 M1). Then
      // pre-convert to blob: URLs in the MAIN thread: the ffmpeg worker
      // cannot fetch file:// URLs itself, but blob: URLs always work.
      const coreJsUrl = new URL('assets/ffmpeg/ffmpeg-core.js', document.baseURI).toString();
      const coreWasmUrl = new URL('assets/ffmpeg/ffmpeg-core.wasm', document.baseURI).toString();
      const inst = new FFmpeg();
      await inst.load({
        coreURL: await toBlobURL(coreJsUrl, 'text/javascript'),
        wasmURL: await toBlobURL(coreWasmUrl, 'application/wasm'),
      });
      _ffmpeg = inst;
    })();
  }
  await _loading;
  return _ffmpeg;
}

function pickRecorderMime(): string {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm',
  ];
  for (const c of candidates) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    } catch { /* keep looking */ }
  }
  return '';
}

export async function renderViz(
  video: HTMLVideoElement,
  frames: SkeletonFrame[],
  opts: VizOpts,
): Promise<VizResult> {
  const { fps, signal } = opts;
  const W = video.videoWidth;
  const H = video.videoHeight;
  const t0 = performance.now();

  const mime = pickRecorderMime();
  if (!mime) throw new Error('MediaRecorder unavailable in this environment');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2d context unavailable');

  const rightColor = opts.colors?.right ?? '#5dd28a';
  const leftColor = opts.colors?.left ?? '#f0b85c';

  // Nearest sampled frame (by timestamp) for a given media time — the
  // sample list is sorted, so a binary search per painted frame is cheap.
  const nearestFrame = (tsMs: number): SkeletonFrame | null => {
    if (frames.length === 0) return null;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (frames[mid].tsMs < tsMs) lo = mid + 1;
      else hi = mid;
    }
    const a = frames[lo];
    const b = frames[Math.max(0, lo - 1)];
    return (Math.abs(a.tsMs - tsMs) <= Math.abs(b.tsMs - tsMs) ? a : b);
  };

  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 8_000_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  // Seek to the very start so the overlay starts at t=0.
  video.pause();
  video.currentTime = 0;
  await waitForSeeked(video);
  video.muted = true;
  video.playsInline = true;

  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  const stopEverything = () => {
    try { video.pause(); } catch { /* ignore */ }
    if (recorder.state !== 'inactive') recorder.stop();
    stream.getTracks().forEach((t) => t.stop());
  };
  const onAbort = () => stopEverything();
  signal?.addEventListener('abort', onAbort);

  const totalProgress = Math.max(1, frames.length);
  const onEnded = () => stopEverything();
  video.addEventListener('ended', onEnded);

  recorder.start(250);
  const paint = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => {
    if (signal?.aborted || recorder.state === 'inactive') return;
    ctx.drawImage(video, 0, 0, W, H);
    const f = nearestFrame(metadata.mediaTime * 1000);
    if (f) {
      if (f.rightWrist) drawWristCircle(ctx, f.rightWrist.x, f.rightWrist.y, W, H, rightColor);
      if (f.leftWrist) drawWristCircle(ctx, f.leftWrist.x, f.leftWrist.y, W, H, leftColor);
    }
    const frac = video.duration > 0 ? video.currentTime / video.duration : 0;
    opts.onProgress?.(Math.round(frac * totalProgress), totalProgress);
    if (HAS_RVFC) video.requestVideoFrameCallback(paint);
  };

  if (HAS_RVFC) video.requestVideoFrameCallback(paint);
  else {
    // No rVFC (non-Chromium fallback): rAF + manual draw.
    const loop = () => {
      if (signal?.aborted || recorder.state === 'inactive') return;
      ctx.drawImage(video, 0, 0, W, H);
      const f = nearestFrame(video.currentTime * 1000);
      if (f) {
        if (f.rightWrist) drawWristCircle(ctx, f.rightWrist.x, f.rightWrist.y, W, H, rightColor);
        if (f.leftWrist) drawWristCircle(ctx, f.leftWrist.x, f.leftWrist.y, W, H, leftColor);
      }
      const frac = video.duration > 0 ? video.currentTime / video.duration : 0;
      opts.onProgress?.(Math.round(frac * totalProgress), totalProgress);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  try {
    await video.play();
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    video.removeEventListener('ended', onEnded);
    throw e;
  }

  // Resolved by recorder.stop() — fired by video 'ended' or abort.
  await done;
  signal?.removeEventListener('abort', onAbort);
  video.removeEventListener('ended', onEnded);

  if (signal?.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }

  const outType = mime.split(';')[0];
  const blob = new Blob(chunks, { type: outType });
  const extension: 'mp4' | 'webm' = outType.includes('mp4') ? 'mp4' : 'webm';
  return {
    blob,
    mimeType: outType,
    extension,
    durationMs: performance.now() - t0,
  };
}

const HAS_RVFC = typeof window !== 'undefined'
  && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

function drawWristCircle(
  ctx: CanvasRenderingContext2D,
  nx: number, ny: number, W: number, H: number, color: string,
): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#0a0e1a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(nx * W, ny * H, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    // If no seek is actually needed (already at 0, not seeking), resolve
    // on the next microtask instead of hanging forever.
    queueMicrotask(() => {
      if (!video.seeking) { video.removeEventListener('seeked', onSeeked); resolve(); }
    });
  });
}
