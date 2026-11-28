/**
 * spec.ts — types and capability declarations for the pi fork family (carrier-agnostic, no logic
 * beyond fork semantics).
 * Split out of aiti-pi-agent's pi-rpc-spawn.ts: types/constants migrated as-is; registerFork/listForks
 * (the family registration mechanism) retired with the split — each extension declares its own spec.
 */

// ============================================================================
// Family difference declarations
// ============================================================================

export interface PiForkCommands {
  /** fork meta-command name: pi=fork; omp=branch. */
  fork: "fork" | "branch";
  /** Fork message query command name (not yet consumed by this engine; declared for a future viewer). */
  getForkMessages: "get_fork_messages" | "get_branch_messages";
  /** Command list query command name: pi=get_commands; omp=get_available_commands. */
  getCommands: "get_commands" | "get_available_commands";
  /** Whether get_entries is supported (pi true; omp false → uses get_messages). */
  hasGetEntries: boolean;
  /** Whether there is a startup ready handshake frame (omp true; pi has none → 300ms sleep fallback). */
  hasReadyFrame: boolean;
  /** Whether get_state includes contextUsage (omp true). */
  hasContextUsage: boolean;
  /** Whether get_state includes dumpTools (omp true). */
  hasDumpTools: boolean;
  /** Whether host tool injection is supported (omp set_host_tools / host_tool_call｜result｜cancel). */
  hasHostTools: boolean;
  /** Whether OAuth login RPC is supported (omp get_login_providers/login → open_url frame; pi has none). */
  hasLogin: boolean;
  /** A09: subagent RPC surface (omp get_subagents/set_subagent_subscription/get_subagent_messages; pi has none). */
  hasSubagents: boolean;
}

export interface PiForkSpec {
  /** Family member id (= provider type suffix: spawn / omp-spawn). */
  id: string;
  /** Backend dropdown UI label. */
  label: string;
  /** Backend dropdown position (SessionProvider.order). */
  order: number;
  /** agentKey (all-sessions claim key; omp sessions land in ~/.omp and do not claim pi history). */
  agentKey?: string;
  /** Execution runtime: node → interpret cli.js with the explicit process.execPath; bun → interpret with the explicit bun. */
  runtime: "node" | "bun";
  /** CLI name on PATH (pi / omp). */
  pathBin: string;
  /** Explicit CLI override env variable name (e.g. OMP_CLI). */
  cliEnvVar: string;
  /** Bundled SDK cli.js path inside the package (pi only: PI_WEB_PKG_DIR); when absent this resolution tier is disabled. */
  bundledCli?(): string | undefined;
  commands: PiForkCommands;
}

/**
 * Host tool definition (omp host tools): a tool the host injects into the fork child process; when
 * the agent calls it, the call comes back to the host via a `host_tool_call` frame, and the host
 * answers with `host_tool_result` (an omp-only capability).
 */
export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema (omp RpcHostToolDefinition.parameters). */
  parameters: Record<string, unknown>;
  /** Host executor: returns a text result; throwing → an isError result frame. */
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
}

/** Handle capability bits (the fork-family subset of SessionCapabilities; the front end renders the action surface from these). */
export interface ForkCapabilities extends Record<string, boolean> {}

/** Derive capability bits from spec.commands (each pi/omp extension declares its maxCapabilities from this). */
export function capabilitiesFor(spec: PiForkSpec): ForkCapabilities {
  return {
    steer: true,
    followUp: true,
    // Queue keeper full CRUD (remote-queue shared layer: native clear_queue + the clear/re-inject mutation
    // strategy, docs/aiti-remote-queue-and-sidecar-plan.md §2)
    queueManage: true,
    // Steering entries can likewise be recalled/moved/converted (a mutation is clear+re-inject) — the host
    // uses this to enable the row-level actions of the queue panel's steer rows; backends like zcode whose
    // entries are "already injected into the peer process, unrecoverable via protocol" do not declare it
    steerQueueManage: true,
    getMessages: true,
    contextUsage: spec.commands.hasContextUsage, // omp get_state.contextUsage; pi RPC has none
    setModel: true,
    setThinkingLevel: true,
    fork: true,
    renameSession: true,
    compact: true,
    executeBash: true,
    setActiveTools: false, // neither family's RPC has it (pending protocol probing, see split plan B5)
    navigateTree: false,
    deleteSession: false,
    getCommands: true,
    listModels: true,
    listTools: spec.commands.hasDumpTools, // omp get_state.dumpTools; pi RPC has none (pending probing)
    // Advanced capabilities (inventoried at the 2026-09-14 split): respondInteraction is implemented,
    // declared; respondPermission/getUsage/fileAttachments to be added after protocol probing (B5).
    respondInteraction: true,
    subagents: spec.commands.hasSubagents,
    respondPermission: false,
    getUsage: false,
    fileAttachments: false,
    respondProviderHeaders: false, // zcode only
    setPermissionMode: false, // cc-connect only
  };
}
