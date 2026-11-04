/**
 * git-plan · aiti-folder 提交计划（原 folder 案 §5/§6，git-ops 融合方案 M4）。
 *
 * - 启发式分组（两级的第一级，零成本离线）：目录前缀聚类 + 类型规则（锁文件/配置/文档/
 *   测试/源码）+ 状态修饰（全新增组建议 feat:、仅修改组建议 fix:）；锁文件默认进 excluded 建议。
 * - 偏好学习（纯本地统计，不上模型）：用户在对话框的纠偏（文件移组=dirKey 共现、剔除=pattern）
 *   写入 state/grouping-prefs.json；启发式读入——共现 ≥2 的 dirKey 对合并为一组。
 * - plan CRUD：state 层（不可再生）`<stateDir>/aiti-folder/plan-<hash(cwd)>.json`；
 *   执行不走这里——客户端直调引擎 `/git/plan/execute`（断点语义）与 `/git/plan/rollback`。
 *
 * 服务端红线对照：纯 fs + 同步小 JSON（<8MB 千倍余量）；无 git 子进程（读面全走引擎）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface PlanGroup {
  id: string;
  files: string[];
  message: string;
  state: "pending" | "committed" | "failed";
}
export interface CommitPlan {
  id: string;
  cwd: string;
  baseHEAD: string;
  groups: PlanGroup[];
  excluded: string[];
  createdAt: number;
  updatedAt: number;
}

interface Prefs {
  /** dirKey 共现权重：用户把两个 dirKey 的文件分进同组 → 计数 +1；≥CO_CHANGE_MIN 合并 */
  coChange: Record<string, number>;
  /** 用户剔除过的路径（精确）→ 启发式直接建议 excluded */
  excludedPaths: string[];
}

const LOCK_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i;
const DOC_RE = /(^|\/)(docs?|README|CHANGELOG|LICENSE)|\.(md|mdx|txt)$/i;
const CFG_RE = /\.(json|ya?ml|toml|ini|conf|env|rc)$/i;
const TEST_RE = /(^|\/)(tests?|__tests__)(\/|$)|[.\-_](test|spec)\.[a-z]+$/i;
const CO_CHANGE_MIN = 2;
const PLAN_CAP = 20; // 计划文件体自防御上限（KB）：正常计划远小于此

const dirKeyOf = (rel: string): string => {
  const norm = rel.replace(/\\/g, "/");
  const segs = norm.split("/");
  if (segs.length <= 1) return "(root)";
  // src/包名 二级；其余一级
  if (/^(src|lib|app|packages)$/.test(segs[0]) && segs.length > 2) return `${segs[0]}/${segs[1]}`;
  return segs[0];
};

const typeOf = (rel: string): "lock" | "docs" | "config" | "test" | "source" => {
  if (LOCK_RE.test(rel)) return "lock";
  if (DOC_RE.test(rel)) return "docs";
  if (TEST_RE.test(rel)) return "test";
  if (CFG_RE.test(rel)) return "config";
  return "source";
};

const typeRank: Record<string, number> = { docs: 0, config: 1, test: 2, source: 3 };

const suggestType = (rel: string, statuses: string[]): string => {
  const t = typeOf(rel);
  if (t === "docs") return "docs";
  if (t === "config" || t === "lock") return "chore";
  if (t === "test") return "test";
  // 源码：组内全为新增 → feat:；含修改 → fix:（启发式猜测，用户可改）
  return statuses.every((s) => s === "untracked" || s === "added") ? "feat" : "fix";
};

function loadPrefs(stateDir: string): Prefs {
  try {
    const p = JSON.parse(readFileSync(join(stateDir, "aiti-folder", "grouping-prefs.json"), "utf8"));
    return { coChange: p.coChange ?? {}, excludedPaths: p.excludedPaths ?? [] };
  } catch {
    return { coChange: {}, excludedPaths: [] };
  }
}

function savePrefs(stateDir: string, prefs: Prefs): void {
  const f = join(stateDir, "aiti-folder", "grouping-prefs.json");
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(prefs, null, 2));
}

