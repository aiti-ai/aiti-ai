/**
 * wire.ts — JSONL RPC wire-protocol host (carrier-agnostic).
 *
 * Split out of aiti-pi-agent's pi-rpc-spawn.ts: child-process management / request-response id
 * correlation / event fanout / death reporting + the extension_ui_request <-> interaction_request
 * frame bridge.
 * This layer contains **no fork semantics** (command mapping / capability surface / lifecycle
 * closeout are each extension's handle's responsibility).
 */

import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** Default per-line byte cap (same 10MB as the MCP stdio transport): an overlong line without a newline is treated as a runaway child process. */
export const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;

/** Default control-plane command timeout (fast commands like get_state/set_model/...; long-turn commands like prompt/compact/bash set none). */
export const RPC_CTRL_TIMEOUT_MS = 30_000;

export interface LineReaderOptions {
  /** Per-line byte cap (accumulated before the newline); exceeding it triggers onOverflow and stops processing further data. Default 10MB. */
  maxLineBytes?: number;
  /** Line-overflow callback (the host should markDead — the protocol stream is no longer trustworthy). */
  onOverflow?: (size: number) => void;
}

/**
 * Read a stdout stream line by line (JSONL); returns a cancel function.
 * Bytes accumulate and are sliced per `\n` into Buffers, each decoded as whole-line utf8 (same as
 * the MCP ReadBuffer) — per-chunk `Buffer.toString` would decode multi-byte characters spanning
 * chunks into U+FFFD (CJK text always trips this).
 */
export function lineReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  opts?: LineReaderOptions,
): () => void {
  const maxLineBytes = opts?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const onOverflow = opts?.onOverflow;
  let buf: Buffer = Buffer.alloc(0);
  let overflowed = false;
  const onData = (c: Buffer | string) => {
    if (overflowed) return;
    const chunk = typeof c === "string" ? Buffer.from(c, "utf8") : c;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    let idx: number;
    while ((idx = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, idx).toString("utf8").trim();
      buf = buf.subarray(idx + 1);
      if (line) onLine(line);
    }
    if (buf.length > maxLineBytes) {
      overflowed = true;
      onOverflow?.(buf.length);
    }
  };
  stream.on("data", onData);
  return () => {
    stream.off("data", onData);
  };
}

export type HostEventListener = (event: Record<string, unknown>) => void;

/** Frame-level trace (request/response correlation, disposition included) — lost-message
 *  forensics (2026-11-22 steer-loss). Default: on outside production builds; force with
 *  PI_FORK_RPC_DEBUG=1, force off with =0. One line per frame, never logs message text. */
function traceWire(line: string): void {
  const flag = process.env.PI_FORK_RPC_DEBUG;
  const enabled = flag === "1" || flag === "true"
    ? true
    : flag === "0" || flag === "false"
      ? false
      : process.env.NODE_ENV !== "production";
  if (enabled) console.log(`[fork-rpc-wire] ${line}`);
}

interface PendingRequest {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer?: NodeJS.Timeout;
}

/**
 * Carrier-agnostic RPC child-process host:
 *   - process management (stdin frame writes / stdout line reading / stderr logging / exit-error cleanup)
 *   - request id correlation (commands carry an `id`; `response` frames call back by id; control-plane commands can carry a timeout)
 *   - event fanout (non-response frames -> onFrame dispatch to subclasses -> emit to listeners; per-listener exception isolation)
 *   - death reporting (session_backend_dead)
 *
 * Subclasses inject semantics by overriding onFrame (extension_ui / host_tool / ready handshake /
 * state frames...), and send commands via the protected request / writeRaw.
 */
export class RpcChildHost {
  protected child: ChildProcess;
  protected pending = new Map<string, PendingRequest>();
  protected seq = 0;
  /** Per-instance id salt: an attach replays the wrapper journal into this wire —
   *  the OLD handle's responses ("r1", "r2", …) would collide with this wire's
   *  fresh ids and resolve pending requests with stale acks (2026-11-22
   *  steer-loss forensics: replayed and live frames interleaved in the same
   *  millisecond window). The salt makes replayed ids unmatchable. */
  private seqSalt = Math.floor(Math.random() * 0xffffffff).toString(36);
  protected aliveFlag = true;
  private listeners = new Set<HostEventListener>();
  private detachReader: (() => void) | null = null;

