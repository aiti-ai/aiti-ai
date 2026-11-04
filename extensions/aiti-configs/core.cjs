/**
 * aiti-configs · 核心逻辑（CommonJS，Node 原生可跑）
 *
 * 复用：pi-web 扩展 index.ts（require 本模块）与 watchdog CLI（import 本模块）共用一份。
 * 职责：配置版本化（副本仓双向同步）+ 崩溃自检（selfcheck）。纯 Node 内置依赖，零第三方。
 * 设计：docs/aiti-configs-extension-plan.md
 */
"use strict";
const os = require("node:os");
const { execFile } = require("node:child_process");

// ⚠ 性能红线（2026-09-12 execSync→async 改造）：core.cjs 是 CJS，无法 import ESM 的
// _shared/exec-async.ts，故内嵌同语义实现（错误形态对齐 execFileSync，调用侧 catch(e) 不变）。
// 任何人不得在本文件重新引入 execFileSync/spawnSync/execSync。
function execFileAsync(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd: opts.cwd, encoding: "utf8",
      maxBuffer: opts.maxBuffer || 16 * 1024 * 1024,
      timeout: opts.timeout || 120000,
    }, (err, stdout, stderr) => {
      if (err) { err.stdout = String(stdout ?? ""); err.stderr = String(stderr ?? ""); reject(err); }
      else resolve(String(stdout ?? ""));
    });
  });
}

// per-repo 串行队列：sync/commit/restore 五步走等「读-改-写」序列原子化（失败吞掉不阻断后续）
const _coreQueues = new Map();
function queueRepo(key, fn) {
  const prev = _coreQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  _coreQueues.set(key, run.catch(() => {}));
  return run;
}
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// ---------------- 工具 ----------------
function expandPath(p, ctx) {
  if (!p) return p;
  let s = String(p);
  s = s.replace(/^~(?=\/|$)/, os.homedir());
  // 数据分层（config/cache）：旧 <dataDir> 占位符兼容读 configDir（配置文件里不会出现 cache 场景）
  s = s.replace(/<(?:dataDir|configDir)>/g, (ctx && (ctx.configDir || ctx.dataDir)) || "");
  s = s.replace(/<cacheDir>/g, (ctx && ctx.cacheDir) || "");
  s = s.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] || "");
  s = s.replace(/\{HOME\}/g, os.homedir()); // 跨服务器占位符
  return s;
}

// 内容级 {HOME} 转写（仅针对文本/JSON，防二进制乱码）；portablize=入库，localize=写回源
function portablize(text) {
  const home = os.homedir();
  if (!home) return text;
  try { return String(text).split(home).join("{HOME}"); } catch (e) { return text; }
}
function localize(text) {
  if (String(text).indexOf("{HOME}") < 0) return text;
  try { return String(text).split("{HOME}").join(os.homedir()); } catch (e) { return text; }
}

// 依赖声明名单（无条件进仓、豁免 sizeLimit，保 npm install 即用）
const MANIFEST_BASENAMES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"];
function isManifest(relPath) {
  const p = String(relPath);
  for (const n of MANIFEST_BASENAMES) {
    if (p === n || p.endsWith("/" + n)) return true;
  }
  return false;
}

// 涉密名单（黑名单制：加密 or 阻断；绝不排除）
function isProtectedFile(cfg, relPath) {
  const pats = (cfg && cfg.protected && cfg.protected.length) ? cfg.protected : [];
  return matchesAny(relPath, pats);
}

// 是否严格 JSON 文本（转写仅对文本生效）
function isJsonText(relPath) { return /\.jsonc?$/i.test(String(relPath)); }

