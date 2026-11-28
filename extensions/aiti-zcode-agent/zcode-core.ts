/**
 * zcode-core — aiti-zcode-agent core logic (pure module, testable; research notes in docs/zcode-desktop-cli-agent-analysis.md)
 *
 * Responsibilities:
 *   1. Runtime lifecycle (§3/§8.1): feature path → auto-detect (Windows install dirs / mounted instance / ~/.zcode AppImage)
 *      → auto-download (official site #all-downloads direct links) → `--appimage-extract` extraction cache (no root needed)
 *   2. Credential chain (§5): desktop credentials.json decryption (aes-256-gcm + fallback secret)
 *      → silent `zcode-api-key` exchange via the official login path (check-then-create, idempotent) → configDir cache (0600)
 *   3. Per-turn process orchestration (§8.3): spawn node zcode.cjs --json --mode M [--resume sid] --prompt T
 *   4. Output parsing: --json = a single pretty JSON object (verified 2026-09-06 on runtime 0.16.5, printed in full on exit 0)
 *
 * Testability: fetch is fully injectable; the ~/.zcode location can be overridden via AITI_ZCODE_HOME; no global polling anywhere.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync, closeSync, cpSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createDecipheriv, createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
// Controlled-login shared layer (authoritative source pi-web-ext/_shared/controlled-login.mjs; the copy ships with the extension — keep both sides in sync when changing)
import { cleanEnv, tailLine } from "@aiti-ai/ext-shared/controlled-login";
// P1' launch wrapper (docs/aiti-custom-agent-plan.md): launch resolution goes through the shared layer
import { spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetch timeout fallback for the credential chain (hardened 2026-09-15: the 4-step serial key exchange had no timeout — a hanging endpoint left the turn stuck forever). */
function withFetchTimeout(f: FetchImpl, ms = 15_000): FetchImpl {
  return (url, init) => {
    const signals: AbortSignal[] = [];
    if (init?.signal) signals.push(init.signal);
    signals.push(AbortSignal.timeout(ms));
    return f(url, { ...init, signal: AbortSignal.any(signals) });
  };
}

// ============================================================================
// Constants (provider table = CLI built-in constants, verified in §5.1)
// ============================================================================

/** providerId of a model ref → Anthropic-compatible endpoint (ZCODE_BASE_URL must be set explicitly, otherwise bigmodel falls back to api.anthropic.com). */
export const PROVIDER_BASE_URL: Record<string, string> = {
  bigmodel: "https://open.bigmodel.cn/api/anthropic",
  zai: "https://api.z.ai/api/anthropic",
};

/**
 * ZCode platform root (same as desktop: the desktop process sets env `ZCODE_BASE_URL=https://zcode.z.ai`).
 * The app-server channel injects this into ZCODE_BASE_URL; the engine then fetches `{platformRoot}/api/v1/agent/configs`,
 * reads `data.proxyEndpoint.mapping` to **dynamically route** provider direct requests to the ultra gateway, and completes
 * the handshake signature (ClientRequestSigningV4) on the provider domain — identical to desktop requests (signature headers included).
 * The oneshot channel does not use the platform root (ZCODE_BASE_URL stays the provider baseURL for direct connections).
 */
export const ZCODE_PLATFORM_BASE_URL = "https://zcode.z.ai";

/** start-plan (trial plan) endpoint fallback: used when the desktop registry is missing (official zcode.z.ai plan gateway, analysis §9). */
export const START_PLAN_BASE_URL = "https://zcode.z.ai/api/v1/zcode-plan/anthropic";

/** providerId wire form at the protocol layer: start-plan must carry the `builtin:` prefix — the runtime's
 *  runtime-headers reverse-request trigger matches exactly `builtin:*-start-plan` (verified in analysis §9.2:
 *  a bare id never sends `interaction/requestProviderRuntimeHeaders`). */
export function wireProviderId(providerId: string): string {
  return isStartPlanChannel(providerId) ? `builtin:${providerId}` : providerId;
}

/**
 * start-plan credential (same as desktop): the `zcodejwttoken` field of the credential store's OAuth token set
 * (same source as the asar `loadZcodeJwtTokenForProvider`; no key exchange, never persisted; fingerprint memo prevents repeated decryption).
 * Missing → fail-loud with actionable guidance.
 */
export async function ensureStartPlanCredential(opts: { log?: (msg: string) => void }): Promise<CredentialResult> {
  const fp = credentialFingerprint();
  const mem = fp ? memJwt.get(fp) : undefined;
  if (mem) return { apiKey: mem, providerId: "start-plan", source: "cache" };
  const raw = (() => {
    try {
      return JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(buildNotLoggedInMessage("bigmodel-start-plan", `凭据文件不可读：${e instanceof Error ? e.message : String(e)}`));
    }
  })();
  let plain: Record<string, string>;
  try {
    plain = decryptCredentials(raw, deriveCredentialSecret());
  } catch (e) {
    throw new Error(buildNotLoggedInMessage("bigmodel-start-plan", `凭据解密失败：${e instanceof Error ? e.message : String(e)}`));
  }
  const jwt = plain["zcodejwttoken"]?.trim();
  if (!jwt) {
    throw new Error(
      "ZCode 套餐通道缺少 zcodejwttoken（桌面端/CLI 登录后凭据库应含该字段）。\n" +
      "请打开 ZCode 桌面端完成登录（或工具条 🔑 受控登录）后重试；" +
      `凭据文件：${credentialsPath()}`,
    );
  }
  opts.log?.(`[aiti-zcode-agent] start-plan 凭据就绪（zcodejwttoken ${jwt.length}B）`);
  if (fp) memJwt.set(fp, jwt);
  return { apiKey: jwt, providerId: "start-plan", source: "fresh" };
}

/** zcodejwttoken memo (keyed by credential fingerprint; invalidated automatically when a desktop re-login changes the fingerprint). */
const memJwt = new Map<string, string>();

export interface AliyunCaptchaConfig {
  sceneId: string;
  prefix: string;
  region: string;
}

/**
 * Captcha SDK init triple (same data source as desktop): server client config `data.configs.captcha`
 * (`/api/v1/client/configs`, Bearer zcodejwttoken; analysis §9 / plan §3.4 path 3).
 * enabled:false or missing fields → null (captcha card unusable on the frontend, turn fails with a readable message).
 */
export async function fetchCaptchaConfig(jwt: string, f: FetchImpl = fetch): Promise<AliyunCaptchaConfig | null> {
  f = withFetchTimeout(f);
  const res = await f("https://zcode.z.ai/api/v1/client/configs", {
    headers: { Authorization: `Bearer ${jwt}`, "X-ZCode-App-Version": "3.11.2" },
  });
  if (!res.ok) throw new Error(`client/configs HTTP ${res.status}`);
  const j = await res.json() as { data?: { configs?: { captcha?: { enabled?: boolean; sceneId?: string; prefix?: string; region?: string } } } };
  const c = j.data?.configs?.captcha;
  if (!c?.enabled || typeof c.sceneId !== "string" || !c.sceneId || typeof c.prefix !== "string" || !c.prefix) return null;
  return { sceneId: c.sceneId, prefix: c.prefix, region: typeof c.region === "string" && c.region ? c.region : "cn" };
}

/** P1 model catalog seed (§8.4, legacy static table): now only a fallback for the dynamic catalog (buildZcodeCatalogRefs, desktop registry takes priority) —
 *  headless machines without the desktop installed fall back to this table when v2/config.json is unreadable. Do not add channels here; extend channels via the registry/plan cache. */
export const ZCODE_MODEL_REFS: Array<{ id: string; label: string }> = [
  { id: "bigmodel/GLM-5.3-Flash", label: "GLM-5.3-Flash (ZCode)" },
  { id: "bigmodel/GLM-5.3", label: "GLM-5.3 (ZCode)" },
  { id: "bigmodel/GLM-5-Turbo", label: "GLM-5-Turbo (ZCode)" },
  { id: "zai/GLM-5.3-Flash", label: "GLM-5.3-Flash (ZCode·zai)" },
  { id: "zai/GLM-5.3", label: "GLM-5.3 (ZCode·zai)" },
  { id: "zai/GLM-5-Turbo", label: "GLM-5-Turbo (ZCode·zai)" },
];

export const DEFAULT_MODEL_REF = "bigmodel/GLM-5.3-Flash";

/** Valid `--mode` values (--prompt defaults to yolo, backend scenarios pass it explicitly; unknown values fall back to build). */
export const ZCODE_MODES = ["build", "edit", "plan", "yolo"] as const;

/** Context window of the --json output (projection.contextWindow, 1M-window plan). */
export const ZCODE_CONTEXT_WINDOW = 1_000_000;

/** 3.17+ object-form session/setModel must carry options.reasoningLevel (missing → -32603 Reasoning level is required).
 *  GLM-5-series builtin level vocabulary = disabled/enabled (verified against zcode-builtin modelMatch rules); agent uses enabled (thinking on, same as desktop). */
export const ZCODE_REASONING_LEVEL = "enabled";

/**
 * 3.17+ app-server model registration personal provider config document (finalized by live testing 2026-11-07).
 *
 * Background: 3.17.2 removed `workspace/upsertModelProvider` and the runtimeModel inline
 * provider channel of session/resume|send; the only model source = Provider Registry. Account-type (zhipu-account)
 * providers need the desktop's ZCODE_OFFICIAL_ENDPOINT unix socket resolution, absent from every standalone spawn → empty registry →
 * setModel reports the model is missing from the Provider Registry → send reports "Select a model before continuing".
 * Way out = author our own personal provider config file (pointed to by ZCODE_PERSONAL_PROVIDER_CONFIG_FILE):
 * a custom provider (inline apiKey, env-only compliant) + manualProviderModelRules model cards + defaultModelSelection.
 *
 * Schema pitfalls verified by patch instrumentation (any item missing silently recovers the whole file into an empty registry):
 *   - providerRule.config.group is required and personal only accepts "standard-personal" (registry-level lss validation, stricter than zod)
 *   - personal rules have no builtinModelIds (omitted) → the model list relies on personalModelIds
 *   - manualProviderModelRules[].config is required and enabled must === true (model executable gate);
 *     properties.{contextWindow,supportsJsonSchemaOutput,supportsNativeWebSearch,
 *     supportsMidConversationSystem,inputFormat{supportsImage,Video,Pdf}},
 *     optionSpecs.{reasoningLevel:{values,map},maxOutputTokens:{max}} are all required
 *   - modelConfigRules.providerModelRules: [] key must be present (even as an empty array)
 *   - reasoningLevel level vocabulary follows builtin: disabled/enabled
 */