  constructor(child: ChildProcess, opts?: { maxLineBytes?: number }) {
    this.child = child;
    this.detachReader = lineReader(child.stdout!, (line) => this.dispatchLine(line), {
      ...(opts?.maxLineBytes ? { maxLineBytes: opts.maxLineBytes } : {}),
      onOverflow: (size) => this.markDead(`stdout line overflow (${size} bytes > ${opts?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES})`),
    });
    const stderrDecoder = new StringDecoder("utf8");
    child.stderr?.on("data", (c: Buffer | string) => {
      const text = (typeof c === "string" ? c : stderrDecoder.write(c)).trim();
      if (text) console.log(`[rpc-child] ${text.slice(0, 500)}`);
    });
    // All three streams must carry error listeners: when the child is killed / a pipe breaks, the
    // stream raises ECONNRESET/EPIPE; with no listener = unhandled 'error' event = host process
    // crash (same defense as the MCP stdio transport).
    child.stdout?.on("error", (err: Error) => this.markDead(`stdout error: ${err.message}`));
    child.stderr?.on("error", (err: Error) => console.log(`[rpc-child] stderr error: ${err.message}`));
    child.stdin?.on("error", (err: Error) => console.log(`[rpc-child] stdin error: ${err.message}`));
    // Wrapper facades (SocketChild) report the real cause on "dropped" before the
    // synthetic exit — "superseded" (single-writer slot taken by a newer client),
    // "socket closed", or the socket error message. Listen first so markDead carries
    // a diagnosable reason instead of the generic "process exited (signal)"
    // (markDead is idempotent; the later exit event is a no-op).
    (child as unknown as { once: (ev: string, cb: (reason: unknown) => void) => unknown }).once("dropped", (reason) => {
      if (typeof reason === "string" && reason) this.markDead(reason);
    });
    child.once("exit", (code) => this.markDead(`process exited (${code ?? "signal"})`));
    child.once("error", (err) => this.markDead(`process error: ${err.message}`));
  }

