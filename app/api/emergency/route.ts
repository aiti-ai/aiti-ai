import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { randomUUID } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST /api/emergency { message, cwd, sessionId? }
// 最简急救 AI（crash-rescue §5.2 落地）：创建/复用 agent 会话——普通会话（非
// noExtensions），collectAgentTools 逐扩展 try/catch 容错（broken 扩展跳过）→
// aiti-configs 工具照常注入（满足"急救ai允许aiti-configs的tools"）。发 prompt，
// 订阅 agent_settled → wrapper.inner.getLastAssistantText() 原样返回全文。
// 不依赖 chat UI / SSE 事件解析 / 文本格式化——一个 POST 一轮，原样输出。
// 多轮：首响返回 sessionId，后续请求带 sessionId 复用同一会话。
export async function POST(req: Request) {
  let body: { message?: unknown; cwd?: unknown; sessionId?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message : "";
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const prevId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!message) return Response.json({ error: "message required" }, { status: 400 });

  // 复用或新建会话
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
      if (!cwd) return Response.json({ error: "cwd required for new session" }, { status: 400 });
      // 启用 aiti-configs 的 agentTools（默认关；aiti-configs agentTools() 检 feature flag）
      // → collectAgentTools 注入 aiti_configs_* 工具（满足“急救ai允许aiti-configs的tools”）。
      // 时序安全：startRpcSession 内 collectAgentTools 同步跑完后才返回，故还原不影响本会话已注入的工具。
      const ext = (globalThis as Record<string, unknown> & { __piWebExt?: { setFeatureFlag?: (id: string, f: string, v: boolean) => void; featureEnabled?: (id: string, f: string) => boolean } }).__piWebExt;
      const prevCfg = ext?.featureEnabled?.("aiti-configs", "agentTools.enabled") ?? false;
      if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", true);
      try {
        const r = await startRpcSession(`__emg__${randomUUID()}`, "", cwd, {});
        session = r.session;
        realId = r.realSessionId;
      } finally {
        if (ext?.setFeatureFlag) ext.setFeatureFlag("aiti-configs", "agentTools.enabled", prevCfg);
      }
    }
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }

  // 订阅 agent_settled → 取最终 assistant 文本（subagent.ts:189 同款模式）
  let resolveSettled!: (t: string) => void;
  let rejectSettled!: (e: Error) => void;
  const settled = new Promise<string>((res, rej) => { resolveSettled = res; rejectSettled = rej; });
  let sent = false;
  const off: (() => void) | undefined = session.onEvent?.((ev: { type?: string }) => {
    // 只认 send 之后的首次 agent_settled（含重试/压缩后的一轮结束）
    if (sent && ev.type === "agent_settled") {
      try {
        const text = session.inner?.getLastAssistantText?.() ?? "";
        resolveSettled(typeof text === "string" ? text : "");
      } catch (e) {
        rejectSettled(e instanceof Error ? e : new Error(String(e)));
      }
    }
  });

  try {
    sent = true;
    // send 不阻塞到完成（ack 即返）；agent_settled 到达时 settled resolve
    await session.send({ type: "prompt", message });
  } catch (e) {
    try { off?.(); } catch { /* ignore */ }
    return Response.json({ error: e instanceof Error ? e.message : String(e), sessionId: realId }, { status: 500 });
  }

  // 等 agent_settled，兜底超时 240s（急救 AI 可能跑 bash/aiti_configs 工具）
  let to: ReturnType<typeof setTimeout> | undefined;
  const text = await Promise.race<string>([
    settled,
    new Promise<string>((_, rej) => {
      to = setTimeout(() => rej(new Error("急救 AI 超时（240s 未 settle）")), 240000);
    }),
  ]).catch((e: unknown) => `[急救错误] ${e instanceof Error ? e.message : String(e)}`);
  if (to) clearTimeout(to);
  try { off?.(); } catch { /* ignore */ }

  return Response.json({ sessionId: realId ?? null, text: text || "(无输出)" });
}
