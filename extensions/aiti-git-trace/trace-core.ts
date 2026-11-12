/**
 * aiti-git-trace · 核心逻辑（纯 ESM，可被 index.ts 与 node:test 直接导入）
 *
 * 职责（方案 docs/aiti-git-trace-plan.md §3/§5/§6.3/§7.2）：
 *   - hermetic git 封装：显式 --git-dir/--work-tree/GIT_INDEX_FILE 三件套 +
 *     GIT_CONFIG_GLOBAL=/dev/null + 关 hooks/gpgsign —— 物理上不可能碰用户仓
 *   - store 初始化（.aiti-trace，§13.2 顶层）与安全校验
 *   - 回撤流：safety commit → read-tree -u --reset → phase=rollback 记账
 *   - 部分回滚流：diff 过滤 hunk → apply -R --recount（失败 -3 三方兜底）
 *   - 台账（ops ledger）原子追加 / 读取；workspace 关注路径配置（原子写）
 *
 * 红线：绝不写用户仓 .git；所有写路径只允许 trace store（显式三件套）与 configDir。
 *
 * ⚠ 性能红线（2026-09-12 execSync→async 改造）：全部 git 调用走异步（_shared/exec-async），
 * 同仓写序列（safety/record/rollback 的 commit 链）经 queueRepo 按 gitDir 串行——
 * 异步化后并发事件可能交错「读-改-写」。任何人不得在本文件重新引入 execFileSync/spawnSync。
 */
import { execFileAsync, queueRepo } from "@aiti-ai/ext-shared/exec-async";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, renameSync, appendFileSync, openSync, writeSync, closeSync, statSync, unlinkSync } from "node:fs";
import { join as pathJoin, resolve as pathResolve, dirname as pathDirname, sep as pathSep } from "node:path";
import { createHash } from "node:crypto";
import { homedir as osHomedir } from "node:os";

// ---------- 通用 ----------

/**
 * 数据分层（三目录对称 2026-09-13）：入参 configDir = <extRoot>/config；
 * cache/state 一律在 <extRoot> 下（configDir 的上一级），扩展内部统一经本函数推导。
 */
function extRootOf(configDir: string): string {
  return pathDirname(configDir);
}

export function jsonHash(obj) {
  return createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 12);
}

