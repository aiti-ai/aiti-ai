#!/usr/bin/env node
// publish-all.mjs（aiti-ai 发布快照仓适配版）——源自私有源仓同名脚本（pi-web-ext/tools/publish-all.mjs），
// 目录映射适配本仓布局：ROOT=extensions、插件根=pi-plugins+packages、_shared 不发布。
// 双源注意：私有源仓侧逻辑变更需同步本副本（发布域以本仓为自治事实源）。
// 增量语义：本地 package.json version 未在 registry versions 中 → 构建 + 发布；已存在 → 跳过。
// 范围（2026-09-09 起）：
//   - pi-web-ext/* 全部扩展
//   - 仓根 pi 插件：pi-models-combo、pi-subagents、pi-git-trace、pi-ext/*（plan-sandbox 等）
//   - private 包（如 pi-ext/qoder-private）保持 private：adopt 不改名不去 private，发布阶段自动跳过
// 用法：
//   node tools/publish-all.mjs [--dry-run] [--only <dir>,...] [--bump patch|minor|major]
//   --only 匹配目录短名（pi-web-ext 下为目录名；插件为包目录名，如 pi-models-combo、plan-sandbox）
// 首次使用先把各包 package.json 的 name 改为 @aiti-ai/<name> 并去掉需要发布的包的 private：
//   node tools/publish-all.mjs --adopt   # 只做改名/去 private 预处理，不发布（private 包不动）

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extProtocolInfo } from "../extensions/_shared/ext-protocol.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions");
const REPO = resolve(ROOT, "..");
const SCOPE = "@aiti-ai";
// 示例/模板目录不对外发布
// v3：_shared（@aiti-ai/ext-shared 共享层）纳入发布——4 个扩展 package.json 声明依赖它，
// 不上源则官方安装不可解析（审核 D12）
const EXCLUDE = new Set(["demo", "demo-lazy", "sm-demo-source", "templates", "shared"]); // _shared 是 @aiti-ai/ext-shared 包源，必须发布（22 扩展的运行时依赖）
// 仓根 pi 插件根（相对 REPO）：自身或一级子目录有 package.json 即纳入。
// packages/ = aiti-devtools 全家桶（vite/webpack/nuxt/astro 载体插件 + core/inject/bridge/agent/pi）
// ——用户应用「npm i -D @aiti-ai/aiti-devtools-vite」的接入面，不发布则文档安装方式全是空谈
const PLUGIN_ROOTS = ["pi-plugins", "packages"];

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};
const DRY = has("--dry-run");
const ADOPT = has("--adopt");
const ONLY = opt("--only") ? opt("--only").split(",").map((s) => s.trim()) : null;
const BUMP = opt("--bump");
// 治理逃生口：缺协议声明也强行发布（详见 docs/pi-web-ext-protocol.md）
const ALLOW_MISSING_PROTOCOL = has("--allow-missing-protocol");
// v3 内容哈希变更检测：源码变了→自动 bump patch→发布；没变→跳过。
// 哈希以 contentHash 字段写进发布的 package.json → **npm registry 即为唯一事实源**
// （本地/GHA/docker 均通过 npm view 查询，零本地状态文件）。
// --force 覆盖哈希检测强发。
const FORCE = has("--force");
function contentHash(pkgDir) {
  
  const hash = createHash("sha256");
  const files = [];
  const collect = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        // dist 排除：构建产物是源码的派生物（vite 确定性构建），哈希只算源码——
        // 否则「哈希先于构建计算 + 构建刷新 dist」会导致每次发布哈希漂移、永远追不平
        if (["node_modules", ".git", "__pycache__", "vendor", "dist"].includes(e.name)) continue;
        collect(p);
      } else {
        if (/\.tgz$|\.log$|\.tsbuildinfo$/.test(e.name)) continue;
        // package.json 排除出 contentHash——contentHash 自身写入 package.json 后不参与计算
        if (d === pkgDir && e.name === "package.json") continue;
        files.push({ rel: p.slice(pkgDir.length + 1).replace(/\\/g, "/"), p });
      }
    }
  };
  collect(pkgDir);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  for (const f of files) {
    hash.update(f.rel);
    try { hash.update(readFileSync(f.p)); } catch {}
  }
  return hash.digest("hex").slice(0, 16);
}
// v3 双目标源：AITI_NPM_TARGET=official|staging（env）或 --target <t>（CLI 覆盖）
//   official（默认）：registry.npmjs.org —— 正式发布主渠道；每包发布前强制跑审核门禁
//     （release-audit.mjs 机械项，FAIL 即拒发——公开不可撤回）
//   staging：内部私仓 —— 测试发布源（预发布 -beta 验证 + 私有件 pi-subagents）；URL 属内部值，env 注入
const TARGET = (() => {
  const ti = args.indexOf("--target");
  if (ti >= 0 && ["staging", "official", "aliyun"].includes(args[ti + 1])) return args[ti + 1];
  const env = process.env.AITI_NPM_TARGET;
  if (["staging", "official", "aliyun"].includes(env)) return env;
  return "official";
})();
// ---- 本机私有配置（staging 私仓 URL 等；~/.aiti/release-redact.json，CI 用 env AITI_RELEASE_REDACT 注入）----
function loadPrivConfig() {
  const raw = process.env.AITI_RELEASE_REDACT;
  if (raw) {
    try { return JSON.parse(raw); } catch { console.error("[publish-all] AITI_RELEASE_REDACT 不是合法 JSON——忽略"); }
  }
  try { return JSON.parse(readFileSync(join(homedir(), ".aiti", "release-redact.json"), "utf8")); }
  catch { return null; }
}
const PRIV = loadPrivConfig();
if (!PRIV) console.warn("[publish-all] 未找到 ~/.aiti/release-redact.json——staging 私仓回退官方源/env");
const REGISTRIES = {
  staging: PRIV?.stagingRegistry || process.env.AITI_STAGING_REGISTRY || "https://registry.npmjs.org/", // staging 私仓从本机 ~/.aiti/release-redact.json 加载（CI 用 env AITI_RELEASE_REDACT）
  official: "https://registry.npmjs.org/",
  // 阿里云制品库（正式仓备选）：独立凭据 env（ALIYUN_NPM_USERNAME/ALIYUN_NPM_PASSWORD），
  // publish 时生成临时 userconfig 注入；私有源可覆盖重发，不跑 official 门禁
  aliyun: "https://packages.aliyun.com/63a415398d9a873a30aae528/npm/npm-registry/",
};

