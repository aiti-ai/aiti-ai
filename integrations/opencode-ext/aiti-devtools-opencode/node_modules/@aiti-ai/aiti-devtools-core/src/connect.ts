/**
 * aiti-devtools-core · Connect 中间件适配（公共能力，载体无关）
 *
 * 把 bridge.handle（Next 风格 Request → Response）适配成 Connect 中间件
 * （(req, res, next) => void）——express / vite / webpack-dev-server 共用同一中间件格式，
 * 一个适配器覆盖所有挂中间件的载体；无构建场景用 startHttpServer（node:http 直挂）。
 *
 * 只接管 <prefix>/*（默认 /aiti/）；其余路径 next() 放行给宿主应用。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpBridgeHandle, StaticFile } from "./http.ts";
import { readBody } from "./http.ts";

export interface ConnectBridgeOptions {
  /** 挂载前缀（默认 /aiti；只接管此前缀下的路径） */
  prefix?: string;
  /** 静态资源映射（路径如 /aiti-launcher.js → 内容；剥前缀后匹配，同独立桥） */
  staticFiles?: Record<string, StaticFile>;
  onError?: (err: unknown) => void;
}

export interface ConnectMiddleware {
  (req: IncomingMessage, res: ServerResponse, next: () => void): void;
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type",
};

export function connectBridge(bridge: HttpBridgeHandle, opts: ConnectBridgeOptions = {}): ConnectMiddleware {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/";
  const staticFiles = opts.staticFiles || {};
  const onError = opts.onError || ((e: unknown) => console.error("[aiti-bridge] middleware error", e));

  return (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    // 只接管 <prefix>/*；其余交给宿主应用
    if (pathname !== prefix && !pathname.startsWith(prefix + "/")) return next();

    // 静态资产（剥前缀后匹配；桥端点优先——与独立桥 isBridgePath 语义一致）
    const rest = pathname === prefix ? "/" : pathname.slice(prefix.length);
    const pathArr = rest.split("/").filter(Boolean);
    const isBridgePath = pathArr[0] === "bridge" || pathArr[0] === "mcp" || (pathArr[0] === "aiti" && (pathArr[1] === "bridge" || pathArr[1] === "mcp"));
    const sf = staticFiles[rest] || staticFiles[rest.replace(/\/+$/, "") || "/"];
    if (sf && !isBridgePath) {
      if (sf.status && sf.status >= 300) {
        res.writeHead(sf.status, { ...(sf.headers || {}), ...CORS_HEADERS });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": sf.type || "application/octet-stream", "cache-control": "no-store", ...CORS_HEADERS });
      res.end(sf.content || "");
      return;
    }

    // CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const request = new Request(url, {
      method: req.method,
      headers: req.headers as Record<string, string>,
    });

    // 读体 → 转发桥 → 写回（SSE 流式）
    readBody(req)
      .then((buf) => {
        const r = new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body: buf.length ? buf : undefined });
        return bridge.handle(r, pathArr, url.searchParams);
      })
      .then((response) => {
        res.writeHead(response.status, { ...Object.fromEntries(response.headers.entries()), ...(response.status === 204 ? {} : {}) });
        if (response.body) {
          const reader = response.body.getReader();
          // 客户端断开清理：监听 res.close（readBody 消费 req 后 req.close 在注册前已发完，永不触发——僵尸会话根因）
          res.on("close", () => { reader.cancel().catch(() => {}); });
          const pump = async () => {
            try {
              const { done, value } = await reader.read();
              if (done) { res.end(); return; }
              res.write(value);
              pump();
            } catch {
              res.end();
            }
          };
          pump();
        } else {
          response.arrayBuffer().then((ab) => res.end(Buffer.from(ab))).catch(() => res.end());
        }
      })
      .catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }));
        onError(e);
      });
  };
}
