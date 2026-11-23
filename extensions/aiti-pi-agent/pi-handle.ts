/**
 * pi-handle.ts — pi fork 的 SessionHandle 实现（aiti-pi-agent 专一后端）。
 *
 * 拆分自旧 pi-rpc-spawn.ts 的 PCliSpawnHandle（PiForkSpec 参数化同时承载 pi/omp）。
 * 现 pi 与 omp 各自独立 handle：本文件只保留 pi 语义（get_entries / fork / get_commands /
 * 无 ready 握手 / 无 contextUsage·dumpTools / 无 host tools / 无 login）。
 * 线协议载体无关层（RpcChildHost / extension_ui 桥接 / CLI 解析 / spawn env / 治理 env）
 * 来自共享层 fork-rpc/（副本同步自 _shared/pi-fork-rpc，见 scripts/sync-pi-fork-rpc.mjs）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { appendFile, open, stat, truncate } from "node:fs/promises";
import { RpcChildHost, toInteractionRequest, toExtensionUIResponse, UI_METHODS_NEEDING_ANSWER, shutdownChild, RPC_CTRL_TIMEOUT_MS, type ExtensionUIRequest } from "./fork-rpc/wire.ts";
// 远端 pi 协议队列 queueManage 适配（共享层 _shared/pi-fork-rpc/remote-queue.ts，副本随扩展部署——改动须双向同步）
import { createRemotePiQueueSupport } from "./fork-rpc/remote-queue.ts";
import { capabilitiesFor, type PiForkCommands, type PiForkSpec } from "./fork-rpc/spec.ts";
import { resolveForkCli } from "./fork-rpc/cli-resolve.ts";
import { agentSpawnEnv, spawnEnvList, spawnCommand, spawnArgsPrefix, parseArgsLines, resolveCliLaunch } from "@aiti-ai/ext-shared/agent-spawn-env";
import type { LaunchOverride } from "@aiti-ai/ext-shared/agent-spawn-env";
import { governanceEnv } from "./external-governance.ts";

// ============================================================================
// 上下文用量（pi RPC 线协议无 contextUsage 命令字段——从会话文件自行换算，语义对齐
// pi 本地 runtime getContextUsage：tokens = usage.totalTokens || 四项和；跳过
// aborted/error/全零 assistant；压缩边界后无新 usage → tokens/percent null。窗口
// 来自 get_state.data.model.contextWindow，会话文件路径来自 get_state.data.sessionFile。）
// ============================================================================

/** pi 语义 tokens：totalTokens 优先，缺省回退四项和（照抄 pi compaction.calculateContextTokens）。 */
function piContextTokens(usage: Record<string, unknown>): number {
  const t = typeof usage.totalTokens === "number" && usage.totalTokens > 0 ? usage.totalTokens : 0;
  if (t > 0) return t;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return n(usage.input) + n(usage.output) + n(usage.cacheRead) + n(usage.cacheWrite);
}

/**
 * 从 pi 会话 jsonl 行倒序挑最近有效 assistant usage → contextUsage 契约。
 * 返回 null = 先碰到压缩边界（压缩后无新 usage，pi 语义 tokens 未知）；
 * undefined = 窗口内既无有效 assistant 也无压缩边界（文件过新/窗口太小，不编数据）。
 */
export function pickContextUsageFromLines(
  lines: string[],
  contextWindow: number,
): { percent: number | null; contextWindow: number; tokens: number | null } | null | undefined {
  if (!(contextWindow > 0)) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (e.type === "compaction") return { tokens: null, percent: null, contextWindow };
    if (e.type !== "message") continue;
    const m = (e.message ?? {}) as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    const stop = m.stopReason;
    if (stop === "aborted" || stop === "error") continue;
    const usage = m.usage as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== "object") continue;
    const tokens = piContextTokens(usage);
    if (!(tokens > 0)) continue;
    return { percent: Math.min(100, (tokens / contextWindow) * 100), contextWindow, tokens };
  }
  return undefined;
}

/** 异步读文件尾部（≤1MB，整行对齐——首行可能残缺丢弃），供倒序扫描。 */
export async function readSessionTailLines(filePath: string, maxBytes = 1_000_000): Promise<string[]> {
  try {
    const fh = await open(filePath, "r");
    try {
      const size = (await fh.stat()).size;
      const start = Math.max(0, size - maxBytes);
      const len = size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      let text = buf.toString("utf8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl === -1) return []; // 窗口内无完整行
        text = text.slice(nl + 1);
      }
      return text.split("\n");
    } finally {
      await fh.close();
    }
  } catch {
    return []; // 文件不存在/不可读（尚未落盘等）——静默，不编数据
  }
}

const PI_SESSION_TAIL_BYTES = 1_000_000;

/**
 * Custom-entry type of the in-place branch anchor navigateTree() appends. `custom`
 * entries never reach the LLM context (pi's sessionEntryToContextMessages skips them)
 * and pi-web's transcript reader drops them too — the anchor is invisible.
 */
export const BRANCH_POINT_ENTRY_TYPE = "pi-web:branch-point";

