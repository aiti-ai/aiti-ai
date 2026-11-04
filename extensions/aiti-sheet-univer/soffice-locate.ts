/**
 * soffice-locate —— LibreOffice (soffice) 定位器（共享权威源，部署拷进扩展目录）。
 *
 * 解析顺序：
 *   1) aiti-editor 功能配置「soffice.path」（<dataRoot>/features.json → aiti-editor.soffice.path，
 *      extman 功能页可填绝对路径）——填了就用它（校验存在 + 可执行）
 *   2) PATH 查找：soffice → libreoffice（--version 探测）
 *   3) 常见安装路径兜底（/usr/bin/soffice、/opt/libreoffice/program/soffice 等）
 * 结果缓存（默认 60s）——配置变更后调 invalidateSofficeCache()。
 *
 * 用途：.doc/.ppt → PDF 预览、.xls/.ods/.doc → xlsx/docx 转换（aiti-editor /
 * aiti-sheet-univer 共用）。不可用时给出安装与配置指引（SOFFICE_INSTALL_HINTS）。
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";

export interface SofficeLocateResult {
  path: string | null;
  source: "feature" | "path" | "common" | null;
  version?: string;
}

export const SOFFICE_INSTALL_HINTS = {
  linux: "sudo apt install libreoffice",
  macos: "brew install --cask libreoffice",
  windows: "winget install --id TheDocumentFoundation.LibreOffice -e（或 https://www.libreoffice.org/download/download/ ）",
  feature: "扩展管理器 → aiti-editor → 功能 → soffice 路径",
};

const COMMON_PATHS = [
  "/usr/bin/soffice",
  "/usr/lib/libreoffice/program/soffice",
  "/opt/libreoffice/program/soffice",
  "/snap/bin/libreoffice",
];

// Windows 常见安装路径（winget/官方安装器默认落点；msi 可能为 x86）
function winCommonPaths(): string[] {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const lm = process.env["LOCALAPPDATA"] || "";
  const out = [
    join(pf, "LibreOffice", "program", "soffice.exe"),
    join(pf86, "LibreOffice", "program", "soffice.exe"),
  ];
  if (lm) out.push(join(lm, "Programs", "LibreOffice", "program", "soffice.exe"));
  return out;
}

let _cache: { at: number; result: SofficeLocateResult } | null = null;
let _dataDir = "";

/** 注入扩展 configDir（features.json 在数据根 <dataRoot> = 其上级的上级）；部署后的每个扩展各注入一次，读同一份全局配置。 */
export function setSofficeDataDir(configDir: string): void {
  if (configDir && configDir !== _dataDir) {
    _dataDir = configDir;
    _cache = null;
  }
}

export function invalidateSofficeCache(): void {
  _cache = null;
}

function featureSofficePath(): string | null {
  if (!_dataDir) return null;
  try {
    const raw = readFileSync(join(_dataDir, "..", "..", "features.json"), "utf8"); // <dataRoot>/features.json（configDir = <dataRoot>/<extId>/config）
    const conf = JSON.parse(raw);
    const v = conf?.["aiti-editor"]?.["soffice.path"];
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch { /* 无配置文件/解析失败 → 跳过 */ }
  return null;
}

function usable(p: string): boolean {
  try {
    statSync(p);
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步版定位（2026-09-12 execSync→async 改造）：纯 fs 探测（配置路径/常见安装路径 + 可执行位），
 * 零 spawn——绝不再引入 execFileSync（which/--version 同步探测曾冻结主线程 1~8s）。
 * version 字段与 PATH 探测走异步版 locateSofficeAsync（结果写同一 _cache，同步调用随后命中缓存）。
 */
export function locateSoffice(): SofficeLocateResult {
  const now = Date.now();
  if (_cache && now - _cache.at < 600_000) return _cache.result;

  let result: SofficeLocateResult = { path: null, source: null };

  // 1) 功能配置的绝对路径
  const fromFeature = featureSofficePath();
  if (fromFeature && usable(fromFeature)) {
    result = { path: fromFeature, source: "feature" };
  } else {
    // 2) 常见路径兜底（Windows 先查 winget/msi 默认落点）——纯 fs，可同步
    const common = process.platform === "win32" ? winCommonPaths() : COMMON_PATHS;
    for (const p of common) {
      if (usable(p)) {
        result = { path: p, source: "common" };
        break;
      }
    }
  }

  _cache = { at: now, result };
  return result;
}

/**
 * 异步版定位（性能修复 2026-09-13）：全 execFile 异步探测（which/--version/常见路径），
 * 结果写入同一 _cache（同步 getter/后续调用零 spawn）。
 * 原同步 cold 路径实测 1~3s 冻结 pi-web 主线程（文档类扩展首次操作/soffice-status 请求）。
 */
export async function locateSofficeAsync(): Promise<SofficeLocateResult> {
  const now = Date.now();
  if (_cache && now - _cache.at < 600_000) return _cache.result;
  const runP = (bin: string, args: string[], timeoutMs: number): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || "")));
    });
  const probeVersionAsync = async (p: string): Promise<string | undefined> => {
    // Windows：soffice.exe 是 GUI 子系统程序，stdout 不回管道；同目录 soffice.com 是控制台版
    const exe = process.platform === "win32" && /soffice\.exe$/i.test(p) ? p.replace(/soffice\.exe$/i, "soffice.com") : p;
    const out = await runP(exe, ["--version"], 8000);
    return out ? out.split(/\r?\n/)[0].slice(0, 80) : undefined;
  };

  let result: SofficeLocateResult = { path: null, source: null };
  // 1) 功能配置的绝对路径
  const fromFeature = featureSofficePath();
  if (fromFeature && usable(fromFeature)) {
    result = { path: fromFeature, source: "feature", version: await probeVersionAsync(fromFeature) };
  } else {
    // 2) PATH（Windows 无 which，用 where）
    const whichCmd = process.platform === "win32" ? "where" : "which";
    for (const name of ["soffice", "libreoffice"]) {
      const out = await runP(whichCmd, [name], 5000);
      const p = out ? out.split(/\r?\n/)[0].trim() : "";
      if (p && usable(p)) {
        result = { path: p, source: "path", version: await probeVersionAsync(p) };
        break;
      }
    }
    // 3) 常见路径兜底（Windows 先查 winget/msi 默认落点）
    if (!result.path) {
      const common = process.platform === "win32" ? winCommonPaths() : COMMON_PATHS;
      for (const p of common) {
        if (usable(p)) {
          result = { path: p, source: "common", version: await probeVersionAsync(p) };
          break;
        }
      }
    }
  }

  _cache = { at: Date.now(), result };
  return result;
}

/** 拿到可执行路径或 null（便捷封装） */
export function sofficePathOrNull(): string | null {
  return locateSoffice().path;
}
