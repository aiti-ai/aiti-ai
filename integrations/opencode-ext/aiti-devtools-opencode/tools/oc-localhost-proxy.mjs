#!/usr/bin/env node
/**
 * oc-localhost-proxy.mjs · 本地无认证双协议代理（opencode web UI + 桥同源化）
 *   https://opencode.localhost:8442/  (TLS 自签)  ┐
 *   http://127.0.0.1:8443/          (plain)      ├→ / → 19870 opencode（剥 CSP + 注入 aiti client）
 *                                                └→ /aiti/* → 8777 桥
 * 用法：node oc-localhost-proxy.mjs [port=8442]
 */
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const port = parseInt(process.argv[2] || '8442', 10);
const WEB = 'http://127.0.0.1:19870';
const BRIDGE = 'http://127.0.0.1:8777';
const INJECT = '<script src="/aiti/aiti-client-opencode.js" defer></script>';

const certDir = join(homedir(), '.local/share/opencode-aiti');
const keyPath = join(certDir, 'key.pem'), crtPath = join(certDir, 'cert.pem');
if (!existsSync(keyPath)) execSync(`mkdir -p ${certDir} && openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${crtPath} -days 3650 -subj "/CN=opencode.localhost" -addext "subjectAltName=DNS:localhost,DNS:opencode.localhost,IP:127.0.0.1"`, { stdio: 'inherit' });

const handler = async (req, res) => {
  const url = req.url || '/';
  if (url === '/aiti' || url.startsWith('/aiti/')) {
    try {
      const chunks = []; req.on('data', c => chunks.push(c));
      await new Promise(r => req.on('end', r));
      const resp = await fetch(BRIDGE + url, {
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:8777' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
        redirect: 'manual',
      });
      const rh = Object.fromEntries(resp.headers.entries());
      // SSE/长连接直通 pipe（arrayBuffer 会等流结束，EventSource 永远收不到首块）
      if ((rh['content-type'] || '').includes('text/event-stream') && resp.body) {
        res.writeHead(resp.status, rh);
        resp.body.pipe(res);
        resp.body.on('error', () => res.end());
        return;
      }
      res.writeHead(resp.status, rh);
      if (resp.body) res.end(Buffer.from(await resp.arrayBuffer())); else res.end();
    } catch (e) {
      if (!res.headersSent) { try { res.writeHead(502); } catch {} }
      try { res.end('bridge: ' + (e && e.message || e)); } catch {}
    }
    return;
  }
  try {
    const chunks = []; req.on('data', c => chunks.push(c));
    await new Promise(r => req.on('end', r));
    const resp = await fetch(WEB + url, {
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:19870' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      redirect: 'manual',
    });
    const h = Object.fromEntries(resp.headers.entries());
    delete h['content-security-policy']; delete h['content-security-policy-report-only']; delete h['content-length'];
    const ctype = h['content-type'] || '';
    if (ctype.includes('text/html')) {
      let html = await resp.text();
      html = html.includes('</head>') ? html.replace('</head>', INJECT + '</head>') : INJECT + html;
      res.writeHead(resp.status, { ...h, 'content-length': Buffer.byteLength(html) });
      res.end(html);
    } else {
      res.writeHead(resp.status, h);
      if (resp.body) res.end(Buffer.from(await resp.arrayBuffer())); else res.end();
    }
  } catch (e) {
    if (!res.headersSent) { try { res.writeHead(502); } catch {} }
    try { res.end('web: ' + (e && e.message || e)); } catch {}
  }
};

createHttps({ key: readFileSync(keyPath), cert: readFileSync(crtPath) }, handler)
  .listen(port, '127.0.0.1', () => console.log(`[oc-localhost] https://opencode.localhost:${port}/`));
createHttp(handler)
  .listen(port + 1, '127.0.0.1', () => console.log(`[oc-localhost] http://127.0.0.1:${port + 1}/ (plain)`));
