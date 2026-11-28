import assert from "node:assert/strict";
import test from "node:test";
import { spawn as spawnNode } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "pi-starter-wrapper-"));
process.env.PI_AGENT_STARTER_DIR = root;
process.env.PI_AGENT_STARTER_RUNNER = "plain";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-agent.mjs");
const NODE = process.execPath;

const { LinuxMacWrapperStarter } = await import("./wrapper.ts");
const { DirectStarter } = await import("./direct.ts");
const { findEntryBySession, readEntry, probeEndpoint, getDetachedPreference } = await import("./registry.ts");

const runnerEnv = {};
const wrapper = new LinuxMacWrapperStarter({ runner: "plain", runnerEnv, nodePath: NODE });

let seq = 0;
function sessionId(tag) {
  seq += 1;
  return `${tag}-${process.pid}-${seq}`;
}

/** Wait until the predicate holds, driven by events (bounded timeout). */
function waitFor(predicate, { timeoutMs = 10000, label = "condition" } = {}) {
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
      setTimeout(tick, 15);
      });
    };
    tick();
  });
}

/** Drive one session over a child (direct or wrapper) and record its transcript. */
function drive(child, lines) {
  const transcript = { stdout: [], stderr: [], events: [] };
  child.stdout.on("data", (chunk) => transcript.stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => transcript.stderr.push(chunk.toString()));
  child.on("exit", (code, signal) => transcript.events.push(["exit", code, signal]));
  child.on("close", (code, signal) => transcript.events.push(["close", code, signal]));
  const done = new Promise((resolve) => child.once("close", resolve));
  for (const line of lines) child.stdin.write(`${line}\n`);
  return { transcript, done };
}

const SCRIPT = ["echo one", "err boom", "env PI_STARTER_PROBE", "lines 3", "exit 4"];

test("conformance: direct spawn and wrapper spawn produce the same wire transcript", async () => {
  const env = { ...process.env, PI_STARTER_PROBE: "probe-value" };
  const direct = new DirectStarter();
  const directChild = await direct.spawn(NODE, [FAKE_AGENT], { env });
  const directRun = drive(directChild, SCRIPT);
  await directRun.done;

  const id = sessionId("conform");
  const wrappedChild = await wrapper.spawn(NODE, [FAKE_AGENT], { env, sessionId: id, agentKey: "pi", cwd: process.cwd() });
  const wrappedRun = drive(wrappedChild, SCRIPT);
  await wrappedRun.done;

  // Same bytes, same event order; only the exit timing may differ.
  assert.equal(wrappedRun.transcript.stdout.join(""), directRun.transcript.stdout.join(""));
  assert.equal(wrappedRun.transcript.stderr.join(""), directRun.transcript.stderr.join(""));
  assert.deepEqual(wrappedRun.transcript.events, directRun.transcript.events);
  assert.equal(wrappedRun.transcript.stdout.join("").includes("env:PI_STARTER_PROBE=probe-value"), true);
  assert.equal(wrappedRun.transcript.stderr.join("").includes("err:boom"), true);
  assert.equal(directChild.exitCode, 4);
  assert.equal(wrappedChild.exitCode, 4);
  // The facade reports the AGENT pid (hello frame), not the wrapper's.
  assert.equal(typeof wrappedChild.pid, "number");
});

