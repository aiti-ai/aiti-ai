/**
 * aiti-mcp-shim 端点协商纯函数单测（node --test）。
 * 覆盖：后缀剥离（/aiti /mcp /mcp/mcp /bridge）、pi-web 扩展路径识别（多写/少写 /mcp）、
 * 裸 origin 的 basePath 变体候选、非 URL 容错、SSE 解析（单事件/多 data 行/杂行）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeInput, buildCandidates, parseSseMessages, parseFirstJson, stripKnownSuffix } = require("../bin/aiti-mcp-shim.cjs");

test("stripKnownSuffix：整段精确剥离，不吃 aiti-devtools", () => {
  assert.equal(stripKnownSuffix("/aiti"), "");
  assert.equal(stripKnownSuffix("/aiti/mcp"), "");
  assert.equal(stripKnownSuffix("/aiti/mcp/mcp"), "");
  assert.equal(stripKnownSuffix("/bridge"), "");
  assert.equal(stripKnownSuffix("/dev/api/extensions/aiti-devtools"), "/dev/api/extensions/aiti-devtools"); // 不误剥
  assert.equal(stripKnownSuffix("/dev/aiti/mcp"), "/dev");
  assert.equal(stripKnownSuffix("/foo"), "/foo"); // 未知路径保留
});

test("裸 origin：候选以独立桥 /aiti/mcp 开头 + 全部 basePath 变体", () => {
  const n = normalizeInput("http://127.0.0.1:8777");
  assert.equal(n.base, "http://127.0.0.1:8777");
  assert.equal(n.extBase, null);
  const c = buildCandidates(n);
  assert.equal(c[0], "http://127.0.0.1:8777/aiti/mcp");
  assert.ok(c.includes("http://127.0.0.1:8777/api/extensions/aiti-devtools/mcp/mcp"));
  assert.ok(c.includes("http://127.0.0.1:8777/dev/api/extensions/aiti-devtools/mcp/mcp"));
  assert.ok(c.includes("http://127.0.0.1:8777/mac/api/extensions/aiti-devtools/mcp/mcp"));
});

test("带 /aiti 或 /aiti/mcp 或 /bridge：剥回 origin 再生成候选", () => {
  for (const raw of ["http://h:1/aiti", "http://h:1/aiti/mcp", "http://h:1/aiti/mcp/mcp", "http://h:1/bridge"]) {
    const n = normalizeInput(raw);
    assert.equal(n.base, "http://h:1", raw);
    assert.equal(buildCandidates(n)[0], "http://h:1/aiti/mcp", raw);
  }
});

test("pi-web basePath（如 /dev）：base 保留 basePath，候选含扩展端点", () => {
  const n = normalizeInput("http://127.0.0.1:3001/dev");
  assert.equal(n.base, "http://127.0.0.1:3001/dev");
  const c = buildCandidates(n);
  assert.equal(c[0], "http://127.0.0.1:3001/dev/aiti/mcp");
  assert.ok(c.includes("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp/mcp"));
  // 非 裸 origin 不追加 basePath 变体
  assert.ok(!c.includes("http://127.0.0.1:3001/win/api/extensions/aiti-devtools/mcp/mcp"));
});

test("完整扩展端点（多写）：extBase 截到 aiti-devtools，候选第一即精确端点", () => {
  const n = normalizeInput("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp/mcp");
  assert.equal(n.extBase, "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools");
  const c = buildCandidates(n);
  assert.equal(c[0], "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp/mcp");
});

test("扩展端点少写一个 /mcp：仍归一到 /mcp/mcp 精确端点", () => {
  const n = normalizeInput("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp");
  const c = buildCandidates(n);
  assert.equal(c[0], "http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp/mcp");
  assert.ok(c.includes("http://127.0.0.1:3001/dev/api/extensions/aiti-devtools/mcp")); // 兜底候选也在
});

test("非 URL 输入：不抛异常，按原样作 base", () => {
  const n = normalizeInput("not a url");
  assert.equal(n.base, "not a url");
  assert.equal(n.extBase, null);
  assert.ok(Array.isArray(buildCandidates(n)));
});

test("尾随斜杠容错", () => {
  const n = normalizeInput("http://h:8777/aiti/");
  assert.equal(n.base, "http://h:8777");
});

test("parseSseMessages：单事件 / 多 data 行拼接 / 忽略杂行 / 尾事件无空行", () => {
  const single = 'event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n';
  assert.deepEqual(parseSseMessages(single), [{ jsonrpc: "2.0", id: 1 }]);
  const multi = 'data: {"a":\ndata: 1}\n\ndata: {"b":2}\n\n';
  assert.deepEqual(parseSseMessages(multi), [{ a: 1 }, { b: 2 }]);
  const noise = ": comment\ndata: not-json\n\n";
  assert.deepEqual(parseSseMessages(noise), []);
  const noTrailingBlank = 'data: {"x":9}';
  assert.deepEqual(parseSseMessages(noTrailingBlank), [{ x: 9 }]);
});

test("parseFirstJson：json 直读 / sse 取首个 / 空体与非 JSON 返回 null", () => {
  assert.deepEqual(parseFirstJson("application/json", '{"jsonrpc":"2.0","id":1}'), { jsonrpc: "2.0", id: 1 });
  assert.deepEqual(parseFirstJson("text/event-stream", 'data: {"id":2}\n\n'), { id: 2 });
  assert.equal(parseFirstJson("application/json", ""), null);
  assert.equal(parseFirstJson("text/html", "<html>404</html>"), null);
});
