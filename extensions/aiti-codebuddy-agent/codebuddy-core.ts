/**
 * codebuddy-core —— aiti-codebuddy-agent 核心逻辑（纯模块，可测）。
 *
 * 职责：
 *   1. CLI 解析：feature/env 指定路径 → PATH 上 cbc/codebuddy → npx（node + npx-cli.js，
 *      免 systemd PATH 缺 nvm 的坑）；npx 每次拉最新缓存的包（首用有下载延迟，见 plan §7）。
 *   2. 进程编排（双模式，2026-09-12 起默认长连接）：
 *      stream（默认，参照 aiti-claude-code-agent）：`cbc -p --input-format stream-json
 *       --output-format stream-json --include-partial-messages --verbose
 *       [--model M] [--permission-mode X] [--resume sid]` 单进程多轮；
 *      exec（兼容档）：`cbc -p <prompt> --output-format stream-json --include-partial-messages
 *       [--model M] [--permission-mode X] [--resume sid]` 每轮单发 + --resume（同 zcode/codex exec 模式）。
 *   3. 帧解析（2.148.0 未登录实测钉死）：**stream-json 输出与 CC 完全同形**
 *      （system/init、stream_event、assistant{message{content[]}}、result{is_error,usage,
 *       modelUsage}）——注意与存储 jsonl（顶层 role/content）是两套形状，互不相干。
 *      ⚠ 错误轮 exit code 也是 0（实测）——成败只认 result 帧 is_error / 有无 result 帧。
 *   4. 凭据（plan §4.3 路径 A · P0）：CODEBUDDY_API_KEY / CODEBUDDY_AUTH_TOKEN /
 *      CODEBUDDY_BASE_URL env 直读通道；值存扩展 dataDir 凭据文件（0600），每轮 spawn 注入。
 *      浏览器 OAuth（服务端 PTY 驱动）留 P1（plan §9.3，依赖 aiti-cmd runner services 注册）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import { StringDecoder } from "node:string_decoder";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { governanceEnv } from "./external-governance.ts";
import { agentSpawnEnv, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";

// ============================================================================
// CLI 解析
// ============================================================================

export interface ResolvedCli {
  /** direct = 直接执行 bin；npx = [node, npx-cli.js, "-y", <spec>, …turnArgs] */
  kind: "direct" | "npx";
  cmd: string;
  baseArgs: string[];
}

function which(bin: string): string | null {
  return whichBin(bin); // 纯 fs PATH 探测（零 spawn，不阻塞事件循环）
}

/** npm 的 npx-cli.js：nvm/unix 布局 <node目录>/../lib/node_modules/npm/bin/npx-cli.js；
 *  Windows 布局 <node目录>/node_modules/npm/bin/npx-cli.js。CODEBUDDY_NPX_PATH 可覆盖。 */
export function npxCliJsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEBUDDY_NPX_PATH) return env.CODEBUDDY_NPX_PATH;
  const binDir = dirname(process.execPath);
  const candidate = process.platform === "win32"
    ? join(binDir, "node_modules", "npm", "bin", "npx-cli.js")
    : join(binDir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js");
  return candidate;
}

/**
 * 解析 CLI 三元组（按序尝试；全落空 throw 人话错误）：
 *   1. featurePath（codebuddy.cliPath）或 env CODEBUDDY_CLI_PATH —— 绝对路径直调（免 npx 冷启动）
 *   2. PATH 上的 `cbc` / `codebuddy`（npm -g 或 brew 装机）
 *   3. npx -y <pkgSpec>（零安装；npx-cli.js 用 pi-web 自身 node 执行）
 */
export function resolveCli(opts: { featurePath?: string; pkgSpec?: string } = {}): ResolvedCli {
  const explicit = opts.featurePath?.trim() || process.env.CODEBUDDY_CLI_PATH?.trim() || "";
  if (explicit) {
    if (existsSync(explicit)) return { kind: "direct", cmd: explicit, baseArgs: [] };
    throw new Error(`codebuddy.cliPath 指定的路径不存在：${explicit}`);
  }
  for (const bin of ["cbc", "codebuddy"]) {
    const hit = which(bin);
    if (hit) return { kind: "direct", cmd: hit, baseArgs: [] };
  }
  const npxCli = npxCliJsPath();
  if (existsSync(npxCli)) {
    return { kind: "npx", cmd: process.execPath, baseArgs: [npxCli, "-y", opts.pkgSpec || DEFAULT_PKG_SPEC] };
  }
  throw new Error(
    "未找到 CodeBuddy Code CLI。解决（任选其一）：\n"
    + "1. 扩展管理器 → aiti-codebuddy-agent → 功能管理 → codebuddy.cliPath 填 cbc 可执行文件路径；\n"
    + "2. 安装：npm i -g @tencent-ai/codebuddy-code（或 brew install codebuddy-code）；\n"
    + "3. 依赖 npx 兜底时确认 node 安装自带 npm（npx-cli.js 可寻）。",
  );
}

