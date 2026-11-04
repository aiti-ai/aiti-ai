/**
 * aiti-model-check · 核心逻辑（CommonJS，Node 原生可跑）
 *
 * 职责：模型可用性探测 + 429 限流识别 + 可用时间识别。
 * 做法（类似 aiti-ai-input 的 suggest/selfInvoke 轻量直连）：读 ~/.pi/agent/models.json，
 * 对每个 model 用 OpenAI 兼容接口发一条极小探针消息（"ping" → 期望回 "ok"），
 * 看返回：200=可用 / 429=限流（解析 Retry-After、X-RateLimit-Reset、错误提示 → 预测恢复时间）
 *        / 其它错误。每次探测追加记录到 history.jsonl，汇总写 state.json。
 * 设计：docs/aiti-model-check-extension-plan.md
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");

// ---------------- 常量 ----------------
const PROBE_SYSTEM = "Reply with exactly one word: ok";
const PROBE_USER = "ping";

const DEFAULT_CONFIG = {
  modelsPath: "~/.pi/agent/models.json",
  modelsStorePath: "~/.pi/agent/models-store.json",
  fallbackToStore: false, // 默认不回退 store：只探测 models.json 显式配置的模型；true=对 models 为 null 的 provider 补全（如 opencode-go）
  apiVariants: { "ark-coding-cn": ["anthropic-messages", "openai-responses"] }, // 同套餐多 API 形式（火山 coding 套餐 OpenAI/Anthropic/Responses 三种）
  probe: { timeoutMs: 15000, concurrency: 2, maxTokens: 8, perKey: true }, // perKey=true 时对配了多 key 的 provider 分 key 检查
  // 订阅登录型（OAuth）provider（qoder/github-copilot 等，凭据在 auth.json）：默认在模型清单里一并列出并做
  // provider 级订阅状态检查（qoder 查配额余量）；false=不合并（与旧行为一致，只显示 models.json 里的）。
  subscriptions: { enabled: true },
  watch: { enabled: false, intervalSec: 60, onlyNotOk: true, farThresholdMin: 30, farFactor: 30 }, // 默认关闭自动哨兵；用户点击/调用 model_probe 时才探测
  history: { maxEntriesPerModel: 500 },
  state: { windowSize: 20 }, // 每个 model 在 state 里保留的最近探测条数（时间线展示用）
  // 运行期监测：agent 实际执行中被大量 429/限流错误阻断时 → 标记该模型不可用（通知模型检查）。
  // 判定规则（防临时出错误标）：一次执行里累计 429/限流错误 ≥ minBlockCount（大量）且该次执行最终被阻断（任务中断/失败）才标记；
  // 只出现一两次 429 但重试成功、执行正常完成 → 不标记。pattern 匹配 auto_retry_start/最终错误消息里的限流文案。
  // proxyLog=true 时另启用「带外观测」：tail pi-models-combo 代理日志（key-requests-*.jsonl）的
  // 非 2xx/3xx 行（429 限流/402 欠费/401 key 无效/5xx…，带 key 归因，含聚合组成员）→ state.runtimeErrors
  // （1h/24h 窗口 + 按状态分类），只提示不标记，探测才是权威。
  runtime: { enabled: true, minBlockCount: 3, proxyLog: true, pattern: "429|rate.?limit|too many requests|overloaded|insufficient_quota|quota|billing|retry delay|try your request again|exceeded request buffer|exhausted|usage limit|resets in" },
  // 限流到期提醒（recover）：纯本地时间检查（零探测）——对已持续限流 ≥ minLimitedHours 的模型，
  // 在其 429 记录的预计恢复时间（predictedAvailableAt）到点时提醒用户去手动验证（点「测」）。
  // providers/models：逐 provider / 逐模型开关覆盖（模型级 > provider 级 > notifyDefault）。
  recover: { enabled: true, minLimitedHours: 72, notifyDefault: true, checkIntervalSec: 1800, providers: {}, models: {} },
};

// ---------------- 工具 ----------------
function expandPath(p) {
  if (!p) return p;
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}
function now() { return Date.now(); }
function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 距现在较远的恢复时间显示带日期（如 "08-24 08:00"），近的只显示时分秒
function fmtPredict(ts, nowMs = Date.now()) {
  if (!ts) return "未知";
  if (ts - nowMs > 6 * 3600 * 1000) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return fmtTime(ts);
}
function fmtDuration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  if (ms < 3600000) return Math.round(ms / 60000) + "min";
  const h = ms / 3600000;
  if (h < 48) return (Math.round(h * 10) / 10) + "h";
  const d = Math.floor(h / 24);
  const hr = Math.round(h % 24);
  return d + " 天 " + (hr || 0) + " 小时";
}

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
  } catch (e) { /* 无配置 → 默认 */ }
  return cfg;
}
function saveConfig(cfg, configDir) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const { _file, ...rest } = cfg;
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(rest, null, 2) + "\n");
    return true;
  } catch (e) { return false; }
}
/** 读盘上原始用户配置（不合并 DEFAULT_CONFIG）——写回局部字段时用，避免把默认值固化进用户配置。 */
function loadUserConfig(configDir) {
  try { return JSON.parse(fs.readFileSync(path.join(configDir || "", "config.json"), "utf8")) || {}; } catch (e) { return {}; }
}

// ---------------- 多 keys（models.json 的 provider.apiKeys，与 aiti-model-wizard / 代理同源） ----------------
// apiKeys 存于 models.json 的 provider 配置里：providers.<p>.apiKeys = [{name, key, rpm?}]。
// TypeBox 1.3.7 对未知属性放行（实证），pi 加载不报错；运行时只取 apiKey/baseUrl，apiKeys 不上行。
// 由 aiti-model-wizard 写入，本扩展只读（分 key 检查）。
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
  return { name: String(k.name || "key"), key: String(k.key || ""), rpm, minIntervalMs };
}
/** 某 provider 的 keys 数组（无则 []；key 名唯一化；从 models.json provider.apiKeys 读） */
function getProviderKeys(cfg, provider) {
  const file = expandPath(cfg.modelsPath || "~/.pi/agent/models.json");
  let prov = null;
  try { prov = (JSON.parse(fs.readFileSync(file, "utf8")).providers || {})[provider]; } catch (e) {}
  const keys = prov && prov.apiKeys;
  const arr = Array.isArray(keys) ? keys.map(normalizeKeyEntry).filter(Boolean) : [];
  // 同名去重（保留第一个，补序号）；无 name 时生成 key-<i>
  const seen = new Set();
  const out = [];
  for (const k of arr) {
    let n = k.name || "key";
    if (seen.has(n)) { let i = 2; while (seen.has(n + "-" + i)) i++; n = n + "-" + i; }
    seen.add(n); out.push({ ...k, name: n });
  }
  return out;
}

// ---------------- 模型清单 ----------------
// ---------------- pi 模型注册表（ModelRuntime） ----------------
// 用 pi 官方 API 拿模型清单：models.json + models-store.json 目录自动合并（opencode-go 的 19 个、
// zai-coding-cn 的真实 baseUrl+5 个模型都是目录里来的）、baseUrl 规范化、每个模型自己的 api 类型。
// 探测仍走本文件轻量直连（key 从 models.json 读——pi 认证体系不含 models.json 明文 key）。
let _piRT = null;
let _piErr = "";
// 从进程 cwd（pi-web/pi-prod）向上找 @earendil-works/pi-coding-agent 包目录（扩展目录自身没有该依赖）
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
  try {
    const pkgDir = findPiPackage();
    if (!pkgDir) throw new Error("找不到 @earendil-works/pi-coding-agent（从 cwd 向上找 node_modules）");
    // 0.84.2 exports 只有 import 条件（无 require），CJS require 解析失败 → 用动态 import()（ESM 语义）
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const entry = (pkg.exports && pkg.exports["."] && (pkg.exports["."].import || pkg.exports["."].default)) || pkg.main || "dist/index.js";
    const { pathToFileURL } = require("node:url");
    const mod = await import(pathToFileURL(path.join(pkgDir, entry)).href);
    const ModelRuntime = mod.ModelRuntime || (mod.default && mod.default.ModelRuntime);
    if (!ModelRuntime) throw new Error("pi-coding-agent 无 ModelRuntime 导出");
    _piRT = await ModelRuntime.create({
      refreshOnCreate: false, // 离线：只用本地 models.json + models-store.json 缓存 + 内置目录，不触发网络目录刷新
      modelsPath: expandPath(cfg.modelsPath || "~/.pi/agent/models.json"),
      modelsStorePath: expandPath(cfg.modelsStorePath || "~/.pi/agent/models-store.json"),
    });
    _piErr = "";
  } catch (e) {
    _piRT = null;
    _piErr = String((e && e.message) || e);
  }
  return _piRT;
}
function piReady() { return !!_piRT; }
function piError() { return _piErr; }

// api 变体后缀（同套餐多 API 形式）：provider 名加后缀区分，如 ark-coding-cn-anthropic
const V_API_SUFFIX = { "openai-completions": "openai", "anthropic-messages": "anthropic", "openai-responses": "responses" };
// 给指定 provider 的条目追加 api 变体（如火山 coding 套餐三种 API 形式）
function appendApiVariants(entries, cfg, pName) {
  const variants = (cfg.apiVariants && cfg.apiVariants[pName]) || [];
  if (!variants.length) return;
  const base = entries.filter((e) => e.provider === pName);
  for (const vApi of variants) {
    const suffix = V_API_SUFFIX[vApi] || vApi.replace(/[^a-z0-9]/gi, "");
    for (const e of base) {
      entries.push(Object.assign({}, e, { provider: pName + "-" + suffix, api: vApi, source: e.source + "-variant" }));
    }
  }
}

// 生效模型清单解析（store 兜底/runtime 覆盖）用工作区共享实现：部署时拷到扩展目录，仓内测试回退相对路径
let resolveProviderModels;
try { ({ resolveProviderModels } = require("./effective-models.cjs")); }
catch { ({ resolveProviderModels } = require("../shared/effective-models.cjs")); }

// 组合模型（combo:true provider）标注：🧩 成员构成 + 引擎路由标记（不直接探测）
function markComboEntries(entries, provCfg, pName) {
  if (!provCfg || provCfg.combo !== true) return;
  for (const e of entries) {
    if (e.provider !== pName || e.combo) continue;
    const md = (Array.isArray(provCfg.models) ? provCfg.models : []).find((m) => m && String(m.id || m.model || "") === String(e.modelId || e.model));
    if (!md || !md.combo) continue;
    const mem = Array.isArray(md.combo.members) ? md.combo.members : [];
    e.combo = true;
    e.comboMembers = mem.map((r) => String(r.provider) + "/" + String(r.model) + (r.weight != null && r.weight !== 10 ? " ×" + r.weight : ""));
    if (md.combo.stickyTtlMin) e.comboTtl = md.combo.stickyTtlMin;
  }
}

