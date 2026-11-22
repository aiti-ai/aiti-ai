/**
 * aiti-mcp-shim 载荷与并发专项测试（node --test；mock 桥）。
 * 钉死：大载荷（~600KB）逐字 intact 转发、中文/emoji/换行 Unicode 往返、
 * 双 shim 实例并发互不串扰、缺 jsonrpc 字段的应答被 isValidRpc 丢弃（不写 stdout）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-mcp-shim.cjs");

async function startMock(handler) {
  const state = { requests: 0 };
  state.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      state.requests++;
      const msg = JSON.parse(body);
      if (msg.id === 0) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 0, result: {} })); return; }
      handler(res, msg);
    });
  });
  state.server.listen(0, "127.0.0.1");
  await once(state.server, "listening");
  state.url = "http://127.0.0.1:" + state.server.address().port;
  state.close = () => { state.server.closeAllConnections(); return new Promise((r) => state.server.close(r)); };
  return state;
}

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
        if (waiters[i].id === m.id) {
          clearTimeout(waiters[i].timer);
          const w = waiters.splice(i, 1)[0];
          w.res(m);
        }
      }
    }
  });
  return {
    send: (o) => child.stdin.write(JSON.stringify(o) + "\n"),
    until: (id, ms = 15000) => new Promise((res, rej) => {
      const hit = lines.find((m) => m.id === id);
      if (hit) return res(hit);
      const timer = setTimeout(() => rej(new Error("timeout waiting " + id)), ms);
      waiters.push({ id, res, timer });
    }),
    lines,
    kill: () => { try { child.kill(); } catch {} },
  };
}

const INIT = { jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "payload", version: "0" } } };
const ready = async (sh) => { sh.send(INIT); await sh.until("i"); sh.send({ jsonrpc: "2.0", method: "notifications/initialized" }); };

test("载荷：~600KB 大响应逐字 intact 转发", async () => {
  const bigText = "x".repeat(600 * 1024);
  const mock = await startMock((res, msg) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { big: bigText, n: bigText.length } }));
  });
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "big", method: "tools/call", params: { name: "t", arguments: {} } });
    const r = await sh.until("big");
    assert.equal(r.result.big.length, 600 * 1024, "长度一致");
    assert.ok(r.result.big === bigText, "内容逐字一致");
  } finally { sh.kill(); await mock.close(); }
});

test("载荷：中文/emoji/换行/引号 Unicode 往返不损坏", async () => {
  const sample = "中文测试🎉\n第二行\"引号\"\\反斜杠\t制表符　全角空格🌐终结";
  const mock = await startMock((res, msg) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { text: sample } }));
  });
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "u", method: "tools/call", params: { name: "t", arguments: {} } });
    const r = await sh.until("u");
    assert.equal(r.result.text, sample, "Unicode 逐字一致");
    // 反向：请求参数含 Unicode 也完整到达桥
    sh.send({ jsonrpc: "2.0", id: "u2", method: "tools/call", params: { name: sample, arguments: {} } });
    await sh.until("u2");
  } finally { sh.kill(); await mock.close(); }
});

test("并发：双 shim 实例同时会话互不串扰", async () => {
  const mock = await startMock((res, msg) => {
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-shared" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { who: msg.id } }));
  });
  const a = startShim({ AITI_BRIDGE_URL: mock.url });
  const b = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    a.send(INIT); b.send(INIT);
    await a.until("i"); await b.until("i");
    a.send({ jsonrpc: "2.0", id: "req-A", method: "tools/call", params: { name: "t", arguments: {} } });
    b.send({ jsonrpc: "2.0", id: "req-B", method: "tools/call", params: { name: "t", arguments: {} } });
    const ra = await a.until("req-A");
    const rb = await b.until("req-B");
    assert.equal(ra.result.who, "req-A", "A 收到 A 的应答");
    assert.equal(rb.result.who, "req-B", "B 收到 B 的应答");
    assert.ok(!a.lines.some((m) => m.id === "req-B"), "A 的 stdout 无 B 的应答");
    assert.ok(!b.lines.some((m) => m.id === "req-A"), "B 的 stdout 无 A 的应答");
    assert.ok(mock.requests >= 6, "全部请求到达桥（探针+init×2+业务×2）");
  } finally { a.kill(); b.kill(); await mock.close(); }
});

test("过滤：应答缺 jsonrpc 字段 → isValidRpc 丢弃，stdout 无该消息", async () => {
  const mock = await startMock((res, msg) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (msg.id === "broken") res.end(JSON.stringify({ id: msg.id, result: { x: 1 } })); // 缺 jsonrpc
    else res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }));
  });
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "broken", method: "tools/call", params: { name: "t", arguments: {} } });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(sh.lines.filter((m) => m.id === "broken").length, 0, "破损应答不透传给 agent");
    sh.send({ jsonrpc: "2.0", id: "good", method: "tools/call", params: { name: "t", arguments: {} } });
    const g = await sh.until("good");
    assert.equal(g.result.ok, true, "后续正常应答不受影响");
  } finally { sh.kill(); await mock.close(); }
});
