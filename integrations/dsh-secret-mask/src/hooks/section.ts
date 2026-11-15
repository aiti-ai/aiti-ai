/**
 * Convention injection: a `secret_masking` system-prompt section telling the
 * model that `[REDACTED:*]` placeholders are opaque stand-ins to copy
 * verbatim into tool arguments and never guess.
 *
 * The section text is a provider evaluated at every assembly, so the section
 * only renders for sessions that actually hold registered values (DSH has no
 * "add section later" API — a provider is the supported dynamic form). The
 * assemble scope is the agent itself (dsh-scope keys agent scopes by the
 * agent object), so the provider reads the agent id off it.
 */

import type { PluginConfig, PluginContext } from "../dsh-types.ts";
import { stateFor } from "../state.ts";

export const SECTION_KEY = "secret_masking";

export const SECTION_TEXT = [
  "Some credential values in this conversation are hidden behind placeholders like",
  "[REDACTED:alias] or [REDACTED:LABEL#ab12cd34]. Each placeholder stands for one real",
  "secret value that the user knows; it is restored automatically when passed verbatim in",
  "tool arguments. Rules: never guess, shorten, transform or invent the underlying value;",
  "copy the placeholder exactly as shown whenever you need to reference the credential",
  "(file edits, commands, config); do not ask the user to paste the value into chat.",
].join("\n");

export function registerSection(ctx: PluginContext, cfg: PluginConfig): void {
  ctx.systemPrompt.section({
    name: SECTION_KEY,
    order: 150, // tool guidance band (100–199) per the system-prompt order convention
    text: (context: { scope?: unknown }) => {
      const scope = context?.scope as { id?: string } | undefined;
      const st = stateFor(scope?.id, cfg);
      return st.enabled && st.registry.size > 0 ? SECTION_TEXT : "";
    },
  });
}
