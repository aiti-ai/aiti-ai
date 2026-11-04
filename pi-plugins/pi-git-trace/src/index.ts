/**
 * aiti-git-trace — pi 扩展入口（WP-B，M0 追踪核心）。
 *
 * 事件接线（pi SDK docs/extensions.md）：
 *   session_start        → 重建 engine（新会话/fork 后状态重置；台账续接 op 编号）
 *   turn_start           → msgSeq 归属计数
 *   tool_call            → mutating 判定 + before commit（可 block 语义未用，只观测）
 *   tool_execution_end   → after commit + 台账行
 *   turn_end             → 无条件兜底 flush（§3.5）
 *   session_shutdown     → 丢弃内存态（台账/追踪仓为权威）
 */
import { TraceEngine } from "./engine.ts";
import { resolveDataDir, traceDataDir } from "./paths.ts";
import fs from "node:fs";
import path from "node:path";
/* WP-A 接入：recognition.ts 的 ensureWired() 动态 import ../lib/*（同包已交付，自动生效） */

interface MinimalSessionManager {
  getSessionId?(): string;
  getSessionFile?(): string | undefined;
  getLeafEntry?(): { id?: string } | undefined;
}

interface MinimalCtx {
  cwd?: string;
  sessionManager?: MinimalSessionManager;
}

interface MinimalPi {
  on(event: string, handler: (event: any, ctx: MinimalCtx) => Promise<any> | any): void;
}

