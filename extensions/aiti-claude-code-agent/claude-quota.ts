/**
 * claude-quota —— Claude Code 账号额度（agent-manager 统一「账号额度」行显示）。
 *
 * 凭据：~/.claude/.credentials.json → claudeAiOauth.accessToken（兼容顶层 accessToken）。
 * 接口：GET https://api.anthropic.com/api/oauth/usage（社区已知端点，
 *   headers: Authorization: Bearer <token> / anthropic-version: 2023-06-01 / anthropic-beta: oauth-2025-04-20）
 *   → 窗口字段 five_hour / seven_day / seven_day_opus / seven_day_sonnet，各 { utilization: 0-100, resets_at: ISO }。
 *
 * ⚠ 本机当前无 claude 登录，接口形状按社区已知实现，**待真机校准**（正常化逻辑已用假响应单测覆盖；
 *   解析不到窗口时返回 available:false，不会误报）。token 仅服务端使用，绝不下发客户端。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeQuotaPackage {
  name?: string;
  usedPercent?: number;
  note?: string;
}

export type ClaudeQuotaView =
  | {
    available: true;
    display?: string;
    unit?: string;
    used?: number;
    usedPercent?: number;
    remaining?: number;
    total?: number;
    packages?: ClaudeQuotaPackage[];
    note?: string;
    expiresAt?: number;
    fetchedAt: number;
  }
  | { available: false; reason: string; note?: string; fetchedAt: number };

export interface ClaudeCreds {
  token: string;
  expiresAt?: number;
}

/** 读 Claude OAuth 凭据（无凭据/坏文件 → null）。 */
export function readClaudeCreds(home = homedir()): ClaudeCreds | null {
  const p = join(home, ".claude", ".credentials.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as {
      accessToken?: unknown;
      expiresAt?: unknown;
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = j.claudeAiOauth ?? {};
    const token = (typeof oauth.accessToken === "string" && oauth.accessToken)
      || (typeof j.accessToken === "string" && j.accessToken)
      || "";
    if (!token) return null;
    const rawExp = typeof oauth.expiresAt === "number" ? oauth.expiresAt : (typeof j.expiresAt === "number" ? j.expiresAt : undefined);
    return { token, ...(rawExp !== undefined ? { expiresAt: rawExp } : {}) };
  } catch {
    return null;
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pctLeft = (used: number): number => Math.round(Math.max(0, Math.min(100, 100 - used)) * 10) / 10;

/** 窗口定义（显示名 + 简称）。 */
const WINDOWS: Array<{ key: string; name: string; short: string }> = [
  { key: "five_hour", name: "5 小时窗口", short: "5h" },
  { key: "seven_day", name: "7 天窗口", short: "7d" },
  { key: "seven_day_opus", name: "7 天 Opus", short: "7d Opus" },
  { key: "seven_day_sonnet", name: "7 天 Sonnet", short: "7d Sonnet" },
];

const fmtReset = (iso: unknown): string | undefined => {
  if (typeof iso !== "string" || !iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  try { return new Date(ms).toLocaleString(); } catch { return undefined; }
};

/** oauth/usage 响应 → 归一化视图（纯函数；窗口缺失优雅降级）。 */
export function normalizeClaudeUsage(raw: unknown, now = Date.now(), tokenExpiresAt?: number): ClaudeQuotaView {
  const d = (raw ?? {}) as Record<string, unknown>;
  const found: Array<{ key: string; name: string; short: string; used: number; reset?: string }> = [];
  for (const w of WINDOWS) {
    const win = (d[w.key] ?? null) as Record<string, unknown> | null;
    if (!win) continue;
    const used = num(win.utilization);
    if (used === undefined) continue;
    found.push({ ...w, used, ...(fmtReset(win.resets_at) ? { reset: fmtReset(win.resets_at)! } : {}) });
  }
  if (!found.length) {
    return { available: false, reason: "unparsed", note: "Claude 用量响应未识别（窗口字段缺失；待真机校准）", fetchedAt: now };
  }
  const primary = found.find((w) => w.key === "seven_day") ?? found[0];
  const display = "额度 " + found
    .filter((w) => w.key === "five_hour" || w.key === "seven_day")
    .map((w) => `${w.short} 剩余 ${pctLeft(w.used)}%`)
    .join(" · ");
  return {
    available: true,
    display: display === "额度 " ? `额度 剩余 ${pctLeft(primary.used)}%` : display,
    unit: "%",
    used: primary.used,
    usedPercent: primary.used,
    remaining: pctLeft(primary.used),
    total: 100,
    packages: found.map((w) => ({
      name: w.name,
      usedPercent: w.used,
      ...(w.reset ? { note: `重置于 ${w.reset}` } : {}),
    })),
    ...(tokenExpiresAt !== undefined ? { expiresAt: tokenExpiresAt } : {}),
    fetchedAt: now,
  };
}

/** 拉 Claude OAuth 用量（fetchImpl 可注入；超时/非 200/异常 → throw，调用方回落 available:false）。 */
export async function fetchClaudeQuota(opts: {
  token: string;
  expiresAt?: number;
  timeoutMs?: number;
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<ClaudeQuotaView> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchFn("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Claude 用量接口 HTTP ${res.status}`);
    return normalizeClaudeUsage(await res.json(), opts.now, opts.expiresAt);
  } finally {
    clearTimeout(timer);
  }
}
