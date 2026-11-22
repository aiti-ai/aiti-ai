/**
 * aiti-cmd · detachable PTY sessions — client side of the pty-host.
 *
 * Borrowed architecture from lib/agent-starter (the mechanism that keeps external agent
 * sessions alive across pi-web restarts): one wrapper process per session, an on-disk
 * registry for reattachment, a unix socket with a framed protocol and a journal ring for
 * replay, single-writer semantics.
 *
 * Differences are PTY-specific: the wrapper spawns node-pty (a real tty, resize works),
 * and the protocol carries an input channel plus resize/kill control frames.
 *
 * Layout (root shared by the dev and prod instances so either can attach):
 *   <root>/pty-host.mjs             materialized host program (content-hash versioned)
 *   <root>/registry/<sid>.json      one entry per session (single writer per file)
 *   <root>/run/<sid>.sock           socket served by the host
 *   <root>/run/<sid>.sock.ready     written once the host is listening
 *   <root>/launch/<sid>.json        one-shot spawn config (deleted by the host on read)
 *   <root>/logs/<sid>.log           host stderr (diagnostics)
 *
 * Fallbacks: no systemd user manager / non-POSIX / spawn failure → the caller keeps its
 * in-process node-pty path. Nothing here is required for normal operation.
 */
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PTY_HOST_SOURCE } from "./pty-host-source.ts";

export type RunnerKind = "systemd-run" | "plain";

export type DetachProbe = {
  available: boolean;
  kind: RunnerKind;
  /** Coordinates the systemd user manager needs (empty for the plain runner). */
  env: Record<string, string>;
  detail: string;
};

export type HostEntry = {
  sid: string;
  cmd: string;
  cwd?: string;
  /** Runner-side session source ("shell" terminal vs one-shot command) — restored on reattach
   *  so pool accounting/audit stay correct across reloads. Missing on pre-source entries. */
  source?: string;
  socket: string;
  ready: string;
  log: string;
  pid?: number | null;
  wrapperPid?: number | null;
  runner: RunnerKind;
  unit?: string;
  createdAt: number;
};

export function detachRoot(): string {
  return process.env.AITI_CMD_HOST_DIR || join(homedir(), ".pi", "agent", "aiti-cmd-host");
}
const registryDir = () => join(detachRoot(), "registry");
const runDir = () => join(detachRoot(), "run");
const launchDir = () => join(detachRoot(), "launch");
const logDir = () => join(detachRoot(), "logs");

/** node-pty's node_modules root (the host resolves it from this directory). */
function ptyNodeModules(): string {
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve("node-pty"); // …/node_modules/node-pty/lib/index.js
    const idx = entry.lastIndexOf("/node-pty/");
    if (idx > 0) return entry.slice(0, idx);
    return join(entry, "..", "..", "..");
  } catch (_e) {
    return "";
  }
}

let probeCache: Promise<DetachProbe> | null = null;

