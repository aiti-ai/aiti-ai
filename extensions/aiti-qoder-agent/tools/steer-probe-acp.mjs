#!/usr/bin/env node
/**
 * steer-probe-acp — ACP 驱动下的运行中注入（steer）**实跑探针**（能力位由证据开门，见 steer-gate.ts）。
 *
 * 背景：qodercli 1.1.81+ 移除 stream-json SDK worker 后，驱动改成 `qodercli --acp`
 * （JSON-RPC over stdio）。旧探针（tools/steer-probe.mjs）打的是 stream-json 的 stdin
 * `user` 帧，对 ACP 不适用——所以账本按驱动隔离（driver 字段），本探针只产 ACP 证据。
 *
 * 注入面（本机 1.1.87 二进制取证 + ACP 实跑验证）：
 *   - initialize 自报 `agentCapabilities._meta.qoder.promptQueueing: true`；
 *   - ACP `session/prompt` 走 CLI 自己的消息队列，`toCommand` 默认 `priority:"next"`，
 *     AgentLoop 工具间隙 drain（`[MessageQueue] enqueue ... priority=next` / `Mid-turn drain`）。
 *   → 客户端在**主轮 session/prompt 在途时**再发一条 session/prompt，即运行中注入。
 *
 * 它做什么：起一个 `qodercli --acp`，session/new 后发「连续 4 次 Bash sleep」的任务；
 * 在**第一个工具完成（tool_call_update status=completed）**后注入第二条 session/prompt，
 * 要求模型立即停止后续工具调用并只回 INJECTED-OK。
 *
 * 判据（pass 需要全部成立）：
 *   C0 CLI 自报 promptQueueing（协议能力位；CLI 不认这个通道 = 注入无意义）
 *   C1 注入发生在主轮 session/prompt 响应之前（否则只是普通的下一轮）
 *   C2 注入之后没有再出现新的 tool_call，且 assistant 文本里出现 INJECTED-OK
 *      —— 模型改了行为 = 注入确被本轮吸收（行为级证据，最强的那条）
 *   另外主轮若以 stopReason:"cancelled" 收口 = 注入把本轮打断（中断语义，不是 steer）→ 拒判 pass。
 *   blocked = 额度/登录受阻（不下 fail 结论，也不开门）
 *
 * 用法：
 *   node tools/steer-probe-acp.mjs                     # 只跑只报（cn 变体）
 *   node tools/steer-probe-acp.mjs --variant intl
 *   node tools/steer-probe-acp.mjs --record            # 结论写 <stateDir>/steer-probe.json（driver:"acp"）
 *   node tools/steer-probe-acp.mjs --frames-out /tmp/steer-acp-frames.jsonl   # 留现场
 *   node tools/steer-probe-acp.mjs --timeout 420000
 *
 * pass + --record 之后：reload 扩展（deploy 自动做，或 POST /api/extensions/reload），
 * **新开会话**生效（存量会话的能力表在创建时已固化）。
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};

const variant = opt("variant", "cn") === "intl" ? "intl" : "cn";
const deadlineMs = Number(opt("timeout", "300000"));
const framesOut = opt("frames-out", null);
const record = argv.includes("--record");
const stateDir = opt("state-dir", null)
  ? resolve(opt("state-dir", ""))
  // 与扩展 ctx.stateDir 同约定（探针脚本没有 ctx）
  : join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data"), "aiti-qoder-agent", "state");

// Windows-safe dynamic imports: bare `D:\...` paths are invalid ESM specifiers.
const { AcpRpc } = await import(pathToFileURL(join(here, "..", "qoder-acp.ts")).href);
const { resolveQoderCli, qoderLoginBin } = await import(pathToFileURL(join(here, "..", "login-driver.ts")).href);
const gate = await import(pathToFileURL(join(here, "..", "steer-gate.ts")).href);

const cli = opt("cli", "") || resolveQoderCli(variant) || qoderLoginBin(variant);
const turn1 =
  "请依次执行 4 次 Bash 工具调用，每次只跑 `sleep 6`（一次调用一个 sleep，不要合并、不要并行），" +
  "全部跑完后回一句 DONE。除此之外不要说别的。";
const injectedText = "立刻停止后续的 Bash 调用，不要再发起任何工具调用，只回复一个词：INJECTED-OK";

const log = (m) => console.log(m);
const t0 = Date.now();
const at = () => `[${String(Date.now() - t0).padStart(6, " ")}ms]`;
if (framesOut) mkdirSync(dirname(framesOut), { recursive: true });

const workDir = mkdtempSync(join(tmpdir(), "aiti-steer-acp-probe-"));
log(`${at()} cli=${cli}`);
log(`${at()} cwd=${workDir} variant=${variant} deadline=${deadlineMs}ms`);
log(`${at()} 第 1 轮: ${turn1}`);
log(`${at()} 注入文本: ${injectedText}`);

const child = spawn(cli, ["--acp"], { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
let stderrText = "";
child.stdin?.on("error", (e) => log(`${at()} stdin error: ${e.message}`));
child.stderr?.on("data", (c) => { stderrText += String(c); });
child.stderr?.on("error", () => { /* 忽略 */ });

