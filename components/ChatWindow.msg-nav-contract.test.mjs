import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Message-area extension contract guard — the message scroll-nav extension (navigation bar)
// and the message anchor-banner extension are pure-frontend extensions that rely entirely on
// contract attributes the core stamps onto the DOM, with zero server-side API. Upstream sees
// these attributes as meaningless bare attributes, so merges most often silently drop them
// (2026-08-26 c3db1c1 dropped data-chat-msg-role, and the nav's ▲▼ prev/next user-input
// targeting silently died — see the merge-notes doc, item ⑨). This file watches the contract
// wiring: any item lost in a merge turns red immediately.
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("message wrapper div carries the data-chat-msg-role contract", () => {
  // ⑨ Root cause: the scroll-nav extension's ▲prev/▼next user-input targeting relies on
  // [data-chat-msg-role="user"]; once the attribute is dropped in a merge, getUserEls()
  // filters to empty → prev/next silently return. It must be stamped on the message wrapper
  // div carrying attachVisibleRef, with the role taken from the msg.role expression.
  // (After the experimental merge, ref became the attachRef conditional; the wrapper div
  // still carries both contracts.)
  assert.match(source, /data-chat-msg-role=\{msg\.role\}/);
  assert.match(source, /ref=\{options\.attachRef === false \? undefined : attachVisibleRef\(idx, currentRefIdx\)\}/);
});

test("scroll container carries the data-chat-scroll contract", () => {
  // The other half of the contract: ⏫ jump-to-earliest / ⏬ jump-to-latest / button visibility
  // (atTop/atBottom) all use it to find the scroll container.
  assert.match(source, /ref=\{handleScrollBoxRef\} data-chat-scroll/);
});

test("both user and assistant messages remain visible (and thus nav targets)", () => {
  // Narrowing isVisible (e.g. upstream rerouting user messages away from this render path)
  // would leave ▲▼ with no targets to jump to; user messages must enter the wrapper-div
  // render branch on equal footing with assistant messages.
  // (After the experimental merge, upstream's isMessageGroupAnchor criterion = user +
  // compaction anchors was adopted, which covers more cases.)
  assert.match(source, /const isVisible = isMessageGroupAnchor\(msg\) \|\| msg\.role === "assistant";/);
  assert.match(
    source,
    /if \(!isVisible \|\| currentRefIdx === undefined\) return view;/,
  );
});

test("chatOverlay slot stays wired for the nav toolbar extension", () => {
  // After the built-in ScrollToolbar was extracted into the scroll-nav extension (4678bc9),
  // the core is left with only this slot mount point; the agentRunning/isMobile passthrough
  // drives "keep-alive while long-pressing jump-to-latest" and mobile edge-snapping;
  // revealHistory (2026-09-06) lets jump-to-earliest/prev targets expand the full history
  // when they fall outside the render window (same source as ChatMinimap's onRevealHistory,
  // a one-shot setVisibleCount(messages.length*2)).
  assert.match(source, /<ExtSlot\n\s+name="chatOverlay"/);
  assert.match(source, /extra=\{\{ agentRunning, isMobile, revealHistory: revealHistoryForMinimap,[\s\S]*?backendSource \}\}/); // P3 de-coring: usage-badge data is passed through with the slot (display belongs to the provider-usage extension)
});

test("chatOverlay slot keeps passing currentSession for the anchor banner", () => {
  // The anchor-banner extension's title mode falls back on firstMessage (f1ac17a/94d3435);
  // this passthrough was added even later than the slot itself and is even less recognized
  // upstream, so merges would likewise drop it as redundant.
  assert.match(source, /firstMessage: session\.firstMessage/);
});
