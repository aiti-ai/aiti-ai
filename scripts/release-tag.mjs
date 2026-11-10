#!/usr/bin/env node
// release-tag.mjs — 发版打 tag 唯一入口（带 fork 版本守卫）
//
// 用法：
//   node scripts/release-tag.mjs                # 校验 + 创建 annotated tag v<version>
//   node scripts/release-tag.mjs --dry-run      # 只校验和打印，不写任何东西
//   node scripts/release-tag.mjs --suggest      # 只建议当前基线的下一个 -aiti.N 构建号
//   node scripts/release-tag.mjs --force        # 工作树不干净时强行走（默认拒绝）
//
// 版本约定（Debian/Ubuntu 后缀模型）：
//   package.json version = "X.Y.Z-aiti.N"（fork 构建号；同上游基线重构建递增 N）
//   release tag          = "v<version>"（npm 版本 / 资产名 / GitHub Release 同源）
//   裸 "X.Y.Z"（无 -aiti.N）不发版 —— 上游 tag 语义留给上游，杜绝撞名。
//
// 守卫规则（全部通过才落 tag）：
//   ① version 形如 X.Y.Z-aiti.N（裸版本 / 其他 prerelease 一律拒绝）
//   ② tag v<version> 本地与 origin 均不存在
//   ③ 工作树干净（--force 豁免）
//   ④ tag 名只由 package.json 推导，不接受手工传入（防错位版本 / 裸 v* 混入）

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// git 式 cwd 语义：对哪个仓打 tag 由运行目录决定（fixture 测试也因此可行）
const REPO = process.cwd();
export const FORK_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-aiti\.(\d+)$/;

// ---- 纯函数（测试入口） ----

export function parseReleaseVersion(version) {
  const m = FORK_VERSION_PATTERN.exec(String(version || "").trim());
  if (!m) return null;
  const parts = m.slice(1, 4).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  const fork = Number(m[4]);
  return Number.isSafeInteger(fork) ? { version: String(version).trim(), tag: `v${version}`, parts, fork } : null;
}

/** 从既有 tag 名单里算同一上游基线的下一个构建号（无则 1） */
export function nextForkNumber(tags, coreVersion) {
  const re = new RegExp(`^v${coreVersion.replace(/\./g, "\\.")}-aiti\\.(\\d+)$`);
  let max = 0;
  for (const t of tags) {
    const m = re.exec(t);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function planRelease({ version, tags = [], clean = true }) {
  const parsed = parseReleaseVersion(version);
  if (!parsed) {
    return { ok: false, reason: `package.json version "${version}" 不是 X.Y.Z-aiti.N 形态 —— 发版必须带 -aiti.N 后缀（裸版本是上游语义，禁止撞名）` };
  }
  if (tags.includes(parsed.tag)) {
    return { ok: false, reason: `tag ${parsed.tag} 已存在（本地/远端）——同基线重构建请先把 package.json 的 -aiti.N 递增` };
  }
  if (!clean) {
    return { ok: false, reason: "工作树不干净 —— 先 commit/stash，或用 --force 明确豁免" };
  }
  return { ok: true, tag: parsed.tag, version: parsed.version };
}

// ---- git 帮手 ----

function git(args, { cwd = REPO } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

function collectTags() {
  const local = git(["tag", "--list"]).split("\n").filter(Boolean);
  let remote = [];
  try {
    remote = git(["ls-remote", "--tags", "origin"])
      .split("\n")
      .map((l) => l.split("\t")[1]?.replace(/^refs\/tags\//, ""))
      .filter((t) => t && !t.endsWith("^{}"));
  } catch {
    console.error("[release-tag] ls-remote origin 失败（离线?）——只按本地 tag 判重");
  }
  return [...new Set([...local, ...remote])];
}

// ---- main ----

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const suggest = args.includes("--suggest");
  const force = args.includes("--force");

  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const version = pkg.version;

  if (suggest) {
    const core = version.replace(/-aiti\.\d+$/, "");
    const tags = collectTags();
    const n = nextForkNumber(tags, core);
    console.log(`当前 package.json: ${version}`);
    console.log(`基线 ${core} 已有构建号 → 建议下一个: v${core}-aiti.${n}`);
    return;
  }

  const status = git(["status", "--porcelain"]);
  const plan = planRelease({ version, tags: collectTags(), clean: status.length === 0 || force });
  if (!plan.ok) {
    console.error(`[release-tag] ✗ ${plan.reason}`);
    process.exit(1);
  }

  console.log(`[release-tag] version=${plan.version} → tag=${plan.tag}`);
  if (dryRun) {
    console.log("[release-tag] --dry-run：校验通过，未创建。实际执行：");
    console.log(`  git tag -a ${plan.tag} -m "aiti-ai release ${plan.version}" && git push origin ${plan.tag}`);
    return;
  }

  git(["tag", "-a", plan.tag, "-m", `aiti-ai release ${plan.version}`]);
  console.log(`[release-tag] ✓ 已创建 ${plan.tag}`);
  console.log(`[release-tag] 下一步：git push origin ${plan.tag}  （触发 release.yml：构建四平台产物 + GitHub Release）`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
