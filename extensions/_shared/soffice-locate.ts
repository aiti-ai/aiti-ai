/**
 * soffice-locate — LibreOffice (soffice) locator (shared authoritative source, deployed by copy into extension dirs).
 *
 * Resolution order:
 *   1) the aiti-editor feature config "soffice.path" (<dataRoot>/features.json → aiti-editor.soffice.path;
 *      the extman features page accepts an absolute path) — if set, it wins (existence + executable verified)
 *   2) PATH lookup: soffice → libreoffice (--version probe)
 *   3) common install paths as fallback (/usr/bin/soffice, /opt/libreoffice/program/soffice, …)
 * Results cached (default 60s) — call invalidateSofficeCache() after config changes.
 *
 * Used for: .doc/.ppt → PDF preview, .xls/.ods/.doc → xlsx/docx conversion (shared by
 * aiti-editor / aiti-sheet-univer). When unavailable, gives install/config guidance (SOFFICE_INSTALL_HINTS).
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
  windows: "winget install --id TheDocumentFoundation.LibreOffice -e (or https://www.libreoffice.org/download/download/ )",
  feature: "extension manager → aiti-editor → features → soffice path",
};

const COMMON_PATHS = [
  "/usr/bin/soffice",
  "/usr/lib/libreoffice/program/soffice",
  "/opt/libreoffice/program/soffice",
  "/snap/bin/libreoffice",
];

// Common Windows install paths (winget/official installer defaults; msi may be x86)
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

/** Inject the extension configDir (features.json lives at the data root <dataRoot> = two levels up); each deployed extension injects once, all reading the same global config. */
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
    const raw = readFileSync(join(_dataDir, "..", "..", "features.json"), "utf8"); // <dataRoot>/features.json (configDir = <dataRoot>/<extId>/config)
    const conf = JSON.parse(raw);
    const v = conf?.["aiti-editor"]?.["soffice.path"];
    if (typeof v === "string" && v.trim()) return v.trim();
  } catch { /* no config file / parse failure → skip */ }
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
 * Sync locator (post 2026-09-12 execSync→async rework): pure fs probing (config path/common install
 * paths + executable bit), zero spawn — never reintroduce execFileSync (sync which/--version probing
 * once froze the main thread for 1–8s). The version field and PATH probing go through the async
 * locateSofficeAsync (results share the same _cache, so sync calls hit the cache afterwards).
 */
export function locateSoffice(): SofficeLocateResult {
  const now = Date.now();
  if (_cache && now - _cache.at < 600_000) return _cache.result;

  let result: SofficeLocateResult = { path: null, source: null };

  // 1) absolute path from the feature config
  const fromFeature = featureSofficePath();
  if (fromFeature && usable(fromFeature)) {
    result = { path: fromFeature, source: "feature" };
  } else {
    // 2) common-path fallback (Windows checks winget/msi defaults first) — pure fs, sync-safe
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
 * Async locator (perf fix 2026-09-13): all probing via async execFile (which/--version/common paths),
 * results written to the same _cache (sync getters / subsequent calls spawn nothing).
 * The old sync cold path measured 1–3s freezing the pi-web main thread (first operation of document
 * extensions / soffice-status requests).
 */
export async function locateSofficeAsync(): Promise<SofficeLocateResult> {
  const now = Date.now();
  if (_cache && now - _cache.at < 600_000) return _cache.result;
  const runP = (bin: string, args: string[], timeoutMs: number): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout || "")));
    });
  const probeVersionAsync = async (p: string): Promise<string | undefined> => {
    // Windows: soffice.exe is a GUI-subsystem program, stdout does not reach the pipe; the sibling soffice.com is the console build
    const exe = process.platform === "win32" && /soffice\.exe$/i.test(p) ? p.replace(/soffice\.exe$/i, "soffice.com") : p;
    const out = await runP(exe, ["--version"], 8000);
    return out ? out.split(/\r?\n/)[0].slice(0, 80) : undefined;
  };

  let result: SofficeLocateResult = { path: null, source: null };
  // 1) absolute path from the feature config
  const fromFeature = featureSofficePath();
  if (fromFeature && usable(fromFeature)) {
    result = { path: fromFeature, source: "feature", version: await probeVersionAsync(fromFeature) };
  } else {
    // 2) PATH (Windows has no which, use where)
    const whichCmd = process.platform === "win32" ? "where" : "which";
    for (const name of ["soffice", "libreoffice"]) {
      const out = await runP(whichCmd, [name], 5000);
      const p = out ? out.split(/\r?\n/)[0].trim() : "";
      if (p && usable(p)) {
        result = { path: p, source: "path", version: await probeVersionAsync(p) };
        break;
      }
    }
    // 3) common-path fallback (Windows checks winget/msi defaults first)
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

/** Convenience wrapper: executable path or null */
export function sofficePathOrNull(): string | null {
  return locateSoffice().path;
}
