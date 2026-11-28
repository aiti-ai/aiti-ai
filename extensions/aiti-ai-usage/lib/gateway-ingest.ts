/**
 * aiti-ai-usage · model-gateway (aiti-model-gateway) traffic ingestion + query.
 *
 * Source: per-request rows pushed by aiti-model-gateway via ctx.services
 * (key "aiti-ai-usage.ingest"). Two write paths (see the usage-ingest plan §D3):
 *   - subject='external'（caller keeps no token stats of its own) -> ext_usage (agent='gateway', counted into the totals)
 *     + gateway_usage (gateway dimension);
 *   - subject='agent'（caller is a token-journalling agent CLI whose JSONL is already ingested by the ext pipeline)
 *     -> gateway_usage only (no ext_usage write, avoiding a double count in the totals).
 *
 * Idempotency: PK (token|agent, session_id, ts, provider, model) with INSERT OR IGNORE —
 * single writer (the gateway) + per-request timestamps make replays safe.
 */
import type { UsageDb } from "./db.ts";
import { localDay } from "./db.ts";
import { noteDirtyDay } from "./ingest.ts";

export type GatewaySubject = "agent" | "external";

export interface GatewayUsageRow {
  token: string;
  subject: GatewaySubject;
  ts: number;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  costTotal: number;
}

const n0 = (v: unknown): number => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);

/** Idempotent ingest of a batch of gateway calls. Returns the number of newly inserted rows. */
export function ingestGatewayUsage(usage: UsageDb, rows: GatewayUsageRow[]): number {
  const db = usage.db;
  let inserted = 0;
  for (const row of rows) {
    const day = localDay(row.ts);
    const token = String(row.token || "open").slice(0, 120);
    const subject: GatewaySubject = row.subject === "agent" ? "agent" : "external";
    const input = n0(row.input);
    const output = n0(row.output);
    const cacheRead = n0(row.cacheRead);
    const cacheWrite = n0(row.cacheWrite);
    const reasoning = n0(row.reasoning);
    const totalTokens = n0(row.totalTokens) || input + output + cacheRead + cacheWrite;
    const costTotal = Number(row.costTotal) || 0;
    const ts = Number(row.ts) || Date.now();

    // PK = (token, ts, provider, model) with ts in ms — two parallel completions of the
    // same token/model can share a millisecond. PK collision has two distinct causes:
    //   ① gateway replayed the exact same row (identical content) → skip (idempotency);
    //   ② a genuinely different parallel call landed on the same ms → nudge ts until it
    //      fits (rows are independent usage facts; ordering within a ms is irrelevant).
    // "Same content" = the full token/usage tuple matches — a replayed row is
    // byte-identical, a parallel call virtually never is.
    const insertGateway = (tsMs: number) => db.prepare(
      `INSERT OR IGNORE INTO gateway_usage (token, subject, ts, day, provider, model,
        input, output, cache_read, cache_write, reasoning, total_tokens, cost_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(token, subject, tsMs, day, String(row.provider || "?"), String(row.model || "?"),
      input, output, cacheRead, cacheWrite, reasoning, totalTokens, costTotal);
    const sameGatewayRow = (tsMs: number) => {
      const got = db.prepare(
        "SELECT subject, input, output, cache_read, cache_write, reasoning, total_tokens, cost_total FROM gateway_usage WHERE token = ? AND ts = ? AND provider = ? AND model = ?",
      ).get(token, tsMs, String(row.provider || "?"), String(row.model || "?")) as any;
      return Boolean(got)
        && got.subject === subject
        && got.input === input && got.output === output
        && got.cache_read === cacheRead && got.cache_write === cacheWrite
        && got.reasoning === reasoning && got.total_tokens === totalTokens
        && Number(got.cost_total) === costTotal;
    };
    let gatewayTs = ts;
    while (Number(insertGateway(gatewayTs).changes) === 0) {
      if (sameGatewayRow(gatewayTs)) break; // exact replay → already counted
      gatewayTs += 1;                       // parallel collision → next slot
    }
    inserted += 1;

    // external only enters the totals: agent-class traffic is already covered by the caller's own journalled stats (ext ingestion).
    if (subject === "external") {
      const insertExt = (tsMs: number) => db.prepare(
        `INSERT OR IGNORE INTO ext_usage (agent, session_id, ts, day, provider, model,
          input, output, cache_read, cache_write, reasoning, total_tokens, cost_total, credits)
         VALUES ('gateway', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(token, tsMs, day, String(row.provider || "?"), String(row.model || "?"),
        input, output, cacheRead, cacheWrite, reasoning, totalTokens, costTotal);
      let extTs = gatewayTs;
      while (Number(insertExt(extTs).changes) === 0) extTs += 1;
      inserted += 1;
      noteDirtyDay(day);
    }
  }
  return inserted;
}

/** Gateway-dimension aggregates (per token): optional time range (ms). */
export function queryGatewayUsage(usage: UsageDb, opts: { from?: number; to?: number } = {}): any {
  const db = usage.db;
  const conds: string[] = [];
  const params: any[] = [];
  if (opts.from) { conds.push("ts >= ?"); params.push(opts.from); }
  if (opts.to) { conds.push("ts <= ?"); params.push(opts.to); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const byToken = db.prepare(
    `SELECT token, subject, COUNT(*) calls, SUM(input) input, SUM(output) output,
            SUM(cache_read) cacheRead, SUM(total_tokens) totalTokens, SUM(cost_total) cost
     FROM gateway_usage ${where} GROUP BY token, subject ORDER BY totalTokens DESC`,
  ).all(...params);
  const byDay = db.prepare(
    `SELECT day, SUM(input) input, SUM(output) output, SUM(total_tokens) totalTokens,
            SUM(cost_total) cost, COUNT(*) calls
     FROM gateway_usage ${where} GROUP BY day ORDER BY day`,
  ).all(...params);
  return { byToken, byDay };
}
