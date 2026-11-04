#!/usr/bin/env node
/**
 * aiti-devtools-dsh demos —— 静态服务器
 * 服务 demos/ 下的演示页（page-a/page-b），用于测试 launcher 的页面跳转/返回帧管理。
 *
 * 用法：node demos/serve.mjs [port]   （默认 8090；可 AITI_DEMOS_PORT 覆盖）
 * 然后把 browser 打开 http://127.0.0.1:<port>/page-a.html
 *
 * 说明：demo 页 launcher 默认指向 DSH 域名（window.__AITI_BASE__ = https://dsh.pi.example.com:8443），
 *       需浏览器已登录 dsh.pi.example.com（Authelia）才能拉到 launcher；改 __AITI_BASE__ 为
 *       http://127.0.0.1:3080 可走本地。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.argv[2] || process.env.AITI_DEMOS_PORT || "8090", 10);
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
}).listen(port, "127.0.0.1", () => console.log(`[aiti-demos] http://127.0.0.1:${port}/page-a.html`));
