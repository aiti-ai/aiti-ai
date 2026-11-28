/**
 * Wait for a backend session handle's bootstrap (initialize + session/new|load)
 * before the read routes project its history.
 *
 * External providers (ACP/Qoder/…) return the handle before the asynchronous
 * bootstrap finishes. A page opened immediately after a hosting switch could
 * therefore read a partial/empty history and never refresh, which looks like
 * "the session cannot be opened". The wait is event-driven on the handle's
 * optional waitUntilReady(); handles without the seam are a no-op.
 */
export async function waitSessionReady(target: unknown, timeoutMs = 30_000): Promise<void> {
  const candidate = target as
    | { waitUntilReady?: () => Promise<void>; handle?: { waitUntilReady?: () => Promise<void> } }
    | null;
  const fn = candidate?.waitUntilReady ?? candidate?.handle?.waitUntilReady;
  if (typeof fn !== "function") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      const result = fn.call(candidate);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(finish, finish);
      } else {
        finish();
      }
    } catch {
      finish();
    }
  });
}
