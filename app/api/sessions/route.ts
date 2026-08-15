import { NextResponse } from "next/server";
import { listAllSessions, invalidateSessionListCache } from "@/lib/session-reader";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export async function GET(req: Request) {
  try {
    // Extension-triggered mutations (e.g. session-manager archive) change the
    // on-disk list out from under the 5s TTL cache — let callers force a
    // fresh scan instead of waiting for the cache to expire.
    if (new URL(req.url).searchParams.get("refresh") === "1") {
      invalidateSessionListCache();
    }
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds() });
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
