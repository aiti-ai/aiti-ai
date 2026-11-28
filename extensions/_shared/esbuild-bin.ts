/**
 * Convergence point for esbuild's derived platform forms (the single entry of the
 * test-bundling paradigm; callers must not re-judge the platform).
 *
 * esbuild's `bin/esbuild` is not the same thing in three places:
 *   - On Linux/macOS postinstall swaps it for a **native binary** (ELF/Mach-O) → it can
 *     only be exec'd directly; `node <bin>` blows up with SyntaxError (measured on 48
 *     ports 2026-09-19; upstream changed 9 cases to direct exec for this reason);
 *   - Without postinstall / on Windows it is a **JS wrapper with a node shebang** →
 *     Windows CreateProcess doesn't recognize a shebang text file and direct exec fails
 *     ENOENT (measured locally); only `node <bin>` works;
 *   - `node_modules/.bin/esbuild` on Windows is a /bin/sh script shim (plus .cmd/.ps1
 *     copies); spawning it from native Node is always ENOENT (§0.1 hard rule).
 *
 * Prefer the official per-platform binary package `@esbuild/<platform>-<arch>` (esbuild's
 * own JS API looks it up the same way); on a miss, decide direct exec vs `node` by the
 * file's first two bytes (shebang).
 */
import { existsSync, closeSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileAsync, type ExecAsyncOpts } from "./exec-async.ts";

/** Whether the file head is `#!` (a shebang text file is not exec-able on Windows). */
function shebangLine(p: string): string | null {
  const fd = openSync(p, "r");
  try {
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n < 2 || buf[0] !== 0x23 || buf[1] !== 0x21) return null;
    const end = buf.subarray(0, n).indexOf(0x0a);
    return buf.subarray(2, end < 0 ? n : end).toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * Official platform binary: walk upward from the given path looking for
 * `node_modules/@esbuild/<platform>-<arch>`.
 * The two entry depths differ (`<nm>/esbuild/bin/esbuild` three levels, `<nm>/.bin/esbuild`
 * two), and pnpm/hoisted installs may hit an even higher node_modules, so the level
 * count is not hardcoded.
 */
function platformBin(esbuildPath: string): string | null {
  const tail = process.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"];
  for (let dir = dirname(esbuildPath); ; dir = dirname(dir)) {
    const cand = join(dir, "@esbuild", `${process.platform}-${process.arch}`, ...tail);
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
    if (dirname(dir) === dir) return null; // stop at the drive root / filesystem root
  }
}

/**
 * Resolve a directly spawnable `[cmd, prefix args]` (non-empty prefix = the
 * `node <JS entry>` form).
 * The caller passes its original path (`.../esbuild/bin/esbuild` or `.../.bin/esbuild`);
 * this function re-judges on its own.
 */
export function resolveEsbuildSpawn(esbuildPath: string): { cmd: string; prefix: string[] } {
  const native = platformBin(esbuildPath);
  if (native) return { cmd: native, prefix: [] };
  if (existsSync(esbuildPath)) {
    const head = shebangLine(esbuildPath);
    if (head === null) return { cmd: esbuildPath, prefix: [] }; // native binary
    if (/node(\s|$)/.test(head)) return { cmd: process.execPath, prefix: [esbuildPath] };
  }
  return { cmd: esbuildPath, prefix: [] }; // hand to spawn as-is; report the real ENOENT instead of inventing a reason here
}

/** Run the esbuild CLI once (args passed through verbatim, e.g. `["entry.ts", "--bundle", "--outfile=..."]`). */
export function runEsbuild(esbuildPath: string, args: string[], opts: ExecAsyncOpts = {}): Promise<string> {
  const { cmd, prefix } = resolveEsbuildSpawn(esbuildPath);
  return execFileAsync(cmd, [...prefix, ...args], opts);
}
