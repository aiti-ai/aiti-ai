/**
 * PathBreadcrumb — a path bar with Windows Explorer behavior:
 *
 * - Display mode: every folder segment is a button (click = navigate to that level),
 *   the free space to their right is an "edit" hot area, and a copy button sits at the end.
 * - Edit mode: the same field becomes a text input, selected as a whole (copy/paste as
 *   usual). Enter commits, Escape reverts (and only reverts: it never bubbles out to close
 *   the dialog), blur commits as Explorer does. Alt+D / Ctrl+L / F2 / Enter or typing any
 *   printable character enters edit mode, so "open the picker and type a path" still works.
 *
 * Pure split logic lives in ./path-crumbs.ts (unit tested); this file is presentation plus
 * focus/commit plumbing. Consumers: directory pickers that want the bar (directory-picker).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { splitPathSegments } from "./path-crumbs";

export interface PathBreadcrumbProps {
  /** The current (resolved) folder — what the bar shows in display mode. */
  value: string;
  /** Accessible name of the bar (e.g. "Directory path"). */
  label: string;
  /** Accessible name/tooltip of the edit hot area. */
  editLabel: string;
  /** Optional hint under the edit hot area's tooltip. */
  editHint?: string;
  /** Accessible name/tooltip of the copy button. */
  copyLabel: string;
  /** Shown for ~1.2s after a successful copy. */
  copiedLabel: string;
  placeholder?: string;
  /** Busy: segments and the edit hot area stop responding (the field stays readable). */
  disabled?: boolean;
  /** Focus the bar on mount (typing then enters edit mode directly). */
  autoFocus?: boolean;
  /** Navigate to an absolute path (segment click, Enter in edit mode, blur commit). */
  onNavigate: (path: string) => void;
  /** Lets the dialog disable its own actions while the field is being edited. */
  onEditingChange?: (editing: boolean) => void;
  style?: CSSProperties;
}

const BOX: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  minWidth: 0,
  height: 36,
  padding: "0 4px 0 6px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  boxSizing: "border-box",
};

const SEGMENT: CSSProperties = {
  minWidth: 22,
  maxWidth: 240,
  height: 24,
  padding: "0 4px",
  border: 0,
  borderRadius: 4,
  background: "none",
  color: "var(--text-muted)",
  font: "inherit",
  cursor: "pointer",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ICON_BUTTON: CSSProperties = {
  flexShrink: 0,
  width: 24,
  height: 24,
  padding: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: 0,
  borderRadius: 4,
  background: "none",
  color: "var(--text-dim)",
  cursor: "pointer",
};

function CopyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.2" />
      <path d="M10.5 5.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="2.5 8.5 6 12 13.5 4" />
    </svg>
  );
}

