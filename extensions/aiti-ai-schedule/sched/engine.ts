/**
 * engine.ts —— 调度内核 + 执行引擎（方案 §4/§5）
 *
 * 统一任务模型：hook（扩展声明式 schedules）+ ai（plans.json 里的 Plan）
 *   - tick 驱动：到点执行；水位持久化（state.json）；启动补跑/missed（宽限默认 5min）
 *   - 门控：AITI_AI_SCHEDULE_ENABLED env（未设=off，防 dev/prod 双触发，方案 §4.1）
 *           + configDir/aiti-ai-schedule.json { enabled }（运行时暂停开关，默认 on）
 *   - 执行：hook → 直接调用；ai → 三模式（session 注入活会话 / 一次性会话 / invokeAI）
 *   - 安全网：并发上限、单次超时、失败重试 1 次、once 自停、maxRuns 到量停
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join as pathJoin, dirname as pathDirname, basename as pathBasename } from "node:path";
import { Store, type Plan, type RunRecord } from "./store.ts";
import { parseSchedule, parseSchedules, nextRunAt, type ScheduleSpec } from "./cron.ts";
import { sendOnMatch, type OutboundFn, type OutboundResult } from "./outbound.ts";

// ---- 配置 ----

const CONCURRENCY_LIMIT = 2;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** state 根解析（两套语义，禁止再拼 config/state 或丢层级）：
 *  - AITI_AI_SCHEDULE_DATA_DIR（自管数据目录，部署 env 显式指定；如 48-dev 的 ~/.pi/web-dev/data/aiti-ai-schedule）
 *    → 其下直接 state/（本数据域自带分层，2026-09-13 三目录改造前语义）
 *  - 宿主 ctx.configDir（= <extRoot>/config）→ state 在 <extRoot>/state（三目录对称）
 */
export function resolveStateDir(configDir: string): string {
  if (process.env.AITI_AI_SCHEDULE_DATA_DIR) return pathJoin(process.env.AITI_AI_SCHEDULE_DATA_DIR, "state");
  const base = pathBasename(configDir) === "config" ? pathDirname(configDir) : configDir;
  return pathJoin(base, "state");
}

function envOn(): boolean {
  const v = process.env.AITI_AI_SCHEDULE_ENABLED;
  return v !== undefined && /^(1|true|yes|on)$/i.test(String(v));
}
function graceSec(): number {
  const v = Number(process.env.AITI_AI_SCHEDULE_CATCHUP_GRACE_SEC);
  return Number.isFinite(v) && v > 0 ? v : 300;
}

interface HookTask {
  extId: string; id: string; name: string;
  extConfigDir: string;          // 扩展自身 configDir（§2.5 契约：ctx.configDir = 扩展的，不是调度器的）
  spec: ReturnType<typeof parseSchedule>;
  enabled: boolean;
  run: (ctx: any) => Promise<any> | any;
}

/** 统一调度条目（多调度：specs[i] 对应 specAt[i]，nextRunAt = 全部时点的最小值） */
interface Entry {
  key: string;                   // "hook:extId:schedId" | "plan:<planId>"
  kind: "hook" | "ai";
  name: string;
  enabled: boolean;
  spec: NonNullable<ReturnType<typeof parseSchedule>>; // 兼容字段 = specs[0]（once 判断/展示用）
  specs: ScheduleSpec[];         // 全部调度（hook 恒 1 个；ai 计划可多个）
  specAt: number[];              // 每个 spec 的下一次执行时点（epoch ms；耗尽 = Number.MAX_SAFE_INTEGER）
  nextRunAt: number;
  lastRunAt: number | null;
  runCount: number;
  running: boolean;
  plan?: Plan;                   // kind=ai 时有效
  hook?: HookTask;               // kind=hook 时有效
}

// ---- 每日执行预算（方案 §10：高频计划打爆 token 的对策）----
// state.json["_daily"] = { date: "YYYY-MM-DD", counts: { [entryKey]: n } }——自动触发计数，
// 手动 ▶ 不占预算；跨日自动清零；plan.dailyCap 为计划级上限，config { dailyCap } 为全局兜底。
const DAILY_KEY = "_daily";
function today(): string { return new Date().toISOString().slice(0, 10); }


