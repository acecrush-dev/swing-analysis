# 05 · Electron GUI

`Swing-Analysis`(AceCrush 品牌)的桌面壳。Renderer 从不接触 MediaPipe、
OpenCV 或任何视觉/ML 模型 — 它只跟 `127.0.0.1:8321` 谈 HTTP + WS,由主进
程(`src/main/`)代理。品牌分层:安装器/关于/文档 = `AceCrush Swing-Analysis`;
macOS 顶栏 app 菜单槽是单独的 `AceCrush`;窗口标题、App 头部、国际化字
符串是 `Swing-Analysis`。

## 项目布局

```
src/
├── main/
│   ├── index.ts             ← 窗口创建 + PythonSidecar 生命周期
│   │                          + ipc handlers + menu + 品牌分层
│   ├── panels.ts            ← F12 风格可分离的 Clips / Log 窗口
│   └── settings.ts          ← userData、output_dir 持久化
├── preload/
│   └── index.ts             ← contextBridge.window.api (类型化接口)
└── renderer/
    ├── index.html            ← 主窗口入口
    ├── clips.html            ← 分离的 Clips 面板入口
    ├── log.html              ← 分离的事件日志入口
    └── src/
        ├── main.tsx            ← App 根
        ├── clips-window.tsx    ← 面板窗口挂载
        ├── log-window.tsx
        ├── App.tsx             ← 双栏布局,状态机,WS 接线
        ├── i18n.ts             ← en/zh 字典 + locale hook
        ├── api/
        │   ├── client.ts       ← 带类型的 fetch + WS + 自动重连
        │   ├── types.ts        ← wire types (mirror schemas.py)
        │   └── panels.ts       ← 面板 state/action 负载结构
        ├── hooks/
        │   └── theme.tsx       ← dark/light 主题 provider
        └── components/
            ├── VideoPicker.tsx        ← 拖拽 + 文件对话框
            ├── ParamsForm.tsx         ← 右侧参数网格
            ├── ProgressPanel.tsx      ← Start/Cancel + 双进度条
            ├── ResultsPanel.tsx       ← 实时段列表 + viz.mp4 帧
            ├── ResultsActionsBar.tsx ← ⬇ segments.json / ⬇ viz.mp4 / 打开目录 / 导出 / 删除
            ├── ClipsBar.tsx           ← 底部缩略图条 + ↗ 分离
            ├── EventLogList.tsx       ← 中部事件日志 + ↗ 分离
            ├── ClipPlayer.tsx         ← 行内 clip 播放器 + 水印
            ├── ClipGrid.tsx           ← clip 卡片渲染 + tooltip
            ├── HelpPanel.tsx          ← 浮层:用法 / 参数 / 菜单 / 提示
            ├── SettingsPanel.tsx      ← 浮层:标注颜色 + output_dir
            ├── Toast.tsx              ← 短暂状态提示
            ├── Tooltip.tsx            ← 统一的图标按钮 tooltip
            ├── ErrorBoundary.tsx
            └── panels/
                ├── ClipsPanelApp.tsx  ← 面板窗口内容 (clips)
                └── LogPanelApp.tsx    ← 面板窗口内容 (event log)
```

## 品牌分层约定

| 表面 | 字符串 | 为什么 |
| --- | --- | --- |
| macOS 顶栏 app 菜单槽 | `AceCrush` | 父品牌(darwin 时由 `src/main/index.ts` 的 `app.setName` 注入) |
| macOS Dock 图标 | 网球 logo | 父品牌(由 `app.dock.setIcon(build/icon.png|.icns)` 设置) |
| BrowserWindow 标题 / HTML `<title>` | `Swing-Analysis` | 这款 app(不含品牌) |
| Help → About 菜单项 | `关于 AceCrush Swing-Analysis` | 品牌 + app |
| About 对话框 `message` | `AceCrush Swing-Analysis` | 大标题槽 |
| `package.json` `productName` | `AceCrush Swing-Analysis` | 安装器 / dmg / NSIS 标签;Windows 快捷方式名;userData 目录名 |
| `package.json` `appId` | `com.leochan007.acecrush.swinganalysis` | 反向域,品牌段在前 |
| `package.json` `appImage.executableName` | `swing-analysis` | Linux ELF 二进制名(Linux 习惯用小写) |
| `app.settings` / i18n `app.title` | `🎾 Swing-Analysis` | app 头部 |