function loadModels(cfg) {
  const file = expandPath(cfg.modelsPath || "~/.pi/agent/models.json");
  let provCfg = {};
  try { provCfg = (JSON.parse(fs.readFileSync(file, "utf8")).providers) || {}; } catch (e) {}

  // pi ModelRuntime 快照条目（可选）：扩展 startup 时建；未就绪 → 纯静态解析
  let runtimeEntries = null;
  if (_piRT) {
    try {
      for (const pName of Object.keys(provCfg)) {
        const ms = _piRT.getModels(pName) || [];
        for (const m of ms) {
          (runtimeEntries = runtimeEntries || []).push({
            provider: pName, id: String(m.id), api: m.api,
            baseUrl: String(m.baseUrl || ""), reasoning: !!m.reasoning,
          });
        }
      }
    } catch (e) { runtimeEntries = null; }
  }
  const store = (cfg.fallbackToStore !== false)
    ? (() => { try { return JSON.parse(fs.readFileSync(expandPath(cfg.modelsStorePath || "~/.pi/agent/models-store.json"), "utf8")); } catch (e) { return null; } })()
    : null;

  // 共享解析：显式 models > store 补全；runtime 快照存在时以其为主、显式补缺漏
  const resolved = resolveProviderModels({ providers: provCfg, store, runtime: runtimeEntries });

  const entries = [];
  for (const pName of Object.keys(provCfg)) {
    const pCfg = provCfg[pName] || {};
    const entry = resolved.get(pName);
    if (!entry || entry.models.length === 0) continue; // 无可用模型 → 跳过（原行为）
    const apiKey = pCfg.apiKey || (pCfg.apiKeyEnv ? process.env[pCfg.apiKeyEnv] : "") || "";
    const keys = (cfg.probe && cfg.probe.perKey === false) ? [] : getProviderKeys(cfg, pName);
    // 探测走 models.json 里的原始 baseUrl：pi 包（如 pi-models-combo 的多 key 轮换代理）会经
    // registerProvider 把 baseUrl 改写成 http://127.0.0.1:<port>/，运行时返回的 m.baseUrl 已被
    // 覆盖——拿真实 key 打内部代理只会得到 401 unauthorized。provider 显式配置的地址优先。
    for (const m of entry.models) {
      const base = String(pCfg.baseUrl || "").trim() || m.baseUrl || "";
      if (!base) continue; // 无地址无法探测（原行为）
      entries.push({
        provider: pName,
        model: m.id,
        modelId: m.id,
        api: m.api,
        baseUrl: base,
        apiKey: pCfg.combo === true ? "" : apiKey, // combo provider 不持有真实 key（成员 key 在引擎内注入）
        keys: pCfg.combo === true ? [] : keys,
        reasoning: !!m.reasoning,
        source: m._source === "pi" ? "pi" : "models.json",
    ...(pCfg.combo === true ? (() => {
        const rawDef = (Array.isArray(pCfg.models) ? pCfg.models : []).find((x) => x && String(x.id || x.model || "") === String(m.id));
        const mem = rawDef && rawDef.combo && Array.isArray(rawDef.combo.members) ? rawDef.combo.members.map((r) => String(r.provider) + "/" + String(r.model) + (r.weight != null && r.weight !== 10 ? " ×" + r.weight : "")) : [];
        return { combo: true, comboMembers: mem, ...(rawDef && rawDef.combo && rawDef.combo.stickyTtlMin ? { comboTtl: rawDef.combo.stickyTtlMin } : {}) };
      })() : {}),
      });
    }
    appendApiVariants(entries, cfg, pName);
  }
  // 订阅登录型（OAuth）provider 合并：qoder/qoder-cn/github-copilot 等凭据在 auth.json，不写 models.json，
  // 但模型检查同样要列出它们（含 provider 级订阅状态检查）。cfg.subscriptions.enabled=false 可关。
  if (!cfg.subscriptions || cfg.subscriptions.enabled !== false) {
    entries.push(...loadSubscriptionEntries(Object.keys(provCfg)));
  }
  const runtimeMode = _piRT ? "pi" : "fallback";
  return { ok: true, file, entries, runtime: runtimeMode, piError: _piErr };
}