export const DEFAULT_PKG_SPEC = "@tencent-ai/codebuddy-code";

// ============================================================================
// 每轮 argv 组装
// ============================================================================

export function buildTurnArgs(opts: {
  prompt: string;
  sessId?: string;
  model?: string;
  permissionMode?: string;
  /** stream-json 增量帧（message_update 打字机）；CLI 缺该 flag 也不致命（丢增量不丢结果帧） */
  includePartial?: boolean;
}): string[] {
  return [
    "-p", opts.prompt,
    "--output-format", "stream-json",
    ...(opts.includePartial === false ? [] : ["--include-partial-messages"]),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.permissionMode ? ["--permission-mode", opts.permissionMode] : []),
    ...(opts.sessId ? ["--resume", opts.sessId] : []),
  ];
}

// ============================================================================
// 长连接（stream 模式）argv / stdin 行（CC 同形；2.150.0 实测钉死）
// ============================================================================

/** 长连接启动 argv（stream-json 双端；实测多轮同进程 + control_request 三通道可用）。 */
export function buildStreamArgs(opts: {
  model?: string;
  permissionMode?: string;
  resumeSid?: string;
  /** stream-json 增量帧（message_update 打字机）；缺省开启 */
  includePartial?: boolean;
}): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    ...(opts.includePartial === false ? [] : ["--include-partial-messages"]),
    "--verbose",
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.permissionMode ? ["--permission-mode", opts.permissionMode] : []),
    ...(opts.resumeSid ? ["--resume", opts.resumeSid] : []),
  ];
}

/** stdin 用户消息行（stream-json 输入协议：{type:"user",message:{...}}）。 */
export function userLine(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
}

/** stdin 控制请求行（interrupt / set_model / set_permission_mode，CC 同形；cbc 实测三通道全支持）。 */
export function controlRequestLine(requestId: string, request: Record<string, unknown>): string {
  return JSON.stringify({ type: "control_request", request_id: requestId, request });
}

/**
 * turn-ack：result 帧是否属于「写入被 CLI 吞掉后的复读」。
 *
 * 背景（2026-09-12 实测）：cbc stream-json + MCP 连通时，result 后极短窗口内写入的
 * 用户行会被吞——CLI 复读上一轮 result 且不启动新轮（与延迟非单调相关，50/150ms 可过、
 * 200ms 也丢过）；纯延迟规避不可靠，靠本判定 + 有界重写。
 *
 * 判据：有上轮 result 可比、本轮无任何活动帧、非错误轮，且
 *（结果文本与上轮完全相同 或 距写入 < 1500ms）。
 */
export function isSwallowedResult(opts: {
  /** 本轮写入后是否见过 stream_event/assistant 等活动帧（真轮必然有） */
  activity: boolean;
  resultText: string;
  /** 上一轮 result 文本；null = 无上轮（不可能复读） */
  lastResultText: string | null;
  /** 距本次写入的毫秒数 */
  sinceWriteMs: number;
  isError?: boolean;
}): boolean {
  if (opts.lastResultText === null) return false;
  if (opts.isError === true) return false;
  if (opts.activity) return false;
  if (opts.resultText === opts.lastResultText) return true;
  return opts.sinceWriteMs >= 0 && opts.sinceWriteMs < 1500;
}

// ============================================================================
// stream-json 帧解析（CC 同形；2.148.0 实测）
// ============================================================================

export interface CbcFrame extends Record<string, unknown> {
  type?: string;
  subtype?: string;
  session_id?: string;
}

/** 单行 → 帧对象（非 JSON / 控制噪声返回 null）。 */
export function parseFrame(line: string): CbcFrame | null {
  const s = line.trim();
  if (!s.startsWith("{")) return null;
  try {
    const m = JSON.parse(s) as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as CbcFrame) : null;
  } catch {
    return null;
  }
}

export interface ParsedAssistant {
  text: string;
  model: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

/** assistant 帧 → 文本/模型/工具调用（兼容 message.content 嵌套与顶层 content 两种形状）。 */
export function parseAssistantFrame(frame: CbcFrame): ParsedAssistant | null {
  const message = (frame.message ?? null) as Record<string, unknown> | null;
  const content = Array.isArray(message?.content)
    ? message!.content
    : Array.isArray(frame.content) ? frame.content : null;
  if (!content) return null;
  let text = "";
  const toolCalls: ParsedAssistant["toolCalls"] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== "object") continue;
    if ((b.type === "text" || b.type === "output_text") && typeof b.text === "string") text += b.text;
    else if (b.type === "tool_use" && typeof b.name === "string") {
      toolCalls.push({
        id: String(b.id ?? ""),
        name: b.name,
        input: (b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {}) as Record<string, unknown>,
      });
    }
  }
  const rawModel = message && typeof message.model === "string" ? message.model
    : typeof frame.model === "string" ? frame.model : "";
  return { text, model: rawModel, toolCalls };
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ============================================================================
// stream-json 工具结果（user 帧 tool_result；与 CC 同形，2026-09-13 cbc 2.150.0 真机钉死）
// ============================================================================

