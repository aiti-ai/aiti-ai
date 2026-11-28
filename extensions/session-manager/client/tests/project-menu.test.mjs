/**
 * project-menu contract tests — the project menu is now ONE body shared by two places
 * (sidebar CWD picker + new-session Workspace selector). These assertions pin the
 * properties that made sharing worth it, plus the new-session staging contract.
 *
 * Source-level (the extension client has no DOM test harness): the pure lists/orders are
 * covered by sidebar/pure tests, the React behavior is verified in the dev instance.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const here = new URL("../src/", import.meta.url);
const projectMenu = await readFile(new URL("sidebar/project-menu.tsx", here), "utf8");
const picker = await readFile(new URL("sidebar/picker.tsx", here), "utf8");
const newSession = await readFile(new URL("new-session-workspace-picker.tsx", here), "utf8");
const directoryPicker = await readFile(new URL("sidebar/directory-picker.tsx", here), "utf8");
const entry = await readFile(new URL("entry.tsx", here), "utf8");
const manifest = await readFile(new URL("../../index.ts", import.meta.url), "utf8");

test("one body, two places: the sidebar picker and the new-session selector render ProjectMenuBody", () => {
  assert.match(projectMenu, /export function ProjectMenuBody/);
  assert.match(picker, /import \{ ProjectMenuBody \} from "\.\/project-menu"/);
  assert.match(newSession, /import \{ ProjectMenuBody \} from "\.\/sidebar\/project-menu"/);
  // Both mount the same actions: default directory + browse folders, then the slot footer.
  for (const source of [projectMenu]) {
    assert.match(source, /labels\.useDefault/);
    assert.match(source, /labels\.browse/);
    assert.match(source, /props\.actions/);
  }
  // The old per-surface row markup is gone (one row shape from @aiti-ai/ext-shared/menu-row).
  assert.match(projectMenu, /from "@aiti-ai\/ext-shared\/menu-row"/);
  assert.doesNotMatch(picker, /padding: "8px 10px"/);
});

test("browse folder entry is discoverable: its own label key, icon, tooltip, emphasized row", () => {
  assert.match(projectMenu, /labels\.browseTitle/);
  assert.match(projectMenu, /emphasized/);
  // "Custom path…" stays in the dictionary for older callers, "Browse folders…" is the row label.
  assert.match(manifest, /"sidebar\.browseFolders": "Browse folders…"/);
  assert.match(manifest, /"sidebar\.browseFoldersTitle":/);
  assert.match(manifest, /"sidebar\.browseFolders": "浏览文件夹…"/);
  assert.match(manifest, /"sidebar\.browseFolders": "瀏覽資料夾…"/);
});

test("new-session selector is registered as the host workspace takeover and stays staged", () => {
  assert.match(entry, /registerItems\?\.\("newSessionWorkspacePicker"/);
  assert.match(manifest, /newSessionWorkspacePicker: \[\{ id: "projects"/);
  // Staging first (native <select> semantics), immediate move only as the old-host fallback.
  const setTargetAt = newSession.indexOf("service.setTarget(path)");
  const setCwdAt = newSession.indexOf("service.setCwd(path)");
  assert.notEqual(setTargetAt, -1);
  assert.notEqual(setCwdAt, -1);
  assert.ok(setTargetAt < setCwdAt, "setTarget is the primary path; setCwd is the fallback");
  // Hidden workspaces are filtered exactly like the sidebar list (current folder excepted).
  assert.match(newSession, /project\.root !== current && hidden\.has\(project\.root\)/);
  assert.match(newSession, /orderProjects\(filtered, pinnedKeys\)/);
  // The same footer slot (get/upload/manage) feeds the new-session menu.
  assert.match(newSession, /renderSlot\("workspacePickerActions"/);
});

test("directory picker address bar is the shared breadcrumb (no always-on input)", async () => {
  // The dialog body now lives in extensions/_shared/directory-picker.tsx (one shape on every
  // extension surface); session-manager only binds it to this extension's host-shim. The
  // Explorer-style bar contract is pinned on the shared file.
  const shared = await readFile(new URL("../../../_shared/directory-picker.tsx", here), "utf8");
  assert.match(shared, /import \{ PathBreadcrumb \} from "\.\/path-breadcrumb"/);
  assert.match(shared, /<PathBreadcrumb/);
  assert.match(shared, /onEditingChange=\{setPathEditing\}/);
  assert.doesNotMatch(shared, /directory-picker-path"/);
  // Selection waits for the bar to leave edit mode (the listed folder is the commit point).
  assert.match(shared, /!pathEditing/);
  // The binding keeps the export name the lazy picks rely on and passes the host facilities.
  assert.match(directoryPicker, /export function DirectoryPicker/);
  assert.match(directoryPicker, /@aiti-ai\/ext-shared\/directory-picker/);
  assert.match(directoryPicker, /host=\{HOST\}/);
});

test("add folder to sidebar mounts the shared picker, not aiti-folder's browse dialog", async () => {
  // One picker everywhere: the sidebar's ＋ reuses sidebar-dock's lazy ref (same chunk,
  // Explorer-style path bar + new-folder row) instead of aiti-folder's DirectoryBrowser.
  const sidebarContent = await readFile(new URL("sidebar-content.tsx", here), "utf8");
  const sidebarDock = await readFile(new URL("sidebar-dock.tsx", here), "utf8");
  assert.match(sidebarDock, /export const dirPickerRef = createLazyModule\(\(\) => import\("\.\/sidebar\/directory-picker"\)\)/);
  assert.match(sidebarContent, /import \{ SidebarList, dirPickerRef \} from "\.\/sidebar-dock"/);
  assert.match(sidebarContent, /load=\{dirPickerRef\}/);
  assert.match(sidebarContent, /pick="DirectoryPicker"/);
  assert.doesNotMatch(sidebarContent, /aiti-folder\/client\/src\/directory-browser/);
});
