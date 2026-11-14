/**
 * aiti-folder · 文件夹浏览器扩展（独立）
 *
 * 把文件夹查看/切换的业务逻辑从 pi-web 核心搬到本扩展。核心只保留薄委托：
 *  - fileViewer 槽：kind==="folder" 的 tab 由 FolderBrowser 接管（树 + git 徽标 + 开文件/子文件夹）
 *  - pathPicker 槽：FolderSwitcher 暴露为「目录选择器能力」，核心顶栏「打开文件夹」消费
 *
 * 全部复用核心现有端点（/api/files、/api/git/status、/api/sessions、/api/cwd/browse、
 * /api/default-cwd、/api/home），UI 用 ctx.h 重画，不引核心组件。
 *
 * 与 aiti-editor 的关系：同一 fileViewer 槽里两项共存——aiti-editor match 排除 folder，
 * 本扩展 match 仅命中 folder，互不冲突。文件夹 tab 的打开/关闭/重启恢复仍走核心
 * handleOpenFolder + aiti-editor session-files（kind=folder），本扩展不碰会话记录。
 *
 * 文件夹操作（+ 菜单）：新建文件/新建文件夹/上传文件夹走本扩展 server.api
 * （核心 files API 无 create/mkdir/嵌套上传），上传文件复用核心 /api/files?type=upload。
 * 删除（行悬停 🗑）：POST /trash 移入系统回收站（trash npm 包：Linux XDG / macOS 原生 / Windows 回收站），可恢复。
 * 写路径先过 isWritableTarget（realpath 最深已存在父链 + 词法 isAllowed）——防根内 symlink
 * 逃逸到根外；目录自身校验用 allowedDir（isAllowed 同一安全面）。
 */
import { renameSync, rmSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { groupHeuristic, loadPlan, savePlan, newPlan, learn } from "./server/git-plan";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import trash from "trash";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** 条目名合法性：非空、无路径分隔符/\0/..、长度 ≤200。 */
function validEntryName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return true;
}

/** aiti-doc-center services.docs 出口（search=FTS 全文检索带 <mark> snippet；query=拉取面）；未装/未启用/版本旧 → null（调用方降级）。
 *  每请求现取（不缓存引用）——doc-center 后装/热重载后下一请求自愈（plan-first 同款惰性解析）。
 *  双轨（DI 方案 P1）：ctx.services 优先（startup 捕获），__piWebExt.byId 穿透兜底（生产旧 core 过渡期）。 */
let hostSvc: any = null; // startup 捕获 ctx.services
function docsService(): { search?: (q: string, limit?: number) => any[] } | null {
  const viaSvc = hostSvc?.get?.("aiti-doc-center.docs");
  if (viaSvc && typeof viaSvc.search === "function") return viaSvc;
  const reg = (globalThis as any).__piWebExt;
  const loaded = reg && typeof reg.byId === "function" ? reg.byId("aiti-doc-center") : null;
  const s = loaded?.ext?.services?.docs;
  return s && typeof s.search === "function" ? s : null;
}

/** 路径末段（文件/文件夹名）；无害纯函数（此前 archive 路由直接引用未定义标识符，已补） */
function lastSeg(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 相对路径合法性（上传树用）：逐段校验，防目录逃逸。 */
function validRelPath(rel: string): boolean {
  if (!rel || rel.length > 2000) return false;
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[a-zA-Z]:/.test(rel)) return false;
  const segs = rel.split(/[\\/]+/).filter(Boolean);
  if (segs.length === 0) return false;
  return segs.every((s) => validEntryName(s));
}

/** 校验写目标目录（绝对路径 + allowed-roots）。返回规范化目录或 null。 */
async function allowedDir(dir: string, ctx: any): Promise<string | null> {
  if (!dir || !isAbsolute(dir)) return null;
  const norm = normalize(dir);
  try { if (!(await ctx.core.fileAccess.isAllowed(norm))) return null; } catch { return null; }
  return norm;
}

// ── 归档下载票据（可重复使用，TTL 5 分钟）──
// 动机：GET /archive?path=/abs/dir 会把本地路径落进隧道/代理 access log。
// 改两步：POST /archive-ticket { path } 换随机票据 → GET /archive?ticket=<token> 流式下载。
// TTL 内可重复取（外部下载器/断点重试友好）；到期即作废；不绑 cookie（下载器不带会话）。
const TICKET_TTL_MS = 5 * 60 * 1000;
const archiveTickets = new Map<string, { path: string; exp: number }>();
function sweepArchiveTickets(now: number) { for (const [k, v] of archiveTickets) if (v.exp <= now) archiveTickets.delete(k); }
function issueArchiveTicket(path: string): { ok: true; ticket: string; expiresIn: number } {
  const now = Date.now();
  sweepArchiveTickets(now);
  const ticket = randomBytes(24).toString("base64url");
  archiveTickets.set(ticket, { path, exp: now + TICKET_TTL_MS });
  return { ok: true, ticket, expiresIn: Math.round(TICKET_TTL_MS / 1000) };
}
function redeemArchiveTicket(ticket: unknown): string | null {
  const now = Date.now();
  sweepArchiveTickets(now);
  const v = archiveTickets.get(typeof ticket === "string" ? ticket : "");
  return v ? v.path : null;
}

