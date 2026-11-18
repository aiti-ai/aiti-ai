import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * POST /api/sessions/[id]/detach — "start this cold session detached".
 *
 * Pins the guards that keep it from doing harm:
 *   - unknown id → 404 (never spawn a phantom agent under a foreign id)
 *   - a real session whose agent family has no detachable backend → 400 with the
 *     family name, no process started
 * The happy path (spawn through the wrapper) is verified on the dev instance.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-web-detach-route-agent-"));
process.once("exit", () => {
  try { rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST: detachSession } = await jiti.import("./route.ts");
const { cacheSessionPath, invalidateSessionPathCache, invalidateSessionListCache } = await jiti.import(
  "../../../../../lib/session-reader.ts",
);

function call(id) {
  return detachSession(
    new Request(`http://localhost/api/sessions/${id}/detach`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

test("unknown session id is refused instead of spawning a phantom agent", async () => {
  const response = await call("00000000-0000-0000-0000-0000000000aa");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Session not found" });
});

test("a session whose agent family has no detachable backend answers 400 with the family", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-detach-route-"));
  const id = "11111111-2222-3333-4444-5555555555bb";
  const filePath = join(dir, `2099-01-01T00-00-00-000Z_${id}.jsonl`);
  // Placeholder row of an external agent whose backend never opted in.
  writeFileSync(
    filePath,
    JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir, extId: "nosuchagent:abc" }) + "\n",
  );
  cacheSessionPath(id, filePath);
  try {
    const response = await call(id);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(String(body.error), /no detachable backend/i);
    assert.match(String(body.error), /nosuchagent/);
  } finally {
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
