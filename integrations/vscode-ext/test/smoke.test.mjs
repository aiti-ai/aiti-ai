/**
 * aiti-devtools-vscode 冒烟测试（node:test，纯 node 模块，不依赖 vscode）
 * 覆盖：代理注入 / 双注入跳过 / 非 HTML 透传 / 目标不可达 502 / 桥路径探测 /
 *       桥复用或拉起（真实 spawn）+ 停止 / mcp.json 合并写入与防 clobber
 * 运行：node --test test/smoke.test.mjs（先自动 esbuild 出 dist-test/）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

// 构建（模块顶层，先于下方静态 import 的动态解析）
await esbuild.build({
  entryPoints: [
    "src/proxy-server.ts",
    "src/bridge-manager.ts",
    "src/paths.ts",
    "src/mcp-config.ts",
  ],
  outdir: "dist-test",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  logLevel: "silent",
});

const { startProxy, launcherScriptTag } = await import("../dist-test/proxy-server.js");
const { BridgeManager } = await import("../dist-test/bridge-manager.js");
const { resolveBridgePath, resolveShimPath } = await import("../dist-test/paths.js");
const { upsertMcpConfig } = await import("../dist-test/mcp-config.js");

// ---------- mock dev server ----------
let mock;
let mockPort;
before(async () => {
  mock = http.createServer((req, res) => {
    if (req.url === "/app.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("console.log('app')");
      return;
    }
    if (req.url === "/already") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!DOCTYPE html><html><body><script src="http://other/aiti-launcher.js" defer></script></body></html>');
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!DOCTYPE html><html><head><title>t</title></head><body><h1>hello</h1></body></html>");
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  mockPort = mock.address().port;
});
after(() => mock?.close());

function get(url, extraHeaders = {}) {
  // 原生 http.get：undici fetch 禁设 sec-fetch-mode（forbidden header），模拟不了浏览器导航
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers: extraHeaders }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      })
      .on("error", reject);
  });
}

const NAV = { "sec-fetch-mode": "navigate" }; // 浏览器地址栏导航语义
const CORS = { "sec-fetch-mode": "cors" }; // fetch/XHR/RSC 流语义

const LOG = () => {};

test("代理注入：HTML 首块 prepend launcher 标签（绝对 URL 指桥）", async () => {
  const proxy = await startProxy(`http://127.0.0.1:${mockPort}`, 0, launcherScriptTag("http://127.0.0.1:8777/aiti"), LOG);
  try {
    const r = await get(proxy.url, NAV);
    assert.equal(r.status, 200);
    assert.ok(r.body.startsWith("<script"), `launcher 标签应在文档最前，实际 head=${JSON.stringify(r.body.slice(0, 60))}`);
    assert.ok(r.body.includes('data-bridge-url="http://127.0.0.1:8777/aiti"'));
    assert.ok(r.body.includes("<!DOCTYPE html>"), "原 HTML 保持完整");
    assert.equal(r.headers["content-length"], undefined, "注入后应转 chunked（无 content-length）");
    assert.ok(r.body.includes("aiti-launcher.js"));
    // 非 navigate（fetch/XHR/RSC 流，sec-fetch-mode: cors）不注入——与 core htmlInjectMiddleware 同语义（无头请求如 curl 默认注入）
    const r2 = await get(proxy.url, CORS);
    assert.ok(!r2.body.startsWith("<script"), "非 navigate 请求不注入");
  } finally {
    await proxy.close();
  }
});

test("双注入防护：页面已自带 launcher → 不重复注入", async () => {
  const proxy = await startProxy(`http://127.0.0.1:${mockPort}`, 0, launcherScriptTag("http://127.0.0.1:8777/aiti"), LOG);
  try {
    const r = await get(proxy.url + "already", NAV);
    assert.equal(r.status, 200);
    assert.equal(r.body.split("aiti-launcher.js").length - 1, 1, "仅出现一次");
    assert.ok(!r.body.startsWith("<script"), "未 prepend 我们的标签");
  } finally {
    await proxy.close();
  }
});

test("非 HTML 透传：JS 资源原样", async () => {
  const proxy = await startProxy(`http://127.0.0.1:${mockPort}`, 0, launcherScriptTag("http://127.0.0.1:8777/aiti"), LOG);
  try {
    const r = await get(proxy.url + "app.js");
    assert.equal(r.body, "console.log('app')");
    assert.ok(!r.body.includes("aiti-launcher"));
  } finally {
    await proxy.close();
  }
});

test("目标不可达 → 502 + 提示 JSON", async () => {
  const proxy = await startProxy("http://127.0.0.1:59999", 0, launcherScriptTag("http://127.0.0.1:8777/aiti"), LOG);
  try {
    const r = await get(proxy.url);
    assert.equal(r.status, 502);
    const j = JSON.parse(r.body);
    assert.ok(j.error.includes("unreachable"));
    assert.ok(j.hint);
  } finally {
    await proxy.close();
  }
});

test("launcherScriptTag: aiUrl setting takes precedence, empty falls back to bridge cockpit", () => {
  const t1 = launcherScriptTag("http://127.0.0.1:8777/aiti", "aiti-devtools", "http://127.0.0.1:8080/");
  assert.ok(t1.includes('data-ai-url="http://127.0.0.1:8080"'), t1); // trailing slash normalized
  assert.ok(t1.includes('data-bridge-url="http://127.0.0.1:8777/aiti"'));
  const t2 = launcherScriptTag("http://127.0.0.1:8777/aiti");
  assert.ok(t2.includes('data-ai-url="http://127.0.0.1:8777/aiti/cockpit.html"'), t2);
  const t3 = launcherScriptTag("http://127.0.0.1:8777/aiti", "aiti-devtools", "   ");
  assert.ok(t3.includes('data-ai-url="http://127.0.0.1:8777/aiti/cockpit.html"'));
});

test("路径探测：本机能找到安装态桥与 shim", () => {
  const b = resolveBridgePath();
  const s = resolveShimPath();
  assert.ok(b && fs.existsSync(b), `bridge: ${b}`);
  assert.ok(s && fs.existsSync(s), `shim: ${s}`);
  assert.ok(b.endsWith("aiti-bridge.mjs"));
  assert.ok(s.endsWith("aiti-mcp-shim.cjs"));
});

test("桥管理：复用或拉起 + 停止（真实 spawn/stop 闭环，不杀外部桥）", async () => {
  const bridgePath = resolveBridgePath();
  assert.ok(bridgePath);
  const mgr = new BridgeManager(18799);
  try {
    const how = await mgr.ensureRunning(bridgePath); // 8777 若有常驻桥不受影响（独立端口）
    assert.ok(how === "started" || how === "already");
    assert.ok(await mgr.healthy());
    if (how === "started") {
      assert.ok(mgr.spawnedHere);
      mgr.stop();
      // Windows taskkill tree-kill is async: poll briefly until the port is actually down (max ~2s)
      let down = false;
      for (let i = 0; i < 10 && !down; i++) {
        await new Promise((r) => setTimeout(r, 200));
        down = !(await mgr.healthy());
      }
      assert.ok(down, "停止后应不可达");
      assert.equal(mgr.spawnedHere, false);
    } else {
      assert.equal(mgr.spawnedHere, false, "外部桥复用不标记 spawnedHere");
    }
  } finally {
    mgr.stop(); // 幂等
  }
});

test("mcp.json：创建 / 合并保留既有 server / 非法 JSON 不覆盖", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiti-mcp-"));
  try {
    // ① 创建
    let r = upsertMcpConfig(dir, "/x/aiti-mcp-shim.cjs", "http://127.0.0.1:8777/aiti");
    assert.equal(r.action, "created");
    let cfg = JSON.parse(fs.readFileSync(r.file, "utf8"));
    assert.equal(cfg.servers.aiti.type, "stdio");
    assert.equal(cfg.servers.aiti.env.AITI_BRIDGE_URL, "http://127.0.0.1:8777/aiti");
    assert.ok(cfg.servers.aiti.args[0].endsWith("aiti-mcp-shim.cjs"));
    // ② 合并：既有 server 保留，aiti 条目新入 → created；再跑一次 → updated
    const existing = { servers: { foo: { command: "bar" } }, inputs: [] };
    fs.writeFileSync(path.join(dir, ".vscode", "mcp.json"), JSON.stringify(existing));
    r = upsertMcpConfig(dir, "/x/shim.cjs", "http://127.0.0.1:9/aiti");
    assert.equal(r.action, "created", "aiti 条目首次写入该文件");
    cfg = JSON.parse(fs.readFileSync(r.file, "utf8"));
    assert.deepEqual(cfg.servers.foo, { command: "bar" });
    assert.deepEqual(cfg.inputs, []);
    assert.equal(cfg.servers.aiti.env.AITI_BRIDGE_URL, "http://127.0.0.1:9/aiti");
    r = upsertMcpConfig(dir, "/x/shim.cjs", "http://127.0.0.1:9/aiti");
    assert.equal(r.action, "updated", "幂等重写");
    // ③ 非法 JSON（含注释）→ 报错不覆盖
    const raw = '{\n// comment\n"servers": {}\n}';
    fs.writeFileSync(path.join(dir, ".vscode", "mcp.json"), raw);
    r = upsertMcpConfig(dir, "/x/shim.cjs", "http://127.0.0.1:9/aiti");
    assert.equal(r.action, "error");
    assert.equal(fs.readFileSync(path.join(dir, ".vscode", "mcp.json"), "utf8"), raw, "内容不被破坏");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
