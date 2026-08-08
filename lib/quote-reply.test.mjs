import assert from "node:assert/strict";
import test from "node:test";
import { detectOptions, formatQuote, parseParagraph, splitQuestions } from "./quote-reply.ts";

test("quoted replies preserve underscores in identifiers and env var names", () => {
  // Regression: clean() used to strip `_` as if it were markdown emphasis,
  // mangling PI_WEB_BASE_DOMAIN → PIWEBBASEDOMAIN in quoted replies.
  assert.equal(formatQuote("命名你定：PI_WEB_BASE_DOMAIN"), "> 命名你定：PI_WEB_BASE_DOMAIN\n");
  const [seg] = splitQuestions("用 PI_WEB_BASE_DOMAIN 还是 PIWEBPROXYSUBFIX？");
  assert.match(seg, /PI_WEB_BASE_DOMAIN/);
  assert.match(seg, /PIWEBPROXYSUBFIX/);
});

test("splitQuestions keeps an A-还是-B choice whole with underscores intact", () => {
  const parts = splitQuestions("命名你定：PI_WEB_BASE_DOMAIN 还是 PIWEBPROXYSUBFIX？");
  assert.deepEqual(parts, ["命名你定：PI_WEB_BASE_DOMAIN 还是 PIWEBPROXYSUBFIX？"]);
});

test("formatQuote keeps the rendered text verbatim (no markdown processing)", () => {
  // The input is already-rendered text — literal chars survive quoting.
  assert.equal(formatQuote("用 *斜体* 强调 `code` ~~删除~~"), "> 用 *斜体* 强调 `code` ~~删除~~\n");
});

test("detectOptions still recognizes A-还是-B choices and keeps underscores", () => {
  const options = detectOptions("命名你定：PI_WEB_BASE_DOMAIN 还是 PIWEBPROXYSUBFIX？");
  assert.ok(options, "expected a choice to be detected");
  assert.equal(options.length, 2);
  assert.ok(options.some((o) => o.value.includes("PI_WEB_BASE_DOMAIN")));
  assert.ok(options.some((o) => o.value.includes("PIWEBPROXYSUBFIX")));
});

test("parseParagraph yields options + full quoted segment for env-var choices", () => {
  const [seg] = parseParagraph("用 PI_WEB_BASE_DOMAIN 还是 PIWEBPROXYSUBFIX？");
  assert.equal(seg.text, "用 PI_WEB_BASE_DOMAIN 还是 PIWEBPROXYSUBFIX？");
  assert.ok(seg.options?.length === 2);
});

test("detectOptions parses 或者还是 with longest-alternative-first ordering", () => {
  // Regression: `或者还是` was listed AFTER `还是`, so the engine matched
  // `还是` inside "或者还是" first and b came out as "还是 B".
  const options = detectOptions("A 或者还是 B？");
  assert.ok(options, "expected a choice to be detected");
  assert.equal(options[0].value, "A");
  assert.equal(options[1].value, "B");
});

test("English yes/no question containing 'show' gets Yes/No options", () => {
  // Regression: 'show' contains the substring 'how', which used to trip the
  // open-ended detector and suppress the yes/no buttons entirely.
  const s = "Want me to show a diff summary of the modified files?";
  assert.deepEqual(detectOptions(s), [
    { label: "Yes", value: "Yes" },
    { label: "No", value: "No" },
  ]);
  const [seg] = parseParagraph(s);
  assert.equal(seg.text, s);
  assert.equal(seg.options?.length, 2);
});

test("English open-ended cues still suppress yes/no options (word-boundary aware)", () => {
  assert.equal(detectOptions("How do I fix this?"), null);
  assert.equal(detectOptions("What's the best approach?"), null);
  assert.equal(detectOptions("Which file should I edit?"), null);
  assert.equal(detectOptions("Where did you put it?"), null);
  // Word-boundary safety: substrings inside other words are not cues.
  assert.ok(detectOptions("Can you show the change somewhere?")?.length === 2);
});

test("English yes/no question with a short extractable action gets English buttons", () => {
  // Regression: the Chinese action path (好，X / 不用) fired before the
  // English fallback whenever the extracted action was ≤16 chars, so
  // "Should I proceed?" / "Can you fix it?" got mixed-language buttons.
  assert.deepEqual(detectOptions("Should I proceed?"), [
    { label: "Yes", value: "Yes" },
    { label: "No", value: "No" },
  ]);
  assert.deepEqual(detectOptions("Can you fix it?"), [
    { label: "Yes", value: "Yes" },
    { label: "No", value: "No" },
  ]);
});

test("Chinese yes/no question keeps Chinese buttons", () => {
  assert.deepEqual(detectOptions("需要我帮你看看吗？"), [
    { label: "好，帮你看看", value: "是的" },
    { label: "不用", value: "不用了" },
  ]);
  assert.deepEqual(detectOptions("刚才我们讨论的那个方案现在还要继续推进吗？"), [
    { label: "是", value: "是的" },
    { label: "否", value: "不用了" },
  ]);
});
