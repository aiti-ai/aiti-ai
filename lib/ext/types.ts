/**
 * pi-web extension framework — shared contract types.
 *
 * Extensions live in ~/.pi/web/extensions/<id>/ (PI_WEB_EXTENSIONS_DIR
 * overrides). Each exports a default object matching {@link PiWebExtension}.
 * Runtime data goes to ~/.pi/web/data/<id>/ (PI_WEB_DATA_DIR overrides) so
 * code and data never mix.
 *
 * Design aligns with docs/service-tunnels-extension.md §3/§11 (pending-design
 * items for generic slots, core data contract, data dir convention).
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Core data capabilities handed to extensions — no reimplementation of session access. */
export interface ExtCoreApi {
  listSessions(): Promise<unknown[]>;
  getRunningSessionIds(): Promise<string[]>;
  getHomeDir(): Promise<string>;
  /** Full session context (messages + entry ids) for a session id; null when missing. */
  readSession(id: string): Promise<unknown | null>;
  /** File-access helpers bound to pi-web's allowed-roots security (session cwds etc.). */
  fileAccess: {
    allowRoot(root: string): void;
    isAllowed(p: string): Promise<boolean>;
  };
}

/** Server context passed to startup/shutdown/api hooks. */
export interface ExtServerContext {
  id: string;
  /** Absolute path of the extension code directory (read-only for assets). */
  dir: string;
  /** Absolute path of the extension data directory (~/.pi/web/data/<id>/). */
  dataDir: string;
  core: ExtCoreApi;
}

/** Context for a single API dispatch (path segments after the extension id). */
export interface ExtApiContext extends ExtServerContext {
  method: string;
  /** Path segments after the extension id, e.g. ["echo"] for /api/extensions/demo/echo. */
  path: string[];
  searchParams: URLSearchParams;
}

export type ExtMiddlewareResult =
  | { handled: true; response: Response }
  | { handled: false }
  ;

export interface ExtServerHooks {
  startup?(ctx: ExtServerContext): Promise<void> | void;
  shutdown?(ctx: ExtServerContext): Promise<void> | void;
  /** Return null/undefined to signal "not found". */
  api?(req: Request, ctx: ExtApiContext): Promise<Response | null | undefined> | Response | null | undefined;
  /** Optional; runs for every request in the middleware, before core DNS-rebinding gate. */
  middleware?(req: Request): Promise<ExtMiddlewareResult> | ExtMiddlewareResult;
}

/**
 * agent 会话级扩展点（方案 M）：扩展把工具/回调进程内注入每个 agent 会话，零配置。
 * 工具经 SDK `createAgentSessionFromServices` 的 `customTools` 注入；会话生命周期
 * （启动/结束/settle）由 rpc-manager 回调。适合「桥与 agent 同进程」的场景（如 aiti-devtools）。
 */
