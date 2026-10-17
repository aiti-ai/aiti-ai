import { existsSync, readFileSync } from "fs";
import { stat } from "fs/promises";
import { resolve, join } from "path";
import { createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { orderSelectorModels, resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { readModelsConfig } from "@/lib/models-config-store";
import { annotateVisibleModels, parseModelCheckState, type AvailKind } from "@/lib/model-visibility";
import { rememberProviderModels, withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { inferRemovedWorktree } from "@/lib/worktree";

export const dynamic = "force-dynamic";

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
  let modelList: ModelsData["modelList"] = [];
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
  await rememberProviderModels(services.modelRuntime);
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    withDeferredProviderModels(services.modelRuntime),
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  // pi's /model order drives the selector order (upstream #783 — never re-sort by
  // name: a models.json provider loses the order its file gives). Local model
  // visibility rides on that order: models.json enabled:false entries are filtered
  // out at provider and model level, and the model-check extension's availability
  // is annotated (pure logic in lib/model-visibility; unit-testable).
  const modelsCfg = readModelsConfig();
  const providersCfg = (modelsCfg.providers ?? {}) as Record<string, unknown>;
  modelList = annotateVisibleModels(
    orderSelectorModels(scope).map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      input: m.input,
    })),
    providersCfg,
    readModelCheckAvail(),
  );
  // Name map / thinking levels cover the picker-visible models only — a model
  // hidden by enabled:false keeps rendering historical messages from raw ids
  // rather than pretending it is still selectable.
  const pickerVisible = new Set(modelList.map((m) => `${m.provider}:${m.id}`));
  for (const m of visible) {
    if (!pickerVisible.has(`${m.provider}:${m.id}`)) continue;
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
      savedDefaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
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
  savedDefaultThinkingLevel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

async function handleModels(requestedCwd: string | null): Promise<Response> {
  const resolvedCwd = resolve(requestedCwd || process.cwd());
  // A subagent run isolated in a worktree has that worktree removed when the run
  // finishes, yet its session file still records the worktree as its cwd. Fall back
  // to the main repo it branched from, so opening a finished subagent resolves the
  // same models a non-isolated one would. The roots check below runs on the folder
  // actually answered from, so the fallback reaches no project that was not allowed
  // by name already.
  const cwd = existsSync(resolvedCwd)
    ? resolvedCwd
    : inferRemovedWorktree(resolvedCwd)?.projectRoot ?? resolvedCwd;

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
