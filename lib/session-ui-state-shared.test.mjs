import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  MAX_SESSION_UI_IDS_PER_REQUEST,
  SESSION_ID_PATTERN,
  applySessionUiStateRequest,
  chunkForSessionUiRequests,
  emptySessionUiState,
  normalizeSessionUiState,
  parseSessionUiStateRequest,
  snapshotSessionUiFlags,
} = await jiti.import("./session-ui-state-shared.ts");

const source = await readFile(new URL("./session-ui-state-shared.ts", import.meta.url), "utf8");
const readerSource = await readFile(new URL("./session-reader.ts", import.meta.url), "utf8");

const state = (sessions = {}, projects = {}, revision = 3) => ({ version: 1, revision, sessions, projects });
const parse = (body) => parseSessionUiStateRequest(body);
const request = (body) => {
  const result = parse(body);
  assert.equal(result.ok, true, result.error);
  return result.request;
};

test("is client-safe and uses the session id rule of the session reader", () => {
  assert.doesNotMatch(source, /from "node:|from "(fs|path|os|crypto)"|require\(/);
  assert.doesNotMatch(source, /\(\?<[=!]/, "no RegExp lookbehind (Safari 16.2)");
  const readerPattern = readerSource.match(/const SESSION_ID_PATTERN = (\/.*\/);/)?.[1];
  assert.equal(String(SESSION_ID_PATTERN), readerPattern);
});

test("empty state is fresh every call", () => {
  const a = emptySessionUiState();
  a.sessions.x = { pinnedAt: 1 };
  assert.deepEqual(emptySessionUiState(), { version: 1, revision: 0, sessions: {}, projects: {} });
});

test("normalize keeps valid entries and drops malformed ones", () => {
  const normalized = normalizeSessionUiState({
    version: 1,
    revision: 7,
    extra: { kept: "by the server, not here" },
    sessions: {
      "a-1": { pinnedAt: 10, color: "red" },
      b: { archivedAt: 20 },
      c: { pinnedAt: "soon" },
      d: { pinnedAt: -1, archivedAt: Number.POSITIVE_INFINITY },
      e: null,
      "-bad": { pinnedAt: 1 },
      "bad/slash": { pinnedAt: 1 },
      f: { pinnedAt: 5, archivedAt: 6 },
    },
    projects: {
      "/repo": { pinnedAt: 1, root: "/repo" },
      "/no-root": { pinnedAt: 1 },
      "/bad-time": { pinnedAt: "x", root: "/bad-time" },
      "": { pinnedAt: 1, root: "/empty-key" },
      "/long-root": { pinnedAt: 1, root: "x".repeat(4097) },
    },
  });
  assert.deepEqual(normalized, {
    version: 1,
    revision: 7,
    sessions: { "a-1": { pinnedAt: 10 }, b: { archivedAt: 20 }, f: { pinnedAt: 5, archivedAt: 6 } },
    projects: { "/repo": { pinnedAt: 1, root: "/repo" } },
  });
});

test("normalize fills missing parts and rejects an unusable root shape", () => {
  assert.deepEqual(normalizeSessionUiState({}), emptySessionUiState());
  assert.deepEqual(normalizeSessionUiState({ revision: -1 }), emptySessionUiState());
  assert.deepEqual(normalizeSessionUiState({ revision: 1.5 }), emptySessionUiState());
  for (const value of [null, undefined, 1, "x", [], { version: 2 }, { version: "1" }, { sessions: [] }, { projects: "x" }, { sessions: null }]) {
    assert.equal(normalizeSessionUiState(value), null, JSON.stringify(value));
  }
});

test("normalize never sets a prototype from a __proto__ key", () => {
  const normalized = normalizeSessionUiState(JSON.parse('{"projects":{"__proto__":{"pinnedAt":1,"root":"/x"}},"sessions":{"__proto__":{"pinnedAt":1}}}'));
  assert.equal(Object.getPrototypeOf(normalized.projects), Object.prototype);
  assert.deepEqual(Object.keys(normalized.projects), []);
  assert.deepEqual(Object.keys(normalized.sessions), []);
});

test("parse accepts the three actions and dedupes ids", () => {
  assert.deepEqual(request({ action: "set", ids: ["a", "b", "a"], pinned: true, extra: 1 }), { action: "set", ids: ["a", "b"], pinned: true });
  assert.deepEqual(request({ action: "set", ids: ["a"], archived: false }), { action: "set", ids: ["a"], archived: false });
  assert.deepEqual(
    request({ action: "restore", entries: [{ id: "a", pinnedAt: null, archivedAt: 5, extra: true }, { id: "b", pinnedAt: 1, archivedAt: null }] }),
    { action: "restore", entries: [{ id: "a", pinnedAt: null, archivedAt: 5 }, { id: "b", pinnedAt: 1, archivedAt: null }] },
  );
  assert.deepEqual(request({ action: "restore", entries: [] }), { action: "restore", entries: [] });
  assert.deepEqual(
    request({ action: "pin-project", projectKey: "/repo", root: "/repo", pinned: true }),
    { action: "pin-project", projectKey: "/repo", root: "/repo", pinned: true },
  );
});

test("parse refuses malformed bodies", () => {
  const ids = (count) => Array.from({ length: count }, (_, index) => `id-${index}`);
  assert.equal(parse({ action: "set", ids: ids(MAX_SESSION_UI_IDS_PER_REQUEST), pinned: true }).ok, true);
  const refused = [
    null,
    [],
    "set",
    {},
    { action: "nope" },
    { action: "set", ids: ["a"] },
    { action: "set", ids: ["a"], pinned: true, archived: true },
    { action: "set", ids: ["a"], pinned: "yes" },
    { action: "set", ids: [], pinned: true },
    { action: "set", ids: "a", pinned: true },
    { action: "set", ids: ["../a"], pinned: true },
    { action: "set", ids: [""], pinned: true },
    { action: "set", ids: [1], pinned: true },
    { action: "set", ids: ids(MAX_SESSION_UI_IDS_PER_REQUEST + 1), pinned: true },
    { action: "restore" },
    { action: "restore", entries: [{ id: "a", pinnedAt: null }] },
    { action: "restore", entries: [{ id: "a", pinnedAt: "1", archivedAt: null }] },
    { action: "restore", entries: [{ id: "a", pinnedAt: -1, archivedAt: null }] },
    { action: "restore", entries: [{ id: "a", pinnedAt: null, archivedAt: null }, { id: "a", pinnedAt: 1, archivedAt: null }] },
    { action: "restore", entries: [{ id: "bad id", pinnedAt: null, archivedAt: null }] },
    { action: "pin-project", projectKey: "", root: "/r", pinned: true },
    { action: "pin-project", projectKey: "/r", root: "", pinned: true },
    { action: "pin-project", projectKey: "/r", root: "/r" },
    { action: "pin-project", projectKey: "__proto__", root: "/r", pinned: true },
    { action: "pin-project", projectKey: "x".repeat(4097), root: "/r", pinned: true },
  ];
  for (const body of refused) {
    const result = parse(body);
    assert.equal(result.ok, false, JSON.stringify(body)?.slice(0, 120));
    assert.equal(typeof result.error, "string");
  }
});

test("pin and archive exclude each other", () => {
  const start = state({ a: { archivedAt: 100 }, b: { pinnedAt: 50 } });
  const pinned = applySessionUiStateRequest(start, request({ action: "set", ids: ["a", "b"], pinned: true }), 200);
  assert.equal(pinned.changed, true);
  assert.deepEqual(pinned.state.sessions, { a: { pinnedAt: 200 }, b: { pinnedAt: 50 } }, "already pinned keeps its time");
  assert.equal(pinned.state.revision, 3, "revision is the server's to bump");

  const archived = applySessionUiStateRequest(pinned.state, request({ action: "set", ids: ["a"], archived: true }), 300);
  assert.deepEqual(archived.state.sessions, { a: { archivedAt: 300 }, b: { pinnedAt: 50 } });

  const again = applySessionUiStateRequest(archived.state, request({ action: "set", ids: ["a"], archived: true }), 400);
  assert.equal(again.changed, true, "re-archiving refreshes the time");
  assert.deepEqual(again.state.sessions.a, { archivedAt: 400 });

  const repinBoth = applySessionUiStateRequest(state({ a: { pinnedAt: 1, archivedAt: 2 } }), request({ action: "set", ids: ["a"], pinned: true }), 9);
  assert.equal(repinBoth.changed, true);
  assert.deepEqual(repinBoth.state.sessions.a, { pinnedAt: 9 });
});

test("clearing a flag removes it and drops empty entries", () => {
  const start = state({ a: { pinnedAt: 1 }, b: { archivedAt: 2 } });
  const unpinned = applySessionUiStateRequest(start, request({ action: "set", ids: ["a", "missing"], pinned: false }), 10);
  assert.equal(unpinned.changed, true);
  assert.deepEqual(unpinned.state.sessions, { b: { archivedAt: 2 } });
  const unarchived = applySessionUiStateRequest(unpinned.state, request({ action: "set", ids: ["b"], archived: false }), 10);
  assert.deepEqual(unarchived.state.sessions, {});
  const noop = applySessionUiStateRequest(unarchived.state, request({ action: "set", ids: ["b"], archived: false }), 10);
  assert.equal(noop.changed, false);
  const notArchived = applySessionUiStateRequest(state({ a: { pinnedAt: 1 } }), request({ action: "set", ids: ["a"], archived: false }), 10);
  assert.equal(notArchived.changed, false);
  assert.deepEqual(notArchived.state.sessions, { a: { pinnedAt: 1 } });
});

test("never mutates its input", () => {
  const start = state({ a: { pinnedAt: 1 } }, { "/r": { pinnedAt: 1, root: "/r" } });
  const frozen = JSON.stringify(start);
  const result = applySessionUiStateRequest(start, request({ action: "set", ids: ["a"], archived: true }), 5);
  applySessionUiStateRequest(start, request({ action: "pin-project", projectKey: "/r", root: "/r", pinned: false }), 5);
  applySessionUiStateRequest(start, request({ action: "restore", entries: [{ id: "a", pinnedAt: null, archivedAt: null }] }), 5);
  assert.equal(JSON.stringify(start), frozen);
  assert.notEqual(result.state.sessions, start.sessions);
  const unchanged = applySessionUiStateRequest(start, request({ action: "set", ids: ["a"], pinned: true }), 5);
  assert.equal(unchanged.changed, false);
  assert.notEqual(unchanged.state, start, "a new object even when nothing changed");
});

test("restore writes back the exact prior values and undoes an archive", () => {
  const start = state({ a: { pinnedAt: 1 }, c: { archivedAt: 3 } });
  const snapshot = snapshotSessionUiFlags(start, ["a", "b", "c", "a"]);
  assert.deepEqual(snapshot, [
    { id: "a", pinnedAt: 1, archivedAt: null },
    { id: "b", pinnedAt: null, archivedAt: null },
    { id: "c", pinnedAt: null, archivedAt: 3 },
  ]);
  const archived = applySessionUiStateRequest(start, request({ action: "set", ids: ["a", "b", "c"], archived: true }), 50);
  assert.deepEqual(archived.state.sessions, { a: { archivedAt: 50 }, b: { archivedAt: 50 }, c: { archivedAt: 50 } });
  const restored = applySessionUiStateRequest(archived.state, request({ action: "restore", entries: snapshot }), 60);
  assert.equal(restored.changed, true);
  assert.deepEqual(restored.state.sessions, start.sessions);
  const again = applySessionUiStateRequest(restored.state, request({ action: "restore", entries: snapshot }), 70);
  assert.equal(again.changed, false);
  assert.deepEqual(snapshotSessionUiFlags(start, ["constructor"]), [{ id: "constructor", pinnedAt: null, archivedAt: null }]);
});

test("pin-project pins with its root and unpins", () => {
  const pinned = applySessionUiStateRequest(state(), request({ action: "pin-project", projectKey: "/r", root: "/r", pinned: true }), 10);
  assert.equal(pinned.changed, true);
  assert.deepEqual(pinned.state.projects, { "/r": { pinnedAt: 10, root: "/r" } });
  const same = applySessionUiStateRequest(pinned.state, request({ action: "pin-project", projectKey: "/r", root: "/r", pinned: true }), 20);
  assert.equal(same.changed, false);
  assert.deepEqual(same.state.projects["/r"], { pinnedAt: 10, root: "/r" });
  const moved = applySessionUiStateRequest(pinned.state, request({ action: "pin-project", projectKey: "/r", root: "/R", pinned: true }), 30);
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.state.projects["/r"], { pinnedAt: 30, root: "/R" });
  const unpinned = applySessionUiStateRequest(moved.state, request({ action: "pin-project", projectKey: "/r", root: "/R", pinned: false }), 40);
  assert.equal(unpinned.changed, true);
  assert.deepEqual(unpinned.state.projects, {});
  const noop = applySessionUiStateRequest(unpinned.state, request({ action: "pin-project", projectKey: "/r", root: "/R", pinned: false }), 50);
  assert.equal(noop.changed, false);
  const toString = applySessionUiStateRequest(state(), request({ action: "pin-project", projectKey: "toString", root: "/t", pinned: false }), 1);
  assert.equal(toString.changed, false, "inherited names are not entries");
});

test("a change to more families than one request carries is split into accepted requests, in order", () => {
  const ids = Array.from({ length: 2 * MAX_SESSION_UI_IDS_PER_REQUEST + 1 }, (_, index) => `s${index}`);
  // One request with every id is refused, so it must never be sent.
  assert.equal(parse({ action: "set", ids, archived: true }).ok, false);

  const chunks = chunkForSessionUiRequests(ids);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [MAX_SESSION_UI_IDS_PER_REQUEST, MAX_SESSION_UI_IDS_PER_REQUEST, 1]);
  assert.deepEqual(chunks.flat(), ids, "every id once, in order");
  let archived = state({}, {}, 0);
  for (const chunk of chunks) {
    archived = applySessionUiStateRequest(archived, request({ action: "set", ids: chunk, archived: true }), 7).state;
  }
  assert.equal(Object.keys(archived.sessions).length, ids.length);

  // Its Undo restores in parts the same way.
  const snapshot = snapshotSessionUiFlags(state(), ids);
  let restored = archived;
  for (const entries of chunkForSessionUiRequests(snapshot)) {
    restored = applySessionUiStateRequest(restored, request({ action: "restore", entries }), 8).state;
  }
  assert.deepEqual(restored.sessions, {});

  assert.deepEqual(chunkForSessionUiRequests([]), []);
  assert.deepEqual(chunkForSessionUiRequests(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  assert.deepEqual(chunkForSessionUiRequests(["a", "b"], 0), [["a"], ["b"]], "a size below one still makes progress");
});
