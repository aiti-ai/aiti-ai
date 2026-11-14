/**
 * aiti-model-check · pi-web 模型可用性管理扩展
 *
 * 设计：docs/aiti-model-check-extension-plan.md
 * 能力：
 *   - 全模型轻量探测（类 suggest 直连）：发极小探针消息看返回（200 ok / 429 限流 / 其它）
 *   - 429 限流识别：解析 Retry-After / X-RateLimit-Reset / 错误提示 → 预测恢复时间
 *   - 记录：history.jsonl（全量）+ state.json（每模型最近状态 + 时间线 + 恢复时间）
 *   - 后台哨兵：对处于 429/异常 的模型周期复测 → 自动识别可用时间（watch）
 *   - MCP/agent 工具（server.agent 进程内注入）：model_status / model_probe / model_history / model_config
 *   - 网页 UI（📡）：状态总览 / 一键探测 / 历史时间线
 */
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
/** 每次加载清掉 core.cjs 的 require 缓存（热重载后能拿到新逻辑；jiti 的 require.cache 是空对象，须用原生 createRequire 的缓存） */
function loadCore() {
  const nativeRequire = createRequire(import.meta.url);
  const c = nativeRequire.cache || {};
  for (const k of Object.keys(c)) {
    if (k.includes("aiti-model-check") && (k.endsWith("core.cjs") || k.endsWith("effective-models.cjs"))) delete c[k];
  }
  return nativeRequire("./core.cjs");
}
const core = loadCore();

let configDir = "";
let cfg: any = null;
let watcher: any = null;
/** 运行监测：每个 agent 会话的事件订阅（shutdown 时统一退订） */
const runtimeUnsubs: Array<() => void> = [];

// ---------- 运行期错误带外 tailer（pi-models-combo 代理日志，事件驱动零轮询） ----------
// 代理每次上游尝试都往 <agentDir>/model-usage/key-requests-<YYYY-MM>.jsonl 追加一行
// { ts, provider, model, key, status, client }——非 2xx/3xx 行天然带 key 归因（apiKeys 名/聚合成员 `pid/keyName`）：
// 429 限流 / 402 欠费 / 401 key 无效 / 403 无权限 / 404 不存在 / 5xx 服务端错 / 502·504 网络·超时。
// 真实流量里哪个 key 出了什么错，不主动打探针就知道。本扩展 fs.watch 该目录增量 tail（与 aiti-ai-usage
// 的 proxy-tail 同模式、各自独立 offset 互不冲突）→ core.ingestRuntimeError → state.runtimeErrors
// （1h/24h 窗口 + 按状态分类计数 + key 聚合）→ 节流落盘 + SSE notifyAvailability。
// 零改动 pi-models-combo；不标记模型（探测才是权威），只做提示 + 引导重检。
let tailDirWatcher: FSWatcher | null = null;
let tailReadTimer: ReturnType<typeof setTimeout> | null = null;
let tailFlushTimer: ReturnType<typeof setTimeout> | null = null;
let tailStaged: any = null; // debounce 窗口内累积的 runtimeErrors 子树（flush 时整体替换，见 scheduleTailFlush）
const tailPending = new Set<string>(); // 待增量读的文件名

function modelUsageDir(): string {
  if (process.env.PMC_USAGE_FILE) return path.dirname(core.expandPath(process.env.PMC_USAGE_FILE));
  const home = process.env.HOME || process.env.USERPROFILE || "";
  // agentDir：PI_CODING_AGENT_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = 旧 PI_DIR / ~/.pi/agent 链原行为
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? core.expandPath(process.env.PI_CODING_AGENT_DIR)
    : process.env.PI_DIR
      ? path.join(core.expandPath(process.env.PI_DIR), "agent")
      : path.join(home, ".pi", "agent");
  return path.join(agentDir, "model-usage");
}
function tailOffsetsFile() { return path.join(path.dirname(configDir), "cache", "runtime-tail.json"); } // 数据分层：cache 在 <extRoot> 下
function loadTailOffsets(): Record<string, number> {
  try { return JSON.parse(readFileSync(tailOffsetsFile(), "utf8")) || {}; } catch { return {}; }
}
function saveTailOffsets(o: Record<string, number>) {
  try { writeFileSync(tailOffsetsFile(), JSON.stringify(o)); } catch { /* 尽力而为 */ }
}

function tailIngestFile(base: string) {
  const file = path.join(modelUsageDir(), base);
  let st; try { st = statSync(file); } catch { return; }
  const offsets = loadTailOffsets();
  let from = offsets[base];
  if (from == null) { // 首次见此文件：记下当前大小为起点，只看新增（历史错误不回灌，避免启动时大量旧事件）
    offsets[base] = st.size;
    saveTailOffsets(offsets);
    return;
  }
  if (from > st.size) from = 0;     // 截断/重建 → 重读
  if (from >= st.size) return;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(st.size - from);
    readSync(fd, buf, 0, buf.length, from);
    let text = buf.toString("utf8");
    const nl = text.lastIndexOf("\n");
    if (nl < 0) return; // 只有半行 → 留给下次
    text = text.slice(0, nl);
    offsets[base] = from + Buffer.byteLength(text) + 1;
    saveTailOffsets(offsets);
    // 先解析收集错误行（常态日志 99%+ 是 200 成功 → 不碰 state，零 loadState 开销）
    const errs: any[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      let rec: any; try { rec = JSON.parse(line); } catch { continue; }
      if (!rec || rec.type || rec.switch) continue;               // client/session 行、粘性切换行不是请求结果
      const status = Number(rec.status) || 0;
      if (!status || (status >= 200 && status < 400)) continue;   // 只收错误（4xx/5xx，含 502/504 网络错）
      errs.push(rec);
    }
    if (!errs.length) return;
    const state = core.loadState(configDir);
    for (const rec of errs) {
      core.ingestRuntimeError(state, { provider: rec.provider, model: rec.model, key: rec.key, status: Number(rec.status), at: rec.ts, client: rec.client, src: "proxy" });
    }
    core.pruneRuntimeErrors(state);
    tailStaged = state.runtimeErrors;
    scheduleTailFlush();
  } finally { closeSync(fd); }
}

/** 共享 flush（800ms 短去抖）：tailer 与会话摄入两路突发合并——一个窗口至多一次
 *  loadState+saveState(2MB 同步写 ~14ms)+SSE 推送；只以本通道数据覆盖 runtimeErrors 子树，
 *  探测/watch 并发写入的其它字段用盘上最新，互不覆盖。 */
function scheduleTailFlush() {
  if (tailFlushTimer) return;
  tailFlushTimer = setTimeout(() => {
    tailFlushTimer = null;
    const staged = tailStaged; tailStaged = null;
    if (!staged) return;
    try {
      const fresh = core.loadState(configDir);
      fresh.runtimeErrors = staged;
      core.saveState(configDir, fresh);
      // 429 事件按 key 节流（2min 一次），其余错误照常——避免持续限流导致每 800ms 广播事件风暴
      if (tailFlushShouldBroadcast(fresh.runtimeErrors)) notifyAvailability();
    } catch (e) { /* 尽力而为 */ }
  }, 800);
  (tailFlushTimer as any).unref?.();
}

