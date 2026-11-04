/**
 * aiti-ui-env · 显示环境核心（模式 / 探测 / 裁决 / 运行 / VNC）
 *
 * 职责：把「4 种显示模式」裁决成一份可执行的环境变量（DISPLAY/XAUTHORITY/
 * DBUS_SESSION_BUS_ADDRESS/XDG_RUNTIME_DIR/a11y 开关），供新启动的 MCP/GUI 应用使用。
 * 只依赖 Node 内建模块（fs/os/child_process），不进任何 npm 依赖。
 *
 * 关键语义（与 docs/aiti-ui-env-extension-plan.md §3 一致）：
 *   prefer-desktop   桌面可用→桌面，否则回退虚拟屏
 *   prefer-headless  虚拟屏可用→虚拟屏，否则回退桌面
 *   always-desktop   强制桌面；不可用返回 error
 *   always-headless  强制虚拟屏；不可用返回 error + 启动指引（feature 开启时自动拉起）
 *
 * 模式优先级：调用方显式 prefer > env UI_ENV_MODE > 持久化文件 configDir/env-mode.json
 * 探测带 TTL 缓存（1.5s）；实例幂等，跨扩展 reload 存活（用方挂 globalThis 单例）。
 */

import { spawn, execFile } from "node:child_process";
import { connect } from "node:net";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureRdpWasm, wasmCachePath } from "./rdp-wasm-assets.js";
import * as win from "./win.js";
import * as mac from "./mac.js";

export const LIB_VERSION = "0.3.1"; // 单例 key 用：lib 逻辑变更时 bump，reload 即换新实例

/** 平台分派：Windows/macOS 语义映射见 docs/aiti-ui-env-{windows-support,macos-support}-plan.md */
export const IS_WIN = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";
export const IS_UNIX = !IS_WIN && !IS_MAC;

export type UeMode = "prefer-desktop" | "prefer-headless" | "always-desktop" | "always-headless";
export type UeTarget = "desktop" | "headless";

export const MODES: { id: UeMode; label: string; desc: string }[] = [
  { id: "prefer-desktop", label: "优先桌面", desc: "桌面可用走真实桌面，否则虚拟屏" },
  { id: "prefer-headless", label: "优先无头虚拟环境", desc: "虚拟屏可用走虚拟屏，否则桌面" },
  { id: "always-desktop", label: "总是桌面", desc: "强制真实桌面，不可用即报错" },
  { id: "always-headless", label: "总是无头虚拟环境", desc: "强制虚拟屏，未启动给出启动指引" },
];

export const DEFAULT_DISPLAY_NUM = 99;

/** 探测结果（一次探测的完整快照） */
export interface ProbeInfo {
  display: string;
  available: boolean;
  kind?: "x11" | "wayland" | "windows" | "macos";
  xauthority?: string;
  resolution?: string;
  wm?: string;
  dbusBus?: string;      // AT-SPI session bus（headless）
  atspi: boolean;        // at-spi 总线进程在跑
  vnc?: { tcp: boolean; web: boolean; tcpPort?: number; webPort?: number };
  error?: string;
  consoleUser?: string;  // macOS：控制台登录用户（root = 停在登录窗口）
}

export interface Resolved {
  ok: boolean;
  mode: UeMode;
  target: UeTarget | null;
  env: Record<string, string>;
  exportLines: string[];
  rationale: string;
  warnings: string[];
  error?: string;
  hint?: string;
  probes: { desktop: ProbeInfo; headless: ProbeInfo };
}

export interface RunResult {
  ok: boolean;
  pid?: number;
  cmd?: string;
  target?: UeTarget;
  env?: Record<string, string>;
  logFile?: string;
  error?: string;
}

// ─────────────────────────── 工具小函数 ───────────────────────────

function runCmd(cmd: string, args: string[], timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 1 << 20 },
      (err: Error | null, stdout: string) => resolve(err ? "" : String(stdout)));
  });
}

/** 执行并拿二进制输出（VNC 密码文件是 8 字节二进制，utf8 会损坏）；可喂 stdin。 */
function runCmdBuf(cmd: string, args: string[], input?: Buffer, timeoutMs = 8000): Promise<{ ok: boolean; out: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { timeout: timeoutMs, stdio: [input ? "pipe" : "ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let done = false;
    const fin = (ok: boolean) => { if (!done) { done = true; resolve({ ok, out: Buffer.concat(chunks) }); } };
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", () => fin(false));
    child.on("close", (code) => fin(code === 0));
    if (input && child.stdin) { child.stdin.end(input); }
  });
}

function uidOf(): number | string {
  try { return process.getuid?.() ?? os.userInfo().uid; } catch { return os.userInfo().uid; }
}

function homeDir(): string {
  return os.homedir();
}

/** 解析可执行文件绝对路径：PATH 优先（command -v / where），再查常见安装目录 */
export async function resolveBin(bin: string): Promise<string | null> {
  if (IS_WIN) return win.winResolveBin(bin);
  const v = await runCmd("sh", ["-c", `command -v ${bin} 2>/dev/null`]).catch(() => "");
  if (v.trim()) return v.trim();
  const dirs = [
    path.join(homeDir(), ".local", "bin"),
    "/usr/local/bin", "/usr/bin", "/usr/sbin", "/bin", "/sbin",
    "/usr/libexec", "/usr/lib",
    "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin",
    path.join(homeDir(), "bin"),
  ];
  for (const d of dirs) {
    try { if (fs.existsSync(path.join(d, bin))) return path.join(d, bin); } catch { /* ignore */ }
  }
  return null;
}

/** 探测 TCP 端口监听（Linux: ss 优先回退 netstat；macOS: BSD netstat -an -p tcp；Windows: netstat -an LISTENING） */
export async function portListening(port: number): Promise<boolean> {
  if (IS_WIN) return win.winPortListening(port);
  if (IS_MAC) return mac.macPortListening(port);
  const out = await runCmd("ss", ["-tln"]).catch(() => "");
  if (out) return new RegExp(`:${port}\\s`).test(out) || new RegExp(`:${port}$`).test(out);
  const net = await runCmd("netstat", ["-tln"]).catch(() => "");
  return new RegExp(`:${port}\\s`).test(net) || new RegExp(`:${port}$`).test(net);
}

/** 任意 host:port TCP 可达性探测（外部 VNC/RDP 目标用；本机端口用 portListening 即可）。
 *  2.5s 超时避免远程死锚点挂起。 */
export function tcpReachable(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let sock: ReturnType<typeof connect> | null = null;
    const finish = (ok: boolean) => { if (!done) { done = true; try { sock?.destroy(); } catch { /* ignore */ } resolve(ok); } };
    try {
      sock = connect({ host, port }, () => finish(true));
      sock.on("error", () => finish(false));
      sock.setTimeout(timeoutMs, () => finish(false));
    } catch { finish(false); } // 防同步抛异常（畸形 host 等）导致 Promise 永不 settle
  });
}

/** 抓进程列表（Xorg/Xvfb 命令行里找 -auth / 显示号） */
async function psArgs(): Promise<string[]> {
  const out = await runCmd("ps", ["-eo", "args"]).catch(() => "");
  return out.split("\n").filter(Boolean);
}

function detectDesktopDisplayNum(): number | null {
  // 保留：多桌面 socket 场景的桌面显示号解析备用（当前以 Xorg 进程为主证据）
  try {
    for (const f of fs.readdirSync("/tmp/.X11-unix")) {
      const m = f.match(/^X(\d+)$/);
      if (m) return Number(m[1]);
    }
  } catch { return null; }
  return null;
}

function findSocket(displayNum: number): boolean {
  return fs.existsSync(`/tmp/.X11-unix/X${displayNum}`);
}

const XAUTH_HINTS = [
  () => `/tmp/ui-env-${DEFAULT_DISPLAY_NUM}/Xauthority`,
  () => path.join(homeDir(), ".Xauthority"),
  () => `/run/user/${uidOf()}/gdm/Xauthority`,
];

// ─────────────────────────── 探测 ───────────────────────────

let probeCache: { at: number; desktop: ProbeInfo; headless: ProbeInfo } | null = null;
const PROBE_TTL = 1500;

export async function probeAll(refresh = false): Promise<{ desktop: ProbeInfo; headless: ProbeInfo }> {
  if (!refresh && probeCache && Date.now() - probeCache.at < PROBE_TTL) return probeCache;
  const [desktop, headless] = await Promise.all([probeDesktop(), probeHeadless()]);
  probeCache = { at: Date.now(), desktop, headless };
  return probeCache;
}

async function probeDesktop(): Promise<ProbeInfo> {
  if (IS_WIN) return win.winProbeDesktop();
  if (IS_MAC) return mac.macProbeDesktop();
  const args = await psArgs();
  // 只认 Xorg（真桌面）；Xvfb/Xvnc 是无头虚拟屏，不算桌面。
  // -displayfd 启动的 Xorg 命令行里没有显式 :N → 回退 :0 并用 socket 验证。
  const xProc = args.find((l) => /(\/usr\/lib\/xorg\/Xorg|Xorg\s|\bXorg\b)/.test(l) && !/Xvfb|Xvnc/.test(l) && !/grep/.test(l));
  const numRaw = xProc && ((xProc.match(/\s:(\d+)/) || [])[1]);
  // -displayfd 的 Xorg 命令行没有显式 :N → 从 socket 目录挑非虚拟屏的最小编号（如 GDM 常见 :1）
  let num: string | null = numRaw || null;
  if (xProc && !num) {
    const headlessNum = envDisplayNum();
    const socks: number[] = [];
    try { for (const f of fs.readdirSync("/tmp/.X11-unix")) { const m = f.match(/^X(\d+)$/); if (m) socks.push(Number(m[1])); } } catch { /* ignore */ }
    const cand = socks.filter((n) => n !== headlessNum).sort((a, b) => a - b);
    num = cand.includes(0) ? "0" : (cand[0] !== undefined ? String(cand[0]) : null);
  }
  const display = num ? `:${num}` : ":0";
  const info: ProbeInfo = { display, available: false, atspi: false, error: undefined };

  // 1) socket 证据（Xorg 进程对应的显示号必须有 socket）
  if (num === null || !findSocket(Number(num))) {
    info.error = "未发现桌面 X server 进程（仅 Xvfb 不算桌面）";
    return info;
  }
  if (xProc) {
    const m = xProc.match(/-auth\s+(\S+)/);
    if (m) info.xauthority = m[1];
  }
  if (!info.xauthority) {
    for (const hint of XAUTH_HINTS) {
      try { if (fs.existsSync(hint())) { info.xauthority = hint(); break; } } catch { /* ignore */ }
    }
  }

  // 2) wayland 判定：进程里有 wayland 合成器 + XDG_RUNTIME wayland socket
  const isWayland = args.some((l) => /weston|sway|wayfire|mutter.*wayland|kwin_wayland|labwc|hyprland/.test(l) && !/grep/.test(l));
  info.kind = isWayland ? "wayland" : "x11";

  // 3) 分辨率（xdpyinfo 可选）
  const res = await runCmd("sh", ["-c", `DISPLAY=${info.display} xdpyinfo 2>/dev/null | grep -m1 dimensions`]).catch(() => "");
  if (res) info.resolution = res.trim();

  // 4) WM（常见枚举，弱证据）
  const wm = args.find((l) => /(gnome-shell|kwin|openbox|mutter|xfwm4|i3|sway|xfce4-session|plasma)/.test(l) && !/grep/.test(l));
  if (wm) info.wm = wm.trim().split(/\s+/)[0].split("/").pop();

  // 5) at-spi（桌面会话的语义总线；非必须）
  info.atspi = args.some((l) => /at-spi-bus-launcher/.test(l) && !/grep/.test(l));

  info.available = true;
  if (!info.xauthority) info.error = "桌面可达但未找到 Xauthority（启动 GUI 可能被拒，需授权）";
  return info;
}

async function probeHeadless(): Promise<ProbeInfo> {
  if (IS_WIN) return win.winProbeHeadless(configDir);
  if (IS_MAC) return mac.macProbeHeadless();
  const num = envDisplayNum();
  const display = `:${num}`;
  const info: ProbeInfo = { display, available: false, atspi: false, error: undefined };

  if (!findSocket(num)) {
    info.error = `虚拟屏未运行：/tmp/.X11-unix/X${num} 不存在`;
    return info;
  }
  const args = await psArgs();
  const xProc = args.find((l) => /Xvfb|Xvnc/.test(l) && new RegExp(`:${num}`).test(l) && !/grep/.test(l));
  if (!xProc) {
    info.error = `${display} socket 存在但未找到 Xvfb/Xvnc 进程`;
    return info;
  }
  const m = xProc.match(/-screen\s+\S+\s+(\S+)/);
  if (m) info.resolution = m[1];
  const auth = xProc.match(/-auth\s+(\S+)/);
  if (auth) info.xauthority = auth[1];

  if (!info.xauthority) {
    for (const hint of XAUTH_HINTS) {
      try { if (fs.existsSync(hint())) { info.xauthority = hint(); break; } } catch { /* ignore */ }
    }
  }

  // AT-SPI session bus：Xvfb 同用户常见路径枚举
  const busCandidates = [
    `/tmp/ui-env-${num}/bus`,
    `/run/user/${uidOf()}/at-spi/bus`,
    path.join(homeDir(), ".cache", "at-spi", `bus_${num}`),
  ];
  for (const c of busCandidates) {
    try {
      if (fs.existsSync(c)) { info.dbusBus = c; break; }
    } catch { /* ignore */ }
  }
  info.atspi = args.some((l) => /at-spi-bus-launcher/.test(l) && !/grep/.test(l)) || !!info.dbusBus;

  info.wm = args.find((l) => /openbox/.test(l) && !/grep/.test(l)) ? "openbox" : undefined;
  if (!info.wm) info.error = "虚拟屏无 openbox（WM 缺失会限制语义操作的 foreground 激活）";

  // VNC 层：多实例感知（优先第一个实例的随机端口；注册表空时回退固定端口探测）
  const insts = vncInstances();
  const inst = insts[0];
  const vncPort = inst ? inst.rfbPort : envNumber("UI_ENV_VNC_PORT", 5900);
  const webPort = inst ? inst.webPort : vncWebPort();
  const [tcp, web] = await Promise.all([portListening(vncPort), portListening(webPort)]);
  info.vnc = { tcp, web, tcpPort: vncPort, webPort };

  info.available = true;
  return info;
}

// ─────────────────────────── 模式 ───────────────────────────

let configDir = ""; // startup 注入
export function setDataDir(dir: string) { configDir = dir; }
export function getDataDir(): string { return configDir; }

/** 数据分层（三目录对称 2026-09-13）：configDir = <extRoot>/config，cache 在 <extRoot>/cache 下。 */
function cachePath(...segments: string[]): string {
  return path.join(path.dirname(configDir), "cache", ...segments);
}

function modeFile(): string { return path.join(configDir, "env-mode.json"); }
function validMode(m: string): m is UeMode { return (MODES.some((x) => x.id === m)); }

export function loadMode(): UeMode {
  const envMode = process.env.UI_ENV_MODE;
  if (envMode && validMode(envMode)) return envMode;
  try {
    const j = JSON.parse(fs.readFileSync(modeFile(), "utf8"));
    if (validMode(j.mode)) return j.mode;
  } catch { /* 无文件或损坏 → 默认 */ }
  return "prefer-headless";
}

export function saveMode(mode: UeMode): UeMode {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(modeFile(), JSON.stringify({ mode, updatedAt: new Date().toISOString() }, null, 2));
  } catch { /* 写失败不致命 */ }
  return mode;
}

let hostFeatures: any = null; // DI 方案 P1：extension startup 捕获 ctx.features（CLI 场景保持 null）
/** 扩展入口调用：捕获 ctx.features（DI 方案 P1；CLI 场景不调用，走旧通道兜底） */
export function setFeatureSource(f: unknown): void { hostFeatures = f ?? null; }
export function featureEnabled(id: string): boolean {
  try {
    const v = hostFeatures?.get?.("aiti-ui-env", id);
    if (typeof v === "boolean") return v;
    const reg = (globalThis as Record<string, any>).__piWebExt;
    if (reg && typeof reg.featureEnabled === "function") return !!reg.featureEnabled("aiti-ui-env", id);
  } catch { /* ignore */ }
  return true; // 无 registry（独立 CLI）默认开
}

