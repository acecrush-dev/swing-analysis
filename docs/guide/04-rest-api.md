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

## Wire-type summary

| JSON type | Mirrors in `backend/service/schemas.py` |
| --- | --- |
| `JobParams` | every CLI flag |
| `JobCreate` | `{video_path, params?}` |
| `JobAccepted` | `{job_id}` |
| `JobInfo` | full state for `GET` + reconciliation |
| `SegmentOut` | one segment, fields identical to `core.SwingSegment` plus `phases[]` |
| `ProgressEvent` | WS envelope `{type, job_id, data}` |