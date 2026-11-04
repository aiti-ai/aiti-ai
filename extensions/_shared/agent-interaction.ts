/**
 * _shared/agent-interaction — 会话「需用户应答的请求」统一语义（kind 裁决 + pending 账本 + 答案→线协议）。
 *
 * 权威契约 docs/pi-web-ext-agent-interaction-unify-plan.md §2/§3。所有会话后端（CC 族
 * control_request/can_use_tool、ACP session/request_permission、zcode 反向请求、pi/omp fork-rpc）
 * 把各自协议里的 ask 转成同一个 `interaction_request` 事件，答案从同一个 `respondInteraction`
 * 回来；本层负责语义换算与生命周期，各家 handle 只留「认帧 + 写字节」。
 *
 * 三条不可谈判的行为（都是事故/缺陷驱动，见方案 §0）：
 * 1. `answers`/`approved`/`feedback` 必须回填进工具入参（CC 的 execute() 就从 params 读答案与
 *    审批结论），否则 AskUserQuestion 是假支持——卡片能点、答案进不去；方案拒绝也丢反馈通道。
 * 2. 未决 ask 落 sidecar 且可 replay 补发（**复用原 requestId**）：handle 被重建/前端刷新后
 *    卡片若不再可点，CLI 会永久等一个没人回答的授权（qoder 会话挂 5 小时的根因）。
 * 3. 选项表缺失/未知 optionId 一律 fail-closed，绝不随便挑一个当用户同意。
 *
 * 测试：agent-interaction.test.mjs
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type InteractionKind = "tool_auth" | "ask_user" | "plan_approval" | "open_url" | "generic";
export type InteractionExpireReason = "turn_end" | "cancelled" | "dead";

export interface InteractionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface InteractionQuestionOption {
  label: string;
  description?: string;
}

export interface InteractionQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: InteractionQuestionOption[];
}

/** 后端广播的统一 ask 事件（宿主原样透传到前端 sessionRequestCard 插槽）。 */
export interface InteractionRequestEvent {
  type: "interaction_request";
  requestId: string;
  kind: InteractionKind;
  capability: "respondInteraction";
  toolName?: string;
  input?: unknown;
  questions?: InteractionQuestion[];
  options?: InteractionOption[];
  plan?: string;
  url?: string;
  launchUrl?: string;
  prompt?: string;
  reason?: string;
}

export interface InteractionExpiredEvent {
  type: "interaction_expired";
  requestId: string;
  reason: InteractionExpireReason;
}

/** 前端作答（宿主 respond_interaction 命令体）。 */
export interface InteractionAnswer {
  action: "accept" | "decline";
  answers?: Record<string, string | string[]>;
  message?: string;
  optionId?: string;
}

/** 账本条目（sidecar 落盘形态 = 事件 + 落盘时间）。 */
export interface PendingAsk {
  requestId: string;
  kind: InteractionKind;
  toolName?: string;
  input?: unknown;
  options?: InteractionOption[];
  askedAt: number;
}

export interface InteractionRecord {
  requestId: string;
  kind: InteractionKind;
  toolName?: string;
  input?: unknown;
  decision: "pending" | "allow" | "deny" | "cancelled";
  note?: string;
}

export interface InteractionLedger {
  /** 记一笔未决并广播；requestId 给了就复用（应答必须回同一个 id）。 */
  open(partial: Partial<InteractionRequestEvent> & { kind?: InteractionKind; requestId?: string }): string;
  /** 作答收口：命中返回账项并清账，未命中 null（重复应答幂等）。 */
  settle(requestId: string, answer: InteractionAnswer): PendingAsk | null;
  pending(): PendingAsk[];
  /**
   * 未决的广播帧（不发）：订阅者补发用——前端刷新后卡片丢了而 CLI 还在等，
   * 拿这批帧重投即可（同 requestId，幂等，不新造）。
   */
  replay(): InteractionRequestEvent[];
  /** turn 收口 / 进程死亡：逐个 interaction_expired + 留痕 + 清空。 */
  failPending(reason: InteractionExpireReason): number;
  /** 启动时从 sidecar 恢复未决，返回恢复条数（无 sidecar 路径返回 0）。 */
  load(): number;
}

// ── kind 裁决 ──────────────────────────────────────────────────────────────

