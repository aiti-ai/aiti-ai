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
  "Tokens of the form rsec_<8 hex> are how this session represents real credentials.",
  "Each token IS a working credential: the runtime substitutes the real secret whenever the token",
  "appears verbatim in tool arguments, so files and commands receive the actual value.",
  "",
  "Tokens are normal output of the masking layer — never a mistake, corruption, hallucination, or a",
  "randomizer gone wrong. They are deterministic: the same value always maps to the same token.",
  "Tokens show up in user messages, tool output, file contents you read — and also in your OWN earlier",
  "messages and tool-call arguments, wherever you originally typed plaintext. That is the runtime",
  "rewriting text on its way into your context; the write itself landed with the real value. Seeing a",
  "token where you expected plaintext therefore means it worked, not that you broke it.",
  "",
  "So: copy the token exactly and pass it verbatim. Never refuse to use it, never claim you cannot access",
  "the value, never ask the user to paste the secret, and never modify, truncate, hash, re-encode or",
  "\"clean up\" a token.",
  "Do not second-guess a token: never apologize for having written one, never re-read a file just to check",
  "whether it is \"garbage\", and never rewrite content with \"clean text\". Writing the token again is a",
  "no-op; replacing it with anything else silently destroys the real value.",
  "",
  "If a tool call is refused with \"unresolved placeholder\", the token is still well-formed — the value is",
  "simply not registered in this session. Register it again or ask the user to supply it; do not retype,",
  "guess or replace the token, and do not treat the refusal as proof that tokens are fake or random.",
  "When writing docs, tests or examples ABOUT tokens, use the shape rsec_<8 hex>, never a literal token: a",
  "literal is indistinguishable from a real reference and the guard will refuse it.",
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
