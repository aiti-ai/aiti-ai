/**
 * aiti-editor · pi-web 文件编辑器扩展（可扩展编辑器 + Monaco + 保存）
 *
 * 设计：docs/pi-web-file-editor-design.md（v0.3 扩展化架构）
 * M1 能力：
 *   - fileViewer slot 接管：文本类文件由扩展组件渲染（Monaco 编辑），非文本交核心旧查看器
 *   - POST /save：fs 写入 + baseMtime 冲突 409 + 白名单/大小校验（读/watch 复用核心 API，零改动）
 * 后续（M2+）：注册表开放（window.__aitiEditor）、语言服务桥、ContentProvider 自定义、Markdown 增强
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, closeSync, statSync, watch, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import diffMatchPatch from "./vendor/diff-match-patch.js";
import { execFileAsync, whichBin } from "@aiti-ai/ext-shared/exec-async";
import { createConvertSaveAsRoute } from "./convert-saveas";
import { locateSoffice, locateSofficeAsync, setSofficeDataDir, invalidateSofficeCache, SOFFICE_INSTALL_HINTS } from "./soffice-locate";
import {
  resolvePreviewTarget, previewRelOrEntry, previewCsp, previewMimeOf, isPreviewDoc, servePreviewDoc,
  previewBaseFromSegments, PREVIEW_MAX_BYTES, PREVIEW_DOC_MAX_BYTES,
} from "./preview/preview-serve.ts";

// ── 7-Zip 解析链：系统已装 → 直接用；未装 → justget 多源下载 portable 7za（~1-2MB，缓存本地） ──
//   主源 GitHub develar/7zip-bin；镜像多源（justget 竞速）：
//     1) gitee justdb-mirrors/downloads（自有镜像，tools/mirror-7za.mjs 同步）——国内加速
//     2) jsDelivr CDN（自动镜像 GitHub 仓库）——全球 CDN
//     3) ghproxy 代理（GitHub 加速）——纯代理兜底
//   justget 多源竞速：主站快则不启动镜像，慢/失败自动切镜像。客户机零安装。
const GITEE_MIRROR = "https://gitee.com/justdb-mirrors/downloads/raw/master/7zip-bin";
const GHPROXY = "https://ghproxy.net";
const PORTABLE_7Z_REL: Record<string, { rel: string; isWindow: boolean }> = {
  "linux-x64": { rel: "linux/x64/7za", isWindow: false },
  "linux-ia32": { rel: "linux/ia32/7za", isWindow: false },
  "linux-arm": { rel: "linux/arm/7za", isWindow: false },
  "linux-arm64": { rel: "linux/arm64/7za", isWindow: false },
  "win32-x64": { rel: "win/x64/7za.exe", isWindow: true },
  "win32-ia32": { rel: "win/ia32/7za.exe", isWindow: true },
  "darwin-x64": { rel: "mac/x64/7za", isWindow: false },
  "darwin-arm64": { rel: "mac/arm64/7za", isWindow: false },
};
let _portable7zPath: string | null | undefined;
let _portable7zInflight: Promise<string | null> | null = null;
/** configDir 兜底（startup 未提供 ctx.configDir 时）：PI_WEB_DATA_DIR 优先（Docker/Windows 数据根独立于 ~/.pi）；未设 = ~/.pi/web-dev/data 原行为 */
function fallbackDataDir(): string {
  return join(process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi", "web-dev", "data"), "aiti-editor", "config");
}
/** portable 7za 缓存路径（cache/7z/；数据分层：下载物可重建 → cache） */
function portable7zPath(): string {
  const dir = join(ensureCacheDir(), "7z");
  try { mkdirSync(dir, { recursive: true }); } catch { /* 目录创建失败 */ }
  const key = process.platform + "-" + process.arch;
  const bin = PORTABLE_7Z_REL[key]?.isWindow ? "7za.exe" : "7za";
  return join(dir, bin);
}
/** 找 justget CLI（~/workspace/justget 或 PATH） */
function findJustgetCli(): string | null {
  const cands = [
    process.env.JUSTGET_BIN as string,
    join(homedir(), "workspace", "justget", "dist", "cli.js"),
    join(homedir(), "workspace", "justget", "justget.mjs"),
  ].filter(Boolean);
  for (const c of cands) { try { if (existsSync(c)) return c; } catch { /* 忽略 */ } }
  { // 纯 fs PATH 探测（2026-09-12 execSync→async 改造：spawnSync 探针移除）
    if (whichBin("justget")) return "justget";
  }
  return null;
}
/** 异步跑子进程（Promise 化；无输出收集，只看退出码）。
 *  性能红线（2026-09-13）：原 spawnSync 同步探测/下载（timeout 3~100s）会把 pi-web
 *  主线程冻结；改异步后语义不变、主线程不被占用。 */
function runProcAsync(cmd: string, args: string[], opts: { timeoutMs?: number; stdio?: unknown } = {}): Promise<{ code: number | null; error?: string }> {
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn(cmd, args, { stdio: (opts.stdio as any) ?? ["ignore", "ignore", "ignore"], windowsHide: true });
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (code: number | null, error?: string) => { if (done) return; done = true; if (timer) clearTimeout(timer); resolve({ code, error }); };
    if (opts.timeoutMs) timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } finish(null, "timeout"); }, opts.timeoutMs);
    child.on("error", (e: Error) => finish(null, String(e?.message || e)));
    child.on("close", (c: number | null) => finish(c));
  });
}

/** 确保 portable 7za 就绪：已缓存 → 直接返回；未缓存 → justget 多源下载并校验 */
async function ensurePortable7z(): Promise<string | null> {
  if (_portable7zPath) return Promise.resolve(_portable7zPath);
  if (_portable7zInflight) return _portable7zInflight;
  const key = process.platform + "-" + process.arch;
  const conf = PORTABLE_7Z_REL[key];
  if (!conf) { _portable7zPath = null; return Promise.resolve(null); }
  const dest = portable7zPath();
  const { existsSync: _exists } = require("node:fs") as typeof import("node:fs");
  if (_exists(dest)) {
    // 缓存已存在：快速校验可用
    if (await test7zBin(dest)) { _portable7zPath = dest; return Promise.resolve(dest); }
  }
  _portable7zInflight = (async () => {
    const primary = "https://raw.githubusercontent.com/develar/7zip-bin/master/" + conf.rel;
    // 多镜像：gitee 自有（tools/mirror-7za.mjs 同步）/ jsDelivr CDN / ghproxy 代理
    const mirrors = [
      GITEE_MIRROR + "/" + conf.rel,
      "https://cdn.jsdelivr.net/gh/develar/7zip-bin@master/" + conf.rel,
      GHPROXY + "/https://raw.githubusercontent.com/develar/7zip-bin/master/" + conf.rel,
    ];
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { readFileSync: _read, writeFileSync: _write, chmodSync: _chmod, rmSync: _rm } = require("node:fs") as typeof import("node:fs");
    const tmp = join(tmpdir(), "aiti-7za-" + process.pid + "-" + Date.now());
    try {
      // 主源 + 多镜像竞速（justget -m 可重复）；失败降级 fetch 顺序尝试
      const jg = findJustgetCli();
      const srcs = [primary, ...mirrors];
      let done = false;
      if (jg) {
        const base = jg === "justget" ? [jg] : [process.execPath, jg];
        try {
          const jgArgs = [primary, "-o", tmp];
          for (const m of mirrors) jgArgs.push("-m", m);
          jgArgs.push("--timeout", "90000", "--connect-timeout", "10000");
          // 异步下载（性能红线：execFileSync 同步跑网络下载 timeout 100s 冻结主线程）
          await new Promise<void>((resolve, reject) => {
            const { execFile } = require("node:child_process") as typeof import("node:child_process");
            execFile(base[0], [...base.slice(1), ...jgArgs], { stdio: ["ignore", "ignore", "inherit"], timeout: 100000 }, (err) => (err ? reject(err) : resolve()));
          });
          done = true;
        } catch (e) {
          console.error("[aiti-editor] justget 下载 7za 失败，降级 fetch: " + String((e as Error).message || e));
        }
      }
      if (!done && _exists(tmp)) { try { _rm(tmp); } catch { /* 忽略 */ } }
      if (!done) {
        let buf: Buffer | null = null;
        for (const u of srcs) {
          try {
            const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(60000) });
            if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); console.log("[aiti-editor] 7za 回退源 OK: " + u); break; }
          } catch { /* 试下一个源 */ }
        }
        if (!buf) throw new Error("全部源下载失败（" + srcs.join(" | ") + "）");
        _write(tmp, buf);
      }
      const buf = _read(tmp);
      _write(dest, buf);
      if (!conf.isWindow) { try { _chmod(dest, 0o755); } catch { /* Windows 忽略 */ } }
      if (!(await test7zBin(dest))) throw new Error("下载的 7za 不可用");
      _portable7zPath = dest;
      return dest;
    } catch (e) {
      _portable7zPath = null;
      console.error("[aiti-editor] portable 7za 下载失败: " + String((e as Error).message || e));
      return null;
    } finally {
      try { _rm(tmp, { force: true }); } catch { /* 忽略 */ }
      _portable7zInflight = null;
    }
  })();
  return _portable7zInflight;
}
/** 校验某个 7z 二进制可执行（异步 -i 探测；原 spawnSync 5s 同步版会冻主线程） */
async function test7zBin(bin: string): Promise<boolean> {
  const r = await runProcAsync(bin, ["i"], { timeoutMs: 5000 });
  return r.code === 0;
}
/** 获取可用 7z 二进制：系统优先，其次按需下载 portable */
async function resolve7zBin(): Promise<string | null> {
  const sys = await findSystem7z();
  if (sys) return sys;
  return ensurePortable7z();
}

// ── 系统 7-Zip 探测（可选增强：zip/tar/gz 纯 JS 无需它；7z/rar 等专有格式需要）──
let _sevenBin: string | null | undefined;
async function findSystem7z(): Promise<string | null> {
  if (_sevenBin !== undefined) return _sevenBin;
  const { existsSync: _exists } = require("node:fs") as typeof import("node:fs");
  const candidates: string[] = ["7z", "7za", "7zr"];
  // Windows 常见安装路径
  if (process.platform === "win32") {
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    candidates.push(pf + "\\7-Zip\\7z.exe", pf86 + "\\7-Zip\\7z.exe");
  }
  for (const c of candidates) {
    try {
      if (c.includes("/") || c.includes("\\")) {
        if (_exists(c)) { _sevenBin = c; return c; }
        continue;
      }
      const r = await runProcAsync(c, ["i"], { timeoutMs: 3000 });
      if (r.code === 0) { _sevenBin = c; return c; }
    } catch { /* 继续探测 */ }
  }
  _sevenBin = null;
  return null;
}
/** 递归查找文件（7z 提取可能带子目录结构） */
function findFileRecursive(dir: string, filename: string): string | null {
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isFile() && ent.name === filename) return full;
      if (ent.isDirectory()) {
        const found = findFileRecursive(full, filename);
        if (found) return found;
      }
    }
  } catch { /* 忽略 */ }
  return null;
}
/** 7z -slt 解析结果 → 文件条目 */
function pushSevenEntry(files: Array<{ name: string; size: number; date: string; compressedSize?: number }>, rec: Record<string, string>): void {
  // 仅收真实文件条目：必须有 Attributes 字段（7z -slt 归档头摘要块无此字段）
  if (!rec.Path || rec.Path === "*" || !rec.Attributes) return;
  files.push({
    name: rec.Path,
    size: parseInt(rec.Size || "0", 10) || 0,
    date: rec.Modified ? new Date(rec.Modified.replace(" ", "T") + "Z").toLocaleString("zh-CN", { hour12: false }) : "",
    compressedSize: parseInt(rec.PackedSize || "0", 10) || undefined,
  });
}

let configDir = "";

let _gbkTable: Map<string, number> | null = null;
/** 构建 unicode→GBK 码映射（隐含 ASCII + cp936 压缩表） */
function gbkMap(): Map<string, number> {
  if (_gbkTable) return _gbkTable;
  const m = new Map<string, number>();
  for (let c = 0; c < 128; c++) m.set(String.fromCharCode(c), c);
  const tables = JSON.parse(readFileSync(join(__dirname, "vendor", "tables", "cp936.json"), "utf8")) as any[];
  for (const row of tables) {
    let code = parseInt(row[0], 16);
    for (let i = 1; i < row.length; i++) {
      const v = row[i];
      if (typeof v === "string") { for (const ch of v) { if (!m.has(ch)) m.set(ch, code); code++; } }
      else if (typeof v === "number") code += v;
    }
  }
  _gbkTable = m;
  return m;
}
/** 按编码编码文本为 Buffer（保留 BOM 状态） */
function encodeText(content: string, encoding: string, hasBOM: boolean): Buffer {
  switch (encoding) {
    case "utf-8": {
      const b = Buffer.from(content, "utf8");
      return hasBOM ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]) : b;
    }
    case "utf-16le": {
      const b = Buffer.from(content, "utf16le");
      return hasBOM ? Buffer.concat([Buffer.from([0xff, 0xfe]), b]) : b;
    }
    case "utf-16be": {
      const b = Buffer.from(content, "utf16le").swap16();
      return hasBOM ? Buffer.concat([Buffer.from([0xfe, 0xff]), b]) : b;
    }
    case "gbk": {
      const m = gbkMap();
      const out: number[] = [];
      for (const ch of content) {
        const code = m.get(ch);
        if (code === undefined) out.push(0x3f); // 未映射 → ?
        else if (code <= 0x7f) out.push(code);
        else out.push(code >> 8, code & 0xff);
      }
      return Buffer.from(out);
    }
    default: // latin1/ascii 等单字节
      return Buffer.from(content, "latin1");
  }
}
/** 编码检测：BOM 优先，无 BOM utf-8 严格试，失败 gbk/latin1 兜底 */
function detectEncoding(buf: Buffer): { encoding: string; hasBOM: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { encoding: "utf-8", hasBOM: true };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: "utf-16le", hasBOM: true };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: "utf-16be", hasBOM: true };
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return { encoding: "utf-8", hasBOM: false }; }
  catch {
    const g = new TextDecoder("gbk").decode(buf);
    const replaces = (g.match(/\\uFFFD/g) || []).length;
    if (replaces > 0 && replaces / Math.max(g.length, 1) > 0.05) return { encoding: "latin1", hasBOM: false };
    return { encoding: "gbk", hasBOM: false };
  }
}
/** 解码（去掉 BOM） */
function decodeText(buf: Buffer, encoding: string, hasBOM: boolean): string {
  let b = buf;
  if (hasBOM) {
    if (encoding === "utf-8") b = buf.subarray(3);
    else if (encoding === "utf-16le" || encoding === "utf-16be") b = buf.subarray(2);
  }
  if (encoding === "utf-8") return b.toString("utf8");
  if (encoding === "utf-16le") return b.toString("utf16le");
  if (encoding === "utf-16be") { const s = Buffer.from(b); return s.swap16().toString("utf16le"); }
  if (encoding === "gbk") return new TextDecoder("gbk").decode(b);
  return b.toString("latin1");
}

