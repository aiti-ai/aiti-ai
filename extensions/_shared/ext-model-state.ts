/**
 * ext-model-state — shared module for external agent sessions' "temporary model state file" (authoritative source).
 *
 * Each external agent session handle owns one JSON file:
 *   ~/.pi/agent/ext-agents/<agentKey>/<sanitized-handle-id>.json
 *
 * Responsibilities (requirement: on startup or switch, persist pi's models into a temporary config file to steer the external agent):
 *   1. Records the currently selected model (selected) → each extension's spawn args (--model/-m) derive from it,
 *      so the model choice survives session reopen / process restart;
 *   2. Carries the merged model catalog (external's own + pi's flattened models.json) →
 *      getAvailableModels takes the pi part from here, so the model picker groups external/pi on one screen;
 *   3. Atomic writes (tmp + rename); bad JSON/missing directory always fail-soft (return null/[]);
 *   4. Every write also maintains the agent's "last used model" KV (`<agentKey>/_last-model.json`) —
 *      the default model for each agent's new sessions (per-agent last used, matching pi's defaultModel semantics)
 *      can be read from it; extensions need not track/scan on their own.
 *
 * This file is copied per deployment unit into each extension directory (aiti-*-agent/ext-model-state.ts);
 * sync the copies after changing it (same pattern as cursor-cli-store.ts).
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** pi's model registry (~/.pi/agent/models.json, {providers:{<key>:{models:[…]}}}). */
export function piModelsConfigPath(): string {
  return process.env.PI_MODELS_CONFIG_PATH || join(homedir(), ".pi", "agent", "models.json");
}

