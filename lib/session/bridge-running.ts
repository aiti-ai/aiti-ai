/**
 * bridge-running — TUI 桥会话运行状态监听（无需 web 认领 attach 也能点亮侧栏 spinner）。
 *
 * 背景：attach handle 只在 web 打开该会话时惰性创建（attachIfBridged）。TUI 重启后
 * socket 路径变化，旧 handle 死亡；此后 TUI 再跑 turn，web 侧无人广播 running →
 * 左侧树「运行中」图标缺失（2026-08-28 dev E2E 实测复现：TUI 跑 turn 期间
 * /api/agent/running 恒空，直到用户重新打开该会话才恢复）。
 *
 * 机制：扫桥注册表（~/.pi/agent/bridge-registry.json，由 TUI 侧 pi-web-bridge 写入；
 * 格式契约见 pi-web-ext/aiti-attach-agent/bridge-registry.ts），对每个 live 条目挂一条
 * 只读监听连接——TUI 把 agent_start/agent_end 等事件广播给所有 client，监听连接据此
 * 维护该会话的 running 集。事件驱动零轮询；注册表扫描只在请求路径上节流触发
 * （5s），watcher 常驻直到 socket 关闭或注册表条目消失。
 *
 * 与 attach handle 的关系：互相独立、结果并集去重。同一会话两者都在时重复计数无害
 * （Set 合并）；full attach 关闭后 watcher 仍在，运行指示不中断。
 */

import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Listener = () => void;

interface BridgeWatcher {
  sessionIds: Set<string>;
  close(): void;
}

// globalThis 承载：next dev 热重载换模块实例时不丢 watcher/监听者（同 handle-store 模式）
interface BridgeRunningStore {
  watchers: Map<string, BridgeWatcher>; // key = socket 路径
  listeners: Set<Listener>;
  lastScanMs: number;
}

const g = globalThis as { __aitiBridgeRunning?: BridgeRunningStore };
const store: BridgeRunningStore = (g.__aitiBridgeRunning ??= {
  watchers: new Map(),
  listeners: new Set(),
  lastScanMs: 0,
});

const SCAN_THROTTLE_MS = 5_000;

/** 订阅桥侧运行变化（TUI agent_start/end 等经 watcher 触发）。返回退订函数。 */
export function subscribeBridgeRunning(listener: Listener): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

function notify(): void {
  for (const l of store.listeners) {
    try { l(); } catch { /* 监听者异常不扩散 */ }
  }
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

interface RegistryRow { sessionFile: string; socket: string; sessionId: string }

/** 读注册表并做 pid 存活过滤（格式/自愈语义对齐 aiti-attach-agent bridge-registry.readBridgeRegistry） */
function readRegistryRows(): RegistryRow[] {
  const registryPath =
    process.env.PI_BRIDGE_REGISTRY
    ?? join(homedir(), ".pi", "agent", "bridge-registry.json");
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, { socket?: unknown; pid?: unknown }>;
    const rows: RegistryRow[] = [];
    for (const [sessionFile, entry] of Object.entries(reg)) {
      const m = sessionFile.match(/_([0-9a-f-]{36})\.jsonl$/);
      const socket = typeof entry?.socket === "string" ? entry.socket : "";
      const pid = typeof entry?.pid === "number" ? entry.pid : 0;
      // 平铺文件名 → sessionId 从后缀推导；嵌套路径（fork 子代理
      // .../<childSessionUuid>/run-0/session.jsonl）→ sessionId 未知，
      // 由 watcher 播种 get_state 拿权威会话 id（bridge-runningSeed）。
      if (!socket) continue;
      if (pid && !isPidAlive(pid)) continue;
      rows.push({ sessionFile, socket, sessionId: m ? m[1] : "" });
    }
    return rows;
  } catch {
    return []; // 无注册表/解析失败 → 无桥
  }
}

/** 对单个注册表条目挂只读监听：连接时发一次 get_state 播种，之后纯靠广播帧维护。 */
function watchEntry(row: RegistryRow): void {
  const sessionIds = new Set<string>();
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    if (store.watchers.get(row.socket) === watcher) {
      store.watchers.delete(row.socket);
      if (sessionIds.size > 0) notify();
    }
  };

  const socket = connect({ path: row.socket });
  const watcher: BridgeWatcher = {
    sessionIds,
    close: () => { try { socket.destroy(); } catch { /* 已关 */ } finish(); },
  };

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      let msg: { id?: unknown; type?: unknown; data?: unknown };
      try { msg = JSON.parse(line); } catch { continue; }
      // 播种应答：get_state 权威化 sessionId（嵌套 fork 子代理条目在注册表里
      // 推导不出 id，播种拿到子代理运行时 session id = 列表行 id）+ isStreaming
      if (msg.id === "aiti-bridge-running-seed" && msg.type === "response") {
        const data = msg.data as { sessionId?: unknown; isStreaming?: unknown } | null;
        const sid = String(data?.sessionId ?? "") || row.sessionId;
        if (sid && sid !== row.sessionId) row.sessionId = sid;
        const streaming = (data as { isStreaming?: unknown } | null)?.isStreaming === true;
        if (streaming && row.sessionId && !sessionIds.has(row.sessionId)) {
          sessionIds.add(row.sessionId);
          notify();
        }
        continue;
      }
      if (typeof msg.type !== "string") continue;
      if (!row.sessionId) continue; // 播种前 id 未知，不维护 running 集
      if (msg.type === "agent_start" || msg.type === "turn_start") {
        if (!sessionIds.has(row.sessionId)) {
          sessionIds.add(row.sessionId);
          notify();
        }
      } else if (msg.type === "agent_end" || msg.type === "agent_settled") {
        if (sessionIds.delete(row.sessionId)) notify();
      }
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);

  // 连接建立后播种一次（TUI 中途开跑/我们中途接入都能拿到当前状态）
  socket.once("connect", () => {
    try {
      socket.write(JSON.stringify({ id: "aiti-bridge-running-seed", type: "get_state" }) + "\n");
    } catch { finish(); }
  });

  store.watchers.set(row.socket, watcher);
}

/** 注册表扫描（节流）：新增条目挂 watcher，消失条目收 watcher。 */
function ensureWatchers(): void {
  const now = Date.now();
  if (now - store.lastScanMs < SCAN_THROTTLE_MS) return;
  store.lastScanMs = now;

  const rows = readRegistryRows();
  const liveSockets = new Set(rows.map((r) => r.socket));
  for (const row of rows) {
    if (!store.watchers.has(row.socket)) watchEntry(row);
  }
  for (const [socketPath, watcher] of store.watchers) {
    if (!liveSockets.has(socketPath)) watcher.close();
  }
}

/** 桥侧正在执行 turn 的会话 id 集（与 handle 侧并集后进侧栏运行指示）。 */
export function getBridgeRunningIds(): string[] {
  ensureWatchers();
  const ids = new Set<string>();
  for (const w of store.watchers.values()) {
    for (const id of w.sessionIds) ids.add(id);
  }
  return [...ids];
}
