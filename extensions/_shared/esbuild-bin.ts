/**
 * esbuild 派生的平台形态差异收口（测试打包范式唯一入口，勿在调用侧再判平台）。
 *
 * esbuild 在三种位置上的 `bin/esbuild` 不是同一种东西：
 *   - Linux/macOS 安装后 postinstall 把它换成**原生二进制**（ELF/Mach-O）→ 只能直接 exec，
 *     `node <bin>` 必炸 SyntaxError（2026-09-19 48 端实测，上游为此把 9 个用例改成直接 exec）；
 *   - 未跑 postinstall / Windows 装的是**带 node shebang 的 JS 包装**→ Windows 的
 *     CreateProcess 不认 shebang 文本文件，直接 exec 报 ENOENT（本机实测），只能 `node <bin>`；
 *   - `node_modules/.bin/esbuild` 在 Windows 是 /bin/sh 的脚本垫片（还有 .cmd/.ps1 两份），
 *     从原生 Node spawn 一律 ENOENT（§0.1 硬规则）。
 *
 * 首选各平台都有的官方二进制包 `@esbuild/<platform>-<arch>`（esbuild 自己的 JS API 也这么找），
 * 落空再按文件头两字节判 shebang 决定直接 exec 还是 `node` 直跑。
 */
import { existsSync, closeSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileAsync, type ExecAsyncOpts } from "./exec-async.ts";

/** 文件头是不是 `#!`（shebang 文本文件在 Windows 不可 exec）。 */
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
 * 官方平台二进制：从给定路径逐级上溯找 `node_modules/@esbuild/<platform>-<arch>`。
 * 两种入口深度不同（`<nm>/esbuild/bin/esbuild` 三级、`<nm>/.bin/esbuild` 两级），
 * 且 pnpm/hoisted 安装还可能命中更上层的 node_modules，故不写死级数。
 */
function platformBin(esbuildPath: string): string | null {
  const tail = process.platform === "win32" ? ["esbuild.exe"] : ["bin", "esbuild"];
  for (let dir = dirname(esbuildPath); ; dir = dirname(dir)) {
    const cand = join(dir, "@esbuild", `${process.platform}-${process.arch}`, ...tail);
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
    if (dirname(dir) === dir) return null; // 到盘根/根目录即止
  }
}

/**
 * 解析出可直接 spawn 的 `[cmd, 前置参数]`（前置参数非空即 `node <JS 入口>` 形态）。
 * 传参用调用侧原有路径（`.../esbuild/bin/esbuild` 或 `.../.bin/esbuild`），本函数自行改判。
 */
export function resolveEsbuildSpawn(esbuildPath: string): { cmd: string; prefix: string[] } {
  const native = platformBin(esbuildPath);
  if (native) return { cmd: native, prefix: [] };
  if (existsSync(esbuildPath)) {
    const head = shebangLine(esbuildPath);
    if (head === null) return { cmd: esbuildPath, prefix: [] }; // 原生二进制
    if (/node(\s|$)/.test(head)) return { cmd: process.execPath, prefix: [esbuildPath] };
  }
  return { cmd: esbuildPath, prefix: [] }; // 原样交给 spawn，报真实 ENOENT 而不是这里编造原因
}

/** 跑一次 esbuild CLI（args 原样透传，如 `["entry.ts", "--bundle", "--outfile=..."]`）。 */
export function runEsbuild(esbuildPath: string, args: string[], opts: ExecAsyncOpts = {}): Promise<string> {
  const { cmd, prefix } = resolveEsbuildSpawn(esbuildPath);
  return execFileAsync(cmd, [...prefix, ...args], opts);
}
