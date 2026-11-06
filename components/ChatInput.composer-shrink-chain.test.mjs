import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Upstream #1429 turned the composer into a shrinkable flex-column CHAIN so a
// long queued-message list gives way instead of pushing the input off screen:
//
//   ChatWindow bottom container (min-h-0 flex-col)
//     └ fieldset.chat-input-shell (flex column, minHeight 0)
//         └ inner column div (flex column, minHeight 0, **width: "100%"**)
//             └ queue box (flex column, minHeight: 72 → rows scroll in their own box)
//
// The merge of v0.13/v0.15 kept the fieldset piece but resolved the other
// hunks to the fork's pre-#1429 lines — the chain broke in half and, because
// the inner div only has `margin: "0 auto"` (horizontal auto margins disable
// align-self:stretch in a flex column), the whole composer collapsed to
// fit-content (measured: 20px wide; textarea wrapper at flex:1 1 0 → 0px, all
// composer buttons overflowed the box). The demo mirror (demo/components/)
// kept the full upstream form, which is how the loss was spotted.
//
// Pin all four pieces: they are one upstream commit's design and only work
// together — a merge that resolves SOME of these hunks to the old fork side
// must fail here.

const inputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const windowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("shrink chain ①: the composer fieldset is a shrinkable flex column (non-compact)", () => {
  assert.match(
    inputSource,
    /\.\.\.\(compact \? \{ flexShrink: 0 \} : \{ display: "flex", flexDirection: "column", minHeight: 0 \}\)/,
  );
});

test("shrink chain ②: the inner column keeps width 100% — the collapse guard", () => {
  // THE critical piece: without `width: "100%"` the div's `margin: "0 auto"`
  // wins over stretch in the fieldset's flex column and the composer shrinks
  // to fit-content. If a merge drops just this spread, this test goes red.
  assert.match(
    inputSource,
    /\.\.\.\(compact \? undefined : \{ display: "flex", flexDirection: "column", minHeight: 0, width: "100%" \}\), maxWidth: "var\(--chat-content-max-width, 820px\)", margin: "0 auto"/,
  );
});

test("shrink chain ③: the queue box can give way down to header + one row (minHeight 72)", () => {
  assert.match(inputSource, /flexDirection: "column",\s*\n\s*minHeight: 72,/);
  // …and the rows scroll inside their own capped box (overscroll contained).
  assert.match(
    inputSource,
    /maxHeight: "min\(180px, calc\(var\(--app-viewport-height, 100dvh\) \* 0\.25\)\)",\s*\n\s*overflowY: "auto",\s*\n\s*overscrollBehavior: "contain",/,
  );
});

test("shrink chain ④: ChatWindow's bottom composer container is a shrinkable flex column", async () => {
  assert.match(windowSource, /className="relative flex min-h-0 flex-col"/);
  // Demo mirror agrees (full-upstream form) — if the two disagree again, that's
  // a merge resolution bug, not intent.
  const demoWindow = await readFile(new URL("../demo/components/ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(demoWindow, /className="relative flex min-h-0 flex-col"/);
});

test("the demo mirror keeps the same chain (the merge对照 was how the loss was found)", async () => {
  // demo/components/ChatInput.tsx is a full-upstream mirror of the composer.
  // If the demo mirror and the real component ever disagree on the inner
  // column form again, treat it as a merge resolution bug, not as intent.
  const demo = await readFile(new URL("../demo/components/ChatInput.tsx", import.meta.url), "utf8");
  assert.match(
    demo,
    /\{ display: "flex", flexDirection: "column", minHeight: 0, width: "100%" \}/,
  );
});
