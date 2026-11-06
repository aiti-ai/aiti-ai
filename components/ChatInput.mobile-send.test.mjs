import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for the fork's WeChat-style mobile send (ada119b4):
// on a phone the bare Enter sends — the soft keyboard shows a Send key
// (enterKeyHint="send") and there is no Ctrl on a phone keyboard anyway.
// Upstream #1001 rewrote sendShortcut with an operator-precedence bug and
// the merge carried it in verbatim:
//   const sendShortcut = isMobile || enterSendMode === "ctrlEnter"
//     ? enterKey && (e.ctrlKey || e.metaKey)
//     : enterKey;
// which binds as (isMobile || mode==="ctrlEnter") ? (enterKey && ctrl||meta) : enterKey
// — on a phone sendShortcut was then always false and Enter silently became a
// newline (the Send-labelled key inserting line breaks). This file pins the
// correct form so the next merge cannot reintroduce either the bug or the
// semantic loss.

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

test("mobile send: isMobile short-circuits BEFORE the ctrlEnter ternary (bare Enter sends)", () => {
  // The fork form: isMobile ? enterKey : ... — no modifier requirement on a phone.
  assert.match(
    source,
    /const sendShortcut = isMobile\s*\?\s*enterKey\s*:\s*enterSendMode === "ctrlEnter"\s*\?\s*enterKey && \(e\.ctrlKey \|\| e\.metaKey\)\s*:\s*enterKey;/,
  );
});

test("mobile send: the upstream precedence-bug form must never come back", () => {
  // The exact buggy binding: `isMobile || enterSendMode === "ctrlEnter"` as the
  // ternary condition with `enterKey && (ctrl||meta)` as its true-arm. If a
  // merge reintroduces this text, mobile Enter is a newline again.
  assert.doesNotMatch(
    source,
    /isMobile \|\| enterSendMode === "ctrlEnter"\s*\?\s*enterKey && \(e\.ctrlKey \|\| e\.metaKey\)/,
  );
});

test("mobile send: the soft keyboard advertises Send (enterKeyHint), so Enter must send", () => {
  // Consistency pin: the textarea asks the IME for a Send key; if the key
  // handler stopped sending on bare Enter, the labelled key would insert
  // newlines — keep these two in sync or change both deliberately.
  assert.match(source, /enterKeyHint="send"/);
});

test("mobile send: Shift+Enter stays a newline and the IME guard still intercepts composition Enter", () => {
  // enterKey excludes Shift and key-repeat; the IME guard consumes
  // acceptShortcut presses while composing (Safari candidate confirm) before
  // any send can happen.
  assert.match(source, /const enterKey = e\.key === "Enter" && !e\.shiftKey && !e\.repeat;/);
  assert.match(source, /if \(acceptShortcut && \(isComposing \|\| recentlyComposed\)\) \{/);
  // acceptShortcut itself: mobile must resolve to sendShortcut (= bare Enter
  // send), so menus and the IME guard behave identically to the send key. If
  // a merge makes acceptShortcut desktop-only again, mobile Enter picks menu
  // items but never sends — pin the exact form.
  assert.match(source, /const acceptShortcut = isMobile \? sendShortcut : enterKey;/);
});
