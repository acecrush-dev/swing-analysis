/**
 * TsRunner — drives the in-renderer pipeline for the unified main UI
 * (plan 008 M2).
 *
 * The App component owns one TsRunner ref (mode-independent state) and
 * starts a run exactly where it would POST /api/jobs in python mode.
 * The runner's events mirror the sidecar's WS event payloads:
 *
 *   onProgress  ← shape of WS `pose.progress`
 *                 {frames, total, fps, eta_sec, segments_emitted}
 *   onSegment   ← shape of WS `segment.emitted` data.segment (wire Segment)
 *   onClip      ← shape of WS `clip.generated` data (ClipInfo, + ts url)
 *   onViz       ← viz blob URL + actual container
 *   onDone / onFailed / onCancelled ← job.completed / failed / cancelled
 *
 * Because the shapes match, App's apply* functions handle both backends
 * unchanged (M3).
 *
 * M2 scope: clips are stubbed as non-playable cards (seek-to-original
 * degradation); real ffmpeg.wasm cutting lands in M4 (clipCutter.ts).
 * viz is produced by runPipeline's renderViz (streaming rewrite also
 * lands in M4 — the VizResult contract is stable either way).
 */
import { runPipeline } from '../pipeline';
import type { PipelineProgress } from '../pipeline';
import { jobParamsToPipelineOptions, vizColors } from './paramsMap';
import { toWireSegment } from './segmentAdapter';
import { cutClips } from './clipCutter';
import { mediaUrl } from '../mediaUrl';
import type { JobParams, Segment, ClipInfo } from '../../api/types';

export interface TsProgress {
  frames: number;
  total: number;
  fps: number;
  eta_sec: number | null;
  segments_emitted: number;
}

export interface TsVizInfo {
  url: string;
  extension: 'mp4' | 'webm';
  sizeBytes: number;
}

/** Non-fatal notices the App surfaces via pushLog + toast. */
export type TsNotice = 'clipSkipLarge' | 'vizWebm';

export interface TsRunnerHandlers {
  onProgress(p: TsProgress): void;
  onSegment(seg: Segment): void;
  onClip(info: ClipInfo): void;
  onViz(v: TsVizInfo): void;
  onDone(segmentCount: number): void;
  onFailed(error: string): void;
  onCancelled(): void;
  onNotice?(kind: TsNotice): void;
}

/** segments.json payload — same top-level keys as the python side's file. */
export interface TsSegmentsJson {
  input: string;
  fps: number;
  total_frames: number;
  processed_frames: number;
  duration_sec: number;
  wrist_detected_pct: number;
  params: Record<string, unknown>;
  segments: Segment[];
  segment_count: number;
}

export class TsRunner {
  private ac: AbortController | null = null;
  private running = false;
  // Last-run bookkeeping for buildSegmentsJson().
  private lastInput = '';
  private lastParams: JobParams | null = null;
  private lastWireSegments: Segment[] = [];
  private lastStats = { totalFrames: 0, processedFrames: 0, durationSec: 0, wristPct: 0 };

  get isRunning(): boolean {
    return this.running;
  }

  async start(videoPath: string, params: JobParams, handlers: TsRunnerHandlers): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ac = new AbortController();
    const signal = this.ac.signal;

    // Offscreen video element — the pipeline seeks/detects on it. It MUST
    // stay in the render tree (1px, off-screen, near-transparent) but
    // never `display: none`: requestVideoFrameCallback only fires for
    // elements that participate in composition, so a display:none video
    // would freeze the live-detection pass with zero callbacks.
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.src = mediaUrl(videoPath);
    video.style.position = 'fixed';
    video.style.left = '-9999px';
    video.style.top = '0';
    video.style.width = '2px';
    video.style.height = '2px';
    video.style.opacity = '0.01';
    video.style.pointerEvents = 'none';
    video.style.zIndex = '-1';
    document.body.appendChild(video);

