import { readFileSync, existsSync, statSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry, isPublicApiPath } from "@/lib/ext/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ path: string[] }> };

const CONTENT_TYPES: Record<string, string> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  // 字体（Monaco codicon 等；octet-stream 会被 font-face 拒载）
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// 扩展 API 通用 CORS（aiti-devtools 注入页跨域直连桥；本地开发场景）
const EXT_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

/** vite/rollup 构建产物的内容 hash 文件名（如 editor-KLE6jdfb.js / json.worker-BizpAl9O.js）。
 *  内容变 → 文件名变，可安全 immutable 永久缓存（Monaco 分包资产等）。
 *  ⚠ 字符类不能含 '-'：否则 aiti-ai-usage.mjs 这类自身带连字符的扩展 bundle
 *  会误匹配，拿到 immutable 永久缓存，部署后浏览器永不拉新（rev 参数也被击穿）。 */
const HASHED_ASSET_RE = /-[A-Za-z0-9_]{8}\.[a-zA-Z0-9]+$/;

async function handle(req: NextRequest, params: Params): Promise<Response> {
  // 跨源豁免（注入页面加载扩展资产/API）两条路：
  //   ① aiti-devtools：历史特例——全 API 跨源直连桥（桥自身有 secret 凭证认证）；待迁移为声明式
  //   ② 通用声明式：扩展在 index.ts 声明 publicApi: ["path", ...] → GET 精确命中即豁免
  //      （service-tunnels 注入到任意页面的资产，如 aiti-cpu-meter.js；跨源 <script src> 带
  //      Sec-Fetch-Site: cross-site，默认门禁必拦 → 403 JSON → 浏览器 ORB 二次拦截）
  const { path } = await params.params;
  const publicApiExempt = req.method === "GET"
    && path.length >= 2
    && isPublicApiPath(path[0], path.slice(1).join("/"));
  if (path[0] !== "aiti-devtools" && !publicApiExempt && !isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (path.length === 0) return NextResponse.json({ error: "missing extension id" }, { status: 400 });

  const registry = getRegistry();
  const [extId, ...rest] = path;

  // /api/extensions/<id>/assets/<file> — serve files inside the extension dir.
  if (rest[0] === "assets") {
    const file = registry.assetPath(extId, rest.slice(1).join("/"));
    if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });
    try {
      if (!existsSync(file) || !statSync(file).isFile()) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      const dot = file.lastIndexOf(".");
      const type = dot >= 0 ? CONTENT_TYPES[file.slice(dot)] : undefined;
      const contentType = type ?? "application/octet-stream";

      // 内容 hash 文件名：内容变→名变，immutable 永久缓存（此前一律 no-store，导致
      // Monaco 等分包资产每次页面加载全量重拉 ~4MB/17 请求，首次打开编辑器秒级→十秒级）
      if (HASHED_ASSET_RE.test(file)) {
        return new Response(readFileSync(file), {
          status: 200,
          headers: {
            "content-type": contentType,
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }

      // 非 hash 文件（loader.js / 扩展 client bundle 等）：ETag 协商缓存——文件未变时
      // 304 免重传；变了立即拿新的（不依赖 URL 变化，部署即生效）
      const st = statSync(file);
      const etag = `W/"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, {
          status: 304,
          headers: { etag, "cache-control": "public, max-age=0, must-revalidate" },
        });
      }
      return new Response(readFileSync(file), {
        status: 200,
        headers: {
          "content-type": contentType,
          etag,
          "cache-control": "public, max-age=0, must-revalidate",
        },
      });
    } catch {
      return NextResponse.json({ error: "read failed" }, { status: 500 });
    }
  }

  const response = await registry.api(req, path);
  if (!response) return NextResponse.json({ error: "not found" }, { status: 404 });
  // 统一加 CORS（aiti 跨域注入场景；同源请求无害）
  for (const [k, v] of Object.entries(EXT_CORS)) response.headers.set(k, v);
  return response;
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: EXT_CORS });
}

export async function GET(req: NextRequest, ctx: Params): Promise<Response> {
  return handle(req, ctx);
}
export async function POST(req: NextRequest, ctx: Params): Promise<Response> {
  return handle(req, ctx);
}
export async function PUT(req: NextRequest, ctx: Params): Promise<Response> {
  return handle(req, ctx);
}
export async function DELETE(req: NextRequest, ctx: Params): Promise<Response> {
  return handle(req, ctx);
}
export async function PATCH(req: NextRequest, ctx: Params): Promise<Response> {
  return handle(req, ctx);
}
