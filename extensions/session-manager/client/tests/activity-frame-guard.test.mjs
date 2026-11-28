/**
 * Activity-frame stale-row guard regression test (2026-11 anti-flicker fix).
 *
 * Symptom: right after archive/delete, the row flashed back into the live list
 * and vanished again on the next refresh (delete → flash-in → flash-out).
 * Root cause: sm:session-activity frames are throttled server-side (3s + trailing)
 * and carry the row from the server's assembly-time row cache — a frame built
 * before the archive landed still has archived=false. The old
 * onSessionActivityFrame applied such a frame unconditionally, yanking the row
 * out of the archived bucket back into the live bucket.
 *
 * Guard semantics pinned here:
 *   - live frame for an id the store only knows as archived → skipped (THE bug);
 *   - archived frame while an archive op is in flight (marker in the live
 *     bucket) → skipped (the fetch landing moves the row; optimistic snapshot
 *     must survive);
 *   - archived frame without a live marker → applied (valid landing signal,
 *     row moves live → archived);
 *   - live frame for a live id → applied (content refresh).
 *
 * Run: node client/tests/activity-frame-guard.test.mjs (seconds)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../../node_modules/esbuild/lib/main.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "src");
const serverRoot = join(here, "..", "..", "server");

const HOST_SHIM_STUB = [
  "export function useState<T>(_v: T) { return [undefined, () => {}] as [T, (v: T) => void]; }",
  "export function useEffect(_f: () => unknown, _d?: unknown[]) { /* noop */ }",
  "export function apiUrl(p: string) { return \"/dev\" + p; }",
  "export function getExtService<T>(_k: string): T | undefined { return undefined; }",
  "export function t(k: string) { return k; }",
  "export function getLocale() { return \"en\"; }",
].join("\n");
const EXT_FLOAT_STUB = [
  "export function present() { return {} as Record<string, unknown>; }",
  "export function presentState() { return \"closed\" as const; }",
  "export function openFloat() { /* test stub */ }",
  "export function closePanel() { /* test stub */ }",
].join("\n");

/** Isolation dir mirroring store.ts relative imports (sm/client/src/ + _shared/ + sm/server/). */
function setupIsolation() {
  const dir = mkdtempSync(join(tmpdir(), "sm-frame-guard-"));
  const sm = join(dir, "sm");
  const clientSrc = join(sm, "client", "src");
  mkdirSync(join(clientSrc, "sidebar"), { recursive: true });
  writeFileSync(join(clientSrc, "store.ts"), readFileSync(join(srcRoot, "store.ts"), "utf8"));
  writeFileSync(join(clientSrc, "float-yield.pure.ts"), readFileSync(join(srcRoot, "float-yield.pure.ts"), "utf8"));
  writeFileSync(join(clientSrc, "host-shim.ts"), HOST_SHIM_STUB);
  writeFileSync(join(clientSrc, "sidebar", "pure.ts"), readFileSync(join(srcRoot, "sidebar", "pure.ts"), "utf8"));
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
const { store, onSessionActivityFrame, markPendingRemoval, clearPendingRemoval } = mod;

// No fetch expected on guarded paths; fail loudly if one fires (fallback refresh).
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls++;
  const u = String(url);
  if (u.includes("/api/agent/running")) {
    return new Response(JSON.stringify({ runningSessionIds: [] }), { status: 200 });
  }
  return new Response(JSON.stringify({ sessions: [], archived: [], rev: "r0" }), { status: 200, headers: { etag: '"r0"' } });
};

const liveRow = { id: "live-a", cwd: "/c", modified: "2026-11-01T00:00:00Z", archived: false, name: "a" };
const archRow = { id: "arch-b", cwd: "/c", modified: "2026-11-01T00:00:00Z", archived: true, name: "b" };

function seed() {
  store.sessions = [liveRow];
  store.archived = [archRow];
}

test("regression: stale LIVE frame for an archived id must NOT move the row back to live", () => {
  seed();
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "arch-b", row: { ...archRow, archived: false, name: "stale-live" } });
  assert.equal(store.archived.length, 1, "row stays in the archived bucket");
  assert.equal(store.archived[0].id, "arch-b", "archived row intact");
  assert.equal(store.archived[0].name, "b", "archived row untouched");
  assert.equal((store.sessions ?? []).filter((r) => r.id === "arch-b").length, 0, "no resurrection into the live bucket");
  assert.equal(fetchCalls, 0, "guarded path does not trigger a refresh");
});

