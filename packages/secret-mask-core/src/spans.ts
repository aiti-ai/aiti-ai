/**
 * Generic text-span redaction loop — the one piece every host needs.
 *
 * A host maps its message shape down to `TextSpan`s (get/set accessors over
 * the host's text blocks) and decides which spans are user-authored (auto-
 * detection registers newly seen secret-shaped values ONLY from user-authored
 * text; everything else just gets redaction of already-registered values).
 *
 * Both reference hosts differ in message shape and mutability semantics:
 *  - pi mutates a deep-copied context (session keeps the original);
 *  - DSH rebuilds frozen messages immutably (pre-step replacements are
 *    durable in the session log).
 * The span contract covers both: `set` may mutate or the host may rebuild.
 */

import { registerWeakCandidates, type WeakCandidate } from "./extract.ts";
import { applyFixedRules, registerRuleMatches, type CustomRule } from "./rules.ts";
import type { Registry, RegistryEntry, ScanMaxOptions } from "./mask.ts";

export interface TextSpan {
  get(): string;
  set(text: string): void;
}

export interface SpanRedactResult {
  changed: boolean;
  newEntries: number;
}

export interface SpanRedactOptions extends ScanMaxOptions {
  /** Register new auto-detected secrets from this span. */
  autoDetect?: boolean;
  /** User-defined rules merged on top of the built-in detection rules. */
  rules?: CustomRule[];
  /**
   * Called with newly detected entries BEFORE redaction, so a host can mount
   * them differently (vault landing: stable alias placeholder in place of the
   * session token).
   */
  onDetected?: (entries: RegistryEntry[]) => void;
  /** L3 weak-value candidates (only on user-authored spans). */
  weak?: { auto?: boolean; onCandidate?: (candidate: WeakCandidate) => void; minLength?: number };
}

/**
 * Register new auto-detected secrets from the given spans (when `autoDetect`
 * is set for user-authored spans), then redact all registered value forms
 * across every span. Mutates spans in place (hosts owning immutable messages
 * read `changed` and rebuild).
 */
export function redactTextSpans(
  spans: TextSpan[],
  registry: Registry,
  salt: string,
  opts: SpanRedactOptions = {},
): SpanRedactResult {
  let newEntries = 0;
  let changed = false;
  for (const span of spans) {
    const text = span.get();
    if (!text) continue;
    if (opts.autoDetect) {
      const added = registry.autoRegister(text, salt, opts);
      if (added.length > 0) {
        opts.onDetected?.(added);
        newEntries += added.length;
      }
      if (opts.weak) {
        const weak = registerWeakCandidates(text, registry, salt, opts.weak);
        newEntries += weak.filter((c) => c.registered).length;
      }
    }
    if (opts.rules && opts.rules.length > 0) newEntries += registerRuleMatches(text, registry, opts.rules, salt);
    const res = registry.redact(text);
    let next = res.text;
    let count = res.count;
    if (opts.rules && opts.rules.length > 0) {
      const fixed = applyFixedRules(next, opts.rules);
      next = fixed.text;
      count += fixed.count;
    }
    if (count > 0) {
      span.set(next);
      changed = true;
    }
  }
  return { changed, newEntries };
}

/** Build a span over one mutable string holder (the common host pattern). */
export function spanOf(get: () => string, set: (text: string) => void): TextSpan {
  return { get, set };
}
