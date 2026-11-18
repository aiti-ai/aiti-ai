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
  CH_STDERR,
  CH_STDOUT,
  CH_STDIN,
  FrameParser,
  decodeControl,
  encodeControl,
  encodeFrame,
  type Frame,
} from "./wire.ts";

export type SocketChildOptions = {
  /** Agent process pid reported by the wrapper's hello frame. */
  pid: number;
  wrapperPid: number;
  sessionId?: string;
  agentKey?: string;
  spawnfile?: string;
  spawnargs?: string[];
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

  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  /** In upstream Node, `stdout`/`stderr` may be null for non-pipe stdio — wrapper children always have pipes. */
  readonly stdio: Array<Writable | PassThrough | null>;

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  private readonly socket: Socket;
  private readonly parser = new FrameParser();
  private closed = false;
  private released = false;

  constructor(socket: Socket, options: SocketChildOptions, prelude?: SocketChildPrelude) {
    super();
    this.socket = socket;
    this.pid = options.pid;
    this.wrapperPid = options.wrapperPid;
    this.sessionId = options.sessionId;
    this.agentKey = options.agentKey;
    this.spawnfile = options.spawnfile ?? "";
    this.spawnargs = options.spawnargs ?? [];

    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
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

    if (prelude && (prelude.frames.length > 0 || prelude.bytes)) {
      process.nextTick(() => {
        if (this.closed) return;
        if (prelude.bytes && prelude.bytes.length > 0) this.onData(prelude.bytes);
        for (const frame of prelude.frames) {
          if (this.closed) break;
          this.dispatchFrame(frame);
        }
      });
    }
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

  private onData(chunk: Buffer): void {
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
    if (frame.channel !== CH_CTRL) return;
    const control = decodeControl(frame.payload);
    if (!control) return;
    if (control.t === "exit") {
      this.finalize(control.code, control.signal);
    } else if (control.t === "superseded") {
      // Another pi-web instance took this session over (single writer).
      this.finalize(this.exitCode, this.signalCode, "superseded");
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
    for (const stream of [this.stdout, this.stderr, this.stdin]) {
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
