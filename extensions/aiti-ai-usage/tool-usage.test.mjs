/**
 * aiti-ai-usage — tool/skill usage stats tests (borrow plan §2.7A/B).
 *
 * Covers:
 *   1) parseSessionJsonl extracts ToolUsageRow / SkillUsageRow from assistant toolCall blocks /
 *      toolResult messages / user <skill> blocks (incl. anon call_id fallback and multi-skill messages);
 *   2) insertToolRows merge semantics: call row (ok=NULL) ← result row fills ok/duration/tool by key;
 *   3) idempotency: repeated parse+insert of the same file never inflates counts;
 *   4) catalog pure functions: estimateTokens (chars/4) + toolEstTokens + buildCatalog merge.
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-ai-usage/tool-usage.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openUsageDb } from "./lib/db.ts";
import { parseSessionJsonl, insertToolRows, insertSkillRows } from "./lib/ingest.ts";
import { buildCatalog, estimateTokens, readMcpCatalog, toolEstTokens } from "./lib/catalog.ts";

const NOW = Date.now();

/** Fixture session JSONL: one tool call (call+result), one failing call, one skill message, one plain assistant */
function fixtureJsonl() {
  const lines = [
    JSON.stringify({ type: "session", id: "sess-tu", cwd: "/tmp/proj", timestamp: new Date(NOW).toISOString() }),
    // assistant: two toolCall blocks + usage
    JSON.stringify({
      id: "m1", timestamp: new Date(NOW).toISOString(), type: "message",
      message: {
        role: "assistant", provider: "openai", model: "gpt-4o", timestamp: NOW,
        content: [
          { type: "text", text: "let me check" },
          { type: "toolCall", toolCallId: "call_1", toolName: "read", input: { path: "/tmp/a" } },
          { type: "toolCall", toolCallId: "call_2", toolName: "bash", input: { cmd: "ls" } },
        ],
        usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.01 } },
      },
    }),
    // toolResult: call_1 ok (with toolName + duration), call_2 failed
    JSON.stringify({
      id: "m2", timestamp: new Date(NOW + 1000).toISOString(), type: "message",
      message: { role: "toolResult", toolCallId: "call_1", toolName: "read", isError: false, durationMs: 120, timestamp: NOW + 1000, content: [{ type: "text", text: "ok" }] },
    }),
    JSON.stringify({
      id: "m3", timestamp: new Date(NOW + 2000).toISOString(), type: "message",
      message: { role: "toolResult", toolCallId: "call_2", toolName: "bash", isError: true, durationMs: 30, timestamp: NOW + 2000, content: [{ type: "text", text: "boom" }] },
    }),
    // user: skill block prepended (pi skill invocation shape)
    JSON.stringify({
      id: "m4", timestamp: new Date(NOW + 3000).toISOString(), type: "message",
      message: {
        role: "user", timestamp: NOW + 3000,
        content: [{ type: "text", text: '<skill name="usage-report" location="/x/SKILL.md">\nReferences are relative to the skill dir.\n\n帮我出报表' }],
      },
    }),
    // assistant without usage (its toolCall block must still record a call row)
    JSON.stringify({
      id: "m5", timestamp: new Date(NOW + 4000).toISOString(), type: "message",
      message: { role: "assistant", timestamp: NOW + 4000, content: [{ type: "toolCall", toolCallId: "call_3", toolName: "edit", input: {} }] },
    }),
  ];
  return lines.join("\n") + "\n";
}

function openTmpDb(root) {
  const usage = openUsageDb(join(root, "usage.sqlite"));
  usage.ensure();
  return usage;
}

test("parseSessionJsonl：toolCall/toolResult/<skill> 提取正确", async () => {
  const parsed = await parseSessionJsonl(fixtureJsonl(), "fallback");
  assert.equal(parsed.id, "sess-tu");
  // 3 tool call rows (2 calls + 1 call-only) + 2 result rows = 5 raw rows
  assert.equal(parsed.toolRows.length, 5);
  const calls = Object.fromEntries(parsed.toolRows.map((r) => [r.call_id, r]));
  assert.equal(calls.call_1.tool, "read");
  assert.equal(calls.call_2.tool, "bash");
  assert.equal(calls.call_3.tool, "edit");
  assert.equal(calls.call_1.ok, 1);
  assert.equal(calls.call_1.duration_ms, 120);
  assert.equal(calls.call_2.ok, 0);
  assert.equal(calls.call_2.duration_ms, 30);
  assert.equal(calls.call_3.ok, null); // no result yet → placeholder row
  // skill: 1 row (multiple skill blocks in one message would yield multiple rows)
  assert.equal(parsed.skillRows.length, 1);
  assert.equal(parsed.skillRows[0].skill, "usage-report");
  assert.equal(parsed.skillRows[0].session_id, "sess-tu");
});