// ---------------- 订阅登录型（OAuth）provider 支持 ----------------
// 订阅型（如 qoder/qoder-cn/github-copilot/kimi-coding…）凭据在 ~/.pi/agent/auth.json（OAuth/设备码登录），
// 不写 models.json；模型向导在「订阅服务」tab 管理登录。模型检查同样要列出它们：
//   - 模型清单：pi ModelRuntime（github-copilot/kimi-coding 等内置）+ 模型向导国内目录（qoder/qoder-cn）
//   - 探测方式：协议特殊（qoder 用 WASM 加密信封 / github 走 Copilot 引擎 + 模型 id 映射），
//     不直接发标准探针（发错端点/模型名会误报「异常」）；改为 provider 级「订阅状态」轻查
//     （qoder 查 openapi 配额余量；其余凭据存在即视为已登录，由引擎接入）。
function loadAuthCredentials() {
  try {
    const p = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8")) || {};
  } catch (e) { return {}; }
}
let _cnCatCache = { mtime: 0, data: null };
function loadChinaCatalogForModelCheck() {
  // 尽力读模型向导的国内目录（qoder/qoder-cn 模型唯一来源）；读不到返回 null（只出 pi 运行时模型）
  try {
    const cands = [
      path.join(__dirname, "..", "aiti-model-wizard", "china-catalog.json"),
      path.join(path.dirname(path.dirname(__dirname)), "aiti-model-wizard", "china-catalog.json"),
    ];
    for (const f of cands) {
      if (fs.existsSync(f)) {
        const st = fs.statSync(f);
        if (_cnCatCache.mtime === st.mtimeMs && _cnCatCache.data) return _cnCatCache.data;
        const d = JSON.parse(fs.readFileSync(f, "utf8"));
        const providers = (d && d.providers) || {};
        _cnCatCache = { mtime: st.mtimeMs, data: providers };
        return providers;
      }
    }
  } catch (e) {}
  return null;
}
/** qoder 订阅状态检查端点（Bearer access 直连官方 openapi；与模型向导 oauth-info 同源） */
function subscriptionCheckInfo(id, cred) {
  if (id === "qoder") return { kind: "qoder-quota", baseUrl: "https://openapi.qoder.sh", apiKey: (cred && cred.access) || "" };
  if (id === "qoder-cn") return { kind: "qoder-quota", baseUrl: "https://openapi.qoder.com.cn", apiKey: (cred && cred.access) || "" };
  return { kind: "oauth-login", baseUrl: "", apiKey: "" };
}
/** 收集已登录的订阅 provider 条目（models 不直接探测，标记 notProbeable；供列出 + 订阅状态检查）。 */
function loadSubscriptionEntries(configuredIds) {
  const out = [];
  const auth = loadAuthCredentials();
  if (!Object.keys(auth).length) return out;
  const known = new Set(Array.isArray(configuredIds) ? configuredIds : []);
  const catalog = loadChinaCatalogForModelCheck();
  for (const [id, v] of Object.entries(auth)) {
    if (!v || !(v.type === "oauth" || v.access)) continue;
    if (known.has(id)) continue; // 已在 models.json 配置（如 openrouter）→ 走 token 型路径
    // 模型：pi 运行时（github-copilot/kimi-coding…）∪ 国内目录（qoder/qoder-cn）
    let piModels = [];
    if (_piRT) { try { piModels = _piRT.getModels(id) || []; } catch (e) {} }
    const cnModels = (catalog && catalog[id] && Array.isArray(catalog[id].models)) ? catalog[id].models : [];
    const seen = new Set(); const ids = [];
    for (const m of piModels) { const mid = m && m.id; if (mid && !seen.has(mid)) { seen.add(mid); ids.push(mid); } }
    for (const m of cnModels) { const mid = typeof m === "string" ? m : (m && (m.id || m.model || m.name)); if (mid && !seen.has(mid)) { seen.add(mid); ids.push(mid); } }
    if (!ids.length) continue; // 无已知模型（既不在 pi 运行时也不在目录）→ 不列出
    const info = subscriptionCheckInfo(id, v);
    for (const mid of ids) {
      out.push({
        provider: id, model: mid, modelId: mid,
        api: "openai-completions", baseUrl: info.baseUrl || "", apiKey: info.apiKey || "",
        keys: [], reasoning: false,
        source: "oauth", subscription: true, notProbeable: true, subKind: info.kind,
      });
    }
  }
  return out;
}
/** provider 级订阅状态检查：qoder 查 openapi 配额余量（Bearer access）；其余凭据存在即已登录。 */
async function checkSubscription(entry, cfg, opts = {}) {
  const t0 = now();
  const timeoutMs = opts.timeoutMs || (cfg && cfg.probe && cfg.probe.timeoutMs) || 10000;
  const id = entry.provider;
  const fail = (label, error) => ({ provider: id, ok: false, label, text: "", error, checkedAt: now(), latencyMs: now() - t0 });
  if (entry.subKind === "qoder-quota") {
    if (!entry.apiKey) return fail("未登录", "auth.json 无 " + id + " 的 access 凭据（需在模型向导「订阅服务」登录）");
    try {
      const res = await fetch(entry.baseUrl + "/api/v2/quota/usage", {
        method: "GET", headers: { authorization: "Bearer " + entry.apiKey }, signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.text().catch(() => "");
      if (res.status === 200) {
        let j = null; try { j = JSON.parse(body); } catch (e) {}
        const q = j && j.userQuota;
        if (q && q.remaining != null) {
          const exhausted = !!j.isQuotaExceeded || Number(q.remaining) <= 0;
          return { provider: id, ok: true, label: exhausted ? "额度用尽" : "订阅有效", text: q.remaining + " " + (q.unit || "credits") + " 剩余" + (q.total != null ? " / " + q.total : ""), credits: q.remaining, exhausted, checkedAt: now(), latencyMs: now() - t0 };
        }
        return fail("查询失败", "quota 响应异常：" + String((j && (j.error || j.message)) || body || "").slice(0, 120));
      }
      if (res.status === 401 || res.status === 403) return fail("凭据失效", "HTTP " + res.status + "（" + id + " 登录已过期，需在模型向导重新登录）");
      return fail("查询失败", "HTTP " + res.status + " · " + body.slice(0, 120));
    } catch (e) {
      const abort = /abort|timeout/i.test(String((e && e.message) || ""));
      return fail("网络不通", abort ? "timeout(" + timeoutMs + "ms)" : String((e && e.message) || e).slice(0, 120));
    }
  }
  // oauth-login：凭据存在即视为已登录（模型接入由 pi/厂商引擎负责，非标准探针可达；真实验证在引擎接入时发生）
  return { provider: id, ok: true, label: "已登录", text: "OAuth 凭据在档 · 由引擎接入时校验", checkedAt: now(), latencyMs: 0 };
}

// ---------------- 探测 ----------------
// ---------------- x-opencode-session 自学习（Console Go 等要求该头做 prompt cache 路由） ----------------
// 上游 host 命中（opencode.ai / *.opencode.ai，或曾报 MissingSessionID 被学习）→ 探测请求自动注入该头。
// 学习标记为模块级全局：进程内后续探测直接带头，不再依赖错误触发（与 pi-models-combo 代理同语义）。
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
  try { return require("node:crypto").randomUUID(); } catch (e) { return "probe-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
}

function buildRequest(entry, cfg) {
  const api = entry.api || "openai-completions";
  const baseUrl = (entry.baseUrl || "").replace(/\/+$/, "");
  const headers = { "content-type": "application/json" };
  if (entry.apiKey) headers.authorization = "Bearer " + entry.apiKey;
  if (api === "anthropic-messages") {
    // baseUrl 已含版本段（如 .../api/plan/v3）则直接拼 /messages，否则补 /v1
    const base = /\/v\d+$/.test(baseUrl) ? baseUrl : baseUrl + "/v1";
    headers["anthropic-version"] = "2023-06-01";
    if (entry.apiKey) { delete headers.authorization; headers["x-api-key"] = entry.apiKey; }
    return { url: base + "/messages", headers, body: { model: entry.modelId, max_tokens: Math.max(4, cfg.probe.maxTokens || 8), messages: [{ role: "user", content: PROBE_USER + " " + PROBE_SYSTEM }] } };
  }
  if (api === "openai-responses") {
    return { url: baseUrl + "/responses", headers, body: { model: entry.modelId, max_output_tokens: Math.max(4, cfg.probe.maxTokens || 8), input: PROBE_USER + " " + PROBE_SYSTEM } };
  }
  // openai-completions（默认）
  return { url: baseUrl + "/chat/completions", headers, body: { model: entry.modelId, max_tokens: Math.max(4, cfg.probe.maxTokens || 8), temperature: 0, messages: [{ role: "system", content: PROBE_SYSTEM }, { role: "user", content: PROBE_USER }] } };
}

function extractResponseText(api, data) {
  try {
    if (api === "anthropic-messages") {
      const c = data && data.content;
      if (Array.isArray(c)) return c.map((x) => x && x.text).filter(Boolean).join(" ").trim();
      return "";
    }
    if (api === "openai-responses") {
      if (data && data.output_text) return String(data.output_text).trim();
      const out = data && data.output;
      if (Array.isArray(out)) {
        const parts = out.map((o) => {
          const cs = o && o.content;
          if (Array.isArray(cs)) return cs.map((x) => x && (x.text || "")).join("");
          return "";
        });
        return parts.filter(Boolean).join(" ").trim();
      }
      return "";
    }
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (msg && msg.content) return String(msg.content).trim();
    // 推理模型常把 token 全耗在 reasoning_content 上、content 为空 → 回退展示推理片段，说明模型活着
    if (msg && msg.reasoning_content) return "(reasoning) " + String(msg.reasoning_content).trim().slice(0, 60);
    return "";
  } catch (e) { return ""; }
}

// 从 429 响应解析限流信息：Retry-After（秒 / HTTP 日期）、X-RateLimit-Reset、错误提示
function extractRateLimit(res, bodyText) {
  const rl = { retryAfterSec: undefined, resetAt: undefined, remaining: undefined, hint: "" };
  try {
    const get = (k) => { try { return res.headers.get(k); } catch (e) { return null; } };
    const retryAfter = get("retry-after");
    if (retryAfter) {
      if (/^\d+$/.test(retryAfter.trim())) rl.retryAfterSec = parseInt(retryAfter.trim(), 10);
      else { const d = Date.parse(retryAfter); if (!isNaN(d)) rl.resetAt = d; }
    }
    const reset = get("x-ratelimit-reset") || get("x-ratelimit-reset-models") || get("ratelimit-reset");
    if (reset != null) {
      const n = Number(String(reset).trim());
      if (!isNaN(n)) rl.resetAt = n > 1e12 ? n : n * 1000; // unix 秒或毫秒
    }
    const remaining = get("x-ratelimit-remaining") || get("x-ratelimit-remaining-models");
    if (remaining != null) { const r = Number(String(remaining).trim()); if (!isNaN(r)) rl.remaining = r; }
    // 错误提示：优先 JSON error.message/type/code，其次原文
    let text = String(bodyText || "");
    try {
      const j = JSON.parse(text);
      const e = j && j.error;
      rl.hint = (e && (e.message || e.type || e.code)) || j.message || "";
      if (!rl.hint && e && typeof e === "object") rl.hint = JSON.stringify(e).slice(0, 140);
      if (!rl.hint && j.error) rl.hint = String(j.error).slice(0, 140);
    } catch (e2) { rl.hint = text.slice(0, 140); }
    rl.hint = String(rl.hint || "").trim();
    // 中文提示里的明确重置时间："限额将在 2026-08-22 16:35:11 重置"（智谱等）
    if (!rl.resetAt) {
      const m = rl.hint.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
      if (m) { const d = Date.parse(m[1] + "T" + m[2]); if (!isNaN(d)) rl.resetAt = d; }
    }
  } catch (e) {}
  return rl;
}

// ---------------- 错误统一分类（HTTP 状态 → 精准中文原因） ----------------
// 单一事实来源：probe / UI / MCP 工具统一用这套分类，不再笼统显示"异常"。
// 各状态码语义经联网核对（OpenAI / Anthropic / DeepSeek 错误文档 + GitHub issue 实测确认）：
//   402 = Insufficient Balance 欠费/余额不足（DeepSeek 官方实测返回 "402 Insufficient Balance"）
//   401 = API key/token 无效、缺失、格式错（AuthenticationError）
//   403 = key 无权限 / 地区 / 组织限制（PermissionError）
//   404 = 模型名不存在 / 端点拼错（ModelNotFound / NotFound）
//   429 = 频率或配额限流（含恢复时间预测，单独处理）
//   5xx = 服务端过载 / 故障；网络/超时 = 连不上 / 探测超时
const KIND_META = {
  ok:         { label: "可用",     color: "#16a34a" },
  auth:       { label: "key 不对", color: "#dc2626" },   // 401 token/API key 无效/缺失/格式错
  billing:    { label: "欠费",     color: "#dc2626" },   // 402 余额不足 / 欠费（DeepSeek/Anthropic）
  permission: { label: "无权限",   color: "#d97706" },   // 403
  region:     { label: "模型不可用", color: "#d97706" },   // 403 该模型在所在地区不可用（Google 等）
  notfound:   { label: "不存在",   color: "#d97706" },   // 404 模型名/端点
  badreq:     { label: "请求错误", color: "#d97706" },   // 400 / 422
  rate:       { label: "限流",     color: "#dc2626" },   // 429
  server:     { label: "服务端错", color: "#d97706" },   // 5xx
  network:    { label: "网络不通", color: "#d97706" },
  timeout:    { label: "超时",     color: "#d97706" },
  other:      { label: "异常",     color: "#d97706" },
};

/** 按 HTTP 状态码 + 错误体关键词统一分类（关键词仅在状态码缺失时兜底，避免误判）。 */
function classifyHttp(status, bodyText) {
  const s = Number(status) || 0;
  const t = String(bodyText || "").slice(0, 500).toLowerCase();
  const has = (re) => re.test(t);
  const R_BILLING = /insufficient[ _-]?(balance|quota)|payment required|billing|balance\b|已?欠费|余额不足|额度不足|account.{0,20}(suspend|debt|arrears)|credit.{0,10}(insufficient|exhausted)/;
  const R_AUTH = /invalid.{0,10}api[ _-]?key|incorrect.{0,10}api[ _-]?key|authentication|unauthorized|api[ _-]?key.{0,20}(invalid|missing|expired|wrong)|no api[ _-]?key|token.{0,10}(invalid|expired|wrong|missing)|not authenticated/;
  const R_PERM = /forbidden|permission|not allowed|access denied|not permitted/;
  const R_NOTFOUND = /model.{0,15}(not found|does not exist)|no such model|unknown model|endpoint.{0,10}(not found|does not exist)|resource not found|not found/;
  const R_BADREQ = /bad request|invalid.{0,10}(request|parameter|argument|json|payload)|unprocessable|invalid_prompt/;
  if (s >= 200 && s < 300) return { kind: "ok", ...KIND_META.ok };
  if (s === 429) return { kind: "rate", ...KIND_META.rate };
  if (s === 401) return { kind: "auth", ...KIND_META.auth };
  if (s === 402) return { kind: "billing", ...KIND_META.billing };
  if (s === 403) {
    // 403 细分：模型在所在地区不可用（Google 等 region 限制）vs 通用无权限
    if (has(/region|not available in your (region|area|country|location)|geo[- ]?(block|restrict)|in your country/)) return { kind: "region", ...KIND_META.region };
    return { kind: "permission", ...KIND_META.permission };
  }
  if (s === 404) return { kind: "notfound", ...KIND_META.notfound };
  if (s === 400 || s === 422) return { kind: "badreq", ...KIND_META.badreq };
  if (s >= 500 && s < 600) return { kind: "server", ...KIND_META.server };
  if (s >= 300 && s < 400) return { kind: "other", ...KIND_META.other };
  // 状态码 0/缺失：按错误体关键词兜底
  if (R_BILLING.test(t)) return { kind: "billing", ...KIND_META.billing };
  if (R_AUTH.test(t)) return { kind: "auth", ...KIND_META.auth };
  if (R_PERM.test(t)) return { kind: "permission", ...KIND_META.permission };
  if (/region|not available in your (region|area|country|location)|geo[- ]?(block|restrict)/.test(t)) return { kind: "region", ...KIND_META.region };
  if (R_NOTFOUND.test(t)) return { kind: "notfound", ...KIND_META.notfound };
  if (R_BADREQ.test(t)) return { kind: "badreq", ...KIND_META.badreq };
  return { kind: "other", ...KIND_META.other };
}

function makeErrorEntry(entry, err) {
  const ms = now();
  const msg = String((err && err.message) || err || "unknown").slice(0, 200);
  const c = classifyHttp(0, msg); // 状态码 0 → 按文本兜底（network/timeout 由调用处覆盖）
  return {
    ts: ms, provider: entry.provider, model: entry.model, modelId: entry.modelId,
    ok: false, status: 0, latencyMs: 0, text: "", error: msg,
    kind: c.kind, label: c.label, rateLimit: null, predictedAvailableAt: null, baseUrl: entry.baseUrl || "",
  };
}

async function probeOneKey(entry, cfg, opts = {}) {
  const t0 = now();
  const timeoutMs = opts.timeoutMs || cfg.probe.timeoutMs || 10000;
  const req = buildRequest(entry, cfg);
  const preHeader = wantsOcSession(req.url);
  if (preHeader) req.headers["x-opencode-session"] = ocSessionId();
  let res;
  try {
    res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = makeErrorEntry(entry, err);
    e.latencyMs = now() - t0;
    if (String((err && err.name) || "") === "TimeoutError" || /abort|timeout/i.test(String(err && err.message || ""))) {
      e.error = "timeout(" + timeoutMs + "ms)"; e.kind = "timeout"; e.label = KIND_META.timeout.label;
    } else {
      e.error = "network: " + (err && err.message || err); e.kind = "network"; e.label = KIND_META.network.label;
    }
    return e;
  }
  let bodyText = await res.text().catch(() => "");
  // MissingSessionID 自学习：本次没带头 + 400 且错误体点名缺头 → 学习 host（全局标记，
  // 进程内后续探测直接带头）并带头重发一次，重发结果作为本次探测结论。
  if (res.status === 400 && !preHeader && isMissingSessionErr(bodyText)) {
    try { ocSessionLearnedHosts.add(new URL(req.url).hostname); } catch (e) {}
    try {
      res = await fetch(req.url, {
        method: "POST",
        headers: { ...req.headers, "x-opencode-session": ocSessionId() },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      bodyText = await res.text().catch(() => "");
    } catch (err) {
      const e = makeErrorEntry(entry, err);
      e.latencyMs = now() - t0;
      if (String((err && err.name) || "") === "TimeoutError" || /abort|timeout/i.test(String(err && err.message || ""))) {
        e.error = "timeout(" + timeoutMs + "ms)"; e.kind = "timeout"; e.label = KIND_META.timeout.label;
      } else {
        e.error = "network: " + (err && err.message || err); e.kind = "network"; e.label = KIND_META.network.label;
      }
      return e;
    }
  }
  const latencyMs = now() - t0;
  const entry2 = {
    ts: now(), provider: entry.provider, model: entry.model, modelId: entry.modelId,
    ok: res.status >= 200 && res.status < 300, status: res.status, latencyMs,
    text: "", error: "", kind: "", label: "", rateLimit: null, predictedAvailableAt: null, baseUrl: entry.baseUrl || "",
  };
  if (entry2.ok) {
    const c = classifyHttp(res.status, bodyText);
    entry2.kind = c.kind; entry2.label = c.label;
    try { entry2.text = extractResponseText(entry.api || "openai-completions", JSON.parse(bodyText)).slice(0, 80); }
    catch (e) { entry2.text = ""; }
  } else if (res.status === 429) {
    entry2.rateLimit = extractRateLimit(res, bodyText);
    const rl = entry2.rateLimit;
    // 恢复时间只信「未来的」：已过点（reset 头过期/失效）或 retry-after≤0 都视为没查到，不写入、不显示
    const future = now();
    if (rl.resetAt && rl.resetAt > future) entry2.predictedAvailableAt = rl.resetAt;
    else if (rl.retryAfterSec != null && rl.retryAfterSec > 0) entry2.predictedAvailableAt = future + rl.retryAfterSec * 1000;
    entry2.kind = "rate"; entry2.label = KIND_META.rate.label;
    entry2.error = ("429 " + (rl.hint || "rate-limited")).trim().slice(0, 200);
  } else {
    const c = classifyHttp(res.status, bodyText);
    entry2.kind = c.kind; entry2.label = c.label;
    entry2.error = (res.status + " " + bodyText).trim().slice(0, 200);
  }
  return entry2;
}

// 多 key 分 key 检查：对配了多个 key 的 provider，逐个 key 探测并聚合。
// 聚合规则：任一 key 成功 → 模型整体 ok（perKey 保留各 key 详情）；全部失败 → 有 429 归类"限流"（key 有效只是限流），
// 否则取最说明问题的失败（auth 优先），供分 key 定位坏 key。
async function probeOne(entry, cfg, opts = {}) {
  const keys = (Array.isArray(entry.keys) ? entry.keys : []).filter((k) => k && k.key);
  if (keys.length <= 1 || (cfg.probe && cfg.probe.perKey === false)) {
    return probeOneKey(entry, cfg, opts); // 单 key / 无 key：原路径，格式不变
  }
  const perKey = [];
  let anyOk = false, firstOk = null, firstFail = null, rateFail = null, authFail = null;
  for (const k of keys) {
    const e = { ...entry, apiKey: k.key, keyName: k.name };
    const r = await probeOneKey(e, cfg, opts);
    r.keyName = k.name;
    perKey.push(r);
    if (r.ok) { anyOk = true; if (!firstOk) firstOk = r; }
    else { if (!firstFail) firstFail = r; if (r.status === 429 && !rateFail) rateFail = r; if (r.kind === "auth" && !authFail) authFail = r; }
  }
  const avgLatency = Math.round(perKey.reduce((s, r) => s + (r.latencyMs || 0), 0) / perKey.length);
  const agg = {
    ts: now(), provider: entry.provider, model: entry.model, modelId: entry.modelId,
    ok: anyOk,
    status: anyOk ? (firstOk && firstOk.status) || 200 : (firstFail ? firstFail.status : 0),
    latencyMs: avgLatency,
    text: anyOk && firstOk ? (firstOk.text || "") : "",
    error: "", kind: "", label: "", rateLimit: null, predictedAvailableAt: null,
    baseUrl: entry.baseUrl || "", perKey,
  };
  if (anyOk) {
    agg.kind = "ok"; agg.label = KIND_META.ok.label;
  } else if (rateFail) {
    agg.kind = "rate"; agg.label = "限流（全部 " + perKey.length + " 个 key 均 429）";
    agg.rateLimit = rateFail.rateLimit; agg.predictedAvailableAt = rateFail.predictedAvailableAt; agg.error = rateFail.error;
  } else if (authFail) {
    agg.kind = "auth"; agg.label = "key 不对"; agg.error = authFail.error;
  } else if (firstFail) {
    agg.kind = firstFail.kind || "other"; agg.label = firstFail.label || "异常"; agg.error = firstFail.error;
  }
  return agg;
}

// 并发池探测（限制并发，加快全量探测）
async function probeAll(entries, cfg, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || cfg.probe.concurrency || 4);
  const results = [];
  let idx = 0;
  const worker = async () => {
    while (idx < entries.length) {
      const e = entries[idx++];
      try { results.push(await probeOne(e, cfg, opts)); }
      catch (err) { results.push(makeErrorEntry(e, err)); }
    }
  };
  const n = Math.min(concurrency, Math.max(1, entries.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results.sort((a, b) => (a.provider + "/" + a.model).localeCompare(b.provider + "/" + b.model));
}

// 按 provider 逐个探测（并发池只在单个 provider 内部使用）：
// 一个 provider 探完 → 回调 onProviderDone(provider, results)（调用方可立即落盘/通知）→ 再探下一个。
// 避免一次全量探测（provider 多时）要等全部完成才有任何结果/状态更新。
async function probeByProvider(entries, cfg, opts = {}) {
  const onProviderDone = opts.onProviderDone || (() => {});
  const concurrency = Math.max(1, opts.concurrency || cfg.probe.concurrency || 4);
  const byProvider = {};
  for (const e of entries) (byProvider[e.provider] = byProvider[e.provider] || []).push(e);
  const order = Object.keys(byProvider).sort((a, b) => a.localeCompare(b));
  const all = [];
  for (const pName of order) {
    const pResults = await probeAll(byProvider[pName], cfg, { ...opts, concurrency });
    all.push(...pResults);
    try { await onProviderDone(pName, pResults); } catch (e) { /* 回调异常不中断后续 provider */ }
  }
  return all;
}

// ---------------- 记录 ----------------
/** cache 根：宿主 configDir = <extRoot>/config → <extRoot>/cache；否则（测试/独立）按传入目录下 cache/（2026-09-13 三目录对称）。 */
function cacheBase(configDir) {
  const p = configDir || "";
  return path.basename(p) === "config" ? path.join(path.dirname(p), "cache") : path.join(p, "cache");
}
function historyFile(configDir) { return path.join(cacheBase(configDir), "history.jsonl"); }
function stateFile(configDir) { return path.join(cacheBase(configDir), "state.json"); }

function recordHistory(configDir, results) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const f = historyFile(configDir);
    const lines = results.map((r) => JSON.stringify(r) + "\n").join("");
    fs.appendFileSync(f, lines);
    // 裁剪：每个 model 保留最近 maxEntriesPerModel 条
    trimHistory(configDir);
    return results.length;
  } catch (e) { return 0; }
}

function trimHistory(configDir, cfg) {
  try {
    const f = historyFile(configDir);
    if (!fs.existsSync(f)) return;
    const max = (cfg && cfg.history && cfg.history.maxEntriesPerModel) || 500;
    const byModel = {};
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        const k = e.provider + "/" + e.model;
        (byModel[k] = byModel[k] || []).push(line);
      } catch (e2) {}
    }
    const keep = [];
    for (const k of Object.keys(byModel)) keep.push(...byModel[k].slice(-max));
    const all = lines.map((l) => l);
    if (keep.length < all.length) fs.writeFileSync(f, keep.join("\n") + "\n");
  } catch (e) {}
}

function loadState(configDir) {
  try { return JSON.parse(fs.readFileSync(stateFile(configDir), "utf8")) || { updatedAt: 0, models: {} }; }
  catch (e) { return { updatedAt: 0, models: {} }; }
}
function saveState(configDir, state) {
  // 原子写：先写临时文件再 rename（POSIX 原子），避免并发读者（UI/loadState/轮询）读到半截 JSON。
  // 正式路径带 _ 前缀 → 与 stateFile() 返回的正式路径再拼同名 `.tmp`，同目录保证 rename 同文件系统。
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const f = stateFile(configDir);
    const tmp = path.join(configDir, path.basename(f) + ".tmp");
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
    fs.renameSync(tmp, f);
    return true;
  } catch (e) { return false; }
}

