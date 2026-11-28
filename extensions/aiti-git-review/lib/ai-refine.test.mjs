/**
 * ai-refine · JSON 契约解析测试（容错：围栏/闲话/尾逗号/缺组）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRefinePrompt, parseRefineJson, sanitizeRefineInput } from "./ai-refine.ts";

test("裸 JSON 直解", () => {
  const r = parseRefineJson('{"groups":[{"key":"g1","message":"feat(x): a","files":["a.ts"]}],"excluded":[],"notes":"ok"}');
  assert.equal(r?.groups[0].message, "feat(x): a");
  assert.equal(r?.notes, "ok");
});

test("围栏 + 前后闲话", () => {
  const r = parseRefineJson('好的，以下是修订：\n```json\n{"groups":[{"key":"k","message":"m","files":["a.ts","b.ts"],"note":"⚠ 注意锁文件"}],"excluded":["l.lock"]}\n```\n请查收');
  assert.equal(r?.groups.length, 1);
  assert.equal(r?.groups[0].note, "⚠ 注意锁文件");
  assert.deepEqual(r?.excluded, ["l.lock"]);
});

test("尾逗号宽松修复", () => {
  const r = parseRefineJson('{"groups":[{"key":"k","message":"m","files":["a.ts"],}],}');
  assert.equal(r?.groups.length, 1);
});

test("非法/无组 → null", () => {
  assert.equal(parseRefineJson("这不是 JSON"), null);
  assert.equal(parseRefineJson('{"groups":[]}'), null);
  assert.equal(parseRefineJson(""), null);
});

test("sanitize：组/文件截断", () => {
  const s = sanitizeRefineInput({ cwd: "/r", groups: Array.from({ length: 30 }, (_, i) => ({ key: "k" + i, message: "m", files: ["f"] })), excluded: [] });
  assert.equal(s.groups.length, 20);
});

test("prompt：含契约格式与仓库路径", () => {
  const p = buildRefinePrompt({ cwd: "/repo", groups: [{ key: "g", message: "m", files: ["a"] }], excluded: [] });
  assert.ok(p.includes("/repo"));
  assert.ok(p.includes('"groups"'));
});
