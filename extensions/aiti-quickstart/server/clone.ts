/**
 * aiti-quickstart · clone 引擎 + 获取历史（v2 Workspace Hub，方案 docs/aiti-quickstart-hub-plan.md §3）。
 *
 * clone（checkout 专项）：
 *   - spawn `git clone --progress [--depth N] [--branch b] <ref> <staging>`（arg-array，无 shell；
 *     ref/branch 已由 client parseGitUrl 拒前导 `-`/控制字符——服务端 isUnsafeGitArg 再拦一道）；
 *   - staging `<final>.qs-clone-<ts>-<rand>/` 在目标父目录内（rename 恒同 fs）→ 成功 rename →
 *     never-overwrite `-2/-3`（upload pickFinalName 同款语义，实现内联避免跨端 import client TS）；
 *   - 进度：stderr 逐行解析（`--progress` 的 "Receiving/Resolving objects: xx%"）→
 *     aiti-event-bus.publish-local topic `aiti-quickstart:clone:<jobId>`（软依赖，缺席静默）；
 *   - 600s 死线（SIGTERM → 5s 宽限 SIGKILL）；失败清 staging + stderr 尾部摘要；
 *   - git 缺失（whichBin null）→ 400「需要 git」。
 *
 * 历史（不可再生 → state 层 `ctx.stateDir ?? <configDir>/state`，原子写 tmp+rename）：
 *   - GET history：记录 + 目录扫描合并（`~/workspace` 顶层目录 mtime top8，source:"scan"
 *     不写盘）——覆盖「上次 zip 上传的几个」（既往 upload 无记录，靠扫描呈现）。
 *   - POST forget {id}。
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { whichBin } from "@aiti-ai/ext-shared/exec-async";
import type { ExtApiCtx } from "./types.ts";

/* ── 安全 ── */

/** clone 传参防选项注入：拒绝前导 `-` 与控制字符（parseGitUrl 同语义的服务端复检）。 */
function isUnsafeGitArg(s: string): boolean {
  return /^-/.test(s) || /[\u0000-\u001f\u007f]/.test(s);
}

/* ── 进度帧（event-bus 软依赖） ── */

export interface CloneProgressFrame {
  phase: "cloning" | "receiving" | "resolving" | "done" | "error";
  percent?: number;
  message?: string;
  root?: string;
  error?: string;
}

function publisher(ctx: ExtApiCtx): ((topic: string, frame: CloneProgressFrame) => void) | null {
  const publish = ctx.services?.get?.("aiti-event-bus.publish-local") as
    ((topic: string, data: unknown) => void) | undefined;
  if (typeof publish !== "function") return null;
  return (topic, frame) => {
    try { publish(topic, frame); } catch { /* ignore */ }
  };
}

/** stderr 行解析：git --progress 的 "Receiving objects:  42% (123/293)" /
 *  "Resolving deltas:  100% (50/50)" → percent（阶段词 + 任意冒号后缀）。 */
export function parseCloneProgress(line: string): CloneProgressFrame | null {
  const m = line.match(/(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Checking out files):\s+\d+%/);
  if (m) {
    const tag = m[1];
    const pct = line.match(/:\s+(\d+)%/);
    const percent = pct ? Number(pct[1]) : undefined;
    const phase = tag === "Receiving objects" ? "receiving"
      : (tag === "Resolving deltas" || tag === "Checking out files") ? "resolving"
      : "cloning";
    return percent === undefined ? { phase } : { phase, percent };
  }
  if (/Cloning into/.test(line)) return { phase: "cloning" };
  if (/Checking connectivity/.test(line)) return { phase: "resolving" };
  return null;
}

/* ── spawn 流式（exec-async 无流式；超时杀语义对齐 execFileAsync） ── */

interface SpawnResult { code: number | null; signal: NodeJS.Signals | null; stderrTail: string }

function spawnStream(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
  onLine: (line: string) => void,
): Promise<SpawnResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    let settled = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000).unref?.();
        }, opts.timeoutMs)
      : null;
    if (timer && typeof timer.unref === "function") timer.unref();

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stderrTail });
    };

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000); // 尾部摘要（错误回传用）
      for (const line of chunk.split(/\r?\n|\r/)) {
        if (line.trim()) onLine(line);
      }
    });
    child.on("error", () => finish(null, null));
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/* ── 历史存取（state 层，原子写） ── */

export interface WorkspaceRecord {
  id: string;
  source: "clone" | "upload" | "local" | "new" | "scan";
  root: string;
  name: string;
  time: number;
  url?: string;
}

