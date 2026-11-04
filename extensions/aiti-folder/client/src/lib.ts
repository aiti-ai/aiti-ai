/**
 * aiti-folder · 共享工具与纯函数（自手写版迁移，逻辑一比一）
 */

// ── 路径工具 ──
export function lastSeg(p?: string) { if (!p) return p; const s = p.replace(/[\\/]+$/, ""); const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")); return i >= 0 ? s.slice(i + 1) : s; }
export function joinPath(dir?: string, name?: string) { if (!dir) return name; return dir.replace(/[\\/]+$/, "") + "/" + name; }
export function displayCwd(cwd?: string, home?: string) { return home && cwd && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd; }
export function normSlash(p?: string) { return p ? p.replace(/\\/g, "/") : p; }
// 目录路径（等价 core getFileDirectory）："/a/b/c" → "/a/b"，"/a/b" → "/a"，"/a" → "/"
export function dirOf(p?: string) { const s = normSlash(p || "").replace(/\/+$/, ""); if (!s) return ""; const i = s.lastIndexOf("/"); if (i < 0) return ""; if (i === 0) return "/"; return s.slice(0, i); }
export function fileDir(p: string) { const s = normSlash(p); const i = s.lastIndexOf("/"); return i >= 0 ? s.slice(0, i) : s; }

// ── 简易文件图标数据（按扩展名着色，不引核心 FileIcons）──
export const EXT_LANG: Record<string, string> = { ts:"typescript",tsx:"typescript",js:"javascript",jsx:"javascript",mjs:"javascript",json:"json",css:"css",scss:"scss",html:"html",md:"markdown",yml:"yaml",yaml:"yaml",xml:"xml",svg:"xml",py:"python",go:"go",rs:"rust",java:"java",c:"c",cpp:"cpp",sh:"shell",sql:"sql",toml:"toml" };
export const LANG_COLOR: Record<string, string> = { typescript:"#3178c6", javascript:"#f1dd2f", json:"#a0a0a0", css:"#42a5f5", scss:"#cd6799", html:"#e44d26", markdown:"#999", yaml:"#cb171e", xml:"#e37935", python:"#3572a5", go:"#00add8", rust:"#dea584", java:"#b07219", c:"#555", cpp:"#f34b7d", shell:"#89e051", sql:"#e38c00", toml:"#9c4221" };

// ── 未读/项目聚合 ──
const UNREAD_KEY = "pi-web:unread-session-ids";
export function loadUnread(): Set<string> { try { const r = localStorage.getItem(UNREAD_KEY); const a = r?JSON.parse(r):[]; return new Set(Array.isArray(a)?a:[]); } catch { return new Set(); } }
// getRecentProjects 等价（客户端）：按 projectKey/workspaceKey 去重取最新
function wkKey(s: any) { return s.projectKey || s.cwd || s.id; }
export function recentProjects(sessions: any[]) {
  const m = new Map<string, { root: string; modified: string }>();
  for (const s of sessions) { const root = s.projectRoot || s.cwd; if (!root) continue; const k = wkKey(s); const p = m.get(k); if (!p || s.modified > p.modified) m.set(k, { root, modified: s.modified }); }
  return [...m.values()].sort((a,b)=> (b.modified||"").localeCompare(a.modified||"")).map(x=>({ key: x.root, root: x.root }));
}
export function projectActivity(sessions: any[], running: Set<string>, unread: Set<string>) {
  const m = new Map<string, { running: number; unread: number }>();
  for (const s of sessions) { const k = wkKey(s); if (!k) continue; let e = m.get(k); if (!e){ e={running:0,unread:0}; m.set(k,e);} if (running.has(s.id)) e.running++; if (unread.has(s.id)) e.unread++; }
  return m;
}

// ── git 状态 ──
export const GIT_COLORS: Record<string, string> = { modified:"#d6a84b", added:"#4ade80", deleted:"#f87171", renamed:"#60a5fa", untracked:"#4ade80", conflict:"#f87171" };
export const GIT_KEYS: Record<string, string> = { modified:"files.modified", added:"files.added", deleted:"files.deleted", renamed:"files.renamed", untracked:"files.untracked", conflict:"files.conflict" };
export function buildGitByPath(files: any[]) { const m=new Map<string, any>(); for (const f of files) m.set(normSlash(f.filePath), f); return m; }
export function buildChangedDirs(files: any[], cwd?: string) {
  const dirs=new Set<string>(); const nc = normSlash(cwd||"").replace(/\/$/,"");
  for (const f of files) { let d=fileDir(normSlash(f.filePath));
    while (d===nc || d.startsWith(nc+"/")) { dirs.add(d); if (d===nc) break; const p=fileDir(d); if (p===d) break; d=p; } }
  return dirs;
}

export interface FolderList { entries: any[]; parentPath: string | null; }
export async function fetchListRaw(apiUrlFn: (p: string) => string, dirPath: string, showIgnored?: boolean): Promise<FolderList> {
  const res = await fetch(apiUrlFn(showIgnored ? "/api/files/get?showIgnored=1" : "/api/files/get"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dirPath, type: "list" }) });
  if (!res.ok) throw new Error("HTTP "+res.status);
  const d = await res.json();
  return {
    entries: (d.entries||[]).map((e: any)=>({ name:e.name, fullPath:joinPath(dirPath, e.name), isDir:e.isDir, size:e.size, ignored:!!e.ignored, children:e.isDir?[]:undefined, loaded:!e.isDir })),
    // 可上溯的父目录：后端返回 parentPath 时以其为边界（null = 已到可浏览边界）；
    // 旧后端未返回该字段则回退 dirOf（保持旧「尽量向上」行为）。「上一个目录」按钮据此显隐。
    parentPath: ("parentPath" in d) ? (d.parentPath == null ? null : d.parentPath) as string | null : dirOf(dirPath),
  };
}

