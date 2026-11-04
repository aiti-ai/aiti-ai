/**
 * aiti-devtools-core · HTTP 适配器
 *
 * 把 createBridge 的 handle（Next.js route handler 风格：Request → Response，SSE 用 ReadableStream）
 * 适配到 node:http server，供独立桥使用（pi 扩展内嵌、独立桥服务 --http 8777）。
 * 同时提供静态资源（aiti-launcher.js / ai.html / cockpit.html / bridge-client.js）——页面直接
 * <script src="http://<host>:<port>/aiti-launcher.js"> 注入即用。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type StaticFile = { type?: string; content?: string; status?: number; headers?: Record<string, string> };

export interface HttpBridgeOptions {
  port?: number;
  host?: string;
  /** 静态资源映射：路径（如 /aiti-launcher.js）→ 内容（content/type）或重定向（status/headers，如 302 → /cockpit.html）。桥自身端点（/bridge/*、/mcp）优先。 */
  staticFiles?: Record<string, StaticFile>;
  /** 桥端点前缀（path[0]），默认 "bridge" 与 "mcp" 均直通（即 path 原样传给 handle）。 */
  onError?: (err: unknown) => void;
}

export interface HttpBridgeHandle {
  handle(req: Request, path: string[], searchParams: URLSearchParams): Promise<Response>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
export { readBody };

/**
 * 启动独立桥 HTTP server。
 * @returns { server, url, close } —— url 形如 http://127.0.0.1:8777
 */
export function startHttpServer(bridge: HttpBridgeHandle, opts: HttpBridgeOptions = {}) {
  const port = opts.port ?? 8777;
  const host = opts.host ?? "127.0.0.1";
  const staticFiles = opts.staticFiles || {};
  const onError = opts.onError || ((e: unknown) => console.error("[aiti-bridge] http error", e));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;
      const path = pathname.split("/").filter(Boolean);

      // 静态资源（先于桥端点；桥端点为 /bridge/* 与 /mcp*；/aiti/ 前缀剥掉后匹配，旧路径兼容）
      const sfKey = pathname.startsWith("/aiti/") ? pathname.slice(5) : pathname;
      const sf = staticFiles[sfKey];
      const isBridgePath = path[0] === "bridge" || path[0] === "mcp" || (path[0] === "aiti" && (path[1] === "bridge" || path[1] === "mcp"));
      if (sf && !isBridgePath) {
        if (sf.status && sf.status >= 300) {
          res.writeHead(sf.status, { ...(sf.headers || {}), "access-control-allow-origin": "*" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": sf.type || "application/octet-stream", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(sf.content || "");
        return;
      }

      // CORS 预检
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "Content-Type",
        });
        res.end();
        return;
      }

      const body = await readBody(req);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: body.length ? body : undefined,
      });
      const response = await bridge.handle(request, path, url.searchParams);

      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        // 流式转发（SSE：/bridge/sse 与 /mcp GET 持久流；ping 心跳逐块穿透）
        const reader = response.body.getReader();
        // 客户端断开清理：监听 res.close（readBody 消费 req 后 req.close 在注册前已发完，永不触发——僵尸会话根因）
        res.on("close", () => { reader.cancel().catch(() => {}); });
        const pump = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) { res.end(); return; }
            res.write(value);
            pump();
          } catch (e) {
            res.end();
          }
        };
        pump();
      } else {
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }));
      onError(e);
    }
  });

  return new Promise<{ server: Server; url: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.on("error", onError);
      const url = `http://${host}:${port}`;
      resolve({
        server,
        url,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