/**
 * 写目标授权（扩展内实现，不依赖 core 新增接口）：
 * realpath 最深已存在父链，再对 real 父路径做词法 isAllowed。
 * writeFile/mkdir 都跟随中间 symlink 段——纯词法前缀检查会被「根内 symlink 目录
 * 指向根外」逃逸（如 root/link → /etc，写 link/evil 落到根外）；先把已存在父链
 * 解析成真实路径再校验即封住。差异：core isAllowed 对 roots 做词法比较（未
 * realpath 化 roots），allowed root 自身是 symlink 时会误拒——deny 方向，可接受。
 */
async function isWritableTarget(target: string, ctx: any): Promise<boolean> {
  let cur = target;
  for (;;) {
    try {
      lstatSync(cur);
    } catch {
      // 尚不存在——向上找最深已存在祖先；整条链缺失则写必败，防御性拒绝。
      const parent = dirname(cur);
      if (parent === cur) return false;
      cur = parent;
      continue;
    }
    try {
      return await ctx.core.fileAccess.isAllowed(realpathSync(cur));
    } catch {
      // lstat 存在但 realpath 失败（权限/竞态）——拒绝。
      return false;
    }
  }
}

const UPLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024;
const UPLOAD_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** 移入系统回收站（trash npm 包：Linux XDG / macOS 原生 / Windows 回收站；可恢复）。 */
async function trashToRecycle(absPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // glob:false —— 路径按字面处理，避免含 * ? [] 等字符被当 glob 展开
    await trash([absPath], { glob: false });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export default {
  id: "aiti-folder",
  name: "aiti-folder",
  description: "文件夹浏览器（fileViewer folder 接管）+ 目录选择器能力（pathPicker FolderSwitcher）。复用核心端点，UI 全在扩展。",
  client: "dist/aiti-folder-client.mjs",
  clientImmediately: true,
  // 可选依赖（git-ops 共享引擎方案 §4 软依赖）：引擎在位时目录浏览器出 git 工具条
  // （分支面板/同步/提交）；缺席/禁用 → 工具条隐藏，folder 其余功能零影响。
  optionalDependsOn: ["aiti-git-ops"],
  icon: "icon.svg",
  ui: {
    fileViewer: [
      { id: "aiti-folder", label: "文件夹", title: "aiti-folder：文件夹浏览器（树 + git 状态 + 切换）" },
    ],
    pathPicker: [
      { id: "aiti-folder-picker", label: "目录选择", title: "aiti-folder：目录选择器能力（FolderSwitcher，不切 cwd）" },
    ],
    // 扩展自持 i18n 表（ctx.t 只读本表；缺 key 回退显 key）。复用核心 files.*/sidebar.* key，
    // 翻译与 core lib/i18n/messages 对齐——新增 t()/tt() 调用记得同步补 key。
    i18n: {
      "zh-CN": {
        "files.cancel": "取消",
        "files.refresh": "刷新",
        "files.changedCount": "{count} 个文件",
        "files.loading": "正在加载文件...",
        "files.noFiles": "未找到文件",
        "files.noSubdirs": "无子目录",
        "files.openFolder": "打开文件夹",
        "files.parentDir": "上级目录",
        "files.selectFolder": "选择此文件夹",
        "files.containsChangedFiles": "包含已更改文件",
        "files.insertPath": "将路径插入聊天",
        "files.atNewSession": "到新session",
        "files.entryInfo": "文件信息",
        "files.infoName": "名称",
        "files.infoType": "类型",
        "files.infoSize": "大小",
        "files.infoMtime": "修改时间",
        "files.infoParent": "所在目录",
        "files.infoOpenParent": "点击打开该目录",
        "files.infoItems": "包含条目",
        "files.infoTypeFile": "文件",
        "files.infoTypeDir": "文件夹",
        "files.open": "打开",
        "files.openInPanel": "在面板打开",
        "files.openNewWindow": "在新窗口打开",
        "files.rename": "重命名",
        "files.renamePlaceholder": "新名称",
        "files.renameSuccess": "已重命名",
        "files.renameFailed": "重命名失败",
        "files.confirm": "确认",
        "files.copyPath": "复制路径",
        "files.copyDone": "已复制路径",
        "files.copyFailed": "复制失败",
        "files.copyTo": "复制到",
        "files.copyToTitle": "复制到",
        "files.copyHere": "复制到此目录",
        "files.copyDoneAction": "已复制",
        "files.menuTabs": "标签页",
        "files.menuNav": "导航",
        "files.menuOpen": "打开",
        "files.menuRef": "路径引用",
        "files.menuOrganize": "整理",
        "files.menuCreate": "新建 / 上传",
        "files.menuExport": "导出",
        "files.menuGit": "Git",
        "files.openParentDir": "打开上级目录",
        "files.openTerminal": "打开终端",
        "files.pin": "钉住",
        "files.unpin": "取消钉住",
        "files.pinDone": "已钉住（不受批量关闭影响）",
        "files.unpinDone": "已取消钉住",
        "files.closeLeft": "关闭左侧",
        "files.closeRight": "关闭右侧",
        "files.closeAll": "关闭全部",
        "files.batchClosed": "已关闭 {count} 个标签页",
        "files.download": "下载",
        "files.newFile": "新建文件",
        "files.newFolder": "新建文件夹",
        "files.uploadFile": "上传文件",
        "files.uploadFolder": "上传文件夹",
        "files.create": "创建",
        "files.delete": "删除",
        "files.trash": "移入回收站",
        "files.trashConfirmTitle": "移入回收站？",
        "files.trashConfirmBody": "将移入系统回收站（可恢复）。",
        "files.trashDone": "已移入回收站",
        "files.move": "移动到",
        "files.moveTitle": "移动到",
        "files.moveTarget": "目标目录",
        "files.moveWorkspace": "选择工作区",
        "files.moveBrowse": "选择目标目录",
        "files.moveHere": "移动到此目录",
        "files.moveDone": "已移动",
        "files.moveFailed": "移动失败",
        "files.moveIntoItself": "不能移动到自身或其子目录",
        "files.namePlaceholderFile": "文件名（如 readme.md）",
        "files.namePlaceholderFolder": "文件夹名",
        "i18n.close": "关闭",
        "sidebar.agentRunning": "Agent 运行中…",
        "sidebar.changedFiles": "{count} 个变更文件",
        "sidebar.customPath": "自定义路径…",
        "sidebar.filterProjects": "筛选项目…",
        "sidebar.newSessionActivity": "会话有新活动",
        "sidebar.noMatchingProjects": "没有匹配的项目",
        "sidebar.noMatchingFiles": "没有匹配的文件",
        "sidebar.refreshExplorer": "刷新文件浏览器",
        "sidebar.searchFiles": "搜索文件",
        "sidebar.searchFilesPlaceholder": "搜索文件…",
        "sidebar.searchingFiles": "搜索中…",
        "sidebar.clearSearch": "清除搜索",
        "sidebar.searchTabFiles": "文件",
        "sidebar.searchTabFulltext": "文档",
        "sidebar.searchingDocs": "搜索文档中…",
        "sidebar.noMatchingDocs": "没有匹配的文档",
        "sidebar.docCenterUnavailable": "文档中心未启用",
        "sidebar.fullScopeAll": "全 workspace",
        "sidebar.fulltextHint": "限文档中心已收录 md",
        "sidebar.fulltextHintTitle": "仅搜索文档中心已收录的 workspace md；收录为定期/手动扫描，最新文件可能未入库",
        "sidebar.useDefaultDirectory": "使用默认目录",
        "i18n.networkError": "网络错误",
      },
      "en": {
        "files.cancel": "Cancel",
        "files.refresh": "Refresh",
        "files.changedCount": "{count} files",
        "files.loading": "Loading files...",
        "files.noFiles": "No files found",
        "files.noSubdirs": "No subdirectories",
        "files.openFolder": "Open Folder",
        "files.parentDir": "Parent directory",
        "files.selectFolder": "Select this folder",
        "files.containsChangedFiles": "Contains changed files",
        "files.insertPath": "Insert path into chat",
        "files.atNewSession": "to new session",
        "files.entryInfo": "File info",
        "files.infoName": "Name",
        "files.infoType": "Type",
        "files.infoSize": "Size",
        "files.infoMtime": "Modified",
        "files.infoParent": "Parent directory",
        "files.infoOpenParent": "Click to open this directory",
        "files.infoItems": "Items",
        "files.infoTypeFile": "File",
        "files.infoTypeDir": "Folder",
        "files.open": "Open",
        "files.openInPanel": "Open in panel",
        "files.openNewWindow": "Open in new window",
        "files.rename": "Rename",
        "files.renamePlaceholder": "New name",
        "files.renameSuccess": "Renamed",
        "files.renameFailed": "Rename failed",
        "files.confirm": "Confirm",
        "files.copyPath": "Copy path",
        "files.copyDone": "Path copied",
        "files.copyFailed": "Copy failed",
        "files.copyTo": "Copy to",
        "files.copyToTitle": "Copy to",
        "files.copyHere": "Copy here",
        "files.copyDoneAction": "Copied",
        "files.menuTabs": "Tabs",
        "files.menuNav": "Navigate",
        "files.menuOpen": "Open",
        "files.menuRef": "Path reference",
        "files.menuOrganize": "Organize",
        "files.menuCreate": "Create / Upload",
        "files.menuExport": "Export",
        "files.menuGit": "Git",
        "files.openParentDir": "Open parent folder",
        "files.openTerminal": "Open in Terminal",
        "files.pin": "Pin",
        "files.unpin": "Unpin",
        "files.pinDone": "Pinned (protected from batch close)",
        "files.unpinDone": "Unpinned",
        "files.closeLeft": "Close Left",
        "files.closeRight": "Close Right",
        "files.closeAll": "Close All",
        "files.batchClosed": "Closed {count} tab(s)",
        "files.download": "Download",
        "files.newFile": "New File",
        "files.newFolder": "New Folder",
        "files.uploadFile": "Upload File",
        "files.uploadFolder": "Upload Folder",
        "files.create": "Create",
        "files.delete": "Delete",
        "files.trash": "Move to trash",
        "files.trashConfirmTitle": "Move to trash?",
        "files.trashConfirmBody": "Will be moved to the system trash (recoverable).",
        "files.trashDone": "Moved to trash",
        "files.move": "Move to",
        "files.moveTitle": "Move to",
        "files.moveTarget": "Destination",
        "files.moveWorkspace": "Select workspace",
        "files.moveBrowse": "Choose destination",
        "files.moveHere": "Move here",
        "files.moveDone": "Moved",
        "files.moveFailed": "Move failed",
        "files.moveIntoItself": "Cannot move into itself or its subdirectory",
        "files.namePlaceholderFile": "File name (e.g. readme.md)",
        "files.namePlaceholderFolder": "Folder name",
        "i18n.close": "Close",
        "sidebar.agentRunning": "Agent running…",
        "sidebar.changedFiles": "{count} changed files",
        "sidebar.customPath": "Custom path…",
        "sidebar.filterProjects": "Filter projects…",
        "sidebar.newSessionActivity": "New session activity",
        "sidebar.noMatchingProjects": "No matching projects",
        "sidebar.noMatchingFiles": "No matching files",
        "sidebar.refreshExplorer": "Refresh explorer",
        "sidebar.searchFiles": "Search files",
        "sidebar.searchFilesPlaceholder": "Search files…",
        "sidebar.searchingFiles": "Searching…",
        "sidebar.clearSearch": "Clear search",
        "sidebar.searchTabFiles": "Files",
        "sidebar.searchTabFulltext": "Docs",
        "sidebar.searchingDocs": "Searching docs…",
        "sidebar.noMatchingDocs": "No matching docs",
        "sidebar.docCenterUnavailable": "Doc center unavailable",
        "sidebar.fullScopeAll": "All workspaces",
        "sidebar.fulltextHint": "doc-center indexed md only",
        "sidebar.fulltextHintTitle": "Only workspace md indexed by aiti-doc-center; collection is periodic/manual, newest files may be missing",
        "sidebar.useDefaultDirectory": "Use default directory",
        "i18n.networkError": "Network error",
      },
    },
  },
  server: {
    startup(ctx?: any) {
      hostSvc = ctx?.services ?? null; // DI 方案 P1：services 通道捕获
      console.log("[aiti-folder] 就绪 · fileViewer(folder) + pathPicker 槽");
    },
    async api(req: Request, ctx: any) {
      const u = new URL(req.url);
      const p = u.pathname.split("/").filter(Boolean);
      const route = p[p.length - 1];

      // POST /create-file { dir, name, content? } → 新建文件（可带初始内容；已存在 409）
      if (route === "create-file" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const dir = typeof body?.dir === "string" ? body.dir : "";
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (!validEntryName(name)) return json({ ok: false, error: "文件名非法（不能含 / \\ 或 ..）" }, 400);
        const root = await allowedDir(dir, ctx);
        if (!root) return json({ ok: false, error: "目录不在可写范围" }, 403);
        const target = join(root, name);
        // 写前 realpath 校验：目录自身是 symlink（指向根外）时拒绝。
        if (!(await isWritableTarget(target, ctx))) return json({ ok: false, error: "目标不在可写范围" }, 403);
        if (existsSync(target)) return json({ ok: false, error: "文件已存在" }, 409);
        try {
          // wx：原子新建，竞态下不覆盖已有文件（EEXIST 归一 409）。
          writeFileSync(target, typeof body?.content === "string" ? body.content : "", { flag: "wx" });
          return json({ ok: true, path: target });
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return json({ ok: false, error: "文件已存在" }, 409);
          return json({ ok: false, error: "创建失败: " + String((e as Error)?.message || e) }, 500);
        }
      }

      // POST /open-terminal { path } → 在目录打开终端（Unix=终端模拟器新窗跑 bash；Windows=powershell 新窗）
      // 选中文件夹→CWD=自身；选中文件→CWD=父目录。detached+stdio:ignore 弹独立窗口，与 pi-web 服务生命周期解耦。
      if (route === "open-terminal" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const path = typeof body?.path === "string" ? body.path : "";
        if (!path || !isAbsolute(path)) return json({ ok: false, error: "需要绝对路径" }, 400);
        const abs = normalize(path);
        if (!(await isWritableTarget(abs, ctx))) return json({ ok: false, error: "路径不在可写范围" }, 403);
        if (!existsSync(abs)) return json({ ok: false, error: "不存在" }, 404);
        const isDir = lstatSync(abs).isDirectory();
        const cwd = isDir ? abs : dirname(abs);
        // detached 启动单个候选；ENOENT 等经 error 事件 reject → 调用方换下一个候选
        const trySpawn = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
          try {
            const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
            child.once("error", reject);
            child.once("spawn", () => resolve());
            child.unref();
          } catch (e) { reject(e); }
        });
        try {
          if (process.platform === "win32") {
            // start 在新控制台窗口拉起 powershell，-NoExit 保持会话
            await trySpawn("cmd.exe", ["/c", "start", "powershell", "-NoExit", "-Command", "Set-Location", "-LiteralPath", cwd]);
          } else if (process.platform === "darwin") {
            await trySpawn("open", ["-a", "Terminal", cwd]);
          } else {
            // Linux：按常见度依次尝试（各终端 working-directory 参数形式不同）
            const candidates: Array<[string, string[]]> = [
              ["x-terminal-emulator", ["--working-directory", cwd]],
              ["gnome-terminal", ["--working-directory=" + cwd]],
              ["konsole", ["--workdir", cwd]],
              ["xfce4-terminal", ["--working-directory", cwd]],
              ["xterm", ["-e", "bash", "-c", "cd " + JSON.stringify(cwd) + "; exec bash"]],
            ];
            let lastErr: unknown = null;
            let launched = false;
            for (const [cmd, args] of candidates) {
              try { await trySpawn(cmd, args); launched = true; break; } catch (e) { lastErr = e; }
            }
            if (!launched) return json({ ok: false, error: "没有可用的终端模拟器: " + String((lastErr as Error)?.message || lastErr) }, 500);
          }
          return json({ ok: true });
        } catch (e) {
          return json({ ok: false, error: "打开终端失败: " + String((e as Error)?.message || e) }, 500);
        }
      }
      // POST /create-folder { dir, name } → 新建文件夹（已存在 409）
      if (route === "create-folder" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const dir = typeof body?.dir === "string" ? body.dir : "";
        const name = typeof body?.name === "string" ? body.name.trim() : "";
        if (!validEntryName(name)) return json({ ok: false, error: "文件夹名非法（不能含 / \\ 或 ..）" }, 400);
        const root = await allowedDir(dir, ctx);
        if (!root) return json({ ok: false, error: "目录不在可写范围" }, 403);
        const target = join(root, name);
        if (!(await isWritableTarget(target, ctx))) return json({ ok: false, error: "目标不在可写范围" }, 403);
        if (existsSync(target)) return json({ ok: false, error: "文件夹已存在" }, 409);
        try {
          mkdirSync(target);
          return json({ ok: true, path: target });
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return json({ ok: false, error: "文件夹已存在" }, 409);
          return json({ ok: false, error: "创建失败: " + String((e as Error)?.message || e) }, 500);
        }
      }

      // POST /upload-tree — multipart：dir 字段 + files（文件名=相对路径，服务端逐层建目录）
      // 语义：把选中文件夹的内容整体上传到 dir 下（含文件夹名），冲突跳过。
      if (route === "upload-tree" && req.method === "POST") {
        // 解析期预检：Content-Length 超上限直接 413（不解析 body，防超大请求打内存）。
        const contentLength = Number(req.headers.get("content-length") || 0);
        if (contentLength > UPLOAD_MAX_TOTAL_BYTES + 1024 * 1024) {
          return json({ ok: false, error: "总大小超过 100MB" }, 413);
        }
        let form: FormData;
        try { form = await req.formData(); }
        catch { return json({ ok: false, error: "multipart 解析失败" }, 400); }
        const dir = String(form.get("dir") || "");
        const root = await allowedDir(dir, ctx);
        if (!root) return json({ ok: false, error: "目录不在可写范围" }, 403);
        const files = form.getAll("files").filter((e): e is File => typeof e !== "string");
        if (files.length === 0) return json({ ok: false, error: "没有文件" }, 400);
        if (files.some((f) => f.size > UPLOAD_MAX_FILE_BYTES)) return json({ ok: false, error: "单个文件超过 25MB" }, 413);
        if (files.reduce((t, f) => t + f.size, 0) > UPLOAD_MAX_TOTAL_BYTES) return json({ ok: false, error: "总大小超过 100MB" }, 413);
        const uploaded: string[] = [];
        const skipped: string[] = [];
        const errors: Array<{ name: string; error: string }> = [];
        for (const f of files) {
          const rel = f.name; // FormData append 的 filename = 相对路径
          if (!validRelPath(rel)) { errors.push({ name: rel, error: "非法路径" }); continue; }
          const target: string = join(root, rel.split(/[\\/]+/).join(sep));
          if (!target.startsWith(root + sep)) { errors.push({ name: rel, error: "路径越界" }); continue; }
          // 写前 realpath 校验：中间目录可能是根内 symlink（指向根外）——逐文件封住。
          if (!(await isWritableTarget(target, ctx))) { errors.push({ name: rel, error: "路径越界" }); continue; }
          if (existsSync(target)) { skipped.push(rel); continue; }
          try {
            const parent: string = target.slice(0, target.lastIndexOf(sep));
            if (parent && parent !== root && !existsSync(parent)) mkdirSync(parent, { recursive: true });
            writeFileSync(target, Buffer.from(await f.arrayBuffer()), { flag: "wx" });
            uploaded.push(rel);
          } catch (e) {
            errors.push({ name: rel, error: String((e as Error)?.message || e) });
          }
        }
        return json({ ok: true, uploaded, skipped, errors });
      }

      // POST /trash { paths: string[] } → 移入系统回收站（gio trash / XDG 兑底），可恢复、不物理删除
      if (route === "trash" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const paths: string[] = Array.isArray(body?.paths)
          ? body.paths.filter((x: unknown): x is string => typeof x === "string" && !!x)
          : [];
        if (paths.length === 0) return json({ ok: false, error: "需要 paths" }, 400);
        const trashed: string[] = [];
        const errors: Array<{ path: string; error: string }> = [];
        for (const raw of paths) {
          const abs = normalize(raw);
          if (!isAbsolute(abs)) { errors.push({ path: raw, error: "非绝对路径" }); continue; }
          // realpath 校验：中间段 symlink（指向根外）会把删除引到根外；路径已存在，
          // isWritableTarget 解析其真实路径后做词法 isAllowed。
          if (!(await isWritableTarget(abs, ctx))) { errors.push({ path: raw, error: "路径不在可写范围" }); continue; }
          if (!existsSync(abs)) { errors.push({ path: raw, error: "不存在" }); continue; }
          const r = await trashToRecycle(abs);
          if (r.ok) trashed.push(raw);
          else errors.push({ path: raw, error: r.error || "回收失败" });
        }
        return json({ ok: true, trashed, errors });
      }

      // POST /rename { path, newName } → 重命名文件或文件夹（renameSync）
      if (route === "rename" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const path = typeof body?.path === "string" ? body.path : "";
        const newName = typeof body?.newName === "string" ? body.newName.trim() : "";
        if (!path || !newName) return json({ ok: false, error: "需要 path 和 newName" }, 400);
        if (!validEntryName(newName)) return json({ ok: false, error: "名称非法（不能含 / \\ 或 ..）" }, 400);
        const abs = normalize(path);
        if (!isAbsolute(abs)) return json({ ok: false, error: "非绝对路径" }, 400);
        if (!(await isWritableTarget(abs, ctx))) return json({ ok: false, error: "路径不在可写范围" }, 403);
        if (!existsSync(abs)) return json({ ok: false, error: "不存在" }, 404);
        const dir = dirname(abs);
        const target = join(dir, newName);
        if (target === abs) return json({ ok: true, path: abs });
        if (existsSync(target)) return json({ ok: false, error: "目标已存在" }, 409);
        if (!(await isWritableTarget(target, ctx))) return json({ ok: false, error: "目标不在可写范围" }, 403);
        try {
          renameSync(abs, target);
          return json({ ok: true, path: target });
        } catch (e) {
          return json({ ok: false, error: "重命名失败: " + String((e as Error)?.message || e) }, 500);
        }
      }

      // POST /move { path, targetDir } → 移动文件/文件夹到目标目录（renameSync；跨设备 EXDEV 时复制 + 源移入回收站）
      if (route === "move" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const path = typeof body?.path === "string" ? body.path : "";
        const targetDir = typeof body?.targetDir === "string" ? body.targetDir : "";
        if (!path || !targetDir) return json({ ok: false, error: "需要 path 和 targetDir" }, 400);
        const abs = normalize(path);
        const dest = normalize(targetDir);
        if (!isAbsolute(abs) || !isAbsolute(dest)) return json({ ok: false, error: "需要绝对路径" }, 400);
        // 源与目标目录都必须过 realpath 写授权（防根内 symlink 逃逸）
        if (!(await isWritableTarget(abs, ctx))) return json({ ok: false, error: "源路径不在可写范围" }, 403);
        if (!(await isWritableTarget(dest, ctx))) return json({ ok: false, error: "目标目录不在可写范围" }, 403);
        if (!existsSync(abs)) return json({ ok: false, error: "源不存在" }, 404);
        if (!existsSync(dest) || !lstatSync(dest).isDirectory()) return json({ ok: false, error: "目标不是目录或不存在" }, 400);
        const name = lastSeg(abs);
        const target = join(dest, name);
        // 移动进自身目录（同名条目冲突）；目标 = 源自身时无操作
        if (target === abs) return json({ ok: true, path: abs });
        // 目录不能移进自己或自己的子孙目录（否则会把自己搬进自己）
        const srcReal = abs.replace(/[\\/]+$/, "");
        if (lstatSync(abs).isDirectory() && (dest === srcReal || dest.startsWith(srcReal + sep))) {
          return json({ ok: false, error: "不能移动到自身或其子目录" }, 400);
        }
        if (existsSync(target)) return json({ ok: false, error: "目标位置已存在同名条目" }, 409);
        if (!(await isWritableTarget(target, ctx))) return json({ ok: false, error: "目标不在可写范围" }, 403);
        try {
          renameSync(abs, target);
          return json({ ok: true, path: target });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException)?.code;
          // EXDEV：跨设备（rename 不支持）——递归复制到目标，成功后源移入回收站（可恢复，不物理删除）
          if (code === "EXDEV") {
            try {
              cpSync(abs, target, { recursive: true, preserveTimestamps: true });
              const r = await trashToRecycle(abs);
              if (!r.ok) { try { rmSync(target, { recursive: true, force: true }); } catch { /* noop */ } return json({ ok: false, error: "跨设备移动失败: " + (r.error || "源清理失败") }, 500); }
              return json({ ok: true, path: target });
            } catch (e2) {
              try { rmSync(target, { recursive: true, force: true }); } catch { /* noop */ }
              return json({ ok: false, error: "跨设备移动失败: " + String((e2 as Error)?.message || e2) }, 500);
            }
          }
          return json({ ok: false, error: "移动失败: " + String((e as Error)?.message || e) }, 500);
        }
      }

      // POST /copy { path, targetDir } → 复制文件/文件夹到目标目录（cpSync recursive，源保留不动；行菜单「复制到」）
      if (route === "copy" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const path = typeof body?.path === "string" ? body.path : "";
        const targetDir = typeof body?.targetDir === "string" ? body.targetDir : "";
        if (!path || !targetDir) return json({ ok: false, error: "需要 path 和 targetDir" }, 400);
        const abs = normalize(path);
        const dest = normalize(targetDir);
        if (!isAbsolute(abs) || !isAbsolute(dest)) return json({ ok: false, error: "需要绝对路径" }, 400);
        // 源与目标目录都必须过 realpath 写授权（防根内 symlink 逃逸）
        if (!(await isWritableTarget(abs, ctx))) return json({ ok: false, error: "源路径不在可写范围" }, 403);
        if (!(await isWritableTarget(dest, ctx))) return json({ ok: false, error: "目标目录不在可写范围" }, 403);
        if (!existsSync(abs)) return json({ ok: false, error: "源不存在" }, 404);
        if (!existsSync(dest) || !lstatSync(dest).isDirectory()) return json({ ok: false, error: "目标不是目录或不存在" }, 400);
        const srcReal = abs.replace(/[\\/]+$/, "");
        const target = join(dest, lastSeg(abs));
        if (target === abs) return json({ ok: false, error: "目标与源相同" }, 400);
        // 目录不能复制进自己或自己的子孙目录（自包含递归）
        if (lstatSync(abs).isDirectory() && (dest === srcReal || dest.startsWith(srcReal + sep))) {
          return json({ ok: false, error: "不能复制到自身或其子目录" }, 400);
        }
        if (existsSync(target)) return json({ ok: false, error: "目标位置已存在同名条目" }, 409);
        if (!(await isWritableTarget(target, ctx))) return json({ ok: false, error: "目标不在可写范围" }, 403);
        try {
          cpSync(abs, target, { recursive: true, preserveTimestamps: true });
          return json({ ok: true, path: target });
        } catch (e) {
          // cpSync 无原子性：半途失败先撤目标，不留半份拷贝
          try { rmSync(target, { recursive: true, force: true }); } catch { /* noop */ }
          return json({ ok: false, error: "复制失败: " + String((e as Error)?.message || e) }, 500);
        }
      }

      // POST /entry-info { path } → 文件/目录基本信息（行菜单「文件信息」弹层用；读操作，与写操作同一安全面）
      // POST /doc-search { q, limit? } → 文档全文检索（标题+正文 FTS5 trigram，<3 字符 LIKE 降级）。
      // 代理 aiti-doc-center services.docs.search（进程内消费——客户端不直连兄弟扩展 HTTP，同 msg-smart 红线）。
      // doc-center 未装/未启用 → available:false（客户端隐藏「文档」页签）；db 未建库 → items:[]（无命中展示）。
      if (route === "doc-search" && req.method === "POST") {
        let body: any = null;
        try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid JSON body" }, 400); } // 与 pi-web file-index POST 同风格：非法 body 400
        const q = typeof body?.q === "string" ? body.q.trim().slice(0, 500) : "";
        const limit = Math.min(Math.max(Number(body?.limit) || 200, 1), 200);
        const svc = docsService();
        if (!svc) return json({ ok: true, available: false, items: [] });
        // 用 search(q, limit)（= queryDocs withSnippet:true）而非 query()——后者出口不透传 snippet，正文高亮就没了
        const raw = q ? svc.search!(q, limit) : [];
        const items = raw.map((d: any) => ({
          path: [d.root, d.relpath].filter(Boolean).join("/"), // 绝对路径（root=收集时 workspace，relpath 相对它）
          title: typeof d.title === "string" ? d.title : "",
          snippet: typeof d.snippet === "string" ? d.snippet : "", // 已含 <mark>…</mark> 高亮；客户端切分渲染，不走 innerHTML
          tags: Array.isArray(d.tags) ? d.tags : [],
          mtimeMs: typeof d.mtimeMs === "number" ? d.mtimeMs : 0,
        }));
        return json({ ok: true, available: true, items });
      }

      if (route === "entry-info" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const raw = typeof body?.path === "string" ? body.path : "";
        if (!raw || !isAbsolute(raw)) return json({ ok: false, error: "需要绝对路径" }, 400);
        const abs = normalize(raw);
        if (!(await isWritableTarget(abs, ctx))) return json({ ok: false, error: "路径不在可写范围" }, 403);
        try {
          const st = statSync(abs);
          const info: Record<string, unknown> = {
            name: lastSeg(abs),
            isDir: st.isDirectory(),
            size: st.size,
            mtimeMs: st.mtimeMs,
          };
          if (st.isDirectory()) {
            try { info.items = readdirSync(abs).length; } catch { info.items = null; }
          }
          return json({ ok: true, ...info });
        } catch {
          return json({ ok: false, error: "不存在或不可读" }, 404);
        }
      }

      // POST /archive-ticket { path } → 签发短时效下载票据（5 分钟，可重复使用；供 GET /archive 用）
      if (route === "archive-ticket" && req.method === "POST") {
        const body = await req.json().catch(() => null);
        const dir = typeof body?.path === "string" ? body.path : "";
        if (!dir || !isAbsolute(dir)) return json({ ok: false, error: "需要绝对路径" }, 400);
        const abs = normalize(dir);
        if (!(await isWritableTarget(abs, ctx))) return json({ ok: false, error: "路径不在可写范围" }, 403);
        if (!existsSync(abs) || !lstatSync(abs).isDirectory()) return json({ ok: false, error: "不存在或不是目录" }, 404);
        return json(issueArchiveTicket(abs));
      }

      // GET /archive?ticket= → 以 tar.gz 流式下载目录（无上限，流式响应）。
      // 路径不收 query（会落隧道/代理 access log）：先 POST /archive-ticket 换票据。
      if (route === "archive" && req.method === "GET") {
        const url = new URL(req.url);
        const abs = redeemArchiveTicket(url.searchParams.get("ticket"));
        if (!abs) return json({ ok: false, error: "票据无效或已过期" }, 403);
        if (!(await isWritableTarget(abs, ctx))) return json({ ok: false, error: "路径不在可写范围" }, 403);
        if (!existsSync(abs) || !lstatSync(abs).isDirectory()) return json({ ok: false, error: "不存在或不是目录" }, 404);
        const parent = dirname(abs);
        const name = lastSeg(abs);
        return new Response(
          new ReadableStream({
            start(controller) {
              const proc = spawn("tar", ["czf", "-", "-C", parent, name], { stdio: ["ignore", "pipe", "pipe"] });
              const errBuf: Buffer[] = [];
              proc.stderr.on("data", (d) => errBuf.push(d));
              proc.stdout.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
              proc.stdout.on("end", () => {
                const err = Buffer.concat(errBuf).toString().trim();
                if (err && proc.exitCode !== 0) {
                  controller.error(new Error("打包失败: " + err));
                } else {
                  controller.close();
                }
              });
              proc.stderr.on("error", () => {});
              proc.on("error", (e) => controller.error(e));
              proc.on("exit", (code) => {
                if (code !== 0 && code !== null) {
                  const err = Buffer.concat(errBuf).toString().trim();
                  controller.error(new Error(err || "tar 退出失败"));
                }
              });
            },
          }),
          {
            headers: {
              "content-type": "application/gzip",
              "content-disposition": `attachment; filename="${name.replace(/[^a-zA-Z0-9_.-]/g,"_")}.tar.gz"`,
            },
          }
        );
      }

      // ── 提交计划（git-ops M4：CRUD/启发式/学习在 folder state 层；执行直调引擎 /git/plan/*）──
      if (route === "git-plan-get" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const cwd = typeof body?.cwd === "string" ? body.cwd : "";
        if (!isAbsolute(cwd)) return json({ ok: false, error: "cwd required" }, 400);
        const stateDir = (ctx?.stateDir as string) || ((ctx?.configDir as string) ? join(ctx.configDir, "state") : "");
        return json({ ok: true, plan: loadPlan(stateDir, cwd) });
      }
      if (route === "git-plan-save" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const cwd = typeof body?.cwd === "string" ? body.cwd : "";
        if (!isAbsolute(cwd)) return json({ ok: false, error: "cwd required" }, 400);
        const stateDir = (ctx?.stateDir as string) || ((ctx?.configDir as string) ? join(ctx.configDir, "state") : "");
        const prev = loadPlan(stateDir, cwd);
        const plan = savePlan(stateDir, {
          id: prev?.id ?? newPlan(cwd, String(body?.baseHEAD || "")).id,
          cwd,
          baseHEAD: String(body?.baseHEAD || prev?.baseHEAD || ""),
          groups: Array.isArray(body?.groups) ? body.groups : [],
          excluded: Array.isArray(body?.excluded) ? body.excluded : [],
          createdAt: prev?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        });
        return json({ ok: true, plan });
      }
      if (route === "git-plan-group" && req.method === "POST") {
        // 启发式分组（两级的第一级）：目录/类型/状态规则 + 偏好（dirKey 共现合并 / 剔除建议）
        const body = await req.json().catch(() => ({}));
        const stateDir = (ctx?.stateDir as string) || ((ctx?.configDir as string) ? join(ctx.configDir, "state") : "");
        const files = Array.isArray(body?.files) ? body.files : [];
        return json({ ok: true, aiRefine: !!hostSvc?.get?.("aiti-git-review.aiReview"), ...groupHeuristic(stateDir, files) });
      }
      if (route === "git-plan-ai-refine" && req.method === "POST") {
        // AI 精修（git-ops M4 补遗）：中继 git-review aiReview 服务（spawn 会话 + settle 事件取回答）。
        // 服务缺席 → 503（client 按钮隐藏/降级为启发式结果）。
        const body = await req.json().catch(() => ({}));
        const svc = hostSvc?.get?.("aiti-git-review.aiReview") as
          | { groupReview?: (o: Record<string, unknown>) => Promise<unknown> }
          | undefined;
        if (!svc?.groupReview) return json({ ok: false, error: "aiti-git-review.aiReview 不可用" }, 503);
        try {
          const result = await svc.groupReview({
            origin: String(body?.origin || ""),
            basePath: String(body?.basePath || ""),
            cwd: String(body?.cwd || ""),
            groups: Array.isArray(body?.groups) ? body.groups : [],
            excluded: Array.isArray(body?.excluded) ? body.excluded : [],
          });
          return json({ ok: true, result });
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }
      if (route === "git-commit-ai-avail" && req.method === "POST") {
        // AI 生成提交信息可用性探测（docs/aiti-folder-commit-ai-message-plan.md）：服务版本旧（无 commitMessage）→ 按钮隐藏。
        const svc = hostSvc?.get?.("aiti-git-review.aiReview") as { commitMessage?: unknown } | undefined;
        return json({ ok: true, avail: typeof svc?.commitMessage === "function" });
      }
      if (route === "git-commit-ai-message" && req.method === "POST") {
        // AI 生成提交信息：中继 git-review aiReview.commitMessage（服务端只读收集 AGENTS.md + diff 上下文）；
        // 服务缺席 503（client 按钮隐藏）、服务抛错 502（错误透传 UI）。
        const body = await req.json().catch(() => ({}));
        const svc = hostSvc?.get?.("aiti-git-review.aiReview") as
          | { commitMessage?: (o: Record<string, unknown>) => Promise<{ message?: string }> }
          | undefined;
        if (typeof svc?.commitMessage !== "function") return json({ ok: false, error: "aiti-git-review.aiReview.commitMessage 不可用" }, 503);
        try {
          const result = await svc.commitMessage({
            origin: String(body?.origin || ""),
            basePath: String(body?.basePath || ""),
            cwd: String(body?.cwd || ""),
            files: Array.isArray(body?.files) ? body.files.map((f: unknown) => String(f)) : [],
            amend: !!body?.amend,
          });
          return json({ ok: true, message: String(result?.message || "") });
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 502);
        }
      }
      if (route === "git-plan-learn" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        const action = body?.action === "exclude" ? "exclude" : body?.action === "move" ? "move" : null;
        if (!action) return json({ ok: false, error: "action required" }, 400);
        const stateDir = (ctx?.stateDir as string) || ((ctx?.configDir as string) ? join(ctx.configDir, "state") : "");
        learn(stateDir, action, { file: body?.file, toKey: body?.toKey, path: body?.path });
        return json({ ok: true });
      }

      return json({ ok: false, error: "not found" }, 404);
    },
  },
};
