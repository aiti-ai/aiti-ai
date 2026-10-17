import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: the fork's "edit from here" mechanism (a pure frontend pending-send mark) was lost when
// plan-a-upstream was merged — MessageView got reverted to the upstream onNavigate+onEditContent
// (clicking the button immediately jumps and prefills), turning the fork's entire flow (a click only marks
// + highlights + the button turns into cancel; the session is only rewound when sent) into dead code.
// This file watches the props wiring on the MessageView side: if a merge ever switches it back to the
// upstream mechanism, this test goes red immediately.
const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("MessageView still declares the edit-from-here trio in its props interface", () => {
  // All three props are required: the mark entry / whether currently pending-send (highlight + button becomes cancel) / cancel the mark
  assert.match(source, /onEditFromHere\?: \(entryId: string, message: UserMessage, branchPointId: string \| null\) => void;/);
  assert.match(source, /editingFromStart\?: boolean;/);
  assert.match(source, /onCancelEditFromStart\?: \(\) => void;/);
});

test("MessageView passes the trio through to UserMessageView", () => {
  assert.match(
    source,
    /entryId=\{entryId\} onFork=\{onFork\} forking=\{forking\} onNavigate=\{onNavigate\} prevAssistantEntryId=\{prevAssistantEntryId\} onEditFromHere=\{onEditFromHere\} editingFromStart=\{editingFromStart\} onCancelEditFromStart=\{onCancelEditFromStart\}/,
  );
});

test("UserMessageView computes canEditFromHere (the button hides without onEditFromHere)", () => {
  assert.match(source, /const canEditFromHere = !!onEditFromHere && !!entryId;/);
});

test("the edit-from-here button becomes \"cancel\" while pending-send, otherwise marks the branch point", () => {
  // Branch point: with a previous assistant reply → rewind to it; first message (no canNavigate) → null → root rebuild on send (new session)
  assert.match(
    source,
    /onClick=\{[\s\S]*?if \(editingFromStart\) \{[\s\S]*?onCancelEditFromStart\?\.\(\);[\s\S]*?\} else \{[\s\S]*?onEditFromHere!\(entryId!, editTarget, canNavigate \? prevAssistantEntryId! : null\);/,
  );
  assert.match(source, /editingFromStart\s*\?\s*t\("i18n\.editFromHereCancelTitle"\)/);
  assert.match(source, /canNavigate \? t\("i18n\.editFromHereTitle"\) : t\("i18n\.editFromStartTitle"\)/);
  assert.match(source, /editingFromStart \? t\("i18n\.editFromHereCancel"\) : t\("i18n\.editFromHere"\)/);
});

test("the edit-from-here pending state highlights the user bubble (boxShadow; border left alone to avoid layout jumps)", () => {
  assert.match(
    source,
    /\.\.\.\(editingFromStart \? \{ boxShadow: "0 0 0 1\.5px var\(--accent\), 0 0 12px rgba\(59,130,246,0\.25\)" \} : \{\}\)/,
  );
});

test("the actions-area container includes the canEditFromHere branch", () => {
  assert.match(source, /\{\(canFork \|\| canNavigate \|\| canEditFromHere \|\| canEdit \|\| canCancelEdit\) && \(/); // 合并：本地并入了 canEdit/canCancelEdit 分支
});
