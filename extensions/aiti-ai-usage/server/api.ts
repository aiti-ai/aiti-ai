/**
 * aiti-ai-usage · REST API（GET 查询 + POST sync）。
 * 路径前缀：/api/extensions/aiti-ai-usage/*
 */
import { runtime } from "./runtime.ts";
import { localDay } from "../lib/db.ts";

export interface ExtApiCtx {
  configDir: string;
  path: string[];
  searchParams: URLSearchParams;
}

// ---------------------------------------------------------------- 范围解析

interface Range { where: string; params: (string | number)[]; label: string; months: boolean }

/** col：day 列的限定名（join 查询里传 "m.day"/"k.day"）。 */
function resolveRange(sp: URLSearchParams, col = "day"): Range {
  const month = sp.get("month");
  const day = sp.get("day");
  const days = Math.max(0, parseInt(sp.get("days") ?? "0", 10) || 0);
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  // 自定义起止（含端）：from/to 均为 YYYY-MM-DD，可只给一端
  const from = sp.get("from");
  const to = sp.get("to");
  if ((from && DAY.test(from)) || (to && DAY.test(to))) {
    const conds: string[] = [];
    const params: string[] = [];
    if (from && DAY.test(from)) { conds.push(`${col} >= ?`); params.push(from); }
    if (to && DAY.test(to)) { conds.push(`${col} <= ?`); params.push(to); }
    const spanDays = from && to
      ? Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86400000)) : 0;
    return { where: `WHERE ${conds.join(" AND ")}`, params,
      label: `${from || "…"} ~ ${to || "…"}`, months: spanDays > 60 };
  }
  if (day && DAY.test(day)) {
    return { where: `WHERE ${col} = ?`, params: [day], label: day, months: false };
  }
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    return { where: `WHERE ${col} LIKE ?`, params: [`${month}-%`], label: month, months: false };
  }
  if (days > 0) {
    const since = localDay(Date.now() - days * 86400000);
    // 窗口 > 60 天时趋势图自动切月粒度
    return { where: `WHERE ${col} >= ?`, params: [since], label: `${days}d`, months: days > 60 };
  }
  return { where: "", params: [], label: "all", months: true };
}

// ---------------------------------------------------------------- provider/model 过滤

interface ColFilters { conds: string; params: (string | number)[] }

/**
 * provider/model/agent 通用过滤（query 参数 provider=、model=、agent=，精确匹配）。
 * 返回裸条件片段（无 AND 前缀，可为空）+ 参数；列名可带表别名（如 "m.provider"）。
 * agentCol 仅会话口径（usage_caliber / daily_model）传；代理口径不传（key_req 无 agent 概念）。
 * 拼接用 mergeWhere() —— 空片段/空范围 WHERE 都要正确处理。
 */
function resolveFilters(sp: URLSearchParams, providerCol = "provider", modelCol = "model", agentCol?: string): ColFilters {
  const provider = (sp.get("provider") ?? "").trim();
  const model = (sp.get("model") ?? "").trim();
  const agent = (sp.get("agent") ?? "").trim();
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (provider) { conds.push(`${providerCol} = ?`); params.push(provider); }
  if (model) { conds.push(`${modelCol} = ?`); params.push(model); }
  if (agent && agentCol) { conds.push(`${agentCol} = ?`); params.push(agent); }
  return { conds: conds.join(" AND "), params };
}

