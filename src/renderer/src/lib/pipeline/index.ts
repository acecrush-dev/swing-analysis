/**
 * Pipeline orchestrator — chains frames → pose → wrist tracking →
 * segments → viz. Public API: `runPipeline(video, opts)`.
 *
 * Each step is a separate module under ./pipeline/ so they can evolve
 * independently. The orchestrator wires them together, surfaces
 * progress, and owns the abort signal.
 *
 * Run order:
 *   1. sampleFrames — extract ImageBitmaps at target fps
 *   2. populateWristFrames — mediapipe PoseLandmarker on each frame
 *   3. detectSegments — peak picking on the wrist-y series
 *   4. renderViz — optional, canvas + MediaRecorder overlay video
 *
 * Caller is expected to have called `modelLoader.loadAll()` first so
 * the mediapipe runner is available. We don't re-check here — failure
 * mode is a clean throw from `getRunner('mediapipe')`.
 */
import { sampleFrames, type FrameSample } from './frames';
import { populateWristFrames } from './pose';
import { detectSegments } from './tracking';
import { renderViz } from './viz';
import type { VizResult } from './viz';
import type { PipelineOptions, PipelineResult, SwingSegment, WristFrame } from './types';

export type { PipelineOptions, PipelineResult, PipelineProgress, SwingSegment, WristFrame } from './types';
export type { VizResult } from './viz';
export { sampleFrames, populateWristFrames, detectSegments, renderViz };

export async function runPipeline(
  video: HTMLVideoElement,
  opts: PipelineOptions & { renderViz?: boolean },
): Promise<PipelineResult & { viz?: VizResult }> {
  const { fps, onProgress, signal } = opts;

  // 1. Extract frames.
  onProgress?.({ current: 0, total: 0, phase: 'frames' });
  const samples: FrameSample[] = await sampleFrames(video, {
    fps,
    stride: opts.stride,
    signal,
    onProgress: (current, total) => onProgress?.({ current, total, phase: 'frames' }),
  });

  // 2. Pose detection (per-frame mediapipe call).
  const frames: WristFrame[] = samples.map((s, i) => ({ tsMs: s.tsMs, frameIdx: i }));
  onProgress?.({ current: 0, total: samples.length, phase: 'poses' });
  await populateWristFrames(video, samples, frames,
    (current, total) => onProgress?.({ current, total, phase: 'poses' }),
    signal,
  );

  // 3. Peak picking → segments.
  onProgress?.({ current: 0, total: 0, phase: 'peaks' });
  const segments = detectSegments(frames, opts);

  // 4. Optional viz render.
  let viz: VizResult | undefined;
  if (opts.renderViz) {
    onProgress?.({ current: 0, total: frames.length, phase: 'viz' });
    viz = await renderViz(video, frames, {
      fps,
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
