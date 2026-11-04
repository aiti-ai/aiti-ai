/**
 * aiti-model-wizard · 核心逻辑（CommonJS，Node 原生可跑）
 *
 * 职责：模型添加开机向导的纯逻辑 ——
 *   - 目录：models.dev（justget 多源下载 + Gitee 镜像缓存）+ 内嵌国内 AI 目录（中文名/注册/领 token）；
 *     TTL 过期启动后台刷新；保存/查询未知模型查不到参数时强制刷新一次
 *   - 模型元数据反填三源：models.json 已有条目 → 内置目录 models-store → models.dev（含完整规格映射），
 *     未知模型（stealth 新模型如 ox-alpha-free）不再落裸 {id} 被 pi 落到 128k/16k 硬默认
 *   - 搜索（中/英/别名/模型 id）→ 提供商详情（api 地址 / doc / 注册说明 / 领 token 地址）
 *   - 反向匹配（normalizeBaseUrl 剥 /v1 /v2 /v1beta 后比 host+path）
 *   - 自动探测（探 endpoints 判定 api 类型 + 真实地址，用户漏 v1/v2 也能补）
 *   - 测试连接（探针消息：2xx / 429 都算通过）
 *   - 模型发现（/models 列表 ∪ 目录已知模型，去重）
 *   - 多 keys 管理：apiKeys 存于 models.json 同目录 api-keys.json（隐藏于 pi-coding-agent 之外，不进 headers）
 *   - models.json 读写（原子写 + 合并）+ token 一律打码只进不出
 *
 * 设计：docs/aiti-model-wizard-extension-plan.md
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

// ---------------- 常量 ----------------
const PROBE_SYSTEM = "Reply with exactly one word: ok";
const PROBE_USER = "ping";

const DEFAULT_CONFIG = {
  modelsPath: "~/.pi/agent/models.json",
  // pi 动态模型目录（内置配置）：models.json 里 provider 缺 baseUrl/models 时用它补全（如 zai-coding-cn 只存 key）
  modelsStorePath: "~/.pi/agent/models-store.json",
  catalog: {
    primaryUrl: "https://models.dev/api.json",
    mirrorUrl: "https://gitee.com/justdb-mirrors/downloads/raw/master/models-dev/api.json",
    ttlHours: 168,            // 7 天缓存（超时视为 stale：启动后台刷新；保存未知模型时强制刷新）
    snapshotPath: "",         // 内嵌快照（部署时指向 ext dir/catalog/models.dev.json）
    autoRefresh: true,        // 未知模型反填查不到时自动强制刷新一次目录（false = 只用现有缓存/快照，离线/测试用）
    // 兜底公共目录（反填第④⑤源；公开免 key，下载失败静默跳过，不影响保存）：
    openRouter: true,         // OpenRouter /api/v1/models —— context_length/pricing/modalities/supported_parameters
    liteLlm: true,            // LiteLLM model_prices_and_context_window.json —— 覆盖最广的社区价目表
    openRouterUrl: "https://openrouter.ai/api/v1/models",
    liteLlmUrl: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    auxTimeoutMs: 30000,      // 兜底目录下载超时
  },
  download: {
    justget: "auto",          // justget CLI 路径 或 "auto"（自动找）
    timeoutMs: 90000,
  },
  probe: { timeoutMs: 12000, maxTokens: 8 },
  test: { timeoutMs: 12000 },   // 连接测试/一键体检超时（可经设置面板调）
  // 厂商推广计划（运营配置，实际链接填在 configDir/config.json，不进公开仓库）
  // 格式：{ "<推荐卡片id>": { "link": "https://.../", "note": "注册送X，返佣Y" } }
  affiliate: {},
  // 在线加载 affiliate：从中心 URL 拉取（Node 侧无 CORS），本地缓存 + TTL；失败回退本地 affiliate/缓存
  affiliateUrl: "https://aiti.pw/models/config.json",   // 置空 = 禁用在线，只读本地 affiliate
  affiliateCacheMs: 5 * 60 * 1000,                      // 拉取缓存 TTL（默认 5 分钟）
  // 新模型检测与提醒：后台定时拉各 provider /models 快照（今日桶），比对前日基线发现新模型；
  // toast 频控：每天最多 maxPerDay 次、相邻间隔 ≥ minGapMs
  reminder: {
    enabled: true,
    checkIntervalMs: 30 * 60 * 1000,   // 后台扫描间隔（30 分钟）
    fetchTimeoutMs: 8000,              // 单 provider /models 拉取超时
    maxPerDay: 100,                    // toast 常驻化后频控仅作极端刷屏兑底（关闭即 ack，正常不会触顶）
    minGapMs: 30 * 1000,               // 相邻 toast 最小间隔（30 秒；防快速连续刷新时闪烁）
    driftMaxCount: 10,                 // 整目录漂移降噪：单家一次新增超过此数 → 视为目录漂移不提醒
    driftRatio: 0.25,                  // 或超过现列表的 25%（两者取大）——厂商整包目录更新不刷屏
    toastMs: 10000,                    // toast 展示时长（10 秒）
  },
};

// ---------------- 工具 ----------------
function expandPath(p) {
  if (!p) return p;
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}
function now() { return Date.now(); }
function mkdirp(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }
function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  try { mkdirp(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; } catch (e) { return false; }
}
function writeJSONAtomic(file, data) {
  try {
    mkdirp(path.dirname(file));
    const tmp = file + ".tmp" + Math.random().toString(36).slice(2);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { return false; }
}
function fmtDur(ms) { return ms == null ? "-" : ms < 1000 ? ms + "ms" : (ms / 1000).toFixed(1) + "s"; }

// ---------------- 配置 ----------------
function loadConfig(configDir) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg._file = path.join(configDir || "", "config.json");
  try {
    const user = JSON.parse(fs.readFileSync(cfg._file, "utf8"));
    for (const k of Object.keys(user)) {
      if (k && typeof k === "string" && !k.startsWith("_")) {
        if (user[k] && typeof user[k] === "object" && !Array.isArray(user[k]) && cfg[k] && typeof cfg[k] === "object") {
          cfg[k] = { ...cfg[k], ...user[k] };
        } else cfg[k] = user[k];
      }
    }
  } catch (e) {}
  return cfg;
}
function saveConfig(cfg, configDir) {
  try {
    mkdirp(configDir || "");
    const { _file, ...rest } = cfg;
    fs.writeFileSync(path.join(configDir || "", "config.json"), JSON.stringify(rest, null, 2) + "\n");
    return true;
  } catch (e) { return false; }
}

// ── affiliate 在线加载（中心 URL + 本地缓存 + TTL）────────────────────────────
// 拉取 https://aiti.pw/models/config.json（Node fetch，无浏览器 CORS），结果内存+磁盘双缓存；
// 过期重拉，失败回退磁盘缓存→上次内存→本地 config.affiliate。中心文件结构 = 本地同款：
// { "affiliate": { "<卡id>": { "link", "note" } } }（无 affiliate 键则整个对象视为卡映射）。
let _affCache = { ts: 0, items: null };
function normalizeAffiliate(raw) {
  const src = raw && typeof raw === "object" ? (raw.affiliate || raw) : {};
  const items = {};
  for (const [k, v] of Object.entries(src)) {
    const a = v;
    if (a && typeof a === "object" && a.link) items[k] = { link: String(a.link), note: a.note ? String(a.note) : "" };
  }
  return items;
}
/** cache 根：宿主 configDir = <extRoot>/config → <extRoot>/cache；否则（测试/独立）按传入目录下 cache/（2026-09-13 三目录对称）。 */
function cacheBase(configDir) {
  const p = configDir || "";
  return path.basename(p) === "config" ? path.join(path.dirname(p), "cache") : path.join(p, "cache");
}
function affCacheFile(configDir) { return path.join(cacheBase(configDir), "affiliate-cache.json"); }
function readAffCacheDisk(configDir) {
  try { return JSON.parse(fs.readFileSync(affCacheFile(configDir), "utf8")); } catch (e) { return null; }
}
function writeAffCacheDisk(configDir, items) {
  try {
    mkdirp(configDir || "");
    fs.writeFileSync(affCacheFile(configDir), JSON.stringify({ ts: Date.now(), items }, null, 2) + "\n");
  } catch (e) {}
}
/** 读 affiliate：优先中心 URL（带 TTL 缓存），失败回退磁盘缓存→内存→本地 config.affiliate。 */
async function loadAffiliate(configDir, cfg) {
  const ttl = (cfg && cfg.affiliateCacheMs) || 5 * 60 * 1000;
  // 1) TTL 内先用内存命中
  if (_affCache.items && Date.now() - _affCache.ts < ttl) return _affCache.items;
  // 2) TTL 内先从磁盘命中（重启后仍可用）
  const disk = readAffCacheDisk(configDir);
  if (disk && disk.items && Date.now() - disk.ts < ttl) { _affCache = { ts: disk.ts, items: disk.items }; return disk.items; }
  // 3) 中心 URL 拉取（Node fetch，无 CORS）
  const url = cfg && cfg.affiliateUrl;
  if (url) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "aiti-model-wizard/0.1", accept: "application/json" }, redirect: "follow" });
      clearTimeout(to);
      if (r.ok) {
        const items = normalizeAffiliate(await r.json());
        _affCache = { ts: Date.now(), items };
        writeAffCacheDisk(configDir, items);
        return items;
      }
    } catch (e) {}
  }
  // 4) 中心不可用：回退磁盘缓存（即使过期也先用）→ 内存 → 本地 config.affiliate
  if (disk && disk.items) { _affCache = { ts: disk.ts, items: disk.items }; return disk.items; }
  if (_affCache.items) return _affCache.items;
  return normalizeAffiliate(cfg && cfg.affiliate);
}

// ── 免费模型列表（在线加载：中心 URL 的 freeModels 节，本地缓存+TTL；失败回退本地 config.freeModels）──
let _freeCache = { ts: 0, items: null };
function normalizeFreeModels(raw) {
  const src = raw && typeof raw === "object" ? (raw.freeModels || {}) : {};
  const items = {};
  for (const [k, v] of Object.entries(src)) {
    const a = v;
    if (a && typeof a === "object" && a.npm) items[k] = {
      npm: String(a.npm),
      name: String(a.name || k),
      desc: String(a.desc || ""),
      note: String(a.note || ""),
      url: a.url ? String(a.url) : "",
      models: Array.isArray(a.models) ? a.models.map((m) => String(m)).slice(0, 12) : [],
    };
  }
  return items;
}
function freeCacheFile(configDir) { return path.join(configDir || "", "free-models-cache.json"); }
function readFreeCacheDisk(configDir) {
  try { return JSON.parse(fs.readFileSync(freeCacheFile(configDir), "utf8")); } catch (e) { return null; }
}
function writeFreeCacheDisk(configDir, items) {
  try {
    mkdirp(configDir || "");
    fs.writeFileSync(freeCacheFile(configDir), JSON.stringify({ ts: Date.now(), items }, null, 2) + "\n");
  } catch (e) {}
}
/** 提取免费包的包名：npm:pi-freeflow / npm:pi-freeflow@1.2 / npm:@scope/pkg@ver → 裸包名。 */
function freeNpmName(npm) {
  const s = String(npm || "");
  if (!s.startsWith("npm:")) return "";
  const spec = s.slice(4);
  const at = spec.lastIndexOf("@");
  const scoped = spec.startsWith("@");
  if (at > (scoped ? spec.indexOf("/") : 0)) return spec.slice(0, at);
  return spec;
}

/** 用「已装包名集合」匹配免费包安装状态（名字一样即算已装——本地路径开发版与 npm 版同包名）。
 *  包名来源：进程内 /api/plugins 的 packageName（pi SDK 从各包 package.json 解析）。
 *  返回 {[id]: true}。 */
function matchInstalledFree(items, pkgNames) {
  const names = pkgNames instanceof Set ? pkgNames : new Set(pkgNames || []);
  const out = {};
  for (const [id, it] of Object.entries(items || {})) {
    const name = freeNpmName(it && it.npm);
    out[id] = !!name && names.has(name);
  }
  return out;
}


/** 读免费模型列表：优先中心 URL（带 TTL 缓存），失败回退磁盘缓存→内存→本地 config.freeModels。 */
async function loadFreeModels(configDir, cfg) {
  const ttl = (cfg && cfg.affiliateCacheMs) || 5 * 60 * 1000;
  if (_freeCache.items && Date.now() - _freeCache.ts < ttl) return _freeCache.items;
  const disk = readFreeCacheDisk(configDir);
  if (disk && disk.items && Date.now() - disk.ts < ttl) { _freeCache = { ts: disk.ts, items: disk.items }; return disk.items; }
  const url = cfg && cfg.affiliateUrl;
  if (url) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "aiti-model-wizard/0.1", accept: "application/json" }, redirect: "follow" });
      clearTimeout(to);
      if (r.ok) {
        const items = normalizeFreeModels(await r.json());
        // 中心 200 但无 freeModels 节（站点未发布/回滚）→ 不写缓存不返回空，继续回退链，防空结果固化 TTL
        if (Object.keys(items).length) {
          _freeCache = { ts: Date.now(), items };
          writeFreeCacheDisk(configDir, items);
          return items;
        }
      }
    } catch (e) {}
  }
  if (disk && disk.items) { _freeCache = { ts: disk.ts, items: disk.items }; return disk.items; }
  if (_freeCache.items) return _freeCache.items;
  return normalizeFreeModels(cfg && cfg.freeModels);
}

// ==================== 多 keys 管理（models.json 的 provider.apiKeys） ====================
// 多 key 存于 models.json 的 provider 配置里：providers.<p>.apiKeys = [{name, key, rpm?}]。
// 实证：TypeBox 1.3.7 对未知属性放行（T.Object 默认允许 additional），pi 加载 models.json 不报错；
// 运行时只取 apiKey/baseUrl，apiKeys 不进请求头、不转发给上游 → 对 pi 和上游都是隐藏的。
// models.json 的 apiKey 恒等于第一个 key（pi 直连也直接可用）。
// 格式：
//   "providers": { "openrouter": {
//     "apiKey": "sk-first",
//     "apiKeys": [ { "name": "key-1", "key": "sk-xxx", "rpm": 60 }, ... ]
//   } }

/** 读某 provider 的 keys 数组（无则 []；从 models.json 的 provider.apiKeys） */
function getProviderKeys(configDir, cfg, provider) {
  const { data } = loadModelsJson(configDir, cfg);
  const p = data.providers && data.providers[provider];
  const keys = p && p.apiKeys;
  return dedupKeyNames(Array.isArray(keys) ? keys.map(normalizeKeyEntry).filter(Boolean) : []);
}
/** key 名唯一化：同名追加 -2/-3；空名自动 key-<i>；返回新数组（不改原文件） */
function dedupKeyNames(clean) {
  const seen = new Set();
  const out = [];
  for (const k of clean) {
    let n = k.name || "key";
    if (seen.has(n)) { let i = 2; while (seen.has(n + "-" + i)) i++; n = n + "-" + i; }
    seen.add(n); out.push({ ...k, name: n });
  }
  return out;
}
/** 写某 provider 的 keys（空数组 → 清空 apiKeys）；同步 apiKey=第一个 key。单一 models.json 原子写。 */
function setProviderKeys(configDir, cfg, provider, keys) {
  if (!provider) return { ok: false, error: "缺少 provider 名" };
  const { file, data } = loadModelsJson(configDir, cfg);
  const prov = data.providers && data.providers[provider];
  if (!prov) return { ok: false, error: "provider 不在 models.json: " + provider };
  const clean = dedupKeyNames(Array.isArray(keys) ? keys.map(normalizeKeyEntry).filter((k) => k && k.key) : []);
  if (clean.length) {
    prov.apiKeys = clean;
    // apiKey 恒 = 第一个「启用」的 key（pi 直连与代理回退都用它；禁用首个 key 后自动切到下一把启用 key）
    const active = clean.find((k) => k.enabled !== false) || clean[0];
    prov.apiKey = active.key;
  } else {
    delete prov.apiKeys;
    delete prov.apiKey;
  }
  if (!saveModelsJson(configDir, cfg, data)) return { ok: false, error: "写 models.json 失败" };
  return { ok: true, provider, keys: clean.map(maskKeyEntry), file, modelsSynced: clean.length > 0 };
}
/** 规范化单条 key 条目 */
function normalizeKeyEntry(k) {
  if (typeof k === "string") return { name: "key", key: k };
  if (!k || typeof k !== "object") return null;
  const rpm = k.rpm ? Math.max(1, Math.floor(k.rpm)) : undefined;
  // minIntervalMs：等间距节流透传。留空=auto（代理按 rpm 折算）；0=关闭匀速（突发滑窗）；正数=固定毫秒
  let minIntervalMs;
  if (k.minIntervalMs === 0 || k.minIntervalMs === "0") minIntervalMs = 0;
  else if (k.minIntervalMs === "auto" || k.minIntervalMs === true) minIntervalMs = "auto";
  else if (k.minIntervalMs !== undefined && k.minIntervalMs !== null && k.minIntervalMs !== "") {
    const mi = Math.floor(Number(k.minIntervalMs));
    minIntervalMs = Number.isFinite(mi) && mi > 0 ? mi : undefined;
  }
  // enabled:false = 临时禁用（不删除）：透传保留；引擎 normalizeApiKeys 跳过、不参与轮转
  return { name: String(k.name || "key"), key: String(k.key || ""), rpm, minIntervalMs, ...(k.enabled === false ? { enabled: false } : {}) };
}
/** 打码 keys（只进不出）：每个 key 的 key 字段打码 */
function maskKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return keys.map(maskKeyEntry);
}
function maskKeyEntry(k) {
  return { name: k && k.name, key: maskKey(k && k.key), rpm: k && k.rpm, minIntervalMs: k && k.minIntervalMs, ...(k && k.enabled === false ? { enabled: false } : {}) };
}

// ---------------- 目录缓存（models.dev） ----------------
function catalogCachePath(configDir) { return path.join(cacheBase(configDir), "catalog", "models.dev.json"); }
function catalogMetaPath(configDir) { return path.join(cacheBase(configDir), "catalog", "meta.json"); }

/** models.dev 格式统一：api.json 顶层就是 provider 映射（无 providers 包裹）；兼容两种。 */
function normalizeModelsDev(d) {
  if (!d || typeof d !== "object") return null;
  if (d.providers && typeof d.providers === "object") return d;
  const first = Object.values(d)[0];
  if (first && typeof first === "object" && (first.id !== undefined || first.models !== undefined || first.api !== undefined || first.name !== undefined)) {
    return { providers: d };
  }
  return null;
}

function loadModelsDev(configDir, cfg) {
  const cache = normalizeModelsDev(readJSON(catalogCachePath(configDir)));
  if (cache) {
    const meta = readJSON(catalogMetaPath(configDir), {});
    const ttlMs = ((cfg && cfg.catalog && cfg.catalog.ttlHours) || 168) * 3600 * 1000;
    const ageMs = meta.ts ? Date.now() - meta.ts : null;
    return { data: cache, meta, from: "cache", ageMs, stale: ageMs == null ? true : ageMs > ttlMs };
  }
  const snap = cfg && cfg.catalog && cfg.catalog.snapshotPath;
  if (snap) {
    const d = normalizeModelsDev(readJSON(expandPath(snap)));
    if (d) return { data: d, meta: { from: "snapshot", ts: 0 }, from: "snapshot", ageMs: null, stale: true };
  }
  return { data: null, meta: {}, from: "none", ageMs: null, stale: true };
}
function saveModelsDevCache(configDir, data, meta) {
  writeJSON(catalogCachePath(configDir), data);
  writeJSON(catalogMetaPath(configDir), { ...(meta || {}), ts: Date.now() });
}
function cacheAgeMs(configDir) {
  const meta = readJSON(catalogMetaPath(configDir), {});
  return meta.ts ? Date.now() - meta.ts : null;
}

