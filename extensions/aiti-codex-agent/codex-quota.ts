/**
 * codex-quota —— Codex CLI（ChatGPT 账号）额度（agent-manager 统一「账号额度」行显示）。
 *
 * 凭据：~/.codex/auth.json → tokens.access_token（兼容顶层 access_token；account_id = tokens.account_id）。
 * 接口：GET https://chatgpt.com/backend-api/wham/usage
 *   headers: Authorization: Bearer <token> + chatgpt-account-id: <account_id>（有则带）
 *
 * ⚠ 本机当前无 codex 登录，响应形状按社区已知的 rate_limits 结构做**防御式解析**（多种命名兼容），
 *   **待真机校准**；解析不到窗口时返回 available:false（不会误报）。token 仅服务端使用，绝不下发客户端。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexQuotaPackage {
  name?: string;
  usedPercent?: number;
  note?: string;
}

export type CodexQuotaView =
  | {
    available: true;
    display?: string;
    unit?: string;
    used?: number;
    usedPercent?: number;
    remaining?: number;
    total?: number;
    packages?: CodexQuotaPackage[];
    note?: string;
    fetchedAt: number;
  }
  | { available: false; reason: string; note?: string; fetchedAt: number };

export interface CodexCreds {
  token: string;
  accountId?: string;
}

/** 读 Codex OAuth 凭据（无凭据/坏文件 → null）。 */
export function readCodexCreds(home = homedir()): CodexCreds | null {
  const p = join(home, ".codex", "auth.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as {
      access_token?: unknown;
      account_id?: unknown;
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const t = j.tokens ?? {};
    const token = (typeof t.access_token === "string" && t.access_token)
      || (typeof j.access_token === "string" && j.access_token)
      || "";
    if (!token) return null;
    const accountId = (typeof t.account_id === "string" && t.account_id)
      || (typeof j.account_id === "string" && j.account_id)
      || undefined;
    return { token, ...(accountId ? { accountId } : {}) };
  } catch {
    return null;
  }
}

const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};
const pick = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};
const pctLeft = (used: number): number => Math.round(Math.max(0, Math.min(100, 100 - used)) * 10) / 10;

/** 窗口时长（分钟）→ 显示名（5h / 周 / Nh）。 */
function windowLabel(minutes?: number): string {
  if (minutes === undefined) return "窗口";
  if (minutes <= 360) return "5h";
  if (minutes >= 1440 * 5) return "周";
  return `${Math.max(1, Math.round(minutes / 60))}h`;
}

/** wham/usage 响应 → 归一化视图（纯函数；防御式兼容多命名，解析不到 = unparsed）。 */
export function normalizeCodexUsage(raw: unknown, now = Date.now()): CodexQuotaView {
  const root = (raw ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const limits = pick(data, ["rate_limits", "rateLimits", "rate_limit", "rateLimit"]) as Record<string, unknown> | undefined;
  const planType = pick(data, ["plan_type", "planType"]);
  const windows: Array<{ used: number; minutes?: number; resetInSec?: number }> = [];

  const readWindow = (w: unknown): void => {
    if (!w || typeof w !== "object") return;
    const o = w as Record<string, unknown>;
    const used = num(pick(o, ["used_percent", "usedPercent"]));
    if (used === undefined) return;
    const minutes = num(pick(o, ["window_minutes", "windowMinutes"]))
      ?? (() => {
        const sec = num(pick(o, ["window_seconds", "windowSeconds", "limit_window_seconds", "limitWindowSeconds"]));
        return sec !== undefined ? sec / 60 : undefined;
      })();
    const resetInSec = num(pick(o, ["resets_in_seconds", "resetsInSeconds", "reset_after_seconds", "resetAfterSeconds"]));
    windows.push({ used, ...(minutes !== undefined ? { minutes } : {}), ...(resetInSec !== undefined ? { resetInSec } : {}) });
  };

  if (limits) {
    readWindow(pick(limits, ["primary_window", "primaryWindow", "primary"]));
    readWindow(pick(limits, ["secondary_window", "secondaryWindow", "secondary"]));
    const arr = pick(limits, ["windows", "buckets"]);
    if (Array.isArray(arr)) for (const w of arr) readWindow(w);
  }
  if (!windows.length) {
    // 兼容：顶层直接给窗口
    readWindow(pick(data, ["primary_window", "primaryWindow"]));
    readWindow(pick(data, ["secondary_window", "secondaryWindow"]));
  }
  if (!windows.length) {
    return { available: false, reason: "unparsed", note: "codex 额度响应未识别（待真机校准）", fetchedAt: now };
  }

  const fmtReset = (sec?: number): string | undefined => {
    if (sec === undefined) return undefined;
    try { return new Date(now + sec * 1000).toLocaleString(); } catch { return undefined; }
  };
  const packages: CodexQuotaPackage[] = windows.map((w) => {
    const reset = fmtReset(w.resetInSec);
    return { name: windowLabel(w.minutes), usedPercent: w.used, ...(reset ? { note: `重置于 ${reset}` } : {}) };
  });
  const primary = windows[1] ?? windows[0]; // 次窗口通常是周额度，作主指标
  const displayParts = windows
    .slice(0, 2)
    .map((w) => `${windowLabel(w.minutes)} 剩余 ${pctLeft(w.used)}%`);
  return {
    available: true,
    display: `额度 ${displayParts.join(" · ")}`,
    unit: "%",
    used: primary.used,
    usedPercent: primary.used,
    remaining: pctLeft(primary.used),
    total: 100,
    packages,
    ...(typeof planType === "string" && planType ? { note: `套餐：${planType}` } : {}),
    fetchedAt: now,
  };
}

/** 拉 Codex 用量（fetchImpl 可注入；超时/非 200/异常 → throw，调用方回落 available:false）。 */
export async function fetchCodexQuota(opts: {
  token: string;
  accountId?: string;
  timeoutMs?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<CodexQuotaView> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchFn("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(opts.accountId ? { "chatgpt-account-id": opts.accountId } : {}),
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Codex 用量接口 HTTP ${res.status}`);
    return normalizeCodexUsage(await res.json(), opts.now);
  } finally {
    clearTimeout(timer);
  }
}