/**
 * Append one JSONL entry to a session file on disk.
 *
 * pi writes with append semantics and restores the leaf as the file's last entry, so an
 * external append is a valid new tail. A file left without a trailing newline (crash,
 * hand edit) gets one first, otherwise the new entry would merge into the previous line.
 */
export async function appendSessionEntry(filePath: string, entry: Record<string, unknown>): Promise<void> {
  let needsNewline = false;
  try {
    const size = (await stat(filePath)).size;
    if (size > 0) {
      const fh = await open(filePath, "r");
      try {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, size - 1);
        needsNewline = buf[0] !== 0x0a;
      } finally {
        await fh.close();
      }
    }
  } catch {
    // Missing file: appendFile creates it (pi always writes the header first).
  }
  await appendFile(filePath, `${needsNewline ? "\n" : ""}${JSON.stringify(entry)}\n`);
}

const PI_COMMANDS: PiForkCommands = {
  fork: "fork",
  getForkMessages: "get_fork_messages",
  getCommands: "get_commands",
  hasGetEntries: true,
  hasReadyFrame: false,
  hasContextUsage: false,
  hasDumpTools: false,
  hasHostTools: false,
  hasLogin: false,
  hasSubagents: false, // pi RPC 无 subagent 面（A09）
};

/** pi fork 声明（唯一成员）。 */
export const PI_SPEC: PiForkSpec = {
  id: "pi",
  label: "New pi subprocess (--mode rpc)",
  order: 20,
  agentKey: "pi",
  runtime: "node",
  pathBin: "pi",
  cliEnvVar: "PI_WEB_PI_CLI",
  bundledCli() {
    const pkgDir = process.env.PI_WEB_PKG_DIR;
    if (pkgDir) {
      const rel = join("@earendil-works", "pi-coding-agent", "dist", "cli.js");
      // Source-repo layout: pkgDir is the repo root, deps hoisted at <root>/node_modules.
      // npm install layout: pkgDir is <root>/node_modules/@aiti-ai/pi-web, so the hoisted
      // dep lives two levels up (also covers npm -g / npx cache roots).
      const candidates = [
        join(pkgDir, "node_modules", rel),
        join(pkgDir, "..", "..", rel),
      ];
      for (const bundled of candidates) {
        if (existsSync(bundled)) return bundled;
      }
    }
    return undefined;
  },
  commands: PI_COMMANDS,
};

/**
 * Host-injected process strategy (pi-web core `agent-starter`). Older pi-web
 * builds do not pass it — the extension then falls back to a plain spawn, which
 * is the historical behavior. When the host injects the detachable variant the
 * agent process outlives pi-web and a reattach adopts it (see `attach`).
 */
export interface AgentStarterLike {
  readonly kind: "direct" | "wrapper";
  spawn(
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      shell?: boolean | string;
      agentKey?: string;
      sessionId?: string;
    },
  ): Promise<ChildProcess>;
}

/** Adopt an already-live agent process (core recovery after a pi-web restart). */
export interface AttachedChildOptions {
  child: ChildProcess;
  sessionId: string;
  agentKey?: string;
  /** True workspace of the adopted process (core passes the wrapper registry entry's cwd); falls back to the host process cwd. */
  cwd?: string;
}

interface PendingUI {
  id: string;
  requestId: string;
  method: string;
}

/** pendingUI 封顶：超过即自动取消最老一条（防子进程刷 UI 请求撑爆内存）。 */
const MAX_PENDING_UI = 32;

/** pi fork 会话 handle。 */
export class PiSpawnHandle extends RpcChildHost {
  readonly source: string;
  readonly capabilities: Record<string, boolean>;
  /** Current record id — mutable: a fork rebinds the subprocess to a branched child session (new id). */
  id: string;
  readonly spec: PiForkSpec;
  readonly cwd: string;

