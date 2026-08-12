import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";

// GET /api/extensions/status — load status per extension (errors included).
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const registry = getRegistry();
  return NextResponse.json({
    loaded: registry.isLoaded(),
    extensionsRoot: registry.extensionsRoot(),
    extraExtensionsRoots: registry.extraExtensionsRoots(),
    bundledExtensionsRoot: registry.bundledExtensionsRoot(),
    dataRoot: registry.dataRoot(),
    extensions: registry.status(),
  }, { headers: { "cache-control": "no-store" } });
}
