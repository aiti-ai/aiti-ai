/**
 * aiti-channels · cc-connect process hosting + status probing + socket API client
 *
 * Lifecycle owned by aiti (start/stop/restart managed here; no always-on unit
 * management UI, but Linux defaults to a systemd-run transient unit — the
 * proc-runner three-kind matrix, see lib/proc-runner.ts). Linux (user manager
 * reachable) = systemd-run user unit `aiti-cc-<id>` (immune to pi-web restarts;
 * stop = systemctl --user stop, cgroup-wide kill with graceful timeout);
 * macOS/containers = plain detached (historical path); Windows =
 * Win32_Process.Create + taskkill tree-kill. The active regime is recorded in
 * <dataDir>/runtime.json; instances started by the old setsid+pid-file path
 * keep working (dual regime in probe) and switch on the next restart. Never
 * fuzzy-pkill. Probe = process alive + management TCP + api.sock HTTP.
 *
 * cc-connect outward channels (2026-08 verified):
 *   - Unix socket API (~/.cc-connect/run/api.sock): POST /send (text/file), GET /sessions
 *   - management API (9820): web UI + /api/v1/*
 *   - bridge WS (9810): live chat
 */
import { spawn } from "node:child_process";
import { execFileAsync } from "@aiti-ai/ext-shared/exec-async"; // 性能红线：ps 探测不阻塞事件循环
import { homedir, platform } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as http from "node:http";
import { readConfigFile } from "./config.ts";
import { managedBin } from "./installer.ts";
import * as proc from "./proc-runner.ts";

export const LIB_VERSION = "0.1.8"; // bump: proc-runner regime (reload swaps the globalThis-cached manager namespace)

const IS_WIN = platform() === "win32";

// 运行时 dataDir（pi-web startup 注入；ESM namespace 不可变，故用内部变量 + setter）
let _dataDir = "";
export function setDataDir(d: string) { _dataDir = d || ""; }
export function getDataDir() { return _dataDir; }

export const DEFAULTS = {
  // 托管 bin 优先（aiti-channels 安装器装在 cache/bin 下，Windows 带 .exe——路径单一出口 installer.managedBin()），
  // 不存在时回退系统 bin /usr/local/bin/cc-connect（CC_CONNECT_BIN 可覆盖；Windows 无系统 bin 概念，恒用托管路径）
  bin: process.env.CC_CONNECT_BIN || (IS_WIN || fs.existsSync(managedBin()) ? managedBin() : "/usr/local/bin/cc-connect"),
  config: path.join(homedir(), ".config", "cc-connect.toml"),
  sock: path.join(homedir(), ".cc-connect", "run", "api.sock"),
  log: path.join(homedir(), ".cc-connect", "logs", "cc-connect.log"),
};

// ---------- 进程状态 ----------

function readPidFile(dataDir: string): number | null {
  try {
    const p = Number(fs.readFileSync(path.join(dataDir, "cc.pid"), "utf8").trim());
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

function writePidFile(dataDir: string, pid: number) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "cc.pid"), String(pid));
}

function pidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ManagerOpts = {
  dataDir: string;
  bin?: string;
  config?: string;
  logFile?: string;
  sock?: string; // 缺省从 dataDir 推导：<dataDir>/run/api.sock
};

function resolveSock(m: ManagerOpts): string {
  return m.sock || path.join(m.dataDir, "run", "api.sock");
}

function resolveConfig(m: ManagerOpts): string {
  return m.config || DEFAULTS.config;
}
function resolveLog(m: ManagerOpts): string {
  return m.logFile || DEFAULTS.log;
}

/** 解析 PowerShell `Get-CimInstance Win32_Process` 的 TSV 行（pid \t Name \t CommandLine；
 *  非管理员时其他用户的 CommandLine 为空——name 匹配不受影响，configPath 精确匹配受限）。 */
export function parseCimTable(out: string): Array<{ pid: number; name: string; cmdline: string }> {
  const rows: Array<{ pid: number; name: string; cmdline: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const pid = Number(parts[0]!.trim());
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid, name: (parts[1] ?? "").trim(), cmdline: (parts[2] ?? "").trim() });
  }
  return rows;
}

