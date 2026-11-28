/**
 * sync-dir leftover-retention-window unit tests (node --test).
 *
 * Pins the 2026-09-22 deploy-interruption incident: vite lazy chunks are imported only on click,
 * while a deploy --deletes the previous round's `sessions-panel-<hash>.js` outright -> a page opened
 * before the deploy clicks All Sessions, fetches the old chunk name, 404s, and the panel "won't open"
 * (a user reported "All Sessions won't open anymore").
 * Inside the delGraceMs window (mtime = the deploy copy moment) nothing is deleted; only past the
 * window is it cleaned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { syncDir } from "./sync-dir.mjs";

const HOUR = 3600 * 1000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sync-dir-test-"));
  const src = join(root, "src");
  const dst = join(root, "dst");
  mkdirSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  const put = (dir, rel, body = "x") => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const age = (rel, ms) => {
    const t = new Date(Date.now() - ms);
    utimesSync(join(dst, rel), t, t);
  };
  return { root, src, dst, put, age };
}

test("leftovers inside the window are kept, leftovers past the window are cleaned", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "entry-new12345.js", "new-build");
  put(dst, "entry-old12345.js"); age("entry-old12345.js", 60 * 1000);            // last round's chunk (1min)
  put(dst, "sessions-panel-abcdef12.js"); age("sessions-panel-abcdef12.js", 5 * HOUR); // lazy chunk inside the window
  put(dst, "kanban-99887766.js"); age("kanban-99887766.js", 7 * HOUR);            // past the window
  put(dst, "stale-server-side.mjs"); age("stale-server-side.mjs", 10 * 1000);     // not a chunk name, kept all the same
  const st = syncDir(src, dst, { del: true });
  assert.ok(existsSync(join(dst, "entry-new12345.js")), "this round's artifact must be copied in");
  assert.ok(existsSync(join(dst, "entry-old12345.js")), "the in-window previous chunk must not be deleted (an open page still points at it)");
  assert.ok(existsSync(join(dst, "sessions-panel-abcdef12.js")), "the in-window lazy chunk must not be deleted");
  assert.ok(!existsSync(join(dst, "kanban-99887766.js")), "the past-window chunk must be deleted (the disk must not grow forever)");
  assert.equal(st.deleted, 1);
  assert.equal(st.kept, 3);
  rmSync(root, { recursive: true, force: true });
});

test("delGraceMs:0 restores immediate deletion (explicit caller semantics)", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "entry-new12345.js", "new-build");
  put(dst, "entry-old12345.js"); age("entry-old12345.js", 1000);
  syncDir(src, dst, { del: true, delGraceMs: 0 });
  assert.ok(!existsSync(join(dst, "entry-old12345.js")));
  rmSync(root, { recursive: true, force: true });
});

test("with del:false, leftovers are never touched", () => {
  const { root, src, dst, put } = fixture();
  put(src, "index.mjs", "a");
  put(dst, "old-abcdefgh.js");
  const st = syncDir(src, dst);
  assert.ok(existsSync(join(dst, "old-abcdefgh.js")));
  assert.equal(st.deleted, 0);
  assert.equal(st.kept, 0);
  rmSync(root, { recursive: true, force: true });
});

test("excluded entries take precedence over the window: protected items are never deleted", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "index.mjs", "a");
  put(dst, "node_modules/keep.js", "dep");
  put(dst, "notes.txt"); age("notes.txt", 10 * 1000);
  syncDir(src, dst, {
    del: true,
    delGraceMs: 0,
    exclude: (rel) => rel.startsWith("node_modules"),
  });
  assert.ok(existsSync(join(dst, "node_modules/keep.js")), "excluded items are not deleted even with del + past-window");
  assert.ok(!existsSync(join(dst, "notes.txt")));
  rmSync(root, { recursive: true, force: true });
});

test("dst-only directories are window-judged by the directory's own mtime", () => {
  const { root, src, dst, put, age } = fixture();
  put(src, "sub/keep-me.js", "src");
  put(dst, "sub/gone-old.js"); age("sub/gone-old.js", 7 * HOUR); // src also has sub -> judged per file
  put(dst, "oldassets/chunk-abcdefgh.js");
  age("oldassets", 7 * HOUR); // the whole directory is past the window -> recursive delete
  put(dst, "recentdir/chunk-12345678.js"); // directory mtime=now -> the whole in-window directory is kept
  syncDir(src, dst, { del: true });
  assert.ok(!existsSync(join(dst, "sub/gone-old.js")), "past-window files under a same-named src directory are still deleted");
  assert.ok(!existsSync(join(dst, "oldassets")), "a past-window whole directory is deleted");
  assert.ok(existsSync(join(dst, "recentdir/chunk-12345678.js")), "an in-window new directory must not be deleted as a whole");
  rmSync(root, { recursive: true, force: true });
});
