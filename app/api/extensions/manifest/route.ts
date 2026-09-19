import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // createHash needs the node runtime

// GET /api/extensions/manifest — client-side extension manifest (UI metadata,
// client bundle URL, i18n tables) + the client-modules boot graph + load failures.
// Consumed by components/ExtSlots.tsx (metadata + failure list registered into the
// error indicator) and the client bundle loader (graph: rev-anchored entry rows for
// two-stage load / HMR diffing).
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const reg = getRegistry();
  // ETag/304: the manifest is stable until an extension reload; the client holds a
  // localStorage copy and sends If-None-Match — on an unchanged manifest, 304 means zero
  // transfer (the manifest includes ~50KB i18n tables, worth saving on the first-paint
  // serial fetch).
  const body = JSON.stringify(
    { extensions: reg.manifest(), graph: reg.bootGraph(), failed: reg.loadFailures() },
  );
  const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } });
  }
  return new Response(body, {
    headers: { "content-type": "application/json", etag, "cache-control": "no-store" },
  });
}
