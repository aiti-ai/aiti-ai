/**
 * copy-client-bundle — deployment helper for extension client build output (including code chunks).
 *
 * Background (docs/aiti-ext-lazy-loading-plan.md pitfall ④; same root as backend-queue G1):
 * most extension deploy scripts copy the single-entry manifest "client/<ext>-client.mjs" — once the
 * bundle produces code chunks (vite dynamic import() / React.lazy -> separate hash chunks), those
 * chunk files are not copied and the runtime import() 404s (silent, only visible in the console).
 *
 * Usage (replaces the single-file copyFileSync inside deploy.mjs):
 *   import { copyClientBuild } from "@aiti-ai/ext-shared/copy-client-bundle";
 *   copyClientBuild(root, extDir, "aiti-xxx-client.mjs");
 *
 * Behavior:
 *  1. Copies the main bundle (<main>.mjs) + every .mjs/.js build artifact under client/ (src/ is not copied);
 *  2. Cleans .js files in the target directory that no longer exist in the source (prevents stale hash chunks accumulating);
 *  3. Idempotent, safe to call repeatedly.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export function copyClientBuild(root, extDir, mainBundle) {
  const srcClient = resolve(root, "client");
  const dstClient = resolve(extDir, "client");
  if (!existsSync(srcClient)) return;
  mkdirSync(dstClient, { recursive: true });
  const srcFiles = readdirSync(srcClient).filter((f) => f.endsWith(".mjs") || f.endsWith(".js"));
  const main = resolve(srcClient, mainBundle);
  if (existsSync(main)) copyFileSync(main, resolve(dstClient, mainBundle));
  for (const f of srcFiles) {
    if (f === mainBundle) continue;
    copyFileSync(resolve(srcClient, f), resolve(dstClient, f));
  }
  // Clean stale chunks in the target directory (the source no longer carries the old hash names)
  for (const f of readdirSync(dstClient)) {
    if (f.endsWith(".js") && !srcFiles.includes(f)) {
      try { unlinkSync(resolve(dstClient, f)); } catch { /* noop */ }
    }
  }
}
