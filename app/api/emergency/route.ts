import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { randomUUID } from "crypto";

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
  let body: { message?: unknown; cwd?: unknown; sessionId?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message : "";
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const prevId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  // biome-ignore lint/suspicious/noExplicitAny: wrapper 类型跨文件，按结构用
  let session: any = null;
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
      const useCwd = cwd || process.env.HOME || "/";
      // 启用 aiti-configs 的 agentTools（默认关）→ collectAgentTools 注入 aiti_configs_* 工具。
      // 时序安全：startRpcSession 内 collectAgentTools 同步跑完才返回，还原不影响本会话已注入工具。
      const ext = (globalThis as Record<string, unknown> & { __piWebExt?: { setFeatureFlag?: (id: string, f: string, v: boolean) => void; featureEnabled?: (id: string, f: string) => boolean } }).__piWebExt;
      const prevCfg = ext?.featureEnabled?.("aiti-configs", "agentTools.enabled") ?? false;
      if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", true);
      try {
        const r = await startRpcSession(`__emg__${randomUUID()}`, "", useCwd, {});
        session = r.session;
        realId = r.realSessionId;
      } finally {
        if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", prevCfg);
      }
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

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

      const off = session.onEvent?.((ev: { type?: string; assistantMessageEvent?: { partial?: { content?: unknown[] } } }) => {
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
              const fin = (session.inner?.getLastAssistantText?.() ?? "") as string;
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

      // 无活动兑底：30s 无任何事件则关流（防 agent_settled 不发/模型挂起 → 240s 空等）
      const actTimer = setInterval(() => {
        if (closed) return;
        if (Date.now() - lastEventAt > 30000) {
          enqueue("\n[急救] 30s 无活动，流关闭");
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

      session.send({ type: "prompt", message }).catch((e: unknown) => {
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
