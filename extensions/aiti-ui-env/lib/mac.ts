/**
 * aiti-ui-env · macOS 平台实现（process.platform === "darwin" 专用）
 *
 * 设计（docs/aiti-ui-env-macos-support-plan.md）：
 * - 桌面 = Aqua 控制台会话。证据链：WindowServer 在跑 + /dev/console 属主（root = 停在登录窗口）
 *   + 属主 == 本进程用户（GUI 应用以 pi-web 同身份 spawn，只有 console 会话属主连得上 WindowServer）
 *   + 本进程 launchd 上下文（launchctl managername==Aqua；pi-web 以 LaunchAgent 跑在 gui 域即满足，
 *     ssh/daemon 上下文给出 warning）。
 * - 无头虚拟屏（诚实降级，同 Windows 哲学）：macOS 无 Xvfb 等价物、无进程级显示隔离——GUI 永远落
 *   控制台桌面。「无头」= 屏幕共享 VNC server（com.apple.screensharing，5900）就绪 + vnc-bridge/noVNC
 *   浏览器查看（无物理屏/远程场景 = 看这块屏）。
 * - VNC：不自管 server，桥接系统屏幕共享（RFB 认证 = mac 账号密码，noVNC 凭据层输入）。
 *   启用：系统设置 → 通用 → 共享 → 屏幕共享；或 sudo launchctl load -w
 *   /System/Library/LaunchDaemons/com.apple.screensharing.plist；或 scripts/macos/setup-macos.sh enable
 * - 语义通道：AT-SPI 是 Linux 概念；mac 等价物是 AX Accessibility API，不在本扩展范围（cua 侧课题）。
 * - X11 应用：装 XQuartz 后自带 X server + xdotool/x11vnc（可选增强，不属 core）。
 *
 * 编码注意：daemon/ssh 上下文 PATH 常缺 /usr/sbin（netstat/screencapture/system_profiler 在此）——
 * 探测命令一律经 runMac 绝对路径兜底；ps/stat/launchctl/sw_vers 在 /bin、/usr/bin 稳定可达。
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProbeInfo, SysVncEntry } from "./env.js";

/** 数据分层（三目录对称 2026-09-13）：configDir = <extRoot>/config，cache 在 <extRoot>/cache 下。 */
function cachePath(configDir: string, ...segments: string[]): string {
  return path.join(path.dirname(configDir), "cache", ...segments);
}

// ─────────────────────────── 进程/命令工具 ───────────────────────────

export function macExec(cmd: string, args: string[], timeoutMs = 5000): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 << 20 },
        (err: (Error & { code?: number }) | null, stdout: string) =>
          resolve({ out: String(stdout || ""), code: err ? ((typeof (err as any).code === "number" ? (err as any).code : 1)) : 0 }));
    } catch {
      resolve({ out: "", code: 127 }); // spawn 同步抛错（受限环境/权限）：按命令不可用处理
    }
  });
}

/** 已知工具的绝对路径解析（bin 名 → 常见目录首个存在者；找不到则原样交给 PATH） */
async function absBin(cmd: string): Promise<string> {
  if (cmd.includes("/")) return cmd;
  for (const dir of ["/bin", "/usr/bin", "/usr/sbin", "/sbin"]) {
    try { if (fs.existsSync(path.join(dir, cmd))) return path.join(dir, cmd); } catch { /* ignore */ }
  }
  return cmd;
}

/** runMac：绝对路径兜底执行（daemon/ssh 上下文 PATH 不完整也能跑） */
export async function runMac(cmd: string, args: string[], timeoutMs = 5000): Promise<{ out: string; code: number }> {
  return macExec(await absBin(cmd), args, timeoutMs);
}

/** 本进程用户名（与 console 属主比对用） */
function me(): string {
  if (process.env.USER) return process.env.USER;
  try { return os.userInfo().username; } catch { return ""; }
}

// ─────────────────────────── 探测原语 ───────────────────────────

/** 端口监听探测：BSD netstat（`-tln` 是 Linux 语法，mac 无效；`-an -p tcp` 输出 LISTEN 行）。
 *  行样例：`tcp4  0  0  *.5900  *.*  LISTEN` */
