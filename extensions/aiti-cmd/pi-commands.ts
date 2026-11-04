/**
 * aiti-cmd · pi-commands —— pi-web agent 会话运行中命令的实时视图
 *
 * 数据源：agent 会话事件（tool_execution_start / update / end）进程内直连订阅。
 *   - 订阅入口（按优先级）：
 *     1) 官方 AgentSessionInfo.subscribeEvent / abortBash（pi-web 方案 M agent 扩展点；
 *        lib/ext/types.ts + rpc-manager dispatch 传入）
 *     2) 兜底 globalThis.__piSessions（rpc-manager 的 wrapper registry，globalThis 跨热重载
 *        存活）：wrapper.onEvent / wrapper.inner.abortBash——未打补丁的 pi-web（如 prod
 *        旧构建）也立即可用
 *   - tool_execution_update 的 partialResult.content[].text 是「到目前为止的滚动输出」
 *     （pi-core bash 工具 100ms 节流）。agent events 的 SSE 出口过滤了该事件类型，
 *     浏览器看不到；本模块在进程内原样拿到，按 per-连接 diff 增量下发：
 *     {type:"data"} = 追加增量，{type:"replace"} = 全量重写（截断/最终结果改写时）。
 *   - kill：abortBash() 只中止当前 bash 命令，不 abort 整个 turn——agent 收到
 *     "Command aborted" 错误结果后继续思考。注意：parallel 工具模式下同会话的
 *     并发 bash 会被一起中止（AgentSession.abortBash 是会话级语义）。
 *   - RPC 直连的 executeBash（POST /api/agent/{id} {"type":"bash"}）不产生
 *     tool_execution_* 事件，不在本视图内（那是 UI 直连通道，不经 agent 工具循环）。
 */
import { randomBytes } from "node:crypto";

const TEXT_MAX_BYTES = 512 * 1024;  // 单条命令输出保留上限（超出丢头部 + truncated 标记）
const DONE_TTL_MS = 5 * 60 * 1000;  // 已结束条目保留时长（供事后查看）
const DONE_KEEP_MAX = 50;           // 已结束条目数量上限（超出丢最旧）
const CMD_MAX_LEN = 20000;

export interface PiCmdEntry {
  id: string;                 // toolCallId
  sessionId: string;
  toolName: string;           // "bash"
  cmd: string;
  cwd?: string;
  startedTs: number;
  status: "running" | "done";
  isError?: boolean;
  endTs?: number;
  /** 订阅前已开始（错过 start 事件，命令原文未知，靠 update 兜底建条目） */
  lateJoin?: boolean;
  /** 当前已知全量输出（滚动窗；update 替换式更新） */
  text: string;
  truncated: boolean;
  /** 已发布到事件总线的全量基线（delta 衔接基准；快照 REST 返回它，配合 seq 无缝续流） */
  publishedText: string;
  /** 总线帧序号（每次发布 ++；客户端与快照去重用） */
  seq: number;
}

/** 从 partialResult / result 提取文本（content: [{type:"text",text}]） */
function extractText(payload: unknown): string {
  const content = (payload as { content?: unknown } | undefined | null)?.content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const b of content) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
      const t = (b as { text?: unknown }).text;
      if (typeof t === "string") out += t;
    }
  }
  return out;
}

// 帧主题：每个 agent 命令视图一个专属 type（cmd-<toolCallId>），列表快照固定 type。
// 初始全量 text（≤512KB 大消息）不走总线——快照走 REST /pi-commands/{id}；
// 总线只发实时增量（delta/replace 小帧）与状态。
const piTopic = (id: string) => "cmd-" + id;
const TOPIC_PILIST = "cmd-pilist";

