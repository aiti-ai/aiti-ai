# 调研：把 pi-web 后端替换为 omp（Oh My Pi）

> 状态：调研报告（未实施）
> 日期：2026-02
> 结论：**技术上可行**，omp 是 pi 的 fork，API 兼容度约 90%；但 omp 是 Bun-only 运行时，
> 且数据（目录/配置/会话格式）有实质差异。两条实施路线，推荐 B（RPC 子进程）。

---

## 1. omp 是什么

- **Oh My Pi**（[omp.sh](https://omp.sh) / github.com/can1357/oh-my-pi），
  pi（pi-mono）的 fork，MIT，当前版本 `17.2.11`（pi-web 用的 pi 是 `0.84.0`，版本体系不同）。
- 架构：TypeScript + **Bun**，核心重活由 Rust 原生引擎（`@oh-my-pi/pi-natives`，N-API）承担
  （~80k 行 Rust：LSP、DAP、grep、文本搜索、PTY 等）。
- 特性是 pi 的超集：subagents/task、plan mode、LSP 集成、DAP 调试、hindsight 记忆、
  hashline 编辑、time-traveling 流式规则、代码执行内核（Python/Bun worker）、advisor 模型等。
- 三种集成面：
  1. **CLI 二进制**（`curl https://omp.sh/install | sh`、brew、`bun install -g @oh-my-pi/pi-coding-agent`）
  2. **Node SDK 内嵌**：`createAgentSession()` —— "The Node SDK embeds the session in your process"
  3. **RPC 模式**：`omp --mode rpc`，stdio 上跑换行分隔的 JSON 协议（`docs/rpc.md`）

## 2. pi-web 当前后端（替换对象）

- Next.js 服务器（**Node** ≥ 22.19）进程内 `startRpcSession()`：
  `createAgentSessionServices()` 预建服务 → `createAgentSessionFromServices()` 创建
  `AgentSession`，wrapper 注册在 `globalThis.__piSessions`，10 分钟空闲回收。
- 直接读 `~/.pi/agent/sessions/<--cwd-->/<ts>_<uuid>.jsonl`（`lib/session-reader.ts`）。
- 配置/认证：`~/.pi/agent/{settings.json, models.json, auth.json}`。
- 依赖 `@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui`、`pi-agent-core`。

## 3. 逐项兼容性核对

### 3.1 运行时 —— 最大障碍 ⛔

- omp 全部包 `engines: { "bun": ">=1.3.14" }`。
- npm 包**直接发源码**（`main: ./src/index.ts`），且核心模块硬编码 `bun:sqlite` /
  `bun:ffi` / `bun:jsc`（tools/read、tools/write、session storage、history、memories、
  mnemopi 等 19 处）。
- `dist/cli.js` 是 Bun bundle（`#!/usr/bin/env bun`，含 `bun:` 导入）。
- **Node 下无法 import 或执行**。pi-web 服务器要么整体搬到 Bun 上跑 Next.js，
  要么走 RPC 子进程（见 §5）。

### 3.2 SDK API 面 —— 高兼容 ✅

omp 是 fork，核心 API 同名同签名（已对照 omp 17.2.11 npm 包源码逐项验证）：

| pi-web 使用的 | omp 对应 |
|---|---|
| `createAgentSessionFromServices` / `createAgentSessionServices` | ❌ 无；合并为单一 `createAgentSession(options)`（含 `sessionManager`/`settings`/`authStorage`/`modelRegistry`/`model`/`thinkingLevel`/`scopedModels`/`toolNames`/`eventBus`/`systemPrompt`…） |
| `SessionManager.create/open/list/continueRecent` | ✅ 同名 |
| `session.prompt / steer / followUp / abort` | ✅ 同名 |
| `session.fork()` | ✅（同 fork 语义，`parentSession` header） |
| `session.navigateTree(targetId)` | ✅（RPC 里叫 `branch`） |
| `session.compact / abortCompaction` | ✅ |
| `session.setModel / setThinkingLevel / setAutoCompactionEnabled / setAutoRetryEnabled` | ✅ |
| `session.getAllTools / setActiveToolsByName / getActiveToolNames` | ✅ |
| `session.getState / getSessionStats / getContextUsage / getLastAssistantText / setSessionName` | ✅（RPC `get_state` 字段基本一致） |
| `session.clearQueue / getSteeringMessages / getFollowUpMessages` | ✅ |
| `session.subscribe / dispose / reload` | ✅ |
| `getAgentDir()` | ✅ 但指向 `~/.omp/agent` |
| `initTheme / KeybindingsManager (pi-tui)` | ✅ `@oh-my-pi/pi-tui` |
| `resolveModelScopeWithDiagnostics`（lib/model-scope.ts） | ⚠️ 有 `resolveModelScope(patterns, registry, prefs, settings)`，签名略变，需小适配 |
| `AuthStorage / ModelRegistry / Settings` | ✅ 同名 |

`lib/rpc-manager.ts` 的 `send()` 全部命令（prompt/abort/get_state/set_model/fork/
navigate_tree/set_thinking_level/compact/set_session_name/get_session_stats/
get_last_assistant_text/set_auto_compaction/clear_queue/steer/follow_up/get_tools/
set_tools/reload/abort_compaction/set_auto_retry/bash/abort_bash）在 omp AgentSession
上都有对应方法；`move_queue/recall_queue_item/requeue_at/remove_queue_item/
resolve_recovery/export_queue/import_queue/stage_recovery` 是 pi-web 自己的逻辑，不受影响。

### 3.3 事件流 —— 兼容超集 ✅

`AgentSessionEvent` = pi 的 `AgentEvent` 超集（新增 auto_retry_*/retry_fallback_*/
ttsr_triggered/todo_*/notice/thinking_level_changed/goal_updated/subagent_* 等；
`agent_end` 多了 `isTerminal` 字段，`auto_compaction_start/end` 的 `action` 枚举扩展）。
pi-web `useAgentSession` 已兼容 `compaction_start/end` 与 `auto_compaction_start/end`
两套命名，事件层面基本可直接用。

### 3.4 数据位置与格式 —— 实质差异 ⚠️

| 项 | pi（现状） | omp |
|---|---|---|
| 配置根 | `~/.pi/agent` | `~/.omp/agent`（`PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR` 可改，XDG 感知） |
| sessions 目录 | `~/.pi/agent/sessions/--<cwd>--/` | `~/.omp/agent/sessions/<编码>/`：home 相对 `-workspace-foo`、绝对 `abs-…`（17.2.5–17.2.8 曾是哈希名，现支持迁移旧 `--…--` 名） |
| 主配置 | `settings.json`（JSON） | `config.yml`（YAML，`MAIN_CONFIG_FILENAMES = ["config.yml","config.yaml"]`，**不读 settings.json**） |
| 模型配置 | `models.json`（pi-web 有读写 UI） | `models.yml`（含 provider apiKey 覆盖） |
| 认证 | `auth.json` | `auth.json`（基本兼容，新增 credential pin） |
| session 文件 | `<ts>_<uuid>.jsonl`，entry：session/message/model_change/compaction/thinking_level_change/session_info | 同名文件与 entry 大集合，但：`model_change` 改为 `{model: "provider/modelId", role?}`（pi 是 `{provider, modelId}`）；标题在 header `title`+`titleSource` 而非 `session_info` entry；新增 `branch_summary/reset_boundary/custom/label/service_tier_change` 等 entry |
| skills | `~/.pi/agent/skills` | `~/.omp/agent/skills` |

> omp 自带 "foreign session" 导入只覆盖 **claude/codex**，**不含 pi**；
> 转换 pi↔omp 需要 pi.dev 上的 `pi-omp-session-sync` 包或自写适配。

### 3.5 版本漂移风险 ⚠️

omp 是高速迭代的 fork（17.2.11，上游同步标记 2026-03-22），存储层在演化
（sql-session-storage / redis / indexed-storage 可选后端），RPC/SDK 核心面保持稳定但
有小幅更名（`navigate_tree`→`branch`）。升级 omp 需要回归 pi-web 的 rpc-manager 适配层。

## 4. 不受影响的部分

- 前端全部（React/Next 组件、SSE 管道形状、ChatInput/MessageView/FileViewer…）
- `proxy.ts` / service-tunnels 集成（pi-web 自持）
- queue 侧车文件 `<session>.jsonl.queue.json`（pi-web 自持，与引擎无关）
- worktrees / file-access / auth 网关（web-auth、request-security）
- session 导出的 HTML（pi 的 export helper → omp 的 `export_html`/`export/*`）

## 5. 两条实施路线

### 路线 A：SDK 内嵌换包（服务器整体搬 Bun）

- 依赖 `@earendil-works/*` → `@oh-my-pi/*`（coding-agent/ai/tui/agent-core），
  服务器用 `bun run next dev` / `bun run next start`。
- 改造量：`lib/rpc-manager.ts`（`createAgentSessionServices`+`createAgentSessionFromServices`
  折叠成一次 `createAgentSession()`，工具禁用时 `systemPrompt=""` 的 hack 需重查 omp 语义）、
  `lib/model-scope.ts`、`lib/session-reader.ts`（entry 解析）、`lib/models-config-store.ts`、
  `lib/skills-service.ts` / `lib/skill-lock.ts`（agentDir）。
- 风险：Next 16 middleware（proxy.ts）+ service-tunnels + proper-lockfile + undici
  在 Bun 下的兼容性未验证；omp 发的是裸 TS 源码，依赖 Bun 原生 TS 加载。

### 路线 B：RPC 子进程（Node 服务器保留）✅ 推荐

- 服务器保持 Node/Next；每个会话 spawn `omp --mode rpc`（或按 cwd 一个进程 +
  `switch_session`），stdio NDJSON 通信（协议有 ready frame、`negotiate_protocol` v2
  分帧、id 关联；Node 侧实现一个轻量 RpcClient 不难，omp 的 TS RpcClient 在 Bun 侧）。
- `AgentSessionWrapper` 改造成子进程客户端：命令 1:1 转发，事件 JSONL → SSE 管道几乎不动。
- **需补 RPC 缺口**：RPC 命令集里**没有 `fork` 和 `get_tools`**——fork 可用
  `new_session {parentSession}` 替代（wrapper 现有 fork=destroy+重建语义天然适配子进程模型）；
  get_tools 用 `get_state`/`set_host_tools`/`get_available_commands` 组合推断预设。
- 数据适配（session-reader/models-config/skills）与路线 A 相同。
- 优点：无 Bun-in-Node 问题；进程隔离（崩溃不影响服务器）；omp 二进制是官方发行形态；
  原生重特性（LSP/DAP/subagents）免费获得。

## 6. 改造文件清单（两条路线共用）

```
lib/rpc-manager.ts        # 会话创建 + 命令适配（最大改动）
lib/session-reader.ts     # entry 解析（model_change 单字段、标题来源）+ agentDir + 目录编码
lib/model-scope.ts        # resolveModelScope 签名适配
lib/models-config-store.ts # ~/.omp/agent 路径 + config.yml/models.yml 格式
lib/skills-service.ts, lib/skill-lock.ts  # agentDir 路径
lib/startup-preferences.ts # 与 settings 格式相关的持久化
app/api/models/route.ts, app/api/models-config/* # 模型配置读写来源
app/api/sessions/[id]/context/route.ts  # 若 entry 形状变了
package.json              # 依赖 scope 替换（或新增 omp 子进程封装）
docs/…                    # AGENTS.md 架构图更新
```

## 7. 建议的下一步（PoC 顺序）

1. 安装 omp CLI，跑一个真实会话，diff 实际产出的 session JSONL 与 `~/.pi/agent` 的差异
   （确认 §3.4 的 entry/标题差异全貌，含 message content block 类型）。
2. 用 `omp --mode rpc` 驱动一次 prompt + fork + steer，对比事件流与 pi 的差异。
3. 验证 `pi-omp-session-sync`（pi.dev）能否批量转换存量会话。
4. 路线 B 打样：Node 侧 100 行 RpcClient + 一个代理 route，跑通 prompt/SSE 即可评估全量迁移。
5. 决策点：a) 数据迁移策略（`~/.pi` → `~/.omp` 还是双读）；b) 是否保留 pi-web 的
   models/settings UI（omp 用 config.yml/models.yml，格式不同）；c) 是否回退保留 pi 双后端开关。

