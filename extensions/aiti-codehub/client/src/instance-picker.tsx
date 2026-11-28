/**
 * Account instance pickers (multi-account).
 *
 * Rendering rule: a platform with a single account stays flat; from two
 * accounts up the picker groups them under the platform name:
 *
 *   ▾ Yunxiao
 *       Personal   ✓ wind
 *       Work       ⚠ re-login
 *
 * `InstanceSelect` is a native <select> with <optgroup>, so it drops into any toolbar.
 * `InstanceTree` is the settings-page column (platform headers, add/rename/delete).
 */
import { useState, t } from "./host-shim";
import type { ProviderInfo } from "./api";
import { aliasDisplay, groupByPlatform, type PlatformGroup } from "./store";
import { groupOpenKey } from "./keys";
import { Btn, Ic, ICONS, Input, S, useLocaleTick } from "./ui";

export function instanceStatusText(p: ProviderInfo): string {
  const st = p.status;
  if (st?.needsLogin) return t("ch.picker.needRelogin");
  if (p.virtual) return t("ch.picker.notConfigured");
  if (st?.hasToken || st?.configured) {
    const name = st.account?.displayName || st.account?.username || "";
    return name ? `✓ ${name}` : t("ch.picker.configured");
  }
  return t("ch.picker.notConfigured");
}

export function instanceRowLabel(p: ProviderInfo, withStatus: boolean): string {
  const alias = aliasDisplay(p);
  return withStatus ? `${alias}  ${instanceStatusText(p)}` : alias;
}

/** Native select: flat for one-account platforms, optgroup from two up. */
export function InstanceSelect(p: {
  value: string;
  onChange: (id: string) => void;
  instances: ProviderInfo[];
  groups?: PlatformGroup[];
  style?: Record<string, unknown>;
  disabled?: boolean;
}) {
  const groups = p.groups && p.groups.length ? p.groups : groupByPlatform(p.instances);
  const multi = groups.some((g) => g.items.length > 1);
  return (
    <select
      value={p.value}
      disabled={p.disabled}
      onChange={(e: any) => p.onChange(e.target.value)}
      style={{ ...S.input, cursor: p.disabled ? "not-allowed" : "pointer", ...(p.style || {}) }}
    >
      {groups.flatMap((g) => {
        const options = g.items.map((it) => (
          <option key={it.id} value={it.id}>{instanceRowLabel(it, true)}</option>
        ));
        if (!multi || g.items.length < 2) return options;
        return [<optgroup key={`g:${g.platform}`} label={g.label}>{options}</optgroup>];
      })}
    </select>
  );
}

function readOpen(platform: string): boolean {
  try {
    return localStorage.getItem(groupOpenKey(platform)) !== "0";
  } catch {
    return true;
  }
}

function writeOpen(platform: string, open: boolean): void {
  try { localStorage.setItem(groupOpenKey(platform), open ? "1" : "0"); } catch { /* ignore */ }
}

/** Settings column: platform groups + account rows + add/rename/delete. */
type TreeView = "grouped" | "flat";
const VIEW_KEY = "pi-codehub:tree-view";

function readView(): TreeView {
  try { return localStorage.getItem(VIEW_KEY) === "flat" ? "flat" : "grouped"; } catch { return "grouped"; }
}

