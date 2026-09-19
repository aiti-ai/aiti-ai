/**
 * Extension registry — owns loading, lifecycle, API dispatch, middleware
 * chaining and manifest generation. One instance per server process, held on
 * globalThis.__piWebExt so the middleware bundle (proxy.ts, separate Next
 * bundle) can invoke hooks without importing extension code.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join, sep } from "path";
import type {
  AgentSessionInfo,
  ExtAgentEndReason,
  ExtAgentHooks,
  ExtApiContext,
  ExtCoreApi,
  ExtDepResolution,
  ExtFeature,
  ExtMiddlewareResult,
  ExtServerContext,
  ExtServerHooks,
  ExtStatusFeature,
  ExtUiDefinition,
  ExtensionSource,
  LoadedExtension,
  ManifestExtension,
} from "./types.ts";
import { dataRoot, extensionsRoot, bundledExtensionsRoot, devExtensionsRoot, extraExtensionsRoots } from "./data-dir.ts";
import { loadExtensionFromDir, scanExtensionDirs, compareExtVersions, snapshotJitiCache, countRetranspiled } from "./loader.ts";
import { extProtocolInfo, EXT_PROTOCOL_VERSION, EXT_PROTOCOL_MIN_MAJOR, EXT_PROTOCOL_STRICT_BLOCKED, type ExtProtocolInfo } from "./protocol.ts";
import { buildBootGraph, type PiWebBootGraph } from "./client-modules.ts";
import { buildClientBundle, emptyClientBundleCode, usesImportMeta, type ClientBundleEntry } from "./client-bundle.ts";
import { ExtServicesRegistry } from "./services.ts";
import { invokeAI as aiInvokeImpl } from "../ai-invoke.ts";
import { registerExtensionProvider, removeProvider as removeProviderFromRegistry, cleanupAllExtensionProviders, findProvidersForAgent } from "../session/providers.ts";
import { openExternalSession } from "../session/index.ts";
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

const DISABLED_FILE = "disabled-extensions.json";
/** Feature-flag persistence: <dataRoot>/features.json → { [extId]: { [featureId]: boolean | string } } (only explicit settings are stored; defaults are not written). */
const FEATURES_FILE = "features.json";
/** Dependency/capability pin persistence (P2): <dataRoot>/ext-pins.json. Same mechanism as disabled/features (dataRoot; dev instances isolate automatically). */
const PINS_FILE = "ext-pins.json";

/** ExtUiDefinition slot keys holding item arrays (the extension-manager UI counts insertion points from these). */
const UI_SLOT_KEYS = [
  "toolbar",
  "sidebar",
  "sidebarFooter",
  "sessionTopbar",
  "sessionRowActions",
  "sessionRowMeta",
  "sidebarProjects", // sidebar "Projects" session list fully taken over (session-manager SidebarClone)
  "dialogs",
  "banners",
  "pages",
  "chatInputTop",
  "sidebarExplorerDock", // float-dock extension v0.5.0: sidebar dock zone
  "rightFileDock",       // float-dock extension v0.5.0: right dock zone (tabbed)
  "sidebarTasks",        // float-dock extension v0.5.1: sidebar tasks zone
] as const;

const SERVER_HOOK_KEYS = ["startup", "shutdown", "api", "middleware"] as const;
const AGENT_HOOK_KEYS = ["agentTools", "onAgentSession", "onAgentSessionEnd", "onAgentSettled"] as const;

/** One entry of the status API (consumed by the extension-manager UI). */
export interface ExtStatusEntry {
  loaded: boolean;
  /** false = listed in disabled-extensions.json (skipped by loadAll; no code executed). */
  enabled?: boolean;
  error?: string;
  name?: string;
  version?: string;
  source?: ExtensionSource;
  icon?: string | null;
  /** Code directory (also present for disabled/failed entries). */
  dir?: string;
  /** Config area (backup scope); stateDir = persistent data area (non-regenerable); cacheDir = cache area (safe to delete and rebuild). dataDir was split into these three tiers (data layering). */
  configDir?: string;
  stateDir?: string;
  cacheDir?: string;
  /** Client bundle file + content hash (only when a client exists). */
  client?: { file: string; hash: string } | null;
  /** Insertion points: slot name → item id list (only when ui is declared). */
  slots?: Record<string, string[]>;
  /** Taken-over built-in capabilities (EXT_PROVIDES). */
  provides?: string[];
  /** Other extension ids this client depends on (boot-graph inject edges). */
  clientDependsOn?: string[];
  /** i18n locale table. */
  i18nLocales?: string[];
  /** Server hooks (listed when present). */
  serverHooks?: string[];
  /** Agent session hooks (plan-M extension point). */
  agentHooks?: string[];
  /** Feature management: declarations + current on/off state (only when the extension declares features). */
  features?: ExtStatusFeature[];
  /** Static info from the directory's package.json (no code executed). homepage = source/docs URL (written at install time or declared by the author); soul = tagline (shown by the extension manager); protocol = raw aitiExtProtocol declaration. */
  packageInfo?: { name?: string; version?: string; dependencies?: string[]; homepage?: string; soul?: string; protocol?: string };
  /** Protocol declaration and compatibility state (adjudicated by the host; docs/pi-web-ext-protocol.md). */
  protocol?: ExtProtocolInfo;
  /** Hard dependency declarations (dependency & capability model: elements are extension ids or capability names). */
  dependsOn?: string[];
  /** Optional dependency declarations (declarative only; absence has no effect and is not warned about). */
  optionalDependsOn?: string[];
  /** Provided capabilities (provides declarations; distinct from built-in takeovers via ui.provides). */
  capsProvides?: string[];
  /** Exclusively taken-over features (takeover declarations). */
  capsTakeover?: string[];
  /** Dependency resolution results (all hard + optional edges; resolved by core, rendered by the extension manager). */
  depsResolved?: ExtDepResolution[];
  /** Takeover effective state (when multiple declarers claim the same feature, exactly one has effective=true). */
  takeoverResolved?: Array<{ name: string; effective: boolean }>;
}

/** One entry of statusPayload.capabilities: capability name → providers/effective/consumers (data source for the extension manager's capability view). */
export interface CapabilityViewEntry {
  /** All providers (provides ∪ takeover declarers, with version/source and whether declared via takeover). */
  providers: Array<{ id: string; version: string; source?: ExtensionSource; takeover: boolean }>;
  /** Effective provider (resolution: pin > takeover > newest semver > id lexicographic); null when no provider exists (missing). */
  effective: string | null;
  /** User-pinned provider (absent when unpinned or the pin is stale). */
  pinnedTo?: string;
  /** Consumers (loaded extensions whose dependsOn/optionalDependsOn names this capability without hitting an extension id). */
  consumers: Array<{ extId: string; hard: boolean }>;
}

/** One entry of statusPayload.multiSource: multi-source group for the same id (only when >1 candidates; data source for the extension manager's conflict/version management). */
export interface MultiSourceGroup {
  candidates: Array<{ dir: string; source: ExtensionSource; version?: string; winner: boolean }>;
}

/** Dedupe set for protocol-declaration warnings (process-wide: reloads don't re-spam non-ok states). */
const protocolWarned = new Set<string>();

/** Strict refusal-to-load switch (default off; stale is not in the refuse set — the host keeps a compat layer). */
function protocolStrict(): boolean {
  return process.env.PI_WEB_EXT_PROTOCOL_STRICT === "1";
}

/** Read an extension directory's package.json without executing code (disabled entries still get name/version/deps/source URL). */
function readPackageInfo(dir?: string): { name?: string; version?: string; dependencies?: string[]; homepage?: string; soul?: string; protocol?: string } {
  if (!dir) return {};
  try {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8")) as {
      name?: unknown;
      version?: unknown;
      dependencies?: unknown;
      homepage?: unknown;
      url?: unknown;
      repository?: unknown;
      soul?: unknown;
      aitiExtProtocol?: unknown;
    };
    // homepage → url → repository (string or {url}), in descending priority.
    const repoUrl = typeof parsed.repository === "string"
      ? parsed.repository
      : parsed.repository && typeof parsed.repository === "object" && typeof (parsed.repository as { url?: unknown }).url === "string"
        ? (parsed.repository as { url: string }).url
        : undefined;
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      dependencies:
        parsed.dependencies && typeof parsed.dependencies === "object"
          ? Object.keys(parsed.dependencies as Record<string, unknown>)
          : undefined,
      homepage: typeof parsed.homepage === "string" ? parsed.homepage
        : typeof parsed.url === "string" ? parsed.url
        : repoUrl,
      soul: typeof parsed.soul === "string" && parsed.soul.trim() ? parsed.soul.trim() : undefined,
      // raw protocol declaration (string validation left to extProtocolInfo — non-string types like numbers count as invalid)
      protocol: parsed.aitiExtProtocol === undefined ? undefined : String(parsed.aitiExtProtocol),
    };
  } catch {
    return {};
  }
}

function collectSlots(ui?: ExtUiDefinition): Record<string, string[]> | undefined {
  if (!ui) return undefined;
  const slots: Record<string, string[]> = {};
  for (const key of UI_SLOT_KEYS) {
    const items = ui[key];
    if (Array.isArray(items) && items.length > 0) slots[key] = items.map((it) => it.id);
  }
  return Object.keys(slots).length > 0 ? slots : undefined;
}

