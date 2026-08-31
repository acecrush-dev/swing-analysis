import type { JobInfo, JobParams } from './types';

export class SwingClient {
  constructor(public baseUrl: string) {}

  videoUrl(absPath: string): string {
    return `${this.baseUrl}/api/videos?path=${encodeURIComponent(absPath)}`;
  }

  artifactUrl(jobId: string, rel: string): string {
    return `${this.baseUrl}/api/artifacts/${jobId}/${rel}`;
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