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

  // 子代理 RPC 通道（aiti-subagents-fork-upstream-core-plan §5.4）：
  // 本进程 env 注入 PI_WEB_BRIDGE_AUTO=1，经上游 spawn 的 env 透传链送达每个
  // fork 子代理；子代理内 ambient 加载的 web-bridge 扩展命中该标记 + 上游
  // PI_SUBAGENT_CHILD=1 双条件后自动起桥写 bridge-registry →
  // pi-web 打开该子代理 session 时 attach（双向 IO，不独占）。
  process.env.PI_WEB_BRIDGE_AUTO = "1";
  console.log("[aiti] PI_WEB_BRIDGE_AUTO=1 injected — fork children will auto-bridge");

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
