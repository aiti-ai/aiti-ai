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
import type { ReactNode } from "react";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueuePanelProps } from "@/lib/composer/queue-api";

/**
 * 扩展功能声明（功能管理）：扩展可把自己开放的「功能点」（如注入 agent 会话的
 * 工具、可选行为开关）声明为可管理的 feature。用户经扩展管理器逐个启用/禁用，
 * 状态持久化在 <dataRoot>/features.json（core registry 统一读写）。
 *
 * 工具级功能约定：feature.id = "tool.<注入后的工具名>"（如 aiti-devtools 的
 * aiti_page_exec → "tool.aiti_page_exec"）时，core 在 collectAgentTools 注入时
 * 自动过滤被禁用的工具，并在 execute 时校验（禁用后即时拒绝，已有会话同样生效）。
 * 其他前缀（如 "behavior.xxx"）由扩展自行在代码里查询 featureEnabled 决定行为。
 */
export interface ExtFeature {
  /** 功能唯一 id（扩展内唯一）。工具级 = "tool.<工具名>"。 */
  id: string;
  /** 显示名（扩展管理界面展示）。 */
  label: string;
  /** 说明（可选）。 */
  description?: string;
  /** 分组（可选，如 "页面操作" / "用户交互"；扩展管理界面按组分）。 */
  group?: string;
  /** 值类型（缺省 "boolean" = 开关；"string" = 文本配置项，扩展管理界面画输入框）。 */
  type?: "boolean" | "string";
  /** 默认启用（boolean 类型用；缺省 true；false = 默认关闭，用户可手动打开）。 */
  default?: boolean;
  /** 默认值（string 类型用；缺省 ""）。 */
  value?: string;
  /** 输入框占位提示（string 类型用，可选）。 */
  placeholder?: string;
}

/** status 接口里的功能条目 = 声明 + 当前生效状态。 */
export interface ExtStatusFeature extends ExtFeature {
  /** 当前生效（boolean 类型：用户显式设置优先，否则取 default；string 类型恒 true）。 */
  enabled: boolean;
  /** 当前值（string 类型：用户显式设置优先，否则取声明 value；boolean 类型无此字段）。 */
  value?: string;
}

/**
 * 会话后端注册 slot：扩展在 server.startup 里注册 SessionProvider，把自定义
 * agent 后端接入 pi-web 的多 agent 前端。注册键自动加扩展 id 前缀
 * （"<extId>/<type>"），不会遮蔽内置 provider 或其他扩展；扩展 shutdown/
 * reload 时自动注销。
 *
 * 类型契约见 lib/session/types.ts（SessionHandle / SessionCapabilities）——
 * fail loud：不支持的能力声明 false 并在方法里抛 UnsupportedCapabilityError。
 */
export interface ExtSessionProviderRegistration {
  /** Provider 短名（不含前缀；不能含 "/"）。最终键 = "<extId>/<type>"。 */
  type: string;
  /** UI 展示名（新建会话的 provider 选择器）。 */
  label: string;
  /** 能力上限声明（fail-loud 契约，UI 据此显隐控件）。 */
  maxCapabilities: import("../session/types.ts").SessionCapabilities;
  /** 静态模型目录（无会话即可取；新建页选后端时给选择器供数据）。可选，缺省回退本地清单。 */
  listModels?(): Promise<Array<{ id: string; provider: string; label?: string }>>;
  createSession(options: {
    sessionFile?: string;
    cwd?: string;
    socketPath?: string;
    env?: Record<string, string>;
    /** 扩展可自由扩展的额外选项（透传，host 不解释）。 */
    [key: string]: unknown;
  }): Promise<import("../session/types.ts").SessionHandle>;
  shutdown?(): Promise<void>;
}

/**
 * 会话标注 slot：扩展为会话列表行追加自有字段（如占用标记）。
 * 数据的所有权在扩展——核心不感知任何具体格式（如桥注册表文件）。
 * 返回以行 id 或 path 为键的部分字段映射，由核心合并进响应。
 */
