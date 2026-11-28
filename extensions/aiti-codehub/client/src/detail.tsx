/**
 * Work item detail dialog (floating). Opened from the list/recent/hub via openWorkItem().
 */
import { useEffect, useState, t } from "./host-shim";
import { closePanel, openFloat, useGate } from "../../../_shared/ext-float-dock-lite";
import { getComments, getWorkItem, markUsage, type Scope, type WorkItem } from "./api";
import { aliasOf, loadConfig, platformLabelOf } from "./store";
import { apiUrl, currentCwd, extSvc, sendChat, setComposer, stageNewSession } from "./host-shim";
import { submitPick, usePickMode } from "./workitem-picker";
import { formatBranchName, formatWorkItemText } from "../../server/format.ts";
import { Btn, clip, ErrBox, FloatShell, friendlyError, fmtTime, Ic, ICONS, S, Spinner, StateBadge, Tag, toast, useLocaleTick } from "./ui";
import { fileIdentifierOf, fileProxyUrl, RichBody } from "./rich";
import { DETAIL_KEY, SETTINGS_KEY } from "./keys";

export interface DetailTarget {
  provider: string;
  scope: Scope;
  /** List row or a stub from recents; the full item is fetched on open. */
  item: WorkItem;
}

let target: DetailTarget | null = null;
const listeners = new Set<() => void>();

export function openWorkItem(tgt: DetailTarget): void {
  target = tgt;
  for (const l of listeners) {
    try { l(); } catch { /* ignore */ }
  }
  openFloat(DETAIL_KEY);
}

function useTarget(): DetailTarget | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return target;
}

export function WorkItemDetailFace() {
  const gate = useGate(DETAIL_KEY, "float");
  useLocaleTick();
  const tgt = useTarget();
  if (!gate || !tgt) return null;
  return (
    <FloatShell title={`#${tgt.item.key} ${tgt.item.title}`} width={860} height={660} onClose={() => closePanel(DETAIL_KEY)}>
      <DetailBody key={`${tgt.provider}:${tgt.scope.id}:${tgt.item.id}`} target={tgt} />
    </FloatShell>
  );
}

/** Detail body, shared by the detail float and the picker overlay (pass
 * onBack there). While a pick is active the toolbar gains a primary Select. */
