/**
 * aiti-channels · cc-connect 安装/更新（justget 多源竞速下载 + gitee 镜像）
 *
 * 用 justget（多源竞速分块下载器）下载 cc-connect release：
 *   主源 GitHub  release（https://github.com/chenhg5/cc-connect/releases/download/<tag>/…）
 *   镜像 Gitee  release（https://gitee.com/cg33/cc-connect/releases/download/<tag>/…）
 * 谁快用谁，单源失败自动切换（justget 竞速语义）。
 *
 * 下载通道两级（2026-09-19 起）：
 *   主：npm 依赖 justget 进程内 download()（纯 JS 三平台同构，免外部 CLI/免 spawn/shell；
 *       依赖声明进 package.json，经 extman reconcile 装进共享根 <webRoot>/node_modules）
 *   兜底：外部 justget CLI（env > workspace > 全局含 %APPDATA%\npm 逐级探测 → npx），
 *       覆盖「包尚未 reconcile」的窗口期；win32 下 npx 是 .cmd shim，spawn 必须 shell:true
 *       （lessons §0.1）。
 *
 * 下载后解压（tar.gz=系统 tar；zip=yauzl 纯 JS，Windows 产物即 zip）→ 安装二进制到托管
 * bin 目录（免 sudo；Windows 落 cc-connect.exe），并在 sudo 可用时同步到
 * /usr/local/bin/cc-connect（与现有启动路径一致；Windows 跳过）。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { execFileAsync } from "@aiti-ai/ext-shared/exec-async";
import { homedir, platform, arch } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const IS_WIN = platform() === "win32";
// yauzl（CJS）双环境可解析：jiti 运行时与 node strip-types 测试都走这里，
// walk-up 命中扩展本地或共享根 <webRoot>/node_modules。
const require_ = createRequire(import.meta.url);

export const GITHUB_API = "https://api.github.com/repos/chenhg5/cc-connect/releases/latest";
export const GITEE_API = "https://gitee.com/api/v5/repos/cg33/cc-connect/releases/latest";
const GITHUB_DL = "https://github.com/chenhg5/cc-connect/releases/download";
const GITEE_DL = "https://gitee.com/cg33/cc-connect/releases/download";

/** 托管 bin 目录（免 sudo）：~/.pi/web/data/aiti-channels/cache/bin/cc-connect（数据分层：可再下载 → cache） */
export function managedBinDir(): string {
  return path.join(homedir(), ".pi", "web", "data", "aiti-channels", "cache", "bin");
}
/** 托管二进制文件名（Windows 必须带 .exe：无扩展名文件 Node 直 spawn 虽可过，但用户手动/cmd 跑不了，且语义脏） */
export function managedBinName(): string {
  return IS_WIN ? "cc-connect.exe" : "cc-connect";
}
export function managedBin(): string {
  return path.join(managedBinDir(), managedBinName());
}
const SYSTEM_BIN = "/usr/local/bin/cc-connect";

function sysTriple(): string {
  const osMap: Record<string, string> = { linux: "linux", darwin: "darwin", win32: "windows" };
  const archMap: Record<string, string> = { x64: "amd64", arm64: "arm64" };
  const os = osMap[platform()] || "linux";
  const a = archMap[arch()] || "amd64";
  return `${os}-${a}`;
}

/** 当前安装版本（托管 bin 优先，回退系统 bin） */
export async function currentVersion(): Promise<{ version: string | null; bin: string | null }> {
  for (const bin of [managedBin(), SYSTEM_BIN]) {
    if (!fs.existsSync(bin)) continue;
    try {
      const out = await execFileAsync(bin, ["--version"], { timeoutMs: 5000 });
      const m = out.match(/v[\d.]+/);
      return { version: m ? m[0] : out.trim().split("\n")[0] || null, bin };
    } catch { /* 继续找下一个 */ }
  }
  return { version: null, bin: null };
}

/** 最新 release 版本（GitHub API，失败回退 Gitee API） */
export async function latestVersion(): Promise<{ tag: string; source: string }> {
  for (const [source, api] of [["github", GITHUB_API], ["gitee", GITEE_API]] as const) {
    try {
      const r = await fetch(api, { signal: AbortSignal.timeout(12000), headers: source === "github" ? { "user-agent": "aiti-channels" } : {} });
      if (!r.ok) continue;
      const d = await r.json().catch(() => null);
      const tag = d?.tag_name || d?.tagName;
      if (tag) return { tag, source };
    } catch { /* 下一个源 */ }
  }
  throw new Error("无法获取最新版本（GitHub/Gitee API 均失败）");
}

