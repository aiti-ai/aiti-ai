/**
 * esbuild-bin shared-layer cases — pinning the "derived form resolves per platform"
 * contract.
 *
 * Regression background: esbuild's `bin/esbuild` gets swapped to a native binary by
 * postinstall on Linux/macOS (`node <bin>` blows up), on Windows it is a JS wrapper with
 * a shebang (CreateProcess rejects it; direct exec fails ENOENT), and `.bin/esbuild` on
 * Windows is a /bin/sh shim (spawn always ENOENT). The fix-one-side-break-the-other
 * ping-pong happened twice (this repo ran node directly → the 48-port deployment moved
 * to direct exec 2026-09-19); after converging into this layer, this test guards it.
 *
 * Run: node scripts/test-web-ext.mjs --only _shared
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEsbuildSpawn, runEsbuild } from "./esbuild-bin.ts";

const here = dirname(fileURLToPath(import.meta.url));
const nm = join(here, "..", "aiti-float", "node_modules");
const pkgEntry = join(nm, "esbuild", "bin", "esbuild");
const shimEntry = join(nm, ".bin", "esbuild");
const expectedVersion = existsSync(join(nm, "esbuild", "package.json"))
  ? JSON.parse(readFileSync(join(nm, "esbuild", "package.json"), "utf8")).version
  : null;

const cases = [
  ["package entry esbuild/bin/esbuild", pkgEntry],
  [".bin shim (a sh script on Windows)", shimEntry],
];

// When the official platform package is present, both entries must resolve to it (an
// earlier hardcoded "walk up two levels" never hit the three-level-deep
// esbuild/bin/esbuild, leaving the platform branch dead).
const platformPkg = join(nm, "@esbuild", `${process.platform}-${process.arch}`);
const wantPlatformBin = existsSync(platformPkg);

for (const [label, bin] of cases) {
  if (!existsSync(bin)) continue; // environments without this extension dependency skip cleanly
  test(`esbuild derived binary runs: ${label}`, async () => {
    const { cmd } = resolveEsbuildSpawn(bin);
    assert.ok(existsSync(cmd), `the resolved cmd must actually exist: ${cmd}`);
    if (wantPlatformBin) {
      assert.ok(cmd.startsWith(platformPkg), `with the platform package present it must be used; got ${cmd}`);
    }
    // The spawned body must not be a "shell-required" script (Windows CreateProcess
    // would ENOENT): either a native binary, or go through node (non-empty prefix).
    if (process.platform === "win32") {
      const head = readFileSync(cmd).subarray(0, 2).toString("utf8");
      assert.notEqual(head, "#!", `on win32 a directly exec'd target must not be a shebang text file: ${cmd}`);
    }
    const out = await runEsbuild(bin, ["--version"]);
    assert.equal(out.trim(), expectedVersion, "both entry forms must resolve to the same esbuild");
  });
}