function applyRuntimeTailer() {
  clearRuntimeTailer();
  if (!cfg.runtime || cfg.runtime.enabled === false) return;
  if (cfg.runtime.proxyLog === false) return; // 可显式关（config.json runtime.proxyLog=false）
  const dir = modelUsageDir();
  try { tailDirWatcher = watch(dir); } catch { return; } // 目录不存在等 → 静默不监听
  tailDirWatcher.on("change", (_evt, name) => {
    const base = name == null ? "" : String(name);
    if (!/^key-requests-\d{4}-\d{2}\.jsonl$/.test(base)) return;
    tailPending.add(base);
    if (tailReadTimer) return; // 短去抖合并同批多次 append
    tailReadTimer = setTimeout(() => {
      tailReadTimer = null;
      for (const b of tailPending) { try { tailIngestFile(b); } catch { /* 文件瞬时消失等 */ } }
      tailPending.clear();
    }, 200);
    (tailReadTimer as any).unref?.();
  });
  tailDirWatcher.on("error", () => { /* 目录被删等——静默 */ });
  console.log("[aiti-model-check] 运行期错误带外监听启动 · " + dir);
}
function clearRuntimeTailer() {
  if (tailDirWatcher) { try { tailDirWatcher.close(); } catch { /* noop */ } tailDirWatcher = null; }
  if (tailReadTimer) { clearTimeout(tailReadTimer); tailReadTimer = null; }
  if (tailFlushTimer) { clearTimeout(tailFlushTimer); tailFlushTimer = null; }
  tailStaged = null;
  tailPending.clear();
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
let hostFeatures: any = null; // DI 方案 P1：startup 捕获 ctx.features
const getCtx = () => ({ configDir, registry: (globalThis as any).__piWebExt });

// ---------- availability 变更推送（pi-web 页面事件流 mc:avail 帧）----------
// 事件源：探测记录 / 运行期 429 阻断标记 / 后台哨兵复测 / 配置变更——每次状态落盘后 notify。
// 订阅方（模型向导 banner 等）经页面事件流（globalThis.__piPageEvents）mc:avail 帧实时刷新，
// 无需周期轮询；无订阅时零开销。core 过旧缺 __piPageEvents 时静默降级（订阅方拉取兑底）。
function currentAvailability() {
  const state = core.loadState(configDir);
  const lm = core.loadModels(cfg);
  core.pruneState(state, lm.entries);
  return { ok: true, ...core.availability(state, lm.entries), modelsError: lm.ok ? "" : lm.error, at: Date.now() };
}
function notifyAvailability() {
  let payload: any = null;
  try { payload = currentAvailability(); } catch (e) { return; }
  (globalThis as any).__piPageEvents?.publish("mc:avail", payload);
}

// —— 429 限流事件去重广播 ——
// 背景：代理真实流量持续 429 时，tailer 每 ~800ms 落盘一次并广播 mc:avail，
// 前端每个标签页被推着每 800ms 反查 availability/status——无人类观众的事件风暴。
// 节流：同一 provider/model/key 的 429，2 分钟内至多广播一次（首次必广播，窗口过了有新事件再播）；
// 非 429 错误（401/402/5xx 等，一般不是持续态）照常广播。探测/阻断标记/配置变更不走此函数，不受影响。
const RATE_LIMIT_DEDUP_MS = 2 * 60 * 1000;
const last429EventTs = new Map<string, number>(); // `${provider}/${model}/${key}` → 已广播的最新 429 事件 ts
const last429At = new Map<string, number>();      // 同上 → 上次广播时刻
let lastNon429EventTs = 0;                         // 非 429 错误照常广播（全局最新已广播事件 ts）

function tailFlushShouldBroadcast(runtimeErrors: any): boolean {
  const now = Date.now();
  const models = runtimeErrors?.models;
  if (!models) return false;
  let trigger = false;
  for (const mk of Object.keys(models)) {
    const evs = models[mk]?.events;
    if (!Array.isArray(evs) || !evs.length) continue;
    const last = evs[evs.length - 1];
    if (!last || typeof last.ts !== "number") continue;
    if (Number(last.status) === 429) {
      const k = mk + "/" + (last.key || "");
      const lastTs = last429EventTs.get(k) || 0;
      const lastAt = last429At.get(k) || 0;
      if (last.ts > lastTs && now - lastAt >= RATE_LIMIT_DEDUP_MS) {
        trigger = true;
        last429EventTs.set(k, last.ts);
        last429At.set(k, now);
      }
    } else if (last.ts > lastNon429EventTs) {
      trigger = true;
      lastNon429EventTs = last.ts;
    }
  }
  return trigger;
}

// feature 值读取（DI 方案 P1：ctx.features 优先，__piWebExt 兜底）——string feature 未设置返回声明默认（""）
function featureVal(fid: string): boolean | string | undefined {
  try {
    const v = hostFeatures?.get?.("aiti-model-check", fid);
    if (v !== undefined) return v;
  } catch (e) { /* noop */ }
  try {
    const registry = (globalThis as any).__piWebExt;
    if (registry?.featureValue) return registry.featureValue("aiti-model-check", fid);
    if (registry?.featureEnabled) return registry.featureEnabled("aiti-model-check", fid);
  } catch (e) { /* noop */ }
  return undefined;
}

/** recover 生效配置合成：feature（extman 可配，符合「阈值在 check feature 里配置」）优先，config.json 回退，最后默认。
 *  合成结果写回 cfg.recover —— core 直接读它（providers/models 覆盖映射保持 config 原文）。 */
function applyRecoverFeatures(c: any) {
  const r = (c.recover && typeof c.recover === "object") ? c.recover : {};
  const fEnabled = featureVal("recover.enabled");
  const fHours = featureVal("recover.minLimitedHours");
  const fDefault = featureVal("recover.notifyDefault");
  const fh = parseFloat(String(fHours == null ? "" : fHours));
  const ch = parseFloat(String(r.minLimitedHours == null ? "" : r.minLimitedHours));
  c.recover = {
    ...r,
    enabled: typeof fEnabled === "boolean" ? fEnabled : (r.enabled !== false),
    minLimitedHours: Number.isFinite(fh) && fh > 0 ? fh : (Number.isFinite(ch) && ch > 0 ? ch : 72),
    notifyDefault: typeof fDefault === "boolean" ? fDefault : (r.notifyDefault !== false),
  };
  return c;
}

function reloadCfg() {
  cfg = applyRecoverFeatures(core.loadConfig(configDir));
  return cfg;
}

// 探测并记录（供 agent 工具 / API / watcher 共用）
async function probeAndRecord(filter: { provider?: string; model?: string } = {}, opts: any = {}) {
  const lm = core.loadModels(cfg);
  if (!lm.ok) return { ok: false, error: lm.error, results: [] };
  let entries = lm.entries;
  // 组合模型（🧩 聚合组）由 pi-models-combo 引擎路由，不直接探测（占位 baseUrl 打不通）；单探时明确提示
  if (filter.provider || filter.model) {
    const matched = entries.filter((e: any) => (!filter.provider || e.provider === filter.provider) && (!filter.model || e.model === filter.model));
    if (matched.length && matched.every((e: any) => e.combo)) {
      return { ok: false, error: "聚合组模型由引擎路由（粘性+权重），不直接探测——请探测其成员真实模型", results: [] };
    }
  }
  entries = entries.filter((e: any) => !e.combo);
  if (filter.provider) entries = entries.filter((e: any) => e.provider === filter.provider);
  if (filter.model) entries = entries.filter((e: any) => e.model === filter.model);
  if (!entries.length) return { ok: true, empty: true, reason: "无匹配模型（provider=" + (filter.provider || "*") + " model=" + (filter.model || "*") + "）", results: [] };
  // 订阅登录型（OAuth，notProbeable）协议特殊不逐模型探针 → 做 provider 级订阅状态检查（qoder 配额 / 登录态）
  const subEntries = entries.filter((e: any) => e.notProbeable);
  const probeEntries = entries.filter((e: any) => !e.notProbeable);
  // 逐个 provider 探测，每探完一个立即落盘/通知 → 前面 provider 的结果先可用，不用等全部（provider 多时不再单次大等待）
  const results = probeEntries.length ? await core.probeByProvider(probeEntries, cfg, {
    ...opts,
    onProviderDone: (provider: string, pResults: any[]) => {
      core.recordHistory(configDir, pResults);
      const st = core.loadState(configDir);
      for (const r of pResults) core.applyToState(st, r, cfg);
      core.saveState(configDir, st);
      notifyAvailability();
    },
  }) : [];
  // 探测结果已逐 provider 落盘；这里重新读最新 state（含全部探测结果 + 期间任何并发写入），
  // 只补订阅状态再写一次——不基于探测前旧快照整写（避免覆盖并发更新，也去掉重复 apply）
  const state = core.loadState(configDir);
  const subResults: any[] = [];
  if (subEntries.length) {
    const byProv: any = {};
    for (const e of subEntries) if (!byProv[e.provider]) byProv[e.provider] = e;
    const subs = state.subscriptions || (state.subscriptions = {});
    for (const e of Object.values(byProv)) {
      const r = await core.checkSubscription(e, cfg, opts);
      subs[e.provider] = r;
      subResults.push(r);
    }
    if (subs && !Object.keys(subs).length) delete state.subscriptions;
  }
  core.saveState(configDir, state);
  notifyAvailability();
  return { ok: true, probed: results.length, subscriptions: subResults, results, summary: core.buildSummary(state) };
}

// ---- agent 工具定义（process-injected，AI 直接用；与 aiti-configs 同机制） ----
const TOOLS = [
  { name: "model_status", description: "模型可用性总览：读最近探测状态，列出各 model 是否可用 / 429 限流 / 异常 / 未探测，含 429 的预计恢复时间与最近探测时间线。多 key 的 provider 会列出每 key 状态（分 key 检查）。另含运行期错误观测（代理真实流量 + 直连模型会话事件：429 限流 / 402 欠费 / 401 key 无效 / 5xx 等，走代理的带 key 归因）。不探测（快），要现测用 model_probe。", inputSchema: { type: "object", properties: {} } },
  { name: "model_keys", description: "查看各 provider 配置的多个 API key（打码）与最近检查状态（分 key 检查结果）：每 key 是否可用 / 429 / 异常、延迟。keys 存于 models.json 的 provider.apiKeys（与模型向导共享），不改动。", inputSchema: { type: "object", properties: { provider: { type: "string", description: "只列该 provider（缺省全部）" } } } },
  { name: "model_availability", description: "看「是否无可用模型」：无任何模型 / 所有已配置模型都不可用（全部限流或异常）→ 供判断要不要引导用户添加/换模型；含分类计数与最近一次被运行阻断的执行记录（大量 429 导致任务中断）。", inputSchema: { type: "object", properties: {} } },
  { name: "model_report_blocked", description: "报告一次被限流阻断的执行（运行期大量 429/限流错误导致任务中断）→ 把对应模型标记为不可用并记入检查记录。判定：累计 429/限流错误数 ≥ runtime.minBlockCount（默认 3）且该次执行确实被阻断才标记；临时出错（重试成功/执行完成）不标记。", inputSchema: { type: "object", properties: { provider: { type: "string", description: "provider（如 deepseek / ark-coding-cn）" }, model: { type: "string", description: "model id（如 glm-5.2）" }, count: { type: "number", description: "该次执行累计的 429/限流错误数（缺省 1）" }, blocked: { type: "boolean", description: "该次执行是否真的被阻断（任务中断/失败）" }, errorSummary: { type: "string", description: "最近一次限流错误文案（如 429 Too Many Requests）" } } } },
  { name: "model_probe", description: "立即对模型发极小探针消息（类 suggest 轻量直连，'ping'→期望'ok'）测当前可用性：200=可用 / 429=限流（解析 Retry-After 等预测恢复时间）/ 其它错误。默认全量探测，可 provider/model 过滤。结果记录入历史（history.jsonl + state.json）。", inputSchema: { type: "object", properties: { provider: { type: "string", description: "只探测该 provider（如 sensenova / ark-coding-cn / deepseek）" }, model: { type: "string", description: "只探测该 model（如 glm-5.2 / deepseek-v4-flash）" } } } },
  { name: "model_history", description: "查看模型的探测历史（history.jsonl），按时间正序返回最近记录：可用性 / HTTP 状态 / 延迟 / 429 的恢复时间预测。用于识别可用时间窗口。", inputSchema: { type: "object", properties: { provider: { type: "string", description: "按 provider 过滤" }, model: { type: "string", description: "按 model 过滤" }, limit: { type: "number", description: "条数（默认 30，最大 200）" } } } },
  { name: "model_balance", description: "查询各 AI provider 账户余额/套餐用量：支持有公开余额 API 的（DeepSeek /user/balance、Z.AI/智谱编码 /monitor/usage/quota/limit、OpenCode Zen /v1/usage、Moonshot-Kimi /v1/users/me/balance、OpenRouter /key、MiniMax /token_plan/remains、Venice /billing/balance——端点依据 OpenClaw 源码与官网/官方文档实测）。返回每个 provider 可查与否 + 余额/用量；不支持的标出原因。余额是 provider 级（同家多个模型共一个账户）。refresh=false 用缓存（≤10min）。", inputSchema: { type: "object", properties: { refresh: { type: "boolean", description: "false=用上次缓存结果（默认 true 现查）" } } } },
  { name: "model_config", description: "查看/修改 aiti-model-check 配置（modelsPath / probe.timeoutMs.concurrency / watch.intervalSec.enabled / history 保留条数）。修改需确认。", inputSchema: { type: "object", properties: { get: { type: "boolean", description: "true=读当前配置（缺省）" }, set: { type: "object", description: "要合并写入的配置片段（如 {watch:{intervalSec:120}}）" } } } },
];

function toolResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}
async function runTool(name: string, args: any): Promise<any> {
  reloadCfg();
  switch (name) {
    case "model_status": {
      const state = core.loadState(configDir);
      const lm = core.loadModels(cfg);
      core.pruneState(state, lm.entries);
      const summary = core.buildSummary(state);
      const bal = state.balances || {};
      const balOk = Object.values(bal).filter((b: any) => b.ok);
      const balNote = balOk.length
        ? "\n💰 余额（缓存）: " + balOk.map((b: any) => b.provider + " " + (b.text || "")).join(" · ")
        : (Object.keys(bal).length ? "\n💰 余额: 暂无可查项（调 model_balance 现查）" : "");
      const subs = state.subscriptions || {};
      const subNote = Object.keys(subs).length
        ? "\n🔐 订阅 provider：" + Object.entries(subs).map(([p, s]: any) => (s.ok ? (s.exhausted ? "⚠️ " : "✅ ") : "❌ ") + p + " " + (s.label || "") + (s.text ? "（" + s.text + "）" : "")).join(" · ")
        : (lm.entries.some((e: any) => e.subscription) ? "\n🔐 订阅 provider（qoder/github-copilot 等）：调 model_probe 做订阅状态检查" : "");
      // 运行期错误观测（带外）：代理真实流量里的 429/402/401/5xx…（带 key 归因）——临时故障可能尚未反映到探测状态
      const rtNote = core.buildRuntimeErrorsSummary(state);
      // 限流到期提醒：长期限流 + 预测恢复时间到点的「待验证」清单（纯时间检查，不自动探测）
      const recNote = core.buildRecoverSummary(state, cfg);
      return toolResult(summary + (rtNote ? "\n" + rtNote : "") + "\n" + recNote + balNote + subNote + (lm.ok ? "" : "\n⚠️ " + lm.error) + "\n（" + lm.entries.length + " 个已配置 model；state 更新时间 " + core.fmtTime(state.updatedAt) + "）");
    }
    case "model_keys": {
      const state = core.loadState(configDir);
      const lm = core.loadModels(cfg);
      const pFilter = String(args && args.provider || "").trim();
      const L = ["多 key 配置（models.json provider.apiKeys）："];
      const providers = lm.ok ? [...new Set(lm.entries.map((e: any) => e.provider))] : [];
      let any = false;
      for (const p of providers) {
        if (pFilter && p !== pFilter) continue;
        const keys = core.getProviderKeys(cfg, p);
        if (!keys.length) continue;
        any = true;
        const kTxt = keys.map((k: any) => {
          const km = state.models && Object.values(state.models).find((m: any) => m.provider === p && m.keys && m.keys[k.name]);
          const kk = km && km.keys[k.name];
          const st = !kk ? "⚪ 未检" : kk.ok ? "OK" : kk.status === 429 ? "🔴 429" + (kk.predictedAvailableAt ? " ~" + core.fmtPredict(kk.predictedAvailableAt) : "") : "⚠️ " + (kk.status || "err");
          return k.name + "=" + core.maskKey(k.key) + (k.rpm ? "(rpm" + k.rpm + ")" : "") + " " + st + (kk && kk.latencyMs != null ? " " + core.fmtDuration(kk.latencyMs) : "");
        }).join(" · ");
        L.push("  · " + p + "（" + keys.length + " 个 key）: " + kTxt);
      }
      if (!any) L.push(pFilter ? "  provider=" + pFilter + " 没有配置多 key（可用模型向导 aiti_model_wizard_keys 添加）" : "  还没有任何 provider 配置多 key（可用模型向导 aiti_model_wizard_keys / 保存时带 keys 添加）");
      return toolResult(L.join("\n"));
    }
    case "model_availability": {
      const state = core.loadState(configDir);
      const lm = core.loadModels(cfg);
      core.pruneState(state, lm.entries);
      const a = core.availability(state, lm.entries);
      const L = [];
      if (a.noModels) L.push("无任何已配置模型 → 应引导用户添加（aiti_model_wizard_search / 模型向导）");
      else if (a.allUnavailable) L.push("🔴 所有已配置模型都不可用（" + a.total + " 个：限流 " + a.rateLimited + " · 异常 " + a.errorCount + "）→ 需要换模型或等恢复");
      else L.push("🟢 有可用模型（总 " + a.total + "：可用 " + a.available + " · 限流 " + a.rateLimited + " · 异常 " + a.errorCount + " · 未探测 " + a.unprobed + "）");
      const bl = a.blockedExecutions;
      if (bl && bl.length) {
        const last = bl[bl.length - 1];
        L.push("最近被阻断的执行（大量 429 导致任务中断）：" + core.fmtTime(last.at) + " · " + (last.provider + "/" + last.model) + " · " + last.count + " 次" + (last.marked ? "（已标记模型不可用）" : "（未达标记线）") + (last.errorSummary ? " · " + last.errorSummary.slice(0, 80) : ""));
      } else {
        L.push("（还没有运行期阻断记录：执行中大量 429 导致任务中断时自动记录）");
      }
      return toolResult(L.join("\n"));
    }
    case "model_report_blocked": {
      const p = String(args && args.provider || "");
      const md = String(args && args.model || "");
      if (!p || !md) return toolResult("需要 provider + model", true);
      const count = Math.max(1, parseInt(String(args && args.count || "1"), 10) || 1);
      const blocked = args && args.blocked !== false;
      const errorSummary = String(args && args.errorSummary || "").slice(0, 300);
      const state = core.loadState(configDir);
      const cfg2 = reloadCfg();
      const minCount = (cfg2.runtime && cfg2.runtime.minBlockCount) || 3;
      const marked = blocked && count >= minCount;
      const ev = { provider: p, model: md, count, blocked, marked, errorSummary, source: "report", at: Date.now() };
      core.recordBlockedExecution(state, ev);
      if (marked) core.markBlocked(state, p, md, ev);
      core.saveState(configDir, state);
      notifyAvailability();
      const L = [];
      L.push("已记录被阻断的执行：" + p + "/" + md + " · " + count + " 次 429/限流错误" + (blocked ? "（执行被阻断）" : "（未阻断）"));
      if (marked) L.push("🔴 已把该模型标记为不可用（" + count + " ≥ " + minCount + "，且确实阻断执行——大量出错才标记，临时出错不标记）");
      else L.push("⚪ 未标记模型（规则：需 " + count + " ≥ " + minCount + " 且执行被阻断；防止临时出错误标）");
      if (errorSummary) L.push("错误摘要：" + errorSummary);
      return toolResult(L.join("\n"));
    }
    case "model_probe": {
      const r = await probeAndRecord({ provider: args && args.provider, model: args && args.model });
      if (!r.ok) return toolResult("探测失败：" + r.error, true);
      if (r.empty) return toolResult(r.reason || "无匹配模型", true);
      const subN = Array.isArray(r.subscriptions) ? r.subscriptions.length : 0;
      const lines = ["🔍 " + (r.probed ? "已探测 " + r.probed + " 个模型" : (subN ? "订阅状态检查" : "无结果")) + "（" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "）："];
      for (const x of r.results) {
        lines.push(core.statusOf({ lastProbedAt: 1, lastOk: x.ok, rateLimited: x.status === 429 }) === "rl"
          ? "  🔴 " + x.provider + "/" + x.model + " · 429 · " + (x.predictedAvailableAt ? "预计恢复 ~" + core.fmtPredict(x.predictedAvailableAt) : "未知恢复点") + (x.error ? " · " + x.error.slice(0, 90) : "")
          : x.ok
            ? "  ✅ " + x.provider + "/" + x.model + " · 200 · " + core.fmtDuration(x.latencyMs) + " · 回 " + JSON.stringify(x.text || "")
            : "  ⚠️ " + x.provider + "/" + x.model + " · HTTP " + (x.status || "net") + " · " + (x.label || "异常") + (x.error ? " · " + x.error.slice(0, 90) : ""));
        if (Array.isArray(x.perKey) && x.perKey.length > 1) {
          for (const pk of x.perKey) {
            lines.push("      ↳ key " + (pk.keyName || "?") + ": " + (pk.ok ? "✅ " + pk.status : pk.status === 429 ? "🔴 429" + (pk.predictedAvailableAt ? " ~" + core.fmtPredict(pk.predictedAvailableAt) : "") : "⚠️ " + (pk.status || "net") + " " + (pk.label || "")) + " · " + core.fmtDuration(pk.latencyMs) + (pk.error ? " · " + pk.error.slice(0, 70) : ""));
          }
        }
      }
      if (Array.isArray(r.subscriptions) && r.subscriptions.length) {
        for (const s of r.subscriptions) {
          lines.push(s.ok
            ? "  🔐 " + s.provider + " 订阅 · " + (s.label || "已登录") + (s.text ? " · " + s.text : "")
            : "  ❌ " + s.provider + " 订阅 · " + (s.label || "异常") + (s.error ? " · " + s.error.slice(0, 90) : ""));
        }
      }
      lines.push(""); lines.push(r.summary);
      return toolResult(lines.join("\n"));
    }
    case "model_history": {
      const limit = Math.min(parseInt(String(args && args.limit || "30"), 10) || 30, 200);
      const hist = core.readHistory(configDir, { provider: args && args.provider, model: args && args.model, limit });
      if (!hist.length) return toolResult("无探测历史（先调 model_probe 探测一次）");
      const lines = ["探测历史（" + hist.length + " 条" + (args && args.provider ? " · provider=" + args.provider : "") + (args && args.model ? " · model=" + args.model : "") + "）："];
      for (const h of hist) {
        const icon = h.ok ? "✅" : h.status === 429 ? "🔴" : "⚠️";
        let extra = icon + " " + h.provider + "/" + h.model + " · " + core.fmtTime(h.ts) + " · HTTP " + (h.status || "net") + " · " + core.fmtDuration(h.latencyMs);
        if (h.ok) extra += " · " + JSON.stringify(h.text || "");
        else if (h.status === 429) extra += " · 预计恢复 " + (h.predictedAvailableAt ? core.fmtPredict(h.predictedAvailableAt) : "未知");
        if (h.label && !h.ok) extra += " · " + h.label;
        if (h.error) extra += " · " + h.error.slice(0, 80);
        lines.push("  " + extra);
      }
      return toolResult(lines.join("\n"));
    }
    case "model_config": {
      if (args && args.get === false && args.set && typeof args.set === "object") {
        const merged = { ...cfg, ...args.set };
        if (core.saveConfig(merged, configDir)) { reloadCfg(); applyWatcher(); applyRecoverTimer(); notifyAvailability(); return toolResult("已更新配置（watch / 到期检查生效于下一周期）"); }
        return toolResult("写配置失败", true);
      }
      const { _file, ...rest } = cfg;
      return toolResult(JSON.stringify({ ok: true, file: cfg._file, config: rest }, null, 2));
    }
    case "model_balance": {
      const lm = core.loadModels(cfg);
      if (!lm.ok) return toolResult("读模型清单失败：" + lm.error, true);
      const refresh = !(args && args.refresh === false); // 默认现查；refresh:false 用缓存
      let balances = (core.loadState(configDir).balances) || {};
      if (refresh) {
        const results = await core.checkAllBalances(lm.entries, cfg);
        const st2 = core.loadState(configDir);
        core.applyBalancesToState(st2, results);
        core.saveState(configDir, st2);
        balances = st2.balances || {};
      }
      const okList = Object.values(balances).filter((b: any) => b.ok);
      const unsupList = Object.values(balances).filter((b: any) => b.unsupported);
      const errList = Object.values(balances).filter((b: any) => !b.unsupported && !b.ok);
      const L = ["模型余额 / 套餐用量（provider 级" + (refresh ? "，刚现查" : "，缓存") + " " + core.fmtTime(Date.now()) + "）："];
      if (!Object.keys(balances).length) L.push("还没有余额记录，本工具已现查一次；多 provider 并行查询可能需几秒。");
      if (okList.length) { L.push("可查 (" + okList.length + ")："); L.push(core.buildBalanceSummary(balances)); }
      if (unsupList.length) { L.push("⚪ 无公开余额接口 (" + unsupList.length + ")："); L.push(core.buildBalanceSummary(balances)); }
      if (errList.length) { L.push("查询失败 (" + errList.length + ")："); L.push(core.buildBalanceSummary(balances)); }
      L.push("支持查余额/用量的 provider（端点依据 OpenClaw 源码 + 实测官网/官方 API）：DeepSeek /user/balance · Z.AI/智谱编码 /monitor/usage/quota/limit · OpenCode Zen /v1/usage · Moonshot-Kimi /v1/users/me/balance · OpenRouter /key · MiniMax /token_plan/remains · Venice /billing/balance");
      return toolResult(L.join("\n"));
    }
    default: return toolResult("unknown tool: " + name, true);
  }
}