/** 保证缓存目录存在（数据分层：cache 在扩展数据根下 —— configDir = <extRoot>/config → dirname(configDir)/cache） */
function ensureCacheDir(): string {
  if (!configDir) {
    // startup 未提供 ctx.configDir 的 fallback
    configDir = fallbackDataDir();
  }
  const dir = join(dirname(configDir), "cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

// ── 编辑器偏好持久化（M0 §1.4a）：configDir/editor-prefs.json，{ ".docx": "providerId" }。
//    原子写（tmp+rename，对齐 cache 惯例）；GET 全量 / PUT 增量合并。 ──
function readPrefs(): Record<string, string> {
  try {
    const dir = configDir || fallbackDataDir();
    const raw = readFileSync(join(dir, "editor-prefs.json"), "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}
function writePrefsAtomic(prefs: Record<string, string>): void {
  const dir = configDir || fallbackDataDir();
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, ".editor-prefs.tmp-" + process.pid + "-" + Date.now());
  writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  renameSync(tmp, join(dir, "editor-prefs.json"));
}

// ---------- 路径票据（安全基线：文件路径不进 URL）----------
// 浏览器/代理 access log 会永久保留查询串——文件路径一旦进 URL 即永久泄露。
// 客户端先 POST /ticket {filePath} 换随机票据，之后所有读端点走 /t/<ticket>/<endpoint>，
// 服务端兑换出真实路径。票据 TTL 1h + 滑动续期（活跃会话不过期），可重复兑换
//（<video> 拖动进度条、EventSource 自动重连都会多次请求）。
const EDITOR_TICKET_TTL_MS = 3_600_000;
const editorTickets = new Map<string, { fp: string; root: string; exp: number }>();
// ---------- 文件 watch（pi-web 页面事件流承载，全页 0 条专用连接）----------
// 客户端 POST /ticket {filePath, wantWatch:true} → 返回 watchId 并内联启动 fs.watch（300ms 防抖）；变化经
// globalThis.__piPageEvents.publish("ed-watch", { id, size, mtimeMs }) 推送，
// 浏览器端按 id 过滤。POST /watch-stop {watchId} / 30min 无事件自动停（防泄漏）。
const editorWatches = new Map<string, { target: string; watcher: any; timer: any; lastFire: number; idleTimer: any }>();
function publishEdWatch(id: string, data: Record<string, unknown>): void {
  (globalThis as any).__piPageEvents?.publish("ed-watch", { id, ...data });
}
function startEditorWatch(id: string, target: string): void {
  if (editorWatches.has(id)) return;
  const rec: any = { target, watcher: null, timer: null, lastFire: Date.now(), idleTimer: null };
  const fire = () => {
    if (rec.timer) return;
    rec.timer = setTimeout(() => { // 300ms 防抖：流式写入连发事件合并
      rec.timer = null;
      rec.lastFire = Date.now();
      try { const s2 = statSync(target); publishEdWatch(id, { size: s2.size, mtimeMs: Math.floor(s2.mtimeMs) }); }
      catch { publishEdWatch(id, { gone: true }); }
    }, 300);
  };
  try { rec.watcher = watch(target, fire); }
  catch {
    try { rec.watcher = watch(dirname(target), (_e: any, name: any) => { if (!name || String(name) === basename(target)) fire(); }); }
    catch { return; } // 无法监听：客户端保持静态预览
  }
  // 30min 无事件自动停（防客户端遗忘 stop 造成泄漏）；重开由客户端带 wantWatch 的 /ticket 驱动
  rec.idleTimer = setInterval(() => { if (Date.now() - rec.lastFire > 30 * 60_000) stopEditorWatch(id); }, 60_000);
  rec.idleTimer.unref?.();
  editorWatches.set(id, rec);
}
function stopEditorWatch(id: string): void {
  const rec = editorWatches.get(id);
  if (!rec) return;
  editorWatches.delete(id);
  try { rec.watcher?.close(); } catch { /* noop */ }
  if (rec.timer) clearTimeout(rec.timer);
  if (rec.idleTimer) clearInterval(rec.idleTimer);
}
function issueEditorTicket(fp: string, root: string): string {
  const now = Date.now();
  if (editorTickets.size > 512) {
    for (const [k, v] of editorTickets) if (v.exp < now) editorTickets.delete(k); // 懒清理过期
  }
  const token = createHash("sha256").update(randomBytes(24)).update(String(now)).digest("hex").slice(0, 48);
  editorTickets.set(token, { fp, root, exp: now + EDITOR_TICKET_TTL_MS });
  return token;
}
function redeemEditorTicket(token: string): { fp: string; root: string } | null {
  const rec = editorTickets.get(token);
  if (!rec) return null;
  if (rec.exp < Date.now()) { editorTickets.delete(token); return null; }
  rec.exp = Date.now() + EDITOR_TICKET_TTL_MS; // 滑动续期
  return { fp: rec.fp, root: rec.root };
}

/** session-files 条目归一化：旧格式（string）→ {path, kind:"file"}；已是对象则补全 kind。 */
function normalizeSessionFiles(files: any[]): Array<{ path: string; kind: string }> {
  const out: Array<{ path: string; kind: string }> = [];
  for (const e of files) {
    if (typeof e === "string") out.push({ path: e, kind: "file" });
    else if (e && typeof e.path === "string") out.push({ path: e.path, kind: e.kind === "folder" ? "folder" : "file" });
  }
  return out;
}

/** 最大可编辑文本长度（> 此值保存拒绝；读取仍可只读展示）。 */
const MAX_EDIT_BYTES = 1024 * 1024;

/** ~ 开头的 home 相对路径 → 绝对路径（"~" → home，"~/x"/"~\\x" → home/x）；其余原样。 */
function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** 宿主 file-access 门禁（pi-web allowed-roots：session cwd/projectRoot 动态集合；ctx.core 注入，
 *  M3 对齐——与 aiti-folder/doc-center/git-trace 同一安全面）。修复 Windows 项目根不在 home 下
 *  （如 155：项目在 D:\workspace 而 home 在 C:\Users）时静态名单误杀「路径不在白名单内」；
 *  缺席（独立测试环境/旧宿主）→ 静态名单兜底。 */
let _hostIsAllowed: ((p: string) => Promise<boolean>) | null = null;
function bindHostFileAccess(ctx: any): void {
  const fa = ctx?.core?.fileAccess;
  if (fa && typeof fa.isAllowed === "function") _hostIsAllowed = (p: string) => fa.isAllowed(p);
}

/** 读写白名单（读+写同一面；对标核心 allowed-roots 语义）：宿主 fileAccess.isAllowed 优先（session
 *  cwd/projectRoot 等动态集合），静态名单（cwd + ~/workspace + home）并集兜底——行为只增不减。
 *  返回 normalize 后路径；拒绝返回 null。 */
async function resolveAllowedWrite(filePath: string, cwd?: string): Promise<string | null> {
  if (!filePath) return null;
  // ~ 开头 = home 相对路径：浏览器无 homedir，消息里的 ~/ 路径（msg-smart 识别、写入文件 chips、
  // markdown 链接）原样透传到编辑器，统一在此展开（与 core /api/files filePathFromSegments 一致）
  const expanded = expandTildePath(filePath);
  if (!isAbsolute(expanded)) return null;
  const fp = normalize(expanded);
  if (_hostIsAllowed) {
    try { if (await _hostIsAllowed(fp)) return fp; } catch { /* 宿主门禁异常 → 落静态名单 */ }
  }
  const home = homedir();
  const roots: string[] = [];
  if (cwd && isAbsolute(cwd)) roots.push(normalize(cwd));
  roots.push(join(home, "workspace"));
  roots.push(home); // 用户根（本地单用户可信环境兜底；宿主在位时核心 roots 覆盖常规面）
  return roots.some((r) => fp === r || fp.startsWith(r + sep)) ? fp : null;
}

// ── git 变更探测（工作区 vs HEAD）：打开文件时显示「有变更」+ diff 视图（左右/合并/大纲，对标 aiti-git-review）──
/** 自 dir 向上找 git 仓库根（.git 目录或文件——worktree/submodule 均可）；找不到返回 null */
function findRepoRoot(startDir: string): string | null {
  let cur = startDir;
  for (let i = 0; i < 48; i++) {
    try { if (existsSync(join(cur, ".git"))) return cur; } catch { /* 忽略 */ }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
/** 固定参数跑 git（无用户拼接输入，pathspec 走 -- ；失败返回 ok:false） */
async function gitRun(repo: string, args: string[], maxBuffer = 1024 * 1024): Promise<{ ok: boolean; out: string }> {
  // 异步化（2026-09-12 execSync→async 改造）：错误形态对齐 spawnSync（e.stderr）
  try {
    const out = await execFileAsync("git", args, { cwd: repo, maxBuffer, timeoutMs: 8000 });
    return { ok: true, out };
  } catch (e: any) { return { ok: false, out: String(e.stderr || e) }; }
}
/** 固定参数跑 git，返回原始 Buffer（HEAD blob 按文件编码探测解码用，避免 utf8 硬解弄乱 GBK/UTF-16） */
async function gitRunBuf(repo: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<{ ok: boolean; buf: Buffer }> {
  // 异步化（2026-09-12）：Buffer 版走 spawn 手工收集（blob 二进制输出不能经 utf8 字符串往返）
  return new Promise((resolve) => {
    const { spawn } = require("node:child_process") as typeof import("node:child_process");
    const child = spawn("git", args, { cwd: repo, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    let total = 0, truncated = false;
    child.stdout!.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBuffer) { truncated = true; try { child.kill("SIGKILL"); } catch {} return; }
      chunks.push(c);
    });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 8000);
    child.on("error", () => { clearTimeout(timer); resolve({ ok: false, buf: Buffer.alloc(0) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (truncated || (code !== 0 && code !== null)) return resolve({ ok: false, buf: Buffer.alloc(0) });
      resolve({ ok: true, buf: Buffer.concat(chunks) });
    });
  });
}
const GIT_CHANGE_LABEL: Record<string, string> = { M: "已修改", A: "新增", D: "已删除", R: "重命名" };

/** EOL classification of a text blob (diagnostics only; never rewrites content). */
function textEolKind(text: string): "lf" | "crlf" | "mixed" | "none" {
  let crlf = 0, lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++; else lf++;
  }
  if (!crlf && !lf) return "none";
  if (crlf && lf) return "mixed";
  return crlf ? "crlf" : "lf";
}

/** EOL classification from a small head sample of the worktree file. */
function fileEolKind(absPath: string, sampleBytes = 64 * 1024): "lf" | "crlf" | "mixed" | "none" {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(sampleBytes);
    const n = readSync(fd, buf, 0, sampleBytes, 0);
    let crlf = 0, lf = 0;
    for (let i = 0; i < n; i++) {
      if (buf[i] !== 10) continue;
      if (i > 0 && buf[i - 1] === 13) crlf++; else lf++;
    }
    if (!crlf && !lf) return "none";
    if (crlf && lf) return "mixed";
    return crlf ? "crlf" : "lf";
  } catch { return "none"; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } } }
}
/** 解析 porcelain -z 首条记录 → 简化 status（M/A/D/R）+ rename 旧路径（-z 下旧路径在第二条记录） */
function parsePorcelain(recs: string[]): { status: string; oldPath: string } {
  const xy = (recs[0] || "").slice(0, 2);
  let status = "M";
  if (xy.includes("R") || xy.includes("C")) status = "R";
  else if (xy.includes("D")) status = "D";
  else if (xy[0] === "A" || xy[1] === "A" || xy === "??") status = "A";
  return { status, oldPath: status === "R" ? (recs[1] || "") : "" };
}
/** 文件的 git 变更信息：{ repo, rel, changed, status?, oldPath?, adds?, dels? }；不在仓库/git 不可用 → changed:false */
async function gitFileInfo(target: string): Promise<{ repo: string; rel: string; changed: boolean; status?: string; oldPath?: string; adds?: number | null; dels?: number | null }> {
  const repo = findRepoRoot(dirname(target));
  if (!repo) return { repo: "", rel: "", changed: false };
  const rel = relative(repo, target).split(sep).join("/");
  const st = await gitRun(repo, ["status", "--porcelain=v1", "-z", "--", rel]);
  if (!st.ok || !st.out) return { repo, rel, changed: false }; // 干净（porcelain 空）或 git 不可用
  const { status, oldPath } = parsePorcelain(st.out.split("\0"));
  // numstat（vs HEAD）：二进制 = "- -" → null；untracked 无 diff 输出 → 工作区行数全算新增
  let adds: number | null = null, dels: number | null = null;
  if (status === "A" && (st.out.split("\0")[0] || "").slice(0, 2) === "??") {
    try { adds = readFileSync(target, "utf8").split("\n").length; dels = 0; } catch { /* 忽略 */ }
  } else {
    const nm = await gitRun(repo, ["diff", "--no-color", "--numstat", "-z", "HEAD", "--", ...(oldPath ? [oldPath, rel] : [rel])]);
    const m = nm.ok ? /^(\d+|-)\t(\d+|-)\t/.exec(nm.out) : null;
    if (m) {
      adds = m[1] === "-" ? null : parseInt(m[1], 10);
      dels = m[2] === "-" ? null : parseInt(m[2], 10);
    }
  }
  return { repo, rel, changed: true, status, oldPath, adds, dels };
}

// ── ts-siblings 兄弟文件集（Monaco TS extraLib 用）：家族扩展名 + 限制 + stat-only 签名 ──
const TS_FAMILY = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SIB_MAX_FILES = 60;
const SIB_MAX_PER_FILE = 512 * 1024;
const SIB_MAX_TOTAL = 2 * 1024 * 1024;
function isTsSibling(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".d.ts") || TS_FAMILY.includes(extname(n));
}
/** 生成编辑缓存文件名：filePath 的 md5 + .json */
function cacheName(path: string): string {
  return createHash("md5").update(path).digest("hex") + ".json";
}
/** 从编辑缓存重建当前内容（未保存编辑优先于磁盘）：content 策略直接返回；diff 策略用 diff-match-patch 反解补丁。 */
function cachedContent(data: any): string | null {
  if (!data) return null;
  if (typeof data.content === "string" && data.strategy !== "diff") return data.content;
  if (typeof data.original === "string" && typeof data.diff === "string" && data.diff) {
    try {
      const dmp = new diffMatchPatch();
      const [text] = dmp.patch_apply(dmp.patch_fromText(data.diff), data.original);
      if (typeof text === "string") return text;
    } catch { /* 补丁应用失败 → 退回磁盘 */ }
  }
  return null;
}
/** 兄弟文件集签名（仅 stat，不读文件内容）——ETag 变更检测用。
 *  每个兄弟文件的令牌：有未保存编辑缓存 → C:<缓存文件 mtime>；无 → D:<磁盘 mtime>:<size>。
 *  与响应过滤规则保持一致（同家族/跳过自身/≤512KB/≤60 个）。 */
function siblingSignature(dir: string, skipBase: string): string | null {
  try {
    const parts: string[] = [];
    let count = 0;
    const cacheDir = ensureCacheDir();
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const n = ent.name;
      if (n === skipBase || !isTsSibling(n)) continue;
      if (count >= SIB_MAX_FILES) break;
      try {
        const full = join(dir, n);
        const st = statSync(full);
        if (!st.isFile() || st.size > SIB_MAX_PER_FILE) continue;
        let tok: string;
        try {
          // 有未保存编辑缓存 → 用缓存内容哈希（内容不变则 etag 不变，避免 30s auto-save 重写相同内容白发 200）
          const cpath = join(cacheDir, cacheName(full));
          const cdata = JSON.parse(readFileSync(cpath, "utf8"));
          tok = cdata && typeof cdata.contentHash === "string" && cdata.contentHash
            ? "C:" + cdata.contentHash
            : "C:" + statSync(cpath).mtimeMs;
        } catch {
          tok = "D:" + st.mtimeMs + ":" + st.size;
        }
        parts.push(n + ":" + tok);
        count++;
      } catch { /* 单个 stat 失败跳过 */ }
    }
    if (parts.length === 0) return "empty";
    return '"' + createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16) + '"';
  } catch { return null; }
}

/** 处理保存：复用现有 GET read 的同一文件面；mtime 冲突检测 → 409。 */
async function handleSave(body: any): Promise<Response> {
  const filePath = typeof body?.filePath === "string" ? body.filePath : "";
  const content = typeof body?.content === "string" ? body.content : null;
  const cwd = typeof body?.cwd === "string" ? body.cwd : undefined;
  if (!filePath || content === null) {
    return json({ ok: false, error: "需要 filePath 与 content" }, 400);
  }
  const target = await resolveAllowedWrite(filePath, cwd);
  if (!target) {
    return json({ ok: false, error: "路径不在可写白名单内" }, 400);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) {
    return json({ ok: false, error: "文件超过 1MB，拒绝保存（只读）" }, 413);
  }
  let st;
  try {
    st = statSync(target);
    if (!st.isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
  } catch {
    return json({ ok: false, error: "文件不存在" }, 404);
  }
  const diskMtimeMs = st.mtimeMs;
  if (typeof body?.baseMtimeMs === "number") {
    // 编辑时基于的版本 vs 磁盘现状：不一致 → 409 冲突（客户端展示 diff 二选一）
    if (Math.abs(diskMtimeMs - body.baseMtimeMs) > 1) {
      return json({ ok: false, conflict: true, diskMtimeMs }, 409);
    }
  }
  // 按原编码写回（VSCode 语义：默认保持文件编码 + BOM 状态；用户可另存为其他编码）
  const encoding = typeof body?.encoding === "string" && body.encoding ? body.encoding : "utf-8";
  const hasBOM = body?.hasBOM === true;
  const out = encodeText(content, encoding, hasBOM);
  writeFileSync(target, out);
  const after = statSync(target);
  return json({ ok: true, mtimeMs: after.mtimeMs, size: after.size, encoding });
}

// ── 服务端文件提供者注册表（扩展可注册自定义 serveFile handler）──
interface FileProvider {
  id: string;
  /** 匹配的扩展名列表（不含点，如 ["png","jpg"]） */
  extensions: string[];
  /** 自定义文件服务函数：返回 Response（原始字节/处理后的内容），缺省用默认 /file 逻辑 */
  serveFile?: (filePath: string, target: string) => Response | Promise<Response>;
}
const _aitiFileProviders: FileProvider[] = [];

function registerFileProvider(provider: FileProvider): () => void {
  _aitiFileProviders.push(provider);
  return () => {
    const i = _aitiFileProviders.indexOf(provider);
    if (i >= 0) _aitiFileProviders.splice(i, 1);
  };
}

const MIME_MAP: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon",
  avif: "image/avif", heic: "image/heic", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", opus: "audio/opus",
  mp4: "video/mp4", webm: "video/webm", avi: "video/x-msvideo",
  mov: "video/quicktime", mkv: "video/x-matroska",
  pdf: "application/pdf",
  ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2", otf: "font/otf", eot: "application/vnd.ms-fontobject",
};


// ── 老格式 → 可编辑格式另存派生（.doc → .docx；-fromdoc 命名，不覆盖，(n) 递增）──
const convertSaveAsRoute = createConvertSaveAsRoute({
  extId: "aiti-editor",
  conversions: {
    doc: { toExt: "docx", filter: "docx:MS Word 2007 XML" },
    ppt: { toExt: "pptx", filter: "pptx:Impress MS PowerPoint 2007 XML" },
  },
  sofficePath: () => locateSoffice().path,
});

// ── 老格式（.doc/.ppt）→ PDF 只读预览：soffice 无头转换，configDir 按 mtime 键控缓存 ──
const DOC_PDF_EXTS = new Set(["doc", "ppt", "pptx", "odt", "odp"]);
let _sofficeBusy = 0;
function docPdfCachePath(target: string): string {
  const st = statSync(target);
  const key = createHash("md5").update(target + ":" + Math.round(st.mtimeMs) + ":" + st.size).digest("hex").slice(0, 16);
  return join(ensureCacheDir(), "docpdf", key + ".pdf"); // 数据分层：转换缓存 → cache/ 内（旧实现借 ".." 落回 configDir 根）
}
async function docToPdf(target: string): Promise<{ ok: true; pdfPath: string } | { ok: false; error: string; code?: string }> {
  const soffice = (await locateSofficeAsync()).path;
  if (!soffice) return { ok: false, code: "soffice-missing", error: "未找到 LibreOffice (soffice)：老格式转 PDF 需要它（安装后在 aiti-editor 功能配置 soffice.path）" };
  const ext = extname(target).toLowerCase().replace(/^\./, "");
  if (!DOC_PDF_EXTS.has(ext)) return { ok: false, error: "仅支持 " + [...DOC_PDF_EXTS].join("/") };
  if (statSync(target).size > 50 * 1024 * 1024) return { ok: false, error: "文件超过 50MB，拒绝转换" };
  const out = docPdfCachePath(target);
  try { const st = statSync(out); if (st.isFile() && st.size > 0) return { ok: true, pdfPath: out }; } catch { /* 无缓存 */ }
  // 同一时刻只允许一个 soffice 实例（并发转换互相锁死）
  if (_sofficeBusy) return { ok: false, error: "上一个转换还在进行，请稍后重试" };
  _sofficeBusy = 1;
  const dir = dirname(out);
  try {
    mkdirSync(dir, { recursive: true });
    const tmpOut = join(dir, "conv-" + process.pid + "-" + Date.now());
    mkdirSync(tmpOut, { recursive: true });
    // soffice 要求输出目录为空目录内转换；--convert-to pdf 产出 <basename>.pdf。
    // 异步执行（2026-09-10）：soffice 冷启动 5-20s，同步等待会阻塞整个 pi-web 事件循环
    // （guard 探活 3s 超时即误判无响应）——await 子进程期间事件循环照常服务其他请求。
    const { execFile } = require("node:child_process") as typeof import("node:child_process");
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(soffice, ["--headless", "--convert-to", "pdf", "--outdir", tmpOut, target], { timeout: 60000, stdio: ["ignore", "ignore", "pipe"] }, (err) => err ? reject(err) : resolve());
      });
    } finally {
      try { rmSync(target + ".~lock." + basename(target) + "#", { force: true }); } catch { /* 忽略锁文件清理 */ }
    }
    const produced = tmpOut + "/" + basename(target).replace(/\.[^.]+$/, "") + ".pdf";
    const st = statSync(produced);
    if (!st.isFile() || st.size === 0) throw new Error("转换产物为空");
    renameSync(produced, out);
    return { ok: true, pdfPath: out };
  } catch (e) {
    return { ok: false, error: "soffice 转换失败: " + String((e as Error).message || e).slice(0, 200) };
  } finally {
    _sofficeBusy = 0;
  }
}

