import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { InteractionBroker } from "./broker.ts";
import type { InteractionBrokerEvent } from "./types.ts";

export interface InteractionServerOptions {
  broker: InteractionBroker;
  host?: string
  port?: number;
  /** Bearer token. Omit for a random token; pass "" to disable auth (loopback dev only). */
  token?: string
  /** Let the built-in page auto-size to its content (default true). Pinned geometry sets false. */
  autosize?: boolean
  /** Directory containing interaction.html + interaction-client.js. */
  pageDir?: string
  pageFile?: string
  clientFile?: string
}

export interface InteractionServerHandle {
  server: Server;
  port: number;
  host: string
  /** Base HTTP origin, no token (append API paths). */
  baseUrl: string
  /** Page URL, including ?token= when auth is enabled. */
  url: string
  token: string
  close: () => Promise<void>;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function tokenOf(req: IncomingMessage, url: URL): string {
  const auth = String(req.headers.authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : String(url.searchParams.get("token") || "");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function serveFile(res: ServerResponse, path: string, contentType: string): void {
  try {
    const body = readFileSync(path);
    // Custom pages live on another loopback origin and import the client module.
    res.writeHead(200, { "content-type": contentType, "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

/**
 * Start the loopback HTTP + SSE endpoint consumed by interaction pages.
 *
 * The page is public static content; all state/answer endpoints require the token.
 * SSE uses `data: {type,...}` frames and reconnects automatically.
 */
export async function startInteractionServer(options: InteractionServerOptions): Promise<InteractionServerHandle> {
  const host = options.host || "127.0.0.1";
  const port = Number.isInteger(options.port) ? Number(options.port) : 0;
  const token = options.token === undefined ? randomUUID() : String(options.token);
  const pageDir = options.pageDir || fileURLToPath(new URL("../page/", import.meta.url));
  const pageFile = options.pageFile || "interaction.html";
  const clientFile = options.clientFile || "interaction-client.js";
  const sseClients = new Set<ServerResponse>();

  const authorized = (req: IncomingMessage, url: URL): boolean => token === "" || tokenOf(req, url) === token;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, JSON_HEADERS);
      res.end();
      return;
    }
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        serveFile(res, join(pageDir, pageFile), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/interaction-client.js") {
        serveFile(res, join(pageDir, clientFile), "text/javascript; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, { ok: true, pending: options.broker.pending().length });
        return;
      }
      if (!authorized(req, url)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/interactions/pending") {
        json(res, 200, { ok: true, requests: options.broker.pending() });
        return;
      }
      if (req.method === "GET" && url.pathname === "/interactions/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*",
        });
        res.write("retry: 1000\n\n");
        sseClients.add(res);
        const write = (event: InteractionBrokerEvent) => {
          try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
        };
        const unsubscribe = options.broker.subscribe(write);
        const heartbeat = setInterval(() => {
          try { res.write(": ping\n\n"); } catch { /* closed */ }
        }, 15000);
        heartbeat.unref?.();
        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          sseClients.delete(res);
        };
        req.on("close", cleanup);
        req.on("error", cleanup);
        return;
      }
      if (options.allowCreate && req.method === "POST" && url.pathname === "/interactions") {
        let body: Record<string, unknown>;
        try {
          body = await readJson(req);
        } catch (error) {
          json(res, 400, { error: String((error as Error)?.message || error) });
          return;
        }
        const spec = (body.request && typeof body.request === "object" ? body.request : body) as {
          kind?: string;
        };
        if (!spec || typeof spec.kind !== "string") {
          json(res, 400, { error: "request.kind is required" });
          return;
        }
        const opened = options.broker.open(spec as never);
        try { options.onCreate?.(opened.request); } catch { /* best effort */ }
        json(res, 200, { ok: true, id: opened.id, request: opened.request });
        return;
      }
      const waitMatch = /^\/interactions\/([^/]+)\/wait$/.exec(url.pathname);
      if (req.method === "GET" && waitMatch) {
        const id = decodeURIComponent(waitMatch[1]);
        const pending = options.broker.wait(id);
        if (!pending) {
          json(res, 409, { error: "no pending interaction with that id" });
          return;
        }
        const result = await pending;
        json(res, 200, { ok: true, result });
        return;
      }
      const oneMatch = /^\/interactions\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && oneMatch) {
        const id = decodeURIComponent(oneMatch[1]);
        const request = options.broker.pending().find((r) => r.id === id);
        if (!request) {
          json(res, 404, { error: "no pending interaction with that id" });
          return;
        }
        json(res, 200, { ok: true, request });
        return;
      }
      const answerMatch = /^\/interactions\/([^/]+)\/answer$/.exec(url.pathname);
      if (req.method === "POST" && answerMatch) {
        const id = decodeURIComponent(answerMatch[1]);
        let body: Record<string, unknown>;
        try {
          body = await readJson(req);
        } catch (error) {
          json(res, 400, { error: String((error as Error)?.message || error) });
          return;
        }
        const outcome = options.broker.answer(id, body as any);
        if (!outcome.ok) {
          const status = outcome.code === "not_found" ? 409 : 400;
          json(res, status, { error: outcome.error || "answer failed", ...outcome });
          return;
        }
        json(res, 200, { ok: true, ...outcome });
        return;
      }
      const cancelMatch = /^\/interactions\/([^/]+)\/cancel$/.exec(url.pathname);
      if (req.method === "POST" && cancelMatch) {
        const id = decodeURIComponent(cancelMatch[1]);
        const ok = options.broker.cancel(id, "cancelled by renderer");
        json(res, ok ? 200 : 409, ok ? { ok: true } : { error: "no pending interaction with that id" });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, { error: String((error as Error)?.message || error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = `http://${host}:${actualPort}/`;
  const pageParams = new URLSearchParams();
  if (token) pageParams.set("token", token);
  if (options.autosize === false) pageParams.set("autosize", "0");
  const query = pageParams.toString();
  const url = query ? `${baseUrl}?${query}` : baseUrl;
  return {
    server,
    port: actualPort,
    host,
    baseUrl,
    url,
    token,
    close: async () => {
      for (const client of sseClients) {
        try { client.end(); } catch { /* ignore */ }
      }
      sseClients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
