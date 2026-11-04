/**
 * aiti-ui-env · Windows 平台实现（process.platform === "win32" 专用）
 *
 * 设计（docs/aiti-ui-env-windows-support-plan.md）：
 * - 主桌面：交互会话证据（SESSIONNAME + explorer.exe + 屏幕枚举）。env 不带 DISPLAY，
 *   子进程继承 pi-web 所在交互会话即落桌面。
 * - 虚拟屏（headless）：诚实降级 = 虚拟显示驱动（PnP Display 类）+ VNC server 就绪。
 *   GUI 仍落交互会话桌面（Windows 单桌面架构无进程隔离），区别在查看通道与无屏可用性。
 * - VNC：自管便携 UltraVNC winvnc（ultravnc.portable 标记 + exe 同目录 ini，仅回环 +
 *   随机密码 VNCAuth）；系统安装（Program Files 服务型）只探测/复用不启停。
 * - RDP：rdp-bridge 客户端桥平台无关（env.ts）；此处只做 TermService/3389 探测。
 * - deps：winget/安装检测 + justget 下载兜底（UltraVNC 便携包）。
 *
 * 编码注意：PowerShell 统一 [Console]::OutputEncoding=UTF8；netstat/tasklist 输出为
 * 系统 OEM 码页（中文系统 GBK），但只解析 ASCII 结构（端口数字/LISTENING/exe 名），乱码无影响。
 */

import { spawn, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProbeInfo, SysVncEntry, SysRdpEntry } from "./env.js";

/** 数据分层（三目录对称 2026-09-13）：configDir = <extRoot>/config，cache 在 <extRoot>/cache 下。 */
function cachePath(configDir: string, ...segments: string[]): string {
  return path.join(path.dirname(configDir), "cache", ...segments);
}

export interface WinDepsStatus {
  os: string;
  distro: string;
  pkgMgr: string | null;
  sudo: boolean;
  coreMissing: { bin: string; label: string; group: "core" | "ui"; installed: boolean; pkg: string | null; manual: string }[];
  uiMissing: { bin: string; label: string; group: "core" | "ui"; installed: boolean; pkg: string | null; manual: string }[];
  allInstalled: boolean;
  manualHints: string[];
  // Windows 附加探测
  session: string | null;       // SESSIONNAME（Console / RDP-Tcp#n / 空=服务上下文）
  vddDriver: string | null;     // 虚拟显示驱动名（已装）
  winvncPath: string | null;    // 找到的 winvnc.exe
  winvncPortable: boolean;      // 是否便携模式（本扩展可管 ini）
  winvncRunning: boolean;
}

// ─────────────────────────── 进程/命令工具 ───────────────────────────

export function winExec(cmd: string, args: string[], timeoutMs = 5000, maxBuffer = 4 << 20): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer, windowsHide: true },
      (err: (Error & { code?: number }) | null, stdout: string) =>
        resolve({ out: String(stdout || ""), code: err ? ((err as any).code ?? 1) : 0 }));
  });
}

/** PowerShell 执行（-NoProfile -NonInteractive；输出统一 UTF8） */
export async function winPwsh(script: string, timeoutMs = 8000): Promise<string> {
  const full = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
  const r = await winExec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", full], timeoutMs);
  return r.out;
}

/** 写临时脚本文件执行（含 Add-Type 等多行脚本用；调用方负责清理） */
export async function winPwshFile(scriptPath: string, args: string[] = [], timeoutMs = 15000): Promise<string> {
  const r = await winExec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], timeoutMs);
  return r.out;
}

