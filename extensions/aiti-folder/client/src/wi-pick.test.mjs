/**
 * wi-pick.test.mjs — work-item header insertion (tests wi-pick-core.ts directly).
 * Run: node --test extensions/aiti-folder/client/src/wi-pick.test.mjs
 *
 * Covers: prependHeader idempotency (no duplicate header) and separators
 * ("\n\n" textarea vs " " single-line plan input). The service call itself
 * (pickWorkItemHeader in wi-pick.ts) is a thin extSvc lookup, covered by the
 * integration path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { prependHeader } = await import("./wi-pick-core.ts");

const HEADER = "#123 任务 标题";

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
