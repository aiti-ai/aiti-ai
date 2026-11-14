/**
 * aiti-ai-schedule · pi-web 常驻调度器
 *
 * 方案：docs/aiti-ai-schedule-真正方案.md（计划管理 + cron 调度 + AI 执行引擎 + AI 自建计划工具 + 管理 UI）
 * 结构：index.ts（入口装配）+ sched/{cron,store,engine}.ts（内核）+ client/*.mjs（管理页）
 *
 * 扩展注册机制（§2.5）：扩展 export default 加顶层 schedules: [{id, name, intervalSec, enabled, run(ctx)}]，
 *   本扩展启动时经 globalThis.__piWebExt.all() 聚合进调度内核，到点执行——各扩展不再自造 setInterval。
 *
 * 门控（§4.1，防 dev/prod 双触发）：
 *   - AITI_AI_SCHEDULE_ENABLED env：**未设 = 不自动触发**（宁可手动开）；UI/API 照常可看可管
 *   - configDir/aiti-ai-schedule.json { enabled }：运行时暂停开关（默认 on）
 *   - AITI_AI_SCHEDULE_DATA_DIR：覆盖存储目录；AITI_AI_SCHEDULE_API_ORIGIN：一次性会话自调地址
 *
 * 首个接入方：aiti-configs（崩溃哨兵 / 滞留提醒 / 兜底 commit 三任务）
 */
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import { Engine } from "./sched/engine.ts";
import { parseSchedules, nextRunAt } from "./sched/cron.ts";
import { makeOutbound, resolveCcConfig, CC_TIMEOUT_MS, type CcConfig } from "./sched/outbound.ts";
import type { Plan } from "./sched/store.ts";

// ---- 进程内接线（startup 时由 ctx 填充）----

let g = globalThis as Record<string, any>;
g.__aitiAiScheduleInvokeAI = g.__aitiAiScheduleInvokeAI || null; // ctx.invokeAI

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

let engine: Engine | null = null;

function emit(type: string, payload: any) {
  // 帧上总线唯一通道（sched:* 前缀；2026-09-09 拍板：自建 SSE 双轨已删，订阅端 topics 唯一、禁止任何兜底）。
  try { (globalThis as any).__piPageEvents?.publish("sched:" + type, payload ?? {}); } catch {}
}

function resolveDataDir(ctxDataDir: string): string {
  // Docker 标准化（B1）：无 ctx/AITI_AI_SCHEDULE_DATA_DIR 时优先 PI_WEB_DATA_DIR（数据根 …/web/data）
  return process.env.AITI_AI_SCHEDULE_DATA_DIR || ctxDataDir ||
    (process.env.PI_WEB_DATA_DIR ? pathJoin(process.env.PI_WEB_DATA_DIR, "aiti-ai-schedule", "config") : "") ||
    (homedir() + "/.pi/web/data/aiti-ai-schedule/config");
}

// ---- schedule_task 工具描述（方案 §6：让 AI 自己建计划）----

const SCHEDULE_TASK_DESC = `定时任务管理：创建/查询/修改/启停/删除/立即执行「到点自动运行」的计划。

创建计划时：
- schedule 写法（三选一）：
  · cron 表达式："0 9 * * *"（分 时 日 月 周，5 段；也可 6 段带秒）——每天9点、每小时0分等固定时刻用这个
  · 间隔："30m" / "2h" / "90s"（数字+单位 s/m/h/d）——每隔多久跑一次用这个
  · 一次性："+30m" / "+2h"（相对现在）或 {type:"once", at:"2026-09-01T09:00:00"}——只跑一次用这个
- 多调度（可选，数组）：一个任务可有多个不同时点，如工作日/非工作日不同 cron → schedule 传数组 ["0 9 * * 1-5", "0 10 * * 0,6"]，任一时点到达都会执行
- prompt 写「目标 + 验收标准」：给未来的 AI 看的完整指令，包含要做什么、输出到哪里、怎样算完成。不要写"如上所述"之类依赖上下文的话。
- mode 选型：纯问答/汇总报告类（不需要读写文件）→ "invokeAI"；需要读文件/跑命令/写日报文件 → "auto"；明确要注入用户现有会话 → "session"
- 结果送达（可选）：ccProject+ccSessionKey 推送到 cc-connect 的指定 IM 会话；mailTo 发邮件（经 aiti-mail，多邮箱逗号分隔）；sendOn 控制送达条件（缺省 all=成功失败都发）。用户说「结果发我钉钉/发我邮箱」时用这些参数。
- 你（agent）创建的计划默认 autoApprove=false，需用户在管理页批准后才生效——创建后告知用户去 ⏰调度 页批准。`;