/** 端口监听探测（netstat -an 解析 LISTENING；netstat 输出 GBK 但 ASCII 结构可解析） */
export async function winPortListening(port: number): Promise<boolean> {
  const { out } = await winExec("netstat", ["-an"], 5000);
  if (!out) return false;
  const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING`, "i");
  return re.test(out);
}

/** 解析可执行文件：PATH（where）→ 常见安装目录（含便携位置） */
export async function winResolveBin(bin: string, extraDirs: string[] = []): Promise<string | null> {
  const { out } = await winExec("where", [bin], 4000);
  const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.toLowerCase().endsWith(".exe") && fs.existsSync(s));
  if (first) return first;
  const dirs = [
    ...extraDirs,
    process.env["ProgramFiles"] ? path.join(process.env["ProgramFiles"], bin.replace(/\.exe$/i, "")) : "",
    process.env["ProgramFiles"] || "",
    process.env["LocalAppData"] ? path.join(process.env["LocalAppData"], "Programs") : "",
  ].filter(Boolean);
  for (const d of dirs) {
    const p = d.toLowerCase().endsWith(".exe") ? d : path.join(d, bin);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

// ─────────────────────────── VNC server（自管便携 UltraVNC） ───────────────────────────

/** UltraVNC 便携包直链（uvnc.eu 官方；justget 兜底见 deps 安装） */
export const ULTRAVNC_ZIP_URL = "https://uvnc.eu/download/1800/UltraVNC_1829.zip";

/** 找自管便携 winvnc.exe：configDir/ultravnc → D:\apps\ultravnc → 其他已知便携位置；
 *  系统 Program Files 安装型由 findSystemWinVnc 单独探测（只复用不接管）。 */
export function findPortableWinVnc(configDir: string): string | null {
  const candidates = [
    process.env.UI_ENV_WINVNC_EXE || "",
    cachePath(configDir, "ultravnc", "winvnc.exe"), // ui_env_deps install 装到 <extRoot>/cache/ultravnc
    path.join(configDir, "ultravnc", "winvnc.exe"), // 历史位置兼容（<extRoot>/config/ultravnc）
    "D:\\apps\\ultravnc\\winvnc.exe",
    "C:\\apps\\ultravnc\\winvnc.exe",
    path.join(os.homedir(), "ultravnc", "winvnc.exe"),
    path.join(os.homedir(), "apps", "ultravnc", "winvnc.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

/** 系统（Program Files）UltraVNC / TightVNC 安装探测（只探测/复用，不接管配置） */
export function findSystemWinVnc(): { path: string; kind: "ultravnc" | "tightvnc" } | null {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const cands: { path: string; kind: "ultravnc" | "tightvnc" }[] = [
    { path: path.join(pf, "uvnc bvba", "UltraVNC", "winvnc.exe"), kind: "ultravnc" },
    { path: path.join(pf, "UltraVNC", "winvnc.exe"), kind: "ultravnc" },
    { path: path.join(pf86, "uvnc bvba", "UltraVNC", "winvnc.exe"), kind: "ultravnc" },
    { path: path.join(pf, "TigerVNC", "winvnc.exe"), kind: "ultravnc" },
    { path: path.join(pf, "TightVNC", "tvnserver.exe"), kind: "tightvnc" },
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c.path)) return c; } catch { /* ignore */ }
  }
  return null;
}

/** 自管 winvnc 进程 pid 记录文件 */
function vncPidFile(configDir: string): string { return cachePath(configDir, "win-winvnc.pid"); }
export function winVncSelfPid(configDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(vncPidFile(configDir), "utf8").trim());
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 0); return pid; } catch { return null; }
    }
  } catch { /* ignore */ }
  return null;
}

/** VNC 密码（≤8 字符，UltraVNC VNC auth 上限）：env UI_ENV_VNC_PASSWORD 优先 → configDir/vnc-passwd 持久化。
 *  未设置返回 null —— 由上层提示用户输入（安装/启动时），不再随机生成藏起来。
 *  密码是「用户自己知道的那个」：VNC server 用它做认证，桥/浏览器不再代答。 */
export function winVncPassword(configDir: string): string | null {
  const envPw = process.env.UI_ENV_VNC_PASSWORD;
  if (envPw && envPw.trim()) return envPw.trim().slice(0, 8);
  try {
    const file = path.join(configDir, "vnc-passwd");
    if (fs.existsSync(file)) {
      const pw = fs.readFileSync(file, "utf8").trim().slice(0, 8);
      if (pw) return pw;
    }
  } catch { /* ignore */ }
  return null;
}

/** 持久化用户设定的 VNC 密码（安装/启动时提示输入；1~8 字符，超出截断）。 */
export function winVncPasswordSet(configDir: string, pw: string): { ok: boolean; password?: string; error?: string } {
  const p = String(pw ?? "").trim().slice(0, 8);
  if (!p) return { ok: false, error: "VNC 密码不能为空" };
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "vnc-passwd"), p, { mode: 0o600 });
    try { fs.rmSync(path.join(configDir, "vnc-rfb-passwd"), { force: true }); } catch { /* 历史随机密码文件，清掉 */ }
    return { ok: true, password: p };
  } catch (e) {
    return { ok: false, error: String((e as Error).message) };
  }
}

const SET_VNC_INI_PS = String.raw`
param([string]$VncDir, [string]$Pw)
$ErrorActionPreference = "Stop"
Add-Type -Namespace Win32 -Name Prof -MemberDefinition @'
[DllImport("kernel32.dll", CharSet=CharSet.Ansi)] public static extern bool WritePrivateProfileString(string sect, string key, string val, string file);
'@
$ini = Join-Path $VncDir "ultravnc.ini"
New-Item -ItemType File -Force (Join-Path $VncDir "ultravnc.portable") | Out-Null
# 整体重建：winvnc 退出时会回写它内存里的旧配置，残留键（旧 passwd/passwd2/大小写变体）会让
# 新密码不生效；所以每次先删文件再写一份干净的，且只写小写 passwd。
Remove-Item -LiteralPath $ini -Force -ErrorAction SilentlyContinue
# UltraVNC 专有密码存储：DES-ECB(data=密码补零到 8 字节, key = E8 4A D6 60 C4 72 1A E0)
# ⚠ 不是标准 VNC 的固定钥匙 17 52 6B 06 23 4E 58 07（用错钥匙 server 解出乱码，认证必败）。
# 官方格式 = 8 字节密文 + 1 字节校验（UltraVNC 忽略该字节）的 hex。
$uvkey = [byte[]](232,74,214,96,196,114,26,224)
$pb = [System.Text.Encoding]::ASCII.GetBytes($Pw)
$data = New-Object byte[] 8
for ($i = 0; $i -lt [Math]::Min(8, $pb.Length); $i++) { $data[$i] = $pb[$i] }
$des = New-Object System.Security.Cryptography.DESCryptoServiceProvider
$des.Mode = [System.Security.Cryptography.CipherMode]::ECB
$des.Padding = [System.Security.Cryptography.PaddingMode]::None
$des.Key = $uvkey; $des.IV = New-Object byte[] 8
$h = $des.CreateEncryptor().TransformFinalBlock($data, 0, 8)
$hex = (($h | ForEach-Object { $_.ToString('X2') }) -join '') + '00'
[Win32.Prof]::WritePrivateProfileString("admin","AutoPortSelect","0",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","PortNumber","5900",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","LoopbackOnly","1",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","AllowLoopback","1",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","HTTPConnect","0",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","FileTransferEnabled","0",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","IdleTimeout","0",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","QueryAccept","0",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("admin","Secure","0",$ini) | Out-Null
[Win32.Prof]::WritePrivateProfileString("UltraVNC","passwd",$hex,$ini) | Out-Null
Write-Output "OK"
`;

/** 写便携 winvnc 配置（portable 标记 + ini + 用户密码）。密码由调用方给出（winVncPassword）。 */
export async function winVncWriteIni(vncDir: string, configDir: string, pw: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const ps = cachePath(configDir, "tmp-set-vnc-ini.ps1");
    fs.mkdirSync(configDir, { recursive: true });
    // ⚠ 必须带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 文件按 ANSI 解码，脚本里的中文注释
    //   会被误解码，某些字节会拼出「行尾反引号」把下一行代码吞掉（实证 $uvkey 变 null）。
    fs.writeFileSync(ps, "\uFEFF" + SET_VNC_INI_PS);
    const out = await winPwshFile(ps, ["-VncDir", vncDir, "-Pw", pw], 20000);
    try { fs.rmSync(ps, { force: true }); } catch { /* ignore */ }
    if (!out.includes("OK")) return { ok: false, error: out.slice(-300) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message) };
  }
}

/** 重设 VNC 密码的通用入口（Windows）：自管便携 winvnc（ini+重启）+ 系统安装 UltraVNC/TightVNC（注册表）。
 *  两者都存在就都写（用户可能用任一个）；都找不到 → 报错。 */
export async function winResetVncPassword(
  configDir: string,
  pw: string,
  _opts: { id?: string } = {},
): Promise<{ ok: boolean; applied: string[]; errors: string[]; restartRequired: boolean; error?: string }> {
  const applied: string[] = [];
  const errors: string[] = [];
  const set = winVncPasswordSet(configDir, pw);
  if (!set.ok) return { ok: false, applied, errors, restartRequired: false, error: set.error };
  const p = set.password!;

  // 1) 自管便携 winvnc：写 ultravnc.ini（UltraVNC 专有钥匙）并重启生效
  const portable = findPortableWinVnc(configDir);
  if (portable) {
    const r = await winVncEnsure(configDir);
    if (r.ok) applied.push(`自管便携 winvnc（${path.dirname(portable)}）已重写并重启`);
    else errors.push("自管便携 winvnc：" + (r.error || "未知错误"));
  }

  // 2) 系统安装的 UltraVNC / TightVNC：写注册表（需管理员；HKLM 双视图都试）
  const sys = findSystemWinVnc();
  if (sys?.kind === "ultravnc") {
    const r = await winSetRegistryVncPassword([
      "HKLM:\\SOFTWARE\\UltraVNC\\Server",
      "HKLM:\\SOFTWARE\\WOW6432Node\\UltraVNC\\Server",
    ], "passwd", p, "E8 4A D6 60 C4 72 1A E0"); // UltraVNC 专有 DES 钥匙
    if (r.ok) applied.push(`系统安装 UltraVNC（${sys.path}）注册表已写`);
    else errors.push("系统安装 UltraVNC 注册表写入失败" + (r.error ? "：" + r.error : "（需管理员权限）"));
  } else if (sys?.kind === "tightvnc") {
    const r = await winSetRegistryVncPassword([
      "HKLM:\\SOFTWARE\\TightVNC\\Server",
      "HKLM:\\SOFTWARE\\WOW6432Node\\TightVNC\\Server",
    ], "Password", p, "17 52 6B 06 23 4E 58 07"); // TightVNC 走标准 VNC 钥匙
    if (r.ok) applied.push(`系统安装 TightVNC（${sys.path}）注册表已写`);
    else errors.push("系统安装 TightVNC 注册表写入失败" + (r.error ? "：" + r.error : "（需管理员权限）"));
  }

  if (!portable && !sys) {
    return { ok: false, applied, errors, restartRequired: false, error: "未找到 winvnc/tvnserver（先跑 ui_env_deps install 或安装系统版）" };
  }
  return { ok: applied.length > 0, applied, errors, restartRequired: !portable && !!sys };
}

/** 写 HKLM 注册表 VNC 密码（REG_BINARY 8 字节）：DES 在 PowerShell/.NET 里算（不在 JS 侧自实现 DES）。
 *  keyHex = VNC 存储钥匙的 hex（UltraVNC 自有 / 标准 vncpasswd 各不相同）。 */
async function winSetRegistryVncPassword(paths: string[], name: string, pw: string, keyHex: string): Promise<{ ok: boolean; error?: string }> {
  const key = keyHex.split(/\s+/).map((h) => "0x" + h).join(",");
  const ps = [
    "$ErrorActionPreference='Stop'",
    `$key=[byte[]](${key})`,
    "$data=New-Object byte[] 8",
    `$pb=[System.Text.Encoding]::ASCII.GetBytes('${pw.replace(/'/g, "''")}')`,
    "for($i=0;$i -lt [Math]::Min(8,$pb.Length);$i++){ $data[$i]=$pb[$i] }",
    "$des=New-Object System.Security.Cryptography.DESCryptoServiceProvider",
    "$des.Mode='ECB'; $des.Padding='None'; $des.Key=$key; $des.IV=New-Object byte[] 8",
    "$b=$des.CreateEncryptor().TransformFinalBlock($data,0,8)",
    "$done=@()",
    `foreach($p in @(${paths.map((x) => `'${x}'`).join(",")})){`,
    "  try { if(-not (Test-Path $p)){ New-Item -Path $p -Force | Out-Null }",
    `        Set-ItemProperty -Path $p -Name '${name}' -Value $b -Type Binary -ErrorAction Stop`,
    "        $done += $p } catch { Write-Error $_.Exception.Message }",
    "}",
    "Write-Output ('OK:' + ($done -join ';'))",
  ].join("; ");
  const out = await winPwsh(ps, 15000);
  if (out.includes("OK:")) return { ok: true };
  return { ok: false, error: out.trim().slice(-200) };
}

