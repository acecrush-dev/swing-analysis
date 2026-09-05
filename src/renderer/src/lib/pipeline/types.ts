/**
 * Common types for the in-renderer swing-analysis pipeline (TS backend mode).
 *
 * Mirrors the data shapes the Python pipeline produces — wrist coordinates
 * in normalised [0,1] image-space, peak indices in the sampled frame
 * timeline, segments as (start, peak, end) frame triples. Anything that
 * has to round-trip back to user-visible UI goes through here so we
 * don't end up with three slightly-different shapes for the same concept.
 */

export interface WristFrame {
  /** Sampled-frame timestamp in milliseconds from the start of the video. */
  tsMs: number;
  /** Index into the sampled frame list (== tsMs / frameIntervalMs). */
  frameIdx: number;
  /** Right wrist in normalized [0,1] coords, with confidence. Absent if mediapipe returned no pose / low visibility. */
  rightWrist?: { x: number; y: number; visibility: number };
  /** Left wrist (mirror of right). Many right-handed tennis players' swings
   *  are best tracked via the right wrist; the left is kept around for
   *  handedness detection later. */
  leftWrist?: { x: number; y: number; visibility: number };
}

export interface SwingSegment {
  /** 0-based segment id within this run. */
  id: number;
  /** Frame index where the swing starts (wrist begins moving up). */
  startFrameIdx: number;
  /** Frame index at peak wrist position (top of swing). */
  peakFrameIdx: number;
  /** Frame index where the swing ends (wrist back down). */
  endFrameIdx: number;
  /** ms equivalents — convenient for seekInto() on the <video> element. */
  startTsMs: number;
  peakTsMs: number;
  endTsMs: number;
  /** 0–1 confidence the swing is real (vs noise). Currently a placeholder. */
  confidence: number;
}

export interface PipelineProgress {
  current: number;
  total: number;
  phase: 'frames' | 'poses' | 'peaks' | 'viz';
}

export interface PipelineOptions {
  /** Target frames-per-second to sample from the input video. */
  fps: number;
  /** Min frames between consecutive peaks (debounces near-duplicates). */
  minGapFrames?: number;
  /** Threshold multiplier: peak must exceed mean + factor * std. */
  thresholdFactor?: number;
  /** Half-width of the extracted clip around the peak (frames on each side). */
  clipHalfWidth?: number;
  /** Frames skipped between samples (1 = every frame; 2 = every other; useful
   *  for fast previews on long videos). */
  stride?: number;
  onProgress?: (p: PipelineProgress) => void;
  signal?: AbortSignal;
}

export interface PipelineResult {
  segments: SwingSegment[];
  framesProcessed: number;
  videoDurationMs: number;
  videoWidth: number;
  videoHeight: number;
}