export function providerConfigDocument(opts: {
  providerId: string;
  providerName?: string;
  baseURL: string;
  apiKey: string;
  models: Array<{ modelId: string; contextWindow?: number }>;
  /** Session default model "provider/model" (defaultModelSelection; app-server runs one process per session, this points at the session model). */
  defaultModelRef?: string;
}): Record<string, unknown> {
  const reasoningValues = ["disabled", "enabled"];
  const modelCard = (m: { modelId: string; contextWindow?: number }) => ({
    providerId: opts.providerId,
    modelId: m.modelId,
    config: {
      enabled: true,
      properties: {
        contextWindow: m.contextWindow ?? ZCODE_CONTEXT_WINDOW,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
        inputFormat: { supportsImage: true, supportsVideo: false, supportsPdf: true },
      },
      optionSpecs: {
        reasoningLevel: { values: reasoningValues, map: "{}" },
        maxOutputTokens: { max: 128_000 },
      },
    },
  });
  const [defProvider, defModel] = (opts.defaultModelRef ?? "").split("/");
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: opts.providerId,
            ...(opts.providerName ? { providerName: opts.providerName } : {}),
            config: {
              group: "standard-personal",
              personalModelIds: opts.models.map((m) => m.modelId),
              access: { type: "zhipu-coding-plan-api-key", apiKey: opts.apiKey },
              api: { type: "anthropic-messages", baseUrl: opts.baseURL },
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: opts.models.map(modelCard),
      },
      ...(defProvider && defModel ? { defaultModelSelection: { providerId: defProvider, modelId: defModel } } : {}),
    },
  };
  return doc;
}

/**
 * Writes the provider config file (0600, includes apiKey; atomic tmp+rename).
 * Merge semantics: read the desktop personal config (default <zcodeHome>/v2/provider_config.json) → keep other
 * providers' rules and model cards → overlay/override this providerId's entry and defaultModelSelection → write to cache.
 * Returns the absolute file path (fed to ZCODE_PERSONAL_PROVIDER_CONFIG_FILE).
 */
export function writeProviderConfigFile(opts: {
  cacheDir: string;
  providerId: string;
  providerName?: string;
  baseURL: string;
  apiKey: string;
  models: Array<{ modelId: string; contextWindow?: number }>;
  defaultModelRef?: string;
  desktopPersonalPath?: string;
  log?: (m: string) => void;
}): string {
  const dir = join(opts.cacheDir, "provider-config");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${opts.providerId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  // Merge the existing personal config (parse failure treated as empty, non-blocking)
  let existing: { config?: Record<string, unknown> } = {};
  const src = opts.desktopPersonalPath ?? join(zcodeHome(), "v2", "provider_config.json");
  try {
    const raw = JSON.parse(readFileSync(src, "utf8")) as { config?: Record<string, unknown> };
    if (raw && typeof raw === "object" && raw.config && typeof raw.config === "object") existing = raw;
  } catch { /* missing or corrupt file → start from scratch */ }
  const old = existing.config as {
    providerConfigRules?: { providerRules?: Array<{ providerId: string }> };
    modelConfigRules?: { manualProviderModelRules?: Array<{ providerId: string }> };
    providerOrder?: string[];
  };
  const oldProviderRules = old?.providerConfigRules?.providerRules ?? [];
  const oldManualRules = old?.modelConfigRules?.manualProviderModelRules ?? [];
  const mine = providerConfigDocument(opts) as {
    config: {
      providerConfigRules: { providerRules: Array<Record<string, unknown>> };
      modelConfigRules: { manualProviderModelRules: Array<Record<string, unknown>> };
      defaultModelSelection?: Record<string, unknown>;
    };
  };
  const doc: Record<string, unknown> = {
    schemaVersion: 1,
    config: {
      ...(Array.isArray(old?.providerOrder) && old!.providerOrder!.length ? { providerOrder: old!.providerOrder } : {}),
      providerConfigRules: {
        // Keep other providers (including account: entries); this providerId overrides
        providerRules: [...oldProviderRules.filter((r) => r?.providerId !== opts.providerId), ...mine.config.providerConfigRules.providerRules],
      },
      modelConfigRules: {
        providerModelRules: [],
        manualProviderModelRules: [...oldManualRules.filter((r) => r?.providerId !== opts.providerId), ...mine.config.modelConfigRules.manualProviderModelRules],
      },
      defaultModelSelection: mine.config.defaultModelSelection,
    },
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  opts.log?.(`[aiti-zcode-agent] provider config 已写 ${file}（provider=${opts.providerId}，models=${opts.models.length}）`);
  return file;
}

/** Parses a model ref: "bigmodel/GLM-5.3" → { providerId, modelId }; the channel must be in the known set (seed ∪ registry ∪ plan cache), invalid → null. */
export function parseModelRef(ref: string): { providerId: string; modelId: string } | null {
  const i = ref.indexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  const providerId = ref.slice(0, i);
  const modelId = ref.slice(i + 1);
  if (providerId.includes("/")) return null;
  if (!knownChannels().has(providerId)) return null;
  return { providerId, modelId };
}

export function baseUrlFor(providerId: string): string | undefined {
  const reg = readProviderRegistry().find((p) => p.channel === providerId && p.baseURL);
  if (reg?.baseURL) return reg.baseURL;
  return PROVIDER_BASE_URL[providerId];
}

// ============================================================================
// --json output parsing (single pretty JSON object; tolerates noise lines before/after)
// ============================================================================

export interface ParsedTurn {
  sessionId?: string;
  traceId?: string;
  turnId?: string;
  /** Normalized response text (string / block array / {text} all flattened). */
  response?: string;
  usage?: Record<string, unknown>;
  projection?: Record<string, unknown>;
}

/** Parses one turn's result from stdout; returns null when no JSON can be parsed (caller treats it as a CLI failure). */
export function parseTurnOutput(stdout: string): ParsedTurn | null {
  const s = stdout.trim();
  if (!s) return null;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let m: unknown;
  try {
    m = JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  return {
    ...(typeof o.sessionId === "string" ? { sessionId: o.sessionId } : {}),
    ...(typeof o.traceId === "string" ? { traceId: o.traceId } : {}),
    ...(typeof o.turnId === "string" ? { turnId: o.turnId } : {}),
    ...(o.response !== undefined ? { response: extractResponseText(o.response) } : {}),
    ...(o.usage && typeof o.usage === "object" ? { usage: o.usage as Record<string, unknown> } : {}),
    ...(o.projection && typeof o.projection === "object" ? { projection: o.projection as Record<string, unknown> } : {}),
  };
}

/** Flattens the response field: string used as-is; block arrays take text blocks (text/thinking excluded); {text} reads the field. */
function extractResponseText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v
      .map((b) => (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string"
        ? (b as Record<string, unknown>).text as string
        : ""))
      .filter(Boolean)
      .join("");
  }
  if (v && typeof v === "object" && typeof (v as Record<string, unknown>).text === "string") {
    return (v as Record<string, unknown>).text as string;
  }
  return "";
}

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** usage → pi-web UsageReport normalization (camelCase fields, verified 2026-09). */
export function usageToReport(usage: Record<string, unknown> | undefined, model?: string): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  const out: Record<string, unknown> = { provider: "zcode", ...(model ? { model } : {}) };
  const inputTokens = num(usage.inputTokens);
  const outputTokens = num(usage.outputTokens);
  const cacheReadTokens = num(usage.cacheReadTokens);
  const cacheWriteTokens = num(usage.cacheWriteTokens);
  const totalTokens = num(usage.totalTokens);
  if (inputTokens !== undefined) out.inputTokens = inputTokens;
  if (outputTokens !== undefined) out.outputTokens = outputTokens;
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  // totalTokens fallback: approximate input as total - output when missing (CLI observed total ≈ input + output)
  if (inputTokens === undefined && totalTokens !== undefined && outputTokens !== undefined) {
    out.inputTokens = Math.max(0, totalTokens - outputTokens);
  }
  if (totalTokens !== undefined) out.totalTokens = totalTokens;
  return Object.keys(out).length > (model ? 2 : 1) ? out : undefined;
}

/** Extracts a human-readable error from stderr on CLI failure (responseBody JSON → last Error: line → tail line fallback). */
export function extractCliError(stderr: string, fallback: string): string {
  // The responseBody line is greedily matched whole (non-greedy would truncate early at inner quotes)
  const rbLine = stderr.split("\n").find((l) => l.includes("responseBody:"));
  const rb = rbLine?.match(/responseBody:\s*['"](.*)['"]\s*,?\s*$/)?.[1];
  if (rb) {
    try {
      const j = JSON.parse(rb) as { error?: { message?: unknown } };
      if (j?.error?.message) return `zcode CLI: ${String(j.error.message)}`;
    } catch { /* not JSON, keep going */ }
  }
  const errs = [...stderr.matchAll(/^Error:\s*(.+)$/gm)];
  if (errs.length > 0) return `zcode CLI: ${errs[errs.length - 1][1].trim().slice(0, 300)}`;
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) return `zcode CLI: ${lines[lines.length - 1].slice(0, 300)}`;
  return fallback;
}

// ============================================================================
// Per-turn process orchestration (§8.3: one process per turn, stdout collected in full, stderr kept as a tail ring)
// ============================================================================

export interface ZcodeTurnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  stdout: string;
  stderrTail: string;
}

const STDERR_TAIL_BYTES = 8 * 1024;

export function execZcodeTurn(opts: {
  nodeBin: string;
  runtimePath: string;
  cliArgs: string[];
  cwd: string;
  env: Record<string, string>;
  /** P2 protocol delegation: member-level launch wrapper (custom-agent path), takes priority over extman spawn.* features. */
  launchOverride?: LaunchOverride;
  /** abort hook: lets the caller kill the child once it exists. */
  onChild?: (child: ChildProcess) => void;
}): Promise<ZcodeTurnOutcome> {
  return new Promise((resolve, reject) => {
    // extman spawn.command/spawn.argsPrefix launch wrapper; default = unchanged behavior; P2 launchOverride takes priority
    const ov = opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: opts.nodeBin,
      command: ov?.command?.trim() || spawnCommand("aiti-zcode-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-zcode-agent")).args,
      driverArgs: [opts.runtimePath, ...opts.cliArgs],
      env: opts.env,
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: opts.cwd,
      warn: (m) => console.log(`[aiti-zcode-agent] ${m}`),
    });
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
    });
    opts.onChild?.(child);
    let stdout = "";
    let stderrTail = "";
    let killed = false;
    // StringDecoder for chunk-safe decoding (hardening A1): per-chunk toString can split multibyte characters
    const stdoutDec = new StringDecoder("utf8");
    const stderrDec = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : stdoutDec.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + (typeof chunk === "string" ? chunk : stderrDec.write(chunk))).slice(-STDERR_TAIL_BYTES);
    });
    child.once("error", (err) => reject(new Error(`spawn ${opts.nodeBin} 失败: ${err.message}`)));
    child.once("exit", (code, signal) => {
      if (signal) killed = true;
      resolve({ exitCode: code, signal, killed, stdout, stderrTail });
    });
  });
}

// ============================================================================
// Credential chain (§5): decrypt → silent key exchange → cache
// ============================================================================

export function zcodeHome(): string {
  return process.env.AITI_ZCODE_HOME || join(homedir(), ".zcode");
}

export function credentialsPath(): string {
  return join(zcodeHome(), "v2", "credentials.json");
}

export function codingPlanCachePath(): string {
  return join(zcodeHome(), "v2", "coding-plan-cache.json");
}

export function desktopConfigPath(): string {
  return join(zcodeHome(), "v2", "config.json");
}

