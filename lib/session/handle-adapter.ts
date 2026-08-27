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
  /** Backend tag (provider type tail); undefined for local sessions. */
  readonly source: string;
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

  readonly source: string;

  constructor(handle: SessionHandle) {
    this.handle = handle;
    this.source = handle.source;
    this.lastModel = handle.getModel();

    this.unsubscribe = handle.subscribe((rawEvent) => {
      // 规范化合成事件 → pi 词汇表（前端流式渲染依赖精确形状，见 normalize 注释）
      const merged = this.normalize(rawEvent);
      const event = { ...rawEvent, ...merged } as Record<string, unknown>;
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
        const msg = event.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
        const finalText = typeof event.text === "string"
          ? event.text
          : msg?.content?.find((b) => b.type === "text")?.text;
        if (finalText !== undefined && this.partialActive) this.partialText = finalText;
        this.partialActive = false;
      }
      if (type === "agent_settled") this.partialActive = false;

      if (type === "model_select" && event.model) {
        this.lastModel = event.model as { id: string; provider: string };
      }

      for (const l of this.listeners) l(event as Parameters<Listener>[0]);
    });
  }

  /**
   * 把后端合成事件规范化为前端已理解的 pi 词汇表。返回需要覆盖的字段子集
   * （与原事件合并后下发）；已是 pi 原生形状的事件返回空合并。
   *
   * 关键契约（缺一即渲染失败）：
   *   - message_update 必须带 assistantMessageEvent{text_delta,contentIndex,delta}
   *     —— toClientAgentEvent 对缺失该字段的事件整条丢弃（流式不上屏）
   *   - message_end 必须带完整 message:{role,content} —— reducer 靠它追加最终消息
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

      case "get_tools": {
        cap("listTools");
        // 后端有 raw 命令通道（attach/socket）时直达，返回 bridge 的真实工具快照
        // （before_provider_request 捕获）；否则空数组（合法空态）——绝不 fail-loud。
        if (h.send) return h.send({ type: "get_tools" });
        return [] as unknown[];
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
