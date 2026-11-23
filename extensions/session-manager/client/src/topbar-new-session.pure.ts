/**
 * session-manager · topbarMobileLeading button — the action half, pure and DOM-free
 * (node --experimental-strip-types testable; the JSX shell lives in topbar-new-session.tsx).
 *
 * The host owns session creation; the extension only names the cwd. "pi-web.newSession" is
 * the host client service the sidebar takeovers already use (workspace upload, the
 * welcome-page picker), so the phone button takes exactly the same path as the drawer
 * header's "+": draft parking, URL cleanup and closing the drawer stay in the host's
 * single implementation (AppShell handleNewSession).
 */

/** The slice of the host "pi-web.newSession" client service this button needs. */
export interface NewSessionService {
  /** Start a fresh composer in `path` (host service; absent on older hosts). */
  setCwd?: (path: string) => void;
}

/** True when the service took the cwd; no cwd / older host = nothing to do. */
export function startNewSessionAt(
  service: NewSessionService | null | undefined,
  cwd: string | null | undefined,
): boolean {
  if (!cwd || typeof service?.setCwd !== "function") return false;
  service.setCwd(cwd);
  return true;
}
