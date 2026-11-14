/**
 * aiti-provider-usage · provider 余额/配额查询扩展（pi-web 去 fork 化第二批 B1）
 *
 * 把 pi-web fork 的 provider-usage 适配器体系（15+ 家 provider，2026-09-13 落地）
 * 外迁为独立扩展；core 恢复上游 v0.9.1 原实现（8 家官方直连 + ModelsConfig 内嵌
 * Summary）。上游每次演进 provider-usage 不再与我方冲突（原 -336 替换型分歧清零）。
 *
 * 架构：
 *   - server：适配器注册表（adapters/* 自注册）+ aggregate 总览（TTL 5min、并发 3）
 *     + 单查门面；经宿主 api 分发（/api/extensions/aiti-provider-usage/*，自带门禁）
 *   - client：sessionInfoPanel 插槽渲染「剩余额度」面板（当前会话 provider 置顶展开）；
 *     feature 开关即时回落（关 → 面板消失，上游同形 = 信息面板无余额区）
 *   - 认证零配置：宿主 loader 已把 @earendil-works/* alias 到宿主 node_modules
 *     （同版本同实例），ModelRuntime.getAuth 与 core 同源
 *
 * 契约：docs/pi-web-defork-batch-2026-09-plan.md §2；插槽 lib/ext/types.ts sessionInfoPanel。
 */
import { isProviderUsageId, invalidateUsageOverviewCache, queryProviderUsage, queryUsageOverview } from "./lib/server/index.ts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export default {
  id: "aiti-provider-usage",
  name: "Provider Usage",
  client: "dist/aiti-provider-usage.mjs",
  icon: "icons/chart-column.svg",
  // 服务出口（2026-09-17）：aiti-model-wizard 等消费方经 ctx.services 取余额总览，
  // 复用同一份 TTL 缓存/并发闸门——不新增上游请求面（跨扩展通信一律 ctx.services）
  provides: ["aiti-provider-usage.overview"],
  features: [
    {
      id: "providerUsage.enabled",
      type: "boolean",
      label: "剩余额度面板",
      placeholder: "会话信息面板余额区块（15+ 家 provider）；关闭后信息面板不显示余额区（上游同形）",
      enabled: true,
    },
  ],
  ui: {
    sessionInfoPanel: [{ id: "panel", label: "剩余额度" }],
    // i18n：8 个 fork key 随 UI 外迁（core 已删同名 key，恢复上游 key 集）；另含
    // 上游 Summary 7 key 的自持副本——扩展自包含，不依赖 core 翻译表。
    i18n: {
      "zh-CN": {
        "providerUsage.remainingQuota": "剩余额度",
        "providerUsage.currentSession": "当前会话",
        "providerUsage.loading": "查询中…",
        "providerUsage.limit": "限额",
        "providerUsage.exhausted": "已耗尽",
        "providerUsage.used": "已用",
        "providerUsage.stateRateLimited": "限流",
        "providerUsage.stateExhausted": "已用满",
        "providerUsage.updated": "更新于 {time}",
        "providerUsage.refresh": "刷新用量",
        "providerUsage.refreshing": "正在刷新用量",
        "providerUsage.available": "可用",
      },
      "zh-TW": {
        "providerUsage.remainingQuota": "剩餘額度",
        "providerUsage.currentSession": "當前會話",
        "providerUsage.loading": "查詢中…",
        "providerUsage.limit": "限額",
        "providerUsage.exhausted": "已耗盡",
        "providerUsage.used": "已用",
        "providerUsage.stateRateLimited": "限流",
        "providerUsage.stateExhausted": "已用滿",
        "providerUsage.updated": "更新於 {time}",
        "providerUsage.refresh": "重新整理用量",
        "providerUsage.refreshing": "正在重新整理用量",
        "providerUsage.available": "可用",
      },
      en: {
        "providerUsage.remainingQuota": "Remaining quota",
        "providerUsage.currentSession": "current session",
        "providerUsage.loading": "Loading…",
        "providerUsage.limit": "limit",
        "providerUsage.exhausted": "exhausted",
        "providerUsage.used": "used",
        "providerUsage.stateRateLimited": "rate limited",
        "providerUsage.stateExhausted": "used up",
        "providerUsage.updated": "Updated {time}",
        "providerUsage.refresh": "Refresh usage",
        "providerUsage.refreshing": "Refreshing usage",
        "providerUsage.available": "Available",
      },
    },
  },
  server: {
    startup(ctx: any) {
      // 服务出口：与 REST /overview 同面（薄包，无独立状态）。缺席 services 总线时静默（REST 仍可用）。
      try {
        ctx?.services?.provide?.("aiti-provider-usage.overview", {
          overview: (force?: boolean) => queryUsageOverview(force === true),
          query: (providerId: string) =>
            isProviderUsageId(providerId)
              ? queryProviderUsage(providerId)
              : Promise.resolve({ providerId, status: "unsupported", message: "Unsupported provider" }),
          invalidate: () => invalidateUsageOverviewCache(),
        });
      } catch { /* 服务总线不可用 → REST 端点兜底 */ }
    },
    api(req, ctx) {
      const path = ctx.path.join("/");
      if (ctx.method === "POST" && path === "overview") {
        return req
          .json()
          .catch(() => ({}))
          .then((body: { force?: unknown }) => {
            if (body?.force === true) invalidateUsageOverviewCache();
            return queryUsageOverview(body?.force === true).then((overview) => json(overview));
          });
      }
      if (ctx.method === "POST" && path === "query") {
        return req
          .json()
          .catch(() => ({}))
          .then((body: { providerId?: unknown }) => {
            const providerId = typeof body?.providerId === "string" ? body.providerId : "";
            if (!isProviderUsageId(providerId)) return json({ error: "Unsupported provider" }, 400);
            return queryProviderUsage(providerId).then((result) => json(result));
          });
      }
      return null;
    },
  },
};
