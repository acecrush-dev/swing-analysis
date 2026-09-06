/**
 * swing-media:// URL builder for ts backend mode.
 *
 * ts mode has no python sidecar, so there is no /api/videos HTTP stream.
 * The main process registers a read-only `swing-media://local/<encoded>`
 * scheme (see src/main/index.ts) that streams local video files with
 * HTTP Range support, letting <video> seek exactly like the sidecar
 * path. Python mode never calls this — its video/thumb URLs keep coming
 * from SwingClient's http endpoints.
 */
export function mediaUrl(absPath: string): string {
  return 'swing-media://local/' + encodeURIComponent(absPath);
}
