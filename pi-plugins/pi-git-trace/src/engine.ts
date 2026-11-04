/**
 * TraceEngine：before/after 双 commit 引擎 + 多仓归属 + 台账（§3.4/§3.6/§3.7）。
 *
 * 红线自检：一切 git 写操作都经 HermeticGit（构造后无旁路）；对用户仓仅允许
 * userRepoHead/userRepoLsFiles 两个只读函数。
 *
 * op 成本优化（docs/aiti-git-trace-op-cost-optimization-plan.md，2026-09-13）：
 *  - P0-1 bash 只读短路：classifyBashMutability = readonly → 整 op 零 git 进程；
 *  - P0-2 探测门 + 懒提交 + 懒 tag：before 用 diff-index --quiet 探测（无手改零写），
 *    after 用枚举当探测（无候选零写）；tag 仅在「有变化 op」成对打（before-N→after
 *    提交的 parent、after-N→新 commit）；before 引用恒非 null（除首触/root commit）；
 *  - P0-3 仓数收敛：op 记账集合 = 常驻仓（primary/watchPaths/trackNestedRepos）∪
 *    本 op targets 命中仓；CWD 子仓默认不注册；turn_end flush 同步收敛；
 *  - P1-1 gitlink 兜底降频：每 turn 每仓至多一次。
 */
import fs from "node:fs";
import path from "node:path";
import { HermeticGit, queueRepo, userRepoHead } from "./git-wrap.ts";
import { ensureStore, excludeNestedInParent, storeGitDir } from "./store.ts";
import { ensureWired, getRecognition, getResolver, isWithinPath, isValidGitDir, classifyBashMutability } from "./recognition.ts";
import { appendRow, recoverLastOp } from "./ledger.ts";
import { ledgerFileFor, workspaceConfigFile } from "./paths.ts";
import { countFilesWithBudget, looseDenied, maintainLooseGitignore } from "./loose.ts";
import type { CommitMeta, LedgerRow, Phase, StoreFileCounts, StoreHandle, StoreLedgerEntry, WorkspaceWatchConfig } from "./types.ts";

/** 纯读工具白名单：之外的工具（含未识别的自定义工具）一律按会改处理（§3.5） */
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "glob", "ls", "find", "list", "search", "tree", "view", "cat",
]);

/** A01 方向1：核心写工具集合——其 op 的文件变更视为本会话所为（不打 suspect）。
 *  集合外（mcp__<server>_<tool> / 自定义工具）的 op：变更照记（不漏记、回滚安全），
 *  但打 suspect=可疑并行污染；plan-first 绑定向导/绿标清单过滤 suspect 行。
 *  已知纯读工具走 READ_ONLY_TOOLS 短路（不产生 op），bash 再经 classifyBashMutability
 *  二次判定——能落到台账行的非核心工具即本集合的补集。 */
const KNOWN_WRITE_TOOLS = new Set([
  "bash", "write", "edit", "multiedit", "apply_patch", "patch", "notebook_edit",
  "save", "create", "create_file", "write_file", "edit_file", "str_replace",
  "str_replace_editor", "move", "rename", "delete", "remove",
]);

/** Windows 保留设备名（大小写不敏感）：git 无法 stat/index，混入会让整批 add fatal */
const WIN_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Windows 保留设备名判定（含 <name>.<ext> 形态，nul.txt 同为保留）。
 * 典型来源：bash 里误用 cmd 风格 `> nul` 重定向 → 创建真实文件 nul。
 * 同步实现：pi-git-trace/src/excludes.ts（info/exclude 模式段）与
 * pi-web-ext/aiti-git-trace/trace-core.ts isWindowsReservedPath。
 */
export function isWindowsReservedPath(p: string): boolean {
  const base = p.split(/[\\/]/).pop() ?? "";
  const stem = base.split(".", 1)[0].toUpperCase();
  return WIN_RESERVED_NAMES.has(stem);
}

export interface EngineOptions {
  cwd: string;
  sessionId: string;
  dataDir: string;
  /** fork/子代理父会话（台账 parent 字段，§3.3） */
  parentSessionId?: string | null;
  /** [P1-2] 当前模型读取器（pi 侧 model_select 驱动；台账行 additive model 字段） */
  getModel?: () => { provider?: string; modelId?: string } | null;
  /** [P1-2 尾巴] 方案绑定读取器（plans.json 反查；台账行 additive planRel 字段） */
  getPlanRel?: () => string | null;
  /** scope=cwd 时 work-tree 取会话目录（巨型仓，§9） */
  scope?: "repo" | "cwd";
  maxFileKB?: number;
  builtinExcludes?: boolean;
  extraExcludes?: string[];
  includeExtra?: string[];
  /** 注入 entry id 获取（index.ts 由 ctx.sessionManager.getLeafEntry() 提供） */
  getEntryId?: () => string | null;
  /** §13.4 loose 模式：无 git 目录预算内自动建仓（默认开；config.json trace.autoInit） */
  autoInit?: boolean;
  /** loose 建仓文件数预算（默认 2000） */
  autoInitMaxFiles?: number;
  /** loose .gitignore 是否补常见条目（默认关） */
  seedCommonIgnores?: boolean;
  /** 是否应用内置系统目录 denylist（默认 true；测试 sandbox 在 /tmp 下时置 false） */
  looseDenylist?: boolean;
}

interface PendingOp {
  op: number;
  toolCallId: string;
  toolName: string;
  summary: string;
  t0: number;
  entryId: string | null;
  userEntryId: string | null;
  prompt: string | null;
  msgSeq: number;
  userHead: string;
  /** 范围外写入（仅记录列示，不拦截；§7.1） */
  leaks: { path: string; kind: string }[];
  /**
   * 本 op 参与记账的仓根集合（P0-3b：常驻仓 ∪ targets 命中仓）。
   * before 引用不在此保存——after 边界由 after 提交的 parent 推导（同会话串行
   * 队列内，before→after 之间分支只可能被本 op 的懒提交推进，parent 即正确的
   * before 引用；root commit → null → partial 首触语义自然成立）。
   */
  repos: Set<string>;
}

