import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";

// GET /api/extensions/status — framework-level load status per extension
// (loaded/enabled/error + slots/hooks/deps detail) + extension roots.
// Management operations (enable/disable/install/uninstall/online registry) live in the
// extman extension's API: /api/extensions/aiti-extman/ops.
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const registry = getRegistry();
  return NextResponse.json(registry.statusPayload(), { headers: { "cache-control": "no-store" } });
}