/** 杀本扩展自管 winvnc（pid 文件精确匹配，不碰用户进程） */export async function winVncKillSelf(configDir: string): Promise<boolean> {
  const pid = winVncSelfPid(configDir);
  if (!pid) return false;
  try { process.kill(pid); } catch { /* 已退出 */ }
  try { fs.rmSync(vncPidFile(configDir), { force: true }); } catch { /* ignore */ }
  return true;
}

/** 兜底：pid 文件失准时（手工启动/崩溃遗留），若 5900 仍被占且占用者正是本目录的 winvnc.exe，
 *  杀掉它（只杀自管 exe，目录不符 → 判为系统/用户 VNC，一律不碰）。返回是否杀过。 */
async function winVncKillPortOwner(vncDir: string): Promise<boolean> {
  const out = await winPwsh(
    `$c = Get-NetTCPConnection -LocalPort 5900 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
    `if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; Write-Output ("" + $c.OwningProcess + "|" + $p.Path) }`,
    8000,
  );
  const line = out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || "";
  const m = /^(\d+)\|(.+)$/.exec(line);
  if (!m) return false;
  const pid = Number(m[1]);
  const owner = m[2].trim();
  const sameDir = path.resolve(path.dirname(owner)).toLowerCase() === path.resolve(vncDir).toLowerCase();
  if (!sameDir || !/^winvnc\.exe$/i.test(path.basename(owner))) return false;
  try { process.kill(pid); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));
  return true;
}

/** 确保自管 winvnc 在跑：杀旧 → 写 ini（用户密码）→ 起新 → 记 pid。
 *  顺序有讲究：必须先杀旧再写 ini —— winvnc 退出时会把内存里的旧配置回写 ultravnc.ini，
 *  先写后杀会让新密码被覆盖（历史 bug 之一）。
 *  needPassword=true 表示还没设过密码：上层需提示用户输入后重试。 */
export async function winVncEnsure(configDir: string): Promise<{ ok: boolean; path?: string; error?: string; needPassword?: boolean }> {
  const exe = findPortableWinVnc(configDir);
  if (!exe) {
    const sys = findSystemWinVnc();
    return { ok: false, error: sys
      ? `未找到便携 winvnc（系统安装 ${sys.path} 属服务型，本扩展不接管；请将 UltraVNC 便携版解压到 ${cachePath(configDir, "ultravnc")} 或设置 UI_ENV_WINVNC_EXE）`
      : `未找到 winvnc.exe：跑 ui_env_deps install 自动安装便携 UltraVNC，或设置 UI_ENV_WINVNC_EXE 指向 winvnc.exe` };
  }
  const vncDir = path.dirname(exe);
  const pw = winVncPassword(configDir);
  if (!pw) return { ok: false, needPassword: true, error: "未设置 VNC 密码：VNC 连接需要密码认证，请先设置（安装/启动时会提示输入 1~8 位密码）" };
  await winVncKillSelf(configDir);
  await winVncKillPortOwner(vncDir); // pid 文件失准时的兜底（仅杀同目录 winvnc.exe）
  await new Promise((r) => setTimeout(r, 600));
  const w = await winVncWriteIni(vncDir, configDir, pw);
  if (!w.ok) return { ok: false, error: `写 winvnc 配置失败（${vncDir}）：${w.error || ""}` };
  try {
    const logFd = fs.openSync(cachePath(configDir, "logs", "winvnc.log"), "a"); // 数据分层：日志 → <extRoot>/cache/logs
    const child = spawn(exe, [], { detached: true, stdio: ["ignore", logFd, logFd], cwd: vncDir, windowsHide: false });
    child.unref();
    fs.closeSync(logFd);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(vncPidFile(configDir), String(child.pid));
    // 等端口起来（事件驱动的有限次探测，非常驻轮询；首跑含 Add-Type 编译较慢）
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await winPortListening(5900)) return { ok: true, path: exe };
    }
    return { ok: true, path: exe }; // 起了但端口未就绪（慢启动），交给上层探测
  } catch (e) {
    return { ok: false, error: "winvnc 启动失败：" + String((e as Error).message) };
  }
}

// ─────────────────────────── 探测 ───────────────────────────

/** 虚拟显示驱动（PnP Display 类，Idd/Virtual/Oray/间接显示系） */
async function winProbeVdd(): Promise<string | null> {
  const out = await winPwsh(
    `try { Get-PnpDevice -Class Display -Status OK -ErrorAction Stop | Where-Object { $_.FriendlyName -match 'Idd|Virtual|Oray|间接|Indirect' } | Select-Object -First 1 -ExpandProperty FriendlyName } catch { '' }`,
    10000);
  const name = out.trim();
  return name || null;
}

export async function winProbeDesktop(): Promise<ProbeInfo> {
  const info: ProbeInfo = { display: "console", available: false, atspi: false, error: undefined };
  // 会话判定用进程 SessionId（schtasks/vbs 启动链的 env 无 SESSIONNAME，不可靠）：
  // 自身 SessionId == explorer.exe 的 SessionId → 同一交互会话，GUI 可落桌面。
  const sessOut = await winPwsh(
    `$my=[System.Diagnostics.Process]::GetCurrentProcess().SessionId; ` +
    `$e=(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1); ` +
    `if ($e) { Write-Output (\"$my $($e.SessionId)\") } else { Write-Output (\"$my none\") }`,
    10000);
  const parts = sessOut.trim().split(/\s+/);
  const mySid = Number(parts[0]);
  const expSid = parts[1] && parts[1] !== "none" ? Number(parts[1]) : null;
  if (expSid === null) {
    info.display = "session:" + mySid;
    info.error = "无 explorer.exe（Shell 未运行），桌面不可用";
    return info;
  }
  if (mySid !== expSid) {
    info.display = "session:" + mySid;
    info.error = `扩展进程在 Session ${mySid}（非交互，如服务上下文 Session 0），而桌面 Shell 在 Session ${expSid}：GUI 应用无法显示。请把 pi-web 跑在用户登录会话内（schtasks onlogon / 手动启动）`;
    return info;
  }
  info.display = "session:" + mySid;
  const res = await winPwsh(
    `Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output ("$($b.Width)x$($b.Height)"); Write-Output ([System.Windows.Forms.Screen]::AllScreens.Count)`,
    10000);
  const lines = res.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines[0]) info.resolution = lines[0] + (lines[1] ? ` x${lines[1]}屏` : "");
  info.kind = "windows";
  info.wm = "explorer";
  info.available = true;
  return info;
}

