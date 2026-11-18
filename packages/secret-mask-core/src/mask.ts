/**
 * Placeholder registry and redaction engine.
 *
 * The registry maps secret values to stable placeholders. v2 format (see
 * ./placeholder.ts):
 *   - manual entry with alias:  `rsec_a1b2c3d4`
 *   - auto-detected entry:      `rsec_a1b2c3d4`
 *     (hash = fnv1a(sessionSalt + value), stable within one session so
 *      repeated values map to the same placeholder; meaningless across
 *      sessions)
 *   - vault (stable) entry:     `rsec_a1b2c3d4`
 *     (hash = fnv1a("vault:" + alias), stable across sessions so a re-mounted
 *      alias revives historical placeholders after resume)
 *
 * Legacy v1 placeholders (`[REDACTED:alias]`, `[REDACTED:LABEL#hash8]`) are
 * still restorable but never generated.
 *
 * redact() replaces known value forms with placeholders; restore() puts real
 * values back (used in tool arguments before execution). All operations are
 * exact-match and idempotent.
 */

import { scan } from "./detect.ts";
import { fnv1a } from "./hash.ts";
import { PLACEHOLDER_RE, STABLE_NAMESPACE, placeholderFromHash } from "./placeholder.ts";

/** Values shorter than this are not registered (avoid noise on short flags/ids). */
export const MIN_REDACT_LENGTH = 6;

export type EntrySource = "manual" | "auto" | "vault";

export interface RegistryEntry {
  placeholder: string;
  value: string;
  /** Display label: alias for manual/vault entries, rule label for auto entries. */
  label: string;
  alias?: string;
  source: EntrySource;
  ruleId?: string;
  /** Stable (cross-session) placeholder generated from a namespace + alias. */
  stable?: boolean;
}

export interface RedactResult {
  text: string;
  count: number;
}

export interface RegisterResult {
  entry: RegistryEntry;
  /** True when an existing entry for the same value was replaced (alias re-add). */
  replaced: boolean;
}

export interface ScalarOptions {
  /** Skip rule scanning for texts above this size (redaction still runs). */
  autoDetectMaxBytes?: number;
}

export type ScanMaxOptions = ScalarOptions;

export interface RegisterOptions {
  alias?: string;
  /** Explicit placeholder to reuse (snapshot load). */
  placeholder?: string;
  /** Session salt for placeholder hashing (defaults to `registry.salt`). */
  salt?: string;
  /** Stable-placeholder namespace (vault); enables cross-session placeholders. */
  namespace?: string;
  ruleId?: string;
  label?: string;
  /** Override minimum value length (custom rules may opt into shorter values). */
  minLength?: number;
}

function stringLeaves(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const child of Object.values(node as Record<string, unknown>)) stringLeaves(child, out);
  return out;
}

/**
 * Forms of one value that should all be redacted: the value itself, its
 * trimmed form, JSON leaves (key files), and 20+ char runs inside multi-part
 * values (PEM bodies split by line numbers / diff marks / JSON escapes).
 */
