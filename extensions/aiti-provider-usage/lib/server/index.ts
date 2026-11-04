import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import "./adapters/index.ts";
import { queryUsageTargets, resolveUsageTargets } from "./key-pool.ts";
import { assertOfficialOrigin } from "./secure-fetch.ts";
import { getUsageAdapter, listUsageAdapters } from "./registry.ts";
import type { ProviderUsageResult, UsageReport } from "./types.ts";
import type { ProviderUsageId } from "./ids.ts";

export { PROVIDER_USAGE_IDS, isProviderUsageId, type ProviderUsageId } from "./ids.ts";
export { queryUsageOverview, invalidateUsageOverviewCache, type UsageOverview, type OverviewEntry } from "./aggregate.ts";
export { listUsageAdapters, registerUsageAdapter, getUsageAdapter } from "./registry.ts";
export type { UsageBucket, UsageMetric, UsageReport, ProviderUsageResult, ProviderUsageStatus, UsageAdapter } from "./types.ts";

// 单 provider 查询门面（原 pi-web fork lib/provider-usage.ts 的注册表形态）：
// 优先精确/origin 匹配适配器执行；无适配器 = unsupported（core 上游实现只覆盖
// 8 家官方直连，本扩展 15+ 家全量，ModelsConfig 上游 Summary 兜底不冲突）。

export async function queryProviderUsage(providerId: ProviderUsageId): Promise<ProviderUsageResult> {
  let runtime: ModelRuntime;
  try {
    runtime = await ModelRuntime.create({ refreshOnCreate: false });
  } catch {
    return { providerId, status: "query-failed", message: "The provider runtime is unavailable." };
  }
  const provider = runtime.getProvider(providerId);
  const adapter = getUsageAdapter(providerId, provider?.baseUrl);
  if (!adapter) return { providerId, status: "unsupported", message: "This provider does not support usage queries." };

  // Runtime credential, or the models.json rotation pool for proxied multi-key
  // providers (pi-models-combo hands out dummy tokens; see key-pool.ts).
  const targets = await resolveUsageTargets(runtime, providerId);
  if (!targets) {
    return { providerId, status: "auth-unavailable", message: "Connect this provider before querying usage." };
  }

  try {
    const report: UsageReport = await queryUsageTargets(adapter, targets);
    return { providerId, status: "ready", report };
  } catch (caught) {
    return { providerId, status: "query-failed", message: caught instanceof Error ? caught.message : "The provider usage query failed." };
  }
}

/** 凭据只发官方 origin（adapter.origins 白名单；测试同款断言面）。 */
export function isOfficialProviderUsageOrigin(providerId: ProviderUsageId, baseUrl: string | undefined): boolean {
  const adapter = getUsageAdapter(providerId);
  if (!adapter || !baseUrl) return false;
  try {
    assertOfficialOrigin(adapter.origins, new URL(baseUrl).origin);
    return true;
  } catch {
    return false;
  }
}

/** 载荷归一（无网络；测试/重归一用）。 */
export function normalizeProviderUsagePayload(
  providerId: ProviderUsageId,
  payload: Record<string, unknown>,
  _capturedAt = Date.now(),
): UsageReport {
  const adapter = getUsageAdapter(providerId);
  if (!adapter?.normalize) throw new Error(`No usage adapter for ${providerId}.`);
  return adapter.normalize(payload, { providerId, auth: {} });
}
