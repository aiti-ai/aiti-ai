import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
  invalidateSessionListCache,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getHandleSessionInfos, getRunningHandleIds, getHandle, warmHandleFirstMessages } from "@/lib/session";
import { getBridgeRunningIds } from "@/lib/session/bridge-running";
import { getRegistry } from "@/lib/ext/registry";
import { stampExternalSessions } from "@/lib/session/placeholder";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    // Extension-triggered mutations (e.g. session-manager archive) change the
    // on-disk list out from under the 5s TTL cache — let callers force a
    // fresh scan instead of waiting for the cache to expire.
    if (new URL(req.url).searchParams.get("refresh") === "1") {
      invalidateSessionListCache();
    }
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    // Live backend sessions (attach/spawn/extension handles) — transient rows
    // so the sidebar lists them and ?session=<composite-id> restore works.
    // Warm the firstMessage cache first (backends without placeholder files, e.g. omp):
    // the first load already carries the real first user message, matching the semantics
    // of pi sessions on disk (the sidebar shows firstMessage when there is no name).
    await warmHandleFirstMessages();
    const backendRows = await attachSessionProjectInfo(getHandleSessionInfos());

    const pathKeyedHandles = backendRows.filter((r) => !r.id.startsWith("/"));
    const sessions = mergeSessionLists(
      mergeSessionLists(persistedSessions as never[], runtimeSessions),
      pathKeyedHandles,
    );
    // Placeholder-row annotation: external-session placeholders found by the disk scan do
    // not carry header extension fields -- fill in the agent label from the registry
    // (frontend badges / external model directory routing depend on it).
    stampExternalSessions(sessions);
    // Placeholder-row activity time for external sessions: the placeholder file is a
    // static anchor (no message lines) and its modified time is frozen at creation --
    // continuing a chat does not update it. While the handle is alive (the user has the
    // session open), override it with the handle's last activity time so the sidebar's
    // "x ago / just now" refreshes with the conversation.
    let refreshPatched = false;
    for (const s of sessions) {
      const h = getHandle(s.id);
      const act = h?.alive() ? h.getLastActivity?.() : undefined;
      if (typeof act === "number" && act > 0) {
        s.modified = new Date(act).toISOString();
        refreshPatched = true;
      }
    }
    if (refreshPatched) sessions.sort((a, b) => b.modified.localeCompare(a.modified));
    // Session annotation slot: extensions append their own fields (e.g. the TUI bridge's
    // in-use marker). Data ownership stays with the extension -- the core knows nothing
    // about bridge registries or other concrete formats.
    try {
      await getRegistry().dispatchSessionAnnotations(sessions);
    } catch (e) {
      console.error("[sessions] annotate failed:", e instanceof Error ? e.message : e);
    }
    // ETag/304: the first load has multiple trigger points (running backfill / SSE frames /
    // recovery flow) that can re-fetch the full list; when the list and running set are
    // unchanged -> 304 empty transfer (client sends If-None-Match). sha1 over ~250KB of
    // JSON is millisecond-scale, far cheaper than the network transfer and client-side parse.
    const payload = {
      sessions,
      sessionListVersion,
      // running = local runtime + backend sessions alive and executing + TUI bridges (visible even when unclaimed)
      runningSessionIds: [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds(), ...getBridgeRunningIds()])],
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    };
    const body = JSON.stringify(payload);
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-store" } });
    }
    // Large lists are gzipped (upstream jsonResponse); the ETag is computed over the uncompressed body to match the client's If-None-Match.
    return jsonResponse(req, payload, {
      headers: { ETag: etag, "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
