/**
 * tabs/DdnsTab — P3b DDNS 管理 tab（provider 凭据 / profiles / 注册条目）。
 *
 * - 数据与库自带 UI / CLI 同一 registry 文件（双开互查，方案 §8 判据）
 * - 文案单源消费合并进来的库键 ui.ddns.*（server/i18n.ts 域过滤合并）
 * - provider 120 家下拉（/ddns-providers）；token 遮蔽 + 👁；必填/格式校验行内报错
 */
import { useEffect, useState } from "react";
import { apiUrl } from "../host-shim";

type T = (key: string, params?: Record<string, string>) => string;

interface DdnsRegistry {
  providerProfiles?: Record<string, { provider?: string; token?: string }>;
  profiles?: Record<string, { providerProfile?: string; zone?: string; record?: string; txtName?: string }>;
  entries?: Array<Record<string, unknown>>;
}

const input = { padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, width: "100%", boxSizing: "border-box" as const };
const btn = { padding: "4px 12px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 };
const card = { border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", padding: "10px 12px", marginBottom: 10 };
const label = { fontSize: 10, color: "var(--text-muted)", display: "block", marginBottom: 2 };
const th = { textAlign: "left" as const, padding: "4px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600, fontSize: 10 };
const td = { padding: "4px 8px", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text)" };

/** token 单元格：遮蔽显示 + 👁 切换（数据已在本进程，本地揭示）。 */
function TokenCell({ value, t }: { value: string | undefined; t: T }) {
  const [shown, setShown] = useState(false);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontFamily: "var(--font-mono)" }}>{shown ? value || "—" : "••••••••"}</span>
      <button onClick={() => setShown(!shown)} title={shown ? t("ui.ddns.hide") : t("ui.ddns.reveal")} style={{ ...btn, padding: "1px 6px", border: "none", display: "inline-flex", alignItems: "center" }}><svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg></button>
    </span>
  );
}

