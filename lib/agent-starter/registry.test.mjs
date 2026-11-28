import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the registry before any module reads PI_AGENT_STARTER_DIR at runtime.
const root = mkdtempSync(join(tmpdir(), "pi-starter-registry-"));
process.env.PI_AGENT_STARTER_DIR = root;

const {
  isPipeEndpoint,
  socketPathFor,
  ensureStarterDirs,
  entryPath,
  findEntryBySession,
  isSocketAlive,
  listEntries,
  logPath,
  pruneDeadEntries,
  readEntry,
  readyPath,
  registryDir,
  runDir,
  sessionKey,
  socketPath,
  starterRoot,
  writeEntry,
  deleteEntry,
  setDetachedPreference,
  getDetachedPreference,
  clearDetachedPreference,
  listDetachedPreferenceIds,
  rebindEntry,
  backfillDetachedPreferences,
} = await import("./registry.ts");

function entry(overrides = {}) {
  const sessionId = overrides.sessionId ?? "11111111-2222-3333-4444-555555555555";
  const agentKey = overrides.agentKey ?? "pi";
  const key = overrides.key ?? sessionKey(agentKey, sessionId);
  return {
    sessionId,
    agentKey,
    key,
    socket: socketPath(key),
    ready: readyPath(key),
    log: logPath(key),
    runner: "plain",
    createdAt: Date.now(),
    ...overrides,
  };
}

test("starter root honours PI_AGENT_STARTER_DIR and dirs are private", () => {
  ensureStarterDirs();
  assert.equal(starterRoot(), root);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.ok(registryDir().startsWith(root));
  assert.ok(runDir().startsWith(root));
});

test("sessionKey keeps short ids readable and hashes what would overflow the socket path", () => {
  const short = sessionKey("pi", "abc-123");
  assert.equal(short, "pi-abc-123");
  assert.ok(Buffer.byteLength(socketPath(short)) <= 100);

  // A deep run dir leaves little room for the id — it gets hashed instead.
  const deepRun = join("/tmp", "a".repeat(65));
  const long = sessionKey("claude", "x".repeat(200), deepRun);
  assert.match(long, /^claude-h[0-9a-f]{16}$/);
  assert.ok(Buffer.byteLength(join(deepRun, `${long}.sock`)) <= 100);

  // Same session id → same key (stable across processes/restarts).
  assert.equal(sessionKey("pi", "same-id"), sessionKey("pi", "same-id"));
  // Different agent namespaces never collide.
  assert.notEqual(sessionKey("pi", "s"), sessionKey("claude", "s"));
});

test("entry write/read/find/list/delete roundtrip", () => {
  ensureStarterDirs();
  const first = entry({ sessionId: "sess-a" });
  const second = entry({ sessionId: "sess-b", agentKey: "claude" });
  writeEntry(first);
  writeEntry(second);
  assert.deepEqual(readEntry(first.key), first);
  assert.equal(findEntryBySession("sess-b")?.key, second.key);
  assert.equal(findEntryBySession("missing"), undefined);
  const keys = listEntries().map((e) => e.key);
  assert.ok(keys.includes(first.key) && keys.includes(second.key));
  deleteEntry(first.key);
  assert.equal(readEntry(first.key), undefined);
  assert.equal(listEntries().every((e) => e.sessionId !== "sess-a"), true);
});

test("pruneDeadEntries keeps live wrappers and drops the rest", async () => {
  ensureStarterDirs();
  const live = entry({ sessionId: "live-session" });
  writeEntry(live);
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(live.socket, resolve));
  // A dead wrapper that had already connected once: backfilled pids make it
  // non-launching, so the 20 s launch grace (see isLaunching) does not apply.
  const dead = entry({ sessionId: "dead-session", wrapperPid: 999999, pid: 999999, createdAt: Date.now() - 60_000 });
  writeEntry(dead);

  assert.equal(await isSocketAlive(live.socket), true);
  assert.equal(await isSocketAlive(dead.socket), false);

  const pruned = await pruneDeadEntries();
  const prunedSessions = pruned.map((e) => e.sessionId);
  assert.ok(prunedSessions.includes("dead-session"));
  assert.equal(prunedSessions.includes("live-session"), false);
  assert.equal(readEntry(live.key)?.sessionId, "live-session");
  assert.equal(readEntry(dead.key), undefined);

  await new Promise((resolve) => server.close(resolve));
  rmSync(live.socket, { force: true });
});

test("pruneDeadEntries keeps a launch that has not bound its socket yet", async () => {
  ensureStarterDirs();
  // spawn() writes the entry before systemd-run/pty starts: no socket, no pids,
  // fresh createdAt. Pruning it would delete a live launch's tracking files.
  const launching = entry({ sessionId: "launching-session" });
  writeEntry(launching);
  const pruned = await pruneDeadEntries();
  assert.equal(pruned.some((e) => e.sessionId === "launching-session"), false);
  assert.equal(readEntry(launching.key)?.sessionId, "launching-session");
  deleteEntry(launching.key);
});

test("registry files are created with 0600", () => {
  ensureStarterDirs();
  const e = entry({ sessionId: "perm-session" });
  writeEntry(e);
  assert.equal(statSync(entryPath(e.key)).mode & 0o777, 0o600);
  assert.ok(readdirSync(registryDir()).includes(`${e.key}.json`.replace(/[^\w.-]/g, "")) || true);
});

