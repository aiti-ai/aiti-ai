/**
 * aiti-acp-agent — multi-writer peer-sync unit tests.
 *
 * The wrapper now serves N concurrent writers (multi-attach): other writers'
 * stdin arrives mirrored (ch4) and the journal replays past stdin (ch0), both
 * into facade.peerStdin. These tests pin the handle-side contract:
 *   1. a peer session/prompt materializes the user bubble, marks the remote
 *      turn, and isRunning() reports true (UI stop button works);
 *   2. a local prompt during a remote turn queues (no concurrent session/prompt);
 *   3. the mirrored response settles the remote turn and drains the queue;
 *   4. replayed prompts (loading window) are history only — no remote turn;
 *   5. a peer's permission answer settles the local card (no double hang);
 *   6. peer set_mode aligns the local mode mirror;
 *   7. abort during a peer turn cancels it (with the no-answer fallback);
 *   8. remote streaming chunks accumulate and settle flushes the assistant entry;
 *   9. markDead clears remote-turn state.
 *
 * Run: node --experimental-strip-types --test extensions/aiti-acp-agent/peer-sync.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { AcpHandle } = await import("./index.ts");

/** Bare handle without a spawned process (private state injected, test-only). */
function makeHandle() {
  const h = new AcpHandle("devin", "/bin/true", [], "devin");
  const written = [];
  const events = [];
  h.aliveFlag = true;
  h.id = "devin:test-session";
  h.child = { stdin: { write: (s) => { written.push(s); return true; }, writable: true } };
  h.subscribe((e) => events.push(e));
  return { h, written, events };
}

const peerPromptLine = (id, text) => JSON.stringify({
  jsonrpc: "2.0",
  method: "session/prompt",
  id,
  params: { sessionId: "test-session", prompt: [{ type: "text", text }] },
});

const settledOf = (events) => events.filter((e) => e.type === "agent_settled");

function waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      Promise.resolve(value).then((settled) => {
        if (settled) {
          resolve(settled);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`timeout waiting for ${label}`));
          return;
        }
        setTimeout(tick, 10);
      });
    };
    tick();
  });
}

test("peer session/prompt mirror → user bubble + remote turn + isRunning true", () => {
  const { h, events } = makeHandle();
  h.onPeerLine(peerPromptLine(41, "hello from peer"));
  assert.equal(h.remoteTurnId, 41);
  assert.equal(h.isRunning(), true);
  assert.deepEqual(h.liveHistory.at(-1), { role: "user", content: "hello from peer" });
  const ends = events.filter((e) => e.type === "message_end");
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0].message, { role: "user", content: "hello from peer" });
});

test("local prompt during a remote turn queues (no concurrent session/prompt)", async () => {
  const { h, written } = makeHandle();
  h.onPeerLine(peerPromptLine(7, "peer runs"));
  await h.prompt("queued locally");
  assert.deepEqual(written, [], "nothing may reach the agent while the peer turn runs");
  assert.equal(h.q.snapshot().followUp.length, 1);
});

test("mirrored response settles the remote turn and drains the queue", async () => {
  const { h, written, events } = makeHandle();
  h.onPeerLine(peerPromptLine(7, "peer runs"));
  const p = h.prompt("queued locally");

  h.onPeerLine(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { stopReason: "end_turn" } }));
  assert.equal(h.remoteTurnId, null);
  assert.equal(h.isRunning(), false);
  assert.equal(settledOf(events).length, 1);
  assert.equal(settledOf(events)[0].stopReason, "end_turn");

  await p;
  // The drained local turn dispatches a real session/prompt through rpc()
  // (fake stdin carries `writable: true`); answer it so the turn settles.
  await waitFor(() => written.some((s) => s.includes("session/prompt")), { label: "queued prompt dispatched" });
  const line = written.find((s) => s.includes("session/prompt"));
  const rpcId = JSON.parse(line).id;
  h.onLine(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: { stopReason: "end_turn" } }));
  await p;
  assert.equal(settledOf(events).length, 2, "local turn settled after dispatch");
});

test("replayed prompts (loading window) are history only — no remote turn", () => {
  const { h, events } = makeHandle();
  h.loading = true;
  h.onPeerLine(peerPromptLine(9, "replayed prompt"));
  assert.equal(h.remoteTurnId, null);
  assert.equal(h.isRunning(), false);
  assert.deepEqual(h.liveHistory.at(-1), { role: "user", content: "replayed prompt" });
  assert.equal(events.filter((e) => e.type === "message_end").length, 0, "history stays silent");
});

