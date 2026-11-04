# aiti-event-bus · 页面事件总线

> ❝ 一条总线，全部帧。 ❞

页面事件总线归口扩展（依赖注入方案 **P0.5**，`docs/pi-web-ext-dependency-injection-plan.md` §4-E，2026-09-06 拍板）：总线实现归本扩展持有，core `lib/agent-page-events.ts` 不删不改、退为兜底宿主 + core 自用通道（SessionSidebar running）。

## 机制：访问器属性接管

页面事件的**全部发布**（core `running`、plan-first `pf:remind`、model-check `mc:avail`、editor `ed-watch`…）都走 `globalThis.__piPageEvents.publish` 全局口。本扩展 startup 时把 `__piPageEvents` 属性**接管为访问器**（`installPageEventSlot`，bus-core.ts）：

- **读**恒得稳定槽对象（`publish` = wrapper 双喂：当前前任 + 本总线）——core 零改动拿到全部帧
- **写**（模块再求值 / 他人重装的重赋值）被 setter 吸收为「前任更新」——turbopack dev 下 instrumentation 与路由各自惰性求值 `agent-page-events` 并无条件重赋全局，换函数式接管会被冲掉（dev 实测复现），访问器方案免役且与求值顺序无关
- **restore 守卫**：仅当访问器仍是自己装的才卸下还原前任槽（防热重载堆叠）；reload 时主动断开全部 SSE 连接，客户端 EventSource 自动重连到新总线实例

- `bus-core.ts`：纯内核（`createEventBus` 广播器 + `installPageEventSlot` 访问器接管），`node --test` 直测（15 例：bus-core 10 例，`client-url` 5 例，含 clobber 免疫与 `//dev` 主机误拼关键回归）

## 面

| 面 | 契约 |
|---|---|
| SSE | `GET /api/extensions/aiti-event-bus/events` —— 帧契约 `{type,...}` 与 core route 一致；建连即推 named `hello`（`{conn}`，客户端据此声明订阅）；named `heartbeat` 30s 不进帧分发 |
| 订阅声明 | `POST /api/extensions/aiti-event-bus/subscribe` `{conn, types:[...]|null}` —— 声明该连接的 type 白名单（整体覆盖；空数组=合法空白名单；null=恢复全帧）。转发按白名单过滤（`frameMatches`）：**不匹配的帧不出 SSE**——高频流扩展（aiti-cmd 终端 `cmd-<id>`）靠它避免无关帧到达订阅方；未声明的连接全帧（v0.1 兼容）。精确项全等匹配，尾部 `*` 项作前缀通配（如 `sched:*`，供 type 动态拼接的生产方）。EventSource 断线重连后新连接订阅集为空 → 客户端在 hello 后重发全集 |
| 连接保活 | `POST /heartbeat {conn}` —— client broker 每 45s 一次；服务端扫描（60s）：发过心跳且 3min 未刷新的连接判半开（页面已死 TCP 未断）→ cleanup。v0.1 旧客户端不发心跳、永不超时（兼容） |
| 服务端服务出口 | `ctx.services.provide("aiti-event-bus.publish", { publish(type, data) })` —— 经全局槽双喂（core route 也收到；低频状态帧用）。`ctx.services.provide("aiti-event-bus.publish-local", { publish })` —— **直连总线不喂 core**（v0.2）：高频大帧（终端流）专用，避免污染 core route 订阅方（session-manager/SessionSidebar）；local 帧不会出现在 `/api/agent/running/events` 上 |
| 客户端服务出口 | `ctx.registerExtService("aiti-event-bus.subscribe", subscribePageFrames)`（全帧，v0.1 兼容）+ `ctx.registerExtService("aiti-event-bus.subscribe-topics", subscribeTopics)`（主题订阅，v0.2） |
| client broker | 页面级单例 SSE + 引用计数（末位退订才关闭）；分发/退订契约与 core `window.__piPageEventsClient` 一致 |

## 消费方接入（2026-09-09 拍板：topics 唯一，禁止任何兜底）