/** 默认文件服务：原始字节 + 正确 Content-Type。
 *  带 Range 分片流式（RFC 7233）：音视频拖动进度条必需（206 + Content-Range），
 *  大文件走 createReadStream 不再整读进内存。
 *  opts.mime 覆盖内容类型（预览路由自带扩展名表）；opts.headers 追加响应头
 *  （HTML 预览的 CSP sandbox / nosniff / noindex 走这里，避免为同一套流式逻辑再写一份）。 */
function serveFileDefault(
  target: string,
  ext: string,
  req?: any,
  opts?: { mime?: string; headers?: Record<string, string> },
): Response {
  const mime = opts?.mime || MIME_MAP[ext] || "application/octet-stream";
  const st = statSync(target);
  const size = st.size;
  const baseHeaders: Record<string, string> = {
    "content-type": mime,
    "cache-control": "no-cache",
    "content-disposition": "inline",
    "accept-ranges": "bytes",
    etag: `"${size}-${Math.floor(st.mtimeMs)}"`,
    ...(opts?.headers || {}),
  };
  const range = String(req?.headers?.get?.("range") || "").trim();
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m && (m[1] !== "" || m[2] !== "")) {
    let start: number, end: number;
    if (m[1] === "") {
      // 后缀区间：bytes=-N → 最后 N 字节
      const n = Math.min(parseInt(m[2], 10), size);
      start = size - n; end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
    }
    if (!Number.isFinite(start) || start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
    const web = Readable.toWeb(createReadStream(target, { start, end })) as any;
    return new Response(web, {
      status: 206,
      headers: { ...baseHeaders, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  // 全量：同样走流（大媒体不再 readFileSync 整读）
  const web = Readable.toWeb(createReadStream(target)) as any;
  return new Response(web, { status: 200, headers: { ...baseHeaders, "content-length": String(size) } });
}

/** 维护扩展 => provider id 的反向索引（快速查找匹配的 provider） */
function findProvider(ext: string, filePath: string): FileProvider | null {
  // 按注册序倒序（后注册的优先，类似 CSS 优先级）
  for (let i = _aitiFileProviders.length - 1; i >= 0; i--) {
    const p = _aitiFileProviders[i];
    if (p.serveFile && p.extensions.includes(ext)) return p;
  }
  return null;
}

export default {
  id: "aiti-editor",
  name: "aiti-editor",
  description: "文件编辑器：Monaco 在线编辑（接管文本文件；非文本回退核心查看器）。设计 docs/pi-web-file-editor-design.md",
  client: "dist/aiti-editor-client.mjs",
  icon: "icon.svg",
  ai: {
    manage: true,
    intro: "AI 能帮我在服务器安装/诊断 LibreOffice (soffice)，让 .doc/.xls/.ppt 等老格式在线转换与 PDF 预览可用（aiti-editor）",
    skills: "skills",
  },
  ui: {
    // 懒加载 v2 M2：唯一入口 fileViewer（交互时挂载 + FileViewer 补触发）。
    // 右键「打开方式」菜单随之延迟到首次物化（未物化时优雅回退浏览器默认菜单）。
    // ⚠ 必须写在 ui.* 下——registry 读 e.ext.ui?.clientImmediately（原先误写在扩展顶层
    //   是从未生效的死配置，editor 此前实际一直是即时加载）。
    clientImmediately: false,
    // [idle prefetch 2026-11-24] Host materializes this lazy extension in the first idle
    // window after boot (ExtSlots.scheduleIdleMaterialized) so register() runs early and
    // warmMonacoOnIdle (entry.tsx) can preload the Monaco AMD chain ahead of the first
    // file open — without it the bundle + Monaco waterfall (~3s cold, worse on mobile)
    // lands entirely on the first open, showing an empty editor for seconds.
    // The editor has no connect side effects (pure UI registration), safe to load early.
    prefetchOnIdle: true,
    fileViewer: [
      { id: "aiti-editor", label: "i18n:it.fileviewer.label", title: "i18n:it.fileviewer.title" },
    ],
    // 文件 dock faces（file-dock.tsx 按实例动态注册）+ 图片预览浮层（image-float.tsx 固定条目）：
    // 此静态声明供宿主懒加载清单发现——刷新后存在 docked 文件实例时，消费这些插槽才知道
    // 要物化本扩展回归 face；图片浮层条目同理（dialogs 是宿主常挂插槽）。
    dialogs: [{ id: "file", label: "i18n:it.file.label" }, { id: "image-preview", label: "i18n:it.image-preview.label" }],
    sidebarExplorerDock: [{ id: "file", label: "i18n:ed.file.label", icon: "file" }],
    rightFileDock: [{ id: "file", label: "i18n:ed.file.label" }, { id: "image-preview", label: "i18n:ed.image.label" }],
    i18n: {
      // Full i18n table (2026-11-17 ext-i18n convention): client copy uses Chinese raw text as the
      // t() key — zh-CN table is identity (mandatory, prevents the cascade ui18n[loc] ?? short ?? en ??
      // first-table from wrongly hitting en on zh devices), en table carries hand translations.
      // Static slot entries keep their it.*/ed.*/ext.*/feat.* id keys, one copy per table.
      "zh-CN": {
        "it.file.label": "文件",
        "it.image-preview.label": "图片预览",
        "it.image-preview.title": "图片预览",
        "it.fileviewer.label": "编辑器",
        "it.fileviewer.title": "aiti-editor：文本文件在线编辑（Monaco），二进制可扩展渲染",
        "ext.displayName": "文件编辑器",
        "ed.file.label": "文件",
        "ed.image.label": "图片预览",
        " 编辑": " 编辑",
        " 适": " 适",
        " 预览": " 预览",
        "-副本": "-副本",
        "7za 缺失时自动下载 portable 版（客户机零安装）": "7za 缺失时自动下载 portable 版（客户机零安装）",
        "AI 帮我安装（推荐）": "AI 帮我安装（推荐）",
        "AI 选区（问 AI / 解释 / 重构 / 新会话）、@ 提及、同目录 ‹› 遍历": "AI 选区（问 AI / 解释 / 重构 / 新会话）、@ 提及、同目录 ‹› 遍历",
        "EXIF 信息读取": "EXIF 信息读取",
        "HTML 编辑 / 分栏 / 预览（快速态看缓冲、真预览态走目录级预览路由；视口预设、报错回传、相对链接改道 dock）": "HTML 编辑 / 分栏 / 预览（快速态看缓冲、真预览态走目录级预览路由；视口预设、报错回传、相对链接改道 dock）",
        "HTML 预览": "HTML 预览",
        "JSON 值": "JSON 值",
        "JSON 键": "JSON 键",
        "LibreOffice 启动失败：{msg}": "LibreOffice 启动失败：{msg}",
        "Markdown 编辑 / 分栏 / 预览（GFM、TOC、滚动同步、变更块定位、导出 HTML/PDF）": "Markdown 编辑 / 分栏 / 预览（GFM、TOC、滚动同步、变更块定位、导出 HTML/PDF）",
        "Mermaid 图表": "Mermaid 图表",
        "Monaco 在线文本/代码编辑器（含 Markdown 双模式）": "Monaco 在线文本/代码编辑器（含 Markdown 双模式）",
        "Monaco 编辑器加载失败": "Monaco 编辑器加载失败",
        "PDF 只读预览": "PDF 只读预览",
        "PDF 只读预览（浏览器原生渲染，可缩放 / 打印 / 下载）": "PDF 只读预览（浏览器原生渲染，可缩放 / 打印 / 下载）",
        "Range 流式播放（拖进度条不整载）": "Range 流式播放（拖进度条不整载）",
        "VNC 会话获取失败": "VNC 会话获取失败",
        "VNC 启动失败：{msg}": "VNC 启动失败：{msg}",
        "YAML / TOML / SQL 一键格式化": "YAML / TOML / SQL 一键格式化",
        "aiti-ai-speek 未安装或未启用——已打开扩展管理，请启用后重试": "aiti-ai-speek 未安装或未启用——已打开扩展管理，请启用后重试",
        "aiti-helper 未就绪（未部署或未加载）：刷新页面后重试，或按上方命令手动安装。": "aiti-helper 未就绪（未部署或未加载）：刷新页面后重试，或按上方命令手动安装。",
        "git 变更视图（工作区 vs HEAD：行级标注 / 左右 / 合并 / 大纲）": "git 变更视图（工作区 vs HEAD：行级标注 / 左右 / 合并 / 大纲）",
        "git 变更视图（工作区 vs HEAD；默认「最新」显示最终版）": "git 变更视图（工作区 vs HEAD；默认「最新」显示最终版）",
        "iframe 指向服务端磁盘文档：原生相对解析与站内导航（未保存编辑不可见）": "iframe 指向服务端磁盘文档：原生相对解析与站内导航（未保存编辑不可见）",
        "readFile 失败 ({status})": "readFile 失败 ({status})",
        "ticket 签发失败": "ticket 签发失败",
        "vendor 加载失败: {p}": "vendor 加载失败: {p}",
        "zip/tar/7z/rar/cab/iso 等列出清单": "zip/tar/7z/rar/cab/iso 等列出清单",
        "{name}——能力与限制": "{name}——能力与限制",
        "{n} 字节": "{n} 字节",
        "{n} 行": "{n} 行",
        "→ 目标目录: {p}": "→ 目标目录: {p}",
        "⇋ {n} 处改动 · 定位": "⇋ {n} 处改动 · 定位",
        "○关": "○关",
        "●开": "●开",
        "「虚拟环境打开」在服务器的虚拟桌面上运行 LibreOffice 并经浏览器 VNC 远程查看——适合不想在本地装 Office、且服务器已配置虚拟屏（aiti-ui-env）的场景。": "「虚拟环境打开」在服务器的虚拟桌面上运行 LibreOffice 并经浏览器 VNC 远程查看——适合不想在本地装 Office、且服务器已配置虚拟屏（aiti-ui-env）的场景。",
        "上一个图片": "上一个图片",
        "上一个文件（同目录深度遍历）": "上一个文件（同目录深度遍历）",
        "上一个文件（深度遍历）": "上一个文件（深度遍历）",
        "上级目录": "上级目录",
        "下一个图片": "下一个图片",
        "下一个文件（同目录深度遍历）": "下一个文件（同目录深度遍历）",
        "下一个文件（深度遍历）": "下一个文件（深度遍历）",
        "下载到本机编辑": "下载到本机编辑",
        "下载原图": "下载原图",
        "下载原图（保存到本地）": "下载原图（保存到本地）",
        "下载原文件，在你本地用 Office/WPS 编辑": "下载原文件，在你本地用 Office/WPS 编辑",
        "下载文件": "下载文件",
        "下载文件 (SVG)": "下载文件 (SVG)",
        "不保存关闭": "不保存关闭",
        "不想手动装？点按钮唤起 AI 助手自动完成检测、安装、验证；也可点弹窗右上角 🤖 手动选帮助点。": "不想手动装？点按钮唤起 AI 助手自动完成检测、安装、验证；也可点弹窗右上角 🤖 手动选帮助点。",
        "主窗口未响应（aiti-cmd 未启用？）": "主窗口未响应（aiti-cmd 未启用？）",
        "主面板已关闭，无法写入输入框": "主面板已关闭，无法写入输入框",
        "主面板已关闭，无法发送": "主面板已关闭，无法发送",
        "二进制文件不接管（交给对应查看器 / 编辑器扩展）": "二进制文件不接管（交给对应查看器 / 编辑器扩展）",
        "二进制文件（只读预览）": "二进制文件（只读预览）",
        "仅浏览器可解码的格式": "仅浏览器可解码的格式",
        "从磁盘重读最新内容（有未保存编辑时会先询问：合并/加载磁盘/保留）": "从磁盘重读最新内容（有未保存编辑时会先询问：合并/加载磁盘/保留）",
        "以编码保存（另存为新编码）": "以编码保存（另存为新编码）",
        "以编码重新打开（不保存当前改动）": "以编码重新打开（不保存当前改动）",
        "作者脚本已剥离（快速态剥 srcdoc／真预览态服务端剥响应）；预览自身的报错回传与链接改道不受影响": "作者脚本已剥离（快速态剥 srcdoc／真预览态服务端剥响应）；预览自身的报错回传与链接改道不受影响",
        "作者脚本执行中（仍无同源能力：fetch/localStorage/读父页 DOM 不可用）": "作者脚本执行中（仍无同源能力：fetch/localStorage/读父页 DOM 不可用）",
        "保存": "保存",
        "保存冲突检测（外部修改 → 409 → 合并或覆盖）": "保存冲突检测（外部修改 → 409 → 合并或覆盖）",
        "保存失败 ({status})": "保存失败 ({status})",
        "保存并关闭": "保存并关闭",
        "保存并刷新": "保存并刷新",
        "保存当前编辑内容（Ctrl+S）": "保存当前编辑内容（Ctrl+S）",
        "保留当前": "保留当前",
        "修改时间": "修改时间",
        "共 {files} 个文件{dirs}": "共 {files} 个文件{dirs}",
        "关于编辑器…": "关于编辑器…",
        "关闭": "关闭",
        "关闭全部": "关闭全部",
        "关闭右侧": "关闭右侧",
        "关闭左侧": "关闭左侧",
        "关闭未保存的文件": "关闭未保存的文件",
        "内容太大，无法复制（超过 1MB）": "内容太大，无法复制（超过 1MB）",
        "内容未加载": "内容未加载",
        "写入剪贴板失败": "写入剪贴板失败",
        "分栏": "分栏",
        "创建终端失败": "创建终端失败",
        "到新会话": "到新会话",
        "到聊天": "到聊天",
        "刷新": "刷新",
        "刷新失败：{msg}": "刷新失败：{msg}",
        "加密 / 带密码压缩包不支持": "加密 / 带密码压缩包不支持",
        "加载磁盘": "加载磁盘",
        "单文件上限 50MB": "单文件上限 50MB",
        "单文件超过 1MB 只读": "单文件超过 1MB 只读",
        "压缩包": "压缩包",
        "压缩包为空": "压缩包为空",
        "压缩包内文件点击提取并打开": "压缩包内文件点击提取并打开",
        "压缩包浏览（纯 JS 优先 + 7-Zip 兜底）": "压缩包浏览（纯 JS 优先 + 7-Zip 兜底）",
        "原生图片查看器": "原生图片查看器",
        "原生视频播放器": "原生视频播放器",
        "原生音频播放器": "原生音频播放器",
        "参数": "参数",
        "取决于浏览器解码器（.mid 多数浏览器不可播）": "取决于浏览器解码器（.mid 多数浏览器不可播）",
        "取决于浏览器解码器（mp4/webm/ogg 系友好；部分 .avi/.mkv 可能无法解码）": "取决于浏览器解码器（mp4/webm/ogg 系友好；部分 .avi/.mkv 可能无法解码）",
        "取消": "取消",
        "取消钉住": "取消钉住",
        "另存为…": "另存为…",
        "另存为（输入完整路径或当前目录下的文件名）：": "另存为（输入完整路径或当前目录下的文件名）：",
        "另存失败 ({status})": "另存失败 ({status})",
        "只读": "只读",
        "只读预览": "只读预览",
        "只读（编辑 / 批注请用专业 PDF 工具）": "只读（编辑 / 批注请用专业 PDF 工具）",
        "只读（解包请用命令行）": "只读（解包请用命令行）",
        "只读：编辑请先另存 / 转换为 .docx（Word）": "只读：编辑请先另存 / 转换为 .docx（Word）",
        "合并": "合并",
        "后台转换为同名 -fromdoc.docx 副本（不覆盖原文件与已有文件）并自动打开": "后台转换为同名 -fromdoc.docx 副本（不覆盖原文件与已有文件）并自动打开",
        "图片": "图片",
        "图片信息": "图片信息",
        "图片加载失败": "图片加载失败",
        "图片预览": "图片预览",
        "在新窗口打开（独立查看窗口）": "在新窗口打开（独立查看窗口）",
        "在服务器的虚拟桌面用 LibreOffice 打开本文件，经浏览器 VNC 远程查看/编辑（需 aiti-ui-env 扩展）": "在服务器的虚拟桌面用 LibreOffice 打开本文件，经浏览器 VNC 远程查看/编辑（需 aiti-ui-env 扩展）",
        "在目录打开": "在目录打开",
        "复制": "复制",
        "复制内容": "复制内容",
        "复制图片到剪贴板（PNG）": "复制图片到剪贴板（PNG）",
        "复制失败": "复制失败",
        "复制文件全部内容到剪贴板（超过 1MB 拒绝）": "复制文件全部内容到剪贴板（超过 1MB 拒绝）",
        "复制路径": "复制路径",
        "多编码打开与保存（UTF-8 / UTF-16 / GBK / Latin-1，含 BOM）": "多编码打开与保存（UTF-8 / UTF-16 / GBK / Latin-1，含 BOM）",
        "大小": "大小",
        "大纲": "大纲",
        "大纲 · {n} 个变更区": "大纲 · {n} 个变更区",
        "仅行尾差异（CRLF/LF），内容一致": "仅行尾差异（CRLF/LF），内容一致",
        "行尾差异": "行尾差异",
        "显示变更大纲（{n} 个变更区）": "显示变更大纲（{n} 个变更区）",
        "隐藏变更大纲": "隐藏变更大纲",
        "无法读取 HEAD 基线（视图与大纲暂不可用）": "无法读取 HEAD 基线（视图与大纲暂不可用）",
        "基线 {ref}（{eol} · {lines} 行 · {bytes}B）· 工作区 {weol} · {wlines} 行": "基线 {ref}（{eol} · {lines} 行 · {bytes}B）· 工作区 {weol} · {wlines} 行",
        "宽度不足，当前自动使用合并视图": "宽度不足，当前自动使用合并视图",
        "定位到下一个 git 变更块（循环）": "定位到下一个 git 变更块（循环）",
        "实时": "实时",
        "实现：": "实现：",
        "实际大小（1）": "实际大小（1）",
        "导出 HTML": "导出 HTML",
        "导出 PDF": "导出 PDF",
        "将当前文件写入聊天输入框": "将当前文件写入聊天输入框",
        "尝试其他编辑器": "尝试其他编辑器",
        "工作区 vs HEAD 有未提交变更（{label}{dirty}）；点击在 最新/左右 视图间切换": "工作区 vs HEAD 有未提交变更（{label}{dirty}）；点击在 最新/左右 视图间切换",
        "左侧编辑·右侧预览": "左侧编辑·右侧预览",
        "左右": "左右",
        "已切换到 {name}": "已切换到 {name}",
        "已切换到 {name}{mode}": "已切换到 {name}{mode}",
        "已创建 {name}，正在打开…": "已创建 {name}，正在打开…",
        "已取消钉住": "已取消钉住",
        "已另存为 {name}": "已另存为 {name}",
        "已同步": "已同步",
        "已唤起 AI 助手并自动发起安装任务——切到 AI 助手弹窗查看进度；装完回本页点「重试转换」。": "已唤起 AI 助手并自动发起安装任务——切到 AI 助手弹窗查看进度；装完回本页点「重试转换」。",
        "已在虚拟环境打开，正在跳转远程查看…": "已在虚拟环境打开，正在跳转远程查看…",
        "已复制": "已复制",
        "已复制上报内容": "已复制上报内容",
        "已复制内容": "已复制内容",
        "已复制到剪贴板": "已复制到剪贴板",
        "已复制路径": "已复制路径",
        "已安装但不在 PATH？配置路径": "已安装但不在 PATH？配置路径",
        "已恢复未保存编辑": "已恢复未保存编辑",
        "已插入输入框，未发送": "已插入输入框，未发送",
        "已移动到 {name} → {dir}": "已移动到 {name} → {dir}",
        "已重命名为 {name}": "已重命名为 {name}",
        "已钉住（不受批量关闭/容量逐出影响）": "已钉住（不受批量关闭/容量逐出影响）",
        "平板 768": "平板 768",
        "并发转换时会提示稍后重试": "并发转换时会提示稍后重试",
        "开始朗读：{name}（{chunks} 块 · 播放条可控）": "开始朗读：{name}（{chunks} 块 · 播放条可控）",
        "当前文件不在遍历清单内，按路径序定位相邻文件（共 {n} 个）": "当前文件不在遍历清单内，按路径序定位相邻文件（共 {n} 个）",
        "当前生效": "当前生效",
        "当前缩放 {pct}%（点击回到 100%）": "当前缩放 {pct}%（点击回到 100%）",
        "当前预览文档：{p}": "当前预览文档：{p}",
        "当前默认（点击无变化）": "当前默认（点击无变化）",
        "快速": "快速",
        "手机 390": "手机 390",
        "打开 Mermaid 查看器": "打开 Mermaid 查看器",
        "打开方式": "打开方式",
        "打开方式（★ = 设为默认）": "打开方式（★ = 设为默认）",
        "打开方式（本文件类型有多个编辑器）": "打开方式（本文件类型有多个编辑器）",
        "打开终端失败 ({status})": "打开终端失败 ({status})",
        "打开终端（当前文件所在目录）": "打开终端（当前文件所在目录）",
        "打开终端（当前文件所在目录；Unix=bash / Windows=PowerShell）": "打开终端（当前文件所在目录；Unix=bash / Windows=PowerShell）",
        "扩展管理器 → aiti-editor → 功能 → 「soffice 路径（LibreOffice）」填入绝对路径（如 /opt/libreoffice/program/soffice），保存后刷新页面重试。": "扩展管理器 → aiti-editor → 功能 → 「soffice 路径（LibreOffice）」填入绝对路径（如 /opt/libreoffice/program/soffice），保存后刷新页面重试。",
        "把当前内容保存为新文件": "把当前内容保存为新文件",
        "把当前文件移到其他目录": "把当前文件移到其他目录",
        "拍摄时间": "拍摄时间",
        "拖拽平移 · 滚轮缩放 · 双击 适应/100%": "拖拽平移 · 滚轮缩放 · 双击 适应/100%",
        "按 1280px 宽度排版（横向可滚）": "按 1280px 宽度排版（横向可滚）",
        "按 390px 宽度排版": "按 390px 宽度排版",
        "按 768px 宽度排版": "按 768px 宽度排版",
        "按列宽对齐光标所在 Markdown 表格（Alt+Shift+F 同款）": "按列宽对齐光标所在 Markdown 表格（Alt+Shift+F 同款）",
        "提及文件——将当前文件写入聊天输入框": "提及文件——将当前文件写入聊天输入框",
        "提取失败": "提取失败",
        "插入 @引用到新会话输入框（不发送）": "插入 @引用到新会话输入框（不发送）",
        "插入 @文件#行 引用到当前会话输入框（不发送）": "插入 @文件#行 引用到当前会话输入框（不发送）",
        "放大": "放大",
        "放大（+）": "放大（+）",
        "文件信息": "文件信息",
        "文件内容为空，无可朗读内容": "文件内容为空，无可朗读内容",
        "文件变化实时同步中——agent 追写内容会自动刷新预览": "文件变化实时同步中——agent 追写内容会自动刷新预览",
        "文件变化实时跟随（watch）": "文件变化实时跟随（watch）",
        "文件名": "文件名",
        "文件已被外部修改，用当前内容覆盖磁盘版本？": "文件已被外部修改，用当前内容覆盖磁盘版本？",
        "新建会话并在输入框插入当前文件的 @ 引用": "新建会话并在输入框插入当前文件的 @ 引用",
        "新文件": "新文件",
        "新文件（相对 HEAD 无基线，整篇均为新增{dirty}）；点击在 最新/左右 视图间切换": "新文件（相对 HEAD 无基线，整篇均为新增{dirty}）；点击在 最新/左右 视图间切换",
        "新文件：相对 HEAD 无基线，整篇均为新增": "新文件：相对 HEAD 无基线，整篇均为新增",
        "新窗口打开原图": "新窗口打开原图",
        "旋转 90°（R）": "旋转 90°（R）",
        "无 EXIF 信息": "无 EXIF 信息",
        "无变更行（工作区与 HEAD 一致，或基线尚未加载）": "无变更行（工作区与 HEAD 一致，或基线尚未加载）",
        "无子目录": "无子目录",
        "无效的 Mermaid 图表": "无效的 Mermaid 图表",
        "无法获取 HEAD 基线": "无法获取 HEAD 基线",
        "无法解析的行（TOML 语法）": "无法解析的行（TOML 语法）",
        "旧格式只读预览（soffice 转 PDF）": "旧格式只读预览（soffice 转 PDF）",
        "旧格式转 PDF 预览": "旧格式转 PDF 预览",
        "时长显示": "时长显示",
        "时间": "时间",
        "暂不支持预览此类型文件": "暂不支持预览此类型文件",
        "更多": "更多",
        "替代方案": "替代方案",
        "最新": "最新",
        "有变更": "有变更",
        "有未保存修改": "有未保存修改",
        "服务器安装 LibreOffice（任选其一）": "服务器安装 LibreOffice（任选其一）",
        "服务器端未检测到 LibreOffice，因此无法把老格式{target}。两个解决方向：在<b>服务器</b>安装并配置 LibreOffice（推荐，装完即可在线转换）；或把文件下载到<b>你本地</b>用 Office 编辑。": "服务器端未检测到 LibreOffice，因此无法把老格式{target}。两个解决方向：在<b>服务器</b>安装并配置 LibreOffice（推荐，装完即可在线转换）；或把文件下载到<b>你本地</b>用 Office 编辑。",
        "朗读失败：{msg}": "朗读失败：{msg}",
        "朗读当前文件（aiti-speek 跟读模式）": "朗读当前文件（aiti-speek 跟读模式）",
        "未保存内容自动缓存（停手 2s + 页面关闭兜底，刷新后恢复）": "未保存内容自动缓存（停手 2s + 页面关闭兜底，刷新后恢复）",
        "未加载": "未加载",
        "未安装可{mode} .{ext} 的扩展": "未安装可{mode} .{ext} 的扩展",
        "未安装可编辑 .{ext} 的扩展": "未安装可编辑 .{ext} 的扩展",
        "未知": "未知",
        "未知原因": "未知原因",
        "未知错误": "未知错误",
        "来自扩展 {src}": "来自扩展 {src}",
        "查看文件大小 / 修改时间等信息": "查看文件大小 / 修改时间等信息",
        "桌面 1280": "桌面 1280",
        "正在加载…": "正在加载…",
        "正在加载压缩包内容…": "正在加载压缩包内容…",
        "正在加载文件内容…": "正在加载文件内容…",
        "正在加载编辑器…": "正在加载编辑器…",
        "正在渲染 Mermaid 图表": "正在渲染 Mermaid 图表",
        "正在获取 HEAD 基线…": "正在获取 HEAD 基线…",
        "正在转换（soffice）…首次约需数秒": "正在转换（soffice）…首次约需数秒",
        "流式播放": "流式播放",
        "浏览": "浏览",
        "浏览器不支持": "浏览器不支持",
        "浏览器内置 PDF 引擎渲染": "浏览器内置 PDF 引擎渲染",
        "浏览器原生 <audio>": "浏览器原生 <audio>",
        "浏览器原生 <iframe>": "浏览器原生 <iframe>",
        "浏览器原生 <img>": "浏览器原生 <img>",
        "浏览器原生 <video>": "浏览器原生 <video>",
        "深度遍历共 {n} 个文件（仅文件，不含文件夹）": "深度遍历共 {n} 个文件（仅文件，不含文件夹）",
        "清空": "清空",
        "渲染页面预览": "渲染页面预览",
        "渲染预览": "渲染预览",
        "点击打开 {name}": "点击打开 {name}",
        "点击打开该目录": "点击打开该目录",
        "点击用此编辑器打开（仅本次）": "点击用此编辑器打开（仅本次）",
        "用当前缓冲重建预览": "用当前缓冲重建预览",
        "目录": "目录",
        "目标文件已存在：\\n{p}\\n覆盖？": "目标文件已存在：\\n{p}\\n覆盖？",
        "相机": "相机",
        "真预览": "真预览",
        "真预览读的是磁盘文件，当前有未保存修改": "真预览读的是磁盘文件，当前有未保存修改",
        "磁盘上的文件已不存在（可能被移动或删除）": "磁盘上的文件已不存在（可能被移动或删除）",
        "磁盘上的文件已被修改": "磁盘上的文件已被修改",
        "票据未就绪或已过期——重开文件或切回「快速」": "票据未就绪或已过期——重开文件或切回「快速」",
        "票据未就绪，真预览暂不可用": "票据未就绪，真预览暂不可用",
        "票据签发失败": "票据签发失败",
        "移动到": "移动到",
        "移动到...": "移动到...",
        "移动到此目录": "移动到此目录",
        "窗口": "窗口",
        "窗口太窄，并排不可读，已用合并视图展示（拉宽窗口恢复并排）": "窗口太窄，并排不可读，已用合并视图展示（拉宽窗口恢复并排）",
        "立即以 steer 发送到当前会话": "立即以 steer 发送到当前会话",
        "等待预览装载…（久候无响应多为脚本出错或资源路径越出预览目录）": "等待预览装载…（久候无响应多为脚本出错或资源路径越出预览目录）",
        "类型": "类型",
        "缓冲 · 未保存可见": "缓冲 · 未保存可见",
        "编码": "编码",
        "编辑": "编辑",
        "编辑器「{name}」未注册内容管线（ContentProvider.write），无法保存": "编辑器「{name}」未注册内容管线（ContentProvider.write），无法保存",
        "编辑器实例未就绪，请稍后再试": "编辑器实例未就绪，请稍后再试",
        "编辑器未返回视图（render 需返回 { el, dispose }）": "编辑器未返回视图（render 需返回 { el, dispose }）",
        "编辑器渲染失败": "编辑器渲染失败",
        "编辑器缓冲直接进 srcdoc：未保存即所见，相对资源走预览路由": "编辑器缓冲直接进 srcdoc：未保存即所见，相对资源走预览路由",
        "编辑模式（当前编辑器具备编辑能力）": "编辑模式（当前编辑器具备编辑能力）",
        "编辑源码": "编辑源码",
        "缩小": "缩小",
        "缩小（-）": "缩小（-）",
        "缩放 / 平移 / 100% 复位": "缩放 / 平移 / 100% 复位",
        "网络错误": "网络错误",
        "老格式（.doc / .ppt / .pptx / .odt / .odp）经 soffice 转 PDF 只读预览": "老格式（.doc / .ppt / .pptx / .odt / .odp）经 soffice 转 PDF 只读预览",
        "能力": "能力",
        "脚本": "脚本",
        "脚本加载失败（网络中断 / 404 / 被拦截），已自动清除加载缓存，可重试；若仍失败请刷新页面": "脚本加载失败（网络中断 / 404 / 被拦截），已自动清除加载缓存，可重试；若仍失败请刷新页面",
        "脚本加载失败：{src}": "脚本加载失败：{src}",
        "自适应": "自适应",
        "虚拟屏启动失败：{msg}": "虚拟屏启动失败：{msg}",
        "虚拟环境准备中…": "虚拟环境准备中…",
        "虚拟环境打开（远程查看）": "虚拟环境打开（远程查看）",
        "虚拟环境打开（重试）": "虚拟环境打开（重试）",
        "虚拟环境打开（需 aiti-ui-env 扩展）": "虚拟环境打开（需 aiti-ui-env 扩展）",
        "行数": "行数",
        "视口宽度预设（只改宽度，不伪造 UA／像素比——设备模拟是 devtools 的活）": "视口宽度预设（只改宽度，不伪造 UA／像素比——设备模拟是 devtools 的活）",
        "视图模式": "视图模式",
        "视频": "视频",
        "解析中…": "解析中…",
        "解析失败": "解析失败",
        "许可：": "许可：",
        "设为 {name} 为默认（持久化）": "设为 {name} 为默认（持久化）",
        "该格式无法复制": "该格式无法复制",
        "语法高亮与补全（40+ 语言，TS/JS 智能提示、JSON 大纲、CSV 彩虹列）": "语法高亮与补全（40+ 语言，TS/JS 智能提示、JSON 大纲、CSV 彩虹列）",
        "调起 aiti-helper 并自动选中「AI 帮我在服务器安装 LibreOffice」帮助点，AI 自动检测平台（Linux/Windows/macOS）、安装并验证": "调起 aiti-helper 并自动选中「AI 帮我在服务器安装 LibreOffice」帮助点，AI 自动检测平台（Linux/Windows/macOS）、安装并验证",
        "超 1MB 只读": "超 1MB 只读",
        "跟随预览区宽度": "跟随预览区宽度",
        "转为 .docx 并打开": "转为 .docx 并打开",
        "转换中…": "转换中…",
        "转换失败": "转换失败",
        "转换失败 ({status})": "转换失败 ({status})",
        "转换失败：{msg}": "转换失败：{msg}",
        "转换成 {label}": "转换成 {label}",
        "转换结果异常（非 PDF）": "转换结果异常（非 PDF）",
        "转换结果按 mtime 键控缓存——二次打开秒开": "转换结果按 mtime 键控缓存——二次打开秒开",
        "转换该文件需要 LibreOffice (soffice)": "转换该文件需要 LibreOffice (soffice)",
        "输入新文件名": "输入新文件名",
        "适应宽度": "适应宽度",
        "适应窗口（0）": "适应窗口（0）",
        "选区写入当前会话输入框，自主决定是否发送": "选区写入当前会话输入框，自主决定是否发送",
        "重命名...": "重命名...",
        "重命名失败": "重命名失败",
        "重新加载": "重新加载",
        "重新拉取磁盘文档（换破缓存参数）": "重新拉取磁盘文档（换破缓存参数）",
        "重试": "重试",
        "重试会自动清除加载缓存；若反复失败请刷新页面（或检查网络）": "重试会自动清除加载缓存；若反复失败请刷新页面（或检查网络）",
        "重试加载": "重试加载",
        "重试转换": "重试转换",
        "钉住": "钉住",
        "链接指向预览目录之外，未改道": "链接指向预览目录之外，未改道",
        "镜头": "镜头",
        "限制": "限制",
        "音频": "音频",
        "预览": "预览",
        "预览 + 编辑": "预览 + 编辑",
        "预览上报 · {n}": "预览上报 · {n}",
        "预览内 console／报错回传（上限 {n} 条，最新在前）": "预览内 console／报错回传（上限 {n} 条，最新在前）",
        "预览模式（{name}）": "预览模式（{name}）",
        "首次打开需数秒（soffice 无头转换）；排版保真取决于 LibreOffice 对原格式的还原度": "首次打开需数秒（soffice 无头转换）；排版保真取决于 LibreOffice 对原格式的还原度",
        "（网络中断 / 404 / 被拦截）": "（网络中断 / 404 / 被拦截）",
        "，{n} 个目录": "，{n} 个目录",
        "，含未保存编辑": "，含未保存编辑",
      },
      // en table: HTML-preview subset first (hand translations); the rest of the zh-CN
      // catalog lands incrementally — cascade falls back to the first table for missing keys.
      "en": {
        "it.file.label": "File",
        "it.image-preview.label": "Image preview",
        "it.image-preview.title": "Image preview",
        "it.fileviewer.label": "Editor",
        "it.fileviewer.title": "aiti-editor: online text/code editing (Monaco), extensible rendering for binaries",
        "ext.displayName": "File Editor",
        "ed.file.label": "File",
        "ed.image.label": "Image preview",
        "HTML 预览": "HTML preview",
        "编辑": "Edit",
        "预览": "Preview",
        "左侧编辑·右侧预览": "Editor left · preview right",
        "分栏": "Split",
        "快速": "Fast",
        "真预览": "Served preview",
        "渲染页面预览": "Rendered page",
        "渲染预览": "Rendered preview",
        "编辑源码": "Edit source",
        "刷新": "Refresh",
        "保存并刷新": "Save & refresh",
        "清空": "Clear",
        "复制": "Copy",
        "复制失败": "Copy failed",
        "已复制上报内容": "Report copied",
        "脚本": "Scripts",
        "●开": "●on",
        "○关": "○off",
        "缓冲 · 未保存可见": "Buffer · unsaved visible",
        "当前预览文档：{p}": "Current preview doc: {p}",
        "预览上报 · {n}": "Preview reports · {n}",
        "预览内 console／报错回传（上限 {n} 条，最新在前）": "In-preview console/error reports (cap {n}, newest first)",
        "票据未就绪或已过期——重开文件或切回「快速」": "Ticket not ready or expired — reopen the file or switch back to Fast",
        "票据未就绪，真预览暂不可用": "Ticket not ready — served preview unavailable",
        "等待预览装载…（久候无响应多为脚本出错或资源路径越出预览目录）": "Waiting for preview… (no response usually means a script error or a resource path outside the preview dir)",
        "链接指向预览目录之外，未改道": "Link points outside the preview dir; not redirected",
        "编辑器缓冲直接进 srcdoc：未保存即所见，相对资源走预览路由": "Editor buffer straight into srcdoc: unsaved-as-seen, relative assets via the preview route",
        "iframe 指向服务端磁盘文档：原生相对解析与站内导航（未保存编辑不可见）": "iframe points to the server-side disk doc: native relative resolution and in-site navigation (unsaved edits not visible)",
        "作者脚本执行中（仍无同源能力：fetch/localStorage/读父页 DOM 不可用）": "Author scripts running (still no same-origin: fetch/localStorage/parent DOM unavailable)",
        "作者脚本已剥离（快速态剥 srcdoc／真预览态服务端剥响应）；预览自身的报错回传与链接改道不受影响": "Author scripts stripped (fast mode strips the srcdoc / served mode strips responses); the preview's own error reporting and link redirect are unaffected",
        "用当前缓冲重建预览": "Rebuild preview from the current buffer",
        "重新拉取磁盘文档（换破缓存参数）": "Re-fetch the disk doc (cache-busting)",
        "真预览读的是磁盘文件，当前有未保存修改": "Served preview reads the disk file; there are unsaved changes",
        "视口宽度预设（只改宽度，不伪造 UA／像素比——设备模拟是 devtools 的活）": "Viewport width presets (width only, no UA/DPR spoofing — device emulation is devtools' job)",
      },
      // zh-TW table: same HTML-preview subset (traditional Chinese).
      "zh-TW": {
        "it.file.label": "檔案",
        "it.image-preview.label": "圖片預覽",
        "it.image-preview.title": "圖片預覽",
        "it.fileviewer.label": "編輯器",
        "it.fileviewer.title": "aiti-editor：文字檔線上編輯（Monaco），二進位可擴充渲染",
        "ext.displayName": "檔案編輯器",
        "ed.file.label": "檔案",
        "ed.image.label": "圖片預覽",
        "HTML 预览": "HTML 預覽",
        "左侧编辑·右侧预览": "左側編輯 · 右側預覽",
        "编辑": "編輯",
        "预览": "預覽",
        "分栏": "分欄",
        "快速": "快速",
        "真预览": "真預覽",
        "渲染页面预览": "渲染頁面",
        "渲染预览": "渲染預覽",
        "编辑源码": "編輯原始碼",
        "刷新": "重新整理",
        "保存并刷新": "儲存並重新整理",
        "清空": "清空",
        "复制": "複製",
        "复制失败": "複製失敗",
        "已复制上报内容": "已複製回報內容",
        "脚本": "腳本",
        "●开": "●開",
        "○关": "○關",
        "缓冲 · 未保存可见": "緩衝 · 未儲存可見",
        "当前预览文档：{p}": "目前預覽文件：{p}",
        "预览上报 · {n}": "預覽回報 · {n}",
        "预览内 console／报错回传（上限 {n} 条，最新在前）": "預覽內 console／錯誤回報（上限 {n} 條，最新在前）",
        "票据未就绪或已过期——重开文件或切回「快速」": "票據未就緒或已過期——重開檔案或切回「快速」",
        "票据未就绪，真预览暂不可用": "票據未就緒，真預覽暫不可用",
        "等待预览装载…（久候无响应多为脚本出错或资源路径越出预览目录）": "等待預覽載入…（久候無反應多為腳本出錯或資源路徑越出預覽目錄）",
        "链接指向预览目录之外，未改道": "連結指向預覽目錄之外，未改道",
        "编辑器缓冲直接进 srcdoc：未保存即所见，相对资源走预览路由": "編輯器緩衝直接進 srcdoc：未儲存即所見，相對資源走預覽路由",
        "iframe 指向服务端磁盘文档：原生相对解析与站内导航（未保存编辑不可见）": "iframe 指向伺服器磁碟文件：原生相對解析與站內導航（未儲存編輯不可見）",
        "作者脚本执行中（仍无同源能力：fetch/localStorage/读父页 DOM 不可用）": "作者腳本執行中（仍無同源能力：fetch/localStorage/讀父頁 DOM 不可用）",
        "作者脚本已剥离（快速态剥 srcdoc／真预览态服务端剥响应）；预览自身的报错回传与链接改道不受影响": "作者腳本已剝離（快速態剝 srcdoc／真預覽態伺服器剝回應）；預覽自身的錯誤回報與連結改道不受影響",
        "用当前缓冲重建预览": "用目前緩衝重建預覽",
        "重新拉取磁盘文档（换破缓存参数）": "重新拉取磁碟文件（換破快取參數）",
        "真预览读的是磁盘文件，当前有未保存修改": "真預覽讀的是磁碟文件，目前有未儲存修改",
        "视口宽度预设（只改宽度，不伪造 UA／像素比——设备模拟是 devtools 的活）": "視窗寬度預設（只改寬度，不偽造 UA／像素比——裝置模擬是 devtools 的活）",
      },
      en: {
        "it.file.label": "Files",
        "it.image-preview.label": "Image preview",
        "it.image-preview.title": "Image preview",
        "it.fileviewer.label": "Editor",
        "it.fileviewer.title": "aiti-editor: online text editing (Monaco); binaries rendered by extensions",
        "ext.displayName": "File Editor",
        "feat.aiti-editor": "Editor",
        "feat.file": "Files",
        "feat.image-preview": "Image preview",
        "feat.editor.text": "Text file editing",
        "feat.soffice.path": "soffice path (LibreOffice)",
        "feat.editor.binary": "Binary file viewer",
        "feat.editor.mdPreviewSmart": "Markdown preview smart click",
        "feat.editor.text.desc": "Takes over text files with the Monaco in-browser editor (falls back to the core read-only viewer when not matched)",
        "feat.soffice.path.desc": "Legacy format conversion (.doc→.docx/.pdf, .xls→.xlsx, .ppt→.pptx); auto-detected when empty",
        "feat.editor.binary.desc": "Renders images/video/audio/PDF and other binary files with registered providers (falls back to the core viewer when off)",
        "feat.editor.mdPreviewSmart.desc": "Clicking a paragraph/heading/code line in the preview pops an action card (copy/quote/new session/file/edit…)",
        "ed.file.label": "Files",
        "ed.image.label": "Image preview",
        " 编辑": " Edit",
        " 适": " fit",
        " 预览": " preview",
        "-副本": "-copy",
        "7za 缺失时自动下载 portable 版（客户机零安装）": "Auto-downloads portable 7za when missing (zero install on the client machine)",
        "AI 帮我安装（推荐）": "AI install for me (recommended)",
        "AI 选区（问 AI / 解释 / 重构 / 新会话）、@ 提及、同目录 ‹› 遍历": "AI selection (ask / explain / refactor / new session), @mentions, same-directory ‹› walk",
        "EXIF 信息读取": "EXIF reading",
        "HTML 编辑 / 分栏 / 预览（快速态看缓冲、真预览态走目录级预览路由；视口预设、报错回传、相对链接改道 dock）": "HTML edit / split / preview (fast mode reads the buffer, true preview goes through the directory-level preview route; viewport presets, error reporting, relative-link redirect into the dock)",
        "HTML 预览": "HTML preview",
        "JSON 值": "JSON value",
        "JSON 键": "JSON key",
        "LibreOffice 启动失败：{msg}": "LibreOffice failed to start: {msg}",
        "Markdown 编辑 / 分栏 / 预览（GFM、TOC、滚动同步、变更块定位、导出 HTML/PDF）": "Markdown edit / split / preview (GFM, TOC, scroll sync, change-block navigation, export to HTML/PDF)",
        "Mermaid 图表": "Mermaid diagram",
        "Monaco 在线文本/代码编辑器（含 Markdown 双模式）": "Monaco online text/code editor (with Markdown dual mode)",
        "Monaco 编辑器加载失败": "Failed to load the Monaco editor",
        "PDF 只读预览": "PDF read-only preview",
        "PDF 只读预览（浏览器原生渲染，可缩放 / 打印 / 下载）": "Read-only PDF preview (browser-native rendering; zoom / print / download)",
        "Range 流式播放（拖进度条不整载）": "Range streaming (seeking doesn't download the whole file)",
        "VNC 会话获取失败": "Failed to get the VNC session",
        "VNC 启动失败：{msg}": "VNC failed to start: {msg}",
        "YAML / TOML / SQL 一键格式化": "One-click YAML / TOML / SQL formatting",
        "aiti-ai-speek 未安装或未启用——已打开扩展管理，请启用后重试": "aiti-ai-speek is not installed or disabled — Extension Manager opened, please enable it and retry",
        "aiti-helper 未就绪（未部署或未加载）：刷新页面后重试，或按上方命令手动安装。": "aiti-helper is not ready (not deployed or not loaded): refresh the page and retry, or install manually with the commands above.",
        "git 变更视图（工作区 vs HEAD：行级标注 / 左右 / 合并 / 大纲）": "git change view (workspace vs HEAD: inline markers / side-by-side / inline / outline)",
        "git 变更视图（工作区 vs HEAD；默认「最新」显示最终版）": "git change view (workspace vs HEAD; default \"Latest\" shows the final version)",
        "iframe 指向服务端磁盘文档：原生相对解析与站内导航（未保存编辑不可见）": "iframe points to the on-disk document: native relative resolution and in-site navigation (unsaved edits not visible)",
        "readFile 失败 ({status})": "readFile failed ({status})",
        "ticket 签发失败": "ticket issuance failed",
        "vendor 加载失败: {p}": "vendor load failed: {p}",
        "zip/tar/7z/rar/cab/iso 等列出清单": "List contents of zip/tar/7z/rar/cab/iso and more",
        "{name}——能力与限制": "{name} — capabilities & limits",
        "{n} 字节": "{n} bytes",
        "{n} 行": "{n} lines",
        "→ 目标目录: {p}": "→ target dir: {p}",
        "⇋ {n} 处改动 · 定位": "⇋ {n} change hunks · jump",
        "○关": "○off",
        "●开": "●on",
        "「虚拟环境打开」在服务器的虚拟桌面上运行 LibreOffice 并经浏览器 VNC 远程查看——适合不想在本地装 Office、且服务器已配置虚拟屏（aiti-ui-env）的场景。": "\"Open in virtual desktop\" runs LibreOffice on the server's virtual desktop and streams it via browser VNC — for when you'd rather not install Office locally and the server has a virtual display (aiti-ui-env) configured.",
        "上一个图片": "Previous image",
        "上一个文件（同目录深度遍历）": "Previous file (same-directory depth walk)",
        "上一个文件（深度遍历）": "Previous file (depth walk)",
        "上级目录": "Parent directory",
        "下一个图片": "Next image",
        "下一个文件（同目录深度遍历）": "Next file (same-directory depth walk)",
        "下一个文件（深度遍历）": "Next file (depth walk)",
        "下载到本机编辑": "Download & edit locally",
        "下载原图": "Download original",
        "下载原图（保存到本地）": "Download original (save locally)",
        "下载原文件，在你本地用 Office/WPS 编辑": "Download the original file and edit it locally with Office/WPS",
        "下载文件": "Download file",
        "下载文件 (SVG)": "Download file (SVG)",
        "不保存关闭": "Close without saving",
        "不想手动装？点按钮唤起 AI 助手自动完成检测、安装、验证；也可点弹窗右上角 🤖 手动选帮助点。": "Rather not install manually? Click the button to have the AI assistant detect, install and verify automatically; or click the 🤖 at the top-right of the dialog to pick a helper point yourself.",
        "主窗口未响应（aiti-cmd 未启用？）": "Main window not responding (aiti-cmd disabled?)",
        "主面板已关闭，无法写入输入框": "Main panel closed, cannot write to the input box",
        "主面板已关闭，无法发送": "Main panel closed, cannot send",
        "二进制文件不接管（交给对应查看器 / 编辑器扩展）": "Binary files not taken over (left to the matching viewer / editor extensions)",
        "二进制文件（只读预览）": "Binary file (read-only preview)",
        "仅浏览器可解码的格式": "Only browser-decodable formats",
        "从磁盘重读最新内容（有未保存编辑时会先询问：合并/加载磁盘/保留）": "Reload latest content from disk (with unsaved edits you'll be asked: merge / load disk / keep mine)",
        "以编码保存（另存为新编码）": "Save with encoding (save as a new encoding)",
        "以编码重新打开（不保存当前改动）": "Reopen with encoding (current edits are not saved)",
        "作者脚本已剥离（快速态剥 srcdoc／真预览态服务端剥响应）；预览自身的报错回传与链接改道不受影响": "Author scripts stripped (fast mode strips srcdoc / true preview strips responses server-side); error reporting and link redirection of the preview itself are unaffected",
        "作者脚本执行中（仍无同源能力：fetch/localStorage/读父页 DOM 不可用）": "Author scripts running (still no same-origin powers: fetch/localStorage/parent DOM are unavailable)",
        "保存": "Save",
        "保存冲突检测（外部修改 → 409 → 合并或覆盖）": "Save conflict detection (external modification → 409 → merge or overwrite)",
        "保存失败 ({status})": "Save failed ({status})",
        "保存并关闭": "Save and close",
        "保存并刷新": "Save and refresh",
        "保存当前编辑内容（Ctrl+S）": "Save current edits (Ctrl+S)",
        "保留当前": "Keep mine",
        "修改时间": "Modified",
        "共 {files} 个文件{dirs}": "{files} files{dirs}",
        "关于编辑器…": "About this editor…",
        "关闭": "Close",
        "关闭全部": "Close all",
        "关闭右侧": "Close right",
        "关闭左侧": "Close left",
        "关闭未保存的文件": "Close unsaved files",
        "内容太大，无法复制（超过 1MB）": "Content too large to copy (over 1MB)",
        "内容未加载": "Content not loaded",
        "写入剪贴板失败": "Failed to write to clipboard",
        "分栏": "Split",
        "创建终端失败": "Failed to create terminal",
        "到新会话": "to new session",
        "到聊天": "to chat",
        "刷新": "Refresh",
        "刷新失败：{msg}": "Refresh failed: {msg}",
        "加密 / 带密码压缩包不支持": "Encrypted / password-protected archives not supported",
        "加载磁盘": "Load from disk",
        "单文件上限 50MB": "50MB per-file limit",
        "单文件超过 1MB 只读": "Read-only above 1MB per file",
        "压缩包": "Archive",
        "压缩包为空": "Archive is empty",
        "压缩包内文件点击提取并打开": "Click an archived file to extract and open it",
        "压缩包浏览（纯 JS 优先 + 7-Zip 兜底）": "Archive browsing (pure JS first, 7-Zip fallback)",
        "原生图片查看器": "Native image viewer",
        "原生视频播放器": "Native video player",
        "原生音频播放器": "Native audio player",
        "参数": "Params",
        "取决于浏览器解码器（.mid 多数浏览器不可播）": "Depends on browser codecs (.mid mostly not playable)",
        "取决于浏览器解码器（mp4/webm/ogg 系友好；部分 .avi/.mkv 可能无法解码）": "Depends on browser codecs (mp4/webm/ogg friendly; some .avi/.mkv may not decode)",
        "取消": "Cancel",
        "取消钉住": "Unpin",
        "另存为…": "Save as…",
        "另存为（输入完整路径或当前目录下的文件名）：": "Save as (enter a full path or a file name in the current directory):",
        "另存失败 ({status})": "Save-as failed ({status})",
        "只读": "Read-only",
        "只读预览": "Read-only preview",
        "只读（编辑 / 批注请用专业 PDF 工具）": "Read-only (use dedicated PDF tools to edit / annotate)",
        "只读（解包请用命令行）": "Read-only (use the command line to unpack)",
        "只读：编辑请先另存 / 转换为 .docx（Word）": "Read-only: to edit, first save-as / convert to .docx (Word)",
        "合并": "Inline",
        "后台转换为同名 -fromdoc.docx 副本（不覆盖原文件与已有文件）并自动打开": "Converts in the background to a same-name -fromdoc.docx copy (original and existing files untouched) and opens it automatically",
        "图片": "Image",
        "图片信息": "Image info",
        "图片加载失败": "Failed to load image",
        "图片预览": "Image preview",
        "在新窗口打开（独立查看窗口）": "Open in new window (standalone viewer)",
        "在服务器的虚拟桌面用 LibreOffice 打开本文件，经浏览器 VNC 远程查看/编辑（需 aiti-ui-env 扩展）": "Opens this file with LibreOffice in the server's virtual desktop, viewed/edited remotely via browser VNC (requires the aiti-ui-env extension)",
        "在目录打开": "Reveal in folder",
        "复制": "Copy",
        "复制内容": "Copy content",
        "复制图片到剪贴板（PNG）": "Copy image to clipboard (PNG)",
        "复制失败": "Copy failed",
        "复制文件全部内容到剪贴板（超过 1MB 拒绝）": "Copy the whole file content to clipboard (rejected over 1MB)",
        "复制路径": "Copy path",
        "多编码打开与保存（UTF-8 / UTF-16 / GBK / Latin-1，含 BOM）": "Multi-encoding open & save (UTF-8 / UTF-16 / GBK / Latin-1, with BOM)",
        "大小": "Size",
        "大纲": "Outline",
        "大纲 · {n} 个变更区": "Outline · {n} change hunks",
        "仅行尾差异（CRLF/LF），内容一致": "Line endings only (CRLF/LF); content is identical",
        "行尾差异": "EOL difference",
        "显示变更大纲（{n} 个变更区）": "Show change outline ({n} hunks)",
        "隐藏变更大纲": "Hide change outline",
        "无法读取 HEAD 基线（视图与大纲暂不可用）": "Cannot read the HEAD baseline (change view and outline are unavailable)",
        "基线 {ref}（{eol} · {lines} 行 · {bytes}B）· 工作区 {weol} · {wlines} 行": "Baseline {ref} ({eol} · {lines} lines · {bytes}B) · Worktree {weol} · {wlines} lines",
        "宽度不足，当前自动使用合并视图": "Not enough width; inline view is used automatically",
        "定位到下一个 git 变更块（循环）": "Jump to next git change block (loops)",
        "实时": "Live",
        "实现：": "Implementation: ",
        "实际大小（1）": "Actual size (1)",
        "导出 HTML": "Export HTML",
        "导出 PDF": "Export PDF",
        "将当前文件写入聊天输入框": "Write the current file into the chat input box",
        "尝试其他编辑器": "Try another editor",
        "工作区 vs HEAD 有未提交变更（{label}{dirty}）；点击在 最新/左右 视图间切换": "Workspace vs HEAD has uncommitted changes ({label}{dirty}); click to toggle Latest / Side-by-side",
        "左侧编辑·右侧预览": "Editor left · preview right",
        "左右": "Side-by-side",
        "已切换到 {name}": "Switched to {name}",
        "已切换到 {name}{mode}": "Switched to {name}{mode}",
        "已创建 {name}，正在打开…": "Created {name}, opening…",
        "已取消钉住": "Unpinned",
        "已另存为 {name}": "Saved as {name}",
        "已同步": "Synced",
        "已唤起 AI 助手并自动发起安装任务——切到 AI 助手弹窗查看进度；装完回本页点「重试转换」。": "AI assistant invoked and the install task has started — switch to the AI assistant dialog to follow progress; come back here and click \"Retry conversion\" once done.",
        "已在虚拟环境打开，正在跳转远程查看…": "Opened in the virtual desktop; redirecting to remote view…",
        "已复制": "Copied",
        "已复制上报内容": "Report content copied",
        "已复制内容": "Content copied",
        "已复制到剪贴板": "Copied to clipboard",
        "已复制路径": "Path copied",
        "已安装但不在 PATH？配置路径": "Installed but not on PATH? Configure the path",
        "已恢复未保存编辑": "Unsaved edits restored",
        "已插入输入框，未发送": "Inserted into the input box, not sent",
        "已移动到 {name} → {dir}": "Moved {name} → {dir}",
        "已重命名为 {name}": "Renamed to {name}",
        "已钉住（不受批量关闭/容量逐出影响）": "Pinned (excluded from bulk close and capacity eviction)",
        "平板 768": "Tablet 768",
        "并发转换时会提示稍后重试": "Concurrent conversions ask you to retry later",
        "开始朗读：{name}（{chunks} 块 · 播放条可控）": "Reading aloud: {name} ({chunks} chunks · playback bar available)",
        "当前文件不在遍历清单内，按路径序定位相邻文件（共 {n} 个）": "Current file is not in the walk list; adjacent files located by path order ({n} total)",
        "当前生效": "Currently active",
        "当前缩放 {pct}%（点击回到 100%）": "Zoom {pct}% (click to reset to 100%)",
        "当前预览文档：{p}": "Current preview doc: {p}",
        "当前默认（点击无变化）": "Current default (click does nothing)",
        "快速": "Fast",
        "手机 390": "Phone 390",
        "打开 Mermaid 查看器": "Open Mermaid viewer",
        "打开方式": "Open with",
        "打开方式（★ = 设为默认）": "Open with (★ = set default)",
        "打开方式（本文件类型有多个编辑器）": "Open with (multiple editors for this file type)",
        "打开终端失败 ({status})": "Failed to open terminal ({status})",
        "打开终端（当前文件所在目录）": "Open terminal (current file's directory)",
        "打开终端（当前文件所在目录；Unix=bash / Windows=PowerShell）": "Open terminal (current file's directory; Unix=bash / Windows=PowerShell)",
        "扩展管理器 → aiti-editor → 功能 → 「soffice 路径（LibreOffice）」填入绝对路径（如 /opt/libreoffice/program/soffice），保存后刷新页面重试。": "Extension Manager → aiti-editor → Features → \"soffice path (LibreOffice)\": fill in the absolute path (e.g. /opt/libreoffice/program/soffice), save, then refresh the page and retry.",
        "把当前内容保存为新文件": "Save the current content as a new file",
        "把当前文件移到其他目录": "Move the current file to another directory",
        "拍摄时间": "Taken",
        "拖拽平移 · 滚轮缩放 · 双击 适应/100%": "Drag to pan · wheel to zoom · double-click fit/100%",
        "按 1280px 宽度排版（横向可滚）": "Laid out at 1280px width (horizontally scrollable)",
        "按 390px 宽度排版": "Laid out at 390px width",
        "按 768px 宽度排版": "Laid out at 768px width",
        "按列宽对齐光标所在 Markdown 表格（Alt+Shift+F 同款）": "Align the Markdown table at the cursor by column width (same as Alt+Shift+F)",
        "提及文件——将当前文件写入聊天输入框": "Mention file — write the current file into the chat input box",
        "提取失败": "Extraction failed",
        "插入 @引用到新会话输入框（不发送）": "Insert an @mention into a new session input box (not sent)",
        "插入 @文件#行 引用到当前会话输入框（不发送）": "Insert an @file#line reference into the current session input box (not sent)",
        "放大": "Zoom in",
        "放大（+）": "Zoom in (+)",
        "文件信息": "File info",
        "文件内容为空，无可朗读内容": "File is empty, nothing to read aloud",
        "文件变化实时同步中——agent 追写内容会自动刷新预览": "File changes sync live — content appended by the agent refreshes the preview automatically",
        "文件变化实时跟随（watch）": "Follows file changes live (watch)",
        "文件名": "File name",
        "文件已被外部修改，用当前内容覆盖磁盘版本？": "File was modified externally. Overwrite the on-disk version with the current content?",
        "新建会话并在输入框插入当前文件的 @ 引用": "Create a new session and insert an @reference to the current file in its input box",
        "新文件": "New file",
        "新文件（相对 HEAD 无基线，整篇均为新增{dirty}）；点击在 最新/左右 视图间切换": "New file (no HEAD baseline, everything counts as added{dirty}); click to toggle Latest / Side-by-side",
        "新文件：相对 HEAD 无基线，整篇均为新增": "New file: no HEAD baseline, everything counts as added",
        "新窗口打开原图": "Open original in new window",
        "旋转 90°（R）": "Rotate 90° (R)",
        "无 EXIF 信息": "No EXIF data",
        "无变更行（工作区与 HEAD 一致，或基线尚未加载）": "No changed lines (workspace matches HEAD, or baseline not loaded yet)",
        "无子目录": "No subdirectories",
        "无效的 Mermaid 图表": "Invalid Mermaid diagram",
        "无法获取 HEAD 基线": "Failed to get HEAD baseline",
        "无法解析的行（TOML 语法）": "Unparseable line (TOML syntax)",
        "旧格式只读预览（soffice 转 PDF）": "Legacy-format read-only preview (soffice → PDF)",
        "旧格式转 PDF 预览": "Legacy format → PDF preview",
        "时长显示": "Duration display",
        "时间": "Time",
        "暂不支持预览此类型文件": "Preview is not supported for this file type yet",
        "更多": "More",
        "替代方案": "Alternatives",
        "最新": "Latest",
        "有变更": "Changed",
        "有未保存修改": "Unsaved changes",
        "服务器安装 LibreOffice（任选其一）": "Install LibreOffice on the server (pick any one)",
        "服务器端未检测到 LibreOffice，因此无法把老格式{target}。两个解决方向：在<b>服务器</b>安装并配置 LibreOffice（推荐，装完即可在线转换）；或把文件下载到<b>你本地</b>用 Office 编辑。": "LibreOffice was not detected on the server, so the legacy format{target} cannot be converted. Two options: install and configure LibreOffice on the <b>server</b> (recommended — enables online conversion once done); or download the file to <b>your machine</b> and edit it with Office.",
        "朗读失败：{msg}": "Read-aloud failed: {msg}",
        "朗读当前文件（aiti-speek 跟读模式）": "Read the current file aloud (aiti-speek follow mode)",
        "未保存内容自动缓存（停手 2s + 页面关闭兜底，刷新后恢复）": "Unsaved content auto-cached (2s idle + page-close fallback; restored after refresh)",
        "未加载": "Not loaded",
        "未安装可{mode} .{ext} 的扩展": "No extension capable of {mode} .{ext} installed",
        "未安装可编辑 .{ext} 的扩展": "No extension capable of editing .{ext} installed",
        "未知": "unknown",
        "未知原因": "unknown reason",
        "未知错误": "unknown error",
        "来自扩展 {src}": "from extension {src}",
        "查看文件大小 / 修改时间等信息": "View file size / modified time and other details",
        "桌面 1280": "Desktop 1280",
        "正在加载…": "Loading…",
        "正在加载压缩包内容…": "Loading archive contents…",
        "正在加载文件内容…": "Loading file content…",
        "正在加载编辑器…": "Loading editor…",
        "正在渲染 Mermaid 图表": "Rendering Mermaid diagram",
        "正在获取 HEAD 基线…": "Getting HEAD baseline…",
        "正在转换（soffice）…首次约需数秒": "Converting (soffice)… first run takes a few seconds",
        "流式播放": "Streaming playback",
        "浏览": "Browse",
        "浏览器不支持": "Browser not supported",
        "浏览器内置 PDF 引擎渲染": "Rendered by the browser's built-in PDF engine",
        "浏览器原生 <audio>": "Browser-native <audio>",
        "浏览器原生 <iframe>": "Browser-native <iframe>",
        "浏览器原生 <img>": "Browser-native <img>",
        "浏览器原生 <video>": "Browser-native <video>",
        "深度遍历共 {n} 个文件（仅文件，不含文件夹）": "Depth walk: {n} files (files only, no folders)",
        "清空": "Clear",
        "渲染页面预览": "Rendered page preview",
        "渲染预览": "Rendered preview",
        "点击打开 {name}": "Click to open {name}",
        "点击打开该目录": "Click to open this directory",
        "点击用此编辑器打开（仅本次）": "Click to open with this editor (this time only)",
        "用当前缓冲重建预览": "Rebuild the preview from the current buffer",
        "目录": "Directory",
        "目标文件已存在：\\n{p}\\n覆盖？": "Target file already exists:\\n{p}\\nOverwrite?",
        "相机": "Camera",
        "真预览": "True preview",
        "真预览读的是磁盘文件，当前有未保存修改": "True preview reads the on-disk file; there are unsaved edits",
        "磁盘上的文件已不存在（可能被移动或删除）": "The file on disk no longer exists (moved or deleted)",
        "磁盘上的文件已被修改": "The file on disk has been modified",
        "票据未就绪或已过期——重开文件或切回「快速」": "Ticket not ready or expired — reopen the file or switch back to \"Fast\"",
        "票据未就绪，真预览暂不可用": "Ticket not ready; true preview unavailable for now",
        "票据签发失败": "Ticket issuance failed",
        "移动到": "Move to",
        "移动到...": "Move to...",
        "移动到此目录": "Move to this directory",
        "窗口": "Window",
        "窗口太窄，并排不可读，已用合并视图展示（拉宽窗口恢复并排）": "Window too narrow for side-by-side; shown as inline view (widen the window to restore side-by-side)",
        "立即以 steer 发送到当前会话": "Send to the current session as steer immediately",
        "等待预览装载…（久候无响应多为脚本出错或资源路径越出预览目录）": "Waiting for the preview to load… (no response usually means a script error or a resource path escaping the preview directory)",
        "类型": "Type",
        "缓冲 · 未保存可见": "Buffer · unsaved visible",
        "编码": "Encoding",
        "编辑": "Edit",
        "编辑器「{name}」未注册内容管线（ContentProvider.write），无法保存": "Editor \"{name}\" has no content pipeline registered (ContentProvider.write); cannot save",
        "编辑器实例未就绪，请稍后再试": "Editor instance not ready, try again shortly",
        "编辑器未返回视图（render 需返回 { el, dispose }）": "Editor returned no view (render must return { el, dispose })",
        "编辑器渲染失败": "Editor render failed",
        "编辑器缓冲直接进 srcdoc：未保存即所见，相对资源走预览路由": "Editor buffer goes straight into srcdoc: what you see is what's unsaved; relative resources go through the preview route",
        "编辑模式（当前编辑器具备编辑能力）": "Edit mode (current editor has edit capability)",
        "编辑源码": "Edit source",
        "缩小": "Zoom out",
        "缩小（-）": "Zoom out (-)",
        "缩放 / 平移 / 100% 复位": "Zoom / pan / reset to 100%",
        "网络错误": "Network error",
        "老格式（.doc / .ppt / .pptx / .odt / .odp）经 soffice 转 PDF 只读预览": "Legacy formats (.doc / .ppt / .pptx / .odt / .odp) converted to read-only PDF preview via soffice",
        "能力": "Capabilities",
        "脚本": "Scripts",
        "脚本加载失败（网络中断 / 404 / 被拦截），已自动清除加载缓存，可重试；若仍失败请刷新页面": "Script load failed (network interruption / 404 / blocked); the load cache has been cleared automatically and you can retry; if it still fails, refresh the page",
        "脚本加载失败：{src}": "Script load failed: {src}",
        "自适应": "Auto",
        "虚拟屏启动失败：{msg}": "Virtual display failed to start: {msg}",
        "虚拟环境准备中…": "Preparing virtual desktop…",
        "虚拟环境打开（远程查看）": "Open in virtual desktop (remote view)",
        "虚拟环境打开（重试）": "Open in virtual desktop (retry)",
        "虚拟环境打开（需 aiti-ui-env 扩展）": "Open in virtual desktop (requires aiti-ui-env)",
        "行数": "Lines",
        "视口宽度预设（只改宽度，不伪造 UA／像素比——设备模拟是 devtools 的活）": "Viewport width presets (width only, no fake UA/pixel ratio — device emulation is devtools' job)",
        "视图模式": "View mode",
        "视频": "Video",
        "解析中…": "Parsing…",
        "解析失败": "Parse failed",
        "许可：": "License: ",
        "设为 {name} 为默认（持久化）": "Set {name} as default (persisted)",
        "该格式无法复制": "This format cannot be copied",
        "语法高亮与补全（40+ 语言，TS/JS 智能提示、JSON 大纲、CSV 彩虹列）": "Syntax highlighting & completion (40+ languages; TS/JS intellisense, JSON outline, CSV rainbow columns)",
        "调起 aiti-helper 并自动选中「AI 帮我在服务器安装 LibreOffice」帮助点，AI 自动检测平台（Linux/Windows/macOS）、安装并验证": "Invokes aiti-helper and auto-selects the \"AI: install LibreOffice on the server\" helper point; the AI detects the platform (Linux/Windows/macOS), installs and verifies automatically",
        "超 1MB 只读": "Read-only over 1MB",
        "跟随预览区宽度": "Follow the preview area width",
        "转为 .docx 并打开": "Convert to .docx and open",
        "转换中…": "Converting…",
        "转换失败": "Conversion failed",
        "转换失败 ({status})": "Conversion failed ({status})",
        "转换失败：{msg}": "Conversion failed: {msg}",
        "转换成 {label}": " be converted into {label}",
        "转换结果异常（非 PDF）": "Conversion result is abnormal (not a PDF)",
        "转换结果按 mtime 键控缓存——二次打开秒开": "Conversion results cached by mtime — second open is instant",
        "转换该文件需要 LibreOffice (soffice)": "Converting this file requires LibreOffice (soffice)",
        "输入新文件名": "Enter the new file name",
        "适应宽度": "Fit width",
        "适应窗口（0）": "Fit window (0)",
        "选区写入当前会话输入框，自主决定是否发送": "Write the selection into the current session input box; you decide whether to send",
        "重命名...": "Rename...",
        "重命名失败": "Rename failed",
        "重新加载": "Reload",
        "重新拉取磁盘文档（换破缓存参数）": "Re-fetch the on-disk document (cache-busting param)",
        "重试": "Retry",
        "重试会自动清除加载缓存；若反复失败请刷新页面（或检查网络）": "Retrying clears the load cache automatically; if it keeps failing, refresh the page (or check the network)",
        "重试加载": "Retry load",
        "重试转换": "Retry conversion",
        "钉住": "Pin",
        "链接指向预览目录之外，未改道": "Link points outside the preview directory; not redirected",
        "镜头": "Lens",
        "限制": "Limits",
        "音频": "Audio",
        "预览": "Preview",
        "预览 + 编辑": "Preview + Edit",
        "预览上报 · {n}": "Preview reports · {n}",
        "预览内 console／报错回传（上限 {n} 条，最新在前）": "console/errors reported from the preview (cap {n}, newest first)",
        "预览模式（{name}）": "Preview mode ({name})",
        "首次打开需数秒（soffice 无头转换）；排版保真取决于 LibreOffice 对原格式的还原度": "First open takes a few seconds (headless soffice conversion); layout fidelity depends on LibreOffice's support for the original format",
        "（网络中断 / 404 / 被拦截）": "(network interruption / 404 / blocked)",
        "，{n} 个目录": ", {n} directories",
        "，含未保存编辑": ", including unsaved edits",
      },
    },

  },
  features: [
    { id: "editor.text", label: "文本文件编辑", description: "接管文本类文件为 Monaco 在线编辑器（未命中时回退核心只读查看器）", default: true },
    { id: "soffice.path", type: "string", label: "soffice 路径（LibreOffice）", default: "",
      placeholder: "留空=自动从 PATH 查找；或填绝对路径如 /usr/bin/soffice",
      description: "老格式转换（.doc→.docx/.pdf、.xls→.xlsx、.ppt→.pptx）所用 soffice 可执行文件路径", group: "转换" },
    { id: "editor.binary", label: "二进制文件查看", description: "使用注册的 provider 渲染图片/视频/音频/PDF 等二进制文件（关闭后回退核心查看器）", default: true },
    { id: "editor.mdPreviewSmart", label: "Markdown 预览智能点击", description: "预览里点击段落/标题/代码行弹出动作卡（复制/引用/新会话/文件/链接），引用自动带 @文件#行号；需安装并启用 aiti-msg-smart", default: true },
  ],
  server: {
    startup(ctx: any) {
      if (ctx.configDir) configDir = ctx.configDir;
      setSofficeDataDir(configDir); // soffice 定位：features.json 在 configDir 上级
      // 暴露 registerFileProvider 给其他扩展（通过 ctx 传递）
      (ctx as any).registerFileProvider = registerFileProvider;
      bindHostFileAccess(ctx); // 宿主 allowed-roots 门禁（resolveAllowedWrite 用）
      console.log("[aiti-editor] 就绪 · configDir=" + configDir + " · fileProviders=" + _aitiFileProviders.length + " · hostFileAccess=" + (_hostIsAllowed ? "on" : "off"));
    },
    async api(req: Request, ctx: any) {
      bindHostFileAccess(ctx); // 惰性兑底绑定（startup 前到达的请求/reload 场景）
      const u = new URL(req.url);
      let p = u.pathname.split("/").filter(Boolean);
      // GET /prefs → 全量偏好；PUT /prefs → 增量合并写回（M0 §1.4a；无路径参数，不需票据）
      if (p[p.length - 1] === "prefs" && req.method === "GET") {
        return json({ ok: true, prefs: readPrefs() });
      }
      if (p[p.length - 1] === "prefs" && req.method === "PUT") {
        const body = await req.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json({ ok: false, error: "body 需为对象（{ \".ext\": \"providerId\" }）" }, 400);
        }
        const cur = readPrefs();
        for (const [k, v] of Object.entries(body)) {
          if (!/^\.[a-z0-9]{1,16}$/i.test(k)) return json({ ok: false, error: "非法偏好键（需为 .ext）: " + k }, 400);
          if (typeof v !== "string" || v.length === 0 || v.length > 200) return json({ ok: false, error: "非法偏好值: " + String(v) }, 400);
          cur[k] = v;
        }
        try {
          writePrefsAtomic(cur);
        } catch (e) {
          return json({ ok: false, error: "偏好写盘失败: " + String((e as Error).message || e) }, 500);
        }
        return json({ ok: true, prefs: cur });
      }
      // ── GET /preview/<ticket>/<rel…> → HTML 预览服务态（方案 docs/aiti-editor-html-preview-plan.md §3.2）
      //   票据入口文件所在目录 = 预览命名空间根（相对资源/多页导航靠它天然解析）；
      //   文档响应带 CSP sandbox（文档落 opaque origin，读不到 pi-web 任何东西）+ 注入上报 shim。
      // 路由锚点从左往右取首个 `aiti-editor/preview` 段对：扩展自身前缀必在用户可控段之前；
      // 用 lastIndexOf 会被「相对路径里正好有同名目录」的合法请求抢走（ticket 认不出来 → 403）
      let extIdx = -1;
      for (let i = 1; i < p.length - 1; i++) { if (p[i] === "aiti-editor" && p[i + 1] === "preview") { extIdx = i; break; } }
      if (req.method === "GET" && extIdx >= 0 && p.length >= extIdx + 3) {
        const ticket = p[extIdx + 2];
        const rec = redeemEditorTicket(ticket);
        if (!rec) return json({ ok: false, error: "ticket 无效或已过期" }, 403);
        // rel 保持 URL 原样（不解码）：解码统一在 resolvePreviewTarget 内做一次；
        // 目录根（`…/preview/<ticket>/`）= 票据绑定的入口文档，见 previewRelOrEntry
        const r = resolvePreviewTarget(rec.fp, previewRelOrEntry(rec.fp, p.slice(extIdx + 3).join("/")));
        if (!r.ok) return json({ ok: false, error: r.error }, r.status);
        if (!(await resolveAllowedWrite(r.target))) return json({ ok: false, error: "路径不在白名单内" }, 403);
        let pst: any;
        try { pst = statSync(r.target); } catch { return json({ ok: false, error: "资源不存在" }, 404); }
        if (!pst.isFile()) return json({ ok: false, error: "目标不是文件" }, 404);
        if (pst.size > PREVIEW_MAX_BYTES) return json({ ok: false, error: "预览资源超过 20MB" }, 413);
        const scripts = u.searchParams.get("noscript") !== "1";
        const base = previewBaseFromSegments(p, extIdx + 2);
        const safeHeaders: Record<string, string> = {
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex",
          "referrer-policy": "no-referrer",
        };
        if (isPreviewDoc(r.ext)) {
          // 「脚本关」= 剥掉**作者**脚本，不是 CSP 零授权：后者会把自己的上报 shim 一起杀掉
          //（报错回传/链接改道/装载判定全失效）。边界仍是 opaque origin（sandbox 恒在）。
          if (pst.size <= PREVIEW_DOC_MAX_BYTES) {
            const buf = readFileSync(r.target); // 限量守卫在上一行（红线：>8MB 禁同步读）
            const enc = detectEncoding(buf);
            const doc = servePreviewDoc(decodeText(buf, enc.encoding, enc.hasBOM), {
              base,
              docRel: relative(dirname(rec.fp), r.target).split(sep).join("/"),
              scripts,
            });
            safeHeaders["content-security-policy"] = previewCsp(true); // 注入即恒带 allow-scripts（shim 要跑；作者脚本已按开关剥离）
            return new Response(doc.body, {
              status: 200,
              headers: {
                "content-type": previewMimeOf(r.ext),
                "cache-control": "no-store", // 文档含注入脚本，ETag 无意义——每次取最新（保存后刷新即见）
                "content-disposition": "inline",
                ...safeHeaders,
              },
            });
          }
          safeHeaders["content-security-policy"] = previewCsp(false); // 超限不注入：无 shim 可留，整篇裸 sandbox
        }
        return serveFileDefault(r.target, r.ext, req, { mime: previewMimeOf(r.ext), headers: safeHeaders });
      }
      // 路径票据兑换：/t/<ticket>/<endpoint> → 兑换出 filePath/root，路径不进 URL（安全基线）
      let tFp = "", tRoot = "";
      if (p.length >= 3 && p[p.length - 3] === "t") {
        const rec = redeemEditorTicket(p[p.length - 2]);
        if (!rec) return json({ ok: false, error: "ticket 无效或已过期" }, 403);
        tFp = rec.fp; tRoot = rec.root;
        p = [...p.slice(0, -3), p[p.length - 1]];
      }
      // POST /ticket {filePath, root?} → 签发路径票据（root 供 siblings/ts-siblings 等双路径端点）
      if (p[p.length - 1] === "ticket" && req.method === "POST") {
        const body = await req.json().catch(() => null) as { filePath?: unknown; root?: unknown; wantWatch?: unknown } | null;
        const fp = typeof body?.filePath === "string" ? body.filePath : "";
        if (!fp || !(await resolveAllowedWrite(fp))) return json({ ok: false, error: "路径不在白名单内" }, 400);
        let root = "";
        if (typeof body?.root === "string" && body.root) {
          if (!(await resolveAllowedWrite(body.root))) return json({ ok: false, error: "root 不在白名单内" }, 400);
          root = body.root;
        }
        const out: any = { ok: true, ticket: issueEditorTicket(fp, root), expiresIn: 3600 };
        if (body?.wantWatch === true) {
          const watchId = "ew-" + randomBytes(12).toString("hex");
          startEditorWatch(watchId, (await resolveAllowedWrite(fp)) as string);
          out.watchId = watchId;
        }
        return json(out);
      }
      // GET /stat?filePath=… → 当前 mtimeMs/size（保存冲突检测用；meta 接口不含 mtimeMs）
      if (p[p.length - 1] === "stat" && req.method === "GET") {
        const fp = tFp;
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        try {
          const st = statSync(target);
          if (!st.isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
          return json({ ok: true, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          return json({ ok: false, error: "文件不存在" }, 404);
        }
      }
      // GET /git-changes?filePath= → 工作区 vs HEAD 变更探测（打开文件时；快速、不传内容）
      //   返回 { isRepo, changed, status: M|A|D|R, adds, dels, label }；不在仓库/git 不可用 → changed:false
      if (p[p.length - 1] === "git-changes" && req.method === "GET") {
        const fp = tFp; // 路径来自票据（不进 URL）
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        try {
          if (!statSync(target).isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
        } catch { return json({ ok: false, error: "文件不存在" }, 404); }
        const info = await gitFileInfo(target);
        return json({ ok: true, isRepo: !!info.repo, changed: info.changed, status: info.status,
          adds: info.adds ?? null, dels: info.dels ?? null, worktreeEol: fileEolKind(target),
          label: info.status ? (GIT_CHANGE_LABEL[info.status] || "有变更") : undefined });
      }
      // GET /git-base?filePath= → HEAD 基线文本（diff 视图按需懒加载；rename 用旧路径取）
      //   HEAD 无此文件（新增/untracked/空仓库）→ original=""（按全新文件对比）
      if (p[p.length - 1] === "git-base" && req.method === "GET") {
        const fp = tFp; // 路径来自票据（不进 URL）
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        try {
          if (!statSync(target).isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
        } catch { return json({ ok: false, error: "文件不存在" }, 404); }
        const info = await gitFileInfo(target);
        if (!info.repo) return json({ ok: false, error: "不在 git 仓库内" }, 404);
        const gb = await gitRunBuf(info.repo, ["show", "HEAD:" + (info.oldPath || info.rel)]);
        if (!gb.ok) return json({ ok: true, original: "", base: "（无 HEAD 基线，按全新文件对比）",
          hasBaseline: false, baselineEol: "none", baselineBytes: 0, baselineLines: 0 });
        if (gb.buf.length > 6 * 1024 * 1024) return json({ ok: false, error: "HEAD 版本超过 6MB，不支持内置对比（可用 aiti-git-review 查看）" }, 413);
        // 按字节探测编码解码（与 /raw 同一管线）：GBK/UTF-16 基线不再乱码，diff 才有意义
        const enc = detectEncoding(gb.buf);
        const original = decodeText(gb.buf, enc.encoding, enc.hasBOM);
        return json({ ok: true, original, base: "HEAD", hasBaseline: true,
          baselineEol: textEolKind(original), baselineBytes: gb.buf.length,
          baselineLines: original ? original.split("\n").length - (original.endsWith("\n") ? 1 : 0) : 0 });
      }
      // GET /siblings?filePath=…&root=… → 深度遍历文件清单（仅文件，不含目录；‹ › 上下篇切换用）
      //   深度优先 + 同层按名称排序；仅排除 .git/node_modules；上限 MAX_SIBLINGS 防失控。
      //   root 可把遍历根提升到祖先目录（如项目根）：必须是指定文件的祖先且在白名单内。
      if (p[p.length - 1] === "siblings" && (req.method === "GET" || req.method === "POST")) {
        const fp = tFp; // 路径来自票据（不进 URL）
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        let rootParam = tRoot;
        if (req.method === "POST") {
          // root 由 body 传入（同样是路径，不进 URL）；仍走白名单校验
          const body = await req.json().catch(() => null) as { root?: unknown } | null;
          if (typeof body?.root === "string") rootParam = body.root;
        }
        try {
          if (!statSync(target).isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
          let rootDir = dirname(target);
          if (rootParam) {
            const r = await resolveAllowedWrite(rootParam);
            if (r && statSync(r).isDirectory() && (target === r || target.startsWith(r + sep))) rootDir = r;
          }
          const SKIP_DIRS = new Set([".git", "node_modules"]);
          const MAX_SIBLINGS = 5000;
          const out: string[] = [];
          const walk = (dir: string, depth: number): void => {
            if (out.length >= MAX_SIBLINGS || depth > 24) return;
            let ents: any[];
            try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
            ents.sort((a, b) => a.name.localeCompare(b.name));
            for (const ent of ents) {
              if (out.length >= MAX_SIBLINGS) return;
              if (ent.isSymbolicLink()) continue; // 不跟随软链：防环
              if (ent.isDirectory()) {
                if (!SKIP_DIRS.has(ent.name)) walk(join(dir, ent.name), depth + 1); // 含隐藏目录（.claude 等），仅排除 .git/node_modules
              } else if (ent.isFile()) {
                out.push(join(dir, ent.name));
              }
            }
          };
          walk(rootDir, 0);
          return json({ ok: true, dir: rootDir, files: out, truncated: out.length >= MAX_SIBLINGS });
        } catch {
          return json({ ok: false, error: "目录读取失败" }, 404);
        }
      }
      // POST /rename { filePath, newName } → fs.renameSync
      // ── 编辑缓存持久化（服务端目录，刷新不丢）──
      const cacheDir = ensureCacheDir();

      // POST /cache-write { filePath, strategy:"content"|"diff", content?, diff?, original?, baseMtimeMs, contentHash?, history? }
      // → 存完整内容 + 内容哈希 + 历史版本（多开版本比对）\
      //    strategy=content：覆盖全部（含 original 基线）；strategy=diff：保留旧 original，只更新 diff
      if (p[p.length - 1] === "cache-write" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const filePath = typeof body?.filePath === "string" ? body.filePath : "";
        const strategy = body?.strategy === "diff" ? "diff" : "content";
        const content = typeof body?.content === "string" ? body.content : null;
        const diff = typeof body?.diff === "string" ? body.diff : null;
        const original = typeof body?.original === "string" ? body.original : null;
        const baseMtimeMs = typeof body?.baseMtimeMs === "number" ? body.baseMtimeMs : 0;
        const contentHash = typeof body?.contentHash === "string" ? body.contentHash : "";
        const history = Array.isArray(body?.history) ? body.history : [];
        if (!filePath) return json({ ok: false, error: "需要 filePath" }, 400);
        try {
          // 缓存键按展开后的绝对路径规范化：~/x 与 /home/pi/x 同一文件只存一份（ts-siblings 读侧用展开路径查）
          const canonical = expandTildePath(filePath);
          const cacheFile = join(cacheDir, cacheName(canonical));
          let data: any = { filePath: canonical, baseMtimeMs, contentHash, history, storedAt: Date.now() };
          if (strategy === "diff") {
            // 只更新 diff，保留已有 original 基线
            if (!diff) return json({ ok: false, error: "strategy=diff 时需要 diff" }, 400);
            let prev: any = {};
            try { prev = JSON.parse(readFileSync(cacheFile, "utf8")); } catch {}
            data.strategy = "diff";
            data.diff = diff;
            data.original = prev.original || original || ""; // 保留基线（第一次 diff 前必须有 content 建过基线）
            if (!data.original) {
              // 没有基线（缓存被清/从来没 content 写过）→ 无法存 diff，退回 content 语义
              return json({ ok: false, error: "无基线，先发完整内容" }, 409);
            }
          } else {
            if (content === null || original === null) return json({ ok: false, error: "strategy=content 时需要 content 与 original" }, 400);
            data.strategy = "content";
            data.content = content;
            data.original = original;
          }
          writeFileSync(cacheFile, JSON.stringify(data), "utf8");
          return json({ ok: true, strategy, contentHash, historyCount: history.length });
        } catch (e) {
          return json({ ok: false, error: "缓存写失败: " + String(e) }, 500);
        }
      }

      // GET /session-files?sessionId= → 读取 session 打开的文件列表（墓碑制）
      //   返回 files: Array<{path, kind}>（kind="file"|"folder"）。
      //   旧格式（files 为 string[]）在读取时就地升级为对象。
      if (p[p.length - 1] === "session-files" && req.method === "GET") {
        const sid = u.searchParams.get("sessionId") || "";
        if (!sid) return json({ ok: false, error: "需要 sessionId" }, 400);
        const f = join(ensureCacheDir(), "..", "state", "sessions", sid + ".json");
        try {
          const data = JSON.parse(readFileSync(f, "utf8"));
          const files = normalizeSessionFiles(data.files || []);
          return json({ ok: true, files });
        } catch { return json({ ok: true, files: [] }); }
      }
      // POST /session-files { sessionId, filePath, kind?:"file"|"folder", action:"add"|"remove" }
      if (p[p.length - 1] === "session-files" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const sid = body?.sessionId || "";
        const filePath = body?.filePath || "";
        const kind = body?.kind === "folder" ? "folder" : "file";
        const action = body?.action || "add";
        if (!sid || !filePath) return json({ ok: false, error: "需要 sessionId 与 filePath" }, 400);
        const f = join(ensureCacheDir(), "..", "state", "sessions", sid + ".json");
        mkdirSync(join(ensureCacheDir(), "..", "state", "sessions"), { recursive: true });
        let data = { files: [] };
        try { data = JSON.parse(readFileSync(f, "utf8")); } catch {}
        // 墓碑存展开后的绝对路径：~/ 形式与绝对形式同一文件只记一条，恢复打开不依赖二次展开
        const canonical = expandTildePath(filePath);
        let files = normalizeSessionFiles(data.files || []);
        if (action === "add") {
          if (!files.some((e) => e.path === canonical)) files.push({ path: canonical, kind });
        } else if (action === "remove") {
          files = files.filter((e) => e.path !== canonical);
        }
        data.files = files;
        writeFileSync(f, JSON.stringify(data), "utf8");
        return json({ ok: true, files });
      }

      // GET /cache-read?filePath= → 读取缓存（恢复编辑内容 + 版本信息 + strategy/diff）
      if (p[p.length - 1] === "cache-read" && req.method === "GET") {
        const fp = tFp; // 路径来自票据（不进 URL）
        if (!fp) return json({ ok: false, error: "需要 filePath" }, 400);
        try {
          const cacheFile = join(cacheDir, cacheName(expandTildePath(fp)));
          if (!existsSync(cacheFile)) return json({ ok: false, error: "无缓存" }, 404);
          const data = JSON.parse(readFileSync(cacheFile, "utf8"));
          return json({ ok: true, original: data.original || "", content: data.content || "",
            strategy: data.strategy || "content", diff: data.diff || null,
            baseMtimeMs: data.baseMtimeMs || 0,
            contentHash: data.contentHash || "",
            history: data.history || [],
          });
        } catch (e) {
          return json({ ok: false, error: "缓存读失败: " + String(e) }, 500);
        }
      }

      // POST /cache-delete { filePath } → 删除缓存
      if (p[p.length - 1] === "cache-delete" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const fp = typeof body?.filePath === "string" ? body.filePath : "";
        if (!fp) return json({ ok: false, error: "需要 filePath" }, 400);
        try {
          const cacheFile = join(cacheDir, cacheName(expandTildePath(fp)));
          if (existsSync(cacheFile)) rmSync(cacheFile);
          return json({ ok: true });
        } catch (e) {
          return json({ ok: false, error: "缓存删失败: " + String(e) }, 500);
        }
      }
      if (p[p.length - 1] === "rename" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const filePath = typeof body?.filePath === "string" ? body.filePath : "";
        const newName = typeof body?.newName === "string" ? body.newName : "";
        if (!filePath || !newName || newName.includes("/") || newName.includes("\\")) {
          return json({ ok: false, error: "需要 filePath 与合法 newName（不含斜杠）" }, 400);
        }
        const target = await resolveAllowedWrite(filePath);
        if (!target) return json({ ok: false, error: "路径不在可写白名单内" }, 400);
        // 目标基于展开后的绝对路径计算（filePath 可能是 ~/ 形式，直接 dirname 会拼出字面 "~/" 目录）
        const dest = join(dirname(target), newName);
        if ((await resolveAllowedWrite(dest)) !== normalize(dest)) {
          return json({ ok: false, error: "目标路径不在可写白名单内" }, 400);
        }
        if (existsSync(dest)) return json({ ok: false, error: "目标文件已存在" }, 409);
        try {
          renameSync(target, dest);
          return json({ ok: true, newPath: dest, mtimeMs: statSync(dest).mtimeMs, size: statSync(dest).size });
        } catch (e) {
          return json({ ok: false, error: "重命名失败: " + String(e && e.message || e) }, 500);
        }
      }
      // POST /move { filePath, targetDir } → 移动文件到目标目录（renameSync；白名单校验 + 同名冲突 409）
      if (p[p.length - 1] === "move" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const filePath = typeof body?.filePath === "string" ? body.filePath : "";
        const targetDir = typeof body?.targetDir === "string" ? body.targetDir : "";
        if (!filePath || !targetDir) return json({ ok: false, error: "需要 filePath 和 targetDir" }, 400);
        const src = await resolveAllowedWrite(filePath);
        if (!src) return json({ ok: false, error: "源路径不在可写白名单内" }, 400);
        const dest = await resolveAllowedWrite(targetDir);
        if (!dest) return json({ ok: false, error: "目标目录不在可写白名单内" }, 400);
        try {
          if (!statSync(src).isFile()) return json({ ok: false, error: "源不是文件" }, 400);
        } catch { return json({ ok: false, error: "源文件不存在" }, 404); }
        try {
          if (!statSync(dest).isDirectory()) return json({ ok: false, error: "目标不是目录" }, 400);
        } catch { return json({ ok: false, error: "目标目录不存在" }, 404); }
        const name = basename(src);
        const target = join(dest, name);
        if (target === src) return json({ ok: true, newPath: src }); // 同目录无操作
        if (existsSync(target)) return json({ ok: false, error: "目标位置已存在同名文件" }, 409);
        try {
          renameSync(src, target);
          return json({ ok: true, newPath: target, mtimeMs: statSync(target).mtimeMs, size: statSync(target).size });
        } catch (e) {
          return json({ ok: false, error: "移动失败: " + String((e as Error)?.message || e) }, 500);
        }
      }
      // GET /archive-extract?innerPath= → 从压缩包提取单文件到临时缓存，返回提取路径
      //   archivePath 走 /t/<ticket> 路径票据（安全基线：不进 URL；query 通道已移除），
      //   innerPath 是压缩包内的文件路径（如 "dir/file.txt"）；提取到 configDir/archive-extract/<hash>/ 下
      if (p[p.length - 1] === "archive-extract" && req.method === "GET") {
        const archivePath = tFp;
        if (!archivePath) return json({ ok: false, error: "需要路径票据（/t/<ticket>/archive-extract）" }, 400);
        const innerPath = u.searchParams.get("innerPath") || "";
        const target = await resolveAllowedWrite(archivePath);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        if (!innerPath) return json({ ok: false, error: "需要 innerPath" }, 400);
        try {
          const st = statSync(target);
          if (!st.isFile()) return json({ ok: false, error: "目标不是压缩文件" }, 400);
          const ext = extname(archivePath).toLowerCase().replace(/^\./, "");
          const name = basename(archivePath).toLowerCase();
          const extractBase = join(ensureCacheDir(), "archive-extract", createHash("md5").update(archivePath + "::" + innerPath).digest("hex"));
          const outFile = join(extractBase, basename(innerPath));
          if (existsSync(outFile)) {
            // 缓存命中
            return json({ ok: true, extractPath: outFile, cached: true });
          }
          mkdirSync(extractBase, { recursive: true });
          if (ext === "zip") {
            await new Promise<void>((resolve, reject) => {
              const yauzl = require("yauzl");
              const fs = require("node:fs");
              yauzl.open(target, { lazyEntries: true, autoClose: true }, (err: Error | null, zipfile: any) => {
                if (err) return reject(err);
                zipfile.on("entry", (entry: any) => {
                  if (entry.fileName === innerPath) {
                    // 找到匹配文件，提取内容
                    zipfile.openReadStream(entry, (err2: Error | null, stream: any) => {
                      if (err2) return reject(err2);
                      const ws = fs.createWriteStream(outFile);
                      stream.pipe(ws);
                      ws.on("finish", () => resolve());
                      ws.on("error", reject);
                    });
                  } else {
                    zipfile.readEntry();
                  }
                });
                zipfile.on("end", () => reject(new Error("未找到文件: " + innerPath)));
                zipfile.on("error", reject);
                zipfile.readEntry();
              });
            });
          } else if (ext === "tar" || name.endsWith(".tar.gz") || ext === "tgz") {
            await new Promise<void>((resolve, reject) => {
              const tarStream = require("tar-stream");
              const zlib = require("node:zlib");
              const fs = require("node:fs");
              const extract = tarStream.extract();
              const needsGunzip = ext === "tgz" || name.endsWith(".tar.gz");
              let src: any = fs.createReadStream(target);
              if (needsGunzip) src = src.pipe(zlib.createGunzip());
              src.on("error", reject);
              src.pipe(extract);
              extract.on("entry", (header: any, stream: any, next: () => void) => {
                if (header.name === innerPath) {
                  const ws = fs.createWriteStream(outFile);
                  stream.pipe(ws);
                  ws.on("finish", () => resolve());
                  ws.on("error", reject);
                } else {
                  stream.resume();
                  stream.on("end", next);
                }
              });
              extract.on("finish", () => reject(new Error("未找到文件: " + innerPath)));
              extract.on("error", reject);
            });
          } else {
            // 7z/rar 等：用 7z 提取
            const seven = await resolve7zBin();
            if (!seven) return json({ ok: false, error: "此格式需要 7-Zip 才能提取文件" }, 422);
            // 异步化（2026-09-12）：30s 同步 7z 提取曾冻结主线程
            const r = await runProcAsync(seven, ["x", target, "-o" + extractBase, innerPath, "-y"], { timeoutMs: 30000 });
            if (r.code !== 0) throw new Error(r.error || "7z 提取失败");
            if (!existsSync(outFile)) {
              // 7z 提取可能创建了子目录，递归查找
              const found = findFileRecursive(extractBase, basename(innerPath));
              if (!found) throw new Error("提取后未找到文件");
              return json({ ok: true, extractPath: found });
            }
          }
          return json({ ok: true, extractPath: outFile });
        } catch (e: any) {
          return json({ ok: false, error: "提取失败: " + String(e?.message || e) }, 500);
        }
      }
      // GET /archive?filePath= → 压缩文件内容列表（纯 JS 优先，零系统依赖；专有格式可选 7-Zip 增强）
      //   纯 JS 支持：zip（yauzl）/ tar / tar.gz / tgz（tar-stream + zlib）
      //   可选 7-Zip：7z/rar/xz/bz2/zst/cab/iso/wim/dmg（系统装了 7-Zip 才能列，未装给清晰提示）
      if (p[p.length - 1] === "archive" && req.method === "GET") {
        const fp = tFp; // 路径来自票据（不进 URL）
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        try {
          const st = statSync(target);
          if (!st.isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
          const maxSize = 200 * 1024 * 1024; // 200MB 限制
          if (st.size > maxSize) return json({ ok: false, error: "压缩文件超过 200MB" }, 413);
          const ext = extname(fp).toLowerCase().replace(/^\./, "");
          const name = basename(fp).toLowerCase();
          const files: Array<{ name: string; size: number; date: string; compressedSize?: number }> = [];

          if (ext === "zip") {
            // zip：yauzl（纯 JS，跨平台）
            await new Promise<void>((resolve, reject) => {
              const yauzl = require("yauzl");
              yauzl.open(target, { lazyEntries: true, autoClose: true }, (err: Error | null, zipfile: any) => {
                if (err) return reject(err);
                zipfile.on("entry", (entry: any) => {
                  files.push({ name: entry.fileName, size: entry.uncompressedSize, date: entry.getLastModDate().toLocaleString("zh-CN", { hour12: false }) });
                  zipfile.readEntry();
                });
                zipfile.on("end", () => resolve());
                zipfile.on("error", reject);
                zipfile.readEntry();
              });
            });
          } else if (ext === "tar" || name.endsWith(".tar.gz") || ext === "tgz") {
            // tar / tar.gz / tgz：tar-stream，gz 用 Node 内置 zlib 解压（零外部依赖）
            await new Promise<void>((resolve, reject) => {
              const tarStream = require("tar-stream");
              const zlib = require("node:zlib");
              const fs = require("node:fs");
              const extract = tarStream.extract();
              const needsGunzip = ext === "tgz" || name.endsWith(".tar.gz");
              let src: any = fs.createReadStream(target);
              if (needsGunzip) src = src.pipe(zlib.createGunzip());
              src.on("error", reject);
              src.pipe(extract);
              extract.on("entry", (header: any, stream: any, next: () => void) => {
                files.push({ name: header.name, size: header.size || 0, date: header.mtime ? new Date(header.mtime).toLocaleString("zh-CN", { hour12: false }) : "" });
                stream.resume();
                stream.on("end", next);
              });
              extract.on("finish", () => resolve());
              extract.on("error", reject);
            });
          } else if (ext === "gz" && !name.endsWith(".tar.gz")) {
            // 单文件 gzip：条目 = 去掉 .gz 的文件名
            files.push({ name: name.replace(/\.gz$/i, ""), size: 0, date: "（gzip 单文件压缩）" });
          } else {
            // 专有/磁盘格式（7z/rar/xz/bz2/zst/cab/iso/wim/dmg）：系统 7-Zip 优先，未装则按需下载 portable 7za
            const seven = await resolve7zBin();
            if (!seven) {
              return json({ ok: false, requires7z: true, error: "此格式需要 7-Zip：系统未找到 7z，且自动下载 portable 7za 失败（常见格式 zip/tar/gz 无需任何安装）" }, 422);
            }
            await new Promise<void>((resolve, reject) => {
              const { spawn } = require("node:child_process");
              const proc = spawn(seven, ["l", "-slt", target], { stdio: ["ignore", "pipe", "pipe"] });
              let out = "";
              let err = "";
              proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
              proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
              proc.on("close", (code: number | null) => {
                if (code !== 0) return reject(new Error((err || out).slice(0, 300) || "7z 退出码 " + code));
                // -slt 输出：Path = ... / Size = ... / Modified = ... / Attributes = ...
                let cur: Record<string, string> = {};
                for (const line of out.split("\n")) {
                  const m = line.match(/^([^=]+)=(.*)$/);
                  if (!m) continue;
                  const k = m[1].trim();
                  const v = m[2].trim();
                  if (k === "Path" && cur.Path) {
                    pushSevenEntry(files, cur);
                    cur = {};
                  }
                  cur[k] = v;
                }
                if (cur.Path) pushSevenEntry(files, cur);
                resolve();
              });
              proc.on("error", (e: Error) => reject(e));
            });
          }
          return json({ ok: true, files, format: ext, totalSize: st.size });
        } catch (e: any) {
          return json({ ok: false, error: "读取压缩文件失败: " + String(e?.message || e) }, 500);
        }
      }
      // GET /file?filePath= → 直接读原始字节流返回（正确 Content-Type，浏览器原生渲染）
      //   先查注册的 provider 是否有自定义 serveFile handler；无则用默认 serveFileDefault
      // GET /soffice-status → LibreOffice 定位结果（客户端降级面板 / 转换可用性预判用）
      if (p[p.length - 1] === "soffice-status" && req.method === "GET") {
        if (u.searchParams.get("refresh") === "1") invalidateSofficeCache();
        const r = await locateSofficeAsync();
        return json({ ok: true, available: !!r.path, path: r.path, source: r.source, version: r.version || null, installHints: SOFFICE_INSTALL_HINTS });
      }
      // GET /t/<ticket>/doc-pdf → 老格式（.doc/.ppt/...）soffice 转 PDF 只读预览（缓存键控 mtime）
      if (p[p.length - 1] === "doc-pdf" && req.method === "GET") {
        const fp = tFp;
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        const ext = extname(fp).toLowerCase().replace(/^\./, "");
        if (!DOC_PDF_EXTS.has(ext)) return json({ ok: false, error: "仅支持 " + [...DOC_PDF_EXTS].join("/") + "（docx 走 mammoth 预览）" }, 400);
        const r = await docToPdf(target);
        if (!r.ok) return json({ ok: false, code: (r as any).code, error: r.error }, (r as any).code === "soffice-missing" ? 503 : 500);
        const buf = readFileSync(r.pdfPath);
        return new Response(new Uint8Array(buf), {
          status: 200,
          headers: { "content-type": "application/pdf", "cache-control": "no-store", "content-disposition": "inline; filename=\"" + basename(fp).replace(/\.[^.]+$/, "") + ".pdf\"" },
        });
      }
      if (p[p.length - 1] === "file" && req.method === "GET") {
        const fp = tFp; // 路径来自票据（不进 URL）
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        try {
          const st = statSync(target);
          if (!st.isFile()) return json({ ok: false, error: "目标不是文件" }, 400);
          const ext = extname(fp).toLowerCase().replace(/^\./, "");
          // 查注册 provider：有自定义 serveFile 则委派
          const provider = findProvider(ext, fp);
          if (provider && provider.serveFile) {
            return await provider.serveFile(fp, target);
          }
          // 默认：直接返回原始字节 + 正确 Content-Type（带 Range 分片流式）
          return serveFileDefault(target, ext, req);
        } catch (e) {
          return json({ ok: false, error: "读取失败: " + String(e && e.message || e) }, 500);
        }
      }
      // POST /watch-stop {watchId} → 停止对应 fs.watch（客户端暂停/关标签时调；30min 无事件亦自动停）
      if (p[p.length - 1] === "watch-stop" && req.method === "POST") {
        const body = await req.json().catch(() => null) as { watchId?: unknown } | null;
        if (typeof body?.watchId === "string") stopEditorWatch(body.watchId);
        return json({ ok: true });
      }
      // GET /raw?filePath=&encoding= → 读原始字节 → 编码检测 → 解码返回
      //   encoding=可选：用户指定以某编码打开（模式同 VSCode "Reopen with Encoding"）
      if (p[p.length - 1] === "raw" && req.method === "GET") {
        const fp = tFp; // 路径来自票据（不进 URL）
        const forced = u.searchParams.get("encoding") || "";
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        try {
          const buf = readFileSync(target);
          let enc: { encoding: string; hasBOM: boolean } = detectEncoding(buf);
          if (forced && forced !== "auto") enc = { encoding: forced, hasBOM: false };
          const content = decodeText(buf, enc.encoding, enc.hasBOM);
          return json({ ok: true, content, encoding: enc.encoding, hasBOM: enc.hasBOM, size: buf.length });
        } catch (e) {
          return json({ ok: false, error: "读取失败: " + String(e && e.message || e) }, 500);
        }
      }
      // GET /ts-siblings?filePath= → 同目录 TS/JS 家族兄弟文件内容（Monaco TS worker 相对导入解析用：
      //   浏览器 worker 无 FS，把兄弟文件注册为 extraLib 后 './host-shim' 这类相对 import 可解析）。
      //   限制：最多 60 个、单文件 ≤512KB、总量 ≤2MB；跳过自身与二进制。
      if (p[p.length - 1] === "ts-siblings" && req.method === "GET") {
        const fp = tFp; // 路径来自票据（不进 URL）
        const target = await resolveAllowedWrite(fp);
        if (!target) return json({ ok: false, error: "路径不在白名单内" }, 400);
        const dir = dirname(target);
        const baseName = basename(target);
        // ETag 校验：兄弟文件未变 → 304（客户端保留已有 extraLib，磁盘不重读、内容不重发）
        const sig = siblingSignature(dir, baseName);
        if (sig === null) return json({ ok: false, error: "读取目录失败" }, 500);
        const inm = req.headers.get("if-none-match");
        if (inm && inm.trim() === sig) {
          return new Response(null, { status: 304, headers: { "etag": sig } });
        }
        try {
          const out: Array<{ path: string; content: string }> = [];
          let total = 0;
          for (const ent of readdirSync(dir, { withFileTypes: true })) {
            if (!ent.isFile()) continue;
            const n = ent.name;
            if (n === baseName || !isTsSibling(n)) continue;
            if (out.length >= SIB_MAX_FILES || total >= SIB_MAX_TOTAL) break;
            const full = join(dir, n);
            try {
              const st = statSync(full);
              if (!st.isFile() || st.size > SIB_MAX_PER_FILE) continue;
              // 未保存编辑优先：有编辑缓存 → 用缓存内容（可能含未保存改动）；否则读磁盘
              let content: string | null = null;
              try {
                const cpath = join(ensureCacheDir(), cacheName(full));
                if (existsSync(cpath)) {
                  content = cachedContent(JSON.parse(readFileSync(cpath, "utf8")));
                }
              } catch { /* 缓存读取失败 → 退回磁盘 */ }
              if (content === null) {
                const buf = readFileSync(full);
                const enc = detectEncoding(buf);
                content = decodeText(buf, enc.encoding, enc.hasBOM);
              }
              out.push({ path: full, content });
              total += Buffer.byteLength(content, "utf8");
            } catch { /* 单个文件读取失败跳过 */ }
          }
          return new Response(JSON.stringify({ ok: true, dir, files: out }), {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-cache", "etag": sig },
          });
        } catch (e) {
          return json({ ok: false, error: "读取目录失败: " + String(e && e.message || e) }, 500);
        }
      }
      // POST /save { filePath, cwd, content, baseMtimeMs, encoding?, hasBOM? }
      if (p[p.length - 1] === "save" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        return await handleSave(body);
      }
      // POST /convert-saveas { filePath } → soffice 转可编辑格式另存（.doc→.docx / .ppt→.pptx）
      if (p[p.length - 1] === "convert-saveas" && req.method === "POST") {
        return await convertSaveAsRoute(req);
      }
      return json({ ok: false, error: "not found" }, 404);
    },
  },
};