/** workspace key：主仓根（无 git 则 cwd）规范路径哈希前 16 位（§7.2；与 pi-git-trace/src/paths.ts 严格一致） */
export function workspaceKey(workspaceRoot) {
  return createHash("sha256").update(pathResolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function atomicWrite(file, text) {
  mkdirSync(pathDirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8);
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// ---------- hermetic git 封装 ----------

/**
 * 组装 hermetic git 参数前缀。store = { gitDir, workTree, sessionId }。
 * 红线（§3.2）：三件套缺一不可；全局/系统配置一律不进追踪仓；用户 hooks 不生效。
 */
export function gitPrefix(store) {
  const args = ["--git-dir", store.gitDir, "--work-tree", store.workTree,
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
  const env = {
    ...process.env,
    GIT_INDEX_FILE: pathJoin(store.gitDir, "index-" + (store.sessionId || "default")),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { args, env };
}

/** 执行追踪仓 git（cwd=workTree 仓根；异步，不阻塞事件循环）。抛错时带 stderr 首行。 */
export async function runGit(store, args, opts = {}) {
  const { args: prefix, env } = gitPrefix(store);
  try {
    const stdout = await execFileAsync("git", [...prefix, ...args], {
      cwd: store.workTree,
      env,
      // stdin 仅在需要 input 时接管道（update-ref --stdin 等）；否则 ignore——
      // 'ignore' 会把 input 吞掉（曾致批量删 tag 静默无效）
      input: opts.input,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (e) {
    if (opts.allowFail) return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
    const msg = String(e.stderr ?? e.message ?? "").trim().split("\n")[0] || "git error";
    throw new Error("git " + args[0] + " 失败: " + msg);
  }
}

// ---------- Windows 保留设备名防御（add 毒丸） ----------

/** Windows 保留设备名（大小写不敏感）：git 无法 stat/index，混入会让整批 add fatal */
const WIN_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Windows 保留设备名判定（含 <name>.<ext> 形态，nul.txt 同为保留）。
 * 典型来源：bash 里误用 cmd 风格 `> nul` 重定向 → 创建真实文件 nul。
 * 同步实现：pi-git-trace/src/engine.ts isWindowsReservedPath（info/exclude v2 模式段同源）。
 */
export function isWindowsReservedPath(p) {
  const base = p.split(/[\\/]/).pop() ?? "";
  const stem = base.split(".", 1)[0].toUpperCase();
  return WIN_RESERVED_NAMES.has(stem);
}

/**
 * add -A 安全版：批次毒丸降级。
 * `git add -A` 遇 Windows 保留设备名（如 bash 误 `> nul` 建出的真实 nul 文件）
 * 会 `fatal: adding files failed` 整批报废 → 枚举变更文件、过滤保留名后分批重加；
 * 批次仍失败再降逐文件（坏文件单独失败，其余照常入库）。store 的 info/exclude
 * v2 已含保留名模式（pi 扩展 ensureStore 幂等升级同仓共享），此处为末道防线。
 */
export async function addAllSafe(store) {
  const r = await runGit(store, ["add", "-A"], { allowFail: true });
  if (r.code === 0) return;
  const un = await runGit(store, ["ls-files", "--others", "--exclude-standard"], { allowFail: true });
  const md = await runGit(store, ["ls-files", "-m", "-d"], { allowFail: true });
  const paths = [...new Set(
    ((un.code === 0 ? un.stdout : "") + "\n" + (md.code === 0 ? md.stdout : ""))
      .split("\n").map((s) => s.trim()).filter(Boolean),
  )].filter((p) => !isWindowsReservedPath(p));
  for (let i = 0; i < paths.length; i += 500) {
    const batch = paths.slice(i, i + 500);
    const b = await runGit(store, ["add", "--", ...batch], { allowFail: true });
    if (b.code !== 0) {
      for (const p of batch) await runGit(store, ["add", "--", p], { allowFail: true });
    }
  }
}

// ---------- store 定位与初始化（§3.1） ----------

/** cwd 是否处于某个合法 git 仓内：向上走查含 HEAD 的 .git 目录 */
export function repoRootOf(cwd) {
  let dir = pathResolve(cwd);
  for (; ; dir = pathDirname(dir)) {
    const g = pathJoin(dir, ".git");
    if (existsSync(g) && existsSync(pathJoin(g, "HEAD"))) return dir;
    const parent = pathDirname(dir);
    if (parent === dir) return null; // 走到根仍无 → 无 git（不建仓不追踪，§3.1）
  }
}

/** trace store 是否已初始化（<repoRoot>/.aiti-trace/HEAD 存在） */
export function storeOk(repoRoot) {
  return !!repoRoot && existsSync(pathJoin(repoRoot, ".aiti-trace", "HEAD"));
}

export function storeOf(repoRoot, sessionId) {
  return { gitDir: pathJoin(repoRoot, ".aiti-trace"), workTree: repoRoot, sessionId };
}

/** store 初始化：git init + hermetic config 写死（幂等；已初始化则跳过 config 外的自排除补写） */
export async function initStore(repoRoot) {
  if (!repoRoot || !existsSync(pathJoin(repoRoot, ".git", "HEAD"))) {
    throw new Error("initStore：目标不是合法 git 仓（无 .git/HEAD）");
  }
  const store = storeOf(repoRoot, "default");
  if (storeOk(repoRoot)) return store;
  await queueRepo(pathResolve(store.gitDir), async () => {
    mkdirSync(store.gitDir, { recursive: true });
    await runGit(store, ["init", "--quiet"]);
    for (const [k, v] of [
      ["user.name", "aiti-trace"], ["user.email", "aiti@local"],
      ["core.autocrlf", "false"], ["core.fsmonitor", "off"],
      ["gc.auto", "0"], ["status.showuntrackedfiles", "all"], ["core.quotepath", "false"],
    ]) await runGit(store, ["config", k, v]);
  });
  // §13.3①：store 自身 info/exclude 加 .aiti-trace/（实证 git 不自动排除非 .git 名 gitdir；
  // 缺它则任何 add -A 都会把 store 内部文件吸进 index，rollback read-tree 时炸对象缺失）
  try {
    mkdirSync(pathJoin(store.gitDir, "info"), { recursive: true });
    const excl = pathJoin(store.gitDir, "info", "exclude");
    let prev = "";
    try { prev = readFileSync(excl, "utf8"); } catch { /* new */ }
    if (!prev.includes(".aiti-trace/")) writeFileSync(excl, prev + "# aiti store self-exclude\n.aiti-trace/\n");
  } catch { /* 不阻塞 */ }
  // store 自携带免打扰声明（AI grep/搜索自动跳过 store 内部）：.aiti-trace/.gitignore + .ignore = *（幂等，含 `*` 行则跳过）
  try {
    for (const name of [".gitignore", ".ignore"]) {
      const f = pathJoin(store.gitDir, name);
      let c = "";
      try { c = readFileSync(f, "utf8"); } catch { /* new */ }
      if (c.split("\n").map((l) => l.trim()).includes("*")) continue;
      const h = name === ".gitignore" ? "# aiti-trace store self-ignore (managed)\n" : "";
      writeFileSync(f, c + (c && !c.endsWith("\n") ? "\n" : "") + h + "*\n");
    }
  } catch { /* 不阻塞 */ }
  // §13.3②：项目仓 .git/info/exclude 可见性托管块（用户 git status 干净）
  try {
    mkdirSync(pathJoin(repoRoot, ".git", "info"), { recursive: true });
    const pexcl = pathJoin(repoRoot, ".git", "info", "exclude");
    let pprev = "";
    try { pprev = readFileSync(pexcl, "utf8"); } catch { /* new */ }
    if (!pprev.includes(".aiti-trace/")) {
      const re = /# --- aiti store visibility ---[\s\S]*?# --- end aiti store visibility ---\n?/;
      const block = ["# --- aiti store visibility ---", ".aiti-trace/", "# --- end aiti store visibility ---", ""].join("\n");
      writeFileSync(pexcl, re.test(pprev) ? pprev.replace(re, block) : pprev + (pprev && !pprev.endsWith("\n") ? "\n" : "") + block);
    }
  } catch { /* 不阻塞 */ }
  return store;
}

// ---------- 提交原语（§3.4/§5.3） ----------

export async function resolveCommit(store, ref) {
  const r = await runGit(store, ["cat-file", "-e", ref + "^{commit}"], { allowFail: true });
  return r.code === 0;
}

/** 会话分支：refs/heads/aiti/<sid 短 16>（与 pi-git-trace/src/paths.ts sessionBranch 严格一致） */
export function sessionBranch(store) {
  const short = String(store.sessionId || "s").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 16) || "s";
  return "refs/heads/aiti/" + short;
}

/**
 * plumbing 提交到会话分支（红线修正：绝不用 git commit——那会写到 HEAD 指向的
 * master/main，脱离会话分支导致时间线看不见回滚记账）。
 */
/** compact 排它锁探测：写入侧在 commit 前等待其释放（防 compact gc 剪掉 commit-tree 已产、update-ref 未指的对象）。
 *  异步轮询等待——严禁改回 Atomics.wait/while-sleep 同步阻塞（会冻结事件循环）。 */
export async function waitForCompactLock(repoRoot, maxMs = 5000) {
  const lock = pathJoin(repoRoot, ".aiti-trace", "compact.lock");
  const t0 = Date.now();
  while (existsSync(lock)) {
    if (Date.now() - t0 > maxMs) break; // 超时放行（compact 全程持锁，正常早已释放）
    await new Promise((r) => setTimeout(r, 200));
  }
  return Date.now() - t0;
}

/**
 * 提交原语（未串行化内核，仅供下方 queued 公共 API 在 queueRepo 块内调用；
 * 直接调用会失去同仓写序列原子性）。 */
async function commitToSessionBranch(store, message) {
  const branch = sessionBranch(store);
  try { await waitForCompactLock(store.workTree); } catch { /* 等待失败不阻塞写入 */ }
  await addAllSafe(store);
  const tree = (await runGit(store, ["write-tree"])).stdout.trim();
  const parentRes = await runGit(store, ["rev-parse", "--verify", "--quiet", branch], { allowFail: true });
  const parent = parentRes.code === 0 && parentRes.stdout.trim() ? parentRes.stdout.trim() : null;
  const args = ["commit-tree", tree];
  if (parent) args.push("-p", parent);
  args.push("-m", message);
  const sha = (await runGit(store, args)).stdout.trim();
  await runGit(store, ["update-ref", branch, sha]);
  return sha;
}

/** 公共 API：同仓写序列经 queueRepo(gitDir) 串行（异步化后防并发交错）。 */
export function safetyCommit(store, label = "pre-rollback") {
  return queueRepo(pathResolve(store.gitDir), () => safetyCommitUnq(store, label));
}

/** 未串行化内核：safety 记账（仅供 queued 流程内部使用）。 */
function safetyCommitUnq(store, label = "pre-rollback") {
  return commitToSessionBranch(store, `aiti phase=safety ${label} @${new Date().toISOString()}`);
}

export async function lastCommit(store) {
  const branch = sessionBranch(store);
  const r = await runGit(store, ["rev-parse", "--verify", "--quiet", branch], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : ""; // 分支未建立（尚无任何记账）→ 空串
}

export function readTreeReset(store, commit) {
  // 未入队：仅由下方已整体入队的 rollback* 流程调用（嵌套 queueRepo 同 key 会死锁）
  return runGit(store, ["read-tree", "-u", "--reset", commit]);
}

/** 记账 commit（当前 index 状态；落到会话分支，追加式历史；同仓串行） */
export function recordCommit(store, message) {
  return queueRepo(pathResolve(store.gitDir), () => commitToSessionBranch(store, message));
}

// ---------- 回撤流（§5.3） ----------

/**
 * 全量回撤：safety → read-tree -u --reset target → phase=rollback 记账。
 * 返回 {safety, rollback}；store 只写 trace store（三件套隔离）。
 * 整段入队（queueRepo per gitDir）：safety/read-tree/记账三步原子，防并发交错。
 */
export function rollbackFull({ repoRoot, sessionId, targetCommit }) {
  const store = storeOf(repoRoot, sessionId);
  return queueRepo(pathResolve(store.gitDir), () => rollbackFullUnq(store, targetCommit));
}

async function rollbackFullUnq(store, targetCommit) {
  const { repoRoot, sessionId } = { repoRoot: store.workTree, sessionId: store.sessionId };
  if (!storeOk(repoRoot)) throw new Error("该仓没有初始化 trace store（.aiti-trace 不存在）");
  if (!(await resolveCommit(store, targetCommit))) throw new Error("targetCommit 不存在于追踪仓: " + targetCommit);
  const safety = await safetyCommitUnq(store, "pre-rollback");
  await readTreeReset(store, targetCommit);
  const rollback = await commitToSessionBranch(store, `aiti phase=rollback → ${targetCommit} @${new Date().toISOString()}`);
  return { safety, rollback };
}

// ---------- 部分回滚（§6.3） ----------

/** diff base..target（限 files），返回 { text, hunks:[{file, idx, header}] }（只读，不入队） */
export async function diffPatch(store, base, target, files) {
  const args = ["diff", "--no-color", base, target, "--"];
  for (const f of files) args.push(f);
  const text = (await runGit(store, args)).stdout;
  const hunks = [];
  let file = null, idx = 0;
  for (const line of text.split("\n")) {
    const m = line.startsWith("diff --git ") ? line.match(/^diff --git a\/(.+?) b\/(.+)$/) : null;
    if (m) file = m[2];
    if (line.startsWith("@@")) hunks.push({ file, idx: idx++, header: line });
  }
  return { text, hunks };
}

/** 过滤 patch：只保留 hunkIdx 集合命中的 hunk（连同其所在文件头），供 apply -R */
export function filterPatchHunks(patchText, hunkIdxSet) {
  const keep = new Set(hunkIdxSet);
  const out = [];
  let cur = null, curHas = false, inHunk = false, hunkKeep = false, n = 0;
  const flush = () => { if (cur && curHas) out.push(...cur); };
  const lines = patchText.replace(/\n$/, "").split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur = [line]; curHas = false; inHunk = false; hunkKeep = false;
      continue;
    }
    if (cur === null) { out.push(line); continue; } // 罕见：无文件头的前置行原样保留
    if (line.startsWith("@@")) {                     // 新 hunk 开始（先于 !inHunk 兑底判断）
      inHunk = true;
      hunkKeep = keep.has(n);
      n++;
      if (hunkKeep) { cur.push(line); curHas = true; }
      continue;
    }
    if (!inHunk) { cur.push(line); continue; }      // 文件头元数据行（index/---/+++/mode…）
    if (hunkKeep) cur.push(line);                    // hunk 内容行
  }
  flush();
  return out.join("\n") + "\n";
}

/**
 * 部分回滚：safety → 过滤逆 patch → apply -R --recount（失败 -3 兜底）→ 记账。
 * hunkIdx 为「files 过滤后 patch 内的全局 hunk 序号」（0 起，按 diff 输出顺序）。
 */
export function rollbackPartial({ repoRoot, sessionId, base, target, files, hunkIdx }) {
  const store = storeOf(repoRoot, sessionId);
  return queueRepo(pathResolve(store.gitDir), () => rollbackPartialUnq(store, { base, target, files, hunkIdx }));
}

async function rollbackPartialUnq(store, { base, target, files, hunkIdx }) {
  const { repoRoot, sessionId } = { repoRoot: store.workTree, sessionId: store.sessionId };
  if (!storeOk(repoRoot)) throw new Error("该仓没有初始化 trace store（.aiti-trace 不存在）");
  for (const ref of [base, target]) if (!(await resolveCommit(store, ref))) throw new Error("commit 不存在于追踪仓: " + ref);
  const { text } = await diffPatch(store, base, target, files);
  // [P0-1 契约] 空 hunkIdx = 该文件全部 hunk（不做过滤）——逐 op 回滚前端只圈文件级，
  // hunk 级细选留给未来的部分回滚 UI；契约见 docs/aiti-lineage-closure-plan.md P0-1。
  const patch = hunkIdx.length ? filterPatchHunks(text, new Set(hunkIdx)) : text;
  if (!patch.trim()) throw new Error("过滤后 patch 为空（hunkIdx 与 diff 不匹配）");
  const safety = await safetyCommitUnq(store, "pre-partial-rollback");
  const patchFile = pathJoin(store.gitDir, "partial-rollback.patch");
  writeFileSync(patchFile, patch);
  let r = await runGit(store, ["apply", "-R", "--whitespace=nowarn", patchFile], { allowFail: true });
  let usedThreeway = false;
  if (r.code !== 0) { // worktree 已漂移 → 三方兜底（store 内有全部 blob）
    r = await runGit(store, ["apply", "-R", "--3way", "--whitespace=nowarn", patchFile], { allowFail: true });
    usedThreeway = true;
  }
  try { rmSync(patchFile, { force: true }); } catch {}
  if (r.code !== 0) {
    throw new Error("部分回滚 apply 失败" + (usedThreeway ? "（-3 亦失败）" : "") + ": " + (r.stderr || "").trim().split("\n")[0]);
  }
  await addAllSafe(store);
  const rollback = await commitToSessionBranch(store, `aiti phase=rollback partial files=[${files.join(",")}] hunks=[${hunkIdx.join(",")}] base=${base} target=${target} @${new Date().toISOString()}`);
  return { safety, rollback, usedThreeway };
}

// ---------- 台账（§3.6，state/ops/<sid>.jsonl；不可再生 → state 层） ----------

/** 台账目录（state 层：不可再生数据，不随 cache 清理）。写==读同源：统一经 opsDirFor/opsFile。 */
export function opsDirFor(configDir) {
  return pathJoin(extRootOf(configDir), "state", "ops");
}

export function opsFile(configDir, sessionId) {
  return pathJoin(opsDirFor(configDir), sanitizeSession(sessionId) + ".jsonl");
}

export function sanitizeSession(sid) {
  return String(sid || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "default";
}

export function readOps(configDir, sessionId) {
  return readOpsWithMeta(configDir, sessionId).rows.slice(); // 浅拷贝：防调用方就地改写污染解析缓存
}

/** /ops 解析缓存（mtime+size 键，LRU 上限）：live 轮次 SSE 批次重取免去整读整 parse
 *  （方案 §11.3 性能审计——1.1MB 台账每批省 ~12ms 同步阻塞；台账 append 均保前缀，
 *  size/mtime 变化即失效，清理/截断缩小亦然，无需手动失效）。 */
const OPS_PARSE_CACHE_MAX = 8;
const opsParseCache = new Map<string, { mtimeMs: number; size: number; rows: any[] }>();

/** 读台账并附带 ETag 元数据（`W/"size-mtimeMs"`；api /ops 据此做 If-None-Match 304 再校验）。 */
export function readOpsWithMeta(configDir, sessionId): { rows: any[]; etag: string | null } {
  const f = opsFile(configDir, sessionId);
  let st;
  try { st = statSync(f); } catch { return { rows: [], etag: null }; }
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  const hit = opsParseCache.get(f);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    opsParseCache.delete(f);
    opsParseCache.set(f, hit); // LRU touch
    return { rows: hit.rows, etag };
  }
  const rows: any[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { /* 跳过坏行（台账容错） */ }
  }
  opsParseCache.delete(f);
  opsParseCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, rows });
  while (opsParseCache.size > OPS_PARSE_CACHE_MAX) {
    opsParseCache.delete(opsParseCache.keys().next().value);
  }
  return { rows, etag };
}

// web 侧追加通知（api.ts 的 plan-record/回撤记账走 appendOps 直写文件，不经 pi 引擎的
// __aitiTraceEmit 广播——index.ts 装此钩子把同形事件转 traceBus/SSE，否则浏览器实时化
// 对 web 侧写入不生效（2026-09-09 SSE 推送实测发现））
let appendListener: ((sessionId: string, entry: any) => void) | null = null;
export function setAppendListener(fn: ((sessionId: string, entry: any) => void) | null): void {
  appendListener = fn;
}

export function appendOps(configDir, sessionId, entry) {
  const f = opsFile(configDir, sessionId);
  mkdirSync(pathDirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(entry) + "\n", "utf8");
  try { appendListener?.(sessionId, entry); } catch { /* 通知失败不影响记账 */ }
}

/**
 * 会话台账里出现过的全部仓根（stores[].root 去重，按首次出现序）。
 * 用途：跨仓文件分辨（aiti-msg-smart 协作）与 watch 弹窗「本会话识别的仓」补全——
 * state/<sid>.json 只是运行时快照，引擎重启会丢之前的副仓；台账才是持久记录。
 */
export function sessionRepoRoots(configDir, sessionId) {
  const roots = [];
  for (const op of readOps(configDir, sessionId)) {
    for (const st of Array.isArray(op.stores) ? op.stores : []) {
      const r = typeof st?.root === "string" ? st.root : "";
      if (r && !roots.includes(r)) roots.push(r);
    }
  }
  return roots;
}

/** fork 预览：返回 fork 点之后的 ops。fork 点=用户消息 entry → 优先匹配 userEntryId
 *  （ledger entryId 是 assistant/toolCall entry，永不等于 fork 点）；两者都找不到时保守返回全部。 */
export function forkPreviewOps(configDir, sessionId, entryId) {
  const ops = readOps(configDir, sessionId);
  if (!entryId) return ops;
  let last = -1;
  ops.forEach((o, i) => {
    if (o.userEntryId === entryId || o.entryId === entryId) last = i;
  });
  return last >= 0 ? ops.slice(last + 1) : ops;
}

// ---------- workspace 关注路径配置（§7.2，configDir/workspaces/<key>.json） ----------

export const DEFAULT_WORKSPACE = { enabled: true, autoDiscover: true, paths: [] };

export function workspaceFile(configDir, key) {
  const safe = String(key || "").replace(/[^A-Za-z0-9_-]/g, "");
  return pathJoin(extRootOf(configDir), "cache", "workspaces", safe + ".json");
}

export function loadWorkspace(configDir, key) {
  const f = workspaceFile(configDir, key);
  if (!existsSync(f)) return { ...DEFAULT_WORKSPACE, paths: [] };
  try {
    const cfg = JSON.parse(readFileSync(f, "utf8"));
    return {
      enabled: cfg.enabled !== false,
      autoDiscover: cfg.autoDiscover !== false,
      paths: Array.isArray(cfg.paths) ? cfg.paths : [],
    };
  } catch { return { ...DEFAULT_WORKSPACE, paths: [] }; }
}

export function saveWorkspace(configDir, key, cfg) {
  const clean = {
    enabled: cfg?.enabled !== false,
    autoDiscover: cfg?.autoDiscover !== false,
    paths: (Array.isArray(cfg?.paths) ? cfg.paths : []).map((p) => ({
      path: String(p.path || ""),
      origin: p.origin === "user" ? "user" : "user",
      repoRoot: p.repoRoot ? String(p.repoRoot) : null,
      addedAt: Number(p.addedAt) || Date.now(),
    })).filter((p) => p.path),
  };
  atomicWrite(workspaceFile(configDir, key), JSON.stringify(clean, null, 2));
  return clean;
}

export function deleteWorkspace(configDir, key) {
  const f = workspaceFile(configDir, key);
  if (existsSync(f)) rmSync(f, { force: true });
  return true;
}

/** 归属解析：路径向上走查最近 .git（§3.7）；目录无归属时向下扫一层找嵌套仓 */
export function resolveWatchPath(p) {
  const abs = pathResolve(p);
  const up = repoRootOf(abs);
  if (up) return { path: abs, repoRoot: up, nested: [] };
  const nested = [];
  try {
    for (const name of readdirSync(abs)) {
      const child = pathJoin(abs, name);
      try {
        if (existsSync(pathJoin(child, ".git", "HEAD"))) nested.push(child);
      } catch {}
    }
  } catch {}
  return { path: abs, repoRoot: null, nested };
}

// ---------- 内置排除清单（§3.5 v1；供 store init 写 aiti/excludes） ----------

export const BUILTIN_EXCLUDES_V1 = `# aiti-excludes v1 —— 构建产物 / 依赖 / 缓存 / 临时物；锁文件与 .env 不在列
# —— Node / 前端
node_modules/
.next/ .nuxt/ .output/ .svelte-kit/ .astro/ .vite/ .vitest/ .parcel-cache/ .turbo/ .vercel/
dist/ build/ out/ coverage/ .nyc_output/ .cache/
.eslintcache *.tsbuildinfo
.yarn/cache .yarn/install-state.gz .pnpm-store/
# —— Python
__pycache__/ *.py[cod] .ipynb_checkpoints/
.venv/ venv/ .tox/ .nox/ .hypothesis/
.pytest_cache/ .mypy_cache/ .ruff_cache/ *.egg-info/
# —— JVM / .NET
target/ build/ .gradle/ *.class
bin/ obj/ .vs/
# —— Ruby
.bundle/ vendor/bundle/
# —— 日志 / 临时 / 崩溃物
*.log logs/ tmp/ .tmp/ *.swp *.swo core core.*
# —— OS / IDE
.DS_Store Thumbs.db desktop.ini
.idea/ .vscode/
`;

/** 写内置排除托管文件（幂等；版本戳变更时重写） */
export function ensureExcludesFile(configDir) {
  const dir = pathJoin(extRootOf(configDir), "cache", "excludes");
  mkdirSync(dir, { recursive: true });
  const f = pathJoin(dir, "aiti-excludes-v1.txt");
  if (!existsSync(f)) writeFileSync(f, BUILTIN_EXCLUDES_V1);
  return f;
}

export { pathJoin, pathResolve, existsSync, copyFileSync };


/* ---------------- loose 模式判定（§13.4；镜像 pi-git-trace/src/loose.ts） ---------------- */

const DENY_EXACT = new Set(["/", "/tmp", "/proc", "/sys", "/dev", "/run", "/etc", "/var", "/boot", "/usr", "/lib", "/opt", "/snap"]);
const DENY_PREFIX = ["/tmp/", "/proc/", "/sys/", "/dev/", "/run/", "/etc/", "/var/", "/boot/", "/usr/", "/lib/", "/opt/", "/snap/"];

export function looseDenied(dir) {
  try {
    const p = pathResolve(dir);
    if (p === osHomedir()) return true;
    if (DENY_EXACT.has(p)) return true;
    return DENY_PREFIX.some((pre) => p.startsWith(pre));
  } catch { return true; }
}

export function countFilesWithBudget(dir, budget) {
  let count = 0;
  const visit = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      if (e.name === ".aiti-trace") continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!visit(pathJoin(d, e.name))) return false; }
      else { count += 1; if (count > budget) return false; }
    }
    return true;
  };
  visit(dir);
  return count;
}