URL(`leochan007.github.io/swing-analysis/`、`github.com/leochan007/swing-analysis`)
和 npm 包名(`swing-analysis-gui`)保持小写,因为它们是稳定标识符 — 改
了会破坏外链与 npm 安装。

## Sidecar 生命周期

`src/main/index.ts` 的 `class PythonSidecar` 提供两种启动模式,通过
`app.isPackaged` 区分:

### dev(`!app.isPackaged`)

```
backend/.venv/bin/python3 -m backend.service --port 0 \
    --data-dir <repo>/backend/data \
    --models-dir <repo>/backend/models
```

`--port 0` 让 uvicorn 自由选端口;stdout 中的
`SWING_SERVICE_URL=http://127.0.0.1:<port>` 一行被主进程捕获、解析成
WebSocket 端点 `${url}/api/jobs/<id>/events`。若进程在 15 秒内未打
印这一行(崩溃 / 卡住),弹错误框并退出。

### 打包后(`app.isPackaged`)

```
<resourcesPath>/backend/swing-backend(.exe) --port 0 \
    --data-dir <userData>/backend-data \
    --models-dir <resourcesPath>/models
```

`swing-backend(.exe)` 由 PyInstaller(`scripts/build-python-bundle.js`)
生成、落在 `backend/dist/`,electron-builder 的 `extraResources` 配置
把它和 `backend/models/` 都拷到打包后 app 的 `resources/` 下。
`process.resourcesPath` 在 macOS 指向 `<app>/Contents/Resources`、
win/linux 指向 `<app>/resources/`。`defaultDataDir()`(`src/main/settings.ts`)
按 `app.isPackaged` 自动切换,把任务输出写到 userData 的 per-user 目录。

`process.env.SWING_SERVICE_URL` 仍然在两种模式下都生效 — 想从终端手
动启动 service 然后用 Electron 客户端连过去调试时很有用。

### 进程树 kill

`app.before-quit` 时,sidecar 给进程组发 SIGTERM(`process.kill(-pid)`),
让子 Python 线程(uvicorn、MediaPipe VIDEO tracker、ONNX runtime worker)
干净关停,然后 `proc.kill()` 作安全网。

## IPC handlers

`src/main/index.ts` 注册了所有以下通道;renderer 通过 preload 的
`window.api.*` 访问它们。完整接口:

| IPC 通道 | preload 方法 | 返回 |
| --- | --- | --- |
| `pick-video` | `pickVideo()` | `string \| null`(绝对路径,cancel 时 null) |
| `get-service-info` | `getServiceInfo()` | sidecar `SWING_SERVICE_URL` 或 `null` |
| `get-dropped-file-path`(只 preload,非 IPC) | `getDroppedFilePath(file)` | 绝对路径(用 `webUtils.getPathForFile`;Electron 32 移除了 `File.path`) |
| `export-package` | `exportPackage(jobId)` | `{ ok, path }` 或 `{ ok: false, error }` |
| `open-external` | `openExternal(url)` | `boolean`(只接 http/https) |
| `open-output-dir` | `openOutputDir(jobId)` | `{ ok, path }` 或 `{ ok: false, error }` — 在 OS 文件管理器打开 `DATA_DIR/jobs/<id>/` |
| `clear-output-dir` | `clearOutputDir()` | `{ ok, path, deleted_count, cleared_job_ids }` |
| `show-about` | `showAbout()` | `void` — 模态对话框(品牌 + app 标题) |
| `settings:get` | `getSettings()` | `{ output_dir, default_output_dir, configured_output_dir }` |
| `settings:set-output-dir` | `setOutputDir(dir)` | `{ ok, output_dir }` 或 `{ ok: false, error }` — 落 `userData/settings.json` |
| `settings:pick-output-dir` | `pickOutputDir()` | `{ ok, path }`(文件夹选择器) |
| `panel:open` / `panel:close` / `panel:is-open` | `openPanel(kind)` / `closePanel(kind)` / `panelIsOpen()` | `{ ok }` |
| `panel:get-state` / `panel:push-state` | `getPanelState()` / `pushPanelState(snap)` | 双向同步 clips + log 快照 |
| `panel:action-request` | `sendPanelAction(action)` | clip-select → 主窗口聚焦 + seek |
| `panel:state`(事件) | `onPanelState(cb)` | 订阅 |
| `panel:action`(事件) | `onPanelAction(cb)` | 订阅 |
| `menu:<id>`(事件) | `onMenuEvent(channel, cb)` | 订阅(open-file、export-package、clear-job、clear-output、about) |