/** Windows headless 探测：虚拟显示驱动 + VNC 层就绪度（available 以 VNC 层为准） */
export async function winProbeHeadless(configDir: string): Promise<ProbeInfo> {
  const info: ProbeInfo = { display: "virtual", available: false, atspi: false, error: undefined };
  const [vdd, rfbOn] = await Promise.all([winProbeVdd(), winPortListening(5900)]);
  if (vdd) info.wm = "vdd"; // 复用字段提示虚拟驱动已装（kind=windows 在 buildEnv 里不需要）
  info.kind = "windows";
  const selfPid = winVncSelfPid(configDir);
  if (rfbOn) {
    info.available = true;
    info.resolution = vdd ? undefined : "物理/虚拟屏共享";
    if (!vdd) info.error = "VNC 就绪但未检测到虚拟显示驱动：无物理显示器时可能黑屏（可跑 setup-windows.ps1 装虚拟驱动，或 UltraVNC 自带 UVncVirtualDisplay 驱动）";
    return info;
  }
  info.error = selfPid
    ? "自管 winvnc 已 spawn 但 5900 未监听（启动中或失败，看 configDir/logs/winvnc.log）"
    : "Windows 虚拟屏（虚拟显示驱动 + VNC server）未就绪：跑 ui_env_headless start 拉起自管 VNC（headless 档）";
  return info;
}

