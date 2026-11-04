import type { TabOpen } from "./tab-session.ts";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /** The id came from a remembered tab, not the URL: the sidebar treats it as absent (#1168). */
  sessionFromTab?: boolean;
  sidebarCollapsed: boolean;
}

export function getInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : (searchParams.get("session") || null),
    sidebarCollapsed: searchParams.get("sidebar") === "collapsed",
  };
}

/**
 * Apply per-tab memory to a navigation snapshot that was taken from the URL
 * alone. Returns the same object when the URL already chose a cwd or session,
 * or when this tab has nothing stored.
 *
 * A remembered session fills `sessionId`. A remembered new-session composer
 * fills `requestedCwd` so reload shows that UI instead of the previous chat.
 *
 * Call this after mount. Reading sessionStorage during the first client render
 * (including a `useState` initializer) makes SSR HTML diverge from the client
 * tree — sessionStorage is empty on the server — and React reports a
 * hydration text mismatch in the sidebar / placeholder.
 */
export function withTabOpen(
  navigation: InitialNavigation,
  tabOpen: TabOpen | null,
): InitialNavigation {
  if (navigation.requestedCwd || navigation.sessionId || !tabOpen) {
    return navigation;
  }
  if (tabOpen.kind === "session") {
    return { ...navigation, sessionId: tabOpen.sessionId };
  }
  return { ...navigation, requestedCwd: tabOpen.cwd };
}

/** The ?session= id the URL asked for, unless it named a tab session (#1168). */
export function linkedSessionId(navigation: InitialNavigation): string | null {
  return navigation.sessionFromTab ? null : navigation.sessionId;
}
