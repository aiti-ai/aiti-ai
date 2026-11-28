/**
 * pick-header.test.mjs — commit-message header insertion (tests pick-header.ts directly).
 * Run: node --test tests/pick-header.test.mjs
 *
 * Covers: prependHeader idempotency (no duplicate header) and separators
 * ("\n\n" textarea vs " " single-line plan input).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { prependHeader } = await import("../client/src/pick-header.ts");

const HEADER = "#123 Bug Fix login timeout";

test("prependHeader: empty message takes the header alone", () => {
  assert.equal(prependHeader(HEADER, "", "\n\n"), HEADER);
  assert.equal(prependHeader(HEADER, "", " "), HEADER);
});

test("prependHeader: prepends with the given separator", () => {
  assert.equal(prependHeader(HEADER, "fix: bug", "\n\n"), HEADER + "\n\nfix: bug");
  assert.equal(prependHeader(HEADER, "fix: bug", " "), HEADER + " fix: bug");
});

test("prependHeader: idempotent when the message already starts with the header", () => {
  const withHeader = HEADER + "\n\nfix: bug";
  assert.equal(prependHeader(HEADER, withHeader, "\n\n"), withHeader);
  const inline = HEADER + " fix: bug";
  assert.equal(prependHeader(HEADER, inline, " "), inline);
});

test("prependHeader: leading whitespace in the message is dropped before the header", () => {
  assert.equal(prependHeader(HEADER, "  fix: bug", " "), HEADER + " fix: bug");
});
