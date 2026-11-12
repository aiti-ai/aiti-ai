/**
 * commit message 单参数长度护栏回归测试。
 *
 * 背景（2026-12-17 实测）：Linux 内核对 execve 的单个 argv/env 字符串有硬上限
 * MAX_ARG_STRLEN = 32 * PAGE_SIZE = 128 KiB，与总量预算（stack rlimit/4 ≈ 2 MB）
 * 是两道独立限制。大工作区（pi-work，~3k 变更文件）的 _turn_flush 快照曾把全量
 * 文件路径内联进一条 commit-tree -m message，单串超 128 KiB，spawn 直接 E2BIG，
 * 整个 turn_end 记账失败（报「Extension error: spawn E2BIG」）。
 * 修复：buildMessage 出口统一 clamp（MAX_MESSAGE_BYTES = 64 KiB，双倍余量），
 * 早期切分护栏（MAX_SUMMARY_BYTES）从 2 MB 降到 48 KiB（省大串拼接）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampArgvString, MAX_MESSAGE_BYTES } from "../src/engine.ts";

test("clamp: 短串原样返回", () => {
  const s = "aiti op=1 msg=- phase=after\nhello";
  assert.equal(clampArgvString(s), s);
});

test("clamp: 恰好等于上限时原样返回", () => {
  const s = "x".repeat(MAX_MESSAGE_BYTES);
  assert.equal(clampArgvString(s), s);
  assert.equal(Buffer.byteLength(s, "utf8"), MAX_MESSAGE_BYTES);
});

test("clamp: 超长 ASCII 串截到上限内并带截断标记", () => {
  const s = "y".repeat(MAX_MESSAGE_BYTES * 4);
  const out = clampArgvString(s);
  assert.ok(Buffer.byteLength(out, "utf8") <= MAX_MESSAGE_BYTES, `clamped ${Buffer.byteLength(out)} <= ${MAX_MESSAGE_BYTES}`);
  assert.ok(out.endsWith("(truncated: single-argv kernel limit)"));
  assert.ok(out.startsWith("yyyy"));
});

test("clamp: UTF-8 多字节边界不撕裂（中文字符切割点回退）", () => {
  // 每个中文 3 字节；造一个截断点落在多字节序列中间的串
  const s = "中".repeat(MAX_MESSAGE_BYTES); // 远超上限
  const out = clampArgvString(s);
  assert.ok(Buffer.byteLength(out, "utf8") <= MAX_MESSAGE_BYTES);
  // 可无损 decode（无替换符 U+FFFD 残留在截断体里——marker 之前不应出现）
  const body = out.slice(0, out.lastIndexOf("\n…(truncated"));
  assert.ok(!body.includes("\uFFFD"), "截断体不应有撕裂字符");
  assert.ok(body.startsWith("中"));
});

test("clamp: emoji（4 字节序列）边界同样安全", () => {
  const s = "🎉".repeat(MAX_MESSAGE_BYTES); // 4 字节/个
  const out = clampArgvString(s);
  assert.ok(Buffer.byteLength(out, "utf8") <= MAX_MESSAGE_BYTES);
  const body = out.slice(0, out.lastIndexOf("\n…(truncated"));
  assert.ok(!body.includes("\uFFFD"));
});

test("clamp: marker 自身计入预算（产出恒 ≤ MAX_MESSAGE_BYTES）", () => {
  // 极端：内容全为多字节，marker 占用不能把总量顶过上限
  const s = "\u4e2d".repeat(100_000);
  const out = clampArgvString(s);
  assert.ok(Buffer.byteLength(out, "utf8") <= MAX_MESSAGE_BYTES);
});
