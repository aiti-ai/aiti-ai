/**
 * 模型可见性纯逻辑（pi-web /api/models 用）：临时禁用过滤 + aiti-model-check 可用性标注。
 *
 * 与 pi-models-combo 引擎 isVisibleModel 同源语义（provider/模型级 enabled:false 隐藏），
 * 但引擎补丁经 Next.js 多模块图不一定作用到 /api/models 的 ModelRuntime，故在此显式过滤兜底。
 * 纯函数、零宿主依赖，便于单测。
 */
import type { ModelsData } from "./models-cache";

/** aiti-model-check 探测/运行期状态归一化：ok=可用 / rl=限流429 / err=其它错误 / unprobed=未测。 */
export type AvailKind = "ok" | "rl" | "err" | "unprobed";

/**
 * aiti-model-check state.json 原始内容 → provider/model 可用性 Map（纯函数）。
 * 容忍缺字段/损坏条目（静默跳过），返回空 Map = 无状态可展示。
 * 字段语义与 aiti-model-check/core.cjs 的 stateFile 一致：
 *   lastProbedAt 缺省 → unprobed；lastOk → ok；rateLimited → rl；其余 → err。
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
  /** 当前可用性——仅展示提示，绝不据此自动禁用 */
  avail?: AvailKind;
  /** 该 provider 是否整体限流（全部模型当前都 429）——组头提示，不自动禁用 */
  providerRL?: boolean;
}

/** 解析 models.json 的临时禁用标记：provider 级 enabled:false + 模型级 enabled:false。 */
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
 * 从已有模型里过滤禁用项，并附上可用性标注（avail + provider 整体限流标记）。
 * 返回的 modelList 与 ModelsData.modelList 兼容（含 avail / providerRL 可选字段）。
 * @param visible   引擎 resolveVisibleModels 给的模型列表
 * @param modelsCfg models.json（parseDisabledModels 消费）
 * @param avail     provider/model → 可用性（aiti-model-check state.json；空 Map=无状态）
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
  // provider 整体限流：该 provider 的全部（启用）模型当前都 429
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
