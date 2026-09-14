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
/** 功能管理持久化：<dataRoot>/features.json → { [extId]: { [featureId]: boolean | string } }（只存显式设置，默认不落盘）。 */
const FEATURES_FILE = "features.json";
/** 依赖与能力模型 pin 持久化（P2）：<dataRoot>/ext-pins.json。与 disabled/features 同机制（dataRoot，dev 实例自动隔离）。 */
const PINS_FILE = "ext-pins.json";

/** ExtUiDefinition 里带条目数组的插槽（扩展管理界面按此统计插入点）。 */
const UI_SLOT_KEYS = [
  "toolbar",
  "sidebar",
  "sidebarFooter",
  "sessionTopbar",
  "sessionRowActions",
  "sessionRowMeta",
  "sidebarProjects", // 左栏「项目 / Projects」会话列表整块接管（session-manager SidebarClone）
  "dialogs",
  "banners",
  "pages",
  "chatInputTop",
  "sidebarExplorerDock", // aiti-float dock v0.5.0：侧栏停靠区
  "rightFileDock",       // aiti-float dock v0.5.0：右栏停靠区（tab 化）
  "sidebarTasks",        // aiti-float dock v0.5.1：左栏任务区
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
  /** 配置区（备份范围）；stateDir=持久数据区（不可再生）；cacheDir=缓存区（可删重建）。dataDir 已拆分为三层（数据分层）。 */
  configDir?: string;
  stateDir?: string;
  cacheDir?: string;
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
  /** 目录里 package.json 的静态信息（不执行代码）。homepage = 来源/文档地址（安装时写入或作者声明）；soul = 灵魂句（extman 展示）；protocol = aitiExtProtocol 声明原值。 */
  packageInfo?: { name?: string; version?: string; dependencies?: string[]; homepage?: string; soul?: string; protocol?: string };
  /** 协议声明与兼容状态（宿主裁决；docs/pi-web-ext-protocol.md）。 */
  protocol?: ExtProtocolInfo;
  /** 功能级硬依赖声明（依赖与能力模型：元素 = 扩展 id 或能力名）。 */
  dependsOn?: string[];
  /** 可选依赖声明（纯声明，缺席不影响，不警告）。 */
  optionalDependsOn?: string[];
  /** 提供的能力（provides 声明；与 ui.provides 内置接管区分）。 */
  capsProvides?: string[];
  /** 独占接管的特性（takeover 声明）。 */
  capsTakeover?: string[];
  /** 依赖解析结果（硬 + 可选全部边；core 解析，extman 只渲染）。 */
  depsResolved?: ExtDepResolution[];
  /** takeover 生效状态（同特性多声明者时仅一个 effective=true）。 */
  takeoverResolved?: Array<{ name: string; effective: boolean }>;
}

/** statusPayload.capabilities 的一行：能力名 → 提供者/生效者/消费方（extman 能力视图数据源）。 */
export interface CapabilityViewEntry {
  /** 提供者全集（provides ∪ takeover 声明者，含版本/来源/是否 takeover 声明）。 */
  providers: Array<{ id: string; version: string; source?: ExtensionSource; takeover: boolean }>;
  /** 生效提供者（裁决：pin > takeover > semver 最新 > id 字典序）；无提供者 = null（missing）。 */
  effective: string | null;
  /** 用户 pin 的提供者（未 pin 或 pin 失效时缺省）。 */
  pinnedTo?: string;
  /** 消费方（dependsOn/optionalDependsOn 指向本能力名且未 id 命中的已加载扩展）。 */
  consumers: Array<{ extId: string; hard: boolean }>;
}

/** statusPayload.multiSource 的一行：同 id 多来源组（候选 >1 时才有；extman 冲突/版本管理数据源）。 */
export interface MultiSourceGroup {
  candidates: Array<{ dir: string; source: ExtensionSource; version?: string; winner: boolean }>;
}

/** 协议声明检查 warn 去重（进程级：reload 重复非 ok 不刷屏）。 */
const protocolWarned = new Set<string>();

/** strict 拒载开关（默认关；stale 不在拒载集——宿主保留兼容层）。 */
function protocolStrict(): boolean {
  return process.env.PI_WEB_EXT_PROTOCOL_STRICT === "1";
}

/** 不执行代码读取扩展目录的 package.json（disabled 条目也能有名字/版本/依赖/来源地址）。 */
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
      // 协议声明原值（字符串校验留给 extProtocolInfo——数字等非法类型归 invalid）
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

/** pin 持久化文件结构（<dataRoot>/ext-pins.json）。 */
interface ExtPins {
  /** dev 调试优先（同 id 多来源裁决时 dev 根候选直接胜出；默认关——保持既有裁决契约，开发者显式开启）。 */
  devPriority?: boolean;
  /** pin 表："source:<extId>" → 候选目录；"capability:<cap>" → 提供者扩展 id。 */
  pins?: Record<string, string>;
}

