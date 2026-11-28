/**
 * Extension runtime: storage + registry + event-bus publishing.
 */
import { Store } from "./store.ts";
import { registry, provideRegistryService, type ForgeRegistry } from "./registry.ts";
import type { OAuthRuntime } from "./oauth.ts";

let store: Store | null = null;
let servicesCtx: { get?: (key: string) => unknown } | null = null;
let disposeService: (() => void) | null = null;

export function getStore(): Store {
  if (!store) throw new Error("aiti-codehub: storage is not initialized");
  return store;
}

export function getRegistry(): ForgeRegistry {
  return registry;
}

export function getServices(): { get?: (key: string) => unknown } | null {
  return servicesCtx;
}

export function publish(topic: string, data: Record<string, unknown>): void {
  try {
    const svc = servicesCtx?.get?.("aiti-event-bus.publish-local") ?? servicesCtx?.get?.("aiti-event-bus.publish");
    const fn = (svc as { publish?: (t: string, d: Record<string, unknown>) => void } | undefined)?.publish;
    fn?.(topic, data);
  } catch {
    /* event bus absent: the UI still works through explicit refreshes */
  }
}

export function runtime(): OAuthRuntime {
  return { store: getStore(), registry, publish };
}

export function startup(ctx: {
  configDir: string;
  stateDir?: string;
  cacheDir?: string;
  services?: { provide?: (key: string, impl: unknown) => () => void; get?: (key: string) => unknown };
}): void {
  const configDir = String(ctx.configDir || "");
  const stateDir = String(ctx.stateDir || `${configDir}/state`);
  const cacheDir = String(ctx.cacheDir || `${configDir}/cache`);
  store = new Store({ configDir, stateDir, cacheDir });
  // Let the host file API/editor open the read-only remote copies we materialize in cache.
  try {
    (ctx as { core?: { fileAccess?: { allowRoot?: (p: string) => void } } }).core?.fileAccess?.allowRoot?.(cacheDir);
  } catch { /* older host */ }
  servicesCtx = (ctx.services as { get?: (key: string) => unknown } | undefined) || null;
  disposeService = provideRegistryService(ctx.services);
  const g = store.global();
  console.log(`[aiti-codehub] ready · providers=${registry.ids().join(",")} · accounts=${store.instances().map((i) => i.id).join(",") || "(none)"} · default=${g.defaultInstance || g.defaultProvider || "(auto)"}`);
}

export function shutdown(): void {
  try {
    disposeService?.();
  } catch {
    /* ignore */
  }
  disposeService = null;
  servicesCtx = null;
  store = null;
}
