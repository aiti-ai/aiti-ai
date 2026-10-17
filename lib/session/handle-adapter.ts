/**
 * HandleSessionAdapter — makes any SessionHandle answer the command vocabulary
 * of AgentSessionWrapper.send() and the SSE surface (onEvent/isStreaming/
 * streamingMessage), so the EXISTING frontend chat flow (POST /api/agent/[id]
 * + GET /api/agent/[id]/events) drives provider sessions unmodified.
 *
 * This is the join that lets "new session with a non-local backend" reuse
 * 100% of pi-web's chat UI. Command coverage is capability-aware:
 *
 *   mapped   → prompt/steer/follow_up/abort/get_state/set_model/
 *              set_thinking_level/compact/set_session_name/fork/bash/
 *              abort_bash/get_commands/get_entries
 *   noop     → queue-management family (steering/follow-up queues are
 *              backend-owned; pi-spawn/attach queue inside their process)
 *   fail     → everything else, via UnsupportedCapabilityError (501-ready)
 *
 * Degradations vs local sessions (documented, intentional):
 *   - streamingMessage is a synthetic assistant message rebuilt from
 *     message_update deltas (survives SSE reconnect; not byte-identical to
 *     the SDK's live object).
 *   - `inner` SDK object does not exist → routes needing it (auto-name,
 *     context) fall back to file-based paths or degrade.
 */

import type { AgentMessage, SessionEntry } from "../types.ts";
import type { SessionHandle } from "./types.ts";
import { UnsupportedCapabilityError } from "./types.ts";
import { normalizeToolCalls } from "../normalize.ts";
import { entryToUiMessage } from "../session-reader.ts";

type WrapperCommand = Record<string, unknown>;

type Listener = (event: { type: string; [key: string]: unknown }) => void;

/** Minimal surface copied from AgentSessionWrapper / AgentEventStreamSession. */
/**
 * HandleModel ({id, provider}) → client contract ({provider, modelId}).
 * Routes returning an attach handle's getModel() as context.model must
 * normalize through this: passing it through as-is (shape is {id,…}) leaves
 * the frontend's value.modelId === undefined → the model selector's
 * current-name span renders empty (the root cause of a fully connected data
 * path with only the "display" leg broken).
 */
export function handleModelToClient(
  m?: { id: string; provider: string } | null,
): { provider: string; modelId: string } | null {
  return m && m.provider && m.id ? { provider: m.provider, modelId: m.id } : null;
}

/**
 * Normalize the shapes returned by provider backends' getMessages() (unwrap
 * history-replay messages).
 *
 * pi-family backends (pi/omp spawn, custom-agent delegation) return local
 * session entries ({type:"message", message:{…}}) — message is nested one
 * level deep; dispatching them as-is leaves the frontend without a top-level
 * role and the message area renders empty (the root cause of spawn sessions
 * "showing no AI replies"). Adapt per item shape:
 *   - pi entry (has type, no top-level role) → the same authoritative
 *     conversion as the file path, entryToUiMessage (unwraps message; converts
 *     compaction/branch_summary/custom_message to UI messages; drops
 *     non-message entries like model_change/session_info);
 *   - direct message shape ({role,…} of cursor/claude/codebuddy/echo) →
 *     normalized as-is.
 */
function normalizeHandleMessages(items: unknown[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.type === "string" && !("role" in rec)) {
      const msg = entryToUiMessage(rec as unknown as SessionEntry, {});
      if (msg) out.push(msg);
      continue;
    }
    out.push(normalizeToolCalls(rec as unknown as AgentMessage));
  }
  return out;
}