// aliyun 凭据 → 临时 userconfig（NPM_CONFIG_USERCONFIG 注入全部 npm 子命令）；
// 凭据只进 tmp 文件（进程结束即弃），不入仓不入 ~/.npmrc
function aliyunUserconfig() {
  const u = process.env.ALIYUN_NPM_USERNAME, p = process.env.ALIYUN_NPM_PASSWORD;
  if (!u || !p) throw new Error("target=aliyun 需要环境变量 ALIYUN_NPM_USERNAME / ALIYUN_NPM_PASSWORD");
  const hostPath = REGISTRY.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const f = join(mkdtempSync(join(tmpdir(), "aliyun-npmrc-")), "npmrc");
  writeFileSync(f, [
    `//${hostPath}/:username=${u}`,
    `//${hostPath}/:_password=${Buffer.from(p).toString("base64")}`,
    `//${hostPath}/:always-auth=true`,
    `registry=${REGISTRY}`,
  ].join("\n") + "\n");
  return f;
}
const REGISTRY = REGISTRIES[TARGET];
const NPM_ENV_EXTRA = TARGET === "aliyun" ? { NPM_CONFIG_USERCONFIG: aliyunUserconfig() } : {};
// official 门禁：单包机械审核（--fix 关闭——门禁只拦不改；要改用 release-audit --fix 先行）
const AUDIT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "release-audit.mjs");
function officialAuditGate(dir) {
  const r = spawnSync(process.execPath, [AUDIT_SCRIPT, "--only", dir, "--target", "official"], {
    cwd: REPO, encoding: "utf8", timeout: 180_000,
  });
  return { ok: r.status === 0, output: (r.stdout || "") + (r.stderr || "") };
}

