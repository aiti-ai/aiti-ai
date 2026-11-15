/**
 * Send-boundary redaction: the `agent/pre-step` waterfall receives the exact
 * batch of user messages claimed for the proposed step (followup, steering
 * and injected context all arrive through this claim), and its enter-branch
 * messages are the durable request material — so redacting here covers
 * everything the model is about to see from the user side, and the
 * placeholders persist in the session log (a deliberate DSH difference from
 * pi, where the transcript keeps the original text).
 */

import type { PluginConfig, PluginContext, PreStepDecision, PreStepPayload } from "../dsh-types.ts";
import { stateFor } from "../state.ts";
import { redactUserMessage } from "../spans.ts";

export function registerPreStep(ctx: PluginContext, cfg: PluginConfig): void {
  ctx.on("agent/pre-step", async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const decision = await next();
    if (!decision || decision.kind === "reject" || !Array.isArray(decision.messages)) return decision;
    const st = stateFor(payload.agent?.id, cfg);
    if (!st.enabled) return decision;
    let changed = false;
    const messages = decision.messages.map((m) => {
      const r = redactUserMessage(m, st, cfg.autoDetect);
      if (r.changed) changed = true;
      return r.message;
    });
    if (!changed) return decision;
    return { ...decision, messages };
  });
}