/**
 * Plan availability (same data source as desktop): full passthrough of coding-plan-cache.json entryStatus.items
 * (maintained by the server after desktop login; includes *-start-plan "ZCode plan" entries since 2026-09).
 * Keys have the `builtin:` prefix stripped; unreadable/corrupt JSON → [] (desktop not installed / headless server).
 */
let _planStatusMemo: { fp: string | null; data: Array<{ channel: string; status: string }> } | null = null;

export function readPlanStatus(): Array<{ channel: string; status: string }> {
  // stat fingerprint memo: parseModelRef runs multiple times per turn on the hot path, and readProviderRegistry/readPlanStatus
  // each read a small file; cache hits while the file is unchanged (mtimeMs+size equal), invalidated when the desktop re-logins.
  const fp = statFingerprint(codingPlanCachePath());
  if (_planStatusMemo && _planStatusMemo.fp === fp) return _planStatusMemo.data;
  let data: Array<{ channel: string; status: string }> = [];
  try {
    const j = JSON.parse(readFileSync(codingPlanCachePath(), "utf8")) as {
      entryStatus?: { items?: Record<string, { status?: string }> };
    };
    data = Object.entries(j.entryStatus?.items ?? {}).map(([k, v]) => ({
      channel: k.replace(/^builtin:/, ""),
      status: typeof v?.status === "string" ? v.status : "unknown",
    }));
  } catch { /* not logged in / file missing */ }
  _planStatusMemo = { fp, data };
  return data;
}

/**
 * Plan channel status → agent-manager quota view (unified display contract, 2026-09-13):
 * zcode officially has no numeric quota API, so we surface plan channel availability (source = coding-plan-cache.json).
 * Pure function (no IO), for unit tests.
 */
export function planQuotaView(
  status: Array<{ channel: string; status: string }>,
  now = Date.now(),
): Record<string, unknown> {
  if (!status.length) {
    return { available: false, reason: "no-plan-cache", note: "未读到 coding-plan-cache.json（未装桌面端 / headless 未登录）", fetchedAt: now };
  }
  const available = status.filter((s) => s.status === "available").map((s) => s.channel);
  return {
    available: true,
    display: available.length ? `套餐：${available.join(", ")} 可用` : "套餐：无可用通道",
    unit: "plan",
    note: "z.ai/bigmodel 套餐通道状态（官方无额度数值接口）",
    packages: status.map((s) => ({ name: s.channel, note: s.status })),
    fetchedAt: now,
  };
}

// ============================================================================
// Account quota (coding-plan channel): live numeric quota via quota/limit
// ============================================================================

/** coding-plan quota endpoints per provider family (desktop BigModelUsageQuotaProvider parity, 2026-11-28 asar). */
export const QUOTA_LIMIT_URL: Record<string, string> = {
  bigmodel: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  zai: "https://api.z.ai/api/monitor/usage/quota/limit",
};

/**
 * Read the per-channel API key previously written by writeProviderConfigFile
 * (<cacheDir>/provider-config/<channel>.json → config.providerConfigRules.providerRules[].config.access.apiKey).
 * Returns null when the file is absent or the channel entry has no key — callers fall back gracefully.
 */
