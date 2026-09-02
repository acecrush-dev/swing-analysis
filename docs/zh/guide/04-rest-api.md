# 04 · REST API

服务默认绑 `127.0.0.1:8321`。所有端点都是 JSON 或 WebSocket,只有
`/api/videos` 走字节流。

## CORS

任何 `http://localhost:*` 或 `http://127.0.0.1:*` origin (任意端口) 都
允许。这样 GUI 开发时 Vite dev server (默认 `http://localhost:5173`) 能直
接打到 API。

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

GUI 启动时用这个端点判断是 spawn 一个 sidecar 还是 attach 已有的实例。

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

`video_path` **必须绝对**。服务不上传视频内容,只是用 OpenCV 在本地
打开路径。这是桌面 / LAN 场景的刻意设计。Phase C 会加 multipart
`/api/jobs/upload` 给浏览器客户端用。

`params` 可选。每字段默认值与 CLI 一致。字段语义见
[03 · CLI 用法](03-cli-usage.md)。v0.2 新增:

- `clip_bbox` (bool, 默认 false) —— 在每个抽出的 clip 上叠加 RTMDet 人物框
- `clip_skel` (bool, 默认 false) —— 在每个抽出的 clip 上叠加姿态骨架
- `skel_backend` (string, 默认 `"rtmpose"`) —— 画骨架用哪个模型:
  `"rtmpose"` (COCO-13) 或 `"mediapipe"` (33 点)

错误响应:

| 状态 | body | 何时 |
| --- | --- | --- |
| `400` | `{"detail":"video_path 必须是绝对路径"}` | 相对路径 |
| `404` | `{"detail":"视频不存在: …"}` | 路径在磁盘上不存在 |
| `500` | (模型加载失败) | MediaPipe task 丢失或损坏 |

## `GET /api/jobs/{id}`

完整状态 + 至此所有已 emit 的 segment + `state == "done"` 后的完整
`segments_payload`。**WS 断线重连后用这个对账** —— WS 回放缓冲只保留最
近 1024 条事件。

```bash
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b
```

```json
{
  "job_id": "51b71ad9db8b",
  "state": "done",
  "video_path": "/abs/fdl.mp4",
  "params": { /* 回显 */ },
  "created_at": 1725087600.12,
  "started_at": 1725087600.45,
  "finished_at": 1725087612.78,
  "segments": [ /* 最终列表 */ ],
  "segments_payload": { /* 完整 segments.json 内容 */ }
}
```

状态机:`queued | running | done | failed | cancelled`。

## `POST /api/jobs/{id}/cancel`

```bash
curl -X POST http://127.0.0.1:8321/api/jobs/51b71ad9db8b/cancel
# {"ok": true}
```

幂等。对已完成的 job 调用也安全。

## `DELETE /api/jobs/{id}`

```bash
curl -X DELETE http://127.0.0.1:8321/api/jobs/51b71ad9db8b
# {"ok": true}
```

job 当前是 `running` 时拒 (`409`)。先 cancel 再 DELETE。成功后清理
`backend/data/jobs/<id>/`。

## `WS /api/jobs/{id}/events`

带**事件回放**的 WebSocket 端点。晚到的订阅者先收到缓冲的历史,然后
是 live 事件。

事件类型:

| `type` | `data` |
| --- | --- |
| `job.started` | `{video_path}` |
| `pose.progress` | `{phase, frames, total, fps, eta_sec, segments_emitted}` |
| `segment.emitted` | `{segment: Segment}` (每段一条,按到达顺序) |
| `clip.annotated` | `{seg_id, clip_in, clip_annotated, frames, bbox, skel, skel_backend}` (仅当 `clip_bbox` 或 `clip_skel` 开启;每段标注完成后发一次) |
| `job.completed` | `{segment_count}` |
| `job.failed` | `{error}` (异常 repr) |
| `job.cancelled` | `{}` |

客户端可以每 N 秒发一个字面量 `"ping"`;服务端回 `"pong"` 保活。

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

流式输出原始视频,支持 HTTP Range。

```bash
# Range 请求 (Chromium <video> 拖动 seek 用的就是这个)
curl -H 'Range: bytes=0-1023' \
     'http://127.0.0.1:8321/api/videos?path=/abs/fdl.mp4' -o /dev/null -D -
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/25243119
# Accept-Ranges: bytes
# Content-Length: 1024
# Content-Type: video/mp4

# 全量请求
curl 'http://127.0.0.1:8321/api/videos?path=/abs/fdl.mp4' -o /dev/null -D -
# HTTP/1.1 200 OK
# Accept-Ranges: bytes
# Content-Length: 25243119
```

**为什么有这个端点**:Electron dev 模式下 renderer 从
`http://localhost:5173` 加载,而 Chromium 因为安全策略拦
`<video src="file://…">`。把原视频通过 HTTP 代理出去既绕开这道坎,又白
送 Range 支持。

| 状态 | 何时 |
| --- | --- |
| `200` | 无 Range —— 整段 |
| `206` | 有 Range —— 切片 |
| `400` | `path` 非绝对 |
| `404` | 文件缺失 |

## `GET /api/artifacts/{id}/{rel_path:path}`

静态文件服务,输出生成的产物。

```bash
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/segments.json -o seg.json
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/clips/clip_001.mp4 -o c1.mp4
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/viz.mp4 -o viz.mp4
```

- `{rel_path}` 被约束在 `backend/data/jobs/<id>/` 下 —— 路径穿越返 `400`
- 文件仅在对应 flag 开启 (`save_clips`、`viz_video`) 时存在;缺失返 `404`
- 标注后的 clip 与原 clip 同目录:`clips/clip_NNN_annotated.mp4`
- `Content-Type` 由 `mimetypes.guess_type` 按扩展名推断

