#!/usr/bin/env node
// draft-release-notes.mjs — draft a release notes skeleton for the next release
//
// Usage:
//   node scripts/draft-release-notes.mjs                          # package.json version → releases/v<version>.md
//   node scripts/draft-release-notes.mjs --tag v0.16.0-aiti.1     # explicit tag (file name only)
//   node scripts/draft-release-notes.mjs --out path/to.md         # custom output path
//   node scripts/draft-release-notes.mjs --dry-run                # print to stdout, write nothing
//   node scripts/draft-release-notes.mjs --force                  # overwrite an existing draft
//
// Commit range: previous tag (git describe --tags --abbrev=0 HEAD) .. HEAD.
// Grouping by conventional prefix:
//   feat → Features · fix → Bug Fixes · perf → Performance
//   everything else (sync/chore/docs/test/refactor/build/ci/no prefix) → Internal
// The "(mirror workspace-tools <hash>)" trailer is stripped — internal bookkeeping, and
// workspace-tools hashes have no target on GitHub.
//
// The draft carries only the human-written part (Highlights + grouped changes).
// Install/assets/compare sections are appended by release.yml at publish time.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";

const REPO = process.cwd();

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

// ---- pure helpers (fixture-testable) ----

export function stripMirrorTrailer(subject) {
  return String(subject || "").replace(/\s*\(mirror workspace-tools[^\)]*\)\s*$/i, "").trim();
}

const GROUPS = [
  { type: "feat", title: "Features" },
  { type: "fix", title: "Bug Fixes" },
  { type: "perf", title: "Performance" },
];

export function parseCommitType(subject) {
  const m = /^(feat|fix|perf|sync|chore|docs|test|refactor|build|ci)(?:\([^)]*\))?:\s+/.exec(String(subject || ""));
  return m ? m[1] : null;
}

export function groupCommits(commits) {
  const out = { groups: [], internal: [] };
  const byTitle = new Map();
  for (const g of GROUPS) {
    const list = [];
    byTitle.set(g.title, list);
    out.groups.push({ title: g.title, commits: list });
  }
  for (const c of commits) {
    const type = parseCommitType(c.subject);
    const line = `- ${stripMirrorTrailer(c.subject)} (${c.hash})`;
    if (!type) { out.internal.push(line); continue; }
    const g = GROUPS.find((x) => x.type === type);
    if (g) byTitle.get(g.title).push(line);
    else out.internal.push(line);
  }
  return out;
}

export function renderDraft({ tag, range, commits }) {
  const { groups, internal } = groupCommits(commits);
  const lines = [];
  lines.push(`## Highlights`);
  lines.push("");
  lines.push(`<!-- Write 1-5 user-facing highlights; delete this comment when done. -->`);
  lines.push(`- TODO: ...`);
  lines.push("");
  lines.push(`## Changes`);
  for (const g of groups) {
    if (!g.commits.length) continue;
    lines.push("");
    lines.push(`### ${g.title}`);
    lines.push("");
    lines.push(...g.commits);
  }
  if (internal.length) {
    lines.push("");
    lines.push(`## Internal`);
    lines.push("");
    lines.push(...internal);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---- main ----

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const tagArg = (args.find((a) => a.startsWith("--tag=")) || (args.includes("--tag") ? args[args.indexOf("--tag") + 1] : "")) || "";
  const outArg = (args.find((a) => a.startsWith("--out=")) || (args.includes("--out") ? args[args.indexOf("--out") + 1] : "")) || "";

  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const tag = tagArg || `v${pkg.version}`;
  const outPath = outArg || join(REPO, "releases", `${tag}.md`);

  // previous tag relative to HEAD (not to --tag) — the draft always covers
  // what is on HEAD but not yet released
  let prev;
  try {
    prev = git(["describe", "--tags", "--abbrev=0", "HEAD"]);
  } catch {
    console.error("[draft-notes] ✗ no previous tag found (git describe) — nothing to diff against");
    process.exit(1);
  }
  const logRaw = git(["log", "--format=%h%x00%s", `${prev}..HEAD`]);
  const commits = logRaw.split("\n").filter(Boolean).map((l) => {
    const [hash, ...rest] = l.split("\x00");
    return { hash, subject: rest.join("\x00") };
  });

  if (!commits.length) {
    console.error(`[draft-notes] ✗ no commits between ${prev} and HEAD — nothing to draft`);
    process.exit(1);
  }

  const body = renderDraft({ tag, range: `${prev}..HEAD`, commits });

  console.log(`[draft-notes] ${prev}..HEAD → ${commits.length} commit(s)`);
  const counts = {};
  for (const c of commits) {
    const t = parseCommitType(c.subject) || "(none)";
    counts[t] = (counts[t] || 0) + 1;
  }
  console.log(`[draft-notes] grouping: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  if (dryRun) {
    console.log("[draft-notes] --dry-run: draft below (not written)\n");
    console.log(body);
    return;
  }

  if (existsSync(outPath) && !force) {
    console.error(`[draft-notes] ✗ ${outPath} already exists — pass --force to overwrite (human edits are not clobbered silently)`);
    process.exit(1);
  }

  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body);
  console.log(`[draft-notes] ✓ written ${outPath}`);
  console.log(`[draft-notes] next: rewrite Highlights (drop the TODO placeholder), review grouping, then commit and run scripts/release-tag.mjs`);
}

main().catch((e) => {
  console.error(`[draft-notes] ✗ ${e.message}`);
  process.exit(1);
});
