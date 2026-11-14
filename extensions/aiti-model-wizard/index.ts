/**
 * aiti-model-wizard · 模型添加开机向导扩展（server 端）
 *
 * 设计：docs/aiti-model-wizard-extension-plan.md
 * 能力：
 *   - 目录：models.dev（justget 多源下载 + Gitee 镜像缓存）+ 内嵌国内 AI 目录（中文名/注册说明/领 token 地址）
 *   - 搜索（中/英/别名/模型 id）→ 提供商详情（api 地址 / doc / 注册说明 / 领 token 地址）
 *   - 反向匹配（baseUrl → 候选，用户漏 /v1 /v2 也能匹配）
 *   - 自动探测（baseUrl → api 类型 + 真实地址）
 *   - 测试连接（探针：2xx / 429 都算通过）
 *   - 模型发现（/models 列表 ∪ 目录已知模型，去重）
 *   - 写 models.json（原子写 + 合并 provider/models）；token 一律打码只进不出
 *   - agent 工具（server.agent 进程内注入）：aiti_model_wizard_*
 */
import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { createRequire } from "node:module";

/** 代理刷新：扩展↔扩展直连 pi-models-combo 的 globalThis 服务入口
 *  （跨副本共享挂载面；未装载该扩展时静默跳过）。不再经由宿主 core special-case。
 *  @returns 实际刷新的 provider 列表（未装载时为空数组）。 */
function refreshProxiesViaCombo(providerId?: string): string[] {
  try {
    const g = globalThis as any;
    const res = g.__piModelsCombo?.refresh?.(providerId);
    return Array.isArray(res) ? res : [];
  } catch { /* 未装 pi-models-combo 时静默 */ return []; }
}
/** 每次加载清掉 core.cjs 的 require 缓存（热重载后能拿到新逻辑；jiti 的 require.cache 是空对象，须用原生 createRequire 的缓存） */
function loadCore() {
  const nativeRequire = createRequire(import.meta.url);
  const c = nativeRequire.cache || {};
  for (const k of Object.keys(c)) {
    if (k.includes("aiti-model-wizard") && (k.endsWith("core.cjs") || k.endsWith("effective-models.cjs"))) delete c[k];
  }
  return nativeRequire("./core.cjs");
}
const core = loadCore();

let configDir = "";
let cfg: any = null;
// 服务总线（startup 捕获；/usage 消费 aiti-provider-usage.overview 用——跨扩展一律 ctx.services）
let servicesCtx: any = null;

/** OAuth 订阅型 provider 判定（/save 守卫与 saveBatch 共用；getIndex 读目录缓存）。 */
function isOauthProvider(pid: string): boolean {
  try { const { byKey } = getIndex(); return byKey.get(pid)?.authType === "oauth"; } catch { return false; }
}

/** 自定义请求头白名单清洗（2026-09-17）：只收非空字符串值；上限 32 条防滥用。 */
function sanitizeHeaders(v: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    const name = String(k || "").trim();
    if (!name || typeof val !== "string" || !val.trim()) continue;
    out[name] = val;
    if (Object.keys(out).length >= 32) break;
  }
  return out;
}
/** 读 models.json 已存 provider 的 headers（测试/拉模型/探测链路共用，2026-09-17）。 */
function storedProviderHeaders(provider: string): Record<string, string> {
  try { return sanitizeHeaders(core.loadModelsJson(configDir, cfg).data?.providers?.[provider]?.headers); }
  catch { return {}; }
}
/** 生效请求头（2026-09-17 审核修正）：合并「草稿头」与「已存头」，掩码不得当真实值发出。
 *  - 未传 headers（undefined）→ 全用已存（未动=保留）；
 *  - 传了 headers（含空对象=清除）→ 草稿为准；maskedHeaders 名单里的头用已存原值替换，已存缺失丢弃。 */
function effectiveHeaders(b: any, provider?: string): Record<string, string> {
  const stored = provider ? storedProviderHeaders(provider) : {};
  if (!b || b.headers === undefined) return stored;
  const draft = sanitizeHeaders(b.headers);
  const masked = new Set((Array.isArray(b.maskedHeaders) ? b.maskedHeaders : []).map((n: any) => String(n || "").trim()).filter(Boolean));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft)) {
    if (masked.has(k)) { if (stored[k]) out[k] = stored[k]; }
    else out[k] = v;
  }
  for (const n of masked) if (!(n in out) && stored[n]) out[n] = stored[n];
  return out;
}

/** 单条 save 共享实现（/save 与 save-batch/saveBatch service 共用）：
 *  守卫（oauth/combo/必填）→ 元数据多源反填 → upsert（含 apiKeyEnv env 型 key）→ 改名迁移。
 *  不做 stash/写盘/缓存失效/代理刷新——批量场景由 saveBatchImpl 一次完成（undo 快照批前一次打）。
 *  返回 {ok:true, undoPatch, r, models, keys, md} | {ok:false, status, error}。 */
async function applySaveInto(data: any, b: any, c: any, storeData?: any) {
  const provider = String(b.provider || "");
  if (isOauthProvider(provider)) return { ok: false as const, status: 400, error: "「" + provider + "」是订阅登录型 provider，凭据由登录流程管理（auth.json），不能写入 models.json。如需重新登录请打开 🧙 面板 ☰ 功能菜单 →「🔐 订阅」。" };
  if (!b.provider || !b.baseUrl || !b.api) return { ok: false as const, status: 400, error: "需要 provider + baseUrl + api" };
  if (((data.providers || {})[provider] || {}).combo === true) return { ok: false as const, status: 400, error: "「" + provider + "」是模型聚合组——请在 🧙 面板「🧩 模型聚合」中编辑" };
  const models = Array.isArray(b.models) ? b.models.map((m: any) => typeof m === "string" ? { id: m } : m) : [];
  const keys = Array.isArray(b.keys) ? b.keys.map((k: any) => typeof k === "string" ? { name: "key", key: k } : k) : undefined;
  // undo 快照取「pre-mutation 深拷贝」：upsert 对已存在 provider 是原地突变，
  // 批量场景 stash 在批末统一落盘——存引用会让快照跟着突变、undo 失效（原 /save 因先 stash 后 upsert 无此问题）
  const undoPatch: any = { [provider]: data.providers && data.providers[provider] != null ? JSON.parse(JSON.stringify(data.providers[provider])) : null };
  const oldName0 = String(b.renameFrom || "").trim();
  if (oldName0 && oldName0 !== provider) undoPatch[oldName0] = data.providers && data.providers[oldName0] != null ? JSON.parse(JSON.stringify(data.providers[oldName0])) : null;
  // 注意 .data：loadModelsStore 返回 {file, data} 包装，store 消费端（storeModelsFor）要的是 provider 映射本身
  const store = storeData ?? core.loadModelsStore(configDir, c).data;
  const prov0 = data.providers && data.providers[provider];
  const md = await core.resolveMdForUpsert(configDir, c, { provider, baseUrl: b.baseUrl, models, existingModels: prov0 && prov0.models, store });
  // 改名场景：已存头来源=旧 provider（掩码回填/未动继承，审核修正——不得因改名丢头）
  const headersFrom = oldName0 && oldName0 !== provider && data.providers && data.providers[oldName0] ? data.providers[oldName0].headers : undefined;
  const r = core.upsertProviderData(data, { provider, baseUrl: b.baseUrl, api: b.api, apiKey: b.apiKey, apiKeyEnv: b.apiKeyEnv, keepKey: !!b.keepKey, models, removeModels: !!b.replaceModels, keys, headers: b.headers, maskedHeaders: b.maskedHeaders, ...(headersFrom ? { headersFrom } : {}), store, mdModels: md.mdModels, extras: md.extras, listExtras: Array.isArray(b.listExtras) ? b.listExtras : [] });
  if (!r.ok) return { ok: false as const, status: 500, error: r.error };
  // 改名：provider 变了才删旧键（编辑流重命名用）；key 一并迁移不丢失
  const old = String(b.renameFrom || "").trim();
  if (old && old !== provider) {
    const src = r.data.providers[old];
    const dst = r.data.providers[provider];
    if (src && dst) {
      if (!dst.apiKey && src.apiKey) dst.apiKey = src.apiKey;
      if (!dst.apiKeyEnv && src.apiKeyEnv) dst.apiKeyEnv = src.apiKeyEnv;
      if ((!dst.apiKeys || !dst.apiKeys.length) && Array.isArray(src.apiKeys) && src.apiKeys.length) dst.apiKeys = src.apiKeys;
    }
    const dr = core.deleteProviderData(r.data, old);
    if (dr.ok) r.data = dr.data;
  }
  return { ok: true as const, undoPatch, r, models, keys, md };
}

/** 批量保存（aiti-models-import 等扩展经 ctx.services 消费；HTTP POST /save-batch 同一实现）：
 *  批前一次 stashUndo（多 provider patch → /undo 一步回整批）→ 逐条 upsert（单条失败不中断）
 *  → 单次 writeModelsConfig + 缓存失效 + 逐 provider 代理热刷新。 */
async function saveBatchImpl(ctx: any, saves: any[]) {
  const c = withCfg();
  const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
  const storeData = core.loadModelsStore(configDir, c).data; // .data = provider 映射（见 applySaveInto 注释）
  const undoPatch: any = {};
  const results: any[] = [];
  const changed: string[] = [];
  for (const sb of saves) {
    const one = await applySaveInto(data, sb, c, storeData);
    const name = String(sb?.provider || "");
    if (!one.ok) { results.push({ provider: name, ok: false, error: one.error }); continue; }
    Object.assign(undoPatch, one.undoPatch);
    results.push({ provider: one.r.provider, ok: true, modelCount: one.r.modelCount, fills: one.r.fills || [], missingParams: one.r.missingParams || [] });
    changed.push(one.r.provider);
    core.snapshotProvider(configDir, String(sb.provider), one.models, { merge: true });
  }
  if (!changed.length) return { ok: false as const, error: "无有效保存（全部条目失败）", results };
  core.stashUndo(configDir, undoPatch);
  await ctx.core.writeModelsConfig(data);
  for (const pid of changed) refreshProxiesViaCombo(pid);
  return { ok: true as const, results, file: "(pi-web /api/models-config)", undoable: true };
}

// ---- 新模型检测与提醒：后台扫描状态（globalThis 按 configDir 分 key，跨 reload 不重复起 timer） ----
const gScanKey = "aitiModelWizardReminderScan";
function getScanState() {
  const g = globalThis as any;
  const key = gScanKey + ":" + configDir;
  if (!g[key]) g[key] = { timer: null, scanning: false, done: false, lastAt: 0 };
  return g[key];
}
/** 后台扫描：逐已配置 provider（有 key）并行拉 /models → 快照进今日桶；失败静默。 */
async function scanNewModels(state: any) {
  if (!cfg || !cfg.reminder || cfg.reminder.enabled === false) { if (state) state.done = true; return; }
  if (!state || state.scanning) return;
  state.scanning = true;
  const t0 = Date.now();
  try {
    const c = withCfg();
    core.rollReminder(configDir);
    const params = core.providerScanParams(configDir, c);
    const timeoutMs = (c.reminder && c.reminder.fetchTimeoutMs) || 8000;
    const results = await Promise.all(params.map(async (it: any) => {
      if (!it || !it.hasKey || !it.hasBase) return { ok: false, skip: true, name: it && it.name };
      const m = await core.discoverModels({ baseUrl: it.baseUrl, api: it.api, apiKey: it.apiKey }, { timeoutMs, extraHeaders: it.headers }).catch(() => ({ ok: false }));
      if (m.ok && Array.isArray(m.models) && m.models.length) {
        core.snapshotProvider(configDir, it.name, m.models.map((x: any) => (typeof x === "string" ? x : x && x.id)));
        refluxAux(it.baseUrl, (m as any).raw); // 扫描拉到的实时目录顺手入缓存：横幅提示的同时参数即可反填
        return { ok: true, name: it.name };
      }
      return { ok: false, name: it.name };
    }));
    const okN = results.filter((r: any) => r.ok).length;
    const skipN = results.filter((r: any) => r.skip).length;
    console.log("[aiti-model-wizard] 新模型扫描完成 · providers=" + params.length + " · 成功=" + okN + " · 跳过(缺key/base)=" + skipN + " · " + Math.round((Date.now() - t0) / 1000) + "s");
  } catch (e: any) {
    console.error("[aiti-model-wizard] 新模型扫描失败：" + String((e && e.message) || e));
  } finally {
    state.done = true;
    state.lastAt = Date.now();
    state.scanning = false;
  }
}
/** 启动后台扫描：首扫延迟 3s（等服务稳定），之后按 reminder.checkIntervalMs 周期；幂等（先清旧 timer）。 */
function startReminderScan() {
  const state = getScanState();
  if (state.timer) clearInterval(state.timer);
  const intervalMs = (cfg && cfg.reminder && cfg.reminder.checkIntervalMs) || 30 * 60 * 1000;
  state.timer = setInterval(() => void scanNewModels(state), intervalMs);
  setTimeout(() => void scanNewModels(state), 3000);
}
function stopReminderScan() {
  const state = getScanState();
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** 拉取同进程 /api/models（pi ModelRuntime 可见模型清单），返回 byProvider map（pid → modelList）。
 *  /combos / /status 等共享：runtime provider 合并 + 内存模型清单。失败静默返回 null。 */
async function fetchModelsData(req: Request, cwdHint?: string): Promise<any | null> {
  try {
    const host = req.headers.get("host") || "127.0.0.1:3001";
    const envBasePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
    const base = `http://${host}${envBasePath}`;
    const candidates: string[] = [];
    if (cwdHint) candidates.push(cwdHint);
    candidates.push(process.cwd());
    for (const cwd of candidates) {
      try {
        const res = await fetch(`${base}/api/models`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
        if (res.ok) return await res.json();
      } catch { /* 试下一个候选 */ }
    }
  } catch (err: any) {
    console.warn("[aiti-model-wizard] 获取 /api/models 失败:", err?.message);
  }
  return null;
}

/** /api/models 响应 → 运行时注册 provider 全集 map（不带 skip 过滤——skip 由调用方做，缓存共用全集）。
 *  pid → { name, api, baseUrl, apiKey, models:[{id,name,api,baseUrl,contextWindow,maxTokens,input,reasoning}], _runtimeRegistered }。 */
function modelsDataToRuntimeProviders(modelsData: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!modelsData) return out;
  const byProvider = new Map<string, any[]>();
  for (const m of modelsData.modelList || []) {
    if (!m || !m.provider) continue;
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider)!.push(m);
  }
  for (const [pid, models] of byProvider) {
    out[pid] = {
      name: pid,
      api: "openai-completions",
      baseUrl: "",
      apiKey: "runtime-registered",
      models: models.map((m: any) => ({
        id: m.id,
        name: m.name,
        api: "openai-completions",
        baseUrl: "",
        contextWindow: null,
        maxTokens: null,
        input: ["text"],
        reasoning: false,
      })),
      _runtimeRegistered: true,
    };
  }
  return out;
}

function filterRuntimeProviders(map: Record<string, any>, skip: Set<string>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const pid of Object.keys(map)) {
    if (!skip.has(pid)) out[pid] = map[pid];
  }
  return out;
}

// ── 运行时 provider 展示合并缓存（stale-while-revalidate，2026-11-04）──
// /api/models 冷加载（内存缓存 miss 且磁盘快照缺失/超龄）要现场 createAgentSessionServices（全量初始化
// pi 会话服务），秒级——打开向导面板的 /status 只为「模型列表补全运行时注册 provider」这一展示用途，
// 不值得每次都同步等它（实测冷路径把面板打开卡到 ~7s）。
// 内存 TTL 内直接用；过期先回旧值 + 后台 single-flight 刷新（失败保留旧值）；
// cwdHint 非空（调用方点名 cwd）绕过缓存走实时；无缓存（首冷）同步拉一次落缓存，此后永不再等。
// 校验类用途（/combos、/combo-save 成员池）不走此缓存——继续实时 getRuntimeEntries。
let _rtProvCache: { at: number; data: Record<string, any> } | null = null;
let _rtProvRefresh: Promise<void> | null = null;
const RT_PROV_TTL_MS = 90_000;

