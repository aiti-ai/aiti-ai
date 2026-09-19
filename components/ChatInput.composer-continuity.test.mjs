import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { isDraftKeyPromotion } = await jiti.import("./ChatInput.tsx");

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");

// Second root cause of "input interrupted while the AI is showing" on small screens (unrelated to scrolling):
//  ① New-session promotion (provisional `new:…` → real sid) went through the "switch-session clears the composer" path →
//    the next input the user had just typed during the AI answer was swallowed in front of them by setValue("");
//  ② At send time the composer moves from the welcome page to the bottom of the message stream (two different DOM
//    locations → the whole ChatInput remounts) → focus dies with the old node: the mobile keyboard closes and IME composition is lost.
test("a new-session promotion keeps the in-progress composer text", () => {
  // Rule: only `new:…` → non-`new:…` counts as a promotion
  assert.equal(isDraftKeyPromotion("new:abc123:/repo", "1b63f5ac-134c-40b8-9d80-f61288e0039c"), true);
  // First mount (previous undefined) / switching to another new-session page / clearing the key are not promotions → clear as before
  assert.equal(isDraftKeyPromotion(undefined, "1b63f5ac"), false);
  assert.equal(isDraftKeyPromotion("new:a:/repo", "new:b:/repo"), false);
  assert.equal(isDraftKeyPromotion("1b63f5ac", undefined), false);

  const draftKeyEffectSource = source.slice(
    source.indexOf("  useEffect(() => {\n    const previousDraftKey = draftKeyRef.current;"),
    source.indexOf("// Cross-session prefill"),
  );
  // On promotion only the key changes + a broadcast fires; the value and attachments are not cleared (the broadcast must run before the clear early-return — the keeper relies on it to redirect the slot)
  assert.match(draftKeyEffectSource, /emitComposerKeyChange\(previousDraftKey, draftKey\);[\s\S]*?if \(isDraftKeyPromotion\(previousDraftKey, draftKey\)\) return;/);
  const broadcastIdx = draftKeyEffectSource.indexOf("emitComposerKeyChange(previousDraftKey, draftKey);");
  const promoteIdxFirst = draftKeyEffectSource.indexOf("if (isDraftKeyPromotion(");
  assert.ok(broadcastIdx !== -1 && broadcastIdx < promoteIdxFirst, "the key-change broadcast must still fire on a promotion (keeper redirects the slot on it)");
  const clearIdx = draftKeyEffectSource.indexOf('setValue("");');
  const promoteIdx = draftKeyEffectSource.indexOf("if (isDraftKeyPromotion(");
  assert.ok(clearIdx > promoteIdx, "the clear must stay behind the promotion early-return");
});

test("the composer hands focus over across the welcome→composer remount", () => {
  const handoffSource = source.slice(
    source.indexOf("let composerLiveFocused = false;"),
    source.indexOf("const ChatInputInner = forwardRef"),
  );
  assert.match(handoffSource, /let pendingFocusHandoff = false;/);

  const effectSource = source.slice(
    source.indexOf("  // Focus hand-off across remounts"),
    source.indexOf("// Collapse the Send button label"),
  );
  // Re-attach on mount + bookkeeping on unmount; preventScroll prevents "restoring focus from scrolling the page as a side effect"
  assert.match(effectSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(effectSource, /ta\.focus\(\{ preventScroll: true \}\)/);
  assert.match(effectSource, /return \(\) => \{\s*pendingFocusHandoff = composerLiveFocused;/);
  // Focus state is maintained by real focus/blur events (when the node is detached, the browser-dispatched blur
  // does not go through React delegation, so the value read before unmount means "the user didn't actively click elsewhere")
  assert.match(source, /const handleFocus = useCallback\(\(\) => \{\s*composerLiveFocused = true;/);
  assert.match(source, /const handleBlur = useCallback\(\(\) => \{\s*composerLiveFocused = false;/);
  assert.match(source, /onFocus=\{handleFocus\}\s*onBlur=\{handleBlur\}/);
});
