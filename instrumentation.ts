export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Stamp an env marker on everything this server (indirectly) spawns, so port
  // discovery can still identify our children after they are re-parented by
  // daemonization (nohup / setsid / double-fork). Children inherit env at spawn
  // time, so the marker survives even when the process tree link does not.
  process.env.PI_WEB_CHILD_MARKER ??= `pi-web-${process.pid}-${Date.now().toString(36)}`;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();

  // Initialize the service-tunnels instance on globalThis — the middleware
  // (proxy.ts) resolves service virtual hosts through it in-process. No
  // separate proxy listener anymore (decisions are embedded in the middleware).
  const { getServiceTunnels, maybeExposeSelf } = await import("@/lib/service-tunnels-integration");
  getServiceTunnels();
  // Optional self-exposure from PI_WEB_EXPOSE (best-effort, non-blocking).
  void maybeExposeSelf();
}
