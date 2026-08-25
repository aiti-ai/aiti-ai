import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./[id]/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  // TUI 占用标记经扩展协商（sessionAnnotations slot），核心不读注册表文件
  assert.match(listRoute, /dispatchSessionAnnotations\(sessions\)/);
  assert.match(listRoute, /getHandleSessionInfos\(\)/);
  // TUI-bridged sessions are marked in the merged list (agent badge)
  assert.match(listRoute, /readBridgeRegistry/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("session reads use the live SessionManager before requiring a JSONL path", () => {
  for (const source of [detailRoute, contextRoute]) {
    // Live lookups precede the file-based fallback:
    //   local registry (getRpcSession) and — in detail/state routes, where the
    //   TUI single-writer rule applies — bridge attachment by path
    //   (attachIfBridged; TUI owns the file so a stale wrapper yields to it)
    //   plus provider handles (resolveAnySession).
    assert.ok(source.includes("getRpcSession(id)"));
    assert.match(source, /liveRpc\?\.inner\.sessionManager \?\? SessionManager\.open/);
  }
  // The detail route additionally honors TUI ownership and provider handles.
  assert.match(detailRoute, /attachIfBridged\(/);
  assert.match(detailRoute, /resolveAnySession\(id\)/);
});

test("live agent state is available before the session file is persisted", () => {
  // Live sources (local registry / TUI bridge / provider handles) must all be
  // consulted before falling back to a JSONL path.
  assert.ok(stateRoute.includes("getRpcSession(id)"));
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
  assert.match(stateRoute, /resolveAnySession\(id\)/);
  assert.match(stateRoute, /attachIfBridged\(/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });
});
