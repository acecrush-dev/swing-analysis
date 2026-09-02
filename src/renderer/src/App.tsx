import { useEffect, useMemo, useRef, useState } from 'react';
import { SwingClient } from './api/client';
import { DEFAULT_PARAMS, type ClipInfo, type ClipProcessingState, type JobParams, type Segment } from './api/types';
import { VideoPicker } from './components/VideoPicker';
import { ParamsForm } from './components/ParamsForm';
import { ProgressPanel } from './components/ProgressPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { ClipsBar } from './components/ClipsBar';
import { useTheme } from './hooks/theme';
import { HelpPanel } from './components/HelpPanel';

declare global {
  interface Window {
    api: {
      pickVideo: () => Promise<string|null>;
      getServiceInfo: () => Promise<string|null>;
      getDroppedFilePath: (file: File) => string;
      exportPackage: (jobId: string | null) => Promise<{ ok: boolean; path?: string; error?: string }>;
      openExternal: (url: string) => Promise<boolean>;
      showAbout: () => Promise<void>;
      onMenuEvent: (channel: string, cb: () => void) => () => void;
    };
  }
}

// Allowed video extensions (kept in sync with the dialog filter on the
// main-process side). Anything dropped that doesn't match is rejected
// with a friendly error instead of being shoved into the pipeline.
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'] as const;
function isVideoPath(p: string): boolean {
  const m = p.match(/\.([a-z0-9]+)$/i);
  return !!m && VIDEO_EXTS.includes(m[1].toLowerCase() as any);
}

// Tiny state for the drop-target visual feedback (kept around for
// future per-drop metadata; currently only `active` is tracked inline).
interface DropState { active: boolean; }