// ---- 收集包清单：entry = { dir: 唯一短名（--only/显示），pkgDir: 绝对路径，pjPath, p } ----
const pkgs = [];
function addPkg(pkgDir) {
  const pjPath = join(pkgDir, "package.json");
  let p;
  try { p = JSON.parse(readFileSync(pjPath, "utf8")); } catch { return; }
  pkgs.push({ dir: basename(pkgDir), pkgDir, pjPath, p });
}
for (const d of readdirSync(ROOT)) {
  const pj = join(ROOT, d, "package.json");
  if (existsSync(pj)) addPkg(join(ROOT, d));
}
for (const rel of PLUGIN_ROOTS) {
  const abs = join(REPO, rel);
  if (existsSync(join(abs, "package.json"))) { addPkg(abs); continue; }
  if (!existsSync(abs)) continue;
  for (const d of readdirSync(abs, { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(join(abs, d.name, "package.json"))) addPkg(join(abs, d.name));
  }
}

// registry 信息：curl 拉完整 packument（npm view 的 install-v1 缩略 Accept 在阿里云 lazy
// proxy 上不触发上游拉取恒 404——完整 JSON 才 200）。aliyun target 带 Basic 认证。
function registryPackument(fullName) {
  const url = REGISTRY + fullName.replace("/", "%2f");
  const auth = TARGET === "aliyun"
    ? `-H ${JSON.stringify("Authorization: Basic " + Buffer.from(`${process.env.ALIYUN_NPM_USERNAME}:${process.env.ALIYUN_NPM_PASSWORD}`).toString("base64"))}`
    : "";
  try {
    const out = execSync(`curl -s --max-time 30 ${auth} ${JSON.stringify(url)}`, {
      encoding: "utf8", shell: true, timeout: 45_000 }
    );
    const j = JSON.parse(out);
    if (!j || j.error || !j.versions) return null;
    const versions = Object.keys(j.versions);
    const latest = j["dist-tags"] && j["dist-tags"].latest;
    const latestManifest = latest && j.versions[latest];
    return { versions: new Set(versions), latest, latestHash: (latestManifest && latestManifest.contentHash) || null };
  } catch {
    return null;
  }
}

function bump(v, kind) {
  const [a, b, c] = v.split(".").map(Number);
  if (kind === "major") return `${a + 1}.0.0`;
  if (kind === "minor") return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

// ---- adopt 阶段：统一改名 + 去 private + 补 version（private 包保持原样：不改名不去 private）----
if (ADOPT) {
  for (const { dir, pkgDir, pjPath, p } of pkgs) {
    if (EXCLUDE.has(dir)) continue;
    if (p.private) { console.log(`[adopt] ${dir}: private，保持不动`); continue; }
    const want = p.name.includes("/") ? p.name : `${SCOPE}/${p.name}`;
    const changed = [];
    if (p.name !== want) { changed.push(`name ${p.name || "-"} -> ${want}`); p.name = want; }
    if (!p.version) { changed.push("补 version 0.1.0"); p.version = "0.1.0"; }
    if (changed.length) {
      writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
      console.log(`[adopt] ${dir}: ${changed.join("; ")}`);
    }
  }
  console.log("adopt 完成");
  process.exit(0);
}

// ---- 发布阶段 ----
let published = 0, skippedUpToDate = 0, skippedPrivate = 0, skippedProtocol = 0, failed = 0;
const report = [];

for (const { dir, pkgDir, pjPath, p } of pkgs) {
  if (EXCLUDE.has(dir)) continue;
  if (ONLY && !ONLY.includes(dir)) continue;
  if (!p.version) { report.push(`-  ${dir}: 无 version，跳过`); continue; }
  if (p.private) { skippedPrivate++; report.push(`P  ${dir}: private，保持 private，跳过`); continue; }
  // v3 元数据注入（幂等，缺失才写）：repository/homepage/bugs 指向 aiti-ai org、
  // license 补 MIT——npm 页面展示与消费者溯源需要；跳过的包同样补齐。写回不改
  // contentHash（package.json 已排除出哈希计算）→ 跳过判断不受影响。
  {
    // monorepo 标准形态：url 指向真实存在的公开仓 aiti-ai/aiti-ai（扩展单包仓在
    // GitHub org 上不存在——写 github.com/aiti-ai/<pkg> 是死链），子目录用
    // repository.directory 标注（npm 页面据此展示包内位置）。
    const REPO_URL = "git+https://github.com/aiti-ai/aiti-ai.git";
    const repoDir = pkgDir.startsWith(ROOT + sep)
      ? `extensions/${basename(pkgDir)}`
      : pkgDir.startsWith(join(REPO, "packages") + sep)
        ? `packages/${basename(pkgDir)}`
        : `pi-plugins/${basename(pkgDir)}`;
    let metaChanged = false;
    if (!p.repository) { p.repository = { type: "git", url: REPO_URL, directory: repoDir }; metaChanged = true; }
    if (!p.homepage) { p.homepage = "https://github.com/aiti-ai/aiti-ai#readme"; metaChanged = true; }
    if (!p.bugs) { p.bugs = { url: "https://github.com/aiti-ai/aiti-ai/issues" }; metaChanged = true; }
    if (!p.license) { p.license = "MIT"; metaChanged = true; }
    if (metaChanged) writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
  }
  // pi-web-ext 扩展协议声明治理（docs/pi-web-ext-protocol.md）：缺/非法声明拒发该包；过期发警告但放行。
  // 注意作用域仅 pi-web-ext/*——仓根 pi 插件（combo/subagents/git-trace/pi-ext/*）不适用本字段。
  if (pkgDir.startsWith(ROOT + sep)) {
    const proto = extProtocolInfo(p.aitiExtProtocol);
    if (proto.state === "missing" || proto.state === "invalid") {
      if (!ALLOW_MISSING_PROTOCOL) {
        skippedProtocol++;
        report.push(`✗  ${dir}@${p.version}: 缺/非法 aitiExtProtocol（跳过发布；修复：package.json 加 "aitiExtProtocol": "1.0"，或 extman 的 AI 升级 skill；--allow-missing-protocol 可强制）`);
        continue;
      }
    } else if (proto.state !== "ok") {
      console.log(`[协议警告] ${dir}: aitiExtProtocol=${p.aitiExtProtocol} state=${proto.state}${proto.upgradeRefs.length ? "（迁移手册 " + proto.upgradeRefs.join(" → ") + "）" : ""}`);
    }
  }
  const fullName = p.name.startsWith(SCOPE + "/") ? p.name : `${SCOPE}/${p.name}`;
  let version = p.version;
  // aliyun lazy proxy 下 npm view 恒 404——直接走 curl 完整 packument（npmjs 同样支持，
  // 两分支统一走一个实现——旧的 registryInfo 在 packument 化重构后未清理，已删除）
  const info = registryPackument(fullName);

  // v3 内容哈希变更检测：源码变了→自动 bump patch→发布；没变→跳过。
  // 哈希以 contentHash 字段写进发布的 package.json → **npm registry 即为唯一事实源**
  // （本地/GHA/docker 均通过 npm view 查询，零本地状态文件）。
  // **contentHash 不可用（旧包无字段/包不存在）视为变更** → auto bump（版本被占时）→
  // 发布带 contentHash 的新版本，全量包一次收敛进新体系。--force 覆盖强发。
  const curHash = contentHash(pkgDir);
  let publishedHash = null;
  try {
    publishedHash = execSync(`npm view ${JSON.stringify(fullName)} contentHash --json --registry ${REGISTRY}`, {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, ...NPM_ENV_EXTRA },
    }).trim().replace(/^"/, "").replace(/"$/, "");
  } catch { publishedHash = null; }
  if (!publishedHash || publishedHash === "undefined" || publishedHash === "") publishedHash = null;
  if (TARGET === "aliyun") publishedHash = (info && info.latestHash) || null;
  const versionOnRegistry = info && info.versions.has(version);
  // 元数据收敛检查：npm 版本不可变 → 元数据修正只能随新版本发布。源上 latest 的
  // repository 未指向真实公开仓 aiti-ai/aiti-ai（缺失或旧死链形态
  // github.com/aiti-ai/<pkg>，org 上无单包仓）→ 视为变更走 bump 重发。
  let metaOnRegistry = "";
  try {
    metaOnRegistry = execSync(`npm view ${JSON.stringify(fullName)} repository.url --json --registry ${REGISTRY}`, {
      encoding: "utf8", timeout: 30_000, env: { ...process.env, ...NPM_ENV_EXTRA },
    }).trim().replace(/^"/, "").replace(/"$/, "");
  } catch { metaOnRegistry = ""; }
  const metaOk = metaOnRegistry.includes("github.com/aiti-ai/aiti-ai");
  if (!FORCE && !BUMP && publishedHash !== null && publishedHash === curHash && versionOnRegistry && metaOk) {
    // registry 有 contentHash 且与当前内容一致、且本地版本就是源上版本 → 跳过。
    // 本地版本高于源上（版本未注册）时不走此分支：内容即使一致也照发该高版本
    //（staging 测试发了多版 → 上官方直接用高版本，不 bump 不跳过）
    skippedUpToDate++;
    report.push(`=  ${dir}@${version}: 内容未变（hash ${curHash.slice(0, 8)}），跳过`);
    continue;
  }
  if (!FORCE && !BUMP && info?.latest && semLt(version, info.latest)) {
    // 本地版本低于源上 latest → 跳过（发布倒退版本没有意义；并行开发 WIP 版本号未追平，
    // 等本地版本 ≥ latest 时正常发布）。独立于 versionOnRegistry：0.1.5 < 0.1.9 即使
    // 0.1.5 未注册同样跳过。
    skippedUpToDate++;
    report.push(`=  ${dir}@${version}: 本地版本低于源上 latest ${info.latest}，跳过`);
    continue;
  }
  if (!FORCE && !BUMP && versionOnRegistry) {
    version = bump(p.version, "patch");
    p.version = version;
    writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
    report.push(publishedHash === null
      ? `^  ${dir}: contentHash 不可用（旧包），视为变更，版本自动 bump → ${version}`
      : `^  ${dir}: 内容变更，版本自动 bump → ${version}`);
  }
  // else：版本未被占用（首次发布/新版本）→ 按当前版本直接发布
  // 构建（门禁前）：official 门禁含 C9（dist 存在性）——构建必须先于门禁，否则首次发布
  // 的扩展（树内无 dist）一律被 C9 拒发（2026-11-11 CI 实测 64/75 假拒）。构建成功后
  // dist 非空，发布块内的同款检查自然跳过（幂等）。DRY 也构建——让 dry-run 报告反映
  // 真实可发布性。
  {
    const isPackages0 = pkgDir.startsWith(join(REPO, "packages") + sep);
    const buildScript0 = p.scripts?.["build:client"] && p.scripts["build:client"].trim() !== "true"
      ? "build:client"
      : isPackages0 && p.scripts?.build ? "build" : null;
    if (buildScript0) {
      const _dist0 = join(pkgDir, "dist");
      if (existsSync(_dist0) && readdirSync(_dist0).length > 0) {
        console.log(`[publish] ${dir}: dist 已存在，跳过 ${buildScript0}`);
      } else {
        execSync(`npm run ${buildScript0}`, { cwd: pkgDir, stdio: "inherit" });
      }
    }
  }
  // official 门禁（v3）：正式发布前跑单包机械审核（脱敏/lock/LICENSE/入口对齐/依赖可解析），
  // FAIL 即拒发——公开不可撤回。--force 可越过门禁（应急），staging 不跑门禁。
  if (TARGET === "official" && !FORCE) {
    const gate = officialAuditGate(dir);
    if (!gate.ok) {
      failed++;
      report.push(`✗  ${dir}@${version}: 官方发布审核门禁未过——拒发（修：node tools/release-audit.mjs --only ${dir} --target official --fix）`);
      if (!DRY) console.log(gate.output.split("\n").filter((l) => l.includes(":")).slice(0, 6).join("\n"));
      continue;
    }
  }
  const tag = info && info.latest && !semLt(info.latest, version)
    ? `（注意：源上 latest ${info.latest} 不低于本地，发布不会回退 latest）` : "";
  console.log(`\n==> ${fullName}@${version} ${DRY ? "[dry-run]" : ""} ${tag}`);
  if (DRY) { published++; report.push(`D  ${dir}@${version}: 将发布 ${fullName}`); continue; }

  // aliyun 专有：上游聚合仓 packument 只回本地缓存（新包名=空），PUT 却校验上游——
  // 同版本撞「已存在该版本」403 时 bump patch 重试一次（新版本号必然可进）
  let _aliyunRetried = false;
  while (true) {
  try {
    // 有构建脚本先构建：扩展走 build:client（"true" 占位跳过）；packages/ 侧走 build
    const isPackages = pkgDir.startsWith(join(REPO, "packages") + sep);
    const buildScript = p.scripts?.["build:client"] && p.scripts["build:client"].trim() !== "true"
      ? "build:client"
      : isPackages && p.scripts?.build ? "build" : null;
    if (buildScript) {
      // dist 已存在（非空）则跳过构建——发布源可预置同版本构建产物（CI 对 packages 侧
      // 用 vendor tgz 解出 dist 直塞，绕开各包 build 脚本的自定义 esbuild 解析差异）；
      // 本地常规路径 dist 由发布前构建产出，语义不变
      const _dist = join(pkgDir, "dist");
      if (existsSync(_dist) && readdirSync(_dist).length > 0) {
        console.log(`[publish] ${dir}: dist 已存在，跳过 ${buildScript}`);
      } else {
        execSync(`npm run ${buildScript}`, { cwd: pkgDir, stdio: "inherit" });
      }
    }
    // official 目标：发布前 lock 重写（私源 resolved → 官方源；staging 源即私域不改）
    if (TARGET === "official") {
      const lockPath = join(pkgDir, "package-lock.json");
      if (existsSync(lockPath)) {
        const lockText = readFileSync(lockPath, "utf8");
        const rewritten = lockText.replace(/https:\/\/npm\.alot\.pw/g, "https://registry.npmjs.org");
        if (rewritten !== lockText) writeFileSync(lockPath, rewritten);
      }
    }
    // v3 把内容哈希写进 package.json contentHash 字段 → 随包发布到 registry，
    // 下一轮 npm view 即可查到（registry 本身就是变更检测的事实源）
    p.contentHash = curHash;
    writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
    // dist 校验：有真实构建的包发布前必须产出 dist（防止纯源码包上源）
    if (buildScript) {
      const distDir = join(pkgDir, "dist");
      if (!existsSync(distDir) || readdirSync(distDir).length === 0) {
        failed++;
        report.push(`!  ${dir}@${version}: dist/ 为空（${buildScript} 未产出）——跳过发布`);
        break;
      }
    }
    const provenance = TARGET === "official" ? " --provenance" : "";
    execSync(`npm publish --registry ${REGISTRY} --access public${provenance}`, {
      cwd: pkgDir, stdio: "inherit", env: { ...process.env, ...NPM_ENV_EXTRA },
    });
    published++;
    report.push(`+  ${dir}@${version}: 已发布为 ${fullName}`);
    break;   // 成功即出 retry 循环（缺此 break 会空转第二轮、撞同版本 409 假报失败）
  } catch (e) {
    const emsg = e.message || "";
    if (TARGET === "aliyun" && !_aliyunRetried && /已存在|不允许被覆盖/.test(emsg)) {
      _aliyunRetried = true;
      version = bump(version, "patch");
      p.version = version;
      writeFileSync(pjPath, JSON.stringify(p, null, 2) + "\n");
      report.push(`^  ${dir}: aliyun 同版本撞上游缓存，bump → ${version} 重试`);
      continue;   // while 顶重试（dist 已存在 → 直发新版本号）
    }
    failed++;
    report.push(`!  ${dir}@${version}: 发布失败 — ${emsg.split("\n")[0]}`);
    break;   // 跳出 while，继续外层下一包
  }
  }   // aliyun 重试 while
}

console.log("\n===== 发布报告 =====");
for (const r of report) console.log(r);
console.log(`\n发布 ${published} / 最新跳过 ${skippedUpToDate} / private 跳过 ${skippedPrivate} / 协议跳过 ${skippedProtocol} / 失败 ${failed}`);

function semLt(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  return false;
}