export interface CbcToolResult {
  /** 对应 assistant tool_use 的 id（chatcmpl-tool-*）；缺失时为空串（孤儿兜底）。 */
  callId: string;
  text: string;
  isError: boolean;
}

/**
 * user 帧 → 工具结果列表（stream/exec 两档同一输出协议）。
 *
 * 形状（实测）：
 *   {"type":"user","message":{"content":[{"type":"tool_result",
 *     "tool_use_id":"chatcmpl-tool-…","is_error":false,
 *     "content":[{"type":"text","text":"Command: …\nStdout: …"}]}]}}
 * 兼容：content 为字符串 / 块数组 / 缺省；一帧多条 tool_result。
 * 注意：user 帧也可能是用户消息回显（text 块）——这里只认 tool_result 块。
 */
export function toolResultsFromUserFrame(frame: CbcFrame): CbcToolResult[] {
  const message = (frame.message ?? null) as Record<string, unknown> | null;
  const content = Array.isArray(message?.content)
    ? message!.content
    : Array.isArray(frame.content) ? frame.content : null;
  if (!content) return [];
  const out: CbcToolResult[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (!b || typeof b !== "object" || b.type !== "tool_result") continue;
    const callId = typeof b.tool_use_id === "string" && b.tool_use_id
      ? b.tool_use_id
      : typeof b.callId === "string" ? b.callId : "";
    const raw = (b as { content?: unknown }).content;
    let text = "";
    if (typeof raw === "string") text = raw;
    else if (Array.isArray(raw)) {
      text = raw
        .map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : ""))
        .join("");
    }
    out.push({ callId, text: text.trim(), isError: b.is_error === true || b.status === "failed" });
  }
  return out;
}

export interface TurnUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  numTurns?: number;
  contextWindow?: number;
}

/** result 帧 → 归一 usage（context ≈ input+cache_read+cache_creation；contextWindow 取 modelUsage 首档）。 */
export function usageFromResult(frame: CbcFrame): TurnUsage {
  const u = (frame.usage ?? {}) as Record<string, unknown>;
  const modelUsage = (frame.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
  const first = Object.entries(modelUsage)[0];
  const usage: TurnUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    costUsd: num(frame.total_cost_usd),
    numTurns: num(frame.num_turns),
    ...(first ? { model: first[0], contextWindow: num(first[1].contextWindow) } : {}),
  };
  return usage;
}

/** stream_event 帧 → 文本增量（content_block_delta/text_delta；其他增量类型忽略）。 */
export function deltaFromStreamEvent(frame: CbcFrame): string | null {
  const ev = (frame.event ?? {}) as Record<string, unknown>;
  if (String(ev.type ?? "") !== "content_block_delta") return null;
  const delta = (ev.delta ?? {}) as Record<string, unknown>;
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : null;
}

// ============================================================================
// 失败人话提取（错误轮 exit 0 + result.is_error=true 是常态；进程异常退出也有兜底）
// ============================================================================

export function extractTurnError(opts: { resultError?: string; errors?: unknown; stderrTail?: string; fallback: string }): string {
  const err0 = Array.isArray(opts.errors) && typeof opts.errors[0] === "string" ? opts.errors[0] : "";
  const detail = opts.resultError || err0;
  if (detail) {
    if (/authentication required|please use \/login/i.test(detail)) {
      return [
        "CodeBuddy 未登录（CLI 返回：Authentication required）。",
        "解决：扩展管理器 → aiti-codebuddy-agent → 功能管理，填入 codebuddy.apiKey（或 codebuddy.authToken；",
        "第三方模型网关再配 codebuddy.baseUrl），或等待 Agent 管理界面的浏览器 OAuth 登录（P1）。",
      ].join("\n");
    }
    return `CodeBuddy CLI: ${detail.slice(0, 300)}`;
  }
  const lines = (opts.stderrTail ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) return `CodeBuddy CLI: ${lines[lines.length - 1].slice(0, 300)}`;
  return opts.fallback;
}

// ============================================================================
// 每轮进程执行（stdout 逐行喂 onFrame；stderr 尾部环形）
// ============================================================================

export interface CbcTurnOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  stderrTail: string;
  sawResult: boolean;
}

const STDERR_TAIL_BYTES = 8 * 1024;

// ---- stdout 帧循环（纯函数，可重放测试；execCbcTurn 消费） ----

export interface StdoutFeedState {
  buffer: string;
  sawResult: boolean;
}

export function createFeedState(): StdoutFeedState {
  return { buffer: "", sawResult: false };
}