// 把一条探测结果并入 state（最近状态 + 滚动时间线 + 连续 429 计数 + 恢复记录）
function applyToState(state, e, cfg) {
  state.updatedAt = now();
  const k = e.provider + "/" + e.model;
  const m = state.models[k] || { provider: e.provider, model: e.model, lastProbedAt: 0, lastOk: null, lastStatus: 0, lastLatencyMs: 0, consecutive429: 0, rateLimited: false, predictedAvailableAt: null, lastText: "", lastError: "", recoveredAt: null, history: [] };
  m.lastProbedAt = e.ts;
  m.lastOk = e.ok;
  m.lastStatus = e.status;
  m.lastLatencyMs = e.latencyMs;
  if (e.ok) {
    m.consecutive429 = 0;
    m.rateLimited = false;
    m.predictedAvailableAt = null;
    m.lastText = e.text || "";
    m.lastError = "";
    // 若刚从限流恢复 → 记录可用时间；清除限流起点与到期提醒状态（recover 功能）
    if (m._wasLimited) { m.recoveredAt = e.ts; m._wasLimited = false; }
    m.limitedSince = null;
    m.alertAt = null;
    m.alertNotifiedAt = null;
  } else {
    m.lastText = "";
    m.lastError = e.error || "";
    if (e.status === 429) {
      m.rateLimited = true;
      m.consecutive429 = (m.consecutive429 || 0) + 1;
      // 限流起点：首次 429 记一次；持续限流期间保持不变（「已持续限流 ≥ 阈值」的判定基准）
      if (!m.limitedSince) m.limitedSince = e.ts;
      // 恢复时间只信本次探测解析到的（Retry-After / X-RateLimit-Reset / 错误体里的明确重置时间）；
      // 没解析到就清空，绝不保留/强加上一次的旧预测（旧预测已过点还在限流，无参考价值）。
      const pred = e.predictedAvailableAt || null;
      // 到期提醒登记：预测恢复时间变化 → 重新武装（清 notified）；同值不改动；无预测 → 清空
      if (pred !== (m.alertAt || null)) { m.alertAt = pred; m.alertNotifiedAt = null; }
      m.predictedAvailableAt = pred;
      m._wasLimited = true;
    } else {
      m.rateLimited = false;
      m.predictedAvailableAt = null;
    }
  }
  // 统一精准原因标签（lastKind/lastLabel 供 UI 与工具显示；history 每条也带）
  if (e.ok) { m.lastKind = "ok"; m.lastLabel = KIND_META.ok.label; }
  else if (e.kind && e.label) { m.lastKind = e.kind; m.lastLabel = e.label; }
  else { const c = classifyHttp(e.status, e.error || ""); m.lastKind = c.kind; m.lastLabel = c.label; }
  const win = (cfg && cfg.state && cfg.state.windowSize) || 20;
  m.history = [...(m.history || []), { ts: e.ts, ok: e.ok, status: e.status, latencyMs: e.latencyMs, text: e.text || "", error: e.error || "", kind: m.lastKind, label: m.lastLabel, predictedAvailableAt: e.predictedAvailableAt, perKey: e.perKey }].slice(-win);
  // 分 key 检查结果：每 key 最近状态（供“分 key 检查”展示 / 定位坏 key）
  if (Array.isArray(e.perKey) && e.perKey.length) {
    const prevKeys = m.keys || {};
    m.keys = {};
    for (const pk of e.perKey) {
      const n = pk.keyName || "key";
      const prevK = prevKeys[n] || {};
      const is429 = pk.status === 429;
      m.keys[n] = {
        lastProbedAt: e.ts, ok: pk.ok, status: pk.status, latencyMs: pk.latencyMs,
        error: pk.error || "", kind: pk.kind || "", label: pk.label || "", text: pk.text || "",
        consecutive429: is429 ? (prevK.consecutive429 || 0) + 1 : 0,
        rateLimited: is429, predictedAvailableAt: pk.predictedAvailableAt || null,
      };
    }
  } else if (m.keys) {
    delete m.keys; // 不再是多 key 探测 → 清旧快照
  }
  state.models[k] = m;
  return m;
}

// ---------------- 运行期 429 监测 / 阻断标记 ----------------
// 运行监测（agent 实际执行）与探测（probe）是两条独立信号：
//  - probe 是主动探测（小探针消息）；watch 哨兵周期复测。
//  - runtime 是被动观测 agent 执行事件流：大量 429/限流错误且某次执行被阻断（任务中断/失败）→ 标记模型不可用。
// 判定规则：不能因临时出错标记（一两次 429 重试成功不标记）；只在「最后一次执行大量出错（≥ minBlockCount）且阻断了执行」才标记。

/** 是否属于 429/限流/额度耗尽类错误文案（宽松匹配，供运行监测计数）。 */
function isRateLimitError(text, cfg) {
  const t = String(text || "");
  if (!t) return false;
  const pat = (cfg && cfg.runtime && cfg.runtime.pattern) || DEFAULT_CONFIG.runtime.pattern;
  try { return new RegExp(pat, "i").test(t); } catch (e) { return /429|rate.?limit|too many requests/i.test(t); }
}

/** 把一次被阻断的执行记录到 state.blockedExecutions（滚动保留最近 20 条；不标模型，纯记录）。 */
function recordBlockedExecution(state, ev) {
  state.updatedAt = now();
  state.blockedExecutions = [...(state.blockedExecutions || []), {
    at: ev.at || now(),
    provider: ev.provider || "",
    model: ev.model || "",
    count: Number(ev.count) || 1,          // 该次执行里累计的 429/限流错误数（大量判定）
    blocked: !!ev.blocked,                 // 是否真的阻断了执行（任务中断/失败）
    marked: !!ev.marked,                   // 是否因此把模型标记为不可用
    errorSummary: String(ev.errorSummary || "").slice(0, 300),
    sessionId: ev.sessionId || "",
    source: ev.source || "runtime",
  }].slice(-20);
  return state.blockedExecutions;
}

