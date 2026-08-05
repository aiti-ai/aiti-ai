export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Stamp an env marker on everything this server (indirectly) spawns, so port
  // discovery can still identify our children after they are re-parented by
  // daemonization (nohup / setsid / double-fork). Children inherit env at spawn
  // time, so the marker survives even when the process tree link does not.
  process.env.PI_WEB_CHILD_MARKER ??= `pi-web-${process.pid}-${Date.now().toString(36)}`;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Optional auth-proxy listener (PI_WEB_PROXY_PORT): pi-web's own process
  // also answers virtual hosts like `30142-portal.localhost:<port>`. Off by
  // default — only starts when the env var is set.
  const { startProxyIfEnabled } = await import("@/lib/service-tunnels-integration");
  startProxyIfEnabled();
}
