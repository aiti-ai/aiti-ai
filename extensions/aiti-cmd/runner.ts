/**
 * aiti-cmd · 执行引擎 —— node-pty 真 PTY 会话管理 + SSE 流
 *
 * - run()：spawn 真 PTY（node-pty，forkpty/ConPTY），每会话一个 session
 * - input()/resize()/kill()：POST 上行（真 TTY 交互）
 * - 会话持久：session 独立于 SSE 连接，关面板不断；TTL 定期清理
 * - 退出时刷审计：append-only JSONL + 输出落盘（去 ANSI，>1MB 截断）
 */
import { createRequire } from "node:module";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditRecord } from "./audit.js";
import type { CommandStore } from "./store.js";

const require = createRequire(import.meta.url);

// node-pty 原生模块：装于扩展目录 node_modules（jiti 相对 resolve）；加载失败 → 降级标记
let ptyMod: any = null;
try {
  ptyMod = require("node-pty");
  if (!ptyMod || typeof ptyMod.spawn !== "function") ptyMod = null;
} catch (e) {
  console.error("[aiti-cmd] node-pty 加载失败（将降级 script 伪 TTY）:", String((e as Error)?.message || e));
}

// macOS 自愈：npm 源上 node-pty@1.1.0 tarball 的 prebuilds/darwin-*/spawn-helper 权限位是 0644
//（上游发布事故），helper 起不来 → 所有 pty spawn 报 "posix_spawnp failed."。加载时自动 chmod +x
//（扩展目录 / ~/node_modules 等任意解析路径一并覆盖），用户零感知；spawn 错误路径另有二次自愈
// + 一次重试（见 spawnSession）。非 darwin / 解析不到 node-pty 时静默空转。
function healPtyHelper(): void {
  if (process.platform !== "darwin") return;
  try {
    const pkg = require.resolve("node-pty/package.json") as string;
    const prebuilds = path.join(path.dirname(pkg), "prebuilds");
    if (!fs.existsSync(prebuilds)) return;
    for (const d of fs.readdirSync(prebuilds)) {
      if (!d.startsWith("darwin-")) continue;
      const helper = path.join(prebuilds, d, "spawn-helper");
      try {
        if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o100) === 0) {
          fs.chmodSync(helper, 0o755);
          console.warn("[aiti-cmd] 已自动修复 node-pty spawn-helper 执行权限: " + helper);
        }
      } catch { /* 单个失败不阻断 */ }
    }
  } catch { /* 静默：spawn 错误路径还有兜底 */ }
}
if (ptyMod) healPtyHelper();

const RING_MAX_BYTES = 1024 * 1024;   // 环形缓冲（重放）1MB
const ALL_MAX_BYTES = 6 * 1024 * 1024; // 审计全量捕获上限 6MB（超出丢最旧 + 标记）
const SESSION_TTL = 60 * 60 * 1000;   // 会话 TTL 1h
const MAX_CONCURRENT = 4;
const MAX_CMD_LEN = 20000;

// ---------------- 沙箱（bubblewrap 只读文件系统） ----------------
let bwrapCached: string | null | undefined;
function bwrapPath(): string | null {
  if (bwrapCached !== undefined) return bwrapCached;
  bwrapCached = null;
  if (process.platform !== "win32") {
    const p = whichBin("bwrap"); // 纯 fs PATH 探测（零 spawn）
    if (p) bwrapCached = p;
  }
  return bwrapCached;
}
let sandboxRootDir = "";
function sandboxRoot(): string {
  return sandboxRootDir;
}

