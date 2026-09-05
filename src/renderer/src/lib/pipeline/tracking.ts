/**
 * Wrist tracking + peak picking — port of backend/core/segment_swing.py
 * to TypeScript.
 *
 * The Python pipeline collects (frame_idx, wrist_x, wrist_y) tuples, then:
 *   1. Smooth with an EMA (alpha=0.6 — heavier weight on recent frames
 *      so fast swings aren't averaged out)
 *   2. Compute a dynamic threshold = mean + factor * std
 *   3. Find local maxima above threshold with a minimum-gap constraint
 *      (debounces near-duplicate hits on a single swing)
 *
 * Output: array of peak indices into the *smoothed* array. Caller
 * expands each peak into a SwingSegment by padding with `clipHalfWidth`
 * frames on each side.
 *
 * Tennis-swing specifics: we track wrist **y** (not x), because the
 * vertical motion is what distinguishes a swing from a wave / reach.
 * y is in mediapipe normalised [0,1] where 0=top, 1=bottom — so a
 * peak in wrist position means wrist is at the BOTTOM of the frame
 * (preparation), while a swing happens as the wrist rises to contact
 * and falls again. We track the "rising phase" by inverting: swing
 * apex = wrist at top of frame (smallest y). The dynamic threshold
 * captures that automatically once we invert.
 */
import type { SwingSegment, WristFrame } from './types';

interface PeakOpts {
  /** Minimum number of frames between consecutive peaks. Default 15 (0.5s @ 30fps). */
  minGapFrames?: number;
  /** Peak must exceed mean + thresholdFactor * std. Default 1.2. */
  thresholdFactor?: number;
  /** EMA smoothing alpha. Higher = more weight on recent frames. Default 0.6. */
  alpha?: number;
  /** Frames on each side of a peak to include in the extracted clip. Default 30 (1s @ 30fps). */
  clipHalfWidth?: number;
}

/** Pick peaks on a 1-D wrist-y series. Returns smoothed peak indices. */
export function pickPeaks(
  series: (number | null | undefined)[],
  opts: PeakOpts = {},
): number[] {
  const { minGapFrames = 15, thresholdFactor = 1.2, alpha = 0.6 } = opts;
  // Coerce: null / undefined / NaN → null. Linear-interpolate nulls so
  // a single missed frame doesn't break smoothing.
  const filled = fillMissing(series);
  if (filled.length < 3) return [];

  // EMA smoothing
  const smoothed: number[] = [];
  let ema = filled[0];
  for (const v of filled) {
    ema = alpha * v + (1 - alpha) * ema;
    smoothed.push(ema);
  }

  // Dynamic threshold
  const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
  const variance = smoothed.reduce((a, b) => a + (b - mean) ** 2, 0) / smoothed.length;
  const std = Math.sqrt(variance);
  // Wrist y is inverted (mediapipe: 0 = top). So a swing apex has a LOW
  // value. We detect minima rather than maxima.
  const threshold = mean - thresholdFactor * std;

  const peaks: number[] = [];
  let lastPeakIdx = -minGapFrames - 1;
  for (let i = 1; i < smoothed.length - 1; i++) {
    if (
      smoothed[i] < threshold &&
      smoothed[i] < smoothed[i - 1] &&
      smoothed[i] < smoothed[i + 1] &&
      i - lastPeakIdx >= minGapFrames
    ) {
      peaks.push(i);
      lastPeakIdx = i;
    }
  }
  return peaks;
}

/** Expand peak indices into full SwingSegment objects using `frames` for timestamps. */
export function peaksToSegments(
  peakIndices: number[],
  frames: WristFrame[],
  opts: PeakOpts = {},
): SwingSegment[] {
  const { clipHalfWidth = 30 } = opts;
  const segments: SwingSegment[] = [];
  for (let i = 0; i < peakIndices.length; i++) {
    const peakIdx = peakIndices[i];
    const start = Math.max(0, peakIdx - clipHalfWidth);
    const end = Math.min(frames.length - 1, peakIdx + clipHalfWidth);
    if (!frames[peakIdx]) continue;
    // Confidence: average visibility of wrists within the clip window.
    // Higher = more reliable detection.
    let confSum = 0;
    let confN = 0;
    for (let j = start; j <= end; j++) {
      const f = frames[j];
      if (f.rightWrist) { confSum += f.rightWrist.visibility; confN++; }
      if (f.leftWrist)  { confSum += f.leftWrist.visibility;  confN++; }
    }
    const confidence = confN > 0 ? confSum / confN : 0;
    segments.push({
      id: i,
      startFrameIdx: start,
      peakFrameIdx: peakIdx,
      endFrameIdx: end,
      startTsMs: frames[start].tsMs,
      peakTsMs: frames[peakIdx].tsMs,
      endTsMs: frames[end].tsMs,
      confidence,
    });
  }
  return segments;
}

/**
 * Pick peaks + expand to segments in one call.
 * `wristKey` chooses which wrist to track: 'right' (default — most
 * right-handed players), 'left', or 'avg' (mean of both, present in
 * both wrisits). NaN entries (frames where the wrist wasn't visible)
 * are interpolated so a few dropped frames don't kill the smoothing.
 */
export function detectSegments(
  frames: WristFrame[],
  opts: PeakOpts & { wristKey?: 'right' | 'left' | 'avg' } = {},
): SwingSegment[] {
  const { wristKey = 'right', ...peakOpts } = opts;
  const series = frames.map((f) => {
    const w = wristKey === 'right' ? f.rightWrist :
              wristKey === 'left'  ? f.leftWrist  :
              (f.rightWrist && f.leftWrist
                ? { x: (f.rightWrist.x + f.leftWrist.x) / 2, y: (f.rightWrist.y + f.leftWrist.y) / 2, visibility: (f.rightWrist.visibility + f.leftWrist.visibility) / 2 }
                : f.rightWrist ?? f.leftWrist);
    return w?.y ?? null;
  });
  const peaks = pickPeaks(series, peakOpts);
  return peaksToSegments(peaks, frames, peakOpts);
}

// ── helpers ──────────────────────────────────────────────────────────────
function fillMissing(series: (number | null | undefined)[]): number[] {
  // Linear interpolate null/undefined/NaN between valid samples. Trims
  // leading/trailing nulls so pickPeaks() doesn't average over a
  // half-window of zeros at the start. Returns `number[]` (not nullable)
  // since by the time pickPeaks() runs we've already trimmed out the
  // bad edges.
  const out = series.map((v) => (v == null || Number.isNaN(v) ? null : v));
  let last: number | null = null;
  let lastIdx = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] != null) {
      if (last != null && i - lastIdx > 1) {
        const span = i - lastIdx;
        const delta = (out[i]! - last) / span;
        for (let j = 1; j < span; j++) {
          out[lastIdx + j] = last + delta * j;
        }
      }
      last = out[i]!;
      lastIdx = i;
    }
  }
  const firstValid = out.findIndex((v) => v != null);
  const lastValid = out.length - 1 - [...out].reverse().findIndex((v) => v != null);
  if (firstValid === -1) return [];
  return (out.slice(firstValid, lastValid === -1 ? out.length : lastValid + 1) as number[]);
}
