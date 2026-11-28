/**
 * zcode-appserver — ZCode Protocol v1 persistent client (`zcode.cjs app-server` over stdio NDJSON).
 *
 * Driven the same way as the ZCode desktop app (docs/zcode-desktop-cli-agent-analysis.md §7, 2026-09-07 source reverse-engineering + direct-connect E2E):
 *   spawn app-server → session/create|resume → session/subscribe{deliveryKind:"desktop-continuous"}
 *   → session/send (accepted asynchronously) → session/event notification stream
 *   ⚠ Mid-run steer does not go through session/send (probe 2026-09-10: the v1 path only lands in the runtime deferred queue and never delivers),
 *   it uses the desktop-style v4/command sendText{requestedDelivery:"guide"} (see steerViaCommand).
 *
 * Event mapping (desktop consumption shape → pi-web wire):
 *   model.streaming text_*     → message_update text_start/delta/end (typewriter)
 *   model.streaming reasoning_*→ message_update thinking_start/delta/end
 *   model.streaming tool_input_* / tool_call → message_update toolcall_start/delta/end
 *   tool.updated scheduled/started → tool_execution_start (closes the current streaming message segment first)
 *   tool.updated progress      → tool_execution_update (stdoutTail → partialResult text)
 *   tool.updated result/error  → tool_execution_end + message_end{role:"toolResult"} (tool result card)
 *   tool.updated (TodoWrite family) → onTaskList task-list mirror (desktop-style derivation; no dedicated todo event in the protocol)
 *   turn.completed / failed    → streaming message close message_end{assistant} + agent_end + agent_settled
 *
 * Reverse requests (server→client, must be answered): session/requestRuntimePreferences (desktop-style answer),
 *   interaction/requestPermission (auto-allow, backend semantics), interaction/requestUserInput (★ interaction-primitive bridging).
 *
 * Interaction primitives (2026-09-10, protocol reverse-engineering + session-record evidence):
 *   zcode's "question mode / plan approval" is initiated by two tools, both decided through the interaction/requestUserInput reverse request:
 *   - AskUserQuestion (kind=ask_user): questions=[{question,header,multiSelect,options}] →
 *     answer {action:"accept",content:{answers:{<question text>:<label|label[]>}}}; refusal → deny.
 *   - ExitPlanMode (kind=plan_approval, schema.interaction="plan_approval"): full plan text in input.plan →
 *     approval answer {action:"accept",content:{answer:"approve"}}; rejection-with-feedback answers
 *     {action:"accept",content:{answer:"<feedback>"}} (zcode normalizes to deny+reason=feedback; the agent keeps refining the plan);
 *     direct rejection {action:"decline"}.
 *   Bridging: emit an interaction_request event to the pi-web frontend (unified approval/question cards); the user's answer comes back via
 *   respondInteraction(); zcode has no overall timeout (reannounce re-sends share the requestId; the handler is idempotent),
 *   and on turn settle/dispose all pending requests are declined + cleaned up with interaction_expired.
 *   Permission requests (interaction/requestPermission) keep auto-allow (backend semantics, per the user's yolo requirement).
 *
 *
 * Process model: one app-server child process per connection; process exit → waiters rejected + marked invalid,
 *   the next prompt re-spawns + session/resume (sess_xxx persists under ~/.zcode, revives across processes).
 *   Detachable hosting (2026-12): the child can be launched under the host's wrapper
 *   (systemd-run) and survives a pi-web restart; on reopen the live process is adopted
 *   and the wrapper journal replay (byte-budget gated) restores the scene — beginAdopted/endReplay.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
// P1' launch wrapping (docs/aiti-custom-agent-plan.md): launch resolution goes through the shared layer
import { spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
// Task list (TodoWrite-family tool event derivation) parse/update semantics live in the shared layer (authoritative source _shared/task-list.ts)
import { createTaskListMirror, type TaskEntry } from "@aiti-ai/ext-shared/task-list";

/** Detachable-hosting strategy injected by the host (agent-starter wrapper; absent = plain spawn). */
export interface ZcodeAgentStarterLike {
  readonly kind: "direct" | "wrapper";
  spawn(
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      shell?: boolean | string;
      agentKey?: string;
      sessionId?: string;
    },
  ): Promise<ChildProcess>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Image attachment (same shape as index.ts's TurnImage; data is base64 without the data: prefix). */
export interface TurnImageLike { data: string; mimeType: string; filename?: string }

/** app-server startup retry params: cleans up and re-pulls when the pre-send startup phase (spawn→upsert→resume→subscribe) hits a transport-layer interruption. */
const STARTUP_ATTEMPTS = 3;
const STARTUP_BACKOFF_MS = 1200;

type JsonRecord = Record<string, unknown>;
type Listener = (event: JsonRecord) => void;

/** Desktop-style runtime preferences answer (probe-verified to pass; modelContextBudgetStrategy takes the CLI default preflight-v1). */
export const RUNTIME_PREFERENCES_ANSWER: JsonRecord = {
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
};

/** "bigmodel/GLM-5.3" → {providerId, modelId} (the model field of session/create|setModel); returns null when invalid. */
export function toProtocolModel(modelRef: string): { providerId: string; modelId: string } | null {
  const i = modelRef.indexOf("/");
  if (i <= 0 || i === modelRef.length - 1) return null;
  return { providerId: modelRef.slice(0, i), modelId: modelRef.slice(i + 1) };
}

/** 3.17+ object-form setModel: models that declare a reasoningLevel tier must carry options.reasoningLevel
 *  (otherwise -32603 "Reasoning level is required"; the personal provider config's model card declares
 *  the disabled/enabled tiers). GLM-5 series agents use enabled (thinking on, desktop-style). */
const ZCODE_REASONING_LEVEL = "enabled";

/** UI five-level permission mode → ZCode mode enum (plan/build/edit/yolo/auto). */
export function toProtocolMode(mode: string | undefined): string | undefined {
  switch (mode) {
    case "plan": return "plan";
    case "default": case "build": return "build";
    case "acceptEdits": case "edit": return "edit";
    case "bypassPermissions": case "yolo": return "yolo";
    default: return undefined;
  }
}

// ============================================================================
// Connection layer: one app-server child process + NDJSON codec + bidirectional RPC
// ============================================================================

export class ZcodeAppServerConnection {
  private child: ChildProcess | null = null;
  private buffer = "";
  private exited = true;
  private nextId = 1;
  private pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout | undefined;
  }>();
  private reverse = new Map<string, (params: JsonRecord) => unknown | Promise<unknown>>();
  private notificationListeners = new Set<(method: string, params: JsonRecord) => void>();
  private exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  /** app-server stderr last-8KB ring buffer (persisted on non-zero exit / spawn failure, replacing the previous full stderr discard). */
  private stderrTail = "";

  private opts: {
    nodeBin: string;
    runtimePath: string;
    cwd: string;
    env: Record<string, string>;
    /** P2 protocol delegation: member-level launch wrapping (custom-agent path), takes precedence over the extman spawn.* feature. */
    launchOverride?: LaunchOverride;
    /** Injected by the pi-web core (detachable hosting); absent = plain spawn. */
    agentStarter?: ZcodeAgentStarterLike;
    /** Registry key for the detached wrapper (native sess id, or the provisional composite id pre-bind). */
    registryKey?: string;
    /** Core recovery: adopt this live wrapper-hosted process instead of spawning. */
    attachedChild?: ChildProcess;
    /** Journal bytes the wrapper replayed into the adopted child's stdio (see SocketChild.replayBytes). */
    replayByteBudget?: number;
    log?: (msg: string) => void;
  };

  /** Assigned post-construction (the session owns the replay boundary; see AppServerSession.beginAdopted). */
  onReplayDrained: (() => void) | null = null;

  private replayBudget: number;
  private replaySeen = 0;
  private replayDoneFired = false;

  constructor(opts: {
    nodeBin: string;
    runtimePath: string;
    cwd: string;
    env: Record<string, string>;
    launchOverride?: LaunchOverride;
    agentStarter?: ZcodeAgentStarterLike;
    registryKey?: string;
    attachedChild?: ChildProcess;
    replayByteBudget?: number;
    log?: (msg: string) => void;
  }) {
    this.opts = opts;
    this.replayBudget = opts.replayByteBudget ?? 0;
  }

  isAlive(): boolean {
    return !this.exited && this.child !== null;
  }

  /** True while the connection hosts an adopted wrapper process (dispose = release, never kill). */
  isAdopted(): boolean {
    return this.opts.attachedChild !== undefined;
  }

  /** Journal replay byte budget (0 = none); consumed by actual stdout+stderr bytes here. */
  replayBudgetBytes(): number {
    return this.replayBudget;
  }

  /**
   * Adopted process died (crash / superseded by another instance): drop the adopt
   * constraint so the next start() spawns normally (still through the wrapper
   * strategy when present) — keeps the stock "process exit → next prompt respawn +
   * session/resume" resilience instead of wedging the retry loop on a dead facade.
   */
  clearAdopted(): void {
    this.opts.attachedChild = undefined;
    this.replayBudget = 0;
    this.replayDoneFired = true;
  }

  async start(): Promise<void> {
    if (this.isAlive()) return;
    // Adopted path (pi-web restart recovery): the process is hosted by the wrapper —
    // wire it, never spawn.
    if (this.opts.attachedChild) {
      this.wireChild(this.opts.attachedChild);
      this.opts.log?.(`[aiti-zcode-agent] app-server adopted (pid ${this.opts.attachedChild.pid ?? "?"}, replay ${this.replayBudget}B)`);
      return;
    }
    // extman spawn.command/spawn.argsPrefix launch wrapping; default = unchanged behavior; P2 launchOverride takes precedence
    const ov = this.opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: this.opts.nodeBin,
      command: ov?.command?.trim() || spawnCommand("aiti-zcode-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-zcode-agent")).args,
      driverArgs: [this.opts.runtimePath, "app-server", "--surface", "desktop"],
      env: this.opts.env,
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: this.opts.cwd,
      warn: (m) => console.log(`[aiti-zcode-agent] ${m}`),
    });
    // Detachable hosting: host-injected wrapper strategy (systemd-run launches the
    // pi-web wrapper; the agent survives pi-web restarts and is re-adopted via the
    // registry); absent = plain spawn.
    const child = this.opts.agentStarter
      ? await this.opts.agentStarter.spawn(launch.command, launch.args, {
        cwd: this.opts.cwd,
        env: launch.env as Record<string, string>,
        agentKey: "zcode",
        sessionId: this.opts.registryKey || "",
      })
      : spawn(launch.command, launch.args, {
        cwd: this.opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: launch.env,
      });
    this.wireChild(child);
  }

  /** Wire a child (shared by spawn and adopt): feed stdout byte-wise + replay budget accounting. */
  private wireChild(child: ChildProcess): void {
    this.child = child;
    this.exited = false;
    this.buffer = "";
    this.stderrTail = "";
    // No setEncoding: the replay budget counts bytes (stdout+stderr combined), and
    // both the facade PassThrough and multibyte chars split across chunks need raw
    // Buffer + StringDecoder (hardening A1 pattern).
    const dec = new StringDecoder("utf8");
    const countBytes = (n: number): void => {
      if (this.replayDoneFired || this.replayBudget <= 0) return;
      this.replaySeen += n;
      if (this.replaySeen >= this.replayBudget) {
        this.replayDoneFired = true;
        this.onReplayDrained?.();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      // Feed the protocol layer first, count after: the budget-completing chunk is
      // still dispatched inside the replay gate (the drain callback fires endReplay
      // synchronously; counting first would let this chunk slip through as "live"
      // and re-emit history).
      this.feed(dec.write(chunk));
      countBytes(chunk.length);
    });
    // All three streams must have error listeners (hardening A2): ECONNRESET/EPIPE without a listener crashes the host process.
    child.stdout?.on("error", (err: Error) => {
      // stdout is the protocol stream; broken = dead: the exit path runs failAllPending
      this.opts.log?.(`[aiti-zcode-agent] app-server stdout error: ${err.message}`);
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    });
    child.stderr?.on("error", (err: Error) => this.opts.log?.(`[aiti-zcode-agent] app-server stderr error: ${err.message}`));
    child.stdin?.on("error", (err: Error) => this.opts.log?.(`[aiti-zcode-agent] app-server stdin error: ${err.message}`));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      countBytes(typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length);
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8192);
      if (process.env.AITI_ZCODE_DEBUG_STDERR) {
        process.stderr.write(`[aiti-zcode-agent][app-server] ${chunk.toString()}`);
      }
    });
    child.once("exit", (code, signal) => {
      // Generation check: a late exit from a stale child after reset/respawn must not overwrite the new child's state
      if (this.child !== child) return;
      this.exited = true;
      this.child = null;
      const reason = `app-server 进程退出（code=${code}${signal ? ` signal=${signal}` : ""}）`;
      // Persist stderr only on abnormal exit (non-zero code / hard-kill signals like SIGKILL); dispose's normal SIGTERM shutdown stays quiet
      const abnormal = (code !== null && code !== 0) || (signal != null && signal !== "SIGTERM" && signal !== "SIGINT");
      if (abnormal) {
        this.opts.log?.(`[aiti-zcode-agent] ${reason}\n--- app-server stderr tail ---\n${this.stderrTail || "(empty)"}\n--- end ---`);
      }
      this.failAllPending(new Error(reason));
      for (const fn of [...this.exitListeners]) fn({ code, signal });
    });
    child.once("error", (err) => {
      if (this.child !== child) return;
      this.exited = true;
      this.child = null;
      this.opts.log?.(`[aiti-zcode-agent] app-server 进程启动失败: ${err.message}\n--- stderr tail ---\n${this.stderrTail || "(empty)"}\n--- end ---`);
      this.failAllPending(new Error(`app-server 进程启动失败: ${err.message}`));
      for (const fn of [...this.exitListeners]) fn({ code: null, signal: null });
    });
    this.opts.log?.(`[aiti-zcode-agent] app-server ${child === this.opts.attachedChild ? "adopted" : "spawned"} (pid ${child.pid})`);
  }

  /** Latest child stderr (last 8KB; attached to the error on startup failure and surfaced, replacing the previous full stderr discard). */
  get stderrTailText(): string {
    return this.stderrTail;
  }

  /** Current child process (facade or plain spawn; null before start). */
  childProcess(): ChildProcess | null {
    return this.child;
  }

  /** Registers a server→client reverse-request handler (must answer; unregistered methods get no reply and the server times out on its own). */
  handleReverseRequest(method: string, handler: (params: JsonRecord) => unknown | Promise<unknown>): void {
    this.reverse.set(method, handler);
  }

  onNotification(fn: (method: string, params: JsonRecord) => void): () => void {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  onExit(fn: (info: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(fn);
    return () => this.exitListeners.delete(fn);
  }

  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
    if (!this.isAlive()) return Promise.reject(new Error("app-server 进程未运行"));
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const entry = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: timeoutMs > 0
          ? setTimeout(() => {
            this.pending.delete(String(id));
            reject(new Error(`${method} 超时（${timeoutMs}ms）`));
          }, timeoutMs)
          : undefined,
      };
      this.pending.set(String(id), entry);
      this.write({ id, method, params });
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    try { this.child?.kill(signal); } catch { /* already dead */ }
  }

  /**
   * Drop the local connection without killing the agent (dispose semantics for a
   * wrapper-hosted facade; SocketChild.release only tears down the socket — the
   * process stays in the wrapper). Plain children have no release surface → kill
   * as fallback (callers should not reach this on a non-wrapper child: the handle
   * branches on facade.detachable first).
   */
  release(): void {
    const facade = this.child as unknown as { detachable?: unknown; release?: () => void } | null;
    if (facade?.detachable === true && typeof facade.release === "function") {
      facade.release();
      return;
    }
    this.kill();
  }

  private write(obj: JsonRecord): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) return;
    try {
      stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      // Write failed (child just died): the exit event finishes with failAllPending
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg: JsonRecord;
      try { msg = JSON.parse(line) as JsonRecord; } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRecord): void {
    const id = msg.id;
    if (id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(String(id));
      if (!entry) return;
      this.pending.delete(String(id));
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error !== undefined && msg.result === undefined) {
        const e = msg.error as { code?: number; message?: string; data?: unknown };
        const err = new Error(`zcode rpc ${e.code ?? ""}: ${e.message ?? "unknown"}`);
        (err as Error & { code?: number; data?: unknown }).code = e.code;
        (err as Error & { code?: number; data?: unknown }).data = e.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method !== "string") return;
    const params = (msg.params ?? {}) as JsonRecord;
    if (id !== undefined) {
      // Reverse request: run the handler asynchronously and answer (reply with the same id: {id, result|error})
      const handler = this.reverse.get(msg.method);
      if (!handler) return; // the desktop tolerates unanswered unknown reverse requests (probe confirmed requestOfficialMcpAuthHeaders may go unanswered)
      void Promise.resolve()
        .then(() => handler(params))
        .then((result) => this.write({ id, result: result ?? {} }))
        .catch((e) => this.write({ id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }));
      return;
    }
    for (const fn of [...this.notificationListeners]) fn(msg.method, params);
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// ============================================================================
// Session layer: one zcode session (create/resume/subscribe/send/stop/setModel/setMode)
// + session/event → pi event state machine (desktop-style consumption shape)
// ============================================================================

/** usage from turn.completed (real provider figures; missing field = the server did not report it).
 *  ⚠ tokenCount is a chars/4 character estimate when the engine lacks a baseline (base64 images/large text are counted in full;
 *  content-heavy sessions can reach millions) — context usage must preferentially take the real usage here, tokenCount is only a fallback. */
export interface TurnUsageSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface TurnOutcome {
  cancelled: boolean;
  errorMessage?: string;
  /** tokenCount from turn.completed (engine projection; ≈ totalTokens when usage exists, a character estimate without baseline). */
  tokenCount?: number | null;
  /** usage from turn.completed (real provider usage; authoritative source for context usage / usage panels). */
  usage?: TurnUsageSnapshot;
  durationMs?: number | null;
  cacheReadTokens?: number | null;
  resultType?: string;
}

/** turn.completed payload.usage → snapshot (schema is t.unknown(); field-by-field wide-number extraction). */
function parseUsageSnapshot(v: unknown): TurnUsageSnapshot | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const p = v as JsonRecord;
  const out: TurnUsageSnapshot = {};
  const inputTokens = num(p.inputTokens);
  const outputTokens = num(p.outputTokens);
  const totalTokens = num(p.totalTokens);
  const reasoningTokens = num(p.reasoningTokens);
  const cacheReadTokens = num(p.cacheReadTokens);
  const cacheWriteTokens = num(p.cacheWriteTokens);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** interaction/requestUserInput reverse-request params (runtime 0.16.5 schema summary). */
interface UserInputRequestParams {
  requestId?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  prompt?: unknown;
  questions?: unknown;
  input?: unknown;
  schema?: unknown;
}

/** The user's answer to an interaction request (same shape as pi-web InteractionAnswer, avoids a cross-package type dependency). */
export interface InteractionAnswerInput {
  action: "accept" | "decline";
  answers?: Record<string, string | string[]>;
  message?: string;
}

/** Pending interaction request: shared promise (reused across reannounce re-sends) + event payload + resolver. */
interface PendingInteraction {
  kind: "plan_approval" | "ask_user" | "generic";
  requestId: string;
  promise: Promise<JsonRecord>;
  resolve: (answer: JsonRecord) => void;
  /** interaction_request event payload (re-emitted as-is on reannounce re-sends). */
  event: JsonRecord;
}

/** Fixed answer value for plan-approval questions (zcode constant; runtime reverse-engineering confirmed "approve" is the real approval). */
const PLAN_APPROVE_ANSWER = "approve";

export interface AppServerSessionOpts {
  connection: ZcodeAppServerConnection;
  cwd: string;
  /** Permission mode at create time (either a UI five-level name or a zcode mode name; normalized internally). */
  mode?: string;
  /** Model ref at create time ("provider/model"). */
  modelRef?: string;
  /** Known zcode session id → use session/resume (revival from All Sessions / after a process restart). */
  sessId?: string;
  /**
   * Provider injection (desktop-style workspace/upsertModelProvider channel): credentials and model catalog
   * registered purely in memory (apiKey inline → in-memory secrets, never written to config.json). Required for resume —
   * when restoring a session the server validates that the historical model is in the provider registry; if absent it sets restoreWarning (-32031 rejects send).
   * Also used to build runtimeModel (carried on resume/send → the server's xse path applies the model directly and clears restoreWarning;
   * measured 2026-09-09: even after upsert, resume can still hit the deferred_model_adapter (restoreWarning) path on some sessions,
   * and only carrying runtimeModel bypasses -32031; see docs/zcode-desktop-cli-agent-analysis.md §7.3.1).
   */
  provider?: {
    providerId: string;
    baseURL: string;
    apiKey: string;
    models: Array<{ modelId: string; label?: string; contextWindow?: number }>;
    /** Extra request headers submitted with the provider (start-plan captcha backfill: `x-aliyun-captcha-verify-param` etc.; analysis §9). */
    headers?: Record<string, string>;
  };
  log?: (msg: string) => void;
  /** pi event outlet (message_*, tool_*, agent_*). */
  onEvent: (ev: JsonRecord) => void;
  /** Captures the real zcode session id (called once after the first create). */
  onSessionId?: (sid: string) => void;
  /** Server steer-queue mirror changes (inputs handed to zcode but not yet drained; full snapshot). */
  onSteerQueue?: (items: Array<{ pendingInputId: string; input: string }>) => void;
  /** Task-list mirror changes (read-only TodoWrite working plan; full snapshot, persists across turns). */
  onTaskList?: (todos: TaskEntry[]) => void;
  /**
   * start-plan captcha solver slot (data source for the `interaction/requestProviderRuntimeHeaders` reverse request).
   * Returning {captchaVerifyParam, region?} → internally re-upserts with provider headers, then answers {headersApplied:true};
   * returning {ok:false, errorMessage?} or timing out / being unconfigured → answers {headersApplied:false, errorMessage} (turn fails with a human-readable message).
   * Absent = no solver configured (start-plan channel turns fail with "captcha solver not configured").
   */
  onProviderHeadersRequest?: (req: { requestId: string; providerId: string; modelRef: string; reason: string }) => Promise<
    { ok: true; captchaVerifyParam: string; region?: string } | { ok: false; errorMessage: string }
  >;
}

/** Time limit for waiting on captcha solving (covers the silent + user-slider modes; timeout settles as headersApplied:false). */
const PROVIDER_HEADERS_WAIT_MS = 180_000;

type StreamBlock = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "toolCall"; toolCallId: string; toolName: string; input: JsonRecord };
interface WaiterEntry { resolve: (o: TurnOutcome) => void; reject: (e: Error) => void }

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ----------------------------------------------------------------------------
// Task-list derivation (read-only TodoWrite working plan mirror) — parse/update semantics moved up into the shared layer
// @aiti-ai/ext-shared/task-list (shared across the CC family; tests in _shared/task-list.test.mjs).
// This file keeps only the outlets: tool events → mirror.fromToolEvent, resume snapshot → mirror.seed.
// ----------------------------------------------------------------------------

