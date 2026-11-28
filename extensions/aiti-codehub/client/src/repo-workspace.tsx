/**
 * Repo Workspace — remote read-only browsing (tree/files/commits/diff) plus local
 * clone discovery/actions. Opens as a floating dialog by default and can be docked
 * to the right/left panel (createDockFaces).
 */
import { useEffect, useMemo, useState, t } from "./host-shim";
import { apiUrl, currentCwd, extSvc, openFile, openFolder } from "./host-shim";
import { present, presentState, openFloat } from "../../../_shared/ext-float-dock-lite";
import {
  getState,
  listBranches,
  toggleFavorite,
  repoBlobTickets,
  repoBlobUrl,
  repoCommit,
  repoCommits,
  repoEditorCopy,
  repoFile,
  repoLocal,
  repoTree,
  type Branch,
  type CommitDetail,
  type Repo,
  type RepoCommit,
  type RepoFileResult,
  type TreeEntry,
} from "./api";
import { openClone } from "./clone";
import { ensureReadOnlyEditor } from "./editor-provider";
import { openMR } from "./mr";
import { RichBody } from "./rich";
import { Btn, Empty, ErrBox, fmtTime, friendlyError, Ic, ICONS, Input, Section, Select, S, Spinner, StateBadge, Tag, Tabs, toast, useLocaleTick } from "./ui";
import { REPO_KEY, SETTINGS_KEY, repoWsKey } from "./keys";
import { cachedProviders, instanceTitle, readSelectedProvider } from "./store";

export interface WorkspaceTarget {
  provider: string;
  repo: Repo;
}

function writeLastRepo(t: WorkspaceTarget): void {
  try { localStorage.setItem(repoWsKey(t.provider), JSON.stringify(t)); } catch { /* ignore */ }
}

/** Last opened repo of the currently selected provider (reopen restore). */
function readLastRepo(): WorkspaceTarget | null {
  try {
    const raw = localStorage.getItem(repoWsKey(readSelectedProvider()));
    if (!raw) return null;
    const t = JSON.parse(raw) as WorkspaceTarget;
    if (t && t.provider && t.repo && t.repo.id) return t;
  } catch { /* ignore */ }
  return null;
}

/* restore the last repo of the last provider at bundle load, so a reopened
 * workspace panel lands on the previous repo instead of the empty hint */
let target: WorkspaceTarget | null = readLastRepo();
const listeners = new Set<() => void>();

export function openRepoWorkspace(t: WorkspaceTarget): void {
  target = t;
  writeLastRepo(t);
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
  const st = presentState(REPO_KEY);
  if (st === "closed" || st === "floating") present(REPO_KEY, "float");
  else openFloat(REPO_KEY);
}

function useTarget(): WorkspaceTarget | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return target;
}

function repoBody(t: WorkspaceTarget, ref?: string, path?: string) {
  return {
    provider: t.provider,
    repoId: t.repo.id,
    repoPath: t.repo.path,
    repoName: t.repo.name,
    defaultBranch: t.repo.defaultBranch,
    cloneSsh: t.repo.cloneSsh,
    cloneHttp: t.repo.cloneHttp,
    ...(ref ? { ref } : {}),
    ...(path !== undefined ? { path } : {}),
  };
}

