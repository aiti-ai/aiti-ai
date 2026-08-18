import { NextResponse } from "next/server";
import { SessionManager, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(filePath!);
    // 不走 buildSessionContext/buildContextEntries（会过滤掉压缩前的原始消息）
    // 直接走全路径，所有消息原样返回
    const fullPath = buildFullPath(sm.getEntries() as unknown as SessionEntry[], leafId);
    const { thinkingLevel, model } = getSessionContextSettings(fullPath);
    const messages = fullPath.flatMap(sessionEntryToContextMessages);
    const context = { messages, thinkingLevel, model, entryIds: fullPath.map(e => e.id) };

    return NextResponse.json({ context });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// 从 leaf 到 root 走全路径（不丢弃压缩前的消息）
function buildFullPath(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  let leaf: SessionEntry | undefined;
  if (leafId) leaf = byId.get(leafId);
  leaf ??= entries[entries.length - 1];
  if (!leaf) return [];

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();
  return path;
}

function getSessionContextSettings(path: SessionEntry[]): { thinkingLevel: string; model: { provider: string; modelId: string } | null } {
  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = (entry as any).thinkingLevel;
    } else if (entry.type === "model_change") {
      model = { provider: (entry as any).provider, modelId: (entry as any).modelId };
    } else if (entry.type === "message" && (entry as any).message?.role === "assistant") {
      model = { provider: (entry as any).message.provider, modelId: (entry as any).message.model };
    }
  }
  return { thinkingLevel, model };
}
