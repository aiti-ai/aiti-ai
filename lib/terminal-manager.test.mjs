import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createTerminal, getTerminalCwd, hasTerminal, killTerminal, subscribeTerminal, TERMINAL_RECONNECT_MS } = await jiti.import("./terminal-manager.ts");
const { GET } = await jiti.import("../app/api/terminal/[id]/events/route.ts");
const { GET: bufferedGET } = await jiti.import("../app/api/terminal/[id]/buffered/route.ts");
const agentPageEvents = await jiti.import("./agent-page-events.ts");

test("native module load failures are deferred until creation and include repair instructions", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const exports = {};
  runInNewContext(outputText, { exports, process, require(id) {
    if (id === "node-pty") throw new Error("Cannot find module pty.node");
    if (id === "./agent-page-events") return agentPageEvents;
    return id === "./paths" ? paths : require(id);
  } });
  assert.equal(exports.hasTerminal("missing"), false);
  assert.throws(() => exports.createTerminal(process.cwd(), 80, 24), (error) => {
    assert.match(error.message, /native terminal module/);
    assert.match(error.message, /npm rebuild node-pty --build-from-source --ignore-scripts=false --foreground-scripts/);
    assert.match(error.message, /Cannot find module pty.node/);
    return true;
  });
});

test("shell environment defaults to UTF-8 locale when the host has none", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./paths") return paths;
    if (id === "./agent-page-events") return agentPageEvents;
    return require(id);
  };
  const envWithoutLocale = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["LANG", "LC_ALL", "LC_CTYPE"].includes(k)));
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env: envWithoutLocale, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.LANG, "C.UTF-8");
});

test("shell environment preserves a case-insensitive Windows locale", async () => {
  const require = createRequire(import.meta.url);
  const paths = await jiti.import("./paths.ts");
  const source = readFileSync(new URL("./terminal-manager.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const spawnCalls = [];
  const fakePty = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
  const fakeRequire = (id) => {
    if (id === "node-pty") return { spawn: (...args) => { spawnCalls.push(args); return fakePty; } };
    if (id === "./paths") return paths;
    if (id === "./agent-page-events") return agentPageEvents;
    return require(id);
  };
  const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["lang", "lc_all", "lc_ctype"].includes(key.toLowerCase())));
  rawEnv.lang = "zh_CN.UTF-8";
  const envWithLocale = new Proxy(rawEnv, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const match = Object.keys(target).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      return match ? target[match] : undefined;
    },
  });
  const exports = {};
  runInNewContext(outputText, { exports, process: { ...process, env: envWithLocale, once() {}, platform: process.platform }, require: fakeRequire, setTimeout, clearTimeout, console });
  exports.createTerminal(process.cwd(), 80, 24);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][2].env.lang, "zh_CN.UTF-8");
  assert.equal("LANG" in spawnCalls[0][2].env, false);
});

test("native PTY starts after install and repeated creation reuses the same workspace process", (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  assert.ok(record.pty.pid > 0);
  assert.equal(getTerminalCwd(id), process.cwd());
  assert.equal(createTerminal(process.cwd(), 100, 30, id), id);
  assert.strictEqual(globalThis.__piWebTerminals.get(id), record);
  assert.throws(() => createTerminal(process.cwd() + "/other", 80, 24, id), /different workspace/);
  assert.ok(record.cleanupTimer, "unclaimed creations have a lease");
});

test("connected terminals outlive the grace period; only the last disconnect starts expiry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const first = subscribeTerminal(id, () => {});
  const second = subscribeTerminal(id, () => {});
  first.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS * 2);
  assert.ok(hasTerminal(id));
  second.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS - 1);
  assert.ok(hasTerminal(id));
  const resumed = subscribeTerminal(id, () => {});
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.ok(hasTerminal(id));
  resumed.unsubscribe();
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("unclaimed creations expire without requiring a browser cleanup request", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});

