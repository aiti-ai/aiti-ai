import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("explicit context changes invalidate a pending workspace restore", () => {
  const callbacks = [
    ["handleCwdChange", "handleSelectSession"],
    ["handleSelectSession", "handleNewSession"],
    ["handleNewSession", "hydrateSelectedSession"],
    ["handleSessionCreated", "handleAgentEnd"],
    ["handleSessionForked", "handleInitialRestoreDone"],
    ["handleSessionDeleted", "handleOpenFile"],
  ];

  for (const [name, nextName] of callbacks) {
    assert.match(callbackBody(name, nextName), /invalidateWorkspaceRestore\(\);/);
  }
});

test("all active-session transitions share one persistence effect", () => {
  assert.match(
    source,
    /useEffect\(\(\) => \{\s+if \(!selectedSession\) return;[\s\S]*?setLastOpenSession\(projectKey, selectedSession\.id\);\s+\}, \[selectedSession\]\);/,
  );
});

test("workspace restoration remains inside the cross-project branch", () => {
  const body = callbackBody("handleCwdChange", "handleSelectSession");
  assert.match(
    body,
    /if \(isUserProjectSwitch\) \{[\s\S]*?restoreWorkspaceContext\(newProject\);[\s\S]*?\}/,
  );
});

test("cold start never restores the remembered session (fresh-composer draft survives reload)", () => {
  // currentProject === null means the sidebar's first identity sync, not a
  // user switch — restoring there would yank the new-session composer (and
  // its recovered draft) to a historical session on every reload.
  const body = callbackBody("handleCwdChange", "handleSelectSession");
  assert.match(body, /const isUserProjectSwitch = currentProject !== null && currentProject !== newProject;/);
  assert.doesNotMatch(body, /if \(currentProject !== newProject\) \{[\s\S]*?restoreWorkspaceContext/);
});
