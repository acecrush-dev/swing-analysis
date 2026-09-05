/**
 * Video output — render the original video with skeleton overlay to a
 * real `.mp4` the user can open in QuickTime / VLC / iOS.
 *
 * Pipeline:
 *   1. Draw each sampled frame + skeleton overlay to an OffscreenCanvas
 *   2. canvas.convertToBlob({ type: 'image/png' }) → writeFile into
 *      ffmpeg's MEMFS as `frame_NNNNN.png`
 *   3. ffmpeg `-framerate {fps} -i frame_%05d.png -c:v libx264 -pix_fmt
 *      yuv420p out.mp4` reads the PNGs and writes H.264 mp4
 *   4. readFile('out.mp4') → Blob → user downloads
 *
 * Why ffmpeg.wasm and not MediaRecorder:
 *   - MediaRecorder produces webm in older Chromium and only mp4 on
 *     Chromium 120+. The user wants mp4 unconditionally.
 *   - ffmpeg.wasm gives us real H.264 yuv420p (QuickTime / iOS compat)
 *     with predictable output regardless of Chromium version.
 *   - Cost: ~31 MB wasm download + ~3-10 s init. Worth it for "save
 *     .mp4" UX.
 *
 * Loading: the @ffmpeg/core wasm + js are copied to
 * public/assets/ffmpeg/ at install time (via the build orchestrator) so
 * Vite serves them at /assets/ffmpeg/. We pass those URLs to ffmpeg.load().
 * That avoids CDN dependency (works offline once Electron has the files).
 *
 * Single-FFmpeg instance: ffmpeg.wasm's MEMFS is reset on `terminate()`.
 * For a single render we just load once, write frames, exec, read,
 * done. If we ever need to render multiple videos in parallel, switch
 * to a per-render instance.
 */
import type { WristFrame } from './types';

export interface VizOpts {
  fps: number;
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

async function ensureFfmpeg(): Promise<any> {
  if (_ffmpeg) return _ffmpeg;
  // Concurrent loadAll() calls (e.g. user clicks "Run + viz" twice)
  // would each spawn their own ffmpeg.wasm load. Coalesce via a
  // shared promise so only one load runs.
  if (!_loading) {
    _loading = (async () => {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const inst = new FFmpeg();
      await inst.load({
        coreURL:  new URL('/assets/ffmpeg/ffmpeg-core.js',  window.location.href).toString(),
        wasmURL:  new URL('/assets/ffmpeg/ffmpeg-core.wasm', window.location.href).toString(),
      });
      _ffmpeg = inst;
    })();
  }
  await _loading;
  return _ffmpeg;
}

export async function renderViz(
  video: HTMLVideoElement,
  frames: SkeletonFrame[],
  opts: VizOpts,
): Promise<VizResult> {
  const { fps, signal } = opts;
  const ffmpeg = await ensureFfmpeg();
  const W = video.videoWidth;
  const H = video.videoHeight;

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');

  const t0 = performance.now();

  // 1. Write every frame as a PNG into ffmpeg's MEMFS.
  for (let i = 0; i < frames.length; i++) {
    if (signal?.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    const f = frames[i];
    const tsSec = f.tsMs / 1000;
    video.currentTime = tsSec;
    await waitForSeeked(video);
    ctx.drawImage(video, 0, 0, W, H);
    drawSkeleton(ctx, video, f, W, H);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const name = `frame_${String(i + 1).padStart(5, '0')}.png`;
    await ffmpeg.writeFile(name, buf);
    opts.onProgress?.(i + 1, frames.length);
  }

  // 2. Encode H.264 mp4.
  //
  // - `-framerate` is the input rate (the rate our PNGs represent)
  // - `-c:v libx264` + `-pix_fmt yuv420p` gives QuickTime/iOS compat
  // - `-preset ultrafast` trades size for speed; we have one render so
  //   we don't care about size
  // - `-movflags +faststart` puts the moov atom at the front so the
  //   browser can start playing before the download finishes
  await ffmpeg.exec([
    '-framerate', String(fps),
    '-i', 'frame_%05d.png',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-movflags', '+faststart',
    'out.mp4',
  ]);

  // 3. Read out the mp4.
  const data = await ffmpeg.readFile('out.mp4');
  // ffmpeg.wasm 0.12 returns `Uint8Array | string` depending on path;
  // always materialise a fresh ArrayBuffer-backed view so Blob is happy
  // with TS strict mode (which rejects SharedArrayBuffer-backed views).
  const raw = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  const bytes = new Uint8Array(raw.byteLength);
  bytes.set(raw);

  // 4. Cleanup MEMFS so the next render starts clean.
  // ffmpeg.wasm's MEMFS accumulates across runs unless we deleteFile.
  for (let i = 0; i < frames.length; i++) {
    const name = `frame_${String(i + 1).padStart(5, '0')}.png`;
    try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
  }
  try { await ffmpeg.deleteFile('out.mp4'); } catch { /* ignore */ }

  return {
    blob: new Blob([bytes], { type: 'video/mp4' }),
    mimeType: 'video/mp4',
    extension: 'mp4',
    durationMs: performance.now() - t0,
  };
}

// ── skeleton drawing ──────────────────────────────────────────────────
//
// Phase 3 ships wrist-circles only (we don't cache all 33 mediapipe
// landmarks yet — see tracking.ts). Full-skeleton render path is wired
// and will activate when hasFullLandmarks() flips to true (Phase 4).

const ARM_SKELETON: Array<[number, number]> = [
  [12, 14], [14, 16],   // right arm
  [11, 13], [13, 15],   // left arm
  [12, 24], [11, 23],   // torso
  [23, 24],             // hips
];
const KEYPOINT_INDICES = [11, 12, 13, 14, 15, 16, 23, 24];

function drawSkeleton(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  video: HTMLVideoElement,
  frame: SkeletonFrame,
  W: number,
  H: number,
): void {
  const fullLandmarks = hasFullLandmarks(frame);

  if (!fullLandmarks) {
    // Wrist-only highlight — gives the user something to verify against.
    if (frame.rightWrist) {
      drawWristCircle(ctx, frame.rightWrist.x, frame.rightWrist.y, W, H, '#5dd28a');
    }
    if (frame.leftWrist) {
      drawWristCircle(ctx, frame.leftWrist.x, frame.leftWrist.y, W, H, '#f0b85c');
    }
    return;
  }

  // Full-skeleton path — kicks in once pose.ts caches all 33 mediapipe
  // landmarks (Phase 4).
  const anyFrame = frame as any;
  ctx.strokeStyle = '#5dd28a';
  ctx.lineWidth = 3;
  for (const [a, b] of ARM_SKELETON) {
    const la = anyFrame[a];
    const lb = anyFrame[b];
    if (!la || !lb) continue;
    ctx.beginPath();
    ctx.moveTo(la.x * W, la.y * H);
    ctx.lineTo(lb.x * W, lb.y * H);
    ctx.stroke();
  }
  ctx.fillStyle = '#5dd28a';
  for (const i of KEYPOINT_INDICES) {
    const k = anyFrame[i];
    if (!k) continue;
    ctx.beginPath();
    ctx.arc(k.x * W, k.y * H, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWristCircle(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
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

function hasFullLandmarks(_frame: SkeletonFrame): boolean {
  return false;  // Phase 4: flip once pose.ts caches all 33 landmarks.
}

function waitForSeeked(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
  });
}