/** 找正在运行的 cc-connect 进程——按 config 路径精确匹配（多实例互不误杀）。 */
async function findRunning(configPath?: string): Promise<{ pid: number; cmdline: string } | null> {
  if (IS_WIN) {
    // Windows 无 ps：一次 Get-CimInstance 全表（async——红线禁 execFileSync 秒级外部程序）
    try {
      const out = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }',
      ], { timeoutMs: 15000 });
      for (const r of parseCimTable(out)) {
        if (!/^cc-connect(\.exe)?$/i.test(r.name)) continue;
        if (configPath && !r.cmdline.includes(configPath)) continue;
        return { pid: r.pid, cmdline: r.cmdline || r.name };
      }
    } catch { /* ignore */ }
    return null;
  }
  try {
    const out = await execFileAsync("ps", ["-eo", "pid,args"], { timeoutMs: 10000 });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const [, pidStr, args] = m;
      if (!/\/?cc-connect\b/.test(args) || /grep|ps\b/.test(args)) continue;
      // 指定 config 时精确匹配；否则匹配任何实例（默认兼容）
      if (configPath && !args.includes(configPath)) continue;
      return { pid: Number(pidStr), cmdline: args };
    }
  } catch { /* ignore */ }
  return null;
}

// ---------- TCP / socket 探测 ----------

function tcpProbe(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.once("error", () => resolve(false));
  });
}

function sockHttpProbe(sockPath: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(sockPath)) return resolve(false);
    const req = http.request(
      { socketPath: sockPath, path: "/health", method: "GET", timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode !== undefined); },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ---------- socket API 客户端（实测：/send、/sessions） ----------

