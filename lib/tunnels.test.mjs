import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  delete globalThis.__piTunnels;
  delete process.env.PI_WEB_TUNNELS;
  delete process.env.PI_WEB_TUNNEL_CMD;
  delete process.env.PI_WEB_TUNNEL_NAME;
  const mod = await import("./tunnels.ts");
  // Kill any leftover tunnel process groups from previous tests so their stdio
  // pipes never keep the test runner alive (the slow-test culprit).
  for (const info of mod.getTunnelInfos()) {
    if (info.pid) {
      try { process.kill(-info.pid, "SIGKILL"); } catch { /* gone */ }
      try { process.kill(info.pid, "SIGKILL"); } catch { /* gone */ }
    }
  }
  return mod;
}

const SLEEPER = (label) =>
  `node -e "console.log('${label}'); setTimeout(()=>{}, 60000);"`;

test("reports an empty list when nothing is configured", async () => {
  const { getTunnelInfos, getTunnelConfigs } = await loadSubject();
  assert.deepEqual(getTunnelConfigs(), []);
  assert.deepEqual(getTunnelInfos(), []);
});

test("parses tunnel URLs from known tunnel domains and generic output", async () => {
  const { extractTunnelUrl } = await loadSubject();
  assert.equal(extractTunnelUrl("Forwarding https://abc.ngrok.io -> http://localhost:30141"), "https://abc.ngrok.io");
  assert.equal(
    extractTunnelUrl("Your quick Tunnel has been created! Visit it at https://xyz.trycloudflare.com"),
    "https://xyz.trycloudflare.com",
  );
  assert.equal(extractTunnelUrl("tunnel url: https://abc.loca.lt/"), "https://abc.loca.lt/");
  assert.equal(extractTunnelUrl("connecting to http://localhost:30141 ..."), null); // localhost excluded
  assert.equal(extractTunnelUrl("no url here"), null);
  // Known tunnel domains win even when an unrelated official-site link comes first
  // (cloudflared prints https://www.cloudflare.com/website-terms/ before the
  // real trycloudflare URL).
  const mixed = "Terms: https://www.cloudflare.com/website-terms/ ... tunnel: https://real.trycloudflare.com";
  assert.equal(extractTunnelUrl(mixed), "https://real.trycloudflare.com");
});

test("configures multiple tunnels from PI_WEB_TUNNELS + legacy CMD", async () => {
  const { getTunnelConfigs } = await loadSubject();
  process.env.PI_WEB_TUNNELS = JSON.stringify([
    { name: "ngrok", cmd: "ngrok http 30141", auto: true },
    { name: "cfd", cmd: "cloudflared tunnel --url http://localhost:30141" },
  ]);
  process.env.PI_WEB_TUNNEL_CMD = "lt --port 30141";
  process.env.PI_WEB_TUNNEL_NAME = "legacy";
  const cfgs = getTunnelConfigs();
  assert.deepEqual(cfgs.map((c) => c.name), ["ngrok", "cfd", "legacy"]);
  assert.equal(cfgs[0].auto, true);
  assert.equal(cfgs[1].auto, false);
  assert.equal(cfgs[2].auto, true);
});

test("port tunnel templates and one-off start/stop", { timeout: 20_000 }, async () => {
  const { getPortTunnelTemplates, startPortTunnel, stopTunnel, getTunnelInfos } = await loadSubject();
  const templates = getPortTunnelTemplates(8901);
  const names = templates.map((t) => t.name);
  assert.deepEqual(names, ["cloudflared", "localtunnel", "ngrok", "serveo"]);
  assert.ok(templates.every((t) => t.cmd.includes("8901")), "commands must carry the port");
  assert.equal(templates.find((t) => t.name === "ngrok")?.requiresAuth, true);

  assert.equal(startPortTunnel(8901, "bogus"), false); // unknown tool
  assert.equal(startPortTunnel(8901, "localtunnel"), true);
  const info = getTunnelInfos().find((t) => t.name === "port-8901-localtunnel");
  assert.ok(info, "one-off tunnel listed");
  assert.equal(info.running, true);

  assert.equal(stopTunnel("port-8901-localtunnel"), true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(getTunnelInfos().find((t) => t.name === "port-8901-localtunnel")?.running, false);
});

test("per-tool tunnels coexist on the same port; same tool is idempotent", { timeout: 20_000 }, async () => {
  const { startPortTunnel, stopTunnel, getTunnelInfos } = await loadSubject();
  assert.equal(startPortTunnel(8904, "localtunnel"), true);
  assert.equal(startPortTunnel(8904, "localtunnel"), true); // same tool idempotent
  await new Promise((r) => setTimeout(r, 200));
  const lts = getTunnelInfos().filter((t) => t.name === "port-8904-localtunnel");
  assert.equal(lts.length, 1, "one localtunnel per port");
  assert.equal(lts[0].running, true);

  // A DIFFERENT tool on the same port coexists (not replaced).
  assert.equal(startPortTunnel(8904, "serveo"), true);
  await new Promise((r) => setTimeout(r, 300));
  const infos = getTunnelInfos().filter((t) => t.name.startsWith("port-8904-"));
  assert.ok(infos.some((t) => t.name === "port-8904-localtunnel" && t.running), "localtunnel still running");
  assert.ok(infos.some((t) => t.name === "port-8904-serveo"), "serveo listed too");

  for (const t of infos) stopTunnel(t.name);
});

test("start/stop a tunnel; start is idempotent; URL parsed and kept across polls", { timeout: 20_000 }, async () => {
  const { getTunnelConfigs, startTunnel, stopTunnel, getTunnelInfos } = await loadSubject();
  process.env.PI_WEB_TUNNELS = JSON.stringify([
    { name: "demo", cmd: SLEEPER("url: https://demo.ngrok.io") },
  ]);
  assert.equal(getTunnelConfigs()[0].name, "demo");

  assert.equal(startTunnel("demo"), true);
  assert.equal(startTunnel("demo"), true); // idempotent
  const first = getTunnelInfos()[0];
  assert.equal(first.running, true);
  assert.ok(first.pid && first.pid > 0);

  // URL appears once output arrives; stays cached across poll refreshes.
  await new Promise((r) => setTimeout(r, 600));
  const second = getTunnelInfos()[0];
  assert.equal(second.url, "https://demo.ngrok.io");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(getTunnelInfos()[0].url, "https://demo.ngrok.io"); // refresh keeps it

  assert.equal(stopTunnel("demo"), true);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(getTunnelInfos()[0].running, false);

  assert.equal(startTunnel("missing"), false);
  assert.equal(stopTunnel("missing"), false);
});
