---
title: 打包与发布 (Windows / macOS / Linux)
---

# 打包与发布

AceCrush Swing-Analysis 在三大平台上都以原生桌面应用的形式分发。Electron 渲染层用
`electron-vite`,打包发布用 `electron-builder`,Python 后端通过
PyInstaller 打成二进制。

## 一句话总结

```bash
npm install
npm run pack:mac        # macOS .dmg + .zip (当前架构)
npm run pack:win        # Windows NSIS .exe (需在 Windows 上跑)
npm run pack:linux      # Linux AppImage + .deb (需在 Linux 上跑)
```

产物落在 `release/` 下,例如 `AceCrush Swing-Analysis-0.1.0-mac-arm64.dmg`。

## 跨平台构建矩阵

PyInstaller 会把**当前主机**的 Python 解释器一起塞进二进制,所以每个目标
平台都需要在那个平台上构建 —— **不支持跨平台编译**。打包模式也按平台
分:

| 目标二进制                  | 构建主机            | PyInstaller 模式    | 产物                                                  |
|-----------------------------|---------------------|---------------------|-------------------------------------------------------|
| `swing-backend` (Mach-O)    | macOS (x64 或 arm64)| `--onefile`         | `backend/dist/swing-backend`                          |
| `swing-backend-win/` 目录   | Windows (x64)       | `--onedir`          | `backend/dist/swing-backend-win/swing-backend.exe`    |
| `swing-backend` (ELF)       | Linux (x64)         | `--onefile`         | `backend/dist/swing-backend`                          |

**Windows 为什么用 `--onedir` 而不是 `--onefile`:** `--onefile` 每次启动都
要把整个包(~300 MiB)解压到临时目录,还要触发 Defender 扫描。冷启动 20–40s,
超过 sidecar 的 15s 超时,直接让打包版启动失败。`--onedir` 让 `.exe` 直接
原地运行(3–5s 启动,杀软误报率也低得多)。代价是 NSIS 安装包大 ~150 MiB;
为了"下载 → 安装 → 双击就能用",这个代价可以接受。

## 打包进去的有哪些

- `out/**` — Electron 主 / preload / 渲染层 (electron-vite 产物)
- `backend/dist/swing-backend` — macOS / Linux PyInstaller 单文件 sidecar
- `backend/dist/swing-backend-win/swing-backend.exe` — Windows onedir sidecar
  (一个目录树: `.exe` + `_internal/`,内含 `python*.dll`、`numpy`、
  `mediapipe` 的 solutions、`imageio_ffmpeg` 自带的 `ffmpeg` 二进制 …… )
- `backend/models/**` — MediaPipe / RTMDet / RTMPose ONNX 权重
  (~162 MiB,通过 Git LFS 拉取 —— 见下文 "LFS")
- `build/icon.{png,ico,icns}` — 应用图标

打包后 sidecar 的最终路径:

- **macOS / Linux**: `<resourcesPath>/backend/swing-backend`
- **Windows**:     `<resourcesPath>/backend/swing-backend-win/swing-backend.exe`

模型在所有平台都落在 `<resourcesPath>/models/`。主进程显式传 `--models-dir`
和 `--data-dir`,所以开发环境与发布版的启动方式都能复用同一份 launcher;
PyInstaller frozen 环境下 `__file__` 指向临时解压目录这件事也就无关紧要了。

### LFS

`backend/models/*.onnx` 是 Git LFS 追踪的。如果 CI 的 checkout 没有
`lfs: true`,磁盘上的就是 134 字节的指针文本 —— 打包产物里的 models 目录
其实是空的,运行必挂。`release.yml` 三个 build job 的 checkout 都明确写了
`with.lfs: true`;如果你 fork 或复制工作流,这一行不能丢。

## 开发 vs 打包后的 sidecar 启动

`src/main/index.ts` 在运行时通过 `app.isPackaged` 区分:

- **dev** → `python -m backend.service --port 0 --data-dir <X> --models-dir backend/models`
- **打包后 macOS / Linux** → `<resources>/backend/swing-backend --port 0 --data-dir <userData>/backend-data --models-dir <resources>/models`
- **打包后 Windows**     → `<resources>/backend/swing-backend-win/swing-backend.exe --port 0 --data-dir <userData>/backend-data --models-dir <resources>/models`

打包版启动超时是 **60 秒**(dev 是 15s),留出 macOS onefile 首次解压的时间。
如果 sidecar 启动失败,主进程弹错误对话框后退出 —— 看 stderr / 日志里的
`[sidecar] spawning:` 一行,会打印它实际尝试的命令路径,排查就从这里入手。

数据目录的默认值也对应切换:

- **dev** → `<repoRoot>/backend/data`
- **打包后** → `app.getPath('userData')/backend-data` (每个用户一份,重新
  安装也不会丢)

用户可以在设置面板里改 `output_dir`,改完下次启动生效(sidecar 只读一次
`--data-dir`)。

## CI 工作流

`release.yml` 在 `resolve-tag` 之后跑 **四个原生 OS job**,互相并行:

| Job              | Runner             | 主要步骤                                                                                       |
|------------------|--------------------|------------------------------------------------------------------------------------------------|
| `build-linux`    | `ubuntu-22.04`     | checkout(lfs) → setup-python 3.13 → setup-node → `npm ci` → `bundle:py` → `electron-builder --linux --x64` |
| `build-windows`  | `windows-latest`   | checkout(lfs) → setup-python 3.13 → setup-node → `npm ci` → `bundle:py` → `electron-builder --win --x64`   |
| `build-mac`      | `macos-latest`     | checkout(lfs) → setup-node → **pass1 (arm64)**: setup-python + bundle:py + `file backend/dist/swing-backend` 证据 + `electron-builder --mac --arm64` → **pass2 (x64)**: setup-python `architecture: x64` + 重 pip + 重 `bundle:py` + `file ... \| grep x86_64` 证据 + `electron-builder --mac --x64` |

`publish-release` 拉取三个 `installers-*` artifact,用 `gh release create`
发到公开镜像 repo。`shopt -s globstar` + `dist/installers-*/**/*` 把所有
job 产出的文件一次性展开。

为什么每个平台必须有原生 runner:

- PyInstaller **不能**交叉编译(它会把本机 Python 解释器一起塞进去,解释
  器本身就是原生二进制)。在 Linux runner 上跑 `electron-builder --win`
  历史上产过把 Linux ELF 当 Windows sidecar 塞进去的安装包 —— CI 测不出,
  用户首次启动直接挂。
- macOS 双架构:一次 `bundle:py` 只能产一个架构的 Mach-O。之前用同一份
  sidecar 同时出 `--arm64` 和 `--x64` 两个 dmg,结果 Intel dmg 里塞的是
  arm64 字节。现在用 `setup-python@v5` 的 `architecture:` 参数跑两次
  setup,中间重 `pip install` + 重 `bundle:py`;每次 `electron-builder`
  之前用 `file backend/dist/swing-backend` 把当前 Mach-O 架构打到 CI 日志
  里,出问题立刻看见。

## 首次启动 & 未签名产物的绕过

没有代码签名证书(开源项目 + 没买 Apple Developer 账号 / Windows EV 证书
的默认情况)时,用户首次启动会撞 OS 安全提示。这是**预期的**,不是 bug:

- **macOS Gatekeeper** —— "无法打开 'AceCrush Swing-Analysis.app',因为
  无法验证开发者。" 两种绕过方式:
  1. 右键(按住 Control 点)应用 → **打开** → 在弹窗里再确认一次。macOS
     会按"每台机器每个 app"记住这个选择。
  2. 命令行:`xattr -cr "/Applications/AceCrush Swing-Analysis.app"` —
     去掉 `com.apple.quarantine` 这个扩展属性,启动行为就等价于从 App
     Store 装的。CI 冒烟测试、批量部署等右键不便的场景都用这一招。
