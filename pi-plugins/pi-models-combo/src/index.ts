/**
 * pi-models-combo — model filtering + API key rotation proxy.
 *
 * Why
 * ---
 * 1. Filter: hide built-in catalog models (openrouter has 300+), keep only
 *    what you configured in models.json.
 * 2. Rotate: when a provider has multiple apiKeys, a local proxy intercepts
 *    all requests. It replaces the auth header (scheme per api type) with a
 *    rotating key, retries on 429 with the next key, and puts exhausted keys
 *    on cooldown.
 *
 * How pi sees it
 * --------------
 * pi only sees a normal baseUrl pointing to 127.0.0.1. It sends a random
 * dummy token (Bearer / x-api-key / x-goog-api-key — whichever its client
 * uses for that provider). The proxy replaces it with a real key from
 * models.json. pi never knows the proxy exists, never touches the real keys,
 * and never sees rate-limit errors (proxy retries internally).
 *
 * Provider rewiring goes through the official ExtensionAPI:
 *   pi.registerProvider(providerId, { baseUrl: proxyUrl, apiKey: dummyToken })
 * Extension-registered baseUrl/apiKey take precedence over models.json in
 * the SDK's provider composer, while models stay untouched.
 *
 * Lifecycle / coexistence
 * -----------------------
 * Proxy state lives on globalThis.__piModelsCombo so ANY number of module
 * copies (CLI session, every aiti-ai RPC session, jiti re-imports) share one
 * set of proxies: loading is idempotent (no port leaks), models.json mtime
 * changes restart the affected set, and stopAllRespect() releases everything.
 *
 * Configuration (models.json)
 * ----------------------------
 * Multi keys live under each provider in models.json (pi ignores the field,
 * it is never forwarded in headers — only apiKey/baseUrl reach the wire):
 *   "providers": {
 *     "openrouter": {
 *       "baseUrl": "https://openrouter.ai/api/v1",
 *       "apiKey": "sk-xxx1",   ← 第一个 key（pi 直连/代理注入 dummy 均兼容）
 *       "apiKeys": [
 *         { "name": "key-1", "key": "sk-xxx1", "rpm": 60 },
 *         { "name": "key-2", "key": "sk-xxx2" }
 *       ],
 *       "models": [{ "id": "openai/gpt-4o" }]
 *     }
 *   }
 *
 * - `apiKey` (single string) works as before when `apiKeys` is absent.
 * - `apiKeys` (array of {name, key, rpm?}) enables rotation. Each key needs
 *   a unique `name` (shown in model wizard / model check).
 * - `rpm` = max requests per minute (sliding-window sleep in proxy).
 *
 * Security: random port + dummy token. The proxy reads real keys only from
 * models.json's apiKeys. The dummy token pi sends is discarded on receipt.
 */

import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SLOT_WEIGHT, ProxyServer } from "./proxy.ts";
import { t } from "./i18n.ts";
import { flattenComboSlots } from "./flatten.ts";
import {
  appendRawRecord,
  setUsageLogFile,
  shortClient,
  usageLogEnabled,
} from "./usage-log.ts";

const MODELS_PATH = join(getAgentDir(), "models.json");
const ORIG = "__piModelsComboOrig";
const STATE_KEY = "__piModelsCombo";
const RUNTIME_PROVIDERS_KEY = "__piModelsComboRuntimeProviders";
/** 引擎状态版本：不同版本的模块副本相遇时告警一次（防多版本混跑）。
 *  v5（2026-08-27）：新增 status() 运行时状态查询（proxyStatus / globalThis.__piModelsCombo.status）。
 *  v6（2026-08-28）：SlotStat 增加 token 流量累计（tin/tout/tcr/tcw，成功响应解析 usage）。
 *  v7（2026-09-07）：proxyStatus() 补报未构建 combo（built:false + configError 探测）。
 *  v8（2026-09-07）：临时禁用（enabled:false）——provider 级（不建代理/模型隐藏）、key 级（不入轮转）、模型级（隐藏/组合成员跳过）。 */
const ENGINE_VERSION = 8;
/** combo provider 的识别标记（models.json provider 级 "combo": true）。 */

// --------------------------------------------------------------------
// 运行时注册的 provider 缓存（供 flattenComboSlots 解析 combo 成员用）
// --------------------------------------------------------------------
/** 当前会话上下文（pi 实例 + runToken）：供延迟建 combo 代理时接入本会话用（模块级单值，最近一次会话）。 */
let _currentRun: { pi: any; runToken: string } = { pi: null, runToken: "" };

// pi-models-combo 在 pi-web 每 factory run 加载一份副本；_modelRegistry/_currentRun 是模块级，
// 多副本各自独立 → 需经 globalThis 共享「最新捕获的 modelRegistry」，否则服务特定会话的副本
// 可能拿到另一个副本捕获的空/low 版本 registry。state() 已用此模式，这里同款。
const MODEL_REGISTRY_KEY = "__piModelsComboModelRegistry";
/** 全局共享的 pi modelRegistry（读 pi 实时模型清单用；跨副本共享最新捕获）。 */
function getSharedModelRegistry(): any {
  return (globalThis as any)[MODEL_REGISTRY_KEY] || null;
}
function setSharedModelRegistry(reg: any): void {
  (globalThis as any)[MODEL_REGISTRY_KEY] = reg || null;
}

/** 捕获 pi 的 modelRegistry（每会话刷新；写入 globalThis 共享，跨副本可见）。
 *  只在「新 registry 有 getRegisteredProviderIds」或「当前共享的 registry 无该方法」时更新——
 *  避免无方法的劣质 registry 覆盖已捕获到免费 provider 的好 registry。 */
function captureModelRegistry(ctx: any): void {
  const r = ctx?.modelRegistry;
  if (r) {
    const cur = getSharedModelRegistry();
    const rGood = typeof r.getRegisteredProviderIds === "function";
    const curGood = cur && typeof cur.getRegisteredProviderIds === "function";
    if (rGood || !curGood) {
      setSharedModelRegistry(r);
    }
  }
}

/** 从给定 registry（ModelRegistry/ModelRuntime）枚举已注册扩展 provider 的模型。
 *  返回数组（格式1），元素带 provider_id/api/baseUrl/reasoning/input 供 flatten 重建 provider。 */
function registryToLiveModels(reg: any): Array<{ provider: string; id: string; api?: string; baseUrl?: string; reasoning?: boolean; input?: string[] }> {
  const out: Array<{ provider: string; id: string; api?: string; baseUrl?: string; reasoning?: boolean; input?: string[] }> = [];
  if (!reg) return out;
  if (typeof reg.getRegisteredProviderIds === "function") {
    const ids = reg.getRegisteredProviderIds();
    for (const pid of ids) {
      const cfg = typeof reg.getRegisteredProviderConfig === "function" ? reg.getRegisteredProviderConfig(pid) : undefined;
      if (!cfg) continue;
      const pApi = cfg.api || "openai-completions";
      const pBase = cfg.baseUrl || "";
      const ms = Array.isArray(cfg.models) ? cfg.models : [];
      for (const m of ms) {
        if (!m || m.combo) continue;
        out.push({
          provider: pid,
          id: String(m.id ?? m.model ?? ""),
          api: m.api || pApi,
          baseUrl: m.baseUrl || pBase,
          reasoning: !!(m.reasoning ?? (m as any)?.providerConfig?.reasoning),
          input: Array.isArray(m.input) ? m.input : undefined,
        });
      }
    }
    return out;
  }
  if (typeof reg.getAvailable === "function") {
    const all = reg.getAvailable();
    if (Array.isArray(all)) return all as any;
  }
  return out;
}