// ---- 后台哨兵：周期复测处于 429/异常 的模型（识别可用时间） ----
let watchCycle = 0;
function applyWatcher() {
  clearWatcher();
  if (!cfg || !cfg.watch || !cfg.watch.enabled) return;
  const intervalMs = Math.max(10, (cfg.watch.intervalSec || 60)) * 1000;
  const farThresholdMs = Math.max(1, (cfg.watch.farThresholdMin || 30)) * 60000; // 预计恢复远于此 → 低频复测
  const farFactor = Math.max(1, cfg.watch.farFactor || 30); // 每 N 周期测一次远期限流
  watchCycle = 0;
  watcher = setInterval(async () => {
    try {
      watchCycle++;
      const state = core.loadState(configDir);
      const nowMs = Date.now();
      const candidates = Object.values(state.models || {}).filter((m: any) => {
        if (!m.lastProbedAt || m.lastOk) return false;
        if (cfg.watch.onlyNotOk === false) return true;
        // 远期恢复（如月度额度 14 天）的模型低频复测，避免每 60s 白打一堆请求
        if (m.predictedAvailableAt && m.predictedAvailableAt - nowMs > farThresholdMs) {
          return watchCycle % farFactor === 0;
        }
        return true;
      });
      if (!candidates.length) return; // 全都可用 → 不打搅
      const lm = core.loadModels(cfg);
      const entries = lm.entries.filter((e: any) => candidates.some((m: any) => m.provider === e.provider && m.model === e.model));
      if (!entries.length) return;
      // 逐个 provider 复测，每探完一个立即落盘/通知（恢复可用尽早通知）
      const results = await core.probeByProvider(entries, cfg, {
        onProviderDone: (provider: string, pResults: any[]) => {
          core.recordHistory(configDir, pResults);
          const st = core.loadState(configDir);
          for (const r of pResults) core.applyToState(st, r, cfg);
          core.saveState(configDir, st);
          notifyAvailability();
        },
      });
      const rec = results.filter((r: any) => r.ok).length;
      if (rec) console.log("[aiti-model-check] watch 复测 " + results.length + " 个，恢复可用 " + rec + " 个（" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "）");
    } catch (e) { console.warn("[aiti-model-check] watch 异常", e); }
  }, intervalMs);
  watcher.unref?.();
  console.log("[aiti-model-check] watch 哨兵启动 · 每 " + (cfg.watch.intervalSec || 60) + "s 复测非可用模型（远期限流低频）");
}
function clearWatcher() {
  if (watcher) { clearInterval(watcher); watcher = null; }
}

