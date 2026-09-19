import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // esbuild needs the node runtime

// GET /api/extensions/client-bundle?rev=<rev> — eager extension client bundle batch
// (lib/ext/client-bundle.ts): one self-contained ESM exporting { registry: { [extId]: registerFn } }.
// The frontend loader (components/ext-client-loader.ts) imports it once and materializes items
// per the startup graph, compressing "~35 extension client requests + sub-chunks on first paint"
// into 1 request.
// URL content addressing (rev = hash of the participating extension set): content changes → rev
// changes, safe to cache immutable forever.
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { rev, code, ids } = await getRegistry().clientBundle();
  return new Response(code, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${rev}"`,
      "x-pi-web-bundle-ids": String(ids.length),
    },
  });
}
