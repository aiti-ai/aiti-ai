#!/usr/bin/env node
// publish-gitee-mirror.mjs — mirror a GitHub Release into the Gitee mirror repo.
//
// Gitee caps release attachments at 100 MB, so archives above --part-size
// (default 95 MiB headroom) are uploaded as <asset>.part-N pieces plus a tiny
// <asset>.split manifest holding the part count; the installers reassemble and
// checksum-verify against checksums.txt exactly as on GitHub.
//
// Usage:
//   node scripts/publish-gitee-mirror.mjs --tag v0.16.0-aiti.1 [--assets-dir DIR] [--repo ghOwner/ghRepo] [--gitee owner/repo]
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
  console.error("usage: publish-gitee-mirror.mjs --tag v0.16.0-aiti.1 [--assets-dir DIR]");
  process.exit(1);
}
const GH_REPO = opt("--repo") || "aiti-ai/aiti-ai";
const GE_REPO = opt("--gitee") || "aiti-ai/aiti-ai";
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
// Release body: mirror the GitHub notes (assembled by release.yml from
// releases/<tag>.md). The fixed line stays first — GitHub links inside the
// notes are unreachable from CN networks, which is exactly why this mirror
// exists; the notes text itself is still worth carrying.
let ghBody = "";
try {
  const ghRel = await (await ghApi(`/releases/tags/${TAG}`)).json();
  if (ghRel && ghRel.body && String(ghRel.body).trim()) ghBody = String(ghRel.body).trim();
} catch {}
const MIRROR_NOTE = `Prebuilt release mirror of https://github.com/${GH_REPO}/releases/tag/${TAG} (identical assets + checksums).`;
const mirrorBody = ghBody ? `${MIRROR_NOTE}\n\n---\n\n${ghBody}` : MIRROR_NOTE;
if (ghBody) console.log(`[gitee] GitHub release body found (${ghBody.length} chars) — will mirror as release body`);
else console.error(`[gitee] ⚠ no GitHub release body for ${TAG} — keeping the plain mirror note`);

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
      body: mirrorBody,
    }),
  });
  rel = await r.json();
  if (!rel.id) throw new Error(`gitee release create failed: ${JSON.stringify(rel).slice(0, 300)}`);
}
console.log(`[gitee] release id=${rel.id} tag=${rel.tag_name}`);

// Keep the body in sync even when the release already existed (idempotent
// re-publish) — the GitHub notes assembled by release.yml are the source of
// truth. A failed PATCH is a warning, not a failure: attachments are the
// core of the mirror, and the release.yml job is continue-on-error anyway.
const pr = await api(`/releases/${rel.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ access_token: TOKEN, body: mirrorBody }),
});
if (pr.ok) console.log(`[gitee] body synced (${mirrorBody.length} chars${ghBody ? ", from GitHub notes" : ", mirror note only"})`);
else console.error(`[gitee] ⚠ body PATCH failed: HTTP ${pr.status} — release keeps its previous body`);

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
  // Chunk dir must not collide with the downloaded file's own path (split reads it).
  const partsDir = join(WORK, `${f.name}.parts`);
  rmSync(partsDir, { recursive: true, force: true });
  mkdirSync(partsDir, { recursive: true });
  execFileSync("split", ["-b", String(PART_SIZE), "-d", "-a", "2", f.path, join(partsDir, "p.")]);
  for (let i = 0; i < parts; i++) {
    const n = String(i).padStart(2, "0");
    const from = join(partsDir, `p.${n}`);
    const to = join(partsDir, `${f.name}.part-${i + 1}`);
    if (from !== to) execFileSync("mv", [from, to]);
    uploads.push({ name: `${f.name}.part-${i + 1}`, path: to });
  }
  const manifest = join(partsDir, `${f.name}.split`);
  writeFileSync(manifest, String(parts) + "\n");
  uploads.push({ name: `${f.name}.split`, path: manifest });
}

// ---- drop existing attachments whose names collide (idempotent re-publish) ----
const existing = (await (await api(`/releases/${rel.id}/attach_files?access_token=${TOKEN}`)).json()) || [];
let deleteFailed = 0;
for (const a of existing) {
  if (uploads.some((u) => u.name === a.name)) {
    console.log(`[gitee] replacing existing attachment: ${a.name}`);
    const dr = await api(`/releases/${rel.id}/attach_files/${a.id}?access_token=${TOKEN}`, { method: "DELETE" });
    if (!dr.ok) {
      // A leftover attachment makes the re-upload below fail too, so this must
      // not slip through silently in CI — counted into the exit code.
      deleteFailed++;
      console.error(`  delete ${a.name} failed: HTTP ${dr.status}`);
    }
  }
}

// ---- upload ----
let uploadFailed = 0;
for (const u of uploads) {
  process.stdout.write(`[gitee] upload ${u.name} (${(statSync(u.path).size / 1048576).toFixed(1)} MB) ... `);
  const buf = readFileSync(u.path);
  const form = new FormData();
  form.append("access_token", TOKEN);
  form.append("file", new Blob([buf]), u.name);
  const r = await api(`/releases/${rel.id}/attach_files`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.name === u.name) console.log("ok");
  else {
    uploadFailed++;
    console.log(`FAIL: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  }
}

// Non-zero exit on any failure so CI (release.yml gitee-mirror job) surfaces
// partial syncs instead of silently shipping a broken mirror.
if (deleteFailed > 0 || uploadFailed > 0) {
  console.error(`[gitee] FAILED: ${deleteFailed} delete(s) + ${uploadFailed} upload(s) failed`);
  process.exit(1);
}
console.log(`[gitee] done: ${uploads.length} asset(s) synced`);