export function DetailBody(p: { target: DetailTarget; onBack?: () => void }) {
  useLocaleTick();
  const picking = usePickMode();
  const { provider, scope, item: stub } = p.target;
  const [item, setItem] = useState<WorkItem | null>(null);
  const [comments, setComments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [usage, setUsage] = useState<any>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setErr(null);
    try {
      const [a, b] = await Promise.all([getWorkItem(provider, scope, stub.id), getComments(provider, scope, stub.id).catch(() => ({ comments: [] }))]);
      setItem(a.item);
      setUsage(a.usage || null);
      setComments(b.comments || []);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function templates(): Promise<{ paste: string; ai: string; branch: string }> {
    try {
      const c = await loadConfig();
      return (c as any)?.global?.templates || { paste: "#{id} {type} {title}", ai: "#{id} {type} {title}", branch: "{type}_{id}" };
    } catch {
      return { paste: "#{id} {type} {title}", ai: "#{id} {type} {title}", branch: "{type}_{id}" };
    }
  }

  async function copyMessage(): Promise<void> {
    if (!item) return;
    const tpl = await templates();
    await clip(formatWorkItemText(item, platformLabelOf(provider), tpl.paste, aliasOf(provider)));
    const u = await markUsage(provider, item.id, "paste").catch(() => null);
    if (u?.usage) setUsage(u.usage);
  }

  async function writeCommit(): Promise<void> {
    if (!item) return;
    const cwd = currentCwd();
    if (!cwd) { toast(t("ch.detail.needWorkspace")); return; }
    const tpl = await templates();
    const message = formatWorkItemText(item, platformLabelOf(provider), tpl.paste, aliasOf(provider));
    const svc = extSvc<{ open?: (p: { cwd?: string; message: string }) => boolean | Promise<boolean> }>("aiti-folder.commit");
    if (svc && typeof svc.open === "function") {
      const ok = await svc.open({ cwd, message });
      if (ok) {
        const u = await markUsage(provider, item.id, "paste").catch(() => null);
        if (u?.usage) setUsage(u.usage);
        toast(t("ch.detail.commitWritten"));
        return;
      }
    }
    await clip(message);
    toast(t("ch.detail.commitSvcMissing"));
  }

  async function createBranch(): Promise<void> {
    if (!item) return;
    const cwd = currentCwd();
    if (!cwd) { toast(t("ch.detail.needWorkspace")); return; }
    setBusy("branch");
    try {
      const tpl = await templates();
      const name = formatBranchName(item, platformLabelOf(provider), tpl.branch, aliasOf(provider));
      const r = await fetch(apiUrl("/api/extensions/aiti-git-ops/git/branch-create"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, name }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.ok) {
        toast(d?.error || t("ch.detail.branchFail", { code: r.status }));
        return;
      }
      setBranch(name);
      const u = await markUsage(provider, item.id, "branch", name).catch(() => null);
      if (u?.usage) setUsage(u.usage);
      toast(t("ch.detail.branchCreated", { name }));
    } finally {
      setBusy(null);
    }
  }

  async function sendCurrent(): Promise<void> {
    if (!item) return;
    const tpl = await templates();
    const text = formatWorkItemText(item, platformLabelOf(provider), tpl.ai, aliasOf(provider));
    if (sendChat(text, "followUp")) {
      const u = await markUsage(provider, item.id, "ai").catch(() => null);
      if (u?.usage) setUsage(u.usage);
      toast(t("ch.detail.sentCurrent"));
      return;
    }
    if (setComposer(text)) {
      toast(t("ch.detail.composerFilled"));
      return;
    }
    await clip(text);
  }

  /** Stage the content into the fresh new-session composer (no session is created): the
   * host remounts the composer on setCwd, so the write lands one tick later. */
  function fillStagedComposer(text: string): void {
    setTimeout(() => { if (!setComposer(text)) void clip(text); }, 120);
  }

  async function sendNew(): Promise<void> {
    if (!item) return;
    const cwd = currentCwd();
    if (!cwd) { toast(t("ch.detail.needWorkspace")); return; }
    const tpl = await templates();
    let text = formatWorkItemText(item, platformLabelOf(provider), tpl.ai, aliasOf(provider));
    /* Trailing platform URL — the same link the Open button opens. */
    const url = item?.webUrl || stub.webUrl;
    if (url) text += `\n\n${url}`;

    if (!stageNewSession(cwd)) {
      /* Old host without pi-web.newSession: still never auto-creates a session —
       * fill whatever composer is present and let the user pick the target. */
      setComposer(text);
      toast(t("ch.detail.newPrepared"));
      return;
    }

    /* File mode when the body is long or carries images/attachments: persist into
     * the workspace (attachments downloaded alongside) and reference it via @path. */
    const imgFileIds = (item.images || [])
      .map((src) => fileIdentifierOf(src))
      .filter((v): v is string => !!v);
    const attFiles = (item.attachments || []).map((a) => ({ fileId: a.id, name: a.name, kind: "attachment" }));
    const files = [
      ...imgFileIds.map((fileId, i) => ({ fileId, name: `image-${i + 1}.png`, kind: "image" })),
      ...attFiles,
    ];
    const heavy = files.length > 0 || text.length > 1500;
    try {
      if (heavy) {
        setBusy("note");
        const r = await fetch(apiUrl("/workspace/note"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider,
            cwd,
            id: item.id,
            title: item.title || `${item.type} ${item.key}`,
            text,
            files,
          }),
        });
        const d = await r.json().catch(() => null);
        if (!r.ok || !d?.ok) {
          toast(d?.error || t("ch.detail.noteFail", { err: String(d?.error || r.status) }));
          fillStagedComposer(text);
          return;
        }
        fillStagedComposer(`@${String(d.relPath)}`);
        toast(t("ch.detail.noteSaved", { path: String(d.relPath) }));
      } else {
        fillStagedComposer(text);
        toast(t("ch.detail.newPrepared"));
      }
      const u = await markUsage(provider, item.id, "ai").catch(() => null);
      if (u?.usage) setUsage(u.usage);
    } finally {
      setBusy(null);
    }
  }

  function openWeb(): void {
    const url = item?.webUrl || stub.webUrl;
    if (!url) { toast(t("ch.detail.noWebUrl")); return; }
    try { window.open(url, "_blank", "noopener,noreferrer"); } catch { /* ignore */ }
  }

  const it = item || stub;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div style={{ display: "flex", gap: 6, padding: "4px 14px 8px", flexWrap: "wrap", alignItems: "center", borderBottom: "1px solid var(--border, #3a3a3a)" }}>
        {p.onBack ? <Btn small onClick={() => p.onBack?.()}>{t("ch.pick.back")}</Btn> : null}
        {picking ? <Btn small primary disabled={loading && !item} onClick={() => void submitPick(it, provider)}>{t("ch.pick.choose")}</Btn> : null}
        <Btn small primary onClick={() => void copyMessage()}><Ic paths={ICONS.copy} /> {t("ch.detail.copy")}</Btn>
        <Btn small onClick={() => void writeCommit()}><Ic paths={ICONS.commit} /> {t("ch.detail.writeCommit")}</Btn>
        <Btn small onClick={() => void createBranch()} disabled={busy === "branch"}><Ic paths={ICONS.branch} /> {busy === "branch" ? t("ch.detail.branchCreating") : t("ch.detail.branchCreate")}</Btn>
        <span style={{ width: 1, height: 18, background: "var(--border, #3a3a3a)", margin: "0 2px" }} />
        <Btn small onClick={() => void sendCurrent()} disabled={busy === "note"}><Ic paths={ICONS.send} /> {t("ch.detail.sendCurrent")}</Btn>
        <Btn small onClick={() => void sendNew()} disabled={busy === "note"}><Ic paths={ICONS.robot} /> {busy === "note" ? t("ch.detail.preparing") : t("ch.detail.sendNew")}</Btn>
        <span style={{ flex: 1 }} />
        {usage?.sentToAIAt ? <Tag title={t("ch.wi.tagSentAI")}>{t("ch.detail.tagSentAI")}</Tag> : null}
        {usage?.pastedAt ? <Tag title={t("ch.wi.tagPasted")}>{t("ch.detail.tagWritten")}</Tag> : null}
        {branch || usage?.branch ? <Tag title={t("ch.detail.tagBranch")}>⎇ {branch || usage.branch}</Tag> : null}
        <Btn small onClick={openWeb}><Ic paths={ICONS.external} /> {t("ch.common.open")}</Btn>
        <Btn small onClick={() => void load()} disabled={loading}><Ic paths={ICONS.refresh} /></Btn>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 16px 18px" }}>
        {loading && !item ? <Spinner /> : null}
        {err ? <ErrBox text={err} onRetry={() => void load()} onSetup={err === t("ch.err.authInvalid") ? () => openFloat(SETTINGS_KEY) : undefined} /> : null}

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600, marginRight: 6 }}>#{it.key} {it.title}</span>
          <StateBadge state={it.state} status={it.status} />
          {it.type ? <Tag>{it.type}</Tag> : null}
          {it.priority ? <Tag>P{it.priority}</Tag> : null}
          {it.assignee ? <Tag>@{it.assignee}</Tag> : null}
          {it.tags?.map((t) => <Tag key={t}>{t}</Tag>)}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginBottom: 10 }}>
          <Field label={t("ch.detail.fieldScope")} value={`${scope.label}${scope.kind === "project" ? t("ch.detail.scopeProjectSuffix") : ""}`} />
          <Field label={t("ch.detail.fieldCreator")} value={it.creator || "—"} />
          <Field label={t("ch.detail.fieldCreatedAt")} value={fmtTime(it.createdAt) || "—"} />
          <Field label={t("ch.detail.fieldUpdatedAt")} value={fmtTime(it.updatedAt) || "—"} />
          {(it.extraFields || []).map((f) => <Field key={f.label} label={f.label} value={f.value} />)}
        </div>

        {it.attachments?.length ? (
          <>
            <div style={{ ...S.sectionTitle }}>{t("ch.detail.attachments", { n: it.attachments.length })}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
              {it.attachments.map((a) => (
                <a key={a.id} href={fileProxyUrl(a.id, it.id, provider, true)} target="_blank" rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent, #2563eb)", fontSize: 12, textDecoration: "none" }}>
                  <Ic paths={ICONS.external} /> {a.name}{a.size ? ` · ${Math.max(1, Math.round(a.size / 1024))} KB` : ""}
                </a>
              ))}
            </div>
          </>
        ) : null}

        <div style={{ ...S.sectionTitle }}>{t("ch.detail.description")}</div>
        {it.description || it.descriptionHtml ? (
          <RichBody text={it.description} html={it.descriptionHtml} format={it.descriptionFormat} workitemId={it.id} instance={provider} />
        ) : (
          <div style={S.muted}>{t("ch.detail.noDescription")}</div>
        )}
        {it.images?.length && !it.descriptionHtml && it.descriptionFormat !== "markdown" ? (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            {it.images.map((src, i) => (
              <a key={src + i} href={src} target="_blank" rel="noreferrer" title={src}>
                <img src={src} alt={`image ${i + 1}`} referrerPolicy="no-referrer" loading="lazy" style={{ maxWidth: 260, maxHeight: 180, borderRadius: 6, border: "1px solid var(--border, #3a3a3a)" }} />
              </a>
            ))}
          </div>
        ) : null}

        <div style={{ ...S.sectionTitle, marginTop: 14 }}>{t("ch.detail.comments", { n: comments.length })}</div>
        {comments.length === 0 ? <div style={S.muted}>{t("ch.detail.noComments")}</div> : null}
        {comments.map((c) => (
          <div key={c.id} style={{ padding: "7px 9px", border: "1px solid var(--border, #3a3a3a)", borderRadius: 7, marginBottom: 6 }}>
            <div style={{ display: "flex", gap: 8, ...S.dim, marginBottom: 3 }}>
              <span style={{ color: "var(--text-muted, #bbb)" }}>{c.author || "?"}</span>
              <span>{fmtTime(c.createdAt)}</span>
              {c.top ? <span style={{ color: "var(--accent, #2563eb)" }}>{t("ch.detail.pinned")}</span> : null}
            </div>
            <RichBody text={c.body} html={c.bodyHtml} format={c.bodyFormat} workitemId={it.id} instance={provider} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Field(p: { label: string; value: string }) {
  return (
    <div>
      <div style={{ ...S.label, marginBottom: 1 }}>{p.label}</div>
      <div style={{ fontSize: 12, wordBreak: "break-word" }}>{p.value}</div>
    </div>
  );
}
