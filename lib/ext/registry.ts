/**
 * Extension registry — owns loading, lifecycle, API dispatch, middleware
 * chaining and manifest generation. One instance per server process, held on
 * globalThis.__piWebExt so the middleware bundle (proxy.ts, separate Next
 * bundle) can invoke hooks without importing extension code.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { join, sep } from "path";
import type {
  AgentSessionInfo,
  ExtAgentEndReason,
  ExtAgentHooks,
  ExtApiContext,
  ExtCoreApi,
  ExtMiddlewareResult,
  ExtServerContext,
  ExtServerHooks,
  ExtensionSource,
  LoadedExtension,
  ManifestExtension,
} from "./types.ts";
import { dataRoot, extensionsRoot, bundledExtensionsRoot, devExtensionsRoot, extraExtensionsRoots } from "./data-dir.ts";
import { loadExtensionFromDir, scanExtensionDirs } from "./loader.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

declare global {
  var __piWebExt: ExtRegistryImpl | undefined;
}

export interface RegistryOptions {
  core: ExtCoreApi;
  /** Test hook: override the extensions root. */
  extensionsRootOverride?: string;
  /** Test hook: override the extra (middle-tier) extension roots. */
  extraExtensionsRootsOverride?: string[];
  /** Test hook: dev layer root; undefined = auto-detect, null = disabled. */
  devExtensionsRootOverride?: string | null;
  /** Test hook: override the bundled extension root. */
  bundledExtensionsRootOverride?: string;
  /** Test hook: override the data root. */
  dataRootOverride?: string;
}

export class ExtRegistryImpl {
  core: ExtCoreApi;
  private readonly extensionsRootOverride?: string;
  private readonly extraExtensionsRootsOverride?: string[];
  private readonly devExtensionsRootOverride?: string | null;
  private readonly bundledExtensionsRootOverride?: string;
  private readonly dataRootOverride?: string;
  private extensions = new Map<string, LoadedExtension>();
  private errors = new Map<string, string>();
  private loaded = false;

  constructor(options: RegistryOptions) {
    this.core = options.core;
    this.extensionsRootOverride = options.extensionsRootOverride;
    this.extraExtensionsRootsOverride = options.extraExtensionsRootsOverride;
    this.devExtensionsRootOverride = options.devExtensionsRootOverride;
    this.bundledExtensionsRootOverride = options.bundledExtensionsRootOverride;
    this.dataRootOverride = options.dataRootOverride;
  }

  extensionsRoot(): string {
    return this.extensionsRootOverride ?? extensionsRoot();
  }

  extraExtensionsRoots(): string[] {
    return this.extraExtensionsRootsOverride ?? extraExtensionsRoots();
  }

  bundledExtensionsRoot(): string {
    return this.bundledExtensionsRootOverride ?? bundledExtensionsRoot();
  }

  dataRoot(): string {
    return this.dataRootOverride ?? dataRoot();
  }

  /** 解析顺序即优先级：user → extra（env 列出顺序）→ dev（dev-exts）→ bundled。 */
  private extensionRoots(): Array<{ root: string; source: ExtensionSource }> {
    const dev = this.devExtensionsRootOverride !== undefined
      ? this.devExtensionsRootOverride
      : devExtensionsRoot();
    return [
      { root: this.extensionsRoot(), source: "user" },
      ...this.extraExtensionsRoots().map((root) => ({ root, source: "extra" as const })),
      ...(dev ? [{ root: dev, source: "dev" as const }] : []),
      { root: this.bundledExtensionsRoot(), source: "bundled" },
    ];
  }