// 二进制检测：读前 8KB 含 NUL 即判二进制
function isBinaryBuf(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// 简单 glob → RegExp：支持 **（跨目录）、*（段内）、?。相对路径匹配。
function globToRe(pat) {
  const p = String(pat).replace(/^\.\//, "");
  let re = "^";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // **：跨目录；**/（目录通配）→ 匹配零或任意层目录
        if (p[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
        else { re += ".*"; i++; }
      }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re);
}

const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+/g,
  /PRIVATE\s+KEY/g,
  /password\s*[:=]\s*\S+/gi,
  /passwd\s*[:=]\s*\S+/gi,
  /secret\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /access[_-]?token\s*[:=]\s*\S+/gi,
];
function scanSensitive(text) {
  const hits = [];
  const s = String(text || "");
  for (const re of SENSITIVE_PATTERNS) {
    re.lastIndex = 0;
    const m = s.match(re);
    if (m) hits.push(m[0].split(":")[0] || m[0].slice(0, 20));
  }
  return hits;
}

// ---- 密文 commit（可选 encrypt 配置；AES-256-GCM，确定性 IV） ----
// 格式：ENC1:<iv b64>:<tag b64>:<ct b64>
// 关键：IV = HMAC(key, 明文)[0:12]（确定性）——同明文→同密文→git hash 与真实内容联动（源不变仓就不变，noop/对比/恢复正确）
function encryptText(key, text) {
  const iv = crypto.createHmac("sha256", key).update(String(text)).digest().subarray(0, 12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "ENC1:" + iv.toString("base64") + ":" + c.getAuthTag().toString("base64") + ":" + ct.toString("base64");
}
function decryptText(key, s) {
  if (typeof s !== "string" || !s.startsWith("ENC1:")) return s; // 明文/旧副本原样
  try {
    const [, ivB, tagB, ctB] = s.split(":");
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64"));
    d.setAuthTag(Buffer.from(tagB, "base64"));
    return Buffer.concat([d.update(Buffer.from(ctB, "base64")), d.final()]).toString("utf8");
  } catch (e) { return s; }
}
// 默认密钥路径：{repo}/.git/configs-key —— 放 git 元数据目录，git 层面天然不跟踪（永不入仓，不依赖 hardExcludes 拦截）
function defaultKeyFile(cfg, ctx) {
  const repo = expandPath(cfg && cfg.repo, ctx);
  return repo ? path.join(repo, ".git", "configs-key") : "";
}
// 读密钥（keyFile 不存在返回 null）；key = 32 字节 Buffer（文件存 base64）
function loadKey(cfg, ctx) {
  try {
    const kf = expandPath((cfg.encrypt && cfg.encrypt.keyFile) || "", ctx) || defaultKeyFile(cfg, ctx);
    if (!kf || !fs.existsSync(kf)) return null;
    return Buffer.from(String(fs.readFileSync(kf, "utf8")).trim(), "base64");
  } catch (e) { return null; }
}
// 生成密钥文件（默认 {repo}/.git/configs-key，600 权限）；已存在则保留原密钥（不覆盖——防误点覆盖毁掉历史密文，换 key 需手动删文件）
function generateKey(cfg, ctx) {
  try {
    const kf = expandPath((cfg.encrypt && cfg.encrypt.keyFile) || "", ctx) || defaultKeyFile(cfg, ctx);
    if (!kf) return { ok: false, error: "未配置 repo，无法确定密钥路径" };
    if (fs.existsSync(kf)) return { ok: true, keyFile: kf, existed: true, keyB64: String(fs.readFileSync(kf, "utf8")).trim(), note: "密钥已存在，保留原密钥（如需更换请先删除该文件）" };
    fs.mkdirSync(path.dirname(kf), { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(kf, key.toString("base64") + "\n", { mode: 0o600 });
    try { fs.chmodSync(kf, 0o600); } catch (e) {}
    return { ok: true, keyFile: kf, keyB64: key.toString("base64") };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
// 该仓内相对路径是否应加密（按文件粒度：命中 encrypt.patterns 或 protected 涉密名单）。
// 刻意不用整目录（如 pi/agent/**），避免把源码/依赖声明一并加密、破坏明文 diff。
function isEncryptedPath(cfg, relPath) {
  if (!cfg.encrypt || !cfg.encrypt.enabled) return false;
  if (isProtectedFile(cfg, relPath)) return true; // 涉密名单：无论 patterns 是否列，一律加密
  const pats = (cfg.encrypt.patterns && cfg.encrypt.patterns.length) ? cfg.encrypt.patterns : [];
  return matchesAny(relPath, pats);
}

// ---------------- 配置 ----------------
const DEFAULT_CONFIG = {
  // 备份仓搬家（重构 §4.1）：.git 出源码目录，落 ~/.pi/configs（非 bare：工作区+对象库同处）；旧仓归档 ~/.pi/configs-archive-<date> 新起历史
  repo: "~/.pi/configs",
  branch: "main",
  identity: { name: "aiti-ai", email: "ai@aiti.local" },
  includes: [],
  // 黑名单制：默认全收，仅排除可重建物/运行时/下载物（依赖声明豁免见 isManifest）
  // 分层兜底（重构 §4.2）：web/data 分层后 cache/ 天然可排除；这里防「未改造扩展乱放」+ dev 实例整体忽略
  excludes: ["**/web-dev/**",
    "**/cache/**", "**/venv/**", "**/*-venv/**", "**/recordings/**",
    "**/ops/**", "**/state/**", "**/runtime/**", "**/bin/**", "**/instances/**", "**/acp/**",
    "**/novnc/**", "**/grdpwasm/**", "**/tts-cache/**", "**/webRDP/**", "**/view-common/**",
    "**/missions/projects/**", "**/ext-agents/**",
    "**/*-relay-state.json",
    "**/*.sock",
    "**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/.vite/**", "**/.turbo/**",
    "**/__pycache__/**", "**/target/**", "**/.gradle/**", "**/.cache/**", "**/coverage/**", "**/.nyc_output/**",
    // db/sqlite 全家（运行时；** 前缀保证任意层级命中）
    "**/*.db", "**/*.db-wal", "**/*.db-shm", "**/*.sqlite", "**/*.sqlite3", "**/*-wal", "**/*-shm",
    // 下载/二进制大文件（运行时自动下载）
    "**/*.zip", "**/*.tar", "**/*.gz", "**/*.tgz", "**/*.7z", "**/*.rar", "**/*.wasm", "**/*.pwarc",
    "**/monaco/**", "**/bin/cc-connect", "**/*.pack",
    // 运行时数据/日志/缓存/会话/备份
    "**/sessions/**", "**/*.jsonl", "**/logs/**", "**/tmp/**", "**/*.log", "**/tool-output-artifacts/**",
    "**/missions/index/**", "**/model-usage/**", "**/*.bak*", "**/mcp-cache.json", "**/*-cache.json", "**/run-history.jsonl",
  ],
  // 涉密名单：黑名单制——加密 or 阻断，绝不排除（auth.json 不再被丢）
  protected: ["**/auth.json", "**/*token*", "**/credentials*", "**/*.key", "**/*.pem", "**/*.p12", "**/*.jks", "**/*.asc", "**/.configs-key", "**/bridge-registry.json", "**/agent-accounts.json"],
  hardExcludes: ["**/.git/**", "**/.aiti-trace/**", "**/.git/"], // 仅仓元数据/追踪（git 自身）
  sizeLimitKB: 2048,
  commit: { mode: "smart", batch: 20, template: "chore(configs): {{summary}}",
    scopes: ["pi-agent", "aiti-cmd", "aiti-prompts", "aiti-extman", "ai-helper", "ai-created", "aiti-configs"] },
  watch: false,
  sentry: { enabled: false, intervalSec: 60, bridgeUrl: null, fingerprints: [] },
  encrypt: { enabled: false, algo: "aes-256-gcm", keyFile: "", patterns: ["pi/agent/auth.json", "pi/agent/models.json", "pi/agent/models-store.json", "pi/pi-session-manager/auth_tokens.json", "pi/service-tunnels/*.json", "**/agent-accounts.json"] }, // 按文件粒度加密
};

// 自身配置目录（重构 §4.2）：ai-configs.json 是备份系统自己的命根子，不随扩展 dataDir 走——
// 独立落 ~/.pi/configs-self/ 并经 configs-self include 进备份面（防自丢）。
const SELF_CONFIG_DIR = process.env.AITI_CONFIGS_SELF_DIR || path.join(os.homedir(), ".pi", "configs-self");
function selfConfigFile() { return path.join(SELF_CONFIG_DIR, "ai-configs.json"); }

function loadConfig(legacyDir) {
  const file = selfConfigFile();
  // 一次性迁移：旧位置（<dataDir>/ai-configs.json）存在且新位置缺席 → 复制迁入（旧文件原地保留作兜底）
  if (!fs.existsSync(file) && legacyDir) {
    const legacy = path.join(legacyDir, "ai-configs.json");
    if (fs.existsSync(legacy)) {
      try {
        fs.mkdirSync(SELF_CONFIG_DIR, { recursive: true });
        fs.copyFileSync(legacy, file);
        try { fs.writeFileSync(legacy + ".migrated-to-configs-self", "本配置已迁移到 " + file + "（本文件保留仅作迁移前兜底）\n"); } catch (e) {}
        console.log("[aiti-configs] 自身配置已迁移：" + legacy + " → " + file);
      } catch (e) { console.warn("[aiti-configs] 自身配置迁移失败（继续用旧位置）:", (e && e.message) || e); }
    }
  }
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {}
  return {
    ...DEFAULT_CONFIG,
    ...c,
    identity: { ...DEFAULT_CONFIG.identity, ...(c.identity || {}) },
    commit: { ...DEFAULT_CONFIG.commit, ...(c.commit || {}) },
    sentry: { ...DEFAULT_CONFIG.sentry, ...(c.sentry || {}) },
    encrypt: { ...DEFAULT_CONFIG.encrypt, ...(c.encrypt || {}) },
    remote: { ...DEFAULT_CONFIG.remote, ...(c.remote || {}) },
    protected: [...(DEFAULT_CONFIG.protected || []), ...(c.protected || [])], // 涉密合并（默认 + 用户追加）
    _file: file,
  };
}
function saveConfig(cfg) {
  const { _file, ...rest } = cfg;
  const out = { ...rest, commit: cfg.commit, identity: cfg.identity, sentry: cfg.sentry };
  try { fs.mkdirSync(path.dirname(_file), { recursive: true }); fs.writeFileSync(_file, JSON.stringify(out, null, 2)); return true; } catch (e) { return false; }
}

// 收集 includes：手写 + 扩展 configs 声明聚合（globalThis.__piWebExt.all()）
function collectIncludes(cfg, ctx) {
  const out = [];
  const seen = new Set();
  const push = (it, src) => {
    if (!it || !it.path) return;
    const key = String(it.path) + "|" + String(it.dest || "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...it, _src: src });
  };
  for (const it of cfg.includes || []) push(it, "ai-configs.json");
  try {
    const reg = (ctx && ctx.registry) || (globalThis.__piWebExt);
    const all = reg && typeof reg.all === "function" ? reg.all() : [];
    for (const ext of all) {
      const list = ext && ext.ext && ext.ext.configs && ext.ext.configs.includes;
      if (!Array.isArray(list)) continue;
      for (const it of list) push({ ...it, _ext: ext.ext.id || "?" }, "ext:" + (ext.ext.id || "?"));
    }
  } catch (e) {}
  return out;
}

function matchesAny(relPath, patterns) {
  for (const p of patterns || []) {
    try { if (globToRe(p).test(relPath)) return true; } catch (e) {}
  }
  return false;
}

// ---------------- 仓操作（git，cwd=repo） ----------------
async function git(repo, argsArr, opts = {}) {
  const argsList = Array.isArray(argsArr) ? argsArr : String(argsArr).split(/\s+/).filter(Boolean);
  try {
    const out = await execFileAsync("git", argsList, { cwd: repo, maxBuffer: 16 * 1024 * 1024, ...opts });
    return { ok: true, out: String(out || "") };
  } catch (e) {
    return { ok: false, out: String((e.stderr && e.stderr.toString()) || e.message || "") };
  }
}

async function ensureRepoUnq(cfg, ctx) {
  const repo = expandPath(cfg.repo, ctx);
  try { fs.mkdirSync(repo, { recursive: true }); } catch (e) {}
  let r = await git(repo, ["rev-parse", "--is-inside-work-tree"]);
  if (!r.ok || String(r.out).trim() !== "true") {
    await git(repo, ["init", "-q"]);
    await git(repo, ["checkout", "-q", "-b", cfg.branch || "main"]);
    // 搬仓引导（重构 §4.1）：新仓首建且检测到归档旧仓 → 落迁移提示，供人/AI 识别旧历史去向
    try {
      const piDir = path.join(os.homedir(), ".pi");
      const archives = fs.readdirSync(piDir).filter((n) => /^configs-archive-/.test(n)).sort();
      const note = path.join(repo, "MIGRATION-NOTE.md");
      if (archives.length && !fs.existsSync(note)) {
        fs.writeFileSync(note,
          "# configs 仓迁移说明\n\n本仓（" + repo + "）于搬仓重构后新起历史（旧历史全是 18G 时代快照，无回滚价值）。\n\n" +
          "旧仓整体归档在：`~/.pi/" + archives.join("`、`~/.pi/") + "`（含全部旧 commit，确认无需回看后可删）。\n");
      }
    } catch (e) {}
  }
  if (!(await git(repo, ["config", "user.email"])).ok || !(await git(repo, ["config", "user.name"])).ok) {
    await git(repo, ["config", "user.email", (cfg.identity && cfg.identity.email) || "ai@aiti.local"]);
    await git(repo, ["config", "user.name", (cfg.identity && cfg.identity.name) || "aiti-ai"]);
  }
  return repo;
}

// 把单个源文件同步到仓副本；返回 {copied, skipped, reason} 或 null（无需同步）
function syncOne(src, destAbs, destRel, cfg, ctx) {
  let st;
  try { st = fs.statSync(src); if (!st.isFile()) return null; } catch (e) { return null; }
  const manifest = isManifest(destRel);
  const limitKB = cfg.sizeLimitKB || 2048;
  // 依赖声明豁免 sizeLimit（#2）：package.json/lock/yarn.lock 等无条件进仓，保 npm install 即用
  if (!manifest && st.size > limitKB * 1024) return { skipped: 1, reason: "big>" + limitKB + "KB" };
  let buf;
  try { buf = fs.readFileSync(src); } catch (e) { return null; }
  // 密文 commit（git filter 方案）：加密由 git 的 clean/smudge filter 在 add/checkout 时自动做，
  // 仓副本保持明文（diff/状态/冲突可见）。这里只决定加密/敏感/转写策略。
  const willEnc = isEncryptedPath(cfg, destRel) || isProtectedFile(cfg, destRel);
  if (willEnc) {
    if (!loadKey(cfg, ctx)) return { skipped: 1, reason: "encrypt:no-key（需 configs_key generate 生成密钥）" };
  }
  // 二进制检测（#F）：非文本且非依赖声明，读前 8KB 含 NUL 判二进制，避免误收下载物/大二进制
  const isBin = isBinaryBuf(buf);
  if (!manifest && !willEnc && isBin && st.size > 1024 * 128) return { skipped: 1, reason: "binary:big" };
  // 敏感扫描：加密文件直接跳过（密文入对象库，公开仓安全）；非加密命中敏感则拦
  let content = buf.toString("utf8");
  if (!willEnc) {
    const sens = scanSensitive(content);
    if (sens.length) return { skipped: 1, reason: "sensitive:" + sens[0] };
  }
  // 内容级 {HOME} 转写：仅对严格 JSON 文本（#A）
  if (isJsonText(destRel)) content = portablize(content);
  try {
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.writeFileSync(destAbs, content);
    return { copied: 1, bytes: st.size };
  } catch (e) { return { skipped: 1, reason: "io:" + (e.message || "") }; }
}

// 同步所有 includes 到仓副本；返回 { synced:[{src,dest}], skipped:[{src,reason}], errors:[] }
// 确保 git filter 配置（git filter 方案：工作区明文、对象库密文）。encrypt 开时在 sync 前调用；关时清理。
async function ensureGitFilterUnq(cfg, ctx) {
  const en = cfg.encrypt;
  const repo = await ensureRepoUnq(cfg, ctx);
  const gitAttr = path.join(repo, ".gitattributes");
  if (!en || !en.enabled) {
    // 关闭：移除 aiti-configs 写入的 filter 行 + filter/merge 配置（避免 git add 仍加密）
    if (fs.existsSync(gitAttr)) {
      // 移除 aiti-configs 写入的所有行（filter 行 + 防自身加密行）；全空则删文件
      const lines = fs.readFileSync(gitAttr, "utf8").split("\n").filter((l) => !l.includes("filter=aiti-enc") && !l.includes("!filter") && !l.includes("!merge") && l.trim() !== "");
      if (lines.length) fs.writeFileSync(gitAttr, lines.join("\n") + "\n"); else fs.unlinkSync(gitAttr);
    }
    for (const k of ["filter.aiti-enc", "merge.aiti-enc"]) await git(repo, ["config", "--remove-section", k]);
    return { ok: true, mode: "off" };
  }
  const keyFile = expandPath(en.keyFile || defaultKeyFile(cfg, ctx), ctx);
  const fm = path.join(__dirname, "filter.mjs");
  if (!fs.existsSync(fm)) return { ok: false, error: "filter.mjs 不存在：" + fm };
  // pats = encrypt.patterns ∪ protected（并集）——syncOne 用 isEncryptedPath||isProtectedFile 判定加密，
  // .gitattributes 必须覆盖全部将被加密项，否则 protected 命中但 patterns 未列的文件会明文入库（安全缺陷 #1）
  const pats = [...new Set([...(en.patterns && en.patterns.length ? en.patterns : []), ...(cfg.protected || [])])];
  // 注意：永远不要加密 .gitattributes 自身（git-crypt 明确警告）——显式排除，防 pats 配 `*`/`**` 误加密
  const lines = pats.map((p) => p + " filter=aiti-enc diff=aiti-enc merge=aiti-enc");
  lines.push(".gitattributes !filter !diff !merge");
  fs.writeFileSync(path.join(repo, ".gitattributes"), lines.join("\n") + "\n");
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // shell 引号（防路径含空格）
  const cmd = (sub) => "AITI_CONFIGS_KEY_FILE=" + q(keyFile) + " node " + q(fm) + " " + sub;
  await git(repo, ["config", "filter.aiti-enc.clean", cmd("enc")]);
  await git(repo, ["config", "filter.aiti-enc.smudge", cmd("dec")]);
  await git(repo, ["config", "filter.aiti-enc.required", "true"]);
  await git(repo, ["config", "merge.aiti-enc.driver", cmd("merge %A %O %B")]);
  await git(repo, ["config", "diff.aiti-enc.textconv", cmd("textconv")]); // 明文 diff 可读（restore 预览/版本对比）
  return { ok: true, mode: "filter", keyFile, patterns: pats };
}

async function syncToRepoUnq(cfg, ctx) {
  const repo = await ensureRepoUnq(cfg, ctx);
  await ensureGitFilterUnq(cfg, ctx); // 密文 commit：确保 clean/smudge/merge filter 已配置（encrypt 开时）
  const inc = collectIncludes(cfg, ctx);
  const res = { synced: [], skipped: [], errors: [], bytes: 0 }; // bytes=本次同步量（体积自防御：selfcheck/snapshot 闸门数据源）
  for (const item of inc) {
    const srcRoot = expandPath(item.path, ctx);
    const destRel = String(item.dest || path.basename(srcRoot)).replace(/\/+$/, ""); // dest 去尾斜杠
    // 收录/排除判定统一用「相对源根」路径（git 同款；globToRe/expandPath 不掺和匹配）
    const exclPatterns = [...(cfg.hardExcludes || []), ...(cfg.excludes || [])];
    // 预编译一次排除正则（避免每个文件重复 new RegExp——大目录下 9 万+ 文件 × 50+ 模式 = 数百万次编译，是 globToRe 热点根源）
    const exclRes = [];
    for (const p of exclPatterns) { try { exclRes.push(globToRe(p)); } catch (e) {} }
    const decide = (rel) => { for (const re of exclRes) { try { if (re.test(rel)) return true; } catch (e) {} } return false; };
    // 支持通配源路径（** 目录全量 / **/*.json）：逐个文件，全部走黑名单排除判定
    const star = String(item.path).includes("*");
    if (star) {
      const baseStar = srcRoot.slice(0, srcRoot.indexOf("*"));
      const files = [];
      const walk = (dir) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const en of ents) {
          if (en.name === ".git" || en.name === ".aiti-trace") continue; // 仓元数据不跟
          const fp = path.join(dir, en.name);
          if (en.isDirectory()) {
            if (en.name === "node_modules") continue;
            // 目录级剪枝：目录 rel + "/" 命中排除模式（如 **/aiti-ai-input/**、**/sessions/**）→ 整棵子树跳过，不必逐文件遍历
            const dRel = path.relative(baseStar, fp).split(path.sep).join("/");
            if (dRel && decide(dRel + "/")) continue;
            walk(fp);
          }
          else if (en.isFile()) files.push(fp);
        }
      };
      if (fs.existsSync(baseStar)) walk(baseStar);
      for (const fp of files) {
        // 相对源根路径（自动处理黑名单根 agent/**、web/** 下的任意层级）
        const rel = path.relative(baseStar, fp).split(path.sep).join("/");
        if (decide(rel)) { res.skipped.push({ src: fp, reason: "excluded" }); continue; }
        const destAbs = path.join(repo, destRel, rel);
        const r = syncOne(fp, destAbs, destRel + "/" + rel, cfg, ctx);
        if (r && r.copied) { res.synced.push({ src: fp, dest: path.relative(repo, destAbs) }); res.bytes += r.bytes || 0; }
        else if (r && r.skipped) res.skipped.push({ src: fp, reason: r.reason });
      }
    } else {
      const destAbs = path.join(repo, destRel);
      if (decide(destRel)) { res.skipped.push({ src: srcRoot, reason: "excluded" }); continue; }
      const r = syncOne(srcRoot, destAbs, destRel, cfg, ctx);
      if (r && r.copied) { res.synced.push({ src: srcRoot, dest: destRel }); res.bytes += r.bytes || 0; }
      else if (r && r.skipped) res.skipped.push({ src: srcRoot, reason: r.reason });
      else if (fs.existsSync(srcRoot)) res.skipped.push({ src: srcRoot, reason: "dir-or-io" });
    }
  }
  return res;
}

// 仓副本 vs HEAD 状态（sync 后调用）；返回 { changed:[{path,status}], clean, stat }
async function gitStatusUnq(cfg, ctx) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const r = await git(repo, ["status", "--porcelain"]);
  const changed = [];
  for (const line of String(r.out || "").split("\n").filter(Boolean)) {
    const st = line.slice(0, 2).trim() || "M";
    const fp = line.slice(3).trim();
    if (!fp) continue;
    if (fp === "ai-configs.json") continue; // 自身不进 status 摘要（配置文件本身也可版本化，但避免噪音）
    changed.push({ path: fp, status: st });
  }
  const inc = collectIncludes(cfg, ctx);
  const destRelOf = (i) => String(i.dest || path.basename(String(i.path || "")));
  const encryptFiles = inc.filter((i) => isEncryptedPath(cfg, destRelOf(i))).map((i) => destRelOf(i));
  return { repo, changed, clean: changed.length === 0, raw: r.out || "", encryptFiles };
}

// 生成提交信息（smart：按变更路径猜 scope + 摘要；离线降级模板）
function buildCommitMessage(cfg, status) {
  const changed = status.changed || [];
  const scopeMap = {};
  for (const c of changed) {
    // 路径规范化后匹配 scope：pi/agent/settings.json → pi-agent；ext/aiti-cmd/… → aiti-cmd（目录级路径去尾斜杠）
    const norm = String(c.path).replace(/\/+$/, "").replace(/\//g, "-");
    const scope = (cfg.commit.scopes || []).find((s) => norm.includes(s)) || "configs";
    scopeMap[scope] = (scopeMap[scope] || 0) + 1;
  }
  const scopes = Object.keys(scopeMap);
  const scope = scopes.length === 1 ? scopes[0] : "configs";
  const n = changed.length;
  const summary = n + " 个文件变更（" + scopes.join("/") + "）";
  return cfg.commit.template.replace("{{summary}}", summary).replace("{{scope}}", scope) + "\n\n" +
    changed.slice(0, 15).map((c) => (c.status === "D" ? "删除 " : "变更 ") + c.path).join("\n");
}

// ---- commit 前预扫描（块 F）：检测仓内二进制/超大/异常文件，自动写 .gitignore 防误收 ----
async function scanStagedUnq(cfg, ctx) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const r = await git(repo, ["ls-files", "-z", "--exclude-standard"]);
  const hits = [];
  const list = String(r.out || "").split("\0").filter(Boolean);
  const limitKB = cfg.sizeLimitKB || 2048;
  for (const rel of list) {
    if (isManifest(rel)) continue; // 依赖声明豁免
    const abs = path.join(repo, rel);
    let st, buf;
    try { st = fs.statSync(abs); } catch (e) { continue; }
    if (!st.isFile()) continue;
    const isBin = (() => { try { buf = fs.readFileSync(abs); return isBinaryBuf(buf); } catch (e) { return false; } })();
    if (isBin && st.size > 1024 * 128) { hits.push({ path: rel, reason: "binary:" + (st.size / 1024).toFixed(0) + "KB" }); continue; }
    if (!isBin && st.size > limitKB * 1024) { hits.push({ path: rel, reason: "big>" + limitKB + "KB" }); }
  }
  return { repo, hits, tracked: list.length };
}

// 自动写 .gitignore（幂等，带 aiti-configs auto-block 注释块），供 scanStaged 命中项防再入
async function autoGitignoreUnq(cfg, ctx, scanned) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const gi = path.join(repo, ".gitignore");
  if (!scanned || !scanned.hits || !scanned.hits.length) return { written: 0 };
  // 已存在内容（若文件不是 aiti-configs 托管，先保留尾部空行分节）
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  let block = existing;
  if (block && !block.endsWith("\n")) block += "\n";
  const mark = "# aiti-configs auto-block";
  if (block.indexOf(mark) < 0) { block = (block ? block + "\n" : "") + mark + "\n"; }
  const blockEnd = "# aiti-configs auto-block-end";
  // 用命中项组装一行一模式（保留原始相对路径，去前导 /）
  const lines = scanned.hits.map((h) => "/" + h.path).sort();
  let out = block;
  // 把旧 auto-block 段整体替换（幂等）
  const start = out.indexOf(mark);
  if (start >= 0) {
    const end = out.indexOf(blockEnd, start);
    const tail = end >= 0 ? out.slice(end + blockEnd.length) : "";
    out = out.slice(0, start) + mark + "\n" + lines.join("\n") + "\n" + blockEnd + "\n" + tail.replace(/^\n+/, "");
  } else {
    out = block + lines.join("\n") + "\n" + blockEnd + "\n";
  }
  try { fs.writeFileSync(gi, out); return { written: lines.length }; } catch (e) { return { written: 0, error: e.message }; }
}

async function gitCommitUnq(cfg, ctx, message) {
  const repo = await ensureRepoUnq(cfg, ctx);
  await syncToRepoUnq(cfg, ctx); // 关键：commit 前先同步源→仓副本（否则源改动永远进不了提交，status 干净 → noop 丢改动）
  const st = await gitStatusUnq(cfg, ctx);
  // 预扫描（块 F）：若存在大二进制/超大文件，先自动写 .gitignore，再重同步（gitignore 生效后自然排除）
  const scanned = await scanStagedUnq(cfg, ctx);
  if (scanned.hits.length && scanned.hits.length < 200) {
    const w = await autoGitignoreUnq(cfg, ctx, scanned);
    if (w.written) { await syncToRepoUnq(cfg, ctx); }
  }
  const st2 = await gitStatusUnq(cfg, ctx);
  const status = st2.clean ? st : st2;
  if (status.clean) {
    const sync = await gitSyncUnq(cfg, ctx);
    return { ok: true, noop: true, hash: ((await git(repo, ["rev-parse", "--short", "HEAD"]))).out.trim(), message: "", sync, scanned: scanned.hits };
  }
  await git(repo, ["add", "-A"]);
  // 依赖声明强制进仓（bug2）：真实 agent/npm/.gitignore = `*` 会让 git add 忽略 npm/*，
  // 但 package.json 是 npm install 即用的依据，须用 -f 强制加入（不受仓内 .gitignore 影响）。
  // 注意：ls-files -o 默认含被忽略的未跟踪文件，去掉 --exclude-standard 才能看到它们。
  // 过滤（2026-09-10）：sync 快照目录（include dest 前缀，如 pi/agent/、web/、self/）= 非源码
  // 路径不强制进仓（add -f 曾绕过导致 11k 行 package*.json/lock 噪音入库）；
  // 锁文件（package-lock/yarn.lock/pnpm-lock 等大体积可重建物）一律排除，package.json 仍保留。
  try {
    const destPrefixes = collectIncludes(cfg, ctx)
      .map((it) => String(it.dest || "").replace(/\/+$/, ""))
      .filter(Boolean);
    const lockNames = MANIFEST_BASENAMES.filter((n) => n !== "package.json");
    const manifest = (((await git(repo, ["ls-files", "-o", "-z"]))).out || "")
      .split("\0")
      .filter((x) => isManifest(x))
      .filter((x) => !destPrefixes.some((d) => x === d || x.startsWith(d + "/")))
      .filter((x) => !lockNames.some((n) => x === n || x.endsWith("/" + n)));
    for (const m of manifest) await git(repo, ["add", "-f", m]);
  } catch (e) {}
  const msg = message || buildCommitMessage(cfg, status);
  const r = await git(repo, ["commit", "-q", "-m", msg]);
  if (!r.ok && r.out.includes("nothing to commit")) {
    const sync = await gitSyncUnq(cfg, ctx);
    return { ok: true, noop: true, hash: ((await git(repo, ["rev-parse", "--short", "HEAD"]))).out.trim(), message: "", sync, scanned: scanned.hits };
  }
  const hash = ((await git(repo, ["rev-parse", "--short", "HEAD"]))).out.trim();
  const sync = await gitSyncUnq(cfg, ctx); // commit 之后才同步远端（pull --rebase → push）
  return { ok: r.ok, hash, message: msg, changed: status.changed.length, sync, scanned: scanned.hits };
}

// ---- remote 远端同步（对标 etckeeper push；配置 remote.url + push 即启用） ----
function maskUrl(url) {
  if (!url) return "";
  return String(url).replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\/]*@/i, "$1****@"); // https://user:token@ → https://****@
}

async function gitRemoteStatusUnq(cfg, ctx) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const r = await git(repo, ["remote", "get-url", "origin"]);
  const actual = r.ok ? String(r.out).trim() : "";
  const rm = (cfg.remote && cfg.remote.url) || "";
  return {
    url: maskUrl(actual || rm),
    push: !!(cfg.remote && cfg.remote.push && rm),
    autoPull: !(cfg.remote && cfg.remote.autoPull === false),
    branch: (cfg.remote && cfg.remote.branch) || cfg.branch || "main",
  };
}

