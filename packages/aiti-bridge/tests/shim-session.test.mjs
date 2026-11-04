/**
 * 会话生命周期与显式 URL 专项测试（node --test；严格 mock 服务端）。
 * 钉死：桥重启后旧 mcp-session-id 失效 → shim 丢弃旧会话、重做 initialize 握手取新会话、
 * 原消息重试成功（D10）；--url 指向 pi-web basePath 时经探测选中正确扩展端点（D11）；
 * 重握手应答（__aiti_reshake）不透传给 agent。
 * 真实桥实证：aiti 桥对未知/缺失 sid 宽容（200），本套件针对符合 MCP 规范的严格服务端。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-mcp-shim.cjs");

/** 严格 mock：会话白名单制——initialize（无 sid）发新 sid；无效/缺失 sid 的其他请求 404/400 */
async function startStrictMock() {
  const state = { valid: new Set(), seq: 0, requests: [] };
  state.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      const sid = req.headers["mcp-session-id"];
      state.requests.push({ sid, msg });
      if (!sid && msg.method === "initialize") {
        const nsid = "sess-" + (++state.seq);
        state.valid.add(nsid);
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": nsid });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "strict-mock", version: "1" } } }));
        return;
      }
      if (!sid || !state.valid.has(sid)) {
        res.writeHead(!sid ? 400 : 404, { "content-type": "text/plain" });
        res.end("session expired");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (msg.method === "tools/list") res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "strict_tool" }] } }));
      else res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: (msg.params || {}).name || "ok" } }));
    });
  });
  state.server.listen(0, "127.0.0.1");
  await once(state.server, "listening");
  state.url = "http://127.0.0.1:" + state.server.address().port;
  state.restart = () => state.valid.clear(); // 模拟桥重启：全部会话失效
  state.close = () => { state.server.closeAllConnections(); return new Promise((r) => state.server.close(r)); };
  return state;
}

function startShim(env = {}, args = []) {
  const child = spawn("node", [SHIM, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
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
        if (waiters[i].id === m.id) { clearTimeout(waiters[i].timer); waiters.splice(i, 1)[0].res(m); }
      }
    }
  });
  return {
    send: (o) => child.stdin.write(JSON.stringify(o) + "\n"),
    until: (id, ms = 20000) => new Promise((res, rej) => {
      const hit = lines.find((m) => m.id === id);
      if (hit) return res(hit);
      const timer = setTimeout(() => rej(new Error("timeout waiting " + id)), ms);
      waiters.push({ id, res, timer });
    }),
    lines,
    kill: () => { try { child.kill(); } catch {} },
  };
}

const INIT = { jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lc", version: "0" } } };
const ready = async (sh) => { sh.send(INIT); await sh.until("i"); sh.send({ jsonrpc: "2.0", method: "notifications/initialized" }); };

test("会话生命周期：桥重启（旧 sid 全失效）→ 丢弃旧会话+重握手+原消息重试成功", async () => {
  const mock = await startStrictMock();
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "w1", method: "tools/call", params: { name: "t", arguments: {} } });
    assert.equal((await sh.until("w1")).result.echo, "t", "正常会话工作");
    mock.restart(); // 模拟桥重启：旧 sid 全部失效
    sh.send({ jsonrpc: "2.0", id: "w2", method: "tools/call", params: { name: "t2", arguments: {} } });
    const r = await sh.until("w2");
    assert.equal(r.result.echo, "t2", "重启后经重握手自动恢复");
    // 重握手确实发生：重启后出现无 sid 的 initialize
    const afterRestart = mock.requests.slice(mock.requests.findIndex((q) => q.msg.id === "w2"));
    assert.ok(afterRestart.some((q) => q.msg.method === "initialize" && !q.sid), "重做 initialize 握手");
    // 重握手应答不透传（agent 看不到 __aiti_reshake）
    assert.equal(sh.lines.filter((m) => m.id === "__aiti_reshake").length, 0, "reshake 应答不写 stdout");
    // 重试使用新会话
    const w2req = afterRestart.find((q) => q.msg.id === "w2");
    assert.ok(w2req.sid && w2req.sid !== "sess-1", "重试携带新 sid");
    sh.send({ jsonrpc: "2.0", id: "w3", method: "tools/call", params: { name: "t3", arguments: {} } });
    assert.equal((await sh.until("w3")).result.echo, "t3", "新会话持续工作");
  } finally { sh.kill(); await mock.close(); }
});

test("显式 URL：--url 指向 pi-web basePath → 经探测选中正确扩展端点（而非信任错误首候选）", async () => {
  // mock 仅在 /dev/api/extensions/aiti-devtools/mcp/mcp 上服务，其余路径 404
  const state = { server: null };
  state.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      if (req.url !== "/dev/api/extensions/aiti-devtools/mcp/mcp") {
        res.writeHead(404, { "content-type": "text/html" });
        res.end("<html>not found</html>");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { serverInfo: { name: "aiti-devtools" }, tools: [] } }));
    });
  });
  state.server.listen(0, "127.0.0.1");
  await once(state.server, "listening");
  const url = "http://127.0.0.1:" + state.server.address().port + "/dev";
  const sh = startShim({ AITI_BRIDGE_URL: "http://127.0.0.1:1" }, ["--url", url]); // env 指向死端点，--url 显式给 basePath
  try {
    sh.send(INIT);
    const r = await sh.until("i");
    assert.equal(r.result.serverInfo.name, "aiti-devtools", "探测跳过 404 首候选，命中扩展端点");
  } finally {
    sh.kill();
    state.server.closeAllConnections();
    await new Promise((r2) => state.server.close(r2));
  }
});