// Full-duplex frame capture (--frames-out): raw JSONL lines both ways, prefixed
// C> (client→agent) / S> (agent→client). This is the evidence that decides
// "agent never replied" vs "we failed to match the reply".
if (framesOut) {
  const stdin = child.stdin;
  if (stdin) {
    const origWrite = stdin.write.bind(stdin);
    stdin.write = (chunk, ...rest) => {
      try { appendFileSync(framesOut, `C> ${String(chunk).trim()}\n`); } catch { /* ignore */ }
      return origWrite(chunk, ...rest);
    };
  }
  let rawBuf = "";
  child.stdout?.on("data", (c) => {
    rawBuf += String(c);
    let i;
    while ((i = rawBuf.indexOf("\n")) >= 0) {
      const line = rawBuf.slice(0, i).trim();
      rawBuf = rawBuf.slice(i + 1);
      if (line) { try { appendFileSync(framesOut, `S> ${line}\n`); } catch { /* ignore */ } }
    }
  });
}

// ---- state ----
let sessionId = "";
let cliVersion = "";
let promptQueueing = false;
let injected = false;
let injectAt = 0;
let injectError = "";
let primaryDoneAt = 0;
let primaryStopReason = "";
let primaryError = "";
let injectedDoneAt = 0;
let markerAt = 0;
let sawMarker = false;
let toolCallsTotal = 0;
let toolCallsAfterInject = 0;
let bashCalls = 0;
let blockedReason = "";
let injectedPromise = null;
const seenToolIds = new Set();

const BLOCK_MARKERS = [
  "credit usage limit", "usage limit", "upgrade your subscription",
  "not logged in", "unauthorized", "invalid token", "quota exceeded", "exceeded your",
];
const isBlocked = (text) => BLOCK_MARKERS.some((m) => String(text).toLowerCase().includes(m));

