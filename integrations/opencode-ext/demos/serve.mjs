#!/usr/bin/env node
/**
 * aiti-devtools-opencode demos —— 静态服务器
 * 服务 demos/ 下的演示页（page-a/page-b），用于测试 launcher + opencode web UI AI 窗。
 *
 * 用法：node demos/serve.mjs [port]   （默认 8091；可 AITI_DEMOS_PORT 覆盖）
 * 浏览器打开 http://127.0.0.1:<port>/page-a.html
 *
 * demo 页 launcher 默认指向 opencode 调试口（https://opencode.pi.example.com:8443，免认证直通，
 * 页面无需登录即可拉 launcher / 连桥）；AI 窗 = 该口上的 opencode web UI（nginx 已注入
 * aiti-client-opencode.js）。改 window.__AITI_BASE__ 可走其他环境（8443 需 Authelia；
 * http://127.0.0.1:8777 为本地裸桥，AI 窗退化为 cockpit）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.argv[2] || process.env.AITI_DEMOS_PORT || "8091", 10);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".json": "application/json" };

http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  const file = path.join(dir, p === "/" ? "page-a.html" : p);
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("404 " + p);
  }
}).listen(port, "127.0.0.1", () => console.log(`[aiti-oc-demos] http://127.0.0.1:${port}/page-a.html`));
