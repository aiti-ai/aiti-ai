/**
 * client-modules boot-graph tests (docs/dsh-adapter-assessment.md §5.1).
 * Run: node --experimental-strip-types --test lib/ext/client-modules.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildBootGraph, EMPTY_BOOT_GRAPH, hashText } from "./client-modules.ts";

test("empty input yields the empty graph", () => {
  assert.deepEqual(buildBootGraph([]), EMPTY_BOOT_GRAPH);
  assert.deepEqual(buildBootGraph([{ id: "x", assetUrl: "/a", hash: "" }]), EMPTY_BOOT_GRAPH);
});

test("composes rows with rev-anchored URLs and a whole-graph rev", () => {
  const g = buildBootGraph([
    { id: "a", assetUrl: "/api/extensions/a/assets/client.js", hash: "aaaa1111aaaa" },
    { id: "b", assetUrl: "/api/extensions/b/assets/client.mjs", hash: "bbbb2222bbbb", immediately: false },
  ]);
  assert.equal(g.entries.length, 2);
  assert.equal(g.entries[0].url, "/api/extensions/a/assets/client.js?rev=aaaa1111aaaa");
  assert.equal(g.entries[1].url, "/api/extensions/b/assets/client.mjs?rev=bbbb2222bbbb");
  assert.equal(g.entries[1].immediately, false);
  assert.ok(g.rev.length === 12 && /^[0-9a-f]{12}$/.test(g.rev));
});

test("graph rev changes when any row changes (consistency anchor)", () => {
  const base = [
    { id: "a", assetUrl: "/a", hash: "aaaa1111aaaa" },
    { id: "b", assetUrl: "/b", hash: "bbbb2222bbbb" },
  ];
  const g1 = buildBootGraph(base);
  const g2 = buildBootGraph([...base, { id: "c", assetUrl: "/c", hash: "cccc3333cccc" }]);
  const g3 = buildBootGraph(base.map((e) => (e.id === "a" ? { ...e, hash: "aaaa9999aaaa" } : e)));
  assert.notEqual(g2.rev, g1.rev, "row added → rev changes");
  assert.notEqual(g3.rev, g1.rev, "rev changed → rev changes");
  assert.equal(buildBootGraph(base).rev, g1.rev, "identical input → identical rev");
});

test("inject edges are informational and optional", () => {
  const g = buildBootGraph([
    { id: "a", assetUrl: "/a", hash: "aaaa1111aaaa" },
    { id: "b", assetUrl: "/b", hash: "bbbb2222bbbb", inject: ["a"] },
  ]);
  assert.deepEqual(g.entries[1].inject, ["a"]);
  assert.equal(g.entries[0].inject, undefined);
});

test("hashText is a stable sha256 prefix", () => {
  assert.equal(hashText("hello"), hashText("hello"));
  assert.notEqual(hashText("hello"), hashText("world"));
  assert.ok(/^[0-9a-f]{12}$/.test(hashText("anything")));
});

// ---- 统一 SSE 端口方案 §3-B：priority 透传（前端 materialize 优先级）----

test("priority passes through to rows; zero/undefined omitted", () => {
  const g = buildBootGraph([
    { id: "bus", assetUrl: "/b", hash: "bbbb2222bbbb", priority: 100 },
    { id: "a", assetUrl: "/a", hash: "aaaa1111aaaa", priority: 0 },
    { id: "z", assetUrl: "/z", hash: "zzzz3333zzzz" },
  ]);
  assert.equal(g.entries[0].priority, 100);
  assert.equal(g.entries[1].priority, undefined, "priority 0 = 缺省，不写进图行");
  assert.equal(g.entries[2].priority, undefined);
});

test("graph rev changes when priority changes (scheduling is part of the graph)", () => {
  const g1 = buildBootGraph([{ id: "a", assetUrl: "/a", hash: "aaaa1111aaaa", priority: 100 }]);
  const g2 = buildBootGraph([{ id: "a", assetUrl: "/a", hash: "aaaa1111aaaa", priority: 200 }]);
  assert.notEqual(g1.rev, g2.rev, "priority 变化 → 图 rev 变化（前端对账感知）");
});
