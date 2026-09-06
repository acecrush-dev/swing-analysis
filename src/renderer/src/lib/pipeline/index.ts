/**
 * Pipeline orchestrator — chains frames → pose → wrist tracking →
 * segments → viz. Public API: `runPipeline(video, opts)`.
 *
 * Each step is a separate module under ./pipeline/ so they can evolve
 * independently. The orchestrator wires them together, surfaces
 * progress, and owns the abort signal.
 *
 * Run order (plan 008 perf path — requestVideoFrameCallback available):
 *   1. populateWristFramesLive — ONE 1x playback pass: sampling and
 *      mediapipe detection per painted frame, zero seeks (~30 fps)
 * Fallback (no rVFC): sampleTimestamps playback, then seek-per-frame
 *   populateWristFrames.
 * Then for both:
 *   3. detectSegments — peak picking on the wrist-y series
 *   4. renderViz — optional, canvas captureStream + MediaRecorder
 *
 * Caller is expected to have called `modelLoader.loadAll()` first so
 * the mediapipe runner is available. We don't re-check here — failure
 * mode is a clean throw from `getRunner('mediapipe')`.
 */
import { sampleTimestamps, HAS_RVFC } from './frames';
import { populateWristFrames, populateWristFramesLive } from './pose';
import { detectSegments } from './tracking';
import { renderViz } from './viz';
import type { VizResult } from './viz';
import type { PipelineOptions, PipelineProgress, PipelineResult, SwingSegment, WristFrame } from './types';

export type { PipelineOptions, PipelineResult, PipelineProgress, SwingSegment, WristFrame } from './types';
export type { VizResult } from './viz';
export { sampleFrames, sampleTimestamps, emptyWristFrames } from './frames';
export { populateWristFrames, resetPoseTimestamp } from './pose';
export { detectSegments } from './tracking';
export { renderViz } from './viz';

export async function runPipeline(
  video: HTMLVideoElement,
  opts: PipelineOptions & { renderViz?: boolean },
): Promise<PipelineResult & { viz?: VizResult }> {
  const { fps, onProgress, signal } = opts;
  const intervalMs = 1000 / fps;
  const stride = Math.max(1, opts.stride ?? 1);
  const durationMs = video.duration * 1000;

  if (HAS_RVFC) {
    // ── plan 008 perf path: single live pass ──────────────────────────
    // Timestamps are arithmetic (no sampling playback needed); playback
    // + pose detection happen together in populateWristFramesLive at 1x
    // with zero seeks. The old two-pass flow (sample playback + a seek
    // per frame for detection) measured only ~20 fps on long videos;
    // the live pass runs at playback rate (~30 fps) and roughly halves
    // total wall-clock.
    let tss: number[] = [];
    for (let i = 0; i * intervalMs < durationMs; i += stride) {
      tss.push(i * intervalMs);
    }
    if (opts.maxFrames && opts.maxFrames > 0) tss = tss.slice(0, opts.maxFrames);
    const frames: WristFrame[] = tss.map((tsMs, i) => ({ tsMs, frameIdx: i }));
    onProgress?.({ current: 0, total: frames.length, phase: 'poses' });
    await populateWristFramesLive(video, tss, frames,
      (current, total) => onProgress?.({ current, total, phase: 'poses' }),
      signal,
    );
    return await finishRun(video, frames, opts, fps, onProgress, signal);
  }

  // ── fallback (no requestVideoFrameCallback): two-pass flow ─────────
  // 1. Sample timestamps (O(1) memory — no frame pixels kept; plan 008 M2).
  onProgress?.({ current: 0, total: 0, phase: 'frames' });
  let tss: number[] = await sampleTimestamps(video, {
    fps,
    stride,
    signal,
    onProgress: (current, total) => onProgress?.({ current, total, phase: 'frames' }),
  });
  // python `max_frames` — cap the sample list (0/undefined = unlimited).
  if (opts.maxFrames && opts.maxFrames > 0) {
    tss = tss.slice(0, opts.maxFrames);
  }

  // 2. Pose detection (per-frame mediapipe call).
  const frames: WristFrame[] = tss.map((tsMs, i) => ({ tsMs, frameIdx: i }));
  onProgress?.({ current: 0, total: frames.length, phase: 'poses' });
  await populateWristFrames(video, frames, frames,
    (current, total) => onProgress?.({ current, total, phase: 'poses' }),
    signal,
  );
  return await finishRun(video, frames, opts, fps, onProgress, signal);
}

/** Shared tail: peaks (+duration filters) → optional viz. */
async function finishRun(
  video: HTMLVideoElement,
  frames: WristFrame[],
  opts: PipelineOptions & { renderViz?: boolean },
  fps: number,
  onProgress?: (p: PipelineProgress) => void,
  signal?: AbortSignal,
): Promise<PipelineResult & { viz?: VizResult }> {

  // 3. Peak picking → segments, then python `min_dur`/`max_dur` filters.
  onProgress?.({ current: 0, total: 0, phase: 'peaks' });
  let segments = detectSegments(frames, opts);
  if (opts.minDurSec != null && opts.minDurSec > 0) {
    segments = segments.filter((s) => (s.endTsMs - s.startTsMs) / 1000 >= opts.minDurSec!);
  }
  if (opts.maxDurSec != null && opts.maxDurSec > 0) {
    segments = segments.filter((s) => (s.endTsMs - s.startTsMs) / 1000 <= opts.maxDurSec!);
  }
  // Hand segments to the caller before viz — the unified ts UI shows
  // segment cards while the (roughly real-time) viz render continues.
  opts.onSegments?.(segments);

  // 4. Optional viz render.
  let viz: VizResult | undefined;
  if (opts.renderViz) {
    onProgress?.({ current: 0, total: frames.length, phase: 'viz' });
    viz = await renderViz(video, frames, {
      fps,
      colors: opts.colors,
      signal,
      onProgress: (current, total) => onProgress?.({ current, total, phase: 'viz' }),
    });
  }

  return {
    segments,
    framesProcessed: frames.length,
    videoDurationMs: video.duration * 1000,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
    viz,
  };
}
