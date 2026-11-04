/**
 * aiti-backup · 备份核心（纯 Node 零依赖，CommonJS —— 照 aiti-configs core.cjs 范式）
 *
 * 方案：docs/pi-web-ext-data-backup-extension-plan.md §2.4（M1 核心 + M2 增量硬链接）
 *
 * 算法：
 *   1. 扫描源 → 文件清单（path,size,mtimeMs；symlink 不跟随记 skipped）
 *   2. 新快照写临时目录 `.tmp-<ts>`：与上一快照 manifest 同 path 且 size+mtime 一致 →
 *      fs.link 硬链接（零拷贝）；否则 copyFile 流式复制（复制件尽力保留源 mtime）；
 *      链接不受目标盘支持（EXDEV/EPERM/EOPNOTSUPP/ENOSYS）→ 本轮整盘降级复制（mode:"full"）
 *   3. 写 manifest.json（快照完成标记，先写 .tmp 再 rename 保证原子）
 *   4. 临时目录原子 rename 为正式快照名
 *   5. 保留轮转（只删 snapshots/ 内、严格匹配时间戳命名的目录）
 *
 * 红线：源严格只读（从不写/删源）；中断安全（任意时刻 kill 只可能留 `.tmp-*` 残留，下次运行前清理）。
 */
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** 快照目录名：UTC ISO 安全化（2026-09-19T08-30-00-123Z），字典序 = 时间序 */
const SNAPSHOT_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const TMP_PREFIX = ".tmp-";
const MANIFEST_NAME = "manifest.json";

/** link 失败即整盘降级的错误码（目标 fs 不支持硬链接：exFAT/FAT32/跨盘/权限） */
const DEGRADE_CODES = new Set(["EXDEV", "EPERM", "EOPNOTSUPP", "ENOSYS", "ENOTSUP", "EACCES"]);

/** 源内运行态/噪音文件默认排除（方案 §2.2） */
const DEFAULT_EXCLUDES = new Set([".tmp", ".incomplete", ".DS_Store", "Thumbs.db", "desktop.ini"]);

function snapshotName(d) {
  return (d instanceof Date ? d : new Date(d || Date.now())).toISOString().replace(/[:.]/g, "-");
}

/** p 或其最近的已存在祖先的 realpath（目的地尚不存在时也能校验） */
async function nearestExisting(p) {
  let cur = path.resolve(p);
  for (;;) {
    try {
      return await fsp.realpath(cur);
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

/**
 * 目的地安全校验（方案 §2.10 防误删/防递归）：目的地不得等于/包含/被包含于任何源，
 * 不得为文件系统根 / 用户家目录 / pi-web dataRoot。校验用 realpath 归一化后再比对。
 * @returns {Promise<string>} 归一化后的目的地路径；不合法时 throw Error
 */
async function validateDestination(dest, sourcePaths, opts) {
  const o = opts || {};
  const destReal = await nearestExisting(dest);
  const isRoot = path.dirname(destReal) === destReal;
  if (isRoot) throw new Error("目的地不能是文件系统根（" + destReal + "）");
  const protectedRoots = [o.home, o.dataRoot].filter(Boolean).map((x) => path.resolve(x));
  for (const guard of protectedRoots) {
    if (destReal === guard) throw new Error("目的地不能是受保护根目录（" + destReal + "）");
  }
  for (const srcRaw of sourcePaths || []) {
    if (!srcRaw) continue;
    const src = await nearestExisting(srcRaw);
    if (destReal === src) throw new Error("目的地不能与备份源相同（" + src + "）");
    if (destReal.startsWith(src + path.sep)) throw new Error("目的地不能位于备份源内部（" + src + "）");
    if (src.startsWith(destReal + path.sep)) throw new Error("目的地不能包含备份源（" + src + "）");
  }
  return destReal;
}

/**
 * 扫描源目录 → 文件清单。不跟随符号链接（记 skipped）；默认排除运行态噪音名。
 * @returns {Promise<{files:{path,size,mtimeMs}[], skipped:{path,reason}[], totalBytes:number}>}
 *          path 一律 `/` 分隔的源内相对路径（跨平台稳定），按字典序稳定排序
 */
async function scanSource(srcPath, opts) {
  const o = opts || {};
  const root = path.resolve(srcPath);
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: relBase || ".", reason: "readdir:" + (e.code || e.message) });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const ent of entries) {
      const rel = relBase ? relBase + "/" + ent.name : ent.name;
      if (DEFAULT_EXCLUDES.has(ent.name)) continue;
      if (ent.isSymbolicLink()) {
        skipped.push({ path: rel, reason: "symlink" });
        continue;
      }
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      let st;
      try {
        st = await fsp.stat(abs);
      } catch (e) {
        skipped.push({ path: rel, reason: "stat:" + (e.code || e.message) });
        continue;
      }
      if (!st.isFile()) {
        skipped.push({ path: rel, reason: "not-regular-file" });
        continue;
      }
      files.push({ path: rel, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      totalBytes += st.size;
      if (o.onFile) o.onFile(files.length);
    }
  }
  await walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, skipped, totalBytes };
}

