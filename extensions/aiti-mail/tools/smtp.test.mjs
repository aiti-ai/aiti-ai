/**
 * aiti-mail 单元测试（node:test，零依赖直跑：node --test tools/smtp.test.mjs）
 *
 * 覆盖（方案 docs/aiti-ai-schedule-integration-plan.md §4.6「可测性」）：
 *   - RFC 2047 主题编码（encoded-word ≤75、纯 ASCII 透传、多字节字符不切半）
 *   - MIME 组装（头齐全 / base64 76 切行 / dot-stuffing）
 *   - 地址解析（裸地址 / Name <addr> / 引号逗号 / 全角分隔）
 *   - store.ts 发送记录（临时目录 db：insert/list/cleanup/保留期）
 *
 * sendMail 的协议对谈属网络集成，不在单测面（管理页「发送测试」一键真验）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  encodeRfc2047, buildMime, parseAddress, parseAddressList, splitAddresses,
  formatAddress, formatRfc5322Date, dotStuff,
} from "../smtp.ts";
import { SendStore } from "../store.ts";

// ───────────────────────── 地址解析 ─────────────────────────

test("splitAddresses：半角/全角分隔 + 引号内逗号不切", () => {
  assert.deepEqual(splitAddresses("a@b.com,c@d.com"), ["a@b.com", "c@d.com"]);
  assert.deepEqual(splitAddresses("a@b.com，c@d.com；e@f.com"), ["a@b.com", "c@d.com", "e@f.com"]);
  assert.deepEqual(splitAddresses('"Zhang, San" <z.s@x.com>, b@c.com'), ['"Zhang, San" <z.s@x.com>', "b@c.com"]);
  assert.deepEqual(splitAddresses("  a@b.com  , ,c@d.com "), ["a@b.com", "c@d.com"]);
  assert.deepEqual(splitAddresses(""), []);
});

test("parseAddress：裸地址 / Name <addr> / 非法返回 null", () => {
  assert.deepEqual(parseAddress("a@b.com"), { name: "", address: "a@b.com" });
  assert.deepEqual(parseAddress("Zhang San <z.s@x.com>"), { name: "Zhang San", address: "z.s@x.com" });
  assert.deepEqual(parseAddress('"Zhang, San" <z.s@x.com>'), { name: "Zhang, San", address: "z.s@x.com" });
  assert.equal(parseAddress("not-an-address"), null);
  assert.equal(parseAddress(""), null);
});

test("parseAddressList：混合与非法片段丢弃", () => {
  const list = parseAddressList("a@b.com, Zhang <z@x.com>, 坏地址, ;, e@f.cn");
  assert.deepEqual(list.map((a) => a.address), ["a@b.com", "z@x.com", "e@f.cn"]);
});

test("formatAddress：ASCII 名 / 含特殊字符名 / 非 ASCII 名编码", () => {
  assert.equal(formatAddress({ name: "", address: "a@b.com" }), "a@b.com");
  assert.equal(formatAddress({ name: "Zhang San", address: "a@b.com" }), "Zhang San <a@b.com>");
  assert.equal(formatAddress({ name: "Zhang, San", address: "a@b.com" }), '"Zhang, San" <a@b.com>');
  const enc = formatAddress({ name: "张三", address: "a@b.com" });
  assert.match(enc, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <a@b\.com>$/);
});

// ───────────────────────── RFC 2047 ─────────────────────────

test("encodeRfc2047：纯 ASCII 透传", () => {
  assert.equal(encodeRfc2047("hello world 123"), "hello world 123");
  assert.equal(encodeRfc2047(""), "");
});

test("encodeRfc2047：中文编码且每个 encoded-word ≤75 字符", () => {
  const enc = encodeRfc2047("每日 9 点项目日报");
  for (const word of enc.split("\r\n ")) {
    assert.ok(word.length <= 75, "encoded-word 超长: " + word.length);
    assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  }
  // 解码回原文
  const decoded = enc.split("\r\n ")
    .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"))
    .join("");
  assert.equal(decoded, "每日 9 点项目日报");
});

test("encodeRfc2047：长主题切块且多字节字符不切半（全部可无损解码）", () => {
  const long = "定时任务结果送达通知".repeat(20) + " ✅";
  const enc = encodeRfc2047(long);
  const decoded = enc.split("\r\n ")
    .map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8"))
    .join("");
  assert.equal(decoded, long);
  for (const word of enc.split("\r\n ")) assert.ok(word.length <= 75);
});

test("encodeRfc2047：含 ?/= 的 ASCII 也编码（防 encoded-word 解析歧义）", () => {
  const enc = encodeRfc2047("a?b=c");
  assert.notEqual(enc, "a?b=c");
  assert.match(enc, /^=\?UTF-8\?B\?/);
});

// ───────────────────────── MIME 组装 / dot-stuffing ─────────────────────────

test("buildMime：头齐全 + 正文 base64 76 切行 + CRLF", () => {
  const mime = buildMime({
    from: "from@example.com", to: ["a@b.com", "c@d.com"],
    subject: "主题", body: "第一行\n第二行", messageId: "<test@host>", date: new Date(0),
  });
  assert.ok(mime.startsWith("From: from@example.com\r\n"));
  assert.ok(mime.includes("To: a@b.com, c@d.com\r\n"));
  assert.ok(mime.includes("Subject: =?UTF-8?B?"));
  assert.ok(mime.includes("Date: Thu, 01 Jan 1970"));
  assert.ok(mime.includes("Message-ID: <test@host>\r\n"));
  assert.ok(mime.includes("MIME-Version: 1.0\r\n"));
  assert.ok(mime.includes("Content-Type: text/plain; charset=UTF-8\r\n"));
  assert.ok(mime.includes("Content-Transfer-Encoding: base64\r\n"));
  // 头与正文空行分隔
  const bodyPart = mime.split("\r\n\r\n")[1];
  assert.ok(bodyPart.length > 0);
  for (const line of bodyPart.split("\r\n")) assert.ok(line.length <= 76, "正文行超 76: " + line.length);
  // base64 解码回原文
  assert.equal(Buffer.from(bodyPart.replace(/\r\n/g, ""), "base64").toString("utf8"), "第一行\n第二行");
});

test("buildMime：Message-ID 缺省自动生成（@hostname 形态）", () => {
  const mime = buildMime({ from: "a@b.com", to: ["c@d.com"], subject: "s", body: "x" });
  const m = mime.match(/Message-ID: <[^>]+>/);
  assert.ok(m, "缺 Message-ID 头");
});

test("formatRfc5322Date：UTC +0000 形态", () => {
  assert.equal(formatRfc5322Date(new Date("2026-09-07T01:02:03Z")), "Mon, 07 Sep 2026 01:02:03 +0000");
});

test("dotStuff：行首点加倍，中间点不动", () => {
  assert.equal(dotStuff(".hidden\r\nnormal.line\r\n"), "..hidden\r\nnormal.line\r\n");
  assert.equal(dotStuff("\r\n.deep\r\n"), "\r\n..deep\r\n");
  assert.equal(dotStuff("no leading dot"), "no leading dot");
});

// ───────────────────────── store（临时目录 db） ─────────────────────────

function withTempStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "aiti-mail-test-"));
  const store = new SendStore(dir);
  try { return fn(store, dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test("store：insert + list 倒序 + status 过滤 + limit", () => {
  withTempStore((store) => {
    store.insert({ ts: "2026-09-01T00:00:01Z", to_addr: "a@b.com", subject: "s1", body_len: 10, status: "ok", error: null, message_id: "<1@h>", duration_ms: 100, source: "test" });
    store.insert({ ts: "2026-09-02T00:00:00Z", to_addr: "c@d.com", subject: "s2", body_len: 20, status: "error", error: "AUTH 失败", message_id: null, duration_ms: 50, source: "api" });
    store.insert({ ts: "2026-09-03T00:00:00Z", to_addr: "e@f.com", subject: "s3", body_len: 30, status: "ok", error: null, message_id: "<3@h>", duration_ms: 200, source: "aiti-ai-schedule:p_abc" });
    // 倒序
    assert.deepEqual(store.list(50).map((r) => r.to_addr), ["e@f.com", "c@d.com", "a@b.com"]);
    // status 过滤
    assert.deepEqual(store.list(50, "ok").map((r) => r.to_addr), ["e@f.com", "a@b.com"]);
    assert.deepEqual(store.list(50, "error").map((r) => r.error), ["AUTH 失败"]);
    // limit
    assert.equal(store.list(2).length, 2);
    // 行字段完整（schema §4.6）
    const row = store.list(1)[0];
    assert.equal(row.subject, "s3");
    assert.equal(row.body_len, 30);
    assert.equal(row.message_id, "<3@h>");
    assert.equal(row.duration_ms, 200);
    assert.equal(row.source, "aiti-ai-schedule:p_abc");
  });
});

test("store：cleanup 按保留期清理（默认 90 天）", () => {
  withTempStore((store) => {
    const old = new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString();
    const fresh = new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString();
    store.insert({ ts: old, to_addr: "old@x.com", subject: "o", body_len: 1, status: "ok", error: null, message_id: null, duration_ms: 1, source: "api" });
    store.insert({ ts: fresh, to_addr: "new@x.com", subject: "n", body_len: 1, status: "ok", error: null, message_id: null, duration_ms: 1, source: "api" });
    const removed = store.cleanup();
    assert.equal(removed, 1);
    assert.deepEqual(store.list(50).map((r) => r.to_addr), ["new@x.com"]);
  });
});

test("store：重复打开同一 configDir 不重复建表（幂等 schema）", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-mail-test-"));
  try {
    const s1 = new SendStore(dir);
    s1.insert({ ts: new Date().toISOString(), to_addr: "a@b.com", subject: "s", body_len: 1, status: "ok", error: null, message_id: null, duration_ms: 1, source: "api" });
    s1.close();
    const s2 = new SendStore(dir);
    assert.equal(s2.list(50).length, 1);
    s2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