## 应用菜单

在 `buildMenu()`(`src/main/index.ts`)中定义:

- **macOS 第一项 = App 菜单**(占 `app.name` 这个槽)。包含标准
  About / Hide / Services / Quit 项 — 必须显式给,否则 macOS 会把第
  一个菜单自动顶上去当作 App 菜单,然后把我们命名的 "System" 改名
  "AceCrush" 并吞掉。
- **System 菜单**(mac 上永远是第二项):Open File…(`Cmd/Ctrl+O`),
  Export Package…(`Cmd/Ctrl+E`),分隔符,Clear Current Job Dir,
  Clear Output Dir…,分隔符,Quit。
- **Help 菜单**:Help Content(打开
  `https://leochan007.github.io/swing-analysis/`),分隔符,
  About AceCrush Swing-Analysis。

renderer 收每条点击为 `menu:<id>` IPC 事件,反应方式跟 app 内按钮一
样(打开文件对话框、触发导出等),所以键盘快捷键不管面板窗口目前是
否聚焦都管用。

## Renderer 布局

`src/renderer/src/App.tsx` 搭出双栏主窗口。运行时:

![Swing-Analysis 主窗口 —— 已加载视频,下方是 clip 缩略图条](/images/load_video.png)

```
┌──────────────────────────────────────────────────┬──────────────────┐
│ 📁 [drag-drop 区] 视频选择器(播放器)              │ ⚙ Parameters     │
│   ↩ original / ▶ clip / 🎬 viz.mp4               │   网格表单       │
│   (clip 上有水印)                                │   + save/viz     │
├──────────────────────────────────────────────────┤   勾选框        │
│  Progress  ▶ Start  ⊘ Cancel                     │   + clip section │
│  双进度条(队列 + 每 clip)                         │   (RTMDet 人框   │
│                                                  │    / 姿态骨架    │
│  事件日志(live WS)                               │    + backend)   │
│                                                  ├──────────────────┤
│                                                  │ 实时段 +        │
│                                                  │ ResultsActions  │
│                                                  │ (download, open-dir, export, delete) │
├──────────────────────────────────────────────────┴──────────────────┤
│ 🎬 ClipsBar  ↗ 分离                                              │
│   [thumb][thumb][thumb]…                                          │
└───────────────────────────────────────────────────────────────────┘
```

renderer 状态机:

```
idle  ──[start]──▶  queued  ──[ws.open]──▶  running
                                           │
                                    ┌──────┼──────┐
                                    ▼      ▼      ▼
                                   done  failed  cancelled
```

`SettingsPanel` 与 `HelpPanel` 是**浮层**(fixed-position 模态),用
`App.tsx` 里的 `useState` 控制显隐,盖满整个窗口但不影响底层布局;
ESC 可关,点击空白可关。

clip 切出来后,底部 ClipsBar 出现每个周期的缩略图;点哪个就内联播放。
勾上 `clip_bbox + clip_skel` 后,player 会显示带叠加的版本(你设的
`color_bbox` 颜色的人物框 + `color_pose_left/right/body` 骨架),同时双
进度条亮起:

![第 3 段 clip 正在播放,带人物框 + 骨架 + 双进度条](/images/clip_play.png)

## 可分离面板

两个高频被切的区域 — 缩略图条和事件日志 — 可通过工具栏上的 `↗` 按钮
(或 `Help → System` 菜单)弹成独立 OS 窗口。机制在 `src/main/panels.ts`:

- **状态。** 每种面板一个 `BrowserWindow`(`Map<PanelKind, BrowserWindow>` 缓存)。
  再点 `↗` 聚焦已有窗口,不开第二份。
- **位置持久化。** 每种面板关闭时把 `(x, y, width, height)` 写到
  `userData/panel-bounds.json`;重开时按当前显示器工作区 `clampBounds`,
  防止显示器拔了之后窗口飞到屏外。
- **状态同步。** renderer 每 100 ms(`usePanelSync`)发一次冻结快照:
  `ipcRenderer.send('panel:push-state', snap)`;面板窗口挂载时主动
  `ipcRenderer.invoke('panel:get-state')` 拿一次,首帧就不会空白。
