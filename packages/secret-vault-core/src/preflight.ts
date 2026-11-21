/**
 * Pre-send preflight: stricter detection + masking for a human-confirmed gate.
 *
 * The automatic path must never guess (a wrong guess silently rewrites the
 * user's words). A pre-send confirmation can afford to guess, because the human
 * sees the list and picks. So this module offers medium-confidence candidates on
 * top of the normal hits, and applies masking only to the indices the human
 * accepted.
 *
 * Zero-value by design: `preflightScan` returns masked previews only, and
 * `preflightMask` re-scans the same text deterministically, so the client never
 * has to send values back. Indices are positions in the deterministic candidate
 * list for that exact text.
 */

import {
  STABLE_NAMESPACE,
  previewValue,
  scanCandidates,
  stablePlaceholder,
  type Candidate,
} from "@aiti-ai/secret-mask-core";
import { suggestAutoAlias } from "./entries.ts";
import type { VaultStore } from "./store.ts";

export interface PreflightCandidate {
  /** Position in the candidate list for this text; what `preflightMask` accepts. */
  index: number;
  label: string;
  ruleId: string;
  confidence: "high" | "medium";
  /** Masked preview (`ark-1a2b…c5de`) — never the value. */
  preview: string;
  /** An alias already holds this exact value (masking reuses it). */
  stored: boolean;
}

export interface PreflightScanOptions {
  /** Include medium-confidence candidates (the confirmed path is meant to). */
  strict?: boolean;
}

export interface PreflightScanResult {
  candidates: PreflightCandidate[];
  /** Vault is locked: masking will fail, so the UI must not offer it. */
  locked: boolean;
}

export interface PreflightMaskResult {
  text: string;
  aliases: string[];
}

function candidatesOf(store: VaultStore, text: string, opts: PreflightScanOptions): Candidate[] {
  return scanCandidates(text, { strict: opts.strict ?? true });
}

/**
 * value → alias for the whole vault, one decryption per entry. Looking up each
 * candidate separately (value × entries decryptions) makes the confirmation
 * dialog wait on AES for no reason.
 */
function valueIndex(store: VaultStore): Map<string, string> {
  const index = new Map<string, string>();
  let entries: ReturnType<VaultStore["list"]>;
  try {
    entries = store.list();
  } catch {
    return index;
  }
  for (const info of entries) {
    try {
      const value = store.get(info.alias).value;
      if (!index.has(value)) index.set(value, info.alias);
    } catch {
      // locked/undecryptable entry: simply not offered as "already stored"
    }
  }
  return index;
}

/**
 * Candidates for a confirmation list. Values never leave the server: each entry
 * carries a masked preview plus whether the vault already stores that value.
 */
export function preflightScan(store: VaultStore, text: string, opts: PreflightScanOptions = {}): PreflightScanResult {
  // `status().locked` only means "no key loaded yet" (lazy). Probe the key so the
  // UI hint is accurate: a fresh store is not locked (the first write creates the
  // keyfile); an existing keyfile that cannot load is genuinely locked.
  let locked = false;
  try {
    store.keyFor(false);
  } catch {
    locked = store.initialized;
  }
  const index = locked ? new Map<string, string>() : valueIndex(store);
  const candidates = candidatesOf(store, text, opts).map((hit, position) => ({
    index: position,
    label: hit.label,
    ruleId: hit.id,
    confidence: hit.confidence,
    preview: previewValue(hit.value),
    stored: index.has(hit.value),
  }));
  return { candidates, locked };
}

/**
 * Store the accepted candidates in the vault and replace them in `text` with the
 * stable placeholder the agent side already understands (same token a mounted
 * alias produces, so tool-argument restore keeps working).
 */
export function preflightMask(
  store: VaultStore,
  text: string,
  indices: number[],
  opts: PreflightScanOptions & { tags?: string[] } = {},
): PreflightMaskResult {
  const hits = candidatesOf(store, text, opts);
  const wanted = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < hits.length).sort((a, b) => b - a);
  if (wanted.length === 0) return { text, aliases: [] };

  let masked = text;
  const aliases: string[] = [];
  const known = valueIndex(store);
  for (const index of wanted) {
    const hit = hits[index]!;
    let alias = known.get(hit.value);
    if (!alias) {
      alias = suggestAutoAlias(hit.label || hit.id, hit.value);
      const res = store.add(alias, hit.value, { desc: "pre-send preflight", tags: opts.tags ?? ["preflight"] });
      known.set(hit.value, res.alias ?? alias);
    }
    const token = stablePlaceholder(STABLE_NAMESPACE, alias);
    // Replace from the end so earlier offsets stay valid.
    masked = masked.slice(0, hit.start) + token + masked.slice(hit.end);
    if (!aliases.includes(alias)) aliases.push(alias);
  }
  return { text: masked, aliases };
}
