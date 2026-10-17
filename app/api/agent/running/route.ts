import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { getRunningHandleIds } from "@/lib/session/handle-store";
import { getBridgeRunningIds } from "@/lib/session/bridge-running";
import { ensureRunningBroadcast } from "@/lib/running-broadcast";
import { getSessionUiStateRevision } from "@/lib/session-ui-state";

export const dynamic = "force-dynamic";

/** Running set = local rpc + handles (attach/spawn and similar backends) + TUI
 *  bridge (visible even when unclaimed), merged (design doc
 *  attach-rpc-session-running-sync §2.2; the bridge-side gap was closed after
 *  live testing on 2026-08-28).
 *  Must not be exported — Next route files may only export HTTP
 *  methods/config; extra exports are rejected by .next/types validation. */
function runningSessionIds(): string[] {
  return [...new Set([...getRunningRpcSessionIds(), ...getRunningHandleIds(), ...getBridgeRunningIds()])];
}

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
// sessionUiStateRevision (null when unreadable) tells the sidebar its pins and
// archive changed elsewhere; it costs one stat while the file is unchanged.
export async function GET() {
  // Fallback activation of the running-set broadcast (three-way changes → bus
  // running frames; normally registered by the instrumentation startup section,
  // this guards against deployment-shape differences — idempotent O(1). See
  // lib/running-broadcast.ts)
  ensureRunningBroadcast();
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds: runningSessionIds(),
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      sessionUiStateRevision: getSessionUiStateRevision(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
