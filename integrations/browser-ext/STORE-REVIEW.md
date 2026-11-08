# 三市场上架合规清单（Chrome Web Store / Edge Add-ons / AMO）

> 2026-11-08 深审基线。产物：`dist/{chrome,edge,firefox}`（构建即清单，无手工改动）。
> 结论：**技术合规已达标；上架需补「文档/素材」三件 + eval 审核说明（见 §4）。**

## 0. 浏览器覆盖矩阵

| 浏览器 | 用哪份产物 | 状态 | 说明 |
|---|---|---|---|
| Chrome | dist/chrome | ✅ 主目标 | MV3 service_worker |
| Edge | dist/chrome（同 Chromium） | ✅ 零改动 | 商店单独注册 |
| **Brave / Vivaldi / Opera / Arc / Yandex** | dist/chrome | ✅ 零改动 | Chromium 系直装 CWS 或开发者模式加载；Opera 需「安装 Chrome 扩展」跳板（或直接加载） |
| Firefox / ESR / Nightly / DevEdition | dist/firefox | ✅ 主目标 | 事件页 background.scripts；ESR/Dev/Nightly 可免签装 xpi |
| **LibreWolf / Waterfox / Zen / Tor**（Firefox 系） | dist/firefox | ✅ 零改动 | fork 跟随 Firefox 128+；LibreWolf 天然允许未签名扩展 |
| Firefox for Android | dist/firefox | ✅ | 需 AMO 签名（gecko id 已固定） |
| **Safari**（macOS / iOS） | 需移植 | 📋 评估中 | 见 §7 |
| Samsung Internet / 国产双核（360/QQ/搜狗） | — | ❌ 不建议 | API 子集差异大 / 内核老旧 MV3 支持参差，开发者调试场景价值低 |

### §7 Safari 移植评估（唯一需要真实移植的）

- **API 基线（核实）**：Safari 16.4+ 名义支持 world:"MAIN" content script（MDN/Apple 论坛）——但实测有 bug 且 iOS/macOS 行为不一致，社区惯例回退 script 标签 DOM 注入；MV3 背景须 service_worker 或非持久页（我们的 sw.js 仅 onInstalled+storage，兼容）；storage.sync/session ✅
- **移植路径**：xcrun safari-web-extension-converter dist/chrome → Xcode 工程（Swift 壳 App）→ 构建/签名
- **前提**：macOS + Xcode；上架 App Store 需 Apple Developer（$99/年）；本地自用可 Xcode 构建免上架
- **风险点**：① world:MAIN 平台差异——launcher 注入可能需回退 script 标签方案（与页面 CSP 注入设计冲突，需验证）② gecko 专属键剥除 ③ popup/options 无差异
- **建议优先级**：P2——等 v2（默认关/按需注入）在三大浏览器稳定后；mac 测试机是生态一级平台，Safari 用户值得做，但不阻塞当前

## 1. 已达标项（自动化扫描 + 逐项核对）

| 项 | 状态 | 依据 |
|---|---|---|
| MV3 manifest | ✅ 三端 | manifest_version: 3 |
| 无内联事件处理器 / 内联 script | ✅ | popup/options HTML 零 onclick/onload；脚本全部外链文件（MV3 CSP 合规） |
| 无 web_accessible_resources 需求 | ✅ | launcher 构建期内联进 content script，不依赖页面可取资源 |
| 无远程托管代码 | ✅ | launcher/cdp-core 构建期内联；运行时 fetch 仅指向**用户自配**的桥/AI 地址（HEAD 探测/数据交互），无第三方代码源 |
| manifest icons + action.default_icon | ✅ | 16/32/48/128（aiti 品牌标，sharp 渲染） |
| Firefox 事件页 | ✅ | `background.scripts`（build 按 target 分叉；service_worker 为 Chromium 专属） |
| Firefox 稳定签名前置 | ✅ | `gecko.id: aiti-devtools@aiti.ai` + `strict_min_version: 128.0`（gecko_android 同） |
| Chromium 版本下限 | ✅ | `minimum_chrome_version: "111"`（world:MAIN 依赖；firefox 走 gecko 128） |
| author / homepage_url | ✅ | aiti-ai / https://aiti.pw |
| 默认关 + 按需启用 | ✅ | v2：新装不注入任何页面；popup 一键按需 / 白名单——显著降低 `<all_urls>` 审核敏感度 |
| 产物非压缩可读 | ✅ | build 不混淆（launcher 源码内联可读）——AMO 源码审查友好 |

