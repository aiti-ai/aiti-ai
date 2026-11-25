#!/usr/bin/env node
/**
 * Install this package as a bundled pi plugin into <agentDir>/pi-plugins/pi-git-trace/,
 * where pi-web's lib/pi-plugins.ts scans it and loads it per session via the SDK's
 * native additionalExtensionPaths. The copy source is this repo's src/ (the build
 * artifact IS the TS source, loaded directly through jiti).
 *
 * Usage: node tools/install-plugin.mjs [agentDir]   (defaults to ~/.pi/agent)
 */
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const agentDir = process.argv[2] || path.join(homedir(), ".pi", "agent");
const srcDir = path.resolve(import.meta.dirname, "..", "src");
const dst = path.join(agentDir, "pi-plugins", "pi-git-trace");
mkdirSync(dst, { recursive: true });
cpSync(srcDir, dst, { recursive: true });
const version = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8")).version;
console.log(`[pi-git-trace] bundled plugin installed -> ${dst} (v${version})`);
