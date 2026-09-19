import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadQueueFile,
  queueSidecarPath,
  removeQueue,
  saveQueue,
} from "./queue-store.ts";

function makeDir() {
  return mkdtempSync(join(tmpdir(), "pi-queue-trash-"));
}

test("v1 sidecars (no trash section) migrate transparently on load", () => {
  const dir = makeDir();
  try {
    const base = join(dir, "session");
    const path = queueSidecarPath(base);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: [
          { id: "a", kind: "steer", text: "hello", queuedAt: 1 },
          { id: "b", kind: "followUp", text: "world", queuedAt: 2 },
        ],
      }),
    );
    const { entries, trash } = loadQueueFile(base);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, "a");
    assert.deepEqual(trash, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 round-trip persists live entries and trash independently", () => {
  const dir = makeDir();
  try {
    const base = join(dir, "session");
    const live = [{ id: "a", kind: "steer", text: "live", queuedAt: 1 }];
    const trash = [
      { id: "t1", kind: "followUp", text: "deleted one", queuedAt: 2 },
      { id: "t2", kind: "steer", text: "deleted two", queuedAt: 3, images: [{ type: "image", data: "x", mimeType: "image/png" }] },
    ];
    saveQueue(base, live, trash);

    const raw = JSON.parse(readFileSync(queueSidecarPath(base), "utf8"));
    assert.equal(raw.version, 2);

    const { entries, trash: loaded } = loadQueueFile(base);
    assert.deepEqual(entries, live);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[1].id, "t2");
    assert.equal(loaded[1].images?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("composer (cleared input) entries round-trip: kind persistence + image retention", () => {
  const dir = makeDir();
  try {
    const base = join(dir, "session");
    const trash = [
      { id: "c1", kind: "composer", text: "误清的一段文字", queuedAt: 123, images: [{ type: "image", data: "abc", mimeType: "image/png" }] },
      { id: "c2", kind: "composer", text: "纯文本", queuedAt: 124 },
    ];
    saveQueue(base, [], trash);
    const { entries, trash: loaded } = loadQueueFile(base);
    assert.deepEqual(entries, []);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].kind, "composer");
    assert.equal(loaded[0].images?.length, 1);
    assert.equal(loaded[1].kind, "composer");
    assert.ok(!loaded[1].images);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveQueue without a trash argument keeps trash empty", () => {
  const dir = makeDir();
  try {
    const base = join(dir, "session");
    saveQueue(base, [{ id: "a", kind: "steer", text: "live", queuedAt: 1 }]);
    const { entries, trash } = loadQueueFile(base);
    assert.equal(entries.length, 1);
    assert.deepEqual(trash, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt sidecar loads as empty rather than crashing", () => {
  const dir = makeDir();
  try {
    const base = join(dir, "session");
    writeFileSync(queueSidecarPath(base), "not json {");
    assert.deepEqual(loadQueueFile(base), { entries: [], trash: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeQueue deletes the sidecar including trash", () => {
  const dir = makeDir();
  try {
    const base = join(dir, "session");
    saveQueue(base, [], [{ id: "t", kind: "steer", text: "x", queuedAt: 1 }]);
    assert.ok(existsSync(queueSidecarPath(base)));
    removeQueue(base);
    assert.ok(!existsSync(queueSidecarPath(base)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The wrapper behaviors below are covered by source-level checks matching the
// existing rpc-manager test style (the wrapper needs a live AgentSession to
// execute commands, which these tests do not construct).
test("remove_queue_item soft-deletes to trash unless permanent", async () => {
  const source = await readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const caseSource = source.slice(source.indexOf("case \"remove_queue_item\""), source.indexOf("case \"trash_direct_add\""));
  assert.match(caseSource, /const permanent = command\.permanent === true/);
  assert.match(caseSource, /if \(!permanent\) \{\s*this\.queueTrash\.push\(removed\)/);
  assert.match(caseSource, /removed: \{/);
  assert.match(caseSource, /queueTrash: this\.getQueueTrashView\(\)/);
});

test("remove_queue_item permanent out-of-range is an idempotent noop (consumption race)", async () => {
  const source = await readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const caseSource = source.slice(source.indexOf("case \"remove_queue_item\""), source.indexOf("case \"restore_trash_item\""));
  // permanent out-of-range = the target entry was already consumed by dispatch
  // (e.g. taken away by steer-send), a benign no-op: return the current queue
  // instead of throwing; the unconditional throw below only covers the
  // non-permanent (explicit user delete) path, preserving defect capture.
  const rangeBlock = caseSource.slice(caseSource.indexOf("index < 0"), caseSource.indexOf("const [removed]"));
  assert.match(rangeBlock, /if \(permanent\) \{\s*return \{[\s\S]*?getQueueTrashView\(\)/);
  assert.match(rangeBlock, /throw new Error\("remove_queue_item index out of range"\)/);
  assert.ok(rangeBlock.indexOf("getQueueTrashView()") < rangeBlock.indexOf("throw new Error"), "permanent noop must short-circuit before the throw");
});

test("restore_trash_item and purge_trash commands exist with the right semantics", async () => {
  const source = await readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const restoreSource = source.slice(source.indexOf("case \"restore_trash_item\""), source.indexOf("case \"purge_trash\""));
  assert.match(restoreSource, /this\.queueTrash\.findIndex\(\(e\) => e\.id === id\)/);
  assert.match(restoreSource, /this\.queueTrash\.splice\(trashIdx, 1\)/);
  assert.match(restoreSource, /entries\.splice\(rawIndex, 0, entry\)/);

  const purgeSource = source.slice(source.indexOf("case \"purge_trash\""), source.indexOf("case \"resolve_recovery\""));
  assert.match(purgeSource, /this\.queueTrash = this\.queueTrash\.filter\(\(e\) => !idSet\.has\(e\.id\)\)/);
  assert.match(purgeSource, /this\.queueTrash = \[\]/);
  assert.match(purgeSource, /return \{ queueTrash: this\.getQueueTrashView\(\) \}/);
});

test("clear_queue moves entries to trash (soft clear)", async () => {
  const source = await readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const caseSource = source.slice(source.indexOf("case \"clear_queue\""), source.indexOf("case \"move_queue\""));
  assert.match(caseSource, /this\.queueTrash\.push\(\.\.\.this\.queueMirror\)/);
});

test("persistQueue keeps the sidecar when only trash remains", async () => {
  const source = await readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const persistSource = source.slice(source.indexOf("private persistQueue"), source.indexOf("private getQueueTrashView"));
  assert.match(persistSource, /entries\.length === 0 && this\.queueTrash\.length === 0/);
  assert.match(persistSource, /saveQueue\(file, entries, this\.queueTrash\)/);
});

test("get_state and loadQueueRecovery expose the trash", async () => {
  const source = await readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /queueTrash: this\.getQueueTrashView\(\)/);
  assert.match(source, /this\.queueTrash = trash;/);
});

test("trash_direct_add writes straight to trash (bypassing the live queue) + composer restore branch", async () => {
  const source = await readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const directSource = source.slice(source.indexOf("case \"trash_direct_add\""), source.indexOf("case \"restore_trash_item\""));
  // Build a composer entry and push it onto queueTrash without touching queueMirror / inner
  assert.match(directSource, /createQueueEntry\(\"composer\", text/);
  assert.match(directSource, /this\.queueTrash\.push\(entry\)/);
  assert.match(directSource, /QUEUE_TRASH_MAX_ENTRIES/);
  assert.match(directSource, /return \{\s*entry:/);
  assert.doesNotMatch(directSource, /queueMirror|this\.inner/);

  const restoreSource = source.slice(source.indexOf("case \"restore_trash_item\""), source.indexOf("case \"purge_trash\""));
  // composer entries: return the full content from trash, do not enter the live
  // queue (clearQueue/re-enqueue only serve steer/followUp)
  assert.match(restoreSource, /entry\.kind === \"composer\"/);
  assert.match(restoreSource, /restoredComposer:/);
});
