#!/usr/bin/env node
// Upstream-merge line auditor (the tool that found the #1429 / mobile-toolbar
// merge losses). After merging upstream, run it per suspicious file:
//
//   node scripts/check-upstream-merge.mjs --base <merge-base-tag> --upstream <upstream-tip-ref> \
//        [--file components/ChatInput.tsx ...]   (default: the merge-sensitive set below)
//
// It lists every line that upstream ADDED since the merge base but that is not
// present (whitespace-normalized) in the working tree — i.e. candidates the
// merge dropped. The output is a REVIEW LIST, not a verdict: fork-intentional
// rewrites (providerName mapping, StreamingActionButton, custom top bar, the
// WeChat-style mobile send …) also show up here. Triage each line:
//   • fork-intentional  → note it in the PR/commit message, move on
//   • merge loss        → restore the upstream form (and check the demo mirror)
// Pair it with the pins: ChatInput.mobile-send / ChatInput.composer-shrink-chain /
// AppShell.topbar-dedup / AppShell.mobile-toolbar — see the merge guard notes in the private source workspace.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const base = flag("--base");
const upstream = flag("--upstream");
if (!base || !upstream) {
  console.error("usage: node scripts/check-upstream-merge.mjs --base <merge-base> --upstream <tip> [--file <path> ...]");
  process.exit(2);
}

const DEFAULT_FILES = [
  "components/ChatInput.tsx",
  "components/ChatWindow.tsx",
  "components/AppShell.tsx",
  "components/ModelSelector.tsx",
  "components/TabBar.tsx",
  "components/FileExplorer.tsx",
  "app/globals.css",
  "app/settings.css",
  "app/sidebar.css",
  "hooks/useIsMobile.ts",
];

const fileArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--file") fileArgs.push(args[i + 1]);
}
const files = fileArgs.length ? fileArgs : DEFAULT_FILES;

const norm = (s) => s.replace(/\s+/g, " ").trim();
let hadMissing = false;

for (const file of files) {
  let diff;
  try {
    diff = execSync(`git diff ${base} ${upstream} -- ${file}`, { encoding: "utf8", maxBuffer: 1e8 });
  } catch {
    console.log(`=== ${file}: skipped (git diff failed) ===`);
    continue;
  }
  let head;
  try {
    head = readFileSync(file, "utf8");
  } catch {
    console.log(`=== ${file}: skipped (not in working tree) ===`);
    continue;
  }
  const headNorm = head.split("\n").map(norm);
  const missing = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const t = norm(line.slice(1));
      if (t && !headNorm.includes(t)) missing.push(t);
    }
  }
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  console.log(`=== ${file}: upstream net-new ${added} lines, ${missing.length} not in working tree ===`);
  for (const m of missing) console.log(`  MISS: ${m.slice(0, 160)}`);
  if (missing.length) hadMissing = true;
}

console.log(hadMissing
  ? "\nReview each MISS: fork-intentional rewrite vs merge loss (see the merge guard notes in the private source workspace)."
  : "\nAll upstream net-new lines are present in the working tree.");
