import type { ClipCleanupResult, ClipInfo, JobInfo, JobParams } from './types';

export class SwingClient {
  constructor(public baseUrl: string) {}

  videoUrl(absPath: string): string {
    return `${this.baseUrl}/api/videos?path=${encodeURIComponent(absPath)}`;
  }

  artifactUrl(jobId: string, rel: string): string {
    return `${this.baseUrl}/api/artifacts/${jobId}/${rel}`;
  }

  // ── clips (plan 002) ──────────────────────────────────────────────
  clipStreamUrl(jobId: string, segId: number): string {
    return `${this.baseUrl}/api/jobs/${jobId}/clips/${segId}/stream`;
  }

  clipThumbUrl(jobId: string, segId: number): string {
    return `${this.baseUrl}/api/jobs/${jobId}/clips/${segId}/thumbnail.jpg`;
  }

  async listClips(jobId: string): Promise<ClipInfo[]> {
    const r = await fetch(`${this.baseUrl}/api/jobs/${jobId}/clips`);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`listClips failed: ${r.status} ${t}`);
    }
    return r.json();
  }

  async cleanupClips(jobId: string): Promise<ClipCleanupResult> {
    const r = await fetch(`${this.baseUrl}/api/jobs/${jobId}/clips:cleanup`, { method: 'POST' });
    if (!r.ok) {
      const t = await r.text();
      // pass through status + body so caller can show 409 ("running job")
      // verbatim to the user.
      throw new Error(`cleanupClips failed: ${r.status} ${t}`);
    }
    return r.json();
  }

  async health(): Promise<{ status: string; model_ready: boolean; version: string }> {
    const r = await fetch(`${this.baseUrl}/api/health`);
    if (!r.ok) throw new Error(`health failed: ${r.status}`);
    return r.json();
  }

  async createJob(videoPath: string, params?: JobParams): Promise<{ job_id: string }> {
    const r = await fetch(`${this.baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ video_path: videoPath, params }),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`create job failed: ${r.status} ${t}`);
    }
    return r.json();
  }

  async getJob(jobId: string): Promise<JobInfo> {
    const r = await fetch(`${this.baseUrl}/api/jobs/${jobId}`);
    if (!r.ok) throw new Error(`get job failed: ${r.status}`);
    return r.json();
  }

  async cancel(jobId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/jobs/${jobId}/cancel`, { method: 'POST' });
  }

  async delete(jobId: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/jobs/${jobId}`, { method: 'DELETE' });
  }

  /**
   * Plan 005 — DELETE /api/jobs/{id} with an AbortSignal so the caller's
   * 取消 button can short-circuit the in-flight fetch. We treat 404 as
   * success (job already gone) and AbortError as {ok:false, error:'cancelled'}.
   * Kept on the SwingClient as a general utility — App.tsx now goes
   * through main-process `cleanupClips` instead, but other callers
   * (CLI, future endpoints) can still use this directly.
   */
  async deleteWithSignal(jobId: string, signal: AbortSignal): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${this.baseUrl}/api/jobs/${jobId}`, { method: 'DELETE', signal });
      if (!r.ok && r.status !== 404) {
        const t = await r.text().catch(() => '');
        return { ok: false, error: `HTTP ${r.status}${t ? `: ${t}` : ''}` };
      }
      return { ok: true };
    } catch (e: any) {
      if (e?.name === 'AbortError') return { ok: false, error: 'cancelled' };
      return { ok: false, error: String(e) };
    }
  }

  /** WebSocket event stream — auto-reconnect with resync via GET on reconnect. */
  openEvents(
    jobId: string,
    onEvent: (e: any) => void,
    onClose: () => void,
  ): () => void {
    let ws: WebSocket | null = null;
    let closed = false;
    const url = this.baseUrl.replace(/^http/, 'ws') + `/api/jobs/${jobId}/events`;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(url);
      ws.onmessage = (m) => {
        try { onEvent(JSON.parse(m.data)); } catch { /* ignore */ }
      };
      ws.onclose = () => { if (!closed) { onClose(); setTimeout(connect, 1500); } };
      ws.onerror = () => { ws?.close(); };
    };
    connect();
    return () => { closed = true; ws?.close(); };
  }
}