/** 喂一段 stdout（帧可跨 chunk 边界；一 chunk 多帧都拆开派发）。返回本段是否见到 result 帧。 */
export function feedStdout(state: StdoutFeedState, chunk: string, onFrame: (frame: CbcFrame) => void): boolean {
  state.buffer += chunk;
  for (;;) {
    const idx = state.buffer.indexOf("\n");
    if (idx === -1) break;
    const line = state.buffer.slice(0, idx);
    state.buffer = state.buffer.slice(idx + 1);
    const frame = parseFrame(line);
    if (!frame) continue;
    if (frame.type === "result") state.sawResult = true;
    try {
      onFrame(frame);
    } catch (e) {
      console.warn("[aiti-codebuddy-agent] onFrame 处理异常（不中断轮次）:", e instanceof Error ? e.message : e);
    }
  }
  return state.sawResult;
}

/** 进程退出时冲刷无尾换行的最后一帧。返回冲刷是否产生 result 帧。 */
export function flushStdoutTail(state: StdoutFeedState, onFrame: (frame: CbcFrame) => void): boolean {
  if (!state.buffer.trim()) {
    state.buffer = "";
    return false;
  }
  const frame = parseFrame(state.buffer);
  state.buffer = "";
  if (!frame) return false;
  if (frame.type === "result") state.sawResult = true;
  try {
    onFrame(frame);
  } catch { /* 同 feedStdout */ }
  return state.sawResult;
}

export function execCbcTurn(opts: {
  cli: ResolvedCli;
  turnArgs: string[];
  cwd: string;
  env: Record<string, string>;
  /** P2 协议委托：成员级启动包装（custom-agent 路径），优先于 extman spawn.* feature。 */
  launchOverride?: LaunchOverride;
  onChild?: (child: ChildProcess) => void;
  onFrame?: (frame: CbcFrame) => void;
}): Promise<CbcTurnOutcome> {
  // npx：node + [npx-cli.js, -y, <spec>, …turnArgs]；direct：bin + […turnArgs]
  // P1' 启动包装（docs/aiti-custom-agent-plan.md）：extman spawn.command/spawn.argsPrefix，缺省 = 行为不变
  // P2：launchOverride（custom-agent 委托路径）优先于 extman feature
  const ov = opts.launchOverride;
  const launch = resolveCliLaunch({
    defaultCommand: opts.cli.cmd,
    command: ov?.command?.trim() || spawnCommand("aiti-codebuddy-agent") || undefined,
    argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-codebuddy-agent")).args,
    driverArgs: [...opts.cli.baseArgs, ...opts.turnArgs],
    env: opts.env,
    memberEnv: ov?.env,
    bridge: ov?.bridge,
    cwd: opts.cwd,
    warn: (m) => console.log(`[aiti-codebuddy-agent] ${m}`),
  });
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
            shell: launch.shell,
cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
    });
    opts.onChild?.(child);
    let stderrTail = "";
    let killed = false;
    const feed = createFeedState();
    // StringDecoder 跨 chunk 安全解码（加固 A1）：逐 chunk toString 会切碎多字节字符
    const stdoutDec = new StringDecoder("utf8");
    const stderrDec = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => {
      feedStdout(feed, typeof chunk === "string" ? chunk : stdoutDec.write(chunk), (frame) => opts.onFrame?.(frame));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrTail = (stderrTail + (typeof chunk === "string" ? chunk : stderrDec.write(chunk))).slice(-STDERR_TAIL_BYTES);
    });
    child.once("error", (err) => reject(new Error(`spawn ${launch.command} 失败: ${err.message}`)));
    child.once("exit", (code, signal) => {
      // 进程退出时缓冲区可能还有最后一行（无换行结尾）——补处理
      flushStdoutTail(feed, (frame) => opts.onFrame?.(frame));
      if (signal) killed = true;
      resolve({ exitCode: code, signal, killed, stderrTail, sawResult: feed.sawResult });
    });
  });
}

// ============================================================================
// 凭据（plan §4.3 路径 A）：dataDir 凭据文件（0600）+ feature override
// ============================================================================

export interface CbcCredentials {
  apiKey?: string;
  authToken?: string;
  baseUrl?: string;
}

export function credPath(configDir: string): string {
  return join(configDir, "codebuddy-credentials.json");
}

