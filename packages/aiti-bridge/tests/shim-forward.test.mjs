/**
 * aiti-mcp-shim 转发链路专项测试（node --test；mock 桥，不依赖真实服务）。
 * 逐功能钉死：SSE 流式响应逐事件转发（含 progress 通知）、mcp-session-id 捕获+回带、
 * batch JSON 数组响应、探测超时（挂起服务器 1.5s 放弃转下一候选）、跳过挂起候选命中
 * 后续候选、断线自愈（转发失败重置协商→端点恢复后自愈）、HTML 垃圾响应 → -32000、
 * stdin 非 JSON 行忽略、--url=x 等号参数形式、通知转发 + 202 语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-mcp-shim.cjs");

/**
 * 可编程 mock 桥。modes：
 *   json    —— 正常 JSON 应答（tools/list 返回 bridge_tool；业务应答带 mcp-session-id）
 *   sse     —— text/event-stream：tools/list 先推 progress 通知（多 data 行）再推最终应答
 *   batch   —— JSON 数组批量应答（通知混在其中）
 *   hang    —— 仅 /aiti/mcp 挂起不响应，其余路径按 json 应答（测"跳过挂起候选命中后者"）
 *   hangall —— 所有路径挂起（测"全部候选超时→降级"）
 *   html    —— 探测请求（initialize id=0）回合法 JSON，其余请求回 text/html 垃圾
 * 记录每个请求的 headers/body 供断言。
 */
async function startMock(mode = "json") {
  const state = { mode, requests: [] };
  const jsonReply = (res, msg, withSid) => {
    res.writeHead(200, { "content-type": "application/json", ...(withSid && msg.id !== 0 ? { "mcp-session-id": "sess-JSON-9" } : {}) });
    if (msg.method === "tools/list") res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "bridge_tool" }] } }));
    else res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { echo: (msg.params || {}).name || "init" } }));
  };
  state.server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { res.destroy(); return; }
      state.requests.push({ headers: req.headers, msg });
      if (state.mode === "hangall") return; // 永不响应
      if (state.mode === "hang" && req.url.endsWith("/aiti/mcp")) return; // 仅首选候选挂起
      if (state.mode === "html") {
        if (msg.id === 0 && msg.method === "initialize") return jsonReply(res, msg, false); // 探测放行（协商可成功）
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<html>502 Bad Gateway</html>");
        return;
      }
      if (state.mode === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream", ...(msg.id !== 0 ? { "mcp-session-id": "sess-SSE-1" } : {}) });
        if (msg.method === "tools/list") {
          res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",");
          res.write("\n");
          res.write("data:   \"params\":{\"progress\":50}}\n\n"); // 多 data 行拼接 + 通知
          res.write(": keep-alive comment\n");
          res.write("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":\"" + msg.id + "\",\"result\":{\"tools\":[{\"name\":\"sse_tool\"}]}}\n\n");
          res.end();
          return;
        }
        res.end("event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n\n");
        return;
      }
      if (state.mode === "batch") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([
          { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }, // 通知混在 batch 里
          { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "batch_tool" }] } },
        ]));
        return;
      }
      jsonReply(res, msg, true);
    });
  });
  state.server.listen(0, "127.0.0.1");
  await once(state.server, "listening");
  state.port = state.server.address().port;
  state.url = "http://127.0.0.1:" + state.port;
  state.close = () => { state.server.closeAllConnections(); return new Promise((r) => state.server.close(r)); };
  state.reopen = async () => { state.server.listen(state.port, "127.0.0.1"); await once(state.server, "listening"); };
  state.stop = () => { state.server.closeAllConnections(); return new Promise((r) => state.server.close(r)); };
  return state;
}

