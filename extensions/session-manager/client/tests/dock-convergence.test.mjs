/**
 * Dock convergence: the sidebar dock renders store.projectSessions (the scoped channel),
 * so full-channel-only updates leave sessions created/updated elsewhere invisible until a
 * project switch. Regression for the user report "other qoder sessions are missing until I
 * switch workspace and back".
 *
 * Covers: activity data frames mirroring into the scoped bucket (insert / replace / drop on
 * archive / other-project ignored), and draft promotion splicing the landed row into the
 * scoped bucket instead of letting it blink out of the sidebar.
 *
 * Run: node client/tests/dock-convergence.test.mjs
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const serverRoot = join(here, "..", "..", "server");

const HOST_SHIM_STUB = [
  "export function useState(v) { return [undefined, () => {}]; }",
  "export function useEffect(_f, _d) { /* noop */ }",
  "export function apiUrl(p) { return '/dev' + p; }",
  "export function getExtService() { return undefined; }",
  "export function t(k) { return k; }",
  "export function getLocale() { return 'en'; }",
].join("\n");
const EXT_FLOAT_STUB = [
  "export function present() { return {}; }",
  "export function presentState() { return 'closed'; }",
  "export function openFloat() { /* test stub */ }",
  "export function closePanel() { /* test stub */ }",
].join("\n");

function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-dock-convergence-"));
  const sm = join(dir, "sm");
  const clientSrc = join(sm, "client", "src");
  mkdirSync(join(clientSrc, "sidebar"), { recursive: true });
  writeFileSync(join(clientSrc, "store.ts"), readFileSync(join(srcRoot, "store.ts"), "utf8"));
  writeFileSync(join(clientSrc, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(clientSrc, "sidebar", "pure.ts"), readFileSync(join(srcRoot, "sidebar", "pure.ts"), "utf8"));
  writeFileSync(join(clientSrc, "float-yield.pure.ts"), readFileSync(join(srcRoot, "float-yield.pure.ts"), "utf8"));
  mkdirSync(join(dir, "node_modules", "@aiti-ai", "ext-shared"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "package.json"), JSON.stringify({ name: "@aiti-ai/ext-shared", type: "module" }));
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "ext-float-dock-lite.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "ext-float-dock.ts"), EXT_FLOAT_STUB);
  writeFileSync(join(dir, "node_modules", "@aiti-ai", "ext-shared", "dedupe-fetch.ts"), readFileSync(join(here, "..", "..", "..", "_shared", "dedupe-fetch.ts"), "utf8"));
  mkdirSync(join(sm, "server"), { recursive: true });
  writeFileSync(join(sm, "server", "payload.ts"), readFileSync(join(serverRoot, "payload.ts"), "utf8"));
  return dir;
}

const isoDir = setupIsolation();
const bundleOut = join(isoDir, "bundle", "store.mjs");
await build({
  entryPoints: [join(isoDir, "sm", "client", "src", "store.ts")],
  bundle: true, format: "esm", platform: "node",
  outfile: bundleOut, logLevel: "silent",
});
const mod = await import(pathToFileURL(bundleOut).href + "?" + Date.now());
const { store, refreshSessions, refreshProjectSessions, noteDraftSession, onSessionActivityFrame } = mod;

/* ── server stub: rows carry a win32-shaped projectKey; the scoped view filters by key ── */
const PROJECT_RAW = "D:\\Workspace\\Proj";
const PROJECT_KEY = "d:/workspace/proj";
const OTHER_RAW = "E:\\Other";
const SERVER = { live: [], archived: [] };
let calls = [];
let etagSeq = 0;