export interface EngineEvents {
  emit(type: string, payload: any): void;
}

export class Engine {
  store: Store;
  private entries = new Map<string, Entry>();
  private timer: any = null;
  private cfgFile: string;
  private executing = 0;
  // 会话接线（方案 §5）：onAgentSession 维护活会话 steer 句柄
  liveSessions = new Map<string, { cwd: string; steer: (t: string) => Promise<void>; startedAt: number }>();
  /** 一次性会话 invoke 的 pending 等待（sessionId → resolve）——由扩展入口把 onAgentSettled 接进来 */
  pendingInvokes = new Map<string, { resolve: (text: string) => void; reject: (e: Error) => void; timer: any }>();
  events: EngineEvents;
  /** 结果送达回调（集成方案 §4.3，index.ts startup 注入；内核不感知外部实现） */
  outbound: OutboundFn | null;
  /** missed 告警节流（A29 后续）：plan.id → 上次告警 ms；1h 窗口防重启风暴连发 */
  private missedAlertAt = new Map<string, number>();

  constructor(configDir: string, events: EngineEvents, outbound?: OutboundFn) {
    // 数据分层：计划/水位/运行历史（不可再生）→ state/；config 仅 aiti-ai-schedule.json
    // （state 位置解析见 resolveStateDir：env 自管目录 vs 宿主 <extRoot>/config，2026-09-13）
    this.store = new Store(resolveStateDir(configDir));
    this.cfgFile = pathJoin(configDir, "aiti-ai-schedule.json");
    this.events = events;
    this.outbound = outbound || null;
  }

  // ---- 全局配置 ----

  loadConfig(): any {
    try { return JSON.parse(readFileSync(this.cfgFile, "utf8")); } catch { return {}; }
  }
  saveConfig(cfg: any) {
    try { mkdirSync(this.store.dir, { recursive: true }); writeFileSync(this.cfgFile, JSON.stringify(cfg, null, 2) + "\n"); } catch {}
  }
  /** 触发总开关：env 门控（未设=off）+ config 运行时暂停。UI/API 照常可看可管。 */
  triggerEnabled(): boolean {
    return envOn() && this.loadConfig().enabled !== false;
  }

  // ---- 注册 ----

  /** 聚合各扩展声明的 schedules（§2.5）。热重载后重复调用安全：同名任务更新闭包保留水位。 */
  registerHooks(all: Array<{ id: string; configDir?: string; schedules?: any[] }>) {
    for (const ext of all) {
      if (!Array.isArray(ext?.schedules)) continue;
      for (const s of ext.schedules) {
        if (!s || !s.id || typeof s.run !== "function") continue;
        const spec = parseSchedule({ everySec: s.intervalSec || s.everySec, ...s });
        if (!spec) continue;
        const key = "hook:" + ext.id + ":" + s.id;
        const name = String(s.name || s.id);
        const prev = this.entries.get(key);
        const wm = this.store.watermark(key);
        const specAt = [prev ? prev.nextRunAt : this.initialNext(spec, wm, name)];
        this.entries.set(key, {
          key, kind: "hook",
          name,
          enabled: s.enabled !== false,
          spec,
          specs: [spec],
          specAt,
          nextRunAt: specAt[0],
          lastRunAt: wm.lastRunAt,
          runCount: prev ? prev.runCount : 0,
          running: false,
          hook: { extId: ext.id, id: key.slice(5), name, extConfigDir: String(ext.configDir || ""), spec, enabled: s.enabled !== false, run: s.run },
        });
      }
    }
    this.rebuildPlans();
  }

  /** plans.json → 调度条目（每次 plans 变更后调用）。 */
  rebuildPlans() {
    for (const p of this.store.plans) this.upsertPlanEntry(p, false);
    this.saveWatermarks();
  }