    let segmentsEmitted = 0;
    try {
      // Wait for metadata; swing-media:// streams over Range requests so
      // this resolves once the moov atom is parsed.
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      await new Promise<void>((resolve, reject) => {
        const ok = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error(`视频加载失败: ${video.error?.message ?? 'unknown media error'}`)); };
        const onAbort = () => { cleanup(); reject(new DOMException('aborted', 'AbortError')); };
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', ok);
          video.removeEventListener('error', fail);
          signal.removeEventListener('abort', onAbort);
        };
        video.addEventListener('loadedmetadata', ok);
        video.addEventListener('error', fail);
        signal.addEventListener('abort', onAbort);
      });
      if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error(`视频元数据无效 (${video.videoWidth}×${video.videoHeight}, ${video.duration}s)`);
      }

      const opts = jobParamsToPipelineOptions(params);
      const maxDurSec = opts.maxDurSec;
      this.lastInput = videoPath;
      this.lastParams = params;

      // Rolling fps/ETA estimate over the whole run (poses phase is the
      // long one; frames/viz phases also flow through here).
      const t0 = performance.now();
      let lastT = t0;
      let lastCurrent = 0;
      let fpsEst = 0;

      const result = await runPipeline(video, {
        ...opts,
        renderViz: params.viz_video,
        colors: vizColors(params),
        signal,
        onSegments: (segs) => {
          this.lastWireSegments = segs.map((s) => toWireSegment(s, { maxDurSec }));
          // Emit all at once (ts peaks in batch — python emits online);
          // cards still enqueue per-clip afterwards, so the UI effect is
          // close to the sidecar's behaviour.
          for (const seg of this.lastWireSegments) {
            segmentsEmitted++;
            handlers.onSegment(seg);
          }
        },
        onProgress: (p: PipelineProgress) => {
          const now = performance.now();
          const dt = (now - lastT) / 1000;
          if (dt > 0.5) {
            const inst = (p.current - lastCurrent) / dt;
            if (inst > 0) fpsEst = fpsEst === 0 ? inst : fpsEst * 0.7 + inst * 0.3;
            lastT = now;
            lastCurrent = p.current;
          }
          const eta = fpsEst > 0 && p.total > p.current
            ? (p.total - p.current) / fpsEst
            : null;
          handlers.onProgress({
            frames: p.current,
            total: p.total,
            fps: Math.round(fpsEst * 10) / 10,
            eta_sec: eta != null ? Math.round(eta) : null,
            segments_emitted: segmentsEmitted,
          });
        },
      });

      // Bookkeeping for segments.json.
      this.lastStats = {
        totalFrames: Math.round(video.duration * (opts.fps ?? 30)),
        processedFrames: result.framesProcessed,
        durationSec: result.videoDurationMs / 1000,
        wristPct: 100, // refined when we track per-frame wrist presence
      };

      // Clips — real per-segment mp4 cutting via ffmpeg.wasm. A source
      // beyond the MEMFS guard degrades every card to non-playable and
      // fires onNotice('clipSkipLarge') so the App can explain why.
      if (params.save_clips && this.lastWireSegments.length > 0) {
        await cutClips(videoPath, this.lastWireSegments, {
          fps: opts.fps ?? 30,
          signal,
          onClip: (info) => handlers.onClip(info),
          onSkipLarge: () => handlers.onNotice?.('clipSkipLarge'),
        });
      }

      // Viz blob → object URL (runner owns nothing after handing over;
      // App revokes on reset/new run).
      if (result.viz) {
        const url = URL.createObjectURL(result.viz.blob);
        const extension = result.viz.extension === 'webm' ? 'webm' as const : 'mp4' as const;
        if (extension === 'webm') handlers.onNotice?.('vizWebm');
        handlers.onViz({
          url,
          extension,
          sizeBytes: result.viz.blob.size,
        });
      }

      handlers.onDone(result.segments.length);
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        handlers.onCancelled();
      } else {
        handlers.onFailed(`${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`);
      }
    } finally {
      this.running = false;
      this.ac = null;
      video.src = '';
      video.remove();
    }
  }

  cancel(): void {
    this.ac?.abort();
  }

  /** segments.json-equivalent payload for the current/last run. */
  buildSegmentsJson(): TsSegmentsJson | null {
    if (!this.lastParams) return null;
    return {
      input: this.lastInput,
      fps: jobParamsToPipelineOptions(this.lastParams).fps ?? 30,
      total_frames: this.lastStats.totalFrames,
      processed_frames: this.lastStats.processedFrames,
      duration_sec: this.lastStats.durationSec,
      wrist_detected_pct: this.lastStats.wristPct,
      params: jobParamsToPipelineOptions(this.lastParams) as unknown as Record<string, unknown>,
      segments: this.lastWireSegments,
      segment_count: this.lastWireSegments.length,
    };
  }
}
