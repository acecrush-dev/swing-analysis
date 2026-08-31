# 05 · Electron GUI

REST 服务之上的薄桌面壳。Renderer 从不接触 MediaPipe 或 OpenCV —— 它只
跟 `127.0.0.1:8321` 谈 HTTP + WS。

## 项目布局

```
src/
├── main/
│   └── index.ts             ← 窗口创建 + PythonSidecar 生命周期
├── preload/
│   └── index.ts             ← contextBridge: window.api
└── renderer/
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx           ← 页面布局、状态、WS 接线
        ├── api/
        │   ├── client.ts     ← 带类型的 fetch + WS + 自动重连
        │   └── types.ts      ← 线类型 (镜像 schemas.py)
        └── components/
            ├── VideoPicker.tsx
            ├── ParamsForm.tsx
            ├── ProgressPanel.tsx
            └── ResultsPanel.tsx
```

## Sidecar 生命周期

`src/main/index.ts` 定义 `class PythonSidecar`:

1. **发现**。如果 `process.env.SWING_SERVICE_URL` 设了,直接 attach(手动
   dev 时你在终端起了服务就用这个)。否则 spawn:
   ```bash
   backend/.venv/bin/python3 -m backend.service --port 0 \
       --data-dir <repo>/backend/data
   ```
   `--port 0` 让 uvicorn 选空闲端口;stdout 里的
   `SWING_SERVICE_URL=http://127.0.0.1:<port>` 行透露实际端口
2. **等启动**。按行读 stdout,最多 15s。行不来就弹错误框 + `app.quit()`
3. **进程树 kill**。`before-quit` 时给进程组发 SIGTERM,让子 Python 线
   程干净退出

## IPC

`src/main/index.ts` 注册两个 IPC handler:

- `pick-video` → `dialog.showOpenDialog`,filter `mp4|mov|m4v|avi`。返
  回绝对路径,取消返 `null`
- `get-service-info` → 返回当前 `SWING_SERVICE_URL`(sidecar 没起来返
  `null`)

`src/preload/index.ts` 通过 `contextBridge` 暴露两者:

```ts
window.api = {
  pickVideo: () => Promise<string | null>,
  getServiceInfo: () => Promise<string | null>,
};
```

## Renderer 布局

`src/renderer/src/App.tsx` 是 2 列网格:

```
┌──────────────────────────────────────┬───────────────────┐
│  VideoPicker (原视频 + seek)         │  ParamsForm       │
│  ProgressPanel (开始/取消/ETA)       │  ResultsPanel     │
│                                      │  (实时 segments)  │
└──────────────────────────────────────┴───────────────────┘
```

Renderer 状态机:

```
idle  ──[start]──▶  queued  ──[ws.open]──▶  running
                                              │
                                       ┌──────┼──────┐
                                       ▼      ▼      ▼
                                      done  failed  cancelled
```

## WS 自动重连

`SwingClient.openEvents(jobId, onEvent, onClose)`:

- 开 `ws://127.0.0.1:8321/api/jobs/<id>/events`
- 解析后的事件转给 `onEvent`
- 关连时调 `onClose`(它会 GET `/api/jobs/<id>` 对账),1.5s 后重连
- 调用方用返回的 cleanup 函数取消(取消按钮用)

## 通过 `/api/videos` 回放

`<video>` 的 src 是
`${baseUrl}/api/videos?path=${encodeURIComponent(abs)}`。用户在
ResultsPanel 点一段,renderer 解析 `start_timecode`(`mm:ss.SSS`)转秒,
设 `videoRef.current.currentTime`,然后 `play()`。

这绕开 cv2 `mp4v` 编码问题 —— `extract_one_clip` 写的 clip 用
MPEG-4 Part 2,Chromium 解不出来;GUI 根本不试。它们依然作为产物下载链
接可用。

## Dev 工作流

```bash
# 一次性
npm install

# 日常
npm run dev
# → electron-vite 编译 main + preload + renderer
# → spawn PythonSidecar
# → 开 Electron 窗口指向 dev server

# 想 attach 到手动启的服务:
SWING_SERVICE_URL=http://127.0.0.1:8321 npm run dev
```

## 构建发布版

本次 release 不在范围内 (Phase C)。计划是 `electron-builder` + PyInstaller
`onedir` 打包 sidecar,放在 `extraResources/` 下。