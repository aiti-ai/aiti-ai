/**
 * aiti-zcode-agent detachable hosting (agent-starter wrapper) regression tests.
 *
 * Adoption contract (mirrors qoder-detach.test.mjs): after a pi-web restart the core

 * attaches the live process via the registry and createSession({attached}) adopts it —
 * create/resume/subscribe never re-run (the session and its subscription are alive in

 * the old process); the journal replay is byte-budget gated (history segment suppresses
 * emits and only advances mirrors; once drained it flips to live).

 * Also covers agentStarter pass-through on the spawn path and dispose's release (never kill) semantics.

 *
 * Run: node --test pi-web-ext/aiti-zcode-agent/zcode-detach.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = mkdtempSync(join(tmpdir(), "zcode-detach-"));
process.env.EXT_MODEL_STATE_DIR = join(ROOT, "ext-model-state");

const { ZcodeAppServerConnection, AppServerSession } = await import("./zcode-appserver.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fake wrapper facade (SocketChild surface): EventEmitter + PassThrough stdio + detachable. */
function fakeFacade(journalLines = []) {
  const journal = journalLines.map((l) => JSON.stringify(l) + "\n").join("");
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.exitCode = null;
  child.detachable = true;
  child.replayBytes = Buffer.byteLength(journal);
  child.released = false;
  child.killed = false;
  child.release = () => { child.released = true; };
  child.kill = () => { child.killed = true; };
  // Journal replay bytes go into the buffer first (PassThrough only buffers until a consumer wires — same as the real facade)
  if (journal) child.stdout.write(journal);
  child.writes = [];
  child.stdin.on("data", (b) => child.writes.push(b.toString()));
  child.writeLive = (obj) => child.stdout.write(JSON.stringify(obj) + "\n");
  return child;
}

const streamingEvent = (text) => ({
  method: "session/event",
  params: { type: "model.streaming", payload: { kind: "text_delta", delta: text, assistantMessageId: "am1" } },
});
const completedEvent = { method: "session/event", params: { type: "turn.completed", payload: { resultType: "success", tokenCount: 7 } } };

test("adopt: no startup re-run; replay segment suppresses emits; budget drain flips to live (idle session, no agent_start)", async () => {
  const child = fakeFacade([
    streamingEvent("hi"), // replay segment: already persisted, must not re-emit
    completedEvent, // journal already carries the completion → the turn was over at adoption (idle)
  ]);
  const conn = new ZcodeAppServerConnection({
    nodeBin: "node", runtimePath: "stub.cjs", cwd: ROOT, env: {},
    attachedChild: child, replayByteBudget: child.replayBytes,
  });
  const events = [];
  const session = new AppServerSession({
    connection: conn, cwd: ROOT, sessId: "sess_x",
    onEvent: (ev) => events.push(ev),
  });
  await session.beginAdopted();
  assert.equal(session.zcodeSid, "sess_x");
  assert.equal(child.writes.length, 0, "adoption must not send any RPC (no create/resume/subscribe)");
  await sleep(30); // replay bytes delivered + budget drained → endReplay
  assert.equal(session.replayActive(), false, "replay budget consumed → live");
  assert.ok(!events.some((e) => e.type === "message_update"), "replayed streaming deltas must not re-emit");
  assert.ok(!events.some((e) => e.type === "agent_start"), "idle adopt (turn completed pre-restart) fires no agent_start");
  // live segment passes through as usual
  child.writeLive(streamingEvent("live"));
  await sleep(20);
  assert.ok(events.some((e) => e.type === "message_update" && e.assistantMessageEvent?.delta === "live"), "live events flow after the boundary");
  await session.detachDispose();
  assert.equal(child.released, true, "detachDispose releases the facade");
  assert.equal(child.killed, false, "detachDispose must never kill the agent");
});

