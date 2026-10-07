"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { CheckIcon } from "./SidebarIcons";

/**
 * The session sidebar's popup menu: a row's ⋯ or right-click menu, a project
 * group's menu, the worktree picker. On a desktop it is a small menu placed at
 * a point or beside a button; on a phone (`sheet`) a bottom sheet over its own
 * backdrop. Either way it is portaled to `document.body`: the mobile sidebar
 * drawer moves with `transform`, which would make a `position: fixed` menu
 * inside it fixed to the 280px drawer instead of the screen.
 *
 * The menu holds no state of its own: what it shows and whether it is open
 * come from the parent, which keeps them above the virtualized rows so a row
 * scrolled out of view does not take its open menu with it.
 */

/** What an item's `onSelect` is told about the activation. */
export interface SidebarMenuSelectEvent {
  /** Shift was held (click, Enter or the item's shortcut letter): Delete skips its confirmation. */
  shiftKey: boolean;
  /**
   * Leaves the menu open instead of closing it after `onSelect`: for an item
   * that swaps the menu's body, such as "New worktree…" turning the worktree
   * picker into a small form.
   */
  keepOpen(): void;
}

export type SidebarMenuItem =
  | {
      type: "item";
      id: string;
      label: string;
      icon?: ReactNode;
      /** One letter that activates the item while the menu has focus. */
      shortcut?: string;
      /** Right-aligned hint shown instead of the shortcut (a worktree's "main"). */
      note?: string;
      /** A choice: shows a check mark (true) or an empty slot (false) instead of `icon`. */
      checked?: boolean;
      mono?: boolean;
      danger?: boolean;
      disabled?: boolean;
      /** Shown on the right of a disabled item, in place of its shortcut. */
      disabledReason?: string;
      onSelect: (event: SidebarMenuSelectEvent) => void;
    }
  | { type: "separator"; id: string }
  | { type: "header"; id: string; label: string };

export type SidebarMenuAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; rect: { left: number; top: number; right: number; bottom: number }; align: "start" | "end" };

export type SidebarMenuCloseReason = "escape" | "outside" | "select" | "cancel";

export interface SidebarMenuProps {
  open: boolean;
  anchor: SidebarMenuAnchor | null;
  /** True on a phone (≤640px): a bottom sheet with its own backdrop. */
  sheet: boolean;
  ariaLabel: string;
  /** The sheet's heading (one line, ellipsis). */
  title?: string;
  items?: SidebarMenuItem[];
  /** A custom body (a small form) instead of `items`. */
  children?: ReactNode;
  /** The sheet's Cancel button. */
  cancelLabel: string;
  /** Tab out of the menu reports "outside". */
  onClose: (reason: SidebarMenuCloseReason) => void;
  /**
   * Focus goes back here on close when it was inside the menu or fell to
   * `<body>`. Read when the menu opens: the parent may let go of it before
   * the menu has closed.
   */
  returnFocusTo?: HTMLElement | null;
  /** Desktop width in px. */
  width?: number;
}

type ActionItem = Extract<SidebarMenuItem, { type: "item" }>;

/** Distance the menu keeps from the edges of the visible viewport. */
const MENU_MARGIN = 8;
/** Gap between a button and the menu it opened. */
const ANCHOR_GAP = 4;
const DEFAULT_MENU_WIDTH = 208;

const ITEM_SELECTOR = "[data-sidebar-menu-item]";
const FOCUSABLE_SELECTOR = "button, input, textarea, select, a[href], [tabindex]";
/** A row of the session tree (components/SessionTree.tsx), where most openers sit. */
const ROW_SELECTOR = "[data-row-key]";

export interface SidebarMenuViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a desktop menu of `size` goes, in viewport coordinates. A point (a
 * right-click) opens the menu at the pointer, to its left or above it when it
 * does not fit, like a native context menu. A button's rect opens it below,
 * lined up with the button's left (`start`) or right (`end`) edge, and above
 * the button when there is no room below but there is above. Whatever is left
 * over is clamped into the viewport, `MENU_MARGIN` from its edges.
 */
export function placeSidebarMenu(
  anchor: SidebarMenuAnchor,
  size: { width: number; height: number },
  viewport: SidebarMenuViewport,
  margin = MENU_MARGIN,
): { left: number; top: number } {
  const minLeft = viewport.left + margin;
  const minTop = viewport.top + margin;
  const maxRight = viewport.left + viewport.width - margin;
  const maxBottom = viewport.top + viewport.height - margin;
  let left: number;
  let top: number;
  if (anchor.kind === "point") {
    left = anchor.x + size.width > maxRight && anchor.x - size.width >= minLeft ? anchor.x - size.width : anchor.x;
    top = anchor.y + size.height > maxBottom && anchor.y - size.height >= minTop ? anchor.y - size.height : anchor.y;
  } else {
    const { rect } = anchor;
    left = anchor.align === "end" ? rect.right - size.width : rect.left;
    const below = rect.bottom + ANCHOR_GAP;
    const above = rect.top - ANCHOR_GAP - size.height;
    top = below + size.height > maxBottom && above >= minTop ? above : below;
  }
  return {
    left: Math.max(minLeft, Math.min(left, maxRight - size.width)),
    top: Math.max(minTop, Math.min(top, maxBottom - size.height)),
  };
}

