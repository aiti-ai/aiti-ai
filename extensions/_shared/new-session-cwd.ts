/**
 * 共享：@到新会话 CWD 判定（不随便变更当前 CWD，归一化到 workspace 粒度）
 * 方案：docs/pi-web-at-new-session-cwd-plan.md（v1）+ docs/pi-web-at-new-session-cwd-v2-plan.md（v2）
 *
 * 原则（v2，2026-09-17）：目标定位优先于目录切换，且 CWD 必须落在 workspace 粒度——
 * ① 目标已在当前 CWD 内 → 保持当前；② 目标在当前 CWD 的关注目录（git-trace watchPaths，
 *    repoRoot ?? path）内 → 切到该关注目录（最深命中）；③ 目标在已有 workspace（左侧下拉候选，
 *    /api/sessions 派生 projectRoot ?? cwd）内 → 用最长覆盖项；④ 否则用自己的目录，向上剥离
 *    常规目录名（docs/doc/tmp/temp/design/designs），剥离结果命中 workspace 则用 workspace。
 *    无当前 CWD 时 ②③④ 同样执行（修 v1：无 cwd 直接落文件父目录 → 深子目录 bug）。
 *
 * 纯函数（无 DOM/fs 依赖）：server 端（jiti）与 client 端（vite 打包，经 `../../../_shared/…` 相对导入）
 * 双端 import 同一源——与 `_shared/ext-float-dock.ts` 同款引用方式。
 *
 * 能力收口：session-manager client 注册 `session-manager.mention` 服务（buildAtText + openNewSession）；
 * 消费方优先经服务调用（`openNewSessionWithExtSvc`），服务缺席时降级本文件同源实现（行为不变）。
 */

/** 常规目录名（剥离候选：目标目录是这些名字时不当 CWD，向上找；v2 用户拍板写死，暂不可配置） */
export const DEFAULT_EXCLUDE_DIR_NAMES = ["docs", "doc", "tmp", "temp", "design", "designs"];

