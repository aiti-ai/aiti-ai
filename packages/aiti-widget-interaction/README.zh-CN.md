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

页面里的 module script **不要用顶层 await**：macOS 11 的 WKWebView 会静默跳过整段脚本
（窗口正常但页面永不连接）。把启动逻辑包进 `async function start()`；`test/pages.test.mjs`
已对随包页面做守卫。

`AITI_WIDGET_DEBUG=1` 会把壳的 stderr 透传出来；默认适配层保留最后 4 kB，可用
`window.stderr` 读取（“窗口空白 / 页面没回调”通常是会话锁屏或页面加载失败，先看这里）。

`test/gui.test.mjs` 会开真窗口（遮挡窗几何、钉住定位、daemon 重开）；没有 DISPLAY 时自起
私有 `Xvfb :97` + openbox，缺显示器/xdotool/widget 二进制时自动 skip。

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
`--widget-bin`、`--no-window`（只打印页面 URL）、`--width`、`--height`、`--x`/`--y`
（绝对屏幕坐标）、`--display <序号|名称|primary>`（此时 x/y 变成该屏内的相对偏移）、`--center`。
显式给了任一几何参数即“钉住”窗口：内置页面不再自动贴合内容（`?autosize=0`），卡片保持
指定位/尺寸——放在录制区域外时这一点很关键。

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

## 定位辅助

壳只接受绝对屏幕坐标；包里带一组纯几何函数，Host 可以把卡片放在录制区域之外，并处理多屏：

```ts
import { monitorRect, placeOnMonitor, placeOutside } from "@aiti-ai/widget-interaction";

const second = { x: 1920, y: 0, width: 2560, height: 1440 };
const capture = monitorRect(second, { x: 200, y: 120, width: 1600, height: 1000 });
const spot = placeOutside(capture, { width: 560, height: 260 }, { gap: 16, monitors: [second] });

const win = new InteractionWidgetWindow({ width: 560, height: 260, x: spot.x, y: spot.y });
await win.open(server.url);
win.move(spot.x, spot.y + 40);   // 跟随目标窗口
```

`placeOutside` 依次尝试下 → 上 → 右 → 左，跳过与目标矩形重叠或越出显示器的位置，最后兜底
夹取到可放置点；`placeOnMonitor` 把屏内偏移换算成绝对坐标（与 `--display` 同一套数学），
`clampRect` 把矩形夹进显示器。放在录制区域外的卡片不会被录进去。

## 桌面遮挡（cover）

`DesktopCover` 用一块独立窗口遮住桌面录制里的敏感区域：点击穿透、不可聚焦、始终置顶，
窗口像素就是遮挡内容。v1 只做纯色/纹理/半透明遮挡；实时马赛克需要屏幕采集，不在范围内。

```ts
import { DesktopCover, monitorRect } from "@aiti-ai/widget-interaction";

const cover = new DesktopCover({
  rect: monitorRect(display, { x: 200, y: 120, width: 900, height: 600 }),
  color: "#101216",
  opacity: 0.9,
  pattern: "grid",          // solid | grid | stripes
});
await cover.open();          // 拉起 aiti-desktop-widget --html page/cover.html?...
cover.move({ x: 320, y: 200 });                 // 跟随目标窗口
await cover.update({ color: "#000000", opacity: 1 });
await cover.close();
```

遮挡窗是独立进程：被录制的页面刷新/重绘/导航都删不掉它；它本来就在录制区域内——被录进去
才是遮挡生效的方式。

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

工具：`widget_confirm`、`widget_choose`、`widget_input`、`widget_pick_path`、
`widget_presence`、`widget_notify`、`widget_custom`、`widget_await`、`widget_cancel`。
工具调用会阻塞到页面作答或超时；stdout 只输出 JSON-RPC，诊断走 stderr。

任意问答工具都可传 `async: true`：立即返回 `{id, status:"pending"}`，再用
`widget_await({ id })` 取结果（可带客户端 `timeout`，到点返回 `{status:"timeout",
pending:true}`，Host 侧请求仍保持 pending）。`widget_custom` 会把窗口导航到 loopback 的
`page`（`data` 以 `request.data` 下发），只能在进程内模式下用——daemon 无法按请求切换共享窗口。
`--notify` 会在请求结束时向客户端发 `notifications/aiti/interaction`（`{id, result}`）；
配合 `--http` 时改为订阅 daemon 的 `/interactions/events` 流（不再依赖本地 broker）。

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
- 实时桌面马赛克（v1 只有遮挡窗）；
- aiti-devtools launcher UI 基础件复用。