export interface ExtSessionAnnotatorSlot {
  /**
   * 注册标注器。rows 是当前会话列表行的轻量投影；
   * 返回 Record<rowKey, Partial<fields>>（rowKey 匹配行的 id 或 path）。
   */
  register(annotator: {
    annotate(rows: Array<{ id: string; path?: string; cwd?: string }>): Promise<Record<string, Record<string, unknown>> | void>;
  }): void;
}

export interface ExtSessionProviderSlot {
  /** 注册后返回完整 registry key（"<extId>/<type>"），调用方作为 providerType 使用。 */
  register(provider: ExtSessionProviderRegistration): string;
  /** 按完整键注销一个 provider（热移除，无需 reload）。 */
  remove(type: string): boolean;
  /** 是否有能驱动该外部 agent 的后端（all-sessions agentKey，如 "claude"）。 */
  canOpen(agentKey: string): boolean;
  /**
   * 打开外部历史会话为 live 会话（attach-from-history）。成功返回
   * { ok: true, sessionId }（sessionId = 复合 id，可直接喂给 /api/agent/[id]）；
   * 无驱动后端返回 { ok: false, reason: "no_provider" }。
   */
  open(
    compositeId: string,
    options?: { cwd?: string },
  ): Promise<{ ok: true; sessionId: string } | { ok: false; reason: "no_provider" | "open_failed"; error?: string }>;
}

/** Core data capabilities handed to extensions — no reimplementation of session access. */
export interface ExtCoreApi {
  listSessions(): Promise<unknown[]>;
  getRunningSessionIds(): Promise<string[]>;
  getHomeDir(): Promise<string>;
  /** Full session context (messages + entry ids) for a session id; null when missing. */
  readSession(id: string): Promise<unknown | null>;
  /** 读当前 models.json（{providers:{...}}）。扩展不直接手写文件——统一走此接口（含缓存失效）。 */
  readModelsConfig(): Promise<Record<string, unknown>>;
  /** 写 models.json（规范化 + invalidateModelsCache 缓存失效，改动立即生效）。 */
  writeModelsConfig(data: Record<string, unknown>): Promise<void>;
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
  /** 会话后端注册 slot（多 agent 前端）：扩展经此注册自定义 SessionProvider。 */
  sessionProviders: ExtSessionProviderSlot;
  /** 会话标注 slot：扩展为会话列表追加自有标记（如 TUI 桥占用）。 */
  sessionAnnotations: ExtSessionAnnotatorSlot;
  /** 通用 AI 调用（core 最底层模型能力）：任意 system+messages → { text, usage }；core 零业务、零统计。
   *  所有 prompt 组装 / 上下文 / 项目现场 / token 统计由调用方扩展负责。 */
  invokeAI?: (params: {
    provider?: string; modelId?: string; system?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number; temperature?: number; reasoning?: string;
    /** 记账维度：扩展可细分场景（如 aiti-ai-input/complete），缺省记 ext.id */
    caller?: string;
  }) => Promise<{ text: string; provider: string; model: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }>;
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
  /** 该会话当前正在使用的模型（随模型切换实时返回；运行时监测/归因用）。 */
  getModel?(): { provider: string; modelId: string } | null;
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
  /** 菜单内已自带完整内容（如搜索输入框），宿主不再补文字 label */
  noMenuLabel?: boolean;
  /**
   * 声明式图标（toolbar 插槽；宿主按标准灰度线条风格渲染，外观收敛归宿主，杜绝各扩展自绘漂移）：
   * - { svg }: 24×24 viewBox 的 SVG 内部标记字符串（lucide 线条风格，stroke=currentColor，如 `<path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>`）
   * - emoji 字符串（如 "📥"）
   * - 扩展内 .svg 文件相对路径（如 "icon.svg"；CSS-mask 渲染，颜色随 currentColor）
   */
  icon?: ExtUiItemIcon;
}

/** toolbar 条目声明式图标（见 ExtUiItem.icon）。 */
export type ExtUiItemIcon = string | { svg: string };

