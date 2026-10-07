import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("uses the server-resolved current worktree identity", () => {
  assert.match(source, /currentWorktreePath: string \| null/);
  assert.match(
    source,
    /const currentWorktree =[\s\S]*?worktreeState\.currentWorktreePath[\s\S]*?worktree\.path === worktreeState\.currentWorktreePath/,
  );
  assert.match(source, /if \(currentWorktreePath === path\) setSelectedCwd\(worktreeState\.projectRoot\)/);
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});

test("the group + picker marks the checkout in use with the server-resolved path", () => {
  const picker = source.slice(source.indexOf("const worktreeMenuItems"), source.indexOf("const viewMenuItems"));
  assert.match(
    picker,
    /const current = pickerCurrentWorktreePath\(listing, project\.key === selectedProject\?\.key \? currentWorktreePath : null\);/,
  );
  assert.doesNotMatch(picker, /worktree\.path === selectedCwd/);
});