export class ExtRegistryImpl {
  core: ExtCoreApi;
  /** ctx.services 定位器内核（§4-A）：provide/get/require/onChange + reload 反卷。 */
  readonly services = new ExtServicesRegistry();
  /** ctx.features.on 的变更监听（setFeatureValue 后触发；shutdown 时随周期清空）。 */
  private featureListeners = new Set<() => void>();
  /** pin 文件缓存（mtime 失效，同 disabledCache 模式）。 */
  private pinsCache: { mtimeMs: number; data: ExtPins } | null = null;
  private readonly extensionsRootOverride?: string;
  private readonly extraExtensionsRootsOverride?: string[];
  private readonly devExtensionsRootOverride?: string | null;
  private readonly bundledExtensionsRootOverride?: string;
  private readonly dataRootOverride?: string;
  private extensions = new Map<string, LoadedExtension>();
  /** 同名裁决结果（loadAll 填充）：id → 胜出候选。status() 复用它保证遮蔽口径一致。 */
  private winners = new Map<string, { dir: string; source: ExtensionSource }>();
  /** 同 id 多来源候选组（loadAll 填充，仅候选 >1 的 id；multiSource 面板数据源）。 */
  private candidates = new Map<string, MultiSourceGroup["candidates"]>();
  /** 能力注册表（loadAll 重建）：能力名 → 提供者全集（provides ∪ takeover 声明者）。解析器输入。 */
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

