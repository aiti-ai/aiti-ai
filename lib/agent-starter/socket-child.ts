/**
 * SocketChild — adapts a wrapper socket to the ChildProcess surface.
 *
 * Every adopting agent backend already has a working "drive a child process"
 * implementation (read stdout lines, write stdin lines, watch exit). This class
 * keeps that code untouched by presenting the same shape over the framing
 * socket: pure stdout/stderr streams, an exit event with the real code/signal,
 * exitCode/signalCode/pid/killed, and kill(signal) (forwarded as a control
 * frame so the wrapper kills the agent it owns, not us).
 *
 * Two extra members exist for detachable children:
 *   detachable = true      providers branch on the property, not on a class
 *                          identity (module copies differ under dev HMR)
 *   release()              disconnect without killing the agent — dispose()
 *                          semantics for a wrapper-hosted session
 */

import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { PassThrough, Writable } from "node:stream";
import {
  CH_CTRL,
  CH_PEER_STDIN,
  CH_STDERR,
  CH_STDOUT,
  CH_STDIN,
  FrameParser,
  decodeControl,
  encodeControl,
  encodeFrame,
  type Frame,
} from "./wire.ts";

/**
 * Event emitted once the replayed history has been dispatched: everything before
 * it came from the wrapper's journal, everything after it is live. Handles that
 * keep a protocol state machine (ACP JSON-RPC) use it to treat replayed frames as
 * history instead of new input.
 */
export const REPLAY_END_EVENT = "replay_end";

/**
 * How long the facade waits for the consumers to attach their stdout+peerStdin
 * readers before dispatching the journal replay anyway (legacy handles never
 * read peerStdin; the replay then rides the grace like it rode setImmediate).
 */
const PRELUDE_GRACE_MS = 3_000;

export type SocketChildOptions = {
  /** Agent process pid reported by the wrapper's hello frame. */
  pid: number;
  wrapperPid: number;
  sessionId?: string;
  agentKey?: string;
  spawnfile?: string;
  spawnargs?: string[];
  /**
   * Journal bytes replayed at handshake (hello.journalBytes; stdout+stderr
   * combined). Protocol-bridging backends (NDJSON RPC) use it as a byte-exact
   * budget: every stdout/stderr byte up to this count is history — count what
   * `data` delivers and gate live processing once the budget is consumed.
   * Unlike REPLAY_END_EVENT this is not timing-sensitive: the event fires
   * before the replayed chunks are delivered through the PassThrough, while
   * the budget travels with the bytes themselves.
   */
  replayBytes?: number;
  /** Writers already attached at handshake (hello.writers; absent/1 = just us). */
  writers?: number;
};

/**
 * Frames that arrived together with the handshake (journal replay, or the
 * terminal outcome when the agent was already gone). Dispatched on the next
 * tick so the caller can attach listeners first.
 */
export type SocketChildPrelude = { frames: Frame[]; bytes?: Buffer };

export class SocketChild extends EventEmitter {
  /** Marker: this child is hosted by a wrapper; killing it is a deliberate act. */
  readonly detachable = true;

  readonly pid: number;
  readonly wrapperPid: number;
  readonly sessionId?: string;
  readonly agentKey?: string;
  readonly spawnfile: string;
  readonly spawnargs: string[];
  /** Journal bytes that were replayed at handshake (0 = fresh spawn / no wrapper). */
  readonly replayBytes: number;
  /** Writers already attached at handshake (hello.writers; 1 = just us). */
  readonly writers: number;

  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  /**
   * Stdin traffic this handle did not originate in this incarnation: live ch4
   * frames (another writer's stdin, mirrored by the wrapper) and replayed ch0
   * frames (the journal's stdin history — every past user prompt). Session
   * backends that parse it can materialize peer prompts into their history;
   * consumers that ignore it are unaffected (the wrapper only forwards there).
   */
  readonly peerStdin: PassThrough;
  /** In upstream Node, `stdout`/`stderr` may be null for non-pipe stdio — wrapper children always have pipes. */
  readonly stdio: Array<Writable | PassThrough | null>;

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  private readonly socket: Socket;
  private readonly parser = new FrameParser;
  private closed = false;
  private released = false;
  /**
   * Journal replay is dispatched only once the consumers attached their readers:
   * replayed stdout lines and replayed peer-stdin lines must interleave in wire
   * order, and cross-stream ordering holds only when BOTH PassThroughs are in
   * flowing mode before the first prelude write. Consumers attach their readers
   * right after construction (wireChild), possibly across several microtasks —
   * so dispatch waits for the second reader and a grace bounds the wait for
   * consumers that never read peerStdin (legacy handles).
   */
  private preludePending = true;
  private preludeDispatched = false;
  private preludeGrace: ReturnType<typeof setTimeout> | undefined;
  private pendingLive: Buffer[] = [];

