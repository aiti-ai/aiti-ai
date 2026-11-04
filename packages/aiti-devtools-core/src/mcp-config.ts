/**
 * aiti-devtools-core · MCP 配置注册（公共能力，载体无关）
 *
 * 把 <name>（默认 aiti-devtools）的 MCP 端点 url 写进常见 agent 工具的 mcp 配置：
 *   - targets:'auto' 只写已存在的配置文件（不污染用户环境）
 *   - configPaths 用户直接指定文件位置 → 自动识别结构（mcpServers/servers/mcp）
 *   - 原子写（tmp+rename）+ 备份 .bak；幂等（url 相同不写）；dryRun 只报告
 * 三处复用：aiti-devtools-vite 插件 / 独立桥 CLI / pi-web 扩展（统一调用）。
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";

/** 每次调用现取（不固化）——模块加载后才改 HOME/用户目录的测试与环境仍生效（lessons §6 欠账） */
const homeDir = () => homedir();

export interface McpTargetFile {
  /** 路径（projectDir 为项目根，home 文件忽略该参数） */
  path: (projectDir: string) => string;
  /** 写入结构 key：mcpServers（pi/claude/cursor/windsurf）| servers（vscode）| mcp（zed） */
  key: "mcpServers" | "servers" | "mcp";
  /** 是否项目级文件（.mcp.json / .vscode / .zed） */
  project?: boolean;
  /**
   * 显式嵌套容器路径（如 zcode 的 ["mcp","servers"]）。给定时跳过结构自动识别，
   * 沿路径逐层补建对象后落条目——用于 servers 容器不在顶层的配置格式。
   */
  keyPath?: string[];
  /**
   * 该目标的 stdio 条目形状构建器（各宿主 schema 异构）。
   * 缺省 = { type:"stdio", command:"node", args:[shimPath] }（pi/claude/cursor/zcode/…）。
   * opencode = { command:["node",shimPath], enabled:true }（command 数组 + enabled）。
   * 版本守卫 env map（AITI_SHIM_VERSION）由注册逻辑统一追加，不在此声明。
   */
  shimEntry?: (shimPath: string) => Record<string, unknown>;
  /** 版本守卫 env map 的字段名（默认 "env"；opencode = "environment"——其 schema 用异构名） */
  envKey?: string;
  /**
   * http 条目形状构建器（registerMcp 通用通路）。缺省 = { type:"http", url }。
   * opencode = { type:"remote", url, enabled:true }（其 schema 不认 "http" 类型，见 D23）。
   */
  httpEntry?: (url: string) => Record<string, unknown>;
}

