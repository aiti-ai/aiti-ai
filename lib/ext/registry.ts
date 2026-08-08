/**
 * Extension registry — owns loading, lifecycle, API dispatch, middleware
 * chaining and manifest generation. One instance per server process, held on
 * globalThis.__piWebExt so the middleware bundle (proxy.ts, separate Next
 * bundle) can invoke hooks without importing extension code.
 */
import { existsSync, mkdirSync } from "fs";
import { join, sep } from "path";
import type {
  ExtApiContext,
  ExtCoreApi,
  ExtMiddlewareResult,
  ExtServerContext,
  LoadedExtension,
  ManifestExtension,
} from "./types.ts";
import { dataRoot, extensionsRoot } from "./data-dir.ts";
import { loadExtensionFromDir, scanExtensionDirs } from "./loader.ts";

declare global {
  var __piWebExt: ExtRegistryImpl | undefined;
}

export interface RegistryOptions {
  core: ExtCoreApi;
  /** Test hook: override the extensions root. */
  extensionsRootOverride?: string;
  /** Test hook: override the data root. */
  dataRootOverride?: string;
}

export class ExtRegistryImpl {
  core: ExtCoreApi;
  private readonly extensionsRootOverride?: string;
  private readonly dataRootOverride?: string;
  private extensions = new Map<string, LoadedExtension>();
  private errors = new Map<string, string>();
  private loaded = false;

  constructor(options: RegistryOptions) {
    this.core = options.core;
    this.extensionsRootOverride = options.extensionsRootOverride;
    this.dataRootOverride = options.dataRootOverride;
  }

  extensionsRoot(): string {
    return this.extensionsRootOverride ?? extensionsRoot();
  }

  dataRoot(): string {
    return this.dataRootOverride ?? dataRoot();
  }

  /** Scan + load every extension directory. Individual failures never block others. */
  async loadAll(): Promise<void> {
    this.extensions.clear();
    this.errors.clear();
    const dirs = scanExtensionDirs(this.extensionsRoot());
    for (const dir of dirs) {
      const id = dir.split(sep).pop() ?? dir;
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
        this.extensions.set(ext.id, { id: ext.id, name: ext.name, version: ext.version, dir, dataDir, ext });
      } catch (e) {
        this.errors.set(id, e instanceof Error ? e.message : String(e));
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

  status(): Record<string, { loaded: boolean; error?: string; name?: string; version?: string }> {
    const out: Record<string, { loaded: boolean; error?: string; name?: string; version?: string }> = {};
    for (const [id, error] of this.errors) out[id] = { loaded: false, error };
    for (const ext of this.extensions.values()) {
      out[ext.id] = { loaded: true, name: ext.name, version: ext.version };
    }
    return out;
  }

  manifest(): ManifestExtension[] {
    return [...this.extensions.values()].map((e) => ({
      id: e.id,
      name: e.name,
      version: e.version,
      clientUrl: e.ext.client ? `/api/extensions/${e.id}/assets/${e.ext.client}` : null,
      ui: e.ext.ui ?? null,
    }));
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
