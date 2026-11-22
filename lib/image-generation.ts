/**
 * image-generation — the core's image-generation capability for extensions.
 *
 * The pi SDK already models image generation (`ImageModel` + `generateImages()`),
 * with one built-in implementation (`openrouter-images`) and an extension path
 * (`registerProvider(name, { models: [{ type: "image", ... }], images: {...} })`).
 * What it does not expose to pi-web extensions is a way to list or call those
 * models, or to register a provider that survives a ModelRuntime rebuild.
 *
 * This module provides exactly that:
 *   listImageModels()                     — every image model + credential status
 *   generateImages(input)                 — prompt/images → base64 images (never rejects)
 *   registerImageProvider(extId, name, c) — register + ledger + replay on rebuild
 *   unregisterImageProviders(extId)       — extension shutdown cleanup
 *   replayImageProviders(pi)              — called from the model-runtime InlineExtension
 *
 * Design notes:
 *   - The ledger hangs off globalThis: turbopack duplicates this module across
 *     route graphs (same reason lib/ai-invoke.ts shares its usage array).
 *   - pi-web never touches secrets: the caller resolves its own credential
 *     (e.g. from aiti-secret-vault) and passes `apiKey` as a per-call override.
 *   - `generateImages()` on the runtime never rejects; this wrapper turns its
 *     `stopReason`/`errorMessage` into `{ ok, error }` so callers cannot mistake
 *     a failed generation for an empty one.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getModelRuntimeWithExtensions } from "./model-runtime.ts";

/** Minimal shape of pi-ai's image model (avoids importing the SDK's deep types here). */
interface ImageModelLike {
  provider: string;
  id: string;
  name?: string;
  api: string;
  baseUrl?: string;
  output?: string[];
}

export interface CoreImageModelInfo {
  provider: string;
  id: string;
  name?: string;
  /** Output modalities (`image`, optionally `text`). */
  output: string[];
  /** The provider has usable credentials (env / auth.json / registered key). */
  available: boolean;
}

export interface CoreImageGenerationInput {
  /** `provider/modelId`; either alone is enough, both missing = first available image model. */
  provider?: string;
  modelId?: string;
  /** Text prompt (text-to-image). */
  prompt?: string;
  /** Reference images (image-to-image); base64 + mimeType. */
  images?: Array<{ mimeType: string; data: string }>;
  /** Candidate count (1..8). Provider adapters take one image per call; the core loops. */
  n?: number;
  /** Passed through `options.metadata`; the provider implementation decodes it. */
  size?: string;
  seed?: number;
  /** Caller-resolved credential (e.g. from the secret vault). Overrides pi's own auth. */
  apiKey?: string;
  timeoutMs?: number;
  /** Accounting dimension (ai-usage caller). Reserved; wired in a later phase. */
  caller?: string;
  signal?: AbortSignal;
}

export interface CoreImageGenerationResult {
  ok: boolean;
  provider: string;
  model: string;
  /** Generated images, base64 + mimeType. */
  images: Array<{ mimeType: string; data: string }>;
  /** Text blocks the model also returned (some image models describe the result). */
  texts: string[];
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Readable failure reason when ok=false (never contains a credential). */
  error?: string;
}

export interface CoreImageProviderRegistration {
  ok: boolean;
  error?: string;
}

/** extId → provider name → ProviderConfigInput (unknown at this layer on purpose). */
type Ledger = Map<string, Map<string, Record<string, unknown>>>;

interface ImageGenerationState {
  ledger: Ledger;
  /** Registrations are applied to this runtime instance; a rebuild re-applies them. */
  appliedOn?: ModelRuntime;
}

const STATE_KEY = "__piWebImageProviders";

function state(): ImageGenerationState {
  const g = globalThis as { __piWebImageProviders?: ImageGenerationState };
  g.__piWebImageProviders ??= { ledger: new Map() };
  return g.__piWebImageProviders;
}

/**
 * Test seam: swap the runtime resolver. Production always goes through
 * `getModelRuntimeWithExtensions()`; tests inject a fake to cover the ledger,
 * validation and result flattening without building a real SDK runtime.
 */
let runtimeOverride: ModelRuntime | null = null;
export function __setTestRuntime(runtime: unknown): void {
  runtimeOverride = (runtime as ModelRuntime) ?? null;
}

async function resolveRuntime(): Promise<ModelRuntime> {
  return runtimeOverride ?? await getModelRuntimeWithExtensions();
}

