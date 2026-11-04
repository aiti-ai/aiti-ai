/**
 * sidebar-dock 置顶（固定 tag「📌 置顶」）纯函数单测。
 * 覆盖：buildSessionTree 排序（pinned 优先）、findPinTagId / pinnedSessionIds / isSessionPinned。
 * 运行：node --test --experimental-strip-types client/tests/sidebar-dock-pin.test.mjs
 * 方案：docs/session-manager-sidebar-dock-pin-plan.md
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionTree,
  flattenSessionTree,
  findPinTagId,
  isSessionPinned,
  pinnedSessionIds,
  PIN_TAG_NAME,
} from "../src/sidebar/pure.ts";

const sess = (id, modified, extra = {}) => ({
  path: `/s/${id}`,
  id,
  cwd: "/w",
  created: modified,
  modified,
  messageCount: 1,
  firstMessage: `msg ${id}`,
  ...extra,
});

const idsOf = (tree) =>
  flattenSessionTree(tree, 0, new Set()).map((row) => row.node.session.id);

test("buildSessionTree：pinnedIds 缺省行为不变（按 modified 降序）", () => {
  const tree = buildSessionTree([
    sess("a", "2026-09-01T00:00:00Z"),
    sess("b", "2026-09-03T00:00:00Z"),
    sess("c", "2026-09-02T00:00:00Z"),
  ]);
  assert.deepEqual(idsOf(tree), ["b", "c", "a"]);
});

test("buildSessionTree：pinned 会话排最前（组内仍按 modified 降序）", () => {
  const tree = buildSessionTree(
    [
      sess("a", "2026-09-01T00:00:00Z"),
      sess("b", "2026-09-03T00:00:00Z"),
      sess("c", "2026-09-02T00:00:00Z"),
      sess("d", "2026-09-04T00:00:00Z"),
    ],
    new Set(["a", "c"]),
  );
  // pinned 组 [a, c]（组内 modified 降序：c 新）→ 非 pinned 组 [d, b]
  assert.deepEqual(idsOf(tree), ["c", "a", "d", "b"]);
});

test("buildSessionTree：空 pinnedIds 集合 = 不置顶，排序不变", () => {
  const tree = buildSessionTree(
    [sess("a", "2026-09-01T00:00:00Z"), sess("b", "2026-09-03T00:00:00Z")],
    new Set(),
  );
  assert.deepEqual(idsOf(tree), ["b", "a"]);
});

test("buildSessionTree：pinned 父节点子树随父整体上移，子树内部 pinned 优先递归生效", () => {
  const parent = sess("p", "2026-09-01T00:00:00Z");
  const childA = sess("p-child-a", "2026-09-02T00:00:00Z", { parentSessionId: "p" });
  const childB = sess("p-child-b", "2026-09-05T00:00:00Z", { parentSessionId: "p" });
  const otherParent = sess("q", "2026-09-06T00:00:00Z");
  const otherChild = sess("q-child", "2026-09-04T00:00:00Z", { parentSessionId: "q" });
  // 只有 p 置顶（q 时间新但不置顶）→ p 子树整体置前；子树内部 childB 比 childA 新 → childB 先
  const tree = buildSessionTree([otherParent, otherChild, parent, childA, childB], new Set(["p"]));
  assert.deepEqual(idsOf(tree), ["p", "p-child-b", "p-child-a", "q", "q-child"]);
});

test("buildSessionTree：层级递归 pinned 优先（非 pinned 父下 pinned 子同层置前）", () => {
  const q = sess("q", "2026-09-06T00:00:00Z");
  const qcPinned = sess("qc-pinned", "2026-09-01T00:00:00Z", { parentSessionId: "q" });
  const qcNew = sess("qc-new", "2026-09-05T00:00:00Z", { parentSessionId: "q" });
  const tree = buildSessionTree([q, qcNew, qcPinned], new Set(["qc-pinned"]));
  // 根层 q 唯一；q 子树内 pinned 的 qc-pinned 置前（尽管 modified 更旧）
  assert.deepEqual(idsOf(tree), ["q", "qc-pinned", "qc-new"]);
});

test("findPinTagId：根层按名字匹配；子层同名不算", () => {
  const data = {
    version: 1,
    tags: [
      { id: "t1", name: PIN_TAG_NAME, parentId: null },
      { id: "t2", name: PIN_TAG_NAME, parentId: "t1" },   // 子层同名（防御性）
      { id: "t3", name: "普通标签", parentId: null },
    ],
    sessionTags: {},
  };
  assert.equal(findPinTagId(data), "t1");
  // 无 tags / 空数据兜底
  assert.equal(findPinTagId({ tags: [] }), null);
  assert.equal(findPinTagId({}), null);
  assert.equal(findPinTagId(null), null);
  assert.equal(findPinTagId(undefined), null);
});

test("findPinTagId：不在根层（父节点缺失）的孤儿节点也算根层候选", () => {
  const data = {
    version: 1,
    tags: [{ id: "orphan", name: PIN_TAG_NAME, parentId: "missing" }],
    sessionTags: {},
  };
  assert.equal(findPinTagId(data), "orphan");
});

test("pinnedSessionIds：反查所有打了置顶 tag 的会话", () => {
  const data = {
    version: 1,
    tags: [{ id: "pin", name: PIN_TAG_NAME, parentId: null }, { id: "other", name: "x", parentId: null }],
    sessionTags: {
      s1: ["pin"],
      s2: ["other"],
      s3: ["pin", "other"],
    },
  };
  const pinned = pinnedSessionIds(data);
  assert.deepEqual([...pinned].sort(), ["s1", "s3"]);
  // 无置顶 tag → 空集
  assert.equal(pinnedSessionIds({ tags: [], sessionTags: { s1: [] } }).size, 0);
  assert.equal(pinnedSessionIds(null).size, 0);
});

test("isSessionPinned：单会话判断；无 tag/未打标/打他标 → false", () => {
  const data = {
    version: 1,
    tags: [{ id: "pin", name: PIN_TAG_NAME, parentId: null }],
    sessionTags: { s1: ["pin"], s2: ["other"], s3: [] },
  };
  assert.equal(isSessionPinned(data, "s1"), true);
  assert.equal(isSessionPinned(data, "s2"), false);
  assert.equal(isSessionPinned(data, "s3"), false);
  assert.equal(isSessionPinned(data, "s4"), false);
  assert.equal(isSessionPinned(null, "s1"), false);
});