## 2. 需要审核说明的两项（不可删，是产品功能）

### 2.1 `eval` / `new Function`（content/main.js ×3）

- `Runtime.evaluate` 等价核心：`targetWin.eval(...)` —— 在**被调试网页**里执行 AI 请求的表达式（调试器产品功能，同浏览器 DevTools Console）
- self 宿主页：`new Function("__DBG_POST__", MINI_DBG_CLIENT...)` —— 编译**构建时内联**的常量字符串（非远程）

**CWS 审核应答（粘贴用）**：
> The eval/new Function calls execute JavaScript in the *debugged web page* only — this is the core function of the developer-debugging tool (equivalent to browser DevTools Console). The code strings are compiled at build time into the package (no remotely hosted code) or supplied by the user's own locally-running aiti bridge (127.0.0.1 by default, user-configurable). No third-party/remote code source is involved. Injection is off by default and only happens on explicit user action or user-configured allowlist.

**AMO 审核应答**：同上（英文提交）；AMO 若要求源码 → 提交 `browser-ext/` 目录 + `packages/aiti-devtools-core/assets/` 构建说明（build 从源码可复现）。

### 2.2 `host_permissions: ["<all_urls>"]`

- 用途说明（三市场粘贴）：**开发者调试工具**——需向任意被调试网页注入调试助手；注入**默认关闭**，仅在用户显式按需启用或白名单站点自动注入；数据仅与用户自配的本地桥/工作台交互，无遥测。
- 风险评估：CWS 对 `<all_urls>`+调试类工具有成熟先例（同类注入型开发工具可过），但可能触发人工深审（视频演示偶发要求）；**默认关设计是最大的减分险规避**。

## 3. 上架待办（提交前必须补齐）

| # | 待办 | 适用商店 |
|---|---|---|
| 1 | **隐私政策 URL**（CWS/Edge 对 `<all_urls>` 扩展强制要求；AMO 建议有）——需可公开访问的页面。草稿：见 §5 | 三市场 |
| 2 | **商店素材**：CWS 128×128 商店图标（可由 icon128 放大版直接用）+ 440×280 小宣传图 + 920×680/1400×560 大图 + 1-5 张截图 | CWS / Edge |
| 3 | **单一用途声明**（CWS 必填）：One purpose: an in-page AI debugging assistant for web developers（注入调试器 + AI 协作即全部功能） | CWS |
| 4 | **权限逐项说明**（提交表单）：storage=保存用户设置；activeTab/scripting=按需向当前被调试页注入；host_permissions=任意网页可作为调试目标（默认关） | 三市场 |
| 5 | Edge 商店需单独注册卖家账号 + 上传同一 zip | Edge |
| 6 | AMO 需 AMO 账号；如走自分发签名需 API Key（`web-ext sign --channel=unlisted`） | AMO |

## 4. 三市场差异速查

| | CWS | Edge Add-ons | AMO |
|---|---|---|---|
| manifest | MV3 service_worker ✅ | 同 Chrome ✅ | MV3 事件页 background.scripts ✅ |
| 签名 | 商店自动 | 商店自动 | unlisted 签名后可自分发；Android 需签名 |
| eval | 政策禁远程代码，本地源可说明 | 同 CWS | 需说明，可能要求源码（非压缩 ✓） |
| `<all_urls>` | 人工深审风险（默认关缓解） | 同 CWS | 触发额外审核（工具类先例可过） |
| 隐私政策 | **强制**（broad host perms） | 强制 | 建议 |

## 5. 隐私政策草稿（部署到 aiti.pw/privacy 后引用）

> **aiti devtools 隐私说明**：本扩展不收集、不上传任何遥测或个人数据。所有配置仅保存在浏览器本地（browser storage）。扩展运行时只与**用户自行配置**的服务地址通信（默认为本机 127.0.0.1 的本地桥/工作台）——通信内容为被调试页面的调试信息，经用户显式操作触发。注入行为默认关闭，仅在被调试页面上由用户按需启用或按白名单自动启用。

## 6. 已知非阻塞项

- `content/main.js` 在默认关时仍以 content script 形式常驻所有页面（零 DOM 副作用退出）——严格隐私模式（移除常驻脚本改事件驱动注入）在 v2 规划 P2
- 人工审核员可能要求演示视频（CWS 对 `<all_urls>` 偶发）——录一段「popup 按需启用 → AI 修页面元素」30s 即可
