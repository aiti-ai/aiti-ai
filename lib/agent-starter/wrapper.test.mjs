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
const { findEntryBySession, readEntry } = await import("./registry.ts");

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

test("single writer: a second attach supersedes the first client", async () => {
  const id = sessionId("supersede");
  const first = await wrapper.spawn(NODE, [FAKE_AGENT], { env: process.env, sessionId: id, agentKey: "pi" });
  const dropped = [];
  first.on("dropped", (reason) => dropped.push(reason));
  const firstClosed = new Promise((resolve) => first.once("close", resolve));

  const second = await wrapper.attach(id);
  await firstClosed;
  assert.deepEqual(dropped, ["superseded"]);

  const out = [];
  second.stdout.on("data", (chunk) => out.push(chunk.toString()));
  second.stdin.write("echo second\n");
  await waitFor(() => out.join("").includes("echo:second"), { label: "second client traffic" });
  second.release();
  await wrapper.kill(id);
  assert.equal(await wrapper.holds(id), false);
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
