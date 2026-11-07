/**
 * aiti-devtools 扩展 · 桥逻辑（从 dbg-mcp-server.cjs 移植，HTTP 层适配 Next route handler）
 *
 * 会话体系（方案 D）：pageId = instanceId/frameId
 *   - claim：连接登记/复用（secret 认证 + 端口偏好：纯数字=端口，字母前缀=随机）
 *   - sessions：发现（按 frame 展开）
 *   - register：iframe 动态补报 frameId
 *   - sse：持久连接（instanceId+secret 校验；role=page|ai）
 *   - result/event：pageId 校验 + 全局 pendingRequests
 *   - mcp：JSON-RPC（tools/list / tools/call page_exec/page_snapshot/bridge_status）
 */
import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readdirSync, readFileSync, existsSync, statSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

const ID_TTL = parseInt(process.env.AITI_BRIDGE_TTL || "600000", 10); // 断开后保留（ms）
// ---- agent 会话治理：历史 agent 清理 / 群发排除 / 显示用 CWD ----
const AGENT_TTL = parseInt(process.env.AITI_AGENT_TTL || "3600000", 10); // agent 掉线后内存保留（默认 1h，超时定期清理；消息历史 JSONL 保留）
const BROADCAST_TTL = parseInt(process.env.AITI_BROADCAST_TTL || "600000", 10); // 群发/页面事件推送排除：掉线超过此时长的 agent（“掉线很久”，默认 10min）
const AGENT_GRACE_TTL = parseInt(process.env.AITI_AGENT_GRACE_TTL || "120000", 10); // 无流 agent（stateless）静默宽限：此期间视为活跃（重新活动即不累计掉线）
const AGENT_HISTORY_TTL = parseInt(process.env.AITI_AGENT_HISTORY_TTL || String(7 * 24 * 3600 * 1000), 10); // 磁盘消息 session 历史保留期（超过自动删除，默认 7 天）
const SWEEP_MS = parseInt(process.env.AITI_SWEEP_MS || "60000", 10); // 清理扫描周期
const LEGACY_TOKEN = "dev";

