import { useEffect, useMemo, useState } from 'react';
import { SwingClient } from './api/client';
import { DEFAULT_PARAMS, type ClipInfo, type JobParams, type Segment } from './api/types';
import { VideoPicker } from './components/VideoPicker';
import { ParamsForm } from './components/ParamsForm';
import { ProgressPanel } from './components/ProgressPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { ClipsBar } from './components/ClipsBar';

declare global {
  interface Window { api: { pickVideo: () => Promise<string|null>; getServiceInfo: () => Promise<string|null> }; }
}

export default function App() {
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
  // Right-panel event log feed. Plain text lines, newest at the bottom.
  const [logLines, setLogLines] = useState<string[]>([]);

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

  const client = useMemo(() => baseUrl ? new SwingClient(baseUrl) : null, [baseUrl]);

  const startJob = async () => {
    if (!client || !videoPath) return;
    setError(null);
    setSegments([]);
    setSelectedSeg(null);
    setClips([]);
    setActiveClip(null);
    setLogLines([]);
    setProgress(null);
    setJobState('queued');
    try {
      const r = await client.createJob(videoPath, params);
      setJobId(r.job_id);
      setJobState('running');
      pushLog(`▶ job ${r.job_id} 创建 · save_clips=${params.save_clips}`);
      const close = client.openEvents(
        r.job_id,
        (e: any) => {
          // Defensive — wrap the whole handler so a single malformed event
          // can never tear down the React tree.
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
            if (e.type === 'clip.generated') {
              // plan 002 M13 — push the new clip into the UI immediately.
              // The thumbnail loads lazily on first <img> render (cached
              // on disk by GET /thumbnail.jpg after that).
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
            }
            if (e.type === 'job.completed') {
              setJobState('done');
              pushLog(`✓ job 完成 · 共 ${data.segment_count ?? '?'} 段`);
            }
            if (e.type === 'job.failed') {
              setJobState('failed');
              const msg = String(data.error ?? 'unknown');
              setError(msg);
              pushLog(`✗ job 失败: ${msg}`);
            }
            if (e.type === 'job.cancelled') {
              setJobState('cancelled');
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

  // Fetch clips once the job reaches done. Re-runs on reconnect-driven
  // jobState flips too, so a stale UI snaps back.
  useEffect(() => {
    if (!client || !jobId) return;
    if (jobState !== 'done') return;
    client.listClips(jobId)
      .then((cs) => setClips(Array.isArray(cs) ? cs : []))
      .catch((e) => setError(`listClips: ${e}`));
  }, [client, jobId, jobState]);

  // ── clip handlers (plan 002) ────────────────────────────────────────
  const handleSelectClip = (c: ClipInfo) => {
    if (!c) return;
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

  if (!baseUrl) return <div style={{ padding: 24 }}>⏳ 等待 sidecar 服务启动…</div>;

  const clipSegment = activeClip
    ? segments.find((s) => s.seg_id === activeClip.seg_id) ?? null
    : null;
  const clipUrl = activeClip && client && jobId
    ? client.clipStreamUrl(jobId, activeClip.seg_id)
    : null;
  const thumbUrl = (segId: number) =>
    client && jobId ? client.clipThumbUrl(jobId, segId) : '';

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 360px',
        height: '100vh',
        fontFamily: 'system-ui',
        color: '#eee',
        background: '#1a1a1a',
      }}
    >
      {/* Left column — order: title → video → progress → clips (pinned).
          Video takes the scrollable middle; progress + clips always visible. */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto auto',
          padding: 16,
          gap: 8,
          minHeight: 0,
        }}
      >
        <h2 style={{ margin: 0 }}>🎾 swing-analysis</h2>
        <div style={{ overflow: 'auto', minHeight: 0 }}>
          <VideoPicker
            videoPath={videoPath}
            onPick={async () => {
              const p = await window.api?.pickVideo?.();
              if (p) setVideoPath(p);
            }}
            client={client}
            selectedSeg={selectedSeg}
            activeClip={activeClip}
            clipUrl={clipUrl}
            clipSegment={clipSegment}
            onReturnToOriginal={handleReturnToOriginal}
          />
          {error && <div style={{ color: '#f88', marginTop: 8 }}>❌ {error}</div>}
        </div>
        <ProgressPanel
          state={jobState}
          progress={progress}
          segments={segments.length}
          onStart={startJob}
          onCancel={cancelJob}
          disabled={!videoPath || jobState === 'running'}
        />
        {/* Clips bar — always pinned at the bottom of the left column.
            Wraps to multiple rows so it uses the full left-column width
            instead of squeezing the event log column. */}
        <ClipsBar
          clips={clips}
          segments={segments}
          activeClip={activeClip}
          onSelectClip={handleSelectClip}
          onCleanupClips={handleCleanupClips}
          thumbUrl={thumbUrl}
          jobDone={jobState === 'done' || jobState === 'failed' || jobState === 'cancelled'}
          saveClipsEnabled={params.save_clips}
        />
      </div>

      {/* Right column */}
      <div
        style={{
          borderLeft: '1px solid #333',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <ParamsForm params={params} onChange={setParams} disabled={jobState === 'running'} />
        <ResultsPanel
          client={client}
          jobId={jobId}
          logLines={logLines}
          onClearLog={handleClearLog}
        />
      </div>
    </div>
  );
}