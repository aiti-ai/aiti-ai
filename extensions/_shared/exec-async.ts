/**
 * 共享异步子进程工具（execFileSync → execFile 全仓改造的权威实现）。
 *
 * ⚠ 性能红线（2026-09-12 改造）：常驻进程（pi-web 服务端 / pi 扩展）内
 * 禁止 execFileSync/spawnSync/execSync——git/ps/soffice 等子进程跑多久，
 * 整个 HTTP 服务就阻塞多久。凡新代码需要跑子进程，一律 import 本文件。
 * 构建/部署/一次性 CLI 脚本不受此红线约束。
 *
 * 错误形态对齐 execFileSync：失败时抛出的 Error 附着 stdout/stderr/status，
 * 调用侧原有的 `catch (e) { e.stderr }` 读取逻辑不需要改。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { join as pathJoin } from "node:path";

export interface ExecAsyncOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 超时后 kill 子进程（默认 120s；超时错误 code=ETIMEOUT? 见 ETIMEOUT 处理） */
  timeoutMs?: number;
  maxBuffer?: number;
  /** stdin 写入（如 sqlcipher 解密）：传字符串则写完自动 end */
  input?: string;
  /** shell 直通（仅在参数无法数组化时使用，默认 false） */
  shell?: boolean;
}

/** execFileSync 兼容错误形态：调用侧 catch (e) { e.stderr/e.stdout/e.status } 原样可用 */
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
 * Promise 版 execFile：返回 stdout；失败时抛出带 stdout/stderr/status 的错误。
 * 基于 spawn 实现（execFile 不支持 stdin input）。
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
      // 宽限 5s 后升级 SIGKILL（子进程忽略 SIGTERM 时）
      setTimeout(() => {
        if (!child.killed || child.exitCode === null) {
          try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
        }
      }, 5_000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    if (opts.input != null && child.stdin) {
      child.stdin.on("error", () => { /* EPIPE：子进程提前退出属正常 */ });
      child.stdin.end(opts.input);
    }

    // StringDecoder 跨 chunk 安全解码（加固 A1）：逐 chunk toString 会把跨 chunk
    // 的多字节字符（中文）解码成 U+FFFD，损坏输出文本
    const stdoutDec = new StringDecoder("utf8");
    const stderrDec = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLen += chunk.length;
      if (stdoutLen > maxBuffer) {
        overflowed = true;
        killed = true;
        try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
        return;
      }
      stdout += stdoutDec.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLen += chunk.length;
      if (stderrLen > maxBuffer) {
        overflowed = true;
        killed = true;
        try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
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
 * per-key 串行队列：同一资源（如同一 gitDir）的「读-改-写」序列原子化。
 *
 * 异步化后同仓提交序列（rev-parse → add → write-tree → commit-tree →
 * update-ref）可能被并发事件交错；队列保证同 key 序列一个接一个跑。
 * 失败消化：单次失败不阻断后续（链条吞掉 rejection）。
 */
const queues = new Map<string, Promise<unknown>>();

export function queueRepo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

/**
 * 同步 PATH 探测（纯 fs，零 spawn）：命中返回绝对路径，未命中返回 null。
 * 语义同 `which <bin>`，但只读文件系统（毫秒级）——探针类调用严禁 execFileSync("which")。
 * 候选必须 isFile（目录 X_OK 恒真，qoder 同名目录误报教训）。
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