export class AppServerSession {
  /** Real zcode session id (sess_xxx). */
  zcodeSid: string | null;
  private ready = false;
  private subscribed = false;
  private opts: AppServerSessionOpts;
  private conn: ZcodeAppServerConnection;
  private turnWaiters = new Set<WaiterEntry>();
  /** Server steer-queue mirror (turn.steerQueued in / steerDrained·steerDiscarded out). */
  private steerQueue: Array<{ pendingInputId: string; input: string }> = [];
  /** Task-list mirror (derived from TodoWrite-family tool events + resume snapshot seed; persists across turns, finishTurn does not clear it). */
  private tasks = createTaskListMirror((todos) => this.opts.onTaskList?.(todos));
  /** v4 steer command sequence number (commandId uniqueness). */
  private v4SteerSeq = 0;
  private wired = false;
  private offNotification: (() => void) | null = null;
  private offExit: (() => void) | null = null;
  /** Set by dispose: the ensureReady retry loop stops as soon as it sees this (no more child respawn). */
  private disposedFlag = false;
  /** Pending interaction-primitive requests (interaction_request emitted, waiting for the user's answer; addressed by requestId). */
  private pendingInteractions = new Map<string, PendingInteraction>();
  /** Current turn has settled (turn.completed/failed handled): reverse requests arriving afterwards are no longer pended and get declined directly (leak prevention). */
  private turnSettled = true;
  // ---- Detachable hosting (wrapper-hosted process survives pi-web restarts; journal replay recovery) ----
  /** Replay in progress: journal-replayed session/events never re-emit (already persisted
   *  in the store/frontend; re-emitting would duplicate). Only in-memory mirrors advance
   *  (steer queue/task list/turn state); the byte budget draining flips this to live. */
  private replaying = false;
  /** endReplay idempotence guard (the connection callback and beginAdopted can both trigger it). */
  private replayDone = true;
  /** A turn is still unsettled inside the adopted process (journal shows streaming/tool without
   *  turn.completed; live turn.completed clears it). Consumed by handle.isRunning() — a turn
   *  that was running across the restart keeps its running state and settles normally. */
  turnActive = false;