/** 常见 agent 工具 → 配置文件（core 内置，可扩展） */
export const MCP_TARGETS: Record<string, McpTargetFile[]> = {
  // pi 实际读取 getAgentDir()/mcp.json（getAgentDir = $PI_CODING_AGENT_DIR，默认 ~/.pi/agent）；
  // ~/.config/mcp/mcp.json 是历史误记——默认 pi 不读它（探针实证 2026-09-10，见执行记录 P17）
  pi: [{ path: () => join(process.env.PI_CODING_AGENT_DIR || join(homeDir(), ".pi", "agent"), "mcp.json"), key: "mcpServers" }],
  zcode: [{ path: () => join(homeDir(), ".zcode", "cli", "config.json"), key: "mcpServers", keyPath: ["mcp", "servers"] }],
  opencode: [{
    path: () => join(homeDir(), ".config", "opencode", "opencode.json"),
    key: "mcpServers",
    keyPath: ["mcp"],
    shimEntry: (shimPath: string) => ({ type: "local", command: ["node", shimPath], enabled: true }),
    envKey: "environment", // opencode 的 env map 字段名异构；条目零顶层私有键（schema 严格拒未知键）
    httpEntry: (url: string) => ({ type: "remote", url, enabled: true }), // D23：http 类型对 opencode 非法
  }],
  claude: [
    { path: () => join(homeDir(), ".claude.json"), key: "mcpServers" },
    { path: (p) => join(p, ".mcp.json"), key: "mcpServers", project: true },
  ],
  // CodeBuddy Code（腾讯 cbc）：用户级 ~/.codebuddy/.mcp.json（官方 mcp.md：.mcp.json 推荐 /
  // mcp.json 已废弃；条目形状 mcpServers+stdio 与 claude 同构，2026-09-11 cbc mcp add 实测钉死）。
  // 项目级 .mcp.json 与 claude 同文件（claude 目标已覆盖），不重复注册。
  codebuddy: [{ path: () => join(homeDir(), ".codebuddy", ".mcp.json"), key: "mcpServers" }],
  cursor: [{ path: () => join(homeDir(), ".cursor", "mcp.json"), key: "mcpServers" }],
  windsurf: [{ path: () => join(homeDir(), ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" }],
  vscode: [{ path: (p) => join(p, ".vscode", "mcp.json"), key: "servers", project: true }],
  zed: [
    { path: () => join(homeDir(), ".config", "zed", "settings.json"), key: "mcp" },
    { path: (p) => join(p, ".zed", "settings.json"), key: "mcp", project: true },
  ],
};

export interface RegisterMcpOptions {
  /** MCP 端点完整 URL（如 http://localhost:5173/aiti/mcp/mcp） */
  url: string;
  /** 配置条目名，默认 'aiti-devtools'（多项目并存改名，提示/日志全跟随） */
  serverName?: string;
  /** 'auto'=扫描已存在的配置文件（默认）；或显式 ['pi','claude',…] */
  targets?: string[] | "auto";
  /** 用户直接指定配置文件位置（自动识别结构） */
  configPaths?: string[];
  /** 项目根（claude 项目 .mcp.json / vscode 工作区用；默认 process.cwd()） */
  projectDir?: string;
  /** 只报告不写 */
  dryRun?: boolean;
  /** 逐条日志回调（默认 console.log） */
  log?: (line: string) => void;
}

export interface RegisterMcpResult {
  ok: boolean;
  /** 至少一处写入发生（未 dryRun） */
  changed: boolean;
  results: { target: string; path: string; changed: boolean; error?: string }[];
  summary: string;
}

interface PlannedWrite {
  target: string;
  path: string;
  key: string;
  exists: boolean;
  keyPath?: string[];
  shimEntry?: (shimPath: string) => Record<string, unknown>;
  envKey?: string;
  httpEntry?: (url: string) => Record<string, unknown>;
}

/** 自动识别配置结构：mcpServers → servers → mcp；都没有 → 用 pi 风格 mcpServers 并提示 */
export function detectStructureKey(cfg: unknown): { key: "mcpServers" | "servers" | "mcp"; inferred: boolean } {
  if (cfg && typeof cfg === "object") {
    const c = cfg as Record<string, unknown>;
    if (c.mcpServers && typeof c.mcpServers === "object") return { key: "mcpServers", inferred: false };
    if (c.servers && typeof c.servers === "object") return { key: "servers", inferred: false };
    if (c.mcp && typeof c.mcp === "object") return { key: "mcp", inferred: false };
  }
  return { key: "mcpServers", inferred: true };
}

function readJson(path: string): { cfg: unknown; error?: string } {
  try {
    return { cfg: JSON.parse(stripBom(readFileSync(path, "utf8"))) };
  } catch {
    // JSONC 兼容（zed settings.json 等带注释/尾随逗号）：剥注释与尾随逗号再试
    try {
      const clean = stripJsonComments(stripBom(readFileSync(path, "utf8"))).replace(/,\s*([}\]])/g, "$1");
      return { cfg: JSON.parse(clean) };
    } catch (e) {
      return { cfg: null, error: "JSON 解析失败：" + String((e as Error)?.message || e) };
    }
  }
}

/** 去 UTF-8 BOM（部分编辑器写入） */
function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

/** 合法容器：对象且非数组（数组上挂字符串键会被 JSON 序列化静默丢弃） */
function isPlainContainer(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 轻量 JSONC 清洗：剥掉字符串外的双斜线注释与块注释（字符串内保留） */
function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; out += " "; continue; }
    out += c;
  }
  return out;
}

