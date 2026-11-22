/**
 * Custom redaction rules (G6) — user-extensible detection on top of the
 * built-in 24 rules.
 *
 * File: `~/.pi/agent/secret-mask-rules.json` (host pins the path). Shape:
 *
 *   {
 *     "version": 1,
 *     "rules": [ { "label": "corp-token", "type": "regex", "match": "acme_[A-Za-z0-9]{32}" } ],
 *     "projects": {
 *       "/home/me/repo": [ { "label": "local-key", "type": "exact", "match": "..." } ]
 *     }
 *   }
 *
 * Rule modes:
 *   - `placeholder` (default): the matched value is registered in the session
 *     registry, so it is redacted outbound AND restored inside tool arguments
 *     (the normal secret lifecycle).
 *   - `fixed`: the matched text is replaced one-way with `fixed` (default
 *     `<redacted:label>`); restoring is impossible by design.
 *
 * Rules are re-read lazily (mtime check per call — event-driven, no timers)
 * so editing the file takes effect on the next request without /reload.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MIN_REDACT_LENGTH, type Registry } from "./mask.ts";
import type { RedactResult } from "./mask.ts";

export type RuleMode = "placeholder" | "fixed";
export type RuleType = "exact" | "regex";

export interface CustomRule {
  /** Literal value (type=exact) or regular-expression source (type=regex). */
  match: string;
  label: string;
  type?: RuleType;
  mode?: RuleMode;
  /** Replacement text for mode=fixed (default `<redacted:label>`). */
  fixed?: string;
  /** Regex flags (default "g"; "g" is always added). */
  flags?: string;
  /** Minimum match length to accept (default MIN_REDACT_LENGTH). */
  minLength?: number;
}

export interface RulesFile {
  version: 1;
  rules: CustomRule[];
  projects: Record<string, CustomRule[]>;
}

export const RULES_FILE_NAME = "secret-mask-rules.json";

export interface RulesReadResult {
  file: RulesFile;
  errors: string[];
}

function emptyFile(): RulesFile {
  return { version: 1, rules: [], projects: {} };
}

function normalize(raw: unknown, where: string, errors: string[]): CustomRule | undefined {
  if (!raw || typeof raw !== "object") {
    errors.push(`${where}: rule must be an object`);
    return undefined;
  }
  const r = raw as Partial<CustomRule>;
  if (typeof r.match !== "string" || r.match.length === 0) {
    errors.push(`${where}: missing "match"`);
    return undefined;
  }
  if (typeof r.label !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.label)) {
    errors.push(`${where}: missing/invalid "label" (1-64 of [A-Za-z0-9_.-])`);
    return undefined;
  }
  const type: RuleType = r.type === "exact" ? "exact" : "regex";
  const mode: RuleMode = r.mode === "fixed" ? "fixed" : "placeholder";
  const rule: CustomRule = { match: r.match, label: r.label, type, mode };
  if (mode === "fixed") rule.fixed = typeof r.fixed === "string" && r.fixed ? r.fixed : `<redacted:${r.label}>`;
  if (typeof r.flags === "string" && r.flags) rule.flags = r.flags.replace(/[gy]/g, "");
  if (typeof r.minLength === "number" && Number.isFinite(r.minLength)) rule.minLength = Math.max(1, Math.floor(r.minLength));
  if (type === "regex") {
    try {
      new RegExp(rule.match, flagsOf(rule));
    } catch (e) {
      errors.push(`${where}: invalid regex for "${rule.label}": ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }
  return rule;
}

function flagsOf(rule: CustomRule): string {
  return `g${rule.flags ?? ""}`;
}

/** Parse the raw rules JSON; invalid rules are dropped (fail-open) and reported. */
export function parseRulesFile(raw: string): RulesReadResult {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { file: emptyFile(), errors: [`invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!parsed || typeof parsed !== "object") return { file: emptyFile(), errors: ["rules file must be a JSON object"] };
  const doc = parsed as Partial<RulesFile> & { rules?: unknown[]; projects?: Record<string, unknown[]> };
  const file = emptyFile();
  const list = Array.isArray(doc.rules) ? doc.rules : [];
  list.forEach((rule, i) => {
    const n = normalize(rule, `rules[${i}]`, errors);
    if (n) file.rules.push(n);
  });
  if (doc.projects && typeof doc.projects === "object") {
    for (const [scope, rules] of Object.entries(doc.projects)) {
      if (!Array.isArray(rules)) continue;
      file.projects[scope] = [];
      rules.forEach((rule, i) => {
        const n = normalize(rule, `projects[${scope}][${i}]`, errors);
        if (n) file.projects[scope]!.push(n);
      });
    }
  }
  return { file, errors };
}

export function readRulesFile(path: string): RulesReadResult {
  try {
    return parseRulesFile(readFileSync(path, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file: emptyFile(), errors: [] };
    return { file: emptyFile(), errors: [e instanceof Error ? e.message : String(e)] };
  }
}

export function writeRulesFile(path: string, file: RulesFile): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Merge global + per-project rules (project entries win on duplicate labels). */
export function mergeRules(file: RulesFile, scope: string): CustomRule[] {
  const seen = new Set<string>();
  const out: CustomRule[] = [];
  for (const rule of [...(file.projects[scope] ?? []), ...file.rules]) {
    if (seen.has(rule.label)) continue;
    seen.add(rule.label);
    out.push(rule);
  }
  return out;
}

/**
 * Lazy rules source: reads the file on first use and re-reads only when the
 * mtime/size changes. Hosts call `rules()` once per request boundary.
 */
export class RulesSource {
  private cache?: RulesFile;
  private stamp = "";
  errors: string[] = [];
  path: string;
  scope: string;

  constructor(path: string, scope: string) {
    this.path = path;
    this.scope = scope;
  }

  rules(): CustomRule[] {
    this.refresh();
    return mergeRules(this.cache ?? emptyFile(), this.scope);
  }

  refresh(force = false): void {
    let stamp = "missing";
    try {
      const st = statSync(this.path);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = "missing";
    }
    if (!force && this.cache && stamp === this.stamp) return;
    const { file, errors } = readRulesFile(this.path);
    this.cache = file;
    this.errors = errors;
    this.stamp = stamp;
  }

  setScope(scope: string): void {
    this.scope = scope;
    this.cache = undefined;
    this.stamp = "";
  }

  reload(): CustomRule[] {
    this.refresh(true);
    return this.rules();
  }
}

function minLengthOf(rule: CustomRule): number {
  return rule.minLength ?? MIN_REDACT_LENGTH;
}

/**
 * Register values matched by placeholder-mode rules so the normal
 * redact/restore pipeline owns them. Returns how many distinct values were
 * newly registered (0 when everything was already known).
 */
export function registerRuleMatches(text: string, registry: Registry, rules: CustomRule[], salt: string): number {
  if (!text || rules.length === 0) return 0;
  let added = 0;
  for (const rule of rules) {
    if ((rule.mode ?? "placeholder") !== "placeholder") continue;
    const min = minLengthOf(rule);
    if ((rule.type ?? "regex") === "exact") {
      if (rule.match.length < min || !text.includes(rule.match)) continue;
      if (registry.registerAuto(rule.match, `custom:${rule.label}`, rule.label, salt, { minLength: min })) added++;
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(rule.match, flagsOf(rule));
    } catch {
      continue;
    }
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0] === "") {
        re.lastIndex++;
        continue;
      }
      if (m[0].length >= min && registry.registerAuto(m[0], `custom:${rule.label}`, rule.label, salt, { minLength: min })) added++;
    }
  }
  return added;
}