export function readCred(configDir: string): CbcCredentials | null {
  try {
    const j = JSON.parse(readFileSync(credPath(configDir), "utf8")) as Record<string, unknown>;
    const out: CbcCredentials = {};
    if (typeof j.apiKey === "string" && j.apiKey) out.apiKey = j.apiKey;
    if (typeof j.authToken === "string" && j.authToken) out.authToken = j.authToken;
    if (typeof j.baseUrl === "string" && j.baseUrl) out.baseUrl = j.baseUrl;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** 写入凭据（0600；patch 字段缺省不动、空字符串清除该字段；全空则删文件）。 */
export function writeCred(configDir: string, patch: CbcCredentials): CbcCredentials | null {
  const cur = readCred(configDir) ?? {};
  const next: CbcCredentials = { ...cur };
  for (const key of ["apiKey", "authToken", "baseUrl"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === "") delete next[key];
    else next[key] = v;
  }
  const p = credPath(configDir);
  try {
    if (!Object.keys(next).length) {
      rmSync(p, { force: true });
      return null;
    }
    if (!existsSync(p)) { try { closeSync(openSync(p, "w", 0o600)); } catch { /* exists race */ } }
    writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch (e) {
    throw new Error(`凭据文件写失败（${p}）: ${e instanceof Error ? e.message : String(e)}`);
  }
  return next;
}

/**
 * 每轮 spawn env（共享机制 _shared/agent-spawn-env.ts）：governance 白名单起底
 * + 自动 AITI_BRIDGE_URL（pi-web 自身实例推导；extra 里的 feature 手动配置优先）
 * + extman spawn.env 用户列表（KEY=VALUE / -NAME 排除 / $VAR 引用，最高优先）。
 * 凭据优先级：feature/env override（调用方合并进 cred）> configDir 凭据文件。
 * iam.md 优先级（CLI 侧）：CODEBUDDY_AUTH_TOKEN > apiKeyHelper > CODEBUDDY_API_KEY。
 */
export function buildTurnEnv(cred: CbcCredentials | null, extra?: Record<string, string>): Record<string, string> {
  return agentSpawnEnv({
    cli: "codebuddy",
    governance: governanceEnv,
    extId: "aiti-codebuddy-agent",
    envList: spawnEnvList("aiti-codebuddy-agent"),
    extra: {
      ...(cred?.apiKey ? { CODEBUDDY_API_KEY: cred.apiKey } : {}),
      ...(cred?.authToken ? { CODEBUDDY_AUTH_TOKEN: cred.authToken } : {}),
      ...(cred?.baseUrl ? { CODEBUDDY_BASE_URL: cred.baseUrl } : {}),
      ...(extra ?? {}),
    },
  });
}

// ============================================================================
// 模型目录（--help 内置清单，2026-09-10 实测）+ pi 目录合并由 index.ts 做
// ============================================================================

export const CBC_MODELS: Array<{ id: string; label: string }> = [
  { id: "default-model", label: "Default（账号默认档）" },
  { id: "fast-model", label: "Fast（快速档）" },
  { id: "balanced-model", label: "Balanced（均衡档）" },
  { id: "primary-model", label: "Primary（主力档）" },
  { id: "deep-model", label: "Deep（深度档）" },
  { id: "glm-5.3", label: "GLM 5.3" },
  { id: "glm-5.2", label: "GLM 5.2" },
  { id: "kimi-k3", label: "Kimi K3" },
  { id: "kimi-k2.6", label: "Kimi K2.6" },
  { id: "minimax-m3", label: "MiniMax M3" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
];

export const DEFAULT_MODEL = "default-model";

// ============================================================================
// 动态模型目录（D13）：cbc --help 真实清单（共享解析器 cbc-model-catalog.ts），
// CBC_MODELS 降级为解析失败兜底。探测结果内存缓存 + cache 层持久化。
// ============================================================================

let dynModels: Array<{ id: string }> | null = null;

/** 内存动态目录（探测成功后注入；null = 未探测，用 CBC_MODELS 兜底）。 */
export function getCachedCbcModels(): Array<{ id: string }> | null {
  return dynModels;
}

export function setCachedCbcModels(models: Array<{ id: string }>): void {
  dynModels = models;
}

/** cache 层持久化文件（<cacheDir>/cbc-model-catalog.json；可再生，rm -rf 自愈）。 */
export function cbcCatalogCacheFile(cacheDir: string): string {
  return join(cacheDir, "cbc-model-catalog.json");
}

export function loadCachedCbcModels(cacheDir: string): Array<{ id: string }> | null {
  try {
    const j = JSON.parse(readFileSync(cbcCatalogCacheFile(cacheDir), "utf8")) as { models?: unknown };
    if (Array.isArray(j.models) && j.models.length
      && j.models.every((m) => m && typeof (m as { id?: unknown }).id === "string")) {
      return j.models as Array<{ id: string }>;
    }
  } catch { /* 缺失/坏 JSON → null */ }
  return null;
}

export function saveCachedCbcModels(cacheDir: string, models: Array<{ id: string }>, cliVersion: string | null): void {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cbcCatalogCacheFile(cacheDir), JSON.stringify({ models, ...(cliVersion ? { cliVersion } : {}), fetchedAt: Date.now() }));
  } catch { /* 不可写 → 内存态照常 */ }
}

/** 启动后台刷新：CLI 探测 → 内存 + cache 层落盘（失败静默，保留兜底）。 */
export async function refreshCbcModelCatalog(cacheDir: string, cli: ResolvedCli): Promise<Array<{ id: string }> | null> {
  const { probeCbcCatalog } = await import("@aiti-ai/ext-shared/cbc-model-catalog");
  const probe = await probeCbcCatalog({ cmd: cli.cmd, baseArgs: cli.baseArgs }, { timeoutMs: 60_000 });
  if (!probe.models.length) return null;
  setCachedCbcModels(probe.models);
  saveCachedCbcModels(cacheDir, probe.models, probe.cliVersion);
  return probe.models;
}

/** 权限模式合法档（--permission-mode choices，2026-09-10 --help 实测）。 */
export const CBC_PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const;

/** 结果帧上下文窗口（modelUsage 首档 contextWindow，如 default-model=176000）；未知返回 null。 */
export function contextWindowFromUsage(usage: TurnUsage | null): number | null {
  return usage?.contextWindow ?? null;
}

// ============================================================================
// 登录 PTY 驱动（plan §9.3 · §9.5 步 4；aiti-cmd M1 services.runner 的首个消费者）
//
// 进程所有权在服务端：扩展经 ctx.services.get("aiti-cmd.runner") 在后台建 cbc 交互
// TUI 会话（sid 共享给 aiti-cmd 前端 xterm 渲染），程序化喂 "/login"，站点选择等人工
// 介入由用户在共享终端直接键入（或 /login/tui/input 转发）。授权 URL 从输出流抓取；
// 登录完成以 ~/.codebuddy 落盘指纹变化判定（settings.json + local_storage/ mtime，
// 2026-09-10 真机登录时刻实测）。不实现 OAuth 协议、不碰凭据内容（受控登录标准哲学）。
// ============================================================================

/** PTY 输出 → 纯文本（剥 ANSI CSI/OSC 转义与控制字符，URL/指纹/尾栏提取用）。
 *  OSC8 超链接（\x1b]8;;URL\x07文本\x1b]8;;\x07）先还原出 URL 文本再清其余转义——
 *  否则 TUI 以超链接形态打印授权 URL 时会被整段剥掉。 */
export function stripAnsi(text: string): string {
  return text
    // OSC8 超链接 → 还原 URL 文本（保留 href 供 URL 提取）
    .replace(/\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, "$1")
    // 其余 OSC（含 BEL 与 ST 两种终止）
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI（含私有模式与中间字节）
    .replace(/\x1b\[[0-9:;?<=>!]*[ -/]*[@-~]/g, "")
    // 其余单字符转义（\x1b 后单字节）
    .replace(/\x1b[@-Z\\-_]/g, "")
    // 裸控制字符（保留 \n；\r 一并去除——PTY 的 \r\n 归一为 \n）
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/g, "");
}

/** 从 TUI 输出抓授权 URL（含 sso/oauth/authorize/login/signin 提示词的 https 链接；先到先得）。 */
export function extractCbcLoginUrl(text: string): string | null {
  const re = /https?:\/\/[^\s"'<>\\)\]}]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const url = m[0].replace(/[.,;]+$/, "");
    if (/oauth|authorize|sso|login|signin|auth/i.test(url)) return url;
  }
  return null;
}

// ============================================================================
// CLI 侧登录态探测（2026-09-13）：cbc 浏览器 OAuth 的凭据不落在 ~/.codebuddy，
// 而在 <数据目录>/CodeBuddyExtension/Data/Public/auth/*.info（实测本机
// ~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info，
// 0600，结构 {account:{uid,nickname,uin,…}, auth:{accessToken,expiresAt,refreshExpiresAt,…}}）。
// 只读展示字段（nickname/uin/过期时间），**绝不返回任何 token**（受控登录标准哲学）。
// ============================================================================

/** 相对数据根的路径段（auth provider id 因站点而异 → 目录内 *.info 全扫）。 */
export const CBC_CLI_AUTH_REL = ["CodeBuddyExtension", "Data", "Public", "auth"];

export interface CliAuthInfo {
  user?: string;
  uin?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  /** refreshExpiresAt（缺省 expiresAt）已过 = 彻底过期（access 过期但可刷新不算） */
  expired: boolean;
  file: string;
}

/** 数据根候选（XDG / Windows LOCALAPPDATA|APPDATA）。 */
export function codebuddyDataRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === "win32") {
    return [env.LOCALAPPDATA, env.APPDATA].filter((v): v is string => Boolean(v));
  }
  return [env.XDG_DATA_HOME || join(homedir(), ".local", "share")];
}

