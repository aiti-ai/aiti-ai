/**
 * Clone dialog: pick a branch + protocol + destination directory, then reuse the
 * aiti-quickstart clone engine (staging / progress / never-overwrite) and switch the
 * new-session workspace to the cloned root.
 */
import { useEffect, useState, t } from "./host-shim";
import { apiUrl, extSvc } from "./host-shim";
import { closePanel, openFloat, useGate } from "../../../_shared/ext-float-dock-lite";
import { listBranches, type Branch, type Repo } from "./api";
import { Btn, clip, ErrBox, FloatShell, friendlyError, Ic, ICONS, Input, Select, S, Spinner, toast, useLocaleTick } from "./ui";
import { CLONE_KEY } from "./keys";

export interface CloneTarget {
  provider: string;
  repo: Repo;
}

let target: CloneTarget | null = null;
const listeners = new Set<() => void>();

export function openClone(t: CloneTarget): void {
  target = t;
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
  openFloat(CLONE_KEY);
}

function useTarget(): CloneTarget | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return target;
}

export function CloneFace() {
  const gate = useGate(CLONE_KEY, "float");
  useLocaleTick();
  const tgt = useTarget();
  if (!gate || !tgt) return null;
  return (
    <FloatShell title={t("ch.clone.title", { name: tgt.repo.displayPath || tgt.repo.path })} width={520} height={480} onClose={() => closePanel(CLONE_KEY)}>
      <CloneForm key={`${tgt.provider}:${tgt.repo.id}`} target={tgt} onDone={() => closePanel(CLONE_KEY)} />
    </FloatShell>
  );
}

export function CloneForm(p: { target: CloneTarget; onDone?: (root: string) => void }) {
  useLocaleTick();
  const { provider, repo } = p.target;
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(true);
  const [branch, setBranch] = useState(repo.defaultBranch || "");
  const [protocol, setProtocol] = useState<"https" | "ssh">(repo.cloneHttp ? "https" : "ssh");
  const [dest, setDest] = useState("~/workspace");
  const [depth, setDepth] = useState(true);
  const [submodules, setSubmodules] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBranchesLoading(true);
    void listBranches(provider, repo, 1, 100)
      .then((r) => { if (alive) setBranches(r.items || []); })
      .catch(() => { if (alive) setBranches([]); })
      .finally(() => { if (alive) setBranchesLoading(false); });
    return () => { alive = false; };
  }, [provider, repo.id]);

  const url = protocol === "ssh" ? repo.cloneSsh : repo.cloneHttp;

  async function pickDir(): Promise<void> {
    const svc = extSvc<{ directory?: (p: { initialPath?: string }) => Promise<string | null> }>("aiti-folder.pick");
    if (!svc?.directory) {
      toast(t("ch.clone.dirSvcMissing"));
      return;
    }
    try {
      const picked = await svc.directory({ initialPath: dest || "~/workspace" });
      if (picked) setDest(picked);
    } catch (e) {
      toast((e as Error).message);
    }
  }

  async function go(): Promise<void> {
    if (!url) { setErr(t("ch.clone.noCloneUrl")); return; }
    setBusy(true);
    setErr(null);
    setProgress(t("ch.clone.progressing"));
    try {
      const r = await fetch(apiUrl("/api/extensions/aiti-quickstart/workspace/clone"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, branch: branch.trim() || undefined, dir: dest.trim() || undefined, depth: depth ? 1 : undefined, submodules }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.ok) {
        setErr(d?.error || t("ch.clone.failHttp", { code: r.status, url }));
        return;
      }
      const root = String(d.root || "");
      toast(t("ch.clone.clonedTo", { root }));
      try { extSvc<{ setCwd?: (p: string) => void }>("pi-web.newSession")?.setCwd?.(root); } catch { /* ignore */ }
      p.onDone?.(root);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div style={{ padding: "8px 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ ...S.muted }}>
        {(repo.displayPath || repo.path)}{repo.description ? ` · ${repo.description}` : ""}
      </div>
      <div>
        <label style={S.label}>{t("ch.clone.branch")}</label>
        <div style={{ display: "flex", gap: 6 }}>
          <Select
            value={branch}
            onChange={setBranch}
            options={[{ value: "", label: t("ch.clone.defaultBranchOpt") }, ...branches.map((b) => ({ value: b.name, label: b.name + (b.default ? `（${t("ch.common.defaultTag")}）` : "") }))]}
            style={{ flex: 1 }}
          />
          {branchesLoading ? <Spinner text="" /> : null}
        </div>
      </div>
      <div>
        <label style={S.label}>{t("ch.clone.protocol")}</label>
        <Select
          value={protocol}
          onChange={(v) => setProtocol(v === "ssh" ? "ssh" : "https")}
          options={[
            ...(repo.cloneHttp ? [{ value: "https", label: "HTTPS" }] : []),
            ...(repo.cloneSsh ? [{ value: "ssh", label: "SSH" }] : []),
          ]}
        />
        <div style={{ ...S.dim, marginTop: 3, wordBreak: "break-all" }}>{url || t("ch.clone.noUrl")}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, ...S.muted, cursor: "pointer" }}>
          <input type="checkbox" checked={depth} onChange={(e: any) => setDepth(!!e.target.checked)} />
          {t("ch.clone.depthOpt")}
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, ...S.muted, cursor: "pointer" }}>
          <input type="checkbox" checked={submodules} onChange={(e: any) => setSubmodules(!!e.target.checked)} />
          {t("ch.clone.submodulesOpt")}
        </label>
      </div>
      <div>
        <label style={S.label}>{t("ch.clone.destParent")}</label>
        <div style={{ display: "flex", gap: 6 }}>
          <Input value={dest} onChange={setDest} placeholder="~/workspace" style={{ flex: 1 }} />
          <Btn small onClick={() => void pickDir()}><Ic paths={ICONS.folder} /> {t("ch.clone.pick")}</Btn>
        </div>
      </div>
      {progress ? <div style={S.muted}>{progress}</div> : null}
      {err ? <ErrBox text={err} /> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn primary small onClick={() => void go()} disabled={busy || !url}>{busy ? t("ch.clone.cloning") : t("ch.clone.start")}</Btn>
        {url ? <Btn small onClick={() => void clip(`git clone${depth ? " --depth 1" : ""}${submodules ? " --recurse-submodules" : ""}${branch ? ` -b ${branch}` : ""} ${url}`)}>{t("ch.clone.copyCmd")}</Btn> : null}
      </div>
    </div>
  );
}
