/**
 * trace-files-row 纯函数矩阵测试（方案 docs/aiti-git-trace-message-files-ext-plan.md §3.3）。
 *
 * 覆盖：增量口径、entryId 聚合、跨 store/op 去重、相对→绝对路径、writtenFiles 差集、
 * 空态（无命中/全无增量/空 id 集合）。组件层（取数/渲染）在 trace-files-row.tsx，不在此覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { rowHasDelta, toAbsPath, aggregateTraceTurnFiles, diffAgainstWritten } from "./client/src/trace-files-row.pure.ts";

const store = (over = {}) => ({
  root: "/repo",
  before: "aaa",
  files: { M: 1, A: 0, D: 0 },
  paths: ["a.ts"],
  ...over,
});

test("rowHasDelta：纯基线 op（before=null）且无 leaks → false（与徽标/时间线口径一致）", () => {
  assert.equal(rowHasDelta({ stores: [{ root: "/r", before: null, files: { M: 1 } }], leaks: [] }), false);
  assert.equal(rowHasDelta({ stores: [store()], leaks: [] }), true);
  assert.equal(rowHasDelta({ stores: [{ root: "/r", before: null }], leaks: [{}] }), true);
  assert.equal(rowHasDelta({ stores: [store({ files: { M: 0, A: 0, D: 0 } })], leaks: [] }), false);
});

test("toAbsPath：相对拼 root，绝对原样，Windows 盘符原样", () => {
  assert.equal(toAbsPath("/repo", "src/a.ts"), "/repo/src/a.ts");
  assert.equal(toAbsPath("/repo/", "src/a.ts"), "/repo/src/a.ts");
  assert.equal(toAbsPath("/repo", "/abs/a.ts"), "/abs/a.ts");
  assert.equal(toAbsPath(undefined, "C:\\repo\\a.ts"), "C:\\repo\\a.ts");
  assert.equal(toAbsPath("/repo", ""), "");
});

test("aggregateTraceTurnFiles：按 entryId 聚合本轮，跨 op/store 去重保首见序", () => {
  const rows = [
    { entryId: "e1", stores: [store({ paths: ["a.ts", "b.ts"] })] },
    { entryId: "e2", stores: [store({ paths: ["b.ts", "c.ts"] }), store({ root: "/repo2", paths: ["d.ts"] })] },
    { entryId: "e9", stores: [store({ paths: ["x.ts"] })] }, // 不在本轮
  ];
  const info = aggregateTraceTurnFiles(rows, ["e1", "e2"]);
  assert.deepEqual(info.absPaths, ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts", "/repo2/d.ts"]);
  assert.equal(info.ops, 2);
  assert.equal(info.truncated, false);
});

test("aggregateTraceTurnFiles：无命中 / 全无增量 / 空 id 集合 → null", () => {
  assert.equal(aggregateTraceTurnFiles([{ entryId: "e1", stores: [store()] }], []), null);
  assert.equal(aggregateTraceTurnFiles([{ entryId: "e2", stores: [store()] }], ["e1"]), null);
  assert.equal(aggregateTraceTurnFiles([{ entryId: "e1", stores: [{ root: "/r", before: null, paths: ["a.ts"] }] }], ["e1"]), null);
  assert.equal(aggregateTraceTurnFiles(null, ["e1"]), null);
});

test("aggregateTraceTurnFiles：pathsTruncated 任一 store 命中即置位", () => {
  const info = aggregateTraceTurnFiles([{ entryId: "e1", stores: [store({ pathsTruncated: true, paths: ["a.ts"] })] }], ["e1"]);
  assert.equal(info.truncated, true);
});

test("diffAgainstWritten：归一分隔符后求差集，保 trace 首见序", () => {
  const extra = diffAgainstWritten(
    ["/repo/a.ts", "/repo/b.ts", "/repo/sub/c.ts"],
    ["/repo/b.ts", "/repo/sub/c.ts".replace(/\//g, "\\")],
  );
  assert.deepEqual(extra, ["/repo/a.ts"]);
  assert.deepEqual(diffAgainstWritten(["/repo/a.ts"], []), ["/repo/a.ts"]);
  assert.deepEqual(diffAgainstWritten([], ["/repo/a.ts"]), []);
});
