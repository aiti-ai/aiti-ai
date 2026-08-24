import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { resolveAnySession, attachIfBridged } from "@/lib/session";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // 桥占用识别最先：被 TUI 桥持有的会话永远走 socket（即使存在陈旧的
    // 本地 wrapper——单写者规则下 TUI 是文件的所有者）
    {
      const fp = await resolveSessionPath(id);
      if (fp) {
        const bridged = await attachIfBridged(fp);
        if (bridged?.isAlive()) {
          const result = await bridged.send(body);
          promptAccepted = body.type === "prompt";
          return NextResponse.json({ success: true, data: result });
        }
      }
    }

    // Fast path: already-running session (local registry, then provider handles)
    const existing = getRpcSession(id)?.isAlive() ? getRpcSession(id) : resolveAnySession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    // 桥占用识别：该会话文件被运行中的 TUI 持有时，附着到桥而不是本地打开
    //（单写者规则——否则两个运行时同时 append 同一 .jsonl）
    if (filePath) {
      let bridged;
      try {
        bridged = await attachIfBridged(filePath);
      } catch (e) {
        if ((e as { name?: string }).name === "BridgeOccupiedError") {
          return NextResponse.json({ error: String(e), code: "session_bridged_unreachable" }, { status: 409 });
        }
        throw e;
      }
      if (bridged?.isAlive()) {
        const result = await bridged.send(body);
        promptAccepted = body.type === "prompt";
        return NextResponse.json({ success: true, data: result });
      }
    }
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined);
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id)?.isAlive() ? getRpcSession(id) : resolveAnySession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
