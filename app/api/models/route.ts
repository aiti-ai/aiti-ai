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

/** aiti-model-check 的探测/运行期状态（state.json，落盘）。返回 provider/model → 可用性。
 *  仅展示提示（429/错误），绝不据此自动禁用——禁用是用户的显式操作。
 *  文件不存在/不可解析 → 空 Map（无状态可展示，静默降级）。 */
function readModelCheckAvail(): Map<string, AvailKind> {
  try {
    // 2026-09-13 扩展数据分层（三目录对称）：state.json 落在 cache/ 子目录；
    // 旧根路径保留回退（未迁移/旧版扩展的部署仍可读）。
    const root = join(getAgentDir(), "..", "web", "data", "aiti-model-check");
    const statePath = [join(root, "cache", "state.json"), join(root, "state.json")]
      .find((candidate) => existsSync(candidate));
    if (!statePath) return new Map();
    return parseModelCheckState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch {
    /* 状态文件损坏/不可读 → 无状态展示 */
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
  // 临时禁用（models.json 的 enabled:false）→ 选择器不展示：provider 级 + 模型级都过滤
  //（pure 逻辑在 lib/model-visibility，含可用性标注，纯函数可单测）。
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

// GET /api/models?cwd= — 查询串形态保留给存量调用方；新代码一律用 POST（cwd 走 JSON body，不落 URL/访问日志）。
export async function GET(req: Request) {
  return handleModels(new URL(req.url).searchParams.get("cwd"));
}

// POST /api/models  body: { cwd? } — 同语义；cwd 缺省时用 process.cwd()（与无 cwd 参数的 GET 一致）。
export async function POST(req: Request) {
  let bodyCwd: string | null = null;
  try {
    const body = (await req.json()) as { cwd?: unknown };
    if (typeof body.cwd === "string" && body.cwd.trim()) bodyCwd = body.cwd;
  } catch {
    // 空/非 JSON body → 默认 cwd
  }
  return handleModels(bodyCwd);
}
