import { useEffect, useMemo, useRef, useState } from 'react';
import { SwingClient } from './api/client';
import { DEFAULT_PARAMS, type ClipInfo, type ClipProcessingState, type JobParams, type Segment } from './api/types';
import { VideoPicker } from './components/VideoPicker';
import { ParamsForm } from './components/ParamsForm';
import { ProgressPanel } from './components/ProgressPanel';
import { ResultsPanel } from './components/ResultsPanel';
import { ClipsBar } from './components/ClipsBar';
import { ResultsActionsBar } from './components/ResultsActionsBar';
import { useTheme } from './hooks/theme';
import { HelpPanel } from './components/HelpPanel';
import { SettingsPanel, loadColors } from './components/SettingsPanel';
import { Tooltip } from './components/Tooltip';
import { ToastHost, toast } from './components/Toast';
import { BusyModal } from './components/BusyModal';
import { usePanelSync } from './hooks/usePanelSync';
import type { PanelStateSnapshot } from './api/panels';
import { useI18n, toggleLocale, getLocale } from './i18n';
import * as busy from './busy';
import type { BusyState } from './busy';
import { StatusBar } from './components/StatusBar';
import './api/electron-api';

// Allowed video extensions (kept in sync with the dialog filter on the
// main-process side). Anything dropped that doesn't match is rejected
// with a friendly error instead of being shoved into the pipeline.

