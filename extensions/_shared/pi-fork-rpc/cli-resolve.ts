/**
 * cli-resolve.ts — fork CLI resolution (carrier-agnostic).
 * Split out of aiti-pi-agent's pi-rpc-spawn.ts: resolveForkCli / resolveBun / which.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PiForkSpec } from "./spec.ts";

export interface ResolvedForkCli {
  /** The interpreter actually executed (node / bun). */
  runner: string;
  /** Interpreter args (usually [cliPath]; [] when a PATH executable runs directly). */
  args: string[];
  /** Human-readable resolution origin (for logs/errors). */
  origin: string;
}

/**
 * Resolve the fork CLI. Resolution order:
 *   1) spec.cliEnvVar explicitly set (absolute path, handed to the runtime interpreter)
 *   2) spec.bundledCli() (pi: the SDK cli.js inside the pi-web package, interpreted by node)
 *   3) spec.pathBin on PATH (absolute path → runtime interpreter; not found → null)
 *
 * Returns null when the fork is not installed: the provider still registers, and createSession
 * reports a clear error (the list is not blocked).
 */
export function resolveForkCli(spec: PiForkSpec): ResolvedForkCli | null {
  const explicit = process.env[spec.cliEnvVar];
  if (explicit && existsSync(explicit)) {
    return { runner: spec.runtime === "bun" ? resolveBun() : process.execPath, args: [explicit], origin: `env ${spec.cliEnvVar}` };
  }
  const bundled = spec.bundledCli?.();
  if (bundled) {
    return { runner: process.execPath, args: [bundled], origin: "bundled SDK" };
  }
  const onPath = which(spec.pathBin);
  if (onPath) {
    return { runner: spec.runtime === "bun" ? resolveBun() : process.execPath, args: [onPath], origin: `PATH ${spec.pathBin}` };
  }
  // Fallback: the bun global install directory (service processes such as systemd usually lack ~/.bun/bin on PATH)
  const bunGlobalBin = join(process.env.HOME || "", ".bun", "bin", spec.pathBin);
  if (spec.runtime === "bun" && existsSync(bunGlobalBin)) {
    return { runner: resolveBun(), args: [bunGlobalBin], origin: "~/.bun/bin" };
  }
  return null;
}

/** bun interpreter resolution: env BUN → PATH bun. Returns "bun" when not found (lets spawn report ENOENT, fail loud). */
export function resolveBun(): string {
  return process.env.BUN || "bun";
}

/** PATH executable lookup (synchronous; Windows-compatible: `;` separator + PATHEXT suffixes + isFile check;
 *  POSIX additionally requires the executable bit). Returns undefined when not found. */
export function which(bin: string): string | undefined {
  const isWin = process.platform === "win32";
  const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  // Windows also tries PATHEXT suffixes (pi.cmd / pi.exe …); the leading empty string = exact name first
  const exts = isWin ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The candidate must be a file (a same-named directory doesn't count) and executable (POSIX checks the executable bit). */
function isExecutableFile(path: string): boolean {
  let st;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  return process.platform === "win32" || (st.mode & 0o111) !== 0;
}
