/**
 * Unregistered-placeholder guard (G7).
 *
 * After `vault forget`, a rotation/alias change, or a session resume in a
 * volatile landing mode, the model may still reference a placeholder that no
 * longer resolves. Without a guard the literal token (`rsec_ab12cd34`) lands
 * in the tool arguments and the command silently runs with a fake value. The
 * guard finds those tokens before execution and blocks with actionable
 * guidance instead.
 *
 * Tokens that redirect to a live entry (old placeholder of a re-registered
 * value) count as mounted: references from earlier turns keep working.
 */

import type { Registry } from "./mask.ts";
import { findV2Placeholders } from "./placeholder.ts";

/** Placeholder tokens in `text` that the registry cannot resolve. */
export function unmountedPlaceholders(text: string, registry: Registry): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const token of findV2Placeholders(text)) {
    if (registry.isMounted(token)) continue;
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** Walk a nested tool-call input and collect unresolved placeholder tokens. */
export function unmountedInValue(value: unknown, registry: Registry): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      for (const token of unmountedPlaceholders(node, registry)) if (!out.includes(token)) out.push(token);
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  };
  walk(value);
  return out;
}

export interface GuardReasonOptions {
  /** Landing mode, used to tailor the recovery hint. */
  landing?: string;
}

/** User/model facing block reason with the exact recovery command. */
export function guardReason(tokens: string[], opts: GuardReasonOptions = {}): string {
  const list = tokens.join(", ");
  const hint =
    opts.landing === "ephemeral"
      ? `/secret add <label> to register the value again (ephemeral landing keeps values in memory only) or ask the user to provide it`
      : `vault_get <alias> to re-mount the value, or /secret add <label> to register it in this session`;
  return `secret-mask: refused to run with unresolved placeholder(s) ${list}. The value behind them is not mounted in this session — call ${hint}. Do not retype, guess or replace the placeholder yourself.`;
}