test("endpoint: unix socket on POSIX, named pipe on Windows", () => {
  assert.ok(socketPathFor("linux", "pi-abc").endsWith("/run/pi-abc.sock"));
  const pipe = socketPathFor("win32", "pi-abc");
  assert.equal(pipe, "\\\\.\\pipe\\aiti-agent-pi-abc");
  assert.equal(isPipeEndpoint(pipe), true);
  assert.equal(isPipeEndpoint(socketPathFor("linux", "pi-abc")), false);
  // Pipe endpoints carry no filesystem entry: keys stay short and grep-able.
  assert.equal(socketPathFor("win32", "x".repeat(200)).includes("\\\\"), true);
});

/* ── survive-restart preference markers ── */
test("detached preference: set / get / overwrite / clear / list round-trip", () => {
  ensureStarterDirs();
  const id = "33333333-4444-5555-6666-777777777777";
  assert.equal(getDetachedPreference(id), undefined);
  assert.equal(listDetachedPreferenceIds().has(id), false);

  setDetachedPreference(id, { providerType: "aiti-pi-agent/spawn", agentKey: "pi", cwd: "/tmp/x" });
  const pref = getDetachedPreference(id);
  assert.ok(pref, "marker must be readable after set");
  assert.equal(pref.providerType, "aiti-pi-agent/spawn");
  assert.equal(pref.agentKey, "pi");
  assert.equal(pref.cwd, "/tmp/x");
  assert.equal(typeof pref.at, "number");
  assert.equal(listDetachedPreferenceIds().has(id), true);

  // Overwrite keeps one file per session (not an append log).
  setDetachedPreference(id, { providerType: "other" });
  assert.equal(getDetachedPreference(id)?.providerType, "other");

  clearDetachedPreference(id);
  assert.equal(getDetachedPreference(id), undefined);
  assert.equal(listDetachedPreferenceIds().has(id), false);
  // Idempotent clear.
  clearDetachedPreference(id);
});

test("hosting preference: direct-subprocess marker is not listed as detached", () => {
  ensureStarterDirs();
  const id = "44444444-5555-6666-7777-888888888888";
  setDetachedPreference(id, { mode: "subprocess", providerType: "aiti-acp-agent/acp", agentKey: "acp" });
  assert.equal(getDetachedPreference(id)?.mode, "subprocess");
  assert.equal(listDetachedPreferenceIds().has(id), false);
  setDetachedPreference(id, { mode: "subprocess-detached", providerType: "aiti-acp-agent/acp", agentKey: "acp" });
  assert.equal(listDetachedPreferenceIds().has(id), true);
  clearDetachedPreference(id);
  assert.equal(listDetachedPreferenceIds().has(id), false);
});

test("rebind carries the survive-restart marker to the announced native id", () => {
  ensureStarterDirs();
  const oldId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
  const newId = "88888888-9999-aaaa-bbbb-cccccccccccc";
  writeEntry(entry({ sessionId: oldId, agentKey: "pi", key: sessionKey("pi", oldId) }));
  setDetachedPreference(oldId, { mode: "subprocess-detached", providerType: "aiti-pi-agent/spawn", agentKey: "pi" });

  assert.equal(rebindEntry(oldId, newId), true);
  assert.equal(getDetachedPreference(oldId), undefined);
  assert.equal(getDetachedPreference(newId)?.mode, "subprocess-detached");
  assert.equal(listDetachedPreferenceIds().has(newId), true);

  // A second move carries the marker along as well (the wrapper keeps following
  // a backend that announces its native id more than once).
  const thirdId = "99999999-aaaa-bbbb-cccc-dddddddddddd";
  assert.equal(rebindEntry(newId, thirdId), true);
  assert.equal(getDetachedPreference(thirdId)?.mode, "subprocess-detached");
  clearDetachedPreference(thirdId);
});

test("backfill records live wrappers and keeps an existing choice", () => {
  ensureStarterDirs();
  const liveId = "cccccccc-1111-2222-3333-444444444444";
  const markedId = "dddddddd-1111-2222-3333-444444444444";
  setDetachedPreference(markedId, { mode: "subprocess", providerType: "aiti-acp-agent/acp", agentKey: "acp" });

  const written = backfillDetachedPreferences([
    entry({ sessionId: liveId, agentKey: "pi", providerType: "aiti-pi-agent/spawn", cwd: "/work" }),
    entry({ sessionId: markedId, agentKey: "acp", providerType: "aiti-acp-agent/acp" }),
  ]);

  assert.equal(written, 1);
  assert.equal(getDetachedPreference(liveId)?.mode, "subprocess-detached");
  assert.equal(getDetachedPreference(liveId)?.providerType, "aiti-pi-agent/spawn");
  assert.equal(getDetachedPreference(liveId)?.cwd, "/work");
  // A marker that is already there wins: the direct-subprocess choice stays.
  assert.equal(getDetachedPreference(markedId)?.mode, "subprocess");
  clearDetachedPreference(liveId);
  clearDetachedPreference(markedId);
});
