import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mcpToolLabel, prettyMcpResultText, toolDisplayName } = await jiti.import("./mcp-tool-display.ts");

test("MCP tools read as server/tool, from the result's details when it has them", () => {
  assert.deepEqual(mcpToolLabel("mcp__github__create_issue"), { server: "github", tool: "create_issue" });
  // The registered name is sanitized; the details keep what the server called it.
  assert.deepEqual(
    mcpToolLabel("mcp__docs_v2__search_pages", { server: "docs.v2", tool: "search.pages" }),
    { server: "docs.v2", tool: "search.pages" },
  );
  assert.deepEqual(mcpToolLabel("mcp__docs__search", { server: 1 }), { server: "docs", tool: "search" });
  assert.equal(mcpToolLabel("read", { server: "docs", tool: "search" }), null);
  assert.equal(mcpToolLabel("mcp__onlyserver"), null);
  assert.equal(toolDisplayName("mcp__github__create_issue"), "github/create_issue");
  assert.equal(toolDisplayName("bash"), "bash");
});

test("a result that is one JSON document is indented, anything else is kept", () => {
  assert.equal(prettyMcpResultText("{\"items\":[1,2]}"), "{\n  \"items\": [\n    1,\n    2\n  ]\n}");
  assert.equal(prettyMcpResultText("  [1]\n"), "[\n  1\n]");
  for (const text of ["plain text", "{\"a\": 1} and more", "{not json", "42", ""]) {
    assert.equal(prettyMcpResultText(text), text);
  }
});
