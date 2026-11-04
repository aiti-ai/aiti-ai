"use strict";
/**
 * aiti-models-import · 纯 Node 核心（无外部依赖，io 可注入可测）
 *
 * 职责：
 *   - 导入标记（import-state.json，stateDir，原子写 0600）：completedAt/dismissedAt + 逐源指纹/草稿快照
 *   - 指纹：源级 sha256（稳定字符串化，剔除 key 明文、含 hasKey/apiKeyEnv 语义）
 *   - 状态机：available-new / changed / unchanged / source-gone（§4.3 docs/aiti-models-import-plan.md）
 *   - 冲突检测：草稿 vs models.json 现有 providers（none/merge/override）
 *   - 草稿规整/消毒：key 明文不出 server（/scan 回 hasKey+keyHint；标记快照剔除 apiKey）
 *   - 模型预览元数据（modelMeta）：只服务弹窗「点开看待带入的模型」——不进 models 导入载荷、
 *     不进指纹、不进标记快照（预览变了不等于配置变了）
 *
 * 红线：本模块不写 models.json（保存一律走 aiti-model-wizard saveBatch）；不落任何日志。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MARKER_VERSION = 1;

// ---------------- 标记（import-state.json） ----------------

function defaultMarker() {
  return { version: MARKER_VERSION, completedAt: null, dismissedAt: null, sources: {} };
}

function markerPath(stateDir) {
  return path.join(stateDir || "", "import-state.json");
}

function readMarker(stateDir) {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(stateDir), "utf8"));
    if (!m || typeof m !== "object") return defaultMarker();
    return {
      version: MARKER_VERSION,
      completedAt: m.completedAt || null,
      dismissedAt: m.dismissedAt || null,
      sources: m.sources && typeof m.sources === "object" ? m.sources : {},
    };
  } catch {
    return defaultMarker();
  }
}

function writeMarker(stateDir, marker) {
  const p = markerPath(stateDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch { /* 平台不支持则跳过 */ }
  return true;
}

/** 首启判定：无完成标记且未关闭过。 */
function isFirstRun(marker) {
  return !marker.completedAt && !marker.dismissedAt;
}

// ---------------- 指纹（稳定字符串化 + 剔除 key 明文） ----------------

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