test("adopt (mid-turn): turnActive spans replay and live settling; resumed agent_start at the boundary", async () => {
  const child = fakeFacade([
    streamingEvent("partial"),
    { method: "session/event", params: { type: "tool.updated", payload: { kind: "started", toolCallId: "t1", toolName: "Bash" } } },
    { method: "session/event", params: { type: "turn.steerQueued", payload: { pendingInputId: "st1", input: "go on" } } },
    // no turn.completed in the journal → the turn is still running at adoption
  ]);
  const conn = new ZcodeAppServerConnection({
    nodeBin: "node", runtimePath: "stub.cjs", cwd: ROOT, env: {},
    attachedChild: child, replayByteBudget: child.replayBytes,
  });
  const events = [];
  const steers = [];
  let sessionRef = null;
  let replayDuringFlush = null;
  const session = new AppServerSession({
    connection: conn, cwd: ROOT, sessId: "sess_x",
    onEvent: (ev) => events.push(ev),
    onSteerQueue: (items) => {
      steers.push(items);
      if (replayDuringFlush === null && sessionRef) replayDuringFlush = sessionRef.replayActive();
    },
  });
  sessionRef = session;
  await session.beginAdopted();
  await sleep(30); // replay bytes delivered (buffer flush is async) → activity frames register turnActive → budget drained, endReplay
  assert.equal(session.turnActive, true, "journal shows activity without completion → turn still running");
  assert.ok(events.some((e) => e.type === "agent_start" && e.resumed === true), "resumed agent_start at the boundary");
  assert.equal(replayDuringFlush, true, "steer final-state flush runs while replayActive() is still true (the handle suppresses bubbles for replayed steers)");
  assert.deepEqual(steers.at(-1)?.map((s) => s.pendingInputId), ["st1"], "steer mirror flushed once at the boundary");
  // Adopted-turn abort path: session/stop goes straight through (allowed without waiters); not awaited —

  // the stub never answers and waiting 5s for the RPC timeout is pure waste; assert the write only.

  void session.stop();
  await sleep(10);
  assert.ok(child.writes.some((w) => w.includes("session/stop")), "stop() on an adopted turn sends session/stop");
  // live settle
  child.writeLive(completedEvent);
  await sleep(20);
  assert.equal(session.turnActive, false, "live turn.completed settles the adopted turn");
  assert.ok(events.some((e) => e.type === "agent_settled"), "agent_settled reaches the frontend after live completion");
  await session.detachDispose();
  assert.equal(child.released, true);
});

test("adopt (pending interaction in the replay): interaction_request card re-emitted after the budget drains", async () => {
  const child = fakeFacade([
    // reverse request with an id: dispatch goes through the reverse handler → pending (emit gated during replay)
    { id: 99, method: "interaction/requestUserInput", params: { requestId: "rq1", toolName: "AskUserQuestion", questions: [{ question: "Q?", options: [{ label: "a" }] }] } },
  ]);
  const conn = new ZcodeAppServerConnection({
    nodeBin: "node", runtimePath: "stub.cjs", cwd: ROOT, env: {},
    attachedChild: child, replayByteBudget: child.replayBytes,
  });
  const events = [];
  const session = new AppServerSession({
    connection: conn, cwd: ROOT, sessId: "sess_x",
    onEvent: (ev) => events.push(ev),
  });
  await session.beginAdopted();
  await sleep(30);
  assert.ok(events.some((e) => e.type === "interaction_request" && e.requestId === "rq1"), "pending interaction re-emitted at the boundary");
  // Answer written back (a replayed request is still answerable — exactly what this
  // feature exists to preserve: approvals that were pending before the restart)
  const answered = session.respondInteraction("rq1", { action: "accept", answers: { "Q?": "a" } });
  assert.equal(answered, true);
  await sleep(10);
  assert.ok(child.writes.some((w) => w.includes('"id":99')), "answer frame written back to the agent (replayed request id)");
  await session.detachDispose();
});

test("adopt (plain facade, no replay budget): straight to live", async () => {
  const child = fakeFacade([]);
  child.replayBytes = 0;
  const conn = new ZcodeAppServerConnection({
    nodeBin: "node", runtimePath: "stub.cjs", cwd: ROOT, env: {},
    attachedChild: child,
  });
  const session = new AppServerSession({ connection: conn, cwd: ROOT, sessId: "sess_x", onEvent: () => {} });
  await session.beginAdopted();
  assert.equal(session.replayActive(), false, "no budget → straight to live");
  assert.equal(session.turnActive, false);
  await session.detachDispose();
  assert.equal(child.released, true);
});

test("spawn path: agentStarter pass-through (command/args/registryKey/agentKey)", async () => {
  const spawned = [];
  const conn = new ZcodeAppServerConnection({
    nodeBin: "node", runtimePath: "stub.cjs", cwd: ROOT, env: { FOO: "1" },
    agentStarter: {
      kind: "wrapper",
      spawn: async (command, args, options) => {
        spawned.push({ command, args, options });
        return fakeFacade([]);
      },
    },
    registryKey: "sess_x",
  });
  await conn.start();
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.sessionId, "sess_x", "registry key = native sid");
  assert.equal(spawned[0].options.agentKey, "zcode");
  assert.ok(spawned[0].args.includes("app-server"), "app-server subcommand in driver args");
  assert.ok(spawned[0].args.includes("stub.cjs"));
  conn.clearAdopted(); // harmless: idempotent on non-adopt connections too
});

// ---- handle level (index.ts): core recovery-path glue + dispose release ----

const stubPath = join(ROOT, "runtime-stub.cjs");
let registered;