// 提交后同步远端：确保 origin → pull --rebase（autoPull）→ push。返回 { ok, pushed, conflict, error, skipped }
async function gitSyncUnq(cfg, ctx) {
  const rm = (cfg.remote && cfg.remote.url) || "";
  if (!rm || !(cfg.remote && cfg.remote.push)) return { skipped: true, reason: "未配置 remote.push" };
  const repo = await ensureRepoUnq(cfg, ctx);
  const branch = (cfg.remote && cfg.remote.branch) || cfg.branch || "main";
  // 确保 origin 指向配置 url
  const cur = await git(repo, ["remote", "get-url", "origin"]);
  if (!cur.ok || String(cur.out).trim() !== rm) {
    if (cur.ok) await git(repo, ["remote", "set-url", "origin", rm]);
    else await git(repo, ["remote", "add", "origin", rm]);
  }
  const out = [];
  if (cfg.remote && cfg.remote.autoPull !== false) {
    const pull = await git(repo, ["pull", "--rebase", "origin", branch]);
    if (!pull.ok) {
      const msg = String(pull.out);
      if (/does not appear|couldn't find remote ref|could not read Username|not a git repository|upstream/i.test(msg)) {
        out.push("pull(跳过:远端无分支/未认证)"); // 首次 push 前常见，直接 push
      } else if (/CONFLICT|conflict/i.test(msg)) {
        return { ok: false, conflict: true, error: "rebase 冲突（需手动处理）：" + msg.slice(0, 160), out: out.join("\n") };
      } else {
        return { ok: false, conflict: false, error: "pull 失败：" + msg.slice(0, 160), out: out.join("\n") };
      }
    } else out.push("pull(ok)");
  }
  const push = await git(repo, ["push", "-u", "origin", branch]);
  if (!push.ok) return { ok: false, conflict: false, error: "push 失败：" + String(push.out).slice(0, 160), out: out.join("\n") };
  return { ok: true, pushed: true, out: out.join("\n") };
}