test("detach + attach replays the journal and keeps the agent alive across releases", async () => {
  const id = sessionId("reattach");
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi", cwd: process.cwd() });
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk.toString()));
  child.stdin.write("echo before-detach\n");
  await waitFor(() => out.join("").includes("echo:before-detach"), { label: "first echo" });

  // Detach: pi-web "goes away" — the agent must survive.
  child.release();
  assert.equal(await wrapper.holds(id), true);

  // Reattach: the journal replays everything that happened so far.
  const reattached = await wrapper.attach(id);
  const replay = [];
  reattached.stdout.on("data", (chunk) => replay.push(chunk.toString()));
  await waitFor(() => replay.join("").includes("echo:before-detach"), { label: "journal replay" });
  assert.equal(replay.join("").includes("READY"), true);

  // Live traffic still flows through the new connection.
  reattached.stdin.write("echo after-attach\n");
  await waitFor(() => replay.join("").includes("echo:after-attach"), { label: "post-attach echo" });
  const exited = new Promise((resolve) => reattached.once("exit", (code, signal) => resolve({ code, signal })));
  reattached.stdin.write("exit 0\n");
  assert.deepEqual(await exited, { code: 0, signal: null });
  // The exit frame reaches us before the wrapper finishes its own cleanup, so
  // the registry probe settles a moment later (bounded wait, no polling loop).
  await waitFor(async () => !(await wrapper.holds(id)), { label: "wrapper cleanup" }).catch(() => {});
  assert.equal(await wrapper.holds(id), false);
});

