import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./external-session-paging.ts");
}

function rawEntries(n) {
  return Array.from({ length: n }, (_, i) => ({ role: "user", content: [{ type: "text", text: `m${i}` }] }));
}

test("initial load returns only the tail with synthesized entry ids", async () => {
  const { buildExternalPagedContext } = await loadSubject();
  const r = buildExternalPagedContext(rawEntries(120), { tail: 50 });
  assert.equal(r.messages.length, 50);
  assert.equal(r.messages[0].content[0].text, "m70");
  assert.equal(r.entryIds[0], "ext-70");
  assert.equal(r.entryIds[49], "ext-119");
  assert.equal(r.oldestEntryId, "ext-70");
  assert.equal(r.hasMore, true);
  assert.equal(r.totalCount, 120);
});

test("no paging opts returns everything with hasMore=false", async () => {
  const { buildExternalPagedContext } = await loadSubject();
  const r = buildExternalPagedContext(rawEntries(10));
  assert.equal(r.messages.length, 10);
  assert.equal(r.hasMore, false);
  assert.equal(r.oldestEntryId, "ext-0");
});

test("before page excludes the marker entry and stops at zero", async () => {
  const { buildExternalPagedContext } = await loadSubject();
  const r = buildExternalPagedContext(rawEntries(120), { tail: 50, before: "ext-70" });
  assert.equal(r.messages.length, 50);
  assert.equal(r.messages[0].content[0].text, "m20");
  assert.equal(r.messages[49].content[0].text, "m69"); // excludes ext-70 itself
  assert.equal(r.oldestEntryId, "ext-20");
  assert.equal(r.hasMore, true);

  const last = buildExternalPagedContext(rawEntries(120), { tail: 50, before: "ext-20" });
  assert.equal(last.messages.length, 20);
  assert.equal(last.messages[0].content[0].text, "m0");
  assert.equal(last.hasMore, false);
});

test("parseExternalEntryId rejects non-marker ids", async () => {
  const { parseExternalEntryId } = await loadSubject();
  assert.equal(parseExternalEntryId("ext-42"), 42);
  assert.equal(parseExternalEntryId("ext-abc"), null);
  assert.equal(parseExternalEntryId("some-uuid"), null);
  assert.equal(parseExternalEntryId(null), null);
});

test("clampTailParam clamps and falls back", async () => {
  const { clampTailParam } = await loadSubject();
  assert.equal(clampTailParam("200"), 200);
  assert.equal(clampTailParam("5000"), 1000);
  assert.equal(clampTailParam("-3"), 50);
  assert.equal(clampTailParam(null), 50);
  assert.equal(clampTailParam("abc"), 50);
});