// ---------------- justget 下载（多源竞速：官方 + Gitee 镜像） ----------------
function findJustget() {
  const cands = [
    process.env.JUSTGET_BIN,
    path.join(os.homedir(), "workspace", "justget", "dist", "cli.js"),
    path.join(os.homedir(), "workspace", "justget", "justget.mjs"),
  ].filter(Boolean);
  for (const c of cands) { if (fs.existsSync(expandPath(c))) return expandPath(c); }
  { // PATH 探测改纯 fs（2026-09-12：execFileSync 探针移除——不阻塞事件循环）
    const dirs = (process.env.PATH || "").split(":").filter(Boolean);
    for (const d of dirs) {
      try { fs.accessSync(path.join(d, "justget"), fs.constants.X_OK); return "justget"; } catch (e) {}
    }
  }
  return null;
}
function runJustget(url, mirrors, outPath, timeoutMs) {
  return new Promise((resolve) => {
    const jg = findJustget();
    if (!jg) return resolve({ ok: false, error: "justget 不可用" });
    const args = [];
    if (!jg.endsWith(".js") && !jg.endsWith(".mjs")) args.push("justget");
    else args.push(jg);
    args.push(url, "-o", outPath, "--timeout", String(timeoutMs || 60000), "--connect-timeout", "10000", "--min-size", "1");
    for (const m of mirrors || []) args.push("-m", m);
    const cmd = jg.endsWith(".js") || jg.endsWith(".mjs") ? process.execPath : jg;
    const cli = jg.endsWith(".js") || jg.endsWith(".mjs") ? args : args.slice(1);
    try {
      const child = execFile(cmd, cli, { timeout: (timeoutMs || 60000) + 15000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(stderr || err.message || "").slice(0, 300) });
        resolve({ ok: true, output: String(stdout || "").slice(0, 500) });
      });
      child.on("error", (e) => resolve({ ok: false, error: String(e && e.message || e) }));
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}
async function fetchFallback(urls, timeoutMs) {
  for (const u of urls) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    try {
      const r = await fetch(u, { signal: ctrl.signal, headers: { "user-agent": "aiti-model-wizard/0.1" }, redirect: "follow" });
      if (r.ok) { clearTimeout(to); return { ok: true, url: u, text: await r.text() }; }
      clearTimeout(to);
    } catch (e) { clearTimeout(to); }
  }
  return { ok: false, error: "全部源下载失败" };
}
async function downloadCatalog(configDir, cfg) {
  const t0 = Date.now();
  const out = path.join(cacheBase(configDir), "catalog", "models.dev.download.json");
  mkdirp(path.dirname(out));
  const urls = [cfg.catalog.primaryUrl, cfg.catalog.mirrorUrl].filter(Boolean);
  let text = null, source = "", usedJustget = false;
  if (cfg.download && cfg.download.justget !== "off") {
    const r = await runJustget(cfg.catalog.primaryUrl, [cfg.catalog.mirrorUrl].filter(Boolean), out, cfg.download.timeoutMs);
    if (r.ok && fs.existsSync(out)) {
      const size = fs.statSync(out).size;
      if (size > 1024) {
        text = fs.readFileSync(out, "utf8");
        source = r.output.includes("mirror") || r.output.includes("镜像") ? "justget" : "justget";
        usedJustget = true;
      }
    }
  }
  if (text == null) {
    const r = await fetchFallback(urls, cfg.download.timeoutMs);
    if (r.ok) { text = r.text; source = r.url.includes("gitee") ? "gitee-mirror" : "models.dev"; }
    else return { ok: false, error: r.error, elapsedMs: Date.now() - t0 };
  }
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, error: "解析失败: " + e.message, elapsedMs: Date.now() - t0 }; }
  data = normalizeModelsDev(data);
  if (!data) return { ok: false, error: "目录格式不对（缺 providers）", elapsedMs: Date.now() - t0 };
  const providers = Object.keys(data.providers || {}).length;
  saveModelsDevCache(configDir, data, { source, bytes: Buffer.byteLength(text), providers });
  try { fs.unlinkSync(out); } catch (e) {}
  return { ok: true, source, bytes: Buffer.byteLength(text), providers, elapsedMs: Date.now() - t0, justget: usedJustget, cacheAgeMs: 0 };
}

// ---------------- models.dev → pi 元数据映射（未知模型反填第三源） ----------------
// 背景：provider 的 /models 列表端点协议本身只有 {id}（OpenAI/Anthropic 皆然），拿不到真实参数；
// 内置目录 models-store.json 收录滞后（stealth 新模型常缺失）。models.dev 目录有完整规格
// （contextWindow/maxTokens/reasoning/input/cost/thinking 等级/interleaved 字段），作为反填兜底源。
/** models.dev 单模型详情 → pi models.json 元数据子集（只含能可靠映射的字段）。
 *  映射：limit.context→contextWindow · limit.output→maxTokens · reasoning→reasoning ·
 *  modalities.input→input（只保留 text/image，video/audio pi 不支持）·
 *  cost.{input,output,cache_read,cache_write}→cost（四字段缺省补 0，pi schema 必填）·
 *  reasoning_options(type=effort).values→thinkingLevelMap（全 level 显式化，不支持的置 null）·
 *  interleaved.field==="reasoning_content"→compat.requiresReasoningContentOnAssistantMessages。 */
/** 模型 id 归一化：小写 + 去掉除字母数字外的所有字符（ZhipuAI/GLM-5.2 → zhipuaiglm52）。 */
function normModelKey(id) { return String(id || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
/** 跨提供商模型元数据互证（models.dev 目录）：同一上游模型常同时上架多个网关
 *  （如 deepseek-ai/DeepSeek-V4-Flash-0731 在 deepinfra/huggingface/togetherai…），
 *  本 provider 的目录条目缺该模型时，借其它网关条目反填。
 *  匹配两级：① 归一化全 id 精确；② 末段（剥组织前缀）归一化相等（ZhipuAI/GLM-5.2 ↔ zai-org/glm-5.2 ↔ glm-5.2）。
 *  字段取共识（多数派，平票取较大数值）；cost 各网关加价不同 → 仅全部命中完全一致才带。
 *  返回 { meta, from } 或 null。 */
function crossProviderModelMeta(mdData, modelId) {
  const key = normModelKey(modelId);
  if (!key || key.length < 3) return null;
  const all = [];
  const provs = (mdData && mdData.providers) || {};
  for (const [pid, pp] of Object.entries(provs)) {
    const ms = pp && pp.models && typeof pp.models === "object" && !Array.isArray(pp.models) ? pp.models : null;
    if (!ms) continue;
    for (const [mid, mm] of Object.entries(ms)) {
      if (!mm || typeof mm !== "object") continue;
      const mapped = mapModelsDevModel(mm);
      if (mapped) all.push({ pid, mid, mapped });
    }
  }
  let valid = all.filter((h) => normModelKey(h.mid) === key);
  if (!valid.length) {
    const rawTail = String(modelId).includes("/") ? String(modelId).split("/").pop() : String(modelId);
    const tail = normModelKey(rawTail);
    if (tail.length < 4) return null; // 防短 id 误伤（如 "gpt" 会撞一片）
    valid = all.filter((h) => normModelKey(String(h.mid).includes("/") ? String(h.mid).split("/").pop() : h.mid) === tail);
  }
  if (!valid.length) return null;
  const pick = (field) => {
    const vals = valid.map((h) => h.mapped[field]).filter((v) => v !== undefined);
    if (!vals.length) return undefined;
    const freq = [];
    for (const v of vals) {
      const k = JSON.stringify(v);
      const e = freq.find((x) => x.k === k);
      if (e) e.n++; else freq.push({ k, v, n: 1 });
    }
    freq.sort((a, b) => b.n - a.n || (typeof a.v === "number" && typeof b.v === "number" ? b.v - a.v : 0));
    return freq[0].v;
  };
  const meta = {};
  for (const f of ["name", "reasoning", "input", "contextWindow", "maxTokens", "thinkingLevelMap", "compat"]) {
    const v = pick(f);
    if (v !== undefined) meta[f] = v;
  }
  const costs = valid.map((h) => h.mapped.cost).filter(Boolean);
  if (costs.length === 1) meta.cost = costs[0];
  else if (costs.length > 1 && costs.every((c) => JSON.stringify(c) === JSON.stringify(costs[0]))) meta.cost = costs[0];
  return { meta: Object.keys(meta).length ? meta : null, from: [...new Set(valid.map((h) => h.pid))].slice(0, 6) };
}
function mapModelsDevModel(m) {
  if (!m || typeof m !== "object") return null;
  const out = {};
  if (typeof m.name === "string" && m.name && m.name !== m.id) out.name = m.name;
  if (typeof m.reasoning === "boolean") out.reasoning = m.reasoning;
  const ctx = m.limit && Number(m.limit.context);
  if (Number.isFinite(ctx) && ctx > 0) out.contextWindow = ctx;
  const maxOut = m.limit && Number(m.limit.output);
  if (Number.isFinite(maxOut) && maxOut > 0) out.maxTokens = maxOut;
  const ins = Array.isArray(m.modalities && m.modalities.input)
    ? m.modalities.input.filter((x) => x === "text" || x === "image")
    : [];
  if (ins.length) out.input = ins;
  if (m.cost && typeof m.cost === "object") {
    out.cost = {
      input: Number(m.cost.input) || 0,
      output: Number(m.cost.output) || 0,
      cacheRead: Number(m.cost.cache_read != null ? m.cost.cache_read : m.cost.cacheRead) || 0,
      cacheWrite: Number(m.cost.cache_write != null ? m.cost.cache_write : m.cost.cacheWrite) || 0,
    };
  }
  const ro = Array.isArray(m.reasoning_options) ? m.reasoning_options.find((o) => o && o.type === "effort") : null;
  if (ro && Array.isArray(ro.values) && ro.values.length) {
    const tlm = {};
    for (const lv of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) tlm[lv] = ro.values.includes(lv) ? lv : null;
    out.thinkingLevelMap = tlm;
  }
  if (m.interleaved && m.interleaved.field === "reasoning_content") {
    out.compat = { requiresReasoningContentOnAssistantMessages: true };
  }
  return Object.keys(out).length ? out : null;
}
/** 在 models.dev 目录里定位某 provider 的原始模型表：先按 slug 精确命中，
 *  再按 baseUrl 归一比对（models.json 里的 provider 名常与目录 slug 不同，如 opencode-go-2）。
 *  mdData 兼容 {providers:{…}} 包裹与裸 provider 映射两种格式。
 *  返回 { ok, slug, models }，models 归一为 [{id, …detail}] 数组（兼容 dict/array 容器）。 */
function findModelsDevProvider(mdData, providerId, baseUrl) {
  const providers = (mdData && (mdData.providers || mdData)) || null;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return { ok: false };
  const normModels = (mm) => Array.isArray(mm)
    ? mm.filter((x) => x && (x.id || x.model)).map((x) => ({ ...(typeof x === "object" ? x : {}), id: x.id || x.model }))
    : mm && typeof mm === "object"
      ? Object.entries(mm).map(([k, v]) => ({ ...(v && typeof v === "object" ? v : {}), id: (v && (v.id || v.model)) || k }))
      : [];
  let hit = providers[providerId];
  let slug = providerId;
  if (!hit && baseUrl) {
    const nb = normalizeBaseUrl(baseUrl);
    if (nb) {
      for (const [s, p] of Object.entries(providers)) {
        if (p && typeof p === "object" && p.api && normalizeBaseUrl(p.api) === nb) { hit = p; slug = s; break; }
      }
    }
  }
  if (!hit || typeof hit !== "object") return { ok: false };
  return { ok: true, slug, models: normModels(hit.models) };
}

// ---------------- 目录新鲜度（TTL 自动刷新 + 强制刷新 + 并发去重） ----------------
let _catalogInflight = null;     // 进行中的下载（并发调用共享同一次；settle 即清，身份守卫防误清新请求）
let _catalogForceAt = 0;         // 上次强制刷新尝试时刻（限频：避免连续保存未知模型时反复打网）
const CATALOG_FORCE_MIN_GAP_MS = 5 * 60 * 1000;
const AUX_FORCE_MIN_AGE_MS = 30 * 60 * 1000; // 兑底目录跟随强刷的最低年龄：<30min 刚下过则不重复拉
/** 确保 models.dev 目录可用且新鲜：无缓存 / 超过 TTL（catalog.ttlHours）/ force=true → 触发下载
 *  （justget 多源竞速：官方 + Gitee 镜像）；并发调用 single-flight 去重。
 *  返回 { ok(是否有可用目录), refreshed(本次是否真的重新下载了), from, ageMs, stale, error? } */
async function ensureCatalog(configDir, cfg, opts = {}) {
  const cur = loadModelsDev(configDir, cfg);
  const needRefresh = !!opts.force || cur.from !== "cache" || cur.stale;
  if (!needRefresh) return { ok: true, refreshed: false, from: cur.from, ageMs: cur.ageMs, stale: false };
  if (!_catalogInflight) {
    const dl = opts._download || downloadCatalog;
    const p = (async () => {
      try {
        return { _r: await dl(configDir, cfg) };
      } finally {
        if (_catalogInflight === p) _catalogInflight = null; // settle 即清；仅清自己（防并发下新请求被误清）
      }
    })();
    _catalogInflight = p;
  }
  const { _r: r } = await _catalogInflight;
  const after = loadModelsDev(configDir, cfg);
  return { ok: !!after.data, refreshed: !!(r && r.ok), from: after.from, ageMs: after.ageMs, stale: after.stale, error: r && r.ok ? undefined : (r && r.error) || "下载失败" };
}

// ---------------- 兜底公共目录：OpenRouter + LiteLLM（反填第④⑤源） ----------------
// 定位：models.dev 查不到的模型（收录滞后/小众厂商）再到这两个公共源碰运气；
// 下载失败静默降级（保存照常，只是少个反填源）；缓存独立 TTL（同 catalog.ttlHours）。
const AUX_CATALOGS = {
  openrouter: { file: "openrouter.json", urlKey: "openRouterUrl", enabledKey: "openRouter" },
  litellm: { file: "litellm.json", urlKey: "liteLlmUrl", enabledKey: "liteLlm" },
};
function auxPaths(configDir, name) {
  const base = path.join(cacheBase(configDir), "catalog");
  return [path.join(base, AUX_CATALOGS[name].file), path.join(base, name + ".meta.json")];
}
function loadAux(configDir, cfg, name) {
  const [dataFile, metaFile] = auxPaths(configDir, name);
  const data = readJSON(dataFile);
  const meta = readJSON(metaFile, {});
  const ttlMs = ((cfg && cfg.catalog && cfg.catalog.ttlHours) || 168) * 3600 * 1000;
  const ageMs = meta && meta.ts ? Date.now() - meta.ts : null;
  return { data, ageMs, stale: !data || ageMs == null || ageMs > ttlMs };
}
async function downloadAux(configDir, cfg, name) {
  const c = (cfg && cfg.catalog) || {};
  const t0 = Date.now();
  try {
    const r = await httpGet(c[AUX_CATALOGS[name].urlKey], { timeoutMs: c.auxTimeoutMs || 30000 });
    if (r.status !== 200 || !r.body) return { ok: false, error: "HTTP " + r.status + (r.error ? " " + r.error : "") };
    const data = name === "openrouter"
      ? (Array.isArray(r.body.data) ? r.body.data : null)
      : (r.body && typeof r.body === "object" && !Array.isArray(r.body) ? r.body : null);
    if (!data) return { ok: false, error: "响应格式不符" };
    const [dataFile, metaFile] = auxPaths(configDir, name);
    writeJSONAtomic(dataFile, data);
    writeJSONAtomic(metaFile, { ts: Date.now(), bytes: Buffer.byteLength(JSON.stringify(data)), source: name });
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 160) }; }
}
const _auxInflight = {}; // name → 进行中的下载 promise（single-flight；settle 即清）
function ensureAux(configDir, cfg, name, opts = {}) {
  const c = (cfg && cfg.catalog) || {};
  if (c[AUX_CATALOGS[name].enabledKey] === false) return Promise.resolve({ ok: false, refreshed: false, skipped: true });
  const cur = loadAux(configDir, cfg, name);
  if (!(opts.force || cur.stale)) return Promise.resolve({ ok: true, refreshed: false, ageMs: cur.ageMs });
  if (!_auxInflight[name]) {
    const dl = opts[name === "openrouter" ? "_dlOpenRouter" : "_dlLiteLlm"] || ((d, cc) => downloadAux(d, cc, name));
    const p = (async () => { try { return { _r: await dl(configDir, cfg) }; } finally { if (_auxInflight[name] === p) _auxInflight[name] = null; } })();
    _auxInflight[name] = p;
  }
  return _auxInflight[name].then(({ _r }) => ({ ok: !!(_r && _r.ok), refreshed: !!(_r && _r.ok), error: _r && _r.error }));
}
function ensureAuxAll(configDir, cfg, opts = {}) {
  return Promise.allSettled([ensureAux(configDir, cfg, "openrouter", opts), ensureAux(configDir, cfg, "litellm", opts)])
    .then(([o, l]) => ({ openrouter: o.status === "fulfilled" ? o.value : { ok: false }, litellm: l.status === "fulfilled" ? l.value : { ok: false } }));
}
/** provider baseUrl 是否 OpenRouter 官方端点（aux openrouter 源 = 该厂商本身，扫描结果可回流缓存） */
function isOpenRouterBase(baseUrl) {
  const host = String(baseUrl || "").replace(/^https?:\/\//i, "").split(/[/:]/)[0].toLowerCase();
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}
/** 厂商 /models 扫描结果回流 aux 缓存（openrouter 官方源 = provider 本身）。
 *  消除「扫描实时拉、反填写旧缓存」的时差：新模型检测发现上架的那一刻，参数反填（第④源）即可命中
 *  （实测：hy4-preview 上架后新模型横幅已提示，参数弹窗却查不到——aux 缓存还是 6h 前的）。
 *  内容全量比对（非仅 id 集）：价格/窗口修正也能回流；无变化不覆写（避免每 30min 扫描白写 1MB）；
 *  原子写（writeJSONAtomic：非原子直写若崩在半途，readJSON 解析失败 → 反填源静默失效一整个 TTL）。 */
function updateAuxFromScan(configDir, cfg, baseUrl, rawList) {
  if (!Array.isArray(rawList) || !rawList.length) return { ok: false };
  if (!isOpenRouterBase(baseUrl)) return { ok: false, skip: true };
  const [dataFile, metaFile] = auxPaths(configDir, "openrouter");
  const cur = readJSON(dataFile);
  // 全量比对（非仅 id 集）且与顺序无关：价格/窗口修正也回流，厂商响应序变化不触发白写
  const sigOf = (arr) => arr.map((m) => JSON.stringify(m)).sort().join("\n");
  if (Array.isArray(cur) && sigOf(cur) === sigOf(rawList)) return { ok: true, unchanged: true };
  writeJSONAtomic(dataFile, rawList);
  writeJSONAtomic(metaFile, { ts: Date.now(), bytes: Buffer.byteLength(JSON.stringify(rawList)), source: "openrouter", via: "scan" });
  return { ok: true, updated: true };
}
let _auxRetryMissAt = 0; // 上次「强刷后仍查不到」时刻：5min 内不重复刷网（查不到的私有模型名别每次点开都打上游）
/** aux 反填 + 兑底重查：openrouter 官方源覆盖该 provider 时若仍有缺字段模型、且缓存超阈值（10min）
 *  → 强刷一次重查。针对非扫描路径进来的新模型（扫描回流已消除主路径时差，这是双保险）。
 *  buildModels(extras) → models[]：由调用方闭包给出（oauth/主分支合成逻辑不同）。 */
async function auxBackfillWithRetry(configDir, cfg, ids, baseUrl, buildModels, opts = {}) {
  let aux = auxBackfillExtras(configDir, cfg, ids);
  let models = buildModels(aux.extras);
  const stillMissing = () => models.some((m) =>
    ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat"].some((f) => m[f] === undefined));
  if (Array.isArray(ids) && ids.length && isOpenRouterBase(baseUrl) && stillMissing()) {
    const cur = loadAux(configDir, cfg, "openrouter");
    const freshMs = 10 * 60 * 1000;
    if ((!cur.data || cur.ageMs == null || cur.ageMs > freshMs) && Date.now() - _auxRetryMissAt > 5 * 60 * 1000) {
      await ensureAux(configDir, cfg, "openrouter", { force: true, ...opts }); // single-flight：并发查询只打一次上游
      aux = auxBackfillExtras(configDir, cfg, ids);
      models = buildModels(aux.extras);
      if (stillMissing()) _auxRetryMissAt = Date.now();
    }
  }
  return { aux, models };
}
/** 在 OpenRouter 目录里找模型：先精确 id（含 vendor/ 前缀），再按「/ 后基本名」后缀匹配
 *  （models.json 存厂商原生 id 如 deepseek-v4-pro，OpenRouter 是 deepseek/deepseek-v4-pro）；多候选取 created 最新。 */
function findOpenRouterModel(orData, modelId) {
  const arr = Array.isArray(orData) ? orData : (orData && orData.data) || [];
  if (!arr.length || !modelId) return null;
  const norm = (s) => String(s || "").toLowerCase();
  const id = norm(modelId);
  const baseOf = (s) => { const n = norm(s); return n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n; };
  let cands = arr.filter((m) => m && norm(m.id) === id);
  if (!cands.length) cands = arr.filter((m) => m && baseOf(m.id) === baseOf(modelId) && baseOf(modelId) !== "");
  if (!cands.length) return null;
  cands.sort((a, b) => (Number(b.created) || 0) - (Number(a.created) || 0));
  return cands[0];
}
/** OpenRouter 模型 → pi 元数据片段。pricing 单位 $/token，pi cost 单位 $/M tokens → ×1e6（保留 4 位小数）。 */
function mapOpenRouterModel(o) {
  if (!o || typeof o !== "object") return null;
  const out = {};
  const ctx = Number(o.context_length);
  if (Number.isFinite(ctx) && ctx > 0) out.contextWindow = ctx;
  const mc = o.top_provider && Number(o.top_provider.max_completion_tokens);
  if (Number.isFinite(mc) && mc > 0) out.maxTokens = mc;
  const ins = Array.isArray(o.architecture && o.architecture.input_modalities)
    ? o.architecture.input_modalities.filter((x) => x === "text" || x === "image") : [];
  if (ins.length) out.input = ins;
  const perM = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e10) / 1e4 : 0; };
  const p = o.pricing || {};
  if (p.prompt != null || p.completion != null) {
    out.cost = { input: perM(p.prompt), output: perM(p.completion), cacheRead: p.input_cache_read != null ? perM(p.input_cache_read) : 0, cacheWrite: p.input_cache_write != null ? perM(p.input_cache_write) : 0 };
  }
  const sp = Array.isArray(o.supported_parameters) ? o.supported_parameters : [];
  if (sp.includes("reasoning") || sp.includes("reasoning_effort")) out.reasoning = true;
  return Object.keys(out).length ? out : null;
}
/** LiteLLM 条目定位：键形如 "deepseek/deepseek-chat" / "azure_ai/FW-DeepSeek-V4-Pro" ——
 *  取键尾段（/ 后）归一（小写去非字母数字）与目标 id 归一比较；多命中取键最短者（更接近原生 id）。 */
