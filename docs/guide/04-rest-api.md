# 04 · REST API

The service binds to `127.0.0.1:8321` by default. All endpoints are JSON or
WebSocket, except `/api/videos` which streams bytes.

## CORS

Any `http://localhost:*` or `http://127.0.0.1:*` origin is allowed (any port).
This is so the Vite dev server (which defaults to `http://localhost:5173`)
can hit the API during GUI development.

## `GET /api/health`

```bash
curl http://127.0.0.1:8321/api/health
```

```json
{
  "status": "ok",
  "version": "0.1.0",
  "model_ready": true,
  "models_dir": "/abs/path/to/backend/models"
}
```

Use this from the GUI startup to decide whether to spawn a sidecar or
attach to an existing one.

## `POST /api/jobs`

```bash
curl -X POST http://127.0.0.1:8321/api/jobs \
     -H 'Content-Type: application/json' \
     -d '{
           "video_path":"/abs/fdl.mp4",
           "params":{
             "max_frames":1500,
             "save_clips":false,
             "viz_video":true
           }
         }'
```

```json
{ "job_id": "51b71ad9db8b" }
```

`video_path` MUST be absolute. The service does not upload video content;
it just opens the path with OpenCV on the local filesystem. This is the
intentional design for the desktop / LAN scenario. Phase C adds a multipart
`/api/jobs/upload` for browser clients.

`params` is optional. Every field defaults to the same value the CLI uses.
See [03 · CLI Usage](03-cli-usage.md) for field semantics. New since v0.2:

- `clip_bbox` (bool, default false) — overlay RTMDet person bbox on each extracted clip
- `clip_skel` (bool, default false) — overlay pose skeleton on each extracted clip
- `skel_backend` (string, default `"rtmpose"`) — which model draws the
  skeleton overlay: `"rtmpose"` (COCO-13) or `"mediapipe"` (33 points)

Error responses:

| Status | Body | When |
| --- | --- | --- |
| `400` | `{"detail":"video_path 必须是绝对路径"}` | Relative path |
| `404` | `{"detail":"视频不存在: …"}` | Path doesn't exist on disk |
| `500` | (model-load failure) | MediaPipe task missing or corrupt |

## `GET /api/jobs/{id}`

Full state + every emitted segment so far + the final `segments_payload`
once `state == "done"`. Use this to **reconcile after a WebSocket
disconnect** — the WS replay buffer only carries the last 1024 events.

```bash
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b
```

```json
{
  "job_id": "51b71ad9db8b",
  "state": "done",
  "video_path": "/abs/fdl.mp4",
  "params": { /* echo */ },
  "created_at": 1725087600.12,
  "started_at": 1725087600.45,
  "finished_at": 1725087612.78,
  "segments": [ /* final list */ ],
  "segments_payload": { /* full segments.json contents */ }
}
```

States: `queued | running | done | failed | cancelled`.

## `POST /api/jobs/{id}/cancel`

```bash
curl -X POST http://127.0.0.1:8321/api/jobs/51b71ad9db8b/cancel
# {"ok": true}
```

Idempotent. Safe to call on a job that already finished.

## `DELETE /api/jobs/{id}`

```bash
curl -X DELETE http://127.0.0.1:8321/api/jobs/51b71ad9db8b
# {"ok": true}
```

Refuses with `409` if the job is currently `running`. Cancels first, then
re-DELETE. Cleans up `backend/data/jobs/<id>/` on success.

## `WS /api/jobs/{id}/events`

WebSocket endpoint with **event replay**. Late subscribers receive the
buffered history immediately, then live events.

Event types:

| `type` | `data` |
| --- | --- |
| `job.started` | `{video_path}` |
| `pose.progress` | `{phase, frames, total, fps, eta_sec, segments_emitted}` |
| `segment.emitted` | `{segment: Segment}` (one per cycle, in arrival order) |
| `clip.annotated` | `{seg_id, clip_in, clip_annotated, frames, bbox, skel, skel_backend}` (only when `clip_bbox` or `clip_skel` was set; per-clip after annotation finishes) |
| `job.completed` | `{segment_count}` |
| `job.failed` | `{error}` (repr of the exception) |
| `job.cancelled` | `{}` |

