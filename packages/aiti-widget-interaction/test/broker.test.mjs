import test from "node:test";
import assert from "node:assert/strict";
import { InteractionBroker } from "../dist/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("ask resolves a confirm answer and removes the pending request", async () => {
  let seq = 0;
  const broker = new InteractionBroker({ idFactory: () => `id-${++seq}` });
  const result = broker.ask({ kind: "confirm", title: "Continue?" });
  assert.deepEqual(broker.pending().map((r) => r.id), ["id-1"]);
  const outcome = broker.answer("id-1", { action: "approve", approved: true, comment: "ok" });
  assert.equal(outcome.ok, true);
  const answer = await result;
  assert.equal(answer.status, "answered");
  assert.equal(answer.action, "approve");
  assert.equal(answer.approved, true);
  assert.equal(answer.comment, "ok");
  assert.equal(broker.pending().length, 0);
  assert.equal(broker.answer("id-1", { action: "approve" }).ok, false);
});

test("timeout resolves without a human answer", async () => {
  const broker = new InteractionBroker({ idFactory: () => "timeout", timeoutMs: 25 });
  const result = await broker.ask({ kind: "input", title: "Name?" });
  assert.equal(result.status, "timeout");
  assert.equal(result.reason, "timeout");
  assert.equal(broker.pending().length, 0);
});

test("keepOpen updates state and resolves only through the host", async () => {
  const broker = new InteractionBroker({ idFactory: () => "custom" });
  const opened = broker.open({ kind: "custom", keepOpen: true, state: { phase: "ready" } });
  const keep = broker.answer("custom", { action: "pause", keepOpen: true, state: { phase: "pausing" } });
  assert.equal(keep.keepOpen, true);
  assert.equal(broker.pending()[0].state.phase, "pausing");
  broker.update("custom", { phase: "paused", label: "Paused" });
  assert.equal(broker.pending()[0].state.label, "Paused");
  broker.resolve("custom", { status: "answered", action: "continue" });
  const result = await opened.result;
  assert.equal(result.action, "continue");
  assert.equal(result.state.phase, "paused");
});

test("subscribers receive snapshot, request, update and resolved events", async () => {
  const broker = new InteractionBroker({ idFactory: () => "events" });
  const events = [];
  const off = broker.subscribe((event) => events.push(event));
  const pending = broker.ask({ kind: "confirm", title: "Continue?" });
  broker.answer("events", { action: "approve", approved: false });
  await pending;
  off();
  assert.equal(events[0].type, "snapshot");
  assert.equal(events[1].type, "request");
  assert.equal(events[2].type, "resolved");
  assert.equal(broker.pending().length, 0);
});

test("close cancels pending requests", async () => {
  const broker = new InteractionBroker({ idFactory: () => "closed" });
  const result = broker.ask({ kind: "confirm", title: "Continue?" });
  await sleep(0);
  broker.close();
  const answer = await result;
  assert.equal(answer.status, "cancelled");
  assert.match(answer.reason, /closed/);
});
