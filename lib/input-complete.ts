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
 *   - **模型 = 补全专用档**（默认 `AITI_COMPLETE_MODEL`，缺省 opencode-go-2/deepseek-v4-pro，
 *     实测质量/速度可用）；传 provider 时在该 provider 内选非推理最便宜→推理最便宜；
 *     DEFAULT 缺失 → 回退全局非推理最便宜。
 *   - **速度优先**：非推理 maxTokens 小档（60/96/144）；推理 160/256/384，且尽力 reasoning:"off"。
 *   - 输出后处理：剥围栏→裁到首个句读符、去与输入尾部的重复前缀；无句子结果丢弃。
 *   - 60s TTL LRU 缓存：同一 provider/model+输入串停顿重触发不重复呼出模型。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getRpcSession, getRpcSessionInfos } from "./rpc-manager";

export type CompleteContextSize = "small" | "medium" | "large";
export type CompleteMode = "complete" | "voice-fix";

export interface CompleteInputRequest {
  /** 缺省取 DEFAULT_COMPLETE_MODEL（补全专用档）；传则限定该 provider 内按非推理→推理最便宜选 */
  provider?: string;
  /** complete=逐句续写（默认）；voice-fix=语音歧义判定/修复（无歧义 → 返回空 text） */
  mode?: CompleteMode;
  /** 当前输入全文（服务端按档位截尾） */
  input: string;
  /** 本会话历史 user 消息文本（可选） */
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
  "你是编程开发场景的 AI 助手（coding agent），用户在编写与代码、工程、调试、架构、性能、技术判断相关的输入。",
  "你是聊天输入框的逐句补全器。下面这条 user 消息是一整段内容：前部是本会话历史上下文，最后是用户当前正在输入的文字（或想继续写下去的句尾）。",
  "任务：直接续写最后一段文字——输出紧接着它的下一句话，让整段读起来连贯自然，且严格保持在编程/工程场景内。",
  "铁律：绝不偏移到小说、故事、日常办公、闲聊等与本会话编程主题无关的内容；绝不输出元话语（如「我们需要…」「您能提供…」这类提问或转述）；",
  "不解释、不评价、不换行、不加编号、不用 markdown；保持用户语言与文风（中文用中文、英文用英文）；一句话 ≤ 60 字；",
  "不重复或改写已有文本；若结尾已是完整断句（。！？!?…），则写下一句的开头。宁可短，不可编造无关内容。",
  "",
  "示例（编程场景）：",
  "历史：无 ｜ 当前输入：请帮我分析一下这个页面的性能问题",
  "输出：重点关注网络请求、图片体积和 DOM 渲染开销。",
  "历史：无 ｜ 当前输入：把这段代码改成 TypeScript",
  "输出：同时补上函数返回类型的定义。",
  "历史：无 ｜ 当前输入：总结一下今天的改动",
  "输出：并列出影响面最大的几处重构。",
].join("\n");

// ---------- voice-fix 判定 prompt：语音转写歧义修复（主动；无歧义必须回空，严格） ----------
const VOICE_FIX_PROMPT = [
  "你是编程开发场景下的语音转写校对器（coding agent）。下面这条 user 消息是用户语音输入转写成的文字（可能有同音/近音/漏字错误，常见于代码词、技术专名的音译）。",
  "任务：判断其中是否存在需要修复的歧义或转写错误（结合下方历史上下文判断，如有历史也一并给出）。",
  "输出规则：",
  "  · 无歧义/无需修改 → 只输出：无；",
  "  · 有歧义或明显转写错误、且能给出与原文不同的更合理文本 → 只输出修复后的完整句（保持原意与语气，不解释、不加引号、不用 markdown）；",
  "  · 若你给出的修复与原句相同，说明无歧义，一律输出：无。",
  "绝不编造歧义；宁可漏报，不要只为了提供一个修复而强行改动无错文本。",
  "",
  "典型同音/音译示例（务必识别这类）：",
  "语音：帮我把这断代码改成太空脚本 → 修复：帮我把这段代码改成 TypeScript",
  "语音：我用的是有效果钩子来管理状态 → 修复：我用的是 useEffect 钩子来管理状态",
  "语音：多克容器一直重启 → 修复：docker 容器一直重启",
  "语音：这个组件在卸载时清理监听器 → 修复：无（无歧义）",
].join("\n");