/** 读 pi 实时模型清单（含动态注册模型）；无注册表/无模型返回空数组。
 *  注意：不能用 getAll()（那是全量模型字典，含未注册的 amazon-bedrock 等）。
 *  必须用「已注册的扩展 provider」：getRegisteredProviderIds() + getRegisteredProviderConfig()。
 *  来源优先级：_currentRun.pi.modelRegistry（同步可用）→ _modelRegistry（事件捕获）→ getRuntimeProviders。 */
function getLiveModels(): Array<{ provider: string; id: string; api?: string; baseUrl?: string; reasoning?: boolean; input?: string[] }> {
  const sharedReg = getSharedModelRegistry();
  // 1) 同步：当前 run 的 pi 实例暴露 modelRegistry getter（runner.js:get modelRegistry()）——不依赖事件时序
  const piReg = _currentRun?.pi?.modelRegistry;
  if (piReg) {
    const out = registryToLiveModels(piReg);
    if (out.length > 0) return out;
  }
  // 2) 事件捕获的 registry（globalThis 共享，跨副本可见）
  if (sharedReg) {
    const out = registryToLiveModels(sharedReg);
    if (out.length > 0) return out;
  }
  return [];
}

/** 记录运行时注册的 provider（由 pi.registerProvider 触发）。 */
export function setRuntimeProvider(name: string, config: any): void {
  const g = globalThis as any;
  if (!g[RUNTIME_PROVIDERS_KEY]) g[RUNTIME_PROVIDERS_KEY] = new Map();
  g[RUNTIME_PROVIDERS_KEY].set(name, config);
}

/** 获取所有运行时注册的 provider（用于 flattenComboSlots） */
export function getRuntimeProviders(): Record<string, any> {
  const g = globalThis as any;
  const map = g[RUNTIME_PROVIDERS_KEY] as Map<string, any> | undefined;
  if (!map) return {};
  const result: Record<string, any> = {};
  for (const [k, v] of map) result[k] = v;
  return result;
}

// --------------------------------------------------------------------
// globalThis singleton state（跨模块副本/跨 session 共享；双通道共存协议）
// --------------------------------------------------------------------
type ProxyEntry = {
  proxy: ProxyServer;
  started: Promise<void>;
};
type RespectState = {
  version: number;
  mtime: number;
  proxies: Map<string, ProxyEntry>;
};

function state(): RespectState {
  const g = globalThis as any;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = { version: ENGINE_VERSION, mtime: -1, proxies: new Map() } as RespectState;
    hookProcessExit();
  } else if (g[STATE_KEY].version !== ENGINE_VERSION) {
    console.warn(
      t("dup.copy", { a: g[STATE_KEY].version, b: ENGINE_VERSION })
    );
    g[STATE_KEY].version = ENGINE_VERSION;
  }
  return g[STATE_KEY] as RespectState;
}

/** 进程退出时释放端口（unref 已兜底，这里再保险一次）。 */
function hookProcessExit() {
  const g = globalThis as any;
  if (g.__piModelsComboExitHooked) return;
  g.__piModelsComboExitHooked = true;
  process.on("exit", () => stopAllRespect());
}

/** 停止并清空所有代理（测试/手动清理用）。 */
export function stopAllRespect(): void {
  const s: RespectState | undefined = (globalThis as any)[STATE_KEY];
  if (!s) return;
  for (const entry of s.proxies.values()) entry.proxy.stop();
  s.proxies.clear();
  s.mtime = -1;
}

/**
 * 外部入口：刷新指定 provider 的代理槽位（从 models.json 读取最新配置，原地更新不重启 HTTP）。
 * 调用方可从任意模块副本出发（通过 globalThis.__piModelsCombo.refresh 找到）。
 * providerId 缺省时刷新所有已存在的代理。
 */
export function refreshProviderProxies(providerId?: string): string[] {
  const s: RespectState | undefined = (globalThis as any)[STATE_KEY];
  if (!s) return [];
  const { providers, mtime } = loadModelsJson();
  const refreshed: string[] = [];
  // 无 providerId = 刷新全部：既更新已存在的代理，也补建缺失代理
  // （手工编辑 models.json 加了多 key 的新 provider，不等待新会话即可生效）
  const ids = providerId ? [providerId] : [...new Set([...s.proxies.keys(), ...Object.keys(providers)])];
  for (const pid of ids) {
    const cfg = providers[pid];
    const existingEntry = s.proxies.get(pid);
    // provider 已从 models.json 删除 → 停止并移除
    if (!cfg) {
      if (existingEntry) { existingEntry.proxy.stop(); s.proxies.delete(pid); }
      continue;
    }
    // provider 被禁用（enabled:false）→ 停代理、配置保留（临时禁用不删除）
    if (cfg.enabled === false) {
      if (existingEntry) { existingEntry.proxy.stop(); s.proxies.delete(pid); }
      continue;
    }
    const isCombo = cfg?.combo === true;
    let entries: Array<{ name: string; key: string; rpm?: number; minIntervalMs?: number }> = [];
    let api = cfg?.api;
    let baseUrl = cfg?.baseUrl;

    if (isCombo) {
      const models = Array.isArray(cfg.models) ? cfg.models : [];
      const r = flattenComboSlots(models, providers, normalizeApiKeys, loadModelsStoreFile(), getRuntimeProviders());
      for (const e of r.errors) {
        console.warn(t("refresh.skip", { pid, model: e.modelId, err: e.error }));
      }
      if (r.slots.length === 0) continue;
      entries = r.slots;
      if (r.api) api = r.api;
      if (!baseUrl) baseUrl = r.slots[0].upstream;
    } else {
      entries = Array.isArray(cfg?.apiKeys) ? normalizeApiKeys(cfg.apiKeys, pid) : [];
      if (entries.length < 2) continue;
      if (!baseUrl) { console.error(t("no.baseurl.refresh", { pid })); continue; }
    }

    if (existingEntry) {
      const removed = existingEntry.proxy.updateEntries({ entries, upstream: baseUrl, api, timeouts: cfg.timeouts, quality: cfg.quality, devRole: buildDevRoleMap(cfg), xOpenCodeSession: buildXOpenCodeSession(cfg) });
      existingEntry.proxy.log(t("slots.external", { n: entries.length, removed: removed.length ? t("slots.removed", { list: removed.join(", ") }) : "" }));
      refreshed.push(pid);
    } else {
      // 尚无运行中代理（手工改 models.json 加了多 key / 新 provider）→ 补建，不等待新会话。
      // 端口随机 + 随机 dummy token；后续会话 setupProxies 会 registerToken + registerProvider 接入。
      const proxy = new ProxyServer({
        provider: pid,
        upstream: baseUrl,
        apiKeys: entries,
        port: randomPort(),
        authToken: randomToken(),
        api,
        timeouts: cfg.timeouts,
        quality: cfg.quality,
        devRole: buildDevRoleMap(cfg),
        xOpenCodeSession: buildXOpenCodeSession(cfg),
      });
      const e: ProxyEntry = { proxy, started: null! };
      e.started = proxy.start();
      e.started.catch((err: any) => {
        s.proxies.delete(pid);
        console.error(`[pi-models-combo] proxy failed "${pid}": ${err?.message ?? err}`);
      });
      s.proxies.set(pid, e);
      refreshed.push(pid);
    }
  }
  s.mtime = mtime;
  return refreshed;
}

