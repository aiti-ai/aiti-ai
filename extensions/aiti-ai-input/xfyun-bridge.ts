/**
 * 讯飞真流式桥 —— **扩展进程内**的轻量 WS 服务（不起子进程，不装依赖）
 *
 * 为什么需要它：pi-web 扩展只有 startup/shutdown/api/middleware 四个钩子，**不能自己终止 WebSocket**
 * （middleware 只能返回 x-middleware-rewrite 把升级请求转给上游）。所以云引擎要真流式，就在扩展进程内
 * 起一个 http server 监听 127.0.0.1:<port>，middleware 把客户端 WS rewrite 过来，本模块负责
 * HMAC 签名 + PCM 转发讯飞 iat WSS，并把结果按客户端 /ws/vad 协议回传。
 *
 * 协议（与自建 8767 的 /ws/vad 完全一致，客户端零改动）：
 *   C→S: 文本帧 {type:"init", ws?} / {type:"stop"} / {type:"reset"}；二进制帧 = Int16 PCM 16k 单声道
 *   S→C: {type:"ready"} / {type:"seg_quick", idx, quick} / {type:"seg_refined", idx, refined}
 *        / {type:"done", segments:[{quick, refined}]} / {type:"error", message}
 *
 * 生命周期：本模块随扩展加载；server 挂在 globalThis 上——扩展 reload 后新模块实例直接复用旧监听器
 * （不重复 listen，也不留孤儿进程）。凭据在**每条会话建立时**读取，改 key 即时生效，无需重启。
 */
import { createServer, type Server } from "node:http";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordUsage, setUsageDirFromConfig } from "./asr-usage.ts";

const XF_HOST = "iat-api.xfyun.cn";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const AUDIO_FRAME = 1280;   // 40ms @16k/16bit —— 讯飞要求 40ms/帧，客户端的分块在此切片

interface BridgeState {
  server: Server;
  port: number;            // 实际端口（随机分配）
  configPath: string;
  startedAt: number;
  version: number;         // 代码版本：reload 后旧监听器若版本落后则重建（否则一直跑旧逻辑）
}
const BRIDGE_VERSION = 2;
const BRIDGE_KEY = "__aitiXfBridge";

// ---------------------------------------------------------------- 凭据（每条会话读一次）

function xfCreds(configPath: string): { appId: string; apiKey: string; apiSecret: string } {
  const p = configPath || join(homedir(), ".pi", "web", "data", "aiti-ai-input", "config", "asr-config.json");
  try {
    const cfg = JSON.parse(readFileSync(p, "utf8") || "{}") as {
      providers?: Record<string, Record<string, unknown>>;
    };
    const x = cfg.providers?.xfyun || {};
    return {
      appId: String(x.appId || "").trim(),
      apiKey: String(x.apiKey || "").trim(),
      apiSecret: String(x.apiSecret || "").trim(),
    };
  } catch { return { appId: "", apiKey: "", apiSecret: "" }; }
}

function xfUrl(apiKey: string, apiSecret: string): string {
  const date = new Date().toUTCString();
  const sig = createHmac("sha256", apiSecret)
    .update(`host: ${XF_HOST}\ndate: ${date}\nGET /v2/iat HTTP/1.1`).digest("base64");
  const auth = Buffer.from(`api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`).toString("base64");
  return `wss://${XF_HOST}/v2/iat?authorization=${encodeURIComponent(auth)}&date=${encodeURIComponent(date)}&host=${encodeURIComponent(XF_HOST)}`;
}

// ---------------------------------------------------------------- 手写 WebSocket 服务端

function encodeFrame(opcode: number, data: Buffer): Buffer {
  const len = data.length;
  let head: Buffer;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, data]);
}

/** 从缓冲解出若干帧，返回剩余缓冲（小帧场景，忽略跨包分片续接） */
function decodeFrames(buf: Buffer, onFrame: (opcode: number, payload: Buffer) => void): Buffer {
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let mask: Buffer | null = null;
    if (masked) { if (p + 4 > buf.length) break; mask = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    p += len;
    off = p;
    if (!fin) continue;
    onFrame(opcode, payload);
  }
  return buf.subarray(off);
}