const rpc = new AcpRpc(child, {
  onRequest(method, params) {
    if (method === "session/request_permission") {
      const options = Array.isArray(params?.options) ? params.options : [];
      const kindOf = (o) => String(o?.kind ?? o?.optionKind ?? "");
      const allow = options.find((o) => kindOf(o).startsWith("allow")) ?? options[0];
      // 与扩展同款应答形状（index.ts respondInteraction）
      return allow?.optionId
        ? { outcome: { outcome: "allow_selected", optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    throw new Error(`unsupported agent request: ${method}`);
  },
  onNotification(method, params) {
    if (method !== "session/update") return;
    const u = params?.update;
    if (u && typeof u === "object") handleUpdate(u);
  },
}, (m) => log(`${at()} [acp] ${m}`));

child.once("error", (e) => finish(`spawn error: ${e.message}`));
child.once("exit", (code) => {
  if (!blockedReason && isBlocked(stderrText)) blockedReason = stderrText.trim().slice(0, 200);
  finish(`exit(${code ?? "signal"})`);
});

// ---- frame handling ----
function toolNameOf(u) {
  const meta = u?._meta?.qoder;
  if (meta && typeof meta.toolName === "string" && meta.toolName) return meta.toolName;
  return typeof u?.title === "string" ? u.title : "";
}

function handleUpdate(u) {
  const kind = String(u.sessionUpdate ?? "");
  if (framesOut) appendFileSync(framesOut, JSON.stringify({ update: u }) + "\n");
  if (kind === "agent_message_chunk") {
    const text = typeof u.content?.text === "string" ? u.content.text : "";
    if (!text) return;
    if (!markerAt && text.includes("INJECTED-OK")) {
      markerAt = Date.now();
      sawMarker = true;
      log(`${at()} ★INJECTED-OK（注入后 ${injectAt ? markerAt - injectAt : 0}ms）`);
      // 给第二段 loop 留 3s 收尾帧（注入请求响应/后续 update），再判收口
      const t = setTimeout(() => finish("marker"), 3_000);
      t.unref?.();
    }
    return;
  }
  if (kind === "tool_call") {
    const id = String(u.toolCallId ?? "");
    const status = String(u.status ?? "");
    const isNew = id ? !seenToolIds.has(id) : true;
    if (id) seenToolIds.add(id);
    if (isNew) {
      const name = toolNameOf(u);
      toolCallsTotal += 1;
      if (name.toLowerCase().includes("bash") || name.toLowerCase().includes("shell")) bashCalls += 1;
      if (injected) toolCallsAfterInject += 1;
      log(`${at()} tool_call ${name} status=${status || "?"}`);
    }
    // 同一 tool_call 帧也可能直接带终态（部分 ACP 实现把结果并进调用帧）
    if ((status === "completed" || status === "failed") && !injected) maybeInject();
    return;
  }
  if (kind === "tool_call_update" && String(u.status ?? "") === "completed" && !injected) {
    log(`${at()} tool_result ${toolNameOf(u) || "?"} completed`);
    maybeInject();
  }
}

function maybeInject() {
  injected = true;
  injectAt = Date.now();
  log(`${at()} ★注入（主轮 session/prompt 在途）`);
  injectedPromise = rpc.request(
    "session/prompt",
    { sessionId, prompt: [{ type: "text", text: injectedText }] },
    deadlineMs,
  );
  injectedPromise.then((r) => {
    injectedDoneAt = Date.now();
    log(`${at()} 注入请求响应 stopReason=${r?.stopReason ?? "?"}`);
  }).catch((e) => {
    injectedDoneAt = Date.now();
    injectError = e instanceof Error ? e.message : String(e);
    log(`${at()} 注入请求失败: ${injectError}`);
  });
}

// ---- finish control ----
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

// ---- bootstrap ----
try {
  const init = await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }, 60_000);
  cliVersion = String(init?.agentInfo?.version ?? "");
  promptQueueing = init?.agentCapabilities?._meta?.qoder?.promptQueueing === true;
  log(`${at()} initialize version=${cliVersion || "?"} promptQueueing=${promptQueueing}`);
  rpc.notify("initialized", {});

  const created = await rpc.request("session/new", { cwd: workDir, mcpServers: [] }, 60_000);
  sessionId = String(created?.sessionId ?? "");
  if (!sessionId) throw new Error("session/new returned no sessionId");
  log(`${at()} session/new sid=${sessionId}`);

  try {
    await rpc.request("session/set_mode", { sessionId, modeId: "yolo" }, 15_000);
    log(`${at()} set_mode yolo`);
  } catch (e) {
    log(`${at()} set_mode yolo 失败（继续）: ${e instanceof Error ? e.message : String(e)}`);
  }

  const primary = rpc.request(
    "session/prompt",
    { sessionId, prompt: [{ type: "text", text: turn1 }] },
    deadlineMs,
  );
  primary.then((r) => {
    primaryDoneAt = Date.now();
    primaryStopReason = String(r?.stopReason ?? "");
    log(`${at()} 主轮响应 stopReason=${primaryStopReason}`);
    if (!injected) finish("no-gap（主轮收口前没有工具间隙）");
  }).catch((e) => {
    primaryDoneAt = Date.now();
    primaryError = e instanceof Error ? e.message : String(e);
    if (isBlocked(primaryError)) blockedReason = primaryError.slice(0, 200);
    log(`${at()} 主轮失败: ${primaryError}`);
    finish("primary-error");
  });
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (isBlocked(msg)) blockedReason = msg.slice(0, 200);
  log(`${at()} bootstrap 失败: ${msg}`);
  finish("bootstrap-error");
}

await finished;
try { child.kill("SIGTERM"); } catch { /* 已退 */ }
if (!blockedReason && isBlocked(stderrText)) blockedReason = stderrText.trim().slice(0, 200);
try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }

