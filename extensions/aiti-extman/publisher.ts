/**
 * aiti-extman · publisher —— 发行者解析与信任管理（VSCode 式 trust）
 *
 * 发行者来源判定（安装时，优先级）：
 *   - npm 包   → npm registry（_npmUser / maintainers / author）；注册表无发行者信息时
 *                回退注册表声明的 author（hintAuthor，在线注册表安装）或 `npm:<name>` 指纹。
 *   - github/gitlab/git → 仓库 owner（URL 解析，离线可得）。
 *   - 本地路径 / zip / 其他 url → package.json author（字符串或对象，解析 name/url）。
 *
 * 信任持久化：<dataRoot>/aiti-extman/trusted-publishers.json
 *   [{ name, url, source, fingerprint, trustedAt }]
 *   isTrusted：有名发行者按 name 匹配；未知发行者（name 为空）按 fingerprint（来源指纹）匹配。
 *
 * 安装成功后把解析出的发行者写回扩展目录 package.json（publisher 字段），
 * 供扩展管理面板展示（含可点击网站）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { createHash } from "crypto";

export interface Publisher {
  /** 发行者名（org/用户）。null = 无法识别 → 按 fingerprint 信任。 */
  name: string | null;
  /** 可点击的发行者主页（github profile / npm 用户页 / author.url / homepage…）。 */
  url?: string;
  /** 来源：npm / github / gitlab / git / package.json / unknown。 */
  source: string;
  /** 信任指纹（unknown 发行者用；有名发行者即 name）。 */
  fingerprint: string;
  /** 在线注册表条目可能附带 email 等（备用展示）。 */
  email?: string;
}

// ── 目录约定（与 installer 同源；数据目录共享 pi-web dataRoot） ──

function webRoot(): string {
  return process.env.PI_WEB_DEV_DIST === "1"
    ? join(homedir(), ".pi", "web-dev")
    : join(homedir(), ".pi", "web");
}

function dataRoot(): string {
  return process.env.PI_WEB_DATA_DIR || join(webRoot(), "data");
}

const TRUSTED_FILE = () => join(dataRoot(), "aiti-extman", "trusted-publishers.json");

interface TrustedEntry {
  name: string | null;
  url?: string;
  source: string;
  fingerprint: string;
  trustedAt: string;
}

function loadTrusted(): TrustedEntry[] {
  try {
    const p = TRUSTED_FILE();
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8")) as TrustedEntry[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persistTrusted(list: TrustedEntry[]): void {
  const p = TRUSTED_FILE();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(list, null, 2) + "\n");
}

/** 发行者唯一键：有名用 name，未知用 fingerprint。 */
function keyOf(p: Pick<Publisher, "name" | "fingerprint">): string {
  return (p.name && p.name.trim()) || p.fingerprint;
}

/** 是否已信任（有名发行者按 name；未知按 fingerprint）。 */
export function isTrusted(p: Pick<Publisher, "name" | "fingerprint">): boolean {
  const k = keyOf(p);
  if (!k) return false;
  const keys = new Set(loadTrusted().map((t) => keyOf(t)));
  return keys.has(k);
}

/** 记录信任（去重；返回是否新增）。 */
export function addTrusted(p: Publisher): boolean {
  const list = loadTrusted();
  const k = keyOf(p);
  if (list.some((t) => keyOf(t) === k)) return false;
  list.push({
    name: p.name ?? null,
    url: p.url,
    source: p.source,
    fingerprint: p.fingerprint,
    trustedAt: new Date().toISOString(),
  });
  persistTrusted(list);
  return true;
}

/** 撤销信任（按 name 或 fingerprint）。 */
export function removeTrusted(nameOrFp: string): boolean {
  const list = loadTrusted();
  const next = list.filter((t) => keyOf(t) !== nameOrFp && (t.name ?? "") !== nameOrFp);
  if (next.length === list.length) return false;
  persistTrusted(next);
  return true;
}

/** 全部已信任发行者（供管理 UI）。 */
export function listTrusted(): TrustedEntry[] {
  return loadTrusted();
}

// ── package.json author / repository / homepage 解析 ──

