/**
 * provider-quota-convert — pure shape conversion for the pi-session provider
 * quota fallback (plan: pi-web-pi-session-provider-quota §4-A2).
 *
 * provider-usage's UsageReport (windows/balance metrics, see
 * lib/provider-usage/types.ts) → the session-level UsageReport snapshot the
 * get_usage protocol consumers expect (lib/session/types.ts: the same shape
 * qoder/zcode handles return from getUsage()).
 *
 * Zero runtime imports (types only): unit tests import this file directly and
 * never touch the ModelRuntime query chain.
 *
 * Conversion rules (deep-review §7.1/§7.2):
 *   - count-window buckets (real allowance limits) → snapshot `buckets` detail
 *     rows, with stable i18n-friendly names when recognizable (5h→five_hour,
 *     1w→weekly, 30d/1mo→monthly_credits; raw label as fallback).
 *   - percent windows (limit=100) are NOT emitted as detail rows ("45/100"
 *     reads as noise); their signal is folded into `credits.usedPercent`
 *     (tightest window wins).
 *   - balance-style providers (deepseek/moonshot: currency metrics, no
 *     windows) → `credits {remaining, unit: currency}` from the first numeric
 *     currency metric — without this branch those providers light up nowhere.
 *   - `quotaExceeded` ← report.exhausted; `provider` ← report.providerId.
 *   - Token/cost fields are intentionally left unset: pi sessions already
 *     report tokens via getSessionStats; mixing the two would double-count.
 */

import type { UsageBucket, UsageReport } from "./types.ts";
import type { UsageBucket as ProviderBucket, UsageMetric, UsageReport as ProviderReport } from "../provider-usage/types.ts";

/** Recognizable window labels → stable bucket names shared by the three quota
 *  UIs' i18n tables (am.quota.pkg.* / badge.bucket.* / providerUsage.bucket.*).
 *  Source shapes: zai's windowLabel ("5h" / "1w" / "1mo"), limit.type words
 *  ("monthly credit"), and generic "30d" spellings. First match wins. */
const NAME_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^5\s*h/i, "five_hour"],
  [/^(1\s*w|7\s*d)/i, "weekly"],
  [/^(30\s*d|1\s*mo)/i, "monthly_credits"],
];

function stableBucketName(label: string): string {
  for (const [pattern, name] of NAME_PATTERNS) {
    if (pattern.test(label)) return name;
  }
  return label;
}

function bucketUsedPercent(bucket: ProviderBucket): number | undefined {
  if (bucket.used !== undefined && bucket.limit !== undefined && bucket.limit > 0) {
    return Math.min(100, Math.max(0, Math.round((bucket.used / bucket.limit) * 100)));
  }
  if (bucket.unit === "percent" && bucket.remaining !== undefined) {
    return Math.min(100, Math.max(0, Math.round(100 - bucket.remaining)));
  }
  return undefined;
}

/** Tightest-window usedPercent across all buckets (count + percent alike). */
function tightestUsedPercent(buckets: ProviderBucket[]): number | undefined {
  let worst: number | undefined;
  for (const bucket of buckets) {
    const pct = bucketUsedPercent(bucket);
    if (pct !== undefined && (worst === undefined || pct > worst)) worst = pct;
  }
  return worst;
}

/** Balance-style providers: first numeric currency metric (adapters emit their
 *  primary balance first, e.g. deepseek total_balance) → credits. */
function creditsFromBalanceMetrics(metrics: UsageMetric[]): UsageReport["credits"] {
  for (const metric of metrics) {
    if (metric.unit !== "currency" || typeof metric.value !== "number") continue;
    return { remaining: metric.value, ...(metric.currency ? { unit: metric.currency } : {}) };
  }
  return undefined;
}

export function providerReportToUsageSnapshot(report: ProviderReport, fallbackProviderId?: string): UsageReport {
  const detailBuckets: UsageBucket[] = [];
  for (const bucket of report.buckets) {
    const usedPercent = bucketUsedPercent(bucket);
    const common = {
      name: stableBucketName(bucket.label),
      ...(bucket.used !== undefined ? { used: bucket.used } : {}),
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(bucket.status === "exhausted" ? { limitReached: true } : {}),
    };
    if (bucket.unit === "percent") {
      // Share window (limit=100): emit as a detail row too (plan §7.3 feedback — the
      // badge/lists show EVERY window the provider reports, not just the binding one).
      // `remaining` stays the leftover share (73 = 73% left); consumers render
      // total===100 rows as percentages instead of "73/100".
      if (bucket.remaining !== undefined || bucket.limit !== undefined) {
        detailBuckets.push({
          ...common,
          total: bucket.limit ?? 100,
          ...(bucket.remaining !== undefined ? { remaining: bucket.remaining } : {}),
        });
      }
      continue;
    }
    if (bucket.limit === undefined || bucket.limit <= 0) continue;
    detailBuckets.push({
      ...common,
      total: bucket.limit,
      ...(bucket.remaining !== undefined ? { remaining: bucket.remaining } : {}),
    });
  }

  // Credits = the BINDING (tightest) window, expressed in REMAINING terms — same
  // language as every quota surface (provider rows read "1w 36%" = remaining share;
  // "64% used" next to it would read as a contradiction). zcode's verified semantics
  // (zcode-core quotaLimitToQuotaView) treat `percentage` as USED and pick the highest
  // as the binding window; we mirror that binding choice but lead with what is LEFT.
  // unit "%" + total 100 make the share explicit wherever the unit is rendered.
  const bindingPct = tightestUsedPercent(report.buckets);
  const credits = detailBuckets.length === 0
    ? creditsFromBalanceMetrics(report.metrics)
    : bindingPct !== undefined
      ? { remaining: 100 - bindingPct, total: 100, usedPercent: bindingPct, unit: "%" }
      : undefined;

  return {
    provider: report.providerId ?? fallbackProviderId,
    ...(detailBuckets.length > 0 ? { buckets: detailBuckets } : {}),
    ...(credits ? { credits } : {}),
    ...(report.exhausted ? { quotaExceeded: true } : {}),
  };
}
