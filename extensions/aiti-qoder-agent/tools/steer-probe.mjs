#!/usr/bin/env node
/**
 * steer-probe — Qoder 运行中注入（steer）能力的**实跑探针**（能力位由证据开门，见 steer-gate.ts）。
 *
 * 它做什么：按扩展同款参数起一个 headless qodercli，发一条「连续 4 次 Bash sleep」的任务
 * （制造工具间隙），在**第一个工具结果帧之后**（轮内、有间隙可插）注入一条带 `priority`
 * 的 user 帧，要求模型立即停止后续工具调用并只回 INJECTED-OK。
 *
 * 1.1.44 内嵌 JS 取证（决定探针测哪一档）：
 *   - `MessageQueue`：`oz$={now:0,next:1,later:2}`，入站 user 帧 `priority:s.enum(["now","next","later"])`；
 *   - AgentLoop 的 `inter_turn` 附件采集调 `W58 → Lu$("next")` = **取 rank ≤ next 的条目**（now+next 可
 *     被本轮吸收，走 `queued_command` 附件 + `{midTurn:!0}` 包装，消费后发 `command_lifecycle state:"started"`，
 *     日志 `[AgentLoop] Mid-turn drain`）；`later` 不在集合里 → 只能等轮末；
 *   - headless 的队列监听 `NH`：`if (sA（本轮在跑）&& ze(x => x.priority==="now")) AA()` ——**now 额外触发
 *     抢占**（实测：注入后 535ms 本轮以 `result/error_during_execution` 收口）。那是「插队=抢停」，
 *     不是 steer（steer 要求本轮继续、把补充指令喂进下一次模型调用）。
 *   → 默认测 `next`（真·轮内）；`--priority now` 留作抢占语义的对照实验。
 *
 * 判据（pass 需要三条同时成立）：
 *   C1 注入发生在**被注入那一轮**的收口之前（否则只是普通的第二轮，不算 steer）
 *   C2 注入之后没有再出现任何 tool_use，且 assistant 文本里出现 INJECTED-OK
 *      —— 模型改了行为 = 注入确被消费（行为级证据，最强的那条）
 *   C2a 该 marker 出现在**同一个轮内**（inject 与第一个 post-inject result 之间）
 *      跨轮 = 注入把本轮打断、另起一轮才回答 = 中断语义 → 不判 pass（记 interrupt_like=true），
 *      避免把「抢停」当成「插队」上线。
 *   C3 CLI 显式认领注入帧：同 uuid 的 `user` 回显（isReplay）或 `command_lifecycle`
 *      命中（协议级证据；state 序列一并记账——`started` 才是「已被轮内消费」，`queued` 只是「进队列」）。
 *      缺它不判 fail——运行时在本轮收口处兜底——但缺了说明面板摘条会延迟到轮末。
 *   pass = C1 && C2 && C2a；blocked = 额度/登录受阻（不下 fail 结论，也不开门）
 *
 * 收口策略：**不在第一个 result 就退**（那样恰好错过跨轮证据）——注入未发生时见 result
 * 即退（本轮跑完都没间隙 = 无注入面可用）；注入已发生则跑到「看到 marker」或「注入后又
 * 收口 2 轮」或 deadline/进程退出为止。
 *
 * 用法：
 *   node tools/steer-probe.mjs                     # 只跑只报（cn 变体）
 *   node tools/steer-probe.mjs --variant intl
 *   node tools/steer-probe.mjs --record            # 结论写 <stateDir>/steer-probe.json
 *   node tools/steer-probe.mjs --frames-out /tmp/steer-frames.jsonl   # 留现场
 *   node tools/steer-probe.mjs --timeout 420000
 *
 * pass + --record 之后：reload 扩展（deploy 自动做，或 POST /api/extensions/reload），
 * **新开会话**生效（存量会话的能力表在创建时已固化）。
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const variant = opt("variant", "cn") === "intl" ? "intl" : "cn";
// 注入档位：next = 轮内吸收（steer 语义）；now = 额外触发抢占；later = 只能等轮末。见头注释取证。
const priority = ["now", "next", "later"].includes(opt("priority", "next")) ? opt("priority", "next") : "next";
const deadlineMs = Number(opt("timeout", "300000"));
const framesOut = opt("frames-out", null);
const record = argv.includes("--record");
const stateDir = opt("state-dir", null)
  ? resolve(opt("state-dir", ""))
  // 与扩展 ctx.stateDir 同约定（探针脚本没有 ctx）
  : join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data"), "aiti-qoder-agent", "state");

const { resolveQoderCli, qoderLoginBin } = await import(join(here, "..", "login-driver.ts"));
const gate = await import(join(here, "..", "steer-gate.ts"));

const cli = opt("cli", "") || resolveQoderCli(variant) || qoderLoginBin(variant);
const turn1 =
  "请依次执行 4 次 Bash 工具调用，每次只跑 `sleep 6`（一次调用一个 sleep，不要合并、不要并行），" +
  "全部跑完后回一句 DONE。除此之外不要说别的。";
const injectedText = "立刻停止后续的 Bash 调用，不要再发起任何工具调用，只回复一个词：INJECTED-OK";
const injectUuid = `probe-${Date.now().toString(36)}`;

const log = (m) => console.log(m);
const t0 = Date.now();
const at = () => `[${String(Date.now() - t0).padStart(6, " ")}ms]`;
if (framesOut) mkdirSync(dirname(framesOut), { recursive: true });

const workDir = mkdtempSync(join(tmpdir(), "aiti-steer-probe-"));
const args = [
  "-p",
  "--output-format", "stream-json",
  "--input-format", "stream-json",
  "--include-partial-messages",
  "--permission-mode", "bypass_permissions",
];
log(`${at()} cli=${cli}`);
log(`${at()} cwd=${workDir} variant=${variant} deadline=${deadlineMs}ms uuid=${injectUuid}`);
log(`${at()} 第 1 轮: ${turn1}`);
log(`${at()} 注入文本: ${injectedText}`);

const child = spawn(cli, args, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
let stderrText = "";
child.stdin?.on("error", (e) => log(`${at()} stdin error: ${e.message}`));
child.stderr?.on("data", (c) => { stderrText += String(c); });

let buf = "";
let injectAt = 0;
let firstResultAt = 0;
let firstPostInjectResultAt = 0;
let postInjectResults = 0;
let claimAt = 0;
let markerAt = 0;
const claimStates = [];
let sawInterruptResult = false;
let cliVersion = "";
let toolCallsTotal = 0;
let toolUseAfterInject = 0;
let sawInjectedOk = false;
let blockedReason = "";

const BLOCK_MARKERS = [
  "credit usage limit", "usage limit", "upgrade your subscription",
  "not logged in", "unauthorized", "invalid token", "quota exceeded", "exceeded your",
];
const isBlocked = (text) => BLOCK_MARKERS.some((m) => String(text).toLowerCase().includes(m));

let done = false;
let settled;
const finished = new Promise((r) => { settled = r; });
function finish(how) {
  if (done) return;
  done = true;
  clearTimeout(killTimer);
  log(`${at()} 收口：${how}`);
  settled(how);
}
const killTimer = setTimeout(() => finish("timeout"), deadlineMs);
killTimer.unref?.();

function writeStdin(obj) {
  if (!child.stdin?.writable) return false;
  child.stdin.write(`${JSON.stringify(obj)}\n`);
  return true;
}

function handleFrame(msg) {
  const type = String(msg.type ?? "");
  const note = [];
  if (type === "system" && msg.subtype === "init") {
    cliVersion = String(msg.qodercli_version ?? "");
    note.push(`version=${cliVersion}`);
  } else if (type === "assistant") {
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
    const tools = blocks.filter((b) => b?.type === "tool_use");
    const text = blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(" ");
    toolCallsTotal += tools.length;
    if (injectAt) toolUseAfterInject += tools.length; // 注入之后还发起工具 = 没早停
    if (text.includes("INJECTED-OK") && !markerAt) {
      sawInjectedOk = true;
      markerAt = Date.now();
      note.push(`★INJECTED-OK（${injectAt && markerAt > firstPostInjectResultAt ? "跨轮：注入后已收口过一轮" : "同轮"}）`);
    } else if (text.includes("INJECTED-OK")) sawInjectedOk = true;
    if (tools.length) note.push(`tool_use×${tools.length}=${tools.map((t) => t.name).join("/")}`);
    if (text && !markerAt) note.push(`text="${text.slice(0, 50)}"`);
  } else if (type === "user") {
    const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
    const results = blocks.filter((b) => b?.type === "tool_result");
    if (msg.uuid === injectUuid) {
      if (!claimAt) claimAt = Date.now();
      claimStates.push("replay");
      note.push("★注入帧被回显（认领）");
    } else if (results.length) {
      note.push(`tool_result×${results.length}`);
      if (!injectAt && !firstResultAt) {
        injectAt = Date.now();
        const ok = writeStdin({
          type: "user",
          uuid: injectUuid,
          priority,
          message: { role: "user", content: [{ type: "text", text: injectedText }] },
        });
        note.push(ok ? `★已注入 priority=${priority}` : "!! stdin 不可写");
        if (!ok) finish("stdin 不可写");
      }
    }
  } else if (type === "command_lifecycle") {
    if (msg.command_uuid === injectUuid) {
      if (!claimAt) claimAt = Date.now();
      claimStates.push(String(msg.state ?? "?"));
      note.push(`★注入帧被认领 state=${msg.state}`);
    }
  } else if (type === "result") {
    const isError = msg.is_error === true;
    if (!injectAt) {
      if (!firstResultAt) firstResultAt = Date.now();
      note.push(`注入未发生即收口 is_error=${isError}`);
      finish(isError && isBlocked(msg.result) ? "result(blocked?)" : "result");
    } else {
      postInjectResults += 1;
      if (!firstPostInjectResultAt) firstPostInjectResultAt = Date.now();
      if (String(msg.subtype ?? "") === "error_during_execution") sawInterruptResult = true;
      if (isError && isBlocked(msg.result)) blockedReason = String(msg.result).slice(0, 200);
      note.push(`注入后第${postInjectResults}轮收口 subtype=${msg.subtype} is_error=${isError} result="${String(msg.result ?? "").slice(0, 40)}"`);
      if (markerAt || postInjectResults >= 2) finish(`result(注入后第${postInjectResults}轮${markerAt ? "·已见 marker" : "·无 marker"})`);
    }
  }
  log(`${at()} ${type}${msg.subtype ? `/${msg.subtype}` : ""}${note.length ? " · " + note.join(" · ") : ""}`);
  if (framesOut) appendFileSync(framesOut, JSON.stringify(msg) + "\n");
}

child.stdout?.on("data", (c) => {
  buf += String(c);
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handleFrame(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
  }
});
child.once("exit", (code) => {
  if (!blockedReason && isBlocked(stderrText)) blockedReason = stderrText.trim().slice(0, 200);
  finish(`exit(${code ?? "signal"})`);
});
child.once("error", (e) => finish(`spawn error: ${e.message}`));

if (!writeStdin({ type: "user", message: { role: "user", content: [{ type: "text", text: turn1 }] } })) {
  log(`${at()} 首轮写入失败：stdin 不可用（CLI 是否支持 --input-format stream-json？）`);
  process.exit(1);
}
await finished;
try { child.kill("SIGTERM"); } catch { /* 已退 */ }