/** 无 Request 时的自取 /api/models（startup 预热路径；同 fetchRuntimeEntriesSelf 的端点逻辑，返回原始 JSON）。 */
async function fetchModelsDataSelf(): Promise<any | null> {
  const port = String(process.env.PORT || "");
  if (!port) return null;
  try {
    const envBasePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
    const res = await fetch(`http://127.0.0.1:${port}${envBasePath}/api/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** 后台刷新运行时 provider 缓存（single-flight；仅成功时覆盖——失败保留旧值下次过期再试）。 */
function rtProvStartRefresh(req: Request | null, cwdHint?: string): Promise<void> {
  if (_rtProvRefresh) return _rtProvRefresh;
  const p = (async () => {
    try {
      const d = req ? await fetchModelsData(req, cwdHint) : await fetchModelsDataSelf();
      if (d) _rtProvCache = { at: Date.now(), data: modelsDataToRuntimeProviders(d) };
    } catch { /* 失败保留旧值 */ }
  })().finally(() => { if (_rtProvRefresh === p) _rtProvRefresh = null; });
  _rtProvRefresh = p;
  return p;
}

/** /status 专用的运行时 provider 合并（带 SWR 缓存；skip：已存在的 provider 集合，避免重复）。 */
async function fetchRuntimeProviders(req: Request, skip: Set<string>, cwdHint?: string): Promise<Record<string, any>> {
  if (cwdHint) {
    // 点名 cwd：绕过缓存走实时（不同 cwd 的运行时视图可能不同；也不污染默认 cwd 的缓存）
    return filterRuntimeProviders(modelsDataToRuntimeProviders(await fetchModelsData(req, cwdHint)), skip);
  }
  const cached = _rtProvCache;
  if (cached) {
    if (Date.now() - cached.at > RT_PROV_TTL_MS) rtProvStartRefresh(req); // 过期：先回旧值 + 后台刷新
    return filterRuntimeProviders(cached.data, skip);
  }
  // 无缓存（首冷）：同步拉一次落缓存，此后打开面板不再等冷加载
  const d = await fetchModelsData(req);
  const data = modelsDataToRuntimeProviders(d);
  if (d) _rtProvCache = { at: Date.now(), data };
  return filterRuntimeProviders(data, skip);
}

/** /api/models 响应 → pi 运行时条目（resolveProviderModels 的 runtime 参数格式） */
function modelsDataToEntries(modelsData: any): any[] | null {
  const entries: any[] = [];
  for (const m of modelsData?.modelList || []) {
    if (!m || !m.provider || !m.id) continue;
    entries.push({
      provider: m.provider,
      id: m.id,
      api: m.api || "openai-completions",
      baseUrl: m.baseUrl || "",
      reasoning: !!m.reasoning,
    });
  }
  return entries.length ? entries : null;
}

/** 从 /api/models 构建 pi ModelRuntime 快照条目（同 aiti-model-check /status 的合并方式）。 */
async function fetchRuntimeEntries(req: Request, cwdHint?: string): Promise<any[] | null> {
  const modelsData = await fetchModelsData(req, cwdHint);
  return modelsData ? modelsDataToEntries(modelsData) : null;
}

/** 无 Request 时的自取（agent 工具路径）：Next 服务器进程环境变量 PORT + PI_WEB_BASE_PATH 自调 /api/models。 */
async function fetchRuntimeEntriesSelf(): Promise<any[] | null> {
  const port = String(process.env.PORT || "");
  if (!port) return null;
  try {
    const envBasePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
    const res = await fetch(`http://127.0.0.1:${port}${envBasePath}/api/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: process.cwd() }),
    });
    if (!res.ok) return null;
    return modelsDataToEntries(await res.json());
  } catch { return null; }
}

/** 运行时条目（combo 成员池权威源，/combos / /combo-save / 工具三处同源）：
 *  1) HTTP /api/models——服务进程 live 注册表（含 pi 扩展注册的 provider 如 freeflow/qoder-local，
 *     离线 ModelRuntime.create() 看不到它们）；agent 工具路径无 Request → 用 PORT 自取。
 *  2) offline = 离线快照（core.initPiRuntime）兜底——仅补 models.json 已知 provider 的模型清单
 *     （knownPids 过滤；内置 provider 目录不得据此入池——hasKey 误真且引擎运行时无法解析）。 */
async function getRuntimeEntries(req: Request | null, cwdHint?: string, knownPids?: Set<string>): Promise<any[] | null> {
  const [live, offlineRaw] = await Promise.all([
    req ? fetchRuntimeEntries(req, cwdHint) : fetchRuntimeEntriesSelf(),
    (async () => { if (!core.piReady()) { await core.initPiRuntime(cfg).catch(() => {}); } return core.runtimeEntries(); })(),
  ]);
  // offline 含全部内置 provider（anthropic/openai 等未配置凭据的也在）——仅允许补 models.json 已知
  // provider 的模型清单（knownPids 过滤），严禁据此合成新 provider 成员（hasKey 误真 + 引擎运行时无法解析）
  const offline = offlineRaw && knownPids ? offlineRaw.filter((e: any) => knownPids.has(e.provider)) : offlineRaw;
  if (!live) return offline && offline.length ? offline : null;
  if (!offline || !offline.length) return live;
  const seen = new Set(live.map((e: any) => e.provider + "/" + e.id));
  return live.concat(offline.filter((e: any) => !seen.has(e.provider + "/" + e.id)));
}

function reloadCfg() {
  cfg = core.loadConfig(configDir);
  return cfg;
}
function withCfg() {
  reloadCfg();
  // 快照兜底：指向扩展目录里内嵌的 models.dev 快照
  if (!cfg.catalog.snapshotPath) {
    try {
      const extDir = pathJoin(__dirname, "catalog");
      if (existsSync(pathJoin(extDir, "models.dev.json"))) cfg.catalog.snapshotPath = pathJoin(extDir, "models.dev.json");
    } catch (e) {}
  }
  return cfg;
}
function getIndex() {
  const c = withCfg();
  return core.buildIndex(configDir, c);
}
/** 目录信息卡（给前端/AI 的简洁字段，不含内部字段） */
function providerCard(p: any) {
  return {
    id: p.id, name: p.name, cnName: p.cnName || "", baseUrl: p.baseUrl || "", apiType: p.apiType,
    doc: p.doc || "", signupUrl: p.signupUrl || "", tokenUrl: p.tokenUrl || "", register: p.register || "",
    env: p.env || "", source: p.source, hasCn: !!p.hasCn, authType: p.authType || "", oauthProviderId: p.oauthProviderId || "",
  };
}
function providerFull(p: any) {
  return { ...providerCard(p), aliases: p.aliases || [], models: (p.models || []).slice(0, 200) };
}
/** 给探测结果补品牌与建议地址：反向匹配目录；score>=100 视为品牌确定 + suggestedBaseUrl（目录完整地址，如补 /v1） */
function augmentDetect(detect: any, index: any[], inputUrl: string) {
  if (!detect || !detect.ok) return { ...(detect || {}), providerGuess: null, suggestedBaseUrl: null };
  const configuredBaseUrls = getConfiguredBaseUrls();
  const cands = core.reverseMatch(index, detect.baseUrl || inputUrl, configuredBaseUrls);
  const exact = cands.find((c: any) => c.score >= 100);
  const best = cands[0];
  const providerGuess = best
    ? { id: best.id, name: best.name, cnName: best.cnName || "", score: best.score, confident: !!(exact && best.id === exact.id) }
    : null;
  return {
    ...detect,
    providerGuess,
    // 精确命中 → 用目录已知完整地址（如 deepseek 补 /v1）；anthropic 按运行时语义去尾部 /v1（2026-09-17）
    suggestedBaseUrl: exact ? core.normalizeBaseForApi(exact.baseUrl, detect.api) : null,
  };
}
/** 从 models.json 收集已配置 provider 的 baseUrl（用于域名反向匹配）。 */
function getConfiguredBaseUrls() {
  try {
    const { data } = core.loadModelsJson(configDir, withCfg());
    const out: Record<string, string> = {};
    for (const [name, p] of Object.entries(data.providers || {})) {
      if (p && typeof p === "object" && p.baseUrl) out[name] = String(p.baseUrl);
    }
    return out;
  } catch {
    return {};
  }
}
/** 带 key 时用「建议完整地址」拉 /models 模型列表（品牌/模型查询接口）——显示真实模型 */
async function withModels(result: any, apiKey?: string, extraHeaders?: Record<string, string>) {
  if (!apiKey || !result.ok) return { ...result, models: null, modelCount: 0, modelsError: "" };
  const base = result.suggestedBaseUrl || result.baseUrl;
  const m = await core.discoverModels({ baseUrl: base, api: result.api, apiKey }, { timeoutMs: 10000, extraHeaders }).catch(() => ({ ok: false }));
  if (m.ok && Array.isArray(m.models)) {
    refluxAux(base, (m as any).raw);
    return { ...result, models: m.models.slice(0, 60), modelCount: m.models.length, modelsError: "" };
  }
  return { ...result, models: null, modelCount: 0, modelsError: m.error || "" };
}
/** 厂商 /models 原始数据回流 openrouter aux 缓存（fire-and-forget，失败静默）：
 *  检测/探测/刷新拉到的实时目录顺手入缓存，参数反填即刻可命中——消灭「拉两遍互不共享」的时差 */