/** 刷新 models.json 的 mtime 缓存（外部通知：文件已变，下次 loadModelsJson 强制重读） */
export function bustModelsJsonCache(): void {
  modelsCache = null!;
  allowlistMtime = -1;
}

/**
 * 运行状态查询：globalThis 共享状态里各 provider 代理的槽位健康/冷却/统计快照。
 * 供向导「聚合 / 多 key 信息」面板等外部消费者；引擎未装载/无代理返回空数组。
 * 不返回任何 key 明文（key 永远只进 models.json 与代理内存）。
 */
export function proxyStatus(): Array<Record<string, unknown>> {
  const s: RespectState | undefined = (globalThis as any)[STATE_KEY];
  if (!s) return [];
  const out: Array<Record<string, unknown>> = [];
  const built = new Set<string>();
  for (const [pid, entry] of s.proxies) {
    try {
      const fn = (entry.proxy as { status?: () => Record<string, unknown> }).status;
      const st = typeof fn === "function" ? fn.call(entry.proxy) : null;
      if (st) { out.push({ provider: pid, built: true, ...st }); built.add(pid); }
    } catch { /* 单 provider 状态读取失败不影响其他 */ }
  }
  // 已配置但未构建的 combo：combo 代理是懒建（首次请求才 ensureComboProxyLazy），
  // 从未被请求过的 combo 不在 s.proxies——状态面板也要能看到它（标 built:false）。
  // 成员解析失败（如成员 provider 不在 models.json / 未运行时注册）的 combo 永远无法懒建，
  // 标 configError 让前端提示修复配置而非「首次请求后激活」误导。
  try {
    const { providers } = loadModelsJson();
    const live = getLiveModels();
    const rtProviders = getRuntimeProviders() as any;
    const runtimeSource = live.length > 0 ? live : rtProviders;
    const store = loadModelsStoreFile();
    for (const pid of configuredComboPids()) {
      if (built.has(pid)) continue;
      const cfg = providers[pid] as any;
      const models = Array.isArray(cfg?.models) ? cfg.models : [];
      // 与 buildComboProxyLazy 同源探测：能出槽位 → 正常懒建；0 槽 → 配置错误（附首个错误，不含 key）
      let configError: string | undefined;
      try {
        const probe = flattenComboSlots(models, providers, normalizeApiKeys, store, runtimeSource);
        if (probe.slots.length === 0 && probe.errors.length > 0) {
          const first = probe.errors[0];
          configError = first.error || `成员 ${first.modelId} 无法解析`;
        }
      } catch { /* 探测失败不阻塞展示 */ }
      out.push({
        provider: pid,
        built: false,
        isCombo: true,
        port: 0,
        upstream: ProxyServer.safeUpstream(cfg?.baseUrl || ""),
        api: cfg?.api || undefined,
        sticky: cfg?.sticky !== false,
        entries: [],
        saturation: [],
        configModels: models.length,
        configError,
      });
    }
  } catch { /* 补未构建 combo 失败不影响已构建项 */ }
  return out;
}

/** 挂载 refresh/status 入口到 globalThis 状态，供外部消费方（向导扩展 refreshProxiesViaCombo 直连等）调用 */
function mountRefreshToGlobal(): void {
  try {
    const s = state();
    (s as any).refresh = refreshProviderProxies;
    (s as any).status = proxyStatus;
  } catch { /* 极端情况：状态未就绪则下次 session 创建时重挂 */ }
}


// --------------------------------------------------------------------
// models.json reader (mtime-aware)
// --------------------------------------------------------------------
let modelsCache: { providers: Record<string, any>; mtime: number } = null!;

function loadModelsJson(): { providers: Record<string, any>; mtime: number } {
  try {
    const st = statSync(MODELS_PATH);
    if (modelsCache && st.mtimeMs === modelsCache.mtime) return modelsCache;
    const parsed = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
    modelsCache = { providers: parsed.providers ?? {}, mtime: st.mtimeMs };
    return modelsCache;
  } catch {
    return modelsCache || { providers: {}, mtime: 0 };
  }
}

// --------------------------------------------------------------------
// Model allowlist (original filter logic)
// --------------------------------------------------------------------
let providerAllowlist: Map<string, Set<string>> = new Map();
let allowlistMtime = -1;

function loadAllowlist(): Map<string, Set<string>> {
  try {
    const { providers, mtime } = loadModelsJson();
    if (mtime === allowlistMtime) return providerAllowlist;
    const map = new Map<string, Set<string>>();
    for (const [pid, cfg] of Object.entries(providers)) {
      const models = cfg?.models;
      if (Array.isArray(models) && models.length > 0) {
        map.set(pid, new Set(models.map((m: any) => m.id)));
      }
    }
    providerAllowlist = map;
    allowlistMtime = mtime;
    return map;
  } catch {
    return providerAllowlist;
  }
}

function isVisibleModel(model: { provider: string; id: string }): boolean {
  const pcfg = loadModelsJson().providers?.[model.provider];
  // provider 级禁用（enabled:false）→ 该 provider 全部模型从可用列表隐藏（临时禁用不删除）
  if (pcfg && pcfg.enabled === false) return false;
  // 模型级禁用（models[i].enabled === false）→ 单个模型隐藏（与 provider 级禁用独立）
  if (pcfg && Array.isArray(pcfg.models)) {
    const mdef = pcfg.models.find((m: any) => m && String(m.id ?? m.model ?? "") === model.id);
    if (mdef && mdef.enabled === false) return false;
  }
  const allow = loadAllowlist().get(model.provider);
  if (allow === undefined) return true;
  return allow.has(model.id);
}

function filterModels<T extends { provider: string; id: string }>(models: T[]): T[] {
  return models.filter(isVisibleModel);
}

// --------------------------------------------------------------------
// Proxy setup: random port, read apiKeys from models.json, start proxy
// --------------------------------------------------------------------

/** Generate a random high port (30000–49999). */
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

/** Generate a random hex token (used as dummy credential pi sends). */
function randomToken(): string {
  return "sk-dummy-" + randomBytes(16).toString("hex");
}

