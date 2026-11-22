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

## CLI

```bash
aiti-dialog confirm --text "继续？" [--ok-label 继续] [--cancel-label 取消]
aiti-dialog input --text "名称：" [--default foo] [--password]
aiti-dialog choose --text "选择" --options "A,B,C"
aiti-dialog file [--multiple] [--filter "*.png"]
aiti-dialog directory
aiti-dialog notify --text "完成" [--timeout 5]
aiti-dialog custom --page http://127.0.0.1:PORT/page.html
aiti-dialog --daemon [--port 18095] [--ttl 600]
```

公共参数：`--json`（输出完整 Host envelope）、`--timeout <秒>`、`--title`、`--detail`、
`--widget-bin`、`--no-window`（只打印页面 URL）、`--width`、`--height`。

退出码（zenity 兼容）：`0` 已作答、`1` 取消、`5` 超时、`2` 参数错误、`4` 运行错误
（无窗口/无 widget 二进制）。

daemon 输出 `{"ok":true,"port":N,"baseUrl":"…","token":"…"}`，接口：

```text
POST /interactions            { kind, title, message, ... } -> { id }
GET  /interactions/:id/wait   阻塞到 resolved
GET  /interactions/pending
GET  /interactions/events     SSE
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

内置页面在 `/`，支持 confirm / choose / input 和队列。

### 自定义页面

Host 可以自带 UI。页面打开时会自动附加 broker 坐标（`withInteractionParams`，
`aiti-dialog custom --page <url>` 也走同一处理）：

```text
http://127.0.0.1:<页面端口>/custom.html?base=http://127.0.0.1:<broker端口>/&token=<token>
```

页面从 broker 源动态导入公开 client（静态资产带 `access-control-allow-origin: *`），
用同一个 id 作答：

```js
const params = new URLSearchParams(location.search);
const base = (params.get("base") || location.origin).replace(/\/+$/, "");
const { connectInteraction } = await import(`${base}/interaction-client.js`);
const client = await connectInteraction({ baseUrl: base });

client.onRequest((request) => render(request));       // request.kind === "custom"
client.onUpdate((id, state) => update(id, state));    // Host 持有的 UI 状态
client.onResolved((id, result) => close(id, result));
await client.answer(request.id, { action: "approve", approved: true, value: { ... } });
```

完整零依赖示例见 [`page/custom-example.html`](page/custom-example.html)。pending 仍在
broker 侧，页面刷新/重开只丢渲染，不丢请求。

`aiti-dialog custom --page <url>` 只接受 loopback URL：token 会随页面 URL 下发，远程源等于
泄露 token。直接调 Host API（`broker.open({ kind: "custom", custom: { pageUrl } })` +
`window.open(...)`）时也应遵守同样的规则，并用
`withInteractionParams(pageUrl, server.baseUrl, server.token)` 拼接参数。

## MCP stdio

```bash
npm run build
node bin/widget-interaction-mcp.mjs --no-widget
node bin/widget-interaction-mcp.mjs
```

工具：`widget_confirm`、`widget_choose`、`widget_input`、`widget_presence`、
`widget_notify`、`widget_cancel`。工具调用会阻塞到页面作答或超时；stdout 只输出
JSON-RPC，诊断走 stderr。

### 与 daemon 共用一个窗口

daemon 起一次，多个 MCP 客户端共用同一个 broker 和窗口，避免每次请求都付 WebView 启动成本：

```bash
# 终端 1：常驻 host + 窗口；输出 {ok, port, baseUrl, token}
aiti-dialog --daemon --port 18095

# 终端 2：代理到 daemon 的 MCP server
node bin/widget-interaction-mcp.mjs --http http://127.0.0.1:18095/ --token <token>
```

HTTP 模式下工具映射为 `POST /interactions` + `GET /interactions/:id/wait`（迟到的 wait
会重放已保存的 envelope），`widget_cancel` 映射为 `POST /interactions/:id/cancel`。
非 MCP 代码可用同一个传输层：

```ts
import { createHttpInteractionTransport } from "@aiti-ai/widget-interaction";
const transport = createHttpInteractionTransport({ baseUrl: "http://127.0.0.1:18095/", token });
const answer = await transport.ask({ kind: "confirm", title: "继续？" });
```

## 首版未包含

- 表单构建器/声明式自定义 UI（自带页面即可）；
- 桌面遮挡/实时马赛克；
- aiti-devtools launcher UI 基础件复用。
