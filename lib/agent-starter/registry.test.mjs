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
  const dead = entry({ sessionId: "dead-session" });
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

test("registry files are created with 0600", () => {
  ensureStarterDirs();
  const e = entry({ sessionId: "perm-session" });
  writeEntry(e);
  assert.equal(statSync(entryPath(e.key)).mode & 0o777, 0o600);
  assert.ok(readdirSync(registryDir()).includes(`${e.key}.json`.replace(/[^\w.-]/g, "")) || true);
});