/** Settings column: platform groups or one merged list of every account. */
export function InstanceTree(p: {
  instances: ProviderInfo[];
  value: string;
  onSelect: (id: string) => void;
  onAdd: (platform: string) => void;
  onRename?: (instance: ProviderInfo) => void;
  onDelete?: (instance: ProviderInfo) => void;
}) {
  useLocaleTick();
  const allGroups = groupByPlatform(p.instances);
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(allGroups.map((g) => [g.platform, readOpen(g.platform)])));
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<TreeView>(readView);
  const needle = filter.trim().toLowerCase();
  const groups = needle
    ? allGroups
      .map((g) => ({ ...g, items: g.items.filter((it) => `${it.alias || ""} ${it.label || ""} ${it.id}`.toLowerCase().includes(needle)) }))
      .filter((g) => g.items.length > 0)
    : allGroups;

  function switchView(next: TreeView): void {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch { /* ignore */ }
  }

  function row(it: ProviderInfo, platformLabel?: string) {
    const active = it.id === p.value;
    return (
      <div
        key={it.id}
        onClick={() => p.onSelect(it.id)}
        title={`${it.alias || it.label} (${it.id})`}
        style={{
          display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          padding: platformLabel ? "5px 6px" : "5px 6px 5px 18px", borderRadius: 6, fontSize: 12,
          background: active ? "var(--bg-hover, rgba(255,255,255,0.06))" : "transparent",
          borderLeft: `2px solid ${active ? "var(--accent, #2563eb)" : "transparent"}`,
        }}
      >
        {platformLabel ? (
          <span style={{ ...S.dim, width: 58, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{platformLabel}</span>
        ) : null}
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {aliasDisplay(it)}
          {it.isDefault ? <span style={{ ...S.dim, marginLeft: 6 }}>{t("ch.picker.isDefaultTag")}</span> : null}
        </span>
        <span style={{ ...S.dim, fontSize: 10.5, whiteSpace: "nowrap" }}>{instanceStatusText(it)}</span>
        {p.onRename ? (
          <button
            type="button"
            title={t("ch.picker.rename")}
            onClick={(e: any) => { e.stopPropagation(); p.onRename!(it); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim, #888)", padding: 0, display: "inline-flex" }}
          >
            <Ic paths={ICONS.gear} />
          </button>
        ) : null}
        {p.onDelete ? (
          <button
            type="button"
            title={t("ch.picker.delete")}
            onClick={(e: any) => { e.stopPropagation(); p.onDelete!(it); }}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim, #888)", padding: "0 2px", fontSize: 13, lineHeight: 1, fontFamily: "inherit" }}
          >
            ×
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
        <Btn small primary={view === "grouped"} onClick={() => switchView("grouped")} title={t("ch.picker.groupViewTitle")}>{t("ch.picker.groupView")}</Btn>
        <Btn small primary={view === "flat"} onClick={() => switchView("flat")} title={t("ch.picker.flatViewTitle")}>{t("ch.picker.flatView")}</Btn>
        <span style={{ flex: 1 }} />
        {view === "flat" ? (
          <select
            value=""
            onChange={(e: any) => { if (e.target.value) p.onAdd(e.target.value); }}
            title={t("ch.picker.addAccount")}
            style={{ ...S.input, width: 84, padding: "3px 4px", fontSize: 11, cursor: "pointer" }}
          >
            <option value="">{t("ch.picker.addOption")}</option>
            {allGroups.map((g) => <option key={g.platform} value={g.platform}>{g.label}</option>)}
          </select>
        ) : null}
      </div>
      {p.instances.length >= 8 ? (
        <Input value={filter} onChange={setFilter} placeholder={t("ch.picker.filterPh")} style={{ marginBottom: 4 }} />
      ) : null}
      {groups.length === 0 ? <div style={{ ...S.dim, padding: "4px 6px" }}>{t("ch.picker.noMatch")}</div> : null}

      {view === "flat"
        ? groups.flatMap((g) => g.items.map((it) => row(it, g.label)))
        : groups.map((g) => {
          const collapsed = !needle && open[g.platform] === false;
          return (
            <div key={g.platform}>
              <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...open, [g.platform]: collapsed };
                    setOpen(next);
                    writeOpen(g.platform, !collapsed);
                  }}
                  style={{
                    flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4,
                    background: "none", border: "none", cursor: "pointer", padding: "5px 4px",
                    color: "var(--text-muted, #999)", fontSize: 11, letterSpacing: 0.3, textAlign: "left",
                    fontFamily: "inherit",
                  }}
                  title={collapsed ? t("ch.common.expand") : t("ch.common.collapse")}
                >
                  <span style={{ width: 9, display: "inline-block", opacity: 0.7 }}>{collapsed ? "▸" : "▾"}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.label}</span>
                  <span style={{ opacity: 0.5 }}>{g.items.length}</span>
                </button>
                <Btn small title={t("ch.picker.addForPlatform", { platform: g.label })} onClick={() => p.onAdd(g.platform)}>+</Btn>
              </div>
              {collapsed ? null : g.items.map((it) => row(it))}
            </div>
          );
        })}
    </div>
  );
}