function sendJson(sock: { write: (b: Buffer) => void }, obj: unknown): void {
  try { sock.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"))); } catch { /* 已断开 */ }
}

// ---------------------------------------------------------------- 一条录音会话 = 一条讯飞 WSS

function startSession(sock: { write: (b: Buffer) => void }, appId: string, apiKey: string, apiSecret: string) {
  let up: WebSocket;
  try { up = new WebSocket(xfUrl(apiKey, apiSecret)); } catch (e) {
    sendJson(sock, { type: "error", message: String((e as Error)?.message || e) });
    return null;
  }
  const st = {
    open: false, done: false, closed: false, pendingStop: false, sent: 0,
    idx: 0, buf: "", base: "", segs: [] as Array<{ quick: string; refined: string }>,
    queue: [] as Buffer[], carry: Buffer.alloc(0), pcmBytes: 0, counted: false,
  };
  // 每条会话结束时记 1 次用量（真流式口径：时长按累计 PCM 字节折算 16k/16bit）
  const countOnce = (ok: boolean) => {
    if (st.counted) return;
    st.counted = true;
    try { recordUsage({ provider: "xfyun", mode: "vad", seconds: st.pcmBytes / 32000, ok }); } catch { /* ignore */ }
  };

  const frame = (status: number, audioB64: string) => JSON.stringify({
    common: { app_id: appId },
    business: { language: "zh_cn", domain: "iat", accent: "mandarin", vad_eos: 10000 },
    data: { status, format: "audio/L16;rate=16000", encoding: "raw", audio: audioB64 },
  });

  up.onopen = () => {
    st.open = true;
    sendJson(sock, { type: "ready" });
    for (const c of st.queue) { up.send(frame(st.sent++ === 0 ? 0 : 1, c.toString("base64"))); }
    st.queue.length = 0;
    if (st.pendingStop) up.send(frame(2, ""));
  };

  const push = (pcm: Buffer) => {
    if (st.open) up.send(frame(st.sent++ === 0 ? 0 : 1, pcm.toString("base64")));
    else if (st.queue.length < 2000) st.queue.push(pcm);   // 建连未完成时的积压上限（防内存涨）
  };
  const flush = () => {
    st.carry = st.carry.length ? st.carry : Buffer.alloc(0);
    while (st.carry.length >= AUDIO_FRAME) {
      push(Buffer.from(st.carry.subarray(0, AUDIO_FRAME)));
      st.carry = Buffer.from(st.carry.subarray(AUDIO_FRAME));
    }
  };

  up.onmessage = (ev: MessageEvent) => {
    let m: { code?: number; message?: string; data?: { status?: number; ls?: boolean; result?: { pgs?: string; ws?: Array<{ cw?: Array<{ w?: string }> }> } } };
    try { m = JSON.parse(String(ev.data)); } catch { return; }
    if (m.code !== 0) { countOnce(false); sendJson(sock, { type: "error", message: `${m.code} ${m.message || ""}`.trim() }); return; }
    const d = m.data || {};
    const text = (d.result?.ws || []).map((w) => (w.cw || []).map((c) => c.w || "").join("")).join("");
    // pgs：apd=追加 / rpl=替换上一段；实测大量帧不带该字段 → 按追加处理
    if (d.result?.pgs === "rpl") st.buf = st.base + text;
    else { st.base = st.buf; st.buf += text; }
    if (st.buf) sendJson(sock, { type: "seg_quick", idx: st.idx, quick: st.buf });
    const segEnd = d.ls === true;                          // 讯飞 VAD 判定该句结束
    if (segEnd && st.buf) {
      sendJson(sock, { type: "seg_refined", idx: st.idx, refined: st.buf });
      st.segs[st.idx] = { quick: st.buf, refined: st.buf };
      st.idx++; st.buf = ""; st.base = "";
    }
    if (d.status === 2) {
      if (st.buf) { sendJson(sock, { type: "seg_refined", idx: st.idx, refined: st.buf }); st.segs[st.idx] = { quick: st.buf, refined: st.buf }; st.idx++; st.buf = ""; st.base = ""; }
      if (!st.done) { st.done = true; countOnce(true); sendJson(sock, { type: "done", segments: st.segs.filter(Boolean) }); }
      try { up.close(); } catch { /* ignore */ }
    }
  };
  up.onerror = () => { if (!st.done) sendJson(sock, { type: "error", message: "讯飞连接错误（网络/鉴权）" }); };
  up.onclose = () => {
    st.open = false;
    if (!st.done && !st.closed) {
      st.done = true;
      if (st.buf) st.segs[st.idx] = { quick: st.buf, refined: st.buf };
      countOnce(true);
      sendJson(sock, { type: "done", segments: st.segs.filter(Boolean) });
    }
  };

  return {
    audio(pcm: Buffer) { st.pcmBytes += pcm.length; st.carry = st.carry.length ? Buffer.concat([st.carry, pcm]) : Buffer.from(pcm); flush(); },
    stop() {
      if (st.carry.length) { push(Buffer.from(st.carry)); st.carry = Buffer.alloc(0); }
      if (st.open) up.send(frame(2, "")); else st.pendingStop = true;
    },
    abort() { st.closed = true; try { up.close(); } catch { /* ignore */ } },
  };
}

// ---------------------------------------------------------------- 服务（进程内单实例）

export function xfBridgePort(): number {
  const s = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as BridgeState | undefined;
  return s?.port || 0;
}

/**
 * 确保桥在跑（幂等）。**端口随机**（listen(0) → 系统分配空闲端口）：每个 pi-web 实例各起各的桥，
 * 天然不存在「dev/prod 抢同一个端口」的问题，也不需要跨实例共享。
 * 实际端口从返回值取（或 xfBridgePort()），middleware 必须用实际端口而非常量。
 * 需要固定端口时（调试/防火墙）设 env AITI_XF_BRIDGE_PORT 或传 o.port。
 */
export async function ensureXfBridge(o: { port?: number; configPath?: string }): Promise<{ ok: boolean; port: number; error?: string; reused?: boolean }> {
  const want = Number(o.port || process.env.AITI_XF_BRIDGE_PORT || 0);   // 0 = 随机
  const configPath = o.configPath || join(homedir(), ".pi", "web", "data", "aiti-ai-input", "config", "asr-config.json");
  const prev = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as BridgeState | undefined;
  // 版本落后（reload 后旧代码实例）→ 关掉重建，避免一直跑旧逻辑（如漏记用量）
  if (prev?.server?.listening && prev.version !== BRIDGE_VERSION) {
    try { prev.server.close(); } catch { /* ignore */ }
    try { delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]; } catch { /* ignore */ }
  }
  if (prev?.server?.listening && prev.version === BRIDGE_VERSION) {
    prev.configPath = configPath;
    setUsageDirFromConfig(configPath);                 // reload 后复用旧监听器，只换配置路径
    return { ok: true, port: prev.port, reused: true };
  }

  const server = createServer((req, res) => {
    if ((req.url || "").startsWith("/health")) {
      const s = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as BridgeState | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, bridge: "xfyun", uptime: s ? Math.round((Date.now() - s.startedAt) / 1000) : 0 }));
      return;
    }
    res.writeHead(404); res.end("not found");
  });

  server.on("upgrade", (req, sock) => {
    const state = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as BridgeState | undefined;
    const key = req.headers["sec-websocket-key"];
    if (!key) { try { sock.destroy(); } catch { /* ignore */ } return; }
    const accept = createHash("sha1").update(String(key) + WS_GUID).digest("base64");
    try {
      sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      sock.setNoDelay(true);
    } catch { return; }
    let buf = Buffer.alloc(0);
    let sess: ReturnType<typeof startSession> | null = null;
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      buf = decodeFrames(buf, (opcode, payload) => {
        if (opcode === 0x8) { try { sess?.abort(); } catch { /* ignore */ } try { sock.end(); } catch { /* ignore */ } return; }
        if (opcode === 0x9) { try { sock.write(encodeFrame(0xA, payload)); } catch { /* ignore */ } return; }
        if (opcode === 0x2) {                                   // 二进制：PCM
          if (!sess) {
            const c = xfCreds(state?.configPath || "");
            if (!c.appId || !c.apiKey || !c.apiSecret) { sendJson(sock, { type: "error", message: "桥未读到讯飞凭据（POST /asr/config 配置）" }); return; }
            sess = startSession(sock, c.appId, c.apiKey, c.apiSecret);
          }
          sess?.audio(payload);
          return;
        }
        if (opcode === 0x1) {                                   // 文本：控制帧
          let m: { type?: string } | null = null;
          try { m = JSON.parse(payload.toString("utf8")); } catch { return; }
          if (m?.type === "stop") { if (sess) sess.stop(); else sendJson(sock, { type: "done", segments: [] }); }
          else if (m?.type === "reset") { try { sess?.abort(); } catch { /* ignore */ } sess = null; sendJson(sock, { type: "done", segments: [] }); }
          // init：忽略（本桥不做 workspace 热词）
        }
      });
    });
    sock.on("error", () => { try { sess?.abort(); } catch { /* ignore */ } });
    sock.on("close", () => { try { sess?.abort(); } catch { /* ignore */ } });
  });

  const ok = await new Promise<boolean>((resolve) => {
    const onErr = (e: NodeJS.ErrnoException) => {
      try { console.warn(`[aiti-ai-input] 讯飞桥监听失败：${e?.code || e?.message || e}`); } catch { /* ignore */ }
      resolve(false);
    };
    server.once("error", onErr);
    server.listen(want, "127.0.0.1", () => { server.off("error", onErr); resolve(true); });
  });
  if (!ok) { try { server.close(); } catch { /* ignore */ } return { ok: false, port: want, error: `监听失败（端口 ${want || "随机"}）` }; }

  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : want;
  const s: BridgeState = { server, port, configPath, startedAt: Date.now(), version: BRIDGE_VERSION };
  (globalThis as Record<string, unknown>)[BRIDGE_KEY] = s;
  try { console.log(`[aiti-ai-input] 讯飞真流式桥就绪 ws://127.0.0.1:${port}`); } catch { /* ignore */ }
  return { ok: true, port };
}

/** 关闭桥（端口换/扩展停用时用；reload 场景建议复用而非关闭）。 */
export function stopXfBridge(): void {
  const s = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as BridgeState | undefined;
  if (!s) return;
  try { s.server.close(); } catch { /* ignore */ }
  try { delete (globalThis as Record<string, unknown>)[BRIDGE_KEY]; } catch { /* ignore */ }
}
