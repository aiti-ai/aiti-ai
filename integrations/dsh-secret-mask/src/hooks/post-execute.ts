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
import { redactDeep, registerExtractedSecrets, registerValueSecrets, sensitiveReadTargets } from "@aiti-ai/secret-mask-core";
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
      if (!st.enabled) return decision;

      // L1/L2: weak-value discovery from tool output / write arguments.
      const contentBlocks = (decision.content as ContentBlock[] | undefined) ?? (result.content as ContentBlock[]);
      const text = Array.isArray(contentBlocks)
        ? contentBlocks.filter(isTextBlock).map((b) => b.text).join("\n")
        : "";
      if (text) st.lastToolOutput = text.slice(0, 65_536);
      if (st.extract !== false) {
        let extracted = 0;
        if (text) extracted += registerExtractedSecrets(text, st.registry, st.salt).count;
        if ("value" in decision && decision.value !== undefined) {
          extracted += registerValueSecrets(decision.value, st.registry, st.salt).count;
        }
        const sensitive = sensitiveReadTargets(exec.name, exec.arguments);
        const dedicated = sensitive.find((x) => x.info.dedicated);
        const trimmed = text.trim();
        const policy = st.filePolicy ?? "learn";
        if (policy === "block" && sensitive.length > 0) {
          return {
            kind: "block",
            feedback: [{ type: "text", text: "dsh-secret-mask: sensitive file content withheld by policy (/secret files learn|off to allow)." }],
          };
        }
        if (policy === "learn" && dedicated && extracted === 0 && trimmed.length >= 6 && trimmed.length <= 8192) {
          const label = (dedicated.path.split(/[/\\]/).pop() ?? "FILE").toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 48) || "FILE";
          st.registry.registerAuto(trimmed, "file:secret", label, st.salt);
          return {
            kind: "block",
            feedback: [
              {
                type: "text",
                text: `dsh-secret-mask: sensitive file content withheld (${trimmed.length} bytes). The value is registered in this session — use its placeholder in tool arguments.`,
              },
            ],
          };
        }
      }
      if (st.registry.size === 0) return decision;

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
