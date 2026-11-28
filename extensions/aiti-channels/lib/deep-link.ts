/**
 * aiti-channels · mobile deep link builder (F6, pure — unit-tested).
 *
 * origin + basePath of THIS page plus ?session=<id> so the mobile workspace
 * lands on the current conversation (the AppShell reads the query param
 * natively). Empty sessionId → the param is dropped (workspace home).
 */

export function buildDeepLink(pageUrl: string, sessionId: string): string {
  try {
    const u = new URL(pageUrl);
    if (sessionId) u.searchParams.set("session", sessionId);
    else u.searchParams.delete("session");
    return u.toString();
  } catch { return pageUrl; }
}
