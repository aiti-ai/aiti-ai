import assert from "node:assert/strict";

/*
 * The sidebar's sessions and files in either layout: on a desktop the files
 * sit below the sessions by default (both in view; the files section may be
 * folded to its header row), phones and Settings › General › File browser
 * "Separate tab" show one tab at a time. Both panels keep their ids in both.
 */

/** Shows the explorer: the Files tab, or the files section opened. */
export async function showSidebarFiles(page) {
  const files = page.locator("#session-sidebar-panel-files");
  const tab = page.getByRole("tab", { name: "Files", exact: true });
  const toggle = files.locator(".sidebar-files-section-toggle");
  await tab.or(toggle).first().waitFor();
  if (await tab.count()) {
    if (await tab.getAttribute("aria-selected") !== "true") await tab.click();
  } else if (await toggle.getAttribute("aria-expanded") !== "true") {
    await toggle.click();
  }
  await files.locator(".sidebar-files-body").waitFor({ state: "visible" });
}

/** Shows the session rows: the Sessions tab, or nothing to do below the files. */
export async function showSidebarSessions(page) {
  // [fork] the sessions region is rendered by the session-manager dock inside
  // #session-sidebar — the upstream tab/panel ids do not exist there. Wait for
  // the sidebar itself, then for at least one session row (by visible title).
  await page.locator("#session-sidebar").waitFor({ state: "visible" });
  await page.locator("#session-sidebar [data-session-row], #session-sidebar button").first().waitFor({ state: "visible" });
}

/**
 * [fork] Finds a session row by exact visible title inside #session-sidebar.
 * The dock renders plain buttons (no upstream .session-tree-* classes), so the
 * row is located by its title text and clicked directly.
 */
export function sessionRowLocator(page, title) {
  // The dock renders rows as plain divs (no button/role) — match by text and
  // take the deepest match, then fall back to the whole sidebar text scan.
  return page.locator(`#session-sidebar :text("${title}")`).last();
}

/**
 * On a desktop both regions show by default; "Separate tab" brings the tabs
 * back and "Below sessions" returns, the file tree mounted throughout: its
 * own root stays on the page and its file search keeps its query, which a
 * remount would lose (open folders would come back from the per-folder
 * memory, so they prove nothing).
 */
export async function checkFilesPlacement(page) {
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  const sessions = page.getByRole("region", { name: "Sessions", exact: true });
  const files = page.getByRole("region", { name: "Files", exact: true });
  const tablist = page.getByRole("tablist", { name: "Sidebar view", exact: true });
  await sessions.waitFor();
  await files.waitFor();
  assert.equal(await tablist.count(), 0, "No tabs while the files sit below the sessions");
  await showSidebarFiles(page);
  await page.getByRole("separator", { name: "Resize file browser", exact: true }).waitFor();
  const fileSearch = files.getByRole("button", { name: "Search files", exact: true });
  const fileQuery = page.locator("#file-search-input");
  if (await fileSearch.getAttribute("aria-expanded") !== "true") await fileSearch.click();
  await fileQuery.fill("e2e-placement");
  // FileExplorer's root, not the scroll box the sidebar always renders around it.
  const tree = await page.locator("#session-sidebar-panel-files .sidebar-files-scroll > *").first().elementHandle();
  const choose = async (label) => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.locator(".settings-section-tabs").getByRole("button", { name: "General", exact: true }).click();
    const radio = page.getByRole("radio", { name: label, exact: true });
    await radio.locator("..").click();
    assert.equal(await radio.isChecked(), true);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
  };

  await choose("Separate tab");
  await tablist.waitFor();
  assert.equal(await tablist.getByRole("tab").count(), 2);
  assert.equal(await tablist.getByRole("tab", { name: "Files", exact: true }).count(), 1);
  assert.equal(await sessions.count() + await files.count(), 0, "The panels are the tabs' again");
  assert.equal(await page.locator(".sidebar-files-section").count(), 0);
  await showSidebarFiles(page);
  await page.getByRole("tabpanel", { name: "Files", exact: true }).waitFor();

  await choose("Below sessions");
  await sessions.waitFor();
  await files.waitFor();
  assert.equal(await tablist.count(), 0);
  assert.equal(await tree.evaluate((element) => element.isConnected), true, "Switching layouts keeps the file tree mounted");
  assert.equal(await fileQuery.inputValue(), "e2e-placement", "and its file search");
  await tree.dispose();
  await fileQuery.fill("");
  await fileSearch.click();
  await fileQuery.waitFor({ state: "detached" });
}
