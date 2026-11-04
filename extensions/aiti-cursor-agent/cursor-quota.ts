/**
 * cursor-quota —— Cursor 账号用量/额度（agent-manager 统一「账号额度」行显示）。
 *
 * 官方接口（2026-09-13 本机实测，凭据 ~/.config/cursor/auth.json 的 accessToken）：
 *   POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 *   headers: Authorization: Bearer <accessToken> / Content-Type: application/json / Connect-Protocol-Version: 1
 *   → { billingCycleStart, billingCycleEnd,
 *       planUsage: { totalSpend, bonusSpend, remainingBonus, autoPercentUsed, apiPercentUsed, totalPercentUsed },
 *       spendLimitUsage: { pooledLimit, pooledRemaining, individualLimit, limitType, overallLimit, overallRemaining },
 *       displayThreshold, displayMessage, autoModelSelectedDisplayMessage, namedModelSelectedDisplayMessage }
 *
 * 归一化：unit="%"，used = totalPercentUsed，剩余 = 100 - used；分包 auto / api，消费上限非 0 时追加一行。
 * 纯模块（fetch 可注入）——token 仅服务端使用，绝不下发客户端。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CursorQuotaPackage {
  name?: string;
  usedPercent?: number;
  total?: number;
  remaining?: number;
  note?: string;
}

export type CursorQuotaView =
  | {
    available: true;
    display?: string;
    unit?: string;
    remaining?: number;
    total?: number;
    used?: number;
    usedPercent?: number;
    packages?: CursorQuotaPackage[];
    note?: string;
    expiresAt?: number;
    fetchedAt: number;
  }
  | { available: false; reason: string; note?: string; fetchedAt: number };

/** Cursor 凭据路径（Linux 实测 ~/.config/cursor/auth.json；旧路径 ~/.cursor/auth.json 兜底）。 */
export function cursorAuthPath(home = homedir()): string | null {
  const primary = join(home, ".config", "cursor", "auth.json");
  const legacy = join(home, ".cursor", "auth.json");
  if (existsSync(primary)) return primary;
  if (existsSync(legacy)) return legacy;
  return null;
}

/** 读 Cursor accessToken（无凭据/坏文件 → null）。 */
export function readCursorToken(home = homedir()): string | null {
  const p = cursorAuthPath(home);
  if (!p) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { accessToken?: unknown };
    return typeof j.accessToken === "string" && j.accessToken ? j.accessToken : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  // 实测：billingCycleEnd 等字段为数字字符串
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};
const pctLeft = (used: number): number => Math.round(Math.max(0, Math.min(100, 100 - used)) * 10) / 10;

/** GetCurrentPeriodUsage 响应 → 归一化视图（纯函数）。 */
export function normalizeCursorUsage(raw: unknown, now = Date.now()): CursorQuotaView {
  const d = (raw ?? {}) as Record<string, unknown>;
  const plan = (d.planUsage ?? {}) as Record<string, unknown>;
  const totalUsed = num(plan.totalPercentUsed);
  if (totalUsed === undefined) {
    return { available: false, reason: "unparsed", note: "Cursor 用量响应未识别（缺 planUsage.totalPercentUsed）", fetchedAt: now };
  }
  const auto = num(plan.autoPercentUsed);
  const api = num(plan.apiPercentUsed);
  const packages: CursorQuotaPackage[] = [];
  if (auto !== undefined) packages.push({ name: "自动模型（auto）", usedPercent: auto });
  if (api !== undefined) packages.push({ name: "API 模型", usedPercent: api });
  packages.push({ name: "总用量", usedPercent: totalUsed });
  const spend = (d.spendLimitUsage ?? {}) as Record<string, unknown>;
  const limit = num(spend.overallLimit) ?? num(spend.pooledLimit);
  const left = num(spend.overallRemaining) ?? num(spend.pooledRemaining);
  if ((limit ?? 0) > 0) packages.push({ name: "消费上限", note: `上限 ${limit} / 剩余 ${left ?? 0}` });

  const cycleEnd = num(d.billingCycleEnd);
  const msg = typeof d.displayMessage === "string" && d.displayMessage.trim() ? d.displayMessage.trim() : undefined;
  return {
    available: true,
    display: `额度 剩余 ${pctLeft(totalUsed)}%`,
    unit: "%",
    used: totalUsed,
    usedPercent: totalUsed,
    remaining: pctLeft(totalUsed),
    total: 100,
    packages,
    ...(msg ? { note: msg } : {}),
    ...(cycleEnd !== undefined ? { expiresAt: cycleEnd } : {}),
    fetchedAt: now,
  };
}

/** 拉 Cursor 用量（fetchImpl 可注入；超时/非 200/异常 → throw，由调用方回落 available:false）。 */
export async function fetchCursorQuota(opts: {
  token: string;
  timeoutMs?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<CursorQuotaView> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchFn("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Cursor 用量接口 HTTP ${res.status}`);
    return normalizeCursorUsage(await res.json(), opts.now);
  } finally {
    clearTimeout(timer);
  }
}
