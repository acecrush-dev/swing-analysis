---
title: 打包与发布 (Windows / macOS / Linux)
---

# 打包与发布

AceCrush Swing-Analysis 在三大平台上都以原生桌面应用的形式分发。Electron 渲染层用
`electron-vite`，打包发布用 `electron-builder`，Python 后端通过
PyInstaller 打成单文件二进制。

## 一句话总结

```bash
npm install
npm run pack:mac        # macOS .dmg + .zip (当前架构)
npm run pack:win        # Windows NSIS .exe (需在 Windows 上跑)
npm run pack:linux      # Linux AppImage + .deb (需在 Linux 上跑)
```

产物落在 `release/` 下,例如 `AceCrush Swing-Analysis-0.1.0-mac-arm64.dmg`。

## 跨平台构建矩阵 ⚠️

PyInstaller 会把**当前主机**的 Python 解释器一起塞进二进制,所以每个目标
平台都需要在那个平台上构建:

| 目标二进制             | 构建主机                  | 产物                              |
|------------------------|---------------------------|-----------------------------------|
| `swing-backend`        | macOS (x64 或 arm64)      | `<dist>/swing-backend`            |
| `swing-backend.exe`    | Windows (x64)             | `<dist>/swing-backend.exe`        |
| `swing-backend`        | Linux (x64)               | `<dist>/swing-backend`            |

**不支持跨平台编译**。一种主流做法是用 GitHub Actions 的
`macos-latest` / `windows-latest` / `ubuntu-latest` 三个 runner 各打一份。

## 打包进去的有哪些

- `out/**` — Electron 主 / preload / 渲染层 (electron-vite 产物)
- `backend/dist/swing-backend(.exe)` — PyInstaller 单文件 Python 服务
- `backend/models/**` — MediaPipe / RTMDet / RTMPose ONNX 权重 (~162 MiB)
- `build/icon.{png,ico,icns}` — 应用图标

打包后在应用里,Python 二进制落在
`<resourcesPath>/backend/swing-backend(.exe)`,模型落在
`process.resourcesPath/models/`。主进程显式传 `--models-dir` 和
`--data-dir`,所以开发环境与发布版的启动方式都能复用同一份 launcher。

## 开发 vs 打包后的 sidecar 启动

`src/main/index.ts` 在运行时通过 `app.isPackaged` 区分:

- **dev** → `python -m backend.service --port 0 --data-dir <X> --models-dir backend/models`
- **打包后** → `<resources>/backend/swing-backend(.exe) --port 0 --data-dir <userData>/backend-data --models-dir <resources>/models`

数据目录的默认值也对应切换:

- **dev** → `<repoRoot>/backend/data`
- **打包后** → `app.getPath('userData')/backend-data` (每个用户一份,重新
  安装也不会丢)

用户可以在设置面板里改 `output_dir`,改完下次启动生效(sidecar 只读一次
`--data-dir`)。

## CI 工作流 (草稿)

```yaml
# .github/workflows/release.yml
jobs:
  mac:
    runs-on: macos-latest
    steps: [checkout, lfs-pull, setup-node, setup-python, pip pyinstaller,
            npm ci, npm run pack:mac, upload-artifact]
  win:
    runs-on: windows-latest
    # ... npm run pack:win
  linux:
    runs-on: ubuntu-latest
    # ... npm run pack:linux
```

## 代码签名 / 公证 (上线前要做)

- **Windows**: NSIS 默认不打证书,用户会看到 SmartScreen 警告。设
  `win.certificateFile` + 环境变量 `CSC_KEY_PASSWORD`。
- **macOS**: 已经开了 `hardenedRuntime: true`。正式发布还需设
  `mac.identity`、`CSC_LINK`、`CSC_KEY_PASSWORD`,然后跑
  `electron-builder notarize`,配 `APPLE_ID` +
  `APPLE_APP_SPECIFIC_PASSWORD`。没公证的话,Gatekeeper 会拦首次启动。
- **Linux**: AppImage / deb 默认无签名。AppImage 第一次需要 `chmod +x`;
  .deb 加了 apt 源就 `dpkg -i`。

## 这次改动的文件

| 路径                                             | 说明                                                |
|--------------------------------------------------|-----------------------------------------------------|
| `build/icon.{png,ico,icns}`                      | 平台相关图标                                        |
| `build/entitlements.mac.plist`                   | macOS hardened-runtime 例外                         |
| `backend/launcher.py`                            | PyInstaller 入口                                    |
| `scripts/generate-icons.js`                      | 跨平台图标重新生成                                  |
| `scripts/build-python-bundle.js`                 | PyInstaller 单文件封装                              |
| `src/main/index.ts` (改)                         | dev/打包 spawn 切换 + 图标                          |
| `src/main/panels.ts` (改)                        | panel 窗口图标                                      |
| `src/main/settings.ts` (改)                      | 打包后 defaultDataDir                               |
| `src/renderer/{index,clips,log}.html` (改)      | favicon + Swing-Analysis 标题                       |
| `package.json` (改)                              | electron-builder 配置 + 脚本                        |
| `.gitignore` (改)                                | 跟踪图标但忽略中间产物                              |
