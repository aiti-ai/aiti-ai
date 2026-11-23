/**
 * MCP self-check tests (node --test): the two shapes that make one bridge get registered or
 * connected twice.
 *   1. one config file already lists the same endpoint under another name → registerMcp
 *      skips the write and reports duplicateOf
 *   2. several config files define one name with different endpoints, or one endpoint under
 *      several names → auditMcpServers reports it
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SANDBOX = mkdtempSync(join(tmpdir(), "aiti-mcp-dup-"));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;

const { registerMcp, unregisterMcp, auditMcpServers, normalizeMcpUrl } = await import("./mcp-config.ts");

const QUIET = () => {};
const rd = (p) => JSON.parse(readFileSync(p, "utf8"));

function configFile(name, cfg) {
  const p = join(SANDBOX, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

test("normalizeMcpUrl: default ports, host case and trailing slashes do not matter", () => {
  assert.equal(normalizeMcpUrl("HTTP://Example.COM:80/aiti/mcp/"), "http://example.com/aiti/mcp");
  assert.equal(normalizeMcpUrl("https://example.com:443/aiti/mcp"), "https://example.com/aiti/mcp");
  assert.equal(normalizeMcpUrl("http://127.0.0.1:30142/dev/api/x/mcp"), "http://127.0.0.1:30142/dev/api/x/mcp");
  assert.equal(normalizeMcpUrl("not a url"), null);
  assert.equal(normalizeMcpUrl(undefined), null);
  assert.equal(normalizeMcpUrl("http://a:1111/x"), normalizeMcpUrl("http://a:1111/x/"));
  assert.notEqual(normalizeMcpUrl("http://a:1111/x"), normalizeMcpUrl("http://a:1112/x"));
});

test("registerMcp: idempotent, and skips an equivalent entry under another name", () => {
  const file = configFile("dup/one.json", {
    mcpServers: { "aiti-devtools-old": { type: "http", url: "HTTP://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp/" } },
  });
  const url = "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp";

  const first = registerMcp({ url, configPaths: [file], log: QUIET });
  assert.equal(first.ok, true);
  assert.equal(first.changed, false, "equivalent endpoint already present → nothing to write");
  assert.equal(first.results[0].duplicateOf, "aiti-devtools-old");
  assert.deepEqual(Object.keys(rd(file).mcpServers), ["aiti-devtools-old"], "no second entry added");

  // a different endpoint under another name must still be written
  const other = registerMcp({ url: "http://127.0.0.1:20341/api/extensions/aiti-devtools/mcp/mcp", configPaths: [file], log: QUIET });
  assert.equal(other.ok, true);
  assert.equal(other.changed, true);
  assert.deepEqual(Object.keys(rd(file).mcpServers).sort(), ["aiti-devtools", "aiti-devtools-old"]);

  // re-running the same registration stays idempotent
  const again = registerMcp({ url: "http://127.0.0.1:20341/api/extensions/aiti-devtools/mcp/mcp", configPaths: [file], log: QUIET });
  assert.equal(again.changed, false);
  assert.equal(again.results[0].duplicateOf, undefined);
});

test("registerMcp: a disabled equivalent entry does not block the write", () => {
  const file = configFile("dup/disabled.json", {
    mcpServers: { "aiti-devtools-off": { type: "http", url: "http://127.0.0.1:30142/dev/x/mcp", enabled: false } },
  });
  const r = registerMcp({ url: "http://127.0.0.1:30142/dev/x/mcp", configPaths: [file], log: QUIET });
  assert.equal(r.changed, true, "disabled entries must not shadow an active registration");
  assert.deepEqual(Object.keys(rd(file).mcpServers).sort(), ["aiti-devtools", "aiti-devtools-off"]);
});

test("registerMcp: unregister still removes the exact entry", () => {
  const file = configFile("dup/two.json", { mcpServers: {} });
  const url = "http://127.0.0.1:8777/aiti/mcp";
  assert.equal(registerMcp({ url, configPaths: [file], log: QUIET }).changed, true);
  assert.equal(unregisterMcp({ configPaths: [file], log: QUIET }).changed, true);
  assert.deepEqual(rd(file).mcpServers, {});
});

test("auditMcpServers: same name with diverging endpoints across files", () => {
  const a = configFile("audit/a.json", { mcpServers: { "aiti-devtools": { type: "http", url: "http://127.0.0.1:30142/dev/api/extensions/aiti-devtools/mcp/mcp" } } });
  const b = configFile("audit/b.json", { mcpServers: { "aiti-devtools": { type: "http", url: "http://localhost:5199/aiti/mcp" } } });
  const report = auditMcpServers([a, b, join(SANDBOX, "audit/missing.json")]);
  assert.equal(report.sameName.length, 1);
  assert.equal(report.sameName[0].name, "aiti-devtools");
  assert.equal(report.sameName[0].urls.length, 2);
  assert.equal(report.sameUrl.length, 0);
});

test("auditMcpServers: same endpoint under several names (double connection)", () => {
  const a = configFile("audit/c.json", {
    mcpServers: {
      "aiti-devtools": { type: "http", url: "http://127.0.0.1:8777/aiti/mcp" },
      "aiti-devtools-copy": { type: "http", url: "http://127.0.0.1:8777/aiti/mcp/" },
    },
  });
  const report = auditMcpServers([a]);
  assert.equal(report.sameUrl.length, 1);
  assert.equal(report.sameUrl[0].url, "http://127.0.0.1:8777/aiti/mcp");
  assert.deepEqual(report.sameUrl[0].entries.map((e) => e.name).sort(), ["aiti-devtools", "aiti-devtools-copy"]);
});

test("auditMcpServers: identical duplicate across files is not reported as a conflict", () => {
  const url = "http://127.0.0.1:8777/aiti/mcp";
  const a = configFile("audit/d.json", { mcpServers: { "aiti-devtools": { type: "http", url } } });
  const b = configFile("audit/e.json", { mcpServers: { "aiti-devtools": { type: "http", url } } });
  const report = auditMcpServers([a, b]);
  assert.deepEqual(report.sameName, []);
  assert.deepEqual(report.sameUrl, []);
});

test("auditMcpServers: handles servers/mcp containers and stdio entries", () => {
  const a = configFile("audit/f.json", { servers: { x: { url: "http://a:1/x" } } });
  const b = configFile("audit/g.json", { mcp: { y: { url: "http://a:1/x", type: "http" }, z: { command: "node", args: ["s.cjs"] } } });
  const report = auditMcpServers([a, b]);
  assert.equal(report.sameUrl.length, 1, "cross-container duplicate is still one endpoint");
  assert.deepEqual(report.sameUrl[0].entries.map((e) => e.name).sort(), ["x", "y"]);
  assert.equal(report.sameName.length, 0);
});