test("multi-writer: a second attach co-attaches (no supersede), mirrors stdin, broadcasts output", async () => {
  const id = sessionId("multi");
  const first = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const out1 = [];
  const peer1 = [];
  first.stdout.on("data", (chunk) => out1.push(chunk.toString()));
  first.peerStdin.on("data", (chunk) => peer1.push(chunk.toString()));
  const dropped = [];
  first.on("dropped", (reason) => dropped.push(reason));
  await waitFor(() => out1.join("").includes("READY"), { label: "first client ready" });

  // A second instance opens the same session: no supersede, both drive the agent.
  const second = await wrapper.attach(id);
  const out2 = [];
  const peer2 = [];
  second.stdout.on("data", (chunk) => out2.push(chunk.toString()));
  second.peerStdin.on("data", (chunk) => peer2.push(chunk.toString()));
  await waitFor(() => out2.join("").includes("READY"), { label: "second client replay" });

  // The second writer's stdin reaches the agent and both writers' stdout...
  second.stdin.write("echo from-second\n");
  await waitFor(() => out1.join("").includes("echo:from-second") && out2.join("").includes("echo:from-second"), { label: "broadcast echo" });
  // ...and is mirrored as peer stdin to the FIRST writer only (no self-echo).
  await waitFor(() => peer1.join("").includes("echo from-second"), { label: "ch4 mirror" });
  assert.equal(peer2.join("").includes("echo from-second"), false, "the origin must not see its own mirror");

  first.stdin.write("echo from-first\n");
  await waitFor(() =>
    out1.join("").includes("echo:from-first")
    && out2.join("").includes("echo:from-first")
    && peer2.join("").includes("echo from-first"), { label: "reverse mirror" });
  assert.equal(peer1.join("").includes("echo from-first"), false);
  assert.deepEqual(dropped, [], "multi-writer: nobody is superseded");

  // The agent survives the first client leaving; the second keeps driving.
  first.release();
  second.stdin.write("echo after-first-left\n");
  await waitFor(() => out2.join("").includes("echo:after-first-left"), { label: "solo continue" });
  const exited = new Promise((resolve) => second.once("exit", (code, signal) => resolve({ code, signal })));
  second.stdin.write("exit 0\n");
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("stdin is journaled: an attach replays peer prompts (user-message history)", async () => {
  const id = sessionId("stdinjournal");
  const first = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const out1 = [];
  first.stdout.on("data", (chunk) => out1.push(chunk.toString()));
  first.stdin.write("echo prompt-one\n");
  await waitFor(() => out1.join("").includes("echo:prompt-one"), { label: "first prompt" });
  first.release();

  // The replay now carries the stdin direction: the past user prompt (this is
  // what fixes the adopt-replay-missing-user-message incident, D3).
  const second = await wrapper.attach(id);
  const peer2 = [];
  second.peerStdin.on("data", (chunk) => peer2.push(chunk.toString()));
  await waitFor(() => peer2.join("").includes("echo prompt-one"), { label: "stdin journal replay" });
  const exited = new Promise((resolve) => second.once("exit", (code, signal) => resolve({ code, signal })));
  second.stdin.write("exit 0\n");
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("peers control frames: hello.writers at join + live count changes", async () => {
  const id = sessionId("peers");
  const first = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const counts1 = [];
  first.on("peers", (count) => counts1.push(count));

  const second = await wrapper.attach(id);
  // The joiner sees the joined count through hello.writers (no event yet).
  assert.equal(second.writers, 2);
  // The incumbent receives the live broadcast.
  await waitFor(() => counts1.includes(2), { label: "peers broadcast on join" });

  // Leaving drops the count back; the survivor stays connected.
  const closed2 = new Promise((resolve) => second.once("close", resolve));
  second.release();
  await closed2;
  await waitFor(() => counts1.includes(1), { label: "peers broadcast on leave" });

  const exited = new Promise((resolve) => first.once("exit", (code, signal) => resolve({ code, signal })));
  first.stdin.write("exit 0\n");
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test("a liveness probe never supersedes the attached client (live event feed survives)", async () => {
  // 2026-11-23: registry.probeEndpoint connected and dropped; the wrapper treated
  // every connection as a client, superseded the live one, and the page's event
  // stream went blind (queue_update frames never arrived; a reload was the only
  // cure). A probe must be a no-op for the current client.
  const id = sessionId("probe");
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const dropped = [];
  child.on("dropped", (reason) => dropped.push(reason));
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk.toString()));
  child.stdin.write("echo before-probe\n");
  await waitFor(() => out.join("").includes("echo:before-probe"), { label: "pre-probe echo" });

  const entry = findEntryBySession(id);
  assert.ok(entry?.socket, "wrapper registry entry carries the socket path");
  assert.equal(await probeEndpoint(entry.socket), "alive");
  // Let the identify grace pass: the probe socket closed, so nothing may promote.
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.deepEqual(dropped, [], "a liveness probe must not supersede the live client");

  child.stdin.write("echo after-probe\n");
  await waitFor(() => out.join("").includes("echo:after-probe"), { label: "post-probe echo" });
  child.release();
  await wrapper.kill(id);
});

test("concurrent spawns of one session share one launch (no duplicate wrapper)", async () => {
  const id = sessionId("concurrent");
  const settled = await Promise.allSettled([
    wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" }),
    wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" }),
  ]);
  const wins = settled.filter((r) => r.status === "fulfilled");
  const losses = settled.filter((r) => r.status === "rejected");
  assert.equal(wins.length, 1, "exactly one launch may own the session");
  assert.equal(losses.length, 1);
  assert.match(String(losses[0].reason), /already hosted/);
  assert.equal(await wrapper.holds(id), true, "the winner is registered and reachable");

  const child = wins[0].value;
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.stdin.write("exit 0\n");
  const result = await exited;
  assert.equal(result.signal, null);
  assert.ok(result.code === 0 || result.code === null, `unexpected exit code ${result.code}`);
  await waitFor(async () => !(await wrapper.holds(id)), { label: "wrapper cleanup" }).catch(() => {});
  assert.equal(await wrapper.holds(id), false);
});

test("a live wrapper makes a second spawn refuse without unlinking its files", async () => {
  const id = sessionId("busy-entry");
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const entry = findEntryBySession(id);
  assert.ok(entry, "registry entry written by the spawn");
  await assert.rejects(
    () => wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" }),
    /already hosted|did not answer/,
  );
  assert.equal(findEntryBySession(id)?.key, entry.key, "the live entry survives the refused spawn");
  child.stdin.write("exit 0\n");
  await new Promise((resolve) => child.once("exit", resolve));
});

test("kill stops the agent and prunes the entry", async () => {
  const id = sessionId("kill");
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  // Let the agent finish booting (a signal before its listeners exist kills it
  // by default, which would mask what this test checks).
  const seen = [];
  child.stdout.on("data", (chunk) => seen.push(chunk.toString()));
  await waitFor(() => seen.join("").includes("READY"), { label: "agent ready" });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(await wrapper.kill(id), true);
  const result = await exited;
  assert.equal(result.signal, "SIGTERM");
  assert.equal(findEntryBySession(id), undefined);
  assert.equal(await wrapper.kill(id), false);
});

test("spawn failure rejects loudly (ENOENT) and leaves no registry entry", async () => {
  const id = sessionId("missing");
  await assert.rejects(
    () => wrapper.spawn("/nonexistent/agent-binary", [], { env: process.env, sessionId: id, agentKey: "pi" }),
    /agent-starter/,
  );
  assert.equal(findEntryBySession(id), undefined);
});

test("env, cwd, shell and the registry entry survive the spawn", async () => {
  const id = sessionId("env");
  const cwd = mkdtempSync(join(tmpdir(), "pi-starter-cwd-"));
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], {
    env: { ...process.env, PI_STARTER_PROBE: "env-ok" },
    sessionId: id,
    agentKey: "pi",
    cwd,
  });
  const entry = findEntryBySession(id);
  assert.equal(entry.sessionId, id);
  assert.equal(entry.cwd, cwd);
  assert.equal(entry.runner, "plain");
  assert.equal(entry.pid, child.pid);
  assert.equal(typeof entry.wrapperPid, "number");
  assert.equal(entry.wrapperPid === entry.pid, false);

  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk.toString()));
  child.stdin.write("env PI_STARTER_PROBE\ncwd\n");
  await waitFor(() => out.join("").includes("cwd:"), { label: "env/cwd output" });
  assert.equal(out.join("").includes("env:PI_STARTER_PROBE=env-ok"), true);
  assert.equal(out.join("").includes(`cwd:${cwd}`), true);
  child.release();
  await wrapper.kill(id);
  rmSync(cwd, { recursive: true, force: true });
});

