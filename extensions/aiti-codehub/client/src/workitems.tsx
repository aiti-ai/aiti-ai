/**
 * Work items surface: provider → scope (project / repo) → filters → list.
 * Tabs: items · recent · settings.
 */
import { useEffect, useMemo, useRef, useState, t } from "./host-shim";
import {
  fetchCounts,
  getState,
  listScopes,
  listWorkItems,
  markSeen,
  toggleFavorite,
  type Page,
  type ProviderInfo,
  type Scope,
  type WorkItem,
} from "./api";
import { instanceTitle, readSelectedProvider, useProviders } from "./store";
import { readStoredScope, writeStoredScope, type StoredScope } from "./keys";
import { isPickMode, openPickDetail, submitPick, usePickMode } from "./workitem-picker";
import { InstanceSelect } from "./instance-picker";
import { openWorkItem } from "./detail";
import { ScopeTreeSelect, type ScopeCount } from "./scope-tree";
import { SettingsPanel } from "./settings";
import { YUNXIAO_STATUS_KEY } from "../../ui-i18n";
import { Btn, Empty, ErrBox, friendlyError, fmtTime, Ic, ICONS, Input, Section, S, Spinner, StateBadge, Tabs, Tag, tf, toast, useLocaleTick } from "./ui";

type TabId = "items" | "recent" | "settings";

/* Provider descriptor copy (filters) is server data: translate by platform+key with
 * the server value as fallback. State/option values that the server matches with
 * CONTAINS stay as data on the wire — only the displayed label is localized. */
/** True when the (already normalized) error is the localized auth hint. */
function isAuthError(msg: string | null): boolean {
  return !!msg && msg === t("ch.err.authInvalid");
}

function filterLabel(_providerId: string, f: { key: string; label?: string }): string {
  return tf(`ch.prov.filter.${f.key}`, String(f.label || f.key));
}
function filterOptLabel(providerId: string, f: { key: string }, o: { value: string; label: string }): string {
  const platform = String(providerId.split("~")[0] || providerId);
  if (platform === "yunxiao" && f.key === "type") {
    return tf(`ch.prov.filteropt.type.${o.value}`, o.label);
  }
  if (platform === "yunxiao" && f.key === "status") {
    const suffix = YUNXIAO_STATUS_KEY[o.label];
    if (suffix) return tf(`ch.prov.filteropt.status.${suffix}`, o.label);
  }
  return o.label;
}

