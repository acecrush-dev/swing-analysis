# 05 · Electron GUI

A thin desktop shell around the REST service. The renderer never talks to
MediaPipe or OpenCV — it only talks to `127.0.0.1:8321` over HTTP + WS.

## Project layout

```
src/
├── main/
│   └── index.ts             ← window creation + PythonSidecar lifecycle
├── preload/
│   └── index.ts             ← contextBridge: window.api
└── renderer/
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx           ← page layout, state, WS wiring
        ├── api/
        │   ├── client.ts     ← typed fetch + WS + auto-reconnect
        │   └── types.ts      ← wire types (mirror schemas.py)
        └── components/
            ├── VideoPicker.tsx
            ├── ParamsForm.tsx
            ├── ProgressPanel.tsx
            └── ResultsPanel.tsx
```

## Sidecar lifecycle

`src/main/index.ts` defines `class PythonSidecar`:

1. **Discovery.** If `process.env.SWING_SERVICE_URL` is set, attach to that
   URL (used during manual dev when you've started the service in a
   terminal). Otherwise, spawn:
   ```bash
   backend/.venv/bin/python3 -m backend.service --port 0 \
       --data-dir <repo>/backend/data
   ```
   `--port 0` lets uvicorn pick a free port; the line
   `SWING_SERVICE_URL=http://127.0.0.1:<port>` in stdout reveals it.
2. **Boot wait.** Parse stdout line-by-line up to 15s. Error dialog and
   `app.quit()` if the line never arrives.
3. **Process tree kill.** On `before-quit`, send SIGTERM to the process
   group so child Python threads shut down cleanly.

## IPC

`src/main/index.ts` registers two IPC handlers:

- `pick-video` → `dialog.showOpenDialog` with `mp4|mov|m4v|avi` filter.
  Returns the absolute path, or `null` on cancel.
- `get-service-info` → returns the current `SWING_SERVICE_URL` (or `null`
  if the sidecar isn't up yet).

`src/preload/index.ts` exposes both via `contextBridge`:

```ts
window.api = {
  pickVideo: () => Promise<string | null>,
  getServiceInfo: () => Promise<string | null>,
};
```

## Renderer layout

`src/renderer/src/App.tsx` is a 2-column grid:

```
┌──────────────────────────────────────┬───────────────────┐
│  VideoPicker (original video + seek) │  ParamsForm       │
│  ProgressPanel (start/cancel/ETA)    │  ResultsPanel     │
│                                      │  (live segments)  │
└──────────────────────────────────────┴───────────────────┘
```

State machine in the renderer:

```
idle  ──[start]──▶  queued  ──[ws.open]──▶  running
                                              │
                                       ┌──────┼──────┐
                                       ▼      ▼      ▼
                                      done  failed  cancelled
```

## WS auto-reconnect

`SwingClient.openEvents(jobId, onEvent, onClose)`:

- Opens `ws://127.0.0.1:8321/api/jobs/<id>/events`
- Forwards parsed events to `onEvent`
- On close, calls `onClose` (which fetches `/api/jobs/<id>` to reconcile),
  then reconnects after 1.5s
- Caller cancels via the returned cleanup function (used by the cancel
  button)

## Playback via `/api/videos`

`<video>` source is `${baseUrl}/api/videos?path=${encodeURIComponent(abs)}`.
When the user clicks a segment in `ResultsPanel`, the renderer parses the
`start_timecode` (`mm:ss.SSS`), converts to seconds, sets
`videoRef.current.currentTime`, and calls `play()`.

This sidesteps the cv2 `mp4v` codec problem — the clips written by
`extract_one_clip` use MPEG-4 Part 2, which Chromium cannot decode; the
GUI never tries to play them. They're still available as download artifacts.

## Dev workflow

```bash
# one-time
npm install

# day-to-day
npm run dev
# → electron-vite builds main + preload + renderer
# → spawns PythonSidecar
# → opens Electron window pointed at the dev server

# to attach to a manually-started service instead:
SWING_SERVICE_URL=http://127.0.0.1:8321 npm run dev
```

## Build for distribution

Out of scope for this release (Phase C). The plan is `electron-builder` with
PyInstaller `onedir` for the sidecar, packed under `extraResources/`.