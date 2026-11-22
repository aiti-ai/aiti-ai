#!/usr/bin/env node
// sync-tunnel-binaries.mjs — publish the Dockerfile.full ④ binaries (cloudflared / ttyd / frp) to a gitee release
// so builds on a throttled network can race an in-country mirror instead of depending on a third-party GitHub
// accelerator that may disappear.
//
// Dockerfile.full consumes the result through GITEE_BIN_BASE; the asset names here are exactly the <gitee-name>
// values passed to dl() there — keep the two in sync:
//   cloudflared-linux-<garch> · ttyd.<tarch> · frp_<ver>_linux_<garch_f>.tar.gz
//
// Versions are read from Dockerfile.full: bump the pins there first, then re-run this script. The default tag stays
// put (vendor-v1) so the URL in the Dockerfile keeps working; pass --tag vendor-v2 only when you want to force a
// fresh cache key for every build.
//
// Usage:
//   AITI_GITEE_TOKEN=... node scripts/sync-tunnel-binaries.mjs [--arches amd64,arm64]
//     [--gitee owner/repo] [--tag vendor-v1] [--accel <prefix>[,<prefix>]] [--assets-dir DIR] [--dry-run]
//
// --assets-dir DIR reuses already-downloaded files instead of fetching them again.
// Gitee caps a single attachment at 100 MB; every asset here is far below that.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (f, d = null) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const DRY = args.includes("--dry-run");
const GE_REPO = opt("--gitee", "aiti-ai/tunnel-binaries");
const TAG = opt("--tag", "vendor-v1");
const ARCHES = (opt("--arches", "amd64") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ACCEL = (opt("--accel", "https://ghfast.top/https://github.com") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ASSETS_DIR = opt("--assets-dir");
const WORK = resolve(opt("--work", join("tmp", "tunnel-binaries")));
const TOKEN = process.env.AITI_GITEE_TOKEN;

// ---- pins from the Dockerfile (single source of truth for the versions) ----
const dockerfilePath = new URL("../docker/Dockerfile.full", import.meta.url);
const dockerfile = readFileSync(dockerfilePath, "utf8");
const pick = (re, what) => {
  const m = dockerfile.match(re);
  if (!m) throw new Error(`docker/Dockerfile.full: cannot locate ${what} — did the ④ block change?`);
  return m[1];
};
const CF_VER = pick(/cloudflared\/releases\/download\/([\w.-]+)\/cloudflared-linux-/, "the cloudflared pin");
const TTYD_VER = pick(/ttyd\/releases\/download\/([\w.-]+)\/ttyd\./, "the ttyd pin");
const FRP_VER = pick(/frp\/releases\/download\/v([\w.-]+)\/frp_/, "the frp pin");

const ARCH = {
  amd64: { garch: "amd64", tarch: "x86_64", garch_f: "amd64" },
  arm64: { garch: "aarch64", tarch: "aarch64", garch_f: "arm64" },
};

const targets = [];
for (const a of ARCHES) {
  const m = ARCH[a];
  if (!m) throw new Error(`unsupported arch "${a}" (expected amd64 or arm64)`);
  targets.push(
    {
      name: `cloudflared-linux-${m.garch}`,
      rel: `cloudflare/cloudflared/releases/download/${CF_VER}/cloudflared-linux-${m.garch}`,
    },
    { name: `ttyd.${m.tarch}`, rel: `tsl0922/ttyd/releases/download/${TTYD_VER}/ttyd.${m.tarch}` },
    {
      name: `frp_${FRP_VER}_linux_${m.garch_f}.tar.gz`,
      rel: `fatedier/frp/releases/download/v${FRP_VER}/frp_${FRP_VER}_linux_${m.garch_f}.tar.gz`,
    },
  );
}

console.log(`[bins] Dockerfile pins: cloudflared ${CF_VER} · ttyd ${TTYD_VER} · frp ${FRP_VER}`);
console.log(`[bins] target release: gitee ${GE_REPO} @ ${TAG} (${ARCHES.join(", ")})`);

// ---- download ----
async function fetchTo(out, url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "aiti-tunnel-binaries-sync" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("empty body");
  writeFileSync(out, buf);
  return buf.length;
}

mkdirSync(WORK, { recursive: true });
const uploads = [];
for (const t of targets) {
  const reused = ASSETS_DIR ? join(resolve(ASSETS_DIR), t.name) : null;
  const out = reused && existsSync(reused) ? reused : join(WORK, t.name);
  if (reused && existsSync(reused)) {
    console.log(`[bins] ${t.name} — reuse ${reused} (${(statSync(out).size / 1048576).toFixed(1)} MB)`);
  } else {
    const candidates = [`https://github.com/${t.rel}`, ...ACCEL.map((a) => `${a}/${t.rel}`)];
    let size = 0;
    for (const u of candidates) {
      try {
        process.stdout.write(`[bins] ${t.name} ← ${u} ... `);
        size = await fetchTo(out, u);
        console.log(`ok (${(size / 1048576).toFixed(1)} MB)`);
        break;
      } catch (e) {
        console.log(`failed (${e.message})`);
      }
    }
    if (!size) throw new Error(`all sources failed for ${t.name}`);
  }
  uploads.push({ name: t.name, path: out });
}

if (DRY) {
  console.log("[bins] dry run — nothing published. Would upload:");
  for (const u of uploads) console.log(`  ${u.name}  ${(statSync(u.path).size / 1048576).toFixed(1)} MB`);
  process.exit(0);
}

if (!TOKEN) {
  console.error("[bins] AITI_GITEE_TOKEN env required (gitee personal access token)");
  process.exit(2);
}

const gitee = (path, init = {}) => fetch(`https://gitee.com/api/v5/repos/${GE_REPO}${path}`, init);
const asJson = async (p) => {
  try {
    return await (await p).json();
  } catch {
    return {};
  }
};

// ---- repo (create once; auto_init so a release can target a real branch) ----
const repoProbe = await gitee(`?access_token=${TOKEN}`);
if (repoProbe.status === 404) {
  const [owner, name] = GE_REPO.split("/");
  console.log(`[bins] gitee repo ${GE_REPO} missing — creating (public, auto_init)`);
  const form = new URLSearchParams({
    access_token: TOKEN,
    name,
    path: name,
    description: "Vendored third-party tunnel binaries used by the aiti container build (cloudflared / ttyd / frp)",
    private: "false",
    auto_init: "true",
    has_issues: "false",
    has_wiki: "false",
    has_pull_requests: "false",
  });
  let created = await fetch(`https://gitee.com/api/v5/orgs/${owner}/repos`, { method: "POST", body: form });
  if (!created.ok) created = await fetch("https://gitee.com/api/v5/user/repos", { method: "POST", body: form });
  if (!created.ok) throw new Error(`repo create failed: HTTP ${created.status} ${(await created.text()).slice(0, 200)}`);
} else if (!repoProbe.ok) {
  throw new Error(`repo probe failed: HTTP ${repoProbe.status}`);
}

const repoInfo = await asJson(gitee(`?access_token=${TOKEN}`));
const DEFAULT_BRANCH = repoInfo.default_branch || "master";

// ---- release ----
let rel = await asJson(gitee(`/releases/tags/${TAG}?access_token=${TOKEN}`));
if (!rel?.id) {
  console.log(`[bins] release ${TAG} missing — creating (target_commitish=${DEFAULT_BRANCH})`);
  rel = await asJson(
    gitee(`/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        access_token: TOKEN,
        tag_name: TAG,
        target_commitish: DEFAULT_BRANCH,
        name: "Vendored tunnel binaries",
        body:
          "Third-party tunnel binaries mirrored for the aiti container build (Dockerfile.full ④).\n\n" +
          `cloudflared ${CF_VER} · ttyd ${TTYD_VER} · frp ${FRP_VER}\n\n` +
          "Redistributed unmodified under their upstream licenses (cloudflared Apache-2.0, ttyd MIT, frp Apache-2.0).",
      }),
    }),
  );
  if (!rel?.id) throw new Error(`release create failed: ${JSON.stringify(rel).slice(0, 300)}`);
}

// ---- idempotent replace, then upload ----
const existing = (await asJson(gitee(`/releases/${rel.id}/attach_files?access_token=${TOKEN}`))) || [];
let failed = 0;
for (const a of existing) {
  if (uploads.some((u) => u.name === a.name)) {
    console.log(`[bins] replacing existing attachment: ${a.name}`);
    const dr = await gitee(`/releases/${rel.id}/attach_files/${a.id}?access_token=${TOKEN}`, { method: "DELETE" });
    if (!dr.ok) {
      // A leftover attachment blocks the re-upload, so never swallow this.
      failed++;
      console.error(`  delete ${a.name} failed: HTTP ${dr.status}`);
    }
  }
}

for (const u of uploads) {
  const size = (statSync(u.path).size / 1048576).toFixed(1);
  process.stdout.write(`[bins] upload ${u.name} (${size} MB) ... `);
  const form = new FormData();
  form.append("access_token", TOKEN);
  form.append("file", new Blob([readFileSync(u.path)]), u.name);
  const r = await gitee(`/releases/${rel.id}/attach_files`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (r.ok && j.name === u.name) console.log("ok");
  else {
    failed++;
    console.log(`FAIL: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  }
}

if (failed) {
  console.error(`[bins] FAILED: ${failed} operation(s)`);
  process.exit(1);
}

const base = `https://gitee.com/${GE_REPO}/releases/download/${TAG}`;
console.log(`[bins] done. GITEE_BIN_BASE=${base}`);
console.log(`[bins] docker build --build-arg GITEE_BIN_BASE=${base} ...`);