/** loose 决策（与引擎同链）：返回 { allowed, reason } */
export function looseDecision(cwd, opts = {}) {
  if (opts.autoInit === false) return { allowed: false, reason: "no-git-disabled" };
  if (looseDenied(cwd)) return { allowed: false, reason: "no-git-denylist" };
  const budget = Number(opts.maxFiles) || 2000;
  if (countFilesWithBudget(cwd, budget) > budget) return { allowed: false, reason: "no-git-oversize" };
  return { allowed: true, reason: "" };
}


/* ---------------- 清理（§15）：会话台账 / 工作区深清理 ---------------- */

/** 会话台账清理：beforeOp 缺省 = 删除整文件；否则保留 op >= beforeOp 的行。返回删除行数。 */
export function cleanupSessionOps(configDir, sessionId, beforeOp) {
  const f = opsFile(configDir, sessionId);
  if (!existsSync(f)) return { removed: 0, deleted: true };
  if (!beforeOp) { rmSync(f); return { removed: -1, deleted: true }; }
  const rows = readOps(configDir, sessionId);
  const keep = rows.filter((r) => r.op >= beforeOp);
  const removed = rows.length - keep.length;
  if (keep.length === 0) { rmSync(f); return { removed, deleted: true }; }
  writeFileSync(f, keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { removed, deleted: false };
}

/** 工作区深清理：删除 cwd 位于 root 之下（含 root 本身）的全部会话台账 + 本工作区追踪仓。
 *  追踪仓仅在确认是我们创建的（HEAD 存在）时删除。运行中会话由引擎自愈重建空仓。 */
export function cleanupWorkspace(configDir, root) {
  if (!root) return { sessions: 0, storeRemoved: false };
  const r = String(root);
  const prefix = r.endsWith(pathSep) ? r : r + pathSep;
  const dir = opsDirFor(configDir);
  let sessions = 0;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = pathJoin(dir, f);
      try {
        const first = readFileSync(fp, "utf8").split("\n").find((l) => l.trim());
        if (!first) { rmSync(fp); sessions++; continue; }
        const cwd = String(JSON.parse(first).cwd || "");
        if (cwd === r || cwd.startsWith(prefix)) { rmSync(fp); sessions++; }
      } catch { /* 坏行文件：保守跳过 */ }
    }
  } catch { /* 目录缺失 */ }
  let storeRemoved = false;
  const store = pathJoin(r, ".aiti-trace");
  if (existsSync(pathJoin(store, "HEAD"))) {
    rmSync(store, { recursive: true, force: true });
    storeRemoved = true;
  }
  return { sessions, storeRemoved };
}


