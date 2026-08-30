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
import { loadExtensionFromDir, scanExtensionDirs, compareExtVersions } from "./loader.ts";
import { buildBootGraph, type PiWebBootGraph } from "./client-modules.ts";
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
/** 功能管理持久化：<dataRoot>/features.json → { [extId]: { [featureId]: boolean | string } }（只存显式设置，默认不落盘）。 */
const FEATURES_FILE = "features.json";

/** ExtUiDefinition 里带条目数组的插槽（扩展管理界面按此统计插入点）。 */
const UI_SLOT_KEYS = [
  "toolbar",
  "sidebar",
  "sidebarFooter",
  "sessionTopbar",
  "sessionRowActions",
  "dialogs",
  "banners",
  "pages",
  "chatInputTop",
] as const;

const SERVER_HOOK_KEYS = ["startup", "shutdown", "api", "middleware"] as const;
const AGENT_HOOK_KEYS = ["agentTools", "onAgentSession", "onAgentSessionEnd", "onAgentSettled"] as const;

/** status 接口的一行（扩展管理界面消费）。 */
export interface ExtStatusEntry {
  loaded: boolean;
  /** false = 在 disabled-extensions.json 里（loadAll 跳过，不执行代码）。 */
  enabled?: boolean;
  error?: string;
  name?: string;
  version?: string;
  source?: ExtensionSource;
  icon?: string | null;
  /** 代码目录（disabled/失败条目也有）。 */
  dir?: string;
  dataDir?: string;
  /** client bundle 文件 + 内容哈希（有 client 才有）。 */
  client?: { file: string; hash: string } | null;
  /** 插入点：slot 名 → 条目 id 列表（声明了 ui 才有）。 */
  slots?: Record<string, string[]>;
  /** 接管的内置能力（EXT_PROVIDES）。 */
  provides?: string[];
  /** client 依赖的其他扩展 id（启动图 inject 边）。 */
  clientDependsOn?: string[];
  /** i18n 语言表。 */
  i18nLocales?: string[];
  /** 服务端钩子（存在即列出）。 */
  serverHooks?: string[];
  /** agent 会话钩子（方案 M 扩展点）。 */
  agentHooks?: string[];
  /** 功能管理：声明 + 当前启停状态（扩展声明了 features 才有）。 */
  features?: ExtStatusFeature[];
  /** 目录里 package.json 的静态信息（不执行代码）。homepage = 来源/文档地址（安装时写入或作者声明）；soul = 灵魂句（extman 展示）。 */
  packageInfo?: { name?: string; version?: string; dependencies?: string[]; homepage?: string; soul?: string };
}

/** 不执行代码读取扩展目录的 package.json（disabled 条目也能有名字/版本/依赖/来源地址）。 */
function readPackageInfo(dir?: string): { name?: string; version?: string; dependencies?: string[]; homepage?: string; soul?: string } {
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
    };
    // homepage → url → repository（string 或 {url}），优先级递减。
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
 * 候选版本（同名裁决用）：package.json version 优先，缺失时退回 entry 声明的
 * version（懒加载探测一次，结果缓存）。探测失败按未知处理——真实错误在候选
 * 胜出后的正式加载时暴露。注意：只对「同名冲突」的候选调用，且禁用的扩展
 * 绝不探测（不执行代码的不变量）。
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

export class ExtRegistryImpl {
  core: ExtCoreApi;
  private readonly extensionsRootOverride?: string;
  private readonly extraExtensionsRootsOverride?: string[];
  private readonly devExtensionsRootOverride?: string | null;
  private readonly bundledExtensionsRootOverride?: string;
  private readonly dataRootOverride?: string;
  private extensions = new Map<string, LoadedExtension>();
  /** 同名裁决结果（loadAll 填充）：id → 胜出候选。status() 复用它保证遮蔽口径一致。 */
  private winners = new Map<string, { dir: string; source: ExtensionSource }>();
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
  // 持久化到 <dataRoot>/disabled-extensions.json（数组）；disable 的扩展在
  // loadAll 时跳过（status 标记 disabled:true），enable 后 reload 恢复。

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
   * 启用/禁用扩展（持久化）。返回新的 disabled 集合。调用方随后应
   * reload()（或 loadAll+startAll）让变更生效。
   */
  setEnabled(id: string, enabled: boolean): void {
    const set = new Set(this.disabledExtensions());
    if (enabled) set.delete(id);
    else set.add(id);
    this.persistDisabled(set);
    this.disabledCache = null; // 使缓存失效（下次读盘）
  }

