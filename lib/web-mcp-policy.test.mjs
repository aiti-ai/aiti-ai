/**
 * web-mcp-policy —— Web 会话默认剔除 pi-mcp-adapter 测试。
 *
 * 语义：组装 SDK 扩展加载结果时，pi-mcp-adapter（npm source 或本地 npm 目录
 * 路径两种形态）整个移除（不初始化）；其他包不受影响；PI_WEB_LOAD_MCP=1
 * 恢复旧行为（原样返回）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dropMcpAdapterForWebSessions } from "./web-mcp-policy.ts";

function fakeExt(path, source, tools = ["bash"]) {
  return {
    path,
    resolvedPath: path,
    sourceInfo: { path, source, scope: "user", origin: "package", baseDir: "/x" },
    handlers: new Map(),
    tools: new Map(tools.map((name) => [name, { name }])),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
  };
}

function fakeResult(extensions) {
  return { extensions, errors: [] };
}

test("npm source 形态的 pi-mcp-adapter 被剔除", () => {
  const base = fakeResult([
    fakeExt("/a/pi-mcp-adapter/index.ts", "npm:pi-mcp-adapter@2.26.0"),
    fakeExt("/b/models-respect/index.ts", "npm:@aiti-ai/pi-models-respect@0.4.0"),
  ]);
  const out = dropMcpAdapterForWebSessions(base);
  assert.equal(out.extensions.length, 1);
  assert.equal(out.extensions[0].sourceInfo.source, "npm:@aiti-ai/pi-models-respect@0.4.0");
  assert.deepEqual(out.errors, []);
});

test("本地 npm 目录路径形态也命中（路径 scoped 包名匹配）", () => {
  const adapter = fakeExt("/home/pi/.pi/agent/npm/node_modules/pi-mcp-adapter/index.ts", "");
  const other = fakeExt("/home/pi/.pi/agent/npm/node_modules/@aiti-ai/pi-subagents/dist/index.ts", "");
  const out = dropMcpAdapterForWebSessions(fakeResult([adapter, other]));
  assert.equal(out.extensions.length, 1);
  assert.match(out.extensions[0].path, /pi-subagents/);
});

test("没有 adapter 时原样返回（不重建结果对象）", () => {
  const base = fakeResult([fakeExt("/x/index.ts", "npm:@aiti-ai/pi-subagents@0.59.0-aiti.1")]);
  const out = dropMcpAdapterForWebSessions(base);
  assert.equal(out, base);
});

test("PI_WEB_LOAD_MCP=1 恢复旧行为", () => {
  process.env.PI_WEB_LOAD_MCP = "1";
  try {
    const base = fakeResult([fakeExt("/a/index.ts", "npm:pi-mcp-adapter@2.26.0")]);
    const out = dropMcpAdapterForWebSessions(base);
    assert.equal(out, base);
  } finally {
    delete process.env.PI_WEB_LOAD_MCP;
  }
});

test("对应 error 条目一并移除", () => {
  const base = {
    extensions: [],
    errors: [{ path: "/a/pi-mcp-adapter/index.ts", error: "boom" }],
  };
  base.extensions = [fakeExt("/a/pi-mcp-adapter/index.ts", "npm:pi-mcp-adapter")];
  const out = dropMcpAdapterForWebSessions(base);
  assert.equal(out.extensions.length, 0);
  assert.deepEqual(out.errors, []);
});
