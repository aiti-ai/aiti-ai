/**
 * tabs/SvcManagerCard — service management card for the Pi-web tab (SelfTab).
 *
 * Data source: the aiti-updater extension's /run-status API (form detection via
 * cgroup + systemctl UnitFileState persistence; launch sampling; version
 * compare). Actions go through the same extension's /register, /launch,
 * /bare/* and /service/* routes. When aiti-updater is not deployed the card
 * degrades to a one-line hint and never blocks the tab.
 */
import { useEffect, useRef, useState } from "react";

const UPD = "/api/extensions/aiti-updater";

type RunStatus = {
  form?: "service" | "manual" | "unknown";
  unit?: string | null;
  unitFile?: string | null;
  unitState?: string | null;
  unitEnabled?: string | null;
  pid?: number | null;
  uptimeMs?: number | null;
  serviceName?: string | null;
  displayName?: string | null;
  manager?: string | null;
  port?: number | null;
  basePath?: string | null;
  launch?: { cmd: string; args: string[]; cwd: string } | null;
  envKeys?: string[];
  versions?: { current?: string; latest?: string; upToDate?: boolean } | null;
  upgradeConfig?: string;
};

const tailPath = (p: string): string => {
  try {
    const parts = String(p).split("/").filter(Boolean);
    return parts.length <= 2 ? String(p) : "…/" + parts.slice(-2).join("/");
  } catch {
    return String(p);
  }
};

