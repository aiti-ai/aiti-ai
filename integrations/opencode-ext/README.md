# opencode-ext

> OpenCode 扩展作用域目录（npm scope `@aiti-ai/aiti-devtools-opencode`）。承载 aiti-devtools → OpenCode 宿主的 adapter（host 插件 + web UI AI 窗 client）。

## 这是什么

把 `aiti-devtools`（页面内 AI 调试助手）完整接入 **OpenCode**（sst 开源编码 agent，官方 web UI）：

- **host 插件**（`~/.config/opencode/plugins/` 或 npm 包）：进程内注册 16 个 `aiti_*` 工具（`tool()` 工厂，不走 MCP）+ 桥 SSE 推送注入 + `session.idle` 回答回桥 + **占位符改写**（`experimental.chat.messages.transform`）
- **web UI AI 窗适配**（`client/aiti-client-opencode.js`，不 fork）：候选条/详情弹窗/交互卡/占位符——经 nginx 反代自动注入（剥 CSP + `/aiti/` 同源挂桥 + sub_filter）
- **AI 窗 = `https://opencode.pi.example.com:8443/`**（官方 web UI 原样，功能全量）

## 结构

```
opencode-ext/
├── README.md
└── aiti-devtools-opencode/
    ├── src/index.ts                    # 插件（工具注册 + 推送注入 + messages.transform 占位符改写）
    ├── client/aiti-client-opencode.js  # ★web UI AI 窗适配（vanilla DOM；桥经 --assets-extra serve）
    ├── tools/build.mjs                 # esbuild → dist/（external @opencode-ai/plugin）
    ├── tools/deploy.mjs                # → ~/.config/opencode/plugins/
    └── tools/oc-localhost-proxy.mjs     # 本地无认证双协议代理（8442 TLS + 8443 plain → 19870；开发/E2E）
    └── tools/oc-web-proxy.mjs          # 单 HTTP 反代（4322 → opencode web 4321；老工具，保留）
```

## 数据流（占位符方案，DSH 同款语义）

```
点选元素（目标页 launcher）──桥──▶ AI 窗候选条（chip）
  │ 点击 chip                     │ 候选变化 → POST /aiti/bridge/picked {tag,describe,pageId}[]
  ▼                               │
composer 插 [元素N] ──用户发送──▶ 插件 messages.transform：
                                   GET /aiti/bridge/picked → rewriteMessage（core 公共库）
                                   [元素N] → 完整 describe + [发自: pageId · url]
                                   （会话历史保留原占位符；只有 LLM 输入被展开）
                                   └─▶ POST /aiti/bridge/ai/event {aiti_consumed,{tags}}
                                          └─▶ 桥 pushAiEvent → AI 窗 SSE → 清候选+摘占位符
```

交互卡：模型调 `aiti_user_confirm/choose/input/...` → 桥推 AI 窗 → web UI 本地渲染卡（右下角）→ 作答 `BridgeClient.postResult` → 模型收到。

## 用法

### host 插件（两种，勿同时用）

```bash
# 1) npm 包（npm.example.com）
#    opencode.json: { "plugin": ["@aiti-ai/aiti-devtools-opencode"] }
# 2) 本地：cd ~/workspace/pi-work/opencode-ext/aiti-devtools-opencode && npm run deploy
```

桥默认 `http://127.0.0.1:8777/aiti`（`AITI_BRIDGE_URL` 覆盖）。

### web UI AI 窗（生产，已部署）

nginx `opencode.conf`（`opencode.pi.example.com` → 127.0.0.1:19870，用户 `opencode.service`）已加：

- `location /aiti/` → 桥 8777（同源资产/REST/SSE；Authelia 同护）
- `location /`：`proxy_hide_header Content-Security-Policy` + `sub_filter '</head>' …aiti-client-opencode.js…` + `proxy_set_header Accept-Encoding ""`（sub_filter 需上游未压缩）

桥 systemd `aiti-bridge.service` 已加 `--assets-extra …/opencode-ext/aiti-devtools-opencode/client`（serve 该脚本）。client 桥地址自动从脚本 src 推导（同源 `/aiti/`，零配置；`data-bridge`/`window.__AITI_BRIDGE__` 可覆盖）。