  upsertPlanEntry(p: Plan, persist = true) {
    // 先按原始形态解析（字符串/对象/数组均可），再把 plan.timezone 附加到每个 spec
    // （修复：此前对字符串 schedule 做 {...spread} 展开出字符索引对象 → 解析失败 → 条目静默丢弃）
    const parsed = parseSchedules(p.schedule);
    const specs = parsed && p.timezone
      ? parsed.map((sp) => (sp.type === "once" ? sp : { ...sp, tz: p.timezone }))
      : parsed;
    const key = "plan:" + p.id;
    const prev = this.entries.get(key);
    const wm = this.store.watermark(key);
    if (!specs) {
      this.entries.delete(key);
      return;
    }
    const enabled = p.enabled === true;
    // 保持既有水位：同启停态 + 多调度内容未变（逐个 spec 指纹一致）→ 完全沿用 prev.specAt（含过期点，由 tick 补跑）；
    // 否则（新建/编辑改了 schedule）→ 重算：单 spec 走 initialNext（含水位补跑/missed），多 spec 从 now 起算各时点。
    const sameShape = prev && prev.enabled === enabled && prev.specs.length === specs.length
      && specs.every((s, i) => JSON.stringify(s) === JSON.stringify(prev.specs[i]));
    const specAt = sameShape ? prev!.specAt : this.initialSpecAt(specs, wm, p.name, p);
    this.entries.set(key, {
      key, kind: "ai", name: p.name,
      enabled,
      spec: specs[0],
      specs,
      specAt,
      nextRunAt: Math.min(...specAt),
      lastRunAt: wm.lastRunAt,
      runCount: p.runCount || 0,
      running: false,
      plan: p,
    });
    if (persist) this.saveWatermarks();
  }

  removePlan(id: string) {
    this.entries.delete("plan:" + id);
    delete this.store.state["plan:" + id];
    this.store.saveState();
  }

  /**
   * 初始下次执行时间（水位补跑判定，方案 §4.2）：
   *   水位为空（首次注册）→ 从现在起算；
   *   已过期且在宽限内 → 保留过期时间点（tick 立即补跑）；
   *   已过期超宽限 → 记 missed 并跳到下一个未来时点。
   */
  private initialNext(spec: NonNullable<ReturnType<typeof parseSchedule>>, wm: { nextRunAt: number }, label = "(未知任务)", plan?: Plan): number {
    const now = Date.now();
    if (!wm.nextRunAt) {
      const n = nextRunAt(spec, now);
      return n ?? now;
    }
    if (wm.nextRunAt <= now) {
      if (now - wm.nextRunAt <= graceSec() * 1000) return wm.nextRunAt; // 补跑
      // 门控关闭（没人在值班）期间的水位过期 ≠ 漏跑，静默顺延不记 missed
      if (this.triggerEnabled()) this.logMissed(label, wm.nextRunAt, plan);
      const n = nextRunAt(spec, now);
      return n ?? now; // once 过期即不再自动触发
    }
    return wm.nextRunAt;
  }

  /**
   * 多调度初始时点：单 spec 走 initialNext（含水位补跑/missed）；多 spec 从 now 起算每个 spec 的下一个未来时点
   * （各时点独立推进，取最小值触发——工作日/非工作日等不同 cron 共存）。
   */
  private initialSpecAt(specs: ScheduleSpec[], wm: { nextRunAt: number }, label = "(未知任务)", plan?: Plan): number[] {
    if (specs.length === 1) return [this.initialNext(specs[0], wm, label, plan)];
    const now = Date.now();
    return specs.map((s) => nextRunAt(s, now) ?? Number.MAX_SAFE_INTEGER);
  }

  private logMissed(label: string, missedAt: number, plan?: Plan) {
    this.store.appendRun({
      id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      targetId: "(watermark)", kind: "hook", name: label,
      at: new Date().toISOString(), status: "missed", ms: 0,
      error: "计划时点 " + new Date(missedAt).toISOString() + " 已超宽限（" + graceSec() + "s），跳过",
    });
    // A29 后续：missed 也走 cc/mail 告警（09-09 早报漏报事故复盘——"重启迟到窗外"的静默漏报要可见）。
    // 尊重 sendOn（="ok" 表示用户明确不要失败类提醒）；1h 节流防重启风暴连发；fire-and-forget。
    if (!plan || !this.outbound) return;
    const now = Date.now();
    if (now - (this.missedAlertAt.get(plan.id) ?? 0) < 60 * 60 * 1000) return;
    if (!sendOnMatch(plan.sendOn, "error")) return;
    this.missedAlertAt.set(plan.id, now);
    try {
      this.outbound(plan, {
        status: "error",
        at: new Date().toISOString(), ms: 0, runId: "missed_" + plan.id,
        error: "计划时点 " + new Date(missedAt).toISOString() + " 已超补跑宽限（" + graceSec() + "s）未执行（missed，非失败重试）",
      });
    } catch { /* 送达失败不影响调度 */ }
  }

