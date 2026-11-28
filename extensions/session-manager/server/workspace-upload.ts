/**
 * workspace-upload —— workspace 下拉「上传工作区」服务端
 * （方案 docs/session-manager-workspace-upload-plan.md）
 *
 * API（session-manager /api/extensions/session-manager/workspace/*）：
 *   POST /upload?name=<enc(包文件名)>&dir=<enc(目标目录绝对路径)>
 *     body = 原始字节流（客户端 XHR upload.onprogress 进度；服务端流式写盘零整包内存）
 *     → { ok, root, singleRoot, renamed, bytes, elapsedMs }
 *   GET /capabilities
 *     → { zip, tar, rar, sevenz }（zip/tar 恒可用；rar/7z 看系统命令，值为通道工具名或 null）
 *
 * 流程（统一 staging + 永不覆盖，方案 §3）：
 *   校验 → 目标目录内建临时区 .sm-upload-<ts>/{archive, extract/}（rename 恒同 fs，无跨盘复制）
 *   → 流式收包（1GB 上限，Content-Length 预检 + 流式计数双保险）
 *   → 解压到 extract/（zip=yauzl 逐条清洗防 zip slip；tar/rar/7z=系统工具，自身带路径防御）
 *   → 逃逸校验（解压前后目标目录 readdir diff，工具缺陷兜底）
 *   → 清垃圾（__MACOSX/.DS_Store/._*）→ readdir 推断单根（绕开 tar/7z 列表 GBK/quoting 编码坑）
 *   → 冲突顺延 -2/-3 → rename 落位 → 清临时区。
 *
 * 单根判定（方案 §2）：extract/ 顶层恰一个目录 → 带根（落位名=该目录名，root=目标/根名）；
 * 散文件/多顶层 → 不带根（落位名=包名去扩展，root=目标/<包名>）；重名一律顺延，永不覆盖。
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { platform } from "node:os";

// yauzl（CJS）双环境可解析：jiti 运行时与 node strip-types 测试都走这里，walk-up 命中
// 扩展本地或共享根 <webRoot>/node_modules（同 aiti-channels 样板）。
const require_ = createRequire(import.meta.url);

const IS_WIN = platform() === "win32";
/** 单包上传上限：1GB（nginx 全局 client_max_body_size 4096m 之上收紧到常见 workspace 量级）。 */
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
/** 解压总字节上限（zip bomb 防护；tar/rar/7z 流式写盘靠磁盘自限，zip 侧按条目声明累计）。 */
const MAX_EXTRACT_BYTES = 8 * 1024 * 1024 * 1024;
/** staging 临时区前缀（点前缀隐藏；每次上传顺手清理 >24h 残留，请求驱动非轮询）。 */
const STAGE_PREFIX = ".sm-upload-";
const STAGE_STALE_MS = 24 * 60 * 60 * 1000;

export class UploadTooLargeError extends Error {
  constructor() { super("上传内容超过 1GB 上限"); }
}
/** 可转成 4xx 明确报错的领域错误（message 直出给前端）。 */
export class UploadError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ───────────────────────── 格式识别 ─────────────────────────

export type ArchiveKind = "zip" | "tar" | "tar.gz" | "tar.bz2" | "tar.xz" | "rar" | "7z";

const ARCHIVE_EXTS: readonly [string, ArchiveKind][] = [
  [".tar.gz", "tar.gz"], [".tgz", "tar.gz"],
  [".tar.bz2", "tar.bz2"], [".tbz2", "tar.bz2"],
  [".tar.xz", "tar.xz"], [".txz", "tar.xz"],
  [".tar", "tar"], [".zip", "zip"], [".rar", "rar"], [".7z", "7z"],
];