function fmtSize(n?: number): string {
  if (!n || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Tab = "overview" | "files" | "commits" | "branches" | "local";

export function RepoWorkspaceContent() {
  useLocaleTick();
  const tgt = useTarget();
  if (!tgt) return <div style={{ padding: 20 }}><Empty text={t("ch.repo.pickRepo")} /></div>;
  return <WorkspaceBody key={`${tgt.provider}:${tgt.repo.id}`} target={tgt} />;
}

function WorkspaceBody(p: { target: WorkspaceTarget }) {
  const { provider, repo } = p.target;
  const [tab, setTab] = useState<Tab>("overview");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [favBranches, setFavBranches] = useState<string[]>([]);
  const [ref, setRef] = useState(repo.defaultBranch || "");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<(RepoFileResult & { path: string }) | null>(null);
  const [mdPreview, setMdPreview] = useState(true);

  const [commits, setCommits] = useState<RepoCommit[]>([]);
  const [commitPage, setCommitPage] = useState(1);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);

  const [local, setLocal] = useState<{ found: boolean; path?: string; remote?: string } | null>(null);
  const [localRefs, setLocalRefs] = useState<any>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    void listBranches(provider, repo, 1, 100)
      .then((r) => {
        if (!alive) return;
        setBranches(r.items || []);
        if (!ref) setRef(repo.defaultBranch || r.items?.find((b) => b.default)?.name || r.items?.[0]?.name || "");
      })
      .catch((e) => { if (alive) setErr(friendlyError(e)); })
      .finally(() => { if (alive) setLoading(false); });
    void repoLocal({ ...repoBody(p.target), cwd: currentCwd() }).then((r) => { if (alive) setLocal(r); }).catch(() => { if (alive) setLocal({ found: false }); });
    void getState().then((s) => { if (alive) setFavBranches(s.favorites?.[provider]?.branches || []); }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [provider, repo.id]);

  // tree loads when the files tab/ref/path changes
  useEffect(() => {
    if (tab !== "files") return;
    let alive = true;
    setLoading(true);
    setErr(null);
    void repoTree(repoBody(p.target, ref, path))
      .then((r) => { if (alive) setEntries(r.entries || []); })
      .catch((e) => { if (alive) setErr(friendlyError(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tab, ref, path, provider, repo.id]);

  // commits load when tab/ref/page changes
  useEffect(() => {
    if (tab !== "commits" && tab !== "overview") return;
    let alive = true;
    setCommitLoading(true);
    void repoCommits({ ...repoBody(p.target, ref), page: commitPage, pageSize: 30 })
      .then((r) => { if (alive) setCommits(r.items || []); })
      .catch((e) => { if (alive) setErr(friendlyError(e)); })
      .finally(() => { if (alive) setCommitLoading(false); });
    return () => { alive = false; };
  }, [tab, ref, commitPage, provider, repo.id]);

  // local git status via git-ops
  useEffect(() => {
    if (!local?.found || !local.path) return;
    let alive = true;
    void fetch(apiUrl("/api/extensions/aiti-git-ops/git/refs"), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: local.path }),
    }).then((r) => r.json()).then((d) => { if (alive) setLocalRefs(d); }).catch(() => { if (alive) setLocalRefs(null); });
    return () => { alive = false; };
  }, [local?.path]);

  async function starBranch(b: Branch): Promise<void> {
    const key = `${repo.path}#${b.name}`;
    try {
      const r = await toggleFavorite(provider, "branches", key);
      setFavBranches((cur) => (r.active ? [...cur, key] : cur.filter((x) => x !== key)));
    } catch { /* ignore */ }
  }

  async function openFileAt(entry: TreeEntry): Promise<void> {
    if (entry.type === "dir") { setPath(entry.path); setFile(null); return; }
    if (entry.type === "submodule") { toast(t("ch.repo.submoduleHint")); return; }
    setLoading(true);
    setErr(null);
    try {
      const r = await repoFile({ ...repoBody(p.target, ref), path: entry.path });
      setFile({ ...r, path: entry.path });
      setMdPreview(true);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  async function openCommit(sha: string): Promise<void> {
    setCommitLoading(true);
    setErr(null);
    try {
      const r = await repoCommit({ ...repoBody(p.target, ref), sha });
      setCommitDetail(r.commit);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setCommitLoading(false);
    }
  }

  async function openInEditor(): Promise<void> {
    if (!file) return;
    try {
      await ensureReadOnlyEditor();
      const r = await repoEditorCopy({ ...repoBody(p.target, ref), path: file.path });
      if (!openFile(r.path, file.path.split("/").pop())) toast(t("ch.repo.editorMissing"));
      else toast(t("ch.repo.editorOpened"));
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function download(): Promise<void> {
    if (!file) return;
    try {
      const r = await repoBlobTickets({ ...repoBody(p.target, ref), items: [{ path: file.path, download: true }] });
      const token = r.items?.[0]?.token;
      if (!token) return;
      const a = document.createElement("a");
      a.href = repoBlobUrl(token);
      a.download = file.path.split("/").pop() || "file";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  function copyClone(url?: string): void {
    if (!url) return;
    void navigator.clipboard.writeText(`git clone ${url}`).then(() => toast(t("ch.repo.copiedCloneCmd")));
  }

  const canMR = (cachedProviders().find((x) => x.id === provider)?.capabilities as any)?.code?.mergeRequests === "write";
  const refOptions = branches.map((b) => ({ value: b.name, label: b.name + (b.default ? t("ch.common.defaultTag") + "" : "") }));
  const crumbs = path ? path.split("/").filter(Boolean) : [];
  const localLabel = local?.found ? t("ch.repo.clonedTag") : t("ch.repo.notClonedTag");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 4px", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{repo.displayPath || repo.path}</span>
        <Tag>{instanceTitle(provider)}</Tag>
        {repo.defaultBranch ? <Tag>{t("ch.code.defaultBranch", { name: repo.defaultBranch })}</Tag> : null}
        <Tag title={local?.path || ""}>{localLabel}</Tag>
        <span style={{ flex: 1 }} />
        {repo.webUrl ? <Btn small onClick={() => window.open(repo.webUrl, "_blank", "noopener,noreferrer")}><Ic paths={ICONS.external} /> {t("ch.repo.web")}</Btn> : null}
        <Btn small onClick={() => (local?.found ? openFolder(local.path!, repo.name) : openClone({ provider, repo }))}>
          {local?.found ? t("ch.repo.openFolder") : t("ch.repo.cloneDots")}
        </Btn>
        <Btn small onClick={() => { setTab("files"); setPath(""); }}>{t("ch.repo.browseFiles")}</Btn>
      </div>
      <div style={{ padding: "0 14px" }}>
        <Tabs
          tabs={[
            { id: "overview", label: t("ch.repo.tabOverview") },
            { id: "files", label: t("ch.repo.tabFiles") },
            { id: "commits", label: t("ch.repo.tabCommits") },
            { id: "branches", label: t("ch.repo.tabBranches") },
            { id: "local", label: t("ch.repo.tabLocal") },
          ]}
          active={tab}
          onChange={(id) => { setTab(id as Tab); setErr(null); }}
        />
      </div>
      {err ? <div style={{ padding: "0 14px" }}><ErrBox text={err} onSetup={err === t("ch.err.authInvalid") ? () => openFloat(SETTINGS_KEY) : undefined} /></div> : null}
      {loading && tab !== "commits" ? <div style={{ padding: "0 14px" }}><Spinner /></div> : null}

      {tab === "overview" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 16px 16px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 12 }}>
            <Field label={t("ch.repo.fieldDefaultBranch")} value={ref || repo.defaultBranch || "—"} />
            <Field label={t("ch.repo.fieldLastUpdate")} value={fmtTime(repo.updatedAt) || "—"} />
            <Field label={t("ch.repo.fieldLocalClone")} value={local?.found ? local.path || t("ch.repo.foundTag") : t("ch.repo.notFoundClone")} />
            <Field label={t("ch.repo.fieldLocalBranch")} value={localRefs?.current || "—"} />
          </div>
          {repo.description ? <div style={{ ...S.muted, marginBottom: 10 }}>{repo.description}</div> : null}
          <Section title={t("ch.repo.sectionClone")}>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {repo.cloneHttp ? <Btn small onClick={() => copyClone(repo.cloneHttp)}>{t("ch.repo.copyHttps")}</Btn> : null}
              {repo.cloneSsh ? <Btn small onClick={() => copyClone(repo.cloneSsh)}>{t("ch.repo.copySsh")}</Btn> : null}
              <Btn small onClick={() => openClone({ provider, repo })}>{t("ch.repo.cloneToWorkspace")}</Btn>
            </div>
          </Section>
          <Section title={t("ch.repo.recentCommits")} right={<Btn small onClick={() => { setTab("commits"); setCommitPage(1); }}>{t("ch.repo.all")}</Btn>}>
            <CommitList items={commits.slice(0, 3)} onOpen={(sha) => { setTab("commits"); void openCommit(sha); }} />
          </Section>
        </div>
      ) : null}

      {tab === "files" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "6px 14px 12px" }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
            <Select value={ref} onChange={(v) => { setRef(v); setPath(""); setFile(null); }} options={refOptions.length ? refOptions : [{ value: "", label: t("ch.repo.defaultBranchOpt") }]} style={{ width: 170 }} />
            <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
              <button type="button" style={crumbBtn} onClick={() => { setPath(""); setFile(null); }}>{repo.name}</button>
              {crumbs.map((c, i) => (
                <span key={c + i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={S.dim}>/</span>
                  <button type="button" style={crumbBtn} onClick={() => { setPath(crumbs.slice(0, i + 1).join("/")); setFile(null); }}>{c}</button>
                </span>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <Btn small onClick={() => setPath(path.split("/").slice(0, -1).join("/"))} disabled={!path}>{t("ch.repo.parentDir")}</Btn>
          </div>
          <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
            <div style={{ width: file ? "42%" : "100%", minWidth: 220, overflowY: "auto", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8 }}>
              {entries.length === 0 && !loading ? <Empty text={t("ch.repo.emptyDir")} /> : null}
              {entries.map((e) => (
                <div key={e.path} style={{ ...S.row, borderRadius: 0, borderBottom: "1px solid var(--border, #2a2a2a)" }} onClick={() => void openFileAt(e)}>
                  <span style={{ width: 14, color: "var(--text-dim, #888)" }}>{e.type === "dir" ? "▸" : e.type === "submodule" ? "◈" : "·"}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={e.path}>{e.name}</span>
                  <span style={{ ...S.dim, minWidth: 58, textAlign: "right" }}>{e.type === "dir" ? "" : fmtSize(e.size)}</span>
                </div>
              ))}
            </div>
            {file ? (
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid var(--border, #3a3a3a)", flexWrap: "wrap" }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }} title={file.path}>{file.path}</span>
                  <Tag>{fmtSize(file.size)}</Tag>
                  {file.truncated ? <Tag>{t("ch.repo.truncated")}</Tag> : null}
                  {file.kind === "text" ? <Btn small onClick={() => void navigator.clipboard.writeText(file.text || "").then(() => toast(t("ch.common.copied")))}>{t("ch.common.copy")}</Btn> : null}
                  <Btn small onClick={() => void download()}>{t("ch.repo.download")}</Btn>
                  <Btn small onClick={() => void openInEditor()}>{t("ch.repo.openInEditor")}</Btn>
                  {/\.(md|markdown)$/i.test(file.path) && file.kind === "text" ? (
                    <Btn small onClick={() => setMdPreview((v) => !v)}>{mdPreview ? t("ch.repo.source") : t("ch.repo.preview")}</Btn>
                  ) : null}
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
                  {file.kind === "text" ? (
                    /\.(md|markdown)$/i.test(file.path) && mdPreview
                      ? <RichBody text={file.text} format="markdown" />
                      : <pre style={{ margin: 0, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{file.text}</pre>
                  ) : file.kind === "image" && file.blobToken ? (
                    <img src={repoBlobUrl(file.blobToken)} alt={file.path} style={{ maxWidth: "100%", borderRadius: 6, border: "1px solid var(--border, #3a3a3a)" }} />
                  ) : (
                    <Empty text={t("ch.repo.binaryHint")} action={<Btn small onClick={() => void download()}>{t("ch.repo.download")}</Btn>} />
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "commits" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 8, padding: "6px 14px 12px" }}>
          <div style={{ width: commitDetail ? "40%" : "100%", minWidth: 240, display: "flex", flexDirection: "column", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 8px", borderBottom: "1px solid var(--border, #3a3a3a)" }}>
              <Select value={ref} onChange={(v) => { setRef(v); setCommitPage(1); setCommitDetail(null); }} options={refOptions.length ? refOptions : [{ value: "", label: t("ch.repo.defaultBranchOpt") }]} style={{ flex: 1 }} />
              <Btn small onClick={() => setCommitPage((n) => Math.max(1, n - 1))} disabled={commitPage <= 1 || commitLoading}>{t("ch.repo.prevPage")}</Btn>
              <Btn small onClick={() => setCommitPage((n) => n + 1)} disabled={commitLoading || commits.length < 30}>{t("ch.repo.nextPage")}</Btn>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
              {commitLoading && commits.length === 0 ? <Spinner /> : null}
              <CommitList items={commits} onOpen={(sha) => void openCommit(sha)} />
            </div>
          </div>
          {commitDetail ? <CommitDetailPane commit={commitDetail} /> : null}
        </div>
      ) : null}

      {tab === "branches" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 14px 12px" }}>
          {branches.map((b) => {
            const fav = favBranches.includes(`${repo.path}#${b.name}`);
            const cloneUrl = repo.cloneHttp || repo.cloneSsh || "";
            return (
              <div key={b.name} style={{ ...S.row, flexWrap: "wrap" }}>
                <button
                  type="button"
                  title={fav ? t("ch.repo.favBranchRemove") : t("ch.repo.favBranchAdd")}
                  onClick={() => void starBranch(b)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: fav ? "var(--warn, #f59e0b)" : "var(--text-dim, #888)", padding: 0, display: "inline-flex" }}
                >
                  <Ic paths={ICONS.star} />
                </button>
                <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.name}</span>
                {b.default ? <Tag>{t("ch.common.defaultTag")}</Tag> : null}
                {b.protected ? <Tag>{t("ch.common.protectedTag")}</Tag> : null}
                {b.commit?.title ? <span style={{ ...S.dim, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={b.commit.title}>{b.commit.title}</span> : null}
                <Btn small title={t("ch.repo.browseFilesTitle")} onClick={() => { setRef(b.name); setPath(""); setFile(null); setTab("files"); }}>{t("ch.repo.tabFiles")}</Btn>
                <Btn small title={t("ch.repo.viewCommitsTitle")} onClick={() => { setRef(b.name); setCommitPage(1); setCommitDetail(null); setTab("commits"); }}>{t("ch.repo.tabCommits")}</Btn>
                <Btn small title={t("ch.repo.copyBranchName")} onClick={() => void navigator.clipboard.writeText(b.name).then(() => toast(t("ch.repo.copiedBranch")))}>{t("ch.common.copy")}</Btn>
                <Btn small title={t("ch.repo.copyCloneBTitle")} onClick={() => { if (cloneUrl) void navigator.clipboard.writeText(`git clone -b ${b.name} ${cloneUrl}`).then(() => toast(t("ch.repo.copiedCloneBCmd"))); }}>clone -b</Btn>
                {canMR ? <Btn small onClick={() => openMR({ provider, repo })}>MR</Btn> : null}
              </div>
            );
          })}
          {branches.length === 0 ? <Empty text={t("ch.repo.noBranches")} /> : null}
        </div>
      ) : null}

      {tab === "local" ? (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 16px 16px" }}>
          {!local?.found ? (
            <Empty
              text={t("ch.repo.noLocalClone")}
              action={<div style={{ display: "flex", gap: 8, justifyContent: "center" }}><Btn small onClick={() => openClone({ provider, repo })}>{t("ch.repo.cloneToWorkspace")}</Btn></div>}
            />
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 10 }}>
                <Field label={t("ch.repo.fieldLocalPath")} value={local.path || ""} />
                <Field label={t("ch.repo.fieldLocalBranch")} value={localRefs?.current || "—"} />
                <Field label={t("ch.repo.fieldDirtyFiles")} value={localRefs?.dirtyCount !== undefined ? String(localRefs.dirtyCount) : "—"} />
                <Field label="ahead/behind" value={Array.isArray(localRefs?.aheadBehind) ? `${localRefs.aheadBehind[0]} / ${localRefs.aheadBehind[1]}` : "—"} />
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                <Btn small primary onClick={() => openFolder(local.path!, repo.name)}>{t("ch.repo.openFolder")}</Btn>
                <Btn small onClick={() => openFile(local.path!)}>{t("ch.repo.openDirEditor")}</Btn>
                <Btn small onClick={() => { try { extSvc<{ setCwd?: (p: string) => void }>("pi-web.newSession")?.setCwd?.(local.path!); } catch { /* ignore */ } }}>{t("ch.repo.setSessionCwd")}</Btn>
                <Btn small onClick={() => void (async () => {
                  try {
                    const r = await fetch(apiUrl("/api/extensions/aiti-git-ops/git/log"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: local.path, cursor: 0 }) });
                    const d = await r.json().catch(() => null);
                    if (d?.lines) toast(t("ch.repo.localLoaded"));
                  } catch { /* ignore */ }
                })()}>{t("ch.repo.reloadLocal")}</Btn>
                <Btn small onClick={() => openClone({ provider, repo })}>{t("ch.repo.cloneAgain")}</Btn>
              </div>
              {localRefs?.branches?.length ? (
                <Section title={t("ch.repo.localBranches", { n: localRefs.branches.length })}>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {localRefs.branches.slice(0, 20).map((b: string) => <Tag key={b}>{b}</Tag>)}
                  </div>
                </Section>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Field(p: { label: string; value: string }) {
  return (
    <div>
      <div style={{ ...S.label, marginBottom: 1 }}>{p.label}</div>
      <div style={{ fontSize: 12, wordBreak: "break-word" }}>{p.value || "—"}</div>
    </div>
  );
}

const crumbBtn: Record<string, unknown> = {
  border: "none", background: "none", color: "var(--accent, #2563eb)", cursor: "pointer", fontSize: 12, padding: 0, fontFamily: "inherit",
};

function CommitList(p: { items: RepoCommit[]; onOpen: (sha: string) => void }) {
  if (!p.items.length) return <Empty text={t("ch.repo.noCommits")} />;
  return (
    <>
      {p.items.map((c) => (
        <div key={c.sha} style={{ ...S.row, alignItems: "flex-start" }} onClick={() => p.onOpen(c.sha)}>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "var(--text-muted, #999)", minWidth: 62 }}>{c.shortSha}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.message}>{c.title}</div>
            <div style={{ ...S.dim, marginTop: 2 }}>{c.author ? `${c.author} · ` : ""}{c.date ? fmtTime(new Date(c.date).getTime()) : ""}</div>
          </div>
        </div>
      ))}
    </>
  );
}

function CommitDetailPane(p: { commit: CommitDetail }) {
  const c = p.commit;
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--border, #3a3a3a)" }}>
        <div style={{ fontWeight: 600, fontSize: 12.5, wordBreak: "break-word" }}>{c.title}</div>
        <div style={{ ...S.dim, marginTop: 3 }}>{c.shortSha} · {c.author || "?"} · {c.date ? fmtTime(new Date(c.date).getTime()) : ""}{c.stats ? ` · +${c.stats.additions} -${c.stats.deletions}` : ""}</div>
        {c.message && c.message !== c.title ? <pre style={{ ...S.muted, margin: "6px 0 0", whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{c.message}</pre> : null}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px" }}>
        {c.files.length === 0 ? <Empty text={t("ch.repo.noDiff")} /> : null}
        {c.files.map((f) => (
          <div key={f.path + (f.oldPath || "")} style={{ marginBottom: 10, border: "1px solid var(--border, #3a3a3a)", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "4px 8px", background: "var(--bg-panel, #141414)", fontSize: 11.5 }}>
              <StateBadge state={f.status === "deleted" ? "closed" : "open"} status={f.status} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={f.path}>{f.path}</span>
              {f.oldPath ? <span style={S.dim}>{f.oldPath}</span> : null}
              <span style={S.dim}>+{f.additions || 0} -{f.deletions || 0}</span>
            </div>
            {f.binary ? <div style={{ ...S.dim, padding: "6px 8px" }}>{t("ch.repo.binaryFile")}</div> : null}
            {f.patch ? (
              <pre style={{ margin: 0, padding: "6px 8px", overflowX: "auto", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre" }}>
                {f.patch.split("\n").map((line, i) => (
                  <div key={i} style={{ color: line.startsWith("+") && !line.startsWith("+++") ? "var(--ok, #22c55e)" : line.startsWith("-") && !line.startsWith("---") ? "var(--danger, #f87171)" : line.startsWith("@@") ? "var(--accent, #2563eb)" : "inherit" }}>{line || " "}</div>
                ))}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
