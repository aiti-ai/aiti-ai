import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { ProjectWorktreePicker, WorktreeRemoveForm } = await jiti.import("./ProjectWorktreePicker.tsx");
const { SidebarMenuSurface } = await jiti.import("./SidebarMenu.tsx");
const source = await readFile(new URL("./ProjectWorktreePicker.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const menuCss = await readFile(new URL("../app/sidebar-menu.css", import.meta.url), "utf8");

const h = React.createElement;
const noop = () => {};

const context = {
  cwd: "/home/me/work/app-worktrees/feature",
  project: { key: "app-key", root: "/home/me/work/app" },
  worktrees: [
    { path: "/home/me/work/app", branch: "main", isMain: true },
    { path: "/home/me/work/app-worktrees/feature", branch: "feature/x", isMain: false },
  ],
  currentWorktreePath: "/home/me/work/app-worktrees/feature",
  projects: [{ key: "app-key", root: "/home/me/work/app" }, { key: "lib-key", root: "/home/me/work/lib" }],
};

function render(props = {}) {
  return renderToStaticMarkup(h(I18nProvider, null, h(ProjectWorktreePicker, {
    layout: "stacked",
    context,
    mobile: false,
    label: "Project and worktree",
    newWorktreeTitle: "Create a worktree checkout for a branch",
    onPick: noop,
    onUseDefaultDirectory: noop,
    onOpenFolder: noop,
    onRefreshWorktrees: noop,
    onCreateWorktree: async () => ({ error: "unused" }),
    ...props,
  })));
}

/** The source between two anchors. */
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} … ${end}`);
  return source.slice(from, to);
}

test("inline: two chips with a divider, in the UI font", () => {
  const html = render({ layout: "inline" });
  assert.match(html, /^<div class="project-picker is-inline" role="group" aria-label="Project and worktree">/);
  assert.match(html, /<button type="button" class="project-picker-button is-project" title="\/home\/me\/work\/app" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="project-picker-label">app<\/span><svg[^>]*class="project-picker-chevron sidebar-icon-down"/);
  assert.match(html, /<span class="project-picker-divider" aria-hidden="true"><\/span>/);
  assert.match(html, /<button type="button" class="project-picker-button" title="Worktree: \/home\/me\/work\/app-worktrees\/feature" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="project-picker-label">feature\/x<\/span>/);
  // The chips carry nothing of the files tab's rows.
  assert.doesNotMatch(html, /project-picker-path|project-picker-note|project-picker-activity|is-name|is-mono/);
});

test("stacked: the project's name and its path, the worktree with its notes", () => {
  const html = render({ homeDir: "/home/me" });
  assert.match(html, /^<div class="project-picker is-stacked" role="group" aria-label="Project and worktree">/);
  assert.match(html, /<span class="project-picker-label is-name">app<\/span><span class="project-picker-path"><span>~\/work\/app<\/span><\/span>/);
  assert.doesNotMatch(html, /project-picker-divider/);
  // A linked checkout: its branch and how many checkouts there are.
  assert.match(html, /<span class="project-picker-label">feature\/x<\/span><span class="project-picker-note">2<\/span><svg/);
  // The main checkout says so.
  const main = render({ context: { ...context, currentWorktreePath: "/home/me/work/app" } });
  assert.match(main, /<span class="project-picker-label">main<\/span><span class="project-picker-note">main<\/span><span class="project-picker-note">2<\/span>/);
  // Without the home folder the path shows as it is.
  assert.match(render(), /<span class="project-picker-path"><span>\/home\/me\/work\/app<\/span><\/span>/);
  assert.doesNotMatch(html, /font-mono|style=/, "no code type, no inline styles");
});

test("stacked: activity elsewhere shows a dot; the project in use does not count", () => {
  const elsewhere = render({ projectActivity: new Map([["lib-key", { running: 0, unread: 2 }]]) });
  assert.match(elsewhere, /<span class="project-picker-activity" role="img" title="New activity" aria-label="New activity"><\/span><svg[^>]*project-picker-chevron/);
  assert.doesNotMatch(render({ projectActivity: new Map([["app-key", { running: 1, unread: 1 }]]) }), /project-picker-activity/);
  assert.doesNotMatch(render({ projectActivity: new Map([["lib-key", { running: 0, unread: 0 }]]) }), /project-picker-activity/);
  // The chips never show it.
  assert.doesNotMatch(render({ layout: "inline", projectActivity: new Map([["lib-key", { running: 1, unread: 0 }]]) }), /project-picker-activity/);
  // In the menu the counts are the session tree's own badge.
  assert.match(source, /badge: activity \? <ActivitySummary running=\{activity\.running\} unread=\{activity\.unread\} t=\{t\} \/> : undefined,/);
});

test("stacked: no project yet, and no worktree list", () => {
  const empty = render({ context: { project: null, worktrees: null, currentWorktreePath: null, projects: [] }, placeholder: "Select project…" });
  assert.match(empty, /<button type="button" class="project-picker-button is-project is-empty" title="" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(empty, /<span class="project-picker-label">Select project…<\/span>/);
  assert.equal((empty.match(/<button /g) ?? []).length, 1);

  // A subdirectory or a non-git folder: a disabled row says why, out of the tab order.
  const hint = { label: "Open repo root", title: "Open the repository root to manage worktrees." };
  const subdir = render({ context: { ...context, worktrees: null, currentWorktreePath: null }, worktreeHint: hint });
  assert.match(subdir, /<button type="button" aria-disabled="true" tabindex="-1" title="Open the repository root to manage worktrees\." class="project-picker-button is-inactive"><svg[^>]*class="project-picker-icon"[\s\S]*?<span class="project-picker-label">Open repo root<\/span><\/button>/);
  assert.equal((subdir.match(/aria-haspopup="menu"/g) ?? []).length, 1, "one menu button");
  // The chips have no hint: the project alone.
  assert.doesNotMatch(render({ layout: "inline", context: { ...context, worktrees: null }, worktreeHint: hint }), /is-inactive|project-picker-divider/);
});

test("both menus in both places: picking what is in use changes nothing while the worktrees are listed", () => {
  const projects = between("const projectItems", "const worktreeItems");
  assert.match(projects, /checked: choice\.key === project\?\.key,/);
  // Without a worktree list (a removed checkout's cwd) the project in use is the way back to its root.
  assert.match(projects, /if \(choice\.key !== project\?\.key \|\| !worktrees\) onPick\(\{ cwd: choice\.root, projectKey: choice\.key, projectRoot: choice\.root \}, "project"\);/);
  // Names, a parent folder only where names collide, the full path as the tooltip.
  assert.match(projects, /describeProjectChoices\(projectChoices\(context\)\)/);
  assert.match(projects, /title: choice\.root,/);
  // Then the default directory and any other folder.
  const defaults = projects.indexOf('label: t("sidebar.useDefaultDirectory"),');
  const other = projects.indexOf('label: t("sidebar.openOtherProject"),');
  assert.ok(projects.indexOf('{ type: "separator", id: "separator" }') < defaults && defaults < other);
  // No project to list (a first run): no line above the two folder items.
  assert.match(projects, /const separator: SidebarMenuItem\[\] = choices\.length > 0 \? \[\{ type: "separator", id: "separator" \}\] : \[\];/);
  assert.match(projects, /onSelect: \(\) => onUseDefaultDirectory\(\),/);
  assert.match(projects, /onSelect: \(\) => onOpenFolder\(menu\?\.opener \?\? null\),/);

  const worktrees = between("const worktreeItems", "const body = ");
  assert.match(worktrees, /checked: worktree\.path === current\?\.path,/);
  assert.match(worktrees, /if \(project && worktree\.path !== current\?\.path\) \{\s*onPick\(\{ cwd: worktree\.path, projectKey: project\.key, projectRoot: project\.root \}, "worktree"\);/);
  assert.match(worktrees, /note: worktree\.isMain \? t\("sidebar\.main"\) : undefined,/);
  assert.match(worktrees, /label: t\("sidebar\.newWorktree"\),[\s\S]*?onSelect: \(\{ keepOpen \}\) => \{\s*keepOpen\(\);\s*showBody\(\{ kind: "create", busy: false, error: null \}\);/);
  // Opening the worktree menu lists the worktrees again.
  assert.match(source, /if \(kind === "worktree"\) onRefreshWorktrees\(\);/);
  // Both lists get a filter once they are long.
  assert.match(source, /\? \{ placeholder: t\("sidebar\.filterProjects"\), emptyLabel: t\("sidebar\.noMatchingProjects"\) \}\s*: \{ placeholder: t\("sidebar\.filterWorktrees"\), emptyLabel: t\("sidebar\.noMatchingWorktrees"\) \};/);
  assert.match(source, /filter=\{filter\}/);
});

test("only the files tab removes worktrees, never the main one", () => {
  const worktrees = between("const worktreeItems", "const body = ");
  assert.match(worktrees, /secondary: onRemoveWorktree && !worktree\.isMain \? \{\s*label: t\("sidebar\.removeWorktreeTitle", \{ path: worktree\.path \}\),\s*icon: <TrashIcon size=\{12\} \/>,\s*danger: true,\s*disabled: menu\?\.removing,/);
  assert.match(worktrees, /keepOpen\(\);\s*void removeWorktree\(worktree, false\);/);
  assert.match(source, /onRemoveWorktree\?: \(project: ProjectChoice, path: string, force: boolean\) => Promise<WorktreeRemoval>;/);
});

test("a removal that needs an answer becomes the menu's body; a removed checkout goes back to the list", () => {
  const remove = between("const removeWorktree = async", "const projectItems");
  assert.match(remove, /result = await onRemoveWorktree\(project, worktree\.path, force\);/);
  assert.match(remove, /if \(result === "removed"\) return \{ \.\.\.menuState, removing: false, body: null \};/);
  assert.match(remove, /const dirty = result === "dirty" \|\| \(menuState\.body\?\.kind === "remove" && menuState\.body\.dirty\);/);
  assert.match(remove, /body: \{ kind: "remove", worktree, dirty, busy: false, error: result === "dirty" \? null : result\.error \},/);
  // Only the menu it was asked from takes the answer.
  assert.match(source, /const updateMenu = \(id: number, change: \(state: MenuState\) => MenuState \| null\) => \{\s*setMenu\(\(state\) => \(state\?\.id === id \? change\(state\) : state\)\);/);
  // Force from the body; Cancel takes the focus first, so Enter discards nothing.
  assert.match(source, /onForce=\{\(\) => \{ void removeWorktree\(body\.worktree, true\); \}\}/);
  assert.match(source, /<button type="button" className="sidebar-worktree-cancel" data-sidebar-menu-autofocus="" onClick=\{onCancel\}>/);
  assert.match(source, /focusCancel=\{body\?\.kind === "remove"\}/);
  assert.match(source, /\{dirty && <div className="sidebar-worktree-message">\{t\("sidebar\.forceRemoveCheckout"\)\}<\/div>\}/);
  assert.match(source, /menuTitle = t\("sidebar\.removeWorktreeHeading", \{ name: worktreeLabel\(body\.worktree\) \}\);/);
});

test("a created worktree is moved to only while its form is still open", () => {
  const create = between("const createWorktree = async", "const removeWorktree = async");
  const mounted = create.indexOf("if (!mountedRef.current) return;");
  const error = create.indexOf('if ("error" in result) {');
  const open = create.indexOf("if (menuRef.current?.id !== id) return;");
  const pick = create.indexOf('onPickRef.current({ cwd: result.path, projectKey: project.key, projectRoot: project.root }, "worktree");');
  assert.ok(mounted >= 0 && mounted < error && error < open && open < pick, "mounted, error shown, form still open, then the move");
  assert.match(source, /const onPickRef = useRef\(onPick\);\s*onPickRef\.current = onPick;/);
  // A new body is a new menu: the list's pending removal answers nobody.
  assert.match(source, /setMenu\(\(state\) => \(state\?\.kind === "worktree" \? \{ \.\.\.state, id, body, removing: false \} : state\)\);/);
});

test("the owner reaches the buttons and opens a menu through the handle", () => {
  const handle = between("useImperativeHandle(handleRef", "/** Changes the menu");
  assert.match(handle, /button: \(control\) => \(control === "worktree" \? worktreeRef : projectRef\)\.current,/);
  assert.match(handle, /if \(button\) openMenuRef\.current\(control, button\);/);
  assert.match(handle, /\}\), \[\]\);/);
  // A stacked row's menu is as wide as the row.
  assert.match(source, /const width = stacked \? Math\.max\(STACKED_MENU_MIN_WIDTH, Math\.round\(rect\.width\)\) : kind === "project" \? 260 : 240;/);
});

test("client code stays parseable by Safari 16.2 and its CSS flat", () => {
  assert.doesNotMatch(source, /\(\?<[=!]/, "no RegExp lookbehind");
  const rules = css.slice(css.indexOf("/* The project and worktree picker (ProjectWorktreePicker)"), css.indexOf(".file-viewer-icon-button {"));
  assert.ok(rules.length > 0);
  assert.doesNotMatch(rules.replace(/@media[^{]*\{/g, ""), /\{[^}]*\{|&/, "no nested rules");
  assert.doesNotMatch(rules, /font-mono/, "the UI font in both places");
  // The files tab's rows: full width, the bar's type and box, the path cut at its left.
  assert.match(rules, /\.project-picker\.is-stacked \{\s*flex: none;\s*flex-direction: column;\s*align-items: stretch;/);
  assert.match(rules, /\.project-picker\.is-stacked \.project-picker-button \{\s*width: 100%;\s*max-width: none;/);
  assert.match(rules, /\.project-picker-path \{[^}]*direction: rtl;/);
  // A long path never squeezes the project name: the name does not shrink, the path grows from zero.
  assert.match(rules, /\.project-picker\.is-stacked \.project-picker-label\.is-name \{\s*flex: 0 0 auto;\s*max-width: 60%;/);
  assert.match(rules, /\.project-picker-path \{\s*flex: 1 1 0;\s*min-width: 0;/);
  assert.match(rules, /\.project-picker-path > span \{\s*unicode-bidi: plaintext;/);
  assert.match(rules, /\.project-picker-button\.is-inactive,\s*\.project-picker-button\.is-inactive:hover \{[^}]*cursor: default;/);
  assert.match(menuCss, /\.sidebar-worktree-force \{\s*border-color: #ef4444;/);
});

/** The removal body inside the menu surface, as the picker hands it over. */
function removalSurface({ sheet, dirty = true, error = null }) {
  return renderToStaticMarkup(h(I18nProvider, null, h(SidebarMenuSurface, {
    sheet,
    ariaLabel: "Remove feature/x?",
    title: "Remove feature/x?",
    cancelLabel: "Cancel",
    focusCancel: true,
    onActivate: noop,
    onClose: noop,
  }, h(WorktreeRemoveForm, {
    heading: sheet ? null : "Remove feature/x?",
    dirty,
    busy: false,
    error,
    showCancel: !sheet,
    onForce: noop,
    onCancel: noop,
  }))));
}

test("the force question starts on a Cancel on a desktop and in a sheet, never on Force", () => {
  const desktop = removalSurface({ sheet: false });
  assert.equal((desktop.match(/data-sidebar-menu-autofocus=""/g) ?? []).length, 1);
  assert.match(desktop, /<button type="button" class="sidebar-worktree-cancel" data-sidebar-menu-autofocus="">Cancel<\/button>/);
  // The sheet brings its own Cancel, which takes the focus Force would get as the first control.
  const sheet = removalSurface({ sheet: true });
  assert.equal((sheet.match(/data-sidebar-menu-autofocus=""/g) ?? []).length, 1);
  assert.match(sheet, /<button type="button" class="sidebar-worktree-force">Force<\/button>/);
  assert.match(sheet, /<button type="button" class="sidebar-sheet-cancel" data-sidebar-menu-autofocus="">Cancel<\/button><\/div><\/div>$/);
  assert.doesNotMatch(sheet, /sidebar-worktree-cancel/, "one Cancel in the sheet");
  // A failure without the question: the error, and still Cancel first.
  const failed = removalSurface({ sheet: true, dirty: false, error: "locked" });
  assert.doesNotMatch(failed, /sidebar-worktree-force/);
  assert.match(failed, /<div class="sidebar-worktree-error" role="alert">locked<\/div>/);
});

test("the menu gets one child, null while it lists items", () => {
  const menu = source.slice(source.indexOf("<SidebarMenu\n"), source.indexOf("</SidebarMenu>"));
  assert.match(menu, /width=\{menu\?\.width\}\s*>\s*\{menuBody\}\s*$/);
  assert.match(source, /let menuBody: ReactNode = null;/);
  // Each body goes with its own title, and a list with no body at all.
  const chain = between("let menuBody: ReactNode = null;", "const filter = ");
  assert.match(chain, /if \(body\?\.kind === "create"\) \{\s*menuTitle = newWorktreeTitle;\s*menuBody = \(\s*<WorktreeCreateForm/);
  assert.match(chain, /\} else if \(body\?\.kind === "remove"\) \{\s*menuTitle = [^;]+;\s*menuBody = \(\s*<WorktreeRemoveForm/);
  assert.match(chain, /\} else if \(menu\?\.kind === "project"\) \{\s*menuTitle = t\("workspace\.project"\);\s*menuItems = projectItems\(\);/);
});

test("clipped labels keep their descenders in both places", () => {
  const rules = css.slice(css.indexOf("/* The project and worktree picker (ProjectWorktreePicker)"), css.indexOf(".file-viewer-icon-button {"));
  assert.match(rules, /\.project-picker \{[^}]*line-height: 1;/);
  assert.match(rules, /\.project-picker-label,\s*\.project-picker-path \{\s*line-height: normal;\s*\}/);
  assert.match(rules, /\.project-picker-label \{[^}]*overflow: hidden;/);
  assert.match(rules, /\.project-picker-path \{[^}]*overflow: hidden;/);
});