export function readProviderConfigApiKey(cacheDir: string, channel: string): string | null {
  const file = join(cacheDir, "provider-config", `${channel.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as {
      config?: {
        providerConfigRules?: {
          providerRules?: Array<{ providerId?: unknown; config?: { access?: { apiKey?: unknown } } }>;
        };
      };
    };
    for (const rule of j.config?.providerConfigRules?.providerRules ?? []) {
      if (rule?.providerId !== channel) continue;
      const key = rule?.config?.access?.apiKey;
      return typeof key === "string" && key.trim() ? key.trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** GET quota/limit payload (15s timeout via withFetchTimeout; injectable fetchImpl for tests). */
export async function fetchCodingPlanQuotaLimit(
  apiKey: string,
  family: string,
  f: FetchImpl = fetch,
): Promise<Record<string, unknown>> {
  f = withFetchTimeout(f);
  const res = await f(QUOTA_LIMIT_URL[family] ?? QUOTA_LIMIT_URL.bigmodel, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`quota/limit HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

type QuotaLimitBucket = {
  type?: unknown;
  unit?: unknown;
  number?: unknown;
  percentage?: unknown;
  usage?: unknown;
  currentValue?: unknown;
  remaining?: unknown;
  nextResetTime?: unknown;
};

/**
 * quota/limit payload → unified quota view (agent-manager quota view contract, qoder quotaFromUsage shape).
 * Bucket semantics verified against desktop 4.0.0 UI selectors (IB(limits,type,unit,number)):
 *   TOKENS_LIMIT unit=3 number=5 → five-hour window; TOKENS_LIMIT unit=6 → weekly window;
 *   TIME_LIMIT unit=5 number=1 → monthly credits (usage=total / currentValue=used / remaining).
 * Bucket names are STABLE KEYS (five_hour / weekly / monthly_credits) — consumers translate via
 * their i18n tables (providerUsage.bucket.* / badge.bucket.* / am.quota.pkg.*), mirroring qoder
 * (which sends user_quota / add_on_quota / org_resource_package keys).
 * Headline fields (remaining/used/total/usedPercent/unit/expiresAt) = the BINDING bucket (highest
 * usedPercent, i.e. lowest remaining ratio) so every surface leads with the tightest constraint.
 * Token windows are share buckets (x/100, unit "%"); the monthly bucket keeps real counts.
 * Pure function (no IO), for unit tests.
 */
export function quotaLimitToQuotaView(payload: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  const data = payload?.data as { limits?: unknown; level?: unknown } | undefined;
  const buckets: QuotaLimitBucket[] = Array.isArray(data?.limits) ? (data.limits as QuotaLimitBucket[]) : [];
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const keyOf = (b: QuotaLimitBucket): string => {
    if (b.type === "TOKENS_LIMIT") return num(b.unit) === 3 ? "five_hour" : "weekly";
    return "monthly_credits";
  };

  if (!buckets.length) {
    return { available: false, reason: "no-limits", note: "quota/limit 响应无 limits 数据", packages: [], fetchedAt: now };
  }

  const packages = buckets.map((b) => {
    const base: Record<string, unknown> = { name: keyOf(b) };
    const used = num(b.currentValue);
    const total = num(b.usage);
    const remaining = num(b.remaining);
    const pct = num(b.percentage);
    const reset = num(b.nextResetTime);
    if (used !== undefined) base.used = used;
    if (total !== undefined) base.total = total;
    if (remaining !== undefined) base.remaining = remaining;
    if (pct !== undefined) base.usedPercent = pct;
    if (reset !== undefined) base.nextResetTime = reset;
    return base;
  });

  // Binding bucket = highest usedPercent across all buckets (lowest remaining ratio).
  let binding: { pkg: Record<string, unknown>; pct: number } | null = null;
  for (const pkg of packages) {
    const pct = num(pkg.usedPercent);
    if (pct !== undefined && (!binding || pct > binding.pct)) binding = { pkg, pct };
  }
  const level = typeof data?.level === "string" && data.level.trim() ? data.level.trim() : null;

  const view: Record<string, unknown> = {
    available: true,
    unit: "%",
    packages,
    fetchedAt: now,
  };
  if (binding) {
    const pkg = binding.pkg;
    const isShare = num(pkg.remaining) === undefined;
    view.usedPercent = binding.pct;
    if (num(pkg.nextResetTime) !== undefined) view.expiresAt = num(pkg.nextResetTime);
    if (isShare) {
      // Token window: express remaining as the remaining share (x/100).
      view.remaining = Math.round(100 - binding.pct);
      view.total = 100;
      view.used = binding.pct;
    } else {
      if (num(pkg.remaining) !== undefined) view.remaining = num(pkg.remaining);
      if (num(pkg.total) !== undefined) view.total = num(pkg.total);
      if (num(pkg.used) !== undefined) view.used = num(pkg.used);
      view.unit = "credits";
    }
  }
  if (level) {
    view.plan = level;
    view.note = level;
  }
  return view;
}

/**
 * quota view → get_usage protocol snapshot (lib/ext/types.ts BackendUsageSnapshot) merged over
 * the latest per-turn tokens. Token windows expose only a percentage upstream: remaining is
 * expressed as the remaining share of the window (x/100) so consumers can render a bar; the
 * monthly bucket keeps real counts. Returns null when the view carries no numeric quota
 * (e.g. the plan-status fallback view) — callers then keep their tokens-only snapshot.
 * Pure function (no IO), for unit tests.
 */
export function backendUsageFromQuotaView(
  view: Record<string, unknown> | null | undefined,
  base?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!view || view.available !== true) return null;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const packages = Array.isArray(view.packages) ? (view.packages as Array<Record<string, unknown>>) : [];
  const hasNumbers = num(view.remaining) !== undefined
    || num(view.usedPercent) !== undefined
    || packages.some((p) => num(p.usedPercent) !== undefined || num(p.remaining) !== undefined);
  if (!hasNumbers) return null;

  const buckets = packages.map((p) => {
    const pct = num(p.usedPercent);
    const remaining = num(p.remaining) ?? (pct !== undefined ? Math.round(100 - pct) : undefined);
    const isShareBucket = num(p.remaining) === undefined && pct !== undefined;
    const total = num(p.total) ?? (isShareBucket ? 100 : undefined);
    const used = num(p.used) ?? (isShareBucket ? pct : undefined);
    const out: Record<string, unknown> = { name: p.name };
    if (remaining !== undefined) out.remaining = remaining;
    if (total !== undefined) out.total = total;
    if (used !== undefined) out.used = used;
    if (pct !== undefined) out.usedPercent = pct;
    const reset = num(p.nextResetTime);
    if (reset !== undefined) out.nextResetTime = reset;
    return out;
  });

  const exhausted = buckets.some((b) => b.usedPercent === 100) || num(view.remaining) === 0;
  const credits: Record<string, unknown> = { unit: typeof view.unit === "string" ? view.unit : "次" };
  for (const key of ["remaining", "used", "usedPercent", "expiresAt"] as const) {
    const v = num(view[key]);
    if (v !== undefined) credits[key] = v;
  }

  return {
    ...(base ?? {}),
    provider: "zcode",
    ...(typeof view.plan === "string" && view.plan ? { plan: view.plan } : {}),
    credits,
    buckets,
    ...(exhausted ? { quotaExceeded: true } : {}),
  };
}

/**
 * Desktop provider registry (v2/config.json provider section): channel → baseURL + model id table.
 * Maintained automatically by the desktop across versions/plans (the authoritative source instead of hardcoding endpoints and model catalogs); unreadable → [].
 */
let _registryMemo: { fp: string | null; data: Array<{ channel: string; baseURL?: string; models: string[]; label?: string }> } | null = null;

export function readProviderRegistry(): Array<{ channel: string; baseURL?: string; models: string[]; label?: string }> {
  const fp = statFingerprint(desktopConfigPath());
  if (_registryMemo && _registryMemo.fp === fp) return _registryMemo.data;
  let data: Array<{ channel: string; baseURL?: string; models: string[]; label?: string }> = [];
  try {
    const j = JSON.parse(readFileSync(desktopConfigPath(), "utf8")) as {
      provider?: Record<string, { name?: unknown; baseURL?: unknown; options?: { baseURL?: unknown }; models?: unknown }>;
    };
    data = Object.entries(j.provider ?? {}).map(([k, v]) => ({
      channel: k.replace(/^builtin:/, ""),
      // The desktop's real structure puts the endpoint at provider.options.baseURL (verified on both the 48 and 155 machines, 2026-09-12);
      // the top-level baseURL is kept as a compatibility fallback.
      ...(typeof v?.baseURL === "string" && v.baseURL
        ? { baseURL: v.baseURL }
        : typeof v?.options?.baseURL === "string" && v.options.baseURL
          ? { baseURL: v.options.baseURL }
          : {}),
      models: v?.models && typeof v.models === "object" ? Object.keys(v.models) : [],
      ...(typeof v?.name === "string" && v.name ? { label: v.name } : {}),
    }));
  } catch { /* file missing */ }
  _registryMemo = { fp, data };
  return data;
}

/** Channel → family (bigmodel-start-plan → bigmodel). */
export function channelFamily(channel: string): string {
  return channel.split("-")[0];
}

/** start-plan (ZCode plan) channel: credential injection already works desktop-style (zcodejwttoken → upsertModelProvider),
 *  but the endpoint enforces Aliyun captcha verification on model requests (3007), and verification params can only be produced by a desktop GUI session —
 *  the pi-web web environment cannot pass the captcha check (proven 2026-09-13), so headless/web cannot drive it; excluded from the catalog. */
export function isStartPlanChannel(channel: string): boolean {
  return channel.endsWith("-start-plan");
}

/** Channel ordering: driveable (API-key / coding-plan) first, start-plan (desktop) last. */
function channelRank(channel: string): number {
  return isStartPlanChannel(channel) ? 1 : 0;
}

/**
 * Dynamic model catalog (nothing hardcoded), mirroring what the desktop actually shows (2026-09-12 user requirement: never show plans inconsistent with the desktop):
 * - Channel set = static seed channels ∪ desktop registry ∪ plan cache; start-plan only when available (desktop evidence);
 * - Plan cache readable (desktop has logged in) → per-channel ruling via isChannelDriveable: channels tracked in the plan cache
 *   must be **themselves** available (tightened 2026-09-15 — the old family-level pass listed unavailable coding-plan
 *   channels, and selecting one meant 429/1113 on every turn); base channels keep the family gate; missing cache keeps everything listed, coding-plan goes through the original available gate;
 * - **Label = the zcode channel id verbatim** (`modelId (channelId)`, builtin: prefix stripped) — zero normalization, zero invented terms;
 *   decided 2026-09-13: if bigmodel-coding-plan is visible we show it as-is, never normalized into invented terminology;
 * - Registry models are authoritative: when the registry has models for a channel the static seed is not merged in (guards against delisted-tier leftovers); otherwise seed covers older models.
 * - start-plan (ZCode plan) channels are no longer excluded (since 2026-09-15, user decision): the endpoint enforces Aliyun
 *   captcha 3007 on headless/web requests, verification params only producible in a desktop GUI session — pi-web cannot pass the check (isChannelDriveable
 *   always false), so **list them as usual but append a "not yet supported" hint to the label** (listed only with desktop evidence of available, to stay consistent with the desktop),
 *   so users see the channel exists; selection/sends are intercepted with a readable message by index.ts (captcha required, not yet supported).
 * Returns `channel/modelId` refs, driveable channels first, start-plan last.
 */
export function buildZcodeCatalogRefs(): Array<{ id: string; label: string }> {
  const registry = new Map(readProviderRegistry().map((p) => [p.channel, p]));
  const planItems = readPlanStatus();
  const available = new Set(planItems.filter((x) => x.status === "available").map((x) => x.channel));
  const channels = new Set<string>([...Object.keys(PROVIDER_BASE_URL), ...registry.keys(), ...available.keys()]);
  const out: Array<{ id: string; label: string }> = [];
  for (const channel of [...channels].sort((a, b) => channelRank(a) - channelRank(b) || a.localeCompare(b))) {
    const isStart = isStartPlanChannel(channel);
    if (isStart) {
      // Plan channel (start-plan): captcha can only be produced by a desktop GUI session, pi-web cannot drive it (isChannelDriveable always false).
      // No longer excluded — listed as usual when the desktop evidence says available (label carries the "not yet supported" hint, see below), so users know it exists;
      // without evidence (channel absent from the plan cache) it stays unlisted, keeping parity with the desktop.
      if (!available.has(channel)) continue;
    } else {
      const driveable = isChannelDriveable(channel);
      if (driveable === false) continue;
      // Plan cache missing (isChannelDriveable → null, older headless machines): coding-plan channels go through the original available gate
      if (driveable === null && channel.endsWith("-coding-plan") && available.size > 0 && !available.has(channel)) {
        continue;
      }
    }
    const regModels = registry.get(channel)?.models ?? [];
    const models = regModels.length > 0
      ? regModels
      : ZCODE_MODEL_REFS.filter((m) => m.id.split("/")[0] === channel).map((m) => m.id.split("/")[1]);
    for (const modelId of models) {
      // Label = the zcode channel id verbatim (builtin: namespace prefix stripped by convention); zero normalization, zero invented terms;
      // start-plan channels get a "not yet supported" hint appended (not driveable, see the isStartPlanChannel comment).
      out.push({ id: `${channel}/${modelId}`, label: `${modelId} (${channel})${isStart ? " · desktop only" : ""}` });
    }
  }
  return out;
}

/** Channel set accepted when parsing model refs (seed ∪ registry ∪ all plan-cache entries). */
function knownChannels(): Set<string> {
  return new Set<string>([
    ...Object.keys(PROVIDER_BASE_URL),
    ...readProviderRegistry().map((p) => p.channel),
    ...readPlanStatus().map((x) => x.channel),
  ]);
}

/**
 * Lightweight probe of the default model channel family (no crypto, no network): reads the plan cache's available status,
 * preferring driveable channels (coding-plan / API-key); when only start-plan (ZCode plan) is available,
 * falls back to that family — the start-plan endpoint itself is not headless-driveable (not chosen), but the family still has
 * base / coding-plan channels (exactly what the catalog shows), so the default model should land in that available family.
 * Returns null = cannot probe (not logged in / file missing) — caller falls back to bigmodel.
 */
export function detectPlanProvider(): "bigmodel" | "zai" | null {
  const available = new Set(readPlanStatus().filter((x) => x.status === "available").map((x) => x.channel));
  for (const channel of ["bigmodel-coding-plan", "bigmodel", "zai-coding-plan", "zai"]) {
    if (available.has(channel)) return channelFamily(channel) as "bigmodel" | "zai";
  }
  // Only start-plan available (desktop trial plan): the family can still be decided — start-plan itself is never the default,
  // but same-family base/coding-plan channels are in the catalog and driveable (pitfall verified 2026-09-14: returning
  // null previously fell back to bigmodel, planting an out-of-catalog invalid default on zai-plan-only machines).
  for (const channel of available) {
    if (!isStartPlanChannel(channel)) continue;
    const family = channelFamily(channel);
    if (family === "bigmodel" || family === "zai") return family;
  }
  return null;
}

/**
 * Channel driveability ruling (channel-level tightening 2026-09-15; shared by catalog buildZcodeCatalogRefs / index.ts
 * createSession seeding and resume validation / lastUsedModelRef — do not reimplement elsewhere):
 * - start-plan: false (captcha only producible in a desktop GUI session, not headless-driveable — decided 2026-09-13);
 * - Channels tracked in the plan cache (*-coding-plan etc.): driveable only when **that channel itself** has status=available —
 *   the old family-level pass planted dead channels that hit "429/1113 on every turn once selected" (verified 2026-09-15: with only
 *   zai-start-plan available, zai-coding-plan (not_entitled) was still listed and picked as default);
 * - Base channels (bigmodel/zai, not in the plan cache, driven by OAuth/API-key credentials): keep the family gate
 *   (pass when the family has any available plan; missing credentials fall through to ensureCredential's readable error);
 * - Returns null = plan cache missing so probing is impossible (older headless machines) → caller rules with the old family logic.
 */
export function isChannelDriveable(providerId: string): boolean | null {
  if (isStartPlanChannel(providerId)) return false;
  const planItems = readPlanStatus();
  if (!planItems.length) return null;
  const own = planItems.find((x) => x.channel === providerId)?.status;
  if (own !== undefined) return own === "available";
  return planItems.some((x) => x.status === "available" && channelFamily(x.channel) === channelFamily(providerId));
}

/**
 * fallback secret derivation (§5.2, verified to decrypt):
 *   secret = ZCODE_CREDENTIAL_SECRET env ?? "zcode-credential-fallback:{platform}:{homedir}:{username}"
 */
export function deriveCredentialSecret(parts?: { platform?: string; homedir?: string; username?: string; secretEnv?: string }): string {
  const secretEnv = parts?.secretEnv ?? process.env.ZCODE_CREDENTIAL_SECRET;
  if (secretEnv) return secretEnv;
  const platform = parts?.platform ?? process.platform;
  const home = parts?.homedir ?? homedir();
  const username = parts?.username ?? userInfo().username;
  return `zcode-credential-fallback:${platform}:${home}:${username}`;
}

/** Decrypts a single enc:v1:{iv}.{tag}.{ct} (aes-256-gcm, key=sha256(secret)). */
export function decryptEncValue(enc: string, secret: string): string {
  const body = enc.replace(/^enc:v1:/, "");
  const [ivB, tagB, ctB] = body.split(".");
  const decipher = createDecipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
}

/** Decrypts the whole credentials.json: enc:v1 values decrypted one by one, plaintext values kept as-is. Throws on decryption failure. */
export function decryptCredentials(raw: Record<string, unknown>, secret: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") continue;
    out[k] = v.startsWith("enc:v1:") ? decryptEncValue(v, secret) : v;
  }
  return out;
}

/** stat fingerprint (mtimeMs:size, missing file → null): shared by the credential cache and the registry/plan data memos. */
function statFingerprint(p: string): string | null {
  try {
    const st = statSync(p);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
}

/** credentials.json fingerprint (mtimeMs:size) — invalidates caches after a desktop re-auth. null = file missing. */
export function credentialFingerprint(p = credentialsPath()): string | null {
  return statFingerprint(p);
}

/** Default org/project pick: isDefault → name contains the Chinese word for "default" → first entry (§5.3 + isDefault field verified 2026-09). */
export function pickDefault<T extends Record<string, unknown>>(list: T[] | undefined, nameField: string): T | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.find((x) => x.isDefault === true)
    ?? list.find((x) => typeof x[nameField] === "string" && (x[nameField] as string).includes("默认"))
    ?? list[0];
}

/**
 * bigmodel silent key exchange (§5.3, non-interactive replica of the official login, end-to-end verified 2026-09-06):
 * getCustomerInfo (Authorization: <token> without Bearer) → default org/project
 * → api_keys look up name="zcode-api-key" (POST-create when absent, idempotent) → copy endpoint fetches the full secretKey
 * → key = `${apiKey}.${secretKey}` (Zhipu id.secret format).
 */
