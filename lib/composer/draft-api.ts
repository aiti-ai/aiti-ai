/**
 * 草稿存储 API 注册表（composer 契约收敛后的原语）。
 *
 * 设计（方案 A「keeper 唯一所有者」）：core 不再直接操作槽位（saveDraft/
 * clearDraft/rekeyDraft 均已退役），只声明**意图**，全部槽位读/写/清/搬在
 * keeper 状态机（aiti-draft-keeper/client/core.mjs）单一顺序内完成——
 * 此前 core 清槽与 keeper 清空链、promote 搬运交错的竞态窗口由此消除。
 *
 * core 经 applyDraftIntent() 访问；部署顺序无关：旧 keeper（无 applyIntent）
 * 时回退到 v1 方法模拟同等语义。
 */
/** 草稿图片的持久化形态（base64 data，无 previewUrl）。 */
export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface DraftSnapshot {
  value: string;
  images: ChatDraftImage[];
}

/** core → keeper 的草稿意图（唯一写入口）。 */
export type DraftIntent =
  /** 新建会话已提升为真实会话：provisional 草稿作废；此后对 provisionalKey 的
   *  输入由 keeper 重定向落 sessionId 槽位（消除「已发送消息残留」竞态）。 */
  | { type: "sessionCreated"; provisionalKey: string; sessionId: string }
  /** 发送失败/被拒：把提交合并回草稿（提交在前、原稿在后），目标是当前框则写回框内。 */
  | { type: "rejected"; key: string; text: string; images?: ChatDraftImage[] };

export interface DraftApi {
  /** 只读：读取指定 key 的草稿。 */
  getDraft(key: string): DraftSnapshot | null;
  /** 清除某会话所有草稿槽位（会话删除用，含旧 per-tab 残留）。 */
  clearAllDrafts(sessionId: string): void;
  /** 同步落盘所有未刷盘草稿（卸载/隐藏前）。 */
  flushAll(): void;
  /** 唯一写入口：core 只声明意图，keeper 决定全部槽位操作。 */
  applyIntent(intent: DraftIntent): void;
  // ---- deprecated v1（仅旧 keeper 兼容回退使用；新 core 不直调）----
  saveDraft?(key: string, draft: DraftSnapshot): void;
  clearDraft?(key: string): void;
  rekeyDraft?(previousKey: string, nextKey: string, currentDraft?: DraftSnapshot): DraftSnapshot | null;
  restoreSubmission?(key: string, text: string, images?: { data: string; mimeType: string }[]): DraftSnapshot;
}

let api: DraftApi | null = null;

export function registerDraftApi(a: DraftApi | null): void {
  api = a;
}

export function getDraftApi(): DraftApi | null {
  return api;
}

/** core 侧唯一写入口：优先走新原语；旧 keeper（无 applyIntent）回退 v1 方法模拟同等语义。 */
export function applyDraftIntent(intent: DraftIntent): void {
  const a = api;
  if (!a) return;
  if (typeof a.applyIntent === "function") {
    a.applyIntent(intent);
    return;
  }
  // 旧 keeper 回退：清 provisional 即可（rekey 搬运存在读槽竞态，宁可丢不可残留）
  if (intent.type === "sessionCreated") {
    a.clearDraft?.(intent.provisionalKey);
  } else if (intent.type === "rejected") {
    a.restoreSubmission?.(intent.key, intent.text, intent.images);
  }
}
