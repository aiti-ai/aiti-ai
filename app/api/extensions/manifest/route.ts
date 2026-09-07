import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // createHash 需要 node runtime

// GET /api/extensions/manifest — client-side extension manifest (UI metadata,
// client bundle URL, i18n tables) + the client-modules boot graph + load failures.
// Consumed by components/ExtSlots.tsx (metadata + 失败清单注册进错误指示器) and the
// client bundle loader (graph: rev-anchored entry rows for two-stage load / HMR diffing).
export async function GET(req: NextRequest): Promise<Response> {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const reg = getRegistry();
  // ETag/304：扩展 reload 前清单稳定；客户端持 localStorage 副本带 If-None-Match，
  // 未变时 304 零传输（清单含 i18n 表 ~50KB，首屏串行拉取值得省）。
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
