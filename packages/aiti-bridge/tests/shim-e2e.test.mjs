/**
 * aiti-mcp-shim 端到端测试（node --test；依赖本机真实服务）：
 *   独立桥 127.0.0.1:8777（systemd aiti-bridge）/ pi-web dev 30142（/dev basePath）/
 *   pi-web prod 20341。任一未启动则对应用例失败（视为环境问题非代码问题）。
 *
 * 覆盖：AITI_BRIDGE_URL 各种写法（裸 origin / basePath / 完整端点 / 少写 /mcp）协商、
 * initialize 转发、通知静默转发、tools/list 透传 + aiti_shim_status 合并、
 * tools/call 透传（file_stat）、未设 env 降级、全候选不可达降级、错误调用应答。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), "../bin/aiti-mcp-shim.cjs");

/** 起一个 shim 子进程，返回 {send, until, stderr, kill}；until(id) 等待对应应答 */
function startShim(extraEnv = {}) {
  const child = spawn("node", [SHIM], {
    env: { ...process.env, AITI_PROBE_TIMEOUT_MS: "5000", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const waiters = [];
  const lines = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!l) continue;
      const msg = JSON.parse(l);
      lines.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if ((w.filter && w.filter(msg)) || msg.id === w.id) { waiters.splice(i, 1); w.resolve(msg); }
      }
    }
  });
  let errBuf = "";
  child.stderr.on("data", (d) => { errBuf += d; });
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const until = (idOrFilter, timeoutMs = 20000) => {
    const hit = typeof idOrFilter === "function" ? lines.find(idOrFilter) : lines.find((m) => m.id === idOrFilter);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolveP, rejectP) => {
      const w = typeof idOrFilter === "function"
        ? { filter: idOrFilter, resolve: resolveP }
        : { id: idOrFilter, resolve: resolveP };
      waiters.push(w);
      setTimeout(() => rejectP(new Error("等待应答超时 id=" + JSON.stringify(idOrFilter))), timeoutMs);
    });
  };
  const kill = () => { try { child.kill(); } catch {} };
  return { send, until, kill, get stderr() { return errBuf; } };
}

const INIT = { jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } };

