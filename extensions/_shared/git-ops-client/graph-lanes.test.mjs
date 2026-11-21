/**
 * graph-lanes · pure parser tests (graph view data layer, borrow plan §2.1).
 * Run: node --experimental-strip-types --test extensions/_shared/git-ops-client/graph-lanes.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignLanes, laneColor, parseGraphRow, parseGraphRows } from "./graph-lanes.mjs";

test("plain straight line: node on lane 0, subject kept", () => {
  const row = parseGraphRow("* abc1234 fix: parser edge");
  assert.equal(row.graph, "*");
  assert.equal(row.sha, "abc1234");
  assert.deepEqual(row.refs, []);
  assert.equal(row.subject, "fix: parser edge");
});

test("decorate=short: HEAD -> main / tag / remote badges split", () => {
  const row = parseGraphRow("* abc1234 (HEAD -> main, origin/main, tag: v1.0) init");
  assert.deepEqual(row.refs, ["HEAD -> main", "origin/main", "tag: v1.0"]);
  assert.equal(row.subject, "init");
});

test("bare HEAD decoration", () => {
  const row = parseGraphRow("* abc1234 (HEAD) detached subject");
  assert.deepEqual(row.refs, ["HEAD"]);
  assert.equal(row.subject, "detached subject");
});

test("paren group right after sha is treated as decorations (bare words are valid branch names, indistinguishable)", () => {
  const row = parseGraphRow("* abc1234 (WIP) fix things");
  assert.deepEqual(row.refs, ["WIP"]);
  assert.equal(row.subject, "fix things");
});

test("merge commit line: wide graph prefix, sha extracted", () => {
  const row = parseGraphRow("*   deadbee Merge branch 'feature'");
  assert.equal(row.sha, "deadbee");
  assert.equal(row.subject, "Merge branch 'feature'");
});

test("continuation rows (bare art, no sha) kept as graph-only rows", () => {
  const a = parseGraphRow("|\\");
  assert.equal(a.sha, null);
  assert.equal(a.graph, "|\\");
  const b = parseGraphRow("|/");
  assert.equal(b.sha, null);
  const c = parseGraphRow("| |/");
  assert.equal(c.sha, null);
  assert.equal(c.graph, "| |/");
});

test("non-graph line returns null (caller falls back to raw)", () => {
  assert.equal(parseGraphRow("hello world"), null);
  assert.equal(parseGraphRow(""), null);
  assert.equal(parseGraphRow(null), null);
});

test("parseGraphRows: unparseable lines become { raw } fallback rows", () => {
  const rows = parseGraphRows(["* abc1234 ok", "weird line"]);
  assert.equal(rows[0].sha, "abc1234");
  assert.equal(rows[1].raw, "weird line");
});

test("assignLanes: straight history, single lane", () => {
  const rows = assignLanes(parseGraphRows(["* aaa1111 second", "* bbb2222 first"]));
  assert.equal(rows[0].nodeCol, 0);
  assert.equal(rows[1].nodeCol, 0);
  assert.equal(rows[0].lanes.length, 1);
  assert.equal(rows[0].lanes[0][0], 0);
});

test("assignLanes: branch-out inherits pipe, branch gets own lane color", () => {
  const rows = assignLanes(parseGraphRows([
    "* aaa1111 main tip",
    "|\\",
    "| * bbb2222 on feature",
    "|/",
    "* ccc3333 main base",
  ]));
  const mainId = rows[0].lanes[0][1];
  // row `|\`: main pipe col0 keeps main color; branch lane at col2 is new
  const branchRow = rows[1];
  assert.deepEqual(branchRow.lanes.map((e) => e[0]).sort((a, b) => a - b), [0, 2]);
  assert.equal(branchRow.lanes.find((e) => e[0] === 0)[1], mainId);
  const branchId = branchRow.lanes.find((e) => e[0] === 2)[1];
  assert.notEqual(branchId, mainId);
  // row `| *`: node at col2 inherits the branch lane
  assert.equal(rows[2].nodeCol, 2);
  assert.equal(rows[2].lanes.find((e) => e[0] === 2)[1], branchId);
  // row `|/`: pipe at col0 stays main; merge junction does not steal main's color
  assert.equal(rows[3].lanes.find((e) => e[0] === 0)[1], mainId);
  // row `* col0`: back on main lane color
  assert.equal(rows[4].nodeCol, 0);
  assert.equal(rows[4].lanes.find((e) => e[0] === 0)[1], mainId);
});

test("assignLanes: merge edge keeps collapsing lane color via prevLanes", () => {
  const rows = assignLanes(parseGraphRows(["* aaa1111 tip", "|\\", "| * bbb2222 feat", "|/", "* ccc3333 base"]));
  const branchId = rows[1].lanes.find((e) => e[0] === 2)[1];
  const prevMap = new Map(rows[3].prevLanes);
  assert.equal(prevMap.get(2), branchId); // `/` edge at row `|/` pulls the feature lane color
});

test("assignLanes: raw fallback rows carry empty lane maps", () => {
  const rows = assignLanes(parseGraphRows(["* abc1234 ok", "not art"]));
  assert.deepEqual(rows[1].lanes, []);
  assert.equal(rows[1].nodeCol, -1);
});

test("laneColor: stable per id, cycles within palette", () => {
  assert.equal(laneColor(0), laneColor(0));
  assert.equal(laneColor(7), laneColor(1));
  assert.equal(laneColor(-3), laneColor(3)); // negative ids still map into the palette
});

test("octopus-ish merge: every row parses, no raw fallback", () => {
  const rows = assignLanes(parseGraphRows([
    "*   aaa1111 Merge branches 'b1' and 'b2'",
    "|\\",
    "| \\",
    "|  \\",
    "| * bbb2222 on b2",
    "* | ccc3333 on b1",
    "|/",
    "* ddd4444 base",
  ]));
  assert.equal(rows[0].sha, "aaa1111");
  assert.equal(rows[1].sha, null);
  assert.equal(rows[4].nodeCol, 2);
  assert.equal(rows[5].nodeCol, 0);
  assert.ok(rows.every((r) => r.raw === undefined));
});
