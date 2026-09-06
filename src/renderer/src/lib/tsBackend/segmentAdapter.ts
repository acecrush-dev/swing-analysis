/**
 * SwingSegment (pipeline shape) → Segment (python wire shape) adapter,
 * plan 008 M2.
 *
 * The unified main UI (ClipsBar / ClipGrid / VideoPicker / Results
 * panels) consumes the wire `Segment` shape that mirrors
 * backend.service.schemas.Segment. The ts pipeline produces its own
 * leaner SwingSegment. Adapting here keeps every downstream component
 * untouched by the backend mode.
 *
 * Fields the python side computes but ts doesn't have an equivalent for
 * (peak_velocity, merged_intervals, phases) are filled with neutral
 * values — they're display-only extras in the GUI today.
 */
import type { SwingSegment } from '../pipeline';
import type { Segment } from '../../api/types';

/** ms → "MM:SS.mmm" — VideoPicker's tcToSec() parses this format. */
function formatTimecode(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function toWireSegment(s: SwingSegment, opts: { maxDurSec?: number } = {}): Segment {
  const durationSec = (s.endTsMs - s.startTsMs) / 1000;
  return {
    seg_id: s.id + 1,
    start_frame: s.startFrameIdx,
    end_frame: s.endFrameIdx,
    active_start_frame: s.startFrameIdx,
    active_end_frame: s.endFrameIdx,
    contact_frame: s.peakFrameIdx,
    peak_velocity: 0,
    duration_sec: durationSec,
    total_sec: durationSec,
    start_timecode: formatTimecode(s.startTsMs),
    contact_timecode: formatTimecode(s.peakTsMs),
    end_timecode: formatTimecode(s.endTsMs),
    over_long: (opts.maxDurSec ?? 0) > 0 && durationSec > opts.maxDurSec!,
    merged_intervals: 0,
    peak_frame: s.peakFrameIdx,
    peak_timecode: formatTimecode(s.peakTsMs),
    phases: [],
  };
}
