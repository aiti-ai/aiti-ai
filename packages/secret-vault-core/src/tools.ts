/**
 * AI tool surface (read-only by design).
 *
 *   vault_list  → alias metadata only (never values)
 *   vault_get   → mounts the alias in the session registry and returns its
 *                 stable placeholder + the usage contract (the model must
 *                 pass the token verbatim; the runtime substitutes the value
 *                 inside tool arguments)
 *
 * No write/reveal tool is registered: the model cannot add, rotate, remove
 * or read the vault. Writing requires the human `/vault` command surface.
 */

import type { Registry } from "@aiti-ai/secret-mask-core";
import { assessPasswordStrength } from "@aiti-ai/secret-mask-core";
import { VaultError, type VaultEntryInfo, type VaultStore } from "./store.ts";

export const VAULT_GET_NOTE =
  "This token IS a working credential: pass it verbatim into tool arguments — the runtime materializes the real secret at execution time. " +
  "Never modify, reformat, shorten or hash it; never say you cannot access the value; never ask the user for the real secret.";

export interface VaultToolState {
  store: VaultStore;
  registry: Registry;
  sessionId?: string;
}

export interface TextToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export function formatEntryLine(info: VaultEntryInfo, weak = false): string {
  const tags = info.tags?.length ? ` (${info.tags.join(",")})` : "";
  const desc = info.desc ? ` — ${info.desc}` : "";
  const used = info.lastUsedAt ? ` · last used ${info.lastUsedAt}` : "";
  return `- ${info.alias} [${info.scope}] v${info.version}${desc}${tags}${used}${weak ? " ⚠ weak password" : ""}`;
}

/** Weak-password flag per alias (decrypts; no lastUsed touch). */
export function weakAliases(store: VaultStore): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const info of store.list()) {
    try {
      out[info.alias] = assessPasswordStrength(store.get(info.alias).value).weak;
    } catch {
      // locked / undecryptable entries are simply not flagged
    }
  }
  return out;
}

/** `vault_list` implementation (zero values). */
export function vaultList(state: VaultToolState, params: { tag?: string } = {}): TextToolResult {
  let entries: VaultEntryInfo[];
  try {
    entries = state.store.list();
  } catch (e) {
    if (e instanceof VaultError) throw e;
    throw new VaultError("vault-error", e instanceof Error ? e.message : String(e));
  }
  if (params.tag) entries = entries.filter((e) => e.tags?.includes(params.tag!));
  if (entries.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "The secret vault has no entries here (or none match the tag). Vault writes are human-only — ask the user to run " +
            "`/vault add <alias>` (interactive value input) and call vault_list again.",
        },
      ],
      details: { entries: [] },
    };
  }
  const weak = weakAliases(state.store);
  const text = [
    `Secret vault: ${entries.length} alias(es). Values are never returned — call vault_get with an alias to receive a placeholder.`,
    ...entries.map((e) => formatEntryLine(e, weak[e.alias] === true)),
  ].join("\n");
  return { content: [{ type: "text", text }], details: { entries: entries.map((e) => ({ ...e, weak: weak[e.alias] === true })) } };
}

export interface MountResult {
  alias: string;
  placeholder: string;
  desc?: string;
  scope: string;
  version: number;
  weak: boolean;
}

/**
 * Mount one alias into the session registry (stable placeholder) and update
 * the last-used attribution fields.
 */
export function mountAlias(state: VaultToolState, alias: string): MountResult {
  const entry = state.store.get(alias, { touch: true, sessionId: state.sessionId });
  const res = state.registry.registerStable(entry.value, alias);
  if (!res) throw new VaultError("mount-failed", `vault: could not mount "${alias}" (placeholder collision — /vault status)`);
  return {
    alias,
    placeholder: res.entry.placeholder,
    desc: entry.info.desc,
    scope: entry.scope,
    version: entry.info.version,
    weak: assessPasswordStrength(entry.value).weak,
  };
}

/** `vault_get` implementation: mounts the alias and returns its placeholder. */
export function vaultGet(state: VaultToolState, params: { alias?: string }): TextToolResult {
  const alias = params.alias?.trim();
  if (!alias) throw new VaultError("bad-args", "vault_get requires { alias } — call vault_list to see aliases");
  const mounted = mountAlias(state, alias);
  return {
    content: [
      {
        type: "text",
        text: [
          mounted.placeholder,
          "",
          VAULT_GET_NOTE,
          `(alias: ${mounted.alias}${mounted.desc ? ` — ${mounted.desc}` : ""}, v${mounted.version})`,
          ...(mounted.weak ? ["Note: this credential is a weak password — advise the user to rotate it."] : []),
        ].join("\n"),
      },
    ],
    details: { placeholder: mounted.placeholder, alias: mounted.alias, desc: mounted.desc, version: mounted.version, scope: mounted.scope, weak: mounted.weak },
  };
}
