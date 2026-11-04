# aiti-devtools 浏览器扩展（Chrome / Edge / Firefox）

任意网页——**无需目标应用任何改造**——注入 aiti-devtools 页面内 AI 调试助手
（FAB 💬+🎯、Inspector 点选、AI 窗），配合 aiti-devtools 桥（本地独立桥或 pi-web）
即可用 pi / claude / opencode 等 agent 操作任意页面。

方案设计见 `docs/aiti-devtools-browser-ext-plan.md`（同仓）。

## 快速开始

```bash
cd browser-ext
npm run build       # → dist/chrome dist/edge dist/firefox
npm run package     # → dist/*.zip（需系统 zip）

# 前置：确保 aiti-devtools 桥在跑（默认本地独立桥 127.0.0.1:8777）
#   systemctl start aiti-bridge      # 或 node packages/aiti-bridge/bin/aiti-bridge.mjs
```

### 安装

- **Chrome/Edge**：`chrome://extensions`（或 `edge://extensions`）→ 开启「开发者模式」→
  「加载已解压的扩展程序」→ 选 `dist/chrome`（Edge 选 `dist/edge`）
- **Firefox**：`about:debugging#/runtime/this-firefox` → 「临时载入附加组件」→ 选
  `dist/firefox/manifest.json`
- **Firefox for Android（Fenix）**：`dist/firefox`（需 Firefox ≥ 120；永久安装需签名的
  稳定 gecko id `aiti-devtools@aiti.ai`）

## 使用

1. 装好后，任意网页自动出现右下角 FAB（💬 AI + 🎯 Inspector）。
2. 点 💬 打开 AI 窗（默认 = 桥同源的 cockpit 操作台）。
3. agent 端接入（三选一）：
   - **pi**：装 aiti-devtools-pi，会话内直接调 `aiti_*` 工具（连同一桥）
   - **stdio shim**：env `AITI_BRIDGE_URL=http://127.0.0.1:8777/aiti`（见 options 页复制地址）
   - **MCP**：mcp.json 加 `{ type: "http", url: "<bridgeUrl>/mcp/mcp" }`

## 配置（options 页）

- **桥地址**：默认 `http://127.0.0.1:8777/aiti`（本地独立桥）；可填远程 pi-web 桥
- **AI 窗地址**：默认 `http://127.0.0.1:8777/cockpit.html`；可指向 pi-web AI 窗
- **全局开关** / **排除站点**（每行一个正则）
- **AITI_BRIDGE_URL**：agent 端 stdio shim 接入用，一键复制

> 配置保存后**刷新页面**生效（stable 语义，见方案 D1）。

## 实现要点

- 注入 = `world:"MAIN"` content script（Chrome/Edge 111+、Firefox 128+），launcher 源码
  构建时内联进 `content/main.js`（文件顶层执行，**不受页面 CSP 约束**）
- 配置 = isolated world（`content/bridge.js`）读 storage.sync → 写 localStorage（跨 world
  共享）→ MAIN world document_idle 同步读 → 注入
- 防重复：`window.__dbgLauncherInstalled` 守卫（页面本身有 launcher，如 pi-web，时不双注入）
- 小屏：Firefox for Android 完整支持（MV3）；launcher 小屏物理适配内置，注入即用

## 目录

```
browser-ext/
├── src/
│   ├── content/   bridge.js(隔离世界配置) + main.js(主世界注入)
│   ├── background/ sw.js
│   ├── popup/     popup.html/css/js
│   └── options/   options.html/css/js
├── scripts/       build.mjs + package.mjs
└── dist/          chrome/ edge/ firefox/（构建产物）
```