export default function App() {
  const { theme, toggle } = useTheme();
  const [dropActive, setDropActive] = useState(false);
  const dropCounter = useRef(0);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [params, setParams] = useState<JobParams>(DEFAULT_PARAMS);
  const [jobId, setJobId] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [jobState, setJobState] = useState<'idle'|'queued'|'running'|'done'|'failed'|'cancelled'>('idle');
  const [progress, setProgress] = useState<{ frames: number; total: number; fps: number; eta_sec: number | null; segments_emitted: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeg, setSelectedSeg] = useState<Segment | null>(null);

  // Clips (plan 002)
  const [clips, setClips] = useState<ClipInfo[]>([]);
  const [activeClip, setActiveClip] = useState<ClipInfo | null>(null);
  // plan 003 — per-clip annotation stage progress, keyed by seg_id.
  // Populated by `clip.progress` WS events; cleared by `clip.generated`
  // (for that seg_id) and on every job terminal event.
  const [clipProc, setClipProc] = useState<Record<number, ClipProcessingState>>({});
  const [logLines, setLogLines] = useState<string[]>([]);
  // Viz mode: video player shows the pipeline-rendered viz.mp4 instead
  // of the original video / a clip. Set when the user clicks the
  // "🎬 可视化完整视频" button in the right-panel footer.
  const [vizMode, setVizMode] = useState(false);
  // Help overlay (plan 002 M22)
  const [helpOpen, setHelpOpen] = useState(false);

  // Per-artifact existence flags. Populated by HEAD probes after the
  // job reaches done. The right panel uses these to hide download links
  // and the viz-play button that would 404 anyway.
  const [artifacts, setArtifacts] = useState<{
    segmentsJson: boolean;
    viz: boolean;
    clips: boolean;
  }>({ segmentsJson: false, viz: false, clips: false });

  const pushLog = (line: string) => setLogLines((prev) => {
    const next = [...prev, line];
    return next.length > 500 ? next.slice(next.length - 500) : next;
  });

  useEffect(() => {
    (async () => {
      try {
        const url = await window.api.getServiceInfo();
        setBaseUrl(url);
      } catch (e: any) {
        setError(`getServiceInfo failed: ${e}`);
      }
    })();
  }, []);

  // Wire native menu items (File → Open File / Export Package) and the
  // Help → About trigger. Help Content + docs link are handled in main
  // process (shell.openExternal).
  useEffect(() => {
    if (!window.api?.onMenuEvent) return;
    const offOpen = window.api.onMenuEvent('menu:open-file', () => {
      // re-use the existing flow — fire a fake pick that mimics clicking
      // the "选择视频…" button
      (async () => {
        const p = await window.api.pickVideo();
        if (p) {
          setError(null);
          setVideoPath(p);
          pushLog(`📁 菜单打开文件: ${p}`);
        }
      })();
    });
    const offExport = window.api.onMenuEvent('menu:export-package', () => {
      handleExportPackage();
    });
    const offAbout = window.api.onMenuEvent('menu:about', () => {
      window.api?.showAbout?.();
    });
    return () => { offOpen(); offExport(); offAbout(); };
  }, []);

  const client = useMemo(() => baseUrl ? new SwingClient(baseUrl) : null, [baseUrl]);

  const startJob = async () => {
    if (!client || !videoPath) return;
    setError(null);
    setSegments([]);
    setSelectedSeg(null);
    setClips([]);
    setActiveClip(null);
    setVizMode(false);
    setLogLines([]);
    setProgress(null);
    setClipProc({});
    setJobState('queued');
    try {
      const r = await client.createJob(videoPath, params);
      setJobId(r.job_id);
      setJobState('running');
      pushLog(`▶ job ${r.job_id} 创建 · save_clips=${params.save_clips}`);
      const close = client.openEvents(
        r.job_id,
        (e: any) => {
          try {
            if (!e || typeof e !== 'object' || !e.type) return;
            const data: any = e.data ?? {};
            if (e.type === 'pose.progress') {
              if (typeof data.frames === 'number') {
                setProgress({
                  frames: data.frames,
                  total: data.total ?? 0,
                  fps: typeof data.fps === 'number' ? data.fps : 0,
                  eta_sec: data.eta_sec ?? null,
                  segments_emitted: data.segments_emitted ?? 0,
                });
              }
              const d = data;
              if (typeof d.fps === 'number' && typeof d.frames === 'number'
                  && (d.frames % 50 === 0 || d.frames === d.total)) {
                pushLog(`  pose ${d.frames}/${d.total} · ${d.fps.toFixed(1)} fps · emit=${d.segments_emitted ?? 0}`);
              }
            }
            if (e.type === 'segment.emitted') {
              const seg = data.segment;
              if (!seg) return;
              setSegments((s) => [...s, seg]);
              pushLog(`✂ segment #${seg.seg_id} ${seg.start_timecode ?? '?'} → ${seg.end_timecode ?? '?'} · 击球 @ ${seg.contact_timecode ?? '?'}`);
            }
            if (e.type === 'clip.annotated') {
              pushLog(`🎯 clip #${data.seg_id} 标注完成`);
            }
            if (e.type === 'clip.progress') {
              // plan 003 — per-clip annotation stage progress. Keyed by
              // seg_id; concurrent clips (max_workers=2) ride side by side
              // in the ProgressPanel inner bars.
              const sid = typeof data.seg_id === 'number' ? data.seg_id : 0;
              if (sid > 0 && typeof data.frame === 'number') {
                const stage: ClipProcessingState['stage'] =
                  data.stage === 'rtmdet' || data.stage === 'pose'
                    ? data.stage
                    : 'rtmdet+pose';
                const fp: ClipProcessingState = {
                  seg_id: sid,
                  stage,
                  frame: data.frame,
                  total: typeof data.total === 'number' ? data.total : 0,
                };
                setClipProc((prev) => ({ ...prev, [sid]: fp }));
              }
            }
            if (e.type === 'clip.generated') {
              const info: ClipInfo = {
                seg_id: typeof data.seg_id === 'number' ? data.seg_id : 0,
                exists: !!data.exists,
                size_bytes: typeof data.size_bytes === 'number' ? data.size_bytes : 0,
                playable: !!data.playable,
                annotated: !!data.annotated,
                thumb_ready: !!data.thumb_ready,
              };
              if (info.seg_id > 0) {
                setClips((prev) => {
                  if (prev.some((c) => c.seg_id === info.seg_id)) return prev;
                  return [...prev, info];
                });
                pushLog(`🎬 clip #${info.seg_id} 生成${info.playable ? ' (H.264 ✓)' : ' (mp4v only)'}`);
              }
              // plan 003 — clip is fully done (extracted + annotated +
              // H.264 attempted); drop its inner progress bar.
              setClipProc((prev) => {
                if (!(info.seg_id in prev)) return prev;
                const next = { ...prev };
                delete next[info.seg_id];
                return next;
              });
            }
            if (e.type === 'job.completed') {
              setJobState('done');
              setClipProc({});
              pushLog(`✓ job 完成 · 共 ${data.segment_count ?? '?'} 段`);
            }
            if (e.type === 'job.failed') {
              setJobState('failed');
              setClipProc({});
              const msg = String(data.error ?? 'unknown');
              setError(msg);
              pushLog(`✗ job 失败: ${msg}`);
            }
            if (e.type === 'job.cancelled') {
              setJobState('cancelled');
              setClipProc({});
              pushLog(`⊘ job 取消`);
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ws handler]', err);
          }
        },
        () => {
          try {
            if (!client) return;
            client.getJob(r.job_id).then((info) => {
              if (!info) return;
              setJobState(info.state);
              setSegments(info.segments ?? []);
              // plan 003 — clipProc is a per-event live stream artifact;
              // on reconnect we clear and let fresh events rebuild it.
              setClipProc({});
              pushLog(`↻ WS 重连 · state=${info.state} · ${(info.segments ?? []).length} 段`);
            }).catch((err) => {
              // eslint-disable-next-line no-console
              console.error('[ws reconnect]', err);
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[ws reconnect]', err);
          }
        }
      );
      (window as any).__closeWs = close;
    } catch (e: any) {
      setError(String(e));
      setJobState('failed');
      pushLog(`✗ 创建失败: ${String(e)}`);
    }
  };

  const cancelJob = async () => {
    if (!client || !jobId) return;
    try {
      await client.cancel(jobId);
      pushLog(`⊘  已发送取消请求`);
    } catch (e: any) {
      setError(String(e));
      pushLog(`✗ 取消失败: ${String(e)}`);
    }
  };

  // Delete the entire job — wipes /api/data/jobs/{id} from disk.
  const deleteJob = async () => {
    if (!client || !jobId) return;
    if (jobState === 'running') {
      setError('运行中的 job 不能删除，请先取消');
      return;
    }
    if (!window.confirm(`删除整个 job？所有 clips 和 viz.mp4 都会从磁盘清空（backend/data/jobs/${jobId}/）。`)) return;
    try {
      await client.delete(jobId);
      // Close the live WS if any
      (window as any).__closeWs?.();
      pushLog(`🗑 job ${jobId} 已删除`);
      // Reset everything
      setJobId(null);
      setSegments([]);
      setSelectedSeg(null);
      setClips([]);
      setActiveClip(null);
      setProgress(null);
      setClipProc({});
      setVizMode(false);
      setJobState('idle');
    } catch (e: any) {
      setError(String(e));
      pushLog(`✗ 删除失败: ${String(e)}`);
    }
  };

  useEffect(() => {
    if (!client || !jobId) return;
    if (jobState !== 'done') return;
    client.listClips(jobId)
      .then((cs) => setClips(Array.isArray(cs) ? cs : []))
      .catch((e) => setError(`listClips: ${e}`));
  }, [client, jobId, jobState]);

  // HEAD-probe each artifact once the job is done. Cancelling resets
  // everything to "false" so the UI hides links / buttons that would
  // 404. Doesn't run while the job is running — we don't want to spam
  // the server with HEAD requests per frame.
  useEffect(() => {
    if (!client || !jobId) {
      setArtifacts({ segmentsJson: false, viz: false, clips: false });
      return;
    }
    if (jobState !== 'done') {
      // If the job failed/was cancelled and never wrote some files,
      // hide those links too.
      setArtifacts({ segmentsJson: false, viz: false, clips: false });
      return;
    }
    let cancelled = false;
    const headOk = async (rel: string): Promise<boolean> => {
      try {
        const r = await fetch(client.artifactUrl(jobId, rel), { method: 'HEAD' });
        return r.ok;
      } catch {
        return false;
      }
    };
    (async () => {
      try {
        const [segmentsJson, viz, clips] = await Promise.all([
          headOk('segments.json'),
          headOk('viz.mp4'),
          client.listClips(jobId).then((cs) => Array.isArray(cs) && cs.length > 0).catch(() => false),
        ]);
        if (!cancelled) setArtifacts({ segmentsJson, viz, clips });
      } catch {
        if (!cancelled) setArtifacts({ segmentsJson: false, viz: false, clips: false });
      }
    })();
    return () => { cancelled = true; };
  }, [client, jobId, jobState]);

  const handleSelectClip = (c: ClipInfo) => {
    if (!c) return;
    setVizMode(false); // exit viz mode when picking a clip
    setActiveClip(c);
    if (!c.playable) {
      const seg = segments.find((s) => s.seg_id === c.seg_id);
      if (seg) setSelectedSeg(seg);
    }
  };

  const handleReturnToOriginal = () => {
    const seg = activeClip
      ? segments.find((s) => s.seg_id === activeClip.seg_id)
      : null;
    setActiveClip(null);
    if (seg) setSelectedSeg({ ...seg });
  };

  const handleCleanupClips = async () => {
    if (!client || !jobId) return;
    if (!window.confirm('删除该 job 的全部 clips？')) return;
    try {
      const res = await client.cleanupClips(jobId);
      setClips([]);
      setActiveClip(null);
      pushLog(`🧹 已清理 ${res.deleted_count} 个 clips 文件 (${(res.freed_bytes/1024).toFixed(1)} KB)`);
    } catch (e: any) {
      setError(String(e));
      pushLog(`✗ 清理失败: ${String(e)}`);
    }
  };

  const handleClearLog = () => setLogLines([]);

  // Zip the active job's outputs into a single file the user can pass
  // around. IPC goes to the main process which uses archiver to walk
  // the job directory.
  const handleExportPackage = async () => {
    if (!jobId) {
      setError('没有可导出的 job');
      return;
    }
    if (!window.api?.exportPackage) {
      setError('当前环境不支持导出（preload 没暴露 exportPackage）');
      return;
    }
    try {
      const res = await window.api.exportPackage(jobId);
      if (res.ok) {
        pushLog(`📦 已导出 job 包: ${res.path}`);
        setError(null);
      } else {
        if (res.error !== 'cancelled') setError(`导出失败: ${res.error}`);
      }
    } catch (e: any) {
      setError(`导出失败: ${e}`);
    }
  };

  // Drag-and-drop video onto the window. Accept only one file at a time;
  // reject anything that doesn't look like a video by extension.
  const handleDroppedFile = (file: File) => {
    let p = '';
    try {
      p = window.api?.getDroppedFilePath?.(file) ?? '';
    } catch {
      p = '';
    }
    if (!p) {
      setError('无法获取拖入文件的绝对路径 —— 请改用「选择视频…」按钮');
      return;
    }
    if (!isVideoPath(p)) {
      const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '?').toLowerCase();
      setError(`不是视频文件（.${ext})。请拖入 ${VIDEO_EXTS.map((e) => '.' + e).join(' / ')} 格式的视频。`);
      return;
    }
    setError(null);
    setVideoPath(p);
    pushLog(`📂 拖入视频: ${p}`);
  };

  // Drag events on the outer grid. We use a counter to ignore dragleave
  // events that fire when the cursor moves over child elements.
  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dropCounter.current += 1;
    setDropActive(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dropCounter.current = Math.max(0, dropCounter.current - 1);
    if (dropCounter.current === 0) setDropActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dropCounter.current = 0;
    setDropActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) {
      setError('没有收到文件');
      return;
    }
    if (files.length > 1) {
      setError('一次只能拖一个视频文件');
      return;
    }
    handleDroppedFile(files[0]);
  };

  if (!baseUrl) return <div style={{ padding: 24 }}>⏳ 等待 sidecar 服务启动…</div>;

  const clipSegment = activeClip
    ? segments.find((s) => s.seg_id === activeClip.seg_id) ?? null
    : null;
  // Priority for video src:
  //   1. vizMode on → viz.mp4
  //   2. active clip → clip stream (if playable) else original
  //   3. selectedSeg / no active → original video
  let videoSrc: string | null = null;
  if (vizMode && client && jobId) {
    videoSrc = client.artifactUrl(jobId, 'viz.mp4');
  } else if (activeClip && client && jobId) {
    videoSrc = activeClip.playable
    ? client.clipStreamUrl(jobId, activeClip.seg_id)
    : client.videoUrl(videoPath ?? '');
  } else if (videoPath && client) {
    videoSrc = client.videoUrl(videoPath);
  }
  const thumbUrl = (segId: number) =>
    client && jobId ? client.clipThumbUrl(jobId, segId) : '';

  // plan 003 — outer queue bar (done/discovered) is purely derived;
  // inner per-clip bars are pulled from the clipProc map (see WS handler).
  // Strictly the user's spec: shows dual bars only when a clip annotation
  // flag is on, not for extract-only runs.
  const clipBarsEnabled = params.save_clips && (params.clip_bbox || params.clip_skel);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 360px',
        height: '100vh',
        fontFamily: 'system-ui',
        color: 'var(--text)',
        background: 'var(--bg)',
      }}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropActive && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(255,235,59,0.18)',
            border: '4px dashed var(--accent)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            color: 'var(--accent)',
            fontSize: 22,
            fontWeight: 'bold',
          }}
        >
          拖入视频文件即可载入
        </div>
      )}
      {/* Left column — title → video → progress → clips (pinned) */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto auto',
          padding: 16,
          gap: 8,
          minHeight: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>🎾 swing-analysis</h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={() => setHelpOpen(true)}
              title="帮助 / 参数说明"
              style={{
                background: 'var(--bg-elev)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: '50%',
                width: 26, height: 26,
                cursor: 'pointer',
                fontSize: 14, fontWeight: 'bold',
                lineHeight: 1, padding: 0,
              }}
            >
              ?
            </button>
            <button
              onClick={toggle}
              title={theme === 'dark' ? '当前：深色模式（点击切换到浅色）' : '当前：浅色模式（点击切换到深色）'}
              style={{
                background: 'var(--bg-elev)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              {theme === 'dark' ? '🌙' : '☀️'}
            </button>
          </div>
        </div>
        <div style={{
          // Flex column that hosts the VideoPicker (which itself is a flex
          // column with the video area on flex:1). No overflow on this
          // wrapper — the VideoPicker / video element handle their own
          // sizing, and overflow:hidden would silently clip the controls
          // bar if the available space is tight.
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'hidden',
        }}>
          <VideoPicker
            videoPath={videoPath}
            onPick={async () => {
              const p = await window.api?.pickVideo?.();
              if (p) setVideoPath(p);
            }}
            client={client}
            selectedSeg={selectedSeg}
            activeClip={activeClip}
            clipSegment={clipSegment}
            onReturnToOriginal={handleReturnToOriginal}
            vizMode={vizMode}
            videoSrc={videoSrc}
          />
          {error && <div style={{ color: 'var(--danger)', marginTop: 8, fontSize: 12, flex: '0 0 auto' }}>❌ {error}</div>}
        </div>
        <ProgressPanel
          state={jobState}
          progress={progress}
          segments={segments.length}
          onStart={startJob}
          onCancel={cancelJob}
          disabled={!videoPath || jobState === 'running'}
          clipBarsEnabled={clipBarsEnabled}
          clipsDone={clips.length}
          clipsDiscovered={segments.length}
          clipProcessing={clipProc}
        />
        <ClipsBar
          clips={clips}
          segments={segments}
          activeClip={activeClip}
          onSelectClip={handleSelectClip}
          onCleanupClips={handleCleanupClips}
          thumbUrl={thumbUrl}
          jobDone={jobState === 'done' || jobState === 'failed' || jobState === 'cancelled'}
          saveClipsEnabled={params.save_clips}
          jobRunning={jobState === 'running' || jobState === 'queued'}
        />
      </div>

      {/* Right column */}
      <div
        style={{
          borderLeft: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          background: 'var(--bg)',
        }}
      >
        <ParamsForm params={params} onChange={setParams} disabled={jobState === 'running'} />
        <ResultsPanel
          client={client}
          jobId={jobId}
          logLines={logLines}
          onClearLog={handleClearLog}
          onDeleteJob={deleteJob}
          onExportPackage={handleExportPackage}
          vizMode={vizMode}
          onToggleViz={() => setVizMode((v) => !v)}
          vizAvailable={artifacts.viz}
          segmentsJsonAvailable={artifacts.segmentsJson}
          clipsAvailable={artifacts.clips}
        />
      </div>

      {/* Help overlay — sits above everything */}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
    </div>
  );
}