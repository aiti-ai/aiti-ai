import { NextResponse } from "next/server";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { parseMaxTokenCap } from "@/lib/max-token-cap";

export const dynamic = "force-dynamic";

const PROBE_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verify a model's max output token cap with one minimal request (a "Reply
 * with OK only." turn). If the provider accepts `max_tokens = metadataValue`
 * the value is confirmed. If it rejects with a parseable bound (Ark reports
 * "expected a value <= 128000"), the real cap is returned so the wizard can
 * correct the metadata. Errors without a bound (auth, unknown model, timeout)
 * return ok:false and the wizard keeps the metadata value.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ ok: false, error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json(
      { ok: false, error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  let tempDir: string | undefined;

  try {
    const body = await req.json() as { providerName?: unknown; provider?: unknown; model?: unknown };
    const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
    if (!providerName) return NextResponse.json({ ok: false, error: "providerName is required" }, { status: 400 });
    if (!isRecord(body.provider)) return NextResponse.json({ ok: false, error: "provider is required" }, { status: 400 });
    if (!isRecord(body.model)) return NextResponse.json({ ok: false, error: "model is required" }, { status: 400 });

    const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
    if (!modelId) return NextResponse.json({ ok: false, error: "Model ID is required" }, { status: 400 });
    const probeMaxTokens = typeof body.model.maxTokens === "number" && Number.isFinite(body.model.maxTokens)
      ? Math.floor(body.model.maxTokens)
      : undefined;
    if (!probeMaxTokens || probeMaxTokens <= 0) {
      return NextResponse.json({ ok: false, error: "Model maxTokens is required to probe" }, { status: 400 });
    }

    tempDir = mkdtempSync(join(tmpdir(), "pi-web-model-probe-"));
    const modelsPath = join(tempDir, "models.json");
    // pi clamps max_tokens to the context window (contextWindow - context -
    // safety margin). Force a generous contextWindow on the probe entry so the
    // request carries the exact metadata maxTokens value we want to verify;
    // otherwise the clamp would silently shrink it and the probe would
    // "confirm" a value the API actually rejects.
    const modelEntry = {
      ...body.model,
      id: modelId,
      contextWindow: Math.max(128000, probeMaxTokens + 65536),
    };
    writeFileSync(modelsPath, JSON.stringify({
      providers: {
        [providerName]: {
          ...body.provider,
          models: [modelEntry],
        },
      },
    }, null, 2), "utf8");

    const modelRuntime = await ModelRuntime.create({ modelsPath });
    const loadError = modelRuntime.getError();
    if (loadError) return NextResponse.json({ ok: false, error: loadError });

    const model = modelRuntime.getModel(providerName, modelId);
    if (!model) return NextResponse.json({ ok: false, error: `Model not found: ${providerName}/${modelId}` });

    const resolved = await modelRuntime.getAuth(model);
    if (!resolved?.auth.apiKey) {
      return NextResponse.json({ ok: false, error: `No API key found for "${providerName}"` });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const message = await completeSimple(model, {
        messages: [{
          role: "user",
          content: "Reply with OK only.",
          timestamp: Date.now(),
        }],
      }, {
        apiKey: resolved.auth.apiKey,
        headers: resolved.auth.headers,
        maxTokens: probeMaxTokens,
        timeoutMs: PROBE_TIMEOUT_MS,
        maxRetries: 0,
        cacheRetention: "none",
        signal: controller.signal,
      });

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        const errorText = message.errorMessage
          ?? (controller.signal.aborted ? "Probe timed out" : "Model returned an error");
        const cap = parseMaxTokenCap(errorText);
        if (cap !== undefined && cap < probeMaxTokens) {
          return NextResponse.json({ ok: true, confirmedMaxTokens: cap });
        }
        return NextResponse.json({ ok: false, error: errorText });
      }

      // Accepted: the metadata value sits within the provider's real cap.
      return NextResponse.json({ ok: true, confirmedMaxTokens: probeMaxTokens });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: errorMessage(error) }, { status: 500 });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}
