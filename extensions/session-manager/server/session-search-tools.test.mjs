/**
 * session-manager — session-search tools data layer tests（docs/pi-session-search-tools-plan.md §7）。
 *
 * Covers the three read-only SessionIndex methods added for the agent-facing
 * session_search / session_read tools (searchSessions / resolveSessionRefs /
 * sessionMessages), plus the runtime closeRuntime eviction (reload safety).
 *
 * Run: node --experimental-strip-types --test pi-web-ext/session-manager/server/session-search-tools.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { openSessionIndex } = await import("../lib/session-index.ts");
const { runtime, closeRuntime } = await import("../server/runtime.ts");

const ID_A = "11111111-1111-4111-8111-111111111111"; // pi session A
const ID_B = "22222222-2222-4222-8222-222222222222"; // pi session B (shares prefix "2" with B2)
const ID_B2 = "22229999-9999-4999-8999-999999999999";
const PIA = "aaaa3333-3333-4333-8333-333333333333"; // claude ext session

function jsonl(id, cwd, turns) {
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-28T00:00:00.000Z", cwd }),
  ];
  for (const [i, t] of turns.entries()) {
    lines.push(JSON.stringify({
      type: "message", id: `m-${id.slice(0, 4)}-${i}`, timestamp: `2026-11-28T00:0${i}:00.000Z`,
      message: { role: t.role, content: [{ type: "text", text: t.text }] },
    }));
  }
  return lines.join("\n") + "\n";
}

async function fixtureIndex(dir) {
  const dbPath = join(dir, "index.sqlite");
  const idx = openSessionIndex(dbPath);
  // two pi sessions via the real parse path
  writeFileSync(join(dir, "sA.jsonl"), jsonl(ID_A, "/home/x/proj-a", [
    { role: "user", text: "帮我实现 ddns 的 mock 验证脚本" },
    { role: "assistant", text: "好的，我用 node 写 verify-all.mjs，覆盖四个运营商解析：阿里 DNS、DNSPod、华为云、Cloudflare 各自的 API 基线完全不一样，鉴权方式、分页参数、TTL 生效时间都有差异，所以脚本里分别封装 client，统一输出结构和退出码，方便 CI 直接消费结果并打印每一步耗时。另外脚本支持 --only 参数只跑指定运营商，失败时自动重试一次并记录每次请求的原始响应体到 cache 目录，方便事后排查签名错误和限流问题，整体验证流程保持幂等，可以反复跑而不污染线上配置。" },
    { role: "user", text: "压缩前的重要决定：域名解析走 dnspod API" },
  ]));
  writeFileSync(join(dir, "sB.jsonl"), jsonl(ID_B, "/home/x/proj-b", [
    { role: "user", text: "resize the image to 400px" },
    { role: "assistant", text: "done" },
  ]));
  writeFileSync(join(dir, "sB2.jsonl"), jsonl(ID_B2, "/home/x/proj-b", [
    { role: "user", text: "另一个以 22 开头的会话，谈论 resize 逻辑" },
  ]));
  await idx.sync([
    { path: join(dir, "sA.jsonl"), id: ID_A, cwd: "/home/x/proj-a" },
    { path: join(dir, "sB.jsonl"), id: ID_B, cwd: "/home/x/proj-b" },
    { path: join(dir, "sB2.jsonl"), id: ID_B2, cwd: "/home/x/proj-b" },
  ]);
  // one external (claude) session via the ext upsert path
  idx.upsertExtParsed("claude", PIA, "service:claude:" + PIA, {
    meta: { path: "service:claude:" + PIA, id: PIA, cwd: "/home/x/proj-a", name: "claude fix", created: "2026-11-27T00:00:00.000Z", modified: "2026-11-27T01:00:00.000Z", messageCount: 1, firstMessage: "f", lastMessage: "l" },
    messages: [{ entryId: "ce0", role: "user", ts: "2026-11-27T00:30:00.000Z", text: "fix the dnspod retry loop" }],
    files: [],
  });
  return idx;
}

test("searchSessions：all 默认全局命中（含 ext 家族），每会话一条", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  let idx;
  try {
    idx = await fixtureIndex(dir);
    const hits = idx.searchSessions("dnspod");
    assert.equal(hits.length, 2); // pi A + claude ext
    const ids = hits.map((h) => h.sessionId).sort();
    assert.deepEqual(ids, [ID_A, `claude:${PIA}`].sort());
    const a = hits.find((h) => h.sessionId === ID_A);
    assert.equal(a.agent, "pi");
    assert.ok(a.snippet_ === undefined); // no stray fields
    assert.ok(a.text.includes("dnspod"));
    assert.equal(a.role, "user");
    assert.ok(a.entryId.length > 0);
  } finally { idx?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("searchSessions：agents 过滤（pi only / claude only）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  let idx;
  try {
    idx = await fixtureIndex(dir);
    assert.deepEqual(idx.searchSessions("dnspod", { agents: ["pi"] }).map((h) => h.sessionId), [ID_A]);
    assert.deepEqual(idx.searchSessions("dnspod", { agents: ["claude"] }).map((h) => h.sessionId), [`claude:${PIA}`]);
  } finally { idx?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("searchSessions：sessionIds 收窄 + role 过滤", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  let idx;
  try {
    idx = await fixtureIndex(dir);
    // "resize" appears in B and B2 only; narrowing to A yields nothing
    assert.deepEqual(idx.searchSessions("resize", { sessionIds: [ID_A] }), []);
    const hits = idx.searchSessions("resize", { sessionIds: [ID_A, ID_B], role: "user" });
    assert.deepEqual(hits.map((h) => h.sessionId), [ID_B]);
    assert.equal(hits[0].role, "user");
  } finally { idx?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("searchSessions：4 字符走 FTS，2 字符退化 LIKE 兜底", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  let idx;
  try {
    idx = await fixtureIndex(dir);
    const fts = idx.searchSessions("done"); // ≥3 chars → trigram MATCH
    assert.deepEqual(fts.map((h) => h.sessionId), [ID_B]);
    const like = idx.searchSessions("dn"); // <3 chars → LIKE '%dn%' hits dnspod mentions
    const likeIds = like.map((h) => h.sessionId).sort();
    assert.deepEqual(likeIds, [ID_A, `claude:${PIA}`].sort());
  } finally { idx?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("resolveSessionRefs：精确 id / uuid 前缀 / path / 歧义 / 未知", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  let idx;
  try {
    idx = await fixtureIndex(dir);
    assert.deepEqual(idx.resolveSessionRefs([ID_A]).ids, [ID_A]);
    assert.deepEqual(idx.resolveSessionRefs(["11111111"]).ids, [ID_A]); // unique prefix
    assert.deepEqual(idx.resolveSessionRefs([join(dir, "sB.jsonl")]).ids, [ID_B]); // path
    // ambiguous prefix: "2222" matches B and B2 (and claude composite? no — claude:aaaa…)
    const amb = idx.resolveSessionRefs(["2222"]);
    assert.equal(amb.ids.length, 0);
    assert.deepEqual(amb.unresolved, ["2222"]);
    const unknown = idx.resolveSessionRefs(["ffffffff"]);
    assert.equal(unknown.ids.length, 0);
    assert.deepEqual(unknown.unresolved, ["ffffffff"]);
  } finally { idx?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("sessionMessages：user 默认 / all / 分页 / 截断 / entry 锚定 / total", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  let idx;
  try {
    idx = await fixtureIndex(dir);
    const def = idx.sessionMessages(ID_A, { role: "user" }); // 工具层默认传 user（契约）
    assert.equal(def.total, 2);
    assert.deepEqual(def.messages.map((m) => m.role), ["user", "user"]);
    assert.ok(def.messages[0].text.includes("mock 验证脚本"));
    assert.equal(def.row.cwd, "/home/x/proj-a");

    const all = idx.sessionMessages(ID_A); // 数据层不传 role = 全部
    assert.equal(all.total, 3);

    const page = idx.sessionMessages(ID_A, { role: "all", limit: 1, offset: 2 });
    assert.equal(page.messages.length, 1);
    assert.ok(page.messages[0].text.includes("压缩前的重要决定"));

    const tiny = idx.sessionMessages(ID_A, { role: "assistant", maxChars: 200 }); // 实现钳位下限 200
    assert.equal(tiny.messages[0].truncated, true);
    assert.ok(tiny.messages[0].text.endsWith("…[truncated]"));

    const anchor = idx.sessionMessages(ID_A, { entryId: `m-1111-2` });
    assert.equal(anchor.messages.length, 1);
    assert.ok(anchor.messages[0].text.includes("dnspod"));

    assert.equal(idx.sessionMessages("ffffffff"), null);
    assert.equal(idx.sessionMessages("2222"), null); // ambiguous → null
    assert.ok(idx.sessionMessages(`claude:${PIA}`).messages[0].text.includes("retry loop"));
  } finally { idx?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("searchSessions：cwdPrefix 在 SQL 内过滤（LIMIT 只数匹配会话）+ NaN 防御", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  let idx;
  try {
    idx = await fixtureIndex(dir);
    // dnspod matches A(proj-a)+claude(proj-a); cwd=proj-b → SQL-level filter yields empty even with limit
    assert.deepEqual(idx.searchSessions("dnspod", { cwdPrefix: "/home/x/proj-b", limit: 1 }), []);
    const scoped = idx.searchSessions("dnspod", { cwdPrefix: "/home/x/proj-a", limit: 1 });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].cwd.startsWith("/home/x/proj-a"), true);
    // NaN / junk numerics fall back to defaults instead of poisoning LIMIT
    assert.ok(idx.searchSessions("dnspod", { limit: Number.NaN }).length >= 1);
    assert.equal(idx.sessionMessages(ID_A, { limit: "junk" }).total >= 1, true);
    assert.equal(idx.sessionMessages(ID_A, { maxChars: Number.NaN }).messages.every((m) => m.text.length > 0), true);
  } finally { idx?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("closeRuntime：驱逐后 runtime() 重建新实例（reload 安全）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sm-sst-"));
  try {
    const cfg = join(dir, "config");
    const r1 = runtime(cfg);
    assert.equal(runtime(cfg), r1); // cached
    closeRuntime(cfg);
    const r2 = runtime(cfg);
    assert.notEqual(r2, r1); // rebuilt, fresh handle
    closeRuntime(cfg); // idempotent
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
