/**
 * TsPipelinePanel — main-window UI for SWING_BACKEND=ts mode.
 *
 * Picks a local video file via the file dialog, runs the in-renderer
 * pipeline (frames → mediapipe pose → wrist tracking → peak picking),
 * and renders the detected swing segments in a list. The user can then
 * download a viz video with skeleton overlay via MediaRecorder.
 *
 * Phase 3 ships:
 *   - File picker (HTML input, picks the file directly)
 *   - Hidden <video> element that loads the file via URL.createObjectURL
 *   - Run button → kicks off the pipeline; progress shown
 *   - Results table: per-segment start / peak / end timestamps + confidence
 *   - Download viz button → renders overlay to canvas + MediaRecorder
 *
 * Limits of Phase 3:
 *   - No clip cutting (just viz with overlay). Cutting the source video
 *     into per-swing mp4s would need MediaSource API or ffmpeg.wasm.
 *   - Skeleton overlay is wrist-circles only (we don't cache all 33
 *     mediapipe landmarks per frame yet; the rest of the skeleton
 *     skeleton renderer is wired but skipped).
 *   - No persistence between runs.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  runPipeline,
  type SwingSegment,
  type VizResult,
  type PipelineProgress,
} from '../lib/pipeline';

interface RunState {
  status: 'idle' | 'loading' | 'running' | 'done' | 'error';
  fileName?: string;
  progress?: PipelineProgress;
  segments?: SwingSegment[];
  segmentsCount?: number;
  videoWidth?: number;
  videoHeight?: number;
  durationMs?: number;
  viz?: VizResult;
  error?: string;
}

export function TsPipelinePanel() {
  const [state, setState] = useState<RunState>({ status: 'idle' });
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onPickFile = () => fileInputRef.current?.click();

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';  // allow re-picking the same file
    setState({ status: 'loading', fileName: file.name });
    const url = URL.createObjectURL(file);
    const video = videoRef.current!;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('video load failed')); };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', ok);
        video.removeEventListener('error', fail);
      };
      video.addEventListener('loadedmetadata', ok);
      video.addEventListener('error', fail);
    });
    setState((s) => ({
      ...s,
      status: 'idle',
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      durationMs: video.duration * 1000,
    }));
  };

  const onRun = async (renderViz: boolean) => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setState((s) => ({ ...s, status: 'running', viz: undefined }));
    try {
      const result = await runPipeline(video, {
        fps: 30,
        stride: 1,
        minGapFrames: 15,
        thresholdFactor: 1.2,
        clipHalfWidth: 30,
        renderViz,
        signal: ac.signal,
        onProgress: (p) => setState((s) => ({ ...s, progress: p })),
      });
      setState((s) => ({
        ...s,
        status: 'done',
        segments: result.segments,
        segmentsCount: result.segments.length,
        videoWidth: result.videoWidth,
        videoHeight: result.videoHeight,
        durationMs: result.videoDurationMs,
        viz: result.viz,
        progress: undefined,
      }));
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setState((s) => ({ ...s, status: 'idle', progress: undefined }));
        return;
      }
      setState((s) => ({
        ...s,
        status: 'error',
        error: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}`,
        progress: undefined,
      }));
    } finally {
      abortRef.current = null;
    }
  };

  const onCancel = () => {
    abortRef.current?.abort();
  };

  const onDownloadViz = () => {
    if (!state.viz) return;
    const url = URL.createObjectURL(state.viz.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.fileName?.replace(/\.[^.]+$/, '') ?? 'viz'}.${state.viz.extension}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div style={wrap}>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />
      {/* Hidden <video> — visible only when a file is loaded so the user
          can preview what they're about to analyse. */}
      <video
        ref={videoRef}
        muted
        playsInline
        controls={!!state.fileName && state.status !== 'running'}
        style={{
          ...videoStyle,
          display: state.fileName ? 'block' : 'none',
          maxHeight: state.status === 'running' ? 0 : 320,
          marginBottom: state.status === 'running' ? 0 : 16,
        }}
      />

      <div style={{ ...card, borderColor: 'var(--border)' }}>
        <div style={cardHeader}>
          <span style={pill}>TS backend</span>
          <span style={{ fontSize: 13, color: 'var(--muted, #8d96b0)' }}>
            in-renderer pipeline · mediapipe PoseLandmarker (WASM)
          </span>
        </div>

        {!state.fileName && (
          <button onClick={onPickFile} style={btn}>
            选视频
          </button>
        )}

        {state.fileName && state.status === 'idle' && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {state.fileName}
              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                {state.videoWidth}×{state.videoHeight} · {(state.durationMs! / 1000).toFixed(1)}s
              </div>
            </div>
            <button onClick={onPickFile} style={btnGhost}>换视频</button>
            <button onClick={() => onRun(false)} style={btn}>Run</button>
            <button onClick={() => onRun(true)} style={btnGhost}>Run + viz</button>
          </div>
        )}

        {state.status === 'loading' && (
          <div style={{ color: 'var(--muted)' }}>加载视频中…</div>
        )}

        {state.status === 'running' && state.progress && (
          <div>
            <div style={{ marginBottom: 8, color: 'var(--muted)', fontSize: 12 }}>
              {phaseLabel(state.progress.phase)} ·{' '}
              {state.progress.total > 0
                ? `${state.progress.current}/${state.progress.total}`
                : state.progress.current}
            </div>
            <div style={progressBarOuter}>
              <div style={{
                ...progressBarInner,
                width: `${state.progress.total > 0 ? (state.progress.current / state.progress.total) * 100 : 30}%`,
              }} />
            </div>
            <button onClick={onCancel} style={{ ...btnGhost, marginTop: 12 }}>取消</button>
          </div>
        )}

        {state.status === 'error' && (
          <div style={{ color: '#ef5b5b', fontSize: 12 }}>{state.error}</div>
        )}

        {state.status === 'done' && state.segments && (
          <SegmentsView
            segments={state.segments}
            videoWidth={state.videoWidth!}
            videoHeight={state.videoHeight!}
            durationMs={state.durationMs!}
            viz={state.viz}
            onDownloadViz={onDownloadViz}
            onRunAgain={() => onRun(!!state.viz)}
          />
        )}
      </div>
    </div>
  );
}

