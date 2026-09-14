import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs"; // esbuild 需要 node runtime

// GET /api/extensions/client-bundle?rev=<rev> — eager 扩展 client bundle 批量包
// （lib/ext/client-bundle.ts）：一个自包含 ESM，导出 { registry: { [extId]: registerFn } }。
// 前端 loader（components/ext-client-loader.ts）一次 import 后按启动图逐项 materialize，
// 把「首屏 ~35 个扩展 client 请求 + 子 chunk」压成 1 个请求。
// URL 内容寻址（rev = 参与扩展集合的哈希）：内容变 → rev 变，可 immutable 永久缓存。
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