  // ---- tick ----

  start() {
    if (this.timer) return;
    // 清理陈旧水位键（扩展卸载/计划已删的残留）；_daily 是每日预算桶，必须保留
    for (const k of Object.keys(this.store.state)) {
      if (k !== DAILY_KEY && !this.entries.has(k)) delete this.store.state[k];
    }
    this.store.saveState();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer?.unref?.();
    console.log("[aiti-ai-schedule] 引擎启动 · entries=" + this.entries.size +
      " · trigger=" + (this.triggerEnabled() ? "ON" : "OFF") +
      " · env=" + (process.env.AITI_AI_SCHEDULE_ENABLED ?? "-"));
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.saveWatermarks();
  }

  saveWatermarks() {
    for (const e of this.entries.values()) {
      this.store.setWatermark(e.key, { nextRunAt: e.nextRunAt, lastRunAt: e.lastRunAt });
    }
    // 把运行字段回写 plan 快照
    let dirty = false;
    for (const e of this.entries.values()) {
      if (e.kind !== "ai" || !e.plan) continue;
      if (e.plan.nextRunAt !== e.nextRunAt || e.plan.lastRunAt !== e.lastRunAt || e.plan.runCount !== e.runCount) {
        e.plan.nextRunAt = e.nextRunAt; e.plan.lastRunAt = e.lastRunAt; e.plan.runCount = e.runCount;
        dirty = true;
      }
    }
    if (dirty) this.store.savePlans();
  }

  /** 当日自动触发计数（懒重置跨日） */
  private dailyCounts(): Record<string, number> {
    const d = this.store.state as any;
    if (!d[DAILY_KEY] || d[DAILY_KEY].date !== today()) {
      d[DAILY_KEY] = { date: today(), counts: {}, skippedNotified: {} };
      this.store.saveState();
    }
    return d[DAILY_KEY].counts;
  }
  private dailySkippedNotified(): Record<string, boolean> {
    const d = this.store.state as any;
    return d[DAILY_KEY].skippedNotified || (d[DAILY_KEY].skippedNotified = {});
  }
  /** 该条目今日剩余预算（Infinity=无限制）；≤0=已用完。
   *  计划级用本任务计数；全局级用所有任务合计。 */
  dailyRemaining(e: Entry): number {
    const planCap = e.plan?.dailyCap;
    const globalCap = Number(this.loadConfig().dailyCap) || Infinity;
    const counts = this.dailyCounts();
    const usedSelf = counts[e.key] || 0;
    const usedTotal = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
    return Math.min(planCap ? planCap - usedSelf : Infinity, globalCap - usedTotal);
  }

  tick() {
    const active = this.triggerEnabled();
    const now = Date.now();
    for (const e of [...this.entries.values()].sort((a, b) => a.nextRunAt - b.nextRunAt)) {
      if (e.nextRunAt > now) break;
      if (!active || !e.enabled || e.running) continue;
      if (this.executing >= CONCURRENCY_LIMIT) break;
      // 每日预算：超限 → 顺延水位并记一次 skipped（每任务每天只记一条，防刷屏）
      if (e.kind === "ai") {
        const remain = this.dailyRemaining(e);
        if (remain <= 0) {
          const sn = this.dailySkippedNotified();
          if (!sn[e.key]) {
            sn[e.key] = true;
            this.store.appendRun({
              id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              targetId: e.key, kind: e.kind, name: e.name,
              at: new Date().toISOString(), status: "skipped", ms: 0,
              error: "已达每日执行预算" + (e.plan?.dailyCap ? "（计划级 " + e.plan.dailyCap + " 次/天）" : "") + "，明日自动恢复",
            });
            this.events.emit("run", { targetId: e.key, kind: e.kind, name: e.name, at: new Date().toISOString(), status: "skipped", error: "达到每日执行预算" });
            this.store.saveState();
          }
          this.advance(e, now);
          continue;
        }
      }
      void this.execute(e);
    }
  }