export interface CliAuthFs {
  existsSync(path: string): boolean;
  readdirSync(path: string): string[];
  readFileSync(path: string): string;
}

/** 单个 *.info 文件 → 展示态（无 account/无 token = 未登录 → null）。 */
export function parseCliAuthFile(raw: string, file: string, now = Date.now()): CliAuthInfo | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  const auth = (j.auth ?? null) as Record<string, unknown> | null;
  const hasToken = typeof auth?.accessToken === "string" && Boolean(auth.accessToken);
  const hasRefresh = typeof auth?.refreshToken === "string" && Boolean(auth.refreshToken);
  if (!hasToken && !hasRefresh) return null;
  const account = (j.account ?? null) as Record<string, unknown> | null;
  const out: CliAuthInfo = { expired: false, file };
  const user = account && typeof account.nickname === "string" && account.nickname ? account.nickname
    : account && typeof account.uin === "string" && account.uin ? account.uin : undefined;
  if (user) out.user = user;
  if (account && typeof account.uin === "string" && account.uin) out.uin = account.uin;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const expiresAt = num(auth?.expiresAt);
  const refreshExpiresAt = num(auth?.refreshExpiresAt);
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  if (refreshExpiresAt !== undefined) out.refreshExpiresAt = refreshExpiresAt;
  const deadline = refreshExpiresAt ?? expiresAt;
  out.expired = deadline !== undefined && deadline < now;
  return out;
}