/** 路径归一：win 反斜杠 → 斜杠，去尾斜杠。 */
export function normDir(p: string): string {
  return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

/** containment：a 与 b 相等或互为路径前缀（doc-center wsCovers 同款；兼容 win 反斜杠与尾斜杠）。 */
export function pathCovers(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normDir(a);
  const nb = normDir(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

/** 严格单向覆盖：c 是 target 的前缀（或相等）——用于「切到覆盖者」候选，避免把目标的子目录误选。 */
function coversDir(c: string, target: string): boolean {
  if (!c || !target) return false;
  return target === c || target.startsWith(c + "/");
}

/** 向上剥离常规目录名（docs/tmp/design…，大小写不敏感），返回首个非常规目录；无可剥则返回原目录。 */
export function stripCommonDirs(dir: string, excludeNames?: string[]): string {
  const ex = new Set((excludeNames ?? DEFAULT_EXCLUDE_DIR_NAMES).map((s) => String(s).toLowerCase()));
  let d = normDir(dir);
  for (;;) {
    const name = d.split("/").pop() || "";
    if (!name || !ex.has(name.toLowerCase())) break;
    const idx = d.lastIndexOf("/");
    if (idx <= 0) break; // 根级（/docs 或 D:）不再上溯
    d = d.slice(0, idx);
  }
  return d;
}

/** 候选（candidates，绝对路径）中严格覆盖 target 的最长（最深）项；无则 null。 */
export function longestCovering(target: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  for (const raw of candidates) {
    const c = normDir(String(raw || ""));
    if (!c) continue;
    if (coversDir(c, target)) {
      if (!best || c.length > best.length) best = c;
    }
  }
  return best;
}

export interface ResolveNewSessionCwdResult {
  /** 判定后应使用的工作目录（绝对路径）。 */
  cwd: string;
  /** 是否相对当前 CWD 发生了切换（无当前 CWD 时恒 false）。 */
  switched: boolean;
}

/**
 * 判定「@到新会话」应使用的工作目录（v2）。
 * @param targetDir 目标目录（绝对路径；文件传其所在目录、目录传自身——调用方提取）
 * @param targetPath 目标文件/目录全路径（可选；文件场景传文件路径，覆盖判定更精确；缺省回退 targetDir）
 * @param currentCwd 当前会话 cwd（空/无 → 跳过 ①，②③④ 照常执行）
 * @param watchPaths 当前 cwd 的关注路径（git-trace watchPaths；元素可为字符串或 {path, repoRoot}，
 *        命中时取 repoRoot ?? path —— v2 用户拍板仓库根优先）
 * @param knownWorkspaces 已有 workspace 候选（左侧下拉 = /api/sessions 派生 projectRoot ?? cwd 去重；可空）
 * @param excludeNames 常规目录名清单（缺省 DEFAULT_EXCLUDE_DIR_NAMES）
 */
export function resolveNewSessionCwd(opts: {
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  watchPaths?: (string | { path?: string | null; repoRoot?: string | null })[];
  knownWorkspaces?: (string | null | undefined)[];
  excludeNames?: string[];
}): ResolveNewSessionCwdResult {
  const target = normDir(opts.targetPath || opts.targetDir || "");
  const dir = normDir(opts.targetDir || opts.targetPath || "");
  const cur = normDir(opts.currentCwd || "");
  if (!target && !dir) return { cwd: cur, switched: false };

  // ① 目标在当前 CWD 内（双向 containment，doc-center wsCovers 同款）→ 保持
  if (cur && (pathCovers(cur, target) || (dir && dir !== target && pathCovers(cur, dir)))) {
    return { cwd: cur, switched: false };
  }

  // ② 目标在当前 CWD 的关注目录（watchPaths，repoRoot ?? path）内 → 切到该关注目录（最深）
  const watchCands: string[] = [];
  for (const w of Array.isArray(opts.watchPaths) ? opts.watchPaths : []) {
    if (typeof w === "string") { if (w) watchCands.push(w); continue; }
    const o = (w ?? {}) as { path?: string | null; repoRoot?: string | null };
    watchCands.push(normDir(o.repoRoot || o.path || ""));
  }
  const wh = longestCovering(target, watchCands) ?? (dir && dir !== target ? longestCovering(dir, watchCands) : null);
  if (wh) return { cwd: wh, switched: !!cur && wh !== cur };

  // ③ 目标在已有 workspace（左侧下拉候选）内 → 用最长覆盖项
  const wsCands = (Array.isArray(opts.knownWorkspaces) ? opts.knownWorkspaces : []).filter(Boolean) as string[];
  const ws = longestCovering(target, wsCands) ?? (dir && dir !== target ? longestCovering(dir, wsCands) : null);
  if (ws) return { cwd: ws, switched: !!cur && ws !== cur };

  // ④ 自己的目录：向上剥离常规目录名；剥离结果命中 workspace 则用 workspace
  const stripped = stripCommonDirs(dir || target, opts.excludeNames);
  const ws2 = longestCovering(stripped, wsCands);
  const out = ws2 || stripped || dir || target || "";
  return { cwd: out, switched: !!cur && out !== cur };
}

/**
 * @ 引用文本：与宿主 `pi-web/lib/file-fuzzy.ts` `buildAtMentionText` 同格式（空格加引号、目录尾斜杠）。
 * 传入最终要显示的路径（调用方决定相对/绝对口径），本函数只负责 `@` 与引号。
 */
export function buildAtText(path: string, isDir?: boolean): string {
  const p = isDir ? path.replace(/\\/g, "/").replace(/\/+$/, "") + "/" : path;
  return p.includes(" ") ? `@"${p}" ` : `@${p} `;
}

// ── 已知 workspace 列表（宿主 /api/sessions 派生，对齐左侧 workspace 下拉）──────────
// 模块级 TTL 缓存（60s）：一次性 fetch 的 Memory cache，无定时器（禁轮询红线自查）；
// 失败静默降级 []（本地判定兜底），并进入冷却避免短时网络故障反复重拉。
const KNOWN_WS_TTL_MS = 60_000;
const wsCache: { t: number; list: string[] } = { t: 0, list: [] };

export function _resetWsCacheForTest(): void { wsCache.t = 0; wsCache.list = []; }

async function fetchKnownWorkspaces(apiUrl: (path: string) => string, fetchFn: typeof fetch): Promise<string[]> {
  const now = Date.now();
  if (now - wsCache.t < KNOWN_WS_TTL_MS) return wsCache.list;
  try {
    const r = await fetchFn(apiUrl("/api/sessions"), { headers: { accept: "application/json" } });
    const d = await r.json().catch(() => null) as { sessions?: Array<{ projectRoot?: string; cwd?: string }> } | null;
    const set = new Set<string>();
    for (const s of d?.sessions ?? []) {
      const root = normDir((s as any)?.projectRoot ?? (s as any)?.cwd ?? "");
      if (root) set.add(root);
    }
    wsCache.list = [...set];
  } catch {
    wsCache.list = [];
  }
  wsCache.t = now;
  return wsCache.list;
}

/**
 * client 便捷：快路径（目标在当前 CWD 内 → 零请求保持）→ 需要进一步判定时拉已知 workspace
 * （/api/sessions 派生，TTL 缓存）+ POST git-trace 端点（关注路径 + 已知列表复核）→ 失败降级
 * 本地判定（knownWorkspaces 在手、watchPaths 缺席）。
 * 返回最终 cwd 字符串；调用方据此派发 pi-web:new-session。
 * @param apiUrl 扩展各自的 apiUrl（host-shim）——用于拼 git-trace 端点与宿主 /api/sessions
 * @param fetchFn 测试注入用（缺省浏览器 fetch）
 */
export async function resolveNewSessionCwdClient(opts: {
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  apiUrl: (path: string) => string;
  fetchFn?: typeof fetch;
}): Promise<string> {
  const target = normDir(opts.targetPath || opts.targetDir || "");
  const cur = normDir(opts.currentCwd || "");
  // 快路径：当前 CWD 覆盖目标 → 保持（零请求；v2 唯一短路点——无 cwd 时仍需 ②③④ 归一化）
  if (cur && target && pathCovers(cur, target)) return cur;
  // 空目标（消息引用等无路径场景）→ 恒保持当前
  if (!opts.targetDir && !opts.targetPath) return cur;
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const knownWs = await fetchKnownWorkspaces(opts.apiUrl, fetchFn);
  try {
    const r = await fetchFn(opts.apiUrl("/api/extensions/aiti-git-trace/new-session-cwd"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetDir: opts.targetDir, targetPath: opts.targetPath || "", cwd: opts.currentCwd || "",
        knownWorkspaces: knownWs,
      }),
    });
    const d = await r.json().catch(() => ({} as any));
    if (d?.ok && typeof d.cwd === "string" && d.cwd) return d.cwd;
  } catch { /* 端点缺席/失败 → 本地判定兜底（fail-silent） */ }
  return resolveNewSessionCwd({
    targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd, knownWorkspaces: knownWs,
  }).cwd;
}

/**
 * @到新会话完整动作（client 专用）：写 pending composer 预填 → CWD 判定（v2，git-trace 端点复核）
 * → 派发 pi-web:new-session。与宿主 ChatInput 消费端（15s 时效）配套。
 * @param windowRef 测试注入（node 环境无 window；缺省取全局 window）
 */
export async function openNewSession(opts: {
  text: string;
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  apiUrl: (path: string) => string;
  fetchFn?: typeof fetch;
  dispatch?: (evt: Event) => void; // 测试注入（缺省 window.dispatchEvent）
  windowRef?: { __piWebPendingComposer?: unknown } | null;
}): Promise<void> {
  const win = opts.windowRef !== undefined ? opts.windowRef : (typeof window !== "undefined" ? window : null);
  if (win) win.__piWebPendingComposer = { text: opts.text, at: Date.now() };
  const finalCwd = await resolveNewSessionCwdClient({
    targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd, apiUrl: opts.apiUrl, fetchFn: opts.fetchFn,
  });
  const dispatch = opts.dispatch ?? ((evt: Event) => (typeof window !== "undefined" ? window : null)?.dispatchEvent?.(evt));
  dispatch(new CustomEvent("pi-web:new-session", { detail: { cwd: finalCwd } }));
}

/**
 * 消费方统一入口：优先 session-manager 的 `session-manager.mention` 客户端服务（能力收口），
 * 服务缺席（session-manager 禁用/未就绪）→ 降级本文件同源实现（行为不变）。
 * @param extSvc 消费方 host-shim 的 extSvc（`getExtService` 封装；未提供则直接降级）
 */
export async function openNewSessionWithExtSvc(opts: {
  text: string;
  targetDir: string;
  targetPath?: string | null;
  currentCwd?: string | null;
  apiUrl: (path: string) => string;
  extSvc?: <T>(key: string) => T | undefined;
  fetchFn?: typeof fetch;
  dispatch?: (evt: Event) => void;
  windowRef?: { __piWebPendingComposer?: unknown } | null;
}): Promise<void> {
  const svc = opts.extSvc?.("session-manager.mention") as
    | { openNewSession: (t: string, o: { targetDir: string; targetPath?: string | null; currentCwd?: string | null }) => Promise<void> }
    | undefined;
  if (svc?.openNewSession) {
    await svc.openNewSession(opts.text, { targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd });
    return;
  }
  await openNewSession({
    text: opts.text, targetDir: opts.targetDir, targetPath: opts.targetPath, currentCwd: opts.currentCwd, apiUrl: opts.apiUrl,
    fetchFn: opts.fetchFn, dispatch: opts.dispatch, windowRef: opts.windowRef,
  });
}