/** 家谱（§3.3）：沿台账 parent 链聚合——祖先链（根优先）+ 当前会话 + 全部后代（BFS 序） */
export function lineage(configDir, sessionId) {
  const nodes = new Map();
  const dir = opsDirFor(configDir);
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const sid = f.replace(/\.jsonl$/, "");
      let parent = null; let opCount = 0; let t0 = Infinity; let t1 = 0;
      try {
        for (const line of readFileSync(pathJoin(dir, f), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            opCount++;
            if (r.t0) t0 = Math.min(t0, r.t0);
            if (r.t1) t1 = Math.max(t1, r.t1);
            if (!parent && r.parent) parent = String(r.parent);
          } catch { /* 坏行跳过 */ }
        }
      } catch { continue; }
      if (opCount > 0) nodes.set(sid, { parent, opCount, t0: t0 === Infinity ? 0 : t0, t1 });
    }
  } catch { /* 目录缺失 */ }
  const seen = new Set([sessionId]);
  const up = []; let cur = sessionId;
  while (true) {
    const n = nodes.get(cur);
    const p = n && n.parent;
    if (!p || seen.has(p)) break;
    seen.add(p); up.unshift(p); cur = p;
    if (!nodes.has(p)) break; // 父会话台账缺失：止步
  }
  const down = [];
  const frontier = [sessionId];
  while (frontier.length) {
    const x = frontier.shift();
    for (const [sid, n] of nodes) {
      if (n.parent === x && !seen.has(sid)) { seen.add(sid); down.push(sid); frontier.push(sid); }
    }
  }
  const genOf = new Map();
  up.forEach((sid, i) => genOf.set(sid, i));
  genOf.set(sessionId, up.length);
  for (const sid of down) {
    const n = nodes.get(sid);
    genOf.set(sid, n && n.parent && genOf.has(n.parent) ? genOf.get(n.parent) + 1 : up.length + 1);
  }
  const node = (sid) => { const n = nodes.get(sid) || {}; return { id: sid, parent: n.parent || null, gen: genOf.get(sid) ?? 0, opCount: n.opCount || 0, t0: n.t0 || 0, t1: n.t1 || 0 }; };
  return { ancestors: up.map(node), self: node(sessionId), descendants: down.map(node) };
}

