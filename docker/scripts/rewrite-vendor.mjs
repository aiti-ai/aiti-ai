// Rewrites dependency references inside staging to in-container file: paths (the transition until @aiti-ai/* is on the official registry):
// 1) vendor tgz re-pack: NAMES references in its own deps become file:/opt/vendor/<flat>.tgz (closing the transitive chain)
// 2) NAMES → file: in the deps/devDeps of the staged {extensions,pi-plugins,packages}/*/package.json files
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const STAGE = process.argv[2];
const NAMES = [
  "@aiti-ai/ext-shared", "@aiti-ai/aiti-bridge", "@aiti-ai/aiti-devtools-core",
  "justget", "service-tunnels", "@aiti-ti/ddns",
];
const VENDOR_SRC = join(STAGE, "vendor", "npm");
const VENDOR_OUT = join(STAGE, "vendor", "rewritten");

const flatName = (pkgName, ver) =>
  `${pkgName.replace(/^@/, "").replace("/", "-")}-${ver}.tgz`;

// 1) rewrite the vendor tgz's transitive deps
mkdirSync(VENDOR_OUT, { recursive: true });
const map = {}; // pkgName → in-container file: value
for (const t of readdirSync(VENDOR_SRC).filter((f) => f.endsWith(".tgz"))) {
  const work = join(VENDOR_OUT, "w-" + t.replace(/\.tgz$/, ""));
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execSync(`tar xzf ${JSON.stringify(join(VENDOR_SRC, t))} -C ${JSON.stringify(work)}`, { shell: true });
  const pj = join(work, "package", "package.json");
  const p = JSON.parse(readFileSync(pj, "utf8"));
  for (const sec of [p.dependencies, p.devDependencies]) {
    for (const n of NAMES) if (sec && sec[n]) sec[n] = `file:/opt/vendor/placeholder-${n}`;
  }
  writeFileSync(pj, JSON.stringify(p, null, 2) + "\n");
  const out = join(VENDOR_OUT, t);
  execSync(`cd ${JSON.stringify(work)} && npm pack --ignore-scripts --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null 2>&1 || npm pack --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null`, { shell: true });
  // The npm pack output name is name+version — build the name mapping (deps reference a unified file:/opt/vendor/<actual filename>)
  const p2 = JSON.parse(readFileSync(pj, "utf8"));
  map[p2.name] = `file:/opt/vendor/${flatName(p2.name, p2.version)}`;
}
// Second pass: fix the first pass's placeholder references with real filenames + verify the tgz landed
for (const t of readdirSync(VENDOR_OUT).filter((f) => f.endsWith(".tgz"))) {
  const work = join(VENDOR_OUT, "w-" + t.replace(/\.tgz$/, ""));
  const pj = join(work, "package", "package.json");
  const p = JSON.parse(readFileSync(pj, "utf8"));
  let ch = false;
  for (const sec of [p.dependencies, p.devDependencies]) {
    if (!sec) continue;
    for (const n of NAMES) if (sec[n] && map[n]) { sec[n] = map[n]; ch = true; }
  }
  if (ch) {
    writeFileSync(pj, JSON.stringify(p, null, 2) + "\n");
    execSync(`cd ${JSON.stringify(work)} && npm pack --ignore-scripts --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null 2>&1 || npm pack --pack-destination ${JSON.stringify(VENDOR_OUT)} > /dev/null`, { shell: true });
  }
}
console.log("[vendor-rewrite] tgz transitive chain rewritten:", Object.keys(map).join(", "));

// 2) batch-rewrite the staged package.json files (NAMES → in-container file: in deps/devDeps)
let n = 0;
const rewrite = (dir) => {
  for (const d of readdirSync(dir)) {
    const pj = join(dir, d, "package.json");
    if (!existsSync(pj)) continue;
    const p = JSON.parse(readFileSync(pj, "utf8"));
    let ch = false;
    for (const sec of [p.dependencies, p.devDependencies]) {
      if (!sec) continue;
      for (const nm of NAMES) if (sec[nm] && map[nm]) { sec[nm] = map[nm]; ch = true; }
    }
    if (ch) { writeFileSync(pj, JSON.stringify(p, null, 2) + "\n"); n++; }
  }
};
for (const sub of (process.argv[3] || "extensions pi-plugins packages").split(" ")) {
  const dir = join(STAGE, sub);
  if (existsSync(dir)) rewrite(dir);
}
console.log(`[vendor-rewrite] rewrote ${n} staged package.json files`);
