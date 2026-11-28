/**
 * Storage for aiti-codehub.
 *
 * Three tiers (extension data contract):
 *   config  <configDir>/config.json + <configDir>/providers/<id>.json (0600)
 *   state   <stateDir>/state.json    (favorites / recents / usage / pending OAuth)
 *   cache   <cacheDir>/<provider>/<fingerprint>/*.json (safe to delete)
 *
 * Secrets never leave the server: every read for the client goes through redact*().
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_TEMPLATES, type OAuthTokens, type ProviderConfig, type ProviderInstance } from "./contract.ts";
import { ForgeHttpError } from "./http.ts";
import {
  MAX_INSTANCES_PER_PLATFORM,
  deriveInstanceId,
  instanceFromConfig,
  isValidInstanceId,
  normalizeAlias,
  platformOf,
  sameAlias,
} from "./instances.ts";

export type RecentKind = "workitem" | "project" | "repo" | "branch";

export interface RecentEntry {
  provider: string;
  kind: RecentKind;
  id: string;
  label: string;
  sub?: string;
  /** Work item scope so a recent entry can reopen the detail without a search. */
  scopeKind?: "project" | "repo";
  scopeId?: string;
  at: number;
  count: number;
}

export interface UsageEntry {
  sentToAIAt?: number;
  pastedAt?: number;
  branch?: string;
  branchAt?: number;
}

export interface FavoriteBucket {
  projects?: string[];
  repos?: string[];
  branches?: string[];
}

export interface PendingOAuth {
  state: string;
  /** Instance id (multi-account); `provider` is kept for older pending records. */
  instance?: string;
  /** Platform id (for the adapter and event payloads). */
  platform?: string;
  /** @deprecated legacy field: same value as `instance` in pre-multi-account records. */
  provider: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  createdAt: number;
}

export interface StateFile {
  favorites: Record<string, FavoriteBucket>;
  recents: RecentEntry[];
  usage: Record<string, UsageEntry>;
  oauth: Record<string, PendingOAuth>;
  /** Last "seen" mark per work-item scope, keyed by instance id (tree badges). */
  seen?: Record<string, Record<string, SeenMark>>;
}

export interface SeenMark {
  seenAt: number;
  seenCount?: number;
  scopeKind?: string;
  scopeLabel?: string;
}

export interface GlobalConfig {
  defaultProvider?: string;
  /** Preferred instance id (multi-account). Falls back to defaultProvider for old configs. */
  defaultInstance?: string;
  pageSize: number;
  excludeClosed: boolean;
  callbackMode: "page" | "loopback";
  /** Base URL for the OAuth landing page (default: CLI default port 30141). */
  oauthCallbackBase: string;
  /** Local clone scan roots (defaults to ~/workspace). */
  localRoots: string[];
  /** DCR registrations shared by every account on the same site (keyed by base URL). */
  dcrClients?: Record<string, { clientId: string; redirects: string[]; at: number }>;
  templates: { paste: string; ai: string; branch: string };
}

export interface StoreDirs {
  configDir: string;
  stateDir: string;
  cacheDir: string;
}

const STATE_LIMIT = 50;
const OAUTH_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 300;

const DEFAULTS: GlobalConfig = {
  pageSize: 50,
  excludeClosed: true,
  callbackMode: "page",
  oauthCallbackBase: "http://127.0.0.1:30141",
  localRoots: ["~/workspace"],
  templates: { ...DEFAULT_TEMPLATES },
};