// ── 目录列表存活缓存：切走再切回不重拉（TTL 内）；手动刷新可强制绕过 ──
export const ENTRIES_TTL = 5 * 60 * 1000;
const entriesCache = new Map<string, { list: FolderList; ts: number }>();
/** 缓存 key：showIgnored 变体单独存（开关切换互不串），读写必须同源——peek 漏了变体位
 *  会让「开启显示忽略项」的面板首挂命中普通列表缓存、渲染出缺忽略项的树。 */
function entriesKey(dirPath: string, showIgnored?: boolean): string {
  return normSlash(dirPath)! + (showIgnored ? "#si1" : "");
}
function pruneEntries() { const now = Date.now(); for (const [k, v] of entriesCache) if (now - v.ts > ENTRIES_TTL) entriesCache.delete(k); }
export function invalidateEntries(dirPath?: string) { if (dirPath) { entriesCache.delete(entriesKey(dirPath)); entriesCache.delete(entriesKey(dirPath, true)); } else entriesCache.clear(); }
/** 同步读缓存（不发起请求）；无新鲜缓存返回 null */
export function peekList(dirPath: string, showIgnored?: boolean): FolderList | null {
  pruneEntries();
  return entriesCache.get(entriesKey(dirPath, showIgnored))?.list ?? null;
}
/** 拉取目录列表（含 parentPath 边界）；force 绕过存活缓存。showIgnored=true 时请求带忽略项
 *  （服务端返回 ignored:true 条目）。 */
export async function fetchList(apiUrlFn: (p: string) => string, dirPath: string, opts?: { force?: boolean; showIgnored?: boolean }): Promise<FolderList> {
  const key = entriesKey(dirPath, opts?.showIgnored);
  pruneEntries();
  if (!opts?.force) { const hit = entriesCache.get(key); if (hit) return hit.list; }
  const list = await fetchListRaw(apiUrlFn, dirPath, opts?.showIgnored);
  entriesCache.set(key, { list, ts: Date.now() });
  return list;
}
/** 兼容旧签名（只返回 entries） */
export function peekEntries(dirPath: string, showIgnored?: boolean): any[] | null { return peekList(dirPath, showIgnored)?.entries ?? null; }
export async function fetchEntries(apiUrlFn: (p: string) => string, dirPath: string, opts?: { force?: boolean; showIgnored?: boolean }): Promise<any[]> {
  return (await fetchList(apiUrlFn, dirPath, opts)).entries;
}

// 相对路径（@mention 用）：base 前缀剥离
export function relTo(rp: string, base?: string) {
  if (base && rp.startsWith(base)) { const s = rp.slice(base.length); return s.replace(/^[/\\]+/, ""); }
  return rp;
}

// Windows 客户端判定（模块加载时一次）：仅用于前缀比较是否大小写不敏感
const IS_WIN = typeof navigator !== "undefined" && (/win/i.test(navigator.platform || "") || /windows/i.test(navigator.userAgent || ""));

// 显示用相对路径（base 前缀剥离）：先统一分隔符再比较，Windows 下大小写不敏感。
// 背景：/api/git/status 的 filePath 是服务端 path.resolve 产物（Windows 反斜杠、盘符大写），
// 而 root 可能是正斜杠/小写盘符形式——直接 startsWith(root+"/") 必失败，变更区整行
// 回退显示完整绝对路径（2026-09 修）。
export function relFromBase(p: string, base?: string): string {
  const np = normSlash(p) || "";
  const nb = normSlash(base || "");
  if (!nb) return np;
  const prefix = nb.endsWith("/") ? nb : nb + "/";
  const hit = IS_WIN ? np.toLowerCase().startsWith(prefix.toLowerCase()) : np.startsWith(prefix);
  return hit ? np.slice(prefix.length) : np;
}

// ── 搜索结果折叠成树（移植 core lib/search-tree.ts，一比一）──
// 目录在前文件在后、逐层字母排序、重复路径合并——结果读起来像真实文件树。
export interface SearchTreeNode {
  name: string;
  /** 相对路径，如 "components/App.tsx" 或 "components" */
  path: string;
  isDir: boolean;
  children: SearchTreeNode[];
}
export function buildSearchTree(paths: string[]): SearchTreeNode[] {
  const roots: SearchTreeNode[] = [];
  const byPath = new Map<string, SearchTreeNode>();
  for (const relative of paths) {
    const segments = relative.split("/");
    let current = roots;
    let currentPath = "";
    for (let i = 0; i < segments.length; i++) {
      currentPath = currentPath ? currentPath + "/" + segments[i] : segments[i];
      let node = byPath.get(currentPath);
      if (!node) {
        node = { name: segments[i], path: currentPath, isDir: i < segments.length - 1, children: [] };
        byPath.set(currentPath, node);
        current.push(node);
      }
      current = node.children;
    }
  }
  const sort = (nodes: SearchTreeNode[]) => {
    nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
