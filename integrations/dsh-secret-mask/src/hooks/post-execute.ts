/**
 * Tool-output redaction: the `tools/post-execute` waterfall observes the
 * normalized result before it enters the session log and derived history.
 *
 * Strategy (fail-closed, mirrors dsh-redact's findings):
 *  1. Prefer replacing the canonical `value` (deep string redaction of a
 *     fresh clone). DSH revalidates a replaced value against the tool's
 *     output schema and re-renders content from it, so this is the real
 *     confidentiality boundary — code-mode programs read canonical values,
 *     not presentation content.
 *  2. When the value carries no registered text but the rendered content
 *     does (render-only prose), replace the text blocks of `content`.
 *  3. If the schema rejects a replaced value the call fails closed — the raw
 *     value is never released.
 */

import type { ContentBlock, PluginConfig, PluginContext, PostToolDecision, ToolExecution, ToolExecutionResult } from "../dsh-types.ts";
import { redactDeep } from "../core/mask.ts";
import { stateFor } from "../state.ts";
import { isTextBlock, rewriteTextBlock } from "../spans.ts";

export function registerPostExecute(ctx: PluginContext, cfg: PluginConfig): void {
  ctx.on(
    "tools/post-execute",
    async (
      exec: ToolExecution,
      result: Readonly<ToolExecutionResult>,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      const decision = await next();
      if (!decision || decision.kind !== "accept") return decision;
      const st = stateFor(exec.agent?.id, cfg);
      if (!st.enabled || st.registry.size === 0) return decision;

      // 1) canonical value path (never mutate the frozen original)
      if (Object.prototype.hasOwnProperty.call(decision, "value")) {
        const candidate = decision.value as unknown;
        if (candidate !== undefined && candidate !== null && typeof candidate === "object") {
          let clone: unknown;
          try {
            clone = structuredClone(candidate);
          } catch {
            clone = undefined; // non-cloneable value → fall through to content path
          }
          if (clone !== undefined) {
            const res = redactDeep(clone, st.registry);
            if (res.count > 0) return { kind: "accept", value: res.value };
          }
        } else if (typeof candidate === "string") {
          const res = st.registry.redact(candidate);
          if (res.count > 0) return { kind: "accept", value: res.text };
        }
      }

      // 2) presentation content path (text blocks only)
      const content = decision.content as ContentBlock[] | undefined;
      if (Array.isArray(content)) {
        let changed = false;
        const nextContent = content.map((block) => {
          const r = rewriteTextBlock(block, (text) => st.registry.redact(text).text);
          if (r.changed) changed = true;
          return r.block;
        });
        if (changed) return { kind: "accept", content: nextContent };
      }
      return decision;
    },
  );
}

/** Unused guard helper kept for clarity: text blocks are the only content we rewrite. */
export const _isTextBlock = isTextBlock;