```js
// 唯一订阅方式：type 白名单（SSE 转发层过滤 + 本地分发过滤）
const topics = ctx.getExtService?.("aiti-event-bus.subscribe-topics");
if (!topics) return;               // 总线未启用 → 不订阅、功能降级，不兜底
const h = topics(handler, ["cmd-s_ab12", "sched:*"], (status) => { /* up/down/reconnecting */ });
// h.ready：白名单在服务端生效（此后再拉初始快照即可无缝衔接）
// ...h.off() 退订
```

> **禁止兜底（必须）**：不得再写全帧订阅（`subscribePageFrames`）/ core
> `__piPageEventsClient` / 自建 EventSource 作为兜底路径——兜底 = 保留复杂度 =
> 保留错误之源，历史兜底已全部删除。`subscribePageFrames` 服务出口仅为兼容面
> 保留，新代码一律 topics。

### 高频流约定（aiti-cmd 范式）

- **发布方自管理是否发送**：每个实例一个专属 type（如终端 `cmd-<sessionId>`、agent 命令 `cmd-<toolCallId>`），列表快照用固定 type（`cmd-sessions` / `cmd-pilist`）；发布帧统一 `{ type, evt, seq?, ...}`。
- **发布走 publish-local**：终端大流量帧直连总线、不双喂 core route——新接入的高频生产方一律用 `aiti-event-bus.publish-local`；低频状态帧（pf:remind/mc:avail/ed-watch/gr:task/sched:*）继续走 `aiti-event-bus.publish`（双喂，core route 消费方可见）。
- **订阅保活（停推协议）**：高频生产方自带保活——前端订阅存在期间每 15s 向**自己的后端**（非 event-bus）POST 活跃 type 表（aiti-cmd：`/alive`）；后端对「曾报活但超时未刷新」的 type **停推**（aiti-cmd：45s），未报活的 type 乐观推（新订阅首心跳前不丢帧）。页面关闭/面板关闭 → 心跳停止 → 源头即断，不依赖 SSE 层丢帧；重开面板 → 心跳恢复 → 自动续推（中断输出靠 REST 快照 + seq 补齐）。**event-bus 不做推送拦截**（无订阅者时拦帧太复杂且易误拦）——活性与停推由各生产方自理；连接级半开回收（/heartbeat 3min 超时清理）归 event-bus；低频帧（分钟级）无需保活。
- **大消息不走总线**：初始回放/全量快照（可达 MB 级）由订阅方先订阅、再 REST 拉快照；发布方每帧带单调 `seq`，客户端以快照 seq 为基线去重后续实时帧——无缝无重复，断线重连后重拉快照补丢失段。
- 实时增量帧（小帧）才进总线。

### 消费方拓扑（2026-09-09 整改后）

| 消费方 | 通道 | 白名单 |
|---|---|---|
| aiti-cmd（TerminalView/PiCommandView/总览列表） | 本总线 topics | `cmd-<id>` / `cmd-sessions` / `cmd-pilist` |
| aiti-ai-schedule | 本总线 topics | `sched:*`（通配） |
| aiti-editor（两处 watch） | 本总线 topics | `ed-watch` |
| aiti-git-review | 本总线 topics | `gr:task` |
| aiti-plan-first | 本总线 topics | `pf:remind` |
| aiti-model-wizard | 本总线 topics | `mc:avail` |
| session-manager / SessionSidebar | core route（`__piPageEventsClient`） | —（cmd 帧已退出 core route，无污染） |

各消费方均保留三级降级链：topics 服务缺席 → 全帧订阅（v0.1）→ core 旧 route / 自建 SSE。

生产方接入（新代码优先走服务出口，全局口兜底）：

```ts
ctx.services?.get("aiti-event-bus.publish")?.publish("my:evt", { ... });
// 过渡期等价：(globalThis as any).__piPageEvents?.publish("my:evt", { ... })
```

稳态拓扑：2 条 SSE——core route（SessionSidebar 自用 running）+ 本扩展 `/events`（其余页面消费，含 aiti-cmd 终端流的主题订阅）；消费方全部迁 ctx 后 core route 仅剩 SessionSidebar 自用。
