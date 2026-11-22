#!/usr/bin/env node
/**
 * CI helper: copy the built binary to a release asset name, normalize the mode.
 * Works on every runner shell (PowerShell included) because the workflow passes
 * literal paths; no bash-only commands are needed for staging.
 *
 *   node scripts/stage-binary.mjs --src <built> --dest dist/<asset>
 */
import { chmodSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const src = opt("--src");
const dest = opt("--dest");
if (!src || !dest) {
  console.error("usage: stage-binary.mjs --src <built> --dest <asset>");
  process.exit(1);
}
const source = resolve(src);
const target = resolve(dest);
const info = statSync(source);
if (!info.isFile() || info.size === 0) {
  console.error(`stage-binary: ${source} is missing or empty`);
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
if (process.platform !== "win32") chmodSync(target, 0o755);
console.log(`stage-binary: ${target} (${info.size} bytes)`);
