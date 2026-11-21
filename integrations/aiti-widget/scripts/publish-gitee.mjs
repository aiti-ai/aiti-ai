#!/usr/bin/env node
/**
 * Mirror an aiti-widget GitHub Release into the Gitee mirror.
 *
 *   node scripts/publish-gitee.mjs --tag aiti-widget-v0.2.0 --assets-dir dist
 *
 * Env:
 *   AITI_GITEE_TOKEN  required — Gitee personal access token (projects scope)
 *   GITHUB_TOKEN      optional — raises GitHub API limits when fetching notes
 *
 * The widget assets are small (< 100 MB), so this intentionally does not split
 * files. If a future asset exceeds the Gitee attachment cap, the upload fails
 * loudly instead of shipping a partial mirror.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const TAG = opt("--tag");
if (!TAG) {
  console.error("usage: publish-gitee.mjs --tag aiti-widget-v0.2.0 --assets-dir dist");
  process.exit(1);
}
const GH_REPO = opt("--repo") || "aiti-ai/aiti-ai";
const GE_REPO = opt("--gitee") || "aiti-ai/aiti-ai";
const TITLE = opt("--title") || `aiti-widget ${TAG.replace(/^aiti-widget-/, "")}`;
const GITEE_TOKEN = process.env.AITI_GITEE_TOKEN;
if (!GITEE_TOKEN) {
  console.error("AITI_GITEE_TOKEN env required (Gitee personal access token)");
  process.exit(1);
}
const ASSETS_DIR = opt("--assets-dir");
if (!ASSETS_DIR) {
  console.error("--assets-dir is required (the release job passes the downloaded artifacts)");
  process.exit(1);
}

const API_BASE = String(process.env.AITI_GITEE_API_BASE || "https://gitee.com/api/v5").replace(/\/+$/, "");
const GH_API_BASE = String(process.env.AITI_GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, "");
const giteeApi = (path, init = {}) =>
  fetch(`${API_BASE}/repos/${GE_REPO}${path}`, {
    ...init,
    signal: AbortSignal.timeout(Number(process.env.AITI_GITEE_TIMEOUT_MS) || 120000),
  });

async function githubBody() {
  const headers = { "User-Agent": "aiti-widget-release" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const response = await fetch(`${GH_API_BASE}/repos/${GH_REPO}/releases/tags/${TAG}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return "";
    const release = await response.json();
    return String(release.body || "").trim();
  } catch {
    return "";
  }
}

const notes = await githubBody();
const mirrorNote = `Prebuilt release mirror of https://github.com/${GH_REPO}/releases/tag/${TAG} (identical assets + checksums).`;
const body = notes ? `${mirrorNote}\n\n---\n\n${notes}` : mirrorNote;

let release = await (await giteeApi(`/releases/tags/${TAG}?access_token=${GITEE_TOKEN}`)).json();
if (!release || !release.id || release.message) {
  console.log(`[gitee] creating release ${TAG}`);
  const response = await giteeApi("/releases", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      access_token: GITEE_TOKEN,
      tag_name: TAG,
      target_commitish: "main",
      name: TITLE,
      body,
    }),
  });
  release = await response.json();
  if (!release.id) throw new Error(`Gitee release create failed: ${JSON.stringify(release).slice(0, 300)}`);
} else {
  console.log(`[gitee] release exists id=${release.id} — syncing title/body`);
  const response = await giteeApi(`/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: GITEE_TOKEN, name: TITLE, body }),
  });
  if (!response.ok) console.warn(`[gitee] body PATCH failed: HTTP ${response.status}`);
}
console.log(`[gitee] release id=${release.id} tag=${release.tag_name}`);

const files = readdirSync(resolve(ASSETS_DIR))
  .map((name) => ({ name, path: join(resolve(ASSETS_DIR), name) }))
  .filter((file) => statSync(file.path).isFile());
if (!files.length) throw new Error(`no assets in ${ASSETS_DIR}`);
const tooLarge = files.filter((file) => statSync(file.path).size > 100 * 1024 * 1024);
if (tooLarge.length) {
  throw new Error(`asset exceeds Gitee's 100 MB cap: ${tooLarge.map((f) => f.name).join(", ")}`);
}

const existing = (await (await giteeApi(`/releases/${release.id}/attach_files?access_token=${GITEE_TOKEN}`)).json()) || [];
let deleteFailed = 0;
for (const asset of existing) {
  if (!files.some((file) => file.name === asset.name)) continue;
  const response = await giteeApi(`/releases/${release.id}/attach_files/${asset.id}?access_token=${GITEE_TOKEN}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    deleteFailed += 1;
    console.error(`[gitee] delete ${asset.name} failed: HTTP ${response.status}`);
  }
}

let uploadFailed = 0;
for (const file of files) {
  const size = (statSync(file.path).size / 1048576).toFixed(1);
  process.stdout.write(`[gitee] upload ${file.name} (${size} MB) ... `);
  const form = new FormData();
  form.append("access_token", GITEE_TOKEN);
  form.append("file", new Blob([readFileSync(file.path)]), file.name);
  const response = await giteeApi(`/releases/${release.id}/attach_files`, { method: "POST", body: form });
  const result = await response.json().catch(() => ({}));
  if (response.ok && result.name === file.name) console.log("ok");
  else {
    uploadFailed += 1;
    console.log(`FAIL: ${response.status} ${JSON.stringify(result).slice(0, 200)}`);
  }
}

if (deleteFailed || uploadFailed) {
  console.error(`[gitee] FAILED: ${deleteFailed} delete(s) + ${uploadFailed} upload(s)`);
  process.exit(1);
}
console.log(`[gitee] done: ${files.length} asset(s) synced`);