function sha256(s) {
  return "sha256:" + crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** 参与指纹/落盘的草稿投影（apiKey 明文绝不进来；hasKey/apiKeyEnv 是语义，保留）。 */
function draftFingerprintInput(d) {
  return {
    key: String(d.key || ""),
    baseUrl: d.baseUrl || null,
    api: d.api || null,
    apiKeyEnv: d.apiKeyEnv || null,
    hasKey: !!d.apiKey,
    models: (d.models || []).map((m) => ({ id: m.id, name: m.name || null, contextWindow: m.contextWindow ?? null, maxTokens: m.maxTokens ?? null })),
  };
}

function sourceFingerprint(drafts) {
  const inputs = (drafts || []).map(draftFingerprintInput).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sha256(stableStringify(inputs));
}

/** 标记快照用草稿（深拷贝 + 剔除 apiKey 明文与展示专用 modelMeta）。 */
function snapshotDraft(draft) {
  const { apiKey, modelMeta, ...rest } = draft || {};
  void apiKey;
  void modelMeta;
  return JSON.parse(JSON.stringify(rest));
}

/** key 掩码提示（UI 展示用）：明文 → "…末4位"。 */
function keyHint(key) {
  const s = String(key || "");
  return s.length > 4 ? "…" + s.slice(-4) : s ? "…" : "";
}

// ---------------- provider key 规整 ----------------

/** 源内 id → pi provider key 片段（models.json 键安全字符）。 */
function sanitizeId(s) {
  return String(s || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** 展示元数据字段白名单 + 类型清洗（任意键不得流出到 client）。 */
function normModelMeta(v) {
  const src = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const out = {};
  if (src.name) out.name = String(src.name);
  if (typeof src.contextWindow === "number" && src.contextWindow > 0) out.contextWindow = src.contextWindow;
  if (typeof src.maxTokens === "number" && src.maxTokens > 0) out.maxTokens = src.maxTokens;
  if (typeof src.reasoning === "boolean") out.reasoning = src.reasoning;
  if (Array.isArray(src.input)) out.input = src.input.map(String).filter(Boolean);
  return Object.keys(out).length ? out : null;
}

function normModelMetaMap(v) {
  const src = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  const out = {};
  for (const [id, meta] of Object.entries(src)) {
    const m = normModelMeta(meta);
    if (m && id) out[String(id)] = m;
  }
  return out;
}

/**
 * 源配置里的模型条目 → 展示元数据（弹窗预览用）。
 * 只读不写：这些字段不进 draft.models、不进指纹、不进标记快照，导入落盘内容与不启用预览时完全一致
 * （方案 B：预览是「看得懂的解释」，不是新的写入通道）。
 */
function pickModelMeta(entry) {
  const src = entry && typeof entry === "object" ? entry : {};
  const limit = src.limit && typeof src.limit === "object" ? src.limit : {};
  const modalities = src.modalities && typeof src.modalities === "object" ? src.modalities : {};
  const reasoning =
    typeof src.reasoning === "boolean" ? src.reasoning
      : src.reasoning && typeof src.reasoning === "object" && typeof src.reasoning.enabled === "boolean" ? src.reasoning.enabled
        : undefined;
  return normModelMeta({
    name: src.name,
    contextWindow: limit.context,
    maxTokens: limit.output,
    reasoning,
    input: Array.isArray(modalities.input) ? modalities.input : src.input,
  });
}

/** 批量：模型 id → 展示元数据（取不到元数据的 id 不进表）。 */
function metaById(ids, rawOf) {
  const out = {};
  for (const id of ids || []) {
    const m = pickModelMeta(rawOf(id));
    if (m) out[String(id)] = m;
  }
  return out;
}

/** 规整 baseUrl（剥尾 /，空值 null）。 */
function normBaseUrl(u) {
  const s = String(u || "").trim();
  return s ? s.replace(/\/+$/, "") : null;
}

/** 草稿兜底规整：补默认字段、去掉未声明 key。 */
function normalizeDraft(d) {
  return {
    key: String(d.key || ""),
    label: String(d.label || d.key || ""),
    sourceId: String(d.sourceId || ""),
    baseUrl: normBaseUrl(d.baseUrl),
    api: String(d.api || ""),
    apiKey: d.apiKey ? String(d.apiKey) : null,
    apiKeyEnv: d.apiKeyEnv ? String(d.apiKeyEnv) : null,
    models: Array.isArray(d.models)
      ? d.models
          .map((m) => (typeof m === "string" ? { id: m } : m && m.id ? { id: String(m.id), name: m.name ? String(m.name) : undefined, contextWindow: m.contextWindow, maxTokens: m.maxTokens } : null))
          .filter((m) => m && m.id)
      : [],
    warnings: Array.isArray(d.warnings) ? d.warnings.map(String) : [],
    modelMeta: normModelMetaMap(d.modelMeta),
  };
}

// ---------------- 已有模型（预览标注「新增 / 已有」） ----------------

/** models.json 里该 provider 已有的模型 id（条目可能是字符串或 {id|model}）。 */
function knownModelIds(providersMap, providerKey) {
  const prov = providersMap && typeof providersMap === "object" ? providersMap[providerKey] : null;
  const models = prov && Array.isArray(prov.models) ? prov.models : [];
  const ids = [];
  for (const m of models) {
    const id = typeof m === "string" ? m : m && (m.id || m.model);
    if (id) ids.push(String(id));
  }
  return ids;
}

// ---------------- 状态机（源级，§4.3） ----------------

function sourceState({ available, record, fingerprint }) {
  if (!available) return record ? "source-gone" : null;
  if (!record) return "available-new";
  return record.fingerprint && record.fingerprint === fingerprint ? "unchanged" : "changed";
}

// ---------------- 冲突检测（草稿 vs models.json providers） ----------------

/** 返回 Map<draftKey, {conflict:"none"|"merge"|"override", overrideFields:string[]}> */
function detectConflicts(drafts, providersMap) {
  const out = new Map();
  const provs = providersMap && typeof providersMap === "object" ? providersMap : {};
  for (const d of drafts || []) {
    const cur = provs[d.key];
    if (!cur || typeof cur !== "object") { out.set(d.key, { conflict: "none", overrideFields: [] }); continue; }
    const overrideFields = [];
    if (normBaseUrl(cur.baseUrl) !== d.baseUrl) overrideFields.push("baseUrl");
    if (cur.api && cur.api !== d.api) overrideFields.push("api");
    out.set(d.key, { conflict: overrideFields.length ? "override" : "merge", overrideFields });
  }
  return out;
}

module.exports = {
  MARKER_VERSION,
  markerPath,
  readMarker,
  writeMarker,
  isFirstRun,
  stableStringify,
  sourceFingerprint,
  draftFingerprintInput,
  snapshotDraft,
  keyHint,
  sanitizeId,
  normBaseUrl,
  normalizeDraft,
  pickModelMeta,
  metaById,
  knownModelIds,
  sourceState,
  detectConflicts,
};
