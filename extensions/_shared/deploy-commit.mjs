/**
 * Shared "deploy-state commit" helper for deploy scripts (used uniformly by the pi-web-ext tools/deploy.mjs files).
 *
 * Background (2026-08-30 debugging, session 0cc6ad47 op264): redeploying identical content made
 * `git add -A && git commit` exit 1 with "nothing to commit", while stdio:"ignore" swallowed stderr,
 * producing the false alarm "commit failed (ignored): Command failed: …" (confirmed on msg-smart);
 * the --allow-empty family meanwhile created empty-commit noise on every deploy. This helper unifies
 * three-state semantics:
 *   committed → staged changes existed, committed
 *   clean     → no changes, skipped (not a failure)
 *   failed    → git genuinely failed (first stderr line attached; deploy not blocked — the deploy itself always wins)
 *
 * Usage:
 *   import { deployCommit } from "@aiti-ai/ext-shared/deploy-commit";
 *   deployCommit({ repo: extRepo, name: "aiti-msg-smart", paths: ["aiti-msg-smart"],
 *                  log: (m) => console.log("[deploy] " + m) });
 *
 * Red lines: this helper never throws and never touches anything outside the deploy output paths;
 * it only add/diff/commits <repo> (default --no-verify; extRepo has no hooks, guarding against future mis-hooks).
 */
import { execFileSync } from "node:child_process";

export function deployCommit({ repo, name, paths = null, extraMsg = "", ident = false, log = console.log }) {
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const firstLine = (s) => String(s || "").trim().split("\n")[0];
  try {
    // Stage: by default only this extension's subdirs (aligns with add <ext>; avoids dragging
    // other extensions' uncommitted changes into this extension's deploy commit); paths=null falls back to repo-wide add -A.
    git(["add", ...(paths && paths.length ? ["--", ...paths] : ["-A"])]);
    let dirty;
    try {
      git(["diff", "--cached", "--quiet"]);
      dirty = false; // exit 0 = index identical to HEAD
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = changes exist; anything else is a real error
      dirty = true;
    }
    if (!dirty) {
      log("extension repo unchanged (commit skipped)");
      return { status: "clean" };
    }
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const msg = `[deploy] ${name} · ${stamp}${extraMsg ? " · " + extraMsg : ""}`;
    git([...(ident ? ["-c", "user.name=deploy", "-c", "user.email=deploy@local"] : []), "commit", "--no-verify", "-m", msg]);
    log("extension repo committed: " + msg);
    return { status: "committed", msg };
  } catch (e) {
    const reason = firstLine(e.stderr) || firstLine(e.message) || "git error";
    log("commit failed (ignored, deploy unaffected): " + reason);
    return { status: "failed", reason };
  }
}
