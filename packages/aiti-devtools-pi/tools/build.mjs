#!/usr/bin/env node
/**
 * Build the aiti-devtools-pi.js single-file bundle (pi extension):
 *   entry src/index.ts; inlines aiti-devtools-core/aiti-devtools-agent (packages/ in this repo)
 *   external: @earendil-works/pi-coding-agent (pi SDK) + typebox (provided by the host)
 *
 * Usage: node tools/build.mjs [outfile]
 * Output: dist/aiti-devtools-pi.js (standalone pi: point settings.json extensions/packages at it,
 *         or publish as a pi package)
 * Note: the pi extension does not inline launcher/cockpit assets (served by the standalone
 *       bridge), so it has no dependency on launcher build artifacts.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const _req = createRequire(import.meta.url);
// esbuild 由仓库根 node_modules 提供（npm i -D esbuild）；包 npm 化后各包自带 esbuild。
function loadEsbuild() {
  try { return _req("esbuild"); } catch {}
  console.error("[build-pi] esbuild not found — run `npm i -D esbuild` at the repo root first");
  process.exit(1);
}
const esbuild = loadEsbuild();
const outfile = process.argv[2] ? resolve(process.argv[2]) : resolve(root, "dist/aiti-devtools-pi.js");

await esbuild.build({
  entryPoints: [resolve(root, "src/index.ts")],
  bundle: true,
  format: "esm",
  outfile,
  charset: "utf8",
  platform: "node",
  target: "node20",
  logLevel: "info",
  banner: { js: "/* aiti-devtools-pi · pi extension (embedded bridge + direct tool access) · generated bundle, do not edit */" },
  external: ["@earendil-works/pi-coding-agent", "typebox"],
});
console.log("[build-pi] → " + outfile);
console.log('[build-pi] standalone pi install: settings.json → "extensions": ["' + outfile + '"] or publish as a pi package');