/** 解析 npm 风格 author 字段："Name <email> (url)" / {name,email,url} / null。 */
export function parseAuthorField(author: unknown): { name?: string; email?: string; url?: string } {
  if (!author) return {};
  if (typeof author === "string") {
    const s = author.trim();
    const m = s.match(/^([^<]*?)(?:\s*<([^>]*)>)?(?:\s*\(([^)]*)\))?\s*$/);
    if (!m) return { name: s };
    return { name: m[1].trim() || undefined, email: m[2]?.trim(), url: m[3]?.trim() };
  }
  if (typeof author === "object") {
    const a = author as Record<string, unknown>;
    const name = typeof a.name === "string" ? a.name : undefined;
    const url = typeof a.url === "string" ? a.url : undefined;
    const email = typeof a.email === "string" ? a.email : undefined;
    return { name, email, url };
  }
  return {};
}

/** 从 directory 读 package.json（不执行代码）。 */
export function readPackageJson(dir: string): Record<string, unknown> {
  try {
    const p = join(dir, "package.json");
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** repository 字段 → 字符串 URL（支持 {url} / {type,url}）。 */
function repositoryUrl(pkg: Record<string, unknown>): string | undefined {
  const r = pkg.repository;
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && typeof (r as { url?: unknown }).url === "string") {
    return (r as { url: string }).url;
  }
  return undefined;
}

/**
 * 从 package.json 推断发行者（本地路径 / zip / 其他 url 安装时用，或已装扩展展示回退）。
 * 读 package.json 的 publisher 字段（安装时写入）→ author → homepage/repository 作为网站。
 */
export function publisherFromPackageJson(dir: string): Publisher {
  const pkg = readPackageJson(dir);
  const pub = pkg.publisher as { name?: unknown; url?: unknown; source?: unknown } | undefined;
  const author = parseAuthorField(pkg.author);
  const homepage = typeof pkg.homepage === "string" ? pkg.homepage : undefined;
  const repo = repositoryUrl(pkg);
  const name = pub && typeof pub.name === "string" && pub.name ? pub.name : author.name;
  const url =
    (pub && typeof pub.url === "string" && pub.url) ||
    author.url ||
    homepage ||
    (repo && /^https?:\/\//.test(repo) ? repo : undefined);
  return {
    name: name ?? null,
    url,
    source: (pub && typeof pub.source === "string" && pub.source) || "package.json",
    fingerprint: name ? String(name) : "package.json:" + fingerprintPath(dir),
    email: author.email,
  };
}

function fingerprintPath(dir: string): string {
  return createHash("sha1").update(dir).digest("hex").slice(0, 10);
}

// ── git / github owner 解析 ──

/** 从 git url（git:… / git@… / https://…）解析仓库 owner 与宿主。 */
export function ownerFromGitUrl(url: string): { owner: string; host: string; url: string; source: string } | null {
  let s = url.trim().replace(/^git:/i, "");
  let host = "";
  let path = "";
  // scp 式：git@github.com:owner/repo.git
  const scp = s.match(/^(?:[\w.-]+@)?([\w.-]+):(.+)$/);
  if (scp && !s.includes("://")) {
    host = scp[1];
    path = scp[2];
  } else {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/i, "");
    const slash = s.indexOf("/");
    if (slash > 0) {
      host = s.slice(0, slash);
      path = s.slice(slash + 1);
    }
  }
  path = path.replace(/\.git(?:\/|$)/, "").replace(/^\/+/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const hostLower = host.toLowerCase();
  const source = hostLower === "github.com" ? "github" : hostLower === "gitlab.com" ? "gitlab" : "git";
  return { owner, host, url: `https://${host}/${owner}`, source };
}

// ── npm registry ──

function configuredRegistry(): string {
  if (process.env.npm_config_registry) return process.env.npm_config_registry.replace(/\/+$/, "");
  try {
    const p = join(homedir(), ".npmrc");
    if (existsSync(p)) {
      const line = readFileSync(p, "utf8").split("\n").find((l) => /^\s*registry\s*=/.test(l));
      if (line) return line.replace(/^\s*registry\s*=\s*/, "").trim().replace(/\/+$/, "");
    }
  } catch {
    // ignore
  }
  return "https://registry.npmjs.org";
}

/** 单次 fetch 注册表（短超时；失败返回 null）。 */
async function fetchRegistryMeta(base: string, name: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${base}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 从 npm registry 元数据提取发行者（_npmUser → maintainers[0] → author）。
 * 无发行者信息返回 null（调用方回退 hintAuthor / 指纹）。
 */
export function publisherFromNpmMeta(meta: Record<string, unknown>): Publisher | null {
  const name = meta.name;
  if (typeof name !== "string" || !name) return null;
  let pubName: string | undefined;
  let email: string | undefined;
  const topUser = meta._npmUser as { name?: unknown; email?: unknown } | undefined;
  if (topUser && typeof topUser.name === "string" && topUser.name) {
    pubName = topUser.name;
    email = typeof topUser.email === "string" ? topUser.email : undefined;
  } else {
    const m = meta.maintainers;
    const first = Array.isArray(m) && (m[0] as { name?: unknown; email?: unknown } | undefined);
    if (first && typeof first.name === "string" && first.name) {
      pubName = first.name;
      email = typeof first.email === "string" ? first.email : undefined;
    }
  }
  // 兜底：最新版本的 _npmUser / author
  if (!pubName) {
    const latest = (meta["dist-tags"] as { latest?: unknown } | undefined)?.latest;
    const versions = meta.versions as Record<string, Record<string, unknown>> | undefined;
    const v = latest && versions ? versions[latest as string] : undefined;
    const vUser = v?._npmUser as { name?: unknown } | undefined;
    if (vUser && typeof vUser.name === "string" && vUser.name) pubName = vUser.name;
    else {
      const a = parseAuthorField(v?.author);
      if (a.name) pubName = a.name;
      email = email || a.email;
    }
  }
  if (!pubName) return null;
  return {
    name: pubName,
    url: `https://www.npmjs.com/~${pubName}`,
    source: "npm",
    fingerprint: pubName,
    email,
  };
}

/** 解析 npm 包发行者：优先配置的注册表，其次公共 npmjs。 */
export async function resolveNpmPublisher(pkgName: string): Promise<Publisher | null> {
  const bases = [configuredRegistry(), "https://registry.npmjs.org"];
  const seen = new Set<string>();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    const meta = await fetchRegistryMeta(base, pkgName);
    if (!meta) continue;
    const pub = publisherFromNpmMeta(meta);
    if (pub) return pub;
  }
  return null;
}

// ── zip 包内 package.json ──

/** 在解包目录（根或一层子目录）里定位 package.json 所在目录。 */
export function findPackageDir(dir: string): string | null {
  if (existsSync(join(dir, "package.json"))) return dir;
  const subs = readdirSync(dir)
    .filter((n) => !n.startsWith(".") && n !== "node_modules")
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  for (const sub of subs) {
    if (existsSync(join(sub, "package.json"))) return sub;
  }
  return null;
}

/**
 * 综合解析安装来源的发行者（trust 前置校验用）。
 * hintAuthor：在线注册表条目的 author（npm 注册表无发行者信息时的可信回退）。
 */
export async function resolvePublisherForSource(
  kind: string,
  source: string,
  hintAuthor?: string,
): Promise<Publisher> {
  if (kind === "npm") {
    const spec = source.startsWith("npm:") ? source.slice(4) : source;
    const name = npmNameFromSpec(spec);
    const pub = name ? await resolveNpmPublisher(name) : null;
    if (pub) return pub;
    if (hintAuthor && hintAuthor.trim()) {
      return {
        name: hintAuthor.trim(),
        source: "npm",
        fingerprint: hintAuthor.trim(),
      };
    }
    return {
      name: null,
      source: "npm",
      fingerprint: "npm:" + (name || spec),
    };
  }
  if (kind === "git") {
    const owner = ownerFromGitUrl(source);
    if (owner) return { name: owner.owner, url: owner.url, source: owner.source, fingerprint: owner.owner };
    return { name: null, source: "git", fingerprint: "git:" + source };
  }
  // path / zip：从 package.json 取。
  const abs = source.replace(/^path:/i, "");
  return publisherFromPackageJson(abs);
}

function npmNameFromSpec(spec: string): string | null {
  let name = spec.trim();
  const at = name.startsWith("@") ? name.indexOf("@", 1) : name.lastIndexOf("@");
  if (at > 0) name = name.slice(0, at);
  if (!name) return null;
  return name;
}

/** zip 包发行者（从包内 package.json 取；入口根或一层子目录）。 */
export function publisherFromZipBuffer(buf: Buffer, extractDir: string): Publisher {
  const dir = findPackageDir(extractDir);
  return publisherFromPackageJson(dir || extractDir);
}
