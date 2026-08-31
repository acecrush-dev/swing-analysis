# 07 · 故障排查

## Python: `pip install mediapipe` 失败

MediaPipe 官方 wheel 历史上止于 Python 3.12。如果你是 3.13+ ,`pip` 会
去下 sdist 本地编译 —— 而 TFLite 的 bazel 构建链常常挂。

**选项**:

1. 看 Python 版本:`python3 --version`
2. 如果 ≥ 3.13,建专用 3.12 venv:
   ```bash
   python3.12 -m venv backend/.venv
   backend/.venv/bin/pip install -r backend/requirements.txt
   ```
3. Apple Silicon 上,确认 `grpcio` 和 `numpy` 在 `mediapipe` **之前**
   装好 (预编译 wheel 的版本约束)

## `model_ready: false` 但文件在

服务在 `backend/models/` 找这些文件名:

- `pose_landmarker_lite.task` (优先)
- `pose_landmarker.task` (兜底)

0 字节文件或拼错名的文件会让 health check 静默失败。验证:

```bash
ls -lh backend/models/
# 期望: -rw-r--r--  5.5M  pose_landmarker_lite.task
```

## `/api/videos` 返 500 / 空白

两个已知问题,本仓库都已修:

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 500 + `'function' object has no attribute 'matches'` | `app.py` 动态换路由时 append 的是裸函数,不是 APIRoute | 当前代码用 `Request` 参数一次性定义路由,不再打补丁 |
| `<video>` 显示 "no video with supported format" | Chromium 解不了 cv2 `mp4v` 编码 | GUI 走 `/api/videos` 播**原视频**,不走 `clips/` —— 不应该撞到这 |

## WS 收不到事件

WebSocket 流程有两种失败:

1. **服务没在期望端口跑**。验证 `cat backend/data/service.json` —
   它的 `port` 字段是真值
2. **URL 错**。浏览器 / Electron 必须用 `ws://`,不是 `http://`。
   `SwingClient.openEvents` 自动转换

还收不到:

```bash
# 原始 WS 测试 (Python,无框架)
python3 -c "
import asyncio, websockets, json
async def t():
    async with websockets.connect('ws://127.0.0.1:8321/api/jobs/<ID>/events') as ws:
        for _ in range(5):
            print(await ws.recv())
asyncio.run(t())
"
```

## 端口被占

```bash
# 谁占的?
lsof -nP -iTCP:8321 -sTCP:LISTEN

# 让服务选空闲端口
python3 -m backend.service --port 0
# stdout 末行透露真实端口
```

Electron 作客户端时,自动解析那行 stdout —— 你不用在哪儿硬编码 8321。

## `onnxruntime` 没装

Clip 标注 (RTMDet + RTMPose) 依赖 `onnxruntime`。**基础 segmentation**
(`--save-clips` 不带 `--clip-bbox/--clip-skel`)**不需要**。如果只想跑
segmentation 可以不动;想跑标注需要 `pip install onnxruntime`。

如果安装失败,确认 Python 版本。`onnxruntime` 官方 wheel 通常覆盖
CPython 3.9–3.13。

## RTMDet 报 CoreML 静态/动态 shape 不匹配

```
onnxruntime:... Non-zero status code returned while running ... CoreML node.
CoreML static output shape ({1,1,1,8400,8400}) and inferred shape ({1,8400})
have different ranks.
```

RTMDet 的输出 shape 是动态的,CoreML EP 不能处理。`RtmdetRunner` 默认
`prefer_coreml=False`,只用 CPU。如果改 `_make_onnx_session` 时把
`prefer_coreml` 设成 True 触发这个错,改回去就行。

RTMPose 是固定 shape (192×256 SimCC),CoreML 跑得通;`RtmposeRunner`
默认 `prefer_coreml=True`。

## 慢 / 卡

- `--clip-bbox` + `--clip-skel`:RTMDet + RTMPose 每帧都跑 (M 系列
  Mac 上大约 20-30 fps,远低于 segmentation 的 MediaPipe ~100 fps)。
  长视频 / 多数 clip 会明显慢
- Apple Silicon 上 RTMPose 用 CoreML EP 会快 3-5 倍;RTMDet 因为
  CoreML 不兼容只能用 CPU
- 大量 clip 想后处理:`python -m backend.cli annotate --bbox --skel`
  复用已加载的 ONNX session (同一个 `ClipAnnotator` 实例),不用每个
  clip 重新加载 100+ MB 模型

## MediaPipe 内部 `IndexError` / `KeyError`

通常 `.task` 文件损坏或版本不对。重抓:

```bash
rm backend/models/pose_landmarker_lite.task
bash scripts/fetch-model.sh
```

下载失败 (离线机),从别处拷,或者从一个新装的 `pip install mediapipe`
里抽出来:
`<venv>/lib/python3.X/site-packages/mediapipe/modules/pose_landmarker/pose_landmarker_lite.task`。

## 明显动作多的视频却没 segment

按这个顺序调:

1. 把 `--min-peak` 调到 0.15 或 0.10 —— 很多"丢的"段其实是峰值阈值过滤
   掉了
2. 检查 `--v-swing` —— 调太高,活动段根本起不来
3. 看 segments.json 里的 `wrist_detected_pct` —— 低于 30% 说明 MediaPipe
   看你这段视频吃力,先调光线/机位,再调算法
4. 最后一招,`--smooth-alpha 0.4` —— 重平滑,吃掉单帧抖动

完整调参见 [06 · 算法原理](06-algorithm.md)。

## 切分爆炸 —— 一个 30 秒的巨段

把 `--gap-merge` 和 `--max-bridge` 调到 ~0.8 —— 你在用某个 gap 窗口把多
次挥拍串起来了。

## Electron 窗口 `npm run dev` 后是白的

1. 开 DevTools (View → Toggle Developer Tools) —— 看 Console
2. 最常见:sidecar 起不来。看 `backend/data/service.json` 是否存在、有
   端口
3. 如果 8321 被老的 `python -m backend.service` 占着,杀掉:
   `pkill -f backend.service`

## GUI 能选片但起不了 job

`/api/jobs` 返错了。最常见是 `404 视频不存在` —— Electron 发的是系统
dialog 返回的路径,按系统分隔符拼的。服务检查 `Path.is_absolute()` —
Windows 上确认你传 `"C:\\..."` 不是 `"C:/..."`。(Python 的 `Path` 两种
都行,但你手动测时可能写错)

## 怎么清理磁盘?

```bash
# 删旧 job 产物 (安全,都可重生成)
rm -rf backend/data/jobs/

# 删 Electron 构建缓存
rm -rf node_modules/ out/ dist/ .electron-vite/

# 删 Python venv (60s 重建)
rm -rf backend/.venv/
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
```

MediaPipe 模型已入库 (5.5 MB) —— 删 `backend/models/` 会触发
`scripts/fetch-model.sh` 重下。