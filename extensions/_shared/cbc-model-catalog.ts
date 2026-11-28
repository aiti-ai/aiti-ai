/**
 * cbc-model-catalog — parsing of the model catalog embedded in cbc (CodeBuddy Code) `--help`
 * (authoritative source).
 *
 * cbc has no session-free list-models command, but the `--model` line of `--help` embeds the
 * currently supported list:
 *   `--model <model>  Model for the current session. ... Currently supported: (a, b, c)`
 * Plan: docs/aiti-acp-model-catalog-startup-plan.md §2/§3.1 (D13/D15).
 *
 * This file is copied per deployment unit into aiti-acp-agent / aiti-codebuddy-agent
 * (cbc-model-catalog.ts); sync the copies after changes (same pattern as cursor-cli-store.ts).
 */

import { spawn } from "node:child_process";

/** The list embedded in the `--model` line: `Currently supported: (a, b, c)` (measured on cbc 2.150). */
const SUPPORTED_RE = /Currently supported:\s*\(([^)]*)\)/;

/**
 * `--help` output -> model id list (pure function; a sample pins the unit test).
 * Returns [] when unparseable (format drift / truncated) — the caller falls back to its existing
 * static catalog.
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

/** Probe result: the CLI catalog (possibly empty = parse failure/timeout) + version (the criterion for a stale cli entry). */
export interface CbcCatalogProbe {
  models: Array<{ id: string }>;
  cliVersion: string | null;
  timedOut: boolean;
}

/** CLI triple (same shape as each extension's resolveCli: direct = invoke the bin directly; npx = node + npx-cli.js ...). */
export interface CliCommand {
  cmd: string;
  baseArgs: string[];
}

/** Generic CLI capture (full stdout + kill on timeout; reused by probes such as opencode models). */
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
 * Probe the cbc catalog: `<cli> --help` parses the model list + `<cli> --version` fetches the version.
 * Any failure is fail-soft (models:[]); the caller decides the fallback.
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
