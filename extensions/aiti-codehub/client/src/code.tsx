/**
 * Repositories surface: provider → namespace → repo list; clicking a repo opens the Repo Workspace.
 * Row actions: clone / MR / web. (The "recent" list belongs to the work items surface; settings is shared.)
 */
import { useEffect, useState, t } from "./host-shim";
import { getState, listNamespaces, listRepos, searchRepos, toggleFavorite, type Repo } from "./api";
import { emitChanged, instanceTitle, useProviders } from "./store";
import { InstanceSelect } from "./instance-picker";
import { openClone } from "./clone";
import { openRepoWorkspace } from "./repo-workspace";
import { openMR } from "./mr";
import { Btn, Empty, ErrBox, friendlyError, fmtTime, Ic, ICONS, Input, Select, S, Spinner, Tag, useLocaleTick } from "./ui";
import { SettingsPanel } from "./settings";
import { codeNsKey } from "./keys";

type TabId = "code" | "settings";
type RepoView = "mine" | "forks" | "starred" | "search";

function readNs(provider: string): string {
  try { return localStorage.getItem(codeNsKey(provider)) || ""; } catch { return ""; }
}

function writeNs(provider: string, id: string): void {
  try { localStorage.setItem(codeNsKey(provider), id); } catch { /* ignore */ }
}

function viewKey(provider: string): string {
  return `pi-codehub:code-view:${provider}`;
}

function readView(provider: string): RepoView {
  try {
    const v = localStorage.getItem(viewKey(provider));
    return v === "forks" || v === "starred" || v === "search" ? v : "mine";
  } catch { return "mine"; }
}

function writeView(provider: string, v: RepoView): void {
  try { localStorage.setItem(viewKey(provider), v); } catch { /* ignore */ }
}

