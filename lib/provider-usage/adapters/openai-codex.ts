import { registerJsonAdapter } from "../declarative";
import { clamp, number, record, stringValue, windowLabel } from "../helpers";
import type { UsageBucket, UsageReport } from "../types";

registerJsonAdapter({
  id: "openai-codex",
  displayName: "OpenAI Codex",
  origins: ["https://chatgpt.com"],
  url: () => "https://chatgpt.com/backend-api/wham/usage",
  normalize: (payload, ctx) => {
    const buckets: UsageBucket[] = [];
    const addGroup = (group: Record<string, unknown>, groupLabel: string, groupId: string) => {
      for (const [position, raw] of [["primary", group.primary_window], ["secondary", group.secondary_window]] as const) {
        const window = record(raw);
        const used = number(window?.used_percent);
        if (used === undefined) continue;
        const seconds = number(window?.limit_window_seconds);
        buckets.push({
          id: `${groupId}:${position}`,
          label: windowLabel(seconds),
          ...(groupId === "codex" ? {} : { groupLabel }),
          used: clamp(used),
          remaining: 100 - clamp(used),
          limit: 100,
          unit: "percent",
          ...(seconds && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
          ...(number(window?.reset_at) !== undefined ? { resetsAt: number(window?.reset_at) } : {}),
        });
      }
    };
    const rateLimit = record(payload.rate_limit);
    if (rateLimit) addGroup(rateLimit, "Codex", "codex");
    const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
    additional.forEach((item, index) => {
      const value = record(item);
      const rate = record(value?.rate_limit);
      if (rate) addGroup(rate, stringValue(value?.limit_name) ?? `Limit ${index + 1}`, stringValue(value?.metered_feature) ?? `additional-${index}`);
    });
    const metrics: UsageReport["metrics"] = [];
    const credits = record(payload.credits);
    if (credits?.unlimited === true) metrics.push({ id: "credits", label: "Credits", value: "Unlimited" });
    else if (number(credits?.balance) !== undefined) metrics.push({ id: "credits", label: "Credits", value: number(credits?.balance)!, unit: "count" });
    if (!buckets.length && !metrics.length) throw new Error("Codex returned no usage data.");
    return { providerId: ctx.providerId, providerName: "OpenAI Codex", capturedAt: Date.now(), buckets, metrics };
  },
});
