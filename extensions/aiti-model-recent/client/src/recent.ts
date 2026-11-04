/**
 * 最近使用模型的存储与面板分组逻辑（自 pi-web fork components/ModelSelector.tsx
 * 外迁，defork P4）。localStorage key 与原实现一致（pi-web:recent-models）——
 * 零数据迁移。
 */

export const RECENT_MODELS_KEY = "pi-web:recent-models";
export const RECENT_MODELS_LIMIT = 8;

/** 面板分组条目形状（与 core ModelSelectorOption 结构兼容的子集镜像）。 */
export interface ModelSelectorOption {
  provider: string;
  modelId: string;
  name: string;
  status?: "ok" | "rl" | "err" | "unprobed";
  providerRL?: boolean;
}

export interface RecentModelEntry {
  provider: string;
  modelId: string;
  at: number;
}

/** 读最近使用的模型（localStorage 持久化；损坏/非法条目静默忽略） */
export function readRecentModels(): RecentModelEntry[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_MODELS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is RecentModelEntry =>
      !!entry && typeof entry === "object"
      && typeof (entry as RecentModelEntry).provider === "string"
      && typeof (entry as RecentModelEntry).modelId === "string"
    );
  } catch {
    return [];
  }
}

/** 记录一次模型使用：置顶 + 去重 + 截断（LRU） */
export function rememberRecentModel(provider: string, modelId: string) {
  try {
    const rest = readRecentModels().filter((entry) => entry.provider !== provider || entry.modelId !== modelId);
    window.localStorage.setItem(RECENT_MODELS_KEY, JSON.stringify(
      [{ provider, modelId, at: Date.now() }, ...rest].slice(0, RECENT_MODELS_LIMIT),
    ));
  } catch {
    /* 隐私模式等 localStorage 不可用 → 静默降级为无最近使用 */
  }
}

/**
 * 最近使用 → 面板分组条目：仅面板打开且非搜索态；按记录时间倒序；
 * 只保留当前仍可用的模型（已删除/下架自动消失）；去重；截断 RECENT_MODELS_LIMIT。
 * provider/modelId 分字段拼接作 Map key，从不切分——含 "/" 的模型 id 安全。
 */
export function pickRecentOptions(
  recentList: RecentModelEntry[],
  sortedOptions: ModelSelectorOption[],
  opts: { open: boolean; filter: string },
): ModelSelectorOption[] {
  if (!opts.open || opts.filter.trim()) return [];
  const byKey = new Map(sortedOptions.map((option) => [`${option.provider}/${option.modelId}`, option] as const));
  const picked: ModelSelectorOption[] = [];
  for (const entry of recentList) {
    if (picked.length >= RECENT_MODELS_LIMIT) break;
    const option = byKey.get(`${entry.provider}/${entry.modelId}`);
    if (option && !picked.includes(option)) picked.push(option);
  }
  return picked;
}
