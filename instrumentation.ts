export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Stamp an env marker on everything this server (indirectly) spawns, so port
  // discovery can still identify our children after they are re-parented by
  // daemonization (nohup / setsid / double-fork). Children inherit env at spawn
  // time, so the marker survives even when the process tree link does not.
  // NOTE: process.pid usage must stay in a dynamically imported module
  // (lib/child-marker.ts) — turbopack's Edge static analysis of this file flags
  // it as a hard compile error, recompiling (and HMR-pushing) on every request.
  const { stampChildMarker } = await import("@/lib/child-marker");
  stampChildMarker();

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // 子代理工厂：全局挂 globalThis.__piSubagentFactory（aiti-subagents 扩展经此调用）
  const { installSubagentFactory } = await import("@/lib/subagent");
  installSubagentFactory();

  // Extension framework: load + start extensions (registry on globalThis so
  // the middleware bundle can invoke hooks without importing extension code).
  // service-tunnels（发现/代理/隧道/自暴露）已抽离为扩展：其 server.startup
  // 负责创建库单例 + PI_WEB_EXPOSE 自暴露。
  const { ensureRegistry } = await import("@/lib/ext/registry");
  const { makeExtCore } = await import("@/lib/ext/core");
  const extRegistry = ensureRegistry(makeExtCore());
  await extRegistry.loadAll();
  await extRegistry.startAll();
}
