/**
 * loose 模式（§13.4）：无 git 目录在预算内自动建 `.aiti-trace`（简易追踪）。
 *
 * 触发条件（engine.init 决策链，全部满足才建）：
 *   resolveRepoRoot(cwd)=null → autoInit 开 → 不在 denylist → 预算扫描未超限。
 * 任何一步不满足/失败 → 放弃建仓并置 noStoreReason（绝不影响会话，引擎总红线）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 系统目录：$HOME 与 "/" 精确匹配；其余前缀匹配（防误建在最惊扰的位置） */
const DENY_EXACT = new Set(["/", "/tmp", "/proc", "/sys", "/dev", "/run", "/etc", "/var", "/boot", "/usr", "/lib", "/opt", "/snap"]);
const DENY_PREFIX = ["/tmp/", "/proc/", "/sys/", "/dev/", "/run/", "/etc/", "/var/", "/boot/", "/usr/", "/lib/", "/opt/", "/snap/"];

export function looseDenied(dir: string): boolean {
  try {
    const p = path.resolve(dir);
    if (p === os.homedir()) return true;
    if (DENY_EXACT.has(p)) return true;
    return DENY_PREFIX.some((pre) => p.startsWith(pre));
  } catch {
    return true; // 判不了 = 保守不建
  }
}

/**
 * 预算扫描（§13.4）：文件计数到 budget 即停（早退，整树不全扫）。
 * 不跟符号链接目录；跳过 .aiti-trace 自身；读不了的目录跳过不算失败。
 * 返回计数（可能 > budget，调用方用 `> budget` 判超限）。
 */
export function countFilesWithBudget(dir: string, budget: number): number {
  let count = 0;
  const visit = (d: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return true; // 权限等：跳过该目录
    }
    for (const e of entries) {
      if (e.name === ".aiti-trace") continue;
      if (e.isSymbolicLink()) continue; // 符号链接一律不跟不计（Dirent.isDirectory 对 symlink 为 false，须先判）
      if (e.isDirectory()) {
        if (!visit(path.join(d, e.name))) return false;
      } else {
        count += 1;
        if (count > budget) return false;
      }
    }
    return true;
  };
  visit(dir);
  return count;
}

/** loose 目录 .gitignore 常见条目（seedCommonIgnores 开时补；默认关，§13.4） */
const COMMON_IGNORES = ["node_modules/", "dist/", "build/", "out/", "coverage/", "__pycache__/", ".venv/", "venv/", "*.log", ".DS_Store"];

/**
 * loose 目录 .gitignore 维护（§13.3）：缺 `.aiti-trace/` 行则补（幂等），
 * 文件不存在则创建；托管块包裹便于用户识别与移除。失败不阻塞建仓。
 */
export function maintainLooseGitignore(root: string, opts: { seedCommon?: boolean } = {}): void {
  try {
    const file = path.join(root, ".gitignore");
    let prev = "";
    try { prev = fs.readFileSync(file, "utf8"); } catch { /* new */ }
    const have = new Set(prev.split("\n").map((l) => l.trim()));
    const needed: string[] = [];
    if (!have.has(".aiti-trace/")) needed.push(".aiti-trace/");
    if (opts.seedCommon) for (const pat of COMMON_IGNORES) if (!have.has(pat)) needed.push(pat);
    if (needed.length === 0) return;
    const base = prev ? (prev.endsWith("\n") ? prev : prev + "\n") : "";
    const block = ["# --- aiti managed (loose trace) ---", ...needed, "# --- end aiti managed (loose trace) ---", ""].join("\n");
    fs.writeFileSync(file, base + block);
  } catch { /* 维护失败不阻塞建仓 */ }
}