// ─────────────────────────── 裁决 ───────────────────────────

let resolvedDisplayNum: number | null = null;

/** 该 display 是否属于本扩展的虚拟屏（/tmp/ui-env-<n>/ 特征目录存在）。 */
function isOursDisplay(num: number): boolean {
  try {
    return fs.existsSync(`/tmp/ui-env-${num}/bus`) || fs.existsSync(`/tmp/ui-env-${num}/Xauthority`);
  } catch { return false; }
}

/** 解析 display 号（首次调用时确定并缓存，进程内稳定；持久化到 configDir 跨 reload 复用）：
 *  - UI_ENV_DISPLAY_NUM 为数字 → 强制使用该号
 *  - UI_ENV_DISPLAY_NUM 非数字（auto/random）→ 每次随机选一个空闲号（不持久化）
 *  - 缺省 → 从 99 起找空闲（被别的程序占则递增）；本扩展正在跑的号（isOursDisplay）视为己有沿用 */
function resolveDisplayNumSync(): number {
  if (resolvedDisplayNum !== null) return resolvedDisplayNum;
  const cfg = loadDisplayConfig();
  const explicit = process.env.UI_ENV_DISPLAY_NUM;
  const randomOk = featureEnabled("behavior.random-display");
  const persistFile = configDir ? cachePath("display-num") : null;

  // 1) env 数字 → 强制
  if (explicit) {
    const n = Number(explicit);
    if (Number.isFinite(n) && n > 0) {
      resolvedDisplayNum = n;
      if (persistFile) { try { fs.writeFileSync(persistFile, String(n)); } catch {} }
      return n;
    }
    // env 显式 auto/random → 随机（env 优先，不随 feature 开关）
    const cands = Array.from({ length: 100 }, (_, i) => 90 + i).filter((c) => !findSocket(c) || isOursDisplay(c));
    const ours = cands.filter((c) => isOursDisplay(c));
    resolvedDisplayNum = ours.length ? ours[0] : (cands.length ? cands[Math.floor(Math.random() * cands.length)] : DEFAULT_DISPLAY_NUM);
    return resolvedDisplayNum;
  }

  // 2) 面板配置 fixed + 指定数字（用户指定优先，被外来占用才避让）
  if (cfg.mode === "fixed" && cfg.num) {
    let n = cfg.num;
    while (findSocket(n) && !isOursDisplay(n)) n++;
    resolvedDisplayNum = n;
    if (persistFile) { try { fs.writeFileSync(persistFile, String(n)); } catch {} }
    return n;
  }

  // 3) auto 随机（feature 开，默认）
  if (randomOk) {
    const cands = Array.from({ length: 100 }, (_, i) => 90 + i).filter((c) => !findSocket(c) || isOursDisplay(c));
    const ours = cands.filter((c) => isOursDisplay(c));
    resolvedDisplayNum = ours.length ? ours[0] : (cands.length ? cands[Math.floor(Math.random() * cands.length)] : DEFAULT_DISPLAY_NUM);
    if (persistFile) { try { fs.writeFileSync(persistFile, String(resolvedDisplayNum)); } catch {} }
    return resolvedDisplayNum;
  }

  // 4) feature 关 → 固定 99 起避让（不随机）
  let n = DEFAULT_DISPLAY_NUM;
  if (persistFile) {
    try {
      const saved = Number(fs.readFileSync(persistFile, "utf8").trim());
      if (Number.isFinite(saved) && saved > 0 && (!findSocket(saved) || isOursDisplay(saved))) n = saved;
    } catch {}
  }
  while (findSocket(n) && !isOursDisplay(n)) n++;
  resolvedDisplayNum = n;
  if (persistFile) { try { fs.writeFileSync(persistFile, String(n)); } catch {} }
  return n;
}

// ── DISPLAY 号配置（默认 auto 随机；用户可指定固定数字） ──

export interface DisplayConfig { mode: "auto" | "fixed"; num?: number; }
function displayConfigFile(): string { return path.join(configDir || "", "display-config.json"); }

export function loadDisplayConfig(): DisplayConfig {
  try {
    if (!configDir || !fs.existsSync(displayConfigFile())) return { mode: "auto" };
    const d = JSON.parse(fs.readFileSync(displayConfigFile(), "utf8"));
    return { mode: d.mode === "fixed" ? "fixed" : "auto", num: d.num };
  } catch { return { mode: "auto" }; }
}

export function saveDisplayConfig(cfg: DisplayConfig): DisplayConfig {
  const c: DisplayConfig = { mode: cfg.mode === "fixed" ? "fixed" : "auto" };
  if (c.mode === "fixed") {
    const n = Number(cfg.num);
    if (Number.isFinite(n) && n > 0) c.num = Math.floor(n);
  }
  if (configDir) {
    ensureDir(configDir, 0o755);
    try { fs.writeFileSync(displayConfigFile(), JSON.stringify(c, null, 2)); } catch {}
  }
  resolvedDisplayNum = null; // 配置变更 → 下次 resolve 重新解析
  return c;
}

function envDisplayNum(): number { return resolveDisplayNumSync(); }
function envNumber(key: string, def: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function envStr(key: string, def: string): string { return process.env[key] || def; }

function headlessBase(): { num: number; authFile: string; busFile: string; runtimeDir: string } {
  const num = envDisplayNum();
  const base = envStr("UI_ENV_XAUTH_DIR", `/tmp/ui-env-${num}`);
  return {
    num,
    authFile: path.join(base, "Xauthority"),
    busFile: path.join(base, "bus"),
    runtimeDir: path.join(base, "runtime"),
  };
}

function ensureDir(p: string, mode = 0o700): void {
  try { fs.mkdirSync(p, { recursive: true, mode }); } catch { /* ignore */ }
}

export function buildEnv(target: UeTarget, probes: { desktop: ProbeInfo; headless: ProbeInfo }): { env: Record<string, string>; warnings: string[] } {
  const warnings: string[] = [];
  if (IS_WIN) {
    // Windows：GUI 子进程继承 pi-web 交互会话即落桌面，无 DISPLAY/X11 键；
    // HOME 映射给 POSIX 工具；headless 档提供 VNC 端口提示。
    const env: Record<string, string> = {
      HOME: process.env.USERPROFILE || homeDir(),
      USER: process.env.USERNAME || "",
      LOGNAME: process.env.USERNAME || "",
      PATH: process.env.PATH || "",
      SESSIONNAME: process.env.SESSIONNAME || "",
    };
    if (target === "headless") {
      env.UI_ENV_VNC_PORT = "5900";
      if (!probes.headless.available) warnings.push("Windows 虚拟屏层未就绪：GUI 将落交互会话桌面，浏览器查看请先启动 VNC（ui_env_vnc start）");
    }
    return { env, warnings };
  }
  const base = {
    HOME: process.env.HOME || homeDir(),
    USER: process.env.USER || process.env.LOGNAME || "root",
    LOGNAME: process.env.LOGNAME || process.env.USER || "root",
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };
  const env: Record<string, string> = { ...base };
  if (IS_MAC) {
    // macOS：Aqua 应用不需要 DISPLAY/X11 键；GUI 子进程继承 pi-web（LaunchAgent=用户 GUI 会话）
    // 落控制台桌面。「无头」档 = 诚实降级（同 Windows）：GUI 仍落桌面，区别在屏幕共享 VNC 查看通道。
    if (target === "headless") {
      if (!probes.headless.available) warnings.push("屏幕共享 VNC 未就绪：GUI 将落控制台桌面，浏览器查看请先开启屏幕共享（ui_env_headless start）");
      env.UI_ENV_VNC_PORT = "5900";
    }
    return { env, warnings };
  }

  if (target === "headless") {
    const h = probes.headless;
    const { num, authFile, busFile, runtimeDir } = headlessBase();
    env.DISPLAY = h.display || `:${num}`;
    if (h.xauthority) env.XAUTHORITY = h.xauthority;
    else { env.XAUTHORITY = authFile; warnings.push(`未探测到虚拟屏 Xauthority，用默认 ${authFile}`); }
    if (h.dbusBus) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${h.dbusBus}`;
    else warnings.push("未找到 AT-SPI session bus（语义树不可用；跑 setup/install-service 补）");
    ensureDir(runtimeDir, 0o700);
    env.XDG_RUNTIME_DIR = runtimeDir;
    env.XDG_SESSION_TYPE = "x11";
    if (featureEnabled("behavior.atspi")) {
      // 追加而非覆盖（保留用户已有 GTK_MODULES，如 gtk-im-module 等）
      env.GTK_MODULES = ["atk-bridge", envStr("GTK_MODULES", "")].filter(Boolean).join(":");
      env.QT_ACCESSIBILITY = "1";
      env.NO_AT_BRIDGE = "0";
    }
    if (featureEnabled("behavior.vnc")) {
      // 多实例感知：注入当前默认实例的随机端口（注册表空时回退固定端口兼容旧场景）
      const insts = vncInstances();
      const inst = insts[0];
      env.UI_ENV_VNC_PORT = String(inst ? inst.rfbPort : envNumber("UI_ENV_VNC_PORT", 5900));
      env.UI_ENV_VNC_WEB_PORT = String(inst ? inst.webPort : vncWebPort());
    }
    env.GDK_BACKEND = "x11";
    env.WAYLAND_DISPLAY = ""; // 清残留
  } else {
    const d = probes.desktop;
    env.DISPLAY = d.display || ":0";
    env.XDG_SESSION_TYPE = d.kind || "x11";
    if (d.kind === "wayland") {
      env.WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY || "wayland-0";
      env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${uidOf()}`;
    }
    if (d.xauthority) env.XAUTHORITY = d.xauthority;
    else if (envStr("XAUTHORITY", "")) env.XAUTHORITY = process.env.XAUTHORITY!;
    else warnings.push("桌面未探测到 Xauthority；启动 GUI 被拒时执行：xhost +SI:localuser:$USER");
  }
  return { env, warnings };
}

export async function resolve(prefer?: UeTarget, refresh = false): Promise<Resolved> {
  const probes = await probeAll(refresh);
  const mode = loadMode();
  const warnings: string[] = [];
  let target: UeTarget | null = null;
  let error: string | undefined;
  let hint: string | undefined;
  let rationale = "";

  const needAutoHeadless = (): boolean => { // 虚拟屏缺失时是否尝试自动拉起
    return featureEnabled("behavior.autostart-headless");
  };
  // 无头层缺失时的指引（三平台各自表述）
  const headlessHint = (): string => IS_WIN
    ? "虚拟屏未运行。启动：ui_env_headless start（自管 VNC；首次先 ui_env_deps install 装便携 winvnc）"
    : IS_MAC
      ? "macOS 无头层 = 屏幕共享 VNC。开启：系统设置 → 通用 → 共享 → 屏幕共享；或 ui_env_headless start（免密 sudo 自动开）；或 scripts/macos/setup-macos.sh enable"
      : "虚拟屏未运行。启动：scripts/linux/install-service.sh 或 setup-linux.sh --bare（或开 behavior.autostart-headless 自动拉起）";
  const bothUnavailableHint = (): string => IS_MAC
    ? "桌面（Aqua 会话）与屏幕共享 VNC 均不可用：登录 Mac GUI 会话 + 开启屏幕共享（ui_env_headless start / setup-macos.sh）"
    : "桌面与虚拟屏均不可用，先跑 setup 安装 Xvfb/openbox";

  // 决策：显式 prefer 是单次软覆盖（目标不够好→回退并 warning）；
  // mode 的 always-* 是硬约束（目标缺失→报错不回退）。
  if (prefer === "desktop") {
    target = probes.desktop.available ? "desktop" : (probes.headless.available ? "headless" : null);
    if (target === "desktop") rationale = "调用方指定桌面：可用";
    else if (target === "headless") { warnings.push("调用方指定桌面但不可用，已回退虚拟屏"); rationale = "指定桌面→回退虚拟屏"; }
  } else if (prefer === "headless") {
    if (probes.headless.available) { target = "headless"; rationale = "调用方指定虚拟屏：可用"; }
    else if (probes.desktop.available) { target = "desktop"; warnings.push("调用方指定虚拟屏但不可用，已回退桌面"); rationale = "指定虚拟屏→回退桌面"; }
    else if (needAutoHeadless() && (await ensureHeadless())) { target = "headless"; rationale = "指定虚拟屏：自动拉起成功"; }
    else { error = "headless unavailable"; hint = headlessHint(); rationale = "指定虚拟屏但不可用"; }
  } else if (mode === "always-desktop") {
    if (probes.desktop.available) { target = "desktop"; rationale = "总是桌面：桌面可用"; }
    else { error = "requires desktop"; warnings.push(`桌面不可用：${probes.desktop.error ?? "无套接字"}`); rationale = "总是桌面但桌面不可用（不自动回退）"; }
  } else if (mode === "always-headless") {
    if (probes.headless.available) { target = "headless"; rationale = "总是无头：虚拟屏可用"; }
    else if (needAutoHeadless() && (await ensureHeadless())) { target = "headless"; rationale = "总是无头：虚拟屏自动拉起成功"; }
    else { error = "requires headless"; hint = headlessHint(); warnings.push(`虚拟屏不可用：${probes.headless.error ?? "无套接字"}`); rationale = "总是无头但虚拟屏不可用（不自动回退）"; }
  } else if (mode === "prefer-desktop") {
    if (probes.desktop.available) { target = "desktop"; rationale = "优先桌面：桌面可用"; }
    else if (probes.headless.available) { target = "headless"; warnings.push("桌面不可用，已回退虚拟屏"); rationale = "优先桌面→回退虚拟屏"; }
    else { error = "both unavailable"; hint = bothUnavailableHint(); rationale = "两侧都不可用"; }
  } else { // prefer-headless（默认）
    if (probes.headless.available) { target = "headless"; rationale = "优先无头：虚拟屏可用"; }
    else if (probes.desktop.available) { target = "desktop"; warnings.push("虚拟屏不可用，已回退桌面"); rationale = "优先无头→回退桌面"; }
    else if (needAutoHeadless() && (await ensureHeadless())) { target = "headless"; rationale = "优先无头：自动拉起成功"; }
    else { error = "both unavailable"; hint = bothUnavailableHint(); rationale = "两侧都不可用"; }
  }

  if (!target) {
    if (!error) error = "both unavailable";
    warnings.push(`桌面: ${probes.desktop.error ?? "不可用"}`);
    warnings.push(`虚拟屏: ${probes.headless.error ?? "不可用"}`);
  } else {
    // 目标已选但带降级告警（如桌面无 Xauthority / 虚拟屏无 openbox）
    const chosen = target === "desktop" ? probes.desktop : probes.headless;
    if (chosen.error) warnings.push(chosen.error);
  }

  const { env, warnings: envWarnings } = target ? buildEnv(target, probes) : { env: {}, warnings: [] };
  warnings.push(...envWarnings);
  const exportLines = Object.entries(env).map(([k, v]) => v === "" ? `unset ${k}` : `export ${k}="${v}"`);

  return {
    ok: !error && !!target,
    mode, target, env, exportLines, rationale,
    warnings: [...new Set(warnings)], error: error || undefined, hint,
    probes,
  };
}

/** 最近一次 Windows 无头启动失败的原因（供 startHeadless 回传 needPassword 等结构化信息）。 */
let winHeadlessLastError: { error?: string; needPassword?: boolean } | null = null;

