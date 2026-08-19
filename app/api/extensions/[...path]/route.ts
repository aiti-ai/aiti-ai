import { readFileSync, existsSync, statSync } from "fs";
import { NextRequest, NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRegistry } from "@/lib/ext/registry";

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

async function handle(req: NextRequest, params: Params): Promise<Response> {
  // aiti-devtools：注入页面（vhost/本地端口）跨域直连桥——放行 origin 门禁（桥本身有 secret 凭证认证 + 本地无鉴权语义）
  // 其他扩展保持默认门禁
  const { path } = await params.params;
  if (path[0] !== "aiti-devtools" && !isApiRequestAllowed(req)) {
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
      const content = readFileSync(file);
      const dot = file.lastIndexOf(".");
      const type = dot >= 0 ? CONTENT_TYPES[file.slice(dot)] : undefined;
      return new Response(content, {
        status: 200,
        headers: {
          "content-type": type ?? "application/octet-stream",
          "cache-control": "no-store",
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