/** 沿 keyPath 逐层下钻（缺层补空对象，数组不算容器），返回 servers 容器（作用于已解析的 cfg 对象） */
function resolveContainer(cfg: Record<string, unknown>, keyPath: string[]): Record<string, unknown> {
  let cur: Record<string, unknown> = cfg;
  for (const k of keyPath) {
    if (!isPlainContainer(cur[k])) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  return cur;
}

/** 单个文件写入/删除条目（原子写 + 备份 .bak；幂等）；keyPath 显式给定时跳过结构识别 */
function patchFile(
  path: string,
  key: string,
  serverName: string,
  url: string | null,
  dryRun: boolean,
  log: (l: string) => void,
  keyPath?: string[],
  httpEntry?: (url: string) => Record<string, unknown>
): { changed: boolean; error?: string } {
  if (!existsSync(path)) return { changed: false, error: "文件不存在" };
  const r = readJson(path);
  if (r.error) return { changed: false, error: "JSON 解析失败：" + r.error };
  let cfg = r.cfg as Record<string, unknown> | null;
  if (!isPlainContainer(cfg)) return { changed: false, error: "配置不是对象" };
  const map = keyPath
    ? resolveContainer(cfg, keyPath)
    : (() => {
        const det = detectStructureKey(cfg);
        if (det.inferred) log(`  ⚠ ${path}：未识别结构（无 mcpServers/servers/mcp 字段），按 mcpServers 写入`);
        if (!isPlainContainer(cfg[det.key])) cfg[det.key] = {};
        return cfg[det.key] as Record<string, unknown>;
      })();
  const entry = map[serverName] && typeof map[serverName] === "object" && !Array.isArray(map[serverName]) ? (map[serverName] as Record<string, unknown>) : null;
  const prevUrl = entry && typeof entry.url === "string" ? entry.url : null;
  if (url === null) {
    if (!(serverName in map)) return { changed: false }; // 本就不存在（幂等）
    if (!dryRun) {
      delete map[serverName];
      try {
        writeAtomic(path, cfg);
      } catch (e) {
        return { changed: false, error: "写入失败：" + String((e as Error)?.message || e) };
      }
    }
    return { changed: true };
  }
  if (prevUrl === url) return { changed: false }; // 幂等
  map[serverName] = { ...(entry || {}), ...(httpEntry ? httpEntry(url) : { type: "http", url }) };
  if (!dryRun) {
    try {
      writeAtomic(path, cfg);
    } catch (e) {
      return { changed: false, error: "写入失败：" + String((e as Error)?.message || e) };
    }
  }
  return { changed: true };
}

/**
 * 原子写（lessons §0.5）：目录先行（path.dirname，win/posix 同构）→ tmp 写成功后才动原文件
 * （bak → 换入，失败原位恢复）。旧实现先 rename 原文件再 mkdirSync(path.split("/")…)——
 * Windows 路径算出空串 mkdir 必 ENOENT，原文件已被挪走 = 「写失败+丢原文件」双重事故。
 */
function writeAtomic(path: string, cfg: unknown) {
  const tmp = path + ".tmp";
  const bak = path + ".bak";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n"); // 先落 tmp：失败时原文件分毫未动
  if (existsSync(path)) {
    try { renameSync(path, bak); } catch { /* 备份失败不阻断——原文件保持在位，换入照走 */ }
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    if (existsSync(bak) && !existsSync(path)) {
      try { renameSync(bak, path); } catch { /* 恢复尽力；.bak 仍在，数据没丢 */ }
    }
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

function listPlannedWrites(opts: RegisterMcpOptions): PlannedWrite[] {
  const projectDir = opts.projectDir || process.cwd();
  const out: PlannedWrite[] = [];
  const hasConfigPaths = !!(opts.configPaths && opts.configPaths.length);
  const auto = (opts.targets === "auto" || !opts.targets) && !hasConfigPaths;
  // configPaths 显式给定时仅处理指定文件（不 auto 扫描其他 targets，避免误写用户其他配置）
  if (!hasConfigPaths) {
    const targets = auto ? Object.keys(MCP_TARGETS) : opts.targets;
    for (const t of targets) {
      const files = MCP_TARGETS[t];
      if (!files) continue;
      for (const f of files) {
        const p = f.path(projectDir);
        if (auto && !existsSync(p)) continue; // auto：只写已存在的（不新建，不污染用户环境）
        out.push({ target: t, path: p, key: f.key, exists: existsSync(p), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry });
      }
    }
  }
  for (const p of opts.configPaths || []) {
    const abs = p.replace(/^~(?=\/|$)/, homeDir());
    // configPaths 命中已知目标的默认文件时，必须带出该目标的异构定义（shimEntry/keyPath/envKey/httpEntry）——
    // 否则退化成默认 stdio 形状：opencode 这类严格 schema 宿主会拒收（D：实测把 local+environment 写成 stdio+env）。
    let matched: PlannedWrite | null = null;
    for (const [t, files] of Object.entries(MCP_TARGETS)) {
      for (const f of files) {
        if (f.path(projectDir) === abs) {
          matched = { target: t, path: abs, key: f.key, exists: existsSync(abs), keyPath: f.keyPath, shimEntry: f.shimEntry, envKey: f.envKey, httpEntry: f.httpEntry };
          break;
        }
      }
      if (matched) break;
    }
    out.push(matched ?? { target: abs, path: abs, key: "mcpServers", exists: existsSync(abs) });
  }
  return out;
}

/** 校验 targets 是否全部为已知目标；返回错误信息或 null（防拼错目标名静默成功） */
function assertKnownTargets(targets?: string[] | "auto"): string | null {
  if (!targets || targets === "auto") return null;
  const unknown = targets.filter((t) => !MCP_TARGETS[t]);
  return unknown.length ? `未知注册目标：${unknown.join("、")}（可用：${Object.keys(MCP_TARGETS).join("、")}）` : null;
}

/** 注册 MCP：把 <serverName> → { type:'http', url } 写进目标 agent 配置文件 */
export function registerMcp(opts: RegisterMcpOptions): RegisterMcpResult {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti-devtools";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l: string) => console.log(l));
  const results: RegisterMcpResult["results"] = [];
  let changed = false;

  for (const w of listPlannedWrites(opts)) {
    const r = patchFile(w.path, w.key, serverName, opts.url, dryRun, log, w.keyPath, w.httpEntry);
    if (r.error) {
      results.push({ target: w.target, path: w.path, changed: false, error: r.error });
      log(`  ✗ ${w.target} → ${w.path}：${r.error}`);
    } else {
      results.push({ target: w.target, path: w.path, changed: r.changed });
      if (r.changed) changed = true;
      if (!w.exists) log(`  ✓ ${w.target} → ${w.path}（新建）`);
      else log(`  ${r.changed ? "✓" : "·"} ${w.target} → ${w.path}${r.changed ? "" : "（已是最新）"}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}MCP ${serverName} → ${opts.url}${results.length ? "；" + results.map((r) => (r.error ? r.target + " ✗" : r.changed ? r.target + " ✓" : r.target + " ·")).join(" ") : "（无目标文件）"}`;
  return { ok, changed, results, summary };
}

/** 移除 <serverName> 条目（显式触发；默认不自动调用，怕误删用户配置） */
export function unregisterMcp(opts: { serverName?: string; configPaths?: string[]; projectDir?: string; dryRun?: boolean; log?: (l: string) => void }): RegisterMcpResult {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti-devtools";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l: string) => console.log(l));
  const results: RegisterMcpResult["results"] = [];
  let changed = false;
  const files = new Map<string, string[] | undefined>([...(opts.configPaths || []).map((p) => [p.replace(/^~(?=\/|$)/, homeDir()), undefined] as const)]);
  // 未显式指定文件时，才扫所有目标文件（存在即尝试移除）——显式指定则只处理指定文件（避免误删）
  if (!files.size) {
    for (const t of Object.keys(MCP_TARGETS)) {
      for (const f of MCP_TARGETS[t]) {
        const p = f.path(opts.projectDir || process.cwd());
        if (existsSync(p)) files.set(p, f.keyPath);
      }
    }
  }
  for (const [p, keyPath] of files) {
    if (!existsSync(p)) continue;
    const det = detectStructureKey(readJson(p).cfg);
    const r = patchFile(p, det.key, serverName, null, dryRun, log, keyPath);
    results.push({ target: p, path: p, changed: r.changed, error: r.error });
    if (r.changed) changed = true;
    if (r.error) log(`  ✗ ${p}：${r.error}`);
    else log(`  ${r.changed ? "✓" : "·"} ${p}${r.changed ? "：已移除 " + serverName : "（无该条目）"}`);
  }
  const ok = results.every((r) => !r.error);
  return { ok, changed, results, summary: `${dryRun ? "[dry-run] " : ""}移除 ${serverName}：${results.length ? results.map((r) => (r.error ? "✗ " : r.changed ? "✓ " : "· ")).join("") : "无目标文件"}` };
}

// ---------------------------------------------------------------------------
// aiti stdio shim 注册（固定名 `aiti`，URL 走环境变量 AITI_BRIDGE_URL，配置零 URL）
// ---------------------------------------------------------------------------

export interface RegisterShimOptions {
  /** shim 脚本绝对路径（写进条目 args） */
  shimPath: string;
  /** shim 版本号（注册方从 shim 文件头 SHIM_VERSION 读；版本守卫用） */
  version: number;
  /** 条目名，默认 'aiti'（固定名：dev/prod 共享同一份配置） */
  serverName?: string;
  /** 'auto'=扫描已存在的配置文件（默认）；或显式 ['zcode','pi',…] */
  targets?: string[] | "auto";
  /** 用户直接指定配置文件位置（自动识别结构；zcode 嵌套结构仅 targets 通道支持） */
  configPaths?: string[];
  projectDir?: string;
  dryRun?: boolean;
  /** 已注册版本 >= 当前版本时仍重写（修 shim 路径等场景） */
  force?: boolean;
  log?: (line: string) => void;
}

/** 旧版顶层版本键（已退役：zcode/opencode 等严格 schema 宿主会因未知键把整个条目判无效，注册时迁移剥除） */
const LEGACY_VERSION_FIELD = "_aitiShimVersion";
/** 版本守卫 env 变量名（env 是 stdio 条目标准字段，值域自由 string map，严格 schema 不拒自定义键） */
const SHIM_VERSION_ENV = "AITI_SHIM_VERSION";

/** 从条目的版本 env map 读已注册版本（无/非法 → 0 视为待升级/待迁移） */
function readShimEntryVersion(entry: Record<string, unknown>, envKey: string): number {
  const env = entry[envKey];
  if (!isPlainContainer(env)) return 0;
  return parseInt(String(env[SHIM_VERSION_ENV] ?? ""), 10) || 0;
}

/** 条目是否仍引用期望的 shim 路径（路径载体随宿主异构：args 数组 / command 数组；序列化包含判定，目标形状无关） */
function entryReferencesShimPath(entry: Record<string, unknown>, shimPath: string): boolean {
  return JSON.stringify(entry).includes(JSON.stringify(shimPath));
}

/**
 * 注册 aiti stdio shim 条目（幂等 + 版本守卫）：
 *   { type:'stdio', command:'node', args:[<shimPath>], env:{ AITI_SHIM_VERSION:'<version>' } }
 * 条目里不写任何 URL——运行时由 shim 读 env AITI_BRIDGE_URL 协商。
 * 版本守卫走条目 env map（envKey 按目标定制，默认 env / opencode = environment），
 * 不写任何顶层私有键——严格 schema 宿主（zcode/opencode 实证）会拒收未知顶层键。
 * 已注册版本 >= version 且 shim 路径未变且无旧版顶层键且未 force → 不改写（config 保持原样）。
 * 含用户自定义 env 变量的条目升级时合并保留（不覆盖）。
 */
export function registerAitiShim(opts: RegisterShimOptions): RegisterMcpResult {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l: string) => console.log(l));
  const results: RegisterMcpResult["results"] = [];
  let changed = false;

  for (const w of listPlannedWrites(opts)) {
    const outcome = ((): { changed: boolean; error?: string; note?: string } => {
    let cfg: Record<string, unknown> | null;
    if (!existsSync(w.path)) {
      // 显式 targets/configPaths 指定的缺失文件：新建（auto 扫描不会列出缺失文件）
      cfg = {};
    } else {
      const r = readJson(w.path);
      if (r.error) return { changed: false, error: "JSON 解析失败：" + r.error };
      cfg = r.cfg as Record<string, unknown> | null;
    }
    if (!isPlainContainer(cfg)) return { changed: false, error: "配置不是对象" };
    const map = w.keyPath
      ? resolveContainer(cfg, w.keyPath)
      : (() => {
          const det = detectStructureKey(cfg);
          if (!isPlainContainer(cfg[det.key])) cfg[det.key] = {};
          return cfg[det.key] as Record<string, unknown>;
        })();
    const existing = map[serverName] && typeof map[serverName] === "object" && !Array.isArray(map[serverName]) ? (map[serverName] as Record<string, unknown>) : null;
    const envKey = w.envKey || "env";
    const existingVer = existing ? readShimEntryVersion(existing, envKey) : 0;
    const hasLegacyField = !!existing && LEGACY_VERSION_FIELD in existing; // 旧顶层版本键 → 无条件迁移重写（剥除）
    // 异构形状一致性：shimEntry 目标（opencode 等）除版本/路径外还要形状正确——
    // 默认形状残留键（args/env）混入即视为损坏，须重写（实测 bug 写坏后守卫漏放）
    const shimShapeBroken = !!w.shimEntry && !!existing && ("args" in existing || ("env" in existing && envKey !== "env"));
    if (existing && !hasLegacyField && !shimShapeBroken && existingVer >= opts.version && !opts.force && entryReferencesShimPath(existing, opts.shimPath)) {
      return { changed: false, note: `已是最新（v${existingVer} >= v${opts.version}）` };
    }
    if (!dryRun) {
      // 各宿主 schema 异构：默认 stdio 形状，目标可用 shimEntry 定制（如 opencode 的 type local + command 数组）
      const entry: Record<string, unknown> = { ...(existing || {}), ...(w.shimEntry ? w.shimEntry(opts.shimPath) : { type: "stdio", command: "node", args: [opts.shimPath] }) };
      delete entry.url; // http 旧形态字段不保留（避免混合语义）
      delete entry[LEGACY_VERSION_FIELD]; // 旧顶层版本键退役，迁移进 env map
      if (w.shimEntry) { delete entry.args; delete entry.env; } // shimEntry 形状下清掉默认形状残留键（防坏形混写）
      const prevEnv = isPlainContainer(entry[envKey]) ? (entry[envKey] as Record<string, unknown>) : {};
      entry[envKey] = { ...prevEnv, [SHIM_VERSION_ENV]: String(opts.version) }; // 用户自定义 env 变量合并保留
      map[serverName] = entry;
      try {
        writeAtomic(w.path, cfg);
      } catch (e) {
        return { changed: false, error: "写入失败：" + String((e as Error)?.message || e) };
      }
    }
    return { changed: true, note: hasLegacyField ? `迁移（顶层版本键 → ${envKey}.${SHIM_VERSION_ENV}）` : existing ? `升级 v${existingVer} → v${opts.version}` : "新建" };
    })();
    results.push({ target: w.target, path: w.path, changed: outcome.changed, error: outcome.error });
    if (outcome.error) log(`  ✗ ${w.target} → ${w.path}：${outcome.error}`);
    else {
      if (outcome.changed) changed = true;
      log(`  ${outcome.changed ? "✓" : "·"} ${w.target} → ${w.path}${outcome.note ? "：" + outcome.note : ""}`);
    }
  }
  const ok = results.every((r) => !r.error);
  const summary = `${dryRun ? "[dry-run] " : ""}shim ${serverName} v${opts.version}（${opts.shimPath}）${results.length ? "；" + results.map((r) => (r.error ? r.target + " ✗" : r.changed ? r.target + " ✓" : r.target + " ·")).join(" ") : "（无目标文件）"}`;
  return { ok, changed, results, summary };
}

/** 移除 aiti shim 条目（只删 serverName 指定的那个，默认 'aiti'；targets 过滤同 registerAitiShim） */
export function unregisterAitiShim(opts: { serverName?: string; targets?: string[] | "auto"; configPaths?: string[]; projectDir?: string; dryRun?: boolean; log?: (line: string) => void }): RegisterMcpResult {
  const unknownErr = assertKnownTargets(opts.targets);
  if (unknownErr) return { ok: false, changed: false, results: [], summary: unknownErr };
  const serverName = opts.serverName || "aiti";
  const dryRun = !!opts.dryRun;
  const log = opts.log || ((l: string) => console.log(l));
  const results: RegisterMcpResult["results"] = [];
  let changed = false;
  const planned = listPlannedWrites({ targets: opts.targets, configPaths: opts.configPaths, projectDir: opts.projectDir });
  // unregister 语义与 register 不同：目标文件存在才移除，不存在不算错也不新建
  const files = planned.filter((w) => existsSync(w.path));
  for (const w of files) {
    const r = patchFile(w.path, w.key, serverName, null, dryRun, log, w.keyPath);
    results.push({ target: w.target, path: w.path, changed: r.changed, error: r.error });
    if (r.changed) changed = true;
    if (r.error) log(`  ✗ ${w.target} → ${w.path}：${r.error}`);
    else log(`  ${r.changed ? "✓" : "·"} ${w.target} → ${w.path}${r.changed ? "：已移除 " + serverName : "（无该条目）"}`);
  }
  const ok = results.every((r) => !r.error);
  return { ok, changed, results, summary: `${dryRun ? "[dry-run] " : ""}移除 shim ${serverName}：${results.length ? results.map((r) => (r.error ? "✗ " : r.changed ? "✓ " : "· ")).join("") : "无目标文件"}` };
}

// ---------------------------------------------------------------------------
// agent 启动自注册（各 agent 扩展启动/session_start 时调用；统一行为：任意外部
// agent 新启动即带 aiti-* 工具直连桥，配合 env AITI_BRIDGE_URL 指定桥地址）
// ---------------------------------------------------------------------------

export interface AutoRegisterAitiShimOptions {
  /** 注册目标（该 agent 自己的 target 名，如 'pi' / 'opencode' / 'zcode'） */
  targets: string[];
  /** 显式配置文件路径（优先于 targets 的默认路径；如 pi 需写 $PI_CODING_AGENT_DIR/mcp.json 而非 ~/.config/mcp/mcp.json） */
  configPaths?: string[];
  projectDir?: string;
  force?: boolean;
  log?: (line: string) => void;
}

/**
 * 逐候选解析 shim 文件路径（安装态优先，仓库检出兜底）：
 * env AITI_SHIM_PATH → <webRoot>/node_modules 安装态（@aiti-ai/aiti-bridge 经 extman reconcile 装入，
 * 与仓库位置解耦，换机/挪仓不断链）→ cwd 候选 → 常见仓库位置；找不到返回 null。
 */
export function resolveShimPathAuto(cwdCandidates?: string[]): { shimPath: string; version: number } | null {
  const installedCandidates = [
    process.env.AITI_WEB_ROOT && join(process.env.AITI_WEB_ROOT, "node_modules"),
    join(homeDir(), ".pi", "web", "node_modules"),
    join(homeDir(), ".pi", "web-dev", "node_modules"),
  ].filter((p): p is string => !!p).map((nm) => join(nm, "@aiti-ai", "aiti-bridge", "bin", "aiti-mcp-shim.cjs"));
  const candidates = [
    process.env.AITI_SHIM_PATH,
    ...installedCandidates,
    ...(cwdCandidates || []),
    join(homeDir(), "workspace", "aiti-ai", "packages", "aiti-bridge", "bin", "aiti-mcp-shim.cjs"),
  ].filter((p): p is string => !!p);
  for (const p of candidates) {
    try {
      const m = readFileSync(p, "utf8").match(/SHIM_VERSION\s*=\s*(\d+)/);
      if (m) return { shimPath: p, version: parseInt(m[1], 10) };
    } catch {}
  }
  return null;
}

/**
 * agent 扩展启动时的 shim 自注册（最佳努力，永不抛错）：
 * 幂等 + 版本守卫（已注册版本够新 → 配置零改写）；shim 文件找不到/写入失败 → 记日志返回 null。
 */
export function autoRegisterAitiShim(opts: AutoRegisterAitiShimOptions): RegisterMcpResult | null {
  const log = opts.log || (() => {});
  try {
    const found = resolveShimPathAuto();
    if (!found) {
      log("[aiti] stdio shim 未找到（可设 env AITI_SHIM_PATH 指向 aiti-mcp-shim.cjs），跳过 MCP 自注册");
      return null;
    }
    const r = registerAitiShim({
      shimPath: found.shimPath, version: found.version,
      configPaths: opts.configPaths,
      targets: opts.configPaths && opts.configPaths.length ? undefined : opts.targets,
      projectDir: opts.projectDir, force: opts.force, log,
    });
    return r;
  } catch (e) {
    log("[aiti] shim 自注册失败（忽略，不影响 agent 启动）：" + String((e as Error)?.message || e));
    return null;
  }
}