/**
 * Candidate version (for same-id arbitration): package.json version first,
 * falling back to the entry-declared version when missing (probed once via lazy
 * load, result cached). Probe failure counts as unknown — the real error
 * surfaces when the winning candidate is formally loaded. Note: only called for
 * "same-id conflict" candidates, and disabled extensions are never probed
 * (the no-code-execution invariant).
 */
async function candidateVersion(dir: string, cache: Map<string, string | undefined>): Promise<string | undefined> {
  if (cache.has(dir)) return cache.get(dir);
  let v = readPackageInfo(dir).version;
  if (v === undefined) {
    try {
      const ext = await loadExtensionFromDir(dir);
      v = ext?.version;
    } catch {
      v = undefined;
    }
  }
  cache.set(dir, v);
  return v;
}

/** Pin persistence file structure (<dataRoot>/ext-pins.json). */
interface ExtPins {
  /** Dev-debug priority (during same-id multi-source arbitration the dev-root candidate wins outright; default off — preserves the existing arbitration contract, developers opt in explicitly). */
  devPriority?: boolean;
  /** Pin table: "source:<extId>" → candidate dir; "capability:<cap>" → provider extension id. */
  pins?: Record<string, string>;
}

export class ExtRegistryImpl {
  core: ExtCoreApi;
  /** ctx.services locator core (§4-A): provide/get/require/onChange + reload teardown. */
  readonly services = new ExtServicesRegistry();
  /** Change listeners for ctx.features.on (fired after setFeatureValue; cleared per cycle on shutdown). */
  private featureListeners = new Set<() => void>();
  /** Pin file cache (invalidated by mtime, same pattern as disabledCache). */
  private pinsCache: { mtimeMs: number; data: ExtPins } | null = null;
  private readonly extensionsRootOverride?: string;
  private readonly extraExtensionsRootsOverride?: string[];
  private readonly devExtensionsRootOverride?: string | null;
  private readonly bundledExtensionsRootOverride?: string;
  private readonly dataRootOverride?: string;
  private extensions = new Map<string, LoadedExtension>();
  /** Same-id arbitration result (filled by loadAll): id → winning candidate. status() reuses it to keep shadowing consistent. */
  private winners = new Map<string, { dir: string; source: ExtensionSource }>();
  /** Multi-source candidate groups for the same id (filled by loadAll, only ids with >1 candidates; multiSource panel data source). */
  private candidates = new Map<string, MultiSourceGroup["candidates"]>();
  /** Capability registry (rebuilt by loadAll): capability name → all providers (provides ∪ takeover declarers). Input to the resolver. */
  private _caps = new Map<string, Array<{ id: string; version: string; source?: ExtensionSource; takeover: boolean }>>();
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

  // ── enabled/disabled ───────────────────────────────────────────────────────
  // Persisted to <dataRoot>/disabled-extensions.json (an array); disabled
  // extensions are skipped at loadAll (status marks enabled:false), and
  // re-enable + reload restores them.

  private disabledCache: { mtimeMs: number; set: Set<string> } | null = null;
  private disabledExtensions(): Set<string> {
    const file = join(this.dataRoot(), DISABLED_FILE);
    try {
      const st = statSync(file);
      if (this.disabledCache && this.disabledCache.mtimeMs === st.mtimeMs) return this.disabledCache.set;
      const raw = readFileSync(file, "utf8");
      const set = new Set(JSON.parse(raw) as string[]);
      this.disabledCache = { mtimeMs: st.mtimeMs, set };
      return set;
    } catch {
      return new Set();
    }
  }

  private persistDisabled(set: Set<string>): void {
    try {
      writeFileSync(join(this.dataRoot(), DISABLED_FILE), JSON.stringify([...set].sort(), null, 2));
    } catch (e) {
      console.error("[ext] failed to persist disabled extensions:", e);
    }
  }

  isEnabled(id: string): boolean {
    return !this.disabledExtensions().has(id);
  }

  /**
   * Enable/disable an extension (persisted). Callers should follow up with
   * reload() (or loadAll+startAll) for the change to take effect.
   */
  setEnabled(id: string, enabled: boolean): void {
    const set = new Set(this.disabledExtensions());
    if (enabled) set.delete(id);
    else set.add(id);
    this.persistDisabled(set);
    this.disabledCache = null; // invalidate the cache (re-read from disk next time)
  }

  // ── pins (dependency & capability model P2: conflict/version management) ──
  // Persisted to <dataRoot>/ext-pins.json: { devPriority?: boolean, pins: { [key]: value } }.
  // Key conventions: "source:<extId>" → value = candidate dir (user-picked source
  //                   among same-id multi-source candidates);
  //                   "capability:<cap>" → value = provider extension id (user-picked
  //                   effective provider for a capability).
  // Pins are soft-validated at arbitration (value outside the candidate/provider
  // set → ignored, back to auto); clearExtPins cleans up on uninstall.

  private extPins(): ExtPins {
    const file = join(this.dataRoot(), PINS_FILE);
    try {
      const st = statSync(file);
      if (this.pinsCache && this.pinsCache.mtimeMs === st.mtimeMs) return this.pinsCache.data;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as ExtPins;
      const data = parsed && typeof parsed === "object" ? parsed : {};
      this.pinsCache = { mtimeMs: st.mtimeMs, data };
      return data;
    } catch {
      return {};
    }
  }