const HISTORY_FILE = "quickstart/recent-workspaces.json";
const MAX_RECORDS = 32;
const SCAN_LIMIT = 8;

function stateDir(ctx: ExtApiCtx): string {
  const dir = (ctx as { stateDir?: string }).stateDir
    ?? join(ctx.configDir ?? "", "state");
  return dir;
}

function historyPath(ctx: ExtApiCtx): string {
  return join(stateDir(ctx), HISTORY_FILE);
}

export function readHistory(ctx: ExtApiCtx): WorkspaceRecord[] {
  try {
    const raw = fs.readFileSync(historyPath(ctx), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is WorkspaceRecord =>
      r && typeof r === "object" && typeof (r as WorkspaceRecord).root === "string" && typeof (r as WorkspaceRecord).id === "string",
    ).slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function writeHistory(ctx: ExtApiCtx, records: WorkspaceRecord[]): void {
  const file = historyPath(ctx);
  try {
    fs.mkdirSync(dirname(file), { recursive: true }); // 含 quickstart/ 子目录
    const tmp = `${file}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(records.slice(0, MAX_RECORDS), null, 1), "utf8");
    fs.renameSync(tmp, file);
  } catch { /* best-effort */ }
}

/** 追加记录：同 root 去重（新条目置顶）；source:"scan" 不入库。 */
export function appendHistory(ctx: ExtApiCtx, record: WorkspaceRecord): WorkspaceRecord[] {
  if (record.source === "scan") return readHistory(ctx);
  const next = [record, ...readHistory(ctx).filter((r) => r.root !== record.root)];
  writeHistory(ctx, next);
  return next;
}

/** 目录扫描兜底：~/workspace 顶层目录 mtime top8（不含隐藏/点前缀；不递归；读失败返回空）。 */
export function scanDefaultWorkspaces(home: string): Array<{ root: string; time: number }> {
  const root = home ? join(home, "workspace") : "";
  if (!root) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ root: string; time: number }> = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      const st = fs.statSync(join(root, e.name));
      if (st.isDirectory()) out.push({ root: join(root, e.name), time: st.mtimeMs });
    } catch { /* ignore */ }
  }
  return out.sort((a, b) => b.time - a.time).slice(0, SCAN_LIMIT);
}

/** 历史 + 扫描合并（与 client quickstart-logic.mergeWorkspaceHistory 同语义；服务端单一事实源）。 */
export function mergedHistory(ctx: ExtApiCtx, home: string): WorkspaceRecord[] {
  const seen = new Set<string>();
  const out: WorkspaceRecord[] = [];
  for (const r of readHistory(ctx)) {
    if (!r.root || seen.has(r.root)) continue;
    seen.add(r.root);
    out.push(r);
  }
  for (const s of scanDefaultWorkspaces(home)) {
    if (seen.has(s.root)) continue;
    seen.add(s.root);
    out.push({ id: `scan:${s.root}`, source: "scan", root: s.root, name: basename(s.root), time: s.time });
  }
  return out.slice(0, 16);
}

/* ── clone 端点 ── */

export interface CloneResult {
  ok: boolean;
  root?: string;
  name?: string;
  jobId?: string;
  elapsedMs?: number;
  error?: string;
}

/** 冲突顺延（内联实现；语义同 client pickFinalName）。 */
function pickFinal(base: string, parent: string): string {
  if (!fs.existsSync(join(parent, base))) return base;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(join(parent, candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function handleClone(body: Record<string, unknown> | null, ctx: ExtApiCtx): Promise<Response> {
  const started = Date.now();
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const dir = typeof body?.dir === "string" ? body.dir.trim() : "";
  const branch = typeof body?.branch === "string" ? body.branch.trim() : "";
  const depth = typeof body?.depth === "number" && body.depth > 0 ? Math.floor(body.depth) : 0;

  if (!url || isUnsafeGitArg(url)) return json({ ok: false, error: "缺少或非法的仓库地址" }, 400);
  if (branch && isUnsafeGitArg(branch)) return json({ ok: false, error: "非法的分支名" }, 400);

  const git = whichBin("git");
  if (!git) return json({ ok: false, error: "未找到 git——请先安装 git（clone 功能依赖它）" }, 400);

  // 目标：**dir 语义 = 目标父目录**（Hub 表单「目标目录」缺省 ~/workspace，最终目录 =
  // <dir>/<仓库名>，冲突 -2/-3 顺延）；缺省 ~/workspace/<urlName>。父目录必须可建。
  let parent: string;
  let baseName: string;
  if (dir) {
    if (!isAbsolute(dir)) return json({ ok: false, error: "目标目录必须为绝对路径" }, 400);
    parent = resolve(dir);
    if (parent === resolve("/") || !isAbsolute(parent)) return json({ ok: false, error: "不能放到文件系统根目录" }, 400);
    baseName = url.replace(/[\\/]+$/, "").replace(/\.git$/, "").split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "") || "workspace";
  } else {
    parent = join(homedir(), "workspace");
    baseName = url.replace(/[\\/]+$/, "").replace(/\.git$/, "").split(/[\\/]/).pop()?.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "") || "workspace";
  }
  if (parent === resolve("/") || !isAbsolute(parent)) return json({ ok: false, error: "不能放到文件系统根目录" }, 400);
  try {
    fs.mkdirSync(parent, { recursive: true });
    fs.accessSync(parent, fs.constants.W_OK);
  } catch (e) {
    return json({ ok: false, error: `目标目录不可用：${(e as Error).message}` }, 400);
  }

  const finalName = pickFinal(baseName, parent);
  const finalPath = join(parent, finalName);
  const stage = `${finalPath}.qs-clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const jobId = `clone-${Date.now().toString(36)}`;
  const publish = publisher(ctx);
  const topic = `aiti-quickstart:${jobId}`;

  const args: string[] = ["clone", "--progress"];
  if (depth > 0) args.push("--depth", String(depth));
  if (branch) args.push("--branch", branch);
  args.push(url, stage);

  publish?.(topic, { phase: "cloning", message: `${url} → ${finalPath}` });
  const r = await spawnStream(git, args, { timeoutMs: 600_000 }, (line) => {
    const frame = parseCloneProgress(line);
    if (frame) publish?.(topic, frame);
  });

  if (r.code !== 0) {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    const tail = r.stderrTail.split(/\r?\n/).filter((l) => l.trim() && !/^Receiving|^Resolving|^Counting|^Compressing/.test(l)).slice(-3).join(" / ").trim();
    const error = r.signal ? `克隆超时中止（${String(r.signal)}）` : (tail || `git clone 退出码 ${r.code ?? "?"}`);
    publish?.(topic, { phase: "error", error });
    return json({ ok: false, error } satisfies CloneResult, 400);
  }

  try {
    fs.renameSync(stage, finalPath);
  } catch (e) {
    await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {});
    const error = `落位失败：${(e as Error).message}`;
    publish?.(topic, { phase: "error", error });
    return json({ ok: false, error } satisfies CloneResult, 500);
  }

  publish?.(topic, { phase: "done", root: finalPath, percent: 100 });
  const record: WorkspaceRecord = {
    id: `clone:${finalPath}`,
    source: "clone",
    root: finalPath,
    name: finalName,
    time: Date.now(),
    url,
  };
  appendHistory(ctx, record);
  return json({
    ok: true, root: finalPath, name: finalName, jobId,
    elapsedMs: Date.now() - started,
  } satisfies CloneResult & { ok: true });
}

/* ── history / forget 端点 ── */

export async function handleHistory(ctx: ExtApiCtx): Promise<Response> {
  let home = "";
  try { home = homedir(); } catch { /* ignore */ }
  return json({ ok: true, workspaces: mergedHistory(ctx, home) });
}

export async function handleForget(body: Record<string, unknown> | null, ctx: ExtApiCtx): Promise<Response> {
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return json({ ok: false, error: "缺少 id" }, 400);
  const next = readHistory(ctx).filter((r) => r.id !== id);
  writeHistory(ctx, next);
  return json({ ok: true, workspaces: next });
}

/** PUT history：客户端补记（Hub 本地目录/新建入口）。source 白名单：clone/upload 由
 *  各自服务端通道写入，此处只收 local/new（防外部伪造来源语义）。 */
export async function handleRecord(body: Record<string, unknown> | null, ctx: ExtApiCtx): Promise<Response> {
  const source = typeof body?.source === "string" ? body.source : "";
  const root = typeof body?.root === "string" ? body.root.trim() : "";
  if (source !== "local" && source !== "new") return json({ ok: false, error: "非法 source" }, 400);
  if (!root || !isAbsolute(root)) return json({ ok: false, error: "root 必须为绝对路径" }, 400);
  const name = (typeof body?.name === "string" && body.name.trim()) || root.split(/[\\/]/).filter(Boolean).pop() || root;
  const record: WorkspaceRecord = {
    id: `${source}:${root}`,
    source: source as WorkspaceRecord["source"],
    root,
    name,
    time: typeof body?.time === "number" ? body.time : Date.now(),
  };
  const next = appendHistory(ctx, record);
  return json({ ok: true, workspaces: next });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