function socketRequest<T = any>(
  sockPath: string,
  method: string,
  apiPath: string,
  body?: unknown,
  timeoutMs = 10000,
  /** cc-connect api_addr patch: TCP listen addr ("127.0.0.1:9375") — dials host:port
   *  instead of the unix/pipe socketPath. Set from config api_addr (Windows reachable). */
  tcpAddr?: string,
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    // cc-connect api_addr patch（2026-11-28）：api_addr 配置时走 TCP——Windows 上
    // AF_UNIX 管名 libuv 拨不通（见 2026-09-18 实测），TCP 是我们 patch 进上游的可达通道。
    if (tcpAddr) {
      const at = tcpAddr.lastIndexOf(":");
      const host = at > 0 ? tcpAddr.slice(0, at) : "127.0.0.1";
      const port = Number(at > 0 ? tcpAddr.slice(at + 1) : 0) || 0;
      const bodyStr = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host,
          port,
          path: apiPath,
          method,
          timeout: timeoutMs,
          headers: bodyStr ? { "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) } : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let data = text as unknown as T;
            try { data = JSON.parse(text); } catch { /* keep raw */ }
            resolve({ status: res.statusCode || 0, data });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("tcp api 请求超时")); });
      if (bodyStr) req.write(bodyStr);
      req.end();
      return;
    }
    // Windows 已知缺口（2026-09-18 真机实测 v1.5.0）：上游 api 只监听 AF_UNIX，Node/libuv 拨不通
    // （EACCES；libuv 的 socketPath 在 win 是命名管语义）。已通过 api_addr patch（cc-connect win-api-addr
    // 分支）解锁 TCP 通道——配置 api_addr 后走上方 TCP 分支。
    if (!fs.existsSync(sockPath)) return reject(new Error(`api.sock 不存在：${sockPath}${IS_WIN ? "（Windows：cc-connect api 仅 AF_UNIX，Node 无法连接——已知缺口，见 windows-compat 方案 §6.1）" : ""}`));
    const bodyStr = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: sockPath,
        path: apiPath,
        method,
        timeout: timeoutMs,
        headers: bodyStr ? { "content-type": "application/json", "content-length": Buffer.byteLength(bodyStr) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = text as unknown as T;
          try { data = JSON.parse(text); } catch { /* keep raw */ }
          try { data = JSON.parse(text); } catch { /* keep raw */ }
          resolve({ status: res.statusCode || 0, data });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("socket 请求超时")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export type SendOptions = {
  project: string;
  sessionKey: string;
  message: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
};

/** 发消息（文本/文件）。filePath 存在时按文件发送（读 base64 → FileAttachment JSON）。
 *  tcpAddr = config api_addr（cc-connect api_addr patch）→ TCP 通道（Windows 可达）。 */
export async function sendMessage(opts: SendOptions & { sock?: string; tcpAddr?: string }): Promise<any> {
  const sock = opts.sock || DEFAULTS.sock;
  const body: any = { project: opts.project, session_key: opts.sessionKey, message: opts.message };
  if (opts.filePath && fs.existsSync(opts.filePath)) {
    const data = fs.readFileSync(opts.filePath).toString("base64");
    body.file = {
      FileName: opts.fileName || path.basename(opts.filePath),
      MimeType: opts.mimeType || "application/octet-stream",
      Data: data,
    };
  }
  return socketRequest(sock, "POST", "/send", body, 10000, opts.tcpAddr);
}

export async function listSessions(sock?: string, tcpAddr?: string): Promise<any> {
  return socketRequest(sock || DEFAULTS.sock, "GET", "/sessions", undefined, 10000, tcpAddr);
}

// ---------- 托管（start / stop / restart） ----------

export async function status(m: ManagerOpts) {
  const bin = m.bin || DEFAULTS.bin;
  const config = resolveConfig(m);
  const sock = resolveSock(m);
  const pidFile = readPidFile(m.dataDir);
  const running = await findRunning(config);
  const pid = running ? running.pid : pidFile && pidAlive(pidFile) ? pidFile : null;
  // Runner regime: runtime.json (what WE started last) + systemd unit liveness.
  // An instance started by the old setsid path has no runtime.json → regime null.
  const runtime = proc.readRuntime(m.dataDir);
  let unitActive = false;
  if (runtime?.runner === "systemd-run" && runtime.unit) {
    unitActive = await proc.unitBusy(runtime.unit, proc.userManagerEnv(typeof process.getuid === "function" ? process.getuid() : undefined));
  }

  return {
    bin,
    config,
    sock,
    existsBin: fs.existsSync(bin),
    existsConfig: fs.existsSync(config),
    running: !!pid,
    pid: pid || null,
    cmdline: running ? running.cmdline : null,
    port9820: false,
    port9810: false,
    sockAlive: false,
    runner: runtime?.runner || null,
    unit: runtime?.unit || null,
    unitActive,
    cfg: readConfigFile(config),
  };
}

export async function probe(m: ManagerOpts): Promise<Record<string, any>> {
  const s = await status(m);
  const mgmtPort = s.cfg?.management?.port || 9820;
  const bridgePort = s.cfg?.bridge?.port || 9810;
  const [pMgmt, pBridge, sock] = await Promise.all([
    tcpProbe(mgmtPort),
    tcpProbe(bridgePort),
    sockHttpProbe(resolveSock(m)),
  ]);
  s.port9820 = pMgmt;
  s.port9810 = pBridge;
  s.sockAlive = sock;

  // management API 版本（带 token）
  let version: string | null = null;
  let mgmtError: string | null = null;
  const token = s.cfg?.management.token || "";
  if (pMgmt && token) {
    try {
      const res = await fetch(`http://127.0.0.1:${mgmtPort}/api/v1/status`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const d = await res.json().catch(() => null);
        version = d?.data?.version || null;
      } else mgmtError = `HTTP ${res.status}`;
    } catch (e: any) { mgmtError = e.message; }
  }
  s.version = version;
  s.mgmtError = mgmtError;
  return s;
}

export async function start(m: ManagerOpts): Promise<{ ok: boolean; pid?: number; error?: string; note?: string }> {
  const bin = m.bin || DEFAULTS.bin;
  const config = resolveConfig(m);
  const logFile = resolveLog(m);
  if (!fs.existsSync(bin)) return { ok: false, error: `cc-connect 二进制不存在：${bin}` };
  if (await findRunning(config)) return { ok: false, error: "cc-connect 已在运行（不重复启动）", note: "如需重启请用 restart" };

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.mkdirSync(m.dataDir, { recursive: true });

  // Runner dispatch (decided once per start): systemd-run transient unit when
  // the user manager answers (immune to pi-web restarts, cgroup-wide stop),
  // plain/cim otherwise (historical paths). Every failure degrades to plain —
  // starting must never regress because the fancier runner hiccuped.
  const probe = await proc.probeRunner();
  const unit = proc.unitNameFor(instanceIdOfDataDir(m.dataDir));
  try {
    if (probe.kind === "systemd-run") {
      if (await proc.unitBusy(unit, probe.env)) {
        return { ok: false, error: `单元 ${unit} 已被占用（unitBusy）`, note: "上次启动可能未完全退出；稍后重试或先 stop" };
      }
      await proc.launchSystemd({ bin, config, logFile, unit, env: probe.env });
      proc.writeRuntime(m.dataDir, { runner: "systemd-run", unit, startedAt: new Date().toISOString() });
      console.log(`[aiti-channels] started via systemd-run unit ${unit} (${probe.detail})`);
      return { ok: true, note: `已启动（systemd 单元 ${unit}，免疫 pi-web 重启），日志 ${logFile}` };
    }
    if (probe.kind === "windows-cim") {
      const r = await proc.launchWindowsCim({ bin, config, logFile, unit, env: probe.env });
      proc.writeRuntime(m.dataDir, { runner: "windows-cim", pid: r.launcherPid, startedAt: new Date().toISOString() });
      if (r.launcherPid) writePidFile(m.dataDir, r.launcherPid);
      console.log(`[aiti-channels] started via Win32_Process.Create (${probe.detail})`);
      return { ok: true, pid: r.launcherPid, note: `已启动（Win32_Process.Create，pid ${r.launcherPid ?? "?"}），日志 ${logFile}` };
    }
  } catch (e: any) {
    console.warn(`[aiti-channels] runner ${probe.kind} failed, degrading to plain: ${e.message}`);
  }
  const r = await proc.launchPlain({ bin, config, logFile, unit, env: probe.env });
  proc.writeRuntime(m.dataDir, { runner: "plain", pid: r.pid, startedAt: new Date().toISOString() });
  writePidFile(m.dataDir, r.pid);
  return { ok: true, pid: r.pid, note: `已启动（pid ${r.pid}，plain detached），日志 ${logFile}` };
}

/** Instance id from its dataDir: the registry maps id→dataDir 1:1, so match
 *  back (default instance ~/.cc-connect included); unknown dirs fall back to a
 *  sanitized dirname (only affects the systemd unit name, nothing functional). */
function instanceIdOfDataDir(dataDir: string): string {
  for (const inst of listInstances()) {
    if (path.resolve(inst.dataDir) === path.resolve(dataDir)) return inst.id;
  }
  const base = path.basename(dataDir.replace(/[\\/]+$/, "")) || "default";
  return base.replace(/^\.cc-connect-?/i, "") || "default";
}

export async function stop(m: ManagerOpts): Promise<{ ok: boolean; error?: string; note?: string }> {
  // systemd regime first (runtime.json): systemctl stop is cgroup-wide and
  // graceful; pid paths below stay as the fallback / other-regime handler.
  const runtime = proc.readRuntime(m.dataDir);
  if (runtime?.runner === "systemd-run" && runtime.unit) {
    const env = proc.userManagerEnv(typeof process.getuid === "function" ? process.getuid() : undefined);
    if (await proc.unitBusy(runtime.unit, env)) {
      await proc.stopUnitAndWait(runtime.unit, env);
      // belt & braces: the unit is stopping — give it a moment, then verify
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300));
        if (!(await proc.unitBusy(runtime.unit, env))) break;
      }
      const still = await findRunning(resolveConfig(m));
      if (!still) {
        proc.clearRuntime(m.dataDir);
        return { ok: true, note: `已停止（systemd 单元 ${runtime.unit}，cgroup 树杀）` };
      }
      // unit stopped but a stray process matches (started outside the unit) — fall through to pid stop
    } else {
      proc.clearRuntime(m.dataDir);
    }
  }

  const running = await findRunning(resolveConfig(m));
  const pid = running ? running.pid : readPidFile(m.dataDir);
  if (!pid || !pidAlive(pid)) {
    return { ok: false, error: "cc-connect 未在运行" };
  }
  if (IS_WIN) {
    // Windows 无 POSIX 信号（process.kill SIGTERM 实为 TerminateProcess 硬杀且不杀子进程）——
    // lessons §0.2 样板：taskkill /T /F 树杀；无优雅退出（flush 丢与否取决于上游），note 里注明
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeoutMs: 8000 });
      proc.clearRuntime(m.dataDir);
      return { ok: true, note: `已树杀（pid ${pid}，Windows taskkill 强杀，无优雅退出）` };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }
  try {
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!pidAlive(pid)) {
        proc.clearRuntime(m.dataDir);
        return { ok: true, note: `已停止（pid ${pid}）` };
      }
    }
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    proc.clearRuntime(m.dataDir);
    return { ok: true, note: `已强制停止（pid ${pid}）` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function restart(m: ManagerOpts) {
  const st = await stop(m);
  // 若原本没在跑，stop 返回 error——不算失败
  await new Promise((r) => setTimeout(r, 500));
  const s = await start(m);
  const wasRunning = st.ok || st.error !== "cc-connect 未在运行";
  return { stopped: wasRunning, ...s };
}

export function logTail(m: ManagerOpts, n = 80): { file: string; lines: string[]; exists: boolean } {
  const f = resolveLog(m);
  try {
    const raw = fs.readFileSync(f, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return { file: f, lines: lines.slice(-n), exists: true };
  } catch {
    return { file: f, lines: [], exists: false };
  }
}

// ---------- 消息日志（我们平台经 cc-connect 发的消息，专用记录 JSONL） ----------

export type MsgLogEntry = {
  ts: string;
  project: string;
  session_key: string;
  platform?: string;
  message: string;
  file?: string | null;
  result: "ok" | "error";
  detail?: any;
};

function msgLogFile(m: ManagerOpts): string {
  // 数据分层：消息日志（历史，不可再生）→ state/（m.dataDir 为扩展 cache 根）
  return path.join(path.dirname(m.dataDir), "state", "msg-log.jsonl");
}

/** 记录一条发消息日志（追尾巴追加 JSONL；dataDir 不存在则建）。 */
export function writeMsgLog(m: ManagerOpts, entry: Omit<MsgLogEntry, "ts">): void {
  try {
    fs.mkdirSync(m.dataDir, { recursive: true });
    fs.mkdirSync(path.dirname(msgLogFile(m)), { recursive: true }); // state/ 目录自建（宿主预建之外的双保险）
    fs.appendFileSync(msgLogFile(m), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* 日志失败不阻断发送 */ }
}

/** 读取最近 N 条消息日志（新→旧）。 */
export function readMsgLogs(m: ManagerOpts, limit = 100): MsgLogEntry[] {
  try {
    const raw = fs.readFileSync(msgLogFile(m), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const list: MsgLogEntry[] = [];
    for (const l of lines) { try { list.push(JSON.parse(l)); } catch { /* skip */ } }
    return list.slice(-limit).reverse();
  } catch {
    return [];
  }
}

// ---------- 多实例注册表 ----------

export type ChannelInstance = {
  id: string;
  name: string;
  config: string;   // config.toml 路径（每实例独立）
  dataDir: string;  // cc-connect data dir（socket/log 隔离）
  bin?: string;
  logFile?: string; // 缺省 <dataDir>/cc-connect.log
};

function instancesFile(): string {
  return path.join(getDataDir(), "instances.json");
}

/** 实例列表：默认实例（现有 ~/.config/cc-connect.toml）+ 用户自建实例。 */
export function listInstances(): ChannelInstance[] {
  const def: ChannelInstance = {
    id: "default",
    name: "默认实例",
    config: DEFAULTS.config,
    dataDir: path.join(homedir(), ".cc-connect"),
  };
  try {
    const raw = fs.readFileSync(instancesFile(), "utf8");
    const list = JSON.parse(raw);
    return [def, ...(Array.isArray(list) ? list : [])];
  } catch {
    return [def];
  }
}

export function resolveInstance(id: string): ChannelInstance | null {
  return listInstances().find((i) => i.id === id) || null;
}

export function saveInstance(inst: ChannelInstance) {
  const list = listInstances().filter((i) => i.id !== "default");
  const idx = list.findIndex((i) => i.id === inst.id);
  if (idx >= 0) list[idx] = inst; else list.push(inst);
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(instancesFile(), JSON.stringify(list, null, 2));
}

export function deleteInstance(id: string) {
  const list = listInstances().filter((i) => i.id !== "default" && i.id !== id);
  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.writeFileSync(instancesFile(), JSON.stringify(list, null, 2));
}

/** 从实例构造 ManagerOpts（bin/log 缺省推导）。 */
export function optsFor(inst: ChannelInstance): ManagerOpts {
  return {
    dataDir: inst.dataDir,
    config: inst.config,
    bin: inst.bin || DEFAULTS.bin,
    logFile: inst.logFile || path.join(inst.dataDir, "cc-connect.log"),
    sock: path.join(inst.dataDir, "run", "api.sock"),
  };
}