/** 标记某模型为「被运行阻断」不可用（lastOk=false + rateLimited + blockedAt/blockedCount），并入时间线。 */
function markBlocked(state, provider, model, ev) {
  state.updatedAt = now();
  const k = provider + "/" + model;
  const m = state.models[k] || { provider, model, lastProbedAt: 0, lastOk: null, lastStatus: 0, lastLatencyMs: 0, consecutive429: 0, rateLimited: false, predictedAvailableAt: null, lastText: "", lastError: "", recoveredAt: null, history: [] };
  const at = ev.at || now();
  m.lastOk = false;
  m.lastStatus = 429;
  m.rateLimited = true;
  m.lastKind = "rate";
  m.lastLabel = KIND_META.rate.label;
  m.lastProbedAt = at; // 用阻断时间占位（探测类展示可用）
  m.lastError = (ev.errorSummary || "运行中被大量 429 限流阻断").slice(0, 300);
  m.consecutive429 = (m.consecutive429 || 0) + (Number(ev.count) || 1);
  m.blockedAt = at;
  m.blockedBy = ev.source || "runtime";
  m.blockedCount = Number(ev.count) || 1;
  m.blockedError = String(ev.errorSummary || "").slice(0, 200);
  // 限流到期提醒（recover）：运行期阻断也是限流起点（探测起点未知时以它为准）
  if (!m.limitedSince) m.limitedSince = at;
  const win = 20;
  m.history = [...(m.history || []), { ts: at, ok: false, status: 429, latencyMs: 0, error: m.blockedError, blocked: true }].slice(-win);
  state.models[k] = m;
  return m;
}

// ---------------- 限流到期提醒（recover，纯本地时间检查，零网络） ----------------
// 设计：docs/aiti-model-check-recovery-notify-plan.md。与「探测发现恢复」不同：这里不发起任何请求，
// 只在本地比对「429 时记录的预计恢复时间（alertAt）」与当前时间，到点且已持续限流达阈值时提醒用户手动验证。

/** 长期限流阈值（毫秒）：cfg.recover.minLimitedHours（feature 合成值），缺省 72h。 */
function recoverThresholdMs(cfg) {
  const h = Number(cfg && cfg.recover && cfg.recover.minLimitedHours);
  return (Number.isFinite(h) && h > 0 ? h : 72) * 3600 * 1000;
}

/** 某模型是否开启限流到期提醒：模型级 > provider 级 > notifyDefault（缺省开）；总开关 enabled=false 全关。 */
function recoverNotifyEnabled(cfg, provider, model) {
  const r = (cfg && cfg.recover) || {};
  if (r.enabled === false) return false;
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const mk = String(provider) + "/" + String(model);
  if (has(r.models, mk)) return !!r.models[mk];
  if (has(r.providers, provider)) return !!r.providers[provider];
  return r.notifyDefault !== false;
}

/** 到期未提醒列表（纯时间比较）：alertAt 已到点 + 未提醒 + 已持续限流 ≥ 阈值 + 开关开。 */
function dueRecoverAlerts(state, cfg, nowMs) {
  const now = nowMs || Date.now();
  const thr = recoverThresholdMs(cfg);
  const out = [];
  for (const m of Object.values((state && state.models) || {})) {
    if (!m || !m.alertAt || m.alertNotifiedAt) continue;
    if (m.alertAt > now) continue;
    if (m.lastOk) continue; // 已恢复（旧 alert 未清理）不提醒
    if (!m.limitedSince) continue;
    const limitedMs = now - m.limitedSince;
    if (limitedMs < thr) continue; // 未达「长期限流」阈值
    if (!recoverNotifyEnabled(cfg, m.provider, m.model)) continue;
    out.push({ provider: m.provider, model: m.model, alertAt: m.alertAt, limitedSince: m.limitedSince, limitedMs });
  }
  return out;
}

/** 到点未验证清单（UI 待办）：alertAt 已到点 + 未恢复（lastOk 非真）——不限阈值/开关（阈值与开关只控制通知）。
 *  探测验证后 alertAt 会被清除/更新（applyToState），自动从清单移除；同一预测时间重复提醒由 alertNotifiedAt 控制。 */
function pendingRecoverChecks(state, cfg, nowMs) {
  const now = nowMs || Date.now();
  const thr = recoverThresholdMs(cfg);
  const out = [];
  for (const m of Object.values((state && state.models) || {})) {
    if (!m || !m.alertAt || m.lastOk) continue;
    if (m.alertAt > now) continue;
    const limitedMs = m.limitedSince ? now - m.limitedSince : null;
    out.push({
      provider: m.provider, model: m.model, alertAt: m.alertAt,
      limitedSince: m.limitedSince || null, limitedMs,
      longTerm: !!(limitedMs != null && limitedMs >= thr),
      notified: !!m.alertNotifiedAt,
    });
  }
  return out.sort((a, b) => b.alertAt - a.alertAt);
}

/** 标记到期提醒已发出：m.alertNotifiedAt=now + 追加 state.recoverAlerts 历史（保留最近 100 条）。 */
function markRecoverAlertsNotified(state, alerts, nowMs) {
  const now = nowMs || Date.now();
  state.updatedAt = now;
  state.recoverAlerts = Array.isArray(state.recoverAlerts) ? state.recoverAlerts : [];
  for (const a of alerts || []) {
    const m = state.models && state.models[a.provider + "/" + a.model];
    if (m) m.alertNotifiedAt = now;
    state.recoverAlerts.push({ at: now, provider: a.provider, model: a.model, alertAt: a.alertAt, limitedSince: a.limitedSince, limitedMs: a.limitedMs });
  }
  if (state.recoverAlerts.length > 100) state.recoverAlerts = state.recoverAlerts.slice(-100);
  return state.recoverAlerts;
}

/** 从 history.jsonl 全量回填 limitedSince（幂等；流式读取，遵守 >8MB 禁同步读红线）。
 *  同时补一步 alertAt 回填：功能上线前的存量限流模型已有 predictedAvailableAt（429 解析过预测恢复时间）
 *  但没有 alertAt 登记 → 直接登记为到期提醒（否则存量模型永远不会提醒）。
 *  limitedSince 规则：顺序扫描，取「最近一次 ok 之后的首条非 ok」时间；全无 ok → 首条记录时间；再无 → blockedAt/lastProbedAt。
 *  只会把起点定在记录能证明的位置（偏晚/保守），不会凭空偏早。 */
async function migrateLimitedSince(state, configDir) {
  const models = Object.values((state && state.models) || {});
  let n = 0;
  // ① alertAt 回填（存量）：有限流 + 有预测恢复时间 + 未登记提醒 → 登记（幂等）
  for (const m of models) {
    if (m && !m.alertAt && !m.lastOk && m.predictedAvailableAt && (m.rateLimited || m.blockedAt)) {
      m.alertAt = m.predictedAvailableAt;
      n++;
    }
  }
  // ② limitedSince 回填：只处理当前限流且无起点的模型
  const need = models.filter((m) => m && !m.limitedSince && (m.rateLimited || m.blockedAt));
  if (!need.length) return n;
  const file = historyFile(configDir);
  const track = new Map(); // key → { first, lastOk, sinceAfterOk }（流式维护，内存 O(模型数)）
  if (fs.existsSync(file)) {
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch (e) { continue; }
      if (!r || !r.provider || !r.model || !r.ts) continue;
      const k = r.provider + "/" + r.model;
      let t = track.get(k);
      if (!t) { t = { first: r.ts, lastOk: 0, sinceAfterOk: 0 }; track.set(k, t); }
      if (r.ok) { t.lastOk = r.ts; t.sinceAfterOk = 0; }
      else if (t.lastOk && !t.sinceAfterOk) t.sinceAfterOk = r.ts;
    }
  }
  let n2 = 0;
  for (const m of need) {
    const t = track.get(m.provider + "/" + m.model);
    let since = 0;
    if (t) {
      if (t.lastOk) since = t.sinceAfterOk; // 最近 ok 后首条非 ok；缺失（ok 后无记录）→ 回落 blockedAt/lastProbedAt
      else since = t.first;                  // 全无 ok → 首条记录时间
    }
    if (!since) since = m.blockedAt || m.lastProbedAt || 0;
    if (since) { m.limitedSince = since; n2++; }
  }
  return n + n2;
}

/** 限流到期提醒摘要（agent 工具 model_status / 排障用）。 */
function buildRecoverSummary(state, cfg, nowMs) {
  const now = nowMs || Date.now();
  const due = dueRecoverAlerts(state, cfg, now);
  const alerts = Array.isArray(state && state.recoverAlerts) ? state.recoverAlerts : [];
  const thrH = Math.round(recoverThresholdMs(cfg) / 3600000);
  const wait = []; // 已登记待到点（长期限流中，预测时间未到）
  for (const m of Object.values((state && state.models) || {})) {
    if (!m || !m.alertAt || m.alertNotifiedAt || m.lastOk) continue;
    if (!m.limitedSince || !recoverNotifyEnabled(cfg, m.provider, m.model)) continue;
    const limitedMs = now - m.limitedSince;
    if (limitedMs < recoverThresholdMs(cfg)) continue;
    if (m.alertAt > now) wait.push({ provider: m.provider, model: m.model, alertAt: m.alertAt, limitedMs });
  }
  const L = [];
  L.push("🔔 限流到期提醒（长期限流 ≥ " + (thrH >= 24 ? (thrH / 24) + " 天" : thrH + " 小时") + " · 纯时间检查，不自动探测）：");
  if (due.length) {
    L.push("  ⏰ 已到预计恢复时间 · 待验证 " + due.length + " 个（点「测」验证）：");
    for (const d of due.slice(0, 10)) L.push("    " + d.provider + "/" + d.model + " · 预计恢复 " + fmtPredict(d.alertAt, now) + "（已过点）· 已持续限流 " + fmtDuration(d.limitedMs));
  }
  if (wait.length) {
    L.push("  🕐 等待到点 " + wait.length + " 个：");
    for (const w of wait.slice(0, 10)) L.push("    " + w.provider + "/" + w.model + " · 预计恢复 " + fmtPredict(w.alertAt, now) + "（" + fmtDuration(w.alertAt - now) + "后）· 已持续 " + fmtDuration(w.limitedMs));
  }
  if (alerts.length) {
    L.push("  📜 最近提醒（显示 " + Math.min(alerts.length, 5) + "/" + alerts.length + " 条）：");
    for (const a of alerts.slice(-5).reverse()) L.push("    " + fmtTime(a.at) + " · " + a.provider + "/" + a.model + " · 预测恢复 " + fmtPredict(a.alertAt, now) + " · 限流 " + fmtDuration(a.limitedMs));
  }
  if (!due.length && !wait.length && !alerts.length) L.push("  （无：还没有超过阈值且带预测恢复时间的限流模型）");
  return L.join("\n");
}

// ---------------- 运行期错误带外观测（pi-models-combo 代理日志 tail） ----------------
// 与探测（probe，主动）和阻断标记（markBlocked，保守）是第三条独立信号：
//  - 来源是代理运行日志（key-requests-*.jsonl 的非 2xx/3xx 行，天然带 key 归因，含聚合组成员）——
//    真实流量里哪个 key 出了什么错（429 限流 / 402 欠费 / 401 key 无效 / 5xx 服务端错 / 502·504 网络错），
//    不需要主动打探针就知道。动机：用户一眼可见哪些可用。
//  - 只记录不标记：不因运行时错误改写探测状态（lastOk/rateLimited 是探测权威），只做提示 + 引导重检。
const RT_WINDOW_MS = 24 * 3600 * 1000; // 计数窗口：24h（1h 子窗口用于"正在发生"判定）
const RT_MAX_EVENTS = 80;              // 每模型事件上限（超则封顶显示 "80+"——24h 内 80+ 次已严重异常）

/** 错误状态 → 展示符号（与 KIND_META 语义对齐；502/504 是代理写的服务端/网络错）。 */
function rtErrIcon(status) {
  const s = Number(status) || 0;
  if (s === 429) return "⚡";        // 限流
  if (s === 402) return "💸";        // 欠费
  if (s === 401) return "🔑";        // key 不对
  if (s === 403) return "⛔";        // 无权限
  if (s === 404) return "∅";        // 不存在
  if (s >= 500) return "⚠️";         // 服务端错
  if (s > 0) return "⚠️";            // 其它 4xx
  return "🔌";                       // 网络/超时（代理 502/504 之外的 0）
}

