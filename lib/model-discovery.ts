export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const SUPPORTED_INPUT_MODALITIES = new Set(["text", "image"]);

/**
 * Read model capability metadata from a provider's /models response so the
 * wizard can seed limits (context window / max output tokens / modalities)
 * from the provider's own data instead of guessing. Handles common shapes:
 * - Ark / Volcano Engine: token_limits.{context_window,max_output_token_length}
 * - OpenAI: max_context_window_tokens / max_output_tokens (+ input_modalities)
 * - Google: inputTokenLimit / outputTokenLimit
 * - generic: context_window / context_length / max_tokens
 */
function readModelLimits(value: Record<string, unknown>): Pick<DiscoveredModel, "contextWindow" | "maxTokens" | "input"> {
  const tokenLimits = isRecord(value.token_limits) ? value.token_limits : {};
  const contextWindow = optionalPositiveNumber(value.max_context_window_tokens)
    ?? optionalPositiveNumber(tokenLimits.context_window)
    ?? optionalPositiveNumber(value.context_window)
    ?? optionalPositiveNumber(value.inputTokenLimit)
    ?? optionalPositiveNumber(value.context_length);
  const maxTokens = optionalPositiveNumber(value.max_output_tokens)
    ?? optionalPositiveNumber(tokenLimits.max_output_token_length)
    ?? optionalPositiveNumber(value.max_output_token_length)
    ?? optionalPositiveNumber(value.outputTokenLimit)
    ?? optionalPositiveNumber(value.max_tokens);

  const modalities = isRecord(value.modalities) ? value.modalities : undefined;
  const rawModalities = Array.isArray(modalities?.input_modalities)
    ? modalities!.input_modalities
    : Array.isArray(value.input_modalities)
      ? value.input_modalities
      : undefined;
  let input: string[] | undefined;
  if (rawModalities) {
    const modalitiesList = Array.from(new Set(rawModalities
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().toLocaleLowerCase())
      .filter((entry) => SUPPORTED_INPUT_MODALITIES.has(entry))));
    if (modalitiesList.length) input = modalitiesList;
  }

  return { contextWindow, maxTokens, input };
}

function modelFromValue(value: unknown): DiscoveredModel | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!isRecord(value)) return null;

  const rawId = cleanString(value.id) ?? cleanString(value.model) ?? cleanString(value.name);
  if (!rawId) return null;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return null;
  const name = cleanString(value.display_name)
    ?? cleanString(value.displayName)
    ?? (cleanString(value.id) || cleanString(value.model) ? cleanString(value.name) : undefined);
  const model: DiscoveredModel = name && name !== id ? { id, name } : { id };
  const limits = readModelLimits(value);
  if (limits.contextWindow !== undefined) model.contextWindow = limits.contextWindow;
  if (limits.maxTokens !== undefined) model.maxTokens = limits.maxTokens;
  if (limits.input) model.input = limits.input;
  return model;
}

function listFromResponse(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "models", "results", "items"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
    if (isRecord(candidate)) return Object.values(candidate);
  }
  return [];
}

export function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of listFromResponse(value)) {
    const model = modelFromValue(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
    numeric: true,
    sensitivity: "base",
  }));
}

export function buildModelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(/\/+$/, "");

  if (!/\/models$/i.test(trimmedPath)) {
    let path = trimmedPath;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/+/g, "/");
  }

  if (api === "anthropic-messages" && !url.searchParams.has("limit")) {
    url.searchParams.set("limit", "1000");
  }
  if (api === "google-generative-ai" && !url.searchParams.has("pageSize")) {
    url.searchParams.set("pageSize", "1000");
  }
  return url;
}
