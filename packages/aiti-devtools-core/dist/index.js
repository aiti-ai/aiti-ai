// src/bridge.ts
import { randomBytes as randomBytes2, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync as mkdirSync2, appendFileSync as appendFileSync2, readdirSync as readdirSync2, readFileSync, existsSync as existsSync2, statSync as statSync2, rmSync as rmSync2, writeFileSync, renameSync, openSync, readSync, closeSync } from "node:fs";
import { join as join2, dirname as dirname2 } from "node:path";

// src/pair.ts
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { mkdirSync, appendFileSync, existsSync, statSync, rmSync, unlinkSync, readdirSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
var PAIR_PEER_TTL = parseInt(process.env.AITI_PAIR_PEER_TTL || "3600000", 10);
var PAIR_FILE_TTL = parseInt(process.env.AITI_PAIR_FILE_TTL || "3600000", 10);
var PAIR_FILE_MAX = parseInt(process.env.AITI_PAIR_FILE_MAX || String(200 * 1024 * 1024), 10);
var CHUNK_MAX = 2 * 1024 * 1024;
var INBOX_MAX = 200;
function createPairModule(deps) {
  const { TAG, dataDir, cors, json, sseResponse, validateInstance } = deps;
  const peers = /* @__PURE__ */ new Map();
  const names = /* @__PURE__ */ new Map();
  const pageInbox = /* @__PURE__ */ new Map();
  const files = /* @__PURE__ */ new Map();
  const filesDir = dataDir ? join(dataDir, "aiti-bridge", "pair-files") : "";
  if (filesDir) {
    try {
      mkdirSync(filesDir, { recursive: true });
    } catch {
    }
  }
  const genId = (p) => p + randomBytes(6).toString("hex");
  const safeName = (s) => String(s || "file").replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "file";
  const iidOf = (s) => String(s || "").split("/")[0];
  const pairPublic = process.env.AITI_PAIR_PUBLIC === "1";
  const pairToken = process.env.AITI_PAIR_TOKEN || "";
  const PRIVATE_IP = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/;
  function gateAdmission(req, regToken) {
    if (pairPublic) return null;
    if ((req.headers.get("remote-user") || "").trim()) return null;
    const ip = (req.headers.get("x-real-ip") || "").trim();
    if (!ip || PRIVATE_IP.test(ip)) return null;
    if (pairToken && regToken && regToken === pairToken) return null;
    return json({ ok: false, error: "pair pairing is restricted to the private network (exposing it publicly: behind Authelia / AITI_PAIR_PUBLIC=1 / AITI_PAIR_TOKEN+regToken)" }, 403);
  }
  function broadcastToPeers(env) {
    for (const [, p] of peers) {
      if (!p.writer) continue;
      if (!p.writer.write(env)) {
        p.writer = null;
        if (!p.offlineAt) p.offlineAt = Date.now();
      }
    }
  }
  const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/;
  function clientIp(req) {
    const real = (req.headers.get("x-real-ip") || "").trim();
    if (real) return real;
    const xff = (req.headers.get("x-forwarded-for") || "").trim();
    if (xff) return xff.split(",")[0].trim() || null;
    return null;
  }
  function register(msg, meta) {
    const now = Date.now();
    const name = safeName(String(msg && msg.name || "")).slice(0, 40) || "Device";
    const pid = msg && msg.peerId && String(msg.peerId) || genId("p_");
    const dev = msg && msg.device && typeof msg.device === "object" ? msg.device : null;
    const devLabel = dev ? [dev.browser || "?", dev.os || "", dev.screen || ""].filter(Boolean).join(" \xB7 ") : null;
    let p = peers.get(pid);
    if (!p) {
      if (devLabel) console.log(TAG + "   device: " + devLabel + (dev && dev.lang ? " \xB7 " + dev.lang : ""));
      p = { peerId: pid, token: "t_" + randomBytes(18).toString("hex"), name, ua: String(msg && msg.ua || "").slice(0, 200), device: dev, deviceLabel: devLabel, lastSeen: now, writer: null, offlineAt: null, inbox: [], ip: meta && meta.ip || null, regAt: now };
      peers.set(pid, p);
      console.log(TAG + " pair device registered: " + name + " (" + pid + ")" + (p.ip ? " @ " + p.ip : ""));
      broadcastToPeers({ type: "peer-join", peer: { id: pid, kind: "pair", name } });
      deps.getDevices().length;
    } else {
      p.name = name;
      p.lastSeen = now;
      p.offlineAt = null;
      if (msg && msg.ua) p.ua = String(msg.ua).slice(0, 200);
      if (dev) {
        p.device = dev;
        p.deviceLabel = devLabel;
      }
      if (meta && meta.ip) p.ip = meta.ip;
    }
    return { peerId: p.peerId, token: p.token, name: p.name };
  }
  function pageIdentity(msg) {
    const iid = String(msg && msg.instanceId || "");
    if (!iid || !validateInstance(iid)) return null;
    const pageId = String(msg && msg.pageId || "") || iid + "/host";
    const named = names.get(iidOf(pageId));
    const self = deps.getDevices().filter((d) => d.instanceId === iid || d.id === pageId || d.id === iid)[0];
    const name = String(msg && msg.name || named && named.name || self && self.name || pageId).slice(0, 80);
    return { id: pageId, name, kind: "page" };
  }
  function checkPeer(peerId, token) {
    const p = peers.get(String(peerId || ""));
    return p && p.token && token && p.token === String(token) ? p : null;
  }
  function notePageInbox(iid, env) {
    const key = iidOf(iid);
    if (!key) return;
    let box = pageInbox.get(key);
    if (!box) {
      box = { seq: 0, items: [] };
      pageInbox.set(key, box);
    }
    box.seq += 1;
    box.items.push({ seq: box.seq, env });
    if (box.items.length > 100) box.items.splice(0, box.items.length - 100);
  }
  function pullPageInbox(iid, since) {
    const box = pageInbox.get(iidOf(iid));
    if (!box) return { ok: true, seq: since || 0, items: [] };
    const items = box.items.filter((it) => it.seq > (since || 0)).map((it) => ({ seq: it.seq, env: it.env }));
    return { ok: true, seq: box.seq, items };
  }
  function listPeers() {
    const now = Date.now();
    return [...peers.values()].map((p) => {
      const stale = !p.writer && now - p.lastSeen >= 12e4;
      return {
        kind: "pair",
        id: p.peerId,
        name: p.name,
        ua: p.ua || null,
        deviceLabel: p.deviceLabel || null,
        online: !stale && !p.offlineAt,
        offlineAt: stale || p.offlineAt ? p.offlineAt || p.lastSeen : null,
        lastSeen: p.lastSeen,
        ip: p.ip || null,
        pending: p.inbox.filter((m) => m.status === "pending").length
      };
    });
  }
  function nameFor(instanceId) {
    const n = names.get(iidOf(instanceId));
    return n ? n.name : null;
  }
  function setName(instanceId, name) {
    const iid = iidOf(instanceId);
    if (!iid || !validateInstance(iid)) return { ok: false, error: "bad instanceId" };
    const clean = String(name || "").trim().slice(0, 40);
    if (!clean) return { ok: false, error: "bad name" };
    names.set(iid, { name: clean, at: Date.now() });
    console.log(TAG + " pair page renamed: " + iid + " \u2192 " + clean);
    return { ok: true, name: clean };
  }
  function deliverToPeer(peerId, env) {
    const p = peers.get(String(peerId || ""));
    if (!p) return false;
    const rec = { ...env, status: "pending" };
    p.inbox.push(rec);
    if (p.inbox.length > INBOX_MAX) p.inbox.splice(0, p.inbox.length - INBOX_MAX);
    if (p.writer && p.writer.write(env)) {
      rec.status = "delivered";
    }
    return true;
  }
  function resolvePeerFuzzy(to) {
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
  function fileInit(from, to, name, size, mime) {
    if (!filesDir) return { error: "bridge has no dataDir configured (file relay unavailable)" };
    if (!size || size <= 0) return { error: "bad size" };
    if (size > PAIR_FILE_MAX) return { error: "file exceeds the " + Math.round(PAIR_FILE_MAX / 1024 / 1024) + "MB cap" };
    const fileId = genId("f_");
    const path = join(filesDir, fileId);
    const rec = { fileId, name: safeName(name), size, mime: String(mime || "application/octet-stream").slice(0, 100), from, to: String(to || ""), path, bytes: 0, status: "uploading", at: Date.now() };
    try {
      rmSync(path, { force: true });
    } catch {
    }
    files.set(fileId, rec);
    return { fileId, name: rec.name, size, chunkMax: CHUNK_MAX };
  }
  function fileChunk(fileId, buf) {
    const f = files.get(String(fileId || ""));
    if (!f) return { error: "unknown fileId" };
    if (f.status !== "uploading") return { error: "upload already completed" };
    if (!buf || !buf.length) return { error: "empty chunk" };
    if (buf.length > CHUNK_MAX) return { error: "chunk too large (\u2264" + CHUNK_MAX + "B)" };
    if (f.bytes + buf.length > f.size) return { error: "exceeds declared size" };
    try {
      appendFileSync(f.path, buf);
      f.bytes += buf.length;
      return { ok: true, bytes: f.bytes };
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  }
  function fileComplete(fileId) {
    const f = files.get(String(fileId || ""));
    if (!f) return { error: "unknown fileId" };
    if (f.status !== "uploading") return { ok: true, file: publicFile(f) };
    if (f.bytes !== f.size) return { error: "size mismatch (received " + f.bytes + "/" + f.size + "B; re-upload the missing chunks before complete)" };
    f.status = "ready";
    return { ok: true, file: publicFile(f) };
  }
  const publicFile = (f) => ({ fileId: f.fileId, name: f.name, size: f.size, mime: f.mime, from: f.from, to: f.to, at: f.at });
  function fileDownload(auth, fileId, peerAuth) {
    const peer = peerAuth ? checkPeer(String(peerAuth.peerId || ""), String(peerAuth.token || "")) : null;
    if (!peer && (!auth || !validateInstance(iidOf(auth.instanceId)))) return json({ ok: false, error: "bad instanceId" }, 401);
    const f = files.get(String(fileId || ""));
    if (!f) return json({ ok: false, error: "unknown fileId" }, 404);
    if (f.status !== "ready") return json({ ok: false, error: "file not ready" }, 409);
    if (peer) {
      const okTo = !f.to || f.to === "all" || f.to === peer.peerId || f.to === peer.name;
      const okFrom = f.from && f.from.id === peer.peerId;
      if (!okTo && !okFrom) return json({ ok: false, error: "not the receiver" }, 403);
    } else {
      const selfIid = iidOf(auth.instanceId);
      if (f.to && f.to !== "all") {
        const selfRow = deps.getDevices().filter((d) => iidOf(d.id) === selfIid)[0];
        const nameHit = !!(selfRow && selfRow.name && (selfRow.name === f.to || String(selfRow.name).includes(f.to)));
        if (iidOf(f.to) !== selfIid && iidOf(f.from && f.from.id) !== selfIid && !nameHit) return json({ ok: false, error: "not the receiver" }, 403);
      }
    }
    if (!existsSync(f.path)) return json({ ok: false, error: "file expired" }, 410);
    let stream;
    try {
      stream = Readable.toWeb(createReadStream(f.path));
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
    return new Response(stream, {
      headers: {
        ...cors,
        "content-type": f.mime || "application/octet-stream",
        "content-length": String(f.size),
        "cache-control": "no-store",
        "content-disposition": 'attachment; filename="pair-' + f.fileId.slice(2, 10) + `"; filename*=UTF-8''` + encodeURIComponent(f.name)
      }
    });
  }
  function getFileInfo(fileId) {
    const f = files.get(String(fileId || ""));
    return f ? { ...publicFile(f), path: f.path, status: f.status } : null;
  }
  async function fetchToFile(fileId, savePath) {
    const f = files.get(String(fileId || ""));
    if (!f) return { error: "unknown fileId" };
    if (f.status !== "ready") return { error: "file not ready" };
    if (!existsSync(f.path)) return { error: "file expired" };
    if (!savePath) {
      const dir = join(dataDir, "aiti-bridge", "pair-inbox");
      try {
        mkdirSync(dir, { recursive: true });
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
      const dest = join(dir, safeName(f.name));
      try {
        if (existsSync(dest)) unlinkSync(dest);
        await (await import("node:fs/promises")).copyFile(f.path, dest);
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
      return { ok: true, path: dest, name: f.name, size: f.size };
    }
    try {
      const { copyFile, mkdir } = await import("node:fs/promises");
      await mkdir(dirname(savePath), { recursive: true });
      await copyFile(f.path, savePath);
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
    return { ok: true, path: savePath, name: f.name, size: f.size };
  }
  function sweep(now) {
    for (const [iid, n] of [...names]) {
      if (now - n.at > PAIR_PEER_TTL) names.delete(iid);
    }
    for (const [pid, p] of [...peers]) {
      if (p.writer) {
        p.offlineAt = null;
        continue;
      }
      if (now - p.lastSeen <= 12e4) continue;
      if (!p.offlineAt) p.offlineAt = p.lastSeen;
      if (now - p.offlineAt > PAIR_PEER_TTL) {
        console.log(TAG + " pair device swept (offline timeout): " + p.name + " (" + pid + ")");
        peers.delete(pid);
        broadcastToPeers({ type: "peer-leave", peer: { id: pid, name: p.name } });
      }
    }
    if (filesDir) {
      for (const [fid, f] of [...files]) {
        if (now - f.at > PAIR_FILE_TTL) {
          try {
            rmSync(f.path, { force: true });
          } catch {
          }
          files.delete(fid);
        }
      }
      try {
        if (existsSync(filesDir)) {
          for (const name of readdirSync(filesDir)) {
            try {
              const p = join(filesDir, name);
              if (statSync(p).isFile() && now - statSync(p).mtimeMs > PAIR_FILE_TTL) {
                rmSync(p, { force: true });
                files.delete(name);
              }
            } catch {
            }
          }
        }
      } catch {
      }
    }
  }
  async function handle(req, path, searchParams) {
    const seg = path.slice(2);
    const method = req.method;
    if (seg[0] === "register" && method === "POST") {
      const msg = await req.json().catch(() => null);
      const denied = gateAdmission(req, msg && msg.regToken || null);
      if (denied) return denied;
      const r = register(msg, { ip: clientIp(req) });
      return json({ ok: true, ...r });
    }
    if (seg[0] === "devices" && method === "GET") {
      return json({ ok: true, devices: deps.getDevices() });
    }
    if (seg[0] === "events" && method === "GET") {
      const denied = gateAdmission(req, searchParams.get("reg"));
      if (denied) return denied;
      const p = checkPeer(searchParams.get("peer"), searchParams.get("token"));
      if (!p) return json({ ok: false, error: "bad peer/token" }, 401);
      const { response, writer, cleanup } = sseResponse(() => {
        if (p.writer === writer) {
          p.writer = null;
          if (!p.offlineAt) p.offlineAt = Date.now();
        }
        cleanup();
      });
      p.writer = writer;
      p.lastSeen = Date.now();
      p.offlineAt = null;
      writer.write({ type: "ready", peerId: p.peerId, name: p.name });
      return response;
    }
    function requestIdentity(msg) {
      const pg = pageIdentity(msg);
      if (pg) return pg;
      const pp = checkPeer(String(msg && msg.peer || ""), String(msg && msg.token || ""));
      return pp ? { id: pp.peerId, name: pp.name, kind: "pair" } : null;
    }
    if (seg[0] === "name" && method === "POST") {
      const msg = await req.json().catch(() => null);
      const from = pageIdentity(msg);
      if (!from) return json({ ok: false, error: "bad instanceId (page not on the bridge)" }, 401);
      const r = setName(from.id, String(msg && msg.name || ""));
      return json(r, r.ok ? 200 : 400);
    }
    if (seg[0] === "message" && method === "POST") {
      const msg = await req.json().catch(() => null);
      const from = requestIdentity(msg);
      if (!from) return json({ ok: false, error: "bad instanceId (page not on the bridge; external devices must send the register peer/token)" }, 401);
      const text = String(msg && msg.text || "").slice(0, 64e3);
      if (!text.trim()) return json({ ok: false, error: "bad request (text required)" }, 400);
      const r = deps.routeSend(from, String(msg && msg.to || "all"), { text, pageId: from.id, notify: !!(msg && msg.notify) });
      return json(r, r.ok ? 200 : r.candidates ? 300 : 400);
    }
    if (seg[0] === "file") {
      if (seg[1] === "init" && method === "POST") {
        const msg = await req.json().catch(() => null);
        const from = requestIdentity({ ...msg, name: void 0 });
        if (!from) return json({ ok: false, error: "bad instanceId (page not on the bridge; external devices must send the register peer/token)" }, 401);
        const denied = gateAdmission(req, null);
        if (denied) return denied;
        const r = fileInit(from, String(msg && msg.to || ""), String(msg && msg.name || ""), Number(msg && msg.size || 0), String(msg && msg.mime || ""));
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
        const f = getFileInfo(fileId);
        deps.routeSend(f.from, f.to || "all", { file: { fileId: f.fileId, name: f.name, size: f.size, mime: f.mime, from: f.from, fromName: f.from.name } });
        return json(r);
      }
      if (seg.length === 2 && method === "GET") {
        return fileDownload({ instanceId: searchParams.get("instanceId") || "" }, String(seg[1] || ""), { peerId: searchParams.get("peer") || "", token: searchParams.get("token") || "" });
      }
    }
    if (seg[0] === "inbox" && method === "GET" && searchParams.get("instanceId")) {
      const iid = searchParams.get("instanceId") || "";
      if (!validateInstance(iid)) return json({ ok: false, error: "bad instanceId" }, 401);
      return json(pullPageInbox(iid, Number(searchParams.get("since") || 0)));
    }
    if (seg[0] === "inbox" && method === "GET") {
      const p = checkPeer(searchParams.get("peer"), searchParams.get("token"));
      if (!p) return json({ ok: false, error: "bad peer/token" }, 401);
      p.lastSeen = Date.now();
      const pending = p.inbox.filter((m) => m.status === "pending");
      for (const m of pending) m.status = "delivered";
      return json({ ok: true, peerId: p.peerId, name: p.name, pending: pending.map(({ status, ...m }) => m) });
    }
    return null;
  }
  return { handle, listPeers, nameFor, setName, notePageInbox, pullPageInbox, deliverToPeer, resolvePeerFuzzy, register, checkPeer, fileInit, fileChunk, fileComplete, fileDownload, getFileInfo, fetchToFile, sweep, close: () => {
    peers.clear();
    names.clear();
    pageInbox.clear();
    files.clear();
  } };
}

// src/ua-parse.js
var BRAND_NAMES = [
  [/Microsoft Edge/i, "Edge"],
  [/Opera|Opera GX/i, "Opera"],
  [/Brave/i, "Brave"],
  [/Vivaldi/i, "Vivaldi"],
  [/Samsung Internet/i, "Samsung Internet"],
  [/YaBrowser|Yandex/i, "Yandex"],
  [/DuckDuckGo/i, "DuckDuckGo"],
  [/Google Chrome/i, "Chrome"],
  [/Chromium/i, "Chromium"]
];
var UA_TOKENS = [
  ["EdgiOS", "Edge"],
  ["EdgA", "Edge"],
  ["Edg", "Edge"],
  ["Edge", "Edge"],
  // legacy EdgeHTML
  ["OPiOS", "Opera"],
  ["OPR", "Opera"],
  ["SamsungBrowser", "Samsung Internet"],
  ["YaBrowser", "Yandex"],
  ["Vivaldi", "Vivaldi"],
  ["DuckDuckGo", "DuckDuckGo"],
  ["Whale", "Whale"],
  ["Electron", "Electron"],
  ["FxiOS", "Firefox"],
  ["Firefox", "Firefox"],
  ["CriOS", "Chrome"],
  ["Chrome", "Chrome"]
];
var VERSION_TOKENS = {
  Edge: ["Edg", "EdgA", "EdgiOS", "Edge"],
  Opera: ["OPR", "OPiOS"],
  "Samsung Internet": ["SamsungBrowser"],
  Yandex: ["YaBrowser"],
  Vivaldi: ["Vivaldi"],
  DuckDuckGo: ["DuckDuckGo"],
  Whale: ["Whale"],
  Electron: ["Electron"],
  Firefox: ["Firefox", "FxiOS"],
  Chrome: ["Chrome", "CriOS"]
};
function tokenVersion(ua, tokens) {
  for (const t of tokens || []) {
    const i = ua.indexOf(t + "/");
    if (i < 0) continue;
    const m = ua.slice(i + t.length + 1).match(/^[\d.]+/);
    if (m) return m[0];
  }
  return "";
}
function parseUa(ua, nav) {
  const s = String(ua || "");
  const out = { browser: "?", version: "", os: "?", osVer: "", deviceType: "desktop", mobile: false, source: "" };
  try {
    const brands = nav && nav.userAgentData && Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands : null;
    if (brands && brands.length) {
      for (const [re, name] of BRAND_NAMES) {
        const hit = brands.filter((b) => b && re.test(String(b.brand)))[0];
        if (!hit) continue;
        out.browser = name;
        out.version = String(hit.version || "");
        out.source = "ua-ch";
        break;
      }
      if (out.browser !== "?" && out.browser !== "Chromium") {
        const full = tokenVersion(s, VERSION_TOKENS[out.browser]);
        if (full) out.version = full;
      }
    }
  } catch (e) {
  }
  if (out.browser === "?" || out.browser === "Chromium") {
    for (const [tok, name] of UA_TOKENS) {
      if (s.indexOf(tok + "/") < 0) continue;
      out.browser = name;
      out.version = tokenVersion(s, VERSION_TOKENS[name]);
      if (!out.source) out.source = "ua-string";
      break;
    }
    if (out.browser === "?") {
      const vm = s.match(/Version\/([\d.]+).*Safari/);
      if (vm) {
        out.browser = "Safari";
        out.version = vm[1];
        out.source = "ua-string";
      } else if (/MSIE|Trident/.test(s)) {
        out.browser = "IE";
        const mi = s.match(/rv:([\d.]+)/);
        out.version = mi ? mi[1] : "";
        out.source = "ua-string";
      }
    }
  }
  let ipadLike = false;
  try {
    const touch = nav && typeof nav.maxTouchPoints === "number" ? nav.maxTouchPoints : 0;
    ipadLike = touch > 1 && /Mac OS X/.test(s) && !/Chrome|CriOS|Firefox|FxiOS|Edg|OPR/.test(s);
    if (/Windows Phone/.test(s)) {
      out.os = "Windows Phone";
    } else if (/Windows NT/.test(s)) {
      out.os = "Windows";
      out.osVer = /Windows NT 10\.0/.test(s) ? "10/11" : /Windows NT 6\.[123]/.test(s) ? "7/8" : "10/11";
    } else if (/iPhone|iPad|iPod/.test(s)) {
      out.os = "iOS";
      const im = s.match(/OS (\d+[_\d]*)/);
      out.osVer = im ? im[1].replace(/_/g, ".") : "";
    } else if (/Android/.test(s)) {
      out.os = "Android";
      const am = s.match(/Android ([\d.]+)/);
      out.osVer = am ? am[1] : "";
    } else if (/CrOS/.test(s)) {
      out.os = "ChromeOS";
    } else if (ipadLike) {
      out.os = "iOS";
      out.osVer = "";
    } else if (/Mac OS X/.test(s)) {
      out.os = "macOS";
      const mm = s.match(/Mac OS X ([\d_.]+)/);
      out.osVer = mm ? mm[1].replace(/_/g, ".") : "";
    } else if (/Linux|X11/.test(s)) {
      out.os = "Linux";
    }
  } catch (e) {
  }
  out.mobile = /Android|iPhone|iPod|Mobile|Windows Phone|IEMobile/i.test(s) || out.os === "iOS" && /iPhone|iPod/.test(s);
  const tablet = /iPad|Tablet|Silk|PlayBook/i.test(s) || /Android/i.test(s) && !/Mobile/i.test(s) || ipadLike;
  out.deviceType = tablet ? "tablet" : out.mobile ? "mobile" : "desktop";
  return out;
}

// src/bridge.ts
var ID_TTL = parseInt(process.env.AITI_BRIDGE_TTL || "600000", 10);
var AGENT_TTL = parseInt(process.env.AITI_AGENT_TTL || "3600000", 10);
var BROADCAST_TTL = parseInt(process.env.AITI_BROADCAST_TTL || "600000", 10);
var AGENT_GRACE_TTL = parseInt(process.env.AITI_AGENT_GRACE_TTL || "120000", 10);
var AGENT_HISTORY_TTL = parseInt(process.env.AITI_AGENT_HISTORY_TTL || String(7 * 24 * 3600 * 1e3), 10);
var SWEEP_MS = parseInt(process.env.AITI_SWEEP_MS || "60000", 10);
var LEGACY_TOKEN = "dev";
var BRIDGE_TOOLS = [
  {
    name: "page_exec",
    description: "Run a CDP-like command on a connected page (DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser domains). pageId defaults to the latest AI main window (self:true); an explicit pageId wins. Dangerous commands / browser-restricted operations pop a user confirmation first; Page.captureScreenshot first pops a prep card stating the screenshot intent (args.reason \u2014 always describe in one sentence what you want to capture), the user adjusts the page before capture starts, and a preview confirmation pops afterwards (large images are written to disk and returned as a file path); the confirmation countdown is tunable via args.timeout (ms, default 280000, the server-side safety net adds +30s). Messages from a debugged page (inject) carry a [\u53D1\u81EA: <pageId> \xB7 <url>] source annotation \u2014 pass that pageId value to the pageId parameter to operate that page.\n\niframe support: Page.getFrameTree inspects the frame tree (iframe src/name/title, same-origin includes url/readyState); pass contextId to Runtime.evaluate (iframe index starting at 1, same-origin eval) to run in an iframe context.",
    inputSchema: { type: "object", properties: {
      cmd: { type: "string" },
      args: { type: "object" },
      pageId: { type: "string", description: "Full ID of the target page \u2014 from an AI message's [\u53D1\u81EA: xxx] annotation (e.g. 3001/host); also queryable via /bridge/sessions" }
    }, required: ["cmd"] }
  },
  { name: "page_snapshot", description: "Pull the basic live state of a connected page (URL / selection / emulation overrides). pageId defaults to the latest AI main window (self:true); an explicit pageId wins.", inputSchema: { type: "object", properties: { pageId: { type: "string" } } } },
  { name: "self_ui", description: "Scan the target page (default: AI main window xxx/ai) for currently open dialogs / forms / fields / buttons \u2014 used by ai-helper to locate fields for backfill. Returns {dialogs:[{title, fields:[{label,selector,type}], buttons}]}; dialogs is empty when none are open.", inputSchema: { type: "object", properties: { pageId: { type: "string", description: "Defaults to the AI main window (xxx/ai); other pages allowed" } } } },
  { name: "form_fill", description: "Backfill field values into a dialog/form on the target page (default: AI main window xxx/ai) \u2014 the AI directly operates extension dialog forms (React-compatible: native value setter + dispatched input/change). Pair with self_ui: first self_ui to get field label/selector, then form_fill to fill. Params: dialog (dialog id: title substring or 0-based index; defaults to the largest visible dialog), fields[{selector|label, value}], button (optional, button text to click after backfill, e.g. 'Save'). Returns {foundDialog, title, filled, missed, clicked}.", inputSchema: { type: "object", properties: {
    pageId: { type: "string", description: "Defaults to the AI main window (xxx/ai); other pages allowed" },
    dialog: { type: "string", description: "Dialog id: title substring or 0-based index; defaults to the largest visible dialog" },
    fields: { type: "array", items: { type: "object", properties: { selector: { type: "string", description: "CSS selector (preferred)" }, label: { type: "string", description: "In-dialog text match (label[for]/wrapping/contains)" }, value: { type: "string", description: "Value to fill" } }, required: ["value"] }, description: "Fields to fill" },
    button: { type: "string", description: "Button text to click after backfill (e.g. 'Save', 'OK')" }
  } } },
  { name: "bridge_status", description: "Query every device on the bridge (devices unified view: kind=page injected pages (pageId/url/title + device browser\xB7OS\xB7screen) / kind=agent agent sessions (with cwd) / kind=pair web devices like phones) + connected page details (sessions) and pending requests. When the user mentions a page title or URL, match pageId by title/url; when they mention a phone/device, pick from devices (pass its id or name to aiti_pair_send/aiti_pair_file to exchange messages/files).", inputSchema: { type: "object", properties: {} } },
  {
    name: "page_logs",
    description: "Pull locally buffered console logs from the target page (log/debug/info/warn/error, full ring; CDP Runtime.evaluate reads window.__dbg.__consoleRing). pageId defaults to the latest AI main window (self:true); an explicit pageId wins. First choice for page-error triage: start at warn/error, then widen. Returns {logs:[{ts,level,text,count}], bufferSize}.",
    inputSchema: { type: "object", properties: {
      pageId: { type: "string", description: "Full ID of the target page ([\u53D1\u81EA: xxx] annotation or /bridge/sessions)" },
      level: { type: "string", description: "Filter level: debug/log/info/warn/error (default all)" },
      since: { type: "string", description: "ISO time: only return logs after this moment" },
      limit: { type: "number", description: "Max entries (\u2264200, default 50, newest kept)" },
      token: { type: "string" }
    } }
  },
  {
    name: "page_network",
    description: "Pull locally buffered ajax/fetch request completions from the target page (CDP Runtime.evaluate reads window.__dbg.__netRing). pageId defaults to the latest AI main window (self:true); an explicit pageId wins. For failure triage pass status 400 or errorOnly:true. Note: static asset loads are not included (that is CDP Network's territory). Returns {requests:[{kind,method,url,status,statusText,durationMs,size,error,ts}], bufferSize}.",
    inputSchema: { type: "object", properties: {
      pageId: { type: "string" },
      url: { type: "string", description: "URL substring filter" },
      status: { type: "number", description: "Only return entries with status >= this value (e.g. 400 for failures only)" },
      errorOnly: { type: "boolean", description: "Failures only (error non-empty or status>=400)" },
      limit: { type: "number", description: "Max entries (\u2264100, default 30, newest kept)" },
      token: { type: "string" }
    } }
  },
  // ---- 用户交互型工具：AI 与人在页面上协作（AI 提问 → 人在 AI 窗口/页面作答或拒绝 → 结果回 AI） ----
  // 统一机制：prompt 显示给人看；timeout 为可选——不传=永久等待（面板常驻直到用户操作，不读秒不超时）；
  //   传了才显示读秒倒计时（可暂停）且服务器强制到点返回“用户无响应/不在线”；
  //   交互消息到达时页面走浏览器 Notification（+标题闪烁/提示音）通知用户；人可拒绝（rejectable）。
  // 响应信封：{ status:'answered'|'rejected'|'timeout'|'error', value?, reason?, error?, tookMs, timeoutMs }
  {
    name: "user_pick_element",
    description: "Ask the human user of the current page to pick a page element (auto-enters Inspector pick mode, collapses the AI window, pops the pick panel; the user can confirm or decline). Returns the element payload {tag,rect,xpath,text,attributes,framework,selector}.",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string", description: "Explanation shown to the user (why this element is needed)" },
      timeout: { type: "number", description: "Optional timeout ms (5000-600000). Omit = wait forever: the panel stays until the user acts, no countdown; when passed, a pausable countdown shows and it auto-returns timeout on expiry" },
      rejectable: { type: "boolean", description: "Whether the user may decline (default true)" },
      async: { type: "boolean", description: "true = async: returns immediately once dispatched; the user's answer arrives via the AI message window; default = wait synchronously" },
      pageId: { type: "string", description: "Full ID of the target page (instanceId/frameId)" }
    }, required: ["prompt"] }
  },
  {
    name: "user_confirm",
    description: 'Ask the human user a yes/no question in the AI window (e.g. "confirm this action?" "continue?"); the user answers via \u2705/\u274C and may attach a free-text note (value.comment); a fixed "none of these fit" option leads to a custom answer (approved:null, custom). Returns {status, approved, comment?, custom?, reason?}.',
    inputSchema: { type: "object", properties: {
      prompt: { type: "string", description: "The question text" },
      timeout: { type: "number", description: "Optional timeout ms (5000-600000). Omit = wait forever: the panel stays until the user acts, no countdown; when passed, a pausable countdown shows and it auto-returns timeout on expiry" },
      rejectable: { type: "boolean", description: `Whether the user may decline with "can't handle this right now" (default true)` },
      async: { type: "boolean", description: "true = async: returns immediately once dispatched; the user's answer arrives via the AI message window (does not block this call); default = wait synchronously" },
      pageId: { type: "string" }
    }, required: ["prompt"] }
  },
  {
    name: "user_choose",
    description: 'Offer the human user a set of options in the AI window (e.g. fix plans A/B/C). Single choice (default) \u2192 value:{index,label}; multiple:true \u2192 value:{indexes,labels}. The user may attach a free-text note (value.comment); a fixed "none of these fit" option leads to a custom answer (index:-1, custom:true). Returns {status, value, reason?}.',
    inputSchema: { type: "object", properties: {
      prompt: { type: "string" },
      choices: { type: "array", items: { type: "string" }, description: "Option list (2-8 items)" },
      multiple: { type: "boolean", description: "Allow multiple selection (default false; returns indexes/labels when true)" },
      timeout: { type: "number", description: "Optional timeout ms (5000-600000). Omit = wait forever: the panel stays until the user acts, no countdown; when passed, a pausable countdown shows and it auto-returns timeout on expiry" },
      rejectable: { type: "boolean", description: "Whether the user may decline (default true)" },
      async: { type: "boolean", description: "true = async: returns immediately once dispatched; the user's answer arrives via the AI message window; default = wait synchronously" },
      pageId: { type: "string" }
    }, required: ["prompt", "choices"] }
  },
  {
    name: "user_input",
    description: "Ask the human user to type a piece of text in the AI window (e.g. desired copy, a config value, a scenario description); sent on Enter/click. Returns {status, value:{text}, reason?}.",
    inputSchema: { type: "object", properties: {
      prompt: { type: "string" },
      defaultValue: { type: "string", description: "Optional pre-filled default" },
      timeout: { type: "number", description: "Optional timeout ms (5000-600000). Omit = wait forever: the panel stays until the user acts, no countdown; when passed, a pausable countdown shows and it auto-returns timeout on expiry" },
      rejectable: { type: "boolean", description: "Whether the user may decline (default true)" },
      async: { type: "boolean", description: "true = async: returns immediately once dispatched; the user's answer arrives via the AI message window; default = wait synchronously" },
      pageId: { type: "string" }
    }, required: ["prompt"] }
  },
  {
    name: "user_presence",
    description: 'Probe whether the human user is present/online (confirm before starting a long task that needs their cooperation); the user taps "here / later" and may attach a note (value.comment). Returns {status, present, comment?}; timeout means not present.',
    inputSchema: { type: "object", properties: {
      prompt: { type: "string", description: 'Question text (default "are you there? I need your help to continue")' },
      timeout: { type: "number", description: "Optional timeout ms (5000-600000). Omit = wait forever until the user answers; when passed, a pausable countdown shows and it returns status:'timeout' on expiry (treated as not present) \u2014 pass it explicitly only for quick presence probes / timeboxed waits" },
      async: { type: "boolean", description: "true = async: returns immediately once dispatched; the user's answer arrives via the AI message window; default = wait synchronously" },
      pageId: { type: "string" }
    }, required: [] }
  },
  {
    name: "user_notify",
    description: 'Non-blocking notification: tell the user something via a browser Notification (e.g. "fix done, please refresh and verify") without waiting for an answer. Returns {notified:true}.',
    inputSchema: { type: "object", properties: {
      title: { type: "string", description: "Notification title" },
      body: { type: "string", description: "Notification body" },
      timeout: { type: "number", description: "Optional: auto-dismiss time for the notification card ms (5000-600000). Omit = stays until the user closes it" },
      async: { type: "boolean", description: "true = async: returns immediately once dispatched; the user's answer arrives via the AI message window; default = wait synchronously" },
      pageId: { type: "string", description: "Target page: full pageId (iid/frameId) / url / title (same as resolvePageId) or bare instanceId (same namespace as pair device ids). Default = broadcast to all AI windows + the session's default page" }
    }, required: ["body"] }
  },
  // ---- 方案 G · P2：agent 接入 + 消息主通道 ----
  {
    name: "aiti_hello",
    description: "Agent self-introduction/registration: override agentId (default clientInfo.name) and sessionId (default Mcp-Session-Id or bridge-random), bind the default target pageId, subscribe page events (page_error). Note: page_log/page_network are no longer pushed live \u2014 pull them on demand with the page_logs/page_network tools. Call once at session start \u2014 once registered, messages can be routed to this session (agentKey=agentId/sessionId).",
    inputSchema: { type: "object", properties: {
      agentId: { type: "string", description: "Custom agent id (e.g. pi / cc / qoder; defaults to clientInfo.name)" },
      sessionId: { type: "string", description: "Session id of this instance (distinguishes multi-instance/multi-session; defaults to Mcp-Session-Id, or bridge-random)" },
      name: { type: "string", description: "Display name (optional, e.g. 'pi \xB7 workspace A')" },
      cwd: { type: "string", description: "Working directory (optional; shown as CWD . name (id) to identify the agent)" },
      pageId: { type: "string", description: "Bind the default debug target page (pageId/url/title all accepted; leave empty to skip)" },
      subEvents: { type: "array", items: { type: "string" }, description: "Live events to subscribe: page_error (not delivered by default, only when explicitly subscribed; page_log/page_network are no longer pushed live \u2014 use page_logs/page_network to pull on demand)" }
    } }
  },
  {
    name: "file_stat",
    description: "Check file existence/type/size/mtime (absolute path; for locating component source / call sites, and as the pre-check for the AI window's backend/frontend open). Non-existent or invalid paths return {exists:false}.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Absolute path (e.g. /home/user/src/App.vue)" }
    }, required: ["path"] }
  },
  {
    name: "aiti_inbox",
    description: "Main message channel: pull messages addressed to this agent session (human-initiated user_message / async user_* answers user_answer / subscribed page events). Call it when starting a new round or needing fresh info; after processing, pass the message ids in the ack param to confirm (marks consumed; history is kept). Returns agentKey (agentId/sessionId); when unregistered it suggests calling aiti_hello first.",
    inputSchema: { type: "object", properties: {
      agentId: { type: "string", description: "Agent id (defaults to the aiti_hello registration or clientInfo.name)" },
      sessionId: { type: "string", description: "Session id of this instance (defaults to Mcp-Session-Id or the aiti_hello registration)" },
      ack: { description: "Ids of processed messages, or { ids: [...], summary: 'execution summary' } \u2014 summary (required) is shown in the console message stream as the agent's handling record", oneOf: [{ type: "array", items: { type: "string" } }, { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, summary: { type: "string" } } }] }
    } }
  },
  // ---- pair device interconnect (temporary chat / file transfer; device discovery via bridge_status's devices view) ----
  {
    name: "aiti_pair_send",
    description: "Send a text message to another device on the bridge (a page / another agent session / a pair web device like a phone). Pass the device id or name in to (fuzzy match; a unique hit sends, multiple/no hits return a candidate list); omitting to or passing 'all' = all pages (not cross-kind); 'agents' = all agents; 'pairs' = all pair devices. For file transfer use aiti_pair_file.",
    inputSchema: { type: "object", properties: {
      to: { type: "string", description: "Target device id or name (pick from bridge_status devices; default/'all'=all pages; 'agents'=all agents; 'pairs'=all pair devices)" },
      text: { type: "string", description: "Message text" }
    }, required: ["text"] }
  },
  {
    name: "aiti_pair_file",
    description: "Push a local file on the bridge's machine to another device (pair web devices download it directly in the browser; agents receive file-meta and fetch it back with aiti_pair_fetch). Pass the device id or name in to. Per-file cap 200MB, relay keeps it for 1 hour.",
    inputSchema: { type: "object", properties: {
      to: { type: "string", description: "Target device id or name" },
      path: { type: "string", description: "Absolute path of the local file" }
    }, required: ["to", "path"] }
  },
  {
    name: "aiti_pair_fetch",
    description: "Fetch a received pair file back onto the bridge machine's disk (fileId comes from an aiti_inbox message payload.file.fileId). Defaults to dataDir/aiti-bridge/pair-inbox/<original name> and returns a readable path; pass savePath to choose the destination.",
    inputSchema: { type: "object", properties: {
      fileId: { type: "string", description: "File id (aiti_inbox message payload.file.fileId)" },
      savePath: { type: "string", description: "Absolute destination path (default: pair-inbox dir + original name)" }
    }, required: ["fileId"] }
  }
];
function createBridge(dataDir = "", opts = {}) {
  const BRIDGE_NAME = opts.name || "aiti-mcp";
  const DISPLAY_NAME = opts.name || "aiti-devtools";
  const TAG = "[" + BRIDGE_NAME + "]";
  const busPublish = opts.busPublish || null;
  const BUS_CONN_TTL = parseInt(process.env.AITI_BUS_CONN_TTL || "150000", 10);
  const idRegistry = /* @__PURE__ */ new Map();
  const pages = /* @__PURE__ */ new Map();
  const pendingRequests = /* @__PURE__ */ new Map();
  const aiConns = /* @__PURE__ */ new Set();
  const mcpReqMap = /* @__PURE__ */ new Map();
  const cancelIdMap = /* @__PURE__ */ new Map();
  const aiPageReg = /* @__PURE__ */ new Map();
  const aiSelfReg = /* @__PURE__ */ new Map();
  const sseMcpClients = /* @__PURE__ */ new Set();
  const mcpSessions = /* @__PURE__ */ new Map();
  const MCP_SESSION_TTL = parseInt(process.env.AITI_MCP_SESSION_TTL || "600000", 10);
  const mcpSessionExpired = (s) => Date.now() - (s && s.lastSeen || 0) > MCP_SESSION_TTL;
  const agents = /* @__PURE__ */ new Map();
  const agentFallbackPageIds = /* @__PURE__ */ new Map();
  const boundPageIdFor = (sess) => {
    const key = sess && (sess.agentKey || sess.agentId);
    const ag = key ? agents.get(String(key)) : null;
    if (!ag) return null;
    if (ag.activeBoundPageId && boundPageAlive(ag.activeBoundPageId)) return String(ag.activeBoundPageId);
    const fbList = agentFallbackPageIds.get(String(key));
    if (fbList && fbList.length > 0) {
      const sorted = fbList.filter(function(e) {
        return boundPageAlive(e.pageId);
      }).sort(function(a, b) {
        return b.lastSeen - a.lastSeen;
      });
      if (sorted.length > 0) return String(sorted[0].pageId);
    }
    if (ag.boundPageId && boundPageAlive(ag.boundPageId)) return String(ag.boundPageId);
    const sid = sess && sess.id || key && String(key).split("/").slice(1).join("/") || null;
    if (sid) {
      let best = null;
      let bestSeen = -1;
      for (const [, rec] of aiSelfReg) {
        const m = String(rec.url || "").match(/[?&]session=([^&#]+)/);
        if (m && decodeURIComponent(m[1]) === sid && (rec.lastSeen || 0) > bestSeen) {
          best = rec;
          bestSeen = rec.lastSeen || 0;
        }
      }
      if (best) return String(best.instanceId) + "/ai";
    }
    return null;
  };
  const bindAgentPage = (key, pageId) => {
    const a = agents.get(String(key || ""));
    if (!a) return { ok: false, error: "unknown agent: " + key };
    a.boundPageId = pageId ? String(pageId) : null;
    return { ok: true, agentKey: String(key), boundPageId: a.boundPageId };
  };
  const bindAgentFromAiSelf = (rec) => {
    const m = String(rec.url || "").match(/[?&]session=([^&#]+)/);
    if (!m) return;
    const sid = decodeURIComponent(m[1]);
    const newPageId = String(rec.instanceId) + "/ai";
    const now = Date.now();
    for (const [key, ag] of agents) {
      const agSid = ag.sessionId || String(key).split("/").slice(1).join("/");
      if (agSid === sid) {
        if (!agentFallbackPageIds.has(key)) agentFallbackPageIds.set(key, []);
        var list = agentFallbackPageIds.get(key);
        var found = false;
        for (var i = 0; i < list.length; i++) {
          if (list[i].pageId === newPageId) {
            list[i].lastSeen = now;
            found = true;
            break;
          }
        }
        if (!found) list.push({ pageId: newPageId, lastSeen: now });
      }
    }
  };
  const bindAgentFromActive = (instanceId, sessionId) => {
    const pageId = instanceId + "/ai";
    for (const [key, ag] of agents) {
      const agSid = ag.sessionId || String(key).split("/").slice(1).join("/");
      if (agSid === sessionId) {
        ag.activeBoundPageId = pageId;
        console.log(TAG + " AI main window active binding: " + key + " \u2192 " + pageId);
        break;
      }
    }
  };
  const boundPageAlive = (pageId) => {
    const inst = String(pageId || "").split("/")[0];
    if (!inst) return false;
    for (const [, rec] of aiSelfReg) if (rec.instanceId === inst) return true;
    return false;
  };
  const lastEventPush = /* @__PURE__ */ new Map();
  const pushDeduped = (key, sig) => {
    const now = Date.now();
    const last = lastEventPush.get(key);
    if (last && last.sig === sig && now - last.ts < 5e3) return true;
    lastEventPush.set(key, { sig, ts: now });
    return false;
  };
  const agentIdx = /* @__PURE__ */ new Map();
  const agentOnline = (a) => !!(a && a.conn > 0);
  const markOffline = (key) => {
    const a = agents.get(key);
    if (a && !agentOnline(a) && !a.offlineAt) a.offlineAt = Date.now();
  };
  const agentKey = (aid, sid) => safeId(aid) + "/" + safeId(sid || "s_" + randomBytes2(3).toString("hex"));
  const randomSessionId = () => "s_" + randomBytes2(3).toString("hex");
  const OUTBOX_MAX = 200;
  const safeId = (s) => String(s || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  const msgSessionDir = (agentId) => join2(dataDir, "aiti-bridge", "sessions", safeId(agentId));
  const msgSessionFile = (agentId) => {
    const dir = msgSessionDir(agentId);
    const files = existsSync2(dir) ? readdirSync2(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
    if (files.length) {
      const latest = join2(dir, files[files.length - 1]);
      try {
        if (statSync2(latest).size > 2 * 1024 * 1024) return newMsgSessionFile(agentId);
      } catch {
      }
      return latest;
    }
    return newMsgSessionFile(agentId);
  };
  const newMsgSessionFile = (agentId) => {
    const dir = msgSessionDir(agentId);
    mkdirSync2(dir, { recursive: true });
    return join2(dir, (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + "_" + randomBytes2(8).toString("hex") + ".jsonl");
  };
  const appendMsgEvent = (agentId, evt) => {
    try {
      const file = msgSessionFile(agentId);
      if (!existsSync2(file)) appendFileSync2(file, JSON.stringify({ type: "session", version: 1, id: randomBytes2(8).toString("hex"), timestamp: (/* @__PURE__ */ new Date()).toISOString(), kind: "aiti-bridge" }) + "\n");
      appendFileSync2(file, JSON.stringify(evt) + "\n");
    } catch (e) {
    }
  };
  const readMsgSession = (agentId) => {
    const rows = [];
    try {
      const dir = msgSessionDir(agentId);
      if (!existsSync2(dir)) return rows;
      for (const f of readdirSync2(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
        for (const line of readFileSync(join2(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === "message") rows.push({ id: evt.id, ...evt.message || {}, at: evt.timestamp });
          else if (evt.type === "status_change") {
            const r = rows.find((x) => x.id === evt.msgId);
            if (r) r.status = evt.status;
          }
        }
      }
    } catch (e) {
    }
    return rows;
  };
  const restoreAgentOutbox = (agentId, agent) => {
    for (const row of readMsgSession(agentId)) {
      if (row.status !== "consumed") agent.outbox.push({ ...row, status: "pending" });
    }
  };
  const ensureAgent = (agentId, sessionId, session) => {
    if (!agentId) return { a: null, key: null };
    const aid = safeId(agentId);
    const sid = sessionId ? safeId(String(sessionId)) : randomSessionId();
    const key = aid + "/" + sid;
    let a = agents.get(key);
    if (!a) {
      a = {
        agentId: aid,
        sessionId: sid,
        registered: !!sessionId,
        name: aid + (session && session.clientInfo && session.clientInfo.name ? " (" + session.clientInfo.name + ")" : ""),
        cwd: null,
        offlineAt: null,
        conn: 0,
        // cwd：工作目录（显示 CWD . name (id)）；offlineAt：掉线时间（显示/清理用）；conn：持久连接数
        transportKind: session && session.open ? "streamable" : "stateless",
        source: session && session.source || "unknown",
        // 调用来源：extension（pi 扩展直连）/ mcp / unknown
        capabilities: session && session.capabilities || {},
        stream: session && session.writer || null,
        boundPageId: null,
        subEvents: /* @__PURE__ */ new Set(),
        outbox: [],
        lastSeen: Date.now(),
        agentStream: null,
        inProcessSink: null
        // 宿主进程内 agent（如 pi-web 方案 M）：消息直推回调（注入会话，不走 outbox/SSE）——任何宿主可用
      };
      restoreAgentOutbox(key, a);
      agents.set(key, a);
      let idxSet = agentIdx.get(aid);
      if (!idxSet) {
        idxSet = /* @__PURE__ */ new Set();
        agentIdx.set(aid, idxSet);
      }
      idxSet.add(key);
      console.log(TAG + " agent session registered: " + key + (a.registered ? "(explicit)" : "(random session; prompt aiti_hello to register)") + " " + a.transportKind + " restored outbox " + a.outbox.length + " msg(s)");
    }
    a.lastSeen = Date.now();
    if (session) {
      a.capabilities = session.capabilities || a.capabilities;
      if (session.writer) a.stream = session.writer;
      if (session.open) a.transportKind = "streamable";
    }
    return { a, key };
  };
  const queueMsg = (key, msg) => {
    const a = agents.get(key);
    if (!a) return { ok: false, error: "unknown agent session: " + key };
    let srcPageId = msg.pageId || msg.payload && msg.payload.pageId || null;
    let srcUrl = msg.url || msg.payload && msg.payload.url || null;
    if (typeof msg.text === "string") {
      const fm = msg.text.match(/\[发自:\s*([^\s·\]（(]+)/);
      if (fm) srcPageId = srcPageId || fm[1].trim();
      if (!srcUrl) {
        const um = msg.text.match(/\[发自:\s*[^\s·\]（(]+\s*·\s*([^\s（(]+)/);
        if (um) srcUrl = um[1].trim();
      }
    }
    const m = { id: randomBytes2(4).toString("hex"), ...msg, pageId: srcPageId, url: srcUrl, source: msg.source || msg.payload && msg.payload.source || null, sourceLabel: msg.sourceLabel || msg.payload && msg.payload.sourceLabel || null, agentId: key, at: (/* @__PURE__ */ new Date()).toISOString(), status: "pending" };
    a.outbox.push(m);
    if (a.outbox.length > OUTBOX_MAX) a.outbox.splice(0, a.outbox.length - OUTBOX_MAX);
    appendMsgEvent(key, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
    return { ok: true, msg: m };
  };
  const resolvePushTargets = (to) => {
    const now = Date.now();
    const liveKeys = [...agents.entries()].filter(([, a]) => a.registered && (agentOnline(a) || now - (a.offlineAt || a.lastSeen || 0) <= BROADCAST_TTL)).map(([k]) => k);
    if (!to || to === "all") return liveKeys.sort((a, b) => ((agents.get(b) || {}).lastSeen || 0) - ((agents.get(a) || {}).lastSeen || 0));
    const s = String(to);
    if (agents.has(s)) return [s];
    if (agentIdx.has(s)) return [...agentIdx.get(s)].filter((k) => liveKeys.includes(k)).sort((a, b) => ((agents.get(b) || {}).lastSeen || 0) - ((agents.get(a) || {}).lastSeen || 0));
    return [];
  };
  const listAgentSessions = () => {
    return [...agents.entries()].map(([key, a]) => ({
      agentKey: key,
      agentId: a.agentId,
      sessionId: a.sessionId,
      registered: a.registered,
      name: a.name || a.agentId,
      transportKind: a.transportKind,
      source: a.source || "unknown",
      boundPageId: a.boundPageId || null,
      subEvents: [...a.subEvents],
      online: agentOnline(a),
      agentStream: !!a.agentStream,
      cwd: a.cwd || null,
      offlineAt: a.offlineAt || null,
      inboxPending: a.outbox.filter((m) => m.status !== "consumed").length,
      lastSeen: a.lastSeen
    })).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
  };
  const pruneSessionDirs = (now) => {
    if (!dataDir) return;
    const rootDir = join2(dataDir, "aiti-bridge", "sessions");
    let dirs = [];
    try {
      dirs = existsSync2(rootDir) ? readdirSync2(rootDir) : [];
    } catch {
      return;
    }
    for (const d of dirs) {
      try {
        const p = join2(rootDir, d);
        const st = statSync2(p);
        if (!st.isDirectory()) continue;
        const files = readdirSync2(p).filter((f) => f.endsWith(".jsonl"));
        let mtime = st.mtimeMs;
        for (const f of files) {
          try {
            mtime = Math.max(mtime, statSync2(join2(p, f)).mtimeMs);
          } catch {
          }
        }
        if (now - mtime > AGENT_HISTORY_TTL) {
          rmSync2(p, { recursive: true, force: true });
          console.log(TAG + " sweeping history session (> " + Math.round(AGENT_HISTORY_TTL / 864e5) + " days idle): " + d);
        }
      } catch {
      }
    }
  };
  const agentSweep = () => {
    const now = Date.now();
    for (const [key, a] of agents) {
      if (agentOnline(a)) {
        if (a.offlineAt) a.offlineAt = null;
        continue;
      }
      if (now - a.lastSeen <= AGENT_GRACE_TTL) {
        if (a.offlineAt) a.offlineAt = null;
        continue;
      }
      if (!a.offlineAt) a.offlineAt = a.lastSeen;
      if (now - a.offlineAt > AGENT_TTL) {
        console.log(TAG + " agent swept (offline > " + Math.round(AGENT_TTL / 6e4) + "min): " + key + " " + (a.name || "") + " (offlineAt " + new Date(a.offlineAt).toISOString() + ")");
        agents.delete(key);
        const idx = agentIdx.get(a.agentId);
        if (idx) {
          idx.delete(key);
          if (!idx.size) agentIdx.delete(a.agentId);
        }
      }
    }
    for (const [k, v] of lastEventPush) if (now - v.ts > 36e5) lastEventPush.delete(k);
    try {
      pair.sweep(now);
    } catch {
    }
    for (const [iid, p] of [...pages]) {
      if (p.writer?.viaBus && now - (p.writer.lastSeen || 0) > BUS_CONN_TTL) {
        pages.delete(iid);
        console.log(TAG + " bus-type page connection timed out and removed: " + iid);
      }
    }
    for (const w of [...aiConns]) {
      if (w?.viaBus && now - (w.lastSeen || 0) > BUS_CONN_TTL) {
        aiConns.delete(w);
        aiPageReg.delete(w);
        aiSelfReg.delete(w);
      }
    }
    pruneSessionDirs(now);
  };
  const sweepTimer = setInterval(agentSweep, SWEEP_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  const close = () => {
    clearInterval(sweepTimer);
    try {
      pair.close();
    } catch {
    }
  };
  const pendingSampling = /* @__PURE__ */ new Map();
  const SAMPLING_TIMEOUT_MS = 45e3;
  const samplingTextOf = (result) => {
    if (!result) return "";
    const c = result.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => b && b.text || "").join("\n").trim();
    if (c && typeof c === "object") return c.text || "";
    return JSON.stringify(result).slice(0, 300);
  };
  const pushToAgents = (to, text, kind = "user_message", payload = {}, ref = null) => {
    const targets = resolvePushTargets(to);
    if (!targets.length) return { ok: false, error: "no registered agent sessions (an agent must connect to the bridge and register to have an inbox)" };
    const delivered = [];
    for (const t of targets) {
      const { a } = ensureAgent(t.split("/")[0], t.split("/").slice(1).join("/"), null);
      const srcLabel = a && a.source === "extension" ? "aiti-*" : DISPLAY_NAME + " MCP";
      let srcPageId = payload && payload.pageId || null;
      let srcUrl = payload && payload.url || null;
      let srcTitle = payload && payload.title || null;
      let srcDevice = payload && payload.deviceLabel || null;
      if (!srcPageId) {
        const bind = a && a.boundPageId ? resolvePageId(a.boundPageId) : null;
        const rows = listSessions().filter((r) => r.active && r.pageId);
        const pick = bind && bind.pageId && rows.find((r) => r.pageId === bind.pageId) || (rows.length === 1 ? rows[0] : null);
        if (pick) {
          srcPageId = pick.pageId;
          srcUrl = pick.url;
          srcTitle = pick.title || null;
          srcDevice = srcDevice || devShortLabel(pick.device);
        }
      } else if (!srcUrl) {
        const row = listSessions().find((r) => r.pageId === srcPageId);
        if (row) {
          srcUrl = row.url || null;
          srcTitle = srcTitle || row.title || null;
          srcDevice = srcDevice || devShortLabel(row.device);
        }
      }
      const clipMid = (s, max) => {
        s = String(s || "");
        if (s.length <= max) return s;
        const half = Math.max(8, Math.floor((max - 1) / 2));
        return s.slice(0, half) + "\u2026" + s.slice(s.length - half);
      };
      let tText = String(text);
      if (srcPageId && tText.indexOf("[\u53D1\u81EA: ") < 0) {
        const parts = [srcPageId];
        if (srcUrl) parts.push(clipMid(srcUrl, 64));
        if (srcTitle) parts.push(clipMid(srcTitle, 40));
        if (srcDevice) parts.push(clipMid(srcDevice, 40));
        tText = tText + "\n[\u53D1\u81EA: " + parts.join(" \xB7 ") + " (" + srcLabel + "; use it as the pageId param)]";
      }
      payload = { ...payload || {}, source: payload.source || a && a.source || null, sourceLabel: payload.sourceLabel || srcLabel, pageId: srcPageId, url: srcUrl, title: srcTitle };
      const canSample = !!(a && a.stream && a.capabilities && a.capabilities.sampling && (kind === "user_message" || kind === "chat"));
      if (canSample) {
        const rid = "smp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
        const done = (ok, result) => {
          if (!pendingSampling.delete(rid)) return;
          const answer2 = ok ? samplingTextOf(result) : result && result.error || "sampling failed";
          console.log(TAG + " sampling answer \u2192 agent=" + t + " \xB7 " + String(answer2).slice(0, 80));
          for (const w of aiConns) w.write({ type: "agent_answer", agentKey: t, agentId: a.agentId, ok, text: answer2, requestId: rid, at: Date.now() });
        };
        pendingSampling.set(rid, { agentKey: t, done, at: Date.now() });
        a.stream.write({
          jsonrpc: "2.0",
          id: rid,
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: tText } }],
            systemPrompt: "(Message from a human at the debug scene via " + DISPLAY_NAME + ". Target page pageId=" + (payload.pageId || "?") + ". Just answer, keep it brief.",
            maxTokens: 1024,
            temperature: 0.3
          }
        });
        setTimeout(() => done(false, { error: "sampling timed out (agent did not respond, or needs approval)" }), SAMPLING_TIMEOUT_MS);
        delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "sampling" });
      } else {
        const q = queueMsg(t, { kind, from: "window", text: tText, payload, pageId: payload && payload.pageId || null, source: payload.source, sourceLabel: payload.sourceLabel, ref });
        if (typeof a.inProcessSink === "function") {
          try {
            a.inProcessSink(tText, kind, payload);
          } catch (e) {
            console.error(TAG + " inProcessSink failed", e);
          }
          const m0 = q && q.msg;
          if (m0 && m0.status === "pending") {
            m0.status = "delivered";
            appendMsgEvent(t, { type: "status_change", id: randomBytes2(4).toString("hex"), msgId: m0.id, status: "delivered", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
            for (const w of aiConns) w.write({ type: "msg_status", agentKey: t, msgId: m0.id, status: "delivered" });
          }
          delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "inprocess" });
        } else if (a.agentStream && !pushDeduped(t, "push:" + kind + tText)) {
          a.agentStream.write({ type: "agent_push", kind, text: tText, payload, at: Date.now() });
          const m = q && q.msg;
          if (m && m.status === "pending") {
            m.status = "delivered";
            appendMsgEvent(t, { type: "status_change", id: randomBytes2(4).toString("hex"), msgId: m.id, status: "delivered", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
            for (const w of aiConns) w.write({ type: "msg_status", agentKey: t, msgId: m.id, status: "delivered" });
          }
          delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "stream+delivered" });
        } else {
          delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "queue" });
        }
      }
    }
    for (const w of aiConns) w.write({ type: "event", from: "bridge", event: "inbox_status", payload: { agentKeys: targets } });
    return { ok: true, delivered, to: targets };
  };
  const deliverUserAnswer = (agentKey2, result) => {
    if (!agentKey2 || !result) return;
    const text = JSON.stringify(result).slice(0, 500);
    const a = agents.get(agentKey2);
    if (a && a.agentStream) a.agentStream.write({ type: "agent_push", kind: "user_answer", text, payload: result, at: Date.now() });
    if (a && typeof a.inProcessSink === "function") {
      try {
        a.inProcessSink(text, "user_answer", result);
      } catch (e) {
        console.error(TAG + " inProcessSink failed", e);
      }
    }
    queueMsg(agentKey2, { kind: "user_answer", from: "page", text, payload: result });
  };
  const formatPageEvent = (eventType, payload, pageInfo) => {
    const where = pageInfo && pageInfo.url ? pageInfo.pageId ? `[${pageInfo.pageId} \xB7 ${pageInfo.url}]` : `[${pageInfo.url}]` : "";
    if (eventType === "page_error") {
      const pl = payload || {};
      return `\u26A0 Page error${where} ${pl.kind || ""} ${String(pl.message || "").slice(0, 300)}` + (pl.stack ? `
${String(pl.stack).slice(0, 400)}` : "");
    }
    if (eventType === "page_log") {
      const items = ((payload || {}).logs || (payload || {}).batch || []).slice(0, 5);
      return `\u{1F4CB} Page logs${where}: ` + items.map((l) => `[${l.level}] ${String(l.text || "").slice(0, 120)}`).join(" | ");
    }
    if (eventType === "page_network") {
      const items = ((payload || {}).requests || (payload || {}).batch || []).slice(0, 5);
      return `\u{1F310} Page network${where}: ` + items.map((r) => `${r.method || "?"} ${String(r.url || "").slice(0, 80)} \u2192 ${r.status ?? "?"}${r.error ? " ERR" : ""}`).join(" | ");
    }
    return `\u{1F4E2} Page event${where}: ${JSON.stringify(payload).slice(0, 200)}`;
  };
  const pushEventToSubscribers = (eventType, payload, pageInfo) => {
    const sigBase = eventType + ":" + JSON.stringify(payload).slice(0, 120);
    const now = Date.now();
    for (const [key, a] of agents) {
      if (!a.subEvents || !a.subEvents.has(eventType)) continue;
      if (!agentOnline(a) && now - (a.offlineAt || a.lastSeen || 0) > BROADCAST_TTL) continue;
      if (pushDeduped(key, sigBase)) {
        console.log(TAG + " push deduped (same event within 5s) " + key + " " + eventType);
        continue;
      }
      const text = formatPageEvent(eventType, payload, pageInfo);
      if (a.agentStream) a.agentStream.write({ type: "page_event", event: eventType, text, pageId: pageInfo && pageInfo.pageId || null, url: pageInfo && pageInfo.url || null, at: Date.now() });
      else {
        queueMsg(key, { kind: "page_" + eventType, from: "page", text, payload });
        console.log(TAG + " push without stream \u2192 outbox " + key + " " + eventType);
      }
    }
  };
  const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extraHeaders }
  });
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type" };
  const pickedReports = /* @__PURE__ */ new Map();
  const pickedFile = dataDir ? join2(dataDir, "picked.json") : "";
  try {
    if (pickedFile && existsSync2(pickedFile)) {
      const saved = JSON.parse(readFileSync(pickedFile, "utf8"));
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved)) if (Array.isArray(v)) pickedReports.set(k, v);
      }
    }
  } catch {
  }
  const persistPicked = () => {
    if (!pickedFile) return;
    try {
      mkdirSync2(dirname2(pickedFile), { recursive: true });
      const tmp = pickedFile + ".tmp";
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(pickedReports)));
      renameSync(tmp, pickedFile);
    } catch {
    }
  };
  const isExpired = (rec) => Date.now() - rec.lastSeen > ID_TTL;
  function randomInstanceId() {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return letters[randomInt(26)] + letters[randomInt(26)] + String(randomInt(100, 1e3));
  }
  function genSecret() {
    return randomBytes2(12).toString("hex");
  }
  function portFromHostUrl(hostUrl) {
    if (!hostUrl || typeof hostUrl !== "string") return null;
    try {
      const u = new URL(hostUrl);
      if (u.port) {
        const n = parseInt(u.port, 10);
        if (n > 0 && n <= 65535) return n;
      }
      const host = (u.hostname || "").toLowerCase();
      const m = host.match(/^(\d{1,5})(?:-port)?[-.]/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n <= 65535) return n;
      }
      const m2 = host.match(/-?(\d{1,5})-port(?=\.|$)/);
      if (m2) {
        const n = parseInt(m2[1], 10);
        if (n > 0 && n <= 65535) return n;
      }
    } catch {
    }
    return null;
  }
  const allocInstanceId = (preferred) => {
    const free = (id) => !pages.has(id) && !idRegistry.has(id);
    if (preferred && free(String(preferred))) return String(preferred);
    for (let i = 0; i < 64; i++) {
      const n = randomInstanceId();
      if (free(n)) return n;
    }
    return randomInstanceId();
  };
  function claimInstanceId(preferred, secret, pageKey, hostUrl) {
    const now = Date.now();
    for (const [id2, rec] of idRegistry) {
      if (!pages.has(id2) && now - rec.lastSeen > ID_TTL) idRegistry.delete(id2);
    }
    if (preferred && idRegistry.has(preferred) && !pages.has(preferred) && !isExpired(idRegistry.get(preferred))) {
      const rec = idRegistry.get(preferred);
      if (secret && rec.secret && secret === rec.secret) {
        rec.lastSeen = now;
        return { instanceId: preferred, secret: rec.secret };
      }
    }
    const id = allocInstanceId(portFromHostUrl(hostUrl));
    const sec = genSecret();
    idRegistry.set(id, { pageKey: pageKey || null, secret: sec, lastSeen: now });
    return { instanceId: id, secret: sec };
  }
  function checkSecret(instanceId, secret) {
    if (!secret) return true;
    const rec = idRegistry.get(instanceId);
    return !!(rec && rec.secret && rec.secret === secret);
  }
  function parsePageId(pageId) {
    if (typeof pageId !== "string") return { instanceId: LEGACY_TOKEN, frameId: null };
    const i = pageId.lastIndexOf("/");
    if (i < 0) return { instanceId: pageId, frameId: null };
    return { instanceId: pageId.slice(0, i), frameId: pageId.slice(i + 1) };
  }
  const validInstance = (id) => id === LEGACY_TOKEN || idRegistry.has(id);
  function resolvePageId(input) {
    if (typeof input !== "string" || !input) return { notFound: true };
    const rows = listSessions().filter((r) => r.active);
    if (rows.some((r) => r.pageId === input)) return { pageId: input };
    const hit = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const u = r.url || "", t = r.title || "";
      if (u && (u === input || u.includes(input)) || t && (t === input || t.includes(input))) hit.set(r.pageId, true);
    }
    if (hit.size === 1) return { pageId: [...hit.keys()][0] };
    if (hit.size > 1) return { multiple: [...hit.keys()] };
    return { notFound: true };
  }
  function resolveAiTarget(pageIdStr) {
    const full = String(pageIdStr || "");
    if (!full) return null;
    const pid = parsePageId(full);
    if (pid.frameId === "ai") {
      for (const [w, rec] of aiSelfReg) {
        if (String(rec.instanceId) === String(pid.instanceId)) return { w, via: "self", frameId: "ai", connInstanceId: String(rec.instanceId) };
      }
      for (const [w, rec] of aiPageReg) {
        if (rec.pageId && String(rec.instanceId) === String(pid.instanceId)) return { w, via: "self", frameId: "ai", connInstanceId: String(rec.instanceId) };
      }
    }
    let hit = null;
    let bestSeen = 0;
    for (const [w, rec] of aiPageReg) {
      if (!rec.pageId) continue;
      const baseId = String(rec.pageId).replace(/\/host$/, "");
      if (rec.pageId === full || baseId && full.indexOf(baseId + "/") === 0) {
        if (!hit || (rec.lastSeen || 0) > bestSeen) {
          hit = { w, rec, baseId };
          bestSeen = rec.lastSeen || 0;
        }
      }
    }
    if (!hit) {
      if (pid.frameId === "host") {
        for (const [w, rec] of aiSelfReg) {
          if (String(rec.instanceId) === String(pid.instanceId)) return { w, via: "ai", frameId: "host", connInstanceId: String(rec.instanceId) };
        }
      }
      return null;
    }
    const frame = full.length > String(hit.baseId).length ? full.slice(String(hit.baseId).length + 1) : "host";
    return { w: hit.w, via: "ai", frameId: frame || "host", connInstanceId: String(hit.rec.instanceId) };
  }
  const withDevice = (row, dev, label) => {
    if (dev && typeof dev === "object") {
      row.device = dev;
      row.deviceLabel = label || [dev.browser || "?", dev.os || "", dev.screen || ""].filter(Boolean).join(" \xB7 ");
    }
    return row;
  };
  function listSessions(boundPageId) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const addMine = (row) => {
      row.mine = !!(boundPageId && row.pageId === boundPageId);
    };
    for (const [instanceId, page] of pages) {
      for (const frameId of page.frames) {
        const fi = page.frameInfo && page.frameInfo.get(frameId) || null;
        const isHost = frameId === "host";
        const fUrl = fi && fi.url || (isHost ? page.url : null);
        const fTitle = fi && fi.title || (isHost ? page.title : null);
        const row = {
          instanceId,
          frameId,
          pageId: instanceId + "/" + frameId,
          url: page.url,
          title: page.title || null,
          frameworks: page.frameworks,
          active: true,
          lastSeen: Date.now(),
          frameUrl: fUrl || null,
          frameTitle: fTitle || null,
          frameName: fi && fi.name || "",
          frameSrc: fi && fi.src || "",
          frameParent: isHost ? null : fi && fi.parentId || null,
          root: isHost || !(fi && fi.parentId)
        };
        withDevice(row, page.device, page.deviceLabel);
        seen.add(row.pageId);
        addMine(row);
        out.push(row);
      }
    }
    for (const [instanceId, rec] of idRegistry) {
      if (!pages.has(instanceId) && !isExpired(rec)) {
        const row = { instanceId, frameId: null, pageId: null, url: null, frameworks: null, active: false, lastSeen: rec.lastSeen, pageKey: rec.pageKey };
        addMine(row);
        out.push(row);
      }
    }
    const aiByBase = /* @__PURE__ */ new Map();
    for (const [w, rec] of aiPageReg) {
      if (!rec.pageId) continue;
      const baseId = String(rec.pageId).replace(/\/host$/, "");
      const prev = aiByBase.get(baseId);
      const prevScore = (prev && prev.frames && prev.frames.length ? prev.frames.length : 0) * 100 + (prev ? prev.lastSeen : 0);
      const recScore = (rec.frames && rec.frames.length ? rec.frames.length : 0) * 100 + rec.lastSeen;
      if (!prev || recScore > prevScore) aiByBase.set(baseId, rec);
    }
    for (const [baseId, rec] of aiByBase) {
      const fr = rec.frames || null;
      if (!fr || !fr.length) {
        if (seen.has(rec.pageId)) continue;
        seen.add(rec.pageId);
        const aiRow1 = { instanceId: rec.instanceId, frameId: null, pageId: rec.pageId, url: rec.url || null, title: rec.title || null, frameworks: null, active: true, viaAI: true, lastSeen: rec.lastSeen };
        withDevice(aiRow1, rec.device, rec.deviceLabel);
        addMine(aiRow1);
        out.push(aiRow1);
        continue;
      }
      for (const f of fr) {
        const fid = String(f.id || "host");
        const isHost = fid === "host";
        const rowPageId = baseId + "/" + fid;
        if (seen.has(rowPageId)) continue;
        seen.add(rowPageId);
        const frRow = {
          instanceId: rec.instanceId,
          frameId: fid,
          pageId: rowPageId,
          url: rec.url || null,
          title: rec.title || null,
          frameworks: null,
          active: true,
          viaAI: true,
          lastSeen: rec.lastSeen,
          frameUrl: f && f.url || (isHost ? rec.url : null) || null,
          frameTitle: f && f.title || (isHost ? rec.title : null) || null,
          frameName: f && f.name || "",
          frameSrc: f && f.src || "",
          frameParent: isHost ? null : f && f.parentId || null,
          root: isHost || !(f && f.parentId)
        };
        withDevice(frRow, rec.device, rec.deviceLabel);
        addMine(frRow);
        out.push(frRow);
      }
    }
    for (const [w, rec] of aiSelfReg) {
      const selfPageId = String(rec.instanceId) + "/ai";
      if (seen.has(selfPageId)) continue;
      seen.add(selfPageId);
      const selfRow = { instanceId: rec.instanceId, frameId: "ai", pageId: selfPageId, url: rec.url || null, title: rec.title ? rec.title + " \xB7 AI main window" : "AI main window", frameworks: null, active: true, viaAI: true, self: true, lastSeen: rec.lastSeen };
      withDevice(selfRow, rec.device, rec.deviceLabel);
      addMine(selfRow);
      out.push(selfRow);
    }
    for (const [w, rec] of aiPageReg) {
      if (rec.pageId) continue;
      const self2 = aiSelfReg.get(w);
      const iid = self2 && String(self2.instanceId);
      const fbPageId = iid ? iid + "/host" : null;
      if (!fbPageId || seen.has(fbPageId)) continue;
      seen.add(fbPageId);
      const fbRow = { instanceId: iid, frameId: "host", pageId: fbPageId, url: rec.url || self2 && self2.url || null, title: rec.title || self2 && self2.title || null, frameworks: null, active: true, viaAI: true, lastSeen: rec.lastSeen };
      withDevice(fbRow, self2 && self2.device, self2 && self2.deviceLabel);
      addMine(fbRow);
      out.push(fbRow);
    }
    return out;
  }
  const TOOLS = BRIDGE_TOOLS;
  const settlePending = (requestId, ok, result) => {
    const r = pendingRequests.get(requestId);
    if (!r) return false;
    pendingRequests.delete(requestId);
    if (r.mcpReqId) mcpReqMap.delete(r.mcpReqId);
    if (r.cancelId) cancelIdMap.delete(r.cancelId);
    try {
      if (r.signal && r.onAbort) r.signal.removeEventListener("abort", r.onAbort);
    } catch {
    }
    r.resolve({ ok, result });
    return true;
  };
  const cancelPending = (requestId, reason) => {
    const r = pendingRequests.get(requestId);
    if (!r) return false;
    const ist = interactionTimers.get(requestId);
    if (ist) {
      clearTimeout(ist.timer);
      interactionTimers.delete(requestId);
    }
    const result = { status: "cancelled", error: reason, cancelled: true, tookMs: Date.now() - (r.t0 || Date.now()), ...ist ? { timeoutMs: ist.ms, pausedMs: ist.pausedMs } : {} };
    settlePending(requestId, false, result);
    for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result });
    console.log(TAG + " \u2702 request cancelled: " + requestId + " \xB7 " + reason);
    return true;
  };
  const SNAPSHOT_FALLBACK = `(() => {
    try {
      var isVis = function (el) {
        if (!el) return false;
        if (el.getClientRects && el.getClientRects().length > 0) return true;
        try { return el.offsetParent !== null; } catch (e) { return false; }
      };
      var label = function (el) {
        return (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '').trim().slice(0, 60);
      };
      var pack = function (el) {
        var r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), text: label(el), id: el.id || undefined,
          name: el.getAttribute('name') || undefined, type: el.getAttribute('type') || undefined,
          href: (el.tagName === 'A' && el.getAttribute('href')) ? el.getAttribute('href').slice(0, 80) : undefined,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
      };
      var els = [].slice.call(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="tab"],[role="dialog"],[role="alertdialog"]')).filter(isVis).slice(0, 60);
      return JSON.stringify({
        url: location.href.slice(0, 300), title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) },
        selected: String(window.getSelection ? window.getSelection().toString() : '').slice(0, 120) || undefined,
        elements: els.map(pack),
        textHead: (document.body && document.body.innerText ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 600)
      });
    } catch (e) { return JSON.stringify({ error: 'snapshot fallback failed: ' + (e && e.message) }); }
  })()`;
  const SELF_UI_SCAN = `(() => {
    try {
      var out = { dialogs: [] };
      var isVis = function (el) {
        if (!el) return false;
        if (el.getClientRects && el.getClientRects().length > 0) return true;
        try { return el.offsetParent !== null; } catch (e) { return false; }
      };
      var hits = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-dialog], [data-role="dialog"], .dialog, .modal, [class*="dialog"], [class*="modal"]');
      var dialogs = [];
      for (var i = 0; i < hits.length && dialogs.length < 8; i++) {
        var d = hits[i];
        if (!isVis(d)) continue;
        if (d.closest && d.closest('#__dbg_launcher')) continue; // \u6392\u9664 aiti \u81EA\u8EAB
        var already = false;
        for (var j = 0; j < dialogs.length; j++) if (dialogs[j].contains(d)) { already = true; break; }
        if (already) continue;
        if (d.parentElement && dialogs.indexOf(d.parentElement) >= 0) continue;
        dialogs.push(d);
      }
      if (!dialogs.length) {
        // \u515C\u5E95\uFF1A\u53EF\u89C1\u7684 fixed/absolute \u9762\u677F\uFF08\u5BBD\u5EA6 > 40% \u89C6\u53E3\u4E14 zIndex \u9AD8\uFF09
        var all = document.querySelectorAll('div, section, aside');
        for (var k = 0; k < all.length && dialogs.length < 4; k++) {
          var e = all[k];
          if (!isVis(e)) continue;
          var st = getComputedStyle(e);
          if (st.position !== 'fixed' && st.position !== 'absolute') continue;
          var r = e.getBoundingClientRect();
          if (r.width < window.innerWidth * 0.4 || r.height < 200) continue;
          if (e.closest && e.closest('#__dbg_launcher')) continue;
          dialogs.push(e);
        }
      }
      for (var m = 0; m < dialogs.length; m++) {
        var dlg = dialogs[m];
        var titleEl = dlg.querySelector('[class*="title"], h1, h2, h3, header, [role="heading"]');
        var title = titleEl ? String((titleEl.innerText || titleEl.textContent || '').trim()).slice(0, 60) : '';
        var fields = [];
        var inputs = dlg.querySelectorAll('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]');
        for (var n = 0; n < inputs.length && fields.length < 20; n++) {
          var f = inputs[n];
          if (f.type === 'hidden') continue;
          var isCE = f.isContentEditable || (f.tagName !== 'INPUT' && f.tagName !== 'TEXTAREA' && f.tagName !== 'SELECT' && f.hasAttribute && f.hasAttribute('contenteditable'));
          var label = '';
          try { if (!isCE && f.labels && f.labels.length && f.labels[0].innerText) label = f.labels[0].innerText.trim(); } catch (e) {}
          if (!label && f.placeholder) label = String(f.placeholder).trim();
          if (!label && f.name) label = String(f.name);
          if (!label && f.id) label = '#' + f.id;
          if (!label && isCE) label = String((f.getAttribute && (f.getAttribute('data-placeholder') || f.getAttribute('aria-label'))) || (f.innerText || '').trim()).slice(0, 40) || ('editable area ' + (n + 1));
          var sel = f.id ? ('#' + String(f.id).replace(/([^a-zA-Z0-9_-])/g, '\\$1')) : (f.name ? ('[name="' + String(f.name).replace(/"/g, '\\"') + '"]') : (isCE ? null : ''));
          fields.push({ label: String(label).slice(0, 40), selector: sel, type: isCE ? 'contenteditable' : (f.type || 'text'), value: String(isCE ? ((f.innerText || f.textContent || '')) : (f.value || '')).slice(0, 60) });
        }
        var buttons = [];
        var btns = dlg.querySelectorAll('button, [role="button"]');
        for (var b = 0; b < btns.length && buttons.length < 10; b++) {
          if (!isVis(btns[b])) continue;
          var bt = String((btns[b].innerText || btns[b].getAttribute('aria-label') || '').trim()).slice(0, 30);
          if (bt) buttons.push(bt);
        }
        out.dialogs.push({ title: title, fields: fields, buttons: buttons });
      }
      return out;
    } catch (e) { return { error: String((e && e.message) || e) }; }
  })()`;
  function pickSelfPageId() {
    let best = null, bestSeen = 0;
    for (const r of listSessions()) {
      if (r.self && (r.lastSeen || 0) > bestSeen) {
        best = r.pageId;
        bestSeen = r.lastSeen || 0;
      }
    }
    return best || null;
  }
  const FORM_FILL_FN = `function (opts) {
    try {
      var isVis = function (el) { return !!(el && (el.getClientRects().length > 0 || el.offsetParent !== null)); };
      var cands = Array.prototype.filter.call(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-dialog], .dialog, .modal, [class*="dialog"], [class*="modal"]'), isVis);
      var dialog = null;
      if (opts && opts.dialog !== undefined && opts.dialog !== null && String(opts.dialog) !== '') {
        var q = String(opts.dialog);
        var idx = /^\\d+$/.test(q) ? parseInt(q, 10) : -1;
        if (idx >= 0 && idx < cands.length) dialog = cands[idx];
        else dialog = cands.find(function (d) {
          var t = ((d.querySelector('h1,h2,h3,[class*="title"],header,[role="heading"]') || {}).textContent || '');
          return (d.textContent || '').indexOf(q) >= 0 || t.indexOf(q) >= 0;
        }) || null;
      } else {
        var best = null, bestArea = 0;
        for (var i = 0; i < cands.length; i++) {
          var r = cands[i].getBoundingClientRect();
          var area = r.width * r.height;
          if (area > bestArea) { bestArea = area; best = cands[i]; }
        }
        dialog = best;
      }
      if (!dialog) return { foundDialog: false, filled: 0, missed: 0, clicked: false, error: 'no visible dialog found (use self_ui first to confirm the dialog is open)' };
      var setNative = function (el, value) {
        var text = String(value == null ? '' : value);
        // contenteditable\uFF08\u5BCC\u6587\u672C/<p> \u53EF\u7F16\u8F91\u5757\uFF09\uFF1A\u6D4F\u89C8\u5668\u539F\u751F\u8F93\u5165\u8DEF\u5F84\uFF08\u771F\u5B9E\u952E\u5165\uFF0C\u7B49\u4EF7 CDP Input.insertText\uFF09\u2014\u2014
        // execCommand('insertText') \u89E6\u53D1\u771F\u5B9E beforeinput/input(inputType=insertText)\uFF0CReact onChange \u6B63\u786E\u63A5\u6536\uFF0C\u503C\u4E0D\u88AB\u91CD\u7F6E
        if (el.isContentEditable || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT' && el.hasAttribute && el.hasAttribute('contenteditable'))) {
          try { el.focus(); } catch (e) {}
          try {
            var sel = window.getSelection();
            if (sel) {
              var range = document.createRange();
              range.selectNodeContents(el);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          } catch (e) {}
          var done = false;
          try { done = document.execCommand('insertText', false, text); } catch (e) {}
          if (!done) {
            try { el.textContent = text; } catch (e) {}
            try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' })); }
            catch (e) { try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {} }
          }
          return;
        }
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, text); else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      var findField = function (f) {
        if (f.selector) { try { var el = dialog.querySelector(f.selector); if (el) return el; } catch (e) {} }
        if (f.label) {
          var l = String(f.label);
          var labels = Array.prototype.filter.call(dialog.querySelectorAll('label'), function (x) { return (x.textContent || '').trim() === l || (x.textContent || '').indexOf(l) >= 0; });
          for (var j = 0; j < labels.length; j++) {
            var lb = labels[j];
            if (lb.htmlFor) { try { var fe = dialog.querySelector('#' + String(lb.htmlFor).replace(/([^a-zA-Z0-9_\\-])/g, '\\\\$1')); if (fe) return fe; } catch (e) {} }
            var inl = lb.querySelector('input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""]'); if (inl) return inl;
          }
          // \u515C\u5E95\uFF1Acontenteditable \u65E0 <label> \u65F6\u6309 aria-label/data-placeholder \u5339\u914D\uFF08self_ui \u5DF2\u5217\u51FA\uFF09
          var ces = dialog.querySelectorAll('[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""]');
          for (var c = 0; c < ces.length; c++) {
            var ce = ces[c];
            var al = (ce.getAttribute && (ce.getAttribute('aria-label') || ce.getAttribute('data-placeholder'))) || '';
            if (al && (al === l || al.indexOf(l) >= 0)) return ce;
          }
        }
        return null;
      };
      var filled = 0, missed = 0;
      var fields = (opts && Array.isArray(opts.fields)) ? opts.fields : [];
      for (var k = 0; k < fields.length; k++) {
        var f = fields[k];
        if (!f || typeof f !== 'object' || f.value === undefined) continue;
        var tgt = findField(f);
        if (tgt) { setNative(tgt, f.value); filled++; } else missed++;
      }
      var clicked = false;
      if (opts && opts.button) {
        var btns = dialog.querySelectorAll('button, [role="button"]');
        var b = null;
        for (var m = 0; m < btns.length; m++) { if ((btns[m].textContent || '').trim().indexOf(String(opts.button)) >= 0) { b = btns[m]; break; } }
        if (b) { try { b.click(); clicked = true; } catch (e) {} }
      }
      return { foundDialog: true, title: ((dialog.querySelector('h1,h2,h3,[class*="title"],header') || {}).textContent || '').slice(0, 60), filled: filled, missed: missed, clicked: clicked };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  }`;
  ;
  const devShortLabel = (d) => d ? [d.browser, d.os].filter(Boolean).join(" \xB7 ") || null : null;
  const deviceShort = (pid) => {
    try {
      if (!pid) return null;
      const s = String(pid);
      let dev = null;
      let iid = null;
      try {
        const p = parsePageId(s);
        iid = String(p.instanceId);
        dev = pages.get(iid)?.device || null;
      } catch {
      }
      if (!dev) {
        for (const rec of aiPageReg.values()) {
          const base = String(rec.pageId || "").replace(/\/host$/, "");
          if (String(rec.pageId) === s || base && base === s) {
            dev = rec.device;
            break;
          }
        }
        if (!dev && iid) {
          for (const rec of aiSelfReg.values()) if (String(rec.instanceId) === iid) {
            dev = rec.device;
            break;
          }
        }
      }
      return devShortLabel(dev);
    } catch {
      return null;
    }
  };
  function execOnPage(cmd, args, pageId, signal, mcpReqId, cancelId, src) {
    const { instanceId, frameId } = parsePageId(pageId || LEGACY_TOKEN);
    const page = pages.get(instanceId);
    return new Promise((resolve) => {
      const requestId = "mcp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const rec = { resolve, agentId: null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
      pendingRequests.set(requestId, rec);
      if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
      if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
      const srcExt = src && src.agentId ? { agentId: src.agentId || null, agentName: src.agentName || null, agentSessionUrl: src.agentSessionUrl || null, targetDevice: src.targetDevice || null } : {};
      rec.onAbort = () => cancelPending(requestId, "cancelled (agent stopped)");
      if (signal) {
        if (signal.aborted) {
          cancelPending(requestId, "cancelled (agent stopped)");
          return;
        }
        rec.signal = signal;
        signal.addEventListener("abort", rec.onAbort, { once: true });
      }
      console.log(TAG + " exec \u2192", cmd, JSON.stringify(args || {}), "\u2192 pageId=" + pageId);
      if (page) {
        if (!page.writer.write({ type: "exec", requestId, cmd, args: args || {}, frameId, ...srcExt })) {
          const irec = idRegistry.get(instanceId);
          if (irec) irec.lastSeen = Date.now();
          pages.delete(instanceId);
          settlePending(requestId, false, { error: "page connection lost (retry after reconnect)" });
          return;
        }
      } else if (frameId === "ai" && aiSelfReg.size > 0) {
        let target = null, bestSeen = 0;
        for (const [w, rec2] of aiSelfReg) {
          if (String(rec2.instanceId) === String(instanceId) && (rec2.lastSeen || 0) > bestSeen) {
            target = w;
            bestSeen = rec2.lastSeen || 0;
          }
        }
        if (target) {
          if (!target.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "self", ...srcExt })) {
            aiConns.delete(target);
            aiSelfReg.delete(target);
            settlePending(requestId, false, { error: "target AI main window connection lost (auto-reconnects after refresh)" });
            return;
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "self", ...srcExt });
        } else {
          setTimeout(() => settlePending(requestId, false, { error: "no executor (AI main window not connected); connect the bridge first" }), 100);
          return;
        }
      } else if (aiPageReg.size > 0) {
        let target = null, targetRec = null, viaFrameId = null, bestSeen = 0;
        for (const [w, rec2] of aiPageReg) {
          const baseId = String(rec2.pageId || "").replace(/\/host$/, "");
          if (rec2.pageId === pageId || baseId && pageId && String(pageId).indexOf(baseId + "/") === 0) {
            if (!target || (rec2.lastSeen || 0) > bestSeen) {
              target = w;
              targetRec = rec2;
              bestSeen = rec2.lastSeen || 0;
            }
          }
        }
        if (target && targetRec) {
          const baseId = String(targetRec.pageId || "").replace(/\/host$/, "");
          if (pageId && baseId && String(pageId).indexOf(baseId + "/") === 0) viaFrameId = String(pageId).slice(baseId.length + 1) || "host";
          if (!target.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai", frameId: viaFrameId, ...srcExt })) {
            aiConns.delete(target);
            aiPageReg.delete(target);
            settlePending(requestId, false, { error: "target AI window connection lost (auto-reconnects after page refresh; retry shortly)" });
            return;
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai", ...srcExt });
        } else {
          setTimeout(() => settlePending(requestId, false, { error: "no executor (neither page nor AI channel connected); connect the bridge first" }), 100);
          return;
        }
      } else if (aiConns.size > 0) {
        for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai", ...srcExt });
      } else {
        setTimeout(() => settlePending(requestId, false, { error: "no executor (neither page nor AI channel connected); connect the bridge first" }), 100);
        return;
      }
      const SLOW_EXEC_CMDS = /* @__PURE__ */ new Set([
        "Page.captureScreenshot",
        "Browser.paste",
        "Browser.pickFile",
        "Browser.share",
        "DOM.removeNode",
        "Page.reload",
        "Page.navigate",
        "Storage.localStorageClear",
        "Storage.localStorageSet"
      ]);
      const slowNet = (function() {
        if (!SLOW_EXEC_CMDS.has(cmd)) return 15e3;
        if (cmd === "Page.captureScreenshot") {
          const n = parseInt(args && args.timeout, 10);
          if (n > 0) return Math.min(Math.max(n + 3e4, 6e4), 36e5);
        }
        return 3e5;
      })();
      setTimeout(() => settlePending(requestId, false, { error: "page execution timed out" + (SLOW_EXEC_CMDS.has(cmd) ? " (user did not finish confirming/choosing)" : "") }), slowNet);
    });
  }
  const INTERACTION_MAX_TIMEOUT_MS = 6e5;
  const INTERACTION_MIN_TIMEOUT_MS = 5e3;
  const clampTimeout = (ms) => {
    const n = parseInt(ms, 10);
    if (!n || n <= 0) return 0;
    return Math.min(Math.max(n, INTERACTION_MIN_TIMEOUT_MS), INTERACTION_MAX_TIMEOUT_MS);
  };
  const interactionTimers = /* @__PURE__ */ new Map();
  const pauseInteraction = (requestId) => {
    const st = interactionTimers.get(requestId);
    if (!st) return { ok: false, error: "unknown interaction" };
    if (st.paused) return { ok: true, paused: true, remainingMs: st.remaining };
    clearTimeout(st.timer);
    st.remaining = Math.max(0, st.deadline - Date.now());
    st.paused = true;
    st.pausedAt = Date.now();
    console.log(TAG + " interaction \u23F8 paused requestId=" + requestId + " remaining=" + st.remaining + "ms");
    return { ok: true, paused: true, remainingMs: st.remaining };
  };
  const resumeInteraction = (requestId) => {
    const st = interactionTimers.get(requestId);
    if (!st) return { ok: false, error: "unknown interaction" };
    if (!st.paused) return { ok: true, paused: false, remainingMs: Math.max(0, st.deadline - Date.now()) };
    if (st.pausedAt) st.pausedMs += Date.now() - st.pausedAt;
    st.pausedAt = null;
    st.paused = false;
    st.remaining = Math.max(0, st.remaining);
    st.deadline = Date.now() + st.remaining;
    const fire = () => {
      if (!interactionTimers.delete(requestId)) return;
      const result = { status: "timeout", error: "user not responding (offline or unhandled)", tookMs: Date.now() - st.t0, timeoutMs: st.ms, pausedMs: st.pausedMs };
      if (settlePending(requestId, false, result)) {
        for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result });
      }
    };
    if (st.remaining <= 0) {
      fire();
      return { ok: true, paused: false, remainingMs: 0, timedOut: true };
    }
    st.timer = setTimeout(fire, st.remaining);
    console.log(TAG + " interaction \u25B6 resumed requestId=" + requestId + " remaining=" + st.remaining + "ms");
    return { ok: true, paused: false, remainingMs: st.remaining };
  };
  const clearInteractionTimer = (requestId) => {
    const st = interactionTimers.get(requestId);
    if (st) {
      clearTimeout(st.timer);
      interactionTimers.delete(requestId);
    }
  };
  function interactOnPage(interaction, pageId, timeoutMs, signal, mcpReqId, cancelId) {
    const { instanceId, frameId } = parsePageId(pageId || LEGACY_TOKEN);
    const page = pages.get(instanceId);
    let aiTarget = null;
    let aiTargetVia = "self";
    let aiTargetFrameId = "ai";
    if (frameId === "ai") {
      for (const [w, rec] of aiSelfReg) if (rec.instanceId === instanceId) {
        aiTarget = w;
        break;
      }
    }
    if (!aiTarget) {
      const t = resolveAiTarget(pageId || "");
      if (t) {
        aiTarget = t.w;
        aiTargetVia = t.via;
        aiTargetFrameId = t.frameId;
      }
    }
    const ms = clampTimeout(timeoutMs);
    const t0 = Date.now();
    const payload = { ...interaction, timeoutMs: ms };
    const isAsync = !!payload.async;
    return new Promise((resolve) => {
      const requestId = "ui_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      if (isAsync) {
        console.log(TAG + " interaction (async) \u2192 kind=" + payload.kind + " \xB7 " + String(payload.prompt || "").slice(0, 60) + " \u2192 pageId=" + pageId + (payload.agentId ? " \xB7 agent=" + payload.agentId : ""));
        resolve({ ok: true, result: { status: "async", message: "dispatched async: once the user answers, the result lands in the initiating agent\u2019s (" + (payload.agentId || "?") + ") aiti_inbox" } });
      } else {
        const rec = { resolve, agentId: payload.agentId || null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
        pendingRequests.set(requestId, rec);
        if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
        if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
        rec.onAbort = () => cancelPending(requestId, "cancelled (agent stopped)");
        if (signal) {
          if (signal.aborted) {
            cancelPending(requestId, "cancelled (agent stopped)");
            return;
          }
          rec.signal = signal;
          signal.addEventListener("abort", rec.onAbort, { once: true });
        }
        console.log(TAG + " interaction \u2192 kind=" + payload.kind + " \xB7 " + String(payload.prompt || "").slice(0, 60) + " \u2192 pageId=" + pageId + " \xB7 timeout=" + (ms > 0 ? ms + "ms" : "\u221E (wait forever)") + (payload.agentId ? " \xB7 agent=" + payload.agentId : ""));
      }
      const noExecutor = () => {
        clearInteractionTimer(requestId);
        cancelPending(requestId, "no executor (neither page nor AI channel connected); connect the bridge first");
      };
      if (aiTarget) {
        const env = { type: "interaction", requestId, interaction: payload, frameId: aiTargetFrameId };
        if (aiTargetVia === "ai") env.pageId = pageId;
        env.via = aiTargetVia;
        if (!aiTarget.write(env)) {
          aiConns.delete(aiTarget);
          aiSelfReg.delete(aiTarget);
          aiPageReg.delete(aiTarget);
          if (aiConns.size > 0) {
            for (const w of aiConns) w.write({ type: "interaction", requestId, interaction: payload, pageId, via: "ai" });
          } else return noExecutor();
        }
      } else if (payload.kind === "pick_element") {
        if (page) {
          if (!page.writer.write({ type: "interaction", requestId, interaction: payload, frameId })) {
            pages.delete(instanceId);
            return noExecutor();
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "interaction", requestId, interaction: payload, pageId, via: "ai" });
        } else return noExecutor();
      } else {
        if (page) {
          if (!page.writer.write({ type: "interaction", requestId, interaction: payload, frameId })) {
            pages.delete(instanceId);
            return noExecutor();
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "interaction", requestId, interaction: payload, pageId, via: "ai" });
        } else return noExecutor();
      }
      if (!isAsync && ms > 0) {
        const st = { timer: null, deadline: Date.now() + ms, remaining: ms, paused: false, pausedAt: null, pausedMs: 0, ms, t0, resolve };
        interactionTimers.set(requestId, st);
        st.timer = setTimeout(() => {
          if (!interactionTimers.delete(requestId)) return;
          const result = { status: "timeout", error: "user not responding (offline or unhandled)", tookMs: Date.now() - t0, timeoutMs: ms, pausedMs: st.pausedMs };
          if (settlePending(requestId, false, result)) {
            for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result });
          }
        }, ms);
      }
    });
  }
  function handleMcpRequest(req, session = null, signal = null, cancelId = null) {
    const params = req.params || {};
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: params.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: DISPLAY_NAME, version: "0.2" },
          instructions: [
            "aiti-devtools: in-page AI debug assistant (browser bridge).",
            "Workflow: messages from pages usually carry a pageId. Without one, discover connected pages with bridge_status first (returns sessions with pageId/url/title/frameworks/device \u2014 the deviceLabel line's browser\xB7screen\xB7online\xB7language quickly tells which machine and which tab) \u2192 pass that pageId to the target tool.",
            "pageId format is instanceId/frameId (e.g. 3001/host); url or page title also accepted; when several match, disambiguate with a concrete pageId.",
            "page_exec: run a CDP-like command on a connected page (DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser domains). args is the command params object. Dangerous commands (navigation/download/dialogs etc.) pop a user confirmation automatically. For screenshots (Page.captureScreenshot) always pass reason in args (one sentence telling the user what you want to capture \u2014 the page first pops a prep card with that note and capture starts only after the user adjusts the page).",
            "page_snapshot: pull the target page's basic live state (URL / selection / emulation overrides).",
            "page_logs / page_network: first choices for page-error / failed-request triage \u2014 page_logs reads the console (level/since/limit filters; start at warn/error); page_network reads ajax/fetch completions (status\u2265400 or errorOnly:true for failures only). Both read the page's local ring buffer (CDP Runtime.evaluate on demand; no longer reported live).",
            "user_confirm / user_choose / user_input / user_pick_element / user_presence: collaborate with the human user on the page \u2014 prompt is shown to the user; by default synchronous and waiting forever (no timeout passed: the panel stays until the user answers, no countdown; only pass timeout ms when you truly need a timeboxed nudge \u2014 the panel then shows a pausable countdown and returns status:'timeout' on expiry), response envelope {status:'answered'|'rejected'|'timeout'|'error', value?, reason?, tookMs, timeoutMs}. Pass async:true to return immediately (the result arrives via the AI message window).",
            "user_notify: non-blocking browser notification, does not wait for an answer.",
            "Device interconnect: bridge_status returns devices (kind=page/agent/pair unified view) \u2014 aiti_pair_send texts any device, aiti_pair_file pushes local files, aiti_pair_fetch retrieves received files (fileId in an aiti_inbox message payload.file); opening the pi-web page in any browser brings it online in the device panel.",
            "Common recipes: page error \u2192 page_logs(level:warn/error) or page_network(errorOnly:true); operate the page \u2192 page_exec(cmd:'Runtime.evaluate', args:{expression:'...'}); locate an element \u2192 page_snapshot then page_exec, or ask the user with user_pick_element."
          ].join("\n")
        };
      case "notifications/initialized":
        return null;
      case "notifications/cancelled": {
        const rid = params && params.requestId !== void 0 ? String(params.requestId) : "";
        if (rid) {
          const internalId = mcpReqMap.get(rid);
          if (internalId) cancelPending(internalId, "cancelled (MCP notifications/cancelled)");
        }
        return null;
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "resources/list":
        return { resources: [] };
      case "tools/call": {
        const a = params.arguments || {};
        const rawArgs = (() => {
          let x = a.args;
          if (typeof x === "string") {
            try {
              x = JSON.parse(x);
            } catch {
            }
          }
          return x && typeof x === "object" ? x : {};
        })();
        const cmdRaw = a.cmd || rawArgs.cmd || a.command || rawArgs.command;
        const cmd = typeof cmdRaw === "string" && cmdRaw.includes(".") ? cmdRaw.replace(/^./, (c) => c.toUpperCase()) : cmdRaw;
        const pageId = a.pageId || rawArgs.pageId || a.target || rawArgs.target;
        const cmdArgs = { ...rawArgs };
        delete cmdArgs.cmd;
        delete cmdArgs.command;
        delete cmdArgs.pageId;
        delete cmdArgs.target;
        delete cmdArgs.token;
        const recAgentKey = session && session.agentKey || (session && session.agentId ? session.agentId + (session.id ? "/" + session.id : "") : null) || null;
        const agentSrc = () => {
          const key = session && session.agentKey || (session && session.agentId ? session.agentId + (session.id ? "/" + session.id : "") : null) || a.agentId || null;
          const agRec = key ? agents.get(String(key)) : null;
          return { agentId: key || null, agentName: agRec && agRec.name || null, agentSessionUrl: agRec && agRec.sessionUrl || null };
        };
        const recToolCall = (text, ok, detail) => {
          if (!recAgentKey) return;
          const m = { id: randomBytes2(4).toString("hex"), kind: "agent_tool", from: "agent", agentKey: recAgentKey, agentId: recAgentKey.split("/")[0], sessionId: recAgentKey.split("/").slice(1).join("/") || null, source: (agents.get(recAgentKey) || {}).source || "unknown", text: String(text).slice(0, 2e3), detail: detail === void 0 ? null : typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 4e3), at: (/* @__PURE__ */ new Date()).toISOString(), status: ok ? "ok" : "error" };
          appendMsgEvent(recAgentKey, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
          for (const w of aiConns) w.write({ type: "agent_answer", agentKey: recAgentKey, agentId: recAgentKey.split("/")[0], ok, text: m.text, at: m.at, detail: m.detail });
        };
        if (params.name === "bridge_status") {
          const curAgentKey = session && session.agentKey || (session && session.agentId ? session.agentId + (session.id ? "/" + session.id : "") : null) || null;
          const boundPageId = curAgentKey && agents.get(curAgentKey) && agents.get(curAgentKey).boundPageId || null;
          const sess = listSessions(boundPageId);
          const devices = listDevices();
          const resp = { sessions: sess, activePageId: boundPageId || null, devices };
          recToolCall("\u{1F6E0} bridge_status \u2192 " + sess.length + " connected page(s) \xB7 " + devices.length + " device(s)" + (boundPageId ? " \xB7 bound: " + boundPageId : ""), true, resp);
          return { content: [{ type: "text", text: JSON.stringify(resp) }], isError: false };
        }
        if (params.name === "aiti_pair_send") {
          const text = String(a.text || "").slice(0, 64e3);
          if (!text.trim()) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "bad request (text required)" }) }], isError: true };
          const me = { id: recAgentKey || "agent", name: (recAgentKey && agents.get(recAgentKey) || {}).name || recAgentKey || "agent", kind: "agent" };
          if (!a.to || !String(a.to).trim()) {
            const cands = [
              ...listDevices().filter((d) => d.kind === "page").map((d) => ({ kind: "page", id: d.id, name: d.name })),
              ...listAgentSessions().filter((x) => x.agentKey !== recAgentKey).map((x) => ({ kind: "agent", id: x.agentKey, name: x.name })),
              ...pair.listPeers().map((pd) => ({ kind: "pair", id: pd.id, name: pd.name || pd.id }))
            ];
            const resp = { ok: false, error: 'to not specified \u2014 default broadcast is no longer allowed (broadcasting requires explicit to:"all"); pick a target id/name from bridge_status devices and retry', candidates: cands };
            recToolCall('\u{1F6E0} aiti_pair_send \u2192 declined default broadcast (broadcasting requires explicit to:"all")', false, resp);
            return { content: [{ type: "text", text: JSON.stringify(resp) }], isError: true };
          }
          const r = routePairSend(me, String(a.to), { text });
          recToolCall("\u{1F6E0} aiti_pair_send(" + a.to + ") \u2192 " + (r.ok ? "delivered to " + (r.delivered || []).length + " endpoint(s)" : r.error || "failed"), !!r.ok, r);
          return { content: [{ type: "text", text: JSON.stringify(r.ok ? { ok: true, delivered: r.delivered } : r) }], isError: !r.ok };
        }
        if (params.name === "aiti_pair_file") {
          const fp = String(a.path || "").trim();
          const to = String(a.to || "").trim();
          if (!fp || !to) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "bad request (to/path required)" }) }], isError: true };
          let st = null;
          try {
            st = statSync2(fp);
          } catch {
          }
          if (!st || !st.isFile()) {
            recToolCall("\u{1F6E0} aiti_pair_file \u2192 file not found: " + fp, false);
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "file not found: " + fp }) }], isError: true };
          }
          const me = { id: recAgentKey || "agent", name: (recAgentKey && agents.get(recAgentKey) || {}).name || recAgentKey || "agent", kind: "agent" };
          const toId = to;
          const init = pair.fileInit(me, toId, fp.split(/[\\/]/).pop() || "file", st.size, "application/octet-stream");
          if (init.error) {
            recToolCall("\u{1F6E0} aiti_pair_file \u2192 " + init.error, false);
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: init.error }) }], isError: true };
          }
          const CHUNK = 1024 * 1024;
          const buf = Buffer.allocUnsafe(CHUNK);
          const fd = openSync(fp, "r");
          try {
            let off = 0;
            while (off < st.size) {
              const n = readSync(fd, buf, 0, Math.min(CHUNK, st.size - off), off);
              const r2 = pair.fileChunk(init.fileId, buf.subarray(0, n));
              if (r2.error) throw new Error(r2.error);
              off += n;
            }
          } finally {
            closeSync(fd);
          }
          const done = pair.fileComplete(init.fileId);
          if (done.error) {
            recToolCall("\u{1F6E0} aiti_pair_file \u2192 " + done.error, false);
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: done.error }) }], isError: true };
          }
          const meta = done.file;
          const r = routePairSend(me, to, { file: { ...meta, fromName: me.name } });
          recToolCall("\u{1F6E0} aiti_pair_file(" + to + ") \u2192 " + meta.name + " (" + Math.round(st.size / 1024) + "KB)" + (r.ok ? " delivered" : " delivery failed: " + (r.error || "")), !!r.ok, r);
          return { content: [{ type: "text", text: JSON.stringify(r.ok ? { ok: true, fileId: meta.fileId, name: meta.name, size: meta.size, delivered: r.delivered } : r) }], isError: !r.ok };
        }
        if (params.name === "aiti_pair_fetch") {
          const fileId = String(a.fileId || "").trim();
          if (!fileId) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "bad request (fileId required)" }) }], isError: true };
          const info = pair.getFileInfo(fileId);
          return pair.fetchToFile(fileId, a.savePath ? String(a.savePath) : null).then((r) => {
            recToolCall("\u{1F6E0} aiti_pair_fetch(" + fileId + (info ? " \xB7 " + info.name : "") + ") \u2192 " + (r.ok ? r.path : r.error), !!r.ok, r);
            return { content: [{ type: "text", text: JSON.stringify(r.ok ? { ...r, name: info ? info.name : null } : r) }], isError: !r.ok };
          });
        }
        if (params.name === "file_stat") {
          const fp = String(a.path || "").trim();
          const out = { path: fp || null, exists: false, isFile: false, isDirectory: false, size: null, mtime: null };
          if (fp) {
            try {
              const st = statSync2(fp);
              out.exists = true;
              out.isFile = st.isFile();
              out.isDirectory = st.isDirectory();
              out.size = st.isFile() ? st.size : null;
              out.mtime = st.mtimeMs;
            } catch {
            }
          }
          recToolCall("\u{1F6E0} file_stat(" + (fp || "") + ") \u2192 " + (out.exists ? out.isFile ? "file " + out.size + "B" : "directory" : "not found"), out.exists === true, out);
          return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
        }
        if (params.name === "page_logs" || params.name === "page_network") {
          const isLog = params.name === "page_logs";
          const ringExpr = isLog ? "(() => { try { var r = window.__dbg && window.__dbg.__consoleRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 200) + "); } catch(e) { return []; } })()" : "(() => { try { var r = window.__dbg && window.__dbg.__netRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 100) + "); } catch(e) { return []; } })()";
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) {
            recToolCall("\u{1F6E0} " + params.name + " \u2192 \u26A0 page matched multiple", false);
            return { content: [{ type: "text", text: "page matched multiple (by url/title): " + resolved.multiple.join(", ") + " \u2014 specify a concrete pageId" }], isError: true };
          }
          if (resolved.notFound) {
            recToolCall("\u{1F6E0} " + params.name + " \u2192 \u26A0 no matching page found", false);
            return { content: [{ type: "text", text: "no matching page (pageId/url/title all missed) \u2014 use bridge_status to list available pageIds" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const execSrc = { ...agentSrc(), targetDevice: deviceShort(resolved.pageId) };
          return execOnPage("Runtime.evaluate", { expression: ringExpr }, resolved.pageId, signal, mcpReqId, cancelId, execSrc).then((r) => {
            const raw2 = r.ok && r.result && r.result.value !== void 0 ? r.result.value : [];
            let rows = Array.isArray(raw2) ? raw2 : [];
            if (isLog) {
              if (a.level) rows = rows.filter((l) => l.level === a.level);
              if (a.since) {
                const t = Date.parse(a.since);
                if (!isNaN(t)) rows = rows.filter((l) => l.ts >= t);
              }
            } else {
              if (a.url) rows = rows.filter((rq) => String(rq.url || "").includes(String(a.url)));
              if (a.status) rows = rows.filter((rq) => (rq.status || 0) >= Number(a.status));
              if (a.errorOnly) rows = rows.filter((rq) => rq.error || (rq.status || 0) >= 400);
            }
            const limit = Math.min(parseInt(a.limit, 10) || (isLog ? 50 : 30), isLog ? 200 : 100);
            rows = rows.slice(-limit);
            const out = isLog ? { logs: rows, bufferSize: Array.isArray(raw2) ? raw2.length : 0 } : { requests: rows, bufferSize: Array.isArray(raw2) ? raw2.length : 0 };
            recToolCall("\u{1F6E0} " + params.name + "(" + resolved.pageId + ") \u2192 " + rows.length + " row(s)", true, out);
            return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
          });
        }
        if (params.name === "page_exec" || params.name === "page_snapshot") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) {
            recToolCall("\u{1F6E0} " + params.name + " \u2192 \u26A0 page matched multiple\uFF1A" + resolved.multiple.join(", "), false);
            return { content: [{ type: "text", text: "page matched multiple (by url/title): " + resolved.multiple.join(", ") + " \u2014 specify a concrete pageId (see bridge_status)" }], isError: true };
          }
          if (resolved.notFound) {
            recToolCall("\u{1F6E0} " + params.name + (pageId ? "(" + pageId + ")" : "") + " \u2192 \u26A0 no matching page found", false);
            return { content: [{ type: "text", text: "no matching page (pageId/url/title all missed) \u2014 use bridge_status to list available pageIds" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const runPageTool = params.name === "page_exec" ? execOnPage(cmd, cmdArgs, resolved.pageId, signal, mcpReqId, cancelId, { ...agentSrc(), targetDevice: deviceShort(resolved.pageId) }) : execOnPage("__snapshot__", {}, resolved.pageId, signal, mcpReqId, cancelId, { ...agentSrc(), targetDevice: deviceShort(resolved.pageId) }).then((r) => {
            const txt = JSON.stringify(r.result || r);
            if (r.ok || txt.indexOf("unknown command: __snapshot__") === -1) return r;
            return execOnPage("Runtime.evaluate", { expression: SNAPSHOT_FALLBACK, returnByValue: true }, resolved.pageId, signal, mcpReqId, cancelId, { ...agentSrc(), targetDevice: deviceShort(resolved.pageId) }).then((r2) => {
              if (!r2.ok) return r2;
              const ro = r2.result && r2.result.result ? r2.result.result : r2.result;
              let val = ro && ro.value !== void 0 ? ro.value : ro;
              if (typeof val === "string") {
                try {
                  val = JSON.parse(val);
                } catch {
                }
              }
              return { ok: true, result: val };
            });
          });
          return runPageTool.then((r) => {
            recToolCall("\u{1F6E0} " + params.name + "(" + resolved.pageId + ")" + (params.name === "page_exec" && cmd ? " \xB7 " + String(cmd).slice(0, 80) : "") + " \u2192 " + (r.ok ? "ok" : "failed"), !!r.ok, { tool: params.name, request: params.name === "page_exec" ? { cmd, args: cmdArgs } : { pageId: resolved.pageId }, response: r.result || r, at: (/* @__PURE__ */ new Date()).toISOString() });
            return { content: [{ type: "text", text: JSON.stringify(r.result || r) }], isError: !r.ok };
          });
        }
        if (params.name === "self_ui") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) {
            recToolCall("\u{1F6E0} self_ui \u2192 target page not found (no AI main window connected, or pageId did not match)", false);
            return { content: [{ type: "text", text: "target page not found: no AI main window connected, or pageId did not match" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          return execOnPage("Runtime.evaluate", { expression: SELF_UI_SCAN }, resolved.pageId, signal, mcpReqId, cancelId, { ...agentSrc(), targetDevice: deviceShort(resolved.pageId) }).then((r) => {
            const val = r.ok && r.result && r.result.value !== void 0 ? r.result.value : r.result || r;
            recToolCall("\u{1F6E0} self_ui(" + resolved.pageId + ") \u2192 " + (r.ok ? val && val.dialogs ? val.dialogs.length + " dialog(s)" : "no dialogs" : "failed"), !!r.ok, val);
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        if (params.name === "form_fill") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) {
            recToolCall("\u{1F6E0} form_fill \u2192 target page not found", false);
            return { content: [{ type: "text", text: "target page not found: no AI main window connected, or pageId did not match" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const opts2 = { dialog: a.dialog || null, fields: a.fields || [], button: a.button || null };
          const expression = "(" + FORM_FILL_FN + ")(" + JSON.stringify(opts2) + ")";
          return execOnPage("Runtime.evaluate", { expression }, resolved.pageId, signal, mcpReqId, cancelId, { ...agentSrc(), targetDevice: deviceShort(resolved.pageId) }).then((r) => {
            const val = r.ok && r.result && r.result.value !== void 0 ? r.result.value : r.result || r;
            recToolCall("\u{1F6E0} form_fill(" + resolved.pageId + ") \u2192 " + (r.ok ? val && val.foundDialog ? "filled " + val.filled + " field(s)" + (val.clicked ? ", clicked button" : "") : "no dialog found" : "failed"), !!r.ok, { tool: "form_fill", pageId: resolved.pageId, response: val });
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        const interact = (interaction, timeout) => {
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const targetPageId = pageId || boundPageIdFor(session) || void 0;
          return interactOnPage({ ...interaction, ...agentSrc(), targetDevice: deviceShort(targetPageId) }, targetPageId, timeout, signal, mcpReqId, cancelId).then((r) => {
            recToolCall("\u{1F6E0} " + interaction.kind + " \u2192 " + (r.ok ? "answered" : r.result && r.result.status || "failed/declined"), !!r.ok);
            return { content: [{ type: "text", text: JSON.stringify(r.result || r) }], isError: !r.ok };
          });
        };
        if (params.name === "user_pick_element") {
          return interact({ kind: "pick_element", prompt: String(a.prompt || "Please click an element on the page (the AI needs your help locating it)"), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_confirm") {
          return interact({ kind: "confirm", prompt: String(a.prompt || "Please confirm"), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_choose") {
          const choices = Array.isArray(a.choices) && a.choices.length ? a.choices.map(String).slice(0, 8) : ["Option A", "Option B"];
          return interact({ kind: "choose", prompt: String(a.prompt || "Please pick one"), choices, multiple: !!a.multiple, rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_input") {
          return interact({ kind: "input", prompt: String(a.prompt || "Please type your answer"), defaultValue: String(a.defaultValue || ""), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_presence") {
          return interact({ kind: "presence", prompt: String(a.prompt || "Are you there? I need your help to continue"), rejectable: false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_notify") {
          const srcN = agentSrc();
          const notif = { kind: "notify", title: String(a.title || "\u{1F916} The AI has a message"), body: String(a.body || a.prompt || ""), timeoutMs: clampTimeout(a.timeout), pageId: raw, async: a.async === true, agentId: a.agentId || null, t0: Date.now() };
          const rid = "notify_" + Date.now();
          if (a.pageId) {
            const raw2 = String(a.pageId);
            let iid = "";
            let frameId = null;
            let fullPageId = "";
            if (raw2.indexOf("/") >= 0) {
              const resolved = resolvePageId(raw2);
              if (resolved.multiple) {
                recToolCall("\u{1F514} user_notify \u2192 \u26A0 page matched multiple", false);
                return { content: [{ type: "text", text: "page matched multiple: " + resolved.multiple.join(", ") + " \u2014 specify a concrete pageId" }], isError: true };
              }
              if (resolved.notFound || !resolved.pageId) {
                recToolCall("\u{1F514} user_notify(" + raw2 + ") \u2192 \u26A0 no matching page found", false);
                return { content: [{ type: "text", text: "no matching page (pageId/url/title all missed) \u2014 use bridge_status to list available pageIds" }], isError: true };
              }
              const pid = parsePageId(resolved.pageId);
              iid = pid.instanceId;
              frameId = pid.frameId;
              fullPageId = resolved.pageId;
            } else {
              iid = raw2;
            }
            let delivered = false;
            const tgt = fullPageId ? resolveAiTarget(fullPageId) : resolveAiTarget(iid + "/ai");
            try {
              notif.targetDevice = deviceShort(fullPageId || iid + "/ai") || notif.targetDevice;
            } catch {
            }
            if (tgt) {
              try {
                delivered = !!tgt.w.write({ type: "interaction", requestId: rid, interaction: notif, frameId: tgt.frameId, via: tgt.via });
              } catch {
                delivered = false;
              }
              if (!delivered) {
                aiConns.delete(tgt.w);
                aiSelfReg.delete(tgt.w);
                aiPageReg.delete(tgt.w);
              }
            }
            if (!delivered) {
              const pg2 = pages.get(iid);
              if (pg2) delivered = !!pg2.writer.write({ type: "interaction", requestId: rid, interaction: notif, frameId, render: "notify-only" });
            }
            if (!delivered) {
              recToolCall("\u{1F514} user_notify(" + iid + ") \u2192 \u26A0 target not connected", false);
              return { content: [{ type: "text", text: "target page not connected (instanceId missed or offline) \u2014 use bridge_status to list available pageIds" }], isError: true };
            }
            recToolCall("\u{1F514} user_notify(" + iid + ") \u2192 " + String(notif.body).slice(0, 60), true);
            return { content: [{ type: "text", text: JSON.stringify({ status: "sent", notified: true, title: notif.title, pageId: fullPageId || iid }) }], isError: false };
          }
          for (const w of aiConns) w.write({ type: "interaction", requestId: rid, interaction: notif, pageId });
          const pg = pages.get(parsePageId(pageId || LEGACY_TOKEN).instanceId);
          if (pg) pg.writer.write({ type: "interaction", requestId: rid, interaction: notif, frameId: parsePageId(pageId || LEGACY_TOKEN).frameId, render: "notify-only" });
          recToolCall("\u{1F514} user_notify \u2192 " + String(notif.body).slice(0, 60), true);
          return { content: [{ type: "text", text: JSON.stringify({ status: "sent", notified: true, title: notif.title }) }], isError: false };
        }
        if (params.name === "aiti_hello") {
          const agentId = String(a.agentId || session && session.agentId || "pi");
          const sessionId = a.sessionId || session && session.id || null;
          const { a: agent, key } = ensureAgent(agentId, sessionId, session);
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "agent registration failed" }) }], isError: true };
          agent.registered = true;
          agent.name = a.name || agent.name;
          if (typeof a.cwd === "string" && a.cwd) agent.cwd = a.cwd;
          if (session) {
            session.agentId = agentId;
            session.agentKey = key;
          }
          if (a.pageId) {
            const resolved2 = resolvePageId(a.pageId);
            agent.boundPageId = resolved2.pageId || a.pageId;
          }
          if (Array.isArray(a.subEvents)) agent.subEvents = new Set(a.subEvents.map(String));
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, agentKey: key, agentId, sessionId: agent.sessionId, boundPageId: agent.boundPageId || null, subEvents: [...agent.subEvents], inboxPending: agent.outbox.filter((m) => m.status !== "consumed").length }) }], isError: false };
        }
        if (params.name === "aiti_inbox") {
          const agentId = String(a.agentId || session && session.agentId || "pi");
          const sessionId = a.sessionId || session && session.id || (session && session.agentKey ? session.agentKey.split("/").slice(1).join("/") : null) || null;
          const { a: agent, key } = ensureAgent(agentId, sessionId, session);
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown agent: call aiti_hello first, or pass agentId/sessionId" }) }], isError: true };
          if (session && !session.agentKey) session.agentKey = key;
          if (Array.isArray(a.ack) || a.ack && typeof a.ack === "object") {
            const ackIds = Array.isArray(a.ack) ? a.ack.map(String) : (a.ack && a.ack.ids || []).map(String);
            const summary = !Array.isArray(a.ack) && a.ack && typeof a.ack.summary === "string" && a.ack.summary.trim() || "";
            let ackedAny = false;
            for (const id of ackIds) {
              const m = agent.outbox.find((x) => x.id === id && x.status !== "consumed");
              if (m) {
                m.status = "consumed";
                m.ackedAt = Date.now();
                m.summary = summary || null;
                ackedAny = true;
                appendMsgEvent(key, { type: "status_change", id: randomBytes2(4).toString("hex"), msgId: id, status: "consumed", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
              }
            }
            if (ackedAny) {
              const text = summary || `\u2705 handled ${ackIds.length} message(s) (no summary attached \u2014 passing a summary with ack is recommended)`;
              const rid = randomBytes2(4).toString("hex");
              const rec = { id: rid, kind: "agent_summary", from: "agent", agentKey: key, agentId, sessionId: agent.sessionId, text, ackedIds: ackIds, at: (/* @__PURE__ */ new Date()).toISOString(), status: "ok" };
              agent.outbox.push(rec);
              appendMsgEvent(key, { type: "message", id: rid, parentId: null, timestamp: rec.at, message: rec });
              for (const w of aiConns) w.write({ type: "agent_answer", agentKey: key, agentId, ok: true, text, at: Date.now(), summary: true });
            }
          }
          const out = [];
          for (const m of agent.outbox) {
            if (m.status === "consumed") continue;
            if (m.status === "pending") {
              m.status = "delivered";
              appendMsgEvent(key, { type: "status_change", id: randomBytes2(4).toString("hex"), msgId: m.id, status: "delivered", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
            }
            out.push({ id: m.id, kind: m.kind, from: m.from, agentKey: key, agentId, sessionId: agent.sessionId, pageId: m.pageId || m.payload && m.payload.pageId || null, url: m.url || m.payload && m.payload.url || null, text: m.text ?? null, payload: m.payload || null, at: m.at, status: m.status });
          }
          for (const w of aiConns) w.write({ type: "event", from: "agent", event: "inbox_status", payload: { agentKey: key, queueSize: agent.outbox.filter((x) => x.status !== "consumed").length } });
          const guide = agent.registered ? "" : " \u26A0 not explicitly registered (random session) \u2014 call aiti_hello with agentId/sessionId to register so messages can be routed to this session reliably";
          return { content: [{ type: "text", text: JSON.stringify({ agentKey: key, registered: agent.registered, messages: out, queueSize: agent.outbox.filter((x) => x.status !== "consumed").length, guide }) }], isError: false };
        }
        return { content: [{ type: "text", text: "unknown tool: " + params.name }], isError: true };
      }
      default:
        return { error: "unknown method " + req.method };
    }
  }
  function parseCmdStr(cmdStr) {
    const parts = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while (m = re.exec(cmdStr)) parts.push(m[1] !== void 0 ? m[1] : m[2]);
    return { exe: parts[0] || "", args: parts.slice(1) };
  }
  function isCodeLikeEditor(name) {
    return /(^|[\\/])(code|code-insiders|cursor|windsurf|codium|vscodium|zed)(\.exe|\.cmd|\.bat)?$/i.test(name);
  }
  function hasDesktopSession() {
    if (process.platform !== "linux") return true;
    return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE || Object.keys(desktopEnv()).length);
  }
  function desktopEnv() {
    const out = {};
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      const home = process.env.HOME || "";
      try {
        const xs = readdirSync2("/tmp/.X11-unix").filter((f) => /^X\d+$/.test(f)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        if (xs.length && !out.DISPLAY) out.DISPLAY = ":" + xs[0].slice(1);
      } catch {
      }
      const authCands = [];
      if (uid != null) authCands.push(`/run/user/${uid}/gdm/Xauthority`);
      authCands.push(`${home}/.Xauthority`);
      for (const a of authCands) {
        try {
          if (a && existsSync2(a)) {
            out.XAUTHORITY = a;
            break;
          }
        } catch {
        }
      }
      if (uid != null) {
        try {
          const ws = readdirSync2(`/run/user/${uid}`).filter((f) => /^wayland-\d+$/.test(f)).sort();
          if (ws.length) out.WAYLAND_DISPLAY = ws[0];
        } catch {
        }
        try {
          if (existsSync2(`/run/user/${uid}/bus`)) {
            out.XDG_RUNTIME_DIR = `/run/user/${uid}`;
            out.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
          }
        } catch {
        }
      }
    } catch {
    }
    return out;
  }
  function openFileInEditor(file, line) {
    return new Promise((resolve) => {
      if (!file) return resolve({ ok: false, error: "file param missing" });
      const platform = process.platform;
      const isWin = platform === "win32";
      const target = file + (line ? ":" + line : "");
      const cmdRaw = process.env.AITI_OPEN_CMD || process.env.EDITOR || process.env.VISUAL || "";
      const { exe, args: cmdArgs } = cmdRaw ? parseCmdStr(cmdRaw) : { exe: "", args: [] };
      const defaultOpen = (f) => {
        if (isWin) return spawn("cmd", ["/c", "start", "", f], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...desktopEnv() } });
        return spawn(platform === "darwin" ? "open" : "xdg-open", [f], { detached: true, stdio: "ignore", env: { ...process.env, ...desktopEnv() } });
      };
      let child;
      if (exe) {
        const codeLike = isCodeLikeEditor(exe);
        const args = [...cmdArgs];
        if (codeLike && !args.includes("--goto")) args.push("--goto");
        args.push(codeLike ? target : file);
        child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...desktopEnv() }, ...isWin ? { shell: true } : {} });
      } else {
        if (!hasDesktopSession()) {
          return resolve({ ok: false, error: "no desktop session (systemd/headless) \u2014 backend open unavailable: use the frontend-open path in the pi-web window" });
        }
        child = defaultOpen(file);
      }
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      child.on("error", () => {
        if (!hasDesktopSession()) {
          return finish({ ok: false, error: "neither the editor nor the system default opener is available (no desktop session) \u2014 configure AITI_OPEN_CMD or use the frontend-open path" });
        }
        const c2 = defaultOpen(file);
        c2.on("error", (e2) => finish({ ok: false, error: String(e2 && e2.message || e2) }));
        c2.unref();
        setTimeout(() => finish({ ok: true, opened: file, via: "default" }), 300);
      });
      child.on("spawn", () => setTimeout(() => finish({ ok: true, opened: exe ? target : file, via: exe || "default" }), 300));
      child.unref();
    });
  }
  function sseResponse(onClose, opts2 = {}) {
    let controllerRef = null;
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
      },
      cancel() {
        closed = true;
        try {
          if (onClose) onClose();
        } catch {
        }
      }
    });
    const eventLine = opts2.event ? "event: " + opts2.event + "\n" : "";
    const writer = {
      // 返回是否写成功：流已关闭/写入异常（浏览器端断连）→ 触发 onClose 清理注册 + 返回 false，调用方（exec/interact 路由）据此快速失败而非白等超时
      write(obj) {
        try {
          if (controllerRef && !closed) {
            controllerRef.enqueue(new TextEncoder().encode(eventLine + "data: " + JSON.stringify(obj) + "\n\n"));
            return true;
          }
        } catch (e) {
        }
        if (!closed) {
          closed = true;
          try {
            if (onClose) onClose();
          } catch {
          }
        }
        return false;
      }
    };
    const ping = setInterval(() => {
      try {
        if (controllerRef && !closed) controllerRef.enqueue(new TextEncoder().encode(": ping\n\n"));
      } catch {
      }
    }, 15e3);
    const cleanup = () => {
      clearInterval(ping);
    };
    return { response: new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...cors } }), writer, cleanup };
  }
  const pair = createPairModule({
    TAG,
    dataDir,
    cors,
    json,
    sseResponse: (onClose, opts2) => sseResponse(onClose, opts2),
    getDevices: () => listDevices(),
    routeSend: (fromDev, to, payload) => routePairSend(fromDev, to, payload),
    // Page identity check: idRegistry (claim registrations) U aiSelfReg (role=ai self-attested connections
    // carry ai- prefixed ids and never enter idRegistry — see the connect handler); public forgery is gated by gateAdmission
    validateInstance: (instanceId) => validInstance(instanceId) || [...aiSelfReg.values()].some((r) => String(r.instanceId) === String(instanceId))
  });
  function listDevices() {
    const out = [];
    const seenPages = /* @__PURE__ */ new Set();
    for (const w of aiConns) {
      const self = aiSelfReg.get(w);
      const pageReg = aiPageReg.get(w);
      const iid = self && String(self.instanceId);
      if (!iid || seenPages.has(iid)) continue;
      seenPages.add(iid);
      const dev = self.device || null;
      const pageId = pageReg && pageReg.pageId ? String(pageReg.pageId) : iid + "/host";
      const nm = pair.nameFor(iid) || (dev && (dev.os || dev.browser) ? [dev.os, dev.browser].filter(Boolean).join(" \xB7 ") : self.title || pageReg?.url || pageId);
      out.push({ kind: "page", id: pageId, instanceId: iid, name: nm, url: pageReg?.url || null, title: pageReg?.title || null, device: dev, deviceLabel: dev ? [dev.browser, dev.os, dev.screen].filter(Boolean).join(" \xB7 ") : null, online: true, lastSeen: self.lastSeen || Date.now() });
    }
    for (const [instanceId, page] of pages) {
      if (seenPages.has(instanceId)) continue;
      out.push({ kind: "page", id: instanceId, instanceId, name: pair.nameFor(instanceId) || page.title || page.url || instanceId, url: page.url || null, title: page.title || null, device: page.device || null, deviceLabel: page.deviceLabel || null, online: true, lastSeen: Date.now() });
    }
    for (const [key, a] of agents) {
      if (!a.registered && !agentOnline(a) && !a.outbox.length) continue;
      out.push({ kind: "agent", id: key, name: a.name || a.agentId, cwd: a.cwd || null, sessionId: a.sessionId || (key.includes("/") ? key.split("/").slice(1).join("/") : null), source: a.source || "unknown", transportKind: a.transportKind, online: agentOnline(a), offlineAt: a.offlineAt || null, lastSeen: a.lastSeen });
    }
    for (const p of pair.listPeers()) out.push(p);
    return out.sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
  }
  function aiDeviceFrom(req, msg) {
    let dev = null;
    try {
      const dq = msg && msg.device || null;
      if (dq) dev = typeof dq === "string" ? JSON.parse(dq) : dq;
    } catch (e) {
    }
    if (!dev) {
      const ua = req.headers.get("user-agent") || "";
      if (ua) {
        const p = parseUa(ua, null);
        dev = { browser: p.browser, version: p.version, os: p.os, osVer: p.osVer, deviceType: p.deviceType };
      }
    }
    return dev;
  }
  function pageRegMatches(reg, bare, full) {
    if (!reg) return false;
    if (String(reg.instanceId) === bare) return true;
    const pid = reg.pageId ? String(reg.pageId) : "";
    if (!pid) return false;
    return pid === full || pid === bare + "/host" || pid.split("/")[0] === bare;
  }
  function deliverToInstance(iidOrPageId, envelope) {
    const bare = iidOrPageId.indexOf("/") >= 0 ? iidOrPageId.split("/")[0] : iidOrPageId;
    const full = iidOrPageId;
    for (const w of aiConns) {
      const self = aiSelfReg.get(w);
      const pageReg = aiPageReg.get(w);
      if (pageRegMatches(self, bare, full) || pageRegMatches(pageReg, bare, full)) {
        let ok = false;
        try {
          ok = !!w.write(envelope);
        } catch {
          ok = false;
        }
        if (!ok) {
          aiConns.delete(w);
          aiSelfReg.delete(w);
          aiPageReg.delete(w);
        }
        return ok;
      }
    }
    const pg = pages.get(bare);
    if (pg && pg.writer) {
      try {
        return !!pg.writer.write(envelope);
      } catch {
        return false;
      }
    }
    return false;
  }
  function pageInstanceFor(iidOrPageId) {
    const bare = iidOrPageId.indexOf("/") >= 0 ? iidOrPageId.split("/")[0] : iidOrPageId;
    const full = iidOrPageId;
    for (const w of aiConns) {
      const self = aiSelfReg.get(w);
      const pageReg = aiPageReg.get(w);
      if (pageRegMatches(self, bare, full)) return self && self.instanceId ? String(self.instanceId) : bare;
      if (pageRegMatches(pageReg, bare, full)) return pageReg && pageReg.instanceId ? String(pageReg.instanceId) : bare;
    }
    return pages.has(bare) ? bare : null;
  }
  function routePairSend(fromDev, to, payload) {
    const q = String(to || "all").trim() || "all";
    const from = { id: fromDev.id, kind: fromDev.kind || "page", name: fromDev.name };
    const env = (type, extra) => ({ id: randomBytes2(4).toString("hex"), type, from, to: q, ts: Date.now(), ...extra });
    const devRows = listDevices().filter((d) => d.kind === "page");
    const delivered = [];
    const pushAgent = (target) => {
      const fromIsAgent = from.kind === "agent";
      const fromId = String(fromDev.id || fromDev.name || "?");
      const fromName = String(fromDev.name || fromId);
      const fromShown = fromName !== fromId ? fromName + "\uFF08" + fromId + "\uFF09" : fromId;
      const label = fromIsAgent ? "[\u53D1\u81EA session: " + fromShown + "]" : "[\u53D1\u81EA pair: " + fromName + "]";
      const pl = { source: "pair", sourceLabel: (fromIsAgent ? "Session \xB7 " : "Pair \xB7 ") + fromName, fromDevice: from };
      const text = payload.file ? "\u{1F4CE} File received: " + payload.file.name + " (" + Math.max(1, Math.round((payload.file.size || 0) / 1024)) + "KB) \u2014 see the pair-inbox notes for how to fetch it" : String(payload.text || "") + "\n" + label;
      if (payload.file) pl.file = { fileId: payload.file.fileId, name: payload.file.name, size: payload.file.size, mime: payload.file.mime };
      const r = pushToAgents(target, text, payload.file ? "pair_file" : "user_message", pl);
      for (const d of r && r.delivered || []) delivered.push({ kind: "agent", id: d.agentKey, status: d.status });
    };
    const pushPageRow = (row) => {
      const iid = pageInstanceFor(String(row.id)) || String(row.id).split("/")[0];
      const rid = "pair_" + randomBytes2(4).toString("hex");
      let ok = false;
      let frame = null;
      if (payload.file) {
        const msg = env("file", { file: payload.file });
        frame = { ...msg, type: "pair_msg" };
        ok = deliverToInstance(iid, frame);
      } else if (payload.notify) {
        const body = String(payload.text || "");
        const card = { kind: "notify", title: from.name, body, timeoutMs: 3e4, fromPair: from };
        for (const w of aiConns) {
          const self = aiSelfReg.get(w);
          const pageReg = aiPageReg.get(w);
          if (pageRegMatches(self, iid, row.id) || pageRegMatches(pageReg, iid, row.id)) {
            try {
              ok = !!w.write({ type: "interaction", requestId: rid, interaction: card, frameId: "ai", via: "self" });
            } catch {
              ok = false;
            }
            break;
          }
        }
        if (!ok) {
          const pg = pages.get(iid);
          if (pg && pg.writer) {
            try {
              ok = !!pg.writer.write({ type: "interaction", requestId: rid, interaction: card, frameId: null, render: "notify-only" });
            } catch {
              ok = false;
            }
          }
        }
        if (ok) frame = { id: rid, type: "text", from, to: row.id, ts: Date.now(), text: body };
      } else {
        const msg = env("text", { text: payload.text });
        frame = { ...msg, type: "pair_msg" };
        ok = deliverToInstance(iid, frame);
      }
      if (ok) {
        delivered.push({ kind: "page", id: row.id });
        if (frame) pair.notePageInbox(iid, frame);
      }
      return ok;
    };
    const pushPageRaw = (raw2) => {
      const row = devRows.find((d) => d.id === raw2);
      return row ? pushPageRow(row) : false;
    };
    const selfIid = pageInstanceFor(String(fromDev.id)) || (fromDev.id.indexOf("/") >= 0 ? fromDev.id.split("/")[0] : fromDev.id);
    const rowIsSelf = (row) => (pageInstanceFor(String(row.id)) || String(row.id).split("/")[0]) === selfIid;
    if (q === "all" || q === "pages") {
      for (const row of devRows) {
        if (rowIsSelf(row)) continue;
        pushPageRow(row);
      }
      return { ok: delivered.length > 0, delivered };
    }
    if (q === "agents") {
      pushAgent("all");
      return { ok: delivered.length > 0, delivered };
    }
    if (q === "pairs") {
      const penv = env(payload.file ? "file" : "text", payload.file ? { file: payload.file } : { text: payload.text });
      for (const pd of pair.listPeers()) {
        try {
          if (pair.deliverToPeer(pd.id, penv)) delivered.push({ kind: "pair", id: pd.id });
        } catch {
        }
      }
      return { ok: delivered.length > 0, delivered };
    }
    if (q === "all-kinds") {
      for (const row of devRows) {
        if (rowIsSelf(row)) continue;
        pushPageRow(row);
      }
      pushAgent("all");
      const penv = env(payload.file ? "file" : "text", payload.file ? { file: payload.file } : { text: payload.text });
      for (const pd of pair.listPeers()) {
        try {
          if (pair.deliverToPeer(pd.id, penv)) delivered.push({ kind: "pair", id: pd.id });
        } catch {
        }
      }
      return { ok: delivered.length > 0, delivered };
    }
    if (devRows.some((d) => d.id === q)) {
      pushPageRaw(q);
      return { ok: delivered.length > 0, delivered };
    }
    const qBase = q.indexOf("/") >= 0 ? q.split("/")[0] : q;
    const byIid = devRows.filter((d) => d.instanceId && String(d.instanceId) === qBase);
    if (byIid.length === 1) {
      pushPageRow(byIid[0]);
      return { ok: delivered.length > 0, delivered };
    }
    if (agents.has(q) || agentIdx.has(q)) {
      pushAgent(q);
      return { ok: delivered.length > 0, delivered };
    }
    const devMatches = devRows.filter((d) => (d.name || "").includes(q) || d.id.includes(q) || d.instanceId && String(d.instanceId).includes(q));
    if (devMatches.length === 1) {
      pushPageRaw(devMatches[0].id);
      return { ok: delivered.length > 0, delivered };
    }
    if (devMatches.length > 1) return { ok: false, candidates: devMatches.map((d) => ({ kind: "page", id: d.id, name: d.name })), error: "page name matches multiple devices" };
    const agentRows = listAgentSessions().filter((a) => (a.name || "").includes(q) || a.agentKey.includes(q));
    if (agentRows.length === 1) {
      pushAgent(agentRows[0].agentKey);
      return { ok: delivered.length > 0, delivered };
    }
    if (agentRows.length > 1) return { ok: false, candidates: agentRows.map((a) => ({ kind: "agent", id: a.agentKey, name: a.name })), error: "agent name matches multiple sessions" };
    const pr = pair.resolvePeerFuzzy(q);
    if (pr && pr.hit) {
      const penv = env(payload.file ? "file" : "text", payload.file ? { file: payload.file } : { text: payload.text });
      try {
        if (pair.deliverToPeer(pr.hit.peerId, penv)) delivered.push({ kind: "pair", id: pr.hit.peerId });
      } catch {
      }
      return { ok: delivered.length > 0, delivered };
    }
    if (pr && pr.multiple) return { ok: false, candidates: pr.multiple, error: "pair device name matches multiple devices" };
    return { ok: false, error: "no matching device (to accepts a device id or name; use bridge_status or /bridge/pair/devices to list online devices)" };
  }
  async function handle(req, path, searchParams) {
    if (path[0] === "aiti") path = path.slice(1);
    const endpoint = path[0];
    const sub = path.slice(1)[0] || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (endpoint === "bridge" && sub === "pair") {
      const r = await pair.handle(req, path, searchParams);
      if (r) return r;
      return new Response("not found: " + endpoint + "/" + sub, { status: 404 });
    }
    if (endpoint === "bridge" && sub === "claim" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const r = claimInstanceId(msg && msg.instanceId, msg && msg.secret, msg && msg.pageKey, msg && msg.hostUrl);
      const reused = !!(msg && msg.instanceId && r.instanceId === msg.instanceId && msg.secret);
      const portPref = portFromHostUrl(msg && msg.hostUrl);
      console.log(TAG + " claim \u2192 instanceId=" + r.instanceId + (reused ? "(reused)" : "(new" + (portPref ? " port preference=" + portPref : "") + ")"));
      return json({ ok: true, instanceId: r.instanceId, secret: r.secret });
    }
    if (endpoint === "bridge" && sub === "sessions" && req.method === "GET") return json(listSessions());
    if (endpoint === "bridge" && sub === "ai" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.pageId) return json({ ok: false, error: "instanceId/pageId missing" }, 400);
      let hit = null;
      for (const [w, rec] of aiPageReg) if (rec.instanceId === String(msg.instanceId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai conn\uFF1A" + msg.instanceId }, 404);
      const baseId = String(msg.pageId).replace(/\/host$/, "");
      for (const [w, rec] of aiPageReg) {
        if (w !== hit && rec.pageId && String(rec.pageId).replace(/\/host$/, "") === baseId) aiPageReg.delete(w);
      }
      const prev = aiPageReg.get(hit) || {};
      const fr = Array.isArray(msg.frames) ? msg.frames : prev.frames || null;
      aiPageReg.set(hit, { instanceId: String(msg.instanceId), pageId: String(msg.pageId), title: msg.title || prev.title || null, url: msg.url || prev.url || null, frames: fr, device: msg.device && typeof msg.device === "object" ? msg.device : prev.device || null, deviceLabel: msg.deviceLabel || prev.deviceLabel || null, lastSeen: Date.now() });
      console.log(TAG + " AI host page registered: " + msg.pageId + " \xB7 " + (msg.title || "") + (fr && fr.length ? " \xB7 frames=" + fr.length : "") + (msg.device ? " \xB7 " + (msg.deviceLabel || msg.device) : ""));
      return json({ ok: true, pageId: msg.pageId });
    }
    if (endpoint === "bridge" && sub === "self" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId) return json({ ok: false, error: "instanceId missing" }, 400);
      let hit = null;
      for (const [w, rec] of aiSelfReg) if (rec.instanceId === String(msg.instanceId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai conn\uFF1A" + msg.instanceId }, 404);
      const prev = aiSelfReg.get(hit) || {};
      aiSelfReg.set(hit, { instanceId: String(msg.instanceId), url: msg.url || prev.url || null, title: msg.title || prev.title || null, device: msg.device && typeof msg.device === "object" ? msg.device : prev.device || null, deviceLabel: msg.deviceLabel || prev.deviceLabel || null, lastSeen: Date.now() });
      bindAgentFromAiSelf(aiSelfReg.get(hit));
      console.log(TAG + " AI main window self registered: " + msg.instanceId + "/ai \xB7 " + (msg.title || "") + (msg.device ? " \xB7 " + (msg.deviceLabel || msg.device) : ""));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }
    if (endpoint === "bridge" && sub === "self" && path[2] === "active" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.sessionId) return json({ ok: false, error: "instanceId/sessionId missing" }, 400);
      bindAgentFromActive(String(msg.instanceId), String(msg.sessionId));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }
    if (endpoint === "bridge" && sub === "ai" && path[2] === "frames" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.pageId || !Array.isArray(msg.frames)) return json({ ok: false, error: "bad request (pageId/frames required)" }, 400);
      let hit = null;
      for (const [w, rec2] of aiPageReg) if (rec2.pageId === String(msg.pageId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai host page\uFF1A" + msg.pageId }, 404);
      const rec = aiPageReg.get(hit);
      rec.frames = msg.frames;
      rec.lastSeen = Date.now();
      console.log(TAG + " AI host frame tree updated: " + msg.pageId + " frames=" + msg.frames.length);
      return json({ ok: true, frames: msg.frames.length });
    }
    if (endpoint === "bridge" && sub === "register" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !validInstance(msg.instanceId)) return json({ ok: false, error: "bad instanceId" }, 401);
      const page = pages.get(msg.instanceId);
      if (!page) return json({ ok: false, error: "no active page" }, 404);
      const list = Array.isArray(msg.frames) ? msg.frames : [msg.frameId].filter(Boolean);
      page.frames.clear();
      page.frameInfo.clear();
      for (const f of list) {
        if (typeof f === "string" && f) {
          page.frames.add(f);
          continue;
        }
        if (f && f.id) {
          page.frames.add(String(f.id));
          if (f.title || f.url || f.name || f.src || f.parentId) {
            page.frameInfo.set(String(f.id), { title: f.title || null, url: f.url || null, name: f.name || null, src: f.src || null, parentId: f.parentId || null });
          }
        }
      }
      console.log(TAG + " register frames \u2192", msg.instanceId, [...page.frames].join(","));
      return json({ ok: true, frames: [...page.frames] });
    }
    if (endpoint === "bridge" && sub === "agent" && path[2] === "tools" && path[3] === "call" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.tool) return json({ ok: false, error: "bad request (tool required)" }, 400);
      const agentId = msg.agentId ? String(msg.agentId) : "pi";
      const sessionId = msg.sessionId ? String(msg.sessionId) : null;
      const { a: ag, key } = ensureAgent(agentId, sessionId, null);
      if (sessionId) ag.registered = true;
      ag.source = msg.source === "mcp" ? "mcp" : "extension";
      if (msg.cwd) ag.cwd = String(msg.cwd);
      const session = { agentId, agentKey: key, id: sessionId || key.split("/").slice(1).join("/"), source: ag.source };
      try {
        const r = await callTool(String(msg.tool), msg.args && typeof msg.args === "object" ? msg.args : {}, session, null, msg.cancelId ? String(msg.cancelId) : null);
        if (r && r.error) return json({ ok: false, error: r.error });
        const text = r && r.content && r.content[0] && r.content[0].text || JSON.stringify(r);
        return json({ ok: true, agentKey: key, result: text, isError: !!(r && r.isError) });
      } catch (e) {
        return json({ ok: false, error: String(e && e.message || e) });
      }
    }
    if (endpoint === "bridge" && sub === "agent" && path[2] === "register" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.agentId) return json({ ok: false, error: "bad request (agentId required)" }, 400);
      const { a: ag, key } = ensureAgent(String(msg.agentId), msg.sessionId ? String(msg.sessionId) : null, null);
      ag.registered = true;
      if (msg.name) ag.name = String(msg.name);
      if (msg.cwd) ag.cwd = String(msg.cwd);
      if (msg.source) ag.source = String(msg.source);
      if (msg.pageId) ag.boundPageId = String(msg.pageId);
      if (Array.isArray(msg.subEvents)) ag.subEvents = new Set(msg.subEvents.map(String));
      return json({ ok: true, agentKey: key, agentId: ag.agentId, sessionId: ag.sessionId, registered: true, subEvents: [...ag.subEvents], inboxPending: ag.outbox.filter((m) => m.status !== "consumed").length });
    }
    if (endpoint === "bridge" && sub === "agent" && path[2] === "sse" && req.method === "GET") {
      const key = searchParams.get("agentKey") || "";
      const parts = key.split("/");
      const { a, key: resolvedKey } = ensureAgent(parts[0], parts.slice(1).join("/") || null, null);
      if (!a) return json({ ok: false, error: "unknown agent session" }, 400);
      const { response, writer, cleanup } = sseResponse(() => {
        if (a.agentStream === writer) {
          a.agentStream = null;
          a.conn = Math.max(0, (a.conn || 1) - 1);
          markOffline(resolvedKey);
        }
        cleanup();
      });
      a.agentStream = writer;
      a.conn = (a.conn || 0) + 1;
      console.log(TAG + " agent SSE established: " + resolvedKey + " (P3 push channel)");
      return response;
    }
    if (endpoint === "bridge" && sub === "agent" && path[2] === "answer" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.agentKey || !msg.text) return json({ ok: false, error: "bad request (agentKey/text required)" }, 400);
      const parts = String(msg.agentKey).split("/");
      const { a, key: resolvedKey } = ensureAgent(parts[0], parts.slice(1).join("/") || null, null);
      for (const om of a.outbox) {
        if (om.status !== "consumed" && (om.kind === "user_message" || om.kind === "user_answer" || om.kind === "chat")) {
          om.status = "consumed";
          om.ackedAt = Date.now();
          appendMsgEvent(resolvedKey, { type: "status_change", id: randomBytes2(4).toString("hex"), msgId: om.id, status: "consumed", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
          for (const w of aiConns) w.write({ type: "msg_status", agentKey: resolvedKey, msgId: om.id, status: "consumed" });
        }
      }
      const m = { id: randomBytes2(4).toString("hex"), kind: msg.kind || "agent_answer", from: "agent", agentId: parts[0], pageId: null, text: String(msg.text).slice(0, 4e3), payload: msg.payload || null, at: (/* @__PURE__ */ new Date()).toISOString(), status: "consumed" };
      appendMsgEvent(resolvedKey, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
      for (const w of aiConns) w.write({ type: "agent_answer", agentKey: resolvedKey, agentId: parts[0], text: m.text, at: m.at });
      console.log(TAG + " agent answer \u2192 " + resolvedKey + " \xB7 " + String(m.text).slice(0, 80) + " (consumed pending messages: " + (a.outbox || []).length + ")");
      return json({ ok: true, message: m });
    }
    if (endpoint === "bridge" && sub === "agents" && req.method === "GET") return json({ ok: true, agents: listAgentSessions() });
    if (endpoint === "bridge" && sub === "sse") {
      const instanceId = searchParams.get("instanceId") || searchParams.get("token") || LEGACY_TOKEN;
      const role = searchParams.get("role") || "page";
      const secret = searchParams.get("secret") || null;
      if (role !== "ai" && !validInstance(instanceId)) return json({ ok: false, error: "bad instanceId" }, 401);
      if (!checkSecret(instanceId, secret)) return json({ ok: false, error: "bad secret" }, 401);
      const { response, writer, cleanup: sseCleanup } = sseResponse(() => cleanup());
      const cleanup = () => {
        if (role === "ai") {
          aiConns.delete(writer);
          aiPageReg.delete(writer);
          aiSelfReg.delete(writer);
          var deadPageId = instanceId + "/ai";
          for (var [, fbList] of agentFallbackPageIds) {
            for (var fi = fbList.length - 1; fi >= 0; fi--) {
              if (fbList[fi].pageId === deadPageId) fbList.splice(fi, 1);
            }
          }
          for (var [, ag] of agents) {
            if (ag.activeBoundPageId === deadPageId) ag.activeBoundPageId = null;
          }
          sseCleanup();
          return;
        }
        if (pages.get(instanceId)?.writer === writer) {
          const rec = idRegistry.get(instanceId);
          if (rec) rec.lastSeen = Date.now();
          pages.delete(instanceId);
        }
        sseCleanup();
      };
      if (role === "ai") {
        aiConns.add(writer);
        const aiDev = aiDeviceFrom(req, { device: searchParams.get("device") || null });
        aiPageReg.set(writer, { instanceId, pageId: null, title: null, url: null, frames: null, lastSeen: Date.now() });
        aiSelfReg.set(writer, { instanceId, url: searchParams.get("url") || null, title: searchParams.get("title") || null, frames: /* @__PURE__ */ new Set(["host"]), frameInfo: /* @__PURE__ */ new Map(), device: aiDev, deviceLabel: aiDev ? [aiDev.browser, aiDev.os].filter(Boolean).join(" \xB7 ") : null, lastSeen: Date.now() });
        bindAgentFromAiSelf(aiSelfReg.get(writer));
        console.log(TAG + " AI console connected: instanceId=" + instanceId);
      } else {
        const existing = pages.get(instanceId);
        if (existing) {
          try {
            existing.writer.end();
          } catch {
          }
          pages.delete(instanceId);
        }
        const initialFrame = searchParams.get("frameId") || "host";
        let pageDevice = null, pageDeviceLabel = null;
        try {
          const d = searchParams.get("device");
          if (d) pageDevice = JSON.parse(d);
        } catch (e) {
        }
        pageDeviceLabel = searchParams.get("deviceLabel") || null;
        pages.set(instanceId, {
          writer,
          url: searchParams.get("url") || null,
          title: searchParams.get("title") || null,
          frameworks: searchParams.get("frameworks") || null,
          frames: /* @__PURE__ */ new Set([initialFrame]),
          frameInfo: /* @__PURE__ */ new Map(),
          device: pageDevice,
          deviceLabel: pageDeviceLabel
        });
        const rec = idRegistry.get(instanceId);
        if (rec) rec.lastSeen = Date.now();
        console.log(TAG + " page connected: instanceId=" + instanceId + " frame=" + initialFrame);
      }
      writer.write({ type: "ready", bridge: "/api/extensions/aiti-devtools/mcp", instanceId, token: LEGACY_TOKEN, role });
      return response;
    }
    if (endpoint === "bridge" && sub === "attach-bus" && req.method === "POST") {
      if (!busPublish) return json({ ok: false, error: "bus not wired" }, 501);
      const msg = await req.json().catch(() => null);
      const instanceId = msg && (msg.instanceId || msg.token) || LEGACY_TOKEN;
      const role = msg && msg.role || "page";
      if (role !== "ai" && !validInstance(instanceId)) return json({ ok: false, error: "bad instanceId" }, 401);
      if (!checkSecret(instanceId, msg && msg.secret || null)) return json({ ok: false, error: "bad secret" }, 401);
      const topic = "bridge-" + instanceId;
      const writer = {
        viaBus: true,
        lastSeen: Date.now(),
        // 帧契约：{ type: "bridge-<instanceId>", msg: <桥原消息> }——帧 type 即 topic（与
        // 客户端订阅白名单一致，publish(type, data) 的 data 展开会覆盖同名键，故桥消息只能放 msg）；
        // 永远返回 true：投递由总线管理（白名单过滤 + SSE 转发）；断线重连由客户端订阅状态回调驱动
        write(obj) {
          try {
            busPublish(topic, { msg: obj });
            return true;
          } catch {
            return false;
          }
        },
        end() {
        }
      };
      if (role === "ai") {
        for (const [w, reg] of [...aiSelfReg]) {
          if (w !== writer && String(reg.instanceId) === String(instanceId)) {
            aiConns.delete(w);
            aiPageReg.delete(w);
            aiSelfReg.delete(w);
          }
        }
        aiConns.add(writer);
        const aiDev = aiDeviceFrom(req, msg);
        aiPageReg.set(writer, { instanceId, pageId: null, title: msg && msg.title || null, url: msg && msg.url || null, frames: null, lastSeen: Date.now() });
        aiSelfReg.set(writer, { instanceId, url: msg && msg.url || null, title: msg && msg.title || null, device: aiDev, deviceLabel: aiDev ? [aiDev.browser, aiDev.os].filter(Boolean).join(" \xB7 ") : null, lastSeen: Date.now() });
        bindAgentFromAiSelf(aiSelfReg.get(writer));
        console.log(TAG + " AI console connected (bus): instanceId=" + instanceId);
      } else {
        const existing = pages.get(instanceId);
        if (existing) {
          try {
            existing.writer.end();
          } catch {
          }
          pages.delete(instanceId);
        }
        let pageDevice = null;
        try {
          if (msg && msg.device) pageDevice = typeof msg.device === "string" ? JSON.parse(msg.device) : msg.device;
        } catch (e) {
        }
        pages.set(instanceId, {
          writer,
          url: msg && msg.url || null,
          title: msg && msg.title || null,
          frameworks: msg && msg.frameworks || null,
          frames: /* @__PURE__ */ new Set([msg && msg.frameId || "host"]),
          frameInfo: /* @__PURE__ */ new Map(),
          device: pageDevice,
          deviceLabel: msg && msg.deviceLabel || null
        });
        const rec = idRegistry.get(instanceId);
        if (rec) rec.lastSeen = Date.now();
        console.log(TAG + " page connected (bus): instanceId=" + instanceId);
      }
      writer.write({ type: "ready", bridge: "/api/extensions/aiti-devtools/mcp", instanceId, token: LEGACY_TOKEN, role, via: "bus" });
      return json({ ok: true, topic, via: "bus" });
    }
    if (endpoint === "bridge" && sub === "bus-heartbeat" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const instanceId = msg && (msg.instanceId || msg.token) || LEGACY_TOKEN;
      const role = msg && msg.role || "page";
      if (!checkSecret(instanceId, msg && msg.secret || null)) return json({ ok: false, error: "bad secret" }, 401);
      if (role === "ai") {
        for (const w of aiConns) {
          if (w.viaBus && aiSelfReg.get(w)?.instanceId === instanceId) {
            w.lastSeen = Date.now();
            return json({ ok: true });
          }
        }
        return json({ ok: false, error: "unknown conn" }, 404);
      }
      const p = pages.get(instanceId);
      if (!p || !p.writer.viaBus) return json({ ok: false, error: "unknown conn" }, 404);
      p.writer.lastSeen = Date.now();
      const rec = idRegistry.get(instanceId);
      if (rec) rec.lastSeen = Date.now();
      return json({ ok: true });
    }
    if (endpoint === "bridge" && sub === "interaction" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.requestId || msg.action !== "pause" && msg.action !== "resume") return json({ ok: false, error: "bad request" }, 400);
      const { instanceId } = parsePageId(msg.pageId);
      if (!validInstance(instanceId || msg.token)) return json({ ok: false }, 401);
      if (!checkSecret(instanceId || msg.token, msg.secret)) return json({ ok: false, error: "bad secret" }, 401);
      const r = msg.action === "pause" ? pauseInteraction(msg.requestId) : resumeInteraction(msg.requestId);
      for (const w of aiConns) w.write({ type: "event", from: "page", event: "interaction_" + msg.action, payload: { requestId: msg.requestId, remainingMs: r.remainingMs } });
      return json({ ok: r.ok, ...r });
    }
    if (endpoint === "bridge" && sub === "result" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      const { instanceId } = parsePageId(msg.pageId);
      if (!validInstance(instanceId || msg.token)) return json({ ok: false }, 401);
      if (!checkSecret(instanceId || msg.token, msg.secret)) return json({ ok: false, error: "bad secret" }, 401);
      try {
        const r0 = msg.result;
        if (r0 && typeof r0 === "object" && typeof r0.dataUrl === "string" && r0.dataUrl.length > 12e4) {
          const ext = r0.format === "png" ? "png" : "jpg";
          const dir = join2(dataDir, "aiti-bridge", "shots");
          mkdirSync2(dir, { recursive: true });
          const file = join2(dir, (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + "-" + String(msg.requestId).replace(/[^\w-]/g, "").slice(0, 12) + "." + ext);
          writeFileSync(file, Buffer.from(r0.dataUrl.slice(r0.dataUrl.indexOf(",") + 1), "base64"));
          msg.result = { file, width: r0.width, height: r0.height, format: r0.format, bytes: r0.bytes || 0, note: "screenshot saved to file (dataUrl too large to inline); read it back via the file tools" };
          console.log(TAG + " screenshot written: " + file + " (" + Math.round((r0.bytes || 0) / 1024) + "KB)");
        }
      } catch (e) {
        console.warn(TAG + " screenshot write failed (falling back to inline):", e.message);
      }
      const r = pendingRequests.get(msg.requestId);
      if (r) {
        pendingRequests.delete(msg.requestId);
        try {
          if (r.signal && r.onAbort) r.signal.removeEventListener("abort", r.onAbort);
        } catch {
        }
        if (r.mcpReqId) mcpReqMap.delete(r.mcpReqId);
        if (r.cancelId) cancelIdMap.delete(r.cancelId);
        const ist = interactionTimers.get(msg.requestId);
        if (ist) {
          clearTimeout(ist.timer);
          interactionTimers.delete(msg.requestId);
          if (msg.result && typeof msg.result === "object" && !("pausedMs" in msg.result)) msg.result.pausedMs = ist.pausedMs;
        }
        r.resolve({ ok: msg.ok, result: msg.result });
        console.log(TAG + " \u2190 result posted back ok=" + msg.ok + (r.agentId ? " \u2192 agent=" + r.agentId : ""));
        if (r.agentId && msg.ok) deliverUserAnswer(r.agentId, msg.result);
      } else {
        console.log(TAG + " \u26A0 result posted back but no pending request: " + msg.requestId);
        return new Response("ok", { headers: cors });
      }
      for (const w of aiConns) w.write({ type: "result", requestId: msg.requestId, ok: msg.ok, result: msg.result, pageId: msg.pageId });
      return new Response("ok", { headers: cors });
    }
    if (endpoint === "bridge" && sub === "cancel" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false, error: "bad request" }, 400);
      const internalId = msg.requestId ? String(msg.requestId) : msg.cancelId ? cancelIdMap.get(String(msg.cancelId)) : null;
      if (!internalId) return json({ ok: false, error: "unknown request", cancelled: false });
      return json({ ok: cancelPending(internalId, "cancelled (client request)"), cancelled: true });
    }
    if (endpoint === "bridge" && sub === "push" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.text) return json({ ok: false, error: "bad request (text required)" }, 400);
      return json(pushToAgents(msg.to, String(msg.text), msg.kind || "user_message", msg.payload || {}, msg.ref || null));
    }
    if (endpoint === "bridge" && sub === "picked" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const list = msg && Array.isArray(msg.candidates) ? msg.candidates : null;
      if (!list) return json({ ok: false, error: "bad request (candidates array required)" }, 400);
      const key = String(msg && msg.to || "__all__");
      pickedReports.set(key, list.filter((c) => c && c.tag));
      persistPicked();
      return json({ ok: true, count: pickedReports.get(key).length, key });
    }
    if (endpoint === "bridge" && sub === "picked" && req.method === "GET") {
      const key = searchParams.get("agentKey") || "__all__";
      const list = pickedReports.get(key) ?? pickedReports.get("__all__") ?? [];
      return json({ ok: true, key, count: list.length, candidates: list });
    }
    if (endpoint === "bridge" && sub === "ai" && path[2] === "event" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.event) return json({ ok: false, error: "bad request (event required)" }, 400);
      const ev = String(msg.event);
      if (ev === "aiti_consumed") {
        const tags = Array.isArray(msg.payload?.tags) ? msg.payload.tags.map(String) : null;
        for (const [k, list] of pickedReports) {
          const next = tags ? list.filter((c) => !tags.includes(String(c.tag))) : [];
          if (next.length !== list.length) {
            pickedReports.set(k, next);
            persistPicked();
          }
        }
      }
      return json(pushAiEvent(ev, msg.payload || {}, "host-rest"));
    }
    if (endpoint === "bridge" && sub === "inbox-status" && req.method === "GET") {
      const input = searchParams.get("agentId") || "";
      const key = input.includes("/") ? input : resolvePushTargets(input)[0] || "";
      const a = key ? agents.get(key) : null;
      if (!a) return json({ ok: false, error: "unknown agent session" }, 404);
      return json({ ok: true, agentKey: key, agentId: a.agentId, sessionId: a.sessionId, queueSize: a.outbox.filter((x) => x.status !== "consumed").length, messages: a.outbox.slice(-50).map((m) => ({ id: m.id, kind: m.kind, from: m.from, text: m.text ?? null, at: m.at, status: m.status })) });
    }
    if (endpoint === "bridge" && sub === "messages" && req.method === "GET") {
      const input = searchParams.get("agentId") || "";
      const key = input.includes("/") ? input : resolvePushTargets(input)[0] || "";
      const limit = Math.min(parseInt(searchParams.get("limit"), 10) || 50, 200);
      const before = searchParams.get("before") || "";
      const since = searchParams.get("since") || "";
      const rows = key ? readMsgSession(key).sort((x, y) => String(x.at).localeCompare(String(y.at))) : [];
      let filtered = rows;
      if (since) {
        const t = Date.parse(since);
        if (!isNaN(t)) filtered = filtered.filter((r) => Date.parse(r.at) >= t);
      } else if (before) filtered = filtered.filter((r) => String(r.at) < before);
      const msgs = filtered.slice(-limit).map((m) => {
        const ak = m.agentKey || key || (m.agentId ? m.agentId + (m.sessionId ? "/" + m.sessionId : "") : "");
        return { id: m.id, kind: m.kind, from: m.from, agentKey: ak, agentId: m.agentId || (ak ? ak.split("/")[0] : null), sessionId: m.sessionId || (ak && ak.includes("/") ? ak.split("/").slice(1).join("/") : null) || null, pageId: m.pageId || m.payload && m.payload.pageId || null, ref: m.ref ?? null, text: m.text ?? null, detail: m.detail ?? null, at: m.at, status: m.status || "pending" };
      });
      return json({ ok: true, agentKey: key, total: rows.length, since, messages: msgs });
    }
    if (endpoint === "bridge" && sub === "event" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      const { instanceId } = parsePageId(msg.pageId);
      const aiRegistered = typeof msg.pageId === "string" && [...aiPageReg.values()].some((r) => r.pageId === msg.pageId);
      if (!aiRegistered && !validInstance(instanceId || msg.token)) return json({ ok: false }, 401);
      if (!checkSecret(aiRegistered ? instanceId : instanceId || msg.token, msg.secret)) return json({ ok: false, error: "bad secret" }, 401);
      for (const w of aiConns) w.write({ type: "event", from: "page", ...msg });
      const pageInfo = { pageId: msg.pageId || null, url: msg.payload && msg.payload.url || null };
      if (msg.type === "page_error") {
        pushEventToSubscribers("page_error", msg.payload || {}, pageInfo);
        console.log(TAG + " page_error event \u2192 subscribers: " + Object.keys(subsFor(instanceId)).length);
      }
      if (msg.type === "page_log" || msg.type === "page_network") {
        return json({ ok: false, error: "page_log/page_network are no longer reported live; use the page_logs/page_network tools to pull on demand" }, 410);
      }
      if (msg.type === "open_file") {
        const payload = msg.payload || {};
        console.log(TAG + " open_file \u2192", payload.file + (payload.line ? ":" + payload.line : ""));
        return json(await openFileInEditor(payload.file, payload.line));
      }
      return json({ ok: true, type: msg.type });
    }
    if (endpoint === "mcp") {
      for (const [sid2, s] of mcpSessions) if (!s.open && mcpSessionExpired(s)) mcpSessions.delete(sid2);
      if (req.method === "GET") {
        const sid2 = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id") || "";
        const session2 = sid2 ? mcpSessions.get(sid2) : null;
        if (!session2) return json({ ok: false, error: "bad or missing Mcp-Session-Id" }, 400);
        if (session2.open) return json({ ok: false, error: "stream already open" }, 409);
        session2.open = true;
        session2.lastSeen = Date.now();
        const { response, writer, cleanup } = sseResponse(() => {
          session2.open = false;
          session2.lastSeen = Date.now();
          session2.writer = null;
          const ak = session2.agentKey || (session2.agentId ? session2.agentId + "/" + session2.id : "");
          if (ak) {
            const { a: ag } = ensureAgent(ak.split("/")[0], ak.split("/").slice(1).join("/") || null, null);
            if (ag) {
              ag.conn = Math.max(0, (ag.conn || 1) - 1);
              if (ag.stream === writer) ag.stream = null;
              markOffline(ak);
            }
          }
          cleanup();
        }, { event: "message" });
        session2.writer = writer;
        if (session2.agentId) {
          const { a: ag } = ensureAgent(session2.agentId, session2.id, session2);
          if (ag) {
            ag.transportKind = "streamable";
            ag.conn = (ag.conn || 0) + 1;
          }
        }
        console.log(TAG + " streamable GET stream established session=" + sid2.slice(0, 8) + " agent=" + (session2.agentId || "?"));
        writer.write({ jsonrpc: "2.0", method: "notifications/initialized" });
        return response;
      }
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      if (msg.id !== void 0 && !msg.method && pendingSampling.has(String(msg.id))) {
        const p = pendingSampling.get(String(msg.id));
        const ok = !(msg.error || msg.result && msg.result.isError);
        p.done(ok, msg.error ? { error: String(msg.error.message || msg.error.code || "sampling declined") } : msg.result || {});
        console.log(TAG + " sampling response posted back id=" + String(msg.id).slice(0, 12) + " agent=" + p.agentId + " ok=" + ok);
        return new Response(null, { status: 202 });
      }
      const sid = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id") || "";
      let session = sid ? mcpSessions.get(sid) || null : null;
      const isInit = msg.method === "initialize";
      if (isInit) {
        if (!session) {
          const newId = randomBytes2(16).toString("hex");
          session = { id: newId, writer: null, agentId: null, clientInfo: null, capabilities: null, lastSeen: Date.now(), open: false, source: "mcp" };
          mcpSessions.set(newId, session);
        }
        const p = msg.params || {};
        session.clientInfo = p.clientInfo || null;
        session.capabilities = p.capabilities || null;
        session.agentId = p.clientInfo && p.clientInfo.name || session.agentId || null;
        session.clientInfo = p.clientInfo || session.clientInfo;
        session.lastSeen = Date.now();
        console.log(TAG + " initialize \u2192 session=" + session.id.slice(0, 8) + " client=" + (p.clientInfo ? p.clientInfo.name + " " + (p.clientInfo.version || "") : "?") + " transport=" + (sid ? "streamable" : "session-new") + " caps=" + JSON.stringify(p.capabilities || {}).slice(0, 120));
      } else if (session) {
        session.lastSeen = Date.now();
      }
      if (isInit && session && session.agentId) {
        const { a: ag, key } = ensureAgent(session.agentId, session.id, session);
        session.agentKey = key;
        if (ag) ag.transportKind = sid ? "streamable" : "stateless";
      }
      const extraHeaders = isInit && session ? { "mcp-session-id": session.id } : {};
      const respond = async (result) => {
        if (msg.id !== void 0) return json({ jsonrpc: "2.0", id: msg.id, result }, 200, extraHeaders);
        return new Response(null, { status: 202, headers: extraHeaders });
      };
      const r = handleMcpRequest(msg, session);
      if (r && typeof r.then === "function") return respond(await r);
      return respond(r);
    }
    return new Response("not found: " + endpoint + "/" + sub, { status: 404 });
  }
  function callTool(name, args = {}, session = null, signal = null, cancelId = null) {
    const r = handleMcpRequest({ method: "tools/call", params: { name, arguments: args } }, session, signal, cancelId);
    if (r && typeof r.then === "function") return r;
    return Promise.resolve(r);
  }
  const bindAgentFromAiSelfReverse = (agentKey2, agent) => {
    const agSid = agent.sessionId || String(agentKey2).split("/").slice(1).join("/");
    if (!agSid || agent.activeBoundPageId) return;
    for (const [, rec] of aiSelfReg) {
      const m = String(rec.url || "").match(/[?&]session=([^&#]+)/);
      if (!m) continue;
      const sid = decodeURIComponent(m[1]);
      if (sid === agSid) {
        agent.boundPageId = String(rec.instanceId) + "/ai";
        console.log(TAG + " agent registered with reverse-bound AI main window: " + agentKey2 + " \u2192 " + agent.boundPageId);
        break;
      }
    }
  };
  const registerAgent = (key, opts2 = {}) => {
    const k = String(key || "");
    if (!k) return { ok: false, error: "bad key" };
    if (!agents.has(k)) {
      agents.set(k, { agentId: k, sessionId: opts2.id || k, registered: true, name: opts2.name || k, cwd: opts2.cwd || null, sessionUrl: opts2.sessionUrl || null, offlineAt: null, conn: 0, transportKind: "inprocess", source: opts2.source || "extension", capabilities: opts2.capabilities || {}, stream: null, boundPageId: opts2.pageId || null, activeBoundPageId: null, subEvents: new Set(opts2.subEvents || []), outbox: [], lastSeen: Date.now(), agentStream: null, inProcessSink: null });
    }
    const a = agents.get(k);
    a.lastSeen = Date.now();
    if (opts2.name && a.name === k) a.name = String(opts2.name);
    if (opts2.name) a.name = String(opts2.name);
    if (opts2.cwd) a.cwd = String(opts2.cwd);
    if (opts2.sessionUrl) a.sessionUrl = String(opts2.sessionUrl);
    if (opts2.pageId) a.boundPageId = String(opts2.pageId);
    if (Array.isArray(opts2.subEvents)) a.subEvents = new Set(opts2.subEvents.map(String));
    if (!a.boundPageId) bindAgentFromAiSelfReverse(k, a);
    return { ok: true, agentKey: k, agentId: k };
  };
  const setAgentSink = (key, fn) => {
    const a = agents.get(String(key || ""));
    if (!a) return { ok: false, error: "unknown agent: " + key };
    a.inProcessSink = typeof fn === "function" ? fn : null;
    if (a.transportKind === "inprocess") {
      if (a.inProcessSink) {
        a.conn = Math.max(a.conn || 0, 1);
        a.offlineAt = null;
        a.lastSeen = Date.now();
      } else {
        a.conn = 0;
        if (!a.offlineAt) a.offlineAt = a.lastSeen;
      }
    }
    return { ok: true, agentKey: String(key) };
  };
  const answer = (key, text) => {
    const k = String(key || "");
    const t = String(text || "");
    if (!k || !t) return { ok: false, error: "bad request" };
    const a = agents.get(k);
    const at = (/* @__PURE__ */ new Date()).toISOString();
    if (a) {
      for (const om of a.outbox) {
        if (om.status !== "consumed" && (om.kind === "user_message" || om.kind === "user_answer" || om.kind === "chat")) {
          om.status = "consumed";
          om.ackedAt = Date.now();
          appendMsgEvent(k, { type: "status_change", id: randomBytes2(4).toString("hex"), msgId: om.id, status: "consumed", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
          for (const w of aiConns) w.write({ type: "msg_status", agentKey: k, msgId: om.id, status: "consumed" });
        }
      }
    }
    const m = { id: randomBytes2(4).toString("hex"), kind: "agent_summary", from: "agent", agentKey: k, agentId: k, sessionId: k.split("/").slice(1).join("/") || null, text: t.slice(0, 4e3), payload: null, at, status: "consumed" };
    appendMsgEvent(k, { type: "message", id: m.id, parentId: null, timestamp: at, message: m });
    for (const w of aiConns) w.write({ type: "agent_answer", agentKey: k, agentId: k, ok: true, text: m.text, at });
    return { ok: true, message: m };
  };
  const clearAgent = (key) => {
    const k = String(key || "");
    if (!k) return { ok: false, error: "bad key" };
    agents.delete(k);
    agentFallbackPageIds.delete(k);
    return { ok: true };
  };
  const pushAiEvent = (event, payload = {}, from = "host") => {
    let n = 0;
    for (const w of aiConns) {
      try {
        w.write({ type: "event", from, event: String(event || ""), payload });
        n++;
      } catch {
      }
    }
    return { ok: true, delivered: n };
  };
  return { handle, sessions: () => listSessions(), devices: () => listDevices(), routePairSend, pair: () => pair, tools: () => TOOLS, callTool, registerAgent, bindAgentPage, setAgentSink, answer, clearAgent, pushAiEvent, close };
}

// src/send-rewrite.ts
var PLACEHOLDER_RE = /\[(?:元素|回答|错误|选择)\d+\]/;
var ORPHAN_RE = /\[(?:元素|回答|错误)\d+\]/g;
var LEGACY_TAG_RE = /\[选择\d+\]/g;
var SRC_TAG_RE = /\[发自:[^\]]*\]\s*/g;
var ORPHAN_NOTICE = "[\u26A0 \u5019\u9009\u5DF2\u5931\u6548\uFF0C\u5360\u4F4D\u7B26\u5DF2\u79FB\u9664\uFF08\u91CD\u65B0\u9009\u5143\u7D20/\u5237\u65B0\u9875\u9762\u91CD\u91C7\uFF09]";
function clipUrl(u, max = 120) {
  if (!u) return "";
  try {
    const p = new URL(u);
    p.hash = "";
    let out = p.origin + p.pathname;
    if (p.search) {
      const q = p.search.slice(1).split("&").filter(Boolean).slice(0, 2);
      if (q.length) out += "?" + q.join("&");
    }
    return out.length > max ? out.slice(0, max) + "\u2026" : out;
  } catch {
    return u.length > max ? u.slice(0, max) + "\u2026" : u;
  }
}
function withSourceTag(text, opts) {
  const pid = opts.pid || "";
  if (!pid) return text;
  const note = opts.srcNote ?? "aiti-*\uFF1ApageId \u53C2\u6570\u7528\u5B83";
  const tag = "[\u53D1\u81EA: " + pid + (opts.pageUrl ? " \xB7 " + clipUrl(opts.pageUrl) : "") + "\uFF08" + note + "\uFF09]";
  const cleaned = String(text || "").replace(SRC_TAG_RE, "").replace(/\s+$/, "");
  return (cleaned ? cleaned + "\n" : "") + tag;
}
function stripOrphanTags(text) {
  return String(text || "").replace(ORPHAN_RE, ORPHAN_NOTICE);
}
function replaceTag(text, tag, desc) {
  const i = text.indexOf(tag);
  if (i < 0) return text;
  const rest = text.slice(i + tag.length);
  return text.slice(0, i) + desc + (rest.trim() ? "\n" + rest : rest);
}
function rewriteMessage(text, picked, opts = {}) {
  let out = String(text || "");
  const usedTags = [];
  out = out.replace(LEGACY_TAG_RE, "");
  if (picked.length) {
    for (const c of picked) {
      if (c.tag && out.includes(c.tag)) {
        out = replaceTag(out, c.tag, c.describe || c.tag);
        usedTags.push(c.tag);
      }
    }
  }
  if (ORPHAN_RE.test(out)) {
    ORPHAN_RE.lastIndex = 0;
    out = stripOrphanTags(out);
  } else ORPHAN_RE.lastIndex = 0;
  const usedAny = usedTags.length > 0;
  const finalText = withSourceTag(out, opts);
  return { text: finalText, usedTags, usedAny };
}

// src/http.ts
import { createServer } from "node:http";
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
function startHttpServer(bridge, opts = {}) {
  const port = opts.port ?? 8777;
  const host = opts.host ?? "127.0.0.1";
  const staticFiles = opts.staticFiles || {};
  const onError = opts.onError || ((e) => console.error("[aiti-bridge] http error", e));
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const pathname = url.pathname;
      const path = pathname.split("/").filter(Boolean);
      const sfKey = pathname.startsWith("/aiti/") ? pathname.slice(5) : pathname;
      const sf = staticFiles[sfKey];
      const isBridgePath = path[0] === "bridge" || path[0] === "mcp" || path[0] === "aiti" && (path[1] === "bridge" || path[1] === "mcp");
      if (sf && !isBridgePath) {
        if (sf.status && sf.status >= 300) {
          res.writeHead(sf.status, { ...sf.headers || {}, "access-control-allow-origin": "*" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": sf.type || "application/octet-stream", "cache-control": "no-store", "access-control-allow-origin": "*" });
        res.end(sf.content || "");
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "Content-Type"
        });
        res.end();
        return;
      }
      const body = await readBody(req);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: body.length ? body : void 0
      });
      const response = await bridge.handle(request, path, url.searchParams);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body) {
        const reader = response.body.getReader();
        res.on("close", () => {
          reader.cancel().catch(() => {
          });
        });
        const pump = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              return;
            }
            res.write(value);
            pump();
          } catch (e) {
            res.end();
          }
        };
        pump();
      } else {
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      onError(e);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.on("error", onError);
      const realPort = server.address()?.port ?? port;
      const url = `http://${host}:${realPort}`;
      resolve({
        server,
        url,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

// src/connect.ts
var CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type"
};
function connectBridge(bridge, opts = {}) {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/";
  const staticFiles = opts.staticFiles || {};
  const onError = opts.onError || ((e) => console.error("[aiti-bridge] middleware error", e));
  return (req, res, next) => {
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    if (pathname !== prefix && !pathname.startsWith(prefix + "/")) return next();
    const rest = pathname === prefix ? "/" : pathname.slice(prefix.length);
    const pathArr = rest.split("/").filter(Boolean);
    const isBridgePath = pathArr[0] === "bridge" || pathArr[0] === "mcp" || pathArr[0] === "aiti" && (pathArr[1] === "bridge" || pathArr[1] === "mcp");
    const sf = staticFiles[rest] || staticFiles[rest.replace(/\/+$/, "") || "/"];
    if (sf && !isBridgePath) {
      if (sf.status && sf.status >= 300) {
        res.writeHead(sf.status, { ...sf.headers || {}, ...CORS_HEADERS });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": sf.type || "application/octet-stream", "cache-control": "no-store", ...CORS_HEADERS });
      res.end(sf.content || "");
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    const request = new Request(url, {
      method: req.method,
      headers: req.headers
    });
    readBody(req).then((buf) => {
      const r = new Request(url, { method: req.method, headers: req.headers, body: buf.length ? buf : void 0 });
      return bridge.handle(r, pathArr, url.searchParams);
    }).then((response) => {
      res.writeHead(response.status, { ...Object.fromEntries(response.headers.entries()), ...response.status === 204 ? {} : {} });
      if (response.body) {
        const reader = response.body.getReader();
        res.on("close", () => {
          reader.cancel().catch(() => {
          });
        });
        const pump = async () => {
          try {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              return;
            }
            res.write(value);
            pump();
          } catch {
            res.end();
          }
        };
        pump();
      } else {
        response.arrayBuffer().then((ab) => res.end(Buffer.from(ab))).catch(() => res.end());
      }
    }).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
      onError(e);
    });
  };
}

// src/endpoints.ts
var MCP_PATH_SUFFIXES = ["/mcp/mcp", "/bridge", "/mcp"];
function normalizeBridgeUrl(raw2, prefix) {
  const notes = [];
  let u;
  try {
    u = new URL(raw2);
  } catch {
    return { origin: raw2, notes: ["address could not be parsed; using as-is: " + raw2] };
  }
  let path = u.pathname.replace(/\/+$/, "") || "/";
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of MCP_PATH_SUFFIXES) {
      if (path.endsWith(suf)) {
        notes.push(`stripped path suffix "${suf}"`);
        path = path.slice(0, -suf.length) || "/";
        changed = true;
        break;
      }
    }
    if (!changed && prefix && prefix !== "/" && path.endsWith(prefix)) {
      notes.push(`stripped prefix "${prefix}"`);
      path = path.slice(0, -prefix.length) || "/";
      changed = true;
    }
  }
  if (path && path !== "/") notes.push(`dropped extra path "${path}" (treated as origin ${u.origin})`);
  return { origin: u.origin, notes };
}
function hasBridgePathSignature(raw2) {
  try {
    const p = new URL(raw2).pathname;
    return /\/aiti(\/|$)/.test(p) || /\/bridge(\/|$)/.test(p) || /\/mcp(\/|$)/.test(p);
  } catch {
    return false;
  }
}
function sameOrigin(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.host === ub.host;
  } catch {
    return false;
  }
}
function resolveEndpoints(input) {
  const prefix = (input.prefix || "/aiti").replace(/\/+$/, "") || "/";
  const serverUrl = String(input.serverUrl || "").replace(/\/+$/, "");
  const notes = [];
  let origin;
  let kind = "same-origin";
  if (!input.bridgeUrl) {
    origin = serverUrl;
  } else {
    const r = normalizeBridgeUrl(input.bridgeUrl, prefix);
    origin = r.origin;
    notes.push(...r.notes);
    if (sameOrigin(origin, serverUrl)) kind = "same-origin";
    else {
      kind = "external-bridge";
      if (!hasBridgePathSignature(input.bridgeUrl)) notes.push("input address has no bridge path signature (/aiti /bridge /mcp); treating it as a bridge address \u2014 if it is an aiti-agent (AI window) address, switch to the aiUrl field instead");
    }
  }
  const bridgeBase = origin + prefix;
  const cockpitUrl = bridgeBase + "/cockpit.html";
  const aiUrl = input.aiUrl && input.aiUrl.trim() ? input.aiUrl.replace(/\/+$/, "") : cockpitUrl;
  return {
    kind,
    origin,
    bridgeBase,
    launcherUrl: bridgeBase + "/aiti-launcher.js",
    // MCP 端点用一遍 /mcp（语义清晰：path[0]=mcp 即 MCP 端点）；/mcp/mcp 两遍旧形态兼容（协商剥后缀仍支持）
    mcpUrl: bridgeBase + "/mcp",
    cockpitUrl,
    aiUrl,
    notes
  };
}
async function probeBridge(bridgeBase, timeoutMs = 1500) {
  const base = bridgeBase.replace(/\/+$/, "");
  const url = base + "/aiti/mcp";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      return !!body && (body.jsonrpc === "2.0" || typeof body.result !== "undefined" || body.error !== void 0);
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

// src/mcp-config.ts
import { homedir } from "node:os";
import { join as join3, dirname as dirname3 } from "node:path";
import { existsSync as existsSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync as renameSync2, mkdirSync as mkdirSync3, rmSync as rmSync3 } from "node:fs";
var homeDir = () => homedir();
var MCP_TARGETS = {
  // pi 实际读取 getAgentDir()/mcp.json（getAgentDir = $PI_CODING_AGENT_DIR，默认 ~/.pi/agent）；
  // ~/.config/mcp/mcp.json 是历史误记——默认 pi 不读它（探针实证 2026-09-10，见执行记录 P17）
  pi: [{ path: () => join3(process.env.PI_CODING_AGENT_DIR || join3(homeDir(), ".pi", "agent"), "mcp.json"), key: "mcpServers" }],
  zcode: [{ path: () => join3(homeDir(), ".zcode", "cli", "config.json"), key: "mcpServers", keyPath: ["mcp", "servers"] }],
  opencode: [{
    path: () => join3(homeDir(), ".config", "opencode", "opencode.json"),
    key: "mcpServers",
    keyPath: ["mcp"],
    shimEntry: (shimPath) => ({ type: "local", command: ["node", shimPath], enabled: true }),
    envKey: "environment",
    // opencode 的 env map 字段名异构；条目零顶层私有键（schema 严格拒未知键）
    httpEntry: (url) => ({ type: "remote", url, enabled: true })
    // D23：http 类型对 opencode 非法
  }],
  claude: [
    { path: () => join3(homeDir(), ".claude.json"), key: "mcpServers" },
    { path: (p) => join3(p, ".mcp.json"), key: "mcpServers", project: true }
  ],
  // CodeBuddy Code（腾讯 cbc）：用户级 ~/.codebuddy/.mcp.json（官方 mcp.md：.mcp.json 推荐 /
  // mcp.json 已废弃；条目形状 mcpServers+stdio 与 claude 同构，2026-09-11 cbc mcp add 实测钉死）。
  // 项目级 .mcp.json 与 claude 同文件（claude 目标已覆盖），不重复注册。
  codebuddy: [{ path: () => join3(homeDir(), ".codebuddy", ".mcp.json"), key: "mcpServers" }],
  cursor: [{ path: () => join3(homeDir(), ".cursor", "mcp.json"), key: "mcpServers" }],
  windsurf: [{ path: () => join3(homeDir(), ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" }],
  vscode: [{ path: (p) => join3(p, ".vscode", "mcp.json"), key: "servers", project: true }],
  zed: [
    { path: () => join3(homeDir(), ".config", "zed", "settings.json"), key: "mcp" },
    { path: (p) => join3(p, ".zed", "settings.json"), key: "mcp", project: true }
  ]
};
function detectStructureKey(cfg) {
  if (cfg && typeof cfg === "object") {
    const c = cfg;
    if (c.mcpServers && typeof c.mcpServers === "object") return { key: "mcpServers", inferred: false };
    if (c.servers && typeof c.servers === "object") return { key: "servers", inferred: false };
    if (c.mcp && typeof c.mcp === "object") return { key: "mcp", inferred: false };
  }
  return { key: "mcpServers", inferred: true };
}
function readJson(path) {
  try {
    return { cfg: JSON.parse(stripBom(readFileSync2(path, "utf8"))) };
  } catch {
    try {
      const clean = stripJsonComments(stripBom(readFileSync2(path, "utf8"))).replace(/,\s*([}\]])/g, "$1");
      return { cfg: JSON.parse(clean) };
    } catch (e) {
      return { cfg: null, error: "JSON parse failed: " + String(e?.message || e) };
    }
  }
}
function stripBom(text) {
  return text.replace(/^\uFEFF/, "");
}
function isPlainContainer(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function stripJsonComments(text) {
  let out = "";
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      out += " ";
      continue;
    }
    out += c;
  }
  return out;
}
function resolveContainer(cfg, keyPath) {
  let cur = cfg;
  for (const k of keyPath) {
    if (!isPlainContainer(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  return cur;
}
function normalizeMcpUrl(raw2) {
  if (typeof raw2 !== "string" || !raw2.trim()) return null;
  try {
    const u = new URL(raw2.trim());
    const defaultPort = u.protocol === "http:" && u.port === "80" || u.protocol === "https:" && u.port === "443";
    const port = u.port && !defaultPort ? ":" + u.port : "";
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${path}${u.search}`;
  } catch {
    return null;
  }
}
function findEquivalentEntry(map, serverName, url) {
  const target = normalizeMcpUrl(url);
  if (!target) return null;
  for (const [name, entry] of Object.entries(map)) {
    if (name === serverName) continue;
    if (!isPlainContainer(entry)) continue;
    const record = entry;
    if (record.enabled === false) continue;
    if (normalizeMcpUrl(record.url) === target) return name;
  }
  return null;
}
function auditMcpServers(files) {
  const byName = /* @__PURE__ */ new Map();
  const byUrl = /* @__PURE__ */ new Map();
  for (const file of files) {
    if (!existsSync3(file)) continue;
    const cfg = readJson(file).cfg;
    if (!isPlainContainer(cfg)) continue;
    const det = detectStructureKey(cfg);
    const container = cfg[det.key];
    if (!isPlainContainer(container)) continue;
    for (const [name, entry] of Object.entries(container)) {
      if (!isPlainContainer(entry)) continue;
      const url = typeof entry.url === "string" ? entry.url : null;
      const norm = normalizeMcpUrl(url);
      if (!url || !norm) continue;
      byName.set(name, [...byName.get(name) || [], { file, url }]);
      byUrl.set(norm, [...byUrl.get(norm) || [], { name, file }]);
    }
  }
  return {
    sameName: [...byName.entries()].filter(([, urls]) => urls.length > 1 && new Set(urls.map((u) => normalizeMcpUrl(u.url))).size > 1).map(([name, urls]) => ({ name, urls })),
    sameUrl: [...byUrl.entries()].filter(([, entries]) => new Set(entries.map((e) => e.name)).size > 1).map(([url, entries]) => ({ url, entries }))
  };
}
function patchFile(path, key, serverName, url, dryRun, log, keyPath, httpEntry) {
  if (!existsSync3(path)) return { changed: false, error: "file not found" };
  const r = readJson(path);
  if (r.error) return { changed: false, error: "JSON parse failed: " + r.error };
  let cfg = r.cfg;
  if (!isPlainContainer(cfg)) return { changed: false, error: "config is not an object" };
  const map = keyPath ? resolveContainer(cfg, keyPath) : (() => {
    const det = detectStructureKey(cfg);
    if (det.inferred) log(`  \u26A0 ${path}: unrecognized structure (no mcpServers/servers/mcp key); writing as mcpServers`);
    if (!isPlainContainer(cfg[det.key])) cfg[det.key] = {};
    return cfg[det.key];
  })();
  const entry = map[serverName] && typeof map[serverName] === "object" && !Array.isArray(map[serverName]) ? map[serverName] : null;
  const prevUrl = entry && typeof entry.url === "string" ? entry.url : null;
  if (url === null) {
    if (!(serverName in map)) return { changed: false };
    if (!dryRun) {
      delete map[serverName];
      try {
        writeAtomic(path, cfg);
      } catch (e) {
        return { changed: false, error: "write failed: " + String(e?.message || e) };
      }
    }
    return { changed: true };
  }
  if (prevUrl === url) return { changed: false };
  const dupName = url === null ? null : findEquivalentEntry(map, serverName, url);
  if (dupName) {
    log(`  \u23ED ${path}: equivalent entry "${dupName}" already exists (same endpoint) \u2192 skipping write to avoid a double connection`);
    return { changed: false, duplicateOf: dupName };
  }
  map[serverName] = { ...entry || {}, ...httpEntry ? httpEntry(url) : { type: "http", url } };
  if (!dryRun) {
    try {
      writeAtomic(path, cfg);
    } catch (e) {
      return { changed: false, error: "write failed: " + String(e?.message || e) };
    }
  }
  return { changed: true };
}
function writeAtomic(path, cfg) {
  const tmp = path + ".tmp";
  const bak = path + ".bak";
  mkdirSync3(dirname3(path), { recursive: true });
  writeFileSync2(tmp, JSON.stringify(cfg, null, 2) + "\n");
  if (existsSync3(path)) {
    try {
      renameSync2(path, bak);
    } catch {
    }
  }
  try {
    renameSync2(tmp, path);
  } catch (e) {
    if (existsSync3(bak) && !existsSync3(path)) {
      try {
        renameSync2(bak, path);
      } catch {
      }
    }
    try {
      rmSync3(tmp, { force: true });
    } catch {
    }
    throw e;
  }
}
function listPlannedWrites(opts) {
  const projectDir = opts.projectDir || process.cwd();
  const out = [];
  const hasConfigPaths = !!(opts.configPaths && opts.configPaths.length);
  const auto = (opts.targets === "auto" || !opts.targets) && !hasConfigPaths;
  if (!hasConfigPaths) {
    const targets = auto ? Object.keys(MCP_TARGETS) : opts.targets;
    for (const t of targets) {
      const files = MCP_TARGETS[t];
      if (!files) continue;
      for (const f of files) {
        const p = f.path(projectDir);
        if (auto && !existsSync3(p)) continue;
        out.push({ target: t, path: p, key: f.key, exists: existsSync3(p), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry });
      }
    }
  }
  for (const p of opts.configPaths || []) {
    const abs = p.replace(/^~(?=\/|$)/, homeDir());
    let matched = null;
    for (const [t, files] of Object.entries(MCP_TARGETS)) {
      for (const f of files) {
        if (f.path(projectDir) === abs) {
          matched = { target: t, path: abs, key: f.key, exists: existsSync3(abs), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry };
          break;
        }
      }
      if (matched) break;
    }
    out.push(matched ?? { target: abs, path: abs, key: "mcpServers", exists: existsSync3(abs) });
  }
  return out;
}
function assertKnownTargets(targets) {
  if (!targets || targets === "auto") return null;
  const unknown = targets.filter((t) => !MCP_TARGETS[t]);
  return unknown.length ? `\u672A\u77E5\u6CE8\u518C\u76EE\u6807\uFF1A${unknown.join("\u3001")}\uFF08\u53EF\u7528\uFF1A${Object.keys(MCP_TARGETS).join("\u3001")}\uFF09` : null;
}
function registerMcp(opts) {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti-devtools";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l) => console.log(l));
  const results = [];
  let changed = false;
  for (const w of listPlannedWrites(opts)) {
    const r = patchFile(w.path, w.key, serverName, opts.url, dryRun, log, w.keyPath, w.httpEntry);
    if (r.error) {
      results.push({ target: w.target, path: w.path, changed: false, error: r.error });
      log(`  \u2717 ${w.target} \u2192 ${w.path}\uFF1A${r.error}`);
    } else {
      results.push({ target: w.target, path: w.path, changed: r.changed, duplicateOf: r.duplicateOf });
      if (r.changed) changed = true;
      if (r.duplicateOf) log(`  \u23ED ${w.target} \u2192 ${w.path}\uFF1A\u4E0E\u5DF2\u6709\u6761\u76EE "${r.duplicateOf}" \u540C\u4E00\u7AEF\u70B9\uFF08\u81EA\u68C0\u8DF3\u5199\uFF09`);
      else if (!w.exists) log(`  \u2713 ${w.target} \u2192 ${w.path}\uFF08\u65B0\u5EFA\uFF09`);
      else log(`  ${r.changed ? "\u2713" : "\xB7"} ${w.target} \u2192 ${w.path}${r.changed ? "" : "\uFF08\u5DF2\u662F\u6700\u65B0\uFF09"}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}MCP ${serverName} \u2192 ${opts.url}${results.length ? "\uFF1B" + results.map((r) => r.error ? r.target + " \u2717" : r.duplicateOf ? r.target + " \u23ED" : r.changed ? r.target + " \u2713" : r.target + " \xB7").join(" ") : "\uFF08\u65E0\u76EE\u6807\u6587\u4EF6\uFF09"}`;
  return { ok, changed, results, summary };
}
function unregisterMcp(opts) {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti-devtools";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l) => console.log(l));
  const results = [];
  let changed = false;
  const files = new Map([...(opts.configPaths || []).map((p) => [p.replace(/^~(?=\/|$)/, homeDir()), void 0])]);
  if (!files.size) {
    for (const t of Object.keys(MCP_TARGETS)) {
      for (const f of MCP_TARGETS[t]) {
        const p = f.path(opts.projectDir || process.cwd());
        if (existsSync3(p)) files.set(p, f.keyPath);
      }
    }
  }
  for (const [p, keyPath] of files) {
    if (!existsSync3(p)) continue;
    const det = detectStructureKey(readJson(p).cfg);
    const r = patchFile(p, det.key, serverName, null, dryRun, log, keyPath);
    results.push({ target: p, path: p, changed: r.changed, error: r.error });
    if (r.changed) changed = true;
    if (r.error) log(`  \u2717 ${p}\uFF1A${r.error}`);
    else log(`  ${r.changed ? "\u2713" : "\xB7"} ${p}${r.changed ? "\uFF1A\u5DF2\u79FB\u9664 " + serverName : "\uFF08\u65E0\u8BE5\u6761\u76EE\uFF09"}`);
  }
  const ok = results.every((r) => !r.error);
  return { ok, changed, results, summary: `${dryRun ? "[dry-run] " : ""}\u79FB\u9664 ${serverName}\uFF1A${results.length ? results.map((r) => r.error ? "\u2717 " : r.changed ? "\u2713 " : "\xB7 ").join("") : "\u65E0\u76EE\u6807\u6587\u4EF6"}` };
}
var LEGACY_VERSION_FIELD = "_aitiShimVersion";
var SHIM_VERSION_ENV = "AITI_SHIM_VERSION";
function readShimEntryVersion(entry, envKey) {
  const env = entry[envKey];
  if (!isPlainContainer(env)) return 0;
  return parseInt(String(env[SHIM_VERSION_ENV] ?? ""), 10) || 0;
}
function entryReferencesShimPath(entry, shimPath) {
  return JSON.stringify(entry).includes(JSON.stringify(shimPath));
}
function registerAitiShim(opts) {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l) => console.log(l));
  const results = [];
  let changed = false;
  for (const w of listPlannedWrites(opts)) {
    const outcome = (() => {
      let cfg;
      if (!existsSync3(w.path)) {
        cfg = {};
      } else {
        const r = readJson(w.path);
        if (r.error) return { changed: false, error: "JSON parse failed: " + r.error };
        cfg = r.cfg;
      }
      if (!isPlainContainer(cfg)) return { changed: false, error: "config is not an object" };
      const map = w.keyPath ? resolveContainer(cfg, w.keyPath) : (() => {
        const det = detectStructureKey(cfg);
        if (!isPlainContainer(cfg[det.key])) cfg[det.key] = {};
        return cfg[det.key];
      })();
      const existing = map[serverName] && typeof map[serverName] === "object" && !Array.isArray(map[serverName]) ? map[serverName] : null;
      const envKey = w.envKey || "env";
      const existingVer = existing ? readShimEntryVersion(existing, envKey) : 0;
      const hasLegacyField = !!existing && LEGACY_VERSION_FIELD in existing;
      const shimShapeBroken = !!w.shimEntry && !!existing && ("args" in existing || "env" in existing && envKey !== "env");
      if (existing && !hasLegacyField && !shimShapeBroken && existingVer >= opts.version && !opts.force && entryReferencesShimPath(existing, opts.shimPath)) {
        return { changed: false, note: `\u5DF2\u662F\u6700\u65B0\uFF08v${existingVer} >= v${opts.version}\uFF09` };
      }
      if (!dryRun) {
        const entry = { ...existing || {}, ...w.shimEntry ? w.shimEntry(opts.shimPath) : { type: "stdio", command: "node", args: [opts.shimPath] } };
        delete entry.url;
        delete entry[LEGACY_VERSION_FIELD];
        if (w.shimEntry) {
          delete entry.args;
          delete entry.env;
        }
        const prevEnv = isPlainContainer(entry[envKey]) ? entry[envKey] : {};
        entry[envKey] = { ...prevEnv, [SHIM_VERSION_ENV]: String(opts.version) };
        map[serverName] = entry;
        try {
          writeAtomic(w.path, cfg);
        } catch (e) {
          return { changed: false, error: "write failed: " + String(e?.message || e) };
        }
      }
      return { changed: true, note: hasLegacyField ? `\u8FC1\u79FB\uFF08\u9876\u5C42\u7248\u672C\u952E \u2192 ${envKey}.${SHIM_VERSION_ENV}\uFF09` : existing ? `\u5347\u7EA7 v${existingVer} \u2192 v${opts.version}` : "\u65B0\u5EFA" };
    })();
    results.push({ target: w.target, path: w.path, changed: outcome.changed, error: outcome.error });
    if (outcome.error) log(`  \u2717 ${w.target} \u2192 ${w.path}\uFF1A${outcome.error}`);
    else {
      if (outcome.changed) changed = true;
      log(`  ${outcome.changed ? "\u2713" : "\xB7"} ${w.target} \u2192 ${w.path}${outcome.note ? "\uFF1A" + outcome.note : ""}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}shim ${serverName} v${opts.version}\uFF08${opts.shimPath}\uFF09${results.length ? "\uFF1B" + results.map((r) => r.error ? r.target + " \u2717" : r.changed ? r.target + " \u2713" : r.target + " \xB7").join(" ") : "\uFF08\u65E0\u76EE\u6807\u6587\u4EF6\uFF09"}`;
  return { ok, changed, results, summary };
}
function unregisterAitiShim(opts) {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l) => console.log(l));
  const results = [];
  let changed = false;
  const planned = listPlannedWrites({ targets: opts.targets, configPaths: opts.configPaths, projectDir: opts.projectDir });
  const files = planned.filter((w) => existsSync3(w.path));
  for (const w of files) {
    const r = patchFile(w.path, w.key, serverName, null, dryRun, log, w.keyPath);
    results.push({ target: w.target, path: w.path, changed: r.changed, error: r.error });
    if (r.changed) changed = true;
    if (r.error) log(`  \u2717 ${w.target} \u2192 ${w.path}\uFF1A${r.error}`);
    else log(`  ${r.changed ? "\u2713" : "\xB7"} ${w.target} \u2192 ${w.path}${r.changed ? "\uFF1A\u5DF2\u79FB\u9664 " + serverName : "\uFF08\u65E0\u8BE5\u6761\u76EE\uFF09"}`);
  }
  const ok = results.every((r) => !r.error);
  return { ok, changed, results, summary: `${dryRun ? "[dry-run] " : ""}\u79FB\u9664 shim ${serverName}\uFF1A${results.length ? results.map((r) => r.error ? "\u2717 " : r.changed ? "\u2713 " : "\xB7 ").join("") : "\u65E0\u76EE\u6807\u6587\u4EF6"}` };
}
function resolveShimPathAuto(cwdCandidates) {
  const installedCandidates = [
    process.env.AITI_WEB_ROOT && join3(process.env.AITI_WEB_ROOT, "node_modules"),
    join3(homeDir(), ".pi", "web", "node_modules"),
    join3(homeDir(), ".pi", "web-dev", "node_modules")
  ].filter((p) => !!p).map((nm) => join3(nm, "@aiti-ai", "aiti-bridge", "bin", "aiti-mcp-shim.cjs"));
  const candidates = [
    process.env.AITI_SHIM_PATH,
    ...installedCandidates,
    ...cwdCandidates || [],
    join3(homeDir(), "workspace", "aiti-ai", "packages", "aiti-bridge", "bin", "aiti-mcp-shim.cjs")
  ].filter((p) => !!p);
  for (const p of candidates) {
    try {
      const m = readFileSync2(p, "utf8").match(/SHIM_VERSION\s*=\s*(\d+)/);
      if (m) return { shimPath: p, version: parseInt(m[1], 10) };
    } catch {
    }
  }
  return null;
}
function autoRegisterAitiShim(opts) {
  const log = opts.log || (() => {
  });
  try {
    const found = resolveShimPathAuto();
    if (!found) {
      log("[aiti] stdio shim \u672A\u627E\u5230\uFF08\u53EF\u8BBE env AITI_SHIM_PATH \u6307\u5411 aiti-mcp-shim.cjs\uFF09\uFF0C\u8DF3\u8FC7 MCP \u81EA\u6CE8\u518C");
      return null;
    }
    const r = registerAitiShim({
      shimPath: found.shimPath,
      version: found.version,
      configPaths: opts.configPaths,
      targets: opts.configPaths && opts.configPaths.length ? void 0 : opts.targets,
      projectDir: opts.projectDir,
      force: opts.force,
      log
    });
    return r;
  } catch (e) {
    log("[aiti] shim \u81EA\u6CE8\u518C\u5931\u8D25\uFF08\u5FFD\u7565\uFF0C\u4E0D\u5F71\u54CD agent \u542F\u52A8\uFF09\uFF1A" + String(e?.message || e));
    return null;
  }
}

// src/assets.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
var ASSET_NAMES = ["aiti-launcher.js", "bridge-client.js", "cockpit.html", "aiwin.js", "host-protocol.js", "pair-client.js"];
function loadAssets(assetsDir) {
  const dir = assetsDir || new URL("../assets/", import.meta.url).pathname;
  const out = {};
  for (const name of ASSET_NAMES) {
    try {
      const content = readFileSync3(join4(dir, name), "utf8");
      const type = name.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8";
      out["/" + name] = { type, content };
    } catch (e) {
      console.warn(`[aiti-devtools] \u26A0 \u8D44\u4EA7\u7F3A\u5931\uFF1A${join4(dir, name)}\uFF08${e.message}\uFF09\u2014\u2014\u5148\u8DD1 packages/aiti-devtools-core/tools/build-assets.mjs \u6216\u4F20 assetsDir`);
    }
  }
  return out;
}

// src/install.ts
import http from "node:http";
function aitiMiddleware(opts = {}) {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const name = opts.name || "aiti-devtools";
  const bridge = opts.bridge || createBridge();
  const bridgeMw = connectBridge(bridge, { prefix, staticFiles: loadAssets() });
  const tag = opts.tag === null ? null : opts.tag !== void 0 ? opts.tag : opts.bridgeUrl ? externalTag(opts.bridgeUrl, opts.aiUrl, name) : defaultTag(prefix, opts.aiUrl, name);
  const mw = (req, res, next) => {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      bridgeMw(req, res, () => {
        if (!res.headersSent) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found: " + pathname);
        }
      });
      return;
    }
    if (tag && shouldInject(req)) {
      if (req.headers["accept-encoding"] !== void 0) req.headers["accept-encoding"] = "identity";
      wrapResForInject(res, tag);
    }
    next();
  };
  return Object.assign(mw, { bridge });
}
function patchProcessHttp(opts = {}) {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const log = opts.log || ((l) => console.log(l));
  const sym = /* @__PURE__ */ Symbol.for("aiti-devtools.process-patched");
  if (globalThis[sym]) {
    log(`[aiti-devtools] \u8FDB\u7A0B\u7EA7 patch \u5DF2\u5B58\u5728\uFF0C\u8DF3\u8FC7`);
    return { bridge: globalThis.__aitiBridge };
  }
  const mw = aitiMiddleware(opts);
  globalThis.__aitiBridge = mw.bridge;
  globalThis[sym] = true;
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function(event, ...args) {
    if (event === "request") {
      const [req, res] = args;
      let passed = false;
      mw(req, res, () => {
        passed = true;
      });
      if (!passed) return true;
    }
    return origEmit.call(this, event, ...args);
  };
  const mcp = opts.mcp || {};
  if (mcp.register !== false && mcp.targets !== false) {
    const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : NaN);
    if (Number.isFinite(port)) {
      const host = opts.host || "localhost";
      const url = opts.bridgeUrl ? normalizeBridgeUrl(opts.bridgeUrl, "/aiti").origin + "/aiti/mcp" : `http://${host}:${port}${opts.prefix || "/aiti"}/mcp`;
      const r = registerMcp({
        url,
        serverName: opts.name,
        targets: mcp.targets === false ? void 0 : mcp.targets || "auto",
        configPaths: mcp.configPaths || [],
        projectDir: mcp.projectDir,
        dryRun: !!mcp.dryRun,
        log
      });
      log(`[aiti-devtools] MCP \u6CE8\u518C\uFF1A${r.summary}`);
    } else {
      log(`[aiti-devtools] \u672A\u63D0\u4F9B\u7AEF\u53E3\uFF08opts.port / PORT env\uFF09\uFF0C\u8DF3\u8FC7 MCP \u6CE8\u518C`);
    }
  }
  log(`[aiti-devtools] \u8FDB\u7A0B\u7EA7\u6302\u8F7D\u5B8C\u6210\uFF08\u6865\u8DEF\u7531 + HTML \u6CE8\u5165\uFF09`);
  return { bridge: mw.bridge };
}
function defaultTag(prefix, aiUrl, name) {
  return `<script src="${prefix}/aiti-launcher.js" data-ai-url="${aiUrl || prefix + "/cockpit.html"}" data-bridge-url="${prefix}"${name ? ` data-name="${name}"` : ""} defer></script>`;
}
function externalTag(bridgeUrl, aiUrl, name) {
  const r = normalizeBridgeUrl(bridgeUrl, "/aiti");
  const base = r.origin + "/aiti";
  return `<script src="${base}/aiti-launcher.js" data-ai-url="${aiUrl || base + "/cockpit.html"}" data-bridge-url="${base}"${name ? ` data-name="${name}"` : ""} defer></script>`;
}
function shouldInject(req) {
  const sfm = String(req.headers["sec-fetch-mode"] || "");
  if (sfm && sfm !== "navigate") return false;
  return true;
}
function wrapResForInject(res, tag) {
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origSetHeader = res.setHeader.bind(res);
  const origWriteHead = res.writeHead.bind(res);
  let ctCache;
  const isHtml = () => {
    const ct = ctCache !== void 0 ? ctCache : String(res.getHeader("content-type") || "");
    return ct.includes("text/html");
  };
  const stripCl = (h) => {
    const o = { ...h };
    delete o["Content-Length"];
    delete o["content-length"];
    delete o["Transfer-Encoding"];
    delete o["transfer-encoding"];
    return o;
  };
  res.setHeader = function(k, v) {
    if (String(k).toLowerCase() === "content-type" && typeof v === "string") ctCache = v;
    if (isHtml() && String(k).toLowerCase() === "content-length") return this;
    return origSetHeader(k, v);
  };
  res.writeHead = function(status, ...rest) {
    const hs = rest[0];
    if (hs && typeof hs === "object") {
      const h = hs;
      const ct = h["Content-Type"] || h["content-type"];
      if (typeof ct === "string" && ctCache === void 0) ctCache = ct;
      if (isHtml()) return origWriteHead(status, stripCl(h), ...rest.slice(1));
    }
    return origWriteHead(status, ...rest);
  };
  const injectAt = (buf) => {
    const head = buf.toString("utf8");
    const m = head.match(/^\s*<!DOCTYPE[^>]*>/i);
    if (m) {
      const at = m[0].length;
      return Buffer.concat([buf.subarray(0, at), Buffer.from("\n" + tag), buf.subarray(at)]);
    }
    return Buffer.concat([Buffer.from(tag), buf]);
  };
  let injected = false;
  res.write = function(chunk, ...rest) {
    if (!injected && isHtml() && chunk != null) {
      injected = true;
      return origWrite(injectAt(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))), ...rest);
    }
    return origWrite(chunk, ...rest);
  };
  res.end = function(chunk, ...rest) {
    if (!injected && isHtml() && chunk != null) {
      injected = true;
      return origEnd(injectAt(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))), ...rest);
    }
    return origEnd(chunk, ...rest);
  };
}

