/**
 * watch.test.mjs — directory live-watch tests (borrow plan §2.4; tests server/watch.ts directly, git-plan pattern)
 * Run: node --experimental-strip-types --test extensions/aiti-folder/server/watch.test.mjs
 *
 * Covers: folderWatchApi /watch (allowedDir checks 403 / missing 404 / watchId issuance),
 * frame publish (__piPageEvents.publish("folder-watch") + 300ms debounce), /watch-stop removes the watch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { folderWatchApi } = await import("./watch.ts");

const tmp = mkdtempSync(join(tmpdir(), "folder-watch-"));
mkdirSync(join(tmp, "allow"), { recursive: true });
const allowRoot = join(tmp, "allow");

const ctx = { core: { fileAccess: { isAllowed: async (p) => String(p).startsWith(allowRoot) } } };

const call = (path, body) => folderWatchApi(new Request("http://local/" + path, {
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
}), ctx, path);

const frames = [];

globalThis.__piPageEvents = { publish: (type, data) => frames.push({ type, ...data }) };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("watch frames: dir change → debounced frame (type/dir/id); nothing after watch-stop", async () => {
  const ok = await call("watch", { dir: allowRoot });
  const id = (await ok.json()).id;
  frames.length = 0;
  writeFileSync(join(allowRoot, "a.txt"), "1");
  await wait(700);
  const hit = frames.filter((f) => f.type === "folder-watch" && f.id === id);
  assert.ok(hit.length >= 1, "debounced frame published; frames=" + JSON.stringify(frames));
  assert.equal(hit[0].dir, allowRoot);
  // stop → no further frames for this id
  await call("watch-stop", { ids: [id] });
  frames.length = 0;
  writeFileSync(join(allowRoot, "b.txt"), "2");
  await wait(700);
  assert.equal(frames.filter((f) => f.type === "folder-watch" && f.id === id).length, 0);
});

test("watch frames: child-directory activity does not refresh the parent listing (git status loop guard)", async () => {
  const sub = join(allowRoot, "child");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "inside.txt"), "0");
  const ok = await call("watch", { dir: allowRoot });
  const id = (await ok.json()).id;
  frames.length = 0;
  // Writing into a child directory leaves the parent's entries untouched; Windows
  // surfaces it as "change child" (a directory), which must not publish a frame —
  // that is the .git/index → refresh → git status → .git/index loop trigger.
  writeFileSync(join(sub, "inside.txt"), "1");
  await wait(700);
  assert.equal(frames.filter((f) => f.type === "folder-watch" && f.id === id).length, 0, "no frame for a child-directory change");
  // A real entry change in the watched directory still refreshes.
  writeFileSync(join(allowRoot, "new.txt"), "2");
  await wait(700);
  assert.ok(frames.filter((f) => f.type === "folder-watch" && f.id === id).length >= 1, "root entry change still publishes");
  await call("watch-stop", { ids: [id] });
});

test("hot reload re-arms leftover watches: one current watcher, no duplicates, filtering kept", async () => {
  const sub = join(allowRoot, "reload-child");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "inside.txt"), "0");
  const ok = await call("watch", { dir: allowRoot });
  const id = (await ok.json()).id;
  frames.length = 0;
  // A distinct URL = a second module instance, as an extension reload creates.
  const reloaded = await import(new URL("./watch.ts?reload=1", import.meta.url).href);
  assert.equal(typeof reloaded.startFolderWatch, "function");
  writeFileSync(join(allowRoot, "after-reload.txt"), "x");
  await wait(700);
  const hits = frames.filter((f) => f.type === "folder-watch" && f.id === id);
  assert.equal(hits.length, 1, "the reloaded module replaced the older watcher, not added one; frames=" + JSON.stringify(frames));
  frames.length = 0;
  writeFileSync(join(sub, "inside.txt"), "1");
  await wait(700);
  assert.equal(frames.filter((f) => f.type === "folder-watch" && f.id === id).length, 0, "re-armed watcher keeps the child-directory filter");
  await call("watch-stop", { ids: [id] });
});

test("watch frames: git-ignored changes are skipped; tracked and visible files still refresh", async () => {
  const repo = join(allowRoot, "repo");
  mkdirSync(join(repo, "build"), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "*.log\nbuild/\n");
  writeFileSync(join(repo, "app.log"), "ignored\n");
  writeFileSync(join(repo, "tracked.log"), "force-added\n");
  writeFileSync(join(repo, "code.ts"), "export {}\n");
  writeFileSync(join(repo, "build", "out.js"), "1\n");
  execFileSync("git", ["-C", repo, "init", "--quiet"]);
  execFileSync("git", ["-C", repo, "add", "-f", ".gitignore", "tracked.log", "code.ts"]);
  const ok = await call("watch", { dir: repo });
  const id = (await ok.json()).id;
  const hits = () => frames.filter((f) => f.type === "folder-watch" && f.id === id).length;
  frames.length = 0;
  writeFileSync(join(repo, "app.log"), "ignored again\n");
  await wait(800);
  assert.equal(hits(), 0, "ignored file does not refresh");
  writeFileSync(join(repo, "brand-new.log"), "ignored\n");
  await wait(800);
  assert.equal(hits(), 0, "a new ignored file does not refresh");
  writeFileSync(join(repo, "code.ts"), "export const x = 1;\n");
  await wait(800);
  assert.ok(hits() >= 1, "a tracked visible file still refreshes");
  frames.length = 0;
  writeFileSync(join(repo, "tracked.log"), "changed\n");
  await wait(800);
  assert.ok(hits() >= 1, "a force-added (tracked) file matching an ignore rule still refreshes");
  await call("watch-stop", { ids: [id] });
});

test("hot reload tolerates a legacy registry record (no batch fields)", async () => {
  const dir = join(allowRoot, "legacy");
  mkdirSync(dir, { recursive: true });
  const KEY = Symbol.for("pi-web:aiti-folder:watches");
  const id = "fw-legacy0000000000";
  globalThis[KEY] = new Map([[id, { id, dir, watcher: null, timer: null, lastFire: Date.now(), idleTimer: null }]]);
  const reloaded = await import(new URL("./watch.ts?legacy=1", import.meta.url).href);
  assert.equal(typeof reloaded.startFolderWatch, "function");
  frames.length = 0;
  writeFileSync(join(dir, "file.txt"), "x");
  await wait(800);
  assert.ok(frames.some((f) => f.type === "folder-watch" && f.id === id), "legacy record re-arms with the current code instead of throwing");
  reloaded.stopFolderWatch(id);
});

test("POST /watch: allowedDir checks (403/404/400) + watchId issuance", async () => {
  const ok = await call("watch", { dir: allowRoot });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.ok(/^fw-[0-9a-f]{16}$/.test(okBody.id));
  const deny = await call("watch", { dir: join(tmp, "deny") });
  assert.equal(deny.status, 403);
  const ghost = await call("watch", { dir: join(allowRoot, "nope") });
  assert.equal(ghost.status, 404);
  const rel = await call("watch", { dir: "relative/path" });
  assert.equal(rel.status, 400);
});

test("POST /watch-stop: unknown id is idempotent ok; non-module route returns null", async () => {
  const r = await call("watch-stop", { ids: ["fw-nonexistent0000"] });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  const passthrough = await folderWatchApi(new Request("http://local/other", { method: "POST", body: "{}" }), ctx, "other");
  assert.equal(passthrough, null);
});
// no module-top-level restore of __piPageEvents here: top-level code runs BEFORE tests
// execute and would silently strip the stub for every test (the stub lives for the
// process lifetime; the test process exits right after the run).
