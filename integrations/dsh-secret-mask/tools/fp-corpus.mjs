#!/usr/bin/env node
// False-positive measurement for pi-secret-mask detection rules against pinned
// public repositories (same corpus as claude-code-redact's fp-corpus: 11 repos,
// ~42k files, lockfiles / go.sum / Terraform / minified JS / JWT & PEM test
// vectors / dotenv fixtures). Shallow-fetches each pinned commit into
// /tmp/pi-secret-mask-fp-corpus/ (reused when present), scans every text file
// under 2 MB, prints a summary and writes tools/fp-corpus-results.md.
// Hit values are masked in all output; always exits 0.
//
// Judgement standard (aligned with claude-code-redact): complete private keys,
// signed JWTs and sample DB credentials published as test vectors ARE secrets
// and SHOULD be redacted — they are "real-shaped hits", not false positives.

import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { availableParallelism } from "node:os";

const CORPUS = [
  { repo: "changesets/changesets", sha: "c73949ba7b3160a4aa5729223335c190de1528f8", why: "JS monorepo, yarn.lock" },
  { repo: "psf/requests", sha: "611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60", why: "Python, requirements, test fixtures" },
  { repo: "spf13/cobra", sha: "adbc8813901bba65827259daa8e22ff94ec1f30e", why: "Go, go.sum" },
  { repo: "GoogleCloudPlatform/microservices-demo", sha: "38e7348eb289eb5b87c0c6e8cb19ced0449dc389", why: "Kubernetes manifests, Helm, Terraform" },
  { repo: "docker/awesome-compose", sha: "30f4b7f6a6c3b0c0ecf4d4efb0de203c48d11562", why: "docker-compose files with sample DB credentials" },
  { repo: "tldr-pages/tldr", sha: "0653c297d0a88eb694e7b41fa72bd10bed7713db", why: "docs-heavy Markdown, many languages" },
  { repo: "twbs/bootstrap", sha: "c1f9b9db4dd14d5353e34462ec589cdf8c7270d3", why: "SVG data URIs in SCSS, minified dist" },
  { repo: "highlightjs/cdn-release", sha: "47245af257d8d54d3f5181df0c0ec7e0113af3ec", why: "minified JS heavy" },
  { repo: "auth0/node-jsonwebtoken", sha: "b924272f29192e12926b5414546f7c5bfcc9579d", why: "sample JWTs, PEM test keys" },
  { repo: "panva/jose", sha: "2a3a5259683f21b8ae42181a33cdc812330104be", why: "JOSE test vectors, JWKs, UUIDs" },
  { repo: "motdotla/dotenv", sha: "05215e09b73575b6f8e272658ca7849685651384", why: ".env docs and examples" },
];

const CACHE = "/tmp/pi-secret-mask-fp-corpus";
const MAX_BYTES = 2 * 1024 * 1024;
const EXCERPT_LEN = 40;
const RESULTS = new URL("./fp-corpus-results.md", import.meta.url).pathname;
const BIN_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".so", ".dylib", ".dll", ".exe", ".bin"]);

if (!isMainThread) {
  const { scan } = await import(pathToFileUrl(workerData.src));
  parentPort.on("message", ({ text }) => {
    const describe = (h) => {
      let line = 1;
      for (let i = text.indexOf("\n"); i !== -1 && i < h.start; i = text.indexOf("\n", i + 1)) line++;
      const lineStart = text.lastIndexOf("\n", h.start - 1) + 1;
      const masked = h.value.slice(0, 4) + "*".repeat(Math.min(Math.max(h.value.length - 4, 0), 16));
      const before = text.slice(Math.max(lineStart, h.start - (EXCERPT_LEN - masked.length)), h.start);
      const excerpt = (before + masked).replace(/[\r\n\t]/g, " ").slice(0, EXCERPT_LEN);
      return { id: h.id, line, len: h.value.length, excerpt };
    };
    let secret = [], err = null;
    const t0 = performance.now();
    try { secret = scan(text).map(describe); } catch (e) { err = String(e); }
    parentPort.postMessage({ secret, err, ms: performance.now() - t0 });
  });
}

