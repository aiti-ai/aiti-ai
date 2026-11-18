/**
 * agent-starter registry — the on-disk index of detached agent sessions.
 *
 * Layout (root overridable via PI_AGENT_STARTER_DIR, shared by dev + prod so a
 * session spawned by one instance can be attached by the other):
 *
 *   <root>/wrapper.mjs                  published wrapper program (content-hash versioned)
 *   <root>/registry/<key>.json          one entry file per session (single writer per file)
 *   <root>/run/<key>.sock               unix socket served by the wrapper
 *   <root>/run/<key>.ready              written once the wrapper is listening
 *   <root>/launch/<key>.env.json        spawn options + env, deleted by the wrapper on read
 *   <root>/logs/<key>.log               agent stderr (4 MB cap, rotated on start)
 *
 * One JSON file per session (instead of one shared registry.json) keeps the
 * dev and prod instances from rewriting the same file concurrently: every
 * entry has exactly one writer (the instance that spawned it) and any process
 * can read the directory.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export type RunnerKind = "systemd-run" | "plain";

export type SessionEntry = {
  /** Native session id (pi uuid, ACP sid, …) — the recovery routing key. */
  sessionId: string;
  /** Agent family key ("pi", "claude", …) used to find a provider on attach. */
  agentKey: string;
  /** Registry key (file stem, also the socket file stem). */
  key: string;
  socket: string;
  ready: string;
  log: string;
  runner: RunnerKind;
  /** Transient systemd unit name (systemd-run runner only). */
  unit?: string;
  /** Epoch ms when the spawn was requested. */
  createdAt: number;
  /** Wrapper pid (backfilled from the hello frame). */
  wrapperPid?: number;
  /** Agent pid (backfilled from the hello frame). */
  pid?: number;
  /** Provider registry key that spawned it (exact reattach routing). */
  providerType?: string;
  /** Launch pid of the pi-web instance that spawned it (diagnostics only). */
  launcherPid?: number;
  cwd?: string;
};

/** Agent-starter root — shared by every pi-web instance of this user. */
export function starterRoot(): string {
  return process.env.PI_AGENT_STARTER_DIR || join(homedir(), ".pi", "agent", "agent-starter");
}

export function registryDir(): string {
  return join(starterRoot(), "registry");
}

export function runDir(): string {
  return join(starterRoot(), "run");
}

export function launchDir(): string {
  return join(starterRoot(), "launch");
}

export function logDir(): string {
  return join(starterRoot(), "logs");
}

export function wrapperPath(): string {
  return join(starterRoot(), "wrapper.mjs");
}

/** Create the directory skeleton (0700: launch files carry the full agent env). */
export function ensureStarterDirs(): void {
  for (const dir of [starterRoot(), registryDir(), runDir(), launchDir(), logDir()]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
  try {
    chmodSync(starterRoot(), 0o700);
  } catch {
    /* best effort: a pre-existing dir owned by another user is out of our control */
  }
}

function sanitize(value: string, max: number): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, max) || "x";
}

/**
 * Registry/socket key for a session.
 *
 * Unix socket paths are limited (108 bytes on Linux, 104 on macOS), so a long
 * or unusual session id is replaced by its hash — the entry file keeps the
 * real id and is the authoritative mapping.
 */
export function sessionKey(agentKey: string, sessionId: string, baseDir: string = runDir()): string {
  const agent = sanitize(agentKey || "agent", 16);
  const plain = `${agent}-${sanitize(sessionId, 40)}`;
  if (Buffer.byteLength(join(baseDir, `${plain}.sock`)) <= 100) return plain;
  const digest = createHash("sha1").update(sessionId).digest("hex").slice(0, 16);
  return `${agent}-h${digest}`;
}

export function entryPath(key: string): string {
  return join(registryDir(), `${key}.json`);
}

export function socketPath(key: string): string {
  return join(runDir(), `${key}.sock`);
}

export function readyPath(key: string): string {
  return join(runDir(), `${key}.ready`);
}

export function launchConfigPath(key: string): string {
  return join(launchDir(), `${key}.env.json`);
}

export function logPath(key: string): string {
  return join(logDir(), `${key}.log`);
}

/** Atomic per-entry write (tmp + rename in the same directory). */
export function writeEntry(entry: SessionEntry): void {
  ensureStarterDirs();
  const target = entryPath(entry.key);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

export function readEntry(key: string): SessionEntry | undefined {
  try {
    const raw = JSON.parse(readFileSync(entryPath(key), "utf8")) as SessionEntry;
    return raw && typeof raw.key === "string" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function deleteEntry(key: string): void {
  for (const path of [entryPath(key), socketPath(key), readyPath(key), launchConfigPath(key)]) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

export function listEntries(): SessionEntry[] {
  ensureStarterDirs();
  let names: string[];
  try {
    names = readdirSync(registryDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const entries: SessionEntry[] = [];
  for (const name of names) {
    const entry = readEntry(name.slice(0, -".json".length));
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Registry entry for a native session id (undefined = not managed / already pruned). */
export function findEntryBySession(sessionId: string): SessionEntry | undefined {
  if (!sessionId) return undefined;
  for (const entry of listEntries()) {
    if (entry.sessionId === sessionId) return entry;
  }
  return undefined;
}

/**
 * Is a unix socket accepting connections right now?
 * ENOENT / ECONNREFUSED / timeout all mean "no live wrapper".
 */
export function isSocketAlive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    const socket = connect({ path });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

/**
 * Drop entries whose wrapper is gone (crash, machine reboot, manual cleanup).
 * Returns the removed entries. Cheap enough to run at startup; the probe is
 * bounded (500 ms per entry) and entries are independent.
 */
export async function pruneDeadEntries(): Promise<SessionEntry[]> {
  const entries = listEntries();
  const dead: SessionEntry[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (await isSocketAlive(entry.socket)) return;
      deleteEntry(entry.key);
      dead.push(entry);
    }),
  );
  return dead;
}

/** Entry file mtime (epoch ms) — 0 when missing. Used by diagnostics/tests. */
export function entryMtime(key: string): number {
  try {
    return statSync(entryPath(key)).mtimeMs;
  } catch {
    return 0;
  }
}
