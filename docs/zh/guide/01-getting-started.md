# 01 · 快速开始

从 `git clone` 到第一条结果,五分钟。

## 前置依赖

| 工具 | 版本 | 为什么 |
| --- | --- | --- |
| Python | ≥ 3.10 | MediaPipe 预编译 wheel 历史上止于 3.12;3.13 已实测可跑 |
| Node.js | ≥ 18 | Electron 31 + electron-vite |
| Git | 任意 | clone 仓库 |
| **git-lfs** | **必需** | `backend/models/{rtmdet,rtmpose}-m-*.onnx`(104 MB + 52 MB)是 Git LFS 跟踪的。`git clone` 拉下来是 134 字节的 LFS 指针文本,不是真的 ONNX 二进制 —— 加载器会挂。要么装 `git-lfs` 后跑 `git lfs pull`,要么用 `scripts/fetch-model.sh`(一键搞定 MediaPipe + LFS) |
| ffmpeg | 不需要 | OpenCV 自带编解码 |
| **mediapipe** | **== 0.10.35**(已在 `backend/requirements.txt` 里钉死) | MediaPipe **1.0** 的 wheel 在 Apple Silicon 上有回归,会在 `TensorsToDetectionsCalculator::Open()` abort。详见 [07 · 故障排查](07-troubleshooting.md#apple-silicon-metal-delegate-回归)。**不要直接 `pip install --upgrade mediapipe`** —— 升之前先看那节 |

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

## 3. 模型

三个模型文件在 `backend/models/` 下,**全部都走 Git LFS**:

| 文件 | 大小 | 来源 | `git clone` 完你拿到的是 |
| --- | --- | --- | --- |
| `pose_landmarker_lite.task` | 5.5 MB | Git LFS | 132 字节指针文本 |
| `rtmdet-m-487628.onnx` | 104 MB | Git LFS | 134 字节指针文本 |
| `rtmpose-m-27c0e6.onnx` | 52 MB | Git LFS | 133 字节指针文本 |

`scripts/fetch-model.sh` 是全家桶 —— (a) MediaPipe lite 缺了(且 LFS 不可达)时从 CDN 重新下, (b) 检测 LFS 指针文件(约 130 字节、首行 `version https://git-lfs.github.com/spec/v1`)并自动跑 `git lfs pull` 把真二进制拉下来:

```bash
bash scripts/fetch-model.sh
# 期望输出:
#   [fetch-model] MediaPipe lite 已就位 ... (5.5M)
#   [fetch-model] 模型状态:
#     ✓ pose_landmarker_lite.task   (5.5M)
#     ✓ rtmdet-m-487628.onnx        (112M)
#     ✓ rtmpose-m-27c0e6.onnx       ( 52M)
```

想手动也行:

```bash
brew install git-lfs        # macOS —— Linux 用 apt-get install git-lfs
git lfs install
git lfs pull                # 把 backend/models/*.onnx 实物化出来
```

漏跑 `git lfs pull` 的症状: 脚本报 `模型文件不存在: backend/models/rtmdet-m-487628.onnx`,但 `ls -la` 显示文件确实存在、大小 134 字节 —— 那是 LFS 指针文本。重新跑 `bash scripts/fetch-model.sh` 即可。

## 4. 烟雾测试 (不开服务)

```bash
# 用你手头任何短片
python3 -m backend.cli segment \
    --video /abs/path/to/your/video.mp4 \
    --max-frames 1500 \
    --out-dir /tmp/swing_out

# 期望: ✓ 完成: 检测到 N 个完整挥拍周期 + JSON: /tmp/swing_out/segments.json
```

## 4b. 直接跑单个 vendored 算法

`backend/core/` 下的三个脚本都能独立运行 —— 不需要服务、不需要 pipeline
壳、不需要 Electron。想要单个阶段而不要全套编排时很合适:

```bash
# MediaPipe 一次跑完 33 点 → 切分 + 带骨架的 clip + 整段 viz
backend/.venv/bin/python3 backend/core/analyze_swing.py \
    --file ../../demo.mp4 \
    --save-clips --skel-clips --viz-full

# RTMDet 人物框 + RTMPose 13 点骨架,四象限合成器
backend/.venv/bin/python3 backend/core/gen_skeleton_anim.py \
    --file ../../demo.mp4 \
    --det-model ../models/rtmdet-m-487628.onnx \
    --pose-model ../models/rtmpose-m-27c0e6.onnx

# 只跑腕信号切分管线 (跟 `backend.cli segment` 同款)
backend/.venv/bin/python3 backend/core/segment_swing.py --file ../../demo.mp4 --max-frames 1500
```

每个脚本各管什么见 [02 · 架构](02-architecture.md#l1--算法-backendcore)。

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