  // ---- 执行 ----

  listEntries() {
    return [...this.entries.values()]
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
      .map((e) => ({
        key: e.key, kind: e.kind, id: e.kind === "hook" ? e.hook!.id : e.plan!.id,
        name: e.name, enabled: e.enabled,
        schedule: e.specs.map((sp) => sp.type === "cron" ? sp.expr : sp.type === "interval" ? "每 " + sp.everySec + "s" : new Date(sp.at).toISOString()).join(" · "),
        mode: e.kind === "ai" ? e.plan!.mode : "hook",
        rawSchedule: e.kind === "ai" ? e.plan!.schedule : undefined,
        createdBy: e.kind === "ai" ? e.plan!.createdBy : undefined,
        autoApprove: e.kind === "ai" ? e.plan!.autoApprove : undefined,
        maxRuns: e.kind === "ai" ? e.plan!.maxRuns : undefined,
        dailyCap: e.kind === "ai" ? e.plan!.dailyCap : undefined,
        timezone: e.kind === "ai" ? e.plan!.timezone : undefined,
        todayCount: e.kind === "ai" ? ((this.store.state as any)[DAILY_KEY]?.counts?.[e.key] || 0) : undefined,
        notify: e.kind === "ai" ? e.plan!.notify : undefined,
        prompt: e.kind === "ai" ? e.plan!.prompt : undefined,
        cwd: e.kind === "ai" ? e.plan!.cwd : undefined,
        model: e.kind === "ai" ? e.plan!.model : undefined,
        // 结果送达配置回显（集成方案 §4.2：列表行 💬/✉ 标记的数据源）
        cc: e.kind === "ai" ? e.plan!.cc ?? null : undefined,
        mailTo: e.kind === "ai" ? e.plan!.mailTo ?? null : undefined,
        sendOn: e.kind === "ai" ? e.plan!.sendOn ?? "all" : undefined,
        nextRunAt: e.nextRunAt, lastRunAt: e.lastRunAt, runCount: e.runCount,
        running: e.running,
        triggerEnabled: this.triggerEnabled(),
      }));
  }

  /** 手动触发：fire-and-forget（结果经 SSE/运行历史可见），返回条目供回显状态。 */
  runNow(key: string): Entry | null {
    const k = key.startsWith("plan:") || key.startsWith("hook:") ? key : this.findKey(key);
    const e = k ? this.entries.get(k) : null;
    if (!e || e.running) return e || null;
    void this.execute(e, true);
    return e;
  }

  private findKey(id: string): string | undefined {
    for (const k of this.entries.keys()) if (k.endsWith(":" + id) || k === "plan:" + id) return k;
    return undefined;
  }

  private advance(e: Entry, from: number) {
    // 多调度：只推进「触发本次执行的那一个时点」（specAt[i] === fired），其余时点保持不动，
    // 之后整体 nextRunAt 重新取最小——多个时点不会相互干扰、也不会丢次。
    const fired = e.nextRunAt;
    for (let i = 0; i < e.specs.length; i++) {
      if (e.specAt[i] !== fired) continue;
      const n = nextRunAt(e.specs[i], Math.max(from, Date.now() - 1));
      e.specAt[i] = n ?? Number.MAX_SAFE_INTEGER; // once 跑完/无法计算 → 该时点耗尽，不再自动触发
    }
    e.nextRunAt = Math.min(...e.specAt);
  }