  /**
   * Scan + load every extension directory across all roots. Individual
   * failures never block others. Same id in a lower-priority root is
   * shadowed (skipped silently) once a higher-priority root loaded it.
   */
  async loadAll(): Promise<void> {
    this.extensions.clear();
    this.errors.clear();
    const seen = new Set<string>();
    for (const { root, source } of this.extensionRoots()) {
      for (const dir of scanExtensionDirs(root)) {
        const id = dir.split(sep).pop() ?? dir;
        if (seen.has(id)) continue; // 高优先级根已加载 → 同名遮蔽跳过
        seen.add(id);
        try {
          const ext = await loadExtensionFromDir(dir);
          if (!ext) {
            this.errors.set(id, "no extension entry (index.ts / single script)");
            continue;
          }
          if (ext.id !== id) {
            this.errors.set(id, `entry id "${ext.id}" does not match directory name "${id}"`);
            continue;
          }
          const dataDir = join(this.dataRoot(), ext.id);
          if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
          this.extensions.set(ext.id, { id: ext.id, name: ext.name, version: ext.version, dir, dataDir, source, ext });
        } catch (e) {
          this.errors.set(id, e instanceof Error ? e.message : String(e));
        }
      }
    }
    this.loaded = true;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  byId(id: string): LoadedExtension | undefined {
    return this.extensions.get(id);
  }

  all(): LoadedExtension[] {
    return [...this.extensions.values()];
  }

  status(): Record<string, { loaded: boolean; error?: string; name?: string; version?: string; source?: ExtensionSource }> {
    const out: Record<string, { loaded: boolean; error?: string; name?: string; version?: string; source?: ExtensionSource }> = {};
    for (const [id, error] of this.errors) out[id] = { loaded: false, error };
    for (const ext of this.extensions.values()) {
      out[ext.id] = { loaded: true, name: ext.name, version: ext.version, source: ext.source };
    }
    return out;
  }

  manifest(): ManifestExtension[] {
    return [...this.extensions.values()].map((e) => ({
      id: e.id,
      name: e.name,
      version: e.version,
      // clientUrl 带文件内容哈希（?v=<sha256 前 12 位>）：扩展 client 更新 → URL 变 → 浏览器强制重新拉取（无需硬刷/清缓存）
      clientUrl: e.ext.client ? `/api/extensions/${e.id}/assets/${e.ext.client}?v=${this.clientHash(e)}` : null,
      ui: e.ext.ui ?? null,
      source: e.source,
      icon: e.ext.icon ?? null,
    }));
  }

  /** 扩展 client 文件内容哈希（按 mtime 缓存：文件变化才重算）——clientUrl?v=<hash> 强制浏览器重新拉取 */
  private _clientHashCache = new Map<string, { mtime: number; hash: string }>();
  private clientHash(e: LoadedExtension): string {
    try {
      if (!e.ext.client) return "";
      const p = join(e.dir, e.ext.client);
      const st = statSync(p);
      const c = this._clientHashCache.get(e.id);
      if (c && c.mtime === st.mtimeMs) return c.hash;
      const hash = createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);
      this._clientHashCache.set(e.id, { mtime: st.mtimeMs, hash });
      return hash;
    } catch {
      return "";
    }
  }

  /** Invoke all server.startup hooks (best-effort per extension). */
  async startAll(): Promise<void> {
    for (const ext of this.extensions.values()) {
      try {
        await ext.ext.server?.startup?.(this.serverContext(ext));
      } catch (e) {
        this.errors.set(ext.id, `startup: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // ---- 方案 M：agent 会话级扩展点 ----
  private agentHooks(ext: LoadedExtension): ExtAgentHooks | undefined {
    return (ext.ext.server as (ExtServerHooks & { agent?: ExtAgentHooks }) | undefined)?.agent;
  }

  /** 收集所有扩展注入 agent 会话的 customTools（建会话时调用一次；单扩展异常不阻断整体）。 */
  collectAgentTools(info: Pick<AgentSessionInfo, "sessionId" | "cwd">): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const ext of this.extensions.values()) {
      try {
        const t = this.agentHooks(ext)?.agentTools?.(info);
        if (t) tools.push(...t);
      } catch (e) {
        console.error(`[ext] ${ext.id}.agent.agentTools 失败:`, e instanceof Error ? e.message : e);
      }
    }
    return tools;
  }

  /** 会话启动回调（wrapper 创建后）。 */
  dispatchAgentSession(info: AgentSessionInfo): void {
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSession?.(info); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSession 失败:`, e instanceof Error ? e.message : e); }
    }
  }

