import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const agentEventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");
const agentPostSource = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");

test("agent SSE lazily creates the runtime: opening a session does not cold-start; attaches via broadcast once the wrapper appears", () => {
  assert.match(agentEventsSource, /createAgentEventStream\(req, id, sessionPromise\)/);
  // A local session without a wrapper must not startRpcSession (opening a session is
  // view-only and must not pull up a runtime); attach a lazy handle instead — the real
  // wrapper is brought up by subsequent real interactions and attaches via the running broadcast.
  assert.doesNotMatch(agentEventsSource, /startRpcSession\(/);
  assert.match(agentEventsSource, /sessionPromise = Promise\.resolve\(createPendingAgentSessionHandle\(/);
  assert.match(agentEventsSource, /waitForRpcSession\(id, \(wrapper\) => onReady\(wrapper\)\)/);
  assert.match(agentEventsSource, /if \(req\.signal\.aborted\) return new Response\(null, \{ status: 204 \}\)/);
  assert.match(agentEventsSource, /"Cache-Control": "no-cache, no-transform"/);
  assert.match(agentEventsSource, /"X-Accel-Buffering": "no"/);
});

test("agent SSE reuses one TextEncoder per stream", () => {
  assert.equal((agentEventStreamSource.match(/new TextEncoder\(\)/g) ?? []).length, 1);
  assert.match(agentEventStreamSource, /controller\.enqueue\(encoder\.encode\(/);
});

test("composite external ids (zcode:sess_x etc.) get a cold-recovery fallback over the registry gap instead of 404", () => {
  // events: the SSE opens immediately, sessionPromise cold-recovers asynchronously;
  // failures surface the real reason via startup_error
  assert.match(agentEventsSource, /sessionPromise = resolveExternalCompositeSession\(id\)\.then/);
  assert.match(agentEventsSource, /Session backend unavailable/);
  assert.doesNotMatch(agentEventsSource, /await resolveExternalCompositeSession/);
  // POST: try cold recovery before the 404; only 404 with the real reason +
  // prompt_rejected semantics when that still fails
  assert.match(agentPostSource, /const ext = await resolveExternalCompositeSession\(id\)/);
  assert.match(agentPostSource, /Session backend unavailable/);
});
