/**
 * Vault landing mode adapter (G1 `vault`): values auto-detected in prompt
 * text are led into the encrypted library and remounted as stable
 * placeholders. Re-detection of the same value reuses the existing alias, so
 * repeated pastes do not grow the vault.
 */

import type { Registry } from "@aiti-ai/secret-mask-core";
import { findAliasForValue, suggestAutoAlias } from "./entries.ts";
import type { VaultStore } from "./store.ts";

export interface VaultLandingState {
  store: VaultStore;
  registry: Registry;
}

export interface LandingResult {
  alias: string;
  placeholder: string;
  created: boolean;
}

/**
 * Store `value` in the vault (unless already present) and mount it as a
 * stable placeholder. Returns `undefined` when the vault is locked or the
 * value cannot be stored — callers keep the ordinary session entry then.
 */
export function landValueInVault(state: VaultLandingState, value: string, label: string): LandingResult | undefined {
  try {
    let alias = findAliasForValue(state.store, value);
    let created = false;
    if (!alias) {
      alias = suggestAutoAlias(label, value);
      state.store.add(alias, value, { desc: `auto-captured from prompt (${label})`, tags: ["auto"] });
      created = true;
    }
    const res = state.registry.registerStable(value, alias);
    if (!res) return undefined;
    return { alias, placeholder: res.entry.placeholder, created };
  } catch {
    return undefined;
  }
}
