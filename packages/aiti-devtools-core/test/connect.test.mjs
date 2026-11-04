/**
 * connect.test.mjs —— Connect 中间件适配（vite/webpack/express 载体用）
 * 用法：node test/connect.test.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connectBridge, createBridge } from "../src/index.ts";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("✗ " + msg); } };

const bridge = createBridge("");
const middleware = connectBridge(bridge, {
  prefix: "/aiti",
  staticFiles: {
    "/aiti-launcher.js": { type: "application/javascript; charset=utf-8", content: "window.__LAUNCHER_TEST__ = 1;" },
    "/cockpit.html": { type: "text/html; charset=utf-8", content: "<h1>cockpit</h1>" },
  },
});

const server = createServer((req, res) => {
  let called = false;
  middleware(req, res, () => { called = true; });
  if (called && !res.headersSent) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ notFound: true }));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const get = async (path, opts) => {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
};

// ---- 静态资产 ----
{
  const r = await get("/aiti/aiti-launcher.js");
  ok(r.status === 200 && r.text.includes("__LAUNCHER_TEST__"), "静态资产 launcher");
  ok((r.headers.get("content-type") || "").includes("javascript"), "content-type");
  const c = await get("/aiti/cockpit.html");
  ok(c.status === 200 && c.text.includes("cockpit"), "静态资产 cockpit");
}

// ---- 前缀外放行（宿主应用）----
{
  const r = await get("/other/path");
  ok(r.status === 404 && r.text.includes("notFound"), "前缀外 → next() 交给宿主");
  ok(r.status === 404 && !r.text.includes("cockpit"), "前缀外不接管");
}

// ---- 桥 claim ----
{
  const r = await get("/aiti/bridge/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageKey: "test" }) });
  const j = JSON.parse(r.text);
  ok(r.status === 200 && j.ok && typeof j.instanceId === "string", "POST /aiti/bridge/claim → instanceId");
}

// ---- MCP initialize ----
{
  const r = await get("/aiti/mcp/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "connect-test", version: "0" } } }),
  });
  const j = JSON.parse(r.text);
  ok(r.status === 200 && j.jsonrpc === "2.0" && j.result && j.result.serverInfo, "MCP initialize → serverInfo");
  ok(j.result.serverInfo.name.includes("aiti"), "serverInfo.name");
  ok((r.headers.get("mcp-session-id") || "").length > 0, "返回 Mcp-Session-Id");
}

// ---- 旧路径 /mcp（无 /aiti 前缀 → next 放行；前缀模式只接管 /aiti）----
{
  const r = await get("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(r.status === 404 && r.text.includes("notFound"), "前缀外 /mcp 不接管（宿主决定）");
}

// ---- OPTIONS 预检 ----
{
  const r = await get("/aiti/bridge/claim", { method: "OPTIONS" });
  ok(r.status === 204, "OPTIONS → 204");
}

// ---- SSE 流（/aiti/bridge/sse）----
{
  const claim = JSON.parse((await get("/aiti/bridge/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) })).text);
  const ctrl = new AbortController();
  const sseRes = await fetch(`${base}/aiti/bridge/sse?instanceId=${claim.instanceId}&secret=${claim.secret}&role=page`, { signal: ctrl.signal });
  ok(sseRes.status === 200 && (sseRes.headers.get("content-type") || "").includes("text/event-stream"), "SSE 200 + event-stream");
  const reader = sseRes.body.getReader();
  const { value } = await reader.read();
  ok(value && value.length > 0, "SSE 流有数据");
  ctrl.abort();
}

// ---- 404 未知桥路径 ----
{
  const r = await get("/aiti/bridge/nope");
  ok(r.status === 404, "未知桥路径 → 桥 404");
}

console.log(`\nconnect: ${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