function findLiteLlmEntry(liteData, modelId) {
  if (!liteData || typeof liteData !== "object" || Array.isArray(liteData) || !modelId) return null;
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  const target = norm(modelId);
  if (!target) return null;
  let best = null, bestLen = Infinity;
  for (const [k, v] of Object.entries(liteData)) {
    if (!v || typeof v !== "object") continue;
    const tail = k.includes("/") ? k.slice(k.lastIndexOf("/") + 1) : k;
    if (norm(tail) === target && tail.length < bestLen) { best = v; bestLen = tail.length; }
  }
  return best;
}
/** LiteLLM 条目 → pi 元数据片段。保守取值：contextWindow 只信 max_input_tokens、maxTokens 只信
 *  max_output_tokens（max_tokens 语义在各条目不一致，不猜）。价目单位 $/token ×1e6。 */
function mapLiteLlmModel(e) {
  if (!e || typeof e !== "object") return null;
  const out = {};
  const ctx = Number(e.max_input_tokens);
  if (Number.isFinite(ctx) && ctx > 0) out.contextWindow = ctx;
  const mo = Number(e.max_output_tokens);
  if (Number.isFinite(mo) && mo > 0) out.maxTokens = mo;
  const perM = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e10) / 1e4 : 0; };
  if (e.input_cost_per_token != null || e.output_cost_per_token != null) {
    out.cost = { input: perM(e.input_cost_per_token), output: perM(e.output_cost_per_token), cacheRead: perM(e.cache_read_input_token_cost), cacheWrite: perM(e.cache_creation_input_token_cost) };
  }
  if (e.supports_reasoning === true) out.reasoning = true;
  return Object.keys(out).length ? out : null;
}
/** 测试钩子：重置强刷限频（_catalogForceAt），让下一次未知模型保存可重新触发 force。 */
function resetCatalogForceGap() { _catalogForceAt = 0; }
/** 本地兜底查询（只读缓存，不打网）：ids 里每个模型先 OpenRouter 后 LiteLLM 找参数片段。
 *  返回 { extras:[{id, meta, source}], auxUsed:{openrouter,litellm} }。 */
function auxBackfillExtras(configDir, cfg, ids) {
  const extras = [];
  const auxUsed = { openrouter: false, litellm: false };
  const c = (cfg && cfg.catalog) || {};
  if (c.openRouter === false && c.liteLlm === false) return { extras, auxUsed };
  const orData = c.openRouter !== false ? loadAux(configDir, cfg, "openrouter").data : null;
  const llData = c.liteLlm !== false ? loadAux(configDir, cfg, "litellm").data : null;
  for (const id of Array.isArray(ids) ? ids : []) {
    const o = orData && findOpenRouterModel(orData, id);
    const om = o && mapOpenRouterModel(o);
    if (om) { extras.push({ id, meta: om, source: "openrouter" }); auxUsed.openrouter = true; continue; }
    const le = llData && findLiteLlmEntry(llData, id);
    const lm = le && mapLiteLlmModel(le);
    if (lm) { extras.push({ id, meta: lm, source: "litellm" }); auxUsed.litellm = true; }
  }
  return { extras, auxUsed };
}

// ---------------- 国内 AI 目录（内嵌） ----------------
let _cnCatalogCache = null;
function loadChinaCatalog() {
  if (_cnCatalogCache) return _cnCatalogCache;
  const file = path.join(__dirname, "china-catalog.json");
  const d = readJSON(file);
  _cnCatalogCache = (d && d.providers) ? d.providers : {};
  return _cnCatalogCache;
}
// china-catalog 内嵌参数（provider.modelMeta[id]）：stealth 模型（models.dev 未收录、厂商 /models 只回 id）
// 在本目录内嵌完整参数供反填。按 model id 跨 provider 查找（id 全局唯一足够）。
let _cnMetaIndex = null;
function cnModelMetaFor(modelId) {
  if (_cnMetaIndex == null) {
    _cnMetaIndex = {};
    try {
      const cn = loadChinaCatalog();
      for (const slug of Object.keys(cn)) {
        const mm = cn[slug] && cn[slug].modelMeta;
        if (mm && typeof mm === "object") for (const id of Object.keys(mm)) _cnMetaIndex[id] = mm[id];
      }
    } catch { _cnMetaIndex = {}; }
  }
  return _cnMetaIndex[modelId] || null;
}

// ---------------- 合并目录索引 ----------------
function buildIndex(configDir, cfg) {
  const md = loadModelsDev(configDir, cfg);
  const mdData = md.data && md.data.providers ? md.data.providers : {};
  const cn = loadChinaCatalog();
  const index = [];
  const byKey = new Map();
  for (const [slug, p] of Object.entries(mdData)) {
    const cnInfo = cn[slug] || {};
    const ms = Array.isArray(p.models) ? p.models : Object.values(p.models || {});
    const models = ms.map((m) => ({ id: m && m.id, name: m && (m.name || m.id) }));
    const item = {
      id: slug,
      name: cnInfo.name || p.name || slug,
      cnName: cnInfo.cnName || "",
      aliases: cnInfo.aliases || [],
      baseUrl: cnInfo.baseUrl || p.api || "",
      apiType: cnInfo.apiType || guessApiType(slug, cnInfo.baseUrl || p.api || ""),
      doc: cnInfo.doc || p.doc || "",
      signupUrl: cnInfo.signupUrl || "",
      tokenUrl: cnInfo.tokenUrl || "",
      register: cnInfo.register || "",
      env: cnInfo.env || (Array.isArray(p.env) ? p.env[0] : "") || "",
      authType: cnInfo.authType || "",
      oauthProviderId: cnInfo.oauthProviderId || "",
      models: (cnInfo.models || []).map((id) => ({ id, name: id })),
      source: "models.dev",
      hasCn: !!cnInfo.cnName,
    };
    // excludeModels：快照里已下线/不可推理的模型（上游 models.dev 更新滞后）→ 合并时剔除
    const excluded = new Set(cnInfo.excludeModels || []);
    if (cnInfo.models && cnInfo.models.length) {
      const known = new Set(cnInfo.models);
      for (const m of models) if (!known.has(m.id) && !excluded.has(m.id)) item.models.push(m);
    } else item.models = models.filter((m) => !excluded.has(m.id));
    byKey.set(slug, item);
    index.push(item);
  }
  for (const [slug, c] of Object.entries(cn)) {
    if (byKey.has(slug)) continue;
    const item = {
      id: slug,
      name: c.name || slug,
      cnName: c.cnName || "",
      aliases: c.aliases || [],
      baseUrl: c.baseUrl || "",
      apiType: c.apiType || "openai-completions",
      doc: c.doc || "",
      signupUrl: c.signupUrl || "",
      tokenUrl: c.tokenUrl || "",
      register: c.register || "",
      env: c.env || "",
      authType: c.authType || "",
      oauthProviderId: c.oauthProviderId || "",
      models: (c.models || []).map((id) => ({ id, name: id })),
      source: "china-catalog",
      hasCn: !!c.cnName,
    };
    index.push(item);
    byKey.set(slug, item);
  }
  return { index, byKey, cache: { from: md.from, meta: md.meta, ageMs: cacheAgeMs(configDir), stale: !!md.stale } };
}
function guessApiType(slug, apiUrl) {
  if (/anthropic/i.test(apiUrl)) return "anthropic-messages";
  if (/generativelanguage|googleapis/.test(apiUrl || "")) return "google-generative-ai";
  return "openai-completions";
}