// ---------------- Windows shell 解析（对齐 pi getShellConfig） ----------------
// 优先级：AITI_CMD_SHELL 显式覆盖 > pi settings.json shellPath（~/.pi/agent/settings.json）
//   > ProgramFiles\Git\bin\bash.exe > where bash.exe 首个匹配。
// System32/Sysnative 的 bash.exe 是 WSL 启动器：Win→WSL 命令行转参易坏引号，与 pi 同款走 `-s` + 命令经 stdin；
// 其余 bash 用 -c；找不到任何 bash 时兜底 ComSpec（cmd.exe /d /s /c）。
interface WinShellPlan {
  prog: string;
  /** 交互式启动参数（终端页签） */
  interactiveArgs: string[];
  /** 一次性命令参数（带命令） */
  cmdArgs: (cmd: string) => string[];
  /** true = 命令经 stdin 喂（spawn 后 write，WSL bash -s） */
  viaStdin: boolean;
}
/** shell 路径 → 执行计划（WSL 启动器特殊处理，其余按 bash -c） */
function winShellPlan(prog: string): WinShellPlan {
  const norm = prog.replace(/\//g, "\\").toLowerCase();
  if (/^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(norm)) {
    return { prog, interactiveArgs: ["-s"], cmdArgs: () => ["-s"], viaStdin: true };
  }
  return { prog, interactiveArgs: [], cmdArgs: (x) => ["-c", x], viaStdin: false };
}
function resolveWinShell(): WinShellPlan {
  const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };
  const custom = process.env.AITI_CMD_SHELL;
  if (custom) {
    const base = (custom.toLowerCase().replace(/\.exe$/, "").split(/[\\/]/).pop()) || "";
    const cmdArgs = base === "powershell" || base === "pwsh"
      ? (c: string) => ["-NoLogo", "-Command", c]
      : base === "cmd"
        ? (c: string) => ["/d", "/s", "/c", c]
        : (c: string) => ["-c", c];
    return { prog: custom, interactiveArgs: [], cmdArgs, viaStdin: false };
  }
  // pi settings.json 的 shellPath（settings-manager.getShellPath 同源）：用户显式指定的 shell 优先
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const settingsPath = home ? path.join(home, ".pi", "agent", "settings.json") : "";
    if (settingsPath && exists(settingsPath)) {
      const shellPath = String((JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { shellPath?: string }).shellPath || "").trim();
      if (shellPath && exists(shellPath)) return winShellPlan(shellPath);
    }
  } catch {}
  const pf: string | undefined = process.env.ProgramFiles;
  const pfx86: string | undefined = process.env["ProgramFiles(x86)"];
  for (const c of [pf ? pf + "\\Git\\bin\\bash.exe" : "", pfx86 ? pfx86 + "\\Git\\bin\\bash.exe" : ""]) {
    if (c && exists(c)) return winShellPlan(c);
  }
  {
    const first = whichBin("bash.exe"); // 纯 fs PATH 探测（零 spawn；含 PATHEXT 解析）
    if (first && exists(first)) return winShellPlan(first);
  }
  const comspec = process.env.ComSpec || "cmd.exe";
  return { prog: comspec, interactiveArgs: [], cmdArgs: (x) => ["/d", "/s", "/c", x], viaStdin: false };
}

// node-pty onExit 的 signal 是原始信号编号（15=SIGTERM）→ 映射为名称
const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 6: "SIGABRT", 8: "SIGFPE", 9: "SIGKILL",
  11: "SIGSEGV", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 17: "SIGCHLD", 18: "SIGCONT", 19: "SIGSTOP",
};
// 名称 → 编号反查（降级 script 路径的 exit signal 是名称字符串；审计 exit=128+n 同 PTY 语义）
const SIGNAL_NUM: Record<string, number> = Object.fromEntries(Object.entries(SIGNAL_NAMES).map(([n, name]) => [name, Number(n)]));
function signalName(n: number | null | undefined): string | null {
  if (n == null || n === 0) return null;
  return SIGNAL_NAMES[n] || "SIG" + n;
}
/** 退出码审计语义：被信号杀时 exit = 128 + 信号号（shell 惯例），exitCode 置 null */
function auditExit(exitCode: number | null, sigNum: number | null | undefined): number | null {
  if (sigNum) return 128 + sigNum;
  return exitCode;
}

export interface RunOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
  source?: AuditRecord["source"];
  /** true = 入口未传 source 被兜底（审计标记用，§3.1 防静默吞成 manual） */
  sourceDefaulted?: boolean;
  piSessionId?: string;
  params?: Record<string, string>;
  danger?: string[];
  confirm?: boolean;
  commandId?: string;
  /** 会话 TTL（默认 1h；终端类会话传大值如 24h） */
  ttlMs?: number;
  /** 沙箱：none（默认）/ bwrap-ro（只读+工作目录可写）/ bwrap-offline（只读+断网）/ bwrap-tmp（临时可写盘） */
  sandbox?: "none" | "bwrap-ro" | "bwrap-offline" | "bwrap-tmp";
}

