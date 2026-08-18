/**
 * ai-invoke —— core 暴露给扩展的「通用 AI 调用」（invokeAI）
 *
 * 设计（2026-08 架构收敛）：core **只**提供最底层模型调用，不组装任何业务。
 *   输入：任意 system + messages（或追加到末条）+ 可选模型/采样参数
 *   输出：{ text, usage } —— 不做补全/语音/上下文/项目现场/统计（那些全归扩展）
 *   统计：扩展拿到 usage 后自己记账（写自己的 token 账本）。
 *
 * 模型：独立 ModelRuntime（只读 ~/.pi/agent/models.json，refreshOnCreate:false，不落盘、零网络）。
 *       模型由调用方指定 provider/modelId；缺省 → 全局非推理最便宜。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface InvokeAIMessage { role: "system" | "user" | "assistant"; content: string }
export interface InvokeAIUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface InvokeAIInput {
  /** 模型：provider/modelId（如 "opencode-go-2" / "deepseek-v4-pro"）；缺省取全局非推理最便宜 */
  provider?: string;
  modelId?: string;
  /** 调用方扩展 id（core 记账时归并；由 core 注入层自动填） */
  caller?: string;
  system?: string;
  messages: InvokeAIMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 推理级别（如 "off"），provider 支持才生效 */
  reasoning?: string;
}
export interface InvokeAIResult {
  text: string;
  provider: string;
  model: string;
  usage?: InvokeAIUsage;
}

const AGENT_DIR = join(homedir(), ".pi", "agent");
const MODELS_PATH = process.env.PI_MODELS_JSON || join(AGENT_DIR, "models.json");

let runtimePromise: Promise<ModelRuntime> | null = null;
let runtimeError: unknown = null;
function getRuntime(): Promise<ModelRuntime> {
  if (runtimeError) return Promise.reject(runtimeError);
  if (runtimePromise) return runtimePromise;
  runtimePromise = ModelRuntime.create({ modelsPath: MODELS_PATH, refreshOnCreate: false, allowModelNetwork: false })
    .catch((err) => { runtimeError = err; runtimePromise = null; throw err; });
  return runtimePromise;
}

type ModelLike = { provider: string; id: string; reasoning?: boolean; cost?: { input?: number } };

async function resolveModel(provider?: string, modelId?: string): Promise<{ runtime: ModelRuntime; model: ModelLike }> {
  const runtime = await getRuntime();
  const reg = new ModelRegistry(runtime);
  const all = reg.getAll();
  if (provider && modelId) {
    const m = all.find((x) => x.provider === provider && x.id === modelId);
    if (m) return { runtime, model: m as unknown as ModelLike };
    throw new Error(`model-not-found:${provider}/${modelId}`);
  }
  // 缺省：provider 内非推理最便宜 → 全局
  const pool = provider ? all.filter((m) => m.provider === provider) : all;
  const ranked = [...pool].sort((a, b) => {
    const ra = a.reasoning ? 1 : 0, rb = b.reasoning ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return ((a.cost?.input ?? 0) - (b.cost?.input ?? 0)) || a.id.localeCompare(b.id);
  });
  const best = ranked[0];
  if (!best) throw new Error("no-models");
  return { runtime, model: best as unknown as ModelLike };
}

function toUsage(u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined): InvokeAIUsage | undefined {
  if (!u) return undefined;
  return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
}

// ---------- token 统计（core 基础设施，非业务；集中记账） ----------
export interface AiUsageRow { at: number; caller: string; provider: string; model: string; in: number; out: number; cacheRead: number; cacheWrite: number }
const usages: AiUsageRow[] = [];
function recordUsage(r: Omit<AiUsageRow, "at">) {
  usages.push({ at: Date.now(), ...r });
  if (usages.length > 2000) usages.splice(0, usages.length - 2000);
}
export function aiUsage(totalOnly = false): { totals: { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number }; byCaller: Record<string, number>; recent: AiUsageRow[] } {
  const byCaller: Record<string, number> = {};
  const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  for (const u of usages) {
    totals.in += u.in; totals.out += u.out; totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite; totals.calls++;
    byCaller[u.caller || "?"] = (byCaller[u.caller || "?"] || 0) + u.in;
  }
  return { totals, byCaller, recent: totalOnly ? [] : usages.slice(-20) };
}

export async function invokeAI(input: InvokeAIInput): Promise<InvokeAIResult> {
  const { runtime, model } = await resolveModel(input.provider, input.modelId);
  const registry = new ModelRegistry(runtime);
  const opts: Record<string, unknown> = {};
  if (input.maxTokens) opts.maxTokens = input.maxTokens;
  if (input.temperature != null) opts.temperature = input.temperature;
  if (input.reasoning) opts.reasoning = input.reasoning;
  const assistant = await registry.complete(model as never, {
    systemPrompt: input.system,
    messages: input.messages.map((m) => ({ role: m.role, content: m.content, timestamp: 0 })) as never,
  }, opts as never);
  const text = (assistant.content ?? [])
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text).join("");
  const usage = toUsage(assistant.usage);
  // core 集中记账（基础设施，人人共享样本）
  if (usage) recordUsage({ caller: input.caller || "?", provider: model.provider, model: model.id, in: usage.input, out: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
  return { text, provider: model.provider, model: model.id, usage };
}