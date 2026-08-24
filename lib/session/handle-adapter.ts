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

import type { SessionHandle } from "./types.ts";
import { UnsupportedCapabilityError } from "./types.ts";

type WrapperCommand = Record<string, unknown>;

type Listener = (event: { type: string; [key: string]: unknown }) => void;

/** Minimal surface copied from AgentSessionWrapper / AgentEventStreamSession. */
export interface WrappedSessionLike {
  readonly sessionId: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  send(command: WrapperCommand): Promise<unknown>;
  onEvent(listener: Listener): () => void;
  /** SSE reconnect snapshot (AgentEventStreamSession contract). */
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  waitUntilReady?(): Promise<void>;
  shutdown(): Promise<void>;
}

export class HandleSessionAdapter implements WrappedSessionLike {
  readonly handle: SessionHandle;

  private listeners = new Set<Listener>();
  private unsubscribe: () => void;
  private _isStreaming = false;
  private partialText = "";
  private partialActive = false;
  private lastModel: { id: string; provider: string } | undefined;

  constructor(handle: SessionHandle) {
    this.handle = handle;
    this.lastModel = handle.getModel();

    this.unsubscribe = handle.subscribe((event) => {
      const type = String(event.type ?? "");
      // Track streaming state for the SSE surface
      if (type === "agent_start" || type === "turn_start") this._isStreaming = true;
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
        const finalText = typeof event.text === "string" ? event.text : undefined;
        if (finalText !== undefined && this.partialActive) this.partialText = finalText;
        this.partialActive = false;
      }
      if (type === "agent_settled") this.partialActive = false;

      if (type === "model_select" && event.model) {
        this.lastModel = event.model as { id: string; provider: string };
      }

      for (const l of this.listeners) l(event);
    });
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
          isPromptRunning: this._isStreaming,
          isBashRunning: false,
          isCompacting: false,
          autoCompactionEnabled: false,
          autoRetryEnabled: false,
          model: (h.getModel() ?? this.lastModel)
            ? { ...(h.getModel() ?? this.lastModel)! }
            : undefined,
          messageCount: 0,
          pendingMessageCount: 0,
          queuedMessages: { steering: [], followUp: [] },
          systemPrompt: "",
          thinkingLevel: "off",
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
        const r = await h.fork!(String(command.entryId ?? ""));
        return { text: undefined, cancelled: r.cancelled };
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

      case "get_messages":
      case "get_entries": {
        if (!h.getMessages) this.fail(type, "getMessages");
        const entries = await h.getMessages!();
        return { entries, leafId: undefined };
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
          },
        );
        return { success: ok };
      }

      case "get_usage": {
        if (!h.getUsage) this.fail("get_usage", "getUsage");
        return { usage: h.getUsage() ?? null };
      }

      case "list_models": {
        if (!h.getAvailableModels) this.fail("list_models", "listModels");
        return { models: await h.getAvailableModels() };
      }

      case "get_session_stats":
        return {
          sessionFile: undefined,
          sessionId: h.id,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0,
        };

      // ---- backend-owned queues: acknowledge without action -------------------
      // The remote process owns its steering/follow-up queues; the web-side
      // queue UI features (recovery/trash/reorder) don't apply.
      case "continue_queue":
      case "clear_queue":
      case "move_queue":
      case "convert_queue_item":
      case "recall_queue_item":
      case "requeue_at":
      case "remove_queue_item":
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