test("archived frame while an archive op is in flight (live marker) → skipped", () => {
  seed();
  markPendingRemoval("live-a", "live"); // optimistic archive: marker in the LIVE bucket
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "live-a", row: { ...liveRow, archived: true, name: "landing" } });
  assert.equal((store.sessions ?? []).length, 1, "row not moved while the op is in flight");
  assert.equal(store.sessions[0].name, "a", "row untouched (optimistic snapshot survives)");
  assert.equal(store.archived.length, 1);
  clearPendingRemoval("live-a");
});

test("archived frame without a live marker → valid landing signal, row moves to archived", () => {
  seed();
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "live-a", row: { ...liveRow, archived: true, name: "landed" } });
  assert.equal((store.sessions ?? []).length, 0, "row left the live bucket");
  assert.equal(store.archived.length, 2, "row landed in the archived bucket");
  assert.equal(store.archived.find((r) => r.id === "live-a")?.name, "landed", "landing row applied");
});

test("live frame for a live id → content refresh applies", () => {
  seed();
  onSessionActivityFrame({ type: "sm:session-activity", sessionId: "live-a", row: { ...liveRow, name: "refreshed", modified: "2026-11-02T00:00:00Z" } });
  assert.equal((store.sessions ?? []).length, 1, "row stays live");
  assert.equal(store.sessions[0].name, "refreshed", "content updated");
  assert.equal(store.archived.length, 1);
});

/* ── dock-scoped prune regression (2026-11 anti-flicker round 2) ──
 * Symptom: the flash lived in the sidebar DOCK — it renders store.projectSessions
 * (scoped channel), but prunePendingRemovals only checked the two full buckets.
 * The full landing cleared the marker while the scoped snapshot still had the
 * row → the stale scoped row flashed in → the scoped landing removed it again.
 * Pinned semantics:
 *   1. full landing (row gone from sessions/archived) + row still in
 *      projectSessions → live marker SURVIVES (dock stays hidden);
 *   2. scoped landing (row gone from projectSessions too) → marker cleared;
 *   3. once the full list has landed, a scoped row absent from both full
 *      buckets is server-removed (dock render filter drops it — via
 *      hasLoadedSessionsOnce + the SidebarList filter, tested at the store
 *      level here through the exported flag).
 */
test("dock-scoped prune: live marker survives the full landing until the scoped landing", async () => {
  // full landing first: row removed from sessions/archived, still in projectSessions
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/api/agent/running")) return new Response(JSON.stringify({ runningSessionIds: [] }), { status: 200 });
    // 2026-11-28: the scoped channel posts now — project travels in the JSON body (keeps the
    // absolute path out of URLs); the legacy GET form still reads it from the query string.
    let bodyProject;
    try { bodyProject = JSON.parse(String(init && init.body ? init.body : "{}")).project; } catch { /* non-JSON */ }
    if (bodyProject || u.includes("project=")) {
      // scoped landing AFTER the server filtered the row: payload without dock-x
      return new Response(JSON.stringify({ sessions: [], archived: [], rev: "rp1" }), { status: 200, headers: { etag: '"rp1"' } });
    }
    return new Response(JSON.stringify({ sessions: [], archived: [], rev: "rf1" }), { status: 200, headers: { etag: '"rf1"' } });
  };
  store.sessions = [];
  store.archived = [];
  store.projectSessions = [{ id: "dock-x", cwd: "/c", modified: "2026-11-03T00:00:00Z" }];
  markPendingRemoval("dock-x", "live");
  assert.equal(mod.isPendingRemoval("dock-x", "live"), true, "marker set");
  await mod.refreshSessions({ force: true }); // full landing: row gone from both full buckets
  assert.equal(mod.isPendingRemoval("dock-x", "live"), true, "marker must SURVIVE the full landing while the scoped bucket still has the row");
  const { refreshProjectSessions } = mod;
  await refreshProjectSessions("/c", {});
  assert.equal(mod.isPendingRemoval("dock-x", "live"), false, "scoped landing (row gone from projectSessions) clears the marker");
  assert.equal(store.projectSessions.length, 0, "scoped payload without the row applied");
});