const norm = (k) => String(k ?? "").replace(/\\/g, "/").toLowerCase();
const rowOf = (id, projectRaw = PROJECT_RAW) => ({
  id, cwd: projectRaw, projectKey: projectRaw, modified: "2026-11-20T00:00:00Z", messageCount: 1, firstMessage: id,
});

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push(u);
  if (u.includes("/api/agent/running")) {
    return new Response(JSON.stringify({ runningSessionIds: [], sessionListVersion: 0 }), { status: 200 });
  }
  if (u.includes("/sessions")) {
    // 2026-11-28: the scoped channel posts now — project travels in the JSON body (keeps the
    // absolute path out of URLs); the legacy GET form still reads it from the query string.
    let bodyProject;
    try { bodyProject = JSON.parse(String(init && init.body ? init.body : "{}")).project; } catch { /* non-JSON */ }
    const project = bodyProject ?? new URL(u, "http://x").searchParams.get("project");
    const live = project ? SERVER.live.filter((r) => norm(r.projectKey ?? r.cwd) === norm(project)) : SERVER.live;
    const body = { sessions: live, archived: project ? [] : SERVER.archived, rev: "R" + (++etagSeq) };
    return new Response(JSON.stringify(body), { status: 200, headers: { etag: `"R${etagSeq}"` } });
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Full landing + scoped landing for the dock's project (the normal mount sequence). */
async function landBoth() {
  await refreshSessions({ force: true });
  await refreshProjectSessions(PROJECT_KEY);
  await settle();
}

test("activity data frame inserts a row the scoped bucket lacks (zero request)", async () => {
  SERVER.live = [rowOf("a1"), rowOf("b1")];
  await landBoth();
  // Simulate the race: b1 was created after the last scoped landing → full bucket only.
  store.projectSessions = store.projectSessions.filter((r) => r.id !== "b1");
  assert.deepEqual(store.projectSessions.map((r) => r.id), ["a1"]);
  calls = [];

  const row = { ...rowOf("b1"), messageCount: 9, lastMessage: "latest" };
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "b1", row });
  await settle();

  assert.deepEqual(store.projectSessions.map((r) => r.id).sort(), ["a1", "b1"], "dock rows converge without a project switch");
  assert.equal(store.projectSessions.find((r) => r.id === "b1").messageCount, 9, "frame row is the landed data");
  assert.equal(calls.length, 0, "data frames stay zero-request");
});

test("activity data frame replaces an existing scoped row in place", async () => {
  SERVER.live = [rowOf("a1")];
  await landBoth();
  const before = store.projectSessions.length;
  const row = { ...rowOf("a1"), messageCount: 42 };
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "a1", row });
  assert.equal(store.projectSessions.length, before, "no duplicate row");
  assert.equal(store.projectSessions[0].messageCount, 42);
});

test("activity frames for another project never enter the dock bucket", async () => {
  SERVER.live = [rowOf("a1"), rowOf("o1", OTHER_RAW)];
  await landBoth();
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "o1", row: { ...rowOf("o1", OTHER_RAW), messageCount: 7 } });
  assert.deepEqual(store.projectSessions.map((r) => r.id), ["a1"], "other-project rows stay out");
});

test("an archived activity frame drops the row from the live-only dock bucket", async () => {
  SERVER.live = [rowOf("a1")];
  await landBoth();
  assert.deepEqual(store.projectSessions.map((r) => r.id), ["a1"]);
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "a1", row: { ...rowOf("a1"), archived: 1 } });
  assert.deepEqual(store.projectSessions.map((r) => r.id), [], "archived rows leave the scoped bucket");
});

test("draft promotion splices the landed row into the scoped bucket", async () => {
  SERVER.live = [rowOf("a1"), rowOf("c1")];
  await landBoth();
  store.projectSessions = store.projectSessions.filter((r) => r.id !== "c1"); // scoped landing predates c1
  noteDraftSession({ id: "c1", cwd: PROJECT_RAW, name: "new", firstMessage: "hi" });
  assert.equal(store.pendingDrafts.length, 1, "draft row visible while the jsonl is not listed");

  await refreshSessions({ force: true });
  await settle();

  assert.equal(store.pendingDrafts.length, 0, "promoted out of the draft bucket");
  assert.ok(store.projectSessions.some((r) => r.id === "c1"), "promoted row must not vanish from the dock");
  assert.ok(store.projectSessions.some((r) => r.id === "a1"), "existing scoped rows untouched");
});

test("a draft promoted into another project is not spliced into this dock", async () => {
  SERVER.live = [rowOf("a1"), rowOf("d1", OTHER_RAW)];
  await landBoth();
  noteDraftSession({ id: "d1", cwd: OTHER_RAW, name: "elsewhere", firstMessage: "x" });

  await refreshSessions({ force: true });
  await settle();

  assert.equal(store.pendingDrafts.length, 0);
  assert.ok(!store.projectSessions.some((r) => r.id === "d1"), "other-project rows stay out of the scoped bucket");
});

after(() => {
  rmSync(isoDir, { recursive: true, force: true });
});
