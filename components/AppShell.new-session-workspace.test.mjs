import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression protection (2026-09-15 new-session page adjustments):
//  1. the new-session welcome page Workspace selector (before Backend,
//     defaults to the current cwd) — choosing only stages a target and does
//     not immediately switch the app workspace; the switch and new-session
//     open happen only after session creation succeeds;
//  2. extension entries inside the Backend dropdown (e.g. the ACP agent
//     management entry) — the management entry lives in the list, not
//     outside the selector;
//  3. a target workspace change remounts the composer, dropping the runtime
//     already ensured for the old cwd.
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const extTypes = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");

function callbackBody(source, name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("new-session workspace selection: the target cwd is independent of the app workspace (selecting does not switch immediately)", () => {
  assert.match(appShell, /const \[newSessionWorkspace, setNewSessionWorkspace\] = useState<string \| null>\(null\)/);
  assert.match(appShell, /const targetNewSessionCwd = newSessionWorkspace \?\? effectiveNewSessionCwd/);
  // ChatWindow gets the target cwd; the draft key still follows the current workspace (switching the selection does not change the draft slot)
  assert.match(appShell, /newSessionCwd=\{targetNewSessionCwd\}/);
  assert.match(appShell, /const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd/);
  // the sidebar's selectedCwd is not polluted by the target (otherwise selecting would trigger handleCwdChange and switch the workspace immediately)
  assert.match(appShell, /selectedCwd: selectedSession\?\.cwd \?\? newSessionCwd \?\? null/);
});

test("switching the target workspace remounts the composer (drops the runtime ensured for the old cwd; drafts are restored by the draft keeper)", () => {
  const body = callbackBody(appShell, "handleNewSessionWorkspaceChange", "newSessionDraftKey");
  assert.match(body, /setNewSessionWorkspace\(next\)/);
  assert.match(body, /setSessionKey\(\(k\) => k \+ 1\)/);
});

test("switches into the selected workspace and opens the new session only after creation succeeds", () => {
  const body = callbackBody(appShell, "handleSessionCreated", "deliverSessionNotification");
  assert.match(body, /setNewSessionWorkspace\(null\)/);
  // rewrite the project identity + activeCwd first (the sidebar cwd-sync early-returns and does not treat it as a cross-project switch that splits the session)
  assert.match(body, /if \(session\.cwd && session\.cwd !== activeCwd\) \{/);
  assert.match(body, /activeProjectKeyRef\.current = workspaceKeyOf\(session\)/);
  assert.match(body, /setActiveCwd\(session\.cwd\)/);
  assert.match(body, /setSelectedSession\(session\)/);
});

test("explicit context changes clear the staged target; same-cwd identity hydration does not", () => {
  for (const [name, nextName] of [
    ["handleSelectSession", "handleNewSession"],
    ["handleNewSession", "hydrateSelectedSession"],
    ["handleSessionForked", "handleInitialRestoreDone"],
  ]) {
    assert.match(callbackBody(appShell, name, nextName), /setNewSessionWorkspace\(null\)/, `${name} should clear the staged target`);
  }
  assert.match(callbackBody(appShell, "handleSessionDeleted", "handleOpenFile"), /setNewSessionWorkspace\(null\)/);
  // handleCwdChange: the clear must happen after the "same-cwd identity
  // hydration / same-project early return" — identity hydration is not a
  // user switch and must not wipe the target workspace the user just picked.
  const cwdBody = callbackBody(appShell, "handleCwdChange", "handleSelectSession");
  const hydrationReturn = cwdBody.indexOf("if (currentFreshCwd === cwd && currentProject !== newProject) return;");
  const clear = cwdBody.indexOf("setNewSessionWorkspace(null)");
  assert.notEqual(hydrationReturn, -1);
  assert.notEqual(clear, -1);
  assert.ok(clear > hydrationReturn, "handleCwdChange clear must come after the same-cwd hydration early return");
});

test("extension entries are built into the Backend dropdown (management entry in the list, not outside the selector)", () => {
  assert.match(chatWindow, /useExtSlotItems\("newSessionBackendOptions"\)/);
  assert.match(chatWindow, /BACKEND_EXT_OPTION_PREFIX/);
  assert.match(chatWindow, /backendExtraOptions\.map\(\(item\) => \(/);
  // selecting an extension entry: run its action and reset the dropdown (current backend unchanged)
  assert.match(chatWindow, /e\.target\.value = sessionBackend \?\? ""/);
  assert.match(chatWindow, /\.meta\?\.onClick\?\.\(\)/);
  // the old outside-the-selector slot is fully retired
  assert.doesNotMatch(chatWindow, /newSessionBackendBar/);
  assert.match(extTypes, /"newSessionBackendOptions"/);
  assert.doesNotMatch(extTypes, /"newSessionBackendBar"/);
});

test("the Workspace selector renders before Backend", () => {
  const workspaceAt = chatWindow.indexOf(">Workspace</span>");
  const backendAt = chatWindow.indexOf(">Backend</span>");
  assert.notEqual(workspaceAt, -1, "Workspace label missing");
  assert.notEqual(backendAt, -1, "Backend label missing");
  assert.ok(workspaceAt < backendAt, "Workspace should render before Backend");
  // defaults to the current cwd; the selection is passed back to AppShell (null = current workspace)
  assert.match(chatWindow, /value=\{newSessionWorkspace \?\? newSessionCwd \?\? ""\}/);
  assert.match(chatWindow, /onNewSessionWorkspaceChange\?\.\(e\.target\.value \|\| null\)/);
});
