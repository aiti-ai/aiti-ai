import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression protection (2026-09-17 new-session "branch / worktree" selector,
// fork integration plan M1):
//  1. the newSessionSelectors render slot: DOM order pinned between Workspace
//     and Backend;
//  2. the newSessionPreparers registration surface: ensureNewSession awaits
//     them in order before the POST; {cwd} rewrites the target directory,
//     {abort} goes through the existing throw→notice channel;
//  3. the rewritten cwd is reported via promoteNewSession to
//     onSessionCreated (AppShell switches the active workspace).
const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const useAgentSession = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const extTypes = await readFile(new URL("../lib/ext/types.ts", import.meta.url), "utf8");
const preparers = await readFile(new URL("../hooks/new-session-preparers.ts", import.meta.url), "utf8");

test("slot contract: newSessionSelectors + newSessionPreparers are declared in ExtSlotName/ui declarations/contract map", () => {
  assert.match(extTypes, /"newSessionSelectors"/);
  assert.match(extTypes, /"newSessionPreparers"/);
  assert.match(extTypes, /newSessionSelectors: \{ props: NewSessionSelectorSlotProps \}/);
  assert.match(extTypes, /newSessionSelectors\?: ExtUiItem\[\]/);
  assert.match(extTypes, /newSessionPreparers\?: ExtUiItem\[\]/);
  // extra only carries data (slot-extra red line): callback fields are not allowed in the contract
  const contract = extTypes.slice(extTypes.indexOf("interface NewSessionSelectorSlotProps"), extTypes.indexOf("NewSessionPrepareResult"));
  assert.match(contract, /cwd: string \| null/);
  assert.match(contract, /isMobile: boolean/);
});

test("render-point DOM order: Workspace < newSessionSelectors < Backend", () => {
  const workspaceAt = chatWindow.indexOf(">Workspace</span>");
  const selectorsAt = chatWindow.indexOf('name="newSessionSelectors"');
  const backendAt = chatWindow.indexOf(">Backend</span>");
  assert.notEqual(workspaceAt, -1, "Workspace label missing");
  assert.notEqual(selectorsAt, -1, "newSessionSelectors slot missing");
  assert.notEqual(backendAt, -1, "Backend label missing");
  assert.ok(workspaceAt < selectorsAt && selectorsAt < backendAt, "slot should render between Workspace and Backend");
  // extra only carries data {cwd,isMobile}
  assert.match(chatWindow, /extra=\{\{ cwd: newSessionCwd, isMobile \}\}/);
  // the selector-row render gate includes the slot (the selector stays visible with no workspace/backend options)
  assert.match(chatWindow, /backendExtraOptions\.length > 0 \|\| hasNewSessionSelectors/);
});

test("preparer collection and pass-through: ChatWindow collects meta.prepare → useAgentSession pipeline", () => {
  assert.match(chatWindow, /useExtSlotItems\("newSessionPreparers"\)/);
  assert.match(chatWindow, /typeof it\.meta\?\.prepare === "function"/);
  assert.match(chatWindow, /newSessionPreparers,/);
  assert.match(useAgentSession, /newSessionPreparers\?: NewSessionPreparer\[\]/);
  // ref mirror (identity changes of slot items do not break callback stability)
  assert.match(useAgentSession, /newSessionPreparersRef\.current = opts\.newSessionPreparers/);
});

test("ensureNewSession: preparer pipeline runs before the POST and the rewritten cwd goes into the request body", () => {
  const pipelineAt = useAgentSession.indexOf("runNewSessionPreparers(newSessionPreparersRef.current");
  const fetchAt = useAgentSession.indexOf('fetch(apiUrl("/api/agent/new")');
  assert.notEqual(pipelineAt, -1, "preparer pipeline call not found inside ensureNewSession");
  assert.notEqual(fetchAt, -1);
  assert.ok(pipelineAt < fetchAt, "preparer pipeline must run before POST /api/agent/new");
  // request body cwd = pipeline output (no longer the bare newSessionCwd)
  assert.match(useAgentSession, /cwd: prepared\.cwd,/);
  // abort = the existing throw channel: errors go through the handleSend catch → addNotice; no new display mechanism
  assert.match(preparers, /if \(r\.abort\) throw new Error\(r\.abort\)/);
  assert.match(preparers, /if \(r\.cwd\) target = r\.cwd/);
});

test("the rewritten cwd is reported on session creation (AppShell switches the active workspace to the worktree path)", () => {
  assert.match(useAgentSession, /cwd: newSessionResolvedCwdRef\.current \?\? newSessionCwd,/);
  // the resolved value lands in the ref before the POST (read by promote on success; not promoted on failure)
  const resolvedAt = useAgentSession.indexOf("newSessionResolvedCwdRef.current = prepared.cwd");
  const fetchAt = useAgentSession.indexOf('fetch(apiUrl("/api/agent/new")');
  assert.ok(resolvedAt > -1 && resolvedAt < fetchAt, "resolved cwd must land in the ref before the POST");
});
