/**
 * cli-resolve.ts — fork CLI 解析（载体无关）。
 * 拆自 aiti-pi-agent 的 pi-rpc-spawn.ts：resolveForkCli / resolveBun / which。
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PiForkSpec } from "./spec.ts";

export interface ResolvedForkCli {
  /** 实际执行的解释器（node / bun）。 */
  runner: string;
  /** 解释器参数（通常 [cliPath]；PATH 可执行直跑时 []）。 */
  args: string[];
  /** 人类可读的解析来源（日志/报错用）。 */
  origin: string;
}

/**
 * 解析 fork CLI。解析顺序：
 *   1) spec.cliEnvVar 显式指定（绝对路径，交给 runtime 解释）
 *   2) spec.bundledCli()（pi：pi-web 包内 SDK cli.js，node 解释）
 *   3) PATH 上的 spec.pathBin（绝对路径 → runtime 解释；找不到 → null）
 *
 * fork 未装时返回 null：provider 照常注册，createSession 报清晰错误（不阻塞列表）。
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
  // 兜底：bun 全局安装目录（systemd 等服务进程 PATH 通常不含 ~/.bun/bin）
  const bunGlobalBin = join(process.env.HOME || "", ".bun", "bin", spec.pathBin);
  if (spec.runtime === "bun" && existsSync(bunGlobalBin)) {
    return { runner: resolveBun(), args: [bunGlobalBin], origin: "~/.bun/bin" };
  }
  return null;
}

/** bun 解释器解析：env BUN → PATH bun。找不到返回 "bun"（让 spawn 报 ENOENT，fail loud）。 */
export function resolveBun(): string {
  return process.env.BUN || "bun";
}

/** PATH 查找可执行文件（同步；Windows 兼容：`;` 分隔 + PATHEXT 后缀 + isFile 校验；
 *  POSIX 额外要求可执行位）。找不到返回 undefined。 */
export function which(bin: string): string | undefined {
  const isWin = process.platform === "win32";
  const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  // Windows 还要试 PATHEXT 后缀（pi.cmd / pi.exe …）；首项空串 = 精确名优先
  const exts = isWin ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 候选必须是文件（目录命名的同名项不算）且可执行（POSIX 查可执行位）。 */
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
