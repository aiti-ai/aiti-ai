import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, setRpcSessionTools } from "@/lib/rpc-manager";
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
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;

    const filePath = await resolveSessionPath(id);

    // ── 桥占用识别（单写者红线，最先执行）─────────────────────────────
    // 被 TUI 桥持有的会话永远走 socket——即使存在陈旧的本地 wrapper
    // （TUI 是文件所有者）。附着失败 = 单写者冲突 → 409。
    if (filePath) {
      let bridged;
      try {
        bridged = await attachIfBridged(filePath);
      } catch (e) {
        if ((e as { name?: string }).name === "BridgeOccupiedError") {
          return NextResponse.json({
            error: e instanceof Error ? e.message : String(e),
            code: "bridge_occupied",
            ...(commandType === "prompt" ? { accepted: false } : {}),
          }, { status: 409 });
        }
        throw e;
      }
      if (bridged?.isAlive()) {
        const result = await bridged.send(body);
        promptAccepted = body.type === "prompt";
        return NextResponse.json({ success: true, data: result });
      }
    }

    // Fast path: already-running session (local registry, then provider handles)
    const existing = getRpcSession(id)?.isAlive() ? getRpcSession(id) : resolveAnySession(id);

    // 上游 v0.8.10：set_tools 工具集热更新（会话未运行时按文件路径重建）。
    // 桥持有的会话已在上面走 socket 转发，到这里的一定是本地管辖的会话。
    if (body.type === "set_tools") {
      const targetPath = (existing as { sessionFile?: string } | null | undefined)?.sessionFile || filePath || undefined;
      if (!existing?.isAlive() && !targetPath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const changed = await setRpcSessionTools(id, targetPath, toolNames);
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: result });
    }

    // 本地路径：文件不存在且无 live 会话 → 404；存在则起本地 runtime
    // （startRpcSession 内部仍有 ownsFile 总闸兜底——防其他路由先建了 wrapper）
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    // 单写者红线：占用拒绝是语义性冲突，不是服务器故障
    if ((error as { name?: string }).name === "BridgeOccupiedError") {
      return NextResponse.json({
        error: error instanceof Error ? error.message : String(error),
        code: "bridge_occupied",
        ...(commandType === "prompt" && !promptAccepted ? { accepted: false } : {}),
      }, { status: 409 });
    }
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