// ---------------- 会话来源（直连模型）的错误分类 ----------------
// 直连调用（单 key/订阅型 provider）不走 pi-models-combo 代理、不写 usage log——运行时错误
// 只能从 pi 会话事件流（auto_retry/最终错误）拿。事件里没有结构化状态码，只有错误文案：
// 用 classifyHttp 关键词分类 + 限流文案匹配，映射为伪状态码后与代理日志同构汇入 runtimeErrors。
const KIND_PSEUDO_STATUS = { billing: 402, auth: 401, permission: 403, region: 403, notfound: 404, badreq: 400 };

/** 错误文案 → 伪 HTTP 状态码（无法识别返回 0，调用方跳过不入库，避免噪音）。 */
function pseudoStatusFromText(text, cfg) {
  const t = String(text || "");
  if (!t) return 0;
  // ① 有明确关键词的先归（欠费/认证/权限/地区/不存在/参数错——isRateLimitError 的宽松 pattern 会误吞 billing/quota 词，须先判）
  const kind = classifyHttp(0, t).kind;
  if (KIND_PSEUDO_STATUS[kind]) return KIND_PSEUDO_STATUS[kind];
  // ② 限流（429/rate limit/too many requests/overloaded/quota/exhausted/usage limit…）
  if (isRateLimitError(t, cfg)) return 429;
  // ③ 网络/超时/服务端
  if (/timed?\s*out|timeout|abort/i.test(t)) return 504;
  if (/econn(refused|reset|aborted)|enotfound|ehostunreach|fetch failed|network|socket hang up|dns/i.test(t)) return 502;
  if (/5\d{2}|internal server|bad gateway|server error|service unavailable|overloaded_error/i.test(t)) return 503;
  return 0;
}

/** 该 provider 是否走 pi-models-combo 代理（多 key ≥2 或聚合组）——决定运行时错误由哪条通道归集：
 *  走代理 → usage log tail（带 key 归因）；直连 → 会话事件摄入（无 key）。防双计：走代理的 provider 跳过会话摄入。 */
function providerUsesProxy(cfg, provider) {
  if (getProviderKeys(cfg, provider).length >= 2) return true;
  try {
    const prov = (JSON.parse(fs.readFileSync(expandPath(cfg.modelsPath || "~/.pi/agent/models.json"), "utf8")).providers || {})[provider];
    return !!(prov && prov.combo === true);
  } catch (e) { return false;
  }
}

/** 摄入一条运行时错误事件（provider/model 必填，key 可空）。status 为上游 HTTP 状态码（会话来源可为分类伪码）。返回更新后的模型条目。 */
function ingestRuntimeError(state, ev) {
  const p = String(ev.provider || ""), md = String(ev.model || "");
  const status = Number(ev.status) || 0;
  if (!p || !md || !status || (status >= 200 && status < 400)) return null; // 只收错误
  state.updatedAt = now();
  const rt = state.runtimeErrors || (state.runtimeErrors = { updatedAt: 0, models: {} });
  rt.updatedAt = now();
  const k = p + "/" + md;
  const m = rt.models[k] || { provider: p, model: md, events: [] };
  m.events = [...(m.events || []), { ts: Number(ev.at) || now(), key: String(ev.key || ""), status, ...(ev.src ? { src: String(ev.src) } : {}) }];
  recalcRuntimeErrors(m);
  rt.models[k] = m;
  return m;
}

/** 由 events 重算派生字段（count1h/count24h/byStatus/keys 聚合）。events 为唯一事实，派生值是缓存。 */
function recalcRuntimeErrors(m) {
  const cut1 = now() - 3600 * 1000, cut24 = now() - RT_WINDOW_MS;
  m.events = (m.events || []).filter((e) => e.ts > cut24).slice(-RT_MAX_EVENTS);
  const last = m.events[m.events.length - 1] || null;
  m.count24h = m.events.length;
  m.count1h = m.events.filter((e) => e.ts > cut1).length;
  m.lastAt = last ? last.ts : 0;
  m.lastKey = last ? last.key : "";
  m.lastStatus = last ? last.status : 0;
  m.lastSrc = last ? (last.src || "proxy") : "";
  // 按状态分类计数（模型级）：{"429":{count1h,count24h}, "402":{...}}——限流/欠费/key 无效一眼可分
  const byStatus = {};
  for (const e of m.events) {
    const s = String(e.status || "0");
    const b = byStatus[s] || (byStatus[s] = { count1h: 0, count24h: 0 });
    b.count24h++;
    if (e.ts > cut1) b.count1h++;
  }
  m.byStatus = byStatus;
  // key 维度聚合（派生缓存；代理日志的 key 名已唯一）：每 key 计数 + 分类 + 最近状态
  const keys = {};
  for (const e of m.events) {
    if (!e.key) continue;
    const kk = keys[e.key] || (keys[e.key] = { lastAt: 0, lastStatus: 0, count24h: 0, count1h: 0, byStatus: {} });
    kk.count24h++;
    if (e.ts > cut1) kk.count1h++;
    if (e.ts > kk.lastAt) { kk.lastAt = e.ts; kk.lastStatus = e.status; }
    const s = String(e.status || "0");
    const kb = kk.byStatus[s] || (kk.byStatus[s] = { count1h: 0, count24h: 0 });
    kb.count24h++;
    if (e.ts > cut1) kb.count1h++;
  }
  m.keys = keys;
  return m;
}

/** 清理过期运行时观测（>24h 的空条目删除；一次性清旧版 runtime429 字段；读取前调用）。 */
function pruneRuntimeErrors(state) {
  if (!state) return;
  if (state.runtime429) delete state.runtime429; // 旧字段（仅 429 版本）一次性清理
  const rt = state.runtimeErrors;
  if (!rt || !rt.models) return;
  for (const k of Object.keys(rt.models)) {
    const m = rt.models[k];
    recalcRuntimeErrors(m);
    if (!m.events.length) delete rt.models[k];
  }
  if (!Object.keys(rt.models).length) delete state.runtimeErrors;
}

/** 运行时错误汇总文本（model_status 工具用）：按 1h 次数倒序列前 8 个，分类计数一眼可分。 */
function buildRuntimeErrorsSummary(state) {
  const rt = state && state.runtimeErrors;
  if (!rt || !rt.models) return "";
  const list = Object.values(rt.models).filter((m) => m.count24h > 0)
    .sort((a, b) => b.count1h - a.count1h || b.count24h - a.count24h)
    .slice(0, 8);
  if (!list.length) return "";
  const cls = (m) => Object.entries(m.byStatus || {})
    .sort((x, y) => y[1].count24h - x[1].count24h).map(([s, b]) => rtErrIcon(s) + s + "×" + b.count24h).join(" ");
  const lines = list.map((m) =>
    "  " + rtErrIcon(m.lastStatus) + " " + m.provider + "/" + m.model + " · 1h×" + m.count1h + " / 24h×" + m.count24h + (m.count24h >= RT_MAX_EVENTS ? "+" : "")
    + "（" + cls(m) + "）"
    + " · 最近 " + fmtTime(m.lastAt) + (m.lastKey ? " key " + m.lastKey : ""));
  return "🔎 运行期错误观测（带外 · 来自多 key/聚合代理真实流量，非主动探测；权威确认请 model_probe）：\n" + lines.join("\n");
}

/**
 * 所有已配置模型是否都不可用（用于「还没有可用模型」banner 显示条件）。
 * 规则：每个已配置模型都必须「已探测且非可用」（429 限流或异常）才算全部不可用；
 * 只要有一个可用、或一个还没探测过（无法断定）→ 返回 false（不亮 banner，避免误报）。
 */
function allUnavailable(state, entries) {
  const models = (state && state.models) || {};
  let configured = 0, unavailable = 0;
  for (const e of entries || []) {
    configured++;
    const m = models[e.provider + "/" + e.model];
    if (m && m.lastProbedAt && !m.lastOk) unavailable++;
    else return false; // 有可用或未探测 → 不算全部不可用
  }
  return configured > 0 && unavailable === configured;
}

/** 可用性汇总（banner / agent 工具用）：无模型 / 全部不可用 / 分类计数。 */
function availability(state, entries) {
  const models = (state && state.models) || {};
  const c = { available: 0, rateLimited: 0, errorCount: 0, unprobed: 0 };
  for (const e of entries || []) {
    const m = models[e.provider + "/" + e.model];
    if (!m || !m.lastProbedAt) { c.unprobed++; continue; }
    if (m.lastOk) c.available++;
    else if (m.rateLimited) c.rateLimited++;
    else c.errorCount++;
  }
  const total = c.available + c.rateLimited + c.errorCount + c.unprobed;
  const blockedExecs = (state && Array.isArray(state.blockedExecutions) ? state.blockedExecutions : []);
  const lastBlocked = blockedExecs.length ? blockedExecs[blockedExecs.length - 1] : null;
  return {
    noModels: !(entries || []).length,
    total, ...c,
    allUnavailable: total > 0 && c.available === 0 && c.unprobed === 0 && (c.rateLimited + c.errorCount) === total,
    blockedExecutions: blockedExecs,
    lastBlocked,
  };
}