export default {
  id: "aiti-ai-schedule",
  name: "AI 自调度（计划管理）",
  icon: "icon.svg",
  client: "dist/aiti-ai-schedule.mjs",

  ai: {
    manage: true,
    intro: "AI 能帮我创建/管理定时任务（schedule_task 工具），也能查运行历史和排障",
    skills: "skills",
  },

  // 功能管理：AI 工具整组开关（默认关；helper 帮助点按需开 或 扩展管理器开）
  features: [
    { id: "agentTools.enabled", type: "boolean", label: "AI 工具（调度）", group: "AI", default: false,
      description: "会话内注入 schedule_task 工具（默认关；需要时经 aiti-helper 帮助点（🤖）临时启用，或扩展管理器开启）" },
  ],

  ui: {
    clientImmediately: false, // [懒加载 v2] M1 已同步生产，懒化重启用
    toolbar: [{ id: "aiti-ai-schedule-open", label: "调度", title: "调度：定时任务与计划管理", icon: "icons/clock.svg" }],
    // aiti-float dock v3 + v4 对齐分组：停靠槽静态声明（懒扩展物化触发 + 静态入口；id 与 client 注册一致）
    rightFileDock: [{ id: "panel", label: "调度" }],
    sidebarExplorerDock: [{ id: "panel", label: "任务" }],
    pages: [{ id: "aiti-ai-schedule-page", label: "调度", title: "aiti-ai-schedule：定时任务与计划管理" }],
    // 调度语法说明（? 帮助浮层）词条——按当前 UI 语言取词
    i18n: {
      "zh-CN": {
        "sh.title": "调度语法说明",
        "sh.titleAttr": "调度语法说明",
        "sh.cronHead": "cron 表达式 5 段：分 时 日 月 周（也可 6 段，开头加秒）",
        "sh.f.min": "分 0-59",
        "sh.f.hour": "时 0-23",
        "sh.f.day": "日 1-31",
        "sh.f.month": "月 1-12",
        "sh.f.dow": "周 0-7（0 和 7 都是周日）",
        "sh.symbols": "符号：* 任意 · , 列举 · - 范围 · / 步进",
        "sh.examples": "示例：",
        "sh.ex.9am": "每天 9:00",
        "sh.ex.5m": "每 5 分钟",
        "sh.ex.twice": "每天 6:30 和 18:30",
        "sh.ex.workday": "工作日（周一~五）9:00",
        "sh.ex.weekend": "周六、周日 10:00",
        "sh.others": "其他写法：30m / 2h / 90s 间隔 · +30m / +2h 或 ISO 时间 一次性",
        "sh.multi": "支持多行 = 多调度：每行一个调度，任一到达即执行（可混排 cron / 间隔 / 一次性，如工作日与周末不同时间）",
        "sh.placeholder": "每行一个调度\ncron \"0 9 * * *\" · 间隔 \"30m\"/\"2h\" · 一次性 \"+30m\"",
        "sh.textareaTitle": "支持多行：每行一个调度（如工作日 0 9 * * 1-5，周末 0 10 * * 0,6），任一到达即执行；失焦即时校验",
      },
      en: {
        "sh.title": "Schedule syntax",
        "sh.titleAttr": "Schedule syntax help",
        "sh.cronHead": "cron expression: 5 fields (min hour day month weekday); optionally 6 fields with leading seconds",
        "sh.f.min": "minute 0-59",
        "sh.f.hour": "hour 0-23",
        "sh.f.day": "day 1-31",
        "sh.f.month": "month 1-12",
        "sh.f.dow": "weekday 0-7 (0 and 7 = Sunday)",
        "sh.symbols": "Symbols: * any · , list · - range · / step",
        "sh.examples": "Examples:",
        "sh.ex.9am": "daily 09:00",
        "sh.ex.5m": "every 5 minutes",
        "sh.ex.twice": "daily 06:30 and 18:30",
        "sh.ex.workday": "weekdays (Mon-Fri) 09:00",
        "sh.ex.weekend": "Sat & Sun 10:00",
        "sh.others": "Others: 30m / 2h / 90s interval · +30m / +2h or ISO time once",
        "sh.multi": "Multiple lines = multiple schedules: one per line, runs when any fires (mix cron / interval / once, e.g. different weekday & weekend times)",
        "sh.placeholder": "One schedule per line\ncron \"0 9 * * *\" · interval \"30m\"/\"2h\" · once \"+30m\"",
        "sh.textareaTitle": "One schedule per line (e.g. weekday 0 9 * * 1-5, weekend 0 10 * * 0,6) — any fires the task; validated on blur",
      },
    },
  },

  server: {
    startup(ctx: any) {
      g.__aitiAiScheduleInvokeAI = ctx.invokeAI || null;
      const configDir = resolveDataDir(ctx.configDir);
      engine = new Engine(configDir, { emit }, makeOutbound(configDir, {
        // 送达备注就地补记到对应 RunRecord（ccSent/mailSent，不新增记录行）
        onNote: (runId, note) => engine?.store.patchRun(runId, note),
      }));
      // §2.5 聚合：收集所有扩展声明的 schedules
      const reg = g.__piWebExt;
      const all = reg && typeof reg.all === "function" ? reg.all() : [];
      engine.registerHooks(all.map((e: any) => ({ id: e?.id, configDir: e?.configDir, schedules: e?.ext?.schedules })));
      engine.start();

      console.log("[aiti-ai-schedule] 就绪 · configDir=" + engine.store.dir);
    },
    shutdown() {
      engine?.stop();
    },

    async api(req: any, ctx: any) {
      if (!engine) return json({ ok: false, error: "engine not ready" }, 503);
      const p = ctx.path || [];
      const url = new URL(req.url);

      // ---- hook 任务（§2.5，兼容旧 API）----
      if (req.method === "GET" && p[0] === "schedules" && p.length === 1) {
        return json({ ok: true, active: engine.triggerEnabled(), tasks: engine.listEntries().filter((t) => t.kind === "hook") });
      }
      if (req.method === "GET" && p[0] === "schedules" && p[1] === "log") {
        return json({ ok: true, runs: engine.store.recentRuns(50) });
      }
      if (req.method === "POST" && p[0] === "schedules" && p[2] === "run") {
        const e = engine.runNow("hook:" + p[1]);
        return e ? json({ ok: true, id: p[1], status: "started" }) : json({ ok: false, error: "task not found: " + p[1] }, 404);
      }

      // ---- 运行历史 ----
      if (req.method === "GET" && p[0] === "runs") {
        const limit = Math.min(500, Number(url.searchParams.get("limit")) || 100);
        return json({ ok: true, runs: engine.store.recentRuns(limit) });
      }

      // ---- cc-connect 代理（集成方案 §4.4：必须走代理——外网 https 下浏览器直连 9820 是
      //      mixed content 被拦，且 token 不能下发前端；client 只调同源扩展 API）----
      if (p[0] === "cc" && req.method === "GET") {
        const cfg: CcConfig = resolveCcConfig(engine.store.dir);
        const fwd = async (path: string) => {
          try {
            const r = await fetch(cfg.baseUrl + path, {
              headers: { ...(cfg.token ? { authorization: "Bearer " + cfg.token } : {}) },
              signal: AbortSignal.timeout(CC_TIMEOUT_MS),
            });
            const d: any = await r.json().catch(() => null);
            if (!r.ok) return json({ ok: false, error: "cc-connect HTTP " + r.status + ": " + JSON.stringify(d).slice(0, 200) }, 502);
            return json({ ok: true, ...(d?.data || d) }); // cc-connect 形态 {data:{...},ok:true} → 摊平
          } catch (e: any) {
            return json({ ok: false, error: "cc-connect 不可达（" + cfg.baseUrl + "）：" + String(e?.message || e) }, 502);
          }
        };
        if (p[1] === "projects" && p.length === 2) return fwd("/api/v1/projects");
        if (p[1] === "sessions" && p.length === 3 && url.searchParams.get("project")) {
          return fwd("/api/v1/projects/" + encodeURIComponent(url.searchParams.get("project")!) + "/sessions");
        }
        return json({ ok: false, error: "not found" }, 404);
      }

      // ---- 启停配置 ----
      if (p[0] === "config") {
        if (req.method === "GET") return json({ ok: true, config: engine.loadConfig(), envEnabled: !!process.env.AITI_AI_SCHEDULE_ENABLED?.match(/^(1|true|yes|on)$/i), active: engine.triggerEnabled() });
        if (req.method === "POST") {
          const body = await req.json().catch(() => null);
          const set = body?.set && typeof body.set === "object" ? body.set : {};
          engine.saveConfig({ ...engine.loadConfig(), ...set });
          return json({ ok: true, config: engine.loadConfig(), active: engine.triggerEnabled() });
        }
      }

      // ---- Plans CRUD（方案 §6/§7 数据面）----
      if (p[0] === "plans") {
        // GET /plans —— 列表（含 hook 任务一起返回，UI 一屏管理）
        if (req.method === "GET" && p.length === 1) {
          return json({ ok: true, plans: engine.listEntries() });
        }
        // POST /plans —— 新建
        if (req.method === "POST" && p.length === 1) {
          const b = await req.json().catch(() => null);
          const err = validatePlanInput(b);
          if (err) return json({ ok: false, error: err }, 400);
          const delivery = sanitizeDelivery(b);
          const plan: Plan = {
            id: "p_" + randomUUID().slice(0, 8),
            name: String(b.name).slice(0, 100),
            schedule: b.schedule,
            prompt: String(b.prompt || ""),
            cwd: b.cwd ? String(b.cwd) : undefined,
            model: b.model ? String(b.model) : undefined,
            mode: ["session", "invokeAI", "auto"].includes(b.mode) ? b.mode : "auto",
            enabled: b.enabled !== false,
            autoApprove: b.autoApprove === true,
            maxRuns: b.maxRuns ? Number(b.maxRuns) : undefined,
            dailyCap: b.dailyCap ? Number(b.dailyCap) : undefined,
            timezone: (b.timezone || b.tz) ? String(b.timezone || b.tz).trim() : undefined,
            notify: b.notify === true,
            ...delivery,
            createdAt: new Date().toISOString(),
            createdBy: b.createdBy === "agent" ? "agent" : "user",
          };
          engine.store.plans.push(plan);
          engine.store.savePlans();
          engine.upsertPlanEntry(plan);
          emit("plans", {});
          return json({ ok: true, plan });
        }
        // POST /plans/validate —— 失焦即时校验（前端 blur 调用；与保存校验同一权威逻辑）
        if (req.method === "POST" && p[1] === "validate" && p.length === 2) {
          const b = await req.json().catch(() => null);
          const sErr = validateSchedule(b?.schedule);
          return sErr ? json({ ok: false, error: sErr }, 400) : json({ ok: true });
        }
        const planId = p[1];
        const plan = planId ? engine.store.getPlan(planId) : null;
        if (planId && !plan && p[2] !== "run") return json({ ok: false, error: "plan not found: " + planId }, 404);
        // PUT /plans/:id —— 编辑
        if (req.method === "PUT" && plan && p.length === 2) {
          const b = await req.json().catch(() => null);
          // 权限：agent 创建且未批准的计划，编辑不得携带启停/审批字段（防绕过待确认）
          if (plan.createdBy === "agent" && !plan.autoApprove && b && typeof b === "object") {
            delete b.enabled; delete b.autoApprove;
          }
          const merged = { ...plan, ...b, id: plan.id };
          const err = validatePlanInput(merged);
          if (err) return json({ ok: false, error: err }, 400);
          Object.assign(plan, {
            name: String(merged.name).slice(0, 100), schedule: merged.schedule, prompt: String(merged.prompt || ""),
            cwd: merged.cwd ? String(merged.cwd) : undefined, model: merged.model ? String(merged.model) : undefined,
            mode: ["session", "invokeAI", "auto"].includes(merged.mode) ? merged.mode : "auto",
            enabled: merged.enabled !== false, autoApprove: merged.autoApprove === true,
            maxRuns: merged.maxRuns ? Number(merged.maxRuns) : undefined,
            dailyCap: merged.dailyCap ? Number(merged.dailyCap) : undefined,
            timezone: (merged.timezone || merged.tz) ? String(merged.timezone || merged.tz).trim() : undefined,
            notify: merged.notify === true,
            ...sanitizeDelivery(b), // 白名单合并：缺省 undefined 即保持原值（旧计划兼容，方案 §4.2）
          });
          engine.store.savePlans();
          engine.upsertPlanEntry(plan);
          emit("plans", {});
          return json({ ok: true, plan });
        }
        // DELETE /plans/:id
        if (req.method === "DELETE" && plan && p.length === 2) {
          engine.store.plans = engine.store.plans.filter((x) => x.id !== planId);
          engine.store.savePlans();
          engine.removePlan(planId!);
          emit("plans", {});
          return json({ ok: true });
        }
        // POST /plans/:id/run | enable | disable | approve
        if (req.method === "POST" && plan && p.length === 3) {
          if (p[2] === "run") { engine.runNow("plan:" + planId); return json({ ok: true, status: "started" }); }
          if (p[2] === "enable" || p[2] === "approve") {
            // 权限：agent 创建且未批准的计划必须先经人工批准（enable 不能替代 approve）
            if (plan.createdBy === "agent" && !plan.autoApprove && p[2] === "enable") {
              return json({ ok: false, error: "该计划由 AI 创建且未批准——请先在 ⏰调度 管理页「✓ 批准」后再启用" }, 403);
            }
            plan.enabled = true; plan.autoApprove = plan.autoApprove || p[2] === "approve";
            engine.store.savePlans(); engine.upsertPlanEntry(plan); emit("plans", {});
            return json({ ok: true, plan });
          }
          if (p[2] === "disable") {
            plan.enabled = false;
            engine.store.savePlans(); engine.upsertPlanEntry(plan); emit("plans", {});
            return json({ ok: true, plan });
          }
        }
      }

      return json({ ok: false, error: "not found" }, 404);
    },

    /** agent 会话接线（方案 §5 session 模式）：维护活会话 steer 句柄 + onAgentSettled 回执 */
    agent: {
      onAgentSession(info: any) {
        if (!engine || !info?.sessionId || typeof info.steer !== "function") return;
        engine.liveSessions.set(String(info.sessionId), {
          cwd: String(info.cwd || ""),
          steer: (t: string) => info.steer(t),
          startedAt: Date.now(),
        });
      },
      onAgentSessionEnd(info: { sessionId: string }) {
        engine?.liveSessions.delete(info?.sessionId);
      },
      onAgentSettled(info: { sessionId: string; text?: string }) {
        engine?.settle(info?.sessionId, String(info?.text || ""));
      },
    agentTools(info: { sessionId: string; cwd: string }) {
      // 门控由 core 统一判定（feature agentTools.enabled + per-session enableExtTools），此处无条件返回
      return [{
        name: "schedule_task",
        description: SCHEDULE_TASK_DESC + "\n\n权限边界：你创建的计划默认停用待用户批准；你不能启用/批准任何计划——创建后务必提示用户去 ⏰调度 页「✓ 批准」。",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "list", "get", "update", "disable", "remove", "run-now"], description: "操作（启用/批准不在工具能力内——需用户在 ⏰调度 管理页操作）" },
            id: { type: "string", description: "计划 id（list/get/update/disable/remove/run-now 用；先 list 拿到）" },
            name: { type: "string", description: "计划名（add/update）" },
            schedule: { type: ["string", "array"], items: { type: "string" }, description: '调度：cron 表达式字符串、"30m"/"+30m" 间隔/一次性、ISO 时间；多调度=数组（如 ["0 9 * * 1-5","0 10 * * 0,6"]，任一到达即执行；每元素与单值同格式）' },
            prompt: { type: "string", description: "目标+验收标准的完整提示词（add/update）" },
            mode: { type: "string", enum: ["auto", "invokeAI", "session"], description: "执行模式（缺省 auto）" },
            model: { type: "string", description: "可选模型（provider/modelId）" },
            cwd: { type: "string", description: "可选工作目录（缺省当前会话 cwd）" },
            notify: { type: "boolean", description: "完成后浏览器通知" },
            ccProject: { type: "string", description: "结果送达：cc-connect 项目名（与 ccSessionKey 一起给才生效）" },
            ccSessionKey: { type: "string", description: "结果送达：cc-connect 会话 key（先在 ⏰调度 编辑页通道选择器查看，只接受已存在的会话）" },
            mailTo: { type: "string", description: "结果送达：邮箱（逗号分隔可多个）；结果经 aiti-mail 发送" },
            sendOn: { type: "string", enum: ["all", "ok", "error"], description: "送达条件：all=成功失败都发（默认）/ ok=仅成功 / error=仅失败" },
            maxRuns: { type: "number", description: "最多执行 N 次后自停" },
            enabled: { type: "boolean", description: "是否启用" },
          },
          required: ["action"],
        },
        async execute(args: any) {
          if (!engine) return { ok: false, error: "engine not ready" };
          const a = String(args.action || "");
          const origin = process.env.AITI_AI_SCHEDULE_API_ORIGIN || "http://127.0.0.1:" + (process.env.PORT || "3000");
          const basePath = process.env.PI_WEB_BASE_PATH || "";
          const base = origin + basePath + "/api/extensions/aiti-ai-schedule";
          const call = async (path: string, method: string, body?: any) => {
            const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
            return r.json().catch(() => ({ ok: false, error: "bad json from " + path }));
          };
          try {
            if (a === "list") {
              const d = await call("/plans", "GET");
              return { ok: true, plans: (d.plans || []).filter((x: any) => x.kind === "ai").map(({ key, kind, prompt, ...rest }: any) => rest) };
            }
            if (a === "get") {
              const d = await call("/plans", "GET");
              const hit = (d.plans || []).find((x: any) => x.id === args.id || x.key === "plan:" + args.id);
              return hit ? { ok: true, plan: hit } : { ok: false, error: "not found: " + args.id };
            }
            if (a === "add") {
              if (!args.name || args.schedule === undefined || !args.prompt) return { ok: false, error: "add 需要 name + schedule + prompt" };
              const d = await call("/plans", "POST", {
                name: args.name, schedule: args.schedule, prompt: args.prompt,
                mode: args.mode || "auto", model: args.model, cwd: args.cwd || info.cwd,
                notify: args.notify === true, maxRuns: args.maxRuns, enabled: false, autoApprove: false,
                createdBy: "agent",
                ...(args.ccProject && args.ccSessionKey ? { cc: { project: args.ccProject, sessionKey: args.ccSessionKey } } : {}),
                ...(args.mailTo !== undefined ? { mailTo: args.mailTo } : {}),
                ...(args.sendOn !== undefined ? { sendOn: args.sendOn } : {}),
              });
              if (!d.ok) return d;
              return { ok: true, plan: { id: d.plan.id, name: d.plan.name }, note: "已创建（待确认生效）——请告知用户在 ⏰调度 管理页批准后才会自动执行" };
            }
            if (a === "update") {
              if (!args.id) return { ok: false, error: "update 需要 id" };
              const { id, action, ccProject, ccSessionKey, ...patch } = args;
              // cc 两参数 → 白名单形态 {cc:{project,sessionKey}}（任一缺省/为空 = 清除送达）
              if (ccProject !== undefined || ccSessionKey !== undefined) {
                patch.cc = ccProject && ccSessionKey ? { project: String(ccProject), sessionKey: String(ccSessionKey) } : null;
              }
              return await call("/plans/" + encodeURIComponent(args.id), "PUT", patch);
            }
            if (a === "enable" || a === "approve") {
              // 权限边界：批准必须由人在管理页完成
              return { ok: false, error: "启用/批准需用户在 ⏰调度 管理页操作——请提示用户去批准，而不是调用本工具" };
            }
            if (a === "disable") return await call("/plans/" + encodeURIComponent(args.id) + "/disable", "POST");
            if (a === "remove") return await call("/plans/" + encodeURIComponent(args.id), "DELETE");
            if (a === "run-now") return await call("/plans/" + encodeURIComponent(args.id) + "/run", "POST");
            return { ok: false, error: "未知 action: " + a };
          } catch (e: any) {
            return { ok: false, error: String(e?.message || e) };
          }
        },
      }];
    },
    },
  },
};

