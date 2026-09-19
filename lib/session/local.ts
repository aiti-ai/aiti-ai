/**
 * Local provider — pi-web's existing in-process session creation.
 *
 * Phase 1 keeps the actual AgentSession creation inside rpc-manager.ts (it has
 * deep integration: extension binding, queue mirroring, trust management).
 * This module adapts that world to the SessionHandle seam WITHOUT moving code:
 *
 *   - createLocalHandle(wrapper) wraps an existing AgentSessionWrapper into a
 *     SessionHandle view. rpc-manager continues to own wrapper lifecycle.
 *
 *   - The provider's createSession delegates to startRpcSession so new callers
 *     (future multi-agent UI) can create local sessions through the same
 *     registry-based path as attach/spawn.
 *
 * All capabilities are true — this is the reference implementation.
 */

import type { AgentSessionWrapper } from "../rpc-manager";
import { FULL_CAPABILITIES, guard } from "./types.ts";
import type {
  HandleBashResult,
  HandleCommandInfo,
  HandleEvent,
  HandleEventListener,
  HandleModel,
  PromptOptions,
  SessionHandle,
} from "./types.ts";

/**
 * Wrap an existing AgentSessionWrapper (from rpc-manager) into a SessionHandle.
 * Zero-copy view: all operations delegate; lifecycle stays with the wrapper.
 */
export function createLocalHandle(wrapper: AgentSessionWrapper): SessionHandle {
  const inner = () => wrapper.inner;

  const listeners = new Set<HandleEventListener>();
  // Bridge wrapper events → normalized handle events. The wrapper's event
  // objects already use frontend vocabulary, so pass-through is correct.
  const unsubscribe = wrapper.onEvent((event) => {
    for (const l of listeners) l(event as unknown as HandleEvent);
  });

  const modelOf = (): HandleModel | undefined => {
    const m = inner().model;
    return m ? { id: m.id, provider: m.provider } : undefined;
  };

  const handle: SessionHandle = {
    source: "local",
    capabilities: FULL_CAPABILITIES,

    get id() {
      return wrapper.sessionId;
    },

    async prompt(text: string, options?: PromptOptions): Promise<void> {
      await wrapper.send({
        type: "prompt",
        message: text,
        ...(options?.images ? { images: options.images } : {}),
        ...(options?.streamingBehavior
          ? { streamingBehavior: options.streamingBehavior }
          : {}),
      });
    },

    async abort(): Promise<void> {
      await wrapper.send({ type: "abort" });
    },

    subscribe(listener: HandleEventListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async dispose(): Promise<void> {
      unsubscribe();
      await wrapper.shutdown();
    },

    get cwd() {
      return wrapper.cwd;
    },

    alive: () => wrapper.isAlive(),
    isRunning: () => wrapper.isRunning(),
    getModel: modelOf,

    async steer(text: string): Promise<void> {
      guard(handle, "steer");
      await inner().steer(text);
    },

    async followUp(text: string): Promise<void> {
      guard(handle, "followUp");
      await inner().followUp(text);
    },

    async getMessages(): Promise<unknown[]> {
      guard(handle, "getMessages");
      return inner().sessionManager.getEntries();
    },

    getContextUsage() {
      guard(handle, "contextUsage");
      return inner().getContextUsage();
    },

    async setModel(model: HandleModel): Promise<boolean> {
      guard(handle, "setModel");
      const found = inner().modelRuntime.getModel(model.provider, model.id);
      if (!found) return false;
      await wrapper.send({ type: "set_model", ...model });
      return true;
    },

    setThinkingLevel(level: string): void {
      guard(handle, "setThinkingLevel");
      void wrapper.send({ type: "set_thinking", level }).catch(() => {});
    },

    async fork(entryId: string): Promise<{ cancelled: boolean; newSessionFile?: string }> {
      guard(handle, "fork");
      const data = (await wrapper.send({ type: "fork", entryId })) as {
        cancelled: boolean;
        newSessionFile?: string;
      } | null;
      return data ?? { cancelled: false };
    },

    setSessionName(name: string): void {
      guard(handle, "renameSession");
      void wrapper.send({ type: "set_session_name", name }).catch(() => {});
    },

    async compact(customInstructions?: string): Promise<unknown> {
      guard(handle, "compact");
      return wrapper.send({ type: "compact", customInstructions });
    },

    async executeBash(
      command: string,
      onChunk?: (chunk: string) => void,
    ): Promise<HandleBashResult> {
      guard(handle, "executeBash");
      const result = await inner().executeBash(command, onChunk);
      return result;
    },

    getAllTools(): Promise<Array<{ name: string; description: string }>> {
      guard(handle, "listTools");
      return Promise.resolve(
        inner()
          .getAllTools()
          .map((t) => ({ name: t.name, description: t.description })),
      );
    },

    setActiveTools(names: string[]): void {
      guard(handle, "setActiveTools");
      inner().setActiveToolsByName(names);
    },

    async navigateTree(
      targetId: string,
      options?: { summarize?: boolean },
    ): Promise<{ cancelled: boolean }> {
      guard(handle, "navigateTree");
      // TODO(branch-model-sync): this path reaches AgentSession directly, bypassing the
      // wrapper's navigate_tree backfill (syncSessionSettingsAfterBranch). No consumer
      // today; if one is wired up later, the backfill must be synced here, otherwise
      // the new chain's display may fall back to the old model.
      const result = await inner().navigateTree(targetId, options);
      return { cancelled: result.cancelled };
    },

    async deleteSession(): Promise<void> {
      guard(handle, "deleteSession");
      await wrapper.shutdown();
    },
  };

  return handle;
}
