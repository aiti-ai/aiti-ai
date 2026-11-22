/**
 * dsh-secret-mask — session-level secret redaction for DSH (DeepSeek Harness).
 *
 * Values the user pastes into prompts are replaced with stable placeholders
 * like `[REDACTED:github-token]` before a step enters the model
 * (`agent/pre-step`); placeholders the model echoes back inside whitelisted
 * tool arguments are restored to the real values inside shadow tool wrappers
 * before execution; registered values are redacted from tool results before
 * they enter history (`tools/post-execute`, canonical value first); and an
 * opt-in audit scans the final outgoing payload at `llm/stream` (conversation
 * plus compaction/title calls) appending leak-proof evidence to
 * ~/.dsh/secret-mask-audit.log.
 *
 * Detection core is ported verbatim from @aiti-ai/pi-secret-mask — same
 * rules, entropy thresholds, placeholder format and restore semantics.
 *
 * DSH differences from pi (documented in README):
 *  - one process hosts many sessions → per-agent state keyed by session id,
 *    dropped at `agent/disposed`;
 *  - pre-step replacement is durable: the session log stores placeholders;
 *  - `/secret add` uses recordInput:false so the value never lands in the log.
 */

import z from "@deepseek-ai/schemastery";
import type { Ctx, PluginConfig } from "./dsh-types.ts";
import { dropSession } from "./state.ts";
import { registerPreStep } from "./hooks/pre-step.ts";
import { registerSection } from "./hooks/section.ts";
import { registerPostExecute } from "./hooks/post-execute.ts";
import { registerShadowTools } from "./hooks/shadow-tools.ts";
import { registerAudit } from "./hooks/audit.ts";
import { registerSecretCommand } from "./hooks/commands.ts";

export const name = "dsh-secret-mask";
export const inject = ["tools", "commands", "systemPrompt"];

/** Plugin config (schemastery; misconfiguration fails loud at load). */
export interface Config {
  /** Master switch for all redaction/restore behaviour (default true). */
  enabled?: boolean
  /** Auto-detect secret-shaped values in user-authored text (default true). */
  autoDetect?: boolean
  /** Restore placeholders inside whitelisted tool arguments (shadow tools; default true). */
  restoreToolArgs?: boolean
  /** Start sessions with the per-send wire-payload audit ON (default false). */
  audit?: boolean
  /** Persistence bucket key (workspace root); defaults to the process cwd. */
  workspaceDir?: string
  /** Audit evidence file override (default ~/.dsh/secret-mask-audit.log). */
  auditPath?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  autoDetect: z.boolean().default(true),
  restoreToolArgs: z.boolean().default(true),
  audit: z.boolean().default(false),
  workspaceDir: z.string().default(""),
  auditPath: z.string().default(""),
});

export function apply(ctx: Ctx, config: Config): void {
  const cfg: PluginConfig = {
    enabled: config.enabled ?? true,
    autoDetect: config.autoDetect ?? true,
    restoreToolArgs: config.restoreToolArgs ?? true,
    audit: config.audit ?? false,
    workspaceDir: config.workspaceDir || process.cwd(),
    auditPath: config.auditPath || undefined,
  };

  registerPreStep(ctx, cfg);
  registerSection(ctx, cfg);
  registerPostExecute(ctx, cfg);
  registerShadowTools(ctx, cfg);
  registerAudit(ctx, cfg);
  registerSecretCommand(ctx, cfg);

  // Session lifecycle: value registries are per-agent memory; drop the key so
  // secrets never outlive their session.
  ctx.on("agent/disposed", (payload: { agent?: { id?: string } }) => {
    dropSession(payload?.agent?.id);
  });

  ctx.logger.info("dsh-secret-mask: hooked (pre-step redaction, secret_masking section, post-execute redaction, shadow restore, llm/stream audit, /secret command)");
}
