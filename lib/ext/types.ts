/**
 * pi-web extension framework — shared contract types.
 *
 * Extensions live in ~/.pi/web/extensions/<id>/ (PI_WEB_EXTENSIONS_DIR
 * overrides). Each exports a default object matching {@link PiWebExtension}.
 * Runtime data goes to ~/.pi/web/data/<id>/ (PI_WEB_DATA_DIR overrides) so
 * code and data never mix.
 *
 * Design aligns with the service-tunnels extension integration (pending-design
 * items for generic slots, core data contract, data dir convention).
 */
import type { ReactNode } from "react";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueuePanelProps } from "@/lib/composer/queue-api";
import type { CtxUrgency } from "@/lib/context-urgency";

/**
 * Extension feature declaration (feature management): an extension can declare the
 * capability points it exposes (e.g. tools injected into agent sessions, optional
 * behavior toggles) as manageable features. Users enable/disable them one by one in
 * the extension manager; state persists in <dataRoot>/features.json (read/written
 * solely by the core registry).
 *
 * Tool-level feature convention: when feature.id = "tool.<injected tool name>"
 * (e.g. the in-page devtools extension's aiti_page_exec → "tool.aiti_page_exec"),
 * the core filters disabled tools automatically during collectAgentTools injection
 * and re-checks on execute (rejected immediately once disabled, existing sessions
 * included). Other prefixes (e.g. "behavior.xxx") are queried by the extension
 * itself via featureEnabled to decide behavior.
 */
export interface ExtFeature {
  /** Unique feature id (unique within the extension). Tool-level = "tool.<toolName>". */
  id: string;
  /** Display name (shown in the extension manager UI). */
  label: string;
  /** Description (optional). */
  description?: string;
  /** Group (optional, e.g. "page actions" / "user interaction"; the extension manager groups by it). */
  group?: string;
  /** Value type ("boolean" default = on/off toggle; "string" = text setting, rendered as an input box in the
   *  extension manager; "textlist" = multi-line text, one entry per line (e.g. a list of env vars), rendered as
   *  a multi-line editor with the same value semantics as string). */
  type?: "boolean" | "string" | "textlist";
  /** Default enabled state (boolean type; defaults to true; false = off by default, the user can turn it on). */
  default?: boolean;
  /** Default value (string type; defaults to ""). */
  value?: string;
  /** Input placeholder hint (string type, optional). */
  placeholder?: string;
  /** App-center category tag (consumed by the app-center extension, optional; falls back to the extension-level category, then "other"). */
  category?: string;
}

/** Feature entry in the status API = declaration + current effective state. */
export interface ExtStatusFeature extends ExtFeature {
  /** Effective state (boolean type: explicit user setting wins, otherwise default; string type is always true). */
  enabled: boolean;
  /** Current value (string type: explicit user setting wins, otherwise the declared value; absent for boolean type). */
  value?: string;
}

/**
 * Session backend registration slot: extensions register a SessionProvider in
 * server.startup to plug custom agent backends into the host's multi-agent
 * frontend. The registration key is automatically prefixed with the extension id
 * ("<extId>/<type>") so it can never shadow built-in providers or other
 * extensions; entries are unregistered automatically on extension shutdown/reload.
 *
 * Type contracts live in lib/session/types.ts (SessionHandle /
 * SessionCapabilities) — fail loud: declare unsupported capabilities as false
 * and throw UnsupportedCapabilityError from the method.
 */
export interface ExtSessionProviderRegistration {
  /** Provider short name (no prefix; must not contain "/"). Final key = "<extId>/<type>". */
  type: string;
  /** UI display name (the new-session provider picker). */
  label: string;
  /** Capability ceiling declaration (fail-loud contract; the UI shows/hides controls based on it). */
  maxCapabilities: import("../session/types.ts").SessionCapabilities;
  /** Static model catalog (fetchable without a session; feeds the picker when choosing a backend on the new-session page). Optional; falls back to the local catalog. */
  listModels?(): Promise<Array<{ id: string; provider: string; label?: string }>>;
  /** Manual model catalog refresh (force probe bypassing the cache; data source for the "refresh model list" button on the new-session page). Optional; the button is hidden when absent. */
  refreshModels?(): Promise<Array<{ id: string; provider: string; label?: string }>>;
  createSession(options: {
    sessionFile?: string;
    cwd?: string;
    socketPath?: string;
    env?: Record<string, string>;
    /** Extra options the extension may freely add (passed through; the host does not interpret them). */
    [key: string]: unknown;
  }): Promise<import("../session/types.ts").SessionHandle>;
  shutdown?(): Promise<void>;
}

/**
 * Session annotation slot: extensions attach their own fields to session list
 * rows (e.g. an occupancy marker). Data ownership stays with the extension —
 * the core knows nothing about specific formats (e.g. a bridge registry file).
 * Return a partial field mapping keyed by row id or path; the core merges it
 * into the response.
 */
export interface ExtSessionAnnotatorSlot {
  /**
   * Register the annotator. rows is a lightweight projection of the current
   * session list rows; return Record<rowKey, Partial<fields>> (rowKey matches
   * the row's id or path).
   */
  register(annotator: {
    annotate(rows: Array<{ id: string; path?: string; cwd?: string }>): Promise<Record<string, Record<string, unknown>> | void>;
  }): void;
}

export interface ExtSessionProviderSlot {
  /** Returns the full registry key ("<extId>/<type>") after registration; callers use it as providerType. */
  register(provider: ExtSessionProviderRegistration): string;
  /** Unregister a provider by full key (hot removal, no reload needed). */
  remove(type: string): boolean;
  /** Whether a backend exists that can drive this external agent (all-sessions agentKey, e.g. "claude"). */
  canOpen(agentKey: string): boolean;
  /**
   * Open an external history session as a live session (attach-from-history).
   * On success returns { ok: true, sessionId } (sessionId is the composite id,
   * directly usable with /api/agent/[id]); with no driving backend returns
   * { ok: false, reason: "no_provider" }.
   */
  open(
    compositeId: string,
    options?: { cwd?: string; /** Display name for the placeholder file (pass the real title when All Sessions takes over) */ name?: string },
  ): Promise<{ ok: true; sessionId: string } | { ok: false; reason: "no_provider" | "open_failed"; error?: string }>;
}

/**
 * Resolution result of a dependency declaration entry (registry status output;
 * the extension manager's detail view/warnings consume it directly rather than
 * re-implementing the resolver — single source of truth in the core; older hosts
 * without this field degrade to not rendering it). Resolution rule (dependency &
 * capability model §5.1): an element first matches an extension id exactly (id
 * wins), otherwise it resolves by capability name.
 */
export interface ExtDepResolution {
  /** Original declared element (extension id or capability name). */
  name: string;
  /** Matched by id (including existence while disabled/load-failed) → "ext"; otherwise resolved by capability → "cap". */
  kind: "ext" | "cap";
  /** Hard dependency (dependsOn) = true; optional dependency (optionalDependsOn) = false. */
  hard: boolean;
  /** kind="ext" → target extension id; kind="cap" → effective provider id (absent when missing). */
  target?: string;
  /** ok = in effect (target extension loaded / capability has an effective provider); inactive = target extension exists but is disabled or failed to load; missing = extension does not exist and no capability provider. */
  status: "ok" | "inactive" | "missing";
  /** The effective provider is user-pinned (cap edge only). */
  viaPin?: boolean;
  /** kind="cap": full set of capability providers (id list; >1 with multiple implementations). */
  providers?: string[];
}