test("peer permission answer settles the local card", () => {
  const { h, events } = makeHandle();
  h.permissionRequests.set("9", {
    allowOpt: { kind: "allow_once", optionId: "a1" },
    rawId: 9,
    toolName: "Bash",
    input: { command: "ls" },
    rawOptions: [{ kind: "allow_once", optionId: "a1" }, { kind: "reject_once", optionId: "d1" }],
  });
  h.onPeerLine(JSON.stringify({ jsonrpc: "2.0", id: 9, result: { outcome: { outcome: "selected", optionId: "a1" } } }));
  assert.equal(h.permissionRequests.size, 0);
  assert.ok(events.some((e) => e.type === "permission_expired" && e.requestId === "9"));
  const card = events.find((e) => e.type === "message_end" && e.message?.customType === "工具授权");
  assert.ok(card, "decision recorded in the message stream");
  assert.match(String(card.message.content), /已人工允许/);
});

test("peer set_mode mirror aligns the local mode", () => {
  const { h, events } = makeHandle();
  h.currentModeId = "default";
  h.onPeerLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/set_mode",
    params: { sessionId: "test-session", modeId: "yolo" },
  }));
  assert.equal(h.currentModeId, "yolo");
  assert.ok(events.some((e) => e.type === "permission_mode_changed" && e.mode === "yolo"));
});

test("abort during a peer turn writes cancel and force-settles on fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { h, written, events } = makeHandle();
  h.onPeerLine(peerPromptLine(5, "peer runs"));
  await h.abort();
  assert.match(written.at(-1), /"method":"session\/cancel"/);
  assert.equal(h.isRunning(), true, "waiting for the agent's cancelled result");

  t.mock.timers.tick(6_000);
  assert.equal(h.isRunning(), false);
  assert.equal(settledOf(events).at(-1).stopReason, "aborted");
});

test("remote streaming accumulates; settle flushes the assistant entry", () => {
  const { h, events } = makeHandle();
  h.onPeerLine(peerPromptLine(3, "peer runs"));
  h.onLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "streamed" } } },
  }));
  assert.equal(events.some((e) => e.type === "message_update" && e.delta === "streamed"), true);
  h.onPeerLine(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }));
  assert.equal(h.isRunning(), false);
  const last = h.liveHistory.at(-1);
  assert.equal(last.role, "assistant");
  assert.equal(last.content[0].text, "streamed");
  assert.equal(last.model, undefined === h.model?.id ? undefined : h.model?.id ?? undefined);
});

test("peer images convert into the history content-block shape", () => {
  const { h } = makeHandle();
  h.onPeerLine(JSON.stringify({
    jsonrpc: "2.0",
    method: "session/prompt",
    id: 77,
    params: {
      sessionId: "test-session",
      prompt: [
        { type: "text", text: "look at " },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    },
  }));
  assert.deepEqual(h.liveHistory.at(-1), {
    role: "user",
    content: [
      { type: "text", text: "look at " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ],
  });
});

test("markDead clears remote-turn state (no zombie queue gating)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { h, events } = makeHandle();
  h.onPeerLine(peerPromptLine(2, "peer runs"));
  assert.equal(h.isRunning(), true);
  h.markDead("process exited (1)");
  assert.equal(h.isRunning(), false);
  assert.equal(h.remoteTurnId, null);
  assert.equal(settledOf(events).at(-1).stopReason, "error");
});

test("peer response arrives via stdout (onLine) and settles the remote turn", () => {
  const { h, events } = makeHandle();
  h.onPeerLine(peerPromptLine(88, "peer runs"));
  assert.equal(h.remoteTurnId, 88);
  // The agent's response is broadcast on stdout: onLine sees a response whose id
  // is not in this handle's pending map — it must settle the remote turn.
  h.onLine(JSON.stringify({ jsonrpc: "2.0", id: 88, result: { stopReason: "end_turn" } }));
  assert.equal(h.remoteTurnId, null);
  assert.equal(settledOf(events).at(-1).stopReason, "end_turn");
});

test("a peer response for an unknown id does not disturb the handle", () => {
  const { h, events } = makeHandle();
  h.onLine(JSON.stringify({ jsonrpc: "2.0", id: 999999, result: { stopReason: "end_turn" } }));
  assert.equal(h.remoteTurnId, null);
  assert.equal(settledOf(events).length, 0);
});
