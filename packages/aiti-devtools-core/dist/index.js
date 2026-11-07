// src/bridge.ts
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
        console.log(TAG + " AI \u4E3B\u7A97\u53E3\u6D3B\u8DC3\u7ED1\u5B9A\uFF1A" + key + " \u2192 " + pageId);
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
  const msgSessionDir = (agentId) => join(dataDir, "aiti-bridge", "sessions", safeId(agentId));
  const msgSessionFile = (agentId) => {
    const dir = msgSessionDir(agentId);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
    if (files.length) {
      const latest = join(dir, files[files.length - 1]);
      try {
        if (statSync(latest).size > 2 * 1024 * 1024) return newMsgSessionFile(agentId);
      } catch {
      }
      return latest;
    }
    return newMsgSessionFile(agentId);
  };
  const newMsgSessionFile = (agentId) => {
    const dir = msgSessionDir(agentId);
    mkdirSync(dir, { recursive: true });
    return join(dir, (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-") + "_" + randomBytes(8).toString("hex") + ".jsonl");
  };
  const appendMsgEvent = (agentId, evt) => {
    try {
      const file = msgSessionFile(agentId);
      if (!existsSync(file)) appendFileSync(file, JSON.stringify({ type: "session", version: 1, id: randomBytes(8).toString("hex"), timestamp: (/* @__PURE__ */ new Date()).toISOString(), kind: "aiti-bridge" }) + "\n");
      appendFileSync(file, JSON.stringify(evt) + "\n");
    } catch (e) {
    }
  };
  const readMsgSession = (agentId) => {
    const rows = [];
    try {
      const dir = msgSessionDir(agentId);
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
      console.log(TAG + " agent \u4F1A\u8BDD\u6CE8\u518C\uFF1A" + key + (a.registered ? "\uFF08\u663E\u5F0F\uFF09" : "\uFF08\u968F\u673A session\uFF0C\u5F15\u5BFC aiti_hello \u6CE8\u518C\uFF09") + " " + a.transportKind + " \u6062\u590D outbox " + a.outbox.length + " \u6761");
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
          console.log(TAG + " \u6E05\u7406\u5386\u53F2 session\uFF08> " + Math.round(AGENT_HISTORY_TTL / 864e5) + " \u5929\u65E0\u6D3B\u52A8\uFF09\uFF1A" + d);
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
        console.log(TAG + " agent \u6E05\u7406\uFF08\u6389\u7EBF > " + Math.round(AGENT_TTL / 6e4) + "min\uFF09\uFF1A" + key + " " + (a.name || "") + "\uFF08offlineAt " + new Date(a.offlineAt).toISOString() + "\uFF09");
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
        console.log(TAG + " \u603B\u7EBF\u578B\u9875\u9762\u8FDE\u63A5\u8D85\u65F6\u6458\u9664\uFF1A" + iid);
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
    if (!targets.length) return { ok: false, error: "\u65E0\u5DF2\u6CE8\u518C agent \u4F1A\u8BDD\uFF08agent \u8FDE\u6865\u5E76\u6CE8\u518C\u540E\u624D\u6709\u6536\u4EF6\u7BB1\uFF09" };
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
        return s.slice(0, half) + "\u2026" + s.slice(s.length - half);
      };
      let tText = String(text);
      if (srcPageId && tText.indexOf("[\u53D1\u81EA: ") < 0) {
        const parts = [srcPageId];
        if (srcUrl) parts.push(clipMid(srcUrl, 64));
        if (srcTitle) parts.push(clipMid(srcTitle, 40));
        tText = tText + "\n[\u53D1\u81EA: " + parts.join(" \xB7 ") + "\uFF08" + srcLabel + "\uFF1ApageId \u53C2\u6570\u7528\u5B83\uFF09]";
      }
      payload = { ...payload || {}, source: a && a.source || null, sourceLabel: srcLabel, pageId: srcPageId, url: srcUrl, title: srcTitle };
      const canSample = !!(a && a.stream && a.capabilities && a.capabilities.sampling && (kind === "user_message" || kind === "chat"));
      if (canSample) {
        const rid = "smp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
        const done = (ok, result) => {
          if (!pendingSampling.delete(rid)) return;
          const answer2 = ok ? samplingTextOf(result) : result && result.error || "sampling \u5931\u8D25";
          console.log(TAG + " sampling \u4F5C\u7B54 \u2192 agent=" + t + " \xB7 " + String(answer2).slice(0, 80));
          for (const w of aiConns) w.write({ type: "agent_answer", agentKey: t, agentId: a.agentId, ok, text: answer2, requestId: rid, at: Date.now() });
        };
        pendingSampling.set(rid, { agentKey: t, done, at: Date.now() });
        a.stream.write({
          jsonrpc: "2.0",
          id: rid,
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: tText } }],
            systemPrompt: "\uFF08\u8C03\u8BD5\u73B0\u573A\u7684\u4EBA\u901A\u8FC7 " + DISPLAY_NAME + " \u53D1\u6765\u7684\u6D88\u606F\u3002\u76EE\u6807\u9875 pageId=" + (payload.pageId || "?") + "\u3002\u76F4\u63A5\u56DE\u7B54\u5373\u53EF\uFF0C\u7B80\u77ED\u3002",
            maxTokens: 1024,
            temperature: 0.3
          }
        });
        setTimeout(() => done(false, { error: "sampling \u8D85\u65F6\uFF08agent \u672A\u54CD\u5E94\u6216\u9700\u5BA1\u6279\u786E\u8BA4\uFF09" }), SAMPLING_TIMEOUT_MS);
        delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "sampling" });
      } else {
        const q = queueMsg(t, { kind, from: "window", text: tText, payload, pageId: payload && payload.pageId || null, source: payload.source, sourceLabel: payload.sourceLabel, ref });
        if (typeof a.inProcessSink === "function") {
          try {
            a.inProcessSink(tText, kind, payload);
          } catch (e) {
            console.error(TAG + " inProcessSink \u5931\u8D25", e);
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
        console.error(TAG + " inProcessSink \u5931\u8D25", e);
      }
    }
    queueMsg(agentKey2, { kind: "user_answer", from: "page", text, payload: result });
  };
  const formatPageEvent = (eventType, payload, pageInfo) => {
    const where = pageInfo && pageInfo.url ? pageInfo.pageId ? `[${pageInfo.pageId} \xB7 ${pageInfo.url}]` : `[${pageInfo.url}]` : "";
    if (eventType === "page_error") {
      const pl = payload || {};
      return `\u26A0 \u9875\u9762\u62A5\u9519${where} ${pl.kind || ""} ${String(pl.message || "").slice(0, 300)}` + (pl.stack ? `
${String(pl.stack).slice(0, 400)}` : "");
    }
    if (eventType === "page_log") {
      const items = ((payload || {}).logs || (payload || {}).batch || []).slice(0, 5);
      return `\u{1F4CB} \u9875\u9762\u65E5\u5FD7${where}: ` + items.map((l) => `[${l.level}] ${String(l.text || "").slice(0, 120)}`).join(" | ");
    }
    if (eventType === "page_network") {
      const items = ((payload || {}).requests || (payload || {}).batch || []).slice(0, 5);
      return `\u{1F310} \u9875\u9762\u7F51\u7EDC${where}: ` + items.map((r) => `${r.method || "?"} ${String(r.url || "").slice(0, 80)} \u2192 ${r.status ?? "?"}${r.error ? " ERR" : ""}`).join(" | ");
    }
    return `\u{1F4E2} \u9875\u9762\u4E8B\u4EF6${where}: ${JSON.stringify(payload).slice(0, 200)}`;
  };
  const pushEventToSubscribers = (eventType, payload, pageInfo) => {
    const sigBase = eventType + ":" + JSON.stringify(payload).slice(0, 120);
    const now = Date.now();
    for (const [key, a] of agents) {
      if (!a.subEvents || !a.subEvents.has(eventType)) continue;
      if (!agentOnline(a) && now - (a.offlineAt || a.lastSeen || 0) > BROADCAST_TTL) continue;
      if (pushDeduped(key, sigBase)) {
        console.log(TAG + " push \u53BB\u91CD\uFF085s \u5185\u540C\u4E8B\u4EF6\uFF09" + key + " " + eventType);
        continue;
      }
      const text = formatPageEvent(eventType, payload, pageInfo);
      if (a.agentStream) a.agentStream.write({ type: "page_event", event: eventType, text, pageId: pageInfo && pageInfo.pageId || null, url: pageInfo && pageInfo.url || null, at: Date.now() });
      else {
        queueMsg(key, { kind: "page_" + eventType, from: "page", text, payload });
        console.log(TAG + " push \u65E0\u6D41 \u2192 outbox " + key + " " + eventType);
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
      const selfRow = { instanceId: rec.instanceId, frameId: "ai", pageId: selfPageId, url: rec.url || null, title: rec.title ? rec.title + " \xB7 AI \u4E3B\u7A97\u53E3" : "AI \u4E3B\u7A97\u53E3", frameworks: null, active: true, viaAI: true, self: true, lastSeen: rec.lastSeen };
      withDevice(selfRow, rec.device, rec.deviceLabel);
      addMine(selfRow);
      out.push(selfRow);
    }
    return out;
  }
  const TOOLS = [
    {
      name: "page_exec",
      description: "\u5728\u5DF2\u8FDE\u63A5\u9875\u9762\u6267\u884C\u7C7B CDP \u547D\u4EE4\uFF08DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser \u57DF\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002\u5371\u9669\u547D\u4EE4/\u6D4F\u89C8\u5668\u53D7\u9650\u64CD\u4F5C\u4F1A\u81EA\u52A8\u5F39\u7528\u6237\u786E\u8BA4\uFF1BPage.captureScreenshot \u622A\u5C4F\u4F1A\u5148\u5F39\u51C6\u5907\u5361\u5C55\u793A\u622A\u53D6\u610F\u56FE\uFF08args.reason\uFF0C\u8BF7\u52A1\u5FC5\u7528\u4E00\u53E5\u8BDD\u8BF4\u660E\u60F3\u622A\u4EC0\u4E48\uFF09\uFF0C\u7528\u6237\u8C03\u6574\u597D\u9875\u9762\u624D\u5F00\u59CB\u622A\u5C4F\uFF0C\u622A\u5B8C\u518D\u5F39\u9884\u89C8\u786E\u8BA4\uFF08\u5927\u56FE\u81EA\u52A8\u843D\u76D8\u8FD4\u56DE\u6587\u4EF6\u8DEF\u5F84\uFF09\uFF1B\u786E\u8BA4\u5361\u5012\u8BA1\u65F6\u53EF\u7528 args.timeout\uFF08ms\uFF09\u8C03\u6574\uFF08\u9ED8\u8BA4 280000\uFF0C\u670D\u52A1\u7AEF\u5B89\u5168\u7F51\u81EA\u52A8\u540C\u6B65 +30s \u4F59\u91CF\uFF09\u3002\u8C03\u8BD5\u4F1A\u8BDD\u4E2D\u4ECE\u88AB\u8C03\u8BD5\u9875\u9762\uFF08inject\uFF09\u53D1\u51FA\u7684\u6D88\u606F\u7EDF\u4E00\u5E26 [\u53D1\u81EA: <pageId> \xB7 <url>] \u6765\u6E90\u6807\u6CE8\u2014\u2014\u628A pageId \u503C\u4F20\u7ED9 pageId \u53C2\u6570\u5373\u64CD\u4F5C\u8BE5\u9875\u9762\u3002\n\niframe \u652F\u6301\uFF1APage.getFrameTree \u67E5\u770B frame \u6811\uFF08iframe src/name/title\uFF0C\u540C\u57DF\u542B url/readyState\uFF09\uFF1BRuntime.evaluate \u4F20 contextId\uFF08iframe \u7D22\u5F15\u4ECE 1 \u8D77\uFF0C\u540C\u57DF\u53EF eval\uFF09\u8FDB iframe \u4E0A\u4E0B\u6587\u6267\u884C\u3002",
      inputSchema: { type: "object", properties: {
        cmd: { type: "string" },
        args: { type: "object" },
        pageId: { type: "string", description: "\u76EE\u6807\u9875\u9762\u5B8C\u6574 ID\u2014\u2014\u6765\u81EA AI \u6D88\u606F\u7684 [\u53D1\u81EA: xxx]\uFF08\u5982 3001/host\uFF09\uFF1B\u4E5F\u53EF /bridge/sessions \u67E5\u8BE2" }
      }, required: ["cmd"] }
    },
    { name: "page_snapshot", description: "\u62C9\u53D6\u5DF2\u8FDE\u63A5\u9875\u9762\u57FA\u7840\u73B0\u573A\uFF08URL/\u9009\u533A/\u6A21\u62DF\u6761\u4EF6\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002", inputSchema: { type: "object", properties: { pageId: { type: "string" } } } },
    { name: "self_ui", description: "\u626B\u63CF\u76EE\u6807\u9875\u9762\uFF08\u7F3A\u7701 AI \u4E3B\u7A97\u53E3 xxx/ai\uFF09\u5F53\u524D\u6253\u5F00\u7684\u5F39\u7A97/dialog/\u8868\u5355\u5B57\u6BB5/\u6309\u94AE\u6E05\u5355\u2014\u2014ai-helper \u56DE\u586B\u5B9A\u4F4D\u7528\u3002\u8FD4\u56DE {dialogs:[{title, fields:[{label,selector,type}], buttons}]}\uFF0C\u65E0\u5F39\u7A97\u65F6 dialogs \u4E3A\u7A7A\u6570\u7EC4\u3002", inputSchema: { type: "object", properties: { pageId: { type: "string", description: "\u7F3A\u7701\u7528 AI \u4E3B\u7A97\u53E3\uFF08xxx/ai\uFF09\uFF1B\u4E5F\u53EF\u6307\u5B9A\u5176\u4ED6\u9875\u9762" } } } },
    { name: "form_fill", description: "\u5728\u76EE\u6807\u9875\u9762\uFF08\u7F3A\u7701 AI \u4E3B\u7A97\u53E3 xxx/ai\uFF09\u7684\u5F39\u7A97/\u8868\u5355\u91CC\u56DE\u586B\u5B57\u6BB5\u503C\u2014\u2014AI \u7ED3\u679C\u76F4\u63A5\u64CD\u4F5C\u6269\u5C55\u5F39\u7A97\u8868\u5355\uFF08React \u517C\u5BB9\uFF1A\u539F\u751F value setter + dispatch input/change\uFF09\u3002\u914D\u5408 self_ui \u4F7F\u7528\uFF1A\u5148 self_ui \u62FF\u5B57\u6BB5 label/selector\uFF0C\u518D form_fill \u586B\u503C\u3002\u53C2\u6570\uFF1Adialog\uFF08\u5F39\u7A97\u6807\u8BC6\uFF1A\u6807\u9898\u5B50\u4E32\u6216\u5E8F\u53F7 0 \u8D77\uFF0C\u7F3A\u7701\u53D6\u9762\u79EF\u6700\u5927\u7684\u53EF\u89C1\u5F39\u7A97\uFF09\u3001fields[{selector|label, value}]\u3001button\uFF08\u53EF\u9009\uFF0C\u56DE\u586B\u540E\u70B9\u51FB\u7684\u6309\u94AE\u6587\u672C\u5982\u300E\u4FDD\u5B58\u300F\uFF09\u3002\u8FD4\u56DE {foundDialog, title, filled, missed, clicked}\u3002", inputSchema: { type: "object", properties: {
      pageId: { type: "string", description: "\u7F3A\u7701\u7528 AI \u4E3B\u7A97\u53E3\uFF08xxx/ai\uFF09\uFF1B\u4E5F\u53EF\u6307\u5B9A\u5176\u4ED6\u9875\u9762" },
      dialog: { type: "string", description: "\u5F39\u7A97\u6807\u8BC6\uFF1A\u6807\u9898\u5B50\u4E32\u6216\u5E8F\u53F7\uFF080 \u8D77\uFF09\uFF1B\u7F3A\u7701\u53D6\u9762\u79EF\u6700\u5927\u7684\u53EF\u89C1\u5F39\u7A97" },
      fields: { type: "array", items: { type: "object", properties: { selector: { type: "string", description: "CSS \u9009\u62E9\u5668\uFF08\u4F18\u5148\uFF09" }, label: { type: "string", description: "\u5F39\u7A97\u5185\u6587\u672C\u5339\u914D\uFF08label[for]/\u5305\u88F9/\u6587\u672C\u5305\u542B\uFF09" }, value: { type: "string", description: "\u8981\u586B\u7684\u503C" } }, required: ["value"] }, description: "\u8981\u586B\u7684\u5B57\u6BB5\u5217\u8868" },
      button: { type: "string", description: "\u56DE\u586B\u540E\u70B9\u51FB\u7684\u6309\u94AE\u6587\u672C\uFF08\u5982\u300E\u4FDD\u5B58\u300F\u300E\u786E\u5B9A\u300F\uFF09" }
    } } },
    { name: "bridge_status", description: "\u67E5\u8BE2\u5DF2\u8FDE\u63A5\u9875\u9762\uFF08sessions\uFF1A\u542B pageId/url/title/frameworks + device/deviceLabel\u2014\u2014\u6D4F\u89C8\u5668\xB7OS\xB7\u5C4F\u5E55\xB7dpr\xB7\u5728\u7EBF\xB7\u8BED\u8A00\xB7\u65F6\u533A\u7B49\u8BBE\u5907\u4FE1\u606F\uFF0C\u4FBF\u4E8E\u533A\u5206\u591A\u53F0\u673A\u5668/\u6807\u7B7E\u9875\uFF09\u4E0E\u6302\u8D77\u8BF7\u6C42\u3002\u7528\u6237\u63D0\u5230\u9875\u9762\u6807\u9898\u6216 URL \u65F6\uFF0C\u6309 title/url \u5339\u914D pageId\uFF08\u5982 refresh\u300E\u67D0\u6807\u9898\u9875\u9762\u300F\u6216\u300E\u67D0\u4E2A url \u9875\u9762\u300F\uFF09\u3002", inputSchema: { type: "object", properties: {} } },
    {
      name: "page_logs",
      description: "\u4ECE\u76EE\u6807\u9875\u9762\u62C9\u53D6\u672C\u5730\u7F13\u51B2\u7684 console \u65E5\u5FD7\uFF08log/debug/info/warn/error \u5168\u91CF\uFF0CCDP Runtime.evaluate \u8BFB\u53D6 window.__dbg.__consoleRing\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002\u9875\u9762\u62A5\u9519\u6392\u67E5\u9996\u9009\uFF1A\u5148\u67E5 warn/error \u518D\u9010\u6B65\u653E\u5F00\u3002\u8FD4\u56DE {logs:[{ts,level,text,count}], bufferSize}\u3002",
      inputSchema: { type: "object", properties: {
        pageId: { type: "string", description: "\u76EE\u6807\u9875\u9762\u5B8C\u6574 ID\uFF08[\u53D1\u81EA: xxx] \u6216 /bridge/sessions\uFF09" },
        level: { type: "string", description: "\u8FC7\u6EE4\u7EA7\u522B\uFF1Adebug/log/info/warn/error\uFF08\u9ED8\u8BA4\u5168\u90E8\uFF09" },
        since: { type: "string", description: "ISO \u65F6\u95F4\uFF1A\u53EA\u8FD4\u56DE\u6B64\u65F6\u95F4\u4E4B\u540E\u7684\u65E5\u5FD7" },
        limit: { type: "number", description: "\u6761\u6570\u4E0A\u9650\uFF08\u2264200\uFF0C\u9ED8\u8BA4 50\uFF0C\u53D6\u6700\u65B0\uFF09" },
        token: { type: "string" }
      } }
    },
    {
      name: "page_network",
      description: "\u4ECE\u76EE\u6807\u9875\u9762\u62C9\u53D6\u672C\u5730\u7F13\u51B2\u7684 ajax/fetch \u8BF7\u6C42\u5B8C\u6210\u6001\uFF08CDP Runtime.evaluate \u8BFB\u53D6 window.__dbg.__netRing\uFF09\u3002pageId \u7F3A\u7701=\u6700\u65B0 AI \u4E3B\u7A97\u53E3\uFF08self:true\uFF09\uFF1B\u663E\u5F0F pageId \u4F18\u5148\u3002\u5931\u8D25\u6392\u67E5\uFF1Astatus \u4F20 400 \u6216 errorOnly:true\u3002\u6CE8\u610F\uFF1A\u4E0D\u542B\u9759\u6001\u8D44\u6E90\u52A0\u8F7D\uFF08\u90A3\u662F CDP Network \u7684\u80FD\u529B\uFF09\u3002\u8FD4\u56DE {requests:[{kind,method,url,status,statusText,durationMs,size,error,ts}], bufferSize}\u3002",
      inputSchema: { type: "object", properties: {
        pageId: { type: "string" },
        url: { type: "string", description: "URL \u5B50\u4E32\u8FC7\u6EE4" },
        status: { type: "number", description: "status >= \u6B64\u503C\u624D\u8FD4\u56DE\uFF08\u5982 400 \u53EA\u770B\u5931\u8D25\uFF09" },
        errorOnly: { type: "boolean", description: "\u53EA\u770B\u5931\u8D25\uFF08error \u975E\u7A7A \u6216 status>=400\uFF09" },
        limit: { type: "number", description: "\u6761\u6570\u4E0A\u9650\uFF08\u2264100\uFF0C\u9ED8\u8BA4 30\uFF0C\u53D6\u6700\u65B0\uFF09" },
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
      description: "\u8BF7\u5F53\u524D\u9875\u9762\u7684\u4EBA\u7C7B\u7528\u6237\u70B9\u9009\u4E00\u4E2A\u9875\u9762\u5143\u7D20\uFF08\u81EA\u52A8\u8FDB\u5165 Inspector \u70B9\u9009\u6A21\u5F0F\u3001\u6536\u8D77 AI \u7A97\u53E3\u3001\u5F39\u70B9\u9009\u9762\u677F\uFF1B\u7528\u6237\u53EF\u786E\u8BA4\u9009\u4E2D\u6216\u62D2\u7EDD\uFF09\u3002\u8FD4\u56DE\u5143\u7D20\u8F7D\u8377 {tag,rect,xpath,text,attributes,framework,selector}\u3002",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "\u7ED9\u7528\u6237\u770B\u7684\u8BF4\u660E\uFF08\u4E3A\u4EC0\u4E48\u9700\u8981\u70B9\u9009\u8FD9\u4E2A\u5143\u7D20\uFF09" },
        timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
        rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
        async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
        pageId: { type: "string", description: "\u76EE\u6807\u9875\u9762\u5B8C\u6574 ID\uFF08instanceId/frameId\uFF09" }
      }, required: ["prompt"] }
    },
    {
      name: "user_confirm",
      description: "\u5728 AI \u7A97\u53E3\u5185\u5411\u4EBA\u7C7B\u7528\u6237\u63D0\u4E00\u4E2A\u662F/\u5426\u95EE\u9898\uFF08\u5982\u201C\u786E\u8BA4\u6267\u884C\u6B64\u64CD\u4F5C\uFF1F\u201D\u201C\u662F\u5426\u7EE7\u7EED\uFF1F\u201D\uFF09\uFF0C\u7528\u6237\u70B9 \u2705/\u274C \u4F5C\u7B54\uFF0C\u5E76\u53EF\u9644\u300C\u8865\u5145\u8BF4\u660E\u300D\u81EA\u7531\u6587\u672C\uFF08value.comment\uFF09\uFF1B\u53E6\u6709\u56FA\u5B9A\u9009\u9879\u300C\u90FD\u4E0D\u9002\u5408\u300D\u2192 \u81EA\u5B9A\u4E49\u56DE\u7B54\uFF08approved:null, custom\uFF09\u3002\u8FD4\u56DE {status, approved, comment?, custom?, reason?}\u3002",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "\u95EE\u9898\u5185\u5BB9" },
        timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
        rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u4EE5\u201C\u6682\u65F6\u65E0\u6CD5\u5904\u7406\u201D\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
        async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF08\u4E0D\u963B\u585E\u672C\u8C03\u7528\uFF09\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
        pageId: { type: "string" }
      }, required: ["prompt"] }
    },
    {
      name: "user_choose",
      description: "\u5728 AI \u7A97\u53E3\u5185\u7ED9\u4EBA\u7C7B\u7528\u6237\u4E00\u7EC4\u9009\u9879\u8BA9\u5176\u9009\u62E9\uFF08\u5982\u4FEE\u590D\u65B9\u6848 A/B/C\uFF09\u3002\u5355\u9009\uFF08\u9ED8\u8BA4\uFF09\u2192 value:{index,label}\uFF1Bmultiple:true \u591A\u9009 \u2192 value:{indexes,labels}\u3002\u7528\u6237\u53EF\u9644\u300C\u8865\u5145\u8BF4\u660E\u300D\u81EA\u7531\u6587\u672C\uFF08value.comment\uFF09\uFF1B\u53E6\u6709\u56FA\u5B9A\u9009\u9879\u300C\u8FD9\u4E9B\u90FD\u4E0D\u9002\u5408\u300D\u2192 \u81EA\u5B9A\u4E49\u7B54\u6848\uFF08index:-1, custom:true\uFF09\u3002\u8FD4\u56DE {status, value, reason?}\u3002",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string" },
        choices: { type: "array", items: { type: "string" }, description: "\u9009\u9879\u5217\u8868\uFF082-8 \u4E2A\uFF09" },
        multiple: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u591A\u9009\uFF08\u9ED8\u8BA4 false\uFF1Btrue \u65F6\u8FD4\u56DE indexes/labels\uFF09" },
        timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
        rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
        async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
        pageId: { type: "string" }
      }, required: ["prompt", "choices"] }
    },
    {
      name: "user_input",
      description: "\u5728 AI \u7A97\u53E3\u5185\u8BF7\u4EBA\u7C7B\u7528\u6237\u8F93\u5165\u4E00\u6BB5\u6587\u672C\uFF08\u5982\u671F\u671B\u6587\u6848\u3001\u914D\u7F6E\u503C\u3001\u573A\u666F\u63CF\u8FF0\uFF09\uFF0C\u56DE\u8F66/\u70B9\u51FB\u5373\u53D1\u9001\u3002\u8FD4\u56DE {status, value:{text}, reason?}\u3002",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string" },
        defaultValue: { type: "string", description: "\u9884\u586B\u9ED8\u8BA4\u503C\uFF08\u53EF\u9009\uFF09" },
        timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u64CD\u4F5C\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u81EA\u52A8\u8FD4\u56DE timeout" },
        rejectable: { type: "boolean", description: "\u662F\u5426\u5141\u8BB8\u7528\u6237\u62D2\u7EDD\uFF08\u9ED8\u8BA4 true\uFF09" },
        async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
        pageId: { type: "string" }
      }, required: ["prompt"] }
    },
    {
      name: "user_presence",
      description: "\u63A2\u6D4B\u4EBA\u7C7B\u7528\u6237\u662F\u5426\u5728\u573A/\u5728\u7EBF\uFF08AI \u9700\u8981\u7528\u6237\u914D\u5408\u957F\u4EFB\u52A1\u524D\u5148\u786E\u8BA4\uFF09\uFF0C\u7528\u6237\u70B9\u300C\u6211\u5728/\u7A0D\u540E\u300D\uFF0C\u53EF\u9644\u300C\u8865\u5145\u8BF4\u660E\u300D\uFF08value.comment\uFF09\u3002\u8FD4\u56DE {status, present, comment?}\uFF1B\u8D85\u65F6\u5373\u89C6\u4E3A\u4E0D\u5728\u7EBF\u3002",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "\u8BE2\u95EE\u6587\u6848\uFF08\u9ED8\u8BA4\u201C\u4F60\u5728\u5417\uFF1F\u9700\u8981\u4F60\u914D\u5408\u7EE7\u7EED\u5F00\u53D1\u201D\uFF09" },
        timeout: { type: "number", description: "\u53EF\u9009\u8D85\u65F6 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u6C38\u4E45\u7B49\u5F85\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u4F5C\u7B54\uFF1B\u4F20\u4E86\u624D\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\uFF08\u53EF\u6682\u505C\uFF09\uFF0C\u5230\u70B9\u8FD4\u56DE status:'timeout'\uFF08\u89C6\u4E3A\u4E0D\u5728\u7EBF\uFF09\u2014\u2014\u9700\u8981\u5FEB\u901F\u63A2\u6D4B\u5728\u573A/\u9650\u65F6\u7B49\u5F85\u65F6\u624D\u663E\u5F0F\u4F20" },
        async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
        pageId: { type: "string" }
      }, required: [] }
    },
    {
      name: "user_notify",
      description: "\u975E\u963B\u585E\u901A\u77E5\uFF1A\u901A\u8FC7\u6D4F\u89C8\u5668 Notification \u544A\u8BC9\u7528\u6237\u4E00\u6761\u6D88\u606F\uFF08\u5982\u201C\u4FEE\u590D\u5B8C\u6210\uFF0C\u8BF7\u5237\u65B0\u9A8C\u8BC1\u201D\uFF09\uFF0C\u4E0D\u7B49\u5F85\u56DE\u7B54\u3002\u8FD4\u56DE {notified:true}\u3002",
      inputSchema: { type: "object", properties: {
        title: { type: "string", description: "\u901A\u77E5\u6807\u9898" },
        body: { type: "string", description: "\u901A\u77E5\u5185\u5BB9" },
        timeout: { type: "number", description: "\u53EF\u9009\uFF1A\u901A\u77E5\u5361\u81EA\u52A8\u5173\u95ED\u65F6\u9650 ms\uFF085000-600000\uFF09\u3002\u4E0D\u4F20=\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u5173\u95ED" },
        async: { type: "boolean", description: "true=\u5F02\u6B65\uFF1A\u7ACB\u5373\u8FD4\u56DE\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF0C\u7528\u6237\u4F5C\u7B54\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u53D1\u9001\uFF1B\u7F3A\u7701=\u540C\u6B65\u7B49\u5F85" },
        pageId: { type: "string" }
      }, required: ["body"] }
    },
    // ---- 方案 G · P2：agent 接入 + 消息主通道 ----
    {
      name: "aiti_hello",
      description: "agent \u81EA\u6211\u4ECB\u7ECD/\u6CE8\u518C\uFF1A\u8986\u76D6 agentId\uFF08\u9ED8\u8BA4 clientInfo.name\uFF09\u4E0E sessionId\uFF08\u9ED8\u8BA4 Mcp-Session-Id \u6216\u6865\u968F\u673A\uFF09\u3001\u7ED1\u5B9A\u9ED8\u8BA4\u76EE\u6807\u9875 pageId\u3001\u8BA2\u9605\u9875\u9762\u4E8B\u4EF6\uFF08page_error\uFF09\u3002\u6CE8\u610F\uFF1Apage_log/page_network \u4E0D\u518D\u5B9E\u65F6\u63A8\u9001\uFF0C\u6539\u7528 page_logs/page_network \u5DE5\u5177\u6309\u9700\u62C9\u53D6\u3002\u5EFA\u8BAE\u4F1A\u8BDD\u5F00\u59CB\u65F6\u8C03\u7528\u4E00\u6B21\u2014\u2014\u6CE8\u518C\u540E\u6D88\u606F\u53EF\u5B9A\u5411\u5230\u672C\u4F1A\u8BDD\uFF08agentKey=agentId/sessionId\uFF09\u3002",
      inputSchema: { type: "object", properties: {
        agentId: { type: "string", description: "\u81EA\u5B9A\u4E49 agent \u6807\u8BC6\uFF08\u5982 pi / cc / qoder\uFF1B\u7F3A\u7701\u7528 clientInfo.name\uFF09" },
        sessionId: { type: "string", description: "\u672C\u5B9E\u4F8B\u4F1A\u8BDD\u6807\u8BC6\uFF08\u591A\u5B9E\u4F8B/\u591A\u4F1A\u8BDD\u65F6\u533A\u5206\uFF1B\u7F3A\u7701\u7528 Mcp-Session-Id\uFF0C\u65E0\u5219\u6865\u751F\u6210\u968F\u673A\uFF09" },
        name: { type: "string", description: "\u663E\u793A\u540D\uFF08\u53EF\u9009\uFF0C\u5982 'pi \xB7 \u5DE5\u4F5C\u533AA'\uFF09" },
        cwd: { type: "string", description: "\u5DE5\u4F5C\u76EE\u5F55\uFF08\u53EF\u9009\uFF0C\u663E\u793A CWD . name (id)\uFF0C\u65B9\u4FBF\u8BC6\u522B agent \u8EAB\u4EFD\uFF09" },
        pageId: { type: "string", description: "\u7ED1\u5B9A\u9ED8\u8BA4\u8C03\u8BD5\u76EE\u6807\u9875\uFF08pageId/url/title \u5747\u53EF\uFF0C\u7559\u7A7A\u4E0D\u7ED1\uFF09" },
        subEvents: { type: "array", items: { type: "string" }, description: "\u8BA2\u9605\u5B9E\u65F6\u4E8B\u4EF6\uFF1Apage_error\uFF08\u9ED8\u8BA4\u4E0D\u6295\u9012\uFF0C\u663E\u5F0F\u8BA2\u9605\u624D\u63A8\uFF1Bpage_log/page_network \u4E0D\u518D\u5B9E\u65F6\u63A8\u9001\uFF0C\u6539\u7528 page_logs/page_network \u5DE5\u5177\u6309\u9700\u62C9\u53D6\uFF09" }
      } }
    },
    {
      name: "file_stat",
      description: "\u67E5\u8BE2\u6587\u4EF6\u5B58\u5728\u6027/\u7C7B\u578B/\u5927\u5C0F/\u4FEE\u6539\u65F6\u95F4\uFF08\u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u7EC4\u4EF6\u6E90\u7801/\u8C03\u7528\u4F4D\u7F6E\u5B9A\u4F4D\u3001AI \u7A97\u300E\u540E\u7AEF\u6253\u5F00/\u524D\u7AEF\u6253\u5F00\u300F\u524D\u7F6E\u6821\u9A8C\u7528\uFF09\u3002\u4E0D\u5B58\u5728\u6216\u975E\u6CD5\u8DEF\u5F84\u8FD4\u56DE {exists:false}\u3002",
      inputSchema: { type: "object", properties: {
        path: { type: "string", description: "\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u5982 /home/user/src/App.vue\uFF09" }
      }, required: ["path"] }
    },
    {
      name: "aiti_inbox",
      description: "\u6D88\u606F\u4E3B\u901A\u9053\uFF1A\u62C9\u53D6\u53D1\u7ED9\u672C agent \u4F1A\u8BDD\u7684\u6D88\u606F\uFF08\u4EBA\u4E3B\u52A8\u53D1\u8BDD user_message / \u5F02\u6B65 user_* \u4F5C\u7B54 user_answer / \u8BA2\u9605\u7684\u9875\u9762\u4E8B\u4EF6\uFF09\u3002\u5F00\u59CB\u65B0\u4E00\u8F6E\u6216\u9700\u8981\u6700\u65B0\u4FE1\u606F\u65F6\u5148\u8C03\u7528\uFF1B\u5904\u7406\u5B8C\u628A\u6D88\u606F id \u653E ack \u53C2\u6570\u786E\u8BA4\uFF08\u6807\u8BB0 consumed\uFF0C\u5386\u53F2\u4FDD\u7559\uFF09\u3002\u8FD4\u56DE agentKey\uFF08agentId/sessionId\uFF09\uFF0C\u672A\u6CE8\u518C\u65F6\u63D0\u793A\u8C03 aiti_hello \u6CE8\u518C\u3002",
      inputSchema: { type: "object", properties: {
        agentId: { type: "string", description: "agent \u6807\u8BC6\uFF08\u7F3A\u7701\u7528 aiti_hello \u6CE8\u518C\u503C\u6216 clientInfo.name\uFF09" },
        sessionId: { type: "string", description: "\u672C\u5B9E\u4F8B\u4F1A\u8BDD\u6807\u8BC6\uFF08\u7F3A\u7701\u7528 Mcp-Session-Id \u6216 aiti_hello \u6CE8\u518C\u503C\uFF09" },
        ack: { description: "\u5DF2\u5904\u7406\u6D88\u606F id \u5217\u8868\uFF0C\u6216 { ids: [...], summary: '\u6267\u884C\u603B\u7ED3' }\u2014\u2014summary\uFF08\u5FC5\u5E26\uFF09\u4F1A\u4F5C\u4E3A agent \u5904\u7406\u8BB0\u5F55\u663E\u793A\u5728\u64CD\u4F5C\u53F0\u6D88\u606F\u6D41", oneOf: [{ type: "array", items: { type: "string" } }, { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, summary: { type: "string" } } }] }
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
    console.log(TAG + " \u2702 \u8BF7\u6C42\u5DF2\u53D6\u6D88\uFF1A" + requestId + " \xB7 " + reason);
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
          if (!label && isCE) label = String((f.getAttribute && (f.getAttribute('data-placeholder') || f.getAttribute('aria-label'))) || (f.innerText || '').trim()).slice(0, 40) || ('\u53EF\u7F16\u8F91\u533A\u57DF' + (n + 1));
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
      if (!dialog) return { foundDialog: false, filled: 0, missed: 0, clicked: false, error: '\u672A\u627E\u5230\u53EF\u89C1\u5F39\u7A97\uFF08\u5148\u7528 self_ui \u786E\u8BA4\u5F39\u7A97\u5DF2\u6253\u5F00\uFF09' };
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
  function execOnPage(cmd, args, pageId, signal, mcpReqId, cancelId) {
    const { instanceId, frameId } = parsePageId(pageId || LEGACY_TOKEN);
    const page = pages.get(instanceId);
    return new Promise((resolve) => {
      const requestId = "mcp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const rec = { resolve, agentId: null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
      pendingRequests.set(requestId, rec);
      if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
      if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
      rec.onAbort = () => cancelPending(requestId, "\u5DF2\u53D6\u6D88\uFF08agent \u505C\u6B62\uFF09");
      if (signal) {
        if (signal.aborted) {
          cancelPending(requestId, "\u5DF2\u53D6\u6D88\uFF08agent \u505C\u6B62\uFF09");
          return;
        }
        rec.signal = signal;
        signal.addEventListener("abort", rec.onAbort, { once: true });
      }
      console.log(TAG + " exec \u2192", cmd, JSON.stringify(args || {}), "\u2192 pageId=" + pageId);
      if (page) {
        if (!page.writer.write({ type: "exec", requestId, cmd, args: args || {}, frameId })) {
          const irec = idRegistry.get(instanceId);
          if (irec) irec.lastSeen = Date.now();
          pages.delete(instanceId);
          settlePending(requestId, false, { error: "\u9875\u9762\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF08\u91CD\u8FDE\u540E\u91CD\u8BD5\uFF09" });
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
            settlePending(requestId, false, { error: "\u76EE\u6807 AI \u4E3B\u7A97\u53E3\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF08\u5237\u65B0\u540E\u81EA\u52A8\u91CD\u8FDE\uFF09" });
            return;
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "self" });
        } else {
          setTimeout(() => settlePending(requestId, false, { error: "\u65E0\u6267\u884C\u7AEF\uFF08AI \u4E3B\u7A97\u53E3\u672A\u8FDE\u63A5\uFF09\uFF0C\u5148\u8FDE\u63A5\u6865" }), 100);
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
            settlePending(requestId, false, { error: "\u76EE\u6807 AI \u7A97\u8FDE\u63A5\u5DF2\u65AD\u5F00\uFF08\u9875\u9762\u5237\u65B0\u540E\u81EA\u52A8\u91CD\u8FDE\uFF0C\u7A0D\u540E\u91CD\u8BD5\uFF09" });
            return;
          }
        } else if (aiConns.size > 0) {
          for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai" });
        } else {
          setTimeout(() => settlePending(requestId, false, { error: "\u65E0\u6267\u884C\u7AEF\uFF08\u9875\u9762/AI \u901A\u9053\u5747\u672A\u8FDE\u63A5\uFF09\uFF0C\u5148\u8FDE\u63A5\u6865" }), 100);
          return;
        }
      } else if (aiConns.size > 0) {
        for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai" });
      } else {
        setTimeout(() => settlePending(requestId, false, { error: "\u65E0\u6267\u884C\u7AEF\uFF08\u9875\u9762/AI \u901A\u9053\u5747\u672A\u8FDE\u63A5\uFF09\uFF0C\u5148\u8FDE\u63A5\u6865" }), 100);
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
      setTimeout(() => settlePending(requestId, false, { error: "\u9875\u9762\u6267\u884C\u8D85\u65F6" + (SLOW_EXEC_CMDS.has(cmd) ? "\uFF08\u7528\u6237\u672A\u5B8C\u6210\u786E\u8BA4/\u9009\u62E9\uFF09" : "") }), slowNet);
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
    console.log(TAG + " interaction \u23F8 \u6682\u505C requestId=" + requestId + " remaining=" + st.remaining + "ms");
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
      const result = { status: "timeout", error: "\u7528\u6237\u65E0\u54CD\u5E94\uFF08\u4E0D\u5728\u7EBF\u6216\u672A\u5904\u7406\uFF09", tookMs: Date.now() - st.t0, timeoutMs: st.ms, pausedMs: st.pausedMs };
      if (settlePending(requestId, false, result)) {
        for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result });
      }
    };
    if (st.remaining <= 0) {
      fire();
      return { ok: true, paused: false, remainingMs: 0, timedOut: true };
    }
    st.timer = setTimeout(fire, st.remaining);
    console.log(TAG + " interaction \u25B6 \u7EE7\u7EED requestId=" + requestId + " remaining=" + st.remaining + "ms");
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
    return new Promise((resolve) => {
      const requestId = "ui_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      if (isAsync) {
        console.log(TAG + " interaction\uFF08\u5F02\u6B65\uFF09\u2192 kind=" + payload.kind + " \xB7 " + String(payload.prompt || "").slice(0, 60) + " \u2192 pageId=" + pageId + (payload.agentId ? " \xB7 agent=" + payload.agentId : ""));
        resolve({ ok: true, result: { status: "async", message: "\u5DF2\u5F02\u6B65\u53D1\u51FA\uFF1A\u7528\u6237\u4F5C\u7B54\u540E\u7ED3\u679C\u5C06\u8FDB\u53D1\u8D77 agent\uFF08" + (payload.agentId || "?") + "\uFF09\u7684 aiti_inbox" } });
      } else {
        const rec = { resolve, agentId: payload.agentId || null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
        pendingRequests.set(requestId, rec);
        if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
        if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
        rec.onAbort = () => cancelPending(requestId, "\u5DF2\u53D6\u6D88\uFF08agent \u505C\u6B62\uFF09");
        if (signal) {
          if (signal.aborted) {
            cancelPending(requestId, "\u5DF2\u53D6\u6D88\uFF08agent \u505C\u6B62\uFF09");
            return;
          }
          rec.signal = signal;
          signal.addEventListener("abort", rec.onAbort, { once: true });
        }
        console.log(TAG + " interaction \u2192 kind=" + payload.kind + " \xB7 " + String(payload.prompt || "").slice(0, 60) + " \u2192 pageId=" + pageId + " \xB7 timeout=" + (ms > 0 ? ms + "ms" : "\u221E\uFF08\u6C38\u4E45\u7B49\u5F85\uFF09") + (payload.agentId ? " \xB7 agent=" + payload.agentId : ""));
      }
      const noExecutor = () => {
        clearInteractionTimer(requestId);
        cancelPending(requestId, "\u65E0\u6267\u884C\u7AEF\uFF08\u9875\u9762/AI \u901A\u9053\u5747\u672A\u8FDE\u63A5\uFF09\uFF0C\u5148\u8FDE\u63A5\u6865");
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
        const st = { timer: null, deadline: Date.now() + ms, remaining: ms, paused: false, pausedAt: null, pausedMs: 0, ms, t0, resolve };
        interactionTimers.set(requestId, st);
        st.timer = setTimeout(() => {
          if (!interactionTimers.delete(requestId)) return;
          const result = { status: "timeout", error: "\u7528\u6237\u65E0\u54CD\u5E94\uFF08\u4E0D\u5728\u7EBF\u6216\u672A\u5904\u7406\uFF09", tookMs: Date.now() - t0, timeoutMs: ms, pausedMs: st.pausedMs };
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
            "aiti-devtools\uFF1A\u9875\u9762\u5185 AI \u8C03\u8BD5\u52A9\u624B\uFF08\u6D4F\u89C8\u5668\u6865\uFF09\u3002",
            "\u5DE5\u4F5C\u6D41\uFF1A\u9875\u9762\u53D1\u6765\u7684\u6D88\u606F\u901A\u5E38\u5E26 pageId\u3002\u6CA1\u6709\u4E5F\u53EF\u4EE5\u5148\u7528 bridge_status \u53D1\u73B0\u5DF2\u8FDE\u63A5\u9875\u9762\uFF08\u8FD4\u56DE sessions\uFF0C\u542B pageId/url/title/frameworks/device\u2014\u2014deviceLabel \u4E00\u884C\u7684\u6D4F\u89C8\u5668\xB7\u5C4F\u5E55\xB7\u5728\u7EBF\xB7\u8BED\u8A00\u53EF\u5FEB\u901F\u8BC6\u522B\u662F\u54EA\u53F0\u673A\u5668\u54EA\u4E2A\u6807\u7B7E\uFF09\u2192 \u628A pageId \u4F20\u7ED9\u76EE\u6807\u5DE5\u5177\u3002",
            "pageId \u683C\u5F0F\u4E3A instanceId/frameId\uFF08\u5982 3001/host\uFF09\uFF1B\u4E5F\u53EF\u76F4\u63A5\u4F20 url \u6216\u9875\u9762\u6807\u9898\uFF1B\u547D\u4E2D\u591A\u4E2A\u65F6\u9700\u5177\u4F53 pageId \u6307\u5B9A\u3002",
            "page_exec\uFF1A\u5728\u5DF2\u8FDE\u63A5\u9875\u9762\u6267\u884C\u7C7B CDP \u547D\u4EE4\uFF08DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser \u57DF\uFF09\u3002args \u4E3A\u547D\u4EE4\u53C2\u6570\u5BF9\u8C61\u3002\u5371\u9669\u547D\u4EE4\uFF08\u5BFC\u822A/\u4E0B\u8F7D/\u5BF9\u8BDD\u6846\u7B49\uFF09\u4F1A\u81EA\u52A8\u5F39\u7528\u6237\u786E\u8BA4\u3002\u622A\u5C4F\uFF08Page.captureScreenshot\uFF09\u52A1\u5FC5\u5728 args \u5E26 reason\uFF08\u4E00\u53E5\u8BDD\u5411\u7528\u6237\u8BF4\u660E\u60F3\u622A\u4EC0\u4E48\uFF0C\u9875\u9762\u4F1A\u5148\u5F39\u51C6\u5907\u5361\u5C55\u793A\u8BE5\u8BF4\u660E\u3001\u7528\u6237\u8C03\u6574\u597D\u9875\u9762\u624D\u5F00\u59CB\u622A\u5C4F\uFF09\u3002",
            "page_snapshot\uFF1A\u62C9\u53D6\u76EE\u6807\u9875\u9762\u57FA\u7840\u73B0\u573A\uFF08URL/\u9009\u533A/\u6A21\u62DF\u6761\u4EF6\uFF09\u3002",
            "page_logs / page_network\uFF1A\u6392\u67E5\u9875\u9762\u62A5\u9519/\u8BF7\u6C42\u5931\u8D25\u9996\u9009\u2014\u2014page_logs \u67E5 console\uFF08\u53EF level/since/limit \u8FC7\u6EE4\uFF0C\u5148\u770B warn/error\uFF09\uFF1Bpage_network \u67E5 ajax/fetch \u5B8C\u6210\u6001\uFF08status\u2265400 \u6216 errorOnly:true \u53EA\u770B\u5931\u8D25\uFF09\u3002\u4E24\u8005\u5747\u8BFB\u9875\u9762\u672C\u5730\u7F13\u51B2\uFF08CDP Runtime.evaluate \u6309\u9700\u62C9\u53D6\uFF0C\u4E0D\u518D\u5B9E\u65F6\u4E0A\u62A5\uFF09\u3002",
            "user_confirm / user_choose / user_input / user_pick_element / user_presence\uFF1AAI \u4E0E\u4EBA\u7C7B\u7528\u6237\u5728\u9875\u9762\u4E0A\u534F\u4F5C\u2014\u2014prompt \u7ED9\u7528\u6237\u770B\uFF0C\u9ED8\u8BA4\u540C\u6B65\u7B49\u5F85\u4E14\u6C38\u4E45\u7B49\u5F85\uFF08\u4E0D\u4F20 timeout\uFF1A\u9762\u677F\u5E38\u9A7B\u76F4\u5230\u7528\u6237\u4F5C\u7B54\uFF0C\u65E0\u8BFB\u79D2\uFF1B\u4EC5\u5728\u786E\u9700\u9650\u65F6\u50AC\u4FC3\u65F6\u4F20 timeout ms\uFF0C\u9762\u677F\u663E\u793A\u8BFB\u79D2\u5012\u8BA1\u65F6\u53EF\u6682\u505C\uFF0C\u5230\u70B9\u8FD4\u56DE status:'timeout'\uFF09\uFF0C\u54CD\u5E94\u4FE1\u5C01 {status:'answered'|'rejected'|'timeout'|'error', value?, reason?, tookMs, timeoutMs}\u3002\u4F20 async:true \u53EF\u7ACB\u5373\u8FD4\u56DE\uFF08\u7ED3\u679C\u7ECF AI \u6D88\u606F\u7A97\u9001\u8FBE\uFF09\u3002",
            "user_notify\uFF1A\u975E\u963B\u585E\u6D4F\u89C8\u5668\u901A\u77E5\uFF0C\u4E0D\u7B49\u5F85\u56DE\u7B54\u3002",
            "\u5E38\u89C1\u7528\u6CD5\uFF1A\u9875\u9762\u62A5\u9519\u2192page_logs(level:warn/error) \u6216 page_network(errorOnly:true)\uFF1B\u64CD\u4F5C\u9875\u9762\u2192page_exec(cmd:'Runtime.evaluate', args:{expression:'...'})\uFF1B\u5B9A\u4F4D\u5143\u7D20\u2192page_snapshot \u540E\u518D page_exec \u6216\u8BF7\u7528\u6237 user_pick_element\u3002"
          ].join("\n")
        };
      case "notifications/initialized":
        return null;
      case "notifications/cancelled": {
        const rid = params && params.requestId !== void 0 ? String(params.requestId) : "";
        if (rid) {
          const internalId = mcpReqMap.get(rid);
          if (internalId) cancelPending(internalId, "\u5DF2\u53D6\u6D88\uFF08MCP notifications/cancelled\uFF09");
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
          recToolCall("\u{1F6E0} bridge_status \u2192 " + sess.length + " \u4E2A\u5DF2\u8FDE\u63A5\u9875\u9762" + (boundPageId ? " \xB7 \u5F53\u524D\u7ED1\u5B9A: " + boundPageId : ""), true, resp);
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
          recToolCall("\u{1F6E0} file_stat(" + (fp || "") + ") \u2192 " + (out.exists ? out.isFile ? "\u6587\u4EF6 " + out.size + "B" : "\u76EE\u5F55" : "\u4E0D\u5B58\u5728"), out.exists);
          return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
        }
        if (params.name === "page_logs" || params.name === "page_network") {
          const isLog = params.name === "page_logs";
          const ringExpr = isLog ? "(() => { try { var r = window.__dbg && window.__dbg.__consoleRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 200) + "); } catch(e) { return []; } })()" : "(() => { try { var r = window.__dbg && window.__dbg.__netRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 100) + "); } catch(e) { return []; } })()";
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) {
            recToolCall("\u{1F6E0} " + params.name + " \u2192 \u26A0 \u9875\u9762\u5339\u914D\u591A\u4E2A", false);
            return { content: [{ type: "text", text: "\u9875\u9762\u5339\u914D\u591A\u4E2A\uFF08\u6309 url/title\uFF09\uFF1A" + resolved.multiple.join(", ") + "\u2014\u2014\u8BF7\u7528\u5177\u4F53 pageId \u6307\u5B9A" }], isError: true };
          }
          if (resolved.notFound) {
            recToolCall("\u{1F6E0} " + params.name + " \u2192 \u26A0 \u672A\u627E\u5230\u5339\u914D\u9875\u9762", false);
            return { content: [{ type: "text", text: "\u672A\u627E\u5230\u5339\u914D\u9875\u9762\uFF08pageId/url/title \u5747\u672A\u547D\u4E2D\uFF09\u2014\u2014\u7528 bridge_status \u67E5\u770B\u53EF\u7528 pageId" }], isError: true };
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
            recToolCall("\u{1F6E0} " + params.name + "(" + resolved.pageId + ") \u2192 " + rows.length + " \u6761", true, out);
            return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
          });
        }
        if (params.name === "page_exec" || params.name === "page_snapshot") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) {
            recToolCall("\u{1F6E0} " + params.name + " \u2192 \u26A0 \u9875\u9762\u5339\u914D\u591A\u4E2A\uFF1A" + resolved.multiple.join(", "), false);
            return { content: [{ type: "text", text: "\u9875\u9762\u5339\u914D\u591A\u4E2A\uFF08\u6309 url/title\uFF09\uFF1A" + resolved.multiple.join(", ") + "\u2014\u2014\u8BF7\u7528\u5177\u4F53 pageId \u6307\u5B9A\uFF08bridge_status \u53EF\u67E5\uFF09" }], isError: true };
          }
          if (resolved.notFound) {
            recToolCall("\u{1F6E0} " + params.name + (pageId ? "(" + pageId + ")" : "") + " \u2192 \u26A0 \u672A\u627E\u5230\u5339\u914D\u9875\u9762", false);
            return { content: [{ type: "text", text: "\u672A\u627E\u5230\u5339\u914D\u9875\u9762\uFF08pageId/url/title \u5747\u672A\u547D\u4E2D\uFF09\u2014\u2014\u7528 bridge_status \u67E5\u770B\u53EF\u7528 pageId" }], isError: true };
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
            recToolCall("\u{1F6E0} " + params.name + "(" + resolved.pageId + ")" + (params.name === "page_exec" && cmd ? " \xB7 " + String(cmd).slice(0, 80) : "") + " \u2192 " + (r.ok ? "ok" : "\u5931\u8D25"), !!r.ok, { tool: params.name, request: params.name === "page_exec" ? { cmd, args: cmdArgs } : { pageId: resolved.pageId }, response: r.result || r, at: (/* @__PURE__ */ new Date()).toISOString() });
            return { content: [{ type: "text", text: JSON.stringify(r.result || r) }], isError: !r.ok };
          });
        }
        if (params.name === "self_ui") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) {
            recToolCall("\u{1F6E0} self_ui \u2192 \u672A\u627E\u5230\u76EE\u6807\u9875\u9762\uFF08\u65E0 AI \u4E3B\u7A97\u53E3\u8FDE\u63A5\u6216 pageId \u672A\u547D\u4E2D\uFF09", false);
            return { content: [{ type: "text", text: "\u672A\u627E\u5230\u76EE\u6807\u9875\u9762\u2014\u2014\u9700 AI \u4E3B\u7A97\u53E3\u5DF2\u8FDE\u63A5\uFF08bridge_status \u53EF\u89C1 xxx/ai\uFF09\uFF0C\u6216\u6307\u5B9A pageId" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          return execOnPage("Runtime.evaluate", { expression: SELF_UI_SCAN }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const val = r.ok && r.result && r.result.value !== void 0 ? r.result.value : r.result || r;
            recToolCall("\u{1F6E0} self_ui(" + resolved.pageId + ") \u2192 " + (r.ok ? val && val.dialogs ? val.dialogs.length + " \u4E2A\u5F39\u7A97" : "\u65E0\u5F39\u7A97" : "\u5931\u8D25"), !!r.ok, { tool: "self_ui", pageId: resolved.pageId, response: val });
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        if (params.name === "form_fill") {
          const target = pageId && String(pageId) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) {
            recToolCall("\u{1F6E0} form_fill \u2192 \u672A\u627E\u5230\u76EE\u6807\u9875\u9762", false);
            return { content: [{ type: "text", text: "\u672A\u627E\u5230\u76EE\u6807\u9875\u9762\u2014\u2014\u9700 AI \u4E3B\u7A97\u53E3\u5DF2\u8FDE\u63A5\uFF0C\u6216\u6307\u5B9A pageId" }], isError: true };
          }
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const opts2 = { dialog: a.dialog || null, fields: a.fields || [], button: a.button || null };
          const expression = "(" + FORM_FILL_FN + ")(" + JSON.stringify(opts2) + ")";
          return execOnPage("Runtime.evaluate", { expression }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const val = r.ok && r.result && r.result.value !== void 0 ? r.result.value : r.result || r;
            recToolCall("\u{1F6E0} form_fill(" + resolved.pageId + ") \u2192 " + (r.ok ? val && val.foundDialog ? "\u586B " + val.filled + " \u5B57\u6BB5" + (val.clicked ? "\uFF0C\u70B9\u6309\u94AE" : "") : "\u672A\u627E\u5230\u5F39\u7A97" : "\u5931\u8D25"), !!r.ok, { tool: "form_fill", pageId: resolved.pageId, response: val });
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        const interact = (interaction, timeout) => {
          const mcpReqId = req && req.id !== void 0 ? String(req.id) : null;
          const targetPageId = pageId || boundPageIdFor(session) || void 0;
          return interactOnPage({ ...interaction, agentId: session && session.agentKey || session && session.agentId || a.agentId || null }, targetPageId, timeout, signal, mcpReqId, cancelId).then((r) => {
            recToolCall("\u{1F6E0} " + interaction.kind + " \u2192 " + (r.ok ? "\u5DF2\u4F5C\u7B54" : r.result && r.result.status || "\u5931\u8D25/\u62D2\u7EDD"), !!r.ok);
            return { content: [{ type: "text", text: JSON.stringify(r.result || r) }], isError: !r.ok };
          });
        };
        if (params.name === "user_pick_element") {
          return interact({ kind: "pick_element", prompt: String(a.prompt || "\u8BF7\u70B9\u51FB\u9875\u9762\u4E0A\u7684\u4E00\u4E2A\u5143\u7D20\uFF08AI \u9700\u8981\u4F60\u5E2E\u5FD9\u5B9A\u4F4D\uFF09"), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_confirm") {
          return interact({ kind: "confirm", prompt: String(a.prompt || "\u8BF7\u786E\u8BA4"), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_choose") {
          const choices = Array.isArray(a.choices) && a.choices.length ? a.choices.map(String).slice(0, 8) : ["\u9009\u9879 A", "\u9009\u9879 B"];
          return interact({ kind: "choose", prompt: String(a.prompt || "\u8BF7\u9009\u62E9\u4E00\u9879"), choices, multiple: !!a.multiple, rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_input") {
          return interact({ kind: "input", prompt: String(a.prompt || "\u8BF7\u8F93\u5165"), defaultValue: String(a.defaultValue || ""), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_presence") {
          return interact({ kind: "presence", prompt: String(a.prompt || "\u4F60\u5728\u5417\uFF1F\u9700\u8981\u4F60\u914D\u5408\u7EE7\u7EED\u5F00\u53D1"), rejectable: false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_notify") {
          const notif = { kind: "notify", title: String(a.title || "\u{1F916} AI \u6709\u4E00\u6761\u6D88\u606F"), body: String(a.body || a.prompt || ""), timeoutMs: clampTimeout(a.timeout) };
          const rid = "notify_" + Date.now();
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
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "agent \u6CE8\u518C\u5931\u8D25" }) }], isError: true };
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
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown agent\uFF1A\u5148 aiti_hello \u6216\u5E26 agentId/sessionId" }) }], isError: true };
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
              const text = summary || `\u2705 \u5DF2\u5904\u7406 ${ackIds.length} \u6761\u6D88\u606F\uFF08\u672A\u9644\u603B\u7ED3\u2014\u2014\u5EFA\u8BAE ack \u65F6\u5E26 summary\uFF09`;
              const rid = randomBytes(4).toString("hex");
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
              appendMsgEvent(key, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: m.id, status: "delivered", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
            }
            out.push({ id: m.id, kind: m.kind, from: m.from, agentKey: key, agentId, sessionId: agent.sessionId, pageId: m.pageId || m.payload && m.payload.pageId || null, url: m.url || m.payload && m.payload.url || null, text: m.text ?? null, payload: m.payload || null, at: m.at, status: m.status });
          }
          for (const w of aiConns) w.write({ type: "event", from: "agent", event: "inbox_status", payload: { agentKey: key, queueSize: agent.outbox.filter((x) => x.status !== "consumed").length } });
          const guide = agent.registered ? "" : " \u26A0 \u672A\u663E\u5F0F\u6CE8\u518C\uFF08\u968F\u673A session\uFF09\u2014\u2014\u5EFA\u8BAE\u8C03 aiti_hello \u4F20 agentId/sessionId \u6CE8\u518C\uFF0C\u6D88\u606F\u5C06\u7ED1\u5B9A\u5230\u8BE5\u4F1A\u8BDD";
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
    return new Promise((resolve) => {
      if (!file) return resolve({ ok: false, error: "\u7F3A\u5C11 file" });
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
          return resolve({ ok: false, error: "\u65E0\u684C\u9762\u4F1A\u8BDD\uFF08systemd/\u65E0\u5934\u670D\u52A1\uFF09\u2014\u2014\u540E\u7AEF\u6253\u5F00\u4E0D\u53EF\u7528\uFF1A\u8BF7\u7528\u300C\u524D\u7AEF\u6253\u5F00\u300D\uFF08pi-web \u6587\u4EF6\u6807\u7B7E\u9875\u5728\u7EBF\u67E5\u770B\uFF09\u6216\u8BBE\u7F6E AITI_OPEN_CMD \u6307\u5B9A\u6253\u5F00\u547D\u4EE4\uFF08\u5982 ssh \u56DE\u672C\u5730\u7F16\u8F91\u5668\uFF09" });
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
          return finish({ ok: false, error: "\u7F16\u8F91\u5668\u4E0E\u7CFB\u7EDF\u9ED8\u8BA4\u6253\u5F00\u5668\u5747\u4E0D\u53EF\u7528\uFF08\u65E0\u684C\u9762\u4F1A\u8BDD\uFF09\u2014\u2014\u8BF7\u914D\u7F6E AITI_OPEN_CMD \u6216\u4F7F\u7528\u524D\u7AEF\u6253\u5F00" });
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
      console.log(TAG + " claim \u2192 instanceId=" + r.instanceId + (reused ? "\uFF08\u590D\u7528\uFF09" : "\uFF08\u65B0" + (portPref ? " \u7AEF\u53E3\u504F\u597D=" + portPref : "") + "\uFF09"));
      return json({ ok: true, instanceId: r.instanceId, secret: r.secret });
    }
    if (endpoint === "bridge" && sub === "sessions" && req.method === "GET") return json(listSessions());
    if (endpoint === "bridge" && sub === "ai" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.pageId) return json({ ok: false, error: "\u7F3A\u5C11 instanceId/pageId" }, 400);
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
      console.log(TAG + " AI \u5BBF\u4E3B\u9875\u6CE8\u518C\uFF1A" + msg.pageId + " \xB7 " + (msg.title || "") + (fr && fr.length ? " \xB7 frames=" + fr.length : "") + (msg.device ? " \xB7 " + (msg.deviceLabel || msg.device.browser) : ""));
      return json({ ok: true, pageId: msg.pageId });
    }
    if (endpoint === "bridge" && sub === "self" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId) return json({ ok: false, error: "\u7F3A\u5C11 instanceId" }, 400);
      let hit = null;
      for (const [w, rec] of aiSelfReg) if (rec.instanceId === String(msg.instanceId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai conn\uFF1A" + msg.instanceId }, 404);
      const prev = aiSelfReg.get(hit) || {};
      aiSelfReg.set(hit, { instanceId: String(msg.instanceId), url: msg.url || prev.url || null, title: msg.title || prev.title || null, device: msg.device && typeof msg.device === "object" ? msg.device : prev.device || null, deviceLabel: msg.deviceLabel || prev.deviceLabel || null, lastSeen: Date.now() });
      bindAgentFromAiSelf(aiSelfReg.get(hit));
      console.log(TAG + " AI \u4E3B\u7A97\u53E3 self \u6CE8\u518C\uFF1A" + msg.instanceId + "/ai \xB7 " + (msg.title || "") + (msg.device ? " \xB7 " + (msg.deviceLabel || msg.device.browser) : ""));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }
    if (endpoint === "bridge" && sub === "self" && path[2] === "active" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.sessionId) return json({ ok: false, error: "\u7F3A\u5C11 instanceId/sessionId" }, 400);
      bindAgentFromActive(String(msg.instanceId), String(msg.sessionId));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }
    if (endpoint === "bridge" && sub === "ai" && path[2] === "frames" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.pageId || !Array.isArray(msg.frames)) return json({ ok: false, error: "bad request\uFF08\u9700\u8981 pageId/frames\uFF09" }, 400);
      let hit = null;
      for (const [w, rec2] of aiPageReg) if (rec2.pageId === String(msg.pageId)) {
        hit = w;
        break;
      }
      if (!hit) return json({ ok: false, error: "no such ai host page\uFF1A" + msg.pageId }, 404);
      const rec = aiPageReg.get(hit);
      rec.frames = msg.frames;
      rec.lastSeen = Date.now();
      console.log(TAG + " AI \u5BBF\u4E3B\u5E27\u6811\u66F4\u65B0\uFF1A" + msg.pageId + " frames=" + msg.frames.length);
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
      if (!msg || !msg.tool) return json({ ok: false, error: "bad request\uFF08\u9700\u8981 tool\uFF09" }, 400);
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
      if (!msg || !msg.agentId) return json({ ok: false, error: "bad request\uFF08\u9700\u8981 agentId\uFF09" }, 400);
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
      console.log(TAG + " agent SSE \u5DF2\u5EFA\u7ACB\uFF1A" + resolvedKey + "\uFF08P3 \u63A8\u9001\u901A\u9053\uFF09");
      return response;
    }
    if (endpoint === "bridge" && sub === "agent" && path[2] === "answer" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.agentKey || !msg.text) return json({ ok: false, error: "bad request\uFF08\u9700\u8981 agentKey/text\uFF09" }, 400);
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
      console.log(TAG + " agent \u56DE\u7B54 \u2192 " + resolvedKey + " \xB7 " + String(m.text).slice(0, 80) + "\uFF08\u5DF2\u6D88\u8D39\u5F85\u5904\u7406\u6D88\u606F " + a.outbox.filter((x) => x.status === "consumed").length + " \u6761\uFF09");
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
        console.log(TAG + " AI \u63A7\u5236\u53F0\u5DF2\u8FDE\u63A5\uFF1AinstanceId=" + instanceId);
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
        console.log(TAG + " \u9875\u9762\u5DF2\u8FDE\u63A5\uFF1AinstanceId=" + instanceId + " frame=" + initialFrame);
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
        console.log(TAG + " AI \u63A7\u5236\u53F0\u5DF2\u8FDE\u63A5\uFF08\u603B\u7EBF\uFF09\uFF1AinstanceId=" + instanceId);
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
        console.log(TAG + " \u9875\u9762\u5DF2\u8FDE\u63A5\uFF08\u603B\u7EBF\uFF09\uFF1AinstanceId=" + instanceId);
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
          msg.result = { file, width: r0.width, height: r0.height, format: r0.format, bytes: r0.bytes || 0, note: "\u622A\u5C4F\u5DF2\u5B58\u6587\u4EF6\uFF08dataUrl \u8FC7\u5927\u4E0D\u5185\u8054\uFF09\uFF1B\u524D\u7AEF\u6587\u4EF6\u6807\u7B7E\u9875\u53EF\u76F4\u63A5\u6253\u5F00\u67E5\u770B" };
          console.log(TAG + " \u622A\u5C4F\u843D\u76D8\uFF1A" + file + "\uFF08" + Math.round((r0.bytes || 0) / 1024) + "KB\uFF09");
        }
      } catch (e) {
        console.warn(TAG + " \u622A\u5C4F\u843D\u76D8\u5931\u8D25\uFF08\u9000\u56DE\u5185\u8054\uFF09:", e.message);
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
        console.log(TAG + " \u2190 \u7ED3\u679C\u56DE\u4F20 ok=" + msg.ok + (r.agentId ? " \u2192 agent=" + r.agentId : ""));
        if (r.agentId && msg.ok) deliverUserAnswer(r.agentId, msg.result);
      } else {
        console.log(TAG + " \u26A0 \u7ED3\u679C\u56DE\u4F20\u4F46\u65E0 pending\uFF1A" + msg.requestId);
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
      return json({ ok: cancelPending(internalId, "\u5DF2\u53D6\u6D88\uFF08\u5BA2\u6237\u7AEF\u8BF7\u6C42\uFF09"), cancelled: true });
    }
    if (endpoint === "bridge" && sub === "push" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.text) return json({ ok: false, error: "bad request\uFF08\u9700\u8981 text\uFF09" }, 400);
      return json(pushToAgents(msg.to, String(msg.text), msg.kind || "user_message", msg.payload || {}, msg.ref || null));
    }
    if (endpoint === "bridge" && sub === "picked" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const list = msg && Array.isArray(msg.candidates) ? msg.candidates : null;
      if (!list) return json({ ok: false, error: "bad request\uFF08\u9700\u8981 candidates \u6570\u7EC4\uFF09" }, 400);
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
      if (!msg || !msg.event) return json({ ok: false, error: "bad request\uFF08\u9700\u8981 event\uFF09" }, 400);
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
        console.log(TAG + " page_error \u4E8B\u4EF6 \u2192 \u8BA2\u9605\u5206\u53D1\uFF08type=" + msg.type + " payload=" + JSON.stringify(msg.payload || {}).slice(0, 120) + "\uFF09");
      }
      if (msg.type === "page_log" || msg.type === "page_network") {
        return json({ ok: false, error: "page_log/page_network \u4E0D\u518D\u5B9E\u65F6\u4E0A\u62A5\uFF1B\u8BF7\u7528 page_logs/page_network \u5DE5\u5177\u6309\u9700\u62C9\u53D6" }, 410);
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
        console.log(TAG + " streamable GET \u6D41\u5DF2\u5EFA\u7ACB session=" + sid2.slice(0, 8) + " agent=" + (session2.agentId || "?"));
        writer.write({ jsonrpc: "2.0", method: "notifications/initialized" });
        return response;
      }
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      if (msg.id !== void 0 && !msg.method && pendingSampling.has(String(msg.id))) {
        const p = pendingSampling.get(String(msg.id));
        const ok = !(msg.error || msg.result && msg.result.isError);
        p.done(ok, msg.error ? { error: String(msg.error.message || msg.error.code || "sampling \u62D2\u7EDD") } : msg.result || {});
        console.log(TAG + " sampling \u54CD\u5E94\u56DE\u4F20 id=" + String(msg.id).slice(0, 12) + " agent=" + p.agentId + " ok=" + ok);
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
  const registerAgent = (key, opts2 = {}) => {
    const k = String(key || "");
    if (!k) return { ok: false, error: "bad key" };
    if (!agents.has(k)) {
      agents.set(k, { agentId: k, sessionId: opts2.id || k, registered: true, name: opts2.name || k, cwd: opts2.cwd || null, offlineAt: null, conn: 0, transportKind: "inprocess", source: opts2.source || "extension", capabilities: opts2.capabilities || {}, stream: null, boundPageId: opts2.pageId || null, activeBoundPageId: null, subEvents: new Set(opts2.subEvents || []), outbox: [], lastSeen: Date.now(), agentStream: null, inProcessSink: null });
    }
    const a = agents.get(k);
    a.lastSeen = Date.now();
    if (opts2.pageId) a.boundPageId = String(opts2.pageId);
    if (Array.isArray(opts2.subEvents)) a.subEvents = new Set(opts2.subEvents.map(String));
    if (!a.boundPageId && !a.activeBoundPageId) {
      const agSid = a.sessionId || String(k).split("/").slice(1).join("/");
      if (agSid) {
        for (const [, rec] of aiSelfReg) {
          const m = String(rec.url || "").match(/[?&]session=([^&#]+)/);
          if (!m) continue;
          const sid = decodeURIComponent(m[1]);
          if (sid === agSid) {
            a.boundPageId = String(rec.instanceId) + "/ai";
            break;
          }
        }
      }
    }
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
  return { handle, sessions: () => listSessions(), tools: () => TOOLS, callTool, registerAgent, bindAgentPage, setAgentSink, answer, clearAgent, pushAiEvent, close };
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
      const url = `http://${host}:${port}`;
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
function normalizeBridgeUrl(raw, prefix) {
  const notes = [];
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { origin: raw, notes: ["\u5730\u5740\u65E0\u6CD5\u89E3\u6790\uFF0C\u6309\u539F\u6837\u4F7F\u7528\uFF1A" + raw] };
  }
  let path = u.pathname.replace(/\/+$/, "") || "/";
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of MCP_PATH_SUFFIXES) {
      if (path.endsWith(suf)) {
        notes.push(`\u5265\u79BB\u8DEF\u5F84\u540E\u7F00 "${suf}"`);
        path = path.slice(0, -suf.length) || "/";
        changed = true;
        break;
      }
    }
    if (!changed && prefix && prefix !== "/" && path.endsWith(prefix)) {
      notes.push(`\u5265\u79BB\u524D\u7F00 "${prefix}"`);
      path = path.slice(0, -prefix.length) || "/";
      changed = true;
    }
  }
  if (path && path !== "/") notes.push(`\u5FFD\u7565\u591A\u4F59\u8DEF\u5F84 "${path}"\uFF08\u6309 origin ${u.origin} \u5904\u7406\uFF09`);
  return { origin: u.origin, notes };
}
function hasBridgePathSignature(raw) {
  try {
    const p = new URL(raw).pathname;
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
      if (!hasBridgePathSignature(input.bridgeUrl)) notes.push("\u8F93\u5165\u5730\u5740\u672A\u5E26\u6865\u8DEF\u5F84\u7279\u5F81\uFF08/aiti /bridge /mcp\uFF09\uFF0C\u6309\u6865\u5730\u5740\u5904\u7406\u2014\u2014\u82E5\u8FD9\u662F aiti-agent\uFF08AI \u7A97\uFF09\u5730\u5740\u8BF7\u6539\u7528 aiUrl \u53C2\u6570");
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
      return { cfg: null, error: "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + String(e?.message || e) };
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
function patchFile(path, key, serverName, url, dryRun, log, keyPath, httpEntry) {
  if (!existsSync2(path)) return { changed: false, error: "\u6587\u4EF6\u4E0D\u5B58\u5728" };
  const r = readJson(path);
  if (r.error) return { changed: false, error: "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + r.error };
  let cfg = r.cfg;
  if (!isPlainContainer(cfg)) return { changed: false, error: "\u914D\u7F6E\u4E0D\u662F\u5BF9\u8C61" };
  const map = keyPath ? resolveContainer(cfg, keyPath) : (() => {
    const det = detectStructureKey(cfg);
    if (det.inferred) log(`  \u26A0 ${path}\uFF1A\u672A\u8BC6\u522B\u7ED3\u6784\uFF08\u65E0 mcpServers/servers/mcp \u5B57\u6BB5\uFF09\uFF0C\u6309 mcpServers \u5199\u5165`);
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
        return { changed: false, error: "\u5199\u5165\u5931\u8D25\uFF1A" + String(e?.message || e) };
      }
    }
    return { changed: true };
  }
  if (prevUrl === url) return { changed: false };
  map[serverName] = { ...entry || {}, ...httpEntry ? httpEntry(url) : { type: "http", url } };
  if (!dryRun) {
    try {
      writeAtomic(path, cfg);
    } catch (e) {
      return { changed: false, error: "\u5199\u5165\u5931\u8D25\uFF1A" + String(e?.message || e) };
    }
  }
  return { changed: true };
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
      results.push({ target: w.target, path: w.path, changed: r.changed });
      if (r.changed) changed = true;
      if (!w.exists) log(`  \u2713 ${w.target} \u2192 ${w.path}\uFF08\u65B0\u5EFA\uFF09`);
      else log(`  ${r.changed ? "\u2713" : "\xB7"} ${w.target} \u2192 ${w.path}${r.changed ? "" : "\uFF08\u5DF2\u662F\u6700\u65B0\uFF09"}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}MCP ${serverName} \u2192 ${opts.url}${results.length ? "\uFF1B" + results.map((r) => r.error ? r.target + " \u2717" : r.changed ? r.target + " \u2713" : r.target + " \xB7").join(" ") : "\uFF08\u65E0\u76EE\u6807\u6587\u4EF6\uFF09"}`;
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
        if (existsSync2(p)) files.set(p, f.keyPath);
      }
    }
  }
  for (const [p, keyPath] of files) {
    if (!existsSync2(p)) continue;
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
      if (!existsSync2(w.path)) {
        cfg = {};
      } else {
        const r = readJson(w.path);
        if (r.error) return { changed: false, error: "JSON \u89E3\u6790\u5931\u8D25\uFF1A" + r.error };
        cfg = r.cfg;
      }
      if (!isPlainContainer(cfg)) return { changed: false, error: "\u914D\u7F6E\u4E0D\u662F\u5BF9\u8C61" };
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
          return { changed: false, error: "\u5199\u5165\u5931\u8D25\uFF1A" + String(e?.message || e) };
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
  const files = planned.filter((w) => existsSync2(w.path));
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
    process.env.AITI_WEB_ROOT && join2(process.env.AITI_WEB_ROOT, "node_modules"),
    join2(homeDir(), ".pi", "web", "node_modules"),
    join2(homeDir(), ".pi", "web-dev", "node_modules")
  ].filter((p) => !!p).map((nm) => join2(nm, "@aiti-ai", "aiti-bridge", "bin", "aiti-mcp-shim.cjs"));
  const candidates = [
    process.env.AITI_SHIM_PATH,
    ...installedCandidates,
    ...cwdCandidates || [],
    join2(homeDir(), "workspace", "aiti-ai", "packages", "aiti-bridge", "bin", "aiti-mcp-shim.cjs")
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
import { join as join3 } from "node:path";
var ASSET_NAMES = ["aiti-launcher.js", "bridge-client.js", "cockpit.html", "aiwin.js", "host-protocol.js"];
function loadAssets(assetsDir) {
  const dir = assetsDir || new URL("../assets/", import.meta.url).pathname;
  const out = {};
  for (const name of ASSET_NAMES) {
    try {
      const content = readFileSync3(join3(dir, name), "utf8");
      const type = name.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8";
      out["/" + name] = { type, content };
    } catch (e) {
      console.warn(`[aiti-devtools] \u26A0 \u8D44\u4EA7\u7F3A\u5931\uFF1A${join3(dir, name)}\uFF08${e.message}\uFF09\u2014\u2014\u5148\u8DD1 packages/aiti-devtools-core/tools/build-assets.mjs \u6216\u4F20 assetsDir`);
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
  const sym = Symbol.for("aiti-devtools.process-patched");
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
  MCP_TARGETS,
  ORPHAN_NOTICE,
  PLACEHOLDER_RE,
  aitiMiddleware,
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
