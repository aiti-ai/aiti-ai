#!/usr/bin/env node
/**
 * Install this package as a bundled pi plugin into <agentDir>/pi-plugins/pi-secret-vault/,
 * where pi-web's lib/pi-plugins.ts scans it and loads it per session via the SDK's
 * native additionalExtensionPaths. The copy source is this repo's src/ (the build
 * artifact IS the TS source, loaded directly through jiti).
 *
 * Self-contained: the @aiti-ai/secret-mask-core and @aiti-ai/secret-vault-core builds
 * from packages/ are shipped into the copy's own node_modules/, mirroring what an npm
 * install of the published package provides (the bare src copy alone would not resolve
 * the cores at load).
 *
 * The vault is the encrypted persistent superset of pi-secret-mask; the same-session
 * handshake makes mask yield when both are present.
 *
 * Usage: node tools/install-plugin.mjs [agentDir]   (defaults to ~/.pi/agent)
 */
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const agentDir = process.argv[2] || path.join(homedir(), ".pi", "agent");
const pkgDir = path.resolve(import.meta.dirname, "..");
const srcDir = path.join(pkgDir, "src");
const dst = path.join(agentDir, "pi-plugins", "pi-secret-vault");
mkdirSync(dst, { recursive: true });
cpSync(srcDir, dst, { recursive: true });

// Bundle the repo-built cores into the copy's node_modules (fresh each install).
const cores = [
  ["@aiti-ai/secret-mask-core", "secret-mask-core"],
  ["@aiti-ai/secret-vault-core", "secret-vault-core"],
];
for (const [coreName, dirName] of cores) {
  const coreSrc = path.resolve(pkgDir, "..", "..", "packages", dirName);
  const coreDst = path.join(dst, "node_modules", coreName);
  rmSync(coreDst, { recursive: true, force: true });
  mkdirSync(path.dirname(coreDst), { recursive: true });
  cpSync(path.join(coreSrc, "package.json"), path.join(coreDst, "package.json"));
  cpSync(path.join(coreSrc, "dist"), path.join(coreDst, "dist"), { recursive: true });
}

const version = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
console.log(`[pi-secret-vault] bundled plugin installed -> ${dst} (v${version}, + ${cores.map(([n]) => n).join(", ")})`);
