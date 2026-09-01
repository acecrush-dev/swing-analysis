# 00 · 项目介绍

## 解决什么问题?

教练拍下比赛录像,想从 10 分钟视频里找出每一个正手、反手、发球,切成
独立片段,在击球瞬间标上分析。手工做要几小时;每调一次参数重做一遍,更久。

`swing-analysis` 自动化 **找 + 切** 这两步。你给它视频,可选地给一些调
参;它给你一组完整挥拍周期,带相位边界 (`ready / windup / contact /
follow_through`) 与预切好的 clip MP4。

## 它刻意不做的事

- **不做动作评分**。这是切分,不是分析。击球技术对不对是另一个下游问题
  (见 [`backend/core/analyze_swing.py`](../../backend/core/analyze_swing.py)
  —— 它画 33 点骨架 + 抽 clip,但不评分)
- **不做云服务**。一切都在本地跑。FastAPI 默认绑 `127.0.0.1`。要开放到
  LAN 是 `Phase C` 的事
- **不做模型自动更新**。MediaPipe Pose 模型 (`pose_landmarker_lite.task`,
  5.5 MB) 已入库钉死。升级请刻意为之

## 谁在用?

- 已经有视频工作流的教练/球员 —— 想跳过手工切片的苦
- 想把算法集成进大系统的工程师 (比如分析仪表盘) —— 他们只用 REST API,
  不碰 Electron
- 想调参做实验的研究者 —— 他们用 CLI 快速迭代

## 为什么是分层设计?

两条原则:

1. **算法库是神圣的**。`backend/core/` 里三个脚本全部 byte-for-byte
   vendored —— `segment_swing.py`、`analyze_swing.py`、
   `gen_skeleton_anim.py`。任何修改必须先来自底层源,再 `cp` 进来。
   这保证了你在这里做的任何"修复"都能用一次拷贝复现

2. **UI 是可替换的**。CLI 是一种 UI。桌面应用是一种 UI。浏览器 tab 是一
   种 UI。它们都想做同一件事 —— 提交任务、看进度、拿结果。正确的形状是
   一个算法函数 (`run_pipeline()`),任一 UI 都能调

这种形状让 GUI 只是 CLI 之上的薄壳。Renderer 里没有算法代码。没有"我得
维护两份实现"的债。

## 什么时候不要用它

- 你需要实时姿态跟踪 (这是离线批处理 —— 在 M 系列 Mac 上 Pass 1+1.5 大
  约 1s/帧)
- 你想要一段独立的智能裁剪骨架动画视频 (不要切分,只要叠加)。直接跑
  `backend/.venv/bin/python3 backend/core/gen_skeleton_anim.py --help` —— 同一份算法,但
  包装给 animation-only 场景
- 你想要一个托管的 Web 应用。它本地优先是设计如此;Phase C 画了自托管
  的草图但没建

## 这里的 "挥拍" 是什么?

一个完整周期 = `ready → windup → contact → follow_through`。算法以选
手右手腕 (MediaPipe 关键点 16) 的位置随时间变化为主信号:手腕速度超过阈
值时开始,停下时结束。相邻活动区间在 1.5s 内 (推断为休息) 或 1.5s (推
断为漏检) 合并成一段;否则分开。

完整流水线见 [06 · 算法原理](06-algorithm.md)。