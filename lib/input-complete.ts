/**
 * input-complete —— AI 输入行内自动补全的服务端核心（方案 docs/aiti-input-autocomplete-plan.md）
 *
 * 职责：发一个【极小】补全请求（只续下一句话），返回 { text, usage }。
 *       /api/chat/complete-input 路由薄封装本模块。
 *
 * 关键设计（2026-08 修正）：
 *   - **与会话完全解耦**：不走运行中的 ai session、不读会话上下文——
 *     独立 ModelRuntime 实例（只读 ~/.pi/agent/models.json，refreshOnCreate:false，
 *     零网络刷新、不落盘），messages 仅 system 规则 + 历史输入截尾 + 当前输入截尾。
 *   - **模型 = 当前 provider 内的低配模型**（不换 provider）：
 *       1) 优先该 provider 内 reasoning=false 且输入价最低的模型；
 *       2) 全为推理模型 → 取最便宜并显式 reasoning:"off"（thinkingLevelMap 有 off 的
 *          provider，如 deepseek 官方）；实在不支持 off 就接受默认（预算已按推理档放大）。
 *       3) provider 缺省 = 请求带 provider → ~/.pi/agent/settings.json defaultProvider。
 *   - **速度优先**：非推理模型 maxTokens 小档（60/96/144）；推理模型 160/256/384。
 *   - 输出后处理：裁到首个句读符、去与输入尾部的重复前缀；无句子结果丢弃。
 *   - 60s TTL LRU 缓存：同一 provider/model+输入串停顿重触发不重复呼出模型。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export type CompleteContextSize = "small" | "medium" | "large";

export interface CompleteInputRequest {
  /** 缺省 provider（可选；缺省取 settings defaultProvider）——补全只用该 provider 内的低配模型 */
  provider?: string;
  /** 当前输入全文（服务端按档位截尾） */
  input: string;
  /** 本会话历史 user 消息文本（可选；缺省不带历史，纯当前输入续写） */
  history?: string[];
  /** 上下文档位（缺省 medium） */
  ctx?: CompleteContextSize;
}

interface CompleteResult {
  text: string;
  provider: string;
  model: string;
  reasoning: boolean;
  usage?: { input: number; output: number };
  cached: boolean;
}

// ---------- 档位预算（字符量按中文 ~1token/字符 粗估；maxTokens 分非推理/推理两档，速度优先） ----------
const CTX_BUDGET: Record<CompleteContextSize, { historyChars: number; inputChars: number; maxTokensPlain: number; maxTokensReasoning: number }> = {
  small:  { historyChars: 2000,  inputChars: 800,  maxTokensPlain: 60,  maxTokensReasoning: 160 },
  medium: { historyChars: 8000,  inputChars: 1600, maxTokensPlain: 96,  maxTokensReasoning: 256 },
  large:  { historyChars: 16000, inputChars: 3200, maxTokensPlain: 144, maxTokensReasoning: 384 },
};

// ---------- system prompt（补全规则，固定前缀；§5.3 重构：整句补全 + 前缀可缓存） ----------
// 注：system 保持静态（前缀缓存）；内含 few-shot 引导「直接接续」、杜绝元话语。
const SYSTEM_PROMPT = [
  "你是聊天输入框的逐句补全器。下面这条 user 消息是一整段内容：前部是本会话历史上下文，最后是用户当前正在输入的文字（或想继续写下去的句尾）。",
  "任务：直接续写最后一段文字——输出紧接着它的下一句话，让整段读起来连贯自然。",
  "铁律：绝不输出元话语（如「我们需要…」「您能提供…」「请把…发给我」这类提问或转述）；",
  "不解释、不评价、不换行、不加编号、不用 markdown；保持用户语言与文风（中文用中文、英文用英文）；一句话 ≤ 60 字；",
  "不重复或改写已有文本；若结尾已是完整断句（。！？!?…），则写下一句的开头。宁可短，不可编造无关内容。",
  "",
  "示例：",
  "历史：无 ｜ 当前输入：请帮我分析一下这个页面的性能问题",
  "输出：重点关注网络请求、图片体积和 DOM 渲染开销。",
  "历史：无 ｜ 当前输入：把这段代码改成 TypeScript",
  "输出：同时补上函数返回类型的定义。",
  "历史：无 ｜ 当前输入：总结一下今天的工作",
  "输出：并列出明天要做的三件事。",
].join("\n");