test("a detached spawn records the survive-restart preference", async () => {
  const id = sessionId("pref");
  const cwd = mkdtempSync(join(tmpdir(), "pi-starter-pref-"));
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], {
    env: process.env,
    sessionId: id,
    agentKey: "pi",
    owner: "aiti-pi-agent/spawn",
    cwd,
  });
  // Cold opens and the hosting panels read this marker: without it the session
  // silently downgrades to the local runtime on its next open.
  const pref = getDetachedPreference(id);
  assert.equal(pref?.mode, "subprocess-detached");
  assert.equal(pref?.providerType, "aiti-pi-agent/spawn");
  assert.equal(pref?.agentKey, "pi");
  assert.equal(pref?.cwd, cwd);
  child.release();
  await wrapper.kill(id);
  rmSync(cwd, { recursive: true, force: true });
});

test("stderr is mirrored into the per-session log file", async () => {
  const id = sessionId("log");
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const entry = readEntry(findEntryBySession(id).key);
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk.toString()));
  child.stdin.write("echo marker\n");
  await waitFor(() => out.join("").includes("echo:marker"), { label: "marker" });
  child.release();
  await waitFor(() => existsSync(entry.log) && readFileSync(entry.log, "utf8").includes("BOOT"), { label: "log content" });
  await wrapper.kill(id);
});

test("an agent that dies by signal reports the signal (not an exit code)", async () => {
  const id = sessionId("signal");
  const child = await wrapper.spawn(NODE, [FAKE_AGENT, "--ignore-sigterm"], { env: process.env, sessionId: id, agentKey: "pi" });
  const seen = [];
  child.stdout.on("data", (chunk) => seen.push(chunk.toString()));
  await waitFor(() => seen.join("").includes("READY"), { label: "agent ready" });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  // SIGTERM is ignored by the fixture → the wrapper's SIGKILL grace path runs.
  child.kill("SIGTERM");
  const result = await exited;
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
});

test("direct starter matches node spawn argument-for-argument", async () => {
  const direct = new DirectStarter();
  const id = sessionId("direct");
  const child = await direct.spawn(NODE, [FAKE_AGENT], { env: { ...process.env, PI_STARTER_PROBE: "x" } });
  assert.equal("detachable" in child, false);
  const run = drive(child, ["env PI_STARTER_PROBE", "exit 0"]);
  await run.done;
  assert.equal(run.transcript.stdout.join("").includes("env:PI_STARTER_PROBE=x"), true);
  void id;
  void spawnNode;
});