/**
 * The enabled item a typed letter activates: its `shortcut`, case-insensitive
 * (Shift+D still means D, and tells Delete to skip its confirmation).
 */
export function findSidebarMenuShortcut(items: readonly SidebarMenuItem[] | undefined, key: string): ActionItem | null {
  if (!items || key.length !== 1) return null;
  const wanted = key.toLowerCase();
  for (const item of items) {
    if (item.type === "item" && !item.disabled && item.shortcut && item.shortcut.toLowerCase() === wanted) return item;
  }
  return null;
}

/** A field the keys belong to: arrows move its caret, letters are typed into it. */
function isTextEntry(element: Element | null): boolean {
  if (!element) return false;
  if ((element as HTMLElement).isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = ((element as HTMLInputElement).type || "text").toLowerCase();
  return !["button", "checkbox", "radio", "range", "reset", "submit", "image", "color", "file"].includes(type);
}

/** Laid out: not display: none itself or inside something that is. Only such an element takes focus. */
function isRendered(element: HTMLElement): boolean {
  return element.getClientRects().length > 0;
}

function isFocusable(element: HTMLElement): boolean {
  if ((element as HTMLButtonElement).disabled) return false;
  if (element.getAttribute("aria-disabled") === "true") return false;
  return isRendered(element);
}

/**
 * Where focus goes back to when a menu closes: its opener, while it is on the
 * page and rendered. A tree row's ⋯ (a group's + and ⋯ too) shows only while
 * the row is hovered, selected, holds keyboard focus or has its menu open, so
 * once the menu has closed it can be display: none, and focus() on it would
 * do nothing: focus would fall to `<body>`. The first control of the opener's
 * row that can take focus (its main button, a group's toggle) does instead.
 */
export function menuFocusReturnTarget(opener: HTMLElement | null): HTMLElement | null {
  if (!opener || !opener.isConnected) return null;
  if (isRendered(opener)) return opener;
  const row = opener.closest(ROW_SELECTOR);
  if (!row) return null;
  for (const control of Array.from(row.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))) {
    if (control.tabIndex >= 0 && isFocusable(control)) return control;
  }
  return null;
}

function enabledItems(surface: HTMLElement): HTMLElement[] {
  return Array.from(surface.querySelectorAll<HTMLElement>(ITEM_SELECTOR)).filter(isFocusable);
}

/** What focus goes to when the menu opens: the first enabled item, or the custom body's first control. */
function initialFocusTarget(surface: HTMLElement): HTMLElement | null {
  const items = enabledItems(surface);
  if (items.length > 0) return items[0];
  const controls = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element.tabIndex >= 0 && isFocusable(element));
  return controls[0] ?? null;
}

/**
 * Whether Tab (or Shift+Tab) from `active` takes focus out of the menu: no
 * tabbable element of the menu follows it (precedes it). Items themselves are
 * not tabbable (arrows move between them), so Tab from an item leaves a plain
 * menu, while a form inside one (or the sheet's Cancel) keeps its own order.
 */
function tabLeavesSurface(surface: HTMLElement, active: Element, backwards: boolean): boolean {
  const tabbables = Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => element !== active && element.tabIndex >= 0 && isFocusable(element));
  const direction = backwards ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  return !tabbables.some((element) => (active.compareDocumentPosition(element) & direction) !== 0);
}

/**
 * The opener was pressed while its menu was open: that press closed the menu,
 * and its click must not open it again. Without this a second click on ⋯
 * would close and reopen the menu instead of closing it.
 */