/** 剥 mcp__server__ 前缀并归一大小写/分隔符，供工具名匹配。 */
function normalizeToolName(name?: string): string {
  if (!name) return "";
  let base = name;
  if (base.startsWith("mcp__")) {
    // server 名可含下划线（mcp__my_server__AskUserQuestion）→ 取最后一个分隔符之后
    const tail = base.lastIndexOf("__");
    base = tail > 5 ? base.slice(tail + 2) : base.slice(5);
  }
  return base.replace(/[^A-Za-z]/g, "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function isValidQuestions(value: unknown): value is InteractionQuestion[] {
  const arr = Array.isArray(value) ? value : null;
  if (!arr || arr.length === 0) return false;
  return arr.every((q) => {
    const item = asRecord(q);
    return !!item && typeof item.question === "string" && Array.isArray(item.options);
  });
}

/** 后端显式标注（zcode schema.interaction）优先，其次工具名。 */
export function deriveAskKind(toolName?: string, input?: unknown): InteractionKind {
  const marked = asRecord(input)?.interaction;
  if (marked === "plan_approval") return "plan_approval";
  if (marked === "ask_user") return "ask_user";
  const name = normalizeToolName(toolName);
  if (name === "exitplanmode") return "plan_approval";
  if (name === "askuserquestion") return isValidQuestions(asRecord(input)?.questions) ? "ask_user" : "tool_auth";
  return "tool_auth";
}

// ── 答案 → 各家线协议 ───────────────────────────────────────────────────────

function denyMessage(answer: InteractionAnswer): string {
  return answer.message && answer.message.trim() ? answer.message : "denied by user";
}

/** CC 族 control_response.response（allow/deny + updatedInput 回填）。 */
export function toControlResponse(
  ask: { kind: InteractionKind; input?: unknown; options?: InteractionOption[] },
  answer: InteractionAnswer,
): Record<string, unknown> {
  if (answer.optionId && ask.options?.length) {
    const picked = ask.options.find((o) => o?.optionId === answer.optionId);
    if (!picked) return { behavior: "deny", message: `unknown optionId: ${answer.optionId}` };
    return normalizeOptionKind(picked) === "reject"
      ? { behavior: "deny", message: denyMessage(answer) }
      : { behavior: "allow" };
  }
  if (ask.kind === "plan_approval") {
    // 审批的拒绝**不是**权限拒绝：deny 只会回一条「用户拒绝授权」，方案反馈通道（feedback）
    // 与「修订再继续」的语义就丢了。ExitPlanMode 的 execute 读 params.approved/feedback。
    const base = asRecord(ask.input) ?? {};
    if (answer.action === "decline") {
      const feedback = answer.message && answer.message.trim() ? answer.message.trim() : undefined;
      return { behavior: "allow", updatedInput: { ...base, approved: false, ...(feedback ? { feedback } : {}) } };
    }
    return { behavior: "allow", updatedInput: { ...base, approved: true } };
  }
  if (answer.action === "decline") return { behavior: "deny", message: denyMessage(answer) };
  if (ask.kind === "ask_user") {
    // AskUserQuestion 的 execute 从 params.answers 读（键=问题文本），不回填=空答案
    return { behavior: "allow", updatedInput: { ...(asRecord(ask.input) ?? {}), answers: answer.answers ?? {} } };
  }
  return { behavior: "allow" };
}

/** ACP 族：作答必须落到具体 optionId，查不到就不应答（fail-closed）。 */
export function toAcpOptionId(options: InteractionOption[] | undefined, answer: InteractionAnswer): string | undefined {
  const list = (options ?? []).filter((o) => o && typeof o.optionId === "string");
  if (answer.optionId) return list.find((o) => o.optionId === answer.optionId)?.optionId;
  const want = answer.action === "decline" ? "reject" : "allow";
  return list.find((o) => normalizeOptionKind(o) === want)?.optionId;
}

function normalizeOptionKind(option: InteractionOption): "allow" | "reject" {
  const text = `${option.kind ?? ""} ${option.name ?? ""}`.toLowerCase();
  return /reject|deny|cancel|refuse/.test(text) ? "reject" : "allow";
}

// ── pending 账本 ────────────────────────────────────────────────────────────

const ALLOWED_KINDS = new Set<InteractionKind>(["tool_auth", "ask_user", "plan_approval", "open_url", "generic"]);
const TEXT_FIELDS = ["plan", "url", "launchUrl", "prompt", "reason"] as const;

function sanitizeString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function sanitizeOptions(value: unknown): InteractionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((o) => {
    const item = asRecord(o);
    return !!item && typeof item.optionId === "string";
  }) as InteractionOption[];
  return list.length ? list : undefined;
}

function sanitizeQuestions(value: unknown): InteractionQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((q) => {
    const item = asRecord(q);
    return !!item && typeof item.question === "string" && Array.isArray(item.options);
  }) as InteractionQuestion[];
  return list.length ? list : undefined;
}