- **动作回流。** 在分离的面板里点 clip → 发 `panel:action-request` →
  主进程转发给主窗口,且对 `select-clip` 额外 `restore + show + focus`
  主窗口,这样播放切换可见。
- **生命周期。** 窗口关 → 主窗口 IPC → renderer 把内联 ClipsBar /
  日志区切回"已收回"状态。

`clips.html` 和 `log.html` 是真的 Vite 多入口
(`electron.vite.config.ts:rollupOptions.input`),所以 dev 期 HMR 正常,
生产打包会同时输出 `renderer/clips.html` 与 `renderer/log.html`。面板
窗口里**没有**算法代码 — 它们是纯状态视图节点。

## WS 自动重连

`src/renderer/src/api/client.ts` 的
`SwingClient.openEvents(jobId, onEvent, onClose)`:

- 打开 `ws://127.0.0.1:<port>/api/jobs/<id>/events`
- 把解析后的事件转发给 `onEvent`
- 关掉时:`onClose`(它去 fetch `/api/jobs/<id>` 拿快照对账),然后 1.5 秒
  后重连
- 调用方通过返回的 cleanup 函数取消(给"取消"按钮用)

## 播放

- **原视频。** `<video>` 资源 = `${baseUrl}/api/videos?path=${encodeURIComponent(abs)}` —
  FastAPI 用 HTTP Range 流出来(Chromium 拖动会用到)。
- **Clips。** 段触发时,renderer 切到
  `${baseUrl}/api/jobs/<id>/clips/<seg_id>/stream` —
  H.264 同名 mp4,由 `clip_codec.transcode_h264` 出(没 ffmpeg 时,水印显
  示 `⚠ 原生格式 · 点击跳转原视频`,点击 fallback 为把原视频 seek 到
  `start_timecode`)。
- **viz.mp4。** 结果面板右下角是分离按钮(下载 ⬇ viz.mp4 + 播放器播放)。

## Tooltip 系统

`src/renderer/src/components/Tooltip.tsx` 给头部/底部/工具栏的每个
图标按钮提供统一单行 tooltip。字符串从 `src/renderer/src/i18n.ts` 取
(`btn.*` keys),所有 tooltip 跟着 locale 切中文。clip 播放器的水印
走自定义 `cloneElement` 路径(因为 Tooltip 需要包的是 JSX)。

## i18n

`src/renderer/src/i18n.ts` — 通过 `🌐` 按钮运行时切语言。首次挂载时
从 `navigator.language` 自动检测,之后走 `localStorage['swing.locale']`。
`useI18n()` 是 React hook;`t(key, vars)` 是解析器(回退 `zh → en → key`)。
`HelpPanel` 用它翻译**参数表**(14 行 `<name, meaning, advice>`,整张表
双语全翻译)— 新增参数:在 `HelpPanel.tsx` 的 `PARAM_ROW_IDS` 末尾追加
一行,在 `en` 和 `zh` 字典里各加三个键。

## Dev 流程

```bash
# one-time
npm install

# day-to-day
npm run dev
# → electron-vite 编译 main + preload + renderer
# → 拉起 PythonSidecar(dev 模式:venv python)
# → 打开 Electron 窗口,连到 dev server

# 想连手启的 service:
SWING_SERVICE_URL=http://127.0.0.1:8321 npm run dev
```

## 设置

`src/main/settings.ts` 把设置写到 `userData/settings.json`。目前两个 key:

- `output_dir` — 任务输出根目录。Default = dev 时 `<repo>/backend/data`,
  打包后 `<userData>/backend-data`。只在启动时抓一次;改了需要重启 app
  才生效(sidecar 只在 spawn 时读 `--data-dir`)。

`SettingsPanel`(`src/renderer/src/components/SettingsPanel.tsx`)把
上面这个 + 四个标注颜色(RTMDet bbox、pose-left、pose-right、pose-body)
暴露给用户。颜色作为 CSS 自定义属性被 ResultsPanel 的骨架 / bbox 叠
加层消费。

## 发版打包

`package.json` `build` 配置 + `scripts/build-python-bundle.js`(PyInstaller
单文件封装)交给 `electron-builder`(Windows → NSIS、macOS → dmg + zip、
Linux → AppImage + deb)。每个 `pack:*` 脚本都按顺序执行
`icons + bundle:py + vite build + electron-builder`。

跨平台矩阵、打包后进程契约、签名 / 公证要点见
**[08 · Build & Package](08-build-package.md)**。
