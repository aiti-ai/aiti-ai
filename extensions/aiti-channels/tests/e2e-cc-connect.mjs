#!/usr/bin/env node
/**
 * cc-connect end-to-end — the IM→agent loop exercised against the real binary.
 *
 * Chain under test (all through OUR code paths):
 *   config-gen renders TOML → cc-connect spawns (managed bin, -config) →
 *   management /api/v1/status + /api/v1/reload → bridge WS register →
 *   type=acp project spawns OUR connector → named pipe/UDS → aiti-channels ACP
 *   server → real pi session → reply flows back through the bridge.
 *
 * Prerequisites (missing pieces skip cleanly, never hard-fail):
 *   - managed cc-connect bin (or CC_CONNECT_BIN override)
 *   - a live aiti-channels ACP endpoint (dev/prod instance) for the ACP leg
 *
 * Usage: node tests/e2e-cc-connect.mjs [--no-acp]
 * Exit 0 = green (skips excluded); 1 = failure.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const NO_ACP = process.argv.includes("--no-acp");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.error(`  ❌ ${name}${extra ? "  " + extra : ""}`); }
};
const skipIt = (name, why) => { skip++; console.log(`  ⏭ ${name}  (${why})`); };

// managed bin (installer layout) or explicit override
const bin = process.env.CC_CONNECT_BIN ||
  join(homedir(), ".pi", "web", "data", "aiti-channels", "cache", "bin", platform() === "win32" ? "cc-connect.exe" : "cc-connect");
if (!existsSync(bin)) {
  console.log("==== cc-connect e2e：skip（managed bin 不存在——先经面板/安装 API 安装）====");
  process.exit(0);
}

// config-gen is the product's own renderer — exercise it, not a hand-written TOML
const { renderConfig } = await import("../lib/config-gen.ts");

const dir = mkdtempSync(join(tmpdir(), "cc-e2e-"));
const cfgPath = join(dir, "cc-connect.toml");
const MGMT_PORT = 20000 + Math.floor(Math.random() * 20000);
const BRIDGE_PORT = MGMT_PORT + 1;
const TOKEN = "cc-e2e-" + Date.now();
const auth = { authorization: `Bearer ${TOKEN}` };

// connector + ACP endpoint (deployed layout); ACP leg skipped when unreachable
const extBin = join(homedir(), ".pi", "web", "extensions", "aiti-channels", "bin", "aiti-acp-connector.mjs");
let acpPipe = "";
if (!NO_ACP && existsSync(extBin)) {
  try {
    const r = await fetch("http://127.0.0.1:3001/wdev/api/extensions/aiti-channels/acp-status?instance=default", { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    if ((j.listening || j.endpointAlive) && j.socket) acpPipe = j.socket;
  } catch { /* dev instance down → ACP leg skips */ }
}

const workDir = mkdtempSync(join(tmpdir(), "cc-e2e-work-"));
writeFileSync(join(workDir, "readme.txt"), "cc-connect e2e workspace\n");
const toml = renderConfig({
  dataDir: join(dir, "ccdata"),
  language: "zh",
  management: { enabled: true, port: MGMT_PORT, token: TOKEN },
  bridge: { enabled: true, port: BRIDGE_PORT, token: TOKEN },
  ...(acpPipe ? { acp: { connector: extBin, socketPath: acpPipe } } : {}),
  projects: [{
    name: "acpchat",
    agent: acpPipe ? "piweb" : "claudecode",
    piwebNative: false,
    work_dir: workDir,
    platforms: [{ type: "telegram", fields: { token: "123456789:AAExx-dummy-token-not-real" } }],
  }],
});
writeFileSync(cfgPath, toml);

const child = spawn(bin, ["-config", cfgPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let binLog = "";
child.stdout.on("data", (d) => { binLog += d; });
child.stderr.on("data", (d) => { binLog += d; });

try {
  // ① binary accepts our config-gen output and opens the management port
  let status = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${MGMT_PORT}/api/v1/status`, { headers: auth, signal: AbortSignal.timeout(2000) });
      if (r.ok) { status = await r.json(); break; }
    } catch { /* starting */ }
  }
  ok("config-gen TOML accepted + management up", !!status, status ? `version=${status.data?.version ?? status.version}` : binLog.slice(-200));
  if (!status) throw new Error("management never came up");

  // ② live reload endpoint
  const rl = await fetch(`http://127.0.0.1:${MGMT_PORT}/api/v1/reload`, { method: "POST", headers: auth, signal: AbortSignal.timeout(8000) });
  ok("/api/v1/reload", rl.ok, `HTTP ${rl.status}`);

  // ③ bridge accepts adapter registration
  const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/bridge/ws?token=${TOKEN}`);
  const events = [];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("register timeout")), 10000);
    ws.onmessage = (e) => {
      try { events.push(JSON.parse(e.data)); } catch { /* junk */ }
      if (events.some((m) => m.type === "register_ack")) { clearTimeout(t); resolve(); }
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "register", platform: "web", capabilities: ["text"], metadata: { version: "e2e" } }));
    ws.onerror = () => { clearTimeout(t); reject(new Error("ws error")); };
  });
  ok("bridge register_ack", events.some((m) => m.type === "register_ack" && m.ok !== false));

  // ④ ACP leg: message → cc-connect spawns our connector → real pi session → reply
  if (!acpPipe) {
    skipIt("ACP loop (IM→agent→pi→reply)", "no live ACP endpoint (start dev/prod instance)");
  } else {
    const wsSend = (obj) => ws.send(JSON.stringify(obj));
    const replyText = await new Promise((resolve) => {
      let buf = "";
      const t = setTimeout(() => resolve(""), 90000);
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "ping" || m.type === "ping_request") { wsSend({ type: "pong", ts: Date.now() }); return; }
        if (m.type === "reply_stream") { buf += m.delta || ""; if (m.done) { clearTimeout(t); resolve(buf); } }
        else if (m.type === "reply") { clearTimeout(t); resolve(m.content || ""); }
        else if (m.type === "error") { clearTimeout(t); resolve(""); console.error("    bridge error:", m.code, m.message); }
      };
      wsSend({ type: "message", msg_id: `web-${Date.now()}`, session_key: `web:e2e:${Date.now() % 1000}`, user_id: "web-e2e", user_name: "E2E", content: "只回四个字：链路通", reply_ctx: "web:e2e:1", project: "acpchat" });
    });
    ok("ACP loop: real pi session replied via bridge", replyText.trim().length > 0, JSON.stringify(replyText.trim().slice(0, 40)));
  }
  ws.close();
} catch (e) {
  fail++;
  console.error(`  ❌ chain aborted: ${e.message}`);
} finally {
  // Tree-kill: child.kill() on Windows only terminates cc-connect itself — the
  // type=acp connector grandchild survives holding an ACP-pipe client handle,
  // which wedges the pipe name against any future bind (2026-11-14 incident).
  try {
    if (platform() === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 8000 });
    else child.kill();
  } catch { /* already gone */ }
  await sleep(700);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* locked on win — temp anyway */ }
}

console.log(`\n==== cc-connect e2e：${pass} pass / ${fail} fail / ${skip} skip ====`);
process.exit(fail ? 1 : 0);
