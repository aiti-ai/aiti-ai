# aiti-qoder-agent 扩展（部署目录直改指南）

## 驱动协议：ACP（2026-11-13 重写，源码仓）
- **背景**：qoderclicn 1.1.81+ 移除 SDK worker 会话（CLI 原话 "SDK worker sessions are no longer supported... roll back the CLI to 1.1.80 or earlier"），stream-json 模式的入站 control_request 通道（interrupt/set_model/set_permission_mode）全部断链——生产事故：CN 1.1.83 忙时无视 interrupt，前端「停止中」永挂。
- **现状**：spawn `qodercli/qoderclicn --acp`（JSON-RPC over stdio，传输层 `qoder-acp.ts`）。控制面：`session/prompt`（回合）、`session/cancel`（停止，秒回 `stopReason:cancelled`）、`session/set_model`（运行时切模型）、`session/set_mode`（权限档；`yolo`↔bypassPermissions 映射；**plan 档 ACP 面无**→返 false）。事件面：`session/update`（agent_message/thought_chunk 双气泡、tool_call/tool_call_update 卡（真名在 `_meta.qoder.toolName`）、plan→taskList、available_commands_update→斜杠面板、usage_update→contextUsage）、`session/request_permission`→interaction 账本（应答 accept→allow 选项 / decline→deny 选项）。
- **接管既有会话**：`session/load`（不再 `--resume`/seedHistory——CLI 回放更权威，双喂会重复）；stream-json 时代的老会话也能 load（CLI 会话存储共享，2026-11-13 探针验证）。
- **steer 恒关**：stream-json 的注入面随 SDK worker 移除失效，ACP 注入面未探针——运行中输入一律本地 followUp 队列。要开需按 steer-gate 纪律对 --acp 实跑取证。
- **credits**：session/prompt 响应无 credits 字段（只有 usage tokens）→ 面板额度继续走 REST（WASM client），不变。
- 探针工具（tools/steer-probe.mjs 等）保留；版本敏感行为重验时先跑探针再点亮能力。

## 结构
- 运行时文件平铺在本目录根（index.ts / core.cjs …，宿主 loader 按相对路径加载——**禁手改运行时平铺文件**，改 src/ 再 build）
- `src/` 源码（client/src + 服务端 ts/cjs）· `dist/` 构建产物（禁手改）· `tools/` 构建/部署脚本
- npm 包形态的扩展：本目录 package.json 含 version 与 aitiConfigs 声明

## 小改现场流程（改文案/样式/小逻辑）
1. 改 `src/` 下对应源码
2. `node tools/build.mjs`（client 有构建产物的扩展；纯服务端改动跳过）
3. `curl -X POST http://127.0.0.1:3001/api/extensions/reload`（dev；prod 3002；外部经 nginx 带 basePath：/dev、/mac、/mdev、/win、/wdev → `/xxx/api/extensions/reload`）
4. 浏览器刷新页面验证

## 大改回源码仓
- 源码仓：`extensions/aiti-qoder-agent/`（git 管理，deploy 同步回本目录）
- 改完在源码仓跑 `node tools/deploy.mjs`（或仓库根 `node scripts/deploy-all.mjs --only aiti-qoder-agent`）

## 数据目录（数据分层：config / cache）
- `ctx.configDir` 根级 = 配置与关键小状态（aiti-configs 备份范围；小、珍贵、人可读）
- `ctx.cacheDir`（= `<configDir>/cache/`）= 可删缓存：db/venv/日志/大文件；rm -rf 后扩展下次访问自动重建
- `ctx.dataDir` 已移除（访问即抛）——新代码禁用
- 本扩展白名单（永不为 cache 的配置文件）见 package.json `aitiConfigs.configFiles`

## 变体键（intl / cn）——一处定义，勿在别处拼字符串
- 唯一来源 `variants.ts`（`QODER_VARIANTS` / `qoderVariant(variant)`），三个键各有主人：
  - `type` = provider 注册键（`aiti-qoder-agent/<type>`）：recycleApi providerType、前端后端记忆引用
  - `agentKey` = **All Sessions join key** = 复合 id / `handle.id` 前缀：**必须等于 session-manager 适配器 id**（`session-manager/lib/agents/registry.ts`；CN 是 `qodercn`，不是 `qoder-cn`）
  - `stateKey` = 模型状态文件命名空间（`~/.pi/agent/ext-agents/<stateKey>/`，CN 沿用 `qoder-cn` 存量）