// ---- 送达字段白名单（集成方案 §4.2）----
// 只认 cc / mailTo / sendOn 三个键；请求体缺省 → 返回空对象（PUT 合并语义=保持原值）。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeDelivery(b: any): Pick<Plan, "cc" | "mailTo" | "sendOn"> {
  const out: Pick<Plan, "cc" | "mailTo" | "sendOn"> = {};
  if (!b || typeof b !== "object") return out;
  if (b.cc !== undefined) {
    out.cc = b.cc && typeof b.cc === "object"
      && typeof b.cc.project === "string" && b.cc.project.trim()
      && typeof b.cc.sessionKey === "string" && b.cc.sessionKey.trim()
      ? { project: b.cc.project.trim(), sessionKey: b.cc.sessionKey.trim() }
      : null; // 非法形态一律丢弃（=不发）
  }
  if (b.mailTo !== undefined) {
    if (b.mailTo === null) out.mailTo = null;
    else {
      const list = String(b.mailTo).split(/[,，;；\n]/)
        .map((s: string) => s.trim())
        .filter(Boolean)
        .map((piece: string) => {
          const m = piece.match(/<\s*([^<>\s]+)\s*>/); // 容忍 Name <addr> 形态
          return (m ? m[1] : piece).trim();
        })
        .filter((addr: string) => EMAIL_RE.test(addr));
      out.mailTo = list.length ? list.join(",") : null; // 全非法 → 不发
    }
  }
  if (b.sendOn !== undefined) {
    out.sendOn = ["ok", "error", "all"].includes(b.sendOn) ? b.sendOn : "all";
  }
  return out;
}

