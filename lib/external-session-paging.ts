import { normalizeRawMessages } from "./normalize.ts";
import type { AgentMessage } from "./types.ts";

/**
 * 外部后端会话（zcode/cursor/… provider handle、桥 attach）的游标分页。
 *
 * 这些通道的 get_messages 吐的是无 id 的平面消息数组（与 pi 本地会话的
 * SessionEntry 树不同），历史上详情/上下文路由全量一次性返回——千条级会话
 * 首开 payload 1MB+，前端主线程 parse/加工形成数秒 longtask。
 *
 * 这里统一补上与本地会话同形的分页契约：
 *   - 合成稳定 entryId：`ext-<i>`（i = 消息在完整数组中的下标；外部会话
 *     append-only，前缀稳定，跨页/跨请求可比对）。
 *   - `tail`：首拉只返回尾部 N 条（默认 50，clamp 上限 1000，与本地一致）。
 *   - `before`：客户端已持有的最老 entryId（ext-i）→ 返回 [i-tail, i) 页
 *     （不含 before 自身，与本地 excludeLeaf 语义一致，prepend 无重复）。
 *
 * 服务端仍从 handle 拉全量再切片——handle 侧读取本身是毫秒级（sqlite 直读
 * 实测 15MB 会话 ~300ms，热态 <100ms），瓶颈在传输与前端加工，不在读取。
 */

export const EXTERNAL_ENTRY_ID_PREFIX = "ext-";

export function parseExternalEntryId(id: string | null | undefined): number | null {
  if (!id?.startsWith(EXTERNAL_ENTRY_ID_PREFIX)) return null;
  const n = Number(id.slice(EXTERNAL_ENTRY_ID_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function clampTailParam(raw: string | null | undefined, fallback = 50): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : fallback;
}

export interface ExternalPagedContext {
  messages: AgentMessage[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
  totalCount: number;
}

export function buildExternalPagedContext(
  rawEntries: unknown[],
  opts: { tail?: number; before?: string | null } = {},
): ExternalPagedContext {
  const all = normalizeRawMessages(rawEntries);
  const tail = opts.tail && opts.tail > 0 ? Math.min(opts.tail, 1000) : all.length;
  const beforeIdx = parseExternalEntryId(opts.before);
  const end = beforeIdx !== null ? Math.min(beforeIdx, all.length) : all.length;
  const start = Math.max(0, end - tail);
  const messages = all.slice(start, end);
  const entryIds = messages.map((_, i) => `${EXTERNAL_ENTRY_ID_PREFIX}${start + i}`);
  return {
    messages,
    entryIds,
    oldestEntryId: entryIds[0] ?? null,
    hasMore: start > 0,
    totalCount: all.length,
  };
}