// src/inject-html.ts
function launcherTag(opts = {}) {
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  const name = opts.name || "aiti-devtools";
  return opts.tag || `<script src="${prefix}/aiti-launcher.js" data-ai-url="${prefix}/cockpit.html" data-bridge-url="${prefix}" data-name="${name}" defer></script>`;
}
function htmlInjectMiddleware(opts = {}) {
  const tag = launcherTag(opts);
  const prefix = (opts.prefix || "/aiti").replace(/\/+$/, "") || "/aiti";
  return (req, res, next) => {
    try {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      if (pathname === prefix || pathname.startsWith(prefix + "/")) return next();
    } catch {
    }
    const sfm = String(req.headers["sec-fetch-mode"] || "");
    if (sfm && sfm !== "navigate") return next();
    const isHtmlResponse = (r) => {
      const ct = r.getHeader("content-type");
      return typeof ct === "string" && ct.includes("text/html");
    };
    const origWrite = res.write;
    const origEnd = res.end;
    const origSetHeader = res.setHeader;
    res.setHeader = function(k, v) {
      if (String(k).toLowerCase() === "content-length") return this;
      return origSetHeader.call(this, k, v);
    };
    let injected = false;
    res.write = function(chunk, ...rest) {
      if (!injected && isHtmlResponse(this) && chunk !== void 0 && chunk !== null) {
        injected = true;
        const buf = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(String(chunk));
        return origWrite.call(this, Buffer.concat([Buffer.from(tag), buf]), ...rest);
      }
      return origWrite.call(this, chunk, ...rest);
    };
    res.end = function(chunk, ...rest) {
      if (!injected && isHtmlResponse(this) && chunk !== void 0 && chunk !== null) {
        injected = true;
        const buf = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(String(chunk));
        return origEnd.call(this, Buffer.concat([Buffer.from(tag), buf]), ...rest);
      }
      return origEnd.call(this, chunk, ...rest);
    };
    next();
  };
}
export {
  ASSET_NAMES,
  BRIDGE_TOOLS,
  MCP_TARGETS,
  ORPHAN_NOTICE,
  PLACEHOLDER_RE,
  aitiMiddleware,
  auditMcpServers,
  autoRegisterAitiShim,
  clipUrl,
  connectBridge,
  createBridge,
  detectStructureKey,
  hasBridgePathSignature,
  htmlInjectMiddleware,
  launcherTag,
  loadAssets,
  normalizeBridgeUrl,
  normalizeMcpUrl,
  patchProcessHttp,
  probeBridge,
  readBody,
  registerAitiShim,
  registerMcp,
  replaceTag,
  resolveEndpoints,
  resolveShimPathAuto,
  rewriteMessage,
  sameOrigin,
  startHttpServer,
  stripOrphanTags,
  unregisterAitiShim,
  unregisterMcp,
  withSourceTag
};
