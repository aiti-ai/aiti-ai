import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");
const { NewSessionContextBar } = await jiti.import("./NewSessionContextBar.tsx");
const source = await readFile(new URL("./NewSessionContextBar.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const contextSource = await readFile(new URL("../lib/new-session-context.ts", import.meta.url), "utf8");

const h = React.createElement;
const noop = () => {};

const context = {
  cwd: "/work/app-worktrees/feature",
  project: { key: "app-key", root: "/work/app" },
  worktrees: [
    { path: "/work/app", branch: "main", isMain: true },
    { path: "/work/app-worktrees/feature", branch: "feature/x", isMain: false },
  ],
  currentWorktreePath: "/work/app-worktrees/feature",
  projects: [{ key: "app-key", root: "/work/app" }],
};

function render(props = {}) {
  return renderToStaticMarkup(h(I18nProvider, null, h(NewSessionContextBar, {
    context,
    mobile: false,
    initialFocus: null,
    onInitialFocusDone: noop,
    onPick: noop,
    onUseDefaultDirectory: noop,
    onOpenFolder: noop,
    onRefreshWorktrees: noop,
    onCreateWorktree: async () => ({ error: "unused" }),
    ...props,
  })));
}

test("the bar shows the project and the worktree in use as two menu buttons", () => {
  const html = render();
  assert.match(html, /^<div class="new-session-context"><div class="project-picker is-inline" role="group" aria-label="New session location">/);
  assert.match(html, /<button type="button" class="project-picker-button is-project" title="\/work\/app" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="project-picker-label">app<\/span>/);
  assert.match(html, /<button type="button" class="project-picker-button" title="Worktree: \/work\/app-worktrees\/feature" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="project-picker-label">feature\/x<\/span>/);
  // One type for both: the branch is not set in code type.
  assert.doesNotMatch(html, /is-mono/);
  assert.match(html, /<span class="project-picker-divider" aria-hidden="true"><\/span>/);
  // The side padding is the header row's (ChatWindow), on phones too.
  assert.match(render({ mobile: true }), /^<div class="new-session-context"><div class="project-picker is-inline"/);
  // The files tab's picker, as chips, with the bar's own title for "New worktree…".
  assert.match(source, /<ProjectWorktreePicker\s+handleRef=\{pickerRef\}\s+layout="inline"/);
  assert.match(source, /newWorktreeTitle=\{t\("sidebar\.newWorktreeForSession"\)\}/);
  assert.match(source, /onUseDefaultDirectory=\{onUseDefaultDirectory\}/);
  assert.doesNotMatch(source, /onRemoveWorktree|SidebarMenu/, "the bar removes nothing, and its menus are the picker's");
});

test("the worktree button needs a worktree list: a non-git folder or a subdirectory has none", () => {
  const html = render({ context: { ...context, cwd: "/work/app/sub", project: { key: "/work/app/sub", root: "/work/app/sub" }, worktrees: null, currentWorktreePath: null } });
  assert.match(html, /<span class="project-picker-label">sub<\/span>/);
  assert.doesNotMatch(html, /Worktree:|project-picker-divider/);
  assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 1);
  // The main checkout shows its branch; a detached one its folder.
  assert.match(render({ context: { ...context, currentWorktreePath: "/work/app" } }), /picker-label">main<\/span>/);
  assert.match(
    render({ context: { ...context, worktrees: [{ path: "/work/app", branch: null, isMain: true }], currentWorktreePath: "/work/app" } }),
    /title="Worktree: \/work\/app"[^>]*>[\s\S]*?picker-label">app<\/span>/,
  );
});

test("the control a move came from takes focus in the bar of the new composer", () => {
  assert.match(source, /const from = initialFocusRef\.current;\s*if \(!from\) return;\s*initialFocusRef\.current = null;\s*onInitialFocusDoneRef\.current\(\);\s*const picker = pickerRef\.current;\s*focusIfLost\(document, \(from === "worktree" \? picker\?\.button\("worktree"\) : null\) \?\? picker\?\.button\("project"\) \?\? null\);/);
});

test("the bar sits in the empty page's header row, after the brand, only while it is empty", () => {
  const start = chatWindowSource.indexOf("{isEmptyNew && (\n          <div className=\"new-session-hero\"");
  assert.ok(start > 0);
  const hero = chatWindowSource.slice(start, chatWindowSource.indexOf("{chatInputElement}", start));
  // The versions first (floated right of the first line), then the brand and the bar.
  assert.match(
    hero,
    /^\{isEmptyNew && \(\s*<div className="new-session-hero" style=\{\{ paddingLeft: 16, paddingRight: isMobile \? 16 : 52 \}\}>\s*<div className="new-session-hero-row" style=\{\{ maxWidth: "var\(--chat-content-max-width, 820px\)" \}\}>\s*<div className="new-session-versions">[\s\S]*?<\/div>\s*<div className="new-session-brand" style=\{\{ gap: isMobile \? 7 : 10 \}\}>\s*<Image src="\/icons\/apple-touch-icon\.png"[\s\S]*?<\/div>\s*\{newSessionContextBar\}\s*<\/div>\s*<\/div>\s*\)\}\s*$/,
  );
  // The composer follows the header; nothing renders the bar elsewhere.
  assert.equal((chatWindowSource.match(/newSessionContextBar\}/g) ?? []).length, 1);
});

test("the update check runs once per page, so a later header has the link in its first paint", () => {
  assert.match(chatWindowSource, /let appUpdateCheck: Promise<AppUpdateResponse \| null> \| null = null;\s*let appUpdateFound: AppUpdateResponse \| null = null;/);
  assert.match(chatWindowSource, /appUpdateCheck \?\?= fetch\("\/api\/app-update"\)/);
  // A failure is forgotten: a later header asks again.
  assert.match(chatWindowSource, /\.catch\(\(\) => \{[^}]*appUpdateCheck = null;\s*return null;/);
  assert.match(chatWindowSource, /useState<AppUpdateResponse \| null>\(\(\) => appUpdateFound\);/);
  assert.match(chatWindowSource, /if \(appUpdateFound\) return;\s*let cancelled = false;/);
});

test("client code stays parseable by Safari 16.2 and its CSS flat", () => {
  for (const file of [source, contextSource]) {
    assert.doesNotMatch(file, /\(\?<[=!]/, "no RegExp lookbehind");
  }
  const rules = css.slice(css.indexOf(".new-session-hero {"), css.indexOf(".file-viewer-icon-button {"));
  assert.doesNotMatch(rules.replace(/@media[^{]*\{/g, ""), /\{[^}]*\{|&/, "no nested rules");
  // The brand and the bar wrap as inline boxes: the bar stays beside the
  // brand while its chips fit whole, else it takes the next line, which,
  // below the floated versions, has the whole width. Every box is 40px with
  // its margins, so the lines never depend on what they hold.
  assert.match(rules, /\.new-session-hero-row \{\s*margin: 0 auto;\s*line-height: 0;\s*\}/);
  assert.match(rules, /\.new-session-versions \{\s*display: flex;\s*float: right;[^}]*height: 40px;\s*margin-left: 14px;/);
  // The brand gives way beside the versions rather than dropping under them.
  assert.match(rules, /\.new-session-brand \{\s*display: inline-flex;\s*align-items: center;\s*min-width: 0;\s*max-width: calc\(100% - 120px\);\s*margin: 4px 20px 4px 0;\s*overflow: hidden;[^}]*vertical-align: middle;/);
  assert.match(rules, /\.new-session-context \{\s*display: inline-block;\s*max-width: calc\(100% \+ 10px\);\s*margin: 5px 0 5px -10px;\s*vertical-align: middle;/);
  assert.match(rules, /@media \(pointer: coarse\) \{[^@]*?\.new-session-context \{\s*margin-top: 2px;\s*margin-bottom: 2px;/);
  assert.doesNotMatch(rules, /@container|container-type/);
  // The bar's chips keep the UI font: only the brand and the versions are in code type.
  assert.equal((rules.match(/font-family: var\(--font-mono\);/g) ?? []).length, 2);
  // The chips keep the composer's controls' look.
  assert.match(rules, /\.project-picker \{\s*display: flex;\s*align-items: center;\s*gap: 4px;\s*min-width: 0;\s*box-sizing: border-box;\s*font-size: 12\.5px;\s*font-weight: 500;\s*line-height: 1;/);
  assert.match(rules, /\.project-picker-button \{[^}]*height: 30px;\s*padding: 0 10px;\s*border: 1px solid transparent;\s*border-radius: 9px;\s*background: transparent;\s*color: var\(--text-muted\);/);
  assert.match(rules, /\.project-picker-button:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
  // On a narrow row a long branch name is cut before the project's name,
  // down to the worktree button's icons. The bar is as wide as its chips, so
  // no cap may be a share of its width: 60% of a lone project button (a repo
  // subdirectory has no worktree list) left its name 0px wide.
  assert.match(rules, /\.project-picker-button\.is-project \{\s*flex-shrink: 0;\s*max-width: 100%;\s*\}/);
  assert.match(rules, /\.project-picker\.is-inline \.project-picker-button\.is-project:not\(:only-of-type\) \{\s*max-width: calc\(100% - 66px\);\s*\}/);
  assert.match(rules, /\.project-picker\.is-inline \.project-picker-button:not\(\.is-project\) \{\s*min-width: 57px;\s*\}/);
  assert.doesNotMatch(rules.slice(0, rules.indexOf(".project-picker.is-stacked {")), /max-width: [1-9]\d?%/);
  assert.match(rules, /@media \(pointer: coarse\) \{\s*\.project-picker-button \{\s*min-height: 36px;/);
});
