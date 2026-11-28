#!/usr/bin/env node
/** Deploy aiti-zcode-agent to ~/.pi/web{,-dev}/extensions/ (both by default; --prod prod-only, --dev dev-only; the file set must match the deploy tree). */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { notifyReconcile } from "@aiti-ai/ext-shared/reconcile-deps";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Targets: both web + web-dev by default; --prod prod-only, --dev dev-only (legacy one-sided usage kept working)
const prod = process.argv.includes("--prod");
const devOnly = process.argv.includes("--dev");
const home = process.env.HOME || process.env.USERPROFILE;
const bases = [
  ...(prod ? [] : [join(home, ".pi", process.env.PI_WEB_DEV_DIR ? `web-${process.env.PI_WEB_DEV_DIR}` : "web-dev", "extensions")]),
  ...(devOnly ? [] : [join(home, ".pi", "web", "extensions")]),
];
// client bundle (sessionRequestCard provider_headers verification card; a build failure does not
// block the server-side deploy — when the card is absent the host core fallback card takes over)
{
  try {
    execSync("node tools/build-client.mjs", { cwd: root, stdio: "inherit" });
  } catch (e) {
    console.error("[deploy] client bundle 构建失败（server 侧照常部署）:", e.message);
  }
}

for (const base of bases) {
  const dest = join(base, "aiti-zcode-agent");
  mkdirSync(dest, { recursive: true });
  for (const f of ["index.ts","zcode-core.ts","zcode-appserver.ts","package.json","external-governance.ts"]) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(dest, f));
  }
  {
    const bundle = join(root, "dist", "aiti-zcode-cards.mjs");
    if (existsSync(bundle)) {
      mkdirSync(join(dest, "dist"), { recursive: true });
      cpSync(bundle, join(dest, "dist", "aiti-zcode-cards.mjs"));
    }
  }
  // Login UI has been unified into aiti-agent-manager (2026-09-13): the managed-login client and
  // dialog are no longer deployed (server /login/* and the .agent descriptor remain, consumed via the manager proxy).
  console.log(`[deploy] aiti-zcode-agent → ${dest}`);
}

// ── shared-deps reconcile notification (deps go into <webRoot>/node_modules; failure-tolerant, never throws) ──
await notifyReconcile();

// ── dual-instance hot reload (basePath dual env, set per machine) — failure-tolerant: service down / missing shared module only logs, deploy exit code unaffected ──
try {
  const { reloadInstances } = await import("@aiti-ai/ext-shared/reload-instances");
  await reloadInstances();
} catch (e) {
  console.log("[deploy] 自动 reload 未执行（" + String((e && e.message) || e) + "）— 需手动 POST /api/extensions/reload");
}

// ── dev-pack (plan §3.2: sources + build tools + AGENTS.md delivered to the deploy dir so the AI can edit on-site) — failure-tolerant, deploy exit code unaffected ──
try {
  const { packDevPack } = await import("@aiti-ai/ext-shared/dev-pack");
  packDevPack({ extRoot: resolve(import.meta.dirname, ".."), log: (m) => console.log("[deploy] " + m) });
} catch (e) {
  console.log("[deploy] dev-pack 未执行（" + String((e && e.message) || e) + "）");
}