  // ── pin（依赖与能力模型 P2：冲突/版本管理）───────────────────────────────
  // 持久化到 <dataRoot>/ext-pins.json：{ devPriority?: boolean, pins: { [key]: value } }。
  // key 约定："source:<extId>" → 值 = 候选目录（同 id 多来源用户指定来源）；
  //          "capability:<cap>" → 值 = 提供者扩展 id（能力生效者用户指定）。
  // pin 只在裁决时软校验（值不在候选/提供者集合 → 忽略回自动），卸载时 clearExtPins 清理。

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
    this.pinsCache = null; // 缓存失效（下次读盘）
  }

  /** 设置/清除 pin（value 为 null/undefined 即清除）。调用方随后应 reload() 让裁决生效。 */
  setPin(key: string, value: string | null): void {
    const data = this.extPins();
    const pins = { ...(data.pins ?? {}) };
    if (value) pins[key] = value;
    else delete pins[key];
    this.persistPins({ ...data, pins });
  }

  /** dev 调试优先开关（同 id 多来源裁决：pin > dev 优先 > 版本 > 根顺序；默认关，显式 opt-in）。 */
  setDevPriority(on: boolean): void {
    this.persistPins({ ...this.extPins(), devPriority: on });
  }

  /** dev 调试优先开关当前值（默认关）。 */
  devPriorityEnabled(): boolean {
    return this.extPins().devPriority === true;
  }

  /** 卸载扩展时清理其相关 pin：source pin 直接删；capability pin 值命中也删。 */
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
   * string / textlist 类型功能无开关语义，恒返回 true（值用 featureValue 查）。
   */
  featureEnabled(extId: string, featureId: string): boolean {
    const declared = this.declaredFeature(extId, featureId);
    if (declared && this.isTextualFeature(declared)) return true;
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
    if (declared && this.isTextualFeature(declared)) {
      const explicit = this.featureFlags()[extId]?.[featureId];
      if (typeof explicit === "string") return explicit;
      return declared.value ?? "";
    }
    return this.featureEnabled(extId, featureId);
  }

  /** 文本类 feature（string 单行 / textlist 多行）：无开关语义，取值走 featureValue */
  private isTextualFeature(declared: { type?: "boolean" | "string" | "textlist" }): boolean {
    return declared.type === "string" || declared.type === "textlist";
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
    const isString = declared && this.isTextualFeature(declared);
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
    this.notifyFeatureListeners();
    return this.featureValue(extId, featureId);
  }

  /** ctx.features.on 的广播（任一 feature 落盘变更后触发；监听方错误不阻断）。 */
  private notifyFeatureListeners(): void {
    for (const cb of [...this.featureListeners]) {
      try { cb(); } catch { /* ignore */ }
    }
  }

  /**
   * 收集某扩展注入 agent 会话的全部工具（含 feature 过滤）。
   * 工具级约定：feature.id = "tool.<注入后的工具名>"。
   * 禁用 → 注入时过滤 + execute 时校验（已有会话的已注入工具也会即时拒绝）。
   */
  /**
   * 收集单个扩展的 agent 工具（含门控）。
   * `forced=true`（会话级强制启用）：该扩展在本次会话被显式点名启用，无视 feature 门控全部放行
   * （用于「按需开」——建会话时传 enableExts，不依赖改全局 feature 状态，无竞态/无残留）。
   * `forced=false`：走常规 feature 门控（整组门 / per-tool）。
   */
  private collectExtAgentTools(ext: LoadedExtension, info: Pick<AgentSessionInfo, "sessionId" | "cwd">, forced = false): ToolDefinition[] {
    const t = this.agentHooks(ext)?.agentTools?.(info);
    if (!t) return [];

    // 会话级强制启用：无视 feature，全部放行。
    // 不包 execute 门控检查——forced 是本会话显式授权（enableExtTools），工具在本会话应始终可用，
    // 不能被全局 feature 状态（features.json 里 agentTools.enabled 仍为 false）撤销（否则注入成功但一调就被拒）。
    if (forced) {
      return t;
    }

    const declared = new Set(ext.ext.features?.map((f) => f.id) ?? []);
    const out: ToolDefinition[] = [];
    for (const tool of t) {
      const fid = "tool." + tool.name;
      const managed = declared.has(fid);
      // 未声明整组门 → 纯 per-tool 语义
      const hasWholeGate = (ext.ext.features ?? []).some((f) => f.id === "agentTools.enabled" && f.type !== "string");
      const wholeGateOn = hasWholeGate ? this.featureEnabled(ext.id, "agentTools.enabled") : true;
      // 整组门（粗开关，覆盖 per-tool）：关 → 全组不注入；开 → 忽略 per-tool 默认、全部放行。
      // 未声明整组门 → 纯 per-tool 语义（managed ? featureEnabled : true）。
      const enabled = hasWholeGate ? wholeGateOn : (managed ? this.featureEnabled(ext.id, fid) : true);
      if (!enabled) continue;
      // 整组门开时 execute 包装检查整组门（关即拒，即时生效）；否则检查 per-tool fid
      const checkFid = (hasWholeGate && wholeGateOn) ? "agentTools.enabled" : fid;
      if (!managed) { out.push(tool); continue; }
      out.push(this.wrapAgentToolExecute(ext, tool, checkFid));
    }
    return out;
  }

  /** execute 包装：禁用即时生效（读内存缓存，开销可忽略）——已有会话的已注入工具也会被拒。 */
  private wrapAgentToolExecute(ext: LoadedExtension, tool: ToolDefinition, checkFid: string): ToolDefinition {
    const orig = tool.execute;
    tool.execute = async (toolCallId, params, signal, onUpdate, extCtx) => {
      if (!this.featureEnabled(ext.id, checkFid)) {
        return {
          content: [{ type: "text", text: `[功能管理] 工具 ${tool.name} 已被禁用（扩展 ${ext.id} 的功能管理设置）——请在扩展管理器中重新启用后重试。` }],
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
   * 同名裁决（依赖与能力模型 §5.2）：同一 id 出现在多个根时——
   *   用户 pin（ext-pins.json source:<id>，值命中候选目录）
   *   > dev 调试优先（extPins.devPriority 缺省开；dev 根候选直接胜出，
   *     解决 dev-exts 开发被 user 根「更新版本」遮蔽的痛点；只影响有 dev 根的机器）
   *   > 版本高者胜（候选目录 package.json version，缺失退 entry version）
   *   > 根优先级（user > extra > dev > bundled；同版本/双方都不可解析时兑底）。
   * 落选候选被遮蔽（静默跳过），多候选组记入 candidates（multiSource 面板展示）。
   * 胜出者加载失败不回退到落选候选（fail-fast，与旧语义一致——静默回退反而加重
   * 「改了没生效」的排查难度）。禁用的扩展不加载也不探测版本（不执行代码）。
   */
  async loadAll(): Promise<void> {
    this.invalidateBootGraph();
    this.extensions.clear();
    this.errors.clear();
    this.winners.clear();
    this.candidates.clear();

    // 1) 收集候选：按根优先级顺序枚举，id → 候选数组（数组序 = 根优先级）。
    const candidates = new Map<string, Array<{ dir: string; source: ExtensionSource }>>();
    for (const { root, source } of this.extensionRoots()) {
      for (const dir of scanExtensionDirs(root)) {
        const id = dir.split(sep).pop() ?? dir;
        if (!candidates.has(id)) candidates.set(id, []);
        candidates.get(id)!.push({ dir, source });
      }
    }

    // 2) 裁决：pin > dev 优先 > 版本 > 根优先级。胜出者缓存供 status() 复用；
    //    多候选组连同各自版本记入 candidates（multiSource 面板展示 + pin 可选）。
    const disabled = this.disabledExtensions();
    const pinsData = this.extPins();
    const pinMap = pinsData.pins ?? {};
    const devPriority = pinsData.devPriority === true; // 默认关（拍板反转 plan 倾向）：既有契约「dev 同名不抢 extra/版本裁决」保持；开发者显式 opt-in（extman 开关）
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

    // 3) 加载胜出者（保持首见顺序；失败不回退）。
    //    PI_WEB_EXT_TIMING=1：逐扩展记 import 耗时 + 重转译文件数（jiti 缓存快照
    //    diff），循环尾打总表——「fsCache 持久命中」验收从外部 bench 估算变为直接
    //    读表（pi PI_TIMING 式加载观测，方案 §7.1②）。串行加载保证 miss 归因正确。
    const timingEnabled = process.env.PI_WEB_EXT_TIMING === "1";
    const timings: Array<{ id: string; ms: number; retranspiled: number }> = [];
    for (const [id, winner] of this.winners) {
      if (disabled.has(id)) continue; // 用户禁用 → 不加载（status 里不出现，界面用 isEnabled 展示）
      const { dir, source } = winner;
      const timingT0 = timingEnabled ? performance.now() : 0;
      const cacheBefore = timingEnabled ? snapshotJitiCache() : null;
      try {
        // 协议声明检查（docs/pi-web-ext-protocol.md）：非 ok 一条 warn（进程级去重，reload 不刷屏）；
        // PI_WEB_EXT_PROTOCOL_STRICT=1 时拒载 incompatible/missing/invalid/too_new（stale 仍加载——宿主保留兼容层）。
        const protoInfo = extProtocolInfo(readPackageInfo(dir).protocol);
        if (protoInfo.state !== "ok" || protoInfo.minorAhead) {
          const warnKey = `${id}@${protoInfo.state}@${protoInfo.declared ?? ""}@${protoInfo.current}`;
          if (!protocolWarned.has(warnKey)) {
            protocolWarned.add(warnKey);
            const tip = protoInfo.needsUpgrade ? "——可用 extman「🤖 AI 升级」走 ext-protocol-upgrade skill" : "";
            console.warn(`[ext] ${id} 协议声明 ${protoInfo.declared ?? "(未声明)"} vs 当前 ${protoInfo.current}：${protoInfo.state}${protoInfo.detail ? "（" + protoInfo.detail + "）" : ""}${tip}`);
          }
        }
        if (protocolStrict() && EXT_PROTOCOL_STRICT_BLOCKED.includes(protoInfo.state)) {
          this.errors.set(id, `协议不兼容（${protoInfo.state}：声明 ${protoInfo.declared ?? "—"} vs 当前 ${protoInfo.current}）— PI_WEB_EXT_PROTOCOL_STRICT=1`);
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
        // 数据分层（三目录对称，2026-09-13）：config/state/cache 均为 <dataRoot>/<id>/ 子目录；
        // configDir = 配置区（备份范围），stateDir = 持久数据区（不可再生，不得假设丢失），
        // cacheDir = 缓存区（可整体删除重建，惰性创建）
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
        console.error(`[ext] ${id} 加载失败:`, msg);
        this.errors.set(id, msg);
      } finally {
        if (timingEnabled) {
          timings.push({ id, ms: performance.now() - timingT0, retranspiled: countRetranspiled(cacheBefore!, snapshotJitiCache()) });
        }
      }
    }
    // [懒加载 v2] 标懒静态诊断（不拦截）：clientImmediately:false 却没有任何
    // ui[slot][] 条目声明 → 首插槽渲染即物化（常挂插槽）或永不物化（静默失效）。
    // 有条目声明的交给客户端静态入口/交互插槽机制（dev 断言在 ext-ui-store 合并层）。
    for (const ext of this.extensions.values()) {
      if (ext.ext.ui?.clientImmediately !== false) continue;
      const hasStaticEntry = Object.entries(ext.ext.ui).some(
        ([k, v]) => !["i18n", "provides", "clientDependsOn", "clientImmediately"].includes(k) && Array.isArray(v) && v.length > 0,
      );
      if (!hasStaticEntry) {
        this.errors.set(ext.id, "标懒无效：无任何 ui[slot][] 静态入口（常挂插槽首渲染即物化，或永不物化静默失效）——补静态条目或去掉 clientImmediately:false");
      }
    }
    this.buildCapabilityIndex();
    this.loaded = true;
    if (timingEnabled) {
      const total = timings.reduce((s, t) => s + t.ms, 0);
      const misses = timings.filter((t) => t.retranspiled > 0).length;
      console.log(`[ext-timing] loadAll: ${timings.length} 个扩展 / ${total.toFixed(0)}ms — 缓存命中 ${timings.length - misses}、重转译 ${misses}（PI_WEB_EXT_TIMING=1 门控观测）`);
      for (const [i, t] of timings.entries()) {
        console.log(`[ext-timing]   ${(i + 1).toString().padStart(2)}. ${t.id.padEnd(32)} ${t.ms.toFixed(0).padStart(5)}ms  ${t.retranspiled > 0 ? `MISS（重转译 ${t.retranspiled} 文件）` : "hit"}`);
      }
    }
  }

  /**
   * 能力注册表（依赖与能力模型 §4）：loadAll 尾部构建，reload 重建——
   * 能力名 → 提供者全集（provides ∪ takeover 声明者，均为已加载扩展）。
   * 解析 O(1) 查表；禁用/加载失败者不在集合内（不提供能力）。
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
   * 能力生效提供者裁决（§5.1）：用户 pin > takeover 声明者优先（独占语义）>
   * semver 版本最新 > 扩展 id 字典序（末位保证确定性）。pin 值不在提供者集合时
   * 忽略（软校验回自动，卸载/重装后 pin 失效不患空）。
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
   * 依赖声明元素解析（§5.1）：id 精确命中（含禁用/失败的存在性，winners 全集）→
   * kind="ext"；否则按能力名解析 → kind="cap"。missing/inactive 只标注不拦截。
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

  /** 加载/启动失败清单（id → error，jiti 解析错/entry 校验/startup throw）。
   *  manifest 随路带给前端（ExtSlots 注册进左下角错误指示器）——页面打开即可见，
   *  不必再开 extman 查 /status。 */
  loadFailures(): Array<{ id: string; error: string }> {
    return [...this.errors].map(([id, error]) => ({ id, error }));
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
      // startup/shutdown 失败的扩展也在此循环里（加载成功但启动挂了）：error 必须带上，
      // 否则被 loaded:true 默认值覆盖，extman 里看不到异常（entry 加载失败不在此列，
      // 那时扩展根本不在 extensions map）。
      const startupError = this.errors.get(ext.id);
      // 依赖与能力模型（§4 透传）：四字段声明 + 解析结果（id 优先；能力边含生效提供者）。
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

  /** /api/extensions/status 的完整响应体（GET / install / remove 共用）。 */
  statusPayload(): {
    loaded: boolean;
    extensionsRoot: string;
    extraExtensionsRoots: string[];
    devExtensionsRoot: string | null;
    bundledExtensionsRoot: string;
    dataRoot: string;
    extensions: Record<string, ExtStatusEntry>;
    /** 存活服务清单（§7-7 服务可见性：key + 提供者；extman 面板消费）。 */
    services: Array<{ key: string; extId: string }>;
    /** 能力视图（依赖与能力模型 P1）：能力名 → 提供者/生效者/消费方；含 missing 能力。 */
    capabilities: Record<string, CapabilityViewEntry>;
    /** 同 id 多来源组（P2）：候选 >1 的 id → 候选列表（winner 标记当前生效者）。 */
    multiSource: Record<string, MultiSourceGroup>;
    /** pin 现状（P2）：dev 优先开关 + pin 表（extman 面板回显）。 */
    pins: { devPriority: boolean; pins: Record<string, string> };
    /** 协议版本基线（docs/pi-web-ext-protocol.md；extman/前端消费）。 */
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
   * 能力视图（extman 渲染数据源，§6.2）：提供者/生效提供者/pin/消费方；
   * 还收编只在依赖声明里出现、无提供者的能力（missing 标注用）。
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
    // 消费方（含 missing 能力）：依赖元素指向能力名且未 id 命中的已加载扩展。
    for (const ext of this.extensions.values()) {
      for (const [names, hard] of [[ext.ext.dependsOn, true], [ext.ext.optionalDependsOn, false]] as const) {
        for (const n of names ?? []) {
          if (this.winners.has(n)) continue; // id 优先：已按扩展依赖处理，不算能力消费
          const e = entry(n);
          e.consumers.push({ extId: ext.id, hard });
        }
      }
    }
    return out;
  }

  /** 同 id 多来源组（仅候选 >1 的 id；候选版本缺失 = 禁用未探测）。 */
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
      // clientUrl 带文件内容哈希（?v=<sha256 前 12 位>）：扩展 client 更新 → URL 变 → 浏览器强制重新拉取（无需硬刷/清缓存）
      clientUrl: e.ext.client ? `/api/extensions/${e.id}/assets/${e.ext.client}?v=${this.clientHash(e)}` : null,
      ui: e.ext.ui ?? null,
      source: e.source,
      icon: e.ext.icon ?? null,
      // 依赖与能力模型（§4 透传）：运行时可探测——扩展 client 拿全量 manifest 后
      // 可判断依赖的能力是否有生效提供者 / 某可选扩展在不在，决定是否启用附加功能。
      ...(e.ext.dependsOn?.length ? { dependsOn: [...e.ext.dependsOn] } : {}),
      ...(e.ext.optionalDependsOn?.length ? { optionalDependsOn: [...e.ext.optionalDependsOn] } : {}),
      ...(e.ext.provides?.length ? { provides: [...e.ext.provides] } : {}),
      ...(e.ext.takeover?.length ? { takeover: [...e.ext.takeover] } : {}),
      // 功能状态（extman 管理）：host 客户端加载时一并取，扩展只读共享 store，无独立请求
      features: e.ext.features?.length ? e.ext.features.map((f) => ({ id: f.id, type: f.type, label: f.label, placeholder: f.placeholder, enabled: this.featureEnabled(e.id, f.id), ...(f.type === "string" || f.type === "textlist" ? { value: String(this.featureValue(e.id, f.id)) } : {}) })) : null,
    }));
  }

  /**
   * 各 UI 插槽的声明方扩展 id（slot → extId[]）。服务端权威事实，供 SSR 首帧裁决使用：
   * 例：`sidebarContent` 有声明方 → 首帧就渲染接管占位而非宿主回退侧栏（避免回退组件
   * 挂载即拉一次全量会话列表、随即又被接管替换——见 docs/pi-web-load-perf-optimization-plan.md §5）。
   * 只收非空数组的槽位键；排除元数据键（i18n/provides/clientDependsOn/clientImmediately）。
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
          // eager 批量包排除项（见 lib/ext/client-bundle.ts 头注释）：
          // 仅 import.meta 使用者（资产基址依赖入口 URL，打包后路径漂移）。
          // 拆包扩展（薄壳 + 懒 chunk）不排除——由批量包构建器把其静态相对 import
          // 外置为文件 URL，保证共享 chunk 运行时单实例。
          bundleExcluded: usesImportMeta(join(e.dir, e.ext.client!)),
          // inject 边预留：扩展可在 ui 里声明 clientDependsOn（DSH inject 边）。
          inject: e.ext.ui?.clientDependsOn,
          // 懒加载：ui.clientImmediately === false → 图行标 immediately:false，
          // 启动阶段不 materialize，首次渲染到声明插槽时才加载。
          immediately: e.ext.ui?.clientImmediately === false ? false : undefined,
          // 前端 materialize 优先级透传（统一 SSE 端口方案 §3-B）：ExtSlots 先单独
          // materialize 最高 priority 项（aiti-event-bus 的 window.__piEventBus 先挂槽），
          // 其余立即项并行。undefined 不进行（前端默认 0，与后端一致）。
          priority: e.ext.startupPriority,
        })),
    );
    return this._bootGraph;
  }

  /** 使启动图失效（reload/loadAll 后调用），下次访问重算。 */
  private invalidateBootGraph(): void {
    this._bootGraph = null;
    this._clientBundleCache = null;
  }

  private _clientBundleCache: { rev: string; code: string; ids: string[] } | null = null;
  private _clientBundleInFlight: Promise<{ rev: string; code: string; ids: string[] }> | null = null;

  /**
   * eager 扩展批量 client bundle（按图 rev 缓存；首建 ~0.3-1s，之后零成本）。
   * 内容寻址：调用方 URL 带 ?rev=，可 immutable 缓存；扩展 reload → 图 rev 变 → 重打。
   * 构建期发现 import.meta 漏网项会自动剔除并重打（offenders 记日志）。
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
        console.warn(`[ext] client bundle: import.meta 漏网扩展已剔除: ${built.offenders.join(", ")}`);
      }
      if (built.chunked.length) {
        // 拆包扩展：静态共享 chunk 外置（懒 chunk 运行时与包内引用同一文件实例）
        console.info(`[ext] client bundle: 拆包扩展静态依赖外置: ${built.chunked.join(", ")}`);
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

  /** 预热 eager 批量包（启动/重载后台构建，首个页面请求零等待）。允许失败。 */
  warmClientBundle(): void {
    void this.clientBundle().catch((e) => {
      console.warn("[ext] client bundle warmup failed:", e);
    });
  }

  /** Invoke all server.startup hooks (best-effort per extension). */
  async startAll(): Promise<void> {
    this.provideCoreServices();
    // 统一 SSE 端口方案 §3-A：按 startupPriority 降序稳定排序（默认 0，同优先级保持
    // 扫描原序）——基础设施级扩展（aiti-event-bus=100）的 startup 先于一切消费扩展：
    // __piPageEvents 访问器接管、publish/publish-local 服务出口、/subscribe /events
    // 路由在其它扩展 startup 发布前就绪（消费方不得因总线晚到另起炉灶/撞 404）。
    const ordered = [...this.extensions.values()].map((ext, i) => ({ ext, i }))
      .sort((a, b) => (b.ext.ext.startupPriority ?? 0) - (a.ext.ext.startupPriority ?? 0) || a.i - b.i)
      .map((x) => x.ext);
    for (const ext of ordered) {
      if (this.startedIds.has(ext.id)) continue; // 已被 startupById 单开先行启动：不重复
      await this.startupOne(ext);
    }
    // eager 批量包后台预热（首个页面请求零等待；允许失败，前端有逐扩展回退）。
    this.warmClientBundle();
  }

  /** 已执行 startup 的扩展 id（startupById/startAll 共账；shutdown 周期清空）。 */
  private startedIds = new Set<string>();

  /** 单扩展 startup（best-effort + 慢启动告警），成功后记账。 */
  private async startupOne(ext: LoadedExtension): Promise<void> {
    const t0 = Date.now();
    try {
      await ext.ext.server?.startup?.(this.serverContext(ext));
    } catch (e) {
      const msg = `startup: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[ext] ${ext.id} startup 失败:`, msg);
      this.errors.set(ext.id, msg);
    }
    // 慢启动钩子告警：startup 阻塞全局 reload（含 extman 启停/安装），单钩子 >1s
    // 视为异常（重活应放后台，只影响扩展自身功能的就绪速度）。
    const ms = Date.now() - t0;
    if (ms > 1000) console.warn(`[ext] slow startup hook: ${ext.id} took ${ms}ms (consider backgrounding init)`);
    this.startedIds.add(ext.id);
  }

  /**
   * 统一 SSE 端口方案 §3-A 强化：总线服务端单开先行 startup——不等扩展批量。
   * 宿主启动序列（instrumentation）在 loadAll 后、startAll 前单独调用：/events
   * /subscribe 路由与 __piPageEvents 接管在任何消费扩展（及宿主后续初始化）之前
   * 就绪。幂等：重复调用/与 startAll 重叠都不会二次 startup；扩展缺席（未安装/
   * 停用）静默跳过（返回 false），消费方按各自契约回退。
   * @returns 总线是否存在且已（或此前已）startup。
   */
  async startupById(id: string): Promise<boolean> {
    if (this.startedIds.has(id)) return true;
    const ext = this.extensions.get(id);
    if (!ext) return false;
    await this.startupOne(ext);
    return true;
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

  /**
   * per-session 收集：与本会话默认收集一致，但对 `enableExts` 里的扩展**强制放行**（无视 feature 门控）。
   * 用于「按需开」——建会话时传 enableExts，不依赖改全局 feature 状态（无竞态、无失败残留）。
   * 其余扩展仍走 feature 门控。
   */
  collectAgentToolsWith(info: Pick<AgentSessionInfo, "sessionId" | "cwd">, enableExts?: string[]): ToolDefinition[] {
    const forced = new Set(enableExts ?? []);
    const tools: ToolDefinition[] = [];
    for (const ext of this.extensions.values()) {
      try {
        tools.push(...this.collectExtAgentTools(ext, info, forced.has(ext.id)));
      } catch (e) {
        console.error(`[ext] ${ext.id}.agent.agentTools 失败:`, e instanceof Error ? e.message : e);
      }
    }
    return tools;
  }

  /**
   * 会话订阅纪元账本：sessionId → 本纪元内扩展经 subscribeEvent 建立的退订函数。
   * dispatchAgentSession 每次调用开启新纪元（开始前先回收上一纪元）；会话结束时清账。
   * registry 是 globalThis 单例，跨 reload 幸存——reload 重挂（reattachAgentSessions）
   * 依赖它做到「扩展不主动退订也不双发」。
   */
  private agentSessionSubs = new Map<string, Set<() => void>>();

  /** 会话启动回调（wrapper 创建后）。每次调用即开启该会话的新「订阅纪元」：
   *  先回收上一纪元由宿主记录的 subscribeEvent 退订（防 idle GC 重建 / reload 重挂
   *  双发），再把本纪元新订阅记入账本。 */
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
              // 仅当仍处于本闭包对应的纪元时才记账；已换代/已收（扩展异步迟到订阅）
              // → 立即退订，避免旧纪元订阅混进新纪元造成双发。
              if (this.agentSessionSubs.get(info.sessionId) === subs) subs.add(off);
              else { try { off(); } catch { /* 纪元已换代/已收（会话结束）→ 迟到订阅立即退订 */ } }
            }
            return off;
          },
        }
      : info;
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSession?.(fanout); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSession 失败:`, e instanceof Error ? e.message : e); }
    }
  }

  /** 回收某会话当前纪元记录的扩展订阅（幂等：扩展自己已退订的条目重复调用无副作用）。 */
  private releaseAgentSessionSubs(sessionId: string): void {
    const subs = this.agentSessionSubs.get(sessionId);
    if (!subs) return;
    this.agentSessionSubs.delete(sessionId);
    for (const off of subs) {
      try { off(); } catch { /* 单条失败不阻断 */ }
    }
  }

  /** 会话销毁回调（wrapper destroy，含 fork/idle-GC 回收场景，reason 区分）。 */
  dispatchAgentSessionEnd(sessionId: string, reason?: ExtAgentEndReason): void {
    for (const ext of this.extensions.values()) {
      try { this.agentHooks(ext)?.onAgentSessionEnd?.({ sessionId, reason }); } catch (e) { console.error(`[ext] ${ext.id}.agent.onAgentSessionEnd 失败:`, e instanceof Error ? e.message : e); }
    }
    // 扩展回调之后清账：回收本会话纪元订阅（即使扩展未主动退订也不残留）。
    this.releaseAgentSessionSubs(sessionId);
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
    // 与 startAll 对称逆序（priority 低者先停，总线最后停）：reload 期间消费扩展
    // 先退订/收尾，基础设施级扩展最后收口（统一 SSE 端口方案 §3-A）。
    const ordered = [...this.extensions.values()].map((ext, i) => ({ ext, i }))
      .sort((a, b) => (a.ext.ext.startupPriority ?? 0) - (b.ext.ext.startupPriority ?? 0) || b.i - a.i)
      .map((x) => x.ext);
    for (const ext of ordered) {
      this.startedIds.delete(ext.id); // 本周期 startup 账目清零（下周期重新记账）
      try {
        await ext.ext.server?.shutdown?.(this.serverContext(ext));
      } catch (e) {
        this.errors.set(ext.id, `shutdown: ${e instanceof Error ? e.message : String(e)}`);
      }
      // 服务反卷（§4-A）：扩展提供的全部服务下线（钩子收尾后才撤，广播 down 供消费方重订）
      this.services.revokeExt(ext.id);
    }
    // 会话后端 slot：扩展停用时注销它注册的全部 provider（含 shutdown 回调）。
    await cleanupAllExtensionProviders();
    // 重载周期收尾：core.* 预置服务一并下线（startAll 重新 provide），监听随旧周期闭包清空
    this.services.clear();
    this.featureListeners.clear();
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
      // 会话（wrapper）跨 reload 存活，断的是「新扩展模块 ⇄ wrapper」订阅接线：
      // startAll 后对存活会话补发 agent 钩子，让扩展重新挂订阅（方案
      // docs/pi-web-ext-reload-session-resubscribe-plan.md）。
      this.reattachAgentSessions();
    })();
    try {
      await this.reloadInFlight;
    } finally {
      this.reloadInFlight = null;
    }
  }

  /**
   * reload 完成后重挂：对存活的、曾派发过钩子的本地会话补发 dispatchAgentSession。
   * 过滤走 wrapper 的 isAlive/hasAgentSessionHooks（子代理 wrapper 从未派发钩子，
   * 不纳入）；dispatchAgentSession 内部先回收旧纪元订阅 → 重挂不双发。顺带覆盖
   * reload 竞态：shutdown→startAll 之间新建的会话可能只派发到空/半加载扩展集合，
   * 这里统一捞回。
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
          // 已销毁（destroy 同步置死，end 回调经异步 emit session_shutdown 后才到）：
          // 顺手清账，防旧纪元订阅残留到 end 到达前（end 到达后 release 幂等无副作用）。
          this.releaseAgentSessionSubs(sid);
          continue;
        }
        if (wrapper.hasAgentSessionHooks?.() !== true) continue;
        const info = wrapper.toAgentSessionInfo?.();
        if (!info) continue;
        this.dispatchAgentSession(info);
        n++;
      } catch (e) {
        console.error(`[ext] reload 重挂会话钩子失败 (${sid}):`, e instanceof Error ? e.message : e);
      }
    }
    if (n > 0) console.log(`[ext] reload 重挂 ${n} 个存活会话的 agent 钩子`);
  }

  private serverContext(ext: LoadedExtension): ExtServerContext {
    const ctx: ExtServerContext = {
      id: ext.id, dir: ext.dir, configDir: ext.configDir, stateDir: ext.stateDir, cacheDir: ext.cacheDir, core: this.core,
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
      // 跨扩展服务定位器（§4-A）：provide 强制 "<extId>." 前缀（防冒充）；reload 反卷在 shutdown()
      services: {
        provide: <T,>(key: string, impl: T) => this.services.provide(ext.id, key, impl),
        get: <T,>(key: string) => this.services.get<T>(key),
        require: <T,>(key: string, timeoutMs?: number) => this.services.require<T>(key, timeoutMs),
        onChange: (cb) => this.services.onChange(cb),
      },
      // feature 读写收口（§4-A）：get(fid) 读本扩展 / get(extId, fid) 读指定扩展；on 订阅变更
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
    // dataDir 防误用闸（数据分层 breaking 拆分）：访问即抛——不返回 undefined（那会拼出 "undefined/x"
    // 静默错路径更难排）；错误信息直接指路正确 API 与升级口径（npm 旧扩展包命中时据此升级）
    Object.defineProperty(ctx, "dataDir", {
      get() {
        throw new Error(
          "[pi-web] ctx.dataDir 已移除（数据分层 breaking）：配置用 ctx.configDir，不可再生的持久数据（归档/历史/统计/数据库）用 ctx.stateDir，缓存/可重建数据用 ctx.cacheDir" +
          "（扩展需升级到配套版本；见 pi-web-ext authoring-reference §2.1 数据分层）"
        );
      },
    });
    return ctx;
  }

  /** core.* 预置服务（§4-A core 命名空间）：惰性现取的只读视图（单例/热重载更替不悬空）。 */
  private provideCoreServices(): void {
    const provide = (key: string, impl: unknown) => this.services.provide("core", key, impl);
    // core.sessions —— rpc-manager 会话 wrapper 只读表（§1.1：替代 __piSessions 直读；
    // wrapper 本体是运行面句柄（send/onEvent/abortBash…），「只读」指不得增删改会话表）
    provide("core.sessions", {
      ids: () => [...piSessionsMap().keys()],
      has: (id: string) => piSessionsMap().has(id),
      get: (id: string) => piSessionsMap().get(id),
    });
    // core.registry —— registry 只读投影（extman 等管理面用；替代 __piWebExt 直读。
    // 不发 ext entry 本体——只给元数据投影 + status 快照 + ui 声明只读视图）
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
    // 注：core.bridges 不在此预置——__aitiBridges 实为 aiti-devtools 扩展自建的桥表
    // （写入方在该扩展），P1 提供方迁移时由它以 "aiti-devtools.bridges" provide
    // （契约归所有者，§7-1）；core 不代发不确定的契约。
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

  /** 扩展声明的公开 API 路径（publicApi）是否命中该请求 path（调用方保证仅 GET 豁免）。
   *  未加载 / 未声明 / 不命中 → false（走默认门禁）。实现委托模块级函数（热重载安全，见下）。 */
  isPublicApiPath(extId: string, apiPath: string): boolean {
    return isPublicApiPath(extId, apiPath);
  }
}

/** 扩展声明的公开 API 路径（publicApi）是否命中。模块级函数：dev 热重载下 globalThis 单例
 *  可能是旧类实例（无新方法），直接读其 extensions Map —— reload 后 ext.ext 是新加载模块，
 *  声明字段天然可读，不依赖类方法。 */
export function isPublicApiPath(extId: string, apiPath: string): boolean {
  const reg = (globalThis as { __piWebExt?: { extensions?: Map<string, { ext?: { publicApi?: unknown } }> } }).__piWebExt;
  const ext = reg?.extensions?.get?.(extId);
  if (!ext) return false;
  const declared = ext.ext?.publicApi;
  return Array.isArray(declared) && declared.includes(apiPath);
}

/** rpc-manager 会话 wrapper 表（globalThis 单例，热重载幸存）的惰性只读访问（core.sessions 视图用）。 */
const EMPTY_SESSIONS: Map<string, unknown> = new Map();
function piSessionsMap(): Map<string, unknown> {
  return (globalThis as { __piSessions?: Map<string, unknown> }).__piSessions ?? EMPTY_SESSIONS;
}

// proxy.ts（独立 middleware bundle，不经模块图）经 globalThis 桥读声明判定（与 __aitiInject 同模式）
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
 * SSR 用包装：插槽声明表。注册表未就绪/异常时返回 **null**（而非 {}）——调用方据此
 * 区分「确定没有任何扩展声明该槽」与「未知」，后者不得用于接管裁决。
 */
export function getSlotDeclarations(): Record<string, string[]> | null {
  try {
    return getRegistry().slotDeclarations();
  } catch (e) {
    // SSR 里注册表未就绪（或渲染在无 registry 的上下文）：返回未知态，并留一次诊断。
    console.warn("[pi-web] getSlotDeclarations 不可用（按未知处理）:", e instanceof Error ? e.message : String(e));
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