/** 拉起虚拟屏（Windows: 自管便携 winvnc；macOS: 屏幕共享 VNC；Linux: systemd user 优先，失败回退裸 spawn）。返回是否就绪。 */
export async function ensureHeadless(): Promise<boolean> {
  try {
    if (IS_WIN) {
      const r = await win.winVncEnsure(configDir);
      winHeadlessLastError = r.ok ? null : { error: r.error, needPassword: r.needPassword };
      await sleep(500);
      return await win.winPortListening(5900);
    }
    if (IS_MAC) {
      return await mac.macEnsureHeadless();
    }
    // 配置变更后旧号残留清理：若存在非当前 resolve 号的本扩展虚拟屏在跑，先停掉避免多实例
    const nums = await actualHeadlessNums();
    const current = envDisplayNum();
    const others = [...nums].filter((n) => n !== current && findSocket(n));
    if (others.length) await stopHeadlessNums(new Set(others));

    const logDir = cachePath("logs");
    ensureDir(logDir, 0o755);
    const logFile = path.join(logDir, "ensure-headless.log");
    // 1) systemd user
    if (fs.existsSync(`${homeDir()}/.config/systemd/user/ui-env.target`)) {
      const r = await execFilePromise("systemctl", ["--user", "start", "ui-env.target"], 8000);
      if (!r.err) {
        await sleep(1200);
        return findSocket(envDisplayNum());
      }
    }
    // 2) system 级 unit
    if (fs.existsSync("/etc/systemd/system/ui-env.target")) {
      const r = await execFilePromise("systemctl", ["start", "ui-env.target"], 8000);
      if (!r.err) {
        await sleep(1200);
        return findSocket(envDisplayNum());
      }
    }
    // 3) 裸拉起（与 setup-linux.sh --bare 同构）
    const num = envDisplayNum();
    const { authFile, busFile, runtimeDir } = headlessBase();
    ensureDir(path.dirname(authFile), 0o700); ensureDir(runtimeDir, 0o700);
    if (fs.existsSync(authFile)) fs.rmSync(authFile, { force: true });
    await execFilePromise("sh", ["-c", `XAUTHORITY=${authFile} xauth generate :${num} . trusted 2>/dev/null; XAUTHORITY=${authFile} xauth add :${num} . $(xxd -l 16 -p /dev/urandom) 2>/dev/null || XAUTHORITY=${authFile} xauth generate :${num} . trusted`], 4000);
    if (!findSocket(num)) {
      const xvfbBin = await resolveBin("Xvfb");
      if (xvfbBin) {
        const xvfb = spawn(xvfbBin, [`:${num}`, "-screen", "0", envStr("UI_ENV_RESOLUTION", "1920x1080x24"), "-nolisten", "tcp", "-auth", authFile], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
        xvfb.on("error", () => {});
        xvfb.unref();
      }
    }
    await sleep(800);
    // dbus + at-spi（幂等：重复跑无害）
    spawn("sh", ["-c",
      `[ -S ${busFile} ] || (dbus-daemon --session --fork --address=unix:path=${busFile} --print-address >/dev/null 2>&1 || true); ` +
      `export DBUS_SESSION_BUS_ADDRESS=unix:path=${busFile}; DISPLAY=:${num} at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 || true`],
      { detached: true, stdio: "ignore" }).unref();
    // openbox（无 WM 则起）
    ensureOpenboxMenu(); // 菜单终端指向 Xvfb 可跑的模拟器（见下），已有配置不覆盖
    const args = await psArgs();
    if (!args.some((l) => /openbox/.test(l) && !/grep/.test(l))) {
      spawn("sh", ["-c",
        `export DISPLAY=:${num}; export XAUTHORITY=${authFile}; export XDG_RUNTIME_DIR=${runtimeDir}; ` +
        `export DBUS_SESSION_BUS_ADDRESS=unix:path=${busFile}; nohup openbox >/dev/null 2>&1 & true`],
        { detached: true, stdio: "ignore" }).unref();
    }
    // tint2 面板（随 openbox 一起起；没在跑才起，幂等）—— stopHeadless 会停它，start 要补回来
    if (!args.some((l) => /^tint2(\s|$)/.test(l) && !/grep/.test(l))) {
      if (await resolveBin("tint2")) {
        ensureTint2Config(); // launcher 确保含 终端/文件管理器（已存在只补缺，不覆盖用户定制）
        spawn("sh", ["-c",
          `export DISPLAY=:${num}; export XAUTHORITY=${authFile}; export XDG_RUNTIME_DIR=${runtimeDir}; ` +
          `export DBUS_SESSION_BUS_ADDRESS=unix:path=${busFile}; nohup tint2 >/dev/null 2>&1 & true`],
          { detached: true, stdio: "ignore" }).unref();
      }
    }
    fs.writeFileSync(logFile, `[${new Date().toISOString()}] ensureHeadless: bare start on :${num}\n`);
    await sleep(1000);
    return findSocket(num);
  } catch (e) {
    try { fs.appendFileSync(cachePath("logs", "ensure-headless.log"), `err: ${String((e as Error).message)}\n`); } catch { /* ignore */ }
    return false;
  }
}

/** 手动拉起无头虚拟屏（与 resolve 自动拉起同一条 ensureHeadless 链路；幂等，已在跑则直接返回就绪）。
 *  界面「启动虚拟屏」按钮 / API / agent 工具共用此入口。 */
export async function startHeadless(): Promise<{ ok: boolean; available: boolean; error?: string; hint?: string; needPassword?: boolean }> {
  const ok = await ensureHeadless();
  const p = await probeHeadless();
  const needPassword = !p.available && !!winHeadlessLastError?.needPassword;
  return {
    ok: ok && p.available,
    available: p.available,
    error: p.error || winHeadlessLastError?.error,
    needPassword,
    hint: p.available ? undefined : (needPassword
      ? "需要 VNC 密码：请让用户提供一个 1~8 位密码，然后用 ui_env_headless start { password } 重试（或 POST /vnc-password 设置）"
      : IS_WIN
        ? "启动失败：查看 configDir/logs/winvnc.log；确认便携 winvnc 存在（ui_env_deps install 可自动安装到 configDir/ultravnc）"
        : IS_MAC
          ? "开启失败：屏幕共享需授权——系统设置 → 通用 → 共享 → 屏幕共享；有免密 sudo 时重试 ui_env_headless start"
          : "启动失败：请查看 configDir/logs/ensure-headless.log；或跑 scripts/linux/setup-linux.sh --bare 手动拉一次"),
  };
}

/** 读取已设置的 VNC 密码（仅 Windows 自管 winvnc 用；返回非 null 表示已设置）。 */
export function vncPassword(configDirOverride?: string): string | null {
  return win.winVncPassword(configDirOverride || configDir);
}

/** 设置 VNC 密码（Windows 自管 winvnc 快捷方式）：等价于 resetVncPassword 的 Windows 自管路径。 */
export async function setVncPassword(pw: string): Promise<{ ok: boolean; password?: string; error?: string; needDep?: boolean }> {
  const r = await resetVncPassword(pw);
  return { ok: r.ok, password: r.password, error: r.error };
}

// ── VNC 密码重设（通用：自管 winvnc / 系统 VNC server） ─────────────────────

export interface ResetVncPasswordResult {
  ok: boolean;
  password?: string;
  applied?: string[];      // 实际写入了哪些目标（人可读）
  errors?: string[];       // 部分失败（其他目标可能已成功）
  restartRequired?: boolean;
  note?: string;
  error?: string;
}

/** 重设 VNC 密码 —— 统一入口（面板 🔑 / API / AI 工具）。
 *  Windows：自管便携 winvnc 写 ini 并重启；系统版 UltraVNC/TightVNC 写注册表（需管理员）。
 *  Linux：x11vnc 的 -rfbauth 密码文件 或 ~/.vnc/passwd（都走标准 vncpasswd 格式）。
 *  macOS：屏幕共享用系统账号密码，不支持（返回明确说明）。 */
export async function resetVncPassword(pw: string, opts: { id?: string } = {}): Promise<ResetVncPasswordResult> {
  const p = String(pw ?? "").trim().slice(0, 8);
  if (!p) return { ok: false, error: "密码不能为空" };
  if (IS_WIN) {
    const r = await win.winResetVncPassword(configDir, p, opts);
    return {
      ok: r.ok, password: p, applied: r.applied, errors: r.errors,
      restartRequired: r.restartRequired,
      note: r.restartRequired ? "已写注册表：需重启该 VNC 服务（UltraVNC/TightVNC 服务）后生效" : undefined,
      error: r.ok ? undefined : r.error,
    };
  }
  if (IS_MAC) {
    return { ok: false, password: p, error: "macOS 屏幕共享用系统账号密码（不是 VNC 自己的密码），本扩展不能改：请到『系统设置 → 通用 → 共享 → 屏幕共享』修改该用户登录密码" };
  }
  const e = await linuxResetVncPassword(p, opts);
  return { ...e, password: p };
}

/** 写标准 VNC 密码文件（8 字节，vncpasswd 格式）：优先用系统自带工具，不在 JS 侧自实现 DES。 */
async function linuxWriteVncPasswdFile(pw: string, file: string): Promise<{ ok: boolean; how?: string; error?: string }> {
  const valid = () => { try { return fs.existsSync(file) && fs.statSync(file).size >= 8; } catch { return false; } };
  try { ensureDir(path.dirname(file), 0o700); } catch { /* ignore */ }
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  // 1) x11vnc -storepasswd：最可靠（写的正是它自己读的格式）
  if (await resolveBin("x11vnc")) {
    await runCmd("x11vnc", ["-storepasswd", pw, file], 8000);
    if (valid()) { try { fs.chmodSync(file, 0o600); } catch { /* ignore */ } return { ok: true, how: "x11vnc -storepasswd" }; }
  }
  // 2) TigerVNC vncpasswd -f：从 stdin 读密码，二进制写 stdout
  if (await resolveBin("vncpasswd")) {
    const r = await runCmdBuf("vncpasswd", ["-f"], Buffer.from(pw + "\n"), 8000);
    if (r.ok && r.out.length === 8) { fs.writeFileSync(file, r.out, { mode: 0o600 }); return { ok: true, how: "vncpasswd -f" }; }
  }
  // 3) openssl：OpenSSL 3 需显式启用 legacy provider 才有 DES
  if (await resolveBin("openssl")) {
    const data = Buffer.alloc(8); Buffer.from(pw, "ascii").copy(data, 0, 0, Math.min(8, pw.length));
    const r = await runCmdBuf("openssl", ["enc", "-des-ecb", "-K", "17526B06234E5807", "-nopad", "-provider", "legacy", "-provider", "default"], data, 8000);
    if (r.ok && r.out.length === 8) { fs.writeFileSync(file, r.out, { mode: 0o600 }); return { ok: true, how: "openssl enc -des-ecb" }; }
  }
  return { ok: false, error: "本机缺少可用的密码生成工具（x11vnc -storepasswd / vncpasswd / openssl legacy），无法写标准 VNC 密码文件" };
}

/** 读进程完整命令行（sys 扫描里的 cmd 截断到 110 字符，取 -rfbauth 路径不够用）。 */
async function readProcCmdline(pid: number): Promise<string> {
  try { return (await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ").trim(); } catch { return ""; }
}

async function linuxResetVncPassword(pw: string, opts: { id?: string }): Promise<ResetVncPasswordResult> {
  const list = await systemVncScan();
  let entry = opts.id ? list.find((e) => e.id === opts.id) : undefined;
  if (opts.id && !entry) return { ok: false, error: `未找到系统 VNC 条目 ${opts.id}（刷新系统 VNC 列表后重试）` };
  if (!entry) entry = list.find((e) => e.passwordResettable) || list[0];
  if (!entry) return { ok: false, error: "本机未发现系统 VNC server" };
  if (!entry.passwordResettable) return { ok: false, error: entry.passwordNote || "该 VNC server 的密码不由本扩展管理" };

  let file = "";
  if (entry.kind === "x11vnc") {
    const cmdline = entry.pid ? await readProcCmdline(entry.pid) : "";
    file = (cmdline.match(/-rfbauth\s+(\S+)/) || [])[1] || "";
    if (!file) return { ok: false, error: entry.passwordNote || "该 x11vnc 未使用 -rfbauth 密码文件" };
  } else if (entry.kind === "vncserver") {
    file = path.join(homeDir(), ".vnc", "passwd");
  } else {
    return { ok: false, error: entry.passwordNote || `暂不支持重设 ${entry.kind} 的密码` };
  }

  const w = await linuxWriteVncPasswdFile(pw, file);
  if (!w.ok) return { ok: false, error: w.error };
  return {
    ok: true, applied: [`${file}（${w.how}）`], restartRequired: true,
    note: `已写密码文件 ${file}：需重启该 ${entry.kind} 进程后生效（本扩展不擅自动系统进程）`,
  };
}

/** 进程的 DISPLAY 环境变量是否 == display（用 /proc/<pid>/environ，避免误杀真实桌面进程）。 */
async function procDisplayIs(pid: number, display: string): Promise<boolean> {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    return env.split("\0").some((e) => e === `DISPLAY=${display}`);
  } catch { return false; }
}

/** 实际运行中的本扩展虚拟屏号：resolve 号 + 扫描 /tmp/ui-env-<n>/ 特征目录（配置变更后旧号残留也能抓到）。 */
async function actualHeadlessNums(): Promise<Set<number>> {
  const set = new Set<number>();
  set.add(envDisplayNum());
  try {
    for (const d of fs.readdirSync("/tmp")) {
      const m = /^ui-env-(\d+)$/.exec(d);
      if (m && (fs.existsSync(`/tmp/${d}/bus`) || fs.existsSync(`/tmp/${d}/Xauthority`))) set.add(Number(m[1]));
    }
  } catch { /* ignore */ }
  return set;
}

/** 停止指定 display 号的虚拟屏进程（VNC + Xvfb + x11vnc + bridge + openbox + at-spi + dbus + tint2）。
 *  按 /proc/<pid>/environ 的 DISPLAY=:num 或强命令行特征精确匹配，绝不碰真实桌面。 */
async function stopHeadlessNums(nums: Set<number>): Promise<{ ok: boolean; available: boolean; stopped: string[]; note?: string }> {
  const stopped: string[] = [];

  // 1) VNC 实例（x11vnc + bridge）：虚拟屏停掉后它们失去意义
  for (const inst of vncInstances()) {
    if (nums.has(inst.displayNum)) {
      try { await vncStop(inst.id); stopped.push(`vnc:${inst.id}`); } catch { /* ignore */ }
    }
  }

  const out = await runCmd("ps", ["-eo", "pid,args"]).catch(() => "");
  const kill = async (pid: number, name: string) => {
    try { process.kill(pid, "SIGTERM"); stopped.push(name); } catch { /* 已退出 */ }
  };
  for (const line of out.split("\n").filter(Boolean)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]); const cmd = m[2];
    if (/^\s*(ps|grep|sh -c|timeout)/.test(cmd)) continue;
    for (const num of nums) {
      const display = `:${num}`;
      if (new RegExp(`Xvfb\\s+:${num}(\\s|$)`).test(cmd)) { await kill(pid, `Xvfb:${num}`); break; }
      if (/x11vnc/.test(cmd) && cmd.includes(`-display :${num}`)) { await kill(pid, `x11vnc:${num}`); break; }
      // ⚠ 不按「命令行含 vnc-bridge.mjs」全杀：vnc-bridge 命令行走不带 display/端口，
      //   含 sys 实例（桌面 VNC / QEMU 虚拟机等非本虚拟屏目标）的桥——只能按注册表 pid 精确杀
      //   （上面 step 1 的 vncStop(inst.id) 已做）。2026-09-15 教训：曾把用户正在看的
      //   QEMU 虚拟机视图桥一并杀掉。
      if (/^openbox(\s|$)/.test(cmd) && await procDisplayIs(pid, display)) { await kill(pid, `openbox:${num}`); break; }
      if (/at-spi-bus-launcher/.test(cmd) && await procDisplayIs(pid, display)) { await kill(pid, `at-spi:${num}`); break; }
      if (/^tint2(\s|$)/.test(cmd) && await procDisplayIs(pid, display)) { await kill(pid, `tint2:${num}`); break; }
      if (cmd.includes(`ui-env-${num}/bus`)) { await kill(pid, `dbus:${num}`); break; }
    }
  }

  await sleep(800);
  const still = await actualHeadlessNums();
  const stillRunning = [...still].filter((n) => findSocket(n));
  return {
    ok: stillRunning.length === 0,
    available: stillRunning.length > 0,
    stopped,
    note: stillRunning.length ? `虚拟屏未完全退出（残留：${stillRunning.map((n) => `:${n}`).join("、")}）` : `已停止：${stopped.join("、") || "（无）"}`,
  };
}

