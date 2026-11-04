"use strict";
/**
 * effective-models · provider「生效模型清单」解析 —— 全工作区唯一实现。
 *
 * 背景：models.json 里很多 provider 只配 key+baseUrl、不配 models 列表（如 zai-coding-cn），
 * 真实模型清单在 pi 模型 store（~/.pi/agent/models-store.json）。此前各处（向导已配置页/
 * check 探测/聚合成员池/引擎槽位）各自手写这份兜底逻辑，语义渐渐漂移——本模块收敛为一份。
 *
 * 解析规则（只在这里写一次）：
 *   1. provider 集合 = 调用方传入的 models.json providers（combo/oauth 过滤由调用方负责）
 *   2. 候选模型清单：
 *      · 无 runtime：显式 models[]（非空优先）；为空 → pi 模型 store 同名 provider 补全
 *      · 有 runtime（pi ModelRuntime 快照）：runtime 条目为主；显式非空时过滤到显式 id 集、
 *        显式缺漏补尾（runtime 快照滞后于向导写入的兜底）；两者皆空 → 该 provider 清单为空
 *   3. 元数据优先级：runtime > 显式定义 > store 定义
 *   4. baseUrl = provider.baseUrl || 条目级 baseUrl || store 首条 baseUrl（provider 级直连地址优先，
 *      避免 pmc 代理改写后的 127.0.0.1 地址被当成探测目标）
 *   5. api = runtime.api || model.api || provider.api || store 模型 api || "openai-completions"
 *   6. 每个模型带 _source: "pi" | "models.json" | "store"
 *
 * 分发：部署脚本把本文件拷贝到扩展目录（require("./effective-models.cjs")）；
 *       pi-models-combo 以 vendored 副本随 npm 发布（src/effective-models.cjs，勿改副本）。
 */

/** 归一化模型 id（pi 语义：去 ~ 前缀、:free/:batch 后缀）。 */
function normModelId(s) {
  return String(s ?? "").replace(/^~/, "").replace(/:free$/, "").replace(/:batch$/, "");
}

/**
 * @param {{providers?: object, store?: object|null, runtime?: Array<{provider:string,id:string,api?:string,baseUrl?:string,reasoning?:boolean}>|null}} args
 *   providers: models.json 的 providers 对象
 *   store:     pi 模型 store 数据（可选）
 *   runtime:   pi ModelRuntime 快照条目（可选；check 探测路径传入）
 * @returns Map<pid, { baseUrl, api, keyCount, models:[{id,name,api,baseUrl,contextWindow,maxTokens,input,reasoning,cost,_source}] }>
 */
