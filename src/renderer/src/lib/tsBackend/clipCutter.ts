/**
 * ts-mode clip cutter — real per-segment mp4 extraction (plan 008 M4).
 *
 * Strategy: the source file is fetched ONCE into ffmpeg.wasm's MEMFS
 * (input.ts.mp4), then each segment is cut with an input-level seek
 * (`-ss` before `-i` → fast keyframe seek) and re-encoded to H.264:
 *
 *   -ss <start> -i input.ts.mp4 -t <dur> -c:v libx264 -preset veryfast
 *   -crf 23 -pix_fmt yuv420p -movflags +faststart -an clip_NNN.mp4
 *
 * Each clip becomes a Blob + object URL (playable in the main window)
 * plus a JPEG data: URL thumbnail grabbed from the clip midpoint
 * (data: URLs survive the trip to the detached clips panel window —
 * blob: URLs don't, because that window is a separate file:// document
 * with an opaque origin).
 *
 * Memory guard rails:
 *   - Source >1.5 GiB never enters MEMFS — every segment degrades to a
 *     non-playable card (seek-the-original-video path) and the caller is
 *     notified via onSkipLarge; segments.json and viz are unaffected.
 *   - Each finished clip is read out and deleted from MEMFS immediately,
 *     so peak MEMFS ≈ source + one clip.
 *   - `-an`: python-side clips have no audio track either — parity.
 */
import { ensureFfmpeg } from '../pipeline/viz';
import { mediaUrl } from '../mediaUrl';
import type { Segment, ClipInfo } from '../../api/types';

/** MEMFS guard: sources above this never enter ffmpeg's heap. */
export const MEMFS_GUARD_BYTES = 1.5 * 1024 * 1024 * 1024;

export interface CutClipsOptions {
  fps: number;
  signal?: AbortSignal;
  onClip: (info: ClipInfo) => void;
  /** Called once when the source exceeds the MEMFS guard and all clips
   *  are degraded to non-playable cards. */
  onSkipLarge?: () => void;
}

/** "MM:SS.mmm" / "H:MM:SS.mmm" → seconds (matches our wire timecodes). */
function tcToSec(tc: string): number {
  const parts = tc.split(':');
  const s = Number(parts[parts.length - 1].split('.')[0] + '.' + (parts[parts.length - 1].split('.')[1] ?? '0'));
  const m = Number(parts[parts.length - 2] ?? 0);
  const h = Number(parts[parts.length - 3] ?? 0);
  return h * 3600 + m * 60 + s;
}

export async function cutClips(
  videoPath: string,
  segments: Segment[],
  opts: CutClipsOptions,
): Promise<void> {
  const { signal } = opts;

  // 0. Size guard — HEAD probe via swing-media (Content-Length only).
  let sizeBytes = 0;
  try {
    const h = await fetch(mediaUrl(videoPath), { method: 'HEAD' });
    sizeBytes = Number(h.headers.get('content-length') ?? '0');
  } catch {
    sizeBytes = 0; // unknown → proceed; the full-body fetch below will fail loudly if truly oversized
  }
  if (sizeBytes > MEMFS_GUARD_BYTES) {
    opts.onSkipLarge?.();
    for (const seg of segments) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      opts.onClip({
        seg_id: seg.seg_id, exists: true, size_bytes: 0,
        playable: false, annotated: false, thumb_ready: false,
      });
    }
    return;
  }

  // 1. Load the source into MEMFS once; reuse for every segment.
  const ffmpeg = await ensureFfmpeg();
  const res = await fetch(mediaUrl(videoPath));
  if (!res.ok) throw new Error(`fetch source failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  await ffmpeg.writeFile('input.ts.mp4', buf);

  try {
    for (const seg of segments) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const name = `clip_${String(seg.seg_id).padStart(3, '0')}.mp4`;
      try {
        const startSec = tcToSec(seg.start_timecode);
        const durSec = Math.max(0.05, seg.duration_sec);
        await ffmpeg.exec([
          '-ss', startSec.toFixed(3),
          '-i', 'input.ts.mp4',
          '-t', durSec.toFixed(3),
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '23',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-an',
          name,
        ]);
        const data = await ffmpeg.readFile(name);
        // Materialise a fresh ArrayBuffer-backed view for Blob (TS strict
        // rejects SharedArrayBuffer-backed views; ffmpeg may return a
        // string for non-binary paths).
        const raw = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
        const bytes = new Uint8Array(raw.byteLength);
        bytes.set(raw);
        const blob = new Blob([bytes], { type: 'video/mp4' });
        const url = URL.createObjectURL(blob);
        const thumbUrl = await makeThumb(url, seg).catch(() => null);
        try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
        opts.onClip({
          seg_id: seg.seg_id,
          exists: true,
          size_bytes: blob.size,
          playable: true,
          annotated: false,
          thumb_ready: !!thumbUrl,
          url,
          thumbUrl: thumbUrl ?? undefined,
        });
      } catch (e: any) {
        if (signal?.aborted || e?.name === 'AbortError') {
          throw new DOMException('aborted', 'AbortError');
        }
        // Single-segment failure degrades that card; the batch continues.
        try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
        opts.onClip({
          seg_id: seg.seg_id, exists: true, size_bytes: 0,
          playable: false, annotated: false, thumb_ready: false,
        });
      }
    }
  } finally {
    try { await ffmpeg.deleteFile('input.ts.mp4'); } catch { /* ignore */ }
  }
}

/**
 * Grab a JPEG data: URL thumbnail at the clip's midpoint. Best-effort —
 * any failure resolves null and the card simply ships without a thumb.
 */
function makeThumb(clipUrl: string, seg: Segment, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    let settled = false;
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('loadeddata', onLoaded);
      v.removeEventListener('error', fail);
      v.src = '';
      v.remove();
      resolve(val);
    };
    const fail = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onLoaded = () => {
      const mid = Math.max(0, (tcToSec(seg.start_timecode) + seg.duration_sec / 2) / 2);
      // midpoint of the CLIP itself (it starts at 0)
      v.currentTime = Math.max(0, Math.min(mid, (v.duration || seg.duration_sec) - 0.05));
    };
    const onSeeked = () => {
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth || 320;
        c.height = v.videoHeight || 180;
        const ctx = c.getContext('2d');
        if (!ctx) return finish(null);
        ctx.drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL('image/jpeg', 0.85));
      } catch {
        finish(null);
      }
    };
    v.addEventListener('loadeddata', onLoaded);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', fail);
    v.src = clipUrl;
  });
}