// ---------------- 搜索（中/英/别名/模型 id） ----------------
function tokenize(s) {
  return String(s || "").toLowerCase().replace(/[\s\-_.\/]+/g, "").trim();
}
function searchProviders(index, query) {
  const q = String(query || "").trim();
  if (!q) return index.slice(0, 30);
  const tq = tokenize(q);
  const scored = [];
  for (const p of index) {
    const name = String(p.name || "").toLowerCase();
    const cnName = String(p.cnName || "").toLowerCase();
    const slug = p.id.toLowerCase();
    let score = 0;
    if (slug === tq || tokenize(p.name) === tq || tokenize(p.cnName) === tq) score = 100;
    else if (slug.includes(tq) || name.includes(tq.toLowerCase()) || cnName.includes(tq.toLowerCase())) score = 60;
    else if (tokenize(p.name).includes(tq) || tokenize(p.cnName).includes(tq)) score = 55;
    else {
      for (const a of p.aliases || []) {
        const ta = tokenize(a);
        if (ta === tq) { score = 80; break; }
        if (ta.includes(tq)) { score = 40; break; }
        if (tokenize(a).includes(tq)) { score = 35; break; }
      }
    }
    if (score === 0) {
      for (const m of p.models || []) {
        if (tokenize(m.id).includes(tq) || tokenize(m.name).includes(tq)) { score = 30; break; }
      }
    }
    if (score > 0) scored.push({ ...p, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  return scored.slice(0, 40);
}

// ---------------- 地址规范化（漏 /v1 /v2 /v1beta 也能匹配） ----------------
function normalizeBaseUrl(u) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  try {
    const url = new URL(s);
    let pathname = url.pathname.replace(/\/+$/, "");
    // 循环剥尾巴：端点路径（/chat/completions 等）与版本段交替出现也能剥净，如 /v1/chat/completions → /v1
    for (;;) {
      const next = pathname.replace(/\/(?:chat\/completions|completions|responses|messages|embeddings|models|openai|anthropic|v\d+|v\d+beta|v\d+alpha)$/i, "");
      if (next === pathname) break;
      pathname = next;
    }
    return url.origin + pathname.replace(/\/+$/, "").toLowerCase();
  } catch (e) {
    return tokenize(s);
  }
}
function reverseMatch(index, inputUrl, configuredBaseUrls) {
  const ni = normalizeBaseUrl(inputUrl);
  if (!ni) return [];
  const inputDomain = extractDomain(inputUrl);
  const out = [];
  for (const p of index) {
    if (!p.baseUrl) continue;
    const np = normalizeBaseUrl(p.baseUrl);
    if (!np) continue;
    let score = 0;
    if (np === ni) score = 100;
    else {
      const h1 = hostOf(np), h2 = hostOf(ni);
      if (h1 && h1 === h2) score = 30;
      else if (h1 && h2 && (h1.includes(h2) || h2.includes(h1))) score = 20;
      // 域名匹配（eTLD+1 相同）
      if (inputDomain && extractDomain(p.baseUrl) === inputDomain) score = Math.max(score, 85);
    }
    if (score > 0) out.push({ ...p, score, matchedBaseUrl: p.baseUrl });
  }
  out.sort((a, b) => b.score - a.score || Number(b.hasCn) - Number(a.hasCn));
  const seen = new Set();
  const dedup = [];
  for (const p of out) {
    const key = normalizeBaseUrl(p.baseUrl) || p.id;
    if (seen.has(key)) continue;
    const group = out.filter((q) => (normalizeBaseUrl(q.baseUrl) || q.id) === key);
    const best = group.find((q) => q.hasCn) || group[0];
    seen.add(key);
    dedup.push({ ...best, dupes: group.filter((q) => q.id !== best.id).map((q) => q.id) });
  }
  return dedup.slice(0, 8);
}
async function reverseDetect(index, inputUrl, apiKey, opts = {}) {
  const [candidates, detect] = await Promise.all([
    Promise.resolve().then(() => reverseMatch(index, inputUrl, opts.configuredBaseUrls)),
    detectApi(inputUrl, apiKey || "", { timeoutMs: opts.timeoutMs || 10000, probeModel: opts.probeModel, preferBase: opts.preferBase, extraHeaders: opts.extraHeaders }).catch(() => ({ ok: false, hint: "探测失败" })),
  ]);
  return { candidates, detect };
}
function hostOf(u) { try { return new URL(u).hostname; } catch (e) { return ""; } }
function pathOf(u) { try { return new URL(u).pathname.replace(/\/+$/, ""); } catch (e) { return ""; } }

// ---------------- 域名提取（eTLD+1） ----------------
/** 从 URL 提取可注册域名（eTLD+1）：
 *  - https://maas-api.cn-huabei-1.xf-yun.com/v2 → xf-yun.com
 *  - https://api.deepseek.com/v1 → deepseek.com
 *  - https://ark.cn-beijing.volces.com/api/v3 → volces.com
 *  - https://dashscope.aliyuncs.com/compatible-mode/v1 → aliyuncs.com
 *  已知多段 ccTLD 处理：com.cn / co.uk / org.cn / net.cn / ac.cn / gov.cn / com.hk / com.tw */
const MULTI_PART_TLDS = new Set(["com.cn", "co.uk", "org.cn", "net.cn", "ac.cn", "gov.cn", "com.hk", "com.tw"]);
function extractDomain(u) {
  try {
    const hostname = new URL(u).hostname;
    const parts = hostname.split(".");
    if (parts.length < 2) return hostname;
    const lastThree = parts.slice(-3).join(".");
    if (MULTI_PART_TLDS.has(lastThree)) return lastThree;
    return parts.slice(-2).join(".");
  } catch (e) {
    return "";
  }
}

// ---------------- 域名索引（domain → provider 映射） ----------------
/** 从目录索引 + 已配置 providers 构建域名→provider 映射（惰性缓存）。 */
let _domainIndex = null;
function buildDomainIndex(index, configuredBaseUrls) {
  if (_domainIndex) return _domainIndex;
  const map = new Map(); // domain -> [{id, name, cnName, source}]
  // 从目录索引
  for (const p of index) {
    if (!p.baseUrl) continue;
    const d = extractDomain(p.baseUrl);
    if (!d) continue;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push({ id: p.id, name: p.name, cnName: p.cnName || "", source: "catalog" });
  }
  // 从已配置 providers
  for (const [pid, baseUrl] of Object.entries(configuredBaseUrls || {})) {
    if (!baseUrl) continue;
    const d = extractDomain(baseUrl);
    if (!d) continue;
    if (!map.has(d)) map.set(d, []);
    const existing = map.get(d).find((x) => x.id === pid);
    if (!existing) {
      map.get(d).push({ id: pid, name: pid, cnName: "", source: "configured" });
    }
  }
  _domainIndex = map;
  return map;
}
function resetDomainIndex() { _domainIndex = null; }

// ---------------- 域名推理：URL → provider guess ----------------
/** 仅用域名推断 provider（不依赖路径匹配）。
 *  返回 [{id, name, cnName, score, via}] 或 null。 */
function domainProviderGuess(inputUrl, domainIndex) {
  const d = extractDomain(inputUrl);
  if (!d || !domainIndex) return null;
  const hits = domainIndex.get(d);
  if (!hits || !hits.length) return null;
  // configured providers 优先（用户已配置=真实在用），catalog 次之
  const configured = hits.filter((h) => h.source === "configured");
  const catalog = hits.filter((h) => h.source === "catalog");
  const best = configured.length ? configured[0] : catalog[0];
  if (!best) return null;
  return {
    id: best.id,
    name: best.name,
    cnName: best.cnName,
    score: configured.length ? 75 : 60, // configured 比 catalog 更可信
    via: "domain",
    domain: d,
    candidates: hits.slice(0, 5).map((h) => ({ id: h.id, name: h.name, cnName: h.cnName, source: h.source })),
  };
}

// ---------------- URL 提取 ----------------
function extractUrls(text) {
  const s = String(text || "");
  const re = /https?:\/\/[^\s"'<>()\[\]{}`（）：；，。、！？「」『』【】]+/gi;
  const out = new Set();
  let m;
  while ((m = re.exec(s))) {
    let u = m[0];
    u = u.replace(/[.,;:!?，。；：、）】」』〉》》"'`]+$/g, "");
    u = u.replace(/[)\]}]$/g, "");
    u = u.replace(/\/(?=[?]*$)/g, "").replace(/\/+$/, "");
    if (/^https?:\/\/[^\s]{5,}$/.test(u) && u.length > 12) out.add(u);
  }
  return [...out];
}

// ---------------- 密钥解析（apiKey 三形态） ----------------
/** 把用户输入的 apiKey 解析成可用于探测的真实密钥（与 pi 运行时同语义）:
 *  - "!cmd"     → 执行 shell 命令取 stdout（如 !opencode auth list、!echo $MY_KEY）
 *  - "ENV_NAME" → 全大写环境变量名 → 读 process.env（与 pi 的 env var 形态一致；真实 key 几乎不可能长成纯大写_形式）
 *  - 其它       → 字面量原样
 *  失败返回 ""（探测时按无 key 走）。models.json 里存的是原始输入（pi 运行时自行解析）。 */
async function resolveSecretValue(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.startsWith("!")) {
    const cmd = v.slice(1);
    try {
      const { exec } = require("child_process");
      return await new Promise((resolve) => {
        exec(cmd, { timeout: 10000, windowsHide: true, shell: process.platform === "win32" ? undefined : "/bin/bash" }, (err, stdout) => {
          resolve(err ? "" : String(stdout || "").trim());
        });
      });
    } catch { return ""; }
  }
  if (/^[A-Z_][A-Z0-9_]*$/.test(v)) return String(process.env[v] || "").trim();
  return v;
}

// ---------------- x-opencode-session 自学习（Console Go 等要求该头做 prompt cache 路由） ----------------
// 上游 host 命中（opencode.ai / *.opencode.ai，或曾报 MissingSessionID 被学习）→ 请求自动注入该头。
// 学习标记为模块级全局：进程内后续探测/发现/测试直接带头，不再依赖错误触发（与 pi-models-combo 代理同语义）。
const ocSessionLearnedHosts = new Set();
function wantsOcSession(urlStr) {
  try {
    const h = new URL(urlStr).hostname;
    return h === "opencode.ai" || h.endsWith(".opencode.ai") || ocSessionLearnedHosts.has(h);
  } catch (e) { return false; }
}
function isMissingSessionErr(text) {
  const s = String(text || "");
  return s.indexOf("MissingSessionID") >= 0 || s.indexOf("x-opencode-session") >= 0;
}
function ocSessionId() {
  try { return require("node:crypto").randomUUID(); } catch (e) { return "wiz-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
}

// ---------------- HTTP 小工具 ----------------
async function httpGet(url, opts = {}) {
  const { apiType = "openai-completions", timeoutMs = 12000, extraHeaders = {}, method = "GET", body } = opts;
  const apiKey = await resolveSecretValue(opts.apiKey); // 支持 "!cmd" / 环境变量名字面量
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { ...extraHeaders };
  // 请求头合并（2026-09-17 审核修正）：大小写不敏感；内置头仅在用户未显式提供同名头时写入（用户值优先）
  const hasHdr = (n) => Object.keys(headers).some((k) => k.toLowerCase() === n);
  const setIfAbsent = (n, v) => { if (!hasHdr(n)) headers[n] = v; };
  if (apiType === "anthropic-messages") {
    setIfAbsent("x-api-key", apiKey || "");
    setIfAbsent("anthropic-version", "2023-06-01");
  } else if (apiType === "google-generative-ai") {
    if (apiKey) setIfAbsent("x-goog-api-key", apiKey);
  } else if (apiKey) {
    setIfAbsent("authorization", "Bearer " + apiKey);
  }
  if (body) setIfAbsent("content-type", "application/json");
  if (wantsOcSession(url)) setIfAbsent("x-opencode-session", ocSessionId());
  return fetch(url, { signal: ctrl.signal, headers, method, body, redirect: "follow" })
    .then(async (r) => {
      const text = await r.text().catch(() => "");
      let body_ = null; try { body_ = JSON.parse(text); } catch (e) {}
      return { status: r.status, statusText: r.statusText, ok: r.ok, body: body_, text: text.slice(0, 800), headers: r.headers };
    })
    .catch((e) => ({ status: 0, error: String((e && e.message) || e).slice(0, 200), statusText: "net" }))
    .finally(() => clearTimeout(to));
}
async function httpPostJson(url, bodyObj, opts = {}) {
  const preHeader = wantsOcSession(url);
  let r = await httpPostRaw(url, bodyObj, opts);
  // MissingSessionID 自学习：本次没带头 + 400 且错误体点名缺头 → 学习 host（全局标记）并带头重发一次
  if (r.status === 400 && !preHeader && isMissingSessionErr(r.text)) {
    try { ocSessionLearnedHosts.add(new URL(url).hostname); } catch (e) {}
    r = await httpPostRaw(url, bodyObj, opts); // 第二次：wantsOcSession 命中 → 自动带头
  }
  return r;
}
async function httpPostRaw(url, bodyObj, opts = {}) {
  const { apiType = "openai-completions", timeoutMs = 12000, extraHeaders = {} } = opts;
  const apiKey = await resolveSecretValue(opts.apiKey); // 支持 "!cmd" / 环境变量名字面量
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { ...extraHeaders };
  // 请求头合并（2026-09-17 审核修正）：大小写不敏感；内置头仅在用户未显式提供同名头时写入（用户值优先）
  const hasHdr = (n) => Object.keys(headers).some((k) => k.toLowerCase() === n);
  const setIfAbsent = (n, v) => { if (!hasHdr(n)) headers[n] = v; };
  setIfAbsent("content-type", "application/json");
  if (apiType === "anthropic-messages") {
    setIfAbsent("x-api-key", apiKey || "");
    setIfAbsent("anthropic-version", "2023-06-01");
  } else if (apiType === "google-generative-ai") {
    if (apiKey) setIfAbsent("x-goog-api-key", apiKey);
  } else if (apiKey) {
    setIfAbsent("authorization", "Bearer " + apiKey);
  }
  if (wantsOcSession(url)) setIfAbsent("x-opencode-session", ocSessionId());
  return fetch(url, { method: "POST", signal: ctrl.signal, headers, body: JSON.stringify(bodyObj), redirect: "follow" })
    .then(async (r) => {
      const text = await r.text().catch(() => "");
      let body_ = null; try { body_ = JSON.parse(text); } catch (e) {}
      return { status: r.status, statusText: r.statusText, ok: r.ok, body: body_, text: text.slice(0, 800), headers: r.headers };
    })
    .catch((e) => ({ status: 0, error: String((e && e.message) || e).slice(0, 200), statusText: "net" }))
    .finally(() => clearTimeout(to));
}
function recognizAble(st) { return st === 200 || st === 401 || st === 403 || st === 429; }
function statusHint(st) {
  if (st === 200) return "端点存在";
  if (st === 401 || st === 403) return "端点存在（需认证）";
  if (st === 429) return "端点存在（限流）";
  if (st === 404 || st === 405) return "路径不存在";
  if (st === 0) return "网络不可达";
  return "HTTP " + st;
}

// ---------------- 自动探测（api 类型 + 真实地址） ----------------
/** 剥掉用户多贴的端点尾巴（如 …/v1/chat/completions → …/v1）：用户常直接复制完整请求 URL，
 *  不剥则探测会打出 …/chat/completions/chat/completions 这类 404。循环剥（兼容 /models/embeddings 等叠尾）。 */
function stripEndpointPath(b) {
  let s = b;
  for (;;) {
    const next = s.replace(/\/(?:chat\/completions|completions|responses|messages|embeddings|models)$/i, "");
    if (next === s) break;
    s = next;
  }
  return s;
}
function baseVariants(base) {
  const b = stripEndpointPath(String(base || "").trim().replace(/\/+$/, ""));
  if (!b) return [];
  const out = [b];
  if (!/(\/v\d+|\/v\d+beta|\/api\/paas\/v\d+|\/compatible-mode|\/anthropic)$/i.test(b)) {
    out.push(b + "/v1"); out.push(b + "/v2"); out.push(b + "/v3"); out.push(b + "/v1beta");
  }
  return [...new Set(out)];
}
/** 从用户输入 URL 提取「端点尾巴」暗示的协议（2026-09-17 拍板：探测选择时优先于固定 rank，但只在探针也命中时生效）。
 *  /messages → anthropic；/chat/completions → openai-completions；/responses → openai-responses；
 *  /v1beta/models 或 googleapis/generativelanguage 域名 → google-generative-ai；其余（含裸 /models）→ null。 */
function endpointApiHint(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return null;
  let path = s;
  try { path = new URL(s).pathname; } catch (e) { path = s.split(/[?#]/)[0]; }
  path = path.replace(/\/+$/, "").toLowerCase();
  if (/\/messages$/.test(path)) return "anthropic-messages";
  if (/\/chat\/completions$/.test(path)) return "openai-completions";
  if (/\/responses$/.test(path)) return "openai-responses";
  if (/\/v\d+(?:beta|alpha)\/models$/.test(path) || /generativelanguage/.test(s.toLowerCase())) return "google-generative-ai";
  return null;
}
/** baseUrl 按协议归一（2026-09-17）：pi 的 anthropic-messages 运行时语义是 baseURL + "/v1/messages"
 *  （Anthropic SDK 实测 base 带 /v1 → 请求 /v1/v1/messages；pi-ai 内置 anthropic 系 baseUrl 一律不带 /v1）。
 *  故 anthropic 探测建议统一去掉尾部 /v1；其余协议原样。 */
function normalizeBaseForApi(base, api) {
  const b = String(base || "").replace(/\/+$/, "");
  return api === "anthropic-messages" ? b.replace(/\/v1$/i, "") : b;
}
async function detectApi(baseUrl, apiKey, opts = {}) {
  const variants = baseVariants(baseUrl);
  // 端点尾巴提示（决策：hint > preferBase(协议维度) > 固定 rank）；opts.apiHint 显式传入时覆盖（null = 关闭）
  const apiHint = opts.apiHint !== undefined ? opts.apiHint : endpointApiHint(baseUrl);
  const probes = [];
  const found = [];
  const seen = new Set();
  const run = async (base, api) => {
    const key = base + "|" + api;
    if (seen.has(key)) return; seen.add(key);
    const jobs = [];
    if (api === "openai-completions") {
      jobs.push({ url: base + "/chat/completions", method: "POST", via: "chat" });
      jobs.push({ url: base + "/models", method: "GET", via: "models" });
    } else if (api === "openai-responses") {
      jobs.push({ url: base + "/responses", method: "GET", via: "responses" });
    } else if (api === "anthropic-messages") {
      jobs.push({ url: (base.endsWith("/v1") ? base : base + "/v1") + "/messages", method: "POST", via: "messages" });
      jobs.push({ url: base.endsWith("/v1") ? base + "/models" : base + "/v1/models", method: "GET", via: "models" });
    } else if (api === "google-generative-ai") {
      jobs.push({ url: base + "/v1beta/models", method: "GET", via: "models" });
    }
    for (const j of jobs) {
      const probeModel = opts.probeModel || "probe";
      const body = j.method === "POST"
        ? (api === "anthropic-messages"
          ? JSON.stringify({ model: probeModel, max_tokens: 4, messages: [{ role: "user", content: "ping" }] })
          : JSON.stringify({ model: probeModel, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }))
        : undefined;
      const r = await httpGet(j.url, { apiKey, apiType: api, method: j.method, body, timeoutMs: opts.timeoutMs || 10000, extraHeaders: opts.extraHeaders });
      probes.push({ base, api, url: j.url, status: r.status, hint: r.status ? statusHint(r.status) : String(r.error || "net").slice(0, 80) });
      const pathOk = recognizAble(r.status) || (r.status === 404 && (r.text || "").trim().length > 0);
      if (pathOk) found.push({ api, base, status: r.status, via: j.via });
    }
  };
  const tasks = [];
  for (const b of variants) {
    tasks.push(run(b, "openai-completions"));
    tasks.push(run(b, "openai-responses"));
    tasks.push(run(b, "anthropic-messages"));
    tasks.push(run(b, "google-generative-ai"));
  }
  const totalMs = (opts.timeoutMs || 10000) + 500;
  const settled = await Promise.race([
    Promise.all(tasks),
    new Promise((res) => setTimeout(() => res("__timeout"), totalMs)),
  ]);
  if (settled === "__timeout") {
    return { ok: false, api: null, baseUrl: baseVariants(baseUrl)[0], verified: false, confidence: 0, probes, hint: "探测超时（网络不可达或地址不对）" };
  }
  if (found.length === 0) {
    return { ok: false, api: null, baseUrl: baseVariants(baseUrl)[0], verified: false, confidence: 0, probes, hint: "未探测到可辨识端点（可能地址不对或网络不通）：" + probes.map((p) => p.base + " " + p.hint).slice(0, 6).join("；") };
  }
  const rank = { "openai-completions": 0, "anthropic-messages": 1, "openai-responses": 2, "google-generative-ai": 3 };
  const stRank = (s) => (s === 200 ? 0 : s === 429 ? 1 : s === 401 ? 2 : s === 403 ? 3 : 4);
  const byRank = (a, b) => (rank[a.api] ?? 9) - (rank[b.api] ?? 9) || ((a.via === "chat" ? 0 : 1) - (b.via === "chat" ? 0 : 1)) || stRank(a.status) - stRank(b.status) || a.base.length - b.base.length;
  found.sort(byRank);
  // 选择顺序（2026-09-17 拍板）：preferBase 命中的 base 变体集合内 [hint api > rank] → hint 命中项 → rank[0]
  const hinted = apiHint ? found.find((x) => x.api === apiHint) : null;
  const preferred = opts.preferBase ? found.filter((x) => x.base === opts.preferBase) : [];
  const prefBest = preferred.length
    ? ((apiHint && preferred.find((x) => x.api === apiHint)) || preferred.slice().sort(byRank)[0])
    : null;
  const best = prefBest || hinted || found[0];
  const confidence = best.status === 200 ? 0.95 : 0.85;
  const bestBase = normalizeBaseForApi(best.base, best.api);
  return {
    ok: true, api: best.api, baseUrl: bestBase, rawBaseUrl: best.base, verified: true, confidence, probes,
    hint: "探测到 " + apiName(best.api) + " · " + bestBase + "（" + statusHint(best.status) + "）" + (apiHint && best.api === apiHint ? " · 按输入端点尾巴判定" : ""),
  };
}
function apiName(api) {
  return api === "anthropic-messages" ? "Anthropic 风格" : api === "openai-responses" ? "OpenAI Responses" : api === "google-generative-ai" ? "Google Gemini" : "OpenAI 兼容";
}

// ---------------- 服务端响应头品牌识别（HTTP HEAD） ----------------
/** 探测 API 根路径的响应头（Server / x-powered-by 等）用于品牌识别。
 *  返回 { server, xPoweredBy, status } 或 null（网络不通/超时）。 */
async function probeServerHeaders(base, api, apiKey, timeoutMs = 5000, extraHeaders) {
  const b = String(base || "").replace(/\/+$/, "");
  if (!b) return null;
  try {
    const r = await httpGet(b, { apiKey, apiType: api, method: "HEAD", timeoutMs, extraHeaders });
    if (r.status === 0) return null;
    const h = r.headers || {};
    const server = h.get ? h.get("server") : (h["server"] || "");
    const xpb = h.get ? h.get("x-powered-by") : (h["x-powered-by"] || "");
    return { server: String(server || "").trim(), xPoweredBy: String(xpb || "").trim(), status: r.status };
  } catch {
    return null;
  }
}

// ---------------- 品牌探测（OpenAPI / 模型前缀） ----------------
async function probeOpenApi(base, api, apiKey, timeoutMs = 5000, extraHeaders) {
  const b = String(base || "").replace(/\/+$/, "");
  const candidates = [b + "/openapi.json", b + "/openapi", b + "/api-docs"];
  const tasks = candidates.map(async (u) => {
    try {
      const r = await httpGet(u, { apiKey, apiType: api, timeoutMs: Math.min(timeoutMs, 5000), extraHeaders });
      if (r.status !== 200) return null;
      const info = r.body && (r.body.info || (r.body.openapi && r.body.info));
      if (!info || !info.title) return null;
      return { ok: true, url: u, title: String(info.title).slice(0, 80), description: String(info.description || "").slice(0, 120) };
    } catch (e) { return null; }
  });
  const race = await Promise.race([Promise.all(tasks), new Promise((res) => setTimeout(() => res(null), timeoutMs + 1000))]);
  const hits = (Array.isArray(race) ? race : []).filter(Boolean);
  return hits[0] || { ok: false };
}
function brandNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim(); }
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordHit(name, token) {
  const nn = brandNorm(name).replace(/\s+/g, " ");
  const t = brandNorm(token);
  if (!t) return false;
  if (nn === t || nn.startsWith(t + " ") || nn.endsWith(" " + t) || nn.includes(" " + t + " ")) return true;
  return false;
}
const BRAND_STOPWORDS = new Set(["api","openai","compatible","completion","completions","chat","server","platform","official","http","https","model","models","llm","cloud","console","service","open","key","keys","v1","v2","v3","v4","the","and","for","of","ai","app","docs","doc","endpoint","interface"]);
function brandFromText(text, index) {
  const t = brandNorm(text);
  if (t.length < 2) return null;
  const tokens = t.split(" ").filter((w) => w.length >= 3 && !BRAND_STOPWORDS.has(w));
  for (const p of index) {
    const names = [p.name, p.cnName, ...(p.aliases || [])].filter(Boolean);
    for (const n of names) {
      const nt = brandNorm(n);
      if (nt.length < 2) continue;
      if (t.includes(nt)) return { id: p.id, name: p.name, cnName: p.cnName || "", via: "text" };
      if (tokens.some((tok) => wordHit(n, tok))) return { id: p.id, name: p.name, cnName: p.cnName || "", via: "token" };
    }
  }
  return null;
}
function brandFromModels(models, index) {
  const ids = (models || []).map((m) => String((m && m.id) || "")).filter(Boolean);
  if (ids.length < 1) return null;
  const prefixes = [...new Set(ids.map((id) => id.split(/[-_\/.]/)[0].toLowerCase()))].filter((p) => p.length >= 2);
  const hits = [];
  for (const pre of prefixes) {
    for (const p of index) {
      const names = [p.name, p.cnName, ...(p.aliases || [])].filter(Boolean);
      const nameHit = names.some((n) => wordHit(n, pre));
      const modelHit = (p.models || []).some((m) => String((m && m.id) || "").toLowerCase().split(/[-_\/.]/)[0] === pre);
      if (nameHit || modelHit) hits.push({ id: p.id, name: p.name, cnName: p.cnName || "", nameHit, modelHit, pre });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (b.nameHit ? 1 : 0) - (a.nameHit ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  const best = hits[0];
  return {
    id: best.id, name: best.name, cnName: best.cnName || "", via: best.nameHit ? "name" : "models",
    candidates: hits.slice(0, 3).map((h) => ({ id: h.id, name: h.name, cnName: h.cnName || "", via: h.nameHit ? "name" : "models" })),
  };
}
async function detectBrands(base, models, index, { api, apiKey, timeoutMs = 5000 } = {}) {
  const signals = [];
  const openApi = await probeOpenApi(base, api, apiKey, timeoutMs);
  if (openApi.ok) {
    signals.push({ source: "openapi", title: openApi.title, provider: brandFromText(openApi.title, index) });
  }
  if (Array.isArray(models) && models.length) {
    const mp = brandFromModels(models, index);
    if (mp) signals.push({ source: "models", provider: mp });
  }
  return { signals, openApi };
}

// ---------------- 测试连接（2xx / 429 都算通过） ----------------
async function testConnection({ baseUrl, api = "openai-completions", apiKey, model }, opts = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs || 12000;
  const xh = opts.extraHeaders || {}; // provider 自定义请求头（2026-09-17）：测试/发现/探测链路与运行时同源
  let r;
  if (model) {
    if (api === "anthropic-messages") {
      const b = /\/v1$/.test(base) ? base : base + "/v1";
      r = await httpPostJson(b + "/messages", { model, max_tokens: Math.max(4, (opts.maxTokens || 8)), messages: [{ role: "user", content: PROBE_USER + " " + PROBE_SYSTEM }] }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
    } else if (api === "openai-responses") {
      r = await httpPostJson(base + "/responses", { model, max_output_tokens: Math.max(4, (opts.maxTokens || 8)), input: PROBE_USER + " " + PROBE_SYSTEM }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
    } else if (api === "google-generative-ai") {
      r = await httpPostJson(base + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent", { contents: [{ role: "user", parts: [{ text: PROBE_USER + " " + PROBE_SYSTEM }] }], generationConfig: { maxOutputTokens: Math.max(4, (opts.maxTokens || 8)) } }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
    } else {
      r = await httpPostJson(base + "/chat/completions", { model, messages: [{ role: "system", content: PROBE_SYSTEM }, { role: "user", content: PROBE_USER }], max_tokens: Math.max(4, (opts.maxTokens || 8)), temperature: 0 }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
    }
  } else {
    const listUrl = api === "anthropic-messages" ? (base.endsWith("/v1") ? base + "/models" : base + "/v1/models") : api === "google-generative-ai" ? base + "/v1beta/models" : base + "/models";
    r = await httpGet(listUrl, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
  }
  const latencyMs = Date.now() - t0;
  let pass = r.status >= 200 && r.status < 300 || r.status === 429;
  let detail;
  if (r.status === 429) detail = extractRateLimitText(r);
  else if (r.status >= 200 && r.status < 300) detail = model ? "探针返回正常" : "端点可访问，key 有效";
  else if (r.status === 401) detail = "API Key 无效或无权限（401）";
  else if (r.status === 403) {
    const modelBlocked = isModelLevelBlocked(r);
    if (model && modelBlocked) {
      const listUrl = api === "anthropic-messages" ? (base.endsWith("/v1") ? base + "/models" : base + "/v1/models") : api === "google-generative-ai" ? base + "/v1beta/models" : base + "/models";
      const r2 = await httpGet(listUrl, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
      if (r2.status >= 200 && r2.status < 300) {
        pass = true;
        detail = "key 有效 ✓ 但模型 " + model + " 在服务商受限（403：" + (extractErrorText(r).slice(0, 80) || "模型不可用/地区限制/免费档") + "），请换一个模型或用 /models 列表选可用模型";
      } else if (r2.status === 401 || r2.status === 403) {
        detail = "API Key 无效或无权限（403，/models 验证同样失败）";
      } else {
        detail = "模型不可用（403 · " + (extractErrorText(r).slice(0, 80) || "未知原因") + "），列表验证异常 HTTP " + r2.status;
      }
    } else {
      detail = modelBlocked ? "模型不可用/地区受限（403 · " + (extractErrorText(r).slice(0, 80) || "") + "）" : "API Key 无效或无权限（403）";
    }
  }
  else if (r.status === 404 || r.status === 405) {
    const hasBody = (r.text || "").trim().length > 0;
    if (model && hasBody) {
      const listUrl = api === "anthropic-messages" ? (base.endsWith("/v1") ? base + "/models" : base + "/v1/models") : api === "google-generative-ai" ? base + "/v1beta/models" : base + "/models";
      const r2 = await httpGet(listUrl, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
      if (r2.status >= 200 && r2.status < 300) {
        pass = true;
        detail = "key/端点有效 ✓ 但模型 " + model + " 不可用（404：" + (extractErrorText(r).slice(0, 80) || "模型不存在/不支持该套餐") + "），请换一个模型或用 /models 列表选可用模型";
      } else if (r2.status === 401 || r2.status === 403) {
        detail = "API Key 无效或无权限（404，/models 验证同样失败）";
      } else {
        detail = "模型不可用（404 · " + (extractErrorText(r).slice(0, 80) || "未知原因") + "），列表验证异常 HTTP " + r2.status;
      }
    } else {
      detail = "地址/路径不对（404），可能漏了 /v1 或 /v2";
    }
  }
  else if (r.status === 0) detail = "网络不可达：" + (r.error || "");
  else {
    const raw = extractErrorText(r);
    // 上游「模型在列表但推理后端不受理」类错误（如 ModelScope 的 has no provider supported）→
    // 给明确结论而非裸透传：列表有≠可推理，换模型或刷新实时列表
    const low = raw.toLowerCase();
    if (model && (/no provider supported|provider.*not support/.test(low)
      || /not exist|does not exist|unsupported model|invalid model|模型不存在/.test(low))) {
      detail = "模型 " + model + " 该服务商当前不受理（上游：" + raw.slice(0, 80) + "）—— /models 列表有≠可推理，请换一个模型或点「刷新模型」拉最新列表";
    } else detail = raw;
  }
  return { ok: pass, pass, status: r.status, detail, latencyMs, rateLimited: r.status === 429, model: model || null };
}
function isModelLevelBlocked(r) {
  const err = (r && r.body && r.body.error) || {};
  const m = String(err.message || err.code || err.type || (r && r.text) || "");
  return /region|not available|not permitted|permission|unsupported|not supported|restricted|in your area|geo[- ]?block|免费|受限|不可用|does not exist|no endpoints|requires you to|free/i.test(m);
}
function extractRateLimitText(r) {
  const h = r.headers || {};
  const retry = (h.get && h.get("retry-after")) || "";
  if (retry) return "限流（429）· Retry-After: " + retry + "s";
  const msg = r.body && r.body.error && (r.body.error.message || r.body.error.type || "");
  return "限流（429）" + (msg ? "· " + String(msg).slice(0, 120) : "");
}
function extractErrorText(r) {
  let m = "";
  if (r.body && r.body.error) m = r.body.error.message || r.body.error.type || r.body.error.code || "";
  return String(m || r.text || "HTTP " + r.status).slice(0, 160);
}

// ---------------- maxTokens 实测校正（probe-cap） ----------------
/** 已知厂商 /models 元数据虚报输出上限的修正表（请求时校验会拒）：
 *  Ark coding 端点报告 glm-5-2-260617 的 max_output_token_length=131072，
 *  实测 max_tokens>128000 直接 HTTP 400。 */
const MODEL_MAX_OUTPUT_TOKEN_CORRECTIONS = {
  "ark-coding": { "glm-5-2-260617": 128000 },
};
function knownMaxTokensCap(provider, modelId) {
  const t = MODEL_MAX_OUTPUT_TOKEN_CORRECTIONS[provider];
  return t ? t[modelId] : undefined;
}
/** 从报错文本里解析真实的输出上限：取所有整数候选中 < requested 且 ≥1000 的最大值。
 *  兼容中英文报错（max_tokens/maximum/limit/greater than/上界/不能超过…）。 */
function parseMaxTokensFromError(text, requested) {
  const nums = String(text || "").match(/\d{3,}/g) || [];
  let best = null;
  for (const n of nums) {
    const v = Number(n);
    if (Number.isFinite(v) && v >= 1000 && v < requested && (best === null || v > best)) best = v;
  }
  return best;
}
/** 对单模型发一条最小探针请求验证 maxTokens 上限是否真被接受；被拒则从 API 报错解析真实上限。
 *  返回 { ok, skipped?, confirmedMaxTokens?, corrected, status?, detail? }。不写文件——由调用方决定是否回写。 */
async function probeModelCap({ provider, baseUrl, api = "openai-completions", apiKey, model, maxTokens }, opts = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const cap = Number(maxTokens);
  if (!base || !model || !Number.isFinite(cap) || cap <= 0) return { ok: false, skipped: true, corrected: false, detail: "缺少 baseUrl/model/maxTokens" };
  // ≤ pi 默认输出预算的模型不值得一发探针（内置同阈值语义）
  if (cap <= 16384) return { ok: true, skipped: true, corrected: false, detail: "maxTokens ≤ 16k，无需实测" };
  const timeoutMs = opts.timeoutMs || 20000;
  const xh = opts.extraHeaders || {}; // 自定义请求头透传（2026-09-17）
  let r;
  if (api === "anthropic-messages") {
    const b = /\/v1$/.test(base) ? base : base + "/v1";
    r = await httpPostJson(b + "/messages", { model, max_tokens: cap, messages: [{ role: "user", content: PROBE_USER }] }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
  } else if (api === "openai-responses") {
    r = await httpPostJson(base + "/responses", { model, max_output_tokens: cap, input: PROBE_USER }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
  } else if (api === "google-generative-ai") {
    r = await httpPostJson(base + "/v1beta/models/" + encodeURIComponent(model) + ":generateContent", { contents: [{ role: "user", parts: [{ text: PROBE_USER }] }], generationConfig: { maxOutputTokens: cap } }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
  } else {
    r = await httpPostJson(base + "/chat/completions", { model, messages: [{ role: "user", content: PROBE_USER }], max_tokens: cap, temperature: 0 }, { apiKey, apiType: api, timeoutMs, extraHeaders: xh });
  }
  if (r.status >= 200 && r.status < 300) return { ok: true, corrected: false, confirmedMaxTokens: cap, status: r.status, detail: "实测接受 maxTokens=" + cap };
  if (r.status === 429) return { ok: true, skipped: true, corrected: false, status: 429, detail: "限流（429），暂无法验证上限" };
  if (r.status === 401 || r.status === 403) return { ok: false, skipped: true, corrected: false, status: r.status, detail: "key 无效（" + r.status + "），无法验证上限" };
  if (r.status === 400 || r.status === 413) {
    const err = extractErrorText(r) + " " + (r.text || "");
    const bound = parseMaxTokensFromError(err, cap);
    if (bound) return { ok: true, corrected: true, confirmedMaxTokens: bound, status: r.status, detail: "元数据虚报：API 实际拒绝 " + cap + "，报错给出上限 " + bound };
    return { ok: false, corrected: false, status: r.status, detail: "被拒但未能解析出真实上限：" + err.slice(0, 120) };
  }
  return { ok: false, corrected: false, status: r.status, detail: "HTTP " + r.status + " " + extractErrorText(r).slice(0, 100) };
}

// ---------------- 模型发现（/models 列表 ∪ 目录已知模型） ----------------
/** 厂商 /models 列表富字段提取（各家兼容网关实际返回的参数，标准 OpenAI 协议只有 {id}）：
 *  Groq context_window · Mistral max_context_length · Together/Fireworks context_length ·
 *  Gemini inputTokenLimit/outputTokenLimit · vLLM max_model_len。
 *  只取无歧义键（不猜 max_tokens——有的厂商指输出上限有的指总上下文）。返回 pi 风格 meta 片段或 null。 */
function modelListExtra(m) {
  if (!m || typeof m !== "object") return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const out = {};
  const ctx = num(m.context_window) || num(m.context_length) || num(m.max_context_length) || num(m.inputTokenLimit) || num(m.max_model_len);
  if (ctx) out.contextWindow = ctx;
  const maxOut = num(m.max_output_tokens) || num(m.outputTokenLimit);
  if (maxOut) out.maxTokens = maxOut;
  return Object.keys(out).length ? out : null;
}
async function discoverModels({ baseUrl, api = "openai-completions", apiKey }, opts = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  let listUrl, parser, rawList = null; // rawList：原始模型数组（OpenRouter 等官方源可回流 aux 缓存供参数反填）
  if (api === "anthropic-messages") {
    listUrl = (base.endsWith("/v1") ? base : base + "/v1") + "/models" + (opts.limit ? "?limit=" + opts.limit : "");
    parser = (b) => { rawList = (b && b.data) || null; return (rawList || []).map((m) => ({ id: m && (m.id || m.model), name: m && (m.display_name || m.name), _raw: m })); };
  } else if (api === "google-generative-ai") {
    listUrl = base + "/v1beta/models" + (opts.limit ? "?pageSize=" + opts.limit : "");
    parser = (b) => { rawList = (b && b.models) || null; return (rawList || []).map((m) => ({ id: m && m.name, name: m && m.displayName, _raw: m })); };
  } else {
    listUrl = base + "/models";
    parser = (b) => {
      const arr = Array.isArray(b) ? b : b && (b.data || b.models || b.list);
      rawList = arr || null;
      return (arr || []).map((m) => ({ id: m && (m.id || m.model), name: m && (m.display_name || m.name), _raw: m }));
    };
  }
  const r = await httpGet(listUrl, { apiKey, apiType: api, timeoutMs: opts.timeoutMs || 12000, extraHeaders: opts.extraHeaders });
  if (r.status >= 200 && r.status < 300) {
    let models = parser(r.body) || [];
    models = models.filter((m) => m && m.id).map((m) => {
      let id = m.id;
      if (api === "google-generative-ai") id = String(id).replace(/^models\//, "");
      const out = { id, name: m.name && m.name !== id ? m.name : id };
      const extra = modelListExtra(m._raw); // 富字段（Groq/Mistral/Together/Gemini…）→ 反填第③源
      if (extra) Object.assign(out, extra);
      return out;
    });
    const seen = new Set(); models = models.filter((m) => !seen.has(m.id) && seen.add(m.id));
    return { ok: true, from: "endpoint", models, count: models.length, listUrl, raw: rawList };
  }
  if (r.status === 401 || r.status === 403) return { ok: false, error: "API Key 无效或无权限（" + r.status + "）", listUrl };
  if (r.status === 404 || r.status === 405) return { ok: false, error: "列表端点 404（可能漏了 /v1 /v2）：" + listUrl, listUrl };
  return { ok: false, error: "拉取模型列表失败：HTTP " + r.status + " " + String(r.error || "").slice(0, 100), listUrl };
}

// ---------------- models.json 读写（合并 + 原子写 + 打码 + 多 keys） ----------------
function modelsJsonPath(configDir, cfg) { return expandPath((cfg && cfg.modelsPath) || DEFAULT_CONFIG.modelsPath); }
function loadModelsJson(configDir, cfg) {
  const file = modelsJsonPath(configDir, cfg);
  const d = readJSON(file, null);
  return { file, data: d && d.providers ? d : { providers: {} } };
}
function modelsStorePath(configDir, cfg) { return expandPath((cfg && cfg.modelsStorePath) || DEFAULT_CONFIG.modelsStorePath); }
function loadModelsStore(configDir, cfg) {
  const file = modelsStorePath(configDir, cfg);
  const d = readJSON(file, null);
  return { file, data: d && typeof d === "object" && !Array.isArray(d) ? d : {} };
}
function saveModelsJson(configDir, cfg, data) {
  return writeJSONAtomic(modelsJsonPath(configDir, cfg), data);
}
function maskKey(key) {
  if (!key) return "";
  const s = String(key);
  if (s.length <= 8) return "***";
  return s.slice(0, 3) + "***" + s.slice(-4);
}
/** provider 请求头敏感名清单（2026-09-17 决策 2B）：值打码回显，非敏感头（User-Agent 等）明文。 */
const SENSITIVE_HEADER_RE = /auth|api[-_]?key|token|secret|cookie|session|credential/i;
function maskHeaderValue(value) { return maskKey(value); }
function providersStatus(configDir, cfg) {
  const { file, data } = loadModelsJson(configDir, cfg);
  // 内置模型目录（models-store.json）：models.json 缺 baseUrl/models 时补全——pi 运行时用它合并，向导应一致。
  // 解析逻辑走工作区共享实现 resolveProviderModels（与聚合成员池/引擎槽位单一同源）。
  const { data: store } = loadModelsStore(configDir, cfg);
  const resolved = resolveProviderModels({ providers: data.providers || {}, store: store || null });
  // overrides-only 条目（仅 modelOverrides 一键——原生 isOverridesOnly 同判定）：managed provider 的
  // 上下文覆盖载体，不是独立 provider——树上不展示（否则 G2 覆盖编辑会产生幽灵空行）
  const isOverridesOnly = (p) => p && typeof p === "object"
    && Object.keys(p).length === 1
    && p.modelOverrides && typeof p.modelOverrides === "object" && Object.keys(p.modelOverrides).length > 0;
  const providers = Object.entries(data.providers || {}).filter(([name, p]) => !isOverridesOnly(p)).map(([name, p]) => {
    const entry = resolved.get(name);
    const baseUrl = (entry && entry.baseUrl) || p.baseUrl || "";
    const models = entry ? entry.models.map((m) => ({ id: m.id, enabled: m.enabled !== false })) : [];
    const keys = Array.isArray(p.apiKeys) ? dedupKeyNames(p.apiKeys.map(normalizeKeyEntry).filter(Boolean)) : [];
    // provider 级请求头（2026-09-17 决策 2B：打码回显）——敏感名值掩码 + maskedHeaders 名单；
    // 非敏感头明文；保存时未动行由 upsertProviderData(maskedHeaders) 用已存原值回填
    const rawHeaders = (p.headers && typeof p.headers === "object") ? p.headers : {};
    const headers = {};
    const maskedHeaders = [];
    for (const [hn, hv] of Object.entries(rawHeaders)) {
      const name = String(hn || "").trim();
      const value = String(hv ?? "");
      if (!name || !value) continue;
      if (SENSITIVE_HEADER_RE.test(name)) { headers[name] = maskHeaderValue(value); maskedHeaders.push(name); }
      else headers[name] = value;
    }
    return {
      provider: name,
      combo: p.combo === true,
      enabled: p.enabled !== false, // provider 级临时禁用（enabled:false）
      api: p.api || "openai-completions",
      baseUrl: baseUrl,
      apiKeyMasked: maskKey(p.apiKey || ""),
      hasKey: !!(p.apiKey || "") || p.combo === true, // 聚合组自身无 key（key 在成员侧），不显示「无 key」警告
      modelCount: models.length,
      models: models.filter((m) => m.id), // [{id, enabled}]——模型级禁用标记
      keys: keys.map(maskKeyEntry),
      keyCount: keys.length,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(maskedHeaders.length ? { maskedHeaders } : {}),
    };
  });
  // OAuth 订阅登录型（auth.json）：扩展 provider（如 qoder/qoder-cn/kimi-coding）不写
  // models.json、凭据在 ~/.pi/agent/auth.json，这里合并展示（不回传凭据内容）
  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (fs.existsSync(authPath)) {
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) || {};
      const known = new Set(providers.map((p) => p.provider));
      let cnCatalog = null;
      for (const [id, v] of Object.entries(auth)) {
        if (known.has(id)) continue;
        if (!v || !(v.type === "oauth" || v.access || v.key)) continue;
        if (!cnCatalog) cnCatalog = loadChinaCatalog();
        const cn = cnCatalog[id] || {};
        providers.push({
          provider: id,
          api: v.type === "oauth" || v.access ? "oauth" : "api_key",
          baseUrl: "",
          authType: v.type === "oauth" || v.access ? "oauth" : "api_key",
          apiKeyMasked: v.type === "oauth" || v.access ? "(订阅登录凭据，自动刷新)" : maskKey(v.key || ""),
          hasKey: true,
          modelCount: (cn.models || []).length,
          models: (cn.models || []).map((id) => ({ id, name: id })),
          keys: [],
          keyCount: 0,
        });
      }
    }
  } catch {}
  return { file, providers, configured: providers.length > 0 };
}
/** 查看某 provider 已配置模型的完整参数（只读，models.json + store + models.dev 合并）。
 *  返回每个模型的 id/name/reasoning/input/contextWindow/maxTokens/cost/compat/thinkingLevelMap/samplingParams。
 *  opts.forceRefresh=true 且有模型在任何源都查不到参数时，强制刷新一次 models.dev 目录再查。
 *  返回附带 modelsDev: { used, slug, refreshed? } 说明第三源使用情况。 */
async function modelParams(configDir, cfg, provider, opts = {}) {
  const { data } = loadModelsJson(configDir, cfg);
  const p = data.providers && data.providers[provider];
  const { data: store } = loadModelsStore(configDir, cfg);
  const storeModels0 = store && store[provider] && Array.isArray(store[provider].models) ? store[provider].models : [];
  // 不在 models.json（OAuth 订阅登录型 / 纯目录型，如 qoder）：合成只读参数视图——
  // 同样吃五源（内置目录 → 国内目录清单 → models.dev → OpenRouter/LiteLLM），
  // 不能因为「不在 models.json」就直接报错：卡片明明列着模型、点 👁 却空白
  if (!p) {
    let cn = {};
    try { cn = loadChinaCatalog()[provider] || {}; } catch {}
    const src = storeModels0.length
      ? storeModels0
      : (Array.isArray(cn.models) ? cn.models : []).map((id) => ({ id }));
    if (!src.length) {
      // 未配置且目录未收录（如「添加」流的自定义端点/套餐卡）：按模型 id 跨网关互证合成只读视图，
      // 让添加流在保存前也能 👁 看参数（窗口/能力/价格来自 models.dev 同 id 条目共识）
      const modelId = String(opts.id || "");
      if (!modelId) return { ok: false, error: "provider 不存在: " + provider };
      const cross0 = crossProviderModelMeta(loadModelsDev(configDir, cfg).data, modelId);
      if (!cross0 || !cross0.meta) return { ok: false, error: "目录未收录该模型参数：" + modelId + "（可先拉取 /models 或手动补元数据）" };
      return {
        ok: true, provider,
        baseUrl: "", api: "",
        models: [{ id: modelId, ...cross0.meta }],
        modelCount: 1,
        readOnly: true, source: "catalog",
        modelsDev: { used: true, slug: "" },
        auxUsed: [],
        crossFilled: { [modelId]: cross0.from.join(",") },
      };
    }
    const found = findModelsDevProvider(loadModelsDev(configDir, cfg).data, provider, cn.baseUrl || "");
    const mdModels = found.ok ? found.models : [];
    const { aux, models } = await auxBackfillWithRetry(configDir, cfg, src.map((m) => m.id || m.model).filter((id) => !mdModels.some((x) => String(x.id || x.model) === id)), cn.baseUrl || "",
      (ex) => src.map((m) => backfillModelMeta(typeof m === "string" ? { id: m } : { id: m.id || m.model || m.name, ...m }, null, storeModels0, mdModels, ex)).filter((m) => m.id));
    const first = typeof src[0] === "object" ? src[0] : null;
    return {
      ok: true, provider,
      baseUrl: String((first && first.baseUrl) || cn.baseUrl || ""),
      api: (first && first.api) || cn.apiType || "",
      models, modelCount: models.length,
      readOnly: true, source: storeModels0.length ? "store" : "catalog", // 客户端据此隐藏编辑入口（凭据/配置不由 models.json 管理）
      modelsDev: { used: mdModels.length > 0, slug: found.ok ? found.slug : "" },
      auxUsed: aux.auxUsed,
      crossFilled: (() => {
        const cf = {};
        const mdData = loadModelsDev(configDir, cfg).data; // 只读一次
        for (const m of models) {
          if (!["name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat", "thinkingLevelMap"].some((f) => m[f] === undefined)) continue;
          const cross = crossProviderModelMeta(mdData, m.id);
          if (cross && cross.meta) {
            let filledAny = false;
            for (const [k, v] of Object.entries(cross.meta)) if (m[k] === undefined) { m[k] = v; filledAny = true; }
            if (filledAny) cf[m.id] = cross.from.join(",");
          }
        }
        return cf;
      })(),
    };
  }
  const storeModels = storeModels0;
  // 纯 key 条目（如 zai-coding-cn：models.json 无 models 字段）→ 与 providersStatus 同规则，
  // 用内置目录补全模型清单，否则参数弹窗误报「清单为空」（实际卡片明明列着模型）
  const src = Array.isArray(p.models) && p.models.length ? p.models : storeModels;
  // baseUrl 同样从目录首条模型回退（展示用）
  let provBaseUrl = String(p.baseUrl || "");
  if (!provBaseUrl && storeModels.length) {
    const first = typeof storeModels[0] === "object" ? storeModels[0] : null;
    if (first && first.baseUrl) provBaseUrl = String(first.baseUrl).replace(/\/+$/, "");
  }
  const hasMeta = (o) => o && typeof o === "object" && MODEL_META_FIELDS.some((f) => o[f] !== undefined);
  const needMd = src.some((m) => !hasMeta(typeof m === "string" ? { id: m } : m));
  let mdInfo = { used: false, slug: "", refreshed: false };
  let mdModels = [];
  if (needMd) {
    let found = findModelsDevProvider(loadModelsDev(configDir, cfg).data, provider, p.baseUrl);
    if (!found.ok && opts.forceRefresh && !(cfg && cfg.catalog && cfg.catalog.autoRefresh === false)) {
      _catalogForceAt = Date.now();
      const [, aux] = await Promise.all([
        ensureCatalog(configDir, cfg, { force: true }),
        ensureAuxAll(configDir, cfg), // 兜底目录也顺带按 TTL 刷新
      ]);
      mdInfo.refreshed = true;
      found = findModelsDevProvider(loadModelsDev(configDir, cfg).data, provider, p.baseUrl);
      void aux;
    }
    if (found.ok) { mdModels = found.models; mdInfo.used = true; mdInfo.slug = found.slug; }
  }
  // OpenRouter/LiteLLM 兜底（本地缓存查询）：只查「缺任一字段」的模型（字段级补全——只含 ctx 的半裸条目也查，
  // 不再因有任意一个字段就整条跳过；本地缓存查找零成本，backfill 只填缺失项不污染已有值）
  const coveredByMd = new Set(mdModels.map((x) => String(x.id || x.model)));
  const lacksAnyMeta = (m) => ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat"].some((f) => m[f] === undefined);
  const bareIds = src
    .filter((m) => lacksAnyMeta(typeof m === "string" ? { id: m } : m))
    .map((m) => (typeof m === "string" ? m : (m.id || m.model || m.name)))
    .filter((id) => id && !coveredByMd.has(id));
  // opts.id：指定单模型查参数（客户端 👁 传参）。不在已配置清单时也合成条目走五源反填——
  // 「刷新可选模型」列表里的未配置模型、刚被移除的模型也能看目录反填参数而非空白
  const wantId = String(opts.id || "").trim();
  if (wantId && !src.some((m) => (typeof m === "string" ? m : (m.id || m.model || m.name)) === wantId)) {
    bareIds.push(wantId);
    if (!mdModels.length) {
      // src 全有 meta 时 needMd=false 会跳过 models.dev 查找——指定 id 缺失时补一次（不强制刷网）
      const found = findModelsDevProvider(loadModelsDev(configDir, cfg).data, provider, p.baseUrl);
      if (found.ok) { mdModels = found.models; mdInfo.used = true; mdInfo.slug = found.slug; }
    }
  }
  const { aux, models } = await auxBackfillWithRetry(configDir, cfg, bareIds, provBaseUrl, (ex) =>
    src.map((m) => {
      const base = typeof m === "string" ? { id: m } : { id: m.id || m.model || m.name, ...m };
      return backfillModelMeta(base, null, storeModels, mdModels, ex);
    }).filter((m) => m.id)
  );
  if (wantId && !models.some((m) => m.id === wantId)) {
    models.unshift(backfillModelMeta({ id: wantId }, null, storeModels, mdModels, aux.extras));
  }
  // 跨提供商同 id 互证：字段级补全——只要缺任一字段就查同 id 条目，只填缺失项（标注跨源）
  // 目录数据只读一次（~2MB JSON），循环内复用——逐模型重读是纯浪费
  const mdCacheData = loadModelsDev(configDir, cfg).data;
  const crossFilled = {};
  for (const m of models) {
    if (!["name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "compat", "thinkingLevelMap"].some((f) => m[f] === undefined)) continue;
    const cross = crossProviderModelMeta(mdCacheData, m.id);
    if (cross && cross.meta) {
      let filledAny = false;
      for (const [k, v] of Object.entries(cross.meta)) if (m[k] === undefined) { m[k] = v; filledAny = true; }
      if (filledAny) crossFilled[m.id] = cross.from.join(",");
    }
  }
  return { ok: true, provider, baseUrl: provBaseUrl || "", api: p.api || "openai-completions", models, modelCount: models.length, modelsDev: mdInfo, auxUsed: aux.auxUsed, crossFilled };
}

/**
 * 新模型检测扫描参数：每个已配置 provider 的 { name, baseUrl, apiKey, api }。
 * 与 providersStatus 同源——合并 models-store 补全 baseUrl（如 zai-coding-cn 只存 key、地址在 store）；
 * 但额外带原始 apiKey（供拉 /models 用），并按 apiKeyEnv 从环境变量取 key（如 ark-coding 用 ARK_API_KEY）。
 * 缺 key 或缺 baseUrl 的 provider 也返回（hasKey/hasBase 标记），由调用方决定是否跳过。
 */
function providerScanParams(configDir, cfg) {
  const { data } = loadModelsJson(configDir, cfg);
  const { data: store } = loadModelsStore(configDir, cfg);
  const out = [];
  for (const [name, p] of Object.entries((data && data.providers) || {})) {
    if (!p || typeof p !== "object") continue;
    let baseUrl = String(p.baseUrl || "").replace(/\/+$/, "");
    const sp = store && store[name];
    if (!baseUrl && sp && typeof sp === "object") {
      const sm = Array.isArray(sp.models) ? sp.models : [];
      if (sm.length) {
        const first = typeof sm[0] === "object" ? sm[0] : null;
        baseUrl = (first && first.baseUrl || "").replace(/\/+$/, "");
      }
    }
    const apiKey = String(p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] : "") || "").trim();
    const headers = (p.headers && typeof p.headers === "object") ? p.headers : undefined; // 自定义头透传（扫描/发现链路，审核修正）
    out.push({ name, api: p.api || "openai-completions", baseUrl, apiKey, headers, hasKey: !!apiKey, hasBase: !!baseUrl });
  }
  return out;
}

// 模型元数据字段：写 models.json 时全量保留（避免剥掉 contextWindow/maxTokens/compat/cost/input/thinkingLevelMap）
const MODEL_META_FIELDS = ["api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "samplingParams", "compat", "headers", "inputLimits"];
/** 取某 provider 在内置模型目录（models-store.json）里的模型数组 */
function storeModelsFor(store, provider) {
  const p = store && store[provider];
  return p && Array.isArray(p.models) ? p.models : [];
}
/** 反填模型缺失元数据。优先级（first-wins，只填缺失项，链上前面的源赢了后面的不再覆写）：
 *  incoming → models.json 已有条目 → 内置目录（models-store）→ china-catalog 内嵌参数（stealth 模型）
 *  → 厂商 /models 富字段（listExtras，最权威的在线数据但可能受网关配额限制，故不越过用户显式值）
 *  → models.dev → OpenRouter/LiteLLM（extras）。
 *  解决 wizard 只传 {id,name,reasoning} 时把 contextWindow/maxTokens/compat 剥掉的 BUG，
 *  让 DeepSeek 等已知模型写回时自动带上 1M 上下文/正确 compat，避免“过早压缩”；
 *  未知模型（如 ox-alpha-free）也不再落裸 {id}（pi 会落到 128k/16k 硬默认）。
 *  opts.report 传入对象时，逐字段记录首个命中源（#3 来源标注）：
 *  existing→已配置 / store→内置目录 / china-catalog→国内目录 / listExtras→厂商models /
 *  md→models.dev / extras→openrouter|litellm。 */
function backfillModelMeta(model, existing, storeModels, mdModels, extras, listExtras, report) {
  const out = { ...model };
  const sources = [existing ? [existing, "已配置"] : null,
    ...(Array.isArray(storeModels) ? storeModels.map((s) => [s, "内置目录"]) : [])].filter(Boolean);
  for (const [src, label] of sources) {
    if ((src.id || src.model) !== out.id) continue;
    if (out.name === undefined && src.name !== undefined) { out.name = src.name; if (report) report.name = label; }
    for (const f of MODEL_META_FIELDS) {
      if (out[f] === undefined && src[f] !== undefined) { out[f] = src[f]; if (report) report[f] = label; }
    }
  }
  // china-catalog 内嵌参数（provider.modelMeta[id]）：stealth 模型在扩展自维护目录内嵌权威参数——
  // 所处链位在厂商 /models 与 models.dev 之前，命中即赢（此二者对 stealth 模型常缺/只回 id）
  const cnm = cnModelMetaFor(out.id);
  if (cnm) {
    if (out.name === undefined && cnm.name !== undefined) { out.name = cnm.name; if (report) report.name = "china-catalog"; }
    for (const f of MODEL_META_FIELDS) {
      if (out[f] === undefined && cnm[f] !== undefined) { out[f] = cnm[f]; if (report) report[f] = "china-catalog"; }
    }
  }
  // 厂商 /models 富字段（discoverModels 提取的 contextWindow/maxTokens）
  if (Array.isArray(listExtras) && listExtras.length) {
    const le = listExtras.find((x) => x && (x.id || x.model) === out.id);
    if (le) {
      for (const f of MODEL_META_FIELDS) {
        if (out[f] === undefined && le[f] !== undefined) { out[f] = le[f]; if (report) report[f] = "厂商/models"; }
      }
      if (out.name === undefined && le.name !== undefined) { out.name = le.name; if (report) report.name = "厂商/models"; }
    }
  }
  if (Array.isArray(mdModels) && mdModels.length) {
    const md = mdModels.find((s) => s && (s.id || s.model) === out.id);
    const mapped = md && mapModelsDevModel(md);
    if (mapped) {
      if (out.name === undefined && mapped.name !== undefined) { out.name = mapped.name; if (report) report.name = "models.dev"; }
      for (const f of MODEL_META_FIELDS) {
        if (out[f] === undefined && mapped[f] !== undefined) { out[f] = mapped[f]; if (report) report[f] = "models.dev"; }
      }
    }
  }
  // 第⑤源：OpenRouter/LiteLLM 本地缓存兜底（extras：[{id, meta, source}]，auxBackfillExtras 产出）——
  // 链上最后一源，只填前面各源都没提供的字段（models.dev 未收录的小众模型从这里补 ctx/cost）；
  // catalog.openRouter/liteLlm 关闭或下载失败时 extras 为空数组，此处自然跳过
  if (Array.isArray(extras) && extras.length) {
    const ex = extras.find((x) => x && x.id === out.id && x.meta);
    if (ex) {
      if (out.name === undefined && ex.meta.name !== undefined) { out.name = ex.meta.name; if (report) report.name = ex.source; }
      for (const f of MODEL_META_FIELDS) {
        if (out[f] === undefined && ex.meta[f] !== undefined) { out[f] = ex.meta[f]; if (report) report[f] = ex.source; }
      }
    }
  }
  // GLM 推理模型强制回传 reasoning_content：智谱 thinking+tool_calls 必须回传 reasoning_content，
  // 否则上游 400001（"If thinking mode and tool_calls, reasoning_content must be passed back"）。
  // pi store/上游 compat 常缺此标志（只有 DeepSeek 被 pi-ai 自动检测），这里对 GLM 系统一合并补上。
  if (out.reasoning === true && /^glm[-/\d.]/i.test(String(out.id || ""))) {
    out.compat = { ...(out.compat || {}), requiresReasoningContentOnAssistantMessages: true };
    if (report) report.requiresReasoningContentOnAssistantMessages = "glm-passback";
  }
  return out;
}

/** 为 upsert 准备反填源：定位该 provider 在 models.dev 目录里的模型表；
 *  若存在「existing+store 都查不到元数据、且当前目录也查不到」的未知模型 → 强制刷新一次目录再查
 *  （限频 CATALOG_FORCE_MIN_GAP_MS，并发 single-flight；cfg.catalog.autoRefresh===false 可关），
 *  同时确保 OpenRouter/LiteLLM 兜底目录新鲜（各自 TTL/开关独立，失败静默）。
 *  返回 { mdModels(原始模型数组，可空), refreshed, slug,
 *          extras([{id, meta, source}] OpenRouter/LiteLLM 兜底命中，已映射为 pi 风格),
 *          auxUsed({openrouter, litellm}) }；opts._download/_dlOpenRouter/_dlLiteLlm 可注入下载器（测试用）。 */
async function resolveMdForUpsert(configDir, cfg, { provider, baseUrl, models, existingModels, store, _download, _dlOpenRouter, _dlLiteLlm }) {
  const incoming = normModelIds(models);
  if (!incoming.length) return { mdModels: [], refreshed: false, slug: "", extras: [], auxUsed: { openrouter: false, litellm: false } };
  const hasMeta = (o) => o && typeof o === "object" && MODEL_META_FIELDS.some((f) => o[f] !== undefined);
  const known = new Set();
  for (const m of [...(Array.isArray(existingModels) ? existingModels : []), ...storeModelsFor(store, provider)]) {
    if (hasMeta(m)) known.add(String(m.id || m.model));
  }
  let missing = incoming.filter((id) => !known.has(id));
  const noResult = { mdModels: [], refreshed: false, slug: "", extras: [], auxUsed: { openrouter: false, litellm: false } };
  if (!missing.length) return noResult;
  let found = findModelsDevProvider(loadModelsDev(configDir, cfg).data, provider, baseUrl);
  let lookup = found.ok ? found.models : [];
  missing = missing.filter((id) => !lookup.some((x) => (x.id || x.model) === id));
  let refreshed = false;
  if (missing.length && !(cfg && cfg.catalog && cfg.catalog.autoRefresh === false)) {
    const force = Date.now() - _catalogForceAt > CATALOG_FORCE_MIN_GAP_MS;
    _catalogForceAt = Date.now(); // 无论是否真发请求都记账，连续保存只打一次网
    // 兑底目录跟随 md 强刷，但 <30min 刚下过则降级为按 TTL（避免每次未知模型保存都拉 ~2MB）
    const auxRecentlyFetched = (name) => { const a = loadAux(configDir, cfg, name); return a.ageMs != null && a.ageMs < AUX_FORCE_MIN_AGE_MS; };
    const bothRecent = auxRecentlyFetched("openrouter") && auxRecentlyFetched("litellm");
    const [r] = await Promise.all([
      ensureCatalog(configDir, cfg, { force, _download }),
      ensureAuxAll(configDir, cfg, { force: force && !bothRecent, _dlOpenRouter, _dlLiteLlm }), // 兜底目录各自按 TTL/开关刷新，失败静默
    ]);
    refreshed = !!r.refreshed;
    found = findModelsDevProvider(loadModelsDev(configDir, cfg).data, provider, baseUrl);
    lookup = found.ok ? found.models : lookup;
  }
  // ③④ 兜底（本地缓存查询，不额外打网）：models.dev 仍查不到的模型到 OpenRouter/LiteLLM 找
  const stillMissing = missing.filter((id) => !lookup.some((x) => (x.id || x.model) === id));
  const aux = auxBackfillExtras(configDir, cfg, stillMissing);
  return { mdModels: lookup, refreshed, slug: found.ok ? found.slug : "", extras: aux.extras, auxUsed: aux.auxUsed };
}

/**
 * 纯变换：对一个完整 models 数据对象做 upsert（不写文件）。
 * 多 keys：keys 数组 → 完整写进 prov.apiKeys，同时 apiKey=第一个 key（pi 直连也可用）。
 * 兼容：不传 keys 时保留 apiKey/旧 headers；keepKey=true 保留旧 key。
 */
function upsertProviderData(data, input) {
  const provider = String(input.provider || "").trim();
  if (!provider) return { ok: false, error: "缺少 provider 名" };
  if (!data.providers || typeof data.providers !== "object") data.providers = {};
  const prov = data.providers[provider] || (data.providers[provider] = {});
  if (input.baseUrl) prov.baseUrl = String(input.baseUrl).replace(/\/+$/, "");
  if (input.api) prov.api = input.api;
  // G3 保存闸门（docs/aiti-model-wizard-uiue-gap-plan.md P0-A）：显式 enabled:false =「测试失败仍要保存」
  // → 落盘禁用态（设置面板/勾选可再启用）；undefined = 普通保存不改启用态（本函数永不隐式启用）
  if (input.enabled === false) prov.enabled = false;
  // provider 级请求头（#5）：显式传入时整体替换（空名字/空对象 → 删除）；不传保留旧值。
  // maskedHeaders（2026-09-17 决策 2B）：名单里的头是「打码回显」，写盘前用已存原值替换——
  // 已存缺失则丢弃该行（绝不把掩码当真值写进 models.json）。
  // headersFrom（2026-09-17 审核修正）：改名场景的「已存头」来源（旧 provider 的 headers）——
  // 未传 headers 时照原样继承（未动=保留），传了则作为掩码回填的原值来源。
  const headersFrom = (input.headersFrom && typeof input.headersFrom === "object") ? input.headersFrom : null;
  if (input.headers !== undefined) {
    const masked = new Set((Array.isArray(input.maskedHeaders) ? input.maskedHeaders : [])
      .map((n) => String(n || "").trim()).filter(Boolean));
    const prevHeaders = headersFrom || ((prov.headers && typeof prov.headers === "object") ? prov.headers : {});
    const clean = {};
    let n = 0;
    for (const [k, v] of Object.entries(input.headers || {})) {
      const name = String(k || "").trim();
      if (!name || !String(v ?? "").trim()) continue;
      let value = String(v);
      if (masked.has(name)) {
        if (typeof prevHeaders[name] === "string" && prevHeaders[name]) value = prevHeaders[name];
        else continue;
      }
      clean[name] = value; n++;
    }
    // 打码名单里「草稿未带值」的头：从来源补回（防客户端过滤掩码行后丢失）
    for (const name0 of masked) {
      const name = String(name0 || "").trim();
      if (!name || clean[name] !== undefined) continue;
      if (typeof prevHeaders[name] === "string" && prevHeaders[name]) { clean[name] = prevHeaders[name]; n++; }
    }
    if (n) prov.headers = clean; else delete prov.headers;
  } else if (headersFrom && !prov.headers) {
    prov.headers = { ...headersFrom }; // 改名未动头 → 继承旧 provider 的请求头
  }
  // 多 keys 数组 → 写完整 apiKeys 进 models.json（pi 只取 apiKey/baseUrl，apiKeys 不上行）
  if (Array.isArray(input.keys)) {
    const clean = dedupKeyNames(input.keys.map(normalizeKeyEntry).filter((k) => k && k.key));
    if (clean.length) {
      prov.apiKeys = clean;
      prov.apiKey = clean[0].key;
    } else if (!input.keepKey) {
      delete prov.apiKeys;
      delete prov.apiKey;
    }
  } else if (input.apiKey) {
    prov.apiKey = String(input.apiKey).trim();
    delete prov.apiKeyEnv; // 明文与 env 引用互斥：给了明文即清残留 env 引用（无论本次是否带该字段）
  } else if (input.apiKeyEnv && (!input.keepKey || !prov.apiKey)) {
    // env 型 provider（codex env_key / agent 配置导入）：keepKey 且已有 key 时让位（不覆盖用户现 key）
    prov.apiKeyEnv = String(input.apiKeyEnv).trim();
    delete prov.apiKey;
  } else if (!input.keepKey) {
    delete prov.apiKey;
  }
  const newModels = Array.isArray(input.models) ? input.models.filter((m) => m && (m.id || m.model || (typeof m === "string" && m))).map((m) => {
    if (typeof m === "string") return { id: m };
    const out = { id: m.id || m.model || m.name, name: m.name };
    for (const f of MODEL_META_FIELDS) if (m[f] !== undefined) out[f] = m[f];
    return out;
  }) : [];
  const storeModels = storeModelsFor(input.store, provider);
  const mdModels = Array.isArray(input.mdModels) ? input.mdModels : [];
  // listExtras（厂商 /models 富字段）字段白名单：只收 id/name + 元数据字段，剥掉客户端可能塞的任意其它键
  // headers 是用户手动配置的模型级字段，不该由厂商 /models 发现数据注入 → 从白名单排除
  const LIST_EXTRA_FIELDS = ["id", "model", "name", ...MODEL_META_FIELDS.filter((f) => f !== "headers")];
  const listExtras = Array.isArray(input.listExtras)
    ? input.listExtras
        .filter((x) => x && typeof x === "object" && (x.id || x.model))
        .map((x) => { const o = {}; for (const f of LIST_EXTRA_FIELDS) if (x[f] !== undefined) o[f] = x[f]; return o; })
    : [];
  const extras = Array.isArray(input.extras) ? input.extras : [];
  // 已知虚报上限修正（请求时校验会拒的，直接夹到真实值；如 ark-coding glm 报 131072 实收 128000）
  const clampCap = (m) => {
    const known = knownMaxTokensCap(provider, m.id);
    if (known !== undefined && m.maxTokens !== undefined && m.maxTokens > known) m.maxTokens = known;
    // 通用输出上限钳制（上游 pi #4675 同型问题）：maxTokens 逼近/超过 contextWindow 时，
    // OpenAI 兼容接口按「输入 + max_tokens ≤ 上下文窗口」校验，输入稍长必被 400。
    // OpenRouter 对 free 模型常回 max_completion_tokens = context×0.9 的陷阱值（如
    // nex-n2.5-pro:free 报 235929/262144），向导五源反填会忠实带进来。这里钳到窗口 50%，
    // 给输入留足预算（与 pi 上游 clamp 的 50% 输出硬上限语义一致）。
    if (typeof m.contextWindow === "number" && m.contextWindow > 0 &&
        typeof m.maxTokens === "number" && m.maxTokens > m.contextWindow * 0.5) {
      m.maxTokens = Math.floor(m.contextWindow * 0.5);
    }
    return m;
  };
  // fills：逐模型记录反填来源（仅本次新反填到的字段；#3 来源标注）
  const fills = [];
  if (input.removeModels) {
    // 保留现有条目：勾选式保存（刷新可选模型 / 一键整理）里保留下来的模型，若当前 models.json 已有
    // 本条目（含手工调过的 headers/模型级地址/参数），backfill 时作为最高优先源传入——不因整体替换而丢字段
    const existingKept = new Map();
    for (const m of Array.isArray(prov.models) ? prov.models : []) {
      const mid = typeof m === "string" ? m : (m.id || m.model);
      if (mid) existingKept.set(String(mid), m);
    }
    prov.models = newModels.map((m) => {
      const rep = {};
      const out = backfillModelMeta(m, existingKept.get(String(m.id)) || null, storeModels, mdModels, extras, listExtras, rep);
      // 模型级临时禁用（enabled:false）透传保留（反填链不覆盖用户显式值）
      if (m.enabled === false) out.enabled = false;
      if (Object.keys(rep).length) fills.push({ id: out.id, fills: rep });
      return clampCap(out);
    });
  } else if (newModels.length) {
    const existing = new Map();
    for (const m of Array.isArray(prov.models) ? prov.models : []) {
      const mid = typeof m === "string" ? m : (m.id || m.model);
      if (mid) existing.set(mid, m);
    }
    for (const m of newModels) {
      const report = {};
      const merged = backfillModelMeta(m, existing.get(m.id) || null, storeModels, mdModels, extras, listExtras, report);
      // 模型级临时禁用（enabled:false）透传保留
      if (m.enabled === false) merged.enabled = false;
      existing.set(m.id, clampCap(merged));
      if (Object.keys(report).length) fills.push({ id: m.id, fills: report });
    }
    prov.models = [...existing.values()];
  }
  // missingParams：本次保存里仍缺关键参数（contextWindow 或 maxTokens 在反填后仍为空）的模型
  // —— 数据源全查不到时会被落成裸条目（pi 只能按 128k/16k 硬默认用）。客户端据此提示用户
  // 用 ai-helper 的 model-params-fill skill 上网查权威数据补全（写入 models-store.json）。
  const touchedIds = new Set(newModels.map((m) => String(m.id || m.model || "")));
  const missingParams = (Array.isArray(prov.models) ? prov.models : [])
    .filter((m) => m && typeof m === "object" && touchedIds.has(String(m.id || m.model || "")))
    .filter((m) => m.contextWindow == null || m.maxTokens == null)
    .map((m) => ({ id: String(m.id || m.model || ""), name: m.name ? String(m.name) : "" }));
  return { ok: true, data, provider, modelCount: Array.isArray(prov.models) ? prov.models.length : 0, fills, missingParams };
}
/** 纯变换：写/删 modelOverrides.contextWindow（G2）——managed provider 无模型条目时的唯一写口。
 *  contextWindow 传 null/undefined 删除覆盖；覆盖集空则整键删除；provider 条目空则整条删除（pi 拒收空条目）。 */
function setModelOverrideData(data, provider, modelId, contextWindow) {
  if (!data.providers || typeof data.providers !== "object") data.providers = {};
  const prov = data.providers[provider] || (data.providers[provider] = {});
  const ov = (prov.modelOverrides && typeof prov.modelOverrides === "object" && !Array.isArray(prov.modelOverrides)) ? { ...prov.modelOverrides } : {};
  const prev = (ov[modelId] && typeof ov[modelId] === "object" && !Array.isArray(ov[modelId])) ? { ...ov[modelId] } : {};
  if (contextWindow === undefined || contextWindow === null) delete prev.contextWindow;
  else prev.contextWindow = contextWindow;
  if (Object.keys(prev).length) ov[modelId] = prev; else delete ov[modelId];
  if (Object.keys(ov).length) prov.modelOverrides = ov; else delete prov.modelOverrides;
  if (!Object.keys(prov).length) delete data.providers[provider];
  return { ok: true, data, provider, model: modelId };
}
/** 读取某 provider 的 modelOverrides（仅 contextWindow 键；overrides-only 条目也返回）。 */
function getModelOverrides(data, provider) {
  const prov = data.providers && data.providers[provider];
  const ov = prov && prov.modelOverrides;
  const out = {};
  if (ov && typeof ov === "object" && !Array.isArray(ov)) {
    for (const [mid, v] of Object.entries(ov)) {
      if (v && typeof v === "object" && !Array.isArray(v) && v.contextWindow !== undefined) out[mid] = v.contextWindow;
    }
  }
  return out;
}
/** 纯变换：删除 provider（models 数据层面）。 */
function deleteProviderData(data, provider) {
  if (!data.providers || !data.providers[provider]) return { ok: false, error: "provider 不存在: " + provider };
  delete data.providers[provider];
  return { ok: true, data, provider };
}

// ---------------- 保存撤销（一级 undo） ----------------
function undoPath(configDir) { return path.join(configDir || "", "last-save.json"); }
/** 保存前快照受影响 provider 的旧条目（null=原本不存在 → 撤销时删除）。只留最近一次。 */
function stashUndo(configDir, providersPatch) {
  try { return writeJSONAtomic(undoPath(configDir), { ts: Date.now(), providers: providersPatch }); } catch { return false; }
}
function loadUndo(configDir) {
  const u = readJSON(undoPath(configDir), null);
  return u && u.providers && typeof u.providers === "object" && Object.keys(u.providers).length ? u : null;
}
/** 撤销上次保存：按快照恢复（entry=null 的删掉，其余整体回写）。纯变换 + 原子写由调用方完成时可直接用 restoreUndoData。 */
function restoreUndoData(data, undo) {
  if (!data.providers || typeof data.providers !== "object") data.providers = {};
  let changed = 0;
  for (const [name, entry] of Object.entries(undo.providers)) {
    if (entry === null || entry === undefined) { if (data.providers[name]) { delete data.providers[name]; changed++; } }
    else { data.providers[name] = entry; changed++; }
  }
  return { ok: changed > 0, changed, data };
}
/** 保存 provider（agent 工具路径）：先解析反填源（models.dev + OpenRouter/LiteLLM 兜底，未知模型强制刷新一次），
 *  再纯变换 + 原子写。返回 { ok, provider, modelCount, file, catalogRefreshed?, catalogSlug?, auxUsed? }。 */

// --------------------------------------------------------------------
// 模型聚合（组合模型 / combo provider）：列表 + 保存（纯变换，pi-models-combo 引擎消费）
// --------------------------------------------------------------------
// 生效模型清单解析（store 兜底等）用工作区共享实现：部署时拷到扩展目录，仓内测试回退相对路径
let resolveProviderModels;
let normModelId;
try { ({ resolveProviderModels, normModelId } = require("./effective-models.cjs")); }
catch { ({ resolveProviderModels, normModelId } = require("../shared/effective-models.cjs")); }

// ---- pi ModelRuntime 快照（combo 成员池与引擎同源：内存 models + models.json 统一解析） ----
// combo 成员可以是运行时注册的 provider（如 pi-freeflow 的 freeflow，不在 models.json）——
// 引擎（pi-models-combo flattenComboSlots）运行时按 pi 注册表解析成员，保存校验必须同源，
// 否则把合法成员误报成「成员不存在」。aiti-model-check /status 同款 init（ModelRuntime.create 离线快照）。
let _piRT = null;
let _piRTInit = null;
let _piRTErr = "";
/** 从进程 cwd（pi-web/pi-prod）向上找 @earendil-works/pi-coding-agent 包目录（扩展目录自身没有该依赖） */
function findPiPackage() {
  let dir = process.cwd();
  for (;;) {
    const cand = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent");
    if (fs.existsSync(path.join(cand, "package.json"))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
async function initPiRuntime(cfg) {
  if (_piRT) return _piRT;
  if (_piRTInit) return _piRTInit; // single-flight
  _piRTInit = (async () => {
    try {
      const pkgDir = findPiPackage();
      if (!pkgDir) throw new Error("找不到 @earendil-works/pi-coding-agent（从 cwd 向上找 node_modules）");
      // 0.84.2 exports 只有 import 条件（无 require）→ 动态 import()（ESM 语义；aiti-model-check 同款）
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const entry = (pkg.exports && pkg.exports["."] && (pkg.exports["."].import || pkg.exports["."].default)) || pkg.main || "dist/index.js";
      const { pathToFileURL } = require("node:url");
      const mod = await import(pathToFileURL(path.join(pkgDir, entry)).href);
      const ModelRuntime = mod.ModelRuntime || (mod.default && mod.default.ModelRuntime);
      if (!ModelRuntime) throw new Error("pi-coding-agent 无 ModelRuntime 导出");
      _piRT = await ModelRuntime.create({
        refreshOnCreate: false, // 离线：只用本地 models.json + models-store.json 缓存 + 内置目录，不触发网络刷新
        modelsPath: expandPath(cfg.modelsPath || "~/.pi/agent/models.json"),
        modelsStorePath: expandPath(cfg.modelsStorePath || "~/.pi/agent/models-store.json"),
      });
      _piRTErr = "";
    } catch (e) {
      _piRT = null;
      _piRTErr = String((e && e.message) || e);
    }
    return _piRT;
  })();
  try { return await _piRTInit; } finally { _piRTInit = null; }
}
function piReady() { return !!_piRT; }
function piError() { return _piRTErr; }
/** pi ModelRuntime 快照条目（全部 provider，含运行时注册的如 freeflow）：
 *  [{provider,id,api,baseUrl,reasoning,input}]；未就绪返回 null（调用方回退 HTTP /api/models）。 */
function runtimeEntries() {
  if (!_piRT) return null;
  try {
    const out = [];
    for (const p of _piRT.getProviders()) {
      const pid = String((p && (p.id || p.name)) || "");
      if (!pid) continue;
      let ms = [];
      try { ms = _piRT.getModels(pid) || []; } catch { ms = []; }
      for (const m of ms) {
        if (!m || !m.id) continue;
        out.push({
          provider: pid,
          id: String(m.id),
          api: String(m.api || "openai-completions"),
          baseUrl: String(m.baseUrl || (p && p.baseUrl) || ""),
          reasoning: !!m.reasoning,
          input: Array.isArray(m.input) ? m.input.map(String) : [],
        });
      }
    }
    return out;
  } catch (e) { return null; }
}


/** 运行时 provider 合成（pi-models-combo 引擎 flattenComboSlots 同构）：
 *  runtime 条目数组 [{provider,id,api?,baseUrl?,reasoning?,input?}] 或 provider 映射 →
 *  仅对 models.json 没有的 provider 合成占位条目（apiKey="runtime-registered" 占位，
 *  引擎运行时按注册 provider 的真实凭据/免 key 语义解析）；models.json 已有的 provider 不动，
 *  其内存模型经 resolveProviderModels 的 runtime 条目参数合并（runtime 为主、显式过滤缺漏补尾）。 */
function mergeRuntimeProviders(providers, runtime) {
  const merged = { ...(providers || {}) };
  if (!runtime || typeof runtime !== "object") return merged;
  const byPid = new Map();
  if (Array.isArray(runtime)) {
    for (const rm of runtime) {
      if (!rm || !rm.provider || !rm.id) continue;
      if (!byPid.has(rm.provider)) byPid.set(rm.provider, []);
      byPid.get(rm.provider).push(rm);
    }
  } else {
    for (const [pid, ms] of Object.entries(runtime)) {
      if (!Array.isArray(ms)) continue;
      byPid.set(pid, ms.map((m) => (typeof m === "string" ? { id: m } : m)));
    }
  }
  for (const [pid, ms] of byPid) {
    if (merged[pid]) continue; // models.json 已有 → 走 resolveProviderModels 的 runtime 条目合并
    const seen = new Set();
    const models = [];
    for (const m of ms) {
      const id = String(m.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        api: String(m.api || "openai-completions"),
        baseUrl: String(m.baseUrl || ""),
        reasoning: !!m.reasoning,
        input: Array.isArray(m.input) ? m.input.map(String) : [],
      });
    }
    if (!models.length) continue;
    merged[pid] = {
      name: pid,
      api: models[0].api,
      baseUrl: String(ms[0].baseUrl || ""),
      apiKey: "runtime-registered", // 占位：仅用于保存校验 hasKey 判定（引擎同款）；真实调用凭据在 pi 注册表
      models,
      _runtimeRegistered: true,
    };
  }
  return merged;
}

/** GET /combos 数据：现有 combo provider 列表 + 可选成员池。
 *  成员池经共享模块 resolveProviderModels 解析（显式 models > store 补全），与「已配置」同源。
 *  runtime：pi ModelRuntime 快照条目（aiti-model-check /status 同款合并——内存 models + models.json
 *  统一解析；也兼容 provider 映射对象）。运行时注册的 provider（如 pi-freeflow 的 freeflow，
 *  不在 models.json）合成进 provider 集合参与成员池——与 pi-models-combo 引擎 flattenComboSlots 同构。 */
function comboPageData(data, store, runtime) {
  const combos = [];
  const members = [];
  // 合并 models.json 和运行时 provider（含内存模型条目合并）
  const allProviders = mergeRuntimeProviders(data && data.providers || {}, runtime);
  const resolved = resolveProviderModels({ providers: allProviders, store: store || null, runtime: Array.isArray(runtime) ? runtime : null });
  for (const [pid, pcfg] of Object.entries(allProviders)) {
    if (!pcfg || typeof pcfg !== "object") continue;
    // 检查是否是 combo provider：provider 级别 combo:true 或者任意模型有 combo 属性
    const isComboProvider = pcfg.combo === true || (Array.isArray(pcfg.models) && pcfg.models.some(m => m && m.combo));
    if (isComboProvider) {
      combos.push({
        providerId: pid,
        name: pcfg.name || pid,
        api: pcfg.api || "",
        enabled: pcfg.enabled !== false, // 聚合组级临时禁用
        models: (Array.isArray(pcfg.models) ? pcfg.models : []).map((m) => ({
          id: m.id,
          name: m.name || m.id,
          contextWindow: m.contextWindow ?? null,
          maxTokens: m.maxTokens ?? null,
          input: Array.isArray(m.input) ? m.input : [],
          enabled: m.enabled !== false, // 虚拟模型级临时禁用
          members: (m.combo && Array.isArray(m.combo.members)) ? m.combo.members.map((r) => ({ provider: r.provider, model: r.model, weight: r.weight, enabled: r.enabled !== false, ...(Array.isArray(r.types) && r.types.length > 0 ? { types: r.types } : {}) })) : [],
          stickyTtlMin: (m.combo && m.combo.stickyTtlMin) ?? null,
        })),
      });
      continue;
    }
    const entry = resolved.get(pid);
    if (!entry) continue;
    for (const m of entry.models) {
      if (m.combo) continue;
      members.push({
        provider: pid, model: m.id, name: m.name,
        api: m.api, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
        input: m.input, reasoning: m.reasoning, cost: m.cost, keyCount: entry.keyCount,
      });
    }
  }
  return { combos, members };
}

/**
 * POST /combo-save 纯变换：写 combo:true 虚拟 provider（baseUrl 占位，运行时被 pmc 引擎 override）。
 * 任一硬校验失败整体拒绝（严禁部分组合上线）；重复成员引用忽略；自动计算
 * contextWindow/maxTokens 取成员最小值、input 并集、cost 取最贵成员估算。
 * input: {provider, displayName?, renameFrom?, models:[{id,name?,members:[{provider,model,weight?}],stickyTtlMin?}]}
 */
function comboSaveProviderData(data, input, store, runtime) {
  const provider = String(input.provider || "").trim();
  if (!provider) return { ok: false, error: "需要组合名称（provider id）" };
  if (!data.providers || typeof data.providers !== "object") data.providers = {};
  const inModels = Array.isArray(input.models) ? input.models : [];
  if (!inModels.length) return { ok: false, error: "至少一个虚拟模型" };
  // 名称碰撞保护：目标名已被【非聚合】provider 占用 → 拒绝（防止整份真实配置被静默覆盖）
  if (data.providers[provider] && provider !== String(input.renameFrom || "")) {
    const isCombo = data.providers[provider].combo === true;
    return { ok: false, error: isCombo
      ? `"${provider}" 已是另一个聚合组——如需合并请编辑它，或换一个名字`
      : `"${provider}" 已存在且是普通 provider，不能覆盖为聚合组——请换一个名字` };
  }
  // 成员池校验表（与列表页/引擎同源：共享模块解析 + 运行时 provider 合并——
  // 成员可以是运行时注册 provider（如 freeflow），引擎运行时能解析，校验不得误拒）
  const mergedProviders = mergeRuntimeProviders(data.providers, runtime);
  const resolved = resolveProviderModels({ providers: mergedProviders, store: store || null, runtime: Array.isArray(runtime) ? runtime : null });
  const pool = new Map();
  for (const [pid, entry] of resolved) {
    for (const m of entry.models) {
      if (m.combo) continue; // 聚合组虚拟模型不作成员（与引擎 mdef.combo 拒绝同源，防嵌套组漏网）
      // 归一化键（引擎同款 normModelId）：成员引用省略 :free/:batch/~ 后缀也能命中；raw→norm 在同 provider 内唯一（resolve 已按 norm 去重）
      pool.set(pid + "/" + normModelId(m.id), { api: m.api, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: m.input, cost: m.cost, hasKey: entry.keyCount > 0 });
    }
  }
  const outModels = [];
  let providerApi = "";
  for (const vm of inModels) {
    const id = String(vm.id || "").trim();
    if (!id) return { ok: false, error: "虚拟模型缺 id" };
    const refs = Array.isArray(vm.members) ? vm.members : [];
    if (!refs.length) return { ok: false, error: `虚拟模型 "${id}" 至少一个成员` };
    let commonApi = "";
    let ctxMin = null, outMin = null;
    const inputs = new Set();
    let costIn = 0, costOut = 0, hasCost = false;
    const members = [];
    const seen = new Set();
    for (const ref of refs) {
      const rkey = String(ref?.provider || "") + "/" + String(ref?.model || "");
      const meta = pool.get(String(ref?.provider || "") + "/" + normModelId(String(ref?.model || "")));
      if (!meta) return { ok: false, error: `虚拟模型 "${id}"：成员不存在或不可用: ${rkey}` };
      if (!meta.hasKey) return { ok: false, error: `虚拟模型 "${id}"：成员无可用 key: ${rkey}` };
      if (seen.has(rkey)) continue; // 冗余引用忽略（不叠加权重/槽位）
      seen.add(rkey);
      if (!commonApi) commonApi = meta.api;
      else if (meta.api !== commonApi) return { ok: false, error: `虚拟模型 "${id}"：跨协议成员（${commonApi} vs ${meta.api}: ${rkey}）——仅支持同协议聚合` };
      if (ref.weight != null && ref.weight !== "") {
        const w = Number(ref.weight);
        if (!Number.isFinite(w) || w < 1) return { ok: false, error: `虚拟模型 "${id}"：非法权重 "${ref.weight}"（需 ≥1）: ${rkey}` };
      }
      if (typeof meta.contextWindow === "number") ctxMin = ctxMin === null ? meta.contextWindow : Math.min(ctxMin, meta.contextWindow);
      if (typeof meta.maxTokens === "number") outMin = outMin === null ? meta.maxTokens : Math.min(outMin, meta.maxTokens);
      for (const inp of meta.input) inputs.add(inp);
      if (meta.cost && typeof meta.cost === "object") {
        hasCost = true;
        costIn = Math.max(costIn, Number(meta.cost.input) || 0);
        costOut = Math.max(costOut, Number(meta.cost.output) || 0);
      }
      const w = ref.weight == null || ref.weight === "" ? undefined : Number(ref.weight);
      // 成员承接类别（types）：白名单数组（text/vision/other）。非法值 → 整体拒绝（防止写坏配置）；
      // 空数组/未配 → 不写字段（引擎缺省全收，与现状等价）。
      let types;
      if (ref.types !== undefined && ref.types !== null) {
        if (!Array.isArray(ref.types)) return { ok: false, error: `虚拟模型 "${id}"：成员 ${rkey} 的 types 必须是数组` };
        const VALID_TYPES = ["text", "vision", "other"];
        const bad = ref.types.filter((x) => !VALID_TYPES.includes(String(x)));
        if (bad.length > 0) return { ok: false, error: `虚拟模型 "${id}"：成员 ${rkey} 非法 types 值 ${bad.join(",")}（合法: ${VALID_TYPES.join("/")}）` };
        if (ref.types.length > 0) types = [...new Set(ref.types.map((x) => String(x)))];
      }
      // 成员引用级临时禁用（enabled:false）：透传保留；引擎 flatten 跳过、其余成员照常组队
      members.push({
        provider: ref.provider, model: ref.model,
        ...(w !== undefined ? { weight: w } : {}),
        ...(types ? { types } : {}),
        ...(ref.enabled === false ? { enabled: false } : {}),
      });
    }
    // 成员全部禁用 → 拒绝保存（至少保留一个启用成员；临时全停请用聚合组级禁用）
    if (!members.some((mm) => mm.enabled !== false)) {
      return { ok: false, error: `虚拟模型 "${id}"：所有成员都已禁用——至少保留一个启用的成员（临时全停请用聚合组级禁用）` };
    }
    if (!providerApi) providerApi = commonApi;
    outModels.push({
      id,
      name: String(vm.name || id),
      ...(vm.enabled === false ? { enabled: false } : {}), // 虚拟模型级临时禁用：透传保留
      ...(ctxMin != null ? { contextWindow: ctxMin } : {}),
      ...(outMin != null ? { maxTokens: outMin } : {}),
      input: [...inputs],
      ...(hasCost ? { cost: { input: costIn, output: costOut } } : {}),
      combo: { members, ...(Number(vm.stickyTtlMin) > 0 ? { stickyTtlMin: Number(vm.stickyTtlMin) } : {}) },
    });
  }
  const prevProv = data.providers[provider];
  data.providers[provider] = {
    name: String(input.displayName || provider),
    combo: true,
    baseUrl: "http://combo.pmc.invalid/", // 占位：运行时被 pi-models-combo 引擎 override 为本机聚合代理
    api: providerApi || "openai-completions",
    // 聚合组级临时禁用（enabled:false）保留：编辑已有禁用组不因保存而清除
    ...(input.enabled === false || prevProv?.enabled === false ? { enabled: false } : {}),
    models: outModels,
  };
  // 改名：删旧 provider 键
  const oldName = String(input.renameFrom || "").trim();
  if (oldName && oldName !== provider && data.providers[oldName]) delete data.providers[oldName];
  return { ok: true, provider, modelCount: outModels.length };
}

async function upsertProvider(configDir, cfg, input) {
  const provider = String(input.provider || "").trim();
  if (!provider) return { ok: false, error: "缺少 provider 名" };
  const { file, data } = loadModelsJson(configDir, cfg);
  const store = loadModelsStore(configDir, cfg).data;
  const prov0 = data.providers && data.providers[provider];
  const md = await resolveMdForUpsert(configDir, cfg, {
    provider,
    baseUrl: input.baseUrl,
    models: input.models,
    existingModels: prov0 && prov0.models,
    store,
  });
  const r = upsertProviderData(data, { ...input, store, mdModels: md.mdModels, extras: md.extras });
  if (!r.ok) return r;
  if (!saveModelsJson(configDir, cfg, r.data)) return { ok: false, error: "写 models.json 失败" };
  return { ok: true, provider: r.provider, modelCount: r.modelCount, file, catalogRefreshed: md.refreshed, catalogSlug: md.slug, auxUsed: md.auxUsed, missingParams: r.missingParams || [] };
}
function deleteProvider(configDir, cfg, provider) {
  const { file, data } = loadModelsJson(configDir, cfg);
  const r = deleteProviderData(data, provider);
  if (!r.ok) return r;
  if (!saveModelsJson(configDir, cfg, r.data)) return { ok: false, error: "写 models.json 失败" };
  return { ok: true, provider: r.provider, file };
}

// ---------------- 一键体检与测试留存 ----------------
// last-test.json（cacheBase = 数据分层 cache 层，可再生）：每 provider 最近一次向导测试结论
// （打码 key 名/延迟/状态/明细），树上徽标与详情健康条的数据源；手动 /test 与 /checkup 都写。
function lastTestPath(configDir) { return path.join(cacheBase(configDir), "last-test.json"); }
function loadLastTest(configDir) {
  const r = readJSON(lastTestPath(configDir), null);
  if (r && typeof r === "object" && r.providers && typeof r.providers === "object") return r;
  return { ts: 0, providers: {} };
}
function recordLastTest(configDir, provider, entry) {
  if (!provider || !entry || typeof entry !== "object") return false;
  const r = loadLastTest(configDir);
  r.ts = Date.now();
  r.providers[provider] = { ts: Date.now(), ...entry };
  return writeJSONAtomic(lastTestPath(configDir), r);
}
/** 挑该 provider 的「第一把启用凭据」：多 key 取首个 enabled 的，否则单 apiKey/apiKeyEnv 兜底。 */
function pickProviderCredential(p) {
  if (!p || typeof p !== "object") return null;
  const keys = dedupKeyNames(Array.isArray(p.apiKeys) ? p.apiKeys.map(normalizeKeyEntry).filter(Boolean) : []);
  const k = keys.find((x) => x && x.enabled !== false && x.key) || null;
  if (k) return { key: k.key, keyName: k.name, masked: maskKey(k.key) };
  const single = String(p.apiKey || (p.apiKeyEnv ? process.env[p.apiKeyEnv] || "" : "")).trim();
  if (single) return { key: single, keyName: p.apiKeyEnv ? p.apiKeyEnv : "key", masked: maskKey(single) };
  return null;
}
/** 一键体检：逐已配置 provider 串行发一个探针（跳过聚合组/禁用/运行时注册/无凭据），
 *  首个启用模型作聊天探针（列表有≠可推理；无模型配置则退回 /models 列表验证）；
 *  结果逐 provider 写 last-test.json（手动触发非轮询；串行=避免并发限流假失败，与 /test 同语义）。
 *  testFn 可注入（单测用），缺省 testConnection。 */
async function runCheckup(configDir, cfg, opts = {}) {
  const testFn = opts.testFn || testConnection;
  const timeoutMs = opts.timeoutMs || (cfg.test && cfg.test.timeoutMs) || 12000;
  const { data } = loadModelsJson(configDir, cfg);
  const store = loadModelsStore(configDir, cfg).data;
  const results = [];
  const entries = Object.entries(data.providers || {});
  for (const [name, p] of entries) {
    if (!p || typeof p !== "object") continue;
    if (p.combo === true) { results.push({ provider: name, skipped: true, reason: "聚合组（凭据在成员侧，直接测成员）" }); continue; }
    if (p.enabled === false) { results.push({ provider: name, skipped: true, reason: "临时禁用中" }); continue; }
    const cred = pickProviderCredential(p);
    if (!cred) { results.push({ provider: name, skipped: true, reason: "无存储凭据" }); continue; }
    let baseUrl = String(p.baseUrl || "").replace(/\/+$/, "");
    let api = p.api || "openai-completions";
    if (!baseUrl) {
      // baseUrl 缺失时用 models-store 补全（与 providersStatus 同一解析语义）
      const sp = store && store[name];
      const first = sp && Array.isArray(sp.models) && sp.models.length ? (typeof sp.models[0] === "object" ? sp.models[0] : null) : null;
      if (first && first.baseUrl) { baseUrl = String(first.baseUrl).replace(/\/+$/, ""); if (first.api) api = first.api; }
    }
    if (!baseUrl) { results.push({ provider: name, skipped: true, reason: "无法确定 baseUrl" }); continue; }
    const models = Array.isArray(p.models) ? p.models : [];
    const mEn = models.find((m) => (m && typeof m === "object") ? m.enabled !== false : true);
    const modelId = mEn ? String((mEn && (mEn.id || mEn.model)) || (typeof mEn === "string" ? mEn : "") || "") : "";
    let r;
    try {
      r = await testFn({ baseUrl, api, apiKey: cred.key, model: modelId || undefined }, { timeoutMs, extraHeaders: (p.headers && typeof p.headers === "object") ? p.headers : {} });
    } catch (e) {
      r = { pass: false, rateLimited: false, status: 0, latencyMs: null, detail: "异常：" + String((e && e.message) || e) };
    }
    const row = { provider: name, skipped: false, pass: !!r.pass, rateLimited: !!r.rateLimited, status: r.status ?? null, latencyMs: r.latencyMs ?? null, detail: r.detail || "", keyName: cred.keyName, masked: cred.masked, model: modelId || null };
    results.push(row);
    recordLastTest(configDir, name, { pass: row.pass, rateLimited: row.rateLimited, status: row.status, latencyMs: row.latencyMs, detail: row.detail, keyName: row.keyName, masked: row.masked, model: row.model });
  }
  const real = results.filter((x) => !x.skipped);
  return {
    ok: true, ts: Date.now(), total: entries.length,
    pass: real.filter((x) => x.pass && !x.rateLimited).length,
    rateLimited: real.filter((x) => x.pass && x.rateLimited).length,
    fail: real.filter((x) => !x.pass).length,
    skip: results.length - real.length,
    results,
  };
}

// ---------------- 新模型检测与提醒（模型快照缓存） ----------------
// 缓存文件 configDir/reminder.json 存两份模型列表快照：
//   prev  = 前日旧的（基线）：{ provider: { ts, models[] } }
//   curr  = 今日模型（最近一次拉取/配置的可用列表）：{ provider: { ts, models[] } }
// 跨天时 curr 整体推进为 prev，再建新的空 curr —— 新模型 = (curr - prev) - 已配置。
// toast 频控（每天 ≤ maxPerDay 次、相邻间隔 ≥ minGapMs）持久化在 toast 字段。
function reminderPath(configDir) { return path.join(configDir || "", "reminder.json"); }
function dayStr(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
function loadReminder(configDir) {
  const r = readJSON(reminderPath(configDir), null);
  if (r && typeof r === "object" && r.prev && r.curr) {
    if (!r.pending || typeof r.pending !== "object") r.pending = {}; // 旧文件兼容
    if (!r.acked || typeof r.acked !== "object") r.acked = {};
    return r;
  }
  return { prev: {}, curr: {}, prevDay: "", currDay: "", pending: {}, acked: {}, toast: { day: "", count: 0, lastAt: 0 } };
}
function saveReminder(configDir, r) { return writeJSONAtomic(reminderPath(configDir), r); }
/** 跨天滚动：今日桶整体变前日（prev=curr），再开新今日桶；同日不动。 */
function rollReminderDay(r, ts) {
  const day = dayStr(ts);
  if (r.currDay !== day) {
    r.prev = r.curr || {};
    r.prevDay = r.currDay || "";
    r.curr = {};
    r.currDay = day;
  }
  return r;
}
function rollReminder(configDir, ts) {
  const r = loadReminder(configDir);
  rollReminderDay(r, ts || Date.now());
  saveReminder(configDir, r);
  return r;
}
/** 模型 id 归一：去重保序；兼容 string / {id|model|name} */
function normModelIds(models) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(models) ? models : []) {
    const id = typeof m === "string" ? m : (m && (m.id || m.model || m.name));
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
/** 快照某 provider 的已知模型列表进今日桶。opts.merge=true → 与今日桶现有合并（保存时用，
 *  不丢已发现但未保存的可用模型）；缺省覆盖（扫描拉取是全量，直接替换）。 */
function snapshotProvider(configDir, provider, models, opts) {
  if (!provider) return null;
  const r = loadReminder(configDir);
  rollReminderDay(r, Date.now());
  const ids = normModelIds(models);
  const cur = r.curr[provider];
  const merged = opts && opts.merge && cur && Array.isArray(cur.models)
    ? [...new Set([...cur.models, ...ids])]
    : ids;
  r.curr[provider] = { ts: Date.now(), models: merged };
  saveReminder(configDir, r);
  return r;
}
/** 删除 provider 时同步从两份快照、待告知集与 ack 记录移除（避免幽灵 provider 的误报）。 */
function removeReminderProvider(configDir, provider) {
  const r = loadReminder(configDir);
  delete r.prev[provider];
  delete r.curr[provider];
  if (r.pending) delete r.pending[provider];
  if (r.acked) delete r.acked[provider];
  saveReminder(configDir, r);
  return r;
}
/** 新模型待告知集：今日 diff 并入 pending 持久化，跨天滚动不清（错过 toast 下轮还能再弹），
 *  直到被 ack（用户打开向导已配置页）或模型变成已配置/已删除才移除。
 *  返回值 total/providers 基于 pending 而非当日 diff。 */
function computeNewModels(configDir, cfg) {
  const r = loadReminder(configDir);
  const { data } = loadModelsJson(configDir, cfg);
  const configured = {};
  for (const [name, p] of Object.entries((data && data.providers) || {})) {
    configured[name] = new Set(normModelIds(p && p.models));
  }
  const baseline = !!r.prevDay;
  // 整目录漂移降噪阈值：单家一次新增超过 max(绝对数, 现列表占比) → 视为厂商目录整包更新而非新模型，不提醒
  const remCfg = (cfg && cfg.reminder) || {};
  const driftAbs = remCfg.driftMaxCount != null ? remCfg.driftMaxCount : 10;
  const driftRatio = remCfg.driftRatio != null ? remCfg.driftRatio : 0.25;
  // 今日 diff（前日基线 vs 今日可用 - 已配置）；无基线时为空
  const diffProviders = {};
  if (baseline) {
    for (const [name, c] of Object.entries(r.curr || {})) {
      if (!c || !Array.isArray(c.models)) continue;
      if (!(name in configured)) continue; // 已删除/不存在 → 忽略
      const prevSet = new Set((r.prev && r.prev[name] && r.prev[name].models) || []);
      const conf = configured[name];
      const newOnes = c.models.filter((id) => !prevSet.has(id) && !conf.has(id));
      if (!newOnes.length) continue;
      const driftLimit = Math.max(driftAbs, Math.ceil(c.models.length * driftRatio));
      if (newOnes.length > driftLimit) continue; // 漂移降噪：整包更新刷屏，静默（跨天后自然入基线）
      diffProviders[name] = newOnes;
    }
  }
  // pending 同步：并入新 diff（跳过当日已 ack 的 id）+ 清掉已配置/已删除/过期 ack 记录（有变化才落盘）
  const pending = r.pending && typeof r.pending === "object" ? r.pending : (r.pending = {});
  const acked = r.acked && typeof r.acked === "object" ? r.acked : (r.acked = {});
  let dirty = false;
  // 过期 ack 记录清理（只保留当日的；跨天后旧 diff 已进基线，无需再挡）
  for (const name of Object.keys(acked)) {
    if (!acked[name] || acked[name].day !== r.currDay) { delete acked[name]; dirty = true; }
  }
  for (const name of Object.keys(pending)) {
    const conf = configured[name];
    const kept = Array.isArray(pending[name]) ? pending[name] : [];
    const after = conf ? kept.filter((id) => !conf.has(id)) : kept;
    if (after.length !== kept.length) dirty = true;
    if (!conf || !after.length) { delete pending[name]; dirty = true; }
    else pending[name] = after;
  }
  for (const [name, ids] of Object.entries(diffProviders)) {
    const a = acked[name] && acked[name].day === r.currDay ? new Set(acked[name].ids || []) : null;
    const fresh = a ? ids.filter((id) => !a.has(id)) : ids;
    if (fresh.length !== ids.length) dirty = true;
    if (!fresh.length) continue;
    const merged = [...new Set([...(pending[name] || []), ...fresh])];
    if (merged.length !== (pending[name] || []).length) { pending[name] = merged; dirty = true; }
  }
  if (dirty) saveReminder(configDir, r);
  const providers = {};
  let total = 0;
  for (const [name, ids] of Object.entries(pending)) {
    if (!Array.isArray(ids) || !ids.length) continue;
    providers[name] = { count: ids.length, newModels: ids };
    total += ids.length;
  }
  return { ok: true, total, providers, baseline };
}
/** 用户已知悉（打开向导「已配置」页/点了 toast）：清待告知集，并把本次 ack 的 id 记入
 *  当日 acked（防止同日 diff 在下次 compute 时把刚 ack 的模型重新并回）。
 *  provider 缺省=全部清除；ids 缺省=清该 provider 全部；否则只清指定模型 id。 */
function ackNewModels(configDir, provider, ids) {
  const r = loadReminder(configDir);
  const before = JSON.stringify([r.pending, r.acked]);
  const pending = r.pending && typeof r.pending === "object" ? r.pending : (r.pending = {});
  const acked = r.acked && typeof r.acked === "object" ? r.acked : (r.acked = {});
  const rememberAck = (name, idList) => {
    if (!idList.length) return;
    if (!acked[name] || acked[name].day !== r.currDay) acked[name] = { day: r.currDay, ids: [] };
    acked[name].ids = [...new Set([...acked[name].ids, ...idList])];
  };
  if (!provider) {
    for (const [name, list] of Object.entries(pending)) rememberAck(name, Array.isArray(list) ? list : []);
    r.pending = {};
  } else {
    const idList = Array.isArray(ids) && ids.length ? ids : (pending[provider] || []);
    rememberAck(provider, idList);
    const kept = (pending[provider] || []).filter((id) => !(Array.isArray(ids) && ids.length ? ids.includes(id) : true));
    if (!kept.length) delete pending[provider];
    else pending[provider] = kept;
  }
  if (JSON.stringify([r.pending, r.acked]) !== before) saveReminder(configDir, r);
  return { ok: true };
}
/** 单 provider 的新模型列表（编辑流预勾选用）：待告知集 ∪ 今日 diff - 已配置。 */
function newModelsForProvider(configDir, cfg, provider) {
  if (!provider) return [];
  const r = loadReminder(configDir);
  const { data } = loadModelsJson(configDir, cfg);
  const p = data.providers && data.providers[provider];
  const conf = new Set(normModelIds(p && p.models));
  const out = new Set();
  for (const id of (r.pending && r.pending[provider]) || []) { if (!conf.has(id)) out.add(id); }
  if (r.prevDay) {
    const prevSet = new Set((r.prev && r.prev[provider] && r.prev[provider].models) || []);
    const cur = r.curr && r.curr[provider];
    if (cur && Array.isArray(cur.models)) for (const id of cur.models) { if (!prevSet.has(id) && !conf.has(id)) out.add(id); }
  }
  return [...out];
}
/** toast 频控判定：每天 ≤ maxPerDay 次、相邻间隔 ≥ minGapMs。只判定不落盘。 */
function toastDecision(configDir, cfg) {
  const r = loadReminder(configDir);
  const t = r.toast || (r.toast = { day: "", count: 0, lastAt: 0 });
  const max = (cfg && cfg.reminder && cfg.reminder.maxPerDay) || 3;
  const gap = (cfg && cfg.reminder && cfg.reminder.minGapMs) || 2 * 60 * 60 * 1000;
  const now = Date.now();
  const day = dayStr(now);
  if (t.day !== day) { t.day = day; t.count = 0; }
  if (t.count >= max) return { allowed: false, reason: "daily-limit", count: t.count, nextAtMs: null };
  if (t.lastAt && now - t.lastAt < gap) return { allowed: false, reason: "gap", count: t.count, nextAtMs: t.lastAt + gap };
  return { allowed: true, reason: "ok", count: t.count, nextAtMs: null };
}
/** toast 展示后落盘：计数 +1、记 lastAt。 */
function markToastShown(configDir, cfg) {
  const r = loadReminder(configDir);
  const t = r.toast || (r.toast = { day: "", count: 0, lastAt: 0 });
  const now = Date.now();
  const day = dayStr(now);
  if (t.day !== day) { t.day = day; t.count = 0; }
  t.count += 1;
  t.lastAt = now;
  saveReminder(configDir, r);
  return { count: t.count, lastAt: t.lastAt };
}

// ---------------- 其它 ----------------
function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts); const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

module.exports = {
  DEFAULT_CONFIG, loadConfig, saveConfig, loadAffiliate, loadFreeModels, matchInstalledFree, freeNpmName,
  getProviderKeys, setProviderKeys, dedupKeyNames, normalizeKeyEntry, maskKeys, maskKeyEntry, maskKey,
  loadModelsDev, saveModelsDevCache, cacheAgeMs, downloadCatalog, ensureCatalog, findJustget,
  mapModelsDevModel, findModelsDevProvider, resolveMdForUpsert, resetCatalogForceGap, crossProviderModelMeta,
  loadAux, ensureAuxAll, modelListExtra, findOpenRouterModel, mapOpenRouterModel, findLiteLlmEntry, mapLiteLlmModel, isOpenRouterBase, updateAuxFromScan, auxBackfillWithRetry,
  loadChinaCatalog, buildIndex, searchProviders,
  normalizeBaseUrl, reverseMatch, reverseDetect, extractUrls, detectBrands, probeOpenApi, brandFromText, brandFromModels,
  detectApi, endpointApiHint, normalizeBaseForApi, testConnection, discoverModels, probeModelCap, knownMaxTokensCap, MODEL_MAX_OUTPUT_TOKEN_CORRECTIONS, resolveSecretValue, parseMaxTokensFromError, stripEndpointPath,
  loadModelsJson, saveModelsJson, loadModelsStore, modelsStorePath, providersStatus, modelParams, providerScanParams, upsertProvider, deleteProvider, upsertProviderData, deleteProviderData, setModelOverrideData, getModelOverrides, comboPageData, comboSaveProviderData, modelsJsonPath, initPiRuntime, piReady, piError, runtimeEntries,
  extractDomain, buildDomainIndex, domainProviderGuess, resetDomainIndex, probeServerHeaders,
  stashUndo, loadUndo, restoreUndoData, undoPath,
  maskKey, maskHeaderValue, SENSITIVE_HEADER_RE, httpGet, httpPostJson, expandPath, fmtTime, fmtDur,
  loadReminder, saveReminder, rollReminder, snapshotProvider, removeReminderProvider, computeNewModels, newModelsForProvider, toastDecision, markToastShown, normModelIds, ackNewModels,
  lastTestPath, loadLastTest, recordLastTest, pickProviderCredential, runCheckup,
};