// ---------------- 余额 / 套餐用量查询 ----------------
// 部分 provider 的 API 提供账户余额/套餐用量查询端点（GET + Bearer key）。
// 端点与解析依据：OpenClaw 源码 src/infra/provider-usage.fetch.{deepseek,zai,minimax}.ts +
// extensions/openrouter/usage.ts（/api/v1/key）· Moonshot/智谱官方公开 API。
// kind: "balance"=💰现金余额 / "usage"=📦套餐用量（限额百分比+周期）。
const BALANCE_PROVIDERS = [
  {
    id: "deepseek"/* 字段不用，占位 */,
    match: ["deepseek"], label: "DeepSeek 官方", kind: "balance",
    baseUrl: "https://api.deepseek.com", path: "/user/balance",
    parse(j) {
      const infos = Array.isArray(j && j.balance_infos) ? j.balance_infos : [];
      const b0 = infos[0] || {};
      const cur = String(b0.currency || "");
      const sym = cur.toUpperCase() === "CNY" ? "¥" : cur.toUpperCase() === "USD" ? "$" : (cur ? cur + " " : "");
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      const fmt = (v) => v == null ? null : sym + Number(v).toFixed(2);
      const total = num(b0.total_balance);
      if (total == null) return { ok: false, reason: "无余额数据" };
      const owed = total < 0; // 负余额 = 欠费（不可用，红）
      const parts = [owed ? "欠费 " + fmt(Math.abs(total)) : "余额 " + fmt(total)];
      const g = num(b0.granted_balance); if (g != null && g > 0) parts.push("赠额 " + fmt(g));
      const t = num(b0.topped_up_balance); if (t != null && t > 0 && t !== total) parts.push("充值 " + fmt(t));
      return {
        ok: true, text: parts.join(" · "), exhausted: owed,
        detail: { total: fmt(total), owed, granted: num(b0.granted_balance) > 0 ? fmt(b0.granted_balance) : null, toppedUp: num(b0.topped_up_balance) > 0 ? fmt(b0.topped_up_balance) : null, currency: cur },
      };
    },
  },
  {
    match: ["zai-coding-cn", "zai", "zhipu", "bigmodel"], label: "Z.AI / 智谱 编码套餐", kind: "usage",
    // 主：Z.AI monitor 配额（编码套餐 key 有效，实测返回 limits 用量）· 备：智谱通用余额
    baseUrl: "https://api.z.ai", path: "/api/monitor/usage/quota/limit",
    fallback: [{ baseUrl: "https://open.bigmodel.cn", path: "/api/maas/account/balance", kind: "balance" }],
    parse(j) {
      // {code:200,success:true,data:{level,limits:[{type,unit,number,percentage,usage,currentValue,remaining,nextResetTime,usageDetails}]}}
      if (!j || j.success === false) return { ok: false, reason: "接口返回 " + (j && (j.msg || j.code) || "失败") };
      const d = (j && j.data) || {};
      const limits = Array.isArray(d.limits) ? d.limits : [];
      const parts = [];
      if (d.level) parts.push("level=" + d.level);
      const usedUp = [];
      for (const L of limits) {
        const pct = Number(L.percentage);
        if (L.remaining != null) { // 有剩余配额的可读条目（如 TIME_LIMIT）
          parts.push("剩余 " + L.remaining + "（已用 " + (L.usage != null ? L.usage : "-") + "·" + (Number.isFinite(pct) ? pct : "?") + "%" + (L.nextResetTime ? "，重置 " + fmtPredict(Number(L.nextResetTime), Date.now()) : "") + "）");
        } else if (pct >= 100) usedUp.push(L.type || "额度");
        else if (Number.isFinite(pct)) parts.push((L.type || "额度") + " " + pct + "%");
      }
      for (const t of usedUp) parts.push(t + " 已用满");
      if (!parts.length && !limits.length) return { ok: false, reason: "无 limits 数据" };
      if (usedUp.length) parts.push("任意限额用满即不可用");
      return { ok: true, text: parts.join(" · "), exhausted: usedUp.length > 0, detail: { level: d.level, exhausted: usedUp.length > 0, limits: limits.map((L) => ({ type: L.type, percentage: L.percentage, usage: L.usage, remaining: L.remaining, nextResetAt: L.nextResetTime ? Number(L.nextResetTime) : undefined })) } };
    },
  },
  {
    match: ["opencode"], label: "OpenCode Zen 用量", kind: "usage",
    // 实测：GET /zen/go/v1/usage → {usage:{rolling,weekly,monthly:{status,percent,resetsAt}}}（三窗口用量百分比+重置时间）
    baseUrl: "https://opencode.ai/zen/go", path: "/v1/usage",
    parse(j) {
      const u = (j && j.usage) || {};
      const W = { rolling: "滑动", weekly: "本周", monthly: "本月" };
      const parts = [];
      let exhausted = false; // 任意窗口用满/限流 → 整体不可用
      for (const k of ["rolling", "weekly", "monthly"]) {
        const w = u[k]; if (!w) continue;
        const pct = Number(w.percent);
        const st = w.status === "ok" ? "正常" : (w.status === "rate-limited" ? "限流" : (w.status || ""));
        const usedUp = Number.isFinite(pct) && pct >= 100;
        if (usedUp || w.status === "rate-limited") exhausted = true;
        const reset = w.resetsAt ? "重置 " + fmtPredict(Date.parse(w.resetsAt), Date.now()) : "";
        if (usedUp) parts.push(W[k] + " " + st + "·已用满" + (reset ? "（" + reset + "）" : ""));
        else if (Number.isFinite(pct)) parts.push(W[k] + " " + st + "·" + pct + "%" + (reset ? "·" + reset : ""));
        else parts.push(W[k] + " " + st);
      }
      if (!parts.length) return { ok: false, reason: "无 usage 数据" };
      if (exhausted) parts.push("任意窗口用满即不可用");
      return { ok: true, text: parts.join(" · "), exhausted, detail: { usage: u, exhausted } };
    },
  },
  {
    match: ["venice"], label: "Venice 余额", kind: "balance",
    // OpenClaw extensions/venice/usage.ts：GET /api/v1/billing/balance
    baseUrl: "https://api.venice.ai", path: "/api/v1/billing/balance",
    parse(j) {
      const b = (j && j.balances) || {};
      const parts = [];
      if (b.usd != null) parts.push("USD " + b.usd);
      if (b.diem != null) parts.push("DIEM " + b.diem);
      if (j && j.canConsume === false) parts.push("不可消费");
      if (!parts.length) return { ok: false, reason: "无余额数据" };
      return { ok: true, text: parts.join(" · "), detail: { balances: b, canConsume: j && j.canConsume } };
    },
  },
  {
    match: ["moonshot", "kimi"], label: "Moonshot / Kimi", kind: "balance",
    baseUrl: "https://api.moonshot.cn", path: "/v1/users/me/balance",
    // kimi.com/coding 套餐：先试 {base}/me（会员权益/套餐状态端点，实测 api.kimi.com/coding/v1/me：200=会员数据 / 402=会员失效），失败回退 moonshot 官方。
    extraPathFor: (baseUrl) => /api\.kimi\.com/i.test(baseUrl || "") ? [{ base: baseUrl.replace(/\/+$/, ""), path: "/me" }] : [],
    parse(j) {
      // {code:0, data:{available_balance:"CNY 22.32", vouchers:[{available_balance,type,expired_at}]}}
      // 注意：异常时也可能是 {code:400, msg:...} 200 包
      if (j && j.code !== undefined && Number(j.code) !== 0) return { ok: false, reason: "接口返回 " + (j.msg || j.message || "code=" + j.code) };
      const d = (j && j.data) || {};
      const parts = [];
      if (d.available_balance != null) parts.push("可用 " + d.available_balance);
      const vc = Array.isArray(d.vouchers) ? d.vouchers.filter((v) => v && v.available_balance) : [];
      for (const v of vc) parts.push((v.type || "券") + " " + v.available_balance);
      if (!parts.length) return { ok: false, reason: "无余额数据" };
      return { ok: true, text: parts.join(" · "), detail: { available: d.available_balance, vouchers: vc.map((v) => ({ type: v.type, available: v.available_balance, expiredAt: v.expired_at })) } };
    },
  },
  {
    match: ["openrouter"], label: "OpenRouter", kind: "balance",
    // 主：GET /credits → {data:{total_credits, total_usage}}（账户充值余额 = 充值-已用，真实余额）；
    // 备：GET /key → key 信息（limit/limit_remaining，无 credits 字段——此前误读成 0）
    baseUrl: "https://openrouter.ai/api/v1", path: "/credits",
    fallback: [{ baseUrl: "https://openrouter.ai/api/v1", path: "/key" }],
    parse(j) {
      const d = (j && j.data) || {};
      // —— 主：/credits ——
      if (d && typeof d === "object" && d.total_credits != null) {
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
        const fmt = (v) => v == null ? null : "$" + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
        const tc = num(d.total_credits), tu = num(d.total_usage);
        const rem = (tc || 0) - (tu || 0);
        const parts = ["余额 " + fmt(rem)];
        if (tc != null && tu != null) parts.push("充值 " + fmt(tc) + " · 已用 " + fmt(tu));
        return { ok: true, text: parts.join(" "), exhausted: rem < 0, detail: { totalCredits: fmt(tc), totalUsage: fmt(tu), remaining: fmt(rem), freeTier: false } };
      }
      // —— 备：/key ——（limit=0 + is_free_tier=true = 免费层，按量计费）
      if (!j || (!d.credits && d.usage == null && d.limit == null && d.limit_remaining == null)) return { ok: false, reason: "无额度数据" };
      const num2 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      const fmt2 = (v) => v == null ? null : "$" + (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
      const freeTier = !!d.is_free_tier || (num2(d.limit) === 0 && num2(d.credits) === 0);
      const rem2 = num2(d.limit_remaining) != null ? num2(d.limit_remaining) : num2(d.credits);
      const parts2 = [];
      if (freeTier) parts2.push("免费额度 · 按量计费");
      else if (rem2 != null) parts2.push("剩余 " + fmt2(rem2));
      if (num2(d.limit) != null && num2(d.limit) > 0) parts2.push("本周期额度 $" + Number(d.limit).toFixed(0));
      if (num2(d.usage) != null) parts2.push("已用 " + fmt2(d.usage));
      if (d.label) parts2.push("(" + String(d.label).slice(0, 20) + ")");
      const owed2 = !freeTier && rem2 != null && rem2 < 0;
      return { ok: true, text: parts2.join(" "), exhausted: owed2, detail: { freeTier, credits: fmt2(num2(d.credits)), limit: fmt2(num2(d.limit)), limitRemaining: fmt2(num2(d.limit_remaining)), usage: fmt2(num2(d.usage)) } };
    },
  },
  {
    match: ["minimax"], label: "MiniMax 套餐", kind: "usage",
    baseUrl: "https://api.minimaxi.com", path: "/v1/token_plan/remains",
    parse(j) {
      // token_plan/remains → 套餐剩余/已用百分比（字段名不固定，宽松提取数字字段展示）
      const d = (j && j.data) || j || {};
      if (typeof d !== "object") return { ok: false, reason: "无数据" };
      const keys = Object.keys(d);
      const pick = keys.filter((k) => /remain|percent|usage|left|reset/i.test(k));
      if (!pick.length && !keys.length) return { ok: false, reason: "无数据" };
      const text = pick.length ? pick.map((k) => k + "=" + d[k]).join(" · ") : (keys.slice(0, 6).map((k) => k + "=" + d[k]).join(" · "));
      return { ok: true, text: text.slice(0, 160), detail: d };
    },
  },
];

// 从 models.json 配置条目里找余额端点定义（provider 名小写后子串匹配）
function findBalanceProvider(entry) {
  const name = String(entry.provider || "").toLowerCase();
  for (const p of BALANCE_PROVIDERS) {
    if (p.match.some((m) => name.includes(m))) return p;
  }
  return null;
}

// 查一个 provider 的余额/用量（entry 取该 provider 任一有 key 的条目）
async function checkBalance(entry, cfg, opts = {}) {
  const def = findBalanceProvider(entry);
  const t0 = now();
  const timeoutMs = opts.timeoutMs || (cfg && cfg.probe && cfg.probe.timeoutMs) || 10000;
  const fail = (unsupported, reason) => ({ provider: entry.provider, ok: false, unsupported, reason, checkedAt: now(), latencyMs: now() - t0 });
  if (!def) {
    return fail(true, "无公开余额查询 API（余额请在其控制台查看）");
  }
  if (!entry.apiKey) return fail(false, "models.json 未配置该 provider 的 apiKey，无法鉴权查询");
  // 候选地址：定义默认 base + 定义 fallback + entry.baseUrl 派生（deepseek 官方端点在根域）
  const cands = [{ base: (def.baseUrl || "").replace(/\/+$/, ""), path: def.path }];
  for (const fb of (def.fallback || [])) cands.push({ base: (fb.baseUrl || "").replace(/\/+$/, ""), path: fb.path });
  const extra = def.extraPathFor ? def.extraPathFor(entry.baseUrl) : [];
  for (const x of extra) cands.push(x);
  // 若 entry.baseUrl 与默认不同且不像测试地址（127.0.0.1/localhost），追加同一路径候选
  const eb = (entry.baseUrl || "").replace(/\/+$/, "");
  if (eb && !/127\.0\.0\.1|localhost/.test(eb) && eb !== cands[0].base) {
    // deepseek：官方根域端点已在 cands[0]，entry base 带 /v1 时用 /user/balance 也试一次（api.deepseek.com/v1/user/balance 亦可）
    const p = eb + (def.path.startsWith("/") ? def.path : "/" + def.path);
    if (!cands.some((c) => (c.base + c.path) === p)) cands.push({ base: eb, path: def.path });
  }
  const headers = { accept: "application/json", authorization: "Bearer " + entry.apiKey };
  let lastErr = "", saw404 = false, sawAuth = false;
  const seen = new Set();
  for (const c of cands) {
    const url = c.base + c.path;
    if (seen.has(url)) continue; seen.add(url);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 200) {
        const body = await res.text().catch(() => "");
        let j = null; try { j = JSON.parse(body); } catch (e) {}
        if (!j) return fail(false, "200 但响应非 JSON");
        const parsed = def.parse(j);
        if (!parsed || !parsed.ok) { lastErr = (parsed && parsed.reason) || "解析为空"; continue; } // 该候选业务失败 → 继续试下一个
        return { provider: entry.provider, label: def.label, kind: def.kind, ok: true, unsupported: false, exhausted: !!parsed.exhausted, checkedAt: now(), latencyMs: now() - t0, text: parsed.text, detail: parsed.detail };
      }
      if (res.status === 402) {
        // 402 Payment Required：kimi /me 会员权益端点 → 套餐/会员不可用（可能已失效）
        const body = await res.text().catch(() => "");
        let msg = "HTTP 402（套餐/会员不可用，可能已失效）";
        try {
          const j = JSON.parse(body);
          const em = j && j.error && j.error.message;
          if (em && /membership|benefit|subscription|active/i.test(String(em))) msg = "会员权益无法验证（套餐可能已失效/未生效）";
          else if (em) msg = "套餐/会员不可用：" + String(em).slice(0, 100);
        } catch (e) {}
        return fail(false, msg);
      }
      if (res.status === 404) { saw404 = true; lastErr = "HTTP 404 无此端点"; continue; }
      if (res.status === 401 || res.status === 403) { sawAuth = true; lastErr = "HTTP " + res.status + " key 无余额查询权限（该套餐 key 可能不支持查余额）"; continue; }
      lastErr = "HTTP " + res.status;
    } catch (e) {
      const abort = String((e && e.name) || "") === "TimeoutError" || /abort|timeout/i.test(String((e && e.message) || ""));
      lastErr = abort ? "timeout(" + timeoutMs + "ms)" : "network: " + String((e && e.message) || e);
    }
  }
  if (saw404 && !sawAuth) return fail(false, lastErr || "查询失败");
  if (sawAuth) return fail(false, lastErr || "查询失败");
  return fail(false, lastErr || "查询失败");
}

