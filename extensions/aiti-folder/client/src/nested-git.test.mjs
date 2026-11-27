/**
 * nested-git.test.mjs — client pure helpers for nested git repos (tests nested-git.ts directly).
 * Run: node --experimental-strip-types --test extensions/aiti-folder/client/src/nested-git.test.mjs
 *
 * Covers: scan cache TTL/force semantics (fetch mocked), statusFromXy classification parity
 * with core classifyGitStatus, nestedStatusRows absolute-path synthesis (incl. ignored skip).
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const { fetchNestedRepos, invalidateNestedRepos, statusFromXy, nestedStatusRows } = await import("./nested-git.ts");

// ── fetch mock (module-level fetch is what nested-git.ts calls) ──
const calls = [];
const fetchMock = mock.method(globalThis, "fetch", async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init?.body || "{}") });
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, repos: [{ path: "/w/repo-a", name: "repo-a" }, { path: "\\w\\repo-b", name: "repo-b" }] }),
  };
});

const api = (p) => "http://local" + p;

test("fetchNestedRepos: caches results and normalizes separators", async () => {
  invalidateNestedRepos();
  const first = await fetchNestedRepos(api, "/w");
  assert.deepEqual(first, ["/w/repo-a", "/w/repo-b"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.dir, "/w");
  const second = await fetchNestedRepos(api, "\\w"); // same dir, other separator → cache hit
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1, "cache must absorb the second call");
});

test("fetchNestedRepos: force bypasses the cache", async () => {
  await fetchNestedRepos(api, "/w", { force: true });
  assert.equal(calls.length, 2);
  fetchMock.mock.restore();
});

test("statusFromXy: classification parity with core classifyGitStatus", () => {
  assert.equal(statusFromXy("??").status, "untracked");
  assert.equal(statusFromXy("!!"), null, "ignored entries are not surfaced");
  assert.equal(statusFromXy("UU").status, "conflict");
  assert.equal(statusFromXy("AU").status, "conflict");
  assert.equal(statusFromXy(" D").status, "deleted");
  assert.equal(statusFromXy("R ").status, "renamed");
  assert.equal(statusFromXy("A ").status, "added");
  assert.equal(statusFromXy("M ").status, "modified");
  assert.equal(statusFromXy(" M").status, "modified");
  assert.equal(statusFromXy("MM").status, "modified");
});

test("nestedStatusRows: synthesizes absolute rows, skips ignored, guards empty inputs", () => {
  const rows = nestedStatusRows("/w/repo-a", [
    { xy: "M ", path: "src/app.ts" },
    { xy: "??", path: "notes.md" },
    { xy: "!!", path: "ignored.log" },
    { xy: "??", path: "" }, // guarded
  ]);
  assert.deepEqual(rows.map((r) => r.filePath), ["/w/repo-a/src/app.ts", "/w/repo-a/notes.md"]);
  assert.deepEqual(rows.map((r) => r.status), ["modified", "untracked"]);
  assert.deepEqual(rows.map((r) => r.code), ["M", "U"]);
  assert.equal(nestedStatusRows("", [{ xy: "M ", path: "x" }]).length, 0);
  assert.equal(nestedStatusRows("/w", undefined).length, 0);
});
