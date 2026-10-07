import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SidebarMenu, SidebarMenuSurface, placeSidebarMenu, findSidebarMenuShortcut, menuFocusReturnTarget } = await jiti.import("./SidebarMenu.tsx");
const { SpinnerIcon, MoreIcon, PinIcon } = await jiti.import("./SidebarIcons.tsx");
const source = await readFile(new URL("./SidebarMenu.tsx", import.meta.url), "utf8");
const iconSource = await readFile(new URL("./SidebarIcons.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/sidebar-menu.css", import.meta.url), "utf8");

const h = React.createElement;

function decode(html) {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule not found`);
  return match[1];
}

const noop = () => {};
const items = [
  { type: "header", id: "head", label: "New session in which worktree?" },
  { type: "item", id: "pin", label: "Pin", icon: h(PinIcon), shortcut: "P", onSelect: noop },
  { type: "item", id: "main", label: "main", mono: true, note: "main", checked: true, onSelect: noop },
  { type: "item", id: "feature", label: "feature/x", mono: true, checked: false, title: "/work/app-worktrees/feature-x", onSelect: noop },
  { type: "item", id: "archive", label: "Archive", shortcut: "A", disabled: true, disabledReason: "Running", onSelect: noop },
  { type: "separator", id: "sep" },
  { type: "item", id: "delete", label: "Delete…", shortcut: "D", danger: true, onSelect: noop },
];

function surface(props = {}) {
  return decode(renderToStaticMarkup(h(SidebarMenuSurface, {
    sheet: false,
    ariaLabel: "Session actions",
    items,
    cancelLabel: "Cancel",
    onActivate: noop,
    onClose: noop,
    ...props,
  })));
}

test("the menu waits for the client before portaling, so server markup is empty", () => {
  const html = renderToStaticMarkup(h(SidebarMenu, {
    open: true,
    anchor: { kind: "point", x: 10, y: 10 },
    sheet: false,
    ariaLabel: "Session actions",
    items,
    cancelLabel: "Cancel",
    onClose: noop,
  }));
  assert.equal(html, "");
  assert.match(source, /const \[portalTarget, setPortalTarget\] = useState<HTMLElement \| null>\(null\);/);
  assert.match(source, /useEffect\(\(\) => \{\s*setPortalTarget\(document\.body\);\s*\}, \[\]\);/);
  assert.match(source, /return createPortal\(\s*<SidebarMenuSurface[\s\S]*?portalTarget,\s*\);/);
});

test("desktop menu markup: menu roles, check marks, shortcuts, notes and disabled reasons", () => {
  const html = surface();
  assert.match(html, /^<div class="sidebar-menu" role="menu" aria-label="Session actions" style="width:208px">/);
  assert.match(html, /<div class="sidebar-menu-header" role="presentation">New session in which worktree\?<\/div>/);
  assert.match(html, /<div class="sidebar-menu-separator" role="separator"><\/div>/);

  const pin = html.match(/<button[^>]*>(?:(?!<\/button>).)*Pin(?:(?!<\/button>).)*<\/button>/)?.[0] ?? "";
  assert.match(pin, /role="menuitem"/);
  assert.match(pin, /tabindex="-1"/);
  assert.match(pin, /aria-keyshortcuts="P"/);
  assert.match(pin, /<kbd class="sidebar-menu-shortcut">P<\/kbd>/);
  assert.match(pin, /<span class="sidebar-menu-icon"><svg[^>]*aria-hidden="true"/);

  const main = html.match(/<button[^>]*aria-checked="true"[^>]*>.*?<\/button>/)?.[0] ?? "";
  assert.match(main, /role="menuitemradio"/);
  assert.match(main, /class="sidebar-menu-item is-checked"/);
  assert.match(main, /<span class="sidebar-menu-label is-mono">main<\/span>/);
  assert.match(main, /<span class="sidebar-menu-note">main<\/span>/);
  assert.match(main, /<path d="M20 6 9 17l-5-5"><\/path>/, "a checked choice shows the check mark");

  const feature = html.match(/<button[^>]*aria-checked="false"[^>]*>.*?<\/button>/)?.[0] ?? "";
  assert.match(feature, /role="menuitemradio"/);
  assert.match(feature, /<span class="sidebar-menu-icon"><\/span>/, "an unchecked choice keeps an empty slot");
  assert.match(feature, /title="\/work\/app-worktrees\/feature-x"/, "a tooltip shows what the label shortens");
  assert.doesNotMatch(main, /title=/);

  const archive = html.match(/<button[^>]*aria-disabled="true"[^>]*>.*?<\/button>/)?.[0] ?? "";
  assert.match(archive, /Archive/);
  assert.match(archive, /<span class="sidebar-menu-note">Running<\/span>/);
  assert.doesNotMatch(archive, /sidebar-menu-shortcut|aria-keyshortcuts/, "the reason replaces the shortcut");

  assert.match(html, /<button[^>]*class="sidebar-menu-item is-danger"[^>]*>.*?Delete…/);
  assert.equal((html.match(/data-sidebar-menu-item=""/g) ?? []).length, 5);
});

test("desktop width is configurable and a custom body is a dialog, not a menu", () => {
  const html = surface({ width: 240, children: h("form", null, h("input", { placeholder: "Branch name" })) });
  assert.match(html, /^<div class="sidebar-menu" role="dialog" aria-label="Session actions" style="width:240px">/);
  assert.match(html, /<form><input placeholder="Branch name"\/><\/form>/);
  assert.doesNotMatch(html, /role="menuitem"/);
});

test("the mobile sheet has its own backdrop, a title, the items and a Cancel button", () => {
  const html = surface({ sheet: true, title: "A very long session title" });
  assert.match(html, /^<div class="sidebar-sheet-layer"><div class="sidebar-sheet-backdrop" aria-hidden="true"><\/div>/);
  assert.match(html, /<div class="sidebar-sheet" role="dialog" aria-modal="true" aria-label="Session actions">/);
  assert.match(html, /<div class="sidebar-sheet-title">A very long session title<\/div>/);
  assert.match(html, /<div class="sidebar-sheet-body" role="menu" aria-label="Session actions">/);
  assert.match(html, /<button type="button" class="sidebar-sheet-cancel">Cancel<\/button><\/div><\/div>$/);
  assert.doesNotMatch(html, /style="width/, "the sheet is full width");

  const form = surface({ sheet: true, children: h("input", { "aria-label": "Branch" }) });
  assert.match(form, /<div class="sidebar-sheet-body"><input aria-label="Branch"\/><\/div>/);
});

test("desktop placement: at a point, flipping like a native context menu, then clamped", () => {
  const viewport = { left: 0, top: 0, width: 1000, height: 800 };
  const size = { width: 200, height: 180 };
  assert.deepEqual(placeSidebarMenu({ kind: "point", x: 100, y: 120 }, size, viewport), { left: 100, top: 120 });
  assert.deepEqual(placeSidebarMenu({ kind: "point", x: 900, y: 700 }, size, viewport), { left: 700, top: 520 });
  // No room on either side: clamped 8px inside the viewport.
  assert.deepEqual(placeSidebarMenu({ kind: "point", x: 150, y: 100 }, size, { left: 0, top: 0, width: 300, height: 250 }), { left: 92, top: 62 });
  // The visual viewport may be scrolled or zoomed inside the layout viewport.
  assert.deepEqual(placeSidebarMenu({ kind: "point", x: 0, y: 0 }, size, { left: 40, top: 300, width: 400, height: 400 }), { left: 48, top: 308 });
});

test("desktop placement: below a button, aligned by edge, flipping above when it does not fit", () => {
  const viewport = { left: 0, top: 0, width: 1000, height: 800 };
  const size = { width: 208, height: 150 };
  const rect = { left: 220, top: 100, right: 242, bottom: 122 };
  assert.deepEqual(placeSidebarMenu({ kind: "rect", rect, align: "start" }, size, viewport), { left: 220, top: 126 });
  assert.deepEqual(placeSidebarMenu({ kind: "rect", rect, align: "end" }, size, viewport), { left: 34, top: 126 });
  const low = { left: 220, top: 700, right: 242, bottom: 722 };
  assert.deepEqual(placeSidebarMenu({ kind: "rect", rect: low, align: "end" }, size, viewport), { left: 34, top: 546 });
  // A button near the left edge with end alignment is clamped to the margin.
  const edge = { left: 10, top: 100, right: 32, bottom: 122 };
  assert.deepEqual(placeSidebarMenu({ kind: "rect", rect: edge, align: "end" }, size, viewport), { left: 8, top: 126 });
  // Too tall for either side: stays below, clamped to the bottom margin.
  const tall = { width: 208, height: 700 };
  assert.deepEqual(placeSidebarMenu({ kind: "rect", rect, align: "start" }, tall, viewport), { left: 220, top: 92 });
});

test("shortcut letters find enabled items, case-insensitively", () => {
  assert.equal(findSidebarMenuShortcut(items, "p")?.id, "pin");
  assert.equal(findSidebarMenuShortcut(items, "D")?.id, "delete");
  assert.equal(findSidebarMenuShortcut(items, "a"), null, "disabled items are not activated");
  assert.equal(findSidebarMenuShortcut(items, "x"), null);
  assert.equal(findSidebarMenuShortcut(items, "Enter"), null);
  assert.equal(findSidebarMenuShortcut(undefined, "p"), null);
});

test("Escape is taken in the capture phase and marked handled, so it never also stops the agent", () => {
  assert.match(source, /document\.addEventListener\("keydown", onKeyDown, true\);/);
  assert.match(source, /document\.removeEventListener\("keydown", onKeyDown, true\);/);
  assert.match(source, /if \(!surface \|\| event\.isComposing \|\| event\.keyCode === 229\) return;/);
  assert.match(source, /if \(event\.key === "Escape"\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*onCloseRef\.current\("escape"\);/);
  // Arrow keys and shortcut letters are not stolen from a text field inside the menu.
  assert.match(source, /if \(inside && isTextEntry\(target\)\) return;/);
  assert.ok(source.indexOf("isTextEntry(target)) return;") < source.indexOf('event.key === "ArrowDown"'));
  assert.ok(source.indexOf('event.key === "ArrowDown"') < source.indexOf("findSidebarMenuShortcut(itemsRef.current, event.key)"));
  assert.match(source, /if \(event\.key\.length !== 1 \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.altKey\) return;/);
  // Enter on an item keeps Shift (Delete skips its confirmation) and ignores IME.
  assert.match(source, /if \(event\.key !== "Enter" \|\| event\.nativeEvent\.isComposing \|\| event\.keyCode === 229\) return;\s*event\.preventDefault\(\);\s*onActivate\(item, event\.shiftKey\);/);
});

test("an outside press closes a desktop menu in the capture phase without swallowing it", () => {
  assert.match(source, /document\.addEventListener\("pointerdown", onPointerDown, true\);/);
  const handler = source.slice(source.indexOf("const onPointerDown"), source.indexOf('document.addEventListener("pointerdown"'));
  assert.match(handler, /if \(!surface \|\| \(target && surface\.contains\(target\)\)\) return;/);
  assert.match(handler, /onCloseRef\.current\("outside"\);/);
  assert.doesNotMatch(handler, /preventDefault|stopPropagation/);
  assert.match(source, /if \(!visible \|\| sheet\) return;\s*const onPointerDown/);
});

test("activation calls onSelect before closing, and portal events stop at the menu", () => {
  assert.match(source, /item\.onSelect\(\{ shiftKey, keepOpen: \(\) => \{ keepOpen = true; \} \}\);\s*if \(!keepOpen\) onCloseRef\.current\("select"\);/);
  assert.match(source, /if \(item\.disabled\) return;/);
  assert.match(source, /<div className="sidebar-sheet-backdrop" aria-hidden="true" onClick=\{\(\) => onClose\("outside"\)\} \/>/);
  assert.match(source, /onClick=\{\(\) => onClose\("cancel"\)\}/);
  assert.match(source, /onClick: stopReactPropagation,/);
  assert.match(source, /onContextMenu: stopContextMenu,/);
  assert.equal((source.match(/\{\.\.\.isolateEvents\}/g) ?? []).length, 2);
});

test("focus moves into the menu on open and back to the opener on close", () => {
  assert.match(source, /initialFocusTarget\(surface\)\?\.focus\(\{ preventScroll: true \}\);/);
  // The opener is read when the menu opens: the parent closes the menu by
  // dropping its state, returnFocusTo included, before the cleanup runs.
  const restore = source.slice(source.indexOf("// On close, focus returns"), source.indexOf("// Keys, in the capture phase"));
  assert.match(restore, /if \(!visible \|\| !surface\) return;\s*const opener = returnFocusToRef\.current;\s*return \(\) => \{/);
  assert.doesNotMatch(restore.slice(restore.indexOf("return () => {")), /returnFocusToRef/);
  assert.match(restore, /if \(active && active !== document\.body && !surface\.contains\(active\)\) return;\s*const target = menuFocusReturnTarget\(opener\);\s*if \(!target\) return;\s*target\.focus\(\{ preventScroll: true \}\);/);
  assert.match(restore, /if \(opener && target !== opener && isRendered\(opener\)\) opener\.focus\(\{ preventScroll: true \}\);/);
});

/** A stand-in for an element: whether it is laid out, its row, and what it holds. */
function fakeElement({ rendered = true, connected = true, disabled = false, tabIndex = 0, children = [], row = null } = {}) {
  const element = {
    isConnected: connected,
    disabled,
    tabIndex,
    getAttribute: () => null,
    getClientRects: () => ({ length: rendered ? 1 : 0 }),
    closest: (selector) => (selector === "[data-row-key]" ? element.row : null),
    querySelectorAll: () => children,
    focus() {},
    row,
  };
  return element;
}

test("focus never goes to an opener that is hidden: the row's own button takes it", () => {
  // A rendered opener (the selected row's ⋯, a phone's) gets focus back itself.
  const shown = fakeElement();
  assert.equal(menuFocusReturnTarget(shown), shown);

  // A row's ⋯ is display: none once its menu has closed (not hovered, not selected).
  const main = fakeElement();
  const hiddenMore = fakeElement({ rendered: false });
  const row = fakeElement({ children: [main, hiddenMore] });
  hiddenMore.row = row;
  assert.equal(menuFocusReturnTarget(hiddenMore), main);

  // A group's + and ⋯ hide with their container; disabled, untabbable and hidden controls are skipped.
  const toggle = fakeElement();
  const groupRow = fakeElement({ children: [fakeElement({ disabled: true }), fakeElement({ tabIndex: -1 }), fakeElement({ rendered: false }), toggle] });
  const groupMore = fakeElement({ rendered: false, row: groupRow });
  assert.equal(menuFocusReturnTarget(groupMore), toggle);

  // Nothing to focus: no opener, an opener gone from the page, a hidden one
  // outside a row, or a row that is hidden as a whole (the tab or view went away).
  assert.equal(menuFocusReturnTarget(null), null);
  assert.equal(menuFocusReturnTarget(fakeElement({ connected: false })), null);
  assert.equal(menuFocusReturnTarget(fakeElement({ rendered: false })), null);
  const hiddenRow = fakeElement({ children: [fakeElement({ rendered: false })] });
  assert.equal(menuFocusReturnTarget(fakeElement({ rendered: false, row: hiddenRow })), null);
});

test("menu, sheet and toast styles: layers above the drawer, reduced motion", () => {
  assert.match(cssRule(".sidebar-menu"), /position: fixed;[\s\S]*z-index: 400;[\s\S]*border-radius: 8px;[\s\S]*box-shadow: 0 6px 20px rgba\(0, 0, 0, 0\.10\);/);
  assert.match(cssRule(".sidebar-sheet-backdrop"), /position: fixed;\s*inset: 0;/);
  assert.match(cssRule(".sidebar-sheet"), /position: relative;\s*z-index: 1;[\s\S]*padding: 4px 0 max\(8px, env\(safe-area-inset-bottom\)\);[\s\S]*border-radius: 12px 12px 0 0;/);
  // The sheet sits at the bottom of the visible area, which the software
  // keyboard shrinks (iOS keeps the layout viewport, and bottom: 0, under it),
  // and drops the home indicator inset the keyboard covers.
  assert.match(cssRule(".sidebar-sheet-layer"), /position: fixed;\s*top: 0;\s*right: 0;\s*left: 0;\s*z-index: 410;\s*display: flex;\s*flex-direction: column;\s*justify-content: flex-end;\s*height: var\(--app-viewport-height, 100dvh\);/);
  assert.doesNotMatch(cssRule(".sidebar-sheet"), /position: fixed|bottom: 0/);
  assert.match(cssRule("html[data-keyboard-open] .sidebar-sheet"), /padding-bottom: 8px;/);
  assert.match(cssRule(".sidebar-menu-item"), /height: 28px;/);
  assert.match(cssRule(".sidebar-sheet .sidebar-menu-item"), /height: 48px;[\s\S]*font-size: 15px;/);
  assert.match(cssRule(".sidebar-sheet .sidebar-menu-shortcut"), /display: none;/);
  assert.match(cssRule(".sidebar-spin"), /animation: spin 0\.9s linear infinite;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.sidebar-spin,\s*\.sidebar-menu,\s*\.sidebar-sheet,\s*\.sidebar-sheet-backdrop,\s*\.sidebar-toast \{\s*animation: none;/);
  // Hand-written CSS must parse on Safari 16.2: no nesting.
  assert.doesNotMatch(css, /\{[^{}]*\{[^{}]*\}[^{}]*&/);
  assert.doesNotMatch(css, /@starting-style/);
});

test("icons are decorative unless labelled, and the spinner turns through a class", () => {
  const more = renderToStaticMarkup(h(MoreIcon));
  assert.match(more, /^<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">/);
  const spinner = renderToStaticMarkup(h(SpinnerIcon, { size: 12, label: "Agent running", className: "row-status" }));
  assert.match(spinner, /width="12"/);
  assert.match(spinner, /stroke-width="2\.8"/);
  assert.match(spinner, /class="sidebar-spin row-status"/);
  assert.match(spinner, /role="img" aria-label="Agent running"/);
  assert.doesNotMatch(spinner, /aria-hidden/);
  assert.match(spinner, /<path d="M21 12a9 9 0 1 1-3\.8-7\.4"><\/path>/);
  for (const name of ["PlusIcon", "MoreIcon", "ArchiveIcon", "RestoreIcon", "PinIcon", "PinOffIcon", "ChevronIcon", "BranchIcon", "ForkIcon", "TrashIcon", "PencilIcon", "DotIcon", "DotOutlineIcon", "CheckIcon", "FolderIcon", "FolderPlusIcon", "TerminalIcon", "SearchIcon", "UploadIcon", "RefreshIcon", "ChangesIcon", "MessageIcon", "SpinnerIcon"]) {
    assert.match(iconSource, new RegExp(`export function ${name}\\(`), `${name} is exported`);
  }
});