/** 起 shim（env 指向 mock）；返回 send/until/kill */
function startShim(env = {}) {
  const child = spawn("node", [SHIM], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", err = "";
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
        const w = waiters[i];
        const matched = w.filter ? w.filter(m) : w.id !== undefined && m.id === w.id; // id 等待器不被无 id 消息误唤醒
        if (matched) { waiters.splice(i, 1); w.resolve(m); }
      }
    }
  });
  child.stderr.on("data", (d) => { err += d; });
  return {
    send: (o) => child.stdin.write((typeof o === "string" ? o : JSON.stringify(o)) + "\n"),
    raw: (s) => child.stdin.write(s),
    until: (idOrFilter, ms = 8000) => {
      const hit = typeof idOrFilter === "function" ? lines.find(idOrFilter) : lines.find((m) => m.id === idOrFilter);
      if (hit) return Promise.resolve(hit);
      return new Promise((res, rej) => {
        waiters.push(typeof idOrFilter === "function" ? { filter: idOrFilter, resolve: res } : { id: idOrFilter, resolve: res });
        setTimeout(() => rej(new Error("timeout waiting " + JSON.stringify(idOrFilter) + "\nstderr:\n" + err)), ms);
      });
    },
    kill: () => { try { child.kill(); } catch {} },
    get stderr() { return err; },
    lines,
  };
}

const INIT = { jsonrpc: "2.0", id: "i", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fwd", version: "0" } } };
const ready = async (sh, ms = 8000) => {
  sh.send(INIT);
  await sh.until("i", ms);
  sh.send({ jsonrpc: "2.0", method: "notifications/initialized" });
};

test("转发：SSE 流式响应逐事件透传——progress 通知先达，最终应答后达", async () => {
  const mock = await startMock("sse");
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "L", method: "tools/list", params: {} });
    const progress = await sh.until((m) => m.method === "notifications/progress");
    assert.equal(progress.params.progress, 50, "多 data 行拼接的通知完整");
    const reply = await sh.until("L");
    assert.deepEqual(reply.result.tools.map((t) => t.name).sort(), ["aiti_shim_status", "sse_tool"], "最终应答到达且合并 status 工具");
  } finally { sh.kill(); await mock.close(); }
});

test("转发：mcp-session-id 首响应捕获、后续请求回带", async () => {
  const mock = await startMock("json");
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "q1", method: "tools/call", params: { name: "probe_tool", arguments: {} } });
    await sh.until("q1");
    const initReq = mock.requests.find((r) => r.msg.id === "i");
    const q1 = mock.requests.find((r) => r.msg.id === "q1");
    assert.equal(initReq.headers["mcp-session-id"], undefined, "首请求无 sid");
    assert.equal(q1.headers["mcp-session-id"], "sess-JSON-9", "后续请求回带桥种下的 sid");
  } finally { sh.kill(); await mock.close(); }
});

test("转发：batch JSON 数组响应——通知过滤、应答取出", async () => {
  const mock = await startMock("batch");
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "b", method: "tools/list", params: {} });
    const note = await sh.until((m) => m.method === "notifications/message");
    assert.equal(note.params.level, "info");
    const reply = await sh.until("b");
    assert.equal(reply.result.tools[0].name, "batch_tool");
  } finally { sh.kill(); await mock.close(); }
});

test("协商：全部候选挂起 → 每个 1.5s 超时后放弃，降级自检（耗时受控）", async () => {
  const mock = await startMock("hangall");
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    const t0 = Date.now();
    await ready(sh, 20000); // 7 候选 × 1.5s ≈ 10.5s，给足 20s
    const dt = Date.now() - t0;
    assert.ok(dt >= 1500, "经历了探测超时（实际 " + dt + "ms）");
    assert.ok(dt < 18000, "总耗时受控（实际 " + dt + "ms）");
    sh.send({ jsonrpc: "2.0", id: "st", method: "tools/call", params: { name: "aiti_shim_status", arguments: {} } });
    const st = await sh.until("st");
    assert.ok(st.result.content[0].text.includes("桥未连接"), "降级自检说明");
  } finally { sh.kill(); await mock.close(); }
});

test("协商：首选候选挂起 → 1.5s 后跳过，命中后续候选（扩展端点）", async () => {
  const mock = await startMock("hang"); // /aiti/mcp 挂起；扩展端点路径正常 json
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    const t0 = Date.now();
    await ready(sh, 20000);
    const dt = Date.now() - t0;
    assert.ok(dt >= 1400 && dt < 8000, "跳过挂起者耗时 = 一次探测超时（实际 " + dt + "ms）");
    assert.ok(sh.stderr.includes("/api/extensions/aiti-devtools/mcp/mcp"), "命中了后续候选（扩展端点）");
    assert.ok(sh.stderr.includes("端点"), "协商完成");
  } finally { sh.kill(); await mock.close(); }
});

