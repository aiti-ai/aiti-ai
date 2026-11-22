/**
 * outbound.ts —— 结果送达（cc-connect 通道 + aiti-mail 邮件）
 * （集成方案 docs/aiti-ai-schedule-integration-plan.md §4.3/§4.4/§4.5）
 *
 * 放 sched/ 内的原因：deploy.mjs 整目录拷贝 sched/，放根目录不会被部署（v2 修复 2）。
 *
 * 语义（方案 §4.3）：
 *   - engine 在 execute/retry 完成后调 outbound 回调，fire-and-forget：不 await、
 *     不占并发窗口、失败不重试、不影响任务 status/水位。
 *   - 两级过滤：skipped/missed（调度层事件）永不发（engine 侧只在 ok/error 完成路径挂钩）；
 *     ok/error 再按 plan.sendOn 判定（sendOnMatch，本文件纯函数）。
 *   - 消息文案 cc 与邮件共用标题风格（buildMessage 纯函数）；正文统一截断 3000 字符。
 *
 * 连接参数（§4.4 优先级）：configDir/cc.json（{baseUrl, token}，手工文件不加 API）
 *   > ~/.config/cc-connect.toml 的 [management] port/token（本机零配置即用，只解析两行 key=value）
 *   > 默认 http://127.0.0.1:9820。发送走 pi-web server 代理端点同源逻辑之外的服务端直连（10s 超时）。
 * 邮件（§4.5）：POST /api/extensions/aiti-mail/send（30s 超时），多邮箱由 aiti-mail 侧拆分逐条记录。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin } from "node:path";
import type { Plan } from "./store.ts";

// ---- 结果形态（engine → outbound 回调入参；runId 供 RunRecord 就地补记） ----

export interface OutboundResult {
  status: "ok" | "error";
  text?: string;
  error?: string;
  at: string;                    // ISO 时间
  ms: number;
  runId: string;
}

export type OutboundFn = (plan: Plan, result: OutboundResult) => void;

// ---- 纯函数：发送条件（sendOn） ----

/** sendOn 判定：undefined/"all" 都发 · "ok" 仅成功 · "error" 仅失败（skipped/missed 在 engine 侧已拦）。 */
export function sendOnMatch(sendOn: Plan["sendOn"], status: "ok" | "error"): boolean {
  if (sendOn === "ok") return status === "ok";
  if (sendOn === "error") return status === "error";
  return true; // 缺省 all
}

/** 结果摘要统一截断 3000 字符（完整结果仍在运行历史，方案 §5）。 */
const SUMMARY_MAX = 3000;

// ---- 纯函数：消息文案（cc 与邮件共用标题风格，方案 §4.3） ----

export function buildMessage(
  plan: Pick<Plan, "name">,
  result: { status: "ok" | "error"; text?: string; error?: string; at: string; ms?: number },
): { title: string; body: string } {
  const ok = result.status === "ok";
  const title = "[" + (ok ? "✅ 成功" : "❌ 失败") + "] 定时任务 · " + plan.name;
  const summary = String((ok ? result.text : (result.error || result.text)) || "").slice(0, SUMMARY_MAX);
  const body = [
    "状态 " + result.status + " · 耗时 " + (result.ms ?? 0) + "ms · " + result.at,
    summary,
    "—— pi-web ⏰调度",
  ].join("\n");
  return { title, body };
}

// ---- cc-connect 连接参数（§4.4 优先级） ----

export interface CcConfig { baseUrl: string; token?: string }

/** 解析 ~/.config/cc-connect.toml 的 [management] port/token——只取两行 key=value，不引 toml 库。 */
export function parseTomlManagement(src: string): { port?: number; token?: string } {
  const out: { port?: number; token?: string } = {};
  let inSec = false;
  for (const raw of String(src || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { inSec = line.toLowerCase() === "[management]"; continue; }
    if (!inSec) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim().toLowerCase();
    let v = line.slice(eq + 1).trim();
    // 值解析：引号字符串取首对引号内（行尾 # 注释忽略）；裸值剥「 #」起的行内注释
    const quoted = v.match(/^"([^"]*)"/) || v.match(/^'([^']*)'/);
    if (quoted) v = quoted[1];
    else {
      const hash = v.indexOf(" #");
      if (hash !== -1) v = v.slice(0, hash).trim();
      if (v.startsWith("#")) v = "";
    }
    if (k === "port") { const n = parseInt(v, 10); if (Number.isFinite(n) && n > 0) out.port = n; }
    else if (k === "token" && v) out.token = v;
  }
  return out;
}

