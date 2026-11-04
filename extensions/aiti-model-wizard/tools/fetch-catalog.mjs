#!/usr/bin/env node
/**
 * aiti-model-wizard · 拉取并同步 models.dev 目录（justget 多源竞速 + Gitee 镜像）
 *
 * 职责：
 *   1) 用 justget（多源竞速：官方 models.dev + Gitee 镜像）下载最新 api.json → 更新仓库快照 catalog/models.dev.json
 *   2) 同步快照到 Gitee 镜像仓库 justdb-mirrors/downloads（models-dev/api.json），国内加速
 *   3) 更新运行时 dataDir 缓存（可选）
 *
 * 用法：
 *   node tools/fetch-catalog.mjs                 # 只下载并更新本地快照
 *   node tools/fetch-catalog.mjs --sync-gitee    # 下载 + push 到 gitee 镜像
 *   env GITEE_REMOTE="git@gitee.com:justdb-mirrors/downloads.git" node tools/fetch-catalog.mjs --sync-gitee
 */
import { copyFileSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const OUT = resolve(root, "catalog", "models.dev.json");
const PRIMARY = process.env.MODELS_DEV_URL || "https://models.dev/api.json";
const MIRROR = process.env.MODELS_DEV_MIRROR || "https://gitee.com/justdb-mirrors/downloads/raw/master/models-dev/api.json";
const GITEE_REMOTE = process.env.GITEE_REMOTE || "git@gitee.com:justdb-mirrors/downloads.git";

function findJustget() {
  const cands = [process.env.JUSTGET_BIN, resolve(homedir(), "workspace/justget/dist/cli.js"), resolve(homedir(), "workspace/justget/justget.mjs")];
  for (const c of cands) if (existsSync(c)) return c;
  try { execSync("justget --version", { stdio: "ignore" }); return "justget"; } catch (e) {}
  return null;
}

async function download() {
  const jg = findJustget();
  const tmp = resolve(tmpdir(), "models-dev-" + Date.now() + ".json");
  console.log("[fetch] justget=" + (jg || "未找到（降级 fetch）"));
  if (jg) {
    const isScript = jg.endsWith(".js") || jg.endsWith(".mjs");
    const base = isScript ? [process.execPath, jg] : [jg];
    try {
      execSync([...base, PRIMARY, "-o", tmp, "-m", MIRROR, "--timeout", "120000", "--connect-timeout", "10000"].map(JSON.stringify).join(" "), { stdio: "inherit", timeout: 150000 });
    } catch (e) {
      console.warn("[fetch] justget 失败，降级 fetch 回退");
    }
  }
  if (!existsSync(tmp) || readFileSync(tmp, "utf8").trim().length < 1024) {
    // fetch 回退：官方 → 镜像
    let text = null;
    for (const u of [PRIMARY, MIRROR]) {
      try {
        const r = await fetch(u, { headers: { "user-agent": "aiti-model-wizard/0.1" }, redirect: "follow" });
        if (r.ok) { text = await r.text(); console.log("[fetch] 回退源 OK: " + u + " (" + text.length + "B)"); break; }
      } catch (e) {}
    }
    if (!text) throw new Error("全部源下载失败");
    writeFileSync(tmp, text);
  }
  const data = JSON.parse(readFileSync(tmp, "utf8"));
  if (!data || !data.providers) {
    // models.dev 顶层直接是 provider 映射
    const first = Object.values(data || {})[0];
    if (!(first && typeof first === "object" && (first.models !== undefined || first.api !== undefined || first.id !== undefined))) {
      rmSync(tmp, { force: true }); throw new Error("目录格式不对");
    }
  }
  mkdirSync(resolve(root, "catalog"), { recursive: true });
  copyFileSync(tmp, OUT);
  rmSync(tmp, { force: true });
  const n = data.providers ? Object.keys(data.providers).length : Object.keys(data).length;
  console.log("[fetch] 快照已更新 → " + OUT + "（" + n + " providers · " + readFileSync(OUT, "utf8").length + "B）");
  return n;
}

async function syncGitee() {
  console.log("[gitee] 同步到 " + GITEE_REMOTE + " …");
  const tmpRepo = resolve(tmpdir(), "models-dev-mirror-" + Date.now());
  mkdirSync(tmpRepo, { recursive: true });
  execSync("git init -q", { cwd: tmpRepo });
  execSync("git remote add origin " + JSON.stringify(GITEE_REMOTE), { cwd: tmpRepo });
  execSync("git fetch -q origin", { cwd: tmpRepo, stdio: "ignore" });
  // 若远程有 master，检出来合并（幂等）；否则新建
  try {
    execSync("git checkout -q -B master origin/master", { cwd: tmpRepo, stdio: "ignore" });
  } catch (e) {
    execSync("git checkout -q -B master", { cwd: tmpRepo });
  }
  mkdirSync(resolve(tmpRepo, "models-dev"), { recursive: true });
  copyFileSync(OUT, resolve(tmpRepo, "models-dev", "api.json"));
  const readme = resolve(tmpRepo, "models-dev", "README.md");
  if (!existsSync(readme)) {
    writeFileSync(readme, "# models.dev 镜像\n\n`api.json` = https://models.dev/api.json 快照（aiti-model-wizard 用，国内加速）。\n原始数据版权归 models.dev / Smol AI。\n");
  }
  execSync("git add -A", { cwd: tmpRepo });
  const changed = execSync("git diff --cached --stat", { cwd: tmpRepo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  if (!changed) { console.log("[gitee] 无变化（跳过 push）"); rmSync(tmpRepo, { recursive: true, force: true }); return; }
  const stamp = new Date().toISOString().replace(/T/, " ").slice(0, 19);
  execSync("git -c user.email=ai@aiti.local -c user.name=aiti-ai commit -q -m " + JSON.stringify("mirror: models.dev api.json · " + stamp), { cwd: tmpRepo });
  execSync("git push -q origin master", { cwd: tmpRepo, stdio: "inherit" });
  console.log("[gitee] 已推送 " + GITEE_REMOTE + "（master）");
  rmSync(tmpRepo, { recursive: true, force: true });
}

const doGitee = process.argv.includes("--sync-gitee");
try {
  await download();
  if (doGitee) await syncGitee();
  else console.log("[done] 加 --sync-gitee 可同时推送到 gitee 镜像");
} catch (e) {
  console.error("[fetch] 失败: " + (e && e.message || e));
  process.exit(1);
}