export function SvcManagerCard({ t, onChanged }: { t: (k: string, params?: Record<string, string>) => string; onChanged?: () => void }) {
  const [st, setSt] = useState<RunStatus | null>(null);
  const [avail, setAvail] = useState<boolean | null>(null); // null = checking
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [regName, setRegName] = useState("piweb");
  const [pf, setPf] = useState<any | null>(null);
  const [pfOpen, setPfOpen] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const poll = async () => {
    try {
      const r = await fetch(`${UPD}/run-status`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as RunStatus;
      if (alive.current) { setSt(j); setAvail(true); }
    } catch {
      if (alive.current) { setAvail(false); setSt(null); }
    }
  };
  // Event-driven refresh (mount + window focus / visibility / online), no interval: the run
  // form only changes through operator actions, and every action re-polls explicitly.
  useEffect(() => {
    poll();
    const onWake = () => { if (document.visibilityState !== "hidden") poll(); };
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, []);

  const sourcePage = () => ({ url: window.location.href.split("?tk=")[0], title: document.title });
  const post = async (path: string, body?: unknown) => {
    const r = await fetch(`${UPD}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j as any).error || `HTTP ${r.status}`);
    return j;
  };
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setMsg(null);
    try { await fn(); onChanged?.(); await poll(); } catch (e) { setMsg(t("services.svcFailed") + ": " + String((e as Error).message).slice(0, 120)); } finally { if (alive.current) setBusy(null); }
  };

  const card: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" };
  const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 };
  const kv: React.CSSProperties = { fontSize: 11.5, color: "var(--text-dim)" };
  const btn: React.CSSProperties = { padding: "3px 9px", fontSize: 11.5, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", cursor: busy ? "wait" : "pointer" };
  const danger: React.CSSProperties = { ...btn, color: "var(--danger, #f87171)", borderColor: "color-mix(in srgb, var(--danger, #f87171) 40%, var(--border))" };
  const primary: React.CSSProperties = { ...btn, background: "var(--accent)", borderColor: "var(--accent)", color: "var(--accent-contrast, #fff)", fontWeight: 600 };

  if (avail === false) {
    return (
      <div style={card}>
        <div style={label}>{t("services.svcTitle")}</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("services.svcUnavailable")}</div>
      </div>
    );
  }
  if (!st) {
    return (
      <div style={card}>
        <div style={label}>{t("services.svcTitle")}</div>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("services.svcLoading")}</div>
      </div>
    );
  }

  const form = st.form || "unknown";
  const isSvc = form === "service";
  const dotColor = form === "service" ? "var(--ok, #16a34a)" : form === "manual" ? "var(--warn, #d97706)" : "var(--text-dim)";
  const formLabel = isSvc ? t("services.svcFormService") : form === "manual" ? t("services.svcFormBare") : t("services.svcFormUnknown");
  const up = st.versions?.upToDate;

  return (
    <div style={card}>
      <div style={label}>{t("services.svcTitle")}</div>

      {/* single identity row: dot + form + name · manager · unit · cmd · port · cwd · latest */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", fontSize: 12 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0, boxShadow: `0 0 0 3px color-mix(in srgb, ${dotColor} 18%, transparent)` }} />
        <b>{formLabel}</b>
        <span style={kv}>·</span>
        {st.serviceName ? <span style={kv}><b style={{ color: "var(--text)" }}>{st.serviceName}</b>{st.manager ? ` · ${st.manager}` : ""}</span> : null}
        {st.unit ? <span style={kv} title={st.unitFile || ""}>· {t("services.svcUnit")} {st.unit}</span> : null}
        {st.launch ? <span style={kv} title={`${st.launch.cmd} ${(st.launch.args || []).join(" ")}`}>· {String(st.launch.cmd).split("/").pop()} {Array.isArray(st.launch.args) && st.launch.args[0] ? String(st.launch.args[0]).split("/").pop() : ""}</span> : null}
        <span style={kv}>· :{st.port ?? "?"}{st.launch?.cwd ? ` · ${tailPath(st.launch.cwd)}` : ""}</span>
        {st.versions?.latest ? (
          <span style={kv} title={t("services.svcVersionsTip")}>
            · {t("services.svcLatest")} {st.versions.latest} {up ? <span style={{ color: "var(--ok, #16a34a)" }}>✓</span> : <span style={{ color: "var(--accent)" }}>· {t("services.svcUpdateAvailable")}</span>}
          </span>
        ) : null}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* Upgrade hidden when the version compare says up to date (operator rule) */}
          {isSvc && !up ? (
            <button style={primary} disabled={busy !== null}
              onClick={() => act("upgrade", async () => {
                const j = await post("/launch", { source: sourcePage() }) as any;
                const rec = j?.recommended || (j?.urls || []).find((u: any) => u.reachable)?.url;
                if (rec) window.open(rec, "_blank");
              })}
              title={t("services.svcUpgradeHint")}>
              ↓ {t("services.svcUpgrade")}
            </button>
          ) : null}
          <button style={btn} disabled={busy !== null} onClick={() => setOpen(!open)}>ℹ {t("services.svcDetails")}</button>
          {!isSvc ? (
            <button style={primaryOutline()} disabled={busy !== null} onClick={async () => {
              setBusy("preflight"); setMsg(null);
              try {
                const r = await fetch(`${UPD}/register-preflight`).then((x) => x.json());
                setPf(r); setPfOpen(true);
              } catch (e) { setMsg(t("services.svcFailed") + ": " + String((e as Error).message).slice(0, 120)); }
              finally { setBusy(null); }
            }} title={t("services.svcRegisterHint")}>▶ {t("services.svcRegister")}</button>
          ) : null}
          <button style={btn} disabled={busy !== null} onClick={() => act("restart", async () => {
            // restart goes through the assistant too: the operator watches the
            // stop -> start -> health verification live; one auto-retry on a
            // failed start; terminal page stays up with the result.
            const gen = await post("/assist-plan", { plan: "restart-service" });
            const launched = await post("/launch", { config: gen.configPath, source: sourcePage() });
            const rec = launched?.recommended || (launched?.urls || []).find((u: any) => u.reachable)?.url;
            if (rec) window.open(rec, "_blank");
          })} title={t("services.svcRestartAssistantHint")}>⟳ {t("services.svcRestart")}</button>
          <button style={danger} disabled={busy !== null} onClick={() => act("stop", async () => {
            // terminal stop goes through the assistant: an external process
            // survives the parent going down and shows the stop output + the
            // stop verification. Confirm gate = the assistant window's trigger.
            const gen = await post("/assist-plan", { plan: "stop-service" });
            const launched = await post("/launch", { config: gen.configPath, source: sourcePage() });
            const rec = launched?.recommended || (launched?.urls || []).find((u: any) => u.reachable)?.url;
            if (rec) window.open(rec, "_blank");
          })} title={t("services.svcStopAssistantHint")}>⏹ {t("services.svcStop")}</button>
          {isSvc ? (
            <button style={danger} disabled={busy !== null} onClick={() => act("unregister", async () => {
              // unregister is terminal: it runs in the assistant so the process
              // cannot die mid-flight — the assistant shows the removal output,
              // the stop verification and the manual relaunch command.
              const gen = await post("/assist-plan", { plan: "unregister-service" });
              const launched = await post("/launch", { config: gen.configPath, source: sourcePage() });
              const rec = launched?.recommended || (launched?.urls || []).find((u: any) => u.reachable)?.url;
              if (rec) window.open(rec, "_blank");
            })} title={t("services.svcUnregisterHint")}>⤫ {t("services.svcUnregister")}</button>
          ) : null}
        </span>
      </div>

      {msg ? <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--danger, #f87171)" }}>{msg}</div> : null}

      {/* preflight three-state panel */}
      {pfOpen && pf ? (
        <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", marginTop: 8, fontSize: 11.5 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {pf.state === "free" && <span style={{ color: "var(--ok)" }}>✓ {t("services.pfFree")}</span>}
            {pf.state === "self-managed" && <span style={{ color: "var(--accent)" }}>✓ {t("services.pfSelfManaged")}</span>}
            {pf.state === "conflict" && <span style={{ color: "var(--danger, #f87171)" }}>⚠ {t("services.pfConflict")}</span>}
            {pf.state === "bare" && <span>{t("services.pfBare")}</span>}
          </div>
          {pf.occupierPid ? (
            <div style={{ color: "var(--text-dim)", marginBottom: 6 }}>
              {t("services.pfOccupier")}: pid {pf.occupierPid}{pf.occupierUnit ? ` · ${pf.occupierUnit}` : ""}{pf.occupierExecStart ? <div style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{pf.occupierExecStart}</div> : null}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {pf.state === "self-managed" ? (
              <>
                <button style={{ ...btn, color: "var(--ok)", borderColor: "var(--ok)" }} disabled={busy !== null} onClick={async () => {
                  setPfOpen(false); setMsg(t("services.pfAdopted")); onChanged?.(); await poll();
                }}>{t("services.pfAdopt")}</button>
                <button style={danger} disabled={busy !== null} onClick={async () => {
                  if (!window.confirm(t("services.svcRegisterConfirm"))) return;
                  const gen = await post("/register", { name: regName.trim() || "piweb", replace: true }) as any;
                  await post("/launch", { config: gen.configPath, source: sourcePage() });
                  setPfOpen(false);
                }}>{t("services.pfReregister")}</button>
              </>
            ) : null}
            {pf.state === "conflict" ? (
              <>
                <button style={danger} disabled={busy !== null} onClick={async () => {
                  if (!window.confirm(t("services.pfReplaceConfirm", { unit: String(pf.occupierUnit || "") }))) return;
                  const gen = await post("/register", { name: regName.trim() || "piweb", replace: true }) as any;
                  await post("/launch", { config: gen.configPath, source: sourcePage() });
                  setPfOpen(false);
                }}>{t("services.pfReplace")}</button>
                <button style={btn} onClick={() => setPfOpen(false)}>{t("services.pfCancel")}</button>
              </>
            ) : null}
            {pf.state === "free" || pf.state === "bare" ? (
              <>
                <button style={primary} disabled={busy !== null} onClick={async () => {
                  const gen = await post("/register", { name: regName.trim() || "piweb" }) as any;
                  await post("/launch", { config: gen.configPath, source: sourcePage() });
                  setPfOpen(false);
                }}>{t("services.svcRegister")}</button>
                <button style={btn} onClick={() => setPfOpen(false)}>{t("services.pfCancel")}</button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* register name row (bare form only) */}
      {!isSvc ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 11.5 }}>
          <span style={{ color: "var(--text-dim)" }}>{t("services.svcNameLabel")}</span>
          <input value={regName} onInput={(e: any) => setRegName(e.target.value)}
            style={{ padding: "3px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", width: 150 }} />
        </div>
      ) : null}

      {/* details table (Details toggles) — plain React nodes: run-status values are
          filesystem paths (and a path may legitimately contain markup characters) */}
      {open ? (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 11.5 }}>
          <tbody>
            {([
              [t("services.svcF"), form],
              st.serviceName ? [t("services.svcNameLabel"), <span><b>{st.serviceName}</b>{st.displayName ? ` (${st.displayName})` : ""}</span>] : null,
              st.manager ? [t("services.svcManager"), st.manager] : null,
              st.unit ? [t("services.svcUnit"), (
                <span>
                  {st.unit}
                  {st.unitFile ? <><br /><span style={{ opacity: 0.7 }}>{st.unitFile}</span></> : null}
                  {st.unitState ? <> · <span style={{ color: "var(--ok)" }}>{st.unitState}</span>{st.unitEnabled ? " · " + st.unitEnabled : null}</> : null}
                </span>
              )] : null,
              st.pid ? ["pid", String(st.pid)] : null,
              st.launch ? [t("services.svcCmd"), (
                <span>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{st.launch.cmd} {(st.launch.args || []).join(" ")}</span>
                  <br /><span style={{ opacity: 0.7 }}>cwd: {st.launch.cwd}</span>
                </span>
              )] : null,
              [t("services.svcListen"), `:${st.port ?? "?"} (127.0.0.1) · ${t("services.svcBasePath")} ${st.basePath || "/"}`],
              st.envKeys?.length ? ["env", st.envKeys.join(" · ")] : null,
              st.form === "manual" ? [t("services.svcStopHow"), t("services.svcStopHowVal")] : null,
              st.versions ? [t("services.svcVersions"), (
                <span>
                  current <b>{st.versions.current ?? "-"}</b> · {t("services.svcLatest")} <b>{st.versions.latest ?? "-"}</b>
                  {" · "}
                  {up ? <span style={{ color: "var(--ok)" }}>✓</span> : <span style={{ color: "var(--accent)" }}>{t("services.svcUpdateAvailable")}</span>}
                </span>
              )] : null,
            ] as Array<[string, React.ReactNode] | null>).filter((row): row is [string, React.ReactNode] => row !== null).map(([k, v], i) => (
              <tr key={i}>
                <td style={{ padding: "4px 0", color: "var(--text-dim)", whiteSpace: "nowrap", width: 110, verticalAlign: "top" }}>{k}</td>
                <td style={{ padding: "4px 0", wordBreak: "break-all" }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <div style={{ marginTop: 6, fontSize: 10.5, color: "var(--text-dim)" }}>{t("services.svcSource")}</div>
    </div>
  );

  function primaryOutline(): React.CSSProperties {
    return { ...btn, color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 55%, var(--border))", fontWeight: 600 };
  }
}
