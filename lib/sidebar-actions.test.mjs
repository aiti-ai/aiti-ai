import assert from "node:assert/strict";
import test from "node:test";
import { sessionMenuEntries } from "./sidebar-actions.ts";

const idle = { running: false, unread: false, selected: false, transient: false };

function actions(entries) {
  return entries.map((entry) => entry.kind === "separator" ? "-" : `${entry.id}:${entry.shortcut}${entry.disabledReason ? ` (${entry.disabledReason})` : ""}`);
}

test("a group row offers pin, rename, unread, archive and delete", () => {
  assert.deepEqual(actions(sessionMenuEntries("group", idle)), ["pin:P", "rename:R", "mark-unread:U", "archive:A", "-", "delete:D"]);
  assert.deepEqual(
    actions(sessionMenuEntries("pinned", { ...idle, unread: true })),
    ["unpin:P", "rename:R", "mark-read:U", "archive:A", "-", "delete:D"],
  );
});

test("a running family cannot be archived yet", () => {
  const entries = actions(sessionMenuEntries("group", { ...idle, running: true }));
  assert.ok(entries.includes("archive:A (running)"));
  assert.ok(entries.includes("delete:D"));
});

test("an archived row offers unarchive, pin (which restores it), rename and delete", () => {
  assert.deepEqual(actions(sessionMenuEntries("archive", idle)), ["unarchive:A", "pin:P", "rename:R", "-", "delete:D"]);
});

test("a transient session offers nothing that needs its file", () => {
  for (const context of ["group", "pinned", "archive"]) {
    assert.deepEqual(sessionMenuEntries(context, { ...idle, transient: true }), []);
  }
});

test("shortcuts are unique within a menu", () => {
  for (const context of ["group", "pinned", "archive"]) {
    const shortcuts = sessionMenuEntries(context, idle).filter((entry) => entry.kind === "action").map((entry) => entry.shortcut);
    assert.equal(new Set(shortcuts).size, shortcuts.length);
  }
});
