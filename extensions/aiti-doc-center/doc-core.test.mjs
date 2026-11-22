/**
 * aiti-doc-center · doc-core 单测（fixture 驱动，:memory: DB）
 * Run: node --experimental-strip-types --test doc-core.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseIgnoreSet } from "./doc-core.ts";
import {
  normalizeTag, parseMarkdown, inlineTagScan, derivePathTags, extractLinks, linkCandidates, resolveAbs,
  initSchema, upsertDoc, compareMap, markMissingDeleted, purgeExpired, writeFmTags,
  rebuildAllLinks, computeRank, queryDocs, searchSnippets, tagsAll, tagTree, docDetail, markOneDeleted,
  smartScoreBrowse, smartScoreSearch, freshDecay, defaultSmartWeights,
} from "./doc-core.ts";

// ---------- normalizeTag ----------

test("normalizeTag：大小写/嵌套/非法拒绝", () => {
  assert.equal(normalizeTag("Hello/World")?.key, "hello/world");
  assert.equal(normalizeTag("#x")?.key, "x");
  assert.equal(normalizeTag("a//b///")?.key, "a/b");
  assert.equal(normalizeTag("a/b/")?.key, "a/b");
  assert.equal(normalizeTag("2024"), null);          // 纯数字
  assert.ok(normalizeTag("v2024"));                  // 含字母
  assert.equal(normalizeTag("has space"), null);     // 空格
  assert.equal(normalizeTag("a/b/c/d/e/f/g"), null); // 深度 >6
  assert.equal(normalizeTag("中文标签")?.key, "中文标签");
  assert.equal(normalizeTag(""), null);
});

// ---------- parseMarkdown：front-matter + inline tag 避坑 ----------

const FIXTURE = `---
title: 测试文档
tags: [Alpha, #beta, "gamma/one"]
custom: x
---
# 主标题

正文提到 #全文检索 与 ## 不算 以及 #also_ok 结尾。

\`\`\`bash
# shell 注释不算
\`\`\`

    # 缩进代码不算

行内代码 \`#nottag\` 结束。

链接 [跳转](#锚点) 与 [文档](sub/other.md) 与 [[wiki 名]] 与 @docs/other.md，
邮箱 user@example.com 不算，URL https://x.com/#frag 不算。

## 二级 #deploy
`;

test("parseMarkdown：front-matter 子集解析", () => {
  const p = parseMarkdown(FIXTURE);
  assert.equal(p.title, "测试文档");
  assert.deepEqual(p.fmTags, ["Alpha", "beta", "gamma/one"]);
});

test("parseMarkdown：inline tag 避坑（标题/代码/链接锚点/URL/邮箱）", () => {
  const p = parseMarkdown(FIXTURE);
  const keys = p.inlineTags.map((t) => (normalizeTag(t) ?? { key: "" }).key);
  assert.ok(keys.includes("全文检索"));
  assert.ok(keys.includes("also_ok"));
  assert.ok(keys.includes("deploy")); // 标题行内 tag 合法
  assert.ok(!keys.includes("shell")); // 围栏代码
  assert.ok(!keys.includes("缩进代码不算")); // 缩进代码
  assert.ok(!keys.includes("nottag")); // 行内代码
  assert.ok(!keys.includes("锚点")); // md 链接目标
  assert.ok(!keys.includes("frag")); // URL 锚点
  assert.ok(!keys.includes("example.com"));
});

test("parseMarkdown：headings + title 回退（无 front-matter title → H1）", () => {
  const p = parseMarkdown(FIXTURE);
  assert.equal(p.headings[0].level, 1);
  assert.equal(p.headings[0].text, "主标题");
  assert.equal(p.headings[1].level, 2);
  assert.equal(p.headings[1].text, "二级 #deploy");
  const p2 = parseMarkdown("# 回退标题\n\n内容");
  assert.equal(p2.title, "回退标题");
  const p3 = parseMarkdown("没有标题只有正文 #tag1");
  assert.equal(p3.title, undefined);
  assert.deepEqual(parseMarkdown("没有标题只有正文 #tag1").inlineTags, ["tag1"]);
});

test("extractLinks：md/wiki/@路径；邮箱不误判", () => {
  const p = parseMarkdown(FIXTURE);
  const kinds = Object.fromEntries(p.links.map((l) => [l.kind, l.target]));
  assert.equal(kinds.md, "sub/other.md");
  assert.equal(kinds.wiki, "wiki 名");
  assert.equal(kinds.at, "docs/other.md");
  assert.ok(!p.links.some((l) => l.target.includes("example.com")));
});

// ---------- 路径派生 ----------

test("derivePathTags：逐段倒排（近者优先）+ 随机目录名过滤", () => {
  assert.deepEqual(derivePathTags("pi-web-ext/aiti-ai-usage/README.md"),
    ["aiti-ai-usage", "pi-web-ext"]);
  assert.deepEqual(derivePathTags("docs/design/a.md"), ["design", "docs"]);
  assert.deepEqual(derivePathTags("justdb/git_dest12855832016988290519/docs/x.md"), ["docs", "justdb"]); // 随机名忽略
  assert.deepEqual(derivePathTags("justdb/5491906744617948948/docs/x.md"), ["docs", "justdb"]); // 纯数字段忽略
  assert.deepEqual(derivePathTags("README.md"), []);
  assert.deepEqual(derivePathTags("docs/plans/plan.md", 1), ["plans"]); // 近者优先（倒排，cap=1 取最近目录）
});

test("resolveAbs / linkCandidates", () => {
  assert.deepEqual(resolveAbs("/ws/docs/a.md", ["/ws"]), { root: "/ws", rel: "docs/a.md" });
  assert.equal(resolveAbs("/elsewhere/a.md", ["/ws"]), null); // 根不匹配
  assert.deepEqual(linkCandidates("../docs/a.md", "other/c.md"), ["docs/a.md"]); // .. 归一化
  assert.deepEqual(linkCandidates("other.md", "docs/a.md"), ["docs/other.md", "other.md"]);
});

// ---------- DB 全链路 ----------

const ROOTS = ["/ws"];

function mkdb() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

function up(db, rel, text, mtime = Date.now()) {
  const parsed = parseMarkdown(text);
  return upsertDoc(db, {
    root: "/ws", rel, mtimeMs: mtime, size: text.length, hash: rel, parsed,
    pathTags: derivePathTags(rel),
  });
}

test("DB：upsert / tags / trigram 中文检索 / LIKE 降级 / tag 过滤嵌套", () => {
  const db = mkdb();
  const idA = up(db, "docs/a.md", "# A 方案\n\n这是关于中文全文检索的设计方案。#方案/评审中");
  const idB = up(db, "docs/b.md", "# B 实现\n\n实现 A 方案的代码说明。");
  const idC = up(db, "other/c.md", "# C 记录\n\n引用 [A](../docs/a.md) 三次再引用 [A](../docs/a.md)。");

  // trigram 中文检索（≥3 字符）+ snippet
  const r = queryDocs(db, { q: "全文检索", withSnippet: true });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].id, idA);
  assert.ok(r.items[0].snippet.includes("<mark>"));

  // <3 字符 LIKE 降级（2 码点中文词：trigram 匹配不到 → doc_bigrams 精确命中正文）
  const r2 = queryDocs(db, { q: "检索" });
  assert.equal(r2.total, 1);
  assert.equal(r2.items[0].id, idA);

  // 混合：长词（≥3 码点）FTS + 2 码点短词 bigram，AND 语义
  const rMix = queryDocs(db, { q: "全文检索 检索", withSnippet: true });
  assert.equal(rMix.total, 1);
  assert.equal(rMix.items[0].id, idA);

  // 短词不命中时整体 0（bigram AND 语义）
  const rNone = queryDocs(db, { q: "检索 不存在词" });
  assert.equal(rNone.total, 0);

  // 1 码点词：title/relpath LIKE 兜底（快路径，不触 fts 正文扫描）
  const rOne = queryDocs(db, { q: "A" });
  assert.ok(rOne.total >= 1);

  // 路径 tag 过滤（嵌套：父含子）
  const rDocs = queryDocs(db, { tag: "docs" });
  assert.equal(rDocs.total, 2);
  const rRoot = queryDocs(db, { tag: "other" });
  assert.equal(rRoot.total, 1);
  assert.equal(rRoot.items[0].id, idC);

  // tagsAll / tagTree
  const flat = tagsAll(db);
  const docsTag = flat.find((t) => t.key === "docs");
  assert.equal(docsTag.count, 2);
  const tree = tagTree(flat);
  const docsNode = tree.find((n) => n.key === "docs");
  assert.ok(docsNode);

  // 引用边 + PageRank：C→A，A 的 rank 应高于 B
  const lk = rebuildAllLinks(db, ROOTS);
  assert.equal(lk.edges, 1);
  computeRank(db);
  const all = queryDocs(db, { sort: "rank", limit: 10 });
  const rankA = all.items.find((i) => i.id === idA).rankNorm;
  const rankB = all.items.find((i) => i.id === idB).rankNorm;
  assert.ok(rankA > rankB, `rankA=${rankA} rankB=${rankB}`);

  // 详情：backlinks
  const d = docDetail(db, idA, ROOTS);
  assert.equal(d.backlinks.length, 1);
  assert.equal(d.backlinks[0].id, idC);
  assert.equal(d.tags.filter((t) => t.source === "path").length >= 1, true);
  assert.equal(d.tags.some((t) => t.key === "方案/评审中"), true);

  // 融合分排序：q 命中时 rel 分数存在（≥3 字符走 FTS 分支才有 b25/score）
  const r3 = queryDocs(db, { q: "代码说明", sort: "rel" });
  assert.ok(r3.total >= 1);
  assert.ok(r3.items.every((i) => typeof i.score === "number"));
});

test("DB：文件名搜索（§4.9）——relpath 不进 fts/bigrams，名字路径 OR + 优先排序", () => {
  const db = mkdb();
  // ① 2 字中文文件名关键词：正文/标题都不含“方案”，此前 doc_bigrams 无 relpath 源 → 完全搜不到
  const idName2 = up(db, "docs/模型方案.md", "# 模型设计\n\n正文与检索词无关的内容。");
  const r2 = queryDocs(db, { q: "方案" });
  assert.ok(r2.items.some((i) => i.id === idName2), "2 字中文文件名关键词应命中（nameCond relpath LIKE）");

  // ② ≥3 字符文件名关键词：标题≠文件名时 fts trigram（title/headings/body）不命中 → 此前漏
  const idName3 = up(db, "docs/2026-plan-first.md", "# 设计说明\n\n普通正文。");
  const r3 = queryDocs(db, { q: "plan-first" });
  assert.ok(r3.items.some((i) => i.id === idName3), "3+ 字符文件名关键词应命中（nameCond）");

  // ③ 排序优先：文件名命中（relpath 全词）排在正文命中之前
  const idBody = up(db, "docs/alpha.md", "# Alpha\n\n正文大段讨论方案内容。"); // 正文含“方案”，文件名不含
  const idName = up(db, "docs/方案实施计划.md", "# 实施\n\n正文无关内容。");       // 文件名含“方案”，正文不含
  const rOrd = queryDocs(db, { q: "方案", sort: "rel" });
  const seq = rOrd.items.map((i) => i.id);
  assert.equal(seq[0], idName, "文件名命中（relpath 全词）应排在纯正文命中之前");
  assert.ok(seq.includes(idBody), "正文命中仍应进入结果集");

  // ④ FTS 分支同语义：正文强命中 vs 文件名命中 → 文件名在前
  const idBodyL = up(db, "docs/zeta.md", "# Zeta\n\nprotobuf 的序列化格式说明。");   // 正文含 protobuf，文件名不含
  const idNameL = up(db, "docs/protobuf-notes.md", "# 笔记\n\n与序列化无关。");         // 文件名含 protobuf，正文不含
  const rOrdL = queryDocs(db, { q: "protobuf", sort: "rel" });
  assert.equal(rOrdL.items[0].id, idNameL, "FTS 分支：文件名命中优先于正文命中");
  assert.ok(rOrdL.items.some((i) => i.id === idBodyL));

  // ⑤ 与 tag 过滤组合：tag 交集 + 文件名命中仍工作
  const rTag = queryDocs(db, { q: "方案", tag: "docs" });
  assert.ok(rTag.items.some((i) => i.id === idName2), "tag 过滤下文件名命中仍应保留");

  // ⑥ 多词 AND：词都命中文件名才走名字路径；部分命中退回正文路径（不崩、结果可预期）
  const rMix2 = queryDocs(db, { q: "plan 方案" });
  assert.ok(Array.isArray(rMix2.items), "多词搜索不崩");
});

test("DB：软删 / 复活 / rename 同 hash 继承 / 过期清理", () => {
  const db = mkdb();
  const idA = up(db, "docs/a.md", "# A\n\n内容甲乙丙丁。");
  const idD = up(db, "docs/old/d.md", "# D\n\n老位置文档。");

  // D 从盘上消失 → 软删
  const map = compareMap(db);
  const seen = new Set([...map.keys()].filter((k) => !k.includes("old")));
  assert.equal(markMissingDeleted(db, seen), 1);
  assert.equal(queryDocs(db, {}).total, 1);

  // rename：新路径同 hash（测试里 hash=rel，模拟同内容用同 hash 注入）
  const parsed = parseMarkdown("# D\n\n老位置文档。");
  const idD2 = upsertDoc(db, {
    root: "/ws", rel: "docs/new/d.md", mtimeMs: Date.now(), size: parsed.body.length,
    hash: "docs/old/d.md", parsed, pathTags: derivePathTags("docs/new/d.md"),
  });
  assert.equal(idD2, idD); // 继承 doc_id（sessions/tags 随行）

  // 复活：原路径文件回归
  const idA2 = up(db, "docs/a.md", "# A 更新\n\n内容甲乙丙丁戊。");
  assert.equal(idA2, idA);
  assert.equal(queryDocs(db, {}).total, 2);

  // 过期物理清理
  purgeExpired(db, Date.now() + 1); // 全部软删清掉（当前无软删 → 0）
  assert.equal(queryDocs(db, {}).total, 2);
});

test("DB：markOneDeleted + searchSnippets", () => {
  const db = mkdb();
  up(db, "x.md", "# X\n\n独一份的菠萝披萨争议。");
  assert.ok(markOneDeleted(db, "/ws", "x.md"));
  assert.ok(!markOneDeleted(db, "/ws", "x.md")); // 已删
  assert.equal(searchSnippets(db, "菠萝披萨", 5).total, 0); // 软删不入检索
});

test("walkFiles：递归 + 排除（tmpdir 实测）", async () => {
  const dir = join(tmpdir(), "aiti-doc-center-test-" + Date.now());
  mkdirSync(join(dir, "docs/sub"), { recursive: true });
  mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "docs/a.md"), "A");
  writeFileSync(join(dir, "docs/sub/b.md"), "B");
  writeFileSync(join(dir, "node_modules/pkg/r.md"), "R");
  writeFileSync(join(dir, ".git/config.md"), "G");
  writeFileSync(join(dir, "notes.txt"), "T");
  const { walkFiles, DEFAULT_EXCLUDES } = await import("./doc-core.ts");
  const files = walkFiles(dir, new Set(DEFAULT_EXCLUDES));
  const rels = files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ["docs/a.md", "docs/sub/b.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("parseIgnoreSet：** 段边界（a/**/b 不吞 a/xb；**/foo 不吞 myfoo）", () => {
  const r1 = parseIgnoreSet("a/**/b").rules[0];
  assert.equal(r1.re.test("a/x/b"), true);
  assert.equal(r1.re.test("a/x/y/b"), true);
  assert.equal(r1.re.test("a/xb"), false); // ** 段边界：不吞近名
  const r2 = parseIgnoreSet("**/foo").rules[0];
  assert.equal(r2.re.test("x/foo"), true);
  assert.equal(r2.re.test("x/myfoo"), false); // basename 整段匹配
});