// ---------- 「从这里编辑」区间 + 逐 op 逆序反向回撤（docs/aiti-git-trace-edit-here-reverse-rollback-plan.md） ----------

/**
 * 按被裁轮次集合精确圈定 ops（方案 §4.1）：`userEntryId ∈ ids`，旧台账无 userEntryId 时
 * 兜底 `entryId ∈ ids`；`ids` 为空/无不匹配 → 返回 []（调用方直通不弹窗，安全默认——
 * 漏提示可后续手工处理，误撤销才是灾难）。
 * 区别于 forkPreviewOps（单 entryId + slice(last+1) 漏掉被编辑轮）。
 */
export function forkPreviewOpsByUserEntries(configDir, sessionId, ids) {
  const set = new Set((ids || []).filter(Boolean));
  if (set.size === 0) return [];
  return readOps(configDir, sessionId).filter((o) => set.has(o.userEntryId) || set.has(o.entryId));
}

/**
 * 逐 op 逆序反向回撤（方案 §3.2/§4.2）：对台账 before→after 快照对，从后往前逐个
 * `git diff before after` → `git apply -R`（失败 -3 三方兜底；仍失败则停止并返回 partial）。
 * 只移除被撤 op 引入的变更，保留其他来源（用户手改/并行改动）。
 *
 * gap（before=null，首触无基线）op 无法逆撤 → 计入 skipped 跳过。
 * 回撤动作本身作为可逆记录：`before = safety commit`（回撤前现状）、`after = 记账 commit`（回撤后现状），
 * 双双落会话分支（方案 §7：回撤自身也进 trace、可再回滚）。
 *
 * @param refs 升序 [{op, before, after}]（before=null 表示 gap，跳过）
 * @returns { safety, rollback, applied, skipped, usedThreeway, failed: {op,before,after,stderr}|null }
 */
export function rollbackOpsReversed({ repoRoot, sessionId, refs }) {
  const store = storeOf(repoRoot, sessionId);
  return queueRepo(pathResolve(store.gitDir), () => rollbackOpsReversedUnq(store, refs));
}

async function rollbackOpsReversedUnq(store, refs) {
  const { repoRoot, sessionId } = { repoRoot: store.workTree, sessionId: store.sessionId };
  if (!storeOk(repoRoot)) throw new Error("该仓没有初始化 trace store（.aiti-trace 不存在）");
  const list = (refs || []).filter((r) => r && typeof r === "object");
  // 只校验有 before/after 的 ref（gap 无 before，不校验）
  for (const r of list) {
    if (r.before && r.after) {
      for (const ref of [r.before, r.after]) {
        if (!(await resolveCommit(store, ref))) throw new Error("commit 不存在于追踪仓: " + ref);
      }
    }
  }
  const safety = await safetyCommitUnq(store, "pre-reverse-rollback");
  let applied = 0; let usedThreeway = false; let failed = null;
  const skipped = [];
  // 逆序：后发生的先撤，patch 上下文 = 前一 op 的 after 快照，冲突面最小
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i];
    if (!r.before || !r.after) { skipOperation(skipped, r); continue; }
    const { text } = await diffPatch(store, r.before, r.after, []); // files=[] → 全仓 diff
    if (!text.trim()) continue; // 无差异（理论上不应发生）
    const patchFile = pathJoin(store.gitDir, "reverse-rollback.patch");
    writeFileSync(patchFile, text);
    let ok = await runGit(store, ["apply", "-R", "--whitespace=nowarn", patchFile], { allowFail: true });
    let tw = false;
    if (ok.code !== 0) { // worktree 已漂移 → 三方兜底（store 有全部 blob）
      ok = await runGit(store, ["apply", "-R", "--3way", "--whitespace=nowarn", patchFile], { allowFail: true });
      tw = true;
    }
    try { rmSync(patchFile, { force: true }); } catch {}
    if (ok.code !== 0) {
      failed = { op: r.op, before: r.before, after: r.after, stderr: String(ok.stderr || "").trim().split("\n")[0] };
      break;
    }
    applied += 1;
    if (tw) usedThreeway = true;
  }
  await addAllSafe(store);
  const doneOps = list.map((r) => r.op).join(",");
  const rollback = await commitToSessionBranch(store, `aiti phase=rollback scope=reverse-ops ops=[${doneOps}] applied=${applied}${failed ? " failed@" + failed.op : ""} ${skipped.length ? "skipped=" + skipped.join(",") : ""} @${new Date().toISOString()}`);
  return { safety, rollback, applied, skipped, usedThreeway, failed };
}

/** 增补：gap op 记录进 skipped（含 op 号与原因），不阻塞后续 ref */
function skipOperation(skipped, r) {
  skipped.push({ op: r.op, reason: "gap" });
}


// ---------- 变更总览（docs/aiti-git-trace-overview-view-plan.md §3；只读聚合，零写路径） ----------

/** 台账行圈定（R3）：plan-accept/plan-discard 无 stores 不参与统计；rollback 单独归一 */
const SUMMARY_OP_EXCLUDED_KINDS = new Set(["rollback", "plan-accept", "plan-discard"]);

/** 变更总览文件列表返回上限（§8 渲染保护；超出置 filesTruncated，totals.files 仍为全量计数） */
const SUMMARY_FILES_CAP = 2000;
/** 触达史每文件上限（§3.1） */
const SUMMARY_TOUCH_CAP = 50;

/**
 * 回撤行三 shape 归一（R2，§3.1）：
 *   - rollback-reversed：LedgerRow 同构（stores[].before/after，时间键 t1）
 *   - rollback-partial / rollback full：扁平（storeRoot/base/target/safety/commit，只有 t）
 * 归一为 { t, stores:[{root, before, after, paths}] }；latest commit 取 stores[].after ∨ commit。
 * flat 的 before=safety 是会话中点——只参与 target，不参与 base（调用方约定）。
 */
function normalizeRollbackRow(row) {
  if (!row || row.kind !== "rollback") return null;
  const t = Number(row.t1 ?? row.t ?? 0) || 0;
  let stores;
  if (Array.isArray(row.stores)) {
    stores = row.stores
      .map((st) => ({ root: st?.root, before: st?.before || null, after: st?.after || null, paths: Array.isArray(st?.paths) ? st.paths : [] }))
      .filter((st) => st.root);
  } else if (typeof row.storeRoot === "string" && row.storeRoot) {
    stores = [{ root: row.storeRoot, before: row.safety || null, after: row.commit || null, paths: Array.isArray(row.files) ? row.files : [] }];
  } else stores = [];
  return { t, stores };
}

/** `git diff --name-status -z` 解析：普通 `X\0path\0`；rename/copy `X<score>\0old\0new\0`（三段）。
 *  位置解析：记录首段必为状态 token（rename 双形态 N1：未检测到的改名以 D+A 两行出现，无需合并）。 */
function parseNameStatusZ(stdout) {
  const parts = String(stdout || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length;) {
    const st = parts[i];
    if (!st) { i++; continue; }
    if (/^[RC]/.test(st)) {
      const from = parts[i + 1] || null, to = parts[i + 2] || null;
      i += 3;
      if (to) out.push({ status: st[0], from, path: to });
    } else {
      const to = parts[i + 1] || null;
      i += 2;
      if (to) out.push({ status: st[0], from: null, path: to });
    }
  }
  return out;
}

/** `git diff --numstat -z` 解析（口径镜像 git-review changeSet）：普通 `a\td\tpath\0`；
 *  rename `a\td\t\0old\0new\0`（第三段空串判定，防 binary `-\t-` 误判）；binary = `-\t-`。 */
