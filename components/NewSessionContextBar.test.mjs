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
  assert.match(html, /^<div class="new-session-context" style="padding-left:16px;padding-right:52px"><div class="project-picker is-inline" role="group" aria-label="New session location">/);
  assert.match(html, /<button type="button" class="project-picker-button is-project" title="\/work\/app" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="project-picker-label">app<\/span>/);
  assert.match(html, /<button type="button" class="project-picker-button" title="Worktree: \/work\/app-worktrees\/feature" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="project-picker-label">feature\/x<\/span>/);
  // One type for both: the branch is not set in code type.
  assert.doesNotMatch(html, /is-mono/);
  assert.match(html, /<span class="project-picker-divider" aria-hidden="true"><\/span>/);
  // Phones keep the composer's own side padding.
  assert.match(render({ mobile: true }), /^<div class="new-session-context" style="padding-left:16px;padding-right:16px">/);
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

test("the bar sits between the empty page's hero and the composer, only while it is empty", () => {
  const slot = chatWindowSource.indexOf("{isEmptyNew && newSessionContextBar}");
  assert.ok(slot > chatWindowSource.indexOf('<Image src="/icons/apple-touch-icon.png"'));
  assert.ok(slot < chatWindowSource.indexOf("{chatInputElement}", slot));
  assert.equal(chatWindowSource.indexOf("{chatInputElement}", slot) - slot, "{isEmptyNew && newSessionContextBar}\n        ".length);
});

test("client code stays parseable by Safari 16.2 and its CSS flat", () => {
  for (const file of [source, contextSource]) {
    assert.doesNotMatch(file, /\(\?<[=!]/, "no RegExp lookbehind");
  }
  const rules = css.slice(css.indexOf(".new-session-context {"), css.indexOf(".file-viewer-icon-button {"));
  assert.doesNotMatch(rules.replace(/@media[^{]*\{/g, ""), /\{[^}]*\{|&/, "no nested rules");
  // The chips keep the composer's controls' look.
  assert.match(rules, /\.new-session-context > \.project-picker \{\s*max-width: var\(--chat-content-max-width, 820px\);\s*margin: 0 auto;\s*padding: 0 4px;/);
  assert.match(rules, /\.project-picker \{\s*display: flex;\s*align-items: center;\s*gap: 4px;\s*min-width: 0;\s*box-sizing: border-box;\s*font-size: 12\.5px;\s*font-weight: 500;\s*line-height: 1;/);
  assert.match(rules, /\.project-picker-button \{[^}]*height: 30px;\s*padding: 0 10px;\s*border: 1px solid transparent;\s*border-radius: 9px;\s*background: transparent;\s*color: var\(--text-muted\);/);
  assert.match(rules, /\.project-picker-button:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
  // On a narrow row a long branch name is cut before the project's name.
  assert.match(rules, /\.project-picker-button\.is-project \{\s*flex-shrink: 0;\s*max-width: 60%;/);
  assert.match(rules, /@media \(pointer: coarse\) \{\s*\.project-picker-button \{\s*min-height: 36px;/);
});