/** 校验/规范化 key 条目：必须 key；rpm 非负整数才生效；minIntervalMs：留空/"auto"=按 rpm 折算（默认匀速）、0=关闭（突发滑窗）、正数=固定毫秒；同名去重并告警；自动补名。 */
function normalizeApiKeys(raw: any[], providerId: string): { name: string; key: string; rpm?: number; minIntervalMs?: number }[] {
  const seen = new Map<string, number>();
  const out: { name: string; key: string; rpm?: number; minIntervalMs?: number }[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    // 禁用的 key（enabled:false）：临时停用不删除——不参与轮转，配置保留，向导一键启用即恢复
    if (e.enabled === false) continue;
    const key = String(e.key || "").trim();
    if (!key) {
      console.warn(t("key.empty", { pid: providerId }));
      continue;
    }
    let name = String(e.name || "").trim() || `key-${out.length + 1}`;
    const cnt = seen.get(name) || 0;
    if (cnt > 0) {
      console.warn(t("key.dup", { pid: providerId, name, new: `${name}-${cnt + 1}` }));
      name = `${name}-${cnt + 1}`;
    }
    seen.set(name, cnt + 1);
    let rpm: number | undefined;
    if (e.rpm !== undefined && e.rpm !== null && e.rpm !== "") {
      rpm = Math.floor(Number(e.rpm));
      if (!Number.isFinite(rpm) || rpm < 1) {
        console.warn(t("key.badRpm", { pid: providerId, name, v: e.rpm }));
        rpm = undefined;
      }
    }
    let minIntervalMs: number | undefined;
    const autoMiv = rpm ? Math.round(60000 / rpm) : 0;
    if (e.minIntervalMs === 0 || e.minIntervalMs === "0") {
      minIntervalMs = 0; // 显式关闭匀速 → 仅 rpm 滑动窗口（突发）
    } else if (e.minIntervalMs === undefined || e.minIntervalMs === null || e.minIntervalMs === "" || e.minIntervalMs === "auto" || e.minIntervalMs === true) {
      minIntervalMs = autoMiv; // 默认：按 rpm 折算匀速
    } else {
      const mi = Math.floor(Number(e.minIntervalMs));
      if (Number.isFinite(mi) && mi > 0) minIntervalMs = mi;
      else {
        console.warn(t("key.badMiv", { pid: providerId, name, v: e.minIntervalMs, auto: autoMiv || t("dur.off") }));
        minIntervalMs = autoMiv;
      }
    }
    out.push({ name, key, rpm, minIntervalMs });
  }
  return out;
}

/**
 * Ensure proxies exist for all ≥2-key providers, then register the proxy
 * override into THIS session's runtime via pi.registerProvider.
 *
 * Idempotent: proxies are shared on globalThis — repeated factory runs
 * (every CLI invocation, every aiti-ai session) reuse running proxies instead
 * of leaking one port per session. models.json mtime change restarts them.
 */
/** pi 模型 store（~/.pi/agent/models-store.json）：为未配 baseUrl/models 的 provider 提供成员补全。 */
function loadModelsStoreFile(): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "models-store.json"), "utf8")) || null;
  } catch { return null; }
}

/** 构建「模型 id → supportsDeveloperRole」映射（读 models.json 的 compat；供代理按模型决定 developer→system 改写）。
 *  规则（与 pi 官方一致）：模型级 compat 优先，缺失回退 provider 级 compat；只有显式 false 才改写。 */
function buildDevRoleMap(cfg: any): Map<string, boolean> {
  const map = new Map<string, boolean>();
  const provDev = cfg?.compat?.supportsDeveloperRole;
  for (const m of Array.isArray(cfg?.models) ? cfg.models : []) {
    if (!m || typeof m !== "object") continue;
    const id = String(m.id ?? m.model ?? "");
    if (!id) continue;
    const v = m.compat?.supportsDeveloperRole !== undefined ? m.compat.supportsDeveloperRole : provDev;
    if (typeof v === "boolean") map.set(id, v);
  }
  return map;
}

/** Console Go（opencode.ai/zen/go）强制要求 x-opencode-session 头（prompt cache 路由）。
 *  代理按 provider 级 compat.xOpenCodeSession 三态决定注入：true=强制 / false=关闭 / 缺省=按上游 host 自动检测。 */
function buildXOpenCodeSession(cfg: any): boolean | undefined {
  const v = cfg?.compat?.xOpenCodeSession;
  return typeof v === "boolean" ? v : undefined;
}

/**
 * 延迟建 combo 代理：在首次请求时才解析成员并创建代理。
 * 此时 runtime providers（如 freeflow）已注册，成员可解析。
 * 返回代理 URL；仍无法解析返回 null（不建代理，保持延迟态）。
 * 带 in-flight 守卫：并发触发只建一次（key = providerId）。
 */
const _lazyPending: Map<string, Promise<string | null>> = new Map();
async function ensureComboProxyLazy(providerId: string): Promise<string | null> {
  const s = state();
  // 已有代理（无论普通还是 combo）→ 直接返回其 URL
  const entry = s.proxies.get(providerId);
  if (entry) {
    await entry.started.catch(() => {});
    return `http://127.0.0.1:${entry.proxy.port}/`;
  }
  // 并发守卫：已在建则复用同一 Promise
  const inflight = _lazyPending.get(providerId);
  if (inflight) return inflight;

  const p = buildComboProxyLazy(providerId).finally(() => _lazyPending.delete(providerId));
  _lazyPending.set(providerId, p);
  return p;
}

async function buildComboProxyLazy(providerId: string): Promise<string | null> {
  const s = state();
  const { providers } = loadModelsJson();
  const cfg = providers[providerId];
  if (!cfg || cfg.combo !== true) return null;
  // 聚合组被禁用（enabled:false）→ 不建代理（配置保留，临时禁用）
  if (cfg.enabled === false) return null;

  const models = Array.isArray(cfg.models) ? cfg.models : [];
  // 运行时成员来源：优先 pi 实时模型清单（含 freeflow 等动态注册模型），
  // 无注册表时回退 registerProvider 收集的 provider 配置。
  const live = getLiveModels();
  const rtProviders = getRuntimeProviders() as any;
  const runtimeSource = live.length > 0 ? live : rtProviders;
  const r = flattenComboSlots(models, providers, normalizeApiKeys, loadModelsStoreFile(), runtimeSource);
  for (const e of r.errors) {
    console.warn(t("defer.skip", { pid: providerId, model: e.modelId, err: e.error }));
  }
  if (r.slots.length === 0) {
    console.warn(t("defer.missing", { pid: providerId, n: r.errors.length }));
    return null;
  }

  let baseUrl = cfg.baseUrl;
  if (!baseUrl) baseUrl = r.slots[0].upstream;
  const runToken = _currentRun.runToken || randomToken();
  const proxy = new ProxyServer({
    provider: providerId,
    upstream: baseUrl,
    apiKeys: r.slots,
    port: randomPort(),
    authToken: runToken,
    api: r.api || cfg.api,
    timeouts: cfg.timeouts,
    quality: cfg.quality,
    devRole: buildDevRoleMap(cfg),
    xOpenCodeSession: buildXOpenCodeSession(cfg),
  });
  const e: ProxyEntry = { proxy, started: null! };
  e.started = proxy.start();
  e.started.catch((err: any) => {
    s.proxies.delete(providerId);
    console.error(t("defer.fail", { pid: providerId, err: err?.message ?? err }));
  });
  s.proxies.set(providerId, e);
  // 接入当前会话：注册 token + 注册 provider override（跟 setupProxies 的 existing 分支一致）
  const canRegisterRunToken = typeof (proxy as any).registerToken === "function";
  if (canRegisterRunToken) proxy.registerToken(runToken);
  e.started.then(() => {
    try {
      if (_currentRun.pi) {
        // 端口碰撞重试后真实端口以 proxy.port 为准 —— start() 落定后再读，避免注册过期地址
        const url = `http://127.0.0.1:${proxy.port}/`;
        _currentRun.pi.registerProvider(providerId, {
          baseUrl: url,
          apiKey: canRegisterRunToken ? runToken : "",
        });
      }
    } catch { /* 注册失败不阻断路由 */ }
  }).catch(() => {});
  return `http://127.0.0.1:${proxy.port}/`;
}