/** 按扩展名识别压缩包：返回 { kind, base }（base = 去扩展名的包名）；不识别返回 null。 */
export function classifyArchive(name: string): { kind: ArchiveKind; base: string } | null {
  const lower = name.toLowerCase();
  for (const [ext, kind] of ARCHIVE_EXTS) {
    if (lower.endsWith(ext)) return { kind, base: name.slice(0, name.length - ext.length) };
  }
  return null;
}

/** tar 系解压/列表压缩旗标（GNU tar 与 Windows bsdtar 均认 -z/-j/-J 显式压缩）。 */
function tarFlags(kind: ArchiveKind, list: boolean): string[] {
  const c = kind === "tar" ? "" : kind === "tar.gz" ? "z" : kind === "tar.bz2" ? "j" : "J";
  return [list ? `-t${c}f` : `-x${c}f`];
}

// ───────────────────────── 工具探测（进程级缓存） ─────────────────────────

export interface ArchiveCapabilities {
  zip: true;
  tar: true;
  /** rar 解压通道工具名："unrar"（lb/x）/ "7z"（l -ba -slt/x）/ null（无可用工具）。 */
  rar: string | null;
  /** 7z 通道工具名："7z" / "7za" / null。 */
  sevenz: string | null;
}

interface CapCache { at: number; value: ArchiveCapabilities | null }
const capCache: CapCache = { at: 0, value: null };
const CAP_TTL_MS = 5 * 60_000;

/** 探测命令可执行（spawn 不走 shell；ENOENT = 无）。无参调用即退（usage），只关心 error。 */
function probeSpawnable(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, [], { stdio: "ignore", windowsHide: true, timeout: 5000 });
      child.on("error", () => resolve(false));
      child.on("close", () => resolve(true));
    } catch { resolve(false); }
  });
}

/** Windows 常见安装位探测（PATH 无 7z 时的兜底；绝对路径直接当命令 spawn）。 */
function windowsSevenZPath(): string | null {
  if (!IS_WIN) return null;
  for (const root of [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], "C:\\Program Files", "C:\\Program Files (x86)"]) {
    if (!root) continue;
    for (const exe of ["7z.exe", "7za.exe"]) {
      const p = join(root, "7-Zip", exe);
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return null;
}

async function firstSpawnable(cmds: string[]): Promise<string | null> {
  for (const c of cmds) if (await probeSpawnable(c)) return c;
  return null;
}

/** 解压能力探测（TTL 缓存；rar 通道 unrar → 7z 顺延，7z 通道 7z → 7za → Windows 安装位）。 */
export async function archiveCapabilities(): Promise<ArchiveCapabilities> {
  if (capCache.value && Date.now() - capCache.at < CAP_TTL_MS) return capCache.value;
  const win7z = windowsSevenZPath();
  const sevenz = win7z ?? (await firstSpawnable(["7z", "7za"]));
  const unrar = await firstSpawnable(["unrar"]);
  const value: ArchiveCapabilities = {
    zip: true,
    tar: true,
    rar: unrar ?? sevenz,
    sevenz,
  };
  capCache.at = Date.now();
  capCache.value = value;
  return value;
}

// ───────────────────────── 解压通道 ─────────────────────────

function runTool(cmd: string, args: string[], label: string, timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const child = spawn(cmd, args, { windowsHide: true, timeout: timeoutMs });
    child.stderr?.on("data", (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.stdout?.on("data", () => {}); // 排空防背压
    child.on("error", (e) => reject(new UploadError(`${label} 执行失败：${(e as Error).message}`, 500)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new UploadError(`${label} 失败（exit ${code}）：${stderr.slice(-300) || "无 stderr"}`, 500));
    });
  });
}

/** tar-family extraction (system tar; GNU/bsdtar refuse absolute paths and ".." entries by default).
 *  win32 appends --force-local: GNU tar parses the drive-letter colon in `-f C:\...` as a
 *  remote host ("Cannot connect to C:", Git usr/bin GNU tar; bsdtar accepts the option too).
 *  Separate option style (-x/-z/-f each standalone): with clustered -xzf the token after f
 *  becomes the archive name, so --force-local in between would be treated as the file. */