- **macOS onefile 首次启动** —— sidecar 会把自身解压到
  `~/Library/.../T/*/swing-backend`,SSD 上 3–8s,机械盘更久。主进程给
  sidecar 留了 60s 启动窗口,就是为了这个。后续启动秒开。
- **Windows SmartScreen** —— "Windows 已保护你的电脑" / "未知发布者"。
  点 **更多信息** → **仍要运行**。选择按"每台机器每个文件"持久化。
  SmartScreen 的信誉靠下载量积累,新版本头几天会比成熟版本警告更频繁。

如果 sidecar **根本起不来**(没提示,直接弹 "sidecar 启动失败" 错误框),
几乎总是这几个原因之一:

- 磁盘上 LFS 模型缺失(重新跑 `git lfs pull`)。
- macOS quarantine 扩展属性还在(用上面的绕过命令)。
- Windows Defender 把 `swing-backend.exe` 删了 / 隔离了(看
  `Windows 安全中心 → 病毒和威胁防护 → 保护历史记录`)。

想深入排查,直接在终端里跑 sidecar 二进制 —— 它会打印
`SWING_SERVICE_URL=http://127.0.0.1:<port>` 一行,然后开始服务 API。

## 代码签名

`electron-builder` 通过环境变量读签名/公证凭据。**任意一个子集都自动启用
—— 空值会静默跳过该步骤而不破坏构建。** 在仓库的 GitHub Actions secrets
里配你有的那些就行,工作流已经把它们注入 `build-windows` 和 `build-mac`:

| Secret                            | 用途                                                                       |
|-----------------------------------|----------------------------------------------------------------------------|
| `CSC_LINK`                        | Base64 之后的 `.pfx` (Windows) / `.p12` (macOS) 签名证书                   |
| `CSC_KEY_PASSWORD`                | 该证书的密码                                                              |
| `APPLE_ID`                        | `xcrun notarytool` 用的 Apple ID                                          |
| `APPLE_APP_SPECIFIC_PASSWORD`     | App-specific 密码(不是 Apple ID 的密码)                                  |
| `APPLE_TEAM_ID`                   | developer.apple.com 上 10 位 Team ID                                       |

建议的推进顺序:

1. 先发未签名产物;验证 CI 矩阵在三个 runner 上都能产出可用的安装包。
2. 加上 Windows 的 `CSC_LINK` + `CSC_KEY_PASSWORD` —— 重复下载的用户
   不再看到 SmartScreen。
3. 五个 Apple secrets 全配上,做 macOS 公证 —— 消除 Gatekeeper。

升级 / 降级签名配置不需要改工作流,同一份 `release.yml` 三种状态都跑。

## 这次改动的文件

| 路径                                             | 说明                                                                  |
|--------------------------------------------------|-----------------------------------------------------------------------|
| `build/icon.{png,ico,icns}`                      | 平台相关图标                                                          |
| `build/entitlements.mac.plist`                   | macOS hardened-runtime 例外                                           |
| `backend/launcher.py`                            | PyInstaller 入口                                                      |
| `scripts/generate-icons.js`                      | 跨平台图标重新生成                                                    |
| `scripts/build-python-bundle.js`                 | PyInstaller 封装 (onefile / onedir 分支)                              |
| `src/main/index.ts` (改)                         | dev/打包 spawn 切换 + 60s 超时 + Windows taskkill                     |
| `src/main/panels.ts` (改)                        | panel 窗口图标                                                        |
| `src/main/settings.ts` (改)                      | 打包后 defaultDataDir                                                 |
| `src/renderer/{index,clips,log}.html` (改)      | favicon + Swing-Analysis 标题                                         |
| `package.json` (改)                              | electron-builder 配置 + 脚本                                          |
| `.github/workflows/release.yml` (改)            | 4-job 原生矩阵 + LFS                                                  |
| `.gitignore` (改)                                | 跟踪图标但忽略中间产物                                                |