async function gitLogUnq(cfg, ctx, n = 10) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const r = await git(repo, ["log", "-" + n, "--format=%h|%ad|%D|%s", "--date=iso"]);
  const rows = [];
  for (const line of String(r.out || "").split("\n").filter(Boolean)) {
    let i = line.indexOf("|"), j = line.indexOf("|", i + 1), k = line.indexOf("|", j + 1);
    if (i < 0 || j < 0) continue;
    const refs = k < 0 ? "" : line.slice(j + 1, k);
    rows.push({
      hash: line.slice(0, i),
      date: line.slice(i + 1, j),
      tags: (refs.match(/tag: ([^,)]+)/g) || []).map((t) => t.slice(5)),
      subject: k < 0 ? line.slice(j + 1) : line.slice(k + 1),
    });
  }
  return rows;
}

async function gitTagListUnq(cfg, ctx) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const r = await git(repo, ["tag", "-l", "--sort=-creatordate", "--format=%(refname:short)|%(objectname:short)|%(creatordate:iso8601)"]);
  return String(r.out || "").split("\n").filter(Boolean).map((l) => {
    const [name, commit, date] = l.split("|");
    return { name: name || "", commit: commit || "", date: date || "" };
  });
}

async function gitTagDeleteUnq(cfg, ctx, name) {
  const repo = await ensureRepoUnq(cfg, ctx);
  return await git(repo, ["tag", "-d", name]);
}