## 结论

- **可行性：高**。omp 是 pi 的 fork，SDK/RPC/事件三面高度兼容，pi-web 的 `send()`
  命令面、SSE 管道、queue/worktree/file 等外围全部可复用。
- **主要成本**：运行时换轨（路线 B 规避）、会话/配置数据迁移、session-reader 与
  models/skills 的格式适配、以及 omp 快速迭代带来的长期同步负担。
- **推荐路线 B**（RPC 子进程）：把 omp 当作"可替换引擎"，pi-web 的 Node 架构、
  中间件、service-tunnels 全部不动，集成面收敛在 `lib/rpc-manager.ts` 一个文件里。

---

## 8. 收益分析：换 omp 能得到什么

### 8.1 对最终用户（pi-web 网页聊天）的直接收益

1. **更强的工具链**：LSP 集成（重命名走 `workspace/willRenameFiles` 联动 re-export/alias）、
   DAP 调试（lldb/dlv/debugpy 真调试器）、subagents/task（隔离 worktree 扇出 + 类型化结果）、
   plan mode（计划审批）、代码执行内核（Python/Bun worker 可回调 agent 工具）。
2. **编辑可靠性**：hashline 哈希锚定编辑 —— 官方基准显示部分模型首改通过率提升一个数量级
   （Grok Code Fast 1 6.7%→68.3%）、Grok 4 Fast 输出 token 减少 61%。