## Clips (plan 002)

四个端点暴露每段 clip 的元数据、H.264 预览流、中点帧缩略图，以及一个
服务端清空接口。全部带父 `{job_id}`;无 `{job_id}` 的 clip 不可寻址。

### `GET /api/jobs/{id}/clips`

列出管线产出的全部 clip（文件系统为唯一真值）。

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

- `playable` → `clip_NNN_h264.mp4` 存在（Chromium 能解 H.264 + yuv420p + faststart;mp4v 解不出）
- `annotated` → `clip_NNN_annotated.mp4` 存在（仅当 `clip_bbox` 或 `clip_skel` 开启）
- `thumb_ready` → `clip_NNN.thumb.jpg` 已落盘（见下）
- `clips/` 不存在时返回 `[]`（如该 job 没开 `save_clips: true`）
- `job_id` 未知返回 `404`

### `GET /api/jobs/{id}/clips/{seg_id}/stream`

流式输出 H.264 预览,支持 HTTP Range（与 `/api/videos` 同套机制 —— 给 `<video>` 拖动 seek 用的切片响应）。

```bash
curl -H 'Range: bytes=0-1023' \
     http://127.0.0.1:8321/api/jobs/51b71ad9db8b/clips/1/stream \
     -o /dev/null -D -
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/245760
# Accept-Ranges: bytes
# Content-Type: video/mp4
```

| 状态 | 何时 |
| --- | --- |
| `200` / `206` | H.264 预览存在 —— Chromium `<video>` 可播放 |
| `404` | H.264 预览缺失（ffmpeg 转码失败）—— 降级行为见下方 [Clip 播放](#clip-播放) |

### `GET /api/jobs/{id}/clips/{seg_id}/thumbnail.jpg`

懒生成的中点帧 JPEG。首次请求用 OpenCV 解 mp4、跳到中点、写出
`clip_NNN.thumb.jpg`（q=85）落盘;之后直接走磁盘缓存。

```bash
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b/clips/1/thumbnail.jpg -o t.jpg
file t.jpg    # JPEG image data, JFIF standard 1.01, ...
```

| 状态 | 何时 |
| --- | --- |
| `200` | 返回 JPEG（刚生成或已缓存） |
| `404` | mp4 缺失,或 cv2 解码失败 |

### `POST /api/jobs/{id}/clips:cleanup`

清空 job 的 `clips/` 子目录。幂等:目录不存在返回
`{deleted_count: 0, freed_bytes: 0}`。

```bash
curl -X POST http://127.0.0.1:8321/api/jobs/51b71ad9db8b/clips:cleanup
# {"deleted_count": 12, "freed_bytes": 4816896}
```

| 状态 | 何时 |
| --- | --- |
| `200` | 已清空（或本来就空） |
| `404` | `job_id` 未知 |
| `409` | job 状态为 `queued` 或 `running` —— clip 可能还在写入;先 cancel 或等待完成 |

路径里的冒号（`clips:cleanup`）是刻意的:防止后续 `GET /clips/{seg_id}` 类路由把它误当成 seg_id。

## Clip 播放

管线用 OpenCV `mp4v` fourcc（MPEG-4 Part 2）写出每个
`clip_NNN.mp4`。Chromium 的 `<video>` 解不了 mp4v,所以 Electron GUI
没法直接内嵌播。

为了让 GUI 能播,service 层在抽完 clip 后立刻把它转成同目录的
`clip_NNN_h264.mp4`（H.264 + `yuv420p` + `+faststart`），用的 ffmpeg
二进制由 `imageio-ffmpeg` pip wheel 自带（无需系统装）。mp4v 原件
保留为 canonical 下载产物;GUI 内嵌的是 H.264 副本。

**降级行为**（ffmpeg 不可用或转码失败时）：

- 该 clip 只剩 mp4v;GUI 在对应卡片上标 `⚠ 原生格式 · 点击跳转原视频`
- 点这种卡片会**回退到原视频按 start_timecode seek** —— 原 `<video>`
  仍在播整段文件,但跳到对应时刻
- 该 clip 仍可通过 `/api/artifacts` 端点下载 (`clips/clip_NNN.mp4`)

这个失败模式是**刻意非致命的** —— segmentation 管线不能绑死
ffmpeg 可用性。每次转码都包 `try/except`,失败只打一行 `✗` 日志
留 mp4v。

**`clips:cleanup` 409 守卫**：job 状态为 `queued` 或 `running` 时该
端点拒绝（`409`）。原因:clip 抽帧在 `ThreadPoolExecutor` 后台跑,
即使 WS 发了 `job.completed` 也可能仍在写。先 cancel,或等 job 落到终
态(`done` / `failed` / `cancelled`)。

## 线协议类型总览

| JSON 类型 | 镜像自 `backend/service/schemas.py` |
| --- | --- |
| `JobParams` | 每个 CLI 参数 |
| `JobCreate` | `{video_path, params?}` |
| `JobAccepted` | `{job_id}` |
| `JobInfo` | 完整状态 (用于 GET 与对账) |
| `SegmentOut` | 一个 segment,字段与 `core.SwingSegment` 一致,加 `phases[]` |
| `ClipInfo` | 每段 clip 元数据（`GET /clips` 返回） |
| `ClipCleanupResult` | `{deleted_count, freed_bytes}`（`POST /clips:cleanup` 返回） |
| `ProgressEvent` | WS 信封 `{type, job_id, data}` |