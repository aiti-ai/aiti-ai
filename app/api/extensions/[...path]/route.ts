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
};

async function handle(req: NextRequest, params: Params): Promise<Response> {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { path } = await params.params;
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
  return response;
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
