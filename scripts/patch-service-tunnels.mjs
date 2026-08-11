#!/usr/bin/env node
/**
 * patch-service-tunnels.mjs — 给 service-tunnels 加通用响应注入（transformResponse）
 *
 * 背景：service-tunnels proxy 纯转发（无 CORS/响应变换）。aiti-devtools 注入需要
 * "text/html 响应 </head> 前插 HTML" 的通用能力——做成库的通用选项 transformResponse：
 *   createServiceTunnels({ transformResponse: ({port, url, method}) => string|null })
 * 命中时代理缓冲 HTML → </head> 前注入片段 → 返回。
 *
 * 用法：node scripts/patch-service-tunnels.mjs（幂等，可重复跑）
 * 触发：package.json postinstall（npm install 后自动应用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "node_modules/service-tunnels/dist");
let changed = 0;

function patch(file, repls) {
  const p = join(dist, file);
  let s;
  try { s = readFileSync(p, "utf8"); } catch (e) { console.error(`[patch-st] ⚠ 跳过 ${file}: ${e.message}`); return; }
  for (const [oldText, newText] of repls) {
    if (s.includes(oldText)) { s = s.replace(oldText, newText); changed++; }
    else if (s.includes(newText)) { /* 已 patch */ }
    else console.warn(`[patch-st] ⚠ 未找到（版本变化?）: ${oldText.slice(0, 50)}…`);
  }
  writeFileSync(p, s);
}

// 1) proxy.js
patch("proxy.js", [
  // createProxyServer 解构
  ['const { port = 4180, basePath = "", serviceBasePath, password = "", auth, log = () => { }, } = opts;',
   'const { port = 4180, basePath = "", serviceBasePath, password = "", auth, log = () => { }, transformResponse = null, } = opts;'],
  // pipeTo 签名
  ["function pipeTo(port, req, res) {", "function pipeTo(port, req, res, transformResponse) {"],
  // pipeTo 响应注入（pipeTo 里唯一一处 proxyRes.pipe(res) 是注入点——用完整上下文匹配）
  [`    proxyReq.on("response", (proxyRes) => {
        // connection semantics belong to the DOWNSTREAM client (the upstream's
        // keep-alive must not leak through — relaying \`Connection: keep-alive\` to
        // a client that asked for close poisons keep-alive socket reuse → 400).
        const headers = { ...proxyRes.headers };
        delete headers.connection;
        delete headers["keep-alive"];
        res.writeHead(proxyRes.statusCode ?? 502, headers);
        proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
}
/** Forward a validated WebSocket upgrade to the service. */`,
   `    proxyReq.on("response", (proxyRes) => {
        // connection semantics belong to the DOWNSTREAM client (the upstream's
        // keep-alive must not leak through — relaying \`Connection: keep-alive\` to
        // a client that asked for close poisons keep-alive socket reuse → 400).
        const headers = { ...proxyRes.headers };
        delete headers.connection;
        delete headers["keep-alive"];
        const inject = typeof transformResponse === "function"
            ? transformResponse({ port, url: req.url ?? "", method: req.method })
            : null;
        if (inject && (headers["content-type"] || "").includes("text/html")) {
            // 响应注入（通用 transformResponse）：缓冲 HTML → </head> 前插入
            const chunks = [];
            proxyRes.on("data", (c) => chunks.push(c));
            proxyRes.on("end", () => {
                let html = Buffer.concat(chunks).toString("utf8");
                html = html.includes("</head>") ? html.replace("</head>", inject + "</head>") : html + inject;
                const h2 = { ...headers, "content-length": String(Buffer.byteLength(html)) };
                delete h2["transfer-encoding"];
                res.writeHead(proxyRes.statusCode ?? 502, h2);
                res.end(html);
            });
            return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, headers);
        proxyRes.pipe(res);
    });
    req.pipe(proxyReq);
}
/** Forward a validated WebSocket upgrade to the service. */`],
  // pipe 分支传参
  ['pipeTo(decision.port, req, res);', 'pipeTo(decision.port, req, res, transformResponse);'],
  // forward 分支注入（含两处 pipe 的完整段——forward 的 response 处理）
  [`                proxyReq.on("response", (proxyRes) => {
                    // connection semantics belong to the DOWNSTREAM client — the upstream's
                    // \`Connection: keep-alive\` must not leak through (relaying it to a
                    // client that asked for close poisons keep-alive socket reuse → 400).
                    const headers = { ...proxyRes.headers };
                    delete headers.connection;
                    delete headers["keep-alive"];
                    res.writeHead(proxyRes.statusCode ?? 502, headers);
                    proxyRes.pipe(res);
                });`,
   `                proxyReq.on("response", (proxyRes) => {
                    // connection semantics belong to the DOWNSTREAM client — the upstream's
                    // \`Connection: keep-alive\` must not leak through (relaying it to a
                    // client that asked for close poisons keep-alive socket reuse → 400).
                    const headers = { ...proxyRes.headers };
                    delete headers.connection;
                    delete headers["keep-alive"];
                    const inject = typeof transformResponse === "function"
                        ? transformResponse({ port: Number(t.port) || 80, url: path, method: req.method })
                        : null;
                    if (inject && (headers["content-type"] || "").includes("text/html")) {
                        const chunks = [];
                        proxyRes.on("data", (c) => chunks.push(c));
                        proxyRes.on("end", () => {
                            let html = Buffer.concat(chunks).toString("utf8");
                            html = html.includes("</head>") ? html.replace("</head>", inject + "</head>") : html + inject;
                            const h2 = { ...headers, "content-length": String(Buffer.byteLength(html)) };
                            delete h2["transfer-encoding"];
                            res.writeHead(proxyRes.statusCode ?? 502, h2);
                            res.end(html);
                        });
                        return;
                    }
                    res.writeHead(proxyRes.statusCode ?? 502, headers);
                    proxyRes.pipe(res);
                });`],
]);

