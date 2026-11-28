/**
 * agent-starter registry — the on-disk index of detached agent sessions.
 *
 * Layout (root overridable via PI_AGENT_STARTER_DIR, shared by dev + prod so a
 * session spawned by one instance can be attached by the other):
 *
 *   (the wrapper program itself ships in the package: `pi-web wrapper`)
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
import { CH_CTRL, FrameParser, decodeControl, encodeControl, type Frame } from "./wire.ts";

export type RunnerKind = "systemd-run" | "plain" | "windows-cim";

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

/** Per-session survive-restart preference marker ("this session was last hosted detached"). */
export function prefsDir(): string {
  return join(starterRoot(), "prefs");
}

/** Create the directory skeleton (0700: launch files carry the full agent env). */
export function ensureStarterDirs(): void {
  for (const dir of [starterRoot(), registryDir(), runDir(), launchDir(), logDir(), prefsDir()]) {
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

/**
 * Endpoint the wrapper listens on.
 *
 * POSIX: a unix socket next to the registry (chmod 0600). Windows: a named pipe
 * — `\\.\pipe\<name>` needs no filesystem entry, has no path-length limit and
 * survives the same way (the run dir is still used for the ready marker/log).
 */
export function socketPathFor(platform: NodeJS.Platform, key: string): string {
  if (platform === "win32") return `\\\\.\\pipe\\aiti-agent-${key}`;
  return join(runDir(), `${key}.sock`);
}

export function socketPath(key: string): string {
  return socketPathFor(process.platform, key);
}

/** True when the endpoint is a Windows named pipe (no unlink/chmod, no existsSync). */
export function isPipeEndpoint(path: string): boolean {
  return path.startsWith("\\\\.\\pipe\\");
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

/**
 * Remove one session's tracking files (entry, ready marker, launch config, socket).
 *
 * Destructive: a live wrapper whose files are unlinked becomes unreachable while
 * its transient unit name stays taken — every later open then dies on
 * `systemd-run: unit already loaded` (2026-11-23 orphan incident). Callers must
 * only pass `reason` after proving the wrapper is dead, and the reason is logged
 * so the next incident has an audit trail.
 */
export function deleteEntry(key: string, reason?: string): void {
  const socket = socketPath(key);
  if (reason) console.warn(`[agent-starter] dropping registry files for ${key}: ${reason}`);
  for (const path of [entryPath(key), readyPath(key), launchConfigPath(key), ...(isPipeEndpoint(socket) ? [] : [socket])]) {
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

/**
 * Re-key an entry after the backend reported its real native session id
 * (omp/codebuddy style backends learn it only after start). The registry key
 * (socket/log/entry file names) stays unchanged; only `sessionId` moves, so
 * recovery lookups by the native id hit the same hosted process.
 */
export function rebindEntry(oldSessionId: string, newSessionId: string): boolean {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return false;
  // Backends announce the id in handle form ("claude:<sid>") while the registry is
  // keyed by the native id: accept either spelling on both sides.
  const nativeId = (value: string) => (value.includes(":") ? value.slice(value.indexOf(":") + 1) : value);
  const entry = findEntryBySession(oldSessionId) ?? findEntryBySession(nativeId(oldSessionId));
  if (!entry) return false;
  const next = nativeId(newSessionId);
  if (!next || next === entry.sessionId) return false;
  writeEntry({ ...entry, sessionId: next });
  // The survive-restart marker is keyed by the native id as well; a backend that
  // announces its real id only after start would otherwise keep the marker on the
  // provisional id and lose the detached preference on the next cold open.
  try {
    renameSync(prefPath(entry.sessionId), prefPath(next));
  } catch {
    /* no marker for the old id (or already moved) — nothing to carry over */
  }
  return true;
}

/** Registry entry for a native session id (undefined = not managed / already pruned). */
export function findEntryBySession(sessionId: string): SessionEntry | undefined {
  if (!sessionId) return undefined;
  for (const entry of listEntries()) {
    if (entry.sessionId === sessionId) return entry;
  }
  return undefined;
}

/** How long an entry may stay "launching" before a dead socket counts as death. */
export const LAUNCH_GRACE_MS = 20_000;

/**
 * Is this entry a launch still in flight?
 *
 * `spawn` writes the entry BEFORE systemd-run/pty starts, and the wrapper only
 * binds its socket afterwards. During that window the socket path is ENOENT —
 * which a naive probe reads as "dead" and prunes, deleting a live launch's
 * files (the other half of the 2026-11-23 orphan incident). Entries without a
 * backfilled agent/wrapper pid and younger than the ready timeout are treated
 * as in-flight, never as garbage.
 */
export function isLaunching(entry: SessionEntry, now = Date.now()): boolean {
  return entry.pid === undefined && entry.wrapperPid === undefined && now - entry.createdAt < LAUNCH_GRACE_MS;
}

/**
 * Result of probing a wrapper endpoint.
 *
 *   alive    a listener accepted the connection
 *   dead     nothing can be at that path (ENOENT) or the file has no listener
 *            (ECONNREFUSED) — the only states that justify deleting files
 *   unknown  the probe timed out or failed ambiguously: the wrapper may be alive
 *            but busy (single-threaded event loop, journal replay, GC pause)
 */
export type EndpointState = "alive" | "dead" | "unknown";

/**
 * Probe a unix socket / named pipe. Timeouts are deliberately NOT "dead": a
 * 500 ms stall in a live wrapper must never license unlinking its registry entry
 * and socket (that orphaned a running agent behind an occupied systemd unit on
 * 2026-11-23 — the unit refuses re-spawn, so every reopen failed).
 */
export function probeEndpoint(path: string, timeoutMs = 500): Promise<EndpointState> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (state: EndpointState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    const socket = connect({ path });
    socket.setTimeout(timeoutMs);
    // A bare connect+close is enough: the wrapper only promotes an identified
    // socket (hello_ack) or one that stays silent past its identify grace, so
    // this probe never supersedes the live client (2026-11-23). Sending a
    // frame here would leave the peer's half-open socket behind (server.close
    // waits on it) for no benefit.
    socket.once("connect", () => done("alive"));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      done(err?.code === "ENOENT" || err?.code === "ECONNREFUSED" ? "dead" : "unknown");
    });
    socket.once("timeout", () => done("unknown"));
  });
}

/**
 * Read-only writer-count query (hosting panel): connect, send query_peers, wait
 * for the wrapper's peers reply, hang up. Never a client, never a promote — the
 * wrapper answers and drops this socket itself. Undefined = wrapper dead or did
 * not answer (older wrappers without the query frame time out silently).
 *
 * The timeout MUST stay below the wrapper's 1s identify grace: a legacy wrapper
 * promotes any socket that stays silent past it, and this connection must be
 * gone before that (a promoted query socket would supersede the live writer on
 * a single-writer wrapper — the 2026-11-23 bug class).
 */
export function queryWriters(path: string, timeoutMs = 800): Promise<number | undefined> {
  return new Promise((resolve) => {
    const parser = new FrameParser();
    let settled = false;
    const done = (count: number | undefined) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(count);
    };
    const socket = connect({ path });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      try { socket.write(encodeControl({ t: "query_peers" })); } catch { done(undefined); }
    });
    socket.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = parser.push(chunk);
      } catch {
        done(undefined);
        return;
      }
      for (const frame of frames) {
        if (frame.channel !== CH_CTRL) continue;
        const control = decodeControl(frame.payload);
        if (control?.t === "peers") {
          done(typeof control.count === "number" ? control.count : undefined);
          return;
        }
      }
    });
    socket.once("error", () => done(undefined));
    socket.once("timeout", () => done(undefined));
    socket.once("close", () => done(undefined));
  });
}