3. **效率/成本**：read 摘要化、native Rust grep（文本搜索管线）、fs 扫描缓存 → 更快且省 token；
   "benchmaxxed" 按模型调优的 prompts。
4. **规则/记忆**：ttsr 时间旅行流式规则（越轨时中断注入并重试，抗压缩）、hindsight 持久记忆、
   原生读取 8 种规则格式（Cursor MDC/Cline/Codex AGENTS.md/Copilot applyTo…）。
5. **模型生态**：60+ providers（pi 约 40）；advisor 第二模型旁路审查每轮输出。
6. **性能底座**：Rust 原生核心（N-API）承担 grep/文本搜索/PTY/语法高亮等重活。

### 8.2 对 pi-web 维护者

- 白嫖 omp 社区的持续特性演进（omp 活跃度显著高于 pi，10k+ stars）。
- 引擎可替换后（见 §9），pi-web 前端不再绑定单一 harness 的生死。

### 8.3 代价（已核实的硬成本）

- Bun-only 运行时（§3.1）；数据目录/格式迁移（§3.4）；omp 快速迭代的长期同步负担（§3.5）。
- omp 的 settings/models 是 YAML（config.yml/models.yml），pi-web 现有的 models 编辑 UI
  要么改写读写层，要么只读。

## 9. 兼容的可能：可插拔后端（Pluggable Backend）

