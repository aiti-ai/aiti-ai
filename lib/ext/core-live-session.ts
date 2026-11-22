/**
 * External-backend session fallback for core.readSession (standalone light module:
 * node --test can load it directly — the rpc-manager import chain at the top of
 * core.ts contains a TS parameter property not supported by strip-types).
 */
import { getHandle } from "../session/handle-store.ts";

/** External-backend sessions (zcode/codex/…) have no pi session file — adapt the
 * live handle's in-memory history (getMessages capability) into the {messages,
 * entryIds} file form, so extensions that readSession in file form (ai-speek
 * follow-read etc.) consume them with zero changes.
 *
 * entryId is synthesized from the message index (liveHistory only grows, never
 * shrinks, so the index is stable for the lifetime of this handle; cross-call
 * consistency is the matching precondition for ai-speek's idsOnly→messages-content
 * two-phase fetch); after the handle is disposed it leaves the store and this
 * function returns null (consumers take the empty branch as "session gone"). */
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
