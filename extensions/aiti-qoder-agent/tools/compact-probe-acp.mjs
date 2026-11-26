#!/usr/bin/env node
/**
 * compact-probe-acp — evidence probe for the Qoder backend's manual context
 * compaction capability (`capabilities.compact`, gated in compact-gate.ts).
 *
 * Why a probe: ACP has no `session/compact` method and qodercli's
 * `available_commands_update` frame lists its slash commands without `compact`
 * (1.1.83: 26 entries, none of them compact). The only channel left is the CLI's
 * own interactive command, sent as a plain `session/prompt` whose text is
 * `/compact`. Whether the headless ACP layer routes that text to the command or
 * forwards it to the model as ordinary user text is a runtime fact, not something
 * to infer from the binary strings — hence a real run.
 *
 * Flow (cheapest evidence first):
 *   1. initialize → session/new → collect `available_commands_update` (C0);
 *   2. `/compact` on the fresh, empty session: an unsupported CLI refuses in ~2s
 *      without any model call ("Command /compact requires interactive UI and is
 *      not available in ACP.") → fail immediately, zero credits spent;
 *   3. only when that is not refused: one tiny model turn ("Reply with exactly:
 *      OK") so the session has something to compact, snapshot the native
 *      transcript's compaction boundaries, send `/compact` again and wait for the
 *      CLI itself to write a `system/compact_boundary` record (C2).
 *
 * Criteria:
 *   C0  the CLI advertises a `compact` slash command (informational — an accepted
 *       but unadvertised command still counts)
 *   C1  the `/compact` prompt is not answered with the interactive-UI refusal
 *   C2  objective CLI-side proof, either a new compaction boundary in the
 *       transcript, or the CLI's own command-handler wording ("Nothing to compress
 *       yet. /compact needs at least one model response ...") — text only the
 *       command layer produces, never the model
 *   pass = C1 && C2. `blocked` = quota/login obstacle (no conclusion, gate stays shut).
 *
 * Costs: one tiny model turn, and only on runs where C1 is not already refused.
 *
 * Usage:
 *   node tools/compact-probe-acp.mjs                       # probe + report
 *   node tools/compact-probe-acp.mjs --variant intl
 *   node tools/compact-probe-acp.mjs --record              # write <stateDir>/compact-probe.json
 *   node tools/compact-probe-acp.mjs --frames-out /tmp/compact-acp-frames.jsonl
 *   node tools/compact-probe-acp.mjs --timeout 900000      # overall deadline (ms)
 *
 * After `pass --record`: reload the extension (deploy does it, or POST
 * /api/extensions/reload) and open a NEW session (capability tables are frozen
 * when a handle is created).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
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
const deadlineMs = Number(opt("timeout", "900000"));
/** How long to wait for a transcript boundary after the /compact response (compaction takes minutes). */
const boundaryWaitMs = Number(opt("boundary-wait", "300000"));
/** How long to wait for the slash catalogue frame after session/new. */
const commandsWaitMs = Number(opt("commands-wait", "8000"));
const framesOut = opt("frames-out", null);
const record = argv.includes("--record");
const stateDir = opt("state-dir", null)
  ? resolve(opt("state-dir", ""))
  : join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web", "data"), "aiti-qoder-agent", "state");

// Windows-safe dynamic imports: bare `D:\...` paths are invalid ESM specifiers.
const { AcpRpc } = await import(pathToFileURL(join(here, "..", "qoder-acp.ts")).href);
const { resolveQoderCli, qoderLoginBin } = await import(pathToFileURL(join(here, "..", "login-driver.ts")).href);
const transcripts = await import(pathToFileURL(join(here, "..", "native-transcript.ts")).href);
const gate = await import(pathToFileURL(join(here, "..", "compact-gate.ts")).href);
const probeBook = await import(pathToFileURL(join(here, "..", "probe-book.ts")).href);

const cli = opt("cli", "") || resolveQoderCli(variant) || qoderLoginBin(variant);
const warmupText = "Reply with exactly: OK";
const compactText = "/compact";

/** The CLI's answer when the command is only available in its interactive TUI. */
const REFUSAL = /requires interactive UI|not available in ACP/i;
/** Wording that only the CLI's command handler produces (never a model reply). */
const HANDLED_NOOP = /nothing to compress yet|nothing to compact\b/i;
const BLOCK_MARKERS = [
  "credit usage limit", "usage limit", "upgrade your subscription",
  "not logged in", "unauthorized", "invalid token", "quota exceeded", "exceeded your",
];
const isBlocked = (text) => BLOCK_MARKERS.some((m) => String(text).toLowerCase().includes(m));

