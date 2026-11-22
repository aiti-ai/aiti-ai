#!/usr/bin/env node
/**
 * aiti-ui-env · VNC bridge —— 把「经站点代理连接内部 VNC」固化到协议层。
 *
 * 监听 127.0.0.1:6080（仅回环）：
 *   GET          → noVNC 静态文件（vnc.html / core/*.js 等）
 *   WS upgrade   → 握手前校验 Cookie `ui_env_vnc`（HMAC 签名 + 30min TTL，与 middleware 同算法同
 *                    secret 双层认证）→ 通过才连内部 127.0.0.1:<rfb> VNC server 透传 RFB binary；
 *                    无/错 cookie → 主动 403（middleware 对 upgrade 的 Response 不可靠，认证以桥为准）。
 *
 * 安全模型：完整 VNC token 永不进 URL（仅作会话签名密钥，spawn 时经 env 传入）；
 * URL 零凭据——凭据 = 30min HttpOnly cookie（POST /vnc-session 下发）。握手前无 RFB 数据转发。
 *
 * RFB 纯透传：桥不代答、不改写握手。VNC 密码由 VNC server（x11vnc / UltraVNC）自己认证，
 * 浏览器端 noVNC 自己弹密码框（只问密码，不问用户名）；桥只做静态页 + ws→tcp 字节转发。
 *
 * 无 npm 依赖：手写 RFC 6455 帧编解码 + node:http/net/crypto（替代 python websockify）。
 */
import { createServer } from "node:http";
import { connect } from "node:net";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const PORT = Number(process.env.UI_ENV_VNC_WEB_PORT || 6080);
const RFB_PORT = Number(process.env.UI_ENV_VNC_PORT || 5900);
const RFB_HOST = process.env.UI_ENV_VNC_HOST || "127.0.0.1"; // 目标 VNC 主机（外部 VNC 时非回环）
const NOVNC_DIR = process.env.UI_ENV_NOVNC_DIR || "";
const SECRET = process.env.UI_ENV_VNC_TOKEN || ""; // 签名密钥（vncToken()，spawn 时传入）
const SESSION_TTL_MS = Number(process.env.UI_ENV_SESSION_TTL || 30 * 60 * 1000);
const HANDSHAKE_TIMEOUT = 5000;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ── 会话校验（无状态 HMAC 签名 + 30min TTL）——cookie 认证，URL 无任何凭据 ──
function hmacOf(ts) {
  return createHmac("sha256", SECRET).update("vnc-session:" + ts).digest("hex");
}

function parseCookie(req) {
  const c = req.headers["cookie"] || "";
  for (const part of c.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === "ui_env_vnc") return part.slice(i + 1).trim();
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
  if (!Number.isFinite(age) || age < -5000 || age > SESSION_TTL_MS) return false; // 容忍 5s 时钟偏差
  const expect = hmacOf(ts);
  if (sig.length !== expect.length) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expect, "hex"));
}

// ── 静态服务（noVNC 官方静态客户端，无服务端能力；URL 无凭据，cookie 认证在 middleware+桥双层） ──
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".map": "application/json",
};

function serveStatic(req, res, pathname) {
  const file = pathname === "/" ? "vnc.html" : pathname.replace(/^\/+/, "");
  const abs = resolve(join(NOVNC_DIR, file));
  // 防目录穿越：normalize 后必须仍在 NOVNC_DIR 内（pathname 含 ../ 时 resolve 会逃逸）
  const root = resolve(NOVNC_DIR);
  if (abs !== root && !abs.startsWith(root + sep) && !abs.startsWith(root + "/")) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) { res.writeHead(404); res.end("not found"); return; }
    let body = readFileSync(abs);
    const ext = extname(abs);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
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
  header[0] = 0x80 | opcode; // FIN
  return Buffer.concat([header, payload]);
}

