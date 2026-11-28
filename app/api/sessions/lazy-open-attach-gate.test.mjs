/**
 * Lazy session open — the read-path attach gate (2026-11-23).
 *
 * Opening / restoring / renaming a session must never start an agent process.
 * Every read-side attachIfBridged call passes `{ create: false }`; write paths
 * (prompt, explicit attach, hosting switch, auto-name) keep create = true so a
 * cold provider-owned session still starts on a real interaction.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

const detailRoute = await read("./[id]/route.ts");
const stateRoute = await read("./[id]/state/route.ts");
const contextRoute = await read("./[id]/context/route.ts");
const autoNameRoute = await read("./[id]/auto-name/route.ts");
const agentRoute = await read("../agent/[id]/route.ts");
const agentEventsRoute = await read("../agent/[id]/events/route.ts");

test("session detail read attaches live sessions only (open/restore by id)", () => {
  // Read-path attach helper + the bridge reverse lookup both pass create:false.
  const attachCalls = [...detailRoute.matchAll(/attachIfBridged\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(attachCalls.length >= 3, `expected the read attach sites, got ${attachCalls.length}`);
  for (const args of attachCalls) {
    assert.match(args, /create: false/, `read-path attach must not create: attachIfBridged(${args})`);
  }
});

test("state / context / SSE reads attach live sessions only", () => {
  assert.match(stateRoute, /attachIfBridged\(fp, \{ create: false \}\)/);
  assert.match(contextRoute, /attachIfBridged\(fpEarly, \{ create: false \}\)/);
  assert.match(agentEventsRoute, /attachIfBridged\(filePath, \{ create: false \}\)/);
});

test("agent GET state probe is a read; the POST command path keeps create", () => {
  const getSection = agentRoute.slice(agentRoute.indexOf("export async function GET"));
  assert.match(getSection, /attachIfBridged\(bridgedFile, \{ create: false \}\)/);
  const postSection = agentRoute.slice(0, agentRoute.indexOf("export async function GET"));
  assert.match(postSection, /attachIfBridged\(filePath\)/, "a prompt/command must still start a cold provider session");
  assert.doesNotMatch(postSection, /create: false/);
});

test("auto-name keeps the write path (it runs a prompt on the backend)", () => {
  assert.match(autoNameRoute, /attachIfBridged\(filePath\)/);
  assert.doesNotMatch(autoNameRoute, /create: false/);
});
