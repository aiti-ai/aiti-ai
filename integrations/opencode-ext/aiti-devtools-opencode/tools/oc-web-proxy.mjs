#!/usr/bin/env node
/**
 * oc-web-proxy.mjs · opencode web UI 本地反代（开发/E2E 用；生产用 nginx 同款语义）
 *
 *   - /aiti/*  → 127.0.0.1:8777（桥：同源资产 + REST/SSE）
 *   - 其余     → 127.0.0.1:4321（opencode web UI），并：
 *       · 剥 Content-Security-Policy（web UI 默认 script-src 'self' 禁外部脚本）
 *       · HTML 壳 </head> 前 sub_filter 注入 <script src="/aiti/aiti-client-opencode.js">
 *
 * 用法：node oc-web-proxy.mjs [listen=4322] [web=4321] [bridge=8777]
 */
import { createServer } from 'node:http';

const [listenPort = 4322, webPort = 4321, bridgePort = 8777] = process.argv.slice(2).map(Number);
const INJECT = '<script src="/aiti/aiti-client-opencode.js" defer></script>';

const server = createServer(async (req, res) => {
  const url = req.url || '/';
  // 1) /aiti/* → 桥（同源透传）
  if (url === '/aiti' || url.startsWith('/aiti/')) {
    const target = 'http://127.0.0.1:' + bridgePort + url;
    try {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      await new Promise((r) => req.on('end', r));
      const body = Buffer.concat(chunks);
      const resp = await fetch(target, {
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:' + bridgePort },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
        redirect: 'manual',
      });
      res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()));
      if (resp.body) { const ab = await resp.arrayBuffer(); res.end(Buffer.from(ab)); } else res.end();
    } catch (e) {
      res.writeHead(502); res.end('bridge proxy error: ' + e.message);
    }
    return;
  }
  // 2) 其余 → opencode web UI（剥 CSP + 注入）
  try {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    await new Promise((r) => req.on('end', r));
    const body = Buffer.concat(chunks);
    const resp = await fetch('http://127.0.0.1:' + webPort + url, {
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:' + webPort },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      redirect: 'manual',
    });
    const h = Object.fromEntries(resp.headers.entries());
    delete h['content-security-policy'];        // 剥 CSP（外部脚本注入的前提）
    delete h['content-security-policy-report-only'];
    delete h['content-length'];                  // 注入会改长度
    const ctype = h['content-type'] || '';
    if (ctype.includes('text/html')) {
      let html = await resp.text();
      html = html.includes('</head>') ? html.replace('</head>', INJECT + '</head>') : INJECT + html;
      res.writeHead(resp.status, { ...h, 'content-length': Buffer.byteLength(html) });
      res.end(html);
    } else {
      res.writeHead(resp.status, h);
      if (resp.body) { const ab = await resp.arrayBuffer(); res.end(Buffer.from(ab)); } else res.end();
    }
  } catch (e) {
    res.writeHead(502); res.end('web proxy error: ' + e.message);
  }
});
server.listen(listenPort, '127.0.0.1', () => console.log('[oc-web-proxy] http://127.0.0.1:' + listenPort + '/  (web:' + webPort + ' bridge:' + bridgePort + ')'));