const C1 = Boolean(injectAt) && Boolean(firstPostInjectResultAt) && injectAt < firstPostInjectResultAt;
const C2 = C1 && toolUseAfterInject === 0 && sawInjectedOk;
const sameTurn = C2 && markerAt < firstPostInjectResultAt;
const C2a = C2 && sameTurn;
const verdict = blockedReason ? "blocked" : C2a ? "pass" : "fail";
const evidence = {
  C1_injected_before_turn_end: C1,
  C2_early_stop_with_marker: C2,
  C2a_marker_same_turn: C2a,
  C3_ack_frame: C1 && claimAt > 0,
  interrupt_like: C2 && !sameTurn, // 注入把本轮打断、另起一轮才回答 = 中断语义，不是 steer
  ackStates: claimStates.length ? [...new Set(claimStates)] : undefined,
  turnEndedByInterruptResult: sawInterruptResult || undefined,
  toolCallsTotal,
  toolUseAfterInject,
  postInjectResults,
  sawInjectedOk,
  injectedAtMs: injectAt ? injectAt - t0 : 0,
  ackAtMs: claimAt ? claimAt - t0 : 0,
  markerAtMs: markerAt ? markerAt - t0 : 0,
  injectTurnEndAtMs: firstPostInjectResultAt ? firstPostInjectResultAt - t0 : 0,
  cliVersion: cliVersion || undefined,
  ...(blockedReason ? { blockedReason } : {}),
};

