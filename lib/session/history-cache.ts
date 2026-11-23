/**
 * In-process history snapshot for external sessions.
 *
 * A host switch can leave a live wrapper whose newly attached handle replays
 * only part of the session. Preserve the full history captured during the
 * switch and let read routes prefer it while the handle's copy is shorter.
 * Keyed by every id spelling (native / composite); process-local and disposable.
 */
declare global {
  var __sessionHistoryCache: Map<string, unknown[]> | undefined;
}

function cache(): Map<string, unknown[]> {
  if (!globalThis.__sessionHistoryCache) globalThis.__sessionHistoryCache = new Map();
  return globalThis.__sessionHistoryCache;
}

export function rememberSessionHistory(ids: string[], messages: unknown[]): void {
  if (!messages.length) return;
  for (const id of ids) {
    if (id) cache().set(id, messages.slice());
  }
}

export function cachedSessionHistory(ids: string[]): unknown[] | undefined {
  let best: unknown[] | undefined;
  for (const id of ids) {
    if (!id) continue;
    const value = cache().get(id);
    if (value && (!best || value.length > best.length)) best = value;
  }
  return best;
}

export function clearSessionHistory(ids: string[]): void {
  for (const id of ids) {
    if (id) cache().delete(id);
  }
}
