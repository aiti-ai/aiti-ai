/**
 * /vault command logic — human-only write surface for the encrypted library.
 *
 * Value entry paths (`add`, `set`, `capture`, `import`, `import-env`) never
 * print the value: `add`/`set` use masked interactive input, `capture` stores
 * command stdout directly, imports read files/environment. `reveal` shows a
 * value only through the host dialog/clipboard, never into the transcript.
 */

import { existsSync } from "node:fs";
import { assessPasswordStrength, describePasswordWeakness } from "@aiti-ai/secret-mask-core";
import { Registry } from "@aiti-ai/secret-mask-core";
import { captureIntoVault, importEnvFile, importProcessEnv, type ImportResult } from "./entries.ts";
import { VaultError, type AddResult, type VaultScope, type VaultStore } from "./store.ts";
import { formatEntryLine, mountAlias } from "./tools.ts";

export interface VaultCommandState {
  store: VaultStore;
  registry: Registry;
  sessionId: string;
  cwd: string;
}

export interface VaultCommandIo {
  /** Masked input: the typed value must never reach the chat transcript. */
  input?: (prompt: string) => Promise<string | undefined>;
  confirm?: (prompt: string) => Promise<boolean>;
  show?: (title: string, value: string) => void;
  copy?: (value: string) => void;
  notify?: (text: string, level?: "info" | "warning" | "error") => void;
}

export type VaultCommandOutcome = { ok: true; text: string } | { ok: false; text: string };

interface AddArgs {
  alias?: string;
  desc?: string;
  project: boolean;
  tags?: string[];
}

function parseAddArgs(tail: string): AddArgs {
  const tokens = tail.split(/\s+/).filter(Boolean);
  const out: AddArgs = { project: false };
  if (tokens.length === 0) return out;
  out.alias = tokens.shift();
  const desc: string[] = [];
  while (tokens.length > 0) {
    const token = tokens.shift()!;
    if (token === "--project") {
      out.project = true;
      continue;
    }
    if (token === "--tags") {
      const value = tokens.shift();
      if (value) out.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
      continue;
    }
    desc.push(token);
  }
  if (desc.length) out.desc = desc.join(" ");
  return out;
}

function flag(tokens: string[], name: string): boolean {
  const at = tokens.indexOf(name);
  if (at < 0) return false;
  tokens.splice(at, 1);
  return true;
}

function importSummary(label: string, res: ImportResult): string {
  const weak = res.weak.length ? ` ⚠ weak password: ${res.weak.join(", ")}` : "";
  return `${label}: ${res.added} added, ${res.rotated} rotated, ${res.skipped} skipped.${weak}`;
}

