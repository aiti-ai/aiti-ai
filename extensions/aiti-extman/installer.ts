/**
 * aiti-extman installer —— git / npm / 本地路径 → 用户扩展根（~/.pi/web/extensions/<id>）。
 *
 * 与宿主解耦（扩展不能 import pi-web 内部模块）：目录约定与入口探测逻辑内联自
 * pi-web 的 lib/ext/data-dir.ts / loader.ts。只做文件级安装（clone / pack+解包 /
 * 拷贝），不执行任何扩展代码；装载由 registry.loadAll 在随后的 reload 里完成。
 * 运行时依赖：npm 来源的 tgz 不含 node_modules，安装后由 shared-deps.ts 把扩展
 * package.json 声明的依赖 reconcile 进共享根 <webRoot>/node_modules（jiti 从扩展
 * 入口向上解析自动命中）；扩展也可自带 node_modules（就近优先）。
 *
 * 来源语法（与 pi 插件 install 对齐）：
 *   git:https://github.com/owner/repo[#branch]   git@host:owner/repo.git
 *   https://github.com/owner/repo                （.git / github 链接自动识别）
 *   npm:@scope/pkg[@version]                     @scope/pkg / pkg
 *   /absolute/path/to/ext · ./relative · ../relative（本地目录拷贝）
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { basename, dirname, join, resolve } from "path";

const execPath = process.execPath;

const execFileAsync = promisify(execFile);

// ── client TS 残留检查（层 2，方案见 docs/aiti-ext-client-hardening-plan.md §4.2）──
// check-client.mjs 由 tools/deploy.mjs 拷到本扩展部署目录（与 installer.ts 同目录）。
// 规则均为「合法 JS 但运行时必炸」的高置信模式；FAIL 中止安装（在删旧版之前，旧版本原样保留）。
import { lintExtensionDir } from "./check-client.mjs";

function checkEntryClient(entryDir: string): void {
  const { files, violations } = lintExtensionDir(entryDir);
  const fails = violations.filter((v) => v.level === "FAIL");
  if (!fails.length) return;
  const lines = fails
    .map((v) => `  ${v.file.replace(entryDir, "")}:${v.line} [${v.rule}] ${v.text}`)
    .join("\n");
  throw new Error(
    `client 检查未通过：${files} 个文件中 ${fails.length} 处 TS 残留（.mjs 里是合法 JS，语法检查不报，运行时必炸），已中止安装（旧版本保留）：\n${lines}\n` +
      `修复后重装，或在该行加注释 // check-client:allow 豁免。`,
  );
}

// yauzl：纯 JS zip 读取（npm 依赖，扩展目录自带 node_modules；勿用系统 unzip）。
// CJS 依赖：jiti 加载时 require 可用（与 aiti-cmd 的 node-pty 同模式）。
function requireYauzl(): { fromBuffer(buf: Buffer, cb: (err: Error | null, zip: {
  readEntry: (entry: { fileName: string; compressedSize: number; uncompressedSize: number }) => void;
  openReadStream: (entry: unknown, cb: (err: Error | null, rs: NodeJS.ReadableStream) => void) => void;
  once: (ev: string, cb: () => void) => void;
} | null) => void) } {
  // jiti interop：扩展目录/node_modules/yauzl（CJS）
  const req = typeof require === "function" ? require : undefined;
  if (!req) throw new Error("yauzl 不可用（无 require 环境）");
  return req("yauzl");
}

// ── 目录约定（内联自 pi-web lib/ext/data-dir.ts；env 覆盖优先） ──

function webRoot(): string {
  return process.env.PI_WEB_DEV_DIST === "1"
    ? join(homedir(), ".pi", "web-dev")
    : join(homedir(), ".pi", "web");
}

function extensionsRoot(): string {
  return process.env.PI_WEB_EXTENSIONS_DIR || join(webRoot(), "extensions");
}

// ── 入口探测（内联自 pi-web lib/ext/loader.ts） ──

const ENTRY_NAMES = ["index.ts", "index.mjs", "index.js", "index.cjs"];

function resolveExtensionEntry(dir: string): string | null {
  for (const name of ENTRY_NAMES) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  // 单文件布局：目录里恰好一个 .ts/.js/.mjs 文件。
  const files = readdirSync(dir).filter((f) => /\.(ts|mjs|js|cjs)$/.test(f) && !f.startsWith("."));
  if (files.length === 1) return join(dir, files[0]);
  return null;
}

/** 在一层子目录里找扩展入口（npm 包常见嵌套布局：package/<id>/index.ts）。 */
function findNestedEntry(dir: string): string | null {
  const entries = readdirSync(dir)
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .map((name) => join(dir, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  for (const sub of entries) {
    if (resolveExtensionEntry(sub)) return sub;
  }
  return null;
}

// ── npm pack 调用（不走 shell；优先宿主 node 自带 npm-cli.js） ──

function findNpmCli(): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [
    join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), // Windows MSI 布局
    join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), // Unix 布局
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

export async function runNpm(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  const npmCli = findNpmCli();
  const { command, commandArgs } = npmCli
    ? { command: execPath, commandArgs: [npmCli, ...args] }
    : { command: "npm", commandArgs: args };
  return execFileAsync(command, commandArgs, { timeout: 180_000, cwd, maxBuffer: 16 * 1024 * 1024 });
}

// ── 来源解析 ──

export type InstallKind = "git" | "npm" | "path" | "zip";

export interface InstallPlan {
  kind: InstallKind;
  /** git url / npm spec / 本地绝对路径。 */
  ref: string;
  branch?: string;
  id: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NPM_NAME_RE = /^(@[A-Za-z0-9-*][A-Za-z0-9-._*]*\/)?[A-Za-z0-9][A-Za-z0-9-._]*(@[^/]+)?$/;

function idFromGitUrl(url: string): string {
  const clean = url.replace(/[\\/]+$/, "").replace(/\.git$/, "");
  const tail = clean.split(/[\\/]/).pop() ?? clean;
  return tail.replace(/[^A-Za-z0-9._-]/g, "-");
}

function idFromNpmSpec(spec: string): string {
  let name = spec;
  if (name.startsWith("@")) {
    const idx = name.indexOf("@", 1);
    if (idx > 0) name = name.slice(0, idx);
  } else {
    const idx = name.lastIndexOf("@");
    if (idx > 0) name = name.slice(0, idx);
  }
  return name.split("/").pop() ?? name;
}

/** 解析安装来源；无法识别返回 null（调用方 400）。 */
export function parseInstallSource(source: string): InstallPlan | null {
  const s = source.trim();
  if (!s) return null;

  const gitPrefix = s.match(/^git:(.+?)(?:#([^#]+))?$/);
  if (gitPrefix) return { kind: "git", ref: gitPrefix[1], branch: gitPrefix[2], id: idFromGitUrl(gitPrefix[1]) };
  if (/^git@[\w.-]+:/.test(s)) return { kind: "git", ref: s, id: idFromGitUrl(s) };
  if (/^https?:\/\//i.test(s) && (/\.git(?:#|$|\/)/.test(s) || /github\.com\//i.test(s) || /gitlab\.com\//i.test(s))) {
    const hash = s.indexOf("#");
    const url = hash > 0 ? s.slice(0, hash) : s;
    const branch = hash > 0 ? s.slice(hash + 1) : undefined;
    return { kind: "git", ref: url, branch, id: idFromGitUrl(url) };
  }
  const npmSpec = s.startsWith("npm:") ? s.slice(4) : null;
  if (npmSpec) return { kind: "npm", ref: npmSpec, id: idFromNpmSpec(npmSpec) };
  if (
    NPM_NAME_RE.test(s) &&
    !s.startsWith("/") && !s.startsWith("./") && !s.startsWith("../") &&
    !/^[A-Za-z]:[\\/]/.test(s)
  ) {
    return { kind: "npm", ref: s, id: idFromNpmSpec(s) };
  }
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || /^[A-Za-z]:[\\/]/.test(s)) {
    const abs = resolve(s);
    return { kind: "path", ref: abs, id: basename(abs) };
  }
  return null;
}

// ── 安装 / 卸载 ──

export interface InstallResult {
  id: string;
  dir: string;
  kind: InstallKind;
  /** 已存在并覆盖更新（旧代码目录被替换；数据目录不受影响）。 */
  replaced: boolean;
}

/** 把解析出的发行者写进扩展目录的 package.json（存在则合并字段，不存在则新建）。 */
export function writePublisher(
  dir: string,
  p: { name?: string | null; url?: string; source?: string; email?: string },
): void {
  const pj = join(dir, "package.json");
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(pj, "utf8")) as Record<string, unknown>;
  } catch {
    pkg = {};
  }
  pkg.publisher = {
    name: p.name ?? null,
    ...(p.url ? { url: p.url } : {}),
    ...(p.source ? { source: p.source } : {}),
    ...(p.email ? { email: p.email } : {}),
  };
  writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n");
}

/** 把来源/文档地址写进扩展目录的 package.json homepage（存在则合并字段，不存在则新建）。 */
function writeHomepage(dir: string, url: string): void {
  const p = join(dir, "package.json");
  let pkg: Record<string, unknown> = {};
  try {
    pkg = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    pkg = {};
  }
  pkg.homepage = url;
  writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
}

// ── zip 解包（yauzl，纯 JS；无系统 unzip 依赖）──

/** 读 zip 全部文件条目到内存（解包目录级很小；排除 node_modules 与 mac 垃圾）。 */
async function readZipEntries(buf: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  const yauzl = requireYauzl();
  return new Promise((resolveP, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true, autoClose: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip 打开失败"));
      const out: Array<{ name: string; data: Buffer }> = [];
      zip.on("error", reject);
      zip.once("end", () => resolveP(out));
      zip.on("entry", (entry: { fileName: string }) => {
        const name = entry.fileName.replace(/\\/g, "/");
        if (name.endsWith("/") || name.split("/").some((p) => p === "node_modules" || p === "__MACOSX" || p === ".git")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error(`zip 条目读取失败：${name}`));
          const chunks: Buffer[] = [];
          rs.on("data", (c: Buffer) => chunks.push(c));
          rs.on("error", reject);
          rs.on("end", () => {
            out.push({ name, data: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** 解包 zip 到目录（递归建目录；条目路径不得逃逸目标目录）。 */
async function extractZipTo(buf: Buffer, dest: string): Promise<void> {
  for (const entry of await readZipEntries(buf)) {
    // 防穿越：规范化后必须仍在 dest 内；拒绝绝对路径与盘符。
    const rel = entry.name.split("/").filter((p) => p && p !== "." && !/^[A-Za-z]:$/.test(p));
    if (rel.includes("..")) throw new Error(`zip 含非法路径：${entry.name}`);
    if (rel.length === 0) continue;
    const target = join(dest, ...rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, entry.data);
  }
}

/** 解包 zip 到临时目录（发行者解析/预检用），返回目录；调用方负责 rmSync 清理。 */
export async function extractZipToTemp(buf: Buffer): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-ext-zip-resolve-"));
  await extractZipTo(buf, dir);
  return dir;
}

/** 安装（或覆盖更新）一个扩展到用户扩展根。docsUrl：来源/文档地址，写入 package.json homepage。 */
export async function installExtension(source: string, explicitId?: string, docsUrl?: string): Promise<InstallResult> {
  const plan = parseInstallSource(source);
  if (!plan) throw new Error(`无法识别的扩展来源：${source}`);
  const id = explicitId?.trim() || plan.id;
  if (!ID_RE.test(id)) throw new Error(`非法扩展 id："${id}"（仅限字母数字 . _ -）`);

  const root = extensionsRoot();
  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "pi-web-ext-"));
  try {
    let srcDir: string;
    if (plan.kind === "git") {
      srcDir = join(tmp, "src");
      const args = ["clone", "--depth", "1"];
      if (plan.branch) args.push("--branch", plan.branch);
      args.push(plan.ref, srcDir);
      await execFileAsync("git", args, { timeout: 180_000 });
    } else if (plan.kind === "npm") {
      await runNpm(["pack", plan.ref, "--json", "--pack-destination", tmp], tmp);
      const tgz = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
      if (!tgz) throw new Error(`npm pack 未产出 tarball（${plan.ref}）`);
      const extract = join(tmp, "pkg");
      mkdirSync(extract);
      await execFileAsync("tar", ["-xzf", join(tmp, tgz), "-C", extract, "--strip-components", "1"], { timeout: 60_000 });
      srcDir = extract;
    } else {
      if (!existsSync(plan.ref) || !statSync(plan.ref).isDirectory()) {
        throw new Error(`目录不存在：${plan.ref}`);
      }
      srcDir = join(tmp, "src");
      cpSync(plan.ref, srcDir, { recursive: true });
    }

    // 入口检查：根目录优先，其次一层子目录（嵌套布局）。
    const entryDir = resolveExtensionEntry(srcDir) ? srcDir : findNestedEntry(srcDir);
    if (!entryDir) throw new Error("未找到扩展入口（index.ts 或单文件 .ts/.mjs/.js）");
    checkEntryClient(entryDir); // 层 2：client TS 残留检查，FAIL 在删旧版之前中止

    const target = join(root, id);
    const replaced = existsSync(target);
    if (replaced) rmSync(target, { recursive: true, force: true });
    cpSync(entryDir, target, { recursive: true });
    if (docsUrl && /^https?:\/\//.test(docsUrl)) writeHomepage(target, docsUrl);
    return { id, dir: target, kind: plan.kind, replaced };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 从 zip 包内容安装（浏览器上传，纯 JS 解包无系统依赖）：入口探测（根/嵌套一层）→ 拷贝到用户根。 */
export async function installFromZipBuffer(buf: Buffer, explicitId?: string, docsUrl?: string): Promise<InstallResult> {
  const root = extensionsRoot();
  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "pi-web-ext-zip-"));
  try {
    const extract = join(tmp, "ext");
    mkdirSync(extract);
    await extractZipTo(buf, extract);

    // 入口探测：解包根优先，其次一层子目录（单层包裹：<pkg>/index.ts）。
    const entryDir = resolveExtensionEntry(extract) ? extract : findNestedEntry(extract);
    if (!entryDir) throw new Error("zip 内未找到扩展入口（index.ts 或单文件 .ts/.mjs/.js，且不含 node_modules）");
    checkEntryClient(entryDir); // 层 2：client TS 残留检查，FAIL 在删旧版之前中止

    // 入口在嵌套子目录时，id 缺省用该目录名。
    const defaultId = entryDir === extract ? "uploaded-ext" : basename(entryDir);
    const id = explicitId?.trim() || defaultId;
    if (!ID_RE.test(id)) throw new Error(`非法扩展 id："${id}"（仅限字母数字 . _ -）`);

    const target = join(root, id);
    const replaced = existsSync(target);
    if (replaced) rmSync(target, { recursive: true, force: true });
    cpSync(entryDir, target, { recursive: true });
    if (docsUrl && /^https?:\/\//.test(docsUrl)) writeHomepage(target, docsUrl);
    return { id, dir: target, kind: "zip", replaced };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 卸载：只允许删用户扩展根里的目录（extra/dev/bundled 不可删）。 */
export function removeExtension(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`非法扩展 id："${id}"`);
  const dir = join(extensionsRoot(), id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`扩展 "${id}" 不在用户扩展根（${extensionsRoot()}），无法卸载`);
  }
  rmSync(dir, { recursive: true, force: true });
  return dir;
}