  /**
   * 结果送达（集成方案 §4.3）：仅 ai 计划 + 仅 ok/error（skipped/missed 是调度层事件永不发）；
   * 再按 plan.sendOn 过滤；fire-and-forget——不 await、不占并发窗口、失败不影响任务状态。
   * 自动与手动 ▶ 都触发（手动也是验证通道的方式）。
   */
  private notifyOutbound(e: Entry, r: OutboundResult) {
    if (!this.outbound || e.kind !== "ai" || !e.plan) return;
    if (r.status !== "ok" && r.status !== "error") return; // skipped/missed 永不发
    if (!sendOnMatch(e.plan.sendOn, r.status)) return;
    try { this.outbound(e.plan, r); } catch { /* 送达失败不影响任务 */ }
  }

  private async execute(e: Entry, manual = false) {
    e.running = true;
    this.executing++;
    const started = Date.now();
    let status: RunRecord["status"] = "ok";
    let text: string | undefined;
    let error: string | undefined;
    let sessionId: string | null = null;
    let model: string | null = null;
    const base: Omit<RunRecord, "status"> = {
      id: "r_" + started.toString(36) + Math.random().toString(36).slice(2, 6),
      targetId: e.key, kind: e.kind, name: e.name, at: new Date().toISOString(), mode: e.kind === "ai" ? e.plan!.mode : "hook",
    };
    try {
      if (e.kind === "hook") {
        const t = e.hook!;
        await t.run({
          configDir: t.extConfigDir || this.store.dir, extId: t.extId, scheduleId: t.id, manual,
        });
      } else {
        const p = e.plan!;
        const r = await this.executePlan(p);
        text = r.text; error = r.error; sessionId = r.sessionId; model = r.model;
        if (r.error) throw new Error(r.error);
      }
    } catch (err: any) {
      // 失败重试 1 次（方案 §5），间隔 60s —— 用简单串行重试（不占并发窗口太久）
      error = String(err?.message || err);
      status = "error";
    }
    // once 自停 / maxRuns 到量自停（方案 §4.5）——只对自动触发生效；
    // 手动 ▶ 执行是「验证」，不消耗次数、不触发 once/maxRuns 自停
    if (status === "ok" && !manual) {
      e.runCount++;
      if (e.kind === "ai") {
        const dc = this.dailyCounts();
        dc[e.key] = (dc[e.key] || 0) + 1;
        delete this.dailySkippedNotified()[e.key];
        this.store.saveState();
      }
      if (e.kind === "ai" && e.plan) {
        e.plan.enabled = e.enabled;
        if (e.plan.maxRuns && e.runCount >= e.plan.maxRuns) e.plan.enabled = false;
        this.store.savePlans();
      }
    }
    // 持续失败自动暂停（方案 §5）：连续 3 次失败（不含重试成功重置）→ 停用并记录
    if (!manual) {
      const ef = e as any;
      if (status === "error") ef.consFail = (ef.consFail || 0) + 1;
      else ef.consFail = 0;
      if (status !== "ok" && ef.consFail >= 3 && e.enabled) {
        e.enabled = false;
        if (e.kind === "ai" && e.plan) { e.plan.enabled = false; e.plan.lastStatus = "paused"; this.store.savePlans(); }
        this.store.appendRun({
          id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          targetId: e.key, kind: e.kind, name: e.name,
          at: new Date().toISOString(), status: "skipped", ms: 0,
          error: "连续失败 " + ef.consFail + " 次，已自动暂停（管理页重新启用可恢复）",
        });
        this.events.emit("run", { targetId: e.key, kind: e.kind, name: e.name, at: new Date().toISOString(), status: "skipped", error: "连续失败自动暂停" });
      }
    }
    if (manual) {
      // 手动触发不打乱原定水位：只更新 lastRunAt
      e.lastRunAt = Date.now();
    } else if (status === "ok") {
      e.lastRunAt = Date.now();
      this.advance(e, e.lastRunAt);
      // 全部时点耗尽（纯 once 计划跑完 / cron 无未来时点）→ 自停；interval 永不耗尽
      if (e.nextRunAt === Number.MAX_SAFE_INTEGER) e.enabled = false;
    } else {
      // 失败：跳过该时点，按正常节奏走（避免每秒重试风暴）；重试逻辑见下
      e.lastRunAt = Date.now();
      this.advance(e, e.lastRunAt);
    }
    e.running = false;
    this.executing--;
    // 水位即时落盘（方案 §4.1：nextRunAt 持久化，崩溃后可凭 state.json 补跑/记 missed）
    this.store.setWatermark(e.key, { nextRunAt: e.nextRunAt, lastRunAt: e.lastRunAt });
    if (e.kind === "ai" && e.plan) {
      e.plan.lastRunAt = e.lastRunAt; e.plan.nextRunAt = e.nextRunAt;
      e.plan.runCount = e.runCount;
      e.plan.enabled = e.enabled; // 自停/暂停/启停同步持久化（once 耗尽、maxRuns、失败暂停等）
      e.plan.lastStatus = status; e.plan.lastError = error || null;
      this.store.savePlans();
    }
    this.store.appendRun({ ...base, status, ms: Date.now() - started, text: text?.slice(0, 4000), error, sessionId, model });
    this.events.emit("run", { ...base, status, error, name: e.name, notify: !!(e.kind === "ai" && e.plan?.notify) });
    // 结果送达（方案 §4.3）：fire-and-forget，runId 供 RunRecord 就地补记送达备注
    this.notifyOutbound(e, { status: status as "ok" | "error", text, error, at: base.at, ms: Date.now() - started, runId: base.id });

    // 失败重试 1 次（延迟 60s，独立于 tick）——仅自动触发；手动失败由用户自行决定是否再跑
    if (status === "error" && !manual && !(e as any).retryScheduled) {
      (e as any).retryScheduled = true;
      setTimeout(async () => {
        (e as any).retryScheduled = false;
        if (!this.entries.has(e.key) || !e.enabled || !this.triggerEnabled()) return;
        try {
          e.running = true;
          const retryStart = Date.now();
          const retryId = "r_" + retryStart.toString(36) + Math.random().toString(36).slice(2, 6);
          let retryText: string | undefined;
          if (e.kind === "hook") await e.hook!.run({ configDir: e.hook!.extConfigDir || this.store.dir, extId: e.hook!.extId, scheduleId: e.hook!.id, manual: false });
          else {
            const r = await this.executePlan(e.plan!);
            retryText = r.text;
            if (r.error) throw new Error(r.error);
          }
          this.store.appendRun({
            ...base, id: retryId,
            at: new Date().toISOString(), status: "ok", ms: Date.now() - retryStart,
            text: "(重试成功)",
          });
          this.events.emit("run", { targetId: e.key, kind: e.kind, name: e.name, at: new Date().toISOString(), status: "ok", retry: true });
          this.notifyOutbound(e, { status: "ok", text: retryText, at: new Date().toISOString(), ms: Date.now() - retryStart, runId: retryId });
        } catch (err: any) {
          const failId = "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const failErr = "重试仍失败：" + String(err?.message || err);
          this.store.appendRun({
            ...base, id: failId,
            at: new Date().toISOString(), status: "error",
            error: failErr,
          });
          this.events.emit("run", { targetId: e.key, kind: e.kind, name: e.name, at: new Date().toISOString(), status: "error", retry: true, error: failErr });
          this.notifyOutbound(e, { status: "error", error: failErr, at: new Date().toISOString(), ms: 0, runId: failId });
        } finally {
          e.running = false;
        }
      }, 60_000).unref?.();
    }
  }

