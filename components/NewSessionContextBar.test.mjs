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
    onOpenFolder: noop,
    onRefreshWorktrees: noop,
    onCreateWorktree: async () => ({ error: "unused" }),
    ...props,
  })));
}

test("the bar shows the project and the worktree in use as two menu buttons", () => {
  const html = render();
  assert.match(html, /^<div class="new-session-context" style="padding-left:16px;padding-right:52px">/);
  assert.match(html, /<div class="new-session-context-row" role="group" aria-label="New session location">/);
  assert.match(html, /<button type="button" class="new-session-context-button is-project" title="\/work\/app" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="new-session-context-label">app<\/span>/);
  assert.match(html, /<button type="button" class="new-session-context-button" title="Worktree: \/work\/app-worktrees\/feature" aria-haspopup="menu" aria-expanded="false">/);
  assert.match(html, /<span class="new-session-context-label">feature\/x<\/span>/);
  // One type for both: the branch is not set in code type.
  assert.doesNotMatch(html, /is-mono/);
  assert.match(html, /<span class="new-session-context-divider" aria-hidden="true"><\/span>/);
  // Phones keep the composer's own side padding.
  assert.match(render({ mobile: true }), /^<div class="new-session-context" style="padding-left:16px;padding-right:16px">/);
});

test("the worktree button needs a worktree list: a non-git folder or a subdirectory has none", () => {
  const html = render({ context: { ...context, cwd: "/work/app/sub", project: { key: "/work/app/sub", root: "/work/app/sub" }, worktrees: null, currentWorktreePath: null } });
  assert.match(html, /<span class="new-session-context-label">sub<\/span>/);
  assert.doesNotMatch(html, /Worktree:|new-session-context-divider/);
  assert.equal((html.match(/aria-haspopup="menu"/g) ?? []).length, 1);
  // The main checkout shows its branch; a detached one its folder.
  assert.match(render({ context: { ...context, currentWorktreePath: "/work/app" } }), /context-label">main<\/span>/);
  assert.match(
    render({ context: { ...context, worktrees: [{ path: "/work/app", branch: null, isMain: true }], currentWorktreePath: "/work/app" } }),
    /title="Worktree: \/work\/app"[^>]*>[\s\S]*?context-label">app<\/span>/,
  );
});

test("picking where the composer already is changes nothing", () => {
  const projects = source.slice(source.indexOf("const projectItems"), source.indexOf("const worktreeItems"));
  assert.match(projects, /checked: choice\.key === context\.project\.key,/);
  assert.match(projects, /if \(choice\.key !== context\.project\.key\) onPick\(\{ cwd: choice\.root, projectKey: choice\.key, projectRoot: choice\.root \}, "project"\);/);
  assert.match(projects, /label: t\("sidebar\.openOtherProject"\),[\s\S]*?onSelect: \(\) => onOpenFolder\(menu\?\.opener \?\? null\),/);
  const worktrees = source.slice(source.indexOf("const worktreeItems"), source.indexOf("let menuTitle"));
  assert.match(worktrees, /checked: worktree\.path === current\?\.path,/);
  assert.match(worktrees, /if \(worktree\.path !== current\?\.path\) \{\s*onPick\(\{ cwd: worktree\.path, projectKey: context\.project\.key, projectRoot: context\.project\.root \}, "worktree"\);/);
  assert.match(worktrees, /onSelect: \(\{ keepOpen \}\) => \{\s*keepOpen\(\);/);
  // Opening the worktree menu lists the worktrees again.
  assert.match(source, /if \(kind === "worktree"\) onRefreshWorktrees\(\);/);
});

test("a created worktree starts the session only while its form is still open", () => {
  const create = source.slice(source.indexOf("const createWorktree = async"), source.indexOf("const projectItems"));
  const mounted = create.indexOf("if (!mountedRef.current) return;");
  const error = create.indexOf('if ("error" in result) {');
  const open = create.indexOf("if (menuRef.current?.form?.token !== token) return;");
  const pick = create.indexOf('onPickRef.current({ cwd: result.path, projectKey: project.key, projectRoot: project.root }, "worktree");');
  assert.ok(mounted >= 0 && mounted < error && error < open && open < pick, "mounted, error shown, form still open, then the move");
  assert.match(source, /const onPickRef = useRef\(onPick\);\s*onPickRef\.current = onPick;/);
});

test("the control a move came from takes focus in the bar of the new composer", () => {
  assert.match(source, /const from = initialFocusRef\.current;\s*if \(!from\) return;\s*initialFocusRef\.current = null;\s*onInitialFocusDoneRef\.current\(\);\s*focusIfLost\(document, \(from === "worktree" \? worktreeRef\.current : null\) \?\? projectRef\.current\);/);
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
  assert.match(rules, /\.new-session-context-button:focus-visible \{\s*outline: 2px solid var\(--accent\);/);
  // On a narrow row a long branch name is cut before the project's name.
  assert.match(rules, /\.new-session-context-button\.is-project \{\s*flex-shrink: 0;\s*max-width: 60%;/);
  assert.match(rules, /@media \(pointer: coarse\) \{\s*\.new-session-context-button \{\s*min-height: 36px;/);
});
