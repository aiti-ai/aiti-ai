/**
 * cbc-model-catalog — cbc（CodeBuddy Code）`--help` 内置模型目录解析（权威源）。
 *
 * cbc 无免会话 list-models 命令，但 `--help` 的 `--model` 行内嵌当前支持清单：
 *   `--model <model>  Model for the current session. ... Currently supported: (a, b, c)`
 * 方案：docs/aiti-acp-model-catalog-startup-plan.md §2/§3.1（D13/D15）。
 *
 * 本文件按部署单元复制进 aiti-acp-agent / aiti-codebuddy-agent
 * （cbc-model-catalog.ts），修改后同步副本（与 cursor-cli-store.ts 同一模式）。
 */

import { spawn } from "node:child_process";

/** `--model` 行内嵌清单：`Currently supported: (a, b, c)`（cbc 2.150 实测格式）。 */
const SUPPORTED_RE = /Currently supported:\s*\(([^)]*)\)/;

/**
 * `--help` 输出 → 模型 id 列表（纯函数，样本钉死单测）。
 * 解析不到（格式漂移/被截断）返回 [] —— 调用方回落既有静态清单。
 */
export function parseCbcHelpModels(helpText: string): Array<{ id: string }> {
  const m = SUPPORTED_RE.exec(helpText);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))
    .map((id) => ({ id }));
}

/** 探测结果：CLI 目录（可能为空 = 解析失败/超时）+ 版本（cli 条目失效判据）。 */
export interface CbcCatalogProbe {
  models: Array<{ id: string }>;
  cliVersion: string | null;
  timedOut: boolean;
}

/** CLI 三元组（与各扩展 resolveCli 同形：direct = bin 直调；npx = node + npx-cli.js …）。 */
export interface CliCommand {
  cmd: string;
  baseArgs: string[];
}

/** 通用 CLI 采集（stdout 全量 + 超时杀进程；opencode models 等探测复用）。 */
export function runCliCapture(cmd: string, args: string[], opts: { timeoutMs: number; env?: Record<string, string> }): Promise<{ stdout: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: opts.env });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, code: null, timedOut: true });
    }, opts.timeoutMs);
    child.stdout?.on("data", (c: Buffer | string) => { stdout += typeof c === "string" ? c : c.toString("utf8"); });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code: null, timedOut: false });
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code, timedOut: false });
    });
  });
}

/**
 * 探测 cbc 目录：`<cli> --help` 解析模型清单 + `<cli> --version` 取版本。
 * 任何失败 fail-soft（models:[]），由调用方决定回落。
 */
export async function probeCbcCatalog(cli: CliCommand, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<CbcCatalogProbe> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const help = await runCliCapture(cli.cmd, [...cli.baseArgs, "--help"], { timeoutMs, env: opts.env });
  const models = parseCbcHelpModels(help.stdout);
  let cliVersion: string | null = null;
  if (models.length) {
    const ver = await runCliCapture(cli.cmd, [...cli.baseArgs, "--version"], { timeoutMs: 15_000, env: opts.env });
    cliVersion = ver.stdout.trim().split("\n").pop()?.trim() || null;
  }
  return { models, cliVersion, timedOut: help.timedOut };
}
