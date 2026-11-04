/**
 * hermetic git wrapper（§3.2 核心红线）。
 *
 * 所有对追踪仓的 git 调用必须经此 wrapper：显式 --git-dir/--work-tree/
 * GIT_INDEX_FILE + GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_NOSYSTEM=1，
 * 并 -c 关闭用户全局 hooks/gpgsign。物理上不可能触碰用户仓的
 * objects/refs/index。缺任何一项都视为 bug（构造函数即固定，无旁路）。
 *
 * ⚠ 性能红线（2026-09-12 改造）：全部调用走异步 `execFile`——git 子进程
 * 绝不阻塞事件循环。此前 `execFileSync` 版本在 pi-web 主进程内被高频工具
 * 事件驱动（before/after × 多仓 × 多并发会话），实测每秒数十次 fork，
 * 把整个 HTTP 服务拖进 2~10s 的排队窗口（perf：9% CPU 花在 fork 页表复制）。
 * 任何人不得在此文件重新引入 execFileSync/spawnSync。
 */
import { execFile } from "node:child_process";

export interface HermeticCtx {
  /** GIT_DIR：<repoRoot>/.aiti-trace */
  gitDir: string;
  /** work-tree：仓根（§3.1 repo-rooted；trace.scope=cwd 时为会话目录） */
  workTree: string;
  /** 每会话独立 index：<gitDir>/index-<sessionId>（并发安全） */
  indexFile: string;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function baseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // hermetic：让 git 完全不读用户/系统配置（config 全部 init 时写进 store）
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

/**
 * per-gitDir 串行队列：同一追踪仓的「读-改-写」序列原子化。
 *
 * 为什么需要：异步化后，同一仓的提交序列（rev-parse → add → write-tree →
 * commit-tree → update-ref）可能被并发事件交错（同会话快事件、跨会话共享
 * refs），导致 parent 丢失/update-ref 覆盖。队列保证同仓序列一个接一个跑。
 * 失败消化：单次失败不阻断后续（链条吞掉 rejection）。
 */
const repoQueues = new Map<string, Promise<unknown>>();

export function queueRepo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  repoQueues.set(key, run.catch(() => {}));
  return run;
}

/** 通用 async execFile：返回 stdout；失败时抛出带 stdout/stderr/status 的错误。 */
export function execFileAsync(
  bin: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxBuffer?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
        encoding: "utf8",
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 120_000,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { stdout?: string; stderr?: string; status?: number | null; killed?: boolean };
          e.stdout = typeof stdout === "string" ? stdout : String(stdout ?? "");
          e.stderr = typeof stderr === "string" ? stderr.trim() : String(stderr ?? "");
          e.status = typeof (err as NodeJS.ErrnoException).code === "number"
            ? ((err as NodeJS.ErrnoException).code as unknown as number)
            : null;
          reject(e);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export class HermeticGit {
  private readonly ctx: () => HermeticCtx;
  constructor(ctx: () => HermeticCtx) {
    this.ctx = ctx;
  }

  /** 追踪仓写/读操作（异步；全部带 hermetic 三件套 + 关 hooks/gpgsign） */
  async run(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    const ctx = this.ctx();
    return execFileAsync(
      "git",
      [
        "--git-dir", ctx.gitDir,
        "--work-tree", ctx.workTree,
        "-c", "core.hooksPath=/dev/null", // 用户全局 hooksPath 不得作用于追踪仓
        "-c", "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: ctx.workTree,
        maxBuffer: 64 * 1024 * 1024,
        timeoutMs: opts.timeoutMs ?? 120_000,
        env: { ...baseEnv(), GIT_INDEX_FILE: ctx.indexFile },
      },
    );
  }

  /** 不抛错版本（status/探测类常用） */
  async tryRun(args: string[], opts: { timeoutMs?: number } = {}): Promise<GitResult> {
    try {
      return { ok: true, stdout: await this.run(args, opts), stderr: "", status: 0 };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; status?: number | null; message?: string };
      return {
        ok: false,
        stdout: typeof err?.stdout === "string" ? err.stdout : "",
        stderr: typeof err?.stderr === "string" ? err.stderr : String(err?.message ?? err),
        status: typeof err?.status === "number" ? err.status : null,
      };
    }
  }

  /**
   * 探测门（P0-2）：工作区相对会话分支是否有「手改」。
   * `diff-index --quiet <branch> --` 内容精确（纯 touch 消化、改回原内容不报、stale index 可检出）；
   * untracked 不报（after 边界由枚举补）。退出码：0=无差异；1=有差异；128=分支不存在
   * （首触/新会话——注意新会话空 index 对既有分支也报 1，语义=走懒提交全量快照，与现状一致）。
   * 代价：探测会刷新本会话 index 的 stat 缓存（同会话串行队列内，无并发风险）。
   */
  async probeTrackedDirty(branch: string): Promise<GitResult> {
    return this.tryRun(["diff-index", "--quiet", branch, "--"]);
  }
}

/**
 * 只读：用户仓 HEAD 对照（§3.4 User-Head trailer）。
 * 仅允许 `-C <root> rev-parse HEAD` 这一读形态，绝不接收其他参数。
 */
export async function userRepoHead(repoRoot: string): Promise<string> {
  try {
    const out = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      timeoutMs: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.trim() || "-";
  } catch {
    return "-";
  }
}

/** 只读：用户仓 git status --porcelain（hermetic 校验测试用） */
export function userRepoStatus(repoRoot: string): Promise<string> {
  return execFileAsync("git", ["-C", repoRoot, "status", "--porcelain", "-uall"], {
    timeoutMs: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** 只读：用户仓全部 refs（hermetic 校验测试用） */
export async function userRepoRefs(repoRoot: string): Promise<string[]> {
  const out = await execFileAsync("git", ["-C", repoRoot, "for-each-ref", "--format=%(refname)"], {
    timeoutMs: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** 只读：用户仓某 pathspec 下已追踪文件（§3.5 显式追踪让位检查） */
export async function userRepoLsFiles(repoRoot: string, pathspec: string): Promise<string[]> {
  try {
    const out = await execFileAsync("git", ["-C", repoRoot, "ls-files", "--", pathspec], {
      timeoutMs: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