  constructor(socket: Socket, options: SocketChildOptions, prelude?: SocketChildPrelude) {
    super();
    this.socket = socket;
    this.pid = options.pid;
    this.wrapperPid = options.wrapperPid;
    this.sessionId = options.sessionId;
    this.agentKey = options.agentKey;
    this.spawnfile = options.spawnfile ?? "";
    this.spawnargs = options.spawnargs ?? [];
    this.replayBytes = options.replayBytes ?? 0;
    this.writers = options.writers ?? 1;

    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.peerStdin = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => this.writeStdin(chunk as Buffer, callback),
      final: (callback) => {
        this.socket.write(encodeFrame(CH_STDIN, Buffer.alloc(0)));
        callback();
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr];

    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (err: Error) => this.onSocketError(err));
    socket.on("close", () => this.onSocketClose());

    this.armPrelude(prelude);
  }

  /**
   * Hold the journal replay until the consumer attached its stdout reader:
   * replayed stdout lines and replayed peer-stdin lines must interleave in wire
   * order, and cross-stream ordering holds only when BOTH PassThroughs are in
   * flowing mode before the first prelude write. Handles that also read
   * peerStdin attach that reader BEFORE the stdout reader (wireChild), so the
   * dispatch triggered by the stdout listener sees both streams flowing. A
   * consumer that never reads peerStdin (legacy) is not penalized: the gate is
   * stdout-only, and a grace bounds the wait for consumers that attach nothing.
   */
  private armPrelude(prelude?: SocketChildPrelude): void {
    const hasPrelude = (prelude?.frames?.length ?? 0) > 0 || (prelude?.bytes?.length ?? 0) > 0;
    if (!hasPrelude) {
      // Nothing to replay: deliver the (possibly empty) boundary immediately.
      setImmediate(() => this.runDispatch(prelude));
      return;
    }
    this.preludeGrace = setTimeout(() => {
      this.preludeGrace = undefined;
      this.runDispatch(prelude);
    }, PRELUDE_GRACE_MS);
    this.preludeGrace.unref?.();
    this.stdout.once("newListener", (event: string) => {
      if (event !== "data") return;
      // The listener is being added right now; the microtask runs once it is in
      // place (wireChild attaches the peerStdin reader synchronously before it,
      // so both streams are flowing when the prelude writes happen).
      queueMicrotask(() => this.runDispatch(prelude));
    });
  }

  private runDispatch(prelude?: SocketChildPrelude): void {
    if (this.preludeDispatched || this.closed) return;
    this.preludeDispatched = true;
    if (this.preludeGrace) {
      clearTimeout(this.preludeGrace);
      this.preludeGrace = undefined;
    }
    this.stdout.removeAllListeners("newListener");
    const frames = prelude?.frames ?? [];
    if (prelude?.bytes && prelude.bytes.length > 0) this.#dispatchReplayBytes(prelude.bytes);
    for (const frame of frames) {
      if (this.closed) break;
      this.dispatchFrame(frame);
    }
    this.preludePending = false;
    if (this.closed) return;
    const buffered = this.pendingLive;
    this.pendingLive = [];
    for (const chunk of buffered) {
      if (this.closed) break;
      this.onData(chunk);
    }
    if (!this.closed) this.emit(REPLAY_END_EVENT, frames.length);
  }

  /** Convenience cast for code typed against node's ChildProcess. */
  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }

  /**
   * Disconnect without touching the agent (dispose semantics for a wrapper
   * hosted session). Idempotent; emits "close" like a real child would, but
   * never "exit" — the process is still alive out there.
   */
  release(): void {
    if (this.released || this.closed) return;
    this.released = true;
    this.closed = true;
    this.destroyStreams();
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.emit("close", this.exitCode, this.signalCode);
  }

  kill(signal?: string | number): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    try {
      this.socket.write(encodeControl({ t: "kill", signal: typeof signal === "string" ? signal : "SIGTERM" }));
      return true;
    } catch {
      return false;
    }
  }

  /** No IPC channel exists over the facade socket (documented degradation). */
  disconnect(): void {
    this.release();
  }

  send?: undefined;

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  // ---- internals ---------------------------------------------------------

  private writeStdin(chunk: Buffer, callback: (error?: Error | null) => void): void {
    if (this.closed || this.exitCode !== null) {
      callback();
      return;
    }
    try {
      const frame = encodeFrame(CH_STDIN, chunk);
      if (this.socket.write(frame)) callback();
      else this.socket.once("drain", () => callback());
    } catch (err) {
      callback(err as Error);
    }
  }

  /** Parse dispatched replay bytes (they may complete frames across chunks). */
  #dispatchReplayBytes(bytes: Buffer): void {
    let frames;
    try {
      frames = this.parser.push(bytes);
    } catch (err) {
      this.onSocketError(err as Error);
      return;
    }
    for (const frame of frames) {
      if (this.closed) break;
      this.dispatchFrame(frame);
    }
  }

  private onData(chunk: Buffer): void {
    if (this.preludePending) {
      // Keep the wire order (replay first, then live) until the boundary is crossed.
      this.pendingLive.push(chunk);
      return;
    }
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.onSocketError(err as Error);
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (this.closed) break;
      this.dispatchFrame(frame);
    }
  }

  private dispatchFrame(frame: Frame): void {
    if (frame.channel === CH_STDOUT) {
      this.stdout.write(frame.payload);
      return;
    }
    if (frame.channel === CH_STDERR) {
      this.stderr.write(frame.payload);
      return;
    }
    if (frame.channel === CH_PEER_STDIN) {
      // Another writer's stdin, mirrored live by the wrapper.
      this.peerStdin.write(frame.payload);
      return;
    }
    if (frame.channel === CH_STDIN) {
      // Stdin frames arriving FROM the wrapper are journal history (the
      // wrapper never echoes live stdin): every past user prompt, including
      // this handle's own past-life writes after a host restart.
      this.peerStdin.write(frame.payload);
      return;
    }
    if (frame.channel !== CH_CTRL) return;
    const control = decodeControl(frame.payload);
    if (!control) return;
    if (control.t === "exit") {
      this.finalize(control.code, control.signal);
    } else if (control.t === "superseded") {
      // Legacy single-writer wrapper: another host took the session over.
      this.finalize(this.exitCode, this.signalCode, "superseded");
    } else if (control.t === "peers") {
      this.emit("peers", control.count);
    }
  }

  private onSocketError(err: Error): void {
    if (this.closed) return;
    this.emit("error", err);
    this.finalize(this.exitCode, this.signalCode, err.message);
  }

  private onSocketClose(): void {
    if (this.closed) return;
    // Socket dropped without an exit frame: the wrapper died (crash) or the
    // process group was killed. Surface it as a child exit so existing
    // "process is gone" handling runs unchanged.
    this.finalize(this.exitCode, this.signalCode, "socket closed");
  }

  private finalize(code: number | null, signal: string | null, reason?: string): void {
    // Reentrancy-safe: runDispatch may deliver a terminal exit frame (from the
    // replay or buffered live bytes) that calls back into finalize.
    if (this.closed) return;
    this.closed = true;
    this.exitCode = typeof code === "number" ? code : null;
    this.signalCode = (signal as NodeJS.Signals | null) ?? null;
    if (reason) this.emit("dropped", reason);
    this.destroyStreams();
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.emit("exit", this.exitCode, this.signalCode);
    this.emit("close", this.exitCode, this.signalCode);
  }

  private destroyStreams(): void {
    for (const stream of [this.stdout, this.stderr, this.peerStdin, this.stdin]) {
      try {
        stream.end();
      } catch {
        /* already ended */
      }
      try {
        stream.destroy();
      } catch {
        /* already destroyed */
      }
    }
  }
}

/** True when a child came from the wrapper (property, not identity: dev HMR copies). */
export function isDetachableChild(child: unknown): child is SocketChild {
  const candidate = child as { detachable?: unknown; release?: unknown } | null | undefined;
  return Boolean(candidate && candidate.detachable === true && typeof candidate.release === "function");
}