  // ── 功能管理（features）───────────────────────────────────────────────────
  // 扩展在 entry 里声明 features（能力清单），用户经扩展管理器逐项启用/禁用；
  // 显式设置持久化到 <dataRoot>/features.json，读时合并声明的 default。

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
    this.featureCache = null; // 缓存失效（下次读盘）
  }

  /** 扩展声明里的 feature（按 id）。 */
  private declaredFeature(extId: string, featureId: string): ExtFeature | undefined {
    const ext = this.extensions.get(extId);
    return ext?.ext.features?.find((f) => f.id === featureId);
  }

  /**
   * 功能当前是否启用（boolean 类型）：用户显式设置优先，否则取声明 default（缺省 true）。
   * 供扩展/collectAgentTools 查询；未声明或未知 feature 一律视为启用（不拦截）。
   * string 类型功能无开关语义，恒返回 true（值用 featureValue 查）。
   */
  featureEnabled(extId: string, featureId: string): boolean {
    const declared = this.declaredFeature(extId, featureId);
    if (declared && declared.type === "string") return true;
    const explicit = this.featureFlags()[extId]?.[featureId];
    if (typeof explicit === "boolean") return explicit;
    return declared?.default !== false;
  }

  /**
   * 功能当前值（string 类型）：用户显式设置优先，否则取声明 value（缺省 ""）。
   * boolean 类型返回 featureEnabled 的结果（真值）。
   */
  featureValue(extId: string, featureId: string): boolean | string {
    const declared = this.declaredFeature(extId, featureId);
    if (declared && declared.type === "string") {
      const explicit = this.featureFlags()[extId]?.[featureId];
      if (typeof explicit === "string") return explicit;
      return declared.value ?? "";
    }
    return this.featureEnabled(extId, featureId);
  }

  /**
   * 设置功能启停（boolean 类型，持久化）。显式设置与声明 default 一致时移除条目（保持文件干净）。
   * 返回该 feature 新的生效状态。
   */
  setFeatureFlag(extId: string, featureId: string, enabled: boolean): boolean {
    this.setFeatureValue(extId, featureId, enabled);
    return this.featureEnabled(extId, featureId);
  }

  /**
   * 设置功能值（boolean | string 类型，持久化）。与默认一致则移除条目（保持文件干净）。
   * string 类型：空串与声明默认一致时移除。返回该 feature 新的值。
   */
  setFeatureValue(extId: string, featureId: string, value: boolean | string): boolean | string {
    const flags = this.featureFlags();
    const per = { ...(flags[extId] ?? {}) };
    const declared = this.declaredFeature(extId, featureId);
    const isString = declared && declared.type === "string";
    const isDefault = isString
      ? String(value) === (declared.value ?? "")
      : value === (declared ? declared.default !== false : true);
    if (declared && isDefault) {
      delete per[featureId]; // 与默认一致 → 不落盘
    } else {
      per[featureId] = value;
    }
    const next = { ...flags };
    if (Object.keys(per).length > 0) next[extId] = per;
    else delete next[extId];
    this.persistFeatureFlags(next);
    return this.featureValue(extId, featureId);
  }

  /**
   * 收集某扩展注入 agent 会话的全部工具（含 feature 过滤）。
   * 工具级约定：feature.id = "tool.<注入后的工具名>"。
   * 禁用 → 注入时过滤 + execute 时校验（已有会话的已注入工具也会即时拒绝）。
   */
  private collectExtAgentTools(ext: LoadedExtension, info: Pick<AgentSessionInfo, "sessionId" | "cwd">): ToolDefinition[] {
    const t = this.agentHooks(ext)?.agentTools?.(info);
    if (!t) return [];
    const declared = new Set(ext.ext.features?.map((f) => f.id) ?? []);
    const out: ToolDefinition[] = [];
    for (const tool of t) {
      const fid = "tool." + tool.name;
      const managed = declared.has(fid);
      const enabled = managed ? this.featureEnabled(ext.id, fid) : true;
      if (!enabled) continue; // 注入时过滤
      if (!managed) { out.push(tool); continue; }
      // execute 包装：禁用即时生效（读内存缓存，开销可忽略）——已有会话的已注入工具也会被拒。
      const orig = tool.execute;
      tool.execute = async (toolCallId, params, signal, onUpdate, extCtx) => {
        if (!this.featureEnabled(ext.id, fid)) {
          return {
            content: [{ type: "text", text: `[功能管理] 工具 ${tool.name} 已被禁用（扩展 ${ext.id} 的功能管理设置）——请在扩展管理器中重新启用后重试。` }],
            isError: true,
          } as never;
        }
        return orig
          ? orig(toolCallId, params, signal, onUpdate, extCtx)
          : ({ content: [{ type: "text", text: "" }] } as never);
      };
      out.push(tool);
    }
    return out;
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

  /** 解析顺序即优先级：user → extra（env 列出顺序）→ dev（dev-exts）→ bundled（同名同版本时的回退序）。 */
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
   * 同名裁决（版本优先）：同一 id 出现在多个根时，比各候选目录 package.json 的
   * version（缺失退 entry version）——**版本高者胜，不论在哪个根**；同版本或
   * 双方都无法解析版本时回退根优先级（user > extra > dev > bundled）。落选
   * 候选被遮蔽（静默跳过）。胜出者加载失败不回退到落选候选（fail-fast，
   * 与旧语义一致——静默回退反而加重「改了没生效」的排查难度）。
   * 禁用的扩展不加载也不探测版本（不执行代码）。
   */
  async loadAll(): Promise<void> {
    this.invalidateBootGraph();
    this.extensions.clear();
    this.errors.clear();
    this.winners.clear();

    // 1) 收集候选：按根优先级顺序枚举，id → 候选数组（数组序 = 根优先级）。
    const candidates = new Map<string, Array<{ dir: string; source: ExtensionSource }>>();
    for (const { root, source } of this.extensionRoots()) {
      for (const dir of scanExtensionDirs(root)) {
        const id = dir.split(sep).pop() ?? dir;
        if (!candidates.has(id)) candidates.set(id, []);
        candidates.get(id)!.push({ dir, source });
      }
    }

    // 2) 裁决：版本高者胜；同版本/未知 → 根优先级（数组序靠前者胜）。缓存胜出者
    //    供 status() 复用（禁用枚举与 loadAll 保持同一份遮蔽结果）。
    const disabled = this.disabledExtensions();
    const versionCache = new Map<string, string | undefined>();
    for (const [id, cands] of candidates) {
      let winner = cands[0];
      if (cands.length > 1 && !disabled.has(id)) {
        let winnerVer = await candidateVersion(winner.dir, versionCache);
        for (let i = 1; i < cands.length; i++) {
          const ver = await candidateVersion(cands[i].dir, versionCache);
          if (compareExtVersions(ver, winnerVer) > 0) {
            winner = cands[i];
            winnerVer = ver;
          }
        }
      }
      this.winners.set(id, winner);
    }

    // 3) 加载胜出者（保持首见顺序；失败不回退）。
    for (const [id, winner] of this.winners) {
      if (disabled.has(id)) continue; // 用户禁用 → 不加载（status 里不出现，界面用 isEnabled 展示）
      const { dir, source } = winner;
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
    this.loaded = true;
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

  /**
   * 全量状态（含被禁用与加载失败的扩展）：
   *  - 加载失败 → loaded:false + error
   *  - 被禁用 → enabled:false（读 package.json 静态信息，不执行代码；同名目录用
   *    loadAll 的裁决结果 —— 版本高者胜，同版本/未知回退根优先级）
   *  - 正常 → loaded:true + 插入点/钩子/client 等全部细节
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
      // 优先复用 loadAll 的裁决结果（winners 与加载口径一致）；未 loadAll 过
      // （winners 空）回退首见扫描（旧口径：根优先级）。
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
            };
          }
        }
      }
    }

    for (const ext of this.extensions.values()) {
      const server = ext.ext.server as (ExtServerHooks & { agent?: ExtAgentHooks }) | undefined;
      out[ext.id] = {
        loaded: true,
        enabled: !disabled.has(ext.id),
        name: ext.name,
        version: ext.version,
        source: ext.source,
        icon: ext.ext.icon ?? null,
        dir: ext.dir,
        dataDir: ext.dataDir,
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
          ? ext.ext.features.map((f) => ({ ...f, enabled: this.featureEnabled(ext.id, f.id), ...(f.type === "string" ? { value: String(this.featureValue(ext.id, f.id)) } : {}) }))
          : undefined,
        packageInfo: readPackageInfo(ext.dir),
      };
    }
    return out;
  }

  /** /api/extensions/status 的完整响应体（GET / install / remove 共用）。 */
  statusPayload(): {
    loaded: boolean;
    extensionsRoot: string;
    extraExtensionsRoots: string[];
    devExtensionsRoot: string | null;
    bundledExtensionsRoot: string;
    dataRoot: string;
    extensions: Record<string, ExtStatusEntry>;
  } {
    return {
      loaded: this.isLoaded(),
      extensionsRoot: this.extensionsRoot(),
      extraExtensionsRoots: this.extraExtensionsRoots(),
      devExtensionsRoot: this.devExtensionsRoot(),
      bundledExtensionsRoot: this.bundledExtensionsRoot(),
      dataRoot: this.dataRoot(),
      extensions: this.status(),
    };
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
      // 功能状态（extman 管理）：host 客户端加载时一并取，扩展只读共享 store，无独立请求
      features: e.ext.features?.length ? e.ext.features.map((f) => ({ id: f.id, type: f.type, label: f.label, placeholder: f.placeholder, enabled: this.featureEnabled(e.id, f.id), ...(f.type === "string" ? { value: String(this.featureValue(e.id, f.id)) } : {}) })) : null,
    }));
  }

  /**
   * 启动图（client-modules）：前端 loader 的输入。内容不变则返回稳定对象
   * （与 clientHash 的 mtime 缓存同源，扩展 reload 后自动重算）。
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
          // inject 边预留：扩展可在 ui 里声明 clientDependsOn（DSH inject 边）。
          inject: e.ext.ui?.clientDependsOn,
          // 懒加载：ui.clientImmediately === false → 图行标 immediately:false，
          // 启动阶段不 materialize，首次渲染到声明插槽时才加载。
          immediately: e.ext.ui?.clientImmediately === false ? false : undefined,
        })),
    );
    return this._bootGraph;
  }

  /** 使启动图失效（reload/loadAll 后调用），下次访问重算。 */
  private invalidateBootGraph(): void {
    this._bootGraph = null;
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
      const t0 = Date.now();
      try {
        await ext.ext.server?.startup?.(this.serverContext(ext));
      } catch (e) {
        this.errors.set(ext.id, `startup: ${e instanceof Error ? e.message : String(e)}`);
      }
      // 慢启动钩子告警：startup 阻塞全局 reload（含 extman 启停/安装），单钩子 >1s
      // 视为异常（重活应放后台，只影响扩展自身功能的就绪速度）。
      const ms = Date.now() - t0;
      if (ms > 1000) console.warn(`[ext] slow startup hook: ${ext.id} took ${ms}ms (consider backgrounding init)`);
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
        tools.push(...this.collectExtAgentTools(ext, info));
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

  // ---- 会话标注 slot ----
  private sessionAnnotators = new Map<string, Array<{ extId: string; annotate: (rows: Array<{ id: string; path?: string; cwd?: string }>) => Promise<Record<string, Record<string, unknown>> | void> }>>();

  private registerSessionAnnotator(
    extId: string,
    annotator: { annotate: (rows: Array<{ id: string; path?: string; cwd?: string }>) => Promise<Record<string, Record<string, unknown>> | void> },
  ): void {
    if (!this.sessionAnnotators.has(extId)) this.sessionAnnotators.set(extId, []);
    this.sessionAnnotators.get(extId)!.push({ extId, annotate: annotator.annotate });
  }

  /**
   * 分发标注：把各扩展返回的字段映射按行 id/path 合并进 rows（原地）。
   * 单个标注器异常不阻断整体。
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
          console.error("[ext] session annotator 失败:", e instanceof Error ? e.message : e);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.sessionAnnotators.clear();
    for (const ext of this.extensions.values()) {
      try {
        await ext.ext.server?.shutdown?.(this.serverContext(ext));
      } catch (e) {
        this.errors.set(ext.id, `shutdown: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 会话后端 slot：扩展停用时注销它注册的全部 provider（含 shutdown 回调）。
    await cleanupAllExtensionProviders();
  }

  /** Hot reload: shutdown → reload entries → startup. */
  private reloadInFlight: Promise<void> | null = null;

  /** 热重载：shutdown → loadAll → startAll。并发调用共享同一轮（避免交错丢扩展）。 */
  async reload(): Promise<void> {
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = (async () => {
      await this.shutdown();
      await this.loadAll();
      await this.startAll();
    })();
    try {
      await this.reloadInFlight;
    } finally {
      this.reloadInFlight = null;
    }
  }

  private serverContext(ext: LoadedExtension): ExtServerContext {
    return {
      id: ext.id, dir: ext.dir, dataDir: ext.dataDir, core: this.core,
      // 会话后端注册 slot（多 agent 前端）：键自动加 "<extId>/"" 前缀，shutdown 时自动注销。
      // open/canOpen 委托 openExternalSession（agentKey 解析 + handle 入库）。
      sessionProviders: {
        register: (provider) => registerExtensionProvider(ext.id, provider),
        remove: (type: string) => {
          // 直接操作 globalThis（绕过 turbopack 模块图裁剪）
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
      // 会话标注 slot：数据所有权在扩展（核心不感知桥注册表等具体格式）
      sessionAnnotations: {
        register: (annotator) => this.registerSessionAnnotator(ext.id, annotator),
      },
      // 通用 AI 调用（core 最底层能力，零业务）；按调用扩展 id 记账（token 统计在 core）。
      // caller 允许扩展细分场景（如 aiti-ai-input/complete、aiti-ai-input/voice-fix），缺省用 ext.id
      invokeAI: (p) => aiInvokeImpl({ ...p, caller: (p && p.caller) || ext.id }),
    };
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
