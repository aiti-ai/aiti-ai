/**
 * WrapperStarter — detachable implementation of {@link AgentStarter}.
 *
 * Responsibilities (all decisions were made at construction time by the
 * factory; spawn() itself is a straight line):
 *
 *   spawn()  write the one-shot launch config (full env, 0600), record the
 *            registry entry, start wrapper.mjs under the chosen runner, wait
 *            for its socket, hand back a SocketChild facade.
 *   attach() reconnect to a wrapper that survived a pi-web restart (the
 *            wrapper replays its journal, so the caller sees the same stream).
 *   holds()  registry probe used by the core's recovery routing.
 *   kill()   stop the agent through the wrapper's control channel, then drop
 *            the registry entry.
 *
 * Single writer is structural: a wrapper listens on one socket and supersedes
 * older clients, so two pi-web instances can never drive one agent at once.
 */

import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { basename, join } from "node:path";
import type { AgentStarterSpawnOptions, WrapperStarter } from "./types.ts";
import {
  CH_CTRL,
  FrameParser,
  decodeControl,
  encodeControl,
  type Frame,
  type HelloFrame,
} from "./wire.ts";
import { SocketChild } from "./socket-child.ts";
import {
  deleteEntry,
  ensureStarterDirs,
  entryPath,
  findEntryBySession,
  isSocketAlive,
  launchConfigPath,
  listEntries,
  logPath,
  readEntry,
  readyPath,
  registryDir,
  runDir,
  sessionKey,
  socketPath,
  starterRoot,
  writeEntry,
  type RunnerKind,
  type SessionEntry,
} from "./registry.ts";
import { launchWrapper, stopLauncher } from "./runner.ts";
import { WRAPPER_SOURCE } from "./wrapper-source.ts";

/** How long a freshly launched wrapper may take to start listening. */
const READY_TIMEOUT_MS = 15_000;
/** Handshake timeout (attach + spawn). */
const HELLO_TIMEOUT_MS = 10_000;

export type WrapperStarterOptions = {
  runner: RunnerKind;
  /** Env the launcher needs (systemd user bus coordinates). */
  runnerEnv: Record<string, string>;
  /** Node binary used to run wrapper.mjs (defaults to this process's). */
  nodePath?: string;
};

type Handshake = {
  socket: Socket;
  hello: HelloFrame;
  prelude: { frames: Frame[]; bytes: Buffer };
};

/** Materialize wrapper.mjs into the starter root (content versioned, 0700). */
export function materializeWrapper(): string {
  ensureStarterDirs();
  const target = join(starterRoot(), "wrapper.mjs");
  let current: string | undefined;
  try {
    current = readFileSync(target, "utf8");
  } catch {
    current = undefined;
  }
  if (current !== WRAPPER_SOURCE) {
    // Atomic swap: a concurrently spawning instance sees either version whole.
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, WRAPPER_SOURCE, { mode: 0o700 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, target);
  }
  return target;
}

/** Wait for a file to appear, driven by directory events (no polling loop). */
function waitForFile(path: string, dir: string, timeoutMs: number): Promise<boolean> {
  if (existsSync(path)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const name = basename(path);
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename && filename !== name) return;
        if (existsSync(path)) finish(true);
      });
      watcher.on("error", () => finish(existsSync(path)));
    } catch {
      // Directory watch unavailable → fall back to the timeout check below.
    }
    timer = setTimeout(() => finish(existsSync(path)), timeoutMs);
    timer.unref?.();
  });
}

/** Wait for a file to disappear (wrapper shutdown), driven by directory events. */
function waitForFileGone(path: string, dir: string, timeoutMs: number): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const name = basename(path);
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename && filename !== name) return;
        if (!existsSync(path)) finish(true);
      });
      watcher.on("error", () => finish(!existsSync(path)));
    } catch {
      // watch unavailable → the timeout decides
    }
    timer = setTimeout(() => finish(!existsSync(path)), timeoutMs);
    timer.unref?.();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Connect and read the handshake. Bounded retries cover the (rare) window
 * where the socket file exists before the listener accepts.
 */