/**
 * schedule 独立校验（保存校验与失焦即时校验共用同一权威逻辑，防两端漂移）。
 * 支持单值（字符串/对象）与多值（数组/多行）；parseSchedules 只归一形态，
 * 非法 cron（如 "99 99 ..."）要靠 nextRunAt 实算才能暴露。
 * 返回 null=通过，否则返回完整错误描述（含「schedule 」前缀）。
 */
function validateSchedule(raw: unknown): string | null {
  const specs = parseSchedules(raw);
  if (!specs) return "schedule 无法解析：" + JSON.stringify(raw).slice(0, 80) + "（cron 示例 \"0 9 * * *\"；间隔 \"30m\"；一次性 \"+30m\"；多调度用数组/多行）";
  for (const spec of specs) {
    const next = nextRunAt(spec, Date.now());
    if (spec.type === "once") {
      if (next === null) return "schedule once 时间已过期：" + new Date(spec.at).toISOString();
    } else if (next === null || !Number.isFinite(next)) {
      return "schedule 无法解析：" + JSON.stringify(raw).slice(0, 80) + "（无任何可触发的未来时点）";
    }
  }
  return null;
}

function validatePlanInput(b: any): string | null {  if (!b || typeof b !== "object") return "请求体必须是 JSON 对象";
  if (!b.name || !String(b.name).trim()) return "name 必填";
  if (b.schedule === undefined || b.schedule === null || b.schedule === "") return "schedule 必填（cron 表达式 / 间隔 \"30m\" / 一次性 \"+30m\"）；多调度用数组/多行";
  if (!b.prompt || !String(b.prompt).trim()) return "prompt 必填（目标+验收标准的完整提示词）";
  const sErr = validateSchedule(b.schedule);
  if (sErr) return sErr;
  // timezone：IANA 名校验
  const tz = b.timezone || b.tz;
  if (tz) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); }
    catch { return "timezone 非法（需 IANA 名称，如 Asia/Shanghai）：" + String(tz); }
  }
  if (b.dailyCap !== undefined && b.dailyCap !== null && (!(Number(b.dailyCap) >= 1))) return "dailyCap 需为 ≥1 的整数";
  return null;
}