/** Core data capabilities handed to extensions — no reimplementation of session access. */
export interface ExtCoreApi {
  /** Optional refresh: force a rescan bypassing the 5s list-scan cache (when a session was just written to disk, right after archiving, etc. — anywhere the effect must be immediate). */
  listSessions(options?: { refresh?: boolean }): Promise<unknown[]>;
  getRunningSessionIds(): Promise<string[]>;
  /** Attached (alive, possibly idle) rpc session ids — disk-write guards must include these. */
  getAliveSessionIds(): Promise<string[]>;
  /** Actively release an alive-but-idle rpc session (clear the handle before touching disk on
   *  explicit user archive/delete). Running sessions are untouched (returns "running"); externally
   *  held ones such as a TUI bridge return "missing".
   *  Absent = older core without this capability (the extension keeps its original guard / asks
   *  the user to close it). */
  stopAliveSession?(id: string): Promise<"stopped" | "running" | "not-alive" | "missing" | "still-alive">;
  getHomeDir(): Promise<string>;
  /** Full session context (messages + entry ids) for a session id; null when missing. */
  readSession(id: string): Promise<unknown | null>;
  /** Read the current models.json ({providers:{...}}). Extensions never hand-edit the file — go through this API uniformly (cache invalidation included). */
  readModelsConfig(): Promise<Record<string, unknown>>;
  /** Write models.json (normalized + invalidateModelsCache invalidation; changes take effect immediately). */
  writeModelsConfig(data: Record<string, unknown>): Promise<void>;
  /** A03/B4: rebind a backend session id (backends whose process generates the id, e.g. omp —
   *  once the real id is read back, attach it to the handle as an alias key; the old placeholder
   *  key is kept so draft rows / existing references keep working). Returns false when newId is
   *  already taken or oldId is unusable (idempotent-safe). */
  rebindSessionBackend?(oldId: string, newId: string): boolean;
  /** File-access helpers bound to pi-web's allowed-roots security (session cwds etc.). */
  fileAccess: {
    allowRoot(root: string): void;
    isAllowed(p: string): Promise<boolean>;
  };
}

/**
 * ctx.services service locator (dependency-injection plan §4-A, decided 2026-09-06 —
 * a simple locator, no topological sort / PENDING states). The only sanctioned path for
 * cross-extension server-side calls; key contract "<extId>.<name>" (core-provided
 * services use the "core." prefix), with the core validating the prefix to prevent
 * impersonation. Spec and red lines: the host's ext-services authoring guide.
 */
export interface ExtServicesSlot {
  /** Provide a service. The key is forced to carry this extension's "<extId>." prefix (otherwise throws). Returns a disposer (the core unwinds it automatically on extension shutdown/reload). */
  provide<T>(key: string, impl: T): () => void;
  /** Soft dependency: returns undefined when absent (keeps the graceful-degradation philosophy). Design service objects as lazy getters so hot reload/reinstall never leaves them dangling. */
  get<T>(key: string): T | undefined;
  /** Hard dependency: waits for provide (event-driven, no polling) and rejects on timeout. Use to guarantee readiness during startup. */
  require<T>(key: string, timeoutMs?: number): Promise<T>;
  /** Subscribe to service up/down (fired when a provider provides/revokes; replaces hand-written "self-healing resubscribe" loops). */
  onChange(cb: (key: string, phase: "up" | "down") => void): () => void;
}

/** ctx.features: single entry point for feature state read/write (replaces direct __piWebExt.featureValue/setFeatureFlag calls). */
export interface ExtFeaturesSlot {
  /**
   * Read the current effective value of a feature: get(fid) reads this extension;
   * get(extId, fid) reads a given extension. boolean type returns on/off, string
   * type returns the value; unknown/undeclared features follow the "not explicitly
   * set" semantics and return the declared default (boolean defaults to true).
   */
  get(extIdOrFeatureId?: string, featureId?: string): boolean | string | undefined;
  /** Subscribe to feature state changes (any extension; fired after extension-manager edits). Returns an unsubscribe function; invalidated with ctx on extension shutdown. */
  on(cb: () => void): () => void;
}

