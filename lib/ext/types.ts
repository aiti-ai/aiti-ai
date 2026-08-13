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
  server?: ExtServerHooks;
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