/** 解析 justget CLI 路径：环境变量 > 本机 workspace > 全局（含 Windows %APPDATA%\npm）逐级探测 */
export function resolveJustgetCli(): string {
  if (process.env.JUSTGET_CLI && fs.existsSync(process.env.JUSTGET_CLI)) return process.env.JUSTGET_CLI;
  const candidates = [
    path.join(homedir(), "workspace", "justget", "dist", "cli.js"),
    path.join(homedir(), "workspace", "justget-internal", "dist", "cli.js"),
    path.join(homedir(), ".local", "lib", "node_modules", "justget", "dist", "cli.js"),
  ];
  if (IS_WIN && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "justget", "dist", "cli.js"));
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "npx"; // 兜底：npx justget（win32 下 npx 是 .cmd shim，spawn 必须 shell:true——lessons §0.1）
}

/** 当前下载通道：npm=进程内依赖（主）；cli=外部 justget/npx 兜底（包未 reconcile 的窗口期）。 */
export async function justgetMode(): Promise<"npm" | "cli"> {
  return (await loadJustget()) ? "npm" : "cli";
}

/** justget 进程内下载器（npm 依赖；null=包不可用）。模块级缓存——探测过就不再 import。 */
type JgDownloadFn = (opts: {
  url: string;
  output: string;
  mirrors?: string[];
  options?: Record<string, unknown>;
}) => Promise<unknown>;
let _jgDownload: JgDownloadFn | null | undefined;
async function loadJustget(): Promise<JgDownloadFn | null> {
  if (_jgDownload !== undefined) return _jgDownload as JgDownloadFn | null;
  try {
    const mod: any = await import("justget");
    _jgDownload = typeof mod?.download === "function" ? mod.download : null;
  } catch { _jgDownload = null; } // 包未装（reconcile 未跑/独立脚本环境）→ CLI 兜底
  return _jgDownload as JgDownloadFn | null;
}

/** 用 justget 下载（主源 github + 镜像 gitee），输出到 outPath。npm 进程内为主，CLI 兜底。 */
export async function justgetDownload(dlUrl: string, mirrorUrl: string, outPath: string): Promise<string> {
  const jg = await loadJustget();
  if (jg) {
    try {
      await jg({ url: dlUrl, mirrors: [mirrorUrl], output: outPath, options: { timeout: 300000, connectTimeout: 10000 } });
    } catch (e: any) {
      throw new Error(`justget 下载失败：${(e && e.message) || e}`);
    }
    if (!fs.existsSync(outPath)) throw new Error(`justget 下载完成但未产出文件：${outPath}`);
    return outPath;
  }
  return cliJustgetDownload(dlUrl, mirrorUrl, outPath);
}

/** CLI 兜底：解析 justget CLI 并 spawn（justget npm 包不可用时才走）。 */
function cliJustgetDownload(dlUrl: string, mirrorUrl: string, outPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cli = resolveJustgetCli();
    const baseArgs = cli === "npx"
      ? ["--yes", "justget", dlUrl, "-o", outPath, "-m", mirrorUrl, "--timeout", "300000"]
      : [dlUrl, "-o", outPath, "-m", mirrorUrl, "--timeout", "300000"];
    // cli.js 无执行权限，用 node 解释器跑
    const isJs = cli.endsWith(".js") || cli.endsWith(".mjs") || cli.endsWith(".cjs");
    const cmd = isJs ? "node" : cli;
    const args = isJs ? [cli, ...baseArgs] : baseArgs;
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: IS_WIN && cmd === "npx", // 全部参数自构造（URL/时间戳路径），无用户输入注入面
      windowsHide: true, // 常驻服务上下文防控制台窗闪
    });
    let err = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("error", (e) => reject(new Error("justget 启动失败：" + e.message)));
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(outPath)) resolve(outPath);
      else reject(new Error(`justget 下载失败（exit ${code}）：${err.slice(-300)}`));
    });
  });
}

/** zip 解包到目录（yauzl 流式逐条写盘，防大二进制整包进内存；路径穿越/盘符/绝对路径防御同 aiti-extman 样板）。 */
export function extractZipToDir(zipPath: string, dest: string): Promise<void> {
  const yauzl = require_("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true }, (err: Error | null, zip: any) => {
      if (err || !zip) return reject(err ?? new Error("zip 打开失败"));
      let failed = false;
      const fail = (e: unknown) => { if (!failed) { failed = true; reject(e instanceof Error ? e : new Error(String(e))); } };
      zip.on("error", fail);
      zip.on("end", () => { if (!failed) resolve(); });
      zip.on("entry", (entry: any) => {
        if (failed) return;
        const name = String(entry.fileName).replace(/\\/g, "/");
        if (name.endsWith("/")) return zip.readEntry();
        const rel = name.split("/").filter((p) => p && p !== "." && !/^[A-Za-z]:$/.test(p) && p !== "__MACOSX");
        if (rel.includes("..") || rel.length === 0) return fail(new Error(`zip 含非法路径：${entry.fileName}`));
        const target = path.join(dest, ...rel);
        zip.openReadStream(entry, (e: Error | null, rs: NodeJS.ReadableStream | null) => {
          if (failed) return;
          if (e || !rs) return fail(e ?? new Error(`zip 条目读取失败：${name}`));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const ws = fs.createWriteStream(target);
          rs.on("error", fail);
          ws.on("error", fail);
          ws.on("finish", () => { if (!failed) zip.readEntry(); });
          rs.pipe(ws);
        });
      });
      zip.readEntry();
    });
  });
}