// 并发查全部 provider 余额（按 provider 去重，同 provider 只查一次）
async function checkAllBalances(entries, cfg, opts = {}) {
  const byProv = {};
  for (const e of entries || []) {
    if (!byProv[e.provider] && e.apiKey && !e.notProbeable) byProv[e.provider] = e; // 订阅 provider（OAuth）不走余额 API
  }
  const list = Object.values(byProv);
  const results = await Promise.all(list.map((e) => checkBalance(e, cfg, opts)));
  return results.sort((a, b) => a.provider.localeCompare(b.provider));
}

// 把余额结果并入 state.balances（provider 级缓存）
function applyBalancesToState(state, results) {
  state.balances = state.balances || {};
  for (const r of results) state.balances[r.provider] = r;
  state.updatedAt = now();
}

// 展示归一化：余额/额度为负或文案含"欠费" → 强制 exhausted（防旧缓存/边缘 case 误显绿色）。
// 覆盖 kind=balance（现金余额）与 kind=usage（套餐），兼容各 provider 文本/数字表达（¥-0.38 / -$5 / 欠费 / 透支）。
function normalizeBalanceDisplay(balances) {
  const out = {};
  for (const [prov, b] of Object.entries(balances || {})) {
    if (!b || typeof b !== "object") { out[prov] = b; continue; }
    let ex = !!b.exhausted;
    if (!ex) {
      const d = b.detail || {};
      const t = [b.text, d.total, d.limitRemaining, d.remaining, d.credits]
        .filter((v) => v != null).map(String).join(" ");
      if (/欠费|透支|负余额|余额不足|[¥$€£]\s*-|-[¥$€£]|-\s*[0-9]+\.[0-9]+/.test(t)) ex = true;
    }
    out[prov] = ex === b.exhausted ? b : { ...b, exhausted: ex };
    // 旧缓存 openrouter free tier："剩余 $0.00 本周期额度 $0" → 归一为"免费额度 · 按量计费"（避免读缓存时误显欠费）
    const nb2 = out[prov];
    if (!ex && String(prov).toLowerCase().includes("openrouter")) {
      const t = String(b.text || "");
      if (/剩余\s*\$[^ ]+\s*本周期额度\s*\$[0-9.]+/.test(t)) {
        out[prov] = { ...nb2, text: t.replace(/剩余\s*\$[^ ]+\s*本周期额度\s*\$[0-9.]+/, "免费额度 · 按量计费") };
      }
    }
  }
  return out;
}

// 余额结果的人类可读汇总（tool / API 输出）
function buildBalanceSummary(balances) {
  const norm = normalizeBalanceDisplay(balances || {});
  const list = Object.values(norm);
  if (!list.length) return "（暂无余额查询记录，点「查余额」或调 model_balance）";
  const L = [];
  for (const b of list) {
    if (b.ok && b.exhausted) L.push("  ❌ " + b.provider + " · " + (b.label || "") + " · " + (b.text || "") + "（" + fmtTime(b.checkedAt) + "）");
    else if (b.ok) L.push("  ✅ " + b.provider + " · " + (b.label || "") + " · " + (b.text || "") + "（" + fmtTime(b.checkedAt) + "）");
    else if (b.unsupported) L.push("  ⚪ " + b.provider + " · 不支持查余额（" + (b.reason || "") + "）");
    else L.push("  ⚠️ " + b.provider + " · 查询失败（" + (b.reason || "") + "）");
  }
  return L.join("\n");
}

// ---------------- 读历史 ----------------
function readHistory(configDir, { provider, model, limit } = {}) {
  const f = historyFile(configDir);
  if (!fs.existsSync(f)) return [];
  const out = [];
  const max = limit || 100;
  const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
  // 从后往前取（最新的优先），再反转回时间正序
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (provider && e.provider !== provider) continue;
      if (model && e.model !== model) continue;
      out.push(e);
    } catch (e2) {}
  }
  return out.reverse();
}

// ---------------- 可用性分析 / 摘要 ----------------
function statusOf(m) {
  if (!m || !m.lastProbedAt) return "never";
  if (m.lastOk) return "ok";
  if (m.rateLimited) return "rl";
  return "err";
}
const STATUS_ICON = { ok: "✅", rl: "🔴", err: "⚠️", never: "⚪" };
const STATUS_LABEL = { ok: "可用", rl: "429限流", err: "异常", never: "未探测" };

// 单个 model 的可用性时间线（从 state.window）
function timelineText(m) {
  const h = (m && m.history) || [];
  if (!h.length) return "";
  return h.slice(-8).map((x) => fmtTime(x.ts) + (x.ok ? "✅" : x.status === 429 ? "🔴" : "⚠️")).join(" ");
}

function buildSummary(state, opts = {}) {
  const models = Object.values(state.models || {});
  const nowMs = now();
  const groups = { ok: [], rl: [], err: [], never: [] };
  for (const m of models) groups[statusOf(m)].push(m);
  const L = [];
  L.push("📊 模型可用性总览（" + models.length + " 个 · 状态更新于 " + fmtTime(state.updatedAt) + "）");
  // 分 key 检查：多 key provider 的每 key 状态（✅/🔴/⚠️ key名=状态 延迟）
  const perKeyText = (m) => {
    const ks = m && m.keys;
    if (!ks || typeof ks !== "object") return "";
    const es = Object.entries(ks);
    if (es.length < 2) return "";
    return " [keys " + es.map(([n, k]) => (k.ok ? "✅" : k.status === 429 ? "🔴" : "⚠️") + n + "=" + (k.ok ? "OK" : (k.status || "err")) + (k.latencyMs != null ? " " + fmtDuration(k.latencyMs) : "")).join(" · ") + "]";
  };
  const line = (m, extra) => "  " + STATUS_ICON[statusOf(m)] + " " + m.provider + "/" + m.model + " · HTTP " + (m.lastStatus || "-") + " · " + fmtDuration(m.lastLatencyMs) + perKeyText(m) + " · " + (extra || "");
  if (groups.ok.length) {
    L.push("✅ 可用 (" + groups.ok.length + ")：");
    for (const m of groups.ok) L.push(line(m, "回 " + JSON.stringify(m.lastText || "")));
  }
  if (groups.rl.length) {
    L.push("🔴 429 限流 (" + groups.rl.length + ")" + (models.some((m) => m.blockedAt) ? "（含运行阻断标记）" : "") + "：");
    for (const m of groups.rl) {
      let extra = "连续 " + (m.consecutive429 || 1) + " 次 · 上次可用 " + fmtTime(lastOkTs(m));
      if (m.blockedAt) extra += " · ⛔ 运行期被阻断标记（" + fmtTime(m.blockedAt) + "，" + (m.blockedCount || 1) + " 次 429 导致任务中断）";
      if (m.predictedAvailableAt) extra += " · 预计恢复 ~" + fmtPredict(m.predictedAvailableAt, nowMs) + (m.predictedAvailableAt < nowMs ? "（已过恢复点，待复核）" : "（" + fmtDuration(m.predictedAvailableAt - nowMs) + "后）");
      if (m.lastError) extra += " · 提示: " + m.lastError.slice(0, 80);
      L.push(line(m, extra));
    }
  }
  if (groups.err.length) {
    L.push("⚠️ 异常 (" + groups.err.length + ")：");
    for (const m of groups.err) {
      const label = m.lastLabel || classifyHttp(m.lastStatus, m.lastError || "").label;
      L.push(line(m, label + (m.lastError ? " · " + m.lastError.slice(0, 80) : "")));
    }
  }
  if (groups.never.length) {
    L.push("⚪ 未探测 (" + groups.never.length + ")：");
    for (const m of groups.never) L.push(line(m, "还没有探测记录（用 model_probe）"));
  }
  // 恢复记录（识别到的可用时间）
  const recovered = models.filter((m) => m.recoveredAt);
  if (recovered.length) {
    L.push("🕐 已识别恢复时间：");
    for (const m of recovered) L.push("  " + m.provider + "/" + m.model + " · " + fmtTime(m.recoveredAt) + " 恢复可用（此前限流）");
  }
  // 最近 8 次时间线
  L.push("时间线（最近 8 次探测，每模型）：");
  for (const m of [...groups.ok, ...groups.rl, ...groups.err]) L.push("  " + m.provider + "/" + m.model + "  " + (timelineText(m) || "-"));
  // 运行期被阻断的执行记录（大量 429 导致任务中断 → 通知模型检查的痕迹）
  const blockedExecs = Array.isArray(state.blockedExecutions) ? state.blockedExecutions : [];
  if (blockedExecs.length) {
    L.push("⛔ 运行期阻断记录（最近 " + blockedExecs.length + " 次执行被大量 429 中断）：");
    for (const b of blockedExecs.slice(-3)) {
      L.push("  " + fmtTime(b.at) + " · " + (b.provider + "/" + b.model || "?") + " · " + b.count + " 次" + (b.marked ? "（已标记不可用）" : "") + (b.errorSummary ? " · " + b.errorSummary.slice(0, 60) : ""));
    }
  }
  return L.join("\n");
}
function lastOkTs(m) {
  const h = (m && m.history) || [];
  for (let i = h.length - 1; i >= 0; i--) if (h[i].ok) return h[i].ts;
  return null;
}

/** 裁剪 state.models：只保留 entries 里当前配置的模型（去掉旧探测残留的已删除/已移除模型）。直接修改 state。
 *  同时裁剪 state.subscriptions：只保留仍出现在条目里的订阅 provider（登出/移除后自动清掉陈旧订阅状态）。 */
function pruneState(state, entries) {
  if (!state) return;
  if (state.models && Array.isArray(entries)) {
    const keys = new Set((entries || []).map((e) => e.provider + "/" + e.model));
    for (const k of Object.keys(state.models)) {
      if (!keys.has(k)) delete state.models[k];
    }
  }
  if (state.subscriptions) {
    const subProvs = new Set((entries || []).filter((e) => e.subscription).map((e) => e.provider));
    for (const p of Object.keys(state.subscriptions)) {
      if (!subProvs.has(p)) delete state.subscriptions[p];
    }
    if (!Object.keys(state.subscriptions).length) delete state.subscriptions;
  }
}

module.exports = {
  now, fmtTime, fmtPredict, fmtDuration, expandPath,
  DEFAULT_CONFIG, loadConfig, saveConfig, loadUserConfig,
  getProviderKeys, normalizeKeyEntry,
  initPiRuntime, piReady, piError,
  loadModels, markComboEntries, probeOne, probeOneKey, probeAll, probeByProvider, makeErrorEntry,
  loadAuthCredentials, loadSubscriptionEntries, subscriptionCheckInfo, checkSubscription,
  buildRequest, extractRateLimit, extractResponseText,
  historyFile, stateFile, recordHistory, trimHistory, loadState, saveState, applyToState,
  readHistory, buildSummary, statusOf, lastOkTs,
  isRateLimitError, recordBlockedExecution, markBlocked, allUnavailable, availability,
  recoverThresholdMs, recoverNotifyEnabled, dueRecoverAlerts, pendingRecoverChecks, markRecoverAlertsNotified, migrateLimitedSince, buildRecoverSummary,
  ingestRuntimeError, recalcRuntimeErrors, pruneRuntimeErrors, buildRuntimeErrorsSummary, rtErrIcon, RT_MAX_EVENTS,
  pseudoStatusFromText, providerUsesProxy,
  classifyHttp, KIND_META,
  pruneState,
  BALANCE_PROVIDERS, findBalanceProvider, checkBalance, checkAllBalances,
  applyBalancesToState, buildBalanceSummary, normalizeBalanceDisplay,
};
