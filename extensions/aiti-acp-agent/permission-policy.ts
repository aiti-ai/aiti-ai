/**
 * permission-policy —— aiti-acp-agent 工具授权纯逻辑（可单测，无 IO）。
 *
 * ACP 协议：agent → client `session/request_permission`（JSON-RPC 请求，必须应答）；
 *   options: [{optionId, name, kind}]，kind ∈ allow_once|allow_always|reject_once|reject_always；
 *   应答：{outcome:{outcome:"selected",optionId}} 或 {outcome:{outcome:"cancelled"}}。
 *
 * 策略（feature acp.permissionPolicy）：
 *   allow（默认，信任 agent）：优先把会话切到 no-ask 模式；仍到来的请求自动放行（allow_always 优先）。
 *   ask：请求转前端人工；超时（feature acp.permissionTimeoutSec，默认 300s，0=无限）自动允许。
 *
 * ⚠ 2026-09-12 修复：应答 id 必须**原样回写**（cbc 首个请求 id=数字 0；
 *   旧实现 `Number(id)||id` 把 0 退化成字符串 "0"，cbc 不认导致永久挂起）。
 */

export interface AcpPermissionOptionLike {
  kind?: unknown;
  optionId?: unknown;
  name?: unknown;
}

export interface PickedPermissionOptions {
  allowAlways?: AcpPermissionOptionLike;
  allowOnce?: AcpPermissionOptionLike;
  /** 自动/人工允许时选用的选项：allow_always 优先（记住选择、后续少问） */
  allowOpt?: AcpPermissionOptionLike;
  rejectOnce?: AcpPermissionOptionLike;
  rejectAlways?: AcpPermissionOptionLike;
  /** 人工拒绝时选用的选项：reject_once 优先 */
  denyOpt?: AcpPermissionOptionLike;
}

/** 从 options 中挑选允许/拒绝候选（kind 精确匹配；顺序无关）。 */
export function pickPermissionOptions(options: AcpPermissionOptionLike[]): PickedPermissionOptions {
  const list = Array.isArray(options) ? options.filter((o) => o && typeof o === "object") : [];
  const byKind = (kind: string) => list.find((o) => o.kind === kind);
  const allowAlways = byKind("allow_always");
  const allowOnce = byKind("allow_once");
  const rejectOnce = byKind("reject_once");
  const rejectAlways = byKind("reject_always");
  return {
    allowAlways,
    allowOnce,
    allowOpt: allowAlways ?? allowOnce,
    rejectOnce,
    rejectAlways,
    denyOpt: rejectOnce ?? rejectAlways,
  };
}

/** no-ask 模式偏好（按 agent 宣告的 availableModes 取第一个存在的；无则不切，靠自动应答兜底）。 */
export const TRUST_MODE_PREFERENCE = ["bypassPermissions", "fullAccess", "yolo"] as const;

export function chooseTrustMode(availableModes: Array<{ id?: unknown }>): string | undefined {
  const ids = new Set(
    (Array.isArray(availableModes) ? availableModes : [])
      .map((m) => (m && typeof m === "object" ? m.id : undefined))
      .filter((v): v is string => typeof v === "string" && v.length > 0),
  );
  return TRUST_MODE_PREFERENCE.find((m) => ids.has(m));
}

/** allow|ask 策略归一（未知/空 → allow，信任优先）。 */
export function normalizePolicy(raw: unknown): "allow" | "ask" {
  return typeof raw === "string" && raw.trim() === "ask" ? "ask" : "allow";
}

/** 超时（秒）归一：非法/空 → 300；0 → 0（无限等待）；负数 → 300。 */
export function normalizeAskTimeoutSec(raw: unknown): number {
  const s = typeof raw === "string" ? raw.trim() : raw;
  if (s === "" || s === undefined || s === null) return 300;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 300;
  return Math.floor(n);
}

/** 权限应答行（selected）：id 原样回写（number/string 保真）。 */
export function permissionSelectedLine(id: string | number, optionId: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
}

/** 权限应答行（cancelled）：规范 MUST——client 取消时对待决请求回 cancelled。 */
export function permissionCancelledLine(id: string | number): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
}

/** 工具授权请求的展示信息（前端卡/会话消息流共用）。 */
export interface PermissionAskInfo {
  toolName: string;
  input: unknown;
}

/** 从 ACP request_permission 的 toolCall 提取工具名与入参（容忍多种形状）。 */
export function extractToolAskInfo(toolCall: unknown): PermissionAskInfo {
  const tc = (toolCall && typeof toolCall === "object" ? toolCall : {}) as Record<string, unknown>;
  const meta = (tc._meta && typeof tc._meta === "object" ? tc._meta : {}) as Record<string, unknown>;
  const metaTool = meta["codebuddy.ai/toolName"] ?? meta.toolName;
  const title = typeof tc.title === "string" ? tc.title : "";
  const name = typeof metaTool === "string" && metaTool
    ? metaTool
    : (typeof tc.name === "string" && tc.name ? tc.name : (title || "tool"));
  const input = tc.rawInput ?? tc.input ?? undefined;
  return { toolName: name, input };
}

/** 入参单行摘要（会话消息流展示用；超长截断）。 */
export function summarizeToolInput(input: unknown, max = 220): string {
  if (input === undefined || input === null) return "";
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
