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
  ;

export interface ExtUiDefinition {
  toolbar?: ExtUiItem[];
  sidebar?: ExtUiItem[];
  sessionTopbar?: ExtUiItem[];
  sessionRowActions?: ExtUiItem[];
  dialogs?: ExtUiItem[];
  banners?: ExtUiItem[];
  pages?: ExtUiItem[];
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
}

/** A successfully-loaded extension plus its resolved directories. */
export interface LoadedExtension {
  id: string;
  name: string;
  version: string;
  dir: string;
  dataDir: string;
  ext: PiWebExtension;
}

/** Entry exposed in the client manifest. */
export interface ManifestExtension {
  id: string;
  name: string;
  version: string;
  clientUrl: string | null;
  ui: ExtUiDefinition | null;
  error?: string;
}
