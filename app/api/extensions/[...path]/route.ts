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
  // Fonts (Monaco codicon etc.; octet-stream gets rejected by font-face)
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// Generic CORS for extension APIs (devtools injection pages connect to the bridge cross-origin; local dev scenario)
const EXT_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

/** Content-hashed filenames from vite/rollup builds (e.g. editor-KLE6jdfb.js / json.worker-BizpAl9O.js).
 *  Content changes → filename changes, so safe to cache immutable forever (Monaco chunked assets etc.).
 *  ⚠ The character class must not contain '-': otherwise extension bundles that themselves contain
 *  hyphens (e.g. aiti-ai-usage.mjs) would match, get immutable caching, and the browser would never
 *  re-fetch after deploy (even defeating the rev parameter). */
const HASHED_ASSET_RE = /-[A-Za-z0-9_]{8}\.[a-zA-Z0-9]+$/;

async function handle(req: NextRequest, params: Params): Promise<Response> {
  // Two cross-origin exemptions (injected pages loading extension assets/APIs):
  //   ① devtools bridge extension: historical special case — all APIs reachable cross-origin (the
  //      bridge authenticates with its own secret credential); pending migration to the declarative form
  //   ② Generic declarative: extension declares publicApi: ["path", ...] in index.ts → exact GET match is exempt
  //      (assets injected into arbitrary pages, e.g. aiti-cpu-meter.js; a cross-origin <script src> sends
  //      Sec-Fetch-Site: cross-site, which the default gate would block → 403 JSON → browser ORB blocks again)
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

      // Content-hashed filename: content changes → name changes, immutable caching forever (previously
      // always no-store, which made chunked assets like Monaco re-fetch entirely on every page load
      // ~4MB/17 requests, turning first editor open from seconds to tens of seconds)
      if (HASHED_ASSET_RE.test(file)) {
        return new Response(readFileSync(file), {
          status: 200,
          headers: {
            "content-type": contentType,
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      }

      // Non-hashed files (loader.js / extension client bundles etc.): ETag negotiated caching —
      // 304 avoids re-transfer when unchanged; new content is fetched immediately when changed
      // (no URL change needed, effective as soon as deployed)
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
  // Apply CORS uniformly (cross-origin injection scenario; harmless for same-origin requests)
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