test.before(async () => {
  mkdirSync(ROOT, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(stubPath, "// runtime stub\n");
  process.env.AITI_ZCODE_HOME = join(ROOT, "zhome"); // readZcodeSessionUpdatedMs watermark source
  globalThis.__piWebExt = {
    featureValue: (_extId, fid) =>
      fid === "zcode.transport" ? "app-server"
        : fid === "zcode.runtimePath" ? stubPath
          : fid === "zcode.apiKeyOverride" ? "stub.key"
            : fid === "zcode.mode" ? "build"
              : fid === "zcode.model" ? "bigmodel/GLM-5.3"
                : fid === "zcode.autoDownload" ? false
                  : "",
  };
  const m = await import("./index.ts");
  await m.default.server.startup({
    configDir: join(ROOT, "ext-data"),
    sessionProviders: { register: (p) => { registered = p; return "k"; } },
  });
});

test.after(async () => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

test("handle adopt: id rebind, adopted-turn isRunning, live settling, dispose releases without killing", async () => {
  assert.equal(registered.detachable, true, "provider opts in to detachable hosting (app-server transport)");
  const child = fakeFacade([
    streamingEvent("mid-turn"),
    { method: "session/event", params: { type: "tool.updated", payload: { kind: "started", toolCallId: "t1", toolName: "Read" } } },
  ]);
  const handle = await registered.createSession({
    sessionId: "sess_x",
    cwd: ROOT,
    attached: { child, sessionId: "sess_x", agentKey: "zcode" },
  });
  assert.equal(handle.id, "zcode:sess_x", "handle id uses the adopted native sid");
  const events = [];
  handle.subscribe((e) => events.push(e.type));
  await sleep(200); // reattachNow: runtime resolution + wiring + replay consumption
  assert.equal(handle.isRunning(), true, "adopted mid-turn session reports running");
  assert.ok(events.includes("agent_start"), "resumed agent_start reaches the handle listeners");
  child.writeLive(completedEvent);
  await sleep(50);
  assert.equal(handle.isRunning(), false, "live completion settles the handle");
  await handle.dispose();
  assert.equal(child.released, true, "dispose releases the wrapper-hosted process");
  assert.equal(child.killed, false, "dispose must never SIGTERM a wrapper-hosted agent");
});

test("adopt window reconcile: watermark anchored at seed time + rebuild from the store after the turn settles", async () => {
  // fake zcode home: db.sqlite with a session row (time_updated = the external-write watermark)
  const zhome = join(ROOT, "zhome", "cli", "db");
  mkdirSync(zhome, { recursive: true });
  const dbPath = join(zhome, "db.sqlite");
  const T1 = Date.now() - 60_000;
  const T2 = Date.now();
  {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER)");
    db.prepare("INSERT INTO session (id, time_updated) VALUES (?, ?)").run("sess_x", T1);
    db.close();
  }
  // parseSession stub: 5 messages at createSession time (the seed); after the db watermark
  // advances, 8 messages (including the content suppressed by the replay gate)
  let parsed = { meta: { cwd: ROOT, model: "bigmodel/GLM-5.3" }, messages: Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "m" + i })) };
  const prevById = globalThis.__piWebExt.byId;
  globalThis.__piWebExt.byId = (id) => {
    if (id === "session-manager") {
      return { ext: { services: { sessions: { parseSession: async () => parsed } } } };
    }
    return prevById ? prevById(id) : undefined;
  };

  const child = fakeFacade([
    streamingEvent("suppressed-window"),
    { method: "session/event", params: { type: "tool.updated", payload: { kind: "started", toolCallId: "t9", toolName: "Read" } } },
  ]);
  const handle = await registered.createSession({
    sessionId: "sess_x",
    cwd: ROOT,
    attached: { child, sessionId: "sess_x", agentKey: "zcode" },
  });
  await sleep(200); // reattachNow + replay consumption
  assert.equal((await handle.getMessages()).length, 5, "seeded from the db snapshot at adoption");

  // the replay-suppressed window content lands in the store: advance the watermark + grow the source messages
  {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(T2, "sess_x");
    db.close();
  }
  parsed = { ...parsed, messages: parsed.messages.concat(Array.from({ length: 3 }, (_, i) => ({ role: "assistant", text: "w" + i }))) };

  // live completion -> agent_settled -> reconcile: rev(T2) > anchor(T1) -> rebuild from the store
  child.writeLive(completedEvent);
  await sleep(150);
  const msgs = await handle.getMessages();
  assert.equal(msgs.length, 8, "the replay-suppressed window is reconciled from the store after the turn settles");
  globalThis.__piWebExt.byId = prevById;
  await handle.dispose();
});