// 快照（对标 etckeeper Pre-Invoke）：sync 源→仓副本 → commit（+ 可选打 tag）→ 操作前固化现场
async function snapshotUnq(cfg, ctx, opts = {}) {
  const sync = await syncToRepoUnq(cfg, ctx);
  // 前置闸门（重构 §4.2）：单次同步量超 50M → 拒绝并提示检查 excludes（force:true 豁免一次）
  const gateMB = Number(cfg.snapshotGateMB) || 50;
  if (!opts.force && sync.bytes > gateMB * 1024 * 1024) {
    return { ok: false, gateBlocked: true, bytes: sync.bytes,
      error: "单次同步量 " + mbStr(sync.bytes) + " 超闸门 " + gateMB + "MB——疑似备份面失控（2026-09-10 事故防线）。" +
        "请检查 ai-configs.json excludes；确认无误可用 force:true 豁免一次。" };
  }
  const r = await gitCommitUnq(cfg, ctx, opts.message);
  let tag = null;
  if (opts.tag) {
    const t = String(opts.tag);
    const tr = await gitTagUnq(cfg, ctx, t);
    if (tr.ok) tag = t;
    else return { ok: false, error: "打 tag 失败：" + tr.out, sync, gitCommit: r };
  }
  return { ok: true, noop: r.noop, hash: r.hash, tag, changed: r.changed, skipped: sync.skipped.map((s) => s.reason) };
}