/** 不信任外部输入：逐字段消毒后同时产出账项与广播事件（sidecar 读回也走这条路）。 */
function normalizeAsk(partial: Partial<InteractionRequestEvent> & { requestId?: string }, askedAt: number):
  { ask: PendingAsk; event: InteractionRequestEvent } {
  const requestId = sanitizeString(partial.requestId) ?? randomUUID();
  const kind = ALLOWED_KINDS.has(partial.kind as InteractionKind) ? partial.kind as InteractionKind : "tool_auth";
  const ask: PendingAsk = { requestId, kind, askedAt };
  const event: InteractionRequestEvent = { type: "interaction_request", requestId, kind, capability: "respondInteraction" };
  const toolName = sanitizeString(partial.toolName);
  if (toolName) { ask.toolName = toolName; event.toolName = toolName; }
  if (partial.input !== undefined) { ask.input = partial.input; event.input = partial.input; }
  const options = sanitizeOptions(partial.options);
  if (options) { ask.options = options; event.options = options; }
  const questions = sanitizeQuestions(partial.questions);
  if (questions) event.questions = questions;
  for (const key of TEXT_FIELDS) {
    const value = sanitizeString(partial[key]);
    if (value) event[key] = value;
  }
  return { ask, event };
}

/** sidecar 落盘形态 = 广播事件 + 落盘时间（重连补发要发当初那一帧，不能只剩半截）。 */
type PersistedAsk = InteractionRequestEvent & { askedAt: number };

export function createInteractionLedger(opts: {
  emit(event: InteractionRequestEvent | InteractionExpiredEvent): void;
  /**
   * sidecar 文件路径（惰性取：handle 构造期会话 id 还是占位值，见各家队列 sidecar 同形注释）。
   * 返 undefined = 不落盘（跨重建重发能力自动降级）。
   */
  sidecarFile?: () => string | undefined;
  record?(note: InteractionRecord): void;
  now?: () => number;
}): InteractionLedger {
  const entries = new Map<string, { ask: PendingAsk; event: InteractionRequestEvent }>();
  const now = opts.now ?? (() => Date.now());

  const persist = (): void => {
    const path = opts.sidecarFile?.();
    if (!path) return;
    // 原子写顺序（windows-compat-lessons §0.5）：先写 tmp 再 rename
    try {
      mkdirSync(dirname(path), { recursive: true });
      const rows: PersistedAsk[] = [...entries.values()].map(({ ask, event }) => ({ ...event, askedAt: ask.askedAt }));
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(rows), "utf8");
      renameSync(tmp, path);
    } catch {
      /* sidecar 失败不得杀会话：重建时少一次重发而已 */
    }
  };

  const note = (ask: PendingAsk, decision: InteractionRecord["decision"], msg?: string): void => {
    try {
      opts.record?.({ requestId: ask.requestId, kind: ask.kind, toolName: ask.toolName, input: ask.input, decision, note: msg });
    } catch {
      /* 留痕是附加品，不能反噬应答链路 */
    }
  };

  return {
    open: (partial) => {
      const { ask, event } = normalizeAsk(partial, now());
      entries.set(ask.requestId, { ask, event });
      note(ask, "pending");
      persist();
      opts.emit(event);
      return ask.requestId;
    },

    settle: (requestId, answer) => {
      const entry = entries.get(requestId);
      if (!entry) return null;
      note(entry.ask, answer.action === "accept" ? "allow" : "deny", answer.message);
      entries.delete(requestId);
      persist();
      return { ...entry.ask };
    },

    pending: () => [...entries.values()].map(({ ask }) => ({ ...ask })),

    replay: () => [...entries.values()].map(({ event }) => event),

    failPending: (reason) => {
      if (entries.size === 0) return 0;
      const list = [...entries.entries()];
      entries.clear();
      for (const [, { ask, event }] of list) {
        note(ask, "cancelled");
        opts.emit({ type: "interaction_expired", requestId: event.requestId, reason });
      }
      persist();
      return list.length;
    },

    load: () => {
      const path = opts.sidecarFile?.();
      if (!path) return 0;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        return 0;
      }
      if (!Array.isArray(raw)) return 0;
      let count = 0;
      for (const item of raw) {
        const entry = asRecord(item);
        if (!entry || !sanitizeString(entry.requestId) || !ALLOWED_KINDS.has(entry.kind as InteractionKind)) continue;
        const { ask, event } = normalizeAsk(entry as Partial<InteractionRequestEvent>, Number(entry.askedAt) || now());
        entries.set(ask.requestId, { ask, event });
        count++;
      }
      return count;
    },
  };
}
