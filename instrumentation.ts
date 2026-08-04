export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Stamp an env marker on everything this server (indirectly) spawns, so port
  // discovery can still identify our children after they are re-parented by
  // daemonization (nohup / setsid / double-fork). Children inherit env at spawn
  // time, so the marker survives even when the process tree link does not.
  process.env.PI_WEB_CHILD_MARKER ??= `pi-web-${process.pid}-${Date.now().toString(36)}`;

  // Launch-command tunnels (ngrok / cloudflared / localtunnel / ssh -R) — see
  // lib/tunnels.ts. `auto: true` ones spawn at boot and die with the server;
  // the rest are started/stopped from the Services dialog.
  const { startAutoTunnels } = await import("@/lib/tunnels");
  startAutoTunnels();

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();
}