// ---------- 模型路径 / settings 缓存 ----------
const AGENT_DIR = join(homedir(), ".pi", "agent");
const MODELS_PATH = process.env.PI_MODELS_JSON || join(AGENT_DIR, "models.json");

// ---------- 独立干净 runtime（单例，只读 models.json，不落盘、零网络） ----------
let runtimePromise: Promise<ModelRuntime> | null = null;
let runtimeError: unknown = null;

function getRuntime(): Promise<ModelRuntime> {
  if (runtimeError) return Promise.reject(runtimeError);
  if (runtimePromise) return runtimePromise;
  runtimePromise = ModelRuntime.create({
    modelsPath: MODELS_PATH,
    refreshOnCreate: false,
    allowModelNetwork: false,
  }).catch((err) => {
    runtimeError = err;
    runtimePromise = null;
    throw err;
  });
  return runtimePromise;
}

// ---------- 模型选择：provider 内低配（非推理优先 · 输入价升序） ----------
interface PickResult { model: ModelLike; reasoning: boolean }

/**
 * 模型选择（2026-08 实测定档）：
 *   - 默认 `opencode-go-2/deepseek-v4-pro`（当前供应商生态、实测质量/速度可用；约 2.2s、成本≈0.0007$/次）。
 *   - 低配免费档（deepseek 官方 flash / opencode flash）实测中文续写质量不可用，故不默认。
 *   - 环境变量 AITI_COMPLETE_MODEL="provider/model" 可覆盖；找不到时回退全局非推理最便宜。
 */
const DEFAULT_COMPLETE_MODEL = process.env.AITI_COMPLETE_MODEL || "opencode-go-2/deepseek-v4-pro";

async function pickModel(providerId?: string): Promise<PickResult> {
  const rt = await getRuntime();
  const registry = new ModelRegistry(rt);
  const all = registry.getAll();

  // 1) 显式 provider：该 provider 内 非推理最便宜 → 推理最便宜
  if (providerId) {
    const pool = all.filter((m) => m.provider === providerId);
    if (!pool.length) throw new Error("provider-not-found:" + providerId);
    const ranked = rankModels(pool);
    const best = ranked[0];
    return { model: best, reasoning: isReasoning(best) };
  }

  // 2) 默认档：DEFAULT_COMPLETE_MODEL（存在则用）
  const [defProv, defModel] = DEFAULT_COMPLETE_MODEL.split("/");
  if (defProv && defModel) {
    const found = all.find((m) => m.provider === defProv && m.id === defModel);
    if (found) return { model: found, reasoning: isReasoning(found) };
  }

  // 3) 回退：全局非推理最便宜 → 全局任意最便宜
  const ranked = rankModels(all);
  const best = ranked[0];
  if (!best) throw new Error("no-models");
  return { model: best, reasoning: isReasoning(best) };
}

const isReasoning = (m: ModelLike) => !!(m as { reasoning?: boolean }).reasoning;
function rankModels(pool: ModelLike[]): ModelLike[] {
  const costOf = (m: ModelLike): number => {
    const c = m.cost as { input?: number } | undefined;
    return typeof c?.input === "number" ? c.input : 0;
  };
  return [...pool].sort((a, b) => {
    const ra = isReasoning(a) ? 1 : 0;
    const rb = isReasoning(b) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const ca = costOf(a);
    const cb = costOf(b);
    if (ca !== cb) return ca - cb;
    return a.id.localeCompare(b.id);
  });
}

// 窄化视图（对应 pi-ai Model 字段；cast 由调用方负责）
interface ModelLike {
  provider: string;
  id: string;
  cost?: unknown;
}

