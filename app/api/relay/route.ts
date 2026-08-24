import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { relayToSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/relay — agent-to-agent 消息中继（cc-connect relay send 对齐）。
 *
 * body: { to: string; message: string; timeoutMs?: number }
 *   → 把 message 投递给目标 live 会话（任意后端），等其回合结束并返回回复文本。
 *
 * 响应：{ ok: true, to, reply } | { ok: false, error }
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = await req.json() as { to?: string; message?: string; timeoutMs?: number };
    if (!body.to || typeof body.message !== "string") {
      return NextResponse.json({ error: "to and message are required" }, { status: 400 });
    }
    const result = await relayToSession(body.to, body.message, {
      ...(typeof body.timeoutMs === "number" ? { timeoutMs: body.timeoutMs } : {}),
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