/** 解一帧（客户端→服务端，必须 masked）。返回 {opcode, payload} 或 null（不完整/非法）。 */
const MAX_FRAME = 16 * 1024 * 1024; // 16MB 帧上限（RFB 数据正常 < 1MB；防超大 len DoS）
function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] >> 7) & 1;
  let len = buf[1] & 0x7f, off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME)) return { opcode, payload: null, bad: true }; // 超大帧拒绝
    len = Number(big); off = 10;
  }
  if (!masked) return { opcode, payload: null, bad: true }; // 客户端必须 mask（RFC 6455）
  if (buf.length < off + 4) return null;
  const mask = buf.subarray(off, off + 4); off += 4;
  if (buf.length < off + len) return null;
  const payload = Buffer.alloc(len);
  for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ mask[i % 4];
  return { opcode, payload, consumed: off + len };
}

// ── WS 会话：cookie 认证（握手即校验）→ 连目标 VNC → 纯透传 ──
function handleUpgrade(req, socket, pathname) {
  if (pathname !== "/ws") { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  // 认证：请求 Cookie 里的 ui_env_vnc 会话（HMAC 签名 + 30min）——与 middleware 双保险
  if (!verifySession(parseCookie(req))) {
    socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.end();
    return;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");

  let wsClosed = false, tcp = null;

  const closeWs = () => { if (!wsClosed) { wsClosed = true; try { socket.end(); } catch {} if (tcp) { tcp.destroy(); tcp = null; } } };
  const sendWs = (b) => { if (!wsClosed) { try { socket.write(makeFrame(0x2, b)); } catch {} } };

  // 认证通过即连目标 VNC server（UI_ENV_VNC_HOST 可指外部主机，默认回环）；双向纯透传
  tcp = connect(RFB_PORT, RFB_HOST, () => {});
  tcp.on("data", (d) => { if (!wsClosed) sendWs(d); });
  tcp.on("error", () => closeWs());
  tcp.on("close", () => closeWs());

  let wsBuf = Buffer.alloc(0); // client→server WS 帧跨 chunk 缓冲
  socket.on("data", (chunk) => {
    wsBuf = Buffer.concat([wsBuf, chunk]);
    for (;;) {
      if (wsBuf.length < 2) return;
      const op = wsBuf[0] & 0x0f;
      const masked = (wsBuf[1] >> 7) & 1;
      let len = wsBuf[1] & 0x7f, off = 2;
      if (len === 126) { if (wsBuf.length < 4) return; len = wsBuf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (wsBuf.length < 10) return;
        const big = wsBuf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) { closeWs(); return; }
        len = Number(big); off = 10;
      }
      if (!masked) { closeWs(); return; } // 客户端必须 mask（RFC 6455）
      if (wsBuf.length < off + 4 + len) return; // 帧不完整：等下一段
      const mask = wsBuf.subarray(off, off + 4); off += 4;
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = wsBuf[off + i] ^ mask[i % 4];
      wsBuf = wsBuf.subarray(off + len);
      if (op === 0x8) { closeWs(); return; } // close
      if (op === 0x9) { try { socket.write(makeFrame(0xA, payload)); } catch {} continue; } // ping→pong
      if (op !== 0x2) continue; // 文本/其他帧忽略（RFB 走 binary）
      if (tcp) { try { tcp.write(payload); } catch {} } // binary payload：纯透传
    }
  });

  socket.on("error", closeWs);
  socket.on("close", closeWs);
  socket.on("end", closeWs);
}

// ── 入口 ──
if (!NOVNC_DIR || !existsSync(NOVNC_DIR)) {
  console.error("[vnc-bridge] NOVNC_DIR 不存在: " + NOVNC_DIR);
  process.exit(1);
}

const server = createServer((req, res) => {
  const pathname = new URL(req.url, "http://x").pathname;
  serveStatic(req, res, pathname);
});

server.on("upgrade", (req, socket) => {
  const pathname = new URL(req.url, "http://x").pathname;
  handleUpgrade(req, socket, pathname);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[vnc-bridge] 127.0.0.1:${PORT} （静态: ${NOVNC_DIR}；RFB→${RFB_HOST}:${RFB_PORT}；认证=ws cookie 会话；RFB 纯透传，密码由 VNC server 认证）`);
});