function setupProxies(_pi: any, runToken: string, runClient: string) {
  const s = state();
  const { providers, mtime } = loadModelsJson();

    // models.json 变了 → 原地更新已存在的代理，而非 stop+clear 全量重启（避免中断已在途请求）
  if (mtime !== s.mtime) {
    const knownIds = new Set(Object.keys(providers));
    // 停掉已从 models.json 中移除的 provider 代理
    for (const [pid, _entry] of s.proxies) {
      if (!knownIds.has(pid)) { _entry.proxy.stop(); s.proxies.delete(pid); }
    }
    // 对仍在的 provider 做原地更新（provider 被禁用 → 停代理，配置保留）
    for (const [pid, existingEntry] of s.proxies) {
      const cfg = providers[pid];
      if (!cfg) continue;
      if (cfg.enabled === false) { existingEntry.proxy.stop(); s.proxies.delete(pid); continue; }
      const isCombo = cfg?.combo === true;
      let entries: Array<{ name: string; key: string; rpm?: number; minIntervalMs?: number }> = [];
      let api = cfg?.api;
      let baseUrl = cfg?.baseUrl;

      if (isCombo) {
        const models = Array.isArray(cfg.models) ? cfg.models : [];
        const live = getLiveModels();
        const runtimeSource = live.length > 0 ? live : (getRuntimeProviders() as any);
        const r = flattenComboSlots(models, providers, normalizeApiKeys, loadModelsStoreFile(), runtimeSource);
        for (const e of r.errors) {
          console.warn(t("model.skip", { pid, model: e.modelId, err: e.error }));
        }
        if (r.slots.length === 0) continue;
        entries = r.slots;
        if (r.api) api = r.api;
        if (!baseUrl) baseUrl = r.slots[0].upstream;
      } else {
        entries = Array.isArray(cfg?.apiKeys) ? normalizeApiKeys(cfg.apiKeys, pid) : [];
        if (entries.length < 2) continue;
        if (!baseUrl) { console.error(t("no.baseurl", { pid })); continue; }
      }

      const removed = existingEntry.proxy.updateEntries({ entries, upstream: baseUrl, api, timeouts: cfg.timeouts, quality: cfg.quality, devRole: buildDevRoleMap(cfg), xOpenCodeSession: buildXOpenCodeSession(cfg) });
      if (removed.length) {
        existingEntry.proxy.log(t("slots.update", { list: removed.join(", "), n: entries.length }));
      }
    }
  }
  s.mtime = mtime;

  for (const [providerId, cfg] of Object.entries(providers)) {
    // 禁用的 provider（enabled:false）：临时停用不删除——不建代理；已有代理立即停掉
    if (cfg?.enabled === false) {
      const disEntry = s.proxies.get(providerId);
      if (disEntry) { disEntry.proxy.stop(); s.proxies.delete(providerId); }
      continue;
    }
    // 已有代理 → 只注册当前 session 的 token（创建流程已在上面 mtime 变化时处理）
    const existing = s.proxies.get(providerId);
    if (existing) {
      const canRegisterRunToken = typeof (existing.proxy as { registerToken?: unknown }).registerToken === "function";
      if (canRegisterRunToken) existing.proxy.registerToken(runToken);
      // 对仍在排队中的首个 session 注册提供者
      existing.started.then(() => {
        try {
          _pi.registerProvider(providerId, {
            baseUrl: `http://127.0.0.1:${existing!.proxy.port}/`,
            apiKey: canRegisterRunToken ? runToken : "",
          });
        } catch {}
      }).catch(() => {});
      continue;
    }
    // ── 槽位准备：普通多 key provider 直接用 apiKeys；组合 provider 扁平化成员×key ──
    //   （组合槽位 = 一把 key + 各自目标地址，与普通 key 同一条代理链路，不另起服务）
    const isCombo = cfg?.combo === true;
    let entries: Array<{ name: string; key: string; rpm?: number; minIntervalMs?: number }> = [];
    let api = cfg?.api;
    let baseUrl = cfg?.baseUrl;

    if (isCombo) {
      // combo：不建代理（延迟到首次请求建，见 ensureComboProxyLazy），但必须在 init 时
      // 把 provider 注册进 pi —— 否则组合模型不满足「configured」条件，/model 里看不到。
      // 这里只用 models.json 的 baseUrl 占位 + runToken 作为 dummy key 注册；
      // 首次请求建好真实代理后再用代理 baseUrl 重新注册。
      const comboBaseUrl = baseUrl || cfg?.baseUrl || `http://127.0.0.1:${randomPort()}/`;
      try {
        _pi.registerProvider(providerId, {
          baseUrl: comboBaseUrl,
          apiKey: runToken,
        });
      } catch (e: any) {
        console.warn(t("combo.reg.fail", { pid: providerId, err: e?.message ?? e }));
      }
      continue;
    } else {
      entries = Array.isArray(cfg?.apiKeys) ? normalizeApiKeys(cfg.apiKeys, providerId) : [];
      if (entries.length < 2) continue; // <2 个 key 不需要轮转
      if (!baseUrl) {
        console.error(t("no.baseurl", { pid: providerId }));
        continue;
      }
    }

    let entry = s.proxies.get(providerId);
    if (!entry) {
      // First run creates the proxy with this run's token; later runs only
      // registerToken() below so every session keeps working through the
      // shared proxy while keeping its own correlation key.
      const proxy = new ProxyServer({
        provider: providerId,
        upstream: baseUrl,
        apiKeys: entries,
        port: randomPort(),
        authToken: runToken,
        api: cfg.api,
        timeouts: cfg.timeouts,
        quality: cfg.quality,
        devRole: buildDevRoleMap(cfg),
        xOpenCodeSession: buildXOpenCodeSession(cfg),
      });
      const e: ProxyEntry = { proxy, started: null! };
      // 端口碰撞重试后真实端口以 proxy.port 为准 —— 等 start() 落定再注册。
      e.started = proxy.start();
      e.started.catch((err: any) => {
        // 启动失败：只清理该 provider 的条目并报错，不影响其它 provider。
        s.proxies.delete(providerId);
        console.error(`[pi-models-combo] proxy failed "${providerId}": ${err?.message ?? err}`);
      });
      s.proxies.set(providerId, e);
      entry = e;
    }

    // 本会话的关联 token 注册进共享代理（LRU 集合），后续请求日志带 client 字段。
    // 兼容守卫：升级瞬间新副本可能撞上旧版本创建的共享代理实例（无 registerToken，
    // 其原始 token 在旧 ProxyEntry.token 上）——此时沿用旧 token，进程重启后恢复新机制。
    const legacyToken = (entry as { token?: string }).token;
    const canRegisterRunToken = typeof (entry.proxy as { registerToken?: unknown }).registerToken === "function";
    if (canRegisterRunToken) entry.proxy.registerToken(runToken);

    // 每个 session 都要向自己的 runtime 注册 override（首个 session 排队、
    // 后续 session 立即生效）。注册失败只记日志，绝不删除路由状态——
    // 否则 baseUrl 改写失效、流量直穿真实上游（v0.1.x 断链 bug 的根因）。
    entry.started.then(() => {
      try {
        _pi.registerProvider(providerId, {
          baseUrl: `http://127.0.0.1:${entry!.proxy.port}/`,
          apiKey: canRegisterRunToken ? runToken : legacyToken ?? "",
        });
        // entry!.proxy.log(`registered${isCombo ? " combo" : ""} override → http://127.0.0.1:${entry!.proxy.port}/ (client ${runClient}${canRegisterRunToken ? "" : ", legacy"})`);
      } catch (err: any) {
        console.error(`[pi-models-combo] register "${providerId}" failed: ${err?.message ?? err}`);
      }
    }).catch(() => { /* start 失败已在上面处理 */ });
  }
}


