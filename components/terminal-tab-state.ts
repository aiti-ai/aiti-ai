export interface TerminalTab {
  id: string;
  cwd: string;
  restored?: boolean;
  closing?: "close" | "restart";
}

export const TERMINAL_TABS_KEY = "pi-web:terminal-tabs";

/**
 * [aiti] T2 接管：唤起 aiti-cmd 工作区终端（shell 由 aiti-cmd 承载：沙箱/审计/虚拟键盘/
 * 24h 会话）。aiti-cmd 未加载时返回 false（调用方展示缺席提示），不抛错。
 */
export function openAitiCmdShell(cwd: string): boolean {
  if (typeof window === "undefined") return false;
  const api = (window as unknown as { __aitiCmd?: { openShell?: (cwd: string, name?: string) => unknown } }).__aitiCmd;
  if (!api || typeof api.openShell !== "function") return false;
  try {
    api.openShell(cwd, "bash");
    return true;
  } catch {
    return false;
  }
}

export function newTerminalTab(cwd: string): TerminalTab {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id, cwd };
}

export function restoreTerminalTabs(raw: string | null): { tabs: TerminalTab[]; activeId: string | null; open: boolean } {
  try {
    const saved = JSON.parse(raw ?? "null");
    const tabs: TerminalTab[] = [];
    for (const tab of Array.isArray(saved?.tabs) ? saved.tabs : []) {
      if (tab && typeof tab.id === "string" && /^[a-f0-9]{32}$/.test(tab.id)
        && typeof tab.cwd === "string" && tab.cwd.trim()
        && !tabs.some((existing) => existing.id === tab.id || existing.cwd === tab.cwd)) {
        tabs.push({ id: tab.id, cwd: tab.cwd, restored: true });
      }
    }
    return { tabs, activeId: tabs.some((tab) => tab.id === saved.activeId) ? saved.activeId : null, open: saved?.open === true };
  } catch {
    return { tabs: [], activeId: null, open: false };
  }
}