/** 启发式分组：输入变更文件（相对路径 + 宿主 status 分类），输出组与 excluded 建议 */
export function groupHeuristic(
  stateDir: string,
  files: { path: string; status?: string }[],
): { groups: { key: string; message: string; files: string[] }[]; excluded: string[] } {
  const prefs = loadPrefs(stateDir);
  const excluded: string[] = [];
  const buckets = new Map<string, { type: string; files: string[]; statuses: string[] }>();

  for (const f of files) {
    const rel = String(f.path || "").replace(/\\/g, "/");
    if (!rel) continue;
    if (typeOf(rel) === "lock" || prefs.excludedPaths.includes(rel)) {
      excluded.push(rel);
      continue;
    }
    const dk = dirKeyOf(rel);
    // 偏好：共现 ≥2 的 dirKey 对合并（合并到 key 排序在前的一方）
    let key = `${dk}::${typeOf(rel)}`;
    for (const [pair] of Object.entries(prefs.coChange)) {
      const [a, b] = pair.split("→");
      if ((a === dk || b === dk) && prefs.coChange[pair] >= CO_CHANGE_MIN) {
        const other = a === dk ? b : a;
        key = `${[dk, other].sort()[0]}::merged`;
        break;
      }
    }
    const hit = buckets.get(key);
    if (hit) {
      hit.files.push(rel);
      hit.statuses.push(String(f.status ?? "modified"));
    } else {
      buckets.set(key, { type: typeOf(rel), files: [rel], statuses: [String(f.status ?? "modified")] });
    }
  }

  const groups = [...buckets.entries()]
    .map(([key, b]) => {
      const type = b.type === "lock" ? "chore" : b.type;
      const verb = suggestType(b.files[0], b.statuses);
      const dirLabel = key.split("::")[0] === "(root)" ? "misc" : key.split("::")[0];
      const message = `${verb}(${dirLabel}): ${b.files.length} file(s)`;
      return { key, message, files: b.files.sort() };
    })
    .sort((x, y) => (typeRank[x.key.split("::")[1]] ?? 3) - (typeRank[y.key.split("::")[1]] ?? 3) || x.key.localeCompare(y.key));

  return { groups, excluded: excluded.sort() };
}

/** 偏好学习：用户纠偏回写（move=共现；exclude=精确路径） */
export function learn(stateDir: string, action: "move" | "exclude", payload: { file?: string; toKey?: string; path?: string }): void {
  const prefs = loadPrefs(stateDir);
  if (action === "move" && payload.file && payload.toKey) {
    const dk = dirKeyOf(String(payload.file).replace(/\\/g, "/"));
    if (dk !== payload.toKey) {
      const pair = [dk, payload.toKey].sort().join("→");
      prefs.coChange[pair] = (prefs.coChange[pair] ?? 0) + 1;
    }
  } else if (action === "exclude" && payload.path) {
    const rel = String(payload.path).replace(/\\/g, "/");
    if (!prefs.excludedPaths.includes(rel)) prefs.excludedPaths.push(rel);
  } else {
    return;
  }
  savePrefs(stateDir, prefs);
}

// ── plan CRUD（state 层；按 cwd 哈希一仓一份）──

const planPath = (stateDir: string, cwd: string): string => {
  const h = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  return join(stateDir, "aiti-folder", `plan-${h}.json`);
};

export function loadPlan(stateDir: string, cwd: string): CommitPlan | null {
  const f = planPath(stateDir, cwd);
  try {
    if (!existsSync(f)) return null;
    if (readFileSync(f, "utf8").length > PLAN_CAP * 1024) return null; // 体积自防御：异常大计划拒读
    const p = JSON.parse(readFileSync(f, "utf8")) as CommitPlan;
    return p && Array.isArray(p.groups) ? p : null;
  } catch {
    return null;
  }
}

export function savePlan(stateDir: string, plan: CommitPlan): CommitPlan {
  if (!plan || plan.cwd !== undefined && typeof plan.cwd !== "string") throw new Error("bad plan");
  if (!Array.isArray(plan.groups)) throw new Error("bad plan groups");
  plan.updatedAt = Date.now();
  const f = planPath(stateDir, plan.cwd);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(plan, null, 2));
  return plan;
}

export function newPlan(cwd: string, baseHEAD: string): CommitPlan {
  return {
    id: "plan-" + createHash("sha1").update(cwd + Date.now()).digest("hex").slice(0, 8),
    cwd,
    baseHEAD,
    groups: [],
    excluded: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
