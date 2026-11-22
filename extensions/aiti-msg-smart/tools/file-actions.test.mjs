/**
 * file 区按钮回归（同目录多文件的重复与「定位不选中」）：
 *  - 定位 = 打开所在目录 + 派发 pi-web:folder-reveal 选中该文件（宿主 dock 分支忽略 select）
 *  - 文件条目的定位按钮 label 用文件名（两个同目录文件不再长出两个一模一样的按钮）
 *  - 解析结果按 abs 去重（同一文件多种写法/跨仓分辨撞同一目标 → 只出一组按钮）
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { extractFilePaths } from "../client/src/recognize.js";
import { FILE_ACTION_ORDER, fileActionOrder, sortFileActions } from "../client/src/file-actions.js";

const clientSrc = await readFile(new URL("../client/src/index.js", import.meta.url), "utf8");

test("定位：openFolder 之外必须派发 folder-reveal 才能真正选中文件", () => {
  assert.match(clientSrc, /function openFolderReveal\(abs, isDir\) \{/);
  assert.match(clientSrc, /window\.__piFolderRevealLast = \{ \.\.\.detail, ts: Date\.now\(\) \};/);
  assert.match(clientSrc, /new CustomEvent\("pi-web:folder-reveal", \{ detail \}\)/);
  // 目录条目只打开自身，不发选中事件（target 不存在）
  assert.match(clientSrc, /if \(isDir \|\| !dir\) return;/);
  // 旧宿主（无 ctx.openFolder）仍回退左侧树 revealDir
  assert.match(clientSrc, /typeof ctx\.openFolder !== "function"[\s\S]{0,120}ctx\.revealDir\(abs\)/);
  // 卡片改走该函数（不再手拼 dir + openFolder）
  assert.match(clientSrc, /openFolderReveal\(abs, isDir\);/);
});

test("定位按钮 label 带文件名：同目录多文件不再重复", () => {
  assert.match(clientSrc, /key: "reveal"[\s\S]*?\$\{T\.revealDir\}: \$\{name\}/);
  // 「打开文件夹: docs」这类目录名 label 只剩目录条目（isDir 分支）
  assert.match(clientSrc, /isDir\s*\?\s*`\$\{T\.openFolder\}: \$\{name\}`/);
});

test("解析结果按 abs 去重（React key 唯一 + 不出两组按钮）", () => {
  assert.match(clientSrc, /\.then\(\(found\) => \{[\s\S]*?if \(f && !uniq\.some\(\(u\) => u\.path === f\.path\)\) uniq\.push\(f\);[\s\S]*?view\.paths = uniq;/);
});

test("file row order: Open → external (Share) → Reveal by default", () => {
  const items = [
    { id: "reveal", order: FILE_ACTION_ORDER.reveal },
    { id: "share", order: 20 },
    { id: "open", order: FILE_ACTION_ORDER.open },
    { id: "unset" },
  ];
  assert.deepEqual(sortFileActions(items).map((i) => i.id), ["open", "share", "unset", "reveal"]);
  // unordered providers fall back to the external slot, not after the built-ins
  assert.equal(fileActionOrder({}), FILE_ACTION_ORDER.external);
});

test("file row order: a provider can move itself before Open or after Reveal", () => {
  assert.deepEqual(
    sortFileActions([{ id: "pin", order: 1 }, { id: "open", order: 10 }, { id: "reveal", order: 30 }]).map((i) => i.id),
    ["pin", "open", "reveal"],
  );
  assert.deepEqual(
    sortFileActions([{ id: "open", order: 10 }, { id: "reveal", order: 30 }, { id: "last", order: 99 }]).map((i) => i.id),
    ["open", "reveal", "last"],
  );
});

test("file row order: invalid order degrades to the external slot (no NaN jitter)", () => {
  assert.deepEqual(
    sortFileActions([{ id: "a", order: "x" }, { id: "open", order: 10 }, { id: "reveal", order: 30 }]).map((i) => i.id),
    ["open", "a", "reveal"],
  );
  assert.equal(fileActionOrder(null), FILE_ACTION_ORDER.external);
});

test("card renders the row through sortFileActions", () => {
  assert.match(clientSrc, /\.\.\.sortFileActions\(entries\)\.map\(\(x\) => x\.node\)/);
});

test("提取层：整路径已去重，同目录两文件各自成条（重复来自渲染层不是提取层）", () => {
  const t = "方案已落盘：docs/aiti-session-artifacts-panel-plan.md，并在 docs/index.md 索引表顶部登记了一行。";
  const paths = extractFilePaths(t).map((p) => p.path);
  assert.deepEqual(paths, ["docs/aiti-session-artifacts-panel-plan.md", "docs/index.md"]);
  assert.equal(new Set(paths.map((p) => p.split("/")[0])).size, 1);
});
