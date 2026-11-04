/**
 * 健壮性补强专项（node --test）。
 * 钉死：① 高频请求下的 stdio 分帧完整性（100 请求 id/参数配对无串扰）；
 *       ② 双进程并发注册竞态（最终文件合法、条目唯一）；
 *       ③ 探测对"合法 JSON 但非 JSON-RPC"响应不误判；
 *       ④ bridge CLI --register-shim 与 --name/--mcp-config 组合。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-mcp-shim.cjs");
const REGISTER = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-mcp-register.mjs");
const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-bridge.mjs");

function startShim(env = {}) {
  const child = spawn("node", [SHIM], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const lines = [], waiters = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!l) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      lines.push(m);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].filter(m)) { clearTimeout(waiters[i].timer); waiters.splice(i, 1)[0].res(m); }
      }
    }
  });
  return {
    send: (o) => child.stdin.write(JSON.stringify(o) + "\n"),
    until: (filter, ms = 20000) => new Promise((res, rej) => {
      const hit = lines.find(filter);
      if (hit) return res(hit);
      const timer = setTimeout(() => rej(new Error("timeout")), ms);
      waiters.push({ filter, res, timer });
    }),
    lines,
    kill: () => { try { child.kill(); } catch {} },
  };
}

const INIT = { jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rb", version: "0" } } };

test("浸泡：100 个连续请求 id/参数配对无串扰（分帧完整性）", async () => {
  const mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      if (msg.id === 0) return res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} }));
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: msg.params && msg.params.arguments && msg.params.arguments.idx } }));
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const url = "http://127.0.0.1:" + mock.address().port;
  const sh = startShim({ AITI_BRIDGE_URL: url });
  try {
    sh.send(INIT);
    await sh.until((m) => m.id === "i");
    sh.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const N = 100;
    for (let k = 0; k < N; k++) {
      sh.send({ jsonrpc: "2.0", id: "r" + k, method: "tools/call", params: { name: "t", arguments: { idx: k } } });
    }
    // 等到全部应答到齐
    for (let t0 = Date.now(); Date.now() - t0 < 20000 && sh.lines.filter((m) => /^r\d+$/.test(String(m.id))).length < N; ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const replies = sh.lines.filter((m) => /^r\d+$/.test(String(m.id)));
    assert.equal(replies.length, N, `恰好 ${N} 条应答（实际 ${replies.length}）`);
    for (const r of replies) {
      const k = parseInt(String(r.id).slice(1), 10);
      assert.equal(r.result.echo, k, `id=r${k} 的应答内容与请求配对（echo=${r.result.echo}）`);
    }
    assert.equal(new Set(replies.map((r) => r.id)).size, N, "无重复应答");
  } finally { sh.kill(); mock.closeAllConnections(); await new Promise((r) => mock.close(r)); }
});

test("并发注册：双进程同时写同一配置 → 最终文件合法、条目唯一", async () => {
  const home = mkdtempSync(join(tmpdir(), "aiti-race-"));
  const cfg = join(home, ".pi/agent/mcp.json"); // pi 目标 = getAgentDir()/mcp.json
  mkdirSync(join(cfg, ".."), { recursive: true });
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }, null, 2));
  const run = (ver) => spawn("node", [REGISTER, "--targets", "pi", "--version", String(ver)], { env: { ...process.env, HOME: home }, stdio: "ignore" });
  const p2 = run(2), p3 = run(3);
  await Promise.all([once(p2, "exit"), once(p3, "exit")]);
  const obj = JSON.parse(readFileSync(cfg, "utf8")); // 合法 JSON（原子写未被竞态破坏）
  const e = obj.mcpServers.aiti;
  assert.ok(e, "条目存在");
  assert.ok(e.env?.AITI_SHIM_VERSION === "2" || e.env?.AITI_SHIM_VERSION === "3", "版本为两者之一（无半写状态）：v" + e.env?.AITI_SHIM_VERSION);
});

test("探测：合法 JSON 但非 JSON-RPC 响应不误判为桥", async () => {
  const mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "这不是 MCP 端点" })); // 无 jsonrpc/result/error
    });
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const url = "http://127.0.0.1:" + mock.address().port;
  const sh = startShim({ AITI_BRIDGE_URL: url });
  try {
    sh.send(INIT);
    const init = await sh.until((m) => m.id === "i");
    assert.equal(init.result.serverInfo.name, "aiti-shim", "降级自检模式（未误连非 MCP 服务）");
    sh.send({ jsonrpc: "2.0", id: "st", method: "tools/call", params: { name: "aiti_shim_status", arguments: {} } });
    const st = await sh.until((m) => m.id === "st");
    assert.ok(st.result.content[0].text.includes("桥未连接"), "status 说明未连接");
  } finally { sh.kill(); mock.closeAllConnections(); await new Promise((r) => mock.close(r)); }
});

test("bridge CLI：--register-shim 与 --name/--mcp-config 组合", () => {
  const home = mkdtempSync(join(tmpdir(), "aiti-combo-"));
  const cfg = join(home, "custom.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: {} }, null, 2));
  let out = "";
  try {
    out = execFileSync("node", [BRIDGE, "--port", "18901", "--register-shim", "--name", "aiti-custom", "--mcp-config", cfg], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || ""); // 桥常驻，timeout 杀掉属预期
  }
  assert.ok(out.includes("shim aiti-custom"), out.slice(-300));
  const e = JSON.parse(readFileSync(cfg, "utf8")).mcpServers["aiti-custom"];
  assert.equal(e.type, "stdio");
  assert.equal(e.args[0], SHIM);
});
