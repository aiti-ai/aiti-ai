/**
 * aiti-qoder-agent — unit tests for the compact (manual context compaction) probe gate
 * and its execution path.
 *
 * Three things are pinned here:
 *   1. Gate primitives + ledger isolation: no record / fail / blocked / wrong driver /
 *      different binary -> never open; the compact ledger never inherits steer evidence
 *      (separate file, separate criteria).
 *   2. Capability bit and behaviour share one gate: closed -> capabilities.compact=false
 *      and compact() is fail-loud (never a fake success, no session/prompt sent at all);
 *      open -> compact() sends the CLI's own `/compact` (customInstructions appended).
 *   3. The two CLI answers must be told apart: the refusal sentence ("requires
 *      interactive UI ... ACP") is rethrown verbatim; a real compaction reports the
 *      numbers of THIS call's transcript compact_boundary (preTokens/postTokens) and
 *      never a guess.
 *
 * Run: node --experimental-strip-types --test extensions/aiti-qoder-agent/qoder-compact.test.mjs
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Sandbox the home dir before importing the extension: the transcript helpers resolve
// `~/.qoder{,-cn}/projects/...` through os.homedir(). HOME + USERPROFILE both, so a
// Windows run sandboxes the same way (red line: never leak into the real home).
const sandbox = mkdtempSync(join(tmpdir(), "qoder-compact-"));
process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const gate = await import("./compact-gate.ts");
const { steerProbePath } = await import("./steer-gate.ts");
const transcripts = await import("./native-transcript.ts");
const { QoderHandle, applyCompactProbeBook, applySteerProbeBook } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

const CLI = "/nonexistent-for-test/qoderclicn-9.9.9"; // realpath fails -> key stays as given
const PROBE_ON = { [CLI]: { verdict: "pass", driver: "acp", cliVersion: "1.1.87" } };

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });
afterEach(() => {
  applyCompactProbeBook({});
  applySteerProbeBook({});
});

const prompts = (stub) => stub.sent.filter((f) => f.method === "session/prompt");
const promptTexts = (stub) => prompts(stub).map((f) => f.params.prompt.find((b) => b.type === "text")?.text);

/** Write a native transcript shard for `sid` (the shape the CLI itself writes). */
function seedTranscript(sid, lines) {
  const dir = join(sandbox, ".qoder-cn", "projects", "-tmp-qoder-compact-test");
  mkdirSync(dir, { recursive: true });
  const fp = join(dir, `${sid}.jsonl`);
  writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return fp;
}

function boundaryLine({ trigger = "manual", preTokens = 22349, postTokens = 468, at } = {}) {
  return {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isCompactSummary: true,
    timestamp: at ?? new Date().toISOString(),
    compactMetadata: { trigger, preTokens, postTokens, messagesSummarized: 8, durationMs: 21253 },
  };
}

test("门控纯函数：只有该二进制 + acp 驱动的 pass 记录才开门", () => {
  assert.equal(gate.compactProbePassed({}, CLI), false, "无证据");
  assert.equal(gate.compactProbePassed(undefined, CLI), false, "账本缺席");
  assert.equal(gate.compactProbePassed(PROBE_ON, ""), false, "未解析到 CLI");
  for (const verdict of ["fail", "blocked"]) {
    assert.equal(gate.compactProbePassed({ [CLI]: { verdict, driver: "acp" } }, CLI), false, `${verdict} 不开门`);
  }
  assert.equal(gate.compactProbePassed({ [CLI]: { verdict: "pass", driver: "stream-json" } }, CLI), false, "驱动不符不开门");
  assert.equal(gate.compactProbePassed({ [CLI]: { verdict: "pass" } }, CLI), false, "旧账本无 driver 不认");
  assert.equal(gate.compactProbePassed(PROBE_ON, CLI), true);
  const base = { compact: false, steer: false };
  assert.equal(gate.withCompactGate(base, false), base, "未开门不复制表");
  assert.deepEqual(gate.withCompactGate(base, true), { compact: true, steer: false });
  assert.equal(base.compact, false, "基表不被改动");
});