export function redactForms(value: string): string[] {
  const trimmed = value.trim();
  const forms = new Set([value, trimmed]);
  let parts: string[] | null = null;
  if (/^[[{]/.test(trimmed)) {
    try {
      parts = stringLeaves(JSON.parse(trimmed) as unknown);
    } catch {
      parts = null;
    }
  }
  if (parts || /\s/.test(trimmed)) {
    for (const part of parts ?? [trimmed]) {
      for (const run of part.match(/[A-Za-z0-9+/=_-]{20,}/g) ?? []) forms.add(run);
    }
  }
  return [...forms].filter((form) => form.length >= MIN_REDACT_LENGTH);
}

export class Registry {
  /** Session salt used for v2 placeholder hashing (set by the host). */
  salt = "";
  private byValue = new Map<string, RegistryEntry>();
  private byPlaceholder = new Map<string, RegistryEntry>();
  /** Old placeholder → entry, kept when a value is re-registered under a new alias. */
  private redirects = new Map<string, RegistryEntry>();
  /** value forms sorted longest-first, so a value containing another is replaced whole. */
  private forms: Array<{ form: string; entry: RegistryEntry }> = [];

  get size(): number {
    return this.byValue.size;
  }

  entries(): RegistryEntry[] {
    return [...this.byValue.values()];
  }

  /** Look up an entry by its exact placeholder string (current or redirected). */
  byPlaceholderLookup(placeholder: string): RegistryEntry | undefined {
    return this.byPlaceholder.get(placeholder) ?? this.redirects.get(placeholder);
  }

  /** True when this exact value is already registered. */
  hasValue(value: string): boolean {
    return this.byValue.has(value.trim());
  }

  /** True when a placeholder is mounted (present or redirected). */
  isMounted(placeholder: string): boolean {
    return this.byPlaceholderLookup(placeholder) !== undefined;
  }

  /**
   * Register one value. `source` selects the placeholder namespace:
   * manual/auto → session-salted hash; vault → stable namespace hash.
   */
  register(value: string, source: EntrySource, opts: RegisterOptions = {}): RegisterResult | undefined {
    const trimmed = value.trim();
    if (trimmed.length < (opts.minLength ?? MIN_REDACT_LENGTH)) return undefined;
    const alias = opts.alias?.trim() || undefined;
    const existing = this.byValue.get(trimmed);
    if (existing && existing.source === source && existing.alias === alias && !opts.placeholder) {
      return { entry: existing, replaced: false };
    }
    // Rotation: the same alias re-registered with a new value replaces the old
    // entry (stable placeholders keep their token, so old references revive
    // with the NEW value — exactly what a rotation means).
    const sameAlias =
      alias && (source === "manual" || source === "vault")
        ? this.entries().find((e) => e.source === source && e.alias === alias && e !== existing)
        : undefined;
    if (sameAlias) this.removeEntry(sameAlias, false);

    let label: string;
    if (alias) label = alias;
    else if (opts.label) label = opts.label;
    else if (source === "manual") label = `secret-${this.countSource("manual") + 1}`;
    else label = "SECRET";
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(label)) {
      label = label.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64) || "secret";
    }

    const stable = source === "vault" || Boolean(opts.namespace);
    const namespace = opts.namespace ?? STABLE_NAMESPACE;
    const salt = opts.salt ?? this.salt;
    const placeholder = opts.placeholder
      ? this.takeable(opts.placeholder, existing)
        ? opts.placeholder
        : undefined
      : stable && alias
        ? this.generate((n) => fnv1a(`${namespace}:${alias}${n > 1 ? `#${n}` : ""}`), existing, trimmed)
        : source === "manual" && alias && !salt
          ? // No salt available: keep a deterministic shape (hosts that never set
            // a salt still get cross-session placeholders).
            this.generate((n) => fnv1a(`manual:${alias}${n > 1 ? `#${n}` : ""}`), existing, trimmed)
          : this.generate((n) => fnv1a(`${salt}${trimmed}${n > 1 ? `#${n}` : ""}`), existing, trimmed);
    if (!placeholder) return undefined;

    if (existing) this.removeEntry(existing, existing.placeholder !== placeholder);
    const entry: RegistryEntry = {
      placeholder,
      value: trimmed,
      label,
      alias,
      source,
      ...(opts.ruleId ? { ruleId: opts.ruleId } : {}),
      ...(stable ? { stable: true } : {}),
    };
    this.addEntry(entry);
    return { entry, replaced: existing !== undefined };
  }

  registerManual(value: string, alias?: string, opts: Omit<RegisterOptions, "alias"> = {}): RegisterResult | undefined {
    return this.register(value, "manual", { ...opts, alias });
  }

  registerAuto(value: string, ruleId: string, label: string, salt: string, opts: Omit<RegisterOptions, "salt" | "label" | "ruleId"> = {}): RegisterResult | undefined {
    return this.register(value, "auto", { ...opts, salt, label, ruleId });
  }

  /** Stable entry (vault): placeholder survives sessions and resume. */
  registerStable(value: string, alias: string, namespace = STABLE_NAMESPACE, opts: Omit<RegisterOptions, "alias" | "namespace"> = {}): RegisterResult | undefined {
    return this.register(value, "vault", { ...opts, alias, namespace });
  }

  /** Auto-detect secrets in text and register them; returns newly added entries. */
  autoRegister(text: string, salt: string, opts: ScanMaxOptions = {}): RegistryEntry[] {
    const max = opts.autoDetectMaxBytes ?? 256 * 1024;
    if (text.length > max) return [];
    let hits;
    try {
      hits = scan(text);
    } catch {
      return []; // fail-open on detection only; redaction of known values still runs elsewhere
    }
    const added: RegistryEntry[] = [];
    for (const hit of hits) {
      if (this.byValue.has(hit.value)) continue; // already registered → not a new entry
      const res = this.registerAuto(hit.value, hit.id, hit.label, salt);
      if (res) added.push(res.entry);
    }
    return added;
  }

  /** Remove by label, alias, or exact placeholder. */
  removeByLabel(label: string): boolean {
    const entry = this.entries().find(
      (e) => e.label === label || e.alias === label || e.placeholder === label,
    );
    if (!entry) return false;
    this.removeEntry(entry, true);
    return true;
  }

  /**
   * Remove an entry WITHOUT keeping a redirect — the placeholder stops
   * resolving, so the G7 guard blocks later references (`/vault forget`).
   */
  forgetByLabel(label: string): boolean {
    const entry = this.entries().find((e) => e.label === label || e.alias === label || e.placeholder === label);
    if (!entry) return false;
    this.byValue.delete(entry.value);
    this.byPlaceholder.delete(entry.placeholder);
    this.redirects.delete(entry.placeholder);
    for (const [token, target] of this.redirects) if (target.value === entry.value) this.redirects.delete(token);
    this.rebuildForms();
    return true;
  }

  /** Drop a redirect (snapshot unload); keeps current entries intact. */
  clearRedirects(): void {
    this.redirects.clear();
  }

  redirectsSnapshot(): Record<string, string> {
    return Object.fromEntries([...this.redirects].map(([k, v]) => [k, v.placeholder]));
  }

  /** Redirected placeholder → entry (audit/guard support). */
  redirectEntries(): Array<[string, RegistryEntry]> {
    return [...this.redirects];
  }

  clear(): void {
    this.byValue.clear();
    this.byPlaceholder.clear();
    this.redirects.clear();
    this.forms = [];
  }

  /** Replace all known value forms in text with placeholders. */
  redact(text: string): RedactResult {
    if (!text || this.forms.length === 0) return { text, count: 0 };
    const hits: Array<{ start: number; end: number; entry: RegistryEntry }> = [];
    for (const { form, entry } of this.forms) {
      for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1)) {
        hits.push({ start: at, end: at + form.length, entry });
      }
    }
    if (hits.length === 0) return { text, count: 0 };
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    let out = "";
    let cursor = 0;
    let count = 0;
    let current: (typeof hits)[number] | null = null;
    const flush = (hit: { start: number; end: number; entry: RegistryEntry }) => {
      out += text.slice(cursor, hit.start) + hit.entry.placeholder;
      cursor = hit.end;
      count++;
    };
    for (const hit of hits) {
      if (current && hit.start < current.end) continue; // overlapping earlier (longer) match wins
      if (current) flush(current);
      current = hit;
    }
    if (current) flush(current);
    return { text: out + text.slice(cursor), count };
  }

  /** Replace placeholders in text with their real values. Unknown placeholders pass through. */
  restore(text: string): RedactResult {
    if (!text || this.byPlaceholder.size === 0) return { text, count: 0 };
    let count = 0;
    const out = text.replace(new RegExp(PLACEHOLDER_RE.source, "g"), (m) => {
      const entry = this.byPlaceholderLookup(m);
      if (!entry) return m;
      count++;
      return entry.value;
    });
    return { text: out, count };
  }

  /** True when `placeholder` is free — or already belongs to this value/slot. */
  private takeable(placeholder: string, existing?: RegistryEntry): boolean {
    const current = this.byPlaceholder.get(placeholder);
    if (!current || current === existing) return true;
    return current.value === existing?.value;
  }

  private generate(seed: (n: number) => string, existing?: RegistryEntry, value?: string): string | undefined {
    for (let n = 1; n <= 64; n++) {
      const p = placeholderFromHash(seed(n));
      const occupied = this.byPlaceholder.get(p);
      const redirected = this.redirects.get(p);
      const sameSlot = p === existing?.placeholder;
      const sameValue = value !== undefined && (occupied?.value === value || redirected?.value === value);
      if ((!occupied || sameSlot || sameValue) && (!redirected || sameSlot || sameValue)) return p;
    }
    return undefined;
  }

  private addEntry(entry: RegistryEntry): void {
    this.byValue.set(entry.value, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.rebuildForms();
  }

  /**
   * Remove one entry. `follow` keeps a redirect from the old placeholder to
   * whatever entry replaces this value next (auto→manual upgrade path): the
   * model may still reference the previous placeholder in later turns.
   */
  private removeEntry(entry: RegistryEntry, follow: boolean): void {
    this.byValue.delete(entry.value);
    this.byPlaceholder.delete(entry.placeholder);
    if (follow) this.redirects.set(entry.placeholder, entry);
    this.rebuildForms();
  }

  private rebuildForms(): void {
    const seen = new Set<string>();
    const list: Array<{ form: string; entry: RegistryEntry }> = [];
    for (const entry of this.byValue.values()) {
      for (const form of redactForms(entry.value)) {
        if (seen.has(form)) continue;
        seen.add(form);
        list.push({ form, entry });
      }
    }
    this.forms = list.sort((a, b) => b.form.length - a.form.length);
  }

  private countSource(source: EntrySource): number {
    let n = 0;
    for (const e of this.byValue.values()) if (e.source === source) n++;
    return n;
  }
}

// ---------------------------------------------------------------------------
// deep traversal
// ---------------------------------------------------------------------------

/** Map every string in a JSON-like structure. Returns the original reference when nothing changed. */
export function deepMapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const r = deepMapStrings(v, fn);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = deepMapStrings(v, fn);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

/** Restore placeholders inside a tool-call input structure (in place). */
export function restoreDeep<T>(obj: T, registry: Registry): { value: T; count: number } {
  let count = 0;
  const mapped = deepMapStrings(obj, (s) => {
    const r = registry.restore(s);
    count += r.count;
    return r.text;
  });
  return { value: mapped as T, count };
}

/** Redact known values inside a nested structure (tool results, details, structured data). */
export function redactDeep<T>(obj: T, registry: Registry): { value: T; count: number } {
  let count = 0;
  const mapped = deepMapStrings(obj, (s) => {
    const r = registry.redact(s);
    count += r.count;
    return r.text;
  });
  return { value: mapped as T, count };
}

/** Restore placeholders inside a nested structure **in place** (tool-call inputs must be patched in place: pi reads the fields off the event object). */
export function restoreDeepInPlace(value: unknown, registry: Registry): number {
  return walkInPlace(value, (s) => registry.restore(s));
}

/** Redact known values inside a nested structure **in place** (compaction/tree preparation). */
export function redactDeepInPlace(value: unknown, registry: Registry): number {
  return walkInPlace(value, (s) => registry.redact(s));
}

function walkInPlace(value: unknown, fn: (s: string) => RedactResult): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") {
          const r = fn(v);
          if (r.count > 0) {
            node[i] = r.text;
            count += r.count;
          }
        } else walk(v);
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (typeof v === "string") {
          const r = fn(v);
          if (r.count > 0) {
            (node as Record<string, unknown>)[k] = r.text;
            count += r.count;
          }
        } else walk(v);
      }
    }
  };
  walk(value);
  return count;
}

