import { DefaultResourceLoader, ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * ModelRuntime with extension-registered providers (process-level cache).
 *
 * A bare `ModelRuntime.create()` does not execute extension code, so it cannot
 * see custom providers registered by pi extensions via registerProvider
 * (e.g. qoder/qoder-cn/qoder-local from the private qoder extension). Auth-related
 * routes (provider list / OAuth login) need to see them.
 *
 * Implementation: DefaultResourceLoader only performs extension discovery and
 * execution (skills/prompts/themes/context and other non-extension resources are
 * explicitly disabled), and the extensions' pending provider registrations are
 * applied to the ModelRuntime. Extension sources are the standard pi auto-discovery
 * set (~/.pi/agent/extensions, settings.json packages, etc.) — the same set the
 * session side uses, introducing no new directory convention.
 *
 * Caching: extension factories execute only once (including network/init side
 * effects) and the same runtime is reused within the process; failures are not
 * cached and are retried on the next call.
 */
let cached: Promise<ModelRuntime> | null = null;

export function getModelRuntimeWithExtensions(): Promise<ModelRuntime> {
  if (!cached) {
    cached = (async () => {
      const cwd = process.cwd();
      const agentDir = getAgentDir();
      const runtime = await ModelRuntime.create();
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });
      await loader.reload();
      const { runtime: extRuntime } = loader.getExtensions();
      for (const { name, config } of extRuntime.pendingProviderRegistrations) {
        try {
          runtime.registerProvider(name, config);
        } catch (e) {
          console.error("[model-runtime-ext] registerProvider failed:", name, e instanceof Error ? e.message : e);
        }
      }
      for (const { provider } of extRuntime.pendingNativeProviderRegistrations) {
        try {
          runtime.registerNativeProvider(provider);
        } catch (e) {
          console.error("[model-runtime-ext] registerNativeProvider failed:", provider.id, e instanceof Error ? e.message : e);
        }
      }
      extRuntime.pendingProviderRegistrations = [];
      extRuntime.pendingNativeProviderRegistrations = [];
      return runtime;
    })().catch((e) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}
