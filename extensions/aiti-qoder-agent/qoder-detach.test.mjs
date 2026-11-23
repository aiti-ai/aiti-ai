/**
 * aiti-qoder-agent — detachable hosting (agent-starter) regression.
 *
 * Adoption keeps the ACP session that is already established in the live `--acp`
 * process: no re-handshake, journal replay consumed as history until the
 * `replay_end` boundary. These tests pin that contract with a fake child.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const mod = await import("./index.ts");
const { QoderHandle } = mod;

/** Fake `--acp` child: EventEmitter surface + pipe-like stdio. */
function fakeChild({ detachable } = { detachable: true }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  if (detachable) {
    child.detachable = true;
    child.release = () => { child.released = true; };
  }
  child.kill = () => { child.killed = true; };
  return child;
}

test("adopt: no bootstrap, id from the native sid, history until replay_end", async () => {
  const child = fakeChild();
  const writes = [];
  child.stdin.on("data", (b) => writes.push(b.toString()));
  const handle = QoderHandle.start({ attached: { child, sessionId: "sess-1" }, variant: "intl" });
  const h = await handle;
  assert.equal(h.id, "qoder:sess-1", "handle id uses the adopted native session id");
  assert.equal(h.sessionReady, true, "an adopted ACP session is ready (no initialize/session/new)");
  assert.equal(h.loading, true, "journal replay is treated as history");
  const events = [];
  h.subscribe((e) => events.push(e.type));
  child.emit("replay_end");
  // The boundary is awaited now: readiness (and the resumed agent_start) resolves only after
  // the persisted history seed, so a page that opens with the boundary still gets a full
  // transcript instead of an empty one (2026-11-23).
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.loading, false, "replay_end flips to live");
  assert.ok(events.includes("agent_start"), `agent_start should fire at the boundary, got ${JSON.stringify(events)}`);
  assert.equal(writes.length, 0, "adoption must not send any ACP request (no bootstrap)");
  await h.dispose();
});

test("adopt on a plain child (no wrapper): live from the start", async () => {
  const child = fakeChild({ detachable: false });
  const h = await QoderHandle.start({ attached: { child, sessionId: "sess-2" }, variant: "cn" });
  assert.equal(h.id, "qodercn:sess-2");
  assert.equal(h.loading, false, "nothing to replay → straight to live");
  await h.dispose();
});

test("dispose releases a wrapper-hosted process instead of killing it", async () => {
  const child = fakeChild();
  const h = await QoderHandle.start({ attached: { child, sessionId: "sess-3" }, variant: "intl" });
  await h.dispose();
  assert.equal(child.released, true, "facade child is released (agent keeps running)");
  assert.equal(child.killed, false, "a wrapper-hosted child must never be SIGTERM'd by dispose");
});