function relToAbs(root, rel) {
  return path.join(root, ...rel.split("/"));
}

/** snapshots/ 下的正式快照目录（升序 = 时间升序） */
async function listSnapshotDirs(snapRoot) {
  let entries;
  try {
    entries = await fsp.readdir(snapRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SNAPSHOT_NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

async function loadManifest(snapDir) {
  try {
    const raw = await fsp.readFile(path.join(snapDir, MANIFEST_NAME), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 最新一个「有 manifest（= 完整）」的快照；无名完整快照返回 null */
async function findLatestValidSnapshot(snapRoot) {
  const names = await listSnapshotDirs(snapRoot);
  for (let i = names.length - 1; i >= 0; i--) {
    const manifest = await loadManifest(path.join(snapRoot, names[i]));
    if (manifest) return { name: names[i], manifest };
  }
  return null;
}

/**
 * 快照备份（核心；M1 单源跑通 + M2 硬链接增量/降级/中断安全）
 *
 * @param {object} opts
 *   srcPath     源目录（严格只读）
 *   destRoot    备份目的地根（快照落 <destRoot>/<sourceId>/snapshots/<ts>/）
 *   sourceId    源命名空间
 *   prevManifest 上一快照 manifest（null = 首次/全量）
 *   prevSnapshotName 上一快照目录名（硬链接基底定位用）
 *   keepCount   保留份数（0 = 不轮转）
 *   disableLink 强制复制（模拟/规避不支持硬链接的盘）
 *   onProgress  ({phase,done,total,bytes,current}) => void（调用方自行节流）
 *   signal      {aborted:boolean} 协作式取消
 * @returns {{snapshotName, dir, manifest, pruned:string[]}}
 */
async function backupSnapshot(opts) {
  const t0 = Date.now();
  const srcRoot = path.resolve(opts.srcPath);
  const destRoot = path.resolve(opts.destRoot);
  const sourceId = String(opts.sourceId);
  const keepCount = Math.max(0, Number(opts.keepCount) || 0);
  const onProgress = opts.onProgress || null;
  const signal = opts.signal || null;
  const snapRoot = path.join(destRoot, sourceId, "snapshots");
  const prev = opts.prevManifest && opts.prevSnapshotName ? { name: opts.prevSnapshotName, manifest: opts.prevManifest } : null;

  // 1) 扫描
  if (onProgress) onProgress({ phase: "scan", done: 0, total: 0, bytes: 0, current: "" });
  const scan = await scanSource(srcRoot);
  const total = scan.files.length;
  const prevByPath = new Map();
  if (prev && Array.isArray(prev.manifest.files)) {
    for (const f of prev.manifest.files) prevByPath.set(f.path, f);
  }

  // 2) 临时目录逐项 link/copy
  let name = snapshotName();
  let tmpDir = path.join(snapRoot, TMP_PREFIX + name);
  await fsp.mkdir(tmpDir, { recursive: true });

  let linked = 0;
  let copied = 0;
  let bytesLinked = 0;
  let bytesCopied = 0;
  let linkBroken = false; // 目标盘不支持硬链接 → 本轮剩余全部复制
  const disableLink = !!opts.disableLink;
  const manifestFiles = [];
  let lastEmit = 0;

  for (let i = 0; i < total; i++) {
    if (signal && signal.aborted) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      const err = new Error("aborted");
      err.code = "ABORTED";
      throw err;
    }
    const f = scan.files[i];
    const rel = f.path;
    const outAbs = relToAbs(tmpDir, rel);
    await fsp.mkdir(path.dirname(outAbs), { recursive: true });

    let how = "copied";
    const prevFile = prevByPath.get(rel);
    if (!disableLink && !linkBroken && prevFile && prevFile.size === f.size && prevFile.mtimeMs === f.mtimeMs) {
      const prevAbs = relToAbs(path.join(snapRoot, prev.name), rel);
      try {
        await fsp.link(prevAbs, outAbs);
        how = "linked";
      } catch (e) {
        if (DEGRADE_CODES.has(e.code)) linkBroken = true; // 整盘降级，本轮不再尝试 link
        // 其余（prev 文件被清理等）→ 单文件退化为复制
      }
    }
    if (how !== "linked") {
      await fsp.copyFile(relToAbs(srcRoot, rel), outAbs);
      // 复制件尽力保留源 mtime（硬链接件与上一快照共享 inode，绝不 utimes）
      try {
        const sec = f.mtimeMs / 1000;
        await fsp.utimes(outAbs, sec, sec);
      } catch {}
    }
    if (how === "linked") {
      linked++;
      bytesLinked += f.size;
    } else {
      copied++;
      bytesCopied += f.size;
    }
    manifestFiles.push({ path: rel, size: f.size, mtimeMs: f.mtimeMs, how });

    if (onProgress) {
      const nowMs = Date.now();
      if (i === total - 1 || nowMs - lastEmit >= 200) {
        lastEmit = nowMs;
        onProgress({ phase: "copy", done: i + 1, total, bytes: bytesLinked + bytesCopied, current: rel });
      }
    }
  }

  // 3) manifest（完成标记；先写临时名再 rename 保证原子）
  const prevPaths = prev && Array.isArray(prev.manifest.files) ? prev.manifest.files : [];
  const havePaths = new Set(scan.files.map((f) => f.path));
  let removed = 0;
  for (const pf of prevPaths) if (!havePaths.has(pf.path)) removed++;
  const mode = prev && !disableLink && !linkBroken ? "incremental" : "full";
  const manifest = {
    version: 1,
    sourceId,
    srcPath: srcRoot,
    createdAt: new Date().toISOString(),
    mode,
    linkedTo: mode === "incremental" ? prev.name : null,
    files: manifestFiles,
    skipped: scan.skipped,
    stats: {
      total,
      linked,
      copied,
      bytesTotal: scan.totalBytes,
      bytesLinked,
      bytesCopied,
      removed,
      skipped: scan.skipped.length,
      durationMs: Date.now() - t0,
    },
  };
  const manifestPath = path.join(tmpDir, MANIFEST_NAME);
  await fsp.writeFile(manifestPath + ".tmp", JSON.stringify(manifest));
  await fsp.rename(manifestPath + ".tmp", manifestPath);

  // 4) 原子 rename 为正式快照名（同名冲突 → +1ms 重试）
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmpDir, path.join(snapRoot, name));
      break;
    } catch (e) {
      if (attempt < 5 && (e.code === "ENOTEMPTY" || e.code === "EEXIST")) {
        name = snapshotName(Date.now() + attempt + 1);
        continue;
      }
      throw e;
    }
  }

  // 5) 保留轮转
  const pruned = keepCount > 0 ? await pruneSnapshots(snapRoot, keepCount) : [];
  return { snapshotName: name, dir: path.join(snapRoot, name), manifest, pruned };
}

/**
 * 保留轮转（方案 §2.5）：仅删 `<snapRoot>/` 内、严格匹配时间戳命名的目录；
 * keepCount 超限删最旧。永不触碰 snapshots/ 之外任何路径。
 * @returns {Promise<string[]>} 被删快照名
 */
async function pruneSnapshots(snapRoot, keepCount) {
  const names = await listSnapshotDirs(snapRoot);
  if (names.length <= keepCount) return [];
  const victims = names.slice(0, names.length - keepCount);
  const removed = [];
  for (const name of victims) {
    if (!SNAPSHOT_NAME_RE.test(name)) continue; // 双重护栏
    await fsp.rm(path.join(snapRoot, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** 清理半成品（`.tmp-*`）；下次备份前自动调用，也可手动触发 */
async function cleanupTmp(snapRoot) {
  let entries;
  try {
    entries = await fsp.readdir(snapRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const ent of entries) {
    if (ent.isDirectory() && ent.name.startsWith(TMP_PREFIX)) {
      await fsp.rm(path.join(snapRoot, ent.name), { recursive: true, force: true });
      removed.push(ent.name);
    }
  }
  return removed;
}

/** 快照列表（含 manifest 摘要；无 manifest = 半成品 incomplete） */
async function listSnapshots(destRoot, sourceId) {
  const snapRoot = path.join(path.resolve(destRoot), sourceId, "snapshots");
  const names = await listSnapshotDirs(snapRoot);
  let tmpNames = [];
  try {
    tmpNames = (await fsp.readdir(snapRoot, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith(TMP_PREFIX))
      .map((e) => e.name);
  } catch {}
  const out = [];
  for (const name of names) {
    const m = await loadManifest(path.join(snapRoot, name));
    out.push({
      name,
      incomplete: !m,
      createdAt: m ? m.createdAt : null,
      mode: m ? m.mode : null,
      stats: m ? m.stats : null,
    });
  }
  for (const name of tmpNames) out.push({ name, incomplete: true, createdAt: null, mode: null, stats: null });
  out.sort((a, b) => (a.name < b.name ? -1 : 1));
  return out;
}

/**
 * 自动发现 state 层备份源：`<dataRoot>/<extId>/state/` 存在即一个源（方案 §2.2；
 * 放对层 = 自动被保护，扩展作者零接入）。跳过本扩展自身。
 */
async function discoverStateSources(dataRoot, opts) {
  const selfId = (opts && opts.selfId) || "aiti-backup";
  let entries;
  try {
    entries = await fsp.readdir(dataRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === selfId || ent.name.startsWith(".")) continue;
    const stateDir = path.join(dataRoot, ent.name, "state");
    try {
      const st = await fsp.stat(stateDir);
      if (st.isDirectory()) out.push({ id: ent.name, path: stateDir, kind: "state" });
    } catch {}
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

// ---------- 配置（config 层：ctx.configDir/backup.config.json） ----------

function defaultConfig() {
  return {
    version: 1,
    dest: "",
    keepCount: 7,
    // pi 会话数据默认开（§7 拍板 2）；置 false 关闭
    sourceOverrides: {},
    custom: [], // {id?, path, enabled}
  };
}

async function loadConfig(configDir) {
  const file = path.join(configDir, "backup.config.json");
  let raw = {};
  try {
    raw = JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {}
  const cfg = defaultConfig();
  for (const k of Object.keys(cfg)) if (raw[k] !== undefined) cfg[k] = raw[k];
  cfg.sourceOverrides = raw.sourceOverrides && typeof raw.sourceOverrides === "object" ? raw.sourceOverrides : {};
  cfg.custom = Array.isArray(raw.custom) ? raw.custom : [];
  return cfg;
}

async function saveConfig(configDir, cfg) {
  const file = path.join(configDir, "backup.config.json");
  const tmp = file + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2));
  await fsp.rename(tmp, file);
}

/**
 * 生效源清单：state 自动发现 + pi 会话数据（默认开，§7 拍板）+ 自定义。
 * sourceOverrides[id].enabled === false 关闭；自定义 {id?, path, enabled}。
 */
async function effectiveSources(cfg, opts) {
  const home = opts.home;
  const dataRoot = opts.dataRoot;
  const selfId = opts.selfId || "aiti-backup";
  const out = [];
  const seen = new Set();

  const stateSources = dataRoot ? await discoverStateSources(dataRoot, { selfId }) : [];
  for (const s of stateSources) {
    seen.add(s.id);
    const ov = cfg.sourceOverrides[s.id] || {};
    out.push({
      id: s.id,
      path: s.path,
      kind: "state",
      label: s.id,
      enabled: ov.enabled !== false, // 默认开，显式 false 关
    });
  }

  const piSessions = path.join(home, ".pi", "agent", "sessions");
  if (!seen.has("pi-sessions")) {
    const ov = cfg.sourceOverrides["pi-sessions"] || {};
    out.push({
      id: "pi-sessions",
      path: piSessions,
      kind: "pi-sessions",
      label: "pi 会话数据（~/.pi/agent/sessions）",
      enabled: ov.enabled !== false && fs.existsSync(piSessions),
    });
  }

  for (const c of Array.isArray(cfg.custom) ? cfg.custom : []) {
    if (!c || !c.path) continue;
    const id = c.id || path.basename(path.resolve(c.path)) || "custom";
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, path: path.resolve(c.path), kind: "custom", label: c.label || id, enabled: c.enabled !== false });
  }
  return out;
}

/** 运行历史追加（state 层 runs.jsonl；小 append，非阻塞） */
async function appendRun(stateDir, record) {
  try {
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.appendFile(path.join(stateDir, "runs.jsonl"), JSON.stringify(record) + "\n", "utf8");
  } catch {}
}

async function readRuns(stateDir, tail) {
  try {
    const raw = await fsp.readFile(path.join(stateDir, "runs.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, tail || 20)).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}

module.exports = {
  SNAPSHOT_NAME_RE,
  TMP_PREFIX,
  MANIFEST_NAME,
  DEFAULT_EXCLUDES,
  snapshotName,
  nearestExisting,
  validateDestination,
  scanSource,
  listSnapshotDirs,
  loadManifest,
  findLatestValidSnapshot,
  backupSnapshot,
  pruneSnapshots,
  cleanupTmp,
  listSnapshots,
  discoverStateSources,
  defaultConfig,
  loadConfig,
  saveConfig,
  effectiveSources,
  appendRun,
  readRuns,
};