/** 下载 + 解压 + 安装。返回安装信息。 */
export async function install(tag?: string, opts: { systemBin?: boolean } = {}): Promise<Record<string, any>> {
  const targetTag = tag || (await latestVersion()).tag;
  const triple = sysTriple();
  const ext = triple.startsWith("windows") ? ".zip" : ".tar.gz";
  const filename = `cc-connect-${targetTag}-${triple}${ext}`;
  const github = `${GITHUB_DL}/${targetTag}/${filename}`;
  const gitee = `${GITEE_DL}/${targetTag}/${filename}`;

  fs.mkdirSync(managedBinDir(), { recursive: true });
  const tmpTar = path.join(managedBinDir(), `.download-${Date.now()}${ext}`);
  const backupBin = path.join(managedBinDir(), "cc-connect.bak");

  // 1. justget 竞速下载（github 主源 + gitee 镜像）
  await justgetDownload(github, gitee, tmpTar);

  // 2. 解压（tar.gz=系统 tar；zip=yauzl 纯 JS——裸 Windows 无 unzip，且 Git 的 GNU tar 不认 zip，都不能依赖外部命令）
  const extractDir = path.join(managedBinDir(), `.extract-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });
  try {
    if (ext === ".tar.gz") {
      await new Promise<void>((res, rej) => {
        const c = spawn("tar", ["-xzf", tmpTar, "-C", extractDir]);
        c.on("error", rej); c.on("close", (code) => code === 0 ? res() : rej(new Error("tar 解压失败")));
      });
    } else {
      await extractZipToDir(tmpTar, extractDir);
    }
    // 找解压出的 cc-connect 二进制
    const found = findBinRecursive(extractDir);
    if (!found) throw new Error("解压目录未找到 cc-connect 二进制");
    if (!IS_WIN) fs.chmodSync(found, 0o755);

    // 3. 备份旧 + 安装到托管目录（运行中的镜像文件被 OS 锁定：win=EPERM/EBUSY，POSIX=ETXTBSY——
    //    给出可操作的报错而非裸系统错误）
    if (fs.existsSync(managedBin())) { fs.rmSync(backupBin, { force: true }); fs.copyFileSync(managedBin(), backupBin); }
    try {
      fs.copyFileSync(found, managedBin());
    } catch (e: any) {
      if (["EPERM", "EBUSY", "ETXTBSY", "EACCES"].includes(String(e?.code))) {
        throw new Error(`安装失败：托管 bin 被占用（${e.code}）——cc-connect 正在运行？先停止实例（面板 ⏹ 或 stop API）再安装/更新`);
      }
      throw e;
    }
    if (!IS_WIN) fs.chmodSync(managedBin(), 0o755);

    // 4. sudo 可用时同步系统 bin（与现有启动路径一致；Windows 无此概念，直接跳过）
    let systemInstalled = false;
    if (!IS_WIN && opts.systemBin !== false) {
      try {
        await execFileAsync("sudo", ["-n", "cp", managedBin(), SYSTEM_BIN], { timeoutMs: 8000 });
        await execFileAsync("sudo", ["-n", "chmod", "755", SYSTEM_BIN], { timeoutMs: 8000 });
        systemInstalled = true;
      } catch { systemInstalled = false; }
    }

    const ver = ((await currentVersion()).version) || targetTag;
    return {
      ok: true, tag: targetTag, version: ver, triple,
      bin: managedBin(), systemBin: systemInstalled ? SYSTEM_BIN : null,
      downloaded: tmpTar, extracted: found, backup: fs.existsSync(backupBin) ? backupBin : null,
      mirror: gitee,
    };
  } finally {
    // 清理临时文件
    for (const f of [tmpTar, extractDir]) { try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

export function findBinRecursive(dir: string): string | null {
  const excluded = /\.(tar\.gz|tgz|zip|gz|bak|tmp|md|txt|json|yaml|yml|log|sum|txt|sig)$/;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = findBinRecursive(p);
      if (sub) return sub;
    } else if (e.name === "cc-connect" || e.name === "cc-connect.exe" || (e.name.startsWith("cc-connect") && !excluded.test(e.name))) {
      return p;
    }
  }
  return null;
}
