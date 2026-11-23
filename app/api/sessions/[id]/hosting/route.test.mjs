import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Route contract for GET/POST /api/sessions/[id]/hosting.
 *
 * The hosting core is covered by lib/session/hosting.test.mjs; this file only
 * pins the HTTP surface (body validation + HostingError → status/code mapping).
 */

const sandbox = mkdtempSync(join(tmpdir(), "pi-web-hosting-route-"));
process.once("exit", () => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

const stubPath = join(sandbox, "hosting-stub.mjs");
writeFileSync(stubPath, `
export class HostingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HostingError";
    this.status = status;
    this.code = code;
  }
}
export async function describeSessionHosting(id) {
  const s = globalThis.__hostingRouteStub ?? {};
  if (s.getError) throw new HostingError(s.getError.status, s.getError.code, s.getError.message);
  return s.info ?? { ok: true, sessionId: id };
}
export async function switchSessionHosting(id, mode) {
  const s = globalThis.__hostingRouteStub ?? {};
  s.lastSwitch = { id, mode };
  if (s.postError) throw new HostingError(s.postError.status, s.postError.code, s.postError.message);
  return s.switchResult ?? { ok: true, mode, info: { ok: true, sessionId: id } };
}
`);

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": process.cwd(),
    "@/lib/session/hosting": stubPath,
  },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./route.ts");

function reset(patch = {}) {
  globalThis.__hostingRouteStub = { ...patch };
}

function callGet(id = "session-1") {
  return GET(new Request(`http://localhost/api/sessions/${id}/hosting`), { params: Promise.resolve({ id }) });
}

function callPost(body, id = "session-1") {
  return POST(
    new Request(`http://localhost/api/sessions/${id}/hosting`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

test("GET returns the hosting snapshot", async () => {
  reset({ info: { ok: true, sessionId: "session-1", agent: "pi", mode: null } });
  const response = await callGet();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.agent, "pi");
  assert.equal(body.sessionId, "session-1");
});

test("GET maps a HostingError to status + code", async () => {
  reset({ getError: { status: 404, code: "session_not_found", message: "Session not found" } });
  const response = await callGet("missing");
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, "session_not_found");
  assert.equal(body.ok, false);
});

test("POST rejects an invalid mode without touching the core", async () => {
  reset();
  const response = await callPost({ mode: "nope" });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_mode");
  assert.equal(globalThis.__hostingRouteStub.lastSwitch, undefined);
});

test("POST forwards a valid mode and returns the switch result", async () => {
  reset({ switchResult: { ok: true, mode: "subprocess-detached", info: { ok: true, sessionId: "session-1", mode: "subprocess-detached" } } });
  const response = await callPost({ mode: "subprocess-detached" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "subprocess-detached");
  assert.deepEqual(globalThis.__hostingRouteStub.lastSwitch, { id: "session-1", mode: "subprocess-detached" });
});

test("POST maps a running-session rejection to HTTP 409", async () => {
  reset({ postError: { status: 409, code: "session_running", message: "the session is running" } });
  const response = await callPost({ mode: "in-process" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "session_running");
  assert.equal(body.ok, false);
});

test("POST with an unreadable body is reported as invalid_mode", async () => {
  reset();
  const response = await POST(
    new Request("http://localhost/api/sessions/session-1/hosting", { method: "POST", body: "not-json" }),
    { params: Promise.resolve({ id: "session-1" }) },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_mode");
});