/** Decide once per process how to start a process that outlives pi-web. */
export function probeDetach(): Promise<DetachProbe> {
  if (probeCache) return probeCache;
  probeCache = (async () => {
    const force = String(process.env.AITI_CMD_HOST_RUNNER || "").trim().toLowerCase();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const runtimeDir = process.env.XDG_RUNTIME_DIR || (uid !== undefined ? `/run/user/${uid}` : "");
    const bus = runtimeDir ? join(runtimeDir, "bus") : "";
    const env: Record<string, string> = {};
    if (runtimeDir && bus && existsSync(runtimeDir) && existsSync(bus)) {
      env.XDG_RUNTIME_DIR = runtimeDir;
      env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${bus}`;
    }
    const plain = (detail: string): DetachProbe => ({ available: process.platform !== "win32", kind: "plain", env, detail });
    if (process.env.AITI_CMD_DETACH === "0") return { available: false, kind: "plain", env, detail: "disabled by AITI_CMD_DETACH=0" };
    if (process.platform === "win32") return { available: false, kind: "plain", env, detail: "win32: no detachable PTY host (in-process PTY is used)" };
    if (force === "plain") return plain("forced by AITI_CMD_HOST_RUNNER=plain");
    if (force === "systemd") return { available: true, kind: "systemd-run", env, detail: "forced by AITI_CMD_HOST_RUNNER=systemd" };
    if (!existsSync("/usr/bin/systemd-run") && !existsSync("/bin/systemd-run")) return plain("systemd-run not installed");
    if (!env.XDG_RUNTIME_DIR) return plain("systemd user manager unreachable (no /run/user/<uid>/bus)");
    const alive = await new Promise<boolean>((resolve) => {
      execFile("systemctl", ["--user", "is-system-running"], { env: { ...process.env, ...env }, timeout: 4000 }, (err, stdout) => {
        if (err) { const state = String(stdout ?? "").trim(); resolve(state === "degraded" || state === "starting"); return; }
        resolve(true);
      });
    });
    return alive
      ? { available: true, kind: "systemd-run", env, detail: "systemd user manager reachable" }
      : plain("systemd user manager not answering");
  })();
  return probeCache;
}

/** Materialize the host program (content-hash versioned, like agent-starter's wrapper). */
export function materializeHost(): string {
  const root = detachRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(PTY_HOST_SOURCE).digest("hex").slice(0, 12);
  const target = join(root, `pty-host.${hash}.mjs`);
  if (!existsSync(target)) {
    writeFileSync(target, PTY_HOST_SOURCE, { mode: 0o700 });
    chmodSync(target, 0o700);
    // keep the directory tidy: previous builds are dead weight
    try {
      for (const f of readdirSync(root)) if (/^pty-host\.[0-9a-f]+\.mjs$/.test(f) && join(root, f) !== target) unlinkSync(join(root, f));
    } catch (_e) { /* best effort */ }
  }
  return target;
}

export function listEntries(): HostEntry[] {
  try {
    const out: HostEntry[] = [];
    for (const f of readdirSync(registryDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const e = JSON.parse(readFileSync(join(registryDir(), f), "utf8")) as HostEntry;
        if (e && e.sid && e.socket) out.push(e);
      } catch (_e) { /* torn file — ignore */ }
    }
    return out;
  } catch (_e) { return []; }
}

export function writeEntry(entry: HostEntry): void {
  mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
  const file = join(registryDir(), entry.sid + ".json");
  const tmp = file + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
  renameSync(tmp, file); // atomic: readers never see a torn entry
}

export function removeEntry(sid: string, opts?: { killProcesses?: boolean }): void {
  let entry: HostEntry | null = null;
  if (opts?.killProcesses) {
    // read before deleting: the entry carries the pids we may need to reap
    try { entry = JSON.parse(readFileSync(join(registryDir(), sid + ".json"), "utf8")) as HostEntry; } catch (_e) { /* no entry */ }
  }
  for (const p of [join(registryDir(), sid + ".json"), join(runDir(), sid + ".sock"), join(runDir(), sid + ".sock.ready")]) {
    try { unlinkSync(p); } catch (_e) { /* already gone */ }
  }
  if (entry) killEntryProcesses(entry);
}

/** Last-resort reaping when an entry is dropped while its processes may still be alive
 *  (reattach failure, half-started spawn, host that missed its exit): SIGTERM the pty-host
 *  wrapper and the shell pid, escalating to SIGKILL after a grace. Fire-and-forget.
 *  NEVER use this on a mere failed reattach/claim — the host may have been superseded by
 *  another pi-web instance sharing this detach root, not dead. */
function killEntryProcesses(e: HostEntry): void {
  for (const pid of [e.wrapperPid, e.pid]) {
    if (!pid || pid <= 0 || !pidAlive(pid)) continue;
    try { process.kill(pid, "SIGTERM"); } catch (_e) { /* already gone */ }
    const t = setTimeout(() => {
      try { if (pidAlive(pid)) process.kill(pid, "SIGKILL"); } catch (_e) { /* already gone */ }
    }, 3000);
    if (typeof t.unref === "function") t.unref();
  }
}

/** Best-effort liveness probe for a wrapper pid (entry pruning). */
function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_e) { return false; }
}

/** True when the entry's host wrapper or shell process is still alive. Callers dropping an
 *  entry without killing (failed reattach/claim) use this to decide whether the files may
 *  be removed at all — a live host means the entry still belongs to someone. */
export function entryProcessesAlive(e: HostEntry): boolean {
  return pidAlive(e.wrapperPid) || pidAlive(e.pid);
}

export function pruneEntries(): void {
  for (const e of listEntries()) if (!pidAlive(e.wrapperPid) && !existsSync(e.socket)) removeEntry(e.sid);
  // one-shot launch configs: a host that died before reading its config leaves the file behind
  try {
    const now = Date.now();
    for (const f of readdirSync(launchDir())) {
      const p = join(launchDir(), f);
      try { if (now - statSync(p).mtimeMs > 3600_000) unlinkSync(p); } catch (_e) { /* raced with the host */ }
    }
  } catch (_e) { /* no launch dir yet */ }
}

export type SpawnHostOptions = {
  sid: string;
  cmd: string;
  cwd?: string;
  /** Session source persisted into the registry entry (see HostEntry.source). */
  source?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
  name?: string;
};

/** Spawn a detached PTY host for this session. Throws when the host cannot start. */
export async function spawnHost(opts: SpawnHostOptions): Promise<HostEntry> {
  const probe = await probeDetach();
  if (!probe.available) throw new Error(probe.detail);
  const root = detachRoot();
  for (const d of [runDir(), launchDir(), logDir(), registryDir()]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const hostProgram = materializeHost();

  const socket = join(runDir(), opts.sid + ".sock");
  const ready = socket + ".ready";
  const entryPath = join(registryDir(), opts.sid + ".json");
  const launchPath = join(launchDir(), opts.sid + ".json");
  const log = join(logDir(), opts.sid + ".log");
  try { unlinkSync(ready); } catch (_e) { /* stale */ }

  const entry: HostEntry = {
    sid: opts.sid,
    cmd: opts.cmd,
    cwd: opts.cwd,
    source: opts.source,
    socket,
    ready,
    log,
    runner: probe.kind,
    createdAt: Date.now(),
  };

  // "＋ new terminal" is the literal "$SHELL" marker: let the host start the login shell.
  const isShell = /^\$shell$/i.test(String(opts.cmd || "").trim());
  const file = isShell ? (process.env.SHELL || "/bin/bash") : (process.env.SHELL || "/bin/bash");
  const args = isShell ? [] : ["-c", opts.cmd];

  const launch = {
    file,
    args,
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...(opts.env || {}), TERM: "xterm-256color" },
    cols: opts.cols,
    rows: opts.rows,
    socket,
    ready,
    registryEntry: entryPath,
    nodeModules: ptyNodeModules(),
  };
  writeFileSync(launchPath, JSON.stringify(launch), { mode: 0o600 });
  writeEntry(entry);

  const nodeBin = process.execPath;
  const spawnEnv = { ...process.env, ...probe.env };
  let unit: string | undefined;
  try {
    if (probe.kind === "systemd-run") {
      unit = "aiti-cmd-" + opts.sid;
      // A transient service unit in user.slice: immune to `systemctl restart pi-web`
      // (which kills the service cgroup, not the user manager's units).
      const args1 = ["--user", "--collect", "--quiet", "--unit", unit, "--service-type=simple", "--", nodeBin, hostProgram, "--config", launchPath];
      await new Promise<void>((resolve, reject) => {
        execFile("systemd-run", args1, { env: spawnEnv, timeout: 8000 }, (err, _stdout, stderr) => {
          if (err) reject(new Error(String(stderr || err.message).trim() || "systemd-run failed"));
          else resolve();
        });
      });
    } else {
      const child = spawn(nodeBin, [hostProgram, "--config", launchPath], { env: spawnEnv, detached: true, stdio: "ignore" });
      child.unref();
      if (child.pid) entry.wrapperPid = child.pid;
    }
  } catch (e) {
    removeEntry(opts.sid);
    try { unlinkSync(launchPath); } catch (_e) { /* ignore */ }
    throw e;
  }
  entry.unit = unit;
  writeEntry(entry);

  // Bounded startup wait: the socket appears as soon as the host listens.
  const started = Date.now();
  let lastErr: Error | null = null;
  while (Date.now() - started < 8000) {
    try {
      const hello = await new Promise<{ pid?: number; wrapperPid?: number }>((resolve, reject) => {
        const sock = connect(socket);
        const timer = setTimeout(() => { try { sock.destroy(); } catch (_e) {} reject(new Error("hello timeout")); }, 1200);
        sock.once("connect", () => { /* wait for the hello frame */ });
        sock.once("error", (err) => { clearTimeout(timer); reject(err); });
        // Do not keep this probe socket: we only need the pid backfill. Read one frame.
        let buf = Buffer.alloc(0);
        sock.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 5) {
            const len = buf.readUInt32BE(1);
            if (buf.length < 5 + len) break;
            const ch = buf.readUInt8(0);
            const payload = buf.subarray(5, 5 + len);
            buf = buf.subarray(5 + len);
            if (ch === 3) {
              try {
                const msg = JSON.parse(payload.toString("utf8")) as { t?: string; pid?: number; wrapperPid?: number; message?: string };
                if (msg.t === "hello") { clearTimeout(timer); try { sock.destroy(); } catch (_e) {} resolve(msg); return; }
                if (msg.t === "spawn_error") { clearTimeout(timer); try { sock.destroy(); } catch (_e) {} reject(new Error(msg.message || "spawn failed")); return; }
              } catch (_e) { /* ignore malformed control */ }
            }
          }
        });
      });
      entry.pid = hello.pid ?? null;
      entry.wrapperPid = hello.wrapperPid ?? entry.wrapperPid ?? null;
      writeEntry(entry);
      return entry;
    } catch (e) {
      lastErr = e as Error;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  removeEntry(opts.sid);
  throw new Error("detached pty host did not come up: " + (lastErr ? lastErr.message : "timeout"));
}

export type HostHandlers = {
  onHello?: (msg: { pid?: number; wrapperPid?: number; cols?: number; rows?: number; seq?: number; journalBytes?: number }) => void;
  onData: (text: string) => void;
  onExit: (msg: { code: number | null; signal: string | null; durationMs?: number }) => void;
  onSuperseded?: () => void;
  onClose?: () => void;
  onError?: (err: Error) => void;
};

/** Connect to a live host. Throws when the socket is gone (session lost). */
export function attachHost(entry: HostEntry, handlers: HostHandlers) {
  const sock = connect(entry.socket);
  let pending = Buffer.alloc(0);
  let closed = false;
  const close = () => { if (!closed) { closed = true; try { sock.destroy(); } catch (_e) { /* ignore */ } } };

  sock.on("connect", () => { /* frames follow */ });
  sock.on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    while (pending.length - offset >= 5) {
      const channel = pending.readUInt8(offset);
      const length = pending.readUInt32BE(offset + 1);
      if (length > 32 * 1024 * 1024) { close(); return; }
      if (pending.length < offset + 5 + length) break;
      const payload = pending.subarray(offset + 5, offset + 5 + length);
      offset += 5 + length;
      if (channel === 1) handlers.onData(payload.toString("utf8"));
      else if (channel === 3) {
        try {
          const msg = JSON.parse(payload.toString("utf8")) as Record<string, unknown> & { t?: string };
          if (msg.t === "hello") handlers.onHello?.(msg as never);
          else if (msg.t === "exit") handlers.onExit({ code: (msg.code as number) ?? null, signal: (msg.signal as string) ?? null, durationMs: msg.durationMs as number });
          else if (msg.t === "superseded") handlers.onSuperseded?.();
          else if (msg.t === "spawn_error") handlers.onError?.(new Error(String(msg.message || "spawn failed")));
        } catch (_e) { /* malformed control */ }
      }
    }
    if (offset) pending = pending.subarray(offset);
  });
  sock.on("error", (err) => handlers.onError?.(err as Error));
  sock.on("close", () => { if (!closed) { closed = true; handlers.onClose?.(); } });

  const frame = (channel: number, payload: Buffer) => {
    const header = Buffer.allocUnsafe(5);
    header.writeUInt8(channel & 0xff, 0);
    header.writeUInt32BE(payload.length, 1);
    const buf = Buffer.concat([header, payload]);
    try { sock.write(buf); } catch (_e) { /* closed */ }
  };
  return {
    writeInput(data: string) { frame(0, Buffer.from(data, "utf8")); },
    resize(cols: number, rows: number) { frame(3, Buffer.from(JSON.stringify({ t: "resize", cols, rows }), "utf8")); },
    kill(signal = "SIGTERM") { frame(3, Buffer.from(JSON.stringify({ t: "kill", signal }), "utf8")); },
    close,
  };
}
