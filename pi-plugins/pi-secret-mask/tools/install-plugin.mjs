#!/usr/bin/env node
/**
 * Install this package as a bundled pi plugin into <agentDir>/pi-plugins/pi-secret-mask/,
 * where pi-web's lib/pi-plugins.ts scans it and loads it per session via the SDK's
 * native additionalExtensionPaths. The copy source is this repo's src/ (the build
 * artifact IS the TS source, loaded directly through jiti).
 *
 * Self-contained: the @aiti-ai/secret-mask-core build from packages/ is shipped into
 * the copy's own node_modules/, mirroring what an npm install of the published
 * package provides (the bare src copy alone would not resolve the core at load).
 *
 * Supersedes a settings.json `packages` npm registration for the same plugin — keep
 * exactly one channel so the extension is not loaded twice.
 *
 * Usage: node tools/install-plugin.mjs [agentDir]   (defaults to ~/.pi/agent)
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const agentDir = process.argv[2] || path.join(homedir(), ".pi", "agent");
const pkgDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(pkgDir, "src");
const dst = path.join(agentDir, "pi-plugins", "pi-secret-mask");
mkdirSync(dst, { recursive: true });
cpSync(srcDir, dst, { recursive: true });

// Bundle the repo-built core into the copy's node_modules (fresh each install).
const coreName = "@aiti-ai/secret-mask-core";
const coreSrc = path.resolve(pkgDir, "..", "..", "packages", "secret-mask-core");
const coreDst = path.join(dst, "node_modules", coreName);
rmSync(coreDst, { recursive: true, force: true });
mkdirSync(path.dirname(coreDst), { recursive: true });
cpSync(path.join(coreSrc, "package.json"), path.join(coreDst, "package.json"));
cpSync(path.join(coreSrc, "dist"), path.join(coreDst, "dist"), { recursive: true });

const version = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
console.log(`[pi-secret-mask] bundled plugin installed -> ${dst} (v${version}, + ${coreName})`);