/** 手动停止无头虚拟屏（Windows: 只停自管 winvnc；macOS: 无自管进程，屏幕共享是系统服务不启停；Linux: 按实际运行号）。 */
export async function stopHeadless(): Promise<{ ok: boolean; available: boolean; stopped: string[]; note?: string }> {
  if (IS_MAC) {
    const stopped = await mac.macStopHeadless();
    // 顺带停 VNC 实例 bridge（mac 实例全是「桥接系统屏幕共享」型，停了 RFB 也没了）
    for (const inst of vncInstances()) {
      try { await vncStop(inst.id); } catch { /* ignore */ }
    }
    const still = await mac.macPortListening(5900);
    return { ok: true, available: still, stopped, note: still ? "屏幕共享 VNC 5900 仍在监听（系统服务，本扩展不启停，仅桥接）" : `已停止：${stopped.join("、") || "（无自管进程；屏幕共享未开）"}` };
  }
  if (IS_WIN) {
    const stopped = await win.winStopHeadless(configDir);
    // 顺带停 VNC 实例 bridge（自管 winvnc 停了 RFB 没了，bridge 保留无意义）
    for (const inst of vncInstances()) {
      try { await vncStop(inst.id); } catch { /* ignore */ }
    }
    const still = await win.winPortListening(5900);
    return { ok: !still, available: still, stopped, note: still ? "5900 仍在监听（可能为系统 VNC，未接管不停）" : `已停止：${stopped.join("、") || "（无）"}` };
  }
  return stopHeadlessNums(await actualHeadlessNums());
}

/** 虚拟屏 openbox 菜单修复：默认菜单「Terminal emulator」调 x-terminal-emulator，
 *  而系统 alternatives 常指向 gnome-terminal.wrapper——在无 GNOME 会话的 Xvfb 里
 *  DBus 激活失败（org.gnome.Terminal status 10）→ 终端打不开。
 *  写入用户级 ~/.config/openbox/menu.xml 把 Terminal 指向 Xvfb 可跑的模拟器
 *  （xfce4-terminal 优先，缺则 xterm）。已存在配置（用户自定义）不覆盖。 */
function ensureOpenboxMenu() {
  try {
    const cfgDir = path.join(homeDir(), ".config", "openbox");
    const menuFile = path.join(cfgDir, "menu.xml");
    if (fs.existsSync(menuFile)) return;
    const term = ["xfce4-terminal", "xterm"].find((t) => fs.existsSync(`/usr/bin/${t}`) || fs.existsSync(`/usr/local/bin/${t}`)) || "xterm";
    ensureDir(cfgDir, 0o755);
    // 精简菜单：终端/浏览器/文件管理器/用户应用文件夹/应用列表。刻意不含 openbox 的
    // Restart/Exit/Reconfigure/ObConf 控制项——VNC 里误点 Exit 会直接杀掉 WM。
    const obamenu = fs.existsSync("/usr/bin/obamenu")
      ? `  <menu id="applications-menu" label="Applications" execute="/usr/bin/obamenu"/>\n`
      : "";
    const fm = fs.existsSync("/usr/bin/thunar") ? "thunar" : (fs.existsSync("/usr/bin/nautilus") ? "nautilus" : "xdg-open");
    fs.writeFileSync(menuFile, `<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.5/menu">
  <menu id="root-menu" label="Openbox 3">
    <item label="Terminal emulator">
      <action name="Execute"><execute>${term}</execute></action>
    </item>
    <item label="Web browser">
      <action name="Execute"><execute>x-www-browser</execute></action>
    </item>
    <item label="File Manager">
      <action name="Execute"><execute>${fm}</execute></action>
    </item>
    <item label="User Applications">
      <action name="Execute"><execute>${fm} ${homeDir()}/.local/share/applications</execute></action>
    </item>
${obamenu}</menu>
</openbox_menu>
`);
  } catch { /* 写失败不影响虚拟屏拉起 */ }
}

/** tint2 面板配置：tint2rc 不存在时写一份带 终端/文件管理器/浏览器 启动器的配置；
 *  已存在但 launcher 缺 终端/文件管理器 时追加（保留用户已有项，不覆盖定制）。 */
function ensureTint2Config() {
  try {
    const cfgDir = path.join(homeDir(), ".config", "tint2");
    const cfg = path.join(cfgDir, "tint2rc");
    ensureDir(cfgDir, 0o755);
    const launcherItems = [
      "launcher_item_app = xfce4-terminal.desktop",
      "launcher_item_app = thunar.desktop",
    ];
    if (!fs.existsSync(cfg)) {
      const browsers = fs.existsSync("/usr/share/applications/firefox.desktop")
        ? ["launcher_item_app = firefox.desktop"]
        : (fs.existsSync("/usr/share/applications/google-chrome.desktop") ? ["launcher_item_app = google-chrome.desktop"] : []);
      fs.writeFileSync(cfg, `# tint2 - aiti-ui-env 虚拟屏面板（自动生成；可自行定制，已存在不再覆盖）
#---- Panel ----
panel_items = LTSC
panel_size = 100% 26
panel_position = bottom center horizontal
panel_margin = 0 0
panel_padding = 2 2 2
panel_background_id = 1
panel_layer = bottom
panel_monitor = all
panel_shrink = 0
autohide = 0
#---- Launcher ----
launcher_icon_size = 22
${launcherItems.join("\n")}
${browsers.join("\n")}
#---- Taskbar ----
taskbar_mode = multi_desktop
taskbar_hide_if_empty = 0
taskbar_padding = 2 2 4
taskbar_name = 1
taskbar_icon_size = 20
#---- Systray ----
systray_padding = 0 4 2
systray_icon_size = 20
#---- Clock ----
time1_format = %H:%M
time1_font = sans 9
clock_padding = 3 2
#---- Background 1 ----
rounded = 2
border_width = 0
border_color = #000000 0
background_color = #22222e 85
`);
      return;
    }
    // 已存在：launcher 缺 终端/文件管理器 则追加（保留已有项）
    let s = fs.readFileSync(cfg, "utf8");
    const missing = launcherItems.filter((l) => !s.includes("= " + l.split("= ")[1]));
    if (!missing.length) return;
    const lines = s.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("launcher_item_app"));
    if (idx === -1) {
      const pi = lines.findIndex((l) => l.startsWith("panel_items"));
      lines.splice(pi + 1, 0, ...missing);
    } else {
      lines.splice(idx, 0, ...missing);
    }
    fs.writeFileSync(cfg, lines.join("\n"));
  } catch { /* 配置写失败不影响面板拉起 */ }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function execFilePromise(cmd: string, args: string[], timeoutMs: number): Promise<{ err: Error | null; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => resolve({ err, out: String(stdout) }));
  });
}

// ─────────────────────────── 运行（detached） ───────────────────────────

let runSeq = 0;

