# aiti-custom-agent — 扩展内说明（dev-pack 随部署目录直达，AI 现场直改先读）

## 是什么

自定义 Agent 注册中心：`agents.json`（UI 读写）→ startup 逐成员注册 SessionProvider → 新建会话 Backend 选择器出现。两种驱动：

- **generic**（本扩展自研句柄）：one-shot 任务型——`prompt` 写 stdin → stdout 流式（`message_update`）→ 进程退出收口（`message_end` + `agent_settled`）；abort 杀进程（SIGTERM→3s→SIGKILL）；历史本地 JSONL（`<configDir>/sessions/<id>.jsonl`），不进 All Sessions（provider 无 agentKey）。
- **协议型**（claude/codex/zcode/cursor/qoder/acp/codebuddy/pi）：本扩展不自跑 CLI，`ctx.services.get("<基础扩展id>.launch")` 拿委托服务 → `createSessionFromLaunch(launch, options)` 返回基础扩展真实 handle（完整模型/权限/历史；agentKey/能力模板来自服务）。服务缺席 → 该成员不注册（fail-loud，UI 可见）。

## 文件地图

| 文件 | 职责 |
|---|---|
| `index.ts` | 注册中心：startup 注册/热重建（registerAll）、CRUD/probe/reload/selftest API、driver→服务映射（PROTOCOL_DRIVERS）、provider 组装（generic + 协议委托双轨） |
| `generic-handle.ts` | GenericAgentHandle：generic 驱动句柄（spawn 注入可测；launch 解析走共享层 `resolveCliLaunch`） |
| `agent-spawn-env.ts` | 共享层副本（权威源 `pi-web-ext/_shared/`，改动必须双向同步——`_shared/shared-copy-sync.test.mjs` 校验） |
| `core.cjs` | agents.json 持久层（原子写 tmp+rename / slugify 含中文稳定哈希 / normalizeInput 保存侧第一道关） |
| `client/src/custom-agent-client.mjs` | 管理面板（零构建 h()）：列表+表单+委托目标下拉+**前缀命令包装**（docker/ssh/env/runsocks 结构字段→生成 command/argsPrefix，纯函数可单测）；deploy 拷进 `dist/` |
| `client/src/custom-agent-prefix.test.mjs` | 前缀命令纯函数单测（生成/常用方式下拉/探活继承/反向解析还原/开关保留真实 CLI）12 例 |
| `tools/deploy.mjs` | 部署（双写 web/web-dev + copyIcons + notifyReconcile + 双实例 reload + dev-pack） |

## 关键契约

- provider 注册：`ctx.sessionProviders.register({type: 成员id, label, agentKey?, priority, order, maxCapabilities, createSession})`；键 = `<extId>/<type>`；热移除 `remove(完整键)`。
- generic 能力面诚实声明：仅 `getMessages: true`，其余全 false（fail-loud）。
- 协议别名 `priority: 5`——低于基础扩展自家 provider（认领/恢复直连优先）。
- **面板滚动契约（aiti-float）**：根节点必须是 **不可滚动** 的 flex 列容器（`overflow:hidden` + `max-height` 封顶 + `data-ext-float-autoh="1"`，不写 `data-ext-float-h`），滚动只发生在内容区（`flex:1; minHeight:0; overflowY:auto`）。原因：aiti-float 接管时会给根节点写 `overflow:hidden !important`（非 autoh 还写 `max-height:none` + 固定 height），根节点自己滚 ⇒ 内容一超出就被裁掉且拿不到滚动条。
- launch 服务契约（消费侧）：`{ agentKey, capabilities, members?, listModels?, createSessionFromLaunch(launch{command?,argsPrefix?,env?,bridge?,target?}, options) }`；`target` 仅多成员家族（acp/qoder）选成员。
- env 合并序（`resolveCliLaunch`）：基底 env/全量透传 → 自动 `AITI_BRIDGE_URL` → 成员 env（最高优先）→ bridge 重写；`$VAR`/`${cwd}` spawn 时展开。
- **前缀命令（client 侧约定）**：存储仍是 `command` + `argsPrefix` 两项——勾选包装后 `command`=包装工具本身（`docker`/`ssh`/`env`/`runsocks`），真实 CLI（含参数）必须出现在 argsPrefix 末尾（因为 command 覆盖后协议驱动不再自带自家 CLI 名）；结构字段由纯函数 `buildPrefixArgs/applyPrefix/switchPrefixKind/detectPrefix` 生成与还原（`client/src/custom-agent-client.mjs` 模块级导出，可直接 import 单测）。

## 测试 / 部署

```bash
node --experimental-strip-types --test pi-web-ext/aiti-custom-agent/*.test.mjs   # 本扩展 25+ 用例
node scripts/test-web-ext.mjs --only aiti-custom-agent --only agent-launch       # 含共享层
node pi-web-ext/aiti-custom-agent/tools/deploy.mjs                               # 双实例 reload 200
```

调试端点：`POST /api/extensions/aiti-custom-agent/selftest`（generic 句柄事件流自检）、`POST .../reload`（全量重建注册表）。