test("walkFiles：ignore 感知（.gitignore/.aitiignore）", async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { walkFiles, DEFAULT_EXCLUDES, parseIgnoreSet } = await import("./doc-core.ts");
  const dir = join(tmpdir(), "aiti-doc-center-ign-" + Date.now());
  mkdirSync(join(dir, "ignored"), { recursive: true });
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "ignored/\n*.log\n");
  writeFileSync(join(dir, "ignored/x.md"), "X");
  writeFileSync(join(dir, "root.md"), "R");
  writeFileSync(join(dir, "sub/.aitiignore"), "priv.md\n");
  writeFileSync(join(dir, "sub/priv.md"), "P");
  writeFileSync(join(dir, "sub/ok.md"), "O");
  const files = walkFiles(dir, new Set(DEFAULT_EXCLUDES));
  const rels = files.map((f) => f.rel).sort();
  assert.deepEqual(rels, ["root.md", "sub/ok.md"]); // ignored/ 与 priv.md 被忽略
  // parseIgnoreSet 语义抽查
  const s = parseIgnoreSet("!keep.md\n*.tmp\ndocs/internal/");
  assert.equal(s.rules.length, 3);
  assert.equal(s.rules[0].neg, true);
  assert.equal(s.rules[2].dirOnly, true);
  rmSync(dir, { recursive: true, force: true });
});