export function CodePanel() {
  useLocaleTick();
  const { providers, groups, providerId, setProviderId, reload, loading: providersLoading, error: providersError, authRev } = useProviders("code");
  const provider = providers.find((p) => p.id === providerId);
  const [tab, setTab] = useState<TabId>("code");

  const [namespaces, setNamespaces] = useState<any[]>([]);
  const [ns, setNs] = useState("");
  const [view, setViewState] = useState<RepoView>("mine");

  /* per-provider last namespace + view selection */
  useEffect(() => {
    setNs(readNs(providerId));
    setViewState(readView(providerId));
  }, [providerId]);

  function setView(v: RepoView): void {
    setViewState(v);
    writeView(providerId, v);
    setRepos([]);
    setReposErr(null);
    if (v === "search") setReposLoading(false);
  }
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposErr, setReposErr] = useState<string | null>(null);

  const [favRepos, setFavRepos] = useState<string[]>([]);

  const codeCap = (provider?.capabilities as any)?.code;

  /* favorites */
  async function loadFavorites(): Promise<void> {
    try {
      const s = await getState();
      const b = s.favorites?.[providerId] || {};
      setFavRepos(b.repos || []);
    } catch {
      setFavRepos([]);
    }
  }

  useEffect(() => { void loadFavorites(); }, [providerId]);

  /* namespaces */
  useEffect(() => {
    if (!providerId || !codeCap?.namespaces) { setNamespaces([]); setNs(""); return; }
    let alive = true;
    void listNamespaces(providerId, undefined, 1, 100)
      .then((p) => { if (alive) setNamespaces(p.items || []); })
      .catch(() => { if (alive) setNamespaces([]); });
    return () => { alive = false; };
  }, [providerId, codeCap?.namespaces, authRev]);

  /* repos */
  async function loadRepos(): Promise<void> {
    if (!providerId) return;
    if (view === "search") {
      if (!q.trim()) { setRepos([]); return; }
      setReposLoading(true);
      setReposErr(null);
      try {
        const p = await searchRepos(providerId, q.trim(), 1, 30);
        setRepos(p.items || []);
      } catch (e) {
        setReposErr(friendlyError(e));
      } finally {
        setReposLoading(false);
      }
      return;
    }
    setReposLoading(true);
    setReposErr(null);
    try {
      const p = await listRepos(providerId, view === "mine" ? (ns || undefined) : undefined, 1, 50, q.trim() || undefined, view);
      setRepos(p.items || []);
    } catch (e) {
      setReposErr((e as Error).message);
    } finally {
      setReposLoading(false);
    }
  }

  useEffect(() => {
    if (tab !== "code") return;
    if (!providerId) return;
    if (view === "search") return; /* search loads on demand (Enter) */
    void loadRepos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, providerId, ns, view, authRev]);

  async function starRepo(repo: Repo): Promise<void> {
    try {
      const r = await toggleFavorite(providerId, "repos", repo.path);
      setFavRepos((cur) => (r.active ? [...cur, repo.path] : cur.filter((x) => x !== repo.path)));
      emitChanged();
    } catch { /* ignore */ }
  }

  const nsOptions = [{ value: "", label: t("ch.code.allNamespaces") }, ...namespaces.map((n) => ({ value: String(n.id), label: String(n.name || n.path || n.id) }))];
  const canMR = codeCap?.mergeRequests === "write";
  const views = codeCap?.views || {};
  const viewItems: Array<{ v: RepoView; label: string }> = [
    { v: "mine", label: t("ch.code.viewMine") },
    ...(views.forks ? [{ v: "forks" as RepoView, label: "Fork" }] : []),
    ...(views.starred ? [{ v: "starred" as RepoView, label: "★" }] : []),
    ...(views.search ? [{ v: "search" as RepoView, label: "🔍" }] : []),
  ];

  return (
    <div style={S.panel}>
      <div style={S.bar}>
        {providers.length > 1 ? (
          <InstanceSelect value={providerId} onChange={(v) => { if (v === providerId) return; setProviderId(v); setNs(readNs(v)); setRepos([]); }} instances={providers} groups={groups} style={{ width: 150 }} />
        ) : providers.length === 1 ? (
          <span style={{ ...S.muted, whiteSpace: "nowrap" }} title={instanceTitle(providerId)}>{instanceTitle(providerId)}</span>
        ) : null}
        {viewItems.length > 1 ? (
          <div style={{ display: "inline-flex", gap: 0, borderRadius: 6, overflow: "hidden", border: "1px solid var(--border, #3a3a3a)", flexShrink: 0 }}>
            {viewItems.map((it) => (
              <button
                key={it.v}
                type="button"
                title={{ mine: t("ch.code.viewTitleMine"), forks: t("ch.code.viewTitleForks"), starred: t("ch.code.viewTitleStarred"), search: t("ch.code.viewTitleSearch") }[it.v]}
                onClick={() => setView(it.v)}
                style={{
                  padding: "4px 8px", fontSize: 11, fontFamily: "inherit", cursor: "pointer",
                  color: view === it.v ? "#fff" : "var(--text-muted, #999)",
                  background: view === it.v ? "var(--accent, #2563eb)" : "transparent",
                  border: "none", borderRight: "1px solid var(--border, #3a3a3a)",
                }}
              >
                {it.label}
              </button>
            ))}
          </div>
        ) : null}
        {view === "mine" && codeCap?.namespaces ? <Select value={ns} onChange={(v) => { setNs(v); writeNs(providerId, v); }} options={nsOptions} style={{ width: 140 }} /> : null}
        <div style={{ flex: 1, minWidth: 90 }}>
          <Input value={q} onChange={setQ} onEnter={() => void loadRepos()} placeholder={view === "search" ? t("ch.code.searchPh") : t("ch.code.filterPh")} />
        </div>
        <Btn small onClick={() => void loadRepos()} disabled={reposLoading} title={view === "search" ? t("ch.common.search") : t("ch.common.refresh")}><Ic paths={ICONS.search} /></Btn>
        <Btn small title={t("ch.common.settings")} onClick={() => setTab(tab === "settings" ? "code" : "settings")}><Ic paths={ICONS.gear} /></Btn>
      </div>

      {providersError ? <div style={{ padding: "0 10px" }}><ErrBox text={providersError} onRetry={() => void reload()} /></div> : null}

      {tab === "settings" ? <SettingsPanel compact /> : (
        <div style={{ ...S.body, display: "flex", flexDirection: "column", gap: 6 }}>
          {reposLoading && repos.length === 0 ? <Spinner /> : null}
          {reposErr ? <ErrBox text={reposErr} onRetry={() => void loadRepos()} onSetup={reposErr === t("ch.err.authInvalid") ? () => setTab("settings") : undefined} /> : null}
          {!reposLoading && !reposErr && repos.length === 0 ? <Empty text={view === "search" && !q.trim() ? t("ch.code.searchEmptyHint") : t("ch.common.noMatchRepo")} /> : null}

          <div style={{ flexShrink: 0 }}>
            {repos.map((r) => {
              const fav = favRepos.includes(r.path);
              return (
                <div
                  key={r.id}
                  style={{ ...S.row }}
                  title={t("ch.code.openWorkspaceHint")}
                  onClick={() => openRepoWorkspace({ provider: providerId, repo: r })}
                >
                  <button
                    type="button"
                    title={fav ? t("ch.code.favRemove") : t("ch.code.favAdd")}
                    onClick={(e: any) => { e.stopPropagation(); void starRepo(r); }}
                    style={{ background: "none", border: "none", cursor: "pointer", color: fav ? "var(--warn, #f59e0b)" : "var(--text-dim, #888)", padding: 0, display: "inline-flex" }}
                  >
                    <Ic paths={ICONS.star} />
                  </button>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={(r.displayPath || r.path)}>{(r.displayPath || r.path) || r.name}</div>
                    <div style={{ ...S.dim, marginTop: 1 }}>
                      {r.defaultBranch ? t("ch.code.defaultBranch", { name: r.defaultBranch }) : ""}{r.archived ? t("ch.common.archivedTag") : ""}{r.updatedAt ? ` · ${fmtTime(r.updatedAt)}` : ""}
                    </div>
                  </div>
                  <Btn small title={t("ch.code.clone")} onClick={(e: any) => { e.stopPropagation(); if (r.cloneSsh || r.cloneHttp) openClone({ provider: providerId, repo: r }); }}>{t("ch.code.clone")}</Btn>
                  {canMR ? <Btn small title={t("ch.code.mrNew")} onClick={(e: any) => { e.stopPropagation(); openMR({ provider: providerId, repo: r }); }}>MR</Btn> : null}
                  {r.webUrl ? <Btn small title={t("ch.common.openWeb")} onClick={(e: any) => { e.stopPropagation(); try { window.open(r.webUrl!, "_blank", "noopener,noreferrer"); } catch { /* ignore */ } }}><Ic paths={ICONS.external} /></Btn> : null}
                </div>
              );
            })}
          </div>

        </div>
      )}
    </div>
  );
}