export async function run(cmd: string, opts: { prefer?: UeTarget; env?: Record<string, string> } = {}): Promise<RunResult> {
  const resolved = await resolve(opts.prefer, true);
  if (!resolved.ok || !resolved.target) {
    return { ok: false, error: resolved.error || "resolve 失败", hint: resolved.hint };
  }
  const env = { ...process.env, ...resolved.env, ...(opts.env || {}) };
  const logDir = cachePath("logs");
  ensureDir(logDir, 0o755);
  const logFile = path.join(logDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${++runSeq}.log`);
  const out = fs.openSync(logFile, "a");
  try {
    const [shell, shellArgs] = IS_WIN
      ? ["cmd.exe", ["/d", "/s", "/c", cmd]]
      : ["/bin/sh", ["-c", cmd]];
    const child = spawn(shell, shellArgs, {
      env, detached: true, stdio: ["ignore", out, out], cwd: process.cwd() || homeDir(),
      windowsHide: IS_WIN, // 隐藏 cmd 控制台窗；GUI 子进程窗口不受影响
    } as any);
    child.unref();
    const warnings = resolved.warnings.length ? resolved.warnings : undefined;
    return { ok: true, pid: child.pid, cmd, target: resolved.target, env, logFile, warnings };
  } finally {
    fs.closeSync(out); // spawn 同步抛异常（参数非法等）也释放 fd
  }
}

// ─────────────────────────── VNC ───────────────────────────

export interface VncState {
  displayNum: number;
  vncPort: number;
  webPort: number;
  tcpRunning: boolean;
  webRunning: boolean;
  webUrl: string;
  noVncDir: string | null;
  command: string;
}

/** VNC 会话票据（无状态签名 ts.hmac(token, ts)，30 分钟）——经 Set-Cookie 下发（HttpOnly），
 *  URL 无任何凭据；middleware 与 vnc-bridge 用同一 secret 双层校验（签名算法见下/桥）。 */
export const VNC_SESSION_TTL_MS = 30 * 60 * 1000;

export function makeVncSession(): string {
  const ts = Date.now().toString(36);
  const sig = createHmac("sha256", vncToken()).update("vnc-session:" + ts).digest("hex");
  return `${ts}.${sig}`;
}

export function validVncSession(sess: string | null): boolean {
  const tok = vncToken();
  if (tok === "") return true; // 关闭校验
  if (!sess) return false;
  const i = sess.lastIndexOf(".");
  if (i <= 0) return false;
  const ts = sess.slice(0, i), sig = sess.slice(i + 1);
  if (!/^[a-z0-9]+$/.test(ts)) return false;
  const age = Date.now() - parseInt(ts, 36);
  if (!Number.isFinite(age) || age < -5000 || age > VNC_SESSION_TTL_MS) return false;
  const expect = createHmac("sha256", tok).update("vnc-session:" + ts).digest("hex");
  if (sig.length !== expect.length) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expect, "hex"));
}

/** VNC 访问令牌（capability secret，非用户体系）：env UI_ENV_VNC_TOKEN 优先，
 *  否则 configDir/vnc-token 持久化自动生成；空串 = 关闭校验（仅限可信内网）。 */
export function vncToken(): string {
  const envT = process.env.UI_ENV_VNC_TOKEN;
  if (envT !== undefined && envT !== null) return envT;
  const file = path.join(configDir, "vnc-token");
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    const t = randomBytes(16).toString("hex");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  } catch {
    return "";
  }
}

export function validVncToken(t: string | null): boolean {
  const tok = vncToken();
  if (tok === "") return true; // 关闭校验
  return !!t && t === tok;
}

/** 无头虚拟屏的 VNC web 端口（内部 loopback 专用；对外访问走 middleware 代理） */
export function vncWebPort(): number { return envNumber("UI_ENV_VNC_WEB_PORT", 6080); }

// ── 系统 VNC 探测：接入/查看/管理系统里已有的 VNC server（x11vnc/vncserver，含真实桌面） ──

export interface SysVncEntry {
  id: string;        // "sys-<pid>" 或 "port-<p>"
  kind: string;      // x11vnc | vncserver | unknown
  display: string;   // :N
  port: number;      // RFB 端口
  pid?: number;
  ours: boolean;     // 本扩展自管（自动排除，不列入）
  stoppable: boolean;// 是否由本用户控制（可停止）
  listening: boolean;// 端口是否真的在监听（-loop 父进程等可能进程在但端口无监听 → 不可连）
  cmd?: string;
  passwordResettable?: boolean; // 本扩展能否重设该 VNC server 密码（不能时看 passwordNote）
  passwordNote?: string;        // 不能重设的原因 / 重设后的生效条件
}

/** 探测系统 VNC server：Linux= x11vnc/Xvnc 进程 + 5900-5910；macOS= screensharingd/ARDAgent + 5900-5910；
 *  Windows= winvnc/tvnserver 进程 + 5900。本扩展自启的进程自动排除。 */
/** RFB 常用端口段（5900-5999）的实际监听 pid：ss -tlnp 解析成 端口→pid[]。
 *  系统 VNC 探测用：x11vnc 无 -rfbport 时取「5900 起第一个空闲端口」，不能按 5900+displayNum 瞎猜。 */
async function rfbPortsToPids(): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  const out = await runCmd("ss", ["-tlnp"]).catch(() => "");
  for (const line of out.split("\n")) {
    const pm = line.match(/:(\d+)\s/);
    if (!pm) continue;
    const port = Number(pm[1]);
    if (port < 5900 || port > 5999) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const list = map.get(port) || [];
      list.push(Number(m[1]));
      map.set(port, list);
    }
  }
  return map;
}

export async function systemVncScan(): Promise<SysVncEntry[]> {
  if (IS_WIN) return win.winSystemVncScan(configDir);
  if (IS_MAC) return mac.macSystemVncScan();
  const out = await runCmd("ps", ["-eo", "pid,user,args"]).catch(() => "");
  const list: SysVncEntry[] = [];
  const seenPorts = new Set<number>();
  const portPids = await rfbPortsToPids(); // pid → 实际监听端口（x11vnc 无 -rfbport 时不能按 5900+displayNum 瞎猜）
  const portOfPid = (pid: number): number | null => {
    for (const [port, pids] of portPids) if (pids.includes(pid)) return port;
    return null;
  };
  const push = (e: SysVncEntry) => {
    if (e.ours) return; // 本扩展自管的排除
    if (seenPorts.has(e.port)) return;
    seenPorts.add(e.port);
    list.push(e);
  };
  const pushVerified = async (e: SysVncEntry) => {
    e.listening = e.port > 0 && (await portListening(e.port)); // -loop 父进程等：进程在但端口可能没监听 → 不可连
    push(e);
  };
  for (const line of out.split("\n").filter(Boolean)) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]); const user = m[2]; const cmd = m[3].trim();
    const prog = (cmd.split(/\s+/)[0] || "").split("/").pop(); // 程序名（排除 bash -c 包装误报）
    if (prog === "bash" || prog === "sh" || prog === "ps" || prog === "grep") continue;
    const ours = cmd.includes("/tmp/ui-env-");
    if (prog === "x11vnc") {
      const display = (cmd.match(/-display\s+(:\d+)/) || [])[1] || ":?";
      const rfb = (cmd.match(/-rfbport\s+(\d+)/) || [])[1];
      // 无 -rfbport 时 x11vnc 取「5900 起第一个空闲端口」——以 ss 实际监听 pid 为准；
      // 猜 5900+displayNum 会把别的进程（如 QEMU 虚拟机 VNC）的端口误认成它的（2026-09-15 修）。
      const actual = portOfPid(pid);
      // -loop 监督父进程自己不监听（监听的是它 spawn 的子进程）——跳过，只报真正监听的那一个
      if (!rfb && actual == null && /(^|\s)-loop(\s|$)/.test(cmd)) continue;
      const port = rfb ? Number(rfb) : (actual ?? (display !== ":?" ? 5900 + Number(display.slice(1) || 0) : 0));
      const rfbauth = (cmd.match(/-rfbauth\s+(\S+)/) || [])[1] || "";
      await pushVerified({
        id: "sys-" + pid, kind: "x11vnc", display, port, pid, ours, stoppable: user === process.env.USER, cmd: cmd.slice(0, 110),
        passwordResettable: !!rfbauth,
        passwordNote: rfbauth
          ? `写密码文件 ${rfbauth}（标准 vncpasswd 格式）；需重启该 x11vnc 后生效`
          : (/(^|\s)-passwd(\s|$)/.test(cmd)
            ? "该 x11vnc 用 -passwd 明文参数启动，改密码需改启动命令后重启"
            : "该 x11vnc 未使用密码文件（无 -rfbauth），无密码可重设；如需密码请以其启动配置为准"),
      });
      continue;
    }
    if (prog && (prog.startsWith("Xvnc") || prog.startsWith("Xtightvnc") || prog.startsWith("Xtigervnc")) && /:\d+/.test(cmd)) {
      const display = (cmd.match(/(?:\s)(:\d+)/) || [])[1] || ":?";
      const dnum = Number(String(display).slice(1) || 0);
      await pushVerified({ id: "sys-" + pid, kind: "vncserver", display, port: portOfPid(pid) ?? 5900 + dnum, pid, ours: false, stoppable: user === process.env.USER, cmd: cmd.slice(0, 110),
        passwordResettable: user === process.env.USER,
        passwordNote: user === process.env.USER
          ? "写 ~/.vnc/passwd（标准 vncpasswd 格式）；重启该 vncserver 会话后生效"
          : `该 vncserver 属用户 ${user}，非当前用户，无权限改` });
    }
  }
  // 监听 5900-5910 的未识别 VNC（进程没匹配到）
  for (let p = 5900; p <= 5910; p++) {
    if (await portListening(p) && !seenPorts.has(p)) {
      await pushVerified({ id: "port-" + p, kind: "unknown", display: `:${p - 5900}`, port: p, ours: false, stoppable: false,
        passwordResettable: false, passwordNote: "未识别到已知 VNC server 进程（可能是其它实现），密码请在其自身配置里改" });
    }
  }
  return list;
}

// ── VNC 多实例管理：每次启动随机端口，注册表持久化（跨 reload 恢复，pid 可追踪） ──

export interface VncInstance {
  id: string;            // "default"（首实例）或 "v<ts>"（附加实例）或 "sys-<ts>"（系统 VNC 实例）
  token?: string;        // 真随机 opaque 实例令牌：URL 路径段，代表该实例/端口（不落目标地址）；定期轮换
  prevToken?: string;    // 轮换前的令牌（宽限期内仍可路由，旧 URL 不立即失效）
  displayNum: number;    // 服务哪个虚拟屏（x11vnc -display :N）；sys 实例为 0（无关联虚拟屏）
  rfbPort: number;       // x11vnc RFB 端口（随机）；sys 实例 = 系统 VNC 的目标端口
  webPort: number;       // vnc-bridge 端口（随机，避免与其他服务冲突）
  x11vncPid?: number;
  bridgePid?: number;    // node vnc-bridge（自写，零依赖）
  createdAt: string;
  sys?: { host: string; port: number; label: string }; // 系统 VNC（非本扩展自启）：bridge 直连 host:port（本机=127.0.0.1）
}

function instancesFile(): string { return cachePath("vnc-instances.json"); }

function loadInstances(): Record<string, VncInstance> {
  try { return JSON.parse(fs.readFileSync(instancesFile(), "utf8")).instances || {}; } catch { return {}; }
}
function saveInstances(ins: Record<string, VncInstance>): void {
  try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(instancesFile(), JSON.stringify({ instances: ins }, null, 2)); } catch { /* 写失败不致命 */ }
}

/** pid 是否存活（SIGTERM 未决） */
function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// 并发 start 竞态锁：两个请求同时建 default → 后写覆盖、前者孤儿。
let vncCreateLock: Promise<unknown> | null = null;

/** systemd 服务模式（install-service.sh 固定 5900/6080 + node vnc-bridge）合成只读条目：
 *  注册表为空（服务模式）时，status/middleware 仍能看到并路由 legacy 端口。 */
function legacyVnc(): VncInstance {
  return { id: "systemd", displayNum: envDisplayNum(), rfbPort: envNumber("UI_ENV_VNC_PORT", 5900), webPort: vncWebPort(), createdAt: "" };
}
async function legacyVncRunning(): Promise<boolean> {
  const [tcp, web] = await Promise.all([portListening(envNumber("UI_ENV_VNC_PORT", 5900)), portListening(vncWebPort())]);
  return tcp || web;
}

/** 随机空闲端口（避免与其他服务冲突；顺序扫描兜底） */
export async function pickFreePort(min: number, max: number): Promise<number> {
  for (let i = 0; i < 12; i++) {
    const p = min + Math.floor(Math.random() * (max - min));
    if (!(await portListening(p))) return p;
  }
  for (let p = min; p < max; p++) if (!(await portListening(p))) return p;
  throw new Error(`端口范围 ${min}-${max} 无空闲`);
}

// ── 实例令牌（真随机 opaque，URL 路径段代表实例/端口；不落目标地址）──

/** 已用令牌集合（含两类型全部实例的 token + prevToken，避免跨类型碰撞） */
function usedInstanceTokens(): Set<string> {
  const used = new Set<string>();
  for (const i of [...Object.values(loadInstances()), ...Object.values(loadRdpInstances())]) {
    if (i.token) used.add(i.token);
    if (i.prevToken) used.add(i.prevToken as string);
  }
  return used;
}

/** 生成真随机实例令牌（24B → 32 字符 base64url ≈ 192bit 熵；碰撞检查兜底，超限则带时间戳后缀） */
export function genInstanceToken(): string {
  const used = usedInstanceTokens();
  for (let i = 0; i < 64; i++) {
    const t = randomBytes(24).toString("base64url");
    if (!used.has(t)) return t;
  }
  return randomBytes(24).toString("base64url") + "." + Date.now().toString(36);
}

/** 兼容迁移：存量实例无 token → 补发（幂等，只写有变更时保存） */
export function ensureInstanceTokens(kind: "vnc" | "rdp"): void {
  const load = kind === "vnc" ? loadInstances : loadRdpInstances;
  const save = kind === "vnc" ? saveInstances : saveRdpInstances;
  const ins = load();
  const used = usedInstanceTokens();
  let changed = false;
  for (const i of Object.values(ins)) {
    if (!i.token) { i.token = genInstanceToken(); used.add(i.token); changed = true; }
  }
  if (changed) save(ins);
}

/** 按令牌查实例（token 或 prevToken；路由用，免探活） */
export function vncInstanceByToken(token: string): VncInstance | null {
  const t = String(token || "");
  if (!t) return null;
  ensureInstanceTokens("vnc");
  for (const i of Object.values(loadInstances())) {
    if (i.token === t || i.prevToken === t) return i;
  }
  return null;
}
export function rdpInstanceByToken(token: string): RdpInstance | null {
  const t = String(token || "");
  if (!t) return null;
  ensureInstanceTokens("rdp");
  for (const i of Object.values(loadRdpInstances())) {
    if (i.token === t || i.prevToken === t) return i;
  }
  return null;
}

/** 轮换某类型全部实例令牌（真随机、防碰撞）；旧令牌移入 prevToken 宽限（≤1 个轮换周期仍可路由）。 */
export function rotateInstanceTokens(kind: "vnc" | "rdp"): number {
  const load = kind === "vnc" ? loadInstances : loadRdpInstances;
  const save = kind === "vnc" ? saveInstances : saveRdpInstances;
  ensureInstanceTokens(kind);
  const ins = load();
  const used = usedInstanceTokens();
  let n = 0;
  for (const i of Object.values(ins)) {
    if (!i.token) continue;
    const nt = genInstanceToken();
    used.add(nt);
    i.prevToken = i.token;
    i.token = nt;
    n++;
  }
  if (n) save(ins);
  return n;
}

export function vncInstance(id: string): VncInstance | null {
  return loadInstances()[id] || null;
}

/** 同步查表（middleware 用——不在请求链路里 spawn ss 探测，避免挂起/性能问题）；
 *  legacy（systemd 服务模式）兼容由 middleware 层用 fetch 探活。 */
export function vncInstanceSync(id: string): VncInstance | null {
  ensureInstanceTokens("vnc");
  return loadInstances()[id] || null;
}

export function vncInstances(): VncInstance[] {
  ensureInstanceTokens("vnc");
  return Object.values(loadInstances());
}

function defaultInstanceId(): string {
  const ins = loadInstances();
  if (ins["default"]) return "default";
  const first = Object.keys(ins)[0];
  return first || "default";
}

async function safeSpawnBin(bin: string, args: string[], envExtra: Record<string, string> = {}): Promise<number | null> {
  const exe = IS_UNIX
    ? await resolveBin(bin)
    : (bin === "node" ? process.execPath : await resolveBin(bin)); // Windows: node 用当前运行时进程
  if (!exe) return null;
  try {
    // 子进程日志 → configDir/logs（跨平台路径；诊断 WS 断连等用）
    let stdio: any = "ignore";
    let logFd: number | undefined;
    try {
      const fsMod = await import("node:fs");
      const logDir = configDir ? cachePath("logs") : ".";
      try { fsMod.mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
      logFd = fsMod.openSync(path.join(logDir, `bridge-${bin}-${envExtra.UI_ENV_RDP_WEB_PORT ?? envExtra.UI_ENV_VNC_WEB_PORT ?? Date.now()}.log`), "a");
      stdio = ["ignore", logFd, logFd];
    } catch { /* fall back to ignore */ }
    const p = spawn(exe, args, { detached: true, stdio, env: { ...process.env, ...envExtra } });
    p.on("error", () => { /* 二进制缺失等：忽略，由端口重探判定 */ });
    p.unref();
    return p.pid ?? null;
  } catch { return null; }
}

/** 创建/启动 VNC 实例：随机 RFB + Web 端口；x11vnc（若 display 有 X）+ vnc-bridge。
 *  id 缺省 = 首实例 "default"；已存在且真活着（bridge pid 存活 + web 端口在跑）→ 复用（幂等）。
 *  并发 start 用进程内锁串行（防双建覆盖/孤儿）。 */
export async function vncCreate(id: string | undefined, displayNum = envDisplayNum(), opts: { sysPort?: number; sysHost?: string; sysLabel?: string } = {}): Promise<VncInstance> {
  while (vncCreateLock) { try { await vncCreateLock; } catch { /* 忽略锁内错误 */ } }
  let release!: () => void;
  vncCreateLock = new Promise((r) => (release = r));
  try {
    // macOS：无自管 VNC server —— 非 sys 实例自动转「桥接系统屏幕共享」（127.0.0.1:5900，
    // UI_ENV_VNC_PORT 可覆盖）；RFB 认证 = mac 账号密码（noVNC 凭据层输入，见 docs/aiti-ui-env-macos-support-plan.md）。
    if (IS_MAC && !opts.sysPort) {
      opts.sysPort = envNumber("UI_ENV_VNC_PORT", 5900);
      opts.sysHost = "127.0.0.1";
      opts.sysLabel = "screensharing";
    }
    const isSys = !!opts.sysPort;
    const sysHost = isSys ? (opts.sysHost && opts.sysHost.trim() ? opts.sysHost.trim() : "127.0.0.1") : "127.0.0.1";
    const ins = loadInstances();
    const instId = id || (Object.keys(ins).length === 0 ? "default" : "v" + Date.now().toString(36));
    // 防重复：同一外部/系统 VNC 目标（host:port）已有一个活桥 → 复用，别再加一个新实例
    if (isSys && opts.sysPort) {
      // find() callback can't be async (await in non-async arrow = ParseError,
      // and find() treats a returned Promise as truthy). Use a for-loop so
      // await portListening resolves correctly before deciding to reuse.
      let dup: VncInstance | undefined;
      for (const i of Object.values(ins)) {
        if (i.sys && i.sys.host === sysHost && i.sys.port === opts.sysPort &&
          pidAlive(i.bridgePid) && (await portListening(i.webPort))) {
          dup = i;
          break;
        }
      }
      if (dup) return dup;
    }
    const existing = ins[instId];
    // 复用条件从严：bridge pid 存活 + web 端口在跑（端口被别的服务占时不能误复用）。
    // 僵尸防护：实例存在且 web 正常，但虚拟屏可用而其 x11vnc 缺失/RFB 断（早期版本在虚拟屏
    // 未启动时创建的实例只有 bridge 没有 x11vnc）→ 强制重建，否则 noVNC 连不上 RFB 桌面白屏。
    if (existing && pidAlive(existing.bridgePid) && (await portListening(existing.webPort))) {
      if (isSys) return existing; // 系统 VNC 实例：bridge 活着即可复用
      const x11Ok = existing.x11vncPid ? pidAlive(existing.x11vncPid) : false;
      const rfbOk = await portListening(existing.rfbPort);
      // rfbPort===0（历史 bug：Linux 分支漏随机分配 → x11vnc -rfbport 0 不监听 TCP）无条件判坏重建；
      // 其余：虚拟屏在而 x11vnc 缺失/RFB 断 = 僵尸实例。
      const zombie = existing.rfbPort === 0 || (findSocket(existing.displayNum) && !x11Ok && !rfbOk);
      if (!zombie) return existing;
    }
    if (existing) {
      // 重建前先回收旧进程（防止 x11vnc 活着但 bridge 死了的孤儿）
      for (const pid of [existing.x11vncPid, existing.bridgePid]) {
        if (pidAlive(pid)) { try { process.kill(pid!, "SIGTERM"); } catch { /* ignore */ } }
      }
    }

    // sys 实例：RFB 直连系统端口（不随机、不起 x11vnc）；否则随机端口 + 起 x11vnc。
    // Windows：自管 winvnc 固定 RFB 5900（回环+随机密码 VNCAuth），无 x11vnc。
    // 虚拟屏未启动先自动拉起（幂等）——否则 x11vnc 无 X 可连，RFB 起了也看不了。
    let rfbPort = isSys ? opts.sysPort! : 0;
    let webPort = 0;
    let noVncDir: string;
    if (!isSys) {
      if (IS_WIN) {
        rfbPort = envNumber("UI_ENV_VNC_PORT", 5900);
        await win.winVncEnsure(configDir); // 幂等：杀旧写 ini（随机密码）起新，pid 文件记录
      } else {
        if (!findSocket(displayNum)) await ensureHeadless();
        // 随机 RFB 端口（5901-5999，避开 5900 gdm/桌面 x11vnc；portListening 防撞车）。
        // 不分配会以 -rfbport 0 启动 → x11vnc 不监听 TCP，noVNC 永远连不上。
        rfbPort = await pickFreePort(5901, 5999);
      }
      webPort = await pickFreePort(6000, 6300);
      noVncDir = findNoVncDir() || cachePath("novnc");
      ensureDir(noVncDir, 0o755);
    } else {
      webPort = await pickFreePort(6000, 6300);
      noVncDir = findNoVncDir() || cachePath("novnc");
      ensureDir(noVncDir, 0o755);
    }
    const inst: VncInstance = { id: instId, token: genInstanceToken(), displayNum, rfbPort, webPort, createdAt: new Date().toISOString() };
    if (isSys) inst.sys = { host: sysHost, port: opts.sysPort!, label: opts.sysLabel || "sys" };

    if (!isSys && !IS_WIN) {
      // x11vnc：只回环 + -auth（与 Xvfb 同 cookie）；随机 rfbport 避开 gdm/桌面实例。
      // X11VNC_AVOID_WINDOWS=never：跳过「等显示器管理器消失再建 selection 窗口」的启发式
      // （默认客户端连上后要等 8~45s 才建 selwin，此窗口内客户端 ClientCutText 被静默丢弃
      //  → 查看页「发送到远程」刚打开就发会失败；本扩展的虚拟屏无 DM，立即建窗无副作用）。
      if (findSocket(displayNum)) {
        const auth = stTmpAuth(displayNum);
        const pid = await safeSpawnBin("x11vnc", ["-display", `:${displayNum}`, "-forever", "-shared", "-rfbport", String(rfbPort), "-localhost", ...(auth ? ["-auth", auth] : [])], { X11VNC_AVOID_WINDOWS: "never" });
        if (pid) inst.x11vncPid = pid;
      }
    }
    if (!isSys && IS_WIN) {
      // 自管 winvnc 的 pid 进实例（复用 x11vncPid 字段）；起失败留给 probeHeadless 报告
      const selfPid = win.winVncSelfPid(configDir);
      if (selfPid) inst.x11vncPid = selfPid;
    }
    // vnc-bridge（认证固化协议：cookie 会话；token 经 env 不落 URL/命令行）。
    // Windows/自管 winvnc：密码写在 ultravnc.ini 里由 VNC server 自己认证；桥**不做任何
    // RFB 代答/协议改写**，只做纯转发 + ws cookie 会话（浏览器 noVNC 自己弹密码框）。
    const bridge = cachePath("vnc-bridge.mjs");
    if (fs.existsSync(bridge)) {
      const bridgeEnv: Record<string, string> = {
        UI_ENV_VNC_TOKEN: vncToken(), UI_ENV_VNC_WEB_PORT: String(webPort),
        UI_ENV_VNC_PORT: String(rfbPort), UI_ENV_NOVNC_DIR: noVncDir!,
        UI_ENV_VNC_HOST: sysHost,
      };
      const pid = await safeSpawnBin("node", [bridge], bridgeEnv);
      if (pid) inst.bridgePid = pid;
    }
    ins[instId] = inst;
    saveInstances(ins);
    await sleep(700);
    return inst;
  } finally {
    vncCreateLock = null;
    release();
  }
}

/** 停止实例：杀进程 + 移除注册（systemd unit 若安装则一并停）
 *  target=systemd（服务模式合成条目）→ 只停 unit，不删注册表（合成条目不在表里）。 */
export async function vncStop(id?: string): Promise<{ ok: boolean; message: string }> {
  const ins = loadInstances();
  const target = id || defaultInstanceId();
  const inst = ins[target];
  if (target === "systemd") {
    await stopSystemdUnit();
    return { ok: true, message: "systemd 服务模式实例已请求停止（ui-env-vnc unit）" };
  }
  if (!inst) return { ok: true, message: `实例 ${target} 不存在（无操作）` };
  for (const pid of [inst.x11vncPid, inst.bridgePid]) {
    if (pidAlive(pid)) { try { process.kill(pid!, "SIGTERM"); } catch { /* 已退出 */ } }
  }
  if (target === "default") await stopSystemdUnit();
  delete ins[target];
  saveInstances(ins);
  return { ok: true, message: `实例 ${target} 已停止（RFB :${inst.rfbPort} / Web :${inst.webPort}）` };
}

/** 停 systemd unit（若安装） */
async function stopSystemdUnit(): Promise<void> {
  if (fs.existsSync(`${homeDir()}/.config/systemd/user/ui-env-vnc.service`) || fs.existsSync("/etc/systemd/system/ui-env-vnc.service")) {
    const args = fs.existsSync(`${homeDir()}/.config/systemd/user/ui-env-vnc.service`) ? ["--user", "stop", "ui-env-vnc"] : ["stop", "ui-env-vnc"];
    await execFilePromise("systemctl", args, 8000);
  }
}

/** 实例状态（含存活探测） */
async function instanceLive(inst: VncInstance): Promise<VncInstance & { tcp: boolean; web: boolean }> {
  const [tcp, web] = await Promise.all([portListening(inst.rfbPort), portListening(inst.webPort)]);
  // 外部 VNC（sys host 非回环）：目标端口不在本机，tcp 以「桥在跑」为准（bridge 转发即代表已连通）
  const tcpLive = (inst.sys && inst.sys.host && inst.sys.host !== "127.0.0.1" && inst.sys.host !== "localhost")
    ? web : tcp;
  return { ...inst, tcp: tcpLive, web };
}

/** 清理死实例（startup/重启后调用）：进程不活或端口不通 → 移除注册，避免 middleware 代理到死端口。 */
export async function vncPrune(): Promise<number> {
  const ins = loadInstances();
  let removed = 0;
  for (const [id, inst] of Object.entries(ins)) {
    const alive = (pidAlive(inst.x11vncPid) || pidAlive(inst.bridgePid)) && ((await portListening(inst.webPort)) || (await portListening(inst.rfbPort)));
    if (!alive) {
      delete ins[id];
      removed++;
    }
  }
  if (removed) saveInstances(ins);
  return removed;
}

// ── 剪贴板直读/直写（view.html「获取远程 / 发送到远程」按钮）──
// 为什么不只走 VNC 协议通道（协议本身有硬伤，实测 2026-09-15）：
//   远程→本地：x11vnc 只在剪贴板「变化」时 push（ServerCutText），页面后连接/同内容重拷都收不到；
//   本地→远程：① x11vnc 客户端连接后约 8s（selwin 未创建）内收到的 ClientCutText 被静默丢弃
//             ② 服务器未声明扩展剪贴板时只能走 Latin-1 旧通道，中文/emoji 全变 '?'
//             ③ QEMU 虚拟机 VNC 无 guest 代理（vdagent）时数据在 QEMU 里悬空，客户机永远收不到
// 本机 X 会话/本机系统剪贴板能直读直写就直做（xclip / Get-Clipboard / pbpaste·pbcopy）；
// 目标不是本机 X 会话（QEMU 虚拟机、远程主机）时明确报错，客户端回退 VNC 协议或改用「⌨ 输入到远程」。

/** 读 Linux X 剪贴板：CLIPBOARD 优先（Ctrl+C），空/无所有者回退 PRIMARY（中键复制）。null = 两者都读不到。
 *  xclip 无 -auth 选项，认证经 XAUTHORITY env 传入；无 auth 时显式剔除（残留 cookie 会连无鉴权 X 都被拒）。 */
async function readXClipboard(display: string, auth?: string | null): Promise<string | null> {
  if (!/^:\d+$/.test(display)) return null;
  const env: Record<string, string | undefined> = { ...process.env, DISPLAY: display };
  if (auth) env.XAUTHORITY = auth; else delete env.XAUTHORITY;
  for (const sel of ["clipboard", "primary"]) {
    const text = await new Promise<string | null>((resolve) => {
      execFile("xclip", ["-selection", sel, "-o"], { timeout: 3000, encoding: "utf8", maxBuffer: 1 << 20, env },
        (err: Error | null, stdout: unknown) => resolve(err ? null : String(stdout ?? "")));
    });
    if (text) return text;
  }
  return null;
}

/** 找出本机监听指定 RFB 端口的 x11vnc/Xvnc 进程并解析其 -display/-auth（系统 VNC 实例用）：
 *  x11vnc 缺省端口不能从 display 号推出（默认从 5900 起找空闲口），以 ss -tlnp 的监听 pid 为准再读 /proc 命令行。 */
async function findXServerByRfbPort(port: number): Promise<{ display: string; auth?: string } | null> {
  const out = await runCmd("ss", ["-tlnp"]).catch(() => "");
  const pids = new Set<number>();
  for (const line of out.split("\n")) {
    if (!new RegExp(`:${port}\\s`).test(line)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
  }
  for (const pid of pids) {
    let cmd = "";
    try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { continue; }
    if (!/(^|\/)(x11vnc|Xvnc|Xtigervnc|Xtightvnc)(\s|$)/.test(cmd)) continue;
    const toks = cmd.split(/\s+/);
    let display = "";
    let auth: string | undefined;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i] === "-display" && toks[i + 1]) display = toks[i + 1];
      if (toks[i] === "-auth" && toks[i + 1]) auth = toks[i + 1];
      if (!display && /^:\d+$/.test(toks[i])) display = toks[i]; // Xvnc 的位置参数式 display
    }
    if (display) return { display, auth };
  }
  return null;
}

/** 实例目标是否在本机（sys 实例可指向远程主机；本机才谈得上服务端直读直写） */
function instanceIsLocal(inst: VncInstance): boolean {
  return !inst.sys || !inst.sys.host || ["127.0.0.1", "localhost", "::1"].includes(inst.sys.host);
}

/** 按 token/id 定位实例（三者依次：当前 token → 实例 id → 历史 systemd 合成条目） */
function clipboardInstance(tokenOrId: string): VncInstance | null {
  const key = String(tokenOrId || "").trim();
  if (!key) return null;
  return vncInstanceByToken(key) || vncInstanceSync(key) || (key === "systemd" ? legacyVnc() : null);
}

/** 本机 X 剪贴板目标（display + XAUTHORITY）：自管实例用 displayNum；sys 实例以 RFB 端口反查监听进程。
 *  空数组 = 不是本机 X 会话（QEMU 虚拟机 / 远程主机 / 无 X），服务端直读直写不可用。 */
async function xClipboardTargets(inst: VncInstance): Promise<{ display: string; auth?: string | null }[]> {
  const attempts: { display: string; auth?: string | null }[] = [];
  if (inst.displayNum > 0) attempts.push({ display: `:${inst.displayNum}`, auth: stTmpAuth(inst.displayNum) });
  const scanned = await findXServerByRfbPort(inst.rfbPort);
  if (scanned) attempts.push(scanned);
  return attempts;
}

/** RFB 端口监听进程名（诊断用）：x11vnc / Xvnc / qemu-system-aarch64 / …；找不到返回 null。
 *  优先 /proc/pid/cmdline 首段（comm 会被截到 15 字符，如 qemu-system-aar）。 */
async function rfbPortOwner(port: number): Promise<string | null> {
  const out = await runCmd("ss", ["-tlnp"]).catch(() => "");
  for (const line of out.split("\n")) {
    if (!new RegExp(`:${port}\\s`).test(line)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      try {
        const cmdline = fs.readFileSync(`/proc/${m[1]}/cmdline`, "utf8").split("\0")[0].trim();
        if (cmdline) return path.basename(cmdline);
      } catch { /* 进程已退出：继续 */ }
      try {
        const comm = fs.readFileSync(`/proc/${m[1]}/comm`, "utf8").trim();
        if (comm) return comm;
      } catch { /* 进程已退出：继续 */ }
    }
  }
  return null;
}

/** 服务端直读/直写不可用时的诊断文案：说清目标是什么、为什么不行、可用什么替代。 */
async function clipboardUnavailable(inst: VncInstance, verb: string): Promise<string> {
  const owner = await rfbPortOwner(inst.rfbPort);
  if (owner && /^qemu-system/.test(owner)) {
    return `目标 VNC 由 ${owner}（虚拟机，无本机 X 会话）提供：机内剪贴板需 guest 代理（vdagent）支持，服务端无法${verb}`;
  }
  return `目标 VNC 不是本机 X 会话（${owner || "未知监听进程"}），服务端无法${verb}`;
}

/** 写 Linux X 剪贴板（xclip -in）：xclip 读入 stdin 后 fork 后台进程持有 selection（父进程立即退出），
 *  所以这里把文本写进 stdin 即可，不等 daemon；返回 ok 表示 xclip 已启动并交给它。 */
async function writeXClipboard(display: string, auth: string | null | undefined, text: string): Promise<boolean> {
  if (!/^:\d+$/.test(display)) return false;
  const env: Record<string, string | undefined> = { ...process.env, DISPLAY: display };
  if (auth) env.XAUTHORITY = auth; else delete env.XAUTHORITY;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => { if (!settled) { settled = true; resolve(ok); } };
    try {
      const p = spawn("xclip", ["-selection", "clipboard", "-in"], { env, stdio: ["pipe", "ignore", "ignore"], detached: true });
      p.on("error", () => done(false));
      p.on("exit", (code) => done(code === 0));
      try { p.stdin.on("error", () => { /* 进程提前退出等 */ }); p.stdin.end(text, "utf8"); } catch { done(false); }
      setTimeout(() => done(true), 2000); // 兜底：selection 已写入但 exit 事件迟迟不来（个别 xclip/发行版）
      p.unref();
    } catch { done(false); }
  });
}

/** 读指定 VNC 实例目标桌面的当前剪贴板（按 token 或 id 定位实例）。
 *  Linux=直读目标 X display；Windows=Get-Clipboard；macOS=pbpaste（自管 winvnc/屏幕共享服务的就是系统剪贴板）。
 *  sys 实例指向远程主机时无法代读，明确报错。 */
export async function vncClipboardRead(tokenOrId: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const inst = clipboardInstance(tokenOrId);
  if (!inst) return { ok: false, error: "未知 VNC 实例（token/id 无效或已轮换过期）" };
  if (!instanceIsLocal(inst)) {
    return { ok: false, error: `目标 VNC 在远程主机 ${inst.sys!.host}，服务端无法直读其剪贴板` };
  }

  if (IS_WIN) {
    const out = await win.winPwsh("(Get-Clipboard -Raw)", 5000);
    return out ? { ok: true, text: out.replace(/\r?\n$/, "") } : { ok: false, error: "Get-Clipboard 为空或读取失败" };
  }
  if (IS_MAC) {
    const r = await mac.macExec("pbpaste", [], 5000);
    return r.code === 0 && r.out ? { ok: true, text: r.out } : { ok: false, error: "pbpaste 为空或读取失败" };
  }

  const attempts = await xClipboardTargets(inst);
  if (!attempts.length) return { ok: false, error: `读取失败：${await clipboardUnavailable(inst, "直读")}（可改用查看页「⌨ 输入到远程」）` };
  for (const a of attempts) {
    const text = await readXClipboard(a.display, a.auth);
    if (text !== null) return { ok: true, text };
  }
  return { ok: false, error: "读取失败：xclip 缺失、剪贴板为空，或该 X 会话无访问权限" };
}

/** 写指定 VNC 实例目标桌面的剪贴板（view.html「发送到远程」主通道）：
 *  本机 X → xclip 直写 CLIPBOARD（Unicode 安全、无 x11vnc selwin 8s 窗口、QEMU 等无 X 目标明确报错）；
 *  Windows=Set-Clipboard；macOS=pbcopy。失败时客户端回退 noVNC 协议通道。
 *  说明：只写 CLIPBOARD（Ctrl+V）；不写 PRIMARY（Linux 中键粘贴）——避免把远程主选择区搅乱。 */
export async function vncClipboardWrite(tokenOrId: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const inst = clipboardInstance(tokenOrId);
  if (!inst) return { ok: false, error: "未知 VNC 实例（token/id 无效或已轮换过期）" };
  const value = String(text == null ? "" : text);
  if (!value) return { ok: false, error: "剪贴板内容为空" };
  if (value.length > 1 << 20) return { ok: false, error: `内容过大（${value.length} 字符，上限 1048576）` };
  if (!instanceIsLocal(inst)) {
    return { ok: false, error: `目标 VNC 在远程主机 ${inst.sys!.host}，服务端无法直写其剪贴板` };
  }

  if (IS_WIN) {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const out = await win.winPwsh(`$b=[Convert]::FromBase64String('${b64}'); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($b)); 'ok'`, 6000);
    return out.includes("ok") ? { ok: true } : { ok: false, error: "Set-Clipboard 写入失败" };
  }
  if (IS_MAC) {
    const b64 = Buffer.from(value, "utf8").toString("base64");
    const r = await mac.macExec("/bin/sh", ["-c", `printf %s '${b64}' | base64 -D | pbcopy`], 5000);
    return r.code === 0 ? { ok: true } : { ok: false, error: "pbcopy 写入失败" };
  }

  const attempts = await xClipboardTargets(inst);
  if (!attempts.length) return { ok: false, error: `写入失败：${await clipboardUnavailable(inst, "直写")}` };
  for (const a of attempts) {
    if (await writeXClipboard(a.display, a.auth, value)) return { ok: true };
  }
  return { ok: false, error: "写入失败：xclip 缺失或该 X 会话无访问权限" };
}

export async function vncList(): Promise<(VncInstance & { tcp: boolean; web: boolean })[]> {
  const live = await Promise.all(vncInstances().map(instanceLive));
  // 注册表空但 systemd 服务模式（固定 5900/6080）在跑 → 合成只读条目（面板/agent 可见）
  if (live.length === 0 && (await legacyVncRunning())) {
    const legacy = legacyVnc();
    const [tcp, web] = await Promise.all([portListening(legacy.rfbPort), portListening(legacy.webPort)]);
    live.push({ ...legacy, tcp, web });
  }
  return live;
}

export async function vncStatus(): Promise<VncState & { instances: (VncInstance & { tcp: boolean; web: boolean })[] }> {
  const live = await vncList();
  const def = live.find((i) => i.id === "default") || live[0];
  const noVncDir = findNoVncDir();
  return {
    displayNum: def?.displayNum ?? envDisplayNum(),
    vncPort: def?.rfbPort ?? envNumber("UI_ENV_VNC_PORT", 5900),
    webPort: def?.webPort ?? vncWebPort(),
    tcpRunning: def?.tcp ?? false,
    webRunning: def?.web ?? false,
    webUrl: def ? `http://127.0.0.1:${def.webPort}/vnc.html?autoconnect=true&resize=scale` : "",
    noVncDir, command: def ? `vnc-bridge 127.0.0.1:${def.webPort} → x11vnc 127.0.0.1:${def.rfbPort} (display :${def.displayNum})` : "无实例",
    instances: live,
  };
}

