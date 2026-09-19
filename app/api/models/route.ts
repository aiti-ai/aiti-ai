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
import { annotateVisibleModels, parseModelCheckState, type AvailKind } from "@/lib/model-visibility";

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

/** Probed/runtime availability state of the model-check extension (state.json on disk).
 *  Returns provider/model → availability. Display hints only (429/errors); never used
 *  to auto-disable anything — disabling is an explicit user action.
 *  Missing/unparseable file → empty Map (nothing to show, silent degradation). */
function readModelCheckAvail(): Map<string, AvailKind> {
  try {
    // 2026-09-13 extension data layering (three-directory scheme): state.json
    // lives in the cache/ subdirectory; the old root path is kept as a fallback
    // (deployments of unmigrated/older extension versions remain readable).
    const root = join(getAgentDir(), "..", "web", "data", "aiti-model-check");
    const statePath = [join(root, "cache", "state.json"), join(root, "state.json")]
      .find((candidate) => existsSync(candidate));
    if (!statePath) return new Map();
    return parseModelCheckState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    /* Corrupt/unreadable state file → show no availability state */
    return new Map();
  }
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
  // Temporarily disabled (enabled:false in models.json) → hidden from the picker:
  // filter at both provider and model level (pure logic lives in lib/model-visibility,
  // including availability annotation; pure functions are unit-testable).
  const modelsCfg = readModelsConfig();
  const providersCfg = (modelsCfg.providers ?? {}) as Record<string, unknown>;
  const annotated = annotateVisibleModels(visible, providersCfg, readModelCheckAvail());
  modelList = annotated.sort(compareModelEntries);
  const visibleModels = visible.filter((m) => annotated.some((a) => a.provider === m.provider && a.id === m.id));
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
  const defaultThinkingLevel = initial.thinkingLevel
    ?? (initial.model
      ? settings.getModelThinkingLevel(initial.model.provider, initial.model.id)
      : undefined)
    ?? settings.getDefaultThinkingLevel()
    ?? null;

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      defaultThinkingLevel,
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
  defaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

async function handleModels(requestedCwd: string | null): Promise<Response> {
  const cwd = resolve(requestedCwd || process.cwd());

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

// GET /api/models?cwd= — the query-string form is kept for existing callers; new
// code should always use POST (cwd travels in the JSON body, never in URLs/access logs).
export async function GET(req: Request) {
  return handleModels(new URL(req.url).searchParams.get("cwd"));
}

// POST /api/models  body: { cwd? } — same semantics; when cwd is omitted, process.cwd()
// is used (consistent with GET without the cwd parameter).
export async function POST(req: Request) {
  let bodyCwd: string | null = null;
  try {
    const body = (await req.json()) as { cwd?: unknown };
    if (typeof body.cwd === "string" && body.cwd.trim()) bodyCwd = body.cwd;
  } catch {
    // Empty/non-JSON body → default cwd
  }
  return handleModels(bodyCwd);
}
