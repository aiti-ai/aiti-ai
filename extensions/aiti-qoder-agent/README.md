# aiti-qoder-agent

## 来源 · Origin

本包是 **aiti** 生态的组成部分——以 [pi](https://pi.dev) 为引擎的个人 AI 开发工作台与本地调试注入生态：**aiti-agent**（自托管 Web 工作台，基于开源项目 [pi-web](https://github.com/aiti-ai/pi-web) 构建，浏览器为主操作面）+ 各开发工具内的调试注入（aiti-devtools）+ 丰富的扩展体系。

This package is part of the **aiti** ecosystem — a personal AI development workbench powered by [pi](https://pi.dev): **aiti-agent** (a self-hosted web workbench built on the open-source [pi-web](https://github.com/aiti-ai/pi-web)) plus debug injection into mainstream dev tools (aiti-devtools) and a rich extension system.

**English**: Exclusive Qoder CLI session backend (qodercli/qoderclicn): credits/quota (getUsage), WASM-signed model catalog (listModels), task-list mirror and run-queue management.

- 工作台 / workbench: <https://github.com/aiti-ai/pi-web>
- 生态仓库 / monorepo: <https://github.com/aiti-ai/aiti-ai>
- 官网 / site: <https://aiti.pw>


Qoder CLI 专属会话后端（多 agent 前端 / All Sessions 接入）。qodercli/qoderclicn 是
claude-code 协议族成员，驱动层与 aiti-claude-code-agent 同构；本扩展**独占** qoder 两个
成员（CC 族清单已摘除），在其之上增加：

| 能力 | 说明 |
|---|---|
| `getUsage` | 账号 credits/配额——`{openapi}/api/v2/quota/usage`（Bearer dt-token） |
| `listModels` | 模型目录——infer 网关 `/api/v2/model/list?Encode=1`（WASM 签名请求） |
| `taskList` | TodoWrite 工作计划只读镜像（共享层 `@aiti-ai/ext-shared/task-list` 从工具事件派生；内存空则回退磁盘快照；冷会话由 `aiti-qoder-agent.sessionDormantState` 服务读快照） |
| `queueManage` | 运行中排队（`@aiti-ai/ext-shared/backend-queue` 文件 sidecar + settle 后自动续轮） |
| `respondInteraction` | `control_request/can_use_tool` 交互链（共享层 `@aiti-ai/ext-shared/agent-interaction` 账本）：按工具名派生 kind → 授权卡 / AskUser 卡 / 方案审批卡，应答回 `control_response`；未决项落 sidecar 并经 `subscribe` 时定向补发（重建/刷新不丢卡），回合结束 `turn_end`、进程死亡 `dead` 统一过期 |
| plan 模式 | `setPermissionMode("plan")` 走 `control_request/set_permission_mode`；进/出 plan 由 CLI `system/plan_mode_changed` 帧回报，`getPermissionMode()` 据此返回 `"plan"`。**bypass 默认档不冲突**——bypass 只放行工具授权，plan/AskUser/ExitPlanMode 仍会问（真正互斥的是 `dontAsk`） |
| `getAllTools` / `getCommands` / `getPermissionMode` | 能力面快照——CC 族 `system/init` 帧免费携带 `tools` / `slash_commands` / `permissionMode`，无需额外请求。⚠ `getCommands` 有宿主出口（`get_commands`），`getAllTools` **暂无**：宿主 `get_tools` 只走 `h.send` 裸通道（仅 attach 系有），外部后端一律返回 `[]`（claude-code/zcode 同状态），见下节 |
| 扩展 API | `GET /api/extensions/aiti-qoder-agent/{usage,models}`（无需开会话） |

## 与 zcode / claude-code 家族的容差对齐

驱动层逐条对照 `aiti-zcode-agent` 与 `aiti-claude-code-agent` 已踩过的坑（同一套教训不重踩）：

- **流式块**：孤儿 delta（无 `content_block_start` 先来 delta）就地开块，不丢字；
  `content_block_stop`/`message_stop` 收口；进程死亡时清空 blockMap/blockAcc/toolCallOpen，
  防止半截块复活。
- **liveHistory 原序**：assistant 帧按**帧内块原始顺序**分组 emit（连续同类块合并为一条），
  刷新后不再出现「工具卡片之后才显示思考」。
- **工具结果**：`tool_result.content` 为纯 string 时直接采纳（qoderclicn 1.1.56 实测形态）；
  空输出占位 `(工具执行完成，无文本输出)` / `(工具执行失败)`，不留空气泡。
- **冷恢复回放**：session-manager 的 claude-like adapter 把 `tool_use`/`tool_result` 按 id 配对成结构化工具行
  （`IndexedMessage.tool`），`seedHistory` 经共享层 `@aiti-ai/ext-shared/seed-tool` 展开成 pi 原生
  `toolCall` + `toolResult`——接管/刷新后的工具卡与直播同形（v0.4.2；此前回放只剩一行 `🛠 {json}` 文本）。
- **工具名账本**：流式 `tool_use` 块头即登记 `id → name`，结果帧缺 name 时反查。
- **冷恢复 cwd**：占位会话 id（`new-*`）不发 RPC、不复用磁盘路径；回收占位见 `markDead`。
- **sidecar 文件名**：Windows 下 sid 里的冒号是 NTFS ADS 分隔符，`sidecarBase()` 统一替换。
- **dormant 服务认领严格**：`realSidOf()` 只认 `qoder:`/`qodercn:` 前缀或无前缀裸 id，
  其他后端复合 id 一律返回 null（宿主扫描是「首个非空即采纳」）。
- **contextUsage 暂不声明**：qodercli 的 assistant `usage` 确实带 `context_usage_ratio`，
  但宿主后端会话链路无出口（handle-adapter `get_state` 不吐该字段，前端只在
  `state.contextUsage !== undefined` 时采纳）——等宿主补线再接，不放假能力。
- **工具快照同类宿主缺口**：`getAllTools()` 已实现且 `listTools:true`，但宿主
  `handle-adapter` 的 `get_tools` 分支只有 `if (h.send) return h.send({type:"get_tools"})`
  再 `return []`（不调 `getAllTools`），本后端无 `send` → 工具面板拿空数组。这不是 qoder
  独有（claude-code/cursor/zcode 全部如此，只有 attach 系有裸通道），且 `_shared/
  agent-capability-contract.test.mjs` 的 `listTools` 白名单含 `getAllTools`，静态对照测不出——
  声明保留是为了宿主补线后零改动生效，面板要真出数据须宿主在 `get_tools` 加 `getAllTools` 兜底。

## 双区域

| variant | CLI | infer 网关 | openapi |
|---|---|---|---|
| `qoder`（intl） | `qodercli` | api2-v2.qoder.sh | openapi.qoder.sh |
| `qoder-cn` | `qoderclicn` | gateway.qoder.com.cn | openapi.qoder.com.cn |

按 PATH 上存在的二进制自动注册；区域凭据自动探测（cn 优先）。

CLI 二进制解析（`login-driver.ts resolveQoderCli`）：env 覆盖（`QODER_CLI_PATH`/
`QODER_CLI_CN_PATH`）> PATH（过 `isFile()`，Windows 上 whichBin 会命中 PATH 里的同名目录）>
安装位兜底 `~/.qoder{,-cn}/bin/<cli>/<cli>.exe`（Windows 实测 qoderclicn 装于此、PATH 上只有
IDE 启动命令 `qoder`——非 agent CLI，勿混）。

## 认证原理（逆向，详见 docs/qodercli-auth-api-analysis.md）

- 凭据在 `~/.qoder{,-cn}/.auth/user`（WASM 加密）；`assets/qoder_auth.wasm` +
  `qoder_glue.js` 从 qoderclicn 二进制提取，运行时解密出 dt-token 与
  `encrypt_user_info/key`（COSY 签名材料，长期有效）。
- 会话推理走 CLI 子进程（stream-json），认证由 CLI 自理；credits/目录走直连 REST。

## 已知坑

- qodercli **不支持 `--verbose`**（claude CLI 专属，传了 exit 1）
- headless 会话的活跃工具表（init 帧 33 项）**不含 `AskUserQuestion`**——模型侧根本调不到它；
  `EnterPlanMode`/`ExitPlanMode` 在内且必发 `can_use_tool`。故本后端的 `ask_user` 卡片属于
  「CLI 哪天暴露就自动生效」的共享层能力，不是当前链路（2026-09-19 probe 实测）
- result 帧自带本轮 `total_credits`，已并入 agent_settled 事件的 usage

## 部署

```bash
# 整目录拷到 ~/.pi/web{,-dev}/extensions/aiti-qoder-agent/
POST /api/extensions/reload   # 热重载
```

## 文档 · Documentation

- 中文完整文档（aiti-docs）: <https://aiti.pw/extensions/aiti-qoder-agent.html>
- English docs: <https://aiti.pw/en/extensions/aiti-qoder-agent.html>
- 扩展注册表 / registry: <https://aiti.pw/extensions.html> · machine-readable <https://aiti.pw/extensions.json>
