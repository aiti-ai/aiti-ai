#!/usr/bin/env node
/**
 * aiti-feedback · deploy to ~/.pi/web/extensions/ and ~/.pi/web-dev/extensions/
 *
 * 0) build the JSX client bundle (client/src → dist/aiti-feedback-client.mjs)
 * 1) copy server files (index.ts / package.json / icon.svg) to both instances
 * 2) copy the client bundle to dist/
 * 3) icons from _shared/icons (message-circle)
 * 4) deploy commit + dual-instance hot reload (env ports per machine)
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { deployCommit } from "../../_shared/deploy-commit.mjs";
import { copyIcons } from "../../_shared/ext-icons-deploy.mjs";

// client TS residue check (.mjs hides bad TS syntax from syntax checks; it explodes at runtime)
{
  const { checkClientDir } = await import("../../_shared/check-client.mjs");
  checkClientDir(fileURLToPath(new URL("../client", import.meta.url)), { log: (m) => console.log("[deploy] " + m) });
}

const root = resolve(import.meta.dirname, "..");
const targets = [
  resolve(homedir(), ".pi", "web", "extensions", "aiti-feedback"),
  resolve(homedir(), ".pi", "web-dev", "extensions", "aiti-feedback"),
];
const extRepo = resolve(homedir(), ".pi", "web", "extensions");

console.log("[deploy] build JSX client bundle…");
try {
  execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[deploy] build failed, abort:", e.message);
  process.exit(1);
}

for (const extDir of targets) {
  mkdirSync(extDir, { recursive: true });
  for (const f of ["package.json", "index.ts", "icon.svg"]) {
    copyFileSync(resolve(root, f), resolve(extDir, f));
    console.log("[deploy] src → " + resolve(extDir, f));
  }
  const clientDir = resolve(extDir, "dist");
  mkdirSync(clientDir, { recursive: true });
  copyFileSync(resolve(root, "dist/aiti-feedback-client.mjs"), resolve(clientDir, "aiti-feedback-client.mjs"));
  console.log("[deploy] client → " + resolve(clientDir, "aiti-feedback-client.mjs"));
}

for (const t of targets) copyIcons(resolve(t, "icons"), ["discussion"], { log: (m) => console.log(m) });

deployCommit({ repo: extRepo, name: "aiti-feedback", paths: ["aiti-feedback"], ident: true, log: (m) => console.log("[deploy] " + m) });

console.log("[deploy] done. Reload via POST /api/extensions/reload; client refreshes on page reload");

try {
  const { reloadInstances } = await import("../../_shared/reload-instances.mjs");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] auto reload skipped (" + String((e && e.message) || e) + ")");
}
