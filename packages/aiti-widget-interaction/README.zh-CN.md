# @aiti-ai/widget-interaction

Host 持有的、可刷新恢复的 aiti 用户交互通道。

页面只负责显示；pending 请求、超时、取消、幂等和回调 Promise 都在 Host。页面通过 SSE
接收请求，通过 HTTP 提交答案；刷新/重开页面不会丢失 callback。

## 构建与测试

```bash
cd packages/aiti-widget-interaction
npm run build
node --test test/*.test.mjs
```

## Host API

```ts
import { InteractionBroker, startInteractionServer, InteractionWidgetWindow } from "@aiti-ai/widget-interaction";

const broker = new InteractionBroker();
const server = await startInteractionServer({ broker, port: 0 });
const window = new InteractionWidgetWindow({ width: 560, height: 260 });
await window.open(server.url);

const answer = await broker.ask({
  kind: "confirm",
  title: "继续？",
  message: "请求状态在 Host 侧，页面刷新不会丢。",
  actions: [
    { id: "continue", label: "继续", kind: "primary" },
    { id: "cancel", label: "取消", kind: "secondary" },
  ],
});
```

自定义 / 有状态 UI：

```ts
const opened = broker.open({ kind: "custom", keepOpen: true });
await broker.update(opened.id, { state: "paused", label: "已暂停" });
await broker.resolve(opened.id, { status: "answered", action: "stop" });
```

## 页面协议

```text
GET  /interactions/pending
GET  /interactions/events
POST /interactions/:id/answer
POST /interactions/:id/cancel
```

内置页面在 `/`，支持 confirm / choose / input 和队列。自定义页面使用
`/interaction-client.js` 的 `connectInteraction()`。

## MCP stdio

```bash
npm run build
node bin/widget-interaction-mcp.mjs --no-widget
node bin/widget-interaction-mcp.mjs
```

工具：`widget_confirm`、`widget_choose`、`widget_input`、`widget_presence`、
`widget_notify`、`widget_cancel`。工具调用会阻塞到页面作答或超时；stdout 只输出
JSON-RPC，诊断走 stderr。

## 首版未包含

- 原生文件/文件夹选择；
- 自定义页面注册校验（当前仅接受显式 loopback URL）；
- MCP 包装；
- 桌面遮挡/实时马赛克；
- aiti-devtools launcher UI 基础件复用。