function SegmentsView({
  segments, videoWidth, videoHeight, durationMs, viz, onDownloadViz, onRunAgain,
}: {
  segments: SwingSegment[];
  videoWidth: number;
  videoHeight: number;
  durationMs: number;
  viz?: VizResult;
  onDownloadViz: () => void;
  onRunAgain: () => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>
          {segments.length === 0
            ? 'No swings detected (try lowering thresholdFactor or check video)'
            : `${segments.length} swing${segments.length === 1 ? '' : 's'} detected`}
        </div>
        <button onClick={onRunAgain} style={btnGhost}>重新跑</button>
        {viz && <button onClick={onDownloadViz} style={btn}>下载 viz.{viz.extension}</button>}
      </div>
      {segments.length > 0 && (
        <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elev)' }}>
              <tr>
                <th style={th}>#</th>
                <th style={th}>start</th>
                <th style={th}>peak</th>
                <th style={th}>end</th>
                <th style={th}>conf</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr key={s.id}>
                  <td style={td}>{s.id + 1}</td>
                  <td style={td}>{formatTime(s.startTsMs, durationMs)}</td>
                  <td style={td}>{formatTime(s.peakTsMs, durationMs)}</td>
                  <td style={td}>{formatTime(s.endTsMs, durationMs)}</td>
                  <td style={td}>{(s.confidence * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function phaseLabel(p: PipelineProgress['phase']): string {
  switch (p) {
    case 'frames': return '抽帧';
    case 'poses':  return '姿态检测';
    case 'peaks':  return '找挥拍';
    case 'viz':    return '渲染 viz';
    default:       return p;
  }
}

function formatTime(ms: number, totalMs: number): string {
  const sec = ms / 1000;
  const pct = totalMs > 0 ? (ms / totalMs) * 100 : 0;
  return `${sec.toFixed(2)}s (${pct.toFixed(0)}%)`;
}

// ── styles ──────────────────────────────────────────────────────────────
const wrap: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  height: '100vh',
  padding: 24,
  background: 'var(--bg)',
  color: 'var(--text)',
  fontFamily: 'system-ui',
  boxSizing: 'border-box',
  overflowY: 'auto',
};
const videoStyle: React.CSSProperties = {
  width: '100%',
  maxHeight: 320,
  background: '#000',
  borderRadius: 6,
};
const card: React.CSSProperties = {
  border: '1px solid',
  borderRadius: 10,
  padding: 18,
  background: 'var(--bg-elev)',
};
const cardHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  marginBottom: 14,
};
const pill: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  padding: '2px 7px',
  borderRadius: 3,
  background: 'rgba(93, 210, 138, 0.15)',
  color: '#5dd28a',
  border: '1px solid rgba(93, 210, 138, 0.35)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};
const btn: React.CSSProperties = {
  background: 'var(--accent, #5dd28a)',
  color: '#0a0e1a',
  border: 'none',
  borderRadius: 4,
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  ...btn,
  background: 'transparent',
  color: 'var(--text)',
  border: '1px solid var(--border)',
};
const progressBarOuter: React.CSSProperties = {
  width: '100%',
  height: 6,
  borderRadius: 3,
  background: 'var(--bg)',
  overflow: 'hidden',
};
const progressBarInner: React.CSSProperties = {
  height: '100%',
  background: 'var(--accent, #5dd28a)',
  transition: 'width 0.2s ease',
};
const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '6px 10px',
  fontWeight: 600,
  color: 'var(--muted, #8d96b0)',
  borderBottom: '1px solid var(--border)',
};
const td: React.CSSProperties = {
  padding: '6px 10px',
  borderBottom: '1px solid var(--border)',
  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
};
