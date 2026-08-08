import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";

// GET /api/extensions/manifest — client-side extension manifest (UI metadata,
// client bundle URL, i18n tables). Consumed by components/ExtSlots.tsx.
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ extensions: getRegistry().manifest() }, { headers: { "cache-control": "no-store" } });
}