- 宿主 `findProvidersForAgent` 是**精确匹配**：agentKey 与行 id 前缀不一致 → `qodercn:<sid>` 的 URL 直开、`?session=` 恢复、All Sessions 接管全部 404（2026-09-20 事故即此）。回归测试 `variants.test.mjs` 直接拿适配器表校验，改表/加变体先跑它。
- 接管既有会话的 **cwd 必须来自原会话**（`session-manager.sessions.parseSession(id).meta.cwd`）：qodercli 的 `--resume` 只在 cwd 对应项目目录里找历史，回退进程 cwd 即「会话不存在」。宿主 by-id 路径（URL 恢复）不提供 cwd，故在 `QoderHandle.start` 内解析。
- `deploy.mjs` 文件集含 `variants.ts`（缺文件直接 throw）——新增模块级源文件记得同步补清单。

## abort（停止）两段式与 CN 版 interrupt 实况（2026-11-13）
- **CN 版 qoderclicn 忙时对 `control_request/interrupt` 完全无视**（探针实测：运行 sleep 25 任务中 T+6s 发 interrupt，T+20s 仍无 control_response 也无 result 帧；intl 版 qodercli 2026-09-06 实测亚秒回执）。
- 因此 `abort()` 是两段式：interrupt 等待确认（`INTERRUPT_ACK_TIMEOUT_MS`，默认 5s）→ 未确认即硬杀（SIGTERM → `HARD_KILL_GRACE_MS` 后 SIGKILL，codex 后端同款）。exit → markDead → `session_backend_dead` 让前端「停止中」复位；下次 prompt 宿主 `--resume` 重建（链路已验证）。
- 历史 bug（已修）：未确认时只 `console.warn` 不兜底 → 前端「停止中」永挂（CLI 照跑、无终态帧）；另 control_response 曾不按 request_id 分发，任意回执（如 set_permission_mode）会误放 interrupt waiter——均已回归钉死（`qoder-hardening.test.mjs`）。

## steer（运行中注入）能力门控
- `steer` **不看代码看证据**：只有 `<stateDir>/steer-probe.json`（= `<PI_WEB_DATA_DIR|~/.pi/web/data>/aiti-qoder-agent/state/`）里**本 CLI 二进制的 realpath 键**记着 `verdict:"pass"`，`QODER_CAPABILITIES.steer` 才为 true、`backend-queue` 才挂 `steer` 钩子；否则运行中输入一律本地排队（诚实降级，非 bug）。
- 开门：`node tools/steer-probe.mjs --record`（pass 才写开门证据）→ reload 扩展 → **新开会话**（存量会话能力表创建时已固化）。
- 注入档位 = `priority:"next"`（AgentLoop 轮内吸收）。**别改成 `now`**：`now` 会抢占本轮（≈ stop + 重发），语义不是 steer，探针的 C2a 判据会直接拒判 pass。
- 当前账实（2026-09-22）：`qodercn`（`~/.qoder-cn/bin/qoderclicn/qoderclicn-1.1.44`）已 pass → steer=true；国际版 `qoder` 二进制无记录 → 仍 steer=false。排障先分清变体，别拿一个的结论说另一个。
- **禁手改账本伪造 pass**：键是二进制路径、值是行为级判据（注入后模型当轮改口），假证据=假按钮复发；`index.ts` 的 `QODER_CAPABILITIES` 基表也保持 `steer:false`。
- 协议取证、探针判据、为何不重发 → `docs/aiti-qoder-steer-injection-plan.md`。

## 红线
- 禁轮询（setInterval 拉取）；需要等待用事件/回调/SSE（桥的 SSE、aiti-event-bus topics）
- 禁重启生产服务（pi-web 3002 等 restart 须用户明确同意）
- 禁手改 dist/ 与运行时平铺文件；跨扩展通信走 ctx.services（禁 globalThis.__ext 直穿）
- 服务端：SQLite 一律 WAL + 分批小事务（批间 setImmediate 让步）；禁 execFileSync 调 >1s 外部程序；>8MB 文件禁同步读

## 账号档 / 额度对接
- 本扩展已 provide `<extId>.agent` 描述符（账号档槽位）与 `accountQuota` 额度出口 `GET /login/quota`。
  接入契约 / 现状待办 / 平台坑（.mjs reload 缓存）→ `docs/pi-web-ext-agent-account-contract.md`。
