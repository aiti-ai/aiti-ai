// basePath navigation guard — pins down the 2026-09-06 "/dev navigating to
// /dev/dev" merge incident (upstream #630 regression).
//
// Background: Next's router.replace/push **prepend basePath again on their
// own**. Upstream #630 changed `router.replace("/")` to
// `router.replace(window.location.pathname)` (fixing their reverse-proxy
// prefix topology), but in deployments where basePath is baked into the
// build (e.g. a dev instance with PI_WEB_BASE_PATH=/dev), the pathname
// already contains `/dev`, so replace produces `/dev/dev/`.
// The correct approach: `inAppPathname()` (lib/base-path.ts) strips basePath
// before handing the path back to the router; for root deployments it passes
// through unchanged = upstream behavior preserved.
//
// This guard pins three things:
//   1) router.replace/push must never consume window.location.* directly
//      anywhere in the repo (must go through inAppPathname)
//   2) the NEXT_PUBLIC_BASE_PATH injection wiring in next.config.ts must not
//      be dropped (without it, getBasePath() stays empty → inAppPathname
//      stops stripping → the doubled prefix silently returns)
//   3) skipTrailingSlashRedirect: true must not be dropped (without it, the
//      /dev → /dev/ canonical redirect becomes a Next built-in 308 loop; see
//      the next.config comments)
//
// Maintenance rule: when a feature is intentionally refactored, update this
// file in the same commit and note the guard in the commit message; never
// change the test to accommodate the implementation.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listSources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

test("[basepath-guard] router.replace/push must not consume window.location directly (must go through inAppPathname)", () => {
  const offenders = [];
  for (const dir of ["components", "hooks", "lib", "app"]) {
    for (const file of listSources(path.join(ROOT, dir))) {
      const src = fs.readFileSync(file, "utf8");
      const re = /router\.(?:replace|push)\s*\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const window_ = src.slice(m.index, m.index + 240);
        const loc = window_.search(/window\.location\.(pathname|href)|(?<![.\w])location\.(pathname|href)/);
        if (loc === -1) continue;
        // Skip comment lines (this very guard's comments contain the counter-example)
        const absOffset = m.index + loc;
        const lineStart = src.lastIndexOf("\n", absOffset) + 1;
        const lineHead = src.slice(lineStart, absOffset).trimStart();
        if (lineHead.startsWith("//") || lineHead.startsWith("*") || lineHead.startsWith("/*")) continue;
        const line = src.slice(0, absOffset).split("\n").length;
        offenders.push(`${path.relative(ROOT, file)}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], [
    "router.replace/push consuming window.location.pathname/href directly re-prepends the basePath prefix under basePath deployments",
    "(/dev → /dev/dev, see the upstream #630 regression). Use inAppPathname() from lib/base-path.ts instead.",
    "Offending locations:",
    ...offenders,
  ].join("\n"));
});

test("[basepath-guard] the NEXT_PUBLIC_BASE_PATH injection wiring in next.config.ts must not be dropped", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  assert.match(cfg, /NEXT_PUBLIC_BASE_PATH:\s*basePath/, [
    "next.config env lost the NEXT_PUBLIC_BASE_PATH injection → getBasePath() in lib/base-path.ts",
    "stays empty → inAppPathname() stops stripping basePath → the doubled router prefix silently returns (/dev/dev).",
  ].join("\n"));
});

test("[basepath-guard] skipTrailingSlashRedirect: true must not be dropped (prevents the /dev canonical redirect loop)", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
  assert.match(cfg, /skipTrailingSlashRedirect:\s*true/, [
    "Next's built-in trailing-slash 308 also applies to the basePath root and runs before middleware,",
    "turning the /dev → /dev/ canonical redirect into an infinite loop (see the next.config.ts comments).",
  ].join("\n"));
});

test("[basepath-guard] lib/base-path.ts must export inAppPathname", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "base-path.ts"), "utf8");
  assert.match(src, /export function inAppPathname/);
});