test("自愈：端点中途下线 → 明确报错；恢复在线 → 下次调用自动重连成功", async () => {
  const mock = await startMock("json");
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "ok1", method: "tools/call", params: { name: "t", arguments: {} } });
    assert.equal((await sh.until("ok1")).result.echo, "t");
    await mock.stop(); // 下线
    sh.send({ jsonrpc: "2.0", id: "down", method: "tools/call", params: { name: "t", arguments: {} } });
    const down = await sh.until("down");
    assert.equal(down.error.code, -32000, "下线期间明确报错");
    assert.ok(down.error.message.includes("重新探测"), "提示已重置协商");
    await mock.reopen(); // 恢复
    sh.send({ jsonrpc: "2.0", id: "ok2", method: "tools/call", params: { name: "t2", arguments: {} } });
    assert.equal((await sh.until("ok2")).result.echo, "t2", "恢复后自愈成功（重新协商命中）");
  } finally { sh.kill(); await mock.close(); }
});

test("容错：协商成功后端点开始返回 HTML → -32000 明确报错（非 JSON 响应）", async () => {
  const mock = await startMock("html"); // 探测放行、业务回 HTML
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", id: "h", method: "tools/call", params: { name: "t", arguments: {} } });
    const r = await sh.until("h");
    assert.equal(r.error.code, -32000);
    assert.ok(r.error.message.includes("非 JSON"), r.error.message);
    assert.ok(mock.requests.some((rq) => rq.msg.id === "h"), "转发确实到达端点");
  } finally { sh.kill(); await mock.close(); }
});

test("容错：stdin 混入非 JSON 行/JSON 标量 → 忽略不崩溃，后续正常处理", async () => {
  const mock = await startMock("json");
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    sh.raw("this is not json {{{\n"); // 非 JSON 行
    sh.raw('""\n');                    // 合法 JSON 标量（非请求对象）——转发路径，桥侧忽略
    sh.raw("\n");                      // 空行
    sh.send(INIT);
    const init = await sh.until("i");
    assert.equal(init.result.echo, "init", "非法输入被忽略，init 正常应答");
    await new Promise((r) => setTimeout(r, 400)); // 等 stderr 刷出
    assert.ok(sh.stderr.includes("忽略非 JSON 行"), "stderr 有诊断提示");
  } finally { sh.kill(); await mock.close(); }
});

test("参数：--url=<端点> 等号形式与 --url <端点> 等效", async () => {
  const mock = await startMock("json");
  const child = spawn("node", [SHIM, "--url=" + mock.url], { env: { ...process.env, AITI_BRIDGE_URL: "http://127.0.0.1:1" }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const first = new Promise((res, rej) => {
    child.stdout.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) { try { res(JSON.parse(buf.slice(0, i))); } catch (e) { rej(e); } }
    });
    setTimeout(() => rej(new Error("--url= 等号形式无应答")), 8000);
  });
  child.stdin.write(JSON.stringify(INIT) + "\n");
  try {
    const init = await first;
    assert.equal(init.result.echo, "init", "等号形式指定的端点生效（mock 应答 echo）");
  } finally {
    child.kill(); // 必须进 finally：断言失败也不能留孤儿 shim（其管道句柄会吊住测试进程）
    await mock.close();
  }
});

test("转发：通知转发至端点（202 空体不产生 stdout 应答）", async () => {
  const mock = await startMock("json");
  const sh = startShim({ AITI_BRIDGE_URL: mock.url });
  try {
    await ready(sh);
    sh.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "x" } });
    await new Promise((r) => setTimeout(r, 700));
    const cancelled = mock.requests.filter((r) => r.msg.method === "notifications/cancelled");
    assert.equal(cancelled.length, 1, "通知确实转发到端点");
    assert.equal(sh.lines.filter((m) => m.method === "notifications/cancelled").length, 0, "202 空体不写 stdout");
  } finally { sh.kill(); await mock.close(); }
});
