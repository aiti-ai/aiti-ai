/**
 * /secret command logic — pure functions over the registry + session state,
 * kept free of pi imports so tests can drive them directly.
 *
 * v0.2 command surface:
 *   add / list / remove / clear / on / off / status
 *   landing <plain|ephemeral|vault>   session-file policy (G1)
 *   guard on|off                      unresolved-placeholder guard (G7)
 *   strict on|off                     refuse instead of warn (compact/!-commands)
 *   rule list|add|remove|reload       custom rules (G6)
 *   save <file> | load <file>         explicit plaintext snapshot (no implicit state)
 *   audit [on|off|show]               per-send wire-payload proof log
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync as fileStat, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { MIN_REDACT_LENGTH, Registry, type EntrySource, type RegistryEntry } from "./mask.ts";
import { DEFAULT_LANDING, LANDING_MODES, MASK_LANDING_MODES, isLandingMode, landingChangeWarning, landingText, type LandingMode } from "./landing.ts";
import { addRuleToFile, removeRuleFromFile, ruleSummary, type CustomRule } from "./rules.ts";
import { inspectSensitivePath, learnFromText } from "./extract.ts";

export interface SecretState {
  registry: Registry;
  enabled: boolean;
  salt: string;
  /** Persistence bucket key (usually the workspace/project root). */
  cwd: string;
  /** Legacy flag kept for status display only (no implicit persistence). */
  persisted: boolean;
  /** Per-send wire-payload audit (proof log). */
  audit: boolean;
  /** Summary of the most recent audit scan (set by the host audit hook). */
  lastAudit?: string;
  /** Legacy default snapshot path (deprecated; only used for the migration notice). */
  persistPath: string;
  /** Where per-send audit evidence is appended (host sets it). */
  auditPath: string;
  /** Session-file landing policy (G1). */
  landing: LandingMode;
  /** Modes this host can honour (mask: plain+ephemeral; vault: +vault). */
  landingModes?: readonly LandingMode[];
  /** Block tool calls that reference unmounted placeholders (G7). */
  guard: boolean;
  /** Refuse (instead of warn) when a side channel would carry raw values. */
  strict: boolean;
  /** Set when another package in the same session supersedes this one. */
  disabledBy?: string;
  /** L1 structured extraction from tool output / write inputs (default on). */
  extract?: boolean;
  /** L2 sensitive-file policy (default "learn"). */
  filePolicy?: "learn" | "block" | "off";
  /** L3 weak candidate handling (default "notify"). */
  weakMode?: "notify" | "auto" | "off";
  /** Latest tool output, bounded by the host (/secret learn last). */
  lastToolOutput?: string;
  /** Custom rules snapshot (host refreshes from RulesSource). */
  rules?: CustomRule[];
  rulesPath?: string;
  rulesError?: string;
}

export const PERSIST_FILE_NAME = "secret-mask.json";
export const AUDIT_FILE_NAME = "secret-mask-audit.log";

export interface CommandIo {
  input?: (title: string) => Promise<string | undefined>;
  reloadRules?: () => void;
}

export function maskablePreview(entry: RegistryEntry): string {
  const v = entry.value;
  if (v.length <= 8) return "*".repeat(v.length);
  return `${"*".repeat(Math.max(4, Math.min(16, v.length - 8)))}${v.slice(-4)}`;
}

export function listText(state: SecretState): string {
  const entries = state.registry.entries();
  if (entries.length === 0) {
    return "secret-mask: no registered values this session. Use /secret add (interactive) or vault_get <alias>.";
  }
  const lines = entries.map((e) => {
    const src = e.source === "manual" ? "manual" : e.source === "vault" ? "vault" : `auto(${e.ruleId ?? "?"})`;
    const name = e.alias ?? e.label;
    return `- ${e.placeholder} → ${name}  [${src}]  ${e.value.length} chars  …${maskablePreview(e)}`;
  });
  return `secret-mask: ${entries.length} value(s) registered (landing: ${state.landing}):\n${lines.join("\n")}`;
}

