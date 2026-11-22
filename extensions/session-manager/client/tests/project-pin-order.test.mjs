/**
 * 项目钉住纯函数单测（载体 = tagData.favoriteIds 里的 "ws:<projectKey>" 项）。
 * 覆盖：pinnedProjectKeys / isProjectPinned / projectPinId 归一化、orderProjects 排序
 * （含恒等映射回归：未钉任何项目时顺序与入参逐项一致）、reorderPinnedFavorites
 * （只重排钉住项、会话收藏留在原位）。
 * 运行：node --test --experimental-strip-types client/tests/project-pin-order.test.mjs
 * 方案：docs/session-manager-project-pin-order-plan.md
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isProjectPinned,
  orderProjects,
  pinnedProjectKeys,
  projectPinId,
  reorderPinnedFavorites,
  PROJECT_PIN_PREFIX,
} from "../src/sidebar/pure.ts";

const proj = (key) => ({ key, root: key });
const keysOf = (list) => list.map((p) => p.key);

test("PROJECT_PIN_PREFIX / projectPinId：带前缀 + 键归一化（win32 大小写/分隔符折叠）", () => {
  assert.equal(PROJECT_PIN_PREFIX, "ws:");
  assert.equal(projectPinId("/home/x/p1"), "ws:/home/x/p1");
  assert.equal(projectPinId("C:\\Proj\\A"), "ws:c:/proj/a");
  assert.equal(projectPinId("C:/Proj/A"), "ws:c:/proj/a");
});

test("pinnedProjectKeys：只认 ws: 前缀、剥前缀、保序；会话收藏项不算", () => {
  const data = {
    favoriteIds: ["s1", "ws:/a", "s2", "ws:/b", "ws:/c"],
    tags: [],
    sessionTags: {},
  };
  assert.deepEqual(pinnedProjectKeys(data), ["/a", "/b", "/c"]);
});

test("pinnedProjectKeys：兜底——null/无字段/重复项/空前缀", () => {
  assert.deepEqual(pinnedProjectKeys(null), []);
  assert.deepEqual(pinnedProjectKeys({}), []);
  assert.deepEqual(pinnedProjectKeys({ favoriteIds: "nope" }), []);
  assert.deepEqual(pinnedProjectKeys({ favoriteIds: ["ws:/a", "ws:/a"] }), ["/a"]);
  assert.deepEqual(pinnedProjectKeys({ favoriteIds: ["ws:", "ws:/a"] }), ["/a"]);
  assert.deepEqual(pinnedProjectKeys({ favoriteIds: [1, null, "ws:/a"] }), ["/a"]);
});

test("pinnedProjectKeys：win32 不同形态只算一份（钉一次 = 一个键）", () => {
  const data = { favoriteIds: ["ws:C:\\Proj\\A", "ws:C:/Proj/A"] };
  assert.deepEqual(pinnedProjectKeys(data), ["c:/proj/a"]);
});

test("isProjectPinned：按归一键命中；未钉/其它命名空间 → false", () => {
  const data = { favoriteIds: ["s1", "ws:C:\\Proj\\A"] };
  assert.equal(isProjectPinned(data, "C:/Proj/A"), true);
  assert.equal(isProjectPinned(data, "c:/proj/a"), true);
  assert.equal(isProjectPinned(data, "/other"), false);
  assert.equal(isProjectPinned(data, "s1"), false, "会话收藏 id 不算项目钉住");
  assert.equal(isProjectPinned(null, "/a"), false);
});

test("orderProjects：钉段按 pinnedKeys 序在前，未钉段保持入参序", () => {
  const list = [proj("/a"), proj("/b"), proj("/c"), proj("/d")];
  assert.deepEqual(keysOf(orderProjects(list, ["/c", "/a"])), ["/c", "/a", "/b", "/d"]);
});

test("orderProjects：恒等映射回归（pinnedKeys 空 / null tagData 兜底 = 行为不变）", () => {
  const list = [proj("/a"), proj("/b"), proj("/c")];
  assert.deepEqual(keysOf(orderProjects(list, [])), ["/a", "/b", "/c"]);
  assert.deepEqual(keysOf(orderProjects(list, pinnedProjectKeys(null))), ["/a", "/b", "/c"]);
  // 返回新数组，不入参原地改动
  const out = orderProjects(list, []);
  assert.notEqual(out, list);
});

test("orderProjects：幽灵钉住键（项目已消失）忽略；与会话收藏混池互不污染", () => {
  const list = [proj("/a"), proj("/b")];
  assert.deepEqual(keysOf(orderProjects(list, ["/gone", "/b"])), ["/b", "/a"]);
  const data = { favoriteIds: ["s1", "ws:/b", "s2"] };
  assert.deepEqual(keysOf(orderProjects(list, pinnedProjectKeys(data))), ["/b", "/a"]);
});

test("orderProjects：全部钉住时输出即钉序（不残留活跃序）", () => {
  const list = [proj("/a"), proj("/b"), proj("/c")];
  assert.deepEqual(keysOf(orderProjects(list, ["/c", "/b", "/a"])), ["/c", "/b", "/a"]);
});

test("reorderPinnedFavorites：钉段内交换，会话收藏原位不动", () => {
  const ids = ["s1", "ws:/a", "s2", "ws:/b", "ws:/c"];
  assert.deepEqual(reorderPinnedFavorites(ids, "/b", -1), ["s1", "ws:/b", "s2", "ws:/a", "ws:/c"]);
  assert.deepEqual(reorderPinnedFavorites(ids, "/b", 1), ["s1", "ws:/a", "s2", "ws:/c", "ws:/b"]);
  // 入参不被改写
  assert.deepEqual(ids, ["s1", "ws:/a", "s2", "ws:/b", "ws:/c"]);
});

test("reorderPinnedFavorites：未钉项 / 边界外 → null（无事可做）", () => {
  const ids = ["ws:/a", "s1", "ws:/b"];
  assert.equal(reorderPinnedFavorites(ids, "/zz", -1), null);
  assert.equal(reorderPinnedFavorites(ids, "/a", -1), null, "已在钉段首");
  assert.equal(reorderPinnedFavorites(ids, "/b", 1), null, "已在钉段尾");
  assert.equal(reorderPinnedFavorites([], "/a", 1), null);
});

test("reorderPinnedFavorites：win32 键归一后可移动（钉住与移动同一口径）", () => {
  const ids = ["ws:C:\\Proj\\A", "ws:C:\\Proj\\B"];
  assert.deepEqual(reorderPinnedFavorites(ids, "C:/Proj/B", -1), ["ws:c:/proj/b", "ws:c:/proj/a"]);
});

test("钉 → 移动 → 排序 端到端（纯函数串起来 = 展示层看到的顺序）", () => {
  let ids = ["s1"];
  ids = [...ids, projectPinId("/b")]; // act("favorite") 追加到数组尾
  ids = [...ids, projectPinId("/a")];
  ids = reorderPinnedFavorites(ids, "/a", -1); // ↑ 把 /a 挪到 /b 前
  const list = [proj("/a"), proj("/b"), proj("/c")];
  assert.deepEqual(keysOf(orderProjects(list, pinnedProjectKeys({ favoriteIds: ids }))), ["/a", "/b", "/c"]);
  ids = ids.filter((x) => x !== projectPinId("/b")); // 取消钉住
  assert.deepEqual(pinnedProjectKeys({ favoriteIds: ids }), ["/a"]);
});
