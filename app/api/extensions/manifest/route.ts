import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";

// GET /api/extensions/manifest — client-side extension manifest (UI metadata,
// client bundle URL, i18n tables) + the client-modules boot graph + load failures.
// Consumed by components/ExtSlots.tsx (metadata + 失败清单注册进错误指示器) and the
// client bundle loader (graph: rev-anchored entry rows for two-stage load / HMR diffing).
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const reg = getRegistry();
  return NextResponse.json(
    { extensions: reg.manifest(), graph: reg.bootGraph(), failed: reg.loadFailures() },
    { headers: { "cache-control": "no-store" } },
  );
}
