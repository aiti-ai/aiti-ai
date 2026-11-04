/**
 * Bridge registry — maps live TUI session files to their pi-web bridge sockets.
 *
 * Written by the pi TUI /web bridge extension (pi-web-bridge.ts) when a bridge
 * starts; cleaned up on session_shutdown. Read by pi-web core when opening a
 * session: a registry hit means "this session is owned by a running TUI with a
 * bridge — attach to the socket instead of opening the file locally"
 * (single-writer rule; prevents two runtimes appending to one .jsonl).
 *
 * Cross-platform: socket is a Unix domain socket path OR a Windows named pipe
 * (\\.\pipe\NAME) — node:net treats both as ConnectOpts paths.
 *
 * File: ~/.pi/agent/bridge-registry.json
 * {
 *   "/abs/path/session.jsonl": { socket, pid, startedAt },
 * }
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeEntry {
  /** Unix socket path or Windows named pipe. */
  socket: string;
  /** Owning pi process — used for cheap staleness checks. */
  pid: number;
  startedAt: number;
}

type Registry = Record<string, BridgeEntry>;

function registryPath(): string {
  return process.env.PI_BRIDGE_REGISTRY || join(homedir(), ".pi", "agent", "bridge-registry.json");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read the whole registry, dropping entries whose owning pid is gone. */
export async function readBridgeRegistry(): Promise<Registry> {
  const file = registryPath();
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(await readFile(file, "utf8")) as Registry;
    const out: Registry = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v?.pid && isPidAlive(v.pid)) out[k] = v;
      else await removeBridgeEntry(k).catch(() => {}); // self-clean stale
    }
    return out;
  } catch {
    return {};
  }
}

export async function writeBridgeEntry(sessionFile: string, entry: BridgeEntry): Promise<void> {
  const reg = await readBridgeRegistry();
  reg[sessionFile] = entry;
  await atomicWriteJson(registryPath(), reg);
}

/**
 * 原子替换写（tmp + rename）：非原子直写会让并发读者（dev/prod 两个 pi-web +
 * 多个 TUI 进程共享同一份 registry）见到半截 JSON——readBridgeRegistry 解析失败
 * 当空表，随后任何一次 read-modify-write 都会把全部条目抹掉（attach 全体失效）。
 */
async function atomicWriteJson(file: string, reg: Registry): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(reg, null, 2), "utf8");
  await rename(tmp, file);
}

export async function removeBridgeEntry(sessionFile: string): Promise<void> {
  const file = registryPath();
  if (!existsSync(file)) return;
  try {
    const reg = JSON.parse(await readFile(file, "utf8")) as Registry;
    delete reg[sessionFile];
    await atomicWriteJson(file, reg);
  } catch { /* best-effort */ }
}

/** 注册表声明占用但桥不可达——调用方必须报错而非回退本地打开（单写者红线）。 */
export class BridgeOccupiedError extends Error {
  readonly sessionFile: string;
  constructor(sessionFile: string, detail: string) {
    super(`Session is owned by another pi process (bridge unreachable: ${detail}). Refusing to open locally.`);
    this.name = "BridgeOccupiedError";
    this.sessionFile = sessionFile;
  }
}

/** Socket/pipeline name for the TUI bridge (cross-platform). */
export function bridgeSocketName(pid: number): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-tui-bridge-${pid}`
    : `/tmp/pi-tui-bridge-${pid}`;
}

/** 主动探测 socket 可连接性（权威存活信号——pid 会复用、进程可能假死）。 */
function probeSocketAlive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ path: socketPath });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Find a live bridge for a session file. Returns the socket name ONLY when
 * the owning process is alive AND the socket accepts connections — anything
 * else is treated as stale (self-cleaned) so the session opens locally.
 *
 * Liveness layers:
 *   1. pid check (cheap, read time) — filters obvious deaths
 *   2. active socket probe (authoritative) — catches pid reuse & hung processes
 */
export async function findBridgeSocketForSession(sessionFile: string): Promise<string | undefined> {
  const reg = await readBridgeRegistry();
  const entry = reg[sessionFile];
  if (!entry) return undefined;
  // 二次确认（readBridgeRegistry 只查了 pid）：socket 连不上 = 桥已死
  if (!(await probeSocketAlive(entry.socket))) {
    await removeBridgeEntry(sessionFile).catch(() => {});
    return undefined;
  }
  return entry.socket;
}

/** 活桥条目（含 pid），供 ownsFile/createSession 复用。 */
export async function findLiveBridgeEntry(
  sessionFile: string,
): Promise<{ socket: string; pid: number } | undefined> {
  const socket = await findBridgeSocketForSession(sessionFile);
  if (!socket) return undefined;
  const reg = await readBridgeRegistry();
  return reg[sessionFile] ? { socket, pid: reg[sessionFile].pid } : undefined;
}

/** TUI 桥启动：登记（socket 名按 pid 跨平台生成）。 */
export async function registerBridge(sessionFile: string): Promise<void> {
  await writeBridgeEntry(sessionFile, {
    socket: bridgeSocketName(process.pid),
    pid: process.pid,
    startedAt: Date.now(),
  });
}

/** TUI 桥关闭：注销。 */
export async function unregisterBridge(sessionFile: string): Promise<void> {
  await removeBridgeEntry(sessionFile);
}