// --------------------------------------------------------------------
// Patches: model filtering + proxy baseUrl injection
// --------------------------------------------------------------------

/** Override baseUrl on returned Model objects to point to the proxy.
 *  注意：这里不触发延迟建（仅读已有代理）——延迟建只从 getApiKeyAndHeaders（首次请求）触发，
 *  否则模型列表每次都会触发建 proxy 导致与 registerProvider→refresh 互相重入的递归。 */
function getProxyBaseUrl(model: { provider: string }): string | undefined {
  const entry = state().proxies.get(model.provider);
  if (!entry) return undefined;
  return `http://127.0.0.1:${entry.proxy.port}/`;
}

function patchInstanceMethod(proto: any, method: string) {
  if (typeof proto[method] !== "function") return;
  if (proto[ORIG + method]) return;
  const orig = proto[method];
  proto[ORIG + method] = orig;
  proto[method] = function (this: any, ...args: unknown[]) {
    const result = orig.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((res: unknown) => {
        if (!Array.isArray(res)) return res;
        return filterModels(res).map((m: any) => {
          const pb = getProxyBaseUrl(m);
          if (pb) (m as { baseUrl: string }).baseUrl = pb;
          return m;
        });
      });
    }
    if (!Array.isArray(result)) return result;
    return filterModels(result).map((m: any) => {
      const pb = getProxyBaseUrl(m);
      if (pb) (m as { baseUrl: string }).baseUrl = pb;
      return m;
    });
  };
}

function patchFind(proto: any) {
  if (typeof proto.find !== "function") return;
  if (proto[ORIG + "find"]) return;
  const orig = proto.find;
  proto[ORIG + "find"] = orig;
  proto.find = function (this: any, provider: string, modelId: string) {
    const model = orig.call(this, provider, modelId);
    if (model === undefined) return undefined;
    if (!isVisibleModel(model)) return undefined;
    const pb = getProxyBaseUrl(model);
    if (pb) (model as { baseUrl: string }).baseUrl = pb;
    return model;
  };
}

/** Patch getApiKeyAndHeaders — this is where pi resolves the actual
 * baseUrl for API calls. Override to always return the proxy URL.
 *  combo 代理未建时在此 await 延迟建——这是真正的「首次请求」点。 */
function patchGetApiKeyAndHeaders(proto: any) {
  const method = "getApiKeyAndHeaders";
  if (typeof proto[method] !== "function") return;
  if (proto[ORIG + method]) return;
  const orig = proto[method];
  proto[ORIG + method] = orig;
  proto[method] = async function (this: any, model: any) {
    const provId = model?.provider;
    // 首次请求：确保 combo 代理已建（此刻 runtime provider 数据已齐）
    if (provId) {
      await ensureComboProxyLazy(provId).catch(() => {});
    }
    const result = await orig.call(this, model);
    if (!result || !result.ok) return result;
    // 再用最新代理状态（可能刚建好）解析 baseUrl
    const entry = state().proxies.get(model.provider);
    if (entry) {
      const pb = `http://127.0.0.1:${entry.proxy.port}/`;
      await entry.started.catch(() => {});
      return { ...result, baseUrl: pb };
    }
    return result;
  };
}

/** Patch ModelRuntime.getAuth — the REAL request-path auth/baseUrl resolver.
 *  agent-session._getRequiredRequestAuth 走 this._modelRuntime.getAuth(model)，
 *  而非 ModelRegistry.getApiKeyAndHeaders（后者只作兼容 facade）。
 *  这里才是 combo 代理接入请求的正路：首次请求触发延迟建 + 注入代理 baseUrl。 */
function patchModelRuntimeGetAuth(proto: any) {
  const method = "getAuth";
  if (typeof proto[method] !== "function") return;
  if (proto[ORIG + method + "Auth"]) return;
  const orig = proto[method];
  proto[ORIG + method + "Auth"] = orig;
  proto[method] = async function (this: any, providerOrModel: any, overrides?: any) {
    const provId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel?.provider;
    // 首次请求：确保 combo 代理已建
    if (provId) {
      await ensureComboProxyLazy(provId).catch(() => {});
    }
    const result = await orig.call(this, providerOrModel, overrides);
    if (!result?.auth) return result;
    // 组合代理已建 → 注入代理 baseUrl + runToken
    const entry = state().proxies.get(provId);
    if (entry) {
      await entry.started.catch(() => {});
      const pb = `http://127.0.0.1:${entry.proxy.port}/`;
      const canToken = typeof entry.proxy.registerToken === "function";
      const token = _currentRun.runToken || "";
      if (canToken) entry.proxy.registerToken(token);
      result.auth = {
        ...result.auth,
        baseUrl: pb,
        apiKey: canToken ? token : result.auth.apiKey,
      };
    }
    return result;
  };
}

