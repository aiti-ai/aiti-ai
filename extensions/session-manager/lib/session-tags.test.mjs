/**
 * session-manager tag tree pure-function tests.
 * Run: node --experimental-strip-types --test ~/.pi/web/extensions/session-manager/lib/session-tags.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

const { ...mod } = await import("./session-tags.ts");
const {
  defaultColorFor, findOrCreateTagPath, tagPath, parseTagPath, descendants,
  matchTagFilter, renameTagNode, deleteTagNode, setTagColor, toggleFavorite,
  setSessionTag, buildTagTree, validateTagData, emptyTagData, byIdMap,
} = mod;

test("defaultColorFor: common-name map + deterministic palette fallback", () => {
  assert.equal(defaultColorFor("todo"), "#f59e0b");
  assert.equal(defaultColorFor("TODO"), "#f59e0b"); // case-insensitive
  assert.equal(defaultColorFor("urgent"), "#ef4444");
  // 状态 tag（用户定稿：已解决=绿 / 未解决=灰）
  assert.equal(defaultColorFor("已解决"), "#22c55e");
  assert.equal(defaultColorFor("未解决"), "#64748b");
  assert.equal(defaultColorFor("resolved"), "#22c55e");
  assert.equal(defaultColorFor("unresolved"), "#64748b");
  const a = defaultColorFor("client-x");
  const b = defaultColorFor("client-x");
  assert.equal(a, b); // stable
  assert.match(a, /^#[0-9a-f]{6}$/);
});

test("parseTagPath: valid + invalid", () => {
  assert.deepEqual(parseTagPath(" 项目A / todo "), ["项目A", "todo"]);
  assert.deepEqual(parseTagPath("bugfix"), ["bugfix"]);
  assert.equal(parseTagPath(""), null);
  assert.equal(parseTagPath("/a"), null);
  assert.equal(parseTagPath("a/"), null);
  assert.equal(parseTagPath("a//b"), null);
  assert.equal(parseTagPath("a/b/c/d/e/f/g/h/i"), null); // 9 segments
});

test("findOrCreateTagPath: creates chain with persisted default colors, idempotent", () => {
  let data = emptyTagData();
  const r1 = findOrCreateTagPath(data, "项目A/todo");
  assert.ok(r1);
  data = r1.data;
  assert.equal(data.tags.length, 2);
  const byId = byIdMap(data);
  const todo = byId.get(r1.leafId);
  assert.equal(todo.name, "todo");
  assert.equal(todo.color, "#f59e0b"); // default persisted at creation
  assert.equal(tagPath(todo, byId), "项目A/todo");

  // idempotent — same path reuses nodes
  const r2 = findOrCreateTagPath(data, "项目A/todo");
  assert.equal(r2.leafId, r1.leafId);
  assert.equal(r2.data.tags.length, 2);

  // case-insensitive reuse
  const r3 = findOrCreateTagPath(data, "项目A/TODO");
  assert.equal(r3.leafId, r1.leafId);
});

test("descendants + matchTagFilter (OR, ancestor semantics)", () => {
  let data = emptyTagData();
  data = findOrCreateTagPath(data, "项目A/todo").data;
  const byId = byIdMap(data);
  const rootA = data.tags.find((t) => t.name === "项目A");
  const leaf = data.tags.find((t) => t.name === "todo");

  assert.deepEqual(descendants(rootA.id, byId).sort(), [rootA.id, leaf.id].sort());

  // leaf selected → matches session tagged with leaf
  assert.equal(matchTagFilter([leaf.id], [leaf.id], byId), true);
  // parent selected → matches descendant-tagged session
  assert.equal(matchTagFilter([leaf.id], [rootA.id], byId), true);
  // unrelated selection → no match
  assert.equal(matchTagFilter([leaf.id], ["zzz"], byId), false);
  // empty selection → all
  assert.equal(matchTagFilter([leaf.id], [], byId), true);
});

test("rename/delete/recolor/favorite/sessionTag mutations", () => {
  let data = emptyTagData();
  data = findOrCreateTagPath(data, "项目A/todo").data;
  const leaf = data.tags.find((t) => t.name === "todo");
  const root = data.tags.find((t) => t.name === "项目A");

  // rename ok
  const renamed = renameTagNode(data, leaf.id, "doing");
  assert.equal(renamed.tags.find((t) => t.id === leaf.id).name, "doing");
  // rename conflict: sibling with same name under the same parent
  data = findOrCreateTagPath(data, "项目A/doing").data;
  assert.equal(renameTagNode(data, leaf.id, "doing"), null);

  // delete subtree removes root + leaf
  const deleted = deleteTagNode(data, root.id, true);
  assert.equal(deleted.tags.length, 0);

  // recolor
  data = findOrCreateTagPath(data, "bugfix").data;
  const bf = data.tags[0];
  const recolored = setTagColor(data, bf.id, "#123456");
  assert.equal(recolored.tags[0].color, "#123456");
  assert.equal(setTagColor(data, bf.id, "red"), null); // invalid hex

  // favorite toggle
  let d2 = toggleFavorite(data, "s1", true);
  assert.deepEqual(d2.favoriteIds, ["s1"]);
  d2 = toggleFavorite(d2, "s1", false);
  assert.deepEqual(d2.favoriteIds, []);

  // assign / unassign session tag
  let d3 = setSessionTag(data, "s1", bf.id, true);
  assert.deepEqual(d3.sessionTags.s1, [bf.id]);
  d3 = setSessionTag(d3, "s1", bf.id, false);
  assert.equal(d3.sessionTags.s1, undefined);
  assert.equal(setSessionTag(data, "s1", "nope", true), null);
});

test("validateTagData: accepts valid, rejects invalid", () => {
  const good = {
    version: 3,
    favoriteIds: ["s1"],
    tags: [{ id: "t1", name: "todo", color: "#f59e0b", parentId: null, sortOrder: 0, createdAt: "x" }],
    sessionTags: { s1: ["t1"] },
  };
  const ok = validateTagData(good);
  assert.equal(ok.version, 3);
  assert.deepEqual(ok.favoriteIds, ["s1"]);
  assert.deepEqual(ok.sessionTags.s1, ["t1"]);

  // unknown tag id in sessionTags is dropped
  const badRef = validateTagData({ ...good, sessionTags: { s1: ["t1", "nope"] } });
  assert.deepEqual(badRef.sessionTags.s1, ["t1"]);

  // dangling parent → reject
  assert.equal(validateTagData({
    ...good,
    tags: [{ ...good.tags[0], parentId: "missing" }],
  }), null);

  // cycle → reject
  assert.equal(validateTagData({
    ...good,
    tags: [
      { ...good.tags[0], id: "a", parentId: "b" },
      { ...good.tags[0], id: "b", parentId: "a" },
    ],
  }), null);

  // non-object → null
  assert.equal(validateTagData(null), null);
  assert.equal(validateTagData("x"), null);

  // §10: PUT validation drops path-like / blank names and invalid colors
  // (bad entries are skipped so a partially-corrupt file keeps its valid data)
  const badName = validateTagData({
    ...good,
    tags: [{ ...good.tags[0], name: "a/b" }],
  });
  assert.equal(badName.tags.length, 0);
  const badBlank = validateTagData({
    ...good,
    tags: [{ ...good.tags[0], name: "  " }],
  });
  assert.equal(badBlank.tags.length, 0);
  const badColor = validateTagData({
    ...good,
    tags: [{ ...good.tags[0], color: "red" }],
  });
  assert.equal(badColor.tags.length, 0);
});

test("buildTagTree: parent-child nesting + ordering", () => {
  let data = emptyTagData();
  data = findOrCreateTagPath(data, "项目A/todo").data;
  data = findOrCreateTagPath(data, "bugfix").data;
  const tree = buildTagTree(data);
  assert.equal(tree.length, 2);
  const project = tree.find((t) => t.node.name === "项目A");
  assert.equal(project.children.length, 1);
  assert.equal(project.children[0].node.name, "todo");
});