async function gitDiffUnq(cfg, ctx, version, path) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const r = await git(repo, ["diff", version, "--", path || "."]);
  return String(r.out || "");
}

async function gitShowUnq(cfg, ctx, version) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const r = await git(repo, ["show", "--stat", "--oneline", version]);
  return String(r.out || "");
}

async function gitTagUnq(cfg, ctx, name) {
  const repo = await ensureRepoUnq(cfg, ctx);
  return await git(repo, ["tag", name]);
}

// ---------------- 恢复（五步走，不丢数据） ----------------
async function restoreUnq(cfg, ctx, version, opts = {}) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const steps = [];
  // ① 固化现场（把当前状态——哪怕已损坏——先存仓）
  const commitCur = await gitCommitUnq(cfg, ctx, opts.preMessage || "chore(configs): 恢复前固化现场");
  steps.push({ step: 1, action: "固化现场", result: commitCur.ok ? "ok" : ("fail:" + commitCur.out) });
  if (!commitCur.ok) return { ok: false, steps, error: "固化现场失败：" + commitCur.out };
  // ② 打 pre-recover tag
  const tag = "pre-recover-" + Date.now();
  await gitTagUnq(cfg, ctx, tag);
  steps.push({ step: 2, action: "打 tag " + tag, result: "ok" });
  // ③ 恢复：checkout 所选版本 → 写回源（仓副本文件 → 源路径）
  const r = await git(repo, ["checkout", version, "--", "."]);
  steps.push({ step: 3, action: "checkout " + version, result: r.ok ? "ok" : ("fail:" + r.out) });
  if (!r.ok) return { ok: false, steps, error: "checkout 失败：" + r.out };
  // 写回源：反向映射（仓内 dest → 源路径），黑名单根（** 通配）也需逐文件映射（修正 #3）
  const inc = collectIncludes(cfg, ctx);
  const srcByDest = new Map();
  for (const it of inc) {
    const destRel = String(it.dest || path.basename(String(it.path))).replace(/\/+$/, "");
    const srcRoot = expandPath(it.path, ctx);
    if (String(it.path).includes("*")) {
      // 通配根：遍历当前仓副本可能存在的对应文件，逐一映射到源（相对源根路径）
      const baseStar = srcRoot.slice(0, srcRoot.indexOf("*"));
      const relDir = path.relative(baseStar, srcRoot).split(path.sep).join("/");
      const destDir = path.join(repo, destRel, relDir);
      try {
        const walkBack = (dir) => {
          let ents = [];
          try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
          for (const en of ents) {
            const fp = path.join(dir, en.name);
            if (en.isDirectory()) walkBack(fp);
            else if (en.isFile()) srcByDest.set(fp, path.join(baseStar, path.relative(destDir, fp)));
          }
        };
        if (fs.existsSync(destDir)) walkBack(destDir);
      } catch (e) {}
    } else {
      srcByDest.set(path.join(repo, destRel), srcRoot);
    }
  }
  let written = 0;
  for (const [destAbs, srcAbs] of srcByDest) {
    try {
      if (!fs.existsSync(destAbs)) continue;
      fs.mkdirSync(path.dirname(srcAbs), { recursive: true });
      // git filter 方案：checkout 后工作区已是 smudge 解密的明文，直接复制回源；内容级 {HOME} 还原（#A）
      const raw = fs.readFileSync(destAbs, "utf8");
      const out = isJsonText(srcAbs) ? localize(raw) : raw;
      const tmp = srcAbs + ".aiti-restore.tmp";
      fs.writeFileSync(tmp, out);
      fs.renameSync(tmp, srcAbs);
      written++;
    } catch (e) {}
  }
  steps.push({ step: "3b", action: "写回源", result: written + " 个文件" });
  // ④ 复测 selfcheck
  const sc = await selfcheckUnq(cfg, ctx);
  steps.push({ step: 4, action: "selfcheck", result: sc.ok ? "ok" : ("❌ " + (sc.bad || []).map((x) => x.name).join(",")) });
  // ⑤ 写 HEAD（固化恢复结果）
  const cc = await gitCommitUnq(cfg, ctx, "chore(configs): 恢复至 " + version);
  steps.push({ step: 5, action: "固化恢复", result: cc.ok ? "ok" : ("fail:" + cc.out) });
  return { ok: sc.ok && cc.ok, steps, tag, version, written, selfcheck: sc, gitCommit: cc };
}