export function statusText(state: SecretState): string {
  const rules = state.rules?.length ?? 0;
  const parts = [
    `secret-mask: ${state.disabledBy ? `DISABLED (by ${state.disabledBy})` : state.enabled ? "ON" : "OFF"}`,
    `landing ${state.landing}`,
    `${state.registry.size} value(s) registered`,
    `guard ${state.guard ? "ON" : "OFF"}`,
    `strict ${state.strict ? "ON" : "OFF"}`,
    `rules ${rules}${state.rulesError ? " (errors — /secret rule list)" : ""}`,
    `extract ${state.extract === false ? "OFF" : "ON"}`,
    `files ${state.filePolicy ?? "learn"}`,
    `weak ${state.weakMode ?? "notify"}`,
    `send-audit ${state.audit ? "ON" : "OFF"}`,
  ];
  if (state.lastAudit) parts.push(`last audit: ${state.lastAudit}`);
  return parts.join("; ") + ".";
}

export interface AuditResult {
  time: string;
  sessionId: string;
  /** Host-optional classification (e.g. DSH "compaction"/"session-title"). */
  purpose?: string;
  strings: number;
  placeholders: number;
  leaks: number;
  leakedLabels: string[];
}

/** Append one audit line to the evidence log (never contains raw values). */
export function appendAuditLog(result: AuditResult, path: string): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(result) + "\n", { mode: 0o600 });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function readAuditTail(maxLines = 5, path?: string): string[] {
  if (!path) return [];
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function parseAdd(args: string): { value: string; alias?: string } {
  // `add <value> as <alias>` — split on the last standalone " as "
  const asMatch = /\s+as\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(args);
  if (asMatch) return { value: args.slice(0, asMatch.index).trim(), alias: asMatch[1] };
  const aliasMatch = /^(.*?)\s+--alias\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(args);
  if (aliasMatch) return { value: aliasMatch[1].trim(), alias: aliasMatch[2] };
  return { value: args.trim() };
}

export type CommandOutcome = { ok: true; text: string } | { ok: false; text: string };

function availableLandings(state: SecretState): readonly LandingMode[] {
  return state.landingModes ?? MASK_LANDING_MODES;
}

/** Handle a `/secret <args>` invocation and return the user-facing message. */
export function handleSecretCommand(state: SecretState, rawArgs: string, io: CommandIo = {}): Promise<CommandOutcome> {
  return handleSync(state, rawArgs.trim(), io);
}

async function handleSync(state: SecretState, args: string, io: CommandIo): Promise<CommandOutcome> {
  const [cmd, ...rest] = args.length ? args.split(/\s+/) : [""];
  const tail = args.slice(cmd.length).trim();

  switch (cmd) {
    case "":
    case "help":
      return { ok: true, text: helpText(state) };
    case "add": {
      let value = tail;
      let alias: string | undefined;
      if (!value || /^--alias(\s|$)/.test(value)) {
        const requestedAlias = /^--alias\s+([A-Za-z0-9_-]{1,64})$/.exec(value)?.[1];
        value = (await io.input?.("Paste secret value (input is kept out of the chat)")) ?? "";
        alias = requestedAlias;
        if (!value.trim()) return { ok: false, text: "secret-mask: cancelled." };
      } else {
        const parsed = parseAdd(value);
        value = parsed.value;
        alias = parsed.alias;
      }
      const res = state.registry.registerManual(value, alias, { salt: state.salt });
      if (!res) return { ok: false, text: `secret-mask: value rejected (must be at least ${MIN_REDACT_LENGTH} characters).` };
      const note = res.replaced ? " (replaced previous entry for this value)" : "";
      return { ok: true, text: `secret-mask: registered ${res.entry.placeholder} → ${res.entry.alias ?? res.entry.label}${note}` };
    }
    case "list":
      return { ok: true, text: listText(state) };
    case "remove": {
      if (!tail) return { ok: false, text: "Usage: /secret remove <alias|label|placeholder>" };
      const ok = state.registry.removeByLabel(tail);
      return ok ? { ok: true, text: `secret-mask: removed ${tail}.` } : { ok: false, text: `secret-mask: no entry matching "${tail}".` };
    }
    case "clear": {
      const n = state.registry.size;
      state.registry.clear();
      return { ok: true, text: `secret-mask: cleared ${n} value(s).` };
    }
    case "on":
    case "off": {
      state.enabled = cmd === "on";
      return { ok: true, text: `secret-mask: redaction ${state.enabled ? "enabled" : "disabled"} for this session.` };
    }
    case "landing":
      return landingCommand(state, tail);
    case "guard": {
      if (!tail) return { ok: true, text: `secret-mask: guard ${state.guard ? "ON" : "OFF"} — unresolved placeholders in tool arguments are ${state.guard ? "blocked" : "allowed through"}.` };
      if (tail !== "on" && tail !== "off") return { ok: false, text: "Usage: /secret guard [on|off]" };
      state.guard = tail === "on";
      return { ok: true, text: `secret-mask: guard ${state.guard ? "enabled" : "disabled"}.` };
    }
    case "strict": {
      if (!tail) return { ok: true, text: `secret-mask: strict ${state.strict ? "ON" : "OFF"}.` };
      if (tail !== "on" && tail !== "off") return { ok: false, text: "Usage: /secret strict [on|off]" };
      state.strict = tail === "on";
      return { ok: true, text: `secret-mask: strict ${state.strict ? "enabled" : "disabled"} — side channels ${state.strict ? "fail closed" : "warn and pass"}.` };
    }
    case "rule":
      return ruleCommand(state, tail, io);
    case "audit": {
      const arg = tail.trim();
      if (arg === "on" || arg === "") {
        state.audit = true;
        return { ok: true, text: `secret-mask: send-audit ON — every provider request is scanned for registered raw values; evidence appended to ${state.auditPath}` };
      }
      if (arg === "off") {
        state.audit = false;
        return { ok: true, text: "secret-mask: send-audit OFF." };
      }
      if (arg === "show") {
        const lines = readAuditTail(5, state.auditPath);
        return {
          ok: true,
          text: lines.length
            ? `secret-mask audit evidence (last ${lines.length}):\n${lines.join("\n")}`
            : "secret-mask: no audit evidence yet (turn /secret audit on).",
        };
      }
      return { ok: false, text: "Usage: /secret audit [on|off|show]" };
    }
    case "status":
      return { ok: true, text: statusText(state) };
    case "extract": {
      if (!tail) return { ok: true, text: `secret-mask: extract ${state.extract === false ? "OFF" : "ON"} — structured key-value extraction from tool output and write inputs.` };
      if (tail !== "on" && tail !== "off") return { ok: false, text: "Usage: /secret extract [on|off]" };
      state.extract = tail === "on";
      return { ok: true, text: `secret-mask: extract ${state.extract ? "enabled" : "disabled"}.` };
    }
    case "files": {
      if (!tail) return { ok: true, text: `secret-mask: sensitive-file policy = ${state.filePolicy ?? "learn"} (learn | block | off).` };
      if (tail !== "learn" && tail !== "block" && tail !== "off") return { ok: false, text: "Usage: /secret files [learn|block|off]" };
      state.filePolicy = tail;
      const note = tail === "learn" ? " — structured values are registered; dedicated secret files are withheld as a placeholder" : tail === "block" ? " — reads of sensitive paths are blocked before execution" : " — path policy disabled";
      return { ok: true, text: `secret-mask: file policy → ${tail}${note}.` };
    }
    case "weak": {
      if (!tail) return { ok: true, text: `secret-mask: weak candidates = ${state.weakMode ?? "notify"} (notify | auto | off).` };
      if (tail !== "notify" && tail !== "auto" && tail !== "off") return { ok: false, text: "Usage: /secret weak [notify|auto|off]" };
      state.weakMode = tail;
      return { ok: true, text: `secret-mask: weak candidates → ${tail}${tail === "notify" ? " (dictionary hits register, other candidates only notify)" : tail === "auto" ? " (all weak candidates register)" : ""}.` };
    }
    case "learn": {
      const arg = tail.trim();
      let text: string;
      let label: string | undefined;
      let whole = false;
      if (!arg || arg === "last") {
        if (!state.lastToolOutput) return { ok: false, text: "secret-mask: no recent tool output to learn from." };
        text = state.lastToolOutput;
      } else {
        const path = resolve(state.cwd, arg);
        try {
          const st = fileStat(path);
          if (!st.isFile()) return { ok: false, text: `secret-mask: not a file: ${path}` };
          if (st.size > 1_048_576) return { ok: false, text: `secret-mask: file too large (${st.size} bytes; limit 1MB).` };
          text = readFileSync(path, "utf8");
          label = basename(path);
          whole = inspectSensitivePath(path).dedicated;
        } catch (e) {
          return { ok: false, text: `secret-mask: cannot read ${path}: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      const res = learnFromText(text, state.registry, state.salt, { whole, label });
      const keys = res.keys.slice(0, 8).join(", ") + (res.keys.length > 8 ? ", …" : "");
      return {
        ok: true,
        text: res.count
          ? `secret-mask: learned ${res.count} value(s)${keys ? ` (${keys})` : ""}${res.wholeRegistered ? " — whole file registered" : ""}.`
          : "secret-mask: nothing new to learn (no structured value, or already registered).",
      };
    }
    case "save": {
      if (!tail) return { ok: false, text: "Usage: /secret save <file> — explicit plaintext snapshot (you own the file and its safety)." };
      const path = resolve(state.cwd, tail);
      const err = saveSnapshot(state.registry.entries(), path);
      if (err) return { ok: false, text: `secret-mask: save failed: ${err}` };
      return { ok: true, text: `secret-mask: ${state.registry.size} value(s) written to ${path} (0600, plaintext — placement and safety are yours).` };
    }
    case "load": {
      if (!tail) return { ok: false, text: "Usage: /secret load <file> — explicit snapshot load (nothing is auto-loaded)." };
      const path = resolve(state.cwd, tail);
      const res = loadSnapshot(state.registry, path, { cwd: state.cwd, salt: state.salt });
      if (res.error) return { ok: false, text: `secret-mask: load failed: ${res.error}` };
      state.persisted = false;
      return { ok: true, text: `secret-mask: loaded ${res.loaded} value(s) from ${path}${res.skipped ? ` (${res.skipped} already registered)` : ""}.` };
    }
    case "unload":
      return { ok: true, text: "secret-mask: /secret unload is retired (no implicit persistence). Use /secret clear to drop session entries, or /secret save|load <file> explicitly." };
    default:
      return { ok: false, text: `secret-mask: unknown subcommand "${cmd}". Try /secret help.` };
  }
}

function helpText(state: SecretState): string {
  const modes = availableLandings(state).join("|");
  return [
    "secret-mask commands:",
    "  /secret add [<value>] [as <alias> | --alias <alias>]   register a value (masked input when omitted)",
    "  /secret list                       placeholders → aliases (masked previews)",
    "  /secret remove <alias|label>       unregister one value",
    "  /secret clear                      unregister all",
    "  /secret on | off                   enable/disable redaction for this session",
    `  /secret landing [${modes}]   where real values may live on disk (current: ${state.landing})`,
    "  /secret guard [on|off]             block unresolved placeholders in tool arguments",
    "  /secret strict [on|off]            fail closed on side channels (compaction, ! commands)",
    "  /secret rule list | add | remove | reload   custom detection rules",
    "  /secret extract [on|off]           structured extraction from tool output / write inputs",
    "  /secret files [learn|block|off]    sensitive-file policy (learn = register & redact)",
    "  /secret weak [notify|auto|off]     weak-password candidates (L3)",
    "  /secret learn [last|<file>]        register values from the last tool output or a file",
    "  /secret save <file> | load <file>  explicit plaintext snapshot (no implicit state)",
    "  /secret audit [on|off|show]        per-send wire-payload proof log",
    "  /secret status                     current state",
  ].join("\n");
}

function landingCommand(state: SecretState, tail: string): CommandOutcome {
  const modes = availableLandings(state);
  if (!tail) {
    const lines = modes.map((m) => `  ${m === state.landing ? "*" : " "} ${landingText(m)}`);
    return { ok: true, text: `secret-mask: landing policy (current: ${state.landing})\n${lines.join("\n")}` };
  }
  if (!isLandingMode(tail)) return { ok: false, text: `Usage: /secret landing [${modes.join("|")}]` };
  if (!modes.includes(tail)) return { ok: false, text: `secret-mask: landing "${tail}" is not available in this package (supported: ${modes.join(", ")}).` };
  const previous = state.landing ?? DEFAULT_LANDING;
  state.landing = tail;
  const warning = landingChangeWarning(tail, previous);
  return { ok: true, text: `secret-mask: landing → ${tail}${warning ? `\n${warning}` : ""}` };
}

async function ruleCommand(state: SecretState, tail: string, io: CommandIo): Promise<CommandOutcome> {
  const tokens = tail.split(/\s+/).filter(Boolean);
  const sub = tokens[0] ?? "list";
  if (!state.rulesPath && sub !== "list") {
    return { ok: false, text: "secret-mask: no custom rules file configured by this host." };
  }
  if (sub === "list" || sub === "") {
    const rules = state.rules ?? [];
    const errors = state.rulesError ? [`errors: ${state.rulesError}`] : [];
    if (rules.length === 0 && errors.length === 0) {
      return { ok: true, text: `secret-mask: no custom rules${state.rulesPath ? ` (${state.rulesPath})` : ""}.` };
    }
    const lines = rules.map((r) => `- ${ruleSummary(r)}`);
    return { ok: true, text: `secret-mask: ${rules.length} custom rule(s)${state.rulesPath ? ` from ${state.rulesPath}` : ""}:\n${[...lines, ...errors].join("\n")}` };
  }
  if (sub === "reload") {
    io.reloadRules?.();
    return { ok: true, text: "secret-mask: custom rules reloaded." };
  }
  if (sub === "add") {
    let rest = tokens.slice(1);
    let target: "global" | "project" = "project";
    if (rest.includes("--global")) {
      target = "global";
      rest = rest.filter((t) => t !== "--global");
    }
    let fixed: string | undefined;
    const fixedAt = rest.indexOf("--fixed");
    if (fixedAt >= 0) {
      fixed = rest.slice(fixedAt + 1).join(" ");
      rest = rest.slice(0, fixedAt);
    }
    const [label, type, ...patternParts] = rest;
    if (!label || (type !== "exact" && type !== "regex") || patternParts.length === 0) {
      return { ok: false, text: "Usage: /secret rule add <label> <exact|regex> <pattern> [--fixed <text>] [--global]" };
    }
    const rule: CustomRule = {
      label,
      type,
      match: patternParts.join(" "),
      mode: fixed !== undefined ? "fixed" : "placeholder",
    };
    if (fixed !== undefined) rule.fixed = fixed || `<redacted:${label}>`;
    if (type === "regex") {
      try {
        new RegExp(rule.match, "g");
      } catch (e) {
        return { ok: false, text: `secret-mask: invalid regex: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(label)) return { ok: false, text: "secret-mask: label must be 1-64 chars of [A-Za-z0-9_.-]." };
    const err = addRuleToFile(state.rulesPath!, state.cwd, rule, target);
    if (err) return { ok: false, text: `secret-mask: could not write rules: ${err}` };
    io.reloadRules?.();
    return { ok: true, text: `secret-mask: rule "${label}" added (${target}).` };
  }
  if (sub === "remove") {
    const label = tokens[1];
    if (!label) return { ok: false, text: "Usage: /secret rule remove <label>" };
    const res = removeRuleFromFile(state.rulesPath!, state.cwd, label);
    if (res.error) return { ok: false, text: `secret-mask: could not write rules: ${res.error}` };
    if (res.removed === 0) return { ok: false, text: `secret-mask: no rule labelled "${label}".` };
    io.reloadRules?.();
    return { ok: true, text: `secret-mask: removed rule "${label}".` };
  }
  return { ok: false, text: "Usage: /secret rule [list|add|remove|reload]" };
}

// ---------------------------------------------------------------------------
// snapshots (explicit save/load; no implicit state)
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
  placeholder: string;
  value: string;
  label: string;
  alias?: string;
  source: EntrySource;
  ruleId?: string;
  stable?: boolean;
}

export interface SnapshotFile {
  version: 2;
  savedAt: string;
  cwd: string;
  entries: SnapshotEntry[];
}

/** Write a plaintext snapshot to a user-chosen file (0600). */
export function saveSnapshot(entries: readonly RegistryEntry[], path: string): string | undefined {
  try {
    const file: SnapshotFile = {
      version: 2,
      savedAt: new Date().toISOString(),
      cwd: process.cwd(),
      entries: entries.map((e) => ({
        placeholder: e.placeholder,
        value: e.value,
        label: e.label,
        alias: e.alias,
        source: e.source,
        ruleId: e.ruleId,
        stable: e.stable,
      })),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort (Windows)
    }
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

interface LegacyPersistEntry {
  placeholder: string;
  value: string;
  label: string;
  alias?: string;
  source: EntrySource;
  ruleId?: string;
}

/** Legacy v1 file (`{version:1, projects:{cwd:[entries]}}`). */
function legacyEntries(raw: string, cwd: string): LegacyPersistEntry[] {
  const doc = JSON.parse(raw) as { version?: number; projects?: Record<string, LegacyPersistEntry[]> };
  const projects = doc?.projects;
  if (!projects || typeof projects !== "object") return [];
  if (Array.isArray(projects[cwd])) return projects[cwd];
  return Object.values(projects).flatMap((list) => (Array.isArray(list) ? list : []));
}

export function loadSnapshot(
  registry: Registry,
  path: string,
  opts: { cwd?: string; salt?: string } = {},
): { loaded: number; skipped: number; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { loaded: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
  }
  let entries: SnapshotEntry[];
  try {
    const doc = JSON.parse(raw) as Partial<SnapshotFile> & { projects?: unknown };
    if (doc.version === 2 && Array.isArray(doc.entries)) {
      entries = doc.entries as SnapshotEntry[];
    } else {
      entries = legacyEntries(raw, opts.cwd ?? process.cwd()) as SnapshotEntry[];
    }
  } catch (e) {
    return { loaded: 0, skipped: 0, error: `invalid snapshot: ${e instanceof Error ? e.message : String(e)}` };
  }
  let loaded = 0;
  let skipped = 0;
  for (const e of entries) {
    if (!e || typeof e.value !== "string" || typeof e.placeholder !== "string") {
      skipped++;
      continue;
    }
    if (registry.isMounted(e.placeholder)) {
      skipped++;
      continue;
    }
    const res = registry.register(e.value, e.source ?? "manual", {
      alias: e.alias,
      label: e.label,
      placeholder: e.placeholder,
      salt: opts.salt,
      ruleId: e.ruleId,
    });
    if (res) loaded++;
    else skipped++;
  }
  return { loaded, skipped };
}

/** Deprecated: legacy implicit persist (kept for API compatibility). */
export function savePersist(state: SecretState, path: string): string | undefined {
  return saveSnapshot(state.registry.entries(), path);
}

/** Deprecated: legacy implicit persist (kept for API compatibility). */
export function loadPersist(state: SecretState, path: string): number {
  return loadSnapshot(state.registry, path, { cwd: state.cwd, salt: state.salt }).loaded;
}

/** Deprecated: legacy implicit persist (kept for API compatibility). */
export function clearPersist(_cwd: string, path: string): string | undefined {
  return existsSync(path) ? "implicit persistence is retired; delete the file yourself if you no longer need it" : undefined;
}

/** True when the retired implicit persistence file is still around. */
export function legacyPersistExists(path: string): boolean {
  return existsSync(path);
}
