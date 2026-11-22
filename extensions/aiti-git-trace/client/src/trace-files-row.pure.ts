/**
 * aiti-git-trace · assistantMessageFooter 数据面（纯函数，无依赖可直测）
 * （方案 docs/aiti-git-trace-message-files-ext-plan.md §3.3）
 *
 * 输入 = 台账 ops 行（带外事实源，pi-git-trace 落盘）+ 宿主插槽 extra 的
 * assistantEntryIds（整轮 assistant entry id 集合）。输出 = 本轮 trace 捕捉的
 * 变更文件聚合；渲染前由组件与宿主 writtenFiles（write/edit 口径）求差集。
 */

/** 台账行（pi-git-trace/src/types.ts LedgerRow 的消费侧子集；宽松结构防漂移） */
export interface LedgerRowLike {
  entryId?: string;
  userEntryId?: string;
  stores?: Array<{
    root?: string;
    before?: string | null;
    files?: { M?: number; A?: number; D?: number; skipped?: number };
    paths?: string[];
    pathsTruncated?: boolean;
  }>;
  leaks?: unknown[];
  [k: string]: unknown;
}

/** 增量口径（与时间线/徽标一致）：纯基线 op（无 before）且无 leaks 不算变更。 */
export function rowHasDelta(row: LedgerRowLike): boolean {
  return (row.leaks || []).length > 0
    || (row.stores || []).some((s) => Boolean(s.before)
      && (s.files ? (s.files.M || 0) + (s.files.A || 0) + (s.files.D || 0) : 0) > 0);
}

/** 台账 paths 是仓相对路径 → 拼仓库根成绝对路径（已是绝对形态则原样）。 */
export function toAbsPath(root: string | undefined, rel: string): string {
  if (!rel) return "";
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rel)) return rel;
  if (!root) return rel;
  const sep = root.endsWith("/") || root.endsWith("\\") ? "" : "/";
  return root + sep + rel;
}

export interface TraceTurnFiles {
  /** 绝对路径（跨 store/跨 op 去重，首见序）。 */
  absPaths: string[];
  /** 任一 store 触发台账 paths 上限截断。 */
  truncated: boolean;
  /** 贡献文件的有增量 op 行数（title 展示用）。 */
  ops: number;
}

/**
 * 按整轮 assistant entry id 集合聚合台账 → 本轮 trace 捕捉的变更文件。
 * 关联键 = row.entryId（携带该工具调用的 assistant/toolCall entry）。
 * 无命中行 / 命中行全无增量 → null（渲染层整行不画）。
 */
export function aggregateTraceTurnFiles(
  rows: LedgerRowLike[] | null | undefined,
  assistantEntryIds: string[],
): TraceTurnFiles | null {
  const idSet = new Set((assistantEntryIds || []).map(String).filter(Boolean));
  if (idSet.size === 0) return null;
  const seen = new Set<string>();
  const absPaths: string[] = [];
  let truncated = false;
  let ops = 0;
  for (const row of rows || []) {
    if (!idSet.has(String(row.entryId || ""))) continue;
    if (!rowHasDelta(row)) continue;
    ops++;
    for (const s of row.stores || []) {
      if (s?.pathsTruncated) truncated = true;
      for (const p of s?.paths || []) {
        const abs = toAbsPath(s?.root, String(p));
        if (!abs || seen.has(abs)) continue;
        seen.add(abs);
        absPaths.push(abs);
      }
    }
  }
  if (absPaths.length === 0) return null;
  return { absPaths, truncated, ops };
}

/** 路径归一（分隔符/尾斜杠）后的差集：trace 有、宿主 writtenFiles 没有的文件。 */
export function diffAgainstWritten(absPaths: string[], writtenFiles: string[]): string[] {
  const norm = (p: string) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const written = new Set((writtenFiles || []).map(norm));
  return (absPaths || []).filter((p) => !written.has(norm(p)));
}