export function DdnsTab({ t }: { t: T }) {
  const [reg, setReg] = useState<DdnsRegistry | null>(null);
  const [providers, setProviders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch(apiUrl("/api/extensions/service-tunnels/ddns-registry"))
      .then((r) => r.json())
      .then((d: DdnsRegistry & { error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setReg({ providerProfiles: d.providerProfiles ?? {}, profiles: d.profiles ?? {}, entries: d.entries ?? [] });
        setError(null);
      })
      .catch((e) => setError(String(e)));
  };
  useEffect(() => {
    load();
    fetch(apiUrl("/api/extensions/service-tunnels/ddns-providers"))
      .then((r) => r.json())
      .then((d: { providers?: string[] }) => setProviders(d.providers ?? []))
      .catch(() => setProviders([]));
  }, []);

  const save = async (next: DdnsRegistry) => {
    setBusy(true);
    try {
      const r = await fetch(apiUrl("/api/extensions/service-tunnels/ddns-registry"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const d = (await r.json()) as { error?: string };
      if (d.error) setError(d.error);
      else { setError(null); setReg(next); }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!reg) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)", padding: 12 }}>{t("services.loading")}</div>;
  }
  const pps = reg.providerProfiles ?? {};
  const profs = reg.profiles ?? {};
  const entries = reg.entries ?? [];
  const isEmpty = !Object.keys(pps).length && !Object.keys(profs).length && !entries.length;

  return (
    <div>
      {error && <div style={{ fontSize: 11, color: "var(--danger, #f87171)", margin: "0 0 8px" }}>{t("services.exposeFailed")}: {error}</div>}
      {isEmpty && (
        <div style={{ ...card, textAlign: "center", padding: "22px 12px" }}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>🌐</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("ui.ddns.emptyTitle")}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.7 }}>{t("services.ddnsEmptyGuide")}</div>
        </div>
      )}

      {/* ── Provider 凭据 ── */}
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "2px 0 8px" }}>{t("ui.ddns.pp.title")}</div>
        {Object.keys(pps).length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
            <thead><tr><th style={th}>{t("ui.ddns.pp.name")}</th><th style={th}>{t("ui.ddns.pp.provider")}</th><th style={th}>token</th><th style={{ width: 70 }} /></tr></thead>
            <tbody>
              {Object.entries(pps).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{k}</td>
                  <td style={td}>{v.provider}</td>
                  <td style={td}><TokenCell value={v.token} t={t} /></td>
                  <td style={td}><button disabled={busy} style={{ ...btn, color: "var(--danger, #f87171)" }}
                    onClick={() => { const next = { ...reg, providerProfiles: { ...pps } }; delete next.providerProfiles![k]; save(next); }}>
                    {t("ui.ddns.del")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{t("ui.ddns.pp.empty")}</div>
        )}
        <AddProviderProfile t={t} providers={providers} busy={busy} onAdd={(name, provider, token) =>
          save({ ...reg, providerProfiles: { ...pps, [name]: { provider, token } } })} />
      </div>

      {/* ── Profiles ── */}
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "2px 0 8px" }}>{t("ui.ddns.pf.title")}</div>
        {Object.keys(profs).length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
            <thead><tr><th style={th}>{t("ui.ddns.pf.name")}</th><th style={th}>{t("ui.ddns.pf.pp")}</th><th style={th}>zone</th><th style={th}>record</th><th style={th}>txtName</th><th style={{ width: 70 }} /></tr></thead>
            <tbody>
              {Object.entries(profs).map(([k, v]) => (
                <tr key={k}>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{k}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{v.providerProfile || "—"}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{v.zone}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{v.record || "—"}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{v.txtName || "—"}</td>
                  <td style={td}><button disabled={busy} style={{ ...btn, color: "var(--danger, #f87171)" }}
                    onClick={() => { const next = { ...reg, profiles: { ...profs } }; delete next.profiles![k]; save(next); }}>
                    {t("ui.ddns.del")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{t("ui.ddns.pf.empty")}</div>
        )}
        <AddProfile t={t} ppKeys={Object.keys(pps)} busy={busy} onAdd={(name, pp, zone, record, txtName) =>
          save({ ...reg, profiles: { ...profs, [name]: { providerProfile: pp, zone, record: record || undefined, txtName: txtName || undefined } } })} />
      </div>

      {/* ── 注册条目 ── */}
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "2px 0 8px" }}>{t("ui.ddns.e.title")}</div>
        {entries.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 8 }}>
            <thead><tr><th style={th}>{t("ui.ddns.e.name")}</th><th style={th}>kind</th><th style={th}>{t("ui.ddns.e.target")}</th><th style={th}>zone</th><th style={th}>{t("ui.ddns.e.flags")}</th><th style={{ width: 70 }} /></tr></thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${String(e.name)}-${i}`}>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{String(e.name ?? "")}</td>
                  <td style={td}>{String(e.kind ?? "")}</td>
                  <td style={td}>{e.profile ? `profile: ${String(e.profile)}` : e.provider ? String(e.provider) : e.providerProfile ? `pp: ${String(e.providerProfile)}` : "—"}</td>
                  <td style={{ ...td, fontFamily: "var(--font-mono)" }}>{String(e.zone ?? "—")}</td>
                  <td style={td}>{[
                    [e.ip, "A"], [e.aaaa, "AAAA"], [e.txt, "TXT(ip:port)"], [e.cname, "CNAME"], [e.txtUrl, "TXT(url)"],
                  ].filter(([on]) => on).map(([, l]) => l).join(" ") || "—"}</td>
                  <td style={td}><button disabled={busy} style={{ ...btn, color: "var(--danger, #f87171)" }}
                    onClick={() => save({ ...reg, entries: entries.filter((_, j) => j !== i) })}>
                    {t("ui.ddns.del")}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{t("ui.ddns.e.empty")}</div>
        )}
        <AddEntry t={t} profKeys={Object.keys(profs)} providers={providers} busy={busy} onAdd={(entry) =>
          save({ ...reg, entries: [...entries, entry] })} />
      </div>
    </div>
  );
}

function ErrLine({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return <div style={{ fontSize: 10, color: "var(--danger, #f87171)", margin: "4px 0" }}>{msg}</div>;
}

function AddProviderProfile({ t, providers, busy, onAdd }: {
  t: T; providers: string[] | null; busy: boolean;
  onAdd: (name: string, provider: string, token: string) => void;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const n = name.trim();
    if (!n) return setErr(t("ui.ddns.err.name"));
    if (!provider) return setErr(t("ui.ddns.err.provider"));
    if (!token) return setErr(t("ui.ddns.err.token"));
    setErr(null);
    onAdd(n, provider, token);
    setName(""); setToken("");
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 110px" }}><label style={label}>{t("ui.ddns.pp.name")} *</label>
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="cloudflare-main" /></div>
        <div style={{ flex: "1 1 150px" }}><label style={label}>{t("ui.ddns.pp.provider")} *</label>
          <select style={input} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="">{t("ui.ddns.pickProvider", { n: String(providers?.length ?? 0) })}</option>
            {(providers ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
          </select></div>
        <div style={{ flex: "1 1 160px" }}><label style={label}>token *</label>
          <input style={input} type={show ? "text" : "password"} value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></div>
        <button disabled={busy} style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }} onClick={add}>＋ {t("ui.ddns.add")}</button>
      </div>
      <ErrLine msg={err} />
    </div>
  );
}

function AddProfile({ t, ppKeys, busy, onAdd }: {
  t: T; ppKeys: string[]; busy: boolean;
  onAdd: (name: string, pp: string, zone: string, record: string, txtName: string) => void;
}) {
  const [f, setF] = useState({ name: "", pp: "", zone: "", record: "", txtName: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const add = () => {
    const name = f.name.trim();
    const zone = f.zone.trim();
    if (!name) return setErr(t("ui.ddns.err.name"));
    if (!f.pp) return setErr(t("ui.ddns.err.pp"));
    if (!zone) return setErr(t("ui.ddns.err.zone"));
    if (!zone.includes(".") || /\s/.test(zone)) return setErr(t("ui.ddns.err.zoneFormat"));
    setErr(null);
    onAdd(name, f.pp, zone, f.record.trim(), f.txtName.trim());
    setF({ name: "", pp: "", zone: "", record: "", txtName: "" });
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 110px" }}><label style={label}>{t("ui.ddns.pf.name")} *</label><input style={input} value={f.name} onChange={set("name")} placeholder="home-tunnel" /></div>
        <div style={{ flex: "1 1 130px" }}><label style={label}>{t("ui.ddns.pf.pp")} *</label>
          <select style={input} value={f.pp} onChange={set("pp")}>
            <option value="">{t("services.selectProvider")}</option>
            {ppKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select></div>
        <div style={{ flex: "1 1 130px" }}><label style={label}>zone *</label><input style={input} value={f.zone} onChange={set("zone")} placeholder="example.com" /></div>
        <div style={{ flex: "1 1 130px" }}><label style={label}>record</label><input style={input} value={f.record} onChange={set("record")} /></div>
        <div style={{ flex: "1 1 140px" }}><label style={label}>txtName</label><input style={input} value={f.txtName} onChange={set("txtName")} /></div>
        <button disabled={busy} style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }} onClick={add}>＋ {t("ui.ddns.add")}</button>
      </div>
      <ErrLine msg={err} />
    </div>
  );
}

const FLAGS: Array<[keyof Record<string, boolean>, string]> = [["cname", "CNAME"], ["txtUrl", "TXT(url)"], ["ip", "A"], ["aaaa", "AAAA"], ["txt", "TXT(ip:port)"]];

function AddEntry({ t, profKeys, providers, busy, onAdd }: {
  t: T; profKeys: string[]; providers: string[] | null; busy: boolean;
  onAdd: (entry: Record<string, unknown>) => void;
}) {
  // mode: "profile"（profile 引用）| "full"（完整信息，单独注册）
  const [mode, setMode] = useState<"profile" | "full">(profKeys.length ? "profile" : "full");
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [provider, setProvider] = useState("");
  const [token, setToken] = useState("");
  const [zone, setZone] = useState("");
  const [record, setRecord] = useState("");
  const [txtName, setTxtName] = useState("");
  const [kind, setKind] = useState("tunnel");
  const [follow, setFollow] = useState("");
  const [flags, setFlags] = useState<Record<string, boolean>>({ ip: true, txt: true });
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const n = name.trim();
    const anyFlag = Object.values(flags).some(Boolean);
    const zoneTrim = zone.trim();
    if (!n) return setErr(t("ui.ddns.err.name"));
    if (mode === "profile" && !profile) return setErr(t("ui.ddns.err.profile"));
    if (mode === "full" && !provider) return setErr(t("ui.ddns.err.provider"));
    if (mode === "full" && !zoneTrim) return setErr(t("ui.ddns.err.zone"));
    if (!anyFlag) return setErr(t("ui.ddns.err.flag"));
    setErr(null);
    onAdd({
      name: n,
      kind,
      ...(mode === "profile" ? { profile } : { provider, token: token || undefined, zone: zoneTrim, record: record.trim() || undefined, txtName: txtName.trim() || undefined }),
      followTunnel: follow.trim() || undefined,
      cname: !!flags.cname, txtUrl: !!flags.txtUrl, ip: !!flags.ip, aaaa: !!flags.aaaa, txt: !!flags.txt,
    });
    setName(""); setToken(""); setZone(""); setRecord(""); setTxtName(""); setFollow("");
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, margin: "2px 0 8px", fontSize: 11 }}>
        {(["profile", "full"] as const).map((m) => (
          <label key={m} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: mode === m ? "var(--text)" : "var(--text-dim)" }}>
            <input type="radio" checked={mode === m} onChange={() => setMode(m)} style={{ accentColor: "var(--accent)" }} />
            {m === "profile" ? t("ui.ddns.e.addByProfile") : t("ui.ddns.e.addFull")}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 110px" }}><label style={label}>{t("ui.ddns.e.name")} *</label><input style={input} value={name} onChange={(e) => setName(e.target.value)} /></div>
        {mode === "profile" ? (
          <div style={{ flex: "1 1 130px" }}><label style={label}>{t("ui.ddns.pf.name")} *</label>
            <select style={input} value={profile} onChange={(e) => setProfile(e.target.value)}>
              <option value="">{t("services.selectProvider")}</option>
              {profKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select></div>
        ) : (
          <>
            <div style={{ flex: "1 1 130px" }}><label style={label}>{t("ui.ddns.pp.provider")} *</label>
              <select style={input} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">{t("ui.ddns.pickProvider", { n: String(providers?.length ?? 0) })}</option>
                {(providers ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
              </select></div>
            <div style={{ flex: "1 1 130px" }}><label style={label}>token</label><input style={input} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></div>
            <div style={{ flex: "1 1 120px" }}><label style={label}>zone *</label><input style={input} value={zone} onChange={(e) => setZone(e.target.value)} /></div>
            <div style={{ flex: "1 1 120px" }}><label style={label}>record</label><input style={input} value={record} onChange={(e) => setRecord(e.target.value)} /></div>
            <div style={{ flex: "1 1 130px" }}><label style={label}>txtName</label><input style={input} value={txtName} onChange={(e) => setTxtName(e.target.value)} /></div>
          </>
        )}
        <div style={{ flex: "0 0 100px" }}><label style={label}>kind</label>
          <select style={input} value={kind} onChange={(e) => setKind(e.target.value)}>
            {["tunnel", "portmap", "ipv6"].map((k) => <option key={k} value={k}>{k}</option>)}
          </select></div>
        <div style={{ flex: "1 1 110px" }}><label style={label}>followTunnel</label><input style={input} value={follow} onChange={(e) => setFollow(e.target.value)} /></div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "8px 0", fontSize: 11 }}>
        {FLAGS.map(([k, l]) => (
          <label key={String(k)} style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
            <input type="checkbox" checked={!!flags[String(k)]} onChange={(e) => setFlags({ ...flags, [String(k)]: e.target.checked })} style={{ accentColor: "var(--accent)" }} />
            {l}
          </label>
        ))}
      </div>
      <ErrLine msg={err} />
      <button disabled={busy} style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }} onClick={add}>＋ {t("ui.ddns.add")}</button>
    </div>
  );
}