export async function vncAction(
  action: "start" | "stop" | "status",
  opts: { id?: string; displayNum?: number } = {},
): Promise<VncState & { action: string; message?: string; instances?: (VncInstance & { tcp: boolean; web: boolean })[] }> {
  if (action === "start") {
    try {
      const inst = await vncCreate(opts.id, opts.displayNum);
      const s = await vncStatus();
      return { ...s, action, message: `实例 ${inst.id} 就绪（RFB :${inst.rfbPort} / Web :${inst.webPort}，display :${inst.displayNum}）` };
    } catch (e) {
      const s = await vncStatus();
      return { ...s, action, message: "启动失败：" + String((e as Error).message) };
    }
  }
  if (action === "stop") {
    const r = await vncStop(opts.id);
    const s = await vncStatus();
    return { ...s, action, message: r.message };
  }
  return { ...(await vncStatus()), action };
}


export function findNoVncDir(): string | null {
  const num = envDisplayNum();
  const candidates = [
    envStr("UI_ENV_NOVNC_DIR", ""),
    `/tmp/ui-env-${num}/noVNC`, `/tmp/ui-env-${num}/novnc`,
    "/usr/share/novnc", "/usr/share/noVNC", "/opt/novnc", "/opt/noVNC",
    path.join(homeDir(), "noVNC"), path.join(homeDir(), ".pi", "novnc"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, "vnc.html"))) return c; } catch { /* ignore */ }
  }
  // 兜底：安装脚本会在 configDir 放 vnc.html（本扩展 assets）
  try { const local = path.join(path.dirname(configDir), "novnc", "vnc.html"); if (fs.existsSync(local)) return cachePath("novnc"); } catch { /* ignore */ }
  return null;
}