  /** AI 计划三模式执行（方案 §5）。返回文本/错误；throw 由上层兜底。 */
  private async executePlan(p: Plan): Promise<{ text?: string; error?: string; sessionId?: string | null; model?: string | null }> {
    const timeoutMs = DEFAULT_TIMEOUT_MS;
    if (p.mode === "invokeAI") return this.execInvokeAI(p, timeoutMs);
    if (p.mode === "session" || p.mode === "auto") {
      // auto：优先注入同 cwd 的活会话；无则降级一次性会话
      if (p.mode === "auto") {
        const live = this.pickLiveSession(p.cwd);
        if (live) {
          try {
            await Promise.race([
              live.steer("[定时任务 " + p.name + "] " + p.prompt),
              new Promise((_, rej) => setTimeout(() => rej(new Error("steer 超时")), 30_000)),
            ]);
            return { text: "(已注入活会话 " + live.sessionId.slice(0, 12) + "…，结果随会话产生)", sessionId: live.sessionId };
          } catch { /* 注入失败降级一次性会话 */ }
        }
      }
      return this.execNewSession(p, timeoutMs);
    }
    return { error: "未知执行模式：" + p.mode };
  }

  private pickLiveSession(cwd?: string): { sessionId: string; steer: (t: string) => Promise<void> } | null {
    let best: { sessionId: string; steer: any; startedAt: number } | null = null;
    for (const [sid, info] of this.liveSessions) {
      if (cwd && !info.cwd.startsWith(cwd)) continue;
      if (!best || info.startedAt > best.startedAt) best = { sessionId: sid, steer: info.steer, startedAt: info.startedAt };
    }
    return best;
  }

