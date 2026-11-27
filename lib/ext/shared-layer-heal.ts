/**
 * Shared-layer self-heal — the fix for the 2026-11-23 outage class.
 *
 * Failure mode: a batch of agent extensions (qoder/pi/zcode/omp/codebuddy/…) is
 * deployed with code that imports a NEW export from `@aiti-ai/ext-shared`, while
 * the shared-root copy (`<webRoot>/node_modules/@aiti-ai/ext-shared`, installed
 * by aiti-extman's reconcile from the npm registry) still predates that export.
 * Every jiti load of those extensions then fails ("(0, _x.newFn) is not a
 * function" / "Cannot find module './new-file.ts'"), their sessionProviders never
 * register, and every click on those agents' history rows 404s into the
 * read-only viewer — with the state persisting across reloads until a later
 * reconcile happens to upgrade the package.
 *
 * Heal: when the repo checkout itself is the running cwd (dev machine form —
 * `extensions/_shared` exists next to the process cwd), copy the repo's
 * `_shared` code files over the shared-root package and let the caller reload.
 * The repo is the authoritative source on a dev machine, so this converges the
 * shared root to exactly what the deployed extension code expects. Install
 * forms (Docker / bare npm) have no repo checkout → the guard fails and this
 * is a no-op; they rely on the normal publish → reconcile path instead.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync } from "fs";
import { dirname, join } from "path";
import { webRoot, extensionsRoot } from "./data-dir.ts";

/**
 * Load-failure messages worth healing. Deliberately narrow: both patterns
 * indicate a missing module-graph member (jiti/bundler import-interop call or
 * a missing relative module), not an ordinary TypeError from extension code
 * (a plain "x.y is not a function" bug must NOT trigger file copies).
 */
const HEALABLE = /\(0\s*,\s*[\w$][\w$.]*\) is not a function|Cannot find module '\.\/|Cannot find module '\.\.\//;

export function healCandidate(failures: Map<string, string>): boolean {
  for (const msg of failures.values()) {
    if (HEALABLE.test(msg)) return true;
  }
  return false;
}

/** Code file extensions copied by the heal; tests and the package manifest never move. */
const COPYABLE = /\.(ts|mjs|js|cjs)$/;

/**
 * Copy the repo's `extensions/_shared` code files over the shared-root
 * `@aiti-ai/ext-shared` package. Same-name overwrite only (no deletions — the
 * installed package may legitimately carry files the worktree no longer has);
 * package.json is never touched (the installed version stays npm-owned and the
 * next publish/reconcile converges it).
 *
 * Writes go through temp-file + rename so a concurrent jiti read can never see
 * a half-written file. Returns the number of files copied; 0 when any guard
 * fails (no repo checkout, package name mismatch, shared root not installed).
 */
export function syncSharedLayerFromRepo(cwd = process.cwd()): number {
  const repoShared = join(cwd, "extensions", "_shared");
  let name = "";
  try {
    name = (JSON.parse(readFileSync(join(repoShared, "package.json"), "utf8")) as { name?: unknown }).name as string;
  } catch {
    return 0;
  }
  if (name !== "@aiti-ai/ext-shared") return 0;
  const sharedRoot = dirname(extensionsRoot());
  const target = join(sharedRoot, "node_modules", "@aiti-ai", "ext-shared");
  if (!existsSync(join(target, "package.json"))) return 0;
  let copied = 0;
  for (const file of readdirSync(repoShared)) {
    if (!COPYABLE.test(file) || /\.test\.(mjs|js|cjs|ts)$/.test(file)) continue;
    const src = join(repoShared, file);
    let isFile = false;
    try {
      isFile = statSync(src).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;
    const dest = join(target, file);
    const tmp = `${dest}.heal-${process.pid}-${Date.now()}`;
    try {
      copyFileSync(src, tmp);
      renameSync(tmp, dest);
      copied++;
    } catch {
      // copy or first rename failed (locked dest on Windows / read-only fs):
      // best-effort direct overwrite before giving up on this file
      try {
        copyFileSync(src, dest);
        copied++;
      } catch {
        /* skip this file — the reload retry will surface the residual failure */
      }
    }
  }
  return copied;
}

/** webRoot re-exported for tests (env-matrix assertions). */
export const _webRootForTest = webRoot;