export interface RunSession {
  id: string;
  pty: any | null;            // node-pty 实例（降级时 null → 用 script 伪 TTY 子进程）
  child?: any;                // 降级：script spawn 的子进程
  cmd: string;
  cwd?: string;
  name?: string;
  source: AuditRecord["source"];
  /** true = 入口未传 source 被兜底（透传到审计记录） */
  sourceDefaulted?: boolean;
  piSessionId?: string;
  startTs: number;
  status: "running" | "exit" | "queued";
  exitCode: number | null;
  signal: string | null;
  /** 原始信号号（审计 exit=128+n 用） */
  sigNum: number | null;
  pid: number | null;
  /** 最近输出的重放缓冲（快照 REST 用）；seq 单调递增，供客户端与实时流去重衔接 */
  ring: { seq: number; data: string }[];
  ringBytes: number;
  /** 输出帧序号（feed 每帧 ++；实时总线帧与快照都携带，客户端 seq 去重） */
  seq: number;
  all: string;                // 审计全量捕获（上限 ALL_MAX_BYTES）
  allBytes: number;
  allDroppedStart: boolean;
  truncated: boolean;
  /** 会话 TTL（默认 1h；终端类更长） */
  ttlMs: number;
  lastSeen: number;
  /** 危险标记（审计用） */
  danger: string[];
  confirm: boolean;
  /** 沙箱模式（审计用）：none / bwrap-ro / bwrap-offline / bwrap-tmp */
  sandbox?: "none" | "bwrap-ro" | "bwrap-offline" | "bwrap-tmp";
}

// 帧主题（aiti-event-bus v0.2 主题订阅）：每个终端一个专属 type（cmd-<sessionId>），
// 列表快照用固定 type。终端大流量帧只进这些主题；订阅方按需声明，SSE 转发层过滤，
// 无关终端的帧不出连接。
const ptyTopic = (id: string) => "cmd-" + id;
const TOPIC_SESSIONS = "cmd-sessions";

