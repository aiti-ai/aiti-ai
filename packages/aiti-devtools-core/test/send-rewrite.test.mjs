/**
 * send-rewrite.test.mjs —— B1 下沉的发送改写公共库测试
 * 用法：node test/send-rewrite.test.mjs
 * 覆盖：占位符替换/换行分隔/孤儿兜底/旧标签摘除/发自幂等/clipUrl（与 pi-web preSend 行为逐条对齐）。
 */
import assert from "node:assert/strict";
import {
  rewriteMessage, withSourceTag, stripOrphanTags, replaceTag, clipUrl,
  ORPHAN_NOTICE,
} from "../src/send-rewrite.ts";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("✗ " + msg); } };

const P = { pid: "abc123/host", pageUrl: "http://x.test/page?a=1&b=2&c=3#frag" };
const CANDS = [
  { tag: "[元素1]", describe: "<button> 提交\n  · xpath: /html[1]/button[1]", pageId: "abc123/host" },
  { tag: "[错误1]", describe: "⚠ 页面错误\n  · 消息: boom" },
];

// ---- B1: 基础替换 + 换行分隔（desc 末行与用户文本不粘连）----
{
  const r = rewriteMessage("看下 [元素1] 为什么不亮", CANDS, P);
  // pi-web 同款行为：desc 与 rest 以换行分隔；rest 保留原样（含标签后那个空格）
  ok(r.text.startsWith("看下 <button> 提交\n  · xpath: /html[1]/button[1]\n 为什么不亮"), "替换 + 换行分隔（pi-web 同款 rest 原样）");
  ok(r.usedTags.includes("[元素1]"), "usedTags 记录");
  ok(r.text.includes("[发自: abc123/host · http://x.test/page?a=1&b=2（aiti-*：pageId 参数用它）]"), "发自完整格式（clipUrl：去 hash/query 留前 2）");
}

// ---- B1: 标签在句尾（rest 为空不补换行）----
{
  const r = rewriteMessage("分析 [元素1]", CANDS, P);
  ok(r.text.includes("xpath: /html[1]/button[1]\n[发自:"), "句尾标签：desc 后直接发自行");
  ok(!r.text.includes("/html[1]/button[1]\n\n"), "无多余空行");
}

// ---- B1: 孤儿兜底（无候选）----
{
  const r = rewriteMessage("看 [元素5] 和 [回答9]", [], P);
  ok(r.text.includes(ORPHAN_NOTICE), "无候选 → 全孤儿兜底");
  ok(!/\[(?:元素|回答)\d+\]/.test(r.text), "占位符零残留");
  ok(!r.usedAny, "usedAny=false");
}

// ---- B1: 孤儿兜底（替换后残留：[元素1] 有效 + [元素5] 孤儿混合）----
{
  const r = rewriteMessage("[元素1] 和 [元素5] 都看看", CANDS, P);
  ok(r.text.includes("<button> 提交"), "有效候选已替换");
  ok(r.text.includes(ORPHAN_NOTICE), "残留孤儿兜底");
  ok(!r.text.includes("[元素5]"), "孤儿占位符不残留");
}

// ---- B1: 旧版 [选择N] 摘除 ----
{
  const r = rewriteMessage("旧草稿 [选择2] 加 [元素1]", CANDS, P);
  ok(!r.text.includes("[选择2]"), "旧标签摘除");
  ok(r.text.includes("<button> 提交"), "现候选正常替换");
}

// ---- B1: 无 pid 不加发自 ----
{
  const r = rewriteMessage("看下 [元素1]", CANDS, {});
  ok(!r.text.includes("[发自:"), "无 pid 无发自");
  ok(r.text.includes("<button> 提交"), "替换照常");
}

// ---- B1: 发自幂等（文本已带旧发自 → 只保留新的一条）----
{
  const r = rewriteMessage("看下 [元素1]\n[发自: old/host · http://old]", CANDS, P);
  const n = (r.text.match(/\[发自:/g) || []).length;
  ok(n === 1, "发自幂等（旧摘新加，恰好 1 条）");
  ok(r.text.includes("[发自: abc123/host"), "保留的是新 pid");
}

// ---- B1: srcNote 自定义（i18n）----
{
  const r = rewriteMessage("看 [元素1]", CANDS, { pid: "p/h", srcNote: "aiti-*: use as pageId" });
  ok(r.text.includes("（aiti-*: use as pageId）]"), "srcNote 可定制");
}

// ---- clipUrl（与 host-protocol 同语义）----
{
  ok(clipUrl("http://x.test/p?a=1&b=2&c=3#z") === "http://x.test/p?a=1&b=2", "去 hash + query 前 2");
  ok(clipUrl("http://x.test/p") === "http://x.test/p", "无 query 原样");
  ok(clipUrl("not-a-url").startsWith("not-a-url"), "非法 URL 原样截断路径");
  const long = "http://x.test/" + "a".repeat(150);
  ok(clipUrl(long).length <= 121 && clipUrl(long).endsWith("…"), "120 截断加省略号");
  ok(clipUrl("") === "", "空串");
}

// ---- withSourceTag / stripOrphanTags / replaceTag 单元 ----
{
  ok(withSourceTag("", { pid: "p" }).startsWith("[发自: p"), "空文本发自独立成行");
  ok(withSourceTag("abc", {}) === "abc", "无 pid 原样");
  ok(stripOrphanTags("[元素1][回答2]") === ORPHAN_NOTICE + ORPHAN_NOTICE, "全孤儿逐个替换");
  ok(replaceTag("a [T] b", "[T]", "D") === "a D\n b", "replaceTag 换行分隔（rest 原样含空格，pi-web 同款）");
  ok(replaceTag("a [T]", "[T]", "D") === "a D", "replaceTag 尾标签无残留换行");
}

console.log(`send-rewrite: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