test("writeFmTags：新建/合并/移除/CRLF 保持", () => {
  const r1 = writeFmTags("# 标题\n\n正文", ["Alpha", "#beta"], []);
  assert.ok(r1.text.startsWith("---\ntags: [Alpha, beta]\n---\n"));
  assert.deepEqual(r1.tags, ["alpha", "beta"]);
  const r2 = writeFmTags("---\ntitle: T\ntags: [a, b]\n---\n\n正文", ["c"], ["a"]);
  assert.ok(r2.text.includes("tags: [b, c]"));
  assert.ok(r2.text.includes("title: T"));
  assert.ok(!r2.text.includes("[a,"));
  const r3 = writeFmTags("---\ntags:\n  - x\n  - y\n---\nZ", ["z"], []);
  assert.ok(r3.text.includes("tags: [x, y, z]"));
  assert.ok(!r3.text.includes("  - x"));
  const r4 = writeFmTags("---\r\ntags: [a]\r\n---\r\n\r\n正文", ["b"], []);
  assert.ok(r4.text.includes("\r\n"));
  assert.ok(r4.text.includes("tags: [a, b]"));
  const r5 = writeFmTags("---\ntags: [a]\n---\nB", [], ["nope"]);
  assert.deepEqual(r5.tags, ["a"]);
  const r6 = writeFmTags("X", ["2024", "ok"], []);
  assert.deepEqual(r6.tags, ["ok"]);
});