/** 停 Windows 虚拟屏相关自管进程（仅自管 winvnc；bridge 由 env.ts 统一停） */
export async function winStopHeadless(configDir: string): Promise<string[]> {
  const stopped: string[] = [];
  if (await winVncKillSelf(configDir)) stopped.push("winvnc(自管)");
  await new Promise((r) => setTimeout(r, 500));
  return stopped;
}

// ─────────────────────────── 运行 ───────────────────────────

/** Windows 后台启动：cmd /c（GUI 落当前交互会话桌面；日志重定向由 env.ts 处理 fd） */
export async function winRun(cmd: string, env: Record<string, string>, logFile: string): Promise<{ ok: boolean; pid?: number; error?: string }> {
  try {
    const out = fs.openSync(logFile, "a");
    try {
      const child = spawn("cmd.exe", ["/d", "/s", "/c", cmd], {
        env: { ...process.env, ...env },
        detached: true,
        stdio: ["ignore", out, out],
        cwd: process.cwd() || os.homedir(),
        windowsHide: true, // 隐藏 cmd 控制台窗；GUI 子进程窗口不受影响
      });
      child.unref();
      return { ok: true, pid: child.pid };
    } finally {
      fs.closeSync(out);
    }
  } catch (e) {
    return { ok: false, error: String((e as Error).message) };
  }
}