function parseNumstatZ(stdout) {
  const parts = String(stdout || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length;) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i] || "");
    if (!m) { i++; continue; }
    const binary = m[1] === "-" || m[2] === "-";
    const adds = m[1] === "-" ? 0 : parseInt(m[1], 10) || 0;
    const dels = m[2] === "-" ? 0 : parseInt(m[2], 10) || 0;
    if (m[3] === "") {
      const from = parts[i + 1] || null, to = parts[i + 2] || null;
      i += 3;
      if (to) out.push({ path: to, from, adds, dels, binary });
    } else {
      i += 1;
      out.push({ path: m[3], from: null, adds, dels, binary });
    }
  }
  return out;
}

/**
 * 会话（或指定轮次集合）文件变更总览（§3.1，只读）。
 *
 * 口径：
 *   - 行圈定（R2/R3）：op 行 = 有 stores[] 且 kind ∉ {rollback, plan-accept, plan-discard}；
 *     回撤行（kind=rollback）三 shape 归一后参与 target 与 rollbacks 计数，不参与 base。
 *   - 区间（每 store）：base = op 行最早（t0）非空 before，全空（首触）→ 最早 after；
 *     target = 所有行最新（t1 ?? t）非空 after/commit。entryIds 给定时仅用命中轮 op 行（轮次 = 净增量）。
 *   - 交集口径（R1）：文件集合 = 区间 diff ∩ 台账窗口增量路径并集（before→after 窗口 op 实测 paths）。
 *     status 以 name-status 为权威；numstat 只供行数；+A/−B = 区间净变更（非逐 op 累加）。
 *   - storeMissing（storeOk 假）/ rejected（allowRoot 拒，Y5）标注部分返回，非静默丢。
 *
 * @param entryIds 用户消息 entry 集合（轮次过滤；空/null = 全部）
 * @param opts.allowRoot (root) => Promise<boolean>，缺省放行
 * @param opts.opSet op 号 Set（GET fork-preview 圈定范围用；与 entryIds 二选一场景）
 */