export function WorkItemsPanel() {
  useLocaleTick();
  const picking = usePickMode();
  const { providers, groups, providerId, setProviderId, reload: reloadProviders, loading: providersLoading, error: providersError, authRev } = useProviders("workitems");
  const provider: ProviderInfo | undefined = providers.find((p) => p.id === providerId);

  const [tab, setTab] = useState<TabId>("items");
  const [scopeQuery, setScopeQuery] = useState("");
  const [scopes, setScopes] = useState<any[]>([]);
  const [scopesLoading, setScopesLoading] = useState(false);
  const [scopeId, setScopeId] = useState<string>(() => readStoredScope(readSelectedProvider())?.id || "");
  const [scopesErr, setScopesErr] = useState<string | null>(null);

  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [assignee, setAssignee] = useState("");
  const [labels, setLabels] = useState("");
  const [exclude, setExclude] = useState<boolean>(true);

  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<WorkItem> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [recents, setRecents] = useState<any[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [usageMap, setUsageMap] = useState<Record<string, any>>({});
  const [favProjects, setFavProjects] = useState<string[]>([]);
  const [countsMap, setCountsMap] = useState<Record<string, ScopeCount>>({});
  /* track the last scope we marked seen, so pagination/reload doesn't re-report */
  const seenForRef = useRef<string>("");

  const workItemsCap = (provider?.capabilities as any)?.workItems;
  const scopeKind: "project" | "repo" = workItemsCap?.scope === "project" ? "project" : "repo";
  const filters = (workItemsCap?.filters || []) as any[];

  /* scope list */
  useEffect(() => {
    if (!providerId) return;
    let alive = true;
    setScopesLoading(true);
    setScopesErr(null);
    setScopes([]);
    setData(null);
    void listScopes(providerId, 1, 100, scopeQuery || undefined)
      .then((p) => {
        if (!alive) return;
        const items = p.items || [];
        setScopes(items);
        const stored = readStoredScope(providerId);
        const found = stored ? items.find((x: any) => String(x.id) === String(stored.id)) : undefined;
        if (found) {
          setScopeId(String(found.id));
        } else if (stored) {
          /* remembered scope is beyond the fetched page (or removed): keep it
           * selected via the stored label instead of silently picking the first */
          setScopeId(String(stored.id));
        } else {
          setScopeId(items.length ? String(items[0].id) : "");
        }
      })
      .catch((e) => { if (alive) setScopesErr(friendlyError(e)); })
      .finally(() => { if (alive) setScopesLoading(false); });
    return () => { alive = false; };
  }, [providerId, scopeQuery, authRev]);

  const storedScope = useMemo(() => readStoredScope(providerId), [providerId]);
  const scope: Scope | null = useMemo(() => {
    const s = scopes.find((x) => String(x.id) === scopeId);
    if (s) return { kind: scopeKind, id: String(s.id), label: String(s.name || s.path || s.id) };
    if (storedScope && scopeId === String(storedScope.id)) {
      return { kind: storedScope.kind, id: String(storedScope.id), label: storedScope.label };
    }
    return null;
  }, [scopes, scopeId, scopeKind, storedScope]);

  useEffect(() => {
    if (!providerId || !scopeId) return;
    const s = scopes.find((x) => String(x.id) === scopeId);
    if (!s) return; /* synthetic (remembered-but-not-listed) selection: keep the stored record */
    writeStoredScope(providerId, { id: scopeId, label: String(s.name || s.path || s.id), kind: scopeKind });
  }, [providerId, scopeId, scopes, scopeKind]);

  /** Provider switch: clear per-provider transient state and pre-restore the
   * remembered scope immediately (the list effect re-runs via providerId). */
  function switchProviderSurface(v: string): void {
    if (v === providerId) return;
    setProviderId(v);
    setScopeQuery("");
    setCountsMap({});
    const st = readStoredScope(v);
    setScopeId(st?.id || "");
  }

  /* usage + project favorites */
  useEffect(() => {
    if (!providerId) return;
    void getState()
      .then((s) => {
        setUsageMap(s.usage || {});
        setFavProjects(s.favorites?.[providerId]?.projects || []);
      })
      .catch(() => { /* ignore */ });
  }, [providerId]);

  async function starProject(): Promise<void> {
    if (!scope || scope.kind !== "project") return;
    try {
      const r = await toggleFavorite(providerId, "projects", scope.id);
      setFavProjects((cur) => (r.active ? [...cur, scope.id] : cur.filter((x) => x !== scope.id)));
    } catch { /* ignore */ }
  }

  /* items */
  async function loadItems(nextPage = 1, append = false): Promise<void> {
    if (!provider || !scope) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await listWorkItems({
        provider: provider.id,
        scope,
        keyword: keyword.trim() || undefined,
        types: selected.type,
        statuses: selected.status,
        states: selected.state,
        assignee: assignee.trim() || undefined,
        labels: labels ? labels.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        excludeTerminal: exclude,
        page: nextPage,
        pageSize: undefined,
      });
      setPage(nextPage);
      setData((prev) => (append && prev ? { ...res, items: [...prev.items, ...res.items] } : res));
      void getState().then((st) => setUsageMap(st.usage || {})).catch(() => { /* ignore */ });
      /* first full load of a scope = "user looked at it": record + clear its badge */
      if (nextPage === 1 && !append) {
        const key = `${provider.id}:${scope.id}`;
        if (seenForRef.current !== key) {
          seenForRef.current = key;
          void markSeen(provider.id, scope).catch(() => { /* ignore */ });
          setCountsMap((prev) => {
            const cur = prev[scope.id];
            if (!cur) return prev;
            return { ...prev, [scope.id]: { ...cur, changed: 0, seenAt: Date.now() } };
          });
        }
      }
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  /* batched badge counts, request-driven (each batch of the chain renders as it lands; no polling) */
  const countsChainRef = useRef(0);
  async function refreshCounts(refresh = false): Promise<void> {
    if (!provider) return;
    if (!provider.capabilities?.workItems) return;
    const list = scopes.map((s) => ({ kind: scopeKind, id: String(s.id), label: String(s.name || s.path || s.id) }));
    if (!list.length) return;
    const chain = ++countsChainRef.current;
    const BATCH = 20;
    for (let i = 0; i < list.length; i += BATCH) {
      if (chain !== countsChainRef.current) return; /* a newer refresh superseded this chain */
      try {
        const batch = await fetchCounts(provider.id, list.slice(i, i + BATCH), refresh);
        setCountsMap((prev) => {
          const next = { ...prev };
          for (const [id, c] of Object.entries(batch)) {
            /* a locally-newer seen mark wins: an in-flight batch computed against the old seen */
            const prevSeen = next[id]?.seenAt ?? 0;
            const batchSeen = c.seenAt ?? 0;
            if (prevSeen > batchSeen) continue;
            next[id] = c;
          }
          return next;
        });
      } catch { /* ignore batch failure; badges just stay empty */ }
    }
  }

  /* warm-up: start counting as soon as the panel has scopes (cache makes tree open instant later) */
  useEffect(() => {
    if (scopes.length) void refreshCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, scopes.length]);

  useEffect(() => {
    if (tab !== "items") return;
    if (!scope) return;
    void loadItems(1, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, provider?.id, scope?.id, scope?.kind, authRev]);

  /* recents */
  async function loadRecents(): Promise<void> {
    setRecentLoading(true);
    try {
      const s = await getState();
      setRecents(s.recents || []);
    } catch {
      setRecents([]);
    } finally {
      setRecentLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "recent") void loadRecents();
  }, [tab]);

  function toggleMulti(key: string, value: string, single = false): void {
    setSelected((prev) => {
      const cur = prev[key] || [];
      if (cur.includes(value)) return { ...prev, [key]: cur.filter((v) => v !== value) };
      return { ...prev, [key]: single ? [value] : [...cur, value] };
    });
  }

  function openDetail(item: WorkItem): void {
    const tgt = { provider: providerId, scope: item.scope || scope!, item };
    if (isPickMode()) { openPickDetail(tgt); return; }
    openWorkItem(tgt);
  }

  /** Inline Select on a list row: complete the active pick with the listed item. */
  function pickRow(item: WorkItem): void {
    void submitPick(item, providerId);
  }

  /** Inline Select on a recent row: fetch the full item first (template needs
   * type/status), then complete the pick. */
  async function pickRecentRow(r: any): Promise<void> {
    if (!r?.scopeId) { toast(t("ch.wi.recentMissingScope")); return; }
    const rs = { kind: r.scopeKind === "repo" ? "repo" : "project", id: String(r.scopeId), label: String(r.sub || r.scopeId) } as Scope;
    try {
      const full = await getWorkItem(String(r.provider), rs, String(r.id));
      await submitPick(full.item, String(r.provider));
    } catch { /* keep the pick active; the row click opens the detail instead */ }
  }

  return (
    <div style={S.panel}>
      <div style={S.bar}>
        {providers.length > 1 ? (
          <InstanceSelect value={providerId} onChange={(v) => switchProviderSurface(v)} instances={providers} groups={groups} style={{ width: 160 }} />
        ) : providers.length === 1 ? (
          <span style={{ ...S.muted, whiteSpace: "nowrap" }} title={instanceTitle(providerId)}>{instanceTitle(providerId)}</span>
        ) : null}
        <ScopeTreeSelect
          value={scopeId}
          onChange={setScopeId}
          scopes={scopes}
          storedLabel={storedScope && scopeId === String(storedScope.id) ? storedScope.label : undefined}
          loading={scopesLoading}
          mine={provider?.status?.account?.username || ""}
          favorites={favProjects}
          providerId={providerId}
          counts={countsMap}
          onOpen={() => void refreshCounts()}
          style={{ flex: 1, minWidth: 120 }}
        />
        {scope?.kind === "project" ? (
          <Btn small title={favProjects.includes(scope.id) ? t("ch.wi.favProjectRemove") : t("ch.wi.favProjectAdd")} onClick={() => void starProject()}>
            {favProjects.includes(scope.id) ? "★" : "☆"}
          </Btn>
        ) : null}
        <Btn small title={t("ch.wi.refreshScopes")} onClick={() => { setScopeQuery("");
          void listScopes(providerId, 1, 100).then((p) => setScopes(p.items || [])).catch((e) => setScopesErr(friendlyError(e)));
          if (scope) void loadItems(1, false);
          void refreshCounts(true);
        }}><Ic paths={ICONS.refresh} /></Btn>
        <Btn small title={t("ch.common.settings")} onClick={() => setTab("settings")}><Ic paths={ICONS.gear} /></Btn>
      </div>

      <div style={{ padding: "4px 10px 0" }}>
        <Tabs
          tabs={[{ id: "items", label: t("ch.wi.tabItems") }, { id: "recent", label: t("ch.wi.tabRecent") }, { id: "settings", label: t("ch.wi.tabSettings") }]}
          active={tab}
          onChange={(id) => setTab(id as TabId)}
        />
      </div>

      {providersError ? <div style={{ padding: "0 10px" }}><ErrBox text={providersError} onRetry={() => void reloadProviders()} /></div> : null}
      {/* auth failures repeat for scopes + list (same root cause) — show one line with a Setup action */}
      {scopesErr && !(isAuthError(scopesErr) && isAuthError(err)) ? <div style={{ padding: "0 10px" }}><ErrBox text={scopesErr} onRetry={() => setScopeQuery(scopeQuery ? scopeQuery + " " : "")} onSetup={isAuthError(scopesErr) ? () => setTab("settings") : undefined} /></div> : null}

      {tab === "items" ? (
        <>
          <div style={{ padding: "6px 10px 0", display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 120 }}>
              <Input
                value={keyword}
                onChange={setKeyword}
                onEnter={() => void loadItems(1, false)}
                placeholder={scopeKind === "project" ? t("ch.wi.keywordPhProject") : t("ch.wi.keywordPhRepo")}
              />
            </div>
            <Btn small primary onClick={() => void loadItems(1, false)} disabled={loading}><Ic paths={ICONS.search} /> {t("ch.common.search")}</Btn>
            <Btn small onClick={() => { setKeyword(""); setSelected({}); setAssignee(""); setLabels(""); void loadItems(1, false); }} disabled={loading}>{t("ch.common.clear")}</Btn>
          </div>

          {filters.length ? (
            <div style={{ padding: "6px 10px 0" }}>
              <Section title={t("ch.wi.filters")}>
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
                  {filters.map((f) => {
                    if (f.kind === "multi") {
                      const cur = selected[f.key] || [];
                      const single = f.key === "state";
                      return (
                        <span key={f.key} style={{ display: "inline-flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                          <span style={{ ...S.dim, marginRight: 2 }}>{filterLabel(providerId, f)}:</span>
                          {f.options.map((o: any) => {
                            const on = cur.includes(o.value);
                            return (
                              <button
                                key={o.value}
                                type="button"
                                onClick={() => toggleMulti(f.key, o.value, single)}
                                style={{
                                  padding: "2px 9px",
                                  fontSize: 10.5,
                                  borderRadius: 999,
                                  cursor: "pointer",
                                  fontFamily: "inherit",
                                  color: on ? "#fff" : "var(--text-muted, #aaa)",
                                  background: on ? "var(--accent, #2563eb)" : "transparent",
                                  border: `1px solid ${on ? "var(--accent, #2563eb)" : "var(--border, #3a3a3a)"}`,
                                }}
                              >
                                {filterOptLabel(providerId, f, o)}
                              </button>
                            );
                          })}
                        </span>
                      );
                    }
                    if (f.kind === "bool") {
                      return (
                        <label key={f.key} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, ...S.muted, cursor: "pointer" }}>
                          <input type="checkbox" checked={exclude} onChange={(e: any) => setExclude(!!e.target.checked)} />
                          {filterLabel(providerId, f)}
                        </label>
                      );
                    }
                    if (f.kind === "user") {
                      return (
                        <span key={f.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span style={S.dim}>{filterLabel(providerId, f)}:</span>
                          <Input value={assignee} onChange={setAssignee} placeholder={t("ch.wi.assigneePh")} style={{ width: 110 }} onEnter={() => void loadItems(1, false)} />
                        </span>
                      );
                    }
                    if (f.kind === "tags") {
                      return (
                        <span key={f.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span style={S.dim}>{filterLabel(providerId, f)}:</span>
                          <Input value={labels} onChange={setLabels} placeholder={t("ch.wi.labelsPh")} style={{ width: 130 }} onEnter={() => void loadItems(1, false)} />
                        </span>
                      );
                    }
                    return null;
                  })}
                </div>
              </Section>
            </div>
          ) : null}

          <div style={S.body}>
            {loading && !data ? <div style={{ padding: 16 }}><Spinner /></div> : null}
            {err ? <ErrBox text={err} onRetry={() => void loadItems(page, false)} onSetup={isAuthError(err) ? () => setTab("settings") : undefined} /> : null}
            {!loading && !err && data && data.items.length === 0 ? (
              <Empty text={scope ? t("ch.wi.noMatch") : t("ch.wi.pickScopeFirst")} />
            ) : null}
            {data?.items.map((item) => (
              <WorkItemRow key={`${item.scope?.id}:${item.id}`} item={item} usage={usageMap[`${providerId}:${item.id}`]} onClick={() => openDetail(item)} onPick={picking ? () => pickRow(item) : undefined} />
            ))}
            {data?.hasMore ? (
              <div style={{ display: "flex", justifyContent: "center", padding: "8px 0" }}>
                <Btn small onClick={() => void loadItems(page + 1, true)} disabled={loading}>{loading ? t("ch.common.loading") : t("ch.common.loadMore")}</Btn>
              </div>
            ) : null}
            {data?.total !== undefined ? <div style={{ ...S.dim, textAlign: "center", padding: "6px 0" }}>{t("ch.common.total", { n: data.total })}</div> : null}
          </div>
        </>
      ) : null}

      {tab === "recent" ? (
        <div style={S.body}>
          {recentLoading ? <Spinner /> : recents.length === 0 ? <Empty text={t("ch.wi.noRecents")} /> : null}
          {recents.map((r) => {
            const label = String(r.label || r.id);
            const rKey = label.replace(/^#/, "").split(" ")[0];
            const rTitle = label.replace(/^#\S+\s*/, "");
            return (
            <div
              key={`${r.provider}:${r.kind}:${r.id}`}
              style={{ ...S.row, alignItems: "flex-start" }}
              onClick={() => {
                if (!r.scopeId) {
                  toast(t("ch.wi.recentMissingScope"));
                  return;
                }
                const stubTarget = {
                  provider: String(r.provider),
                  scope: { kind: r.scopeKind === "repo" ? "repo" : "project", id: String(r.scopeId), label: String(r.sub || r.scopeId) } as Scope,
                  item: { id: String(r.id), key: String(rKey), title: String(rTitle), type: "", status: "", state: "other", tags: [], scope: { kind: r.scopeKind === "repo" ? "repo" : "project", id: String(r.scopeId), label: String(r.sub || "") } } as WorkItem,
                };
                if (isPickMode()) { openPickDetail(stubTarget); return; }
                openWorkItem(stubTarget);
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</div>
                <div style={{ ...S.dim, marginTop: 2 }}>
                  {instanceTitle(String(r.provider))} · {r.sub ? r.sub + " · " : ""}{fmtTime(r.at)} · {t("ch.wi.usedCount", { n: r.count })}
                </div>
              </div>
              {picking ? <Btn small primary onClick={(e: any) => { e.stopPropagation(); void pickRecentRow(r); }}>{t("ch.pick.choose")}</Btn> : null}
            </div>
            );
          })}
        </div>
      ) : null}

      {tab === "settings" ? <SettingsPanel compact /> : null}
    </div>
  );
}

function WorkItemRow(p: { item: WorkItem; usage?: any; onClick: () => void; onPick?: () => void }) {
  const it = p.item;
  /* narrow screens: meta tags / time wrap to a second line (pure CSS, no media queries) */
  return (
    <div
      style={{ ...S.row, flexWrap: "wrap", rowGap: 3 }}
      onClick={p.onClick}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover, rgba(255,255,255,0.05))"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, color: "var(--text-muted, #999)", minWidth: 58 }}>#{it.key}</span>
      <span style={{ flex: 1, minWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.title}>{it.title}</span>
      {it.type ? <Tag>{it.type}</Tag> : null}
      <StateBadge state={it.state} status={it.status} />
      {p.usage?.sentToAIAt ? <Tag title={t("ch.wi.tagSentAI")}>AI</Tag> : null}
      {p.usage?.pastedAt ? <Tag title={t("ch.wi.tagPasted")}>✎</Tag> : null}
      {p.usage?.branch ? <Tag title={t("ch.wi.tagBranch", { name: p.usage.branch })}>⎇</Tag> : null}
      {it.assignee ? <Tag title={it.assignee}>{it.assignee}</Tag> : null}
      <span style={{ ...S.dim, marginLeft: "auto", whiteSpace: "nowrap" }}>{fmtTime(it.updatedAt || it.createdAt)}</span>
      {p.onPick ? <Btn small primary onClick={(e: any) => { e.stopPropagation(); p.onPick?.(); }}>{t("ch.pick.choose")}</Btn> : null}
    </div>
  );
}