  /** 会话销毁回调（wrapper destroy，含 fork/idle-GC 回收场景，reason 区分）。 */
  dispatchAgentSessionEnd(sessionId: string, reason?: ExtAgentEndReason): void {
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSessionEnd?.({ sessionId, reason }); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSessionEnd 失败:`, e instanceof Error ? e.message : e); }
    }
  }

  /** agent_settled 回调（最终回答文本）。 */
  dispatchAgentSettled(sessionId: string, text: string): void {
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSettled?.({ sessionId, text }); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSettled 失败:`, e instanceof Error ? e.message : e); }
    }
  }

  async shutdown(): Promise<void> {
    for (const ext of this.extensions.values()) {
      try {
        await ext.ext.server?.shutdown?.(this.serverContext(ext));
      } catch (e) {
        this.errors.set(ext.id, `shutdown: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Hot reload: shutdown → reload entries → startup. */
  async reload(): Promise<void> {
    await this.shutdown();
    await this.loadAll();
    await this.startAll();
  }

  private serverContext(ext: LoadedExtension): ExtServerContext {
    return { id: ext.id, dir: ext.dir, dataDir: ext.dataDir, core: this.core };
  }

  /** Dispatch one API call to an extension; null when no extension/handler matches. */
  async api(req: Request, pathSegments: string[]): Promise<Response | null> {
    const [extId, ...rest] = pathSegments;
    const ext = this.extensions.get(extId);
    if (!ext) return null;
    if (!ext.ext.server?.api) return null;
    const url = new URL(req.url);
    const ctx: ExtApiContext = {
      ...this.serverContext(ext),
      method: req.method,
      path: rest,
      searchParams: url.searchParams,
    };
    try {
      const result = await ext.ext.server.api(req, ctx);
      return result ?? null;
    } catch (e) {
      return new Response(JSON.stringify({ error: `[${extId}] ${e instanceof Error ? e.message : String(e)}` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /**
   * Middleware chain: first extension that handles the request wins.
   * Throwing extensions are fail-closed by the caller (proxy.ts returns 403).
   */
  async middleware(req: Request): Promise<ExtMiddlewareResult> {
    for (const ext of this.extensions.values()) {
      if (!ext.ext.server?.middleware) continue;
      const result = await ext.ext.server.middleware(req);
      if (result && result.handled) return result;
    }
    return { handled: false };
  }

  /**
   * Resolve a relative file inside an extension's code directory (client
   * bundles / static assets). Traversal outside the extension dir is refused.
   */
  assetPath(extId: string, relPath: string): string | null {
    const ext = this.extensions.get(extId);
    if (!ext || !relPath) return null;
    if (relPath.startsWith("/") || relPath.includes("..")) return null;
    const resolved = join(ext.dir, relPath);
    if (!resolved.startsWith(ext.dir + sep)) return null;
    return resolved;
  }
}

/** Process-wide singleton (survives Next.js hot reload). */
export function getRegistry(): ExtRegistryImpl {
  if (!globalThis.__piWebExt) {
    // instrumentation.ts calls ensureRegistry(makeExtCore()) at startup; a
    // missing instance here means the server wasn't fully bootstrapped.
    throw new Error("extension registry not bootstrapped (instrumentation should call ensureRegistry)");
  }
  return globalThis.__piWebExt;
}

/** Create-or-reuse the singleton with an explicit core (instrumentation). */
export function ensureRegistry(core: ExtCoreApi): ExtRegistryImpl {
  if (!globalThis.__piWebExt) {
    globalThis.__piWebExt = new ExtRegistryImpl({ core });
  } else if (globalThis.__piWebExt.core !== core) {
    globalThis.__piWebExt.core = core;
  }
  return globalThis.__piWebExt;
}

/** Test helper: drop the singleton. */
export function resetRegistry(): void {
  delete globalThis.__piWebExt;
}
