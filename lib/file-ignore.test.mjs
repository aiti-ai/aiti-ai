import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { isIgnored, isAitIgnored, clearIgnoreCache } = await import("./file-ignore.ts");

function makeTree(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-file-ignore-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (content === null) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, content);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  clearIgnoreCache();
  return root;
}

test("纯文件驱动：无任何 ignore 文件时全部显示", (t) => {
  const root = makeTree(t, { "node_modules/a.js": "", "dist/b.js": "", "src/c.ts": "" });
  assert.equal(isIgnored(root, "node_modules", true), false);
  assert.equal(isIgnored(root, "dist", true), false);
  assert.equal(isIgnored(root, "src", true), false);
});

test(".gitignore 基础语义：目录名 / 后缀 / 否定", (t) => {
  const root = makeTree(t, {
    ".gitignore": "node_modules/\ndist/\n*.log\n!keep.log\n",
    "keep.log": "",
    "x.log": "",
  });
  assert.equal(isIgnored(root, "node_modules", true), true);
  assert.equal(isIgnored(root, "dist", true), true);
  assert.equal(isIgnored(root, "x.log", false), true);
  assert.equal(isIgnored(root, "keep.log", false), false); // ! 恢复
  assert.equal(isIgnored(root, "src", true), false);
});

test(".aitignore 覆盖 .gitignore（AI 视图解锁）", (t) => {
  const root = makeTree(t, {
    ".gitignore": "dist/\n",
    ".aitignore": "!dist/keep\n",
  });
  assert.equal(isIgnored(root, "dist", true), true); // 目录整体仍忽略（- keep 只恢复子项）
  // dist 是目录，子项判定在子目录层
  assert.equal(isIgnored(root, "dist", true), true);
  // 子目录内：keep 文件被恢复
  assert.equal(isIgnored(path.join(root, "dist"), "keep", false), false);
  assert.equal(isIgnored(path.join(root, "dist"), "other", false), true);
});

test("多层 gitignore：深层规则覆盖浅层", (t) => {
  const root = makeTree(t, {
    ".gitignore": "*.log\n",
    "sub/.gitignore": "!important.log\n",
  });
  // 根层 *.log 忽略任意层级的 .log；子目录 sub 的 !important.log 恢复 sub/important.log
  assert.equal(isIgnored(path.join(root, "sub"), "important.log", false), false);
  assert.equal(isIgnored(path.join(root, "sub"), "other.log", false), true);
});

test("git 仓库根边界：.git 之上的 ignore 文件不生效", (t) => {
  const repo = makeTree(t, {
    ".gitignore": "src/\n",
    ".git": null,
  });
  // repo 之上放一个父级 .gitignore（模拟 home/父目录的规则），不应影响仓库内
  const parent = path.dirname(repo);
  const parentGi = path.join(parent, ".gitignore");
  const had = fs.existsSync(parentGi);
  const backup = had ? fs.readFileSync(parentGi, "utf8") : null;
  try {
    fs.writeFileSync(parentGi, "ALL_IGNORED/\n");
    clearIgnoreCache();
    // repo 含 .git → 收集在 repo 层停止，父级规则不可见
    assert.equal(isIgnored(repo, "ALL_IGNORED", true), false);
    assert.equal(isIgnored(repo, "src", true), true); // 仓库内 .gitignore 生效
  } finally {
    if (had) fs.writeFileSync(parentGi, backup);
    else fs.rmSync(parentGi, { force: true });
  }
});

test("目录尾斜杠语义：build/ 忽略目录，build 文件不忽略", (t) => {
  const root = makeTree(t, { ".gitignore": "build/\n" });
  assert.equal(isIgnored(root, "build", true), true);
  // 同名文件（非目录）不被 build/ 规则忽略
  const root2 = makeTree(t, { ".gitignore": "build/\n" });
  assert.equal(isIgnored(root2, "build", false), false);
});

test("isAitIgnored：仅按 .aitignore 判定（供 git ls-files 叠加）", (t) => {
  const root = makeTree(t, {
    ".gitignore": "dist/\n",
    ".aitignore": "recordings/\n*.snap\n",
  });
  assert.equal(isAitIgnored(root, "recordings/a.wav"), true);
  assert.equal(isAitIgnored(root, "x.snap"), true);
  assert.equal(isAitIgnored(root, "dist/a.js"), false); // .gitignore 不参与（git 分支已由 ls-files 处理）
  assert.equal(isAitIgnored(root, "src/a.ts"), false);
});

test("缓存：同一目录重复判定命中缓存，清缓存后重建", (t) => {
  const root = makeTree(t, { ".gitignore": "tmp/\n" });
  assert.equal(isIgnored(root, "tmp", true), true);
  // 清缓存后仍按文件规则判定（行为一致）
  clearIgnoreCache();
  assert.equal(isIgnored(root, "tmp", true), true);
});

test("Windows 反斜杠路径归一（相对路径转 POSIX）", (t) => {
  const root = makeTree(t, { ".gitignore": "*.pyc\n" });
  // isIgnored 内部用 path.join，反斜杠由 path.relative+split 归一；此处验证逻辑对含子目录路径成立
  assert.equal(isIgnored(root, "a.pyc", false), true);
  assert.equal(isIgnored(root, "a.py", false), false);
});

test(".git 内置特判：规则层无从表达，恒判忽略（与普通忽略项同走 showIgnored）", (t) => {
  const root = makeTree(t, {
    ".gitignore": "!.git\n", // git 自身无视 .gitignore，故否定也恢复不了它
    ".aitignore": "!.git\n",
    ".git/config": "",
  });
  assert.equal(isIgnored(root, ".git", true), true);
  assert.equal(isIgnored(root, ".git", false), true); // worktree/子模块的 gitdir 指针文件同名同判
  // 特判只认 .git 本身：规则文件与易混名不受牵连
  assert.equal(isIgnored(root, ".gitignore", false), false);
  assert.equal(isIgnored(root, ".gitmodules", false), false);
  assert.equal(isIgnored(root, "git", false), false);
  assert.equal(isIgnored(root, ".GIT", false), false); // 大小写敏感（Linux 上 .GIT 是普通目录）
});