export type ExtSlotName =
  | "toolbar"
  | "sidebar"
  | "sidebarFooter"  // 侧栏底部快捷操作行（模型/技能/插件同一行；aiti-extman：扩展管理入口）
  | "sessionTopbar"
  | "sessionRowActions"
  | "sessionRowLeading"
  | "dialogs"
  | "banners"
  | "pages"
  | "chatInputTop"   // 聊天输入框上方（aiti-devtools：inspect 候选区等）
  | "chatOverlay"    // 消息区覆盖层（消息滚动导航条等；aiti-msg-nav
                     //   在消息列右侧渲染 absolute 悬浮工具栏）
  | "userMessageActions" // user 消息底部 hover 操作区（aiti-prompts：📌 收藏为 prompt 等）
  | "fileViewer"     // 文件查看/编辑接管（aiti-editor：文本文件编辑；aiti-folder：文件夹浏览器；未接管时核心原查看器兑底）
  | "pathPicker"    // 目录选择器能力（aiti-folder：FolderSwitcher 同款；顶栏「打开文件夹」等消费）
  | "newSessionBackendBar" // 新会话欢迎页 Backend 选择器旁（各后端扩展自行渲染管理入口，如 ACP agent 管理）
  | "sessionStats"   // 会话统计下拉内扩展条目行（aiti-ai-usage：报表入口；aiti-ai-input：其他辅助 AI 用量统计行）
  | "composerTools"  // 输入框下方控制行（压缩/停止/导入 queue 同排；aiti-git-trace：时间线主入口等）
  | "queuePanel"    // 队列面板插槽（去 fork 化 P3：aiti-queue-keeper 完整队列 UI 接管；
                    //   无接管时 core 兜底 banner 渲染，见 docs/pi-web-queue-cluster-ext-plan.md）
  | "workspacePickerActions" // CWD picker 下拉底部动作区（session-manager：管理工作区列表——
                    //   选择/隐藏/删除；核心只渲染下拉列表，管理 UI 全在扩展侧）
  ;

/**
 * UI 插槽类型契约（DSH SlotMap 反哺，docs/dsh-adapter-assessment.md §5.2）。
 *
 * 扩展（TS 编写 client bundle）通过 module augmentation 声明自己用到/提供的
 * 插槽额外 props 类型：
 *
 *   // 扩展端（client bundle 里的 .ts 文件）
 *   declare module "pi-web-ext/ext" {
 *     interface ExtSlotContractMap {
 *       chatInputTop: { props: { inputValue: string } }
 *     }
 *   }
 *
 * 宿主端 ExtSlot 的 props 类型随插槽名从契约取；未声明的插槽退化为宽松
 * Record<string, unknown>（向后兼容）。契约是「类型级文档」：运行时无影响，
 * 加载正确性仍由 loader 保证。
 */
// 空接口是 module augmentation（declare module "pi-web-ext/ext"）的合并锚点——
// DSH SlotMap 同款设计，必须有可合并的空类型。宿主已声明的插槽契约（如
// queuePanel）直接合并进来，扩展侧经 augmentation 增补；两边的实现都按
// 结构契约消费（扩展在仓外，见 aiti-queue-keeper/client/src/types.ts）。
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
/** workspacePickerActions 插槽 props（CWD picker 下拉底部动作区）。 */
export interface WorkspacePickerActionsProps {
  /** 当前可见项目列表（已按隐藏列表过滤；key=workspace 稳定键，root=展示路径）。 */
  projects: { key: string; root: string }[];
  /** 全部项目列表（未过滤隐藏——管理弹窗需列出含已隐藏的全部项目）。 */
  allProjects: { key: string; root: string }[];
  /** 当前选中的 cwd（未选时为 null）。 */
  selectedCwd: string | null;
  /** 当前隐藏的 workspace root 集合。 */
  hiddenWorkspaces: ReadonlySet<string>;
  /** 选择项目（切到该项目 cwd；管理弹窗「选择」用）。 */
  onSelect: (root: string) => void;
  /** 关闭下拉（管理弹窗打开前调用）。 */
  onClose: () => void;
}

export interface ExtSlotContractMap {
  /** 队列面板（去 fork 化 P3）：core → ext 的 live/trash/actions 原语。
   *  契约定义在 lib/composer/queue-api.ts（含下载导出/导入解析单实现）；
   *  扩展 aiti-queue-keeper 经本插槽渲染完整队列 UI。 */
  queuePanel: { props: QueuePanelProps };
  /** CWD picker 下拉底部动作区（session-manager：管理工作区列表）。 */
  workspacePickerActions: { props: WorkspacePickerActionsProps };
}