  emit(event: Record<string, unknown>): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (e) {
        // Per-listener isolation: one subscriber throwing must not drop frames for the others,
        // let alone crash the process via a raw throw along the stream data callback
        console.error(`[rpc-child] listener error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  subscribe(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Send a command with id correlation attached (writes stdin; the frame's id is appended by this method — don't pass one).
   *  opts.timeoutMs: optional timeout (for fast control-plane commands; long-turn commands like
   *  prompt/compact/bash set none — the timeout only clears the pending entry and rejects; the
   *  child keeps running regardless). */
  protected request<T = unknown>(command: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T> {
    if (!this.aliveFlag || !this.child.stdin?.writable) {
      return Promise.reject(new Error("[rpc-child] not running"));
    }
    const id = `r${this.seqSalt}-${++this.seq}`;
    traceWire(`→ #${id} ${String(command.type ?? "?")}${command.streamingBehavior ? `:${String(command.streamingBehavior)}` : ""}`);
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { resolve: resolve as (v: unknown) => void, reject };
      const timeoutMs = opts?.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          traceWire(`⏱ #${id} ${String(command.type ?? "?")} timeout after ${timeoutMs}ms`);
          reject(new Error(`[rpc-child] timeout: ${String(command.type ?? "?")} after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
        pending.timer = timer;
      }
      this.pending.set(id, pending);
      try {
        this.child.stdin!.write(JSON.stringify({ ...command, id }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        traceWire(`✗ #${id} ${String(command.type ?? "?")} stdin write failed`);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error(`[rpc-child] write failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  /** Write a frame as-is (no request id appended) — host_tool_result etc. must echo the request frame's id. */
  protected writeRaw(frame: Record<string, unknown>): void {
    if (!this.aliveFlag || !this.child.stdin?.writable) return;
    try {
      this.child.stdin.write(JSON.stringify(frame) + "\n");
    } catch {
      // Write failed (the child just died): the exit event will reap it via markDead
    }
  }

  /** Line dispatch: response calls back by id; the rest go to the subclass's onFrame. */
  protected dispatchLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "response" && typeof msg.id === "string") {
      const p = this.pending.get(msg.id);
      if (!p) {
        // Replayed-journal response with no live pending (attach replay) — trace
        // at debug level so lost-message forensics can tell replay apart from live.
        traceWire(`← #${msg.id} response (no pending: replay or stale)`);
        return;
      }
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      const data = msg.data as Record<string, unknown> | undefined;
      traceWire(`← #${msg.id} ${String(msg.command ?? "?")} ok=${msg.success === true}${data && typeof data === "object" && "disposition" in data ? ` disposition=${String((data as { disposition?: unknown }).disposition)}` : ""}`);
      if (msg.success === true) p.resolve(msg.data);
      else p.reject(new Error(String(msg.error ?? "request failed")));
      return;
    }
    try {
      this.onFrame(msg);
    } catch (e) {
      // A subclass onFrame exception likewise must not raw-throw along the stream data callback
      // (emit already isolates; this catches the subclass's own logic)
      console.error(`[rpc-child] onFrame error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Subclass override: semantic dispatch for non-response frames (default passes through to emit). */
  protected onFrame(_msg: Record<string, unknown>): void {
    this.emit(_msg);
  }

  protected markDead(reason: string): void {
    if (!this.aliveFlag) return;
    this.aliveFlag = false;
    this.detachReader?.();
    this.detachReader = null;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`[rpc-child] dead: ${reason}`));
    }
    this.pending.clear();
    this.emit({ type: "session_backend_dead", reason });
  }
}

// ============================================================================
// Child-process closeout (shared by dispose)
// ============================================================================

/** Child-process closeout: SIGTERM -> graceMs (default 1s) -> SIGKILL -> destroy the three streams
 *  (releases handles/event loop; same ladder + cleanup as the MCP stdio transport). A dead process
 *  skips the signals and only clears the streams. Idempotent and reentrant. */
export async function shutdownChild(child: ChildProcess, graceMs = 1_000): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGTERM"); } catch { /* already dead, tolerated */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead, tolerated */ }
        resolve();
      }, graceMs);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
}

// ============================================================================
// extension_ui_request <-> interaction_request bridge (generic frame conversion, no fork semantics)
// ============================================================================

/** fork child-process extension_ui_request frame (select/confirm/input/editor/notify/...). */
export interface ExtensionUIRequest extends Record<string, unknown> {
  type: "extension_ui_request";
  id: string;
  method: string;
}

/** UI methods that need a user answer and a pending wait (the rest are one-way notifications, pass through). */
export const UI_METHODS_NEEDING_ANSWER = new Set(["select", "confirm", "input", "editor"]);

/**
 * Project an extension_ui_request into the pi-web unified interaction_request event
 * (lib/session/types.ts InteractionRequestEvent).
 *   select/confirm -> kind "ask_user" with real options;
 *   input/editor -> kind "ask_user" with an EMPTY options list (free-text answer);
 *   open_url -> kind "open_url" (OAuth login card: url/launchUrl fields, one-way, no answer needed);
 *   the rest (editor/notify/setStatus/...) -> kind "generic" (the raw frame goes into input).
 */
export function toInteractionRequest(req: ExtensionUIRequest): Record<string, unknown> {
  const method = req.method;
  if (method === "open_url") {
    // The fork's real frame: {url, launchUrl, instructions} (instructions = the operation guide for the user)
    const promptText = [req.title, req.instructions].find((s) => typeof s === "string");
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "open_url",
      toolName: "extension_ui.open_url",
      ...(promptText ? { prompt: promptText } : {}),
      ...(typeof req.url === "string" ? { url: req.url } : {}),
      ...(typeof req.launchUrl === "string" ? { launchUrl: req.launchUrl } : {}),
      input: req,
    };
  }
  if (method === "select") {
    const options = Array.isArray(req.options) ? req.options : [];
    const details = Array.isArray(req.optionDetails) ? req.optionDetails : [];
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "ask_user",
      toolName: "extension_ui.select",
      prompt: typeof req.title === "string" ? req.title : undefined,
      questions: [
        {
          question: typeof req.title === "string" ? req.title : "Select an option",
          options: options.map((o, i) => ({
            label: String(o),
            ...(typeof (details[i] as { description?: unknown })?.description === "string"
              ? { description: (details[i] as { description: string }).description }
              : {}),
          })),
        },
      ],
      input: req,
    };
  }
  if (method === "confirm") {
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "ask_user",
      toolName: "extension_ui.confirm",
      prompt: typeof req.title === "string" ? req.title : undefined,
      questions: [
        {
          question: [req.title, req.message].filter((s) => typeof s === "string").join("\n") || "Confirm?",
          options: [{ label: "Confirm" }, { label: "Cancel" }],
        },
      ],
      input: req,
    };
  }
  if (method === "input" || method === "editor") {
    // Free-text answer: `options` is required by the session-request contract, so a text
    // question carries an EMPTY list instead of omitting it. An omitted field made the cards
    // throw on options.map and left the request unanswerable (no way to type the value).
    // The card renders a text field ("input": single line, "editor": textarea + prefill) and
    // sends the typed text back as answers[question]; toExtensionUIResponse reads it there.
    const label =
      typeof req.title === "string" && req.title
        ? req.title
        : method === "input" ? "Input" : "Editor";
    return {
      type: "interaction_request",
      requestId: req.id,
      kind: "ask_user",
      toolName: `extension_ui.${method}`,
      prompt: typeof req.title === "string" ? req.title : undefined,
      questions: [{ question: label, options: [] }],
      input: req,
    };
  }
  return {
    type: "interaction_request",
    requestId: req.id,
    kind: "generic",
    toolName: `extension_ui.${method}`,
    input: req,
  };
}

/**
 * Encode a user answer (InteractionAnswer) back into an extension_ui_response frame
 * (omp RpcExtensionUIResponse: {value} | {confirmed} | {cancelled:true}).
 * Returns null when the request needs no answer (one-way notification class).
 */
export function toExtensionUIResponse(
  req: ExtensionUIRequest,
  answer: { action: "accept" | "decline"; answers?: Record<string, string | string[]>; message?: string },
): Record<string, unknown> | null {
  const method = req.method;
  if (method === "select") {
    if (answer.action === "decline") return { type: "extension_ui_response", id: req.id, cancelled: true };
    const q = typeof req.title === "string" ? req.title : "Select an option";
    const v = answer.answers?.[q];
    return v === undefined
      ? { type: "extension_ui_response", id: req.id, cancelled: true }
      : { type: "extension_ui_response", id: req.id, value: Array.isArray(v) ? v[0] : v };
  }
  if (method === "input" || method === "editor") {
    if (answer.action === "decline") return { type: "extension_ui_response", id: req.id, cancelled: true };
    const q = typeof req.title === "string" ? req.title : method === "input" ? "Input" : "";
    const v = answer.answers?.[q];
    const value = (Array.isArray(v) ? v[0] : v) ?? answer.message ?? "";
    return { type: "extension_ui_response", id: req.id, value };
  }
  if (method === "confirm") {
    if (answer.action === "decline") return { type: "extension_ui_response", id: req.id, cancelled: true };
    // The confirm/cancel rendered by the select card: judged by the picked label; accept + not
    // picking "Cancel" = confirmed
    const q = [req.title, req.message].filter((s) => typeof s === "string").join("\n") || "Confirm?";
    const v = answer.answers?.[q];
    const picked = Array.isArray(v) ? v[0] : v;
    // Defense (fail-closed): non-empty answers that miss the question key (title rendering drift
    // etc.) -> treated as unconfirmed; completely empty answers (the front-end approve-button
    // path) stays confirmed:true, preserving the existing contract.
    const hasAnswers = !!answer.answers && Object.keys(answer.answers).length > 0;
    const confirmed = picked !== undefined ? picked !== "Cancel" : !hasAnswers;
    return { type: "extension_ui_response", id: req.id, confirmed };
  }
  return null; // notify/setStatus/setWidget/setTitle/open_url/... one-way, no response needed
}