/** One-way replacement for mode=fixed rules (run after normal redaction). */
export function applyFixedRules(text: string, rules: CustomRule[]): RedactResult {
  if (!text || rules.length === 0) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const rule of rules) {
    if (rule.mode !== "fixed") continue;
    const replacement = rule.fixed ?? `<redacted:${rule.label}>`;
    if ((rule.type ?? "regex") === "exact") {
      if (rule.match.length === 0) continue;
      const parts = out.split(rule.match);
      if (parts.length > 1) {
        count += parts.length - 1;
        out = parts.join(replacement);
      }
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(rule.match, flagsOf(rule));
    } catch {
      continue;
    }
    out = out.replace(re, () => {
      count++;
      return replacement;
    });
  }
  return { text: out, count };
}

export function ruleSummary(rule: CustomRule): string {
  const mode = rule.mode ?? "placeholder";
  const type = rule.type ?? "regex";
  const extra = mode === "fixed" ? ` → ${rule.fixed ?? `<redacted:${rule.label}>`} (one-way)` : "";
  return `${rule.label}: ${type} /${rule.match}/${rule.flags ?? ""} [${mode}]${extra}`;
}

export interface RuleEditResult {
  rule: CustomRule;
  scope: "global" | "project";
}

/** Add one rule to the file (project bucket by default). */
export function addRuleToFile(path: string, scope: string, rule: CustomRule, target: "global" | "project" = "project"): string | undefined {
  const { file } = readRulesFile(path);
  if (target === "global") {
    file.rules = file.rules.filter((r) => r.label !== rule.label);
    file.rules.push(rule);
  } else {
    const bucket = file.projects[scope] ?? [];
    file.projects[scope] = bucket.filter((r) => r.label !== rule.label).concat(rule);
  }
  return writeRulesFile(path, file);
}

/** Remove a rule by label from both buckets. Returns how many were removed. */
export function removeRuleFromFile(path: string, scope: string, label: string): { removed: number; error?: string } {
  const { file } = readRulesFile(path);
  const before = file.rules.length + (file.projects[scope]?.length ?? 0);
  file.rules = file.rules.filter((r) => r.label !== label);
  if (file.projects[scope]) file.projects[scope] = file.projects[scope]!.filter((r) => r.label !== label);
  const after = file.rules.length + (file.projects[scope]?.length ?? 0);
  const err = writeRulesFile(path, file);
  return err ? { removed: 0, error: err } : { removed: before - after };
}