function stTmpAuth(num: number): string | null {
  try {
    const base = envStr("UI_ENV_XAUTH_DIR", `/tmp/ui-env-${num}`);
    if (fs.existsSync(path.join(base, "Xauthority"))) return path.join(base, "Xauthority");
  } catch { /* ignore */ }
  return null;
}

export interface InstallStatus { os: string; tools: Record<string, boolean>; units: Record<string, "active" | "inactive" | "missing">; }

export async function installStatus(): Promise<InstallStatus> {
  const osName = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  if (osName === "macos") return mac.macInstallStatus(configDir);
  if (osName === "windows") {
    // Windows：检查项 = node / 便携 winvnc / noVNC / bridge / 虚拟显示驱动；units 无意义
    const d = await win.winCheckDeps(configDir);
    const hasNovnc = !d.coreMissing.some((c) => c.bin === "novnc");
    const hasBridge = !d.coreMissing.some((c) => c.bin === "vnc-bridge");
    const winvncPortable = !d.coreMissing.some((c) => c.bin === "winvnc(便携)");
    const tools: Record<string, boolean> = {
      node: true,
      "winvnc(便携)": winvncPortable,
      "winvnc(系统安装)": !winvncPortable && !!d.winvncPath,
      novnc: hasNovnc,
      "vnc/rdp-bridge": hasBridge,
      "虚拟显示驱动": !!d.vddDriver,
      "vnc-server在跑": d.winvncRunning,
    };
    return { os: osName, tools, units: {} };
  }
  const tools = ["Xvfb", "openbox", "x11vnc", "dbus-daemon", "at-spi-bus-launcher", "xauth", "xdpyinfo", "xdotool"] as const;
  const t: Record<string, boolean> = {};
  for (const tool of tools) {
    const hit = await runCmd("sh", ["-c", `command -v ${tool} >/dev/null 2>&1 && echo yes`]).catch(() => "");
    t[tool] = hit.trim() === "yes";
    // PATH 不含 /usr/libexec 等常见位置时的兜底
    if (!t[tool]) {
      const known = ["/usr/bin/" + tool, "/usr/sbin/" + tool, "/usr/libexec/" + tool].find((p) => { try { return fs.existsSync(p); } catch { return false; } });
      t[tool] = !!known;
    }
  }
  // VNC web 层 = 自写 node vnc-bridge（零依赖）；检查文件已部署
  try { t["vnc-bridge"] = fs.existsSync(cachePath("vnc-bridge.mjs")); } catch { t["vnc-bridge"] = false; }
  const units: InstallStatus["units"] = {};
  for (const name of ["ui-env-xvfb", "ui-env-bus", "ui-env-wm", "ui-env-vnc"]) {
    const userOk = fs.existsSync(`${homeDir()}/.config/systemd/user/${name}.service`);
    const sysOk = fs.existsSync(`/etc/systemd/system/${name}.service`);
    if (!userOk && !sysOk) { units[name] = "missing"; continue; }
    const r = await execFilePromise("systemctl", [...(userOk ? ["--user"] : []), "is-active", name], 4000);
    units[name] = r.err ? "inactive" : (r.out.trim() === "active" ? "active" : "inactive");
  }
  return { os: osName, tools: t, units };
}

// ─────────────────────────── 依赖自检 + 自动安装（多 OS） ───────────────────────────

/** 各包管理器安装命令（pkgs 已去重） */
const PKG_INSTALL: Record<string, (pkgs: string[]) => string> = {
  apt: (p) => `DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y ${p.join(" ")}`,
  dnf: (p) => `dnf install -y ${p.join(" ")}`,
  yum: (p) => `yum install -y ${p.join(" ")}`,
  pacman: (p) => `pacman -S --noconfirm --needed ${p.join(" ")}`,
  apk: (p) => `apk add --no-cache ${p.join(" ")}`,
  zypper: (p) => `zypper --non-interactive install -y ${p.join(" ")}`,
  brew: (p) => `brew install ${p.join(" ")}`,
};

interface DepDef {
  bin: string; label: string; group: "core" | "ui";
  pkg: Record<string, string>; manual: string;
}

/** 虚拟屏依赖清单：core=虚拟屏必需；ui=面板/菜单增强（缺了也能跑核心） */
const DEPS: DepDef[] = [
  { bin: "Xvfb", label: "虚拟显示服务器", group: "core", manual: "apt: xvfb · dnf: xorg-x11-server-Xvfb · pacman: xorg-server-xvfb",
    pkg: { apt: "xvfb", dnf: "xorg-x11-server-Xvfb", yum: "xorg-x11-server-Xvfb", pacman: "xorg-server-xvfb", apk: "xorg-server-xvfb", zypper: "xorg-x11-server" } },
  { bin: "openbox", label: "窗口管理器", group: "core", manual: "openbox（各发行版同名）",
    pkg: { apt: "openbox", dnf: "openbox", yum: "openbox", pacman: "openbox", apk: "openbox", zypper: "openbox" } },
  { bin: "x11vnc", label: "VNC 服务", group: "core", manual: "x11vnc（各发行版同名）",
    pkg: { apt: "x11vnc", dnf: "x11vnc", yum: "x11vnc", pacman: "x11vnc", apk: "x11vnc", zypper: "x11vnc" } },
  { bin: "at-spi-bus-launcher", label: "AT-SPI 语义总线", group: "core", manual: "at-spi2-core",
    pkg: { apt: "at-spi2-core", dnf: "at-spi2-core", yum: "at-spi2-core", pacman: "at-spi2-core", apk: "at-spi2-core", zypper: "at-spi2-core" } },
  { bin: "xauth", label: "X 认证", group: "core", manual: "apt/dnf: xauth · pacman: xorg-xauth",
    pkg: { apt: "xauth", dnf: "xauth", yum: "xauth", pacman: "xorg-xauth", apk: "xauth", zypper: "xauth" } },
  { bin: "xdpyinfo", label: "分辨率探测", group: "core", manual: "apt: x11-utils · pacman: xorg-xdpyinfo",
    pkg: { apt: "x11-utils", dnf: "xorg-x11-utils", yum: "xorg-x11-utils", pacman: "xorg-xdpyinfo", apk: "xorg-xdpyinfo", zypper: "xorg-x11-utils" } },
  { bin: "dbus-daemon", label: "D-Bus 会话总线", group: "core", manual: "dbus（通常系统已带）",
    pkg: { apt: "dbus", dnf: "dbus-x11", yum: "dbus-x11", pacman: "dbus", apk: "dbus", zypper: "dbus-1" } },
  { bin: "tint2", label: "面板（任务栏）", group: "ui", manual: "tint2（各发行版同名）",
    pkg: { apt: "tint2", dnf: "tint2", yum: "tint2", pacman: "tint2", apk: "tint2", zypper: "tint2" } },
  { bin: "xfce4-terminal", label: "终端模拟器", group: "ui", manual: "xfce4-terminal（各发行版同名）",
    pkg: { apt: "xfce4-terminal", dnf: "xfce4-terminal", yum: "xfce4-terminal", pacman: "xfce4-terminal", apk: "xfce4-terminal", zypper: "xfce4-terminal" } },
  { bin: "thunar", label: "文件管理器", group: "ui", manual: "thunar（各发行版同名）",
    pkg: { apt: "thunar", dnf: "Thunar", yum: "Thunar", pacman: "thunar", apk: "thunar", zypper: "thunar" } },
  { bin: "xdotool", label: "自动化输入", group: "ui", manual: "xdotool（各发行版同名）",
    pkg: { apt: "xdotool", dnf: "xdotool", yum: "xdotool", pacman: "xdotool", apk: "xdotool", zypper: "xdotool" } },
  { bin: "xterm", label: "备用终端", group: "ui", manual: "xterm（各发行版同名）",
    pkg: { apt: "xterm", dnf: "xterm", yum: "xterm", pacman: "xterm", apk: "xterm", zypper: "xterm" } },
  { bin: "obamenu", label: "应用菜单生成", group: "ui", manual: "obamenu（仅 Debian/Ubuntu 系有包；缺了菜单仍可用）",
    pkg: { apt: "obamenu", dnf: "", yum: "", pacman: "", apk: "", zypper: "" } },
];

interface DepStatusItem { bin: string; label: string; group: "core" | "ui"; installed: boolean; pkg: string | null; manual: string; }

export interface DepsStatus {
  os: string; distro: string; pkgMgr: string | null; sudo: boolean;
  coreMissing: DepStatusItem[]; uiMissing: DepStatusItem[];
  allInstalled: boolean; manualHints: string[]; note?: string;
}

export interface DepsInstallResult extends DepsStatus {
  installRan: boolean; installLog?: string; error?: string;
}

function detectDistro(): { id: string; pretty: string } {
  try {
    const s = fs.readFileSync("/etc/os-release", "utf8");
    return { id: (s.match(/^ID=(\S+)/m)?.[1] || "").replace(/["']/g, ""), pretty: s.match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] || "Linux" };
  } catch { return { id: "", pretty: "Linux" }; }
}

async function detectPlatform(): Promise<{ os: string; distro: string; pkgMgr: string | null; sudo: boolean }> {
  if (process.platform === "darwin") return { os: "macos", distro: "macOS", pkgMgr: "brew", sudo: false };
  if (process.platform === "win32") return { os: "windows", distro: "Windows", pkgMgr: null, sudo: false };
  const { id, pretty } = detectDistro();
  let pkgMgr: string | null = null;
  if (/^(ubuntu|debian|linuxmint|raspbian|kali|pop|elementary|zorin)$/.test(id)) pkgMgr = "apt";
  else if (/^(fedora|rhel|centos|rocky|almalinux|ol|amzn)$/.test(id)) pkgMgr = "dnf";
  else if (/^(arch|manjaro|endeavouros|garuda|cachyos)$/.test(id)) pkgMgr = "pacman";
  else if (id === "alpine") pkgMgr = "apk";
  else if (/^opensuse/.test(id) || id === "sles") pkgMgr = "zypper";
  else {
    for (const m of ["apt-get", "dnf", "pacman", "apk", "zypper", "brew"]) { if (await resolveBin(m)) { pkgMgr = m; break; } }
  }
  let sudo = false;
  if (pkgMgr && process.platform === "linux") sudo = (await runCmd("sudo", ["-n", "true"], 3000)).trim() === "";
  return { os: "linux", distro: pretty || id || "Linux", pkgMgr, sudo };
}

function buildManualHints(plat: { os: string; pkgMgr: string | null; sudo: boolean }, coreMissing: DepStatusItem[], uiMissing: DepStatusItem[]): string[] {
  const hints: string[] = [];
  if (plat.os === "macos") {
    // 理论上到不了（macOS 已在 checkDeps 前置分支走 macCheckDeps），保险兜底
    hints.push("macOS：核心 = Aqua 会话 + 屏幕共享 VNC（系统设置 → 通用 → 共享 → 屏幕共享）；可选增强走 brew（cliclick/XQuartz）。详见 docs/aiti-ui-env-macos-support-plan.md。");
    return hints;
  }
  if (plat.os === "windows") {
    // 理论上到不了（Windows 已在 checkDeps 前置分支），保险兑底
    hints.push("Windows：本扩展支持自管便携 UltraVNC（免安装免管理员）；虚拟显示驱动可装 IddSampleDriver/usbmmidd；Home 版无系统 RDP 服务端（被看用 VNC）。");
    return hints;
  }
  if (coreMissing.length) {
    const pkgs = coreMissing.map((i) => i.pkg).filter(Boolean).join(" ");
    if (plat.pkgMgr && plat.sudo) hints.push(`可自动安装：${plat.pkgMgr} ${pkgs}`);
    else if (plat.pkgMgr) hints.push(`需 root 手动安装（本进程无免密 sudo，请在终端执行）：sudo ${plat.pkgMgr} install -y ${pkgs}`);
    else hints.push(`未知包管理器，手动安装：${coreMissing.map((i) => i.manual).join("；")}`);
  }
  if (uiMissing.length) hints.push(`可选增强缺失：${uiMissing.map((i) => `${i.label}(${i.pkg || "无包可自动装"})`).join("、")}`);
  return hints;
}

/** 自检依赖（多 OS）：返回缺失清单 + 包管理器 + sudo 状态 + 手动指引 */
export async function checkDeps(refresh = false): Promise<DepsStatus> {
  void refresh;
  if (IS_WIN) {
    const w = await win.winCheckDeps(configDir);
    return { os: w.os, distro: w.distro, pkgMgr: w.pkgMgr, sudo: w.sudo, coreMissing: w.coreMissing, uiMissing: w.uiMissing, allInstalled: w.allInstalled, manualHints: w.manualHints };
  }
  if (IS_MAC) {
    const m = await mac.macCheckDeps(configDir);
    return { os: m.os, distro: m.distro, pkgMgr: m.pkgMgr, sudo: m.sudo, coreMissing: m.coreMissing, uiMissing: m.uiMissing, allInstalled: m.allInstalled, manualHints: m.manualHints };
  }
  const plat = await detectPlatform();
  const items: DepStatusItem[] = [];
  for (const d of DEPS) {
    const installed = !!(await resolveBin(d.bin));
    items.push({ bin: d.bin, label: d.label, group: d.group, installed, pkg: plat.pkgMgr ? (d.pkg[plat.pkgMgr] || null) : null, manual: d.manual });
  }
  const coreMissing = items.filter((i) => !i.installed && i.group === "core");
  const uiMissing = items.filter((i) => !i.installed && i.group === "ui");
  return {
    os: plat.os, distro: plat.distro, pkgMgr: plat.pkgMgr, sudo: plat.sudo,
    coreMissing, uiMissing, allInstalled: coreMissing.length === 0 && uiMissing.length === 0,
    manualHints: buildManualHints(plat, coreMissing, uiMissing),
  };
}

/** 大缓冲执行（apt/dnf 输出可能超 1MB） */
function installExec(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 16 << 20 }, (err, stdout) => resolve(String(stdout || "") + (err ? `\n[exit ${(err as any).code ?? "err"}]` : "")));
  });
}

