/* aiti-devtools-pi · pi 扩展（内嵌桥 + 工具直连）· 构建产物，勿手改 */

// src/index.ts
import { join as join3, resolve, dirname as dirname3 } from "node:path";
import { readFileSync as readFileSync3, existsSync as existsSync3, writeFileSync as writeFileSync3, openSync, appendFileSync as appendFileSync2, mkdirSync as mkdirSync3 } from "node:fs";
import { spawn as spawn2 } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ../aiti-devtools-core/src/bridge.ts
import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync, statSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
var ID_TTL = parseInt(process.env.AITI_BRIDGE_TTL || "600000", 10);
var AGENT_TTL = parseInt(process.env.AITI_AGENT_TTL || "3600000", 10);
var BROADCAST_TTL = parseInt(process.env.AITI_BROADCAST_TTL || "600000", 10);
var AGENT_GRACE_TTL = parseInt(process.env.AITI_AGENT_GRACE_TTL || "120000", 10);
var AGENT_HISTORY_TTL = parseInt(process.env.AITI_AGENT_HISTORY_TTL || String(7 * 24 * 3600 * 1e3), 10);
var SWEEP_MS = parseInt(process.env.AITI_SWEEP_MS || "60000", 10);
var LEGACY_TOKEN = "dev";
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
        console.log(TAG + " AI 主窗口活跃绑定：" + key + " → " + pageId);
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
  const agentKey = (aid, sid) => safeId(aid) + "/" + safeId(sid || "s_" + randomBytes(3).toString("hex"));
  const randomSessionId = () => "s_" + randomBytes(3).toString("hex");
  const OUTBOX_MAX = 200;
  const safeId = (s) => String(s || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  const msgSessionDir = (agentId2) => join(dataDir, "aiti-bridge", "sessions", safeId(agentId2));
  const msgSessionFile = (agentId2) => {
    const dir = msgSessionDir(agentId2);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
    if (files.length) {
      const latest = join(dir, files[files.length - 1]);
      try {
        if (statSync(latest).size > 2 * 1024 * 1024) return newMsgSessionFile(agentId2);
      } catch {
      }
      return latest;
    }
    return newMsgSessionFile(agentId2);
  };
  const newMsgSessionFile = (agentId2) => {
    const dir = msgSessionDir(agentId2);
    mkdirSync(dir, { recursive: true });
    return join(dir, (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + "_" + randomBytes(8).toString("hex") + ".jsonl");
  };
  const appendMsgEvent = (agentId2, evt) => {
    try {
      const file = msgSessionFile(agentId2);
      if (!existsSync(file)) appendFileSync(file, JSON.stringify({ type: "session", version: 1, id: randomBytes(8).toString("hex"), timestamp: (/* @__PURE__ */ new Date()).toISOString(), kind: "aiti-bridge" }) + "\n");
      appendFileSync(file, JSON.stringify(evt) + "\n");
    } catch (e) {
    }
  };
  const readMsgSession = (agentId2) => {
    const rows = [];
    try {
      const dir = msgSessionDir(agentId2);
      if (!existsSync(dir)) return rows;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
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
  const restoreAgentOutbox = (agentId2, agent) => {
    for (const row of readMsgSession(agentId2)) {
      if (row.status !== "consumed") agent.outbox.push({ ...row, status: "pending" });
    }
  };
  const ensureAgent = (agentId2, sessionId, session) => {
    if (!agentId2) return { a: null, key: null };
    const aid = safeId(agentId2);
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
      console.log(TAG + " agent 会话注册：" + key + (a.registered ? "（显式）" : "（随机 session，引导 aiti_hello 注册）") + " " + a.transportKind + " 恢复 outbox " + a.outbox.length + " 条");
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
    const m = { id: randomBytes(4).toString("hex"), ...msg, pageId: srcPageId, url: srcUrl, source: msg.source || msg.payload && msg.payload.source || null, sourceLabel: msg.sourceLabel || msg.payload && msg.payload.sourceLabel || null, agentId: key, at: (/* @__PURE__ */ new Date()).toISOString(), status: "pending" };
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
    const rootDir = join(dataDir, "aiti-bridge", "sessions");
    let dirs = [];
    try {
      dirs = existsSync(rootDir) ? readdirSync(rootDir) : [];
    } catch {
      return;
    }
    for (const d of dirs) {
      try {
        const p = join(rootDir, d);
        const st = statSync(p);
        if (!st.isDirectory()) continue;
        const files = readdirSync(p).filter((f) => f.endsWith(".jsonl"));
        let mtime = st.mtimeMs;
        for (const f of files) {
          try {
            mtime = Math.max(mtime, statSync(join(p, f)).mtimeMs);
          } catch {
          }
        }
        if (now - mtime > AGENT_HISTORY_TTL) {
          rmSync(p, { recursive: true, force: true });
          console.log(TAG + " 清理历史 session（> " + Math.round(AGENT_HISTORY_TTL / 864e5) + " 天无活动）：" + d);
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
        console.log(TAG + " agent 清理（掉线 > " + Math.round(AGENT_TTL / 6e4) + "min）：" + key + " " + (a.name || "") + "（offlineAt " + new Date(a.offlineAt).toISOString() + "）");
        agents.delete(key);
        const idx = agentIdx.get(a.agentId);
        if (idx) {
          idx.delete(key);
          if (!idx.size) agentIdx.delete(a.agentId);
        }
      }
    }
    for (const [k, v] of lastEventPush) if (now - v.ts > 36e5) lastEventPush.delete(k);
    for (const [iid, p] of [...pages]) {
      if (p.writer?.viaBus && now - (p.writer.lastSeen || 0) > BUS_CONN_TTL) {
        pages.delete(iid);
        console.log(TAG + " 总线型页面连接超时摘除：" + iid);
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
    if (!targets.length) return { ok: false, error: "无已注册 agent 会话（agent 连桥并注册后才有收件箱）" };
    const delivered = [];
    for (const t of targets) {
      const { a } = ensureAgent(t.split("/")[0], t.split("/").slice(1).join("/"), null);
      const srcLabel = a && a.source === "extension" ? "aiti-*" : DISPLAY_NAME + " MCP";
      let srcPageId = payload && payload.pageId || null;
      let srcUrl = payload && payload.url || null;
      let srcTitle = payload && payload.title || null;
      if (!srcPageId) {
        const bind = a && a.boundPageId ? resolvePageId(a.boundPageId) : null;
        const rows = listSessions().filter((r) => r.active && r.pageId);
        const pick = bind && bind.pageId && rows.find((r) => r.pageId === bind.pageId) || (rows.length === 1 ? rows[0] : null);
        if (pick) {
          srcPageId = pick.pageId;
          srcUrl = pick.url;
          srcTitle = pick.title || null;
        }
      } else if (!srcUrl) {
        const row = listSessions().find((r) => r.pageId === srcPageId);
        if (row) {
          srcUrl = row.url || null;
          srcTitle = srcTitle || row.title || null;
        }
      }
      const clipMid = (s, max) => {
        s = String(s || "");
        if (s.length <= max) return s;
        const half = Math.max(8, Math.floor((max - 1) / 2));
        return s.slice(0, half) + "…" + s.slice(s.length - half);
      };
      let tText = String(text);
      if (srcPageId && tText.indexOf("[发自: ") < 0) {
        const parts = [srcPageId];
        if (srcUrl) parts.push(clipMid(srcUrl, 64));
        if (srcTitle) parts.push(clipMid(srcTitle, 40));
        tText = tText + "\n[发自: " + parts.join(" · ") + "（" + srcLabel + "：pageId 参数用它）]";
      }
      payload = { ...payload || {}, source: a && a.source || null, sourceLabel: srcLabel, pageId: srcPageId, url: srcUrl, title: srcTitle };
      const canSample = !!(a && a.stream && a.capabilities && a.capabilities.sampling && (kind === "user_message" || kind === "chat"));
      if (canSample) {
        const rid = "smp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
        const done = (ok, result) => {
          if (!pendingSampling.delete(rid)) return;
          const answer2 = ok ? samplingTextOf(result) : result && result.error || "sampling 失败";
          console.log(TAG + " sampling 作答 → agent=" + t + " · " + String(answer2).slice(0, 80));
          for (const w of aiConns) w.write({ type: "agent_answer", agentKey: t, agentId: a.agentId, ok, text: answer2, requestId: rid, at: Date.now() });
        };
        pendingSampling.set(rid, { agentKey: t, done, at: Date.now() });
        a.stream.write({
          jsonrpc: "2.0",
          id: rid,
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: tText } }],
            systemPrompt: "（调试现场的人通过 " + DISPLAY_NAME + " 发来的消息。目标页 pageId=" + (payload.pageId || "?") + "。直接回答即可，简短。",
            maxTokens: 1024,
            temperature: 0.3
          }
        });
        setTimeout(() => done(false, { error: "sampling 超时（agent 未响应或需审批确认）" }), SAMPLING_TIMEOUT_MS);
        delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "sampling" });
      } else {
        const q = queueMsg(t, { kind, from: "window", text: tText, payload, pageId: payload && payload.pageId || null, source: payload.source, sourceLabel: payload.sourceLabel, ref });
        if (typeof a.inProcessSink === "function") {
          try {
            a.inProcessSink(tText, kind, payload);
          } catch (e) {
            console.error(TAG + " inProcessSink 失败", e);
          }
          const m0 = q && q.msg;
          if (m0 && m0.status === "pending") {
            m0.status = "delivered";
            appendMsgEvent(t, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: m0.id, status: "delivered", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
            for (const w of aiConns) w.write({ type: "msg_status", agentKey: t, msgId: m0.id, status: "delivered" });
          }
          delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "inprocess" });
        } else if (a.agentStream && !pushDeduped(t, "push:" + kind + tText)) {
          a.agentStream.write({ type: "agent_push", kind, text: tText, payload, at: Date.now() });
          const m = q && q.msg;
          if (m && m.status === "pending") {
            m.status = "delivered";
            appendMsgEvent(t, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: m.id, status: "delivered", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
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
        console.error(TAG + " inProcessSink 失败", e);
      }
    }
    queueMsg(agentKey2, { kind: "user_answer", from: "page", text, payload: result });
  };
  const formatPageEvent = (eventType, payload, pageInfo) => {
    const where = pageInfo && pageInfo.url ? pageInfo.pageId ? `[${pageInfo.pageId} · ${pageInfo.url}]` : `[${pageInfo.url}]` : "";
    if (eventType === "page_error") {
      const pl = payload || {};
      return `⚠ 页面报错${where} ${pl.kind || ""} ${String(pl.message || "").slice(0, 300)}` + (pl.stack ? `
${String(pl.stack).slice(0, 400)}` : "");
    }
    if (eventType === "page_log") {
      const items = ((payload || {}).logs || (payload || {}).batch || []).slice(0, 5);
      return `📋 页面日志${where}: ` + items.map((l) => `[${l.level}] ${String(l.text || "").slice(0, 120)}`).join(" | ");
    }
    if (eventType === "page_network") {
      const items = ((payload || {}).requests || (payload || {}).batch || []).slice(0, 5);
      return `🌐 页面网络${where}: ` + items.map((r) => `${r.method || "?"} ${String(r.url || "").slice(0, 80)} → ${r.status ?? "?"}${r.error ? " ERR" : ""}`).join(" | ");
    }
    return `📢 页面事件${where}: ${JSON.stringify(payload).slice(0, 200)}`;
  };
  const pushEventToSubscribers = (eventType, payload, pageInfo) => {
    const sigBase = eventType + ":" + JSON.stringify(payload).slice(0, 120);
    const now = Date.now();
    for (const [key, a] of agents) {
      if (!a.subEvents || !a.subEvents.has(eventType)) continue;
      if (!agentOnline(a) && now - (a.offlineAt || a.lastSeen || 0) > BROADCAST_TTL) continue;
      if (pushDeduped(key, sigBase)) {
        console.log(TAG + " push 去重（5s 内同事件）" + key + " " + eventType);
        continue;
      }
      const text = formatPageEvent(eventType, payload, pageInfo);
      if (a.agentStream) a.agentStream.write({ type: "page_event", event: eventType, text, pageId: pageInfo && pageInfo.pageId || null, url: pageInfo && pageInfo.url || null, at: Date.now() });
      else {
        queueMsg(key, { kind: "page_" + eventType, from: "page", text, payload });
        console.log(TAG + " push 无流 → outbox " + key + " " + eventType);
      }
    }
  };
  const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extraHeaders }
  });
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type" };
  const pickedReports = /* @__PURE__ */ new Map();
  const pickedFile = dataDir ? join(dataDir, "picked.json") : "";
  try {
    if (pickedFile && existsSync(pickedFile)) {
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
      mkdirSync(dirname(pickedFile), { recursive: true });
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
    return randomBytes(12).toString("hex");
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
  const withDevice = (row, dev, label) => {
    if (dev && typeof dev === "object") {
      row.device = dev;
      row.deviceLabel = label || [dev.browser || "?", dev.os || "", dev.screen || ""].filter(Boolean).join(" · ");
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
      const selfRow = { instanceId: rec.instanceId, frameId: "ai", pageId: selfPageId, url: rec.url || null, title: rec.title ? rec.title + " · AI 主窗口" : "AI 主窗口", frameworks: null, active: true, viaAI: true, self: true, lastSeen: rec.lastSeen };
      withDevice(selfRow, rec.device, rec.deviceLabel);
      addMine(selfRow);
      out.push(selfRow);
    }
    return out;
  }
  const TOOLS = [
    {
      name: "page_exec",
      description: "在已连接页面执行类 CDP 命令（DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser 域）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。危险命令/浏览器受限操作会自动弹用户确认；Page.captureScreenshot 截屏会先弹准备卡展示截取意图（args.reason，请务必用一句话说明想截什么），用户调整好页面才开始截屏，截完再弹预览确认（大图自动落盘返回文件路径）；确认卡倒计时可用 args.timeout（ms）调整（默认 280000，服务端安全网自动同步 +30s 余量）。调试会话中从被调试页面（inject）发出的消息统一带 [发自: <pageId> · <url>] 来源标注——把 pageId 值传给 pageId 参数即操作该页面。\n\niframe 支持：Page.getFrameTree 查看 frame 树（iframe src/name/title，同域含 url/readyState）；Runtime.evaluate 传 contextId（iframe 索引从 1 起，同域可 eval）进 iframe 上下文执行。",
      inputSchema: { type: "object", properties: {
        cmd: { type: "string" },
        args: { type: "object" },
        pageId: { type: "string", description: "目标页面完整 ID——来自 AI 消息的 [发自: xxx]（如 3001/host）；也可 /bridge/sessions 查询" }
      }, required: ["cmd"] }
    },
    { name: "page_snapshot", description: "拉取已连接页面基础现场（URL/选区/模拟条件）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。", inputSchema: { type: "object", properties: { pageId: { type: "string" } } } },
    { name: "self_ui", description: "扫描目标页面（缺省 AI 主窗口 xxx/ai）当前打开的弹窗/dialog/表单字段/按钮清单——ai-helper 回填定位用。返回 {dialogs:[{title, fields:[{label,selector,type}], buttons}]}，无弹窗时 dialogs 为空数组。", inputSchema: { type: "object", properties: { pageId: { type: "string", description: "缺省用 AI 主窗口（xxx/ai）；也可指定其他页面" } } } },
    { name: "form_fill", description: "在目标页面（缺省 AI 主窗口 xxx/ai）的弹窗/表单里回填字段值——AI 结果直接操作扩展弹窗表单（React 兼容：原生 value setter + dispatch input/change）。配合 self_ui 使用：先 self_ui 拿字段 label/selector，再 form_fill 填值。参数：dialog（弹窗标识：标题子串或序号 0 起，缺省取面积最大的可见弹窗）、fields[{selector|label, value}]、button（可选，回填后点击的按钮文本如『保存』）。返回 {foundDialog, title, filled, missed, clicked}。", inputSchema: { type: "object", properties: {
      pageId: { type: "string", description: "缺省用 AI 主窗口（xxx/ai）；也可指定其他页面" },
      dialog: { type: "string", description: "弹窗标识：标题子串或序号（0 起）；缺省取面积最大的可见弹窗" },
      fields: { type: "array", items: { type: "object", properties: { selector: { type: "string", description: "CSS 选择器（优先）" }, label: { type: "string", description: "弹窗内文本匹配（label[for]/包裹/文本包含）" }, value: { type: "string", description: "要填的值" } }, required: ["value"] }, description: "要填的字段列表" },
      button: { type: "string", description: "回填后点击的按钮文本（如『保存』『确定』）" }
    } } },
    { name: "bridge_status", description: "查询已连接页面（sessions：含 pageId/url/title/frameworks + device/deviceLabel——浏览器·OS·屏幕·dpr·在线·语言·时区等设备信息，便于区分多台机器/标签页）与挂起请求。用户提到页面标题或 URL 时，按 title/url 匹配 pageId（如 refresh『某标题页面』或『某个 url 页面』）。", inputSchema: { type: "object", properties: {} } },
    {
      name: "page_logs",
      description: "从目标页面拉取本地缓冲的 console 日志（log/debug/info/warn/error 全量，CDP Runtime.evaluate 读取 window.__dbg.__consoleRing）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。页面报错排查首选：先查 warn/error 再逐步放开。返回 {logs:[{ts,level,text,count}], bufferSize}。",
      inputSchema: { type: "object", properties: {
        pageId: { type: "string", description: "目标页面完整 ID（[发自: xxx] 或 /bridge/sessions）" },
        level: { type: "string", description: "过滤级别：debug/log/info/warn/error（默认全部）" },
        since: { type: "string", description: "ISO 时间：只返回此时间之后的日志" },
        limit: { type: "number", description: "条数上限（≤200，默认 50，取最新）" },
        token: { type: "string" }
      } }
    },
    {
      name: "page_network",
      description: "从目标页面拉取本地缓冲的 ajax/fetch 请求完成态（CDP Runtime.evaluate 读取 window.__dbg.__netRing）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。失败排查：status 传 400 或 errorOnly:true。注意：不含静态资源加载（那是 CDP Network 的能力）。返回 {requests:[{kind,method,url,status,statusText,durationMs,size,error,ts}], bufferSize}。",
      inputSchema: { type: "object", properties: {
        pageId: { type: "string" },
        url: { type: "string", description: "URL 子串过滤" },
        status: { type: "number", description: "status >= 此值才返回（如 400 只看失败）" },
        errorOnly: { type: "boolean", description: "只看失败（error 非空 或 status>=400）" },
        limit: { type: "number", description: "条数上限（≤100，默认 30，取最新）" },
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
      description: "请当前页面的人类用户点选一个页面元素（自动进入 Inspector 点选模式、收起 AI 窗口、弹点选面板；用户可确认选中或拒绝）。返回元素载荷 {tag,rect,xpath,text,attributes,framework,selector}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "给用户看的说明（为什么需要点选这个元素）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string", description: "目标页面完整 ID（instanceId/frameId）" }
      }, required: ["prompt"] }
    },
    {
      name: "user_confirm",
      description: "在 AI 窗口内向人类用户提一个是/否问题（如“确认执行此操作？”“是否继续？”），用户点 ✅/❌ 作答，并可附「补充说明」自由文本（value.comment）；另有固定选项「都不适合」→ 自定义回答（approved:null, custom）。返回 {status, approved, comment?, custom?, reason?}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "问题内容" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户以“暂时无法处理”拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送（不阻塞本调用）；缺省=同步等待" },
        pageId: { type: "string" }
      }, required: ["prompt"] }
    },
    {
      name: "user_choose",
      description: "在 AI 窗口内给人类用户一组选项让其选择（如修复方案 A/B/C）。单选（默认）→ value:{index,label}；multiple:true 多选 → value:{indexes,labels}。用户可附「补充说明」自由文本（value.comment）；另有固定选项「这些都不适合」→ 自定义答案（index:-1, custom:true）。返回 {status, value, reason?}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string" },
        choices: { type: "array", items: { type: "string" }, description: "选项列表（2-8 个）" },
        multiple: { type: "boolean", description: "是否允许多选（默认 false；true 时返回 indexes/labels）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" }
      }, required: ["prompt", "choices"] }
    },
    {
      name: "user_input",
      description: "在 AI 窗口内请人类用户输入一段文本（如期望文案、配置值、场景描述），回车/点击即发送。返回 {status, value:{text}, reason?}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string" },
        defaultValue: { type: "string", description: "预填默认值（可选）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" }
      }, required: ["prompt"] }
    },
    {
      name: "user_presence",
      description: "探测人类用户是否在场/在线（AI 需要用户配合长任务前先确认），用户点「我在/稍后」，可附「补充说明」（value.comment）。返回 {status, present, comment?}；超时即视为不在线。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "询问文案（默认“你在吗？需要你配合继续开发”）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户作答；传了才显示读秒倒计时（可暂停），到点返回 status:'timeout'（视为不在线）——需要快速探测在场/限时等待时才显式传" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" }
      }, required: [] }
    },
    {
      name: "user_notify",
      description: "非阻塞通知：通过浏览器 Notification 告诉用户一条消息（如“修复完成，请刷新验证”），不等待回答。返回 {notified:true}。",
      inputSchema: { type: "object", properties: {
        title: { type: "string", description: "通知标题" },
        body: { type: "string", description: "通知内容" },
        timeout: { type: "number", description: "可选：通知卡自动关闭时限 ms（5000-600000）。不传=常驻直到用户关闭" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" }
      }, required: ["body"] }
    },
    // ---- 方案 G · P2：agent 接入 + 消息主通道 ----
    {
      name: "aiti_hello",
      description: "agent 自我介绍/注册：覆盖 agentId（默认 clientInfo.name）与 sessionId（默认 Mcp-Session-Id 或桥随机）、绑定默认目标页 pageId、订阅页面事件（page_error）。注意：page_log/page_network 不再实时推送，改用 page_logs/page_network 工具按需拉取。建议会话开始时调用一次——注册后消息可定向到本会话（agentKey=agentId/sessionId）。",
      inputSchema: { type: "object", properties: {
        agentId: { type: "string", description: "自定义 agent 标识（如 pi / cc / qoder；缺省用 clientInfo.name）" },
        sessionId: { type: "string", description: "本实例会话标识（多实例/多会话时区分；缺省用 Mcp-Session-Id，无则桥生成随机）" },
        name: { type: "string", description: "显示名（可选，如 'pi · 工作区A'）" },
        cwd: { type: "string", description: "工作目录（可选，显示 CWD . name (id)，方便识别 agent 身份）" },
        pageId: { type: "string", description: "绑定默认调试目标页（pageId/url/title 均可，留空不绑）" },
        subEvents: { type: "array", items: { type: "string" }, description: "订阅实时事件：page_error（默认不投递，显式订阅才推；page_log/page_network 不再实时推送，改用 page_logs/page_network 工具按需拉取）" }
      } }
    },
    {
      name: "file_stat",
      description: "查询文件存在性/类型/大小/修改时间（绝对路径；组件源码/调用位置定位、AI 窗『后端打开/前端打开』前置校验用）。不存在或非法路径返回 {exists:false}。",
      inputSchema: { type: "object", properties: {
        path: { type: "string", description: "绝对路径（如 /home/user/src/App.vue）" }
      }, required: ["path"] }
    },
    {
      name: "aiti_inbox",
      description: "消息主通道：拉取发给本 agent 会话的消息（人主动发话 user_message / 异步 user_* 作答 user_answer / 订阅的页面事件）。开始新一轮或需要最新信息时先调用；处理完把消息 id 放 ack 参数确认（标记 consumed，历史保留）。返回 agentKey（agentId/sessionId），未注册时提示调 aiti_hello 注册。",
      inputSchema: { type: "object", properties: {
        agentId: { type: "string", description: "agent 标识（缺省用 aiti_hello 注册值或 clientInfo.name）" },
        sessionId: { type: "string", description: "本实例会话标识（缺省用 Mcp-Session-Id 或 aiti_hello 注册值）" },
        ack: { description: "已处理消息 id 列表，或 { ids: [...], summary: '执行总结' }——summary（必带）会作为 agent 处理记录显示在操作台消息流", oneOf: [{ type: "array", items: { type: "string" } }, { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, summary: { type: "string" } } }] }
      } }
    }
  ];
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
    console.log(TAG + " ✂ 请求已取消：" + requestId + " · " + reason);
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
        if (d.closest && d.closest('#__dbg_launcher')) continue; // 排除 aiti 自身
        var already = false;
        for (var j = 0; j < dialogs.length; j++) if (dialogs[j].contains(d)) { already = true; break; }
        if (already) continue;
        if (d.parentElement && dialogs.indexOf(d.parentElement) >= 0) continue;
        dialogs.push(d);
      }
      if (!dialogs.length) {
        // 兜底：可见的 fixed/absolute 面板（宽度 > 40% 视口且 zIndex 高）
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
          if (!label && isCE) label = String((f.getAttribute && (f.getAttribute('data-placeholder') || f.getAttribute('aria-label'))) || (f.innerText || '').trim()).slice(0, 40) || ('可编辑区域' + (n + 1));
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
      if (!dialog) return { foundDialog: false, filled: 0, missed: 0, clicked: false, error: '未找到可见弹窗（先用 self_ui 确认弹窗已打开）' };
      var setNative = function (el, value) {
        var text = String(value == null ? '' : value);
        // contenteditable（富文本/<p> 可编辑块）：浏览器原生输入路径（真实键入，等价 CDP Input.insertText）——
        // execCommand('insertText') 触发真实 beforeinput/input(inputType=insertText)，React onChange 正确接收，值不被重置
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
          // 兜底：contenteditable 无 <label> 时按 aria-label/data-placeholder 匹配（self_ui 已列出）
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
  function execOnPage(cmd, args, pageId, signal, mcpReqId, cancelId) {
    const { instanceId, frameId } = parsePageId(pageId || LEGACY_TOKEN);
    const page = pages.get(instanceId);
    return new Promise((resolve2) => {
      const requestId = "mcp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const rec = { resolve: resolve2, agentId: null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
      pendingRequests.set(requestId, rec);
      if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
      if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
      rec.onAbort = () => cancelPending(requestId, "已取消（agent 停止）");
      if (signal) {
        if (signal.aborted) {
          cancelPending(requestId, "已取消（agent 停止）");
          return;
        }
        rec.signal = signal;
        signal.addEventListener("abort", rec.onAbort, { once: true });
      }
      console.log(TAG + " exec →", cmd, JSON.stringify(args || {}), "→ pageId=" + pageId);
      if (page) {
        if (!page.writer.write({ type: "exec", requestId, cmd, args: args || {}, frameId })) {
          const irec = idRegistry.get(instanceId);
          if (irec) irec.lastSeen = Date.now();
          pages.delete(instanceId);
          settlePending(requestId, false, { error: "页面连接已断开（重连后重试）" });
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
          if (!target.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "self" })) {
            aiConns.delete(target);
            aiSelfReg.delete(target);
            settlePending(requestId, false, { error: "目标 AI 主窗口连接已断开（刷新后自动重连）" });
            return;
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "self" });
        } else {
          setTimeout(() => settlePending(requestId, false, { error: "无执行端（AI 主窗口未连接），先连接桥" }), 100);
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
          if (!target.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai", frameId: viaFrameId })) {
            aiConns.delete(target);
            aiPageReg.delete(target);
            settlePending(requestId, false, { error: "目标 AI 窗连接已断开（页面刷新后自动重连，稍后重试）" });
            return;
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai" });
        } else {
          setTimeout(() => settlePending(requestId, false, { error: "无执行端（页面/AI 通道均未连接），先连接桥" }), 100);
          return;
        }
      } else if (aiConns.size > 0) {
        for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai" });
      } else {
        setTimeout(() => settlePending(requestId, false, { error: "无执行端（页面/AI 通道均未连接），先连接桥" }), 100);
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
      setTimeout(() => settlePending(requestId, false, { error: "页面执行超时" + (SLOW_EXEC_CMDS.has(cmd) ? "（用户未完成确认/选择）" : "") }), slowNet);
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
    console.log(TAG + " interaction ⏸ 暂停 requestId=" + requestId + " remaining=" + st.remaining + "ms");
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
      const result = { status: "timeout", error: "用户无响应（不在线或未处理）", tookMs: Date.now() - st.t0, timeoutMs: st.ms, pausedMs: st.pausedMs };
      if (settlePending(requestId, false, result)) {
        for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result });
      }
    };
    if (st.remaining <= 0) {
      fire();
      return { ok: true, paused: false, remainingMs: 0, timedOut: true };
    }
    st.timer = setTimeout(fire, st.remaining);
    console.log(TAG + " interaction ▶ 继续 requestId=" + requestId + " remaining=" + st.remaining + "ms");
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
    if (frameId === "ai") {
      for (const [w, rec] of aiSelfReg) if (rec.instanceId === instanceId) {
        aiTarget = w;
        break;
      }
    }
    const ms = clampTimeout(timeoutMs);
    const t0 = Date.now();
    const payload = { ...interaction, timeoutMs: ms };
    const isAsync = !!payload.async;
    return new Promise((resolve2) => {
      const requestId = "ui_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      if (isAsync) {
        console.log(TAG + " interaction（异步）→ kind=" + payload.kind + " · " + String(payload.prompt || "").slice(0, 60) + " → pageId=" + pageId + (payload.agentId ? " · agent=" + payload.agentId : ""));
        resolve2({ ok: true, result: { status: "async", message: "已异步发出：用户作答后结果将进发起 agent（" + (payload.agentId || "?") + "）的 aiti_inbox" } });
      } else {
        const rec = { resolve: resolve2, agentId: payload.agentId || null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
        pendingRequests.set(requestId, rec);
        if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
        if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
        rec.onAbort = () => cancelPending(requestId, "已取消（agent 停止）");
        if (signal) {
          if (signal.aborted) {
            cancelPending(requestId, "已取消（agent 停止）");
            return;
          }
          rec.signal = signal;
          signal.addEventListener("abort", rec.onAbort, { once: true });
        }
        console.log(TAG + " interaction → kind=" + payload.kind + " · " + String(payload.prompt || "").slice(0, 60) + " → pageId=" + pageId + " · timeout=" + (ms > 0 ? ms + "ms" : "∞（永久等待）") + (payload.agentId ? " · agent=" + payload.agentId : ""));
      }
      const noExecutor = () => {
        clearInteractionTimer(requestId);
        cancelPending(requestId, "无执行端（页面/AI 通道均未连接），先连接桥");
      };
      if (aiTarget) {
        if (!aiTarget.write({ type: "interaction", requestId, interaction: payload, frameId: "ai", via: "self" })) {
          aiConns.delete(aiTarget);
          aiSelfReg.delete(aiTarget);
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
        const st = { timer: null, deadline: Date.now() + ms, remaining: ms, paused: false, pausedAt: null, pausedMs: 0, ms, t0, resolve: resolve2 };
        interactionTimers.set(requestId, st);
        st.timer = setTimeout(() => {
          if (!interactionTimers.delete(requestId)) return;
          const result = { status: "timeout", error: "用户无响应（不在线或未处理）", tookMs: Date.now() - t0, timeoutMs: ms, pausedMs: st.pausedMs };
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
            "aiti-devtools：页面内 AI 调试助手（浏览器桥）。",
            "工作流：页面发来的消息通常带 pageId。没有也可以先用 bridge_status 发现已连接页面（返回 sessions，含 pageId/url/title/frameworks/device——deviceLabel 一行的浏览器·屏幕·在线·语言可快速识别是哪台机器哪个标签）→ 把 pageId 传给目标工具。",
            "pageId 格式为 instanceId/frameId（如 3001/host）；也可直接传 url 或页面标题；命中多个时需具体 pageId 指定。",
            "page_exec：在已连接页面执行类 CDP 命令（DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser 域）。args 为命令参数对象。危险命令（导航/下载/对话框等）会自动弹用户确认。截屏（Page.captureScreenshot）务必在 args 带 reason（一句话向用户说明想截什么，页面会先弹准备卡展示该说明、用户调整好页面才开始截屏）。",
            "page_snapshot：拉取目标页面基础现场（URL/选区/模拟条件）。",
            "page_logs / page_network：排查页面报错/请求失败首选——page_logs 查 console（可 level/since/limit 过滤，先看 warn/error）；page_network 查 ajax/fetch 完成态（status≥400 或 errorOnly:true 只看失败）。两者均读页面本地缓冲（CDP Runtime.evaluate 按需拉取，不再实时上报）。",
            "user_confirm / user_choose / user_input / user_pick_element / user_presence：AI 与人类用户在页面上协作——prompt 给用户看，默认同步等待且永久等待（不传 timeout：面板常驻直到用户作答，无读秒；仅在确需限时催促时传 timeout ms，面板显示读秒倒计时可暂停，到点返回 status:'timeout'），响应信封 {status:'answered'|'rejected'|'timeout'|'error', value?, reason?, tookMs, timeoutMs}。传 async:true 可立即返回（结果经 AI 消息窗送达）。",
            "user_notify：非阻塞浏览器通知，不等待回答。",
            "常见用法：页面报错→page_logs(level:warn/error) 或 page_network(errorOnly:true)；操作页面→page_exec(cmd:'Runtime.evaluate', args:{expression:'...'})；定位元素→page_snapshot 后再 page_exec 或请用户 user_pick_element。"
          ].join("\n")
        };
      case "notifications/initialized":
        return null;
      case "notifications/cancelled": {
        const rid = params && params.requestId !== void 0 ? String(params.requestId) : "";
        if (rid) {
          const internalId = mcpReqMap.get(rid);
          if (internalId) cancelPending(internalId, "已取消（MCP notifications/cancelled）");
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
        const recToolCall = (text, ok, detail) => {
          if (!recAgentKey) return;
          const m = { id: randomBytes(4).toString("hex"), kind: "agent_tool", from: "agent", agentKey: recAgentKey, agentId: recAgentKey.split("/")[0], sessionId: recAgentKey.split("/").slice(1).join("/") || null, source: (agents.get(recAgentKey) || {}).source || "unknown", text: String(text).slice(0, 2e3), detail: detail === void 0 ? null : typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 4e3), at: (/* @__PURE__ */ new Date()).toISOString(), status: ok ? "ok" : "error" };
          appendMsgEvent(recAgentKey, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
          for (const w of aiConns) w.write({ type: "agent_answer", agentKey: recAgentKey, agentId: recAgentKey.split("/")[0], ok, text: m.text, at: m.at, detail: m.detail });
        };
        if (params.name === "bridge_status") {
          const curAgentKey = session && session.agentKey || (session && session.agentId ? session.agentId + (session.id ? "/" + session.id : "") : null) || null;
          const boundPageId = curAgentKey && agents.get(curAgentKey) && agents.get(curAgentKey).boundPageId || null;
          const sess = listSessions(boundPageId);
          const resp = { sessions: sess, activePageId: boundPageId || null };
          recToolCall("🛠 bridge_status → " + sess.length + " 个已连接页面" + (boundPageId ? " · 当前绑定: " + boundPageId : ""), true, resp);
          return { content: [{ type: "text", text: JSON.stringify(resp) }], isError: false };
        }
        if (params.name === "file_stat") {
          const fp = String(a.path || "").trim();
          const out = { path: fp || null, exists: false, isFile: false, isDirectory: false, size: null, mtime: null };
          if (fp) {
            try {
              const st = statSync(fp);
              out.exists = true;
              out.isFile = st.isFile();
              out.isDirectory = st.isDirectory();
              out.size = st.isFile() ? st.size : null;
              out.mtime = st.mtimeMs;
            } catch {
            }
          }
          recToolCall("🛠 file_stat(" + (fp || "") + ") → " + (out.exists ? out.isFile ? "文件 " + out.size + "B" : "目录" : "不存在"), out.exists);
          return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
        }
        if (params.name === "page_logs" || params.name === "page_network") {
          const isLog = params.name === "page_logs";
          const ringExpr = isLog ? "(() => { try { var r = window.__dbg && window.__dbg.__consoleRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 200) + "); } catch(e) { return []; } })()" : "(() => { try { var r = window.__dbg && window.__dbg.__netRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 100) + "); } catch(e) { return []; } })()";
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) {
            recToolCall("🛠 " + params.name + " → ⚠ 页面匹配多个", false);
            return { content: [{ type: "text", text: "页面匹配多个（按 url/title）：" + resolved.multiple.join(", ") + "——请用具体 pageId 指定" }], isError: true };
          }
          if (resolved.notFound) {
            recToolCall("🛠 " + params.name + " → ⚠ 未找到匹配页面", false);
            return { content: [{ type: "text", text: "未找到匹配页面（pageId/url/title 均未命中）——用 bridge_status 查看可用 pageId" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          return execOnPage("Runtime.evaluate", { expression: ringExpr }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const raw = r.ok && r.result && r.result.value !== void 0 ? r.result.value : [];
            let rows = Array.isArray(raw) ? raw : [];
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
            const out = isLog ? { logs: rows, bufferSize: Array.isArray(raw) ? raw.length : 0 } : { requests: rows, bufferSize: Array.isArray(raw) ? raw.length : 0 };
            recToolCall("🛠 " + params.name + "(" + resolved.pageId + ") → " + rows.length + " 条", true, out);
            return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
          });
        }
        if (params.name === "page_exec" || params.name === "page_snapshot") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) {
            recToolCall("🛠 " + params.name + " → ⚠ 页面匹配多个：" + resolved.multiple.join(", "), false);
            return { content: [{ type: "text", text: "页面匹配多个（按 url/title）：" + resolved.multiple.join(", ") + "——请用具体 pageId 指定（bridge_status 可查）" }], isError: true };
          }
          if (resolved.notFound) {
            recToolCall("🛠 " + params.name + (pageId ? "(" + pageId + ")" : "") + " → ⚠ 未找到匹配页面", false);
            return { content: [{ type: "text", text: "未找到匹配页面（pageId/url/title 均未命中）——用 bridge_status 查看可用 pageId" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const runPageTool = params.name === "page_exec" ? execOnPage(cmd, cmdArgs, resolved.pageId, signal, mcpReqId, cancelId) : execOnPage("__snapshot__", {}, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const txt = JSON.stringify(r.result || r);
            if (r.ok || txt.indexOf("unknown command: __snapshot__") === -1) return r;
            return execOnPage("Runtime.evaluate", { expression: SNAPSHOT_FALLBACK, returnByValue: true }, resolved.pageId, signal, mcpReqId, cancelId).then((r2) => {
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
            recToolCall("🛠 " + params.name + "(" + resolved.pageId + ")" + (params.name === "page_exec" && cmd ? " · " + String(cmd).slice(0, 80) : "") + " → " + (r.ok ? "ok" : "失败"), !!r.ok, { tool: params.name, request: params.name === "page_exec" ? { cmd, args: cmdArgs } : { pageId: resolved.pageId }, response: r.result || r, at: (/* @__PURE__ */ new Date()).toISOString() });
            return { content: [{ type: "text", text: JSON.stringify(r.result || r) }], isError: !r.ok };
          });
        }
        if (params.name === "self_ui") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) {
            recToolCall("🛠 self_ui → 未找到目标页面（无 AI 主窗口连接或 pageId 未命中）", false);
            return { content: [{ type: "text", text: "未找到目标页面——需 AI 主窗口已连接（bridge_status 可见 xxx/ai），或指定 pageId" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          return execOnPage("Runtime.evaluate", { expression: SELF_UI_SCAN }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const val = r.ok && r.result && r.result.value !== void 0 ? r.result.value : r.result || r;
            recToolCall("🛠 self_ui(" + resolved.pageId + ") → " + (r.ok ? val && val.dialogs ? val.dialogs.length + " 个弹窗" : "无弹窗" : "失败"), !!r.ok, { tool: "self_ui", pageId: resolved.pageId, response: val });
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        if (params.name === "form_fill") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) {
            recToolCall("🛠 form_fill → 未找到目标页面", false);
            return { content: [{ type: "text", text: "未找到目标页面——需 AI 主窗口已连接，或指定 pageId" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const opts2 = { dialog: a.dialog || null, fields: a.fields || [], button: a.button || null };
          const expression = "(" + FORM_FILL_FN + ")(" + JSON.stringify(opts2) + ")";
          return execOnPage("Runtime.evaluate", { expression }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const val = r.ok && r.result && r.result.value !== void 0 ? r.result.value : r.result || r;
            recToolCall("🛠 form_fill(" + resolved.pageId + ") → " + (r.ok ? val && val.foundDialog ? "填 " + val.filled + " 字段" + (val.clicked ? "，点按钮" : "") : "未找到弹窗" : "失败"), !!r.ok, { tool: "form_fill", pageId: resolved.pageId, response: val });
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        const interact = (interaction, timeout) => {
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const targetPageId = pageId || boundPageIdFor(session) || void 0;
          return interactOnPage({ ...interaction, agentId: session && session.agentKey || session && session.agentId || a.agentId || null }, targetPageId, timeout, signal, mcpReqId, cancelId).then((r) => {
            recToolCall("🛠 " + interaction.kind + " → " + (r.ok ? "已作答" : r.result && r.result.status || "失败/拒绝"), !!r.ok);
            return { content: [{ type: "text", text: JSON.stringify(r.result || r) }], isError: !r.ok };
          });
        };
        if (params.name === "user_pick_element") {
          return interact({ kind: "pick_element", prompt: String(a.prompt || "请点击页面上的一个元素（AI 需要你帮忙定位）"), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_confirm") {
          return interact({ kind: "confirm", prompt: String(a.prompt || "请确认"), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_choose") {
          const choices = Array.isArray(a.choices) && a.choices.length ? a.choices.map(String).slice(0, 8) : ["选项 A", "选项 B"];
          return interact({ kind: "choose", prompt: String(a.prompt || "请选择一项"), choices, multiple: !!a.multiple, rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_input") {
          return interact({ kind: "input", prompt: String(a.prompt || "请输入"), defaultValue: String(a.defaultValue || ""), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_presence") {
          return interact({ kind: "presence", prompt: String(a.prompt || "你在吗？需要你配合继续开发"), rejectable: false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_notify") {
          const notif = { kind: "notify", title: String(a.title || "🤖 AI 有一条消息"), body: String(a.body || a.prompt || ""), timeoutMs: clampTimeout(a.timeout) };
          const rid = "notify_" + Date.now();
          for (const w of aiConns) w.write({ type: "interaction", requestId: rid, interaction: notif, pageId });
          const pg = pages.get(parsePageId(pageId || LEGACY_TOKEN).instanceId);
          if (pg) pg.writer.write({ type: "interaction", requestId: rid, interaction: notif, frameId: parsePageId(pageId || LEGACY_TOKEN).frameId, render: "notify-only" });
          recToolCall("🔔 user_notify → " + String(notif.body).slice(0, 60), true);
          return { content: [{ type: "text", text: JSON.stringify({ status: "sent", notified: true, title: notif.title }) }], isError: false };
        }
        if (params.name === "aiti_hello") {
          const agentId2 = String(a.agentId || session && session.agentId || "pi");
          const sessionId = a.sessionId || session && session.id || null;
          const { a: agent, key } = ensureAgent(agentId2, sessionId, session);
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "agent 注册失败" }) }], isError: true };
          agent.registered = true;
          agent.name = a.name || agent.name;
          if (typeof a.cwd === "string" && a.cwd) agent.cwd = a.cwd;
          if (session) {
            session.agentId = agentId2;
            session.agentKey = key;
          }
          if (a.pageId) {
            const resolved2 = resolvePageId(a.pageId);
            agent.boundPageId = resolved2.pageId || a.pageId;
          }
          if (Array.isArray(a.subEvents)) agent.subEvents = new Set(a.subEvents.map(String));
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, agentKey: key, agentId: agentId2, sessionId: agent.sessionId, boundPageId: agent.boundPageId || null, subEvents: [...agent.subEvents], inboxPending: agent.outbox.filter((m) => m.status !== "consumed").length }) }], isError: false };
        }
        if (params.name === "aiti_inbox") {
          const agentId2 = String(a.agentId || session && session.agentId || "pi");
          const sessionId = a.sessionId || session && session.id || (session && session.agentKey ? session.agentKey.split("/").slice(1).join("/") : null) || null;
          const { a: agent, key } = ensureAgent(agentId2, sessionId, session);
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown agent：先 aiti_hello 或带 agentId/sessionId" }) }], isError: true };
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
                appendMsgEvent(key, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: id, status: "consumed", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
              }
            }
            if (ackedAny) {
              const text = summary || `✅ 已处理 ${ackIds.length} 条消息（未附总结——建议 ack 时带 summary）`;
              const rid = randomBytes(4).toString("hex");
              const rec = { id: rid, kind: "agent_summary", from: "agent", agentKey: key, agentId: agentId2, sessionId: agent.sessionId, text, ackedIds: ackIds, at: (/* @__PURE__ */ new Date()).toISOString(), status: "ok" };
              agent.outbox.push(rec);
              appendMsgEvent(key, { type: "message", id: rid, parentId: null, timestamp: rec.at, message: rec });
              for (const w of aiConns) w.write({ type: "agent_answer", agentKey: key, agentId: agentId2, ok: true, text, at: Date.now(), summary: true });
            }
          }
          const out = [];
          for (const m of agent.outbox) {
            if (m.status === "consumed") continue;
            if (m.status === "pending") {
              m.status = "delivered";
              appendMsgEvent(key, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: m.id, status: "delivered", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
            }
            out.push({ id: m.id, kind: m.kind, from: m.from, agentKey: key, agentId: agentId2, sessionId: agent.sessionId, pageId: m.pageId || m.payload && m.payload.pageId || null, url: m.url || m.payload && m.payload.url || null, text: m.text ?? null, payload: m.payload || null, at: m.at, status: m.status });
          }
          for (const w of aiConns) w.write({ type: "event", from: "agent", event: "inbox_status", payload: { agentKey: key, queueSize: agent.outbox.filter((x) => x.status !== "consumed").length } });
          const guide = agent.registered ? "" : " ⚠ 未显式注册（随机 session）——建议调 aiti_hello 传 agentId/sessionId 注册，消息将绑定到该会话";
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
        const xs = readdirSync("/tmp/.X11-unix").filter((f) => /^X\d+$/.test(f)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        if (xs.length && !out.DISPLAY) out.DISPLAY = ":" + xs[0].slice(1);
      } catch {
      }
      const authCands = [];
      if (uid != null) authCands.push(`/run/user/${uid}/gdm/Xauthority`);
      authCands.push(`${home}/.Xauthority`);
      for (const a of authCands) {
        try {
          if (a && existsSync(a)) {
            out.XAUTHORITY = a;
            break;
          }
        } catch {
        }
      }
      if (uid != null) {
        try {
          const ws = readdirSync(`/run/user/${uid}`).filter((f) => /^wayland-\d+$/.test(f)).sort();
          if (ws.length) out.WAYLAND_DISPLAY = ws[0];
        } catch {
        }
        try {
          if (existsSync(`/run/user/${uid}/bus`)) {
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
    return new Promise((resolve2) => {
      if (!file) return resolve2({ ok: false, error: "缺少 file" });
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
          return resolve2({ ok: false, error: "无桌面会话（systemd/无头服务）——后端打开不可用：请用「前端打开」（pi-web 文件标签页在线查看）或设置 AITI_OPEN_CMD 指定打开命令（如 ssh 回本地编辑器）" });
        }
        child = defaultOpen(file);
      }
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve2(r);
        }
      };
      child.on("error", () => {
        if (!hasDesktopSession()) {
          return finish({ ok: false, error: "编辑器与系统默认打开器均不可用（无桌面会话）——请配置 AITI_OPEN_CMD 或使用前端打开" });
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
  async function handle(req, path, searchParams) {
    if (path[0] === "aiti") path = path.slice(1);
    const endpoint = path[0];
    const sub = path.slice(1)[0] || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (endpoint === "bridge" && sub === "claim" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const r = claimInstanceId(msg && msg.instanceId, msg && msg.secret, msg && msg.pageKey, msg && msg.hostUrl);
      const reused = !!(msg && msg.instanceId && r.instanceId === msg.instanceId && msg.secret);
      const portPref = portFromHostUrl(msg && msg.hostUrl);
      console.log(TAG + " claim → instanceId=" + r.instanceId + (reused ? "（复用）" : "（新" + (portPref ? " 端口偏好=" + portPref : "") + "）"));
      return json({ ok: true, instanceId: r.instanceId, secret: r.secret });
    }
    if (endpoint === "bridge" && sub === "sessions" && req.method === "GET") return json(listSessions());
    if (endpoint === "bridge" && sub === "ai" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.pageId) return json({ ok: false, error: "缺少 instanceId/pageId" }, 400);
      let hit = null;
      for (const [w, rec] of aiPageReg) if (rec.instanceId === String(msg.instanceId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai conn：" + msg.instanceId }, 404);
      const baseId = String(msg.pageId).replace(/\/host$/, "");
      for (const [w, rec] of aiPageReg) {
        if (w !== hit && rec.pageId && String(rec.pageId).replace(/\/host$/, "") === baseId) aiPageReg.delete(w);
      }
      const prev = aiPageReg.get(hit) || {};
      const fr = Array.isArray(msg.frames) ? msg.frames : prev.frames || null;
      aiPageReg.set(hit, { instanceId: String(msg.instanceId), pageId: String(msg.pageId), title: msg.title || prev.title || null, url: msg.url || prev.url || null, frames: fr, device: msg.device && typeof msg.device === "object" ? msg.device : prev.device || null, deviceLabel: msg.deviceLabel || prev.deviceLabel || null, lastSeen: Date.now() });
      console.log(TAG + " AI 宿主页注册：" + msg.pageId + " · " + (msg.title || "") + (fr && fr.length ? " · frames=" + fr.length : "") + (msg.device ? " · " + (msg.deviceLabel || msg.device.browser) : ""));
      return json({ ok: true, pageId: msg.pageId });
    }
    if (endpoint === "bridge" && sub === "self" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId) return json({ ok: false, error: "缺少 instanceId" }, 400);
      let hit = null;
      for (const [w, rec] of aiSelfReg) if (rec.instanceId === String(msg.instanceId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai conn：" + msg.instanceId }, 404);
      const prev = aiSelfReg.get(hit) || {};
      aiSelfReg.set(hit, { instanceId: String(msg.instanceId), url: msg.url || prev.url || null, title: msg.title || prev.title || null, device: msg.device && typeof msg.device === "object" ? msg.device : prev.device || null, deviceLabel: msg.deviceLabel || prev.deviceLabel || null, lastSeen: Date.now() });
      bindAgentFromAiSelf(aiSelfReg.get(hit));
      console.log(TAG + " AI 主窗口 self 注册：" + msg.instanceId + "/ai · " + (msg.title || "") + (msg.device ? " · " + (msg.deviceLabel || msg.device.browser) : ""));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }
    if (endpoint === "bridge" && sub === "self" && path[2] === "active" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.sessionId) return json({ ok: false, error: "缺少 instanceId/sessionId" }, 400);
      bindAgentFromActive(String(msg.instanceId), String(msg.sessionId));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }
    if (endpoint === "bridge" && sub === "ai" && path[2] === "frames" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.pageId || !Array.isArray(msg.frames)) return json({ ok: false, error: "bad request（需要 pageId/frames）" }, 400);
      let hit = null;
      for (const [w, rec2] of aiPageReg) if (rec2.pageId === String(msg.pageId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai host page：" + msg.pageId }, 404);
      const rec = aiPageReg.get(hit);
      rec.frames = msg.frames;
      rec.lastSeen = Date.now();
      console.log(TAG + " AI 宿主帧树更新：" + msg.pageId + " frames=" + msg.frames.length);
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
      console.log(TAG + " register frames →", msg.instanceId, [...page.frames].join(","));
      return json({ ok: true, frames: [...page.frames] });
    }
    if (endpoint === "bridge" && sub === "agent" && path[2] === "tools" && path[3] === "call" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.tool) return json({ ok: false, error: "bad request（需要 tool）" }, 400);
      const agentId2 = msg.agentId ? String(msg.agentId) : "pi";
      const sessionId = msg.sessionId ? String(msg.sessionId) : null;
      const { a: ag, key } = ensureAgent(agentId2, sessionId, null);
      if (sessionId) ag.registered = true;
      ag.source = msg.source === "mcp" ? "mcp" : "extension";
      if (msg.cwd) ag.cwd = String(msg.cwd);
      const session = { agentId: agentId2, agentKey: key, id: sessionId || key.split("/").slice(1).join("/"), source: ag.source };
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
      if (!msg || !msg.agentId) return json({ ok: false, error: "bad request（需要 agentId）" }, 400);
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
      console.log(TAG + " agent SSE 已建立：" + resolvedKey + "（P3 推送通道）");
      return response;
    }
    if (endpoint === "bridge" && sub === "agent" && path[2] === "answer" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.agentKey || !msg.text) return json({ ok: false, error: "bad request（需要 agentKey/text）" }, 400);
      const parts = String(msg.agentKey).split("/");
      const { a, key: resolvedKey } = ensureAgent(parts[0], parts.slice(1).join("/") || null, null);
      for (const om of a.outbox) {
        if (om.status !== "consumed" && (om.kind === "user_message" || om.kind === "user_answer" || om.kind === "chat")) {
          om.status = "consumed";
          om.ackedAt = Date.now();
          appendMsgEvent(resolvedKey, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: om.id, status: "consumed", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
          for (const w of aiConns) w.write({ type: "msg_status", agentKey: resolvedKey, msgId: om.id, status: "consumed" });
        }
      }
      const m = { id: randomBytes(4).toString("hex"), kind: msg.kind || "agent_answer", from: "agent", agentId: parts[0], pageId: null, text: String(msg.text).slice(0, 4e3), payload: msg.payload || null, at: (/* @__PURE__ */ new Date()).toISOString(), status: "consumed" };
      appendMsgEvent(resolvedKey, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
      for (const w of aiConns) w.write({ type: "agent_answer", agentKey: resolvedKey, agentId: parts[0], text: m.text, at: m.at });
      console.log(TAG + " agent 回答 → " + resolvedKey + " · " + String(m.text).slice(0, 80) + "（已消费待处理消息 " + a.outbox.filter((x) => x.status === "consumed").length + " 条）");
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
        aiPageReg.set(writer, { instanceId, pageId: null, title: null, url: null, frames: null, lastSeen: Date.now() });
        aiSelfReg.set(writer, { instanceId, url: searchParams.get("url") || null, title: searchParams.get("title") || null, lastSeen: Date.now() });
        bindAgentFromAiSelf(aiSelfReg.get(writer));
        console.log(TAG + " AI 控制台已连接：instanceId=" + instanceId);
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
        console.log(TAG + " 页面已连接：instanceId=" + instanceId + " frame=" + initialFrame);
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
        aiConns.add(writer);
        aiPageReg.set(writer, { instanceId, pageId: null, title: msg && msg.title || null, url: msg && msg.url || null, frames: null, lastSeen: Date.now() });
        aiSelfReg.set(writer, { instanceId, url: msg && msg.url || null, title: msg && msg.title || null, lastSeen: Date.now() });
        bindAgentFromAiSelf(aiSelfReg.get(writer));
        console.log(TAG + " AI 控制台已连接（总线）：instanceId=" + instanceId);
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
        console.log(TAG + " 页面已连接（总线）：instanceId=" + instanceId);
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
          const dir = join(dataDir, "aiti-bridge", "shots");
          mkdirSync(dir, { recursive: true });
          const file = join(dir, (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + "-" + String(msg.requestId).replace(/[^\w-]/g, "").slice(0, 12) + "." + ext);
          writeFileSync(file, Buffer.from(r0.dataUrl.slice(r0.dataUrl.indexOf(",") + 1), "base64"));
          msg.result = { file, width: r0.width, height: r0.height, format: r0.format, bytes: r0.bytes || 0, note: "截屏已存文件（dataUrl 过大不内联）；前端文件标签页可直接打开查看" };
          console.log(TAG + " 截屏落盘：" + file + "（" + Math.round((r0.bytes || 0) / 1024) + "KB）");
        }
      } catch (e) {
        console.warn(TAG + " 截屏落盘失败（退回内联）:", e.message);
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
        console.log(TAG + " ← 结果回传 ok=" + msg.ok + (r.agentId ? " → agent=" + r.agentId : ""));
        if (r.agentId && msg.ok) deliverUserAnswer(r.agentId, msg.result);
      } else {
        console.log(TAG + " ⚠ 结果回传但无 pending：" + msg.requestId);
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
      return json({ ok: cancelPending(internalId, "已取消（客户端请求）"), cancelled: true });
    }
    if (endpoint === "bridge" && sub === "push" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.text) return json({ ok: false, error: "bad request（需要 text）" }, 400);
      return json(pushToAgents(msg.to, String(msg.text), msg.kind || "user_message", msg.payload || {}, msg.ref || null));
    }
    if (endpoint === "bridge" && sub === "picked" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const list = msg && Array.isArray(msg.candidates) ? msg.candidates : null;
      if (!list) return json({ ok: false, error: "bad request（需要 candidates 数组）" }, 400);
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
      if (!msg || !msg.event) return json({ ok: false, error: "bad request（需要 event）" }, 400);
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
        console.log(TAG + " page_error 事件 → 订阅分发（type=" + msg.type + " payload=" + JSON.stringify(msg.payload || {}).slice(0, 120) + "）");
      }
      if (msg.type === "page_log" || msg.type === "page_network") {
        return json({ ok: false, error: "page_log/page_network 不再实时上报；请用 page_logs/page_network 工具按需拉取" }, 410);
      }
      if (msg.type === "open_file") {
        const payload = msg.payload || {};
        console.log(TAG + " open_file →", payload.file + (payload.line ? ":" + payload.line : ""));
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
        console.log(TAG + " streamable GET 流已建立 session=" + sid2.slice(0, 8) + " agent=" + (session2.agentId || "?"));
        writer.write({ jsonrpc: "2.0", method: "notifications/initialized" });
        return response;
      }
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      if (msg.id !== void 0 && !msg.method && pendingSampling.has(String(msg.id))) {
        const p = pendingSampling.get(String(msg.id));
        const ok = !(msg.error || msg.result && msg.result.isError);
        p.done(ok, msg.error ? { error: String(msg.error.message || msg.error.code || "sampling 拒绝") } : msg.result || {});
        console.log(TAG + " sampling 响应回传 id=" + String(msg.id).slice(0, 12) + " agent=" + p.agentId + " ok=" + ok);
        return new Response(null, { status: 202 });
      }
      const sid = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id") || "";
      let session = sid ? mcpSessions.get(sid) || null : null;
      const isInit = msg.method === "initialize";
      if (isInit) {
        if (!session) {
          const newId = randomBytes(16).toString("hex");
          session = { id: newId, writer: null, agentId: null, clientInfo: null, capabilities: null, lastSeen: Date.now(), open: false, source: "mcp" };
          mcpSessions.set(newId, session);
        }
        const p = msg.params || {};
        session.clientInfo = p.clientInfo || null;
        session.capabilities = p.capabilities || null;
        session.agentId = p.clientInfo && p.clientInfo.name || session.agentId || null;
        session.clientInfo = p.clientInfo || session.clientInfo;
        session.lastSeen = Date.now();
        console.log(TAG + " initialize → session=" + session.id.slice(0, 8) + " client=" + (p.clientInfo ? p.clientInfo.name + " " + (p.clientInfo.version || "") : "?") + " transport=" + (sid ? "streamable" : "session-new") + " caps=" + JSON.stringify(p.capabilities || {}).slice(0, 120));
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
        console.log(TAG + " agent 注册时反向绑定 AI 主窗口：" + agentKey2 + " → " + agent.boundPageId);
        break;
      }
    }
  };
  const registerAgent2 = (key, opts2 = {}) => {
    const k = String(key || "");
    if (!k) return { ok: false, error: "bad key" };
    if (!agents.has(k)) {
      agents.set(k, { agentId: k, sessionId: opts2.id || k, registered: true, name: opts2.name || k, cwd: opts2.cwd || null, offlineAt: null, conn: 0, transportKind: "inprocess", source: opts2.source || "extension", capabilities: opts2.capabilities || {}, stream: null, boundPageId: opts2.pageId || null, activeBoundPageId: null, subEvents: new Set(opts2.subEvents || []), outbox: [], lastSeen: Date.now(), agentStream: null, inProcessSink: null });
    }
    const a = agents.get(k);
    a.lastSeen = Date.now();
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
          appendMsgEvent(k, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: om.id, status: "consumed", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
          for (const w of aiConns) w.write({ type: "msg_status", agentKey: k, msgId: om.id, status: "consumed" });
        }
      }
    }
    const m = { id: randomBytes(4).toString("hex"), kind: "agent_summary", from: "agent", agentKey: k, agentId: k, sessionId: k.split("/").slice(1).join("/") || null, text: t.slice(0, 4e3), payload: null, at, status: "consumed" };
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
  return { handle, sessions: () => listSessions(), tools: () => TOOLS, callTool, registerAgent: registerAgent2, bindAgentPage, setAgentSink, answer, clearAgent, pushAiEvent, close };
}

// ../aiti-devtools-core/src/mcp-config.ts
import { homedir } from "node:os";
import { join as join2, dirname as dirname2 } from "node:path";
import { existsSync as existsSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync as renameSync2, mkdirSync as mkdirSync2, rmSync as rmSync2 } from "node:fs";
var homeDir = () => homedir();
var MCP_TARGETS = {
  // pi 实际读取 getAgentDir()/mcp.json（getAgentDir = $PI_CODING_AGENT_DIR，默认 ~/.pi/agent）；
  // ~/.config/mcp/mcp.json 是历史误记——默认 pi 不读它（探针实证 2026-09-10，见执行记录 P17）
  pi: [{ path: () => join2(process.env.PI_CODING_AGENT_DIR || join2(homeDir(), ".pi", "agent"), "mcp.json"), key: "mcpServers" }],
  zcode: [{ path: () => join2(homeDir(), ".zcode", "cli", "config.json"), key: "mcpServers", keyPath: ["mcp", "servers"] }],
  opencode: [{
    path: () => join2(homeDir(), ".config", "opencode", "opencode.json"),
    key: "mcpServers",
    keyPath: ["mcp"],
    shimEntry: (shimPath) => ({ type: "local", command: ["node", shimPath], enabled: true }),
    envKey: "environment",
    // opencode 的 env map 字段名异构；条目零顶层私有键（schema 严格拒未知键）
    httpEntry: (url) => ({ type: "remote", url, enabled: true })
    // D23：http 类型对 opencode 非法
  }],
  claude: [
    { path: () => join2(homeDir(), ".claude.json"), key: "mcpServers" },
    { path: (p) => join2(p, ".mcp.json"), key: "mcpServers", project: true }
  ],
  // CodeBuddy Code（腾讯 cbc）：用户级 ~/.codebuddy/.mcp.json（官方 mcp.md：.mcp.json 推荐 /
  // mcp.json 已废弃；条目形状 mcpServers+stdio 与 claude 同构，2026-09-11 cbc mcp add 实测钉死）。
  // 项目级 .mcp.json 与 claude 同文件（claude 目标已覆盖），不重复注册。
  codebuddy: [{ path: () => join2(homeDir(), ".codebuddy", ".mcp.json"), key: "mcpServers" }],
  cursor: [{ path: () => join2(homeDir(), ".cursor", "mcp.json"), key: "mcpServers" }],
  windsurf: [{ path: () => join2(homeDir(), ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" }],
  vscode: [{ path: (p) => join2(p, ".vscode", "mcp.json"), key: "servers", project: true }],
  zed: [
    { path: () => join2(homeDir(), ".config", "zed", "settings.json"), key: "mcp" },
    { path: (p) => join2(p, ".zed", "settings.json"), key: "mcp", project: true }
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
      return { cfg: null, error: "JSON 解析失败：" + String(e?.message || e) };
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
function writeAtomic(path, cfg) {
  const tmp = path + ".tmp";
  const bak = path + ".bak";
  mkdirSync2(dirname2(path), { recursive: true });
  writeFileSync2(tmp, JSON.stringify(cfg, null, 2) + "\n");
  if (existsSync2(path)) {
    try {
      renameSync2(path, bak);
    } catch {
    }
  }
  try {
    renameSync2(tmp, path);
  } catch (e) {
    if (existsSync2(bak) && !existsSync2(path)) {
      try {
        renameSync2(bak, path);
      } catch {
      }
    }
    try {
      rmSync2(tmp, { force: true });
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
        if (auto && !existsSync2(p)) continue;
        out.push({ target: t, path: p, key: f.key, exists: existsSync2(p), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry });
      }
    }
  }
  for (const p of opts.configPaths || []) {
    const abs = p.replace(/^~(?=\/|$)/, homeDir());
    let matched = null;
    for (const [t, files] of Object.entries(MCP_TARGETS)) {
      for (const f of files) {
        if (f.path(projectDir) === abs) {
          matched = { target: t, path: abs, key: f.key, exists: existsSync2(abs), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry };
          break;
        }
      }
      if (matched) break;
    }
    out.push(matched ?? { target: abs, path: abs, key: "mcpServers", exists: existsSync2(abs) });
  }
  return out;
}
function assertKnownTargets(targets) {
  if (!targets || targets === "auto") return null;
  const unknown = targets.filter((t) => !MCP_TARGETS[t]);
  return unknown.length ? `未知注册目标：${unknown.join("、")}（可用：${Object.keys(MCP_TARGETS).join("、")}）` : null;
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
      if (!existsSync2(w.path)) {
        cfg = {};
      } else {
        const r = readJson(w.path);
        if (r.error) return { changed: false, error: "JSON 解析失败：" + r.error };
        cfg = r.cfg;
      }
      if (!isPlainContainer(cfg)) return { changed: false, error: "配置不是对象" };
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
        return { changed: false, note: `已是最新（v${existingVer} >= v${opts.version}）` };
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
          return { changed: false, error: "写入失败：" + String(e?.message || e) };
        }
      }
      return { changed: true, note: hasLegacyField ? `迁移（顶层版本键 → ${envKey}.${SHIM_VERSION_ENV}）` : existing ? `升级 v${existingVer} → v${opts.version}` : "新建" };
    })();
    results.push({ target: w.target, path: w.path, changed: outcome.changed, error: outcome.error });
    if (outcome.error) log(`  ✗ ${w.target} → ${w.path}：${outcome.error}`);
    else {
      if (outcome.changed) changed = true;
      log(`  ${outcome.changed ? "✓" : "·"} ${w.target} → ${w.path}${outcome.note ? "：" + outcome.note : ""}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}shim ${serverName} v${opts.version}（${opts.shimPath}）${results.length ? "；" + results.map((r) => r.error ? r.target + " ✗" : r.changed ? r.target + " ✓" : r.target + " ·").join(" ") : "（无目标文件）"}`;
  return { ok, changed, results, summary };
}
function resolveShimPathAuto(cwdCandidates) {
  const installedCandidates = [
    process.env.AITI_WEB_ROOT && join2(process.env.AITI_WEB_ROOT, "node_modules"),
    join2(homeDir(), ".pi", "web", "node_modules"),
    join2(homeDir(), ".pi", "web-dev", "node_modules")
  ].filter((p) => !!p).map((nm) => join2(nm, "@aiti-ai", "aiti-bridge", "bin", "aiti-mcp-shim.cjs"));
  const candidates = [
    process.env.AITI_SHIM_PATH,
    ...installedCandidates,
    ...cwdCandidates || [],
    join2(homeDir(), "workspace", "pi-work", "packages", "aiti-bridge", "bin", "aiti-mcp-shim.cjs")
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
      log("[aiti] stdio shim 未找到（可设 env AITI_SHIM_PATH 指向 aiti-mcp-shim.cjs），跳过 MCP 自注册");
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
    log("[aiti] shim 自注册失败（忽略，不影响 agent 启动）：" + String(e?.message || e));
    return null;
  }
}

// ../aiti-devtools-agent/src/bridge-client.ts
var AgentBridgeClient = class {
  _bridgeUp = false;
  /** 桥地址（已剥尾部斜杠，含 /aiti 路径前缀等） */
  base;
  constructor(base) {
    this.base = base.replace(/\/+$/, "");
  }
  /** 桥当前连通状态（probe/register 成功置 true，失败置 false） */
  get isUp() {
    return this._bridgeUp;
  }
  /** 桥连通性预检（GET /bridge/sessions；本地拒绝连接即时返回） */
  async probe(timeoutMs = 2500) {
    try {
      const res = await fetch(this.base + "/bridge/sessions", { signal: AbortSignal.timeout(timeoutMs) });
      this._bridgeUp = res.ok;
      return res.ok;
    } catch {
      this._bridgeUp = false;
      return false;
    }
  }
  /** agent 启动注册（POST /bridge/agent/register）→ agentKey；失败返回 null */
  async register(opts) {
    try {
      const res = await fetch(this.base + "/bridge/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5e3),
        body: JSON.stringify({
          agentId: opts.agentId,
          sessionId: opts.sessionId,
          name: opts.name,
          cwd: opts.cwd || void 0,
          source: opts.source || "extension",
          subEvents: opts.subEvents ?? ["page_error"]
        })
      });
      const b = await res.json().catch(() => null);
      return b && b.ok ? b : null;
    } catch {
      return null;
    }
  }
  /** 工具执行（POST /bridge/agent/tools/call）——支持宿主 signal 取消 + cancelId 通知桥中断挂起请求 */
  async callTool(tool, args, opts, signal) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 65e3);
    const onAbort = () => {
      clearTimeout(t);
      try {
        ctrl.abort();
      } catch {
      }
      if (opts.cancelId) {
        void fetch(this.base + "/bridge/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cancelId: opts.cancelId }),
          signal: AbortSignal.timeout(3e3)
        }).catch(() => {
        });
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return { ok: false, error: "已取消（agent 停止）" };
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const res = await fetch(this.base + "/bridge/agent/tools/call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        tool,
        args: args || {},
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        cwd: opts.cwd || void 0,
        source: "extension",
        cancelId: opts.cancelId
      })
    }).catch(() => null);
    if (signal) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {
      }
    }
    clearTimeout(t);
    if (!res) return { ok: false, error: "桥不可达：" + this.base };
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, error: "桥响应异常（HTTP " + res.status + "）" };
    return body;
  }
  /** agent 完成 → 回答回桥（POST /bridge/agent/answer）——消息流落盘供窗口展示 */
  async answer(agentKey, text) {
    try {
      await fetch(this.base + "/bridge/agent/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(5e3),
        body: JSON.stringify({ agentKey, text })
      });
    } catch {
    }
  }
  /**
   * agent SSE 持久流（桥 → 宿主注入模型）。断线指数退避重连 + 空闲兜底。
   *
   * @param registerFn 每次（重）连前调用以（重新）注册并取 agentKey——桥重启后 agents 表会丢，
   *   必须在 connect 前重新 register；返回 null 表示本轮不连（宿主要求，不重试）。
   * @param onMessage 每条 SSE 消息回调（含 type/text/payload）
   * @param opts idleMs（空闲超时，默认 60000）；retryBase（退避基数，默认 2000）
   * @returns 停止函数（置停 + abort 当前流；不再重连）
   */
  connectAgentStream(registerFn, onMessage, opts = {}) {
    const idleMs = opts.idleMs ?? 6e4;
    let retry = opts.retryBase ?? 2e3;
    let ctrl = null;
    let stopped = false;
    const run = async () => {
      if (stopped) return;
      const c = new AbortController();
      ctrl = c;
      const agentKey = await registerFn();
      if (!agentKey || stopped) {
        if (ctrl === c) ctrl = null;
        return;
      }
      this._bridgeUp = true;
      let idleTimer = null;
      const poke = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try {
            c.abort();
          } catch {
          }
        }, idleMs);
      };
      try {
        const resp = await fetch(this.base + "/bridge/agent/sse?agentKey=" + encodeURIComponent(agentKey), {
          signal: c.signal,
          headers: { Accept: "text/event-stream" }
        });
        if (!resp.ok || !resp.body) throw new Error("SSE HTTP " + resp.status);
        retry = opts.retryBase ?? 2e3;
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        poke();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          poke();
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data:"));
            if (line) {
              try {
                onMessage(JSON.parse(line.slice(5).trim()));
              } catch {
              }
            }
          }
        }
      } catch {
      }
      if (idleTimer) clearTimeout(idleTimer);
      if (stopped) return;
      if (ctrl === c) {
        setTimeout(() => {
          if (ctrl === c && !stopped) run();
        }, retry);
        retry = Math.min(3e4, retry * 2);
      }
    };
    run();
    return () => {
      stopped = true;
      try {
        ctrl?.abort();
      } catch {
      }
      ctrl = null;
    };
  }
};

// ../aiti-devtools-agent/src/agent-host.ts
function wrapToolResult(r) {
  if (!r.ok) {
    return { content: [{ type: "text", text: r.error || "未知错误" }], details: {}, isError: true };
  }
  return {
    content: [{ type: "text", text: r.result ?? "" }],
    details: {},
    ...r.isError ? { isError: true } : {}
  };
}

// ../aiti-devtools-agent/src/schema.ts
import { Type } from "typebox";
function jsonSchemaToTypeBox(schema) {
  if (!schema || typeof schema !== "object") return Type.Object({});
  const opts = (d) => d ? { description: d } : {};
  switch (schema.type) {
    case "string":
      return Type.String(opts(schema.description));
    case "number":
      return Type.Number(opts(schema.description));
    case "integer":
      return Type.Integer(opts(schema.description));
    case "boolean":
      return Type.Boolean(opts(schema.description));
    case "array": {
      const item = schema.items ? jsonSchemaToTypeBox(schema.items) : Type.Any();
      return Type.Array(item, opts(schema.description));
    }
    case "object": {
      const props = {};
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const [k, v] of Object.entries(schema.properties || {})) {
        const t = jsonSchemaToTypeBox(v);
        props[k] = required.includes(k) ? t : Type.Optional(t);
      }
      return Type.Object(props, opts(schema.description));
    }
    default:
      return Type.Object({}, opts(schema.description));
  }
}

// src/bridge-url.ts
var PI_WEB_EXT_PATH_SIG = "/api/extensions/aiti-devtools";
function normalizeBridgeBase(url) {
  try {
    const u = new URL(url);
    const idx = u.pathname.indexOf(PI_WEB_EXT_PATH_SIG);
    if (idx < 0) return url;
    const extBase = u.origin + u.pathname.slice(0, idx + PI_WEB_EXT_PATH_SIG.length);
    return extBase + "/mcp";
  } catch {
    return url;
  }
}

// src/index.ts
function logFile(msg) {
  try {
    const logDir = join3(getAgentDir(), "logs");
    mkdirSync3(logDir, { recursive: true });
    appendFileSync2(join3(logDir, "aiti-devtools-pi.log"), `[aiti-devtools-pi] ${(/* @__PURE__ */ new Date()).toISOString().slice(11, 19)} ${msg}
`);
  } catch {
  }
}
var DEFAULT_BRIDGE_URL = "http://127.0.0.1:8777/aiti";
function resolveBridgeUrl() {
  if (process.env.AITI_BRIDGE_URL) {
    const url = process.env.AITI_BRIDGE_URL.replace(/\/+$/, "");
    if (process.env.AITI_BRIDGE_PORT) {
      try {
        const uPort = new URL(url).port || (url.startsWith("https:") ? "443" : "80");
        if (uPort !== process.env.AITI_BRIDGE_PORT) {
          logFile("[aiti-devtools-pi] AITI_BRIDGE_URL（端口 " + uPort + "）与 AITI_BRIDGE_PORT=" + process.env.AITI_BRIDGE_PORT + " 不一致 → 以 URL 为准（PORT 被忽略）");
        }
      } catch {
      }
    }
    return normalizeBridgeBase(url);
  }
  const port = process.env.AITI_BRIDGE_PORT;
  if (port) {
    const host = process.env.AITI_BRIDGE_HOST || "127.0.0.1";
    return normalizeBridgeBase("http://" + host + ":" + port + "/aiti");
  }
  try {
    const settingsPath = join3(getAgentDir(), "settings.json");
    if (existsSync3(settingsPath)) {
      const cfg = JSON.parse(readFileSync3(settingsPath, "utf8"));
      const u = cfg?.settings?.aitiDevtools?.bridgeUrl;
      if (typeof u === "string" && u) return normalizeBridgeBase(u.replace(/\/+$/, ""));
    }
  } catch {
  }
  return DEFAULT_BRIDGE_URL;
}
function bridgeScriptPath() {
  if (process.env.AITI_BRIDGE_SCRIPT && existsSync3(process.env.AITI_BRIDGE_SCRIPT)) return process.env.AITI_BRIDGE_SCRIPT;
  const here = dirname3(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../aiti-bridge/bin/aiti-bridge.mjs"),
    // 源码/产物目录 → packages/aiti-bridge/bin
    resolve(homedir2(), "workspace/pi-work/packages/aiti-bridge/bin/aiti-bridge.mjs")
    // 开发环境绝对兜底
  ];
  for (const p of candidates) if (existsSync3(p)) return p;
  return null;
}
function ensureBridgeSetting(url) {
  try {
    const p = join3(getAgentDir(), "settings.json");
    let cfg = null;
    if (existsSync3(p)) {
      try {
        cfg = JSON.parse(readFileSync3(p, "utf8"));
      } catch {
        return false;
      }
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    const cur = cfg?.settings?.aitiDevtools?.bridgeUrl;
    if (typeof cur === "string" && cur.replace(/\/+$/, "") === url) return false;
    cfg = { ...cfg, settings: { ...cfg.settings || {}, aitiDevtools: { ...cfg.settings?.aitiDevtools || {}, bridgeUrl: url } } };
    writeFileSync3(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch (e) {
    return false;
  }
}
function ensureMcpConfig(url) {
  try {
    const p = join3(homedir2(), ".config", "mcp", "mcp.json");
    let cfg = null;
    if (existsSync3(p)) {
      try {
        cfg = JSON.parse(readFileSync3(p, "utf8"));
      } catch {
        return false;
      }
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    if (!cfg.mcpServers) cfg.mcpServers = {};
    const uu = new URL(url);
    const sigIdx = uu.pathname.indexOf(PI_WEB_EXT_PATH_SIG);
    const target = sigIdx >= 0 ? uu.origin + uu.pathname.slice(0, sigIdx + PI_WEB_EXT_PATH_SIG.length) + "/mcp/mcp" : uu.origin + "/aiti/mcp";
    const cur = cfg.mcpServers?.["aiti-devtools"];
    if (cur && cur.type === "http" && cur.url === target) return false;
    cfg.mcpServers = { ...cfg.mcpServers || {}, "aiti-devtools": { type: "http", url: target } };
    writeFileSync3(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch (e) {
    return false;
  }
}
function spawnBridge(script, host, port) {
  try {
    const log = openSync(join3(getAgentDir(), "aiti-bridge.log"), "a");
    const child = spawn2(process.execPath, [script, "--host", host, "--port", String(port)], {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, AITI_BRIDGE_HOST: host, AITI_BRIDGE_PORT: String(port) }
    });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}
async function bootstrapBridge(base) {
  ensureBridgeSetting(base);
  ensureMcpConfig(base);
  if (await probeBridge2(base, 1500)) return true;
  if (process.env.AITI_PI_EXT_NO_BOOTSTRAP) {
    logFile("[aiti-devtools-pi] 桥不可达且已跳过自动拉起（AITI_PI_EXT_NO_BOOTSTRAP=1）");
    return false;
  }
  const script = bridgeScriptPath();
  if (!script) {
    logFile("[aiti-devtools-pi] 桥不可达且找不到桥脚本，无法自动拉起（" + base + "）——可设 AITI_BRIDGE_SCRIPT 指定");
    return false;
  }
  const u = new URL(base);
  if (!u.port) {
    logFile("[aiti-devtools-pi] 托管桥（URL 无端口）不可达 → 不自动拉起，等待宿主恢复：" + base);
    return false;
  }
  const port = parseInt(u.port || "8777", 10) || 8777;
  const host = u.hostname || "127.0.0.1";
  logFile("[aiti-devtools-pi] 桥不可达 → 按端口 " + port + " 拉起独立桥：" + script);
  spawnBridge(script, host, port);
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await probeBridge2(base, 500)) {
      logFile("[aiti-devtools-pi] 桥已拉起并就绪（" + base + "）");
      return true;
    }
  }
  logFile("[aiti-devtools-pi] 桥拉起超时（" + base + "）——查看日志 " + join3(getAgentDir(), "aiti-bridge.log"));
  return false;
}
var agentId = () => process.env.AITI_AGENT_ID || "pi";
function agentDisplayName() {
  if (process.env.AITI_AGENT_NAME) return process.env.AITI_AGENT_NAME;
  try {
    const settingsPath = join3(getAgentDir(), "settings.json");
    if (existsSync3(settingsPath)) {
      const cfg = JSON.parse(readFileSync3(settingsPath, "utf8"));
      const n = cfg?.settings?.aitiDevtools?.agentName;
      if (typeof n === "string" && n) return n;
    }
  } catch {
  }
  return "pi";
}
var bridge = createBridge(join3(getAgentDir(), "aiti-bridge"));
var _bridgeClient = null;
function getBridgeClient(base) {
  if (!_bridgeClient || _bridgeClient.base !== base) _bridgeClient = new AgentBridgeClient(base);
  return _bridgeClient;
}
var currentSessionId = null;
var currentAgentKey = null;
var currentCwd = "";
var streamCtrl = null;
var FALLBACK_SESSION = "s_p" + process.pid.toString(36);
var bridgeUp = false;
var toolsRegistered = false;
async function callBridgeTool(tool, args, signal, cancelId) {
  const relay = globalThis.__aitiTuiRelay;
  if (relay && relay.active()) {
    try {
      logFile("[aiti-devtools-pi] transport=socket →", tool);
      const r = await relay.call(tool, args || {}, cancelId, signal);
      return r;
    } catch (e) {
      logFile("[aiti-devtools-pi] socket 转发失败 → 回退直连桥：", e instanceof Error ? e.message : e);
    }
  } else {
    logFile("[aiti-devtools-pi] transport=http(relay未激活) →", tool);
  }
  return getBridgeClient(resolveBridgeUrl()).callTool(
    tool,
    args || {},
    { agentId: agentId(), sessionId: currentSessionId || FALLBACK_SESSION, cwd: currentCwd || void 0, cancelId },
    signal
  );
}
async function registerAgent(base, sessionId, name, cwd) {
  return getBridgeClient(base).register({ agentId: agentId(), sessionId, name, cwd: cwd || void 0, source: "extension", subEvents: ["page_error"] });
}
async function probeBridge2(base, timeoutMs = 2500) {
  const ok = await getBridgeClient(base).probe(timeoutMs);
  bridgeUp = ok;
  return ok;
}
var STREAM_IDLE_MS = 6e4;
async function connectAgentStream(pi, base, sessionId, name, cwd, onMessage) {
  if (streamCtrl) {
    try {
      streamCtrl.abort();
    } catch {
    }
  }
  let retry = 2e3;
  let respawned = false;
  const run = async () => {
    const ctrl = new AbortController();
    streamCtrl = ctrl;
    const reg = await registerAgent(base, sessionId, name, cwd).catch(() => null);
    if (!reg || !reg.agentKey) {
      bridgeUp = false;
      if (!respawned && !process.env.AITI_PI_EXT_NO_BOOTSTRAP) {
        const script = bridgeScriptPath();
        const u = (() => {
          try {
            return new URL(base);
          } catch {
            return null;
          }
        })();
        if (script && u?.port) {
          try {
            respawned = true;
            spawnBridge(script, u.hostname || "127.0.0.1", parseInt(u.port, 10) || 8777);
            logFile("[aiti-devtools-pi] 桥会话内失联 → 尝试重新拉起：" + script + "（" + base + "）");
          } catch (e) {
          }
        }
      }
      if (streamCtrl === ctrl && !ctrl.signal.aborted) {
        setTimeout(() => {
          if (streamCtrl === ctrl && !ctrl.signal.aborted) run();
        }, retry);
        retry = Math.min(3e4, retry * 2);
      }
      return;
    }
    bridgeUp = true;
    currentAgentKey = reg.agentKey;
    registerBridgeTools(pi);
    let idleTimer = null;
    const poke = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          ctrl.abort();
        } catch {
        }
      }, STREAM_IDLE_MS);
    };
    try {
      const resp = await fetch(base + "/bridge/agent/sse?agentKey=" + encodeURIComponent(reg.agentKey), {
        signal: ctrl.signal,
        headers: { Accept: "text/event-stream" }
      });
      if (!resp.ok || !resp.body) throw new Error("SSE HTTP " + resp.status);
      retry = 2e3;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      poke();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        poke();
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data:"));
          if (line) {
            try {
              onMessage(JSON.parse(line.slice(5).trim()));
            } catch {
            }
          }
        }
      }
    } catch (e) {
      if (streamCtrl !== ctrl) return;
    }
    if (idleTimer) clearTimeout(idleTimer);
    setTimeout(() => {
      if (streamCtrl === ctrl) run();
    }, retry);
    retry = Math.min(3e4, retry * 2);
  };
  run();
}
var lastUserSrc = { pageId: null, url: null, sourceLabel: null };
function injectAgentEvent(pi, m) {
  if (!m || typeof m !== "object") return;
  let text = "";
  if (m.type === "page_event") {
    text = m.text || "";
  } else if (m.type === "agent_push") {
    if (m.kind === "user_answer") text = "💬 你的交互请求有人作答（来自 aiti-devtools）：" + (m.text || "");
    else text = "💬 人发来消息（来自 aiti-devtools）：" + (m.text || "");
    const p = m.payload || {};
    if (p.pageId || p.sourceLabel) lastUserSrc = { pageId: p.pageId || null, url: p.url || null, sourceLabel: p.sourceLabel || null };
  }
  if (!text) return;
  logFile("[aiti-devtools-pi] 收到推送 → 注入会话：" + text.slice(0, 120));
  try {
    pi.sendUserMessage(text, { deliverAs: "steer" });
  } catch (e) {
    console.error("[aiti-devtools-pi] 注入失败", e);
  }
}
var lastAssistantText = "";
function extractAssistantText(content) {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((p) => p && p.type === "text" ? String(p.text || "") : "").join("\n").trim();
  }
  if (content && content.type === "text") return String(content.text || "").trim();
  return "";
}
async function postAgentAnswer(text) {
  if (!text || !currentAgentKey || !bridgeUp) return;
  await getBridgeClient(resolveBridgeUrl()).answer(currentAgentKey, text);
}
function registerBridgeTools(pi) {
  if (toolsRegistered) return;
  toolsRegistered = true;
  for (const t of bridge.tools()) {
    const prefixed = "aiti_" + t.name;
    pi.registerTool({
      name: prefixed,
      description: t.description + "（aiti-devtools-pi 扩展直连独立桥——如与 MCP 同名工具冲突，用本前缀版）",
      parameters: jsonSchemaToTypeBox(t.inputSchema || { type: "object", properties: {} }),
      async execute(toolCallId, params, signal) {
        const r = await callBridgeTool(t.name, params || {}, signal, toolCallId);
        return wrapToolResult(r);
      }
    });
  }
}
async function index_default(pi) {
  const BRIDGE_CFG_ENVS = /* @__PURE__ */ new Set([
    "PI_WEB_BRIDGE_AUTO",
    "PI_WEB_BRIDGE_BASE",
    "PI_WEB_BRIDGE_PORT",
    "PI_WEB_BRIDGE_LANG",
    // TUI 自动桥空闲超时（与 pi-web inprocess 会话同名的用户级配置；设了它不得被误判为宿主）
    "PI_WEB_IDLE_TIMEOUT_MS"
  ]);
  if (!process.env.AITI_PI_EXT_FORCE) {
    let dup = false;
    try {
      const all = pi.getAllTools?.();
      if (Array.isArray(all)) dup = all.some((t) => t && typeof t.name === "string" && t.name.startsWith("aiti_"));
    } catch {
    }
    const piWebEnv = Object.keys(process.env).some((k) => k.startsWith("PI_WEB_") && !BRIDGE_CFG_ENVS.has(k));
    if (dup || piWebEnv) {
      logFile(`[aiti-devtools-pi] 跳过注册（${dup ? "工具表已有 aiti_*" : "pi-web 进程（PI_WEB_* env）——已由 pi-web 扩展注册"}）`);
      return;
    }
  }
  const bridgeBase = resolveBridgeUrl();
  await bootstrapBridge(bridgeBase);
  if (bridgeUp) {
    registerBridgeTools(pi);
  } else {
    logFile(`[aiti-devtools-pi] 桥不可达（${bridgeBase}）→ 暂不注册 aiti_* 工具（会话中持续尝试连接桥，恢复后自动补注册 + 建 SSE；先起独立桥：node packages/aiti-bridge/bin/aiti-bridge.mjs）`);
  }
  pi.on("session_start", async (_e, ctx) => {
    const base = resolveBridgeUrl();
    let piMcpCfg = null;
    try {
      piMcpCfg = join3(getAgentDir(), "mcp.json");
    } catch {
    }
    autoRegisterAitiShim({ targets: ["pi"], configPaths: piMcpCfg ? [piMcpCfg] : void 0, log: logFile });
    let sid = null;
    try {
      sid = ctx.sessionManager.getSessionId() || null;
    } catch {
    }
    if (!sid) {
      try {
        const f = ctx.sessionManager.getSessionFile();
        if (f) sid = f.split(/[/\\]/).pop()?.replace(/\.jsonl$/, "") || null;
      } catch {
      }
    }
    if (!sid) sid = "s_" + Date.now().toString(36);
    currentSessionId = sid;
    currentCwd = ctx.cwd || "";
    const name = agentDisplayName();
    await probeBridge2(base, 800);
    if (bridgeUp) registerBridgeTools(pi);
    connectAgentStream(pi, base, sid, name, currentCwd, (m) => injectAgentEvent(pi, m));
    logFile(`[aiti-devtools-pi] session_start · 桥${bridgeUp ? "已连接" : "不可达（后台重试中）"} · session=${sid}`);
    ctx.ui.notify(
      bridgeUp ? `🧰 aiti-devtools 已注册：${currentAgentKey || "…"}（桥 ${base}；页面注入 <script src="${base}/aiti-launcher.js">）` : `🧰 aiti-devtools 桥不可达：${base}（后台持续尝试连接，桥恢复后页面消息自动注入；先起独立桥：node packages/aiti-bridge/bin/aiti-bridge.mjs）`,
      bridgeUp ? "info" : "warning"
    );
  });
  pi.on("session_shutdown", () => {
    if (lastAssistantText) {
      const t = lastAssistantText;
      lastAssistantText = "";
      logFile("[aiti-devtools-pi] session_shutdown 补发回答 → ", t.slice(0, 60));
      void postAgentAnswer(t);
    }
    currentSessionId = null;
    currentAgentKey = null;
    currentCwd = "";
    lastAssistantText = "";
    if (streamCtrl) {
      try {
        streamCtrl.abort();
      } catch {
      }
      streamCtrl = null;
    }
  });
  pi.on("message_end", async (event) => {
    if (!event || event.message?.role !== "assistant") return;
    const t = extractAssistantText(event.message.content);
    if (t) lastAssistantText = t;
  });
  pi.on("agent_settled", async () => {
    if (!lastAssistantText) return;
    const t = lastAssistantText;
    lastAssistantText = "";
    if (!bridgeUp) {
      logFile("[aiti-devtools-pi] 桥未联通 → 跳过回答回桥（不发总结）");
      return;
    }
    await postAgentAnswer(t);
  });
}
export {
  index_default as default
};
