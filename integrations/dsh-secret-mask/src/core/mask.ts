/**
 * Placeholder registry and redaction engine for dsh-secret-mask.
 *
 * Ported verbatim from @aiti-ai/pi-secret-mask src/mask.ts (same placeholder
 * format, same entropy/checksum rules) so both hosts redact identically. The
 * registry maps secret values to stable placeholders:
 *   - manual entry with alias:  `[REDACTED:github-token]`
 *   - auto-detected entry:      `[REDACTED:GITHUB_TOKEN#a1b2c3d4]`
 *                              (hash = fnv1a(sessionSalt + value), stable within
 *                               one session so repeated values map to the same
 *                               placeholder; meaningless across sessions)
 *
 * redact() replaces known value forms with placeholders; restore() puts real
 * values back (used inside shadow tool wrappers before execution). All
 * operations are exact-match and idempotent.
 */

import { fnv1a, scan } from "./detect.ts";

/** Values shorter than this are not registered (avoid noise on short flags/ids). */
export const MIN_REDACT_LENGTH = 6;

export interface RegistryEntry {
  placeholder: string;
  value: string;
  /** Display label: alias for manual entries, rule label for auto entries. */
  label: string;
  alias?: string;
  source: "manual" | "auto";
  ruleId?: string;
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

export interface ScanMaxOptions {
  /** Skip rule scanning for texts above this size (redaction still runs). */
  autoDetectMaxBytes?: number;
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
  private byValue = new Map<string, RegistryEntry>();
  private byPlaceholder = new Map<string, RegistryEntry>();
  /** value forms sorted longest-first, so a value containing another is replaced whole. */
  private forms: Array<{ form: string; entry: RegistryEntry }> = [];

  get size(): number {
    return this.byValue.size;
  }

  entries(): RegistryEntry[] {
    return [...this.byValue.values()];
  }

  /** Look up an entry by its exact placeholder string. */
  byPlaceholderLookup(placeholder: string): RegistryEntry | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  registerManual(value: string, alias?: string): RegisterResult | undefined {
    const trimmed = value.trim();
    if (trimmed.length < MIN_REDACT_LENGTH) return undefined;
    const existing = this.byValue.get(trimmed);
    if (existing && existing.source === "manual" && existing.alias === (alias ?? undefined)) {
      return { entry: existing, replaced: false };
    }
    let label = alias?.trim() ?? "";
    if (!label) label = `secret-${this.countManual() + 1}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(label)) label = label.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || `secret-${this.countManual() + 1}`;
    if (existing) this.removeEntry(existing);
    const placeholder = `[REDACTED:${label}]`;
    // alias collision with a different value: disambiguate with a numeric suffix
    const entry: RegistryEntry = { placeholder, value: trimmed, label, alias: alias?.trim() || undefined, source: "manual" };
    if (this.byPlaceholder.has(placeholder) && this.byPlaceholder.get(placeholder) !== entry) {
      let n = 2;
      let p = `[REDACTED:${label}-${n}]`;
      while (this.byPlaceholder.has(p)) p = `[REDACTED:${label}-${++n}]`;
      entry.placeholder = p;
    }
    this.addEntry(entry);
    return { entry, replaced: existing !== undefined };
  }

  registerAuto(value: string, ruleId: string, label: string, salt: string): RegisterResult | undefined {
    const trimmed = value.trim();
    if (trimmed.length < MIN_REDACT_LENGTH) return undefined;
    const existing = this.byValue.get(trimmed);
    if (existing) return { entry: existing, replaced: false };
    const placeholder = `[REDACTED:${label}#${fnv1a(salt + trimmed)}]`;
    if (this.byPlaceholder.has(placeholder)) return undefined; // hash collision with a different value: skip, next salt cycle fixes
    const entry: RegistryEntry = { placeholder, value: trimmed, label, source: "auto", ruleId };
    this.addEntry(entry);
    return { entry, replaced: false };
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

  removeByLabel(label: string): boolean {
    const entry = this.entries().find((e) => e.label === label || e.alias === label || e.placeholder === `[REDACTED:${label}]`);
    if (!entry) return false;
    this.removeEntry(entry);
    return true;
  }

  clear(): void {
    this.byValue.clear();
    this.byPlaceholder.clear();
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
    const out = text.replace(/\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g, (m) => {
      const entry = this.byPlaceholder.get(m);
      if (!entry) return m;
      count++;
      return entry.value;
    });
    return { text: out, count };
  }

  private addEntry(entry: RegistryEntry): void {
    this.byValue.set(entry.value, entry);
    this.byPlaceholder.set(entry.placeholder, entry);
    this.rebuildForms();
  }

  private removeEntry(entry: RegistryEntry): void {
    this.byValue.delete(entry.value);
    this.byPlaceholder.delete(entry.placeholder);
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

  private countManual(): number {
    let n = 0;
    for (const e of this.byValue.values()) if (e.source === "manual") n++;
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

/**
 * Restore placeholders inside a **cloned** tool-call input structure. DSH
 * freezes the arguments object before the pipeline, so the shadow tool
 * wrapper restores into a deep clone and executes the wrapped tool with the
 * clone (never mutates the frozen original).
 */
export function restoreDeep<T>(obj: T, registry: Registry): { value: T; count: number } {
  let count = 0;
  const mapped = deepMapStrings(obj, (s) => {
    const r = registry.restore(s);
    count += r.count;
    return r.text;
  });
  return { value: mapped as T, count };
}

/** Redact known values inside a nested structure (tool result canonical values). */
export function redactDeep<T>(obj: T, registry: Registry): { value: T; count: number } {
  let count = 0;
  const mapped = deepMapStrings(obj, (s) => {
    const r = registry.redact(s);
    count += r.count;
    return r.text;
  });
  return { value: mapped as T, count };
}

export interface PayloadAudit {
  strings: number;
  placeholders: number;
  leaks: number;
  leakedLabels: string[];
}

/**
 * Audit the FINAL wire payload (the `llm/stream` GenerateOptions): count
 * placeholder occurrences and — the actual proof — occurrences of any
 * registered raw value across every string leaf. Independent of the redaction
 * passes: whatever earlier hooks did, this sees what the provider receives.
 */
export function auditPayload(payload: unknown, registry: Registry): PayloadAudit {
  const leaksByLabel = new Map<string, number>();
  let strings = 0;
  let placeholders = 0;
  let leaks = 0;
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      strings++;
      for (const entry of registry.entries()) {
        if (entry.value.length >= MIN_REDACT_LENGTH && node.includes(entry.value)) {
          leaks++;
          leaksByLabel.set(entry.label, (leaksByLabel.get(entry.label) ?? 0) + 1);
        }
      }
      const ph = node.match(/\[REDACTED:[A-Za-z0-9_-]{1,64}(?:#[0-9a-fA-F]{1,16})?\]/g);
      if (ph) placeholders += ph.length;
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