/** 扫数据根下 auth 目录的 *.info（字典序首个有效即返回）；全无 = null（CLI 未登录）。 */
export function readCliAuth(fsIn?: CliAuthFs, now = Date.now()): CliAuthInfo | null {
  const fs: CliAuthFs = fsIn ?? {
    existsSync,
    readdirSync: (p: string) => readdirSync(p) as string[],
    readFileSync: (p: string) => readFileSync(p, "utf8"),
  };
  for (const root of codebuddyDataRoots()) {
    const dir = join(root, ...CBC_CLI_AUTH_REL);
    if (!fs.existsSync(dir)) continue;
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".info")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(dir, f);
      try {
        const hit = parseCliAuthFile(fs.readFileSync(p), p, now);
        if (hit) return hit;
      } catch { /* 坏文件 → 下一个 */ }
    }
  }
  return null;
}

/** cbc 家目录（~/.codebuddy；AITI_CODEBUDDY_HOME 测试隔离口，与 session-manager adapter 一致）。 */
export function codebuddyHome(): string {
  return process.env.AITI_CODEBUDDY_HOME || join(homedir(), ".codebuddy");
}

/**
 * 登录落盘指纹（判定「登录完成」）：~/.codebuddy 下认证相关产物的 mtime 签名。
 * 实测（2026-09-10 真机登录 23:56-23:57）：settings.json 与 local_storage/ 在登录窗口被写。
 * 返回 null = ~/.codebuddy 不存在（从未跑过 cbc）。
 */
export function loginFingerprint(now = Date.now()): string | null {
  const home = codebuddyHome();
  if (!existsSync(home)) return null;
  void now;
  const parts: string[] = [];
  const statMtime = (p: string): string => {
    try {
      const st = statSync(p);
      return `${Math.round(st.mtimeMs)}`;
    } catch { return "-"; }
  };
  parts.push(statMtime(join(home, "settings.json")));
  parts.push(statMtime(join(home, "local_storage")));
  try {
    for (const f of readdirSync(join(home, "local_storage")).slice(0, 50).sort()) parts.push(f + ":" + statMtime(join(home, "local_storage", f)));
  } catch { /* 无 local_storage */ }
  return parts.join("|");
}

/** 登录 PTY 的命令行（bash -c 执行；npx 通道 = node + npx-cli.js，免 systemd PATH 坑）。 */
export function buildLoginCommand(cli: ResolvedCli): string {
  if (cli.kind === "direct") return cli.cmd;
  return [cli.cmd, ...cli.baseArgs].map((s) => (/[\s"'$`\\*?]/.test(s) ? JSON.stringify(s) : s)).join(" ");
}

// ============================================================================
// 账号额度（credits）——官方 usercenter billing 接口（2026-09-13 实测）：
//   POST https://<auth.domain>/billing/meter/get-user-resource-summary
//   headers: Authorization: Bearer <accessToken> / X-Domain / X-User-Id / X-Client-Platform
// 返回 Packages[]（CycleTotal/Remain/UsedCapacity + CapacityUnit=credits）。
// **仅服务端内部使用**：token 绝不回传客户端。
// ============================================================================

/** CLI auth 内部凭据（仅服务端调官方接口用；不对外返回）。 */
export interface CliAuthCreds {
  accessToken: string;
  uin?: string;
  domain?: string;
}

/** 读当前 CLI auth 的 token/domain/uin（与 readCliAuth 同扫描口径；无 = null）。 */
export function readCliAuthCredentials(fsIn?: CliAuthFs): CliAuthCreds | null {
  const fs: CliAuthFs = fsIn ?? {
    existsSync,
    readdirSync: (p: string) => readdirSync(p) as string[],
    readFileSync: (p: string) => readFileSync(p, "utf8"),
  };
  for (const root of codebuddyDataRoots()) {
    const dir = join(root, ...CBC_CLI_AUTH_REL);
    if (!fs.existsSync(dir)) continue;
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".info")).sort(); } catch { continue; }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(join(dir, f))) as { auth?: { accessToken?: unknown; domain?: unknown }; account?: { uin?: unknown } };
        const accessToken = typeof j.auth?.accessToken === "string" ? j.auth.accessToken : "";
        if (!accessToken) continue;
        return {
          accessToken,
          ...(typeof j.account?.uin === "string" && j.account.uin ? { uin: j.account.uin } : {}),
          ...(typeof j.auth?.domain === "string" && j.auth.domain ? { domain: j.auth.domain } : {}),
        };
      } catch { /* 坏文件 → 下一个 */ }
    }
  }
  return null;
}