export function resolveCcConfig(configDir?: string): CcConfig {
  // 1) configDir/cc.json（手工覆盖文件，0600 由维护者保证；token 含义 → aiti-configs encrypt 面）
  if (configDir) {
    try {
      const p = pathJoin(configDir, "cc.json");
      if (existsSync(p)) {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (j && j.baseUrl) return { baseUrl: String(j.baseUrl).replace(/\/+$/, ""), token: j.token ? String(j.token) : undefined };
      }
    } catch { /* 坏文件落自动探测 */ }
  }
  // 2) 自动探测 ~/.config/cc-connect.toml（本机零配置即用）
  try {
    const tomlPath = pathJoin(homedir(), ".config", "cc-connect.toml");
    if (existsSync(tomlPath)) {
      const m = parseTomlManagement(readFileSync(tomlPath, "utf8"));
      if (m.port) return { baseUrl: "http://127.0.0.1:" + m.port, token: m.token };
    }
  } catch { /* 落默认 */ }
  // 3) 默认
  return { baseUrl: "http://127.0.0.1:9820" };
}

// ---- 发送（server 端直连；client 永远走 index.ts 的 /cc/* 代理防 mixed content） ----

export const CC_TIMEOUT_MS = 10_000;
export const MAIL_TIMEOUT_MS = 30_000;

/** cc-connect 直推 IM（Outbound 语义，不触发 agent 跑新一轮）。 */
export async function ccSend(cfg: CcConfig, project: string, sessionKey: string, message: string): Promise<void> {
  const r = await fetch(cfg.baseUrl + "/api/v1/projects/" + encodeURIComponent(project) + "/send", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.token ? { authorization: "Bearer " + cfg.token } : {}) },
    body: JSON.stringify({ session_key: sessionKey, message }),
    signal: AbortSignal.timeout(CC_TIMEOUT_MS),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("cc-connect HTTP " + r.status + ": " + t.slice(0, 200));
  }
}

/** aiti-mail 发送（多邮箱由 aiti-mail 侧逐个发送逐条记录）。 */
export async function mailSend(apiBase: string, mailTo: string, subject: string, body: string, planId: string): Promise<void> {
  const r = await fetch(apiBase + "/api/extensions/aiti-mail/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to: mailTo, subject, body, source: "aiti-ai-schedule:" + planId }),
    signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
  });
  const d: any = await r.json().catch(() => null);
  if (!r.ok || !d?.ok) {
    const failed = (d?.results || []).filter((x: any) => x.status !== "ok")
      .map((x: any) => x.to + ": " + (x.error || "?")).join("; ");
    throw new Error("aiti-mail " + (d?.error || "HTTP " + r.status) + (failed ? " · " + failed.slice(0, 200) : ""));
  }
}

/** 同源自调基址（与 engine.execNewSession 同一套 env 语义）。 */
function apiBase(): string {
  const origin = process.env.AITI_AI_SCHEDULE_API_ORIGIN || "http://127.0.0.1:" + (process.env.PORT || "3000");
  return origin + (process.env.PI_WEB_BASE_PATH || "");
}

// ---- 组装：makeOutbound（index.ts startup 注入 engine） ----

/** 送达备注就地补记回调（index.ts 里接 engine.store.patchRun）。 */
export type OnNote = (runId: string, note: { ccSent?: string; mailSent?: string }) => void;

/**
 * 构造 engine 的 outbound 回调。cc/mailTo 都未配置 → 空转（零开销）；发送全程 fire-and-forget，
 * 失败只写送达备注，绝不影响任务状态。
 */
export function makeOutbound(configDir: string, opts?: { onNote?: OnNote }): OutboundFn {
  return (plan: Plan, result: OutboundResult): void => {
    void (async () => {
      const note: { ccSent?: string; mailSent?: string } = {};
      const { title, body } = buildMessage(plan, result);
      if (plan.cc && plan.cc.project && plan.cc.sessionKey) {
        try {
          await ccSend(resolveCcConfig(configDir), plan.cc.project, plan.cc.sessionKey, title + "\n" + body);
          note.ccSent = "ok";
        } catch (e: any) {
          note.ccSent = "error: " + String(e?.message || e).slice(0, 200);
        }
      }
      if (plan.mailTo) {
        try {
          await mailSend(apiBase(), plan.mailTo, title, body, plan.id);
          note.mailSent = "ok";
        } catch (e: any) {
          note.mailSent = "error: " + String(e?.message || e).slice(0, 200);
        }
      }
      if (note.ccSent !== undefined || note.mailSent !== undefined) opts?.onNote?.(result.runId, note);
    })().catch(() => { /* fire-and-forget 兜底 */ });
  };
}