export async function macPortListening(port: number): Promise<boolean> {
  const { out } = await runMac("netstat", ["-an", "-p", "tcp"], 5000);
  if (!out) return false;
  return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTEN`).test(out);
}

/** 本进程 launchd 上下文：Aqua=GUI 会话（LaunchAgent）；System/Background=daemon/ssh 上下文 */
export async function macManagerName(): Promise<string | null> {
  const { out } = await runMac("launchctl", ["managername"], 4000);
  return out.trim() || null;
}

/** 控制台（GUI）登录用户：root = 停在登录窗口（无人登录） */
export async function macConsoleUser(): Promise<string | null> {
  const { out } = await runMac("stat", ["-f", "%Su", "/dev/console"], 4000);
  return out.trim() || null;
}

/** WindowServer 是否在跑（GUI 会话存在的硬证据；停在登录窗口时它也在跑，需配合 console 属主判定） */
async function windowServerRunning(): Promise<boolean> {
  const { out } = await runMac("ps", ["-eo", "comm"], 5000);
  return out.split("\n").some((l) => l.trim().endsWith("/WindowServer") || l.trim() === "WindowServer");
}

/** 分辨率（best-effort）：system_profiler 慢（可达 5-10s）→ 后台单次拉取 + 60s 缓存，
 *  首次探测返回 undefined 不阻塞。缓存刷新 = 事件驱动单次任务，非常驻轮询。 */
let resCache: { at: number; value?: string } | null = null;
let resFetching = false;
export function macDisplayResolution(): string | undefined {
  if (resCache && Date.now() - resCache.at < 60_000) return resCache.value;
  if (!resFetching) {
    resFetching = true;
    macExec("/usr/sbin/system_profiler", ["SPDisplaysDataType"], 15000)
      .then(({ out }) => {
        const m = out.match(/Resolution:\s*(\d+\s*x\s*\d+)/i);
        resCache = { at: Date.now(), value: m ? m[1].replace(/\s+/g, "") : undefined };
      })
      .catch(() => { resCache = { at: Date.now(), value: undefined }; })
      .finally(() => { resFetching = false; });
  }
  return resCache?.value;
}

// ─────────────────────────── 探测（probeDesktop / probeHeadless） ───────────────────────────

export async function macProbeDesktop(): Promise<ProbeInfo> {
  const info: ProbeInfo = { display: "aqua", available: false, atspi: false, kind: "macos", error: undefined };
  const [ws, consoleUser, mgr] = await Promise.all([windowServerRunning(), macConsoleUser(), macManagerName()]);
  if (!ws) { info.error = "WindowServer 未运行：无 GUI 会话"; return info; }
  if (!consoleUser || consoleUser === "root") {
    info.error = "停在登录窗口：无人登录 GUI 桌面（/dev/console 属主 root），GUI 应用无法显示；登录用户会话后恢复";
    return info;
  }
  if (me() && consoleUser !== me()) {
    info.error = `控制台登录用户是 ${consoleUser}，本扩展以 ${me()} 运行：GUI 应用无法显示到他人会话`;
    return info;
  }
  info.consoleUser = consoleUser;
  // Aqua 上下文非硬性（ssh 会话 spawn 的 GUI 有时也能连上 WindowServer）——降级为 warning 随探测带出
  if (mgr && mgr !== "Aqua") info.error = `本进程 launchd 上下文为 ${mgr}（非 Aqua）：GUI 可能无法显示；pi-web 请以 LaunchAgent 方式跑在用户 GUI 会话`;
  info.resolution = macDisplayResolution();
  info.wm = "WindowServer";
  info.available = true;
  return info;
}

export async function macProbeHeadless(): Promise<ProbeInfo> {
  const info: ProbeInfo = { display: "screensharing", available: false, atspi: false, kind: "macos", error: undefined };
  if (await macPortListening(5900)) {
    info.available = true;
    info.wm = "screensharingd";
    info.resolution = macDisplayResolution();
    return info;
  }
  info.error = "屏幕共享（VNC server）未开启：系统设置 → 通用 → 共享 → 屏幕共享；或 sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist（有免密 sudo 时 ui_env_headless start 可自动开启）";
  return info;
}

// ─────────────────────────── 无头层（= 屏幕共享 VNC） ───────────────────────────

/** 拉起「无头」层（macOS = 确保屏幕共享 VNC 开启）：
 *  已开 → true；有免密 sudo → launchctl load -w 系统 plist（幂等）+ 有限次等端口；
 *  否则 false（上层给系统设置/脚本指引）。不触碰其他系统服务。 */
export async function macEnsureHeadless(): Promise<boolean> {
  if (await macPortListening(5900)) return true;
  const sudoOk = (await macExec("sudo", ["-n", "true"], 4000)).code === 0;
  if (!sudoOk) return false;
  const r = await macExec("sudo", ["-n", "launchctl", "load", "-w", "/System/Library/LaunchDaemons/com.apple.screensharing.plist"], 10000);
  if (r.code !== 0) return false;
  // 事件驱动的有限次端口等待（同 winVncEnsure 模式，非常驻轮询）
  for (let i = 0; i < 12; i++) {
    await new Promise((res) => setTimeout(res, 500));
    if (await macPortListening(5900)) return true;
  }
  return false;
}

/** 停「无头」层（macOS = 无自管进程；屏幕共享是系统服务，不启停，仅由 env.ts 统一停 vnc-bridge） */
export async function macStopHeadless(): Promise<string[]> {
  return [];
}

// ─────────────────────────── 系统 VNC 探测 ───────────────────────────

/** 系统 VNC 探测：screensharingd / ARDAgent（屏幕共享）+ 5900-5910 端口兜底。
 *  屏幕共享是系统服务：stoppable=false（本扩展只桥接不启停）。 */
export async function macSystemVncScan(): Promise<SysVncEntry[]> {
  const list: SysVncEntry[] = [];
  const { out } = await runMac("ps", ["-axo", "pid,user,comm"], 6000);
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const name = m[3].split("/").pop() || "";
    if (name !== "screensharingd" && name !== "ARDAgent") continue;
    const listening = await macPortListening(5900);
    list.push({
      id: "sys-" + m[1],
      kind: "screensharing",
      display: "console",
      port: 5900,
      pid: Number(m[1]),
      ours: false,
      stoppable: false,
      listening,
      cmd: `macOS 屏幕共享（${name}${listening ? "，5900 监听中" : "，5900 未监听"}）`,
      passwordResettable: false,
      passwordNote: "macOS 屏幕共享用**系统账号密码**（不是 VNC 自己的密码）：请在『系统设置 → 通用 → 共享 → 屏幕共享』里改该用户的登录密码",
    });
    break;
  }
  // 未识别的 5900-5910 监听兜底。注意：macOS 屏幕共享是 launchd socket 激活——
  // launchd 常驻持有 5900，screensharingd 仅在有 VNC 客户端连入时才 spawn，
  // 进程扫描常见为空，5900 监听 + 无进程 ≈ 屏幕共享（高置信），如实标注激活模式。
  for (let p = 5900; p <= 5910; p++) {
    if ((await macPortListening(p)) && !list.some((e) => e.port === p)) {
      const isSharingPort = p === 5900;
      list.push({
        id: "port-" + p,
        kind: isSharingPort ? "screensharing" : "unknown",
        display: "console",
        port: p,
        ours: false,
        stoppable: false,
        listening: true,
        cmd: isSharingPort ? "macOS 屏幕共享（launchd socket 激活：连接时才 spawn 进程）或第三方 VNC" : undefined,
        passwordResettable: false,
        passwordNote: isSharingPort
          ? "macOS 屏幕共享用系统账号密码，请在『系统设置 → 共享 → 屏幕共享』里改；若为第三方 VNC 请在它自己的配置里改"
          : "未识别到已知 VNC server 进程，密码请在其自身配置里改",
      });
    }
  }
  return list;
}

// ─────────────────────────── deps 检测 / 安装 ───────────────────────────

export interface MacDepItem { bin: string; label: string; group: "core" | "ui"; installed: boolean; pkg: string | null; manual: string; }

export interface MacDepsStatus {
  os: string;
  distro: string;
  pkgMgr: string | null;
  sudo: boolean;
  coreMissing: MacDepItem[];
  uiMissing: MacDepItem[];
  allInstalled: boolean;
  manualHints: string[];
  manager: string | null;      // 本进程 launchd 上下文
  consoleUser: string | null;  // 控制台登录用户（root=登录窗口）
}

async function brewBin(): Promise<string | null> {
  for (const p of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  const r = await macExec("brew", ["--version"], 5000);
  return r.code === 0 ? "brew" : null;
}

async function findInPaths(names: string[]): Promise<string | null> {
  for (const n of names) {
    for (const p of [`/opt/homebrew/bin/${n}`, `/usr/local/bin/${n}`, `/usr/bin/${n}`, `/bin/${n}`]) {
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return null;
}

async function xQuartzInstalled(): Promise<boolean> {
  try {
    if (fs.existsSync("/opt/X11")) return true;
    if (fs.existsSync("/Applications/Utilities/XQuartz.app")) return true;
    if (fs.existsSync("/tmp/.X11-unix")) return true;
  } catch { /* ignore */ }
  return false;
}

export async function macCheckDeps(configDir: string): Promise<MacDepsStatus> {
  const [ver, consoleUser, manager, vncOn, sudoOk] = await Promise.all([
    macExec("/usr/bin/sw_vers", ["-productVersion"], 4000).then((r) => r.out.trim() || "macOS"),
    macConsoleUser(),
    macManagerName(),
    macPortListening(5900),
    macExec("sudo", ["-n", "true"], 4000).then((r) => r.code === 0),
  ]);
  const [brew, cliclick, xquartz] = await Promise.all([brewBin(), findInPaths(["cliclick"]), xQuartzInstalled()]);
  const hasNovnc = (() => { try { return fs.existsSync(cachePath(configDir, "novnc", "vnc.html")); } catch { return false; } })();
  const hasBridges = ["vnc-bridge.mjs", "rdp-bridge.mjs"].every((f) => { try { return fs.existsSync(cachePath(configDir, f)); } catch { return false; } });

  const core: MacDepItem[] = [
    { bin: "node", label: "Node.js（pi-web 运行环境）", group: "core", installed: true, pkg: null, manual: "pi-web 自带" },
    {
      bin: "aqua-session", label: "Aqua GUI 会话（pi-web 与控制台登录用户一致）", group: "core",
      installed: !!(consoleUser && consoleUser !== "root" && (!me() || consoleUser === me())),
      pkg: null,
      manual: `控制台登录用户=${consoleUser || "无（登录窗口）"}；pi-web 请以 LaunchAgent 跑在该用户 GUI 会话`,
    },
    {
      bin: "screensharing", label: "屏幕共享 VNC server（5900，浏览器查看层）", group: "core",
      installed: vncOn, pkg: null,
      manual: "系统设置 → 通用 → 共享 → 屏幕共享；或 sudo launchctl load -w /System/Library/LaunchDaemons/com.apple.screensharing.plist；或 scripts/macos/setup-macos.sh enable",
    },
    { bin: "novnc", label: "noVNC 静态页（浏览器查看层）", group: "core", installed: hasNovnc, pkg: null, manual: "重新部署扩展（deploy.mjs 拷贝 vendor 副本）" },
    { bin: "vnc/rdp-bridge", label: "VNC/RDP bridge（部署产物）", group: "core", installed: hasBridges, pkg: null, manual: "重新部署扩展" },
  ];
  const ui: MacDepItem[] = [
    { bin: "brew", label: "Homebrew（可选工具安装通道）", group: "ui", installed: !!brew, pkg: null, manual: "https://brew.sh（Intel 默认 /usr/local）" },
    { bin: "cliclick", label: "CLI 鼠标键盘自动化（mac 版 xdotool）", group: "ui", installed: !!cliclick, pkg: null, manual: "brew install cliclick" },
    { bin: "xquartz", label: "XQuartz（X11 应用支持，可选）", group: "ui", installed: xquartz, pkg: null, manual: "brew install --cask xquartz（装完有 /tmp/.X11-unix，可跑 x11vnc/xdotool）" },
    { bin: "screencapture", label: "系统截屏（排障快照；宿主 App 需屏幕录制权限）", group: "ui", installed: true, pkg: null, manual: "系统自带 /usr/sbin/screencapture" },
  ];
  const coreMissing = core.filter((c) => !c.installed);
  const uiMissing = ui.filter((c) => !c.installed);

  const hints: string[] = [];
  if (consoleUser === "root") hints.push("Mac 停在登录窗口（无人登录 GUI）：登录用户会话后桌面才可用");
  else if (consoleUser && me() && consoleUser !== me()) hints.push(`控制台用户 ${consoleUser} ≠ 扩展用户 ${me()}：GUI 无法落到桌面`);
  if (manager && manager !== "Aqua") hints.push(`pi-web 进程 launchd 上下文 = ${manager}（非 Aqua）：建议以 LaunchAgent（gui 域）运行`);
  if (!vncOn) hints.push(sudoOk ? "屏幕共享未开：ui_env_headless start 可自动开启（有免密 sudo）" : "屏幕共享未开：系统设置 → 通用 → 共享 → 屏幕共享（无免密 sudo，无法自动开启）");
  if (!brew) hints.push("未装 Homebrew：cliclick/XQuartz 等可选工具装不了（不影响核心链路）");

  return {
    os: "macos",
    distro: "macOS " + ver,
    pkgMgr: brew ? "brew" : null,
    sudo: sudoOk,
    coreMissing,
    uiMissing,
    allInstalled: coreMissing.length === 0,
    manualHints: hints,
    manager,
    consoleUser,
  };
}

/** 安装（macOS 保守策略）：core 项不改系统状态（屏幕共享的自动开启在 ensureHeadless 链路，
 *  免密 sudo 时 ui_env_headless start 触发）；本函数只补可选增强：brew 存在 → 装 cliclick。
 *  XQuartz（cask，体积大 + 可能弹 GUI 确认）只给指引不自动装。 */
export async function macInstallDeps(configDir: string): Promise<{ ran: boolean; error?: string; log?: string }> {
  void configDir;
  const log: string[] = [];
  const brew = await brewBin();
  if (!brew) {
    return { ran: false, log: "未装 Homebrew：无可自动安装项。屏幕共享走系统设置/（免密 sudo）ui_env_headless start；cliclick/XQuartz 需先装 brew。" };
  }
  if (!(await findInPaths(["cliclick"]))) {
    const r = await macExec(brew, ["install", "cliclick"], 180000);
    log.push(`brew install cliclick → exit ${r.code}${r.out ? "\n" + r.out.slice(-400) : ""}`);
    if (r.code !== 0) return { ran: true, error: "brew install cliclick 失败（见 log）", log: log.join("\n") };
  } else {
    log.push("cliclick 已装，跳过");
  }
  log.push("XQuartz（可选）：brew install --cask xquartz（X11 应用支持；不装不影响本扩展核心链路）");
  return { ran: true, log: log.join("\n") };
}

// ─────────────────────────── 安装状态（面板 tools 徽章） ───────────────────────────

export async function macInstallStatus(configDir: string): Promise<{ os: string; tools: Record<string, boolean>; units: Record<string, "active" | "inactive" | "missing"> }> {
  const [consoleUser, vncOn, brew] = await Promise.all([
    macConsoleUser(),
    macPortListening(5900),
    brewBin(),
  ]);
  const hasNovnc = (() => { try { return fs.existsSync(cachePath(configDir, "novnc", "vnc.html")); } catch { return false; } })();
  const hasBridges = ["vnc-bridge.mjs", "rdp-bridge.mjs"].every((f) => { try { return fs.existsSync(cachePath(configDir, f)); } catch { return false; } });
  return {
    os: "macos",
    tools: {
      node: true,
      "Aqua会话": !!(consoleUser && consoleUser !== "root" && (!me() || consoleUser === me())),
      "屏幕共享VNC": vncOn,
      noVNC: hasNovnc,
      "vnc/rdp-bridge": hasBridges,
      brew: !!brew,
      screencapture: true,
    },
    units: {},
  };
}