Client should send literal `"ping"` every N seconds; server replies
`"pong"` to keep the connection warm.

```python
import asyncio, json, websockets

async def watch(job_id):
    async with websockets.connect(f'ws://127.0.0.1:8321/api/jobs/{job_id}/events') as ws:
        async for msg in ws:
            if msg == 'pong':
                continue
            ev = json.loads(msg)
            if ev['type'] == 'pose.progress':
                print(f"  {ev['data']['frames']}/{ev['data']['total']} fps={ev['data']['fps']:.1f}")
            elif ev['type'] == 'segment.emitted':
                s = ev['data']['segment']
                print(f"  #{s['seg_id']:>3} {s['start_timecode']}→{s['end_timecode']} "
                      f"contact@{s['contact_timecode']} peak={s['peak_velocity']:.3f}")
            elif ev['type'] == 'job.completed':
                print(f"done — {ev['data']['segment_count']} segments")
                break
            elif ev['type'] == 'job.failed':
                print(f"FAILED: {ev['data']['error']}")
                break

asyncio.run(watch('51b71ad9db8b'))
```

## `GET /api/videos?path=<abs>`

Streams the original video file with HTTP Range support.

```bash
# Range request (Chromium <video> uses these for seek)
curl -H 'Range: bytes=0-1023' \
     'http://127.0.0.1:8321/api/videos?path=/abs/fdl.mp4' -o /dev/null -D -
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/25243119
# Accept-Ranges: bytes
# Content-Length: 1024
# Content-Type: video/mp4

# Full request
curl 'http://127.0.0.1:8321/api/videos?path=/abs/fdl.mp4' -o /dev/null -D -
# HTTP/1.1 200 OK
# Accept-Ranges: bytes
# Content-Length: 25243119
```

**Why this exists**: in Electron dev mode the renderer loads from
`http://localhost:5173`, but Chromium blocks `<video src="file://…">` for
security. Proxying the original file through HTTP fixes that *and* gives us
Range for free.

| Status | When |
| --- | --- |
| `200` | No Range header — full body |
| `206` | Range header — partial body |
| `400` | `path` is not absolute |
| `404` | File missing |

## `GET /api/artifacts/{id}/{rel_path:path}`

Static-file serving of generated artifacts.

```bash
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/segments.json -o seg.json
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/clips/clip_001.mp4 -o c1.mp4
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/viz.mp4 -o viz.mp4
```

- `{rel_path}` is constrained under `backend/data/jobs/<id>/` — path
  traversal returns `400`.
- Files only exist if the corresponding flag was set (`save_clips`,
  `viz_video`). Missing files return `404`.
- Annotated clips live alongside the raw ones: `clips/clip_NNN_annotated.mp4`.
- `Content-Type` is derived from extension via `mimetypes.guess_type`.

## Clips (plan 002)

Four endpoints expose per-clip metadata, the H.264 preview stream, the
mid-frame thumbnail, and a server-side wipe. All take the parent
`{job_id}`; clips without one are not addressable.

### `GET /api/jobs/{id}/clips`

List all clips the pipeline produced (filesystem as source of truth).

```bash
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b/clips
```

```json
[
  {
    "seg_id": 1,
    "exists": true,
    "size_bytes": 245760,
    "playable": true,
    "annotated": false,
    "thumb_ready": false
  }
]
```

- `playable` → `clip_NNN_h264.mp4` exists (Chromium can decode H.264 +
  yuv420p + faststart; mp4v is not decodable by Chromium).
- `annotated` → `clip_NNN_annotated.mp4` exists (only when `clip_bbox`
  or `clip_skel` was set).
- `thumb_ready` → `clip_NNN.thumb.jpg` exists on disk (see below).
- Returns `[]` if `clips/` doesn't exist (e.g. the job never had
  `save_clips: true`).
- Returns `404` if the job_id is unknown.

### `GET /api/jobs/{id}/clips/{seg_id}/stream`

Streams the H.264 preview with HTTP Range support (same machinery as
`/api/videos` — partial-content responses for `<video>` seek).