// ---------------- 仓孤儿清理（excludes 收紧后，被排除路径的旧副本不再该留在仓里） ----------------
// 遍历 git ls-files：命中 excludes/hardExcludes 且不受 protected 保护的跟踪文件 → 删文件（copy 即副本，真身在源处）。
// 返回清理清单；调用方随后走正常 commit 记录删除。
async function pruneRepoOrphansUnq(cfg, ctx, opts = {}) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const dryRun = !!opts.dryRun;
  const excl = [...(cfg.hardExcludes || []), ...(cfg.excludes || [])];
  const r = await git(repo, ["ls-files", "-z"]);
  const orphans = String(r.out || "").split("\0").filter(Boolean)
    .filter((rel) => matchesAny(rel, excl) && !isProtectedFile(cfg, rel));
  if (!dryRun && orphans.length) {
    for (const rel of orphans) { try { fs.rmSync(path.join(repo, rel), { force: true }); } catch (e) {} }
    await git(repo, ["add", "-A"]);
  }
  return { ok: true, repo, dryRun, pruned: orphans.length, paths: orphans.slice(0, 200) };
}

// ---------------- 体积自防御（重构 §4.2：防 18G 备份事故复发的最后闸门） ----------------
// .git 体积用 count-objects（快）；工作区做「带早停的限额游走」——只判超限不精确统计，
// 超限即停（防 selfcheck 自己变成下一次遍历事故）。
async function repoSizesUnq(cfg, ctx, opts = {}) {
  const repo = expandPath(cfg.repo, ctx);
  const out = { workspaceBytes: 0, gitBytes: 0 };
  try {
    const r = await git(repo, ["count-objects", "-v"]);
    for (const line of String(r.out || "").split("\n")) {
      const m = line.match(/^(\w+):\s+(\d+)$/);
      if (!m) continue;
      if (m[1] === "size" || m[1] === "size-pack") out.gitBytes += Number(m[2]) * 1024;
    }
  } catch (e) {}
  const limit = opts.workspaceLimitBytes || 100 * 1024 * 1024;
  const walk = (dir) => {
    if (out.workspaceBytes > limit) return; // 早停
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const en of ents) {
      if (out.workspaceBytes > limit) return;
      if (en.name === ".git") continue;
      const fp = path.join(dir, en.name);
      if (en.isDirectory()) walk(fp);
      else if (en.isFile()) { try { out.workspaceBytes += fs.statSync(fp).size; } catch (e) {} }
    }
  };
  try { walk(repo); } catch (e) {}
  return out;
}
const mbStr = (n) => (n / 1048576).toFixed(1) + "MB";

