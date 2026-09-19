/**
 * ai-invoke — the generic "AI invocation" (invokeAI) the core exposes to extensions.
 *
 * Design (2026-08 architecture consolidation): the core **only** provides the lowest-level
 * model call and assembles no business logic.
 *   Input: arbitrary system + messages (or an append to the last message) + optional model/
 *   sampling parameters
 *   Output: { text, usage } — no completion/voice/context/project-snapshot/statistics (all of
 *   those belong to extensions)
 *   Accounting: extensions do their own bookkeeping once they receive usage (writing their
 *   own token ledger).
 *
 * Model: an independent ModelRuntime (reads ~/.pi/agent/models.json only, refreshOnCreate:false,
 * no persistence, zero network). The caller specifies the provider/modelId; the default is the
 * cheapest non-reasoning model globally.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface InvokeAIMessage { role: "system" | "user" | "assistant"; content: string }
export interface InvokeAIUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface InvokeAIInput {
  /** Model: provider/modelId (e.g. "opencode-go-2" / "deepseek-v4-pro"); defaults to the cheapest non-reasoning model globally */
  provider?: string;
  modelId?: string;
  /** Caller extension id (merged in core accounting; auto-filled by the core injection layer) */
  caller?: string;
  /** Session id initiating the call (best-effort from the caller; the session panel filters "this session" usage by it) */
  sessionId?: string;
  system?: string;
  messages: InvokeAIMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Reasoning level (e.g. "off"); only effective when the provider supports it */
  reasoning?: string;
}
export interface InvokeAIResult {
  text: string;
  provider: string;
  model: string;
  usage?: InvokeAIUsage;
}

// Docker normalization S2 (docker-image plan, appendix C A1): env takes priority; behavior unchanged when unset.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
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
  // Default: cheapest non-reasoning within the provider → then globally
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

// ---------- token accounting (core infrastructure, not business logic; centralized ledger) ----------
export interface AiUsageRow { at: number; caller: string; provider: string; model: string; in: number; out: number; cacheRead: number; cacheWrite: number; sessionId?: string }
// usages hangs off globalThis: next dev turbopack duplicates this module (each route holds its
// own copy), so a module-level array would keep separate ledgers — sharing via globalThis
// guarantees invokeAI accounting and ai-usage queries see the same data.
const usages: AiUsageRow[] = (globalThis as unknown as { __aiInvokeUsage?: AiUsageRow[] }).__aiInvokeUsage ??= [];
function recordUsage(r: Omit<AiUsageRow, "at">) {
  usages.push({ at: Date.now(), ...r });
  if (usages.length > 2000) usages.splice(0, usages.length - 2000);
}
export interface AiUsageSummary {
  totals: { in: number; out: number; cacheRead: number; cacheWrite: number; calls: number };
  byCaller: Record<string, number>;
  recent: AiUsageRow[];
}
/**
 * Query AI usage. When sessionId is given, only that session's calls are counted (byCaller
 * filtered accordingly), plus a global section (all sessions over the process lifetime) so
 * the panel can distinguish the two scopes; behavior is unchanged without sessionId.
 */
export function aiUsage(totalOnly = false, sessionId?: string): AiUsageSummary & { global?: AiUsageSummary["totals"] } {
  const scoped = sessionId ? usages.filter((u) => u.sessionId === sessionId) : usages;
  const agg = (rows: AiUsageRow[]) => {
    const byCaller: Record<string, number> = {};
    const totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
    for (const u of rows) {
      totals.in += u.in; totals.out += u.out; totals.cacheRead += u.cacheRead; totals.cacheWrite += u.cacheWrite; totals.calls++;
      byCaller[u.caller || "?"] = (byCaller[u.caller || "?"] || 0) + u.in;
    }
    return { totals, byCaller };
  };
  if (!sessionId) {
    const { totals, byCaller } = agg(usages);
    return { totals, byCaller, recent: totalOnly ? [] : usages.slice(-20) };
  }
  const { totals, byCaller } = agg(scoped);
  return { totals, byCaller, recent: totalOnly ? [] : scoped.slice(-20), global: agg(usages).totals };
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
  // Core centralized accounting (infrastructure; samples shared by everyone); sessionId is
  // passed best-effort so the session panel can filter per session
  if (usage) recordUsage({ caller: input.caller || "?", provider: model.provider, model: model.id, in: usage.input, out: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, sessionId: input.sessionId });
  return { text, provider: model.provider, model: model.id, usage };
}