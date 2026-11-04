/**
 * pi-models-combo — key request usage log.
 *
 * Every proxied request appends one JSONL line under <agentDir>/model-usage/:
 *   default  → monthly files key-requests-<YYYY-MM>.jsonl (previous months
 *              are gzip-compressed to *.jsonl.gz by a daily sweep)
 *   PMC_USAGE_FILE env / explicit fixed binding → that exact file, no rotation
 *   disable: PMC_USAGE_LOG=0
 *
 * Line shape:
 *   { ts, provider, model, key, status, attempts,
 *     input?, output?, cacheRead?, cacheWrite?, reasoning? }
 * Token fields are omitted when they cannot be parsed from the response
 * (e.g. openai streaming without stream_options.include_usage).
 *
 * Consumers (aiti-ai-usage aiti-ai extension) tail this file incrementally — the
 * log is the ONLY source of per-key attribution: session JSONL records
 * provider/model/usage but never knows which apiKeys entry served it.
 */

import fs from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

export interface KeyUsageRecord {
  ts: number;
  provider: string;
  model: string | null;
  key: string;
  /** Final HTTP status of this upstream attempt (200 / 429 / 502 / …). */
  status: number;
  /** Truncated per-session dummy token — correlates the request to the pi
   *  session that issued it (see registerClient / session mapping log). */
  client?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  /** 组合模型归属：命中的成员身份 `${providerId}/${modelId}`（仅组合代理成功记录） */
  combo?: string;
  /** 粘性指针切换事件（成员/槽位身份变化；独立行、无用量，不参与 token 统计） */
  switch?: { from: string; to: string; reason: string };
}

/** Truncate a dummy token to a safe correlation key (never the full secret). */
export function shortClient(token: string): string {
  return token.replace(/^sk-dummy-/, "").slice(0, 12);
}

function monthOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

/** Gzip every key-requests-<month>.jsonl older than the current month.
 *  Best-effort per file; compressed files become <name>.gz (original removed). */
export function sweepCompressOldMonths(dir: string, currentMonth: string): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const m = /^key-requests-(\d{4}-\d{2})\.jsonl$/.exec(name);
    if (!m || m[1] >= currentMonth) continue;
    const src = path.join(dir, name);
    try {
      const raw = fs.readFileSync(src);
      fs.writeFileSync(src + ".gz", gzipSync(raw, { level: 6 }));
      fs.unlinkSync(src);
    } catch (err: any) {
      console.error(`[pi-proxy] usage log compress failed (${name}): ${err?.message ?? err}`);
    }
  }
}

/** Append an already-shaped raw record (registration/session-mapping lines).
 *  Never throws — logging must not break proxying. */