test("账本隔离：compact 与 steer 是两个文件、两套判据，互不继承", () => {
  const stateDir = join(sandbox, "state");
  assert.notEqual(gate.compactProbePath(stateDir), steerProbePath(stateDir), "账本文件不同");
  assert.match(gate.compactProbePath(stateDir), /compact-probe\.json$/);
  // Dirty ledger is fail-closed: broken JSON / unknown verdict / non-object -> empty book
  assert.deepEqual(gate.parseCompactProbeBook("{ not json"), {});
  assert.deepEqual(gate.parseCompactProbeBook("[1,2]"), {});
  assert.deepEqual(gate.parseCompactProbeBook(JSON.stringify({ probes: { "/a": { verdict: "maybe" } } })), {});
  // A hand-written true / bare string can never open the gate
  assert.equal(gate.compactProbePassed(gate.parseCompactProbeBook(JSON.stringify({ probes: { [CLI]: { verdict: "true" } } })), CLI), false);
  // Freshness hint (in-place binary replacement): re-run hint only, never a live revoke
  const book = gate.parseCompactProbeBook(JSON.stringify({ probes: { [CLI]: { verdict: "pass", driver: "acp", cliVersion: "1.1.87" } } }));
  assert.match(gate.compactEvidenceStale(book, CLI, "1.2.0") ?? "", /1\.1\.87.*1\.2\.0.*compact-probe-acp/);
  assert.equal(gate.compactEvidenceStale(book, CLI, "1.1.87"), null);
});

test("能力位与行为同一把门：门控关 → compact() fail-loud，且不发任何 session/prompt", async () => {
  applyCompactProbeBook({});
  const { h, stub } = await makeReadyHandle(QoderHandle, { handleOpts: { cliPath: CLI } });
  assert.equal(h.capabilities.compact, false);
  await assert.rejects(() => h.compact(), /not enabled|compact-probe-acp/);
  assert.equal(prompts(stub).length, 0, "未开门时一条 prompt 都不该发");
});

test("门控开：compact() 发的就是 CLI 自己的 /compact（customInstructions 拼接）", async () => {
  applyCompactProbeBook(PROBE_ON);
  const { h, stub } = await makeReadyHandle(QoderHandle, {
    sessionId: "sid-compact-send",
    handleOpts: { cliPath: CLI },
  });
  assert.equal(h.capabilities.compact, true);
  await h.compact();
  assert.deepEqual(promptTexts(stub), ["/compact"]);
  await h.compact("keep the API decisions");
  assert.deepEqual(promptTexts(stub), ["/compact", "/compact keep the API decisions"]);
});

test("CLI 拒绝 /compact：把 CLI 原话抛成错误，不静默成功", async () => {
  applyCompactProbeBook(PROBE_ON);
  const { h, stub } = await makeReadyHandle(QoderHandle, {
    sessionId: "sid-compact-refuse",
    stubOpts: { autoAnswerPrompt: false },
    handleOpts: { cliPath: CLI },
  });
  const pending = h.compact();
  await flush();
  stub.notify({
    sessionUpdate: "agent_message_chunk",
    content: { text: "Command /compact requires interactive UI and is not available in ACP." },
  });
  await flush();
  assert.equal(stub.answerPrompt({ stopReason: "end_turn" }), true);
  await assert.rejects(() => pending, /requires interactive UI/);
});

test("真压缩：数字取自本次 transcript 的 compact_boundary（不伪造）", async () => {
  applyCompactProbeBook(PROBE_ON);
  const sid = "sid-compact-boundary";
  seedTranscript(sid, [
    { type: "user", message: { role: "user", content: "Reply with exactly: OK" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    boundaryLine({ preTokens: 22349, postTokens: 468 }),
  ]);
  const { h } = await makeReadyHandle(QoderHandle, { sessionId: sid, handleOpts: { cliPath: CLI } });
  const result = await h.compact();
  assert.deepEqual(result, { tokensBefore: 22349, estimatedTokensAfter: 468 });
});

test("旧 boundary 不算本次结果：CLI 没压缩时不得回报数字", async () => {
  applyCompactProbeBook(PROBE_ON);
  const sid = "sid-compact-stale-boundary";
  seedTranscript(sid, [
    boundaryLine({ preTokens: 160000, postTokens: 4000, at: "2026-09-22T07:09:19.274Z" }),
  ]);
  const { h } = await makeReadyHandle(QoderHandle, { sessionId: sid, handleOpts: { cliPath: CLI } });
  const result = await h.compact();
  assert.deepEqual(result, { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
});

test("native-transcript：boundary 扫描只认 compact_boundary，坏行跳过", () => {
  const text = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "compact_boundary" } }),
    JSON.stringify(boundaryLine({ trigger: "auto", preTokens: 160000, postTokens: 4000 })),
    "{ not json compact_boundary",
    JSON.stringify(boundaryLine({ trigger: "manual", preTokens: 900, postTokens: 100 })),
  ].join("\n");
  const found = transcripts.scanCompactBoundaries(text);
  assert.equal(found.length, 2, "只认 subtype=compact_boundary 的真记录");
  assert.deepEqual(found.map((b) => b.trigger), ["auto", "manual"]);
  assert.deepEqual(found[1], { trigger: "manual", preTokens: 900, postTokens: 100, timestamp: found[1].timestamp });
  assert.deepEqual(transcripts.scanCompactBoundaries(""), [], "空文本无记录");
  assert.deepEqual(transcripts.sessionCompactBoundaries("sid-that-does-not-exist"), []);
});