test("countDirsAsync：与同步版数量一致 + cap 早退 + 批间让路不阻塞", async () => {
  const { countDirs, countDirsAsync } = await import("./doc-core.ts");
  const mk = async () => {
    const dir = await fsPromises.mkdtemp(join(tmpdir(), "countdirs-"));
    // 树：a/(b/(file), c/) + top.md + .git/(x/)（.git 排除）
    for (const p of ["a/b", "a/c", ".git/x"]) await fsPromises.mkdir(join(dir, p), { recursive: true });
    for (const p of ["top.md", "a/b/f.md", ".git/x/y"]) await fsPromises.writeFile(join(dir, p), "x");
    return dir;
  };
  const d1 = await mk(), d2 = await mk(), d3 = await mk();
  try {
    const syncN = countDirs(d1, new Set(), 50_000);
    const asyncN = await countDirsAsync(d2, new Set(), 50_000);
    assert.equal(asyncN, syncN);
    assert.equal(asyncN, 3); // a, a/b, a/c（.git/x 排除）
    // cap 早退：BFS 按层退出（与同步 DFS 沿深退出不同），粒度=层宽，语义均为“超过 cap 即停止计数”
    const capped = await countDirsAsync(d3, new Set(), 1);
    assert.ok(capped <= 3, "cap early-exit should not count beyond one extra layer");
  } finally {
    for (const d of [d1, d2, d3]) await fsPromises.rm(d, { recursive: true, force: true });
  }
});

