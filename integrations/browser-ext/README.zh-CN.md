# aiti-devtools 浏览器扩展（Chrome / Edge / Firefox）

> ✅ **v2 已实施（P0）**：**默认关闭**——popup「⚡ 本页启用（本次）」一键按需注入 / 「★ 总是启用此站点」白名单；AI 窗默认指向 **pi-web**（设置页自动探测预填）或任意兼容 agent 宿主，cockpit 降为兜底档。P1/P2（快捷键、per-site 目标等）见 `docs/aiti-devtools-browser-ext-v2-plan.md`。
>
> 🇬🇧 English: see [README.md](README.md)

任意网页——**无需目标应用任何改造**——按需注入 aiti-devtools 页面内 AI 调试助手
（FAB 💬 AI + 十字准星 Inspector、点选、AI 窗），AI 窗默认指向 **pi-web 工作台**，
配合 aiti-devtools 桥（本地独立桥或 pi-web）即可用 pi / claude / opencode 等 agent 操作任意页面。

方案设计见 `docs/aiti-devtools-browser-ext-plan.md`（同仓）；v2 增强规划见 `docs/aiti-devtools-browser-ext-v2-plan.md`。

## 快速开始

```bash
cd browser-ext
npm run build       # → dist/chrome dist/edge dist/firefox
npm run package     # → dist/*.zip + dist/aiti-devtools-firefox.xpi（需系统 zip）

# 前置：确保 aiti-devtools 桥在跑（默认本地独立桥 127.0.0.1:8777）
#   systemctl start aiti-bridge      # 或 node packages/aiti-bridge/bin/aiti-bridge.mjs
```

### 安装

- **Chrome/Edge**：`chrome://extensions`（或 `edge://extensions`）→ 开启「开发者模式」→
  「加载已解压的扩展程序」→ 选 `dist/chrome`（Edge 选 `dist/edge`）
- **Firefox（临时载入）**：`about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ 选
  `dist/firefox/manifest.json`（重启后消失，重新载入即可；build 已按 Firefox 换事件页 background.scripts）
- **Firefox（永久 xpi）**：`npm run package` → `dist/aiti-devtools-firefox.xpi`——
  ESR / DevEdition / Nightly 在 `about:config` 开 `xpinstall.signatures.required=false` 后
  「从文件安装」即可永久使用（免签名）；正式版 / Android 永久安装需 AMO 签名
  （`web-ext sign --channel=unlisted` 或 AMO 后台上传本 xpi 走 unlisted；稳定 gecko id `aiti-devtools@aiti.ai` 已固定）

## 使用（v2：默认关）

1. 装好后默认**不注入**任何页面——工具栏弹窗显示本页状态。
2. **按需启用**：popup「⚡ 本页启用（本次）」一键注入当前页（导航后失效）；或「★ 总是启用此站点」加入白名单，之后该站导航自动注入。
3. 启用后页面右下角出现 FAB（💬 AI + 十字准星 Inspector）。
4. 点 💬 打开 AI 窗（默认 = 设置里的 AI 目标：pi-web 工作台 / 兼容 agent / cockpit 兜底）。
5. agent 端接入（三选一）：
   - **pi**：装 aiti-devtools-pi，会话内直接调 `aiti_*` 工具（连同一桥）
   - **stdio shim**：env `AITI_BRIDGE_URL=http://127.0.0.1:8777/aiti`（options 页一键复制）
   - **MCP**：mcp.json 加 `{ type: "http", url: "<bridgeUrl>/mcp/mcp" }`

## 配置（options 页，v2）

- **AI 目标三档**：pi-web 工作台（推荐）/ 兼容 agent 宿主 / cockpit 兜底；目标地址 + **🔍 一键探测本机 pi-web**（30141/30142 自动预填；选中 pi-web 联动预填同源桥地址）
- **站点规则**：默认关 + **白名单站点**（每行一个正则，命中自动注入）+ **排除站点**（优先级最高，白名单命中也不注入）
- **高级**：桥地址 / agent 端接入（AITI_BRIDGE_URL 一键复制）

> 配置保存后**刷新页面**生效（stable 语义，见方案 D1）。

## 实现要点

- 注入 = `world:"MAIN"` content script（Chrome/Edge 111+、Firefox 128+），launcher 源码
  构建时内联进 `content/main.js`（文件顶层执行，**不受页面 CSP 约束**）
- 配置 = isolated world（`content/bridge.js`）读 storage.sync → **站点规则求值**（denySites 优先）→
  写 localStorage（跨 world 共享）→ MAIN world document_idle 同步读 → 注入
- 防重复：`window.__dbgLauncherInstalled` 守卫（页面本身有 launcher，如 pi-web，时不双注入）
- 小屏：Firefox for Android 完整支持（MV3）；launcher 小屏物理适配内置，注入即用

## 目录

```
browser-ext/
├── src/
│   ├── content/   bridge.js(隔离世界配置+规则求值) + main.js(主世界注入)
│   ├── background/ sw.js（安装初始化 + v1 迁移）
│   ├── popup/     popup.html/css/js（本页状态 + 按需启用/白名单）
│   └── options/   options.html/css/js（AI 目标 + 站点规则 + 高级）
├── scripts/       build.mjs + package.mjs
├── icons/         品牌图标（aiti-docs 同款 logo.svg + PNG 族）
└── dist/          chrome/ edge/ firefox/（构建产物）
```