### 9.1 核心判断：两条 RPC 协议同构

pi（0.84.0）与 omp（17.2.11）**都**有 `--mode rpc`，stdio NDJSON，命令高度重合：

| 命令 | pi RPC | omp RPC |
|---|---|---|
| prompt/steer/follow_up/abort/get_state/set_model/set_thinking_level/compact/set_auto_compaction/set_auto_retry/bash/get_session_stats/export_html/switch_session/set_session_name/get_messages/get_last_assistant_text | ✅ | ✅ |
| fork / clone / get_fork_messages / get_entries / get_tree / get_available_thinking_levels / get_commands | ✅ | ❌ |
| navigate_tree | ❌（用 get_tree/get_entries） | ✅ 更名 `branch` / `get_branch_messages` |
| negotiate_protocol / abort_and_prompt / set_host_tools / set_subagent_subscription / get_subagents / set_todos / handoff / get_messages_page / login | ❌ | ✅ |

> 注：**两套 RPC 都没有 `get_tools`** —— 工具预设推断需用 `get_state` + `get_available_commands` +
> `get_messages` 组合（pi-web 现在 `get_tools` 是在进程内调 `inner.getAllTools()`，改 RPC 后两引擎同样处理）。

因此一个**通用 NDJSON RpcClient + 每引擎命令映射表**即可驱动 pi 或 omp 子进程。