// --------------------------------------------------------------------
// Extension entry point
// --------------------------------------------------------------------
export default function piModelsCombo(_pi: any) {
  // 0. 把 refresh 入口挂到 globalThis，供外部消费方（向导扩展直连）调用
  mountRefreshToGlobal();

  // 0. Bind the key-request usage log sink (aiti-ai-usage extension tails this file).
  //    Path follows pi's agent dir (PI_CODING_AGENT_DIR aware) for e2e isolation.
  if (usageLogEnabled()) {
    setUsageLogFile(
      process.env.PMC_USAGE_FILE || join(getAgentDir(), "model-usage", "key-requests.jsonl"),
      process.env.PMC_USAGE_FILE ? undefined : { monthly: true },
    );
  }

  // 0.5 Per-run correlation token: every factory run (= every CLI invocation /
  //     aiti-ai RPC session) gets its own dummy token. Requests through the
  //     shared proxies carry it in the auth header; the usage log records a
  //     truncated form (`client`) so records attribute back to this run.
  //     session_start then maps client → real sessionId (id is not yet known
  //     at factory time for brand-new sessions).
  const runToken = randomToken();
  const runClient = shortClient(runToken);
  // 记录当前会话上下文：延迟建 combo 代理时接入本会话（registerToken + registerProvider）用
  _currentRun = { pi: _pi, runToken };
  if (usageLogEnabled()) {
    appendRawRecord({
      ts: Date.now(),
      type: "client",
      client: runClient,
      pid: process.pid,
      cwd: process.cwd(),
    });
    try {
      _pi.on("session_start", (_ev: unknown, ctx: any) => {
        try {
          appendRawRecord({
            ts: Date.now(),
            type: "session",
            client: runClient,
            sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
            cwd: ctx?.cwd ?? process.cwd(),
          });
        } catch { /* 映射日志失败不影响运行 */ }
      });
    } catch { /* 老宿主无 on API 时跳过 */ }
  }

  // 0.5b 捕获 pi 的 modelRegistry（读实时模型清单，含动态注册模型）——不依赖 usage log 开关。
  try {
    _pi.on("session_start", (_ev: unknown, ctx: any) => captureModelRegistry(ctx), undefined);
    _pi.on("model_select", (_ev: unknown, ctx: any) => captureModelRegistry(ctx), undefined);
  } catch { /* 老宿主无 on API 时跳过（退回仅 registerProvider 收集） */ }

  // 0.6 Hook pi.registerProvider to capture runtime-registered providers
  //    (e.g., pi-freeflow registers "freeflow" provider at runtime)
  const origRegisterProvider = _pi.registerProvider?.bind(_pi);
  if (typeof origRegisterProvider === "function") {
    _pi.registerProvider = function hookedRegisterProvider(name: string, config: any) {
      setRuntimeProvider(name, config);
      return origRegisterProvider(name, config);
    };
  }

  // 1. Ensure shared proxies + register overrides into this session's runtime
  setupProxies(_pi, runToken, runClient);

  // 2. Model filtering + proxy baseUrl injection
  patchInstanceMethod(ModelRuntime.prototype as any, "getModels");
  patchInstanceMethod(ModelRuntime.prototype as any, "getAvailable");
  patchInstanceMethod(ModelRuntime.prototype as any, "getAvailableSnapshot");
  patchInstanceMethod(ModelRegistry.prototype as any, "getAll");
  patchInstanceMethod(ModelRegistry.prototype as any, "getAvailable");
  patchFind(ModelRegistry.prototype as any);
  patchGetApiKeyAndHeaders(ModelRegistry.prototype as any);
  patchModelRuntimeGetAuth(ModelRuntime.prototype as any);

  // 3. Register /combo command (list combo proxy status / members)
  try {
    _pi.registerCommand("combo", {
      description: t("cmd.combo.desc"),
      handler: async (args: string, ctx: any) => {
        const parts = (args || "").trim().split(/\s+/).filter(Boolean);
        const cmd = (parts[0] || "").toLowerCase();
        if (cmd === "" || cmd === "help" || cmd === "?") {
          // 无参数：弹交互选择器（老宿主无 ui.select 时退回文本帮助）
          await pickComboAction(ctx);
        } else {
          await runComboAction(cmd, parts.slice(1).join(" "), ctx);
        }
      },
    });
  } catch { /* 老宿主无 registerCommand 时跳过（命令仅为方便排查，不阻断核心功能） */ }
}

/** 统一输出：宿主有 ui.notify → notify（TUI/操作台显示）；否则 console.log 兜底（headless/print 可见）。
 *  二选一，避免 notify + console.log 同开时输出两份。 */
function emit(ctx: any, msg: string, level: "info" | "warning" = "info"): void {
  if (typeof ctx?.ui?.notify === "function") ctx.ui.notify(msg, level);
  else console.log(msg);
}

/** 输出 /combo list：无条件列出 models.json 里所有组合配置（组合模型+成员/权重），
 *  不依赖代理是否已构建；已构建的仅附加运行标注（端口/冷却）。 */
function outputComboList(ctx: any): void {
  const { providers } = loadModelsJson();
  const builtByPid = new Map<string, any>();
  for (const st of proxyStatus()) {
    if ((st as any).isCombo === true) builtByPid.set(String((st as any).provider), st);
  }
  const lines: string[] = [];
  let combosFound = 0;
  for (const [pid, cfgRaw] of Object.entries(providers)) {
    const cfg = cfgRaw as any;
    if (cfg?.combo !== true) continue;
    const models = Array.isArray(cfg.models) ? cfg.models : [];
    for (const md of models) {
      const spec = md?.combo;
      if (!spec || typeof spec !== "object" || !Array.isArray(spec.members) || spec.members.length === 0) continue;
      combosFound++;
      const built: any = builtByPid.get(pid);
      const cooling = built ? ((built.entries ?? []) as any[]).filter((e) => e.cooldown).length : 0;
      const runMark = built
        ? t("run.built", { port: built.port }) + (cooling ? t("run.cooling", { n: cooling }) : "")
        : t("run.unbuilt");
      lines.push(`▸ ${pid} · ${String(md.id || t("combo.none.id"))}${cfg.baseUrl ? ` · ${cfg.baseUrl}` : ""}${spec.stickyTtlMin ? t("sticky.ttl", { n: spec.stickyTtlMin }) : ""}  ${runMark}`);
      for (const ref of spec.members) {
        const w = (ref as any)?.weight;
        const ty = (ref as any)?.types;
        const tyLabel = Array.isArray(ty) && ty.length > 0 ? `  [${ty.join("/")}]` : "";
        lines.push(`    · ${String(ref?.provider ?? "?")}/${String(ref?.model ?? "?")}${tyLabel}  ${t("weight", { w: w != null && w !== "" ? w : 10 })}`);
      }
    }
  }
  if (combosFound === 0) {
    emit(ctx, t("combo.none.list"), "warning");
    return;
  }
  emit(ctx, lines.join("\n"));
}

/** 槽位统计行：req/429 率/token 输入输出/粘性等（stats 字段与 ProxyServer #stats SlotStat 对齐）。 */
function comboEntryStatusLine(e: any): string {
  const s = e.stats ?? {};
  const total = (s.ok ?? 0) + (s.err429 ?? 0) + (s.err4xx ?? 0) + (s.err5xx ?? 0) + (s.timeout ?? 0) + (s.other ?? 0);
  const parts: string[] = [];
  if (total > 0) parts.push(`req:${total}`);
  if ((s.err429 ?? 0) > 0) parts.push(t("stat.429", { n: s.err429, p: Math.round((s.err429 / Math.max(1, total)) * 100) }));
  if ((s.err4xx ?? 0) > 0) parts.push(`4xx:${s.err4xx}`);
  if ((s.err5xx ?? 0) > 0) parts.push(`5xx:${s.err5xx}`);
  if ((s.timeout ?? 0) > 0) parts.push(t("stat.timeout", { n: s.timeout }));
  if ((s.tin ?? 0) > 0 || (s.tout ?? 0) > 0) parts.push(t("stat.token", { tin: s.tin ?? 0, tout: s.tout ?? 0 }));
  if (s.lastStatus) parts.push(t("stat.lastStatus", { v: s.lastStatus }));
  if (s.lastUsedAt) parts.push(t("stat.lastUse", { v: new Date(s.lastUsedAt).toLocaleTimeString() }));
  const pinned = e.pinned ? t("stat.pinned", { n: e.pinned }) : "";
  const cooling = e.cooldown ? `  ⏳${e.cooldown.kind} ${e.cooldown.secondsLeft}s` : "";
  const stat = parts.length ? `  (${parts.join(" · ")})` : "";
  return `${pinned}${cooling}${stat}`;
}

/** models.json 里配置了 combo 模型的 provider id 清单（含尚未构建的；与 outputComboList 同源）。 */
function configuredComboPids(): string[] {
  const { providers } = loadModelsJson();
  const pids: string[] = [];
  for (const [pid, cfgRaw] of Object.entries(providers)) {
    const cfg = cfgRaw as any;
    if (cfg?.combo !== true) continue;
    const models = Array.isArray(cfg.models) ? cfg.models : [];
    if (models.some((md: any) => md?.combo && Array.isArray(md.combo.members) && md.combo.members.length > 0)) pids.push(pid);
  }
  return pids;
}

