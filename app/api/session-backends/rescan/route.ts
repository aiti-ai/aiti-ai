import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";
import { listProviderInfos } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/session-backends/rescan — re-run backend registration scans
 * (server.rescanBackends) across loaded extensions.
 *
 * Backend extensions that probe for their CLI at startup only register when the
 * binary exists, so a CLI installed after the host booted never shows up in the
 * Backend dropdown until restart. This endpoint asks every extension to re-run
 * its probe+register pass (idempotent: same keys overwrite; entries whose CLI
 * disappeared get removed) and returns the refreshed provider list so the
 * client can update the dropdown in one round trip.
 *
 * → { ok, reports: { "<extId>": { registered?, removed?, error? } },
 *     providers: [...], rescanable: true }
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req as never)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const { reports } = await getRegistry().rescanBackends();
    return NextResponse.json({
      ok: true,
      reports,
      providers: listProviderInfos(),
      rescanable: true,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