export function createRunner(audit: { append: (r: AuditRecord) => void; writeOutput: (id: string, raw: string) => { outBytes: number; outputTruncated: boolean; outputFile: string }; logsDir: string }, store: CommandStore, cacheDir = "", publish?: (type: string, data: Record<string, unknown>) => void) {
  sandboxRootDir = path.join(cacheDir || audit.logsDir, "sandbox");
  const sessions = new Map<string, RunSession>();
  const enc = new TextEncoder();
  // aiti-event-bus 发布（aiti-cmd 自管理是否发送）：缺席/异常静默（总线下线 = 无实时流，
  // 订阅 topics 唯一，无降级通道——2026-09-09 拍板）。
  const pub = (type: string, data: Record<string, unknown>) => { try { publish?.(type, data); } catch {} };
  const publishSessions = () => { try { pub(TOPIC_SESSIONS, { evt: "sessions", sessions: list() }); } catch {} };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

  function genId() { return "s_" + randomBytes(5).toString("hex"); }

  /** 追加输出到会话缓冲（ring 重放 + all 审计捕获），并推给所有 SSE 监听 */
  function feed(s: RunSession, data: string) {
    if (!data) return;
    const seq = ++s.seq;
    // ring
    s.ring.push({ seq, data });
    s.ringBytes += Buffer.byteLength(data, "utf8");
    while (s.ringBytes > RING_MAX_BYTES && s.ring.length > 1) {
      const dropped = s.ring.shift()!;
      s.ringBytes -= Buffer.byteLength(dropped.data, "utf8");
      s.truncated = true;
    }
    // all（审计）
    s.all += data;
    s.allBytes += Buffer.byteLength(data, "utf8");
    if (s.allBytes > ALL_MAX_BYTES) {
      // 丢最旧一半
      const cut = Math.floor(s.all.length / 2);
      s.all = s.all.slice(cut);
      s.allBytes = Buffer.byteLength(s.all, "utf8");
      s.allDroppedStart = true;
    }
    s.lastSeen = Date.now();
    // 总线实时增量（小帧走 event-bus；大回放不走——快照走 REST /sessions/{id}/buffered）
    pub(ptyTopic(s.id), { evt: "data", seq, data });
  }

  /** 会话退出：刷审计 + 通知监听 + 启动队列下一个 */
  function finish(s: RunSession) {
    if (s.status === "exit") return;
    s.status = "exit";
    s.lastSeen = Date.now();
    const durationMs = Date.now() - s.startTs;
    const out = audit.writeOutput(s.id, s.all);
    const rec: AuditRecord = {
      ts: s.startTs,
      id: s.id,
      kind: "exec",
      source: s.source,
      sourceDefaulted: s.sourceDefaulted,
      piSessionId: s.piSessionId,
      cwd: s.cwd,
      cmd: s.cmd,
      danger: s.danger.length ? s.danger : undefined,
      confirm: s.confirm || undefined,
      sandbox: s.sandbox || undefined,
      pid: s.pid || undefined,
      exit: auditExit(s.exitCode, s.sigNum),
      signal: s.signal || undefined,
      durationMs,
      outBytes: out.outBytes,
      outputTruncated: out.outputTruncated || s.allDroppedStart,
      outputFile: out.outputFile,
    };
    audit.append(rec);
    if (s.commandId) { try { store.touchRun(s.commandId); } catch {} }
    pub(ptyTopic(s.id), { evt: "exit", code: s.exitCode, signal: s.signal, durationMs, truncated: out.outputTruncated });
    // 队列：有等待者 → 启动下一个
    const next = queue.shift();
    if (next) spawnSession(next);
    publishSessions();
  }

  /** 排队 FIFO（超过并发上限时进入；finish 后自动启动下一个） */
  const queue: RunSession[] = [];
  const queuePosition = (id: string) => queue.findIndex((q) => q.id === id) + 1;

  /** 真正 spawn（running 时调用；queued 已先行发布） */
  function spawnSession(s: RunSession) {
    s.status = "running";
    s.startTs = Date.now();
    s.lastSeen = Date.now();
    pub(ptyTopic(s.id), { evt: "started", sessionId: s.id, pid: null, cmd: s.cmd, cwd: s.cwd, status: "running" });
    try {
      if (ptyMod) {
        const isWin = process.platform === "win32";
        let prog: string;
        let args: string[];
        let cwd = s.cwd || undefined;
        let stdinCmd: string | null = null; // 非 null = spawn 后经 stdin 喂命令（WSL bash -s）
        if (isWin) {
          const ws = resolveWinShell();
          const bare = s.cmd.trim().toLowerCase();
          if (["$shell", "bash", "sh", "zsh", "fish"].includes(bare)) {
            // 「＋ 新终端」按钮发字面量 $SHELL、终端页签发 bash → 全部映射到解析出的默认 shell 交互启动
            prog = ws.prog;
            args = ws.interactiveArgs;
          } else if (bare === "cmd" || bare === "cmd.exe") {
            prog = process.env.ComSpec || "cmd.exe";
            args = [];
          } else if (bare === "powershell" || bare === "pwsh" || bare === "powershell.exe" || bare === "pwsh.exe") {
            prog = bare.replace(/\.exe$/, "") + ".exe";
            args = [];
          } else {
            prog = ws.prog;
            args = ws.cmdArgs(s.cmd);
            if (ws.viaStdin) stdinCmd = s.cmd;
          }
          if (s.sandbox && s.sandbox !== "none") {
            feed(s, "\r\n[aiti-cmd] Windows 暂不支持 bubblewrap 沙箱，本次按无沙箱执行\r\n");
          }
        } else {
          prog = process.env.SHELL || "/bin/bash";
          args = ["-c", s.cmd];
        }
        if (!isWin && (s.sandbox === "bwrap-ro" || s.sandbox === "bwrap-offline" || s.sandbox === "bwrap-tmp")) {
          // bubblewrap 沙箱：
          //   bwrap-ro      系统只读，仅工作目录真实可写（开发常用）
          //   bwrap-offline 同只读 + 断网（--unshare-net，最高隔离）
          //   bwrap-tmp     全系统临时可写盘（--tmp-overlay /：下层系统镜像 + 上层 tmpfs，退出即丢）
          const bwrap = bwrapPath();
          if (!bwrap) throw new Error("bwrap（bubblewrap）未安装，无法使用沙箱");
          const workdir = cwd || path.join(sandboxRoot(), s.id);
          fs.mkdirSync(workdir, { recursive: true });
          const base = ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
          prog = bwrap;
          if (s.sandbox === "bwrap-tmp") {
            // 一次性环境：系统只读 + /tmp /var/tmp /run /root /$HOME 全 tmpfs（可写但退出即丢）；工作目录只读可见
            args = [...base, "--tmpfs", "/var/tmp", "--tmpfs", "/run", "--tmpfs", "/root", "--tmpfs", process.env.HOME || "/root", "--chdir", cwd || "/tmp", process.env.SHELL || "/bin/bash", "-c", s.cmd];
          } else {
            args = [...base, "--bind", workdir, workdir, "--chdir", workdir];
            if (s.sandbox === "bwrap-offline") args.push("--unshare-net");
            args.push(process.env.SHELL || "/bin/bash", "-c", s.cmd);
          }
          cwd = workdir;
        }
        const startPty = () => {
          const p = ptyMod.spawn(prog, args, {
            name: "xterm-256color",
            cols: 100, rows: 30,
            cwd,
            env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
          });
          s.pty = p;
          s.pid = p.pid || null;
          pub(ptyTopic(s.id), { evt: "pid", pid: s.pid });
          if (stdinCmd) { try { p.write(stdinCmd + "\nexit\n"); } catch {} }
          p.onData((d: string) => feed(s, d));
          p.onExit(({ exitCode, signal }: { exitCode: number; signal: number }) => {
            s.exitCode = exitCode;
            s.signal = signalName(signal);
            s.sigNum = signal || null;
            finish(s);
          });
        };
        try {
          startPty();
        } catch (spawnErr) {
          // helper 权限丢失（如部署后 npm 又重装过 node-pty）→ 自愈后重试一次；再失败走外层报错
          if (process.platform === "darwin" && String((spawnErr as Error)?.message || spawnErr).includes("posix_spawnp failed")) {
            healPtyHelper();
            startPty();
          } else throw spawnErr;
        }
      } else {
        spawnFallback(s.cmd, s.cwd, undefined, s);
      }
    } catch (e) {
      feed(s, "\r\n[aiti-cmd] 启动失败: " + String((e as Error)?.message || e) + "\r\n");
      s.exitCode = 127;
      finish(s);
    }
  }


  /** 降级路径：script -qec 伪 TTY（node-pty 不可用时） */
  function spawnFallback(command: string, cwd: string | undefined, env: Record<string, string> | undefined, s: RunSession) {
    if (process.platform === "win32") {
      // script 降级仅限 Linux/macOS：Windows 上 node-pty 未加载时给出明确报错而非 script ENOENT
      feed(s, "\r\n[aiti-cmd] Windows 需要 node-pty 原生模块（本次未加载成功），无法降级 script 伪 TTY\r\n");
      s.exitCode = 127;
      finish(s);
      return null;
    }
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const args = process.platform === "darwin"
      ? ["-q", "/dev/null", command]
      : ["-qec", command, "/dev/null"];
    const child = spawn("script", args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...(env || {}), TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    s.child = child;
    s.pid = child.pid || null;
    child.stdout.on("data", (d: Buffer) => feed(s, d.toString("utf8")));
    child.on("error", (e: Error) => { feed(s, "\r\n[aiti-cmd] script 启动失败: " + e.message + "\r\n"); s.exitCode = 127; finish(s); });
    child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      s.exitCode = code;
      s.signal = signal ? String(signal) : null;
      // 降级路径同样落 sigNum（审计 exit=128+n 语义与 PTY 模式一致；exitCode 置 null 同 auditExit）
      s.sigNum = signal ? (SIGNAL_NUM[signal] ?? null) : null;
      finish(s);
    });
    return child;
  }

  function run(opts: RunOptions): { ok: boolean; sessionId?: string; queued?: boolean; position?: number; error?: string } {
    const cmd = String(opts.command || "").trim();
    if (!cmd) return { ok: false, error: "命令为空" };
    if (cmd.length > MAX_CMD_LEN) return { ok: false, error: "命令过长" };
    // 惰性清理过期会话
    const now = Date.now();
    for (const [id, x] of sessions) {
      if (x.status === "exit" && now - x.lastSeen > x.ttlMs) {
        try { x.pty?.kill(); } catch {}
        sessions.delete(id);
      }
    }
    const id = genId();
    const s: RunSession = {
      id, pty: null, cmd, cwd: opts.cwd || undefined, name: opts.name,
      source: opts.source || "manual", sourceDefaulted: opts.sourceDefaulted === true || undefined, piSessionId: opts.piSessionId,
      startTs: Date.now(), status: "running", exitCode: null, signal: null, sigNum: null, pid: null,
      ring: [], ringBytes: 0, all: "", allBytes: 0, seq: 0,
      allDroppedStart: false, truncated: false,
      ttlMs: opts.ttlMs || SESSION_TTL, lastSeen: Date.now(),
      danger: opts.danger || [], confirm: opts.confirm === true,
      sandbox: opts.sandbox === "bwrap-ro" || opts.sandbox === "bwrap-offline" || opts.sandbox === "bwrap-tmp" || opts.sandbox === "none" ? opts.sandbox : undefined,
    };
    sessions.set(id, s);
    // 排队：超过并发上限 → FIFO 入队（不拒绝）
    const running = [...sessions.values()].filter((x) => x.status === "running").length;
    if (running >= MAX_CONCURRENT) {
      s.status = "queued";
      queue.push(s);
      pub(ptyTopic(id), { evt: "queued", position: queue.length, maxConcurrent: MAX_CONCURRENT });
      publishSessions();
      return { ok: true, sessionId: id, queued: true, position: queue.length };
    }
    spawnSession(s);
    publishSessions();
    return { ok: true, sessionId: id };
  }

  function input(sessionId: string, data: string) {
    const s = sessions.get(sessionId);
    if (!s) return json({ ok: false, error: "unknown session" }, 404);
    if (s.status !== "running") return json({ ok: false, error: "session 已退出" }, 409);
    try {
      if (s.pty) s.pty.write(data);
      else s.child?.stdin.write(data);
    } catch (e) { return json({ ok: false, error: String((e as Error)?.message || e) }); }
    return json({ ok: true });
  }

  function resize(sessionId: string, cols: number, rows: number) {
    const s = sessions.get(sessionId);
    if (!s) return json({ ok: false, error: "unknown session" }, 404);
    if (s.status !== "running") return json({ ok: false, error: "session 已退出" }, 409);
    const c = Math.max(20, Math.min(500, parseInt(String(cols), 10) || 100));
    const r = Math.max(5, Math.min(200, parseInt(String(rows), 10) || 30));
    try {
      if (s.pty) s.pty.resize(c, r);
    } catch {}
    return json({ ok: true, cols: c, rows: r });
  }

  function kill(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return json({ ok: false, error: "unknown session" }, 404);
    if (s.status === "queued") {
      // 排队中取消：出队 + 记一条未完成审计
      const qi = queue.findIndex((q) => q.id === sessionId);
      if (qi >= 0) queue.splice(qi, 1);
      s.status = "exit";
      s.lastSeen = Date.now();
      audit.append({
        ts: s.startTs, id: s.id, kind: "exec", source: s.source, piSessionId: s.piSessionId,
        cwd: s.cwd, cmd: s.cmd, exit: null, durationMs: Date.now() - s.startTs, outBytes: 0,
      });
      pub(ptyTopic(sessionId), { evt: "exit", code: null, signal: "CANCELLED", durationMs: 0, truncated: false, cancelled: true });
      publishSessions();
      return json({ ok: true, cancelled: true });
    }
    if (s.status !== "running") return json({ ok: false, error: "session 已退出" }, 409);
    try {
      if (s.pty) {
        if (process.platform === "win32") {
          // node-pty Windows：kill(signal) 直接抛 "Signals not supported on windows."；
          // 无参 kill 仅关 ConPTY，对 WSL bash 不保证生效 → taskkill 树杀兜底
          try { s.pty.kill(); } catch {}
          if (s.pid) {
            try {
              // 树杀兜底改异步派发（2026-09-12）：fire-and-forget，不再同步等待 taskkill（≤5s 冻结）
              const { spawn: _spawn } = require("node:child_process") as typeof import("node:child_process");
              _spawn("taskkill", ["/PID", String(s.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
            } catch {}
          }
        } else {
          s.pty.kill("SIGTERM");
          // 3s 后仍未退出 → 杀进程组（npm 孙进程树）
          setTimeout(() => {
            if (sessions.get(sessionId)?.status === "running" && s.pid) {
              try { process.kill(-s.pid, "SIGKILL"); } catch {}
              try { s.pty.kill("SIGKILL"); } catch {}
            }
          }, 3000);
        }
      } else if (s.child) {
        try { s.child.kill("SIGTERM"); } catch {}
      }
    } catch (e) { return json({ ok: false, error: String((e as Error)?.message || e) }); }
    return json({ ok: true, killing: true });
  }

  function list() {
    return [...sessions.values()].map((s) => ({
      id: s.id, cmd: s.cmd, name: s.name, cwd: s.cwd, source: s.source,
      status: s.status, pid: s.pid, startTs: s.startTs,
      exitCode: s.exitCode, signal: s.signal, durationMs: s.status === "exit" ? s.lastSeen - s.startTs : Date.now() - s.startTs,
      ringBytes: s.ringBytes, truncated: s.truncated, sandbox: s.sandbox,
      queuePosition: s.status === "queued" ? queuePosition(s.id) : undefined,
      queueLength: queue.length,
    }));
  }

  function getInfo(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    return { id: s.id, cmd: s.cmd, cwd: s.cwd, status: s.status, exitCode: s.exitCode, ringBytes: s.ringBytes, sandbox: s.sandbox };
  }

  /** shell 实时目录（Linux 读 /proc/<pid>/cwd；macOS 用 lsof；win32 不支持返回 null）。
   *  PTY 会话 s.pid 即交互 shell 进程（bash -c 末命令 exec 后 pid 不变），内建 cd 同步其 cwd——
   *  终端里 cd 过再「＋ 新建」/「新 pi-web 会话」取的就是当前 pwd，与系统终端行为一致。 */
  function liveCwd(sessionId: string): string | null {
    const s = sessions.get(sessionId);
    if (!s || !s.pid || s.status === "exit") return null;
    if (process.platform === "linux") {
      try { return fs.readlinkSync(`/proc/${s.pid}/cwd`); } catch { return null; }
    }
    if (process.platform === "darwin") {
      try {
        const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
        const out = execFileSync("lsof", ["-a", "-p", String(s.pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3000 });
        const m = /^n(\/.+)$/m.exec(out);
        return m ? m[1] : null;
      } catch { return null; }
    }
    return null;
  }

  function diag() {
    return { nodePty: !!ptyMod, sessions: sessions.size, running: [...sessions.values()].filter((x) => x.status === "running").length, queued: queue.length, maxConcurrent: MAX_CONCURRENT, bwrap: bwrapPath(), sandbox: "bwrap-ro" };
  }

  /**
   * 初始快照（REST；终端大消息不走 event-bus，订阅方先订阅后拉这个）。
   * 返回 started meta + ring 全量 + 当前 seq + exit 状态——客户端 reset 后重放、
   * 用 seq 去重后续实时帧，与事件总线增量流无缝衔接（无缝无重复）。
   */
  function buffered(sessionId: string) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id, cmd: s.cmd, cwd: s.cwd, name: s.name, status: s.status,
      pid: s.pid, startTs: s.startTs,
      exitCode: s.exitCode, signal: s.signal,
      durationMs: s.status === "exit" ? s.lastSeen - s.startTs : Date.now() - s.startTs,
      truncated: s.truncated,
      seq: s.seq,
      chunks: s.ring,
    };
  }

  return { run, input, resize, kill, list, getInfo, diag, buffered, liveCwd, sessions };
}

export type Runner = ReturnType<typeof createRunner>;