/** 已构建 combo 代理状态快照；为空时 refresh 补建（延迟建）再取。 */
function builtCombos(): any[] {
  // built !== false：排除未构建（懒建未触发）的 combo，只统计真正在跑的
  let combos = proxyStatus().filter((s: any) => (s as any).isCombo === true && (s as any).built !== false);
  if (combos.length === 0) {
    try { refreshProviderProxies(); } catch { /* 补建失败按无代理处理 */ }
    combos = proxyStatus().filter((s: any) => (s as any).isCombo === true && (s as any).built !== false);
  }
  return combos;
}

/** 单个 combo provider 的状态块（status.line + 逐槽位行）。 */
function comboStatusBlock(st: any): string {
  const entries = (st as any).entries ?? [];
  const coolingCount = entries.filter((e: any) => e.cooldown).length;
  const sats = (st as any).saturation ?? [];
  const lines: string[] = [];
  lines.push(t("status.line", { provider: st.provider, port: st.port, slots: entries.length, sticky: st.sticky ? t("sticky.on") : t("sticky.off"), cooling: coolingCount })
    + (sats.length ? t("status.line.sat", { list: sats.map((x: any) => `${x.pool}(${x.seconds}s)`).join(",") }) : ""));
  for (const e of entries) {
    const ty = Array.isArray(e.types) && e.types.length > 0 ? `  [${e.types.join("/")}]` : "";
    lines.push(`    · ${e.member ?? e.name}  model=${e.model}${ty}${e.upstream ? `  → ${e.upstream}` : ""}  ${t("weight", { w: e.weight ?? 10 })}${comboEntryStatusLine(e)}`);
  }
  return lines.join("\n");
}

/** 按 provider id（大小写不敏感）找已构建 combo；找不到时 refresh 补建后再找一次。 */
function findBuiltCombo(pidLower: string): any | undefined {
  const hit = proxyStatus().find((s: any) => (s as any).isCombo === true && (s as any).built !== false && String(s.provider).toLowerCase() === pidLower);
  if (hit) return hit;
  try { refreshProviderProxies(); } catch { /* 补建失败按未构建处理 */ }
  return proxyStatus().find((s: any) => (s as any).isCombo === true && (s as any).built !== false && String(s.provider).toLowerCase() === pidLower);
}

/** 输出 /combo status：显示组合代理的详细运行状态（粘性/冷却/饱和/请求统计/token 输入输出）。
 *  尚未构建（延迟建）时自动触发 refresh 补建，无需用户手动 /combo refresh。
 *  带 provider 名（/combo status <provider>，大小写不敏感）→ 直接输出该 provider；
 *  不带名字且有多个组合 → 弹 provider 选择器（老宿主/headless 无 ui.select → 退回全部输出）。 */
async function outputComboStatus(ctx: any, providerArg?: string): Promise<void> {
  const want = (providerArg || "").trim().toLowerCase();

  // /combo status <provider>：直出该 provider（未构建先补建）
  if (want) {
    const st = findBuiltCombo(want);
    if (!st) {
      emit(ctx, t("status.unknown.provider", { v: providerArg!.trim(), list: configuredComboPids().join(", ") || t("combo.none.known") }), "warning");
      return;
    }
    emit(ctx, comboStatusBlock(st));
    return;
  }

  const combos = builtCombos();
  if (combos.length === 0) {
    emit(ctx, t("combo.none.status"), "warning");
    return;
  }
  if (combos.length === 1) {
    emit(ctx, comboStatusBlock(combos[0]));
    return;
  }

  // 多个组合：弹 provider 选择器（含已配置未构建项，选中自动补建）
  const select = ctx?.ui?.select;
  if (typeof select !== "function") {
    emit(ctx, combos.map((s) => comboStatusBlock(s)).join("\n\n"));
    return;
  }
  const options: Array<{ label: string; pid: string }> = combos.map((s: any) => {
    const entries = (s as any).entries ?? [];
    return {
      label: `${s.provider} — ${t("status.opt.built", { port: s.port, slots: entries.length, cooling: entries.filter((e: any) => e.cooldown).length })}`,
      pid: String(s.provider),
    };
  });
  const builtPids = new Set(options.map((o) => o.pid.toLowerCase()));
  for (const pid of configuredComboPids()) {
    if (!builtPids.has(pid.toLowerCase())) options.push({ label: `${pid} — ${t("run.unbuilt")}`, pid });
  }
  let picked: string | undefined;
  try {
    picked = await select.call(ctx.ui, t("status.pick.title"), options.map((o) => o.label));
  } catch {
    emit(ctx, combos.map((s) => comboStatusBlock(s)).join("\n\n"));
    return;
  }
  if (!picked) { emit(ctx, t("cancelled")); return; }
  const opt = options.find((o) => o.label === picked);
  if (!opt) { emit(ctx, t("bad.choice", { v: picked }), "warning"); return; }
  const st = findBuiltCombo(opt.pid.toLowerCase());
  if (!st) { emit(ctx, t("status.unknown.provider", { v: opt.pid, list: configuredComboPids().join(", ") }), "warning"); return; }
  emit(ctx, comboStatusBlock(st));
}

/** /combo 可选操作（供交互选择器与 runComboAction 共用）。 */
const COMBO_ACTIONS: Array<{ cmd: string; label: string }> = [
  { cmd: "list", label: `list — ${t("action.list")}` },
  { cmd: "status", label: `status — ${t("action.status")}` },
  { cmd: "refresh", label: `refresh — ${t("action.refresh")}` },
];

/** 执行 /combo 子命令（非法子命令提示可用项）。status 支持可选 provider 名直出（/combo status <provider>）。 */
async function runComboAction(cmd: string, arg: string, ctx: any): Promise<void> {
  if (cmd === "list") {
    outputComboList(ctx);
  } else if (cmd === "status") {
    await outputComboStatus(ctx, arg);
  } else if (cmd === "refresh") {
    const ids = refreshProviderProxies();
    emit(ctx, t("refreshed", { n: ids.length }));
  } else {
    emit(ctx, t("bad.sub"), "warning");
  }
}

/** /combo 无参数：弹三命令交互选择器，选中即执行。
 *  老宿主/headless 无 ui.select（或调用异常）→ 退回文本帮助。 */
async function pickComboAction(ctx: any): Promise<void> {
  const select = ctx?.ui?.select;
  if (typeof select !== "function") {
    outputComboHelp(ctx);
    return;
  }
  let picked: string | undefined;
  try {
    picked = await select.call(ctx.ui, t("pick.title"), COMBO_ACTIONS.map((a) => a.label));
  } catch {
    outputComboHelp(ctx);
    return;
  }
  if (!picked) {
    emit(ctx, t("cancelled"));
    return;
  }
  const action = COMBO_ACTIONS.find((a) => picked === a.label || picked.startsWith(a.cmd + " ") || picked.startsWith(a.cmd + "—"));
  if (!action) {
    emit(ctx, t("bad.choice", { v: picked }), "warning");
    return;
  }
  await runComboAction(action.cmd, "", ctx);
}

/** 输出 /combo 帮助（headless/老宿主兑底）：显示子命令。 */
function outputComboHelp(ctx: any): void {
  emit(ctx, t("help.text"));
}