/** Server context passed to startup/shutdown/api hooks. */
export interface ExtServerContext {
  id: string;
  /** Absolute path of the extension code directory (read-only for assets). */
  dir: string;
  /** Config area (root of ~/.pi/web/data/<id>/): only configuration and critical small state
   *  (covered by the config-backup extension). Data is split into three tiers (config/state/cache),
   *  a breaking change: ctx.dataDir has been removed (accessing it on ctx throws). */
  configDir: string;
  /** Persistent data area (~/.pi/web/data/<id>/state/): data that cannot be regenerated
   *  (archives/history/statistics/databases/user-created artifacts); never assume it may be lost
   *  (unreadable = abnormal) and do not auto-clean (retention policy belongs to the extension). */
  stateDir: string;
  /** Cache area (~/.pi/web/data/<id>/cache/): always safe to delete (the extension rebuilds it automatically on next access after rm -rf); db/venv/logs/large files. */
  cacheDir: string;
  core: ExtCoreApi;
  /** Cross-extension service locator (dependency-injection plan §4-A): provide/get/require/onChange. */
  services: ExtServicesSlot;
  /** Feature state read/write entry point (§4-A): get/on. */
  features: ExtFeaturesSlot;
  /** Session backend registration slot (multi-agent frontend): extensions register custom SessionProviders through it. */
  sessionProviders: ExtSessionProviderSlot;
  /** Session annotation slot: extensions attach their own markers to the session list (e.g. TUI-bridge occupancy). */
  sessionAnnotations: ExtSessionAnnotatorSlot;
  /** Generic AI invocation (the core's lowest-level model capability): any system+messages → { text, usage };
   *  the core adds zero business logic and zero statistics. Prompt assembly / context / project state /
   *  token accounting are entirely the calling extension's responsibility. */
  invokeAI?: (params: {
    provider?: string; modelId?: string; system?: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number; temperature?: number; reasoning?: string;
    /** Accounting dimension: extensions may break scenarios down (e.g. "myext-input/complete"); defaults to ext.id */
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
 * Per-agent-session extension point (plan M): extensions inject tools/callbacks
 * in-process into every agent session with zero configuration. Tools go in via the
 * SDK `createAgentSessionFromServices` `customTools`; the session lifecycle
 * (start/end/settle) is delivered through rpc-manager callbacks. Best suited to
 * "bridge and agent in the same process" setups (e.g. the in-page devtools extension).
 */
export interface AgentSessionInfo {
  sessionId: string;
  cwd: string;
  /** Inject a user message into the session (steer: takes effect after the current turn completes, as if the user had said it). */
  steer(text: string): Promise<void>;
  /**
   * Subscribe to this session's full agent event stream (in-process direct feed,
   * bypassing the SSE egress filter — the agent events route drops
   * tool_execution_update, which carries bash's live scrolling output; extensions
   * get it verbatim through this). Returns an unsubscribe function.
   */
  subscribeEvent?(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
  /** Abort the bash command currently running in this session (does not abort the whole turn — the agent continues after receiving the error result). */
  abortBash?(): void;
  /** The model this session is currently using (reflects model switches in real time; for runtime monitoring/attribution). */
  getModel?(): { provider: string; modelId: string } | null;
}

/** Why the wrapper an extension sees was destroyed (mirrors AgentWrapperEndReason):
 *  "shutdown" = the session truly ended (delete route/global cleanup); "fork" = the
 *  wrapper was swapped after a fork (the original session file still exists); "idle" =
 *  10-minute idle GC (file still exists, wrapper rebuilt on next access). Extensions
 *  should use this to distinguish "session gone" from "wrapper reclaimed"; callbacks
 *  must be idempotent (the same id may receive onAgentSession again after idle GC →
 *  rebuild). */
export type ExtAgentEndReason = "shutdown" | "fork" | "idle";

export interface ExtAgentHooks {
  /** Custom tools injected into every agent session (SDK ToolDefinition[]; tool execute closures call in-process resources directly). */
  agentTools?(info: Pick<AgentSessionInfo, "sessionId" | "cwd">): ToolDefinition[];
  /** Session started (after wrapper creation; register agent identity / bind push sinks here).
   *  ⚠️ **May be invoked repeatedly**: the same id fires again after idle GC → wrapper rebuild,
   *  and after extension hot reload (the host re-attaches surviving sessions after registry
   *  reload). Implementations must be idempotent: overwrite handles/entries, and for
   *  subscribeEvent unsubscribe the old before subscribing the new (the host also reclaims the
   *  previous round of subscriptions **established via `info.subscribeEvent`** before
   *  re-attaching — see the subscription-epoch ledger in ExtRegistryImpl.dispatchAgentSession:
   *  subscriptions made through it are not double-delivered even if the extension never
   *  unsubscribes; subscriptions that bypass it and attach to the wrapper's `onEvent` directly
   *  are not in the ledger and must be unsubscribed by the extension). */
  onAgentSession?(info: AgentSessionInfo): void;
  /** Session wrapper destroyed. Note: this is not the same as "the session file was deleted" —
   *  a fork swapping the wrapper or idle GC reclamation also triggers it; use reason to tell
   *  them apart. Callbacks must be idempotent. */
  onAgentSessionEnd?(info: { sessionId: string; reason?: ExtAgentEndReason }): void;
  /** An agent turn finished (agent_settled) — e.g. forward the final answer back to the bridge or echo it in the UI. */
  onAgentSettled?(info: { sessionId: string; text: string }): void;
}

/** Static metadata for UI items; the actual React components come from the client bundle. */
export interface ExtUiItem {
  id: string;
  label?: string;
  title?: string;
  /** slot-specific placement hints (e.g. sidebar badge) */
  badge?: boolean;
  /** The menu already carries full content (e.g. a search input); the host adds no text label */
  noMenuLabel?: boolean;
  /**
   * Declarative icon (toolbar slot; the host renders it in the standard grayscale line style —
   * looks are normalized by the host to stop per-extension drawing drift):
   * - { svg }: inner SVG markup string with a 24×24 viewBox (lucide line style, stroke=currentColor,
   *   e.g. `<path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/>`)
   * - emoji string (e.g. "📥")
   * - relative path to an .svg file inside the extension (e.g. "icon.svg"; rendered via CSS-mask,
   *   color follows currentColor)
   */
  icon?: ExtUiItemIcon;
  /** [Lazy-load v2] The boolean feature id gating this "static item" (same semantics as item.feature on
   *  registered items). Off → the host does not render the static item; after materialization the registered
   *  item's own feature takes over gating. Only meaningful for two-phase lazy items (manifest ui[slot][]
   *  declaration + client-registered onClick). */
  feature?: string;
}

/** Declarative icon for toolbar items (see ExtUiItem.icon). */
export type ExtUiItemIcon = string | { svg: string };

/**
 * [Lazy-load v2] The UI slot entry set renderable statically from the manifest
 * (ExtUiDefinition minus behavior/declarative fields) — the host renders a "zero-bundle
 * entry" from it before the client bundle materializes. The manifest's ui field serializes
 * this structure in full (registry.ts `ui: e.ext.ui ?? null`); the client's
 * registerStaticItems collects per slot, with zero server-side changes.
 */
export type ExtUiStaticSlots = Omit<
  ExtUiDefinition,
  "provides" | "i18n" | "clientDependsOn" | "clientImmediately" | "clientLazyVia"
>;

export type ExtSlotName =
  | "toolbar"
  | "sidebar"
  | "sidebarFooter"  // Sidebar bottom quick-action row (models/skills/plugins on one line; the extension manager's entry point)
  | "sessionTopbar"
  | "sessionRowActions"
  | "sessionRowLeading"
  | "sessionRowMeta"  // Per-session-row meta (end of the second line holding the spinner/message count): e.g. the plan-tracking extension's plan badge + tags
  | "sidebarProjects" // Full takeover of the left "Projects" session list (session-manager SidebarClone; the dock plan's project-area form)
  | "sidebarContent" // Full takeover of the left sidebar (AppShell layer: Header + DockStack block stack + bottom row; unified sidebar
                     //   dock plan §3.2 — the session-manager SidebarContentDock self-orchestrates, the host ships no dock container;
                     //   without items the host's original sidebar falls back)
  | "dialogs"
  | "banners"
  | "pages"
  | "chatInputTop"   // Above the chat input (the in-page devtools extension: inspect candidate area, etc.)
  | "chatOverlay"    // Overlay above the message area (message scroll navigator etc.; the message-navigation extension
                     //   renders an absolute floating toolbar to the right of the message column)
  | "userMessageActions" // Hover action area under user messages (the prompt-library extension: 📌 save as prompt, etc.)
  | "assistantMessageActions" // Hover action area under assistant messages (the read-aloud extension: 🔊 read this aloud / ⏹ stop reading)
  | "assistantMessageFooter" // End of the assistant message content area (after the "changed files" chips; the git-trace extension:
                    //   lines for changed files captured by trace outside the write/edit accounting. The turn's final-answer
                    //   render point receives the whole turn's assistantEntryIds + writtenFiles from ChatWindow;
                    //   contract = AssistantMessageFooterSlotProps)
  | "fileViewer"     // File view/edit takeover (the file-editor extension: text file editing; the folder-browser extension: folder browsing; without takeover the core's original viewer is the fallback)
  | "pathPicker"    // Directory-picker capability (the folder-browser extension, same as its FolderSwitcher; consumed by the top bar's "open folder" etc.)
  | "newSessionBackendOptions" // Extension entries inside the new-session welcome page's Backend dropdown (one <option> per item;
                     //   selecting runs meta.onClick, e.g. the ACP agent management entry — no more buttons rendered outside the
                     //   picker. Declarative static items are materialized by the host forwarder before the callback fires)
  | "sessionStats"   // Extension entry rows inside the session-stats dropdown (the usage-report extension: report entry; the token-usage extension: other auxiliary AI usage stat rows)
  | "composerTools"  // Control row under the input box (compact/stop/import-queue on the same row; the git-trace extension: timeline main entry, etc.)
  | "queuePanel"    // Queue panel slot (de-fork P3: the queue-manager extension takes over the full queue UI;
                    //   without takeover the core renders a fallback banner — see the queue-cluster extension plan)
  | "workspacePickerActions" // Action area at the bottom of the CWD picker dropdown (session-manager: manage the workspace list —
                    //   select/hide/delete; the core only renders the dropdown list, all management UI lives in the extension)
  | "modelSelector"  // Chat input model button takeover (e.g. the model-wizard extension): once registered it replaces the native
                      //   ModelSelector; unregistered, the core's native dropdown is the fallback (same springboard pattern as fileViewer)
  | "modelSelectorFooter" // Action area at the bottom of the model-selector dropdown (the model-wizard extension: manage-models
                      //   entry — opens the model wizard; the core only renders the slot, all management UI lives in the
                      //   extension, unregistered = zero render and zero regression. Same pattern as workspacePickerActions;
                      //   rendered inside the shared component so every ModelSelector instance (toolbar / ⓘ sheet /
                      //   AgentsConfig) consistently carries this entry)
  | "settingsModels" // Settings panel "Models" tab takeover (e.g. the model-wizard extension): once registered it replaces the
                      //   native ModelsConfig; unregistered, the core's native two-pane is the fallback
  | "settingsAgentsFeature" // Feature block at the top of the settings Agents page (the subagents extension: the pi-subagents engine
                      //   banner + "open the subagent fleet" entry); unregistered, the core's native "built-in subagents" toggle
                      //   area is the fallback
  | "settingsAgents"  // Full-page takeover of the settings "Subagents" tab (the subagents extension): once registered it replaces
                      //   the native AgentsConfig; unregistered, the core's native two-pane is the fallback (same springboard
                      //   pattern as settingsModels)
  | "terminalDock" // Workspace terminal tab content takeover (the terminal extension: true takeover of the right file area's
                      //   terminal tab — the extension's terminal view renders directly inside the tab; a terminal-specific early
                      //   slice of the floating-dock plan: tab⇄dialog single-instance toggle, placeholder both ways); unregistered,
                      //   the core's guide page is the fallback
  | "sidebarExplorerDock" // Floating-dock extension v0.5.0: vertical dock area below the sidebar file area (host DockSection
                      //   collapsed header + multiple items stacked vertically; the whole block is not rendered with no items.
                      //   Float plan §4.2)
  | "rightFileDock"   // Floating-dock extension v0.5.0: right-column dock area — each item derives a TabBar tab (id
                      //   "dock:<extId>:<itemId>", activation reuses activeFileTabId; mutually exclusive tab switching with
                      //   file/terminal tabs. Float plan §4.3)
  | "sidebarTasks"    // Floating-dock extension v0.5.1: left sidebar "Tasks" area (between the session list and the file area;
                      //   host collapsed header, the whole block is not rendered with no items; hosts the subagents extension's
                      //   subagent tasks. Float plan §4.4.2)
  | "composerAffix" // Affix position on the right edge inside the input box (mobile WeChat-style 🎤; rendered only on the mobile
                    //   input row. The core's own × clear and extension registrations are naturally mutually exclusive, derived
                    //   from "empty/non-empty" — see the mobile WeChat-style input plan §3.2)
  | "modelInfoLead" // Mobile model-info leading position (the context-meter extension's context ratio bar): rendered in two
                    //   places — before the ModelSelector in the expanded input row and before the ModelSelector in the ⓘ
                    //   InfoSheet model row; not rendered in the desktop ModelSelector.
                    //   Contract = ModelInfoLeadSlotProps (context-meter plan §4.2)
  | "compactLead"   // Desktop position left of the compact button (the context-meter extension's context ratio bar; moved here
                    //   from the composerTools row tail in v0.1.2). Contract reuses ModelInfoLeadSlotProps (isMobile always
                    //   absent); desktop-only render, zero footprint when no extension registers
  | "sessionRequestCard" // Session request card (agent-capability UI de-coring; agent-capability-UI extension plan §2.1):
                    //   the takeover seam for the three "request-answer" floating-card families — interaction primitives /
                    //   tool authorization / captcha. The host routes by request.kind + registered meta.kinds/backend to a
                    //   single item; misses fall to the core's minimal fallback card (a capability never runs bare).
  | "newSessionSelectors" // Extension pickers between Workspace×Backend on the new-session welcome page (branch/worktree picker
                    //   etc.). extra carries data only { cwd, isMobile } (slot-extra data-only red line); all write operations
                    //   go uniformly through the newSessionPreparers send-time pipeline (branch/worktree plan §3)
  | "newSessionPreparers" // Pre-creation preparer pipeline for new sessions (registration surface, no rendering): items
                    //   meta.prepare({cwd}) => { cwd? } rewrites the target directory / { abort } aborts creation —
                    //   ensureNewSession awaits them in order before the POST; errors go through the existing throw→notice
                    //   channel, drafts are kept by the draft-keeper (same plan §3)
  | "newSessionWidgets" // Top/bottom widget area of the new-session welcome page (mobile/desktop widget semantics): one
                    //   registration surface, two render points (top/bottom); the registration meta declares allowed areas
                    //   (NewSessionWidgetMeta.areas) and grid size (w 1-8 / h 1-3; 4 columns mobile / 8 columns desktop) —
                    //   users can reorder/move across areas/show-hide in the "customize widgets" panel.
                    //   extra carries data only { cwd, isMobile, area } (slot-extra red line); actions go through services
                    //   (e.g. pi-web.session.open). See the new-session widgets plan.
  ;

/**
 * UI slot type contracts (DSH SlotMap feedback; dsh-adapter-assessment §5.2).
 *
 * Extensions (TS-authored client bundles) declare the extra prop types of the
 * slots they use/provide via module augmentation:
 *
 *   // extension side (.ts file in the client bundle)
 *   declare module "pi-web-ext/ext" {
 *     interface ExtSlotContractMap {
 *       chatInputTop: { props: { inputValue: string } }
 *     }
 *   }
 *
 * On the host side, ExtSlot's props type is looked up from the contract by slot
 * name; undeclared slots degrade to a loose Record<string, unknown> (backwards
 * compatible). The contract is "type-level documentation": no runtime effect;
 * load correctness is still guaranteed by the loader.
 */
// The empty interface is the merge anchor for module augmentation
// (declare module "pi-web-ext/ext") — same design as the DSH SlotMap; there must be a mergeable
// empty type. Slot contracts already declared by the host (e.g. queuePanel) merge in directly,
// and extensions add more via augmentation; both sides consume by structural contract
// (extensions live out of repo — see the queue extension's client types).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
/** workspacePickerActions slot props (action area at the bottom of the CWD picker dropdown). */
export interface WorkspacePickerActionsProps {
  /** Currently visible project list (already filtered by the hidden list; key = stable workspace key, root = display path). */
  projects: { key: string; root: string }[];
  /** Full project list (unfiltered for hidden — the management dialog must list all projects including hidden ones). */
  allProjects: { key: string; root: string }[];
  /** Currently selected cwd (null when nothing is selected). */
  selectedCwd: string | null;
  /** Set of currently hidden workspace roots. */
  hiddenWorkspaces: ReadonlySet<string>;
  /** Select a project (switch to that project's cwd; used by the management dialog's "select"). */
  onSelect: (root: string) => void;
  /** Close the dropdown (call before opening the management dialog). */
  onClose: () => void;
}

/** modelSelector slot props (chat input model button takeover): the takeover component receives the same model
 *  list / selection state / switch callback as the native ModelSelector, and can render "open the model wizard"
 *  plus a guaranteed quick-switch as needed. */
export interface ModelSelectorSlotProps {
  /** Current session (null on the new-session composer; cwd may still be an empty string — data not having arrived never blocks the first frame). */
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  model: { provider: string; modelId: string } | null;
  options: { provider: string; modelId: string; name: string }[];
  /** Switch the current session's model (native semantics, guaranteed baseline — the takeover component must keep an entry point so no capability is lost). */
  onChange: (provider: string, modelId: string) => void;
  busy: boolean;
  pending: boolean;
  isAutoSelection: boolean;
  /** Manual model catalog refresh (present on the new-session page when the backend supports refreshModels; the takeover component should forward it to its refresh entry). */
  onRefresh?: () => void;
  /** Refresh in progress (the takeover component disables selection interactions accordingly). */
  refreshing?: boolean;
}

/** modelSelectorFooter slot props (action area at the bottom of the model-selector dropdown): the extension renders the whole
 *  action row (e.g. the model-wizard extension's "manage models"). The host only delivers the collapse callback —
 *  before opening its own overlay such as the wizard, the extension calls onClose to collapse the dropdown,
 *  avoiding two stacked overlays. */
export interface ModelSelectorFooterSlotProps {
  /** Collapse the model dropdown and clear its filter (call before opening the extension's own overlay). */
  onClose: () => void;
}

/** settingsModels slot props (settings "Models" tab takeover). */
export interface SettingsModelsSlotProps {
  /** Current session (the settings panel is instance-level, not session-level; the host always passes null — same shape as ExtRenderProps, reserved for extensions). */
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  onClose: () => void;
}

/** settingsAgentsFeature slot props (takeover of the feature block at the top of the settings Agents page). */
export interface SettingsAgentsFeatureSlotProps {
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  /** Current working directory (the Agents page's instance-level cwd). */
  cwd: string;
  /** Current session (null when new/none selected). */
  sessionId: string | null;
}

/** settingsAgents slot props (full-page takeover of the settings "Subagents" tab). */
export interface SettingsAgentsSlotProps {
  /** Current session (the settings panel is instance-level, not session-level; the host always passes null — same shape as ExtRenderProps, reserved for extensions). */
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  /** Current working directory (the Agents page's instance-level cwd; the extension may show/filter project-level definitions by it). */
  cwd: string;
  /** Current session (null when new/none selected). */
  sessionId: string | null;
  /** Close the settings panel (the extension decides whether to offer a close entry). */
  onClose: () => void;
}

/** terminalDock slot props (workspace terminal tab content takeover). */
export interface TerminalDockSlotProps {
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  /** Tab working directory (the shell starts here). */
  cwd: string;
  /** Tab id (terminalTabs' 32-char hex; ownership state-machine key — the same tabId multiplexes the same shell). */
  tabId: string;
  /** Whether the tab is active (right column expanded and it is the current tab). When inactive the extension may pause rendering (TabBar keeps it mounted via hidden). */
  active: boolean;
  /** Tab restored from sessionStorage (original semantics: restoring does not silently start a shell; the extension offers a "take over" button). */
  restored: boolean;
  /** Tab close finalization (TabBar removes the tab on ✕/restart; the extension should release the ownership record for that tabId). */
  onClosed: () => void;
  /** New shell tab (the extension's "＋ new": force a new tab for the same cwd instead of reusing; when absent the extension hides the entry). */
  openShellTab?: (cwd: string) => void;
}

/** Context snapshot (context-meter seam): the extra.context shared by composerTools / modelInfoLead.
 *  urgency carries the full contextUrgency(percent) result (lib/context-urgency.ts is the single color-scale source). */
export interface ExtContextSnapshot {
  percent: number | null;
  contextWindow: number | null;
  tokens: number | null;
  urgency: CtxUrgency;
}

/** Compaction three-state seam (the streamingActions compaction subset of the ChatInput open-extension plan §3.1;
 *  names = the host ChatInput's existing props, not the proposal draft names onAbort/onCancelCompact).
 *  Field mapping when the proposal lands: onAbort→onAbortCompaction, onCancelCompact→onCancelCompactQueue. */
export interface ExtCompactControls {
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  onCancelCompactQueue?: () => void;
  isCompacting?: boolean;
  compactQueued?: boolean;
}

/** Model-info leading position / left of the compact button (the context-meter extension; the desktop composerTools extra is its superset). */
export interface ModelInfoLeadSlotProps {
  sessionId?: string | null;
  cwd?: string | null;
  /** null = no context data (external backend / idle session) → the extension renders a gray state. */
  context: ExtContextSnapshot | null;
  compact: ExtCompactControls;
  /** Open the session stats panel (AppShell openSessionStatsPanel; the InfoSheet render point already wraps "collapse the
   *  sheet first"). Now service-ized (slot-extra callback decoupling, 2026-09-16): the host extra no longer feeds it;
   *  consumers fall back to the "pi-web.composer" service (rp first); the field remains for older hosts / explicit
   *  pass-through compatibility. */
  openSessionInfo?: () => void;
  isMobile?: boolean;
}

/** Interactive question (the sessionRequestCard ask_user shape; same shape as the original core card component). */
export interface SessionRequestQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** Session request payload (sessionRequestCard slot; a unified view over the three protocol event families).
 *  kind is the routing key: `interaction:plan_approval` / `interaction:ask_user` / `interaction:open_url` /
 *  `interaction:generic` / `permission` / `provider_headers` (backend adapters can add kinds without touching the
 *  core — extensions claim by kinds; misses fall to the host's fallback card). */
export interface SessionRequestPayload {
  requestId: string;
  kind: string;
  /** Protocol event family (respond dispatch key). */
  family: "interaction" | "permission" | "provider_headers";
  /** Source capability name (metadata: respondInteraction / respondPermission / respondProviderHeaders). */
  capability: string;
  toolName?: string;
  prompt?: string;
  /** interaction:plan_approval: the full plan as markdown. */
  plan?: string;
  /** interaction:open_url: the full login/authorization URL. */
  url?: string;
  /** interaction:open_url: the local short URL (prefer copying this). */
  launchUrl?: string;
  questions?: SessionRequestQuestion[];
  input?: unknown;
  /** permission family: the host's option table (ACP optionId/kind/name; without it the extension draws its own Allow/Deny). */
  options?: Array<{ optionId?: string; kind?: string; name?: string }>;
  /** provider_headers family: the captcha init triple + the request reason. */
  captchaConfig?: { sceneId: string; prefix: string; region: string };
  providerId?: string;
  modelRef?: string;
  reason?: "model-request" | "captcha-retry";
}

/** Unified answer input (sessionRequestCard.respond; the core dispatches to the matching protocol command by request.family). */
export interface SessionRequestAnswer {
  action: "accept" | "decline";
  /** interaction:ask_user: per-question selection (single label / set of labels for multi-select, keyed by question text). */
  answers?: Record<string, string | string[]>;
  /** Additional note (interaction: plan feedback / ask_user note → annotations.notes). */
  message?: string;
  /** permission family: the host option id ("always allow" and similar protocol semantics). */
  optionId?: string;
  /** provider_headers family: the captcha verification param sent back. */
  captchaVerifyParam?: string;
  /** provider_headers family: the captcha verification region sent back (→ x-aliyun-captcha-verify-region). */
  region?: string;
  /** provider_headers family: failure reason. */
  error?: string;
}

/** sessionRequestCard slot props (the session request card takeover seam). */
export interface SessionRequestCardSlotProps {
  currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null;
  request: SessionRequestPayload;
  respond: (answer: SessionRequestAnswer) => Promise<boolean>;
  /** Session backend source (zcode/cursor/…; matched against the registered meta.backend; undefined = local session). */
  backendSource?: string;
}

/** newSessionSelectors slot props (extension picker row between Workspace×Backend on the new-session welcome page).
 *  extra carries data only: selection side effects always run through the newSessionPreparers registration surface
 *  when the first message is sent. */
export interface NewSessionSelectorSlotProps {
  /** New-session target cwd (AppShell targetNewSessionCwd; null = undecided, the extension does not render). */
  cwd: string | null;
  isMobile: boolean;
}

/** newSessionWidgets slot props — extra carries data only (slot-extra red line): widgets render from the data,
 *  actions always go through services (e.g. `pi-web.session.open(id)` / `ctx.openFile`), never embedded callbacks. */
export interface NewSessionWidgetSlotProps {
  /** New-session target cwd (AppShell targetNewSessionCwd; null = undecided, the extension degrades on its own). */
  cwd: string | null;
  isMobile: boolean;
  /** The area actually rendered this time (the user can move the same widget across areas in the panel). */
  area: "top" | "bottom";
}

/** newSessionWidgets registration meta: allowed areas + grid size (declared at registration, read by the host layout
 *  resolver). User customization only overrides "order / area membership / visibility"; sizes are declared by the registrant. */
export interface NewSessionWidgetMeta {
  /** Set of areas the widget may appear in; defaults to ["top","bottom"] (both). */
  areas?: ("top" | "bottom")[];
  /** Default home area; defaults to areas[0]. */
  defaultArea?: "top" | "bottom";
  /** Grid column width 1..8, default 4 — a full row on mobile (4 columns) / half a row on desktop (8 columns) ("1×4"). */
  w?: number;
  /** Grid row height 1..3, default 1 (row-height baseline lives in the NewSessionWidgets component). */
  h?: number;
  /** Display name (customization panel / placeholder when content is empty). */
  title?: string;
  /** Default order weight (ascending; new entries without a saved preference are stably appended by it); defaults to registration order. */
  priority?: number;
}

/** prepare return value of the newSessionPreparers registration surface: {cwd} rewrites the target directory (chained —
 *  later preparers see earlier results); {abort} aborts creation (the text goes verbatim into the existing throw→notice
 *  error channel; drafts are kept by the draft-keeper). */
export type NewSessionPrepareResult = { cwd?: string; abort?: string } | void;

/** assistantMessageFooter slot props (end of the assistant message content area, after the "changed files" chips).
 *  The turn's final-answer render point receives whole-turn aggregated data from ChatWindow; the other assistant
 *  message render points only get entryId/sessionId/cwd (assistantEntryIds/writtenFiles absent — per-message fallback).
 *  Process messages inside a grouped turn are not mounted at all when "that turn has a final answer" (dedup, see
 *  MessageView suppressMessageFooter); an interrupted turn with no final answer → process messages fall back as usual. */
export interface AssistantMessageFooterSlotProps {
  /** The assistant message's own entry id (absent in not-yet-persisted cases such as the streaming tail — the render point is not mounted then). */
  entryId?: string;
  /** Session id (absent in session-less contexts such as the new-session welcome page). */
  sessionId?: string;
  /** Session cwd (for resolving relative paths). */
  cwd?: string;
  /** Only at the turn's final-answer render point: the whole turn's assistant entry id set (including the final answer
   *  itself, collected from the same source as writtenFiles). Extensions use it to aggregate this turn's changes
   *  against an out-of-band ledger (the git-trace extension's ops). */
  assistantEntryIds?: string[];
  /** Only at the turn's final-answer render point: the host-derived "changed files" absolute paths (write/edit accounting).
   *  Extensions diff against it and only add files the ledger has extra, avoiding duplicate display. */
  writtenFiles?: string[];
}

export interface ExtSlotContractMap {
  /** Queue panel (de-fork P3): the core → ext live/trash/actions primitives.
   *  Contract defined in lib/composer/queue-api.ts (single implementation of download-export/import-parse);
   *  the queue-manager extension renders the full queue UI through this slot. */
  queuePanel: { props: QueuePanelProps };
  /** Action area at the bottom of the CWD picker dropdown (session-manager: manage the workspace list). */
  workspacePickerActions: { props: WorkspacePickerActionsProps };
  /** Chat input model button takeover (the model-wizard extension). */
  modelSelector: { props: ModelSelectorSlotProps };
  /** Action area at the bottom of the model-selector dropdown (the model-wizard extension's manage-models entry). */
  modelSelectorFooter: { props: ModelSelectorFooterSlotProps };
  /** Settings "Models" tab takeover (the model-wizard extension). */
  settingsModels: { props: SettingsModelsSlotProps };
  /** Feature block at the top of the settings Agents page (the subagents extension). */
  settingsAgentsFeature: { props: SettingsAgentsFeatureSlotProps };
  /** Full-page takeover of the settings "Subagents" tab (the subagents extension). */
  settingsAgents: { props: SettingsAgentsSlotProps };
  /** Workspace terminal tab content takeover (the terminal extension). */
  terminalDock: { props: TerminalDockSlotProps };
  /** Mobile model-info leading position (the context-meter extension's context ratio bar; context-meter plan §4.2). */
  modelInfoLead: { props: ModelInfoLeadSlotProps };
  /** Desktop position left of the compact button (the context-meter extension; same contract as ModelInfoLeadSlotProps, isMobile always absent = desktop). */
  compactLead: { props: ModelInfoLeadSlotProps };
  /** Session request card (agent-capability UI de-coring): takeover seam for the interaction-primitive / tool-authorization /
   *  captcha floating cards (the session-cards extension, the zcode agent adapter client, etc.). Routing/fallback:
   *  agent-capability-UI extension plan §2.1. */
  sessionRequestCard: { props: SessionRequestCardSlotProps };
  /** Extension picker row on the new-session welcome page (session-manager branch/worktree picker). */
  newSessionSelectors: { props: NewSessionSelectorSlotProps };
  /** Top/bottom widget area of the new-session welcome page (built-in recent sessions / extension widgets; mobile-desktop widget semantics). */
  newSessionWidgets: { props: NewSessionWidgetSlotProps };
  /** End of the assistant message content area (the git-trace extension: change-file lines captured by trace;
   *  git-trace message-files extension plan §3.2). */
  assistantMessageFooter: { props: AssistantMessageFooterSlotProps };
  // sidebarProjects: full-column SessionSidebar takeover (session-manager SidebarClone, props passed through in full) —
  // the contract is SessionSidebarProps itself (not in this map; loose object pass-through).
}

/** Slot props type taken from the contract (undeclared → loose object). */
export type ExtSlotProps<S extends ExtSlotName> =
  S extends keyof ExtSlotContractMap
    ? ExtSlotContractMap[S] extends { props: infer P } ? P : Record<string, never>
    : Record<string, unknown>;

/** Slot props extended with the host built-ins (host built-ins + extension declarations merged). */
export type ExtSlotPropsWithBuiltIn<S extends ExtSlotName> =
  { currentSession?: { id: string; cwd: string; name?: string; firstMessage?: string } | null } & ExtSlotProps<S>;

/**
 * i18n type contract (DSH LocaleNamespaceMap feedback): once an extension declares
 * its key table, the key parameter of ctx.t(key) becomes type-checked.
 *
 *   declare module "pi-web-ext/ext" {
 *     interface LocaleNamespaceMap { "my-extension": { "inspect.start": string } }
 *   }
 */
// The empty interface is the module augmentation merge anchor (same as the DSH LocaleNamespaceMap).
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LocaleNamespaceMap {}

/**
 * Paragraph-click takeover extension point (the host stays thin on message-click recognition).
 *
 * An extension (the message-interaction extension) registers a handler; when the user clicks a
 * message paragraph the core hands the paragraph's plain text + context + anchor rect to every
 * handler (there can be several; the message-interaction extension is the primary taker).
 * Recognition / popup rendering / actions / closing all live in the extension; the core only
 * provides: clickable paragraphs + click event broadcast + the setInline mount point (renders
 * extension nodes in-flow after the paragraph; tr rows are auto-ported to body).
 */
export interface ParagraphClickInfo {
  /** Paragraph plain text (textContent after render; table rows = cells joined with " | ") */
  text: string;
  /** Session cwd (for resolving relative paths) */
  cwd?: string;
  /** Message role ("user" / "assistant" / undefined) */
  messageRole?: string;
  /** Paragraph anchor (for extension positioning; view coordinates — the extension may listen to scroll/resize to follow) */
  rect: { top: number; left: number; bottom: number; width: number };
  /** Paragraph DOM element (for extensions needing finer positioning/selection/scroll following) */
  element?: HTMLElement;
  /** Stable paragraph identity (generated by useId) — for extension toggle checks / "only one open at a time" dedup */
  paragraphId: string;
  /** Session/message containing the paragraph (reserved; passed through by the message component when the extension needs it, not guaranteed by the core) */
  sessionId?: string;
  messageId?: string;
  /** Inline expansion of the paragraph (rendered in-flow after it; tr rows are auto-ported to body + positioned by the
   *  extension). Note: the core only provides the mount point — positioning/scroll/closing management are all
   *  extension duties. */
  setInline(node: ReactNode | null): void;
  /** Close this paragraph's inline expansion (the extension calls the old paragraph's close before opening a new one) */
  close(): void;
}

/** Candidate tags for paragraph clicks (semantic blocks the core render shell supports; default p/li/tr) */
export type ClickableTag = "p" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/** Paragraph click handler. May carry a hint: the paragraph hover tooltip text (the visual contract of the
 *  core-rendered tip; the text is supplied by the extension — e.g. the message-interaction extension's
 *  "click to quote-reply"; no hint means no tooltip is shown).
 *  tags: declares the semantic block tags that need clicks (defaults to ["p","li","tr"] when undeclared) —
 *  new scenarios (e.g. headings h1-h6) take effect as soon as the extension declares them, no core change needed. */
export type ParagraphClickHandler = ((info: ParagraphClickInfo) => void) & { hint?: string; tags?: ClickableTag[] };

/** Input to the pre-fork gate (context at the moment the fork is initiated). position follows the pi convention:
 *  "before" = branch from before this entry (/fork semantics); "at" = clone including this entry (/clone). */
export interface SessionForkGateInfo {
  /** Agent session id (composite id, consistent with /api/agent/[id]) */
  sessionId: string;
  /** Session file path (not always available client-side; when absent the extension can resolve it server-side via sessionId) */
  sessionFile?: string;
  /** Entry id of the fork branch point */
  entryId: string;
  position: "before" | "at";
  /** The message turns cut away by "edit from here" (the edited message M and every later user message's entryId),
   *  in session order. Extensions use it to scope the rollback range precisely (including the edited turn) rather
   *  than just the ops after entryId (edit-here reverse-rollback plan). */
  cutUserEntryIds?: string[];
}

/** "Edit & resend" pre-gate (e.g. the git-trace extension's three rollback options): return true to allow; false or a
 *  thrown error cancels this marking. Registered via the client ctx.registerSessionForkGate (the bus lives in
 *  lib/ext/fork-gates.ts; consumption point: components/ChatWindow.handleEditFromHereMark before marking
 *  "edit from here"; forking a new session leaves the original untouched and does not trigger this gate). */
export type SessionForkGate = (info: SessionForkGateInfo) => Promise<boolean>;

/** Capability takeover declarations: once an extension declares one, the core hides the matching built-in UI/behavior
 *  and the extension takes over fully. Capability names are a stable contract between core and extensions (not
 *  extension ids) — when adding a capability, register it in EXT_PROVIDES and update the docs (AGENTS.md). */
export const EXT_PROVIDES = {
  /** Session delete: once declared, the sidebar hides the built-in delete button (the delete flow is taken over by the extension, e.g. archive first, then delete on the archive record). */
  sessionDelete: "session-delete",
  /** External agent session source: once declared, session-manager auto-discovers this extension and calls its
   *  api hook in-process to pull the normalized agent-source/manifest|list|session session data. */
  sessionAgentSource: "session-agent-source",
  /** Queue panel: once declared, ChatInput hides the fallback banner and the extension renders the full queue UI through the queuePanel slot. */
  queuePanel: "queue-panel",
} as const;

export type ExtProvidesName = (typeof EXT_PROVIDES)[keyof typeof EXT_PROVIDES];

export interface ExtUiDefinition {
  toolbar?: ExtUiItem[];
  sidebar?: ExtUiItem[];
  /** Sidebar bottom quick-action row (same row as the built-in models/skills/plugins). */
  sidebarFooter?: ExtUiItem[];
  sessionTopbar?: ExtUiItem[];
  sessionRowActions?: ExtUiItem[];
  /** Per-session-row meta (second line · end of spinner/message count; e.g. the plan-tracking extension's plan binding badge + front-matter tags). */
  sessionRowMeta?: ExtUiItem[];
  /** Full takeover of the left "Projects" session list (session-manager SidebarClone). */
  sidebarProjects?: ExtUiItem[];
  /** Full takeover of the left sidebar (AppShell-level sidebarContent; session-manager SidebarContentDock, unified dock plan §3.2). */
  sidebarContent?: ExtUiItem[];
  dialogs?: ExtUiItem[];
  banners?: ExtUiItem[];
  pages?: ExtUiItem[];
  fileViewer?: ExtUiItem[];   // File view/edit takeover items (springboard-rendered by the core FileViewer; items need a match predicate to take effect)
  pathPicker?: ExtUiItem[];   // Directory-picker capability items (springboard-rendered by the core top bar's "open folder"; items carry render({path,onSelect}))
  chatInputTop?: ExtUiItem[];
  /** Floating-dock extension v0.5.0: dock block below the sidebar file area (host DockSection collapsed container; float plan §4.2). */
  sidebarExplorerDock?: ExtUiItem[];
  /** Floating-dock extension v0.5.0: right-column dock block — each item derives a TabBar tab (float plan §4.3). */
  rightFileDock?: ExtUiItem[];
  /** Floating-dock extension v0.5.1: left sidebar "Tasks" block (float plan §4.4.2). */
  sidebarTasks?: ExtUiItem[];
  modelSelector?: ExtUiItem[];  // Chat input model button takeover items (springboard-rendered by the core ChatInput; once registered, replaces the native ModelSelector)
  settingsModels?: ExtUiItem[]; // Settings panel "Models" tab takeover items (springboard-rendered by the core SettingsPanel; once registered, replaces the native ModelsConfig)
  /** Extension pickers between Workspace×Backend on the new-session welcome page (render-type; extra = NewSessionSelectorSlotProps). */
  newSessionSelectors?: ExtUiItem[];
  /** Pre-creation preparer pipeline for new sessions (registration-type; meta.prepare({cwd}) => NewSessionPrepareResult). */
  newSessionPreparers?: ExtUiItem[];
  /** Top/bottom widget area of the new-session welcome page (render-type; meta = NewSessionWidgetMeta declares areas/size). */
  newSessionWidgets?: ExtUiItem[];
  /** Take over built-in capabilities (see EXT_PROVIDES): e.g. ["session-delete"] makes the core hide the sidebar's built-in delete button. */
  provides?: string[];
  /** Other extension ids this extension's client bundle depends on (startup-graph inject edges: parallel prefetch /
   *  load-order hints, informational — load correctness never depends on it; only affects prefetch scheduling and
   *  HMR diff display). */
  clientDependsOn?: string[];
  /** Lazy-load declaration: when false, this extension's client bundle is not materialized during startup —
   *  it is fetched and registered only when rendering first reaches a UI slot it declared (on-demand load,
   *  DSH immediately feedback). */
  clientImmediately?: boolean;
  /** Lazy-trigger credential (paired with clientImmediately:false): for extensions with no ui[slot][] static items
   *  whose render surface is delivered to consumer extensions via a client service (e.g. app-center →
   *  session-manager orchestrator), the consumer deterministically ensureMaterialized at an always-mounted mount
   *  point — the "lazy marker ineffective" static diagnostic exempts them (what is exempted is the diagnostic,
   *  not the mechanism: only service-triggered lazy extensions without the credential get false-positived). */
  clientLazyVia?: "service";
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
  /** Short icon/emoji (e.g. "🧰") or an icon file path relative to the extension dir (e.g. "icon.svg", lucide line style); optional. */
  icon?: string;
  /**
   * App-center category tag (consumed by the app-center extension; single tag-style value). When the value is one of
   * the app center's internal category ids (session/code/ai/auto/debug/ui/system/other) a localized label is shown;
   * other values display verbatim as custom categories; absent falls to the default category other. Item-level
   * (meta.category / ui item category) and feature-level tags take precedence over this value.
   */
  category?: string;
  /** Feature management declaration: the list of features the extension exposes that users can enable/disable (see ExtFeature). */
  features?: ExtFeature[];
  /**
   * Conflicting-plugin declaration: lists third-party extensions/packages whose functionality conflicts with this
   * extension and must be disabled. When the platform assembles SDK extension load results, any extension whose
   * source package name or path matches an identifier (scoped names in full) is removed entirely (not initialized).
   * Identifiers are npm package names (e.g. "pi-subagents", scoped written as "@scope/name"). The declarer itself
   * lives in the host extension system, naturally isolated from SDK load results.
   */
  conflicts?: string[];
  /**
   * Feature-level hard dependencies (dependency & capability model §2): elements are extension ids **or capability
   * names** (cap.* prefix convention; id matches win). When a dependency is disabled/uninstalled the extension
   * manager shows a warning; an unresolved (missing) one is flagged "dependency unsatisfied" in the extension
   * manager. Declarative only: it does not block loading this extension (§9: avoid declaration conflicts paralyzing
   * features); runtime enforcement is up to the extension probing the manifest itself.
   */
  dependsOn?: string[];
  /**
   * Optional dependencies (npm optionalDependencies semantics): present → the consumer may enable extra
   * functionality; absent/disabled → no effect at all. Purely declarative, triggers no warnings (shown only in
   * the extension manager's detail view).
   */
  optionalDependsOn?: string[];
  /**
   * Server-side startup priority (unified SSE port plan §3-A): higher starts earlier (default 0; the same priority
   * keeps scan order, stable sort). Shutdown is the symmetric reverse (lower priority stops first). Purpose:
   * host infrastructure-level extensions (e.g. the event-bus extension = 100) must finish startup before consuming
   * extensions — the bus's service egress/routes are in place first, and consumers must not spin up their own
   * because the bus arrived late. Only affects start/shutdown order; does not touch dependsOn semantics
   * (which stays a declarative warning).
   */
  startupPriority?: number;
  /**
   * Provided capabilities (capability, multiple implementations): several extensions may declare the same capability,
   * and a consumer's dependsOn can point at the capability name; the platform resolves the effective provider
   * (arbitration: user pin > takeover declarer > newest semver > extension id lexicographic). Convention: capability
   * names carry the "cap." prefix (not enforced; id matches win).
   */
  provides?: string[];
  /**
   * Exclusively taken-over features: multiple declarers of the same feature → conflict; the platform arbitrates a
   * single effective one (same arbitration rules as provides). Does not block loading (providers still load); only
   * arbitrates the effective one + a conflict panel note in the extension manager. Note this differs from
   * ui.provides (EXT_PROVIDES built-in takeovers, a legacy special case) — those are takeover declarations for
   * core built-in capabilities; evolution path in the ext deps-capabilities plan §7.
   */
  takeover?: string[];
  /**
   * Public API declaration: the listed API paths (the path after /api/extensions/<id>/, joined with "/",
   * e.g. "cpu-meter.js") allow cross-origin GET (bypassing request-security's cross-site gate). Purpose:
   * assets/read-only endpoints for "server-side injection into arbitrary pages" (e.g. the standalone script the
   * service-tunnels extension injects) — a cross-origin <script src> carries Sec-Fetch-Site: cross-site with no
   * Origin, so the default gate always blocks it → the browser's ORB blocks it a second time. Security boundary:
   * GET only + exact path match; writes and undeclared paths still go through the default gate.
   */
  publicApi?: string[];
}

/** Extension source roots: local (home) > extra (env middle layer) > dev (dev-exts development layer) > bundled (program directory baseline). */
export type ExtensionSource = "user" | "extra" | "dev" | "bundled";

/** A successfully-loaded extension plus its resolved directories. */
export interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  dir: string;
  /** Config area (root of dataRoot/<id>/). */
  configDir: string;
  /** Persistent data area (dataRoot/<id>/state/, non-regenerable data; never assume it may be lost). */
  stateDir: string;
  /** Cache area (dataRoot/<id>/cache/, safe to delete wholesale and rebuild). */
  cacheDir: string;
  /** The root actually loaded from (user / extra / bundled) — with the same name, a higher-priority root shadows lower-priority ones. */
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
  /** Feature-level hard dependency declarations (runtime-probeable: the client gets the full manifest to check whether dependencies/capabilities are satisfied). */
  dependsOn?: string[];
  /** Optional dependency declarations (runtime-probeable: decides whether to enable extra functionality). */
  optionalDependsOn?: string[];
  /** Provided capability declarations. */
  provides?: string[];
  /** Exclusively taken-over feature declarations. */
  takeover?: string[];
  /** App-center category tag (passed through from PiWebExtension.category; absent = untagged). */
  category?: string;
  /** Feature states (extension-manager managed): fetched together when the host client loads; extensions read a shared store, no separate requests. */
  features?: { id: string; type?: "boolean" | "string" | "textlist"; label?: string; placeholder?: string; category?: string; enabled: boolean; value?: string }[] | null;
}
