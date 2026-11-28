/**
 * Small client-side shared store: account instances (multi-account), selected instance,
 * change events and display helpers.
 *
 * An "instance" is one configured account of a platform: id `github` is the default
 * account, `github~work` an extra one. The server merges the platform descriptor into
 * each instance (capabilities / auth form / labels), so surfaces keep reading
 * `p.capabilities`, `p.auth`, `p.status` without a second lookup.
 */
import { useEffect, useState, t } from "./host-shim";
import { getConfig, type ConfigPayload, type ProviderInfo } from "./api";
import { CHANGE_EVENT, PROVIDER_KEY } from "./keys";
import { friendlyError } from "./ui";

let cache: ConfigPayload | null = null;
let inflight: Promise<ConfigPayload> | null = null;
const listeners = new Set<() => void>();

export function emitChanged(): void {
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
  try { window.dispatchEvent(new Event(CHANGE_EVENT)); } catch { /* ignore */ }
}

export function onChange(cb: () => void): () => void {
  listeners.add(cb);
  const h = () => cb();
  try { window.addEventListener(CHANGE_EVENT, h); } catch { /* ignore */ }
  return () => {
    listeners.delete(cb);
    try { window.removeEventListener(CHANGE_EVENT, h); } catch { /* ignore */ }
  };
}

