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
[03 · CLI 用法](03-cli-usage.md)。

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
- `Content-Type` 由 `mimetypes.guess_type` 按扩展名推断

## 线协议类型总览

| JSON 类型 | 镜像自 `backend/service/schemas.py` |
| --- | --- |
| `JobParams` | 每个 CLI 参数 |
| `JobCreate` | `{video_path, params?}` |
| `JobAccepted` | `{job_id}` |
| `JobInfo` | 完整状态 (用于 GET 与对账) |
| `SegmentOut` | 一个 segment,字段与 `core.SwingSegment` 一致,加 `phases[]` |
| `ProgressEvent` | WS 信封 `{type, job_id, data}` |