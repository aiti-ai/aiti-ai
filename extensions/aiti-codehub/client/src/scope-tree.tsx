/**
 * Namespace-grouped scope picker for the work-items toolbar.
 *
 * Scopes (repos / projects) are grouped under their namespace (org or personal
 * login). The personal namespace — matched against the account login — is
 * pinned to the top and tagged; other namespaces follow alphabetically.
 * Providers whose scopes carry no namespace (e.g. Yunxiao projects) fall back
 * to a plain flat list. Collapsed state persists per provider in localStorage.
 */
import { useEffect, useMemo, useRef, useState, t } from "./host-shim";
import { scopeTreeOpenKey } from "./keys";
import { Input, S, useLocaleTick } from "./ui";

export interface ScopeCount {
  open?: number;
  changed?: number;
  seenAt?: number | null;
  error?: string;
}

interface ScopeGroup {
  ns: string;
  mine: boolean;
  items: any[];
}

function labelOf(s: any): string {
  return String(s.name || s.path || s.id);
}

/** Trigger label: full path ("org/repo") when it carries namespace context. */
function pathLabelOf(s: any): string {
  const path = String(s.path || "");
  const name = String(s.name || "");
  return path && path !== name && path.includes("/") ? path : labelOf(s);
}

function buildGroups(scopes: any[], mine: string): ScopeGroup[] {
  const map = new Map<string, any[]>();
  for (const s of scopes) {
    const ns = String((s as any).namespace || "");
    let arr = map.get(ns);
    if (!arr) {
      arr = [];
      map.set(ns, arr);
    }
    arr.push(s);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === mine) return -1;
    if (b === mine) return 1;
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b);
  });
  return keys.map((ns) => ({ ns, mine: !!ns && ns === mine, items: map.get(ns)! }));
}