export interface WrappedSessionLike {
  readonly sessionId: string;
  readonly cwd: string;
  /** Backend tag (provider type tail); undefined for local sessions. */
  readonly source: string;
  isAlive(): boolean;
  isRunning(): boolean;
  /** Current backend model (attach/spawn reach the handle directly; local wrappers may omit it — callers use ?.()). Note the shape is {id, provider}; normalize via handleModelToClient before returning it as context.model. */
  getModel?(): { id: string; provider: string } | undefined;
  send(command: WrapperCommand): Promise<unknown>;
  /** Server-synthesized event injection point (optional): e.g. re-emitting a prompt_error that arrives late after a 202 acceptance (lib/agent-command-accept). */
  emit?(event: { type: string; [key: string]: unknown }): void;
  onEvent(listener: Listener): () => void;
  /** SSE reconnect snapshot (AgentEventStreamSession contract). */
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  waitUntilReady?(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Start time of the current turn (set on agent_start/turn_start, cleared on
 *  agent_settled) — stored per handle in a module-level WeakMap: the adapter is
 *  a per-request throwaway object (resolveAnySession/attachIfBridged news one
 *  up each time), so storing it on the instance would mean a new instance after
 *  the page reopens forever misses this turn's agent_start, get_state sends
 *  undefined, and the frontend timer resets to zero and restarts (verified
 *  2026-09-16). Handles live across requests in handle-store; the WeakMap
 *  shares that lifetime, so record/clear by any instance is globally visible. */
const runStartedAtByHandle = new WeakMap<SessionHandle, number>();

/**
 * "Needs an answer" event families (the session request card state machines on the
 * frontend). Backends replay outstanding ones synchronously from subscribe() — i.e.
 * inside this constructor, before the SSE route attaches its listener — so they are
 * buffered here and delivered to the first consumer instead of being dropped.
 * Their *_expired counterparts evict the buffered frame (a closed turn must not
 * resurrect a dead card).
 */
const PENDING_ASK_EVENTS = new Set(["interaction_request", "permission_request", "provider_runtime_headers_request"]);
const PENDING_ASK_EXPIRED = new Set(["interaction_expired", "permission_expired", "provider_headers_expired"]);
/** Same requestId re-replayed overwrites; a cap keeps a listener-less adapter bounded. */
const PENDING_ASK_CAP = 16;

export class HandleSessionAdapter implements WrappedSessionLike {
  readonly handle: SessionHandle;

  private listeners = new Set<Listener>();
  private unsubscribe: () => void;
  private _isStreaming = false;
  private partialText = "";
  private partialActive = false;
  private lastModel: { id: string; provider: string } | undefined;
  private pendingAsks: unknown[] = [];

  readonly source: string;

  constructor(handle: SessionHandle) {
    this.handle = handle;
    this.source = handle.source;
    this.lastModel = handle.getModel();

    this.unsubscribe = handle.subscribe((rawEvent) => {
      this.dispatch(rawEvent as Record<string, unknown>);
    });
  }

  /** Server-synthesized event injection point: runs through exactly the same normalization/streaming-state/dispatch pipeline as backend events. */
  emit(event: { type: string; [key: string]: unknown }): void {
    this.dispatch({ ...event });
  }

  private dispatch(rawEvent: Record<string, unknown>): void {
    // Reverse-RPC frames (bridge tool-call forwarding from the TUI) are not
    // events — old handles would emit them into the stream as events, making the
    // frontend render an "unknown error"; double defense here: regardless of
    // handle version, this type is always dropped at the adapter (the real
    // consumer is AttachSessionHandle.handleAitiBridgeReq at the socket layer)
    if (rawEvent.type === "aiti_bridge_req") return;
    // Normalize synthesized events → the local event vocabulary (the frontend's
    // streaming rendering depends on exact shapes; see the normalize comment)
    const merged = this.normalize(rawEvent);
    const event = { ...rawEvent, ...merged } as Record<string, unknown>;
    const type = String(event.type ?? "");
    // Track streaming state for the SSE surface
    if (type === "agent_start" || type === "turn_start") {
      this._isStreaming = true;
      // ??= semantics: replayed/duplicate agent_start does not reset to zero;
      // settled already cleared it, so the next turn naturally starts a new point
      if (!runStartedAtByHandle.has(this.handle)) runStartedAtByHandle.set(this.handle, Date.now());
    }
    if (type === "agent_settled") runStartedAtByHandle.delete(this.handle);
    if (type === "agent_settled" || type === "agent_end") this._isStreaming = false;

    // Rebuild a partial assistant message from deltas (snapshot source).
    if (type === "message_start" && (event.role ?? "assistant") === "assistant") {
      this.partialText = "";
      this.partialActive = true;
    }
    if (type === "message_update" && typeof event.delta === "string") {
      this.partialText += event.delta;
    }
    if (type === "message_end") {
      const msg = event.message as { content?: Array<{ type?: string; text?: string }> | string } | undefined;
      // content may be a string (a valid UserMessage shape, e.g. the user bubble
      // of a backend steer/follow-up turn) — only arrays can be searched with find
      const finalText = typeof event.text === "string"
        ? event.text
        : Array.isArray(msg?.content)
          ? msg.content.find((b) => b.type === "text")?.text
          : typeof msg?.content === "string"
            ? msg.content
            : undefined;
      if (finalText !== undefined && this.partialActive) this.partialText = finalText;
      this.partialActive = false;
    }
    if (type === "agent_settled") this.partialActive = false;

    if (type === "model_select" && event.model) {
      this.lastModel = event.model as { id: string; provider: string };
    }

    if (this.listeners.size === 0) {
      this.bufferAsk(event, type);
      return;
    }
    for (const l of this.listeners) l(event as Parameters<Listener>[0]);
  }

  /**
   * No consumer attached yet (adapter construction replays the backend's outstanding
   * asks; a dropped SSE connection leaves the adapter listener-less too): hold the ask
   * frames so the next onEvent gets them, and evict the ones an expiry already closed.
   */
  private bufferAsk(event: Record<string, unknown>, type: string): void {
    const requestId = typeof event.requestId === "string" ? event.requestId : "";
    if (!requestId) return;
    const kept = this.pendingAsks.filter((e) => (e as { requestId?: string }).requestId !== requestId);
    if (PENDING_ASK_EXPIRED.has(type)) {
      this.pendingAsks = kept;
      return;
    }
    if (!PENDING_ASK_EVENTS.has(type)) return;
    kept.push(event);
    this.pendingAsks = kept.slice(-PENDING_ASK_CAP);
  }

  /** Current backend model (attach/spawn etc. read the handle directly; locally same as lastModel). */
  getModel(): { id: string; provider: string } | undefined {
    return this.handle.getModel() ?? this.lastModel;
  }

  /**
   * Normalize backend-synthesized events into the event vocabulary the frontend
   * already understands. Returns the subset of fields to override (merged with
   * the original event before dispatch); events already in native shape return
   * an empty merge.
   *
   * Key contract (missing either breaks rendering):
   *   - message_update must carry assistantMessageEvent{text_delta,contentIndex,delta}
   *     — toClientAgentEvent drops entire events lacking it (streaming never
   *     reaches the screen)
   *   - message_end must carry the full message:{role,content} — the reducer
   *     relies on it to append the final message
   */
  private normalize(raw: Record<string, unknown>): Partial<Record<string, unknown>> & { type?: string } {
    const type = String(raw.type ?? "");

    if (type === "message_update" && typeof raw.delta === "string" && raw.assistantMessageEvent === undefined) {
      return { type: raw.type as string, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: raw.delta } };
    }

    if (type === "message_end" && raw.message === undefined) {
      const text = typeof raw.text === "string" ? raw.text : this.partialText;
      return {
        type: raw.type as string,
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
          ...(this.lastModel ? { model: this.lastModel.id, provider: this.lastModel.provider } : {}),
        },
      };
    }

    return {};
  }