/** Is a unix socket accepting connections right now? (timeouts read as false — use probeEndpoint when the answer deletes files) */
export function isSocketAlive(path: string, timeoutMs = 500): Promise<boolean> {
  return probeEndpoint(path, timeoutMs).then((state) => state === "alive");
}

/**
 * Drop entries whose wrapper is definitively gone (crash, reboot, manual cleanup).
 * Returns the removed entries. A busy wrapper (probe timeout) is kept: unlinking
 * its files would orphan a live agent behind a name systemd refuses to reuse.
 */
export async function pruneDeadEntries(): Promise<SessionEntry[]> {
  const entries = listEntries();
  const dead: SessionEntry[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (isLaunching(entry)) return;
      if ((await probeEndpoint(entry.socket)) !== "dead") return;
      deleteEntry(entry.key, "pruned: wrapper endpoint definitively dead");
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

/* ── Survive-restart preference markers ──
 *
 * The wrapper registry only tracks LIVE wrappers: pruneDeadEntries deletes the
 * entry as soon as the agent process exits, so "this session was last hosted
 * detached" would be lost exactly when it matters (the session is cold and the
 * next open must decide how to host it). A small per-session marker file keeps
 * that fact:
 *
 *   <root>/prefs/<sessionId>.json   { providerType, agentKey, cwd?, at }
 *
 * Written on a successful detached spawn, kept when the wrapper dies, cleared
 * when the user converts the session back to in-process hosting. Shared by dev
 * + prod like the rest of the starter root. */
export type DetachedPreference = {
  /**
   * Hosting choice for the next cold start. Absent = legacy "survives restarts"
   * (the marker existed before direct-subprocess preferences were added).
   * External agents use "subprocess" to persist a non-wrapper child process;
   * pi uses the marker only for the detached mode.
   */
  mode?: "subprocess" | "subprocess-detached";
  providerType?: string;
  agentKey?: string;
  cwd?: string;
  /** Epoch ms when the marker was (re)written. */
  at: number;
};

function prefPath(sessionId: string): string {
  return join(prefsDir(), `${sanitize(sessionId, 80)}.json`);
}

export function setDetachedPreference(sessionId: string, meta: Partial<DetachedPreference> = {}): void {
  ensureStarterDirs();
  const entry: DetachedPreference = { ...meta, at: Date.now() };
  const target = prefPath(sessionId);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  renameSync(tmp, target);
}

export function getDetachedPreference(sessionId: string): DetachedPreference | undefined {
  try {
    const raw = JSON.parse(readFileSync(prefPath(sessionId), "utf8")) as DetachedPreference;
    return raw && typeof raw.at === "number" ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function clearDetachedPreference(sessionId: string): void {
  try {
    unlinkSync(prefPath(sessionId));
  } catch {
    /* already gone — clearing is idempotent */
  }
}

/** All session ids that currently carry a survive-restart marker (direct-subprocess markers excluded). */
export function listDetachedPreferenceIds(): Set<string> {
  const out = new Set<string>();
  try {
    for (const file of readdirSync(prefsDir())) {
      if (!file.endsWith(".json")) continue;
      const id = file.slice(0, -".json".length);
      if (getDetachedPreference(id)?.mode === "subprocess") continue;
      out.add(id);
    }
  } catch {
    /* no prefs directory yet */
  }
  return out;
}

/**
 * Record the survive-restart preference for sessions a wrapper hosts right now
 * without a marker.
 *
 * Spawns write the marker themselves; a registry entry from an older build (or one
 * whose marker was removed by hand) would otherwise be the last chance to remember
 * the choice: once the wrapper is gone (idle reap, restart) nothing on disk says how
 * the session used to be hosted, and the next open falls back to the local runtime.
 * Markers already present win, so a deliberate choice is never overwritten.
 */
export function backfillDetachedPreferences(entries: SessionEntry[]): number {
  let written = 0;
  for (const entry of entries) {
    if (!entry.sessionId || getDetachedPreference(entry.sessionId)) continue;
    try {
      setDetachedPreference(entry.sessionId, {
        mode: "subprocess-detached",
        ...(entry.providerType ? { providerType: entry.providerType } : {}),
        ...(entry.agentKey ? { agentKey: entry.agentKey } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      });
      written += 1;
    } catch {
      /* best effort: diagnostics only */
    }
  }
  return written;
}