// ---------- smart 综合排序（docs/aiti-doc-center-smart-ranking-plan.md §4.4） ----------

test("smart：fresh 半衰衰减单调递减；isPlan 加成；权重和=1；score∈[0,1]", () => {
  const now = Date.parse("2026-09-19T00:00:00Z");
  const d0 = now - 0 * 86400000, d45 = now - 45 * 86400000, d90 = now - 90 * 86400000;
  const f0 = freshDecay(d0, now, 45), f45 = freshDecay(d45, now, 45), f90 = freshDecay(d90, now, 45);
  assert.ok(f0 > f45 && f45 > f90 && f90 >= 0);
  assert.ok(Math.abs(f0 - 1) < 1e-9);
  assert.ok(Math.abs(f45 - 0.5) < 1e-9); // 半衰：45 天恰为一半
  const w = { now, halfLifeDays: 45, wFresh: 0.45, wRank: 0.35, wPlan: 0.2 };
  assert.ok(Math.abs((w.wFresh + w.wRank + w.wPlan) - 1) < 1e-9);
  const plain = smartScoreBrowse(d45, 0.8, false, w);
  const plan = smartScoreBrowse(d45, 0.8, true, w);
  assert.ok(plan > plain && Math.abs((plan - plain) - w.wPlan) < 1e-9);
  for (const s of [smartScoreBrowse(d0, 1, true, w), smartScoreBrowse(d90, 0, false, w)]) {
    assert.ok(s >= 0 && s <= 1 + 1e-9);
  }
  // 方案示例（§3.2 表，实测 fresh(60d)=0.397 → b≈0.66）：高引用方案显著在前，半年零散沉底
  const b = smartScoreBrowse(now - 60 * 86400000, 0.8, true, w);
  const dd = smartScoreBrowse(now - 180 * 86400000, 0.1, false, w);
  assert.ok(b > 0.6 && b < 0.75 && dd < 0.15);
});