/** range WHERE（"WHERE …" 或 ""）与过滤片段合并为完整 WHERE 子句。 */
function mergeWhere(rangeWhere: string, f: ColFilters): string {
  const base = rangeWhere.replace(/^WHERE\b\s*/i, "");
  const conds = [base, f.conds].filter(Boolean).join(" AND ");
  return conds ? ` WHERE ${conds}` : "";
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- handlers

function status() {
  const rt = runtime();
  const one = (sql: string) => (rt.usage.db.prepare(sql).get() as any) ?? {};
  return json({
    db: "usage.sqlite",
    sessions: one(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN state='running' THEN 1 ELSE 0 END),0) running,
                   COALESCE(SUM(archived),0) archived FROM sessions`),
    msgUsage: one("SELECT COUNT(*) n FROM msg_usage"),
    keyReq: one("SELECT COUNT(*) n FROM key_req"),
    clients: one("SELECT COUNT(*) n FROM clients").n,
    mapped: one("SELECT COUNT(*) n FROM client_sessions").n,
  });
}

function overview(sp: URLSearchParams) {
  const rt = runtime();
  const db = rt.usage.db;
  const r = resolveRange(sp);
  const f = resolveFilters(sp, "provider", "model", "agent"); // usage_caliber/daily_model 带 agent
  const fp = resolveFilters(sp, "provider", "model");           // 代理口径（daily_key 无 agent，忽略 agent 参数）

  const totals = db.prepare(`
    SELECT COUNT(*) msgs, COALESCE(SUM(total_tokens),0) tokens, COALESCE(SUM(cost_total),0) cost
    FROM usage_caliber ${mergeWhere(r.where, f)}`).get(...r.params, ...f.params) as any;
  const keyTotals = db.prepare(`
    SELECT COALESCE(SUM(reqs),0) reqs, COALESCE(SUM(err429),0) err429
    FROM daily_key ${mergeWhere(r.where, fp)}`).get(...r.params, ...fp.params) as any;

  const g = r.months ? "substr(day,1,7)" : "day";
  const series = db.prepare(`
    SELECT ${g} bucket, provider,
           SUM(total_tokens) tokens, SUM(cost_total) cost
    FROM usage_caliber ${mergeWhere(r.where, f)}
    GROUP BY bucket, provider ORDER BY bucket`).all(...r.params, ...f.params);

  const topModels = db.prepare(`
    SELECT agent, provider, model, SUM(msgs) msgs, SUM(total_tokens) tokens, SUM(cost_total) cost
    FROM daily_model ${mergeWhere(r.where, f)}
    GROUP BY agent, provider, model ORDER BY tokens DESC LIMIT 10`).all(...r.params, ...f.params);

  // 今日 / 近7天 / 全部 KPI（不受所选范围影响，固定口径；含消息数）
  const today = localDay(Date.now());
  const d7 = localDay(Date.now() - 7 * 86400000);
  // 固定窗口 KPI 同样跟随 provider/model/agent 过滤（否则过滤后卡片数字不变会造成误导）
  const kpiRow = (where: string, params: (string | number)[]) =>
    db.prepare(`SELECT COUNT(*) msgs, COALESCE(SUM(total_tokens),0) t, COALESCE(SUM(cost_total),0) c
                FROM usage_caliber ${mergeWhere(where, f)}`).get(...params, ...f.params) as any;
  // 同窗口的代理口径请求（仅多 key 轮转渠道；daily_key 由 flushDaily 落库，极端情况下略滞后）
  const proxyRow = (where: string, params: (string | number)[]) =>
    db.prepare(`SELECT COALESCE(SUM(reqs),0) reqs, COALESCE(SUM(err429),0) err429
                FROM daily_key ${mergeWhere(where, fp)}`).get(...params, ...fp.params) as any;
  // 同窗口的用户输入（human 口径；报价与输入统计见 lib/user-quotes.ts）
  const userRow = (where: string, params: (string | number)[]) =>
    db.prepare(`SELECT COUNT(*) msgs, COALESCE(SUM(CASE WHEN quote_lines > 0 THEN 1 ELSE 0 END),0) quoted
                FROM user_msgs ${mergeWhere(where, { conds: "kind = 'human'", params: [] })}`)
      .get(...params) as any;
  const win = (where: string, params: (string | number)[]) => {
    const k = kpiRow(where, params), p = proxyRow(where, params), u = userRow(where, params);
    return { tokens: k.t, cost: k.c, msgs: k.msgs, reqs: p.reqs, err429: p.err429, userMsgs: u.msgs, userQuoted: u.quoted };
  };
  const todayK = win("WHERE day >= ?", [today]);
  const weekK = win("WHERE day >= ?", [d7]);
  const m30K = win("WHERE day >= ?", [localDay(Date.now() - 30 * 86400000)]);
  const allK = win("", []);

  return json({
    label: r.label,
    totals, keyTotals, series, topModels,
    fixed: { today: todayK, week: weekK, days30: m30K, all: allK },
  });
}

function models(sp: URLSearchParams) {
  const rt = runtime();
  const r = resolveRange(sp);
  const f = resolveFilters(sp, "provider", "model", "agent");
  const rows = rt.usage.db.prepare(`
    SELECT agent, provider, model, SUM(msgs) msgs, SUM(input) input, SUM(output) output,
           SUM(cache_read) cacheRead, SUM(cache_write) cacheWrite, SUM(reasoning) reasoning,
           SUM(total_tokens) totalTokens, SUM(cost_total) cost
    FROM daily_model ${mergeWhere(r.where, f)}
    GROUP BY agent, provider, model ORDER BY totalTokens DESC`).all(...r.params, ...f.params);
  return json({ label: r.label, rows });
}

function keys(sp: URLSearchParams) {
  const rt = runtime();
  const r = resolveRange(sp);            // daily_key（裸 day）
  const rk = resolveRange(sp, "k.day");  // join 归因查询（k 别名）
  const f = resolveFilters(sp);                          // daily_key（裸 provider/model）
  const fk = resolveFilters(sp, "k.provider", "k.model"); // key_req 归因查询（k 别名）
  const rows = rt.usage.db.prepare(`
    SELECT provider, key_name keyName, SUM(reqs) reqs, SUM(ok) ok, SUM(err429) err429,
           SUM(input) input, SUM(output) output, SUM(cache_read) cacheRead, SUM(cache_write) cacheWrite
    FROM daily_key ${mergeWhere(r.where, f)}
    GROUP BY provider, key_name ORDER BY reqs DESC`).all(...r.params, ...f.params);
  // 每 key 关联会话数（经 client 归因）
  let sessRows: Array<{ provider: string; keyName: string; client: string; sessions: number }> = [];
  try {
    sessRows = rt.usage.db.prepare(`
      SELECT k.provider, k.key_name keyName, cs.client client, COUNT(DISTINCT cs.session_id) sessions
      FROM key_req k JOIN client_sessions cs ON cs.client = k.client
      ${mergeWhere(rk.where, fk)}
      GROUP BY k.provider, k.key_name, cs.client`).all(...rk.params, ...fk.params) as Array<{ provider: string; keyName: string; client: string; sessions: number }>;
  } catch { /* 映射未就绪 */ }
  // 聚合到 key 粒度
  const byKey = new Map<string, { provider: string; keyName: string; clients: Set<string>; sessions: number }>();
  for (const s of sessRows) {
    const k = `${s.provider}|${s.keyName}`;
    const e = byKey.get(k) ?? { provider: s.provider, keyName: s.keyName, clients: new Set(), sessions: 0 };
    e.clients.add(s.client);
    e.sessions += Number(s.sessions);
    byKey.set(k, e);
  }
  for (const row of rows) {
    const m = byKey.get(`${row.provider}|${row.keyName}`);
    (row as any).sessions = m?.sessions ?? 0;
    (row as any).clients = m?.clients.size ?? 0;
  }
  return json({ label: r.label, rows });
}

/**
 * GET userstat?days=N|day=|month=|from=&to=[&kind=human|agent|external|all]
 * 用户输入统计（user_msgs，扫描自会话 JSONL）：消息数 / 引用消息 / 引用行 /
 * 每日（或月）趋势 / 引用类型分布 / Top 工作区。
 * 默认 kind=human（人类输入）；kind 分布（human/agent/external）恒随范围返回供对照。
 */
function userStat(sp: URLSearchParams) {
  const rt = runtime();
  const db = rt.usage.db;
  const r = resolveRange(sp, "day");
  const kindRaw = (sp.get("kind") ?? "").trim() || "human";
  const kind = ["human", "agent", "external", "all"].includes(kindRaw) ? kindRaw : "human";

  // 条件构造：alias 为空=裸表；alias="u."=join sessions 的查询（列名 day/kind 加前缀）
  const conds = (alias: string, withKind = true) => {
    const out: string[] = [];
    const params: (string | number)[] = [];
    const base = r.where.replace(/^WHERE\b\s*/i, "");
    if (base) { out.push(alias ? base.replace(/\bday\b/g, `${alias}day`) : base); params.push(...r.params); }
    if (withKind && kind !== "all") { out.push(`${alias}kind = ?`); params.push(kind); }
    return { where: out.length ? `WHERE ${out.join(" AND ")}` : "", params };
  };
  const c = conds("");

  const totals = db.prepare(`
    SELECT COUNT(*) msgs,
           COALESCE(SUM(CASE WHEN quote_lines > 0 THEN 1 ELSE 0 END),0) quoted,
           COALESCE(SUM(quote_lines),0) quoteLines,
           COALESCE(SUM(chars),0) chars,
           COALESCE(SUM(CASE WHEN image = 1 THEN 1 ELSE 0 END),0) images,
           COUNT(DISTINCT session_id) sessions
    FROM user_msgs ${c.where}`).get(...c.params) as any;
  totals.quoteRate = totals.msgs > 0 ? totals.quoted / totals.msgs : 0;
  totals.avgChars = totals.msgs > 0 ? Math.round(totals.chars / totals.msgs) : 0;

  // kind 分布（不受 kind 参数影响，只跟随范围）——展示「另有自动会话/导入会话多少」
  const ck = conds("", false);
  const byKind = db.prepare(`
    SELECT kind, COUNT(*) msgs FROM user_msgs ${ck.where} GROUP BY kind`).all(...ck.params);

  const g = r.months ? "substr(day,1,7)" : "day";
  const series = db.prepare(`
    SELECT ${g} bucket, COUNT(*) msgs,
           COALESCE(SUM(CASE WHEN quote_lines > 0 THEN 1 ELSE 0 END),0) quoted,
           COALESCE(SUM(quote_lines),0) quoteLines
    FROM user_msgs ${c.where} GROUP BY bucket ORDER BY bucket`).all(...c.params);

  // 引用类型分布（命中消息数；gt 用 quote_lines>0 统计，> 行含嵌套）
  const cq = conds("");
  const qc = mergeWhere(cq.where, { conds: "quote_kinds != ''", params: [] });
  const quoteTotals = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN quote_lines > 0 THEN 1 ELSE 0 END),0) gt,
           COALESCE(SUM(CASE WHEN instr(quote_kinds,'gtnested') > 0 THEN 1 ELSE 0 END),0) gtnested,
           COALESCE(SUM(CASE WHEN instr(quote_kinds,'gt3') > 0 THEN 1 ELSE 0 END),0) gt3,
           COALESCE(SUM(CASE WHEN instr(quote_kinds,'bbcode') > 0 THEN 1 ELSE 0 END),0) bbcode,
           COALESCE(SUM(CASE WHEN instr(quote_kinds,'attrib') > 0 THEN 1 ELSE 0 END),0) attrib,
           COALESCE(SUM(CASE WHEN instr(quote_kinds,'fileref') > 0 THEN 1 ELSE 0 END),0) fileref
    FROM user_msgs ${cq.where}`).get(...cq.params) as any;
  const quoteKinds = ["gt", "gtnested", "gt3", "bbcode", "attrib", "fileref"]
    .map((k) => ({ kind: k, msgs: Number(quoteTotals[k] ?? 0) }))
    .filter((k) => k.msgs > 0);

  const cu = conds("u.");
  const workspaces = db.prepare(`
    SELECT COALESCE(NULLIF(s.cwd,''),'(未知)') cwd, COUNT(*) msgs,
           COALESCE(SUM(CASE WHEN u.quote_lines > 0 THEN 1 ELSE 0 END),0) quoted
    FROM user_msgs u LEFT JOIN sessions s ON s.id = u.session_id
    ${cu.where}
    GROUP BY cwd ORDER BY msgs DESC LIMIT 12`).all(...cu.params);

  return json({ label: r.label, kind, totals, byKind, series, quoteKinds, workspaces });
}

function sessionsList(sp: URLSearchParams) {
  const rt = runtime();
  const limit = Math.min(500, Math.max(1, parseInt(sp.get("limit") ?? "100", 10) || 100));
  const offset = Math.max(0, parseInt(sp.get("offset") ?? "0", 10) || 0);
  const q = (sp.get("q") ?? "").trim();
  const state = (sp.get("state") ?? "").trim();
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (q) { conds.push("(title LIKE ? OR cwd LIKE ? OR id LIKE ?)"); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (state) { conds.push("state = ?"); params.push(state); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = rt.usage.db.prepare(`
    SELECT id, cwd, title, started_at startedAt, last_ts lastTs, msgs,
           total_tokens totalTokens, cost_total cost, archived, state, end_reason endReason
    FROM sessions ${where}
    ORDER BY COALESCE(last_ts, started_at, 0) DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = (rt.usage.db.prepare(`SELECT COUNT(*) n FROM sessions ${where}`).get(...params) as any).n;
  return json({ rows, total, limit, offset });
}

// ---------------------------------------------------------------- 组合维度透视（matrix）

// 维度 SQL 表达式。workspace = 会话 cwd（NULL/空归「(未知)」）；hour = 本地时区 0-23 时段。
// 会话口径：m = usage_caliber（pi ∪ 外部 agent），s = sessions；代理口径：k = key_req，cs = 去重归因，s = sessions。
const MSG_DIMS: Record<string, string> = {
  workspace: `COALESCE(NULLIF(s.cwd,''),'(未知)')`,
  provider: "m.provider",
  model: `m.provider || '/' || m.model`,
  agent: "m.agent",
  hour: `strftime('%H', m.ts / 1000, 'unixepoch', 'localtime')`,
  day: "m.day",
};
const PROXY_DIMS: Record<string, string> = {
  workspace: `COALESCE(NULLIF(s.cwd,''),'(未知)')`,
  key: `COALESCE(NULLIF(k.key_name,''),'(direct)')`,
  provider: "k.provider",
  model: "COALESCE(k.model,'?')",
  hour: `strftime('%H', k.ts / 1000, 'unixepoch', 'localtime')`,
  day: "k.day",
};

/**
 * GET matrix?dims=workspace,key,hour,...[&days=30|day=|month=][&provider=&model=]（兼容旧参数 dim / dim2）
 * 1-N 维组合聚合（不限维数，去重后上限 = 维度池；LIMIT 兑底防组合爆炸）：维度 ∈ workspace/provider/model/hour/day + key（仅代理口径）。
 * provider/model 为可选精确过滤（与维度无关，先过滤后聚合）。
 * dim 或 dims 含 key → 代理口径（key_req 经 client→session 归因）；否则会话口径（msg_usage）。
 * 每行返回全部指标列（前端多选显示/导出）：
 *   会话口径 msgs/tokens/cost/input/output/cacheRead/cacheWrite/reasoning
 *   代理口径 reqs/ok/err429/errOther/tokens/input/output/cacheRead/cacheWrite
 */
function matrix(sp: URLSearchParams) {
  const rt = runtime();
  const dimsParam = (sp.get("dims") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let dims = dimsParam.length ? dimsParam : (() => {
    const arr = [sp.get("dim") ?? "workspace"];
    const d2 = sp.get("dim2") ?? "";
    if (d2 && d2 !== arr[0]) arr.push(d2);
    return arr;
  })();
  dims = [...new Set(dims)]; // 去重后不限维数（自然上限 = 维度池大小 6）；LIMIT 兑底防组合爆炸
  const useProxy = dims.includes("key");
  const map = useProxy ? PROXY_DIMS : MSG_DIMS;
  if (dims.some((d) => !map[d])) {
    const bad = dims.find((d) => !map[d]);
    return json({ error: `unknown dim '${bad}'（${useProxy ? "代理" : "会话"}口径可用：${Object.keys(map).join(", ")}）` }, 400);
  }
  const r = resolveRange(sp, useProxy ? "k.day" : "m.day");
  const f = useProxy ? resolveFilters(sp, "k.provider", "k.model") : resolveFilters(sp, "m.provider", "m.model", "m.agent");
  const selects = dims.map((_, i) => `${map[dims[i]]} AS d${i + 1}`).join(", ");
  const groups = dims.map((_, i) => `d${i + 1}`).join(", ");
  const sql = useProxy ? `
    SELECT ${selects}, COUNT(*) AS reqs,
           SUM(CASE WHEN k.status BETWEEN 200 AND 399 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN k.status = 429 THEN 1 ELSE 0 END) AS err429,
           SUM(CASE WHEN k.status >= 400 AND k.status != 429 THEN 1 ELSE 0 END) AS errOther,
           COALESCE(SUM(COALESCE(k.input,0) + COALESCE(k.output,0)),0) AS tokens,
           COALESCE(SUM(COALESCE(k.input,0)),0) AS input,
           COALESCE(SUM(COALESCE(k.output,0)),0) AS output,
           COALESCE(SUM(COALESCE(k.cache_read,0)),0) AS cacheRead,
           COALESCE(SUM(COALESCE(k.cache_write,0)),0) AS cacheWrite
    FROM key_req k
    JOIN (SELECT DISTINCT client, session_id FROM client_sessions) cs ON cs.client = k.client
    JOIN sessions s ON s.id = cs.session_id
    ${mergeWhere(r.where, f)}
    GROUP BY ${groups} ORDER BY reqs DESC LIMIT 200000`
    : `
    SELECT ${selects}, COUNT(*) AS msgs,
           COALESCE(SUM(m.total_tokens),0) AS tokens, COALESCE(SUM(m.cost_total),0) AS cost,
           COALESCE(SUM(m.input),0) AS input, COALESCE(SUM(m.output),0) AS output,
           COALESCE(SUM(m.cache_read),0) AS cacheRead, COALESCE(SUM(m.cache_write),0) AS cacheWrite,
           COALESCE(SUM(m.reasoning),0) AS reasoning
    FROM usage_caliber m LEFT JOIN sessions s ON s.id = m.session_id
    ${mergeWhere(r.where, f)}
    GROUP BY ${groups} ORDER BY tokens DESC LIMIT 200000`;
  const rows = rt.usage.db.prepare(sql).all(...r.params, ...f.params);
  return json({ label: r.label, caliber: useProxy ? "proxy" : "session", dims, rows });
}

/** 单会话的 key 归因明细。 */
function sessionKeys(sessionId: string) {
  const rt = runtime();
  const rows = rt.usage.db.prepare(`
    SELECT k.provider, k.key_name keyName, k.status, COUNT(*) reqs,
           COALESCE(SUM(k.input),0) input, COALESCE(SUM(k.output),0) output
    FROM key_req k
    JOIN client_sessions cs ON cs.client = k.client
    WHERE cs.session_id = ?
    GROUP BY k.provider, k.key_name, k.status ORDER BY reqs DESC`).all(sessionId);
  return json({ sessionId, rows });
}

/**
 * GET facets[?provider=x] —— 筛选下拉选项：agents / providers / models 全量；models 可按 provider 联动过滤。
 * 数据源 = 会话口径（usage_caliber：pi ∪ 外部 agent）∪ 代理口径（key_req）；key_req 的 NULL/空/'?' 模型不进列表。
 */
function facets(sp: URLSearchParams) {
  const rt = runtime();
  const provider = (sp.get("provider") ?? "").trim();
  const providers = rt.usage.db.prepare(`
    SELECT DISTINCT provider FROM usage_caliber
    UNION SELECT DISTINCT provider FROM key_req
    ORDER BY provider`).all().map((r: any) => String(r.provider)).filter(Boolean);
  const models = rt.usage.db.prepare(`
    SELECT DISTINCT model FROM usage_caliber ${provider ? "WHERE provider = ?" : ""}
    UNION SELECT DISTINCT model FROM key_req
      WHERE model IS NOT NULL AND model != '' AND model != '?' ${provider ? "AND provider = ?" : ""}
    ORDER BY model`).all(...(provider ? [provider] : []), ...(provider ? [provider] : []))
    .map((r: any) => String(r.model)).filter(Boolean);
  const modelCombos = rt.usage.db.prepare(`
    SELECT DISTINCT provider || '/' || model mc FROM usage_caliber ${provider ? "WHERE provider = ?" : ""}
    ORDER BY mc`).all(...(provider ? [provider] : [])).map((r: any) => String(r.mc)).filter(Boolean);
  const agents = rt.usage.db.prepare(`
    SELECT DISTINCT agent FROM usage_caliber ORDER BY agent`).all().map((r: any) => String(r.agent)).filter(Boolean);
  const workspaces = rt.usage.db.prepare(`
    SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != '' ORDER BY cwd`).all()
    .map((r: any) => String(r.cwd));
  const keys = rt.usage.db.prepare(`
    SELECT DISTINCT key_name FROM key_req WHERE key_name IS NOT NULL AND key_name != '' ORDER BY key_name`).all()
    .map((r: any) => String(r.key_name));
  return json({ agents, providers, models, modelCombos, workspaces, keys });
}

// ---------------------------------------------------------------- 使用趋势（trend line）

const UNKNOWN_WS = "(未知)";
const MSG_TREND_EXPRS: Record<string, string> = {
  msgs: "COUNT(*)",
  tokens: "COALESCE(SUM(m.total_tokens),0)",
  cost: "COALESCE(SUM(m.cost_total),0)",
  input: "COALESCE(SUM(m.input),0)",
  output: "COALESCE(SUM(m.output),0)",
  cacheRead: "COALESCE(SUM(m.cache_read),0)",
  cacheWrite: "COALESCE(SUM(m.cache_write),0)",
  reasoning: "COALESCE(SUM(m.reasoning),0)",
};
const PROXY_TREND_EXPRS: Record<string, string> = {
  reqs: "COUNT(*)",
  ok: "SUM(CASE WHEN k.status BETWEEN 200 AND 399 THEN 1 ELSE 0 END)",
  err429: "SUM(CASE WHEN k.status = 429 THEN 1 ELSE 0 END)",
  errOther: "SUM(CASE WHEN k.status >= 400 AND k.status != 429 THEN 1 ELSE 0 END)",
  tokens: "COALESCE(SUM(COALESCE(k.input,0) + COALESCE(k.output,0)),0)",
  input: "COALESCE(SUM(COALESCE(k.input,0)),0)",
  output: "COALESCE(SUM(COALESCE(k.output,0)),0)",
  cacheRead: "COALESCE(SUM(COALESCE(k.cache_read,0)),0)",
  cacheWrite: "COALESCE(SUM(COALESCE(k.cache_write,0)),0)",
};

/**
 * 趋势维度值过滤（values 为空 → 不过滤，后端取 Top N）。
 * workspace 的 (未知) 特殊处理：NULL/空 cwd。其余维度按值精确 IN。
 */
function trendValueFilter(dim: string, values: string[], useProxy: boolean): ColFilters {
  if (!values.length) return { conds: "", params: [] };
  if (dim === "workspace") {
    const known = values.filter((v) => v !== UNKNOWN_WS);
    const conds: string[] = [];
    const params: string[] = [];
    if (known.length) { conds.push(`s.cwd IN (${known.map(() => "?").join(",")})`); params.push(...known); }
    if (known.length !== values.length) conds.push("(s.cwd IS NULL OR s.cwd = '')");
    return { conds: conds.join(" OR "), params };
  }
  const col = useProxy
    ? (dim === "provider" ? "k.provider" : dim === "key" ? "k.key_name" : "COALESCE(k.model,'?')")
    : (dim === "provider" ? "m.provider" : dim === "agent" ? "m.agent" : "m.provider || '/' || m.model");
  return { conds: `${col} IN (${values.map(() => "?").join(",")})`, params: values };
}

/**
 * GET trend?dim=provider|model|workspace|key&values=a,b[&metric=tokens][&days=|day=|month=|from=&to=][&provider=&model=]
 * 使用趋势线：X = 时间 bucket（日/月，范围 >60 天自动月粒度），Y = 指标，一条线/维度值。
 * dim=key → 代理口径（key_req 经 client→session 归因）；否则会话口径（msg_usage）。
 * values 为空 → 按总量 Top 8（前端提示）。返回 series 按总量降序。
 */
function trend(sp: URLSearchParams) {
  const rt = runtime();
  const dim = (sp.get("dim") ?? "provider").trim();
  const useProxy = dim === "key";
  const map = useProxy ? PROXY_DIMS : MSG_DIMS;
  if (!map[dim]) return json({ error: `unknown trend dim '${dim}'` }, 400);
  const metric = (sp.get("metric") ?? "tokens").trim();
  const exprs = useProxy ? PROXY_TREND_EXPRS : MSG_TREND_EXPRS;
  if (!exprs[metric]) return json({ error: `unknown trend metric '${metric}'` }, 400);

  const r = resolveRange(sp, useProxy ? "k.day" : "m.day");
  const f = useProxy ? resolveFilters(sp, "k.provider", "k.model") : resolveFilters(sp, "m.provider", "m.model", "m.agent");
  const values = (sp.get("values") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const vf = trendValueFilter(dim, values, useProxy);
  const bucket = r.months
    ? (useProxy ? "substr(k.day,1,7)" : "substr(m.day,1,7)")
    : (useProxy ? "k.day" : "m.day");
  const merged = mergeWhere(r.where, {
    conds: [f.conds, vf.conds].filter(Boolean).join(" AND "),
    params: [...f.params, ...vf.params],
  });
  const sql = useProxy ? `
    SELECT ${map[dim]} AS kv, ${bucket} AS bucket, ${exprs[metric]} AS value
    FROM key_req k
    JOIN (SELECT DISTINCT client, session_id FROM client_sessions) cs ON cs.client = k.client
    JOIN sessions s ON s.id = cs.session_id
    ${merged}
    GROUP BY kv, bucket ORDER BY kv, bucket`
    : `
    SELECT ${map[dim]} AS kv, ${bucket} AS bucket, ${exprs[metric]} AS value
    FROM usage_caliber m LEFT JOIN sessions s ON s.id = m.session_id
    ${merged}
    GROUP BY kv, bucket ORDER BY kv, bucket`;
  const rows = rt.usage.db.prepare(sql).all(...r.params, ...f.params, ...vf.params) as any[];
  const byKey = new Map<string, { key: string; total: number; points: Array<{ bucket: string; value: number }> }>();
  for (const row of rows) {
    const k = String(row.kv ?? "");
    let e = byKey.get(k);
    if (!e) { e = { key: k, total: 0, points: [] }; byKey.set(k, e); }
    const v = Number(row.value ?? 0);
    e.total += v;
    e.points.push({ bucket: String(row.bucket), value: v });
  }
  let series = [...byKey.values()].sort((a, b) => b.total - a.total);
  if (!values.length) series = series.slice(0, 8);
  return json({
    label: r.label,
    caliber: useProxy ? "proxy" : "session",
    granularity: r.months ? "month" : "day",
    dim,
    series,
  });
}

// ---------------------------------------------------------------- dispatch

export async function handleApi(req: Request, ctx: ExtApiCtx): Promise<Response | null> {
  const [head, ...rest] = ctx.path;
  if (req.method === "POST" && head === "sync") {
    // 异步分批（2026-09-12）：立即返回，后台推进（与启动 sync 共享去重守卫，末尾自会 flushDaily）
    void runtime().syncAll().catch((e) => console.error("[aiti-ai-usage] 手动 sync 失败:", e));
    return json({ ok: true });
  }
  if (req.method !== "GET") return null;
  const sp = ctx.searchParams;
  switch (head) {
    case "status": return status();
    case "overview": return overview(sp);
    case "models": return models(sp);
    case "keys": return keys(sp);
    case "matrix": return matrix(sp);
    case "trend": return trend(sp);
    case "facets": return facets(sp);
    case "sessions": return sessionsList(sp);
    case "userstat": return userStat(sp);
    case "session-keys": return rest.length ? sessionKeys(rest[0]) : null;
    default: return null;
  }
}
