/**
 * spec.ts — pi 系 fork 家族的类型与能力声明（载体无关，无 fork 语义之外的逻辑）。
 * 拆自 aiti-pi-agent 的 pi-rpc-spawn.ts：类型/常量原样迁移；registerFork/listForks
 * （家族注册机制）随拆分退役——每个扩展各自声明自己的 spec。
 */

// ============================================================================
// 家族差异声明
// ============================================================================

export interface PiForkCommands {
  /** fork 元语命令名：pi=fork；omp=branch。 */
  fork: "fork" | "branch";
  /** fork 消息查询命令名（本引擎暂未消费，声明给后续 viewer 用）。 */
  getForkMessages: "get_fork_messages" | "get_branch_messages";
  /** 命令清单查询命令名：pi=get_commands；omp=get_available_commands。 */
  getCommands: "get_commands" | "get_available_commands";
  /** 是否支持 get_entries（pi true；omp false → 走 get_messages）。 */
  hasGetEntries: boolean;
  /** 是否有启动 ready 握手帧（omp true；pi 无 → 300ms sleep 兜底）。 */
  hasReadyFrame: boolean;
  /** get_state 是否含 contextUsage（omp true）。 */
  hasContextUsage: boolean;
  /** get_state 是否含 dumpTools（omp true）。 */
  hasDumpTools: boolean;
  /** 是否支持宿主工具注入（omp set_host_tools / host_tool_call｜result｜cancel）。 */
  hasHostTools: boolean;
  /** 是否支持 OAuth 登录 RPC（omp get_login_providers/login → open_url 帧；pi 无）。 */
  hasLogin: boolean;
  /** A09：subagent RPC 面（omp get_subagents/set_subagent_subscription/get_subagent_messages；pi 无）。 */
  hasSubagents: boolean;
}

export interface PiForkSpec {
  /** 家族成员 id（= provider type 后缀：spawn / omp-spawn）。 */
  id: string;
  /** Backend 下拉 UI label。 */
  label: string;
  /** Backend 下拉位次（SessionProvider.order）。 */
  order: number;
  /** agentKey（all-sessions 认领键；omp 会话落 ~/.omp，不认领 pi 历史）。 */
  agentKey?: string;
  /** 执行运行时：node → 显式 process.execPath 解释 cli.js；bun → 显式 bun 解释。 */
  runtime: "node" | "bun";
  /** PATH 上的 CLI 名（pi / omp）。 */
  pathBin: string;
  /** 显式 CLI 覆盖 env 变量名（如 OMP_CLI）。 */
  cliEnvVar: string;
  /** 包内自带 SDK cli.js 路径（pi 专用：PI_WEB_PKG_DIR）；无则不启用该解析层。 */
  bundledCli?(): string | undefined;
  commands: PiForkCommands;
}

/**
 * 宿主工具定义（omp host tools）：宿主注入给 fork 子进程的工具；agent 调用时经
 * `host_tool_call` 帧回传宿主执行，宿主以 `host_tool_result` 应答（omp 独有能力）。
 */
export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema（omp RpcHostToolDefinition.parameters）。 */
  parameters: Record<string, unknown>;
  /** 宿主执行体：返回文本结果；抛错 → isError 结果帧。 */
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** Handle 能力位（SessionCapabilities 的 fork 家族子集，前端据此渲染操作面）。 */
export interface ForkCapabilities extends Record<string, boolean> {}

/** 由 spec.commands 派生能力位（pi/omp 各扩展以此声明 maxCapabilities）。 */
export function capabilitiesFor(spec: PiForkSpec): ForkCapabilities {
  return {
    steer: true,
    followUp: true,
    // 队列 keeper 全 CRUD（remote-queue 共享层：clear_queue 原生 + clear/重注入变更策略，
    // docs/aiti-remote-queue-and-sidecar-plan.md §2）
    queueManage: true,
    // steering 条目同样可撤回/移动/转换（变更即 clear+重注入）——宿主据此放开队列面板
    // steer 行的行级操作；zcode 那类「已注入对端进程、协议收不回」的后端不声明
    steerQueueManage: true,
    getMessages: true,
    contextUsage: spec.commands.hasContextUsage, // omp get_state.contextUsage；pi RPC 无
    setModel: true,
    setThinkingLevel: true,
    fork: true,
    renameSession: true,
    compact: true,
    executeBash: true,
    setActiveTools: false, // 两系 RPC 均无（待实测协议面，见拆分计划 B5）
    navigateTree: false,
    deleteSession: false,
    getCommands: true,
    listModels: true,
    listTools: spec.commands.hasDumpTools, // omp get_state.dumpTools；pi RPC 无（待实测）
    // 进阶能力（2026-09-14 拆分时盘点）：respondInteraction 已实现，补声明；
    // respondPermission/getUsage/fileAttachments 待实测协议面后补（B5）。
    respondInteraction: true,
    subagents: spec.commands.hasSubagents,
    respondPermission: false,
    getUsage: false,
    fileAttachments: false,
    respondProviderHeaders: false, // zcode 专属
    setPermissionMode: false, // cc-connect 专属
  };
}