export async function loadConfig(force = false): Promise<ConfigPayload> {
  if (cache && !force) return cache;
  if (inflight) return inflight;
  inflight = getConfig()
    .then((c) => { cache = c; return c; })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Replace the shared cache with a payload a surface just received (mutation responses). */
export function applyConfig(payload: ConfigPayload): void {
  cache = payload;
}

/** Configured accounts; falls back to the platform catalogue (older server). */
export function cachedProviders(): ProviderInfo[] {
  const c = cache as ConfigPayload | null;
  const list = c?.instances?.length ? c.instances : c?.providers;
  return (list || []) as ProviderInfo[];
}

export function cachedPlatforms(): ProviderInfo[] {
  return ((cache as ConfigPayload | null)?.providers || []) as ProviderInfo[];
}

export function readSelectedProvider(): string {
  try { return localStorage.getItem(PROVIDER_KEY) || ""; } catch { return ""; }
}

export function writeSelectedProvider(id: string): void {
  try { localStorage.setItem(PROVIDER_KEY, id); } catch { /* ignore */ }
}

/* ── display helpers (work with ids, aliases and platform ids) ── */

function findInstance(idOrAlias: string): ProviderInfo | undefined {
  const list = cachedProviders();
  const want = String(idOrAlias || "").trim();
  if (!want) return undefined;
  return list.find((p) => p.id === want)
    || list.find((p) => (p.alias || "").trim() === want)
    || list.find((p) => p.platform === want);
}

/** t() with a caller fallback (dictionary miss returns the bare key). */
function tf(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

/** Platform label for an instance id, alias or platform id (localized via the
 * ch.prov.platform.* dictionary; the server-provided label is the fallback). */
export function platformLabelOf(idOrAlias: string): string {
  const p = findInstance(idOrAlias);
  if (!p) return String(idOrAlias || "");
  const platform = String(p.platform || p.id);
  return tf(`ch.prov.platform.${platform}`, String(p.platformLabel || p.label || platform));
}

/** Account alias for an instance id. Aliases derived from the platform label (the
 * server backfills one when no explicit alias exists) display localized. */
export function aliasOf(idOrAlias: string): string {
  const p = findInstance(idOrAlias);
  if (!p) return String(idOrAlias || "");
  return aliasDisplay(p);
}

/** Server-derived alias (platform-label backfill) → localized platform label; an
 * explicit alias is user data and passes through untouched. */
export function aliasDisplay(p: ProviderInfo): string {
  const alias = String(p.alias || "").trim();
  const serverPlatformLabel = String(p.platformLabel || p.label || "");
  if (!alias || alias === serverPlatformLabel) return platformLabelOf(p.id);
  return alias;
}

/** "platform · alias" for extras, platform label alone for the default/single account. */
export function instanceTitle(idOrAlias: string): string {
  const p = findInstance(idOrAlias);
  if (!p) return String(idOrAlias || "");
  const platform = platformLabelOf(idOrAlias);
  const serverPlatformLabel = String(p.platformLabel || p.label || "");
  const alias = String(p.alias || "").trim();
  if (!alias || alias === serverPlatformLabel || alias === platform) return platform;
  return `${platform} · ${alias}`;
}

export interface PlatformGroup {
  platform: string;
  label: string;
  items: ProviderInfo[];
}

/** Group instances by platform (registration order = catalogue order). */
export function groupByPlatform(list: ProviderInfo[]): PlatformGroup[] {
  const order = cachedPlatforms().map((p) => String(p.platform || p.id));
  const map = new Map<string, PlatformGroup>();
  for (const item of list) {
    const platform = String(item.platform || item.id);
    const label = platformLabelOf(item.id);
    const group = map.get(platform) || { platform, label, items: [] };
    group.items.push(item);
    map.set(platform, group);
  }
  return [...map.values()].sort((a, b) => {
    const ia = order.indexOf(a.platform);
    const ib = order.indexOf(b.platform);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.label.localeCompare(b.label);
  });
}

export function pickDefaultProvider(list: ProviderInfo[], forSurface: "workitems" | "code"): string {
  const cap = (p: ProviderInfo) => (forSurface === "workitems" ? !!p.capabilities?.workItems : !!p.capabilities?.code);
  const usable = list.filter(cap);
  const stored = readSelectedProvider();
  if (stored && usable.some((p) => p.id === stored)) return stored;
  const configured = usable.find((p) => p.status?.hasToken || p.status?.configured);
  return (configured || usable[0])?.id || "";
}

/** Reactive instance list (refreshes on CodeHub change events). authRev bumps
 * whenever any provider's auth state flips (e.g. a PAT saved in Settings) so
 * surfaces can re-run their auth-gated loads. */
export function useProviders(forSurface: "workitems" | "code"): {
  providers: ProviderInfo[];
  groups: PlatformGroup[];
  platforms: ProviderInfo[];
  providerId: string;
  setProviderId: (id: string) => void;
  reload: () => Promise<void>;
  loading: boolean;
  error: string | null;
  authRev: number;
} {
  const [providers, setProviders] = useState<ProviderInfo[]>(cachedProviders());
  const [platforms, setPlatforms] = useState<ProviderInfo[]>(cachedPlatforms());
  const [providerId, setProviderIdState] = useState<string>(readSelectedProvider());
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);
  const [authRev, setAuthRev] = useState(0);

  async function reload(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const c = await loadConfig(true);
      const all = (c as ConfigPayload).instances?.length ? (c as ConfigPayload).instances : (c as ConfigPayload).providers;
      const list: ProviderInfo[] = all || [];
      setProviders(list);
      setPlatforms(((c as ConfigPayload).providers || []) as ProviderInfo[]);
      const next = pickDefaultProvider(list, forSurface);
      if (next) setProviderIdState(next);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!cache) void reload();
    /* auth-state signature over the instance list: a flip (PAT saved / logout /
     * needsLogin cleared) must surface to the panels — their load effects key on
     * ids, not on credentials. */
    const sigOf = (list: ProviderInfo[]) =>
      list.map((p) => `${p.id}:${p.status?.hasToken ? 1 : 0}${p.status?.configured ? 1 : 0}`).join(",");
    let prevSig = sigOf(cachedProviders());
    return onChange(() => {
      const list = cachedProviders();
      setPlatforms(cachedPlatforms());
      if (list.length) {
        setProviders(list);
        setProviderIdState((cur) => (cur && list.some((p) => p.id === cur) ? cur : pickDefaultProvider(list, forSurface)));
      }
      const sig = sigOf(list);
      if (sig !== prevSig) {
        prevSig = sig;
        setAuthRev((n) => n + 1);
      }
    });
  }, []);

  const usable = providers.filter((p) => (forSurface === "workitems" ? !!p.capabilities?.workItems : !!p.capabilities?.code));
  const finalList = usable.length ? usable : providers;

  function setProviderId(id: string): void {
    setProviderIdState(id);
    writeSelectedProvider(id);
  }

  const effective = finalList.some((p) => p.id === providerId) ? providerId : finalList[0]?.id || "";
  return { providers: finalList, groups: groupByPlatform(finalList), platforms, providerId: effective, setProviderId, reload, loading, error, authRev };
}