```bash
curl -H 'Range: bytes=0-1023' \
     http://127.0.0.1:8321/api/jobs/51b71ad9db8b/clips/1/stream \
     -o /dev/null -D -
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/245760
# Accept-Ranges: bytes
# Content-Type: video/mp4
```

| Status | When |
| --- | --- |
| `200` / `206` | H.264 preview present — Chromium `<video>` can play |
| `404` | H.264 preview missing (ffmpeg transcode failed) — see [Clip playback](#clip-playback) below for the fallback behaviour |

### `GET /api/jobs/{id}/clips/{seg_id}/thumbnail.jpg`

Lazy-generated mid-frame JPEG. First hit decodes the mp4 with OpenCV,
seeks to the midpoint, and writes `clip_NNN.thumb.jpg` (q=85) to disk;
subsequent hits are served from cache.

```bash
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b/clips/1/thumbnail.jpg -o t.jpg
file t.jpg    # JPEG image data, JFIF standard 1.01, ...
```

| Status | When |
| --- | --- |
| `200` | JPEG served (just-generated or cached) |
| `404` | mp4 missing, or cv2 decode failed |

### `POST /api/jobs/{id}/clips:cleanup`

Wipes the `clips/` subdir for the job. Idempotent: a missing dir returns
`{deleted_count: 0, freed_bytes: 0}`.

```bash
curl -X POST http://127.0.0.1:8321/api/jobs/51b71ad9db8b/clips:cleanup
# {"deleted_count": 12, "freed_bytes": 4816896}
```

| Status | When |
| --- | --- |
| `200` | Wiped (or nothing to wipe) |
| `404` | Unknown job_id |
| `409` | Job state is `queued` or `running` — clips may still be writing; cancel the job first or wait for completion |

The colon in the path (`clips:cleanup`) is deliberate: it keeps the
endpoint from being mistaken for `GET /clips/{seg_id}` by future
routes.

## Clip playback

The pipeline writes each clip as `clip_NNN.mp4` using the OpenCV `mp4v`
fourcc (MPEG-4 Part 2). Chromium's `<video>` element cannot decode
mp4v, so the Electron GUI cannot play these clips in-place.

To make the GUI playable, the service layer transcodes each `clip_NNN.mp4`
into a sibling `clip_NNN_h264.mp4` (H.264 + `yuv420p` + `+faststart`)
right after extraction, using a static ffmpeg binary shipped via the
`imageio-ffmpeg` pip wheel. The mp4v original is kept as the canonical
download artifact; the H.264 copy is what the GUI embeds.

**Fallback behaviour** (when ffmpeg is unavailable or the transcode
fails for any clip):

- The clip stays mp4v-only; the GUI marks the corresponding card with
  `⚠ 原生格式 · 点击跳转原视频`.
- Clicking such a card falls back to **seeking the original video to
  the segment's `start_timecode`** — the original `<video>` plays the
  full file but jumps to the right moment.
- The clip is still downloadable from `clips/clip_NNN.mp4` via the
  `/api/artifacts` endpoint.

This failure mode is **deliberately non-fatal** — the segmentation
pipeline must not be coupled to ffmpeg availability. Every transcode
call is wrapped in `try/except`, and a failed transcode just logs an
`✗` line and leaves the clip as mp4v.

**`clips:cleanup` 409 guard**: the endpoint refuses to wipe clips while
the job is `queued` or `running` (status `409`). The reason: clip
extraction runs on a `ThreadPoolExecutor` background pool, so clips may
still be writing even after the WS `job.completed` event. Cancel first,
or wait for the job to reach a terminal state (`done`/`failed`/
`cancelled`).

## Wire-type summary

| JSON type | Mirrors in `backend/service/schemas.py` |
| --- | --- |
| `JobParams` | every CLI flag |
| `JobCreate` | `{video_path, params?}` |
| `JobAccepted` | `{job_id}` |
| `JobInfo` | full state for `GET` + reconciliation |
| `SegmentOut` | one segment, fields identical to `core.SwingSegment` plus `phases[]` |
| `ClipInfo` | per-clip manifest returned by `GET /clips` |
| `ClipCleanupResult` | `{deleted_count, freed_bytes}` returned by `POST /clips:cleanup` |
| `ProgressEvent` | WS envelope `{type, job_id, data}` |