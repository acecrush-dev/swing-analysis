# 01 · 快速开始

从 `git clone` 到第一条结果,五分钟。

## 前置依赖

| 工具 | 版本 | 为什么 |
| --- | --- | --- |
| Python | ≥ 3.10 | MediaPipe 预编译 wheel 历史上止于 3.12;本机 3.13 已实测可跑 |
| Node.js | ≥ 18 | Electron 31 + electron-vite |
| Git | 任意 | clone 仓库 |
| ffmpeg | 不需要 | OpenCV 自带编解码 |

## 1. Clone

```bash
git clone https://github.com/leochan007/swing-analysis.git
cd swing-analysis
```

## 2. Python 依赖

可以用 venv,也可以直接装到系统 Python —— 脚本默认调 `python3`。

```bash
# 选项 A —— virtualenv (推荐)
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt

# 选项 B —— 装到系统
pip3 install -r backend/requirements.txt
```

## 3. MediaPipe 模型

模型**已经在仓库里**了 —— `backend/models/pose_landmarker_lite.task`
(5.5 MB)。`scripts/fetch-model.sh` 是兜底脚本,极少数情况下文件丢了,它
会从 `ace-crush-lab` 拷一份,或者从 MediaPipe CDN 下载。

```bash
bash scripts/fetch-model.sh    # 应该打 "已就位 …"
```

## 4. 烟雾测试 (不开服务)

```bash
# 用你手头任何短片; fdl.mp4 是上游 ace-crush-lab 的标准测试
python3 -m backend.cli \
    --video /abs/path/to/your/video.mp4 \
    --max-frames 1500 \
    --out-dir /tmp/swing_out

# 期望: ✓ 完成: 检测到 N 个完整挥拍周期 + JSON: /tmp/swing_out/segments.json
```

## 5. 起服务

```bash
python3 -m backend.service --port 8321
# stdout 末行: SWING_SERVICE_URL=http://127.0.0.1:8321
```

另一个终端:

```bash
curl http://127.0.0.1:8321/api/health
# {"status":"ok","version":"0.1.0","model_ready":true,...}
```

## 6. (可选) 起 Electron GUI

```bash
npm install        # 200-400 MB, 1-3 分钟
npm run dev        # 编译 main + preload + renderer,开窗
```

Electron 自动 spawn Python sidecar (期望 PATH 上有 `python3` 或
`backend/.venv/bin/python3`)。如果你的 venv 起了别的名字,改
`src/main/index.ts` 的 `candidates` 数组。

## 产物都去哪了?

| 路径 | 内容 |
| --- | --- |
| `backend/data/service.json` | 服务 bind 信息 (host/port) |
| `backend/data/jobs/<id>/segments.json` | 最终结果 + 完整参数回显 |
| `backend/data/jobs/<id>/clips/clip_NNN.mp4` | 每段 clip (仅当 `save_clips=true`) |
| `backend/data/jobs/<id>/viz.mp4` | 彩色相位标注视频 (仅当 `viz_video=true`) |
| `/tmp/swing_out/` | CLI `--out-dir` 指定的位置 |

这些都进 `.gitignore`。它们是运行时缓存,重跑就会重建。

## 接下来

- [03 · CLI 用法](03-cli-usage.md) —— 所有调参与它们的作用
- [04 · REST API](04-rest-api.md) —— 线协议
- [06 · 算法原理](06-algorithm.md) —— 理解"为什么会有这些参数"