  private running = false;
  private model: { id: string; provider: string } | undefined;
  /** 上下文用量缓存（refreshContextUsage 异步预热；getContextUsage 同步读） */
  private lastContextUsage: { percent: number | null; contextWindow: number; tokens: number | null } | undefined;
  private ctxSessionFile: string | undefined;
  private ctxWindow: number | undefined;
  private ctxRefreshing = false;
  private pendingUI = new Map<string, ExtensionUIRequest>();
  private syntheticUI = new Map<string, (answer: { action: "accept" | "decline"; answers?: Record<string, string | string[]>; message?: string }) => void>();
  private syntheticSeq = 0;
  private deathReason: string | undefined;
  /** Settles when an in-flight navigateTree() finished (prompt() waits on it, see below). */
  private navBarrier: Promise<void> | null = null;
  readonly whenReady: Promise<void>;
  /** 远端队列镜像 + queueManage（remote-queue 共享层；镜像由 onFrame 喂 queue_update 帧）。 */
  private readonly rq = createRemotePiQueueSupport({
    clearRemote: async () => {
      const d = (await this.request({ type: "clear_queue" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { steering?: string[]; followUp?: string[] };
      return { steering: d.steering ?? [], followUp: d.followUp ?? [] };
    },
    reinject: async (text, kind) => {
      await this.request({ type: kind === "steer" ? "steer" : "follow_up", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    },
  });

  constructor(spec: PiForkSpec, id: string, child: ChildProcess, cwd = "") {
    super(child);
    this.spec = spec;
    this.source = "aiti-pi-agent/spawn";
    this.capabilities = capabilitiesFor(spec);
    // Context usage: the RPC wire protocol has no such command field (only omp reports
    // hasContextUsage), but this handle implements getContextUsage() from get_state
    // (sessionFile/model.contextWindow) + the session file. The presence-based host
    // adapter projects by method existence, so the capability is truthfully true.
    this.capabilities = { ...this.capabilities, contextUsage: true, forkRebindHandoff: true };
    // navigateTree: the RPC wire protocol has no such command (capabilitiesFor keeps the
    // probe result false), but this handle implements pi's in-place tree move with a
    // branch-point custom entry + switch_session reopening the same file. Without this
    // declaration "edit from here" degrades to an RPC fork (new file + extra sidebar row).
    this.capabilities = { ...this.capabilities, navigateTree: true };
    // forkFileBranch: the branch button's fork is a host-side file copy (same machinery as
    // the sidebar's Fork); it never sends RPC fork to this process. RPC fork moves the
    // subprocess to a new session file while the agent-starter record (key/socket/systemd
    // unit) still carries the SOURCE id: reopening the source is refused and the copy can
    // be opened by a second agent (double write).
    this.capabilities = { ...this.capabilities, forkFileBranch: true };
    this.id = id;
    this.cwd = cwd;
    this.subscribe((e) => {
      if (e.type === "session_backend_dead") this.deathReason = String(e.reason ?? "unknown");
      // 轮末预热：usage 落盘在 agent_settled 前后，前端 agent_end 后拉 state 前大多已完成
      if (e.type === "agent_settled" || e.type === "agent_end") void this.refreshContextUsage();
    });
    this.whenReady = new Promise<void>((r) => setTimeout(r, 300)); // pi 无 ready 握手帧 → 兜底
    void this.whenReady.then(() => this.refreshContextUsage()); // 恢复场景启动即预热
  }

  static async start(
    opts: {
      sessionId?: string;
      cwd?: string;
      model?: { provider: string; id: string };
      env?: Record<string, string>;
      launchOverride?: LaunchOverride;
      /** Injected by the pi-web core (detachable hosting); absent = plain spawn. */
      agentStarter?: AgentStarterLike;
      /** Core recovery: adopt this live process instead of spawning. */
      attached?: AttachedChildOptions;
    },
    spec: PiForkSpec = PI_SPEC,
  ): Promise<PiSpawnHandle> {
    if (opts.attached) return PiSpawnHandle.attach(opts.attached, spec);
    const resolved = resolveForkCli(spec);
    console.log(`[aiti-pi-agent] spawn resolve: origin=${resolved ? resolved.origin : "null"} pkgDir=${process.env.PI_WEB_PKG_DIR ?? "<unset>"}`);
    if (!resolved) {
      throw new Error(`[aiti-pi-agent] ${spec.pathBin} CLI 未找到（PATH 无 ${spec.pathBin}，且无包内 SDK）。`);
    }
    const argv = [...resolved.args, "--mode", "rpc"];
    // 会话 id 统一（2026-09-13）：pi-web 记档 id = pi 进程落盘 id。
    const recordId = opts.sessionId?.trim() || randomUUID();
    argv.push("--session-id", recordId);
    // cc-switch 语义：pi 系 CLI 原生支持 --provider/--model 启动参数
    if (opts.model?.provider) argv.push("--provider", opts.model.provider);
    if (opts.model?.id) argv.push("--model", opts.model.id);

    const ov = opts.launchOverride;
    const launch = resolveCliLaunch({
      defaultCommand: resolved.runner,
      command: ov?.command?.trim() || spawnCommand("aiti-pi-agent") || undefined,
      argsPrefix: ov?.argsPrefix?.length ? ov.argsPrefix : parseArgsLines(spawnArgsPrefix("aiti-pi-agent")).args,
      driverArgs: argv,
      env: agentSpawnEnv({
        cli: spec.pathBin,
        governance: governanceEnv,
        extra: opts.env,
        extId: "aiti-pi-agent",
        envList: spawnEnvList("aiti-pi-agent"),
      }),
      memberEnv: ov?.env,
      bridge: ov?.bridge,
      cwd: opts.cwd || process.cwd(),
      warn: (m) => console.log(`[aiti-pi-agent] ${m}`),
    });
    // Process strategy comes from the host (agent-starter injection). Without it
    // (older pi-web) this is the historical child_process.spawn.
    const child = opts.agentStarter
      ? await opts.agentStarter.spawn(launch.command, launch.args, {
          shell: launch.shell,
          cwd: opts.cwd || process.cwd(),
          env: launch.env as Record<string, string>,
          agentKey: spec.agentKey,
          sessionId: recordId,
        })
      : spawn(launch.command, launch.args, {
          shell: launch.shell,
          cwd: opts.cwd || process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          env: launch.env,
        });
    return PiSpawnHandle.adopt(spec, recordId, child, opts.cwd || process.cwd());
  }

  /**
   * Build a handle over an existing agent process: a just-spawned child, or (after
   * a pi-web restart) the facade of a detached wrapper the core reattached to.
   * Shared by start() and attach() so both paths get identical warm-up.
   */
  static async adopt(
    spec: PiForkSpec,
    recordId: string,
    child: ChildProcess,
    cwd: string,
  ): Promise<PiSpawnHandle> {
    const handle = new PiSpawnHandle(spec, recordId, child, cwd);
    await handle.whenReady;
    if (!handle.alive()) {
      // fail-loud（加固 P1-5）：进程启动即崩时给清晰错误，替代静默死 handle
      throw new Error(`[aiti-pi-agent] pi 进程启动即退出：${handle.deathReason ?? "unknown"}`);
    }
    // B3（拆分计划）：pi 消费 --provider/--model 启动参数（实测 get_state.data.model 回显完整
    // 解析模型）——ready 后拉一次 get_state 合成 model 状态，agentRunModelRef 即刻对齐实际
    // 运行模型，不必等 pi 主动发 model_select（setModel 切换仍走既有事件链）。
    void (async () => {
      try {
        // request() 已解包返回 frame.data（wire.ts p.resolve(msg.data)）——此前写成 d.data.model
        // 多剥一层导致启动模型回显从未命中（2026-09-19 顺带修复，随 contextUsage 预热同路径实测）。
        const d = (await handle.request({ type: "get_state" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as {
          model?: { id?: unknown; provider?: unknown };
        };
        const m = d?.model;
        if (m && typeof m.id === "string" && m.id && !handle.getModel()) {
          handle.adoptStartModel({ id: m.id, provider: typeof m.provider === "string" && m.provider ? m.provider : "pi" });
        }
      } catch { /* 状态读取失败不影响会话（model 待 pi model_select 事件） */ }
    })();
    return handle;
  }

  /**
   * Recovery path: pi-web restarted while the agent kept running in a detached
   * wrapper (agent-starter). The child is the reattached facade (its journal was
   * replayed before we got here), so building a handle is enough.
   */
  static async attach(opts: AttachedChildOptions, spec: PiForkSpec = PI_SPEC): Promise<PiSpawnHandle> {
    // opts.cwd = the adopted process's true workspace (wrapper registry entry) — never
    // the host's process.cwd(): the handle cwd feeds the UI workspace identity, and a
    // wrong value pins the session to the wrong project (sidebar/files pointed away).
    return PiSpawnHandle.adopt(spec, opts.sessionId, opts.child, opts.cwd || process.cwd());
  }

  /** 覆写：非 response 帧的 pi 语义分发。 */
  protected override onFrame(msg: Record<string, unknown>): void {
    if (msg.type === "extension_ui_request" && typeof msg.id === "string" && typeof msg.method === "string") {
      const req = msg as unknown as ExtensionUIRequest;
      if (UI_METHODS_NEEDING_ANSWER.has(req.method)) {
        if (this.pendingUI.size >= MAX_PENDING_UI && !this.pendingUI.has(req.id)) {
          this.expirePendingUI(this.pendingUI.keys().next().value as string, "overflow");
        }
        this.pendingUI.set(req.id, req);
        this.emit(toInteractionRequest(req));
      } else if (req.method === "open_url") {
        this.emit(toInteractionRequest(req));
      }
      return;
    }
    if (msg.type === "agent_start" || msg.type === "turn_start") this.running = true;
    if (msg.type === "agent_settled" || msg.type === "agent_end") this.running = false;
    if (msg.type === "model_select" && msg.model) {
      this.model = msg.model as { id: string; provider: string };
    }
    // pi appends the run's user entry right after this message_end but announces the
    // entry id to no one (#1746): the chat's New-session/Share on that message need
    // the id before the run's end reads the file. Local rpc sessions get this from
    // rpc-manager's announceUserMessageEntry; the subprocess path mirrors it here by
    // asking the child for its entries and matching the just-appended user tail.
    if (msg.type === "message_end" && (msg as { message?: { role?: unknown } }).message?.role === "user") {
      void this.announceUserMessageEntry((msg as { message?: { timestamp?: unknown } }).message);
    }
    this.rq.observeFrame(msg); // queue_update 帧 → 镜像（原帧照常 emit 给前端）
    this.emit(msg);
  }

  /** Ask the child for its entries and emit `user_message_entry` for the one this
   *  message_end just delivered (matched by timestamp — the IPC boundary strips
   *  object identity, which is what the local path matches on). Failures are
   *  silent: the run's end read still fills the id, this only speeds it up. */
  private announceUserMessageEntryBusy = false;
  private async announceUserMessageEntry(message: { timestamp?: unknown } | undefined): Promise<void> {
    if (!message || this.announceUserMessageEntryBusy) return;
    this.announceUserMessageEntryBusy = true;
    try {
      const res = await this.request<{ entries?: Array<{ type?: unknown; id?: unknown; message?: { role?: unknown; timestamp?: unknown } }> }>(
        { type: "get_entries" },
        { timeoutMs: RPC_CTRL_TIMEOUT_MS },
      );
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type !== "message") continue;
        const entryMessage = entry.message;
        if (entryMessage?.role !== "user") return; // the tail moved past this prompt: never guess
        if (entryMessage.timestamp !== message.timestamp) return;
        if (typeof entry.id === "string") {
          this.emit({ type: "user_message_entry", entryId: entry.id, timestamp: entryMessage.timestamp });
        }
        return;
      }
    } catch {
      // child busy or dying: the run's end read still fills the id
    } finally {
      this.announceUserMessageEntryBusy = false;
    }
  }

  async prompt(
    text: string,
    options?: { images?: unknown[]; streamingBehavior?: string },
  ): Promise<void | { queued: true }> {
    // A send racing an in-place branch move must land on the branch it moved to: the
    // move's own RPC round trips leave the child's stdin free, so a prompt written
    // meanwhile would be processed BEFORE `switch_session` and grow the old branch
    // (branch navigation fires the move without awaiting it).
    if (this.navBarrier) await this.navBarrier;
    const frame: Record<string, unknown> = {
      type: "prompt",
      message: text,
      ...(options?.images ? { images: options.images } : {}),
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
    };
    let res: { disposition?: string } | undefined;
    try {
      res = await this.request<{ disposition?: string }>(frame);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A plain prompt (no explicit streamingBehavior) means the caller believed the
      // child idle; when host state lags the subprocess truth the child rejects it
      // mid-run with "Agent is already processing. Specify streamingBehavior...".
      // Re-queue as followUp: the message and the current run are both preserved,
      // pi drains it at settle (the child was streaming, so the queue will be
      // consumed), and the enqueue emits a queue_update row the user can recall.
      // Callers that chose a behavior explicitly still get their error verbatim.
      if (options?.streamingBehavior || !msg.includes("Specify streamingBehavior")) throw err;
      console.log(`[aiti-pi-agent] plain prompt raced a running child; re-queued as followUp`);
      res = await this.request<{ disposition?: string }>({ ...frame, streamingBehavior: "followUp" });
    }
    // pi answers { disposition }: "queued" means the message waits in the child's
    // queue instead of starting a turn (a retry can also report "started" — the run
    // settled before it landed). Report it, or the caller keeps treating a queued
    // message as a sent one and shows the same text twice: its optimistic bubble
    // plus the queue row pi just created.
    return res?.disposition === "queued" ? { queued: true } : undefined;
  }

  async abort(): Promise<void> {
    await this.request({ type: "abort" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  /**
   * Release this handle. A plain child is killed (historical behavior); a
   * wrapper-hosted child is DETACHED — the agent keeps running so it can be
   * reattached after a pi-web restart / extension reload. Killing such a session
   * is the core's decision (starter.kill) and arrives as an exit frame.
   */
  async dispose(): Promise<void> {
    if (!this.aliveFlag) return;
    const facade = this.child as unknown as { detachable?: unknown; release?: () => void };
    if (facade.detachable === true && typeof facade.release === "function") {
      facade.release();
      this.markDead("detached");
      return;
    }
    await shutdownChild(this.child, 1000);
    this.markDead("disposed");
  }

  alive(): boolean {
    // A wrapper facade whose socket closed can stay exitCode === null for a while (no "exit"
    // event yet) while its stdin is no longer writable: `request()` rejects it as "not running",
    // but an alive() that ignores stdin kept such a dead handle in the store — reads then
    // returned empty transcripts and prompts silently never ran (2026-11-23). Cannot drive it
    // = not alive.
    return this.aliveFlag && this.child.exitCode === null && this.child.stdin?.writable !== false;
  }

  isRunning(): boolean {
    return this.running;
  }

  getModel(): { id: string; provider: string } | undefined {
    return this.model;
  }

  /** B3：启动模型合成入口——仅当事件链尚未记到 model 时由 start() 的 get_state 回显调用。 */
  adoptStartModel(model: { id: string; provider: string }): void {
    if (!this.model) this.model = model;
  }

  /**
   * RPC get_state → 缓存 sessionFile + model.contextWindow → 异步读会话文件尾，
   * 倒序挑最近有效 assistant usage（pi 本地语义，含压缩边界）。fire-and-forget：
   * 事件驱动（构造/轮末）+ getContextUsage 每次调用兜底触发，同步读只碰缓存。
   */
  private async refreshContextUsage(): Promise<void> {
    if (this.ctxRefreshing || !this.alive()) return;
    this.ctxRefreshing = true;
    try {
      const d = (await this.request({ type: "get_state" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as {
        sessionFile?: unknown;
        model?: { contextWindow?: unknown };
      };
      if (typeof d?.sessionFile === "string" && d.sessionFile) this.ctxSessionFile = d.sessionFile;
      const w = d?.model?.contextWindow;
      if (typeof w === "number" && w > 0) this.ctxWindow = w;
      if (!this.ctxSessionFile || !this.ctxWindow) return;
      const lines = await readSessionTailLines(this.ctxSessionFile, PI_SESSION_TAIL_BYTES);
      this.lastContextUsage = pickContextUsageFromLines(lines, this.ctxWindow) ?? undefined;
    } catch {
      // 进程死亡/RPC 失败：缓存保持旧值，下次轮末再试（不抛——get_state 命令路径不能被它带崩）
    } finally {
      this.ctxRefreshing = false;
    }
  }

  /**
   * @capability contextUsage —— 同步读缓存（refreshContextUsage 异步预热：启动/轮末/
   * 本方法调用时 fire-and-forget 触发）。缓存未热返回 undefined（前端「暂无数据」）。
   */
  getContextUsage(): { percent: number | null; contextWindow: number; tokens: number | null } | undefined {
    void this.refreshContextUsage(); // 兜底预热（幂等：ctxRefreshing 防重入）
    return this.lastContextUsage;
  }

  async steer(text: string): Promise<void> {
    await this.request({ type: "steer", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  async followUp(text: string): Promise<void> {
    await this.request({ type: "follow_up", message: text }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  /**
   * @capability queueManage —— 远端队列 keeper 全 CRUD（remote-queue 共享层：list=镜像；
   * clear=协议原生 clear_queue 返回清空前文本；move/remove/recall/requeue/convert=clear+重注入）。
   */
  queueManage = (req: {
    action: "list" | "clear" | "move" | "convert" | "remove" | "recall" | "requeue";
    kind?: "steer" | "followUp";
    from?: number;
    to?: number;
    index?: number;
    targetKind?: "steer" | "followUp";
    text?: string;
  }) => this.rq.queueManage(req);

  /** pi → get_entries（entries 原样）。 */
  async getMessages(): Promise<unknown[]> {
    const d = (await this.request({ type: "get_entries" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { entries?: unknown[] };
    return d.entries ?? [];
  }

  async setModel(model: { id: string; provider: string }): Promise<boolean> {
    await this.request({ type: "set_model", provider: model.provider, modelId: model.id }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    this.model = model;
    return true;
  }

  setThinkingLevel(level: string): void {
    void this.request({ type: "set_thinking_level", level }, { timeoutMs: RPC_CTRL_TIMEOUT_MS }).catch(() => {});
  }

  /**
   * fork — shared by the message "branch" button and "edit from here".
   *
   * pi's fork(position:"before") only accepts a USER message entry: forking at M drops M
   * and everything after, and the branched child keeps the prefix before it (M.parentId
   * empty = first message → fresh empty session linked via parentSession). Input shapes:
   *  - reset (edit-from-here): entryId is the zcode-shaped branch point (previous
   *    assistant entry, or "" for the first message) — the real fork target rides in
   *    opts.editEntryId (the edited user message, sent by the frontend's
   *    handleEditFromStartSend); pi must use it. Missing editEntryId = legacy client →
   *    pass entryId through and let pi reject it explicitly.
   *  - non-reset (branch button): entryId IS the user message to branch at, use as-is.
   *
   * The UI id may be a real pi entry id (local-file context path) or an "ext-N" position
   * id (handle-projection context path — index into the UI message list); resolveForkTarget
   * maps both onto a real pi entry.
   *
   * pi's RPC fork rebinds the subprocess to the branched child session (new file + new
   * id). On success we read get_state.sessionId, announce session_backend_ready (the host
   * re-keys the detached registry record and double-keys the handle store) and return
   * newSessionFile so the frontend can follow to the child (branch button: opens the
   * child with the draft; a rebind-shaped `fork(reset)` from a backend without navigateTree
   * switches + auto-sends).
   *
   * "Edit from here" does NOT come through here any more: navigateTree() rewinds this same
   * session instead of forking a duplicate (see below). pi-web's branch button does not
   * either: this handle declares forkFileBranch, so the host copies the branch on disk
   * (RPC fork leaves the SOURCE id owned by this wrapper's socket/unit — reopening the
   * source was refused and the copy could get a second agent). Kept for callers that
   * explicitly want pi's own fork semantics.
   */
  async fork(entryId: string, opts?: { reset?: boolean; editEntryId?: string }): Promise<{ cancelled: boolean; newSessionFile?: string }> {
    const requested = opts?.reset && opts.editEntryId ? opts.editEntryId : entryId;
    const target = await this.resolveForkTarget(requested);
    const d = await this.request<{ cancelled?: boolean }>({ type: "fork", entryId: target }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
    if (d?.cancelled) return { cancelled: true };
    const st = await this.request<{ sessionId?: unknown }>({ type: "get_state" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS }).catch(() => null);
    const newId = typeof st?.sessionId === "string" ? st.sessionId : "";
    if (newId && newId !== this.id) {
      const oldId = this.id;
      this.id = newId;
      this.emit({ type: "session_backend_ready", oldId, id: newId });
      return { cancelled: false, newSessionFile: newId };
    }
    return { cancelled: false };
  }

  /**
   * @capability navigateTree — in-place branch inside the hosted session's own file.
   *
   * pi 1.6's RPC has no `navigate_tree`: tree moves only exist in-process, and the one
   * tree write the wire exposes (`fork`) creates a NEW session file. Falling back to it
   * made "edit from here" fork a duplicate session next to the original in the sidebar.
   * pi rebuilds the leaf from the file on load (the last entry is the leaf), so the same
   * in-place branch local sessions get is reachable from here: append a context-invisible
   * `custom` entry as a child of the target, then re-open the file with `switch_session`.
   * The next prompt grows the new branch inside THIS file (same id, same file), and the
   * abandoned tail stays where it was, off the active path — exactly what pi's in-process
   * navigateTree() leaves behind.
   *
   * Target semantics mirror pi's: a user (or custom) message means "rewind to its parent"
   * (its text belongs in the composer), every other entry becomes the leaf itself.
   */
  async navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }> {
    const move = this.moveTree(targetId, options);
    this.navBarrier = move.then(() => {}, () => {});
    try {
      return await move;
    } finally {
      this.navBarrier = null;
    }
  }

  private async moveTree(targetId: string, options?: { summarize?: boolean }): Promise<{ cancelled: boolean }> {
    // A branch summary is a model turn; the wire cannot run one from here. pi also refuses
    // tree moves mid-run (the leaf the running turn appends to would move under it).
    if (options?.summarize) throw new Error("[aiti-pi-agent] navigateTree: branch summaries are not supported over RPC");
    if (this.isRunning()) throw new Error("Wait for the current response to finish before navigating the session tree.");
    const entriesFrame = await this.request<{ entries?: Array<Record<string, unknown>>; leafId?: unknown }>(
      { type: "get_entries" },
      { timeoutMs: RPC_CTRL_TIMEOUT_MS },
    );
    const entries = Array.isArray(entriesFrame?.entries) ? entriesFrame.entries : [];
    const target = entries.find((e) => e && e.id === targetId);
    if (!target) throw new Error(`[aiti-pi-agent] navigateTree: entry "${targetId}" not found`);
    const role = (target.message as { role?: unknown } | undefined)?.role;
    const newLeafId = (target.type === "message" && role === "user") || target.type === "custom_message"
      ? (typeof target.parentId === "string" && target.parentId ? target.parentId : null)
      : targetId;
    // Already there: pi treats it as a no-op too (no marker, no re-open).
    const currentLeaf = typeof entriesFrame?.leafId === "string" && entriesFrame.leafId ? entriesFrame.leafId : null;
    if (newLeafId === currentLeaf) return { cancelled: false };

    const state = await this.request<{ sessionFile?: unknown }>(
      { type: "get_state" },
      { timeoutMs: RPC_CTRL_TIMEOUT_MS },
    );
    const file = typeof state?.sessionFile === "string" && state.sessionFile ? state.sessionFile : this.ctxSessionFile;
    if (!file) throw new Error("[aiti-pi-agent] navigateTree: this session has no file on disk yet");

    // pi's own id shape (8 hex chars, SessionManager.generateId) and must not collide with
    // an entry already in the file: the marker is a first-class entry of this session.
    const taken = new Set(entries.map((e) => String(e.id ?? "")));
    let markerId = "";
    for (let i = 0; i < 100 && !markerId; i++) {
      const id = randomUUID().slice(0, 8);
      if (!taken.has(id)) markerId = id;
    }
    if (!markerId) markerId = randomUUID();
    const marker = {
      type: "custom",
      customType: BRANCH_POINT_ENTRY_TYPE,
      data: { targetId, leafId: newLeafId },
      id: markerId,
      parentId: newLeafId,
      timestamp: new Date().toISOString(),
    };
    const sizeBefore = await stat(file).then((s) => s.size, () => 0);
    await appendSessionEntry(file, marker);
    try {
      const switched = await this.request<{ cancelled?: boolean }>(
        { type: "switch_session", sessionPath: file },
        { timeoutMs: RPC_CTRL_TIMEOUT_MS },
      );
      if (switched?.cancelled) {
        // An extension's session_before_switch said no. Roll the marker back: left in the
        // file it would become the leaf of the next load and silently move the session.
        await truncate(file, sizeBefore).catch(() => {});
        return { cancelled: true };
      }
    } catch (error) {
      await truncate(file, sizeBefore).catch(() => {});
      throw error;
    }
    // The runtime was rebuilt from the file: model/usage now come from the new branch.
    this.ctxSessionFile = file;
    void this.refreshContextUsage();
    void this.request<{ model?: { id?: unknown; provider?: unknown } }>(
      { type: "get_state" },
      { timeoutMs: RPC_CTRL_TIMEOUT_MS },
    ).then((st) => {
      const m = st?.model;
      if (m && typeof m.id === "string" && m.id && typeof m.provider === "string" && m.provider) {
        this.model = { id: m.id, provider: m.provider };
      }
    }).catch(() => { /* the next state read reports it */ });
    return { cancelled: false };
  }

  async setSessionName(name: string): Promise<void> {
    await this.request({ type: "set_session_name", name }, { timeoutMs: RPC_CTRL_TIMEOUT_MS });
  }

  /**
   * Resolve a fork target onto a real pi user-message entry id.
   *
   * Real entry ids (local-file context path) hit the exact-id fast path. "ext-N" position
   * ids (handle-projection context path) index the UI message list — mirror the context
   * route's filter (message entries minus transcript system, plus compaction/
   * branch_summary/custom_message) so the index lines up with what the user clicked.
   * Unresolvable ids throw explicitly — forking the wrong entry would silently rewind
   * the session to the wrong point, so never guess.
   */
  private async resolveForkTarget(id: string): Promise<string> {
    const d = (await this.request({ type: "get_entries" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { entries?: unknown[] };
    const entries = (Array.isArray(d?.entries) ? d.entries : []) as Array<Record<string, unknown>>;
    const exact = entries.find((e) => e && e.id === id);
    if (exact) return String(exact.id);
    const m = /^ext-(\d+)$/.exec(id);
    if (m) {
      const ui = entries.filter((e) => {
        if (!e || typeof e !== "object") return false;
        if (e.type === "message") return (e.message as { role?: unknown } | undefined)?.role !== "system";
        if (e.type === "compaction" || e.type === "custom_message") return true;
        // branch_summary renders only when it carries a summary (entryToUiMessage parity)
        return e.type === "branch_summary" && !!e.summary;
      });
      const hit = ui[Number(m[1])];
      if (hit && (hit.message as { role?: unknown } | undefined)?.role === "user") return String(hit.id);
    }
    throw new Error(`[aiti-pi-agent] fork: cannot resolve entry "${id || "(empty)"}" to a pi user message`);
  }

  /** compact 无超时（压缩是一个完整 agent 轮次，时长不可预估；死亡仍会 reject）。 */
  async compact(customInstructions?: string): Promise<unknown> {
    return this.request({ type: "compact", customInstructions });
  }

  /** bash 无超时（命令时长不可预估；死亡仍会 reject）。 */
  async executeBash(command: string): Promise<{ output: string; exitCode?: number }> {
    return this.request({ type: "bash", command });
  }

  async getCommands(): Promise<Array<{ name: string; description?: string; source: string }>> {
    const d = (await this.request({ type: "get_commands" }, { timeoutMs: RPC_CTRL_TIMEOUT_MS })) as { commands?: Array<Record<string, unknown>> };
    return (d.commands ?? []).map((c) => ({
      name: String(c.name ?? ""),
      ...(typeof c.description === "string" ? { description: c.description } : {}),
      source: String(c.source ?? "unknown"),
    }));
  }

  /** RPC get_available_models → 归一化 HandleModelOption[]（后台异步刷新，轮询至非空/超时；单探 10s 超时）。 */
  async getAvailableModels(): Promise<Array<{ id: string; provider: string; label?: string }>> {
    const deadline = Date.now() + 12_000;
    let models: Array<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      const d = (await this.request({ type: "get_available_models" }, { timeoutMs: 10_000 }).catch(() => null)) as {
        models?: Array<Record<string, unknown>>;
      } | null;
      models = d?.models ?? [];
      if (models.length > 0) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    return models.map((m) => ({
      id: String(m.id ?? ""),
      provider: String(m.provider ?? ""),
      ...(typeof m.name === "string" ? { label: String(m.name) } : {}),
    }));
  }

  /** 取消一条挂起 UI 请求（回发 cancelled 帧 + 过期事件；容量封顶/异常清理共用）。 */
  private expirePendingUI(requestId: string, reason: string): void {
    const req = this.pendingUI.get(requestId);
    if (!req) return;
    this.pendingUI.delete(requestId);
    this.writeRaw({ type: "extension_ui_response", id: req.id, cancelled: true });
    this.emit({ type: "interaction_expired", requestId, reason });
  }

  /** 响应挂起中的 extension_ui 请求（interaction_request 事件 → extension_ui_response 帧）。 */
  async respondInteraction(
    requestId: string,
    answer: { action: "accept" | "decline"; answers?: Record<string, string | string[]>; message?: string },
  ): Promise<boolean> {
    const synthetic = this.syntheticUI.get(requestId);
    if (synthetic) {
      this.syntheticUI.delete(requestId);
      synthetic(answer);
      this.emit({ type: "interaction_expired", requestId, reason: "resolved" });
      return true;
    }
    const req = this.pendingUI.get(requestId);
    if (!req) return false;
    const frame = toExtensionUIResponse(req, answer);
    this.pendingUI.delete(requestId);
    if (!frame) return false;
    this.writeRaw(frame);
    this.emit({ type: "interaction_expired", requestId, reason: "resolved" });
    return true;
  }

  // fail-loud stubs（pi RPC 无这些能力；显式 false，前端降级）
  async getAllTools(): Promise<never> {
    throw new Error(`Capability "listTools" is not supported by session backend "${this.source}"`);
  }
  setActiveTools(): never {
    throw new Error(`Capability "setActiveTools" is not supported by session backend "${this.source}"`);
  }
  deleteSession(): never {
    throw new Error(`Capability "deleteSession" is not supported by session backend "${this.source}"`);
  }
}

// 测试工厂：不经 spawn 直接构造 handle（单测驱动线协议）
export function createHandleForTest(spec: PiForkSpec, id: string, fakeChild: ChildProcess, cwd = ""): PiSpawnHandle {
  return new PiSpawnHandle(spec, id, fakeChild, cwd);
}
