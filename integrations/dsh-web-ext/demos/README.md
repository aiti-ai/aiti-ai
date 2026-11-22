# demos —— aiti-devtools-dsh 演示页

> 测试 aiti-devtools launcher 在 DSH（`dsh.pi.example.com:8443`）上的页面**跳转 / 返回**帧管理。
> 这些是给「人 + agent」试用的静态页，持久化在本目录（不再是 /tmp 临时文件）。

## 页面

| 文件 | 说明 |
|---|---|
| `page-a.html` | Demo A：注入 launcher，可「跳转到 Demo B」(location) /「返回」(history.back) |
| `page-b.html` | Demo B：同上，与 A 互跳 |
| `serve.mjs` | 本地静态服务器 |

两页都注入 launcher（`data-bridge-url`/`data-ai-url` 指向 DSH 域名）。launcher 基址可在页内
`window.__AITI_BASE__` 改（默认 `https://dsh.pi.example.com:8443`；改 `http://127.0.0.1:3080` 走本地）。

## 运行

```bash
node demos/serve.mjs            # 默认 127.0.0.1:8090（可传端口 / AITI_DEMOS_PORT 覆盖）
```

浏览器打开 `http://127.0.0.1:8090/page-a.html`。

> ⚠️ demo 页 launcher 从 DSH 域名拉取（`https://dsh.pi.example.com:8443/aiti/aiti-launcher.js`），
> 该域名在 Authelia 后 —— 需浏览器先登录 `dsh.pi.example.com`，且 `/aiti/*` 路由目前也在认证下。
> 若未登录会 302 → launcher 不加载（可改 `__AITI_BASE__` 走本地）。

## pi-web 场景测试页（page-piweb.html）

连 **pi-web dev 桥**（`https://pi.example.com:8443/dev/api/extensions/aiti-devtools/mcp`，AI 窗 = pi-web 页面）。
⚠️ 需浏览器已登录 pi.example.com（Authelia）。改 `__AITI_BASE__`（去掉 `/dev`）测生产。按钮同 page-local（throw/Promise/TypeError/资源 404）。

**测试步骤（注意顺序语义）**：
1. 打开页面 → launcher 加载（console 见 `[aiti] launcher 已启用`）。
2. **先点 💬 打开 AI 窗**（重要：打开 AI 窗会清空旧错误缓存——launcher 设计语义"点 AI 图标即清理，下次触发再发"；先触发错误再开窗 = 错误被清不掉候选）。
3. AI 窗开着 → 点 💥 按钮（每按钮只报一次，同消息去重）→ 候选条出现 [错误N]。
4. 发送 → preSend 替换完整错误详情 + 发自。

**本轮发现的 3 个问题（记录在 docs/dsh-porting-feedback.md，未修）**：
- launcher `__dbg_page_id` localStorage 缓存跨桥串号：同 origin（8090）先连 DSH 桥再连 pi-web 桥，AI 窗 pageId 沿用旧桥的（cj343/host）——建议 pageIdentity 按桥 base 分 key。
- 先触发错误后开 AI 窗：`resetErrDedup` 清空 pendingErrors，错误不进候选（设计语义，但对"页面崩溃后用户才开 AI 窗"的真实路径不友好——值得复议）。
- pi-web dev 页面 self 注入的 launcher 资产 URL 无 `/dev` 前缀（生产 URL）——dev/prod 资产混用疑点。

## 错误候选测试（page-local.html 专属按钮）

页面有两个 💥 按钮：**throw**（同步异常，window.onerror 捕获）与 **Promise**（unhandledrejection 捕获）。
链路：页面错误 → client hook → launcher `picksAddError`（去重/前 3 个）→ `dbg_ai_error` → AI 窗
host-protocol → `[错误N]` 红色候选 chip + composer 自动插占位符。发送时 host `agent/pre-step` 替换为
完整错误详情（类型/消息/堆栈/时间）+ 发自（候选无 pageId 时 client 上报兜底 `hp.hostIdentity().pageId`）。

## 测试点

- 页面加载 → launcher 注入 → 桥会话出现该页（`/aiti/bridge/sessions`）。
- 点「跳转到 Demo B」→ 新页重新注入 launcher → 桥会话切到新 URL/标题。
- 「返回」(history.back) → 回原页，launcher 重新注入。
- 观察 agent 用 `aiti_page_exec` / `aiti_bridge_status` 对这两个页面的帧管理。

## 端到端验证步骤（可复现，Chrome DevTools / 真实点击）

> 前置：`dsh.service` 运行中（127.0.0.1:3080）、`@aiti-ai/aiti-devtools-dsh@0.6.6` 已装、`node demos/serve.mjs 8090` 在跑。

1. 打开 `http://127.0.0.1:8090/page-local.html`（本地免认证页）。
2. 确认桥会话：`curl http://127.0.0.1:3080/aiti/bridge/sessions` 出现 `<id>/host` 与 `<id>/ai`。
3. 点页面「Inspector」→ 点「本地按钮」→ HUD 出现（拦截提示 + 元素卡 `button 106×44`）→ 点 ✓ 确认。
4. 切到 AI 窗（DSH SPA iframe）：**候选条出现两区 chip**：`[元素1]`（占位符区，`.aiti-picked-tag`）+ `本地按钮`（描述区）+ `✕` + `清空`。
5. **验证 composer 显示的是短占位符**（非大段描述）：textarea 值 = `[元素1]`（干净）。
6. **点描述区**（如「本地按钮」文本）→ **详情弹窗**打开：信息行（标签/xpath/尺寸/…）+ 「发送给 AI 的字段」勾选 + 关闭按钮。点遮罩关闭。
7. **点 ✕** → 该候选被清除（候选条消失 + 输入框占位符同步摘除）。重新点选元素恢复。
8. 补一句文本 → **点发送按钮（`.rusa_q_primary` / Send message）** → composer 清空 → **候选条自动清空**（发送即消费）。
9. 查会话历史（DSH `session.list`/`session.history` RPC，Host: dsh.pi.example.com:8443）：
   最新 `user/message` = **完整描述 + 完整发自标注** `[发自: <hostId>/host · <页面URL>（aiti-*：pageId 参数用它）]`，
   **无 `[元素N]` 占位符残留**（格式对齐 pi-web：pid + 裁剪 URL + 工具提示，幂等不叠加）。

> 说明：占位符替换发生在 host 端 **`agent/pre-step`**（agent-loop 官方 waterfall，plan-mode 同款）——
> 用户消息先到 inbox，pre-step 替换后才 append 进 session，所以**历史与模型看到的都是展开文本**，
> 发送方式（Enter/按钮/API）无关。候选条渲染在 `conversation.input.overlay` slot；发送后清理走
> `useSession` snapshot 数据流（新增 user 消息含「发自:」→ 清候选），非 DOM 发送 hook。
> 若历史残留 `[元素N]`，检查 client 0.6.6 已生效（`/aiti/picked` 有上报：
> `curl -X POST 127.0.0.1:3080/aiti/picked -d '[]'` 返回 ok）。