// ---------------------------------------------------------------------------
// final-payload audit (proof layer)
// ---------------------------------------------------------------------------

export interface PayloadAudit {
  strings: number;
  placeholders: number;
  leaks: number;
  leakedLabels: string[];
}

/**
 * Audit the FINAL wire payload (the `before_provider_request` event payload):
 * count placeholder occurrences and — the actual proof — occurrences of any
 * registered raw value across every string leaf. Independent of the redaction
 * pass: whatever earlier hooks did to the payload, this sees what goes out.
 */
export function auditPayload(payload: unknown, registry: Registry): PayloadAudit {
  const leaksByLabel = new Map<string, number>();
  let strings = 0;
  let placeholders = 0;
  let leaks = 0;
  const placeholderRe = new RegExp(PLACEHOLDER_RE.source, "g");
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      strings++;
      for (const entry of registry.entries()) {
        if (entry.value.length >= MIN_REDACT_LENGTH && node.includes(entry.value)) {
          leaks++;
          leaksByLabel.set(entry.label, (leaksByLabel.get(entry.label) ?? 0) + 1);
        }
      }
      placeholders += (node.match(placeholderRe) ?? []).length;
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
  walk(payload);
  return { strings, placeholders, leaks, leakedLabels: [...leaksByLabel.keys()] };
}