// ─────────────────────────── 系统 VNC / RDP 扫描 ───────────────────────────

const VNC_PROCS = ["winvnc.exe", "tvnserver.exe", "vncserver.exe", "winvnc4.exe"];

export async function winSystemVncScan(configDir?: string): Promise<SysVncEntry[]> {
  const list: SysVncEntry[] = [];
  // 自管便携 winvnc 也跑 winvnc.exe → 单独识别，给出准确的重设说明（写 ini + 自动重启，而非注册表）
  const selfPortable = configDir ? findPortableWinVnc(configDir) : null;
  const { out } = await winExec("tasklist", ["/FO", "CSV", "/NH"], 6000);
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const pid = Number(m[2]);
    if (!VNC_PROCS.includes(name)) continue;
    let isSelf = false;
    if (selfPortable) {
      const p = (await winPwsh(`$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){ $p.Path }`, 6000)).trim().split(/\r?\n/).pop()?.trim() || "";
      isSelf = !!p && path.resolve(p).toLowerCase() === path.resolve(selfPortable).toLowerCase();
    }
    list.push({
      id: "sys-" + pid,
      kind: name.includes("tvnserver") ? "tightvnc" : "ultravnc",
      display: "console",
      port: 5900,
      pid,
      ours: isSelf,       // 自管便携（自管实例本身在扩展 VNC 列表，这里只作信息展示）
      stoppable: false, // Windows 版不做系统 VNC 进程启停（可能是用户服务）
      listening: await winPortListening(5900),
      cmd: name,
      passwordResettable: true,
      passwordNote: isSelf
        ? "本扩展自管便携 winvnc：重设会重写 ultravnc.ini 并自动重启（立即生效）"
        : "写 HKLM 注册表（UltraVNC 用其专有 DES 钥匙 / TightVNC 用标准钥匙），需管理员权限；重启该服务后生效",
    });
    break; // 5900 只有一个 owner
  }
  if (!list.length && (await winPortListening(5900))) {
    list.push({ id: "port-5900", kind: "unknown", display: "console", port: 5900, ours: false, stoppable: false, listening: true,
      passwordResettable: false, passwordNote: "未识别到已知 VNC server 进程（可能是其它实现），密码请在其自身配置里改" });
  }
  return list;
}

