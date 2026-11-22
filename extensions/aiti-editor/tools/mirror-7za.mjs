#!/usr/bin/env node
/**
 * aiti-editor · 同步 portable 7za 到 Gitee 镜像仓库 justdb-mirrors/downloads
 *
 * 背景：运行时解析 7z/rar 等专有格式需要 portable 7za。单一 GitHub 源在国内可能
 * 拉不动，所以把 8 个平台二进制镜像到 gitee.com/justdb-mirrors/downloads
 * 仓库（https://gitee.com/justdb-mirrors/downloads/raw/master/7zip-bin/<平台>/7za），
 * 运行时 justget 多源竞速（GitHub 主源 + Gitee 镜像）。
 *
 * 用法：
 *   node tools/mirror-7za.mjs               # 下载全部平台 + push 到 gitee（有变化才 push）
 *   env GITEE_REMOTE="git@gitee.com:justdb-mirrors/downloads.git" node tools/mirror-7za.mjs
 *
 * 幂等：比对内容 hash，无变化跳过 push。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const SOURCES = [
  ["linux/ia32/7za", "https://raw.githubusercontent.com/develar/7zip-bin/master/linux/ia32/7za"],
  ["linux/x64/7za", "https://raw.githubusercontent.com/develar/7zip-bin/master/linux/x64/7za"],
  ["linux/arm/7za", "https://raw.githubusercontent.com/develar/7zip-bin/master/linux/arm/7za"],
  ["linux/arm64/7za", "https://raw.githubusercontent.com/develar/7zip-bin/master/linux/arm64/7za"],
  ["win/ia32/7za.exe", "https://raw.githubusercontent.com/develar/7zip-bin/master/win/ia32/7za.exe"],
  ["win/x64/7za.exe", "https://raw.githubusercontent.com/develar/7zip-bin/master/win/x64/7za.exe"],
  ["mac/x64/7za", "https://raw.githubusercontent.com/develar/7zip-bin/master/mac/x64/7za"],
  ["mac/arm64/7za", "https://raw.githubusercontent.com/develar/7zip-bin/master/mac/arm64/7za"],
];
const GITEE_REMOTE = process.env.GITEE_REMOTE || "git@gitee.com:justdb-mirrors/downloads.git";
const UA = "aiti-editor-mirror/0.1";

async function download(url) {
  const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return Buffer.from(await r.arrayBuffer());
}

async function syncGitee(entries) {
  console.log("[gitee] 同步到 " + GITEE_REMOTE + " …");
  const tmpRepo = resolve(tmpdir(), "aiti-editor-7za-mirror-" + Date.now());
  mkdirSync(tmpRepo, { recursive: true });
  execSync("git init -q", { cwd: tmpRepo });
  execSync("git remote add origin " + JSON.stringify(GITEE_REMOTE), { cwd: tmpRepo });
  execSync("git fetch -q origin", { cwd: tmpRepo, stdio: "ignore" });
  try { execSync("git checkout -q -B master origin/master", { cwd: tmpRepo, stdio: "ignore" }); }
  catch (e) { execSync("git checkout -q -B master", { cwd: tmpRepo }); }
  mkdirSync(resolve(tmpRepo, "7zip-bin"), { recursive: true });
  let changed = false;
  for (const { rel, buf } of entries) {
    const dir = resolve(tmpRepo, "7zip-bin", rel.split("/").slice(0, -1).join("/"));
    mkdirSync(dir, { recursive: true });
    const dest = resolve(tmpRepo, "7zip-bin", rel);
    const sha1 = createHash("sha1").update(buf).digest("hex");
    if (existsSync(dest) && createHash("sha1").update(readFileSync(dest)).digest("hex") === sha1) continue;
    writeFileSync(dest, buf);
    changed = true;
    console.log("[gitee] + " + rel + "（" + (buf.length / 1024).toFixed(0) + "KB）");
  }
  // README（首次）
  const readme = resolve(tmpRepo, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(readme, "# justdb downloads 镜像仓库\n\n第三方二进制/数据文件的国内镜像（justget 多源下载用）。\n原始版权归各自作者（7zip-bin: develar / 7-Zip）。\n");
    changed = true;
  }
  if (!changed) { console.log("[gitee] 无变化（跳过 push）"); rmSync(tmpRepo, { recursive: true, force: true }); return; }
  execSync("git add -A", { cwd: tmpRepo });
  const stamp = new Date().toISOString().replace(/T/, " ").slice(0, 19);
  execSync("git -c user.email=ai@aiti.local -c user.name=aiti-ai commit -q -m " + JSON.stringify("mirror: 7zip-bin portable 7za 全平台 · " + stamp), { cwd: tmpRepo });
  execSync("git push -q origin master", { cwd: tmpRepo, stdio: "inherit" });
  console.log("[gitee] 已推送 " + GITEE_REMOTE + "（master）");
  rmSync(tmpRepo, { recursive: true, force: true });
}

async function main() {
  if (process.argv.includes("--download-only")) {
    const tmpDir = resolve(tmpdir(), "aiti-editor-7za-" + Date.now());
    mkdirSync(tmpDir, { recursive: true });
    for (const [rel, url] of SOURCES) {
      const buf = await download(url);
      const dest = resolve(tmpDir, rel);
      mkdirSync(resolve(tmpDir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(dest, buf);
      console.log("[fetch] " + rel + " → " + dest + "（" + (buf.length / 1024).toFixed(0) + "KB）");
    }
    console.log("[done] 已下载到 " + tmpDir + "（本地检查用）");
    process.exit(0);
  }
  try {
    console.log("[fetch] 下载 8 平台 7za …");
    const entries = [];
    for (const [rel, url] of SOURCES) {
      const buf = await download(url);
      entries.push({ rel, buf });
      console.log("[fetch] " + rel + "（" + (buf.length / 1024).toFixed(0) + "KB）");
    }
    await syncGitee(entries);
    console.log("[done] 镜像同步完成");
  } catch (e) {
    console.error("[mirror] 失败: " + (e && e.message || e));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[mirror] 失败: " + (e && e.message || e));
  process.exit(1);
});