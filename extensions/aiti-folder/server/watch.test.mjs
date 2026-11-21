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