// Unified header icon-button style — same width / height / padding so
// the three controls in the top-right (help / locale / theme) line up
// in a tidy row. Slightly bigger than the original 26×26 because the
// EN/中 glyph needs a bit more room than a single emoji.
const HEADER_BTN_SIZE = 32;
const headerBtn: React.CSSProperties = {
  background: 'var(--bg-elev)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  width: HEADER_BTN_SIZE,
  height: HEADER_BTN_SIZE,
  padding: 0,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};
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
  const { t } = useI18n();
  const [, forceI18n] = useState(0);
  // Re-render App when locale flips so the locale badge stays current.
  useEffect(() => {
    const handler = () => forceI18n((n) => n + 1);
    window.addEventListener('localechange', handler);
    return () => window.removeEventListener('localechange', handler);
  }, []);
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
  // Settings overlay — owns the four annotation colours. Persisted to
  // localStorage by SettingsPanel; here we just track the live values
  // so we can bake them into the next job's params.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [colors, setColors] = useState(() => loadColors());

  // Plan 005 — busy modal state. null = no modal; otherwise a BusyState
  // describes the kind/title/callId of the in-flight long op.
  const [busyState, setBusyState] = useState<BusyState | null>(null);
  const [iconUrl, setIconUrl] = useState<string | null>(null);

  // Wire the imperative busy.startBusy() API into React state.
  useEffect(() => { busy.setBusyCallback(setBusyState); }, []);

  // Fetch the app-icon data URL once on mount; the BusyModal uses it
  // as the logo in its centred card.
  useEffect(() => {
    let cancelled = false;
    window.api?.getIconDataUrl?.()
      ?.then((u) => { if (!cancelled) setIconUrl(u); })
      ?.catch(() => { /* fallback emoji */ });
    return () => { cancelled = true; };
  }, []);

  // Swallow ESC while the modal is open — the user must explicitly
  // click 取消 to abort the IPC. Default ESC handler in the renderer
  // closes HelpPanel/SettingsPanel; we add our own handler above that
  // so the modal swallows the key when busy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busyState) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busyState]);

  // Per-artifact existence flags. Populated by HEAD probes after the
  // job reaches done. The right panel uses these to hide download links
  // and the viz-play button that would 404 anyway.
  // `vizH264` is true when the backend also wrote a sibling
  // viz_h264.mp4 (post-receipt 039 transcode); the `<video>` element
  // uses that one because Chromium cannot decode the cv2-written
  // mp4v fourcc inside viz.mp4. When vizH264=false we still keep
  // `viz` true (download link works) but the in-GUI player just
  // won't have anything playable.
  const [artifacts, setArtifacts] = useState<{
    segmentsJson: boolean;
    viz: boolean;
    vizH264: boolean;
    clips: boolean;
  }>({ segmentsJson: false, viz: false, vizH264: false, clips: false });

  // Sorted-clips view used for BOTH the ClipsBar render and the panel
  // snapshot. Concurrent annotations can finish out of seg_id order
  // (max_workers=2), and the WS `clip.generated` events arrive in
  // completion order; rendering them in that order looks like the
  // clips appear shuffled. Sort once, here, so both surfaces agree.
  const sortedClips = useMemo(
    () => clips.slice().sort((a, b) => a.seg_id - b.seg_id),
    [clips],
  );

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
        setError(t('status.err.getServiceInfo', { err: String(e) }));
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
          pushLog(t('status.menuOpened', { path: p }));
        }
      })();
    });
    const offExport = window.api.onMenuEvent('menu:export-package', () => {
      handleExportPackage();
    });
    const offAbout = window.api.onMenuEvent('menu:about', () => {
      window.api?.showAbout?.();
    });
    const offClearJob = window.api.onMenuEvent('menu:clear-job', () => {
      deleteJob();
    });
    const offClearOutput = window.api.onMenuEvent('menu:clear-output', () => {
      (async () => {
        if (!window.api?.clearOutputDir) return;
        const handle = busy.startBusy('clear-output-dir', t('busy.title.clear-output-dir'));
        const r = await window.api.clearOutputDir(handle.callId);
        if (r.ok) {
          pushLog(t('status.outputCleared', { path: r.path, n: r.deleted_count }));
          // Always reset the React side after a successful wipe — the
          // cleared_job_ids check was leaving the UI in a half-state
          // when the user's current jobId didn't happen to match one
          // of the just-deleted IDs (e.g. the IPC wiped every other
          // job but ours wasn't tracked yet). Resetting unconditionally
          // mirrors what the user expects: "clean output → fresh start".
          (window as any).__closeWs?.();
          resetJobState();
          handle.finish(true);
        } else if (r.error === 'cancelled') {
          handle.finish(false);
        } else {
          setError(t('status.clearOutputFail', { err: r.error }));
          handle.finish(false, t('busy.fail', { err: r.error }));
        }
      })();
    });
    return () => { offOpen(); offExport(); offAbout(); offClearJob(); offClearOutput(); };
  }, []);

  const client = useMemo(() => baseUrl ? new SwingClient(baseUrl) : null, [baseUrl]);

  // Plan 004 — push a debounced snapshot to detached panel windows and
  // receive actions back from them (select-clip / clear-log / cleanup-
  // clips / closed). `sortedClips` (above) is used here so the panel
  // window also renders clips in pipeline order, not arrival order.
  //
  // Plan 005 — also carries `busy` so detached panel windows can dim
  // + pointer-events:none while the main window is running a long op.
  const snapshot: PanelStateSnapshot = useMemo(() => ({
    theme,
    baseUrl,
    jobId,
    videoPath,
    jobState,
    saveClipsEnabled: params.save_clips,
    clips: sortedClips,
    segments,
    activeClip,
    clipProc,
    logLines,
    busy: busyState,
  }), [theme, baseUrl, jobId, videoPath, jobState, params.save_clips, sortedClips, segments, activeClip, clipProc, logLines, busyState]);

  const detachClips = () => { window.api?.openPanel?.('clips'); };
  const recallClips = () => { window.api?.closePanel?.('clips'); };
  const detachLog = () => { window.api?.openPanel?.('log'); };
  const recallLog = () => { window.api?.closePanel?.('log'); };

  const { panelOpen } = usePanelSync(snapshot, (a) => {
    if (!a || typeof a !== 'object') return;
    if (a.type === 'select-clip') {
      const segId = (a as { seg_id?: number }).seg_id;
      if (typeof segId === 'number') {
        const c = clips.find((x) => x.seg_id === segId);
        if (c) handleSelectClip(c);
      }
    } else if (a.type === 'clear-log') {
      setLogLines([]);
    } else if (a.type === 'cleanup-clips') {
      handleCleanupClips();
    }
    // 'closed' is handled inside usePanelSync itself (panelOpen flag).
  });

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
      // Bake the latest annotation colours into the job params. We read
      // `colors` from state on every start, so any change in the
      // Settings panel takes effect on the NEXT job without a restart.
      const r = await client.createJob(videoPath, { ...params, ...colors });
      setJobId(r.job_id);
      setJobState('running');
      pushLog(t('status.jobStart', { id: r.job_id, flag: String(params.save_clips) }));
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
                pushLog(t('status.poseProgress', {
                  frames: d.frames, total: d.total,
                  fps: d.fps.toFixed(1), emit: d.segments_emitted ?? 0,
                }));
              }
            }
            if (e.type === 'segment.emitted') {
              const seg = data.segment;
              if (!seg) return;
              setSegments((s) => [...s, seg]);
              pushLog(t('status.segmentEmitted', {
                id: seg.seg_id,
                start: seg.start_timecode ?? '?',
                end: seg.end_timecode ?? '?',
                contact: seg.contact_timecode ?? '?',
              }));
            }
            if (e.type === 'clip.annotated') {
              pushLog(t('status.clipAnnotated', { id: data.seg_id }));
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
                pushLog(t('status.clipGenerated', {
                  id: info.seg_id,
                  h264: info.playable ? t('status.h264Yes') : t('status.h264No'),
                }));
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
              pushLog(t('status.jobDone', { n: data.segment_count ?? '?' }));
              toast.success(t('toast.jobDone', { n: data.segment_count ?? '?' }));
            }
            if (e.type === 'job.failed') {
              setJobState('failed');
              setClipProc({});
              const msg = String(data.error ?? 'unknown');
              setError(msg);
              pushLog(t('status.jobFail', { err: msg }));
              toast.error(t('toast.jobFail', { err: msg }));
            }
            if (e.type === 'job.cancelled') {
              setJobState('cancelled');
              setClipProc({});
              pushLog(t('status.jobCancel'));
              toast.info(t('toast.jobCancel'));
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
              pushLog(t('status.wsReconnect', { state: info.state, n: (info.segments ?? []).length }));
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
      pushLog(t('status.err.createFail', { err: String(e) }));
    }
  };

  const cancelJob = async () => {
    if (!client || !jobId) return;
    try {
      await client.cancel(jobId);
      // Immediate visible feedback — the cancel is async (the pipeline
      // stops at the next frame boundary), so without this the button
      // can feel dead/unresponsive.
      toast.info(t('toast.cancelSent'));
      pushLog(t('status.cancelSent'));
    } catch (e: any) {
      setError(String(e));
      pushLog(t('status.cancelFail', { err: String(e) }));
    }
  };

  // Wipe every job-related React state back to "nothing here, ready
  // for the next video". Shared by all three cleanup paths (the
  // toolbar 🗑 Delete button, the ClipsBar 🧹 Cleanup button, and
  // the System → Clear Output Dir menu) so they all leave the GUI
  // looking identical: empty events log context, no selected segment,
  // no clips cards, no viz button enabled, no stale job_id sitting
  // around that the WS would re-attach to.
  const resetJobState = () => {
    setJobId(null);
    setSegments([]);
    setSelectedSeg(null);
    setClips([]);
    setActiveClip(null);
    setProgress(null);
    setClipProc({});
    setVizMode(false);
    setJobState('idle');
  };

  // Delete the entire job — wipes /api/data/jobs/{id} from disk.
  const deleteJob = async () => {
    if (!client || !jobId) return;
    if (jobState === 'running' || jobState === 'queued') {
      toast.warning(t('toast.deleteBusy', { state: jobState }));
      return;
    }
    if (!window.confirm(t('status.confirmDeleteJob', { id: jobId }))) return;
    try {
      await client.delete(jobId);
      // Close the live WS if any
      (window as any).__closeWs?.();
      pushLog(t('status.deleted', { id: jobId }));
      resetJobState();
    } catch (e: any) {
      setError(String(e));
      pushLog(t('status.deleteFail', { err: String(e) }));
    }
  };

  useEffect(() => {
    if (!client || !jobId) return;
    if (jobState !== 'done') return;
    client.listClips(jobId)
      .then((cs) => setClips(Array.isArray(cs) ? cs : []))
      .catch((e) => setError(t('status.err.listClips', { err: String(e) })));
  }, [client, jobId, jobState]);

  // HEAD-probe each artifact once the job reaches a terminal state.
  // Cancelling used to flip everything back to "false" and grey the
  // "viz" button even when Pass 2 had already written viz.mp4 to disk
  // before the cancel landed — Pass 1.5 (clip flush, see receipt 027)
  // means a cancel mid-Pass-2 is a real flow. Now we probe on done /
  // failed / cancelled and let the HEAD response speak. We still skip
  // while the job is running to avoid hammering the server per-frame.
  useEffect(() => {
    if (!client || !jobId) {
      setArtifacts({ segmentsJson: false, viz: false, vizH264: false, clips: false });
      return;
    }
    if (jobState !== 'done' && jobState !== 'failed' && jobState !== 'cancelled') {
      // Pre-terminal: assume nothing is on disk yet. The probe effect
      // re-runs the moment state flips to a terminal.
      setArtifacts({ segmentsJson: false, viz: false, vizH264: false, clips: false });
      return;
    }
    let cancelled = false;
    // Probes with `GET` + `Range: bytes=0-0` instead of `HEAD` because
    // FastAPI's `@app.get(...)` route does NOT advertise `HEAD` — a
    // HEAD request returns 405 Method Not Allowed, r.ok is false, and
    // the probe silently fails. Range GET returns 206 Partial Content
    // (still 2xx so r.ok is true) with just 1 byte so we don't pull
    // the whole 13 MB viz.mp4 just to learn it exists.
    const headOk = async (rel: string): Promise<boolean> => {
      try {
        const r = await fetch(client.artifactUrl(jobId, rel), {
          headers: { Range: 'bytes=0-0' },
        });
        return r.ok || r.status === 206;
      } catch {
        return false;
      }
    };
    (async () => {
      try {
        const [segmentsJson, viz, vizH264, clips] = await Promise.all([
          headOk('segments.json'),
          headOk('viz.mp4'),
          headOk('viz_h264.mp4'),
          client.listClips(jobId).then((cs) => Array.isArray(cs) && cs.length > 0).catch(() => false),
        ]);
        if (!cancelled) setArtifacts({ segmentsJson, viz, vizH264, clips });
      } catch {
        if (!cancelled) setArtifacts({ segmentsJson: false, viz: false, vizH264: false, clips: false });
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

  // Cleanup button in the ClipsBar — full job wipe, same endpoint
  // as the toolbar 🗑 Delete-job button. The previous behavior only
  // deleted the `clips/` subdirectory, leaving viz.mp4 + segments.json
  // on disk and the React state stale; the user expects "clean" to
  // mean "everything gone, UI refreshed". This now mirrors `deleteJob`
  // — we keep the entry points separate because the ClipsBar is the
  // natural place to click it (next to the clips it cleans up).
  //
  // Plan 005 — now goes through the new `cleanupClips` IPC instead of
  // calling `client.delete` directly. The IPC accepts a callId-cancel
  // so the user can 取消 mid-wipe; the main process forwards the
  // abort signal to the sidecar fetch.
  const handleCleanupClips = async () => {
    if (!client || !jobId) return;
    if (jobState === 'running' || jobState === 'queued') {
      toast.warning(t('toast.cleanupBusy', { state: jobState }));
      return;
    }
    if (!window.confirm(t('status.confirmCleanup'))) return;
    if (!window.api?.cleanupClips) {
      // Preload missing this method — fall back to the legacy direct
      // delete so old builds still work (will show no modal).
      try {
        await client.delete(jobId);
        (window as any).__closeWs?.();
        pushLog(t('status.cleanupDone', { n: 0, kb: '0.0' }));
        resetJobState();
      } catch (e: any) {
        setError(String(e));
        pushLog(t('status.cleanupFail', { err: String(e) }));
      }
      return;
    }
    const handle = busy.startBusy('cleanup-clips', t('busy.title.cleanup-clips'));
    const r = await window.api.cleanupClips(jobId, handle.callId);
    if (r.ok) {
      (window as any).__closeWs?.();
      pushLog(t('status.cleanupDone', { n: 0, kb: '0.0' }));
      resetJobState();
      handle.finish(true);
    } else if (r.error === 'cancelled') {
      handle.finish(false);
    } else {
      setError(t('status.cleanupFail', { err: r.error }));
      handle.finish(false, t('busy.fail', { err: r.error }));
    }
  };

  const handleClearLog = () => setLogLines([]);

  // Zip the active job's outputs into a single file the user can pass
  // around. IPC goes to the main process which uses archiver to walk
  // the job directory.
  //
  // Plan 005 — wrapped in a busy modal with callId-cancel; the main
  // process aborts the underlying archiver and unlinks the half-zip.
  const handleExportPackage = async () => {
    if (!jobId) {
      setError(t('status.noExport'));
      return;
    }
    if (jobState === 'running' || jobState === 'queued') {
      toast.warning(t('toast.exportBusy', { state: jobState }));
      return;
    }
    if (!window.api?.exportPackage) {
      setError(t('status.noExportApi'));
      return;
    }
    const handle = busy.startBusy('export-package', t('busy.title.export-package'));
    try {
      const res = await window.api.exportPackage(jobId, handle.callId);
      if (res.ok) {
        pushLog(t('status.opened', { path: String(res.path ?? '') }));
        setError(null);
        handle.finish(true);
      } else if (res.error === 'cancelled') {
        handle.finish(false);
      } else {
        setError(t('status.exportFail', { err: String(res.error ?? '') }));
        handle.finish(false, t('busy.fail', { err: String(res.error ?? '') }));
      }
    } catch (e: any) {
      setError(t('status.exportFail', { err: String(e) }));
      handle.finish(false, t('busy.fail', { err: String(e) }));
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
      setError(t('status.noDropPath'));
      return;
    }
    if (!isVideoPath(p)) {
      const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '?').toLowerCase();
      setError(t('status.badExt', { ext, list: VIDEO_EXTS.map((e) => '.' + e).join(' / ') }));
      return;
    }
    setError(null);
    setVideoPath(p);
    pushLog(t('status.dropped', { path: p }));
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
      setError(t('status.noFile'));
      return;
    }
    if (files.length > 1) {
      setError(t('status.multiDrop'));
      return;
    }
    handleDroppedFile(files[0]);
  };

  if (!baseUrl) return <div style={{ padding: 24 }}>{t('status.waitSidecar')}</div>;

  const clipSegment = activeClip
    ? segments.find((s) => s.seg_id === activeClip.seg_id) ?? null
    : null;
  // Priority for video src:
  //   1. vizMode on → viz_h264.mp4 (Chromium can't decode the cv2-written
  //      mp4v inside viz.mp4 on macOS/Linux; the backend also writes a
  //      sibling viz_h264.mp4 after Pass 2 — prefer it for in-place play).
  //      Falls back to viz.mp4 when the transcode didn't run (no ffmpeg).
  //   2. active clip → clip stream (if playable) else original
  //   3. selectedSeg / no active → original video
  let videoSrc: string | null = null;
  if (vizMode && client && jobId) {
    videoSrc = artifacts.vizH264
      ? client.artifactUrl(jobId, 'viz_h264.mp4')
      : client.artifactUrl(jobId, 'viz.mp4');
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
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        fontFamily: 'system-ui',
        color: 'var(--text)',
        background: 'var(--bg)',
      }}
    >
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 360px',
        flex: 1,
        minHeight: 0,
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
          {t('app.dropHint')}
        </div>
      )}
      {/* Left column — title → video → progress → actions toolbar → clips (pinned) */}
      <div
        style={{
          display: 'grid',
          gridTemplateRows: 'auto 1fr auto auto auto',
          padding: 16,
          gap: 8,
          minHeight: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>{t('app.title')}</h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Tooltip text={t('app.help')}>
              <button
                onClick={() => setHelpOpen(true)}
                style={headerBtn}
              >
                ?
              </button>
            </Tooltip>
            <Tooltip text={t('app.settings')}>
              <button
                onClick={() => setSettingsOpen(true)}
                style={headerBtn}
              >
                ⚙
              </button>
            </Tooltip>
            <Tooltip text={t('app.locale.switch')}>
              <button
                onClick={() => toggleLocale()}
                style={headerBtn}
              >
                {getLocale() === 'zh' ? '中' : 'EN'}
              </button>
            </Tooltip>
            <Tooltip text={theme === 'dark' ? t('app.theme.toDark') : t('app.theme.toLight')}>
              <button
                onClick={toggle}
                style={headerBtn}
              >
                {theme === 'dark' ? '🌙' : '☀️'}
              </button>
            </Tooltip>
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
        {/* Per-job actions toolbar — moved out of the right-column
            ResultsPanel footer so it sits next to the segments / clips
            it acts on (between the segmentation panel and the clips
            grid). Sibling-level placement keeps it visually separated
            from the progress controls above. */}
        <ResultsActionsBar
          client={client}
          jobId={jobId}
          vizMode={vizMode}
          onToggleViz={() => setVizMode((v) => !v)}
          vizAvailable={artifacts.viz}
          vizH264Available={artifacts.vizH264}
          segmentsJsonAvailable={artifacts.segmentsJson}
          clipsAvailable={artifacts.clips}
          onOpenDir={async (id) => {
            if (!window.api?.openOutputDir) return;
            const handle = busy.startBusy('open-output-dir', t('busy.title.open-output-dir'));
            const r = await window.api.openOutputDir(id, handle.callId);
            if (r && !r.ok) {
              if (r.error === 'cancelled') {
                handle.finish(false);
              } else {
                // eslint-disable-next-line no-alert
                alert(t('btn.openDir.fail') + r.error);
                handle.finish(false, t('busy.fail', { err: r.error }));
              }
            } else {
              handle.finish(true);
            }
          }}
          onExportPackage={handleExportPackage}
          onDeleteJob={deleteJob}
        />
        <ClipsBar
          clips={sortedClips}
          segments={segments}
          activeClip={activeClip}
          onSelectClip={handleSelectClip}
          onCleanupClips={handleCleanupClips}
          thumbUrl={thumbUrl}
          jobDone={jobState === 'done' || jobState === 'failed' || jobState === 'cancelled'}
          saveClipsEnabled={params.save_clips}
          jobRunning={jobState === 'running' || jobState === 'queued'}
          detached={panelOpen.clips}
          onDetach={detachClips}
          onRecall={recallClips}
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
          jobId={jobId}
          logLines={logLines}
          onClearLog={handleClearLog}
          logDetached={panelOpen.log}
          onDetachLog={detachLog}
          onRecallLog={recallLog}
        />
      </div>

      {/* Toast host — fixed-position notifications under the title row. */}
      <ToastHost />

      {/* Help overlay — sits above everything */}
      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}

      {/* Settings overlay — annotation colours */}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => setSettingsOpen(false)}
          onChange={(c) => setColors(c)}
        />
      )}

      {/* Plan 005 — busy modal. zIndex 5000 puts it above Help/Settings/
          Toast so any in-flight long op visually monopolises the UI. */}
      {busyState && (
        <BusyModal
          busy={busyState}
          iconUrl={iconUrl}
          onCancel={() => window.api?.cancelCall?.(busyState.callId)}
          t={t}
        />
      )}
    </div>

      {/* Persistent bottom strip showing sidecar status + last few log
          lines. Always visible so the user can see model state at a
          glance even after the splash closes. */}
      <StatusBar />
    </div>
  );
}