test("SSE resumes from Last-Event-ID and cancellation releases the connection lease", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "old\r\nnew\r\n";
  record.offset = record.backlog.length;
  const request = new Request("http://localhost/events?after=0", { headers: { "Last-Event-ID": "5" } });
  const response = await GET(request, { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  const replay = new TextDecoder().decode((await reader.read()).value);
  assert.match(replay, /id: 10\n/);
  assert.deepEqual(JSON.parse(replay.split("data: ")[1]), { type: "output", data: "new\r\n", offset: 10, reset: false });
  await reader.cancel();
  assert.equal(record.listeners.size, 0);
  assert.ok(record.cleanupTimer);
});

test("expired output cursors reset bounded history, while explicit close ends connected streams", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "tail";
  record.offset = 100;
  const subscription = subscribeTerminal(id, () => {}, 10);
  assert.deepEqual(subscription.output, { type: "output", data: "tail", offset: 100, reset: true });
  subscription.unsubscribe();
  const response = await GET(new Request("http://localhost/events"), { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  killTerminal(id);
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"closed"/);
  assert.equal((await reader.read()).done, true);
  assert.equal(record.listeners.size, 0);
  assert.equal(hasTerminal(id), false);
});

test("bus snapshot endpoint serves the bounded snapshot and re-arms the lease", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.backlog = "snap-tail";
  record.offset = 900;
  const response = await bufferedGET(new Request("http://localhost/buffered?after=890"), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    output: { type: "output", data: "snap-tail", offset: 900, reset: true },
    exited: false,
    exitCode: null,
  });
  assert.ok(record.cleanupTimer, "subscribe+unsubscribe must re-arm the grace period");
  const missing = await bufferedGET(new Request("http://localhost/buffered"), { params: Promise.resolve({ id: "0".repeat(32) }) });
  assert.equal(missing.status, 404);
});

test("slow consumers are dropped once their response queue fills", async (t) => {
  const id = createTerminal(process.cwd(), 200, 50);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  // Hold the reader without reading: the readable stream queue only accumulates, and once the
  // 256 KiB highWaterMark is exceeded send must kick the consumer off
  const response = await GET(new Request("http://localhost/events"), { params: Promise.resolve({ id }) });
  const reader = response.body.getReader();
  assert.equal(record.listeners.size, 1, "subscriber attached");
  record.pty.write("head -c 400000 /dev/urandom | base64\r");
  for (let i = 0; i < 200 && record.listeners.size > 0; i++) {
    await delay(50);
  }
  assert.equal(record.listeners.size, 0, "queue full → slow consumer disconnected");
  await reader.cancel().catch(() => { /* stream may already be closed */ });
});

test("backlog is bounded to 128 KiB UTF-16 units with a consistent cursor window", async (t) => {
  const id = createTerminal(process.cwd(), 120, 40);
  t.after(() => killTerminal(id));
  const record = globalThis.__piWebTerminals.get(id);
  record.pty.write("head -c 200000 /dev/urandom | base64\r");
  for (let i = 0; i < 200 && record.offset < 200 * 1024; i++) {
    await delay(50);
  }
  assert.ok(record.offset >= 200 * 1024, "shell should have produced more than 128 KiB of output");
  assert.equal(record.backlog.length, 128 * 1024, "backlog keeps at most 128 KiB of UTF-16 code units");
  const start = record.offset - record.backlog.length;
  const within = subscribeTerminal(id, () => {}, start);
  assert.equal(within.output.reset, false, "cursor at the retention edge resumes without a reset");
  assert.equal(within.output.offset, record.offset);
  within.unsubscribe();
  const older = subscribeTerminal(id, () => {}, start - 1);
  assert.equal(older.output.reset, true, "cursor older than retention triggers a reset replay");
  older.unsubscribe();
});

test("termination escalates to SIGKILL when the shell traps SIGHUP", async (t) => {
  const id = createTerminal(process.cwd(), 80, 24);
  const record = globalThis.__piWebTerminals.get(id);
  const pid = record.pty.pid;
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The handshake must rely on bash's **execution output**, not input echo: the tty echoes the
  // command line itself immediately (including the word TRAP), which does not prove the trap is
  // installed. The $((6*7)) result can only appear in execution output.
  record.pty.write("trap '' HUP; echo \"__TRAP_OK_$((6*7))__\"\n");
  for (let i = 0; i < 100 && !/TRAP_OK_42/.test(record.backlog); i++) {
    await delay(50);
  }
  assert.match(record.backlog, /TRAP_OK_42/, "trap in place before termination");
  assert.ok(alive(), "shell should be running before termination");
  assert.ok(killTerminal(id), "explicit termination");
  assert.equal(hasTerminal(id), false, "the record leaves the registry immediately");
  await delay(600);
  assert.ok(alive(), "a shell trapping SIGHUP survives the first signal");
  await delay(2200);
  assert.equal(alive(), false, "SIGKILL escalation two seconds later finishes the shell");
});

test("a shell exit retains the record for the grace period, then expires unobserved", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const id = createTerminal(process.cwd(), 80, 24);
  const record = globalThis.__piWebTerminals.get(id);
  record.pty.write("exit\r");
  for (let i = 0; i < 100 && !record.exited; i++) {
    await delay(50);
  }
  assert.ok(record.exited, "shell exited");
  assert.ok(hasTerminal(id), "the record is retained so late subscribers see output and exit code");
  assert.ok(record.cleanupTimer, "an unobserved exit schedules the same grace period");
  t.mock.timers.tick(TERMINAL_RECONNECT_MS);
  assert.equal(hasTerminal(id), false);
});
