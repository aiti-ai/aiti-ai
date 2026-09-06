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

  // 进程内本地会话工厂：globalThis.__piLocalSessionFactory（扩展经此创建/打开真
  // 实 pi 会话——cc-connect 桥接：aiti-channels ACP server → pi-web 会话）
  const { installLocalSessionFactory } = await import("@/lib/rpc-manager");
  installLocalSessionFactory();

  // pi-web 启动类后端作为子代理执行器（external-job provider "pi-web-rpc"）：
  // agent md 声明 runner={external-job, pi-web-rpc, options.backend} 即可让子代理
  // 跑成真正的 pi-web 会话（pi RPC / claude-code ACP / qoder …），前端可打开 attach。
  const { installPiWebJobProvider } = await import("@/lib/piweb-job-provider");
  installPiWebJobProvider();

  // 页面事件流：globalThis.__piPageEvents.publish(type, data)（全页唯一事件 SSE 承载，
  // running / pf:remind / mc:avail / ed-watch … 统一帧，各扩展不再自建 SSE 连接）
  const { publishPageEvent } = await import("@/lib/agent-page-events");
  void publishPageEvent; // import 副作用：注册 globalThis.__piPageEvents

  // 子代理 RPC 通道（aiti-subagents-fork-upstream-core-plan §5.4）：
  // 本进程 env 注入 PI_WEB_BRIDGE_AUTO=1，经上游 spawn 的 env 透传链送达每个
  // fork 子代理；子代理内 ambient 加载的 web-bridge 扩展命中该标记 + 上游
  // PI_SUBAGENT_CHILD=1 双条件后自动起桥写 bridge-registry →
  // pi-web 打开该子代理 session 时 attach（双向 IO，不独占）。
  process.env.PI_WEB_BRIDGE_AUTO = "1";
  // 宿主声明（aiti-subagents-fork-upstream-core-plan §4.1/4.2）：fork 扩展在本进程
  // 内以 pi-web 宿主身份运行——上游 TUI 载体面（widget/Fleet 状态栏/slash）按
  // host caps 关闭，aiti-subagents 扩展是其完整平替（引擎照常提供 subagent 工具）。
  process.env.PI_SUBAGENTS_HOST = "pi-web";
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

  // 重启恢复 P0：boot 扫描 —— 上一进程的运行集迁入 interrupted 集 + 滚动 bootId。
  // 之后 GET /api/agent/recovery/interrupted 消费该集（文件级校验在 GET 时做）。
  const { bootRollRunningJournal } = await import("@/lib/running-journal");
  const rolled = bootRollRunningJournal();
  if (rolled > 0) console.log(`[pi-web] restart recovery: ${rolled} running session(s) interrupted by previous process`);
}
