#!/usr/bin/env node
// release-tag.mjs — 发版打 tag 唯一入口（带 fork 版本守卫）
//
// 用法：
//   node scripts/release-tag.mjs                # 校验 + 创建 annotated tag v<version>
//   node scripts/release-tag.mjs --dry-run      # 只校验和打印，不写任何东西
//   node scripts/release-tag.mjs --suggest      # 只建议当前基线的下一个 -aiti.N 构建号
//   node scripts/release-tag.mjs --force        # 工作树不干净时强行走（默认拒绝）
//   node scripts/release-tag.mjs --skip-notes   # 豁免 release notes 文件守卫（热修场景，显式警告）
//   node scripts/release-tag.mjs --skip-external # 豁免外部仓依赖地板校验（离线/已知缺失，显式警告）
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
//   ⑤ release notes 文件 releases/v<version>.md 存在且非空（>=3 non-empty lines;
//      TODO placeholder → soft warning; --skip-notes 豁免并显式警告）——
//      draft via scripts/draft-release-notes.mjs

import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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

// Guard ⑤: release notes file must exist and be non-empty (see draft-release-notes.mjs)
export function checkNotesFile(content) {
  if (content == null) {
    return { ok: false, reason: `release notes file releases/v<version>.md is missing — draft one with: node scripts/draft-release-notes.mjs (or pass --skip-notes to waive)` };
  }
  const nonEmpty = String(content).split("\n").filter((l) => l.trim()).length;
  if (nonEmpty < 3) {
    return { ok: false, reason: `release notes file is essentially empty (${nonEmpty} non-empty line(s) < 3) — write real notes or pass --skip-notes` };
  }
  const warns = [];
  if (/\bTODO\b/.test(content)) warns.push("draft placeholder (TODO) still present in the notes file — rewrite Highlights before tagging");
  return { ok: true, ...(warns.length ? { warn: warns.join("; ") } : {}) };
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
  // This is the only entry that creates and pushes the release tag, so an unrecognised flag
  // (historically `--help` was silently ignored and the run went on to tag) must abort here.
  const KNOWN_FLAGS = new Set(["--dry-run", "--suggest", "--force", "--skip-notes", "--skip-external"]);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`release-tag — validate the fork version and create the annotated tag v<version>

Usage:
  node scripts/release-tag.mjs                 validate + create the annotated tag
  node scripts/release-tag.mjs --dry-run       validate and print only, write nothing
  node scripts/release-tag.mjs --suggest       print the next -aiti.N number for this base
  node scripts/release-tag.mjs --force         allow a dirty worktree (default: refuse)
  node scripts/release-tag.mjs --skip-notes    waive the release-notes guard (hotfix; warned)
  node scripts/release-tag.mjs --skip-external waive the external-registry floor check
  -h, --help                                   show this help and exit

Guards (all must pass): version is X.Y.Z-aiti.N, tag is new locally and on origin, worktree is
clean, version > every existing tag, external dependency floors resolve, releases/<tag>.md exists.`);
    return;
  }
  for (const a of args) {
    if (KNOWN_FLAGS.has(a)) continue;
    console.error(`[release-tag] unknown argument: ${a}\n`);
    console.error("Run with --help to list the supported flags.");
    process.exit(2);
  }
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

  // Guard ⑤: release notes file (waivable via --skip-notes)
  const skipNotes = args.includes("--skip-notes");
  const notesPath = join(REPO, "releases", `${plan.tag}.md`);
  let notesContent = null;
  try { notesContent = readFileSync(notesPath, "utf8"); } catch {}
  const notes = checkNotesFile(notesContent);
  if (!notes.ok) {
    if (!skipNotes) {
      console.error(`[release-tag] ✗ ${notes.reason}`);
      process.exit(1);
    }
    console.error(`[release-tag] ⚠ release notes guard waived via --skip-notes: ${notes.reason}`);
  } else if (notes.warn) {
    console.error(`[release-tag] ⚠ ${notes.warn}`);
  }
  if (notesContent != null) console.log(`[release-tag] notes: releases/${plan.tag}.md (${String(notesContent).split("\n").filter((l) => l.trim()).length} lines)`);

  // Guard ⑥: external-repo dependency floors must already be on npmjs. Sibling repos
  // (content-share etc.) are NOT published by this repo's workflows, so a consumer
  // bump that lands before the provider's release only surfaces later as a raw npm
  // ETARGET while the shared build root installs (2026-11-22 content-share incident).
  const skipExternal = args.includes("--skip-external");
  const checker = join(REPO, "scripts", "check-external-deps.mjs");
  if (!skipExternal && existsSync(checker)) {
    const r = spawnSync(process.execPath, [checker, "--target", "official"], { cwd: REPO, encoding: "utf8" });
    if (r.status !== 0) {
      const detail = `${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(-14).join("\n");
      console.error(`[release-tag] ✗ external dependency floors are not satisfied on npmjs:\n${detail}`);
      console.error("[release-tag] publish the owning repos first (commands above), or pass --skip-external (offline / knowingly waived)");
      process.exit(1);
    }
  } else if (skipExternal) {
    console.error("[release-tag] ⚠ external dependency floors guard waived via --skip-external");
  }

  console.log(`[release-tag] version=${plan.version} → tag=${plan.tag}`);
  if (dryRun) {
    console.log("[release-tag] --dry-run：校验通过，未创建。实际执行：");
    console.log(`  git tag -a ${plan.tag} -m "aiti-ai release ${plan.version}" && git push origin ${plan.tag}`);
    return;
  }

  git(["tag", "-a", plan.tag, "-m", `aiti-ai release ${plan.version}`]);
  console.log(`[release-tag] ✓ 已创建 ${plan.tag}`);
  console.log(`[release-tag] 下一步：git push origin ${plan.tag}`);
  console.log(`[release-tag] 之后：gh workflow run release.yml --ref ${plan.tag}  （workflow_dispatch-only，push tag 不会自动触发；主包发布用 gh workflow run publish.yml --ref ${plan.tag}）`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
