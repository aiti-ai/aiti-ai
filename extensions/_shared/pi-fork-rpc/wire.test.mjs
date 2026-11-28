/**
 * wire.test — pi-fork-rpc shared-layer wire-protocol host / extension_ui bridge pure-function tests.
 * Split from the common part of the old aiti-pi-agent/pi-rpc-spawn.test.mjs (depends on no fork semantics).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { RpcChildHost, lineReader, shutdownChild, toInteractionRequest, toExtensionUIResponse } from "./wire.ts";

function fakeChild() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes = [];
  const stdin = new PassThrough();
  stdin.on("data", (c) => writes.push(Buffer.from(c).toString("utf8")));
  const listeners = new Map();
  return {
    stdout,
    stderr,
    stdin,
    writes,
    frames: () => writes.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    exitCode: null,
    kill: () => true,
    once: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
      return this;
    },
    emit: (ev, ...args) => {
      for (const fn of listeners.get(ev) ?? []) fn(...args);
    },
    _listeners: listeners,
  };
}

function feed(host, obj) {
  host.child.stdout.write(JSON.stringify(obj) + "\n");
}

async function later(ms = 20) {
  await new Promise((r) => setTimeout(r, ms));
}

test("wire: request/response id correlation + error frame rejects", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const p = h.request({ type: "get_state" });
  await later();
  assert.equal(child.frames()[0].type, "get_state");
  // Ids carry a per-instance salt (2026-11-22): read the id off the wire instead of assuming a format.
  feed(h, { id: child.frames()[0].id, type: "response", command: "?", success: true, data: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });

  const p2 = h.request({ type: "get_state" });
  await later();
  feed(h, { id: child.frames()[1].id, type: "response", command: "get_state", success: false, error: "boom" });
  await assert.rejects(p2, /boom/);
});

test("wire: non-response frames pass through to emit as-is by default", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const events = [];
  h.subscribe((e) => events.push(e));
  feed(h, { type: "agent_start" });
  feed(h, { type: "message_end", message: { role: "assistant", content: [] } });
  await later();
  assert.equal(events[0].type, "agent_start");
  assert.equal(events[1].type, "message_end");
});

test("wire: process exit -> pending rejects + session_backend_dead event", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const events = [];
  h.subscribe((e) => events.push(e));
  const p = h.request({ type: "abort" });
  await later();
  child.emit("exit", 137);
  await assert.rejects(p, /dead/);
  assert.equal(events.find((e) => e.type === "session_backend_dead")?.reason, "process exited (137)");
});

// ---- hardening regressions (evidence items from docs/pi-fork-rpc-review-findings.md) ----

test("wire: multi-byte characters split across chunks decode intact per line (review P0-1 regression)", async () => {
  const pt = new PassThrough();
  const lines = [];
  lineReader(pt, (l) => lines.push(l));
  // "é" = C3 A9: split inside the 2-byte sequence across two chunks
  pt.write('{"title":"');
  pt.write(Buffer.from([0xc3]));
  pt.write(Buffer.from([0xa9]));
  pt.write('"}\n');
  await later();
  assert.ok(lines[0]?.includes("é"), `cross-chunk decoding must be complete, got=${JSON.stringify(lines[0])}`);
});

test("lineReader: an overlong line triggers onOverflow and stops processing (review P1-6 regression)", async () => {
  const pt = new PassThrough();
  const lines = [];
  let overflowSize = 0;
  lineReader(pt, (l) => lines.push(l), { maxLineBytes: 64, onOverflow: (n) => (overflowSize = n) });
  pt.write(Buffer.from("a".repeat(100))); // over the cap without a newline
  await later();
  pt.write('{"x":1}\n'); // no longer processed after the overflow
  await later();
  assert.ok(overflowSize >= 64, "onOverflow should have fired");
  assert.equal(lines.length, 0, "no dispatch after the overflow");
});

test("wire: line overflow -> markDead (RpcChildHost wiring)", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child, { maxLineBytes: 64 });
  const events = [];
  h.subscribe((e) => events.push(e));
  child.stdout.write(Buffer.from("a".repeat(100)));
  await later();
  assert.equal(events.find((e) => e.type === "session_backend_dead")?.reason.includes("overflow"), true);
  assert.equal(h.aliveFlag, false);
});

test("wire: a single listener throwing neither drops frames nor raw-throws (review P0-3 regression)", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const got = [];
  let boom = null;
  h.subscribe(() => { throw new Error("listener boom"); });
  h.subscribe((e) => got.push(e));
  child.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
  await later();
  assert.equal(got.length, 1, "the second listener should still receive the frame");
  assert.equal(got[0].type, "agent_start");
});

test("wire: stdout stream error -> markDead (review P0-2 regression)", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const events = [];
  h.subscribe((e) => events.push(e));
  child.stdout.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  await later();
  assert.equal(events.find((e) => e.type === "session_backend_dead")?.reason.includes("stdout error"), true);
  assert.equal(h.aliveFlag, false);
});

test("wire: request timeout rejects + response/death clears the timer (review P1-4 regression)", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  await assert.rejects(
    h.request({ type: "get_state" }, { timeoutMs: 20 }),
    /\[rpc-child\] timeout: get_state after 20ms/,
  );
  // The normal response path is unaffected by the timeout
  const p = h.request({ type: "get_state" }, { timeoutMs: 5_000 });
  await later();
  feed(h, { id: child.frames()[1].id, type: "response", command: "get_state", success: true, data: { ok: 1 } });
  assert.deepEqual(await p, { ok: 1 });
});

test("wire: the pending timeout timer is cleared together on death (no leak)", async () => {
  const child = fakeChild();
  const h = new RpcChildHost(child);
  const p = h.request({ type: "get_state" }, { timeoutMs: 60_000 });
  await later();
  child.emit("exit", 0);
  await assert.rejects(p, /dead/);
  // If the timer leaked, 60s later there would be one extra reject (pending already cleared, no
  // side effect) — this only regresses the reject path
});

test("shutdownChild: SIGTERM -> destroy the three streams (real child-process smoke test)", async () => {
  const child = spawn("node", ["-e", "setInterval(()=>{},1000)"]);
  await later(80);
  const t0 = Date.now();
  await shutdownChild(child, 120);
  assert.ok(child.signalCode !== null || child.exitCode !== null, "the child process should have exited");
  assert.ok(Date.now() - t0 < 900, "should settle quickly after the grace period");
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stdin.destroyed, true);
});

// ---- extension_ui <-> interaction_request bridge pure functions --------------------------------

test("toInteractionRequest: open_url real frame shape (instructions field) -> prompt projection", () => {
  const ir = toInteractionRequest({
    type: "extension_ui_request", id: "ui-8", method: "open_url",
    url: "https://auth.x/oa2/authorize", launchUrl: "http://127.0.0.1:1/l", instructions: "Finish the authorization in the browser",
  });
  assert.equal(ir.kind, "open_url");
  assert.equal(ir.toolName, "extension_ui.open_url");
  assert.equal(ir.prompt, "Finish the authorization in the browser");
  assert.equal(ir.url, "https://auth.x/oa2/authorize");
  assert.equal(ir.launchUrl, "http://127.0.0.1:1/l");
});

test("toInteractionRequest: select (with optionDetails description) -> ask_user event", () => {
  const ir = toInteractionRequest({
    type: "extension_ui_request", id: "b", method: "select", title: "t", options: ["x", "y"],
    optionDetails: [{}, { description: "cheaper" }],
  });
  assert.equal(ir.kind, "ask_user");
  assert.equal(ir.questions[0].options[1].description, "cheaper");
});

test("toInteractionRequest: input/editor -> ask_user free text (options required, must be an empty array)", () => {
  // Regression: the projection used to omit `options` entirely, so the session-request
  // cards threw on options.map and the request had no way to be answered — /vault add
  // (ctx.ui.input) never reached the store on subprocess backends.
  const input = toInteractionRequest({
    type: "extension_ui_request", id: "i1", method: "input",
    title: "Value for \"API_KEY\"", placeholder: "Value never reaches the model",
  });
  assert.equal(input.kind, "ask_user");
  assert.equal(input.toolName, "extension_ui.input");
  assert.equal(input.questions.length, 1);
  assert.equal(input.questions[0].question, 'Value for "API_KEY"');
  assert.deepEqual(input.questions[0].options, [], "options-required contract: free-text questions carry an empty array, the field must not be omitted");

  const editor = toInteractionRequest({
    type: "extension_ui_request", id: "e1", method: "editor", title: "", prefill: "secret",
  });
  assert.equal(editor.kind, "ask_user");
  assert.equal(editor.toolName, "extension_ui.editor");
  assert.deepEqual(editor.questions[0].options, []);
  assert.equal(editor.questions[0].question, "Editor", "a stable label when untitled (the answers key)");
  assert.equal(editor.input.prefill, "secret");

  // An untitled input still gets a stable label — it is the key the answer is addressed by
  const untitled = toInteractionRequest({ type: "extension_ui_request", id: "i2", method: "input" });
  assert.equal(untitled.questions[0].question, "Input");
  // The free-text answer travels back as answers[question], the key the card renders
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "i2", method: "input" }, { action: "accept", answers: { Input: "typed-value" } }),
    { type: "extension_ui_response", id: "i2", value: "typed-value" },
  );
});

test("toExtensionUIResponse: select with no answer (decline) -> cancelled; direct pure-function test", () => {
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "a", method: "select", title: "t", options: ["x"] }, { action: "decline" }),
    { type: "extension_ui_response", id: "a", cancelled: true },
  );
  const ir = toInteractionRequest({ type: "extension_ui_request", id: "b", method: "select", title: "t", options: ["x"] });
  assert.equal(ir.kind, "ask_user");
});

test("toExtensionUIResponse: select accept with an answer -> value frame; confirm three states; input/editor", () => {
  const sel = toExtensionUIResponse(
    { type: "extension_ui_request", id: "s", method: "select", title: "t", options: ["x"] },
    { action: "accept", answers: { t: "x" } },
  );
  assert.deepEqual(sel, { type: "extension_ui_response", id: "s", value: "x" });
  // confirm: accept (no answers = approve-button path) -> confirmed true; answers picking "Cancel" -> false; decline -> cancelled
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Delete?", message: "Irreversible" }, { action: "accept" }),
    { type: "extension_ui_response", id: "c1", confirmed: true },
  );
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c2", method: "confirm", title: "Delete?", message: "Irreversible" }, { action: "accept", answers: { "Delete?\nIrreversible": "Cancel" } }),
    { type: "extension_ui_response", id: "c2", confirmed: false },
  );
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c3", method: "confirm", title: "t", message: "m" }, { action: "decline", message: "No" }),
    { type: "extension_ui_response", id: "c3", cancelled: true },
  );
  // confirm defense (fail-closed): non-empty answers missing the question key -> no longer defaults to confirmed true
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "c4", method: "confirm", title: "Delete?", message: "Irreversible" }, { action: "accept", answers: { "some other question": "Confirm" } }),
    { type: "extension_ui_response", id: "c4", confirmed: false },
  );
  // input/editor: answers text -> value; decline -> cancelled
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "i1", method: "input", title: "Session name" }, { action: "accept", answers: { "Session name": "my session" } }),
    { type: "extension_ui_response", id: "i1", value: "my session" },
  );
  assert.deepEqual(
    toExtensionUIResponse({ type: "extension_ui_request", id: "e1", method: "editor", title: "" }, { action: "decline" }),
    { type: "extension_ui_response", id: "e1", cancelled: true },
  );
});

test("toExtensionUIResponse: one-way methods like notify/setWidget -> null (no response needed)", () => {
  assert.equal(
    toExtensionUIResponse({ type: "extension_ui_request", id: "n", method: "notify", message: "hello" }, { action: "accept" }),
    null,
  );
  assert.equal(
    toExtensionUIResponse({ type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "autoresearch" }, { action: "accept" }),
    null,
  );
});