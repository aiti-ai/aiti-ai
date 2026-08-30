/**
 * session-run-quiescence —— 跨实例单写者检查测试。
 *
 * 语义：文件两次采样（700ms 窗口）间 size/mtime 有变化 = 活跃写入 → 抛错；
 * 静默文件 / 不存在文件 → 通过。真实场景：另一 pi-web 实例拉起子进程流式写
 * 同一 session jsonl（孤儿 run，本实例内存态不可见）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, appendFileSync, statSync, existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSessionFileQuiescent } from "./session-run-quiescence.ts";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "quiescence-"));
  const p = join(dir, name);
  writeFileSync(p, "{}\n");
  return p;
}

test("静默文件 → 通过", async () => {
  const p = tmpFile("quiet.jsonl");
  await assertSessionFileQuiescent(p); // 不抛即通过
  assert.ok(existsSync(p));
});

test("采样窗口内有并发写入 → 抛错（孤儿 run 场景）", async () => {
  const p = tmpFile("live.jsonl");
  // 300ms 后开始追加（窗口 700ms 内必然采到变化）
  const timer = setInterval(() => {
    try { appendFileSync(p, JSON.stringify({ type: "message", n: Date.now() }) + "\n"); } catch { /* */ }
  }, 150);
  await assert.rejects(() => assertSessionFileQuiescent(p), /actively written/);
  clearInterval(timer);
});

test("文件不存在 → 视为静默通过", async () => {
  await assertSessionFileQuiescent(join(tmpdir(), "no-such-file.jsonl"));
});

test("删除竞态：窗口内文件消失 → 视为静默通过（不阻塞 fork）", async () => {
  const p = tmpFile("vanish.jsonl");
  const timer = setTimeout(() => { try { import("node:fs").then(fs => fs.rmSync(p)); } catch { /* */ } }, 300);
  await assert.doesNotReject(() => assertSessionFileQuiescent(p));
  clearTimeout(timer);
});

test("statSync 对采样一致性：写入停止后立即可过", async () => {
  const p = tmpFile("settle.jsonl");
  appendFileSync(p, "x\n");
  const before = statSync(p).mtimeMs;
  await assertSessionFileQuiescent(p);
  assert.equal(statSync(p).mtimeMs, before);
});
