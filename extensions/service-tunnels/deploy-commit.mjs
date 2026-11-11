/**
 * deploy 脚本共享「部署状态 commit」助手（pi-web-ext 各扩展 tools/deploy.mjs 统一用）。
 *
 * 背景（2026-08-30 排障，session 0cc6ad47 op264）：重复部署同内容时
 * `git add -A && git commit` 以 "nothing to commit" exit 1，而 stdio:"ignore" 吞掉
 * stderr，输出「提交失败（忽略）：Command failed: …」假报警（msg-smart 实证）；
 * 另有 --allow-empty 族每次部署都造空 commit 噪音。本助手统一三态语义：
 *   committed → 有暂存变更，已提交
 *   clean     → 无变更，跳过（不算失败）
 *   failed    → git 真失败（带 stderr 首行，不阻断部署——部署本体永远优先）
 *
 * 用法：
 *   import { deployCommit } from "../../_shared/deploy-commit.mjs";
 *   deployCommit({ repo: extRepo, name: "aiti-msg-smart", paths: ["aiti-msg-smart"],
 *                  log: (m) => console.log("[deploy] " + m) });
 *
 * 红线：本助手永不 throw、不触碰部署产物路径之外的任何东西；只对 <repo> 做
 * add/diff/commit（默认 --no-verify，extRepo 无 hooks，防未来误挂）。
 */
import { execFileSync } from "node:child_process";

export function deployCommit({ repo, name, paths = null, extraMsg = "", ident = false, log = console.log }) {
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const firstLine = (s) => String(s || "").trim().split("\n")[0];
  try {
    // 暂存：默认只收本扩展子目录（与 add <ext> 行为对齐；避免把别的扩展的
    // 未提交改动卷进本扩展的部署 commit）；paths=null 时退回 add -A 全仓。
    git(["add", ...(paths && paths.length ? ["--", ...paths] : ["-A"])]);
    let dirty;
    try {
      git(["diff", "--cached", "--quiet"]);
      dirty = false; // exit 0 = 暂存区与 HEAD 一致
    } catch (e) {
      if (e.status !== 1) throw e; // 1 = 有变更；其他才是真错误
      dirty = true;
    }
    if (!dirty) {
      log("扩展仓库无变化（跳过提交）");
      return { status: "clean" };
    }
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const msg = `[deploy] ${name} · ${stamp}${extraMsg ? " · " + extraMsg : ""}`;
    git([...(ident ? ["-c", "user.name=deploy", "-c", "user.email=deploy@local"] : []), "commit", "--no-verify", "-m", msg]);
    log("扩展仓库已提交：" + msg);
    return { status: "committed", msg };
  } catch (e) {
    const reason = firstLine(e.stderr) || firstLine(e.message) || "git error";
    log("提交失败（忽略，不影响部署）：" + reason);
    return { status: "failed", reason };
  }
}