function extractTar(file: string, kind: ArchiveKind, dest: string): Promise<void> {
  const comp = kind === "tar" ? [] : kind === "tar.gz" ? ["-z"] : kind === "tar.bz2" ? ["-j"] : ["-J"];
  return runTool("tar", ["-x", ...comp, ...(IS_WIN ? ["--force-local"] : []), "-f", file, "-C", dest], "tar 解压");
}

/** unrar 通道解压（x 全路径 + -y 全确认；目标须以分隔符结尾 unrar 才按目录处理）。 */
function extractUnrar(tool: string, file: string, dest: string): Promise<void> {
  return runTool(tool, ["x", "-y", "-o+", file, dest + sep], "unrar 解压");
}

/** 7z 通道解压（-o<dest> 无空格紧跟目录）。 */
function extractSevenZ(tool: string, file: string, dest: string): Promise<void> {
  return runTool(tool, ["x", "-y", `-o${dest}`, file], "7z 解压");
}

/** zip 解压：yauzl 流式逐条写盘（aiti-channels 样板）；逐条清洗防 zip slip，垃圾条目跳过。 */
function extractZip(file: string, dest: string): Promise<{ entries: number; bytes: number }> {
  const yauzl = require_("yauzl");
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true }, (err: Error | null, zip: any) => {
      if (err || !zip) return reject(new UploadError(`zip 打开失败：${err?.message ?? "未知错误"}`, 400));
      let failed = false;
      let entries = 0;
      let bytes = 0;
      const fail = (e: unknown) => {
        if (!failed) {
          failed = true;
          if (e instanceof UploadError) return reject(e);
          const msg = String((e as Error)?.message ?? e);
          // yauzl 自身拦截（decodeStrings 模式）：../ 条目/绝对路径 → invalid relative path；转 400 语义
          if (/invalid (relative|absolute) path/i.test(msg)) {
            return reject(new UploadError(`zip 含非法路径（拒绝解压）：${msg}`, 400));
          }
          reject(new UploadError(`zip 解压失败：${msg}`, 500));
        }
      };
      zip.on("error", fail);
      zip.on("end", () => { if (!failed) resolve({ entries, bytes }); });
      zip.on("entry", (entry: any) => {
        if (failed) return;
        const raw = String(entry.fileName);
        const parts = sanitizeArchivePath(raw);
        if (!parts) return fail(new UploadError(`zip 含非法路径（拒绝解压）：${raw}`, 400));
        if (isJunkPath(parts)) return zip.readEntry(); // mac 垃圾条目不落盘
        if (zipEntryIsDir(entry)) return zip.readEntry(); // 目录条目（含无尾斜杠但有目录位的变体）不落盘——后续条目 mkdir recursive 隐式建目录
        const target = join(dest, ...parts);
        const size = Number(entry.uncompressedSize ?? 0);
        bytes += size;
        if (bytes > MAX_EXTRACT_BYTES) return fail(new UploadError("解压内容超过 8GB 上限（疑似 zip bomb）", 400));
        zip.openReadStream(entry, (e: Error | null, rs: NodeJS.ReadableStream | null) => {
          if (failed) return;
          if (e || !rs) return fail(e ?? new Error(`zip 条目读取失败：${raw}`));
          fsp.mkdir(join(dest, ...parts.slice(0, -1)), { recursive: true }).then(() => {
            if (failed) return;
            const ws = createWriteStream(target);
            entries++;
            rs.on("error", fail);
            ws.on("error", (we: NodeJS.ErrnoException) => {
              // 同路径既文件又目录的病态包（先写出的目录占位被文件条目覆盖写）→ 400 语义明确
              if (we.code === "EISDIR") return fail(new UploadError(`zip 内路径冲突：${raw} 与已解压目录同名（拒绝解压）`, 400));
              fail(we);
            });
            ws.on("finish", () => { if (!failed) zip.readEntry(); });
            rs.pipe(ws);
          }).catch((me: NodeJS.ErrnoException) => {
            // recursive mkdir 仅在已存在路径是文件时抛 EEXIST → 包内某条目先把同名路径写成文件
            if (me.code === "EEXIST") {
              return fail(new UploadError(`zip 内路径冲突：${parts.slice(0, -1).join("/")} 既是文件又是目录（拒绝解压）`, 400));
            }
            fail(me);
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** 按能力分发解压。返回文件条目数（zip 有精确值，其余 null——仅展示用）。 */
async function extractArchive(
  file: string, kind: ArchiveKind, dest: string, caps: ArchiveCapabilities,
): Promise<{ entries: number | null }> {
  fs.mkdirSync(dest, { recursive: true });
  if (kind === "zip") return extractZip(file, dest);
  if (kind === "rar") {
    if (caps.rar === "unrar") { await extractUnrar("unrar", file, dest); return { entries: null }; }
    if (caps.rar) { await extractSevenZ(caps.rar, file, dest); return { entries: null }; }
    throw new UploadError("解压 .rar 需要系统安装 unrar 或 p7zip（本机未检测到）", 415);
  }
  if (kind === "7z") {
    if (!caps.sevenz) throw new UploadError("解压 .7z 需要系统安装 7-Zip/p7zip（本机未检测到）", 415);
    await extractSevenZ(caps.sevenz, file, dest);
    return { entries: null };
  }
  await extractTar(file, kind, dest);
  return { entries: null };
}

// ───────────────────────── 路径清洗 / 垃圾过滤 / 单根检测 ─────────────────────────

/**
 * zip 条目是否为目录条目。除标准的尾部斜杠外，还识别两类无斜杠变体（常见于 Windows 工具 /
 * Java zip 流打包器——它们不写尾斜杠，目录语义只在外部属性里）：unix mode 目录位
 * （externalFileAttributes 高 16 位）与 MS-DOS 目录位（低字节 bit 4）。漏判会把目录写成
 * 同名文件，后续子路径条目建目录时撞 EEXIST（2026-11-06 实测：git-pullkeep 包）。
 */
export function zipEntryIsDir(entry: { fileName?: unknown; externalFileAttributes?: unknown }): boolean {
  const name = String(entry.fileName ?? "");
  if (name.endsWith("/")) return true;
  const attrs = Number(entry.externalFileAttributes ?? 0);
  if (!Number.isFinite(attrs) || attrs === 0) return false;
  if (((attrs >>> 16) & 0o170000) === 0o40000) return true; // unix mode: S_IFDIR
  if ((attrs & 0x10) !== 0) return true; // MS-DOS: FILE_ATTRIBUTE_DIRECTORY
  return false;
}

/**
 * zip 条目路径清洗（zip slip 防御）：统一反斜杠、拒绝 `..`、绝对路径、盘符段。
 * 返回相对段数组；非法返回 null（整包拒绝）。
 */
export function sanitizeArchivePath(raw: string): string[] | null {
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null; // 绝对路径 / 盘符
  const parts = p.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((s) => s === "." || s === "..")) return null;
  if (parts.some((s) => /^[A-Za-z]:$/.test(s))) return null; // 盘符段（"C:"）
  return parts;
}

/** mac 垃圾条目（任何层级）：__MACOSX 前缀树、.DS_Store、AppleDouble `._*`。 */
export function isJunkPath(parts: string[]): boolean {
  if (parts[0] === "__MACOSX") return true;
  const last = parts[parts.length - 1];
  return last === ".DS_Store" || last.startsWith("._");
}

/**
 * 单根判定（方案 §2，从解压后的 staging 目录推断——绕开 tar/7z 列表编码坑）：
 * 顶层恰一个目录（含空目录）→ 单根返回目录名；散文件/多顶层/空目录 → null。
 */
export function detectSingleRootFromDir(dir: string): string | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const visible = names.filter((n) => !isJunkPath([n]));
  if (visible.length !== 1) return null;
  try { return fs.statSync(join(dir, visible[0])).isDirectory() ? visible[0] : null; }
  catch { return null; }
}

/** 落位名冲突顺延：base 存在 → base-2、base-3…（永不覆盖，方案 §3）。 */
export function pickFinalName(base: string, existsFn: (name: string) => boolean): string {
  if (!existsFn(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base}-${i}`;
    if (!existsFn(n)) return n;
  }
  return `${base}-${Date.now()}`;
}

/** 递归清理解压出的 mac 垃圾（解压后、落位前；目录级 __MACOSX 整树删）。 */
async function cleanupJunk(dir: string): Promise<void> {
  await fsp.rm(join(dir, "__MACOSX"), { recursive: true, force: true }).catch(() => {});
  const walk = async (d: string): Promise<void> => {
    let items: fs.Dirent[];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = join(d, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.name === ".DS_Store" || it.name.startsWith("._")) await fsp.rm(p, { force: true }).catch(() => {});
    }
  };
  await walk(dir);
}

// ───────────────────────── 流式收包 ─────────────────────────

async function streamToFile(req: Request, dest: string): Promise<number> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw new UploadTooLargeError();
  if (!req.body) throw new UploadError("请求体为空", 400);
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _e, cb) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) { cb(new UploadTooLargeError()); return; }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]), counter, createWriteStream(dest));
  return total;
}

// ───────────────────────── staging / 落位 ─────────────────────────

function isFsRoot(p: string): boolean {
  const norm = p.replace(/[\\/]+$/, "");
  if (norm === "") return true;
  if (IS_WIN) return /^[A-Za-z]:$/.test(norm);
  return norm === "/";
}

/** staging 残留清理（>24h 顺手删，请求驱动非轮询）。 */
async function pruneStaleStages(targetDir: string): Promise<void> {
  let items: fs.Dirent[];
    try { items = fs.readdirSync(targetDir, { withFileTypes: true }); } catch { return; }
  const now = Date.now();
  for (const it of items) {
    if (!it.isDirectory() || !it.name.startsWith(STAGE_PREFIX)) continue;
    try {
      const st = fs.statSync(join(targetDir, it.name));
      if (now - st.mtimeMs > STAGE_STALE_MS) await fsp.rm(join(targetDir, it.name), { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}

/** rename 落位（staging 与目标同目录树，恒同 fs；EXDEV 防御性 fallback 复制+删）。 */
async function moveToTarget(src: string, dest: string): Promise<void> {
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw e;
    await fsp.cp(src, dest, { recursive: true });
    await fsp.rm(src, { recursive: true, force: true });
  }
}

// ───────────────────────── API handlers ─────────────────────────

interface MinimalCtx {
  searchParams: URLSearchParams;
}

/** GET /workspace/capabilities —— 解压工具探测（弹窗据此调 accept 与提示文案）。 */
export async function handleCapabilities(): Promise<Response> {
  const caps = await archiveCapabilities();
  return json({ ok: true, ...caps });
}

/** POST /workspace/upload?name=&dir= —— 主流程（方案 §5）。 */
export async function handleWorkspaceUpload(req: Request, ctx: MinimalCtx): Promise<Response> {
  const started = Date.now();
  let stage: string | null = null;
  let realDir = "";
  try {
    // ── 校验 ──
    const rawName = ctx.searchParams.get("name") ?? "";
    const rawDir = ctx.searchParams.get("dir") ?? "";
    const onlyBase = basename(rawName); // 防路径注入（只取文件名）
    if (!onlyBase || onlyBase === "." || onlyBase === "..") throw new UploadError("缺少包文件名", 400);
    const cls = classifyArchive(onlyBase);
    if (!cls) throw new UploadError(`不支持的压缩包格式：${onlyBase}（支持 zip / tar.gz / tgz / tar.bz2 / tbz2 / tar.xz / txz / tar / rar / 7z）`, 415);
    if (!rawDir || !isAbsolute(rawDir)) throw new UploadError("目标目录必须为绝对路径", 400);

    try {
      realDir = fs.realpathSync(rawDir); // symlink 已解析（对齐宿主 /api/files 防逃逸姿势）
    } catch {
      throw new UploadError("目标目录不存在", 400);
    }
    let dirStat: fs.Stats;
    try { dirStat = fs.statSync(realDir); } catch { throw new UploadError("目标目录不存在", 400); }
    if (!dirStat.isDirectory()) throw new UploadError("目标不是目录", 400);
    if (isFsRoot(realDir)) throw new UploadError("不能解压到文件系统根目录", 400);

    await pruneStaleStages(realDir);

    // ── 临时区（目标目录内：rename 恒同 fs，无跨盘复制）──
    stage = join(realDir, `${STAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const extractDir = join(stage, "extract");
    try { fs.mkdirSync(extractDir, { recursive: true }); } catch (e) {
      throw new UploadError(`目标目录不可写：${(e as Error).message}`, 400);
    }

    // ── 流式收包 ──
    const archivePath = join(stage, "archive" + (onlyBase.slice(onlyBase.length - cls.base.length)));
    const before = new Set(fs.readdirSync(realDir));
    let bytes = 0;
    try {
      bytes = await streamToFile(req, archivePath);
    } catch (e) {
      if (e instanceof UploadTooLargeError) throw new UploadError(`上传超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`, 413);
      throw new UploadError(`接收上传失败：${(e as Error).message}`, 400);
    }
    if (bytes === 0) throw new UploadError("空文件", 400);

    // ── 解压（zip 逐条清洗；tar/rar/7z 系统工具）──
    const caps = await archiveCapabilities();
    let extracted: { entries: number | null };
    try {
      extracted = await extractArchive(archivePath, cls.kind, extractDir, caps);
    } catch (e) {
      if (e instanceof UploadError) throw e;
      throw new UploadError(`解压失败：${(e as Error).message}`, 400);
    }

    // ── 逃逸校验（工具路径防御缺陷兜底：目标目录下只允许新增 staging 本身）──
    const after = new Set(fs.readdirSync(realDir));
    const escaped = [...after].filter((n) => !before.has(n) && !n.startsWith(STAGE_PREFIX));
    if (escaped.length > 0) {
      for (const n of escaped) await fsp.rm(join(realDir, n), { recursive: true, force: true }).catch(() => {});
      throw new UploadError("压缩包含越界路径，已拒绝并清理（zip slip 防御）", 400);
    }

    // ── 清垃圾 + 单根判定（FS readdir，方案 §2）──
    await cleanupJunk(extractDir);
    const rootDir = detectSingleRootFromDir(extractDir);
    const singleRoot = rootDir !== null;
    const sourceDir = singleRoot ? join(extractDir, rootDir) : extractDir;

    // ── 冲突顺延 + 落位（永不覆盖）──
    const finalBase = singleRoot ? rootDir : cls.base;
    const finalName = pickFinalName(finalBase, (n) => fs.existsSync(join(realDir, n)));
    const finalPath = join(realDir, finalName);
    await moveToTarget(sourceDir, finalPath);

    // ── 清临时区 + 响应 ──
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    stage = null;
    return json({
      ok: true,
      root: finalPath,
      singleRoot,
      renamed: finalName !== finalBase,
      finalName,
      entries: extracted.entries,
      bytes,
      elapsedMs: Date.now() - started,
    });
  } catch (e) {
    if (stage) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    const status = e instanceof UploadError ? e.status : 500;
    const message = (e as Error)?.message ?? String(e);
    return json({ ok: false, error: message }, status);
  }
}