  // ---- Streaming state machine (one assistant message open at a time; desktop-style granularity) ----
  private stream: {
    assistantMessageId: string;
    blocks: StreamBlock[];
    /** Explicit partId → contentIndex. */
    index: Map<string, number>;
    acc: Map<number, { kind: "text"; text: string } | { kind: "thinking"; thinking: string } | { kind: "tool"; rawInput: string; toolCallId: string; toolName: string }>;
    /** toolCallId → contentIndex (real-device wire tool frames may lack partId; located by callId). */
    toolByCallId: Map<string, number>;
    /** Without partId, implicitly continue a block by kind (the real-device wire can lack *_start opening frames and still land blocks). */
    implicit: { text?: number; reasoning?: number; tool?: number };
  } | null = null;
  private seenToolStarts = new Set<string>();
  /** toolCallId → toolName (reverse lookup across streaming/event frames; result frames may lack toolName). */
  private toolNameByCallId = new Map<string, string>();

  constructor(opts: AppServerSessionOpts) {
    this.opts = opts;
    this.conn = opts.connection;
    this.zcodeSid = opts.sessId ?? null;
  }

  private get log(): (msg: string) => void {
    return this.opts.log ?? (() => {});
  }

  private emit(ev: JsonRecord): void {
    if (this.replaying) return; // journal replay segment: advance mirrors only, never re-emit history
    this.opts.onEvent(ev);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Adopt path (pi-web restart recovery: adopt the live wrapper-hosted process): skips
   * create/resume/subscribe (the old connection never dropped — the wrapper holds the
   * app-server's stdio, so the subscription and any running turn are still alive), flags
   * ready, opens the replay gate and wires the facade to consume the journal replay; the
   * byte budget draining (onReplayDrained → endReplay) flips it to live. Later prompts
   * short-circuit on ready in ensureReady — the startup sequence never re-runs.
   */
  async beginAdopted(): Promise<void> {
    if (this.ready) return;
    const budget = this.conn.replayBudgetBytes();
    this.replayDone = false;
    this.replaying = budget > 0;
    // Treat an unsettled turn as "running" from the first moment of adoption (reverse
    // requests answerable, isRunning true); a turn.completed/failed in the journal
    // settles it via finishTurn.
    this.turnSettled = false;
    this.wire();
    await this.conn.start(); // adopted: wire only, no spawn
    // Adopted = ready (the session and its subscription are alive in the old process):
    // later prompts short-circuit on ready in ensureReady and the startup sequence never
    // re-runs; stop/setModel/setMode depend on this flag too.
    this.ready = true;
    this.subscribed = true;
    if (!this.replaying) this.endReplay(); // no replay (empty journal / plain adopt) → straight to live
  }

  /** Replay budget drained (connection byte accounting): flip to live + flush mirror finals. Connection-callback driven; idempotent. */
  endReplay(): void {
    if (this.replayDone) return;
    // Flush the steer mirror final state BEFORE clearing the gate: the handle's
    // onSteerQueue callback checks replayActive() to suppress user bubbles for
    // replayed steer items (the text is already persisted with the turn in the
    // store); force=true bypasses the gate while keeping replayActive() true.
    this.notifySteerQueue(true);
    this.replayDone = true;
    this.replaying = false;
    // Interactions still unanswered (registered during replay but their emit was gated):
    // re-emit the cards so the user can answer; the server-side reannounce (≤10s) also
    // re-sends the same requestId — double coverage, both idempotent.
    for (const [, pending] of this.pendingInteractions) this.emit(pending.event);
    if (this.turnActive) {
      // A turn was still running at adoption: agent_start(resumed) puts the frontend in
      // streaming state (same contract as qoder); the live turn.completed settles via
      // finishTurn.
      this.emit({ type: "agent_start", resumed: true });
    }
  }

  /** Whether the replay is still in progress (the handle gates steer bubbles etc. on this). */
  replayActive(): boolean {
    return this.replaying;
  }

  /** The wrapper facade behind the current child (SocketChild; null when not wrapper-hosted). Handle dispose branches on this. */
  detachedChild(): (ChildProcess & { detachable?: unknown; release?: () => void }) | null {
    const child = this.conn.childProcess();
    if (!child) return null;
    const facade = child as ChildProcess & { detachable?: unknown; release?: () => void };
    return facade.detachable === true && typeof facade.release === "function" ? facade : null;
  }

  /** Ensures the app-server process + session + subscription are ready (called before prompt; idempotent). */
  async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.wire();
    // Proper bring-up: after the process is killed / exits instantly, in-memory leftovers were reset by the exit callback
    // (ready/subscribed; re-running start re-clears buffer/stderrTail); fully re-walk spawn→upsert→resume→subscribe here to recover —
    // replacing the old behavior of throwing "app-server process not running" straight at the user and wedging the session. Retries cover only the pre-send startup phase;
    // a process exit after send was accepted still rejects the turn via onExit → failWaiters; the next prompt re-pulls from here.
    for (let attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt++) {
      try {
        if (!this.conn.isAlive()) {
          // Adopted process died (crash / superseded): drop the adopt constraint, degrade to a normal spawn+resume
          if (this.conn.isAdopted()) {
            this.conn.clearAdopted();
            this.replayDone = true;
            this.replaying = false;
          }
          await this.conn.start();
        }
        // Adopted connection (wrapper-hosted live process): the session and subscription
        // are alive in the old process — never re-run create/resume/subscribe (it would
        // fork/split the session); a failed start retry simply re-wires.
        if (this.conn.isAdopted() && !this.ready) {
          await this.beginAdopted();
          return;
        }
        await this.ensureProtocolReady();
        this.ready = true;
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const transportDown = /进程退出|进程未运行|启动失败|连接复位/.test(msg);
        if (!transportDown) throw e; // business errors rethrow as-is (e.g. -32031 historical-model validation rejecting send)
        if (attempt >= STARTUP_ATTEMPTS || this.disposedFlag) {
          throw new Error(`app-server 启动失败（已重试 ${attempt} 次）：${msg}；stderr: ${this.conn.stderrTailText || "(empty)"}`);
        }
        this.log(`[aiti-zcode-agent] app-server 启动序列中断（attempt ${attempt}/${STARTUP_ATTEMPTS}），清理内存遗留后重拉：${msg}`);
        await sleep(STARTUP_BACKOFF_MS * attempt);
      }
    }
  }

  /** Startup sequence (ensureReady's retryable body): provider injection → create|resume → subscribe. */
  private async ensureProtocolReady(): Promise<void> {
    // Provider injection (desktop-style): before create/resume — resume validates that the historical
    // model is in the provider registry; absence triggers restoreWarning (-32031 rejects send, measured)
    if (this.opts.provider) {
      await this.upsertProvider();
    }
    if (!this.zcodeSid) {
      // Note: create carries no model param — an explicit model triggers "persist model selection → config.json"
      // failing with -32603 (verified on a real device). The ZCODE_MODEL env is only honored on the --prompt/oneshot
      // surface (probe-verified); the app-server surface does not read env: create's default model = the first available
      // model in the workspace registry (after upsert that is bigmodel-coding-plan/GLM-5.3, desktop registry order;
      // runtime-side zcode_protocol.session_model system). So setModel must align the chosen model after create and
      // before the first send, or the new session runs on the runtime default model from turn one (the nightly free window only accepts Flash).
      const snap = await this.conn.request<JsonRecord>("session/create", {
        workspace: { workspacePath: this.opts.cwd, workspaceKey: this.opts.cwd },
        persistence: "immediate",
        ...(toProtocolMode(this.opts.mode) ? { mode: toProtocolMode(this.opts.mode) } : {}),
      }, { timeoutMs: 120_000 });
      const sid = (snap?.session as JsonRecord | undefined)?.sessionId;
      if (typeof sid !== "string" || !sid) throw new Error("session/create 未返回 sessionId");
      this.zcodeSid = sid;
      this.opts.onSessionId?.(sid);
      this.log(`[aiti-zcode-agent] app-server session created: ${sid}`);
      // Align the model unconditionally (what you select is what you get, no explicit/implicit distinction);
      // persistAsWorkspaceLastUsed:false, same as the resume branch (persist would fail with -32603). Failure does not block startup: this turn
      // falls back to the runtime default model, and the next resume re-aligns by carrying runtimeModel again.
      const createModel = this.opts.modelRef ? toProtocolModel(this.opts.modelRef) : null;
      if (createModel) {
        await this.setModelCompat(createModel, false).catch((e) =>
          this.log(`[aiti-zcode-agent] create 后 setModel 失败（本轮用 runtime 默认模型）: ${e instanceof Error ? e.message : String(e)}`));
      }
    } else if (!this.subscribed) {
      // Cross-process revival: sess_xxx persists under ~/.zcode; resume replays history.
      // With runtimeModel — the server's xse path applies the current model directly and clears restoreWarning;
      // without it, a historical model missing from the catalog (common on the env-only channel) sets restoreWarning → send is rejected with -32031 (measured 2026-09-09).
      const runtimeModel = this.buildRuntimeModel();
      // 3.17+ removed the runtimeModel key from resume (strict schema rejects unknown keys with -32603)
      // → send it first (required for old CLIs to bypass the -32031 restoreWarning); on a ZodError-shaped failure retry without it.
      let resumedWithoutRuntimeModel = false;
      const resumed = await this.conn.request<JsonRecord>("session/resume", {
        sessionId: this.zcodeSid,
        ...(runtimeModel ? { runtimeModel } : {}),
      }, { timeoutMs: 120_000 }).catch(async (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (!runtimeModel || !/ZodError|unrecognized|Invalid input/i.test(msg)) throw e;
        this.log(`[aiti-zcode-agent] resume 带 runtimeModel 被拒（3.17+ 已移除该键），无 runtimeModel 重试: ${msg.slice(0, 120)}`);
        resumedWithoutRuntimeModel = true;
        return this.conn.request<JsonRecord>("session/resume", { sessionId: this.zcodeSid }, { timeoutMs: 120_000 });
      });
      // The resume response is snapshot-shaped (confirmed to include todos on a real device) → task-list seed (cross-process revival / refresh recovery)
      this.seedTaskListFromSnapshot(resumed?.todos);
      if (!runtimeModel || resumedWithoutRuntimeModel) {
        // No provider info (runtimeModel cannot be built → old-CLI setModel fallback) or the 3.17+ retry path (
        // runtimeModel channel retired → explicit setModel aligns the model, paired with personal provider config registry registration)
        const model = this.opts.modelRef ? toProtocolModel(this.opts.modelRef) : null;
        if (model) {
          // persistAsWorkspaceLastUsed:false — env-only mode has no config.json; persisting would error (verified on a real device)
          await this.setModelCompat(model, false).catch((e) =>
            this.log(`[aiti-zcode-agent] resume 后 setModel 失败（不影响本轮）: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      this.log(`[aiti-zcode-agent] app-server session resumed: ${this.zcodeSid}`);
    }
    if (!this.subscribed) {
      await this.conn.request("session/subscribe", {
        sessionId: this.zcodeSid,
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
      }, { timeoutMs: 30_000 });
      this.subscribed = true;
    }
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    this.conn.handleReverseRequest("session/requestRuntimePreferences", () => RUNTIME_PREFERENCES_ANSWER);
    this.conn.handleReverseRequest("interaction/requestPermission", (p) => {
      this.log(`[aiti-zcode-agent] 权限自动放行（backend 语义）: ${String(p.toolName ?? "?")}`);
      return { decision: "allow" };
    });
    this.conn.handleReverseRequest("interaction/requestUserInput", (p) => this.onUserInputRequest(p));
    this.conn.handleReverseRequest("interaction/requestProviderRuntimeHeaders", (p) => this.onProviderHeadersRequest(p));
    // Replay budget drained → flip the session to live (endReplay; never fires for non-adopt / no-budget connections)
    this.conn.onReplayDrained = () => this.endReplay();
    this.offNotification = this.conn.onNotification((method, params) => {
      if (method === "session/event") this.onSessionEvent(params);
    });
    this.offExit = this.conn.onExit(() => {
      this.ready = false;
      this.subscribed = false;
      this.turnActive = false;
      this.failWaiters(new Error("app-server 进程退出，本轮中断"));
    });
  }

  /**
   * Provider injection (desktop-style workspace/upsertModelProvider): credentials and model catalog registered purely in memory.
   * `headers` serves start-plan captcha backfill (`x-aliyun-captcha-verify-param` etc.) — same mechanism as desktop
   * (after solving, re-upsert with headers; providerRevision advances and CLI requests then carry them).
   */
  private async upsertProvider(headers?: Record<string, string>): Promise<void> {
    const p = this.opts.provider;
    if (!p) return;
    const cleanHeaders = headers && Object.keys(headers).length > 0 ? headers : undefined;
    await this.conn.request("workspace/upsertModelProvider", {
      workspace: { workspacePath: this.opts.cwd, workspaceKey: this.opts.cwd },
      provider: {
        providerId: p.providerId,
        kind: "anthropic",
        source: "workspace",
        label: "BigModel",
        baseURL: p.baseURL,
        apiKey: { source: "inline", value: p.apiKey },
        models: p.models.map((m) => ({ modelId: m.modelId, ...(m.label ? { label: m.label } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })),
        ...(cleanHeaders ? { headers: cleanHeaders } : {}),
      },
    }, { timeoutMs: 30_000 }).catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      // 3.17+ removed this RPC (-32601 Method not found) → stay silent in that case (personal provider config takes over model registration)
      if (/Method not found/i.test(msg)) return;
      this.log(`[aiti-zcode-agent] upsertModelProvider 失败（继续，env 通道兜底）: ${msg}`);
    });
  }

  /**
   * `interaction/requestProviderRuntimeHeaders` (start-plan captcha protocol, analysis §9.2):
   * call the solver for captchaVerifyParam → re-upsert the provider with headers → answer `{headersApplied:true}`;
   * solver unconfigured / solving failed / timed out → `{headersApplied:false, errorMessage}` (the result schema is strict zod,
   * allowing only the three keys headersApplied/errorMessage/providerRevision).
   */
  private async onProviderHeadersRequest(p: JsonRecord): Promise<JsonRecord> {
    const requestId = String(p.requestId ?? "");
    const providerId = String(p.providerId ?? "");
    const reason = String(p.reason ?? "model-request");
    const solver = this.opts.onProviderHeadersRequest;
    if (!solver || !this.opts.provider) {
      return { headersApplied: false, errorMessage: "验证码求解器未配置（start-plan 桥接未启用）" };
    }
    try {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        solver({ requestId, providerId, modelRef: String(p.modelRef ?? ""), reason }),
        new Promise<{ ok: false; errorMessage: string }>((resolve) => {
          waitTimer = setTimeout(() => resolve({ ok: false, errorMessage: `等待验证码求解超时（${PROVIDER_HEADERS_WAIT_MS / 1000}s）` }), PROVIDER_HEADERS_WAIT_MS);
        }),
      ]);
      clearTimeout(waitTimer); // the race loser no longer holds the event loop (test process exit depends on this)
      if (!answer.ok) {
        this.log(`[aiti-zcode-agent] provider headers 求解失败（${reason}）: ${answer.errorMessage}`);
        return { headersApplied: false, errorMessage: answer.errorMessage };
      }
      const headers: Record<string, string> = { "x-aliyun-captcha-verify-param": answer.captchaVerifyParam };
      if (answer.region) headers["x-aliyun-captcha-verify-region"] = answer.region;
      await this.upsertProvider(headers);
      this.log(`[aiti-zcode-agent] provider headers 已回填（${providerId}，reason=${reason}，param ${answer.captchaVerifyParam.length}B）`);
      return { headersApplied: true };
    } catch (e) {
      return { headersApplied: false, errorMessage: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * setModel dual-version compatible send: send bare first (old CLIs ≤3.16 succeed without options); on hitting
   * "Reasoning level is required" (3.17+ registry models declare a tier) retry with options added.
   * Note options lives inside the model object (Nl = {providerId, modelId, options?}), not at the request top level.
   * The reverse order (options first) gets rejected by strict schema on old CLIs as an unknown key — do not use it.
   */
  private async setModelCompat(model: { providerId: string; modelId: string }, persistAsWorkspaceLastUsed: boolean): Promise<void> {
    const base = { sessionId: this.zcodeSid, model, persistAsWorkspaceLastUsed };
    try {
      await this.conn.request("session/setModel", base, { timeoutMs: 30_000 });
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/Reasoning level is required/i.test(msg)) throw e;
    }
    await this.conn.request("session/setModel", {
      sessionId: this.zcodeSid,
      model: { ...model, options: { reasoningLevel: ZCODE_REASONING_LEVEL } },
      persistAsWorkspaceLastUsed,
    }, { timeoutMs: 30_000 });
  }

  /** After the store is modified externally (e.g. oneshot --attach turns writing to the same session), forces the next cold resume to re-read history. */
  async refreshFromStorage(): Promise<void> {
    if (!this.ready || !this.zcodeSid || !this.conn.isAlive()) return;
    await this.conn.request("session/close", { sessionId: this.zcodeSid }, { timeoutMs: 15_000 }).catch(() => {});
    this.ready = false;
    this.subscribed = false;
  }

  /** Hot-switch model (session/setModel, desktop-style immediate effect; never written to config.json — env-only compliance constraint). */
  async setModel(modelRef: string): Promise<void> {
    const model = toProtocolModel(modelRef);
    if (!model) throw new Error(`非法模型 ref "${modelRef}"`);
    if (!this.ready || !this.zcodeSid) return; // not ready: recorded only, takes effect at create/resume
    await this.setModelCompat(model, false);
  }

  /**
   * Builds runtimeModel (the runtimeModel field of v1 `session/resume` / `session/send`): carrying it makes the
   * server's xse path apply the model directly + clear restoreWarning (the only way out of a -32031 send rejection, measured 2026-09-09).
   * Returns undefined when provider or modelRef is missing (the caller falls back to the original path).
   */
  private buildRuntimeModel(): JsonRecord | undefined {
    const { provider, modelRef } = this.opts;
    if (!provider || !modelRef) return undefined;
    const model = toProtocolModel(modelRef);
    if (!model) return undefined;
    return {
      revision: "0",
      generatedAt: Date.now(),
      model,
      provider: {
        providerId: provider.providerId,
        kind: "anthropic",
        source: "workspace",
        ...(provider.baseURL ? { baseURL: provider.baseURL } : {}),
        apiKey: { source: "inline", value: provider.apiKey },
        models: provider.models.map((m) => ({
          modelId: m.modelId,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        })),
      },
    };
  }

  /** Hot-switch permission mode (session/setMode, immediate effect). */
  async setMode(mode: string): Promise<void> {
    const m = toProtocolMode(mode);
    if (!m) return;
    if (!this.ready || !this.zcodeSid) return;
    await this.conn.request("session/setMode", { sessionId: this.zcodeSid, mode: m }, { timeoutMs: 30_000 });
  }

  /** abort: session/stop (desktop-style); the turn settles with resultType=cancelled.
   *  Timeout shrunk from 15s to 5s: abort() already calls this fire-and-forget, so a non-quick RPC reply counts as desync,
   *  with the abort watchdog (6s cap) hard-kill as the backstop — stop no longer blocks the full 15s. */
  async stop(): Promise<void> {
    // An adopted unsettled turn (its waiters died with the old instance) also goes through
    // session/stop instead of silently no-op'ing (otherwise abort would fall through to the
    // 6s watchdog hard-kill and waste a graceful cancel).
    if (!this.ready || !this.zcodeSid || (this.turnWaiters.size === 0 && !this.turnActive)) return;
    await this.conn.request("session/stop", { sessionId: this.zcodeSid }, { timeoutMs: 5_000 })
      .catch((e) => this.log(`[aiti-zcode-agent] session/stop 失败（abort 看门狗将兜底）: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** abort watchdog hard-kill entry: SIGTERM kills the app-server child → onExit → failWaiters settles the turn.
   *  Backstop scenario: the zcode-side turn is wedged and the protocol layer's hadActivePrompt is desynced, so session/stop is a permanent no-op (measured 2026-09-09). */
  kill(): void {
    this.conn.kill();
  }

  /**
   * session/fork (desktop-style): forks a child session from the assistant reply of turn turnIndex
   * (0-based, counted by user messages) — child history = that reply and everything before it; file snapshots
   * after it roll back per zcode's own checkpoint semantics. Server restriction: rejected while a prompt
   * is running ("Cannot fork while a prompt is running", mapped to a plain-language error on rethrow). The fork does not
   * take effect in this session in place — the caller rebuilds the channel itself (dispose this session → next prompt resumes with the new sid).
   */
  async forkFromTurn(turnIndex: number): Promise<string> {
    if (!this.zcodeSid) throw new Error("fork unavailable (zcode session not established)");
    await this.ensureReady();
    let r: JsonRecord;
    try {
      r = await this.conn.request<Record<string, unknown>>("session/fork", {
        sessionId: this.zcodeSid,
        target: { kind: "turn", turnIndex },
      }, { timeoutMs: 120_000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Cannot fork while/i.test(msg)) throw new Error("运行中不允许分叉（zcode 限制）：请先停止当前轮再编辑/分叉");
      throw e;
    }
    const forked = r?.forkedSessionId;
    if (typeof forked !== "string" || !forked) throw new Error("session/fork 未返回 forkedSessionId");
    return forked;
  }

  /**
   * v4/command sendText{requestedDelivery:"guide"} — desktop-style steer (2026-09-10 protocol reverse-engineering + real-device test):
   * injects into the running turn; the runtime drains it at the next model/tool gap (turn.steerDrained dequeues) and the model answers in the same turn.
   * Idle calls are rejected by the v4 gateway (sessionNotFound / FK) — call only while running; any non-accepted
   * ack throws → the shared layer R9 degrades to a local followUp queue (no message loss).
   */
  async steerViaCommand(text: string): Promise<void> {
    if (!this.ready || !this.zcodeSid) throw new Error("steer unavailable (app-server not ready)");
    const ack = (await this.conn.request("v4/command", {
      commandId: `aiti-steer-${Date.now()}-${++this.v4SteerSeq}`,
      clientId: "aiti-zcode-agent",
      sessionId: this.zcodeSid,
      issuedAt: Date.now(),
      type: "sendText",
      payload: { text, requestedDelivery: "guide" },
    }, { timeoutMs: 20_000 })) as JsonRecord;
    const status = String(ack.status ?? "");
    if (status !== "accepted") {
      throw new Error(`v4 steer ${status || "no-ack"}: ${String(ack.reasonCode ?? ack.message ?? "unknown")}`);
    }
  }

  /**
   * Sends one turn (idle calls only; while running the handle queue layer intercepts and never reaches here). Resolves when the turn settles.
   * With images, attachments are inlined in send — the v1 surface shape is {kind:"image",dataBase64,mimeType,filename,sizeBytes}
   * (runtime SLi mapping; missing dataBase64 silently drops the image; the desktop v4 {ref,...} shape does not apply on this surface).
   */
  async prompt(content: string, images?: TurnImageLike[]): Promise<TurnOutcome> {
    await this.ensureReady();
    this.turnSettled = false;
    this.turnActive = true;
    const outcome = this.registerWaiter();
    const sessionId = this.zcodeSid;
    if (!sessionId) {
      this.turnWaiters.delete(outcome.entry);
      this.turnActive = false;
      throw new Error("session/send unavailable (no sessionId)");
    }
    const attachments = images?.length
      ? images.map((img, i) => ({
          kind: "image",
          dataBase64: img.data,
          mimeType: img.mimeType,
          filename: img.filename || `image-${i + 1}.${(img.mimeType.split("/")[1] || "png").replace(/[^a-z0-9.+-]/gi, "")}`,
          sizeBytes: Buffer.from(img.data, "base64").length,
        }))
      : undefined;
    const sendParams: JsonRecord = { sessionId, content, ...(attachments ? { attachments } : {}) };
    try {
      await this.conn.request("session/send", sendParams, { timeoutMs: 20_000 });
    } catch (e) {
      this.turnWaiters.delete(outcome.entry);
      this.turnActive = false;
      const err = e instanceof Error ? e : new Error(String(e));
      // -32031 (historical model missing from the registry at validation time, restoreWarning rejects send): resend once with runtimeModel —
      // the server's xse path applies the model and clears restoreWarning (theoretically unreachable when resume already carried runtimeModel; double insurance; measured 2026-09-09, works both ways)
      const rm = this.buildRuntimeModel();
      if (err.message.includes("-32031") && rm) {
        this.log(`[aiti-zcode-agent] send 遇 -32031（历史模型不可用），携带 runtimeModel 重试`);
        const retryOutcome = this.registerWaiter();
        try {
          await this.conn.request("session/send", { ...sendParams, runtimeModel: rm }, { timeoutMs: 20_000 });
          return await retryOutcome.promise;
        } catch (e2) {
          this.turnWaiters.delete(retryOutcome.entry);
          throw e2 instanceof Error ? e2 : new Error(String(e2));
        }
      }
      throw err;
    }
    return await outcome.promise;
  }

  async dispose(): Promise<void> {
    this.disposedFlag = true;
    this.turnSettled = true;
    this.failPendingInteractions("session disposed");
    if (this.ready && this.zcodeSid && this.conn.isAlive()) {
      await this.conn.request("session/close", { sessionId: this.zcodeSid }, { timeoutMs: 5_000 }).catch(() => {});
    }
    this.ready = false;
    this.failWaiters(new Error("session disposed"));
    this.conn.kill();
    this.offNotification?.();
    this.offExit?.();
    this.offNotification = null;
    this.offExit = null;
    this.wired = false;
  }

  /**
   * Detach dispose (dispose semantics for a wrapper-hosted process): drop the local
   * connection only — never session/close, never kill. The agent and its running turn
   * survive a pi-web restart/upgrade untouched; the next open re-adopts via the registry.
   * Pending interactions stay pending (the server is still waiting; replay/reannounce
   * restores them after re-adoption).
   */
  detachDispose(): void {
    this.disposedFlag = true;
    this.ready = false;
    this.failWaiters(new Error("session detached"));
    this.offNotification?.();
    this.offExit?.();
    this.offNotification = null;
    this.offExit = null;
    this.wired = false;
    this.conn.release();
  }

  // ------------------------------------------------------------------
  // Interaction-primitive bridging (interaction/requestUserInput → pi-web frontend approval/question cards)
  // ------------------------------------------------------------------

  /**
   * interaction/requestUserInput reverse-request entry (registered on the wire; reannounce re-sends share the requestId → idempotent).
   * zcode has no overall timeout (it keeps reannouncing until answered / the turn ends), so stay pending awaiting respondInteraction.
   */
  private onUserInputRequest(p: UserInputRequestParams): Promise<JsonRecord> | JsonRecord {
    const requestId = typeof p.requestId === "string" && p.requestId ? p.requestId : "";
    if (!requestId) return { action: "decline", reason: "missing requestId" };
    // Idempotent: a reannounce re-send (same requestId) → return the same pending promise and re-emit the event
    // (cards lost after a frontend SSE reconnect/refresh are brought back by the ≤10s reannounce re-sends)
    const existing = this.pendingInteractions.get(requestId);
    if (existing) {
      this.emit(existing.event);
      return existing.promise;
    }
    // Turn already settled (the reverse request raced with the settle frame): do not pend or emit, decline directly (otherwise nobody would ever answer)
    if (this.turnSettled) return { action: "decline", reason: "turn already ended" };

    const schema = (p.schema ?? {}) as JsonRecord;
    const toolName = typeof p.toolName === "string" ? p.toolName : "";
    const kind: PendingInteraction["kind"] =
      schema.interaction === "plan_approval" ? "plan_approval"
        : toolName === "AskUserQuestion" ? "ask_user"
          : "generic";

    // Event payload: full plan text / normalized question group (options keep only label/description)
    const input = (p.input ?? {}) as JsonRecord;
    const plan = typeof input.plan === "string" ? input.plan : "";
    const questions = normalizeQuestions(p.questions);

    let resolve!: (answer: JsonRecord) => void;
    const promise = new Promise<JsonRecord>((r) => { resolve = r; });
    const event: JsonRecord = {
      type: "interaction_request",
      requestId,
      kind,
      ...(toolName ? { toolName } : {}),
      ...(typeof p.prompt === "string" && p.prompt ? { prompt: p.prompt } : {}),
      ...(kind === "plan_approval" && plan ? { plan } : {}),
      ...(questions.length > 0 ? { questions } : {}),
      ...(kind === "generic" ? { input } : {}),
    };
    this.pendingInteractions.set(requestId, { kind, requestId, promise, resolve, event });
    this.emit(event);
    this.log(`[aiti-zcode-agent] 交互请求已桥接前端: kind=${kind} tool=${toolName || "?"} requestId=${requestId}`);
    return promise;
  }

  /**
   * Feeds back the user's answer (landing point of pi-web handle.respondInteraction).
   * Returns false = request missing/expired (cleared at turn settle, or unknown id).
   */
  respondInteraction(requestId: string, answer: InteractionAnswerInput): boolean {
    const pending = this.pendingInteractions.get(requestId);
    if (!pending) return false;
    this.pendingInteractions.delete(requestId);
    pending.resolve(buildUserInputAnswer(pending.kind, answer));
    // Broadcast the invalidation frame: multi-client (multi-tab) card clearing in sync
    this.emit({ type: "interaction_expired", requestId, reason: "resolved" });
    return true;
  }

  /** Turn settle / dispose: all pending interactions get declined (the zcode-side agent continues/wraps up on rejection), and invalidation frames are broadcast. */
  private failPendingInteractions(reason: string): void {
    for (const [requestId, pending] of this.pendingInteractions) {
      pending.resolve({ action: "decline", reason });
      this.emit({ type: "interaction_expired", requestId, reason });
    }
    this.pendingInteractions.clear();
  }

  // ------------------------------------------------------------------
  // Turn waiting
  // ------------------------------------------------------------------

  private registerWaiter(): { promise: Promise<TurnOutcome>; entry: WaiterEntry } {
    let entry!: WaiterEntry;
    const promise = new Promise<TurnOutcome>((resolve, reject) => {
      entry = { resolve, reject };
    });
    this.turnWaiters.add(entry);
    return { promise, entry };
 }

  private failWaiters(err: Error): void {
    for (const fn of this.turnWaiters) fn.reject(err);
    this.turnWaiters.clear();
  }

  private notifySteerQueue(force = false): void {
    if (this.replaying && !force) return; // gated during replay: the mirror array still advances; the callback final state flushes at endReplay
    this.opts.onSteerQueue?.(this.steerQueue.map((s) => ({ ...s })));
  }

  /** TodoWrite-family tool event derivation (input first, output as fallback; the shared layer dedupes before callback). */
  private maybeUpdateTaskList(toolName: string, ...values: unknown[]): void {
    this.tasks.fromToolEvent(toolName, ...values);
  }

  /** Resume snapshot seed (same shape as the `todos` wire; defensive per-entry parsing, empty/failure silently keeps the current state). */
  private seedTaskListFromSnapshot(raw: unknown): void {
    this.tasks.seed(raw);
  }

  private finishTurn(o: TurnOutcome): void {
    this.closeStream();
    this.seenToolStarts.clear();
    this.turnSettled = true;
    this.turnActive = false;
    this.failPendingInteractions("turn ended");
    if (this.steerQueue.length > 0) {
      this.steerQueue = [];
      this.notifySteerQueue();
    }
    this.emit({ type: "agent_end" });
    if (o.errorMessage) {
      this.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: o.errorMessage,
          ...(this.opts.modelRef ? { model: this.opts.modelRef } : {}),
          provider: "zcode",
        },
      });
      this.emit({ type: "agent_settled_error", error: o.errorMessage });
      this.emit({ type: "agent_settled", stopReason: "error", error: o.errorMessage });
    } else {
      this.emit({ type: "agent_settled", stopReason: o.cancelled ? "aborted" : "end_turn" });
    }
    for (const fn of this.turnWaiters) fn.resolve(o);
    this.turnWaiters.clear();
  }

  // ------------------------------------------------------------------
  // session/event → pi events
  // ------------------------------------------------------------------

  private onSessionEvent(env: JsonRecord): void {
    // Defensive filter: always equal under the one-connection-one-session design; guards against cross-talk if a connection is ever shared
    if (this.zcodeSid && typeof env.sessionId === "string" && env.sessionId && env.sessionId !== this.zcodeSid) return;
    const type = env.type;
    const p = (env.payload ?? {}) as JsonRecord;
    // Turn-activity surface (the adopted path's running-state signal: activity without a
    // completion frame in the journal = an unsettled turn; prompt() sets it idempotently
    // on the normal path). Completion frames settle it via finishTurn.
    if (type === "model.streaming" || type === "tool.updated" || type === "turn.steerQueued") this.turnActive = true;
    switch (type) {
      case "model.streaming": this.onModelStreaming(p); break;
      case "tool.updated": this.onToolUpdated(p); break;
      case "turn.completed": {
        const cache = (p.cacheStats ?? {}) as JsonRecord;
        this.finishTurn({
          cancelled: p.resultType === "cancelled",
          resultType: typeof p.resultType === "string" ? p.resultType : undefined,
          tokenCount: num(p.tokenCount) ?? null,
          usage: parseUsageSnapshot(p.usage),
          durationMs: num(p.duration) ?? null,
          cacheReadTokens: num(cache.cacheReadTokens) ?? null,
        });
        break;
      }
      case "turn.failed": {
        const err = (p.error ?? {}) as JsonRecord;
        this.finishTurn({ cancelled: false, errorMessage: String(err.message ?? "zcode turn failed") });
        break;
      }
      case "turn.steerQueued": {
        const id = String(p.pendingInputId ?? "");
        const input = String(p.input ?? "");
        if (id && input && !this.steerQueue.some((s) => s.pendingInputId === id)) {
          this.steerQueue.push({ pendingInputId: id, input });
          this.notifySteerQueue();
        }
        break;
      }
      case "turn.steerDrained":
      case "turn.steerDiscarded": {
        const ids = Array.isArray(p.pendingInputIds) ? p.pendingInputIds.map(String) : [];
        if (ids.length > 0) {
          this.steerQueue = this.steerQueue.filter((s) => !ids.includes(s.pendingInputId));
          this.notifySteerQueue();
        }
        break;
      }
      default: break; // session.updated / titleUpdated / steer* / usage etc.: not consumed in P1
    }
  }

  // ---- model.streaming → pi text/thinking/toolcall three streams ----
  // Real-device wire (measured 2026-09-07): frames may lack partId, may miss the *_start opening frame, and tool frames
  // locate by toolCallId — desktop-style "append + tolerate gaps": explicit partId first, otherwise implicitly continue a block by kind;
  // frames missing assistantMessageId count as "continue the current message".

  private onModelStreaming(p: JsonRecord): void {
    const kind = String(p.kind ?? "");
    const partId = typeof p.partId === "string" && p.partId ? p.partId : null;
    // Missing assistantMessageId → continue the currently open message (some real-device frames omit it)
    const assistantMessageId = typeof p.assistantMessageId === "string" && p.assistantMessageId
      ? p.assistantMessageId
      : this.stream?.assistantMessageId ?? "assistant";
    switch (kind) {
      case "text_start":
      case "reasoning_start":
      case "tool_input_start": {
        this.ensureOpen(assistantMessageId);
        // Explicit partId already mapped → idempotent; otherwise create a block (ensureBlock emits *_start)
        if (partId && this.streamIndex(partId) !== null) break;
        this.ensureBlock(kind === "text_start" ? "text" : kind === "reasoning_start" ? "reasoning" : "tool", partId, p);
        break;
      }
      case "text_delta":
      case "reasoning_delta":
      case "tool_input_delta": {
        this.ensureOpen(assistantMessageId);
        const idx = this.locateBlock(kind, partId, p);
        if (idx === null) break;
        const delta = String(p.delta ?? "");
        const acc = this.stream!.acc.get(idx);
        if (!acc) break;
        if (kind === "text_delta" && acc.kind === "text") {
          acc.text += delta;
          this.emitDelta({ type: "text_delta", contentIndex: idx, delta });
        } else if (kind === "reasoning_delta" && acc.kind === "thinking") {
          acc.thinking += delta;
          this.emitDelta({ type: "thinking_delta", contentIndex: idx, delta });
        } else if (kind === "tool_input_delta" && acc.kind === "tool") {
          acc.rawInput += delta;
          this.emitDelta({ type: "toolcall_delta", contentIndex: idx, id: acc.toolCallId, toolName: acc.toolName, delta });
        }
        break;
      }
      case "text_end":
      case "reasoning_end": {
        const idx = this.locateBlock(kind, partId, p);
        if (idx === null || !this.stream) break;
        const acc = this.stream.acc.get(idx);
        if (!acc) break;
        if (kind === "text_end" && acc.kind === "text") {
          this.emitDelta({ type: "text_end", contentIndex: idx, content: acc.text });
        } else if (kind === "reasoning_end" && acc.kind === "thinking") {
          this.emitDelta({ type: "thinking_end", contentIndex: idx, content: acc.thinking });
        }
        break;
      }
      case "tool_input_end":
        break; // wait for tool_call (arguments finalized)
      case "tool_call": {
        if (!this.stream) break;
        const callId = String(p.toolCallId ?? "");
        const idx = (callId ? this.stream.toolByCallId.get(callId) : undefined) ?? (partId ? this.streamIndex(partId) : null);
        if (idx === null || idx === undefined) break;
        const acc = this.stream.acc.get(idx);
        if (!acc || acc.kind !== "tool") break;
        const block = this.stream.blocks[idx];
        if (block?.type === "toolCall") block.input = parseJsonInput(acc.rawInput);
        this.emitDelta({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: { id: acc.toolCallId, name: block?.type === "toolCall" ? block.toolName : acc.toolName, arguments: block?.type === "toolCall" ? block.input : {} },
        });
        // Derive the task list the moment streaming input finalizes (real-device wire: the scheduled event's input
        // gets stripped — inputOmitted/inputRef:"model_stream" (runtime wLi); this frame is the only real-time
        // source carrying full parameters)
        this.maybeUpdateTaskList(acc.toolName, block?.type === "toolCall" ? block.input : acc.rawInput);
        break;
      }
      default: break; // start/finish/error: control frames, not mapped
    }
  }

  private ensureOpen(assistantMessageId: string): void {
    if (this.stream && this.stream.assistantMessageId !== assistantMessageId) this.closeStream();
    if (!this.stream) {
      this.stream = { assistantMessageId, blocks: [], index: new Map(), acc: new Map(), toolByCallId: new Map(), implicit: {} };
      this.emit({
        type: "message_start",
        message: {
          role: "assistant",
          content: [],
          ...(this.opts.modelRef ? { model: this.opts.modelRef } : {}),
          provider: "zcode",
        },
      });
    }
  }

  /** Locates the block for delta/end frames: explicit partId → implicit pointer/toolCallId; auto-creates the block when missing (including *_start emission). */
  private locateBlock(kind: string, partId: string | null, p: JsonRecord): number | null {
    if (!this.stream) return null;
    if (partId) {
      const mapped = this.streamIndex(partId);
      if (mapped !== null) return mapped;
      return this.ensureBlock(kind.startsWith("text") ? "text" : kind.startsWith("reasoning") ? "reasoning" : "tool", partId, p);
    }
    if (kind.startsWith("tool")) {
      const callId = String(p.toolCallId ?? "");
      if (callId) {
        const hit = this.stream.toolByCallId.get(callId);
        if (hit !== undefined) return hit;
        return this.ensureBlock("tool", null, { ...p, toolCallId: callId });
      }
      const implicitTool = this.stream.implicit.tool;
      return implicitTool ?? this.ensureBlock("tool", null, p);
    }
    const isText = kind.startsWith("text");
    const implicit = isText ? this.stream.implicit.text : this.stream.implicit.reasoning;
    return implicit ?? this.ensureBlock(isText ? "text" : "reasoning", null, p);
  }

  /** Creates a new block (placeholder + acc seeding + implicit pointer/toolCallId registration + corresponding *_start emission). Returns null when partId is already mapped. */
  private ensureBlock(kind: "text" | "reasoning" | "tool", partId: string | null, p: JsonRecord): number | null {
    const s = this.stream!;
    if (partId && s.index.has(partId)) return null;
    const idx = s.blocks.length;
    s.blocks.push({ type: "text", text: "" }); // placeholder, overwritten right below
    if (partId) s.index.set(partId, idx);
    if (kind === "text") {
      s.blocks[idx] = { type: "text", text: "" };
      s.acc.set(idx, { kind: "text", text: "" });
      s.implicit.text = idx;
      this.emitDelta({ type: "text_start", contentIndex: idx });
    } else if (kind === "reasoning") {
      s.blocks[idx] = { type: "thinking", thinking: "" };
      s.acc.set(idx, { kind: "thinking", thinking: "" });
      s.implicit.reasoning = idx;
      this.emitDelta({ type: "thinking_start", contentIndex: idx });
    } else {
      const toolCallId = String(p.toolCallId ?? `call_${idx}`);
      const toolName = String(p.toolName ?? "tool");
      s.blocks[idx] = { type: "toolCall", toolCallId, toolName, input: {} };
      s.acc.set(idx, { kind: "tool", rawInput: "", toolCallId, toolName });
      s.toolByCallId.set(toolCallId, idx);
      s.implicit.tool = idx;
      this.toolNameByCallId.set(toolCallId, toolName);
      this.emitDelta({ type: "toolcall_start", contentIndex: idx, id: toolCallId, toolName });
    }
    return idx;
  }

  private streamIndex(partId: string): number | null {
    return this.stream?.index.get(partId) ?? null;
  }

  private emitDelta(assistantMessageEvent: JsonRecord): void {
    this.emit({ type: "message_update", assistantMessageEvent });
  }

  /** Closes the current streaming assistant message (message_end + final content blocks). */
  private closeStream(): void {
    const s = this.stream;
    if (!s) return;
    this.stream = null;
    // Final blocks take their values from acc (deltas accumulate in acc; blocks only define order/type)
    const content: StreamBlock[] = [];
    for (let i = 0; i < s.blocks.length; i++) {
      const block = s.blocks[i];
      const acc = s.acc.get(i);
      if (!block) continue;
      if (block.type === "text") content.push({ type: "text", text: acc?.kind === "text" ? acc.text : block.text });
      else if (block.type === "thinking") content.push({ type: "thinking", thinking: acc?.kind === "thinking" ? acc.thinking : block.thinking });
      else if (block.type === "toolCall") content.push({ ...block });
    }
    // Fully empty (no meaningful text/thinking/tool block) emits no empty bubble
    const meaningful = content.some((b) =>
      b.type === "toolCall"
      || (b.type === "thinking" && b.thinking.length > 0)
      || (b.type === "text" && b.text.length > 0));
    if (!meaningful) return;
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content,
        ...(this.opts.modelRef ? { model: this.opts.modelRef } : {}),
        provider: "zcode",
      },
    });
  }

  // ---- tool.updated: execution-surface events + tool result cards ----

  private onToolUpdated(p: JsonRecord): void {
    const kind = String(p.kind ?? "");
    const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
    const toolName = typeof p.toolName === "string" ? p.toolName : "";
    switch (kind) {
      case "scheduled":
      case "started": {
        if (!toolCallId || this.seenToolStarts.has(toolCallId)) break;
        this.seenToolStarts.add(toolCallId);
        if (toolName) this.toolNameByCallId.set(toolCallId, toolName);
        // TodoWrite family: input already carries the full task list (the real-device wire often strips input — see the tool_call frame fallback)
        this.maybeUpdateTaskList(toolName, p.input);
        // pi-native ordering: close the current streaming message segment before tool execution (the assistant message contains the toolCall block)
        this.closeStream();
        this.emit({ type: "tool_execution_start", toolCallId, toolName });
        break;
      }
      case "progress": {
        const text = toolProgressText(p);
        if (!text) break;
        this.emit({
          type: "tool_execution_update",
          toolCallId,
          toolName,
          partialResult: { content: [{ type: "text", text }] },
        });
        break;
      }
      case "result": {
        const result = (p.result ?? {}) as JsonRecord;
        // MCP todo_write/update_plan variants may carry the list in output (desktop CPt fallback path);
        // when the frame lacks toolName, reverse-lookup by callId (registered from streaming/tool frames)
        this.maybeUpdateTaskList(toolName || this.toolNameByCallId.get(toolCallId) || "", result.output, result.content);
        const output = typeof result.output === "string" && result.output
          ? result.output
          : typeof result.content === "string" ? result.content : "(工具执行完成，无文本输出)";
        this.emit({ type: "tool_execution_end", toolCallId });
        this.emit({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId,
            ...(toolName ? { toolName } : {}),
            content: [{ type: "text", text: output }],
            isError: false,
            timestamp: Date.now(),
          },
        });
        break;
      }
      case "error": {
        const err = (p.error ?? {}) as JsonRecord;
        this.emit({ type: "tool_execution_end", toolCallId });
        this.emit({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId,
            ...(toolName ? { toolName } : {}),
            content: [{ type: "text", text: String(err.message ?? "工具执行失败") }],
            isError: true,
            timestamp: Date.now(),
          },
        });
        break;
      }
      default: break; // batch/raw: not mapped
    }
  }
}