export async function handleVaultCommand(
  state: VaultCommandState,
  rawArgs: string,
  io: VaultCommandIo = {},
): Promise<VaultCommandOutcome> {
  const args = rawArgs.trim();
  const [cmd, ...rest] = args.length ? args.split(/\s+/) : [""];
  const tail = args.slice(cmd.length).trim();
  const tokens = rest.slice();

  switch (cmd) {
    case "":
    case "help":
      return { ok: true, text: helpText() };

    case "add":
    case "set": {
      const parsed = parseAddArgs(tail);
      if (!parsed.alias) return { ok: false, text: `Usage: /vault ${cmd} <alias> [description] [--project] [--tags a,b]` };
      if (cmd === "set" && !state.store.find(parsed.alias)) {
        return { ok: false, text: `vault: no entry named "${parsed.alias}" — use /vault add to create it.` };
      }
      if (!io.input) return { ok: false, text: "vault: this host has no masked input surface." };
      const value = await io.input(`Value for "${parsed.alias}" (input is kept out of the chat)`);
      if (!value || !value.trim()) return { ok: false, text: "vault: cancelled." };
      try {
        const res = state.store.add(parsed.alias, value, { desc: parsed.desc, tags: parsed.tags, project: parsed.project });
        return { ok: true, text: describeAdd(res) };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }

    case "capture": {
      // /vault capture <alias> [--project] -- <command...>
      const sep = tail.indexOf(" -- ");
      if (sep < 0) return { ok: false, text: "Usage: /vault capture <alias> [--project] -- <command>" };
      const head = tail.slice(0, sep).trim();
      const command = tail.slice(sep + 4).trim();
      const headTokens = head.split(/\s+/).filter(Boolean);
      const alias = headTokens.shift();
      const project = flag(headTokens, "--project");
      if (!alias || !command) return { ok: false, text: "Usage: /vault capture <alias> [--project] -- <command>" };
      try {
        const cwd = existsSync(state.cwd) ? state.cwd : process.cwd();
        const res = await captureIntoVault(state.store, alias, command, { project, cwd });
        return { ok: true, text: describeAdd(res) + " (value captured from command output; never echoed)" };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }

    case "import": {
      const rest2 = tail.split(/\s+/).filter(Boolean);
      const project = flag(rest2, "--project");
      const path = rest2[0];
      if (!path) return { ok: false, text: "Usage: /vault import <file.env> [--project]" };
      try {
        return { ok: true, text: importSummary(`vault import ${path}`, importEnvFile(state.store, path, { project })) };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }

    case "import-env": {
      const project = flag(tokens, "--project");
      try {
        return { ok: true, text: importSummary("vault import-env", importProcessEnv(state.store, { project })) + " (secret-named variables only)" };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }

    case "list": {
      const scope = flag(tokens, "--project") ? "project" : flag(tokens, "--global") ? "global" : undefined;
      let entries;
      try {
        entries = state.store.list(scope ? { scope: scope as VaultScope } : {});
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
      if (entries.length === 0) return { ok: true, text: "vault: no entries (add one with /vault add <alias>)." };
      const lines = entries.map((e) => {
        let weak = false;
        try {
          weak = assessPasswordStrength(state.store.get(e.alias).value).weak;
        } catch {
          // locked entries are not flagged
        }
        return formatEntryLine(e, weak);
      });
      return { ok: true, text: `vault: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}` };
    }

    case "remove": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault remove <alias>" };
      if (!state.store.find(alias)) return { ok: false, text: `vault: no entry named "${alias}".` };
      const confirmed = io.confirm
        ? await io.confirm(`Delete "${alias}" from the vault? This cannot be undone.`)
        : (await io.input?.(`Type "${alias}" again to confirm deletion`)) === alias;
      if (!confirmed) return { ok: false, text: "vault: cancelled." };
      const removed = state.store.remove(alias);
      state.registry.forgetByLabel(alias);
      return { ok: true, text: `vault: removed "${alias}" (${removed} record(s)); mounted placeholder invalidated.` };
    }

    case "reveal": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault reveal <alias>" };
      try {
        const entry = state.store.get(alias);
        if (!io.show && !io.copy) return { ok: false, text: "vault: this host has no dialog/clipboard surface; refusing to print the value into the transcript." };
        io.show?.(`vault: ${alias}`, entry.value);
        io.copy?.(entry.value);
        const strength = assessPasswordStrength(entry.value);
        const weakNote = strength.weak ? ` ⚠ weak password (${describePasswordWeakness(strength)}); consider rotating it.` : "";
        return {
          ok: true,
          text: `vault: "${alias}" ${io.show ? "shown in a dialog" : ""}${io.show && io.copy ? " and " : ""}${io.copy ? "copied to the clipboard" : ""} — never printed into the session.${weakNote}`,
        };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }

    case "get": {
      const alias = tokens[0];
      if (!alias) return { ok: false, text: "Usage: /vault get <alias> (mounts the alias; prints only its placeholder)" };
      try {
        const mounted = mountAlias(state, alias);
        const weakNote = mounted.weak ? " ⚠ weak password — consider rotating it." : "";
        return { ok: true, text: `vault: mounted "${alias}" as ${mounted.placeholder} (v${mounted.version}, ${mounted.scope}).${weakNote}` };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }

    case "scope": {
      const st = state.store.status();
      return { ok: true, text: `vault scopes:\n- global:  ${st.scopes.global}\n- project: ${st.scopes.project}  (${state.cwd})` };
    }

    case "mode": {
      const requested = tokens[0];
      const current = state.store.status();
      if (!requested) {
        const backend = current.keychainBackend === "unavailable" ? "unavailable on this machine" : current.keychainBackend;
        return {
          ok: true,
          text: [
            `vault unlock mode: ${current.mode}`,
            `- keyfile: 32-byte key at ${state.store.keyPath}`,
            `- keychain: OS credential store (backend: ${backend})`,
            "switching modes regenerates the key and re-encrypts every vault file.",
          ].join("\n"),
        };
      }
      if (requested !== "keyfile" && requested !== "keychain") return { ok: false, text: "Usage: /vault mode [keyfile|keychain]" };
      if (requested === current.mode) return { ok: true, text: `vault: already in ${requested} mode.` };
      const confirmed = io.confirm
        ? await io.confirm(`Switch the vault to ${requested} mode? The master key is regenerated and every entry re-encrypted.`)
        : true;
      if (!confirmed) return { ok: false, text: "vault: cancelled." };
      try {
        const res = state.store.rekeyTo(requested);
        return { ok: true, text: `vault: unlock mode → ${requested} (${res.files} file(s) re-encrypted with a fresh key).` };
      } catch (e) {
        return { ok: false, text: errorText(e) };
      }
    }

    case "lock": {
      state.store.lock();
      return { ok: true, text: "vault: locked (the next read/write needs the keyfile again)." };
    }

    case "unlock": {
      const res = state.store.unlock();
      return res.ok
        ? { ok: true, text: `vault: unlocked (keyfile ${state.store.keyPath}).` }
        : { ok: false, text: `vault: unlock failed: ${res.error}` };
    }

    case "forget": {
      const mounted = state.registry.entries().filter((e) => e.source === "vault");
      for (const entry of mounted) state.registry.forgetByLabel(entry.alias ?? entry.label);
      return { ok: true, text: `vault: unmounted ${mounted.length} alias(es); their placeholders are now invalid (guarded).` };
    }

    case "status": {
      const st = state.store.status();
      const mounted = state.registry.entries().filter((e) => e.source === "vault").length;
      return {
        ok: true,
        text: [
          `vault: ${st.initialized ? (st.locked ? "locked" : "unlocked") : "not initialized"} (mode: ${st.mode}, keychain: ${st.keychainBackend})`,
          `keyfile: ${st.keyfile}`,
          `entries: ${st.globalEntries} global + ${st.projectEntries} project; mounted in this session: ${mounted}`,
          `dir: ${st.dir}`,
        ].join("\n"),
      };
    }

    default:
      return { ok: false, text: `vault: unknown subcommand "${cmd}". Try /vault help.` };
  }
}

function describeAdd(res: AddResult): string {
  const scope = res.scope === "project" ? "project" : "global";
  const shadow = res.shadowed ? " (warning: a same-alias project entry shadows this global value)" : "";
  const weak = res.weak ? ` ⚠ weak password (${res.weakReasons.join(", ")}) — stored anyway; consider rotating to a stronger one.` : "";
  return `vault: ${res.created ? "added" : "rotated"} "${res.alias}" v${res.version} [${scope}]${shadow}${weak}`;
}

function errorText(e: unknown): string {
  if (e instanceof VaultError) return e.message;
  return `vault: ${e instanceof Error ? e.message : String(e)}`;
}

function helpText(): string {
  return [
    "vault commands (values never appear in the transcript):",
    "  /vault add <alias> [desc] [--project] [--tags a,b]   masked input; existing alias = rotate (version+1)",
    "  /vault set <alias>                                  rotate an existing alias",
    "  /vault capture <alias> [--project] -- <command>     stdout into the vault (never echoed)",
    "  /vault import <file.env> [--project]                KEY=value / export KEY=value",
    "  /vault import-env [--project]                       scan this process env (secret-named vars)",
    "  /vault list [--global|--project]                    aliases + metadata (zero values)",
    "  /vault get <alias>                                  mount alias → placeholder (prints token only)",
    "  /vault reveal <alias>                               dialog + clipboard only, never the transcript",
    "  /vault remove <alias>                               delete (asks for confirmation)",
    "  /vault forget                                       unmount all aliases for this session",
    "  /vault scope | mode | lock | unlock | status",
  ].join("\n");
}