export async function winSystemRdpScan(): Promise<SysRdpEntry[]> {
  const out = await winPwsh(
    `$s = Get-Service TermService -ErrorAction SilentlyContinue; if ($s) { Write-Output ("$($s.Status)") } else { Write-Output "missing" }`,
    8000);
  const status = out.trim() || "missing";
  const listening = await winPortListening(3389);
  const isHomeEdition = await winPwsh(
    `(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion").EditionID`,
    8000);
  const edition = isHomeEdition.trim();
  const homeLike = /Core|Home/i.test(edition);
  return [{
    id: "sys-term",
    kind: "TermService" + (homeLike ? "（Home 版无 RDP 服务端）" : ""),
    display: status,
    port: 3389,
    ours: false,
    stoppable: false,
    listening,
    cmd: homeLike
      ? `Windows ${edition}：无系统 RDP 服务端（被看请用 VNC-on-web；本机作为 RDP 客户端桥连其他机器可用）`
      : `TermService ${status}${listening ? "，3389 监听中（sys-open 可桥接）" : "，3389 未监听"}`,
  }];
}

// ─────────────────────────── deps 检测 / 安装 ───────────────────────────

export async function winCheckDeps(configDir: string): Promise<WinDepsStatus> {
  // 交互会话检查（SessionId 对比，与 winProbeDesktop 同逻辑）
  const sessOut = await winPwsh(
    `$my=[System.Diagnostics.Process]::GetCurrentProcess().SessionId; ` +
    `$e=(Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1); ` +
    `if ($e) { Write-Output (\"$my $($e.SessionId)\") } else { Write-Output (\"$my none\") }`,
    10000);
  const sp = sessOut.trim().split(/\s+/);
  const session = sp[0] === undefined ? null : (sp[1] === sp[0] ? "session:" + sp[0] : null);
  const [vdd, portable, sys] = await Promise.all([
    winProbeVdd(),
    Promise.resolve(findPortableWinVnc(configDir)),
    Promise.resolve(findSystemWinVnc()),
  ]);
  const winvncPath = portable || sys?.path || null;
  const winvncPortable = !!portable;
  const winvncRunning = await winPortListening(5900);
  const novncDir = [cachePath(configDir, "novnc"), cachePath(configDir, "grdpwasm")];
  const hasNovnc = novncDir.some((d) => { try { return fs.existsSync(path.join(d, "vnc.html")) || fs.existsSync(path.join(d, "index.html")); } catch { return false; } });
  const hasBridges = ["vnc-bridge.mjs", "rdp-bridge.mjs"].every((f) => { try { return fs.existsSync(path.join(configDir, f)); } catch { return false; } });

  const core = [
    { bin: "node", label: "Node.js（pi-web 运行环境）", installed: true, manual: "pi-web 自带" },
    { bin: "winvnc(便携)", label: "VNC server（便携 UltraVNC，自管）", installed: !!portable, manual: `ui_env_deps install 自动下载便携包 → ${cachePath(configDir, "ultravnc")}；或 UI_ENV_WINVNC_EXE 指向已有 winvnc.exe` },
    { bin: "novnc", label: "noVNC 静态页（浏览器查看层）", installed: hasNovnc, manual: "重新部署扩展（deploy.mjs 拷贝 vendor 副本）" },
    { bin: "vnc-bridge", label: "VNC/RDP bridge（部署产物）", installed: hasBridges, manual: "重新部署扩展" },
  ];
  const ui = [
    { bin: "vdd-driver", label: "虚拟显示驱动（无物理屏时出画面）", installed: !!vdd, manual: "已检测到: " + (vdd || "无——setup-windows.ps1 安装 IddSampleDriver/usbmmidd，或 UltraVNC 自带 UVncVirtualDisplay（winvnc.exe -installdriver，需管理员）") },
  ];
  const coreMissing = core.filter((c) => !c.installed).map((c) => ({ ...c, group: "core" as const, pkg: null }));
  const uiMissing = ui.filter((c) => !c.installed).map((c) => ({ ...c, group: "ui" as const, pkg: null }));
  const hints: string[] = [];
  if (!session) hints.push("扩展进程不在交互会话（SessionId 与 explorer 不一致）：GUI 应用无法落桌面，请在用户登录会话内运行 pi-web");
  if (!portable && !sys) hints.push(`缺 VNC server：ui_env_deps install 自动安装便携 UltraVNC 到 ${cachePath(configDir, "ultravnc")}`);
  else if (!portable && sys) hints.push(`检测到系统安装 VNC（${sys.path}）：本扩展只复用不接管；建议安装便携版以获得自管能力`);
  if (!vdd) hints.push("虚拟显示驱动未装（可选）：无物理显示器时需要它出画面");
  return {
    os: "windows",
    distro: "Windows",
    pkgMgr: null,
    sudo: false,
    coreMissing,
    uiMissing,
    allInstalled: coreMissing.length === 0,
    manualHints: hints,
    session,
    vddDriver: vdd,
    winvncPath,
    winvncPortable,
    winvncRunning,
  };
}