function pathToFileUrl(p) {
  return "file://" + (p.startsWith("/") ? p : process.cwd() + "/" + p);
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

function checkout({ repo, sha }) {
  const dir = path.join(CACHE, `${repo.replace("/", "__")}@${sha.slice(0, 12)}`);
  const marker = path.join(dir, ".fp-corpus-ok");
  if (fs.existsSync(marker)) return { dir, fetched: false };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "fetch", "-q", "--depth", "1", `https://github.com/${repo}.git`, sha);
  git(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD");
  fs.writeFileSync(marker, sha + "\n");
  return { dir, fetched: true };
}

function* walk(dir, base = dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (ent.name === ".git") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(full, base);
    else if (ent.isFile()) yield path.relative(base, full);
  }
}

function readText(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_BYTES || st.size === 0) return null;
  const ext = path.extname(file).toLowerCase();
  if (BIN_EXT.has(ext)) return null;
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return null; // binary
  return buf.toString("utf8");
}

class Pool {
  constructor(size, src) {
    this.slots = [];
    this.src = src;
    this.size = size;
  }
  spawn() {
    const w = new Worker(new URL(import.meta.url), { workerData: { src: this.src } });
    w.unref();
    return w;
  }
  run(text) {
    return new Promise((resolve, reject) => {
      const slot = this.slots.pop() ?? { worker: this.spawn() };
      const onMsg = (m) => { cleanup(); resolve(m); };
      const onErr = (e) => { cleanup(); reject(e); };
      const cleanup = () => {
        slot.worker.off("message", onMsg);
        slot.worker.off("error", onErr);
        this.slots.push(slot);
      };
      slot.worker.on("message", onMsg);
      slot.worker.on("error", onErr);
      slot.worker.postMessage({ text });
    });
  }
}

async function main() {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = here0() ? path.join(here0(), "..", "src", "core", "detect.ts") : path.resolve("src/core/detect.ts");
  const only = process.argv.slice(2); // optional repo name substrings
  const repos = only.length ? CORPUS.filter((c) => only.some((o) => c.repo.includes(o))) : CORPUS;

  fs.mkdirSync(CACHE, { recursive: true });
  const hits = [];
  let files = 0, scanned = 0;
  const t0 = Date.now();
  for (const entry of repos) {
    const { dir, fetched } = checkout(entry);
    console.log(`${fetched ? "fetched" : "cached "} ${entry.repo} (${entry.why})`);
    for (const rel of walk(dir)) {
      files++;
      const text = readText(path.join(dir, rel));
      if (text === null) continue;
      scanned++;
      const res = await globalThis.__pool.run(text);
      if (res.err) console.error(`  scan error ${rel}: ${res.err}`);
      for (const h of res.secret) hits.push({ repo: entry.repo, file: rel, ...h });
    }
  }
  const byId = {};
  for (const h of hits) byId[h.id] = (byId[h.id] ?? 0) + 1;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nscanned ${scanned} of ${files} files in ${secs}s`);
  console.log(`secret-rule hits: ${hits.length}`);
  for (const [id, n] of Object.entries(byId).sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(24)} ${n}`);

  const lines = [
    "# fp-corpus results",
    "",
    `- corpus: ${repos.map((r) => r.repo).join(", ")}`,
    `- files: ${scanned}/${files} scanned (<2MB text, binary skipped) in ${secs}s`,
    `- secret-rule hits: ${hits.length}`,
    "",
    "Judgement: complete private keys / signed JWTs / sample DB credentials published as test vectors are real-shaped hits (should be redacted), not false positives.",
    "",
    "| repo | file | id | line | len | excerpt |",
    "|---|---|---|---|---|---|",
    ...hits.map((h) => `| ${h.repo} | ${h.file} | ${h.id} | ${h.line} | ${h.len} | \`${h.excerpt}\` |`),
    "",
  ];
  fs.writeFileSync(RESULTS, lines.join("\n"));
  console.log(`wrote ${RESULTS}`);
}

function here0() {
  return path.dirname(new URL(import.meta.url).pathname);
}

if (isMainThread) {
  const pool = new Pool(Math.max(2, Math.min(8, availableParallelism())), path.join(here0(), "..", "src", "core", "detect.ts"));
  // expose the pool to main() without a mutable module binding race
  globalThis.__pool = pool;
  main().catch((e) => { console.error(e); process.exit(1); });
}