test("insert 合并语义：call 行(ok=NULL) ← result 行同键补 ok/duration；重复重放幂等", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-usage-tu-"));
  const usage = openTmpDb(root);
  const parsed = await parseSessionJsonl(fixtureJsonl(), "fallback");
  insertToolRows(usage, parsed.toolRows);
  insertSkillRows(usage, parsed.skillRows);
  // after merge: 3 rows (call_1/call_2/call_3) with ok/duration filled in
  const rows = usage.db.prepare("SELECT * FROM tool_usage ORDER BY call_id").all();
  assert.equal(rows.length, 3);
  const byId = Object.fromEntries(rows.map((r) => [r.call_id, r]));
  assert.equal(byId.call_1.ok, 1);
  assert.equal(byId.call_1.duration_ms, 120);
  assert.equal(byId.call_1.tool, "read");
  assert.equal(byId.call_3.ok, null);
  assert.equal(usage.db.prepare("SELECT COUNT(*) n FROM skill_usage").get().n, 1);
  // replay (re-parse + re-insert of the same file) → counts not inflated, values stable
  const again = await parseSessionJsonl(fixtureJsonl(), "fallback");
  insertToolRows(usage, again.toolRows);
  insertSkillRows(usage, again.skillRows);
  assert.equal(usage.db.prepare("SELECT COUNT(*) n FROM tool_usage").get().n, 3);
  assert.equal(usage.db.prepare("SELECT COUNT(*) n FROM skill_usage").get().n, 1);
  const rows2 = usage.db.prepare("SELECT * FROM tool_usage WHERE call_id='call_1'").get();
  assert.equal(rows2.ok, 1);
  assert.equal(rows2.duration_ms, 120);
});

test("result 行缺 toolName 时保留 call 行的 tool（COALESCE 语义）", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-usage-tu-"));
  const usage = openTmpDb(root);
  insertToolRows(usage, [
    { session_id: "s", call_id: "c1", ts: NOW, day: "2026-11-20", tool: "read", ok: null, duration_ms: null },
    { session_id: "s", call_id: "c1", ts: NOW + 1, day: "2026-11-20", tool: "", ok: 1, duration_ms: 5 },
  ]);
  const row = usage.db.prepare("SELECT * FROM tool_usage WHERE call_id='c1'").get();
  assert.equal(row.tool, "read");
  assert.equal(row.ok, 1);
  assert.equal(row.duration_ms, 5);
});

test("30 天计数口径：buildCatalog 归因（tool 级精确名 + MCP server 级 mcp__ 前缀）", () => {
  const servers = [
    {
      name: "big-server", enabled: true, toolCount: 2, estTokens: 0, cachedAt: null,
      tools: [
        { name: "search_docs", estTokens: 200, calls30d: 0 },
        { name: "never_used", estTokens: 300, calls30d: 0 },
      ],
    },
    {
      name: "chrome-devtools", enabled: true, toolCount: 1, estTokens: 0, cachedAt: null,
      tools: [{ name: "click", estTokens: 100, calls30d: 0 }],
    },
  ];
  const skills = [{ name: "usage-report", filePath: "/s/SKILL.md", disabled: false, calls30d: 0 }];
  const cat = buildCatalog(
    servers, skills,
    { search_docs: 7, never_used: 0, mcp__chrome_devtools: 428 },
    { "usage-report": 2 },
  );
  assert.equal(cat.mcp[0].tools[0].calls30d, 7); // bare-name exact match (built-in/extension tools)
  assert.equal(cat.mcp[0].calls30d, 7);
  assert.equal(cat.mcp[1].calls30d, 428); // server-level attribution: mcp__chrome_devtools (dash→underscore)
  assert.equal(cat.mcp[1].tools[0].calls30d, 0); // per-tool stays 0 for MCP (no apportioning in phase 1)
  assert.equal(cat.mcpTotalTools, 3);
  assert.equal(cat.skills[0].calls30d, 2);
});

test("token 估算口径：bytes/4（pi estimateTokens 同源）+ schema JSON 计入", () => {
  assert.equal(estimateTokens("abcdefgh"), 2); // 8 chars / 4
  assert.equal(estimateTokens(""), 0);
  const t1 = toolEstTokens({ name: "search", description: "d".repeat(40), inputSchema: { type: "object", properties: { q: { type: "string" } } } });
  const t2 = toolEstTokens({ name: "search", description: "", inputSchema: {} });
  assert.ok(t1 > t2, "schema+description add tokens");
  assert.ok(t2 >= 1);
});

test("readMcpCatalog: excludeTools 标记 + 幻影行（缓存中已消失的排除名单）", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-usage-cat-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "mcp-cache.json"), JSON.stringify({
    version: 1,
    servers: { big: { configHash: "x", cachedAt: Date.now(), tools: [
      { name: "click", description: "click it", inputSchema: { type: "object" } },
      { name: "search", description: "search", inputSchema: {} },
    ] } },
  }));
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { big: { command: "x", excludeTools: ["click", "gone_tool", "get_*"], enabled: false } } }));
  const servers = readMcpCatalog(agentDir, []);
  assert.equal(servers.length, 1);
  const srv = servers[0];
  assert.equal(srv.enabled, false);
  assert.deepEqual(srv.excludedPatterns, ["click", "gone_tool", "get_*"]);
  const byName = Object.fromEntries(srv.tools.map((t) => [t.name, t]));
  assert.equal(byName.click.excluded, true);           // cache row hit by a pattern → marked excluded
  assert.ok(!byName.search.excluded);
  assert.equal(byName.gone_tool.phantom, true);        // non-cache list row → phantom (restorable)
  assert.equal(byName.gone_tool.excluded, true);
  rmSync(root, { recursive: true, force: true });
});