function parseJsonInput(raw: string): JsonRecord {
  const s = raw.trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as JsonRecord : { _raw: s };
  } catch {
    return { _raw: s };
  }
}

/**
 * Reverse-request questions → normalized event payload (defensive: invalid entries are skipped).
 * The question text is the answer addressing key (zcode-side ONi matches answers by input.questions[].question) and must be preserved verbatim.
 */
function normalizeQuestions(raw: unknown): Array<{
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ header?: string; question: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const q = item as JsonRecord;
    const question = typeof q.question === "string" ? q.question : "";
    if (!question) continue;
    const options: Array<{ label: string; description?: string }> = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (!o || typeof o !== "object") continue;
        const label = typeof (o as JsonRecord).label === "string" ? (o as JsonRecord).label as string : "";
        if (!label) continue;
        const description = typeof (o as JsonRecord).description === "string" ? (o as JsonRecord).description as string : undefined;
        options.push(description ? { label, description } : { label });
      }
    }
    out.push({
      question,
      ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out;
}

/**
 * User answer → zcode answer frame (runtime 0.16.5 reverse-engineered contract; measured semantics in the file-header comment):
 * - plan_approval: approve = accept+answer:"approve"; with feedback = accept+answer:"<feedback>" (zcode normalizes to deny+reason, agent keeps refining); direct rejection = decline.
 * - ask_user: accept+answers (key = question text, value = label or label[]); the frontend "additional notes" text goes through
 *   answer.message → annotations (each answered question gets {notes} — free-text annotation per the zcode contract,
 *   schema: annotations: Record<question text,{notes?}>, returned to the model with the tool result); rejection = decline.
 * - generic: accept with empty content / decline.
 */
function buildUserInputAnswer(kind: PendingInteraction["kind"], answer: InteractionAnswerInput): JsonRecord {
  if (answer.action !== "accept") {
    return { action: "decline", ...(answer.message ? { reason: answer.message } : {}) };
  }
  if (kind === "plan_approval") {
    return { action: "accept", content: { answer: answer.message?.trim() || PLAN_APPROVE_ANSWER } };
  }
  if (kind === "ask_user" && answer.answers) {
    const note = answer.message?.trim();
    const annotations = note
      ? Object.fromEntries(Object.keys(answer.answers).map((q) => [q, { notes: note }]))
      : undefined;
    return { action: "accept", content: { answers: answer.answers, ...(annotations ? { annotations } : {}) } };
  }
  return { action: "accept", content: {} };
}

function toolProgressText(p: JsonRecord): string {
  const stdoutTail = typeof p.stdoutTail === "string" ? p.stdoutTail.trim() : "";
  if (stdoutTail) return stdoutTail.split("\n").pop()?.slice(0, 400) || stdoutTail.slice(-400);
  const stderrTail = typeof p.stderrTail === "string" ? p.stderrTail.trim() : "";
  if (stderrTail) return stderrTail.split("\n").pop()?.slice(0, 400) || stderrTail.slice(-400);
  const elapsed = num(p.elapsedMs);
  if (elapsed !== undefined) return `运行中 ${elapsed >= 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${Math.round(elapsed)}ms`}`;
  return "";
}