export function createPiCommands(publish?: (type: string, data: Record<string, unknown>) => void) {
  const sessions = new Map<string, { cwd?: string; unsubscribe?: () => void; abort?: () => void }>();
  const entries = new Map<string, PiCmdEntry>();
  // aiti-event-bus 发布（缺席/异常静默；客户端降级旧 per-entry SSE）
  const pub = (type: string, data: Record<string, unknown>) => { try { publish?.(type, data); } catch {} };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

  function summaryOf(e: PiCmdEntry) {
    return {
      id: e.id, sessionId: e.sessionId, toolName: e.toolName, cmd: e.cmd, cwd: e.cwd,
      status: e.status, startedTs: e.startedTs,
      durationMs: (e.status === "done" ? e.endTs ?? Date.now() : Date.now()) - e.startedTs,
      bytes: Buffer.byteLength(e.text, "utf8"), truncated: e.truncated,
      isError: e.isError, lateJoin: e.lateJoin || undefined,
    };
  }

  /** 列表快照（不 sweep，防 publishList→list→sweep→publishList 递归） */
  function snapshotList() {
    return [...entries.values()].sort((a, b) => b.startedTs - a.startedTs).map(summaryOf);
  }
  const publishList = () => { try { pub(TOPIC_PILIST, { evt: "pilist", commands: snapshotList() }); } catch {} };

  /** 更新条目输出：总线按「已发布基线」发增量/全量（aiti-cmd 自管理发送 + 订阅保活停推） */
  function setText(e: PiCmdEntry, t: string) {
    if (t.length > TEXT_MAX_BYTES) { t = t.slice(-TEXT_MAX_BYTES); e.truncated = true; }
    e.text = t;
    // 总线（aiti-cmd 自管理是否发送）：基线 = publishedText；delta 基于 publishedText
    // 单调推进，中途订阅者拿快照（publishedText@now + seq）后靠 seq 去重无缝衔接
    if (t.startsWith(e.publishedText)) {
      const delta = t.slice(e.publishedText.length);
      if (delta) { e.seq += 1; pub(piTopic(e.id), { evt: "data", seq: e.seq, data: delta }); e.publishedText = t; }
    } else {
      e.seq += 1; pub(piTopic(e.id), { evt: "replace", seq: e.seq, data: t }); e.publishedText = t;
    }
  }

  function finishEntry(e: PiCmdEntry, isError: boolean) {
    if (e.status === "done") return;
    e.status = "done";
    e.endTs = Date.now();
    e.isError = isError;
    pub(piTopic(e.id), { evt: "exit", isError, durationMs: e.endTs - e.startedTs, truncated: e.truncated });
    publishList();
  }

  function handleEvent(sessionId: string, ev: unknown) {
    const e = ev as { type?: string; toolCallId?: unknown; toolName?: unknown; args?: unknown; partialResult?: unknown; result?: unknown; isError?: unknown } | null | undefined;
    if (!e || typeof e.type !== "string") return;
    const id = String(e.toolCallId ?? "");
    if (e.type === "tool_execution_start" && e.toolName === "bash") {
      if (!id || entries.has(id)) return;
      const cmd = String((e.args as { command?: unknown } | undefined)?.command ?? "");
      const entry: PiCmdEntry = {
        id, sessionId, toolName: "bash", cmd: cmd.slice(0, CMD_MAX_LEN),
        cwd: sessions.get(sessionId)?.cwd,
        startedTs: Date.now(), status: "running", text: "", truncated: false,
        publishedText: "", seq: 0,
      };
      entries.set(id, entry);
      publishList();
    } else if (e.type === "tool_execution_update") {
      if (e.toolName !== "bash" || !id) return;
      // 订阅晚于 start（扩展 reload / lateCatchUp 前已在跑）→ 建兜底条目，命令原文未知
      const entry = entries.get(id) ?? ensureLateEntry(id, sessionId);
      if (entry.status !== "running") return;
      const text = extractText(e.partialResult);
      if (!text) return;
      setText(entry, text);
    } else if (e.type === "tool_execution_end") {
      if (e.toolName !== "bash" || !id) return;
      const entry = entries.get(id) ?? ensureLateEntry(id, sessionId);
      if (entry.status === "done") return;
      // 最终结果（截断后的规范输出）可能与滚动窗不同 → replace 语义下发
      const finalText = extractText(e.result);
      if (finalText) setText(entry, finalText);
      finishEntry(entry, !!e.isError);
    }
  }

  /** update/end 到达但没有对应条目（订阅晚于 start）→ 建兜底条目，命令原文未知 */
  function ensureLateEntry(id: string, sessionId: string): PiCmdEntry {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id, sessionId, toolName: "bash", cmd: "", cwd: sessions.get(sessionId)?.cwd,
        startedTs: Date.now(), status: "running", text: "", truncated: false,
        publishedText: "", seq: 0,
        lateJoin: true,
      };
      entries.set(id, entry);
      publishList();
    }
    return entry;
  }

  /**
   * 订阅一个 agent 会话（onAgentSession 回调 / lateCatchUp 扫描）。
   * 优先官方 info.subscribeEvent / info.abortBash；缺则兜底 globalThis.__piSessions。
   */
  function attach(info: { sessionId: string; cwd?: string; subscribeEvent?: (l: (e: unknown) => void) => () => void; abortBash?: () => void }) {
    const sid = String(info.sessionId || "");
    if (!sid || sessions.has(sid)) return;
    let unsubscribe: (() => void) | undefined;
    let abort: (() => void) | undefined;
    try {
      if (typeof info.subscribeEvent === "function") unsubscribe = info.subscribeEvent((ev) => handleEvent(sid, ev));
      if (typeof info.abortBash === "function") abort = () => { try { info.abortBash?.(); } catch {} };
    } catch {}
    if (!unsubscribe || !abort) {
      try {
        const w = (globalThis as unknown as { __piSessions?: Map<string, { onEvent?: (l: (e: unknown) => void) => () => void; cwd?: unknown; inner?: { abortBash?: () => void }; send?: (cmd: unknown) => Promise<unknown> } | undefined> }).__piSessions?.get?.(sid);
        if (w) {
          if (!unsubscribe && typeof w.onEvent === "function") unsubscribe = w.onEvent((ev) => handleEvent(sid, ev));
          if (!abort) {
            if (w.inner && typeof w.inner.abortBash === "function") abort = () => { try { w.inner?.abortBash(); } catch {} };
            else if (typeof w.send === "function") abort = () => { void w.send?.({ type: "abort_bash" }).catch(() => {}); };
          }
        }
      } catch {}
    }
    sessions.set(sid, { cwd: info.cwd, unsubscribe, abort });
  }

  /** 扩展加载/reload 晚于 wrapper 创建：扫描 registry 补订阅（幂等） */
  function lateCatchUp() {
    try {
      const reg = (globalThis as unknown as { __piSessions?: Map<string, unknown> }).__piSessions;
      if (!reg || typeof reg.forEach !== "function") return;
      reg.forEach((w: unknown, sid: string) => {
        if (sessions.has(sid)) return;
        attach({ sessionId: sid, cwd: typeof (w as { cwd?: unknown })?.cwd === "string" ? (w as { cwd?: string }).cwd : undefined });
      });
    } catch {}
  }

  /** 会话销毁：退订 + 在跑条目收尾（wrapper 空闲 10min 回收 / 手动 shutdown） */
  function detach(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return;
    try { s.unsubscribe?.(); } catch {}
    sessions.delete(sessionId);
    for (const e of entries.values()) {
      if (e.sessionId === sessionId && e.status === "running") finishEntry(e, true);
    }
  }

  /** 惰性清理：过期/超量 done 条目 */
  function sweep() {
    const now = Date.now();
    const done = [...entries.values()].filter((e) => e.status === "done").sort((a, b) => (a.endTs ?? 0) - (b.endTs ?? 0));
    let removed = 0;
    for (const e of done) {
      const age = now - (e.endTs ?? 0);
      if (age > DONE_TTL_MS) { entries.delete(e.id); removed++; }
    }
    while (done.length > DONE_KEEP_MAX) { const e = done.shift()!; entries.delete(e.id); removed++; }
    if (removed) publishList(); // 列表快照推送（snapshotList 不 sweep，无递归）
  }

  // 定时清理：不等 list() 被调（否则无人开面板时 done 条目会持续堆积）；
  // unref 防阻拦进程退出；dispose() 时停表（防 reload 后旧闭包泄漏）
  const sweepTimer = setInterval(() => { try { sweep(); } catch {} }, 60_000);
  (sweepTimer as unknown as { unref?: () => void }).unref?.();

  /** 扩展 shutdown：停定时器 + 全部退订收尾 */
  function dispose() {
    clearInterval(sweepTimer);
    for (const sid of [...sessions.keys()]) detach(sid);
  }

  function list() {
    sweep();
    return snapshotList();
  }

  /**
   * 初始快照（REST；大消息不走 event-bus，订阅方先订阅后拉这个）。
   * text 返回已发布基线 publishedText（而非 e.text）——与后续 delta 帧严格衔接，
   * 配合 seq 去重：客户端 reset 重写基线后，只收 seq 更大的帧。
   */
  function get(id: string, metaOnly = false) {
    lateCatchUp();
    const e = entries.get(id);
    if (!e) return null;
    // metaOnly：轻量摘要（无 text）——客户端状态定案用，死命令免拉全量文本
    return { ...summaryOf(e), seq: e.seq, ...(metaOnly ? {} : { text: e.publishedText }) };
  }

  function kill(id: string) {
    lateCatchUp();
    const e = entries.get(id);
    if (!e) return json({ ok: false, error: "unknown pi-command" }, 404);
    if (e.status !== "running") return json({ ok: false, error: "命令已结束" }, 409);
    const s = sessions.get(e.sessionId);
    if (!s?.abort) return json({ ok: false, error: "会话不可达（未找到 wrapper/官方 abortBash）" }, 409);
    try { s.abort(); } catch (err) { return json({ ok: false, error: String((err as Error)?.message || err) }); }
    // 实际退出经 tool_execution_end → exit 事件下发（isError=true）
    return json({ ok: true, aborting: true });
  }

  function diag() {
    return {
      attached: sessions.size,
      subscribed: [...sessions.values()].filter((s) => s.unsubscribe).length,
      running: [...entries.values()].filter((e) => e.status === "running").length,
      done: [...entries.values()].filter((e) => e.status === "done").length,
    };
  }

  return { attach, detach, lateCatchUp, handleEvent, ensureLateEntry, list, get, kill, diag, dispose };
}

export type PiCommands = ReturnType<typeof createPiCommands>;
