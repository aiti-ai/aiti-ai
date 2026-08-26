import { randomBytes } from "crypto";

/**
 * 文件下载短时效票据（可重复使用，TTL 5 分钟）。
 *
 * 动机：GET /api/files/<path>?type=download 会把本地绝对路径落入隧道/代理 access log。
 * 两步下载：POST /api/files/ticket { path } 换随机票据 → GET /api/files/_t/<ticket> 流式下载。
 * 另服务 /viewer 开窗：POST { path, kind, cwd } 签发 view 票 → 子窗加载后经 opener 拿票兑付。
 * TTL 内可重复取（外部下载器/断点重试友好）；到期即作废；不绑 cookie（下载器不带会话）。
 * 无定时器：过期条目在签发/核销时惰性清理。
 */
export interface FileTicket {
  path: string;
  /** 用途："download"（流式下载）| "view"（/viewer 打开目标，附带 kind/cwd） */
  type: string;
  /** viewer 目标类型（仅 type="view" 时有值）："file" | "folder" */
  kind?: string;
  /** viewer 工作目录（仅 type="view" 时有值） */
  cwd?: string;
  exp: number;
}

const TICKET_TTL_MS = 5 * 60 * 1000;
const tickets = new Map<string, FileTicket>();

function sweep(now: number): void {
  for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
}

export function issueFileTicket(path: string, type = "download", extra?: { kind?: string; cwd?: string }): { ticket: string; expiresIn: number } {
  const now = Date.now();
  sweep(now);
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { path, type, ...(extra?.kind ? { kind: extra.kind } : {}), ...(extra?.cwd ? { cwd: extra.cwd } : {}), exp: now + TICKET_TTL_MS });
  return { ticket, expiresIn: Math.round(TICKET_TTL_MS / 1000) };
}

export function redeemFileTicket(ticket: string | null | undefined): FileTicket | null {
  const now = Date.now();
  sweep(now);
  if (!ticket) return null;
  return tickets.get(ticket) ?? null;
}
