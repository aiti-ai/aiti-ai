/**
 * aiti-qoder-agent — steer 探针门控 + ACP 运行中注入单测。
 *
 * 钉死的是「能力位与行为同一把门」这件事（ACP 驱动，2026-11-13 后）：
 *   1. 门控纯函数：无记录 / fail / blocked / **驱动不符** / **二进制换了**（符号链接被
 *      升级重指向）→ 一律不开门（stream-json 旧证据不得给 ACP 开门）；
 *   2. 门控关（默认）：capabilities.steer=false，steer() fail-loud；
 *   3. 门控开 + CLI 自报 promptQueueing：运行中 steer → 在途 session/prompt 旁再发一条
 *      session/prompt；两条都收口才算整轮结束（agent_settled 只发一次）；
 *      steer 镜像进入 steering 组，随该请求响应出队；
 *   4. CLI 未自报 promptQueueing：注入拒绝 → 共享层降级入本地 followUp 队列（消息不丢）；
 *   5. 空闲 steer 等同普通发送。
 *
 * Run: node --experimental-strip-types --test pi-web-ext/aiti-qoder-agent/qoder-steer.test.mjs
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 状态写盘隔离（session/new 换绑会 rename 模型状态文件）。
const sandbox = mkdtempSync(join(tmpdir(), "qoder-steer-"));
process.env.EXT_MODEL_STATE_DIR = join(sandbox, "ext-agents");
process.env.PI_MODELS_CONFIG_PATH = join(sandbox, "models.json");

const gate = await import("./steer-gate.ts");
const { QoderHandle, applySteerProbeBook } = await import("./index.ts");
const { makeReadyHandle, flush } = await import("./qoder-acp-stub.mjs");

const CLI = "/nonexistent-for-test/qoderclicn-9.9.9"; // realpath 失败 → 原样取键（见 canonicalCliKey）
const PROBE_ON = { [CLI]: { verdict: "pass", driver: "acp", cliVersion: "1.1.87" } };

test.after(() => { rmSync(sandbox, { recursive: true, force: true }); });
afterEach(() => applySteerProbeBook({}));

const prompts = (stub) => stub.sent.filter((f) => f.method === "session/prompt");
const promptTexts = (stub) => prompts(stub).map((f) => f.params.prompt.find((b) => b.type === "text")?.text);
const queueUpdates = (events) => events.filter((e) => e.type === "queue_update");

test("门控纯函数：只有该二进制 + 该驱动的 pass 记录才开门", () => {
  assert.equal(gate.steerProbePassed({}, CLI, "acp"), false, "无证据");
  assert.equal(gate.steerProbePassed(undefined, CLI, "acp"), false, "账本缺席");
  assert.equal(gate.steerProbePassed({ [CLI]: { verdict: "pass" } }, "", "acp"), false, "未解析到 CLI");
  for (const verdict of ["fail", "blocked"]) {
    assert.equal(gate.steerProbePassed({ [CLI]: { verdict, driver: "acp" } }, CLI, "acp"), false, `${verdict} 不开门`);
  }
  assert.equal(gate.steerProbePassed({ [CLI]: { verdict: "pass", driver: "acp" } }, CLI, "acp"), true);
  // 驱动隔离：stream-json 证据不得给 ACP 开门，反之亦然
  assert.equal(gate.steerProbePassed({ [CLI]: { verdict: "pass", driver: "stream-json" } }, CLI, "acp"), false);
  assert.equal(gate.steerProbePassed({ [CLI]: { verdict: "pass", driver: "acp" } }, CLI, "stream-json"), false);
  assert.equal(gate.steerProbePassed({ [CLI]: { verdict: "pass" } }, CLI, "acp"), false, "旧账本无 driver = 不认");
  const base = { steer: false, followUp: true };
  assert.equal(gate.withSteerGate(base, false), base, "未开门不复制表（避免两份对象漂移）");
  assert.deepEqual(gate.withSteerGate(base, true), { steer: true, followUp: true });
  assert.equal(base.steer, false, "基表不被改动");
});

test("证据键归一：CLI 升级换了指向，旧 pass 记录不再开门", () => {
  const dir = mkdtempSync(join(tmpdir(), "aiti-steer-gate-"));
  const v1 = join(dir, "cli-1.1.87");
  const v2 = join(dir, "cli-1.2.0");
  const link = join(dir, "qoderclicn"); // PATH 上的命令是符号链接（本机实测 ~/.local/bin）
  writeFileSync(v1, "a");
  writeFileSync(v2, "b");
  symlinkSync(v1, link);
  let book = gate.mergeSteerProbeRecord({}, link, { verdict: "pass", driver: "acp", cliVersion: "1.1.87" });
  assert.equal(gate.steerProbePassed(book, link, "acp"), true, "同一二进制 → 开门");
  assert.ok(Object.keys(book)[0] !== link, "账本键落在规范路径而不是链接");
  unlinkSync(link);
  symlinkSync(v2, link);
  assert.equal(gate.steerProbePassed(book, link, "acp"), false, "升级换了二进制 → 旧证据作废，必须重跑探针");
  // 原地替换（Windows 的 qoderclicn.exe 被更新器覆盖）：键没变，靠版本二次校验给提示
  assert.equal(gate.steerProbePassed(book, v1, "acp"), true, "证据仍属于 v1 这个二进制");
  assert.match(gate.steerEvidenceStale(book, v1, "1.2.0") ?? "", /1\.1\.87.*1\.2\.0.*重跑/, "版本对不上就给重跑提示");
  assert.equal(gate.steerEvidenceStale(book, v1, "1.1.87"), null, "版本一致不吭声");
  assert.equal(gate.steerEvidenceStale({}, v1, "1.2.0"), null, "没记录就不猜");
});

test("账本解析 fail-closed：脏文件/坏 JSON 都不可能放开能力", () => {
  assert.deepEqual(gate.parseSteerProbeBook(null), {});
  assert.deepEqual(gate.parseSteerProbeBook("{ not json"), {});
  assert.deepEqual(gate.parseSteerProbeBook("[1,2]"), {});
  const book = gate.parseSteerProbeBook(JSON.stringify({
    probes: {
      "/a": { verdict: "pass", driver: "acp" },
      "/b": { verdict: "pass", driver: "rm -rf" },
      "/c": { verdict: "maybe", driver: "acp" },
      "/d": "nope",
    },
  }));
  assert.deepEqual(Object.keys(book).sort(), ["/a", "/b"]);
  assert.equal(book["/a"].driver, "acp");
  assert.equal(book["/b"].driver, undefined, "非法 driver 丢弃 = 任何驱动都不认");
  assert.equal(gate.steerProbePassed(book, "/a", "acp"), true);
  assert.equal(gate.steerProbePassed(book, "/b", "acp"), false);
});

test("门控关（无 ACP 证据）：steer 能力位 false，steer() fail-loud", async () => {
  const { h, stub } = await makeReadyHandle(QoderHandle, { handleOpts: { cliPath: CLI } });
  assert.equal(h.capabilities.steer, false, "无 ACP 探针 → 关");
  await assert.rejects(() => h.steer("运行中注入"), /Capability "steer" is not enabled/);
  assert.equal(prompts(stub).length, 0, "不得发出任何 session/prompt");
  // followUp 仍然可用（本地队列）
  await h.followUp("排队的输入");
  await h.dispose();
});

test("门控开 + promptQueueing：运行中 steer 并发一条 session/prompt，两条收口才结算一次", async () => {
  applySteerProbeBook(PROBE_ON);
  const { h, events, stub } = await makeReadyHandle(QoderHandle, {
    stubOpts: { autoAnswerPrompt: false, cliVersion: "1.1.87" },
    handleOpts: { cliPath: CLI },
  });
  assert.equal(h.capabilities.steer, true, "ACP 探针 pass → 开");

  const primary = h.prompt("主轮");
  primary.catch(() => {});
  await flush();
  assert.equal(prompts(stub).length, 1);

  await h.steer("注入");
  await flush();
  assert.equal(prompts(stub).length, 2, "运行中注入 = 并发第二条 session/prompt");
  assert.deepEqual(promptTexts(stub), ["主轮", "注入"]);
  assert.deepEqual(queueUpdates(events).at(-1)?.steering, ["注入"], "steering 镜像上面板（协议无 ack）");
  assert.equal(events.filter((e) => e.type === "agent_settled").length, 0, "还没收口");

  // 先收注入请求：不得提前结算整轮
  stub.answerPrompt({ stopReason: "end_turn" }, 1);
  await flush();
  assert.equal(events.filter((e) => e.type === "agent_settled").length, 0, "注入判定不触发 agent_settled");
  assert.deepEqual(queueUpdates(events).at(-1)?.steering, [], "注入请求响应 → 镜像出队");

  // 主轮收口 → 整轮结算一次
  stub.answerPrompt({ stopReason: "end_turn" }, 0);
  await primary;
  await flush();
  assert.equal(events.filter((e) => e.type === "agent_settled").length, 1, "整轮只 settled 一次");
  assert.equal(h.isRunning(), false);
  const users = h.getMessages().filter((m) => m?.role === "user");
  assert.deepEqual(users.map((m) => m.content), ["主轮", "注入"], "注入文本进会话历史");
  await h.dispose();
});

test("门控开但 CLI 未自报 promptQueueing：注入拒绝 → 降级入本地 followUp 队列", async () => {
  applySteerProbeBook(PROBE_ON);
  const { h, events, stub } = await makeReadyHandle(QoderHandle, {
    stubOpts: { autoAnswerPrompt: false, promptQueueing: false },
    handleOpts: { cliPath: CLI },
  });
  assert.equal(h.capabilities.steer, true, "能力位由探针账本决定（CLI 能力是运行时二次闸）");

  h.prompt("主轮").catch(() => {});
  await flush();
  await h.steer("降级的话");
  await flush();
  assert.equal(prompts(stub).length, 1, "不得发出第二条 session/prompt");
  assert.deepEqual(queueUpdates(events).at(-1)?.followUp, ["降级的话"], "注入失败 → 本地队列（消息不丢）");

  stub.answerPrompt({ stopReason: "end_turn" }, 0);
  await flush();
  assert.deepEqual(promptTexts(stub), ["主轮", "降级的话"], "settle 后续轮发出排队文本");
  await h.dispose();
});

test("空闲态 steer 等同普通发送（不挂 steer 钩子路径）", async () => {
  applySteerProbeBook(PROBE_ON);
  const { h, stub } = await makeReadyHandle(QoderHandle, { handleOpts: { cliPath: CLI } });
  await h.steer("空闲发送");
  assert.deepEqual(promptTexts(stub), ["空闲发送"]);
  assert.equal(h.isRunning(), false);
  await h.dispose();
});