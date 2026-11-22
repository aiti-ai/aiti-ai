/**
 * version-mention 纯函数单测（docs/aiti-git-trace-timeline-file-actions-plan.md §3 / E4）。
 *
 * 覆盖：@ token 纯路径、边路仓 show/diff 命令、无 target 回退、base==target 去重、
 * 行号映射（hunk 头 / +/−/ctx 行、hunk 前内容）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildVersionMention, resolveDiffLineInfo } from "./client/src/version-mention.ts";

test("buildVersionMention：有 base/target + 行号 → @ token + 边路仓 show+diff 命令", () => {
  const s = buildVersionMention({ path: "src/a.ts", root: "/repo", base: "aaa111", target: "bbb222", line: 120, lineKind: "new" });
  assert.ok(s.startsWith("@src/a.ts "), "at token 纯路径（带尾空格）");
  assert.ok(s.includes("after=bbb222"), "短 hash 摘要");
  assert.ok(s.includes("base=aaa111"), "base 短 hash");
  assert.ok(s.includes("行120(新文件)"), "行号+新文件标注");
  assert.ok(s.includes("git --git-dir=/repo/.aiti-trace --work-tree=/repo show bbb222:src/a.ts"), "完整 hash show 命令");
  assert.ok(s.includes("diff aaa111..bbb222 -- src/a.ts"), "区间 diff 命令");
});

test("buildVersionMention：无 base → 只 show 命令，无 diff", () => {
  const s = buildVersionMention({ path: "a.ts", root: "/r", target: "ccc333" });
  assert.ok(s.includes("after=ccc333"));
  assert.ok(s.includes("show ccc333:a.ts"));
  assert.ok(!s.includes("diff "), "无 base 不出 diff 命令");
});

test("buildVersionMention：无 target（loose 工作区）→ 回退工作区版本附文", () => {
  const s = buildVersionMention({ path: "a.ts", root: "/r" });
  assert.ok(s.startsWith("@a.ts "));
  assert.ok(s.includes("无边路 commit"), "回退提示");
  assert.ok(!s.includes("git --git-dir"));
});

test("buildVersionMention：base==target → 不重复 base 段", () => {
  const s = buildVersionMention({ path: "a.ts", root: "/r", base: "xxx", target: "xxx" });
  assert.ok(!s.includes("base="), "base==target 去重");
  assert.ok(s.includes("after=xxx"));
  assert.ok(!s.includes("diff "), "base==target 不出 diff");
});

test("buildVersionMention：root 尾斜杠归一", () => {
  const s = buildVersionMention({ path: "a.ts", root: "/r/", target: "ddd" });
  assert.ok(s.includes("--git-dir=/r/.aiti-trace"), "尾斜杠被去");
  assert.ok(s.includes("--work-tree=/r "), "work-tree 无重复斜杠");
});

test("resolveDiffLineInfo：hunk 头 + +/−/ctx 行号映射", () => {
  const lines = ["diff --git a b", "index 123..456", "@@ -10,3 +20,3 @@", " ctx", "+add", "-del"];
  // hunk 前内容 → other
  assert.equal(resolveDiffLineInfo(lines, 0).lineKind, "other");
  assert.equal(resolveDiffLineInfo(lines, 0).line, null);
  // hunk 头
  assert.deepEqual(resolveDiffLineInfo(lines, 2), { line: null, lineKind: "hunk" });
  // ctx 行 → new line 20（上下文 old/new 同步推进，但返回 new）
  assert.equal(resolveDiffLineInfo(lines, 3).line, 20);
  assert.equal(resolveDiffLineInfo(lines, 3).lineKind, "context");
  // +add 行 → new line 21
  assert.equal(resolveDiffLineInfo(lines, 4).line, 21);
  assert.equal(resolveDiffLineInfo(lines, 4).lineKind, "new");
  // -del 行 → old line 11（ctx 推进 old 10→11）
  assert.equal(resolveDiffLineInfo(lines, 5).line, 11);
  assert.equal(resolveDiffLineInfo(lines, 5).lineKind, "old");
});

test("resolveDiffLineInfo：多 hunk 跳转后行号正确重置", () => {
  const lines = [
    "@@ -10,2 +20,2 @@",
    " ctx1",      // ctx: new=20,old=10 → 推进 new=21,old=11
    "+add1",      // +: new=21 → 推进 new=22
    "@@ -50,1 +60,1 @@",
    "+add2",      // +: new=60
  ];
  assert.equal(resolveDiffLineInfo(lines, 4).line, 60);
  assert.equal(resolveDiffLineInfo(lines, 4).lineKind, "new");
});
