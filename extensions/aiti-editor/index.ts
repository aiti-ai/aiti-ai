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
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
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
    fileViewer: [
      { id: "aiti-editor", label: "编辑器", title: "aiti-editor：文本文件在线编辑（Monaco），二进制文件可扩展渲染" },
    ],
    // 文件 dock faces（file-dock.tsx 按实例动态注册）+ 图片预览浮层（image-float.tsx 固定条目）：
    // 此静态声明供宿主懒加载清单发现——刷新后存在 docked 文件实例时，消费这些插槽才知道
    // 要物化本扩展回归 face；图片浮层条目同理（dialogs 是宿主常挂插槽）。
    dialogs: [{ id: "file", label: "文件" }, { id: "image-preview", label: "图片预览" }],
    sidebarExplorerDock: [{ id: "file", label: "文件" }],
    rightFileDock: [{ id: "file", label: "文件" }, { id: "image-preview", label: "图片预览" }],
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
          adds: info.adds ?? null, dels: info.dels ?? null, label: info.status ? (GIT_CHANGE_LABEL[info.status] || "有变更") : undefined });
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
        if (!gb.ok) return json({ ok: true, original: "", base: "（无 HEAD 基线，按全新文件对比）" });
        if (gb.buf.length > 6 * 1024 * 1024) return json({ ok: false, error: "HEAD 版本超过 6MB，不支持内置对比（可用 aiti-git-review 查看）" }, 413);
        // 按字节探测编码解码（与 /raw 同一管线）：GBK/UTF-16 基线不再乱码，diff 才有意义
        const enc = detectEncoding(gb.buf);
        return json({ ok: true, original: decodeText(gb.buf, enc.encoding, enc.hasBOM), base: "HEAD" });
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