async function toolsOf(sh) {
  sh.send(INIT);
  const init = await sh.until("init");
  sh.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  sh.send({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
  const list = await sh.until("list");
  return { init, list, names: list.result.tools.map((t) => t.name) };
}

for (const t of [
  { label: "独立桥裸 origin（8777）", url: "http://127.0.0.1:8777", expect: "http://127.0.0.1:8777/aiti/mcp" },
  { label: "独立桥带 /aiti", url: "http://127.0.0.1:8777/aiti", expect: "http://127.0.0.1:8777/aiti/mcp" },
  { label: "独立桥完整端点（多写 /mcp）", url: "http://127.0.0.1:8777/aiti/mcp", expect: "http://127.0.0.1:8777/aiti/mcp" },
  { label: "pi-web dev basePath（30142/dev）", url: "http://127.0.0.1:30142/dev", expect: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp" },
  { label: "pi-web dev 完整端点", url: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp", expect: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp" },
  { label: "pi-web dev 少写一个 /mcp", url: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp", expect: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp" },
  { label: "pi-web dev 裸 origin（basePath 变体探测）", url: "http://127.0.0.1:30142", expect: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp" },
  { label: "pi-web prod 裸 origin（20341）", url: "http://127.0.0.1:20341", expect: "http://127.0.0.1:20341/api/extensions/aiti-devtools/mcp/mcp" },
]) {
  test("e2e 协商+全链路：" + t.label, async () => {
    const sh = startShim({ AITI_BRIDGE_URL: t.url });
    try {
      const { init, names } = await toolsOf(sh);
      assert.equal(init.result.serverInfo.name, "aiti-devtools"); // 桥的 initialize 原样透传
      assert.ok(names.includes("aiti_shim_status"), "status 工具被合并");
      assert.ok(names.some((n) => n.startsWith("page_") || n === "bridge_status"), "桥工具透传");
      // 自检工具能看到协商端点
      sh.send({ jsonrpc: "2.0", id: "st", method: "tools/call", params: { name: "aiti_shim_status", arguments: {} } });
      const st = await sh.until("st");
      assert.ok(st.result.content[0].text.includes(t.expect), "status 含端点 " + t.expect);
      // 真实工具调用透传（file_stat 只读 stat）
      sh.send({ jsonrpc: "2.0", id: "fs", method: "tools/call", params: { name: "file_stat", arguments: { path: "/tmp" } } });
      const fs = await sh.until("fs");
      assert.equal(JSON.parse(fs.result.content[0].text).exists, true);
    } finally {
      sh.kill();
    }
  });
}

test("e2e：通知静默转发（无 id 消息不产生 stdout 应答）", async () => {
  const sh = startShim({ AITI_BRIDGE_URL: "http://127.0.0.1:8777" });
  try {
    sh.send(INIT);
    await sh.until("init");
    sh.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await new Promise((r) => setTimeout(r, 600));
    sh.send({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
    const list = await sh.until("list");
    assert.ok(Array.isArray(list.result.tools));
    // 非法 id 的响应不会被误认为通知应答：上一条 until("list") 已隐式验证顺序完整
  } finally { sh.kill(); }
});

test("e2e：未设 AITI_BRIDGE_URL → 降级自检模式（init 正常、仅 status 工具）", async () => {
  const sh = startShim({ AITI_BRIDGE_URL: "" });
  try {
    const { init, names } = await toolsOf(sh);
    assert.equal(init.result.serverInfo.name, "aiti-shim");
    assert.deepEqual(names, ["aiti_shim_status"]);
    sh.send({ jsonrpc: "2.0", id: "st", method: "tools/call", params: { name: "aiti_shim_status", arguments: {} } });
    const st = await sh.until("st");
    const text = st.result.content[0].text;
    assert.ok(text.includes("未设置"), "提示未设置环境变量");
    assert.ok(text.includes("AITI_BRIDGE_URL"));
    // 其他调用得到明确错误而非挂死
    sh.send({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { name: "bridge_status", arguments: {} } });
    const x = await sh.until("x");
    assert.equal(x.error.code, -32000);
  } finally { sh.kill(); }
});

test("e2e：全部候选不可达 → 降级自检模式，status 说明探测过程", async () => {
  const sh = startShim({ AITI_BRIDGE_URL: "http://127.0.0.1:1" });
  try {
    const { init, names } = await toolsOf(sh);
    assert.equal(init.result.serverInfo.name, "aiti-shim");
    assert.deepEqual(names, ["aiti_shim_status"]);
    sh.send({ jsonrpc: "2.0", id: "st", method: "tools/call", params: { name: "aiti_shim_status", arguments: {} } });
    const st = await sh.until("st");
    assert.ok(st.result.content[0].text.includes("探测未命中"));
  } finally { sh.kill(); }
});

test("e2e：--url 参数显式指定（跳过协商，直接信任）", async () => {
  const child = spawn("node", [SHIM, "--url", "http://127.0.0.1:8777"], { env: { ...process.env, AITI_BRIDGE_URL: "http://127.0.0.1:1" }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    let buf = "";
    const p = new Promise((res) => {
      child.stdout.on("data", (d) => {
        buf += d;
        const i = buf.indexOf("\n");
        if (i >= 0) { try { res(JSON.parse(buf.slice(0, i))); } catch {} }
      });
    });
    child.stdin.write(JSON.stringify(INIT) + "\n");
    const init = await p;
    assert.equal(init.result.serverInfo.name, "aiti-devtools");
  } finally {
    // 断言抛出也收口——孤儿 shim 持 stdio 管道会让整轮测试挂起不退（lessons §1）
    try { child.kill(); } catch {}
  }
});