async function connectWithHandshake(path: string, timeoutMs = HELLO_TIMEOUT_MS): Promise<Handshake> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await onceConnect(path, timeoutMs);
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ECONNREFUSED" && code !== "EAGAIN") break;
      await sleep(attempt === 0 ? 25 : 100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function onceConnect(path: string, timeoutMs: number): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path });
    const parser = new FrameParser();
    const frames: Frame[] = [];
    let settled = false;
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (timer) clearTimeout(timer);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => fail(new Error(`agent-starter: wrapper closed before handshake (${path})`));
    const onData = (chunk: Buffer) => {
      let parsed: Frame[];
      try {
        parsed = parser.push(chunk);
      } catch (err) {
        fail(err as Error);
        return;
      }
      let hello: HelloFrame | undefined;
      for (const frame of parsed) {
        if (frame.channel === CH_CTRL) {
          const control = decodeControl(frame.payload);
          if (control?.t === "hello") {
            hello = control;
            continue;
          }
          if (control?.t === "spawn_error") {
            fail(new Error(`agent-starter: ${control.message}`));
            return;
          }
        }
        frames.push(frame);
      }
      if (!hello) return;
      settled = true;
      cleanup();
      resolve({ socket, hello, prelude: { frames, bytes: parser.drainPending() } });
    };
    const timer = setTimeout(
      () => fail(new Error(`agent-starter: handshake timed out after ${timeoutMs}ms (${path})`)),
      timeoutMs,
    );
    timer.unref?.();
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

type FacadeOptions = {
  command: string;
  args: string[];
  sessionId?: string;
  agentKey?: string;
  cwd?: string;
};

/** Build the facade child from a completed handshake. */
function childFrom(handshake: Handshake, options: FacadeOptions): SocketChild {
  const { hello, socket, prelude } = handshake;
  return new SocketChild(
    socket,
    {
      pid: hello.pid,
      wrapperPid: hello.wrapperPid,
      sessionId: hello.sessionId ?? options.sessionId,
      agentKey: hello.agentKey ?? options.agentKey,
      spawnfile: options.command,
      spawnargs: options.args,
    },
    prelude,
  );
}

export class LinuxMacWrapperStarter implements WrapperStarter {
  readonly kind = "wrapper" as const;
  readonly runner: RunnerKind;

  private readonly runnerEnv: Record<string, string>;
  private readonly nodePath: string;
  private wrapperPath: string | undefined;

  constructor(options: WrapperStarterOptions) {
    this.runner = options.runner;
    this.runnerEnv = options.runnerEnv;
    this.nodePath = options.nodePath ?? process.execPath;
  }

  private wrapper(): string {
    if (!this.wrapperPath) this.wrapperPath = materializeWrapper();
    return this.wrapperPath;
  }

  // --------------------------------------------------------------------------
  // AgentStarter
  // --------------------------------------------------------------------------

