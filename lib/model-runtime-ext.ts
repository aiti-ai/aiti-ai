import { DefaultResourceLoader, ModelRuntime, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * 带扩展 provider 的 ModelRuntime(进程级缓存)。
 *
 * 裸 `ModelRuntime.create()` 不执行扩展代码，看不到 pi 扩展经 registerProvider
 * 注册的自定义 provider(如 qoder-private 的 qoder/qoder-cn/qoder-local)。
 * auth 相关路由(providers 列表 / OAuth 登录)需要看到它们。
 *
 * 实现：DefaultResourceLoader 只做扩展发现与执行(显式关闭 skills/prompts/themes/
 * context 等非扩展资源)，把扩展的 pending provider 注册应用到 ModelRuntime 上。
 * 扩展来源即 pi 标准自动发现(~/.pi/agent/extensions、settings.json packages 等)，
 * 与会话侧同一份集合，不引入新目录约定。
 *
 * 缓存说明：扩展工厂只执行一次(含网络/初始化副作用)，进程内复用同一 runtime；
 * 失败不缓存，下次调用重试。
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
        noPrompts: true,
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