/** Clipboard write with a pre-secure-context fallback (the picker must also work over plain http).
 *  Returns false when both paths failed, so the caller can fall back to selecting the text. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function PathBreadcrumb(props: PathBreadcrumbProps) {
  const { value, disabled = false, onNavigate } = props;
  const [editing, setEditingState] = useState(false);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hotRef = useRef<HTMLButtonElement | null>(null);
  const editingRef = useRef(false);
  const draftRef = useRef("");
  const copyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const propsRef = useRef(props);
  propsRef.current = props;

  const setEditing = useCallback((on: boolean) => {
    editingRef.current = on;
    setEditingState(on);
    propsRef.current.onEditingChange?.(on);
  }, []);

  const enterEdit = useCallback((seed?: string) => {
    if (propsRef.current.disabled) return;
    // A printable character replaces the whole path (the field's content is selected, as in
    // Explorer's address bar); Enter/Alt+D/Ctrl+L/first click just select it all.
    const next = seed !== undefined ? seed : propsRef.current.value;
    draftRef.current = next;
    setDraft(next);
    setEditing(true);
  }, [setEditing]);

  const commitEdit = useCallback(() => {
    if (!editingRef.current) return;
    const next = draftRef.current.trim();
    setEditing(false);
    if (next && next !== propsRef.current.value) propsRef.current.onNavigate(next);
  }, [setEditing]);

  const cancelEdit = useCallback(() => {
    if (!editingRef.current) return;
    setEditing(false);
  }, [setEditing]);

  // Focus and select the whole path once the input exists (Explorer: the address bar
  // content is selected, so typing replaces it and Ctrl+C copies it).
  useEffect(() => {
    if (!editing) return;
    const field = inputRef.current;
    if (!field) return;
    field.focus();
    field.select();
  }, [editing]);

  useEffect(() => {
    if (!editing && props.autoFocus) hotRef.current?.focus({ preventScroll: true });
  }, [editing, props.autoFocus]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const copyPath = useCallback(() => {
    if (!propsRef.current.value) return;
    void writeClipboard(propsRef.current.value).then((ok) => {
      if (!mountedRef.current) return;
      // Clipboard blocked (insecure origin / permission): open the field selected so the
      // user can copy with the keyboard instead of the button doing nothing.
      if (!ok) {
        enterEdit();
        return;
      }
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, 1200);
    });
  }, [enterEdit]);

  const handleBarKeyDown = (event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    preventDefault: () => void;
  }) => {
    if (editingRef.current || propsRef.current.disabled) return;
    if (event.altKey && (event.key === "d" || event.key === "D")) {
      event.preventDefault();
      enterEdit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "l" || event.key === "L")) {
      event.preventDefault();
      enterEdit();
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      enterEdit();
      return;
    }
    // Type-to-edit: one printable character starts the edit with that character, keeping
    // the picker's "open it and type a path" muscle memory without an always-on input.
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      enterEdit(event.key);
    }
  };

  const split = splitPathSegments(value);
  const copyTitle = copied ? props.copiedLabel : props.copyLabel;

  return (
    <div
      className="path-breadcrumb"
      role="group"
      aria-label={props.label}
      onKeyDown={handleBarKeyDown}
      style={{ ...BOX, ...props.style }}
      data-editing={editing ? "1" : undefined}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="path-breadcrumb-input"
          type="text"
          value={draft}
          placeholder={props.placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-label={props.label}
          onChange={(event) => {
            draftRef.current = event.target.value;
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              commitEdit();
              return;
            }
            if (event.key === "Escape") {
              // Edit mode's own Escape: revert and stay in the picker (never close it).
              event.preventDefault();
              event.stopPropagation();
              cancelEdit();
            }
          }}
          onBlur={commitEdit}
          style={{ minWidth: 0, flex: 1, height: 28, padding: "0 8px", border: 0, outline: "none", background: "transparent", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
      ) : value ? (
        <>
          {split.root && (
            <button
              type="button"
              className="path-breadcrumb-segment is-root"
              title={split.root.path}
              disabled={disabled}
              onClick={() => { if (split.root && split.root.path !== value) onNavigate(split.root.path); }}
              style={{ ...SEGMENT, flexShrink: 0, color: "var(--text-muted)" }}
            >
              {split.root.label}
            </button>
          )}
          {split.segments.map((segment, index) => {
            const last = index === split.segments.length - 1;
            // The root crumb already ends with the separator ("/" or "C:"): do not print it twice.
            const showSep = split.root ? !(index === 0 && split.root.path.endsWith(split.sep)) : false;
            return (
              <span key={segment.path} style={{ display: "inline-flex", alignItems: "center", minWidth: 0, flexShrink: last ? 1 : 100 }}>
                {showSep ? <span aria-hidden="true" style={{ flexShrink: 0, color: "var(--text-dim)" }}>{split.sep}</span> : null}
                <button
                  type="button"
                  className={`path-breadcrumb-segment${last ? " is-current" : ""}`}
                  title={segment.path}
                  disabled={disabled}
                  onClick={() => { if (segment.path !== value) onNavigate(segment.path); }}
                  style={{ ...SEGMENT, color: last ? "var(--text)" : "var(--text-muted)", fontWeight: last ? 600 : 400, maxWidth: last ? undefined : 180 }}
                >
                  {segment.label}
                </button>
              </span>
            );
          })}
          <button
            type="button"
            ref={hotRef}
            className="path-breadcrumb-edit-hot"
            aria-label={props.editLabel}
            title={props.editHint ?? props.editLabel}
            autoFocus={props.autoFocus}
            onClick={() => enterEdit()}
            style={{ flex: 1, minWidth: 18, height: "100%", padding: 0, border: 0, background: "none", cursor: "text" }}
          />
        </>
      ) : (
        <button
          type="button"
          ref={hotRef}
          className="path-breadcrumb-edit-hot"
          aria-label={props.editLabel}
          title={props.editHint ?? props.editLabel}
          autoFocus={props.autoFocus}
          onClick={() => enterEdit()}
          style={{ flex: 1, minWidth: 18, height: "100%", padding: "0 8px", border: 0, background: "none", color: "var(--text-dim)", font: "inherit", textAlign: "left", cursor: "text" }}
        >
          {props.placeholder}
        </button>
      )}
      <button
        type="button"
        className="path-breadcrumb-copy"
        aria-label={copyTitle}
        title={copyTitle}
        disabled={disabled || !value || editing}
        onClick={copyPath}
        style={{ ...ICON_BUTTON, cursor: disabled || !value || editing ? "default" : "pointer", opacity: disabled || !value ? 0.5 : 1 }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}