test("journal keeps the tail when output exceeds the ring (4MB)", async () => {
  const id = sessionId("ring");
  const child = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const seen = [];
  child.stdout.on("data", (chunk) => seen.push(chunk.toString()));
  // 5 MB in one line: larger than the journal cap, so the ring keeps only the tail.
  child.stdin.write("big 5000000\n");
  await waitFor(() => seen.join("").length >= 5_000_000, { label: "5MB line", timeoutMs: 20000 });
  child.release();

  const reattached = await wrapper.attach(id);
  const replay = [];
  reattached.stdout.on("data", (chunk) => replay.push(chunk.toString()));
  // Wait past the assertion floor below (3 MiB): stopping at exactly the floor is a
  // race — the chunk that crosses it may land just short of the bound.
  await waitFor(() => replay.join("").length > 3_500_000, { label: "journal replay", timeoutMs: 20000 });
  const bytes = replay.join("").length;
  assert.ok(bytes <= 4 * 1024 * 1024 + 1024, `replay ${bytes} must fit the 4MB ring`);
  assert.ok(bytes > 3 * 1024 * 1024, `replay ${bytes} must be the tail, not nothing`);
  // The tail is the end of the line (the ring dropped the front), so no trailing newline yet.
  assert.equal(replay.join("").includes("READY"), false, "the oldest frames were evicted");
  await wrapper.kill(id);
});

// ---------------------------------------------------------------------------
// Idle reap (wrapper-side lifecycle, PI_WEB_IDLE_TIMEOUT_MS contract)
// ---------------------------------------------------------------------------

const IDLE_MS = 600;

function idleStarter() {
  return new LinuxMacWrapperStarter({ runner: "plain", runnerEnv, nodePath: NODE, idleTimeoutMs: IDLE_MS });
}

test("idle reap: an unattached silent agent is stopped and cleaned up", async () => {
  const reaper = idleStarter();
  const id = sessionId("idlereap");
  const child = await reaper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi", cwd: process.cwd() });
  const pid = child.pid;
  // pi-web goes away: the wrapper arms its idle clock and the silent agent is reaped.
  child.release();
  await waitFor(() => !findEntryBySession(id), { timeoutMs: 10000, label: "entry removed by idle reap" });
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, { timeoutMs: 10000, label: "agent process gone" });
  assert.equal(await reaper.holds(id), false, "no lingering holds after the reap");
});

test("idle reap: output re-arms the timer until the agent goes silent", async () => {
  const reaper = idleStarter();
  const id = sessionId("idlebeat");
  const child = await reaper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi", cwd: process.cwd() });
  // 8 beats 200ms apart (~1.6s of periodic output), then silence: every beat
  // must re-arm the reaper, so the agent outlives 2x the idle timeout.
  child.stdin.write("heartbeat 8 200\n");
  child.release();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.notEqual(findEntryBySession(id), undefined, "beats kept the agent alive past the idle timeout");
  await waitFor(() => !findEntryBySession(id), { timeoutMs: 10000, label: "reaped after the beats went silent" });
});

test("idle reap: an attached client suppresses the reaper; detach starts it", async () => {
  const reaper = idleStarter();
  const id = sessionId("idlehold");
  const child = await reaper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi", cwd: process.cwd() });
  // Far past the idle timeout, but the client is attached: pi-web owns the
  // lifecycle, the wrapper must not reap.
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 2 + 200));
  assert.notEqual(findEntryBySession(id), undefined, "attached client suppresses the reaper");
  const out = [];
  child.stdout.on("data", (chunk) => out.push(chunk.toString()));
  child.stdin.write("echo alive\n");
  await waitFor(() => out.join("").includes("echo:alive"), { label: "agent alive under client" });
  // Now pi-web goes away: the clock starts and the silent agent is reaped.
  child.release();
  await waitFor(() => !findEntryBySession(id), { timeoutMs: 10000, label: "reaped after detach" });
});
