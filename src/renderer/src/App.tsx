import { useEffect, useMemo, useState } from 'react';
import { SwingClient } from './api/client';
import { DEFAULT_PARAMS, type JobParams, type Segment } from './api/types';
import { VideoPicker } from './components/VideoPicker';
import { ParamsForm } from './components/ParamsForm';
import { ProgressPanel } from './components/ProgressPanel';
import { ResultsPanel } from './components/ResultsPanel';

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

  useEffect(() => {
    (async () => {
      const url = await window.api.getServiceInfo();
      setBaseUrl(url);
    })();
  }, []);

  const client = useMemo(() => baseUrl ? new SwingClient(baseUrl) : null, [baseUrl]);

  const startJob = async () => {
    if (!client || !videoPath) return;
    setError(null);
    setSegments([]);
    setSelectedSeg(null);
    setProgress(null);
    setJobState('queued');
    try {
      const r = await client.createJob(videoPath, params);
      setJobId(r.job_id);
      setJobState('running');
      const close = client.openEvents(
        r.job_id,
        (e: any) => {
          if (e.type === 'pose.progress') setProgress(e.data);
          if (e.type === 'segment.emitted') setSegments((s) => [...s, e.data.segment]);
          if (e.type === 'job.completed') setJobState('done');
          if (e.type === 'job.failed') { setJobState('failed'); setError(e.data.error); }
          if (e.type === 'job.cancelled') setJobState('cancelled');
        },
        () => {
          // reconnect → resync from /api/jobs/{id}
          if (!client) return;
          client.getJob(r.job_id).then((info) => {
            setJobState(info.state);
            setSegments(info.segments);
          });
        }
      );
      // store cleanup for cancel button
      (window as any).__closeWs = close;
    } catch (e: any) {
      setError(String(e));
      setJobState('failed');
    }
  };

  const cancelJob = async () => {
    if (!client || !jobId) return;
    (window as any).__closeWs?.();
    await client.cancel(jobId);
  };

  if (!baseUrl) return <div style={{ padding: 24 }}>⏳ 等待 sidecar 服务启动…</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', height: '100vh', fontFamily: 'system-ui', color: '#eee', background: '#1a1a1a' }}>
      <div style={{ display: 'flex', flexDirection: 'column', padding: 16, overflow: 'auto' }}>
        <h2 style={{ margin: '0 0 12px' }}>🎾 swing-analysis</h2>
        <VideoPicker
          videoPath={videoPath}
          onPick={async () => {
            const p = await window.api.pickVideo();
            if (p) setVideoPath(p);
          }}
          client={client}
          selectedSeg={selectedSeg}
        />
        {error && <div style={{ color: '#f88', margin: '12px 0' }}>❌ {error}</div>}
        <ProgressPanel state={jobState} progress={progress} segments={segments.length}
                       onStart={startJob} onCancel={cancelJob} disabled={!videoPath || jobState === 'running'} />
      </div>
      <div style={{ borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
        <ParamsForm params={params} onChange={setParams} disabled={jobState === 'running'} />
        <ResultsPanel
          client={client}
          jobId={jobId}
          segments={segments}
          fps={progress?.fps ?? 0}
          onSelect={setSelectedSeg}
        />
      </div>
    </div>
  );
}