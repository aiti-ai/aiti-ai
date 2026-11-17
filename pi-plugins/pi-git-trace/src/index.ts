/**
 * aiti-git-trace — pi 扩展入口（WP-B，M0 追踪核心）。
 *
 * 事件接线（pi SDK docs/extensions.md）：
 *   session_start        → 重建 engine（新会话/fork 后状态重置；台账续接 op 编号）
 *   message_end          → user-message boundary ([B2] attribution: the event carries the text directly, race-free)
 *   turn_start           → flush convergence-window reset (attribution duty moved to message_end)
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
    // Kill-switch (§9): config.json written by the pi-web extension at startup
    // (configDir = <dataDir>/aiti-git-trace/config/); missing file/field = on (standalone pi CLI).
    // 2026-11-17: fixed the read path (the config segment was missing, so the switch was never seen).
    let cfg: any = {};
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(traceDataDir(process.env), "config", "config.json"), "utf8"));
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
      // [B2] lazy parse of the user-message entryId: message_end fires before the entry is persisted,
      // so the event carries no id; the engine calls back here at first accounting — scanning the
      // session-file tail for the last user entry with text (by then the message is necessarily
      // persisted; on failure returns null, UI grouping falls back to msgSeq).
      findUserEntryId: (): string | null => {
        try {
          const sf = ctxRef?.sessionManager?.getSessionFile?.();
          if (!sf || !fs.existsSync(sf)) return null;
          const lines = fs.readFileSync(sf, "utf8").trimEnd().split("\n").slice(-200);
          for (let i = lines.length - 1; i >= 0; i--) {
            let en: any;
            try { en = JSON.parse(lines[i]); } catch { continue; }
            const m = en?.message;
            if (m?.role !== "user") continue;
            if (!userMessageText(m)) continue; // same filter as onUserMessage
            return en.id ? String(en.id) : null;
          }
          return null;
        } catch { return null; }
      },
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
      // Actual file lives at the configDir tier (<dataDir>/aiti-plan-first/config/plans.json);
      // 2026-11-17: fixed (the config segment was missing → currentPlanRel was always null)
      const pf = path.join(resolveDataDir(), "aiti-plan-first", "config", "plans.json");
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

  // extract user-message text from the event object (content blocks / plain string, two shapes;
  // same filter as the old scan)
  function userMessageText(m: any): string {
    const blocks = Array.isArray(m?.content) ? m.content : [];
    const texts = blocks.map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? String(b.text || "") : "")).filter(Boolean);
    return (texts.join(" ") || (typeof m?.content === "string" ? m.content : "")).trim();
  }

  // [B2] user-message boundary: the message_end(role=user) event necessarily arrives before every
  // tool_call that message triggers (the host loop emits message events before running the
  // provider), so msgSeq/prompt attribution is race-free.
  // The old turn_start session-file scan is retired: it raced with user-entry persistence (a new
  // message not yet persisted hit lastPromptId and was misjudged as a "later turn of the same
  // message", attributing to the previous round = off-by-one).
  pi.on("message_end", async (event, ctx) => {
    const m = (event as any)?.message;
    if (m?.role !== "user") return;
    // the first-message boundary must not be lost: the session_start engine creation may come later
    // than the first message_end (SDK / first-session path), so ensureEngine here too (idempotent);
    // only give up on this round's attribution if the engine cannot be built.
    ctxRef = ctx ?? ctxRef;
    const e = await ensureEngine();
    if (!e) return;
    const text = userMessageText(m);
    if (!text) return; // user entry without text (anomalous/injected shapes): not a new round
    e.onUserMessage(text.slice(0, 200));
  });

  pi.on("turn_start", async (_event, ctx) => {
    refreshPlanRel(); // [P1-2 尾巴] 轮间绑定变更感知
    const e = await ensureEngine();
    await e?.scanNestedRuntime(); // 运行期嵌套仓预扫（审核发现③：原无参调用为死代码，已修）
    e?.onTurnStart(); // [B2] flush-window reset only; attribution already driven by message_end
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