function systemFor(mode: CompleteMode | undefined): string {
  return mode === "voice-fix" ? VOICE_FIX_PROMPT : SYSTEM_PROMPT;
}

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
 *   - 默认 `opencode-go-2/deepseek-v4-pro`（实测质量/速度可用；约 2.2s、成本≈0.0007$/次）。
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

// ---------- 上下文（若调用方未传 history，则取当前会话最近 user 消息文本——只读不写、不碰会话模型） ----------
function contextHistory(): string[] {
  const extract = (w: unknown): string[] | null => {
    const inner = (w as { inner?: unknown } | null)?.inner;
    const msgs = inner && (inner as { messages?: unknown }).messages;
    if (!Array.isArray(msgs)) return null;
    const texts: string[] = [];
    for (const m of msgs as Array<{ role?: string; content?: unknown }>) {
      if (m.role !== "user") continue;
      const c = m.content;
      let t = "";
      if (typeof c === "string") t = c;
      else if (Array.isArray(c)) t = c.filter((b) => (b as { type?: string; text?: string }).type === "text")
        .map((b) => (b as { text: string }).text).join("");
      if (t && t.trim()) texts.push(t);
    }
    return texts.length ? texts : null; // 全量 user 消息——不做滚动切片，保持同 session 前缀稳定以命中缓存
  };
  try {
    // 先看运行中会话，再回退内存中空闲会话（idle wrapper 也载有该会话历史）
    for (const id of getRpcSessionInfos()) {
      const w = getRpcSession(id.id);
      const hit = w && extract(w);
      if (hit) return hit;
    }
  } catch (e) { /* 拿不到就无上下文 */ }
  return [];
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

function cacheKey(req: CompleteInputRequest, pick: PickResult, history?: string[]): string {
  const budget = CTX_BUDGET[req.ctx ?? "medium"];
  const mode = req.mode === "voice-fix" ? "v" : "c";
  const inputTail = (req.input ?? "").slice(-budget.inputChars);
  const historyTail = (history ?? req.history ?? []).slice(-3).map((h) => h.slice(-Math.min(budget.historyChars, 2000))).join("\u0001");
  return `${pick.model.provider}|${pick.model.id}|${pick.reasoning}|${mode}|${req.ctx ?? "medium"}|${inputTail}|${historyTail}`;
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
  const mode = req.mode === "voice-fix" ? "voice-fix" : "complete";
  // 历史：调用方未传时自动带当前会话上下文（对续写与语音判定都有帮助）
  const history = req.history && req.history.length ? req.history : contextHistory();
  const pick = await pickModel(req.provider);
  const key = cacheKey(req, pick, history);

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
  const historyTexts = history
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
    ? `【历史上下文】\n${recent.join("\n\n")}\n\n【语音转写】\n${inputText}`
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
    systemPrompt: systemFor(mode),
    messages: [{ role: "user", content: userText, timestamp: Date.now() }],
  }, options as never);

  const blocks = assistant.content ?? [];
  const raw = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // voice-fix：只剥包裹/空格取整句；"无" 视为无歧义 → text 空（合法，前端不显示）
  if (mode === "voice-fix") {
    let t = (raw || "").replace(/^```[a-zA-Z0-9]*\s*/g, "").replace(/```\s*$/g, "").trim();
    if (/^(无|无歧义|不需要修复|不需要|没有|没歧义|无需|N\/A|none|no)$/i.test(t)) t = "";
    if (t && (t === inputText || t === input)) t = ""; // 修复=原文 → 视为无歧义，不提示
    const result: CompleteResult = {
      text: t,
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