export function createBridge(dataDir = "", opts: { name?: string; busPublish?: (type: string, data?: Record<string, unknown>) => void } = {}) {
  const BRIDGE_NAME = opts.name || "aiti-mcp"; // 标识名（日志前缀；默认兼容旧 aiti-mcp）
  const DISPLAY_NAME = opts.name || "aiti-devtools"; // 展示名（srcLabel/serverInfo）
  const TAG = "[" + BRIDGE_NAME + "]";
  // 统一 SSE 端口适配（方案 v2）：宿主 event-bus 的 publish 出口（pi-web 扩展接线传入；
  // 独立桥/未接线宿主不传 = 下行走自带 SSE，零变化）。传入后页面可经 POST /bridge/attach-bus
  // 把连接注册为「总线型 writer」——下行全部经 w.write() 的既有推送点自动改投总线专属
  // topic（bridge-<instanceId>），不再占一条独立 EventSource 连接。
  const busPublish = opts.busPublish || null;
  const BUS_CONN_TTL = parseInt(process.env.AITI_BUS_CONN_TTL || "150000", 10); // 总线型连接无心跳超时（开页方案 §8：90→150s——客户端 45s 一跳，原 90s < 2×45s 漏一拍即被摘除）
  // ---------------- 会话状态 ----------------
  const idRegistry = new Map(); // instanceId -> { pageKey, secret, lastSeen }
  const pages = new Map();      // instanceId -> { writer, url, frameworks, frames:Set, frameInfo:Map }
  const pendingRequests = new Map(); // requestId -> { resolve, agentId?, t0, signal?, onAbort?, mcpReqId?, cancelId? }（agentId 用于异步作答回投递）
  const aiConns = new Set();    // AI 连接 writer
  const mcpReqMap = new Map();    // MCP jsonrpc id → 内部 requestId（notifications/cancelled 用）
  const cancelIdMap = new Map();  // 客户端 cancelId（pi 扩展 toolCallId）→ 内部 requestId（/bridge/cancel 用）
  // AI 连接宿主页注册表（AI 窗连桥 role=ai 后，把宿主页身份 pageId/title/url 注册到桥——
  // 页面不连桥，桥通过此表看到/定向宿主页：bridge_status 显示、page_exec 经 via:ai 推 AI 窗转发宿主）
  const aiPageReg = new Map();  // writer -> { instanceId, pageId, title, url, lastSeen }
  // AI 主窗口 self 注册表（M1：AI 窗 role=ai 连桥后自注册自己为调试目标 xxx/ai——
  // 桥看到自己窗口：sessions 里恒有 xxx/ai 条目、exec 到 xxx/ai 直接推该 AI 连接 self-exec）
  const aiSelfReg = new Map();  // writer -> { instanceId, url, title, lastSeen }
  const sseMcpClients = new Set();
  // 方案 G · P1：Streamable HTTP MCP 会话（agent 侧；sessionId -> { id, writer, agentId, clientInfo, capabilities, lastSeen, open }）
  const mcpSessions = new Map(); // streamable HTTP 持久会话（Mcp-Session-Id）
  const MCP_SESSION_TTL = parseInt(process.env.AITI_MCP_SESSION_TTL || "600000", 10); // 无流/断开保留（ms）
  const mcpSessionExpired = (s) => Date.now() - (s && s.lastSeen || 0) > MCP_SESSION_TTL;

  // 方案 G · P2：agent 注册表 + outbox（消息主通道）
  // 多 agent/session：key = agentId + "/" + sessionId（同一 agent 多实例/会话各自独立 outbox，不串台）
  //   agentId：agent 类型（pi / cc / qoder）
  //   sessionId：实例内会话标识（pi 的 session id；MCP streamable 的 Mcp-Session-Id；aiti_hello 显式指定；缺省桥生成随机）
  const agents = new Map(); // agentKey -> { agentId, sessionId, registered, name, transportKind, source, capabilities, stream, agentStream, boundPageId, activeBoundPageId, subEvents:Set, outbox:[], lastSeen }
  // 轮询/重连注册的 pageId 列表（不覆盖，每个注册追加一条）。activeBoundPageId 死后从这挑最新的。
  const agentFallbackPageIds = new Map(); // agentKey -> Array<{pageId, lastSeen}>
  // 交互工具目的方兕底：pageId 未指定时用发起 agent 的 boundPageId（定向到其绑定页面）；
  // 再兕底：AI 主窗口（url 含 session=<agent sessionId> 的最新）——避免广播到不确定窗口。
  const boundPageIdFor = (sess: any) => {
    const key = sess && (sess.agentKey || sess.agentId);
    const ag = key ? agents.get(String(key)) : null;
    if (!ag) return null;
    // 1) activeBoundPageId（visibilitychange 活跃绑定）——用户当前在的 tab，最高优先级
    if (ag.activeBoundPageId && boundPageAlive(ag.activeBoundPageId)) return String(ag.activeBoundPageId);
    // 2) 从轮询列表挑最新的（不覆盖，各注册共存）
    const fbList = agentFallbackPageIds.get(String(key));
    if (fbList && fbList.length > 0) {
      const sorted = fbList.filter(function(e) { return boundPageAlive(e.pageId); }).sort(function(a, b) { return b.lastSeen - a.lastSeen; });
      if (sorted.length > 0) return String(sorted[0].pageId);
    }
    // 3) boundPageId（显式绑定，如 bindAgentPage API）
    if (ag.boundPageId && boundPageAlive(ag.boundPageId)) return String(ag.boundPageId);
    // 4) url-session 兜底找最新窗口
    const sid = (sess && sess.id) || (key && String(key).split("/").slice(1).join("/")) || null;
    if (sid) {
      let best: any = null; let bestSeen = -1;
      for (const [, rec] of aiSelfReg) {
        const m = String(rec.url || "").match(/[?&]session=([^&#]+)/);
        if (m && decodeURIComponent(m[1]) === sid && (rec.lastSeen || 0) > bestSeen) { best = rec; bestSeen = rec.lastSeen || 0; }
      }
      if (best) return String(best.instanceId) + "/ai";
    }
    return null;
  };
  /** 绑定 agent 默认目标页（boundPageId）——交互工具 pageId 未指定时的定向目的地（如 invoke 发起方 AI 主窗口） */
  const bindAgentPage = (key: string, pageId: string | null) => {
    const a = agents.get(String(key || ""));
    if (!a) return { ok: false, error: "unknown agent: " + key };
    a.boundPageId = pageId ? String(pageId) : null;
    return { ok: true, agentKey: String(key), boundPageId: a.boundPageId };
  };
  // AI 主窗口 self 注册时（url 含 session=<id>）→ 追加到轮询列表（不覆盖，各注册共存）
  // activeBoundPageId 活着时用它；死了从列表挑最新的。
  const bindAgentFromAiSelf = (rec: any) => {
    const m = String(rec.url || "").match(/[?&]session=([^&#]+)/);
    if (!m) return;
    const sid = decodeURIComponent(m[1]);
    const newPageId = String(rec.instanceId) + "/ai";
    const now = Date.now();
    for (const [key, ag] of agents) {
      const agSid = ag.sessionId || String(key).split("/").slice(1).join("/");
      if (agSid === sid) {
        // 追加到轮询列表
        if (!agentFallbackPageIds.has(key)) agentFallbackPageIds.set(key, []);
        var list = agentFallbackPageIds.get(key);
        // 去重：同一 pageId 更新 lastSeen，不重复插入
        var found = false;
        for (var i = 0; i < list.length; i++) {
          if (list[i].pageId === newPageId) { list[i].lastSeen = now; found = true; break; }
        }
        if (!found) list.push({ pageId: newPageId, lastSeen: now });
      }
    }
  };
  // AI 主窗口主动激活（visibilitychange visible）→ 用户当前在的 tab，设 activeBoundPageId
  // 总是更新，不怕覆盖——同一时刻只有一个 tab 可见。
  const bindAgentFromActive = (instanceId: string, sessionId: string) => {
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
  // 校验 boundPageId 仍指向活跃 AI 主窗口连接（aiSelfReg 里有对应 instanceId）
  const boundPageAlive = (pageId: string) => {
    const inst = String(pageId || "").split("/")[0];
    if (!inst) return false;
    for (const [, rec] of aiSelfReg) if (rec.instanceId === inst) return true;
    return false;
  };
  // agentStream：P3 推送——agent SSE 持久流 writer（pi 扩展 EventSource 连 /bridge/agent/sse；区别于 stream=MCP streamable GET 流）
  // 事件注入防刷屏：同一 (agentKey, 签名) 5s 内不重复推
  const lastEventPush = new Map(); // key -> { sig, ts }
  const pushDeduped = (key, sig) => {
    const now = Date.now();
    const last = lastEventPush.get(key);
    if (last && last.sig === sig && now - last.ts < 5000) return true; // 已推过（5s 内同签名）
    lastEventPush.set(key, { sig, ts: now });
    return false;
  };
  const agentIdx = new Map(); // agentId -> Set<agentKey>（agentId 广播用）
  // 在线判定：持久连接（agent SSE / MCP streamable GET 流）计数 > 0；conn 由流建立/关闭维护
  const agentOnline = (a) => !!(a && a.conn > 0);
  // 标记掉线：流关闭时调用（仅无连接时记 offlineAt；有连接由 sweep 清空）
  const markOffline = (key) => {
    const a = agents.get(key);
    if (a && !agentOnline(a) && !a.offlineAt) a.offlineAt = Date.now();
  };
  const agentKey = (aid, sid) => safeId(aid) + "/" + safeId(sid || "s_" + randomBytes(3).toString("hex"));
  const randomSessionId = () => "s_" + randomBytes(3).toString("hex");
  const OUTBOX_MAX = 200; // pending 未取上限（consumed 历史由 JSONL 持久保留）
  const safeId = (s) => String(s || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  // ---- 消息 session 存储（参照 pi session：append-only 事件流 JSONL，按 (agentId,天) 滚动，2MB 上限）----
  const msgSessionDir = (agentId) => join(dataDir, "aiti-bridge", "sessions", safeId(agentId));
  const msgSessionFile = (agentId) => {
    const dir = msgSessionDir(agentId);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
    if (files.length) {
      const latest = join(dir, files[files.length - 1]);
      try { if (statSync(latest).size > 2 * 1024 * 1024) return newMsgSessionFile(agentId); } catch {}
      return latest;
    }
    return newMsgSessionFile(agentId);
  };
  const newMsgSessionFile = (agentId) => {
    const dir = msgSessionDir(agentId);
    mkdirSync(dir, { recursive: true });
    return join(dir, new Date().toISOString().replace(/[:.]/g, "-") + "_" + randomBytes(8).toString("hex") + ".jsonl");
  };
  const appendMsgEvent = (agentId, evt) => {
    try {
      const file = msgSessionFile(agentId);
      if (!existsSync(file)) appendFileSync(file, JSON.stringify({ type: "session", version: 1, id: randomBytes(8).toString("hex"), timestamp: new Date().toISOString(), kind: "aiti-bridge" }) + "\n");
      appendFileSync(file, JSON.stringify(evt) + "\n");
    } catch (e) {}
  };
  const readMsgSession = (agentId) => { // 重放 JSONL → [{id, ...message, at, status}]
    const rows = [];
    try {
      const dir = msgSessionDir(agentId);
      if (!existsSync(dir)) return rows;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")).sort()) {
        for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === "message") rows.push({ id: evt.id, ...(evt.message || {}), at: evt.timestamp });
          else if (evt.type === "status_change") { const r = rows.find((x) => x.id === evt.msgId); if (r) r.status = evt.status; }
        }
      }
    } catch (e) {}
    return rows;
  };
  const restoreAgentOutbox = (agentId, agent) => {
    // 重启恢复：pending/delivered 消息恢复为 pending（agent 重连可重新取）；consumed 只留历史不重投
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
        agentId: aid, sessionId: sid, registered: !!sessionId,
        name: aid + (session && session.clientInfo && session.clientInfo.name ? " (" + session.clientInfo.name + ")" : ""),
        cwd: null, offlineAt: null, conn: 0, // cwd：工作目录（显示 CWD . name (id)）；offlineAt：掉线时间（显示/清理用）；conn：持久连接数
        transportKind: (session && session.open) ? "streamable" : "stateless",
        source: (session && session.source) || "unknown", // 调用来源：extension（pi 扩展直连）/ mcp / unknown
        capabilities: (session && session.capabilities) || {}, stream: (session && session.writer) || null,
        boundPageId: null, subEvents: new Set(), outbox: [], lastSeen: Date.now(), agentStream: null,
        inProcessSink: null, // 宿主进程内 agent（如 pi-web 方案 M）：消息直推回调（注入会话，不走 outbox/SSE）——任何宿主可用
      };
      restoreAgentOutbox(key, a);
      agents.set(key, a);
      let idxSet = agentIdx.get(aid);
      if (!idxSet) { idxSet = new Set(); agentIdx.set(aid, idxSet); }
      idxSet.add(key);
      console.log(TAG + " agent 会话注册：" + key + (a.registered ? "（显式）" : "（随机 session，引导 aiti_hello 注册）") + " " + a.transportKind + " 恢复 outbox " + a.outbox.length + " 条");
    }
    a.lastSeen = Date.now();
    if (session) { a.capabilities = session.capabilities || a.capabilities; if (session.writer) a.stream = session.writer; if (session.open) a.transportKind = "streamable"; }
    return { a, key };
  };
  const queueMsg = (key, msg) => {
    const a = agents.get(key);
    if (!a) return { ok: false, error: "unknown agent session: " + key };
    // 结构化 pageId/url：显式字段 → payload → 文本 [发自: <pageId> · <url>] 兜底提取（前端只改文本标注时也能结构化）
    let srcPageId = msg.pageId || (msg.payload && msg.payload.pageId) || null;
    let srcUrl = msg.url || (msg.payload && msg.payload.url) || null;
    if (typeof msg.text === "string") {
      const fm = msg.text.match(/\[发自:\s*([^\s·\]（(]+)/);
      if (fm) srcPageId = srcPageId || fm[1].trim();
      if (!srcUrl) {
        const um = msg.text.match(/\[发自:\s*[^\s·\]（(]+\s*·\s*([^\s（(]+)/);
        if (um) srcUrl = um[1].trim();
      }
    }
    const m = { id: randomBytes(4).toString("hex"), ...msg, pageId: srcPageId, url: srcUrl, source: msg.source || (msg.payload && msg.payload.source) || null, sourceLabel: msg.sourceLabel || (msg.payload && msg.payload.sourceLabel) || null, agentId: key, at: new Date().toISOString(), status: "pending" };
    a.outbox.push(m);
    if (a.outbox.length > OUTBOX_MAX) a.outbox.splice(0, a.outbox.length - OUTBOX_MAX);
    appendMsgEvent(key, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
    return { ok: true, msg: m };
  };
  // push 目标解析：agentKey 精确 → agentId 广播（该 agent 全部 session）→ "all"/缺省 全部
  // 群发（all/agentId 广播）只投递：已注册 + （在线 或 掉线 ≤ BROADCAST_TTL）——掉线很久的 agent 不投递（“不用管”）
  const resolvePushTargets = (to) => {
    const now = Date.now();
    const liveKeys = [...agents.entries()].filter(([, a]) => a.registered && (agentOnline(a) || now - (a.offlineAt || a.lastSeen || 0) <= BROADCAST_TTL)).map(([k]) => k);
    if (!to || to === "all") return liveKeys.sort((a, b) => ((agents.get(b) || {}).lastSeen || 0) - ((agents.get(a) || {}).lastSeen || 0));
    const s = String(to);
    if (agents.has(s)) return [s]; // agentKey 精确（显式定向：掉线也投递，入 outbox 待重连拉取）
    if (agentIdx.has(s)) return [...agentIdx.get(s)].filter((k) => liveKeys.includes(k)).sort((a, b) => ((agents.get(b) || {}).lastSeen || 0) - ((agents.get(a) || {}).lastSeen || 0)); // agentId 广播
    return [];
  };
  const listAgentSessions = () => {
    return [...agents.entries()].map(([key, a]) => ({
      agentKey: key, agentId: a.agentId, sessionId: a.sessionId, registered: a.registered,
      name: a.name || a.agentId, transportKind: a.transportKind, source: a.source || "unknown", boundPageId: a.boundPageId || null,
      subEvents: [...a.subEvents], online: agentOnline(a), agentStream: !!a.agentStream,
      cwd: a.cwd || null, offlineAt: a.offlineAt || null,
      inboxPending: a.outbox.filter((m) => m.status !== "consumed").length, lastSeen: a.lastSeen,
    })).sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
  };

  // ---------------- agent 定期清理（掉线治理） ----------------
  // 掉线时间维护：有连接（online）→ 清空 offlineAt；无连接但 GRACE 内活动过 → 仍视为活跃（取消掉线标记）；
  //   否则首次观察即记 offlineAt = lastSeen（无流 agent）或流关闭时间（有流 agent，markOffline）
  // 清理：offlineAt 超 AGENT_TTL → 移出内存（agentIdx 同步；消息历史 JSONL 保留）；磁盘 session 超 AGENT_HISTORY_TTL → 删除
  const pruneSessionDirs = (now) => {
    if (!dataDir) return;
    const rootDir = join(dataDir, "aiti-bridge", "sessions");
    let dirs = [];
    try { dirs = existsSync(rootDir) ? readdirSync(rootDir) : []; } catch { return; }
    for (const d of dirs) {
      try {
        const p = join(rootDir, d);
        const st = statSync(p);
        if (!st.isDirectory()) continue;
        const files = readdirSync(p).filter((f) => f.endsWith(".jsonl"));
        let mtime = st.mtimeMs;
        for (const f of files) { try { mtime = Math.max(mtime, statSync(join(p, f)).mtimeMs); } catch {} }
        if (now - mtime > AGENT_HISTORY_TTL) {
          rmSync(p, { recursive: true, force: true });
          console.log(TAG + " 清理历史 session（> " + Math.round(AGENT_HISTORY_TTL / 86400000) + " 天无活动）：" + d);
        }
      } catch {}
    }
  };
  const agentSweep = () => {
    const now = Date.now();
    for (const [key, a] of agents) {
      if (agentOnline(a)) { if (a.offlineAt) a.offlineAt = null; continue; }
      if (now - a.lastSeen <= AGENT_GRACE_TTL) { if (a.offlineAt) a.offlineAt = null; continue; }
      if (!a.offlineAt) a.offlineAt = a.lastSeen;
      if (now - a.offlineAt > AGENT_TTL) {
        console.log(TAG + " agent 清理（掉线 > " + Math.round(AGENT_TTL / 60000) + "min）：" + key + " " + (a.name || "") + "（offlineAt " + new Date(a.offlineAt).toISOString() + "）");
        agents.delete(key);
        const idx = agentIdx.get(a.agentId);
        if (idx) { idx.delete(key); if (!idx.size) agentIdx.delete(a.agentId); }
      }
    }
    // 事件去重表裁剪（防无限增长）
    for (const [k, v] of lastEventPush) if (now - v.ts > 3600000) lastEventPush.delete(k);
    // 总线型连接超时清理（统一 SSE 端口适配）：无 SSE 断连信号，靠客户端心跳保鲜；
    // 超时 = 页面已死/总线丢失 → 摘除（同 SSE onClose 的清理语义）。
    for (const [iid, p] of [...pages]) {
      if ((p.writer as any)?.viaBus && now - ((p.writer as any).lastSeen || 0) > BUS_CONN_TTL) {
        pages.delete(iid);
        console.log(TAG + " 总线型页面连接超时摘除：" + iid);
      }
    }
    for (const w of [...aiConns]) {
      if ((w as any)?.viaBus && now - ((w as any).lastSeen || 0) > BUS_CONN_TTL) {
        aiConns.delete(w);
        aiPageReg.delete(w);
        aiSelfReg.delete(w);
      }
    }
    pruneSessionDirs(now);
  };
  const sweepTimer = setInterval(agentSweep, SWEEP_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  // 进程内宿主（pi-web/DSH 插件）卸载时停止 sweep——防插件重载后旧定时器泄漏（每实例一个，累积会
  // 重复扫描/写盘）。SSE 连接的 ping/清理由各自 cleanup 负责，close 不碰（断连自然触发 write 失败路径）。
  const close = () => {
    clearInterval(sweepTimer);
  };
  // 人 → AI 推路由（P2 queue 主通道；P3 sampling 推：有流 + sampling 能力的 agent 直接经 GET 流推，模型立即作答）
  const pendingSampling = new Map(); // rid -> { agentId, done, at }（客户端对 sampling/createMessage 的响应经 POST 回）
  const SAMPLING_TIMEOUT_MS = 45000;
  const samplingTextOf = (result) => {
    if (!result) return "";
    const c = result.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.map((b) => (b && b.text) || "").join("\n").trim();
    if (c && typeof c === "object") return c.text || "";
    return JSON.stringify(result).slice(0, 300);
  };
  const pushToAgents = (to, text, kind = "user_message", payload = {}, ref = null) => {
    const targets = resolvePushTargets(to);
    if (!targets.length) return { ok: false, error: "无已注册 agent 会话（agent 连桥并注册后才有收件箱）" };
    const delivered = [];
    for (const t of targets) {
      const { a } = ensureAgent(t.split("/")[0], t.split("/").slice(1).join("/"), null); // 占位注册（消息落 JSONL，agent 首次连接时恢复）
      // 来源双通道：结构字段（payload.source/sourceLabel/pageId/url——agent 工具可读）+ 注入文本标注（[发自: …]——agent 会话直接可见）
      // 扩展接入（pi 扩展/pi-web agent 扩展点）工具为 aiti_* 内部命令；MCP 接入才是 MCP server 工具——提示措辞区分
      const srcLabel = (a && a.source === "extension") ? "aiti-*" : DISPLAY_NAME + " MCP";
      // 缺省页面上下文：payload 未显式带 pageId/url/title 时，用 agent 绑定页 → 当前活跃页兜底（让结构字段有值）
      let srcPageId = (payload && payload.pageId) || null;
      let srcUrl = (payload && payload.url) || null;
      let srcTitle = (payload && payload.title) || null;
      if (!srcPageId) {
        const bind = (a && a.boundPageId) ? resolvePageId(a.boundPageId) : null;
        const rows = listSessions().filter((r) => r.active && r.pageId);
        const pick = (bind && bind.pageId && rows.find((r) => r.pageId === bind.pageId)) || (rows.length === 1 ? rows[0] : null);
        if (pick) { srcPageId = pick.pageId; srcUrl = pick.url; srcTitle = pick.title || null; }
      } else if (!srcUrl) {
        // pageId 已有但缺 url/title → 从 sessions 补（同页信息）
        const row = listSessions().find((r) => r.pageId === srcPageId);
        if (row) { srcUrl = row.url || null; srcTitle = srcTitle || row.title || null; }
      }
      // 长文本截断：前后保留 + 中间省略（标注用）
      const clipMid = (s: string, max: number) => {
        s = String(s || "");
        if (s.length <= max) return s;
        const half = Math.max(8, Math.floor((max - 1) / 2));
        return s.slice(0, half) + "…" + s.slice(s.length - half);
      };
      // 注入文本带来源标注（给 agent 看：谁从哪个页面发的消息——幂等，已有 [发自: ] 不重复）；传输本体保持干净
      let tText = String(text);
      if (srcPageId && tText.indexOf("[发自: ") < 0) {
        const parts = [srcPageId];
        if (srcUrl) parts.push(clipMid(srcUrl, 64));
        if (srcTitle) parts.push(clipMid(srcTitle, 40));
        tText = tText + "\n[发自: " + parts.join(" · ") + "（" + srcLabel + "：pageId 参数用它）]";
      }
      payload = { ...(payload || {}), source: (a && a.source) || null, sourceLabel: srcLabel, pageId: srcPageId, url: srcUrl, title: srcTitle };
      // sampling 推：仅"人主动发话"（user_message/chat）且 agent 有流 + 声明 sampling 能力（如 pi）
      const canSample = !!(a && a.stream && a.capabilities && a.capabilities.sampling && (kind === "user_message" || kind === "chat"));
      if (canSample) {
        const rid = "smp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
        const done = (ok, result) => {
          if (!pendingSampling.delete(rid)) return;
          const answer = ok ? samplingTextOf(result) : (result && result.error) || "sampling 失败";
          console.log(TAG + " sampling 作答 → agent=" + t + " · " + String(answer).slice(0, 80));
          for (const w of aiConns) w.write({ type: "agent_answer", agentKey: t, agentId: a.agentId, ok, text: answer, requestId: rid, at: Date.now() });
        };
        pendingSampling.set(rid, { agentKey: t, done, at: Date.now() });
        a.stream.write({
          jsonrpc: "2.0", id: rid, method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: tText } }],
            systemPrompt: "（调试现场的人通过 " + DISPLAY_NAME + " 发来的消息。目标页 pageId=" + (payload.pageId || "?") + "。直接回答即可，简短。",
            maxTokens: 1024, temperature: 0.3,
          },
        });
        setTimeout(() => done(false, { error: "sampling 超时（agent 未响应或需审批确认）" }), SAMPLING_TIMEOUT_MS);
        delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "sampling" });
      } else {
        const q = queueMsg(t, { kind, from: "window", text: tText, payload, pageId: (payload && payload.pageId) || null, source: payload.source, sourceLabel: payload.sourceLabel, ref });
        if (typeof a.inProcessSink === "function") {
          // 宿主进程内 agent：sink 直推（如 pi-web wrapper.steer 注入会话，模型立即看到）
          try { a.inProcessSink(tText, kind, payload); } catch (e) { console.error(TAG + " inProcessSink 失败", e); }
          const m0 = q && q.msg;
          if (m0 && m0.status === "pending") {
            m0.status = "delivered";
            appendMsgEvent(t, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: m0.id, status: "delivered", timestamp: new Date().toISOString() });
            for (const w of aiConns) w.write({ type: "msg_status", agentKey: t, msgId: m0.id, status: "delivered" });
          }
          delivered.push({ agentKey: t, agentId: a.agentId, sessionId: a.sessionId, status: "inprocess" });
        } else if (a.agentStream && !pushDeduped(t, "push:" + kind + tText)) {
          // P3：agent 有 SSE 持久流 → 实时推送（扩展收到后 sendUserMessage 注入会话）；
          // 推送成功即视为已送达（pending → delivered），状态机与 aiti_inbox 拉取一致；无流保持 pending（等拉取）
          a.agentStream.write({ type: "agent_push", kind, text: tText, payload, at: Date.now() });
          const m = q && q.msg;
          if (m && m.status === "pending") {
            m.status = "delivered";
            appendMsgEvent(t, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: m.id, status: "delivered", timestamp: new Date().toISOString() });
            for (const w of aiConns) w.write({ type: "msg_status", agentKey: t, msgId: m.id, status: "delivered" }); // 窗口实时更新状态
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
  // 异步 user_* 作答 → 回投递发起 agent（§3.4；按 agentKey 定向到发起会话；agentStream 实时推）
  const deliverUserAnswer = (agentKey, result) => {
    if (!agentKey || !result) return;
    const text = JSON.stringify(result).slice(0, 500);
    const a = agents.get(agentKey);
    if (a && a.agentStream) a.agentStream.write({ type: "agent_push", kind: "user_answer", text, payload: result, at: Date.now() });
    // 宿主进程内 agent：sink 同步直推（同 pushToAgents）
    if (a && typeof a.inProcessSink === "function") { try { a.inProcessSink(text, "user_answer", result); } catch (e) { console.error(TAG + " inProcessSink 失败", e); } }
    queueMsg(agentKey, { kind: "user_answer", from: "page", text, payload: result });
  };
  // ---- P3：页面事件 → 订阅 agent（subEvents 显式订阅；agentStream 实时推 / 无流入 outbox；防刷屏） ----
  const formatPageEvent = (eventType, payload, pageInfo) => {
    const where = pageInfo && pageInfo.url ? (pageInfo.pageId ? `[${pageInfo.pageId} · ${pageInfo.url}]` : `[${pageInfo.url}]`) : "";
    if (eventType === "page_error") {
      const pl = payload || {};
      return `⚠ 页面报错${where} ${pl.kind || ""} ${String(pl.message || "").slice(0, 300)}` + (pl.stack ? `\n${String(pl.stack).slice(0, 400)}` : "");
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
      if (!agentOnline(a) && now - (a.offlineAt || a.lastSeen || 0) > BROADCAST_TTL) continue; // 掉线很久：不投递
      if (pushDeduped(key, sigBase)) { console.log(TAG + " push 去重（5s 内同事件）" + key + " " + eventType); continue; }
      const text = formatPageEvent(eventType, payload, pageInfo);
      if (a.agentStream) a.agentStream.write({ type: "page_event", event: eventType, text, pageId: (pageInfo && pageInfo.pageId) || null, url: (pageInfo && pageInfo.url) || null, at: Date.now() });
      else { queueMsg(key, { kind: "page_" + eventType, from: "page", text, payload }); console.log(TAG + " push 无流 → outbox " + key + " " + eventType); }
    }
  };
  // 方案 F-3：页面日志/网络不再实时上报桥——数据留在页面本地缓冲，page_logs/page_network 工具通过 CDP Runtime.evaluate 按需拉取

  // ---------------- 工具 ----------------
  const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors, ...extraHeaders },
  });
  const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "Content-Type" };
  // AI 窗候选上报存储（POST /bridge/picked；key = agentKey 或 '__all__'，最新一份覆盖）
  const pickedReports = new Map();
  // 持久化（picked.json）：桥重启不丢候选（多宿主/升级场景；写盘失败降级内存）
  const pickedFile = dataDir ? join(dataDir, "picked.json") : "";
  try {
    if (pickedFile && existsSync(pickedFile)) {
      const saved = JSON.parse(readFileSync(pickedFile, "utf8"));
      if (saved && typeof saved === "object") for (const [k, v] of Object.entries(saved)) if (Array.isArray(v)) pickedReports.set(k, v);
    }
  } catch {}
  const persistPicked = () => {
    if (!pickedFile) return;
    try {
      mkdirSync(dirname(pickedFile), { recursive: true });
      // 原子写（tmp+rename）：直接覆盖在写入中途被杀会留下半截 JSON，启动解析失败丢全部候选
      const tmp = pickedFile + ".tmp";
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(pickedReports)));
      renameSync(tmp, pickedFile);
    } catch {}
  };
  const isExpired = (rec) => Date.now() - rec.lastSeen > ID_TTL;

  function randomInstanceId() {
    const letters = "abcdefghijklmnopqrstuvwxyz";
    return letters[randomInt(26)] + letters[randomInt(26)] + String(randomInt(100, 1000));
  }
  function genSecret() { return randomBytes(12).toString("hex"); }

  // 端口偏好：localhost:6513（url.port）/ 6513-port.localhost（域名）
  function portFromHostUrl(hostUrl) {
    if (!hostUrl || typeof hostUrl !== "string") return null;
    try {
      const u = new URL(hostUrl);
      if (u.port) { const n = parseInt(u.port, 10); if (n > 0 && n <= 65535) return n; }
      const host = (u.hostname || "").toLowerCase();
      const m = host.match(/^(\d{1,5})(?:-port)?[-.]/);
      if (m) { const n = parseInt(m[1], 10); if (n > 0 && n <= 65535) return n; }
      const m2 = host.match(/-?(\d{1,5})-port(?=\.|$)/);
      if (m2) { const n = parseInt(m2[1], 10); if (n > 0 && n <= 65535) return n; }
    } catch {}
    return null;
  }
  const allocInstanceId = (preferred) => {
    const free = (id) => !pages.has(id) && !idRegistry.has(id);
    if (preferred && free(String(preferred))) return String(preferred);
    for (let i = 0; i < 64; i++) { const n = randomInstanceId(); if (free(n)) return n; }
    return randomInstanceId();
  };

  function claimInstanceId(preferred, secret, pageKey, hostUrl) {
    const now = Date.now();
    for (const [id, rec] of idRegistry) { // 惰性清理过期
      if (!pages.has(id) && now - rec.lastSeen > ID_TTL) idRegistry.delete(id);
    }
    if (preferred && idRegistry.has(preferred) && !pages.has(preferred) && !isExpired(idRegistry.get(preferred))) {
      const rec = idRegistry.get(preferred);
      if (secret && rec.secret && secret === rec.secret) { // secret 匹配才复用
        rec.lastSeen = now;
        return { instanceId: preferred, secret: rec.secret };
      }
    }
    const id = allocInstanceId(portFromHostUrl(hostUrl)); // 新申请：端口偏好 → 随机
    const sec = genSecret();
    idRegistry.set(id, { pageKey: pageKey || null, secret: sec, lastSeen: now });
    return { instanceId: id, secret: sec };
  }
  function checkSecret(instanceId, secret) {
    if (!secret) return true; // 兼容（老 client/dev 不带 secret）
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

  // pageId 兼容 url/title（静默解析）：AI 传 pageId/url/title 均可——
  // 精准匹配（1 个）→ 执行；多个/无 → 反馈（让 AI 调整）
  function resolvePageId(input: unknown): { pageId?: string; multiple?: string[]; notFound?: boolean } {
    if (typeof input !== "string" || !input) return { notFound: true };
    const rows = listSessions().filter((r) => r.active);
    if (rows.some((r) => r.pageId === input)) return { pageId: input };
    const hit = new Map<string, boolean>();
    for (const r of rows) {
      const u = r.url || "", t = r.title || "";
      if ((u && (u === input || u.includes(input))) || (t && (t === input || t.includes(input)))) hit.set(r.pageId, true);
    }
    if (hit.size === 1) return { pageId: [...hit.keys()][0] };
    if (hit.size > 1) return { multiple: [...hit.keys()] };
    return { notFound: true };
  }

  // 设备信息附加到 session 行（仅注册了 device 才带，保持 JSON 精简）；deviceLabel 缺省时用最小兜底
  const withDevice = (row: any, dev: any, label: any) => {
    if (dev && typeof dev === "object") {
      row.device = dev;
      row.deviceLabel = label || [dev.browser || "?", dev.os || "", dev.screen || ""].filter(Boolean).join(" · ");
    }
    return row;
  };

  function listSessions(boundPageId) {
    const out = [];
    const seen = new Set(); // pageId 去重：真实连接（pages）优先；AI 宿主页/幽灵重复行跳过（防多 AI 窗注册同一宿主页产生 frameId=null 幽灵）
    // 为每个 row 打 mine 标记：boundPageId 匹配 → mine:true（当前 agent 绑定的页面）
    const addMine = (row) => { row.mine = !!(boundPageId && row.pageId === boundPageId); };
    for (const [instanceId, page] of pages) {
      for (const frameId of page.frames) {
        const fi = (page.frameInfo && page.frameInfo.get(frameId)) || null;
        const isHost = frameId === "host";
        // 帧级信息（iframe 自身；主页帧回退页面级 url/title；跨域/未上报仅元素属性 src/name）
        const fUrl = (fi && fi.url) || (isHost ? page.url : null);
        const fTitle = (fi && fi.title) || (isHost ? page.title : null);
        const row = { instanceId, frameId, pageId: instanceId + "/" + frameId, url: page.url, title: page.title || null, frameworks: page.frameworks, active: true, lastSeen: Date.now(),
          frameUrl: fUrl || null, frameTitle: fTitle || null, frameName: (fi && fi.name) || "", frameSrc: (fi && fi.src) || "",
          frameParent: isHost ? null : ((fi && fi.parentId) || null), root: isHost || !(fi && fi.parentId),
          };
        withDevice(row, (page as any).device, (page as any).deviceLabel);
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
    // AI 宿主页：AI 窗注册的宿主页（页面不连桥——经 AI 窗可见/可操作；页面已直连时该条目冗余 → 按 pageId 去重跳过）
    // 多 AI 窗注册同一宿主页时按 baseId 聚合：优先选有帧树（frames）的，避免幽灵（frames=null）重复行
    const aiByBase = new Map(); // baseId → rec（最优：有 frames > frames 长 > lastSeen 新）
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
        if (seen.has(rec.pageId)) continue; // 幽灵：宿主页已有真实连接/同 pageId 行 → 跳过
        seen.add(rec.pageId);
        const aiRow1 = { instanceId: rec.instanceId, frameId: null, pageId: rec.pageId, url: rec.url || null, title: rec.title || null, frameworks: null, active: true, viaAI: true, lastSeen: rec.lastSeen };
        withDevice(aiRow1, rec.device, rec.deviceLabel);
        addMine(aiRow1);
        out.push(aiRow1);
        continue;
      }
      // 帧树展开：host 行 + 每帧一行（frameUrl/frameTitle/frameParent 供 cockpit 树形下拉；pageId 与 register 页一致语义）
      for (const f of fr) {
        const fid = String(f.id || "host");
        const isHost = fid === "host";
        const rowPageId = baseId + "/" + fid;
        if (seen.has(rowPageId)) continue; // 与真实连接/先前行重复 → 跳过
        seen.add(rowPageId);
        const frRow = { instanceId: rec.instanceId, frameId: fid, pageId: rowPageId, url: rec.url || null, title: rec.title || null, frameworks: null, active: true, viaAI: true, lastSeen: rec.lastSeen,
          frameUrl: (f && f.url) || (isHost ? rec.url : null) || null, frameTitle: (f && f.title) || (isHost ? rec.title : null) || null,
          frameName: (f && f.name) || "", frameSrc: (f && f.src) || "",
          frameParent: isHost ? null : ((f && f.parentId) || null), root: isHost || !(f && f.parentId) };
        withDevice(frRow, rec.device, rec.deviceLabel);
        addMine(frRow);
        out.push(frRow);
      }
    }
    // M1 · AI 主窗口 self：每个 AI 连接（role=ai）自注册为 xxx/ai 调试目标（无宿主也可被管；
    // 有宿主时并列展开 host+frames+ai）。pageId = <instanceId>/ai；self 标记供 cockpit 识别。
    for (const [w, rec] of aiSelfReg) {
      const selfPageId = String(rec.instanceId) + "/ai";
      if (seen.has(selfPageId)) continue;
      seen.add(selfPageId);
      const selfRow = { instanceId: rec.instanceId, frameId: "ai", pageId: selfPageId, url: rec.url || null, title: rec.title ? (rec.title + " · AI 主窗口") : "AI 主窗口", frameworks: null, active: true, viaAI: true, self: true, lastSeen: rec.lastSeen };
      withDevice(selfRow, rec.device, rec.deviceLabel);
      addMine(selfRow);
      out.push(selfRow);
    }
    return out;
  }

  // ---------------- MCP 工具 ----------------
  const TOOLS = [
    { name: "page_exec", description: "在已连接页面执行类 CDP 命令（DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser 域）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。危险命令/浏览器受限操作会自动弹用户确认；Page.captureScreenshot 截屏会先弹准备卡展示截取意图（args.reason，请务必用一句话说明想截什么），用户调整好页面才开始截屏，截完再弹预览确认（大图自动落盘返回文件路径）；确认卡倒计时可用 args.timeout（ms）调整（默认 280000，服务端安全网自动同步 +30s 余量）。调试会话中从被调试页面（inject）发出的消息统一带 [发自: <pageId> · <url>] 来源标注——把 pageId 值传给 pageId 参数即操作该页面。\n\niframe 支持：Page.getFrameTree 查看 frame 树（iframe src/name/title，同域含 url/readyState）；Runtime.evaluate 传 contextId（iframe 索引从 1 起，同域可 eval）进 iframe 上下文执行。", 
      inputSchema: { type: "object", properties: {
        cmd: { type: "string" }, args: { type: "object" },
        pageId: { type: "string", description: "目标页面完整 ID——来自 AI 消息的 [发自: xxx]（如 30142/host）；也可 /bridge/sessions 查询" },
      }, required: ["cmd"] } },
    { name: "page_snapshot", description: "拉取已连接页面基础现场（URL/选区/模拟条件）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。", inputSchema: { type: "object", properties: { pageId: { type: "string" } } } },
    { name: "self_ui", description: "扫描目标页面（缺省 AI 主窗口 xxx/ai）当前打开的弹窗/dialog/表单字段/按钮清单——ai-helper 回填定位用。返回 {dialogs:[{title, fields:[{label,selector,type}], buttons}]}，无弹窗时 dialogs 为空数组。", inputSchema: { type: "object", properties: { pageId: { type: "string", description: "缺省用 AI 主窗口（xxx/ai）；也可指定其他页面" } } } },
    { name: "form_fill", description: "在目标页面（缺省 AI 主窗口 xxx/ai）的弹窗/表单里回填字段值——AI 结果直接操作扩展弹窗表单（React 兼容：原生 value setter + dispatch input/change）。配合 self_ui 使用：先 self_ui 拿字段 label/selector，再 form_fill 填值。参数：dialog（弹窗标识：标题子串或序号 0 起，缺省取面积最大的可见弹窗）、fields[{selector|label, value}]、button（可选，回填后点击的按钮文本如『保存』）。返回 {foundDialog, title, filled, missed, clicked}。", inputSchema: { type: "object", properties: {
        pageId: { type: "string", description: "缺省用 AI 主窗口（xxx/ai）；也可指定其他页面" },
        dialog: { type: "string", description: "弹窗标识：标题子串或序号（0 起）；缺省取面积最大的可见弹窗" },
        fields: { type: "array", items: { type: "object", properties: { selector: { type: "string", description: "CSS 选择器（优先）" }, label: { type: "string", description: "弹窗内文本匹配（label[for]/包裹/文本包含）" }, value: { type: "string", description: "要填的值" } }, required: ["value"] }, description: "要填的字段列表" },
        button: { type: "string", description: "回填后点击的按钮文本（如『保存』『确定』）" },
      } } },
    { name: "bridge_status", description: "查询已连接页面（sessions：含 pageId/url/title/frameworks + device/deviceLabel——浏览器·OS·屏幕·dpr·在线·语言·时区等设备信息，便于区分多台机器/标签页）与挂起请求。用户提到页面标题或 URL 时，按 title/url 匹配 pageId（如 refresh『某标题页面』或『某个 url 页面』）。", inputSchema: { type: "object", properties: {} } },
    { name: "page_logs", description: "从目标页面拉取本地缓冲的 console 日志（log/debug/info/warn/error 全量，CDP Runtime.evaluate 读取 window.__dbg.__consoleRing）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。页面报错排查首选：先查 warn/error 再逐步放开。返回 {logs:[{ts,level,text,count}], bufferSize}。",
      inputSchema: { type: "object", properties: {
        pageId: { type: "string", description: "目标页面完整 ID（[发自: xxx] 或 /bridge/sessions）" },
        level: { type: "string", description: "过滤级别：debug/log/info/warn/error（默认全部）" },
        since: { type: "string", description: "ISO 时间：只返回此时间之后的日志" },
        limit: { type: "number", description: "条数上限（≤200，默认 50，取最新）" },
        token: { type: "string" },
      } } },
    { name: "page_network", description: "从目标页面拉取本地缓冲的 ajax/fetch 请求完成态（CDP Runtime.evaluate 读取 window.__dbg.__netRing）。pageId 缺省=最新 AI 主窗口（self:true）；显式 pageId 优先。失败排查：status 传 400 或 errorOnly:true。注意：不含静态资源加载（那是 CDP Network 的能力）。返回 {requests:[{kind,method,url,status,statusText,durationMs,size,error,ts}], bufferSize}。",
      inputSchema: { type: "object", properties: {
        pageId: { type: "string" },
        url: { type: "string", description: "URL 子串过滤" },
        status: { type: "number", description: "status >= 此值才返回（如 400 只看失败）" },
        errorOnly: { type: "boolean", description: "只看失败（error 非空 或 status>=400）" },
        limit: { type: "number", description: "条数上限（≤100，默认 30，取最新）" },
        token: { type: "string" },
      } } },
    // ---- 用户交互型工具：AI 与人在页面上协作（AI 提问 → 人在 AI 窗口/页面作答或拒绝 → 结果回 AI） ----
    // 统一机制：prompt 显示给人看；timeout 为可选——不传=永久等待（面板常驻直到用户操作，不读秒不超时）；
    //   传了才显示读秒倒计时（可暂停）且服务器强制到点返回“用户无响应/不在线”；
    //   交互消息到达时页面走浏览器 Notification（+标题闪烁/提示音）通知用户；人可拒绝（rejectable）。
    // 响应信封：{ status:'answered'|'rejected'|'timeout'|'error', value?, reason?, error?, tookMs, timeoutMs }
    { name: "user_pick_element", description: "请当前页面的人类用户点选一个页面元素（自动进入 Inspector 点选模式、收起 AI 窗口、弹点选面板；用户可确认选中或拒绝）。返回元素载荷 {tag,rect,xpath,text,attributes,framework,selector}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "给用户看的说明（为什么需要点选这个元素）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string", description: "目标页面完整 ID（instanceId/frameId）" },
      }, required: ["prompt"] } },
    { name: "user_confirm", description: "在 AI 窗口内向人类用户提一个是/否问题（如“确认执行此操作？”“是否继续？”），用户点 ✅/❌ 作答，并可附「补充说明」自由文本（value.comment）；另有固定选项「都不适合」→ 自定义回答（approved:null, custom）。返回 {status, approved, comment?, custom?, reason?}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "问题内容" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户以“暂时无法处理”拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送（不阻塞本调用）；缺省=同步等待" },
        pageId: { type: "string" },
      }, required: ["prompt"] } },
    { name: "user_choose", description: "在 AI 窗口内给人类用户一组选项让其选择（如修复方案 A/B/C）。单选（默认）→ value:{index,label}；multiple:true 多选 → value:{indexes,labels}。用户可附「补充说明」自由文本（value.comment）；另有固定选项「这些都不适合」→ 自定义答案（index:-1, custom:true）。返回 {status, value, reason?}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string" },
        choices: { type: "array", items: { type: "string" }, description: "选项列表（2-8 个）" },
        multiple: { type: "boolean", description: "是否允许多选（默认 false；true 时返回 indexes/labels）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" },
      }, required: ["prompt", "choices"] } },
    { name: "user_input", description: "在 AI 窗口内请人类用户输入一段文本（如期望文案、配置值、场景描述），回车/点击即发送。返回 {status, value:{text}, reason?}。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string" },
        defaultValue: { type: "string", description: "预填默认值（可选）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户操作，无读秒；传了才显示读秒倒计时（可暂停），到点自动返回 timeout" },
        rejectable: { type: "boolean", description: "是否允许用户拒绝（默认 true）" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" },
      }, required: ["prompt"] } },
    { name: "user_presence", description: "探测人类用户是否在场/在线（AI 需要用户配合长任务前先确认），用户点「我在/稍后」，可附「补充说明」（value.comment）。返回 {status, present, comment?}；超时即视为不在线。",
      inputSchema: { type: "object", properties: {
        prompt: { type: "string", description: "询问文案（默认“你在吗？需要你配合继续开发”）" },
        timeout: { type: "number", description: "可选超时 ms（5000-600000）。不传=永久等待：面板常驻直到用户作答；传了才显示读秒倒计时（可暂停），到点返回 status:'timeout'（视为不在线）——需要快速探测在场/限时等待时才显式传" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" },
      }, required: [] } },
    { name: "user_notify", description: "非阻塞通知：通过浏览器 Notification 告诉用户一条消息（如“修复完成，请刷新验证”），不等待回答。返回 {notified:true}。",
      inputSchema: { type: "object", properties: {
        title: { type: "string", description: "通知标题" },
        body: { type: "string", description: "通知内容" },
        timeout: { type: "number", description: "可选：通知卡自动关闭时限 ms（5000-600000）。不传=常驻直到用户关闭" },
        async: { type: "boolean", description: "true=异步：立即返回已异步发出，用户作答结果经 AI 消息窗发送；缺省=同步等待" },
        pageId: { type: "string" },
      }, required: ["body"] } },
    // ---- 方案 G · P2：agent 接入 + 消息主通道 ----
    { name: "aiti_hello", description: "agent 自我介绍/注册：覆盖 agentId（默认 clientInfo.name）与 sessionId（默认 Mcp-Session-Id 或桥随机）、绑定默认目标页 pageId、订阅页面事件（page_error）。注意：page_log/page_network 不再实时推送，改用 page_logs/page_network 工具按需拉取。建议会话开始时调用一次——注册后消息可定向到本会话（agentKey=agentId/sessionId）。",
      inputSchema: { type: "object", properties: {
        agentId: { type: "string", description: "自定义 agent 标识（如 pi / cc / qoder；缺省用 clientInfo.name）" },
        sessionId: { type: "string", description: "本实例会话标识（多实例/多会话时区分；缺省用 Mcp-Session-Id，无则桥生成随机）" },
        name: { type: "string", description: "显示名（可选，如 'pi · 工作区A'）" },
        cwd: { type: "string", description: "工作目录（可选，显示 CWD . name (id)，方便识别 agent 身份）" },
        pageId: { type: "string", description: "绑定默认调试目标页（pageId/url/title 均可，留空不绑）" },
        subEvents: { type: "array", items: { type: "string" }, description: "订阅实时事件：page_error（默认不投递，显式订阅才推；page_log/page_network 不再实时推送，改用 page_logs/page_network 工具按需拉取）" },
      } } },
    { name: "file_stat", description: "查询文件存在性/类型/大小/修改时间（绝对路径；组件源码/调用位置定位、AI 窗『后端打开/前端打开』前置校验用）。不存在或非法路径返回 {exists:false}。",
      inputSchema: { type: "object", properties: {
        path: { type: "string", description: "绝对路径（如 /home/user/src/App.vue）" },
      }, required: ["path"] } },
    { name: "aiti_inbox", description: "消息主通道：拉取发给本 agent 会话的消息（人主动发话 user_message / 异步 user_* 作答 user_answer / 订阅的页面事件）。开始新一轮或需要最新信息时先调用；处理完把消息 id 放 ack 参数确认（标记 consumed，历史保留）。返回 agentKey（agentId/sessionId），未注册时提示调 aiti_hello 注册。",
      inputSchema: { type: "object", properties: {
        agentId: { type: "string", description: "agent 标识（缺省用 aiti_hello 注册值或 clientInfo.name）" },
        sessionId: { type: "string", description: "本实例会话标识（缺省用 Mcp-Session-Id 或 aiti_hello 注册值）" },
        ack: { description: "已处理消息 id 列表，或 { ids: [...], summary: '执行总结' }——summary（必带）会作为 agent 处理记录显示在操作台消息流", oneOf: [ { type: "array", items: { type: "string" } }, { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, summary: { type: "string" } } } ] },
      } } },
  ];

  // ---- 挂起请求结算/取消（exec + interaction 共用；agent 停止/客户端取消 → 立即结算，不等服务器超时） ----
  const settlePending = (requestId, ok, result) => {
    const r = pendingRequests.get(requestId);
    if (!r) return false;
    pendingRequests.delete(requestId);
    if (r.mcpReqId) mcpReqMap.delete(r.mcpReqId);
    if (r.cancelId) cancelIdMap.delete(r.cancelId);
    try { if (r.signal && r.onAbort) r.signal.removeEventListener("abort", r.onAbort); } catch {}
    r.resolve({ ok, result });
    return true;
  };
  const cancelPending = (requestId, reason) => {
    const r = pendingRequests.get(requestId);
    if (!r) return false;
    const ist = interactionTimers.get(requestId);
    if (ist) { clearTimeout(ist.timer); interactionTimers.delete(requestId); }
    const result = { status: "cancelled", error: reason, cancelled: true, tookMs: Date.now() - (r.t0 || Date.now()), ...(ist ? { timeoutMs: ist.ms, pausedMs: ist.pausedMs } : {}) };
    settlePending(requestId, false, result);
    for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result }); // AI 窗交互卡同步收尾（取消完成）
    console.log(TAG + " ✂ 请求已取消：" + requestId + " · " + reason);
    return true;
  }

  // M1 · self_ui 扫描表达式（在目标窗口内执行，返回打开的弹窗/表单/按钮清单——ai-helper 回填定位用）
  // page_snapshot 回退：目标页不认内部命令 __snapshot__（如 AI 主窗口 aiti-client 仅实现 CDP 域），
  // 改用其支持的 Runtime.evaluate 跑这份内置快照表达式——收集 URL/标题/交互元素摘要/可见文本头部
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
          var sel = f.id ? ('#' + String(f.id).replace(/([^a-zA-Z0-9_\-])/g, '\\$1')) : (f.name ? ('[name="' + String(f.name).replace(/"/g, '\\"') + '"]') : (isCE ? null : ''));
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

  /** 缺省 self 目标：listSessions 里最新的 self:true 页面（AI 主窗口） */
  function pickSelfPageId() {
    let best = null, bestSeen = 0;
    for (const r of listSessions()) {
      if (r.self && (r.lastSeen || 0) > bestSeen) { best = r.pageId; bestSeen = r.lastSeen || 0; }
    }
    return best || null;
  }

  // M1 · form_fill 回填函数体（在目标窗口内执行；opts 由桥注入）——AI 结果直接操作扩展弹窗表单
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
  }`;;

  function execOnPage(cmd, args, pageId, signal, mcpReqId, cancelId) {
    const { instanceId, frameId } = parsePageId(pageId || LEGACY_TOKEN);
    const page = pages.get(instanceId);
    return new Promise((resolve) => {
      const requestId = "mcp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      const rec: any = { resolve, agentId: null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
      pendingRequests.set(requestId, rec);
      if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
      if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
      // 取消支持（pi-web 点停止/SDK abort）→ 立即结算，不等 15s/180s 超时
      rec.onAbort = () => cancelPending(requestId, "已取消（agent 停止）");
      if (signal) {
        if (signal.aborted) { cancelPending(requestId, "已取消（agent 停止）"); return; }
        rec.signal = signal;
        signal.addEventListener("abort", rec.onAbort, { once: true });
      }
      console.log(TAG + " exec →", cmd, JSON.stringify(args || {}), "→ pageId=" + pageId);
      if (page) { // pageId 定向：直推目标页面连接
        if (!page.writer.write({ type: "exec", requestId, cmd, args: args || {}, frameId })) {
          // 目标连接已死（页面刷新/断开未及时清理）→ 立即失败，不白等 15s
          const irec = idRegistry.get(instanceId);
          if (irec) irec.lastSeen = Date.now();
          pages.delete(instanceId);
          settlePending(requestId, false, { error: "页面连接已断开（重连后重试）" });
          return;
        }
      } else if (frameId === "ai" && aiSelfReg.size > 0) { // M1 · AI 主窗口 self-exec：pageId=<instanceId>/ai → 推对应 AI 连接（via:self 窗口内直接执行，不转发宿主）
        let target = null, bestSeen = 0;
        for (const [w, rec] of aiSelfReg) {
          if (String(rec.instanceId) === String(instanceId) && (rec.lastSeen || 0) > bestSeen) { target = w; bestSeen = rec.lastSeen || 0; }
        }
        if (target) {
          if (!target.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "self" })) {
            aiConns.delete(target); aiSelfReg.delete(target);
            settlePending(requestId, false, { error: "目标 AI 主窗口连接已断开（刷新后自动重连）" });
            return;
          }
        } else if (aiConns.size > 0) { // 实例不匹配但可能刚注册——降级推所有 AI 连接（带 via:self 提示）
          for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "self" });
        } else { setTimeout(() => settlePending(requestId, false, { error: "无执行端（AI 主窗口未连接），先连接桥" }), 100); return; }
      } else if (aiPageReg.size > 0) { // AI 宿主页定向：pageId/instanceId 匹配 AI 窗注册的宿主页 → 精确推该 AI 连接（via ai → AI 窗 useForward 转发宿主执行）
        let target = null, targetRec = null, viaFrameId = null, bestSeen = 0;
        for (const [w, rec] of aiPageReg) {
          const baseId = String(rec.pageId || "").replace(/\/host$/, "");
          if (rec.pageId === pageId || (baseId && pageId && String(pageId).indexOf(baseId + "/") === 0)) {
            // 多 AI 窗注册同一宿主页 → 选 lastSeen 最新（最活跃）的连接；不选第一个，避免陈旧窗口丢消息
            if (!target || (rec.lastSeen || 0) > bestSeen) { target = w; targetRec = rec; bestSeen = rec.lastSeen || 0; }
          }
        }
        if (target && targetRec) {
          // 帧提取：pageId = <baseId>/<frameId>（host 帧与 rec.pageId 精确匹配）；frameId 随 exec 转发宿主定向执行（嵌套 fN/0 在宿主侧降级到 fN）
          const baseId = String(targetRec.pageId || "").replace(/\/host$/, "");
          if (pageId && baseId && String(pageId).indexOf(baseId + "/") === 0) viaFrameId = String(pageId).slice(baseId.length + 1) || "host";
          if (!target.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai", frameId: viaFrameId })) {
            // 目标 AI 窗连接已死（断线未重连）→ 移除死连接 + 快速失败（不再白等 15s）
            aiConns.delete(target); aiPageReg.delete(target);
            settlePending(requestId, false, { error: "目标 AI 窗连接已断开（页面刷新后自动重连，稍后重试）" });
            return;
          }
        } else if (aiConns.size > 0) { for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai" }); }
        else { setTimeout(() => settlePending(requestId, false, { error: "无执行端（页面/AI 通道均未连接），先连接桥" }), 100); return; }
      } else if (aiConns.size > 0) { // 降级推 AI 连接
        for (const w of aiConns) w.write({ type: "exec", requestId, cmd, args: args || {}, pageId, via: "ai" });
      } else {
        setTimeout(() => settlePending(requestId, false, { error: "无执行端（页面/AI 通道均未连接），先连接桥" }), 100);
        return;
      }
      // 需用户交互的命令（手势确认卡/危险确认/浏览器原生选择器）→ 长超时：用户 15s 内点不完确认+选择器+授权。
      // 与 launcher GESTURE_COMMANDS/DANGER_COMMANDS 同步维护（core 无法 import launcher 常量，单表小成本）。
      const SLOW_EXEC_CMDS = new Set([
        "Page.captureScreenshot", "Browser.paste", "Browser.pickFile", "Browser.share",
        "DOM.removeNode", "Page.reload", "Page.navigate", "Storage.localStorageClear", "Storage.localStorageSet",
      ]);
      // 慢命令安全网——客户端自身超时先到；Page.captureScreenshot 支持 args.timeout（ms，截屏确认卡倒计时，
      // 与客户端同值）：安全网 = 指定值 + 30s 结算余量（下限 60s，上限 1h），未指定维持 300s
      const slowNet = (function () {
        if (!SLOW_EXEC_CMDS.has(cmd)) return 15000;
        if (cmd === "Page.captureScreenshot") {
          const n = parseInt(args && args.timeout, 10);
          if (n > 0) return Math.min(Math.max(n + 30000, 60000), 3600000);
        }
        return 300000;
      })();
      setTimeout(() => settlePending(requestId, false, { error: "页面执行超时" + (SLOW_EXEC_CMDS.has(cmd) ? "（用户未完成确认/选择）" : "") }), slowNet);
    });
  }

  // ---------------- 用户交互型工具（AI ↔ 人在页面上协作） ----------------
  // 统一机制：AI 提问 → 推 {type:'interaction'} 给 AI 窗口连接（作答卡）与页面连接（通知/点选面板）；
  //   人作答/拒绝 → POST /bridge/result 回桥 → resolve；超时服务器端强制（不依赖页面连接/用户在线）
  const INTERACTION_MAX_TIMEOUT_MS = 600000;
  const INTERACTION_MIN_TIMEOUT_MS = 5000;
  // timeout 为可选参数（非默认）：不传/0 = 永久等待——面板常驻直到用户操作，不读秒不超时（用户要求：
  // 默认读秒带来紧迫感，除非 AI 特意需要限时催促才传）；AI 明确传 timeout 才倒计时读秒（面板 ⏱ 可暂停），
  // 到点服务器强制结算 status:'timeout'
  const clampTimeout = (ms) => {
    const n = parseInt(ms, 10);
    if (!n || n <= 0) return 0;
    return Math.min(Math.max(n, INTERACTION_MIN_TIMEOUT_MS), INTERACTION_MAX_TIMEOUT_MS);
  };
  // 交互请求的服务器端计时状态（支持用户暂停/继续倒计时：⏸ 后服务器计时停止，不超时）
  const interactionTimers = new Map(); // requestId -> { timer, deadline, remaining, paused, pausedAt, pausedMs, resolve, ms, t0 }
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
        for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result }); // 窗口交互卡同步收尾（超时完成）
      }
    };
    if (st.remaining <= 0) { fire(); return { ok: true, paused: false, remainingMs: 0, timedOut: true }; }
    st.timer = setTimeout(fire, st.remaining);
    console.log(TAG + " interaction ▶ 继续 requestId=" + requestId + " remaining=" + st.remaining + "ms");
    return { ok: true, paused: false, remainingMs: st.remaining };
  };
  const clearInteractionTimer = (requestId) => {
    const st = interactionTimers.get(requestId);
    if (st) { clearTimeout(st.timer); interactionTimers.delete(requestId); }
  };


  function interactOnPage(interaction: Record<string, any>, pageId?: string, timeoutMs?: number, signal?: AbortSignal, mcpReqId?: string | null, cancelId?: string | null) {
    const { instanceId, frameId } = parsePageId(pageId || LEGACY_TOKEN);
    const page = pages.get(instanceId);
    // M1·AI 主窗口定向：pageId=<instanceId>/ai → 直接推对应 AI 连接（self 窗口内渲染作答卡，不广播）
    let aiTarget: any = null;
    if (frameId === "ai") { for (const [w, rec] of aiSelfReg) if (rec.instanceId === instanceId) { aiTarget = w; break; } }
    const ms = clampTimeout(timeoutMs);
    const t0 = Date.now();
    const payload = { ...interaction, timeoutMs: ms };
    const isAsync = !!payload.async; // 异步：MCP 立即返回"已异步发出"，用户作答结果经 AI 消息窗发送（前端 bridge）
    return new Promise((resolve) => {
      const requestId = "ui_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
      if (isAsync) {
        console.log(TAG + " interaction（异步）→ kind=" + payload.kind + " · " + String(payload.prompt || "").slice(0, 60) + " → pageId=" + pageId + (payload.agentId ? " · agent=" + payload.agentId : ""));
        resolve({ ok: true, result: { status: "async", message: "已异步发出：用户作答后结果将进发起 agent（" + (payload.agentId || "?") + "）的 aiti_inbox" } });
      } else {
        const rec: any = { resolve, agentId: payload.agentId || null, t0: Date.now(), signal: null, onAbort: null, mcpReqId: mcpReqId || null, cancelId: cancelId || null };
        pendingRequests.set(requestId, rec);
        if (rec.mcpReqId) mcpReqMap.set(rec.mcpReqId, requestId);
        if (rec.cancelId) cancelIdMap.set(rec.cancelId, requestId);
        // 取消支持（pi-web 点停止/SDK abort）→ 立即结算 + AI 窗交互卡收尾
        rec.onAbort = () => cancelPending(requestId, "已取消（agent 停止）");
        if (signal) {
          if (signal.aborted) { cancelPending(requestId, "已取消（agent 停止）"); return; }
          rec.signal = signal;
          signal.addEventListener("abort", rec.onAbort, { once: true });
        }
        console.log(TAG + " interaction → kind=" + payload.kind + " · " + String(payload.prompt || "").slice(0, 60) + " → pageId=" + pageId + " · timeout=" + (ms > 0 ? ms + "ms" : "∞（永久等待）") + (payload.agentId ? " · agent=" + payload.agentId : ""));
      }
      const noExecutor = () => { clearInteractionTimer(requestId); cancelPending(requestId, "无执行端（页面/AI 通道均未连接），先连接桥"); };
      if (aiTarget) {
        // 定向 AI 主窗口（frameId=ai）：self 窗口内直接渲染作答卡；连接失效则退广播
        if (!aiTarget.write({ type: "interaction", requestId, interaction: payload, frameId: "ai", via: "self" })) {
          aiConns.delete(aiTarget); aiSelfReg.delete(aiTarget);
          if (aiConns.size > 0) { for (const w of aiConns) w.write({ type: "interaction", requestId, interaction: payload, pageId, via: "ai" }); }
          else return noExecutor();
        }
      } else if (payload.kind === "pick_element") {
        if (page) {
          if (!page.writer.write({ type: "interaction", requestId, interaction: payload, frameId })) { pages.delete(instanceId); return noExecutor(); }
        }
        else if (aiConns.size > 0) { for (const w of aiConns) w.write({ type: "interaction", requestId, interaction: payload, pageId, via: "ai" }); }
        else return noExecutor();
      } else {
        // confirm/choose/input/presence：页面优先渲染宿主问答面板（AI 窗是 pi-web 无作答卡——宿主面板作答）；
        // 页面未连时降级推 AI 连接（至少通知）
        if (page) {
          if (!page.writer.write({ type: "interaction", requestId, interaction: payload, frameId })) { pages.delete(instanceId); return noExecutor(); }
        }
        else if (aiConns.size > 0) { for (const w of aiConns) w.write({ type: "interaction", requestId, interaction: payload, pageId, via: "ai" }); }
        else return noExecutor();
      }
      // 服务器强制超时（可暂停/继续）：到期必回 'timeout'（用户无响应/不在线）——仅同步模式；
      // timeout=0（未传，永久等待）不设服务器计时——面板常驻直到作答/取消（agent 停止走 cancelPending）
      if (!isAsync && ms > 0) {
        const st = { timer: null, deadline: Date.now() + ms, remaining: ms, paused: false, pausedAt: null, pausedMs: 0, ms, t0, resolve };
        interactionTimers.set(requestId, st);
        st.timer = setTimeout(() => {
          if (!interactionTimers.delete(requestId)) return;
          const result = { status: "timeout", error: "用户无响应（不在线或未处理）", tookMs: Date.now() - t0, timeoutMs: ms, pausedMs: st.pausedMs };
          if (settlePending(requestId, false, result)) {
            for (const w of aiConns) w.write({ type: "result", requestId, ok: false, result }); // 窗口交互卡同步收尾（超时完成）
          }
        }, ms);
      }
    });
  }

  function handleMcpRequest(req, session = null, signal = null, cancelId = null) {
    const params = req.params || {};
    switch (req.method) {
      case "initialize": return {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: DISPLAY_NAME, version: "0.2" },
        instructions: [
          "aiti-devtools：页面内 AI 调试助手（浏览器桥）。",
          "工作流：页面发来的消息通常带 pageId。没有也可以先用 bridge_status 发现已连接页面（返回 sessions，含 pageId/url/title/frameworks/device——deviceLabel 一行的浏览器·屏幕·在线·语言可快速识别是哪台机器哪个标签）→ 把 pageId 传给目标工具。",
          "pageId 格式为 instanceId/frameId（如 30142/host）；也可直接传 url 或页面标题；命中多个时需具体 pageId 指定。",
          "page_exec：在已连接页面执行类 CDP 命令（DOM/CSS/Input/Page/Runtime/Storage/Performance/Browser 域）。args 为命令参数对象。危险命令（导航/下载/对话框等）会自动弹用户确认。截屏（Page.captureScreenshot）务必在 args 带 reason（一句话向用户说明想截什么，页面会先弹准备卡展示该说明、用户调整好页面才开始截屏）。",
          "page_snapshot：拉取目标页面基础现场（URL/选区/模拟条件）。",
          "page_logs / page_network：排查页面报错/请求失败首选——page_logs 查 console（可 level/since/limit 过滤，先看 warn/error）；page_network 查 ajax/fetch 完成态（status≥400 或 errorOnly:true 只看失败）。两者均读页面本地缓冲（CDP Runtime.evaluate 按需拉取，不再实时上报）。",
          "user_confirm / user_choose / user_input / user_pick_element / user_presence：AI 与人类用户在页面上协作——prompt 给用户看，默认同步等待且永久等待（不传 timeout：面板常驻直到用户作答，无读秒；仅在确需限时催促时传 timeout ms，面板显示读秒倒计时可暂停，到点返回 status:'timeout'），响应信封 {status:'answered'|'rejected'|'timeout'|'error', value?, reason?, tookMs, timeoutMs}。传 async:true 可立即返回（结果经 AI 消息窗送达）。",
          "user_notify：非阻塞浏览器通知，不等待回答。",
          "常见用法：页面报错→page_logs(level:warn/error) 或 page_network(errorOnly:true)；操作页面→page_exec(cmd:'Runtime.evaluate', args:{expression:'...'})；定位元素→page_snapshot 后再 page_exec 或请用户 user_pick_element。",
        ].join("\n"),
      };
      case "notifications/initialized": return null;
      case "notifications/cancelled": {
        // MCP 协议取消：params.requestId = 原 tools/call 的 jsonrpc id → 映射内部 requestId → 立即结算
        const rid = params && params.requestId !== undefined ? String(params.requestId) : "";
        if (rid) { const internalId = mcpReqMap.get(rid); if (internalId) cancelPending(internalId, "已取消（MCP notifications/cancelled）"); }
        return null;
      }
      case "ping": return {};
      case "tools/list": return { tools: TOOLS };
      case "resources/list": return { resources: [] };
      case "tools/call": {
        // 通用容错：AI 拼错参数一律兼容——cmd/pageId 误放 args（扁平化）、args 是 JSON 字符串、cmd 小写
        const a = params.arguments || {};
        const rawArgs = (() => { let x = a.args; if (typeof x === "string") { try { x = JSON.parse(x); } catch { /* 保留 */ } } return x && typeof x === "object" ? x : {}; })();
        const cmdRaw = a.cmd || rawArgs.cmd || a.command || rawArgs.command;
        const cmd = (typeof cmdRaw === "string" && cmdRaw.includes(".")) ? cmdRaw.replace(/^./, (c) => c.toUpperCase()) : cmdRaw; // 大小写归一
        const pageId = a.pageId || rawArgs.pageId || a.target || rawArgs.target;
        const cmdArgs = { ...rawArgs };
        delete cmdArgs.cmd; delete cmdArgs.command; delete cmdArgs.pageId; delete cmdArgs.target; delete cmdArgs.token;
        // agent 工具调用 → cockpit 消息流（用户实时看到 agent 在页面上做了什么；aiti_inbox/aiti_hello 是消息通道原语，不记录避免刷屏）
        const recAgentKey = (session && session.agentKey) || (session && session.agentId ? session.agentId + (session.id ? "/" + session.id : "") : null) || null;
        const recToolCall = (text: string, ok: boolean, detail?: any) => {
          if (!recAgentKey) return;
          const m = { id: randomBytes(4).toString("hex"), kind: "agent_tool", from: "agent", agentKey: recAgentKey, agentId: recAgentKey.split("/")[0], sessionId: recAgentKey.split("/").slice(1).join("/") || null, source: (agents.get(recAgentKey) || {}).source || "unknown", text: String(text).slice(0, 2000), detail: detail === undefined ? null : (typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 4000)), at: new Date().toISOString(), status: ok ? "ok" : "error" };
          appendMsgEvent(recAgentKey, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
          for (const w of aiConns) w.write({ type: "agent_answer", agentKey: recAgentKey, agentId: recAgentKey.split("/")[0], ok, text: m.text, at: m.at, detail: m.detail }); // cockpit 实时显示
        };
        // bridge_status：无需目标页——直接在页面解析前返回 sessions（可能为空 []，不应报错）
        if (params.name === "bridge_status") {
          // 从 agent 记录拿当前绑定的 pageId → 传给 listSessions 打 mine 标记 + 顶层 activePageId
          const curAgentKey = (session && session.agentKey) || (session && session.agentId ? session.agentId + (session.id ? "/" + session.id : "") : null) || null;
          const boundPageId = (curAgentKey && agents.get(curAgentKey) && agents.get(curAgentKey).boundPageId) || null;
          const sess = listSessions(boundPageId);
          const resp = { sessions: sess, activePageId: boundPageId || null };
          recToolCall("🛠 bridge_status → " + sess.length + " 个已连接页面" + (boundPageId ? " · 当前绑定: " + boundPageId : ""), true, resp);
          return { content: [{ type: "text", text: JSON.stringify(resp) }], isError: false };
        }
        // file_stat：文件存在性/类型/大小（无页面依赖；组件源码/调用位置定位 + AI 窗打开前置校验）
        if (params.name === "file_stat") {
          const fp = String(a.path || "").trim();
          const out: Record<string, any> = { path: fp || null, exists: false, isFile: false, isDirectory: false, size: null, mtime: null };
          if (fp) {
            try {
              const st = statSync(fp);
              out.exists = true;
              out.isFile = st.isFile();
              out.isDirectory = st.isDirectory();
              out.size = st.isFile() ? st.size : null;
              out.mtime = st.mtimeMs;
            } catch { /* 不存在/无权限 */ }
          }
          recToolCall("🛠 file_stat(" + (fp || "") + ") → " + (out.exists ? (out.isFile ? "文件 " + out.size + "B" : "目录") : "不存在"), out.exists);
          return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
        }
        // 方案 F-3：页面 console 日志 / 网络请求按需拉取——数据留在页面本地缓冲，通过 CDP Runtime.evaluate 读取
        if (params.name === "page_logs" || params.name === "page_network") {
          const isLog = params.name === "page_logs";
          const ringExpr = isLog
            ? "(() => { try { var r = window.__dbg && window.__dbg.__consoleRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 200) + "); } catch(e) { return []; } })()"
            : "(() => { try { var r = window.__dbg && window.__dbg.__netRing; if (!r) return []; return r.slice(-" + (parseInt(a.limit, 10) || 100) + "); } catch(e) { return []; } })()";
          // pageId 缺省兜底 AI 主窗口（self:true，同 self_ui/form_fill）；显式 pageId 永远优先
          const target = (pageId && String(pageId)) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) { recToolCall("🛠 " + params.name + " → ⚠ 页面匹配多个", false); return { content: [{ type: "text", text: "页面匹配多个（按 url/title）：" + resolved.multiple.join(", ") + "——请用具体 pageId 指定" }], isError: true }; }
          if (resolved.notFound) { recToolCall("🛠 " + params.name + " → ⚠ 未找到匹配页面", false); return { content: [{ type: "text", text: "未找到匹配页面（pageId/url/title 均未命中）——用 bridge_status 查看可用 pageId" }], isError: true }; }
          const mcpReqId = (req && req.id !== undefined) ? String(req.id) : null;
          return execOnPage("Runtime.evaluate", { expression: ringExpr }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const raw = (r.ok && r.result && r.result.value !== undefined) ? r.result.value : [];
            let rows = Array.isArray(raw) ? raw : [];
            if (isLog) {
              if (a.level) rows = rows.filter((l) => l.level === a.level);
              if (a.since) { const t = Date.parse(a.since); if (!isNaN(t)) rows = rows.filter((l) => l.ts >= t); }
            } else {
              if (a.url) rows = rows.filter((rq) => String(rq.url || "").includes(String(a.url)));
              if (a.status) rows = rows.filter((rq) => (rq.status || 0) >= Number(a.status));
              if (a.errorOnly) rows = rows.filter((rq) => rq.error || (rq.status || 0) >= 400);
            }
            const limit = Math.min(parseInt(a.limit, 10) || (isLog ? 50 : 30), isLog ? 200 : 100);
            rows = rows.slice(-limit);
            const out = isLog ? { logs: rows, bufferSize: (Array.isArray(raw) ? raw.length : 0) } : { requests: rows, bufferSize: (Array.isArray(raw) ? raw.length : 0) };
            recToolCall("🛠 " + params.name + "(" + resolved.pageId + ") → " + rows.length + " 条", true, out);
            return { content: [{ type: "text", text: JSON.stringify(out) }], isError: false };
          });
        }
        // page_exec/page_snapshot：pageId 可传 url/title（resolvePageId 静默解析）；user_* 的 pageId 可选（不校验）
        if (params.name === "page_exec" || params.name === "page_snapshot") {
          // pageId 缺省兜底 AI 主窗口（self:true，同 self_ui/form_fill）；显式 pageId 永远优先
          const target = (pageId && String(pageId)) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (resolved.multiple) { recToolCall("🛠 " + params.name + " → ⚠ 页面匹配多个：" + resolved.multiple.join(", "), false); return { content: [{ type: "text", text: "页面匹配多个（按 url/title）：" + resolved.multiple.join(", ") + "——请用具体 pageId 指定（bridge_status 可查）" }], isError: true }; }
          if (resolved.notFound) { recToolCall("🛠 " + params.name + (pageId ? "(" + pageId + ")" : "") + " → ⚠ 未找到匹配页面", false); return { content: [{ type: "text", text: "未找到匹配页面（pageId/url/title 均未命中）——用 bridge_status 查看可用 pageId" }], isError: true }; }
          const mcpReqId = (req && req.id !== undefined) ? String(req.id) : null;
          const runPageTool = params.name === "page_exec"
            ? execOnPage(cmd, cmdArgs, resolved.pageId, signal, mcpReqId, cancelId)
            : execOnPage("__snapshot__", {}, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
                // 回退：目标页不认内部命令 __snapshot__（AI 主窗口 aiti-client 仅实现 CDP 域）
                // → 用其支持的 Runtime.evaluate 跑内置快照表达式；结果仍是 {ok,result} 信封
                const txt = JSON.stringify(r.result || r);
                if (r.ok || txt.indexOf("unknown command: __snapshot__") === -1) return r;
                return execOnPage("Runtime.evaluate", { expression: SNAPSHOT_FALLBACK, returnByValue: true }, resolved.pageId, signal, mcpReqId, cancelId).then((r2) => {
                  if (!r2.ok) return r2;
                  const ro = r2.result && r2.result.result ? r2.result.result : r2.result;
                  let val = (ro && ro.value !== undefined) ? ro.value : ro;
                  if (typeof val === "string") { try { val = JSON.parse(val); } catch { /* 保持字符串 */ } }
                  return { ok: true, result: val };
                });
              });
          return runPageTool.then((r) => {
            recToolCall("🛠 " + params.name + "(" + resolved.pageId + ")" + (params.name === "page_exec" && cmd ? " · " + String(cmd).slice(0, 80) : "") + " → " + (r.ok ? "ok" : "失败"), !!r.ok, { tool: params.name, request: params.name === "page_exec" ? { cmd, args: cmdArgs } : { pageId: resolved.pageId }, response: r.result || r, at: new Date().toISOString() });
            return { content: [{ type: "text", text: JSON.stringify(r.result || r) }], isError: !r.ok };
          });
        }
        // self_ui：扫描目标页面（缺省 AI 主窗口 xxx/ai）打开的弹窗/表单/按钮（M1；ai-helper 回填定位）
        if (params.name === "self_ui") {
          const target = (pageId && String(pageId)) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) { recToolCall("🛠 self_ui → 未找到目标页面（无 AI 主窗口连接或 pageId 未命中）", false); return { content: [{ type: "text", text: "未找到目标页面——需 AI 主窗口已连接（bridge_status 可见 xxx/ai），或指定 pageId" }], isError: true }; }
          const mcpReqId = (req && req.id !== undefined) ? String(req.id) : null;
          return execOnPage("Runtime.evaluate", { expression: SELF_UI_SCAN }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const val = (r.ok && r.result && r.result.value !== undefined) ? r.result.value : (r.result || r);
            recToolCall("🛠 self_ui(" + resolved.pageId + ") → " + (r.ok ? ((val && val.dialogs) ? val.dialogs.length + " 个弹窗" : "无弹窗") : "失败"), !!r.ok, { tool: "self_ui", pageId: resolved.pageId, response: val });
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        // form_fill：把 AI 结果直接回填到目标页面弹窗表单（M1；React 兼容 setter + 可选点按钮）
        if (params.name === "form_fill") {
          const target = (pageId && String(pageId)) || pickSelfPageId();
          const resolved = target ? resolvePageId(target) : { notFound: true };
          if (!resolved.pageId) { recToolCall("🛠 form_fill → 未找到目标页面", false); return { content: [{ type: "text", text: "未找到目标页面——需 AI 主窗口已连接，或指定 pageId" }], isError: true }; }
          const mcpReqId = (req && req.id !== undefined) ? String(req.id) : null;
          const opts = { dialog: a.dialog || null, fields: a.fields || [], button: a.button || null };
          const expression = "(" + FORM_FILL_FN + ")(" + JSON.stringify(opts) + ")";
          return execOnPage("Runtime.evaluate", { expression }, resolved.pageId, signal, mcpReqId, cancelId).then((r) => {
            const val = (r.ok && r.result && r.result.value !== undefined) ? r.result.value : (r.result || r);
            recToolCall("🛠 form_fill(" + resolved.pageId + ") → " + (r.ok ? ((val && val.foundDialog) ? "填 " + val.filled + " 字段" + (val.clicked ? "，点按钮" : "") : "未找到弹窗") : "失败"), !!r.ok, { tool: "form_fill", pageId: resolved.pageId, response: val });
            return { content: [{ type: "text", text: JSON.stringify(val) }], isError: !r.ok };
          });
        }
        // ---- 用户交互型工具（AI ↔ 人协作；响应信封见 TOOLS 注释） ----
        const interact = (interaction: Record<string, any>, timeout?: number) => {
          const mcpReqId = (req && req.id !== undefined) ? String(req.id) : null;
          const targetPageId = pageId || boundPageIdFor(session) || undefined;   // 目的方兕底：agent 绑定页 / 最新 AI 主窗口
          return interactOnPage({ ...interaction, agentId: (session && session.agentKey) || (session && session.agentId) || a.agentId || null }, targetPageId, timeout, signal, mcpReqId, cancelId)
            .then((r) => {
              recToolCall("🛠 " + interaction.kind + " → " + (r.ok ? "已作答" : (r.result && r.result.status) || "失败/拒绝"), !!r.ok);
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
          const choices = (Array.isArray(a.choices) && a.choices.length) ? a.choices.map(String).slice(0, 8) : ["选项 A", "选项 B"];
          return interact({ kind: "choose", prompt: String(a.prompt || "请选择一项"), choices, multiple: !!a.multiple, rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_input") {
          return interact({ kind: "input", prompt: String(a.prompt || "请输入"), defaultValue: String(a.defaultValue || ""), rejectable: a.rejectable !== false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_presence") {
          return interact({ kind: "presence", prompt: String(a.prompt || "你在吗？需要你配合继续开发"), rejectable: false, async: a.async === true }, a.timeout);
        }
        if (params.name === "user_notify") {
          // 非阻塞：推给 AI 窗 + 页面（页面走浏览器通知），立即返回
          const notif = { kind: "notify", title: String(a.title || "🤖 AI 有一条消息"), body: String(a.body || a.prompt || ""), timeoutMs: clampTimeout(a.timeout) };
          const rid = "notify_" + Date.now();
          for (const w of aiConns) w.write({ type: "interaction", requestId: rid, interaction: notif, pageId });
          const pg = pages.get(parsePageId(pageId || LEGACY_TOKEN).instanceId);
          if (pg) pg.writer.write({ type: "interaction", requestId: rid, interaction: notif, frameId: parsePageId(pageId || LEGACY_TOKEN).frameId, render: "notify-only" });
          recToolCall("🔔 user_notify → " + String(notif.body).slice(0, 60), true);
          return { content: [{ type: "text", text: JSON.stringify({ status: "sent", notified: true, title: notif.title }) }], isError: false };
        }
        // ---- 方案 G · P2：agent 接入 + 消息主通道（多 agent/session：agentKey = agentId/sessionId） ----
        if (params.name === "aiti_hello") {
          const agentId = String(a.agentId || (session && session.agentId) || "pi");
          const sessionId = a.sessionId || (session && session.id) || null; // 显式 sessionId > Mcp-Session-Id > 桥随机
          const { a: agent, key } = ensureAgent(agentId, sessionId, session);
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "agent 注册失败" }) }], isError: true };
          agent.registered = true; // 显式注册（带 agentId/sessionId）
          agent.name = a.name || agent.name;
          if (typeof a.cwd === "string" && a.cwd) agent.cwd = a.cwd;
          if (session) { session.agentId = agentId; session.agentKey = key; } // 会话内后续调用（aiti_inbox/interact）用注册后的 key
          if (a.pageId) { const resolved2 = resolvePageId(a.pageId); agent.boundPageId = (resolved2.pageId || a.pageId); }
          if (Array.isArray(a.subEvents)) agent.subEvents = new Set(a.subEvents.map(String));
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, agentKey: key, agentId, sessionId: agent.sessionId, boundPageId: agent.boundPageId || null, subEvents: [...agent.subEvents], inboxPending: agent.outbox.filter((m) => m.status !== "consumed").length }) }], isError: false };
        }
        if (params.name === "aiti_inbox") {
          const agentId = String(a.agentId || (session && session.agentId) || "pi");
          const sessionId = a.sessionId || (session && session.id) || (session && session.agentKey ? session.agentKey.split("/").slice(1).join("/") : null) || null;
          const { a: agent, key } = ensureAgent(agentId, sessionId, session);
          if (!agent) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "unknown agent：先 aiti_hello 或带 agentId/sessionId" }) }], isError: true };
          if (session && !session.agentKey) session.agentKey = key;
          if (Array.isArray(a.ack) || (a.ack && typeof a.ack === "object")) {
            // ack：消息 id 数组（旧）或 { ids, summary }（新）——ack 必带执行总结，桥生成 agent 处理记录（cockpit 可见）
            const ackIds = Array.isArray(a.ack) ? a.ack.map(String) : ((a.ack && a.ack.ids) || []).map(String);
            const summary = (!Array.isArray(a.ack) && a.ack && typeof a.ack.summary === "string" && a.ack.summary.trim()) || "";
            let ackedAny = false;
            for (const id of ackIds) {
              const m = agent.outbox.find((x) => x.id === id && x.status !== "consumed");
              if (m) { m.status = "consumed"; m.ackedAt = Date.now(); m.summary = summary || null; ackedAny = true; appendMsgEvent(key, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: id, status: "consumed", timestamp: new Date().toISOString() }); }
            }
            if (ackedAny) {
              // 处理记录（agent_summary）：ack 必带总结——模型提供 summary，或默认提示补总结
              const text = summary || `✅ 已处理 ${ackIds.length} 条消息（未附总结——建议 ack 时带 summary）`;
              const rid = randomBytes(4).toString("hex");
              const rec = { id: rid, kind: "agent_summary", from: "agent", agentKey: key, agentId, sessionId: agent.sessionId, text, ackedIds: ackIds, at: new Date().toISOString(), status: "ok" };
              agent.outbox.push(rec); // 记录进消息流（历史保留）
              appendMsgEvent(key, { type: "message", id: rid, parentId: null, timestamp: rec.at, message: rec });
              for (const w of aiConns) w.write({ type: "agent_answer", agentKey: key, agentId, ok: true, text, at: Date.now(), summary: true }); // cockpit 实时显示
            }
          }
          const out = [];
          for (const m of agent.outbox) {
            if (m.status === "consumed") continue;
            if (m.status === "pending") { m.status = "delivered"; appendMsgEvent(key, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: m.id, status: "delivered", timestamp: new Date().toISOString() }); }
            out.push({ id: m.id, kind: m.kind, from: m.from, agentKey: key, agentId, sessionId: agent.sessionId, pageId: m.pageId || (m.payload && m.payload.pageId) || null, url: m.url || (m.payload && m.payload.url) || null, text: m.text ?? null, payload: m.payload || null, at: m.at, status: m.status });
          }
          for (const w of aiConns) w.write({ type: "event", from: "agent", event: "inbox_status", payload: { agentKey: key, queueSize: agent.outbox.filter((x) => x.status !== "consumed").length } });
          const guide = agent.registered ? "" : " ⚠ 未显式注册（随机 session）——建议调 aiti_hello 传 agentId/sessionId 注册，消息将绑定到该会话";
          return { content: [{ type: "text", text: JSON.stringify({ agentKey: key, registered: agent.registered, messages: out, queueSize: agent.outbox.filter((x) => x.status !== "consumed").length, guide }) }], isError: false };
        }
        return { content: [{ type: "text", text: "unknown tool: " + params.name }], isError: true };
      }
      default: return { error: "unknown method " + req.method };
    }
  }

  // ---------------- 后台打开源文件（编辑器优先，系统默认兜底；跨平台 win/mac/linux） ----------------
  // 编辑器：AITI_OPEN_CMD 显式指定 → $EDITOR/$VISUAL → 系统默认（按文件类型的编辑/查看程序）。
  //   linux: xdg-open · mac: open · win: cmd /c start（系统默认程序）——均不传 :line（系统打开程序不认）；
  //   编辑器：code 系（code/cursor/windsurf/zed…）用 --goto file:line 跳转，其他编辑器传 target/文件。
  // AITI_OPEN_CMD 可带参数（如 `code --reuse-window` / `"C:\\Program Files\\...\\code.exe" --goto`）——引号感知拆分
  function parseCmdStr(cmdStr: string): { exe: string; args: string[] } {
    const parts: string[] = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cmdStr))) parts.push(m[1] !== undefined ? m[1] : m[2]);
    return { exe: parts[0] || "", args: parts.slice(1) };
  }
  function isCodeLikeEditor(name: string): boolean {
    // 支持 file:line 跳转的编辑器（VS Code 系 + 现代编辑器统一 --goto）
    return /(^|[\\/])(code|code-insiders|cursor|windsurf|codium|vscodium|zed)(\.exe|\.cmd|\.bat)?$/i.test(name);
  }
  // 桌面会话检测：Linux 上 systemd/无头服务（无 DISPLAY/WAYLAND）下 xdg-open 与 GUI 编辑器无法弹窗；
  //   win（start）/ mac（open）不依赖 DISPLAY——但 mac 的 open 需要用户会话（launchd 下仍可用）。
  //   仅用于「系统默认打开器」与「编辑器 spawn 失败后的 fallback」的可用性判定；AITI_OPEN_CMD 显式指定时不拦截（尊重用户配置）
  function hasDesktopSession(): boolean {
    if (process.platform !== "linux") return true;
    return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE || Object.keys(desktopEnv()).length);
  }
  // 桌面环境自动探测注入：systemd/无头服务进程没有 DISPLAY/WAYLAND/DBus——但机器上可能有用户 X/Wayland 会话，
  //   探测 /tmp/.X11-unix/X{n}（DISPLAY）、当前会话 Xauthority、/run/user/<uid> 的 wayland/bus/XDG_RUNTIME_DIR，
  //   注入 spawn 环境后 GUI 编辑器（code 等）/ xdg-open 可连到用户桌面打开。探测不到时返回空（外层报无桌面会话）
  function desktopEnv(): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      const home = process.env.HOME || "";
      // X11：/tmp/.X11-unix/X{n} → DISPLAY=:n
      try {
        const xs = readdirSync("/tmp/.X11-unix").filter((f) => /^X\d+$/.test(f)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
        if (xs.length && !out.DISPLAY) out.DISPLAY = ":" + xs[0].slice(1);
      } catch {}
      // XAUTHORITY：当前 X session 的 auth（Xorg/gdm 用）优先，fallback 家目录
      const authCands: string[] = [];
      if (uid != null) authCands.push(`/run/user/${uid}/gdm/Xauthority`);
      authCands.push(`${home}/.Xauthority`);
      for (const a of authCands) {
        try { if (a && existsSync(a)) { out.XAUTHORITY = a; break; } } catch {}
      }
      // Wayland + XDG_RUNTIME_DIR + DBus（GUI 程序常依赖）
      if (uid != null) {
        try {
          const ws = readdirSync(`/run/user/${uid}`).filter((f) => /^wayland-\d+$/.test(f)).sort();
          if (ws.length) out.WAYLAND_DISPLAY = ws[0];
        } catch {}
        try {
          if (existsSync(`/run/user/${uid}/bus`)) {
            out.XDG_RUNTIME_DIR = `/run/user/${uid}`;
            out.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
          }
        } catch {}
      }
    } catch {}
    return out;
  }
  function openFileInEditor(file: string, line: number | null | undefined) {
    return new Promise((resolve) => {
      if (!file) return resolve({ ok: false, error: "缺少 file" });
      const platform = process.platform; // win32 | darwin | linux | …
      const isWin = platform === "win32";
      const target = file + (line ? ":" + line : "");
      const cmdRaw = process.env.AITI_OPEN_CMD || process.env.EDITOR || process.env.VISUAL || "";
      const { exe, args: cmdArgs } = cmdRaw ? parseCmdStr(cmdRaw) : { exe: "", args: [] };
      // 系统默认打开器（按文件类型）：linux xdg-open / mac open / win start（cmd /c start "" "file"）——注入桌面环境（systemd 无 DISPLAY 时探测用户会话）
      const defaultOpen = (f: string) => {
        if (isWin) return spawn("cmd", ["/c", "start", "", f], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...desktopEnv() } });
        return spawn(platform === "darwin" ? "open" : "xdg-open", [f], { detached: true, stdio: "ignore", env: { ...process.env, ...desktopEnv() } });
      };
      let child: any;
      if (exe) {
        const codeLike = isCodeLikeEditor(exe);
        // 用户参数可能已含 --goto（如 `code --goto`）——去重后再补，避免重复
        const args = [...cmdArgs];
        if (codeLike && !args.includes("--goto")) args.push("--goto");
        args.push(codeLike ? target : file);
        // Windows：编辑器常为 .cmd/.bat（VS Code 的 code.cmd），spawn 需 shell 才能在 PATH 找到并执行；注入桌面环境（systemd 无 DISPLAY 时探测用户会话）
        child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...desktopEnv() }, ...(isWin ? { shell: true } : {}) });
      } else {
        // 系统默认打开器：需要桌面会话（xdg-open/open/start 都依赖图形环境）——
        // systemd/无头服务下直接报明确错误（避免 spawn 假成功/挂起），提示用前端打开或 AITI_OPEN_CMD
        if (!hasDesktopSession()) {
          return resolve({ ok: false, error: "无桌面会话（systemd/无头服务）——后端打开不可用：请用「前端打开」（pi-web 文件标签页在线查看）或设置 AITI_OPEN_CMD 指定打开命令（如 ssh 回本地编辑器）" });
        }
        child = defaultOpen(file);
      }
      let done = false;
      const finish = (r: any) => { if (!done) { done = true; resolve(r); } };
      child.on("error", () => {
        // 编辑器 spawn 失败 → fallback 系统默认打开器（同样需桌面会话；无则明确报错）
        if (!hasDesktopSession()) {
          return finish({ ok: false, error: "编辑器与系统默认打开器均不可用（无桌面会话）——请配置 AITI_OPEN_CMD 或使用前端打开" });
        }
        const c2 = defaultOpen(file);
        c2.on("error", (e2: any) => finish({ ok: false, error: String((e2 && e2.message) || e2) }));
        c2.unref();
        setTimeout(() => finish({ ok: true, opened: file, via: "default" }), 300);
      });
      child.on("spawn", () => setTimeout(() => finish({ ok: true, opened: exe ? target : file, via: exe || "default" }), 300));
      child.unref();
    });
  }

  // ---------------- SSE 响应（Next route handler 流式） ----------------
  // opts.event：SSE 帧带 event 字段（streamable HTTP 规范要求 `event: message`；桥私有 /bridge/sse 用无 event 格式）
  function sseResponse(onClose, opts = {}) {
    let controllerRef = null;
    let closed = false;
    const stream = new ReadableStream({
      start(controller) { controllerRef = controller; },
      cancel() { closed = true; try { if (onClose) onClose(); } catch {} },
    });
    const eventLine = opts.event ? "event: " + opts.event + "\n" : "";
    const writer = {
      // 返回是否写成功：流已关闭/写入异常（浏览器端断连）→ 触发 onClose 清理注册 + 返回 false，调用方（exec/interact 路由）据此快速失败而非白等超时
      write(obj) {
        try {
          if (controllerRef && !closed) { controllerRef.enqueue(new TextEncoder().encode(eventLine + "data: " + JSON.stringify(obj) + "\n\n")); return true; }
        } catch (e) { /* enqueue 抛错 = 流已失效 */ }
        if (!closed) {
          closed = true; // 防重复清理
          try { if (onClose) onClose(); } catch {}
        }
        return false;
      },
    };
    // 心跳：穿透代理（vhost rewrite）对长连接有空闲超时——每 15s 发注释帧保持活跃
    const ping = setInterval(() => {
      try { if (controllerRef && !closed) controllerRef.enqueue(new TextEncoder().encode(": ping\n\n")); } catch {}
    }, 15000);
    const cleanup = () => { clearInterval(ping); };
    // X-Accel-Buffering: no —— 禁反代缓冲（nginx HTTP/2 下会攒首帧直到下个写入，SSE 首帧 ready 延迟 15s+，隧道场景实测页面连不上桥）
    return { response: new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no", ...cors } }), writer, cleanup };
  }

  // ---------------- 桥端点处理 ----------------
  async function handle(req, path, searchParams) {
    // 正式路径带 /aiti/ 前缀（避免冲突、方便 nginx 集成 location /aiti/）；旧路径 /bridge /mcp 兼容
    if (path[0] === "aiti") path = path.slice(1);
    const endpoint = path[0]; // bridge / mcp
    const sub = path.slice(1)[0] || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // POST /bridge/claim { instanceId?, secret?, pageKey?, hostUrl? } → { instanceId, secret }
    if (endpoint === "bridge" && sub === "claim" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const r = claimInstanceId(msg && msg.instanceId, msg && msg.secret, msg && msg.pageKey, msg && msg.hostUrl);
      const reused = !!(msg && msg.instanceId && r.instanceId === msg.instanceId && msg.secret);
      const portPref = portFromHostUrl(msg && msg.hostUrl);
      console.log(TAG + " claim → instanceId=" + r.instanceId + (reused ? "（复用）" : "（新" + (portPref ? " 端口偏好=" + portPref : "") + "）"));
      return json({ ok: true, instanceId: r.instanceId, secret: r.secret });
    }

    // GET /bridge/sessions → 发现
    if (endpoint === "bridge" && sub === "sessions" && req.method === "GET") return json(listSessions());

    // POST /bridge/ai/page { instanceId, pageId, title, url, frames? } → AI 窗注册宿主页（页面不连桥，桥经 AI 窗看到宿主页）
    if (endpoint === "bridge" && sub === "ai" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.pageId) return json({ ok: false, error: "缺少 instanceId/pageId" }, 400);
      let hit = null;
      for (const [w, rec] of aiPageReg) if (rec.instanceId === String(msg.instanceId)) { hit = w; break; }
      if (!hit) return json({ ok: false, error: "no such ai conn：" + msg.instanceId }, 404);
      // 同宿主页多 AI 窗去重：同一 baseId（宿主页）只保留最新注册的连接——旧连接不再承接 exec 路由，避免选到不响应的窗口
      const baseId = String(msg.pageId).replace(/\/host$/, "");
      for (const [w, rec] of aiPageReg) {
        if (w !== hit && rec.pageId && String(rec.pageId).replace(/\/host$/, "") === baseId) aiPageReg.delete(w);
      }
      const prev = aiPageReg.get(hit) || {};
      const fr = Array.isArray(msg.frames) ? msg.frames : prev.frames || null;
      aiPageReg.set(hit, { instanceId: String(msg.instanceId), pageId: String(msg.pageId), title: msg.title || prev.title || null, url: msg.url || prev.url || null, frames: fr, device: (msg.device && typeof msg.device === "object") ? msg.device : (prev.device || null), deviceLabel: msg.deviceLabel || prev.deviceLabel || null, lastSeen: Date.now() });
      console.log(TAG + " AI 宿主页注册：" + msg.pageId + " · " + (msg.title || "") + (fr && fr.length ? " · frames=" + fr.length : "") + (msg.device ? " · " + (msg.deviceLabel || msg.device.browser) : ""));
      return json({ ok: true, pageId: msg.pageId });
    }

    // POST /bridge/self/page { instanceId, url, title } → AI 主窗口自注册为 xxx/ai 调试目标（M1）
    if (endpoint === "bridge" && sub === "self" && path[2] === "page" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId) return json({ ok: false, error: "缺少 instanceId" }, 400);
      let hit = null;
      for (const [w, rec] of aiSelfReg) if (rec.instanceId === String(msg.instanceId)) { hit = w; break; }
      if (!hit) return json({ ok: false, error: "no such ai conn：" + msg.instanceId }, 404);
      const prev = aiSelfReg.get(hit) || {};
      aiSelfReg.set(hit, { instanceId: String(msg.instanceId), url: msg.url || prev.url || null, title: msg.title || prev.title || null, device: (msg.device && typeof msg.device === "object") ? msg.device : (prev.device || null), deviceLabel: msg.deviceLabel || prev.deviceLabel || null, lastSeen: Date.now() });
      bindAgentFromAiSelf(aiSelfReg.get(hit));  // 自动绑定：AI 主窗口 url session 匹配的 agent（boundPageId 兕底）
      console.log(TAG + " AI 主窗口 self 注册：" + msg.instanceId + "/ai · " + (msg.title || "") + (msg.device ? " · " + (msg.deviceLabel || msg.device.browser) : ""));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }

    // POST /bridge/self/active { instanceId, sessionId } → AI 主窗口活跃切换（visibilitychange visible）
    // 用户切到哪个 tab，就绑哪个。覆盖 activeBoundPageId。
    if (endpoint === "bridge" && sub === "self" && path[2] === "active" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.instanceId || !msg.sessionId) return json({ ok: false, error: "缺少 instanceId/sessionId" }, 400);
      bindAgentFromActive(String(msg.instanceId), String(msg.sessionId));
      return json({ ok: true, pageId: String(msg.instanceId) + "/ai" });
    }

    // POST /bridge/ai/frames { pageId, frames: [{id,title,url,name,src,parentId}] } → AI 窗上报宿主页帧树（launcher boot 携带，经 AI 窗转达）
    if (endpoint === "bridge" && sub === "ai" && path[2] === "frames" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.pageId || !Array.isArray(msg.frames)) return json({ ok: false, error: "bad request（需要 pageId/frames）" }, 400);
      let hit = null;
      for (const [w, rec] of aiPageReg) if (rec.pageId === String(msg.pageId)) { hit = w; break; }
      if (!hit) return json({ ok: false, error: "no such ai host page：" + msg.pageId }, 404);
      const rec = aiPageReg.get(hit);
      rec.frames = msg.frames;
      rec.lastSeen = Date.now();
      console.log(TAG + " AI 宿主帧树更新：" + msg.pageId + " frames=" + msg.frames.length);
      return json({ ok: true, frames: msg.frames.length });
    }

    // POST /bridge/register { instanceId, frameId | frames: [{id,title,url,name,src,parentId}] } → 帧树补报（幂等全量：整表替换，防 iframe 移除后残留）
    if (endpoint === "bridge" && sub === "register" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !validInstance(msg.instanceId)) return json({ ok: false, error: "bad instanceId" }, 401);
      const page = pages.get(msg.instanceId);
      if (!page) return json({ ok: false, error: "no active page" }, 404);
      const list = Array.isArray(msg.frames) ? msg.frames : [msg.frameId].filter(Boolean);
      page.frames.clear();
      page.frameInfo.clear();
      for (const f of list) {
        if (typeof f === "string" && f) { page.frames.add(f); continue; } // 兼容旧格式：纯 frameId
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

    // POST /bridge/agent/tools/call { tool, args?, agentId?, sessionId? } → 直接调工具（pi 扩展 registerTool 的 execute 用；无状态）
    // agentKey = agentId/sessionId：注册身份后消息定向到该会话；缺省 agentId='pi'、sessionId=桥随机（引导 aiti_hello 注册）
    if (endpoint === "bridge" && sub === "agent" && path[2] === "tools" && path[3] === "call" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.tool) return json({ ok: false, error: "bad request（需要 tool）" }, 400);
      const agentId = msg.agentId ? String(msg.agentId) : "pi";
      const sessionId = msg.sessionId ? String(msg.sessionId) : null;
      const { a: ag, key } = ensureAgent(agentId, sessionId, null);
      if (sessionId) ag.registered = true;
      ag.source = msg.source === "mcp" ? "mcp" : "extension"; // agent REST = pi 扩展直连（默认）；显式 mcp 可覆盖
      if (msg.cwd) ag.cwd = String(msg.cwd); // 工作目录（显示 CWD . name (id)）
      const session = { agentId, agentKey: key, id: sessionId || key.split("/").slice(1).join("/"), source: ag.source };
      try {
        const r = await callTool(String(msg.tool), (msg.args && typeof msg.args === "object") ? msg.args : {}, session, null, msg.cancelId ? String(msg.cancelId) : null);
        if (r && r.error) return json({ ok: false, error: r.error });
        const text = (r && r.content && r.content[0] && r.content[0].text) || JSON.stringify(r);
        return json({ ok: true, agentKey: key, result: text, isError: !!(r && r.isError) });
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) });
      }
    }

    // POST /bridge/agent/register { agentId, sessionId?, name?, pageId?, subEvents? } → agent 启动时注册自己（pi 扩展 session_start 自动调用）
    if (endpoint === "bridge" && sub === "agent" && path[2] === "register" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.agentId) return json({ ok: false, error: "bad request（需要 agentId）" }, 400);
      const { a: ag, key } = ensureAgent(String(msg.agentId), msg.sessionId ? String(msg.sessionId) : null, null);
      ag.registered = true;
      if (msg.name) ag.name = String(msg.name);
      if (msg.cwd) ag.cwd = String(msg.cwd); // 工作目录（显示 CWD . name (id)）
      if (msg.source) ag.source = String(msg.source); // 来源：extension（pi 扩展）/ mcp / 其他
      if (msg.pageId) ag.boundPageId = String(msg.pageId);
      if (Array.isArray(msg.subEvents)) ag.subEvents = new Set(msg.subEvents.map(String));
      return json({ ok: true, agentKey: key, agentId: ag.agentId, sessionId: ag.sessionId, registered: true, subEvents: [...ag.subEvents], inboxPending: ag.outbox.filter((m) => m.status !== "consumed").length });
    }

    // GET /bridge/agent/sse?agentKey= → agent 持久流（P3：页面事件/人发消息实时推送；pi 扩展 EventSource 连接）
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

    // POST /bridge/agent/answer { agentKey, text, kind? } → agent 完成回复 → 消息流（from agent，JSONL 持久化）+ 广播窗口（agent_answer）
    if (endpoint === "bridge" && sub === "agent" && path[2] === "answer" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.agentKey || !msg.text) return json({ ok: false, error: "bad request（需要 agentKey/text）" }, 400);
      const parts = String(msg.agentKey).split("/");
      const { a, key: resolvedKey } = ensureAgent(parts[0], parts.slice(1).join("/") || null, null);
      // AI 已处理并回答 → 该 agent 待处理的消息（user_message/user_answer/chat）全部标 consumed（状态与事实一致：
      // 推送路径不调 aiti_inbox，消息状态靠这里收敛）
      for (const om of a.outbox) {
        if (om.status !== "consumed" && (om.kind === "user_message" || om.kind === "user_answer" || om.kind === "chat")) {
          om.status = "consumed"; om.ackedAt = Date.now();
          appendMsgEvent(resolvedKey, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: om.id, status: "consumed", timestamp: new Date().toISOString() });
          for (const w of aiConns) w.write({ type: "msg_status", agentKey: resolvedKey, msgId: om.id, status: "consumed" }); // 窗口实时更新状态
        }
      }
      const m = { id: randomBytes(4).toString("hex"), kind: msg.kind || "agent_answer", from: "agent", agentId: parts[0], pageId: null, text: String(msg.text).slice(0, 4000), payload: msg.payload || null, at: new Date().toISOString(), status: "consumed" };
      appendMsgEvent(resolvedKey, { type: "message", id: m.id, parentId: null, timestamp: m.at, message: m });
      for (const w of aiConns) w.write({ type: "agent_answer", agentKey: resolvedKey, agentId: parts[0], text: m.text, at: m.at });
      console.log(TAG + " agent 回答 → " + resolvedKey + " · " + String(m.text).slice(0, 80) + "（已消费待处理消息 " + a.outbox.filter((x) => x.status === "consumed").length + " 条）");
      return json({ ok: true, message: m });
    }

    // GET /bridge/agents → 所有 agent 会话（cockpit session 列表/切换用）
    if (endpoint === "bridge" && sub === "agents" && req.method === "GET") return json({ ok: true, agents: listAgentSessions() });

    // GET /bridge/sse?instanceId=&secret=&role=&frameId=&url=&frameworks= → 持久连接
    if (endpoint === "bridge" && sub === "sse") {
      const instanceId = searchParams.get("instanceId") || searchParams.get("token") || LEGACY_TOKEN;
      const role = searchParams.get("role") || "page";
      const secret = searchParams.get("secret") || null;
      if (role !== "ai" && !validInstance(instanceId)) return json({ ok: false, error: "bad instanceId" }, 401); // AI 连接（role=ai）自标识，无需 idRegistry 登记
      if (!checkSecret(instanceId, secret)) return json({ ok: false, error: "bad secret" }, 401);
      const { response, writer, cleanup: sseCleanup } = sseResponse(() => cleanup());
      const cleanup = () => {
        if (role === "ai") {
          aiConns.delete(writer); aiPageReg.delete(writer); aiSelfReg.delete(writer);
          // AI 窗掉线 → 清理轮询列表和 activeBoundPageId 里对应的 pageId
          var deadPageId = instanceId + "/ai";
          for (var [, fbList] of agentFallbackPageIds) {
            for (var fi = fbList.length - 1; fi >= 0; fi--) {
              if (fbList[fi].pageId === deadPageId) fbList.splice(fi, 1);
            }
          }
          for (var [, ag] of agents) {
            if (ag.activeBoundPageId === deadPageId) ag.activeBoundPageId = null;
          }
          sseCleanup(); return;
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
        bindAgentFromAiSelf(aiSelfReg.get(writer));  // 自动绑定：AI 主窗口 url session 匹配的 agent（boundPageId 兕底）
        console.log(TAG + " AI 控制台已连接：instanceId=" + instanceId);
      } else {
        const existing = pages.get(instanceId);
        if (existing) { try { existing.writer.end(); } catch {} pages.delete(instanceId); }
        const initialFrame = searchParams.get("frameId") || "host";
        let pageDevice = null, pageDeviceLabel = null;
        try { const d = searchParams.get("device"); if (d) pageDevice = JSON.parse(d); } catch (e) {}
        pageDeviceLabel = searchParams.get("deviceLabel") || null;
        pages.set(instanceId, {
          writer, url: searchParams.get("url") || null, title: searchParams.get("title") || null, frameworks: searchParams.get("frameworks") || null,
          frames: new Set([initialFrame]), frameInfo: new Map(), device: pageDevice, deviceLabel: pageDeviceLabel,
        });
        const rec = idRegistry.get(instanceId);
        if (rec) rec.lastSeen = Date.now();
        console.log(TAG + " 页面已连接：instanceId=" + instanceId + " frame=" + initialFrame);
      }
      writer.write({ type: "ready", bridge: "/api/extensions/aiti-devtools/mcp", instanceId, token: LEGACY_TOKEN, role });
      return response;
    }

    // POST /bridge/attach-bus {instanceId, secret, token, role, frameId?, url?, title?, device?, deviceLabel?, frameworks?}
    // 统一 SSE 端口适配：把连接注册为「总线型 writer」——无 SSE socket，下行经
    // busPublish 投到专属 topic（bridge-<instanceId>），全部既有 w.write() 推送点零改动。
    // busPublish 未接线（独立桥/未适配宿主）→ 501，客户端 fallback 自带 SSE。
    if (endpoint === "bridge" && sub === "attach-bus" && req.method === "POST") {
      if (!busPublish) return json({ ok: false, error: "bus not wired" }, 501);
      const msg = await req.json().catch(() => null);
      const instanceId = (msg && (msg.instanceId || msg.token)) || LEGACY_TOKEN;
      const role = (msg && msg.role) || "page";
      if (role !== "ai" && !validInstance(instanceId)) return json({ ok: false, error: "bad instanceId" }, 401);
      if (!checkSecret(instanceId, (msg && msg.secret) || null)) return json({ ok: false, error: "bad secret" }, 401);
      const topic = "bridge-" + instanceId;
      const writer: any = {
        viaBus: true,
        lastSeen: Date.now(),
        // 帧契约：{ type: "bridge-<instanceId>", msg: <桥原消息> }——帧 type 即 topic（与
        // 客户端订阅白名单一致，publish(type, data) 的 data 展开会覆盖同名键，故桥消息只能放 msg）；
        // 永远返回 true：投递由总线管理（白名单过滤 + SSE 转发）；断线重连由客户端订阅状态回调驱动
        write(obj: any) {
          try { busPublish(topic, { msg: obj }); return true; } catch { return false; }
        },
        end() { /* 总线型无流可关：由总线/心跳管理生命周期 */ },
      };
      if (role === "ai") {
        aiConns.add(writer);
        aiPageReg.set(writer, { instanceId, pageId: null, title: (msg && msg.title) || null, url: (msg && msg.url) || null, frames: null, lastSeen: Date.now() });
        aiSelfReg.set(writer, { instanceId, url: (msg && msg.url) || null, title: (msg && msg.title) || null, lastSeen: Date.now() });
        bindAgentFromAiSelf(aiSelfReg.get(writer));
        console.log(TAG + " AI 控制台已连接（总线）：instanceId=" + instanceId);
      } else {
        const existing = pages.get(instanceId);
        if (existing) { try { existing.writer.end(); } catch {} pages.delete(instanceId); }
        let pageDevice: any = null;
        try { if (msg && msg.device) pageDevice = typeof msg.device === "string" ? JSON.parse(msg.device) : msg.device; } catch (e) {}
        pages.set(instanceId, {
          writer, url: (msg && msg.url) || null, title: (msg && msg.title) || null, frameworks: (msg && msg.frameworks) || null,
          frames: new Set([(msg && msg.frameId) || "host"]), frameInfo: new Map(), device: pageDevice, deviceLabel: (msg && msg.deviceLabel) || null,
        });
        const rec = idRegistry.get(instanceId);
        if (rec) rec.lastSeen = Date.now();
        console.log(TAG + " 页面已连接（总线）：instanceId=" + instanceId);
      }
      writer.write({ type: "ready", bridge: "/api/extensions/aiti-devtools/mcp", instanceId, token: LEGACY_TOKEN, role, via: "bus" });
      return json({ ok: true, topic, via: "bus" });
    }

    // POST /bridge/bus-heartbeat {instanceId, secret, token, role} —— 总线型连接保活：刷新 lastSeen
    //（无 SSE 断连信号，活性全靠心跳；sweep 扫 BUS_CONN_TTL 超时摘除）。unknown conn → 404，
    // 客户端据此重新 attach-bus。
    if (endpoint === "bridge" && sub === "bus-heartbeat" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const instanceId = (msg && (msg.instanceId || msg.token)) || LEGACY_TOKEN;
      const role = (msg && msg.role) || "page";
      if (!checkSecret(instanceId, (msg && msg.secret) || null)) return json({ ok: false, error: "bad secret" }, 401);
      if (role === "ai") {
        for (const w of aiConns) {
          if ((w as any).viaBus && aiSelfReg.get(w)?.instanceId === instanceId) { (w as any).lastSeen = Date.now(); return json({ ok: true }); }
        }
        return json({ ok: false, error: "unknown conn" }, 404);
      }
      const p = pages.get(instanceId);
      if (!p || !(p.writer as any).viaBus) return json({ ok: false, error: "unknown conn" }, 404);
      (p.writer as any).lastSeen = Date.now();
      const rec = idRegistry.get(instanceId);
      if (rec) rec.lastSeen = Date.now();
      return json({ ok: true });
    }

    // POST /bridge/interaction { pageId?, secret, requestId, action: 'pause'|'resume' } → 交互倒计时控制（用户暂停/继续超时）
    if (endpoint === "bridge" && sub === "interaction" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.requestId || (msg.action !== "pause" && msg.action !== "resume")) return json({ ok: false, error: "bad request" }, 400);
      const { instanceId } = parsePageId(msg.pageId);
      if (!validInstance(instanceId || msg.token)) return json({ ok: false }, 401);
      if (!checkSecret(instanceId || msg.token, msg.secret)) return json({ ok: false, error: "bad secret" }, 401);
      const r = msg.action === "pause" ? pauseInteraction(msg.requestId) : resumeInteraction(msg.requestId);
      for (const w of aiConns) w.write({ type: "event", from: "page", event: "interaction_" + msg.action, payload: { requestId: msg.requestId, remainingMs: r.remainingMs } });
      return json({ ok: r.ok, ...r });
    }

    // POST /bridge/result { pageId, secret, requestId, ok, result }
    if (endpoint === "bridge" && sub === "result" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      const { instanceId } = parsePageId(msg.pageId);
      if (!validInstance(instanceId || msg.token)) return json({ ok: false }, 401);
      if (!checkSecret(instanceId || msg.token, msg.secret)) return json({ ok: false, error: "bad secret" }, 401);
      // 截屏结果落盘（Page.captureScreenshot）：dataUrl 大于阈值 → 写文件，result 换成文件路径——
      // 避免 MB 级 base64 灰进 MCP 工具结果/消息流（agent 拿路径可打开查看，图片本体在磁盘）
      try {
        const r0 = msg.result;
        if (r0 && typeof r0 === "object" && typeof r0.dataUrl === "string" && r0.dataUrl.length > 120_000) {
          const ext = r0.format === "png" ? "png" : "jpg";
          const dir = join(dataDir, "aiti-bridge", "shots");
          mkdirSync(dir, { recursive: true });
          const file = join(dir, new Date().toISOString().replace(/[:.]/g, "-") + "-" + String(msg.requestId).replace(/[^\w-]/g, "").slice(0, 12) + "." + ext);
          writeFileSync(file, Buffer.from(r0.dataUrl.slice(r0.dataUrl.indexOf(",") + 1), "base64"));
          msg.result = { file, width: r0.width, height: r0.height, format: r0.format, bytes: r0.bytes || 0, note: "截屏已存文件（dataUrl 过大不内联）；前端文件标签页可直接打开查看" };
          console.log(TAG + " 截屏落盘：" + file + "（" + Math.round((r0.bytes || 0) / 1024) + "KB）");
        }
      } catch (e) { console.warn(TAG + " 截屏落盘失败（退回内联）:", (e as Error).message); }
      const r = pendingRequests.get(msg.requestId);
      if (r) {
        pendingRequests.delete(msg.requestId);
        try { if (r.signal && r.onAbort) r.signal.removeEventListener("abort", r.onAbort); } catch {}
        if (r.mcpReqId) mcpReqMap.delete(r.mcpReqId);
        if (r.cancelId) cancelIdMap.delete(r.cancelId);
        // 交互请求：清理服务器计时器 + 附上累计暂停时长（用户 ⏸ 过的时间）
        const ist = interactionTimers.get(msg.requestId);
        if (ist) { clearTimeout(ist.timer); interactionTimers.delete(msg.requestId); if (msg.result && typeof msg.result === "object" && !("pausedMs" in msg.result)) msg.result.pausedMs = ist.pausedMs; }
        r.resolve({ ok: msg.ok, result: msg.result }); console.log(TAG + " ← 结果回传 ok=" + msg.ok + (r.agentId ? " → agent=" + r.agentId : ""));
        // 异步作答回投递发起 agent（§3.4：async:true 的结果进 aiti_inbox）
        if (r.agentId && msg.ok) deliverUserAnswer(r.agentId, msg.result);
      }
      else {
        // 无 pending（超时结算/取消/重复回传）：不再广播。广播会把 result 回流给 AI 窗——
        // pi-web 内嵌同窗形态下 onResult → postToLauncher(dbg_mcp_result) 自发自收 →
        // 本模块的 message 监听误当作答回传再次 postResult → 广播 → 自激励回环
        // （实测 ~675 req/s：日志洪水冲爆 dev watch → Fast Refresh 风暴 → 页面点击全失效）。
        console.log(TAG + " ⚠ 结果回传但无 pending：" + msg.requestId);
        return new Response("ok", { headers: cors });
      }
      for (const w of aiConns) w.write({ type: "result", requestId: msg.requestId, ok: msg.ok, result: msg.result, pageId: msg.pageId });
      return new Response("ok", { headers: cors });
    }

    // POST /bridge/cancel { requestId | cancelId } → 取消挂起请求（agent 停止/客户端取消：exec/interaction 立即结算 + 窗口收尾）
    if (endpoint === "bridge" && sub === "cancel" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false, error: "bad request" }, 400);
      const internalId = msg.requestId ? String(msg.requestId) : (msg.cancelId ? cancelIdMap.get(String(msg.cancelId)) : null);
      if (!internalId) return json({ ok: false, error: "unknown request", cancelled: false });
      return json({ ok: cancelPending(internalId, "已取消（客户端请求）"), cancelled: true });
    }

    // POST /bridge/push { to?, text, kind?, ref? } → 人 → AI 主动发消息（方案 G P2：queue 主通道）
    if (endpoint === "bridge" && sub === "push" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.text) return json({ ok: false, error: "bad request（需要 text）" }, 400);
      return json(pushToAgents(msg.to, String(msg.text), msg.kind || "user_message", msg.payload || {}, msg.ref || null));
    }

    // POST /bridge/picked { to?, candidates: [{tag, describe, pageId?}] } → AI 窗候选上报（占位符替换数据源）
    //   存内存（最新一份；to 可选分 agentKey，缺省全局 '__all__'）。HTTP 宿主（opencode 插件等）经
    //   GET /bridge/picked 读取后在自家消息预处理钩子里做占位符替换（DSH 进程内同款语义，协议唯一来源）。
    if (endpoint === "bridge" && sub === "picked" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      const list = msg && Array.isArray(msg.candidates) ? msg.candidates : null;
      if (!list) return json({ ok: false, error: "bad request（需要 candidates 数组）" }, 400);
      const key = String((msg && msg.to) || "__all__");
      pickedReports.set(key, list.filter((c) => c && c.tag));
      persistPicked();
      return json({ ok: true, count: pickedReports.get(key).length, key });
    }
    // GET /bridge/picked?agentKey= → 读候选上报（无 agentKey/未命中时回退全局 '__all__'）
    if (endpoint === "bridge" && sub === "picked" && req.method === "GET") {
      const key = searchParams.get("agentKey") || "__all__";
      const list = pickedReports.get(key) ?? pickedReports.get("__all__") ?? [];
      return json({ ok: true, key, count: list.length, candidates: list });
    }

    // POST /bridge/ai/event { event, payload? } → HTTP 宿主触发 pushAiEvent（aiConns SSE 直推 AI 窗）
    //   进程内宿主（pi-web/DSH）直接调 bridge.pushAiEvent()；HTTP 宿主（opencode 插件）走本 REST。
    //   典型：宿主占位符替换成功 → { event:'aiti_consumed', payload:{tags} } → AI 窗清候选。
    if (endpoint === "bridge" && sub === "ai" && path[2] === "event" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg || !msg.event) return json({ ok: false, error: "bad request（需要 event）" }, 400);
      const ev = String(msg.event);
      // aiti_consumed 权威消费信号：桥侧同步清 picked 候选（防 GET 复活僵尸候选——
      // 独立 AI 窗冷启动拉取会把已消费候选重新合并上报，形成「消费↔拉取」死循环）。
      // payload.tags 指定则只摘这些 tag，缺省清空全局。多窗语义与 picked 全局单份一致。
      if (ev === "aiti_consumed") {
        const tags = Array.isArray((msg.payload as any)?.tags) ? (msg.payload as any).tags.map(String) : null;
        for (const [k, list] of pickedReports) {
          const next = tags ? list.filter((c) => !tags.includes(String(c.tag))) : [];
          if (next.length !== list.length) { pickedReports.set(k, next); persistPicked(); }
        }
      }
      return json(pushAiEvent(ev, msg.payload || {}, "host-rest"));
    }

    // GET /bridge/inbox-status?agentId=<agentKey 或 agentId> → 消息消费状态（窗口显示 待消费/已消费；agentId 时取该 agent 最新 session）
    if (endpoint === "bridge" && sub === "inbox-status" && req.method === "GET") {
      const input = searchParams.get("agentId") || "";
      const key = input.includes("/") ? input : (resolvePushTargets(input)[0] || "");
      const a = key ? agents.get(key) : null;
      if (!a) return json({ ok: false, error: "unknown agent session" }, 404);
      return json({ ok: true, agentKey: key, agentId: a.agentId, sessionId: a.sessionId, queueSize: a.outbox.filter((x) => x.status !== "consumed").length, messages: a.outbox.slice(-50).map((m) => ({ id: m.id, kind: m.kind, from: m.from, text: m.text ?? null, at: m.at, status: m.status })) });
    }

    // GET /bridge/messages?agentId=<agentKey 或 agentId>&limit=&before=&since= → 消息历史（JSONL 重放 + 滑动窗口 + 翻页 + 增量）
    if (endpoint === "bridge" && sub === "messages" && req.method === "GET") {
      const input = searchParams.get("agentId") || "";
      const key = input.includes("/") ? input : (resolvePushTargets(input)[0] || "");
      const limit = Math.min(parseInt(searchParams.get("limit"), 10) || 50, 200);
      const before = searchParams.get("before") || "";
      const since = searchParams.get("since") || "";
      const rows = key ? readMsgSession(key).sort((x, y) => String(x.at).localeCompare(String(y.at))) : [];
      let filtered = rows;
      if (since) { const t = Date.parse(since); if (!isNaN(t)) filtered = filtered.filter((r) => Date.parse(r.at) >= t); }
      else if (before) filtered = filtered.filter((r) => String(r.at) < before);
      const msgs = filtered.slice(-limit).map((m) => { const ak = m.agentKey || key || (m.agentId ? m.agentId + (m.sessionId ? '/' + m.sessionId : '') : ''); return { id: m.id, kind: m.kind, from: m.from, agentKey: ak, agentId: m.agentId || (ak ? ak.split('/')[0] : null), sessionId: m.sessionId || (ak && ak.includes('/') ? ak.split('/').slice(1).join('/') : null) || null, pageId: m.pageId || (m.payload && m.payload.pageId) || null, ref: m.ref ?? null, text: m.text ?? null, detail: m.detail ?? null, at: m.at, status: m.status || 'pending' }; });
      return json({ ok: true, agentKey: key, total: rows.length, since, messages: msgs });
    }

    // POST /bridge/event { pageId, secret, type, payload }
    if (endpoint === "bridge" && sub === "event" && req.method === "POST") {
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      const { instanceId } = parsePageId(msg.pageId);
      // 页面不直连桥（设计：桥的唯一浏览器端点是 AI 窗）——事件由 AI 窗代宿主页上报：
      // pageId 命中 AI 窗注册的宿主页（aiPageReg）即放行（缓冲键 = 该 pageId 的 instanceId，与 page_logs 查询一致）
      const aiRegistered = typeof msg.pageId === "string" && [...aiPageReg.values()].some((r) => r.pageId === msg.pageId);
      if (!aiRegistered && !validInstance(instanceId || msg.token)) return json({ ok: false }, 401);
      if (!checkSecret(aiRegistered ? instanceId : instanceId || msg.token, msg.secret)) return json({ ok: false, error: "bad secret" }, 401);
      for (const w of aiConns) w.write({ type: "event", from: "page", ...msg });
      // P3：订阅分发——subEvents 显式订阅的 agent 实时推送（agentStream）/入 outbox（无流）
      const pageInfo = { pageId: msg.pageId || null, url: (msg.payload && msg.payload.url) || null };
      if (msg.type === "page_error") { pushEventToSubscribers("page_error", msg.payload || {}, pageInfo); console.log(TAG + " page_error 事件 → 订阅分发（type=" + msg.type + " payload=" + JSON.stringify(msg.payload || {}).slice(0, 120) + "）"); }
      // 方案 F-3：日志/网络不再实时上报桥——数据留在页面本地缓冲，page_logs/page_network 工具通过 CDP Runtime.evaluate 按需拉取
      // page_log/page_network 事件不再由桥处理（launcher 不再转发），此处直接返回 410 Gone
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

    // POST /mcp（JSON-RPC；Streamable HTTP：GET 持久流 + Mcp-Session-Id，stateless 兼容）
    if (endpoint === "mcp") {
      // 惰性清理过期会话（无流且超时）
      for (const [sid, s] of mcpSessions) if (!s.open && mcpSessionExpired(s)) mcpSessions.delete(sid);

      // GET：Streamable HTTP 的 server→client 持久流（Accept: text/event-stream + Mcp-Session-Id）
      if (req.method === "GET") {
        const sid = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id") || "";
        const session = sid ? mcpSessions.get(sid) : null;
        if (!session) return json({ ok: false, error: "bad or missing Mcp-Session-Id" }, 400);
        if (session.open) return json({ ok: false, error: "stream already open" }, 409);
        session.open = true;
        session.lastSeen = Date.now();
        const { response, writer, cleanup } = sseResponse(() => {
          session.open = false;
          session.lastSeen = Date.now();
          session.writer = null;
          // 流关闭 → 连接数 -1 + 标掉线（agent 无其他连接时）
          const ak = session.agentKey || (session.agentId ? session.agentId + "/" + session.id : "");
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
        session.writer = writer;
        if (session.agentId) { const { a: ag } = ensureAgent(session.agentId, session.id, session); if (ag) { ag.transportKind = "streamable"; ag.conn = (ag.conn || 0) + 1; } } // 流建立后同步 agent（stream 可推 + 在线计数）
        console.log(TAG + " streamable GET 流已建立 session=" + sid.slice(0, 8) + " agent=" + (session.agentId || "?"));
        // 客户端期待流上第一条消息——发一个 session 确认（无 id 的响应/通知均可被 SDK 忽略）
        writer.write({ jsonrpc: "2.0", method: "notifications/initialized" });
        return response;
      }

      // POST：JSON-RPC 请求/通知（带 session = streamable 会话；无 session 且非 initialize = stateless 兼容）
      const msg = await req.json().catch(() => null);
      if (!msg) return json({ ok: false }, 400);
      // 客户端对服务端请求（sampling/createMessage）的响应：POST 回 {jsonrpc, id, result}，id 匹配 pendingSampling
      if (msg.id !== undefined && !msg.method && pendingSampling.has(String(msg.id))) {
        const p = pendingSampling.get(String(msg.id));
        const ok = !(msg.error || (msg.result && msg.result.isError));
        p.done(ok, msg.error ? { error: String((msg.error.message || msg.error.code) || "sampling 拒绝") } : (msg.result || {}));
        console.log(TAG + " sampling 响应回传 id=" + String(msg.id).slice(0, 12) + " agent=" + p.agentId + " ok=" + ok);
        return new Response(null, { status: 202 }); // 服务端对客户端响应的回执（202 即可）
      }
      const sid = req.headers.get("mcp-session-id") || req.headers.get("Mcp-Session-Id") || "";
      let session = sid ? mcpSessions.get(sid) || null : null;
      const isInit = msg.method === "initialize";
      if (isInit) {
        // initialize：无会话则新建（返回 Mcp-Session-Id 头）；有则复用
        if (!session) {
          const newId = randomBytes(16).toString("hex");
          session = { id: newId, writer: null, agentId: null, clientInfo: null, capabilities: null, lastSeen: Date.now(), open: false, source: "mcp" };
          mcpSessions.set(newId, session);
        }
        const p = (msg.params || {});
        session.clientInfo = p.clientInfo || null;
        session.capabilities = p.capabilities || null;
        session.agentId = (p.clientInfo && p.clientInfo.name) || session.agentId || null;
        session.clientInfo = p.clientInfo || session.clientInfo;
        session.lastSeen = Date.now();
        console.log(TAG + " initialize → session=" + session.id.slice(0, 8) + " client=" + (p.clientInfo ? p.clientInfo.name + " " + (p.clientInfo.version || "") : "?") + " transport=" + (sid ? "streamable" : "session-new") + " caps=" + JSON.stringify(p.capabilities || {}).slice(0, 120));
      } else if (session) {
        session.lastSeen = Date.now();
      }
      if (isInit && session && session.agentId) { const { a: ag, key } = ensureAgent(session.agentId, session.id, session); session.agentKey = key; if (ag) ag.transportKind = sid ? "streamable" : "stateless"; } // P2：agent 自动注册（Mcp-Session-Id 作 sessionId）
      // session 响应头：仅新建会话时返回（客户端据此确认 streamable 支持并持流）
      const extraHeaders = (isInit && session) ? { "mcp-session-id": session.id } : {};
      const respond = async (result) => {
        if (msg.id !== undefined) return json({ jsonrpc: "2.0", id: msg.id, result }, 200, extraHeaders);
        // 通知（无 id）→ 202 Accepted：streamable 客户端（SDK）收到 202 才会开 GET 流（notifications/initialized 触发）
        return new Response(null, { status: 202, headers: extraHeaders });
      };
      const r = handleMcpRequest(msg, session);
      if (r && typeof r.then === "function") return respond(await r);
      return respond(r);
    }

    return new Response("not found: " + endpoint + "/" + sub, { status: 404 });
  }

  // ---------------- 公共 API：直接调用工具（pi 扩展 registerTool 用，不走 HTTP/MCP 传输） ----------------
  function callTool(name, args = {}, session = null, signal = null, cancelId = null) {
    const r = handleMcpRequest({ method: "tools/call", params: { name, arguments: args } }, session, signal, cancelId);
    if (r && typeof r.then === "function") return r;
    return Promise.resolve(r);
  }

  // ---------------- 公共 API：宿主进程内 agent（方案 M 模式；任何宿主可参照） ----------------
  // 与 callTool 同级的进程内扩展点：宿主（pi-web 等）把 agent 会话接进程内（不经 HTTP/MCP）——
  //   registerAgent(key, opts)：登记会话（幂等）；setAgentSink(key, fn)：消息直推回调（入参 pushToAgents 文本/kind/payload）；
  //   answer(key, text)：agent 完成回答 → 消息流落盘（cockpit 等窗口可查历史）；返回结构供宿主上层用。
  // key 为宿主自定义 agentKey（如 "pi-web/<sessionId>"）；与桥自动登记的 agentKey 空间独立。
  const registerAgent = (key, opts = {}) => {
    const k = String(key || "");
    if (!k) return { ok: false, error: "bad key" };
    if (!agents.has(k)) {
      // conn 从 0 起：在线状态由 setAgentSink 维护（sink 在 = 在线；sink 清 = 掉线）——防止会话结束后永远在线泄漏
      agents.set(k, { agentId: k, sessionId: (opts.id || k), registered: true, name: opts.name || k, cwd: opts.cwd || null, offlineAt: null, conn: 0, transportKind: "inprocess", source: opts.source || "extension", capabilities: opts.capabilities || {}, stream: null, boundPageId: opts.pageId || null, activeBoundPageId: null, subEvents: new Set(opts.subEvents || []), outbox: [], lastSeen: Date.now(), agentStream: null, inProcessSink: null });
    }
    const a = agents.get(k);
    a.lastSeen = Date.now();
    if (opts.pageId) a.boundPageId = String(opts.pageId);
    if (Array.isArray(opts.subEvents)) a.subEvents = new Set(opts.subEvents.map(String));
    // 反向匹配：AI 主窗口 URL 的 ?session= 可能已在（AI 窗早于 agent 注册），直接绑定
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
    // 进程内 agent 在线态随 sink 生命周期：挂 sink = 在线（conn≥1）；清 sink = 掉线（记 offlineAt，sweep 到期回收）
    if (a.transportKind === "inprocess") {
      if (a.inProcessSink) { a.conn = Math.max(a.conn || 0, 1); a.offlineAt = null; a.lastSeen = Date.now(); }
      else { a.conn = 0; if (!a.offlineAt) a.offlineAt = a.lastSeen; }
    }
    return { ok: true, agentKey: String(key) };
  };
  const answer = (key, text) => {
    const k = String(key || "");
    const t = String(text || "");
    if (!k || !t) return { ok: false, error: "bad request" };
    const a = agents.get(k);
    const at = new Date().toISOString();
    // 与 HTTP 端点 /bridge/agent/answer 对齐：AI 已作答 → 待处理消息（user_message/user_answer/chat）收敛为 consumed
    if (a) {
      for (const om of a.outbox) {
        if (om.status !== "consumed" && (om.kind === "user_message" || om.kind === "user_answer" || om.kind === "chat")) {
          om.status = "consumed"; om.ackedAt = Date.now();
          appendMsgEvent(k, { type: "status_change", id: randomBytes(4).toString("hex"), msgId: om.id, status: "consumed", timestamp: new Date().toISOString() });
          for (const w of aiConns) w.write({ type: "msg_status", agentKey: k, msgId: om.id, status: "consumed" });
        }
      }
    }
    const m = { id: randomBytes(4).toString("hex"), kind: "agent_summary", from: "agent", agentKey: k, agentId: k, sessionId: k.split("/").slice(1).join("/") || null, text: t.slice(0, 4000), payload: null, at, status: "consumed" };
    appendMsgEvent(k, { type: "message", id: m.id, parentId: null, timestamp: at, message: m });
    for (const w of aiConns) w.write({ type: "agent_answer", agentKey: k, agentId: k, ok: true, text: m.text, at });
    return { ok: true, message: m };
  };
  /** 清理 agent 所有绑定数据（session 结束时调） */
  const clearAgent = (key: string) => {
    const k = String(key || "");
    if (!k) return { ok: false, error: "bad key" };
    agents.delete(k);
    agentFallbackPageIds.delete(k);
    return { ok: true };
  };

  // 进程内宿主（pi-web/DSH 插件）往 AI 窗推自定义事件：与桥内部 inbox_status/page 事件同通道
  // （aiConns SSE writer 直推 type:'event'）。宿主侧在权威时点（如 agent/pre-step 替换成功）
  // 通知 AI 窗前端做对应 UI 动作（如候选清理 aiti_consumed）。
  const pushAiEvent = (event: string, payload: unknown = {}, from = "host") => {
    let n = 0;
    for (const w of aiConns) {
      try { w.write({ type: "event", from, event: String(event || ""), payload }); n++; } catch {}
    }
    return { ok: true, delivered: n };
  };

  return { handle, sessions: () => listSessions(), tools: () => TOOLS, callTool, registerAgent, bindAgentPage, setAgentSink, answer, clearAgent, pushAiEvent, close };
}
