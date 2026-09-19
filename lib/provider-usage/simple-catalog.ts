import { registerJsonAdapter } from "./declarative";
import { decimal, number, record } from "./helpers";
import type { UsageReport } from "./types";

// Simple balance-style providers: one declaration row per provider/region.
// Complex window protocols live in adapters/*.ts instead.

function checkEnvelope(payload: Record<string, unknown>, name: string): void {
  if (payload.code !== undefined && payload.code !== 200 && number(payload.code) !== 0) {
    throw new Error(`${name} returned an unsuccessful response.`);
  }
}

registerJsonAdapter({
  id: "deepseek",
  displayName: "DeepSeek",
  origins: ["https://api.deepseek.com"],
  url: () => "https://api.deepseek.com/user/balance",
  normalize: (payload, ctx) => {
    const metrics: UsageReport["metrics"] = [
      { id: "availability", label: "API calls", value: payload.is_available === true ? "Available" : "Unavailable" },
    ];
    const rows = Array.isArray(payload.balance_infos) ? payload.balance_infos : [];
    for (const rowValue of rows) {
      const row = record(rowValue);
      if (!row) continue;
      const currency = row.currency === "CNY" || row.currency === "USD" ? row.currency : undefined;
      if (!currency) continue;
      for (const [id, label, field] of [
        ["total", "Total balance", "total_balance"],
        ["granted", "Granted balance", "granted_balance"],
        ["topped-up", "Topped-up balance", "topped_up_balance"],
      ] as const) {
        const amount = decimal(row[field]);
        if (amount !== undefined) metrics.push({ id: `${currency.toLowerCase()}-${id}`, label, value: amount, unit: "currency", currency });
      }
    }
    if (rows.length === 0) throw new Error("DeepSeek returned no balance data.");
    return { providerId: ctx.providerId, providerName: "DeepSeek", capturedAt: Date.now(), buckets: [], metrics };
  },
});

for (const [id, origin, currency, name] of [
  ["moonshotai", "https://api.moonshot.ai", "USD", "Moonshot AI"],
  ["moonshotai-cn", "https://api.moonshot.cn", "CNY", "Moonshot AI CN"],
] as const) {
  registerJsonAdapter({
    id,
    displayName: name,
    origins: [origin],
    url: () => `${origin}/v1/users/me/balance`,
    normalize: (payload, ctx) => {
      const data = record(payload.data);
      if (payload.code !== 0 || payload.status !== true || !data) throw new Error("Moonshot returned an unsuccessful response.");
      const metrics = [
        ["available", "Available balance", data.available_balance],
        ["voucher", "Voucher balance", data.voucher_balance],
        ["cash", "Cash balance", data.cash_balance],
      ].flatMap(([key, label, value]) => {
        const amount = number(value);
        return amount === undefined ? [] : [{ id: String(key), label: String(label), value: String(amount), unit: "currency" as const, currency }];
      });
      if (!metrics.length) throw new Error("Moonshot returned no balance data.");
      return { providerId: ctx.providerId, providerName: name, capturedAt: Date.now(), buckets: [], metrics };
    },
  });
}

registerJsonAdapter({
  id: "vercel-ai-gateway",
  displayName: "Vercel AI Gateway",
  origins: ["https://ai-gateway.vercel.sh"],
  url: () => "https://ai-gateway.vercel.sh/v1/credits",
  normalize: (payload, ctx) => {
    const balance = decimal(payload.balance);
    const used = decimal(payload.total_used);
    if (balance === undefined && used === undefined) throw new Error("Vercel returned no credit data.");
    return {
      providerId: ctx.providerId,
      providerName: "Vercel AI Gateway",
      capturedAt: Date.now(),
      buckets: [],
      metrics: [
        ...(balance !== undefined ? [{ id: "balance", label: "Credit balance", value: balance, unit: "currency" as const, currency: "USD" }] : []),
        ...(used !== undefined ? [{ id: "spent", label: "Lifetime spend", value: used, unit: "currency" as const, currency: "USD" }] : []),
      ],
    };
  },
});

for (const [id, origin, name] of [
  ["siliconflow", "https://api.siliconflow.com", "SiliconFlow"],
  ["siliconflow-cn", "https://api.siliconflow.cn", "SiliconFlow CN"],
] as const) {
  registerJsonAdapter({
    id,
    displayName: name,
    origins: [origin],
    url: () => `${origin}/v1/user/info`,
    normalize: (payload, ctx) => {
      checkEnvelope(payload, name);
      const data = record(payload.data);
      if (!data) throw new Error("SiliconFlow returned no user data.");
      const metrics = [
        ["balance", "Cash balance", data.balance],
        ["charge", "Charged balance", data.chargeBalance],
        ["voucher", "Gift balance", data.voucherBalance],
        ["total", "Total balance", data.totalBalance],
      ].flatMap(([key, label, value]) => {
        const amount = decimal(value);
        return amount === undefined ? [] : [{ id: String(key), label: String(label), value: amount, unit: "currency" as const, currency: "CNY" }];
      });
      if (!metrics.length) throw new Error("SiliconFlow returned no balance data.");
      return { providerId: ctx.providerId, providerName: name, capturedAt: Date.now(), buckets: [], metrics };
    },
  });
}
