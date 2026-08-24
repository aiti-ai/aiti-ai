/**
 * 草稿存储 API 注册表（去 fork 化 P2 收尾）。
 *
 * keeper（aiti-draft-keeper）注册实现，core 调用方（useAgentSession / AppShell /
 * ChatInput）经 getDraftApi() 访问——core 不再直连 draft-store，草稿功能全部归 keeper。
 *
 * null 安全：keeper（扩展 client）异步加载，注册前调用返回 null/空操作；这些调用
 * 均发生在用户交互后（会话删除 / 提交回填 / 会话提升），彼时 keeper 已注册。
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

export interface DraftApi {
  /** 保存草稿到指定 key（空草稿 = 清除）。 */
  saveDraft(key: string, draft: DraftSnapshot): void;
  /** 读取指定 key 的草稿（本标签页槽位）。 */
  getDraft(key: string): DraftSnapshot | null;
  /** 清除指定 key 的本标签页槽位。 */
  clearDraft(key: string): void;
  /** 清除某会话所有标签页的草稿槽位（会话删除用）。 */
  clearAllDrafts(sessionId: string): void;
  /** 会话提升 rekey：把旧 key 的草稿搬到新 key（合并已有内容）。返回搬后草稿。 */
  rekeyDraft(previousKey: string, nextKey: string, currentDraft?: DraftSnapshot): DraftSnapshot | null;
  /** 提交回填：把被拒/失败的提交文本+图片合并进指定 key 的草稿（不碰输入框，仅存储）。 */
  restoreSubmission(key: string, text: string, images?: { data: string; mimeType: string }[]): DraftSnapshot;
  /** 同步落盘所有未刷盘草稿（卸载/隐藏前）。 */
  flushAll(): void;
}

let api: DraftApi | null = null;

export function registerDraftApi(a: DraftApi | null): void {
  api = a;
}

export function getDraftApi(): DraftApi | null {
  return api;
}