export function ScopeTreeSelect(p: {
  value: string;
  onChange: (id: string) => void;
  scopes: any[];
  loading?: boolean;
  /** Personal namespace (account login) — pinned first and tagged. */
  mine?: string;
  /** Scope ids shown with a ★ prefix (project favorites). */
  favorites?: string[];
  /** Collapse state persists under this provider id. */
  providerId?: string;
  /** Work-item counters per scope id (tree badges); filled in as batches arrive. */
  counts?: Record<string, ScopeCount>;
  /** Remembered-but-not-listed scope label: shown as the trigger while the item is
   * beyond the fetched page (restore-from-memory state). */
  storedLabel?: string;
  /** Fired when the popover opens (badge refresh hook). */
  onOpen?: () => void;
  style?: Record<string, unknown>;
}) {
  useLocaleTick();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* load persisted collapse state when the provider changes */
  useEffect(() => {
    if (!p.providerId) return;
    try {
      const raw = localStorage.getItem(scopeTreeOpenKey(p.providerId));
      setOpenMap(raw ? JSON.parse(raw) : {});
    } catch {
      setOpenMap({});
    }
  }, [p.providerId]);

  /* click outside does NOT close (stays open for browsing); Esc closes */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => buildGroups(p.scopes, p.mine || ""), [p.scopes, p.mine]);
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? groups
      .map((g) => ({ ...g, items: g.items.filter((s) => labelOf(s).toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length > 0)
    : groups;
  /* single anonymous group = no namespaces on this provider → flat list */
  const flat = groups.length === 1 && !groups[0].ns;

  const current = p.scopes.find((s) => String(s.id) === String(p.value));
  const currentLabel = current
    ? (p.favorites?.includes(String(current.id)) ? "★ " : "") + pathLabelOf(current)
    : p.storedLabel
      ? (p.favorites?.includes(String(p.value)) ? "★ " : "") + p.storedLabel
      : p.loading
        ? t("ch.common.loading")
        : t("ch.scope.none");

  function toggleGroup(ns: string): void {
    const collapsed = openMap[ns] !== false;
    const next = { ...openMap, [ns]: !collapsed };
    setOpenMap(next);
    try {
      localStorage.setItem(scopeTreeOpenKey(p.providerId || ""), JSON.stringify(next));
    } catch { /* ignore */ }
  }

  function toggle(): void {
    const next = !open;
    setOpen(next);
    if (next) p.onOpen?.();
  }

  function pick(id: string): void {
    p.onChange(id);
    setOpen(false);
    setFilter("");
  }

  function badge(id: string): unknown {
    const c = p.counts?.[id];
    if (!c || c.error) return null;
    const open = c.open ?? 0;
    const changed = c.changed ?? 0;
    const neverSeen = c.seenAt === null || c.seenAt === undefined;
    if (open === 0 && changed === 0) return null;
    const hot = changed > 0;
    const openText = `${open}${c.openCapped ? "+" : ""}`;
    return (
      <span
        title={hot ? t("ch.scope.badgeOpen", { n: openText }) + " · " + (neverSeen ? t("ch.scope.badgeNeverSeen") : t("ch.scope.badgeChanged", { n: changed })) : t("ch.scope.badgeOpen", { n: openText })}
        style={{
          flexShrink: 0,
          fontSize: 10,
          lineHeight: "16px",
          padding: "0 6px",
          borderRadius: 999,
          color: hot ? "#fff" : "var(--text-muted, #999)",
          background: hot ? "var(--accent, #2563eb)" : "transparent",
          border: hot ? "none" : "1px solid var(--border, #3a3a3a)",
        }}
      >
        {openText}{hot ? `（±${changed}${c.changedCapped ? "+" : ""}）` : ""}
      </span>
    );
  }

  function repoRow(s: any, indented: boolean): unknown {
    const id = String(s.id);
    const active = id === String(p.value);
    return (
      <div
        key={id}
        onClick={() => pick(id)}
        title={s.path ? String(s.path) : labelOf(s)}
        style={{
          display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          padding: indented ? "6px 6px 6px 22px" : "6px 6px",
          borderRadius: 6, fontSize: 12, fontFamily: "inherit",
          color: active ? "var(--accent, #2563eb)" : "var(--text, #ddd)",
          background: active ? "var(--bg-hover, rgba(255,255,255,0.06))" : "transparent",
          borderLeft: `2px solid ${active ? "var(--accent, #2563eb)" : "transparent"}`,
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.favorites?.includes(id) ? "★ " : ""}{labelOf(s)}
        </span>
        {badge(id)}
        {(s as any).archived ? <span style={S.dim}>{t("ch.scope.archivedTag")}</span> : null}
      </div>
    );
  }

  function groupBlock(g: ScopeGroup): unknown {
    const collapsed = !needle && openMap[g.ns] === false;
    return (
      <div key={`ns:${g.ns}`}>
        <button
          type="button"
          onClick={() => toggleGroup(g.ns)}
          title={collapsed ? t("ch.common.expand") : t("ch.common.collapse")}
          style={{
            width: "100%", minWidth: 0, display: "flex", alignItems: "center", gap: 4,
            background: "none", border: "none", cursor: "pointer", padding: "5px 4px",
            color: "var(--text-muted, #999)", fontSize: 11, letterSpacing: 0.3,
            textAlign: "left", fontFamily: "inherit",
          }}
        >
          <span style={{ width: 9, display: "inline-block", opacity: 0.7 }}>{collapsed ? "▸" : "▾"}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {g.ns}{g.mine ? t("ch.scope.mineSuffix") : ""}
          </span>
          <span style={{ opacity: 0.5 }}>{g.items.length}</span>
        </button>
        {collapsed ? null : g.items.map((s) => repoRow(s, true))}
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ position: "relative", ...(p.style || {}) }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          ...S.input, display: "flex", alignItems: "center", gap: 6,
          textAlign: "left", cursor: "pointer",
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentLabel}</span>
        <span style={{ opacity: 0.6, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 60,
            background: "var(--bg-panel, #141414)", border: "1px solid var(--border, #3a3a3a)",
            borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
            maxHeight: 360, overflowY: "auto", padding: 4, display: "flex", flexDirection: "column", gap: 1,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {p.scopes.length >= 8 ? <Input value={filter} onChange={setFilter} placeholder={t("ch.scope.filterPh")} style={{ marginBottom: 0 }} /> : <span style={{ ...S.dim, fontSize: 11 }}>{t("ch.scope.clickHint")}</span>}
            </div>
            <button
              type="button"
              title={t("ch.common.close")}
              aria-label={t("ch.common.close")}
              onClick={() => { setOpen(false); setFilter(""); }}
              style={{ background: "none", border: "none", color: "var(--text-muted, #888)", cursor: "pointer", fontSize: 14, padding: "2px 6px", fontFamily: "inherit" }}
            >
              ✕
            </button>
          </div>
          {visible.length === 0 ? (
            <div style={{ ...S.dim, padding: "6px 8px" }}>
              {p.loading ? t("ch.common.loading") : p.scopes.length ? t("ch.common.noMatchRepo") : t("ch.scope.none")}
            </div>
          ) : null}
          {visible.map((g) => (flat ? g.items.map((s) => repoRow(s, false)) : groupBlock(g)))}
        </div>
      ) : null}
    </div>
  );
}