/** 从契约取插槽 props 类型（未声明 → 宽松对象）。 */
export type ExtSlotProps<S extends ExtSlotName> =
  S extends keyof ExtSlotContractMap
    ? ExtSlotContractMap[S] extends { props: infer P } ? P : Record<string, never>
    : Record<string, unknown>;

/** 扩展现有插槽 props（宿主内置 + 扩展声明合并）。 */
export type ExtSlotPropsWithBuiltIn<S extends ExtSlotName> =
  { currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null } & ExtSlotProps<S>;

/**
 * i18n 类型契约（DSH LocaleNamespaceMap 反哺）：扩展声明自己的 key 表后，
 * ctx.t(key) 的 key 参数可被类型检查。
 *
 *   declare module "pi-web-ext/ext" {
 *     interface LocaleNamespaceMap { "aiti-devtools": { "inspect.start": string } }
 *   }
 */
// 空接口是 module augmentation 合并锚点（DSH LocaleNamespaceMap 同款）。
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LocaleNamespaceMap {}

/**
 * 段落点击接管扩展点（消息点击识别薄宿主）。
 *
 * 扩展（aiti-msg-smart）注册 handler；用户点击消息段落时 core 把段落纯文本 +
 * 上下文 + 锚点 rect 交给每个 handler（可多个，aiti-msg-smart 为主接管者）。
 * 识别/弹层渲染/动作/关闭全在扩展侧；core 只提供：段落可点击 + 点击事件广播 +
 * setInline 挂载点（段落后 in-flow 渲染扩展节点，tr 自动 portal 到 body）。
 */
export interface ParagraphClickInfo {
  /** 段落纯文本（渲染后 textContent；表格行 = 单元格 " | " 连接） */
  text: string;
  /** 会话 cwd（相对路径解析用） */
  cwd?: string;
  /** 消息角色（"user" / "assistant" / undefined） */
  messageRole?: string;
  /** 段落锚点（扩展定位用；view 坐标，扩展可监听 scroll/resize 跟随） */
  rect: { top: number; left: number; bottom: number; width: number };
  /** 段落 DOM 元素（扩展需要更精细定位/选区/滚动跟随时用） */
  element?: HTMLElement;
  /** 段落稳定标识（useId 生成）——扩展 toggle 判断/「同一时刻只开一个」去重用 */
  paragraphId: string;
  /** 段落所在会话/消息（预留；扩展需要时经消息组件透传，core 不保证） */
  sessionId?: string;
  messageId?: string;
  /** 段落内联展开（in-flow 渲染在段落后；tr 自动 portal 到 body + 由扩展给定位）。
   *  注：core 只提供挂载点，不做定位/滚动/关闭管理——都是扩展职责。 */
  setInline(node: ReactNode | null): void;
  /** 关闭本段落的 inline 展开（扩展切段时先调旧段 close） */
  close(): void;
}

/** 段落点击候选标签（core 渲染壳支持的语义块；默认 p/li/tr） */
export type ClickableTag = "p" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/** 段落点击处理器。可附 hint：段落 hover 提示文案（core 渲染 tip 的视觉契约，
 *  文案由扩展提供——如 aiti-msg-smart 的「点击引用回复」；无 hint 则不显示提示）。
 *  tags：声明需要点击的语义块标签（未声明默认 ["p","li","tr"]）——新增场景
 *  （如标题 h1-h6）由扩展声明即生效，无需改 core。 */
export type ParagraphClickHandler = ((info: ParagraphClickInfo) => void) & { hint?: string; tags?: ClickableTag[] };

/** 会话 fork 前置门的入参（发起 fork 时刻的上下文）。position 沿 pi 约定：
 *  "before" = 从该 entry 之前分叉（/fork 语义）；"at" = 克隆含该 entry（/clone）。 */
export interface SessionForkGateInfo {
  /** agent 会话 id（复合 id，与 /api/agent/[id] 一致） */
  sessionId: string;
  /** 会话文件路径（客户端不一定可得，缺省时扩展可经 sessionId 服务端解析） */
  sessionFile?: string;
  /** fork 分叉点 entry id */
  entryId: string;
  position: "before" | "at";
}