  async spawn(command: string, args: string[], options: AgentStarterSpawnOptions = {}): Promise<ChildProcess> {
    const sessionId = (options.sessionId ?? "").trim();
    if (!sessionId) {
      throw new Error(
        "agent-starter: detachable spawn requires options.sessionId — it is the registry key used to reattach after a restart",
      );
    }
    const agentKey = (options.agentKey ?? "").trim() || "agent";
    const key = sessionKey(agentKey, sessionId);
    ensureStarterDirs();

    // Refuse to double-own a live session: the registry entry + live socket is
    // authoritative (a stale entry with a dead socket is pruned instead).
    const previous = readEntry(key);
    if (previous) {
      if (await isSocketAlive(previous.socket)) {
        throw new Error(`agent-starter: session ${sessionId} is already hosted by a detached wrapper (${previous.socket})`);
      }
      deleteEntry(key);
    }

    const entry: SessionEntry = {
      sessionId,
      agentKey,
      key,
      socket: socketPath(key),
      ready: readyPath(key),
      log: logPath(key),
      runner: this.runner,
      createdAt: Date.now(),
      launcherPid: process.pid,
      ...(options.owner ? { providerType: options.owner } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    };
    // Never inherit a socket file without a live owner.
    for (const stale of [entry.socket, entry.ready]) {
      try {
        unlinkSync(stale);
      } catch {
        /* absent */
      }
    }

    const configPath = launchConfigPath(key);
    writeFileSync(
      configPath,
      JSON.stringify({
        key,
        sessionId,
        agentKey,
        runner: this.runner,
        socket: entry.socket,
        ready: entry.ready,
        log: entry.log,
        registryEntry: entryPath(key),
        command,
        args,
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: options.shell,
      }),
      { mode: 0o600 },
    );
    writeEntry(entry);

    let launched: { launcherPid?: number; unit?: string };
    try {
      launched = await launchWrapper({
        runner: this.runner,
        nodePath: this.nodePath,
        wrapperPath: this.wrapper(),
        configPath,
        key,
        env: this.runnerEnv,
      });
    } catch (err) {
      this.drop(key);
      throw err;
    }
    if (launched.unit || (launched.launcherPid && launched.launcherPid !== entry.launcherPid)) {
      writeEntry({ ...entry, ...(launched.unit ? { unit: launched.unit } : {}) });
    }

    const ready = await waitForFile(entry.ready, runDir(), READY_TIMEOUT_MS);
    if (!ready) {
      stopLauncher(this.runner, launched.unit, launched.launcherPid, this.runnerEnv);
      this.drop(key);
      throw new Error(`agent-starter: wrapper for session ${sessionId} did not become ready within ${READY_TIMEOUT_MS}ms`);
    }

    let handshake: Handshake;
    try {
      handshake = await connectWithHandshake(entry.socket);
    } catch (err) {
      stopLauncher(this.runner, launched.unit, launched.launcherPid, this.runnerEnv);
      this.drop(key);
      throw err;
    }

    writeEntry({ ...entry, ...(launched.unit ? { unit: launched.unit } : {}), wrapperPid: handshake.hello.wrapperPid, pid: handshake.hello.pid });
    const child = childFrom(handshake, { command, args, sessionId, agentKey, cwd: options.cwd });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`agent-starter: agent process exited immediately (session ${sessionId})`);
    }
    return child.asChildProcess();
  }

  // --------------------------------------------------------------------------
  // Recovery
  // --------------------------------------------------------------------------

  /** Does a detached wrapper hold this session right now? Prunes dead entries. */
  async holds(sessionId: string): Promise<boolean> {
    const entry = findEntryBySession(sessionId);
    if (!entry) return false;
    if (await isSocketAlive(entry.socket)) return true;
    deleteEntry(entry.key);
    return false;
  }

  /** Registry entry for a session (undefined = not hosted / already pruned). */
  describe(sessionId: string): SessionEntry | undefined {
    return findEntryBySession(sessionId);
  }

  /** Attach to a wrapper-hosted session (journal replay included). */
  async attach(sessionId: string): Promise<ChildProcess> {
    const entry = findEntryBySession(sessionId);
    if (!entry) throw new Error(`agent-starter: no detached wrapper holds session ${sessionId}`);
    let handshake: Handshake;
    try {
      handshake = await connectWithHandshake(entry.socket);
    } catch (err) {
      deleteEntry(entry.key);
      throw err;
    }
    const child = childFrom(handshake, {
      command: "",
      args: [],
      sessionId,
      agentKey: entry.agentKey,
      cwd: entry.cwd,
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`agent-starter: agent of session ${sessionId} already exited`);
    }
    return child.asChildProcess();
  }

  /**
   * Stop a wrapper-hosted session (delete path, recycle policy).
   *
   * Signalling the wrapper process (rather than opening a control connection)
   * keeps single-writer semantics intact: a handle that is watching the session
   * receives a normal exit frame instead of being superseded, so the UI sees
   * the process end cleanly. The control frame remains the fallback for an
   * entry whose wrapper pid is stale.
   */
  async kill(sessionId: string, signal = "SIGTERM"): Promise<boolean> {
    const entry = findEntryBySession(sessionId);
    if (!entry) return false;
    let signalled = false;
    if (typeof entry.wrapperPid === "number" && entry.wrapperPid > 0) {
      try {
        process.kill(entry.wrapperPid, signal as NodeJS.Signals);
        signalled = true;
      } catch {
        signalled = false;
      }
    }
    if (signalled) {
      await waitForFileGone(entry.socket, runDir(), 8000);
    } else if (await isSocketAlive(entry.socket)) {
      await this.sendKillFrame(entry.socket, signal);
    }
    deleteEntry(entry.key);
    return true;
  }

  /** Control-channel kill (fallback when the wrapper pid is unknown/stale). */
  private sendKillFrame(socketPath: string, signal: string): Promise<void> {
    return new Promise((resolve) => {
      const socket = connect({ path: socketPath });
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        resolve();
      };
      socket.once("connect", () => {
        try {
          socket.write(encodeControl({ t: "kill", signal }));
        } catch {
          /* connection died */
        }
      });
      socket.once("close", done);
      socket.once("error", done);
      setTimeout(done, 8000).unref?.();
    });
  }

  list(): SessionEntry[] {
    return listEntries();
  }

  private drop(key: string): void {
    deleteEntry(key);
    try {
      unlinkSync(launchConfigPath(key));
    } catch {
      /* already consumed */
    }
  }
}
