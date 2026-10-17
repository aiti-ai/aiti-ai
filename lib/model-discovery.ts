const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type EffortLevel = typeof EFFORT_LEVELS[number];

export interface DiscoveredModel {
  id: string;
  name?: string;
  // Capabilities the upstream list publishes, as models.json fields (#856).
  reasoning?: true;
  thinkingLevelMap?: Partial<Record<EffortLevel, string | null>>;
  contextWindow?: number;
  maxTokens?: number;
  /** Input modalities advertised by the provider; wizard seeds limits from it. */
  input?: string[];
}

// Only fields whose meaning does not vary between gateways. `max_tokens` is
// left out: LiteLLM, for one, fills it with either the input or output limit.
const CONTEXT_WINDOW_FIELDS = [
  "context_length", "contextLength", "context_window", "contextWindow",
  "max_model_len", "max_input_tokens", "inputTokenLimit",
];
const MAX_TOKENS_FIELDS = ["max_output_tokens", "maxOutputTokens", "max_completion_tokens", "outputTokenLimit"];
const REASONING_FIELDS = ["supports_reasoning", "supportsReasoning", "reasoning", "thinking"];
const EFFORT_LIST_FIELDS = ["supported_efforts", "supportedEfforts"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function firstPositiveInteger(value: Record<string, unknown>, fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const raw = value[field];
    const number = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
    if (typeof number === "number" && Number.isSafeInteger(number) && number > 0) return number;
  }
  return undefined;
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
    ?? optionalPositiveNumber(value.outputTokenLimit);
  // `value.max_tokens` is deliberately NOT a fallback (upstream #856): gateways
  // fill it with either the input or the output limit — ambiguous, dropped.

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

/**
 * An advertised effort list names pi's own levels, which pi sends as the
 * effort when thinkingLevelMap has no entry. Every level it leaves out is
 * marked unsupported (null), and `xhigh` / `max` need an entry to be offered at
 * all. `off` stays unmapped: the list does not say whether thinking can be
 * turned off. A list naming none of pi's levels maps nothing.
 */
function thinkingLevelMapFromEfforts(value: Record<string, unknown>): DiscoveredModel["thinkingLevelMap"] {
  const list = EFFORT_LIST_FIELDS.map((field) => value[field]).find(Array.isArray);
  if (!list) return undefined;
  const advertised = new Set(list.filter((effort): effort is string => typeof effort === "string"));
  if (!EFFORT_LEVELS.some((level) => advertised.has(level))) return undefined;
  const map: NonNullable<DiscoveredModel["thinkingLevelMap"]> = {};
  for (const level of EFFORT_LEVELS) {
    if (!advertised.has(level)) map[level] = null;
    else if (level === "xhigh" || level === "max") map[level] = level;
  }
  return map;
}

function capabilitiesFromValue(value: Record<string, unknown>): Omit<DiscoveredModel, "id" | "name"> {
  const reasoning = REASONING_FIELDS.some((field) => value[field] === true);
  const thinkingLevelMap = reasoning ? thinkingLevelMapFromEfforts(value) : undefined;
  const contextWindow = firstPositiveInteger(value, CONTEXT_WINDOW_FIELDS);
  const maxTokens = firstPositiveInteger(value, MAX_TOKENS_FIELDS);
  return {
    ...(reasoning ? { reasoning: true } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
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
  // 本地：从 Ark token_limits / OpenAI / Google 形状读限额与输入模态（wizard 种子）。
  const limits = readModelLimits(value);
  if (limits.contextWindow !== undefined) model.contextWindow = limits.contextWindow;
  if (limits.maxTokens !== undefined) model.maxTokens = limits.maxTokens;
  if (limits.input) model.input = limits.input;
  // 上游 #856：保留 reasoning/thinkingLevelMap 能力元数据；扁平字段作本地未命中时的兑底。
  const capabilities = capabilitiesFromValue(value);
  if (capabilities.reasoning) model.reasoning = capabilities.reasoning;
  if (capabilities.thinkingLevelMap) model.thinkingLevelMap = capabilities.thinkingLevelMap;
  if (model.contextWindow === undefined && capabilities.contextWindow !== undefined) model.contextWindow = capabilities.contextWindow;
  if (model.maxTokens === undefined && capabilities.maxTokens !== undefined) model.maxTokens = capabilities.maxTokens;
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