// ---- verdict ----
const C1 = injected && primaryDoneAt > 0 && injectAt < primaryDoneAt;
const C2 = C1 && toolCallsAfterInject === 0 && sawMarker;
const sameTurn = C2 && primaryDoneAt > 0 && markerAt < primaryDoneAt;
const interruptLike = primaryStopReason === "cancelled";
const verdict = blockedReason ? "blocked"
  : C2 && !interruptLike && promptQueueing ? "pass"
    : "fail";
const evidence = {
  driver: "acp",
  promptQueueing,
  C0_prompt_queueing_advertised: promptQueueing,
  C1_injected_before_turn_end: C1,
  C2_early_stop_with_marker: C2,
  C2a_marker_before_primary_response: sameTurn,
  interrupt_like: interruptLike,
  primaryStopReason: primaryStopReason || undefined,
  injectedResponseOk: injectedDoneAt > 0 && !injectError ? true : injectError ? false : undefined,
  injectError: injectError || undefined,
  toolCallsTotal,
  bashCalls,
  toolCallsAfterInject,
  sawInjectedOk: sawMarker,
  injectedAtMs: injectAt ? injectAt - t0 : 0,
  markerAtMs: markerAt ? markerAt - t0 : 0,
  primaryDoneAtMs: primaryDoneAt ? primaryDoneAt - t0 : 0,
  injectedDoneAtMs: injectedDoneAt ? injectedDoneAt - t0 : 0,
  cliVersion: cliVersion || undefined,
  ...(blockedReason ? { blockedReason } : {}),
};

log("");
log(`C0  CLI 自报 promptQueueing : ${promptQueueing ? "✔" : "✘"}（initialize agentCapabilities._meta.qoder）`);
log(`C1  注入早于主轮收口     : ${C1 ? "✔" : "✘"}（inject=${evidence.injectedAtMs}ms → 主轮 ${evidence.primaryDoneAtMs}ms）`);
log(`C2  早停 + INJECTED-OK   : ${C2 ? "✔" : "✘"}（注入后新 tool_call=${toolCallsAfterInject}，marker=${markerAt ? `✔ ${markerAt - t0}ms` : "✘"}）`);
log(`    同轮 marker 证据      : ${sameTurn ? "✔" : "✘"}（marker ${evidence.markerAtMs}ms vs 主轮 ${evidence.primaryDoneAtMs}ms）`);
log(`    主轮收口形态          : ${primaryStopReason || "?"}${interruptLike ? "（中断语义：注入把本轮抢停）" : ""}`);
if (blockedReason) log(`blocked 原因: ${blockedReason}`);
log(`结论: ${verdict.toUpperCase()}`);

// CLI-side queue logs ([MessageQueue] enqueue/drain ...) live on stderr — always
// show the tail so a hang is attributable (agent never drained vs drained late).
const stderrLines = stderrText.trim().split("\n").filter((l) => l.trim());
if (stderrLines.length) {
  log(`--- CLI stderr tail（最后 ${Math.min(40, stderrLines.length)} 行）---`);
  for (const l of stderrLines.slice(-40)) log(`  ${l}`);
}

if (!record) {
  log("未记账（加 --record 才写探针账本；不记 = 能力位保持关）");
  process.exit(verdict === "pass" ? 0 : 2);
}

mkdirSync(stateDir, { recursive: true });
let book = {};
try { book = gate.parseSteerProbeBook(readFileSync(gate.steerProbePath(stateDir), "utf8")); } catch { /* 首次 */ }
const next = gate.mergeSteerProbeRecord(book, cli, {
  verdict,
  driver: "acp",
  ...(cliVersion ? { cliVersion } : {}),
  at: new Date().toISOString(),
  evidence,
});
const path = gate.steerProbePath(stateDir);
writeFileSync(path, JSON.stringify({ probes: next }, null, 2) + "\n");
log(`已记账 ${path}`);
log(`证据键 ${gate.canonicalCliKey(cli)}`);
log(`门控结果(acp): ${gate.describeSteerGate(next, cli, "acp")}`);
if (verdict === "pass") {
  log("下一步：POST /api/extensions/reload（或 node tools/deploy.mjs），**新开会话**验证插队");
} else if (verdict === "blocked") {
  log("额度/登录受阻：恢复后重跑；steer 保持关闭（fail-closed）");
} else {
  log("注入面未证实：steer 保持关闭；用 --frames-out 留现场再判");
}
process.exit(verdict === "pass" ? 0 : 2);