// ---- 限流到期提醒（recover）：纯本地时间检查（零网络），与模型更新检查同频（默认 30min） ----
// 设计：docs/aiti-model-check-recovery-notify-plan.md。不发起任何探测——只在本地比对
// 「429 时记录的预计恢复时间（alertAt）」与当前时间，到点且已持续限流达阈值时提醒用户手动验证。
let recoverTimer: ReturnType<typeof setInterval> | null = null;
function recoverCheckIntervalMs(): number {
  const s = Number(cfg && cfg.recover && cfg.recover.checkIntervalSec);
  return Math.max(60, Number.isFinite(s) && s > 0 ? s : 1800) * 1000;
}
/** 到期检查（纯时间，幂等）：到点 + 已持续长期限流 + 开关开 → 发 mc:recover + 记提醒历史。返回提醒数。 */
function checkRecoverAlerts(): number {
  if (!configDir) return 0;
  reloadCfg();
  if (cfg.recover && cfg.recover.enabled === false) return 0;
  try {
    const state = core.loadState(configDir);
    const due = core.dueRecoverAlerts(state, cfg);
    if (!due.length) return 0;
    core.markRecoverAlertsNotified(state, due);
    core.saveState(configDir, state);
    notifyRecoverAlerts(due);
    console.log("[aiti-model-check] ⏰ 限流到期提醒 · " + due.map((d: any) => d.provider + "/" + d.model).join(", "));
    return due.length;
  } catch (e) { console.warn("[aiti-model-check] 到期检查异常", e); return 0; }
}
function notifyRecoverAlerts(alerts: any[]) {
  const payload = {
    at: Date.now(),
    alerts: (alerts || []).map((a: any) => ({ provider: a.provider, model: a.model, alertAt: a.alertAt, limitedSince: a.limitedSince, limitedMs: a.limitedMs })),
  };
  (globalThis as any).__piPageEvents?.publish("mc:recover", payload);
}
function applyRecoverTimer() {
  if (recoverTimer) { clearInterval(recoverTimer); recoverTimer = null; }
  recoverTimer = setInterval(() => checkRecoverAlerts(), recoverCheckIntervalMs());
  (recoverTimer as any).unref?.();
  console.log("[aiti-model-check] 限流到期提醒检查启动 · 每 " + Math.round(recoverCheckIntervalMs() / 1000) + "s（纯时间检查，零探测）");
}
function clearRecoverTimer() {
  if (recoverTimer) { clearInterval(recoverTimer); recoverTimer = null; }
}
/** 启动序：回填 limitedSince（history.jsonl 流式、幂等）→ 立即到期检查一次（daemon 重启也能尽快补发）。 */
async function initRecover() {
  try {
    const st = core.loadState(configDir);
    const n = await core.migrateLimitedSince(st, configDir);
    if (n) { core.saveState(configDir, st); console.log("[aiti-model-check] limitedSince 回填 " + n + " 个限流模型（依据 history.jsonl）"); }
  } catch (e) { console.warn("[aiti-model-check] limitedSince 迁移失败", e); }
  checkRecoverAlerts();
}
/** /status 的 recover 区块（生效配置 + 提醒历史 + 实时 due 列表）。 */
function recoverStatus(state: any) {
  const r = (cfg && cfg.recover) || {};
  return {
    enabled: r.enabled !== false,
    minLimitedHours: Math.round((core.recoverThresholdMs(cfg) / 3600000) * 100) / 100,
    checkIntervalSec: Math.round(recoverCheckIntervalMs() / 1000),
    notifyDefault: r.notifyDefault !== false,
    providers: r.providers || {},
    models: r.models || {},
    alerts: Array.isArray(state && state.recoverAlerts) ? state.recoverAlerts : [],
    due: core.dueRecoverAlerts(state, cfg),
    pending: core.pendingRecoverChecks(state, cfg),
  };
}

