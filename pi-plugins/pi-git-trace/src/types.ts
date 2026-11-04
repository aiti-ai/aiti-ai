/**
 * aiti-git-trace 共享类型 + WP-A（lib/recognize.ts / lib/resolve.ts）接口契约。
 *
 * 方案：docs/aiti-git-trace-plan.md §3.4/§3.6/§7.1/§7.2。
 * WP-B（本包）只在此定义接口；lib/recognize.ts、lib/resolve.ts 归 WP-A，
 * 经 src/recognition.ts 的 seam 注入，未合并前 engine 走本地兜底实现。
 */

export type Phase = "before" | "after" | "baseline" | "rollback" | "safety";

/** 一个被追踪的仓（主 store 或副 store）。store 以仓为锚（§3.1）。 */
export interface StoreHandle {
  /** 仓根（work-tree） */
  root: string;
  /** 追踪仓路径：<repoRoot>/.aiti-trace（GIT_DIR） */
  gitDir: string;
  /** work-tree（=仓根；trace.scope=cwd 时为会话目录） */
  workTree: string;
  /** 会话分支：refs/heads/aiti/<sid 短 id> */
  branch: string;
  role: "primary" | "secondary";
}

export interface StoreFileCounts {
  M: number;
  A: number;
  D: number;
  /** 超过大小上限被跳过的文件数 */
  skipped: number;
}

/** 台账 stores[] 项（§3.6） */
export interface StoreLedgerEntry {
  root: string;
  before: string | null;
  after: string;
  files: StoreFileCounts;
  paths: string[];
  pathsTruncated?: boolean;
  /** true = 首触 gap（before=null，最早可恢复点=首 commit） */
  partial: boolean;
}

/** 台账行（§3.6，字段与方案一致） */
export interface LedgerRow {
  op: number;
  entryId: string | null;
  /** turn 的用户消息 entry id（消息徽标按用户消息匹配；旧台账无此字段） */
  userEntryId?: string | null;
  /** turn 的用户 prompt 文本（时间线分组头用） */
  prompt?: string | null;
  msgSeq: number;
  tool: string;
  summary: string;
  t0: number;
  t1: number;
  cwd: string;
  userHead: string;
  parent: string | null;
  /** A01 方向1：共享 worktree 并行污染疑似标记——非核心写工具的 op 变更照记（不漏记/回滚安全），
   *  消费方（plan-first 绑定向导 md 检测/绿标清单）过滤或降权 suspect 行。 */
  suspect?: boolean;
  stores: StoreLedgerEntry[];
  leaks: Array<{ path: string; size?: number; kind: string }>;
}

/** commit message 头（§3.4）：`aiti op=12 msg=e_x phase=before` */
export interface CommitMeta {
  op: number;
  entryId: string | null;
  msgSeq: number;
  tool: string;
  phase: Phase;
  sessionId: string;
  cwd: string;
  repoRoot: string;
  userHead: string;
}

/* ---------------- WP-A seam（lib/recognize.ts / lib/resolve.ts） ---------------- */

/** write/edit 类工具 path 参数解析结果 */
export interface ToolPathResult {
  /** 解析出的绝对路径；无法解析为 null */
  abs: string | null;
}

/** bash 命令识别结果（基点跟踪：cd/pushd/popd、-C/--prefix 旗标、常见写目标） */
export interface BashTargetsResult {
  /** 命令写向/切换到的绝对路径集合（尽最大努力，不承诺全覆盖） */
  absolutePaths: string[];
}

/**
 * WP-A 实现的识别接口（§7.1）。M0 的 before/after 提交不依赖识别；
 * M3（关注路径）合入后由 engine 消费。
 */
export interface RecognitionApi {
  parseToolPath(input: unknown, cwd: string): ToolPathResult;
  parseBashTargets(command: string, cwd: string): BashTargetsResult;
}

/** WP-A 的归属解析接口（§3.7 path → store） */
export interface RepoResolverApi {
  /** 从 startDir 向上走查最近合法 .git（目录且含 HEAD）；无则 null */
  resolveRepoRoot(startDir: string): string | null;
  /** dir 的直接子目录中含 .git 仓的路径列表（一次 readdir） */
  findNestedRepos(dir: string): string[];
}

/** workspace 级关注路径配置（§7.2，M0 只读取结构） */
export interface WorkspaceWatchConfig {
  autoDiscover: boolean;
  paths: Array<{
    path: string;
    origin: "tool" | "cmd" | "user";
    repoRoot: string | null;
    addedAt: number;
  }>;
  /** [P0-1] bash 只读短路开关（缺省开；false = 关回严格全记，bash 一律走探测） */
  readOnlyBashFastPath?: boolean;
  /** [P0-3a] CWD 直接子仓自动注册（缺省 false；true = scanNestedRepos 恢复无条件注册并常驻参与） */
  trackNestedRepos?: boolean;
}