export async function fetchBigModelApiKey(token: string, f: FetchImpl = fetch): Promise<string> {
  f = withFetchTimeout(f);
  const H: Record<string, string> = { Authorization: token };
  const info = await f("https://bigmodel.cn/api/biz/customer/getCustomerInfo", { headers: H });
  const infoJson = await info.json().catch(() => null) as { code?: number; msg?: string; success?: boolean; data?: Record<string, unknown> } | null;
  if (!infoJson || infoJson.code !== 200 || infoJson.success !== true) {
    throw new Error(`getCustomerInfo 失败: code=${infoJson?.code} msg=${infoJson?.msg ?? "HTTP " + info.status}`);
  }
  const orgs = infoJson.data?.organizations as Array<Record<string, unknown>> | undefined;
  const org = pickDefault(orgs, "organizationName");
  const proj = pickDefault(org?.projects as Array<Record<string, unknown>> | undefined, "projectName");
  const orgId = typeof org?.organizationId === "string" ? org.organizationId : undefined;
  const projId = typeof proj?.projectId === "string" ? proj.projectId : undefined;
  if (!orgId || !projId) throw new Error("getCustomerInfo 未返回可用的机构/项目（organizations/projects 为空）");

  const base = `https://bigmodel.cn/api/biz/v1/organization/${orgId}/projects/${projId}/api_keys`;
  const listJson = await f(base, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const items = Array.isArray(listJson?.data) ? listJson.data as Array<Record<string, unknown>> : [];
  let entry = items.find((k) => k?.name === "zcode-api-key");
  if (!entry) {
    const created = await f(base, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zcode-api-key" }),
    }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
    entry = (created?.data ?? null) as Record<string, unknown> | null;
    if (entry && Array.isArray((entry as { items?: unknown }).items)) {
      entry = ((entry as { items: Array<Record<string, unknown>> }).items ?? []).find((k) => k?.name === "zcode-api-key") ?? null;
    }
  }
  const apiKey = typeof entry?.apiKey === "string" ? entry.apiKey : undefined;
  if (!apiKey) throw new Error("zcode-api-key 查找/创建失败（api_keys 列表无该条目且创建未返回）");

  const copyJson = await f(`${base}/copy/${apiKey}`, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const d = copyJson?.data;
  const secretKey = typeof d === "string" ? d : (d as Record<string, unknown> | undefined)?.secretKey;
  if (typeof secretKey !== "string" || !secretKey || secretKey.includes("*")) {
    throw new Error(`copy secretKey 失败: code=${(copyJson as { code?: unknown })?.code}`);
  }
  return `${apiKey}.${secretKey}`;
}

/**
 * zai channel silent key exchange (§5.3 zai branch: login swaps for a biz token → Bearer through the isomorphic fbr flow).
 * ⚠️ Verified 2026-09-14: the OAuth token can only exchange for a key once at official login (it burns/expires after use),
 *    and later z/login calls get code=500 "Z.ai user information is invalid" from the server.
 *    So this function is only the fallback for "no ready-made channel key in the desktop config.json"; failures fail-loud
 *    and point to re-login / apiKeyOverride / another channel.
 */
export async function fetchZaiApiKey(token: string, f: FetchImpl = fetch): Promise<string> {
  f = withFetchTimeout(f);
  const loginJson = await f("https://api.z.ai/api/auth/z/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).then((r) => r.json()).catch(() => null) as Record<string, unknown> | null;
  const d = loginJson?.data as Record<string, unknown> | undefined;
  const biz = loginJson?.access_token ?? d?.access_token ?? d?.token;
  if (typeof biz !== "string" || !biz) {
    const code = loginJson?.code;
    const msg = loginJson?.msg;
    const detail = [
      code !== undefined ? `code=${String(code)}` : null,
      typeof msg === "string" && msg ? `msg=${msg}` : null,
    ].filter(Boolean).join(" ");
    throw new Error(
      `zai login 未换到 biz token${detail ? `（服务端：${detail}）` : "（响应结构可能与预期不同）"}。`
      + "OAuth token 过期或已用于换过 key——请重新登录 ZCode（工具条 🔑 受控登录），"
      + "或改选其它通道 / 在扩展管理器填 zcode.apiKeyOverride。",
    );
  }

  const H: Record<string, string> = { Authorization: `Bearer ${biz}` };
  const base0 = "https://api.z.ai";
  const infoJson = await f(`${base0}/api/biz/customer/getCustomerInfo`, { headers: H }).then((r) => r.json()).catch(() => null) as Record<string, unknown> | null;
  const data = (infoJson?.data ?? infoJson) as Record<string, unknown> | undefined;
  const org = pickDefault(data?.organizations as Array<Record<string, unknown>> | undefined, "organizationName");
  const proj = pickDefault(org?.projects as Array<Record<string, unknown>> | undefined, "projectName");
  const orgId = typeof org?.organizationId === "string" ? org.organizationId : undefined;
  const projId = typeof proj?.projectId === "string" ? proj.projectId : undefined;
  if (!orgId || !projId) throw new Error("zai getCustomerInfo 未返回可用的机构/项目");

  const base = `${base0}/api/biz/v1/organization/${orgId}/projects/${projId}/api_keys`;
  const listJson = await f(base, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const items = Array.isArray(listJson?.data) ? listJson.data as Array<Record<string, unknown>> : [];
  const entry = items.find((k) => k?.name === "zcode-api-key");
  const apiKey = typeof entry?.apiKey === "string" ? entry.apiKey : undefined;
  if (!apiKey) throw new Error("zai api_keys 中无 zcode-api-key（zai 通道创建流程未实现，请改用 bigmodel 通道或手动填 zcode.apiKeyOverride）");
  const copyJson = await f(`${base}/copy/${apiKey}`, { headers: H }).then((r) => r.json()).catch(() => null) as { data?: unknown } | null;
  const cd = copyJson?.data;
  const secretKey = typeof cd === "string" ? cd : (cd as Record<string, unknown> | undefined)?.secretKey;
  if (typeof secretKey !== "string" || !secretKey || secretKey.includes("*")) throw new Error("zai copy secretKey 失败");
  return `${apiKey}.${secretKey}`;
}

/** Human-readable not-logged-in guidance (§5.4, three ways out). */
export function buildNotLoggedInMessage(providerId: string, detail: string): string {
  return [
    `ZCode 凭据不可用（${detail}）。`,
    "",
    "解决（任选其一）：",
    CONTROLLED_LOGIN_HINT,
    "1. 本机装有 ZCode 桌面端：打开桌面端 → 左下角「连接使用」→ 连接 BigModel/Z.ai 完成授权，然后重试；",
    "2. headless 服务器：在有浏览器的机器上运行 zcode CLI 的 `login --no-browser`，按打印的 URL 完成 OAuth；",
    "3. 或在智谱开放平台手动创建 API Key，填到 扩展管理器 → aiti-zcode-agent → 功能管理 → zcode.apiKeyOverride。",
    "",
    `（通道：${providerId}；凭据文件：${credentialsPath()}）`,
  ].join("\n");
}

/**
 * Turn error → user-readable message (body of the UI's red error frame). Known provider errors get a cause + actionable guidance,
 * unknown errors pass through verbatim.
 */
export function humanizeZcodeError(raw: string): string {
  const s = raw.trim();
  // z.ai balance/entitlement rejection (429; official message looks like `[1113][Insufficient balance or no resource package...]`)
  if (/\[1113\]|Insufficient balance|no resource package/i.test(s)) {
    return [
      "Z.ai 账号没有 GLM Coding Plan 权益（或余额不足）——z.ai 拒绝了本次请求（错误码 1113）。",
      "解决（任选其一）：",
      "1. 在 z.ai 开通/续费 GLM Coding Plan（或充值）后重试；",
      "2. 在模型选择器改选其它可用通道的模型（如 bigmodel/…）；",
      "3. 或在 扩展管理器 → aiti-zcode-agent → 功能管理 填自己的 zcode.apiKeyOverride。",
      "",
      `原始错误：${s}`,
    ].join("\n");
  }
  return s;
}

/** Controlled-login entry guidance (toolbar 🔑 = the controlled-login dialog, docs/ext-controlled-login-standard.md). */
export const CONTROLLED_LOGIN_HINT =
  "0. 受控登录（推荐，headless 适用）：pi-web 工具条 🔑「登录 ZCode」一键发起——后端 spawn 官方 login，授权链接发给你，任意设备浏览器打开完成授权，凭据自动落盘（需 z.ai 账号；bigmodel 国内套餐走第 2 条）；";

export interface CredentialResult {
  apiKey: string;
  providerId: string;
  /** desktop = ready-made channel key from the desktop config.json (exchanged and written at official login; the official CLI reuses it every turn). */
  source: "override" | "cache" | "fresh" | "desktop";
}

/**
 * Ready-made channel key from the desktop config.json (`builtin:<providerId>.options.apiKey`).
 * The official CLI calls z/login once at OAuth login to exchange for the key and writes it here, then reuses it every turn;
 * the exchanged OAuth token burns, so a repeated z/login always fails (verified 2026-09-14) — the credential chain reuses this key first.
 */
export function readDesktopChannelApiKey(providerId: string): string | null {
  try {
    const j = JSON.parse(readFileSync(desktopConfigPath(), "utf8")) as {
      provider?: Record<string, { options?: { apiKey?: unknown } }>;
    };
    const k = j.provider?.[`builtin:${providerId}`]?.options?.apiKey;
    return typeof k === "string" && k.trim() ? k.trim() : null;
  } catch {
    return null;
  }
}

// In-memory cache: reuse while the credential fingerprint is unchanged (avoids per-turn decryption + per-turn API calls)
const memCred = new Map<string, { apiKey: string; fingerprint: string | null }>();

function keyCachePath(configDir: string): string {
  return join(configDir, "zcode-api-key.json");
}

function readKeyCache(configDir: string): { apiKey: string; providerId: string; fingerprint: string | null } | null {
  try {
    const j = JSON.parse(readFileSync(keyCachePath(configDir), "utf8")) as { apiKey?: unknown; providerId?: unknown; fingerprint?: unknown };
    if (typeof j.apiKey !== "string" || !j.apiKey) return null;
    return {
      apiKey: j.apiKey,
      providerId: typeof j.providerId === "string" ? j.providerId : "",
      fingerprint: typeof j.fingerprint === "string" ? j.fingerprint : null,
    };
  } catch {
    return null;
  }
}

function writeKeyCache(configDir: string, v: { apiKey: string; providerId: string; fingerprint: string | null }): void {
  try {
    mkdirSync(configDir, { recursive: true });
    const p = keyCachePath(configDir);
    // Create the file with 0600 first, then write content (avoids a window of loose permissions)
    if (!existsSync(p)) closeSync(openSync(p, "w", 0o600));
    writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn("[aiti-zcode-agent] key 缓存写失败（不影响本轮）:", e instanceof Error ? e.message : e);
  }
}

/**
 * ensureCredential (§8.2): override → ready-made desktop config.json channel key → memory cache (fingerprint-checked)
 * → disk cache → decrypt + silent key exchange. providerId follows "the provider of the current model ref" (model choice decides the channel).
 */
export async function ensureCredential(opts: {
  providerId: string;
  configDir: string;
  override?: string;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}): Promise<CredentialResult> {
  const { providerId, configDir } = opts;
  const log = opts.log ?? (() => {});
  if (opts.override) return { apiKey: opts.override, providerId, source: "override" };
  if (isStartPlanChannel(providerId)) {
    throw new Error(
      `ZCode 套餐通道（${providerId}）暂无法在无头模式驱动（2026-09-13 桌面端逆向复核）：\n` +
      "官方套餐端点（zcode.z.ai/api/v1/zcode-plan/anthropic）对模型请求强制阿里云验证码校验" +
      "（3007 CAPTCHA_VERIFY_FAILED / x-aliyun-captcha-verify-param，桌面端内嵌 zcode-aliyun-captcha 组件解验，含 captcha-retry 重试流）。\n" +
      "凭据注入本身已按桌面同款打通（凭据库 zcodejwttoken → workspace/upsertModelProvider inline apiKey，请求可直达套餐端点），" +
      "但验证码参数只能由桌面 GUI 会话产生，同一 JWT 无头直连即 400 captcha verify failed。\n" +
      "请改选 Coding Plan / API Key 通道的模型（bigmodel/… 或 zai/…）；套餐通道请在 ZCode 桌面端内使用。",
    );
  }

  const fp = credentialFingerprint();
  const memKey = `${providerId}`;

  // Desktop logged in and this channel has a ready-made key (exchanged at official login, written into config.json; the official CLI reuses it every turn):
  // reuse directly, never call z/login again (the OAuth token burns after one exchange; verified 2026-09-14
  // as code=500 "Z.ai user information is invalid").
  const desktopKey = readDesktopChannelApiKey(providerId);
  if (desktopKey) {
    memCred.set(memKey, { apiKey: desktopKey, fingerprint: fp });
    return { apiKey: desktopKey, providerId, source: "desktop" };
  }

  const mem = memCred.get(memKey);
  if (mem && mem.fingerprint === fp) return { apiKey: mem.apiKey, providerId, source: "cache" };

  const disk = readKeyCache(configDir);
  if (disk && disk.providerId === providerId && disk.fingerprint !== null && disk.fingerprint === fp) {
    memCred.set(memKey, { apiKey: disk.apiKey, fingerprint: fp });
    return { apiKey: disk.apiKey, providerId, source: "cache" };
  }

  const raw = (() => {
    try {
      return JSON.parse(readFileSync(credentialsPath(), "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(buildNotLoggedInMessage(providerId, `凭据文件不可读：${e instanceof Error ? e.message : String(e)}`));
    }
  })();
  let plain: Record<string, string>;
  try {
    plain = decryptCredentials(raw, deriveCredentialSecret());
  } catch (e) {
    throw new Error(buildNotLoggedInMessage(providerId, `凭据解密失败（跨设备拷贝的 credentials.json 无法在本机解开）：${e instanceof Error ? e.message : String(e)}`));
  }
  const family = channelFamily(providerId);
  const token = plain[`oauth:${family}:access_token`];
  if (!token) {
    const has = Object.keys(plain).filter((k) => k.startsWith("oauth:") && k.includes(":access_token")).map((k) => k.split(":")[1]);
    const detail = has.length > 0
      ? `已登录通道为 [${has.join(", ")}]，与当前模型通道 ${providerId} 不匹配（可在模型选择器切换通道，或重新授权）`
      : "credentials.json 中无 OAuth token（未登录）";
    throw new Error(buildNotLoggedInMessage(providerId, detail));
  }
  log(`[aiti-zcode-agent] 凭据指纹变化，静默换取 ${family} zcode-api-key…`);
  const apiKey = family === "bigmodel"
    ? await fetchBigModelApiKey(token, opts.fetchImpl)
    : await fetchZaiApiKey(token, opts.fetchImpl);
  memCred.set(memKey, { apiKey, fingerprint: fp });
  writeKeyCache(configDir, { apiKey, providerId, fingerprint: fp });
  return { apiKey, providerId, source: "fresh" };
}

/** Test hook: clears the in-memory credential cache. */
export function resetCredentialCacheForTests(): void {
  memCred.clear();
}

/** Test hook: clears the registry/plan data memos (stat-fingerprint caches of readProviderRegistry/readPlanStatus). */
export function resetZcodeCatalogCacheForTests(): void {
  _registryMemo = null;
  _planStatusMemo = null;
}

// ============================================================================
// Runtime lifecycle (§3/§8.1): explicit path → detect → download → extraction cache
// ============================================================================

export interface ResolvedRuntime {
  /** Absolute zcode.cjs path (executed with node). */
  cjsPath: string;
  /** AppImage version (ZCODE_APP_VERSION aligned with the desktop UA; best-effort parse from app.asar on Windows installs; omitted when the source is not an AppImage). */
  appVersion?: string;
  origin: "feature" | "install" | "mount" | "appimage" | "download";
}

/** AppImage filename → version (ZCode-3.11.2-linux-x64.AppImage → 3.11.2). */
export function parseAppImageVersion(p: string): string | null {
  const m = p.match(/ZCode-(\d+(?:\.\d+)+)/);
  return m ? m[1] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Extraction cache dir: <extRoot>/cache/runtime/ZCode-<ver>/resources/glm/zcode.cjs (the extraction root is renamed directly to ZCode-<ver>).
 *  Data layering: configDir = <extRoot>/config → cache lives under dirname(configDir). */
export function cachedRuntimeCjs(configDir: string, version: string): string {
  return join(dirname(configDir), "cache", "runtime", `ZCode-${version}`, "resources", "glm", "zcode.cjs");
}

/**
 * Readability probe: statSync still reports "file exists" (isFile() passes) for stale FUSE mount leftovers
 * (the /tmp/.mount_ZCode-* empty shells left after an AppImage unmounts); only open/read surfaces ENOTCONN —
 * an open+read probe is added on top of stat-passing candidates, so a stale mountpoint cannot hijack runtime resolution (root cause of the 2026-09-18 production incident).
 */
export function isReadableFile(p: string): boolean {
  try {
    const fd = openSync(p, "r");
    try { readSync(fd, Buffer.alloc(8), 0, 8, 0); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}

function findCjsUnderDir(dir: string): string | null {
  const candidates = [join(dir, "resources", "glm", "zcode.cjs"), join(dir, "zcode.cjs")];
  for (const c of candidates) {
    try { if (statSync(c).isFile() && isReadableFile(c)) return c; } catch { /* next */ }
  }
  return null;
}

/**
 * Common Windows install dirs (covers NSIS / portable / per-user Electron installs):
 *   %ProgramFiles%\ZCode, %ProgramFiles(x86)%\ZCode, %LOCALAPPDATA%\ZCode, %LOCALAPPDATA%\Programs\ZCode.
 * env is injectable (test isolation).
 */
export function windowsInstallDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  // Windows paths always joined with backslashes (path.join yields "/" on non-win32 hosts; tests pin backslashes;
  // behavior unchanged on win32 — these simple segments have no ".." or trailing separators, so join is equivalent)
  const winJoin = (...parts: string[]) => parts.filter(Boolean).join("\\");
  const out: string[] = [];
  for (const key of ["ProgramFiles", "ProgramFiles(x86)"]) {
    const base = env[key];
    if (base) out.push(winJoin(base, "ZCode"));
  }
  const la = env.LOCALAPPDATA;
  if (la) {
    out.push(winJoin(la, "ZCode"));
    out.push(winJoin(la, "Programs", "ZCode"));
  }
  return [...new Set(out)];
}

/**
 * Best-effort desktop version parse from resources/app.asar in a Windows install dir (ZCODE_APP_VERSION aligns the UA).
 * Supports the @electron/asar v3 new format (header at file head: [u32 x4][header JSON][data]) and the
 * old format (header at file tail: [data][u32 size][u32 headerSize][header JSON]);
 * any failure returns null (a missing version is non-fatal, the runtime itself already works).
 */
export function detectWindowsInstallVersion(installDir: string): string | null {
  let fd: number;
  try { fd = openSync(join(installDir, "resources", "app.asar"), "r"); } catch { return null; }
  try {
    const st = fstatSync(fd);
    const readPkgVersion = (headerBuf: Buffer, offsetBase: number): string | null => {
      try {
        const header = JSON.parse(headerBuf.toString("utf8")) as { files?: Record<string, { size: number; offset?: number | string }> };
        const pj = header.files?.["package.json"];
        if (!pj) return null;
        const off = parseInt(String(pj.offset), 10);
        if (!Number.isFinite(off) || !Number.isFinite(pj.size) || off < 0) return null;
        const pos = offsetBase + off;
        if (pos + pj.size > st.size) return null;
        const dbuf = Buffer.alloc(pj.size);
        if (readSync(fd, dbuf, 0, pj.size, pos) !== pj.size) return null;
        const v = (JSON.parse(dbuf.toString("utf8")) as { version?: unknown })?.version;
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    };
    // New format: [u32][u32 size][u32 size-4][u32 headerSize][header JSON][data], header JSON starts at offset 16
    const head = Buffer.alloc(16);
    if (st.size > 16 && readSync(fd, head, 0, 16, 0) === 16) {
      const headerSize = head.readUInt32LE(12);
      if (headerSize > 0 && 16 + headerSize < st.size) {
        const hbuf = Buffer.alloc(headerSize);
        if (readSync(fd, hbuf, 0, headerSize, 16) === headerSize && hbuf.toString("utf8").includes("\"files\"")) {
          const v = readPkgVersion(hbuf, 16 + headerSize);
          if (v) return v;
        }
      }
    }
    // Old format: tail [u32 size][u32 headerSize][header JSON], header JSON start = size - last 8 bytes
    if (st.size > 8) {
      const tail = Buffer.alloc(8);
      if (readSync(fd, tail, 0, 8, st.size - 8) === 8) {
        const size = tail.readUInt32LE(0);
        const headerSize = tail.readUInt32LE(4);
        const headerStart = st.size - size;
        if (headerSize > 0 && headerSize + 8 === size && headerStart >= 0 && headerStart + headerSize <= st.size) {
          const hbuf = Buffer.alloc(headerSize);
          if (readSync(fd, hbuf, 0, headerSize, headerStart) === headerSize) {
            const v = readPkgVersion(hbuf, 0);
            if (v) return v;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Removes the rename target placeholder dir when empty (rename requires the target to not exist). */
function rmdirIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch { /* already absent is fine */ }
}

/**
 * Extracts an AppImage (no root needed): prefers pattern extraction of resources/glm/* (CLI only, skips 200MB of Electron),
 * falls back to full extraction. Output lands in <extRoot>/cache/runtime/ZCode-<ver>/ (same-partition rename, cross-device cp fallback).
 * Note: configDir = <extRoot>/config (three dirs symmetric) → cache root = dirname(configDir).
 */
export async function extractAppimage(appImage: string, configDir: string, version: string, log = console.log): Promise<string> {
  const cached = cachedRuntimeCjs(configDir, version);
  if (existsSync(cached)) return cached;
  const work = mkdtempSync(join(tmpdir(), "zcode-extract-"));
  try {
    try { chmodSync(appImage, 0o755); } catch { /* read-only mounts etc. — --appimage-extract may still work */ }
    // Try pattern extraction first (glob built into the AppImage runtime); old runtimes without pattern support fall back to full
    for (const args of [["--appimage-extract", "resources/glm/*"], ["--appimage-extract"]]) {
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(appImage, args, { cwd: work, stdio: "ignore" });
        child.once("error", () => resolve(false));
        child.once("exit", (code) => resolve(code === 0));
      });
      const produced = findCjsUnderDir(join(work, "squashfs-root"));
      if (ok && produced) {
        // The 3.17+ provider gate needs <resources>/config/provider/zcode-builtin.json, which the glm-only pattern misses
        // → run a second pattern extraction to fill the gap (extracted into a separate temp dir then merged, sidestepping unclear old-runtime re-extraction behavior).
        const cfg = join(work, "squashfs-root", "resources", "config", "provider", "zcode-builtin.json");
        if (!existsSync(cfg)) {
          const work2 = mkdtempSync(join(tmpdir(), "zcode-extract-cfg-"));
          try {
            const ok2 = await new Promise<boolean>((resolve) => {
              const c2 = spawn(appImage, ["--appimage-extract", "resources/config/*"], { cwd: work2, stdio: "ignore" });
              c2.once("error", () => resolve(false));
              c2.once("exit", (code) => resolve(code === 0));
            });
            const srcCfg = join(work2, "squashfs-root", "resources", "config");
            if (ok2 && existsSync(srcCfg)) {
              cpSync(srcCfg, join(work, "squashfs-root", "resources", "config"), { recursive: true });
            }
          } finally {
            rmSync(work2, { recursive: true, force: true });
          }
        }
        // Rename the extraction root squashfs-root wholesale to <extRoot>/cache/runtime/ZCode-<ver>
        // (destRoot = three levels up from cached: zcode.cjs→glm→resources→ZCode-<ver>)
        const destRoot = join(cached, "..", "..", "..");
        mkdirSync(join(destRoot, ".."), { recursive: true });
        rmdirIfEmpty(destRoot);
        try {
          renameSync(join(work, "squashfs-root"), destRoot);
        } catch {
          cpSync(join(work, "squashfs-root"), destRoot, { recursive: true });
        }
        log(`[aiti-zcode-agent] AppImage 解压完成（${args.length > 1 ? "pattern" : "full"}）→ ${cached}`);
        return cached;
      }
      rmSync(join(work, "squashfs-root"), { recursive: true, force: true });
    }
    throw new Error(`--appimage-extract 失败（AppImage: ${appImage}）`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Official entry pages → set of CDN direct links (the cn/en pages parse identically, §3.1).
 *  The path segment is hyphenated `linux-x64` (captured 2026-09-08); the `linux/x64` slashed form is legacy compatibility. */
export function extractReleaseUrls(html: string): Array<{ ver: string; url: string }> {
  const clean = html.replaceAll("\\/", "/");
  const re = /cdn-zcode\.z\.ai\/zcode\/electron\/releases\/(\d+(?:\.\d+)+)\/(?:linux-x64|linux\/x64)\/ZCode-[\d.]+-linux-x64\.AppImage/g;
  const out = new Map<string, string>();
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    out.set(m[1], `https://${m[0]}`);
  }
  return [...out].map(([ver, url]) => ({ ver, url }));
}

export function pickLatestVersion(vers: string[]): string | null {
  if (vers.length === 0) return null;
  return vers.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}

/** Downloads the AppImage (streamed to disk; writes a .part temp file first, renames only on completion — so an interrupted half file is never mistaken for a cache). */
export async function downloadAppimage(url: string, destFile: string, f: FetchImpl = fetch, log = console.log, signal?: AbortSignal): Promise<void> {
  const res = await f(url, { redirect: "follow", ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) throw new Error(`下载失败 HTTP ${res.status}（${url}）`);
  mkdirSync(join(destFile, ".."), { recursive: true });
  const partFile = `${destFile}.part`;
  const { pipeline } = await import("node:stream/promises");
  const { createWriteStream } = await import("node:fs");
  const { Readable } = await import("node:stream");
  let seen = 0;
  let lastLogged = 0;
  const src = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  src.on("data", (chunk: Buffer) => {
    seen += chunk.length;
    if (seen - lastLogged >= 64 * 1024 * 1024) {
      lastLogged = seen;
      log(`[aiti-zcode-agent] 下载中… ${(seen / 1024 / 1024).toFixed(0)} MB`);
    }
  });
  try {
    await pipeline(src, createWriteStream(partFile));
    if (seen < 1_000_000) throw new Error(`下载内容异常（仅 ${seen} 字节，疑似错误页）`);
    renameSync(partFile, destFile);
  } catch (e) {
    rmSync(partFile, { force: true });
    throw e;
  }
}

/**
 * resolveRuntime (§8.1):
 *   1. featurePath (zcode.cjs / extracted dir / AppImage, any of these)
 *   2. Windows install dirs (ZCode desktop under Program Files / LOCALAPPDATA; automatic on win32)
 *   3. Auto-detect: /tmp/.mount_ZCode dot-prefixed dirs (mounted running instance, freshest) → ~/.zcode/ZCode-*.AppImage (highest version)
 *   4. autoDownload: download via official direct links into configDir/apps → extraction cache
 * All miss → readable error (fail-loud).

Module-level result cache: identical args (featurePath/configDir/autoDownload/mountScanDir) hit directly —
cjsPath is stable; avoids per-turn readdir/extract checks and duplicate logs.
 */
export async function resolveRuntime(opts: {
  featurePath?: string;
  configDir: string;
  autoDownload?: boolean;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
  /** Mounted-instance scan dir (defaults to the system tmpdir; tests inject an empty dir to isolate the real environment). */
  mountScanDir?: string;
  /** Windows install dir scan list (defaults to Program Files / LOCALAPPDATA on win32; tests inject [] to isolate real local installs). */
  winInstallDirs?: string[];
  /** Cancel signal for the download phase (for abort). */
  signal?: AbortSignal;
}): Promise<ResolvedRuntime> {
  const cacheKey = JSON.stringify([
    opts.featurePath ?? "", opts.configDir, !!opts.autoDownload, opts.mountScanDir ?? "",
    opts.winInstallDirs ?? null,
  ]);
  const memo = resolveRuntimeCache.get(cacheKey);
  if (memo && existsSync(memo.cjsPath)) return memo;
  const resolved = await resolveRuntimeUncached(opts);
  resolveRuntimeCache.set(cacheKey, resolved);
  return resolved;
}

const resolveRuntimeCache = new Map<string, ResolvedRuntime>();

async function resolveRuntimeUncached(opts: {
  featurePath?: string;
  configDir: string;
  autoDownload?: boolean;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
  mountScanDir?: string;
  winInstallDirs?: string[];
  signal?: AbortSignal;
}): Promise<ResolvedRuntime> {
  const log = opts.log ?? (() => {});
  const f = opts.fetchImpl ?? fetch;

  // 1) User-specified path
  const fp = opts.featurePath?.trim();
  if (fp) {
    let st: import("node:fs").Stats | null = null;
    try { st = statSync(fp); } catch { /* falls through to the error */ }
    if (st?.isFile()) {
      if (/\.(cjs|js|mjs)$/.test(fp)) return { cjsPath: fp, origin: "feature" };
      const ver = parseAppImageVersion(fp) ?? "unknown";
      const cjs = await extractAppimage(fp, opts.configDir, ver, log);
      return { cjsPath: cjs, appVersion: ver === "unknown" ? undefined : ver, origin: "feature" };
    }
    if (st?.isDirectory()) {
      const cjs = findCjsUnderDir(fp);
      if (cjs) return { cjsPath: cjs, origin: "feature" };
    }
    throw new Error(`zcode.runtimePath 指定的路径不可用：${fp}（需为 zcode.cjs 文件、含 resources/glm/zcode.cjs 的目录、或 ZCode AppImage）`);
  }

  // 2) Windows install detection (ZCode desktop under Program Files / LOCALAPPDATA; on a hit, use the install dir's CLI directly,
  //    no extraction, no download; version best-effort parsed from resources/app.asar → ZCODE_APP_VERSION aligns the UA).
  const winDirs = opts.winInstallDirs ?? (process.platform === "win32" ? windowsInstallDirs() : []);
  if (winDirs.length > 0) {
    const hits: Array<{ dir: string; cjs: string; ver: string | null }> = [];
    for (const dir of winDirs) {
      const cjs = findCjsUnderDir(dir);
      if (cjs) hits.push({ dir, cjs, ver: detectWindowsInstallVersion(dir) });
    }
    hits.sort((a, b) => {
      if (a.ver && b.ver) return compareVersions(b.ver, a.ver);
      if (a.ver) return -1;
      if (b.ver) return 1;
      return 0;
    });
    const best = hits[0];
    if (best) {
      log(`[aiti-zcode-agent] 使用 Windows 安装 runtime${best.ver ? ` ZCode ${best.ver}` : ""}（${best.dir}）`);
      return { cjsPath: best.cjs, ...(best.ver ? { appVersion: best.ver } : {}), origin: "install" };
    }
  }

  // 3a) Mounted running instance (desktop currently running; version unknown → ZCODE_APP_VERSION not set)
  try {
    for (const name of readdirSync(opts.mountScanDir ?? tmpdir())) {
      if (!name.startsWith(".mount_ZCode")) continue;
      const cjs = findCjsUnderDir(join(opts.mountScanDir ?? tmpdir(), name));
      if (cjs) {
        log(`[aiti-zcode-agent] 使用挂载实例 runtime: ${cjs}`);
        return { cjsPath: cjs, origin: "mount" };
      }
    }
  } catch { /* /tmp unreadable etc. */ }

  // 3b) Extraction cache first (<extRoot>/cache/runtime/ZCode-*/…/zcode.cjs): cache stays usable after the AppImage source is deleted/upgraded
  const runtimeDir = join(dirname(opts.configDir), "cache", "runtime");
  const cachedVers: Array<{ ver: string; cjs: string }> = [];
  try {
    for (const name of readdirSync(runtimeDir)) {
      const m = name.match(/^ZCode-(\d+(?:\.\d+)+)$/);
      if (!m) continue;
      const cjs = findCjsUnderDir(join(runtimeDir, name));
      if (cjs) cachedVers.push({ ver: m[1], cjs });
    }
  } catch { /* no runtime dir */ }
  const bestCached = cachedVers.sort((a, b) => compareVersions(b.ver, a.ver))[0];
  if (bestCached) {
    log(`[aiti-zcode-agent] 使用解压缓存 ZCode ${bestCached.ver}: ${bestCached.cjs}`);
    return { cjsPath: bestCached.cjs, appVersion: bestCached.ver, origin: "appimage" };
  }

  // 3c) ~/.zcode/ZCode-*.AppImage (highest version) → extract into the cache
  const appImages: string[] = [];
  try {
    for (const name of readdirSync(zcodeHome())) {
      if (/^ZCode-.*linux.*\.AppImage$/.test(name)) appImages.push(join(zcodeHome(), name));
    }
  } catch { /* no ~/.zcode */ }
  const best = appImages
    .map((p) => ({ p, ver: parseAppImageVersion(p) }))
    .filter((x): x is { p: string; ver: string } => !!x.ver)
    .sort((a, b) => compareVersions(b.ver, a.ver))[0];
  if (best) {
    const cjs = await extractAppimage(best.p, opts.configDir, best.ver, log);
    log(`[aiti-zcode-agent] 使用本机 AppImage ${best.ver}: ${cjs}`);
    return { cjsPath: cjs, appVersion: best.ver, origin: "appimage" };
  }

  // 4) Auto-download
  if (opts.autoDownload) {
    const page = await pickDownloadPage(f, opts.signal);
    const releases = extractReleaseUrls(page);
    const ver = pickLatestVersion(releases.map((r) => r.ver));
    const hit = releases.find((r) => r.ver === ver);
    if (hit) {
      log(`[aiti-zcode-agent] 自动下载 ZCode ${ver} …`);
      const dest = join(dirname(opts.configDir), "cache", "apps", `ZCode-${ver}-linux-x64.AppImage`);
      if (!existsSync(dest)) await downloadAppimage(hit.url, dest, f, log, opts.signal);
      const cjs = await extractAppimage(dest, opts.configDir, ver, log);
      return { cjsPath: cjs, appVersion: ver, origin: "download" };
    }
    throw new Error("官网下载页未解析到 linux-x64 AppImage 直链（页面结构可能变化）");
  }

  throw new Error(
    "未找到 ZCode runtime。解决（任选其一）：\n"
    + "1. 扩展管理器 → aiti-zcode-agent → 功能管理 → zcode.runtimePath 填 ZCode AppImage 或 zcode.cjs 路径；\n"
    + "2. 安装 ZCode 桌面端（https://zcode.z.ai；Windows 安装后扩展自动从安装目录复用 CLI）；\n"
    + "3. 打开功能管理里的 zcode.autoDownload 让扩展自动下载（约 300MB）。",
  );
}

async function pickDownloadPage(f: FetchImpl, signal?: AbortSignal): Promise<string> {
  for (const u of ["https://zcode.z.ai/cn", "https://zcode.z.ai/en"]) {
    try {
      const res = await f(u, { redirect: "follow", ...(signal ? { signal } : {}) });
      if (res.ok) return await res.text();
    } catch { /* next */ }
  }
  throw new Error("官网入口页抓取失败（zcode.z.ai 不可达）");
}

/**
 * node executable: the pi-web service process itself runs on node → process.execPath is the most reliable
 * (dodges the systemd-PATH-missing-nvm pitfall); overridable via ZCODE_NODE_PATH.
 */
export function resolveNodeBin(): string {
  return process.env.ZCODE_NODE_PATH || process.execPath;
}

/** Assembles the CLI argv (excluding the runtime path itself; execZcodeTurn handles the join). */
export function buildCliArgs(opts: {
  mode?: string;
  sessId?: string;
  prompt: string;
  attachPaths?: string[];
}): string[] {
  const mode = (ZCODE_MODES as readonly string[]).includes(opts.mode ?? "") ? opts.mode as typeof ZCODE_MODES[number] : "build";
  return [
    "--json",
    "--mode", mode,
    ...(opts.sessId ? ["--resume", opts.sessId] : []),
    ...(opts.attachPaths ?? []).flatMap((p) => ["--attach", p]),
    "--prompt", opts.prompt,
  ];
}

/**
 * 3.17+ CLI provider runtime gate spawn env (injected desktop-style, 2026-11-07):
 * starting tui/app-server/agent-server/login/logout or a bare run needs the builtin provider config;
 * by default it is scanned relative to the entry (<cliDir>/provider/ and <cliDir>/../../../../../config/provider/ — an npm-install
 * layout assumption); both are absent in the AppImage mount/extract layout (resources/glm/zcode.cjs) →
 * "cannot locate the CLI ZCode Built-in Provider Config" and it crashes at startup (the desktop skips the scan by supplying env directly;
 * mounted-instance env verified: BUILTIN=~/.zcode/v2/runtime/…/endpoint-<hash>/zcode-builtin.json,
 * PERSONAL=~/.zcode/v2/provider_config.json). Aligned injection:
 *   ZCODE_BUILTIN_PROVIDER_CONFIG_FILE  = <resources>/config/provider/zcode-builtin.json bundled with the runtime
 *     (exactly matching the spawned CLI version; falls back to the desktop's refreshed copy at v2/runtime/<plat>-<arch>/<ver>/endpoint-<hash>/)
 *   ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = <zcodeHome>/v2/provider_config.json
 * Keys already present in passthrough are not overridden (spawn.env / launchOverride.memberEnv explicit values win).
 */
export function providerRuntimeEnv(
  runtimeCjsPath: string | undefined,
  passthrough: Record<string, string | undefined> = {},
  appVersion?: string,
): Record<string, string> {
  const BUILTIN = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
  const PERSONAL = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
  const out: Record<string, string> = {};
  if (runtimeCjsPath && !(BUILTIN in passthrough)) {
    const bundled = join(dirname(runtimeCjsPath), "..", "config", "provider", "zcode-builtin.json");
    if (existsSync(bundled)) out[BUILTIN] = bundled;
    else {
      const refreshed = refreshedProviderConfig(zcodeHome(), appVersion);
      if (refreshed) out[BUILTIN] = refreshed;
    }
  }
  if (!(PERSONAL in passthrough)) {
    const personal = join(zcodeHome(), "v2", "provider_config.json");
    if (existsSync(personal)) out[PERSONAL] = personal;
  }
  return out;
}

/** Desktop v2 runtime refreshed copy: runtime/provider/<plat>-<arch>/<ver>/endpoint-<hash>/zcode-builtin.json (ver defaults to the highest).
 *  Dir name = same scheme as the CLI's fnt(): linux-x86_64 / windows-x86_64 / darwin-aarch64… (platform+arch composed segment). */
function refreshedProviderConfig(zcodeHomeDir: string, appVersion?: string): string | null {
  const plat = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}`;
  const platDir = join(zcodeHomeDir, "v2", "runtime", "provider", plat);
  let vers: string[];
  try {
    vers = readdirSync(platDir);
  } catch {
    return null;
  }
  const pick = appVersion && vers.includes(appVersion)
    ? appVersion
    : vers.filter((v) => /^\d+(?:\.\d+)+$/.test(v)).sort(compareVersions).at(-1);
  if (!pick) return null;
  try {
    const ep = readdirSync(join(platDir, pick)).find((d) => d.startsWith("endpoint-"));
    if (!ep) return null;
    const f = join(platDir, pick, ep, "zcode-builtin.json");
    return existsSync(f) ? f : null;
  } catch {
    return null;
  }
}

/** Assembles the governed spawn env (§8.3; UA/fingerprint tool definitions are all built by the official CLI itself). */
export function buildTurnEnv(opts: {
  modelRef: string;
  providerId: string;
  apiKey: string;
  appVersion?: string;
  passthroughEnv: Record<string, string | undefined>;
  /** Overrides ZCODE_BASE_URL (app-server channels pass the platform root; default = provider baseURL direct). */
  baseURL?: string;
  /** Absolute runtime zcode.cjs path: injects the 3.17+ provider runtime gate env (providerRuntimeEnv). */
  runtimeCjsPath?: string;
  /** Path of the self-authored personal provider config file: overrides ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
   *  (3.17+ registry model registration; the file is generated by writeProviderConfigFile merged over the desktop config). */
  personalProviderConfigFile?: string;
}): Record<string, string> {
  return {
    ...opts.passthroughEnv,
    ...providerRuntimeEnv(opts.runtimeCjsPath, opts.passthroughEnv, opts.appVersion),
    ...(opts.personalProviderConfigFile ? { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: opts.personalProviderConfigFile } : {}),
    ZCODE_MODEL: opts.modelRef,
    // Dynamic channels (*-coding-plan/*-start-plan) use registry endpoints; the static table only covers bigmodel/zai.
    ZCODE_BASE_URL: opts.baseURL ?? baseUrlFor(opts.providerId) ?? PROVIDER_BASE_URL.bigmodel,
    ZCODE_API_KEY: opts.apiKey,
    ZCODE_ENV: "production",
    ...(opts.appVersion ? { ZCODE_APP_VERSION: opts.appVersion } : {}),
  };
}

// ============================================================================
// Controlled-login driver (external Agent controlled-login standard; shared layer pi-web-ext/_shared/controlled-login.mjs)
// Mode A url-only: spawns the official `login --no-browser --json`; credentials/key exchange fully handled by the official CLI,
// closing the loop naturally with ensureCredential's fingerprint chain (docs/zcode-controlled-login-analysis.md §6).
// ============================================================================

/** login URL extraction (official print format, verified on runtime 0.16.5: stderr `Open this URL to sign in:\n<url>`). */
export function extractZcodeLoginUrl(text: string): string | null {
  const m = /Open this URL to sign in:\s*(https?:\/\/\S+)/.exec(text);
  return m ? m[1] : null;
}

/**
 * Outcome ruling (output shapes verified live):
 *   exit 0 + stdout single pretty JSON `"status":"ready"` (user{name?,email?}) → success;
 *   exit 1 + stderr `Error: Authorization timed out. Please retry login.` → timeout;
 *   everything else → failed (Error lines surfaced readably).
 */
export function interpretZcodeLogin(code: number | null, stdout: string, stderr: string): { state: "success" | "failed" | "timeout"; user?: string; error?: string } {
  if (code === 0) {
    let user: string | undefined;
    try {
      const j = JSON.parse(stdout) as { status?: unknown; user?: { name?: unknown; email?: unknown } };
      if (j?.status !== undefined && j.status !== "ready") {
        return { state: "failed", error: `zcode login 退出码 0 但 status=${String(j.status)}` };
      }
      const name = typeof j?.user?.name === "string" ? j.user.name : "";
      const email = typeof j?.user?.email === "string" ? j.user.email : "";
      if (name || email) user = name || email;
    } catch { /* not JSON (theoretically unreachable): credentials already persisted by the official CLI, treat as success without user */ }
    return { state: "success", ...(user ? { user } : {}) };
  }
  const detail = extractCliError(stderr, tailLine(stderr) || tailLine(stdout) || `zcode login 异常退出（code=${code ?? "signal"}）`);
  if (/timed out/i.test(stderr) || /timed out/i.test(stdout)) {
    return { state: "timeout", error: detail };
  }
  return { state: "failed", error: detail };
}

/** zcode family driver (loginTimeoutMs 330s: the CLI hard-times-out internally at 300s; the outer layer is one notch looser as a kill fallback). */
export const zcodeLoginDriver = {
  agentId: "zcode",
  mode: "url" as const,
  loginTimeoutMs: 330_000,
  buildLogin: ({ runtime }: { runtime: string; consoleMode?: boolean }) => ({
    cmd: resolveNodeBin(),
    args: [runtime, "login", "--no-browser", "--json"],
    // login is also inside the provider runtime gate (3.17+ bare run crashes) → same env injection
    env: { ...cleanEnv(), ...providerRuntimeEnv(runtime) },
  }),
  extractUrl: extractZcodeLoginUrl,
  interpret: interpretZcodeLogin,
};
