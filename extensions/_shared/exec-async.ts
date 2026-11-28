/**
 * Shared async subprocess utilities (the authoritative implementation of the
 * execFileSync → execFile repo-wide migration).
 *
 * ⚠ Performance red line (2026-09-12 migration): resident processes (the pi-web server /
 * pi extensions) must not use execFileSync/spawnSync/execSync — for as long as a child
 * process (git/ps/soffice etc.) runs, the whole HTTP service stays blocked. Any new code
 * that needs to run a subprocess imports this file.
 * Build/deploy/one-shot CLI scripts are exempt from this red line.
 *
 * Error shape aligned with execFileSync: the Error thrown on failure carries
 * stdout/stderr/status, so callers' existing `catch (e) { e.stderr }` reads need no change.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join as pathJoin } from "node:path";

export interface ExecAsyncOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the child after the timeout (default 120s; see the timeout handling for the
   *  timeout error shape) */
  timeoutMs?: number;
  maxBuffer?: number;
  /** stdin input (e.g. sqlcipher decryption): a string is written then auto-ended */
  input?: string;
  /** shell passthrough (only when args cannot be an array; default false) */
  shell?: boolean;
}

/** execFileSync-compatible error shape: callers' catch (e) { e.stderr/e.stdout/e.status } works as-is */
export type ExecAsyncError = Error & {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  killed?: boolean;
};

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Promise-flavored execFile: resolves stdout; rejects with an error carrying
 * stdout/stderr/status on failure.
 * Built on spawn (execFile does not support stdin input).
 */
export function execFileAsync(bin: string, args: string[], opts: ExecAsyncOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.shell ? { shell: true } : {}),
      stdio: [opts.input != null ? "pipe" : "ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let stdoutLen = 0;
    let stderrLen = 0;
    let overflowed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
      // escalate to SIGKILL after a 5s grace (when the child ignores SIGTERM)
      setTimeout(() => {
        if (!child.killed || child.exitCode === null) {
          try { child.kill("SIGKILL"); } catch { /* already exited */ }
        }
      }, 5_000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    if (opts.input != null && child.stdin) {
      child.stdin.on("error", () => { /* EPIPE: an early child exit is normal */ });
      child.stdin.end(opts.input);
    }

    // StringDecoder decodes safely across chunks (hardening A1): per-chunk toString
    // would decode multi-byte characters split across chunks into U+FFFD, corrupting
    // the output text
    const stdoutDec = new StringDecoder("utf8");
    const stderrDec = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) {
        overflowed = true;
        killed = true;
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        return;
      }
      stdout += stdoutDec.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > maxBuffer) {
        overflowed = true;
        killed = true;
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        return;
      }
      stderr += stderrDec.write(chunk);
    });

    const fail = (code: number | null, signal: NodeJS.Signals | null, message: string) => {
      const e = new Error(`Command failed: ${bin} ${args.join(" ")}: ${message}\n${stderr.trim()}`) as ExecAsyncError;
      e.stdout = stdout;
      e.stderr = stderr.trim();
      e.status = code;
      e.signal = signal;
      e.killed = killed;
      reject(e);
    };

    child.on("error", (err) => fail(null, null, err.message));

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (overflowed) {
        fail(code, signal, `output exceeded maxBuffer (${maxBuffer} bytes)`);
        return;
      }
      if (killed && code === null && signal === "SIGTERM") {
        fail(code, signal, "timed out");
        return;
      }
      if (code === 0 && signal === null) {
        resolve(stdout);
        return;
      }
      fail(code, signal, signal ? `killed by signal ${signal}` : `exit status ${code}`);
    });
  });
}

/**
 * Per-key serial queue: atomize the "read-modify-write" sequence of one resource
 * (e.g. one gitDir).
 *
 * After asynchronization, a repo's commit sequence (rev-parse → add → write-tree →
 * commit-tree → update-ref) can interleave with concurrent events; the queue guarantees
 * same-key sequences run one after another.
 * Failure absorption: a single failure does not block the rest (the chain swallows the
 * rejection).
 */
const queues = new Map<string, Promise<unknown>>();

export function queueRepo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

/**
 * Synchronous PATH probe (pure fs, zero spawn): returns the absolute path on a hit,
 * null on a miss.
 * Semantics of `which <bin>`, but read-only on the filesystem (millisecond scale) —
 * probe-style calls must never execFileSync("which").
 * Candidates must isFile (directories always pass X_OK; lesson from a same-named qoder
 * directory false positive).
 */
export function whichBin(bin: string): string | null {
  const isExecFile = (p: string): boolean => {
    try {
      if (!statSync(p).isFile()) return false;
    } catch { return false; }
    try { accessSync(p, constants.X_OK); return true; } catch { return false; }
  };
  if (bin.includes("/") || bin.includes("\\")) {
    return isExecFile(bin) ? bin : null;
  }
  const dirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ...(process.env.PATHEXT || "").split(";").filter(Boolean).map((e) => e.toLowerCase())]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = pathJoin(dir, bin + ext);
      if (isExecFile(p)) return p;
    }
  }
  return null;
}
