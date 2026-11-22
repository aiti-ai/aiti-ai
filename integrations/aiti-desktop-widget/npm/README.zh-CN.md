# @aiti-ai/aiti-desktop-widget

**与业务无关的原生桌面悬浮窗宿主**——无框、透明、置顶，可选点击穿透/拖动。内容一律通过
URL 或本地 HTML 加载；内置多显示器定位与 stdin JSONL 控制通道。

[English](./README.md) · 简体中文

## 关于 aiti

本包属于 **aiti** 生态——基于 [pi](https://pi.dev) 的个人 AI 开发工作台：**aiti-agent**
（自托管 Web 工作台）、主流开发工具的调试注入（aiti-devtools），以及丰富的扩展体系。

- 生态主仓：<https://github.com/aiti-ai/aiti-ai>
- 官网：<https://aiti.pw> · 文档：<https://aiti.pw/extensions/aiti-desktop-widget.html> · 扩展注册表：<https://aiti.pw/extensions.html>（<https://aiti.pw/extensions.json>）
- 主要使用方：**[aiti-video-studio](https://aiti.pw/extensions/aiti-desktop-widget.html#与-aiti-video-studio-集成)**
  （视频工作室）用 aiti-desktop-widget 显示实时桌面字幕窗

分类：桌面工具 · 标签：`desktop` · `widget` · `tauri` · `字幕` · `悬浮层`

## 安装

```bash
npm install -g @aiti-ai/aiti-desktop-widget
# 或免安装直接运行
npx @aiti-ai/aiti-desktop-widget --help
```

npm 包本身只是启动器：平台二进制是 GitHub/Gitee Release 资产，**首次运行时**通过
[justget](https://www.npmjs.com/package/justget) 多源竞速下载——分块、sha256 校验、按
版本/平台缓存。

- 主源：GitHub Releases
- 镜像：Gitee、`gh-proxy.com`、`ghfast.top`、`ghproxy.net`（由 justget 竞速）
- 使用前会校验同一 Release 的 `checksums.txt`

支持平台：`linux-x64`、`linux-arm64`、`win32-x64`、`win32-arm64`、`darwin-x64`、`darwin-arm64`。

### 本地 / 离线安装

从源码 checkout 打包启动器并预置二进制缓存（不依赖已发布的 Release）：

```bash
cd integrations/aiti-desktop-widget/npm
npm pack
npm install -g ./aiti-ai-aiti-desktop-widget-0.2.0.tgz --ignore-scripts --registry https://registry.npmjs.org
# Windows 上 npm 对本地 tarball 偶尔不建 shim，可补：
npm rebuild -g @aiti-ai/aiti-desktop-widget
```

把构建出的二进制放进缓存，并写一行 `sha256sum` 格式的校验（**名字用 release 资产名**：
需要下载时启动器按这个名校验）：

| 系统 | 缓存路径 | 校验名 |
|---|---|---|
| Linux | `~/.cache/aiti-desktop-widget/<version>/<platform>/` | `aiti-desktop-widget-linux-x64` / `-arm64` |
| macOS | `~/Library/Caches/aiti-desktop-widget/<version>/<platform>/` | `aiti-desktop-widget-darwin-x64` / `-arm64` |
| Windows | `%LOCALAPPDATA%\aiti-desktop-widget\cache\<version>\<platform>\` | `aiti-desktop-widget-win32-x64.exe` / `-arm64.exe` |

```bash
CACHE=~/.cache/aiti-desktop-widget/0.2.0/linux-x64
mkdir -p "$CACHE"
cp target/release/aiti-desktop-widget "$CACHE/aiti-desktop-widget"
sha256sum "$CACHE/aiti-desktop-widget" | awk '{print $1"  aiti-desktop-widget-linux-x64"}' > "$CACHE/checksums.txt"
aiti-desktop-widget --version
```

## 用法

```bash
# 加载网页：无框 + 透明
aiti-desktop-widget http://127.0.0.1:8765/caption-bar.html --width 900 --height 140 \
  --x 190 --y 650 --click-through true

# 本地 HTML（壳内起 loopback 静态服务）
aiti-desktop-widget --html ./pet/index.html --root ./pet --width 220 --height 220 --draggable true

# 选择显示器；x/y 是该屏内相对坐标，缺省轴居中
aiti-desktop-widget http://127.0.0.1:8765/ --display 1 --width 900 --height 140

aiti-desktop-widget --help
```

启动器会转发 argv/stdin/stdout/stderr、信号和原生退出码，因此 stdin JSONL 控制通道与
直接运行原生二进制完全一致。

## 编程调用

```js
import { ensureBinary, binaryPath, releaseUrls } from "@aiti-ai/aiti-desktop-widget";

const bin = await ensureBinary(); // 只下载一次，返回缓存路径
console.log(binaryPath());        // 缓存路径（不触发下载）
console.log(releaseUrls());       // tag、asset、GitHub/Gitee/镜像 URL
```

适合需要自己 spawn 窗口的 runner（例如视频工作室的字幕窗）。

## 环境变量

| 变量 | 含义 |
|---|---|
| `AITI_DESKTOP_WIDGET_BIN` | 直接使用该可执行文件，跳过下载 |
| `AITI_DESKTOP_WIDGET_CACHE_DIR` | 缓存根目录（默认：系统缓存目录） |
| `AITI_DESKTOP_WIDGET_RELEASE_BASE` | 单一 Release 基地址（内网/自托管镜像/测试） |
| `AITI_DESKTOP_WIDGET_MIRRORS` | 额外镜像基地址，逗号分隔 |
| `AITI_DESKTOP_WIDGET_REPO` | 覆盖 `owner/repo`（默认 `aiti-ai/aiti-ai`） |
| `AITI_DESKTOP_WIDGET_TAG` | 覆盖 Release tag（默认 `aiti-desktop-widget-v<version>`） |
| `AITI_DESKTOP_WIDGET_VERBOSE` | `1` 输出下载进度 |

缓存位置：Linux `~/.cache/aiti-desktop-widget/<version>/<platform>`；macOS
`~/Library/Caches/aiti-desktop-widget/...`；Windows `%LOCALAPPDATA%\aiti-desktop-widget\cache\...`。

## 被 aiti-video-studio 使用

[aiti-video-studio](https://aiti.pw/extensions/aiti-desktop-widget.html#与-aiti-video-studio-集成)
（视频工作室）用于确定性演示录制与实时演示。桌面 `overlay` 字幕模式会用本壳打开一个
loopback 字幕页（`caption-bar.html?bubble=1`），通过 SSE 推送字幕；**窗口归壳，内容归
视频工作室**。同一个壳也可承载悬浮状态卡、桌面宠物或任意本地 HTML 页面。

## 说明

- Linux 需要 glibc 2.35+（在 Ubuntu 22.04 构建）以及运行时的 WebKitGTK 4.1 + GTK3。
- Windows 需要 WebView2 运行时（Windows 10/11 已预装，含 ARM64）。
- macOS 可执行文件把 `Info.plist` 嵌入 `__TEXT,__info_plist`（ATS localhost 例外 +
  `LSUIElement`），裸二进制即可加载 `http://127.0.0.1` 页面，无需 `.app` bundle。
- Windows 二进制未签名；手动下载可能触发 SmartScreen。npm 下载路径不会写入
  Mark-of-the-Web。
- 没有 `postinstall` 下载：安装阶段离线安全，首次实际运行才拉取二进制。可用
  `AITI_DESKTOP_WIDGET_RELEASE_BASE` 指向预置镜像。
