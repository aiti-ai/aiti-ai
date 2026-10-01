import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MCP_STATUS_MAX_RECORDS,
  clearMcpStatuses,
  mcpStatusCount,
  mcpStatusKey,
  readMcpStatus,
  recordMcpStatus,
  withMcpStatuses,
} = await jiti.import("./mcp-status.ts");

beforeEach(() => clearMcpStatuses());

const GLOBAL = "/home/u/.pi/agent/mcp.json";
const PROJECT_A = "/work/a/.pi/mcp.json";
const PROJECT_B = "/work/b/.pi/mcp.json";

function status(state = "connected", extra = {}) {
  return { origin: "test", state, tools: [], toolCount: 0, durationMs: 5, testedAt: 1, ...extra };
}

function info(scope, sourcePath, name, configKey) {
  return { name, scope, sourcePath, configKey, enabled: true, validated: true, envNames: [], headerNames: [], usesOAuth: false, commandFields: [], variableReferences: [], masked: false };
}

test("a status is keyed by scope, file and name, so same-named entries never share one", () => {
  assert.equal(mcpStatusKey({ scope: "global", sourcePath: GLOBAL, name: "docs" }), `global\0${GLOBAL}\0docs`);
  recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "docs" }, "k1", status("connected"));
  recordMcpStatus({ scope: "project", sourcePath: PROJECT_A, name: "docs" }, "k2", status("failed"));
  recordMcpStatus({ scope: "project", sourcePath: PROJECT_B, name: "docs" }, "k3", status("needs-auth"));
  assert.equal(readMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "docs" }, "k1").state, "connected");
  assert.equal(readMcpStatus({ scope: "project", sourcePath: PROJECT_A, name: "docs" }, "k2").state, "failed");
  assert.equal(readMcpStatus({ scope: "project", sourcePath: PROJECT_B, name: "docs" }, "k3").state, "needs-auth");
  // A later record for an entry replaces its earlier one.
  recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "docs" }, "k1", status("failed"));
  assert.equal(readMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "docs" }, "k1").state, "failed");
  assert.equal(mcpStatusCount(), 3);
});

test("a status recorded for other content is stale: dropped, and not back when the entry is changed back", () => {
  const entry = { scope: "global", sourcePath: GLOBAL, name: "docs" };
  recordMcpStatus(entry, "before-edit", status());
  assert.equal(readMcpStatus(entry, "after-edit"), undefined);
  assert.equal(mcpStatusCount(), 0);
  assert.equal(readMcpStatus(entry, "before-edit"), undefined);
});

test("the listing gets each server's current status, and a read file's vanished names lose theirs", () => {
  recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "docs" }, "docs-key", status("connected"));
  recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "gone" }, "gone-key", status("failed"));
  recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "edited" }, "old-key", status("failed"));
  recordMcpStatus({ scope: "project", sourcePath: PROJECT_B, name: "other" }, "other-key", status("connected"));
  const servers = withMcpStatuses(
    [info("global", GLOBAL, "docs", "docs-key"), info("global", GLOBAL, "edited", "new-key"), info("global", GLOBAL, "fresh", "fresh-key")],
    [{ scope: "global", path: GLOBAL }],
  );
  assert.deepEqual(servers.map((server) => [server.name, server.status?.state]), [["docs", "connected"], ["edited", undefined], ["fresh", undefined]]);
  // The global file was read: "gone" is no longer in it, and "edited" changed. Project B's file was
  // not read here, so its record stays for the panel that shows that project.
  assert.equal(readMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "gone" }, "gone-key"), undefined);
  assert.equal(readMcpStatus({ scope: "project", sourcePath: PROJECT_B, name: "other" }, "other-key").state, "connected");
  assert.equal(mcpStatusCount(), 2);
  // The input is not changed.
  const plain = info("global", GLOBAL, "docs", "docs-key");
  withMcpStatuses([plain], []);
  assert.equal(plain.status, undefined);
});

test("the store is bounded, dropping the entry written longest ago, and lives on globalThis", () => {
  for (let index = 0; index < MCP_STATUS_MAX_RECORDS + 5; index++) {
    recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: `s${index}` }, "k", status());
  }
  assert.equal(mcpStatusCount(), MCP_STATUS_MAX_RECORDS);
  assert.equal(readMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "s0" }, "k"), undefined);
  assert.equal(readMcpStatus({ scope: "global", sourcePath: GLOBAL, name: `s${MCP_STATUS_MAX_RECORDS + 4}` }, "k").state, "connected");
  // Written again counts as newest.
  recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "s5" }, "k", status("failed"));
  recordMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "extra" }, "k", status());
  assert.equal(readMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "s5" }, "k").state, "failed");
  assert.equal(readMcpStatus({ scope: "global", sourcePath: GLOBAL, name: "s6" }, "k"), undefined);
  // Route handlers are bundled separately and hot reload re-evaluates modules: one map per process.
  assert.ok(globalThis[Symbol.for("pi-web:mcp-status")] instanceof Map);
  assert.equal(globalThis[Symbol.for("pi-web:mcp-status")].size, mcpStatusCount());
});