/** 安装便携 UltraVNC：node fetch 下载 zip → PowerShell Expand-Archive 解压到 configDir/ultravnc。
 *  免安装、免管理员、免 UAC（推荐路线；winget TightVNC 需 UAC 且配置为服务型，不采用）。 */
export async function winInstallDeps(configDir: string): Promise<{ ran: boolean; error?: string; log?: string }> {
  const dest = cachePath(configDir, "ultravnc");
  try {
    if (fs.existsSync(path.join(dest, "winvnc.exe"))) {
      return { ran: false, error: undefined, log: `已存在：${dest}` };
    }
    fs.mkdirSync(dest, { recursive: true });
    const zipPath = cachePath(configDir, "ultravnc.zip");
    const r = await fetch(ULTRAVNC_ZIP_URL, { redirect: "follow" });
    if (!r.ok) return { ran: true, error: `下载失败 HTTP ${r.status}（${ULTRAVNC_ZIP_URL}）` };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1024 * 1024) return { ran: true, error: `下载内容异常（${buf.length}B，非 zip）` };
    fs.writeFileSync(zipPath, buf);
    // Expand-Archive 解压（zip 内含 x64/x86 目录 → 取 x64 到 dest）
    const psScript = [
      `$ErrorActionPreference="Stop"`,
      `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${cachePath(configDir, "ultravnc-extract").replace(/'/g, "''")}' -Force`,
      `Copy-Item -Path (Join-Path '${cachePath(configDir, "ultravnc-extract").replace(/'/g, "''")}' 'x64\\*') -Destination '${dest.replace(/'/g, "''")}' -Recurse -Force`,
      `Remove-Item -Path '${cachePath(configDir, "ultravnc-extract").replace(/'/g, "''")}' -Recurse -Force`,
      `Remove-Item -LiteralPath '${zipPath.replace(/'/g, "''")}' -Force`,
      `Write-Output "UNZIP_OK"`,
    ].join("; ");
    const res = await winPwsh(psScript, 120000);
    if (!res.includes("UNZIP_OK")) return { ran: true, error: "解压失败：" + res.slice(-300) };
    if (!fs.existsSync(path.join(dest, "winvnc.exe"))) return { ran: true, error: `解压完成但缺 winvnc.exe（${dest}）` };
    // 只装程序、不写密码：密码由用户提供（winVncEnsure 时需要，缺密码会提示输入）
    const pw = winVncPassword(configDir);
    if (pw) await winVncWriteIni(dest, configDir, pw);
    return { ran: true, log: `便携 UltraVNC 已装：${dest}${pw ? "" : "（尚未设置 VNC 密码，启动/安装时会提示输入）"}` };
  } catch (e) {
    return { ran: true, error: "安装失败：" + String((e as Error).message) };
  }
}