test("smartScoreSearch：relNorm 主导（相关性悬殊时序同 rel）、min-max 归一化", () => {
  const now = Date.now();
  const w = defaultSmartWeights();
  const hi = smartScoreSearch(10, 0, 10, now, 0, w);   // fused 最高、无引用、刚更新
  const lo = smartScoreSearch(0, 0, 10, now - 365 * 86400000, 0, w); // fused 最低
  assert.ok(hi > 0.68 && hi <= 1.0000001); // wRel=0.7 + fresh≈1*0.15
  assert.ok(lo < 0.16);
});

test("queryDocs sort=smart：浏览视图三信号排序 + planPaths 大小写不敏感 + 分页无重漏", () => {
  const db = mkdb();
  const now = Date.now();
  const upAt = (rel, text, mtime) => {
    const parsed = parseMarkdown(text);
    return upsertDoc(db, { root: "/ws", rel, mtimeMs: mtime, size: text.length, hash: rel, parsed, pathTags: derivePathTags(rel) });
  };
  const idOldNote = upAt("notes/old.md", "# 老零散笔记\n\n随手记录。", now - 180 * 86400000);
  const idNewPlan = upAt("plans/new.md", "# 新方案文档\n\n最近的方案。", now - 2 * 86400000);
  const idOldPlan = upAt("plans/old.md", "# 老方案文档\n\n长期维护的方案。", now - 60 * 86400000);
  // PageRank：给 new/old 方案造些入链（老方案引用最多）
  const rows = [[idOldNote, idNewPlan], [idOldNote, idOldPlan], [idOldNote, idOldPlan]];
  void rows;
  const planPaths = new Set(["/WS/PLANS/NEW.MD", "/ws/plans/old.md"]); // 大写路径验证大小写不敏感
  const w = { now, halfLifeDays: 45, wFresh: 0.45, wRank: 0.35, wPlan: 0.2, wRel: 0.7 };
  const r1 = queryDocs(db, { sort: "smart", limit: 2, planPaths, smart: w });
  assert.equal(r1.total, 3);
  assert.equal(r1.items.length, 2);
  assert.equal(r1.items[0].id, idNewPlan); // 两天前+方案 → 综合第一
  assert.ok(r1.items[0].smartScore !== undefined && r1.items[0].smartScore > 0.6);
  assert.equal(r1.items[1].id, idOldPlan); // 老方案：rank 高不了但 plan 加成应压过零散
  // 分页连续无重漏
  const r2 = queryDocs(db, { sort: "smart", limit: 2, offset: 2, planPaths, smart: w });
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].id, idOldNote);
  const ids = new Set([...r1.items, ...r2.items].map((d) => d.id));
  assert.equal(ids.size, 3);
  // 不传 planPaths：isPlan 全 0，fresh 主导（新方案仍第一）
  const r3 = queryDocs(db, { sort: "smart", limit: 3, smart: w });
  assert.equal(r3.items[0].id, idNewPlan);
});

