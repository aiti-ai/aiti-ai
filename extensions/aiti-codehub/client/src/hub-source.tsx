/**
 * "Get a workspace" source tab: pick a provider → repo → branch → destination and
 * clone through the aiti-quickstart clone engine. Registered as a topic item
 * ("workspace-hub.source") consumed by aiti-quickstart.
 */
import { useEffect, useState, t } from "./host-shim";
import { listRepos, type Repo } from "./api";
import { instanceTitle, useProviders } from "./store";
import { InstanceSelect } from "./instance-picker";
import { CloneForm } from "./clone";
import { openFloat } from "../../../_shared/ext-float-dock-lite";
import { SETTINGS_KEY } from "./keys";
import { Btn, Empty, ErrBox, friendlyError, Ic, ICONS, Input, S, Spinner, useLocaleTick } from "./ui";

export function HubSource(p: { onEnter: (root: string, extra?: { url?: string }) => void }) {
  useLocaleTick();
  const { providers, groups, providerId, setProviderId } = useProviders("code");
  const [q, setQ] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<Repo | null>(null);

  async function load(): Promise<void> {
    if (!providerId) return;
    setLoading(true);
    setErr(null);
    try {
      const page = await listRepos(providerId, undefined, 1, 50, q.trim() || undefined);
      setRepos(page.items || []);
      setSelected(null);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, [providerId]);

  if (selected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <Btn small onClick={() => setSelected(null)}>{t("ch.hub.back")}</Btn>
          <span style={{ ...S.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.path}</span>
        </div>
        <CloneForm
          target={{ provider: providerId, repo: selected }}
          onDone={(root) => p.onEnter(root, { url: selected.cloneHttp || selected.cloneSsh })}
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <InstanceSelect value={providerId} onChange={setProviderId} instances={providers} groups={groups} style={{ width: 170 }} />
        {providerId ? <span style={{ ...S.dim, whiteSpace: "nowrap" }}>{instanceTitle(providerId)}</span> : null}
        <span style={{ flex: 1 }} />
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        <Input value={q} onChange={setQ} onEnter={() => void load()} placeholder={t("ch.hub.searchPh")} style={{ flex: 1 }} />
        <Btn small onClick={() => void load()} disabled={loading}><Ic paths={ICONS.search} /></Btn>
      </div>

      {loading ? <Spinner /> : null}
      {err ? <ErrBox text={err} onRetry={() => void load()} onSetup={err === t("ch.err.authInvalid") ? () => openFloat(SETTINGS_KEY) : undefined} /> : null}
      {!loading && !err && repos.length === 0 ? <Empty text={t("ch.common.noMatchRepo")} /> : null}

      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        {repos.map((r) => (
          <div key={r.id} style={S.row} onClick={() => setSelected(r)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{(r.displayPath || r.path) || r.name}</div>
              <div style={{ ...S.dim }}>{r.defaultBranch ? t("ch.hub.defaultBranch", { name: r.defaultBranch }) : ""}{r.archived ? t("ch.common.archivedTag") : ""}</div>
            </div>
            {r.cloneSsh || r.cloneHttp ? <span style={{ ...S.dim }}>{t("ch.hub.cloneable")}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