// 2) proxy-manager.js: 传 transformResponse
patch("proxy-manager.js", [
  ["            resolveSite: (p, site, label, vhost) => this.#resolveSite(p, site, label, vhost),\n            log: this.#opts.log ?? (() => { }),",
   "            resolveSite: (p, site, label, vhost) => this.#resolveSite(p, site, label, vhost),\n            transformResponse: this.#opts.transformResponse,\n            log: this.#opts.log ?? (() => { }),"],
]);

// 3) index.js: createServiceTunnels 传 transformResponse
patch("index.js", [
  ["        isPortAllowed: () => true,\n        registerInternal: (role, p) => internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: [\"127.0.0.1\"] }),\n        log: () => { },\n    });",
   "        isPortAllowed: () => true,\n        transformResponse: opts.transformResponse,\n        registerInternal: (role, p) => internal.register(role, { port: p, pid: 0, process: role, cmdline: role, addresses: [\"127.0.0.1\"] }),\n        log: () => { },\n    });"],
]);

// 4) 类型声明
patch("proxy-manager.d.ts", [
  ["    /** Optional Basic password gate for OPEN vhosts. */\n    password?: string;",
   "    /** Optional Basic password gate for OPEN vhosts. */\n    password?: string;\n    /** Response transform hook: return an HTML snippet to inject before </head>\n     *  of text/html responses (generic injection — aiti-devtools launcher etc.).\n     *  `{ port, url, method }` identifies the upstream request; null = no injection. */\n    transformResponse?: (info: { port: number; url: string; method: string }) => string | null;"],
]);
patch("index.d.ts", [
  ["export interface ServiceTunnelsOptions extends DirOptions {",
   "export interface ServiceTunnelsOptions extends DirOptions {\n    /** Response transform hook（透传 proxy）：text/html 响应 </head> 前注入 HTML 片段（通用注入） */\n    transformResponse?: (info: { port: number; url: string; method: string }) => string | null;"],
]);

console.log(`[patch-st] service-tunnels transformResponse patch 应用（${changed} 处改动）`);