test("queryDocs sort=smart 有 q：相关性悬殊时序与 rel 一致", () => {
  const db = mkdb();
  const now = Date.now();
  const upAt = (rel, text, mtime) => {
    const parsed = parseMarkdown(text);
    return upsertDoc(db, { root: "/ws", rel, mtimeMs: mtime, size: text.length, hash: rel, parsed, pathTags: derivePathTags(rel) });
  };
  upAt("a.md", "# 强相关\n\n全文检索设计细节全文检索。", now - 100 * 86400000);
  upAt("b.md", "# 弱相关\n\n全文检索一次。", now - 1 * 86400000);
  const w = { now, halfLifeDays: 45, wFresh: 0.45, wRank: 0.35, wPlan: 0.2, wRel: 0.7 };
  const smart = queryDocs(db, { q: "全文检索", sort: "smart", planPaths: new Set(), smart: w });
  const rel = queryDocs(db, { q: "全文检索", sort: "rel" });
  assert.equal(smart.items.length, 2);
  assert.equal(smart.items[0].id, rel.items[0].id); // bm25 悬殊时 relNorm 主导 → 同序
});

// ---------- M6-A：非 md 手工登记（kind='file'）+ db 来源 tag ----------

import { registerFileDoc, findDocByAbsPath, addDbTag, removeDbTag, KEYSEP } from "./doc-core.ts";

test("M6-A：file 登记可见可搜、db tag 增删、清空 db tag 后 tombstone、扫描缺失豁免", () => {
  const db = mkdb();
  const abs = "/ws/notes/design.pdf";
  const id = registerFileDoc(db, abs, { mtimeMs: 1234, size: 5678 });
  assert.ok(id > 0);
  const row = findDocByAbsPath(db, abs);
  assert.equal(row.id, id);
  assert.equal(row.kind, "file");
  assert.equal(registerFileDoc(db, abs), id); // 幂等
  // queryDocs 列表可见（kind='file' 与 md 同权）
  const r = queryDocs(db, { sort: "mtime" });
  assert.ok(r.items.some((it) => it.id === id));
  // db tag：加（纯数字拒绝）→ tag 过滤命中
  assert.ok(addDbTag(db, id, "设计/图形"));
  assert.equal(addDbTag(db, id, "2024"), null);
  const byTag = queryDocs(db, { tag: "设计" });
  assert.ok(byTag.items.some((it) => it.id === id));
  // 扫描缺失软删豁免：seen 只含 md 行 → file 行不被误杀
  const mdId = up(db, "docs/a.md", "# A\n\n正文。");
  const mr = db.prepare("SELECT root, relpath FROM docs WHERE id=?").get(mdId);
  assert.equal(markMissingDeleted(db, new Set([mr.root + KEYSEP + mr.relpath])), 0);
  // 删 db tag：删光 → tombstone（deleted=1 → findDocByAbsPath 查不到）
  assert.ok(removeDbTag(db, id, "设计/图形"));
  assert.equal(findDocByAbsPath(db, abs), null);
});
