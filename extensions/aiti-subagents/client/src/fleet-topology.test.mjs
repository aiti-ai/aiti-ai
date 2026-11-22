/**
 * fleet-topology · pure builder tests (topology view data layer, borrow plan §2.2).
 * Run: node --test extensions/aiti-subagents/client/src/fleet-topology.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopology, topologyCounts, topologyLayers } from "./fleet-topology.mjs";

const run = (id, opts = {}) => ({
  id,
  agent: opts.agent || "worker",
  status: opts.status || "completed",
  createdAt: opts.createdAt ?? 1000,
  sessionFile: opts.sessionFile ?? `/s/${id}.jsonl`,
  parentSessionFile: opts.parent ?? null,
  task: opts.task || `task ${id}`,
});

test("flat runs: every row is a root at depth 0", () => {
  const t = buildTopology([run("a"), run("b", { createdAt: 500 })]);
  assert.equal(t.nodes.length, 2);
  assert.equal(t.roots.length, 2);
  assert.equal(t.maxDepth, 0);
  assert.equal(t.roots[0].run.id, "a"); // newest first
  assert.equal(t.roots[1].run.id, "b");
});

test("linear chain: parent→child nesting by sessionFile", () => {
  const t = buildTopology([
    run("child", { parent: "/s/parent.jsonl" }),
    run("parent"),
  ]);
  assert.equal(t.roots.length, 1);
  assert.equal(t.roots[0].run.id, "parent");
  assert.equal(t.roots[0].children.length, 1);
  assert.equal(t.roots[0].children[0].run.id, "child");
  assert.equal(t.roots[0].depth, 0);
  assert.equal(t.roots[0].children[0].depth, 1);
  assert.equal(t.maxDepth, 1);
});

test("grandchild chain reaches depth 2", () => {
  const t = buildTopology([
    run("gc", { parent: "/s/c.jsonl" }),
    run("c", { parent: "/s/p.jsonl" }),
    run("p"),
  ]);
  assert.equal(t.maxDepth, 2);
  const p = t.roots[0];
  assert.equal(p.children[0].children[0].run.id, "gc");
});

test("parallel siblings under one parent keep launch order", () => {
  const t = buildTopology([
    run("s3", { parent: "/s/p.jsonl", createdAt: 3000 }),
    run("s1", { parent: "/s/p.jsonl", createdAt: 1000 }),
    run("s2", { parent: "/s/p.jsonl", createdAt: 2000 }),
    run("p"),
  ]);
  const kids = t.roots[0].children.map((n) => n.run.id);
  assert.deepEqual(kids, ["s1", "s2", "s3"]);
  assert.equal(t.maxDepth, 1);
});

test("missing parent session surfaces as root (orphan)", () => {
  const t = buildTopology([run("child", { parent: "/s/unknown-session.jsonl" })]);
  assert.equal(t.roots.length, 1);
  assert.equal(t.roots[0].orphan, true);
  assert.equal(t.maxDepth, 0);
});

test("cycle members are demoted to roots, nothing disappears", () => {
  const t = buildTopology([
    run("a", { sessionFile: "/s/a.jsonl", parent: "/s/b.jsonl" }),
    run("b", { sessionFile: "/s/b.jsonl", parent: "/s/a.jsonl" }),
  ]);
  assert.equal(t.roots.length + countNonRoots(t), t.nodes.length);
  assert.ok(t.roots.length >= 1);
});

function countNonRoots(t) {
  let n = 0;
  for (const node of t.nodes) if (!node.orphan) n++;
  return n;
}

test("same-parent shared session file keeps single node entry (first wins)", () => {
  // two rows sharing one sessionFile: dedupe index keeps first, second still reachable as sibling
  const t = buildTopology([
    run("p"),
    run("c1", { parent: "/s/p.jsonl", sessionFile: "/s/dup.jsonl" }),
    run("c2", { parent: "/s/p.jsonl", sessionFile: "/s/dup.jsonl" }),
  ]);
  assert.equal(t.roots[0].children.length, 2);
  assert.equal(t.maxDepth, 1);
});

test("topologyLayers bands nodes by depth from roots", () => {
  const t = buildTopology([
    run("gc", { parent: "/s/c.jsonl", createdAt: 100 }),
    run("c", { parent: "/s/p.jsonl", createdAt: 200 }),
    run("p"),
    run("solo"),
  ]);
  const layers = topologyLayers(t);
  assert.equal(layers.length, 3); // maxDepth 2 → 3 bands
  assert.equal(layers[0].length, 2); // p + solo
  assert.equal(layers[1].length, 1);
  assert.equal(layers[2].length, 1);
  assert.equal(topologyCounts(t).total, 4);
});

test("empty / malformed input stays safe", () => {
  assert.equal(buildTopology([]).nodes.length, 0);
  assert.equal(buildTopology(undefined).nodes.length, 0);
  assert.equal(buildTopology([null, 42, run("ok")]).nodes.length, 1);
});
