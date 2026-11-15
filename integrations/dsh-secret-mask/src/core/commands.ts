/**
 * /secret command logic — pure functions over the registry + persistence
 * state, kept free of host imports so tests can drive them directly.
 *
 * Ported from @aiti-ai/pi-secret-mask src/commands.ts; storage paths point at
 * the DSH home (~/.dsh) instead of ~/.pi/agent.
 */

import { homedir } from "node:os";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIN_REDACT_LENGTH, Registry, type RegistryEntry } from "./mask.ts";

export interface SecretState {
  registry: Registry;
  enabled: boolean;
  salt: string;
  /** Persistence bucket key (workspace root; config.workspaceDir or process.cwd()). */
  cwd: string;
  /** Entry fields persisted/restored across sessions (opt-in). */
  persisted: boolean;
  /** Per-send wire-payload audit (proof log). */
  audit: boolean;
  /** Summary of the most recent audit scan (set by the audit hook). */
  lastAudit?: string;
}

export const PERSIST_PATH = join(homedir(), ".dsh", "secret-mask.json");

export function maskablePreview(entry: RegistryEntry): string {
  const v = entry.value;
  if (v.length <= 8) return "*".repeat(v.length);
  return `${"*".repeat(Math.max(4, Math.min(16, v.length - 8)))}${v.slice(-4)}`;
}

export function listText(state: SecretState): string {
  const entries = state.registry.entries();
  if (entries.length === 0) return "secret-mask: no registered values this session.";
  const lines = entries.map((e) => {
    const src = e.source === "manual" ? "manual" : `auto(${e.ruleId ?? "?"})`;
    return `- ${e.placeholder}  [${src}]  ${e.value.length} chars  …${maskablePreview(e)}`;
  });
  return `secret-mask: ${entries.length} value(s) registered:\n${lines.join("\n")}`;
}

export function statusText(state: SecretState): string {
  const n = state.registry.size;
  return `secret-mask: ${state.enabled ? "ON" : "OFF"}; ${n} value(s) registered; persistence ${state.persisted ? "saved for this workspace" : "off (session-only)"}; send-audit ${state.audit ? "ON" : "OFF"}${state.lastAudit ? `; last: ${state.lastAudit}` : ""}.`;
}

export const AUDIT_LOG_PATH = join(homedir(), ".dsh", "secret-mask-audit.log");

export interface AuditResult {
  time: string;
  sessionId: string;
  purpose: string;
  strings: number;
  placeholders: number;
  leaks: number;
  leakedLabels: string[];
}