// ---------------- 自检 ----------------
async function selfcheckUnq(cfg, ctx) {
  const repo = await ensureRepoUnq(cfg, ctx);
  const rows = [];
  const bad = [];
  // 仓
  const head = await git(repo, ["rev-parse", "--short", "HEAD"]);
  rows.push({ name: "configs 仓", ok: head.ok && !!head.out.trim(), detail: "HEAD=" + (head.out.trim() || "无提交") });
  if (!head.ok || !head.out.trim()) bad.push({ name: "configs 仓" });
  // 体积自防御：工作区 > 100M 或 .git > 300M → bad（进安全盾 UI；防 18G 备份事故复发）
  const sizes = await repoSizesUnq(cfg, ctx, { workspaceLimitBytes: 100 * 1024 * 1024 });
  const wsOver = sizes.workspaceBytes > 100 * 1024 * 1024, gitOver = sizes.gitBytes > 300 * 1024 * 1024;
  rows.push({
    name: "仓体积", ok: !wsOver && !gitOver,
    detail: "工作区 " + (wsOver ? ">" : "") + mbStr(sizes.workspaceBytes) + (wsOver ? "（超 100M）" : "") +
      " · .git " + (gitOver ? ">" : "") + mbStr(sizes.gitBytes) + (gitOver ? "（超 300M）" : ""),
  });
  if (wsOver || gitOver) bad.push({ name: "仓体积", detail: "备份面疑似失控——检查 excludes；.git 超限可对仓做 gc/重灌" });
  const st = await gitStatusUnq(cfg, ctx);
  rows.push({ name: "仓工作区", ok: true, detail: st.clean ? "干净" : "脏 " + st.changed.length + " 文件" });
  // 关键 JSON 可解析（includes 里 json 文件 + 扩展 configs.check 声明）
  const inc = collectIncludes(cfg, ctx);
  const checks = [];
  // 扩展入口/崩溃指纹：注册表可见数（全挂=0 是 reload 全失败的哨兵信号）。CLI 模式无注册表 → n/a 不判错
  let extVisible = 0, extDeclConfigs = 0, hasRegistry = false;
  try {
    const reg = (ctx && ctx.registry) || globalThis.__piWebExt;
    hasRegistry = !!(reg && typeof reg.all === "function");
    const all = hasRegistry ? reg.all() : [];
    for (const ext of all) {
      const e = ext && ext.ext;
      if (!e || !e.id) continue;
      extVisible++;
      if (e.configs && e.configs.includes) extDeclConfigs++;
      const ck = e.configs && e.configs.check;
      if (Array.isArray(ck)) for (const c of ck) checks.push({ path: c.path, kind: c.kind });
    }
  } catch (e) {}
  rows.push({ name: "扩展入口", ok: !hasRegistry || extVisible > 0, detail: hasRegistry ? (extVisible + " 个扩展可见 · " + extDeclConfigs + " 个声明 configs") : "n/a（CLI 模式，无扩展注册表）" });
  if (hasRegistry && extVisible === 0) bad.push({ name: "扩展入口", detail: "注册表 0 个扩展（疑似全部加载失败）" });
  for (const it of inc) {
    // 跳过被 excluded/hardExcluded 的路径（相对源根判定；不进仓也不检查——防止 auth.json 等误报）
    const srcRoot = expandPath(it.path, ctx);
    const destRel = String(it.dest || path.basename(srcRoot)).replace(/\/+$/, "");
    const excl = [...(cfg.hardExcludes || []), ...(cfg.excludes || [])];
    if (matchesAny(destRel, excl)) continue;
    // 黑名单根（** 通配，如 ~/.pi/agent/**）不当作单个 json 文件校验——否则 fs.readFileSync 读目录报错假坏（修复 #3）
    if (String(it.path).indexOf("*") >= 0) continue;
    // 仅对具体 .json/.jsonc 路径做 JSON 可解析校验
    if (String(it.path).endsWith(".json") || String(it.path).endsWith(".jsonc")) checks.push({ path: it.path, kind: "json" });
  }
  const checkedJson = new Set();
  for (const c of checks) {
    const fp = expandPath(c.path, ctx);
    if (checkedJson.has(fp)) continue;
    checkedJson.add(fp);
    if (c.kind === "json") {
      let ok = false, detail = "不存在";
      try { const txt = fs.readFileSync(fp, "utf8"); JSON.parse(txt); ok = true; detail = "可解析"; } catch (e) { detail = "JSON 解析失败：" + ((e && e.message) || e); }
      rows.push({ name: path.basename(fp), ok, detail });
      if (!ok) bad.push({ name: path.basename(fp), detail });
    }
  }
  return { ok: bad.length === 0, rows, bad, repo, head: head.out.trim() };
}

// ---------------- 哨兵（崩溃指纹检测，可复用 CLI/扩展） --------------
// 返回 { hits:[{name,detail,level}], selfcheck }——selfcheck bad 项 + 扩展全挂
async function detectCrashUnq(cfg, ctx) {
  const sc = await selfcheckUnq(cfg, ctx);
  const hits = [];
  for (const b of sc.bad || []) {
    if (b.name === "configs 仓") continue; // 未首次入仓（HEAD 无）是正常态，不是崩溃
    hits.push({ name: b.name, detail: b.detail || "自检失败", level: "selfcheck" });
  }
  const ext = sc.rows.find((r) => r.name === "扩展入口");
  if (ext && !ext.ok) hits.push({ name: "扩展入口", detail: ext.detail, level: "ext" });
  return { hits, selfcheck: sc };
}


// ---------------- 公共 API（per-repo 串行包装） ----------------
const _queued = (fn) => function (cfg, ctx, ...rest) { return queueRepo(expandPath(cfg && cfg.repo, ctx), () => fn(cfg, ctx, ...rest)); };
const ensureRepo = _queued(ensureRepoUnq);
const ensureGitFilter = _queued(ensureGitFilterUnq);
const syncToRepo = _queued(syncToRepoUnq);
const gitStatus = _queued(gitStatusUnq);
const scanStaged = _queued(scanStagedUnq);
const autoGitignore = _queued(autoGitignoreUnq);
const gitCommit = _queued(gitCommitUnq);
const gitRemoteStatus = _queued(gitRemoteStatusUnq);
const gitSync = _queued(gitSyncUnq);
const gitLog = _queued(gitLogUnq);
const gitTagList = _queued(gitTagListUnq);
const gitTagDelete = _queued(gitTagDeleteUnq);
const snapshot = _queued(snapshotUnq);
const gitDiff = _queued(gitDiffUnq);
const gitShow = _queued(gitShowUnq);
const gitTag = _queued(gitTagUnq);
const restore = _queued(restoreUnq);
const pruneRepoOrphans = _queued(pruneRepoOrphansUnq);
const repoSizes = _queued(repoSizesUnq);
const selfcheck = _queued(selfcheckUnq);
const detectCrash = _queued(detectCrashUnq);

// ---------------- 导出 ----------------
module.exports = {
  expandPath, loadConfig, saveConfig, collectIncludes, ensureRepo, syncToRepo,
  gitStatus, buildCommitMessage, gitCommit, gitLog, gitTag, gitTagList, gitTagDelete, snapshot,
  gitDiff, gitShow, restore, selfcheck, detectCrash, scanSensitive, SENSITIVE_PATTERNS, globToRe, matchesAny,
  maskUrl, gitRemoteStatus, gitSync, repoSizes, pruneRepoOrphans,
  encryptText, decryptText, loadKey, generateKey, isEncryptedPath, ensureGitFilter, isProtectedFile,
  portablize, localize, isManifest, scanStaged, autoGitignore, isBinaryBuf, isJsonText,
  defaultKeyFile,
};
