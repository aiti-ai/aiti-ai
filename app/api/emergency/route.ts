import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { randomUUID } from "crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// 兑底临时工作目录：无 cwd 时新建 ~/aiti-<YYYYMMDD>（隔离、不直接动家目录，到天一天一个），
// 让急救 AI 有一个干净起步点（能用绝对路径访问 pi-web / ~/.pi/web 等真实目录）。
async function createTempCwd(): Promise<string> {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  const dir = path.join(os.homedir(), "aiti-" + ts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/emergency { message, cwd, sessionId? }
// 最简急救 AI（crash-rescue §5.2 落地）——流式：订阅 session.onEvent（原始事件，
// 带 partial），把 AI 输出原样持续推流（assistant 文本增量 + 工具调用标记），
// 直到 agent_settled。客户端 fetch+reader 持续追加、全显示，不等完成。不走 chat
// UI / SSE 事件解析 / 文本格式化。多轮：首响 x-session-id 复用同一会话。
//
// 会话：普通会话（非 noExtensions），collectAgentTools 逐扩展 try/catch 容错；
// 建新会话前临时启用 aiti-configs 的 agentTools.enabled（默认关）→ 注入 aiti_configs_*
// 工具，满足"急救ai允许aiti-configs的tools"。
export async function POST(req: Request) {
  let body: { message?: unknown; cwd?: unknown; sessionId?: unknown; model?: unknown; errors?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message : "";
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const prevId = typeof body.sessionId === "string" ? body.sessionId : "";
  // 前端收集到的错误（指示器注册表 / global-error 页错误），建新会话时拼进 AI 消息——
  // 急救 AI 若不知道哪坏了就无从救。
  const errors = Array.isArray(body.errors)
    ? body.errors
        .filter((e): e is { message?: unknown; stack?: unknown; extId?: unknown; slot?: unknown; itemId?: unknown } => !!e && typeof e === "object")
        .map((e) => ({ message: String(e.message ?? ""), stack: String(e.stack ?? ""), extId: String(e.extId ?? ""), slot: String(e.slot ?? ""), itemId: String(e.itemId ?? "") }))
    : [];
  // 可选 model 切换（默认 model 限流/不可用时换一个）：{ provider, modelId }
  const model =
    body.model && typeof body.model === "object"
      ? {
          provider: typeof (body.model as { provider?: unknown }).provider === "string" ? (body.model as { provider: string }).provider : "",
          modelId: typeof (body.model as { modelId?: unknown }).modelId === "string" ? (body.model as { modelId: string }).modelId : "",
        }
      : null;
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  // wrapper 类型跨文件，按结构用（send 恒在；onEvent/inner 可选）——eslint 化后不用 any。
  // send 返回 Promise<unknown>（wrapper 泛型擦除），调用方只挂 catch 不消费值。
  let session: {
    send: (cmd: { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }) => Promise<unknown>;
    onEvent?: (handler: (ev: { type?: string; assistantMessageEvent?: { partial?: { content?: unknown[] } } }) => void) => () => void;
    inner?: { getLastAssistantText?: () => string | undefined };
  } | null = null;
  let realId: string | undefined = prevId || undefined;
  try {
    if (prevId) {
      const ex = getRpcSession(prevId);
      if (ex?.isAlive()) {
        session = ex;
      } else {
        const fp = await resolveSessionPath(prevId);
        if (fp) ({ session } = await startRpcSession(prevId, fp, undefined));
      }
    }
    if (!session) {
      // 无 cwd 时服务端兑底家目录——锥伤的意义就是正常流程用不了时（无会话/页面崩），
      // 不能因缺 cwd 拒绝。aiti_configs_* 工具走绝对路径，bash 也能用绝对路径。
      const useCwd = cwd || (await createTempCwd());
      // 启用 aiti-configs 的 agentTools（默认关）→ collectAgentTools 注入 aiti_configs_* 工具。
      // 时序安全：startRpcSession 内 collectAgentTools 同步跑完才返回，还原不影响本会话已注入工具。
      const ext = (globalThis as Record<string, unknown> & { __piWebExt?: { setFeatureFlag?: (id: string, f: string, v: boolean) => void; featureEnabled?: (id: string, f: string) => boolean } }).__piWebExt;
      const prevCfg = ext?.featureEnabled?.("aiti-configs", "agentTools.enabled") ?? false;
      if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", true);
      try {
        const r = await startRpcSession(`__emg__${randomUUID()}`, "", useCwd, model ? { initialModel: model } : {});
        session = r.session;
        realId = r.realSessionId;
      } finally {
        if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", prevCfg);
      }
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  if (!session) return Response.json({ error: "session unavailable" }, { status: 503 });
  const s = session; // const 收窄：start(controller)/onEvent 闭包内可直达（let 跨闭包不保留窄化）

  const encoder = new TextEncoder();
  let closed = false;
  let lastText = "";
  const emittedTools = new Set<string>();
  const flushTimers: ReturnType<typeof setTimeout>[] = [];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (s: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(s)); } catch { /* stream closed */ }
      };
      let lastEventAt = Date.now();

      const off = s.onEvent?.((ev: { type?: string; assistantMessageEvent?: { partial?: { content?: unknown[] } } }) => {
        const t = ev.type;
        lastEventAt = Date.now();
        // assistant 文本增量（原始 partial.content 带 text 块）
        if (t === "message_update" && ev.assistantMessageEvent?.partial?.content && Array.isArray(ev.assistantMessageEvent.partial.content)) {
          const content = ev.assistantMessageEvent.partial.content as Array<{ type?: string; text?: string; name?: string; toolName?: string; id?: string; toolCallId?: string }>;
          // 文本增量
          const full = content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
          if (full.length > lastText.length) {
            enqueue(full.slice(lastText.length));
            lastText = full;
          }
          // 工具调用标记（新 toolCall 块）
          for (const b of content) {
            if (b && b.type === "toolCall") {
              const id = b.id || b.toolCallId || b.name || b.toolName || "";
              const name = b.name || b.toolName || "?";
              if (id && !emittedTools.has(id)) {
                emittedTools.add(id);
                enqueue(`\n→ 调用工具: ${name}\n`);
              }
            }
          }
        } else if (t === "agent_settled") {
          // 一轮结束：若 partial 未吐文本（部分模型在 settled 才出全文），兑底取
          // getLastAssistantText() 原样补发；短延后关流（冲刷末尾事件）。
          if (!lastText) {
            try {
              const fin = (s.inner?.getLastAssistantText?.() ?? "") as string;
              if (fin) { enqueue(fin); lastText = fin; }
            } catch { /* ignore */ }
          }
          if (!lastText) enqueue("\n[急救] AI 未返回文本（模型可能限流/出错，重试或换模型）");
          const tm = setTimeout(() => {
            if (closed) return;
            closed = true;
            try { off?.(); } catch { /* ignore */ }
            try { controller.close(); } catch { /* stream closed */ }
          }, 400);
          flushTimers.push(tm);
        }
      });

      // 兜底超时 240s（急救 AI 可能跑很久）
      const timeout = setTimeout(() => {
        if (closed) return;
        enqueue("\n[急救] 超时 240s，流已关闭");
        closed = true;
        try { off?.(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* stream closed */ }
      }, 240000);
      flushTimers.push(timeout);

      // 无活动兑底：150s 无任何事件才关流（AI 用 bash 等工具排查可能 30-60s+ 无新事件，
      // 30s 太激进会误杀；150s 只在真挂起触发，240s 兑底超时仍是硬顶）
      const actTimer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastEventAt > 150000) {
          enqueue("\n[急救] 150s 无活动，流关闭");
          closed = true;
          try { off?.(); } catch { /* ignore */ }
          try { controller.close(); } catch { /* stream closed */ }
        }
      }, 5000);
      flushTimers.push(actTimer as unknown as ReturnType<typeof setTimeout>);

      // 客户端断开
      req.signal.addEventListener("abort", () => {
        if (closed) return;
        closed = true;
        try { off?.(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* stream closed */ }
      });

      // 建新会话（无 sessionId）时把前端收集的错误 + 后端可用上下文拼进 AI 消息，
      // 让急救 AI 知道问题在哪；复用会话则历史已含，不再重复拼。
      let aiMessage = message;
      if (!prevId) {
        const ctx: string[] = [];
        // 急救操作规范：改动前先备份、确保可恢复、避免丢数据（提示词优化）
        ctx.push(
          "【急救操作规范——改任何东西之前必须遵守】",
          "1. 动手改任何文件/配置/数据前，先做可回滚备份，且文件名/标识要唯一、带时间戳：文件改动前 cp 到 `<文件名>.<YYYYMMDD-HHMMSS>.bak`（含年月日时分秒，如 20260831-143052，避免和历史 .bak 混淆/覆盖）；或 git stash 到带时间戳的命名 stash（名含 YYYYMMDD-HHMMSS）。配置/状态改动前先快照（如 aiti_configs_status / git status）并记录时间点。",
          "2. 任何修改都要给出一条明确、可事后执行的恢复路径（明确的恢复命令或步骤），并在回复里告诉用户怎么恢复。",
          "3. 避免恢复导致丢数据：不删除没有备份的内容；先备份再覆盖；改已提交文件前确认无未提交的他人改动；不确定影响范围就先只读排查再动手。",
          "4. 若问题复杂、不确定怎么修，先只读（读文件/看状态/跑只读命令）摸清现场，给出方案让用户确认后再改。",
          ""
        );
        if (errors.length) {
          ctx.push("【前端收集到的错误】（共 " + errors.length + " 条）");
          errors.forEach((e, i) => {
            ctx.push(`${i + 1}. [${e.extId || "?"}] ${e.slot || ""}${e.itemId ? "/" + e.itemId : ""} ${e.message}`);
            if (e.stack) ctx.push("  堆栈: " + e.stack);
          });
          ctx.push("");
        }
        aiMessage = (ctx.length ? ctx.join("\n") + "\n\n" : "") + message;
      }
      // 复用会话时，agent 可能仍在流式处理上一条消息——不带 streamingBehavior 会抛
      // "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
      // 导致重试永远卡死。传 steer：正在流式则打断/接管（queued steering），未流式则正常运行；
      // 这样首条 network error 后重试也能立即接管，而不是报错冻结。
      s.send({ type: "prompt", message: aiMessage, streamingBehavior: "steer" }).catch((e: unknown) => {
        enqueue(`\n[发送错误] ${e instanceof Error ? e.message : String(e)}`);
        if (!closed) { closed = true; try { off?.(); } catch { /* ignore */ } try { controller.close(); } catch { /* stream closed */ } }
      });
    },
    cancel() {
      closed = true;
      for (const tm of flushTimers) clearTimeout(tm);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-session-id": realId || "",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
