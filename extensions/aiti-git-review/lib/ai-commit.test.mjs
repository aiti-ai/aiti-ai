/**
 * ai-commit · 纯函数测试（prompt 契约 / diff 组装截断 / 回答清理容错）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleDiffText, buildCommitPrompt, parseCommitText, sanitizeCommitInput, sanitizePath, splitDiffOutput } from "./ai-commit.ts";

const baseInput = () => ({
  cwd: "/repo",
  files: [
    { path: "a.ts", status: "M ", diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n x\n+y" },
  ],
  agentsMds: [{ path: "/repo/AGENTS.md", content: "# 规范\n提交用中文" }],
  recentSubjects: ["feat(a): 一", "fix(b): 二"],
});

test("prompt：含契约要素与上下文块", () => {
  const p = buildCommitPrompt(baseInput());
  assert.ok(p.includes("只输出提交信息本身"));
  assert.ok(p.includes("【项目规范 AGENTS.md】"));
  assert.ok(p.includes("提交用中文"));
  assert.ok(p.includes("【最近提交（风格参考）】"));
  assert.ok(p.includes("- feat(a): 一"));
  assert.ok(p.includes("【待提交变更 diff】"));
  assert.ok(p.includes("diff --git a/a.ts"));
  assert.ok(!p.includes("amend")); // 非 amend 不带原提交信息块
});

test("prompt：amend 附原提交信息", () => {
  const p = buildCommitPrompt({ ...baseInput(), amendOriginal: "feat(x): 旧" });
  assert.ok(p.includes("修正上一笔提交"));
  assert.ok(p.includes("feat(x): 旧"));
});

test("diff 组装：新文件渲染伪 diff", () => {
  const { text } = assembleDiffText([{ path: "new.ts", status: "??", diff: "l1\nl2", isNew: true }]);
  assert.ok(text.includes("diff --git a/new.ts b/new.ts"));
  assert.ok(text.includes("new file mode 100644"));
  assert.ok(text.includes("--- /dev/null"));
  assert.ok(text.includes("+l1\n+l2"));
  assert.ok(text.includes("@@ -0,0 +1,2 @@"));
});

test("diff 组装：空新文件与二进制", () => {
  const { text } = assembleDiffText([
    { path: "empty.ts", status: "??", diff: "", isNew: true },
    { path: "bin.png", status: "??", diff: "ÿ", isNew: true, binary: true },
  ]);
  assert.ok(text.includes("(empty file)"));
  assert.ok(text.includes("Binary file (内容略)"));
});

test("diff 组装：总量超限后续文件只列名", () => {
  const big = "x".repeat(10 * 1024);
  const files = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.ts`, status: "M ", diff: big }));
  const r = assembleDiffText(files, { maxFiles: 200, maxFileDiffBytes: 32 * 1024, maxTotalDiffBytes: 24 * 1024, maxAgentsFiles: 5, maxAgentsBytes: 1024, maxSubjects: 8, maxSubjectLen: 200, maxMessageChars: 4000, maxMessageLines: 50 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.includes("以下文件未包含内容"));
  assert.ok(r.text.includes("- f3.ts")); // 总上限吃满后，后续文件被省略
});

test("diff 组装：单文件截断且不切断多字节字符", () => {
  const content = "中".repeat(100);
  const r = assembleDiffText([{ path: "c.txt", status: "M ", diff: content }], {
    ...({ maxFiles: 200, maxFileDiffBytes: 32 * 1024, maxTotalDiffBytes: 128 * 1024, maxAgentsFiles: 5, maxAgentsBytes: 1024, maxSubjects: 8, maxSubjectLen: 200, maxMessageChars: 4000, maxMessageLines: 50 }),
    maxFileDiffBytes: 30, // 10 个汉字（30 字节）
  });
  assert.ok(r.text.includes("本文件 diff 已截断"));
  assert.ok(!r.text.includes("\ufffd"));
});

test("sanitize：文件数/字段截断，路径清洗换行", () => {
  const s = sanitizeCommitInput({
    cwd: "/r",
    files: Array.from({ length: 250 }, (_, i) => ({ path: `bad\nname${i}.ts`, status: "M ", diff: "d" })),
    agentsMds: [],
    recentSubjects: ["a\nb"],
  });
  assert.equal(s.files.length, 200);
  assert.ok(!s.files[0].path.includes("\n"));
  assert.equal(s.recentSubjects[0], "a b");
  assert.equal(sanitizePath("x\r\ny"), "x  y");
});

test("parse：裸文本直通", () => {
  assert.equal(parseCommitText("feat(x): 支持导出"), "feat(x): 支持导出");
});

test("parse：围栏 + 前后闲话", () => {
  assert.equal(parseCommitText("好的，结果如下：\n```\nfix(a): 修复越界\n\n原因：数组越界\n```\n请查收"), "fix(a): 修复越界\n\n原因：数组越界");
});

test("parse：剥「提交信息：」前缀与引号", () => {
  assert.equal(parseCommitText("提交信息：feat: x"), "feat: x");
  assert.equal(parseCommitText('"fix: y"'), "fix: y");
  assert.equal(parseCommitText("“feat: z”"), "feat: z");
});

test("parse：空/纯空白 → null", () => {
  assert.equal(parseCommitText(""), null);
  assert.equal(parseCommitText("   \n  "), null);
  assert.equal(parseCommitText(null), null);
  assert.equal(parseCommitText("提交信息："), null);
});

test("parse：行数与字符封顶", () => {
  const many = Array.from({ length: 80 }, (_, i) => "line" + i).join("\n");
  const r = parseCommitText(many, { maxMessageChars: 4000, maxMessageLines: 50, maxFiles: 200, maxFileDiffBytes: 1024, maxTotalDiffBytes: 1024, maxAgentsFiles: 5, maxAgentsBytes: 1024, maxSubjects: 8, maxSubjectLen: 200 });
  assert.equal(r?.split("\n").length, 50);
});

test("parse：首尾空行清理", () => {
  assert.equal(parseCommitText("\n\nfeat: x\n\n"), "feat: x");
});

test("splitDiffOutput：按文件分段与引号路径", () => {
  const out = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    'diff --git "a/odd name.txt" "b/odd name.txt"',
    '--- "a/odd name.txt"',
    '+++ "b/odd name.txt"',
    "@@ -1 +1 @@",
    "-1",
    "+2",
    "",
  ].join("\n");
  const segs = splitDiffOutput(out);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].path, "a.ts");
  assert.ok(segs[0].diff.includes("+y"));
  assert.equal(segs[1].path, "odd name.txt");
});

test("splitDiffOutput：空输出 → []", () => {
  assert.deepEqual(splitDiffOutput(""), []);
});