function atomicWrite(path: string, text: string): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
  } catch {
    /* ignore */
  }
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows */
  }
  renameSync(tmp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export function recentScore(entry: { at: number; count: number }, now = Date.now()): number {
  const days = Math.max(0, (now - entry.at) / 86_400_000);
  const time = Math.min(1, Math.max(0, Math.exp(-days / 7)));
  const freq = Math.min(1, Math.max(0, Math.log(1 + Math.max(0, entry.count)) / Math.log(101)));
  return 0.6 * time + 0.4 * freq;
}

export function fingerprintOf(token: string | undefined): string {
  if (!token) return "anon";
  return createHash("sha256").update(String(token)).digest("hex").slice(0, 10);
}

export function redactProviderConfig(cfg: ProviderConfig): Record<string, unknown> {
  const { token, refreshToken, clientSecret, ...rest } = cfg;
  return {
    ...rest,
    hasToken: !!token,
    hasRefreshToken: !!refreshToken,
    hasClientSecret: !!clientSecret,
  };
}

export class Store {
  readonly dirs: StoreDirs;
  private globalCache: GlobalConfig | null = null;
  private stateCache: StateFile | null = null;

  constructor(dirs: StoreDirs) {
    this.dirs = dirs;
    mkdirSync(join(dirs.configDir, "providers"), { recursive: true });
    mkdirSync(dirs.stateDir, { recursive: true });
    mkdirSync(dirs.cacheDir, { recursive: true });
  }

  /* ───────────── global config ───────────── */

  global(): GlobalConfig {
    if (this.globalCache) return this.globalCache;
    const raw = readJson<Partial<GlobalConfig>>(join(this.dirs.configDir, "config.json"), {});
    this.globalCache = {
      ...DEFAULTS,
      ...raw,
      templates: { ...DEFAULTS.templates, ...(raw.templates || {}) },
    };
    return this.globalCache;
  }

  saveGlobal(patch: Partial<GlobalConfig>): GlobalConfig {
    const cur = this.global();
    const next: GlobalConfig = {
      ...cur,
      ...patch,
      templates: { ...cur.templates, ...(patch.templates || {}) },
      callbackMode: patch.callbackMode === "loopback" ? "loopback" : patch.callbackMode === "page" ? "page" : cur.callbackMode,
      pageSize: clampPageSize(patch.pageSize ?? cur.pageSize),
      oauthCallbackBase: String(patch.oauthCallbackBase ?? cur.oauthCallbackBase ?? "").trim().replace(/\/+$/, "") || DEFAULTS.oauthCallbackBase,
      localRoots: Array.isArray(patch.localRoots)
        ? patch.localRoots.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
        : cur.localRoots,
      defaultInstance: String(patch.defaultInstance ?? cur.defaultInstance ?? "").trim() || undefined,
    };
    if (!next.defaultInstance) delete next.defaultInstance;
    this.globalCache = next;
    atomicWrite(join(this.dirs.configDir, "config.json"), JSON.stringify(next, null, 2));
    return next;
  }

  /* ───────────── per-provider config (keyed by instance id) ───────────── */

  private providerPath(id: string): string {
    // Instance ids come from clients: never let a crafted id escape the providers dir.
    const safe = isValidInstanceId(String(id || "")) ? String(id) : "__invalid__";
    return join(this.dirs.configDir, "providers", `${safe}.json`);
  }

  provider(id: string): ProviderConfig {
    return readJson<ProviderConfig>(this.providerPath(id), {});
  }
  saveProvider(id: string, patch: Partial<ProviderConfig>): ProviderConfig {
    const cur = this.provider(id);
    const next: ProviderConfig = { ...cur, ...patch };
    // "keep the old value" semantics for secrets: undefined / "" keeps, null clears.
    for (const key of ["token", "refreshToken", "clientSecret"] as const) {
      const v = (patch as Record<string, unknown>)[key];
      if (v === undefined) {
        (next as Record<string, unknown>)[key] = cur[key];
      } else if (v === null) {
        delete (next as Record<string, unknown>)[key];
      }
    }
    atomicWrite(this.providerPath(id), JSON.stringify(next, null, 2));
    return next;
  }

  clearProvider(id: string): void {
    try {
      rmSync(this.providerPath(id), { force: true });
    } catch {
      /* ignore */
    }
  }

  /* ───────────── instances ───────────── */

  /** Every configured account, ordered by platform creation order (createdAt). */
  instances(): ProviderInstance[] {
    const dir = join(this.dirs.configDir, "providers");
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: ProviderInstance[] = [];
    for (const name of names) {
      // .json only: also filters atomicWrite temp files (.tmp-<pid>-<rand>).
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!isValidInstanceId(id)) continue;
      const file = join(dir, name);
      const cfg = readJson<ProviderConfig>(file, {});
      let mtime = Date.now();
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        /* ignore */
      }
      out.push(instanceFromConfig(id, cfg, mtime));
    }
    out.sort((a, b) => a.platform.localeCompare(b.platform) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return out;
  }

  instancesOf(platform: string): ProviderInstance[] {
    return this.instances().filter((i) => i.platform === platform);
  }

  hasInstance(id: string): boolean {
    const safe = String(id || "");
    if (!isValidInstanceId(safe)) return false;
    return existsSync(this.providerPath(safe));
  }

  /** Resolve an alias / slug / instance id to an instance id on one platform. */
  resolveInstance(platform: string, account: string): string | undefined {
    const want = String(account || "").trim();
    if (!want) return undefined;
    const list = this.instancesOf(platform);
    const hit = list.find((i) => i.id === want || sameAlias(i.alias, want) || i.id === `${platform}~${want.toLowerCase()}`);
    return hit?.id;
  }

  createInstance(platform: string, aliasRaw: string, extra: Partial<ProviderConfig> = {}): ProviderInstance {
    const alias = normalizeAlias(aliasRaw);
    const existing = this.instancesOf(platform);
    if (existing.length >= MAX_INSTANCES_PER_PLATFORM) {
      throw new ForgeHttpError(`At most ${MAX_INSTANCES_PER_PLATFORM} accounts per platform`, { status: 400, code: "bad_request" });
    }
    if (existing.some((i) => sameAlias(i.alias, alias))) {
      throw new ForgeHttpError(`Alias already in use: ${alias}`, { status: 409, code: "bad_request" });
    }
    const taken = new Set(this.instances().map((i) => i.id));
    // The first account of a platform materializes the default instance (id = platform),
    // so the virtual "not configured" row is replaced instead of gaining a sibling.
    const id = existing.length === 0 ? platform : deriveInstanceId(platform, alias, taken);
    const createdAt = Date.now();
    this.saveProvider(id, { ...extra, platform, alias, aliasAuto: true, createdAt });
    return { id, platform, alias, createdAt };
  }

  renameInstance(id: string, aliasRaw: string): ProviderInstance {
    if (!this.hasInstance(id)) throw new ForgeHttpError(`unknown account: ${id}`, { status: 404, code: "not_found" });
    const alias = normalizeAlias(aliasRaw);
    const platform = platformOf(id);
    if (this.instancesOf(platform).some((i) => i.id !== id && sameAlias(i.alias, alias))) {
      throw new ForgeHttpError(`Alias already in use: ${alias}`, { status: 409, code: "bad_request" });
    }
    const cfg = this.saveProvider(id, { alias, aliasAuto: false });
    return { id, platform, alias: String(cfg.alias || alias), createdAt: Number(cfg.createdAt) || Date.now() };
  }

  /** Delete an instance and every piece of per-instance state. */
  deleteInstance(id: string): boolean {
    if (!this.hasInstance(id)) return false;
    this.clearProvider(id);
    try {
      this.clearCache(id);
    } catch {
      /* ignore */
    }
    const s = this.state();
    delete s.favorites[id];
    s.recents = s.recents.filter((r) => r.provider !== id);
    for (const key of Object.keys(s.usage)) {
      if (key === id || key.startsWith(`${id}:`)) delete s.usage[key];
    }
    for (const [state, pending] of Object.entries(s.oauth)) {
      if ((pending.instance || pending.provider) === id) delete s.oauth[state];
    }
    this.persistState();
    const g = this.global();
    if (g.defaultInstance === id || g.defaultProvider === id) {
      const next = { ...g };
      delete next.defaultInstance;
      if (next.defaultProvider === id) delete next.defaultProvider;
      this.globalCache = next;
      atomicWrite(join(this.dirs.configDir, "config.json"), JSON.stringify(next, null, 2));
    }
    return true;
  }

  /* ───────────── shared OAuth DCR registrations (per site) ───────────── */

  /** Site key for DCR sharing: scheme+host(+path), no trailing slash. */
  private siteKey(baseUrl: string): string {
    return String(baseUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  }

  dcrClient(baseUrl: string): { clientId: string; redirects: string[] } | undefined {
    const key = this.siteKey(baseUrl);
    if (!key) return undefined;
    const hit = this.global().dcrClients?.[key];
    return hit?.clientId ? { clientId: hit.clientId, redirects: Array.isArray(hit.redirects) ? hit.redirects : [] } : undefined;
  }

  saveDcrClient(baseUrl: string, clientId: string, redirects: string[]): void {
    const key = this.siteKey(baseUrl);
    if (!key || !clientId) return;
    const cur = this.global().dcrClients || {};
    this.saveGlobal({
      dcrClients: { ...cur, [key]: { clientId, redirects: [...redirects], at: Date.now() } },
    });
  }

  setTokens(id: string, tokens: OAuthTokens, patch: Partial<ProviderConfig> = {}): ProviderConfig {
    const next: Partial<ProviderConfig> = {
      ...patch,
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiry: tokens.expiry,
      needsLogin: false,
    };
    if (tokens.refreshToken === undefined) {
      const cur = this.provider(id);
      next.refreshToken = cur.refreshToken;
    }
    return this.saveProvider(id, next);
  }

  /* ───────────── state ───────────── */

  private statePath(): string {
    return join(this.dirs.stateDir, "state.json");
  }

  state(): StateFile {
    if (this.stateCache) return this.stateCache;
    const raw = readJson<Partial<StateFile>>(this.statePath(), {});
    this.stateCache = {
      favorites: raw.favorites || {},
      recents: Array.isArray(raw.recents) ? raw.recents : [],
      usage: raw.usage || {},
      oauth: raw.oauth || {},
      seen: raw.seen || {},
    };
    return this.stateCache;
  }

  private persistState(): void {
    const s = this.state();
    atomicWrite(this.statePath(), JSON.stringify(s, null, 2));
  }

  addRecent(entry: Omit<RecentEntry, "at" | "count"> & { at?: number; count?: number }): RecentEntry[] {
    const s = this.state();
    const at = entry.at ?? Date.now();
    const idx = s.recents.findIndex((r) => r.provider === entry.provider && r.kind === entry.kind && r.id === entry.id);
    if (idx >= 0) {
      const cur = s.recents[idx];
      s.recents[idx] = { ...cur, ...entry, at, count: cur.count + 1 };
    } else {
      s.recents.push({ ...entry, at, count: entry.count ?? 1 });
    }
    s.recents.sort((a, b) => recentScore(b) - recentScore(a));
    if (s.recents.length > STATE_LIMIT) s.recents = s.recents.slice(0, STATE_LIMIT);
    this.persistState();
    return s.recents;
  }

  favorites(provider?: string): Record<string, FavoriteBucket> {
    const all = this.state().favorites;
    if (!provider) return all;
    return { [provider]: all[provider] || {} };
  }

  /** Seen marks of one instance: scopeId → mark. */
  seenMarks(instance: string): Record<string, SeenMark> {
    return this.state().seen?.[instance] || {};
  }

  /** Record "user looked at this scope now" and invalidate counts cache for the instance. */
  markSeen(instance: string, scopeId: string, mark: { scopeKind?: string; scopeLabel?: string; seenCount?: number }): SeenMark {
    const s = this.state();
    if (!s.seen) s.seen = {};
    const bucket = s.seen[instance] || (s.seen[instance] = {});
    const prev = bucket[scopeId];
    const next: SeenMark = {
      seenAt: Date.now(),
      seenCount: mark.seenCount ?? prev?.seenCount,
      scopeKind: mark.scopeKind ?? prev?.scopeKind,
      scopeLabel: mark.scopeLabel ?? prev?.scopeLabel,
    };
    bucket[scopeId] = next;
    this.persistState();
    // stale badge data for this instance: drop cached counts
    this.clearCountsCache(instance);
    return next;
  }

  /** Drop the per-scope counts cache of one instance (same fingerprint the counts writes use). */
  clearCountsCache(instance: string): void {
    const file = join(this.cacheDir(instance, fingerprintOf("wi-counts")), "cache.json");
    try {
      rmSync(file, { force: true });
    } catch { /* ignore */ }
  }

  toggleFavorite(provider: string, kind: "projects" | "repos" | "branches", id: string): boolean {
    const s = this.state();
    const bucket = (s.favorites[provider] ||= {});
    const list = (bucket[kind] ||= []);
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    this.persistState();
    return idx < 0;
  }

  usageKey(provider: string, workitemId: string): string {
    return `${provider}:${workitemId}`;
  }

  usage(provider: string, workitemId: string): UsageEntry {
    return this.state().usage[this.usageKey(provider, workitemId)] || {};
  }

  markUsage(provider: string, workitemId: string, kind: "ai" | "paste" | "branch", branch?: string): UsageEntry {
    const s = this.state();
    const key = this.usageKey(provider, workitemId);
    const cur = s.usage[key] || {};
    const next: UsageEntry = { ...cur };
    if (kind === "ai") next.sentToAIAt = Date.now();
    if (kind === "paste") next.pastedAt = Date.now();
    if (kind === "branch") {
      next.branch = branch;
      next.branchAt = Date.now();
    }
    s.usage[key] = next;
    this.persistState();
    return next;
  }

  /* ───────────── pending OAuth ───────────── */

  putOauthPending(p: PendingOAuth): void {
    const s = this.state();
    s.oauth[p.state] = p;
    this.pruneOauthPending();
    this.persistState();
  }

  takeOauthPending(state: string): PendingOAuth | undefined {
    const s = this.state();
    this.pruneOauthPending();
    const p = s.oauth[state];
    if (!p) return undefined;
    delete s.oauth[state];
    this.persistState();
    return p;
  }

  pruneOauthPending(): void {
    const s = this.state();
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(s.oauth)) {
      if (!v || now - v.createdAt > OAUTH_TTL_MS) {
        delete s.oauth[k];
        changed = true;
      }
    }
    if (changed) this.persistState();
  }

  /* ───────────── cache ───────────── */

  private cacheDir(provider: string, fp: string): string {
    return join(this.dirs.cacheDir, provider, fp);
  }

  cacheGet<T>(provider: string, token: string | undefined, key: string, ttlMs: number): T | undefined {
    const file = join(this.cacheDir(provider, fingerprintOf(token)), "cache.json");
    const map = readJson<Record<string, { at: number; data: T }>>(file, {});
    const hit = map[key];
    if (!hit) return undefined;
    if (Date.now() - hit.at > ttlMs) return undefined;
    return hit.data;
  }

  cacheSet<T>(provider: string, token: string | undefined, key: string, value: T): void {
    const dir = this.cacheDir(provider, fingerprintOf(token));
    const file = join(dir, "cache.json");
    const map = readJson<Record<string, { at: number; data: T }>>(file, {});
    map[key] = { at: Date.now(), data: value };
    const keys = Object.keys(map);
    if (keys.length > CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => map[a].at - map[b].at);
      for (const k of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete map[k];
    }
    atomicWrite(file, JSON.stringify(map));
  }

  clearCache(provider?: string): void {
    const base = this.dirs.cacheDir;
    try {
      if (provider) rmSync(join(base, provider), { recursive: true, force: true });
      else {
        for (const name of readdirSync(base)) {
          const p = join(base, name);
          if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
        }
      }
    } catch {
      /* ignore */
    }
  }
}

function clampPageSize(n: number | undefined): number {
  const v = Number(n) || DEFAULTS.pageSize;
  return Math.min(100, Math.max(10, Math.floor(v)));
}

/** Client-facing config view (global + per-provider, secrets redacted). */
export function configView(store: Store, providers: string[]): Record<string, unknown> {
  const g = store.global();
  const per: Record<string, unknown> = {};
  for (const id of providers) per[id] = redactProviderConfig(store.provider(id));
  return {
    global: g,
    providers: per,
  };
}
