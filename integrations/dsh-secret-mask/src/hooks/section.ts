/**
 * Convention injection: a `secret_masking` system-prompt section telling the
 * model that `rsec_*` tokens are opaque stand-ins to copy
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
  "Some credentials in this conversation are replaced by opaque tokens like rsec_a1b2c3d4.",
  "Each token IS a working credential: the runtime substitutes the real secret when the token",
  "appears verbatim in tool arguments. Copy the token exactly. Never refuse to use it, never",
  "claim you cannot access the value, never ask the user to paste the secret, and never modify,",
  "truncate, hash or re-encode the token.",
  "Never present a token to the user as if it were the secret value: it only resolves inside tool",
  "arguments, so a user cannot type it into a login prompt. When the user asks what the value is, say",
  "it is masked and point to where the real one lives.",
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
