/**
 * openrouter-images-api — OpenRouter image generation through `/images/generations`.
 *
 * pi's built-in `openrouter-images` implementation posts to `chat/completions`,
 * which only works for models that return inline images in a chat response
 * (Gemini-style). OpenRouter's dedicated image models (FLUX, GPT-Image, Qwen-Image,
 * Seedream, Recraft, …) reject that with
 * `404 ... is an image generation model and cannot be used with the chat/completions endpoint`.
 *
 * This module provides the missing dispatch: same credentials/model catalog idea,
 * but the request goes to `POST {baseUrl}/images/generations` and returns base64.
 * It is registered as its own provider (`openrouter-image-api`) so the built-in
 * provider stays untouched.
 *
 * Model list is intentionally curated: OpenRouter adds models weekly, and a wrong
 * id only costs one failed call (the error is surfaced, never swallowed).
 */

import { readModelsConfig } from "./models-config-store.ts";

export const OPENROUTER_IMAGES_API = "openrouter-images-api";
export const OPENROUTER_PROVIDER = "openrouter-image-api";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Curated subset of OpenRouter's image models (id → display name). */
export const OPENROUTER_IMAGE_MODELS: Array<{ id: string; name: string }> = [
  { id: "openai/gpt-image-1", name: "OpenAI GPT-Image 1" },
  { id: "openai/gpt-image-2", name: "OpenAI GPT-Image 2" },
  { id: "black-forest-labs/flux-3-image", name: "FLUX 3" },
  { id: "black-forest-labs/flux.2-pro", name: "FLUX 2 Pro" },
  { id: "black-forest-labs/flux.2-flex", name: "FLUX 2 Flex" },
  { id: "qwen/qwen-image-3", name: "Qwen Image 3" },
  { id: "qwen/qwen-image-2.1-pro", name: "Qwen Image 2.1 Pro" },
  { id: "bytedance-seed/seedream-4.5", name: "Seedream 4.5" },
  { id: "recraft/recraft-v3", name: "Recraft v3" },
  { id: "recraft/recraft-v4.1", name: "Recraft v4.1" },
  { id: "sourceful/riverflow-v2-pro", name: "Riverflow v2 Pro" },
  { id: "x-ai/grok-imagine-image-2.0", name: "Grok Imagine 2.0" },
];

export interface OpenRouterImagesModelLike {
  provider: string;
  id: string;
  api: string;
  baseUrl?: string;
}

