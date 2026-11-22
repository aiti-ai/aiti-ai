/**
 * Tool-argument restore: DSH deliberately offers no input rewrite
 * (`tools/pre-execute` is allow/deny/ask only and arguments are frozen before
 * the pipeline), so the restore runs inside a **shadow tool**: at
 * `agent/session-start` we re-register the whitelisted write/execute tools in
 * the agent's scope with the same name, schema and presentation fields, and
 * an `execute` that restores placeholders into a deep clone of the arguments
 * before delegating to the original definition captured at wrap time.
 *
 * Scope semantics make this safe-ish and reversible:
 *  - agent-scope registration shadows the same-named global tool for that
 *    agent only and unwinds with the agent's scope (dsh-tools);
 *  - code-mode SDK bindings resolve the visible definition per scope, so the
 *    shadow (same name/schema) intercepts `run_code` sub-calls identically;
 *  - the model-visible call record still shows placeholders — only the
 *    executed arguments carry real values (same observable behaviour as pi's
 *    `tool_call` hook).
 *
 * Whitelist is intentionally narrow (bash / file-write family): a shadow
 * resurfaces a tool as a scope-local definition, which would bypass a
 * `ctx.tools.restrict` deny mask applied to the global; wrapping the minimum
 * set keeps that surface auditable. Restore failures never block the call.
 */

import type { AgentLike, PluginConfig, PluginContext, SessionStartPayload, ToolDefinition, ToolExecution } from "../dsh-types.ts";
import { guardReason, inspectToolTargets, registerExtractedSecrets, restoreDeep, unmountedInValue } from "@aiti-ai/secret-mask-core";
import { stateFor } from "../state.ts";

export const SHADOW_WHITELIST = ["bash", "write", "edit", "str_replace_editor"] as const;

export function registerShadowTools(ctx: PluginContext, cfg: PluginConfig): void {
  if (!cfg.restoreToolArgs) return;
  ctx.on("agent/session-start", (payload: SessionStartPayload) => {
    const agent = payload?.agent as AgentLike | undefined;
    const actx = agent?.ctx;
    if (!agent || !actx?.tools) return;
    for (const name of SHADOW_WHITELIST) {
      const orig = actx.tools.get(name); // resolves inside the agent scope; shadow not yet registered
      if (!orig) continue;
      const shadow: ToolDefinition = {
        ...orig,
        execute: async (args: unknown, exec: ToolExecution) => {
          const st = stateFor(agent.id, cfg);
          if (st.extract !== false) {
            for (const content of inspectToolTargets(name, args).contents) {
              registerExtractedSecrets(content, st.registry, st.salt);
            }
          }
          let restored = args;
          if (st.enabled && args !== null && typeof args === "object") {
            if (st.guard) {
              const missing = unmountedInValue(args, st.registry);
              if (missing.length > 0) throw new Error(guardReason(missing, { landing: st.landing }));
            }
            if (st.registry.size > 0) {
              try {
                restored = restoreDeep(structuredClone(args), st.registry).value;
              } catch {
                restored = args; // non-cloneable args: execute unchanged rather than block
              }
            }
          }
          return orig.execute(restored, exec);
        },
      };
      actx.tools.register(shadow);
    }
    ctx.logger.info(`dsh-secret-mask: shadow restore tools registered for agent ${agent.id} (${SHADOW_WHITELIST.join(", ")})`);
  });
}
