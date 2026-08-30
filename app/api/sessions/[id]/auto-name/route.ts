import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { attachIfBridged } from "@/lib/session";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // 桥占用识别最先（同 agent/[id] POST）：被 TUI 桥认领的会话不在本地起 runtime
    // 跑命名 turn（会双写文件）；attachIfBridged 附带竞态窗口善后（杀双胞胎）。
    try {
      const bridged = await attachIfBridged(filePath);
      if (bridged?.isAlive()) {
        return NextResponse.json({ error: "session bridged; auto-name skipped" }, { status: 409 });
      }
    } catch (e) {
      if ((e as { name?: string }).name === "BridgeOccupiedError") {
        return NextResponse.json({ error: "session bridged; auto-name skipped" }, { status: 409 });
      }
      throw e;
    }

    const existing = getRpcSession(id);
    let session: NonNullable<typeof existing>;
    if (existing?.isAlive()) {
      session = existing;
    } else {
      try {
        ({ session } = await startRpcSession(id, filePath, undefined));
      } catch (e) {
        // 桥占用的会话无法本地起 runtime——自动命名降级跳过（TUI 端可自行命名）
        if ((e as { name?: string }).name === "BridgeOccupiedError") {
          return NextResponse.json({ error: "session bridged; auto-name skipped" }, { status: 409 });
        }
        throw e;
      }
    }

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
