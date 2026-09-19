// Static + behavior coverage for the session detail API's tail bound (the #509/#555
// transfer fix). Mirrors runtime-route.test.mjs: source assertions confirm the route
// parses ?tail (default 50, NaN-safe, capped at 1000) and feeds only the sliced chain
// to buildSessionContext. The data-slicing behavior itself is covered end-to-end in
// lib/session-reader.pagination.test.mjs (sliceActiveBranch + buildSessionContext).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const routeSrc = await readFileSync(new URL("./[id]/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { buildSessionContext, cacheSessionPath, invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");
const { GET: getSessionDetail } = await jiti.import("./[id]/route.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("detail route parses ?tail: default 50, NaN-safe, capped at 1000", () => {
  assert.match(routeSrc, /const rawTail = Number\(searchParams\.get\("tail"\)\)/);
  assert.match(routeSrc, /Math\.min\(rawTail, 1000\)/);
  assert.match(routeSrc, /Number\.isFinite\(rawTail\) && rawTail > 0 \? Math\.min\(rawTail, 1000\) : 50/);
  assert.match(routeSrc, /buildSessionContext\(entries as never, leafId, \{[^}]*tail,[^}]*sessionId: id[^}]*\}\)/);
  assert.match(routeSrc, /computeSessionStats\(entries as unknown as SessionEntry\[\]\)/);
  assert.match(routeSrc, /messageCount: stats\.totalMessages/);
  assert.match(routeSrc, /stats,/);
});

test("detail route bounds history to the tail window (default 50 over 5000 entries)", () => {
  const entries = [];
  for (let i = 0; i < 5000; i++) {
    entries.push({
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      type: "message",
      timestamp: new Date(1000 + i * 1000).toISOString(),
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` },
    });
  }
  const ctx = buildSessionContext(entries, "e4999", { tail: 50 });
  assert.equal(ctx.messages.length, 50);
  // The transferred window is the tail, not the full 5000-entry forest.
  assert.equal(ctx.entryIds[0], "e4950");
  assert.equal(ctx.entryIds[ctx.entryIds.length - 1], "e4999");
});

test("detail route with an out-of-range tail still caps at 1000", () => {
  const entries = [];
  for (let i = 0; i < 5000; i++) {
    entries.push({ id: `e${i}`, parentId: i === 0 ? null : `e${i - 1}`, type: "message", timestamp: new Date(1000 + i * 1000).toISOString(), message: { role: "user", content: `m${i}` } });
  }
  const ctx = buildSessionContext(entries, "e4999", { tail: 5000 });
  assert.equal(ctx.messages.length, 5000);
});

test("detail route ?fresh=1 recycles an idle rpc wrapper before reading disk", () => {
  assert.match(routeSrc, /const fresh = new URL\(req\.url\)\.searchParams\.has\("fresh"\)/);
  assert.match(routeSrc, /if \(fresh\) \{[\s\S]{0,160}?getRpcSession\(id\)/);
  assert.match(routeSrc, /staleRpc\?\.isAlive\(\) && !staleRpc\.isRunning\(\)/);
  assert.match(routeSrc, /await stopIdleRpcSession\(id\)/);
});

test("detail route ?fresh=1 returns disk content when an idle wrapper holds stale memory history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-fresh-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  let sessionId;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    globalThis.__piSessions = previousRegistry;
    if (sessionId) invalidateSessionPathCache(sessionId);
    await rm(dir, { recursive: true, force: true });
  });

  // A real session on disk: two baseline rounds plus one new message appended
  // by an external writer (zcode/another instance).
  const manager = SessionManager.create(dir);
  manager.appendMessage({ role: "user", content: "disk base", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ack" }], timestamp: Date.now() });
  sessionId = manager.getSessionId();
  const filePath = manager.getSessionFile();
  assert.ok(filePath && existsSync(filePath), "session file must be flushed");
  cacheSessionPath(sessionId, filePath);

  const external = SessionManager.open(filePath);
  external.appendMessage({ role: "user", content: "external advance from another client", timestamp: Date.now() });
  const externalLeaf = external.getLeafId();
  assert.ok(externalLeaf);

  // The idle wrapper's in-memory sessionManager is stuck before the external
  // advance — a plain GET would serve this stale history.
  const memoryEntry = {
    type: "message",
    id: "mem-stale-1",
    parentId: null,
    timestamp: new Date(1000).toISOString(),
    message: { role: "user", content: "memory-only stale content" },
  };
  let shutdownCalls = 0;
  globalThis.__piSessions = new Map([[sessionId, {
    isAlive: () => shutdownCalls === 0,
    isRunning: () => false,
    shutdown: async () => {
      shutdownCalls += 1;
      globalThis.__piSessions.delete(sessionId);
    },
    inner: {
      sessionManager: {
        getEntries: () => [memoryEntry],
        getLeafId: () => memoryEntry.id,
        getTree: () => [],
        getSessionName: () => undefined,
        getHeader: () => ({ type: "session", id: sessionId, cwd: dir, timestamp: memoryEntry.timestamp }),
        getSessionFile: () => filePath,
      },
    },
    sessionFile: filePath,
    sessionId,
    cwd: dir,
  }]]);

  const url = `http://localhost/api/sessions/${sessionId}`;
  const context = { params: Promise.resolve({ id: sessionId }) };

  const stale = await (await getSessionDetail(new Request(url), context)).json();
  assert.equal(stale.leafId, memoryEntry.id, "plain GET serves the wrapper memory");
  assert.equal(shutdownCalls, 0, "plain GET must not touch the wrapper");

  const fresh = await (await getSessionDetail(new Request(`${url}?fresh=1`), context)).json();
  assert.equal(shutdownCalls, 1, "?fresh=1 recycles the idle wrapper once");
  assert.equal(fresh.leafId, externalLeaf, "?fresh=1 must serve the on-disk leaf");
  assert.ok(
    fresh.context.messages.some((m) => typeof m.content === "string" && m.content.includes("external advance")),
    "?fresh=1 must include the externally appended message",
  );
});
