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
 * Multi-writer is structural since the 2026-11-28 cross-instance incident: a
 * wrapper serves N concurrent clients (multi-attach, dtach/tmux style) —
 * stdout/stderr broadcast to every client, each client's stdin forwards to the
 * agent and mirrors to the others (ch4) — so two pi-web instances can share
 * one agent at the same time instead of silently superseding each other.
 * Turn-level serialization between writers lives in the session backend (the
 * handle queues its own prompts while a peer's turn is in flight), not here:
 * the wrapper stays protocol-agnostic bytes.
 */

import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  isLaunching,
  isSocketAlive,
  launchConfigPath,
  probeEndpoint,
  queryWriters,
  listEntries,
  logPath,
  rebindEntry,
  readEntry,
  readyPath,
  registryDir,
  runDir,
  sessionKey,
  setDetachedPreference,
  socketPath,
  starterRoot,
  writeEntry,
  type RunnerKind,
  type SessionEntry,
} from "./registry.ts";
import { launchWrapper, stopLauncher, stopUnitAndWait, unitBusy, unitNameFor } from "./runner.ts";

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
  /**
   * Idle reap timeout handed to the wrapper (ms; 0 disables). Same value and
   * contract as pi-web's in-process session GC (PI_WEB_IDLE_TIMEOUT_MS): with
   * no client attached and no output for this long, the wrapper stops its
   * agent so a spawn whose host died cannot linger forever.
   */
  idleTimeoutMs?: number;
};

type Handshake = {
  socket: Socket;
  hello: HelloFrame;
  prelude: { frames: Frame[]; bytes: Buffer };
};

/**
 * Locate this installation's pi-web CLI (`bin/pi-web.js`), whose `wrapper`
 * subcommand hosts the detachable agent.
 *
 * The wrapper used to be materialized into `~/.pi/agent/agent-starter/` because
 * the npm package only ships .next/bin/extensions/public. Dev and prod share
 * that HOME directory, so each build overwrote the other's embedded copy — a
 * newer host silently ran an older wrapper (2026-11-23: probes superseded live
 * clients again). Running `pi-web wrapper` from the installation's own bin/
 * makes every build execute exactly its own version, and the CLI file is part
 * of the package (bin/ is published), so no copy is needed at all.
 */
function resolveCliEntry(): string {
  const candidates: string[] = [];
  const pkgDir = process.env.PI_WEB_PKG_DIR?.trim();
  if (pkgDir) candidates.push(join(pkgDir, "bin", "pi-web.js"));
  // Launched through bin/pi-web.js (prod/npm): argv[1] is the CLI itself.
  if (process.argv[1]) candidates.push(join(dirname(process.argv[1]), "pi-web.js"));
  // The service sets WorkingDirectory to the repo; dev's argv[1] is Next's CLI.
  candidates.push(join(process.cwd(), "bin", "pi-web.js"));
  // Bundled server module: walk up from .next/server/... to the package root.
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(join(dir, "bin", "pi-web.js"));
      dir = dirname(dir);
    }
  } catch {
    /* older runners without import.meta: the candidates above still cover it */
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "agent-starter: cannot locate bin/pi-web.js (the `pi-web wrapper` subcommand). "
    + "Set PI_WEB_PKG_DIR to the pi-web package root.",
  );
}

/** Wait for a file to appear, driven by directory events (no polling loop). */
function waitForFile(path: string, dir: string, timeoutMs: number): Promise<boolean> {
  if (existsSync(path)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let watcher: ReturnType<typeof watch> | undefined;
    // Assigned after the watch is established but cleared by finish() above it —
    // const would hit the TDZ when the watch setup throws and finish(false) runs.
    // eslint-disable-next-line prefer-const
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
    // Assigned after the watch is established but cleared by finish() above it —
    // const would hit the TDZ when the watch setup throws and finish(false) runs.
    // eslint-disable-next-line prefer-const
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
    // Identify as a real client: the wrapper only supersedes the previous one
    // for an identified socket, so a liveness probe can never steal the slot
    // (2026-11-23: probes disconnected the live page; its queue_update feed
    // died and the queue panel stayed empty until a reload).
    socket.once("connect", () => {
      try { socket.write(encodeControl({ t: "hello_ack" })); } catch { /* handshake fails loud below */ }
    });
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
      replayBytes: typeof (hello as { journalBytes?: unknown }).journalBytes === "number"
        ? (hello as { journalBytes: number }).journalBytes
        : 0,
      writers: typeof (hello as { writers?: unknown }).writers === "number" ? (hello as { writers: number }).writers : 1,
    },
    prelude,
  );
}