export interface OpenRouterImagesContextLike {
  input?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

export interface OpenRouterImagesOptionsLike {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface AssistantImagesLike {
  api: string;
  provider: string;
  model: string;
  output: Array<{ type: "image"; mimeType: string; data: string } | { type: "text"; text: string }>;
  responseId?: string;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

/** Read the OpenRouter key the host already stores (models.json `providers.openrouter.apiKey`). */
export function openRouterApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = String(env.OPENROUTER_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = readModelsConfig() as { providers?: Record<string, { apiKey?: string }> };
    return String(cfg?.providers?.openrouter?.apiKey || "").trim();
  } catch {
    return "";
  }
}

function promptOf(context: OpenRouterImagesContextLike): string {
  const parts = Array.isArray(context?.input) ? context.input : [];
  return parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => String(p.text))
    .join("\n")
    .trim();
}

function referenceImagesOf(context: OpenRouterImagesContextLike): Array<{ mimeType: string; data: string }> {
  const parts = Array.isArray(context?.input) ? context.input : [];
  return parts
    .filter((p) => p && p.type === "image" && typeof p.data === "string")
    .map((p) => ({ mimeType: String(p.mimeType || "image/png"), data: String(p.data) }));
}

/**
 * The provider implementation. Mirrors pi's contract: never throws, always
 * returns an AssistantImages whose `stopReason` tells whether it worked.
 */
export async function generateImages(
  model: OpenRouterImagesModelLike,
  context: OpenRouterImagesContextLike,
  options: OpenRouterImagesOptionsLike = {},
): Promise<AssistantImagesLike> {
  const out: AssistantImagesLike = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: "stop",
    timestamp: Date.now(),
  };
  try {
    const apiKey = String(options.apiKey || openRouterApiKey()).trim();
    if (!apiKey) throw new Error(`No API key for ${model.provider} (set OPENROUTER_API_KEY or providers.openrouter.apiKey)`);
    const prompt = promptOf(context);
    const refs = referenceImagesOf(context);
    if (!prompt && refs.length === 0) throw new Error("prompt or reference image required");
    const metadata = (options.metadata || {}) as { size?: unknown; seed?: unknown; n?: unknown };
    const body: Record<string, unknown> = { model: model.id, prompt, n: 1 };
    if (metadata.size !== undefined) {
      // OpenRouter image models disagree on the size vocabulary: some take pixel
      // dimensions ("1024x1024"), others a resolution tier + aspect_ratio
      // (FLUX 3). Forward pixel dimensions as width/height and also derive a
      // tier/aspect pair, so one call shape satisfies both families.
      const raw = String(metadata.size).trim();
      const m = /^(\d+)x(\d+)$/i.exec(raw);
      if (m) {
        const w = Number(m[1]);
        const h = Number(m[2]);
        body.width = w;
        body.height = h;
        body.size = `${w}x${h}`;
        body.resolution = w * h >= 3_000_000 ? "2K" : w * h >= 1_400_000 ? "1.5K" : w * h >= 700_000 ? "1K" : "768";
        const g = (a: number, b: number): number => (b ? g(b, a % b) : a);
        const d = g(w, h) || 1;
        body.aspect_ratio = `${w / d}:${h / d}`;
      } else {
        body.size = raw;
      }
    }
    if (metadata.seed !== undefined && Number.isFinite(Number(metadata.seed))) body.seed = Number(metadata.seed);
    if (refs.length === 1) body.image = `data:${refs[0].mimeType};base64,${refs[0].data}`;
    else if (refs.length > 1) body.images = refs.map((r) => `data:${r.mimeType};base64,${r.data}`);

    const base = String(model.baseUrl || OPENROUTER_BASE_URL).replace(/\/+$/, "");
    const ac = new AbortController();
    const timeout = Math.max(1000, Number(options.timeoutMs) || 180_000);
    const timer = setTimeout(() => ac.abort(), timeout);
    const onAbort = () => ac.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const post = async (payload: Record<string, unknown>) => {
        const res = await fetch(`${base}/images/generations`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            "http-referer": "https://aiti.pw",
            "x-title": "aiti-agent",
          },
          body: JSON.stringify(payload),
          signal: ac.signal,
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      };
      let sent = await post(body);
      if (!sent.ok && /resolution tier|aspect_ratio|not pixel dimensions/i.test(sent.text)) {
        // Tier-based models (FLUX 3) reject pixel dimensions: retry once with the
        // tier vocabulary only. One retry, never a loop.
        const retry: Record<string, unknown> = { ...body };
        delete retry.size;
        delete retry.width;
        delete retry.height;
        sent = await post(retry);
      }
      if (!sent.ok) throw new Error(`${sent.status}: ${sent.text.slice(0, 400)}`);
      const text = sent.text;
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new Error(`non-JSON response: ${text.slice(0, 200)}`); }
      const rows = Array.isArray((data as { data?: unknown }).data) ? (data as { data: Array<Record<string, unknown>> }).data : [];
      for (const row of rows) {
        const b64 = String(row?.b64_json || "");
        const url = String(row?.url || "");
        if (b64) {
          out.output.push({ type: "image", mimeType: String(row?.mime_type || "image/png"), data: b64 });
          continue;
        }
        if (!url) continue;
        const img = await fetch(url, { signal: ac.signal });
        if (!img.ok) throw new Error(`image download failed: ${img.status}`);
        const ct = String(img.headers.get("content-type") || "image/png").split(";")[0];
        out.output.push({ type: "image", mimeType: ct, data: Buffer.from(await img.arrayBuffer()).toString("base64") });
      }
      const id = (data as { id?: unknown }).id;
      if (typeof id === "string") out.responseId = id;
      if (out.output.length === 0) throw new Error("provider returned no image");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    return out;
  } catch (e) {
    out.stopReason = options.signal?.aborted ? "aborted" : "error";
    out.errorMessage = e instanceof Error ? e.message : String(e);
    return out;
  }
}

/** Provider registration config passed to `runtime.registerProvider()`. */
export function openRouterImageApiProvider() {
  // Resolve the credential at registration time: the runtime marks a provider
  // "configured" from this value, and the per-call fallback in generateImages()
  // cannot satisfy that check (it only runs after a model was picked).
  const apiKey = openRouterApiKey();
  return {
    name: "OpenRouter (image API)",
    baseUrl: OPENROUTER_BASE_URL,
    ...(apiKey ? { apiKey } : {}),
    models: OPENROUTER_IMAGE_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      api: OPENROUTER_IMAGES_API,
      type: "image" as const,
      output: ["image"],
    })),
    images: { [OPENROUTER_IMAGES_API]: { generateImages } },
  };
}
