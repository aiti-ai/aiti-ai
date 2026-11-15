/**
 * Proof layer: the `llm/stream` waterfall wraps every streaming model call —
 * loop conversation requests AND auxiliary calls (compaction summarization,
 * session titles; `purpose` distinguishes them). The GenerateOptions payload
 * is frozen and read-only, which is exactly the audit contract: this sees
 * what the provider receives, after every earlier hook, and never rewrites.
 *
 * Evidence lines go to ~/.dsh/secret-mask-audit.log (0600) and never contain
 * raw values — only label names. Any registered raw value found in the
 * outgoing payload raises an immediate `secret-mask LEAK` error log.
 */

import type { GenerateOptions, PluginConfig, PluginContext } from "../dsh-types.ts";
import { auditPayload, appendAuditLog } from "@aiti-ai/secret-mask-core";
import { stateFor } from "../state.ts";

export function registerAudit(ctx: PluginContext, cfg: PluginConfig): void {
  ctx.on("llm/stream", (options: GenerateOptions, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    const st = stateFor(options?.sessionId, cfg);
    if (st.enabled && st.audit && st.registry.size > 0) {
      const a = auditPayload({ system: options.system, messages: options.messages }, st.registry);
      const purpose = options.purpose ?? "conversation";
      st.lastAudit = `${a.leaks} leak(s), ${a.placeholders} placeholder(s)`;
      const err = appendAuditLog(
        {
          time: new Date().toISOString(),
          sessionId: options.sessionId ?? "",
          purpose,
          strings: a.strings,
          placeholders: a.placeholders,
          leaks: a.leaks,
          leakedLabels: a.leakedLabels,
        },
        cfg.auditPath || st.auditPath,
      );
      if (err) ctx.logger.warn("dsh-secret-mask: audit log write failed: " + err);
      if (a.leaks > 0) {
        ctx.logger.error(
          `secret-mask LEAK: ${a.leaks} registered value(s) found in the outgoing ${purpose} payload (${a.leakedLabels.join(", ")}) — check /secret audit show`,
        );
      }
    }
    return next();
  });
}
