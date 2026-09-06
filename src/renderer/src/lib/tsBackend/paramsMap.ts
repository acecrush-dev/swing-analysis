/**
 * JobParams → PipelineOptions mapping (plan 008 M2).
 *
 * The unified main UI edits one JobParams shape (mirrors the python
 * sidecar's schema); the ts pipeline consumes PipelineOptions. This
 * module is the single place where the two vocabularies meet.
 *
 * Mapping table (plan 008 §4.11):
 *
 *   | JobParams            | ts mapping                       | note                       |
 *   |----------------------|----------------------------------|----------------------------|
 *   | (fixed 30)           | fps                              | ts has no source-fps probe |
 *   | skip                 | stride                           | 1 = every sampled frame    |
 *   | max_frames           | maxFrames                        | 0 = unlimited              |
 *   | smooth_alpha         | alpha (EMA)                      | same semantics             |
 *   | gap_merge (s)        | minGapFrames = round(gap*fps)    | peak debounce distance     |
 *   | min_dur / max_dur    | minDurSec / maxDurSec            | segment duration filter    |
 *   | buf_before/after (s) | bufBefore/AfterFrames = round*fps| segment padding            |
 *   | v_swing / max_bridge / max_lost_frames / min_peak | —  | no ts equivalent yet;
 *     the ts peak picker uses its own thresholdFactor (1.2). The UI greys
 *     these out in ts mode (ParamsForm backendMode prop).                |
 *   | save_clips           | (runner decides to call cutClips)| not a pipeline option      |
 *   | viz_video            | renderViz                        |                            |
 *   | color_pose_left/right| viz wrist colours ('#'+6hex)     | vizColors() below          |
 */
import type { JobParams } from '../../api/types';
import type { PipelineOptions } from '../pipeline';

/** ts has no source-frame-rate concept — sampling is fixed at 30fps. */
export const TS_SAMPLE_FPS = 30;

export function jobParamsToPipelineOptions(params: JobParams, fps: number = TS_SAMPLE_FPS): PipelineOptions {
  return {
    fps,
    stride: Math.max(1, Math.round(params.skip)),
    maxFrames: params.max_frames > 0 ? params.max_frames : undefined,
    alpha: params.smooth_alpha,
    minGapFrames: Math.max(1, Math.round(params.gap_merge * fps)),
    minDurSec: params.min_dur > 0 ? params.min_dur : undefined,
    maxDurSec: params.max_dur > 0 ? params.max_dur : undefined,
    bufBeforeFrames: Math.max(0, Math.round(params.buf_before * fps)),
    bufAfterFrames: Math.max(0, Math.round(params.buf_after * fps)),
  };
}

/** Viz wrist colours from the Settings palette ('#rrggbb' from 6-hex). */
export function vizColors(params: JobParams): { right: string; left: string } {
  return {
    right: '#' + params.color_pose_right,
    left: '#' + params.color_pose_left,
  };
}