/** Every ledger entry, flattened (replay order: extId then name, insertion stable). */
function ledgerEntries(): Array<{ extId: string; name: string; config: Record<string, unknown> }> {
  const out: Array<{ extId: string; name: string; config: Record<string, unknown> }> = [];
  for (const [extId, providers] of state().ledger) {
    for (const [name, config] of providers) out.push({ extId, name, config });
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate the caller's registration enough to fail early instead of at the
 * first generation: config must be an object with a non-empty `models` array
 * whose entries are image models carrying an `api`.
 */
function validateRegistration(config: unknown): string | null {
  if (!isRecord(config)) return "config must be an object";
  const models = config.models;
  if (!Array.isArray(models) || models.length === 0) return "config.models must be a non-empty array";
  for (const [i, m] of models.entries()) {
    if (!isRecord(m)) return `config.models[${i}] must be an object`;
    if (m.type !== "image") return `config.models[${i}].type must be "image" (only image models can be registered here)`;
    if (typeof m.id !== "string" || !m.id.trim()) return `config.models[${i}].id is required`;
    if (typeof m.api !== "string" || !m.api.trim()) return `config.models[${i}].api is required`;
  }
  const baseUrl = config.baseUrl;
  if (baseUrl !== undefined && typeof baseUrl !== "string") return "config.baseUrl must be a string";
  return null;
}

/** Apply the whole ledger to one runtime (idempotent: re-registering overwrites). */
function replayOnto(runtime: ModelRuntime): void {
  for (const { name, config } of ledgerEntries()) {
    try {
      runtime.registerProvider(name, config as never);
    } catch (e) {
      console.warn(`[pi-web] image provider replay failed for ${name}:`, e instanceof Error ? e.message : String(e));
    }
  }
  state().appliedOn = runtime;
}

/**
 * Replay every registered image provider onto a freshly built runtime.
 * Called from the model-runtime InlineExtension so registrations survive
 * TTL expiry and `/reload`.
 */
export function replayImageProviders(pi: {
  registerProvider: (name: string, config: never) => void;
}): number {
  const entries = ledgerEntries();
  for (const { name, config } of entries) {
    try {
      pi.registerProvider(name, config as never);
    } catch (e) {
      console.warn(`[pi-web] image provider replay (extension factory) failed for ${name}:`, e instanceof Error ? e.message : String(e));
    }
  }
  return entries.length;
}

/** Register an image provider on behalf of one extension (ledger + current runtime). */
export async function registerImageProvider(
  extId: string,
  name: string,
  config: unknown,
): Promise<CoreImageProviderRegistration> {
  const providerName = String(name || "").trim();
  if (!providerName) return { ok: false, error: "provider name is required" };
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(providerName)) {
    return { ok: false, error: "provider name must match [A-Za-z0-9._-]{1,80}" };
  }
  const invalid = validateRegistration(config);
  if (invalid) return { ok: false, error: invalid };

  const st = state();
  let own = st.ledger.get(extId);
  if (!own) {
    own = new Map();
    st.ledger.set(extId, own);
  }
  own.set(providerName, config as Record<string, unknown>);
  try {
    const runtime = await resolveRuntime();
    runtime.registerProvider(providerName, config as never);
    st.appliedOn = runtime;
    return { ok: true };
  } catch (e) {
    // The ledger keeps the registration so a later runtime build can still apply it.
    return { ok: false, error: `registered into the ledger, but the runtime rejected it: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Drop every provider registered by one extension (extension shutdown). */
export async function unregisterImageProviders(extId: string): Promise<string[]> {
  const st = state();
  const own = st.ledger.get(extId);
  if (!own || own.size === 0) return [];
  const names = [...own.keys()];
  st.ledger.delete(extId);
  try {
    const runtime = await resolveRuntime();
    for (const name of names) {
      try {
        runtime.unregisterProvider(name);
      } catch { /* provider may belong to another layer after a failed register */ }
    }
  } catch { /* no runtime yet: the ledger is already clean */ }
  return names;
}

/** Registered provider names per extension (diagnostics / tests). */
export function imageProviderRegistrations(): Array<{ extId: string; name: string }> {
  return ledgerEntries().map(({ extId, name }) => ({ extId, name }));
}

function imageModelsOf(runtime: ModelRuntime): ImageModelLike[] {
  try {
    return runtime.getModelsOfType("image") as unknown as ImageModelLike[];
  } catch {
    return [];
  }
}

/** Every image model known to the runtime, with credential status. */
export async function listImageModels(): Promise<CoreImageModelInfo[]> {
  const runtime = await resolveRuntime();
  const all = imageModelsOf(runtime);
  const available = new Set<string>();
  try {
    const usable = await runtime.getAvailableOfType("image");
    for (const m of usable as unknown as ImageModelLike[]) available.add(`${m.provider}\u0000${m.id}`);
  } catch {
    // A missing auth layer only means "nothing is flagged available".
  }
  return all.map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    output: Array.isArray(m.output) ? m.output : ["image"],
    available: available.has(`${m.provider}\u0000${m.id}`),
  }));
}

function pickModel(all: ImageModelLike[], provider?: string, modelId?: string): ImageModelLike | undefined {
  if (provider && modelId) return all.find((m) => m.provider === provider && m.id === modelId);
  if (modelId) return all.find((m) => m.id === modelId);
  if (provider) return all.find((m) => m.provider === provider);
  return undefined;
}

function toResult(
  base: { provider: string; model: string },
  raw: {
    output?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    stopReason?: string;
    errorMessage?: string;
  },
): CoreImageGenerationResult {
  const images: Array<{ mimeType: string; data: string }> = [];
  const texts: string[] = [];
  for (const block of raw.output ?? []) {
    if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      images.push({ mimeType: block.mimeType, data: block.data });
    } else if (block?.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  const failed = raw.stopReason === "error" || raw.stopReason === "aborted";
  const result: CoreImageGenerationResult = {
    ok: !failed && images.length > 0,
    provider: base.provider,
    model: base.model,
    images,
    texts,
  };
  if (raw.usage) {
    result.usage = {
      input: raw.usage.input ?? 0,
      output: raw.usage.output ?? 0,
      cacheRead: raw.usage.cacheRead ?? 0,
      cacheWrite: raw.usage.cacheWrite ?? 0,
    };
  }
  if (!result.ok) {
    result.error = raw.errorMessage
      || (raw.stopReason === "aborted" ? "generation aborted" : images.length === 0 ? "model returned no image" : "generation failed");
  }
  return result;
}

/**
 * Generate images. Never rejects: failures come back as `{ ok: false, error }`.
 * `n > 1` loops the provider call (the image protocol has no multi-candidate
 * parameter) and merges the blocks.
 */
export async function generateImages(input: CoreImageGenerationInput): Promise<CoreImageGenerationResult> {
  const prompt = String(input.prompt ?? "").trim();
  const refs = Array.isArray(input.images) ? input.images.filter((i) => i && typeof i.data === "string") : [];
  if (!prompt && refs.length === 0) {
    return { ok: false, provider: "", model: "", images: [], texts: [], error: "prompt or images required" };
  }

  let runtime: ModelRuntime;
  try {
    runtime = await resolveRuntime();
  } catch (e) {
    return { ok: false, provider: "", model: "", images: [], texts: [], error: `model runtime unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }

  const all = imageModelsOf(runtime);
  if (all.length === 0) {
    return { ok: false, provider: "", model: "", images: [], texts: [], error: "no image model available" };
  }
  const explicit = input.provider || input.modelId;
  let model = pickModel(all, input.provider, input.modelId);
  if (!model && explicit) {
    return {
      ok: false,
      provider: input.provider ?? "",
      model: input.modelId ?? "",
      images: [],
      texts: [],
      error: `image model not found: ${input.provider ?? "*"}/${input.modelId ?? "*"}`,
    };
  }
  if (!model) {
    // No explicit choice: prefer a model whose provider has credentials.
    try {
      const usable = (await runtime.getAvailableOfType("image")) as unknown as ImageModelLike[];
      model = usable[0];
    } catch { /* fall through to the first known model */ }
    model ??= all[0];
  }

  const n = Math.max(1, Math.min(8, Math.round(Number(input.n) || 1)));
  const context = {
    input: [
      ...(prompt ? [{ type: "text" as const, text: prompt }] : []),
      ...refs.map((r) => ({ type: "image" as const, mimeType: r.mimeType || "image/png", data: r.data })),
    ],
  };
  const metadata: Record<string, unknown> = {};
  if (input.size) metadata.size = String(input.size);
  if (input.seed !== undefined && Number.isFinite(Number(input.seed))) metadata.seed = Number(input.seed);
  const options = {
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.timeoutMs ? { timeoutMs: Math.max(1000, Number(input.timeoutMs)) } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };

  const base = { provider: model.provider, model: model.id };
  const images: Array<{ mimeType: string; data: string }> = [];
  const texts: string[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let sawUsage = false;
  let lastError = "";

  for (let i = 0; i < n; i++) {
    if (input.signal?.aborted) { lastError = "generation aborted"; break; }
    let raw: Awaited<ReturnType<ModelRuntime["generateImages"]>>;
    try {
      raw = await runtime.generateImages(model as never, context as never, options as never);
    } catch (e) {
      // Defensive: the SDK contract says it never rejects.
      lastError = e instanceof Error ? e.message : String(e);
      break;
    }
    const one = toResult(base, raw as never);
    if (!one.ok) { lastError = one.error || "generation failed"; break; }
    images.push(...one.images);
    if (one.texts.length) texts.push(...one.texts);
    if (one.usage) {
      sawUsage = true;
      usage.input += one.usage.input;
      usage.output += one.usage.output;
      usage.cacheRead += one.usage.cacheRead;
      usage.cacheWrite += one.usage.cacheWrite;
    }
    if (i < n - 1 && input.seed !== undefined) {
      // Distinct candidates from a seed-based provider; ignored elsewhere.
      metadata.seed = Number(input.seed) + i + 1;
      (options as { metadata?: Record<string, unknown> }).metadata = metadata;
    }
  }

  const result: CoreImageGenerationResult = {
    ok: images.length > 0,
    provider: base.provider,
    model: base.model,
    images,
    texts,
    ...(sawUsage ? { usage } : {}),
  };
  if (!result.ok) result.error = lastError || "model returned no image";
  return result;
}

/** Test helper: drop the ledger and the applied-runtime marker. */
export function resetImageProviders(): void {
  const st = state();
  st.ledger.clear();
  st.appliedOn = undefined;
}