/** Reads pi models.json and flattens it into merged catalog entries (unreadable/bad JSON → [], fail-soft). */
export async function readPiModels(): Promise<ExtModelEntry[]> {
  try {
    const raw = await readFile(piModelsConfigPath(), "utf8");
    return piModelsFromModelsConfig(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Merged catalog entry: source distinguishes the external's own catalog from pi's. */
export type ExtModelEntry = {
  id: string;
  provider: string;
  label?: string;
  source?: "ext" | "pi";
  /** Right-aligned dim text in the model picker row (e.g. qoder billing coefficient "0.5x").
   *  Locale-neutral string rendered as-is; absent → host falls back to the provider id. */
  hint?: string;
  /** Server marked the model unavailable (gateway enable:false — quota exhausted / plan state).
   *  Disabled rows stay visible (greyed, not selectable) instead of being filtered out, so an
   *  all-models-disabled account no longer looks like a broken catalog. */
  disabled?: boolean;
  /** Short pill tag from catalog metadata ("New" / "Free" / server-off-peak promo). Locale-keyed;
   *  the host renders it in the picker row with the active locale. */
  badge?: { en: string; zh: string };
};

export type ExtModelState = {
  agentKey: string;
  sessionId: string;
  selected?: { provider: string; id: string };
  models: ExtModelEntry[];
  updatedAt: string;
};

/** State file root directory (overridable via EXT_MODEL_STATE_DIR, for tests). */
export function extModelStateDir(): string {
  return process.env.EXT_MODEL_STATE_DIR || join(homedir(), ".pi", "agent", "ext-agents");
}

/** handle id → safe file name (composite ids like claude:<uuid>; colons/slashes etc. all sanitized; falls back to "session" when no alphanumerics remain). */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : "session";
}

export function extModelStatePath(agentKey: string, sessionId: string): string {
  return join(extModelStateDir(), sanitizeId(agentKey), `${sanitizeId(sessionId)}.json`);
}

/** The agent's "last used model" KV file name (reserved name inside the agent directory; excluded from state GC/scans). */
export const AGENT_LAST_MODEL_FILE = "_last-model.json";

export function agentLastModelPath(agentKey: string): string {
  return join(extModelStateDir(), sanitizeId(agentKey), AGENT_LAST_MODEL_FILE);
}

/**
 * In-process last-used snapshot (agentKey → most recently known value + file mtime):
 *  - read: the in-memory snapshot wins (no content re-read; on a hit a single mtime check runs —
 *    only if the file was deleted or rewritten by another process (dev/prod dual instances share the
 *    state directory) does it fall back to reading the KV file), on miss it reads the file and backfills;
 *  - write: identical repeated writes are skipped outright (no disk write); on a hit the same mtime
 *    check verifies the file was not rewritten elsewhere.
 * State writes trigger on setModel/session creation; repeated reads/writes of the same model must not
 * amplify file IO.
 */
const lastModelCache = new Map<string, { provider: string; id: string; mtimeMs: number }>();

/** Test hook: clears the in-process last-used snapshot (isolates read/skip-write behavior across cases). */
export function resetAgentLastModelCacheForTests(): void {
  lastModelCache.clear();
}

/** Atomic write of "this agent's last used model" (directory auto-created; identical repeated writes skipped; failure only warns). */
export async function writeAgentLastModel(agentKey: string, selected: { provider: string; id: string }): Promise<void> {
  const file = agentLastModelPath(agentKey);
  const cached = lastModelCache.get(agentKey);
  if (cached && cached.provider === selected.provider && cached.id === selected.id) {
    try {
      const st = await stat(file);
      if (st.mtimeMs === cached.mtimeMs) return; // unchanged and not rewritten elsewhere → skip write
    } catch { /* file deleted/unreadable → rewrite */ }
  }
  try {
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
    await writeFile(tmp, JSON.stringify({ agentKey, selected, updatedAt: new Date().toISOString() }, null, 2));
    await rename(tmp, file);
    const st = await stat(file).catch(() => null);
    lastModelCache.set(agentKey, { provider: selected.provider, id: selected.id, mtimeMs: st?.mtimeMs ?? 0 });
  } catch (e) {
    console.warn(`[ext-model-state] last-model write failed (${file}):`, e instanceof Error ? e.message : e);
  }
}

/**
 * Reads "this agent's last used model": the in-memory snapshot wins (no file content read; on a hit a
 * single mtime check runs — only if the file was deleted or rewritten by another instance (dev/prod
 * shared directory) does it fall back to disk); on miss it reads the dedicated KV (`_last-model.json`)
 * and backfills memory; pre-existing installs (KV not yet created) fall back to scanning the directory
 * for the state file with the newest mtime. Missing/corrupt → null (fail-soft). The caller validates
 * legitimacy (channel/directory presence).
 */
export async function readAgentLastUsedModel(agentKey: string): Promise<{ provider: string; id: string } | null> {
  const file = agentLastModelPath(agentKey);
  const cached = lastModelCache.get(agentKey);
  if (cached) {
    try {
      const st = await stat(file);
      if (st.mtimeMs === cached.mtimeMs) return { provider: cached.provider, id: cached.id };
    } catch { /* file deleted → falls through to the disk read/fallback scan below */ }
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { selected?: { provider?: unknown; id?: unknown } };
    const selected = parsed?.selected;
    if (selected && typeof selected.id === "string" && selected.id) {
      const value = {
        provider: typeof selected.provider === "string" && selected.provider ? selected.provider : agentKey,
        id: selected.id,
      };
      const st = await stat(file).catch(() => null);
      lastModelCache.set(agentKey, { ...value, mtimeMs: st?.mtimeMs ?? 0 });
      return value;
    }
  } catch { /* KV missing/corrupt → fallback scan */ }
  return readLatestSelectedModel(agentKey);
}

/** Atomic state write (directory auto-created; failure only warns — the state file never blocks the main flow). */
let writeSeq = 0;
export async function writeExtModelState(state: ExtModelState): Promise<void> {
  const file = extModelStatePath(state.agentKey, state.sessionId);
  const dir = join(file, "..");
  try {
    await mkdir(dir, { recursive: true });
    // Concurrent-write collision guard: two writes with the same pid in the same millisecond must not share a tmp name
    const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
    await rename(tmp, file);
    // Also updates the agent's "last used model" KV (dedicated small file; the frontend/new-session-page default
    // entry matches pi's defaultModel semantics). A failed write does not block the main flow — the reader falls back to the mtime scan when the KV is missing.
    if (state.selected?.id) await writeAgentLastModel(state.agentKey, state.selected);
  } catch (e) {
    console.warn(`[ext-model-state] write failed (${file}):`, e instanceof Error ? e.message : e);
    return;
  }
  // Opportunistic GC: after a successful write, clean up expired states (non-blocking, silent on failure)
  void pruneExpiredStates(dir, file);
}

/** State retention: session states not updated for 30 days count as stale (the session long gone). */
export const EXT_MODEL_STATE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Directory-level throttle: at most one scan per directory per process (avoids a stat storm on every write). */
const prunedDirs = new Set<string>();

/** Deletes old state files past the retention period under the directory (keepFile excepted). Cleanup never throws. */
export async function pruneExpiredStates(dir: string, keepFile?: string): Promise<number> {
  if (prunedDirs.has(dir)) return 0;
  prunedDirs.add(dir);
  let removed = 0;
  try {
    const now = Date.now();
    for (const f of await readdir(dir)) {
      if (!f.endsWith(".json")) continue;
      if (f === AGENT_LAST_MODEL_FILE) continue; // last-used KV kept long-term (does not represent an existing session)
      const p = join(dir, f);
      if (p === keepFile) continue;
      try {
        const st = await stat(p);
        if (now - st.mtimeMs > EXT_MODEL_STATE_RETENTION_MS) {
          await rm(p, { force: true });
          removed++;
        }
      } catch { /* single-file failure does not affect the rest */ }
    }
  } catch { /* directory missing etc. — silent */ }
  return removed;
}

/** Reads state; returns null when missing/corrupt (fail-soft). */
export async function readExtModelState(agentKey: string, sessionId: string): Promise<ExtModelState | null> {
  try {
    const raw = await readFile(extModelStatePath(agentKey, sessionId), "utf8");
    const parsed = JSON.parse(raw) as ExtModelState;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Reads "this agent's last used model" (per-agent last used, matching pi's defaultModel semantics):
 * takes selected from the state file with the newest mtime under the agentKey directory — state files
 * are written on createSession and on every setModel, so the newest one is the model the agent last
 * actually used. Missing directory/no files/bad JSON → null (fail-soft). The caller validates
 * legitimacy (channel/directory presence).
 */
export async function readLatestSelectedModel(agentKey: string): Promise<{ provider: string; id: string } | null> {
  const dir = join(extModelStateDir(), sanitizeId(agentKey));
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== AGENT_LAST_MODEL_FILE);
    let newest: { file: string; mtimeMs: number } | null = null;
    for (const f of files) {
      try {
        const st = await stat(join(dir, f));
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file: f, mtimeMs: st.mtimeMs };
      } catch { /* skip on single-file failure */ }
    }
    if (!newest) return null;
    const parsed = JSON.parse(await readFile(join(dir, newest.file), "utf8")) as ExtModelState;
    const selected = parsed?.selected;
    if (!selected || typeof selected.id !== "string" || !selected.id) return null;
    return {
      provider: typeof selected.provider === "string" && selected.provider ? selected.provider : agentKey,
      id: selected.id,
    };
  } catch {
    return null;
  }
}

/** Rebinds to the real id (session_backend_ready): moves the old file under the new id's name. */
export async function renameExtModelState(agentKey: string, fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const from = extModelStatePath(agentKey, fromId);
  const to = extModelStatePath(agentKey, toId);
  try {
    await mkdir(join(to, ".."), { recursive: true });
    await rename(from, to);
  } catch {
    // old file missing (fresh session's first write) or cross-device — ignore; the next write overwrites
  }
}

/** Deletes state (optional call on dispose; by default kept for reopen recovery). */
export async function removeExtModelState(agentKey: string, sessionId: string): Promise<void> {
  try {
    await rm(extModelStatePath(agentKey, sessionId), { force: true });
  } catch { /* ignore */ }
}

/**
 * Flattens pi's models.json ({providers:{<key>:{apiKey,api,baseUrl,models:[{id,name,api,contextWindow,…}]}}})
 * into merged catalog entries: provider normalized to "pi" (picker groups it separately), label annotated with protocol/window.
 */
export function piModelsFromModelsConfig(config: unknown): ExtModelEntry[] {
  const providers = (config as { providers?: Record<string, unknown> } | null)?.providers;
  if (!providers || typeof providers !== "object") return [];
  const out: ExtModelEntry[] = [];
  for (const [provKey, prov] of Object.entries(providers as Record<string, unknown>)) {
    const models = (prov as { models?: unknown }).models;
    if (!Array.isArray(models)) continue;
    for (const m of models as Array<Record<string, unknown>>) {
      if (typeof m?.id !== "string" || !m.id) continue;
      const bits: string[] = [];
      if (typeof m.api === "string" && m.api) bits.push(String(m.api));
      if (typeof m.contextWindow === "number" && m.contextWindow > 0) bits.push(`${Math.round(m.contextWindow / 1024)}k`);
      const hint = piCostHint(m);
      out.push({
        id: m.id,
        provider: "pi",
        label: bits.length > 0 ? `${String(m.name ?? m.id)} · ${bits.join(" · ")}` : String(m.name ?? m.id),
        source: "pi",
        ...(hint ? { hint } : {}),
      });
      void provKey; // pi's catalog is flattened per model; the source provider key stays out of the UI (avoids clashing with provider-grouping semantics)
    }
  }
  return out;
}

/**
 * A models.json model's cost (pi ModelCost, USD per million tokens) → picker row hint ("$0.6/$2.2 per M").
 * Format matches the host's lib/model-visibility.ts formatModelCostHint (cross-layer copy; sync both when changing format);
 * cache rates/tiers excluded (slot too narrow); missing/all-zero → no hint (no invented data).
 */
function piCostHint(m: { cost?: { input?: unknown; output?: unknown } | null }): string | undefined {
  const c = m.cost;
  if (!c || typeof c !== "object") return undefined;
  const inRate = typeof c.input === "number" && Number.isFinite(c.input) ? c.input : null;
  const outRate = typeof c.output === "number" && Number.isFinite(c.output) ? c.output : null;
  if (inRate === null && outRate === null) return undefined;
  if ((inRate ?? 0) === 0 && (outRate ?? 0) === 0) return undefined;
  const trim = (n: number) => n.toFixed(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `$${trim(inRate ?? 0)}/$${trim(outRate ?? 0)} per M`;
}

/**
 * Merged catalog: the external's own entries first (source:"ext"), pi's entries after (source:"pi");
 * deduplicated by provider+id (first come first served — the external's own catalog wins).
 */
export function mergeModelCatalogs(external: ExtModelEntry[], piModels: ExtModelEntry[]): ExtModelEntry[] {
  const seen = new Set<string>();
  const out: ExtModelEntry[] = [];
  for (const m of [...external, ...piModels]) {
    const key = `${m.provider}/${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Catalog ordering with the current model first (the picker highlights the current entry by default).
 *  When the catalog contains the current model, that entry moves to the front (keeping label and other metadata — a synthesized entry would lose the label and produce a bare ref row);
 *  only when absent from the catalog (e.g. an old ref before channel collapse) is a minimal entry synthesized to the front. */
export function withCurrentFirst(models: ExtModelEntry[], current?: { id: string; provider: string; label?: string }): ExtModelEntry[] {
  if (!current?.id) return models;
  const idx = models.findIndex((m) => m.id === current.id && m.provider === current.provider);
  if (idx < 0) return [{ ...current, source: "ext" as const }, ...models];
  return [models[idx], ...models.slice(0, idx), ...models.slice(idx + 1)];
}

/**
 * Static catalog with the "last used model" pinned to the top — promoted only when hit by id within the
 * catalog (keeping the original entry's provider/label), never synthesized. The static catalog feeds the
 * new-session page's default entry (the frontend takes list[0]); using withCurrentFirst would synthesize
 * a bare entry for a pi model whose provider mismatches → duplicated list rows.
 * No hit / already first → original array.
 *  If the hit row is disabled (server-disabled, quota exhausted, etc.) it must not be
 *  promoted — the default entry has to be selectable; promote the first enabled row
 *  instead and leave disabled rows in place (still listed, see ExtModelEntry.disabled).
 */
export function withLastUsedFirst(models: ExtModelEntry[], lastUsedId?: string | null): ExtModelEntry[] {
  if (!lastUsedId) return models;
  const idx = models.findIndex((m) => m.id === lastUsedId);
  if (idx < 0) return models;
  if (models[idx].disabled) {
    // A disabled last-used must not become the default: promote the first enabled row;
    // no enabled row (or already first) → original order.
    const enabled = models.findIndex((m) => !m.disabled);
    if (enabled <= 0) return models;
    return [models[enabled], ...models.slice(0, enabled), ...models.slice(enabled + 1)];
  }
  if (idx <= 0) return models;
  return [models[idx], ...models.slice(0, idx), ...models.slice(idx + 1)];
}