export class LinuxMacWrapperStarter implements WrapperStarter {
  readonly kind = "wrapper" as const;
  readonly runner: RunnerKind;

  private readonly runnerEnv: Record<string, string>;
  private readonly nodePath: string;
  private readonly idleTimeoutMs: number;
  private wrapperArgs: string[] | undefined;

  constructor(options: WrapperStarterOptions) {
    this.runner = options.runner;
    this.runnerEnv = options.runnerEnv;
    this.nodePath = options.nodePath ?? process.execPath;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
  }

  private wrapper(): string[] {
    // `node <cli> wrapper --config <launch.json>`; resolved once per instance
    // (the path is stable for the life of this installation).
    this.wrapperArgs ??= [resolveCliEntry(), "wrapper"];
    return this.wrapperArgs;
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
    // One launch per session key per process: parallel open requests (get_state,
    // get_commands, prompt …) of one cold session each used to reach spawn, and
    // the second systemd-run refused the just-created unit while its failure
    // cleanup unlinked the winner's socket → live wrapper unreachable + unit name
    // occupied (2026-11-23). The loser now waits for the winner and reports the
    // same "already hosted" verdict it would get a moment later.
    const flights = spawnFlights();
    const inflight = flights.get(key);
    if (inflight) {
      await inflight.catch(() => undefined);
      throw new Error(`agent-starter: session ${sessionId} is already hosted by a detached wrapper (launch in flight)`);
    }
    const flight = this.spawnUnshared(command, args, options, key, sessionId, agentKey);
    flights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (flights.get(key) === flight) flights.delete(key);
    }
  }

  private async spawnUnshared(
    command: string,
    args: string[],
    options: AgentStarterSpawnOptions,
    key: string,
    sessionId: string,
    agentKey: string,
  ): Promise<ChildProcess> {
    // Refuse to double-own a live session: the registry entry + live socket is
    // authoritative. Only a definitively dead endpoint may be pruned — a probe
    // timeout is not proof of death (see probeEndpoint).
    const previous = readEntry(key);
    if (previous) {
      if (isLaunching(previous)) {
        // Another instance wrote this entry moments ago and is waiting for its
        // wrapper to bind (the socket does not exist yet). Deleting it would
        // kill that launch's tracking files; refuse instead.
        throw new Error(`agent-starter: session ${sessionId} is already launching a detached wrapper (in flight)`);
      }
      const state = await probeEndpoint(previous.socket);
      if (state === "alive") {
        throw new Error(`agent-starter: session ${sessionId} is already hosted by a detached wrapper (${previous.socket})`);
      }
      if (state === "unknown") {
        throw new Error(
          `agent-starter: a wrapper for session ${sessionId} is registered but did not answer (${previous.socket}); refusing to start a second agent on the same session`,
        );
      }
      // Dead socket, but the transient unit may still be alive with its socket
      // file lost (orphaned wrapper). Starting a duplicate unit is impossible
      // (same name) and unlinking the entry would hide the process → report it.
      const unit = previous.unit ?? (this.runner === "systemd-run" ? unitNameFor(key) : undefined);
      if (unit && (await unitBusy(unit, this.runnerEnv))) {
        throw new Error(
          `agent-starter: session ${sessionId} is still hosted by systemd unit ${unit}, but its socket is gone; ` +
            `stop it first (systemctl --user stop ${unit}) and reopen the session`,
        );
      }
      deleteEntry(key, "stale registry entry (socket definitively dead, no live unit)");
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
        idleTimeoutMs: this.idleTimeoutMs,
      }),
      { mode: 0o600 },
    );
    writeEntry(entry);

    let launched: { launcherPid?: number; unit?: string };
    try {
      launched = await launchWrapper({
        runner: this.runner,
        nodePath: this.nodePath,
        wrapperArgs: this.wrapper(),
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
      this.drop(key, entry.createdAt);
      throw new Error(`agent-starter: wrapper for session ${sessionId} did not become ready within ${READY_TIMEOUT_MS}ms`);
    }

    let handshake: Handshake;
    try {
      handshake = await connectWithHandshake(entry.socket);
    } catch (err) {
      stopLauncher(this.runner, launched.unit, launched.launcherPid, this.runnerEnv);
      this.drop(key, entry.createdAt);
      throw err;
    }

    writeEntry({ ...entry, ...(launched.unit ? { unit: launched.unit } : {}), wrapperPid: handshake.hello.wrapperPid, pid: handshake.hello.pid });
    // A wrapper is the host a session survives pi-web with, so the choice has to
    // outlive the process too: record "last hosted detached" now, or the first idle
    // reap downgrades the next cold open to the local runtime (and every hosting
    // panel reports "next start: in-process" for it). The marker is only read at
    // cold-open time, so a later explicit in-process start clears it as before.
    try {
      setDetachedPreference(sessionId, {
        mode: "subprocess-detached",
        ...(options.owner ? { providerType: options.owner } : {}),
        ...(agentKey ? { agentKey } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch {
      /* the preference is best-effort: never fail a live spawn over it */
    }
    const child = childFrom(handshake, { command, args, sessionId, agentKey, cwd: options.cwd });
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`agent-starter: agent process exited immediately (session ${sessionId})`);
    }
    return child.asChildProcess();
  }

  // --------------------------------------------------------------------------
  // Recovery
  // --------------------------------------------------------------------------

  /** Does a detached wrapper hold this session right now? Prunes definitively dead entries. */
  async holds(sessionId: string): Promise<boolean> {
    const entry = findEntryBySession(sessionId);
    if (!entry) return false;
    // A launch in flight has no socket yet — that is not death.
    if (isLaunching(entry)) return true;
    const state = await probeEndpoint(entry.socket);
    if (state === "alive") return true;
    // A timeout says nothing about liveness (busy wrapper); removing the files
    // would orphan a running agent behind a unit name systemd will not reuse.
    if (state === "unknown") return true;
    deleteEntry(entry.key, "recovery probe: socket definitively dead");
    return false;
  }

  /** Registry entry for a session (undefined = not hosted / already pruned). */
  describe(sessionId: string): SessionEntry | undefined {
    return findEntryBySession(sessionId);
  }

  /** Read-only writer count of the detached wrapper hosting this session (undefined = dead / no answer / legacy). */
  async writers(sessionId: string): Promise<number | undefined> {
    const entry = findEntryBySession(sessionId);
    if (!entry || isLaunching(entry)) return undefined;
    return queryWriters(entry.socket);
  }

  /** Attach to a wrapper-hosted session (journal replay included). */
  async attach(sessionId: string): Promise<ChildProcess> {
    let entry = findEntryBySession(sessionId);
    if (!entry) throw new Error(`agent-starter: no detached wrapper holds session ${sessionId}`);
    // Another instance may be mid-launch (entry written, socket not bound yet):
    // wait for its ready marker instead of probing a path that cannot exist yet.
    if (isLaunching(entry)) {
      await waitForFile(entry.ready, runDir(), READY_TIMEOUT_MS);
      entry = findEntryBySession(sessionId) ?? entry;
    }
    let handshake: Handshake;
    try {
      handshake = await connectWithHandshake(entry.socket);
    } catch (err) {
      // Drop the entry only when the socket is really dead. A transient
      // failure (busy wrapper, backlog, timeout) must not unlink a live
      // wrapper's tracking files — the registry is the only path to reattach
      // or kill the process afterwards.
      if (!isLaunching(entry) && (await probeEndpoint(entry.socket)) === "dead") {
        deleteEntry(entry.key, "attach: socket definitively dead");
      }
      throw err;
    }
    const child = childFrom(handshake, {
      command: "",
      args: [],
      sessionId,
      agentKey: entry.agentKey,
      cwd: entry.cwd,
    });
    // The facade holds the journal replay until its consumer attaches readers
    // (ordered cross-stream delivery), so the prelude cannot have been dispatched
    // behind our back here. Death-at-handshake is visible in the prelude itself.
    const sawTerminal = handshake.prelude.frames.some(
      (frame) => frame.channel === CH_CTRL && decodeControl(frame.payload)?.t === "exit",
    );
    if (sawTerminal) {
      child.release();
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
    // Windows: a signal terminates the wrapper process outright (Node cannot run a
    // SIGTERM handler there), which would orphan the agent in the same process tree.
    // The control frame is the portable way to stop it, so use that there.
    const useFrame = process.platform === "win32";
    if (!useFrame && typeof entry.wrapperPid === "number" && entry.wrapperPid > 0) {
      try {
        process.kill(entry.wrapperPid, signal as NodeJS.Signals);
        signalled = true;
      } catch {
        signalled = false;
      }
    }
    if (signalled) {
      const gone = await waitForFileGone(entry.socket, runDir(), 8000);
      if (gone) {
        deleteEntry(entry.key, "kill: wrapper removed its socket");
        if (entry.runner === "systemd-run" && entry.unit) await stopUnitAndWait(entry.unit, this.runnerEnv);
        return true;
      }
      // Hard signal (SIGKILL): the wrapper died without cleanup, leaving a
      // stale socket file. Nothing listens behind it — clear the leftovers.
      if ((await probeEndpoint(entry.socket)) === "dead") {
        deleteEntry(entry.key, "kill: socket definitively dead after signal");
        if (entry.runner === "systemd-run" && entry.unit) await stopUnitAndWait(entry.unit, this.runnerEnv);
        return true;
      }
      // The wrapper is still shutting the agent down (orderly shutdown of a
      // mid-turn run can exceed the wait). Deleting the entry now would orphan
      // a LIVE wrapper outside every registry — reattach and any later kill
      // both route through it (the 2026-11-19 zombie incident: four
      // wrapper+agent pairs nobody could reach or stop). Keep the entry and
      // report not-stopped; the wrapper removes its own files on exit.
      return false;
    }
    if (await isSocketAlive(entry.socket)) {
      await this.sendKillFrame(entry.socket, signal);
      const gone = await waitForFileGone(entry.socket, runDir(), 8000);
      if (!gone) {
        if ((await probeEndpoint(entry.socket)) === "dead") {
          deleteEntry(entry.key, "kill(frame): socket definitively dead");
          if (entry.runner === "systemd-run" && entry.unit) await stopUnitAndWait(entry.unit, this.runnerEnv);
          return true;
        }
        return false;
      }
    }
    // Socket dead: the wrapper exited (or was never there) — clear the leftovers.
    deleteEntry(entry.key, "kill: wrapper endpoint gone");
    if (entry.runner === "systemd-run" && entry.unit) await stopUnitAndWait(entry.unit, this.runnerEnv);
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

  /**
   * Follow a backend that learns its native session id after start (omp,
   * codebuddy …): the entry keeps its socket/log and just adopts the new id, so
   * a later reattach by the native id finds the same live process.
   */
  rebind(oldSessionId: string, newSessionId: string): boolean {
    return rebindEntry(oldSessionId, newSessionId);
  }

  private drop(key: string, createdAt?: number): void {
    // Only remove tracking files this call actually wrote. Two launches for the
    // same key (another pi-web instance, or an in-flight spawn) each write their
    // own entry; a loser that cleaned up blindly would unlink the winner's live
    // socket and leave its wrapper unreachable (2026-11-23 orphan incident).
    const current = readEntry(key);
    if (current && createdAt !== undefined && current.createdAt !== createdAt) return;
    deleteEntry(key, "spawn failed before the wrapper became ready");
    try {
      unlinkSync(launchConfigPath(key));
    } catch {
      /* already consumed */
    }
  }
}

/** Per-key in-flight spawns (globalThis: survives dev HMR module recreation). */
declare global {
  var __agentStarterSpawnFlights: Map<string, Promise<ChildProcess>> | undefined;
}

function spawnFlights(): Map<string, Promise<ChildProcess>> {
  if (!globalThis.__agentStarterSpawnFlights) globalThis.__agentStarterSpawnFlights = new Map();
  return globalThis.__agentStarterSpawnFlights;
}
