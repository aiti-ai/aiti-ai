/**
 * Merge request dialog (Yunxiao only in this version).
 */
import { useEffect, useState, t } from "./host-shim";
import { closePanel, openFloat, useGate } from "../../../_shared/ext-float-dock-lite";
import { createMR, listBranches, type Branch, type Repo } from "./api";
import { Btn, ErrBox, FloatShell, friendlyError, Input, Select, S, Spinner, toast, useLocaleTick } from "./ui";
import { MR_KEY } from "./keys";

export interface MRTarget {
  provider: string;
  repo: Repo;
}

let target: MRTarget | null = null;
const listeners = new Set<() => void>();

export function openMR(t: MRTarget): void {
  target = t;
  for (const l of listeners) { try { l(); } catch { /* ignore */ } }
  openFloat(MR_KEY);
}

function useTarget(): MRTarget | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return target;
}

export function MRFace() {
  const gate = useGate(MR_KEY, "float");
  useLocaleTick();
  const tgt = useTarget();
  if (!gate || !tgt) return null;
  return (
    <FloatShell title={`${t("ch.dlg.mr")} · ${tgt.repo.displayPath || tgt.repo.path}`} width={560} height={520} onClose={() => closePanel(MR_KEY)}>
      <MRForm key={`${tgt.provider}:${tgt.repo.id}`} target={tgt} onDone={() => closePanel(MR_KEY)} />
    </FloatShell>
  );
}

function MRForm(p: { target: MRTarget; onDone: () => void }) {
  useLocaleTick();
  const { provider, repo } = p.target;
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("");
  const [targetBranch, setTargetBranch] = useState(repo.defaultBranch || "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workItemIds, setWorkItemIds] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void listBranches(provider, repo, 1, 200)
      .then((r) => {
        if (!alive) return;
        const items = r.items || [];
        setBranches(items);
        const def = items.find((b) => b.default)?.name || repo.defaultBranch || "";
        setTargetBranch((cur) => cur || def);
        const firstFeature = items.find((b) => !b.default)?.name || "";
        setSource((cur) => cur || firstFeature);
      })
      .catch(() => { if (alive) setBranches([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [provider, repo.id]);

  async function submit(): Promise<void> {
    if (!title.trim() || !source.trim() || !targetBranch.trim()) {
      setErr(t("ch.mr.missingFields"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await createMR({
        provider,
        repo,
        sourceBranch: source.trim(),
        targetBranch: targetBranch.trim(),
        title: title.trim(),
        description: description.trim() || undefined,
        workItemIds: workItemIds ? workItemIds.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
      toast(t("ch.mr.created"));
      if (r.mr?.webUrl) {
        try { window.open(r.mr.webUrl, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
      }
      p.onDone();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }

  const branchOptions = branches.map((b) => ({ value: b.name, label: b.name + (b.default ? `（${t("ch.common.defaultTag")}）` : "") }));

  return (
    <div style={{ padding: "8px 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      {loading ? <Spinner /> : null}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div>
          <label style={S.label}>{t("ch.mr.sourceBranch")}</label>
          <Select value={source} onChange={setSource} options={[{ value: "", label: t("ch.common.select") }, ...branchOptions]} />
        </div>
        <div>
          <label style={S.label}>{t("ch.mr.targetBranch")}</label>
          <Select value={targetBranch} onChange={setTargetBranch} options={[{ value: "", label: t("ch.common.select") }, ...branchOptions]} />
        </div>
      </div>
      <div>
        <label style={S.label}>{t("ch.mr.titleField")}</label>
        <Input value={title} onChange={setTitle} placeholder={t("ch.mr.titlePh")} />
      </div>
      <div>
        <label style={S.label}>{t("ch.mr.description")}</label>
        <textarea
          value={description}
          onChange={(e: any) => setDescription(e.target.value)}
          rows={5}
          style={{ ...S.input, resize: "vertical" }}
        />
      </div>
      <div>
        <label style={S.label}>{t("ch.mr.relatedItems")}</label>
        <Input value={workItemIds} onChange={setWorkItemIds} placeholder={t("ch.mr.itemsPh")} />
      </div>
      {err ? <ErrBox text={err} /> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <Btn primary small onClick={() => void submit()} disabled={busy}>{busy ? t("ch.mr.creating") : t("ch.mr.create")}</Btn>
      </div>
    </div>
  );
}
