/**
 * aiti-plan-first · md-files 搜索测试（文件名优先组 + 全文补充 + tag 交集）
 *
 * 背景（2026-09）：选择方案文档的搜索框走 mdCandidates，全文搜索依赖 doc-center
 * FTS/bigrams（只索引 标题+标题列表+正文，relpath 不索引），bm25 融合排序也不优先文件名——
 * 搜文件名关键词（尤其 2 字中文）时正文命中淹没/漏掉精确文件名命中。本测试钉死新语义：
 *   1) 文件名（basename）命中最优先，relpath 命中次之，全文命中殿后；
 *   2) tag 非空时文件名组受 tag 命中交集过滤；
 *   3) doc-center 缺席 → 纯本地清单文件名匹配照常工作。
 *
 * 用 stub services（不走真实 git-trace/doc-center），直呼 handleApi /md-files 路由。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import planFirst, { handleApi } from "./index.ts";

// /repo 下 md 清单（git-trace listMd 形态：path=相对路径, root=仓根）
const MD_LIST = [
  { path: "docs/plan-model.md", root: "/repo" },   // basename 含 plan
  { path: "notes/plan/readme.md", root: "/repo" }, // 仅 relpath 含 plan（basename=readme 不含）
  { path: "guide.md", root: "/repo" },             // 文件名不含 plan（正文会命中）
];
/** doc-center stub：q 命中 = 正文含 q 的全量集（不含文件名语义）；tag 命中 = 固定集合 */
const DOC_TAG_ABS = new Set(["/repo/docs/plan-model.md", "/repo/guide.md"]);
const docQuery = (opts) => {
  const out = [];
  if (opts.tag) {
    for (const abs of DOC_TAG_ABS) {
      const rel = abs.replace("/repo/", "");
      out.push({ root: "/repo", relpath: rel, tags: [{ key: opts.tag, display: opts.tag }] });
    }
    return out;
  }
  // 正文命中全集：plan-model（静态）、guide（正文含 plan）——与文件名无关
  for (const abs of ["/repo/docs/plan-model.md", "/repo/guide.md"]) {
    const rel = abs.replace("/repo/", "");
    out.push({ root: "/repo", relpath: rel, tags: [{ key: "docs", display: "docs" }] });
  }
  return out;
};

async function callMdFiles(ctx, body) {
  const res = await handleApi(
    new Request("http://x/md-files", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { path: ["md-files"], searchParams: new URLSearchParams() },
  );
  return res.json();
}

function makeTrace(mdList) {
  return {
    readOps: () => [],
    onOp: () => () => {},
    listMd: () => mdList,
  };
}
function makeDoc() {
  return { query: docQuery };
}
function makeCtx(configDir, dir, services) {
  return {
    configDir,
    dir,
    services: {
      get: (k) => services[k] ?? undefined,
      provide: () => {},
      onChange: () => {},
    },
    core: { listSessions: async () => [] },
    sessionAnnotations: { register: () => {} },
  };
}
const rels = (j) => (j?.ok ? j.files.map((f) => f.rel) : []);

test("md-files：文件名（basename）命中 > relpath 命中 > 全文命中", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-md-"));
  planFirst.server.startup(makeCtx(root, join(root, "aiti-plan-first"), {
    "aiti-git-trace.trace": makeTrace(MD_LIST),
    "aiti-doc-center.docs": makeDoc(),
  }));
  try {
    const j = await callMdFiles(undefined, { session: "t", cwd: "/repo", q: "plan", tag: "" });
    const got = rels(j);
    assert.deepEqual(got, ["docs/plan-model.md", "notes/plan/readme.md", "guide.md"],
      "文件名命中最优先，relpath 命中次之，全文命中殿后");
    // 全文命中（guide.md）去重后仍带 tags（正文片段来自 doc-center）
    const guide = j.files.find((f) => f.rel === "guide.md");
    assert.ok(Array.isArray(guide?.tags) && guide.tags.length > 0, "全文组条目保留 doc-center tags");
  } finally {
    planFirst.server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("md-files：tag 非空时文件名组经 tag 命中交集过滤", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-md-"));
  planFirst.server.startup(makeCtx(root, join(root, "aiti-plan-first"), {
    "aiti-git-trace.trace": makeTrace(MD_LIST),
    "aiti-doc-center.docs": makeDoc(),
  }));
  try {
    const j = await callMdFiles(undefined, { session: "t", cwd: "/repo", q: "plan", tag: "方案" });
    // 文件名命中仅 plan-model.md 在 tag 集合内；readme.md 被过滤；guide.md 来自全文组（tag 过滤后仍在）
    assert.deepEqual(rels(j), ["docs/plan-model.md", "guide.md"], "tag 交集过滤文件名组 + 全文组");
  } finally {
    planFirst.server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("md-files：doc-center 缺席 → 纯本地文件名匹配照常", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-md-"));
  planFirst.server.startup(makeCtx(root, join(root, "aiti-plan-first"), {
    "aiti-git-trace.trace": makeTrace(MD_LIST),
    // 无 aiti-doc-center.docs
  }));
  try {
    const j = await callMdFiles(undefined, { session: "t", cwd: "/repo", q: "plan", tag: "" });
    assert.deepEqual(rels(j), ["docs/plan-model.md", "notes/plan/readme.md"], "doc 缺席也按 basename/relpath 分级命中");
  } finally {
    planFirst.server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("md-files：多词 AND 匹配文件名", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-md-"));
  planFirst.server.startup(makeCtx(root, join(root, "aiti-plan-first"), {
    "aiti-git-trace.trace": makeTrace(MD_LIST),
    "aiti-doc-center.docs": makeDoc(),
  }));
  try {
    const j = await callMdFiles(undefined, { session: "t", cwd: "/repo", q: "plan model", tag: "" });
    assert.deepEqual(rels(j), ["docs/plan-model.md", "guide.md"], "plan+model 全部词命中 basename，正文命中殿后");
  } finally {
    planFirst.server.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});