export function appendRawRecord(rec: Record<string, unknown>): void {
  if (!usageFilePath) {
    if (!usageLogEnabled()) return;
    usageFilePath = defaultUsageFilePath();
  }
  try {
    let file = usageFilePath;
    if (rotation?.monthly) {
      const now = rotation.now ? rotation.now() : new Date();
      const ts = typeof rec.ts === "number" && rec.ts > 0 ? rec.ts : now.getTime();
      // 文件按记录自身时间戳选择（无状态；时钟回拨/迟到记录也只是落对月份）
      file = path.join(
        path.dirname(usageFilePath!),
        `key-requests-${monthOf(ts)}.jsonl`,
      );
      // 压缩扫描每天至多一次
      const p2 = (n: number) => String(n).padStart(2, "0");
      const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
      if (today !== lastSweepDay) {
        lastSweepDay = today;
        sweepCompressOldMonths(path.dirname(usageFilePath!), monthOf(now.getTime()));
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch (err: any) {
    console.error(`[pi-proxy] usage log append failed: ${err?.message ?? err}`);
  }
}

export function usageLogEnabled(): boolean {
  return process.env.PMC_USAGE_LOG !== "0";
}

export function defaultUsageFilePath(): string {
  if (process.env.PMC_USAGE_FILE) return process.env.PMC_USAGE_FILE;
  // <agentDir>/model-usage/key-requests.jsonl — agentDir resolution without
  // importing the pi SDK here (proxy.ts stays dependency-free).
  // PI_CODING_AGENT_DIR 优先（pi SDK 同款 env，Docker/Windows 数据根独立于 ~/.pi）；
  // 未设 = 旧 PI_DIR / HOME 链原行为。
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? process.env.PI_CODING_AGENT_DIR
    : process.env.PI_DIR
      ? path.join(process.env.PI_DIR, "agent")
      : path.join(process.env.HOME || process.env.USERPROFILE || ".", ".pi", "agent");
  return path.join(agentDir, "model-usage", "key-requests.jsonl");
}

let usageFilePath: string | null = null;

interface RotationOpts {
  /** 按月轮转：写入 <dir>/key-requests-<YYYY-MM>.jsonl，旧月自动 gzip。 */
  monthly?: boolean;
  /** 可注入时钟（测试用）。 */
  now?: () => Date;
}
let rotation: RotationOpts | null = null;
let lastSweepDay = "";

/** Bind the log sink. Without opts the path is used verbatim (tests / fixed
 *  sinks); with {monthly:true} records are split into per-month files named
 *  after each record's own timestamp, and previous months get gzip'd once
 *  per day (best-effort) so the live set stays small. */
export function setUsageLogFile(file: string, opts?: RotationOpts): void {
  usageFilePath = file;
  rotation = opts ?? null;
}

/** Append one record; best-effort — never throws into the proxy path.
 *  Lazily binds the default path when no explicit setUsageLogFile() happened
 *  (hosts that construct ProxyServer directly without the entry hook). */
export function appendUsageRecord(rec: KeyUsageRecord): void {
  appendRawRecord(rec as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------
// Usage extraction from response tails
// ---------------------------------------------------------------------

export interface ParsedUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
}

/**
 * Extract token usage from a (tail of a) response body.
 *
 * Handles:
 *  - SSE frames (`data: {...}` lines) for all three api types
 *  - non-streaming JSON bodies
 *
 * Strategy: pull every JSON object out of `data:` frames (plus the whole-body
 * JSON fallback), then normalize by shape:
 *  - openai-completions: usage {prompt_tokens, completion_tokens,
 *    prompt_tokens_details.cached_tokens}
 *  - anthropic-messages: message_start.message.usage (input/cache) merged
 *    with the last message_delta.usage.output_tokens
 *  - google-generative-ai: usageMetadata {promptTokenCount, ...}
 */
export function extractUsageFromBody(body: string): ParsedUsage | null {
  const objs: any[] = [];
  const push = (o: any) => { if (o && typeof o === "object") objs.push(o); };

  // SSE frames
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { push(JSON.parse(payload)); } catch { /* partial frame — ignore */ }
  }
  // Non-streaming JSON body fallback
  if (objs.length === 0) {
    try { push(JSON.parse(body)); } catch { return null; }
  }
  if (objs.length === 0) return null;

  // anthropic-messages: merge message_start base with final delta output
  const starts = objs.filter((o) => o?.type === "message_start");
  if (starts.length > 0) {
    const u = starts[starts.length - 1]?.message?.usage ?? {};
    const deltas = objs.filter((o) => o?.type === "message_delta");
    const dOut = deltas.length > 0 ? Number(deltas[deltas.length - 1]?.usage?.output_tokens) : NaN;
    const out: ParsedUsage = {
      input: num(u.input_tokens),
      output: Number.isFinite(dOut) ? dOut : num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
    };
    return dropEmpty(out);
  }

  // google-generative-ai: last usageMetadata
  const metas = objs.filter((o) => o?.usageMetadata);
  if (metas.length > 0) {
    const m = metas[metas.length - 1].usageMetadata;
    const cached = num(m.cachedContentTokenCount);
    const thoughts = num(m.thoughtsTokenCount);
    return dropEmpty({
      input: num(m.promptTokenCount) - cached,
      output: num(m.candidatesTokenCount) + thoughts,
      cacheRead: cached,
      reasoning: thoughts,
    });
  }

  // openai-completions: last chunk carrying usage
  const usages = objs.filter((o) => o?.usage && o.usage.prompt_tokens != null);
  if (usages.length > 0) {
    const u = usages[usages.length - 1].usage;
    const cached = num(u.prompt_tokens_details?.cached_tokens);
    return dropEmpty({
      input: num(u.prompt_tokens) - cached,
      output: num(u.completion_tokens),
      cacheRead: cached,
      reasoning: num(u.completion_tokens_details?.reasoning_tokens),
    });
  }

  return null;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function dropEmpty(u: ParsedUsage): ParsedUsage | null {
  const out: any = {};
  for (const [k, v] of Object.entries(u)) if (typeof v === "number" && v > 0) out[k] = v;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Extract the model id from a request body (best-effort). All three api
 * types put `"model": "<id>"` at the top level.
 */
export function extractModelFromBody(body: Buffer): string | null {
  try {
    const obj = JSON.parse(body.toString("utf8"));
    const m = obj?.model;
    return typeof m === "string" && m ? m : null;
  } catch {
    return null;
  }
}
