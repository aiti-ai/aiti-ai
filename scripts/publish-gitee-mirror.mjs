#!/usr/bin/env node
// publish-gitee-mirror.mjs — mirror a GitHub Release into the Gitee mirror repo.
//
// Gitee caps release attachments at 100 MB, so archives above --part-size
// (default 95 MiB headroom) are uploaded as <asset>.part-N pieces plus a tiny
// <asset>.split manifest holding the part count; the installers reassemble and
// checksum-verify against checksums.txt exactly as on GitHub.
//
// Usage:
//   node scripts/publish-gitee-mirror.mjs --tag v0.15.7 [--assets-dir DIR] [--repo ghOwner/ghRepo] [--gitee owner/repo]
// Env: AITI_GITEE_TOKEN (required), GITHUB_TOKEN (optional, raises GH rate limits)
// --assets-dir DIR reuses pre-downloaded release files instead of downloading
// from GitHub (large archives: prefer aria2 -x16 beforehand).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const TAG = opt("--tag");
if (!TAG) {
  console.error("usage: publish-gitee-mirror.mjs --tag v0.15.7 [--assets-dir DIR]");
  process.exit(1);
}
const GH_REPO = opt("--repo") || "aiti-ai/aiti-ai";
const GE_REPO = opt("--gitee") || "justdb-mirrors/aiti-web";
const TOKEN = process.env.AITI_GITEE_TOKEN;
if (!TOKEN) {
  console.error("AITI_GITEE_TOKEN env required (gitee personal access token)");
  process.exit(1);
}
const PART_SIZE = 95 * 1024 * 1024; // 95 MiB — under Gitee's 100 MB cap with headroom
const WORK = resolve(opt("--work") || join("tmp", "gitee-mirror-work"));

const api = (path, init = {}) =>
  fetch(`https://gitee.com/api/v5/repos/${GE_REPO}${path}`, init);

const ghApi = (path) => {
  const headers = { "User-Agent": "aiti-release-mirror" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return fetch(`https://api.github.com/repos/${GH_REPO}${path}`, { headers });
};

// ---- get gitee release (by tag), create if missing ----
let rel = await (await api(`/releases/tags/${TAG}?access_token=${TOKEN}`)).json();
if (!rel || !rel.id || rel.message) {
  console.log(`[gitee] release ${TAG} not found — creating (target_commitish=main)`);
  const r = await api(`/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      access_token: TOKEN,
      tag_name: TAG,
      target_commitish: "main",
      name: `aiti-web ${TAG}`,
      body: `Prebuilt release mirror of https://github.com/${GH_REPO}/releases/tag/${TAG} (identical assets + checksums).`,
    }),
  });
  rel = await r.json();
  if (!rel.id) throw new Error(`gitee release create failed: ${JSON.stringify(rel).slice(0, 300)}`);
}
console.log(`[gitee] release id=${rel.id} tag=${rel.tag_name}`);

// ---- gather assets ----
let files = [];
const assetsDir = opt("--assets-dir");
if (assetsDir) {
  const dir = resolve(assetsDir);
  files = readdirSync(dir).map((f) => ({ name: f, path: join(dir, f) }));
  console.log(`[assets] reusing ${files.length} file(s) from ${dir}`);
} else {
  mkdirSync(WORK, { recursive: true });
  const ghRel = await (await ghApi(`/releases/tags/${TAG}`)).json();
  if (!ghRel.assets) throw new Error(`github release ${TAG} not found: ${JSON.stringify(ghRel).slice(0, 200)}`);
  for (const a of ghRel.assets) {
    const dest = join(WORK, a.name);
    if (existsSync(dest) && statSync(dest).size === a.size) {
      console.log(`[assets] cached: ${a.name}`);
    } else {
      console.log(`[assets] downloading ${a.name} (${(a.size / 1048576).toFixed(1)} MB) ...`);
      const r = await fetch(a.browser_download_url, { redirect: "follow" });
      if (!r.ok) throw new Error(`download failed ${a.name}: ${r.status}`);
      writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    }
    files.push({ name: a.name, path: dest });
  }
}

// ---- split oversized files ----
const uploads = [];
for (const f of files) {
  const size = statSync(f.path).size;
  if (size <= PART_SIZE) {
    uploads.push({ name: f.name, path: f.path });
    continue;
  }
  const parts = Math.ceil(size / PART_SIZE);
  console.log(`[split] ${f.name}: ${(size / 1048576).toFixed(1)} MB → ${parts} part(s)`);
  rmSync(join(WORK, f.name), { recursive: true, force: true });
  mkdirSync(join(WORK, f.name), { recursive: true });
  execFileSync("split", ["-b", String(PART_SIZE), "-d", "-a", "2", f.path, join(WORK, f.name, "p.")]);
  for (let i = 0; i < parts; i++) {
    const n = String(i).padStart(2, "0");
    const from = join(WORK, f.name, `p.${n}`);
    const to = join(WORK, f.name, `${f.name}.part-${i + 1}`);
    if (from !== to) execFileSync("mv", [from, to]);
    uploads.push({ name: `${f.name}.part-${i + 1}`, path: to });
  }
  const manifest = join(WORK, f.name, `${f.name}.split`);
  writeFileSync(manifest, String(parts) + "\n");
  uploads.push({ name: `${f.name}.split`, path: manifest });
}

// ---- drop existing attachments whose names collide (idempotent re-publish) ----
const existing = (await (await api(`/releases/${rel.id}/attach_files?access_token=${TOKEN}`)).json()) || [];
for (const a of existing) {
  if (uploads.some((u) => u.name === a.name)) {
    console.log(`[gitee] replacing existing attachment: ${a.name}`);
    const dr = await api(`/releases/${rel.id}/attach_files/${a.id}?access_token=${TOKEN}`, { method: "DELETE" });
    if (!dr.ok) console.error(`  delete ${a.name} failed: HTTP ${dr.status}`);
  }
}

// ---- upload ----
for (const u of uploads) {
  process.stdout.write(`[gitee] upload ${u.name} (${(statSync(u.path).size / 1048576).toFixed(1)} MB) ... `);
  const buf = readFileSync(u.path);
  const form = new FormData();
  form.append("access_token", TOKEN);
  form.append("file", new Blob([buf]), u.name);
  const r = await api(`/releases/${rel.id}/attach_files`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.name === u.name) console.log("ok");
  else console.log(`FAIL: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
}
console.log("[gitee] done");
