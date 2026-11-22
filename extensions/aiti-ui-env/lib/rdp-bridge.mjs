#!/usr/bin/env node
/**
 * aiti-ui-env · RDP bridge —— WebSocket → TCP RDP 隧道。
 *
 * 与 vnc-bridge.mjs 同构（RFC 6455 帧透传），仅改端口/目标/静态目录/cookie 名。
 * 监听 127.0.0.1:<webPort>（仅回环）：
 *   GET          → webRDP 静态文件（FreeRDP WASM dist，index.html 等）
 *   WS upgrade   → 握手前校验 Cookie `ui_env_rdp`（HMAC 签名 + 30min TTL）→
 *                    通过才连 RDP_HOST:RDP_PORT 透传 RDP binary；
 *                    无/错 cookie → 主动 403。
 *
 * 安全模型：完整 RDP token 永不进 URL；URL 零凭据 = 30min HttpOnly cookie。
 * 无 npm 依赖：手写 RFC 6455 帧编解码 + node:http/net/crypto。
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, normalize, resolve, sep } from "node:path";

const PORT = Number(process.env.UI_ENV_RDP_WEB_PORT || 6090);
const RDP_PORT = Number(process.env.UI_ENV_RDP_PORT || 3389);
const RDP_HOST = process.env.UI_ENV_RDP_HOST || "127.0.0.1";
const RDP_DIR = process.env.UI_ENV_RDP_DIR || "";
// grdpwasm 大文件不落静态目录（安装副本已删）：静态目录缺文件时回退到这份
 // 后端 justget 预取的缓存（ensureRdpWasm → UI_ENV_RDP_WASM_CACHE，同源路径不变）
const WASM_CACHE = process.env.UI_ENV_RDP_WASM_CACHE || "";
const RDP_INDEX = process.env.UI_ENV_RDP_INDEX || "index.html";
const SECRET = process.env.UI_ENV_RDP_TOKEN || "";
const SESSION_TTL_MS = Number(process.env.UI_ENV_SESSION_TTL || 24 * 60 * 60 * 1000);
const HANDSHAKE_TIMEOUT = 5000;
const MAX_WRITE_RETRY = 3;
process.on("uncaughtException", (e) => {
  try { appendFileSync(process.env.UI_ENV_BRIDGE_LOG || "/tmp/aiti-rdp-bridge-crash.log", new Date().toISOString() + " UNCAUGHT: " + (e && e.stack || e) + "\n"); } catch {}
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  try { appendFileSync(process.env.UI_ENV_BRIDGE_LOG || "/tmp/aiti-rdp-bridge-crash.log", new Date().toISOString() + " UNHANDLED: " + (e && e.stack || e) + "\n"); } catch {}
});

const WRITE_BACKPRESSURE_HWM = Number(process.env.UI_ENV_RDP_BP_HWM || 32) * (1 << 20); // 默认 32MB — RDP 全屏未压缩帧可达 4MB，浏览器消费稍慢属正常，阈值太低会误杀连接

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ── 会话校验（无状态 HMAC 签名 + 30min TTL）——cookie 认证，URL 无任何凭据 ──
function hmacOf(ts) {
  return createHmac("sha256", SECRET).update("rdp-session:" + ts).digest("hex");
}

function parseCookie(req) {
  const c = req.headers["cookie"] || "";
  for (const part of c.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "ui_env_rdp") return part.slice(i + 1).trim();
  }
  return null;
}

function verifySession(sess) {
  if (!SECRET || !sess) return false;
  const i = sess.lastIndexOf(".");
  if (i <= 0) return false;
  const ts = sess.slice(0, i), sig = sess.slice(i + 1);
  if (!/^[a-z0-9]+$/.test(ts)) return false;
  const age = Date.now() - parseInt(ts, 36);
  if (!Number.isFinite(age) || age < -5000 || age > SESSION_TTL_MS) return false;
  const expect = hmacOf(ts);
  if (sig.length !== expect.length) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expect, "hex"));
}

// ── 静态服务（webRDP 官方静态客户端，无服务端能力） ──
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".map": "application/json",
  ".wasm": "application/wasm",
};

function serveStatic(req, res, pathname) {
  const file = pathname === "/" ? RDP_INDEX : pathname.replace(/^\/+/, "");
  let abs = resolve(join(RDP_DIR, file));
  const root = resolve(RDP_DIR);
  if (abs !== root && !abs.startsWith(root + sep) && !abs.startsWith(root + "/")) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      // 静态目录没有 → 后端 justget 缓存兑底（仅限缓存目录内同名文件，如 main.wasm）
      const fb = WASM_CACHE ? join(resolve(WASM_CACHE), basename(file)) : "";
      if (fb && fb.startsWith(resolve(WASM_CACHE) + "/") && existsSync(fb) && statSync(fb).isFile()) {
        abs = fb;
      } else {
        res.writeHead(404); res.end("not found"); return;
      }
    }
    // 静态资产缓存：HTML 每次拉新（no-store）；wasm/js/css 等大文件用 ETag 协商——
    // 未变化回 304 不重传 body（WASM 数 MB），变化则立取新版，兼顾缓存与更新。
    const st = statSync(abs);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const isHtml = file === RDP_INDEX || extname(abs) === ".html";
    if (!isHtml && req.headers["if-none-match"] === etag) {
      res.writeHead(304, { etag, "cache-control": "no-cache" });
      res.end();
      return;
    }
    let body = readFileSync(abs);
    // 注入实例目标配置（页面自动连接 + 表单预填用）：target 不落 URL，由桥从自身 env
    // （实例配置 UI_ENV_RDP_HOST/PORT）注入页面，页面读 window.__rdpTarget 即可。
    // 必须插在 <head> 末尾（早于 </body> 前的 __rdpAutoConnect 自动连接脚本），否则自动连接读到 undefined 直接跳过。
    if (file === RDP_INDEX) {
      const s = body.toString("utf8");
      // 幂等标记必须匹配注入节点本身（<script id="__rdpTarget">）；不能用裸 __rdpTarget——
      // 部署时 patch 的自动连接脚本里也含 window.__rdpTarget 引用，会误判已注入而跳过。
      if (!s.includes('<script id="__rdpTarget"')) {
        const inject = `<script id="__rdpTarget">window.__rdpTarget = ${JSON.stringify({ host: RDP_HOST, port: RDP_PORT })};</script>`;
        body = Buffer.from(s.includes("</head>") ? s.replace("</head>", inject + "\n</head>") : s.replace("<body", inject + "\n<body"), "utf8");
      }
    }
    const ext = extname(abs);
    const headers = { "content-type": MIME[ext] || "application/octet-stream" };
    if (isHtml) headers["cache-control"] = "no-store";
    else { headers["cache-control"] = "no-cache"; headers.etag = etag; }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(500); res.end("internal error");
  }
}

// ── RFC 6455 帧 ──
function makeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

const MAX_FRAME = 16 * 1024 * 1024;
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] >> 7) & 1;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) return { opcode, payload: null, bad: true };
    len = Number(big); off = 10;
  }
  if (!masked) return { opcode, payload: null, bad: true };
  if (buf.length < off + 4) return null;
  const mask = buf.subarray(off, off + 4); off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i % 4];
  return { opcode, payload, consumed: off + len };
}

function frameText(s) { return makeFrame(0x1, Buffer.from(s, "utf8")); }

// ── WS 会话：cookie 认证（握手即校验）→ TCP 透传 ──
function handleUpgrade(req, socket, pathname, effectiveUrl) {
  if (pathname !== "/ws") { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  if (!verifySession(parseCookie(req))) {
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.end();
    return;
  }
  // 安全：目标地址固定使用 env 配置（UI_ENV_RDP_HOST/PORT），
  // 不接受客户端传来的 target 参数（防止 SSRF——客户端不能指定连接目标）。
  const rdpHost = RDP_HOST, rdpPort = RDP_PORT;
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");

  let buf = Buffer.alloc(0);
  let wsClosed = false, tcp = null;
  let writePending = false;       // true: 上次 write 未 drained（背压标记）
  let writeQueue = [];            // 待写缓冲区（仅在背压时暂存）
  // WebSocket message reassembly: accumulate continuation frames until FIN.
  // Browsers may fragment large binary messages across multiple frames; if we
  // forwarded each fragment as a separate TCP write the RDP PDU stream would be
  // corrupted → server reports protocol errors (e.g. 0x80090304) and drops.
  let fragBuf = null;  // non-null while accumulating an un-FINished message

  const closeWs = (reason) => {
    if (!wsClosed) {
      wsClosed = true;
      try { appendFileSync(process.env.UI_ENV_BRIDGE_LOG || "/tmp/aiti-rdp-bridge-crash.log", new Date().toISOString().slice(11, 19) + " closeWs: " + (reason || "unspecified") + "\n"); } catch {}
      try { socket.end(); } catch {}
      if (tcp) { tcp.destroy(); tcp = null; }
    }
  };

  // 将 data 写入 WebSocket 并处理背压
  // 如果上次 write 返回 false（背压），则暂存到 writeQueue，等 drain 再写
  const wsWrite = (data) => {
    if (wsClosed) return;
    if (writePending) {
      // 背压中：队列累积超过高水位 → 断开（防止内存泄漏/浏览器消费太慢）
      writeQueue.push(data);
      if (writeQueue.length > 32 || writeQueue.reduce((s, b) => s + b.length, 0) > WRITE_BACKPRESSURE_HWM) {
        writeQueue.length = 0;
        closeWs();
      }
      return;
    }
    const frame = makeFrame(0x2, data);
    try {
      const flushed = socket.write(frame);
      if (!flushed) {
        writePending = true;
        // 超时保护：如果 drain 10s 内不来，主动断开
        const drainTimer = setTimeout(() => {
          if (writePending && !wsClosed) {
            writePending = false;
            writeQueue.length = 0;
            closeWs();
          }
        }, 60000);
        socket.once("drain", () => {
          clearTimeout(drainTimer);
          writePending = false;
          // 把排队数据写出
          const q = writeQueue; writeQueue = [];
          for (const d of q) wsWrite(d);
        });
      }
    } catch (e) { closeWs("ws-write: " + (e && e.message)); }
  };

  tcp = connect(RDP_PORT, RDP_HOST, () => {});
  let tcpBytesIn = 0, wsBytesIn = 0;
  tcp.on("data", (d) => {
    if (wsClosed) return;
    tcpBytesIn += d.length;
    try { appendFileSync(process.env.UI_ENV_BRIDGE_LOG || "/tmp/aiti-rdp-bridge-crash.log", new Date().toISOString().slice(11, 19) + " tcp→ws " + d.length + "B (total " + tcpBytesIn + ") head=" + d.slice(0, 8).toString("hex") + "\n"); } catch {}
    wsWrite(d);
  });
  tcp.on("error", (e) => closeWs("tcp-error: " + (e && e.message)));
  tcp.on("close", () => { closeWs("tcp-close"); });

  socket.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    while (off < buf.length) {
      const frame = parseFrame(buf.subarray(off));
      if (!frame) break;
      if (frame.bad) { closeWs("bad-frame"); return; }
      off += frame.consumed;
      if (frame.opcode === 0x8) { closeWs("ws-close-frame"); return; }
      if (frame.opcode === 0x9) {
        try { socket.write(makeFrame(0xA, frame.payload)); } catch (e) { closeWs("pong-write: " + (e && e.message)); }
        continue;
      }
      // FIN bit (buf[off-consumed] & 0x80). parseFrame already consumed, so
      // re-read the FIN from the frame start byte we just parsed.
      const frameStart = off - frame.consumed;
      const fin = (buf[frameStart] & 0x80) !== 0;
      if (frame.opcode === 0x2 || frame.opcode === 0x0) {
        // Binary message (0x2) or continuation (0x0).
        if (frame.opcode === 0x2) {
          // Start of a new message (discard any partial un-FINished one).
          fragBuf = frame.payload;
        } else {
          // Continuation: append.
          if (fragBuf !== null) {
            fragBuf = fragBuf.length ? Buffer.concat([fragBuf, frame.payload]) : frame.payload;
          } else {
            fragBuf = frame.payload; // stray continuation, treat as start
          }
        }
        if (fin) {
          // Complete message: forward to TCP.
          const p = fragBuf;
          fragBuf = null;
          if (tcp && p) {
            wsBytesIn += p.length;
            try { appendFileSync(process.env.UI_ENV_BRIDGE_LOG || "/tmp/aiti-rdp-bridge-crash.log", new Date().toISOString().slice(11, 19) + " ws→tcp " + p.length + "B (total " + wsBytesIn + ") head=" + p.slice(0, 8).toString("hex") + "\n"); } catch {}
            try { tcp.write(p); } catch (e) { closeWs("tcp-write: " + (e && e.message)); }
          }
        }
      }
    }
    if (off > 0) buf = buf.subarray(off);
  });

  socket.on("error", (e) => closeWs("socket-error: " + (e && e.message)));
  socket.on("close", () => closeWs("socket-close"));
  socket.on("end", () => closeWs("socket-end"));
}

// ── 入口 ──
if (!RDP_DIR || !existsSync(RDP_DIR)) {
  console.error("[rdp-bridge] RDP_DIR 不存在: " + RDP_DIR);
  process.exit(1);
}

// ── nginx 直连模式：从请求 URL 剥离 /aiti-ui-env/rdp/ 前缀后路由 ──
// nginx location 以完整 URI 转发（正则 location 特性），bridge 自行剥离前缀。
// 兼容旧模式：无前缀时直接处理（直连测试 / 旧 webRDP 路径）。
const RDP_PREFIX = "/aiti-ui-env/rdp/";
function stripRdpPrefix(url) {
  const u = new URL(url, "http://x");
  if (u.pathname.startsWith(RDP_PREFIX)) {
    u.pathname = u.pathname.slice(RDP_PREFIX.length) || "/";
    // 若 target 嵌在路径里（nginx map 转发），合并到查询参数
    // 例如 /ws/host:port → /ws?target=host:port
    return u.toString();
  }
  return url;
}

const server = createServer((req, res) => {
  const stripped = stripRdpPrefix(req.url);
  const pathname = new URL(stripped, "http://x").pathname;
  serveStatic(req, res, pathname);
});

server.on("upgrade", (req, socket) => {
  const stripped = stripRdpPrefix(req.url);
  const pathname = new URL(stripped, "http://x").pathname;
  handleUpgrade(req, socket, pathname, stripped);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[rdp-bridge] 127.0.0.1:${PORT} （静态: ${RDP_DIR}；RDP→${RDP_HOST}:${RDP_PORT}；认证=ws cookie 会话）`);
});