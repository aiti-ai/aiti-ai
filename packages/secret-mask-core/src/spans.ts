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

import type { Registry, ScanMaxOptions } from "./mask.ts";

export interface TextSpan {
  get(): string;
  set(text: string): void;
}

export interface SpanRedactResult {
  changed: boolean;
  newEntries: number;
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
  opts: { autoDetect?: boolean } & ScanMaxOptions = {},
): SpanRedactResult {
  let newEntries = 0;
  let changed = false;
  for (const span of spans) {
    const text = span.get();
    if (!text) continue;
    if (opts.autoDetect) newEntries += registry.autoRegister(text, salt, opts).length;
    const res = registry.redact(text);
    if (res.count > 0) {
      span.set(res.text);
      changed = true;
    }
  }
  return { changed, newEntries };
}

/** Build a span over one mutable string holder (the common host pattern). */
export function spanOf(get: () => string, set: (text: string) => void): TextSpan {
  return { get, set };
}