const t0 = Date.now();
const at = () => `[${String(Date.now() - t0).padStart(6, " ")}ms]`;
const log = (m) => console.log(m);

const workDir = mkdtempSync(join(tmpdir(), "aiti-compact-probe-"));
log(`${at()} cli=${cli}`);
log(`${at()} cwd=${workDir} variant=${variant} deadline=${deadlineMs}ms boundary-wait=${boundaryWaitMs}ms`);

const child = spawn(cli, ["--acp"], { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
let stderrText = "";
child.stdin?.on("error", (e) => log(`${at()} stdin error: ${e.message}`));
child.stderr?.on("data", (c) => { stderrText += String(c); });
child.stderr?.on("error", () => { /* ignore */ });

// Full-duplex frame capture (--frames-out): raw JSONL both ways, prefixed C> / S>.
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
let advertisedCommands = [];
let sawCommandsFrame = false;
let resolveCommandsFrame = null;
const commandsFrame = new Promise((r) => { resolveCommandsFrame = r; });
let turnText = ""; // assistant text of the prompt currently in flight
let warmupStopReason = "";
let compactStopReason = "";
let compactError = "";
let refusalText = "";
/** Command-handler wording seen on probe #1 (empty session) — informative only. */
let firstProbeNoop = false;
/** Command-handler wording seen on probe #2 (the real attempt, after a model turn). */
let handledNoop = false;
let blockedReason = "";
let boundariesBefore = 0;
let boundariesAfter = 0;
let boundaryAdded = false;
let boundaryTimer = null;
let watcher = null;
let done = false;
let settled;
const finished = new Promise((r) => { settled = r; });

function finish(how) {
  if (done) return;
  done = true;
  clearTimeout(killTimer);
  if (boundaryTimer) clearTimeout(boundaryTimer);
  if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
  log(`${at()} 收口：${how}`);
  settled(how);
}
const killTimer = setTimeout(() => finish("timeout"), deadlineMs);
killTimer.unref?.();

function readBoundaries() {
  const fp = transcripts.resolveNativeSessionFile(sessionId);
  if (!fp) return { count: 0, file: "" };
  return { count: transcripts.transcriptCompactBoundaries(fp).length, file: fp };
}

/** The CLI appends the boundary while compacting: check once, then wait for a write event (no polling). */
function awaitCompactProof() {
  const now = readBoundaries();
  boundariesAfter = now.count;
  if (boundariesAfter > boundariesBefore) {
    boundaryAdded = true;
    log(`${at()} ★transcript compact_boundary 新增：${boundariesBefore} → ${boundariesAfter}（${now.file}）`);
    finish("boundary");
    return;
  }
  if (handledNoop) {
    log(`${at()} CLI 以命令层文案应答且未产生 boundary`);
    finish("handled-noop");
    return;
  }
  if (!now.file) {
    log(`${at()} 未找到 native transcript（${sessionId}）——无法取证 boundary`);
    finish("no-transcript");
    return;
  }
  try {
    watcher = watch(now.file, () => {
      const cur = readBoundaries();
      boundariesAfter = cur.count;
      if (boundariesAfter > boundariesBefore) {
        boundaryAdded = true;
        log(`${at()} ★transcript compact_boundary 新增：${boundariesBefore} → ${boundariesAfter}`);
        finish("boundary");
      }
    });
    watcher.on?.("error", () => { /* the deadline still settles the run */ });
  } catch (e) {
    log(`${at()} watch 失败（继续等 deadline）：${e instanceof Error ? e.message : String(e)}`);
  }
  boundaryTimer = setTimeout(() => finish("boundary-timeout"), boundaryWaitMs);
  boundaryTimer.unref?.();
  log(`${at()} 等 transcript compact_boundary（≤${boundaryWaitMs}ms，事件驱动）`);
}

const rpc = new AcpRpc(child, {
  onRequest(method, params) {
    if (method === "session/request_permission") {
      const options = Array.isArray(params?.options) ? params.options : [];
      const kindOf = (o) => String(o?.kind ?? o?.optionKind ?? "");
      const allow = options.find((o) => kindOf(o).startsWith("allow")) ?? options[0];
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

function handleUpdate(u) {
  const kind = String(u.sessionUpdate ?? "");
  if (kind === "available_commands_update") {
    const cmds = Array.isArray(u.availableCommands) ? u.availableCommands : [];
    advertisedCommands = cmds.map((c) => String(c?.name ?? "")).filter(Boolean);
    sawCommandsFrame = true;
    log(`${at()} available_commands_update：${advertisedCommands.length} 条${advertisedCommands.includes("compact") ? "（含 compact）" : "（无 compact）"}`);
    resolveCommandsFrame?.();
    return;
  }
  if (kind === "agent_message_chunk") {
    const text = typeof u.content?.text === "string" ? u.content.text : "";
    if (text) turnText += text;
    return;
  }
}

/** Send one prompt turn and return what the CLI said (text is also accumulated in turnText). */
async function promptTurn(text, timeoutMs, label) {
  turnText = "";
  log(`${at()} ${label}：prompt ${JSON.stringify(text)}`);
  try {
    const res = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, timeoutMs);
    const stopReason = String(res?.stopReason ?? "");
    log(`${at()} ${label} 收口 stopReason=${stopReason || "?"} 文本=${JSON.stringify(turnText.trim().slice(0, 200))}`);
    return { ok: true, stopReason, text: turnText.trim() };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`${at()} ${label} 失败：${error}`);
    return { ok: false, stopReason: "", error, text: turnText.trim() };
  }
}

/** Fold one /compact reply into the criteria state (probe #1 and #2 are judged separately). */
function noteCompactReply(text, phase) {
  if (REFUSAL.test(text)) refusalText = text;
  else if (HANDLED_NOOP.test(text)) {
    if (phase === 1) firstProbeNoop = true;
    else handledNoop = true;
  }
}

// ---- bootstrap ----
try {
  const init = await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  }, 60_000);
  cliVersion = String(init?.agentInfo?.version ?? "");
  log(`${at()} initialize version=${cliVersion || "?"}`);
  rpc.notify("initialized", {});

  const created = await rpc.request("session/new", { cwd: workDir, mcpServers: [] }, 60_000);
  sessionId = String(created?.sessionId ?? "");
  if (!sessionId) throw new Error("session/new returned no sessionId");
  log(`${at()} session/new sid=${sessionId}`);

  try {
    await rpc.request("session/set_mode", { sessionId, modeId: "yolo" }, 15_000);
    log(`${at()} set_mode yolo`);
  } catch (e) {
    log(`${at()} set_mode yolo 失败（继续）：${e instanceof Error ? e.message : String(e)}`);
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (isBlocked(msg)) blockedReason = msg.slice(0, 200);
  log(`${at()} bootstrap 失败：${msg}`);
  finish("bootstrap-error");
}

// C0 window: the slash catalogue lands right after session/new (event-driven, deadline-bounded).
if (!done) {
  await Promise.race([
    commandsFrame,
    new Promise((r) => { const t = setTimeout(r, commandsWaitMs); t.unref?.(); }),
  ]);
}

// Probe #1 — empty session, cheapest discriminator (an unsupported CLI refuses with no model call).
if (!done) {
  const first = await promptTurn(compactText, 180_000, "探测回合 #1（空会话）");
  noteCompactReply(first.text, 1);
  compactStopReason = first.stopReason;
  if (!first.ok) {
    // A refusal arrives as a normal end_turn reply (handled above); a rejected request is a
    // transport problem and leaves nothing to judge.
    const msg = first.error ?? "prompt failed";
    if (isBlocked(msg) || isBlocked(first.text)) blockedReason = msg.slice(0, 200);
    else { compactError = msg; finish("probe1-error"); }
  }
  if (refusalText) finish("refused");
}

// Probe #2 — the CLI answered something other than a refusal: give it content, then look for proof.
if (!done && !blockedReason) {
  const warm = await promptTurn(warmupText, 240_000, "预热回合");
  warmupStopReason = warm.stopReason;
  if (!warm.ok) {
    if (isBlocked(warm.error ?? "") || isBlocked(warm.text)) blockedReason = (warm.error ?? warm.text).slice(0, 200);
    else finish("warmup-error");
  }
}

if (!done && !blockedReason) {
  const before = readBoundaries();
  boundariesBefore = before.count;
  log(`${at()} compact 前 boundary=${boundariesBefore}（${before.file || "transcript 未见"}）`);
  const second = await promptTurn(compactText, 600_000, "探测回合 #2（有内容）");
  noteCompactReply(second.text, 2);
  compactStopReason = second.stopReason || compactStopReason;
  if (!second.ok) {
    if (isBlocked(second.error ?? "") || isBlocked(second.text)) blockedReason = (second.error ?? second.text).slice(0, 200);
    else if (!refusalText && !handledNoop) compactError = second.error ?? "prompt failed";
  }
  if (refusalText) finish("refused");
  else awaitCompactProof();
}

await finished;
try { child.kill("SIGTERM"); } catch { /* already gone */ }
if (!blockedReason && isBlocked(stderrText)) blockedReason = stderrText.trim().slice(0, 200);
try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }

// ---- verdict ----
const C0 = advertisedCommands.includes("compact");
const C1 = !refusalText && !compactError && !blockedReason;
const C2 = boundaryAdded || handledNoop;
const verdict = blockedReason ? "blocked" : C1 && C2 ? "pass" : "fail";
const evidence = {
  driver: "acp",
  C0_command_advertised: C0,
  C1_slash_accepted_by_acp: C1,
  C2_cli_side_proof: C2,
  c2_proofKind: boundaryAdded ? "compact-boundary" : handledNoop ? "command-handler-reply" : undefined,
  boundariesBefore,
  boundariesAfter,
  advertisedCommandCount: advertisedCommands.length,
  commandsFrameSeen: sawCommandsFrame,
  refusalText: refusalText || undefined,
  emptySessionCommandReply: firstProbeNoop,
  handledNoop,
  compactStopReason: compactStopReason || undefined,
  compactError: compactError || undefined,
  warmupStopReason: warmupStopReason || undefined,
  cliVersion: cliVersion || undefined,
  ...(blockedReason ? { blockedReason } : {}),
};

log("");
log(`C0  CLI 在 ACP 面广告 compact 命令 : ${C0 ? "✔" : "✘"}（availableCommands ${advertisedCommands.length} 条）`);
log(`C1  /compact 未被 ACP 层拒绝        : ${C1 ? "✔" : "✘"}${refusalText ? `（${refusalText.slice(0, 120)}）` : ""}`);
log(`C2  CLI 侧压缩实证（boundary/文案）  : ${C2 ? "✔" : "✘"}（boundary ${boundariesBefore}→${boundariesAfter}，handledNoop=${handledNoop}）`);
if (blockedReason) log(`blocked 原因：${blockedReason}`);
log(`结论：${verdict.toUpperCase()}`);

const stderrLines = stderrText.trim().split("\n").filter((l) => l.trim());
if (stderrLines.length) {
  log(`--- CLI stderr tail（最后 ${Math.min(20, stderrLines.length)} 行）---`);
  for (const l of stderrLines.slice(-20)) log(`  ${l}`);
}

if (!record) {
  log("未记账（加 --record 才写探针账本；不记 = 能力位保持关）");
  process.exit(verdict === "pass" ? 0 : 2);
}

mkdirSync(stateDir, { recursive: true });
let book = {};
const ledger = gate.compactProbePath(stateDir);
try { book = gate.parseCompactProbeBook(readFileSync(ledger, "utf8")); } catch { /* first run */ }
const next = gate.mergeCompactProbeRecord(book, cli, {
  verdict,
  driver: "acp",
  ...(cliVersion ? { cliVersion } : {}),
  at: new Date().toISOString(),
  evidence,
});
writeFileSync(ledger, JSON.stringify({ probes: next }, null, 2) + "\n");
log(`已记账 ${ledger}`);
log(`证据键 ${probeBook.canonicalCliKey(cli)}`);
log(`门控结果：${gate.describeCompactGate(next, cli)}`);
if (verdict === "pass") {
  log("下一步：POST /api/extensions/reload（或 node tools/deploy.mjs），**新开会话**验证 Compact 按钮");
} else if (verdict === "blocked") {
  log("额度/登录受阻：恢复后重跑；compact 保持关闭（fail-closed）");
} else {
  log("手动压缩面未证实：compact 保持关闭（CLI 自动压缩不受影响）");
}
process.exit(verdict === "pass" ? 0 : 2);
