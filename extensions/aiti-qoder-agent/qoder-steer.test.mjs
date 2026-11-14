/**
 * aiti-qoder-agent — steer 探针门控 + 运行中注入单测。
 *
 * 钉死的是「能力位与行为同一把门」这件事：
 *   1. 门控纯函数：无记录 / fail / blocked / **二进制换了**（符号链接被升级重指向）→ 一律不开门；
 *   2. 门控关（默认）：capabilities.steer=false，运行中发 steer → 不写 stdin、入本地队列；
 *   3. 门控开：capabilities.steer=true，运行中发 steer → 写 priority:"next" 的入站 user 帧
 *      （next = AgentLoop 轮内吸收；now 会抢占本轮，实测注入后 535ms 本轮 error_during_execution）
 *      面板「插队」组出现该条 → CLI 认领回显后摘条并落进消息流；
 *   4. 生命周期回执（含语义有歧义的 cancelled）按已认领收口：摘条落消息流、不转排队；
 *   5. 轮末仍无认领 → 随本轮收口摘条，不重发（歧义时重发才是重复消息的来源）。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-steer.test.mjs
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const gate = await import("./steer-gate.ts");
const { QoderHandle, applySteerProbeBook } = await import("./index.ts");

const CLI = "/nonexistent-for-test/qoderclicn-9.9.9"; // realpath 失败 → 原样取键（见 canonicalCliKey）

function makeHandle(cliPath = CLI) {
  const stdout = new PassThrough();
  const stdinWrites = [];
  const child = {
    stdout,
    stderr: { on() {} },
    once() {},
    stdin: { write: (s) => { stdinWrites.push(String(s)); return true; }, writable: true, on() {} },
    kill() {},
    exitCode: null,
  };
  const h = new QoderHandle("qodercn:new-steer-test", child, null, "/tmp", "cn", cliPath);
  const events = [];
  h.subscribe((e) => events.push(e));
  return {
    h, events, stdinWrites,
    write: (frame) => stdout.write(JSON.stringify(frame) + "\n"),
    frames: () => stdinWrites.map((s) => JSON.parse(s)),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 5));
const userFrames = (frames) => frames.filter((f) => f.type === "user");
const lastQueue = (events) => [...events].reverse().find((e) => e.type === "queue_update");

afterEach(() => applySteerProbeBook({}));

test("门控纯函数：只有该二进制的 pass 记录才开门", () => {
  assert.equal(gate.steerProbePassed({}, CLI), false, "无证据");
  assert.equal(gate.steerProbePassed(undefined, CLI), false, "账本缺席");
  assert.equal(gate.steerProbePassed({ [CLI]: { verdict: "pass" } }, ""), false, "未解析到 CLI");
  for (const verdict of ["fail", "blocked"]) {
    assert.equal(gate.steerProbePassed({ [CLI]: { verdict } }, CLI), false, `${verdict} 不开门`);
  }
  assert.equal(gate.steerProbePassed({ [CLI]: { verdict: "pass" } }, CLI), true);
  const base = { steer: false, followUp: true };
  assert.equal(gate.withSteerGate(base, false), base, "未开门不复制表（避免两份对象漂移）");
  assert.deepEqual(gate.withSteerGate(base, true), { steer: true, followUp: true });
  assert.equal(base.steer, false, "基表不被改动");
});

test("证据键归一：CLI 升级换了指向，旧 pass 记录不再开门", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-steer-gate-"));
  const v1 = join(dir, "cli-1.1.44");
  const v2 = join(dir, "cli-1.2.0");
  const link = join(dir, "qoderclicn"); // PATH 上的命令是符号链接（本机实测 ~/.local/bin）
  writeFileSync(v1, "a");
  writeFileSync(v2, "b");
  symlinkSync(v1, link);
  let book = gate.mergeSteerProbeRecord({}, link, { verdict: "pass", cliVersion: "1.1.44" });
  assert.equal(gate.steerProbePassed(book, link), true, "同一二进制 → 开门");
  assert.ok(Object.keys(book)[0] !== link, "账本键落在规范路径而不是链接");
  unlinkSync(link);
  symlinkSync(v2, link);
  assert.equal(gate.steerProbePassed(book, link), false, "升级换了二进制 → 旧证据作废，必须重跑探针");
  // 原地替换（Windows 的 qoderclicn.exe 被更新器覆盖）：键没变，靠版本二次校验给提示
  assert.equal(gate.steerProbePassed(book, v1), true, "证据仍属于 v1 这个二进制");
  assert.match(gate.steerEvidenceStale(book, v1, "1.2.0") ?? "", /1\.1\.44.*1\.2\.0.*重跑/, "版本对不上就给重跑提示");
  assert.equal(gate.steerEvidenceStale(book, v1, "1.1.44"), null, "版本一致不吭声");
  assert.equal(gate.steerEvidenceStale({}, v1, "1.2.0"), null, "没记录就不猜");
});

test("账本解析 fail-closed：脏文件/坏 JSON 都不可能放开能力", () => {
  assert.deepEqual(gate.parseSteerProbeBook(null), {});
  assert.deepEqual(gate.parseSteerProbeBook("{ not json"), {});
  assert.deepEqual(gate.parseSteerProbeBook("[1,2]"), {});
  const book = gate.parseSteerProbeBook(JSON.stringify({
    probes: { "/a": { verdict: "pass" }, "/b": { verdict: "maybe" }, "/c": "nope" },
  }));
  assert.deepEqual(Object.keys(book), ["/a"]);
  assert.equal(gate.steerProbePassed(book, "/a"), true);
});

test("ACP 驱动：steer 能力位恒关，steer() fail-loud 抛错（运行中输入一律走 followUp 本地队列）", async () => {
  const { QoderHandle } = await import("./index.ts");
  const { makeReadyHandle } = await import("./qoder-acp-stub.mjs");
  const { h } = await makeReadyHandle(QoderHandle, { handleOpts: { cliPath: CLI } });
  assert.equal(h.capabilities.steer, false, "ACP 注入面未探针 → 恒关");
  await assert.rejects(() => h.steer("运行中注入"), /Capability "steer" is not enabled/);
  // followUp 仍然可用（本地队列）
  await h.followUp("排队的输入");
  await h.dispose();
});
