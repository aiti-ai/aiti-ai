/**
 * diff-eol.ts tests — EOL normalization, hunk building and count sourcing.
 *
 * The first dmp case pins the actual bug: an LF blob vs a CRLF worktree copy
 * of the same file is reported by dmp as a whole-file replacement.
 *
 * Run: node --experimental-strip-types --test extensions/aiti-editor/client/src/diff-eol.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const {
  normalizeDiffEol, detectEolKind, isEolOnlyChange, countLines,
  hunksFromDiffs, pickDiffCounts,
} = await import("./diff-eol.ts");

const require = createRequire(import.meta.url);
const DiffMatchPatch = require("../../vendor/diff-match-patch.js");
const dmp = new DiffMatchPatch();

function dmpDiffs(a, b) {
  const toChars = dmp.diff_linesToChars_ || dmp.diff_linesToChars;
  const toLines = dmp.diff_charsToLines_ || dmp.diff_charsToLines;
  const mapped = toChars.call(dmp, a, b);
  const diffs = dmp.diff_main(mapped.chars1, mapped.chars2, false);
  toLines.call(dmp, diffs, mapped.lineArray);
  return diffs;
}

test("normalizeDiffEol: CRLF and lone CR collapse to LF, LF untouched", () => {
  assert.equal(normalizeDiffEol("a\r\nb\r\n"), "a\nb\n");
  assert.equal(normalizeDiffEol("a\rb\r"), "a\nb\n");
  assert.equal(normalizeDiffEol("a\nb\n"), "a\nb\n");
  assert.equal(normalizeDiffEol(""), "");
});

test("detectEolKind: lf / crlf / mixed / none", () => {
  assert.equal(detectEolKind("a\nb\n"), "lf");
  assert.equal(detectEolKind("a\r\nb\r\n"), "crlf");
  assert.equal(detectEolKind("a\r\nb\n"), "mixed");
  assert.equal(detectEolKind("no-newline"), "none");
  assert.equal(detectEolKind(""), "none");
});

test("isEolOnlyChange: EOL-only diff is detected, real edits are not", () => {
  assert.equal(isEolOnlyChange("a\nb\n", "a\r\nb\r\n"), true);
  assert.equal(isEolOnlyChange("a\nb\n", "a\nb\n"), false);              // identical
  assert.equal(isEolOnlyChange("a\nb\n", "a\nc\r\n"), false);            // real content change
  assert.equal(isEolOnlyChange("a\nb\n", "a\nb\nextra\n"), false);       // added line
});

test("countLines matches the hunk builder semantics", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
});

test("hunksFromDiffs: CRLF-vs-LF is a whole-file hunk before normalization, none after", () => {
  const lf = "alpha\nbeta\ngamma\n";
  const crlf = "alpha\r\nbeta\r\ngamma\r\n";

  const raw = dmpDiffs(lf, crlf);
  const rawHunks = hunksFromDiffs(raw);
  assert.equal(rawHunks.length, 1);
  assert.equal(rawHunks[0].adds, 3);
  assert.equal(rawHunks[0].dels, 3);

  const normalized = dmpDiffs(normalizeDiffEol(lf), normalizeDiffEol(crlf));
  assert.deepEqual(hunksFromDiffs(normalized), []);
});

test("hunksFromDiffs: line-ending noise plus one real edit yields exactly one hunk", () => {
  const lf = "alpha\nbeta\ngamma\n";
  const edited = "alpha\r\nBETA\r\ngamma\r\n";
  const diffs = dmpDiffs(normalizeDiffEol(lf), normalizeDiffEol(edited));
  const hunks = hunksFromDiffs(diffs);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].adds, 1);
  assert.equal(hunks[0].dels, 1);
  assert.equal(hunks[0].newStart, 2);
});

test("hunksFromDiffs: pure addition at EOF", () => {
  const hunks = hunksFromDiffs(dmpDiffs("a\nb\n", "a\nb\nc\n"));
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].adds, 1);
  assert.equal(hunks[0].dels, 0);
  assert.equal(hunks[0].newStart, 3);
});

test("pickDiffCounts: dmp already computed wins, including zero hunks", () => {
  const hunks = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, adds: 1, dels: 1, preview: "" }];
  assert.deepEqual(
    pickDiffCounts({ hunks, dmpComputed: true, numstat: { adds: 94, dels: 91 } }),
    { adds: 1, dels: 1, source: "dmp" },
  );
  assert.deepEqual(
    pickDiffCounts({ hunks: [], dmpComputed: true, numstat: { adds: 94, dels: 91 } }),
    { adds: 0, dels: 0, source: "dmp" },
  );
});

test("pickDiffCounts: numstat fallback only before dmp runs", () => {
  assert.deepEqual(
    pickDiffCounts({ hunks: [], dmpComputed: false, numstat: { adds: 3, dels: 1 } }),
    { adds: 3, dels: 1, source: "numstat" },
  );
  assert.deepEqual(
    pickDiffCounts({ hunks: [], dmpComputed: false, numstat: { adds: null, dels: null } }),
    { adds: null, dels: null, source: "none" },
  );
  assert.deepEqual(
    pickDiffCounts({ hunks: [], dmpComputed: false }),
    { adds: null, dels: null, source: "none" },
  );
});