/** 会话 fork 前置门（aiti-git-trace 回撤前置门等）：返回 true 放行、false 或抛错取消本次 fork。
 *  注册经 client ctx.registerSessionForkGate（总线在 lib/ext/fork-gates.ts，
 *  消费点 hooks/useAgentSession.handleFork）。 */
export type SessionForkGate = (info: SessionForkGateInfo) => Promise<boolean>;

/** 能力接管声明：扩展声明后 core 隐藏对应的内置 UI/行为，由扩展全权接管。
 *  能力名是 core 与扩展之间的稳定契约（不是扩展 id）——新增能力时在
 *  EXT_PROVIDES 里登记并同步文档（AGENTS.md）。 */
export const EXT_PROVIDES = {
  /** 会话删除：声明后侧栏隐藏内置删除按钮（删除流由扩展接管，如先归档再在归档记录上删除）。 */
  sessionDelete: "session-delete",
  /** 外部 agent 会话源：声明后 session-manager 自动发现本扩展，进程内直调其
   *  api 钩子拉取 agent-source/manifest|list|session 归一化会话数据。 */
  sessionAgentSource: "session-agent-source",
  /** 队列面板：声明后 ChatInput 隐藏兜底 banner，完整队列 UI 由扩展经 queuePanel 插槽渲染。 */
  queuePanel: "queue-panel",
} as const;

export type ExtProvidesName = (typeof EXT_PROVIDES)[keyof typeof EXT_PROVIDES];

export interface ExtUiDefinition {
  toolbar?: ExtUiItem[];
  sidebar?: ExtUiItem[];
  /** 侧栏底部快捷操作行（与内置 模型/技能/插件 同一排）。 */
  sidebarFooter?: ExtUiItem[];
  sessionTopbar?: ExtUiItem[];
  sessionRowActions?: ExtUiItem[];
  dialogs?: ExtUiItem[];
  banners?: ExtUiItem[];
  pages?: ExtUiItem[];
  fileViewer?: ExtUiItem[];   // 文件查看/编辑接管项（核心 FileViewer 跳板渲染；项需带 match 判定才生效）
  pathPicker?: ExtUiItem[];   // 目录选择器能力项（核心顶栏「打开文件夹」跳板渲染；项带 render({path,onSelect})）
  chatInputTop?: ExtUiItem[];
  /** 接管内置能力（见 EXT_PROVIDES）：如 ["session-delete"] 让 core 隐藏侧栏内置删除按钮。 */
  provides?: string[];
  /** client bundle 依赖的其他扩展 id（启动图 inject 边：并行预取/加载顺序提示，
   *  informational——加载正确性不依赖它，仅影响预取调度与 HMR 差集展示）。 */
  clientDependsOn?: string[];
  /** 懒加载声明：false 时该扩展的 client bundle 不在启动阶段 materialize——
   *  首次渲染到它声明的 UI 插槽时才拉取并注册（按需加载，DSH immediately 反哺）。 */
  clientImmediately?: boolean;
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
  /** 短图标/emoji（如 "🧰"）或相对扩展目录的图标文件路径（如 "icon.svg"，lucide 线条风格），可选。 */
  icon?: string;
  /** 功能管理声明：扩展开放的、可被用户启用/禁用的功能清单（见 ExtFeature）。 */
  features?: ExtFeature[];
  /**
   * 冲突插件声明：列出与本扩展功能冲突、必须禁用的第三方扩展/包标识。
   * 平台组装 SDK 扩展加载结果时，将 source 包名或路径 scoped 包名命中标识的
   * 扩展整个移除（不初始化）。标识用 npm 包名（如 "pi-subagents"，scoped 写全
   * "@scope/name"）。声明者自身在 pi-web 扩展体系，与 SDK 加载结果天然隔离。
   */
  conflicts?: string[];
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
  /** 功能状态（extman 管理）：host 客户端加载时一并取，扩展只读共享 store，无独立请求。 */
  features?: { id: string; type?: "boolean" | "string"; label?: string; placeholder?: string; enabled: boolean; value?: string }[] | null;
}