  private async execInvokeAI(p: Plan, timeoutMs: number): Promise<{ text?: string; error?: string; model?: string | null }> {
    const fn = (globalThis as Record<string, any>).__aitiAiScheduleInvokeAI;
    if (typeof fn !== "function") return { error: "ctx.invokeAI 不可用（框架未提供）" };
    const res = await Promise.race([
      fn({
        system: "你是定时任务执行器。完成用户给出的任务并直接输出结果正文。",
        messages: [{ role: "user", content: p.prompt }],
        ...(p.model ? (() => { const [provider, modelId] = splitModel(p.model); return provider && modelId ? { provider, modelId } : { modelId: p.model }; })() : {}),
        caller: "aiti-ai-schedule/" + p.id,
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("invokeAI 超时（" + Math.round(timeoutMs / 1000) + "s）")), timeoutMs)),
    ]) as any;
    return { text: res?.text, model: res?.model || p.model || null };
  }

  /** 一次性全功能会话（复用 aiti-helper 的 /api/agent/new + onAgentSettled 模式）。 */
  private async execNewSession(p: Plan, timeoutMs: number): Promise<{ text?: string; error?: string; sessionId?: string | null; model?: string | null }> {
    const apiOrigin = process.env.AITI_AI_SCHEDULE_API_ORIGIN || "http://127.0.0.1:" + (process.env.PORT || "3000");
    const basePath = process.env.PI_WEB_BASE_PATH || "";
    const body: Record<string, unknown> = { cwd: p.cwd || process.env.HOME || "/tmp", type: "prompt", message: p.prompt };
    if (p.model) {
      const [provider, modelId] = splitModel(p.model);
      if (provider && modelId) { body.provider = provider; body.modelId = modelId; }
      else body.modelId = p.model;
    }
    let resp: Response;
    try {
      resp = await fetch(apiOrigin + basePath + "/api/agent/new", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      return { error: "创建会话失败（" + apiOrigin + "）：" + (e?.message || e) };
    }
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok || (!data?.success && !data?.sessionId)) {
      return { error: "agent/new 失败 HTTP " + resp.status + ": " + JSON.stringify(data)?.slice(0, 200) };
    }
    const sessionId: string = data.sessionId;
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInvokes.delete(sessionId);
        reject(new Error("一次性会话执行超时（" + Math.round(timeoutMs / 1000) + "s）· sessionId=" + sessionId));
      }, timeoutMs);
      this.pendingInvokes.set(sessionId, { resolve, reject, timer });
    }).catch((e) => ({ __err: String(e.message || e) })) as any;
    if (result && result.__err) return { error: result.__err, sessionId };
    return { text: String(result), sessionId, model: data?.model?.modelId || p.model || null };
  }

  /** onAgentSettled 接线：resolve 等待中的一次性会话。 */
  settle(sessionId: string, text: string) {
    const w = this.pendingInvokes.get(sessionId);
    if (w) {
      clearTimeout(w.timer);
      this.pendingInvokes.delete(sessionId);
      w.resolve(text);
    }
  }
}

function splitModel(m: string): [string | null, string] {
  const i = m.indexOf("/");
  return i > 0 ? [m.slice(0, i), m.slice(i + 1)] : [null, m];
}