export async function sessionFileSummary(configDir, sessionId, entryIds, opts = {}) {
  const rows = readOps(configDir, sessionId);
  const idSet = Array.isArray(entryIds) && entryIds.length ? new Set(entryIds.map(String)) : null;
  const opSet = opts.opSet instanceof Set ? opts.opSet : null;
  const matchEntry = (row) => !idSet
    || (row.userEntryId != null && idSet.has(String(row.userEntryId)))
    || (row.entryId != null && idSet.has(String(row.entryId)));
  const matchOp = (row) => !opSet || (typeof row.op === "number" && opSet.has(row.op));
  const rowT = (row) => Number(row?.t1 ?? row?.t ?? row?.t0 ?? 0) || 0;
  const rowT0 = (row) => Number(row?.t0 ?? row?.t1 ?? row?.t ?? 0) || 0;

  const opRows = [];
  const rbRows = []; // { row: 原台账行, n: 归一结果 }
  for (const row of rows) {
    if (row?.kind === "rollback") {
      if (idSet) continue; // 轮次过滤口径 = 该轮净增量：回撤行不掺入
      const n = normalizeRollbackRow(row);
      if (n && matchOp(row)) rbRows.push({ row, n });
      continue;
    }
    if (SUMMARY_OP_EXCLUDED_KINDS.has(row?.kind)) continue;
    if (!Array.isArray(row?.stores) || row.stores.length === 0) continue;
    if (!matchEntry(row) || !matchOp(row)) continue;
    opRows.push(row);
  }

  // 每 store 聚合桶（按首现序）
  const storesOrder = [];
  const buckets = new Map(); // root → { bases, baseAfters, targets, window:Set, touches:Map<path,[]> }
  const bucketOf = (root) => {
    let b = buckets.get(root);
    if (!b) {
      b = { bases: [], baseAfters: [], targets: [], window: new Set(), touches: new Map() };
      buckets.set(root, b);
      storesOrder.push(root);
    }
    return b;
  };
  const pushTouch = (b, path, touch) => {
    let list = b.touches.get(path);
    if (!list) { list = []; b.touches.set(path, list); }
    list.push(touch);
  };

  for (const row of opRows) {
    const t0 = rowT0(row), t1 = rowT(row);
    const kind = row.kind || "op";
    for (const st of row.stores) {
      if (!st?.root) continue;
      const b = bucketOf(st.root);
      const paths = Array.isArray(st.paths) ? st.paths : [];
      if (st.before) {
        b.bases.push({ t: t0, c: st.before });
        if (st.after) b.targets.push({ t: t1, c: st.after });
        for (const p of paths) {
          b.window.add(p);
          // 触达行附 before/after/partial/truncated（§2 触达行 看diff/回滚 按钮需要该 op 快照对）
          pushTouch(b, p, { op: row.op, msgSeq: row.msgSeq, tool: row.tool, summary: row.summary, t1: t1 || t0, kind,
            before: st.before || null, after: st.after || null, partial: !!st.partial, truncated: !!st.pathsTruncated });
        }
      } else if (st.after) {
        // 首触基线（before=null）不产生文件行；after 仍可作 base 兜底与 target
        b.baseAfters.push({ t: t0, c: st.after });
        b.targets.push({ t: t1, c: st.after });
      }
    }
  }
  for (const { row, n } of rbRows) {
    for (const st of n.stores) {
      const b = bucketOf(st.root);
      if (st.after) b.targets.push({ t: n.t, c: st.after }); // 回撤后 worktree 实际状态
      if (st.before && st.after) {
        for (const p of st.paths) {
          pushTouch(b, p, { op: row.op ?? null, msgSeq: null, tool: "rollback", summary: "↩", t1: n.t, kind: "rollback",
            before: st.before, after: st.after, partial: false, truncated: false });
        }
      }
    }
  }

  const storesOut = [];
  const filesMap = new Map(); // root\0path → file row
  const totals = { ops: 0, files: 0, adds: 0, dels: 0, rollbacks: rbRows.length, leaks: 0, binary: 0 };
  const opHasDelta = (row) => (row.leaks || []).length > 0
    || (row.stores || []).some((st) => st.before && st.files
      && (st.files.M || 0) + (st.files.A || 0) + (st.files.D || 0) > 0);
  totals.ops = opRows.filter(opHasDelta).length;
  const leakPaths = new Set();
  for (const row of opRows) for (const l of row.leaks || []) if (l?.path) leakPaths.add(l.path);
  totals.leaks = leakPaths.size;

  const allowRoot = typeof opts.allowRoot === "function" ? opts.allowRoot : null;
  for (const root of storesOrder) {
    const b = buckets.get(root);
    const entry = {
      root,
      // base = op 行最早（t0）非空 before；全空（首触）→ 最早 after（回撤行不参与 base）
      base: (b.bases.slice().sort((x, y) => x.t - y.t)[0]?.c ?? null)
        ?? (b.baseAfters.slice().sort((x, y) => x.t - y.t)[0]?.c ?? null),
      // target = 所有行（含归一回撤行）最新（t1 ?? t）非空 after/commit
      target: (b.targets.slice().sort((x, y) => x.t - y.t).filter((x) => x.c).pop()?.c ?? null),
    };
    storesOut.push(entry);
    if (!entry.base || !entry.target || entry.base === entry.target) continue;
    if (!storeOk(root)) { entry.storeMissing = true; continue; }
    if (allowRoot) {
      let ok = false;
      try { ok = await allowRoot(root); } catch { ok = false; }
      if (!ok) { entry.rejected = true; continue; }
    }
    let store;
    try {
      store = storeOf(root, sessionId);
      if (!(await resolveCommit(store, entry.base)) || !(await resolveCommit(store, entry.target))) continue;
    } catch { continue; }
    let ns = "", num = "";
    try {
      ns = (await runGit(store, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--name-status", "-z", entry.base, entry.target])).stdout;
      num = (await runGit(store, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--numstat", "-z", entry.base, entry.target])).stdout;
    } catch { continue; }
    const numByPath = new Map();
    const numByPair = new Map();
    for (const n of parseNumstatZ(num)) {
      if (n.from) numByPair.set(n.from + "\0" + n.path, n);
      else numByPath.set(n.path, n);
    }
    for (const r of parseNameStatusZ(ns)) {
      // 交集口径（R1）：区间 diff ∩ 台账窗口增量路径（rename 新旧路径任一命中即可）
      if (!b.window.has(r.path) && !(r.from && b.window.has(r.from))) continue;
      const n = r.from ? numByPair.get(r.from + "\0" + r.path) : numByPath.get(r.path);
      const touchList = [...(b.touches.get(r.path) || []), ...(r.from ? b.touches.get(r.from) || [] : [])]
        .sort((x, y) => (x.t1 || 0) - (y.t1 || 0))
        .slice(0, SUMMARY_TOUCH_CAP);
      filesMap.set(root + "\u0000" + r.path, {
        root, path: r.path, status: r.status,
        adds: n ? n.adds : 0, dels: n ? n.dels : 0, binary: n ? !!n.binary : false,
        renamedFrom: r.from || null,
        touches: touchList,
        lastT: touchList.length ? Math.max(...touchList.map((x) => x.t1 || 0)) : 0,
      });
    }
  }

  const files = [...filesMap.values()]
    .sort((a, b2) => (b2.lastT || 0) - (a.lastT || 0) || (a.path < b2.path ? -1 : 1))
    .slice(0, SUMMARY_FILES_CAP);
  totals.files = filesMap.size;
  for (const f of filesMap.values()) {
    totals.adds += f.adds;
    totals.dels += f.dels;
    if (f.binary) totals.binary += 1;
  }
  return { stores: storesOut, totals, files, filesTruncated: filesMap.size > files.length };
}

const FILE_DIFF_MAX_LINES = 2000;
const FILE_DIFF_MAX_BYTES = 256 * 1024;

/**
 * 单文件（或全树）区间 diff 文本（§3.2，hermetic 只读 + 截断保护 ≤2000 行 / 256KB）。
 * base/target 必须能 resolveCommit（防任意 ref 读——纵深防御）。
 */
export async function fileDiffText(repoRoot, sessionId, base, target, path, maxLines = FILE_DIFF_MAX_LINES) {
  if (!storeOk(repoRoot)) throw new Error("该仓没有初始化 trace store（.aiti-trace 不存在）");
  const store = storeOf(repoRoot, sessionId);
  for (const ref of [base, target]) if (!(await resolveCommit(store, ref))) throw new Error("commit 不存在于追踪仓: " + ref);
  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", base, target];
  if (path) args.push("--", path);
  const full = (await runGit(store, args)).stdout;
  const lines = full.split("\n");
  let text = full;
  let truncated = false;
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (Buffer.byteLength(text, "utf8") > FILE_DIFF_MAX_BYTES) {
    text = Buffer.from(text, "utf8").subarray(0, FILE_DIFF_MAX_BYTES).toString("utf8");
    truncated = true;
  }
  return { text, truncated, total: lines.length };
}


// ---------- 影子仓按时间瘦身（方案四 §5.2：compact） ----------
// 膨胀机理：每 AI 会话一个分支 refs/heads/aiti/<sid>，plumbing 提交永不删除；无 reflog → 删 ref 即断可达性，
// gc --prune=now 可完全回收该会话对象（分支间不合并，无共享对象顾虑）。

export interface CompactOptions {
  days?: number;            // 保留窗（tip committer date 早于 now-days → 候删；默认 30）
  keepActiveHours?: number; // 活跃会话保护：分支 ref 文件 mtime 近 N 小时内 → 跳过（默认 24）
  maxObjectsMB?: number;    // 水位：gc 后 objects 仍超 → days 减半重跑（默认 300；最多 3 轮）
  dryRun?: boolean;         // 只出报告不动任何数据
  extConfigDir?: string;    // 本扩展 configDir（ops/state 无主残留同窗清理用）
  log?: (m: string) => void;
}

export interface CompactResult {
  ok: boolean;
  repoRoot: string;
  dryRun?: boolean;
  lockHeld?: boolean;       // 已有 compact 在跑 → 本轮直接放弃
  rounds?: number;
  daysUsed?: number;
  branchesCandidate?: number;
  branchesRemoved?: number;
  removedBranches?: string[];
  opsStateCleaned?: number;
  /** 同批删除的 tag 数（删分支的会话；tag 是可达性根，不清则 gc 回收不了对象） */
  tagsRemoved?: number;
  /** 同批删除的 index-<sid> 文件数（会话死后的磁盘残留，~232KB/会话） */
  indexesRemoved?: number;
  /** dry-run：候选会话的 tag 总数 */
  tagsCandidate?: number;
  /** dry-run：候选会话的 index 文件总数 */
  indexesCandidate?: number;
  objectsMBBefore?: number;
  objectsMBAfter?: number;
  reclaimedMB?: number;
  error?: string;
}

const TRACE_OBJECTS_LIMIT_FILES = 20000;

/** objects 体积（count-objects -v 的 size+size-pack，KB→MB）。 */
async function traceObjectsMB(store): Promise<number> {
  const r = await runGit(store, ["count-objects", "-v"], { allowFail: true });
  let kb = 0;
  for (const line of String(r.stdout || "").split("\n")) {
    const m = line.match(/^(size|size-pack):\s+(\d+)$/);
    if (m) kb += Number(m[2]);
  }
  return kb / 1024;
}

/** 列 refs/heads/aiti/* 分支：[{ ref, short, tipUnix, mtimeMs }]。 */
async function listSessionBranches(store): Promise<Array<{ ref: string; short: string; tipUnix: number; mtimeMs: number }>> {
  const r = await runGit(store, ["for-each-ref", "refs/heads/aiti/", "--format=%(refname)%09%(committerdate:unix)"], { allowFail: true });
  const out = [];
  for (const line of String(r.stdout || "").split("\n")) {
    const [ref, unix] = line.split("\t");
    if (!ref || !unix) continue;
    const short = ref.replace("refs/heads/aiti/", "");
    let mtimeMs = 0;
    try { mtimeMs = statSync(pathJoin(store.gitDir, "refs", "heads", "aiti", short)).mtimeMs; } catch (e) { /* packed-refs：视为不活跃 */ }
    out.push({ ref, short, tipUnix: Number(unix) * 1000, mtimeMs });
  }
  return out;
}

/** 同批删该会话的台账与 state（三者同生共死：只删影子仓分支会留孤儿索引）。短 sid 前缀匹配长 sid 文件。 */
function removeSessionSidecarFiles(extConfigDir: string, short: string): number {
  if (!extConfigDir) return 0;
  let n = 0;
  for (const [dirName, suffix] of [["state/ops", ".jsonl"], ["cache/state", ".json"]]) {
    const dir = pathJoin(extRootOf(extConfigDir), dirName);
    if (!existsSync(dir)) continue;
    let ents: any[] = [];
    try { ents = readdirSync(dir); } catch (e) { continue; }
    for (const f of ents) {
      if (f.startsWith(short) && f.endsWith(suffix)) {
        try { rmSync(pathJoin(dir, f)); n++; } catch (e) { /* 尽力删 */ }
      }
    }
  }
  return n;
}

/** 该会话的全部 tag 引用（refs/tags/aiti/<short>/...）。
 *  缺口背景（2026-09-13 审计）：compact 原只删分支不删 tag——tag 是 git 可达性根，
 *  被引用的 commit/tree/blob 永远 gc 不掉（对象回收形同虚设），且 packed-refs 随 op
 *  无限膨胀（pi-work 实测 13 天 11.3 万 tag / packed-refs 8.3MB / 10 万行）。
 *  须与分支同批清（保留窗一致：都只动过期已删会话）。 */
async function listSessionTags(store, short: string): Promise<string[]> {
  const prefix = "refs/tags/aiti/" + short;
  const r = await runGit(store, ["for-each-ref", "--format=%(refname)", prefix], { allowFail: true });
  return String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
}
/** 批量删该会话全部 tag（update-ref --stdin 单进程；逐个 -d 会 fork N 次，单会话可达数千 tag）。 */
async function removeSessionTags(store, short: string): Promise<number> {
  const refs = await listSessionTags(store, short);
  if (!refs.length) return 0;
  const input = refs.map((ref) => "delete " + ref).join("\n") + "\n";
  await runGit(store, ["update-ref", "--stdin"], { allowFail: true, input });
  return refs.length;
}

/** 该会话的 index 文件（<gitDir>/index-<完整 sid>；与 sidecar 同款短 sid 前缀匹配）。
 *  index 命名用完整 sessionId（pi 侧 sanitize，本侧直拼；UUID 无特殊字符实际同形），
 *  而分支名用短 sid（16 字符）——前缀匹配。 */
function listSessionIndexFiles(store, short: string): string[] {
  const out: string[] = [];
  try {
    for (const f of readdirSync(store.gitDir)) {
      if (!f.startsWith("index-")) continue;
      if (f.slice("index-".length, "index-".length + short.length) !== short) continue;
      out.push(f);
    }
  } catch (e) { /* 目录不可读 → 无候选 */ }
  return out;
}
function removeSessionIndexFiles(store, short: string): number {
  let n = 0;
  for (const f of listSessionIndexFiles(store, short)) {
    try { rmSync(pathJoin(store.gitDir, f)); n++; } catch (e) { /* 尽力删 */ }
  }
  return n;
}

/** 无主残留清理：ops/*.jsonl、state/*.json 按 mtime 早于保留窗直接删（与影子仓同一保留窗）。 */
export function cleanupOrphanSidecars(extConfigDir: string, days: number, dryRun = false): number {
  if (!extConfigDir) return 0;
  const cutoff = Date.now() - days * 86400 * 1000;
  let n = 0;
  for (const dirName of ["state/ops", "cache/state"]) {
    const dir = pathJoin(extRootOf(extConfigDir), dirName);
    if (!existsSync(dir)) continue;
    let ents: any[] = [];
    try { ents = readdirSync(dir); } catch (e) { continue; }
    for (const f of ents) {
      const fp = pathJoin(dir, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) { if (!dryRun) rmSync(fp); n++; }
      } catch (e) { /* 尽力 */ }
    }
  }
  return n;
}

/**
 * 影子仓瘦身主流程（§5.2 八步）。
 * 不可逆提示：裁剪丢的是 N 天前的 AI 操作追溯（时间线/回滚能力）；默认 30 天审计窗。
 */
export async function compact(repoRoot: string, opts: CompactOptions = {}): Promise<CompactResult> {
  const days0 = Math.max(1, opts.days ?? 30);
  const keepActiveHours = opts.keepActiveHours ?? 24;
  const maxObjectsMB = opts.maxObjectsMB ?? 300;
  const dryRun = !!opts.dryRun;
  const log = opts.log || (() => {});
  const store = storeOf(repoRoot, "compact");
  const out: CompactResult = { ok: false, repoRoot, dryRun };

  if (!storeOk(repoRoot)) return { ...out, error: "目标不是追踪仓（无 .aiti-trace/HEAD）" };

  // 1. 排它锁（O_EXCL 原子创建；写入侧 commit 前探测等待——防撕裂窗口）
  const lock = pathJoin(store.gitDir, "compact.lock");
  let fd: number | null = null;
  if (dryRun) {
    if (existsSync(lock)) return { ...out, lockHeld: true, error: "已有 compact 在跑（锁存在）；dry-run 只报告不持锁" };
  } else {
    try {
      fd = openSync(lock, "wx");
      writeSync(fd, String(process.pid));
    } catch (e) {
      return { ...out, lockHeld: true, error: "已有 compact 在跑（compact.lock O_EXCL 失败）" };
    }
  }

  try {
    const mbBefore = await traceObjectsMB(store);
    let days = days0;
    let rounds = 0;
    const removedBranches: string[] = [];
    let opsStateCleaned = 0;
    let tagsRemoved = 0;
    let indexesRemoved = 0;

    while (rounds < 3) {
      rounds++;
      const now = Date.now();
      const branches = await listSessionBranches(store);
      const cands = branches.filter((b) =>
        b.tipUnix < now - days * 86400 * 1000 &&                                  // tip 早于保留窗
        (b.mtimeMs === 0 || b.mtimeMs < now - keepActiveHours * 3600 * 1000));    // 且非活跃（mtime 保护）
      if (dryRun) {
        let tagsCandidate = 0;
        let indexesCandidate = 0;
        for (const b of cands) {
          tagsCandidate += (await listSessionTags(store, b.short)).length;
          indexesCandidate += listSessionIndexFiles(store, b.short).length;
        }
        return {
          ...out, ok: true, rounds, daysUsed: days, branchesCandidate: cands.length,
          removedBranches: cands.map((b) => b.short), objectsMBBefore: mbBefore,
          opsStateCleaned: dryRun ? cleanupOrphanSidecars(opts.extConfigDir || "", days, true) : 0,
          tagsCandidate, indexesCandidate,
        };
      }
      // 4. 候删分支逐个原子删除 + 同批删台账/state/tag/index（后二者：审计缺口补全）
      for (const b of cands) {
        const r = await runGit(store, ["update-ref", "-d", b.ref], { allowFail: true });
        if (r.code !== 0) { log(`[compact] 删 ${b.short} 失败：` + (r.stderr || "").split("\n")[0]); continue; }
        removedBranches.push(b.short);
        opsStateCleaned += removeSessionSidecarFiles(opts.extConfigDir || "", b.short);
        tagsRemoved += await removeSessionTags(store, b.short);
        indexesRemoved += removeSessionIndexFiles(store, b.short);
      }
      // 5. gc 回收不可达对象（hermetic env 同写入侧）
      await runGit(store, ["gc", "--prune=now", "--quiet"], { allowFail: true });
      // 6. 水位复核
      const mbNow = await traceObjectsMB(store);
      if (mbNow <= maxObjectsMB) {
        return {
          ...out, ok: true, rounds, daysUsed: days, branchesCandidate: cands.length,
          branchesRemoved: removedBranches.length, removedBranches, opsStateCleaned, tagsRemoved, indexesRemoved,
          objectsMBBefore: mbBefore, objectsMBAfter: mbNow, reclaimedMB: Math.max(0, mbBefore - mbNow),
        };
      }
      days = Math.floor(days / 2);
      if (days < 1) {
        return { ...out, ok: true, rounds, daysUsed: days0, branchesRemoved: removedBranches.length,
          removedBranches, opsStateCleaned, tagsRemoved, indexesRemoved, objectsMBBefore: mbBefore, objectsMBAfter: mbNow,
          reclaimedMB: Math.max(0, mbBefore - mbNow) };
      }
      log(`[compact] 水位超 ${maxObjectsMB}MB（现 ${mbNow.toFixed(0)}MB）→ days 减半为 ${days} 重跑`);
    }
    const mbFinal = await traceObjectsMB(store);
    return { ...out, ok: true, rounds, daysUsed: days, branchesRemoved: removedBranches.length,
      removedBranches, opsStateCleaned, tagsRemoved, indexesRemoved, objectsMBBefore: mbBefore, objectsMBAfter: mbFinal,
      reclaimedMB: Math.max(0, mbBefore - mbFinal) };
  } finally {
    // 7. 释放锁
    if (fd !== null) { try { closeSync(fd); } catch (e) {} }
    if (!dryRun) { try { unlinkSync(lock); } catch (e) {} }
  }
}

/** 收集已知追踪仓列表：state 快照的 cwd + workspace 配置的 paths（去重、过滤非追踪仓）。 */
export function collectTraceRepos(extConfigDir: string): string[] {
  if (!extConfigDir) return [];
  const roots = new Set<string>();
  const pushIfStore = (p: string) => {
    try {
      const rp = pathResolve(p);
      if (storeOk(rp)) roots.add(rp);
    } catch (e) { /* 忽略坏路径 */ }
  };
  for (const dirName of ["cache/state", "state"]) {
    const dir = pathJoin(extRootOf(extConfigDir), dirName);
    if (!existsSync(dir)) continue;
    let ents: any[] = [];
    try { ents = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (e) { continue; }
    for (const f of ents) {
      try {
        const j = JSON.parse(readFileSync(pathJoin(dir, f), "utf8"));
        if (j && typeof j.cwd === "string") pushIfStore(j.cwd);
      } catch (e) { /* 坏 json 跳过 */ }
    }
  }
  for (const dirName of ["cache/workspaces", "workspaces"]) {
    const dir = pathJoin(extRootOf(extConfigDir), dirName);
    if (!existsSync(dir)) continue;
    let ents: any[] = [];
    try { ents = readdirSync(dir).filter((f) => f.endsWith(".json")); } catch (e) { continue; }
    for (const f of ents) {
      try {
        const j = JSON.parse(readFileSync(pathJoin(dir, f), "utf8"));
        for (const p of (j && Array.isArray(j.paths) ? j.paths : [])) {
          if (p && typeof p.path === "string") pushIfStore(p.path);
        }
      } catch (e) { /* 坏 json 跳过 */ }
    }
  }
  return [...roots];
}
