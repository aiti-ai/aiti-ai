import { NextResponse } from "next/server";
import { getSessionMeta, attachSessionProjectInfo } from "@/lib/session-reader";
import { getRpcSessionInfos } from "@/lib/rpc-manager";
import { getHandleSessionInfos, warmHandleFirstMessages } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * P0-A lightweight single-item metadata endpoint (web-sessions payload plan §3 P0-A):
 * returns a single SessionInfo (assembled from the same source as the list,
 * including projectKey/relation), without messages/context/tree — replaces
 * AppShell's `?refresh=1` full re-fetch (previously ~1.49MB each time).
 *
 * Covers: local-disk pi sessions (near-zero disk cost on incremental-scan cache hit).
 * Does not cover: bridge/RPC/composite-id sessions → 404; the consumer (AppShell)
 * falls back to the original full fetch on 404, so progressive migration loses
 * no functionality.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    let info = await getSessionMeta(id);
    if (!info) {
      // In-memory form fallback (assembled from the same source as the /api/sessions list, zero disk):
      // bridge/RPC sessions and attach/spawn/extension-handle sessions are all outside the disk scan —
      // these used to always 404, forcing consumers (AppShell ?session= restore / open-session) to fall
      // back to a full refresh=1 re-fetch (one 404 on first load = ~257KB full payload + forced server
      // rescan; a high-frequency waste source).
      // Warm firstMessage first: the real first user message, same source as the list.
      await warmHandleFirstMessages();
      const rows = await attachSessionProjectInfo([...getRpcSessionInfos(), ...getHandleSessionInfos()]);
      info = rows.find((s) => s.id === id) ?? null;
    }
    if (!info) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json(
      { session: info },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
