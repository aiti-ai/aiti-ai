/**
 * aiti-devtools-core · pair 模块（方案 docs/aiti-bridge-pair-plan.md）
 *
 * 设备互连：临时聊天 / 互发消息 / 互传文件。pair 只管 **pair 设备**（连桥浏览器页面注册的
 * web peer）与 **文件中转暂存**；跨 kind 路由（agent/page 目标解析与投递）在 bridge.ts
 * 的 routePairSend——pair.ts 通过 deps 回调交付，不反向 import bridge（避免环）。
 *
 * 协议（REST，挂在 /bridge/pair/*；协议唯一来源 = 本文件 + bridge.ts routePairSend）：
 *   POST /bridge/pair/register        {peerId?, name, ua?} → {peerId, token}（peerId 已知则幂等复用）
 *   GET  /bridge/pair/devices         → {ok, devices}（统一设备视图；与 bridge_status MCP 同源 listDevices()）
 *   GET  /bridge/pair/events?peer&token → SSE（下行 envelope：text/file/devices/peer-join/peer-leave）
 *   POST /bridge/pair/message         {peer, token, to, text} → 跨 kind 投递（bridge routePairSend）
 *   POST /bridge/pair/file/init       {peer, token, to, name, size, mime?} → {fileId}
 *   POST /bridge/pair/file/chunk/<fileId>?n=<seq>  二进制 body（≤1MB/块，追加写）
 *   POST /bridge/pair/file/complete/<fileId>       校验收齐 → 投递 file-meta 给接收方
 *   GET  /bridge/pair/file/<fileId>?peer&token     接收方下载（流式；文件 TTL 到点清理）
 *   GET  /bridge/pair/inbox?peer&token           未读消息/待收文件（页面刷新/重连恢复用）
 *
 * 临时性：消息纯内存（web peer inbox 上限 200 条）；文件暂存 dataDir/aiti-bridge/pair-files/
 * （cache 语义：TTL 默认 1h 到点删除；不删"拉取即删"——半截下载不可恢复，宁可 TTL 兜底）。
 * peer 掉线超 PAIR_PEER_TTL 清理。所有清理挂桥既有 sweep（agentSweep），零新增定时器。
 */
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { mkdirSync, appendFileSync, existsSync, statSync, rmSync, unlinkSync, readdirSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";

const PAIR_PEER_TTL = parseInt(process.env.AITI_PAIR_PEER_TTL || "3600000", 10); // pair 设备掉线后保留（默认 1h，与 agent 同参）
const PAIR_FILE_TTL = parseInt(process.env.AITI_PAIR_FILE_TTL || "3600000", 10); // 中转文件暂存期（默认 1h）
const PAIR_FILE_MAX = parseInt(process.env.AITI_PAIR_FILE_MAX || String(200 * 1024 * 1024), 10); // 单文件上限（默认 200MB）
const CHUNK_MAX = 2 * 1024 * 1024; // 单块上限（客户端按 1MB 切；服务端放宽到 2MB 容错）
const INBOX_MAX = 200;

export function createPairModule(deps: {
  TAG: string;
  dataDir: string;
  cors: Record<string, string>;
  json: (body: unknown, status?: number, extraHeaders?: Record<string, string>) => Response;
  sseResponse: (onClose: () => void, opts?: { event?: string }) => { response: Response; writer: { write: (obj: unknown) => boolean }; cleanup: () => void };
  /** 统一设备视图（bridge.ts listDevices()：page/agent/pair 三类合并；含 pair 自己的行） */
  getDevices: () => any[];
  /** 跨 kind 投递（bridge.ts routePairSend）：to 解析 + agent/page/pair 分发；返回 {ok, delivered, candidates?, error?} */
  routeSend: (fromDev: { id: string; name: string }, to: string, payload: { text?: string; file?: Record<string, unknown> }) => { ok: boolean; delivered?: any[]; candidates?: any[]; error?: string };
}) {
  const { TAG, dataDir, cors, json, sseResponse } = deps;
  // ---------------- 状态 ----------------
  const peers = new Map(); // peerId -> { peerId, name, token, ua, lastSeen, writer, offlineAt, inbox:[{...env,status}] }
  const files = new Map(); // fileId -> { fileId, name, size, mime, from:{id,name}, to, path, bytes, status:'uploading'|'ready', at }
  const filesDir = dataDir ? join(dataDir, "aiti-bridge", "pair-files") : "";
  if (filesDir) { try { mkdirSync(filesDir, { recursive: true }); } catch {} }

  const genId = (p: string) => p + randomBytes(6).toString("hex");
  const safeName = (s: string) => String(s || "file").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "file";

  // ---- 上线门槛（pair 注册/事件订阅是写入面，外网默认挡）----
  // 实测：nginx 对 /api/extensions/aiti-devtools/ 段免 Authelia（历史水位），pair 不把注册面带到公网。
  // 默认：仅私网可上线（X-Real-IP 判内网段；直连桥无该头视为内网场景）；外网需
  //   AITI_PAIR_PUBLIC=1 显式全开，或 AITI_PAIR_TOKEN=<secret> + 请求带 token（档 B 注册 token）。
  const pairPublic = process.env.AITI_PAIR_PUBLIC === "1";
  const pairToken = process.env.AITI_PAIR_TOKEN || "";
  const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/;
  function gateAdmission(req: Request, regToken: string | null): Response | null {
    if (pairPublic) return null;
    // nginx Authelia 透传（auth_request_set remote-user；proxy_set_header 恒覆盖客户端伪造值，
    // 8777 仅 127.0.0.1 监听无绕过面）——已登录的外网手机/浏览器放行
    if ((req.headers.get("remote-user") || "").trim()) return null;
    const ip = (req.headers.get("x-real-ip") || "").trim();
    if (!ip || PRIVATE_IP.test(ip)) return null; // 直连（无头）或私网
    if (pairToken && regToken && regToken === pairToken) return null;
    return json({ ok: false, error: "pair 上线限内网（外网开放：过 Authelia / AITI_PAIR_PUBLIC=1 / AITI_PAIR_TOKEN+regToken）" }, 403);
  }

  function broadcastToPeers(env: any) {
    for (const [, p] of peers) {
      if (!p.writer) continue;
      if (!p.writer.write(env)) { p.writer = null; if (!p.offlineAt) p.offlineAt = Date.now(); }
    }
  }

  // ---------------- 注册 / 设备 ----------------
  function register(msg: any) {
    const now = Date.now();
    const name = safeName(String((msg && msg.name) || "")).slice(0, 40) || "设备";
    const pid = (msg && msg.peerId && String(msg.peerId)) || genId("p_");
    const dev = (msg && msg.device && typeof msg.device === "object") ? msg.device : null;
    const devLabel = dev ? [dev.browser || "?", dev.os || "", dev.screen || ""].filter(Boolean).join(" · ") : null;
    let p = peers.get(pid);
    if (!p) {
      if (devLabel) console.log(TAG + "   设备：" + devLabel + (dev && dev.lang ? " · " + dev.lang : ""));
      p = { peerId: pid, token: "t_" + randomBytes(18).toString("hex"), name, ua: String((msg && msg.ua) || "").slice(0, 200), device: dev, deviceLabel: devLabel, lastSeen: now, writer: null, offlineAt: null, inbox: [] };
      peers.set(pid, p);
      console.log(TAG + " pair 设备注册：" + name + " (" + pid + ")");
      broadcastToPeers({ type: "peer-join", peer: { id: pid, kind: "pair", name } });
      deps.getDevices().length; // 设备视图已变（join 广播已带全量触发客户端刷新）
    } else {
      p.name = name; p.lastSeen = now; p.offlineAt = null;
      if (msg && msg.ua) p.ua = String(msg.ua).slice(0, 200);
      if (dev) { p.device = dev; p.deviceLabel = devLabel; }
    }
    return { peerId: p.peerId, token: p.token, name: p.name };
  }

  function checkPeer(peerId: string, token: string) {
    const p = peers.get(String(peerId || ""));
    return p && p.token && token && p.token === String(token) ? p : null;
  }

  /** pair 设备行（统一设备视图的 pair 部分；bridge listDevices 合并用） */
  function listPeers() {
    const now = Date.now();
    return [...peers.values()].map((p) => ({
      kind: "pair", id: p.peerId, name: p.name, ua: p.ua || null, deviceLabel: p.deviceLabel || null,
      online: !!p.writer, offlineAt: p.offlineAt || null, lastSeen: p.lastSeen, pending: p.inbox.filter((m: any) => m.status === "pending").length,
      _now: now,
    })).map(({ _now, ...row }) => row);
  }

  // ---------------- 投递（pair 目标；bridge routeSend 的 pair 分支调） ----------------
  function deliverToPeer(peerId: string, env: any) {
    const p = peers.get(String(peerId || ""));
    if (!p) return false;
    const rec = { ...env, status: "pending" };
    p.inbox.push(rec);
    if (p.inbox.length > INBOX_MAX) p.inbox.splice(0, p.inbox.length - INBOX_MAX);
    if (p.writer && p.writer.write(env)) { rec.status = "delivered"; }
    return true;
  }

  function resolvePeerFuzzy(to: string) {
    const q = String(to || "").trim();
    if (!q) return { none: true };
    const list = [...peers.values()];
    if (peers.has(q)) return { hit: peers.get(q) };
    const byName = list.filter((p) => p.name === q);
    if (byName.length === 1) return { hit: byName[0] };
    const fuzzy = list.filter((p) => (p.name || "").includes(q) || p.peerId.includes(q));
    if (fuzzy.length === 1) return { hit: fuzzy[0] };
    if (fuzzy.length > 1) return { multiple: fuzzy.map((p) => ({ kind: "pair", id: p.peerId, name: p.name })) };
    return { none: true };
  }

  // ---------------- 文件中转 ----------------
  function fileInit(from: { id: string; name: string }, to: string, name: string, size: number, mime: string) {
    if (!filesDir) return { error: "桥未配置 dataDir（文件中转不可用）" };
    if (!size || size <= 0) return { error: "bad size" };
    if (size > PAIR_FILE_MAX) return { error: "文件超过上限 " + Math.round(PAIR_FILE_MAX / 1024 / 1024) + "MB" };
    const fileId = genId("f_");
    const path = join(filesDir, fileId);
    const rec = { fileId, name: safeName(name), size, mime: String(mime || "application/octet-stream").slice(0, 100), from, to: String(to || ""), path, bytes: 0, status: "uploading", at: Date.now() };
    try { rmSync(path, { force: true }); } catch {}
    files.set(fileId, rec);
    return { fileId, name: rec.name, size, chunkMax: CHUNK_MAX };
  }

  function fileChunk(fileId: string, buf: Buffer) {
    const f = files.get(String(fileId || ""));
    if (!f) return { error: "unknown fileId" };
    if (f.status !== "uploading") return { error: "upload already completed" };
    if (!buf || !buf.length) return { error: "empty chunk" };
    if (buf.length > CHUNK_MAX) return { error: "chunk too large (≤" + CHUNK_MAX + "B)" };
    if (f.bytes + buf.length > f.size) return { error: "exceeds declared size" };
    try {
      appendFileSync(f.path, buf);
      f.bytes += buf.length;
      return { ok: true, bytes: f.bytes };
    } catch (e: any) {
      return { error: String((e && e.message) || e) };
    }
  }

  function fileComplete(fileId: string) {
    const f = files.get(String(fileId || ""));
    if (!f) return { error: "unknown fileId" };
    if (f.status !== "uploading") return { ok: true, file: publicFile(f) };
    if (f.bytes !== f.size) return { error: "size mismatch（已收 " + f.bytes + "/" + f.size + "B，补传缺失块后再 complete）" };
    f.status = "ready";
    return { ok: true, file: publicFile(f) };
  }

  const publicFile = (f: any) => ({ fileId: f.fileId, name: f.name, size: f.size, mime: f.mime, from: f.from, to: f.to, at: f.at });

  function fileDownload(p: { peerId: string; name: string } | null, fileId: string): Response {
    if (!p) return json({ ok: false, error: "bad peer/token" }, 401);
    const f = files.get(String(fileId || ""));
    if (!f) return json({ ok: false, error: "unknown fileId" }, 404);
    if (f.status !== "ready") return json({ ok: false, error: "file not ready" }, 409);
    // 接收方校验：声明 to 命中该 peer（peerId 或设备名；to="all" 或为空放行任意已注册 peer）
    if (f.to && f.to !== "all" && f.to !== p.peerId && f.to !== p.name) return json({ ok: false, error: "not the receiver" }, 403);
    if (!existsSync(f.path)) return json({ ok: false, error: "file expired" }, 410);
    let stream: ReadableStream;
    try {
      stream = Readable.toWeb(createReadStream(f.path)) as unknown as ReadableStream;
    } catch (e: any) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
    return new Response(stream, {
      headers: {
        ...cors,
        "content-type": f.mime || "application/octet-stream",
        "content-length": String(f.size),
        "cache-control": "no-store",
        "content-disposition": "attachment; filename=\"pair-" + f.fileId.slice(2, 10) + "\"; filename*=UTF-8''" + encodeURIComponent(f.name),
      },
    });
  }

  function getFileInfo(fileId: string) {
    const f = files.get(String(fileId || ""));
    return f ? { ...publicFile(f), path: f.path, status: f.status } : null;
  }

  /** aiti_pair_fetch 落盘：复制/移动到 pair-inbox 目录（异步流拷贝，避免大文件同步读） */
  async function fetchToFile(fileId: string, savePath: string | null) {
    const f = files.get(String(fileId || ""));
    if (!f) return { error: "unknown fileId" };
    if (f.status !== "ready") return { error: "file not ready" };
    if (!existsSync(f.path)) return { error: "file expired" };
    if (!savePath) {
      // 缺省落点：dataDir/aiti-bridge/pair-inbox/<safeName>（agent 可直接读的稳定路径）
      const dir = join(dataDir, "aiti-bridge", "pair-inbox");
      try { mkdirSync(dir, { recursive: true }); } catch (e: any) { return { error: String((e && e.message) || e) }; }
      const dest = join(dir, safeName(f.name));
      try { if (existsSync(dest)) unlinkSync(dest); await (await import("node:fs/promises")).copyFile(f.path, dest); } catch (e: any) { return { error: String((e && e.message) || e) }; }
      return { ok: true, path: dest, name: f.name, size: f.size };
    }
    try {
      const { copyFile, mkdir } = await import("node:fs/promises");
      await mkdir(dirname(savePath), { recursive: true });
      await copyFile(f.path, savePath);
    } catch (e: any) {
      return { error: String((e && e.message) || e) };
    }
    return { ok: true, path: savePath, name: f.name, size: f.size };
  }

  // ---------------- 清理（挂桥 agentSweep，零新增定时器） ----------------
  function sweep(now: number) {
    for (const [pid, p] of [...peers]) {
      if (p.writer) { p.offlineAt = null; continue; }
      if (now - p.lastSeen <= 120000) continue; // 2min 宽限（无流短连接轮询场景）
      if (!p.offlineAt) p.offlineAt = p.lastSeen;
      if (now - p.offlineAt > PAIR_PEER_TTL) {
        console.log(TAG + " pair 设备清理（掉线超时）：" + p.name + " (" + pid + ")");
        peers.delete(pid);
        broadcastToPeers({ type: "peer-leave", peer: { id: pid, name: p.name } });
      }
    }
    if (filesDir) {
      for (const [fid, f] of [...files]) {
        if (now - f.at > PAIR_FILE_TTL) {
          try { rmSync(f.path, { force: true }); } catch {}
          files.delete(fid);
        }
      }
      // 目录兜底：registry 丢失/进程重启残留的孤儿文件（mtime 超 TTL 即删）
      try {
        if (existsSync(filesDir)) {
          for (const name of readdirSync(filesDir)) {
            try {
              const p = join(filesDir, name);
              if (statSync(p).isFile() && now - statSync(p).mtimeMs > PAIR_FILE_TTL) { rmSync(p, { force: true }); files.delete(name); }
            } catch {}
          }
        }
      } catch {}
    }
  }

  // ---------------- HTTP 路由 ----------------
  async function handle(req: Request, path: string[], searchParams: URLSearchParams): Promise<Response | null> {
    // path 已剥 /aiti/ 前缀；path[0]="bridge" path[1]="pair" 才进来
    const seg = path.slice(2); // pair 之后的段
    const method = req.method;

    // POST /bridge/pair/register
    if (seg[0] === "register" && method === "POST") {
      const msg = await req.json().catch(() => null);
      const denied = gateAdmission(req, (msg && msg.regToken) || null);
      if (denied) return denied;
      const r = register(msg);
      return json({ ok: true, ...r });
    }

    // GET /bridge/pair/devices
    if (seg[0] === "devices" && method === "GET") {
      return json({ ok: true, devices: deps.getDevices() });
    }

    // GET /bridge/pair/events?peer=&token=[&reg=] —— SSE
    if (seg[0] === "events" && method === "GET") {
      const denied = gateAdmission(req, searchParams.get("reg"));
      if (denied) return denied;
      const p = checkPeer(searchParams.get("peer"), searchParams.get("token"));
      if (!p) return json({ ok: false, error: "bad peer/token" }, 401);
      const { response, writer, cleanup } = sseResponse(() => {
        if (p.writer === writer) { p.writer = null; if (!p.offlineAt) p.offlineAt = Date.now(); }
        cleanup();
      });
      p.writer = writer;
      p.lastSeen = Date.now();
      p.offlineAt = null;
      writer.write({ type: "ready", peerId: p.peerId, name: p.name });
      return response;
    }

    // POST /bridge/pair/message {peer, token, to, text}
    if (seg[0] === "message" && method === "POST") {
      const msg = await req.json().catch(() => null);
      const p = checkPeer(msg && msg.peer, msg && msg.token);
      if (!p) return json({ ok: false, error: "bad peer/token" }, 401);
      const text = String((msg && msg.text) || "").slice(0, 64000);
      if (!text.trim()) return json({ ok: false, error: "bad request（需要 text）" }, 400);
      const r = deps.routeSend({ id: p.peerId, name: p.name }, String((msg && msg.to) || "all"), { text });
      return json(r, r.ok ? 200 : (r.candidates ? 300 : 400));
    }

    // 文件族：/bridge/pair/file/*
    if (seg[0] === "file") {
      if (seg[1] === "init" && method === "POST") {
        const msg = await req.json().catch(() => null);
        const p = checkPeer(msg && msg.peer, msg && msg.token);
        if (!p) return json({ ok: false, error: "bad peer/token" }, 401);
        const r = fileInit({ id: p.peerId, name: p.name }, String((msg && msg.to) || ""), String((msg && msg.name) || ""), Number((msg && msg.size) || 0), String((msg && msg.mime) || ""));
        return r.error ? json({ ok: false, error: r.error }, 400) : json({ ok: true, ...r });
      }
      if (seg[1] === "chunk" && method === "POST") {
        const fileId = String(seg[2] || "");
        const buf = Buffer.from(await req.arrayBuffer());
        const r = fileChunk(fileId, buf);
        return r.ok ? json(r) : json(r, 400);
      }
      if (seg[1] === "complete" && method === "POST") {
        const fileId = String(seg[2] || "");
        const r = fileComplete(fileId);
        if (!r.ok) return json(r, 400);
        // 投递 file-meta 给接收方（跨 kind 路由在 bridge）
        const f = getFileInfo(fileId);
        deps.routeSend(f.from, f.to || "all", { file: { fileId: f.fileId, name: f.name, size: f.size, mime: f.mime, from: f.from, fromName: f.from.name } });
        return json(r);
      }
      // GET /bridge/pair/file/<fileId>?peer=&token=
      if (seg.length === 2 && method === "GET") {
        return fileDownload(checkPeer(searchParams.get("peer"), searchParams.get("token")), String(seg[1] || ""));
      }
    }

    // GET /bridge/pair/inbox?peer=&token=
    if (seg[0] === "inbox" && method === "GET") {
      const p = checkPeer(searchParams.get("peer"), searchParams.get("token"));
      if (!p) return json({ ok: false, error: "bad peer/token" }, 401);
      p.lastSeen = Date.now();
      const pending = p.inbox.filter((m: any) => m.status === "pending");
      for (const m of pending) m.status = "delivered";
      return json({ ok: true, peerId: p.peerId, name: p.name, pending: pending.map(({ status, ...m }: any) => m) });
    }

    return null;
  }

  return { handle, listPeers, deliverToPeer, resolvePeerFuzzy, register, checkPeer, fileInit, fileChunk, fileComplete, fileDownload, getFileInfo, fetchToFile, sweep, close: () => { peers.clear(); files.clear(); } };
}
