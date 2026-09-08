/**
 * core.readSession 的外部后端会话回退（独立轻模块：node --test 可直接加载——
 * core.ts 顶层的 rpc-manager import 链含 strip-types 不支持的 TS parameter property）。
 */
import { getHandle } from "../session/handle-store.ts";

/** 外部后端会话（zcode/codex/…）无 pi 会话文件——从活 handle 的内存历史
 * （getMessages capability）适配成 {messages, entryIds} 文件形态，供按文件形态
 * readSession 的扩展（ai-speek 跟读等）零改动消费。
 *
 * entryId 用消息索引合成（liveHistory 只增不减，索引在本 handle 生命周期内稳定，
 * 跨调用一致性是 ai-speek idsOnly→messages-content 两段拉取的匹配前提）；
 * handle dispose 后出库，本函数返回 null（消费方按「会话没了」走空分支）。 */
export async function readLiveHandleSession(id: string): Promise<{ messages: unknown[]; entryIds: string[] } | null> {
  const handle = getHandle(id);
  if (!handle?.getMessages) return null;
  try {
    const msgs = await handle.getMessages();
    if (!Array.isArray(msgs) || msgs.length === 0) return null;
    return {
      messages: msgs.map((m) => {
        if (!m || typeof m !== "object") return m;
        const o = m as { role?: unknown; content?: unknown };
        return { role: o.role, content: o.content };
      }),
      entryIds: msgs.map((_, i) => `${id}:msg-${i}`),
    };
  } catch {
    return null;
  }
}