interface StoreRuntime {
  handle: StoreHandle;
  git: HermeticGit;
  /**
   * 常驻仓：每 op 无条件参与（primary / watchPaths 关注仓 / trackNestedRepos 注册的子仓）。
   * 非常驻副仓（cd 逃逸/写目标命中注册）仅在本 op 命中时参与（P0-3b）。
   */
  resident: boolean;
}

function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOLS.has(String(toolName).toLowerCase());
}

function buildMessage(meta: CommitMeta, summary: string): string {
  const dash = "-";
  const body = [
    `aiti op=${meta.op} msg=${meta.entryId ?? dash} phase=${meta.phase}`,
    summary || `${meta.tool}`,
    "",
    `Session-Id: ${meta.sessionId}`,
    `Entry-Id: ${meta.entryId ?? dash}`,
    `Msg-Seq: ${meta.msgSeq}`,
    `Op: ${meta.op}`,
    `Tool: ${meta.tool}`,
    `Phase: ${meta.phase}`,
    `Cwd: ${meta.cwd}`,
    `Repo-Root: ${meta.repoRoot}`,
    `User-Head: ${meta.userHead}`,
  ];
  return body.join("\n");
}

export class TraceEngine {
  readonly cwd: string;
  readonly sessionId: string;
  private readonly opts: Required<Pick<EngineOptions, "maxFileKB" | "scope">> & EngineOptions;
  private readonly stores = new Map<string, StoreRuntime>();
  private readonly pending = new Map<string, PendingOp>();
  private nextOp = 1;
  private msgSeq = 0;
  private lastOp = 0;
  private lastEntryId: string | null = null;
  noStore = false;
  noStoreReason = "";
  /** store 形态（§13.6）：git=仓内追踪；loose=无 git 自动建仓简易追踪 */
  kind: "git" | "loose" = "git";
  private initialized = false;
  workspaceConfig: WorkspaceWatchConfig | null = null;
  /** 观测用：每个 op 的台账行（测试/调试） */
  onLedgerRow?: (row: LedgerRow) => void;
  /** [P0-3d] 本 turn 参与过 op 的仓（turn_start 重置；flush 收敛用） */
  private turnActiveRoots = new Set<string>();
  /** [P1-1] gitlink 兜底扫描：每 turn 每仓至多一次（turn_start 重置） */
  private gitlinkScanTurn = new Set<string>();
  /** 兜底/自愈失败计数（可观测；不阻塞任何主流程） */
  errorCount = 0;
  /** [P2-2 lite] 记账开销计数：进入记账的 op / bash 只读短路 / 无变化整行省略 / 落账行 */
  readonly stats = { ops: 0, opsSkippedReadonly: 0, opsNoChange: 0, opsAccounted: 0 };

  constructor(opts: EngineOptions) {
    this.cwd = path.resolve(opts.cwd);
    this.sessionId = opts.sessionId;
    this.opts = {
      ...opts,
      maxFileKB: opts.maxFileKB ?? 2048,
      scope: opts.scope ?? "repo",
    };
  }

  get tracked(): boolean {
    return this.stores.size > 0;
  }

  get primary(): StoreRuntime | null {
    for (const s of this.stores.values()) if (s.handle.role === "primary") return s;
    return null;
  }

