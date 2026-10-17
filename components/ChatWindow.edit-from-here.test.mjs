import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("marks a user message for edit-from-here without touching the session", () => {
  // Click-to-mark: purely frontend (prefill composer + highlight + button flips to cancel); no backend operation is initiated
  assert.match(source, /const handleEditFromHereMark = useCallback\(async \(entryId: string, message: UserMessage, branchPointId: string \| null\) => \{/);
  assert.match(source, /setEditFromHerePending\(\{[\s\S]*?targetId: branchPointId \?\? entryId,[\s\S]*?leafId: branchPointId,[\s\S]*?\}\)/);
  assert.match(source, /handleEditContent\(message\);/);
});

test("re-marks a different message by clearing the previous pending prefill", () => {
  // When a pending mark already exists: clear the old prefill before marking the new one (avoids leftover composer content silently breaking replaceMessage)
  assert.match(source, /const hasPending = editFromHerePendingRef\.current != null;/);
  assert.match(source, /if \(!hasPending && chatInputRef\?\.current\?\.hasInput\?\.\(\)\) return;/);
  assert.match(source, /if \(hasPending\) chatInputRef\?\.current\?\.clearInput\?\.\(\);/);
});

test("runs ai-change gates before marking; free-of-disturbance preflight comes first", () => {
  // Since 2026-09 the AI-change handling gate is attached to "edit from here"
  // (fork no longer triggers it): the hasInput preflight must run before the
  // gate — a non-empty composer aborts silently anyway, and showing the gate
  // first would make the user answer for nothing.
  const gatePos = source.indexOf("await runSessionForkGates(");
  const preflightPos = source.indexOf("if (!hasPending && chatInputRef?.current?.hasInput?.()) return;");
  assert.ok(gatePos > -1, "gate call missing");
  assert.ok(preflightPos > -1, "hasInput preflight missing");
  assert.ok(preflightPos < gatePos, "preflight must run before the gate dialog");
  assert.match(source, /const allowed = await runSessionForkGates\(\{ sessionId: sid, entryId, position: "before", cutUserEntryIds \}\);/);
  assert.match(source, /cutUserEntryIds/);
  assert.match(source, /if \(!allowed\) return;/);
});

test("re-checks composer input after the gate dialog wait", () => {
  // The rewind gate is a non-modal overlay: the user may have typed manually while it waited — re-check after the gate so the prefill does not clobber it (canRestore contract)
  assert.match(source, /if \(!editFromHerePendingRef\.current && chatInputRef\?\.current\?\.hasInput\?\.\(\)\) return;/);
});

test("cancelling the pending mark restores the composer", () => {
  assert.match(source, /const handleCancelEditFromHere = useCallback\(\(\) => \{/);
  assert.match(source, /setEditFromHerePending\(null\);\n\s+chatInputRef\?\.current\?\.clearInput\?\.\(\);/);
});

test("sending with a pending mark rewinds first; bash commands skip the rewind", () => {
  // Send is the actual effect point: with a pending mark, rewind first then send; bash commands prefixed with ! do not consume the mark
  assert.match(source, /const handleSendWrapped = useCallback\(async \(message: string, images\?: AttachedImage\[\], files\?: AttachedFile\[\]\) => \{/);
  assert.match(source, /if \(message\.trim\(\)\.startsWith\("!"\)\) \{[\s\S]*?await handleSend\(message, images[^)]*\);[\s\S]*?return;/);
  assert.match(source, /setEditFromHerePending\(null\);\n\s+await handleEditFromStartSend\(pending\.targetId, pending\.leafId, message, images\);/);
});

test("branch navigation cancels the pending mark automatically", () => {
  // Branch navigation (BranchNavigator/context links) changes activeLeafId →
  // the view position has moved; a pending mark is invalidated and cancelled
  // automatically (otherwise sending would force a rewind over the branch the
  // user just navigated to).
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?setEditFromHerePending\(null\);[\s\S]*?\}, \[activeLeafId\]\);/);
  // activeLeafId must come from the same useAgentSession state
  // (handleLeafChange/handleNavigate update it).
  // (After the experiment merge, the upstream scrollToMessage was appended to
  //  the destructure — used by session-search jumps, unrelated to this
  //  contract; on 2026-09-15 reloadCurrentSession was added — used by manual
  //  refresh of a stopped session, also unrelated; the regex allows any
  //  trailing destructured fields after activeLeafId so new fields don't turn
  //  the test red.)
  assert.match(source, /loadSlashCommands, scrollToBottom, scrollUserMsgToTop,\n\s+loadContext, activeLeafId(?:, \w+)*,\n\s+\} = useAgentSession\(/);
});

test("suppresses composer draft writes while a pending mark is active", () => {
  assert.match(source, /suppressDraft=\{editFromHerePending != null\}/);
});

test("wires the edit-from-here mark into the MessageView render", () => {
  // While merging plan-a-upstream, the message render was once reverted to
  // the upstream onNavigate+onEditContent, dropping the three lines that wire
  // this pending-mark mechanism into MessageView — the internal machinery
  // stayed intact but became dead code. This pins the wiring: if a merge
  // drops any line, the test goes red immediately.
  // 2026-09-18: added capability gating (external backends need navigateTree
  // or fork; the zcode backend uses session/fork semantics, and other external
  // backends hide the button to signal lack of support) — local sessions have
  // no caps and remain unrestricted.
  assert.match(source, /onEditFromHere=\{sessionBusy \|\| isNew \|\| !\(sessionCap\("navigateTree"\) \|\| sessionCap\("fork"\)\) \? undefined : handleEditFromHereMark\}/);
  assert.match(source, /editingFromStart=\{editFromHerePending\?\.entryId === entryIds\[idx\]\}/);
  assert.match(source, /onCancelEditFromStart=\{handleCancelEditFromHere\}/);
});

test("new-session button is not gated by sessionBusy/first message (visible while running and on the first message)", () => {
  // Decided in a4aaff0 (08-20): forking while running is perfectly fine — the
  // backend removed its gatekeeper (snapshot copy, no conflict), and forking
  // from the first message = copying the session to start a new branch, also
  // legitimate.
  // The v0.9.0 merge (test-upstream-0831) once brought back the upstream
  // sessionBusy || isNew || idx===0 guard, which made "new session" disappear
  // on all user messages while running. Pin the expression: if a merge
  // clobbers it again, the test goes red.
  // 2026-09-18: added fork capability gating (local sessions have no caps,
  // unchanged; external backends without fork support hide the button).
  // 合并适配：onFork 融合形态 = 本地能力门 ∪ 上游 bashRunning 门槛
  assert.match(source, /onFork=\{bashRunning \|\| isNew \|\| !sessionCap\("fork"\) \? undefined : handleFork\}/);
  assert.doesNotMatch(source, /onFork=\{sessionBusy/);
  assert.doesNotMatch(source, /idx === 0 && msg\.role === "user" \? undefined : handleFork/);
});

test("edit from here is gated by sessionBusy (hidden while running, decided 2026-09-08)", () => {
  // Edit-from-here rewinds the session on send — marking/rewinding while
  // running would conflict with the in-flight turn, so hide while running.
  assert.match(source, /onEditFromHere=\{sessionBusy \|\| isNew \|\| !\(sessionCap\("navigateTree"\) \|\| sessionCap\("fork"\)\) \? undefined : handleEditFromHereMark\}/);
});

test("never falls back to the superseded upstream navigate+editContent path", () => {
  // The upstream onEditContent semantics (immediate jump + prefill) differ
  // from fork's "mark as pending, rewind on send"; the two cannot coexist:
  // the former's presence means the fork mechanism was clobbered. Forbid it
  // from appearing in the message render line.
  assert.doesNotMatch(source, /onEditContent=\{handleEditContent\}/);
});
