/**
 * Yunxiao constants: work-item categories, filter declaration and web URL builders.
 * Ported from the original VS Code extension (config/workitemTypes.js + extension.js).
 */
import type { FilterSpec } from "../../server/contract.ts";

/** categoryId → display name (platform data, kept in Chinese like the upstream UI). */
export const CATEGORY_NAMES: Record<string, string> = {
  Req: "需求",
  Bug: "缺陷",
  Task: "任务",
  Risk: "风险",
  SubTask: "子任务",
};

export const ALL_CATEGORY_IDS = Object.keys(CATEGORY_NAMES);
export const TERMINAL_STAGES = ["4", "5"]; // completed / cancelled

export function categoryName(id: string | undefined): string {
  if (!id) return "";
  return CATEGORY_NAMES[id] || id;
}

/** Status options used by the legacy filter UI (matched by display name via CONTAINS). */
export const STATUS_OPTIONS = ["未开始", "进行中", "已完成", "已关闭", "已解决", "重新打开", "测试中", "待审核"].map((s) => ({
  value: s,
  label: s,
}));

export const FILTERS: FilterSpec[] = [
  { key: "keyword", kind: "text", label: "关键词 / 编号" },
  {
    key: "type",
    kind: "multi",
    label: "工作项类型",
    options: ALL_CATEGORY_IDS.map((id) => ({ value: id, label: categoryName(id) })),
  },
  { key: "status", kind: "multi", label: "状态", options: STATUS_OPTIONS },
  { key: "assignee", kind: "user", label: "指派人" },
  { key: "excludeTerminal", kind: "bool", label: "排除已完成 / 已取消" },
];

export function workItemWebUrl(identifier: string | undefined, category: string | undefined, subject: string | undefined): string | null {
  if (!identifier) return null;
  const cat = String(category || "Req").toLowerCase();
  const hash = subject ? `#${encodeURIComponent(" " + subject)}` : "";
  return `https://devops.aliyun.com/projex/${cat}/${encodeURIComponent(identifier)}${hash}`;
}

export function projectWebUrl(projectId: string | undefined): string | null {
  if (!projectId) return null;
  return `https://devops.aliyun.com/projex/project/${encodeURIComponent(projectId)}`;
}

/** Work item state from the status stage (4/5 are terminal in Yunxiao's system stages). */
export function stateOf(statusStageId: string | undefined, statusName: string | undefined): "open" | "closed" | "other" {
  const stage = String(statusStageId ?? "").trim();
  // The stage is authoritative: a custom status NAME may read as done while the
  // item is still in progress (name mentions completion at an active stage), so
  // the name is only trusted when no stage exists.
  if (stage) return stage === "4" || stage === "5" ? "closed" : "open";
  const name = String(statusName || "");
  if (/已完成|已关闭|已取消/.test(name)) return "closed";
  if (!name) return "other";
  return "open";
}
