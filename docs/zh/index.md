# 📚 swing-analysis 文档

[English](../index.md) | **简体中文**

## 这是什么?

`swing-analysis` 把已经实测验证的网球挥拍自动切分管线 (最初在
[`ace-crush-lab`](https://github.com/leochan007/ace-crush-lab) 里开发)
包装成可服务化的 Python 后端,UI 层完全可插拔。算法 **byte-for-byte 原样
拷贝** 到 `backend/core/segment_swing.py` —— 不修改、不留惊喜。上游算法
更新时,直接 `cp` 进来就行。

仓库一次性交付三件东西:

1. **自包含 CLI** (`python -m backend.cli`) —— 验证流水线最快的姿势,不用起服务
2. **FastAPI 服务** (`python -m backend.service`) —— REST + WebSocket 监听
   `127.0.0.1:8321`。Electron GUI 在用它;以后浏览器、移动端也是它
3. **Electron + React 桌面 GUI** (`npm run dev`) —— 第一个前端消费者,管
   sidecar 生命周期,串起 *选片 → 调参 → 实时进度 → 看段 → 原视频 seek +
   产物下载*

## 📑 文档索引

| 章节 | 内容 | 谁看 |
| --- | --- | --- |
| [00 · 项目介绍](guide/00-introduction.md) | 项目定位、vendor 优先的解耦故事、什么场景用它 | 所有人 —— 从这里开始 |
| [01 · 快速开始](guide/01-getting-started.md) | 前置依赖、安装、首次运行 (CLI / REST / GUI),10 分钟以内 | 新用户 |
| [02 · 架构](guide/02-architecture.md) | 分层设计 (core / service / cli / electron)、vendor 策略、锁协议 | 好奇者 / 贡献者 |
| [03 · CLI 用法](guide/03-cli-usage.md) | 所有参数、输出 schema、退出码、调用样例 | 跑批量任务的人 |
| [04 · REST API](guide/04-rest-api.md) | 所有端点、payload、WebSocket 事件类型、Range 流、curl 配方 | 接 API 的人 |
| [05 · Electron GUI](guide/05-electron-gui.md) | sidecar 生命周期、dev 工作流、UI 布局、调试 | GUI 用户 / 贡献者 |
| [06 · 算法原理](guide/06-algorithm.md) | v2.1 两阶段切分管线内部是怎么工作的 (在线 + 离线) | 调参的人 |
| [07 · 故障排查](guide/07-troubleshooting.md) | 常见坑和解法 | 卡住的人 |

## 核心思路

```
                       算法 (真理之源)
                            │
                ┌───────────┴───────────┐
                │                       │
         run_pipeline()           run_pipeline()
                │                       │
        ┌───────▼───────┐       ┌───────▼───────┐
        │  CLI  入口    │       │ REST/WS 入口  │
        │  backend.cli  │       │ service.app   │
        └───────┬───────┘       └───────┬───────┘
                │                       │
        终端 UI                  Electron / 浏览器 /
                                 移动端 / curl
```

- **Vendor 优先**。算法库从上游原样拷,拷进来后**一行不改**。本仓库跟上
  游的漂移用 `cp` 解决,不用手工 merge
- **Pipeline 是接缝**。`run_pipeline()` 是唯一接触算法的函数。它接回调
  (`progress_cb` / `on_segment` / `should_cancel`),不直接写终端。HTTP
  服务和 CLI 都调它

- **任何 UI 都能接**。明天想接 Jupyter widget?Streamlit?iOS app?它们都讲
  REST + WebSocket,从 `/api/artifacts/<id>/...` 下产物。算法不关心也不需要关心

## 为什么是 "同一 pipeline 上的两种 UI"?

CLI 是一种 UI。HTTP 服务是一种 UI。Electron 应用也是一种 UI。它们的差
别只在传输和渲染,不在"让算法做什么"。在这一层接缝解耦的好处:

- **不带 UI 噪音测算法**。在固定视频上跑 CLI,直接看 `segments.json`。
  没有浏览器、没有 DevTools、没有抖动的 WS
- **不带算法重新实现测 UI**。GUI 是薄壳:选片、填表、看进度、列段。
  Renderer 那边完全没有 MediaPipe 或 OpenCV
- **任一边都能自由换**。明天 CLI 变 Jupyter widget,Electron 变
  Streamlit。算法纹丝不动

## 项目结构

```
backend/
  core/segment_swing.py    ← vendored,严禁编辑
  service/
    pipeline.py            ← run_pipeline():接缝函数
    jobs.py                ← JobManager + WS 广播
    app.py                 ← FastAPI 路由
    __main__.py            ← uvicorn 入口
    schemas.py             ← pydantic 线协议类型
  cli.py                   ← CLI 入口 (同一 pipeline)
  models/pose_landmarker_lite.task    ← 已入库,5.5 MB
src/
  main/index.ts            ← PythonSidecar 生命周期
  preload/index.ts         ← contextBridge
  renderer/                ← React UI
scripts/fetch-model.sh     ← 兜底下载器
docs/                      ← 你在这里
```

## 验收剧本

```bash
# 1. 健康检查
curl http://127.0.0.1:8321/api/health
# {"status":"ok","version":"0.1.0","model_ready":true,...}

# 2. 提交任务
curl -X POST http://127.0.0.1:8321/api/jobs \
     -H 'Content-Type: application/json' \
     -d '{"video_path":"/abs/fdl.mp4","params":{"max_frames":1500}}'
# {"job_id":"51b71ad9db8b"}

# 3. 轮询状态
curl http://127.0.0.1:8321/api/jobs/51b71ad9db8b | jq '.state, (.segments|length)'
# "done"
# 3

# 4. Range 视频流
curl -H 'Range: bytes=0-1023' \
     'http://127.0.0.1:8321/api/videos?path=/abs/fdl.mp4' -o /dev/null -D -
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1023/25243119

# 5. 下载产物
curl http://127.0.0.1:8321/api/artifacts/51b71ad9db8b/segments.json -o seg.json
```

## 许可

见 [LICENSE](../../LICENSE)。