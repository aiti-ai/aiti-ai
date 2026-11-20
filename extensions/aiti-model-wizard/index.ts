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

/** User-facing message i18n envelope; the client translates via tsrv(). */
const imsg = (key: string, params?: Record<string, unknown>) => "i18n:" + key + (params ? "|" + JSON.stringify(params) : "");
const imsgRaw = imsg;

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
  if (isOauthProvider(provider)) return { ok: false as const, status: 400, error: imsg("mw.s.oauthWriteDenied", { p: provider }) };
  if (!b.provider || !b.baseUrl || !b.api) return { ok: false as const, status: 400, error: imsg("mw.s.needPBA") };
  if (((data.providers || {})[provider] || {}).combo === true) return { ok: false as const, status: 400, error: imsg("mw.s.comboEditHint", { p: provider }) };
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
  if (!changed.length) return { ok: false as const, error: imsg("mw.s.noValidSave"), results };
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
      { id: "aiti-model-wizard-open", label: "i18n:mw.open.label", title: "i18n:mw.open.title" },
    ],
    i18n: {
      "zh-CN": {
        "feat.aiti-model-wizard-banner": "aiti-model-wizard：无模型引导",
        "feat.aiti-model-wizard-multikey-status": "聚合 / 多key运行状态",
        "feat.aiti-model-wizard-multikey-status.desc": "会话信息下拉内「聚合 / 多 key 代理运行时状态」（薄壳直连 /proxy-status，重 chunk 覆盖升级为完整版）",
        "feat.aiti-model-wizard-manage": "管理模型",
        "feat.aiti-model-wizard-manage.desc": "模型选择器下拉底部「管理模型」入口——打开模型向导",
        "it.manage.label": "管理模型",
        "it.multikey-status.label": "聚合 / 多key运行状态",
        "it.settings.label": "模型向导",
        "it.shell.title": "模型管理",
        "it.multikey-status.label.2": "聚合 / 多key运行状态",
        "ext.displayName": "模型添加向导",      "mw.open.label": "模型",
      "mw.open.title": "aiti-model-wizard：添加 AI 提供商/模型（目录搜索 / 反向匹配 / 自动探测）",
      "mw.shell.title": "aiti-model-wizard：添加 AI 提供商/模型",
      "mw.shell.newFound": "aiti-model-wizard：发现 {n} 个新模型，点击查看",
      "mw.shell.manageTitle": "aiti-model-wizard：打开模型向导（添加 AI 提供商/模型、聚合与多 key 管理）",
      "mw.st.title": "聚合 / 多 key 运行状态",
      "mw.st.titleDlg": "聚合 / 多 key 运行时状态",
      "mw.st.refresh": "刷新",
      "mw.st.close": "关闭",
      "mw.st.readFailed": "状态读取失败（引擎可能未运行）",
      "mw.st.emptyLoaded": "引擎已就绪，当前无多 key / 聚合 provider（给 provider 配 ≥2 个 key 或建聚合组后自动出现）",
      "mw.st.emptyPresent": "引擎已运行但为旧版本代码——重启 pi-web（或新建会话）后即显示实时状态",
      "mw.st.emptyNotLoaded": "引擎未加载（尚无 agent 会话启动过 pi-models-combo——开始一次对话后自动就绪）",
      "mw.st.proxiesSlots": "{proxies} 代理 · {slots} 槽位",
      "mw.st.proxies": "{proxies} 代理",
      "mw.st.sum.ready": "运行状态…",
      "mw.st.sum.failed": "状态读取失败",
      "mw.st.sum.failing": "{proxies} 代理 · 有 key 故障/限流",
      "mw.st.sum.cooling": "{proxies} 代理 · 有槽位冷却中",
      "mw.st.sum.empty": "无聚合/多key 代理",
      "mw.st.sum.old": "引擎旧版·重启生效",
      "mw.st.sum.notLoaded": "引擎未加载",
      "mw.st.sumTitle": "查看聚合 / 多key 运行时状态：当前 key · 冷却 · 每 key 统计",
      "mw.st.pillCombo": "聚合",
      "mw.st.pillKey": "多key",
      "mw.st.configError": "配置错误 · 无法构建",
      "mw.st.unbuilt": "未构建 · 首次请求后激活",
      "mw.st.stickyOff": "粘性关",
      "mw.st.memberFailTitle": "成员解析失败：{err}",
      "mw.st.unbuildable": "无法构建：{err}",
      "mw.st.virtualModels": "{n} 个虚拟模型 · 首次请求后自动构建槽位",
      "mw.st.satTitle": "全部槽位持续 429；持续超阈值后代理返回终态错误终止客户端无限重试",
      "mw.st.satChip": "⛔ 全池限流中 {s}s",
      "mw.st.satNear": "即将终态报错",
      "mw.st.intervalAuto": "间隔auto",
      "mw.st.intervalS": "间隔{s}s",
      "mw.st.pinnedTitle": "当前有会话粘住此槽位",
      "mw.st.pinned": "粘×{n}",
      "mw.st.normal": "正常",
      "mw.st.429cool": "429 冷却",
      "mw.st.errCool": "错误冷却",
      "mw.st.linked": "・联",
      "mw.st.all429": "⛔ 全部429",
      "mw.st.unobserved": "◌ 未观测",
      "mw.st.failLinkedTitle": "同一把 key 在其他代理近期全部 429（联动标红）",
      "mw.st.failTitle": "近期请求全部 429（配额耗尽类故障，非瞬时限流）",
      "mw.st.staleTitle": "最后一次观测在 {ago}，无新数据——旧状态不代表当前可用性",
      "mw.st.coolUpstream": "上游 retry-after {up}s → 最早恢复 {clock}（{eta}）",
      "mw.st.coolCapped": "超出内部封顶已截断，实际按 cap 雪藏后重试（上游配额可能尚未恢复）",
      "mw.st.coolNoRetryAfter": "上游未给出 retry-after，按默认冷却：{s}s 后重试",
      "mw.st.coolError": "上游连续错误，按错误冷却冻结",
      "mw.st.tokTitle": "token 流量（进程内累计）：↑ 输入 · ↓ 输出",
      "mw.st.tokCache": "↻ 缓存读+写",
      "mw.st.cumulative": "进程内累计（重启清零）",
      "mw.st.legend": "▶=最近在用槽位 · 粘×N=当前粘住该槽位的会话数 · 🧊429 冷却带「约 X 后」= 上游 retry-after 的相对剩余（鼠标悬停看最早恢复日期时间；⚠=超出内部封顶已截断，实际按 cap 提前重试）· ⛔=近期全部 429 或全池持续限流 · ◌=观测过时（无新数据）· ・联=同 key 其他代理联动（按最新观测）· ↑↓↻=token 流量（输入/输出/缓存读+写，成功响应解析，无 usage 的上游不计）· 统计为引擎进程内累计，不落盘",
      "mw.st.ago.sec": "{s}s前",
      "mw.st.ago.min": "{m}m前",
      "mw.st.ago.hour": "{h}h前",
      "mw.st.eta.sec": "约 {s} 秒后",
      "mw.st.eta.min": "约 {m} 分后",
      "mw.st.eta.minSec": "约 {m} 分 {s} 秒后",
      "mw.st.eta.hour": "约 {h} 小时后",
      "mw.st.eta.hourMin": "约 {h} 小时 {m} 分后",
      "mw.st.eta.day": "约 {d} 天 {h} 小时后",
      "mw.st.eta.dayMin": "约 {d} 天 {h} 小时 {m} 分后",
      "mw.st.shellFailed": "聚合 / 多 key 运行状态：读取失败（引擎可能未运行）",
      "mw.st.shellLoading": "聚合 / 多 key 运行状态 …",
      "mw.st.chipPoolLimit": "⛔ 全池限流 {n}",
      "mw.st.chipCooling": "🧊 冷却 {n}",
      "mw.st.chipAll429": "⛔ 全部429 {n}",
      "mw.tx.208": "收起该 provider 的模型行（{n} 个）",
      "mw.tx.209": "展开该 provider 的模型行（{n} 个）",
      "mw.a.1": "推理",
      "mw.a.2": "输入",
      "mw.a.3": "兼容",
      "mw.a.4": "思考映射",
      "mw.a.5": "采样",
      "mw.a.6": "名",
      "mw.a.7": "地址",
      "mw.a.8": " 等 ",
      "mw.a.9": " 个",
      "mw.a.10": "自动反填：",
      "mw.a.11": "我在模型向导里保存了 provider「",
      "mw.a.12": "」，但以下模型在所有数据源（models.json / 内置目录 models-store / 厂商 /models / models.dev / OpenRouter / LiteLLM）都查不到参数，被保存成了裸条目（缺 contextWindow / maxTokens 等）：",
      "mw.a.13": "请按 model-params-fill 手册：1) 上网查权威数据（官方文档 / /models 接口 / models.dev / OpenRouter）；",
      "mw.a.14": "2) 把权威数据写入 ~/.pi/agent/models-store.json（provider=",
      "mw.a.15": " 的 models 数组，只增改目标模型，勿动其它条目）；",
      "mw.a.16": "3) 在模型向导已打开的「模型参数」弹窗里回填这些参数，让我点击保存生效。",
      "mw.a.17": "权威来源请标注。查不到的字段宁缺毋滥，绝不瞎编。",
      "mw.a.18": "模型添加向导",
      "mw.a.19": "AI 正在查权威数据并补全参数…",
      "mw.a.20": "模型缺参数 · ",
      "mw.a.21": "已用尽",
      "mw.a.22": " 项",
      "mw.a.23": "一键体检",
      "mw.a.24": " · 进行中…",
      "mw.a.25": "关闭",
      "mw.a.26": "体检失败",
      "mw.a.27": " 可用 · 🟡 ",
      "mw.a.28": " 限流 · ❌ ",
      "mw.a.29": " 失败",
      "mw.a.30": " 跳过",
      "mw.a.31": "　（结论已留存，树上徽标/详情健康条同步）",
      "mw.a.32": "网络异常 · ",
      "mw.a.33": "（探针 ",
      "mw.a.34": "读取配置失败",
      "mw.a.35": "已保存，即时生效",
      "mw.a.36": "保存失败",
      "mw.a.37": "目录已刷新（",
      "mw.a.38": " 家 · ",
      "mw.a.39": "刷新失败",
      "mw.a.40": "扫描间隔（分钟）",
      "mw.a.41": "单家拉取超时（秒）",
      "mw.a.42": "toast 每日上限",
      "mw.a.43": "超出后静默（徽标不受影响）",
      "mw.a.44": "toast 最小间隔（秒）",
      "mw.a.45": "toast 展示时长（秒）",
      "mw.a.46": "缓存 TTL（小时）",
      "mw.a.47": "立即重新下载目录（官方 + 镜像竞速）",
      "mw.a.48": "刷新中…",
      "mw.a.49": "↻ 立即刷新",
      "mw.a.50": "连接测试超时（秒）",
      "mw.a.51": "一键体检同用",
      "mw.a.52": "端点探测超时（秒）",
      "mw.a.53": "探针 maxTokens",
      "mw.a.54": "测试连接的最小探针输出上限",
      "mw.a.55": "保存中…",
      "mw.a.56": "保存",
      "mw.a.57": "搜索成员（已配置 provider/模型）…",
      "mw.a.58": "无匹配成员",
      "mw.a.59": "没有可作成员的已配置模型——先在「添加」页配置真实模型",
      "mw.a.60": "共 ",
      "mw.a.61": " 个匹配，仅显示前 ",
      "mw.a.62": " 个——请输入关键字缩小范围",
      "mw.a.63": "探测不可用（aiti-model-check 未启用？）",
      "mw.a.64": "无探测结果（该模型可能不在运行清单里）",
      "mw.a.65": "探测失败：",
      "mw.a.66": "可用",
      "mw.a.67": "🟡 限流（key/端点正确，稍后重试即可）",
      "mw.a.68": " · 预计恢复 ",
      "mw.a.69": "异常",
      "mw.a.70": "模型参数 · ",
      "mw.a.71": "目录未收录该模型的详细参数（仅 id 清单）。",
      "mw.a.72": "未取到该模型参数——provider 的模型清单为空或模型已被移除。",
      "mw.a.73": "图片大小上限需为正整数字节数（留空=默认 4.5MiB）",
      "mw.a.74": "编辑模型 · ",
      "mw.a.75": "发起可用性探测（与「检查」页同款探针，结果写入同一份状态/历史，树上 可用/限流/异常 标记同步更新）——测完立即就地展示",
      "mw.a.76": "测试中…",
      "mw.a.77": "测试",
      "mw.a.78": "正在探测 ",
      "mw.a.79": " …（单条最长约 10 秒）",
      "mw.a.80": "本 provider 目录未收录该模型，参数借其它网关同 id 条目互证（来源：",
      "mw.a.81": "）—— 价格以该网关为准",
      "mw.a.82": "是",
      "mw.a.83": "否",
      "mw.a.84": "（空）",
      "mw.a.85": "模型 id",
      "mw.a.86": "名称",
      "mw.a.87": "上下文窗口（contextWindow）",
      "mw.a.88": "最大输出（maxTokens）",
      "mw.a.89": "输入（input）",
      "mw.a.90": "成本（cost）",
      "mw.a.91": "兼容（compat）",
      "mw.a.92": "输入限制（inputLimits）",
      "mw.a.93": "思考级别映射",
      "mw.a.94": "采样参数",
      "mw.a.95": "API 覆盖",
      "mw.a.96": "保存修改",
      "mw.a.97": "打码回显的行不可改名（服务端按名回填原值）——如需改名请删除后新增",
      "mw.a.98": "（已存值，不改则保留）",
      "mw.a.99": "打码回显：不修改则保存时保留原值",
      "mw.a.100": "删除此行（保存时移除该头）",
      "mw.a.101": "敏感头（Authorization/Key/Token…）打码回显：不修改则保存时保留原值；删除行=删除该头",
      "mw.a.102": "清空本 provider 的全部已存请求头（保存后生效）",
      "mw.a.103": "限流",
      "mw.a.104": "欠费",
      "mw.a.105": "key 无效",
      "mw.a.106": "无权限",
      "mw.a.107": "网络/超时",
      "mw.a.108": "服务端错",
      "mw.a.109": "运行期错误观测（带外 · 代理真实流量非 2xx/3xx，非主动探测）：近 1 小时 ",
      "mw.a.110": " 次 / 24 小时 ",
      "mw.a.111": " 次",
      "mw.a.112": "\\n最近 ",
      "mw.a.113": "——可能仍处于故障中，建议重检确认",
      "mw.a.114": "体检完成：",
      "mw.a.115": " 可用 · ",
      "mw.a.116": " 限流 · ",
      "mw.a.117": "体检失败：",
      "mw.a.118": "查询失败",
      "mw.a.119": "登出 ",
      "mw.a.120": "登出后该 provider 的全部模型立即不可用（凭据从 auth.json 清除）；随时可重新登录恢复。",
      "mw.a.121": "登出",
      "mw.a.122": "已登出 ",
      "mw.a.123": "登出失败：",
      "mw.a.124": "探测完成：",
      "mw.a.125": " 项，树上标记已更新",
      "mw.a.126": "探测中…",
      "mw.a.127": "可用（最近探测通过）",
      "mw.a.128": "限流中（429）——key 额度/速率受限",
      "mw.a.129": "异常（非 429）——可能欠费/失效，建议重检",
      "mw.a.130": "已刷新代理",
      "mw.a.131": "刷新失败：",
      "mw.a.132": "未知错误",
      "mw.a.133": "刷新代理失败：",
      "mw.a.134": "▶ 已启用 ",
      "mw.a.135": "已禁用 ",
      "mw.a.136": "（临时，未删除配置）",
      "mw.a.137": "操作失败",
      "mw.a.138": "操作失败：",
      "mw.a.139": "上次保存（",
      "mw.a.140": "↩ 已撤销上次保存（恢复 ",
      "mw.a.141": "），刷新页面生效",
      "mw.a.142": "撤销失败：",
      "mw.a.143": "已启用 ",
      "mw.a.144": " 的 ",
      "mw.a.145": " 个新模型，刷新页面后生效",
      "mw.a.146": "启用失败：",
      "mw.a.147": "下载失败",
      "mw.a.148": "目录已刷新",
      "mw.a.149": "加载失败",
      "mw.a.150": "已选「",
      "mw.a.151": "）—— 填入 token 后点「测试连接」",
      "mw.a.152": "自定义端点",
      "mw.a.153": "自定义端点：填 Base URL / API 类型 / 请求头 → 测试连接 → 选模型保存",
      "mw.a.154": "（已预填探测结果，可改）",
      "mw.a.155": "未探测到可辨识端点",
      "mw.a.156": "已应用探测端点：",
      "mw.a.157": "未命中 —— 检查拼写（或贴完整 API 地址，会自动反向匹配+探测）；也可用「＋ 自定义」手工接入",
      "mw.a.158": "目录未收录该地址 —— 已自动反向匹配+探测（见下方卡片，可直接用探测结果）；未识别就点最下方「🛠 自定义端点」手工接入",
      "mw.a.159": "搜索失败：",
      "mw.a.160": "已识别为「",
      "mw.a.161": "」（地址精确命中）：",
      "mw.a.162": "）—— 填 token 后点「测试连接」",
      "mw.a.163": "自定义端点（自动探测）",
      "mw.a.164": "已带 key 探测端点：",
      "mw.a.165": "）—— 填 token 后点「测试连接」即可保存",
      "mw.a.166": "已探测端点：",
      "mw.a.167": "）—— ⚠️ 无 key 仅判断 api 类型，建议填 key 精探确认",
      "mw.a.168": "探测未识别端点：",
      "mw.a.169": "反向匹配与自动探测均未命中 —— 检查地址（可去掉 /v1 /v2 再试），或点最下方「🛠 自定义端点」手工接入",
      "mw.a.170": "自动反向匹配失败：",
      "mw.a.171": "带 key 探测确认：「",
      "mw.a.172": "）—— 继续测试/保存即可",
      "mw.a.173": "自定义端点（带 key 探测）",
      "mw.a.174": "带 key 探测确认端点：",
      "mw.a.175": "）—— 继续填 token / 测试即可",
      "mw.a.176": "带 key 探测未识别：",
      "mw.a.177": "带 key 探测仍未命中 —— 检查 key 和地址，或点最下方「🛠 自定义端点」手工接入",
      "mw.a.178": "带 key 探测失败：",
      "mw.a.179": "）—— 填 token 测试",
      "mw.a.180": "pi 内置 provider —— 填 API Key 保存即可（存 auth.json 托管），模型清单由 pi 内置目录自动加载",
      "mw.a.181": "已拉取 /models ",
      "mw.a.182": " 个（新增 ",
      "mw.a.183": " · 原 ",
      "mw.a.184": " 个），目录旧模型已补全",
      "mw.a.185": "拉取失败：",
      "mw.a.186": "未返回模型（检查 token 或地址）",
      "mw.a.187": " 个（用第 ",
      "mw.a.188": " 把凭据",
      "mw.a.189": " · 共 ",
      "mw.a.190": " 把",
      "mw.a.191": "），目录旧模型已补全",
      "mw.a.192": "全部凭据均未拉到模型",
      "mw.a.193": "（已依次试 ",
      "mw.a.194": " 把 key）",
      "mw.a.195": "（检查 key 或地址）",
      "mw.a.196": "请求失败：",
      "mw.a.197": "已保存 ",
      "mw.a.198": " 个模型",
      "mw.a.199": " 个模型缺参数",
      "mw.a.200": " → 已写入 models.json，立即生效",
      "mw.a.201": "已保存「",
      "mw.a.202": "保存失败：",
      "mw.a.203": "删除 provider ",
      "mw.a.204": "已删除 ",
      "mw.a.205": "失败：",
      "mw.a.206": "删除失败：",
      "mw.a.207": " 模型",
      "mw.a.208": " · token 已更新",
      "mw.a.209": " · 已从 ",
      "mw.a.210": " 改名",
      "mw.a.211": "已编辑「",
      "mw.a.212": "已拉取 ",
      "mw.a.213": " 个可选模型 —— ✨ 发现 ",
      "mw.a.214": " 个新模型，已自动勾选（带「新」标），点保存即可启用",
      "mw.a.215": " 个可选模型（已保留原勾选 ",
      "mw.a.216": " 个）—— 勾选后点保存",
      "mw.a.217": "刷新模型失败：",
      "mw.a.218": "一键整理就绪：已按检查结果取消勾选 ",
      "mw.a.219": " 个硬性异常模型（key 不对/欠费/不存在等）——核对后点「保存」生效；限流/未测/暂时性错误默认保留",
      "mw.a.220": "一键整理：没有发现硬性异常模型（限流/未测/暂时性错误均保留）——如需调整可逐家「编辑」",
      "mw.a.221": "一键整理完成：",
      "mw.a.222": " 个 provider 已保存，移除 ",
      "mw.a.223": " 个异常模型（代理已刷新，立即生效）",
      "mw.a.224": "已取消一键整理（未保存任何改动）",
      "mw.a.225": "[aiti-model-wizard] 一键整理应用失败",
      "mw.a.226": "测试失败",
      "mw.a.227": "add 失败",
      "mw.a.228": "删除失败",
      "mw.a.229": "切换失败",
      "mw.a.230": "列表已刷新 · 代理已刷新",
      "mw.a.231": "列表已刷新，代理刷新失败：",
      "mw.a.232": "▾ 收起",
      "mw.a.233": "多 Key 轮转",
      "mw.a.234": " 把）",
      "mw.a.235": "① 重新读取 models.json 的 key 列表（外部改动立即可见）② 刷新运行中代理（立即生效）",
      "mw.a.236": "key 名称（轮转/识别用）",
      "mw.a.237": "当前 ",
      "mw.a.238": "（留空=保留）",
      "mw.a.239": "每分钟请求上限（可选）",
      "mw.a.240": "间隔ms·0=突发",
      "mw.a.241": "等间距节流（默认匀速）三种填法：\\n① 留空 = auto：按 rpm 自动折算（60000÷rpm，rpm30→每2s一个），默认\\n② 0 = 关闭匀速：仅 rpm 滑动窗口（突发模式，允许瞬间打满配额）\\n③ 数字 = 固定间隔毫秒（如 2000 = 每2s一个）\\n与 rpm 同时生效，取最大等待",
      "mw.a.242": "保存修改（改名/换 key/改 rpm/改间隔，立即写入 models.json）",
      "mw.a.243": "无改动",
      "mw.a.244": "临时禁用中（不参与轮转，配置未删除）——点击重新启用",
      "mw.a.245": "临时禁用此 key（不参与轮转，配置未删除，随时可一键启用）",
      "mw.a.246": "删除此 key（立即写入 models.json）",
      "mw.a.247": "名（默认自动 key-N）",
      "mw.a.248": "新 API key（sk-…）",
      "mw.a.249": "等间距节流：留空 = auto（按 rpm 折算，默认匀速）；0 = 突发滑窗；数字 = 固定毫秒",
      "mw.a.250": "实测验证 maxTokens 上限…",
      "mw.a.251": "元数据虚报，已自动下调并回写",
      "mw.a.252": "实测失败",
      "mw.a.253": "模型（",
      "mw.a.254": " 已选 / ",
      "mw.a.255": " 可选",
      "mw.a.256": "过滤可选模型",
      "mw.a.257": "勾选当前筛选出的全部（保留筛选外已选）",
      "mw.a.258": "当前筛选范围内反选",
      "mw.a.259": "取消当前筛选范围内的勾选（筛选外不受影响）",
      "mw.a.260": "查看 ",
      "mw.a.261": " 参数（目录反填，未配置也可看）",
      "mw.a.262": "查看/编辑完整参数（窗口/上下文/成本等）",
      "mw.a.263": "临时禁用此模型（从可用列表隐藏、组合成员跳过，不删除配置）",
      "mw.a.264": "重新启用此模型（恢复可见）",
      "mw.a.265": "移除 ",
      "mw.a.266": "添加模型 id（逗号分隔，如 glm-4.7,kimi-k3）",
      "mw.a.267": "保留原 key（",
      "mw.a.268": "粘贴新 key / ENV_NAME / !cmd",
      "mw.a.269": "目录模型 ",
      "mw.a.270": "官网文档",
      "mw.a.271": "注册账号",
      "mw.a.272": "获取 Token",
      "mw.a.273": "连接中断",
      "mw.a.274": " 分 key 测试：",
      "mw.a.275": " 可用",
      "mw.a.276": "🟡 通过（429 限流）——key/端点正确，稍后重试即可 · ",
      "mw.a.277": "通过（HTTP ",
      "mw.a.278": "失败（HTTP ",
      "mw.a.279": "Claude Pro/Max 订阅 · claude.ai 账号授权",
      "mw.a.280": "ChatGPT Plus/Pro 订阅 · OpenAI 官方背书第三方接入",
      "mw.a.281": "GitHub Copilot 订阅 · github.com 授权",
      "mw.a.282": "xAI Grok/X Premium 订阅",
      "mw.a.283": "OpenRouter 账号授权（PKCE，充值计费）",
      "mw.a.284": "Radius 动态网关",
      "mw.a.285": "Kimi Code 订阅 · auth.kimi.com 设备码登录",
      "mw.a.286": "Qoder 国际订阅 · 浏览器设备码 / PAT。Free 无 credits，付费额度才可推理",
      "mw.a.287": "Qoder CN 国内 · Pro+ credits 在此区。PAT 入口：账号页 → 集成；本机 qoderclicn 登录可自动导入。仅限本人自用",
      "mw.a.288": "先填 API Key",
      "mw.a.289": "已保存（auth.json）——模型清单已生效",
      "mw.a.290": "已移除——该 provider 模型已下线",
      "mw.a.291": "已配置",
      "mw.a.292": "未配置",
      "mw.a.293": "输入新 key 更换…",
      "mw.a.294": "移除该 provider 的 key（auth.json），其全部模型立即不可用",
      "mw.a.295": "移除",
      "mw.a.296": " 参数（目录反填，只读）",
      "mw.a.297": " 个）",
      "mw.a.298": "订阅登录型提供商（",
      "mw.a.299": "）—— 无需 API token，点登录获取凭据",
      "mw.a.300": "OAuth 登录",
      "mw.a.301": "查看登录状态 / 账号 / credits",
      "mw.a.302": "收起",
      "mw.a.303": "详情",
      "mw.a.304": "登出：清除该 provider 的登录凭据（auth.json），其全部模型立即不可用；可随时重新登录",
      "mw.a.305": "登出中…",
      "mw.a.306": " · 到期 ",
      "mw.a.307": "额外购买的加量包",
      "mw.a.308": "（已用 ",
      "mw.a.309": "专属资源包（选定系列模型时优先抵扣）",
      "mw.a.310": "API Key 型提供商（",
      "mw.a.311": "）—— key 存 auth.json（pi 托管）",
      "mw.a.312": "1 个模型",
      "mw.a.313": " · 也可订阅登录",
      "mw.a.314": "刷新信息",
      "mw.a.315": "刷新状态",
      "mw.a.316": "登出：清除该 provider 的登录凭据（auth.json），其全部模型立即不可用",
      "mw.a.317": "留空直接提交 = 浏览器登录",
      "mw.a.318": "请选择：",
      "mw.a.319": "（pi 内置 · 托管凭据）",
      "mw.a.320": "用当前地址 + token/请求头重新探测 api 类型与真实地址（漏 /v1 /v2 也能补）",
      "mw.a.321": "探测",
      "mw.a.322": "pi 的 Anthropic 请求 = baseUrl + /v1/messages；base 带 /v1 会变成 /v1/v1/messages（404）。建议去掉尾部 /v1。",
      "mw.a.323": "仅本 provider 的请求携带（如 User-Agent / x-opencode-session）；空行忽略",
      "mw.a.324": "提供商名称",
      "mw.a.325": "写入 models.json 的标识 · 自动生成可改",
      "mw.a.326": "provider 名（用于 models.json 标识）",
      "mw.a.327": "凭据与连接测试",
      "mw.a.328": "支持字面量（sk-…）· 环境变量名 · !命令",
      "mw.a.329": "已连通",
      "mw.a.330": "未通过",
      "mw.a.331": "粘贴 API token —— 仅用于测试/保存，不回显",
      "mw.a.332": "顶部 token + 下方多 key 行一起逐个串行测，每把单独出结果",
      "mw.a.333": "等间距节流（默认匀速）三种填法：留空 = auto（按 rpm 折算 60000÷rpm，rpm30→每2s）；0 = 关闭匀速（突发滑窗）；数字 = 固定间隔毫秒。与 rpm 取最大等待",
      "mw.a.334": "删除此 key",
      "mw.a.335": "选择模型",
      "mw.a.336": "勾选要启用的模型 · 👁 可看参数详情",
      "mw.a.337": "用已填凭据（token + 多 key 行）逐把拉厂商 /models 实时列表，任一把成功即用（目录旧也能补全）",
      "mw.a.338": "拉取中…",
      "mw.a.339": "已选 ",
      "mw.a.340": "搜索过滤模型（如 glm / flash / free…）",
      "mw.a.341": "筛中 ",
      "mw.a.342": " 参数（窗口/能力/价格，目录反填；未收录按同 id 跨网关互证）",
      "mw.a.343": "手动补充模型 id（逗号分隔，如 deepseek-chat,deepseek-reasoner）",
      "mw.a.344": "先在 ③ 勾选模型",
      "mw.a.345": " · 多 key ",
      "mw.a.346": " · ⚠️ 未填凭据（同名校已存 key 会保留）",
      "mw.a.347": "保存 ",
      "mw.a.348": "保存到配置",
      "mw.a.349": "导出失败：",
      "mw.a.350": "已导出 ",
      "mw.a.351": " 个 provider（无明文 key）",
      "mw.a.352": " · 聚合组 ",
      "mw.a.353": " 个未含",
      "mw.a.354": "JSON 解析失败：",
      "mw.a.355": "预览失败：",
      "mw.a.356": "已导入 ",
      "mw.a.357": " 个 provider（/undo 可一步回整批）",
      "mw.a.358": "导入失败：",
      "mw.a.359": "新增",
      "mw.a.360": "覆盖",
      "mw.a.361": "冲突",
      "mw.a.362": "差异预览：",
      "mw.a.363": " 条（新增 ",
      "mw.a.364": " · 覆盖 ",
      "mw.a.365": " · 冲突 ",
      "mw.a.366": "）。确认后走批量保存，/undo 可一步回整批。",
      "mw.a.367": "导入中…",
      "mw.a.368": "确认导入（",
      "mw.a.369": " 条）",
      "mw.a.370": " · 模型 ",
      "mw.a.371": " · 已填 token",
      "mw.a.372": " 把（随保存写入）",
      "mw.a.373": "最近测试失败：",
      "mw.a.374": "先测试",
      "mw.a.375": "仍要保存（禁用态）",
      "mw.a.376": "确认保存",
      "mw.a.377": " 品牌：",
      "mw.a.378": "OpenAPI 声明",
      "mw.a.379": "模型前缀",
      "mw.a.380": "未匹配目录",
      "mw.a.381": "品牌：",
      "mw.a.382": "疑似：",
      "mw.a.383": "地址匹配",
      "mw.a.384": "同域名（可能是其它套餐）",
      "mw.a.385": "模型列表已拉取（",
      "mw.a.386": " 个）—— 在下方「③ 选择模型」勾选即可",
      "mw.a.387": "模型列表：",
      "mw.a.388": "验证中…",
      "mw.a.389": "服务端错误 ",
      "mw.a.390": "网络错误",
      "mw.a.391": "全部目录（",
      "mw.a.392": " 家 · models.dev 无细分分类，按首字符分组；点「＋ 添加」直接接入）",
      "mw.a.393": "过滤提供商（中英文名 / ID / API 地址）",
      "mw.a.394": " 家",
      "mw.a.395": "展开基本信息与模型列表",
      "mw.a.396": "打开官网/文档（新窗口）",
      "mw.a.397": "打开注册页（新窗口）",
      "mw.a.398": "打开取 token 页（新窗口）",
      "mw.a.399": "点击选用该提供商接入",
      "mw.a.400": "清空当前选择，重新搜索 / 换一家",
      "mw.a.401": "搜索提供商",
      "mw.a.402": "中英文名 / 别名 / 模型 id；贴 API 地址自动反向匹配+探测（漏 /v1 /v2 也能补）",
      "mw.a.403": "DeepSeek / 智谱 GLM / qwen… 或贴 https://api.xxx.com/v1",
      "mw.a.404": "搜…",
      "mw.a.405": "不搜索直接手工添加自定义端点（Base URL / API 类型 / 请求头）",
      "mw.a.406": "刚刚更新",
      "mw.a.407": " 小时前",
      "mw.a.408": " 天前",
      "mw.a.409": "目录 ",
      "mw.a.410": " 家 · models.dev ",
      "mw.a.411": "缓存",
      "mw.a.412": "内嵌快照（旧，启动时自动拉新）",
      "mw.a.413": "未缓存",
      "mw.a.414": " · ⚠ 已超 TTL（保存未知模型时会自动强刷，或点右侧手动刷新）",
      "mw.a.415": "（搜索为空时点右侧按钮拉取）",
      "mw.a.416": "重新下载 models.dev 目录（官方 + Gitee 镜像竞速）",
      "mw.a.417": "↻ 刷新目录",
      "mw.a.418": "浏览目录全部提供商（按首字符分组展开，点添加直接接入）",
      "mw.a.419": "▾ 收起目录",
      "mw.a.420": "浏览目录",
      "mw.a.421": "点选下方套餐接入",
      "mw.a.422": "通过本链接注册，双方得免费额度（新窗口）",
      "mw.a.423": " 地址反向命中 ",
      "mw.a.424": "pi 内置 provider · ",
      "mw.a.425": " 个模型 · 填 API Key 接入",
      "mw.a.426": "已知模型 ",
      "mw.a.427": "点击查看详情",
      "mw.a.428": "反向匹配候选",
      "mw.a.429": "目录 · 100=地址完全一致 · 30=同域名其它套餐/版本，以探测结果为准",
      "mw.a.430": "（匹配度 ",
      "mw.a.431": "无 key 探测只能判断 api 类型，真实版本路径（/v1 /v2 /v3）可能不准；key 只用于探测，不回传",
      "mw.a.432": "精探中…",
      "mw.a.433": "带 key 精探",
      "mw.a.434": "不搜索也能直接进入自定义端点面板（Base URL / API 类型 / 请求头）",
      "mw.a.435": "目录没收录？贴过地址？都从这里进：手工填 Base URL / API 类型 / 请求头，无需目录匹配",
      "mw.a.436": "搜索 provider / 模型 id…（多词空格分隔）",
      "mw.a.437": "清除搜索",
      "mw.a.438": "逐个已配置 provider 发一个真实探针（跳过聚合组/禁用/无凭据；结论留存，树上/详情显示延迟）",
      "mw.a.439": "体检中…",
      "mw.a.440": "已配置 · ",
      "mw.a.441": " · 过滤 ",
      "mw.a.442": "运行期错误观测（带外）：代理真实流量里的非 2xx/3xx（429 限流/402 欠费/401 key 无效/5xx 等，带 key 归因），未探测也能看到",
      "mw.a.443": "无匹配「",
      "mw.a.444": " · 测于 ",
      "mw.a.445": "429 限流（key/端点正确）",
      "mw.a.446": "通过",
      "mw.a.447": "向导测试：",
      "mw.a.448": "部分 key 失败",
      "mw.a.449": "失败",
      "mw.a.450": "余额不足",
      "mw.a.451": "临时禁用中（配置未删除，点击详情页可重新启用）",
      "mw.a.452": " 把 key 临时禁用中（详情页「多 Key 轮转」可启用）",
      "mw.a.453": "临时禁用中（未删除，详情页可重新启用）",
      "mw.a.454": "实测最大输出中",
      "mw.a.455": "实测已校正 maxTokens",
      "mw.a.456": "实测通过",
      "mw.a.457": "● 可用",
      "mw.a.458": "● 限流",
      "mw.a.459": "● 异常（可能欠费/失效）",
      "mw.a.460": " 运行",
      "mw.a.461": "需先启用 aiti-model-check（扩展管理）",
      "mw.a.462": "探测此模型可用性",
      "mw.a.463": " 限流",
      "mw.a.464": " 异常",
      "mw.a.465": " 待测试",
      "mw.a.466": " 模型运行异常 ×",
      "mw.a.467": " 模型 · 扩展动态注册（只读）",
      "mw.a.468": " 模型 · ",
      "mw.a.469": "已配 key",
      "mw.a.470": "无 key",
      "mw.a.471": "有 ",
      "mw.a.472": " 把 key 临时禁用中（不参与轮转，配置未删除）——展开下方「多 Key 轮转」可查看 / 一键启用",
      "mw.a.473": "上次向导测试：",
      "mw.a.474": "尚未用向导测过该 provider",
      "mw.a.475": "未测",
      "mw.a.476": "🟡 429 通过",
      "mw.a.477": "🟡 部分 key 失败",
      "mw.a.478": "用已存凭据发一个真实探针（多 key 逐把测）；结论自动留存并更新树上徽标",
      "mw.a.479": "重测",
      "mw.a.480": "已用 ",
      "mw.a.481": "余 ",
      "mw.a.482": "限 ",
      "mw.a.483": "\\n更新于 ",
      "mw.a.484": "（服务端缓存 5 分钟）",
      "mw.a.485": "额度受限：",
      "mw.a.486": "余额：",
      "mw.a.487": "已欠费/余额不足",
      "mw.a.488": "存在异常模型（可能欠费/失效）",
      "mw.a.489": "正常",
      "mw.a.490": "发起可用性探测（更新树上的 可用/限流/异常 标记，可能需数十秒）",
      "mw.a.491": "刷新该 provider 的运行中代理（改 models.json / 多 key 后立即生效，不重启会话）",
      "mw.a.492": "临时禁用中——模型已从列表隐藏、代理已停（配置未删除）。点击重新启用",
      "mw.a.493": "临时禁用（不删除配置）：模型从列表隐藏、代理停止，随时可一键启用",
      "mw.a.494": "▶ 启用",
      "mw.a.495": "禁用",
      "mw.a.496": "删除 provider",
      "mw.a.497": "还没有配置任何 provider —— 点下方按钮搜索或贴 API 地址添加。models.json：",
      "mw.a.498": "一键整理（基于 ",
      "mw.a.499": " 模型检查）：已按探测结果预选——硬性异常取消勾选，限流/未测/暂时性错误保留",
      "mw.a.500": "保存中 ",
      "mw.a.501": "逐个保存有改动的 provider（写 models.json + 刷新代理，立即生效）",
      "mw.a.502": "没有需要保存的改动（无硬性异常模型）",
      "mw.a.503": "全部保存（",
      "mw.a.504": " 家有改动）",
      "mw.a.505": "放弃本次预选（不保存任何改动）",
      "mw.a.506": "保留 ",
      "mw.a.507": "保存后将从 models.json 删除：",
      "mw.a.508": " 等",
      "mw.a.509": "暂时性错误（服务端/网络/超时类），默认保留——如确认不再需要，可在编辑区手工取消勾选：",
      "mw.a.510": "暂时异常 ",
      "mw.a.511": " 保留",
      "mw.a.512": "该 provider 下所有模型都是硬性异常：请检查 key/余额后重测，或确认后整家删除",
      "mw.a.513": "展开该 provider 编辑区（已按预选勾好，可再调整后保存）",
      "mw.a.514": "发现 ",
      "mw.a.515": " 个新模型",
      "mw.a.516": "清除提醒，不再标注这些新模型",
      "mw.a.517": " · 新增 ",
      "mw.a.518": "勾选全部新模型",
      "mw.a.519": "在全部新模型范围内反选",
      "mw.a.520": "全部取消勾选（不启用）",
      "mw.a.521": "启用中…",
      "mw.a.522": "启用所选",
      "mw.a.523": "展开编辑该 provider（可看全部模型/改 key）",
      "mw.a.524": "忽略该 provider 的这些新模型（其他 provider 下次继续提醒）",
      "mw.a.525": "已配置 ",
      "mw.a.526": " 个 provider · ",
      "mw.a.527": "撤销上次保存（",
      "mw.a.528": "）——恢复保存前的 provider 条目",
      "mw.a.529": "从 models.json 重新加载所有运行中代理的槽位配置（多 key / 聚合改动后立即生效，不重启会话）",
      "mw.a.530": "已完成",
      "mw.a.531": "至少一个成员",
      "mw.a.532": "所有成员已禁用——至少保留一个启用的成员（临时全停请用聚合组级禁用）",
      "mw.a.533": "存在已失效的成员引用",
      "mw.a.534": "跨协议成员（",
      "mw.a.535": "）——仅支持同协议聚合",
      "mw.a.536": "上下文窗口悬殊（最矮 < 最高一半）：取最小值，长会话可能提前裁剪",
      "mw.a.537": "最大输出差异 >20%：取最小值",
      "mw.a.538": "能力不一致（部分成员无 vision）：带图请求会自动避开无 vision 成员",
      "mw.a.539": "全部成员均无 vision：不能处理图片输入",
      "mw.a.540": "无成员承接纯文本请求（全部仅图形/仅媒体）：不带图的会话将无可用成员——确认仍要保存？",
      "mw.a.541": "聚合组已保存：",
      "mw.a.542": " 个虚拟模型）——已刷新运行中代理，新会话模型列表立即可见",
      "mw.a.543": "显示名（如：快速组）",
      "mw.a.544": "留空=同显示名",
      "mw.a.545": "如 fast",
      "mw.a.546": "协议 ",
      "mw.a.547": "混合协议",
      "mw.a.548": "临时禁用中（此虚拟模型从列表隐藏，配置未删除）——点击重新启用",
      "mw.a.549": "临时禁用此虚拟模型（从模型列表隐藏，不删除配置，随时可启用）",
      "mw.a.550": "输出 ⌊",
      "mw.a.551": "能力 ",
      "mw.a.552": "粘性 TTL ",
      "mw.a.553": "粘性 TTL 15min(默认)",
      "mw.a.554": "临时禁用中（不参与路由，配置未删除）",
      "mw.a.555": "上下文最短：把组合 contextWindow 拉低到 ",
      "mw.a.556": "（长会话可能提前裁剪）",
      "mw.a.557": "最大输出最小：",
      "mw.a.558": "无 vision：带图请求会自动避开它",
      "mw.a.559": "已失效",
      "mw.a.560": "上下文窗口",
      "mw.a.561": "最大输出",
      "mw.a.562": "默认 10；按权重占比随机选点（成员级）",
      "mw.a.563": "该成员承接哪些请求类别（按模型能力自动过滤：没声明的能力不显示可勾选项；全部勾选 = 承接全部，与不限定等价）",
      "mw.a.564": "文本",
      "mw.a.565": "取消 = 该成员只接带图请求（仅图形）",
      "mw.a.566": "基础类别：所有模型都处理纯文本，不可取消",
      "mw.a.567": "图形",
      "mw.a.568": "取消 = 该成员不收带图请求（仅文本）",
      "mw.a.569": "全部可勾类别已勾选 = 承接全部请求（与不限定等价；将来新增类别自动承接）",
      "mw.a.570": "临时禁用此成员（不参与路由，配置未删除，随时可启用）",
      "mw.a.571": "重新启用此成员（恢复参与路由）",
      "mw.a.572": "从 models.json 重新加载所有运行中代理的槽位配置（聚合/多key 改动后立即生效，不重启会话）",
      "mw.a.573": "已刷新代理：",
      "mw.a.574": "(无)",
      "mw.a.575": "刷新失败: ",
      "mw.a.576": " 个虚拟模型 · 协议 ",
      "mw.a.577": "临时禁用中（模型从列表隐藏、代理已停，配置未删除）——点击重新启用",
      "mw.a.578": "临时禁用整个聚合组（不删除配置，模型从列表隐藏、代理停止，随时可一键启用）",
      "mw.a.579": "删除聚合组",
      "mw.a.580": "媒体",
      "mw.a.581": "安装中…",
      "mw.a.582": "安装",
      "mw.a.583": "重新安装最新版",
      "mw.a.584": "更新",
      "mw.a.585": "再点一次确认卸载",
      "mw.a.586": "卸载（新会话起不再加载）",
      "mw.a.587": "确认卸载",
      "mw.a.588": "卸载",
      "mw.a.589": "模型列表",
      "mw.a.590": "主视图",
      "mw.a.591": "添加 provider",
      "mw.a.592": "目录/贴地址",
      "mw.a.593": "订阅登录",
      "mw.a.594": "免费模型",
      "mw.a.595": "一键安装",
      "mw.a.596": "模型聚合",
      "mw.a.597": "组合模型",
      "mw.a.598": "模型检查",
      "mw.a.599": "可用性监测",
      "mw.a.600": "功能菜单（切换/返回各功能）",
      "mw.a.601": "订阅",
      "mw.a.602": "免费",
      "mw.a.603": "聚合",
      "mw.a.604": "检查",
      "mw.a.605": "向导设置（新模型提醒 / 目录 / 探测与测试超时）",
      "mw.a.606": "导出 provider 配置（脱敏 JSON——无明文 key，P2-A）",
      "mw.a.607": "导入 provider 配置（差异预览 + 批量保存，可 undo）",
      "mw.a.608": "返回模型列表",
      "mw.a.609": "添加 provider（目录搜索 / 贴地址）",
      "mw.a.610": "关闭模型管理面板",
      "mw.a.611": " 个模型在所有数据源都查不到参数（已落裸条目，pi 按 128k/16k 硬默认用）：",
      "mw.a.612": "已自动唤起 AI 助手（skill：model-params-fill）正在上网查权威数据 → 写入 ~/.pi/agent/models-store.json → 回填参数弹窗。AI 完成后打开各模型「✎ 编辑参数」核对并保存；下次保存会自动反填。",
      "mw.a.613": "重新弹出 AI 助手",
      "mw.a.614": "模型管理",
      "mw.a.615": "所有模型都不可用",
      "mw.a.616": "还没有可用模型",
      "mw.a.617": " · 运行期被大量 429 阻断标记",
      "mw.a.618": "）检查记录看恢复时间，或换个模型",
      "mw.a.619": "各模型均不可用（429 限流 / 出错），检查记录看恢复时间，或换个模型",
      "mw.a.620": "添加 AI 提供商：搜索或贴 API 地址 → 填 token → 测试 → 选模型",
      "mw.a.621": "去换模型",
      "mw.a.622": "去添加",
      "mw.a.623": " 个新模型（",
      "mw.a.624": "）· 点击查看",
      "mw.a.625": "知道了，不再提醒",
      "mw.a.626": "沿用当前配置中的已知差异（增减成员或出现新的差异类别时需重新确认）",
      "mw.a.627": "留空则用聚合组名称；模型列表显示为 <id>/<模型>",
      "mw.a.628": " 个成员引用",
      "mw.a.629": " 个禁用",
      "mw.tx.210": "虚拟模型 id 不能为空",
      "mw.tx.211": "虚拟模型 id 重复",
      "mw.tx.212": "保存前需修正以下问题",
      "mw.tx.213": "可保存",
      "mw.tx.214": "正在保存…",
      "mw.tx.215": "全部接受",
      "mw.tx.216": "聚合组信息",
      "mw.tx.217": "虚拟模型与成员",
      "mw.tx.218": "聚合组名称显示在选择器的分组标题上；provider id 是内部标识（模型列表里显示为 id/模型）",
      "mw.tx.219": "每个虚拟模型对外是一个可选模型；成员是实际承接请求的真实模型——权重决定分流比例",
      "mw.tx.220": "虚拟模型",
      "mw.tx.221": "成员",
      "mw.tx.222": "按权重分流 · 「承接」控制哪些请求会发给它",
      "mw.tx.223": "添加成员",
      "mw.tx.224": "收起",
      "mw.tx.225": "高级：粘性 TTL（分钟，默认 15）",
      "mw.tx.226": "成员必须来自已配置的真实模型：先在「模型列表」加好 provider，再回这里为虚拟模型挑选成员。",
      "mw.tx.1": "正在逐 provider 串行探测（每家最长约 12 秒；跳过聚合组/禁用/无凭据）……测完自动出报告并留存结论。",
      "mw.tx.2": "去修",
      "mw.tx.3": "↻ 重跑体检",
      "mw.tx.4": "完成",
      "mw.tx.5": "向导设置",
      "mw.tx.6": "加载中…",
      "mw.tx.7": "新模型检测与提醒",
      "mw.tx.8": "目录（models.dev）",
      "mw.tx.9": "主源 URL",
      "mw.tx.10": "镜像 URL（竞速兜底）",
      "mw.tx.11": "探测与测试",
      "mw.tx.12": "取消",
      "mw.tx.13": "提交",
      "mw.tx.14": "← 返回",
      "mw.tx.15": "AI 帮我补参数（查权威数据 → 写 models-store）",
      "mw.tx.16": "只读 · 目录反填",
      "mw.tx.17": "编辑",
      "mw.tx.18": "显示名",
      "mw.tx.19": "最大输出 maxTokens",
      "mw.tx.20": "推理（reasoning）",
      "mw.tx.21": "图片输入",
      "mw.tx.22": "（跟随 provider）",
      "mw.tx.23": "Base URL 覆盖（留空=跟随 provider）",
      "mw.tx.24": "图片大小上限（字节，留空=默认 4.5MiB）",
      "mw.tx.25": "单张图片 base64 后的上限 ·",
      "mw.tx.26": "成本（$/M tokens，四项都填才生效）",
      "mw.tx.27": "思考级别映射（留空=删除该级）",
      "mw.tx.28": "DeepSeek 思考兼容",
      "mw.tx.29": "支持 developer 角色",
      "mw.tx.30": "请求头（模型级，空行忽略）",
      "mw.tx.31": "＋ 加一行",
      "mw.tx.32": "清除已存请求头",
      "mw.tx.33": "刷新",
      "mw.tx.34": "多个 key 自动轮转分摊限流 · 每把可设 rpm 上限 + 等间距间隔（留空=auto 按 rpm 折算 · 0=突发滑窗 · 数字=毫秒）· 刷新 = 重读列表 + 刷新代理",
      "mw.tx.35": "（还没有多 key —— 下方添加）",
      "mw.tx.36": "＋ 添加",
      "mw.tx.37": "名称（改后即重命名 provider）",
      "mw.tx.38": "收起列表",
      "mw.tx.39": "全选",
      "mw.tx.40": "反选",
      "mw.tx.41": "清空",
      "mw.tx.42": "新",
      "mw.tx.43": "（无匹配）",
      "mw.tx.44": "（无模型）",
      "mw.tx.45": "连接配置",
      "mw.tx.46": "API 类型",
      "mw.tx.47": "API Key（留空=保留原 key；支持字面量 / 环境变量名 /",
      "mw.tx.48": "!命令",
      "mw.tx.49": "请求头（provider 级；不改则保留已存）",
      "mw.tx.50": "测试连接（全部已存 key）",
      "mw.tx.51": "逐个串行测 models.json 已配的多把 key（非只第一个），每把单独出结果",
      "mw.tx.52": "保存（模型 + 配置）",
      "mw.tx.53": "· 运行时实时",
      "mw.tx.54": "· ⚠ 目录静态清单",
      "mw.tx.55": "未发现订阅登录型提供商。",
      "mw.tx.56": "刷新列表",
      "mw.tx.57": "这些提供商走订阅/OAuth 登录（凭据存 auth.json 自动刷新），与 token 型 provider 并列使用。仅限本人账号自用，禁止共享/转售。",
      "mw.tx.58": "已登录",
      "mw.tx.59": "额度已用完",
      "mw.tx.60": "未登录 —— 点「登录」开始",
      "mw.tx.61": "pi 内置 provider（openai / anthropic / google 等）的 API key 管理入口：保存后模型清单由 pi 内置目录自动加载，与订阅登录型并列；已配置的在左树/选择器直接可见。",
      "mw.tx.62": "没有 apiKey 型内置 provider（本机 pi 版本未声明，或全部已由自定义 provider 覆盖）。",
      "mw.tx.63": "订阅登录型 · 无需 API token",
      "mw.tx.64": "订阅制提供商：点「登录」获取凭据（自动存入 auth.json 并刷新，无需手动保存）。仅限本人账号自用，禁止共享/转售。",
      "mw.tx.65": "未登录",
      "mw.tx.66": "加量包",
      "mw.tx.67": "该账号无 credits 信息（Free 账号或接口不可用）",
      "mw.tx.68": "连接登录服务…",
      "mw.tx.69": "登录成功！上方已显示账号与可用模型。",
      "mw.tx.70": "key 保存进 auth.json（pi 托管，同订阅登录型位置）；模型清单由 pi 内置目录自动加载，无需手选。需要自定义 baseUrl / 多 key 轮转请改用「🛠 自定义端点」。",
      "mw.tx.71": "保存后回「模型列表」即可看到该 provider 与其全部模型。",
      "mw.tx.72": "连接配置（自定义端点）",
      "mw.tx.73": "Anthropic 的 Base URL 不要带尾部 /v1（运行时会在其后拼 /v1/messages）",
      "mw.tx.74": "请求头（可选）",
      "mw.tx.75": "测试连接",
      "mw.tx.76": "环境变量名（如 OPENROUTER_KEY）或",
      "mw.tx.77": "（取 stdout）：保存时原样写入 models.json 由 pi 解析",
      "mw.tx.78": "多 Key 自动轮转",
      "mw.tx.79": "亮点",
      "mw.tx.80": "多把 key 分摊限流、用尽自动切换 · 每把可设 rpm 上限 + 等间距间隔（留空=auto · 0=突发 · 数字=毫秒）",
      "mw.tx.81": "＋ 添加一把 key",
      "mw.tx.82": "刷新模型",
      "mw.tx.83": "暂无已知模型 —— 填好 token 点「测试连接」或「刷新模型」自动拉取 /models 列表（目录列表可能过时，以实时拉取为准）",
      "mw.tx.84": "⇪ 导入 provider 配置",
      "mw.tx.85": "粘贴导出的 JSON（⇩ 导出文件；无明文 key——导入后现有 key 保留，缺 key 的新 provider 落禁用态需补 key）。也可选本地文件：",
      "mw.tx.86": "解析预览",
      "mw.tx.87": "保留现有 key",
      "mw.tx.88": "无可导入条目",
      "mw.tx.89": "返回修改",
      "mw.tx.90": "确认保存 —— 提供商名称",
      "mw.tx.91": "名称（自动生成，可修改；用于 models.json 标识）",
      "mw.tx.92": "尚未测试——保存后立即生效，建议先测一次",
      "mw.tx.93": "用此端点继续",
      "mw.tx.94": "目录未加载 —— 点「↻ 刷新目录」拉取 models.dev 后重试",
      "mw.tx.95": "无匹配提供商",
      "mw.tx.96": "国内",
      "mw.tx.97": "加载模型列表…",
      "mw.tx.98": "官网/文档",
      "mw.tx.99": "注册",
      "mw.tx.100": "取 token",
      "mw.tx.101": "（目录无已知模型——添加后可用「刷新模型」实时拉取 /models）",
      "mw.tx.102": "更换",
      "mw.tx.103": "搜索",
      "mw.tx.104": "＋ 自定义",
      "mw.tx.105": "热门提供商（点下方套餐直接接入；多形态选对应套餐）",
      "mw.tx.106": "官网",
      "mw.tx.107": "有礼",
      "mw.tx.108": "目录未命中 —— 贴完整 API 地址会自动反向匹配+自动探测",
      "mw.tx.109": "pi 内置",
      "mw.tx.110": "无 key 仅判断 api 类型，填 key 精探更准",
      "mw.tx.111": "自定义端点（手工配置）",
      "mw.tx.112": "进入",
      "mw.tx.113": "检查未启用——可用性/余额不可见。请在「扩展管理」启用 aiti-model-check 后刷新。",
      "mw.tx.114": "异常/欠费",
      "mw.tx.115": "运行异常",
      "mw.tx.116": "无标 = 未测",
      "mw.tx.117": "运行时",
      "mw.tx.118": "← 从左侧选择 provider / 模型查看与编辑详情",
      "mw.tx.119": "检查未启用",
      "mw.tx.120": "重检",
      "mw.tx.121": "运行时注册",
      "mw.tx.122": "检查未启用（启用 aiti-model-check 后显示可用性）",
      "mw.tx.123": "未检查",
      "mw.tx.124": "尚未测试连接（点右侧「测试」验证 key/端点，结论将留存）",
      "mw.tx.125": "余额查询中…",
      "mw.tx.126": "余额暂不可用",
      "mw.tx.127": "重查",
      "mw.tx.128": "聚合组成员 / 权重 / 粘性在「模型聚合」页编辑",
      "mw.tx.129": "去编辑",
      "mw.tx.130": "登录态 / 账号额度在「订阅服务」页管理",
      "mw.tx.131": "去管理",
      "mw.tx.132": "运行时注册 provider：由 pi 扩展（如 pi-freeflow）动态注册，模型经 /api/models 实时可见；不受 models.json 管理，这里只读展示。",
      "mw.tx.133": "＋ 添加 provider",
      "mw.tx.134": "聚合组——不参与（在「聚合」页管理）",
      "mw.tx.135": "订阅登录——不参与（凭据由登录流程管理）",
      "mw.tx.136": "运行时注册——不参与（由扩展动态注册，只读）",
      "mw.tx.137": "已保存",
      "mw.tx.138": "全部硬性异常——未预选（编辑区手工处理）",
      "mw.tx.139": "知道了",
      "mw.tx.140": "忽略",
      "mw.tx.141": "↩ 撤销上次保存",
      "mw.tx.142": "刷新代理",
      "mw.tx.143": "← 返回列表",
      "mw.tx.144": "虚拟模型 = 多个真实成员组成一个可调用模型；同会话粘性路由（TTL 内固定同一成员，最大化 prompt cache），429 冷却自动切换",
      "mw.tx.145": "聚合组名称",
      "mw.tx.146": "🔴 显示名 / provider id 至少填一个",
      "mw.tx.147": "虚拟模型 id",
      "mw.tx.148": "删模型",
      "mw.tx.149": "无 vision ⚠",
      "mw.tx.150": "权重",
      "mw.tx.151": "承接",
      "mw.tx.152": "全收",
      "mw.tx.153": "粘性空闲 TTL（分钟，默认 15）",
      "mw.tx.154": "＋ 加一个虚拟模型",
      "mw.tx.155": "保存聚合组",
      "mw.tx.156": "＋ 新建聚合组",
      "mw.tx.157": "把多个真实模型聚成一个虚拟模型暴露给 pi；需要 pi-models-combo 引擎（多 key 代理）在运行时接管路由。同协议才能同组。",
      "mw.tx.158": "还没有聚合组。点「新建聚合组」把已配置的多个模型组合成一个虚拟模型。",
      "mw.tx.159": "已禁用",
      "mw.tx.160": "免费模型来自第三方 pi 扩展，安装即用、无需 API Key；安装后",
      "mw.tx.161": "新会话",
      "mw.tx.162": "生效。",
      "mw.tx.163": "免费 AI 通常是",
      "mw.tx.164": "或",
      "mw.tx.165": "降级",
      "mw.tx.166": "了的，除非赶上新模型测试大放送，一般效果不好——适合试用与轻量任务，重要工作请用付费模型。",
      "mw.tx.167": "暂无免费模型（中心配置为空或加载失败）",
      "mw.tx.168": "已安装 ✓",
      "mw.tx.169": "官网/仓库 ↗",
      "mw.tx.170": "正在加载模型检查（aiti-model-check）…",
      "mw.tx.171": "未能加载模型检查（aiti-model-check 拉起失败，请刷新页面重试）",
      "mw.tx.172": "功能",
      "mw.tx.173": "刷新全部代理",
      "mw.tx.174": "即时生效",
      "mw.tx.175": "导出",
      "mw.tx.176": "导入",
      "mw.tx.177": "添加中",
      "mw.tx.178": "添加",
      "mw.tx.179": "处理中…",
      "mw.tx.180": "重新唤 AI",
      "mw.tx.181": "查看模型检查",
      "mw.tx.182": "点击查看",
      "mw.eb.1": "至少需要保留一个启用的模型。",
      "mw.eb.2": "当前项目的 .pi/settings.json 设置了 enabledModels 并覆盖全局配置，这些开关为只读——请直接修改该文件。",
      "mw.eb.3": "上下文窗口需为正整数 tokens（留空=默认）；非法值未写盘。",
      "mw.eb.4": "保存失败",
      "mw.eb.5": "无法获取模型目录：",
      "mw.eb.6": "已设置 PI_OFFLINE，不会联网获取模型目录。",
      "mw.eb.7": "无法获取模型目录。请检查网络连接和该 provider 的凭据后重试。",
      "mw.eb.8": "已从服务商更新模型列表。",
      "mw.eb.9": "模型列表已是最新。",
      "mw.eb.10": " 条失配",
      "mw.eb.11": "删除匹配不到任何模型的配置条目。没有可用凭证的 provider 的条目会保留，其余也保持不变。",
      "mw.eb.12": "清除所有 provider 的模型筛选。",
      "mw.eb.13": "已启用 ",
      "mw.eb.14": "启用/停用 ",
      "mw.eb.15": " 的全部模型",
      "mw.eb.16": "开启筛选结果",
      "mw.eb.17": "全部开启",
      "mw.eb.18": "关闭筛选结果",
      "mw.eb.19": "全部关闭",
      "mw.eb.20": "立即获取该 provider 当前发布的模型列表。pi 内置的列表固定在 pi-web 附带的 pi 版本上，新发布的模型需要刷新后才会出现。",
      "mw.eb.21": "刷新中…",
      "mw.eb.22": "收起模型行",
      "mw.eb.23": "逐模型开关",
      "mw.eb.24": "筛选 ",
      "mw.eb.25": " 个模型…",
      "mw.eb.26": "筛选可用模型",
      "mw.eb.27": "由 enabledModels 固定的思考等级，需在 settings.json 中修改。",
      "mw.eb.28": "上下文窗口覆盖（tokens），留空使用默认",
      "mw.eb.29": "（当前 ",
      "mw.eb.30": " 的上下文窗口",
      "mw.eb.31": "在模型选择器中显示 ",
      "mw.eb.32": "启用范围读取中…",
      "mw.eb.33": "清理无效条目",
      "mw.eb.34": "启用全部模型",
      "mw.eb.35": "这个 provider 目前没有可用模型。请先保存修改，并确认 API key 有效（或完成登录）。",
      "mw.eb.36": "模型启用范围",
      "mw.eb.37": "刷新目录",
      "mw.eb.38": "没有匹配的模型。",
      "mw.eb.39": "自定义 provider 的模型在「模型」编辑区直接增删；此开关控制整组是否出现在选择器。",
      "mw.tx.183": "Claude 自适应思考（effort 等级）",
      "mw.tx.184": "订阅登录型 provider：凭据由登录流程管理（auth.json、自动刷新），不走 models.json、无 key 可改 —— 下方可直接查看登录态 / 账号 / 额度，需要时重新登录 / 换号。",
      "mw.tx.185": "刷新可选模型",
      "mw.tx.186": "⚠ 这是目录静态清单，运行时未注册「{pid}」的这些 id —— 选择器里可能找不到，点「刷新」也不会变。",
      "mw.tx.187": "同账号其它 provider：",
      "mw.tx.188": "🔐 登录",
      "mw.tx.189": "➕ 加量包",
      "mw.tx.190": "可用模型（{n}）：",
      "mw.tx.191": "🔐 登录 {name}",
      "mw.tx.192": "credits 查询失败：",
      "mw.tx.193": "可用模型（{n} 个，选择器里直接选）",
      "mw.tx.194": "已打开授权页：",
      "mw.tx.195": "登录完成后浏览器会跳到一个打不开的 localhost 地址——把那个完整地址粘贴到这里提交：",
      "mw.tx.196": "打开授权页并输入码 {code}：",
      "mw.tx.197": "保存后刷新页面模型即生效",
      "mw.tx.198": "✅ 最近测试通过",
      "mw.tx.199": "{n}限",
      "mw.tx.200": "🔑⏸ {n} 禁用",
      "mw.tx.201": "🔑 API Key 型内置 provider：凭据存 auth.json（pi 托管）——下方可更换 / 移除；「订阅」页有全部同类 provider 的汇总管理。",
      "mw.tx.202": "预选只改勾选状态，不写配置——逐家或「全部保存」后才写入 models.json 并刷新代理（可撤销：保存后点「↩ 撤销上次保存」）",
      "mw.tx.203": "成员 {id} types 含「图形」但模型不支持图片输入——带图请求仍会被能力过滤排除，该勾选不会生效",
      "mw.tx.204": "模型列表中将显示：",
      "mw.tx.205": "我已知悉上述差异，仍要保存",
      "mw.tx.206": "{n} 项差异待确认",
      "mw.tx.207": "启用后台扫描与提醒",
      "mw.eb.40": "全部启用",
      "mw.eb.41": "上下文窗口（tokens），留空使用默认值；已加载的会话需重启 Pi Web 才会更新。开关 = 在模型选择器中显示/隐藏。",
      "mw.s.addNeedKey": "add 需要 key",
      "mw.s.allCredsFail": "全部 {n} 把凭据均未拉到模型列表",
      "mw.s.balanceFail": "余额查询失败：{err}",
      "mw.s.batchWriteFail": "批量写 models.json 失败: {err}",
      "mw.s.checkupFail": "体检失败: {err}",
      "mw.s.checkupRunning": "体检进行中，请稍候",
      "mw.s.comboEditHint": "「{p}」是模型聚合组——请在 🧙 面板「🧩 模型聚合」中编辑",
      "mw.s.ctxPositive": "上下文窗口需为正整数 tokens（model: {m}）",
      "mw.s.downloadFail": "下载失败",
      "mw.s.extNotInit": "扩展未初始化",
      "mw.s.freePkgInstalled": "已安装，新会话生效",
      "mw.s.freePkgRemoved": "已卸载，新会话起不再加载",
      "mw.s.freePkgUpdated": "已更新，新会话生效",
      "mw.s.fwdFail": "{op}转发失败：{err}",
      "mw.s.importWriteFail": "导入写盘失败: {err}",
      "mw.s.keyDup": "已存在同名 key：{n}",
      "mw.s.keyMissing": "找不到 key：{n}",
      "mw.s.modelMissing": "模型不存在: {id}",
      "mw.s.needBaseUrl": "需要 baseUrl",
      "mw.s.needBaseUrlApi": "需要 baseUrl + api",
      "mw.s.needBaseUrlOrText": "需要 baseUrl 或 text",
      "mw.s.needId": "需要 id",
      "mw.s.needName": "{op} 需要 name",
      "mw.s.needPBA": "需要 provider + baseUrl + api",
      "mw.s.needProvider": "需要 provider",
      "mw.s.needProviderForAllKeys": "allKeys/keyName 需要 provider",
      "mw.s.needProviderModel": "需要 provider + model",
      "mw.s.needProvidersObj": "需要 providers 对象（{名字: {baseUrl, api, models…}}）",
      "mw.s.needSavesArr": "需要 saves 数组",
      "mw.s.needSet": "需要 set",
      "mw.s.noKeysForPull": "该 provider 没有可用的 key（未存储且未填写），无法拉取模型列表",
      "mw.s.noTestableKeys": "没有可测的 key：provider {provider} {keyName}",
      "mw.s.noValidSave": "无有效保存（全部条目失败）",
      "mw.s.oauthNoCombo": "「{p}」是订阅登录型 provider，不能覆盖为聚合组",
      "mw.s.oauthNoDelete": "「{p}」是订阅登录型 provider，不在 models.json 里，无需删除；如需登出请到 pi-web 模型设置操作。",
      "mw.s.oauthNoKeys": "「{p}」是订阅登录型 provider，凭据由登录管理，不支持多 key。",
      "mw.s.oauthNoToggle": "「{p}」是订阅登录型 provider，凭据由登录流程管理（auth.json），不由 models.json 管理，无需禁用/启用。",
      "mw.s.oauthWriteDenied": "「{p}」是订阅登录型 provider，凭据由登录流程管理（auth.json），不能写入 models.json。如需重新登录请打开 🧙 面板 ☰ 功能菜单 →「🔐 订阅」。",
      "mw.s.opInstall": "安装",
      "mw.s.opSignout": "登出",
      "mw.s.probeCapFail": "probe-cap 失败: {err}",
      "mw.s.providerMissing": "provider 不存在: {p}",
      "mw.s.providersEmpty": "providers 为空",
      "mw.s.readCfgFail": "读取配置失败: {err}",
      "mw.s.refreshFail": "刷新失败: {err}",
      "mw.s.skipNoBaseurl": "无法确定 baseUrl，跳过",
      "mw.s.skipNoMaxTokens": "该模型未配置 maxTokens，跳过",
      "mw.s.unknownFreePkg": "未知免费包 id：{id}",
      "mw.s.usageUnavailable": "aiti-provider-usage 未安装或未启用",
      "mw.s.writeCfgFail": "写配置失败",
      "mw.s.writeFail": "写 models.json 失败: {err}",
      "mw.s.writeOverridesFail": "写 modelOverrides 失败: {err}",
      },
      en: {
        "it.manage.label": "Manage models",
        "it.multikey-status.label": "Aggregation / multi-key status",
        "it.settings.label": "Model wizard",
        "it.shell.title": "Model management",
        "it.multikey-status.label.2": "Aggregation / multi-key status",
        "mw.shell.title": "aiti-model-wizard: add AI providers/models",
        "mw.shell.newFound": "aiti-model-wizard: {n} new models found, click to view",
        "mw.shell.manageTitle": "aiti-model-wizard: open the model wizard (add providers/models, aggregation & multi-key management)",
        "feat.tool.aiti_model_wizard_status.desc": "Model setup wizard: currently configured providers (token masked) + models.json path",
        "feat.tool.aiti_model_wizard_search.desc": "Searches AI providers in the catalog (Chinese/English keywords + reverse match from a baseUrl)",
        "feat.tool.aiti_model_wizard_provider.desc": "Views a provider's detail (api URL templates / auth method / model list notes)",
        "feat.tool.aiti_model_wizard_detect.desc": "Auto-probes the api type for a baseUrl (responses/api/v1/messages, etc.)",
        "feat.tool.aiti_model_wizard_test.desc": "Tests the connection: 2xx/429 pass, 401/403 invalid key, others fail",
        "feat.tool.aiti_model_wizard_save.desc": "Writes provider + model list into models.json (with backup)",
        "feat.tool.aiti_model_wizard_combo_save.desc": "Creates or updates a model aggregation group (group name / members / sticky rotation strategy)",
        "feat.tool.aiti_model_wizard_keys.desc": "Manages multiple API keys for a provider (list/add/delete/sticky)",
        "feat.tool.aiti_model_wizard_delete.desc": "Deletes a provider from models.json (with confirmation)",
        "feat.agentTools.enabled.desc": "Injects aiti_model_wizard_* tools into sessions (off by default; enable temporarily via the AI helper 🤖 or the extension manager)",
        "ext.displayName": "Model Wizard",
        "ext.description": "Injects aiti_model_wizard_* tools into sessions (off by default; enable temporarily via the AI helper 🤖 or the extension manager)",
        "feat.aiti-model-wizard-banner": "aiti-model-wizard: no-model onboarding",
        "feat.aiti-model-wizard-multikey-status": "Aggregation / multi-key status",
        "feat.aiti-model-wizard-multikey-status.desc": "Inside the session-info dropdown — aggregation / multi-key proxy runtime status (thin shell via /proxy-status; heavy-chunk upgrade pending)",
        "feat.aiti-model-wizard-manage": "Manage models",
        "feat.aiti-model-wizard-manage.desc": "Manage-models entry at the bottom of the model-selector dropdown — opens the model wizard",
        "feat.tool.aiti_model_wizard_status": "model_wizard_status · current state",
        "feat.tool.aiti_model_wizard_search": "model_wizard_search · search catalog",
        "feat.tool.aiti_model_wizard_provider": "model_wizard_provider · provider detail",
        "feat.tool.aiti_model_wizard_detect": "model_wizard_detect · endpoint probe",
        "feat.tool.aiti_model_wizard_test": "model_wizard_test · test connection",
        "feat.tool.aiti_model_wizard_save": "model_wizard_save · write models.json",
        "feat.tool.aiti_model_wizard_combo_save": "model_wizard_combo_save · create/edit aggregation group",
        "feat.tool.aiti_model_wizard_keys": "model_wizard_keys · multi-key management",
        "feat.tool.aiti_model_wizard_delete": "model_wizard_delete · delete provider",
        "feat.agentTools.enabled": "AI tool (model wizard)",
        "feat.ark": "Pay-as-you-go",
        "feat.ark-coding-plan": "Coding plan",
        "feat.ark-agent": "Agent plan",
        "feat.zhipu": "Pay-as-you-go",
        "feat.zai": "Pay-as-you-go",
        "feat.moonshot": "Pay-as-you-go",
        "feat.alibaba": "Pay-as-you-go",
        "feat.tencent-hunyuan": "Pay-as-you-go",
      "mw.open.label": "Models",
      "mw.open.title": "aiti-model-wizard: add AI providers/models (catalog search / reverse match / probe)",
      "mw.st.title": "Aggregation / multi-key status",
      "mw.st.titleDlg": "Aggregation / multi-key runtime status",
      "mw.st.refresh": "Refresh",
      "mw.st.close": "Close",
      "mw.st.readFailed": "Failed to read status (engine may not be running)",
      "mw.st.emptyLoaded": "Engine ready; no multi-key / aggregation providers yet (add ≥2 keys to a provider or create an aggregation group — it appears automatically)",
      "mw.st.emptyPresent": "Engine running but on an older build — restart pi-web (or open a new session) to show live status",
      "mw.st.emptyNotLoaded": "Engine not loaded (no agent session has started pi-models-combo yet — start a conversation and it auto-initializes)",
      "mw.st.proxiesSlots": "{proxies} proxies · {slots} slots",
      "mw.st.proxies": "{proxies} proxies",
      "mw.st.sum.ready": "Status…",
      "mw.st.sum.failed": "Status read failed",
      "mw.st.sum.failing": "{proxies} proxies · key failure/rate-limit",
      "mw.st.sum.cooling": "{proxies} proxies · slots cooling",
      "mw.st.sum.empty": "No aggregation/multi-key proxies",
      "mw.st.sum.old": "Old engine build · restart to apply",
      "mw.st.sum.notLoaded": "Engine not loaded",
      "mw.st.sumTitle": "View aggregation / multi-key runtime status: current key · cooldown · per-key stats",
      "mw.st.pillCombo": "Combo",
      "mw.st.pillKey": "Multi-key",
      "mw.st.configError": "Config error · cannot build",
      "mw.st.unbuilt": "Unbuilt · activates on first request",
      "mw.st.stickyOff": "sticky off",
      "mw.st.memberFailTitle": "Member resolution failed: {err}",
      "mw.st.unbuildable": "Cannot build: {err}",
      "mw.st.virtualModels": "{n} virtual model(s) · slots auto-build on first request",
      "mw.st.satTitle": "All slots returning 429; past the threshold the proxy returns a terminal error to stop infinite client retries",
      "mw.st.satChip": "⛔ pool rate-limited {s}s",
      "mw.st.satNear": "terminal error imminent",
      "mw.st.intervalAuto": "interval auto",
      "mw.st.intervalS": "interval {s}s",
      "mw.st.pinnedTitle": "A session is currently pinned to this slot",
      "mw.st.pinned": "pin×{n}",
      "mw.st.normal": "OK",
      "mw.st.429cool": "429 cooldown",
      "mw.st.errCool": "error cooldown",
      "mw.st.linked": "·linked",
      "mw.st.all429": "⛔ all-429",
      "mw.st.unobserved": "◌ unobserved",
      "mw.st.failLinkedTitle": "The same key recently returned all-429 on other proxies (linked red flag)",
      "mw.st.failTitle": "Recent requests all 429 (quota-exhaustion fault, not transient rate-limit)",
      "mw.st.staleTitle": "Last observation {ago}, no new data — old status does not reflect current availability",
      "mw.st.coolUpstream": "upstream retry-after {up}s → earliest recovery {clock} ({eta})",
      "mw.st.coolCapped": "exceeds internal cap, truncated — actually retries after cap quarantine (upstream quota may not have recovered)",
      "mw.st.coolNoRetryAfter": "no upstream retry-after; default cooldown: retry in {s}s",
      "mw.st.coolError": "upstream consecutive errors; frozen on error cooldown",
      "mw.st.tokTitle": "token traffic (in-process cumulative): ↑ input · ↓ output",
      "mw.st.tokCache": "↻ cache read+write",
      "mw.st.cumulative": "in-process cumulative (reset on restart)",
      "mw.st.legend": "▶=most-recently-used slot · pin×N=current sessions pinned to the slot · 🧊429 cooldown with 「~X」= relative remaining of upstream retry-after (hover for earliest recovery datetime; ⚠=exceeds internal cap and truncated, actually retried early per cap) · ⛔=recent all-429 or sustained pool-wide rate-limit · ◌=stale observation (no new data) · ·linked=linked with other proxies sharing the same key (latest observation) · ↑↓↻=token traffic (input/output/cache read+write, parsed from successful responses; upstreams without usage are not counted) · stats are in-process cumulative, not persisted",
      "mw.st.ago.sec": "{s}s ago",
      "mw.st.ago.min": "{m}m ago",
      "mw.st.ago.hour": "{h}h ago",
      "mw.st.eta.sec": "~{s}s",
      "mw.st.eta.min": "~{m}m",
      "mw.st.eta.minSec": "~{m}m {s}s",
      "mw.st.eta.hour": "~{h}h",
      "mw.st.eta.hourMin": "~{h}h {m}m",
      "mw.st.eta.day": "~{d}d {h}h",
      "mw.st.eta.dayMin": "~{d}d {h}h {m}m",
      "mw.st.shellFailed": "Aggregation / multi-key status: failed to read status (engine may not be running)",
      "mw.st.shellLoading": "Aggregation / multi-key status …",
      "mw.st.chipPoolLimit": "⛔ pool rate-limit {n}",
      "mw.st.chipCooling": "🧊 cooling {n}",
      "mw.st.chipAll429": "⛔ all-429 {n}",
      "mw.tx.208": "Collapse this provider's model rows ({n})",
      "mw.tx.209": "Expand this provider's model rows ({n})",
      "mw.a.1": "Reasoning",
      "mw.a.2": "Input",
      "mw.a.3": "Compat",
      "mw.a.4": "Thinking map",
      "mw.a.5": "Sampling",
      "mw.a.6": "Name",
      "mw.a.7": "URL",
      "mw.a.8": " etc. ",
      "mw.a.9": " items",
      "mw.a.10": "Auto-backfill: ",
      "mw.a.11": "I saved provider \"",
      "mw.a.12": "\" in the model wizard, but the following models could not be found in any data source (models.json / builtin catalog models-store / vendor /models / models.dev / OpenRouter / LiteLLM) and were saved as bare entries (missing contextWindow / maxTokens etc.):",
      "mw.a.13": "Follow the model-params-fill guide: 1) Look up authoritative data online (official docs / /models endpoint / models.dev / OpenRouter);",
      "mw.a.14": "2) Write the authoritative data into ~/.pi/agent/models-store.json (provider=",
      "mw.a.15": "'s models array; only add/update the target models, do not touch other entries);",
      "mw.a.16": "3) Backfill these parameters into the open \"Model params\" dialog in the model wizard, so I can click Save to apply.",
      "mw.a.17": "Cite authoritative sources. Prefer leaving fields empty over guessing — never fabricate values.",
      "mw.a.18": "Model Wizard",
      "mw.a.19": "AI is looking up authoritative data and backfilling parameters…",
      "mw.a.20": "Models missing params · ",
      "mw.a.21": "exhausted",
      "mw.a.22": " items",
      "mw.a.23": "One-click health check",
      "mw.a.24": " · in progress…",
      "mw.a.25": "Close",
      "mw.a.26": "Health check failed",
      "mw.a.27": " available · 🟡 ",
      "mw.a.28": " rate-limited · ❌ ",
      "mw.a.29": " failed",
      "mw.a.30": " skipped",
      "mw.a.31": "　(results kept in sync with tree badges / detail health bars)",
      "mw.a.32": "Network error · ",
      "mw.a.33": " (probe ",
      "mw.a.34": "Failed to load config",
      "mw.a.35": "Saved and applied immediately",
      "mw.a.36": "Save failed",
      "mw.a.37": "Catalog refreshed (",
      "mw.a.38": " providers · ",
      "mw.a.39": "Refresh failed",
      "mw.a.40": "Scan interval (minutes)",
      "mw.a.41": "Per-provider fetch timeout (s)",
      "mw.a.42": "Daily toast cap",
      "mw.a.43": "Silent beyond the cap (badge unaffected)",
      "mw.a.44": "Min toast interval (s)",
      "mw.a.45": "Toast duration (s)",
      "mw.a.46": "Cache TTL (hours)",
      "mw.a.47": "Re-download catalog now (official + mirror race)",
      "mw.a.48": "Refreshing…",
      "mw.a.49": "↻ Refresh now",
      "mw.a.50": "Connection test timeout (s)",
      "mw.a.51": "Shared with health check",
      "mw.a.52": "Endpoint probe timeout (s)",
      "mw.a.53": "Probe maxTokens",
      "mw.a.54": "Min probe output cap for connection tests",
      "mw.a.55": "Saving…",
      "mw.a.56": "Save",
      "mw.a.57": "Search members (configured providers/models)…",
      "mw.a.58": "No matching members",
      "mw.a.59": "No configured models available as members — configure real models on the \"Add\" tab first",
      "mw.a.60": "Total ",
      "mw.a.61": " matches, showing first ",
      "mw.a.62": " — narrow the search with keywords",
      "mw.a.63": "Probe unavailable (aiti-model-check disabled?)",
      "mw.a.64": "No probe result (model may not be in the runtime list)",
      "mw.a.65": "Probe failed: ",
      "mw.a.66": "Available",
      "mw.a.67": "🟡 Rate-limited (key/endpoint valid; retry later)",
      "mw.a.68": " · expected recovery ",
      "mw.a.69": "Unhealthy",
      "mw.a.70": "Model params · ",
      "mw.a.71": "The catalog has no detailed params for this model (id list only).",
      "mw.a.72": "No params fetched — the provider's model list is empty or the model was removed.",
      "mw.a.73": "Image size cap must be a positive integer in bytes (empty = default 4.5MiB)",
      "mw.a.74": "Edit model · ",
      "mw.a.75": "Run an availability probe (same probe as the \"Check\" tab; results go into the same status/history and update tree badges) — shown in place when done",
      "mw.a.76": "Testing…",
      "mw.a.77": "Test",
      "mw.a.78": "Probing ",
      "mw.a.79": " … (up to ~10s each)",
      "mw.a.80": "This provider's catalog doesn't include the model; params cross-checked from same-id entries on other gateways (source: ",
      "mw.a.81": ") — pricing per that gateway",
      "mw.a.82": "Yes",
      "mw.a.83": "No",
      "mw.a.84": "(empty)",
      "mw.a.85": "Model id",
      "mw.a.86": "Name",
      "mw.a.87": "Context window (contextWindow)",
      "mw.a.88": "Max output (maxTokens)",
      "mw.a.89": "Input (input)",
      "mw.a.90": "Cost (cost)",
      "mw.a.91": "Compat (compat)",
      "mw.a.92": "Input limits (inputLimits)",
      "mw.a.93": "Thinking level map",
      "mw.a.94": "Sampling params",
      "mw.a.95": "API override",
      "mw.a.96": "Save changes",
      "mw.a.97": "Masked rows cannot be renamed (the server matches the original value by name) — delete and re-add to rename",
      "mw.a.98": "(stored value; kept unless changed)",
      "mw.a.99": "Masked echo: the original value is kept on save unless modified",
      "mw.a.100": "Delete this row (removes the header on save)",
      "mw.a.101": "Sensitive headers (Authorization/Key/Token…) are masked: the original value is kept on save unless modified; deleting a row removes the header",
      "mw.a.102": "Clear all stored headers for this provider (applies on save)",
      "mw.a.103": "Rate-limited",
      "mw.a.104": "Out of credit",
      "mw.a.105": "Invalid key",
      "mw.a.106": "No permission",
      "mw.a.107": "Network/timeout",
      "mw.a.108": "Server error",
      "mw.a.109": "Runtime error observations (out-of-band · real proxied traffic non-2xx/3xx, not active probes): last 1h ",
      "mw.a.110": " hits / 24h ",
      "mw.a.111": " hits",
      "mw.a.112": "\nRecent ",
      "mw.a.113": " — may still be failing; re-check to confirm",
      "mw.a.114": "Health check done: ",
      "mw.a.115": " available · ",
      "mw.a.116": " rate-limited · ",
      "mw.a.117": "Health check failed: ",
      "mw.a.118": "Query failed",
      "mw.a.119": "Sign out ",
      "mw.a.120": "After signing out, all models of this provider become unavailable immediately (credentials cleared from auth.json); sign in again anytime to restore.",
      "mw.a.121": "Sign out",
      "mw.a.122": "Signed out ",
      "mw.a.123": "Sign-out failed: ",
      "mw.a.124": "Probe done: ",
      "mw.a.125": " items; tree badges updated",
      "mw.a.126": "Probing…",
      "mw.a.127": "Available (last probe passed)",
      "mw.a.128": "Rate-limited (429) — key quota/rate limited",
      "mw.a.129": "Unhealthy (non-429) — possibly out of credit/expired; re-check advised",
      "mw.a.130": "Proxy refreshed",
      "mw.a.131": "Refresh failed: ",
      "mw.a.132": "Unknown error",
      "mw.a.133": "Proxy refresh failed: ",
      "mw.a.134": "▶ Enabled ",
      "mw.a.135": "Disabled ",
      "mw.a.136": " (temporary, config kept)",
      "mw.a.137": "Operation failed",
      "mw.a.138": "Operation failed: ",
      "mw.a.139": "Last save (",
      "mw.a.140": "↩ Undid last save (restored ",
      "mw.a.141": "), refresh the page to apply",
      "mw.a.142": "Undo failed: ",
      "mw.a.143": "Enabled ",
      "mw.a.144": "'s ",
      "mw.a.145": " new models; refresh the page to apply",
      "mw.a.146": "Enable failed: ",
      "mw.a.147": "Download failed",
      "mw.a.148": "Catalog refreshed",
      "mw.a.149": "Load failed",
      "mw.a.150": "Selected \"",
      "mw.a.151": ") — paste the token and click \"Test connection\"",
      "mw.a.152": "Custom endpoint",
      "mw.a.153": "Custom endpoint: fill Base URL / API type / headers → test connection → pick models and save",
      "mw.a.154": "(pre-filled with probe results, editable)",
      "mw.a.155": "No recognizable endpoint probed",
      "mw.a.156": "Applied probed endpoint: ",
      "mw.a.157": "No match — check spelling (or paste the full API URL for automatic reverse match + probe); or add manually via \"＋ Custom\"",
      "mw.a.158": "URL not in catalog — auto reverse match + probe already run (see the card below, probe results are usable); if unrecognized, use \"🛠 Custom endpoint\" at the bottom to add manually",
      "mw.a.159": "Search failed: ",
      "mw.a.160": "Identified as \"",
      "mw.a.161": "\" (exact URL match): ",
      "mw.a.162": ") — paste the token and click \"Test connection\"",
      "mw.a.163": "Custom endpoint (auto probe)",
      "mw.a.164": "Probed endpoint with key: ",
      "mw.a.165": ") — paste the token and click \"Test connection\" to save",
      "mw.a.166": "Probed endpoint: ",
      "mw.a.167": ") — ⚠️ without a key only the API type was guessed; paste a key for a precise probe",
      "mw.a.168": "Probe did not recognize the endpoint: ",
      "mw.a.169": "Neither reverse match nor probe matched — check the URL (try removing /v1 /v2), or use \"🛠 Custom endpoint\" at the bottom to add manually",
      "mw.a.170": "Auto reverse match failed: ",
      "mw.a.171": "Probe with key confirmed: \"",
      "mw.a.172": ") — continue testing/saving",
      "mw.a.173": "Custom endpoint (key probe)",
      "mw.a.174": "Endpoint confirmed by key probe: ",
      "mw.a.175": ") — continue filling the token / testing",
      "mw.a.176": "Probe with key did not recognize: ",
      "mw.a.177": "Probe with key still unmatched — check the key and URL, or use \"🛠 Custom endpoint\" at the bottom to add manually",
      "mw.a.178": "Probe with key failed: ",
      "mw.a.179": ") — paste token to test",
      "mw.a.180": "pi built-in provider — just paste the API key and save (hosted in auth.json); the model list loads from pi's builtin catalog",
      "mw.a.181": "Pulled /models ",
      "mw.a.182": " models (",
      "mw.a.183": " new · ",
      "mw.a.184": " existing), stale catalog models backfilled",
      "mw.a.185": "Pull failed: ",
      "mw.a.186": "No models returned (check token or URL)",
      "mw.a.187": " models (using credential #",
      "mw.a.188": " key",
      "mw.a.189": " · total ",
      "mw.a.190": " keys",
      "mw.a.191": "), stale catalog models backfilled",
      "mw.a.192": "No credentials pulled any models",
      "mw.a.193": "(tried ",
      "mw.a.194": " keys in order)",
      "mw.a.195": "(check key or URL)",
      "mw.a.196": "Request failed: ",
      "mw.a.197": "Saved ",
      "mw.a.198": " models",
      "mw.a.199": " models missing params",
      "mw.a.200": " → written to models.json, effective immediately",
      "mw.a.201": "Saved \"",
      "mw.a.202": "Save failed: ",
      "mw.a.203": "Delete provider ",
      "mw.a.204": "Deleted ",
      "mw.a.205": "Failed: ",
      "mw.a.206": "Delete failed: ",
      "mw.a.207": " models",
      "mw.a.208": " · token updated",
      "mw.a.209": " · renamed from ",
      "mw.a.210": "",
      "mw.a.211": "Edited \"",
      "mw.a.212": "Pulled ",
      "mw.a.213": " selectable models — ✨ found ",
      "mw.a.214": " new models, auto-checked (with \"new\" badge); click Save to enable",
      "mw.a.215": " selectable models (kept previous checks: ",
      "mw.a.216": ") — check models then click Save",
      "mw.a.217": "Model refresh failed: ",
      "mw.a.218": "Auto-tidy ready: unchecked ",
      "mw.a.219": " hard-failure models per check results (bad key/out of credit/nonexistent etc.) — review then click \"Save\" to apply; rate-limited/untested/transient errors are kept by default",
      "mw.a.220": "Auto-tidy: no hard-failure models found (rate-limited/untested/transient all kept) — edit providers individually if needed",
      "mw.a.221": "Auto-tidy done: ",
      "mw.a.222": " providers saved, removed ",
      "mw.a.223": " failing models (proxy refreshed, effective immediately)",
      "mw.a.224": "Auto-tidy cancelled (nothing saved)",
      "mw.a.225": "[aiti-model-wizard] failed to apply auto-tidy",
      "mw.a.226": "Test failed",
      "mw.a.227": "Add failed",
      "mw.a.228": "Delete failed",
      "mw.a.229": "Switch failed",
      "mw.a.230": "List refreshed · proxy refreshed",
      "mw.a.231": "List refreshed, proxy refresh failed: ",
      "mw.a.232": "▾ Collapse",
      "mw.a.233": "Multi-key rotation",
      "mw.a.234": " keys)",
      "mw.a.235": "① Re-read the key list from models.json (external changes show up immediately) ② Refresh the running proxy (effective immediately)",
      "mw.a.236": "Key name (for rotation/identification)",
      "mw.a.237": "Current ",
      "mw.a.238": "(empty = keep)",
      "mw.a.239": "Requests per minute cap (optional)",
      "mw.a.240": "Interval ms · 0 = burst",
      "mw.a.241": "Even-spacing throttle (default: even rate). Three ways to fill:\n① empty = auto: derived from rpm (60000÷rpm, rpm30→one per 2s), default\n② 0 = off: rpm sliding window only (burst mode, may hit the full quota instantly)\n③ number = fixed interval in ms (e.g. 2000 = one per 2s)\nApplies together with rpm; the longer wait wins",
      "mw.a.242": "Save changes (rename/swap key/change rpm/interval — written to models.json immediately)",
      "mw.a.243": "No changes",
      "mw.a.244": "Temporarily disabled (excluded from rotation, config kept) — click to re-enable",
      "mw.a.245": "Temporarily disable this key (excluded from rotation, config kept, re-enable anytime)",
      "mw.a.246": "Delete this key (written to models.json immediately)",
      "mw.a.247": "Name (defaults to auto key-N)",
      "mw.a.248": "New API key (sk-…)",
      "mw.a.249": "Even-spacing throttle: empty = auto (derived from rpm, default even rate); 0 = burst sliding window; number = fixed milliseconds",
      "mw.a.250": "Verifying actual maxTokens cap…",
      "mw.a.251": "Metadata overstated; auto-reduced and written back",
      "mw.a.252": "Live verify failed",
      "mw.a.253": "Models (",
      "mw.a.254": " selected / ",
      "mw.a.255": " selectable",
      "mw.a.256": "Filter selectable models",
      "mw.a.257": "Check all currently filtered (keeps selections outside the filter)",
      "mw.a.258": "Invert selection within the current filter",
      "mw.a.259": "Uncheck within the current filter (outside the filter unaffected)",
      "mw.a.260": "View ",
      "mw.a.261": " params (catalog backfill, viewable even if unconfigured)",
      "mw.a.262": "View/edit full params (context window/cost etc.)",
      "mw.a.263": "Temporarily disable this model (hidden from the available list, skipped as combo member; config kept)",
      "mw.a.264": "Re-enable this model (visible again)",
      "mw.a.265": "Remove ",
      "mw.a.266": "Add model ids (comma-separated, e.g. glm-4.7,kimi-k3)",
      "mw.a.267": "Keep original key (",
      "mw.a.268": "Paste new key / ENV_NAME / !cmd",
      "mw.a.269": "Catalog models ",
      "mw.a.270": "Official docs",
      "mw.a.271": "Sign up",
      "mw.a.272": "Get token",
      "mw.a.273": "Connection interrupted",
      "mw.a.274": " per-key test:",
      "mw.a.275": " available",
      "mw.a.276": "Passed (429 rate-limited) — key/endpoint valid; retry later · ",
      "mw.a.277": "Passed (HTTP ",
      "mw.a.278": "Failed (HTTP ",
      "mw.a.279": "Claude Pro/Max subscription · claude.ai account OAuth",
      "mw.a.280": "ChatGPT Plus/Pro subscription · OpenAI-endorsed third-party access",
      "mw.a.281": "GitHub Copilot subscription · github.com OAuth",
      "mw.a.282": "xAI Grok/X Premium subscription",
      "mw.a.283": "OpenRouter account OAuth (PKCE, prepaid billing)",
      "mw.a.284": "Radius dynamic gateway",
      "mw.a.285": "Kimi Code subscription · device-code login at auth.kimi.com",
      "mw.a.286": "Qoder international · browser device code / PAT. Free tier has no credits; paid quota required for inference",
      "mw.a.287": "Qoder CN domestic · Pro+ credits live in this region. PAT: account page → integrations; local qoderclicn login auto-imports. Personal use only",
      "mw.a.288": "Enter the API key first",
      "mw.a.289": "Saved (auth.json) — model list in effect",
      "mw.a.290": "Removed — all models of this provider are offline",
      "mw.a.291": "Configured",
      "mw.a.292": "Not configured",
      "mw.a.293": "Enter a new key to replace…",
      "mw.a.294": "Remove this provider's key (auth.json); all its models become unavailable immediately",
      "mw.a.295": "Remove",
      "mw.a.296": " params (catalog backfill, read-only)",
      "mw.a.297": " entries)",
      "mw.a.298": "Subscription-login provider (",
      "mw.a.299": ") — no API token needed; click Sign in to get credentials",
      "mw.a.300": "OAuth sign-in",
      "mw.a.301": "View sign-in status / account / credits",
      "mw.a.302": "Collapse",
      "mw.a.303": "Details",
      "mw.a.304": "Sign out: clears this provider's login credentials (auth.json); all its models become unavailable immediately. Sign in again anytime.",
      "mw.a.305": "Signing out…",
      "mw.a.306": " · expires ",
      "mw.a.307": "Add-on credit packs",
      "mw.a.308": "(used ",
      "mw.a.309": "Dedicated resource packs (applied first for the selected model family)",
      "mw.a.310": "API-key provider (",
      "mw.a.311": ") — key stored in auth.json (hosted by pi)",
      "mw.a.312": "1 model",
      "mw.a.313": " · subscription login also available",
      "mw.a.314": "Refresh info",
      "mw.a.315": "Refresh status",
      "mw.a.316": "Sign out: clears this provider's login credentials (auth.json); all its models become unavailable immediately",
      "mw.a.317": "Submit empty = browser sign-in",
      "mw.a.318": "Choose:",
      "mw.a.319": "(pi builtin · hosted credentials)",
      "mw.a.320": "Re-probe the API type and real URL with the current URL + token/headers (recovers missing /v1 /v2 too)",
      "mw.a.321": "Probe",
      "mw.a.322": "pi's Anthropic requests = baseUrl + /v1/messages; a base ending with /v1 becomes /v1/v1/messages (404). Remove the trailing /v1.",
      "mw.a.323": "Sent only with this provider's requests (e.g. User-Agent / x-opencode-session); empty lines ignored",
      "mw.a.324": "Provider name",
      "mw.a.325": "Identifier written into models.json · auto-generated, editable",
      "mw.a.326": "Provider name (identifier in models.json)",
      "mw.a.327": "Credentials & connection test",
      "mw.a.328": "Accepts literal (sk-…) · env var name · !command",
      "mw.a.329": "Connected",
      "mw.a.330": "Not passed",
      "mw.a.331": "Paste API token — used only for testing/saving, never echoed back",
      "mw.a.332": "The top token and the multi-key rows below are tested serially, each with its own result",
      "mw.a.333": "Even-spacing throttle (default even rate): empty = auto (from rpm, 60000÷rpm, rpm30→one per 2s); 0 = off (burst sliding window); number = fixed interval ms. Takes the max wait with rpm",
      "mw.a.334": "Delete this key",
      "mw.a.335": "Select models",
      "mw.a.336": "Check models to enable · 👁 to view param details",
      "mw.a.337": "Pull the vendor /models live list with each filled credential (token + multi-key rows); first success wins (backfills stale catalogs)",
      "mw.a.338": "Pulling…",
      "mw.a.339": "Selected ",
      "mw.a.340": "Filter models (e.g. glm / flash / free…)",
      "mw.a.341": "Matched ",
      "mw.a.342": " params (window/capabilities/pricing from catalog; unknown ids cross-checked across gateways)",
      "mw.a.343": "Manually add model ids (comma-separated, e.g. deepseek-chat,deepseek-reasoner)",
      "mw.a.344": "Check models in ③ first",
      "mw.a.345": " · multi-key ",
      "mw.a.346": " · ⚠️ no credentials entered (same-name stored keys are kept)",
      "mw.a.347": "Save ",
      "mw.a.348": "Save to config",
      "mw.a.349": "Export failed: ",
      "mw.a.350": "Exported ",
      "mw.a.351": " providers (no plaintext keys)",
      "mw.a.352": " · combo groups ",
      "mw.a.353": " not included",
      "mw.a.354": "JSON parse failed: ",
      "mw.a.355": "Preview failed: ",
      "mw.a.356": "Imported ",
      "mw.a.357": " providers (/undo reverts the whole batch)",
      "mw.a.358": "Import failed: ",
      "mw.a.359": "New",
      "mw.a.360": "Overwrite",
      "mw.a.361": "Conflict",
      "mw.a.362": "Diff preview: ",
      "mw.a.363": " entries (",
      "mw.a.364": " new · ",
      "mw.a.365": " overwrite · ",
      "mw.a.366": " conflicts). Confirmed via batch save; /undo reverts the whole batch.",
      "mw.a.367": "Importing…",
      "mw.a.368": "Confirm import (",
      "mw.a.369": " entries)",
      "mw.a.370": " · models ",
      "mw.a.371": " · token filled",
      "mw.a.372": " keys (written on save)",
      "mw.a.373": "Last test failed: ",
      "mw.a.374": "Test first",
      "mw.a.375": "Save anyway (disabled)",
      "mw.a.376": "Confirm save",
      "mw.a.377": " brand: ",
      "mw.a.378": "OpenAPI declared",
      "mw.a.379": "Model prefix",
      "mw.a.380": "No catalog match",
      "mw.a.381": "Brand: ",
      "mw.a.382": "Suspected: ",
      "mw.a.383": "URL match",
      "mw.a.384": "Same domain (possibly another plan)",
      "mw.a.385": "Model list pulled (",
      "mw.a.386": " models) — check them under \"③ Select models\" below",
      "mw.a.387": "Model list:",
      "mw.a.388": "Verifying…",
      "mw.a.389": "Server error ",
      "mw.a.390": "Network error",
      "mw.a.391": "All catalog providers (",
      "mw.a.392": " providers · models.dev has no finer categories, grouped by first character; click \"＋ Add\" to connect directly)",
      "mw.a.393": "Filter providers (Chinese/English name / id / API URL)",
      "mw.a.394": " providers",
      "mw.a.395": "Expand basic info and model list",
      "mw.a.396": "Open official site/docs (new window)",
      "mw.a.397": "Open sign-up page (new window)",
      "mw.a.398": "Open token page (new window)",
      "mw.a.399": "Click to select and connect this provider",
      "mw.a.400": "Clear current selection, search again / pick another",
      "mw.a.401": "Search providers",
      "mw.a.402": "Chinese/English name / alias / model id; paste an API URL for automatic reverse match + probe (recovers missing /v1 /v2)",
      "mw.a.403": "DeepSeek / Zhipu GLM / qwen… or paste https://api.xxx.com/v1",
      "mw.a.404": "Search…",
      "mw.a.405": "Skip search and add a custom endpoint manually (Base URL / API type / headers)",
      "mw.a.406": "Just updated",
      "mw.a.407": " hours ago",
      "mw.a.408": " days ago",
      "mw.a.409": "Catalog ",
      "mw.a.410": " providers · models.dev ",
      "mw.a.411": "cache",
      "mw.a.412": "builtin snapshot (stale; auto-refreshed at startup)",
      "mw.a.413": "not cached",
      "mw.a.414": " · ⚠ TTL exceeded (auto force-refreshed when saving unknown models, or refresh manually on the right)",
      "mw.a.415": "(click the button on the right to fetch when search is empty)",
      "mw.a.416": "Re-download the models.dev catalog (official + Gitee mirror race)",
      "mw.a.417": "↻ Refresh catalog",
      "mw.a.418": "Browse all catalog providers (grouped by first character; click Add to connect)",
      "mw.a.419": "▾ Collapse catalog",
      "mw.a.420": "Browse catalog",
      "mw.a.421": "Click a plan below to connect",
      "mw.a.422": "Sign up via this link for free credits on both sides (new window)",
      "mw.a.423": " URL reverse-matched ",
      "mw.a.424": "pi builtin provider · ",
      "mw.a.425": " models · paste an API key to connect",
      "mw.a.426": "Known models ",
      "mw.a.427": "Click to view details",
      "mw.a.428": "Reverse-match candidates",
      "mw.a.429": "Catalog · 100 = exact URL match · 30 = same domain, other plan/version; probe results take precedence",
      "mw.a.430": "(match score ",
      "mw.a.431": "Keyless probe only guesses the API type; the real version path (/v1 /v2 /v3) may be wrong. The key is used for probing only, never sent elsewhere",
      "mw.a.432": "Precise probing…",
      "mw.a.433": "Precise probe with key",
      "mw.a.434": "Enter the custom endpoint panel directly without searching (Base URL / API type / headers)",
      "mw.a.435": "Not in catalog? Already have a URL? Start here: fill Base URL / API type / headers manually, no catalog match needed",
      "mw.a.436": "Search provider / model id… (multi-word, space-separated)",
      "mw.a.437": "Clear search",
      "mw.a.438": "Send one real probe to each configured provider (skips combo groups/disabled/no-credential; results kept, shown on tree/details with delay)",
      "mw.a.439": "Health check in progress…",
      "mw.a.440": "Configured · ",
      "mw.a.441": " · filter ",
      "mw.a.442": "Runtime error observations (out-of-band): non-2xx/3xx in real proxied traffic (429 rate-limit / 402 out of credit / 401 invalid key / 5xx etc., attributed per key), visible even without probing",
      "mw.a.443": "No match for \"",
      "mw.a.444": " · tested ",
      "mw.a.445": "429 rate-limited (key/endpoint valid)",
      "mw.a.446": "Passed",
      "mw.a.447": "Wizard test: ",
      "mw.a.448": "Some keys failed",
      "mw.a.449": "Failed",
      "mw.a.450": "Out of credit",
      "mw.a.451": "Temporarily disabled (config kept; re-enable from the detail page)",
      "mw.a.452": " keys temporarily disabled (re-enable via \"Multi-key rotation\" on the detail page)",
      "mw.a.453": "Temporarily disabled (kept; re-enable from the detail page)",
      "mw.a.454": "Verifying actual max output",
      "mw.a.455": "maxTokens corrected by live verify",
      "mw.a.456": "Live verify passed",
      "mw.a.457": "● Available",
      "mw.a.458": "● Rate-limited",
      "mw.a.459": "● Unhealthy (possibly out of credit/expired)",
      "mw.a.460": " running",
      "mw.a.461": "Enable aiti-model-check first (extension manager)",
      "mw.a.462": "Probe this model's availability",
      "mw.a.463": " rate-limited",
      "mw.a.464": " unhealthy",
      "mw.a.465": " untested",
      "mw.a.466": " models failing ×",
      "mw.a.467": " models · registered dynamically by extensions (read-only)",
      "mw.a.468": " models · ",
      "mw.a.469": "key configured",
      "mw.a.470": "no key",
      "mw.a.471": "has ",
      "mw.a.472": " keys temporarily disabled (excluded from rotation, config kept) — expand \"Multi-key rotation\" below to view / re-enable with one click",
      "mw.a.473": "Last wizard test: ",
      "mw.a.474": "This provider has not been tested with the wizard yet",
      "mw.a.475": "Untested",
      "mw.a.476": "🟡 429 passed",
      "mw.a.477": "🟡 Some keys failed",
      "mw.a.478": "Send one real probe with stored credentials (multi-key tested one by one); results are kept automatically and update tree badges",
      "mw.a.479": "Retest",
      "mw.a.480": "Used ",
      "mw.a.481": "left ",
      "mw.a.482": "cap ",
      "mw.a.483": "\nUpdated ",
      "mw.a.484": "(server cache 5 min)",
      "mw.a.485": "Quota limited: ",
      "mw.a.486": "Balance: ",
      "mw.a.487": "Out of credit / insufficient balance",
      "mw.a.488": "Has failing models (possibly out of credit/expired)",
      "mw.a.489": "Healthy",
      "mw.a.490": "Run an availability probe (updates tree badges available/rate-limited/unhealthy; may take tens of seconds)",
      "mw.a.491": "Refresh this provider's running proxy (applies models.json / multi-key changes immediately without restarting the session)",
      "mw.a.492": "Temporarily disabled — model hidden from the list, proxy stopped (config kept). Click to re-enable",
      "mw.a.493": "Temporarily disable (config kept): model hidden from the list, proxy stopped; re-enable anytime with one click",
      "mw.a.494": "▶ Enable",
      "mw.a.495": "Disable",
      "mw.a.496": "Delete provider",
      "mw.a.497": "No providers configured yet — click the button below to search or paste an API URL. models.json: ",
      "mw.a.498": "Auto-tidy (based on ",
      "mw.a.499": " model checks): pre-selected by probe results — hard failures unchecked; rate-limited/untested/transient kept",
      "mw.a.500": "Saving ",
      "mw.a.501": "Saves each changed provider in turn (writes models.json + refreshes proxy, effective immediately)",
      "mw.a.502": "No changes to save (no hard-failure models)",
      "mw.a.503": "Save all (",
      "mw.a.504": " providers changed)",
      "mw.a.505": "Discard this pre-selection (save nothing)",
      "mw.a.506": "Keep ",
      "mw.a.507": "Will be removed from models.json on save: ",
      "mw.a.508": " etc.",
      "mw.a.509": "Transient errors (server/network/timeout) are kept by default — if truly unneeded, uncheck them manually in the edit area: ",
      "mw.a.510": "Transient issues ",
      "mw.a.511": " kept",
      "mw.a.512": "All models of this provider are hard failures: check the key/balance and retest, or delete the whole provider after confirming",
      "mw.a.513": "Expand this provider's edit area (pre-checked by the tidy; adjust then save)",
      "mw.a.514": "Found ",
      "mw.a.515": " new models",
      "mw.a.516": "Dismiss the reminder; stop flagging these new models",
      "mw.a.517": " · new ",
      "mw.a.518": "Check all new models",
      "mw.a.519": "Invert selection across all new models",
      "mw.a.520": "Uncheck all (do not enable)",
      "mw.a.521": "Enabling…",
      "mw.a.522": "Enable selected",
      "mw.a.523": "Expand to edit this provider (see all models / change key)",
      "mw.a.524": "Ignore these new models for this provider (other providers keep reminding next time)",
      "mw.a.525": "Configured ",
      "mw.a.526": " providers · ",
      "mw.a.527": "Undo last save (",
      "mw.a.528": ") — restores provider entries as before the save",
      "mw.a.529": "Reload slot config for all running proxies from models.json (applies multi-key / combo changes immediately without restarting the session)",
      "mw.a.530": "Done",
      "mw.a.531": "At least one member required",
      "mw.a.532": "All members disabled — keep at least one enabled (to stop everything temporarily, disable at the combo-group level)",
      "mw.a.533": "Stale member references exist",
      "mw.a.534": "Cross-protocol members (",
      "mw.a.535": ") — only same-protocol aggregation is supported",
      "mw.a.536": "Context windows vary widely (shortest < half of the longest): the minimum wins; long sessions may be trimmed early",
      "mw.a.537": "Max output differs by >20%: the minimum wins",
      "mw.a.538": "Inconsistent capabilities (some members lack vision): image requests avoid non-vision members automatically",
      "mw.a.539": "No member has vision: image input cannot be handled",
      "mw.a.540": "No member can handle plain-text requests (all image-only/media-only): sessions without images would have no available member — save anyway?",
      "mw.a.541": "Combo group saved: ",
      "mw.a.542": " virtual models) — running proxy refreshed; the new model list is visible in new sessions immediately",
      "mw.a.543": "Display name (e.g. fast group)",
      "mw.a.544": "empty = same as display name",
      "mw.a.545": "e.g. fast",
      "mw.a.546": "Protocol ",
      "mw.a.547": "Mixed protocols",
      "mw.a.548": "Temporarily disabled (this virtual model is hidden from the list, config kept) — click to re-enable",
      "mw.a.549": "Temporarily disable this virtual model (hidden from the model list, config kept, re-enable anytime)",
      "mw.a.550": "Output ⌊",
      "mw.a.551": "Capabilities ",
      "mw.a.552": "Sticky TTL ",
      "mw.a.553": "Sticky TTL 15min (default)",
      "mw.a.554": "Temporarily disabled (not routed, config kept)",
      "mw.a.555": "Shortest context: combo contextWindow lowered to ",
      "mw.a.556": "(long sessions may be trimmed early)",
      "mw.a.557": "Min max output: ",
      "mw.a.558": "No vision: image requests avoid it automatically",
      "mw.a.559": "Stale",
      "mw.a.560": "Context window",
      "mw.a.561": "Max output",
      "mw.a.562": "Default 10; pick points randomly by weight share (per member)",
      "mw.a.563": "Which request categories this member serves (auto-filtered by model capabilities: undeclared capabilities are not listed; all checked = serves everything, same as unrestricted)",
      "mw.a.564": "Text",
      "mw.a.565": "Uncheck = this member serves image requests only (image-only)",
      "mw.a.566": "Base category: every model handles plain text; cannot be unchecked",
      "mw.a.567": "Image",
      "mw.a.568": "Uncheck = this member rejects image requests (text-only)",
      "mw.a.569": "All checkable categories checked = serves all requests (same as unrestricted; future categories auto-included)",
      "mw.a.570": "Temporarily disable this member (not routed, config kept, re-enable anytime)",
      "mw.a.571": "Re-enable this member (routes again)",
      "mw.a.572": "Reload slot config for all running proxies from models.json (applies combo/multi-key changes immediately without restarting the session)",
      "mw.a.573": "Proxy refreshed: ",
      "mw.a.574": "(none)",
      "mw.a.575": "Refresh failed: ",
      "mw.a.576": " virtual models · protocol ",
      "mw.a.577": "Temporarily disabled (model hidden from the list, proxy stopped, config kept) — click to re-enable",
      "mw.a.578": "Temporarily disable the whole combo group (config kept; model hidden from the list, proxy stopped, re-enable anytime)",
      "mw.a.579": "Delete combo group",
      "mw.a.580": "Media",
      "mw.a.581": "Installing…",
      "mw.a.582": "Install",
      "mw.a.583": "Reinstall the latest version",
      "mw.a.584": "Update",
      "mw.a.585": "Click again to confirm uninstall",
      "mw.a.586": "Uninstall (no longer loaded in new sessions)",
      "mw.a.587": "Confirm uninstall",
      "mw.a.588": "Uninstall",
      "mw.a.589": "Model list",
      "mw.a.590": "Main view",
      "mw.a.591": "Add provider",
      "mw.a.592": "Catalog / paste URL",
      "mw.a.593": "Subscription sign-in",
      "mw.a.594": "Free models",
      "mw.a.595": "One-click install",
      "mw.a.596": "Model combo",
      "mw.a.597": "Combo models",
      "mw.a.598": "Model check",
      "mw.a.599": "Availability monitoring",
      "mw.a.600": "Function menu (switch/return between features)",
      "mw.a.601": "Subscriptions",
      "mw.a.602": "Free",
      "mw.a.603": "Combo",
      "mw.a.604": "Check",
      "mw.a.605": "Wizard settings (new-model reminders / catalog / probe & test timeouts)",
      "mw.a.606": "Export provider config (redacted JSON — no plaintext keys, P2-A)",
      "mw.a.607": "Import provider config (diff preview + batch save, undoable)",
      "mw.a.608": "Back to model list",
      "mw.a.609": "Add provider (catalog search / paste URL)",
      "mw.a.610": "Close the model management panel",
      "mw.a.611": " models missing params in every data source (saved as bare entries; pi falls back to 128k/16k defaults): ",
      "mw.a.612": "AI helper auto-invoked (skill: model-params-fill) — looking up authoritative data online → writing ~/.pi/agent/models-store.json → backfilling the params dialog. When AI finishes, open each model's \"✎ Edit params\" to review and save; next save backfills automatically.",
      "mw.a.613": "Re-invoke the AI helper",
      "mw.a.614": "Model management",
      "mw.a.615": "All models unavailable",
      "mw.a.616": "No available models yet",
      "mw.a.617": " · flagged by heavy runtime 429 blocking",
      "mw.a.618": ") check records for recovery times, or switch models",
      "mw.a.619": "All models unavailable (429 rate-limited / errors); check records for recovery times, or switch models",
      "mw.a.620": "Add an AI provider: search or paste an API URL → paste token → test → pick models",
      "mw.a.621": "Switch model",
      "mw.a.622": "Add one",
      "mw.a.623": " new models (",
      "mw.a.624": ") · click to view",
      "mw.a.625": "Got it, stop reminding",
      "mw.a.626": "Known differences already present in this combo (adding/removing members or new difference types require fresh confirmation)",
      "mw.a.627": "Leave empty to use the combo name; shows in the model list as <id>/<model>",
      "mw.a.628": " member references",
      "mw.a.629": " disabled",
      "mw.tx.210": "Virtual model id cannot be empty",
      "mw.tx.211": "Duplicate virtual model id",
      "mw.tx.212": "Fix these before saving",
      "mw.tx.213": "Ready to save",
      "mw.tx.214": "Saving…",
      "mw.tx.215": "Accept all",
      "mw.tx.216": "Combo group",
      "mw.tx.217": "Virtual models & members",
      "mw.tx.218": "The group name labels the picker section; the provider id is the internal identifier (models show as id/model)",
      "mw.tx.219": "Each virtual model is one selectable model; its members are the real models serving requests — weights split the traffic",
      "mw.tx.220": "Virtual model",
      "mw.tx.221": "Members",
      "mw.tx.222": "Traffic splits by weight; \"Serves\" narrows which requests go here",
      "mw.tx.223": "Add member",
      "mw.tx.224": "Collapse",
      "mw.tx.225": "Advanced: sticky TTL (minutes, default 15)",
      "mw.tx.226": "Members must come from configured real models: add providers under \"Model list\" first, then pick members for each virtual model here.",
      "mw.tx.1": "Probing providers serially (up to ~12s each; skips combo groups/disabled/no-credential)… A report is generated and results kept when done.",
      "mw.tx.2": "Fix",
      "mw.tx.3": "↻ Re-run health check",
      "mw.tx.4": "Done",
      "mw.tx.5": "Wizard settings",
      "mw.tx.6": "Loading…",
      "mw.tx.7": "New-model detection & reminders",
      "mw.tx.8": "Catalog (models.dev)",
      "mw.tx.9": "Primary URL",
      "mw.tx.10": "Mirror URL (racing fallback)",
      "mw.tx.11": "Probe & test",
      "mw.tx.12": "Cancel",
      "mw.tx.13": "Submit",
      "mw.tx.14": "← Back",
      "mw.tx.15": "AI: fill missing params (look up authoritative data → write models-store)",
      "mw.tx.16": "Read-only · catalog backfill",
      "mw.tx.17": "Edit",
      "mw.tx.18": "Display name",
      "mw.tx.19": "Max output maxTokens",
      "mw.tx.20": "Reasoning (reasoning)",
      "mw.tx.21": "Image input",
      "mw.tx.22": "(follow provider)",
      "mw.tx.23": "Base URL override (empty = follow provider)",
      "mw.tx.24": "Image size cap (bytes, empty = default 4.5MiB)",
      "mw.tx.25": "Cap after base64-encoding a single image · ",
      "mw.tx.26": "Cost ($/M tokens; effective only when all four are filled)",
      "mw.tx.27": "Thinking level map (empty = remove that level)",
      "mw.tx.28": "DeepSeek thinking compat",
      "mw.tx.29": "Developer role support",
      "mw.tx.30": "Headers (model-level; empty lines ignored)",
      "mw.tx.31": "＋ Add row",
      "mw.tx.32": "Clear stored headers",
      "mw.tx.33": "Refresh",
      "mw.tx.34": "Multi-key rotation spreads rate limits · per-key rpm cap + even-spacing interval (empty = auto from rpm · 0 = burst sliding window · number = ms) · Refresh = re-read list + refresh proxy",
      "mw.tx.35": "(no multi-key yet — add below)",
      "mw.tx.36": "＋ Add",
      "mw.tx.37": "Name (renames the provider on change)",
      "mw.tx.38": "Collapse list",
      "mw.tx.39": "Select all",
      "mw.tx.40": "Invert",
      "mw.tx.41": "Clear",
      "mw.tx.42": "New",
      "mw.tx.43": "(no match)",
      "mw.tx.44": "(no models)",
      "mw.tx.45": "Connection config",
      "mw.tx.46": "API type",
      "mw.tx.47": "API Key (empty = keep original; accepts literal / env var name / ",
      "mw.tx.48": "!command",
      "mw.tx.49": "Headers (provider-level; kept unless changed)",
      "mw.tx.50": "Test connection (all stored keys)",
      "mw.tx.51": "Tests all multi-keys configured in models.json serially (not just the first), each with its own result",
      "mw.tx.52": "Save (models + config)",
      "mw.tx.53": "· runtime live",
      "mw.tx.54": "· ⚠ catalog static list",
      "mw.tx.55": "No subscription-login providers found.",
      "mw.tx.56": "Refresh list",
      "mw.tx.57": "These providers use subscription/OAuth sign-in (credentials auto-stored and refreshed in auth.json) and work alongside token-type providers. Personal accounts only; sharing/reselling prohibited.",
      "mw.tx.58": "Signed in",
      "mw.tx.59": "Credits exhausted",
      "mw.tx.60": "Not signed in — click \"Sign in\" to start",
      "mw.tx.61": "API-key management for pi builtin providers (openai / anthropic / google etc.): after saving, the model list loads from pi's builtin catalog, alongside subscription logins; configured ones show directly in the left tree / selector.",
      "mw.tx.62": "No apiKey-type builtin providers (this pi build declares none, or all are overridden by custom providers).",
      "mw.tx.63": "Subscription-login · no API token needed",
      "mw.tx.64": "Subscription providers: click \"Sign in\" to get credentials (auto-stored in auth.json and refreshed; no manual save). Personal accounts only; sharing/reselling prohibited.",
      "mw.tx.65": "Not signed in",
      "mw.tx.66": "Credit packs",
      "mw.tx.67": "No credits info for this account (Free account or API unavailable)",
      "mw.tx.68": "Connecting to the sign-in service…",
      "mw.tx.69": "Signed in! Account and available models shown above.",
      "mw.tx.70": "Keys are stored in auth.json (pi-hosted, same place as subscription logins); the model list loads from pi's builtin catalog, no manual picking. For custom baseUrl / multi-key rotation use \"🛠 Custom endpoint\" instead.",
      "mw.tx.71": "After saving, go back to \"Model list\" to see the provider and all its models.",
      "mw.tx.72": "Connection config (custom endpoint)",
      "mw.tx.73": "Do not append /v1 to the Anthropic Base URL (the runtime appends /v1/messages after it)",
      "mw.tx.74": "Headers (optional)",
      "mw.tx.75": "Test connection",
      "mw.tx.76": "Env var name (e.g. OPENROUTER_KEY) or ",
      "mw.tx.77": "(stdout captured): written as-is into models.json on save and parsed by pi",
      "mw.tx.78": "Multi-key auto rotation",
      "mw.tx.79": "Highlights",
      "mw.tx.80": "Multiple keys spread rate limits and auto-switch when exhausted · per-key rpm cap + even-spacing interval (empty = auto · 0 = burst · number = ms)",
      "mw.tx.81": "＋ Add a key",
      "mw.tx.82": "Refresh models",
      "mw.tx.83": "No known models yet — fill the token and click \"Test connection\" or \"Refresh models\" to pull the /models list (catalog lists may be stale; live pull wins)",
      "mw.tx.84": "⇪ Import provider config",
      "mw.tx.85": "Paste exported JSON (⇩ export file; no plaintext keys — existing keys are kept on import; new providers missing keys land disabled until a key is added). Or pick a local file:",
      "mw.tx.86": "Parse preview",
      "mw.tx.87": "Keep existing keys",
      "mw.tx.88": "Nothing to import",
      "mw.tx.89": "Back to edit",
      "mw.tx.90": "Confirm save — provider name",
      "mw.tx.91": "Name (auto-generated, editable; identifier in models.json)",
      "mw.tx.92": "Not tested yet — saving applies immediately; test first if possible",
      "mw.tx.93": "Continue with this endpoint",
      "mw.tx.94": "Catalog not loaded — click \"↻ Refresh catalog\" to fetch models.dev and retry",
      "mw.tx.95": "No matching providers",
      "mw.tx.96": "CN",
      "mw.tx.97": "Loading model list…",
      "mw.tx.98": "Docs",
      "mw.tx.99": "Sign up",
      "mw.tx.100": "Get token",
      "mw.tx.101": "(no catalog models — after adding, use \"Refresh models\" to pull /models live)",
      "mw.tx.102": "Replace",
      "mw.tx.103": "Search",
      "mw.tx.104": "＋ Custom",
      "mw.tx.105": "Popular providers (click a plan below to connect; multi-form brands pick the matching plan)",
      "mw.tx.106": "Website",
      "mw.tx.107": "Referral",
      "mw.tx.108": "No catalog match — pasting the full API URL triggers automatic reverse match + probe",
      "mw.tx.109": "pi builtin",
      "mw.tx.110": "Keyless probe only guesses the API type; paste a key for a precise probe",
      "mw.tx.111": "Custom endpoint (manual config)",
      "mw.tx.112": "Enter",
      "mw.tx.113": "Model check disabled — availability/balance hidden. Enable aiti-model-check in the extension manager, then refresh.",
      "mw.tx.114": "Failing/out of credit",
      "mw.tx.115": "Failing",
      "mw.tx.116": "no badge = untested",
      "mw.tx.117": "Runtime",
      "mw.tx.118": "← Select a provider / model on the left to view and edit details",
      "mw.tx.119": "Check disabled",
      "mw.tx.120": "Recheck",
      "mw.tx.121": "Runtime-registered",
      "mw.tx.122": "Check disabled (enable aiti-model-check to see availability)",
      "mw.tx.123": "Unchecked",
      "mw.tx.124": "Connection not tested yet (click \"Test\" on the right to verify key/endpoint; results are kept)",
      "mw.tx.125": "Querying balance…",
      "mw.tx.126": "Balance unavailable",
      "mw.tx.127": "Re-query",
      "mw.tx.128": "Combo members / weights / stickiness are edited on the \"Model combo\" tab",
      "mw.tx.129": "Edit",
      "mw.tx.130": "Sign-in status / account quota are managed on the \"Subscriptions\" tab",
      "mw.tx.131": "Manage",
      "mw.tx.132": "Runtime-registered providers: registered dynamically by pi extensions (e.g. pi-freeflow); models visible live via /api/models; not managed by models.json, shown read-only here.",
      "mw.tx.133": "＋ Add provider",
      "mw.tx.134": "Combo group — not included (managed on the \"Combo\" tab)",
      "mw.tx.135": "Subscription login — not included (credentials managed by the sign-in flow)",
      "mw.tx.136": "Runtime-registered — not included (registered by extensions, read-only)",
      "mw.tx.137": "Saved",
      "mw.tx.138": "All hard failures — nothing pre-selected (handle manually in the edit area)",
      "mw.tx.139": "Got it",
      "mw.tx.140": "Ignore",
      "mw.tx.141": "↩ Undo last save",
      "mw.tx.142": "Refresh proxy",
      "mw.tx.143": "← Back to list",
      "mw.tx.144": "Virtual model = several real members combined into one callable model; sticky routing within a session (same member within the TTL, maximizing prompt cache), auto-switch on 429 cooldown",
      "mw.tx.145": "Combo group name",
      "mw.tx.146": "🔴 Fill in at least a display name / provider id",
      "mw.tx.147": "Virtual model id",
      "mw.tx.148": "Remove model",
      "mw.tx.149": "No vision ⚠",
      "mw.tx.150": "Weight",
      "mw.tx.151": "Serves",
      "mw.tx.152": "All",
      "mw.tx.153": "Sticky idle TTL (minutes, default 15)",
      "mw.tx.154": "＋ Add a virtual model",
      "mw.tx.155": "Save combo group",
      "mw.tx.156": "＋ New combo group",
      "mw.tx.157": "Combine multiple real models into one virtual model exposed to pi; requires the pi-models-combo engine (multi-key proxy) to take over routing at runtime. Same protocol only.",
      "mw.tx.158": "No combo groups yet. Click \"New combo group\" to combine configured models into one virtual model.",
      "mw.tx.159": "Disabled",
      "mw.tx.160": "Free models come from third-party pi extensions — install and use, no API key; after installing, ",
      "mw.tx.161": "new sessions",
      "mw.tx.162": " take effect.",
      "mw.tx.163": "Free AI is usually ",
      "mw.tx.164": "or ",
      "mw.tx.165": "downgraded",
      "mw.tx.166": " — unless you catch a new-model free trial, quality is generally poor; fine for trials and light tasks, use paid models for important work.",
      "mw.tx.167": "No free models (central config empty or failed to load)",
      "mw.tx.168": "Installed ✓",
      "mw.tx.169": "Website/repo ↗",
      "mw.tx.170": "Loading model check (aiti-model-check)…",
      "mw.tx.171": "Failed to load model check (aiti-model-check failed to start; refresh the page and retry)",
      "mw.tx.172": "Functions",
      "mw.tx.173": "Refresh all proxies",
      "mw.tx.174": "Effective immediately",
      "mw.tx.175": "Export",
      "mw.tx.176": "Import",
      "mw.tx.177": "Adding",
      "mw.tx.178": "Add",
      "mw.tx.179": "Processing…",
      "mw.tx.180": "Re-invoke AI",
      "mw.tx.181": "Open model check",
      "mw.tx.182": "Click to view",
      "mw.eb.1": "At least one enabled model must remain.",
      "mw.eb.2": "This project's .pi/settings.json sets enabledModels and overrides global config; these toggles are read-only — edit that file directly.",
      "mw.eb.3": "Context window must be a positive integer in tokens (empty = default); invalid values were not written.",
      "mw.eb.4": "Save failed",
      "mw.eb.5": "Cannot fetch the model catalog: ",
      "mw.eb.6": "PI_OFFLINE is set; the model catalog will not be fetched from the network.",
      "mw.eb.7": "Cannot fetch the model catalog. Check the network connection and this provider's credentials, then retry.",
      "mw.eb.8": "Model list updated from the provider.",
      "mw.eb.9": "Model list is already up to date.",
      "mw.eb.10": " mismatches",
      "mw.eb.11": "Deletes config entries that match no models. Entries of providers without usable credentials are kept; everything else unchanged.",
      "mw.eb.12": "Clear model filters on all providers.",
      "mw.eb.13": "Enabled ",
      "mw.eb.14": "Enable/disable all models of ",
      "mw.eb.15": "",
      "mw.eb.16": "Enable filtered results",
      "mw.eb.17": "Enable all",
      "mw.eb.18": "Disable filtered results",
      "mw.eb.19": "Disable all",
      "mw.eb.20": "Fetch the provider's currently published model list now. pi's builtin list is pinned to the pi version bundled with pi-web; newly released models appear only after a refresh.",
      "mw.eb.21": "Refreshing…",
      "mw.eb.22": "Collapse model rows",
      "mw.eb.23": "Per-model toggles",
      "mw.eb.24": "Filter ",
      "mw.eb.25": " models…",
      "mw.eb.26": "Filter available models",
      "mw.eb.27": "Thinking level pinned by enabledModels; change it in settings.json.",
      "mw.eb.28": "Context window override (tokens), empty = default",
      "mw.eb.29": "(current ",
      "mw.eb.30": "'s context window",
      "mw.eb.31": "Show in the model selector: ",
      "mw.eb.32": "Loading enabled scope…",
      "mw.eb.33": "Clean stale entries",
      "mw.eb.34": "Enable all models",
      "mw.eb.35": "No available models for this provider yet. Save changes first and confirm the API key is valid (or complete sign-in).",
      "mw.eb.36": "Model enabled scope",
      "mw.eb.37": "Refresh catalog",
      "mw.eb.38": "No matching models.",
      "mw.eb.39": "Custom-provider models are added/removed directly in the \"Models\" edit area; this toggle controls whether the whole group appears in the selector.",
      "mw.tx.183": "Claude adaptive thinking (effort levels)",
      "mw.tx.184": "Subscription-login provider: credentials are managed by the sign-in flow (auth.json, auto-refreshed), not models.json — no key to edit here. View sign-in status / account / credits below; sign in again or switch accounts as needed.",
      "mw.tx.185": "Refresh selectable models",
      "mw.tx.186": "⚠ This is the static catalog list; these ids are not registered at runtime for \"{pid}\" — they may be missing from the selector and \"Refresh\" won't change that.",
      "mw.tx.187": "Other providers on the same account: ",
      "mw.tx.188": "🔐 Sign in",
      "mw.tx.189": "➕ Credit packs",
      "mw.tx.190": "Available models ({n}): ",
      "mw.tx.191": "🔐 Sign in {name}",
      "mw.tx.192": "Credits query failed: ",
      "mw.tx.193": "Available models ({n} — pick directly in the selector)",
      "mw.tx.194": "Authorization page opened: ",
      "mw.tx.195": "After sign-in the browser lands on an unresolvable localhost URL — paste that full URL here and submit: ",
      "mw.tx.196": "Open the authorization page and enter the code {code}: ",
      "mw.tx.197": "Refresh the page after saving to apply the models",
      "mw.tx.198": "✅ Last test passed",
      "mw.tx.199": " RL",
      "mw.tx.200": "🔑⏸ {n} disabled",
      "mw.tx.201": "🔑 API-key builtin provider: credentials live in auth.json (pi-hosted) — replace/remove below; the \"Subscriptions\" tab has consolidated management for all of them.",
      "mw.tx.202": "Pre-selection only changes checkmarks, nothing is written — per-provider or \"Save all\" writes models.json and refreshes proxies (undo afterwards via \"↩ Undo last save\")",
      "mw.tx.203": "Member {id}: types include \"image\" but the model doesn't support image input — image requests are still filtered out by capability; the check has no effect",
      "mw.tx.204": "Will appear in the model list as: ",
      "mw.tx.205": "I understand the differences above; save anyway",
      "mw.tx.206": "{n} differences pending confirmation",
      "mw.tx.207": "Background scan & reminders",
      "mw.eb.40": "Enable all",
      "mw.eb.41": "Context window override (tokens), empty = default; running sessions need a Pi Web restart to pick it up. Toggle = show/hide in the model selector.",
      "mw.s.addNeedKey": "add requires key",
      "mw.s.allCredsFail": "None of the {n} credentials pulled a model list",
      "mw.s.balanceFail": "Balance query failed: {err}",
      "mw.s.batchWriteFail": "Failed to batch-write models.json: {err}",
      "mw.s.checkupFail": "Health check failed: {err}",
      "mw.s.checkupRunning": "Health check in progress, please wait",
      "mw.s.comboEditHint": "\"{p}\" is a model combo group — edit it in the 🧙 panel under \"🧩 Model combo\".",
      "mw.s.ctxPositive": "Context window must be a positive integer in tokens (model: {m})",
      "mw.s.downloadFail": "Download failed",
      "mw.s.extNotInit": "Extension not initialized",
      "mw.s.freePkgInstalled": "Installed; takes effect in new sessions",
      "mw.s.freePkgRemoved": "Uninstalled; no longer loaded in new sessions",
      "mw.s.freePkgUpdated": "Updated; takes effect in new sessions",
      "mw.s.fwdFail": "{op} forward failed: {err}",
      "mw.s.importWriteFail": "Failed to write import: {err}",
      "mw.s.keyDup": "A key with the same name already exists: {n}",
      "mw.s.keyMissing": "Key not found: {n}",
      "mw.s.modelMissing": "Model not found: {id}",
      "mw.s.needBaseUrl": "baseUrl required",
      "mw.s.needBaseUrlApi": "baseUrl + api required",
      "mw.s.needBaseUrlOrText": "baseUrl or text required",
      "mw.s.needId": "id required",
      "mw.s.needName": "{op} requires name",
      "mw.s.needPBA": "provider + baseUrl + api required",
      "mw.s.needProvider": "provider required",
      "mw.s.needProviderForAllKeys": "allKeys/keyName requires provider",
      "mw.s.needProviderModel": "provider + model required",
      "mw.s.needProvidersObj": "providers object required ({name: {baseUrl, api, models…}})",
      "mw.s.needSavesArr": "saves array required",
      "mw.s.needSet": "set required",
      "mw.s.noKeysForPull": "This provider has no usable keys (none stored and none provided); cannot pull the model list",
      "mw.s.noTestableKeys": "No testable keys: provider {provider} {keyName}",
      "mw.s.noValidSave": "Nothing saved (all entries failed)",
      "mw.s.oauthNoCombo": "\"{p}\" is a subscription-login provider and cannot be overwritten as a combo group",
      "mw.s.oauthNoDelete": "\"{p}\" is a subscription-login provider, not in models.json — nothing to delete; sign out from the pi-web model settings instead.",
      "mw.s.oauthNoKeys": "\"{p}\" is a subscription-login provider; credentials are managed by sign-in — multi-key is not supported.",
      "mw.s.oauthNoToggle": "\"{p}\" is a subscription-login provider; credentials are managed by the sign-in flow (auth.json), not models.json — no need to enable/disable.",
      "mw.s.oauthWriteDenied": "\"{p}\" is a subscription-login provider; credentials are managed by the sign-in flow (auth.json) and cannot be written to models.json. To sign in again, open the 🧙 panel ☰ menu → \"🔐 Subscriptions\".",
      "mw.s.opInstall": "Install",
      "mw.s.opSignout": "Sign out",
      "mw.s.probeCapFail": "probe-cap failed: {err}",
      "mw.s.providerMissing": "Provider not found: {p}",
      "mw.s.providersEmpty": "providers is empty",
      "mw.s.readCfgFail": "Failed to read config: {err}",
      "mw.s.refreshFail": "Refresh failed: {err}",
      "mw.s.skipNoBaseurl": "Cannot determine baseUrl; skipped",
      "mw.s.skipNoMaxTokens": "Model has no maxTokens configured; skipped",
      "mw.s.unknownFreePkg": "Unknown free-package id: {id}",
      "mw.s.usageUnavailable": "aiti-provider-usage not installed or disabled",
      "mw.s.writeCfgFail": "Failed to write config",
      "mw.s.writeFail": "Failed to write models.json: {err}",
      "mw.s.writeOverridesFail": "Failed to write modelOverrides: {err}",
      },
    },

    dialogs: [{ id: "aiti-model-wizard-dialog", label: "aiti-model-wizard" }],
    banners: [{ id: "aiti-model-wizard-banner", label: "i18n:feat.aiti-model-wizard-banner" }],
    sessionStats: [{ id: "aiti-model-wizard-multikey-status", label: "i18n:feat.aiti-model-wizard-multikey-status", title: "i18n:feat.aiti-model-wizard-multikey-status.desc" }],
    // 模型选择器下拉底部动作区：「管理模型」入口（薄壳启动即注册，宿主 ModelSelector 全实例渲染）
    modelSelectorFooter: [{ id: "aiti-model-wizard-manage", label: "i18n:feat.aiti-model-wizard-manage", title: "i18n:feat.aiti-model-wizard-manage.desc" }],
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
      if (!configDir) return json({ ok: false, error: imsg("mw.s.extNotInit") }, 500);
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
        if (!id) return json({ ok: false, error: imsg("mw.s.needId") }, 400);
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
        if (!it || !it.npm) return json({ ok: false, error: imsg("mw.s.unknownFreePkg", { id: String(b.id) }) }, 400);
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
          return json({ ok: true, action, npm: it.npm, message: imsg(action === "install" ? "mw.s.freePkgInstalled" : action === "remove" ? "mw.s.freePkgRemoved" : "mw.s.freePkgUpdated") });
        } catch (err: any) {
          return json({ ok: false, error: imsg("mw.s.fwdFail", { op: imsgRaw("mw.s.opInstall"), err: err?.message || String(err) }) }, 502);
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
        return r.ok ? json({ ok: true, refreshed: r.refreshed, source: d.source, bytes: d.bytes, providers: d.providers, elapsedMs: d.elapsedMs, justget: !!d.justget }) : json({ ok: false, error: r.error || d.error || imsgRaw("mw.s.downloadFail") }, 500);
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
        if (!raw) return json({ ok: false, error: imsg("mw.s.needBaseUrlOrText") }, 400);
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
        if (!baseUrl) return json({ ok: false, error: imsg("mw.s.needBaseUrl") }, 400);
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
        if (!b.baseUrl || !b.api) return json({ ok: false, error: imsg("mw.s.needBaseUrlApi") }, 400, 400);
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
          if (!b.provider) return json({ ok: false, error: imsg("mw.s.needProviderForAllKeys") }, 400);
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
          if (!targets.length) return json({ ok: false, error: imsg("mw.s.noTestableKeys", { provider: b.provider || "", keyName: b.keyName || "" }) });
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
        if (g[gk]) return json({ ok: false, error: imsg("mw.s.checkupRunning") }, 409);
        g[gk] = true;
        try {
          const r = await core.runCheckup(configDir, c, { timeoutMs: (c.test && c.test.timeoutMs) || 12000 });
          return json(r);
        } catch (e: any) {
          return json({ ok: false, error: imsg("mw.s.checkupFail", { err: (e && e.message) || e }) }, 500);
        } finally { delete g[gk]; }
      }
      // POST /oauth-logout {provider} → 订阅登录型登出：转发同进程宿主 /api/auth/logout/<pid>
      // （宿主清 auth.json 凭据 + invalidateModelsCache；凭据链不经过本扩展）。幂等：未登录时宿主 400 原样回传。
      if (p[0] === "oauth-logout" && req.method === "POST") {
        const provider = String((body && body.provider) || "").trim();
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
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
          return json({ ok: false, error: imsg("mw.s.fwdFail", { op: imsgRaw("mw.s.opSignout"), err: err?.message || String(err) }) }, 502);
        }
      }
      // GET /usage?provider=X&force=1 → 余额/配额：消费 aiti-provider-usage 服务（软依赖；
      // 缺席 available:false，UI 降级隐藏余额段，不自行拉上游——TTL/并发归 provider-usage 管）
      if (p[0] === "usage" && req.method === "GET") {
        const provider = String(ctx.searchParams.get("provider") || "").trim();
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
        const svc = servicesCtx?.get?.("aiti-provider-usage.overview") ?? null;
        if (!svc || typeof svc.overview !== "function") return json({ ok: true, available: false, reason: imsgRaw("mw.s.usageUnavailable") });
        try {
          const ov = await svc.overview(ctx.searchParams.get("force") === "1");
          const entry = (ov && Array.isArray(ov.providers) ? ov.providers : []).find((x: any) => x && x.providerId === provider) || null;
          return json({ ok: true, available: true, capturedAt: (ov && ov.capturedAt) || null, entry });
        } catch (e: any) {
          return json({ ok: true, available: true, error: imsg("mw.s.balanceFail", { err: (e && e.message) || e }) });
        }
      }
      // POST /discover {baseUrl, api, apiKey?}
      if (p[0] === "discover" && req.method === "POST") {
        const b = body || {};
        if (!b.baseUrl || !b.api) return json({ ok: false, error: imsg("mw.s.needBaseUrlApi") }, 400, 400);
        const r = await core.discoverModels({ baseUrl: b.baseUrl, api: b.api, apiKey: b.apiKey }, { timeoutMs: 12000, extraHeaders: sanitizeHeaders(b.headers) });
        if (!r.ok) return json({ ok: false, error: r.error }, 502);
        refluxAux(String(b.baseUrl || ""), (r as any).raw);
        const { raw: _raw, ...rest } = r as any; // raw（全量原始数据）只供回流，不进响应（数百 KB）
        return json({ ok: true, ...rest });
      }
      // POST /discoverStored {provider, apiKey?} → 编辑流刷新可选模型：用存储 key（或刚填的新 key）拉 /models
      if (p[0] === "discoverStored" && req.method === "POST") {
        const provider = String((body && body.provider) || "").trim();
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers && data.providers[provider];
          if (!prov) return json({ ok: false, error: imsg("mw.s.providerMissing", { p: provider }) }, 404);
          // 多 key 感知：刚填的新 key → 单 apiKey → 已存 apiKeys 逐把轮试（任一把拉到即用）→ 环境变量兑底
          const supplied = String((body && body.apiKey) || "").trim();
          const storedList: string[] = Array.isArray(prov.apiKeys) ? prov.apiKeys.map((k: any) => String((k && k.key) || "")).filter(Boolean) : [];
          const cands: string[] = [...new Set([supplied, String(prov.apiKey || ""), ...storedList])].filter(Boolean);
          if (prov.apiKeyEnv && process.env[prov.apiKeyEnv]) cands.push(String(process.env[prov.apiKeyEnv]));
          if (!cands.length) return json({ ok: false, error: imsg("mw.s.noKeysForPull") }, 400);
          // 生效请求头（审核修正）：已存 headers + 未保存草稿（body.headers 覆盖、掩码行回存）
          const xh = effectiveHeaders(body, provider);
          let r: any = null;
          for (const key of cands) {
            r = await core.discoverModels({ baseUrl: prov.baseUrl, api: prov.api, apiKey: key }, { timeoutMs: 12000, extraHeaders: xh });
            if (r.ok) break;
          }
          if (!r || !r.ok) return json({ ok: false, error: (r && r.error) || imsgRaw("mw.s.allCredsFail", { n: cands.length }) }, 502);
          // 新模型检测：刷新即快照今日可用列表；返回相对前日基线的"新增"（编辑流预勾选用）
          core.snapshotProvider(configDir, provider, r.models.map((m: any) => m.id));
          refluxAux(String(prov.baseUrl || ""), (r as any).raw); // 编辑流「刷新可选模型」同源回流：拉到的实时目录即刻可反填参数
          const { raw: _raw2, ...rest } = r; // raw 只供回流，不进响应（数百 KB）
          const newModels = core.newModelsForProvider(configDir, c, provider);
          return json({ ok: true, ...rest, newModels, newCount: newModels.length });
        } catch (e: any) {
          return json({ ok: false, error: imsg("mw.s.readCfgFail", { err: (e && e.message) || e }) }, 500);
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
        if (isOauthManaged(String(b.provider || ""))) return json({ ok: false, error: imsg("mw.s.oauthNoCombo", { p: b.provider }) }, 400);
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
          return json({ ok: false, error: imsg("mw.s.writeFail", { err: (e && e.message) || e }) }, 500);
        }
      }
      // GET /modelParams?provider=X → 查看该 provider 已配置模型的完整参数（只读）
      // &refresh=1 → 有模型在任何源都查不到参数时强制刷新一次 models.dev 再查
      if (p[0] === "modelParams" && req.method === "GET") {
        const provider = String(ctx.searchParams.get("provider") || "").trim();
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
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
          return json({ ok: false, error: imsg("mw.s.writeFail", { err: (e && e.message) || e }) }, 500);
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
        if (!incoming) return json({ ok: false, error: imsg("mw.s.needProvidersObj") }, 400);
        const names = Object.keys(incoming).slice(0, 200);
        if (!names.length) return json({ ok: false, error: imsg("mw.s.providersEmpty") }, 400);
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
          return json({ ok: false, error: imsg("mw.s.importWriteFail", { err: (e && e.message) || e }) }, 500);
        }
      }
      // POST /save-batch {saves:[SaveBody…]} — 批量导入专用（aiti-models-import 经 saveBatch service 调同一实现）：
      // 批前一次 undo 快照（多 provider patch）→ 单次写盘/缓存失效/代理刷新；单条失败不中断；/undo 一步回整批
      if (p[0] === "save-batch" && req.method === "POST") {
        const saves = Array.isArray(body?.saves) ? body.saves : [];
        if (!saves.length) return json({ ok: false, error: imsg("mw.s.needSavesArr") }, 400);
        try {
          const r = await saveBatchImpl(ctx, saves);
          if (!r.ok) return json(r, 400);
          return json(r);
        } catch (e: any) {
          return json({ ok: false, error: imsg("mw.s.batchWriteFail", { err: (e && e.message) || e }) }, 500);
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
        if (!provider || !modelId) return json({ ok: false, error: imsg("mw.s.needProviderModel") }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers && data.providers[provider];
          if (!prov) return json({ ok: false, error: imsg("mw.s.providerMissing", { p: provider }) }, 404);
          const entry = Array.isArray(prov.models) ? prov.models.find((m: any) => m && (typeof m === "object" ? (m.id || m.model) : m) === modelId) : null;
          const meta = entry && typeof entry === "object" ? entry : null;
          const maxTokens = meta && Number(meta.maxTokens);
          if (!Number.isFinite(maxTokens) || maxTokens <= 0) return json({ ok: true, skipped: true, corrected: false, detail: imsgRaw("mw.s.skipNoMaxTokens") });
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
          if (!baseUrl) return json({ ok: true, skipped: true, corrected: false, detail: imsgRaw("mw.s.skipNoBaseurl") });
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
          return json({ ok: false, error: imsg("mw.s.probeCapFail", { err: (e && e.message) || e }) }, 500);
        }
      }
      // POST /delete {provider} → provider 整体删除（apiKeys 一并消失）
      if (p[0] === "delete" && req.method === "POST") {        const provider = String((body && body.provider) || "");
        if (isOauthManaged(provider)) return json({ ok: false, error: imsg("mw.s.oauthNoDelete", { p: provider }) }, 400);
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
          return json({ ok: false, error: imsg("mw.s.writeFail", { err: (e && e.message) || e }) }, 500);
        }
      }
      // POST /enable {provider, enabled} → 临时禁用/启用 provider（不删除配置；立即停/建代理 + 刷新槽位）
      //   聚合组同样适用：enabled:false = 整个组停用（模型列表隐藏、不建代理）
      if (p[0] === "enable" && req.method === "POST") {
        const provider = String((body && body.provider) || "");
        const enabled = !(body && body.enabled === false);
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
        if (isOauthManaged(provider)) return json({ ok: false, error: imsg("mw.s.oauthNoToggle", { p: provider }) }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers?.[provider];
          if (!prov) return json({ ok: false, error: imsg("mw.s.providerMissing", { p: provider }) }, 404);
          // 快照：一级撤销可恢复误切
          core.stashUndo(configDir, { [provider]: prov });
          if (enabled) delete prov.enabled; else prov.enabled = false;
          await ctx.core.writeModelsConfig(data);
          refreshProxiesViaCombo(provider);
          return json({ ok: true, provider, enabled, file: "(pi-web /api/models-config)" });
        } catch (e: any) {
          return json({ ok: false, error: imsg("mw.s.writeFail", { err: (e && e.message) || e }) }, 500);
        }
      }
      // POST /model-enable {provider, model, enabled} → 临时禁用/启用单个模型（不删除；模型从列表隐藏、组合成员跳过）
      if (p[0] === "model-enable" && req.method === "POST") {
        const provider = String((body && body.provider) || "");
        const modelId = String((body && body.model) || "");
        const enabled = !(body && body.enabled === false);
        if (!provider || !modelId) return json({ ok: false, error: imsg("mw.s.needProviderModel") }, 400);
        if (isOauthManaged(provider)) return json({ ok: false, error: "「" + provider + "」是订阅登录型 provider，凭据由登录流程管理，不支持此操作。" }, 400);
        try {
          const data: any = (await ctx.core.readModelsConfig()) || { providers: {} };
          const prov = data.providers?.[provider];
          if (!prov) return json({ ok: false, error: imsg("mw.s.providerMissing", { p: provider }) }, 404);
          const models = Array.isArray(prov.models) ? prov.models : [];
          const mdef = models.find((m: any) => m && String(m.id ?? m.model ?? "") === modelId);
          if (!mdef) return json({ ok: false, error: imsg("mw.s.modelMissing", { id: provider + "/" + modelId }) }, 404);
          core.stashUndo(configDir, { [provider]: prov });
          if (enabled) delete mdef.enabled; else mdef.enabled = false;
          await ctx.core.writeModelsConfig(data);
          refreshProxiesViaCombo(provider);
          return json({ ok: true, provider, model: modelId, enabled, file: "(pi-web /api/models-config)" });
        } catch (e: any) {
          return json({ ok: false, error: imsg("mw.s.writeFail", { err: (e && e.message) || e }) }, 500);
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
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
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
        if (!provider || !modelId) return json({ ok: false, error: imsg("mw.s.needProviderModel") }, 400);
        const raw = b.contextWindow;
        let value: number | undefined;
        if (raw !== undefined && raw !== null && raw !== "") {
          const n = typeof raw === "number" ? raw : Number(String(raw).trim());
          if (!Number.isSafeInteger(n) || n < 1) return json({ ok: false, error: imsg("mw.s.ctxPositive", { m: modelId }) }, 400);
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
          return json({ ok: false, error: imsg("mw.s.writeOverridesFail", { err: (e && e.message) || e }) }, 500);
        }
      }
      // GET /keys?provider= → 某 provider 的 keys（打码，models.json provider.apiKeys）
      // POST /keys {provider, keys: [...]} → 整体替换（空数组=清空）；{provider, action:"remove", name} → 删一个
      if (p[0] === "keys" && req.method === "GET") {
        const provider = String(ctx.searchParams.get("provider") || "").trim();
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
        const keys = core.getProviderKeys(configDir, c, provider);
        // enabled 必须透传：key 行的禁用视觉（灰底/▶ 切回按钮）全靠它——漏掉则
        // 已禁用的 key 在 UI 里永远显示为正常态（实测 2026-09-07：禁用"没效果"）
        return json({ ok: true, provider, file: "models.json", keys: keys.map((k: any) => ({ name: k.name, key: core.maskKey(k.key), rpm: k.rpm, minIntervalMs: k.minIntervalMs, ...(k.enabled === false ? { enabled: false } : {}) })), keyCount: keys.length });
      }
      if (p[0] === "keys" && req.method === "POST") {
        const b = body || {};
        const provider = String((b.provider || "")).trim();
        if (!provider) return json({ ok: false, error: imsg("mw.s.needProvider") }, 400);
        if ((b.action === "set" || b.action === "remove")) {
          try { const { byKey } = getIndex(); if (byKey.get(provider)?.authType === "oauth") return json({ ok: false, error: imsg("mw.s.oauthNoKeys", { p: provider }) }, 400); } catch {}
        }
        if (b.action === "remove") {
          const name = String((b.name || "")).trim();
          if (!name) return json({ ok: false, error: imsg("mw.s.needName", { op: "remove" }) }, 400);
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
          if (!name) return json({ ok: false, error: imsg("mw.s.needName", { op: "update" }) }, 400);
          const cur = core.getProviderKeys(configDir, c, provider);
          if (!cur.some((k: any) => k.name === name)) return json({ ok: false, error: imsg("mw.s.keyMissing", { n: name }) }, 404);
          const newName = String((b.newName ?? "")).trim();
          if (newName && newName !== name && cur.some((k: any) => k.name === newName)) return json({ ok: false, error: imsg("mw.s.keyDup", { n: newName }) }, 400);
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
          if (!key) return json({ ok: false, error: imsg("mw.s.addNeedKey") }, 400);
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
          return json({ ok: false, error: imsg("mw.s.refreshFail", { err: (e && e.message) || e }) }, 500);
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
          return json({ ok: false, error: imsg("mw.s.writeCfgFail") }, 500);
        }
        return json({ ok: false, error: imsg("mw.s.needSet") }, 400);
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