function resolveProviderModels({ providers = {}, store = null, runtime = null } = {}) {
  const out = new Map();
  // runtime 条目按 provider 预分组
  const rtByPid = new Map();
  for (const r of runtime || []) {
    if (!r || !r.provider || !r.id) continue;
    if (!rtByPid.has(r.provider)) rtByPid.set(r.provider, []);
    rtByPid.get(r.provider).push(r);
  }

  for (const [pid, p] of Object.entries(providers || {})) {
    if (!p || typeof p !== "object") continue;
    const keyCount = Array.isArray(p.apiKeys) ? p.apiKeys.length : (p.apiKey ? 1 : 0);
    const sp = store && typeof store[pid] === "object" ? store[pid] : null;
    const sm = sp && Array.isArray(sp.models) ? sp.models : [];
    const rt = rtByPid.get(pid) || null;

    // provider 级 baseUrl 缺失 → 取 store/runtime 首条模型的真实地址
    let baseUrl = String(p.baseUrl || "");
    if (!baseUrl) {
      const first = sm.length ? (typeof sm[0] === "object" ? sm[0] : null) : (rt && rt.length ? rt[0] : null);
      baseUrl = String((first && (first.baseUrl ?? first.baseUrl)) || "");
    }
    if (!baseUrl && rt && rt.length) baseUrl = String(rt[0].baseUrl || "");

    const explicitDefs = Array.isArray(p.models) ? p.models : [];
    const explicitIds = new Set(explicitDefs.map((m) => normModelId((m && (m.id || m.model)) || m)).filter(Boolean));
    const byNorm = new Map(); // normId → model
    const push = (m, src) => {
      const nm = normModelId(m.id);
      if (!nm || byNorm.has(nm)) return;
      byNorm.set(nm, { ...m, _source: src });
    };

    if (rt && rt.length) {
      const allowAll = explicitIds.size === 0;
      for (const r of rt) {
        if (!allowAll && !explicitIds.has(normModelId(r.id))) continue;
        const ed = explicitDefs.find((m) => normModelId((m && (m.id || m.model)) || m) === normModelId(r.id)) || {};
        push({
          id: String(r.id),
          name: ed.name || String(r.id),
          api: String(r.api || ed.api || p.api || "openai-completions"),
          baseUrl: String(p.baseUrl || r.baseUrl || ed.baseUrl || "") || null,
          contextWindow: typeof ed.contextWindow === "number" ? ed.contextWindow : null,
          maxTokens: typeof ed.maxTokens === "number" ? ed.maxTokens : null,
          input: Array.isArray(ed.input) ? ed.input.map(String) : [],
          reasoning: !!(r.reasoning || ed.reasoning),
          cost: ed.cost && typeof ed.cost === "object" ? ed.cost : null,
          // 透传模型级 compat：代理需要 maxTokensField 决定 openai 协议走 max_tokens 还是 max_completion_tokens。
          // 整个对象透传比逐字段更稳（未来加新字段不用同步改这里）。
          compat: ed.compat && typeof ed.compat === "object" ? ed.compat : null,
          ...(ed.combo ? { combo: true } : {}),
          ...(ed.enabled === false ? { enabled: false } : {}),
        }, "pi");
      }
      for (const m of explicitDefs) {
        const id = String((m && (m.id || m.model)) || m || "");
        if (!id || !normModelId(id) || byNorm.has(normModelId(id))) continue;
        push({
          id, name: (m && m.name) || id,
          api: String((m && m.api) || p.api || "openai-completions"),
          baseUrl: String(p.baseUrl || (m && m.baseUrl) || "") || null,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
          maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : null,
          input: Array.isArray(m.input) ? m.input.map(String) : [],
          reasoning: !!(m && m.reasoning),
          cost: m.cost && typeof m.cost === "object" ? m.cost : null,
          compat: m.compat && typeof m.compat === "object" ? m.compat : null,
          ...(m && m.combo ? { combo: true } : {}),
          ...(m && m.enabled === false ? { enabled: false } : {}),
        }, "models.json");
      }
    } else {
      let list = explicitDefs;
      let src = "models.json";
      if (!list.length && sm.length) { list = sm; src = "store"; }
      for (const m of list) {
        if (!m) continue;
        if (typeof m !== "object") {
          const nm = normModelId(String(m));
          if (nm) push({ id: nm, name: nm, api: String(p.api || "openai-completions"), baseUrl: String(p.baseUrl || baseUrl || "") || null, contextWindow: null, maxTokens: null, input: [], reasoning: false, cost: null }, src);
          continue;
        }
        const rawId = String(m.id || m.model || m.name || "");
        if (!rawId || !normModelId(rawId)) continue;
        push({
          id: rawId, name: m.name || rawId,
          api: String(m.api || p.api || "openai-completions"),
          baseUrl: String(m.baseUrl || p.baseUrl || baseUrl || "") || null,
          contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : null,
          maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : null,
          input: Array.isArray(m.input) ? m.input.map(String) : [],
          reasoning: !!m.reasoning,
          cost: m.cost && typeof m.cost === "object" ? m.cost : null,
          combo: !!m.combo,
          ...(m.enabled === false ? { enabled: false } : {}),
          // store 路径同样透传 compat（同源语义）
          compat: m.compat && typeof m.compat === "object" ? m.compat : null,
        }, src);
      }
    }

    out.set(pid, { baseUrl, api: String(p.api || ""), keyCount, models: [...byNorm.values()] });
  }

  // 第二遍：跨 provider 同 id 参数补全——同一真实模型的参数应一致（多 key/多入口只是镜像）。
  // 对缺 contextWindow/maxTokens/input/reasoning 的条目，从其它 provider 同 id 模型的更完整定义抄。
  // 用户显式给出的字段优先（源条目已有字段不覆盖）。
  const metaIndex = new Map(); // normId → 完整度得分最高条目
  const completeness = (m) => [m.contextWindow != null, m.maxTokens != null, (m.input || []).length > 0, m.reasoning, m.cost != null].filter(Boolean).length;
  for (const entry of out.values()) {
    for (const m of entry.models) {
      const nm = normModelId(m.id);
      const prev = metaIndex.get(nm);
      if (!prev || completeness(m) > completeness(prev)) metaIndex.set(nm, m);
    }
  }
  for (const entry of out.values()) {
    for (const m of entry.models) {
      const donor = metaIndex.get(normModelId(m.id));
      if (!donor || donor === m) continue;
      if (m.contextWindow == null) m.contextWindow = donor.contextWindow;
      if (m.maxTokens == null) m.maxTokens = donor.maxTokens;
      if (!(m.input || []).length && donor.input && donor.input.length) m.input = donor.input;
      if (!m.reasoning && donor.reasoning) m.reasoning = true;
      if (m.cost == null) m.cost = donor.cost;
    }
  }
  return out;
}

/** 在解析结果的某个 provider 下按归一化 id 找模型条目。 */
function findModel(resolvedPid, modelId) {
  if (!resolvedPid) return null;
  const nm = normModelId(modelId);
  return resolvedPid.models.find((m) => normModelId(m.id) === nm) || null;
}

module.exports = { resolveProviderModels, normModelId, findModel };
