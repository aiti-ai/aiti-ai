/**
 * Model visibility pure logic (used by pi-web /api/models): temporary-disable filtering +
 * availability annotation from the model-check extension.
 *
 * Same semantics as the model-combo extension engine's isVisibleModel (provider/model-level
 * enabled:false hides), but the engine's patch does not necessarily reach /api/models'
 * ModelRuntime through the Next.js multi-module graph, so this explicit filter acts as a
 * fallback. Pure functions, zero host dependencies, easy to unit test.
 */
import type { ModelsData } from "./models-cache";

/** Normalized probe/runtime state from the model-check extension: ok=available / rl=rate-limited (429) / err=other errors / unprobed=not probed. */
export type AvailKind = "ok" | "rl" | "err" | "unprobed";

/**
 * model-check extension state.json raw content → provider/model availability Map (pure function).
 * Tolerates missing fields/corrupt entries (silently skipped); an empty Map = no state to show.
 * Field semantics match the stateFile of the model-check extension's core.cjs:
 *   lastProbedAt missing → unprobed; lastOk → ok; rateLimited → rl; otherwise → err.
 */
export function parseModelCheckState(raw: unknown): Map<string, AvailKind> {
  const out = new Map<string, AvailKind>();
  const models = (raw as { models?: Record<string, { lastProbedAt?: number; lastOk?: boolean; rateLimited?: boolean }> } | null)?.models;
  if (!models || typeof models !== "object") return out;
  for (const [key, m] of Object.entries(models)) {
    if (!m || typeof m !== "object") continue;
    if (!m.lastProbedAt) out.set(key, "unprobed");
    else if (m.lastOk) out.set(key, "ok");
    else if (m.rateLimited) out.set(key, "rl");
    else out.set(key, "err");
  }
  return out;
}

export interface AnnotatedModelEntry {
  id: string;
  name: string;
  provider: string;
  input?: string[];
  /** Current availability — display hint only, never auto-disable based on it */
  avail?: AvailKind;
  /** Whether this provider is rate-limited as a whole (all models currently 429) — group-header hint, no auto-disable */
  providerRL?: boolean;
}

/** Parse models.json temporary-disable markers: provider-level enabled:false + model-level enabled:false. */
export function parseDisabledModels(providers: Record<string, unknown>): {
  disabledProviders: Set<string>;
  disabledModelIds: Map<string, Set<string>>;
} {
  const disabledProviders = new Set<string>();
  const disabledModelIds = new Map<string, Set<string>>();
  for (const [pid, pcfgRaw] of Object.entries(providers ?? {})) {
    const pcfg = pcfgRaw as Record<string, unknown> | null;
    if (!pcfg || typeof pcfg !== "object") continue;
    if (pcfg.enabled === false) disabledProviders.add(pid);
    if (!Array.isArray(pcfg.models)) continue;
    for (const mRaw of pcfg.models) {
      const m = mRaw as Record<string, unknown> | null;
      if (!m || typeof m !== "object" || m.enabled !== false) continue;
      const mid = String(m.id ?? m.model ?? "");
      if (!mid) continue;
      if (!disabledModelIds.has(pid)) disabledModelIds.set(pid, new Set());
      disabledModelIds.get(pid)!.add(mid);
    }
  }
  return { disabledProviders, disabledModelIds };
}

/**
 * Filter disabled models out of the given list and attach availability annotations
 * (avail + provider-wide rate-limit flag).
 * The returned modelList is compatible with ModelsData.modelList (including the optional
 * avail / providerRL fields).
 * @param visible   Model list from the engine's resolveVisibleModels
 * @param modelsCfg models.json (consumed by parseDisabledModels)
 * @param avail     provider/model → availability (model-check extension state.json; empty Map = no state)
 */
export function annotateVisibleModels<T extends { id: string; name: string; provider: string; input?: string[] }>(
  visible: readonly T[],
  modelsCfg: Record<string, unknown> | undefined | null,
  avail: Map<string, AvailKind>,
): AnnotatedModelEntry[] {
  const { disabledProviders, disabledModelIds } = parseDisabledModels((modelsCfg ?? {}) as Record<string, unknown>);
  const visibleModels = visible.filter(
    (m) => !disabledProviders.has(m.provider) && !disabledModelIds.get(m.provider)?.has(m.id),
  );
  // Provider-wide rate limiting: all (enabled) models of the provider are currently 429
  const providerAvailCount: Record<string, { rl: number; total: number }> = {};
  for (const m of visibleModels) {
    const c = (providerAvailCount[m.provider] ??= { rl: 0, total: 0 });
    c.total++;
    if (avail.get(`${m.provider}/${m.id}`) === "rl") c.rl++;
  }
  const providerRL = new Set<string>();
  for (const [pid, c] of Object.entries(providerAvailCount)) {
    if (c.total > 0 && c.rl === c.total) providerRL.add(pid);
  }
  return visibleModels.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    input: m.input,
    avail: avail.get(`${m.provider}/${m.id}`),
    ...(providerRL.has(m.provider) ? { providerRL: true } : {}),
  }));
}