/** Append one audit line to the evidence log (never contains raw values). */
export function appendAuditLog(result: AuditResult, path: string = AUDIT_LOG_PATH): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(result) + "\n", { mode: 0o600 });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function readAuditTail(maxLines = 5, path: string = AUDIT_LOG_PATH): string[] {
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function parseAdd(args: string): { value: string; alias?: string } | undefined {
  // `add <value> as <alias>` — split on the last standalone " as "
  const m = /\s+as\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(args);
  if (m) return { value: args.slice(0, m.index).trim(), alias: m[1] };
  return { value: args.trim() };
}

export type CommandOutcome = { ok: true; text: string } | { ok: false; text: string };

/** Handle a `/secret <args>` invocation and return the user-facing message. */
export function handleSecretCommand(state: SecretState, rawArgs: string): Promise<CommandOutcome> {
  return handleSync(state, rawArgs.trim());
}

async function handleSync(state: SecretState, args: string): Promise<CommandOutcome> {
  const [cmd, ...rest] = args.length ? args.split(/\s+/) : [""];
  const tail = args.slice(cmd.length).trim();

  switch (cmd) {
    case "":
    case "help": {
      return {
        ok: true,
        text: [
          "secret-mask commands:",
          "  /secret add <value> [as <alias>]   register a value (kept out of the session log)",
          "  /secret list                       show registered values (masked preview)",
          "  /secret remove <alias|label>       unregister one value",
          "  /secret clear                      unregister all",
          "  /secret on | off                   enable/disable redaction for this session",
          "  /secret status                     current state",
          "  /secret save | unload              persist values for this workspace / drop them",
          "  /secret audit [on|off|show]        per-send wire-payload proof log",
        ].join("\n"),
      };
    }
    case "add": {
      const value = tail;
      if (!value) return { ok: false, text: "Usage: /secret add <value> [as <alias>]  (the value never reaches the model and is not written to the session log)" };
      const parsed = parseAdd(value);
      if (!parsed || !parsed.value) return { ok: false, text: "Usage: /secret add <value> [as <alias>]" };
      const res = state.registry.registerManual(parsed.value, parsed.alias);
      if (!res) return { ok: false, text: `secret-mask: value rejected (must be at least ${MIN_REDACT_LENGTH} characters).` };
      const note = res.replaced ? " (replaced previous entry for this value)" : "";
      return { ok: true, text: `secret-mask: registered ${res.entry.placeholder}${note}` };
    }
    case "list":
      return { ok: true, text: listText(state) };
    case "remove": {
      if (!tail) return { ok: false, text: "Usage: /secret remove <alias|label>" };
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
    case "audit": {
      const arg = tail.trim();
      if (arg === "on" || arg === "") {
        state.audit = true;
        return { ok: true, text: `secret-mask: send-audit ON — every model request is scanned for registered raw values; evidence appended to ${AUDIT_LOG_PATH}` };
      }
      if (arg === "off") {
        state.audit = false;
        return { ok: true, text: "secret-mask: send-audit OFF." };
      }
      if (arg === "show") {
        const lines = readAuditTail();
        return { ok: true, text: lines.length ? `secret-mask audit evidence (last ${lines.length}):\n${lines.join("\n")}` : "secret-mask: no audit evidence yet (turn /secret audit on)." };
      }
      return { ok: false, text: "Usage: /secret audit [on|off|show]" };
    }
    case "status":
      return { ok: true, text: statusText(state) };
    case "save": {
      const err = savePersist(state);
      if (err) return { ok: false, text: `secret-mask: save failed: ${err}` };
      state.persisted = true;
      return { ok: true, text: `secret-mask: ${state.registry.size} value(s) persisted for ${state.cwd} (0600, values stay on this machine).` };
    }
    case "unload": {
      const err = clearPersist(state.cwd);
      state.persisted = false;
      if (err) return { ok: false, text: `secret-mask: unload failed: ${err}` };
      return { ok: true, text: `secret-mask: persisted values for ${state.cwd} removed (session entries kept).` };
    }
    default:
      return { ok: false, text: `secret-mask: unknown subcommand "${cmd}". Try /secret help.` };
  }
}

// ---------------------------------------------------------------------------
// persistence (opt-in, per-workspace bucket, 0600)
// ---------------------------------------------------------------------------

interface PersistFile {
  version: 1;
  projects: Record<string, Array<{ placeholder: string; value: string; label: string; alias?: string; source: "manual" | "auto"; ruleId?: string }>>;
}

export function savePersist(state: SecretState, path: string = PERSIST_PATH): string | undefined {
  try {
    let file: PersistFile = { version: 1, projects: {} };
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as PersistFile;
      if (parsed && parsed.version === 1 && parsed.projects) file = parsed;
    } catch {
      // no file yet or unparsable leftovers: start fresh
    }
    file.projects[state.cwd] = state.registry.entries().map((e) => ({
      placeholder: e.placeholder,
      value: e.value,
      label: e.label,
      alias: e.alias,
      source: e.source,
      ruleId: e.ruleId,
    }));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function clearPersist(cwd: string, path: string = PERSIST_PATH): string | undefined {
  try {
    let file: PersistFile = { version: 1, projects: {} };
    try {
      file = JSON.parse(readFileSync(path, "utf8")) as PersistFile;
    } catch {
      return undefined; // nothing persisted
    }
    delete file.projects[cwd];
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function loadPersist(state: SecretState, path: string = PERSIST_PATH): number {
  let n = 0;
  let file: PersistFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as PersistFile;
  } catch {
    return 0;
  }
  const bucket = file?.projects?.[state.cwd];
  if (!Array.isArray(bucket)) return 0;
  for (const e of bucket) {
    if (state.registry.byPlaceholderLookup(e.placeholder)) continue;
    const res =
      e.source === "manual" ? state.registry.registerManual(e.value, e.alias) : state.registry.registerAuto(e.value, e.ruleId ?? "unknown", e.label, state.salt);
    if (res) n++;
  }
  if (n > 0) state.persisted = true;
  return n;
}