/** 自动安装缺失组件（Unix 需免密 sudo；Windows = 下载便携 UltraVNC 到 configDir/ultravnc） */
export async function installDeps(): Promise<DepsInstallResult> {
  const check = await checkDeps(true);
  if (check.os === "windows") {
    const r = await win.winInstallDeps(configDir);
    const after = await checkDeps(true);
    if (!r.ran) return { ...after, installRan: false, note: r.log || r.error };
    if (r.error) return { ...after, installRan: true, error: r.error };
    return { ...after, installRan: true, installLog: r.log };
  }
  if (check.os === "macos") {
    const r = await mac.macInstallDeps(configDir);
    const after = await checkDeps(true);
    if (!r.ran) return { ...after, installRan: false, note: r.log || r.error };
    if (r.error) return { ...after, installRan: true, error: r.error };
    return { ...after, installRan: true, installLog: r.log };
  }
  if (!check.pkgMgr) {
    return { ...check, installRan: false, error: `${check.os} 不支持自动安装：${check.manualHints.join("；") || "无可用包管理器"}` };
  }
  if (!check.sudo) {
    const all = [...check.coreMissing, ...check.uiMissing];
    const pkgs = [...new Set(all.map((i) => i.pkg).filter(Boolean))].join(" ");
    return { ...check, installRan: false, error: `无免密 sudo，无法自动安装。手动执行：sudo ${check.pkgMgr} install -y ${pkgs}` };
  }
  const all = [...check.coreMissing, ...check.uiMissing];
  if (!all.length) return { ...check, installRan: false, note: "无缺失组件，无需安装" };
  const pkgs = [...new Set(all.map((i) => i.pkg).filter(Boolean))] as string[];
  const noPkg = all.filter((i) => !i.pkg).map((i) => i.label);
  if (!pkgs.length) return { ...check, installRan: false, error: `缺失组件无对应包（无法自动装）：${noPkg.join("、")}。${check.manualHints.join("；")}` };
  const cmd = PKG_INSTALL[check.pkgMgr]?.(pkgs);
  if (!cmd) return { ...check, installRan: false, error: `不支持的包管理器：${check.pkgMgr}` };
  const log = await installExec("sudo", ["sh", "-c", cmd], 180000);
  const after = await checkDeps(true);
  return { ...after, installRan: true, installLog: log.slice(-1500) };
}

// ─────────────────────────── RDP ───────────────────────────

/** RDP 会话票据 TTL（30 分钟，与 VNC 同值） */
export const RDP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** RDP 实例：桥端口随机，目标 host:port 用户指定 */
export interface RdpInstance {
  id: string;          // "default" 或 "r<ts>"
  token?: string;      // 真随机 opaque 实例令牌：URL 路径段，代表该实例/端口（不落目标地址）；定期轮换
  prevToken?: string;  // 轮换前令牌（宽限期内仍可路由）
  host: string;        // RDP 目标主机
  port: number;        // RDP 目标端口（默认 3389）
  webPort: number;     // rdp-bridge 端口（随机，避免冲突）
  bridgePid?: number;  // node rdp-bridge
  createdAt: string;
  sys?: { port: number; label: string }; // 系统 RDP（非本扩展自启）
}

function rdpInstancesFile(): string { return cachePath("rdp-instances.json"); }

function loadRdpInstances(): Record<string, RdpInstance> {
  try { return JSON.parse(fs.readFileSync(rdpInstancesFile(), "utf8")).instances || {}; } catch { return {}; }
}
function saveRdpInstances(ins: Record<string, RdpInstance>): void {
  try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(rdpInstancesFile(), JSON.stringify({ instances: ins }, null, 2)); } catch {}
}

/** RDP 访问令牌：env UI_ENV_RDP_TOKEN 优先，否则 configDir/rdp-token 持久化自动生成；空串=关闭校验 */
export function rdpToken(): string {
  const envT = process.env.UI_ENV_RDP_TOKEN;
  if (envT !== undefined && envT !== null) return envT;
  const file = path.join(configDir, "rdp-token");
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
    const t = randomBytes(16).toString("hex");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  } catch { return ""; }
}

export function makeRdpSession(): string {
  const ts = Date.now().toString(36);
  const sig = createHmac("sha256", rdpToken()).update("rdp-session:" + ts).digest("hex");
  return `${ts}.${sig}`;
}

export function validRdpSession(sess: string | null): boolean {
  const tok = rdpToken();
  if (tok === "") return true;
  if (!sess) return false;
  const i = sess.lastIndexOf(".");
  if (i <= 0) return false;
  const ts = sess.slice(0, i), sig = sess.slice(i + 1);
  if (!/^[a-z0-9]+$/.test(ts)) return false;
  const age = Date.now() - parseInt(ts, 36);
  if (!Number.isFinite(age) || age < -5000 || age > RDP_SESSION_TTL_MS) return false;
  const expect = createHmac("sha256", tok).update("rdp-session:" + ts).digest("hex");
  if (sig.length !== expect.length) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expect, "hex"));
}

/** RDP 静态目录（grdpwasm 优先，webRDP 兼容）：env > 常见路径 > configDir 兜底。
 * grdpwasm：有 index.html 即可——main.wasm 可缺（安装副本已删），由后端 justget
 * 缓存（ensureRdpWasm → rdp-bridge 同源回退）与页面自身 CDN 链路双重兜底。
 * webRDP 只需 index.html/main.html/vnc.html。 */
export function findRdpDist(): string | null {
  const candidates = [
    process.env.UI_ENV_RDP_DIR || "",
    // grdpwasm 静态（优先）
    "/opt/grdpwasm", "/opt/Grdpwasm",
    path.join(homeDir(), "grdpwasm", "static"),
    path.join(homeDir(), "grdpwasm"),
    path.join(homeDir(), ".pi", "grdpwasm"),
    cachePath("grdpwasm"),
    // webRDP（兼容旧方案）
    "/opt/webRDP", "/opt/WebRDP",
    path.join(homeDir(), "webRDP"), path.join(homeDir(), ".pi", "webRDP"),
    cachePath("webRDP"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      // grdpwasm：index.html 即可（main.wasm 可缺，后端缓存 + 页面 CDN 双兜底）
      if (fs.existsSync(path.join(c, "index.html"))) return c;
      // webRDP 兼容：任意入口文件
      for (const entry of ["main.html", "vnc.html"]) {
        if (fs.existsSync(path.join(c, entry))) return c;
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ── 系统 RDP 探测（xrdp / 监听端口）──

export interface SysRdpEntry {
  id: string;
  kind: string;
  display: string;
  port: number;
  pid?: number;
  ours: boolean;
  stoppable: boolean;
  listening: boolean;
  cmd?: string;
}

/** 探测系统 RDP server：Unix= xrdp 进程 + 3389；Windows= TermService 服务状态 + 3389 监听。 */
export async function systemRdpScan(): Promise<SysRdpEntry[]> {
  if (IS_WIN) return win.winSystemRdpScan();
  const out = await runCmd("ps", ["-eo", "pid,user,args"]).catch(() => "");
  const list: SysRdpEntry[] = [];
  const seenPorts = new Set<number>();
  for (const line of out.split("\n").filter(Boolean)) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]); const user = m[2]; const cmd = m[3].trim();
    const prog = (cmd.split(/\s+/)[0] || "").split("/").pop();
    if (prog === "bash" || prog === "sh" || prog === "ps" || prog === "grep") continue;
    if (prog === "xrdp" || cmd.includes("xrdp")) {
      const display = (cmd.match(/:(\d+)/) || [])[1];
      const port = 3389;
      const listening = await portListening(port);
      const ours = cmd.includes("/tmp/ui-env-");
      if (!ours && !seenPorts.has(port)) {
        seenPorts.add(port);
        list.push({ id: "sys-" + pid, kind: "xrdp", display: display ? ":" + display : ":?", port, pid, ours, stoppable: user === process.env.USER, listening, cmd: cmd.slice(0, 110) });
      }
    }
  }
  for (let p = 3389; p <= 3399; p++) {
    if (await portListening(p) && !seenPorts.has(p)) {
      list.push({ id: "port-" + p, kind: "unknown", display: ":?", port: p, ours: false, stoppable: false, listening: true });
    }
  }
  return list;
}

// ── RDP 实例管理 ──

let rdpCreateLock: Promise<unknown> | null = null;

export function rdpInstance(id: string): RdpInstance | null {
  return loadRdpInstances()[id] || null;
}

export function rdpInstanceSync(id: string): RdpInstance | null {
  ensureInstanceTokens("rdp");
  return loadRdpInstances()[id] || null;
}

export function rdpInstances(): RdpInstance[] {
  ensureInstanceTokens("rdp");
  return Object.values(loadRdpInstances());
}

function defaultRdpInstanceId(): string {
  const ins = loadRdpInstances();
  if (ins["default"]) return "default";
  const first = Object.keys(ins)[0];
  return first || "default";
}

/** 创建/启动 RDP 实例：随机 web 端口；rdp-bridge 直连外部 RDP 服务器。
 *  id 缺省 = 首实例 "default"；已存在且真活着 → 复用（幂等）。并发 start 串行。 */
export async function rdpCreate(id: string | undefined, host: string, port: number, opts: { sysPort?: number; sysLabel?: string } = {}): Promise<RdpInstance> {
  while (rdpCreateLock) { try { await rdpCreateLock; } catch {} }
  let release!: () => void;
  rdpCreateLock = new Promise((r) => (release = r));
  try {
    const isSys = !!opts.sysPort;
    const ins = loadRdpInstances();
    const instId = id || (Object.keys(ins).length === 0 ? "default" : "r" + Date.now().toString(36));
    // 防重复：同一 RDP 目标（host:port）已有一个活实例 → 复用，别再加一个新实例（同地址开出一堆）
    if (isSys && opts.sysPort) {
      // 系统 RDP（sys-open 桥接本机端口）：同目标已有活桥 → 复用（find+await 不可用，用 for 循环）
      let dup: RdpInstance | undefined;
      for (const i of Object.values(ins)) {
        if (i.sys && i.sys.port === opts.sysPort &&
          pidAlive(i.bridgePid) && (await portListening(i.webPort))) {
          dup = i;
          break;
        }
      }
      if (dup) return dup;
    }
    if (!id && !isSys) {
      // 普通远程目标：find() callback can't be async (await in non-async arrow = ParseError,
      // and find() treats a returned Promise as truthy). Use a for-loop.
      let dup: RdpInstance | undefined;
      for (const i of Object.values(ins)) {
        if (!i.sys && i.host === host && i.port === port &&
          pidAlive(i.bridgePid) && (await portListening(i.webPort))) {
          dup = i;
          break;
        }
      }
      if (dup) return dup;
    }
    const existing = ins[instId];
    if (existing && pidAlive(existing.bridgePid) && (await portListening(existing.webPort))) {
      return existing;
    }
    if (existing && pidAlive(existing.bridgePid)) {
      try { process.kill(existing.bridgePid, "SIGTERM"); } catch {}
    }

    const webPort = await pickFreePort(6400, 6600);
    const rdpDist = findRdpDist();
    const inst: RdpInstance = {
      id: instId,
      token: genInstanceToken(),
      host: isSys ? "127.0.0.1" : host,
      port: isSys ? opts.sysPort! : port,
      webPort,
      createdAt: new Date().toISOString(),
    };
    if (isSys) inst.sys = { port: opts.sysPort!, label: opts.sysLabel || "sys" };

    const bridge = cachePath("rdp-bridge.mjs");
    if (fs.existsSync(bridge) && rdpDist) {
      // main.wasm 资产确保：异步预取到缓存目录（不阻塞桥启动；serve 时文件已在即生效），
      // 桥经 UI_ENV_RDP_WASM_CACHE 在静态目录缺 wasm 时同源回退到这份缓存
      const wasmCache = wasmCachePath(configDir);
      void ensureRdpWasm(configDir).catch(() => null);
      const pid = await safeSpawnBin("node", [bridge], {
        UI_ENV_RDP_TOKEN: rdpToken(),
        UI_ENV_BRIDGE_LOG: cachePath("logs", "rdp-bridge-crash.log"),
        UI_ENV_RDP_WEB_PORT: String(webPort),
        UI_ENV_RDP_PORT: String(inst.port),
        UI_ENV_RDP_HOST: inst.host,
        UI_ENV_RDP_DIR: rdpDist,
        UI_ENV_RDP_WASM_CACHE: fs.existsSync(path.join(rdpDist, "main.wasm")) ? "" : wasmCache,
      });
      if (pid) inst.bridgePid = pid;
    }

    ins[instId] = inst;
    saveRdpInstances(ins);
    await sleep(700);
    return inst;
  } finally {
    rdpCreateLock = null;
    release();
  }
}

export async function rdpStop(id?: string): Promise<{ ok: boolean; message: string }> {
  const ins = loadRdpInstances();
  const target = id || defaultRdpInstanceId();
  const inst = ins[target];
  if (!inst) return { ok: true, message: `实例 ${target} 不存在（无操作）` };
  if (pidAlive(inst.bridgePid)) { try { process.kill(inst.bridgePid!, "SIGTERM"); } catch {} }
  delete ins[target];
  saveRdpInstances(ins);
  return { ok: true, message: `实例 ${target} 已停止（→ ${inst.host}:${inst.port} / Web :${inst.webPort}）` };
}

async function rdpInstanceLive(inst: RdpInstance): Promise<RdpInstance & { web: boolean }> {
  const web = await portListening(inst.webPort);
  return { ...inst, web };
}

export async function rdpPrune(): Promise<number> {
  const ins = loadRdpInstances();
  let removed = 0;
  for (const [id, inst] of Object.entries(ins)) {
    const alive = pidAlive(inst.bridgePid) && (await portListening(inst.webPort));
    if (!alive) { delete ins[id]; removed++; }
  }
  if (removed) saveRdpInstances(ins);
  return removed;
}

export async function rdpList(): Promise<(RdpInstance & { web: boolean })[]> {
  return await Promise.all(rdpInstances().map(rdpInstanceLive));
}

export interface RdpState {
  host: string;
  port: number;
  webPort: number;
  webRunning: boolean;
  command: string;
  rdpDist: string | null;
  instances: (RdpInstance & { web: boolean })[];
}

export async function rdpStatus(): Promise<RdpState> {
  const live = await rdpList();
  const def = live.find((i) => i.id === "default") || live[0];
  return {
    host: def?.host ?? "127.0.0.1",
    port: def?.port ?? 3389,
    webPort: def?.webPort ?? 0,
    webRunning: def?.web ?? false,
    command: def ? `rdp-bridge 127.0.0.1:${def.webPort} → ${def.host}:${def.port}` : "无实例",
    rdpDist: findRdpDist(),
    instances: live,
  };
}

export async function rdpAction(
  action: "start" | "stop" | "status" | "list",
  opts: { id?: string; host?: string; port?: number; sysPort?: number; sysLabel?: string } = {},
): Promise<RdpState & { action: string; message?: string }> {
  if (action === "start") {
    if (!opts.host && !opts.sysPort) throw new Error("start 需要 host（RDP 目标主机）");
    try {
      const inst = opts.sysPort
        ? await rdpCreate(opts.id, "127.0.0.1", 0, { sysPort: opts.sysPort, sysLabel: opts.sysLabel })
        : await rdpCreate(opts.id, opts.host!, opts.port ?? 3389);
      const s = await rdpStatus();
      return { ...s, action, message: `实例 ${inst.id} 就绪（→ ${inst.host}:${inst.port} / Web :${inst.webPort}）` };
    } catch (e) {
      const s = await rdpStatus();
      return { ...s, action, message: "启动失败：" + String((e as Error).message) };
    }
  }
  if (action === "stop") {
    const r = await rdpStop(opts.id);
    const s = await rdpStatus();
    return { ...s, action, message: r.message };
  }
  if (action === "list") {
    const s = await rdpStatus();
    return { ...s, action, message: `共 ${s.instances.length} 个 RDP 实例` };
  }
  return { ...(await rdpStatus()), action };
}