export default function piGitTrace(pi: MinimalPi): void {
  let engine: TraceEngine | null = null;
  let ctxRef: MinimalCtx | null = null;
  let bound = false;

  const sessionIdOf = (ctx: MinimalCtx | null): string | null => {
    const sm = ctx?.sessionManager;
    const viaApi = sm?.getSessionId?.();
    if (viaApi) return String(viaApi);
    const file = sm?.getSessionFile?.();
    if (file) return file.replace(/\.jsonl$/, "").split(/[\\/]/).pop() || null;
    return null;
  };

  /** [P0-2] 解析父会话 id（fork 场景，GAP-2）：会话文件首行 header.parentSession 记录父会话
   *  （路径或 id 形态）→ 归一为父会话 id 传入引擎 parentSessionId——/lineage 家谱与时间线
   *  树视图的数据源（此前恒 null）。非 fork/解析失败 → null（零影响）。 */
  function resolveParentSessionId(): string | null {
    try {
      const sf = ctxRef?.sessionManager?.getSessionFile?.();
      if (!sf || !fs.existsSync(sf)) return null;
      const fd = fs.openSync(sf, "r");
      const buf = Buffer.alloc(2048);
      const n = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      const header = JSON.parse(buf.toString("utf8", 0, n).split("\n")[0]);
      const parent = header?.parentSession;
      if (typeof parent !== "string" || !parent) return null;
      if (parent.endsWith(".jsonl")) {
        const base = path.basename(parent, ".jsonl");
        return (base.includes("_") ? base.split("_").pop() : base) || null;
      }
      return parent;
    } catch { return null; }
  }

  const ensureEngine = async (): Promise<TraceEngine | null> => {
    if (engine) return engine;
    const sid = sessionIdOf(ctxRef);
    if (!sid || !ctxRef?.cwd) return null;
    if (!bound) {
      await (await import("./recognition.ts")).ensureWired();
    }
    // 总开关（§9）：pi-web 扩展 startup 写出的 config.json；缺文件/缺字段 = 开（独立 pi CLI 场景）
    let cfg: any = {};
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(traceDataDir(process.env), "config.json"), "utf8"));
      if (cfg.enabled === false) return null; // kill-switch：本会话不追踪
      bound = true;
    } catch { /* 缺文件/解析失败 = 默认开（独立 pi CLI 场景） */ }
    const e = new TraceEngine({
      cwd: ctxRef.cwd,
      sessionId: sid,
      parentSessionId: resolveParentSessionId(), // [P0-2] fork 家谱接线（GAP-2）
      getModel: () => currentModel, // [P1-2] additive model 字段
      getPlanRel: () => currentPlanRel, // [P1-2 尾巴] additive 方案绑定
      dataDir: resolveDataDir(),  // 根目录（引擎内 ledgerFileFor 再拼 aiti-git-trace/state/ops，§3.6）
      getEntryId: () => ctxRef?.sessionManager?.getLeafEntry?.()?.id ?? null,
      autoInit: cfg.autoInit !== false,
      autoInitMaxFiles: Number(cfg.autoInitMaxFiles) || 2000,
      seedCommonIgnores: cfg.seedCommonIgnores === true,
      // [P2-3] 接通 config.json 的 5 个此前死开关
      excludeExtra: cfg.excludeExtra,
      includeExtra: cfg.includeExtra,
      builtinExcludes: cfg.builtinExcludes,
      maxFileKB: cfg.maxFileKB,
      scope: cfg.scope,
    });
    await e.init();
    // 事件出口（docs/aiti-plan-first-plan.md §3.2）：台账行落地后进程内广播，
    // pi-web 侧 aiti-git-trace 经 globalThis 桥接 sink/traceBus（两侧任一缺席零影响）
    e.onLedgerRow = (row) => (globalThis as any).__aitiTraceEmit?.({ kind: "op", sessionId: sid, row });
    engine = e;
    return e;
  };

  // [P1-2] 当前模型追踪：model_select 事件驱动 + 会话条目初始解析（最近一笔 model_change）
  let currentModel: { provider: string; modelId: string } | null = null;
  // [P1-2 尾巴] 方案绑定（planRel）：session_start/turn_start 时从 plans.json 反查（实时读盘，无轮询）
  let currentPlanRel: string | null = null;
  function refreshPlanRel(): void {
    try {
      const pf = path.join(resolveDataDir(), "aiti-plan-first", "plans.json");
      if (!fs.existsSync(pf)) { currentPlanRel = null; return; }
      const plans = JSON.parse(fs.readFileSync(pf, "utf8"));
      const sid = ctxRef?.sessionManager?.getSessionId?.();
      const st = sid && plans?.sessions?.[sid];
      currentPlanRel = st?.planRel ?? st?.plan ?? null;
    } catch { currentPlanRel = null; }
  }
  function resolveCurrentModel(): { provider: string; modelId: string } | null {
    try {
      const entries: any[] = (ctxRef?.sessionManager?.getEntries?.() ?? []) as any[];
      for (let i = entries.length - 1; i >= 0; i--) {
        const en = entries[i];
        if (en?.type === "model_change" && (en.modelId || en.provider)) {
          return { provider: String(en.provider ?? ""), modelId: String(en.modelId ?? "") };
        }
      }
    } catch { /* noop */ }
    return currentModel;
  }
  pi.on("model_select", (event: any) => {
    const m = event?.model;
    if (m) currentModel = { provider: String(m.provider ?? ""), modelId: String(m.id ?? m.modelId ?? "") };
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx ?? ctxRef;
    engine = null; // fork/new/resume 后重建；op 编号由台账续接
    lastPromptId = null; // 新会话重新捕获用户消息
    currentModel = resolveCurrentModel() ?? currentModel; // [P1-2] 初始模型（最近 model_change 条目）
    refreshPlanRel(); // [P1-2 尾巴] 方案绑定刷新
    await ensureEngine();
  });

  // [P1-1a 记账合一·完整档] plan 采认记账入口（docs/aiti-plan-sandbox-stale-resume-trace-fusion-plan.md §2.3）：
  //   begin = 采认执行前打 before 边界（返回 recordId；无 store/失败 → null 调用方降级）
  //   end   = 采认后 after 边界 + 成对 tag 锚点 + 台账单一 op（kind=plan-accept 带 stores[] / plan-rollback）
  //   note  = 丢弃纯台账行（kind=plan-discard）
  // 旧 __aitiTraceAppendPlanRecord 已删除（未上线无兼容包袱；调用方 plan-sandbox 的
  // resume.ts/index.ts 同步改写，本扩展缺席时调用方判空降级，绝不阻断采认）。
  (globalThis as any).__aitiTracePlanRecord = {
    async begin(meta: { projectDir?: string; sandboxDir?: string; summary?: string; files?: string[]; deletions?: string[] }): Promise<string | null> {
      try {
        const e = await ensureEngine();
        return e ? await e.planRecordBegin(String(meta?.summary || "plan 采认")) : null;
      } catch {
        return null;
      }
    },
    async end(recordId: string | null, info: { outcome: "accepted" | "rolledback"; projectDir?: string; sandboxDir?: string; summary?: string; files?: string[]; deletions?: string[]; conflicts?: string[]; mission?: string | null }): Promise<void> {
      try {
        const e = await ensureEngine();
        await e?.planRecordEnd(recordId, info ?? {});
      } catch { /* 记账失败不影响采认主流程 */ }
    },
    async note(info: { outcome?: "discarded"; projectDir?: string; sandboxDir?: string; summary?: string }): Promise<void> {
      try {
        const e = await ensureEngine();
        await e?.planRecordNote(info ?? {});
      } catch { /* 记账失败不影响采认主流程 */ }
    },
  };

  // 最近一次已捕获的用户消息 entry id（turn 2+ 用来识别「同一用户消息」；session_start 重置）
  let lastPromptId: string | null = null;

  pi.on("turn_start", async (_event, ctx) => {
    refreshPlanRel(); // [P1-2 尾巴] 轮间绑定变更感知
    const e = await ensureEngine();
    await e?.scanNestedRuntime(); // 运行期嵌套仓预扫（审核发现③：原无参调用为死代码，已修）
    // 捕获用户消息：扫会话文件尾（leaf 时序不可靠——turn 2+ 时 leaf 是上一条 assistant 消息）。
    // user 是独立 role（toolResult 不会误报）；命中 lastPromptId 即同一条消息的后续 turn → 不推进 msgSeq。
    let prompt: { userEntryId: string; text: string } | null = null;
    try {
      const sf = ctx?.sessionManager?.getSessionFile?.();
      if (sf && fs.existsSync(sf)) {
        const lines = fs.readFileSync(sf, "utf8").trimEnd().split("\n").slice(-200);
        for (let i = lines.length - 1; i >= 0; i--) {
          let en: any;
          try { en = JSON.parse(lines[i]); } catch { continue; }
          const m = en?.message;
          if (m?.role !== "user") continue;
          if (en.id && en.id === lastPromptId) break; // 同一用户消息已消费
          const blocks = Array.isArray(m.content) ? m.content : [];
          const texts = blocks.map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? String(b.text || "") : "")).filter(Boolean);
          const text = (texts.join(" ") || (typeof m.content === "string" ? m.content : "")).slice(0, 200);
          if (!text.trim()) continue; // 无文本的 user 条目（异常/注入形态）：跳过，继续向前找
          lastPromptId = en.id ? String(en.id) : lastPromptId;
          prompt = { userEntryId: String(en.id || ""), text };
          break;
        }
      }
    } catch { /* 读取失败不阻塞（prompt 缺失仅影响分组头显示） */ }
    e?.onTurnStart(prompt);
  });

  pi.on("tool_call", async (event, ctx) => {
    ctxRef = ctx ?? ctxRef;
    const e = await ensureEngine();
    if (!e) return;
    await e.onToolCall(String(event.toolCallId), String(event.toolName), event.input);
    // 只观测不阻断（2026-08-30 定调：只记录永不拦截；外溢走 leaks 记账）
  });

  pi.on("tool_execution_end", async (event) => {
    const e = engine;
    if (!e) return;
    await e.onToolExecutionEnd(String(event.toolCallId), Boolean(event.isError));
  });

  pi.on("turn_end", async () => {
    const e = engine;
    if (!e) return;
    await e.onTurnEnd();
  });

  pi.on("session_shutdown", async () => {
    engine = null;
    ctxRef = null;
  });
}
