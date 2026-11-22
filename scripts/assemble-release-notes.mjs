#!/usr/bin/env node
// assemble-release-notes.mjs — assemble the final GitHub Release body for a tag
//
// Usage:
//   node scripts/assemble-release-notes.mjs --tag v0.16.0-aiti.1 [--prev v0.15.15-aiti.9] \
//     [--notes-file releases/v0.16.0-aiti.1.md] [--out /tmp/notes-final.md] [--allow-missing]
//
// Body layout: human-written notes file (Highlights / Changes / Internal) + a
// fixed install/verify section + the Full Changelog compare line. The fixed
// section lives here (not in the notes file) so template upgrades never
// require rewriting old notes.
// Exit codes: 0 assembled · 2 notes file missing (caller may fall back to
// --generate-notes) — pass --allow-missing to still emit the fixed section.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();

function arg(name) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
}

const flag = (name) => process.argv.slice(2).includes(`--${name}`);

export function buildBody({ tag, version, prev, notes }) {
  const parts = [];
  if (notes && notes.trim()) parts.push(notes.trimEnd());
  const fixed = [];
  fixed.push(`---`);
  fixed.push(``);
  fixed.push(`## Install / Upgrade`);
  fixed.push(``);
  fixed.push("```bash");
  fixed.push(`npm i -g @aiti-ai/pi-web@${version}       # npm`);
  fixed.push(`docker pull aitiai/pi-web:${version}-core  # Docker (base image)`);
  fixed.push(`docker pull aitiai/pi-web:${version}-full  # Docker (all-in-one)`);
  fixed.push("```");
  fixed.push(``);
  fixed.push(`Archives below are verified against \`checksums.txt\`:`);
  fixed.push("");
  fixed.push("```bash");
  fixed.push(`sha256sum -c checksums.txt`);
  fixed.push("```");
  fixed.push(``);
  fixed.push(`Docs: https://aiti.pw/ · Changelog: https://aiti.pw/changelogs/`);
  parts.push(fixed.join("\n"));
  if (prev) {
    parts.push(`**Full Changelog**: https://github.com/aiti-ai/aiti-ai/compare/${prev}...${tag}`);
  }
  return parts.join("\n\n") + "\n";
}

async function main() {
  const tag = arg("tag");
  if (!tag || !/^v[\w.\-]+$/.test(tag)) {
    console.error("[assemble-notes] ✗ --tag v<version> required");
    process.exit(1);
  }
  const version = tag.replace(/^v/, "");
  const notesFile = arg("notes-file") || join(REPO, "releases", `${tag}.md`);
  const prev = arg("prev") || "";
  const out = arg("out");

  let notes = null;
  if (existsSync(notesFile)) {
    try { notes = readFileSync(notesFile, "utf8"); } catch { notes = null; }
  }
  if (!notes) {
    if (!flag("allow-missing")) {
      console.error(`[assemble-notes] ✗ ${notesFile} missing (exit 2 — caller falls back to --generate-notes)`);
      process.exit(2);
    }
    console.error(`[assemble-notes] ⚠ notes file missing, emitting fixed section only (--allow-missing)`);
  }

  const body = buildBody({ tag, version, prev, notes });
  if (out) {
    writeFileSync(out, body);
    console.log(`[assemble-notes] ✓ ${out} (${body.length} bytes, notes=${notes ? "yes" : "MISSING"}, prev=${prev || "none"})`);
  } else {
    process.stdout.write(body);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
