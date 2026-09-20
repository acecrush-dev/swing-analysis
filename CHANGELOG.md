# Changelog（更新日志）

> Keep a Changelog 简化版；semver tag 约定。本文件为中文版；英文版见 [CHANGELOG_EN.md](CHANGELOG_EN.md)。
>
> 本文件同时是**发布描述的唯一来源**：`release` 工作流会自动提取下方对应
> `## [x.y.z]` 段落作为 GitHub Release 描述（缺段落时回退通用占位文案）。
> 注意：发布描述取自中文版；需要英文发布描述时用 CHANGELOG_EN.md 手动替换。

## [Unreleased]

暂无内容。

## [1.0.0] — 2026-09-09 · Beta

### 版本描述

AceCrush Swing-Analysis 是**桌面端网球挥拍自动切分工具**。1.0.0 是第一个
公开 Beta：把已实测验证的切分管线包装成完整桌面应用 —— 从练习视频里自动
找出每一次挥拍、切成独立片段，并生成骨架叠加预览，逐帧回看技术动作。

**这个版本你能做什么：**

- **自动切分** —— MediaPipe 姿态追踪提取右手腕速度信号，峰值检测自动找出
  每次挥拍：相邻峰值自动合并、按时长过滤、两侧留缓冲，无需手动拖时间轴找点。
- **骨架叠加预览（viz）** —— 每段挥拍一键生成姿态骨架叠加在原始画面上的
  mp4 预览，可内嵌播放也可下载。
- **片段导出** —— 检出的每段挥拍自动切出独立 H.264 mp4；`segments.json`
  保留完整时间数据，便于进一步分析。
- **双管线模式** —— `SWING_BACKEND=python`（Python sidecar 服务）或
  `SWING_BACKEND=ts`（应用内 TypeScript 管线），两种模式驱动同一套统一
  界面，切换模式不改变任何使用方式。

**隐私与数据**：全部分析在本地完成（本地 sidecar 服务或应用内 WASM 管线），
视频不上传。

**获取方式**：从 GitHub Releases 下载安装包 —— macOS（Apple 芯片 & Intel）、
Windows 10/11 x64、Linux（AppImage / deb）。

**Beta 已知限制：**

- macOS Intel 版（`mac-x64.dmg`）体积偏大（约 1 GB，Apple 芯片版约 450 MB）
  —— 包内无害死重，下个版本自然瘦身
- Beta 期间功能与行为可能随版本调整

### Added

- 基于手腕速度信号的挥拍段自动切分（MediaPipe 姿态 30 fps 采样，峰值自动合并、按时长过滤、两侧缓冲）
- 骨架叠加预览（viz）：每段挥拍一键生成姿态骨架叠加 mp4，可内嵌播放或下载
- 片段导出：每段挥拍自动切出独立 H.264 mp4；`segments.json` 保留完整时间数据
- 双管线模式：`SWING_BACKEND=python`（Python sidecar）或 `SWING_BACKEND=ts`（应用内 TypeScript 管线），同一套统一界面
- 跨平台安装包：macOS（Apple 芯片 & Intel dmg）、Windows 10/11 x64、Linux（AppImage / deb）

### Notes

- macOS Intel 版（`mac-x64.dmg`）体积偏大（约 1 GB，Apple 芯片版约 450 MB）—— 包内无害死重，下个版本自然瘦身

[Unreleased]: https://github.com/acecrush-dev/swing-analysis-app/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/acecrush-dev/swing-analysis-app/releases/tag/v1.0.0
