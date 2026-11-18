/**
 * dev server 本地反向代理 + HTML 注入（与 core/inject-html.ts 同语义，载体=独立 http server）：
 * - 仅 text/html 响应、主页面导航（Sec-Fetch-Mode navigate/缺失）注入
 * - 首个 chunk prepend launcher script（流式不缓冲，同 core 做法——生产验证过的语义）
 * - 双注入防护：首 chunk 已含 aiti-launcher.js（目标应用自带 vite 插件等）→ 跳过
 * - 注入会改 body 长度 → 删 content-length 让 Node 转 chunked
 * - navigate 请求强制 accept-encoding: identity（压缩流没法注入）
 * - WebSocket upgrade 隧道透传（Vite HMR 必需）
 */
import * as http from "http";
import * as https from "https";
import type { ServerResponse, IncomingMessage, ClientRequest } from "http";
import type { Socket } from "net";

export interface ProxyHandle {
  port: number;
  /** 代理地址（浏览器应访问这个） */
  url: string;
  target: string;
  close(): Promise<void>;
}

export function launcherScriptTag(bridgeBase: string, name = "aiti-devtools", aiUrl?: string): string {
  // 与 core launcherTag 同构，但跨端口代理场景下用绝对 URL（页面 origin ≠ 桥 origin）
  const base = bridgeBase.replace(/\/+$/, "");
  const ai = (aiUrl || "").trim().replace(/\/+$/, "") || `${base}/cockpit.html`;
  return `<script src="${base}/aiti-launcher.js" data-ai-url="${ai}" data-bridge-url="${base}" data-name="${name}" defer></script>`;
}

export function startProxy(targetUrl: string, listenPort: number, injectTag: string, log: (s: string) => void): Promise<ProxyHandle> {
  const target = new URL(targetUrl);
  const requestUpstream = (opts: http.RequestOptions): ClientRequest =>
    target.protocol === "https:" ? https.request(opts) : http.request(opts);

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const sfm = String(req.headers["sec-fetch-mode"] || "");
    const isNav = !sfm || sfm === "navigate";
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
    if (isNav) headers["accept-encoding"] = "identity"; // HTML 要未压缩才能注入
    delete headers.connection;

    let upstream: ClientRequest;
    try {
      upstream = requestUpstream({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      });
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "aiti proxy: invalid target URL", detail: String(e) }));
      return;
    }
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({
        error: `aiti proxy: target dev server unreachable (${targetUrl})`,
        hint: "check that the dev server is running and targetUrl is configured correctly",
        detail: String(e),
      }));
    });
    req.pipe(upstream);

    upstream.on("response", (ures: IncomingMessage) => {
      const ct = String(ures.headers["content-type"] || "");
      const injectable = isNav && ct.includes("text/html");
      if (!injectable) {
        res.writeHead(ures.statusCode || 502, ures.headers);
        ures.pipe(res);
        return;
      }
      // 注入路径：CL 失效 → 交给 Node chunked
      const outHeaders: http.OutgoingHttpHeaders = { ...ures.headers };
      delete outHeaders["content-length"];
      res.writeHead(ures.statusCode || 502, outHeaders);
      let first = true;
      ures.on("data", (chunk: Buffer) => {
        if (first) {
          first = false;
          if (!chunk.includes("aiti-launcher.js")) {
            res.write(Buffer.concat([Buffer.from(injectTag), chunk]));
            return;
          }
          log("target page already injects by itself (vite plugin etc.) — skipping proxy injection");
        }
        res.write(chunk);
      });
      ures.on("end", () => res.end());
      ures.on("error", () => res.end());
    });
  });

  // WebSocket upgrade 隧道（HMR）：原始字节双向转发
  server.on("upgrade", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
    const upstream: ClientRequest = requestUpstream({
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: req.url,
      method: req.method,
      headers,
    });
    upstream.on("upgrade", (ures, uSocket, uHead) => {
      const lines = [`HTTP/${ures.httpVersion} ${ures.statusCode} ${ures.statusMessage}`];
      for (let i = 0; i < ures.rawHeaders.length; i += 2) lines.push(`${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}`);
      clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
      uSocket.write(head.length ? head : uHead);
      uSocket.pipe(clientSocket);
      clientSocket.pipe(uSocket);
      uSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => uSocket.destroy());
    });
    upstream.on("response", () => clientSocket.destroy()); // 上游拒绝 upgrade
    upstream.on("error", () => clientSocket.destroy());
    upstream.end();
    clientSocket.on("error", () => upstream.destroy());
  });

  server.on("clientError", (_err, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : listenPort;
      log(`proxy listening ${port} → ${targetUrl}`);
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        target: targetUrl,
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
