import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * POST /api/sessions/[id]/attach — "Start in process": convert a previously
 * detached (survive-restart) session back to in-process hosting.
 *
 * Pins:
 *   - composite external id → 400 (pi sessions only)
 *   - unknown id → 404
 *   - already running → { ok, already: true } (no re-spawn)
 *   - cold session with a marker → marker cleared + local runtime started
 *
 * rpc-manager is stubbed (a real local spawn pulls the whole pi SDK runtime);
 * the agent-starter registry is real, pointed at a temp PI_AGENT_STARTER_DIR.
 */

const sandbox = mkdtempSync(join(tmpdir(), "pi-web-attach-route-"));
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-attach-route-agent-"));
process.env.PI_AGENT_STARTER_DIR = mkdtempSync(join(tmpdir(), "pi-web-attach-route-starter-"));
process.once("exit", () => {
  for (const dir of [process.env.PI_CODING_AGENT_DIR, process.env.PI_AGENT_STARTER_DIR, sandbox]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Mutable stub state (per-test).
globalThis.__attachStubRpc = { aliveIds: new Set(), started: [] };

const rpcStub = `
export async function startRpcSession(sessionId, sessionFile, cwd, options = {}) {
  globalThis.__attachStubRpc.started.push([sessionId, sessionFile]);
  return { session: { sessionId }, realSessionId: sessionId };
}
export function getRpcSession(id) {
  const alive = globalThis.__attachStubRpc.aliveIds.has(id);
  return alive ? { isAlive: () => true } : undefined;
}
export function setRpcSessionTools() { return { sessionId: "x", recreated: false }; }
export function getOfflineSessionStats() { return {}; }
`;

const stubPath = join(sandbox, "rpc-manager-stub.mjs");
writeFileSync(stubPath, rpcStub);

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd(), "@/lib/rpc-manager": stubPath },
  interopDefault: true,
  moduleCache: false,
});
const { POST: attachSession } = await jiti.import("./route.ts");
const { cacheSessionPath } = await jiti.import("../../../../../lib/session-reader.ts");
const { setDetachedPreference, getDetachedPreference } = await jiti.import("../../../../../lib/agent-starter/registry.ts");

function call(id) {
  return attachSession(
    new Request(`http://localhost/api/sessions/${id}/attach`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

function coldSessionFile(id) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-attach-sess-"));
  const filePath = join(dir, `2099-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    filePath,
    JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir }) + "\n",
  );
  cacheSessionPath(id, filePath);
  return filePath;
}

test("composite external id is refused: in-process hosting is pi-only", async () => {
  const response = await call("claude:sess_abc");
  assert.equal(response.status, 400);
  assert.match(String((await response.json()).error), /pi sessions only/i);
});

test("unknown session id answers 404", async () => {
  const response = await call("00000000-0000-0000-0000-0000000000aa");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
});

test("a live session answers already=true and does not re-spawn", async () => {
  const id = "11111111-2222-3333-4444-5555555555bb";
  globalThis.__attachStubRpc.aliveIds.add(id);
  try {
    const response = await call(id);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, already: true, started: false });
    assert.equal(globalThis.__attachStubRpc.started.length, 0);
  } finally {
    globalThis.__attachStubRpc.aliveIds.delete(id);
  }
});

test("cold session with a survive-restart marker: marker cleared + local runtime started", async () => {
  const id = "22222222-3333-4444-5555-6666666666cc";
  const filePath = coldSessionFile(id);
  setDetachedPreference(id, { providerType: "aiti-pi-agent/spawn", agentKey: "pi" });
  assert.ok(getDetachedPreference(id), "precondition: marker present");

  const response = await call(id);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, already: false, started: true });
  assert.deepEqual(globalThis.__attachStubRpc.started.at(-1), [id, filePath]);
  assert.equal(getDetachedPreference(id), undefined, "marker must be cleared before spawn");
});