function swallowNextClickOn(element: HTMLElement): void {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return;
  let timer = 0;
  const stop = () => {
    doc.removeEventListener("click", onClick, true);
    view.clearTimeout(timer);
  };
  function onClick(event: MouseEvent) {
    stop();
    if (!(event.target instanceof Node) || !element.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }
  doc.addEventListener("click", onClick, true);
  timer = view.setTimeout(stop, 1000);
}

/**
 * The portal is outside the sidebar in the page, but React still bubbles its
 * events to the components that rendered it: a click on an item would reach
 * the session row underneath in the component tree and select it. Events stop
 * at the menu.
 */
function stopReactPropagation(event: SyntheticEvent) {
  event.stopPropagation();
}

function stopContextMenu(event: SyntheticEvent) {
  event.preventDefault();
  event.stopPropagation();
}

const isolateEvents = {
  onClick: stopReactPropagation,
  onDoubleClick: stopReactPropagation,
  onMouseDown: stopReactPropagation,
  onMouseUp: stopReactPropagation,
  onPointerDown: stopReactPropagation,
  onPointerUp: stopReactPropagation,
  onKeyDown: stopReactPropagation,
  onKeyUp: stopReactPropagation,
  onFocus: stopReactPropagation,
  onBlur: stopReactPropagation,
  onContextMenu: stopContextMenu,
};

export interface SidebarMenuSurfaceProps {
  sheet: boolean;
  ariaLabel: string;
  title?: string;
  items?: SidebarMenuItem[];
  children?: ReactNode;
  cancelLabel: string;
  width?: number;
  surfaceRef?: Ref<HTMLDivElement>;
  onActivate: (item: ActionItem, shiftKey: boolean) => void;
  onClose: (reason: "outside" | "cancel") => void;
}

function MenuItemButton({ item, onActivate }: { item: ActionItem; onActivate: SidebarMenuSurfaceProps["onActivate"] }) {
  const choice = item.checked !== undefined;
  const className = [
    "sidebar-menu-item",
    item.danger ? "is-danger" : "",
    item.checked ? "is-checked" : "",
  ].filter(Boolean).join(" ");
  let trailing: ReactNode = null;
  if (item.disabled && item.disabledReason) {
    trailing = <span className="sidebar-menu-note">{item.disabledReason}</span>;
  } else if (item.note) {
    trailing = <span className="sidebar-menu-note">{item.note}</span>;
  } else if (item.shortcut) {
    trailing = <kbd className="sidebar-menu-shortcut">{item.shortcut}</kbd>;
  }
  return (
    <button
      type="button"
      role={choice ? "menuitemradio" : "menuitem"}
      aria-checked={choice ? item.checked : undefined}
      aria-disabled={item.disabled ? true : undefined}
      aria-keyshortcuts={item.shortcut && !item.disabled ? item.shortcut.toUpperCase() : undefined}
      tabIndex={-1}
      data-sidebar-menu-item=""
      className={className}
      onClick={(event) => onActivate(item, event.shiftKey)}
      onKeyDown={(event) => {
        // Enter is taken here rather than left to the button's click, which
        // would not say whether Shift was held.
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        onActivate(item, event.shiftKey);
      }}
    >
      <span className="sidebar-menu-icon">
        {choice ? (item.checked ? <CheckIcon size={13} /> : null) : item.icon}
      </span>
      <span className={item.mono ? "sidebar-menu-label is-mono" : "sidebar-menu-label"}>{item.label}</span>
      {trailing}
    </button>
  );
}

/**
 * The menu or sheet itself, without the portal, placement, focus or key
 * handling `SidebarMenu` adds around it.
 */
export function SidebarMenuSurface({
  sheet,
  ariaLabel,
  title,
  items,
  children,
  cancelLabel,
  width = DEFAULT_MENU_WIDTH,
  surfaceRef,
  onActivate,
  onClose,
}: SidebarMenuSurfaceProps) {
  const custom = children !== undefined && children !== null && children !== false;
  const body = custom ? children : (items ?? []).map((item) => {
    if (item.type === "separator") return <div key={item.id} className="sidebar-menu-separator" role="separator" />;
    if (item.type === "header") return <div key={item.id} className="sidebar-menu-header" role="presentation">{item.label}</div>;
    return <MenuItemButton key={item.id} item={item} onActivate={onActivate} />;
  });

  if (!sheet) {
    return (
      <div
        ref={surfaceRef}
        className="sidebar-menu"
        role={custom ? "dialog" : "menu"}
        aria-label={ariaLabel}
        style={{ width }}
        {...isolateEvents}
      >
        {body}
      </div>
    );
  }

  return (
    <div className="sidebar-sheet-layer" {...isolateEvents}>
      {/* The backdrop takes the tap that closes the sheet, so it reaches neither the
          drawer's own backdrop (which would close the sidebar) nor a row. */}
      <div className="sidebar-sheet-backdrop" aria-hidden="true" onClick={() => onClose("outside")} />
      <div ref={surfaceRef} className="sidebar-sheet" role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {title ? <div className="sidebar-sheet-title">{title}</div> : null}
        {custom ? (
          <div className="sidebar-sheet-body">{body}</div>
        ) : (
          <div className="sidebar-sheet-body" role="menu" aria-label={ariaLabel}>{body}</div>
        )}
        <button type="button" className="sidebar-sheet-cancel" onClick={() => onClose("cancel")}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}

export function SidebarMenu({
  open,
  anchor,
  sheet,
  ariaLabel,
  title,
  items,
  children,
  cancelLabel,
  onClose,
  returnFocusTo,
  width,
}: SidebarMenuProps) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // The latest props for listeners attached once per opening.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const returnFocusToRef = useRef(returnFocusTo ?? null);
  returnFocusToRef.current = returnFocusTo ?? null;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  const visible = open && portalTarget !== null && (sheet || anchor !== null);
  const custom = children !== undefined && children !== null && children !== false;
  const anchorKey = anchor ? JSON.stringify(anchor) : "";

  const activate = (item: ActionItem, shiftKey: boolean) => {
    if (item.disabled) return;
    let keepOpen = false;
    item.onSelect({ shiftKey, keepOpen: () => { keepOpen = true; } });
    if (!keepOpen) onCloseRef.current("select");
  };
  const activateRef = useRef(activate);
  activateRef.current = activate;

  // Desktop placement: measure, then place, before the browser paints.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!visible || sheet || !surface) return;
    const viewport = window.visualViewport;
    const position = () => {
      const current = anchorRef.current;
      if (!current) return;
      const rect = surface.getBoundingClientRect();
      const { left, top } = placeSidebarMenu(current, { width: rect.width, height: rect.height }, {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      });
      surface.style.left = `${left}px`;
      surface.style.top = `${top}px`;
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(surface);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [visible, sheet, anchorKey, custom]);

  // Focus moves into the menu when it opens, and again when its body is
  // swapped (the worktree picker turning into its form).
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!visible || !surface) return;
    initialFocusTarget(surface)?.focus({ preventScroll: true });
  }, [visible, sheet, custom]);

  // On close, focus returns to the opener unless the user put it elsewhere.
  // The opener is taken now, as the menu opens: the parent closes it by
  // dropping its state, `returnFocusTo` included, before this cleanup runs.
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!visible || !surface) return;
    const opener = returnFocusToRef.current;
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && !surface.contains(active)) return;
      const target = menuFocusReturnTarget(opener);
      if (!target) return;
      target.focus({ preventScroll: true });
      // Keyboard focus on the row's main button shows its actions again
      // (:has(:focus-visible) in app/sidebar.css): the opener is back, so it
      // takes focus, as if it had never been hidden.
      if (opener && target !== opener && isRendered(opener)) opener.focus({ preventScroll: true });
    };
  }, [visible, sheet]);

  // Keys, in the capture phase on `document`: they reach the menu before any
  // bubble-phase listener, including the window-level Escape that stops a
  // running agent (hooks/useKeyboardShortcuts.ts), which skips an Escape
  // marked handled.
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const surface = surfaceRef.current;
      if (!surface || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current("escape");
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const inside = target !== null && surface.contains(target);
      const onPage = target === null || target === document.body || target === document.documentElement;
      if (!inside && !onPage) return;
      if (event.key === "Tab") {
        // No focus trap: Tab out of the menu closes it, and focus goes on from the opener.
        if (!inside || tabLeavesSurface(surface, target as Element, event.shiftKey)) onCloseRef.current("outside");
        return;
      }
      if (inside && isTextEntry(target)) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
        const list = enabledItems(surface);
        if (list.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const index = target ? list.indexOf(target as HTMLElement) : -1;
        let next: number;
        if (event.key === "Home") next = 0;
        else if (event.key === "End") next = list.length - 1;
        else if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % list.length;
        else next = index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length;
        list[next].focus({ preventScroll: false });
        return;
      }
      if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
      const item = findSidebarMenuShortcut(itemsRef.current, event.key);
      if (!item || custom) return;
      event.preventDefault();
      event.stopPropagation();
      activateRef.current(item, event.shiftKey);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [visible, custom]);

  // A press anywhere else closes a desktop menu and goes on to whatever it was
  // on (another row is selected by the same click). The sheet's backdrop
  // closes the sheet instead.
  useEffect(() => {
    if (!visible || sheet) return;
    const onPointerDown = (event: PointerEvent) => {
      const surface = surfaceRef.current;
      const target = event.target instanceof Node ? event.target : null;
      if (!surface || (target && surface.contains(target))) return;
      const opener = returnFocusToRef.current;
      if (opener && target && event.button === 0 && opener.contains(target)) swallowNextClickOn(opener);
      onCloseRef.current("outside");
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [visible, sheet]);

  if (!visible || !portalTarget) return null;

  return createPortal(
    <SidebarMenuSurface
      sheet={sheet}
      ariaLabel={ariaLabel}
      title={title}
      items={items}
      cancelLabel={cancelLabel}
      width={width}
      surfaceRef={surfaceRef}
      onActivate={(item, shiftKey) => activateRef.current(item, shiftKey)}
      onClose={(reason) => onCloseRef.current(reason)}
    >
      {children}
    </SidebarMenuSurface>,
    portalTarget,
  );
}
