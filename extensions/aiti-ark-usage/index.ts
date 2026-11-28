/**
 * aiti-ark-usage · Volcano Ark plan-quota provider extension (first usage-adapter
 * provider on the open ctx.usageAdapters channel).
 *
 * Plan: internal plan doc pi-web-usage-adapter-provider-ext-plan.md (channel:
 * pi-web-pi-session-provider-quota §4-B1/B2).
 *
 * Zero UI: the display faces (stats chip / session-info account block / badge
 * Quota row / provider-usage overview + query) are all host surfaces that
 * already consume the usage-adapter registry. This extension only:
 *   - server.startup — registers one adapter per configured provider id
 *     (default ark-plan) into ctx.usageAdapters; the host removes them again
 *     on shutdown/reload (ownership ledger), so registration is idempotent.
 *   - server.api — config GET/POST (AK/SK storage; secrets never echoed) and
 *     a POST test probe that runs one live query on demand.
 *
 * The plan-quota endpoints (GetCodingPlanUsage / GetAFPUsage on the Volcano
 * control-plane gateway) require AK/SK — the models.json API key cannot query
 * quota. Config: <configDir>/config.json, read fresh on every query.
 */
import { createArkPlanAdapter, normalizeArkPlanPayload, type AdapterLike } from "./lib/adapter.ts";
import { isConfigured, maskSecret, readConfig, writeConfig, isVolcengineApiHost } from "./lib/config.ts";

let configDir = "";
/** Live adapters by provider id (for the test probe; refreshed at startup). */
const adapters = new Map<string, AdapterLike>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

export default {
  id: "aiti-ark-usage",
  name: "Ark Usage（火山方舟套餐余量）",
  icon: "icons/meter-vertical.svg",
  ai: {
    manage: true,
    intro: "火山方舟套餐余量（ark-plan）：引导填火山 AK/SK（API key 查不了套餐余量）、写扩展 config.json、注册 usage 适配器点亮 pi 会话三处配额显示与 provider 总览 ark-plan 行、用 test 探针验证",
    skills: "skills",
  },
  ui: {
    i18n: {
      en: {
        "ext.displayName": "Ark Usage (Volcano Ark plan quota)",
      },
    },
  },
  server: {
    startup(ctx: { configDir?: string; usageAdapters?: { register?: (adapter: unknown) => { ok: boolean; reason?: string } } }) {
      configDir = typeof ctx?.configDir === "string" && ctx.configDir ? ctx.configDir : "";
      adapters.clear();
      if (!configDir || !ctx?.usageAdapters?.register) return;
      const cfg = readConfig(configDir);
      // Registration is startup-pinned (the host ledger tracks ownership per
      // id); the AK/SK itself is re-read per query so edits apply immediately.
      const ids = cfg.providerIds && cfg.providerIds.length > 0 ? cfg.providerIds : ["ark-plan"];
      for (const id of ids) {
        const adapter = createArkPlanAdapter(configDir, id);
        try {
          const result = ctx.usageAdapters.register(adapter);
          if (result?.ok) adapters.set(id, adapter);
          else console.warn(`[aiti-ark-usage] host rejected adapter ${id}: ${result?.reason ?? "unknown"}`);
        } catch (e) {
          console.warn(`[aiti-ark-usage] usage-adapter registration skipped for ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
    async api(req: Request, ctx: { path: string[]; method: string }) {
      const path = (ctx.path ?? []).join("/");
      if (!configDir) return json({ ok: false, error: "Extension not started." }, 503);
      if (ctx.method === "GET" && path === "config") {
        const cfg = readConfig(configDir);
        return json({
          ok: true,
          configured: isConfigured(cfg),
          accessKeyId: maskSecret(cfg.accessKeyId),
          hasSecretAccessKey: Boolean(cfg.secretAccessKey),
          region: cfg.region ?? "cn-beijing",
          gatewayHost: cfg.gatewayHost ?? "open.volcengineapi.com",
          providerIds: adapters.size > 0 ? [...adapters.keys()] : (cfg.providerIds?.length ? cfg.providerIds : ["ark-plan"]),
          product: cfg.product ?? "auto",
        });
      }
      if (ctx.method === "POST" && path === "config") {
        const body = await req.json().catch(() => ({} as Record<string, unknown>));
        // Non-string/empty values are ignored by the normalizer; explicit nulls
        // would be dropped too — clearing a secret means writing a new value.
        const patch: Record<string, unknown> = {};
        for (const key of ["accessKeyId", "secretAccessKey", "region", "gatewayHost", "product", "providerIds"] as const) {
          if (body[key] !== undefined) patch[key] = body[key];
        }
        if (typeof patch.gatewayHost === "string" && patch.gatewayHost && !isVolcengineApiHost(patch.gatewayHost)) {
          return json({ ok: false, error: "gatewayHost must be a *.volcengineapi.com host." }, 400);
        }
        try {
          const merged = writeConfig(configDir, patch);
          return json({ ok: true, configured: isConfigured(merged), accessKeyId: maskSecret(merged.accessKeyId) });
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
      if (ctx.method === "POST" && path === "test") {
        const body = await req.json().catch(() => ({} as Record<string, unknown>));
        const id = typeof body.providerId === "string" && body.providerId ? body.providerId : "ark-plan";
        const adapter = adapters.get(id) ?? createArkPlanAdapter(configDir, id);
        try {
          const report = await adapter.query({ providerId: id, auth: {} });
          return json({ ok: true, providerId: id, report });
        } catch (e) {
          return json({ ok: false, providerId: id, error: e instanceof Error ? e.message : String(e) }, 200);
        }
      }
      if (ctx.method === "POST" && path === "normalize-check") {
        // Offline sanity: normalize a pasted payload without any network/AK/SK.
        const body = await req.json().catch(() => null);
        const payload = body && typeof body === "object" ? body as Record<string, unknown> : null;
        if (!payload) return json({ ok: false, error: "Body must be a JSON object." }, 400);
        try {
          return json({ ok: true, report: normalizeArkPlanPayload(payload, { providerId: "ark-plan", auth: {} }) });
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return json({ ok: false, error: "Unknown path. Use GET/POST config, POST test, POST normalize-check." }, 404);
    },
  },
};