function refluxAux(baseUrl: string, raw: any) {
  try {
    const r: any = core.updateAuxFromScan(configDir, withCfg(), baseUrl, raw);
    if (r && r.updated) console.log("[aiti-model-wizard] /models 原始数据已回流 openrouter aux 缓存（" + String(baseUrl || "").replace(/^https?:\/\//, "") + "）");
  } catch { /* 回流失败不影响主流程 */ }
}
/** 完整探测链路：detect → 目录品牌(URL) → 拉模型∥OpenAPI 探测 → 品牌信号合并 */
async function detectFull(r: any, index: any[], inputUrl: string, apiKey?: string, extraHeaders?: Record<string, string>) {
  const configuredBaseUrls = getConfiguredBaseUrls();
  const aug = augmentDetect(r, index, inputUrl);
  const base = aug.suggestedBaseUrl || aug.baseUrl;
  const [m, openApi] = await Promise.all([
    withModels(aug, apiKey, extraHeaders),
    core.probeOpenApi(base, aug.api, apiKey, undefined, extraHeaders).catch(() => ({ ok: false })),
  ]);
  const brands: any[] = [];
  if (openApi && openApi.ok) {
    brands.push({ source: "openapi", title: openApi.title, provider: core.brandFromText(openApi.title, index) });
  }
  if (m.models && m.models.length) {
    const mp = core.brandFromModels(m.models, index);
    if (mp) brands.push({ source: "models", provider: mp });
  }
  // HTTP HEAD 信号：Server / x-powered-by 等响应头推断品牌
  const headSignal = await core.probeServerHeaders(base, aug.api, apiKey, undefined, extraHeaders).catch(() => null);
  if (headSignal) {
    const hp = core.brandFromText(headSignal.server || headSignal.xPoweredBy || "", index);
    if (hp) brands.push({ source: "server-header", title: headSignal.server || headSignal.xPoweredBy, provider: hp });
  }
  return { ...m, brands, openApi };
}

// ---- agent 工具定义（process-injected，AI 直接用；与 aiti-configs/aiti-model-check 同机制） ----
const TOOLS = [
  { name: "model_wizard_status", description: "模型添加向导：当前已配置的 providers（token 已打码 sk-***abcd），以及 models.json 路径。", inputSchema: { type: "object", properties: {} } },
  { name: "model_wizard_search", description: "模型添加向导：在目录里搜索 AI 提供商（支持中文/英文/别名/模型 id，如 智谱/deepseek/kimi/硅基流动/qwen）。返回候选的 api 地址、注册说明、领 token 地址、文档、已知模型。", inputSchema: { type: "object", properties: { q: { type: "string", description: "搜索词（中文或英文）" } }, required: ["q"] } },
  { name: "model_wizard_provider", description: "模型添加向导：查看某个提供商详情（完整 api 地址/注册说明/领 token 地址/已知模型列表）。id 可从 model_wizard_search 结果拿。", inputSchema: { type: "object", properties: { id: { type: "string", description: "提供商 id（如 deepseek/zhipu/moonshot）" } }, required: ["id"] } },
  { name: "model_wizard_detect", description: "模型添加向导：给一个 baseUrl 自动探测 api 接口类型（openai-completions / anthropic-messages / openai-responses / google-generative-ai）和真实地址——用户漏了 /v1 /v2 /v1beta 也能自动补。可选带 apiKey 验证。", inputSchema: { type: "object", properties: { baseUrl: { type: "string", description: "用户提供的 API 地址（可能漏 v1/v2）" }, apiKey: { type: "string", description: "可选：API key（仅用于探测验证，不回传）" }, headers: { type: "object", description: "可选：自定义请求头（网关要求 User-Agent/x-* 等；键值均为字符串）" } }, required: ["baseUrl"] } },
  { name: "model_wizard_test", description: "模型添加向导：测试连接（发极小探针消息）。2xx 或 429 都算通过（429=key/端点正确只是限流）；401/403=key 无效。有 model 发消息探针，无 model 拉 /models 列表验证。多 key provider 可 allKeys=true 分 key 全测或 keyName 指定测某个（需 provider 字段）。", inputSchema: { type: "object", properties: { baseUrl: { type: "string" }, api: { type: "string", description: "openai-completions / anthropic-messages / openai-responses / google-generative-ai" }, apiKey: { type: "string" }, model: { type: "string", description: "可选：测试用的模型 id（不填则验证列表端点）" }, provider: { type: "string", description: "可选：provider 名（allKeys/keyName 时必填）" }, allKeys: { type: "boolean", description: "可选：分 key 测试该 provider 已存的全部 keys" }, keyName: { type: "string", description: "可选：只测指定名字的那个 key" }, headers: { type: "object", description: "可选：自定义请求头（键值均为字符串；provider 指定时自动带上已存 headers）" } }, required: ["baseUrl", "api"] } },
  { name: "model_wizard_save", description: "模型添加向导：把 provider + 模型列表写入 models.json（合并去重；新 token 覆盖，keepKey=true 保留旧 key）。可选 keys：多个 API key（每个 {name, key, rpm?}，rpm=每分钟请求上限）→ 写入 models.json 的 provider.apiKeys 供轮转/分 key 检查；单 key 也可直接用 apiKey 字段。模型元数据（contextWindow/maxTokens/reasoning/input/cost/thinkingLevelMap/compat）自动多源反填：models.json 已有条目 → 内置目录 → 厂商 /models 富字段 → models.dev → OpenRouter/LiteLLM 兜底（未知/stealth 新模型查不到时会强制刷新目录）；只需传 id/name 即可。注意：combo:true 的模型聚合组不能由此工具写入/修改——用 model_wizard_combo_save，或引导用户打开 🧙 面板 ☰ 功能菜单 →「🧩 聚合」编辑（左树选中聚合组亦可）。成功后刷新页面即出现模型。", inputSchema: { type: "object", properties: { provider: { type: "string", description: "provider 名（唯一标识）" }, baseUrl: { type: "string" }, api: { type: "string" }, apiKey: { type: "string", description: "新 token（可选；不填且 keepKey=true 则保留旧 key）" }, keepKey: { type: "boolean" }, keys: { type: "array", items: { type: "object", properties: { name: { type: "string", description: "key 名称（唯一标识，如 key-1）" }, key: { type: "string" }, rpm: { type: "number", description: "可选：每分钟请求上限" } }, required: ["name", "key"] }, description: "多个 API key（可选）：[{name, key, rpm?}]" }, models: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, reasoning: { type: "boolean" }, contextWindow: { type: "number" }, maxTokens: { type: "number" }, input: { type: "array", items: { type: "string" } }, compat: { type: "object" }, cost: { type: "object" }, thinkingLevelMap: { type: "object" } } }, description: "模型列表 [{id,name,reasoning?,contextWindow?,maxTokens?,input?,compat?,cost?}；元数据缺省时自动多源反填]" } }, headers: { type: "object", description: "可选：provider 级自定义请求头（如 User-Agent/x-*）；传 {} 清空，不传保留旧值" }, required: ["provider", "baseUrl", "api"] } },
  { name: "model_wizard_combo_save", description: "模型添加向导：创建/更新【模型聚合组】（组合模型）——把多个真实模型组成一个虚拟模型暴露给 pi。成员引用 {provider,model}（须为普通 provider 的真实模型：models.json 已配置 / models-store 补全 / 运行时注册 provider（如 pi-freeflow 的 freeflow）均可；可参照 GET /api/extensions/aiti-model-wizard/combos 返回的 members 池），可选 weight（默认 10，按权重占比随机选点）、可选 types（承接的请求类别白名单数组：text/vision/other；不配=承接全部——比如图形专用成员配 [\"vision\"] 则纯文本请求不发给它、带图请求自动路由到它；仅文本成员配 [\"text\"] 则带图请求避开它）。同协议才能同组；聚合组不能嵌套作成员；contextWindow/maxTokens 自动取成员最小值、input 取并集、cost 取最贵估算。粘性路由（同会话 TTL 内固定同一成员，最大化 prompt cache），429 冷却自动切换。保存后刷新页面即出现 聚合组名/虚拟模型id。", inputSchema: {"type":"object","properties":{"provider":{"type":"string","description":"聚合组名（provider id，用户自命名如 快速组/fast-group）"},"displayName":{"type":"string","description":"显示名（可选）"},"renameFrom":{"type":"string","description":"改名时填旧名（可选）"},"models":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string","description":"虚拟模型 id（如 fast）"},"name":{"type":"string"},"stickyTtlMin":{"type":"number","description":"粘性空闲 TTL 分钟（默认 15）"},"members":{"type":"array","items":{"type":"object","properties":{"provider":{"type":"string"},"model":{"type":"string"},"weight":{"type":"number","description":"默认 10；按权重占比随机选点"},"types":{"type":"array","items":{"type":"string"},"description":"可选：承接的请求类别白名单（text/vision/other 子集；不配=全部）——图形专用成员配 [\"vision\"]，仅文本成员配 [\"text\"]"}},"required":["provider","model"]},"description":"真实成员列表（≥1；同协议；不能引用其他聚合组）"}},"required":["id","members"]}}},"required":["provider","models"]} },
  { name: "model_wizard_keys", description: "模型添加向导：管理某 provider 的多个 API key（分 key 检查/轮转用）。action=list 列出（打码）/ set 用 keys 数组整体替换 / remove 按 name 删一个。设置后同步 models.json apiKey=第一个 key。", inputSchema: { type: "object", properties: { provider: { type: "string", description: "provider 名" }, action: { type: "string", description: "list / set / remove（缺省 list）" }, keys: { type: "array", items: { type: "object", properties: { name: { type: "string" }, key: { type: "string" }, rpm: { type: "number" } }, required: ["name", "key"] }, description: "set 时的新 keys 数组" }, name: { type: "string", description: "remove 时删除的 key 名" } }, required: ["provider"] } },
  { name: "model_wizard_delete", description: "模型添加向导：从 models.json 删除一个 provider。", inputSchema: { type: "object", properties: { provider: { type: "string" } }, required: ["provider"] } },
];

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}
async function runTool(name: string, args: any): Promise<any> {
  const c = withCfg();
  try {
    switch (name) {
      case "model_wizard_status": {
        const st = core.providersStatus(configDir, c);
        if (!st.providers.length) return toolResult("当前没有任何已配置 provider（models.json: " + st.file + "）。可用 aiti_model_wizard_search 搜索并添加。");
        const lines = ["已配置 providers（" + st.providers.length + " 个，token 已打码）："];
        for (const p of st.providers) {
          const keyTxt = p.keyCount > 1 ? " · " + p.keyCount + " 个 key" + (p.keys && p.keys.length ? "（" + p.keys.map((k) => k.name + "=" + (k.key || "-")).join(", ") + "）" : "") : (p.apiKeyMasked || "无");
          lines.push("  · " + p.provider + " [" + p.api + "] " + (p.baseUrl || "") + " · key=" + keyTxt + " · " + p.modelCount + " 个模型");
        }
        lines.push("文件：" + st.file);
        return toolResult(lines.join("\n"));
      }
      case "model_wizard_search": {
        const { index } = getIndex();
        const q = String((args && args.q) || "").trim();
        if (!q) return toolResult("请输入搜索词（如 智谱 / deepseek / kimi / 硅基流动）");
        const r = core.searchProviders(index, q);
        if (!r.length) return toolResult("目录未命中「" + q + "」。可让用户贴 baseUrl 用 aiti_model_wizard_detect 自动探测，或用 aiti_model_wizard_detect 从自定义地址接入。");
        const lines = ["搜索结果「" + q + "」（" + r.length + " 个）："];
        for (const p of r.slice(0, 10)) {
          lines.push("· " + p.id + " | " + [p.cnName, p.name].filter(Boolean).join(" / "));
          if (p.baseUrl) lines.push("    api: " + p.baseUrl + " [" + p.apiType + "]");
          if (p.tokenUrl) lines.push("    领 token: " + p.tokenUrl);
          if (p.signupUrl) lines.push("    注册: " + p.signupUrl);
          if (p.register) lines.push("    说明: " + p.register.slice(0, 80));
        }
        lines.push("—— 用 aiti_model_wizard_provider id=<id> 看完整详情与模型列表");
        return toolResult(lines.join("\n"));
      }
      case "model_wizard_provider": {
        const { byKey } = getIndex();
        const id = String((args && args.id) || "");
        const p = byKey.get(id);
        if (!p) return toolResult("找不到提供商 id=" + id + "（用 aiti_model_wizard_search 搜）", true);
        const lines = ["📇 " + [p.cnName, p.name].filter(Boolean).join(" / ") + "（" + p.id + "）"];
        if (p.baseUrl) lines.push("api 地址: " + p.baseUrl + "  [" + p.apiType + "]");
        if (p.doc) lines.push("文档: " + p.doc);
        if (p.signupUrl) lines.push("注册: " + p.signupUrl);
        if (p.tokenUrl) lines.push("领 token: " + p.tokenUrl);
        if (p.register) lines.push("注册说明: " + p.register);
        if ((p.models || []).length) lines.push("已知模型(" + p.models.length + "): " + p.models.slice(0, 20).map((m) => m.id).join(", ") + ((p.models.length > 20) ? " …" : ""));
        return toolResult(lines.join("\n"));
      }
      case "model_wizard_detect": {
        const baseUrl = String((args && args.baseUrl) || "").trim();
        if (!baseUrl) return toolResult("需要 baseUrl", true);
        const r = await core.detectApi(baseUrl, (args && args.apiKey) || "", { timeoutMs: 10000, extraHeaders: sanitizeHeaders(args && args.headers) });
        const lines = ["自动探测 " + baseUrl + "："];
        for (const pr of r.probes.slice(0, 10)) lines.push("  " + pr.api + " " + pr.url + " → " + pr.status + " " + pr.hint);
        if (r.ok) {
          lines.push("命中：" + r.api + " · 真实地址 " + r.baseUrl + "（" + r.hint + "）");
          lines.push("→ 用 aiti_model_wizard_test baseUrl=" + r.baseUrl + " api=" + r.api + " apiKey=<token> 测试连接");
        } else lines.push("❌ " + r.hint);
        return toolResult(lines.join("\n"));
      }
      case "model_wizard_test": {
        const a = args || {};
        // 自定义请求头（2026-09-17）：显式传入优先；provider 指定时回退读已存 headers
        const xh = Object.keys(sanitizeHeaders(a.headers)).length ? sanitizeHeaders(a.headers) : (a.provider ? storedProviderHeaders(String(a.provider)) : {});
        // 多 key 支持：allKeys=true 测已存 provider 全部 keys；keyName 指定测某个；缺省行为不变（单 apiKey）
        const toolTMs = (c.test && c.test.timeoutMs) || 12000;
        const wantMulti = a.allKeys || a.keyName;
        if (wantMulti) {
          const provider = String(a.provider || "");
          const all = provider ? core.getProviderKeys(configDir, c, provider) : [];
          const targets = a.allKeys ? all : all.filter((k: any) => k.name === a.keyName);
          if (!targets.length) {
            return toolResult("没找到可测的 key：provider=" + (provider || "<未传>") + (a.keyName ? " keyName=" + a.keyName : "") + "（先用 model_wizard_keys action=list 确认）");
          }
          const rows: string[] = [];
          for (const k of targets) {
            const r = await core.testConnection({ baseUrl: a.baseUrl, api: a.api, apiKey: k.key, model: a.model }, { timeoutMs: toolTMs, extraHeaders: xh });
            const icon = r.pass ? (r.rateLimited ? "🟡" : "✅") : "❌";
            rows.push("  " + icon + " " + k.name + "=" + core.maskKey(k.key) + " → HTTP " + (r.status || "net") + " · " + core.fmtDur(r.latencyMs) + " · " + r.detail);
          }
          const okCount = rows.filter((l) => l.includes("✅") || l.includes("🟡")).length;
          const head = (okCount === targets.length ? "✅" : okCount > 0 ? "🟡" : "❌") + " 分 key 测试 " + provider + " [" + (a.api || "") + "]" + (a.model ? " · model=" + a.model : "") + "：" + okCount + "/" + targets.length + " 可用";
          return toolResult([head, ...rows].join("\n"));
        }
        const r = await core.testConnection({ baseUrl: a.baseUrl, api: a.api, apiKey: a.apiKey, model: a.model }, { timeoutMs: toolTMs, extraHeaders: xh });
        const icon = r.pass ? (r.rateLimited ? "🟡" : "✅") : "❌";
        const lines = [icon + " 测试连接 " + a.baseUrl + " [" + (a.api || "") + "]" + (a.model ? " · model=" + a.model : "") + "："];
        lines.push("  HTTP " + (r.status || "net") + " · " + core.fmtDur(r.latencyMs));
        lines.push("  " + r.detail);
        if (r.pass) lines.push(r.rateLimited ? "→ 算通过（限流=key/端点正确，稍后重试即可）" : "→ 通过，可以选模型并保存");
        else lines.push("→ 失败（检查 key / 地址 / 是否漏了 /v1，或用 aiti_model_wizard_detect 自动探测）");
        return toolResult(lines.join("\n"));
      }
      case "model_wizard_save": {
        const a = args || {};
        // 订阅登录型守护：与 /save API 同规则（详见 isOauthManaged 注释）
        try { const { byKey } = getIndex(); if (byKey.get(String(a.provider || ""))?.authType === "oauth") return toolResult("「" + a.provider + "」是订阅登录型 provider，凭据由登录流程管理（auth.json），不能写入 models.json。请引导用户在 🧙 面板点「登录」。", true); } catch {}
        const models = Array.isArray(a.models) ? a.models.map((m: any) => typeof m === "string" ? { id: m } : m) : [];
        const keys = Array.isArray(a.keys) ? a.keys.map((k: any) => typeof k === "string" ? { name: "key", key: k } : k) : undefined;
        const hdrs = a.headers === undefined ? undefined : sanitizeHeaders(a.headers); // {} = 清空，不传 = 保留旧值
        const r = await core.upsertProvider(configDir, c, {
          provider: a.provider, baseUrl: a.baseUrl, api: a.api, apiKey: a.apiKey,
          keepKey: !!a.keepKey, models, keys,
          ...(hdrs !== undefined ? { headers: hdrs } : {}),
        });
        if (!r.ok) return toolResult("保存失败：" + r.error, true);
        // 新模型检测：配置即快照（与今日桶现有合并，不丢已发现未保存的可用模型）
        core.snapshotProvider(configDir, r.provider, models, { merge: true });
        const klist = core.getProviderKeys(configDir, c, r.provider);
        const keyTxt = klist.length ? " · " + klist.length + " 个 key（" + klist.map((k) => k.name + "=" + core.maskKey(k.key) + (k.rpm ? "/rpm" + k.rpm : "")).join(", ") + "）" : "";
        const catTxt = r.catalogRefreshed
          ? "；保存前有模型在任何源都查不到参数，已强制刷新一次目录" + (r.catalogSlug ? "（命中 slug=" + r.catalogSlug + "）" : "")
          : "；模型元数据已从 models.json/models-store/厂商富字段/models.dev/OpenRouter/LiteLLM 多源反填补全";
        const auxTxt = r.auxUsed && (r.auxUsed.openrouter || r.auxUsed.litellm)
          ? "；兜底源命中：" + [r.auxUsed.openrouter && "OpenRouter", r.auxUsed.litellm && "LiteLLM"].filter(Boolean).join(" + ")
          : "";
        const missTxt = Array.isArray(r.missingParams) && r.missingParams.length
          ? "；⚠️ 以下模型在所有源都查不到参数（已落裸条目，pi 按 128k/16k 硬默认用）：" + r.missingParams.map((m) => m.id).join(", ")
          + "——建议引导用户用 ai-helper 的 model-params-fill skill（上网查权威数据 → 写入 ~/.pi/agent/models-store.json → 回填参数面板）补全"
          : "";
        return toolResult("已保存 provider=" + r.provider + " · " + r.modelCount + " 个模型" + keyTxt + " → " + r.file + "（" + catTxt + auxTxt + missTxt + "；刷新页面模型即生效；多 key 已写入 models.json 供轮转/分 key 检查）");
      }
      case "model_wizard_combo_save": {
        const a = args || {};
        try {
          const { data } = core.loadModelsJson(configDir, c);
          const storeData = core.loadModelsStore(configDir, c).data;
          const undoPatch: any = { [String(a.provider)]: (data.providers || {})[String(a.provider)] ?? null };
          const oldName = String(a.renameFrom || "").trim();
          if (oldName && oldName !== a.provider) undoPatch[oldName] = (data.providers || {})[oldName] ?? null;
          core.stashUndo(configDir, undoPatch);
          // 成员池校验与引擎同源：live /api/models 优先 + 离线快照仅补 models.json 已知 provider
          const runtime = await getRuntimeEntries(null, undefined, new Set(Object.keys(data.providers || {})));
          const r = core.comboSaveProviderData(data, a, storeData, runtime);
          if (!r.ok) return toolResult("保存失败：" + r.error, true);
          core.saveModelsJson(configDir, c, data);
          return toolResult("已保存聚合组=" + r.provider + " · " + r.modelCount + " 个虚拟模型 → " + "(models.json)；刷新页面后新会话即生效（pi-models-combo 引擎自动接管路由）。可在 🧙 面板 ☰ 功能菜单 →「🧩 聚合」管理，或左树选中聚合组查看。");
        } catch (e: any) {
          return toolResult("保存失败：" + ((e && e.message) || e), true);
        }
      }
      case "model_wizard_keys": {
        const provider = String((args && args.provider) || "").trim();
        if (!provider) return toolResult("需要 provider 名", true);
        try { const { byKey } = getIndex(); if (byKey.get(provider)?.authType === "oauth" && (args.action === "set" || args.action === "remove")) return toolResult("「" + provider + "」是订阅登录型 provider，凭据由登录管理，不支持配置多 key。", true); } catch {}
        const action = String((args && args.action) || "list");
        if (action === "list") {
          const keys = core.getProviderKeys(configDir, c, provider);
          if (!keys.length) return toolResult("provider=" + provider + " 还没有配置多 key（当前单 key 可用，或用 model_wizard_keys action=set 配置多 key）");
          const L = ["🔑 " + provider + " 的 keys（" + keys.length + " 个，已打码 · models.json provider.apiKeys）："];
          for (const k of keys) L.push("  · " + k.name + " = " + core.maskKey(k.key) + (k.rpm ? " · rpm=" + k.rpm : ""));
          L.push("→ 用 action=set 整体替换，action=remove name=<key名> 删一个");
          return toolResult(L.join("\n"));
        }
        if (action === "remove") {
          const name = String((args && args.name) || "").trim();
          if (!name) return toolResult("remove 需要 name 参数（要删除的 key 名）", true);
          const cur = core.getProviderKeys(configDir, c, provider);
          const kept = cur.filter((k) => k.name !== name);
          if (kept.length === cur.length) return toolResult("没找到 name=" + name + "（现有：" + (cur.map((k) => k.name).join(", ") || "无") + "）", true);
          const r = core.setProviderKeys(configDir, c, provider, kept);
          return r.ok ? toolResult("已删除 " + provider + " 的 key[" + name + "]" + (kept.length ? "（剩 " + kept.length + " 个）" : "（已无多 key）")) : toolResult("删除失败：" + r.error, true);
        }
        if (action === "set") {
          const keys = Array.isArray(args && args.keys) ? (args.keys as any[]).map((k: any) => typeof k === "string" ? { name: "key", key: k } : k) : [];
          if (!keys.length) return toolResult("set 需要 keys 数组 [{name,key,rpm?}]（空数组=清空多 key）", true);
          const r = core.setProviderKeys(configDir, c, provider, keys);
          if (!r.ok) return toolResult("设置失败：" + r.error, true);
          return toolResult("已设置 " + provider + " 的 " + r.keys.length + " 个 key（" + r.keys.map((k) => k.name + "=" + k.key).join(", ") + "）" + (r.modelsSynced ? " · models.json apiKey 已同步为第一个 key" : ""));
        }
        return toolResult("未知 action=" + action + "（list/set/remove）", true);
      }
      case "model_wizard_delete": {
        const delId = String((args && args.provider) || "");
        try { const { byKey } = getIndex(); if (byKey.get(delId)?.authType === "oauth") return toolResult("「" + delId + "」是订阅登录型 provider，不在 models.json 里，无需删除；如需登出请到 pi-web 模型设置操作。", true); } catch {}
        const r = core.deleteProvider(configDir, c, delId);
        if (!r.ok) return toolResult("删除失败：" + r.error, true);
        core.removeReminderProvider(configDir, r.provider);
        return toolResult("已删除 provider=" + r.provider);
      }
      default: return toolResult("unknown tool: " + name, true);
    }
  } catch (e: any) {
    return toolResult("工具异常：" + String((e && e.message) || e).slice(0, 300), true);
  }
}