本地开发：`node tools/oc-localhost-proxy.mjs`（https://opencode.localhost:8442 + http://127.0.0.1:8443 →
19870，剥 CSP + 注入 client + `/aiti/` 同源挂桥——nginx 同款语义；127.0.0.1 源免 Authelia）。

> ⚠ 生产入口 `opencode.pi.example.com:8443` 有 Authelia（仅 127.0.0.1 源豁免）：浏览器从本机访问时源 IP 是
> 内网地址（非 127.0.0.1），会被 302 到登录页——demo 页 launcher 拉不到。本地 E2E 用 8443 proxy 或先登录 Authelia。

## E2E 验证（2026-08-24，opencode 1.1.51 / glm-4.7 / 真实 Chrome）

> **2026-11-07 复检（0.3.1 / opencode 1.19.5）**：插件重建携 core 0.3.10（补 mcp-config writeAtomic/HOME 惰性修复）
> 重部署 + serve 重启；web UI 经 8443 代理注入复验（aiti-client script 注入 + 桥 AI 连接上线）✅。构建坑：
> npm 11 arborist 对 peerDeps 崩，用 `npm install --legacy-peer-deps`；devDep `@opencode-ai/plugin` 与 CLI 对齐 1.19.5。

- **工具**：`aiti_bridge_status` / `aiti_page_exec`（真实改 Chrome 页面标题）✅
- **推送**：cockpit/桥 push → 插件注入 → 模型主动调工具作答 → idle → answer 回桥 ✅
- **候选条**（web UI，经反代注入）：chip 渲染 / 详情弹窗（字段筛选/后台打开）/ ✕ / 清空 ✅
- **占位符**：chip → composer 插 `[元素1]`（contenteditable + execCommand）→ 发送 →
  插件 transform 替换（`placeholder consumed: [元素1]`）→ `aiti_consumed` → 候选条清空 + composer 摘占位符 ✅
- **transform 只碰最后一条 user 消息**（历史占位符原文不重复展开/孤儿化）；桥收到 aiti_consumed 同步清 picked
  （防冷启动拉取复活僵尸候选）；client tombstone 过滤已消费 tag ✅
- **交互卡**（web UI 本地渲染）：push → 模型调 `aiti_user_confirm` → 卡渲染 → 点 ✅ →
  `{status:answered,approved:true}` 回模型 ✅
- **生产链**：`https://opencode.pi.example.com:8443/`（Basic 过）→ 脚本注入 + CSP 剥 + `/aiti/` 同源 200 ✅

## 关键坑

- **绝不能 bundle zod**：opencode 内部 zod v4，双实例让其 `to-json-schema` 崩溃；用 `tool.schema`（宿主实例）。
- **web UI 有 CSP**（`script-src 'self'`）：外部脚本注入必须走反代剥 CSP——这是「不 fork」方案的前提；
  同时 `/aiti/` 必须同源挂载（connect-src 也受限）。
- **composer 是 contenteditable**（非 textarea）：`execCommand('insertText')` + selectAll 替换（React 编辑器兼容）。
- **Chrome 后台 tab 节流**：AI 窗 tab 后台 >几分钟 SSE 心跳可能被冻结（卡不渲染）——tab 前台正常；生产可接受（人就在看）。
- **`opencode run` 的 `⚙ aiti_xxx Unknown`** 是 CLI 显示格式非错误；glm-4.7 有时把答案写进 reasoning。
- **coding-plan 模型会下架**（glm-4.5-air→`small_model` 挂）：列表看 `~/.cache/opencode/models.json`。
- **`~/.config/opencode/config.json` 严格校验**：local MCP 需 `{"type":"local","command":[...]}`。
- **桥 `tools/list` stateless**：直接 POST `/aiti/mcp {"method":"tools/list"}` 免 initialize。

## 复用关系

`packages/aiti-devtools-agent`（接线层）、`packages/aiti-devtools-core`（`rewriteMessage` 桥端点 picked/ai-event）、
独立桥 `packages/aiti-bridge`（`--assets-extra` serve client）、launcher 产物。对齐 pi-web 方案 M / DSH Cordis 插件。

## 桥新增端点（core bridge.ts，协议唯一来源）

- `POST /bridge/picked {to?, candidates:[{tag,describe,pageId}]}` / `GET /bridge/picked?agentKey=` —— 候选上报/读取
- `POST /bridge/ai/event {event, payload}` —— HTTP 宿主触发 `pushAiEvent`（进程内宿主直调方法）
