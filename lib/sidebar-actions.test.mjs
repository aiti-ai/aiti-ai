import assert from "node:assert/strict";
import test from "node:test";
import {
  needsWorktreePicker,
  parseWorktreeListing,
  pickerCurrentWorktreePath,
  sessionMenuEntries,
} from "./sidebar-actions.ts";

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

const listing = {
  projectRoot: "/work/app",
  projectKey: "/work/app",
  isGit: true,
  isTopLevel: true,
  currentWorktreePath: "/work/app",
  worktrees: [
    { path: "/work/app", branch: "main", isMain: true },
    { path: "/work/app-worktrees/feature", branch: "feature", isMain: false },
  ],
};

test("worktree listings are read defensively", () => {
  assert.deepEqual(parseWorktreeListing(listing), listing);
  assert.equal(parseWorktreeListing(null), null);
  assert.equal(parseWorktreeListing({ error: "Access denied" }), null);
  assert.equal(parseWorktreeListing({ projectRoot: "" }), null);
  assert.deepEqual(parseWorktreeListing({
    projectRoot: "C:\\work\\app",
    worktrees: [{ path: "C:\\work\\app", branch: null, isMain: true }, { branch: "orphan" }, "junk"],
  }), {
    projectRoot: "C:\\work\\app",
    projectKey: "C:\\work\\app",
    isGit: false,
    isTopLevel: false,
    currentWorktreePath: null,
    worktrees: [{ path: "C:\\work\\app", branch: null, isMain: true }],
  });
});

test("the group + asks only at the top of a checkout with other worktrees", () => {
  assert.equal(needsWorktreePicker(listing), true);
  assert.equal(needsWorktreePicker(null), false);
  assert.equal(needsWorktreePicker({ ...listing, worktrees: listing.worktrees.slice(0, 1) }), false);
  assert.equal(needsWorktreePicker({ ...listing, isTopLevel: false }), false);
  assert.equal(needsWorktreePicker({ ...listing, isGit: false }), false);
});

test("the picker marks the worktree in use, or the main checkout of another project", () => {
  assert.equal(pickerCurrentWorktreePath(listing, "/work/app-worktrees/feature"), "/work/app-worktrees/feature");
  assert.equal(pickerCurrentWorktreePath(listing, null), "/work/app");
  // A cwd that is not one of the listed checkouts falls back to main.
  assert.equal(pickerCurrentWorktreePath(listing, "/elsewhere"), "/work/app");
  assert.equal(pickerCurrentWorktreePath({ ...listing, worktrees: [] }, null), null);
});