log("");
log(`C1  注入早于本轮收口    : ${C1 ? "✔" : "✘"}（inject=${evidence.injectedAtMs}ms → 本轮收口 ${evidence.injectTurnEndAtMs}ms）`);
log(`C2  早停 + INJECTED-OK  : ${C2 ? "✔" : "✘"}（注入后新增 tool_use=${toolUseAfterInject}，marker=${markerAt ? `✔ ${markerAt - t0}ms` : "✘"}）`);
log(`C2a marker 与被注入同轮 : ${C2a ? "✔" : "✘"}${C2 && !C2a ? "（跨轮 = 中断语义：本轮被抢停，注入另起一轮才回答）" : ""}`);
log(`C3  CLI 显式认领注入帧  : ${evidence.C3_ack_frame ? "✔" : "✘"}（ack=${evidence.ackAtMs}ms${claimStates.length ? ` state=${[...new Set(claimStates)].join("→")}` : ""}）`);
log(`    本轮收口形态        : ${sawInterruptResult ? "error_during_execution（被注入打断）" : "正常收口"}；注入后共观察到 ${postInjectResults} 次收口`);
if (blockedReason) log(`blocked 原因: ${blockedReason}`);
log(`结论: ${verdict.toUpperCase()}`);

if (!record) {
  log("未记账（加 --record 才写探针账本；不记 = 能力位保持关）");
  process.exit(verdict === "pass" ? 0 : 2);
}

mkdirSync(stateDir, { recursive: true });
let book = {};
try { book = gate.parseSteerProbeBook(readFileSync(gate.steerProbePath(stateDir), "utf8")); } catch { /* 首次 */ }
const next = gate.mergeSteerProbeRecord(book, cli, {
  verdict,
  ...(cliVersion ? { cliVersion } : {}),
  at: new Date().toISOString(),
  evidence,
});
const path = gate.steerProbePath(stateDir);
writeFileSync(path, JSON.stringify({ probes: next }, null, 2) + "\n");
log(`已记账 ${path}`);
log(`证据键 ${gate.canonicalCliKey(cli)}`);
log(`门控结果: ${gate.describeSteerGate(next, cli)}`);
if (verdict === "pass") {
  log("下一步：POST /api/extensions/reload（或 node tools/deploy.mjs），**新开会话**验证插队");
} else if (verdict === "blocked") {
  log("额度/登录受阻：恢复后重跑；steer 保持关闭（fail-closed）");
} else {
  log("注入面未证实：steer 保持关闭；用 --frames-out 留现场再判");
}
process.exit(verdict === "pass" ? 0 : 2);
