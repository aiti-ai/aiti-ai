export async function register(): Promise<void> {
  // Next builds this file for both the Node and the Edge instrumentation entry.
  // The Edge graph rejects Node APIs, so `process.on` and undici live in
  // ./instrumentation-node, reached only through this compile-time-eliminated
  // NEXT_RUNTIME branch. An early `return` instead of this `if` would leave the
  // Node calls in the Edge module.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation-node.ts");
    registerNodeInstrumentation();

    // Stamp an env marker on everything this server (indirectly) spawns, so port
    // discovery can still identify our children after they are re-parented by
    // daemonization (nohup / setsid / double-fork). Children inherit env at spawn
    // time, so the marker survives even when the process tree link does not.
    // NOTE: process.pid usage must stay in a dynamically imported module
    // (lib/child-marker.ts) — turbopack's Edge static analysis of this file flags
    // it as a hard compile error, recompiling (and HMR-pushing) on every request.
    const { stampChildMarker } = await import("@/lib/child-marker");
    stampChildMarker();

    // File-access sandbox (system-level overall restriction, off by default): when PI_WEB_FILE_SANDBOX=1,
    // PI_WEB_ALLOWED_ROOTS (semicolon-separated) appends allowed roots (session cwd/projectRoot are always allowed).
    // With the sandbox off this registration has no effect (isFilePathAllowed lets everything through); it only applies when enabled.
    {
      const rootsEnv = process.env.PI_WEB_ALLOWED_ROOTS;
      if (rootsEnv) {
        const { allowFileRoot } = await import("@/lib/file-access");
        // win32 splits on ; only (: is the drive-letter colon — splitting there yields "C" + "\repo", a useless root);
        // POSIX keeps the legacy [;:] for compatibility.
        const sep = process.platform === "win32" ? ";" : /[;:]/;
        for (const r of rootsEnv.split(sep).filter(Boolean)) allowFileRoot(r);
      }
    }

    // Subagent factory: mounts globalThis.__piSubagentFactory globally (the subagents extension calls through it)
    const { installSubagentFactory } = await import("@/lib/subagent");
    installSubagentFactory();

    // In-process local session factory: globalThis.__piLocalSessionFactory (extensions create/open real
    // pi sessions through it — cc-connect bridging: the channels extension's ACP server → pi-web sessions)
    const { installLocalSessionFactory } = await import("@/lib/rpc-manager");
    installLocalSessionFactory();

    // pi-web-startable backends as subagent executors (external-job provider "pi-web-rpc"):
    // an agent md declaring runner={external-job, pi-web-rpc, options.backend} makes subagents run as
    // real pi-web sessions (pi RPC / claude-code ACP / qoder …), attachable from the frontend.
    const { installPiWebJobProvider } = await import("@/lib/piweb-job-provider");
    installPiWebJobProvider();

    // Page event stream: globalThis.__piPageEvents.publish(type, data) (the page-wide single event SSE carrier;
    // running / pf:remind / mc:avail / ed-watch … unified frames, so extensions no longer open their own SSE connections)
    const { publishPageEvent } = await import("@/lib/agent-page-events");
    void publishPageEvent; // import side effect: registers globalThis.__piPageEvents

    // Subagent RPC channel (subagents-fork-upstream-core-plan §5.4):
    // this process injects PI_WEB_BRIDGE_AUTO=1 into env, reaching every fork subagent through the
    // upstream spawn env passthrough chain; when the ambiently loaded web-bridge extension inside the
    // subagent sees this marker plus the upstream PI_SUBAGENT_CHILD=1 (both conditions), it auto-starts
    // the bridge and writes the bridge registry →
    // pi-web attaches when opening that subagent session (bidirectional IO, non-exclusive).
    process.env.PI_WEB_BRIDGE_AUTO = "1";
    // Host declaration (subagents-fork-upstream-core-plan §4.1/4.2): the fork extension runs inside this
    // process as a pi-web host — the upstream TUI carrier surfaces (widget/Fleet status bar/slash) are
    // off per host caps, with the subagents extension as their full replacement (the engine still provides subagent tools).
    process.env.PI_SUBAGENTS_HOST = "pi-web";
    console.log("[aiti] PI_WEB_BRIDGE_AUTO=1 injected — fork children will auto-bridge");

    // Extension framework: load + start extensions (registry on globalThis so
    // the middleware bundle can invoke hooks without importing extension code).
    // service-tunnels (discovery/proxy/tunnels/self-exposure) has been extracted into an extension: its server.startup
    // creates the library singleton + PI_WEB_EXPOSE self-exposure.
    const { ensureRegistry } = await import("@/lib/ext/registry");
    const { makeExtCore } = await import("@/lib/ext/core");
    const extRegistry = ensureRegistry(makeExtCore());
    await extRegistry.loadAll();
    // Unified SSE port starts first (plan §3-A hardening): the bus /events /subscribe routes and
    // __piPageEvents takeover are ready before the other extensions and later host initialization —
    // independent of the bulk extension startup order; if the bus extension is absent (not installed/
    // disabled) this silently skips and consumers fall back per their own contracts.
    await extRegistry.startupById("aiti-event-bus");
    await extRegistry.startAll();

    // Running-set broadcast: decoupled from the /api/agent/running/events connection lifecycle (once page
    // events converge onto the bus nobody connects to that route directly, breaking running-frame production
    // → every client falls back to 30s polling). Must run after the bus startup: the first-frame snapshot
    // enters the bus via the __piPageEvents accessor; before the takeover it would only reach core sinks
    // that nobody consumes. See lib/running-broadcast.ts.
    const { ensureRunningBroadcast } = await import("@/lib/running-broadcast");
    ensureRunningBroadcast();

    // Restart recovery P0: boot scan — the previous process's running set migrates into the interrupted set + bootId rolls.
    // GET /api/agent/recovery/interrupted consumes that set afterwards (file-level validation happens at GET time).
    const { bootRollRunningJournal } = await import("@/lib/running-journal");
    const rolled = bootRollRunningJournal();
    if (rolled > 0) console.log(`[pi-web] restart recovery: ${rolled} running session(s) interrupted by previous process`);
  }
}