export interface AgentSessionInfo {
  sessionId: string;
  cwd: string;
  /** 向会话注入一条用户消息（steer：当前 turn 完成后生效，等同用户发话）。 */
  steer(text: string): Promise<void>;
  /**
   * 订阅该会话的全量 agent 事件（进程内直连，不经 SSE 出口过滤——
   * agent events route 会丢弃 tool_execution_update，而它携带 bash 的实时滚动输出；
   * 扩展经此原样拿到）。返回取消订阅函数。
   */
  subscribeEvent?(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
  /** 中止该会话当前运行的 bash 命令（不 abort 整个 turn——agent 收到错误结果后继续）。 */
  abortBash?(): void;
}

/** 扩展看到的 wrapper 销毁原因（与 AgentWrapperEndReason 一致）：
 *  "shutdown" = 会话真正结束（删除路由/全局清理）；"fork" = fork 后换 wrapper
 *  （原会话文件还在）；"idle" = 10 分钟闲置 GC（文件还在，下次访问重建 wrapper）。
 *  扩展应据此区分「会话没了」与「wrapper 回收」，回调本身需幂等（同一 id 可能
 *  在 idle GC → 重建后再次收到 onAgentSession）。 */
export type ExtAgentEndReason = "shutdown" | "fork" | "idle";

export interface ExtAgentHooks {
  /** 注入每个 agent 会话的自定义工具（SDK ToolDefinition[]；工具 execute 闭包内直调本进程资源）。 */
  agentTools?(info: Pick<AgentSessionInfo, "sessionId" | "cwd">): ToolDefinition[];
  /** 会话启动（wrapper 创建后；扩展在此注册 agent 身份/绑定推送 sink）。 */
  onAgentSession?(info: AgentSessionInfo): void;
  /** 会话 wrapper 销毁。注意：不等于「会话文件被删」——fork 换 wrapper、闲置 GC
   *  回收也会触发；用 reason 区分。回调需幂等。 */
  onAgentSessionEnd?(info: { sessionId: string; reason?: ExtAgentEndReason }): void;
  /** agent 一轮执行完（agent_settled）——如把最终回答回桥/回显 UI。 */
  onAgentSettled?(info: { sessionId: string; text: string }): void;
}

/** Static metadata for UI items; the actual React components come from the client bundle. */
export interface ExtUiItem {
  id: string;
  label?: string;
  title?: string;
  /** slot-specific placement hints (e.g. sidebar badge) */
  badge?: boolean;
}

export type ExtSlotName =
  | "toolbar"
  | "sidebar"
  | "sessionTopbar"
  | "sessionRowActions"
  | "dialogs"
  | "banners"
  | "pages"
  | "chatInputTop"   // 聊天输入框上方（aiti-devtools：inspect 候选区等）
  | "userMessageActions" // user 消息底部 hover 操作区（aiti-prompts：📌 收藏为 prompt 等）
  ;

/**
 * 消息点击识别弹层（QuoteReplyPopover）动作扩展点。
 * 扩展注册 provider；点击段落 → core 把段落全文交给每个 provider 的 recognize（可异步校验）
 * → 返回动作按钮 → 点击调用 onClick（识别/校验/执行全在扩展侧，core 只渲染 + 调起）。
 */
export interface PopoverAction {
  /**
   * 动作类型（语义分类，UI 按 type 加图标/分组）：
   * 内置约定 "quote"（问题回复）· "file"（文件）· "command"（命令），扩展可自定义任意字符串。
   */
  type: string;
  /** 动作唯一 id（同段同 provider 内去重用） */
  id: string;
  /** 按钮文案（纯文本，不带图标/⚠——core 按 type/danger 统一加） */
  label: string;
  /** 危险标记 → 红边 + ⚠ */
  danger?: boolean;
  /** 不可用标记（如 command not found）→ 灰显 + ❌，title 提示 */
  unavailable?: boolean;
  /** tooltip */
  title?: string;
  /** 点击回调：参数为 provider 识别时的段落全文 + 会话 cwd */
  onClick: (text: string, cwd?: string) => void;
}
export interface PopoverActionProvider {
  id: string;
  /** 可异步（校验/查环境/调服务端） */
  recognize(text: string, ctx: { cwd?: string; messageRole?: string }): Promise<PopoverAction[]> | PopoverAction[];
}

export interface ExtUiDefinition {
  toolbar?: ExtUiItem[];
  sidebar?: ExtUiItem[];
  sessionTopbar?: ExtUiItem[];
  sessionRowActions?: ExtUiItem[];
  dialogs?: ExtUiItem[];
  banners?: ExtUiItem[];
  pages?: ExtUiItem[];
  chatInputTop?: ExtUiItem[];
  /** Per-locale message table looked up via the client ctx.t(key, params). */
  i18n?: Record<string, Record<string, string>>;
}

export interface PiWebExtension {
  id: string;
  name: string;
  version: string;
  server?: ExtServerHooks & { agent?: ExtAgentHooks };
  ui?: ExtUiDefinition;
  /** Relative path (from the extension dir) to a prebuilt ESM client bundle. */
  client?: string;
  /** 短图标/emoji（如 "🧰"）——顶栏自定义面板等 UI 中标注扩展身份用，可选。 */
  icon?: string;
}

/** 扩展来源根：本地(home) > 额外(env 中间层) > dev(dev-exts 开发层) > 内置(程序目录基线)。 */
export type ExtensionSource = "user" | "extra" | "dev" | "bundled";

/** A successfully-loaded extension plus its resolved directories. */
export interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  dir: string;
  dataDir: string;
  /** 实际加载的根（user / extra / bundled）——同名时高优先级根遮蔽低优先级根。 */
  source: ExtensionSource;
  ext: PiWebExtension;
}

/** Entry exposed in the client manifest. */
export interface ManifestExtension {
  id: string;
  name: string;
  version: string;
  clientUrl: string | null;
  ui: ExtUiDefinition | null;
  source?: ExtensionSource;
  error?: string;
  icon?: string | null;
}