  private persistPins(data: ExtPins): void {
    try {
      writeFileSync(join(this.dataRoot(), PINS_FILE), JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("[ext] failed to persist ext pins:", e);
    }
    this.pinsCache = null; // invalidate the cache (re-read from disk next time)
  }

  /** Set/clear a pin (null/undefined value clears). Callers should follow up with reload() for the arbitration to take effect. */
  setPin(key: string, value: string | null): void {
    const data = this.extPins();
    const pins = { ...(data.pins ?? {}) };
    if (value) pins[key] = value;
    else delete pins[key];
    this.persistPins({ ...data, pins });
  }

  /** Dev-debug priority switch (same-id multi-source arbitration: pin > dev priority > version > root order; default off, explicit opt-in). */
  setDevPriority(on: boolean): void {
    this.persistPins({ ...this.extPins(), devPriority: on });
  }

  /** Current value of the dev-debug priority switch (default off). */
  devPriorityEnabled(): boolean {
    return this.extPins().devPriority === true;
  }

  /** Clean up an extension's pins on uninstall: delete its source pin directly, plus capability pins whose value matches. */
  clearExtPins(extId: string): void {
    const data = this.extPins();
    const pins = { ...(data.pins ?? {}) };
    let changed = false;
    if (("source:" + extId) in pins) { delete pins["source:" + extId]; changed = true; }
    for (const [k, v] of Object.entries(pins)) {
      if (k.startsWith("capability:") && v === extId) { delete pins[k]; changed = true; }
    }
    if (changed) this.persistPins({ ...data, pins });
  }

  // ── feature management ───────────────────────────────────────────────────
  // Extensions declare features (a capability checklist) in their entry; users
  // toggle each item via the extension manager. Explicit settings persist to
  // <dataRoot>/features.json and are merged with declared defaults on read.

  private featureCache: { mtimeMs: number; flags: Record<string, Record<string, boolean | string>> } | null = null;
  private featureFlags(): Record<string, Record<string, boolean | string>> {
    const file = join(this.dataRoot(), FEATURES_FILE);
    try {
      const st = statSync(file);
      if (this.featureCache && this.featureCache.mtimeMs === st.mtimeMs) return this.featureCache.flags;
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, Record<string, boolean | string>>;
      this.featureCache = { mtimeMs: st.mtimeMs, flags: parsed ?? {} };
      return this.featureCache.flags;
    } catch {
      return {};
    }
  }

  private persistFeatureFlags(flags: Record<string, Record<string, boolean | string>>): void {
    try {
      writeFileSync(join(this.dataRoot(), FEATURES_FILE), JSON.stringify(flags, null, 2));
    } catch (e) {
      console.error("[ext] failed to persist feature flags:", e);
    }
    this.featureCache = null; // invalidate the cache (re-read from disk next time)
  }

  /** A feature from the extension's declarations (by id). */
  private declaredFeature(extId: string, featureId: string): ExtFeature | undefined {
    const ext = this.extensions.get(extId);
    return ext?.ext.features?.find((f) => f.id === featureId);
  }

  /**
   * Whether a boolean-type feature is currently enabled: the user's explicit
   * setting wins, otherwise the declared default (default true). Queried by
   * extensions/collectAgentTools; undeclared or unknown features always count
   * as enabled (no gating). string/textlist features have no on/off semantics
   * and always return true (query their value via featureValue).
   */
  featureEnabled(extId: string, featureId: string): boolean {
    const declared = this.declaredFeature(extId, featureId);
    if (declared && this.isTextualFeature(declared)) return true;
    const explicit = this.featureFlags()[extId]?.[featureId];
    if (typeof explicit === "boolean") return explicit;
    return declared?.default !== false;
  }

  /**
   * Current feature value (string type): the user's explicit setting wins,
   * otherwise the declared value (default ""). Boolean features return the
   * featureEnabled result (truthiness).
   */
  featureValue(extId: string, featureId: string): boolean | string {
    const declared = this.declaredFeature(extId, featureId);
    if (declared && this.isTextualFeature(declared)) {
      const explicit = this.featureFlags()[extId]?.[featureId];
      if (typeof explicit === "string") return explicit;
      return declared.value ?? "";
    }
    return this.featureEnabled(extId, featureId);
  }

  /** Textual features (string single-line / textlist multi-line): no on/off semantics; values go through featureValue */
  private isTextualFeature(declared: { type?: "boolean" | "string" | "textlist" }): boolean {
    return declared.type === "string" || declared.type === "textlist";
  }

  /**
   * Set a boolean feature on/off (persisted). When the explicit setting equals
   * the declared default the entry is removed (keeps the file clean). Returns
   * the feature's new effective state.
   */
  setFeatureFlag(extId: string, featureId: string, enabled: boolean): boolean {
    this.setFeatureValue(extId, featureId, enabled);
    return this.featureEnabled(extId, featureId);
  }

  /**
   * Set a feature value (boolean | string, persisted). Entries matching the
   * default are removed (keeps the file clean). For string type, an empty
   * string equal to the declared default is removed. Returns the feature's new value.
   */
  setFeatureValue(extId: string, featureId: string, value: boolean | string): boolean | string {
    const flags = this.featureFlags();
    const per = { ...(flags[extId] ?? {}) };
    const declared = this.declaredFeature(extId, featureId);
    const isString = declared && this.isTextualFeature(declared);
    const isDefault = isString
      ? String(value) === (declared.value ?? "")
      : value === (declared ? declared.default !== false : true);
    if (declared && isDefault) {
      delete per[featureId]; // equals the default → not persisted
    } else {
      per[featureId] = value;
    }
    const next = { ...flags };
    if (Object.keys(per).length > 0) next[extId] = per;
    else delete next[extId];
    this.persistFeatureFlags(next);
    this.notifyFeatureListeners();
    return this.featureValue(extId, featureId);
  }

  /** Broadcast for ctx.features.on (fired after any feature change is persisted; listener errors don't break the loop). */
  private notifyFeatureListeners(): void {
    for (const cb of [...this.featureListeners]) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  /**
   * Collect all tools an extension injects into agent sessions (with feature
   * filtering). Per-tool convention: feature.id = "tool.<injected tool name>".
   * Disabled → filtered at injection + validated at execute time (already
   * injected tools in existing sessions are also rejected immediately).
   */
  /**
   * Collect one extension's agent tools (with gating).
   * `forced=true` (session-level force-enable): the extension was explicitly
   * named for this session, so all tools pass regardless of feature gating
   * (used for "enable on demand" — pass enableExts at session creation instead
   * of mutating global feature state; no races, no residue).
   * `forced=false`: normal feature gating (group gate / per-tool).
   */
  private collectExtAgentTools(ext: LoadedExtension, info: Pick<AgentSessionInfo, "sessionId" | "cwd">, forced = false): ToolDefinition[] {
    const t = this.agentHooks(ext)?.agentTools?.(info);
    if (!t) return [];

    // Session-level force-enable: bypass features, everything passes.
    // No execute-time gating wrapper — forced is this session's explicit
    // authorization (enableExtTools), so tools must stay usable for the whole
    // session and must not be revoked by global feature state (agentTools.enabled
    // still false in features.json would otherwise inject fine but reject on
    // first call).
    if (forced) {
      return t;
    }

    const declared = new Set(ext.ext.features?.map((f) => f.id) ?? []);
    const out: ToolDefinition[] = [];
    for (const tool of t) {
      const fid = "tool." + tool.name;
      const managed = declared.has(fid);
      // no group gate declared → pure per-tool semantics
      const hasWholeGate = (ext.ext.features ?? []).some((f) => f.id === "agentTools.enabled" && f.type !== "string");
      const wholeGateOn = hasWholeGate ? this.featureEnabled(ext.id, "agentTools.enabled") : true;
      // Group gate (coarse switch, overrides per-tool): off → none injected; on →
      // per-tool defaults ignored, everything passes.
      // No group gate declared → pure per-tool semantics (managed ? featureEnabled : true).
      const enabled = hasWholeGate ? wholeGateOn : (managed ? this.featureEnabled(ext.id, fid) : true);
      if (!enabled) continue;
      // when the group gate is on, the execute wrapper checks the group gate
      // (rejection is immediate); otherwise it checks the per-tool fid
      const checkFid = (hasWholeGate && wholeGateOn) ? "agentTools.enabled" : fid;
      if (!managed) { out.push(tool); continue; }
      out.push(this.wrapAgentToolExecute(ext, tool, checkFid));
    }
    return out;
  }

  /** execute wrapper: disabling takes effect immediately (in-memory cache read, negligible cost) — already injected tools in existing sessions are rejected too. */
  private wrapAgentToolExecute(ext: LoadedExtension, tool: ToolDefinition, checkFid: string): ToolDefinition {
    const orig = tool.execute;
    tool.execute = async (toolCallId, params, signal, onUpdate, extCtx) => {
      if (!this.featureEnabled(ext.id, checkFid)) {
        return {
          content: [{ type: "text", text: `[Feature management] Tool ${tool.name} is disabled (via the feature settings of extension ${ext.id}) — re-enable it in the extension manager and retry.` }],
          isError: true,
        } as never;
      }
      return orig
        ? orig(toolCallId, params, signal, onUpdate, extCtx)
        : ({ content: [{ type: "text", text: "" }] } as never);
    };
    return tool;
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

  /** Resolution order = priority: user → extra (env listing order) → dev (dev-exts dir) → bundled (fallback order for same id and version). */
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
   * failures never block others.
   *
   * Same-id arbitration (dependency & capability model §5.2): when the same id
   * appears in multiple roots —
   *   user pin (ext-pins.json source:<id>, value matching a candidate dir)
   *   > dev-debug priority (extPins.devPriority, default on; the dev-root
   *     candidate wins outright, addressing dev-exts development being shadowed
   *     by a "newer version" in the user root; only affects machines with a dev root)
   *   > higher version wins (candidate dir's package.json version, falling back
   *     to the entry version when missing)
   *   > root priority (user > extra > dev > bundled; the tiebreak for equal or
   *     unresolvable versions on both sides).
   * Losing candidates are shadowed (silently skipped); multi-candidate groups are
   * recorded in candidates (shown in the multiSource panel). If the winner fails
   * to load there is no fallback to losers (fail-fast, same as the old semantics —
   * silent fallback only makes "my change didn't take effect" harder to debug).
   * Disabled extensions are neither loaded nor version-probed (no code execution).
   */
  async loadAll(): Promise<void> {
    this.invalidateBootGraph();
    this.extensions.clear();
    this.errors.clear();
    this.winners.clear();
    this.candidates.clear();

    // 1) Collect candidates: enumerate in root-priority order, id → candidate array (array order = root priority).
    const candidates = new Map<string, Array<{ dir: string; source: ExtensionSource }>>();
    for (const { root, source } of this.extensionRoots()) {
      for (const dir of scanExtensionDirs(root)) {
        const id = dir.split(sep).pop() ?? dir;
        if (!candidates.has(id)) candidates.set(id, []);
        candidates.get(id)!.push({ dir, source });
      }
    }

    // 2) Arbitrate: pin > dev priority > version > root priority. Winners are
    //    cached for status() reuse; multi-candidate groups (with versions) are
    //    recorded in candidates (multiSource panel display + optional pinning).
    const disabled = this.disabledExtensions();
    const pinsData = this.extPins();
    const pinMap = pinsData.pins ?? {};
    const devPriority = pinsData.devPriority === true; // default off (decision reversed the plan's lean): the existing contract "dev copies don't steal extra/version arbitration" holds; developers opt in explicitly (extension-manager switch)
    const versionCache = new Map<string, string | undefined>();
    for (const [id, cands] of candidates) {
      let winner = cands[0];
      if (cands.length > 1 && !disabled.has(id)) {
        const vers = new Map<string, string | undefined>();
        for (const c of cands) vers.set(c.dir, await candidateVersion(c.dir, versionCache));
        const pinnedDir = pinMap["source:" + id];
        const pinned = pinnedDir ? cands.find((c) => c.dir === pinnedDir) : undefined;
        const devCand = devPriority ? cands.find((c) => c.source === "dev") : undefined;
        if (pinned) {
          winner = pinned;
        } else if (devCand) {
          winner = devCand;
        } else {
          let winnerVer = vers.get(winner.dir);
          for (let i = 1; i < cands.length; i++) {
            const ver = vers.get(cands[i].dir);
            if (compareExtVersions(ver, winnerVer) > 0) {
              winner = cands[i];
              winnerVer = ver;
            }
          }
        }
        this.candidates.set(id, cands.map((c) => ({
          dir: c.dir,
          source: c.source,
          version: vers.get(c.dir),
          winner: c.dir === winner.dir,
        })));
      } else if (cands.length > 1) {
        this.candidates.set(id, cands.map((c) => ({ dir: c.dir, source: c.source, winner: c.dir === winner.dir })));
      }
      this.winners.set(id, winner);
    }

    // 3) Load winners (first-seen order preserved; no fallback on failure).
    //    PI_WEB_EXT_TIMING=1: record per-extension import time + retranspiled
    //    file count (jiti cache snapshot diff), print the summary table at the
    //    end of the loop — "fsCache persistent hits" verification moves from
    //    estimating via an external bench to reading the table directly
    //    (pi PI_TIMING-style load observation, plan §7.1②). Serial loading keeps
    //    miss attribution correct.
    const timingEnabled = process.env.PI_WEB_EXT_TIMING === "1";
    const timings: Array<{ id: string; ms: number; retranspiled: number }> = [];
    for (const [id, winner] of this.winners) {
      if (disabled.has(id)) continue; // user-disabled → not loaded (absent from status; UI uses isEnabled)
      const { dir, source } = winner;
      const timingT0 = timingEnabled ? performance.now() : 0;
      const cacheBefore = timingEnabled ? snapshotJitiCache() : null;
      try {
        // Protocol declaration check (docs/pi-web-ext-protocol.md): non-ok logs
        // one warn (process-level dedupe, reloads don't re-spam);
        // PI_WEB_EXT_PROTOCOL_STRICT=1 refuses incompatible/missing/invalid/too_new
        // (stale still loads — the host keeps a compat layer).
        const protoInfo = extProtocolInfo(readPackageInfo(dir).protocol);
        if (protoInfo.state !== "ok" || protoInfo.minorAhead) {
          const warnKey = `${id}@${protoInfo.state}@${protoInfo.declared ?? ""}@${protoInfo.current}`;
          if (!protocolWarned.has(warnKey)) {
            protocolWarned.add(warnKey);
            const tip = protoInfo.needsUpgrade ? " — use the extension manager's \"🤖 AI upgrade\" (ext-protocol-upgrade skill)" : "";
            console.warn(`[ext] ${id} protocol declaration ${protoInfo.declared ?? "(undeclared)"} vs current ${protoInfo.current}: ${protoInfo.state}${protoInfo.detail ? " (" + protoInfo.detail + ")" : ""}${tip}`);
          }
        }
        if (protocolStrict() && EXT_PROTOCOL_STRICT_BLOCKED.includes(protoInfo.state)) {
          this.errors.set(id, `Protocol incompatible (${protoInfo.state}: declared ${protoInfo.declared ?? "—"} vs current ${protoInfo.current}) — PI_WEB_EXT_PROTOCOL_STRICT=1`);
          continue;
        }
        const ext = await loadExtensionFromDir(dir);
        if (!ext) {
          this.errors.set(id, "no extension entry (index.ts / single script)");
          continue;
        }
        if (ext.id !== id) {
          this.errors.set(id, `entry id "${ext.id}" does not match directory name "${id}"`);
          continue;
        }
        // Data layering (three symmetric dirs, 2026-09-13): config/state/cache are all
        // <dataRoot>/<id>/ subdirectories;
        // configDir = config area (backup scope), stateDir = persistent data area
        // (non-regenerable, never assume it is lost),
        // cacheDir = cache area (safe to delete wholesale and rebuild; created lazily)
        const extRoot = join(this.dataRoot(), ext.id);
        if (!existsSync(extRoot)) mkdirSync(extRoot, { recursive: true });
        const configDir = join(extRoot, "config");
        if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
        const stateDir = join(extRoot, "state");
        if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
        const cacheDir = join(extRoot, "cache");
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
        this.extensions.set(ext.id, { id: ext.id, name: ext.name, version: ext.version, dir, configDir, stateDir, cacheDir, source, ext });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[ext] ${id} failed to load:`, msg);
        this.errors.set(id, msg);
      } finally {
        if (timingEnabled) {
          timings.push({ id, ms: performance.now() - timingT0, retranspiled: countRetranspiled(cacheBefore!, snapshotJitiCache()) });
        }
      }
    }
    // [lazy loading v2] lazy-flag static diagnostics (non-blocking):
    // clientImmediately:false with no ui[slot][] item declarations at all →
    // materializes on first render of an always-mounted slot, or never
    // materializes (silent no-op). Entries with item declarations are left to the
    // client's static-entry/interactive-slot mechanism (dev assertion lives in the
    // ext-ui-store merge layer);
    // clientLazyVia:"service" = service-delivered lazy extension (rendering is
    // delivered via a client service; the consumer deterministically calls
    // ensureMaterialized at an always-mounted point, e.g. the app-center
    // extension) → has a trigger, exempt.
    for (const ext of this.extensions.values()) {
      if (ext.ext.ui?.clientImmediately !== false) continue;
      if (ext.ext.ui?.clientLazyVia === "service") continue;
      const hasStaticEntry = Object.entries(ext.ext.ui).some(
        ([k, v]) => !["i18n", "provides", "clientDependsOn", "clientImmediately", "clientLazyVia"].includes(k) && Array.isArray(v) && v.length > 0,
      );
      if (!hasStaticEntry) {
        this.errors.set(ext.id, "lazy flag ineffective: no ui[slot][] static entry at all (an always-mounted slot materializes on first render, or it silently never materializes) — add static entries, declare ui.clientLazyVia:\"service\" (consumer deterministically ensureMaterialized), or drop clientImmediately:false");
      }
    }
    this.buildCapabilityIndex();
    this.loaded = true;
    if (timingEnabled) {
      const total = timings.reduce((s, t) => s + t.ms, 0);
      const misses = timings.filter((t) => t.retranspiled > 0).length;
      console.log(`[ext-timing] loadAll: ${timings.length} extensions / ${total.toFixed(0)}ms — cache hits ${timings.length - misses}, retranspiled ${misses} (PI_WEB_EXT_TIMING=1 gated observation)`);
      for (const [i, t] of timings.entries()) {
        console.log(`[ext-timing]   ${(i + 1).toString().padStart(2)}. ${t.id.padEnd(32)} ${t.ms.toFixed(0).padStart(5)}ms  ${t.retranspiled > 0 ? `MISS (retranspiled ${t.retranspiled} files)` : "hit"}`);
      }
    }
  }

  /**
   * Capability registry (dependency & capability model §4): built at the end of
   * loadAll, rebuilt on reload — capability name → all providers (provides ∪
   * takeover declarers, all loaded extensions). O(1) table lookup at resolution;
   * disabled/failed extensions are not in the set (they provide nothing).
   */
  private buildCapabilityIndex(): void {
    const caps = new Map<string, Array<{ id: string; version: string; source?: ExtensionSource; takeover: boolean }>>();
    for (const ext of this.extensions.values()) {
      const provides = Array.isArray(ext.ext.provides) ? ext.ext.provides : [];
      const takeover = Array.isArray(ext.ext.takeover) ? ext.ext.takeover : [];
      const names = new Set([...provides, ...takeover]);
      for (const name of names) {
        if (!caps.has(name)) caps.set(name, []);
        caps.get(name)!.push({
          id: ext.id,
          version: ext.version,
          source: ext.source,
          takeover: takeover.includes(name),
        });
      }
    }
    this._caps = caps;
  }

  /**
   * Effective capability provider resolution (§5.1): user pin > takeover
   * declarers first (exclusive semantics) > newest semver > extension id
   * lexicographic (last resort keeps it deterministic). A pin value outside the
   * provider set is ignored (soft validation back to auto; stale pins after
   * uninstall/reinstall cause no trouble).
   */
  private effectiveProvider(name: string, providers: Array<{ id: string; version: string; takeover: boolean }>): string | null {
    if (!providers || providers.length === 0) return null;
    const pinTo = this.extPins().pins?.["capability:" + name];
    if (pinTo && providers.some((p) => p.id === pinTo)) return pinTo;
    const takers = providers.filter((p) => p.takeover);
    const pool = takers.length > 0 ? takers : providers;
    return [...pool].sort((a, b) => compareExtVersions(b.version, a.version) || a.id.localeCompare(b.id))[0].id;
  }

  /**
   * Resolve a dependency-declaration element (§5.1): exact id hit (including
   * disabled/failed existence, via the winners set) → kind="ext"; otherwise
   * resolve as a capability name → kind="cap". missing/inactive are annotated,
   * not blocking.
   */
  private resolveDep(name: string, hard: boolean): ExtDepResolution {
    if (this.winners.has(name)) {
      return { name, kind: "ext", hard, target: name, status: this.extensions.has(name) ? "ok" : "inactive" };
    }
    const providers = this._caps.get(name);
    if (!providers || providers.length === 0) return { name, kind: "cap", hard, status: "missing" };
    const pinTo = this.extPins().pins?.["capability:" + name];
    const pinned = !!(pinTo && providers.some((p) => p.id === pinTo));
    return {
      name,
      kind: "cap",
      hard,
      target: this.effectiveProvider(name, providers) ?? undefined,
      status: "ok",
      ...(pinned ? { viaPin: true } : {}),
      providers: providers.map((p) => p.id),
    };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  devExtensionsRoot(): string | null {
    return this.devExtensionsRootOverride !== undefined
      ? this.devExtensionsRootOverride
      : devExtensionsRoot();
  }

  byId(id: string): LoadedExtension | undefined {
    return this.extensions.get(id);
  }

  all(): LoadedExtension[] {
    return [...this.extensions.values()];
  }

  /** Load/startup failure list (id → error: jiti resolution errors, entry
   *  validation, startup throws). The manifest carries it to the frontend
   *  (ExtSlots registers it into the bottom-left error indicator) — visible as
   *  soon as a page opens, without opening the extension manager's /status. */
  loadFailures(): Array<{ id: string; error: string }> {
    return [...this.errors].map(([id, error]) => ({ id, error }));
  }

  /**
   * Full status (including disabled and failed extensions):
   *  - load failure → loaded:false + error
   *  - disabled → enabled:false (reads package.json statically, no code executed;
   *    same-id dirs use loadAll's arbitration — higher version wins, equal/unknown
   *    falls back to root priority)
   *  - normal → loaded:true plus slots/hooks/client and all other details
   */
  status(): Record<string, ExtStatusEntry> {
    const disabled = this.disabledExtensions();
    const out: Record<string, ExtStatusEntry> = {};
    const seen = new Set<string>();

    for (const [id, error] of this.errors) {
      seen.add(id);
      out[id] = { loaded: false, enabled: true, error };
    }

    if (disabled.size > 0) {
      // Prefer loadAll's arbitration results (winners matches the load-time
      // view); if loadAll never ran (winners empty) fall back to a first-seen
      // scan (old view: root priority).
      if (this.winners.size > 0) {
        for (const [id, winner] of this.winners) {
          if (seen.has(id) || !disabled.has(id)) continue;
          seen.add(id);
          const packageInfo = readPackageInfo(winner.dir);
          out[id] = {
            loaded: false,
            enabled: false,
            source: winner.source,
            dir: winner.dir,
            name: packageInfo.name ?? id,
            version: packageInfo.version,
            packageInfo,
            protocol: extProtocolInfo(packageInfo.protocol),
          };
        }
      } else {
        for (const { root, source } of this.extensionRoots()) {
          for (const dir of scanExtensionDirs(root)) {
            const id = dir.split(sep).pop() ?? dir;
            if (seen.has(id) || !disabled.has(id)) continue;
            seen.add(id);
            const packageInfo = readPackageInfo(dir);
            out[id] = {
              loaded: false,
              enabled: false,
              source,
              dir,
              name: packageInfo.name ?? id,
              version: packageInfo.version,
              packageInfo,
              protocol: extProtocolInfo(packageInfo.protocol),
            };
          }
        }
      }
    }

    for (const ext of this.extensions.values()) {
      const server = ext.ext.server as (ExtServerHooks & { agent?: ExtAgentHooks }) | undefined;
      // Extensions whose startup/shutdown failed also flow through this loop
      // (loaded OK but startup blew up): the error must be carried, otherwise
      // the loaded:true default masks it and the extension manager shows nothing
      // wrong (entry load failures don't reach here — the extension isn't in the
      // extensions map at all in that case).
      const startupError = this.errors.get(ext.id);
      // Dependency & capability model (§4 pass-through): four declaration fields +
      // resolution results (ids first; capability edges include the effective provider).
      const dependsOn = ext.ext.dependsOn?.length ? [...ext.ext.dependsOn] : undefined;
      const optionalDependsOn = ext.ext.optionalDependsOn?.length ? [...ext.ext.optionalDependsOn] : undefined;
      const capsProvides = ext.ext.provides?.length ? [...ext.ext.provides] : undefined;
      const capsTakeover = ext.ext.takeover?.length ? [...ext.ext.takeover] : undefined;
      const depsResolved = [
        ...(dependsOn ?? []).map((n) => this.resolveDep(n, true)),
        ...(optionalDependsOn ?? []).map((n) => this.resolveDep(n, false)),
      ];
      const packageInfo = readPackageInfo(ext.dir);
      out[ext.id] = {
        loaded: true,
        enabled: !disabled.has(ext.id),
        ...(startupError ? { error: startupError } : {}),
        name: ext.name,
        version: ext.version,
        source: ext.source,
        icon: ext.ext.icon ?? null,
        dir: ext.dir,
        configDir: ext.configDir,
        stateDir: ext.stateDir,
        cacheDir: ext.cacheDir,
        client: ext.ext.client
          ? { file: ext.ext.client, hash: this.clientHash(ext) }
          : null,
        slots: collectSlots(ext.ext.ui),
        provides: ext.ext.ui?.provides?.length ? [...ext.ext.ui.provides] : undefined,
        clientDependsOn: ext.ext.ui?.clientDependsOn?.length ? [...ext.ext.ui.clientDependsOn] : undefined,
        i18nLocales: ext.ext.ui?.i18n ? Object.keys(ext.ext.ui.i18n) : undefined,
        serverHooks: server ? SERVER_HOOK_KEYS.filter((k) => typeof server[k] === "function") : [],
        agentHooks: server?.agent ? AGENT_HOOK_KEYS.filter((k) => typeof server.agent![k] === "function") : [],
        features: ext.ext.features?.length
          ? ext.ext.features.map((f) => ({ ...f, enabled: this.featureEnabled(ext.id, f.id), ...(f.type === "string" || f.type === "textlist" ? { value: String(this.featureValue(ext.id, f.id)) } : {}) }))
          : undefined,
        packageInfo,
        protocol: extProtocolInfo(packageInfo.protocol),
        ...(dependsOn ? { dependsOn } : {}),
        ...(optionalDependsOn ? { optionalDependsOn } : {}),
        ...(capsProvides ? { capsProvides } : {}),
        ...(capsTakeover ? { capsTakeover } : {}),
        ...(depsResolved.length > 0 ? { depsResolved } : {}),
        ...(capsTakeover ? { takeoverResolved: capsTakeover.map((n) => {
          const providers = this._caps.get(n);
          return { name: n, effective: this.effectiveProvider(n, providers ?? []) === ext.id };
        }) } : {}),
      };
    }
    return out;
  }

  /** Full response body of /api/extensions/status (shared by GET / install / remove). */
  statusPayload(): {
    loaded: boolean;
    extensionsRoot: string;
    extraExtensionsRoots: string[];
    devExtensionsRoot: string | null;
    bundledExtensionsRoot: string;
    dataRoot: string;
    extensions: Record<string, ExtStatusEntry>;
    /** Live service list (§7-7 service visibility: key + provider; consumed by the extension-manager panel). */
    services: Array<{ key: string; extId: string }>;
    /** Capability view (dependency & capability model P1): capability name → providers/effective/consumers; includes missing capabilities. */
    capabilities: Record<string, CapabilityViewEntry>;
    /** Multi-source groups per id (P2): ids with >1 candidates → candidate list (winner marks the currently effective one). */
    multiSource: Record<string, MultiSourceGroup>;
    /** Current pins (P2): dev-priority switch + pin table (echoed in the extension-manager panel). */
    pins: { devPriority: boolean; pins: Record<string, string> };
    /** Protocol version baseline (docs/pi-web-ext-protocol.md; consumed by the extension manager/frontend). */
    protocol: { current: string; minMajor: number; minSupported: string };
  } {
    return {
      loaded: this.isLoaded(),
      extensionsRoot: this.extensionsRoot(),
      extraExtensionsRoots: this.extraExtensionsRoots(),
      devExtensionsRoot: this.devExtensionsRoot(),
      bundledExtensionsRoot: this.bundledExtensionsRoot(),
      dataRoot: this.dataRoot(),
      extensions: this.status(),
      services: this.services.list(),
      capabilities: this.capabilitiesView(),
      multiSource: this.multiSourceView(),
      pins: { devPriority: this.devPriorityEnabled(), pins: { ...(this.extPins().pins ?? {}) } },
      protocol: { current: EXT_PROTOCOL_VERSION, minMajor: EXT_PROTOCOL_MIN_MAJOR, minSupported: `${EXT_PROTOCOL_MIN_MAJOR}.0` },
    };
  }

  /**
   * Capability view (rendering data source for the extension manager, §6.2):
   * providers/effective provider/pins/consumers; also folds in capabilities that
   * appear only in dependency declarations and have no provider (for missing markers).
   */
  private capabilitiesView(): Record<string, CapabilityViewEntry> {
    const out: Record<string, CapabilityViewEntry> = {};
    const pins = this.extPins().pins ?? {};
    const entry = (name: string): CapabilityViewEntry => {
      if (!out[name]) out[name] = { providers: [], effective: null, consumers: [] };
      return out[name];
    };
    for (const [name, providers] of this._caps) {
      const e = entry(name);
      e.providers = providers.map((p) => ({ id: p.id, version: p.version, source: p.source, takeover: p.takeover }));
      e.effective = this.effectiveProvider(name, providers);
      const pinTo = pins["capability:" + name];
      if (pinTo && providers.some((p) => p.id === pinTo)) e.pinnedTo = pinTo;
    }
    // Consumers (including missing capabilities): loaded extensions whose dependency
    // element names a capability without hitting an id.
    for (const ext of this.extensions.values()) {
      for (const [names, hard] of [[ext.ext.dependsOn, true], [ext.ext.optionalDependsOn, false]] as const) {
        for (const n of names ?? []) {
          if (this.winners.has(n)) continue; // ids win: already handled as extension deps, not a capability consumer
          const e = entry(n);
          e.consumers.push({ extId: ext.id, hard });
        }
      }
    }
    return out;
  }

  /** Multi-source groups for the same id (only ids with >1 candidates; missing candidate version = disabled, never probed). */
  private multiSourceView(): Record<string, MultiSourceGroup> {
    const out: Record<string, MultiSourceGroup> = {};
    for (const [id, cands] of this.candidates) {
      if (cands.length > 1) out[id] = { candidates: cands.map((c) => ({ ...c })) };
    }
    return out;
  }

  manifest(): ManifestExtension[] {
    return [...this.extensions.values()].map((e) => ({
      id: e.id,
      name: e.name,
      version: e.version,
      // clientUrl carries a content hash (?v=<first 12 hex of sha256>): client
      // update → URL changes → browser forced refetch (no hard refresh/cache clear needed)
      clientUrl: e.ext.client ? `/api/extensions/${e.id}/assets/${e.ext.client}?v=${this.clientHash(e)}` : null,
      ui: e.ext.ui ?? null,
      source: e.source,
      icon: e.ext.icon ?? null,
      // App-center category annotation (consumed by the app-center extension; absent
      // when undeclared — the client falls back to the default category)
      ...(e.ext.category ? { category: e.ext.category } : {}),
      // Dependency & capability model (§4 pass-through): runtime-probeable — with
      // the full manifest a client can tell whether a depended-on capability has
      // an effective provider / whether an optional extension exists, and decide
      // whether to enable extra functionality.
      ...(e.ext.dependsOn?.length ? { dependsOn: [...e.ext.dependsOn] } : {}),
      ...(e.ext.optionalDependsOn?.length ? { optionalDependsOn: [...e.ext.optionalDependsOn] } : {}),
      ...(e.ext.provides?.length ? { provides: [...e.ext.provides] } : {}),
      ...(e.ext.takeover?.length ? { takeover: [...e.ext.takeover] } : {}),
      // Feature state (managed by the extension manager): fetched together when
      // the host client loads; extensions read the shared store only, no separate requests
      features: e.ext.features?.length ? e.ext.features.map((f) => ({ id: f.id, type: f.type, label: f.label, placeholder: f.placeholder, ...(f.category ? { category: f.category } : {}), enabled: this.featureEnabled(e.id, f.id), ...(f.type === "string" || f.type === "textlist" ? { value: String(this.featureValue(e.id, f.id)) } : {}) })) : null,
    }));
  }

  /**
   * Declaring extension ids per UI slot (slot → extId[]). Authoritative
   * server-side fact for SSR first-frame decisions: e.g. when `sidebarContent`
   * has a declarer, the takeover placeholder renders on the first frame instead
   * of the host's fallback sidebar (avoiding the fallback component pulling the
   * full session list on mount only to be replaced by the takeover — see
   * docs/pi-web-load-perf-optimization-plan.md §5).
   * Only non-empty array slot keys are collected; metadata keys
   * (i18n/provides/clientDependsOn/clientImmediately) are excluded.
   */
  slotDeclarations(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const e of this.manifest()) {
      const ui = e.ui as Record<string, unknown> | null | undefined;
      if (!ui) continue;
      for (const [k, v] of Object.entries(ui)) {
        if (k === "i18n" || k === "provides" || k === "clientDependsOn" || k === "clientImmediately") continue;
        if (!Array.isArray(v) || v.length === 0) continue;
        (out[k] ??= []).push(e.id);
      }
    }
    return out;
  }

  /**
   * Boot graph (client-modules): input to the frontend loader. Returns a stable
   * object while content is unchanged (same mtime-cache approach as clientHash;
   * recomputed automatically after extension reload).
   */
  private _bootGraph: PiWebBootGraph | null = null;
  bootGraph(): PiWebBootGraph {
    if (this._bootGraph) return this._bootGraph;
    this._bootGraph = buildBootGraph(
      [...this.extensions.values()]
        .filter((e) => e.ext.client)
        .map((e) => ({
          id: e.id,
          assetUrl: `/api/extensions/${e.id}/assets/${e.ext.client}`,
          hash: this.clientHash(e),
          // eager bundle exclusions (see the lib/ext/client-bundle.ts header comment):
          // import.meta users only (asset base URL depends on the entry URL; paths
          // drift after bundling).
          // Chunked extensions (thin shell + lazy chunks) are not excluded — the
          // bundle builder externalizes their static relative imports as file URLs,
          // keeping shared chunks single-instance at runtime.
          bundleExcluded: usesImportMeta(join(e.dir, e.ext.client!)),
          // inject edge reservation: extensions may declare clientDependsOn in ui
          // (DSH inject edges).
          inject: e.ext.ui?.clientDependsOn,
          // Lazy loading: ui.clientImmediately === false → graph row marked
          // immediately:false, not materialized during startup, loaded on first
          // render into a declared slot.
          immediately: e.ext.ui?.clientImmediately === false ? false : undefined,
          // Frontend materialize priority pass-through (unified SSE port plan
          // §3-B): ExtSlots materializes the highest-priority item alone first
          // (the event-bus extension's window.__piEventBus mounts first), the
          // rest of the immediate items in parallel. undefined skips (frontend
          // default 0, matching the backend).
          priority: e.ext.startupPriority,
        })),
    );
    return this._bootGraph;
  }

  /** Invalidate the boot graph (called after reload/loadAll); recomputed on next access. */
  private invalidateBootGraph(): void {
    this._bootGraph = null;
    this._clientBundleCache = null;
  }

  private _clientBundleCache: { rev: string; code: string; ids: string[] } | null = null;
  private _clientBundleInFlight: Promise<{ rev: string; code: string; ids: string[] }> | null = null;

  /**
   * eager extension batch client bundle (cached by graph rev; first build
   * ~0.3-1s, then free). Content-addressed: caller URLs carry ?rev= and can
   * cache immutably; extension reload → graph rev changes → rebuilt. If the
   * build finds import.meta users that slipped through, they are excluded and
   * it rebuilds (offenders logged).
   */
  async clientBundle(): Promise<{ rev: string; code: string; ids: string[] }> {
    const graph = this.bootGraph();
    const bundle = graph.bundle;
    if (!bundle || bundle.ids.length === 0) {
      return { rev: "empty", code: emptyClientBundleCode(), ids: [] };
    }
    if (this._clientBundleCache?.rev === bundle.rev) return this._clientBundleCache;
    if (this._clientBundleInFlight) return this._clientBundleInFlight;
    const rev = bundle.rev;
    const entries: ClientBundleEntry[] = [];
    bundle.ids.forEach((id, order) => {
      const loaded = this.extensions.get(id);
      if (!loaded?.ext.client) return;
      const file = this.assetPath(id, loaded.ext.client);
      const row = graph.entries.find((r) => r.id === id);
      if (!file || !row) return;
      entries.push({ id, dir: loaded.dir, file, rev: row.rev, priority: row.priority, order });
    });
    const run = buildClientBundle(entries).then((built) => {
      if (built.offenders.length) {
        console.warn(`[ext] client bundle: import.meta-using extensions excluded: ${built.offenders.join(", ")}`);
      }
      if (built.chunked.length) {
        // chunked extensions: static shared chunks externalized (lazy chunks and
        // in-bundle references share one file instance at runtime)
        console.info(`[ext] client bundle: chunked extensions' static deps externalized: ${built.chunked.join(", ")}`);
      }
      const value = { rev, code: built.code, ids: built.ids };
      if (this.bootGraph().bundle?.rev === rev) this._clientBundleCache = value;
      return value;
    }).finally(() => {
      this._clientBundleInFlight = null;
    });
    this._clientBundleInFlight = run;
    return run;
  }

  /** Extension client file content hash (mtime-cached: recomputed only when the file changes) — clientUrl?v=<hash> forces the browser to refetch */
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

  /** Warm the eager bundle (built in the background at startup/reload; the first page request waits for nothing). Failures allowed. */
  warmClientBundle(): void {
    void this.clientBundle().catch((e) => {
      console.warn("[ext] client bundle warmup failed:", e);
    });
  }

  /** Invoke all server.startup hooks (best-effort per extension). */
  async startAll(): Promise<void> {
    this.provideCoreServices();
    // Unified SSE port plan §3-A: stable sort by startupPriority descending
    // (default 0; equal priorities keep scan order) — infrastructure-grade
    // extensions (event-bus = 100) start before every consumer:
    // the __piPageEvents accessor takeover, publish/publish-local service outlets,
    // and /subscribe /events routes are ready before other extensions' startups
    // publish (consumers must not spin up their own bus or hit 404s over late
    // arrival).
    const ordered = [...this.extensions.values()].map((ext, i) => ({ ext, i }))
      .sort((a, b) => (b.ext.ext.startupPriority ?? 0) - (a.ext.ext.startupPriority ?? 0) || a.i - b.i)
      .map((x) => x.ext);
    for (const ext of ordered) {
      if (this.startedIds.has(ext.id)) continue; // already started by startupById: don't repeat
      await this.startupOne(ext);
    }
    // warm the eager bundle in the background (first page request waits for
    // nothing; failure allowed, the frontend falls back per extension).
    this.warmClientBundle();
  }

  /** Extension ids whose startup has run (shared ledger for startupById/startAll; cleared on each shutdown cycle). */
  private startedIds = new Set<string>();

  /** Single-extension startup (best-effort + slow-startup warning); recorded in the ledger on success. */
  private async startupOne(ext: LoadedExtension): Promise<void> {
    const t0 = Date.now();
    try {
      await ext.ext.server?.startup?.(this.serverContext(ext));
    } catch (e) {
      const msg = `startup: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[ext] ${ext.id} startup failed:`, msg);
      this.errors.set(ext.id, msg);
    }
    // Slow-startup-hook warning: startup blocks global reload (including the
    // extension manager's enable/disable/install), so a single hook >1s counts
    // as abnormal (heavy work should go to the background and only affect that
    // extension's own readiness speed).
    const ms = Date.now() - t0;
    if (ms > 1000) console.warn(`[ext] slow startup hook: ${ext.id} took ${ms}ms (consider backgrounding init)`);
    this.startedIds.add(ext.id);
  }

  /**
   * Unified SSE port plan §3-A hardening: the bus's server starts first, alone —
   * not waiting for the extension batch. The host startup sequence
   * (instrumentation) calls this after loadAll and before startAll: /events
   * /subscribe routes and the __piPageEvents takeover are ready before any
   * consumer extension (and the host's later init). Idempotent: repeated calls
   * or overlap with startAll never double-start; an absent (not installed/
   * disabled) extension is skipped silently (returns false) and consumers fall
   * back per their own contracts.
   * @returns whether the bus exists and has been (or already was) started.
   */
  async startupById(id: string): Promise<boolean> {
    if (this.startedIds.has(id)) return true;
    const ext = this.extensions.get(id);
    if (!ext) return false;
    await this.startupOne(ext);
    return true;
  }

  // ---- Plan M: agent session-level extension points ----
  private agentHooks(ext: LoadedExtension): ExtAgentHooks | undefined {
    return (ext.ext.server as (ExtServerHooks & { agent?: ExtAgentHooks }) | undefined)?.agent;
  }

  /** Collect customTools injected into agent sessions by all extensions (called once at session creation; one extension's error doesn't block the rest). */
  collectAgentTools(info: Pick<AgentSessionInfo, "sessionId" | "cwd">): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const ext of this.extensions.values()) {
      try {
        tools.push(...this.collectExtAgentTools(ext, info));
      } catch (e) {
        console.error(`[ext] ${ext.id}.agent.agentTools failed:`, e instanceof Error ? e.message : e);
      }
    }
    return tools;
  }

  /**
   * Per-session collection: same as this session's default collection, but
   * extensions named in `enableExts` are **force-enabled** (feature gating
   * bypassed). Used for "enable on demand" — pass enableExts at session creation
   * instead of mutating global feature state (no races, no failed-change residue).
   * All other extensions still go through feature gating.
   */
  collectAgentToolsWith(info: Pick<AgentSessionInfo, "sessionId" | "cwd">, enableExts?: string[]): ToolDefinition[] {
    const forced = new Set(enableExts ?? []);
    const tools: ToolDefinition[] = [];
    for (const ext of this.extensions.values()) {
      try {
        tools.push(...this.collectExtAgentTools(ext, info, forced.has(ext.id)));
      } catch (e) {
        console.error(`[ext] ${ext.id}.agent.agentTools failed:`, e instanceof Error ? e.message : e);
      }
    }
    return tools;
  }

  /**
   * Session subscription epoch ledger: sessionId → unsubscribe functions created
   * by extensions via subscribeEvent within the current epoch. Every
   * dispatchAgentSession call opens a new epoch (reclaiming the previous one
   * first); the ledger is settled when the session ends. The registry is a
   * globalThis singleton that survives reloads — reload re-attach
   * (reattachAgentSessions) relies on it for "extensions need not unsubscribe
   * themselves, and nothing is delivered twice".
   */
  private agentSessionSubs = new Map<string, Set<() => void>>();

  /** Session start callback (after wrapper creation). Every call opens a new
   *  "subscription epoch" for that session: first reclaim the previous epoch's
   *  subscribeEvent unsubscribes recorded by the host (preventing double delivery
   *  across idle-GC rebuilds / reload re-attach), then record this epoch's new
   *  subscriptions in the ledger. */
  dispatchAgentSession(info: AgentSessionInfo): void {
    this.releaseAgentSessionSubs(info.sessionId);
    const subs = new Set<() => void>();
    this.agentSessionSubs.set(info.sessionId, subs);
    const base = info.subscribeEvent;
    const fanout: AgentSessionInfo = typeof base === "function"
      ? {
          ...info,
          subscribeEvent: (listener) => {
            const off = base(listener);
            if (typeof off === "function") {
            // Record the subscription only while this closure's epoch is still
            // current; if the epoch has rotated/been settled (extension subscribed
            // late, asynchronously) → unsubscribe immediately, keeping old-epoch
            // subscriptions out of the new epoch (no double delivery).
            if (this.agentSessionSubs.get(info.sessionId) === subs) subs.add(off);
            else { try { off(); } catch { /* epoch rotated/settled (session ended) → late subscription unsubscribed immediately */ } }
            }
            return off;
          },
        }
      : info;
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSession?.(fanout); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSession failed:`, e instanceof Error ? e.message : e); }
    }
  }

  /** Reclaim the extensions' subscriptions recorded for a session's current epoch (idempotent: re-invoking already-unsubscribed entries has no effect). */
  private releaseAgentSessionSubs(sessionId: string): void {
    const subs = this.agentSessionSubs.get(sessionId);
    if (!subs) return;
    this.agentSessionSubs.delete(sessionId);
    for (const off of subs) {
      try { off(); } catch { /* one failure doesn't block the rest */ }
    }
  }

  /** Session destroy callback (wrapper destroy, including fork/idle-GC reclamation; distinguished by reason). */
  dispatchAgentSessionEnd(sessionId: string, reason?: ExtAgentEndReason): void {
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSessionEnd?.({ sessionId, reason }); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSessionEnd failed:`, e instanceof Error ? e.message : e); }
    }
    // settle the ledger after extension callbacks: reclaim this session's epoch
    // subscriptions (nothing lingers even if extensions never unsubscribed).
    this.releaseAgentSessionSubs(sessionId);
  }

  /** agent_settled callback (final answer text). */
  dispatchAgentSettled(sessionId: string, text: string): void {
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSettled?.({ sessionId, text }); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSettled failed:`, e instanceof Error ? e.message : e); }
    }
  }

  // ---- session annotation slot ----
  private sessionAnnotators = new Map<string, Array<{ extId: string; annotate: (rows: Array<{ id: string; path?: string; cwd?: string }>) => Promise<Record<string, Record<string, unknown>> | void> }>>();

  private registerSessionAnnotator(
    extId: string,
    annotator: { annotate: (rows: Array<{ id: string; path?: string; cwd?: string }>) => Promise<Record<string, Record<string, unknown>> | void> },
  ): void {
    if (!this.sessionAnnotators.has(extId)) this.sessionAnnotators.set(extId, []);
    this.sessionAnnotators.get(extId)!.push({ extId, annotate: annotator.annotate });
  }

  /**
   * Dispatch annotations: merge each extension's returned field maps into rows
   * (in place) keyed by row id/path. One annotator's error doesn't block the rest.
   */
  async dispatchSessionAnnotations(
    rows: Array<{ id: string; path?: string; cwd?: string } & object>,
  ): Promise<void> {
    for (const [, annotators] of this.sessionAnnotators) {
      for (const { annotate } of annotators) {
        try {
          const patch = await annotate(rows.map((r) => ({ id: r.id, path: r.path, cwd: r.cwd })));
          if (!patch) continue;
          for (const row of rows) {
            const extra = patch[row.id] ?? (row.path ? patch[row.path] : undefined);
            if (extra) Object.assign(row, extra);
          }
        } catch (e) {
          console.error("[ext] session annotator failed:", e instanceof Error ? e.message : e);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.sessionAnnotators.clear();
    // Symmetric reverse of startAll (lower priority stops first, the bus last):
    // during reload consumer extensions unsubscribe/wind down first and
    // infrastructure-grade extensions close out last (unified SSE port plan §3-A).
    const ordered = [...this.extensions.values()].map((ext, i) => ({ ext, i }))
      .sort((a, b) => (a.ext.ext.startupPriority ?? 0) - (b.ext.ext.startupPriority ?? 0) || b.i - a.i)
      .map((x) => x.ext);
    for (const ext of ordered) {
      this.startedIds.delete(ext.id); // clear this cycle's startup ledger entry (re-recorded next cycle)
      try {
        await ext.ext.server?.shutdown?.(this.serverContext(ext));
      } catch (e) {
        this.errors.set(ext.id, `shutdown: ${e instanceof Error ? e.message : String(e)}`);
      }
      // service teardown (§4-A): take all services the extension provided offline
      // (revoked only after hooks finish; down is broadcast for consumers to resubscribe)
      this.services.revokeExt(ext.id);
    }
    // Session backend slot: unregister all providers an extension registered when
    // it is stopped (including shutdown callbacks).
    await cleanupAllExtensionProviders();
    // reload cycle cleanup: core.* preset services go offline too (startAll
    // re-provides them); listeners are cleared with the old cycle's closures
    this.services.clear();
    this.featureListeners.clear();
  }

  /** Hot reload: shutdown → reload entries → startup. */
  private reloadInFlight: Promise<void> | null = null;

  /** Hot reload: shutdown → loadAll → startAll. Concurrent calls share one round (avoids interleaved rounds dropping extensions). */
  async reload(): Promise<void> {
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = (async () => {
      await this.shutdown();
      await this.loadAll();
      await this.startAll();
      // Sessions (wrappers) survive reload; what breaks is the subscription wiring
      // between new extension modules ⇄ wrappers: after startAll, re-dispatch
      // agent hooks to live sessions so extensions re-attach subscriptions (plan
      // docs/pi-web-ext-reload-session-resubscribe-plan.md).
      this.reattachAgentSessions();
    })();
    try {
      await this.reloadInFlight;
    } finally {
      this.reloadInFlight = null;
    }
  }

  /**
   * Re-attach after reload: re-dispatch dispatchAgentSession to local sessions
   * that are alive and were dispatched before. Filtering uses the wrapper's
   * isAlive/hasAgentSessionHooks (subagent wrappers never dispatched hooks, so
   * they are excluded); dispatchAgentSession internally reclaims the old epoch's
   * subscriptions first → re-attach never double-delivers. Also covers reload
   * races: sessions created between shutdown→startAll may have only seen an
   * empty/half-loaded extension set; they are swept up here.
   */
  private reattachAgentSessions(): void {
    let n = 0;
    for (const [sid, raw] of piSessionsMap()) {
      const wrapper = raw as {
        isAlive?(): boolean;
        hasAgentSessionHooks?(): boolean;
        toAgentSessionInfo?(): AgentSessionInfo | undefined;
      } | undefined;
      try {
        if (wrapper?.isAlive?.() !== true) {
          // Destroyed (destroy marks it dead synchronously; the end callback arrives
          // later via an async session_shutdown emit): settle the ledger while here,
          // so old-epoch subscriptions don't linger until end arrives (after end,
          // release is idempotent with no side effects).
          this.releaseAgentSessionSubs(sid);
          continue;
        }
        if (wrapper.hasAgentSessionHooks?.() !== true) continue;
        const info = wrapper.toAgentSessionInfo?.();
        if (!info) continue;
        this.dispatchAgentSession(info);
        n++;
      } catch (e) {
        console.error(`[ext] reload failed to re-attach session hooks (${sid}):`, e instanceof Error ? e.message : e);
      }
    }
    if (n > 0) console.log(`[ext] reload re-attached agent hooks for ${n} live session(s)`);
  }

  private serverContext(ext: LoadedExtension): ExtServerContext {
    const ctx: ExtServerContext = {
      id: ext.id, dir: ext.dir, configDir: ext.configDir, stateDir: ext.stateDir, cacheDir: ext.cacheDir, core: this.core,
      // Session backend registration slot (multi-agent frontend): keys get an
      // automatic "<extId>/" prefix and are unregistered on shutdown.
      // open/canOpen delegate to openExternalSession (agentKey resolution +
      // handle bookkeeping).
      sessionProviders: {
        register: (provider) => registerExtensionProvider(ext.id, provider),
        remove: (type: string) => {
          // operate on globalThis directly (bypasses turbopack module-graph pruning)
          const map = (globalThis as { __sessionProviders?: Map<string, unknown> }).__sessionProviders;
          if (!map) return false;
          return map.delete(type);
        },
        canOpen: (agentKey: string) => findProvidersForAgent(agentKey).length > 0,
        open: async (compositeId, options) => {
          try {
            const handle = await openExternalSession(compositeId, options);
            if (!handle) return { ok: false, reason: "no_provider" as const };
            return { ok: true, sessionId: handle.id };
          } catch (e) {
            return { ok: false, reason: "open_failed" as const, error: e instanceof Error ? e.message : String(e) };
          }
        },
      },
      // Session annotation slot: data ownership stays with the extension (core
      // doesn't know about bridge registries and other concrete formats)
      sessionAnnotations: {
        register: (annotator) => this.registerSessionAnnotator(ext.id, annotator),
      },
      // General AI invocation (core's lowest-level capability, zero business
      // logic); accounted per calling extension id (token stats live in core).
      // caller lets extensions subdivide scenarios (e.g. ai-input/complete,
      // ai-input/voice-fix); defaults to ext.id
      invokeAI: (p) => aiInvokeImpl({ ...p, caller: (p && p.caller) || ext.id }),
      // Cross-extension service locator (§4-A): provide forces the "<extId>."
      // prefix (anti-impersonation); reload teardown happens in shutdown()
      services: {
        provide: <T,>(key: string, impl: T) => this.services.provide(ext.id, key, impl),
        get: <T,>(key: string) => this.services.get<T>(key),
        require: <T,>(key: string, timeoutMs?: number) => this.services.require<T>(key, timeoutMs),
        onChange: (cb) => this.services.onChange(cb),
      },
      // feature read/write funnel (§4-A): get(fid) reads this extension /
      // get(extId, fid) reads a named extension; on subscribes to changes
      features: {
        get: (extIdOrFeatureId?: string, featureId?: string) =>
          featureId !== undefined ? this.featureValue(extIdOrFeatureId as string, featureId)
            : extIdOrFeatureId !== undefined ? this.featureValue(ext.id, extIdOrFeatureId)
            : undefined,
        on: (cb) => {
          this.featureListeners.add(cb);
          return () => {
            this.featureListeners.delete(cb);
          };
        },
      },
    };
    // dataDir misuse guard (breaking data-layering split): accessing throws —
    // returning undefined is not an option (it would splice "undefined/x" into
    // silent wrong paths, harder to debug); the error points straight at the
    // right APIs and the upgrade path (old npm extension packages upgrade based on it)
    Object.defineProperty(ctx, "dataDir", {
      get() {
        throw new Error(
          "[pi-web] ctx.dataDir has been removed (breaking data layering): use ctx.configDir for configuration, ctx.stateDir for non-regenerable persistent data (archives/history/stats/databases), ctx.cacheDir for cache/rebuildable data" +
          " (extensions must upgrade to the matching version; see the extension authoring reference §2.1 data layering)"
        );
      },
    });
    return ctx;
  }

  /** core.* preset services (§4-A core namespace): lazily-fetched read-only views (never dangle across singleton/hot-reload swaps). */
  private provideCoreServices(): void {
    const provide = (key: string, impl: unknown) => this.services.provide("core", key, impl);
    // core.sessions — read-only view of the rpc-manager session wrapper table
    // (§1.1: replaces direct __piSessions reads; the wrapper itself is a runtime
    // handle (send/onEvent/abortBash…), "read-only" means never mutating the
    // session table)
    provide("core.sessions", {
      ids: () => [...piSessionsMap().keys()],
      has: (id: string) => piSessionsMap().has(id),
      get: (id: string) => piSessionsMap().get(id),
    });
    // core.registry — read-only projection of the registry (for the extension
    // manager and other management surfaces; replaces direct __piWebExt reads.
    // Does not expose extension entry objects — only metadata projections + a
    // status snapshot + a read-only view of ui declarations)
    provide("core.registry", {
      ids: () => [...this.extensions.keys()],
      get: (id: string) => {
        const e = this.extensions.get(id);
        return e
          ? { id: e.id, name: e.name, version: e.version, dir: e.dir, configDir: e.configDir, stateDir: e.stateDir, cacheDir: e.cacheDir, source: e.source }
          : undefined;
      },
      ui: (id: string) => this.byId(id)?.ext?.ui ?? null,
      status: () => this.status(),
    });
    // Note: core.bridges is not preset here — __aitiBridges is really a bridge
    // table built by the devtools extension itself (the writer is that extension);
    // when the P1 provider migration lands it will provide "aiti-devtools.bridges"
    // (contracts belong to their owners, §7-1); core doesn't front uncertain contracts.
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

  /** Whether the request path hits the extension's declared public API paths
   *  (publicApi) (the caller guarantees only GET is exempt). Not loaded / not
   *  declared / no hit → false (default gating applies). Delegates to a
   *  module-level function (hot-reload safe, see below). */
  isPublicApiPath(extId: string, apiPath: string): boolean {
    return isPublicApiPath(extId, apiPath);
  }
}

/** Whether the path hits the extension's declared public API paths (publicApi).
 *  Module-level function: under dev hot reload the globalThis singleton may be
 *  an old class instance (without newer methods), so read its extensions Map
 *  directly — after reload ext.ext is the newly loaded module and declaration
 *  fields are readable without relying on class methods. */
export function isPublicApiPath(extId: string, apiPath: string): boolean {
  const reg = (globalThis as { __piWebExt?: { extensions?: Map<string, { ext?: { publicApi?: unknown } }> } }).__piWebExt;
  const ext = reg?.extensions?.get?.(extId);
  if (!ext) return false;
  const declared = ext.ext?.publicApi;
  return Array.isArray(declared) && declared.includes(apiPath);
}

/** Lazy read-only access to the rpc-manager session wrapper table (globalThis
 *  singleton, survives hot reload); used by the core.sessions view. */
const EMPTY_SESSIONS: Map<string, unknown> = new Map();
function piSessionsMap(): Map<string, unknown> {
  return (globalThis as { __piSessions?: Map<string, unknown> }).__piSessions ?? EMPTY_SESSIONS;
}

// proxy.ts (separate middleware bundle, outside the module graph) reads
// declarations through the globalThis bridge (same pattern as __aitiInject)
try { (globalThis as { __piWebExtIsPublicApi?: (extId: string, apiPath: string) => boolean }).__piWebExtIsPublicApi = isPublicApiPath; } catch { /* ignore */ }

/** Process-wide singleton (survives Next.js hot reload). */
export function getRegistry(): ExtRegistryImpl {
  if (!globalThis.__piWebExt) {
    // instrumentation.ts calls ensureRegistry(makeExtCore()) at startup; a
    // missing instance here means the server wasn't fully bootstrapped.
    throw new Error("extension registry not bootstrapped (instrumentation should call ensureRegistry)");
  }
  return globalThis.__piWebExt;
}

/**
 * SSR wrapper: slot declaration table. Returns **null** (not {}) when the
 * registry isn't ready/throws — callers use it to distinguish "definitely no
 * extension declares this slot" from "unknown"; the latter must not drive
 * takeover decisions.
 */
export function getSlotDeclarations(): Record<string, string[]> | null {
  try {
    return getRegistry().slotDeclarations();
  } catch (e) {
    // registry not ready in SSR (or rendering in a context without a registry):
    // return the unknown state and leave one diagnostic.
    console.warn("[pi-web] getSlotDeclarations unavailable (treated as unknown):", e instanceof Error ? e.message : String(e));
    return null;
  }
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
