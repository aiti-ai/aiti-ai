/**
 * qoder-acp.ts — ACP (Agent Client Protocol) JSON-RPC over stdio wiring for the qoder CLI.
 *
 * qoderclicn 1.1.81+ removed the stream-json SDK-worker inbound control channel
 * (`sdk_worker_removed`; "roll back the CLI to 1.1.80 or earlier" is the vendor's own
 * guidance), so the driver speaks ACP instead: spawn `qoderclicn --acp`, initialize,
 * session/new | session/load, session/prompt + session/update notifications,
 * session/cancel to abort (acks sub-second, 2026-11-13 probe).
 *
 * Wire: newline-delimited JSON-RPC 2.0. Requests FROM the agent
 * (session/request_permission, fs/read_text_file, fs/write_text_file) are dispatched to
 * `handlers.onRequest`; its return value becomes the response result (a thrown error
 * becomes a JSON-RPC error response).
 */
import type { ChildProcess } from "node:child_process";

export interface AcpRpcHandlers {
  /** Agent→client request handler. May be async; throw to answer with a JSON-RPC error.
   *  rawId = the JSON-RPC request id (needed for async responses like permissions). */
  onRequest(method: string, params: unknown, rawId: number): Promise<unknown> | unknown;
  /** Notification listener (session/update, session/current_mode_update, ...). */
  onNotification?(method: string, params: unknown): void;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class AcpRpc {
  private buf = "";
  private nextId = 0;
  private readonly pending = new Map<number, PendingEntry>();
  private dead = false;
  private detach: (() => void) | null = null;
  private readonly child: ChildProcess;
  private readonly handlers: AcpRpcHandlers;
  private readonly log: (m: string) => void;

  constructor(child: ChildProcess, handlers: AcpRpcHandlers, log: (m: string) => void = () => {}) {
    this.child = child;
    this.handlers = handlers;
    this.log = log;
    const stdout = child.stdout;
    if (stdout) {
      const onData = (c: Buffer | string) => {
        this.buf += String(c);
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (line) this.handleLine(line);
        }
      };
      stdout.on("data", onData);
      const onError = (err: Error) => this.log(`stdout error: ${err.message}`);
      stdout.on("error", onError);
      this.detach = () => {
        stdout.off("data", onData);
        stdout.off("error", onError);
      };
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === "string" ? msg.method : undefined;

    if (method === undefined) {
      // response to one of our requests
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const err = msg.error as { code?: unknown; message?: unknown };
        entry.reject(new Error(`[acp] ${String(err.message ?? "error")}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (hasId) {
      // agent→client request: must be answered
      const id = Number(msg.id);
      Promise.resolve()
        .then(() => this.handlers.onRequest(method, msg.params, id))
        .then((result) => {
          this.writeRaw({ jsonrpc: "2.0", id, result: result ?? {} });
        })
        .catch((e: unknown) => {
          this.writeRaw({
            jsonrpc: "2.0", id,
            error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
          });
        });
      return;
    }

    // notification
    try {
      this.handlers.onNotification?.(method, msg.params);
    } catch (e) {
      this.log(`notification handler error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Write a request and await its response. Rejects on error response / timeout / dead pipe. */
  request(method: string, params: unknown, timeoutMs = 150_000): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error("[acp] transport closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject, timer: undefined };
      entry.timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`[acp] ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      entry.timer.unref?.();
      this.pending.set(id, entry);
      const wrote = this.writeRaw({ jsonrpc: "2.0", id, method, params });
      if (!wrote && this.pending.has(id)) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(new Error("[acp] stdin closed"));
      }
    });
  }

  /** Fire-and-forget notification (session/cancel, initialized, ...). */
  notify(method: string, params: unknown): boolean {
    return this.writeRaw({ jsonrpc: "2.0", method, params });
  }

  private writeRaw(payload: Record<string, unknown>): boolean {
    const stdin = this.child.stdin;
    if (!stdin?.writable || this.dead) return false;
    try {
      stdin.write(JSON.stringify(payload) + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /** Stop reading; reject all in-flight requests. Idempotent. */
  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.detach?.();
    this.detach = null;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("[acp] transport closed"));
    }
    this.pending.clear();
  }

  get closed(): boolean {
    return this.dead;
  }
}