  /** 定位 + 初始化（幂等；cwd 无 git 时置态不建仓，§3.1） */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await ensureWired(); // WP-A lib 就绪则接入正式识别/归属实现
    const resolver = (await import("./recognition.ts")).getResolver();
    let repoRoot = resolver.resolveRepoRoot(this.cwd);
    // §7.2 workspace 配置提前消费（锚定 repoRoot，无 git 则 cwd）：enabled=false → 本工作区彻底不追踪
    // （特大项目性能保护；面板开关实时生效，见 checkWorkspaceSwitch）
    this.loadWorkspaceConfig(repoRoot || this.cwd);
    if (this.workspaceConfig?.enabled === false) {
      this.noStore = true;
      this.noStoreReason = "workspace-disabled";
      this.writeSessionState();
      return;
    }
    if (!repoRoot) {
      // §13.4 loose 决策链：autoInit 开 → 不在 denylist → 预算内 → 自动建仓（总是追踪）
      if (this.opts.autoInit === false) {
        this.noStore = true; this.noStoreReason = "no-git-disabled"; this.writeSessionState();
        return;
      }
      if (this.opts.looseDenylist !== false && looseDenied(this.cwd)) {
        this.noStore = true; this.noStoreReason = "no-git-denylist"; this.writeSessionState();
        return;
      }
      const budget = this.opts.autoInitMaxFiles ?? 2000;
      if (countFilesWithBudget(this.cwd, budget) > budget) {
        this.noStore = true; this.noStoreReason = "no-git-oversize"; this.writeSessionState();
        return;
      }
      try {
        maintainLooseGitignore(this.cwd, { seedCommon: this.opts.seedCommonIgnores === true });
        this.kind = "loose";
        repoRoot = this.cwd;
      } catch {
        this.noStore = true; this.noStoreReason = "no-git-init-failed"; this.writeSessionState();
        return;
      }
    }
    const handle = await ensureStore({
      repoRoot,
      sessionId: this.sessionId,
      role: "primary",
      scope: this.opts.scope,
      builtinExcludes: this.opts.builtinExcludes,
      extraExcludes: this.opts.extraExcludes,
      includeExtra: this.opts.includeExtra,
    });
    this.register(handle, true);
    // 台账为权威：wrapper 重建后续接 op 编号（§4）
    this.lastOp = recoverLastOp(ledgerFileFor(this.opts.dataDir, this.sessionId));
    this.nextOp = this.lastOp + 1;
    // §3.3 嵌套仓一层预扫：info/exclude 恒写（防 gitlink 污染）；注册副 store 受
    // trackNestedRepos 门控（P0-3a：默认不注册，子仓命中 op 时按需参与）
    await this.scanNestedRepos(handle, resolver);
    // §7.2 消费：关注路径（user 配置，不受 autoDiscover 影响）归属的 git 仓 → 副 store 注册（常驻参与）
    const wc0 = this.workspaceConfig;
    if (wc0 && Array.isArray(wc0.paths)) {
      for (const wp of wc0.paths) {
        try {
          const root = wp.repoRoot && isValidGitDir(path.join(wp.repoRoot, ".git"))
            ? wp.repoRoot
            : resolver.resolveRepoRoot(wp.path || "");
          if (root && root !== handle.root && !this.stores.has(root)) await this.ensureSecondary(root, true);
        } catch { /* 单条路径失效不阻塞 */ }
      }
    }
  }

  private register(handle: StoreHandle, resident: boolean): StoreRuntime {
    const rt: StoreRuntime = {
      handle,
      resident,
      git: new HermeticGit(() => ({
        gitDir: handle.gitDir,
        workTree: handle.workTree,
        indexFile: path.join(handle.gitDir, `index-${this.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-")}`),
      })),
    };
    this.stores.set(handle.root, rt);
    this.writeSessionState(); // 关注路径面板展示会话识别仓（§7.2 session 级）
    return rt;
  }

  private async ensureSecondary(nestedRoot: string, resident = false): Promise<StoreRuntime> {
    const existing = this.stores.get(nestedRoot);
    if (existing) return existing;
    const handle = await ensureStore({
      repoRoot: nestedRoot,
      sessionId: this.sessionId,
      role: "secondary",
      scope: this.opts.scope,
      builtinExcludes: this.opts.builtinExcludes,
      extraExcludes: this.opts.extraExcludes,
      includeExtra: this.opts.includeExtra,
    });
    return this.register(handle, resident);
  }

  /** 嵌套仓一层预扫（§3.3 + P0-3a）：exclude 恒写（防父仓 gitlink 污染，必须）；
   *  注册副 store 受 trackNestedRepos 门控（默认 false——子仓按 op 命中参与），开启时常驻参与。 */
  async scanNestedRepos(handle: StoreHandle, resolver: { findNestedRepos(dir: string): string[] }): Promise<void> {
    try {
      const track = this.workspaceConfig?.trackNestedRepos === true;
      for (const abs of resolver.findNestedRepos(handle.workTree)) {
        const rel = path.relative(handle.workTree, abs).split(path.sep).join("/") + "/";
        excludeNestedInParent(handle, rel);
        if (track && !this.stores.has(abs)) await this.ensureSecondary(abs, true);
      }
    } catch { /* 预扫失败不阻塞 */ }
  }

  /** 运行期嵌套仓预扫（turn_start 调用；主 store 变化后新出现的嵌套仓及时入网） */
  async scanNestedRuntime(): Promise<void> {
    const rt = this.primary;
    if (!rt) return;
    await this.scanNestedRepos(rt.handle, getResolver());
  }

  /** 会话状态文件（§3.1 无 git 提醒 / UI 判断用；写失败不阻塞） */
  writeSessionState(): void {
    try {
      const stDir = path.join(this.opts.dataDir, "aiti-git-trace", "cache", "state"); // 数据分层：state → cache/（与 web 扩展对齐）
      fs.mkdirSync(stDir, { recursive: true });
      fs.writeFileSync(path.join(stDir, `${this.sessionId}.json`), JSON.stringify({
        cwd: this.cwd,
        kind: this.kind,
        noStore: this.noStore,
        noStoreReason: this.noStoreReason,
        tracked: this.tracked,
        stores: Array.from(this.stores.values()).map((rt) => ({ root: rt.handle.root, role: rt.handle.role })),
        ts: Date.now(),
      }));
    } catch { /* 不阻塞 */ }
  }

  /* ---------------- 事件流 ---------------- */

  /** turn 当前用户消息 entry id（消息徽标按用户消息匹配，§4/§8.2） */
  turnUserEntryId: string | null = null;
  turnPrompt: string | null = null;

  /** turn_start：用户消息锚点（§4）。仅当捕获到「新」用户消息时推进 msgSeq——
   *  同一用户消息的后续 agent turn（turn 2+）保持 msgSeq/prompt 不变，归入同一 prompt 分组。 */
  onTurnStart(prompt?: { userEntryId: string; text: string } | null): void {
    this.turnActiveRoots = new Set(); // [P0-3d] flush 收敛窗口按 turn 重置
    this.gitlinkScanTurn.clear(); // [P1-1] 兜底扫描降频窗口
    if (prompt) {
      this.msgSeq += 1;
      this.turnUserEntryId = prompt.userEntryId || null;
      this.turnPrompt = prompt.text || null;
    }
  }

  /** 工作区配置读取（记录 mtime 供实时开关检测；读失败 = 缺省开） */
  private wsCfgMtime = 0;
  private loadWorkspaceConfig(anchor: string): void {
    const cfgFile = workspaceConfigFile(anchor, process.env);
    try {
      this.wsCfgMtime = fs.statSync(cfgFile).mtimeMs;
      this.workspaceConfig = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
    } catch {
      this.wsCfgMtime = 0;
      this.workspaceConfig = null;
    }
  }

  /** 工作区追踪开关实时生效（onToolCall 前调用）：面板切 enabled 后不等 wrapper 重建。
     单次 statSync，mtime 变了才重读文件；关→丢 stores，开→重新 init（op 号由台账续接）。 */
  private async checkWorkspaceSwitch(): Promise<void> {
    try {
      const anchor = this.primary?.handle.root || this.cwd;
      const f = workspaceConfigFile(anchor, process.env);
      const m = fs.statSync(f).mtimeMs;
      if (m === this.wsCfgMtime) return;
      this.wsCfgMtime = m;
      this.workspaceConfig = JSON.parse(fs.readFileSync(f, "utf8"));
      const disabled = this.workspaceConfig?.enabled === false;
      const wasDisabled = this.noStore && this.noStoreReason === "workspace-disabled";
      if (disabled && !wasDisabled) {
        this.stores.clear();
        this.noStore = true;
        this.noStoreReason = "workspace-disabled";
        this.writeSessionState();
      } else if (!disabled && wasDisabled) {
        this.noStore = false;
        this.noStoreReason = "";
        this.initialized = false;
        await this.init(); // 幂等；op 编号由台账续接（§4）
      }
    } catch { /* 配置不存在/读失败：保持现状 */ }
  }

  /**
   * tool_call（执行前）：bash 只读短路（P0-1）→ mutating 判定 → 命中仓收敛（P0-3b）
   * → before 边界探测门（P0-2 懒提交）。
   */
  async onToolCall(toolCallId: string, toolName: string, input: unknown): Promise<void> {
    if (!this.initialized || isReadOnlyTool(toolName)) return;
    if (this.pending.has(toolCallId)) return; // 重复事件防御
    // [P0-1] bash 只读短路：判定 readonly → 整 op 零 git 进程（不建 pending、不消费
    // op 号、不识别/不注册副仓——cd 探索/路径触碰不再产生副仓注册，方案的必然取舍）。
    // 工作区开关 readOnlyBashFastPath 可关回严格全记。放在 checkWorkspaceSwitch 之前：
    // 只读 op 连配置 mtime stat 都省掉（重开追踪由下一个 mutating op 触发）。
    const toolLower = String(toolName).toLowerCase();
    if (toolLower === "bash"
        && this.workspaceConfig?.readOnlyBashFastPath !== false
        && typeof (input as Record<string, unknown> | null)?.command === "string") {
      if (classifyBashMutability(String((input as Record<string, unknown>).command)) === "readonly") {
        this.stats.opsSkippedReadonly += 1;
        return;
      }
    }
    await this.checkWorkspaceSwitch();
    if (!this.initialized) return; // 实时开关关闭了本工作区追踪
    if (this.noStore && this.noStoreReason === "workspace-disabled") return; // 已关闭：不建 pending，不落台账
    const op = this.nextOp++;
    this.lastOp = op;
    this.stats.ops += 1;
    const entryId = this.opts.getEntryId?.() ?? null;
    this.lastEntryId = entryId;
    const userHead = this.primary ? await userRepoHead(this.primary.handle.root) : "-";
    // §7.1 识别消费（autoDiscover 缺省开；关闭则仅用户配置路径生效）：
    // tool/bash 写向路径 → 归属仓 → 副 store 注册（本次 before 循环即含它=首触即配对）。尽最大努力，绝不阻塞 op。
    // §7.1 leak 记账（只记录，永不拦截——整个功能服务用户，不给用户添堵）：
    // 识别到的写入落点若不在任何已知追踪范围内（非 git 路径，或 autoDiscover 关时的未注册仓）
    // → 记入 pending.leaks，随台账入账，时间线亮「外溢」徽标。
    // GAP-21 修复（lineage-closure P2-7）：识别/leak 记账恒跑，只有「自动注册副 store」
    // 受 autoDiscover 门控——关闭时未注册仓的写入按文档语义记外溢，不再整块跳过。
    // [P0-3b] 命中仓收集：targets 命中的注册仓进入本 op 记账集合。
    const leaks: { path: string; kind: string }[] = [];
    const hitRoots = new Set<string>();
    {
      const autoDiscoverOn = this.workspaceConfig ? this.workspaceConfig.autoDiscover !== false : true;
      const rec = getRecognition();
      if (rec) {
        try {
          const inp = (input ?? {}) as Record<string, unknown>;
          let targets: string[] = [];
          if (toolLower === "bash" && typeof inp.command === "string") {
            targets = rec.parseBashTargets(inp.command, this.cwd).absolutePaths;
          } else {
            const tp = rec.parseToolPath(input, this.cwd);
            if (tp.abs) targets = [tp.abs];
          }
          const resolver = getResolver();
          const primaryRoot = this.primary?.handle.root ?? null;
          for (const t of targets) {
            const root = resolver.resolveRepoRoot(t);
            if (autoDiscoverOn && root && !this.stores.has(root)) await this.ensureSecondary(root);
            if (root && this.stores.has(root)) { hitRoots.add(root); continue; }
            // 未归属：primary 工作树内的写入由主 store 枚举兜底（loose/cwd 无 repoRoot
            // 场景 resolveRepoRoot 本就为 null），不记外溢；其余（仓外/未注册仓）→ 外溢。
            if (primaryRoot && isWithinPath(primaryRoot, t)) continue;
            leaks.push({ path: t, kind: String(toolName) });
          }
        } catch { /* 识别失败按未识别处理 */ }
      }
    }
    const pending: PendingOp = {
      op,
      toolCallId,
      toolName: String(toolName),
      summary: summarize(toolName, input),
      t0: Date.now(),
      entryId,
      userEntryId: this.turnUserEntryId,
      prompt: this.turnPrompt,
      msgSeq: Math.max(this.msgSeq, 1),
      userHead,
      leaks: leaks.filter((l, i) => leaks.findIndex((x) => x.path === l.path) === i).slice(0, 20),
      repos: new Set(),
    };
    this.pending.set(toolCallId, pending);
    // [P0-3b] before 循环收敛：常驻仓 ∪ 本 op 命中仓（此前对全部 stores 无差别跑）
    for (const rt of this.stores.values()) {
      if (!rt.resident && !hitRoots.has(rt.handle.root)) continue;
      const root = rt.handle.root;
      if (!isValidGitDir(rt.handle.gitDir)) {
        // §15 清理自愈：store 被删（面板深清理）→ 重建空仓（beforeBoundary 对缺失仓会静默 null，必须显式检）
        try { await this.rebuildStore(rt); } catch { this.errorCount += 1; continue; }
      }
      try {
        await this.beforeBoundary(rt, pending);
      } catch {
        // §15 清理自愈：追踪仓被删除（用户在面板清理工作区）→ 重建空仓重试一次；再失败放弃本仓（绝不影响原命令）
        try {
          await this.rebuildStore(rt);
          await this.beforeBoundary(rt, pending);
        } catch {
          this.errorCount += 1;
          continue;
        }
      }
      pending.repos.add(root);
      this.turnActiveRoots.add(root);
    }
  }

  /** 清理自愈：重建（被删/损坏的）追踪仓为全新空仓并替换运行时（ensureStore 幂等建仓） */
  private async rebuildStore(rt: StoreRuntime): Promise<void> {
    const h = await ensureStore({
      repoRoot: rt.handle.root,
      sessionId: this.sessionId,
      role: rt.handle.role,
      scope: this.opts.scope,
      builtinExcludes: this.opts.builtinExcludes,
      extraExcludes: this.opts.extraExcludes,
      includeExtra: this.opts.includeExtra,
    });
    this.register(h, rt.resident);
  }

  /**
   * [P0-2] after 边界 + 台账 store 条目（探测门第二级）：diff-index --quiet +
   * ls-files --others（≤2 条读）判净；干净 → 本仓零写入（不 add/不 write-tree/
   * 不 commit/不打 tag）；疑似变化 → 枚举取 add 路径提交 + 成对懒打 tag：
   *   before-<op> → after 提交的 parent（= before 边界引用：懒提交 sha 或旧 tip；
   *                 root commit → null → partial 首触语义自然成立）
   *   after-<op>  → 新 commit（「按 commit sha 打」）
   * 无变化 op 零 tag（refs 膨胀止血）。per-gitDir 串行队列保证同仓读改写序列原子化。
   */
	private async afterBoundary(rt: StoreRuntime, pending: PendingOp, tagBase = String(pending.op)): Promise<StoreLedgerEntry | null> {
		return queueRepo(rt.handle.gitDir, async () => {
			// [P0-2] 探测门：diff-index --quiet 内容精确（纯 touch 被 refresh 消化，不受
			// ls-files -m 的 stat 假阳性影响）+ ls-files --others 补 untracked；干净 → 零写。
			// 疑似变化（1/128/探测失败）→ 枚举取 add 路径走全量（commitOn 的 tree 比较兜底假阳性）。
			const probe = await rt.git.probeTrackedDirty(rt.handle.branch);
			if (probe.status === 0) {
				const un = await rt.git.tryRun(["ls-files", "--others", "--exclude-standard"]);
				if (!un.ok || !un.stdout.trim()) return null; // 无变化：零写
			}
			const pre = await this.enumerateCandidates(rt);
			if (pre.paths.length === 0) return null; // 兜底：探测报变化但枚举为空
			const meta: CommitMeta = {
				op: pending.op,
				entryId: pending.entryId,
				msgSeq: pending.msgSeq,
				tool: pending.toolName,
				phase: "after",
				sessionId: this.sessionId,
				cwd: this.cwd,
				repoRoot: rt.handle.root,
				userHead: pending.userHead,
			};
			const sha = await this.commitOn(rt, meta, pending.summary, { pre });
			if (!sha) return null; // tree 兜底：候选非空但 parentTree===tree（假阳性防护）
			const short = rt.handle.branch.split("/").pop() || "s";
			const parent = await rt.git.tryRun(["rev-parse", "--verify", "--quiet", `${sha}^`]);
			const beforeRef = parent.ok && parent.stdout.trim() ? parent.stdout.trim() : null;
			if (beforeRef) {
				try { await rt.git.run(["tag", `aiti/${short}/before-${tagBase}`, beforeRef]); } catch { /* 已存在则跳过 */ }
			}
			try { await rt.git.run(["tag", `aiti/${short}/after-${tagBase}`, sha]); } catch { /* 已存在则跳过 */ }
      const { files, paths, truncated } = await this.diffStat(rt, beforeRef, sha);
      return {
        root: rt.handle.root,
        before: beforeRef,
        after: sha,
        files,
        paths,
        pathsTruncated: truncated || undefined,
        // 首触 gap：before=null 即 partial（§3.7）
        partial: beforeRef === null,
      };
    });
  }

  /**
   * [P0-2] before 边界（探测门第一级 + 懒提交）：
   *   diff-index --quiet <branch>：0=无手改 → 跳过提交（本边界零写）；
   *   1=有手改 → 懒提交（「手改独立快照」语义保持）；128=分支不存在（首触/新会话）
   *   或其他失败 → fallback 全量流程（commitOn 无候选自跳过，不会产生空引导提交）。
   * before 引用不在此处读取：after 边界由 after 提交的 parent 推导（见 PendingOp.repos）。
   */
  private async beforeBoundary(rt: StoreRuntime, pending: PendingOp): Promise<void> {
    return queueRepo(rt.handle.gitDir, async () => {
      const probe = await rt.git.probeTrackedDirty(rt.handle.branch);
      if (probe.status === 0) return; // 无手改：零写（新会话空 index 对既有分支报 1 → 走下方全量=首 op 快照，与现状一致）
      const meta: CommitMeta = {
        op: pending.op,
        entryId: pending.entryId,
        msgSeq: pending.msgSeq,
        tool: pending.toolName,
        phase: "before",
        sessionId: this.sessionId,
        cwd: this.cwd,
        repoRoot: rt.handle.root,
        userHead: pending.userHead,
      };
      await this.commitOn(rt, meta, pending.summary, {});
    });
  }

  /** tool_execution_end（执行后）：after 提交（探测门）+ 台账行（真实顺序落，§3.4） */
  async onToolExecutionEnd(toolCallId: string, _isError?: boolean): Promise<void> {
    const pending = this.pending.get(toolCallId);
    if (!pending) return; // 纯读工具/只读短路/未知事件：跳过（兜底由 turn_end 覆盖）
    this.pending.delete(toolCallId);
    const t1 = Date.now();
    const stores: StoreLedgerEntry[] = [];
    // [P0-3b] 只遍历本 op 参与的仓（pending.repos），不再遍历全部 stores
    for (const root of pending.repos) {
      const rt = this.stores.get(root);
      if (!rt) continue; // 仓已移除（工作区开关）：本 op 该仓不落
      if (!isValidGitDir(rt.handle.gitDir)) {
        // op 中间仓被清理：重建空仓 → after 全量快照（root commit → partial 语义自然成立）
        try { await this.rebuildStore(rt); }
        catch { this.errorCount += 1; continue; }
      }
      let entry: StoreLedgerEntry | null = null;
      try {
        entry = await this.afterBoundary(rt, pending);
      } catch {
        try { await this.rebuildStore(rt); entry = await this.afterBoundary(rt, pending); }
        catch { this.errorCount += 1; continue; }
      }
      if (entry) stores.push(entry);
    }
    // [P0-2] 无变化 op 不落台账：无 store 条目且无外溢 → 整行省略（时间线不再出现
    // files 全 0 空条目；op 号跳号由消费方对齐——plan-first 原生容忍，§5 已审计）。
    // 带外溢的行必须保留（leaks 是外溢写入的唯一记录）。
    if (stores.length === 0 && pending.leaks.length === 0) {
      this.stats.opsNoChange += 1;
      return;
    }
    const row: LedgerRow = {
      op: pending.op,
      entryId: pending.entryId,
      userEntryId: pending.userEntryId,
      prompt: pending.prompt ?? null,
      msgSeq: pending.msgSeq,
      tool: pending.toolName,
      summary: pending.summary,
      t0: pending.t0,
      t1,
      cwd: this.cwd,
      userHead: pending.userHead,
      parent: this.opts.parentSessionId ?? null,
      // [P1-2] additive 主体/模型字段（旧台账行缺省兼容；agent 恒 "pi"——pi 运行时会话专属追踪器）
      agent: "pi",
      ...(() => {
        const m = this.opts.getModel?.();
        if (!m) return {};
        const model = [m.provider, m.modelId].filter(Boolean).join("/");
        return model ? { model } : {};
      })(),
      // [P1-2 尾巴] additive 方案绑定（planRel）+ 生命周期 phase（从 planRel 文档 front-matter 状态 tag 推导）
      ...(() => {
        const rel = this.opts.getPlanRel?.();
        return rel ? { planRel: rel } : {};
      })(),
      // [A01 方向1] 共享 worktree 并行污染打标：非核心写工具（mcp__*/自定义工具——名字无法自证
      // 写能力）的 op 变更照记（不漏记、回滚安全），但打 suspect=「可疑并行污染」；
      // 消费方（plan-first 绑定向导 md 检测/绿标清单）过滤 suspect 行，避免误报他 session 的文件。
      ...(!KNOWN_WRITE_TOOLS.has(pending.toolName) ? { suspect: true } : {}),
      stores,
      leaks: pending.leaks,
    };
    appendRow(ledgerFileFor(this.opts.dataDir, this.sessionId), row);
    this.stats.opsAccounted += 1;
    this.onLedgerRow?.(row);
  }

  /**
   * turn_end：无条件兜底（§3.5）——各仓脏则 flush commit（不占 op 编号、不写台账行）。
   * [P0-3d] flush 收敛：常驻仓（primary/watchPaths/trackNestedRepos）+ 本 turn 参与过
   * op 的仓；无 op 命中且非常驻的仓跳过（不再全 stores 各烧 2 条枚举）。
   */
  async onTurnEnd(): Promise<void> {
    if (!this.initialized || this.stores.size === 0) return;
    const roots = new Set<string>();
    for (const rt of this.stores.values()) if (rt.resident) roots.add(rt.handle.root);
    for (const root of this.turnActiveRoots) if (this.stores.has(root)) roots.add(root);
    for (const root of roots) {
      const rt = this.stores.get(root);
      if (!rt) continue;
      // 整个 flush（枚举读 + 提交写）入同仓串行队列：与边界提交序列严格串行，
      // 防异步化后 flush 与 before/after 交错（原同步实现天然串行）。
      await queueRepo(rt.handle.gitDir, async () => {
        const pre = await this.enumerateCandidates(rt);
        if (pre.paths.length === 0) return; // 干净（相对会话分支，由 commitOn 判定）或全部被过滤
        // 安全预算：argv+env 总量受 execve ARG_MAX 限制（Linux ~2MB），
        // 预留 64KB 给 env+git 剩余参数，summary 上限 ~2MB
        const MAX_SUMMARY_BYTES = 2 * 1024 * 1024 - 64 * 1024;
        let cutCount = pre.paths.length;
        {
          let bytes = 0;
          for (let i = 0; i < pre.paths.length; i++) {
            const add = (i > 0 ? 2 : 0) + Buffer.byteLength(pre.paths[i], "utf8");
            if (bytes + add > MAX_SUMMARY_BYTES) { cutCount = i; break; }
            bytes += add;
          }
        }
        const shown = pre.paths.slice(0, cutCount).join(", ");
        const suffix = cutCount < pre.paths.length ? ` ... (+${pre.paths.length - cutCount} more)` : "";
        const summary = `_turn_flush: turn-end residue checkpoint\n\nFiles (${pre.paths.length}): ${shown}${suffix}`;
        const flushHead = rt.handle.role === "primary" ? await userRepoHead(rt.handle.root) : "-";
        await this.commitOn(rt, {
          op: this.lastOp || 0,
          entryId: this.lastEntryId,
          msgSeq: Math.max(this.msgSeq, 1),
          tool: "_turn_flush",
          phase: "after",
          sessionId: this.sessionId,
          cwd: this.cwd,
          repoRoot: rt.handle.root,
          userHead: flushHead,
        }, summary, { pre });
      });
    }
  }

	/* ---------------- plan 采认记账（fusion 实施档 §2.3：begin/end/note 三原语） ---------------- */

	private planSeq = 0;

	/** 合成 pending（复用 before/after 边界提交管线；不占引擎 op 编号——台账 plan 行与
	 *  rollback 行同策略：kind 标识 + 时间序，op=lastOp 仅作 commit message 占位） */
	private syntheticPending(summary: string): PendingOp {
		return {
			op: this.lastOp || 0,
			toolCallId: `plan-record-${++this.planSeq}`,
			toolName: "plan-accept",
			summary,
			t0: Date.now(),
			entryId: this.opts.getEntryId?.() ?? null,
			userEntryId: this.turnUserEntryId,
			prompt: this.turnPrompt,
			msgSeq: Math.max(this.msgSeq, 1),
			userHead: "-",
			leaks: [],
			repos: new Set(),
		};
	}

	/** begin：采认执行前打 before 边界（脏才提交，flush 同语义）。无 store → null（调用方降级）。
	 *  before 提交失败同样返回 null——end 退化为「只落台账行」，采认主流程绝不受影响。 */
	async planRecordBegin(summary: string): Promise<string | null> {
		if (!this.initialized || this.noStore) return null;
		const rt = this.primary;
		if (!rt || !isValidGitDir(rt.handle.gitDir)) return null;
		const id = `plan-${++this.planSeq}`;
		try {
			const pending = this.syntheticPending(summary);
			try { pending.userHead = await userRepoHead(rt.handle.root); } catch { /* 保持 "-" */ }
			await this.beforeBoundary(rt, pending);
		} catch {
			return null;
		}
		return id;
	}

	/** end：accepted → after 边界（成对懒 tag，tag 基 = recordId）+ 台账单一 op
	 *  （kind=plan-accept，带 stores[]——时间线/回滚按「有无 stores[]」分派）；
	 *  rolledback（门禁失败整单回滚）→ 工作区已恢复原状无净 diff，只落台账行（kind=plan-rollback）。
	 *  台账行带 kind 无 op 编号（readRows/recoverLastOp 只认 op 行，天然忽略；web 消费侧对
	 *  plan 行容错——与 P1-1 op-less 行同共存语义，字段为其超集）。 */
	async planRecordEnd(recordId: string | null, info: { outcome: "accepted" | "rolledback"; summary?: string; sandbox?: string; files?: string[]; deletions?: string[]; conflicts?: string[]; mission?: string | null }): Promise<void> {
		const t = Date.now();
		const row: Record<string, unknown> = {
			kind: info.outcome === "accepted" ? "plan-accept" : "plan-rollback",
			tool: "plan-accept",
			summary: String(info.summary || "").slice(0, 500),
			t,
			t0: t,
			t1: t,
			sandbox: String(info.sandbox || ""),
			files: (info.files || []).map(String).filter(Boolean),
			deletions: (info.deletions || []).map(String).filter(Boolean),
			conflicts: (info.conflicts || []).map(String).filter(Boolean),
			mission: info.mission || null,
			cwd: this.cwd,
			agent: "pi",
		};
		const planRel = this.opts.getPlanRel?.();
		if (planRel) row.planRel = planRel;
		if (recordId && info.outcome === "accepted" && this.initialized && !this.noStore) {
			const rt = this.primary;
			if (rt && isValidGitDir(rt.handle.gitDir)) {
				try {
					const entry = await this.afterBoundary(rt, this.syntheticPending(String(row.summary)), recordId);
					if (entry) row.stores = [entry];
				} catch { /* 提交失败：台账行照落（无 stores 形态） */ }
			}
		}
		appendRow(ledgerFileFor(this.opts.dataDir, this.sessionId), row as unknown as LedgerRow);
		this.onLedgerRow?.(row as unknown as LedgerRow);
	}

	/** note：丢弃（无文件变更，不 commit）——纯台账行 kind=plan-discard。 */
	async planRecordNote(info: { summary?: string; sandbox?: string; projectDir?: string }): Promise<void> {
		const t = Date.now();
		const row: Record<string, unknown> = {
			kind: "plan-discard",
			tool: "plan-accept",
			summary: String(info.summary || "").slice(0, 500),
			t,
			t0: t,
			t1: t,
			sandbox: String(info.sandbox || ""),
			cwd: info.projectDir || this.cwd,
			agent: "pi",
		};
		const planRel = this.opts.getPlanRel?.();
		if (planRel) row.planRel = planRel;
		appendRow(ledgerFileFor(this.opts.dataDir, this.sessionId), row as unknown as LedgerRow);
		this.onLedgerRow?.(row as unknown as LedgerRow);
	}

	/* ---------------- 内部：提交与探测 ---------------- */

  /**
   * 枚举/传入候选 → 过滤 → add → gitlink 兜底（[P1-1] 每 turn 一次）→ write-tree →
   * commit-tree → update-ref。无变化（parentTree===tree）或（新分支且无候选）→ 返回
   * null——[P0-2] 不再产生空提交；tag 已移至 afterBoundary 成对懒打（flush 提交不打 tag）。
   *
   * 全异步（execFile）：不阻塞事件循环；同仓序列由调用方的 queueRepo 串行化。
   * 不经 HEAD/工作区 checkout：plumbing 三步（write-tree → commit-tree → update-ref 分支），
   * 同仓多会话各走各分支、互不干扰（每会话独立 GIT_INDEX_FILE）。
   */
  private async commitOn(rt: StoreRuntime, meta: CommitMeta, summary: string, opts: { pre?: { addPaths: string[]; skipped: number } } = {}): Promise<string | null> {
    const branch = rt.handle.branch;
    // parent commit + parent tree 一次 rev-parse 拿全（两个 rev 一次调用，省一个 fork/边界）。
    // 分支不存在时 git 回显原参数且 exit≠0 → 只认 hex 行；tree 意外缺失时回退单查。
    const rp = await rt.git.tryRun(["rev-parse", "--quiet", branch, `${branch}^{tree}`]);
    const rpLines = rp.ok
      ? rp.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l))
      : [];
    const parent = rpLines[0] ?? null;
    let parentTree: string | null = rpLines[1] ?? null;
    if (parent && !parentTree) {
      const t = await rt.git.tryRun(["rev-parse", "--verify", "--quiet", `${branch}^{tree}`]);
      parentTree = t.ok ? t.stdout.trim() : null;
    }

    // v3：枚举候选（与 add 同一套 exclude 评估）→ 大小过滤 → add → commit（§3.4）
    const { paths: addPaths, skipped } = opts.pre ?? await this.enumerateCandidates(rt);
    // 分支 newborn 且本次无内容：不产生空引导提交（§3.7）
    if (addPaths.length === 0 && parentTree === null) {
      this.lastSkipped = skipped;
      return null;
    }
    for (let i = 0; i < addPaths.length; i += 500) {
      const batch = addPaths.slice(i, i + 500);
      const r = await rt.git.tryRun(["add", "--", ...batch]);
      if (!r.ok) {
        // 批次内有 git 无法索引的文件（Windows 保留设备名 nul 等）→ 整批 fatal。
        // 降级逐文件 add：坏文件跳过（计错误数），不拖垮整个追踪提交。
        for (const p of batch) {
          if (!(await rt.git.tryRun(["add", "--", p])).ok) this.errorCount += 1;
        }
      }
    }
    // 嵌套仓/submodule 兜底：staged gitlink（160000）→ 剔除 + exclude。
    // submodule（.git 为指针文件）只排除不入库；真嵌套仓（.git 为目录）注册副 store。
    // [P1-1] 降频：每 turn 每仓至多一次（scanNestedRepos 的 exclude 已覆盖主路径，兜底可低频）。
    // 整段防弹：失败不影响 commit 本体。
    if (!this.gitlinkScanTurn.has(rt.handle.root)) {
      this.gitlinkScanTurn.add(rt.handle.root);
      try {
        const staged = (await rt.git.tryRun(["ls-files", "-s"])).stdout;
        for (const line of staged.split("\n")) {
          const tab = line.indexOf("\t");
          if (tab < 0 || !line.startsWith("160000 ")) continue;
          const glPath = line.slice(tab + 1).trim();
          if (!glPath) continue;
          excludeNestedInParent(rt.handle, glPath.endsWith("/") ? glPath : glPath + "/");
          await rt.git.run(["rm", "--cached", "--", glPath]);
          const abs = path.join(rt.handle.workTree, glPath);
          let real = false;
          try { real = fs.statSync(path.join(abs, ".git")).isDirectory() && fs.existsSync(path.join(abs, ".git", "HEAD")); } catch {}
          if (real && this.workspaceConfig?.trackNestedRepos === true && !this.stores.has(abs)) {
            try { await this.ensureSecondary(abs, true); } catch { /* init 失败按无仓处理 */ }
          }
        }
      } catch (e) {
        this.errorCount += 1; // 兜底失败不阻塞 commit 本体
      }
    }
    const tree = (await rt.git.run(["write-tree"])).trim();
    // 无变化：跳过（[P0-2] primary/副仓统一「脏才提交」，空提交消失）
    if (parentTree !== null && parentTree === tree) {
      this.lastSkipped = skipped;
      return null;
    }
    const msg = buildMessage(meta, summary);
    const args = ["commit-tree", tree];
    if (parent) args.push("-p", parent);
    args.push("-m", msg);
    const sha = (await rt.git.run(args)).trim();
    await rt.git.run(["update-ref", branch, sha]);
    this.lastSkipped = skipped;
    return sha;
  }

  private lastSkipped = 0;

  /**
   * v3 枚举（§3.4②③）：git 自己的枚举（ls-files 与 add 同一套 exclude 评估，
   * 杜绝 status/add 判定不一致的硬失败类）+ statSync 大小过滤。
   * [P0-2] 本函数同时是 after 边界的探测门：输出即 add 路径，空输出 = 无变化。
   */
  private async enumerateCandidates(rt: StoreRuntime): Promise<{ paths: string[]; skipped: number }> {
    const paths: string[] = [];
    let skipped = 0;
    const un = await rt.git.tryRun(["ls-files", "--others", "--exclude-standard"]);
    const md = await rt.git.tryRun(["ls-files", "-m", "-d"]);
    for (const line of ((un.ok ? un.stdout : "") + "\n" + (md.ok ? md.stdout : "")).split("\n")) {
      const p = line.trim();
      if (!p) continue;
      // belt：追踪仓自身不入库（§13.3①；info/exclude 已有 .aiti-trace/，此处双保险）
      if (p === ".aiti-trace" || p.startsWith(".aiti-trace/") || p.includes("/.aiti-trace/") || p.endsWith("/.aiti-trace")) continue;
      // belt：Windows 保留设备名（bash 误 `> nul` 建出的真实 nul 等）不入库——
      // info/exclude v2 已排除，此处防未升级仓/否定规则救回
      if (isWindowsReservedPath(p)) continue;
      // untracked 新文件：大小过滤（tracked 的修改/删除不过滤——内容变化本身值得记）
      const tracked = md.ok && (md.stdout + "\n").includes("\n" + p + "\n") || md.stdout.startsWith(p + "\n") || md.stdout === p;
      if (!tracked) {
        try {
          if (fs.statSync(path.join(rt.handle.workTree, p)).size > this.opts.maxFileKB * 1024) { skipped += 1; continue; }
        } catch { /* 已消失：跳过 */ }
      }
      paths.push(p);
    }
    return { paths, skipped };
  }

  /** before..after 的 name-status 统计与路径（partial 时退化为 after 提交自身 diff） */
  private async diffStat(rt: StoreRuntime, before: string | null, after: string): Promise<{
    files: StoreFileCounts;
    paths: string[];
    truncated: boolean;
  }> {
    const files: StoreFileCounts = { M: 0, A: 0, D: 0, skipped: this.lastSkipped };
    // partial（before=null）：退化为 after 提交自身 diff；--root 兼容分支首 commit（after^ 不存在）
    const args = before ? ["diff", "--name-status", `${before}..${after}`]
                        : ["diff-tree", "-r", "--name-status", "--root", after];
    const res = await rt.git.tryRun(args);
    let paths: string[] = [];
    if (res.ok) {
      for (const line of res.stdout.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        const code = parts[0][0];
        const p = parts.length > 2 ? parts[2] : parts[1];
        if (p) paths.push(p);
        if (code === "A") files.A += 1;
        else if (code === "D") files.D += 1;
        else files.M += 1; // M/R/C/T 等归 M
      }
    }
    let truncated = false;
    if (paths.length > 50) {
      truncated = true;
      paths = paths.slice(0, 50);
    }
    return { files, paths, truncated };
  }
}

function summarize(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (toolName === "bash" && typeof i.command === "string") {
    return i.command.split("\n")[0].slice(0, 200);
  }
  const p = i.path ?? i.file_path ?? i.filePath;
  if (typeof p === "string") return `${toolName}: ${p}`;
  return String(toolName);
}

export { storeGitDir };
