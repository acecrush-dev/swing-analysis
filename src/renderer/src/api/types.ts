/** Wire types — mirror backend.service.schemas.py. */
export interface JobParams {
  v_swing: number;
  gap_merge: number;
  max_bridge: number;
  min_peak: number;
  smooth_alpha: number;
  max_lost_frames: number;
  min_dur: number;
  max_dur: number;
  buf_before: number;
  buf_after: number;
  skip: number;
  max_frames: number;
  save_clips: boolean;
  viz_video: boolean;
  // clip annotation (optional, applied per clip after extraction)
  clip_bbox: boolean;
  clip_skel: boolean;
  skel_backend: 'rtmpose' | 'mediapipe';
}

export const DEFAULT_PARAMS: JobParams = {
  v_swing: 0.10, gap_merge: 1.5, max_bridge: 1.5, min_peak: 0.30,
  smooth_alpha: 0.65, max_lost_frames: 8, min_dur: 0.3, max_dur: 6.0,
  buf_before: 1.0, buf_after: 1.0, skip: 1, max_frames: 0,
  save_clips: true, viz_video: false,
  clip_bbox: false, clip_skel: false, skel_backend: 'rtmpose',
};

export interface SegmentPhase {
  phase: 'ready' | 'windup' | 'contact' | 'follow_through';
  start_frame: number; end_frame: number;
}

export interface Segment {
  seg_id: number;
  start_frame: number; end_frame: number;
  active_start_frame: number; active_end_frame: number;
  contact_frame: number; peak_velocity: number;
  duration_sec: number; total_sec: number;
  start_timecode: string; contact_timecode: string; end_timecode: string;
  over_long: boolean; merged_intervals: number;
  peak_frame?: number; peak_timecode?: string;
  phases: SegmentPhase[];
}

export interface JobInfo {
  job_id: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  video_path: string;
  params: JobParams;
  created_at: number; started_at?: number; finished_at?: number;
  error?: string;
  segments: Segment[];
  segments_payload?: { fps: number; total_frames: number; duration_sec: number } | null;
  queue_position?: number | null;
}

export interface ClipInfo {
  seg_id: number;
  exists: boolean;
  size_bytes: number;
  playable: boolean;   // clip_NNN_h264.mp4 present → Chromium 内嵌可播
  annotated: boolean;
  thumb_ready: boolean;
}

// plan 003 — per-clip annotation stage progress. One entry per currently
// running clip annotation; key in App.tsx's clipProc map is seg_id.
export interface ClipProcessingState {
  seg_id: number;
  stage: 'rtmdet' | 'pose' | 'rtmdet+pose';
  frame: number;
  total: number;   // 0 = 未知（前端不定长显示）
}

export interface ClipCleanupResult {
  deleted_count: number;
  freed_bytes: number;
}

export type ProgressEvent =
  | { type: 'job.started'; job_id: string; data: { video_path: string } }
  | { type: 'pose.progress'; job_id: string; data: { frames: number; total: number; fps: number; eta_sec: number | null; segments_emitted: number } }
  | { type: 'segment.emitted'; job_id: string; data: { segment: Segment } }
  | { type: 'clip.annotated'; job_id: string; data: { seg_id: number; clip_in: string; clip_annotated: string; frames: number; bbox: boolean; skel: boolean; skel_backend: 'rtmpose' | 'mediapipe' } }
  | { type: 'clip.progress'; job_id: string; data: ClipProcessingState }
  | { type: 'clip.generated'; job_id: string; data: ClipInfo }
  | { type: 'job.completed'; job_id: string; data: { segment_count: number } }
  | { type: 'job.failed'; job_id: string; data: { error: string } }
  | { type: 'job.cancelled'; job_id: string; data: Record<string, never> };