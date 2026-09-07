import { stat } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { readModelsConfig } from "@/lib/models-config-store";

export const dynamic = "force-dynamic";

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string }
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

/** aiti-model-check 的探测/运行期状态（state.json，落盘）。返回 provider/model → 可用性。
 *  仅展示提示（429/错误），绝不据此自动禁用——禁用是用户的显式操作。
 *  文件不存在/不可解析 → 空 Map（无状态可展示，静默降级）。 */
type AvailKind = "ok" | "rl" | "err" | "unprobed";
function readModelCheckAvail(): Map<string, AvailKind> {
  const out = new Map<string, AvailKind>();
  try {
    const statePath = join(getAgentDir(), "..", "web", "data", "aiti-model-check", "state.json");
    if (!existsSync(statePath)) return out;
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      models?: Record<string, { lastProbedAt?: number; lastOk?: boolean; rateLimited?: boolean }>;
    };
    for (const [key, m] of Object.entries(raw.models ?? {})) {
      if (!m || typeof m !== "object") continue;
      if (!m.lastProbedAt) out.set(key, "unprobed");
      else if (m.lastOk) out.set(key, "ok");
      else if (m.rateLimited) out.set(key, "rl");
      else out.set(key, "err");
    }
  } catch {
    /* 状态文件损坏/不可读 → 无状态展示 */
  }
  return out;
}

async function loadModels(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  // 临时禁用（models.json 的 enabled:false）→ 选择器不展示：provider 级 + 模型级都过滤。
  // 与 pi-models-combo 引擎 isVisibleModel 同源语义（该补丁经 Next.js 多模块图不一定作用到
  // 本 route 的 ModelRuntime，这里显式过滤兜底）。禁用只影响展示，配置保留。
  const modelsCfg = readModelsConfig();
  const disabledProviders = new Set<string>();
  const disabledModelIds = new Map<string, Set<string>>();
  for (const [pid, pcfgRaw] of Object.entries(modelsCfg.providers ?? {})) {
    const pcfg = pcfgRaw as Record<string, unknown> | null;
    if (!pcfg || typeof pcfg !== "object") continue;
    if (pcfg.enabled === false) disabledProviders.add(pid);
    if (Array.isArray(pcfg.models)) {
      for (const mRaw of pcfg.models) {
        const m = mRaw as Record<string, unknown> | null;
        if (!m || typeof m !== "object" || m.enabled !== false) continue;
        const mid = String(m.id ?? m.model ?? "");
        if (mid) {
          if (!disabledModelIds.has(pid)) disabledModelIds.set(pid, new Set());
          disabledModelIds.get(pid)!.add(mid);
        }
      }
    }
  }
  const visibleModels = visible.filter(
    (m) => !disabledProviders.has(m.provider) && !disabledModelIds.get(m.provider)?.has(m.id),
  );
  // 可用性状态（aiti-model-check 探测/运行期 429·错误）→ 仅展示提示，不自动禁用
  const avail = readModelCheckAvail();
  const providerAvailCount: Record<string, { rl: number; total: number }> = {};
  for (const m of visibleModels) {
    const c = (providerAvailCount[m.provider] ??= { rl: 0, total: 0 });
    c.total++;
    if (avail.get(`${m.provider}/${m.id}`) === "rl") c.rl++;
  }
  const providerRL = new Set<string>();
  for (const [pid, c] of Object.entries(providerAvailCount)) {
    if (c.total > 0 && c.rl === c.total) providerRL.add(pid); // 全部模型都限流 → 整体 429
  }
  modelList = visibleModels.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    input: m.input,
    avail: avail.get(`${m.provider}/${m.id}`),
    ...(providerRL.has(m.provider) ? { providerRL: true } : {}),
  })).sort(compareModelEntries);
  for (const m of visibleModels) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