// ---------- 输出后处理（§5.4）：剥 markdown 围栏 → 裁到首个断句符 → 去重复前缀 ----------
function trimToSentence(raw: string): string {
  let s = raw.trim();
  if (!s) return "";
  s = s.replace(/^```[a-zA-Z0-9]*\s*/g, "").replace(/```\s*$/g, "").trim(); // 剥代码围栏
  const m = s.match(/[^。！？!?…\r\n]*[。！？!?…]?/);
  return m ? m[0].trim().replace(/^```+\s*/, "").trim() : "";
}

function stripRepeatedPrefix(candidate: string, input: string): string {
  const tail = input.slice(-120);
  for (let i = Math.min(candidate.length, tail.length); i > 0; i--) {
    if (tail.endsWith(candidate.slice(0, i))) return candidate.slice(i);
  }
  return candidate;
}

// ---------- 60s TTL LRU 缓存 ----------
const CACHE_TTL_MS = 60_000;
const CACHE_CAP = 200;
const cache = new Map<string, { ts: number; result: CompleteResult }>();

function cacheKey(req: CompleteInputRequest, pick: PickResult): string {
  const budget = CTX_BUDGET[req.ctx ?? "medium"];
  const inputTail = (req.input ?? "").slice(-budget.inputChars);
  const historyTail = (req.history ?? []).slice(-3).map((h) => h.slice(-Math.min(budget.historyChars, 2000))).join("\u0001");
  return `${pick.model.provider}|${pick.model.id}|${pick.reasoning}|${req.ctx ?? "medium"}|${inputTail}|${historyTail}`;
}

function cacheGet(key: string): CompleteResult | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return hit.result;
}

function cacheSet(key: string, result: CompleteResult) {
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), result });
}

// ---------- 主入口 ----------
export async function completeInput(req: CompleteInputRequest): Promise<CompleteResult> {
  const budget = CTX_BUDGET[req.ctx ?? "medium"];
  const pick = await pickModel(req.provider);
  const key = cacheKey(req, pick);

  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const maxTokens = pick.reasoning ? budget.maxTokensReasoning : budget.maxTokensPlain;

  const runtime = await getRuntime();
  const registry = new ModelRegistry(runtime);
  // 直接用 getAll 选中的模型对象（同 id 多版本时 find 可能解析到另一个版本）
  const model = pick.model as never;

  // 组装消息（§6 + 前缀缓存设计）：历史上下文在前（稳定前缀）+ 当前输入在尾（仅尾部变化）
  // 单条 user 拼接 → provider 自动前缀缓存（deepseek cacheRead 计费）命中：用户在末尾继续打字时
  // 只追加几个字符，前缀（system+历史+输入前段）完全不变 → 每次都命中缓存、成本≈0。
  const historyTexts = (req.history ?? [])
    .filter((h) => typeof h === "string" && h.trim())
    .map((h) => h.trim());
  // 取最近的至多 6 条（保最近意图），各自截尾到预算内
  let historyBudget = budget.historyChars;
  const recent: string[] = [];
  for (let i = historyTexts.length - 1; i >= 0 && historyBudget > 0; i--) {
    const h = historyTexts[i];
    const part = h.slice(-historyBudget);
    recent.unshift(part.length < h.length ? `…${part}` : part);
    historyBudget -= part.length;
  }
  const input = (req.input ?? "").trim();
  const inputTail = input.slice(-budget.inputChars);
  const inputText = inputTail.length < input.length ? `…${inputTail}` : inputTail;
  const userText = recent.length
    ? `【历史上下文】\n${recent.join("\n\n")}\n\n【当前正在输入】\n${inputText}`
    : inputText;

  const options: Record<string, unknown> = {
    maxTokens,
    temperature: 0.2, // 速度优先：低随机
  };
  if (pick.reasoning) {
    // 推理模型：显式关思考（仅对 thinkingLevelMap 支持 off 的 provider 生效；不支持的忽略）
    options.reasoning = "off";
  }

  const assistant = await registry.complete(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText, timestamp: Date.now() }],
  }, options as never);

  const blocks = assistant.content ?? [];
  const raw = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // 后处理后：把结果裁成一句
  let text = stripRepeatedPrefix(trimToSentence(raw || ""), inputText);
  // thinking-only 兜底（推理模型关闭失败时）：取最后一段 thinking 的收尾作为候选
  if (!text) {
    const think = blocks.filter((b) => b.type === "thinking" && typeof (b as { thinking?: string }).thinking === "string")
      .map((b) => (b as { thinking: string }).thinking)
      .pop() || "";
    text = stripRepeatedPrefix(trimToSentence(think), inputText);
  }
  if (!text) throw new Error("empty-completion");

  const result: CompleteResult = {
    text,
    provider: pick.model.provider,
    model: pick.model.id,
    reasoning: pick.reasoning,
    usage: assistant.usage
      ? { input: assistant.usage.input ?? 0, output: assistant.usage.output ?? 0 }
      : undefined,
    cached: false,
  };
  cacheSet(key, result);
  return result;
}