export default {
  id: "aiti-model-wizard",
  name: "模型添加向导（目录搜索 / 反向匹配 / 自动探测）",
  icon: "icon.svg",
  client: "dist/aiti-model-wizard-client.mjs",

  ai: {
    manage: true,
    intro: "AI 能帮我添加 AI 提供商/模型（aiti_model_wizard_search/detect/test/save/keys 工具 + 🧙 面板）：搜提供商→填 token→测试→选模型→写入 models.json；可配置多 key（每个带 name/rpm）写进 models.json 的 provider.apiKeys",
    skills: "skills",
    helpers: [
      {
        id: "add-model",
        title: "AI 帮我添加一个模型",
        placeholder: "想加哪个提供商/模型？比如 DeepSeek、智谱 GLM、Kimi、硅基流动…（或贴一个 API 地址）…",
        system: "你是模型添加向导助手（aiti-model-wizard）。目标：陪用户把 provider+models 写进 models.json。流程：\n" +
          "1) 先调 aiti_model_wizard_status 看现状。\n" +
          "2) 用户给出提供商名/中文名 → aiti_model_wizard_search 搜出候选 → 展示 api 地址 / 注册说明 / 领 token 地址 / 已知模型，让用户去注册领 token。\n" +
          "   若候选带 authType:\"oauth\"（订阅登录型，如 qoder/qoder-cn）：无需 token！让用户打开 🧙 面板 ☰ 功能菜单 →「🔐 订阅」完成登录（内嵌 pi-web OAuth 登录流，已登录的也会出现在左树）；可用 GET /oauth-status?ids=… 查登录状态。\n" +
          "   用户贴的是 API 地址（可能漏 /v1 /v2）→ 先 aiti_model_wizard_detect 自动探测 api 类型+真实地址；探测不到再让用户确认地址。\n" +
          "3) 拿到 token → aiti_model_wizard_test 测试（2xx 或 429 都算通过；429 提示稍后重试也算配好了；401/403 提示 key 无效）。\n" +
          "4) 测试通过 → 让用户勾选/输入模型 id（可先拉 /models 列表，用 aiti_model_wizard_test 带 model 测试确认某个模型可用）→ aiti_model_wizard_save 写入（provider=厂商名，api=探测出的类型，baseUrl=真实地址）。\n" +
          "5) 完成后提示刷新页面模型即生效。token 只在本次会话用于测试，保存时写进 models.json；任何读取都不返回完整 token（打码）。",
        outputs: { format: "text" },
        action: { type: "api", method: "POST", path: "/api/extensions/aiti-model-wizard/test", mapping: {} },
      },
    ],
  },

  ui: {
    toolbar: [
      { id: "aiti-model-wizard-open", label: "模型", title: "aiti-model-wizard：添加 AI 提供商/模型（目录搜索 / 反向匹配 / 自动探测）" },
    ],
    dialogs: [{ id: "aiti-model-wizard-dialog", label: "aiti-model-wizard" }],
    banners: [{ id: "aiti-model-wizard-banner", label: "aiti-model-wizard：无模型引导" }],
    sessionStats: [{ id: "aiti-model-wizard-multikey-status", label: "聚合 / 多key运行状态", title: "会话信息下拉内「聚合 / 多 key 代理运行时状态」（薄壳直连 /proxy-status，重 chunk 覆盖升级为完整版）" }],
    // 模型选择器下拉底部动作区：「管理模型」入口（薄壳启动即注册，宿主 ModelSelector 全实例渲染）
    modelSelectorFooter: [{ id: "aiti-model-wizard-manage", label: "管理模型", title: "模型选择器下拉底部「管理模型」入口——打开模型向导" }],
  },

  // 功能管理（aiti-extman 详情面板逐项启停；core 持久化 features.json）
  // 工具级约定：feature.id = "tool.<注入后的工具名>"——core 自动过滤（注入不出现）+ execute 包装（调用即拒绝）。
  // 默认全部禁用：注册太多工具占用模型上下文/token；需要时在扩展管理器逐项开启。
  features: [
    { id: "tool.aiti_model_wizard_status", label: "model_wizard_status · 现状", group: "模型添加向导", description: "模型添加向导：当前已配置 providers（token 打码）+ models.json 路径", default: false },
    { id: "tool.aiti_model_wizard_search", label: "model_wizard_search · 搜索目录", group: "模型添加向导", description: "在目录里搜索 AI 提供商（中文/英文/别名/模型 id）", default: false },
    { id: "tool.aiti_model_wizard_provider", label: "model_wizard_provider · 提供商详情", group: "模型添加向导", description: "查看某个提供商详情（api 地址/注册说明/领 token/已知模型）", default: false },
    { id: "tool.aiti_model_wizard_detect", label: "model_wizard_detect · 端点探测", group: "模型添加向导", description: "给 baseUrl 自动探测 api 接口类型和真实地址（漏 /v1 /v2 自动补）", default: false },
    { id: "tool.aiti_model_wizard_test", label: "model_wizard_test · 测试连接", group: "模型添加向导", description: "测试连接：2xx/429 通过，401/403 无效；有 model 发探针，无 model 拉 /models 验证", default: false },
    { id: "tool.aiti_model_wizard_save", label: "model_wizard_save · 写 models.json", group: "模型添加向导", description: "把 provider + 模型列表写入 models.json（合并去重，token 打码；可选多 key）", default: false },
    { id: "tool.aiti_model_wizard_combo_save", label: "model_wizard_combo_save · 建/改聚合组", group: "模型添加向导", description: "创建或更新模型聚合组（组合模型）：多个真实模型组成虚拟模型，粘性+权重路由", default: false },
    { id: "tool.aiti_model_wizard_keys", label: "model_wizard_keys · 多 key 管理", group: "模型添加向导", description: "管理某 provider 的多个 API key（list/set/remove，含 rpm 限速）", default: false },
    { id: "tool.aiti_model_wizard_delete", label: "model_wizard_delete · 删 provider", group: "模型添加向导", description: "从 models.json 删除一个 provider（其 apiKeys 一并删除）", default: false },
    { id: "agentTools.enabled", type: "boolean", label: "AI 工具（模型向导）", group: "AI", default: false,
      description: "会话内注入 aiti_model_wizard_* 工具（默认关；需要时经 aiti-helper 帮助点（🤖）临时启用，或扩展管理器开启）" },
  ],

  server: {
    startup(ctx) {
      configDir = ctx.configDir || "";
      servicesCtx = (ctx as any)?.services ?? null;
      withCfg();
      // 批量保存服务（aiti-models-import 等 ext 消费；与 HTTP POST /save-batch 同一实现）
      ctx.services?.provide?.("aiti-model-wizard.saveBatch", (input: { saves: any[] }) =>
        saveBatchImpl(ctx, Array.isArray(input?.saves) ? input.saves : []));
      // pi ModelRuntime 快照预热（combo 成员池同源解析：内存 models + models.json；失败静默回退 HTTP /api/models）
      void core.initPiRuntime(cfg).catch(() => {});
      // 运行时 provider 展示缓存预热（后台自取 /api/models 一次——冷启动后用户首次打开向导面板免等秒级冷加载；
      // PORT 未设（如 next dev 不导出 PORT）拿不到端点则放弃，首次 /status 同步路径会自行落缓存）
      void rtProvStartRefresh(null);
      const { index, cache } = getIndex();
      console.log("[aiti-model-wizard] 就绪 · configDir=" + configDir + " · 目录 " + index.length + " 家（models.dev 缓存=" + (cache.from || "none") + (cache.ageMs != null ? " · " + Math.round(cache.ageMs / 3600000) + "h" : "") + (cache.stale ? " · stale" : "") + "）· models.json=" + (cfg.modelsPath || "~/.pi/agent/models.json"));
      startReminderScan();
      // models.dev 目录新鲜度：无缓存/stale（超 TTL 或只有内嵌快照）→ 后台拉一次（不阻塞启动，失败静默）
      const c0 = withCfg();
      if (c0.catalog && c0.catalog.autoRefresh !== false) {
        void core.ensureCatalog(configDir, c0).then((r: any) => {
          if (r.refreshed) console.log("[aiti-model-wizard] models.dev 目录已刷新（启动 TTL 检查 · from=" + r.from + "）");
        }).catch(() => {});
      }
    },
    shutdown() {
      stopReminderScan();
    },

    async api(req, ctx) {
      const p = ctx.path || [];
      if (!configDir) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      const c = withCfg();
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      // 订阅登录型 provider 守护：它们由扩展注册 + auth.json 登录凭据驱动，
      // 写入 models.json 会与扩展注册同名冲突（覆盖 api/baseUrl/叠加假 key）→ 一律拒绝
      const isOauthManaged = isOauthProvider;

      // GET /oauth-status?ids=qoder,qoder-cn → 订阅登录型 provider 的登录状态（读 ~/.pi/agent/auth.json，不回传凭证内容）
      if (p[0] === "oauth-status" && req.method === "GET") {
        const ids = (ctx.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        let auth: any = {};
        const authPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");
        try { if (existsSync(authPath)) auth = JSON.parse(readFileSync(authPath, "utf8")) || {}; } catch {}
        const status: Record<string, { loggedIn: boolean; type?: string }> = {};
        for (const id of ids) {
          const v = auth[id];
          status[id] = { loggedIn: !!(v && (v.access || v.type === "oauth" || v.type === "api_key")), type: v?.type };
        }
        return json({ ok: true, status });
      }
      // GET /oauth-info?id=X → 订阅登录型详情：登录态 + 账号 + credits 余量 + 模型清单
      // （仅 qoder/qoder-cn 支持远程富信息，凭据 access 为 dt-token 直连官方 openapi；其它只返回登录态与目录模型）
      if (p[0] === "oauth-info" && req.method === "GET") {
        const id = String(ctx.searchParams.get("id") || "").trim();
        if (!id) return json({ ok: false, error: "需要 id" }, 400);
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        let cred: any = null;
        try {
          const authPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");
          if (existsSync(authPath)) cred = (JSON.parse(readFileSync(authPath, "utf8")) || {})[id] || null;
        } catch {}
        const loggedIn = !!(cred && (cred.access || cred.type === "oauth"));
        const info: any = { loggedIn, type: cred?.type || null };
        const { byKey } = getIndex();
        const catalogModels = (byKey.get(id)?.models || []).map((m: any) => ({ id: m.id, name: m.name || m.id }));
        // 模型清单优先取「运行时注册」那份（/api/models = pi ModelRuntime 实际可见 → 选择器里真能选到）。
        // 目录（china-catalog）只是静态猜测：厂商真实返回的 id 常与它不符（如 Qoder 网关返回 dmodel/gm51model
        // 这类别名，目录却写 deepseek-v4-pro/glm-5.2），拿目录当「可用模型」会导致 ①刷新永远不变
        // ②选择器里找不到这些 id。故运行时非空即覆盖目录，并回传 modelsSource 供 UI 标注来源。
        let models = catalogModels;
        let modelsSource: "runtime" | "catalog" = "catalog";
        const related: Array<{ provider: string; count: number; models: Array<{ id: string; name: string }> }> = [];
        try {
          const cwdHint = String(ctx.searchParams.get("cwd") || "") || undefined;
          const modelsData = await fetchModelsData(req, cwdHint);
          const live = (modelsData?.modelList || []).filter((m: any) => m && m.id && m.provider === id);
          if (live.length) {
            models = live.map((m: any) => ({ id: m.id, name: m.name || m.id }));
            modelsSource = "runtime";
            // 同族兄弟 provider（qoder-cn → qoder / qoder-local）：同一订阅账号的模型可能被拆到不同
            // provider id 下注册，只报本 id 会让用户以为「模型没刷出来」，故一并列出供参考。
            const root = id.split("-")[0];
            const seen = new Map<string, Array<{ id: string; name: string }>>();
            for (const m of modelsData?.modelList || []) {
              if (!m || !m.id || !m.provider || m.provider === id) continue;
              if (m.provider !== root && !String(m.provider).startsWith(root + "-")) continue;
              if (!seen.has(m.provider)) seen.set(m.provider, []);
              seen.get(m.provider)!.push({ id: m.id, name: m.name || m.id });
            }
            for (const [provider, ms] of seen) related.push({ provider, count: ms.length, models: ms });
          }
        } catch { /* 运行时不可达 → 退回目录清单 */ }
        if (loggedIn && cred?.access && /^qoder(-cn)?$/.test(id)) {
          const base = id === "qoder-cn" ? "https://openapi.qoder.com.cn" : "https://openapi.qoder.sh";
          const H = { Authorization: `Bearer ${cred.access}` } as any;
          const j = async (u: string) => { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(6000) }); return r.json().catch(() => null); };
          const [quota, user] = await Promise.all([
            j(base + "/api/v2/quota/usage"),
            j(base + "/api/v1/userinfo"),
          ]);
          if (quota?.userQuota) info.credits = { remaining: quota.userQuota.remaining, total: quota.userQuota.total, used: quota.userQuota.used, unit: quota.userQuota.unit || "credits", expiresAt: quota.expiresAt ?? null, exceeded: !!quota.isQuotaExceeded };
          else if (quota) info.quotaError = String(quota.error || quota.message || JSON.stringify(quota).slice(0, 120));
          // 额外包（addOnQuota 加量包）与专属资源包（dedicatedResourcePackages）——Qoder 系特有分桶
          if (quota?.addOnQuota) info.addOn = { remaining: quota.addOnQuota.remaining, total: quota.addOnQuota.total, used: quota.addOnQuota.used, unit: quota.addOnQuota.unit || "credits" };
          if (Array.isArray(quota?.dedicatedResourcePackages)) {
            const pkgs = quota.dedicatedResourcePackages
              .filter((p: any) => p && p.available !== false)
              .map((p: any) => {
                const label = (Array.isArray(p.displayLabels) ? p.displayLabels.find((l: any) => l && l.dimension === "title") : null);
                const txt = label?.valueI18n?.["zh-CN"] || label?.valueI18n?.["en-US"] || label?.value || p.name;
                return { name: txt, remaining: p.remaining, total: p.total, unit: p.unit || "credits", expiresAt: p.expiresAt ?? null };
              })
              .filter((p: any) => p.name && typeof p.remaining === "number");
            if (pkgs.length) info.packages = pkgs;
          }
          if (user && !user.error) info.account = { name: user.name || user.username || "", email: user.email || "", plan: user.plan_tier_name || "" };
        }
        return json({ ok: true, id, info, models, modelsSource, related });
      }
      // GET /affiliate → 厂商推广链接（有 link 才返回；无配置返回空）
      if (p[0] === "affiliate" && req.method === "GET") {
        // 在线加载：中心 URL（aiti.pw/models/config.json）→ 本地缓存+TTL；失败回退本地 affiliate
        const items = await core.loadAffiliate(configDir, c);
        return json({ ok: true, count: Object.keys(items).length, items });
      }
      // GET /free-models → 免费模型列表（中心 URL 的 freeModels 节；失败回退本地 config.freeModels）+ 每项 installed 安装状态。
      // 安装状态：进程内 /api/plugins 的 packageName 集合（名字一样即算已装——本地路径开发版与 npm 版同包名）。
      // 同进程自调与 fetchRuntimeProviders 同模式（生产长期验证）；拿不到 → installed 全 false，不做 settings 直读回退
      //（回退拿不到 packageName 只会给出错误漏判；若自调失败 pi-web 本身已不正常，徽标无意义）。
      if (p[0] === "free-models" && req.method === "GET") {
        const items = await core.loadFreeModels(configDir, c);
        let installed: Record<string, boolean> = {};
        try {
          const port = String(process.env.PORT || "");
          const envBasePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
          const host = port ? `127.0.0.1:${port}` : (req.headers.get("host") || "127.0.0.1:3001");
          const pr = await fetch(`http://${host}${envBasePath}/api/plugins`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd: process.cwd() }),
            signal: AbortSignal.timeout(8000),
          });
          if (pr.ok) {
            const pd: any = await pr.json().catch(() => null);
            const names = new Set<string>();
            for (const pkg of (pd && pd.packages) || []) {
              if (pkg.packageName) names.add(String(pkg.packageName));
              else { const n = core.freeNpmName(pkg.source); if (n) names.add(n); }
            }
            installed = core.matchInstalledFree(items, names);
          }
        } catch { /* 拿不到 → installed 全 false */ }
        const out: Record<string, any> = {};
        for (const [id, it] of Object.entries(items)) out[id] = { ...(it as any), installed: !!installed[id] };
        return json({ ok: true, count: Object.keys(out).length, items: out });
      }
      // POST /free-install {id, action?} → 安装/更新/卸载免费包（转发 pi-web POST /api/plugins，scope=global）
      // cwd 用 pi-web 程序目录（process.cwd()，必在 allowedFileRoots 内）；scope=global 不需要 project trust。
      if (p[0] === "free-install" && req.method === "POST") {
        const b: any = body || {};
        const items = await core.loadFreeModels(configDir, c);
        const it = items[String(b.id || "")];
        if (!it || !it.npm) return json({ ok: false, error: "未知免费包 id：" + String(b.id) }, 400);
        const action = ["install", "remove", "update"].includes(String(b.action)) ? String(b.action) : "install";
        try {
          // 进程内直达（PORT env + basePath）优先，不经 nginx（回环经反代时 body 字段丢失，实证 cwd required）
          const port = String(process.env.PORT || "");
          const envBasePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
          const host = port ? `127.0.0.1:${port}` : (req.headers.get("host") || "127.0.0.1:3001");
          const r = await fetch(`http://${host}${envBasePath}/api/plugins`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, source: it.npm, scope: "global", cwd: process.cwd() }),
            signal: AbortSignal.timeout(180000), // npm 安装走网络，给足超时
          });
          const d: any = await r.json().catch(() => ({}));
          if (!r.ok || d.error) return json({ ok: false, error: d.error || `HTTP ${r.status}` }, 502);
          return json({ ok: true, action, npm: it.npm, message: action === "install" ? "已安装，新会话生效" : action === "remove" ? "已卸载，新会话起不再加载" : "已更新，新会话生效" });
        } catch (err: any) {
          return json({ ok: false, error: "安装转发失败：" + (err?.message || String(err)) }, 502);
        }
      }
      // GET /recommend → 推荐提供商卡片（国内外主要几家；多形态 provider 带 plans 小选项，如 ark 按量/Coding 套餐）
      if (p[0] === "recommend" && req.method === "GET") {
        const { byKey } = getIndex();
        const RECOMMEND_PLANS = [
          { id: "ark", plans: [{ id: "ark", label: "按量" }, { id: "ark-coding-plan", label: "Coding 套餐" }, { id: "ark-agent", label: "Agent 套餐" }] },
          { id: "zhipu", plans: [{ id: "zhipu", label: "按量" }, { id: "zhipu-coding-plan", label: "Coding Plan" }] },
          { id: "zai", plans: [{ id: "zai", label: "按量" }, { id: "zai-coding-plan", label: "Coding Plan" }] },
          { id: "moonshot", plans: [{ id: "moonshot", label: "按量" }, { id: "kimi-for-coding", label: "Kimi For Coding" }] },
          { id: "alibaba", plans: [{ id: "alibaba", label: "按量" }, { id: "alibaba-coding-plan", label: "Coding Plan" }] },
          { id: "tencent-hunyuan", plans: [{ id: "tencent-hunyuan", label: "按量" }, { id: "tencent-coding-plan", label: "Coding Plan" }] },
          { id: "deepseek" }, { id: "baidu-qianfan" }, { id: "siliconflow" }, { id: "minimax" }, { id: "stepfun" }, { id: "openrouter" },
        ];
        const cards = RECOMMEND_PLANS.map((c) => {
          const main = byKey.get(c.id);
          if (!main) return null;
          const plans = (c.plans || [])
            .map((pl) => ({ id: pl.id, label: pl.label, provider: byKey.get(pl.id) }))
            .filter((x) => x.provider)
            .map((x) => ({ id: x.id, label: x.label, provider: providerFull(x.provider) }));
          return { id: c.id, main: providerFull(main), plans: plans.length ? plans : [{ id: c.id, label: "接入", provider: providerFull(main) }] };
        }).filter(Boolean);
        return json({ ok: true, count: cards.length, cards });
      }
      // GET /catalog → 目录总览
      if (p[0] === "catalog" && req.method === "GET") {
        const { index, cache } = getIndex();
        return json({ ok: true, count: index.length, providers: index.map(providerCard), cache: { from: cache.from, ageMs: cache.ageMs, stale: cache.stale, ttlHours: c.catalog.ttlHours }, modelsJson: core.modelsJsonPath(configDir, c) });
      }
      // POST /refresh-catalog → justget 重新下载（官方+镜像竞速；ensureCatalog single-flight 去重）
      if (p[0] === "refresh-catalog" && req.method === "POST") {
        const r = await core.ensureCatalog(configDir, c, { force: true });
        const d = r.result || {};
        return r.ok ? json({ ok: true, refreshed: r.refreshed, source: d.source, bytes: d.bytes, providers: d.providers, elapsedMs: d.elapsedMs, justget: !!d.justget }) : json({ ok: false, error: r.error || d.error || "下载失败" }, 500);
      }
      // GET /search?q= → 正向文本匹配 + URL/域名反向匹配合并（用户贴 API 地址也能搜到）
      if (p[0] === "search" && req.method === "GET") {
        const q = ctx.searchParams.get("q") || "";
        const { index, byKey } = getIndex();
        const text = core.searchProviders(index, q);   // 正向（带 score）
        const urls = core.extractUrls(q);
        const tryUrls = urls.length ? urls : (/\w+\.[a-z]{2,}/i.test(q) && q.split(/\s+/).length === 1 ? [q] : []);
        const revMap = new Map(); // id → {score, matchedBaseUrl, inputUrl}
        const configuredBaseUrls = getConfiguredBaseUrls();
        for (const u of tryUrls) {
          for (const c of core.reverseMatch(index, u, configuredBaseUrls)) {
            const prev = revMap.get(c.id);
            if (!prev || c.score > prev.score) revMap.set(c.id, { score: c.score, matchedBaseUrl: c.matchedBaseUrl, inputUrl: u });
          }
        }
        const seen = new Set();
        const merged = [];
        for (const r of text) {
          seen.add(r.id);
          const rv = revMap.get(r.id);
          merged.push({ ...providerFull(r), matched: rv ? "text+reverse" : "text", reverseScore: rv ? rv.score : null, matchedBaseUrl: rv ? rv.matchedBaseUrl : null, reverseInputUrl: rv ? rv.inputUrl : null });
        }
        for (const [id, rv] of revMap) {
          if (seen.has(id)) continue;
          const p = byKey.get(id);
          if (p) merged.push({ ...providerFull(p), matched: "reverse", reverseScore: rv.score, matchedBaseUrl: rv.matchedBaseUrl, reverseInputUrl: rv.inputUrl });
        }
        return json({ ok: true, q, count: merged.length, results: merged });
      }
      // GET /provider?id=
      if (p[0] === "provider" && req.method === "GET") {
        const { byKey } = getIndex();
        const p2 = byKey.get(ctx.searchParams.get("id") || "");
        return p2 ? json({ ok: true, provider: providerFull(p2) }) : json({ ok: false, error: "not found" }, 404);
      }
      // POST /reverse {baseUrl?|text?, apiKey?} → 自由文本/代码/单个 URL 均接受；
      // 穷尽提取所有 URL，逐个【反向匹配 + 自动探测】并行（同一 provider 多套餐/版本不搞混，探测结果权威）
      if (p[0] === "reverse" && req.method === "POST") {
        const raw = String((body && (body.baseUrl || body.text)) || "").trim();
        if (!raw) return json({ ok: false, error: "需要 baseUrl 或 text" }, 400);
        const urls = core.extractUrls(raw);
        const list = urls.length ? urls : [raw]; // 没提取到 URL → 整体当地址试
        const { index } = getIndex();
        const apiKey = (body && body.apiKey) || "";
        // 已配置 provider 同域名端点有 key 时自动带上探测（无 key 时网关一律 401，无法区分真实路径；
        // 带 key + 真实模型才能确认 chat/completions 是否要版本段，如火山 coding api/plan → api/plan/v3）
        let confKey = "";
        let confModel = "";
        let confBase = "";
        try {
          const mj = JSON.parse(readFileSync(core.expandPath(cfg.modelsPath || "~/.pi/agent/models.json"), "utf8"));
          const conf = (mj.providers || {});
          const hostOf = (u) => { try { return new URL(String(u).trim()).host; } catch (e) { return "" }; };
          const hosts = list.map(hostOf).filter(Boolean);
          if (hosts.length) {
            // 同域名可能多个套餐/端点，key 不互通（如火山 api/plan 与 api/coding）——
            // 优先精确 baseUrl 命中（剥尾版本段后相等），再退而同 host 任一端点。
            let same = Object.entries(conf).find(([, p]) => p && p.baseUrl && list.some((u) => core.normalizeBaseUrl(p.baseUrl) === core.normalizeBaseUrl(u)));
            if (!same) same = Object.entries(conf).find(([, p]) => p && p.baseUrl && hosts.includes(hostOf(p.baseUrl)));
            if (same) { const p2 = same[1]; confKey = p2.apiKey || (p2.apiKeyEnv ? process.env[p2.apiKeyEnv] : "") || ""; confBase = String(p2.baseUrl || "").replace(/\/+$/, ""); const ms = Array.isArray(p2.models) ? p2.models : []; if (ms.length) confModel = String((ms[0] && (ms[0].id || ms[0].model)) || ms[0] || ""); }
          }
        } catch (e) {}
        const configuredBaseUrls = getConfiguredBaseUrls();
        const probeKey = apiKey || confKey || "";
        const xh = sanitizeHeaders((body && body.headers)); // 自定义请求头（2026-09-17）
        const results = await Promise.all(list.map(async (u) => {
          const { candidates, detect } = await core.reverseDetect(index, u, probeKey, { probeModel: confModel || undefined, preferBase: confBase || undefined, configuredBaseUrls, extraHeaders: xh });
          const full = await detectFull(detect, index, u, probeKey, xh);
          return {
            url: u,
            normalized: core.normalizeBaseUrl(u),
            candidates: candidates.map((x) => ({ ...providerFull(x), score: x.score, matchedBaseUrl: x.matchedBaseUrl })),
            detect: full,
            usedKey: !!probeKey,
            probeModel: confModel || "",
          };
        }));
        return json({ ok: true, text: raw, extracted: list.length, urls: results });
      }
      // POST /detect {baseUrl, apiKey?} → 自动探测 api 类型 + 真实地址（漏 /v1 /v2 也能补）
      // 命中后带 key 会顺手拉 /models（品牌/模型查询），并反查目录给品牌 + 建议完整地址
      if (p[0] === "detect" && req.method === "POST") {
        const baseUrl = String((body && body.baseUrl) || "").trim();
        if (!baseUrl) return json({ ok: false, error: "需要 baseUrl" }, 400);
        const { index } = getIndex();
        const xh = sanitizeHeaders((body && body.headers)); // 自定义请求头（2026-09-17）
        const r = await core.detectApi(baseUrl, (body && body.apiKey) || "", { timeoutMs: 10000, extraHeaders: xh });
        const full = await detectFull(r, index, baseUrl, (body && body.apiKey) || "", xh);
        return json({ ok: full.ok, ...full });
      }
      // POST /test {baseUrl, api, apiKey?, model?} · 多 key：{provider, allKeys?/keyName?} 测已存 keys；{keys:[{name,key}]} 直接测传入的
      // 逐个串行测（并发会触发上游并发限流如 Throttling.Concurrency → 假失败）；2xx/429 算通过
      if (p[0] === "test" && req.method === "POST") {
        const b = body || {};
        if (!b.baseUrl || !b.api) return json({ ok: false, error: "需要 baseUrl + api" }, 400);
        const tMs = (c.test && c.test.timeoutMs) || 12000;
        // 生效请求头（审核修正）：provider 已存头 + 草稿合并，掩码行用已存原值（不会把掩码发出）
        const xh = effectiveHeaders(b, b.provider ? String(b.provider) : undefined);
        // 单 key 且未传 apiKey：用已存凭据兜底（详情健康条「重测」只传 provider，不必回传 key）
        let bApiKey = String(b.apiKey || "");
        if (!bApiKey && b.provider && !b.keys && !b.allKeys && !b.keyName) {
          try {
            const { data: mj } = core.loadModelsJson(configDir, c);
            const cred = core.pickProviderCredential(mj.providers && mj.providers[String(b.provider)]);
            if (cred) bApiKey = cred.key;
          } catch { /* 读不到就走原逻辑（空 key 由上游报 401） */ }
        }
        const testOne = (k: any) => core.testConnection({ baseUrl: b.baseUrl, api: b.api, apiKey: k.key, model: b.model }, { timeoutMs: tMs, extraHeaders: xh })
          .then((r: any) => ({ name: k.name || "key", masked: core.maskKey(k.key), pass: !!r.pass, rateLimited: !!r.rateLimited, status: r.status ?? null, latencyMs: r.latencyMs ?? null, detail: r.detail || "" }));
        let targets: any[] | null = null;
        let src = "";
        if (Array.isArray(b.keys) && b.keys.length) { targets = b.keys.map((k: any) => typeof k === "string" ? { name: "key", key: k } : k).filter((k: any) => k && k.key); src = "传入 keys"; }
        else if (b.allKeys || b.keyName) {
          if (!b.provider) return json({ ok: false, error: "allKeys/keyName 需要 provider" }, 400);
          const all = core.getProviderKeys(configDir, c, String(b.provider));
          targets = b.allKeys ? all.slice() : all.filter((k: any) => k.name === b.keyName);
          src = "provider 已存 key";
        }
        // 测试结论留存（P1-A）：指定 provider 时把结论写 last-test.json（key 打码；树上徽标/详情健康条用）
        const persist = (row: any) => {
          if (!b.provider) return;
          try { core.recordLastTest(configDir, String(b.provider), row); } catch { /* 留存失败不影响测试响应 */ }
        };
        if (targets) {
          if (!targets.length) return json({ ok: false, error: "没有可测的 key：" + (b.provider ? "provider " + b.provider + " " : "") + (b.keyName ? "不存在名为 " + b.keyName + " 的 key" : "（先在多 key 区添加）") });
          const results: any[] = [];
          for (const k of targets) results.push(await testOne(k));   // 串行：避免并发限流假失败
          const passCount = results.filter((x) => x.pass).length;
          persist({ pass: passCount === results.length, ...(passCount > 0 && passCount < results.length ? { partial: true } : {}), rateLimited: results.some((x) => x.pass && x.rateLimited), status: results.length === 1 ? results[0].status : null, latencyMs: results.length === 1 ? results[0].latencyMs : null, detail: "分 key " + passCount + "/" + results.length + " 可用", keyName: results.length === 1 ? results[0].name : "全部(" + results.length + "把)", masked: results.length === 1 ? results[0].masked : null, model: b.model || null });
          return json({ ok: true, multiKey: true, total: results.length, passCount, pass: passCount === results.length,
            detail: src + "分 key 测试：" + passCount + "/" + results.length + " 可用", results });
        }
        const r = await core.testConnection({ baseUrl: b.baseUrl, api: b.api, apiKey: bApiKey, model: b.model }, { timeoutMs: tMs, extraHeaders: xh });
        persist({ pass: !!r.pass, rateLimited: !!r.rateLimited, status: r.status ?? null, latencyMs: r.latencyMs ?? null, detail: r.detail || "", keyName: "key", masked: core.maskKey(bApiKey), model: b.model || null });
        return json({ ok: r.pass, pass: r.pass, ...r });
      }
      // GET /last-test → 各 provider 最近一次向导测试结论（key 打码；树上徽标/详情健康条数据源）
      if (p[0] === "last-test" && req.method === "GET") {
        const lt = core.loadLastTest(configDir);
        return json({ ok: true, ts: lt.ts, providers: lt.providers });
      }
      // POST /checkup → 一键体检：逐已配置 provider 串行一个探针（跳过聚合组/禁用/无凭据），
      // 结论写 last-test.json。手动触发非轮询；globalThis 单飞防双击并发。
      if (p[0] === "checkup" && req.method === "POST") {
        const gk = "aitiModelWizardCheckup:" + configDir;
        const g = globalThis as any;
        if (g[gk]) return json({ ok: false, error: "体检进行中，请稍候" }, 409);
        g[gk] = true;
        try {
          const r = await core.runCheckup(configDir, c, { timeoutMs: (c.test && c.test.timeoutMs) || 12000 });
          return json(r);
        } catch (e: any) {
          return json({ ok: false, error: "体检失败: " + ((e && e.message) || e) }, 500);
        } finally { delete g[gk]; }
      }
      // POST /oauth-logout {provider} → 订阅登录型登出：转发同进程宿主 /api/auth/logout/<pid>
      // （宿主清 auth.json 凭据 + invalidateModelsCache；凭据链不经过本扩展）。幂等：未登录时宿主 400 原样回传。
      if (p[0] === "oauth-logout" && req.method === "POST") {
        const provider = String((body && body.provider) || "").trim();
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        try {
          const port = String(process.env.PORT || "");
          const envBasePath = String(process.env.PI_WEB_BASE_PATH || "").replace(/\/+$/, "");
          const host = port ? `127.0.0.1:${port}` : (req.headers.get("host") || "127.0.0.1:3001");
          const r = await fetch(`http://${host}${envBasePath}/api/auth/logout/${encodeURIComponent(provider)}`, { method: "POST", signal: AbortSignal.timeout(10000) });
          const d: any = await r.json().catch(() => ({}));
          if (!r.ok) return json({ ok: false, error: d.error || `HTTP ${r.status}` }, 502);
          try { console.log("[aiti-model-wizard] 订阅登出：" + provider); } catch {}
          return json({ ok: true, provider });
        } catch (err: any) {
          return json({ ok: false, error: "登出转发失败：" + (err?.message || String(err)) }, 502);
        }
      }
      // GET /usage?provider=X&force=1 → 余额/配额：消费 aiti-provider-usage 服务（软依赖；
      // 缺席 available:false，UI 降级隐藏余额段，不自行拉上游——TTL/并发归 provider-usage 管）
      if (p[0] === "usage" && req.method === "GET") {
        const provider = String(ctx.searchParams.get("provider") || "").trim();
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        const svc = servicesCtx?.get?.("aiti-provider-usage.overview") ?? null;
        if (!svc || typeof svc.overview !== "function") return json({ ok: true, available: false, reason: "aiti-provider-usage 未安装或未启用" });
        try {
          const ov = await svc.overview(ctx.searchParams.get("force") === "1");
          const entry = (ov && Array.isArray(ov.providers) ? ov.providers : []).find((x: any) => x && x.providerId === provider) || null;
          return json({ ok: true, available: true, capturedAt: (ov && ov.capturedAt) || null, entry });
        } catch (e: any) {
          return json({ ok: true, available: true, error: "余额查询失败：" + ((e && e.message) || e) });
        }
      }
      // POST /discover {baseUrl, api, apiKey?}
      if (p[0] === "discover" && req.method === "POST") {
        const b = body || {};
        if (!b.baseUrl || !b.api) return json({ ok: false, error: "需要 baseUrl + api" }, 400);
        const r = await core.discoverModels({ baseUrl: b.baseUrl, api: b.api, apiKey: b.apiKey }, { timeoutMs: 12000, extraHeaders: sanitizeHeaders(b.headers) });
        if (!r.ok) return json({ ok: false, error: r.error }, 502);
        refluxAux(String(b.baseUrl || ""), (r as any).raw);
        const { raw: _raw, ...rest } = r as any; // raw（全量原始数据）只供回流，不进响应（数百 KB）
        return json({ ok: true, ...rest });
      }
      // POST /discoverStored {provider, apiKey?} → 编辑流刷新可选模型：用存储 key（或刚填的新 key）拉 /models
      if (p[0] === "discoverStored" && req.method === "POST") {
        const provider = String((body && body.provider) || "").trim();
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers && data.providers[provider];
          if (!prov) return json({ ok: false, error: "provider 不存在: " + provider }, 404);
          // 多 key 感知：刚填的新 key → 单 apiKey → 已存 apiKeys 逐把轮试（任一把拉到即用）→ 环境变量兑底
          const supplied = String((body && body.apiKey) || "").trim();
          const storedList: string[] = Array.isArray(prov.apiKeys) ? prov.apiKeys.map((k: any) => String((k && k.key) || "")).filter(Boolean) : [];
          const cands: string[] = [...new Set([supplied, String(prov.apiKey || ""), ...storedList])].filter(Boolean);
          if (prov.apiKeyEnv && process.env[prov.apiKeyEnv]) cands.push(String(process.env[prov.apiKeyEnv]));
          if (!cands.length) return json({ ok: false, error: "该 provider 没有可用的 key（未存储且未填写），无法拉取模型列表" }, 400);
          // 生效请求头（审核修正）：已存 headers + 未保存草稿（body.headers 覆盖、掩码行回存）
          const xh = effectiveHeaders(body, provider);
          let r: any = null;
          for (const key of cands) {
            r = await core.discoverModels({ baseUrl: prov.baseUrl, api: prov.api, apiKey: key }, { timeoutMs: 12000, extraHeaders: xh });
            if (r.ok) break;
          }
          if (!r || !r.ok) return json({ ok: false, error: (r && r.error) || "全部 " + cands.length + " 把凭据均未拉到模型列表" }, 502);
          // 新模型检测：刷新即快照今日可用列表；返回相对前日基线的"新增"（编辑流预勾选用）
          core.snapshotProvider(configDir, provider, r.models.map((m: any) => m.id));
          refluxAux(String(prov.baseUrl || ""), (r as any).raw); // 编辑流「刷新可选模型」同源回流：拉到的实时目录即刻可反填参数
          const { raw: _raw2, ...rest } = r; // raw 只供回流，不进响应（数百 KB）
          const newModels = core.newModelsForProvider(configDir, c, provider);
          return json({ ok: true, ...rest, newModels, newCount: newModels.length });
        } catch (e: any) {
          return json({ ok: false, error: "读取配置失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // GET /status → 已配置 providers（token 打码）+ 运行时注册 provider（只读展示）
      // ?light=1 → 跳过 runtime 合并：首载空模型判定只需已配置段（服务端自 fetch
      // /api/models 是本端点 ~350ms 的主因，向导面板打开才需要完整合并）。
      if (p[0] === "status" && req.method === "GET") {
        const st = core.providersStatus(configDir, c);
        if (ctx.searchParams.get("light") === "1") return json({ ok: true, ...st });
        // 运行时注册的 provider（如 pi-freeflow 的 freeflow）：/api/models 可见但不在 models.json/auth.json，
        // 合并进「模型列表」只读展示，保证模型列表补全不缺失这些 provider/模型。
        const cwdHint = String(ctx.searchParams.get("cwd") || "").trim();
        const rt = await fetchRuntimeProviders(req, new Set((st.providers || []).map((x: any) => x.provider)), cwdHint || undefined);
        const rtIds = Object.keys(rt).sort();
        for (const pid of rtIds) {
          const rp = rt[pid];
          const ids = (rp.models || []).map((m: any) => m.id).filter(Boolean);
          st.providers.push({
            provider: pid,
            combo: false,
            runtime: true,
            api: rp.api || "openai-completions",
            baseUrl: rp.baseUrl || "",
            apiKeyMasked: "",
            hasKey: false,
            modelCount: ids.length,
            models: ids,
            keys: [],
            keyCount: 0,
          });
        }
        return json({ ok: true, ...st });
      }
      // GET /combos → 模型聚合页数据：现有组合 provider 列表 + 可选成员池
      // 成员池合并内存 models（pi ModelRuntime）+ models.json + store（同 aiti-model-check /status 源；
      // 运行时注册 provider 如 freeflow 由 core 合成进池——与 pi-models-combo 引擎 flattenComboSlots 同构）
      if (p[0] === "combos" && req.method === "GET") {
        const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
        const storeData = core.loadModelsStore(configDir, c).data;
        const cwdHint = String(ctx.searchParams.get("cwd") || "").trim();
        const runtime = await getRuntimeEntries(req, cwdHint || undefined, new Set(Object.keys(data.providers || {})));
        return json({ ok: true, ...core.comboPageData(data, storeData, runtime) });
      }
      // POST /combo-save → 写 combo:true 虚拟 provider（纯变换在 core.comboSaveProviderData；硬校验失败整体拒绝）
      if (p[0] === "combo-save" && req.method === "POST") {
        const b = body || {};
        if (isOauthManaged(String(b.provider || ""))) return json({ ok: false, error: "「" + b.provider + "」是订阅登录型 provider，不能覆盖为聚合组" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const storeData = core.loadModelsStore(configDir, c).data;
          const undoPatch: any = { [String(b.provider)]: (data.providers && data.providers[b.provider]) ?? null };
          const oldName = String(b.renameFrom || "").trim();
          if (oldName && oldName !== b.provider) undoPatch[oldName] = (data.providers && data.providers[oldName]) ?? null;
          core.stashUndo(configDir, undoPatch);
          // 成员池校验与引擎同源：live /api/models 优先 + 离线快照仅补 models.json 已知 provider
          const runtime = await getRuntimeEntries(req, undefined, new Set(Object.keys(data.providers || {})));
          const r = core.comboSaveProviderData(data, b, storeData, runtime);
          if (!r.ok) return json(r, 400);
          await ctx.core.writeModelsConfig(data);
          // 保存后立即刷新运行中代理的槽位配置（pi-models-combo 原地更新，不重启 HTTP）
          refreshProxiesViaCombo(r.provider);
          return json({ ok: true, provider: r.provider, modelCount: r.modelCount, file: "(pi-web /api/models-config)", undoable: true });
        } catch (e: any) {
          return json({ ok: false, error: "写 models.json 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // GET /modelParams?provider=X → 查看该 provider 已配置模型的完整参数（只读）
      // &refresh=1 → 有模型在任何源都查不到参数时强制刷新一次 models.dev 再查
      if (p[0] === "modelParams" && req.method === "GET") {
        const provider = String(ctx.searchParams.get("provider") || "").trim();
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        const r = await core.modelParams(configDir, c, provider, { forceRefresh: ctx.searchParams.get("refresh") === "1", id: ctx.searchParams.get("id") || "" });
        if (!r.ok) return json(r, 404);
        return json(r);
      }
      // POST /save {provider, baseUrl, api, apiKey?, keepKey?, keys?: [{name,key,rpm?}], models[], replaceModels?}
      // 不直接写文件——经 pi-web core 接口（readModelsConfig→变换→writeModelsConfig，含缓存失效）；
      // 多 keys 由 upsertProviderData 完整写进 models.json 的 provider.apiKeys（pi 忽略、不上行）
      if (p[0] === "save" && req.method === "POST") {
        const b = body || {};
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const one = await applySaveInto(data, b, c);
          if (!one.ok) return json({ ok: false, error: one.error }, one.status);
          // 一级撤销快照：记录受影响 provider 的旧条目（含 renameFrom 旧名；#3 undo）
          core.stashUndo(configDir, one.undoPatch);
          await ctx.core.writeModelsConfig(one.r.data);
          // 保存后立即刷新运行中代理（改 key / 模型 / 元数据都要生效）
          refreshProxiesViaCombo(one.r.provider);
          // 新模型检测：配置即快照（与今日桶现有合并，不丢已发现未保存的可用模型）
          core.snapshotProvider(configDir, String(b.provider), one.models, { merge: true });
          if (one.md.refreshed) console.log("[aiti-model-wizard] save 触发 models.dev 强制刷新（未知模型：" + (one.md.slug || b.provider) + "）");
          // 多 keys → 从 r.data 读回打码列表（已随 provider 写进 models.json）
          let keyInfo: any = null;
          if (one.keys !== undefined) {
            const klist = Array.isArray(one.r.data.providers[b.provider].apiKeys)
              ? core.dedupKeyNames(one.r.data.providers[b.provider].apiKeys.map(core.normalizeKeyEntry).filter(Boolean))
              : [];
            keyInfo = { keys: klist.map(core.maskKeyEntry), keyCount: klist.length, error: "" };
          }
          return json({ ok: true, provider: one.r.provider, modelCount: one.r.modelCount, file: "(pi-web /api/models-config)", keys: keyInfo, fills: one.r.fills || [], missingParams: one.r.missingParams || [], undoable: true });
        } catch (e: any) {
          return json({ ok: false, error: "写 models.json 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // GET /export —— 脱敏导出（P2-A / G6）：白名单字段拷贝（apiKey/apiKeys 整字段剔除——
      // 防彩虹表反推，绝不打码保留；headers 只留头名值置空）。换机/团队分发场景，
      // 配合 POST /import 差异预览 + /save-batch（自带 undo）落地。
      if (p[0] === "export" && req.method === "GET") {
        const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
        const out: any = {
          aitiModelWizardExport: 1,
          exportedAt: new Date().toISOString(),
          note: "无明文 key（apiKey/apiKeys 已整字段剔除；headers 值置空仅留头名）。导入：🧙 面板 ⇪ 导入，或让 AI 走 model_wizard_save 补 key。",
          providers: {} as Record<string, unknown>,
          skippedCombos: [] as string[],
        };
        for (const [name, prov0] of Object.entries((data.providers || {}) as Record<string, any>)) {
          if (!prov0 || typeof prov0 !== "object") continue;
          if (prov0.combo === true) { out.skippedCombos.push(name); continue; } // 聚合组不进导入链（applySaveInto 拒收）
          const prov: any = {};
          if (prov0.baseUrl) prov.baseUrl = prov0.baseUrl;
          if (prov0.api) prov.api = prov0.api;
          if (prov0.apiKeyEnv) prov.apiKeyEnv = prov0.apiKeyEnv; // env 变量名（非秘密值）
          if (Array.isArray(prov0.models)) prov.models = prov0.models;
          if (prov0.enabled === false) prov.enabled = false;
          if (prov0.headers && typeof prov0.headers === "object") {
            const hh: Record<string, string> = {};
            for (const k of Object.keys(prov0.headers)) hh[k] = ""; // 值剔除、头名保留
            prov.headers = hh;
          }
          if (prov.baseUrl && prov.api) out.providers[name] = prov;
        }
        return json({ ok: true, ...out });
      }
      // POST /import {providers, apply?} —— 导入预览/应用（P2-A）：
      //   apply=false（缺省）→ 差异预览行（new/same/conflict 三色 + keepKey 标注），零写盘；
      //   apply=true → 组装 saves 走 saveBatchImpl（批前一次 undo 快照，/undo 一步回整批）。
      if (p[0] === "import" && req.method === "POST") {
        const b = body || {};
        const incoming = b.providers && typeof b.providers === "object" && !Array.isArray(b.providers) ? b.providers : null;
        if (!incoming) return json({ ok: false, error: "需要 providers 对象（{名字: {baseUrl, api, models…}}）" }, 400);
        const names = Object.keys(incoming).slice(0, 200);
        if (!names.length) return json({ ok: false, error: "providers 为空" }, 400);
        const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
        const existing = (data.providers || {}) as Record<string, any>;
        const rows: any[] = [];
        const errors: string[] = [];
        for (const name of names) {
          const inc: any = incoming[name] || {};
          if (!inc.baseUrl || !inc.api) { errors.push(name + "：缺 baseUrl/api，跳过"); continue; }
          const cur = existing[name];
          const curCombo = !!(cur && cur.combo === true);
          const curHasKey = !!(cur && (cur.apiKey || (Array.isArray(cur.apiKeys) && cur.apiKeys.length)));
          const incHasKey = !!(inc.apiKey || (Array.isArray(inc.apiKeys) && inc.apiKeys.length));
          const kind = !cur ? "new" : (curCombo || cur.baseUrl !== inc.baseUrl || cur.api !== inc.api) ? "conflict" : "same";
          rows.push({
            name,
            kind,
            reason: curCombo ? "同名为聚合组（导入会拒）" : kind === "conflict" ? `端点不同：${String(cur.baseUrl || "?")} → ${inc.baseUrl}` : "",
            modelsIncoming: Array.isArray(inc.models) ? inc.models.length : 0,
            modelsExisting: cur && Array.isArray(cur.models) ? cur.models.length : 0,
            keepKey: curHasKey && !incHasKey, // 现有 key 保留（导入文件无明文 key）
          });
        }
        if (!b.apply) {
          rows.sort((x: any, y: any) => ["new", "same", "conflict"].indexOf(x.kind) - ["new", "same", "conflict"].indexOf(y.kind) || x.name.localeCompare(y.name));
          return json({ ok: true, preview: true, rows, errors, conflictCount: rows.filter((r) => r.kind === "conflict").length });
        }
        // apply：组装 saves（同端点 = 更新模型/头；冲突条目照导——预览已红牌警示，用户确认即执行）
        const saves = rows.filter((r) => r.kind !== "new" || true).map((r: any) => {
          const inc = incoming[r.name];
          const cur = existing[r.name];
          const curHasKey = !!(cur && (cur.apiKey || (Array.isArray(cur.apiKeys) && cur.apiKeys.length)));
          const save: any = { provider: r.name, baseUrl: inc.baseUrl, api: inc.api, models: Array.isArray(inc.models) ? inc.models : [], keepKey: curHasKey };
          if (inc.apiKeyEnv) save.apiKeyEnv = inc.apiKeyEnv;
          if (inc.enabled === false) save.enabled = false;
          // headers：仅透传带非空值的条目（脱敏导出的空值头不覆盖现有）
          if (inc.headers && typeof inc.headers === "object") {
            const hh: Record<string, string> = {};
            let n = 0;
            for (const [k, v] of Object.entries(inc.headers)) if (String(v ?? "").trim()) { hh[k] = String(v); n++; }
            if (n) save.headers = hh;
          }
          return save;
        });
        try {
          const r = await saveBatchImpl(ctx, saves);
          return json(Object.assign({ imported: saves.length, errors }, r));
        } catch (e: any) {
          return json({ ok: false, error: "导入写盘失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // POST /save-batch {saves:[SaveBody…]} — 批量导入专用（aiti-models-import 经 saveBatch service 调同一实现）：
      // 批前一次 undo 快照（多 provider patch）→ 单次写盘/缓存失效/代理刷新；单条失败不中断；/undo 一步回整批
      if (p[0] === "save-batch" && req.method === "POST") {
        const saves = Array.isArray(body?.saves) ? body.saves : [];
        if (!saves.length) return json({ ok: false, error: "需要 saves 数组" }, 400);
        try {
          const r = await saveBatchImpl(ctx, saves);
          if (!r.ok) return json(r, 400);
          return json(r);
        } catch (e: any) {
          return json({ ok: false, error: "批量写 models.json 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // GET /undo-status → 是否有可撤销的上次保存（不消费）
      // GET /undo-status → 是否有可撤销的上次保存（不消费）
      if (p[0] === "undo-status" && req.method === "GET") {
        const u = core.loadUndo(configDir);
        return json(u ? { ok: true, ts: u.ts, providers: Object.keys(u.providers) } : { ok: false });
      }
      // POST /undo → 撤销上次保存：按快照恢复受影响 provider 的旧条目（null=原本不存在则删除）
      if (p[0] === "undo" && req.method === "POST") {
        try {
          const u = core.loadUndo(configDir);
          if (!u) return json({ ok: false, error: "没有可撤销的保存" }, 404);
          for (const pid of Object.keys(u.providers)) {
            if (isOauthManaged(pid)) delete u.providers[pid]; // 守护：订阅登录型不碰
          }
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const r = core.restoreUndoData(data, u);
          if (!r.ok) return json({ ok: false, error: "快照无有效变更" }, 400);
          await ctx.core.writeModelsConfig(r.data);
          refreshProxiesViaCombo();
          try { require("fs").unlinkSync(core.undoPath(configDir)); } catch {} // 一级撤销：用后即焚
          return json({ ok: true, restored: Object.keys(u.providers) });
        } catch (e: any) {
          return json({ ok: false, error: "撤销失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // POST /probe-cap {provider, model} → 实测验证某已配置模型的 maxTokens 上限（#4）；
      // 元数据虚报被 API 拒时解析真实上限并直接回写 models.json（仅下调，不动其它字段）
      if (p[0] === "probe-cap" && req.method === "POST") {
        const b = body || {};
        const provider = String(b.provider || "").trim();
        const modelId = String(b.model || "").trim();
        if (!provider || !modelId) return json({ ok: false, error: "需要 provider + model" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers && data.providers[provider];
          if (!prov) return json({ ok: false, error: "provider 不存在: " + provider }, 404);
          const entry = Array.isArray(prov.models) ? prov.models.find((m: any) => m && (typeof m === "object" ? (m.id || m.model) : m) === modelId) : null;
          const meta = entry && typeof entry === "object" ? entry : null;
          const maxTokens = meta && Number(meta.maxTokens);
          if (!Number.isFinite(maxTokens) || maxTokens <= 0) return json({ ok: true, skipped: true, corrected: false, detail: "该模型未配置 maxTokens，跳过" });
          // baseUrl/api 缺失时跟随内置目录补全（同 providerScanParams 规则）
          let baseUrl = String(prov.baseUrl || "").replace(/\/+$/, "");
          let api = prov.api || "openai-completions";
          if (!baseUrl || !prov.api) {
            const storeData = core.loadModelsStore(configDir, c).data;
            const sp = storeData && storeData[provider];
            if (sp && Array.isArray(sp.models) && sp.models.length) {
              const first = typeof sp.models[0] === "object" ? sp.models[0] : null;
              if (!baseUrl && first && first.baseUrl) baseUrl = String(first.baseUrl).replace(/\/+$/, "");
              if (!prov.api && first && first.api) api = first.api;
            }
          }
          if (!baseUrl) return json({ ok: true, skipped: true, corrected: false, detail: "无法确定 baseUrl，跳过" });
          const apiKey = String(prov.apiKey || (prov.apiKeyEnv ? process.env[prov.apiKeyEnv] : "") || "").trim();
          const xh = effectiveHeaders(b, provider); // 生效请求头（审核修正：掩码行回存值）
          const pr = await core.probeModelCap({ provider, baseUrl, api, apiKey, model: modelId, maxTokens }, { timeoutMs: 20000, extraHeaders: xh });
          // 虚报确认且比现值小 → 直接回写 models.json（只改 maxTokens，保留并发编辑）
          if (pr.ok && pr.corrected && Number.isFinite(pr.confirmedMaxTokens) && pr.confirmedMaxTokens < maxTokens && meta) {
            meta.maxTokens = pr.confirmedMaxTokens;
            await ctx.core.writeModelsConfig(data);
            // 参数配置已回写 → 刷新运行中代理（timeouts/quality/槽位与 models.json 保持一致）
            refreshProxiesViaCombo(provider);
          }
          return json({ ...pr, provider, model: modelId });
        } catch (e: any) {
          return json({ ok: false, error: "probe-cap 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // POST /delete {provider} → provider 整体删除（apiKeys 一并消失）
      if (p[0] === "delete" && req.method === "POST") {        const provider = String((body && body.provider) || "");
        if (isOauthManaged(provider)) return json({ ok: false, error: "「" + provider + "」是订阅登录型 provider，不在 models.json 里，无需删除；如需登出请到 pi-web 模型设置操作。" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          // 删除也快照（一级撤销可恢复误删）
          core.stashUndo(configDir, { [provider]: (data.providers && data.providers[provider]) ?? null });
          const r = core.deleteProviderData(data, provider);
          if (!r.ok) return json({ ok: false, error: r.error }, 500);
          await ctx.core.writeModelsConfig(r.data);
          refreshProxiesViaCombo(provider);
          core.removeReminderProvider(configDir, provider);
          return json({ ok: true, provider: r.provider, file: "(pi-web /api/models-config)" });
        } catch (e: any) {
          return json({ ok: false, error: "写 models.json 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // POST /enable {provider, enabled} → 临时禁用/启用 provider（不删除配置；立即停/建代理 + 刷新槽位）
      //   聚合组同样适用：enabled:false = 整个组停用（模型列表隐藏、不建代理）
      if (p[0] === "enable" && req.method === "POST") {
        const provider = String((body && body.provider) || "");
        const enabled = !(body && body.enabled === false);
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        if (isOauthManaged(provider)) return json({ ok: false, error: "「" + provider + "」是订阅登录型 provider，凭据由登录流程管理（auth.json），不由 models.json 管理，无需禁用/启用。" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers?.[provider];
          if (!prov) return json({ ok: false, error: "provider 不存在: " + provider }, 404);
          // 快照：一级撤销可恢复误切
          core.stashUndo(configDir, { [provider]: prov });
          if (enabled) delete prov.enabled; else prov.enabled = false;
          await ctx.core.writeModelsConfig(data);
          refreshProxiesViaCombo(provider);
          return json({ ok: true, provider, enabled, file: "(pi-web /api/models-config)" });
        } catch (e: any) {
          return json({ ok: false, error: "写 models.json 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // POST /model-enable {provider, model, enabled} → 临时禁用/启用单个模型（不删除；模型从列表隐藏、组合成员跳过）
      if (p[0] === "model-enable" && req.method === "POST") {
        const provider = String((body && body.provider) || "");
        const modelId = String((body && body.model) || "");
        const enabled = !(body && body.enabled === false);
        if (!provider || !modelId) return json({ ok: false, error: "需要 provider + model" }, 400);
        if (isOauthManaged(provider)) return json({ ok: false, error: "「" + provider + "」是订阅登录型 provider，凭据由登录流程管理，不支持此操作。" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers?.[provider];
          if (!prov) return json({ ok: false, error: "provider 不存在: " + provider }, 404);
          const models = Array.isArray(prov.models) ? prov.models : [];
          const mdef = models.find((m: any) => m && String(m.id ?? m.model ?? "") === modelId);
          if (!mdef) return json({ ok: false, error: "模型不存在: " + provider + "/" + modelId }, 404);
          core.stashUndo(configDir, { [provider]: prov });
          if (enabled) delete mdef.enabled; else mdef.enabled = false;
          await ctx.core.writeModelsConfig(data);
          refreshProxiesViaCombo(provider);
          return json({ ok: true, provider, model: modelId, enabled, file: "(pi-web /api/models-config)" });
        } catch (e: any) {
          return json({ ok: false, error: "写 models.json 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // GET /model-override?provider=X → 该 provider 的 modelOverrides（仅 contextWindow 键）——启用作用域区块覆盖编辑读值用
      // POST /model-override {provider, model, contextWindow?} → 写/删 providers[id].modelOverrides.contextWindow（G2）：
      //   managed/builtin provider（订阅/key 型，模型清单运行时定义）无 models.json 模型条目时的唯一写口；
      //   contextWindow 缺省=删除覆盖；正整数校验（非法 400，原生 ContextWindowError 同语义）；
      //   空 provider 条目自动清理；一级撤销 + 代理刷新。
      //   ⚠️ 不设 isOauthManaged 守卫——原生允许订阅登录型 provider 存 overrides-only 条目（isOverridesOnly 归属托管 provider）。
      if (p[0] === "model-override" && req.method === "GET") {
        const provider = String(ctx.searchParams.get("provider") || "").trim();
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          return json({ ok: true, provider, overrides: core.getModelOverrides(data, provider) });
        } catch (e: any) {
          return json({ ok: false, error: "读取失败: " + ((e && e.message) || e) }, 500);
        }
      }
      if (p[0] === "model-override" && req.method === "POST") {
        const b = body || {};
        const provider = String(b.provider || "").trim();
        const modelId = String(b.model || "").trim();
        if (!provider || !modelId) return json({ ok: false, error: "需要 provider + model" }, 400);
        const raw = b.contextWindow;
        let value: number | undefined;
        if (raw !== undefined && raw !== null && raw !== "") {
          const n = typeof raw === "number" ? raw : Number(String(raw).trim());
          if (!Number.isSafeInteger(n) || n < 1) return json({ ok: false, error: "上下文窗口需为正整数 tokens（model: " + modelId + "）" }, 400);
          value = n;
        }
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers && data.providers[provider];
          core.stashUndo(configDir, { [provider]: prov ? JSON.parse(JSON.stringify(prov)) : null });
          const r = core.setModelOverrideData(data, provider, modelId, value);
          await ctx.core.writeModelsConfig(r.data);
          refreshProxiesViaCombo(provider);
          return json({ ok: true, provider, model: modelId, contextWindow: value ?? null, removed: value === undefined });
        } catch (e: any) {
          return json({ ok: false, error: "写 modelOverrides 失败: " + ((e && e.message) || e) }, 500);
        }
      }
      // GET /keys?provider= → 某 provider 的 keys（打码，models.json provider.apiKeys）
      // POST /keys {provider, keys: [...]} → 整体替换（空数组=清空）；{provider, action:"remove", name} → 删一个
      if (p[0] === "keys" && req.method === "GET") {
        const provider = String(ctx.searchParams.get("provider") || "").trim();
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        const keys = core.getProviderKeys(configDir, c, provider);
        // enabled 必须透传：key 行的禁用视觉（灰底/▶ 切回按钮）全靠它——漏掉则
        // 已禁用的 key 在 UI 里永远显示为正常态（实测 2026-09-07：禁用"没效果"）
        return json({ ok: true, provider, file: "models.json", keys: keys.map((k: any) => ({ name: k.name, key: core.maskKey(k.key), rpm: k.rpm, minIntervalMs: k.minIntervalMs, ...(k.enabled === false ? { enabled: false } : {}) })), keyCount: keys.length });
      }
      if (p[0] === "keys" && req.method === "POST") {
        const b = body || {};
        const provider = String((b.provider || "")).trim();
        if (!provider) return json({ ok: false, error: "需要 provider" }, 400);
        if ((b.action === "set" || b.action === "remove")) {
          try { const { byKey } = getIndex(); if (byKey.get(provider)?.authType === "oauth") return json({ ok: false, error: "「" + provider + "」是订阅登录型 provider，凭据由登录管理，不支持多 key。" }, 400); } catch {}
        }
        if (b.action === "remove") {
          const name = String((b.name || "")).trim();
          if (!name) return json({ ok: false, error: "remove 需要 name" }, 400);
          const cur = core.getProviderKeys(configDir, c, provider);
          const kept = cur.filter((k: any) => k.name !== name);
          // 保护原 apiKey：remove 到空 keys 时 setProviderKeys 会删 apiKey，但对原本只有单 key
          // （无多 key）的 provider 是破坏性的——删除多 key 不应清掉 pi 直连用的主 key。
          const data0: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prevApiKey = data0.providers?.[provider]?.apiKey;
          const r = core.setProviderKeys(configDir, c, provider, kept);
          if (r.ok && prevApiKey) {
            const data1: any = (await ctx.core.readModelsConfig()) || { providers: {} };
            if (data1.providers?.[provider]) {
              // 恢复原 apiKey：仅当它仍「有效」——不在 key 池（独立主 key）恒安全；在池则必须对着一把启用 key。
              // 若 prevApiKey 是被禁用/删除的池内 key，则让 setProviderKeys 的 apiKey=首个启用 key 生效（apiKey 必须切走）。
              const keys1 = Array.isArray(data1.providers[provider].apiKeys) ? data1.providers[provider].apiKeys : [];
              const keySet = new Set(keys1.map((k: any) => k && k.key));
              const inEnabled = keys1.some((k: any) => k && k.key === prevApiKey && k.enabled !== false);
              const safe = !keySet.has(prevApiKey) || inEnabled;
              if (safe) data1.providers[provider].apiKey = prevApiKey;
            }
            await ctx.core.writeModelsConfig(data1);
          }
          if (r.ok) { refreshProxiesViaCombo(provider); }
          return r.ok ? json({ ok: true, provider, removed: name, keys: r.keys, file: r.file }) : json({ ok: false, error: r.error }, 500);
        }
        if (b.action === "update") {
          // 行内编辑单个 key：改名（newName）/换值（newKey，空=保留）/改 rpm（""=清除；缺省=不变）
          const name = String((b.name || "")).trim();
          if (!name) return json({ ok: false, error: "update 需要 name" }, 400);
          const cur = core.getProviderKeys(configDir, c, provider);
          if (!cur.some((k: any) => k.name === name)) return json({ ok: false, error: "找不到 key：" + name }, 404);
          const newName = String((b.newName ?? "")).trim();
          if (newName && newName !== name && cur.some((k: any) => k.name === newName)) return json({ ok: false, error: "已存在同名 key：" + newName }, 400);
          const newKey = String(b.newKey || "").trim();
          const next = cur.map((k: any) => {
            if (k.name !== name) return k;
            let rpmPart: any = {};
            if (b.rpm !== undefined) {
              const rv = String(b.rpm).trim();
              if (rv !== "") { const n = Math.max(1, Math.floor(Number(rv) || 0)); if (n >= 1) rpmPart = { rpm: n }; }
            } else if (k.rpm) rpmPart = { rpm: k.rpm };
            // minIntervalMs：""=清除（落库不写=默认 auto 匀速）；"0"=关闭匀速（突发滑窗）；"auto"=按 rpm 折算；数字=毫秒；缺省=不变
            let mivPart: any = {};
            if (b.minIntervalMs !== undefined) {
              const mv = String(b.minIntervalMs).trim();
              if (mv === "auto") mivPart = { minIntervalMs: "auto" };
              else if (mv !== "") { const n = Math.floor(Number(mv)); if (Number.isFinite(n) && n >= 0) mivPart = { minIntervalMs: n }; }
            } else if (k.minIntervalMs !== undefined) mivPart = { minIntervalMs: k.minIntervalMs };
            // enabled：单把 key 临时禁用/启用（true=启用=删标记；false=禁用=停用不删除）
            let enPart: any = {};
            if (b.enabled !== undefined) enPart = { enabled: !!b.enabled };
            return { ...(newName ? { name: newName } : { name }), key: newKey || k.key, ...rpmPart, ...mivPart, ...enPart };
          });
          const data0: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prevApiKey = data0.providers?.[provider]?.apiKey;
          const r = core.setProviderKeys(configDir, c, provider, next);
          if (r.ok && prevApiKey) {
            const data1: any = (await ctx.core.readModelsConfig()) || { providers: {} };
            if (data1.providers?.[provider]) {
              // 同上：prevApiKey 是池内且非启用的 key 时让 apiKey 切走（禁用主 key 场景）
              const keys1 = Array.isArray(data1.providers[provider].apiKeys) ? data1.providers[provider].apiKeys : [];
              const keySet = new Set(keys1.map((k: any) => k && k.key));
              const inEnabled = keys1.some((k: any) => k && k.key === prevApiKey && k.enabled !== false);
              const safe = !keySet.has(prevApiKey) || inEnabled;
              if (safe) data1.providers[provider].apiKey = prevApiKey;
            }
            await ctx.core.writeModelsConfig(data1);
          }
          if (r.ok) { refreshProxiesViaCombo(provider); }
          return r.ok ? json({ ok: true, provider, keys: r.keys, keyCount: r.keys.length, file: r.file }) : json({ ok: false, error: r.error }, 500);
        }
        if (b.action === "add") {
          // 增量追加/覆盖单个 key（编辑流用：已有 key 打码不可回传，只能增量 add/remove）
          const raw = b.key !== undefined ? b.key : b.keys?.[0]?.key;
          const key = String(raw || "").trim();
          if (!key) return json({ ok: false, error: "add 需要 key" }, 400);
          const rpm = b.rpm !== undefined && b.rpm !== null && b.rpm !== "" ? Math.max(1, Math.floor(Number(b.rpm) || 0)) : undefined;
          const rawMiv = b.minIntervalMs !== undefined && b.minIntervalMs !== null ? String(b.minIntervalMs).trim() : "";
          const minIntervalMs = rawMiv === "auto" ? "auto" : rawMiv !== "" && Number.isFinite(Number(rawMiv)) && Number(rawMiv) >= 0 ? Math.floor(Number(rawMiv)) : undefined;
          const name = String(b.name || "").trim() || "key";
          const cur = core.getProviderKeys(configDir, c, provider);
          const next = cur.filter((k: any) => k.name !== name); // 同名覆盖
          next.push({ name, key, ...(rpm ? { rpm } : {}), ...(minIntervalMs ? { minIntervalMs } : {}) });
          // 保留原有 apiKey（主 key）不被 add 覆盖：setProviderKeys 会把 apiKey 同步为第一个 key，
          // 但 add 只是追加轮换 key，不应改 pi 直连用的主 key（除非原无 apiKey）。
          // 仅当 prevApiKey 仍「有效」才恢复——不在池（独立主 key）恒安全；在池则必须对着一把启用 key
          //（同名覆盖主 key / 池内被禁用时让 apiKey 切到新值）。
          const data0: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prevApiKey = data0.providers?.[provider]?.apiKey;
          const r = core.setProviderKeys(configDir, c, provider, next);
          if (r.ok && prevApiKey) {
            const data1: any = (await ctx.core.readModelsConfig()) || { providers: {} };
            if (data1.providers?.[provider]) {
              const keys1 = Array.isArray(data1.providers[provider].apiKeys) ? data1.providers[provider].apiKeys : [];
              const keySet = new Set(keys1.map((k: any) => k && k.key));
              const inEnabled = keys1.some((k: any) => k && k.key === prevApiKey && k.enabled !== false);
              const safe = !keySet.has(prevApiKey) || inEnabled;
              if (safe) data1.providers[provider].apiKey = prevApiKey;
            }
            await ctx.core.writeModelsConfig(data1);
          }
          if (r.ok) { refreshProxiesViaCombo(provider); }
          return r.ok ? json({ ok: true, provider, keys: r.keys, keyCount: r.keys.length, file: r.file, modelsSynced: r.modelsSynced }) : json({ ok: false, error: r.error }, 500);
        }
        const keys = Array.isArray(b.keys) ? b.keys.map((k: any) => typeof k === "string" ? { name: "key", key: k } : k) : [];
        const r = core.setProviderKeys(configDir, c, provider, keys);
        if (r.ok) { refreshProxiesViaCombo(provider); }
        return r.ok ? json({ ok: true, provider, keys: r.keys, keyCount: r.keys.length, file: r.file, modelsSynced: r.modelsSynced }) : json({ ok: false, error: r.error }, 500);
      }
      // GET /new-models → 新模型检测结果（前日基线 vs 今日可用 - 已配置）：总览 + 各 provider 新增数（已配置 tab 徽标用）
      // ?toast=1 → 客户端请求弹 toast：服务器按频控（每天 ≤maxPerDay 次、间隔 ≥minGapMs）裁决，放行才计数；
      //   toast.allowed=true 表示本次消费了一次额度（客户端弹 10s toast）；false 附 reason/nextAtMs（静默，徽标仍可用）
      // POST /new-models/refresh → 重扫（拉 /models 快照）。缺省后台异步；body {wait:true} 同步扫完返回
      // （模型检查「探测全部/单模型测」完成后联动用——检查时顺手发现新模型）；{force:true} 跳过新鲜度节流。
      // 节流：距上次扫描 < rescanMinGapMs（缺省 5min）直接返回现有结果，避免频繁检查反复打厂商 /models。
      if (p[0] === "new-models" && p[1] === "refresh" && req.method === "POST") {
        const state = getScanState();
        const wait = !!(body && body.wait);
        const force = !!(body && body.force);
        const gapMs = (c.reminder && (c.reminder as any).rescanMinGapMs) != null ? (c.reminder as any).rescanMinGapMs : 5 * 60 * 1000;
        const fresh = state.lastAt && Date.now() - state.lastAt < gapMs;
        let scanned = false;
        if (!state.scanning && (force || !fresh)) {
          if (wait) { await scanNewModels(state); scanned = true; }
          else void scanNewModels(state);
        }
        const nm = core.computeNewModels(configDir, c);
        return json({ ok: true, started: !wait, scanned, scanning: !!state.scanning, total: nm.total, providers: nm.providers, baseline: nm.baseline });
      }
      // POST /new-models/ack {provider?, ids?} → 用户已知悉（打开向导已配置页/启用模型），清待告知集
      if (p[0] === "new-models" && p[1] === "ack" && req.method === "POST") {
        const r = core.ackNewModels(configDir, body && body.provider, body && body.ids);
        const nm = core.computeNewModels(configDir, c);
        return json({ ...r, total: nm.total, providers: nm.providers });
      }
      if (p[0] === "new-models" && req.method === "GET") {
        const nm = core.computeNewModels(configDir, c);
        const state = getScanState();
        const wantToast = ctx.searchParams.get("toast") === "1";
        let toast: any = null;
        // 频控裁决前必须确认扫描已就绪且功能启用：scanning 中响应会被客户端丢弃重试，
        // 若此时烧掉额度（markToastShown）→ 重试被 minGapMs 拒绝 → 额度空烧、toast 永不出。
        // reminder.enabled=false 时同样不裁决（残留 pending 只留徽标，不再弹 toast）。
        const reminderOff = !c.reminder || c.reminder.enabled === false;
        const scanReady = state.done && !state.scanning;
        if (wantToast && nm.total > 0 && reminderOff) {
          toast = { allowed: false, reason: "disabled", shownToday: null, nextAtMs: null };
        } else if (wantToast && nm.total > 0 && !scanReady) {
          toast = { allowed: false, reason: "scanning", shownToday: null, nextAtMs: null };
        } else if (wantToast && nm.total > 0) {
          const dec = core.toastDecision(configDir, c);
          if (dec.allowed) {
            const mark = core.markToastShown(configDir, c);
            toast = { allowed: true, reason: "ok", shownToday: mark.count, nextAtMs: null };
          } else toast = { allowed: false, reason: dec.reason, shownToday: dec.count, nextAtMs: dec.nextAtMs };
        }
        return json({ ok: true, scanning: !state.done, total: nm.total, providers: nm.providers, baseline: nm.baseline, toast });
      }
      // GET /config · POST /config {set}
      if (p[0] === "config" && req.method === "GET") {
        const { _file, ...rest } = c;
        return json({ ok: true, file: c._file, config: rest });
      }
      // POST /refresh {provider?} → 强制刷新运行中代理的槽位配置（pi-models-combo 原地更新）
      // provider 缺省 = 刷新全部已有代理；返回实际刷新的 provider 列表
      if (p[0] === "refresh" && req.method === "POST") {
        const provider = String((body && body.provider) || "").trim();
        try {
          const refreshed = refreshProxiesViaCombo(provider || undefined);
          return json({ ok: true, refreshed, provider: provider || "(全部)" });
        } catch (e: any) {
          return json({ ok: false, error: "刷新失败: " + ((e && e.message) || e) }, 500);
        }
      }
      if (p[0] === "config" && req.method === "POST") {
        if (body && body.set && typeof body.set === "object") {
          const merged = { ...c, ...body.set };
          if (core.saveConfig(merged, configDir)) {
            withCfg();
            // 提醒扫描周期/开关随配置即时生效（timer 幂等重建；enabled=false 时 scanNewModels 自行空转）
            stopReminderScan(); startReminderScan();
            return json({ ok: true });
          }
          return json({ ok: false, error: "写配置失败" }, 500);
        }
        return json({ ok: false, error: "需要 set" }, 400);
      }
      // GET /proxy-status → 聚合 / 多 key 代理运行时状态（pi-models-combo 引擎 globalThis 共享状态）
      //   返回：loaded=status() 入口是否就绪（引擎新版本已加载）；present=引擎状态对象是否在（旧版本引擎在跑但无 status 入口）
      //   status=各 provider 代理的槽位健康/冷却/统计（无任何 key 明文）。刷新按钮按需重拉，不轮询。
      if (p[0] === "proxy-status" && req.method === "GET") {
        let status: unknown = null;
        let loaded = false;
        let present = false;
        try {
          const g = globalThis as any;
          present = !!g?.__piModelsCombo;
          const fn = g?.__piModelsCombo?.status;
          loaded = typeof fn === "function";
          if (loaded) status = fn();
        } catch {}
        return json({
          ok: true,
          loaded,
          present,
          status: Array.isArray(status) ? status : [],
          ts: Date.now(),
        });
      }
      return json({ ok: false, error: "not found" }, 404);
    },

    agent: {
      agentTools() {
        // 门控由 core 统一判定（feature agentTools.enabled + per-session enableExtTools），此处无条件返回
        return TOOLS.map((t) => ({
          name: "aiti_" + t.name,
          label: "aiti_" + t.name,
          description: t.description + "（aiti-model-wizard 进程内直连，pi-web 会话）",
          parameters: t.inputSchema || { type: "object", properties: {} },
          async execute(_toolCallId: string, params: any) {
            return runTool(t.name, params || {});
          },
        }));
      },
    },
  },
};