/** 额度包（归一化展示；金额为 credits）。 */
export interface CbcQuotaPackage {
  code?: string;
  total: number;
  remaining: number;
  used: number;
  unit: string;
}

/** 账号额度总览（归一化）。 */
export interface CbcQuota {
  unit: string;
  total: number;
  remaining: number;
  used: number;
  paid: boolean;
  packages: CbcQuotaPackage[];
  fetchedAt: number;
}

/** 官方额度查询（fetchImpl 可注入便于测试；超时/非 200/异常 → throw）。 */
export async function fetchCbcQuota(opts: {
  token: string;
  uin?: string;
  domain?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CbcQuota> {
  const domain = (opts.domain || "www.codebuddy.cn").replace(/^https?:\/\//, "");
  const url = `https://${domain}/billing/meter/get-user-resource-summary`;
  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        ...(opts.uin ? { "X-User-Id": encodeURIComponent(opts.uin) } : {}),
        "X-Domain": domain,
        "X-Client-Platform": "usercenter",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`额度接口 HTTP ${res.status}`);
    const j = (await res.json()) as { code?: number; msg?: string; data?: { Packages?: Array<Record<string, unknown>>; IsPaidUser?: unknown } };
    if (j.code !== 0) throw new Error(`额度接口返回 code=${j.code} ${j.msg ?? ""}`.trim());
    const pkgRaw = Array.isArray(j.data?.Packages) ? j.data!.Packages : [];
    const num = (v: unknown): number => {
      const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
      return Number.isFinite(n) ? n : 0;
    };
    const packages: CbcQuotaPackage[] = pkgRaw.map((p) => ({
      ...(typeof p.PackageCode === "string" && p.PackageCode ? { code: p.PackageCode } : {}),
      total: num(p.CycleTotalCapacity),
      remaining: num(p.CycleRemainCapacity),
      used: num(p.CycleUsedCapacity),
      unit: typeof p.CapacityUnit === "string" ? p.CapacityUnit : "credits",
    }));
    const unit = packages[0]?.unit ?? "credits";
    return {
      unit,
      total: packages.reduce((s, p) => s + p.total, 0),
      remaining: packages.reduce((s, p) => s + p.remaining, 0),
      used: packages.reduce((s, p) => s + p.used, 0),
      paid: j.data?.IsPaidUser === true,
      packages,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================================
// 登录前凭据隔离（2026-09-13 用户要求）：`cbc login` 会拿现存 token 去注销/覆盖旧账号——
// 启动登录进程前，把 CLI auth *.info 与托管凭据文件**备份并移走**到
// `<stateDir>/login-backup-<ts>/`，登录完成后新凭据自然生效；旧账号可随时还原
// （agent-manager 账号档亦有 `_auto-before-login` 保险快照，双保险）。
// ============================================================================

export interface IsolatedLogin {
  /** 备份目录（无任何文件被移动时为空串） */
  backupDir: string;
  /** 已移走的文件路径 */
  moved: string[];
}

/**
 * 备份并移走当前登录凭据（CLI auth *.info 全数据根 + 托管凭据文件）。
 * 只搬不删；备份目录 0700，文件保持原权限。
 */
export function isolateCliLogin(opts: { configDir: string; stateDir: string; roots?: string[]; now?: number }): IsolatedLogin {
  const roots = opts.roots ?? codebuddyDataRoots();
  const stamp = new Date(opts.now ?? Date.now()).toISOString().replace(/[:.]/g, "-");
  const backupDir = join(opts.stateDir, `login-backup-${stamp}`);
  const moved: string[] = [];
  let idx = 0;
  for (const root of roots) {
    idx += 1;
    const dir = join(root, ...CBC_CLI_AUTH_REL);
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try { files = (readdirSync(dir) as string[]).filter((f) => f.endsWith(".info")); } catch { continue; }
    for (const f of files) {
      const from = join(dir, f);
      const to = join(backupDir, `root${idx}`, f);
      try {
        mkdirSync(join(to, ".."), { recursive: true, mode: 0o700 });
        renameSync(from, to);
        moved.push(to);
      } catch { /* 单个文件失败不阻断其余 */ }
    }
  }
  const cred = credPath(opts.configDir);
  if (existsSync(cred)) {
    const to = join(backupDir, "managed-credentials.json");
    try {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      renameSync(cred, to);
      moved.push(to);
    } catch { /* skip */ }
  }
  if (moved.length) {
    try { chmodSync(backupDir, 0o700); } catch { /* 非 POSIX 容错 */ }
  }
  return { backupDir: moved.length ? backupDir : "", moved };
}