  // ---- AgentEventStreamSession surface --------------------------------------

  get isStreaming(): boolean {
    return this._isStreaming || this.handle.isRunning();
  }

  get streamingMessage(): unknown {
    if (!this.partialText) return undefined;
    return {
      role: "assistant",
      content: [{ type: "text", text: this.partialText }],
      stopReason: undefined,
    };
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.pendingAsks.length) {
      const buffered = this.pendingAsks;
      this.pendingAsks = [];
      for (const event of buffered) {
        try {
          listener(event as Parameters<Listener>[0]);
        } catch { /* one failing consumer must not swallow the rest of the backlog */ }
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- basics -----------------------------------------------------------------

  get sessionId(): string {
    return this.handle.id;
  }

  get cwd(): string {
    return (this.handle as { cwd?: string }).cwd ?? "";
  }

  isAlive(): boolean {
    return this.handle.alive();
  }

  isRunning(): boolean {
    return this.handle.isRunning();
  }

  async waitUntilReady(): Promise<void> {
    /* handles are addressable immediately */
  }

  async shutdown(): Promise<void> {
    this.unsubscribe();
    await this.handle.dispose();
  }

  private fail(command: string, capability?: string): never {
    throw new UnsupportedCapabilityError(capability ?? command, this.handle.source);
  }

  // ---- command mapping ----------------------------------------------------------

  async send(command: WrapperCommand): Promise<unknown> {
    const h = this.handle;
    const type = String(command.type ?? "");
    const cap = <K extends keyof typeof h.capabilities>(k: K) => {
      if (!h.capabilities[k]) this.fail(type, String(k));
    };

    switch (type) {
      case "prompt":
        await h.prompt(String(command.message ?? ""), {
          ...(Array.isArray(command.images) ? { images: command.images as never[] } : {}),
          ...(Array.isArray(command.files) ? { files: command.files as never[] } : {}),
          ...(command.streamingBehavior === "steer" || command.streamingBehavior === "followUp"
            ? { streamingBehavior: command.streamingBehavior }
            : {}),
        });
        return null;

      case "steer":
        cap("steer");
        await h.steer!(String(command.message ?? ""));
        return null;

      case "follow_up":
        cap("followUp");
        await h.followUp!(String(command.message ?? ""));
        return null;

      case "abort":
        await h.abort();
        return null;

      case "get_state": {
        return {
          sessionId: h.id,
          sessionFile: undefined,
          isStreaming: this.isStreaming,
          // Authoritative busy field (aligned with the handle view of
          // /api/agent/running): the handle's own busy flag, plus the adapter
          // having observed agent_start from the event stream (tolerates the
          // handle flag lagging behind).
          isRunning: this.isRunning() || this._isStreaming,
          isPromptRunning: this._isStreaming,
          // Timer start of the current turn (lets the frontend resume after a
          // page reload; undefined when idle or no agent_start was seen)
          runStartedAt: runStartedAtByHandle.get(h),
          isBashRunning: false,
          isCompacting: false,
          autoCompactionEnabled: false,
          autoRetryEnabled: false,
          model: (h.getModel() ?? this.lastModel)
            ? { ...(h.getModel() ?? this.lastModel)! }
            : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          queuedMessages: h.queueManage
            ? await h.queueManage({ action: "list" })
            : { steering: [], followUp: [] },
          // Task list snapshot (the same-source authoritative view behind
          // task_update events: re-seeded via get_state after a page refresh)
          tasks: h.taskList ? (await h.taskList()).todos : [],
          systemPrompt: "",
          thinkingLevel: "off",
          // Context usage (presence-based: project it whenever getContextUsage
          // exists, without relying on capability booleans — ACP/codebuddy/omp
          // implemented it long ago but it was never read, which is why the
          // ctx-meter/bottom-bar chip stayed empty). The frontend's
          // useAgentSession treats undefined at each update point as "not
          // provided this time" and null as "confirmed no data".
          contextUsage: h.getContextUsage?.() ?? null,
        };
      }

      case "set_model": {
        cap("setModel");
        const ok = await h.setModel!({
          provider: String(command.provider ?? ""),
          id: String(command.modelId ?? ""),
        });
        return ok ? { provider: command.provider, id: command.modelId } : null;
      }

      case "set_thinking_level":
        cap("setThinkingLevel");
        h.setThinkingLevel!(String(command.level ?? "off"));
        return null;

      case "compact":
        cap("compact");
        return h.compact!(
          typeof command.customInstructions === "string" ? command.customInstructions : undefined,
        );

      case "set_session_name":
        cap("renameSession");
        h.setSessionName!(String(command.name ?? ""));
        return null;

      case "fork": {
        cap("fork");
        // opts.reset: the external backend's "edit from here" semantics (after
        // fork the handle rebinds to the child session and continues in place;
        // zcode-specific); default = plain fork (the message "branch" button,
        // current session untouched).
        const r = await h.fork!(String(command.entryId ?? ""), { reset: command.reset === true });
        return { text: undefined, cancelled: r.cancelled, newSessionId: r.newSessionFile };
      }

      case "bash": {
        cap("executeBash");
        return h.executeBash!(String(command.command ?? ""));
      }

      case "abort_bash":
        return null; // bash runs synchronously through handles

      case "get_commands": {
        if (!h.getCommands) return { commands: [] };
        const commands = await h.getCommands();
        return {
          commands: commands.map((c) => ({
            name: c.name,
            description: c.description,
            source: c.source,
          })),
        };
      }

      case "get_tools": {
        // When the backend has a raw command channel (attach/socket), go direct
        // and return the bridge's real tool snapshot (captured via
        // before_provider_request); otherwise an empty array (a legitimate empty
        // state) — never fail-loud.
        // Note: this used to throw via cap("listTools") first, so backends
        // declaring listTools:false (cursor/codex/echo etc.) logged console.error
        // "Failed to load tools: AgentCommandError" on every chat page load
        // (contradicting this comment; fixed).
        if (h.send) return h.send({ type: "get_tools" });
        return [] as unknown[];
      }

      case "get_messages":
      case "get_entries": {
        if (!h.getMessages) this.fail(type, "getMessages");
        const entries = await h.getMessages!();
        // Shape-adaptive: unwrap pi entries (provider backends) or normalize raw
        // SDK shapes (attach family), aligned with the file-read channel
        // (session-reader already normalizes) before dispatch — see
        // normalizeHandleMessages
        return { entries: normalizeHandleMessages(entries as unknown[]), leafId: undefined };
      }

      case "get_last_assistant_text":
        return { text: undefined };

      case "permission_response": {
        if (!h.respondPermission) this.fail("permission_response", "respondPermission");
        const ok = await h.respondPermission(
          String(command.requestId ?? ""),
          {
            behavior: command.behavior === "allow" ? "allow" : "deny",
            ...(command.updatedInput ? { updatedInput: command.updatedInput as Record<string, unknown> } : {}),
            ...(typeof command.message === "string" ? { message: command.message } : {}),
            ...(typeof command.optionId === "string" && command.optionId ? { optionId: command.optionId } : {}),
          },
        );
        return { success: ok };
      }

      case "respond_interaction": {
        if (!h.respondInteraction) this.fail("respond_interaction", "respondInteraction");
        const ok = await h.respondInteraction(
          String(command.requestId ?? ""),
          {
            action: command.action === "accept" ? "accept" : "decline",
            ...(command.answers && typeof command.answers === "object"
              ? { answers: command.answers as Record<string, string | string[]> }
              : {}),
            ...(typeof command.message === "string" ? { message: command.message } : {}),
          },
        );
        return { success: ok };
      }

      case "respond_provider_headers": {
        if (!h.respondProviderHeaders) this.fail("respond_provider_headers", "respondProviderHeaders");
        const ok = await h.respondProviderHeaders(
          String(command.requestId ?? ""),
          {
            ...(typeof command.captchaVerifyParam === "string" && command.captchaVerifyParam
              ? { captchaVerifyParam: command.captchaVerifyParam }
              : {}),
            ...(typeof command.region === "string" && command.region ? { region: command.region } : {}),
            ...(typeof command.error === "string" && command.error ? { error: command.error } : {}),
            ...(command.cancel === true ? { cancel: true } : {}),
          },
        );
        return { success: ok };
      }

      case "get_usage": {
        if (!h.getUsage) this.fail("get_usage", "getUsage");
        return { usage: (await h.getUsage()) ?? null };
      }

      case "list_models": {
        if (!h.getAvailableModels) this.fail("list_models", "listModels");
        return { models: await h.getAvailableModels() };
      }

      case "set_permission_mode": {
        if (!h.setPermissionMode) this.fail("set_permission_mode", "setPermissionMode");
        const ok = await h.setPermissionMode(String(command.mode ?? ""));
        return { success: ok };
      }

      case "get_session_stats": {
        // Real external-backend figures (previously hardcoded to all zeros):
        // getUsageTotals (accumulated per turn while the handle process lives,
        // reset on restart) + contextUsage (the context % row of the stats
        // panel — the only viewing entry point on mobile). Handles that do not
        // implement them keep all zeros (behavior unchanged).
        const totals = h.getUsageTotals?.() ?? undefined;
        const cu = h.getContextUsage?.() ?? undefined;
        const tokens = {
          input: totals?.inputTokens ?? 0,
          output: totals?.outputTokens ?? 0,
          cacheRead: totals?.cacheReadTokens ?? 0,
          cacheWrite: totals?.cacheWriteTokens ?? 0,
          total:
            (totals?.inputTokens ?? 0) +
            (totals?.outputTokens ?? 0) +
            (totals?.cacheReadTokens ?? 0) +
            (totals?.cacheWriteTokens ?? 0),
        };
        return {
          sessionFile: undefined,
          sessionId: h.id,
          userMessages: 0,
          assistantMessages: totals?.turns ?? 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: totals?.turns ?? 0,
          tokens,
          cost: totals?.costUsd ?? 0,
          ...(cu ? { contextUsage: cu } : {}),
        };
      }

      // ---- backend-owned queues -------------------------------------------------
      // The remote process owns its steering/follow-up queues. Handles that
      // implement queueManage (the queue-keeper adaptation) get full CRUD
      // forwarded; others keep the legacy no-op (backward compatible).
      case "clear_queue":
        if (h.queueManage) return await h.queueManage({ action: "clear" });
        return null;
      case "move_queue":
        if (h.queueManage) {
          return await h.queueManage({ action: "move", kind: command.kind as "steer" | "followUp", from: Number(command.fromIndex), to: Number(command.toIndex) });
        }
        return null;
      case "convert_queue_item":
        if (h.queueManage) {
          return await h.queueManage({ action: "convert", kind: command.kind as "steer" | "followUp", index: Number(command.index), targetKind: command.targetKind as "steer" | "followUp" });
        }
        return null;
      case "recall_queue_item":
        if (h.queueManage) {
          return await h.queueManage({ action: "recall", kind: command.kind as "steer" | "followUp", index: Number(command.index) });
        }
        return null;
      case "requeue_at":
        if (h.queueManage) {
          return await h.queueManage({ action: "requeue", kind: command.kind as "steer" | "followUp", index: Number(command.index), text: String(command.text ?? "") });
        }
        return null;
      case "remove_queue_item":
        if (h.queueManage) {
          const r = await h.queueManage({ action: "remove", kind: command.kind as "steer" | "followUp", index: Number(command.index) });
          // The frontend's removeQueuedMessage consumes removed (QueueTrashItem
          // shape) to refresh the undo bar; trash persistence is a local
          // mechanism (wrapper), the backend only returns the immediate-effect
          // entry
          const removedEntry = r.entry ?? undefined;
          return {
            ...r,
            ...(removedEntry
              ? {
                  removed: {
                    id: `bq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    kind: String(command.kind ?? "followUp"),
                    text: removedEntry.text,
                    hasImages: false,
                    queuedAt: Date.now(),
                  },
                }
              : {}),
          };
        }
        return null;
      case "continue_queue":
      case "trash_direct_add":
      case "restore_trash_item":
      case "purge_trash":
      case "resolve_recovery":
      case "export_queue":
      case "import_queue":
      case "stage_recovery":
      case "set_auto_compaction":
      case "set_auto_retry":
      case "abort_compaction":
      case "extension_ui_response":
      case "extension_ui_input":
        return null;

      default:
        this.fail(type);
    }
  }
}