### 9.2 架构设计

```
lib/engine/
  types.ts            # AgentEngine 接口 + SessionFormatAdapter 接口
  rpc-client.ts        # 通用 NDJSON RPC 客户端（协议协商/分帧/命令映射）
  pi-inprocess.ts     # 现状实现（globalThis.__piSessions 等，零改动搬迁）
  pi-rpc.ts           # 可选：spawn `pi --mode rpc`（纯 Node 可跑，pi 发编译产物）
  omp-rpc.ts          # 新增：spawn `omp --mode rpc`（Bun 二进制）
  format-pi.ts        # pi session JSONL 解析（现有 session-reader 提取）
  format-omp.ts       # omp JSONL 解析（model_change 单字段、header title、新 entry）
```

- **AgentEngine 接口**（≈ 现在 `AgentSessionWrapper` 的公开面）：
  `createSession / prompt / steer / followUp / abort / fork / navigateTree / compact /
  setModel / setThinkingLevel / getState / getTools / setTools / setSessionName /
  getSessionStats / clearQueue / subscribe / dispose`。
- **事件标准化**：每个实现把引擎事件 normalize 成 pi-web 现有事件形状（已有 `normalizeToolCalls`
  先例；omp 事件是 pi 超集，基本直通）。
- **SessionFormatAdapter**：`listSessions() / buildSessionContext(file)` 按引擎选择；
  agentDir、目录编码、entry 解析全部收敛在这里。
- **引擎选择**：环境变量 `PI_WEB_AGENT_ENGINE=pi-inprocess|omp-rpc|pi-rpc`（可默认 + 运行时切换）。
- **数据并存**：`~/.pi/agent` 与 `~/.omp/agent` 双目录各自读写，互不干扰；session 树按引擎
  过滤或合并展示；存量转换走 pi.dev 的 `pi-omp-session-sync`（或 omp 自身 legacy 目录迁移逻辑）。
- **引擎无关、零改动**：queue 侧车、worktrees、file-access、proxy/service-tunnels、前端全部。

### 9.3 兼容性结论

- **不迁移也能共存**：默认 `pi-inprocess`（现状零回归），omp 作为可选引擎增量引入，
  甚至同一进程同时开 pi 内嵌 + omp 子进程（不同 agentDir，互不冲突）。
- **迁移成本被压缩到单点**：所有差异集中在 `lib/engine/*`；`lib/rpc-manager.ts` 退化为
  引擎注册/选择/生命周期管理。
- **残余风险**：
  1. omp RPC 无 `fork` → 用 `new_session {parentSession}` 替代，需验证与 pi fork
     语义等价（含 `providerPromptCacheKey` 继承）。
  2. omp 迭代快，命令可能继续更名（`navigate_tree`→`branch` 先例）→ 命令映射表集中维护。
  3. omp 的 `extension_ui_request` 帧与 pi-web 的 custom-ui-terminal 桥需适配。
  4. omp 子进程需要生命周期管理（spawn/心跳/崩溃重启/空闲回收），沿用现 wrapper 的
     10 分钟空闲超时模型。

### 9.4 推荐落地顺序

1. 抽出 `AgentEngine` 接口，把现有 `pi-inprocess` 原样实现（纯重构，零行为变化）。
2. 写通用 `rpc-client.ts` + `pi-rpc` 引擎（pi CLI 是 Node 可跑的编译产物，先打通 RPC 通道）。
3. 加 `omp-rpc` 引擎 + `format-omp.ts`，跑通 prompt/fork/steer/compact 全流程。
4. 用 `PI_WEB_AGENT_ENGINE` 开关灰度，评估后决定默认值与数据迁移。