export default {
  id: "aiti-model-check",
  name: "模型可用性管理（探测 / 429 限流识别）",
  icon: "icon.svg",
  client: "dist/aiti-model-check-client.mjs",

  ai: {
    manage: true,
    intro: "AI 能帮我检查各模型当前是否可用、是否 429 限流、预计何时恢复；配了多 key 的 provider 可分 key 检查（aiti-model-check）",
    skills: "skills", // pi skills 标准：skills/index.json + skills/<name>/SKILL.md（ai-helper 聚合）
  },

  ui: {
    clientImmediately: true, // 限流到期提醒（recover）需页面常驻监听 mc:recover→浏览器通知（113KB bundle；懒加载 v2 的 M1 懒化对本功能让步）
    toolbar: [
      { id: "aiti-model-check-open", label: "模型", title: "aiti-model-check：模型可用性探测 / 429 限流识别 / 可用时间", icon: "icons/radio.svg", feature: "behavior.showToolbar" },
    ],
    // aiti-float dock v3：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    sidebarExplorerDock: [{ id: "panel", label: "模型检查" }],
    rightFileDock: [{ id: "panel", label: "模型检查" }],
    pages: [{ id: "aiti-model-check-dialog", label: "aiti-model-check" }], // 实际注册在 pages 插槽（client entry.tsx），声明与之一致
  },

  // 功能管理（aiti-extman 详情面板逐项启停；core 持久化 features.json）
  // 工具级约定：feature.id = "tool.<注入后的工具名>"——core 自动过滤（注入不出现）+ execute 包装（调用即拒绝）。
  // 默认全部禁用：注册太多工具占用模型上下文/token；需要时在扩展管理器逐项开启。
  features: [
    // UI：顶部工具条是否单独显示「模型检查」按钮。默认隐藏——模型检查从模型向导顶部「检查」入口进入（多一步点击）；需要的人可在此打开。
    { id: "behavior.showToolbar", label: "顶部工具条显示「模型」按钮", group: "UI", description: "默认隐藏：模型检查从模型向导顶部「检查」入口进入；打开后在顶部工具条单独显示按钮", default: false },
    // ── 模型工具（默认禁用，需在扩展管理器开启） ──
    { id: "tool.aiti_model_status", label: "model_status · 可用性总览", group: "模型工具", description: "模型可用性总览：各 model 是否可用 / 429 限流 / 异常 / 预计恢复时间（多 key 显示每 key 状态）", default: false },
    { id: "tool.aiti_model_keys", label: "model_keys · 多 key 检查", group: "模型工具", description: "查看各 provider 配置的多个 API key（打码）与分 key 检查状态（可用/429/异常）", default: false },
    { id: "tool.aiti_model_availability", label: "model_availability · 有无可用模型", group: "模型工具", description: "看是否无可用模型（无模型 / 全部限流或异常）+ 最近被阻断的执行记录", default: false },
    { id: "tool.aiti_model_probe", label: "model_probe · 立即探测", group: "模型工具", description: "立即对模型发极小探针消息测当前可用性（200/429/其它）", default: false },
    { id: "tool.aiti_model_report_blocked", label: "model_report_blocked · 报告阻断", group: "模型工具", description: "报告一次被限流阻断的执行（大量 429 导致任务中断）→ 标记模型不可用（大量出错且阻断执行才标记）", default: false },
    { id: "tool.aiti_model_history", label: "model_history · 探测历史", group: "模型工具", description: "查看模型的探测历史（可用性 / 延迟 / 429 恢复时间预测）", default: false },
    { id: "tool.aiti_model_balance", label: "model_balance · 余额/用量", group: "模型工具", description: "查询各 AI provider 账户余额/套餐用量（支持公开余额 API 的）", default: false },
    { id: "tool.aiti_model_config", label: "model_config · 配置", group: "模型工具", description: "查看/修改 aiti-model-check 配置（修改需确认）", default: false },
    // ── 限流到期提醒（recover）：纯时间检查（零探测）——长期限流模型在记录的预计恢复时间到点时提醒（浏览器通知 + 面板待验证）；阈值在此配置 ──
    { id: "recover.enabled", type: "boolean", label: "限流到期提醒", group: "通知", default: true,
      description: "长期限流（已持续 ≥ 阈值）的模型在记录的预计恢复时间到点时提醒（纯时间检查，不发探测）——浏览器通知 + 面板「待验证」高亮" },
    { id: "recover.minLimitedHours", type: "string", label: "长期限流阈值（小时）", group: "通知", value: "", placeholder: "默认 72 = 3 天",
      description: "已持续限流超过该时长才值得到期提醒；留空 = 72 小时（3 天）" },
    { id: "recover.notifyDefault", type: "boolean", label: "默认通知所有模型", group: "通知", default: true,
      description: "未逐模型/逐 provider 设置时，限流到期是否提醒（面板行尾铃铛可单独关闭）" },
    { id: "agentTools.enabled", type: "boolean", label: "AI 工具（模型检查）", group: "AI", default: false,
      description: "会话内注入 aiti_model_* 工具（默认关；需要时经 aiti-helper 帮助点（🤖）临时启用，或扩展管理器开启）" },
  ],

  server: {
    startup(ctx) {
      configDir = ctx.configDir || "";
      hostFeatures = (ctx as any)?.features ?? null; // DI 方案 P1
      reloadCfg();
      applyWatcher();
      applyRuntimeTailer();
      applyRecoverTimer(); // 限流到期提醒：纯时间检查定时器（与模型更新检查同频，默认 30min）
      void initRecover();  // 回填 limitedSince（history.jsonl）+ 立即到期检查一次
      // 异步初始化 pi ModelRuntime（模型清单来源；不阻塞 startup，未就绪时回退自解析）
      core.initPiRuntime(cfg).then(() => {
        const lm = core.loadModels(cfg);
        console.log("[aiti-model-check] pi 模型注册表就绪 · 已配置模型 " + (lm.ok ? lm.entries.length : "读失败: " + lm.error) + " 个（runtime=" + lm.runtime + "）");
      }).catch((e) => console.log("[aiti-model-check] pi 初始化失败（回退自解析）: " + ((e && e.message) || e)));
      const lm0 = core.loadModels(cfg);
      console.log("[aiti-model-check] 就绪 · configDir=" + configDir + " · 已配置模型 " + (lm0.ok ? lm0.entries.length : "读失败: " + lm0.error) + " 个 · watch=" + (cfg.watch && cfg.watch.enabled));
    },
    shutdown() { clearWatcher(); clearRuntimeTailer(); clearRecoverTimer(); while (runtimeUnsubs.length) { try { runtimeUnsubs.pop()!(); } catch (e) {} } },

    async api(req, ctx) {
      const p = ctx.path || [];
      if (!configDir) return json({ ok: false, error: "扩展未初始化" }, 500);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });
      reloadCfg();

      // GET /features → UI feature 状态（client 启动拉取；extman 改后 5s 内重拉生效）
      if (p[0] === "features" && p.length === 1 && req.method === "GET") {
        // DI 方案 P1：ctx.features 优先（featureGet），__piWebExt 直调兜底
        const enabled = (fid: string, fallback = true) => {
          const v = hostFeatures?.get?.("aiti-model-check", fid);
          if (typeof v === "boolean") return v;
          const registry = (globalThis as Record<string, unknown>).__piWebExt as {
            featureEnabled?: (extId: string, fid: string) => boolean;
          } | undefined;
          return registry?.featureEnabled ? registry.featureEnabled("aiti-model-check", fid) : fallback;
        };
        return json({ ok: true, showToolbar: enabled("behavior.showToolbar", false) });
      }

      // GET /balance?refresh=1 → 余额/套餐用量（缺省用 ≤10min 缓存；refresh=1 现查）
      if (p[0] === "balance" && req.method === "GET") {
        const state = core.loadState(configDir);
        const balances = state.balances || {};
        const refresh = ctx.searchParams.get("refresh") === "1";
        const TTL = 10 * 60 * 1000;
        const needCheck = refresh || !Object.values(balances).length || Object.values(balances).some((b) => !b.checkedAt || Date.now() - b.checkedAt > TTL);
        if (needCheck) {
          const lm = core.loadModels(cfg);
          if (!lm.ok) return json({ ok: false, error: lm.error }, 500);
          const results = await core.checkAllBalances(lm.entries, cfg);
          core.applyBalancesToState(state, results);
          core.saveState(configDir, state);
          const nb = core.normalizeBalanceDisplay(state.balances || {});
          return json({ ok: true, refreshed: true, balances: Object.values(nb).sort((a, b) => a.provider.localeCompare(b.provider)), summary: core.buildBalanceSummary(nb) });
        }
        const nb = core.normalizeBalanceDisplay(balances);
        return json({ ok: true, refreshed: false, balances: Object.values(nb).sort((a, b) => a.provider.localeCompare(b.provider)), summary: core.buildBalanceSummary(nb) });
      }
      // GET /status → 状态总览（不探测）
      if (p[0] === "status" && req.method === "GET") {
        const state = core.loadState(configDir);
        if (state.balances) state.balances = core.normalizeBalanceDisplay(state.balances); // 旧缓存负余额归一化，避免误显绿色
        const lm = core.loadModels(cfg);
        core.pruneState(state, lm.entries);
        core.pruneRuntimeErrors(state); // 运行期错误观测过期清理（UI 直接读 state.runtimeErrors）
        // 条目里的 apiKey / keys 是完整明文 → 剥掉不外发（keys 经 GET /keys?provider= 拿打码版；每 key 状态在 state.models[].keys）
        return json({ ok: true, state, models: lm.ok ? lm.entries.map(({ apiKey, keys, ...rest }) => rest) : [], modelsError: lm.ok ? "" : lm.error, runtime: lm.runtime, piError: core.piError(), summary: core.buildSummary(state), recover: recoverStatus(state) });
      }
      // GET /availability → 有无可用模型（banner / agent 用）：无模型 / 全部不可用 / 分类计数 + 最近阻断记录
      if (p[0] === "availability" && req.method === "GET") {
        return json(currentAvailability());
      }
      // POST /blocked-execution { provider, model, count?, blocked?, errorSummary?, sessionId? } → 运行期被阻断的执行（大量 429 导致任务中断）→ 标记模型 + 记入检查记录
      if (p[0] === "blocked-execution" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const provider = String((body && body.provider) || "");
        const model = String((body && body.model) || "");
        if (!provider || !model) return json({ ok: false, error: "需要 provider + model" }, 400);
        const count = Math.max(1, parseInt(String((body && body.count) || "1"), 10) || 1);
        const blocked = (body && body.blocked !== false);
        const minCount = (cfg.runtime && cfg.runtime.minBlockCount) || 3;
        const marked = blocked && count >= minCount;
        const state = core.loadState(configDir);
        const ev = { provider, model, count, blocked, marked, errorSummary: String((body && body.errorSummary) || "").slice(0, 300), sessionId: String((body && body.sessionId) || ""), source: "runtime", at: Date.now() };
        core.recordBlockedExecution(state, ev);
        if (marked) core.markBlocked(state, provider, model, ev);
        core.saveState(configDir, state);
        notifyAvailability();
        return json({ ok: true, count, blocked, marked, minCount, message: marked ? "已标记模型 " + provider + "/" + model + " 为不可用（" + count + " ≥ " + minCount + " 且阻断执行）" : "未标记（" + count + " < " + minCount + " 或未阻断执行，防止临时出错误标）" });
      }
      // POST /probe { provider?, model? } → 现测 + 记录
      if (p[0] === "probe" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const r = await probeAndRecord({ provider: body && body.provider, model: body && body.model });
        if (!r.ok) return json({ ok: false, error: r.error }, 500);
        return json({ ok: true, probed: r.results.length, subscriptions: r.subscriptions || [], results: r.results, summary: r.summary });
      }
      // GET /history?provider=&model=&limit= → 历史
      if (p[0] === "history" && req.method === "GET") {
        const hist = core.readHistory(configDir, {
          provider: ctx.searchParams.get("provider") || undefined,
          model: ctx.searchParams.get("model") || undefined,
          limit: Math.min(parseInt(ctx.searchParams.get("limit") || "50", 10) || 50, 300),
        });
        return json({ ok: true, history: hist });
      }
      // GET /config → 读配置
      if (p[0] === "config" && req.method === "GET") {
        const { _file, ...rest } = cfg;
        return json({ ok: true, file: cfg._file, config: rest });
      }
      // POST /config { set } → 改配置
      if (p[0] === "config" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        if (body && body.set && typeof body.set === "object") {
          const merged = { ...cfg, ...body.set };
          if (core.saveConfig(merged, configDir)) { reloadCfg(); applyWatcher(); applyRecoverTimer(); notifyAvailability(); return json({ ok: true }); }
          return json({ ok: false, error: "写配置失败" }, 500);
        }
        return json({ ok: false, error: "需要 set" }, 400);
      }
      // POST /watch { action: start|stop|status } → 哨兵控制
      if (p[0] === "watch" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const action = body && body.action;
        if (action === "stop") { clearWatcher(); return json({ ok: true, watching: false }); }
        if (action === "start") { applyWatcher(); return json({ ok: true, watching: !!watcher }); }
        return json({ ok: true, watching: !!watcher, intervalSec: cfg.watch && cfg.watch.intervalSec, enabled: cfg.watch && cfg.watch.enabled });
      }
      // POST /recover-check → 立即做一次限流到期检查（纯本地时间比较，零探测；幂等）
      // 前端面板加载时静默调用：把「已到点但页面不在线时未发出的提醒」补发一次。
      if (p[0] === "recover-check" && req.method === "POST") {
        const n = checkRecoverAlerts();
        return json({ ok: true, notified: n, recover: recoverStatus(core.loadState(configDir)) });
      }
      // POST /recover-notify { level: "provider"|"model", provider, model?, value: true|false|null } → 限流到期提醒开关
      // value=null 删除覆盖（回落上级默认：模型级 > provider 级 > notifyDefault）
      if (p[0] === "recover-notify" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const level = String((body && body.level) || "");
        const value = body && body.value;
        const next = core.loadUserConfig(configDir); // 读盘原始用户配置（不合并默认，避免把 recover 默认值固化）
        next.recover = { ...((next.recover && typeof next.recover === "object") ? next.recover : {}) };
        if (level === "provider") {
          const name = String((body && body.provider) || "");
          if (!name) return json({ ok: false, error: "需要 provider" }, 400);
          const pv = { ...(next.recover.providers || {}) };
          if (value === null) delete pv[name]; else pv[name] = !!value;
          next.recover.providers = pv;
        } else if (level === "model") {
          if (!(body && body.provider && body.model)) return json({ ok: false, error: "需要 provider + model" }, 400);
          const key = String(body.provider) + "/" + String(body.model);
          const mv = { ...(next.recover.models || {}) };
          if (value === null) delete mv[key]; else mv[key] = !!value;
          next.recover.models = mv;
        } else {
          return json({ ok: false, error: "level 需要 provider|model" }, 400);
        }
        if (!core.saveConfig(next, configDir)) return json({ ok: false, error: "写配置失败" }, 500);
        reloadCfg();
        notifyAvailability(); // 面板/其它订阅方刷新（开关状态就地更新）
        return json({ ok: true, recover: recoverStatus(core.loadState(configDir)) });
      }
      return json({ ok: false, error: "not found" }, 404);
    },

    agent: {
      agentTools() {
        // 门控由 core 统一判定（feature agentTools.enabled + per-session enableExtTools），此处无条件返回
        return TOOLS.map((t) => ({
          name: "aiti_" + t.name,
          label: "aiti_" + t.name,
          description: t.description + "（aiti-model-check 进程内直连，pi-web 会话）",
          parameters: t.inputSchema || { type: "object", properties: {} },
          async execute(_toolCallId: string, params: any) {
            return runTool(t.name, params || {});
          },
        }));
      },

      // 运行期 429 监测（方案 M onAgentSession）：订阅每个 agent 会话事件流，
      // 统计一轮执行里的 429/限流错误数；某次执行被阻断（重试耗尽/最终错误）且大量出错 →
      // 标记对应模型不可用并记入检查记录（通知模型检查）。
      // 规则：不能因临时出错误标——一两次 429 重试成功、执行正常完成 → 不标记；
      // 只在「最后一次执行大量出错（≥ runtime.minBlockCount）且阻断了执行」才标记。
      onAgentSession(info: any) {
        try {
          if (!info || typeof info.subscribeEvent !== "function") return;
          reloadCfg();
          if (!cfg.runtime || cfg.runtime.enabled === false) return;
          const minCount = Math.max(1, (cfg.runtime.minBlockCount) || 3);
          // 当前会话正在使用的模型（pi-web 经 AgentSessionInfo.getModel 注入；未注入则无法归属，跳过标记）
          const getModel = () => {
            try {
              const m = typeof info.getModel === "function" ? info.getModel() : null;
              return (m && m.provider && m.modelId) ? { provider: m.provider, modelId: m.modelId } : null;
            } catch (e) { return null; }
          };
          const isRl = (text: unknown) => core.isRateLimitError(text, cfg);
          const turn = { hits: 0, errors: [] as string[] };
          const reset = () => { turn.hits = 0; turn.errors = []; };
          // 会话观测摄入（直连模型）：非 2xx/3xx 错误文案 → 伪状态码分类 → 与代理日志同构汇入 runtimeErrors。
          // 走代理的 provider（多 key/聚合组）由 usage log tail 归集（带 key 归因）→ 跳过会话摄入防双计。
          const proxyCache = new Map<string, boolean>();
          const ingestSessionError = (text: unknown) => {
            const em = String(text || "");
            if (!em) return;
            const m = getModel();
            if (!m) return;
            let up = proxyCache.get(m.provider);
            if (up == null) { up = core.providerUsesProxy(cfg, m.provider); proxyCache.set(m.provider, up); }
            if (up) return;
            const status = core.pseudoStatusFromText(em, cfg);
            if (!status) return; // 无法分类 → 不入（避免噪音）
            try {
              const state = core.loadState(configDir);
              core.ingestRuntimeError(state, { provider: m.provider, model: m.modelId, status, key: "", src: "session", at: Date.now() });
              core.pruneRuntimeErrors(state);
              tailStaged = state.runtimeErrors;
              scheduleTailFlush(); // 与 tailer 共用 800ms 合并器：突发 30 连发也只落盘/推送一次
            } catch (e) { /* 尽力而为 */ }
          };
          const maybeMark = (blocked: boolean) => {
            // 大量出错（≥minCount）且该次执行被阻断 → 标记；否则（临时出错/未阻断）不标记
            if (!blocked || turn.hits < minCount) return;
            const m = getModel();
            if (!m) return;
            try {
              const state = core.loadState(configDir);
              const ev = {
                provider: m.provider, model: m.modelId, count: turn.hits, blocked: true, marked: true,
                errorSummary: turn.errors[turn.errors.length - 1] || "运行中被大量 429/限流错误阻断",
                sessionId: String(info.sessionId || ""), source: "runtime", at: Date.now(),
              };
              core.recordBlockedExecution(state, ev);
              core.markBlocked(state, m.provider, m.modelId, ev);
              core.saveState(configDir, state);
              notifyAvailability();
              console.log("[aiti-model-check] 运行监测：会话 " + info.sessionId + " 被大量 429 阻断（" + turn.hits + " 次），已标记 " + m.provider + "/" + m.modelId + " 不可用");
            } catch (e) { console.warn("[aiti-model-check] 运行监测标记失败", e); }
          };
          const unsub = info.subscribeEvent((ev: any) => {
            try {
              const t = (ev && ev.type) || "";
              if (t === "turn_start") { reset(); return; }
              if (t === "auto_retry_start") { // 一次可重试的限流/服务器/网络错误（429/5xx/网络…）
                const em = (ev.errorMessage || "");
                if (em) { ingestSessionError(em); if (isRl(em)) { turn.hits++; if (turn.errors.length < 10) turn.errors.push(String(em).slice(0, 200)); } }
                return;
              }
              if (t === "auto_retry_end") {
                if (ev.success === false) { // 重试耗尽 → 该次执行被阻断
                  if (turn.hits === 0 && isRl(ev.finalError)) turn.hits = 1;
                  maybeMark(true);
                  reset();
                } else {
                  reset(); // 重试成功 → 临时出错，清零（不标记）
                }
                return;
              }
              if (t === "agent_end") {
                if (ev.willRetry === false) {
                  const msgs = ev.messages;
                  if (Array.isArray(msgs) && msgs.length) {
                    const last = msgs[msgs.length - 1];
                    if (last && last.role === "assistant" && last.stopReason === "error") {
                      ingestSessionError(last.errorMessage); // 最终错误（不限限流）→ 会话观测
                      if (isRl(last.errorMessage)) {
                        if (turn.hits === 0) turn.hits = 1;
                        maybeMark(true); // 最终错误即限流 → 执行被阻断
                      }
                    }
                  }
                }
                reset();
                return;
              }
              if (t === "agent_settled" || t === "prompt_done") { reset(); return; }
            } catch (e) { /* 单事件异常不影响订阅 */ }
          });
          if (typeof unsub === "function") runtimeUnsubs.push(unsub);
        } catch (e) { console.warn("[aiti-model-check] 运行监测初始化失败", e); }
      },
    },
  },
};
