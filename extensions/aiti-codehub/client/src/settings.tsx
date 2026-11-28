/**
 * Settings panel: providers + auth (PAT/OAuth) + global templates/defaults + integration status.
 * Used both as a tab inside the panels and as the standalone settings dialog.
 */
import { useEffect, useMemo, useState, t } from "./host-shim";
import {
  cancelDevice, createInstance, deleteInstance, saveConfig, testAuth, logout, startOAuth, deviceStatus,
  ghStatus, ghRefresh, type ConfigPayload, type ProviderInfo, type GhStatusResult,
} from "./api";
import { Btn, ErrBox, friendlyError, Ic, ICONS, Input, Select, Section, S, Spinner, tf, toast, useLocaleTick } from "./ui";
import { extSvc, subscribeBus } from "./host-shim";
import { InstanceTree, instanceStatusText } from "./instance-picker";
import { SETTINGS_PROVIDER_KEY } from "./keys";
import { applyConfig, emitChanged, instanceTitle, loadConfig } from "./store";

export function SettingsPanel(p: { compact?: boolean }) {
  useLocaleTick();
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState<string>(() => {
    try { return localStorage.getItem(SETTINGS_PROVIDER_KEY) || ""; } catch { return ""; }
  });
  const [form, setForm] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [oauthWaiting, setOauthWaiting] = useState<string | null>(null);
  const [device, setDevice] = useState<any>(null);
  const [gh, setGh] = useState<GhStatusResult | null>(null);
  const [ghBusy, setGhBusy] = useState(false);
  const [globalForm, setGlobalForm] = useState<any>({});
  const [creating, setCreating] = useState<{ platform: string; label: string } | null>(null);
  const [newAlias, setNewAlias] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const instances: ProviderInfo[] = useMemo(() => {
    const c = config as ConfigPayload | null;
    return (c?.instances?.length ? c.instances : c?.providers) || [];
  }, [config]);
  const platforms: ProviderInfo[] = useMemo(() => (config as any)?.providers || [], [config]);
  const current = instances.find((x) => x.id === active) || instances[0];
  const currentPlatform = String(current?.platform || current?.id || "");

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const c = await loadConfig(true);
      setConfig(c);
      const list: ProviderInfo[] = c.instances?.length ? c.instances : c.providers;
      const nextActive = list.find((x) => x.id === active)?.id || list[0]?.id || "";
      if (nextActive && nextActive !== active) {
        setActive(nextActive);
        try { localStorage.setItem(SETTINGS_PROVIDER_KEY, nextActive); } catch { /* ignore */ }
      }
      setGlobalForm((c as any).global || {});
      // Keep the other surfaces (pickers, hub source) in sync with instance changes.
      emitChanged();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  // reset the provider form when the active provider (or its status) changes
  useEffect(() => {
    if (!current) return;
    setConfirmDelete(false);
    setForm({
      alias: current.alias || "",
      authType: current.status.authType || (current.auth.oauth ? "oauth" : "pat"),
      token: "",
      clientId: current.status.clientId || "",
      clientSecret: "",
      orgId: current.status.orgId || "",
      baseUrl: current.status.baseUrl || "",
      ghHost: current.status.ghHost || "github.com",
      ghUser: current.status.ghUser || "",
      callbackMode: "default",
      customBase: "",
    });
  }, [current?.id, current?.alias, current?.status.authType, current?.status.clientId, current?.status.orgId, current?.status.baseUrl, current?.status.ghHost, current?.status.ghUser]);

  // OAuth completion: refresh status via the shared event bus (no polling)
  useEffect(() => {
    const off = subscribeBus((frame: any) => {
      if (frame?.type !== "aiti-codehub:oauth") return;
      if (oauthWaiting && String(frame.instance || frame.provider || "") !== oauthWaiting) return;
      setOauthWaiting(null);
      if (frame.ok === false) toast(t("ch.settings.oauthFail", { err: friendlyError(frame.error) || t("ch.settings.unknownErr") }));
      else { setDevice(null); toast(t("ch.settings.oauthDone")); }
      void load();
    }, ["aiti-codehub:oauth"]);
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, [oauthWaiting]);

  /** Keep the shared cache + other surfaces in sync with a mutation response. */
  function applyPayload(c: ConfigPayload): void {
    setConfig(c);
    applyConfig(c);
    emitChanged();
  }

  function switchProvider(id: string) {
    setActive(id);
    try { localStorage.setItem(SETTINGS_PROVIDER_KEY, id); } catch { /* ignore */ }
  }

  async function addAccount(): Promise<void> {
    if (!creating) return;
    const alias = newAlias.trim() || creating.label;
    setBusy("create");
    setErr(null);
    try {
      const c = await createInstance({ platform: creating.platform, alias });
      applyPayload(c);
      setCreating(null);
      setNewAlias("");
      const created = (c as any).created;
      if (created?.id) switchProvider(created.id);
      toast(t("ch.settings.addedAccount", { alias }));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function removeAccount(): Promise<void> {
    if (!current) return;
    setBusy("delete");
    setErr(null);
    try {
      const c = await deleteInstance(current.id);
      applyPayload(c);
      const list: ProviderInfo[] = c.instances?.length ? c.instances : c.providers;
      const next = list.find((x) => x.platform === currentPlatform) || list[0];
      if (next) switchProvider(next.id);
      setConfirmDelete(false);
      toast(t("ch.settings.deletedAccount", { name: current.alias || current.id }));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function setDefaultAccount(): Promise<void> {
    if (!current) return;
    setBusy("default");
    try {
      await saveConfig({ global: { defaultInstance: current.id } as any });
      await load();
      toast(t("ch.settings.setDefaultDone"));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveProvider(): Promise<boolean> {
    if (!current) return false;
    setBusy("save");
    setErr(null);
    try {
      const alias = String(form.alias || "").trim();
      await saveConfig({
        provider: current.id,
        config: {
          ...(alias && alias !== (current.alias || "") ? { alias, aliasAuto: false } : {}),
          authType: form.authType,
          ...(form.token ? { token: form.token } : {}),
          clientId: form.clientId || undefined,
          ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
          orgId: form.orgId || undefined,
          baseUrl: form.baseUrl || undefined,
          ghHost: form.authType === "gh" ? form.ghHost || "github.com" : undefined,
          ghUser: form.authType === "gh" ? form.ghUser || undefined : undefined,
        },
      });
      await load();
      toast(t("ch.settings.saved"));
      return true;
    } catch (e) {
      setErr(friendlyError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function detectGh(): Promise<void> {
    if (!current) return;
    setGhBusy(true);
    setErr(null);
    try {
      const r = await ghStatus(current.id, String(form.ghHost || "github.com"));
      setGh(r);
      if (!r.available) setErr(r.error || t("ch.settings.ghNotAvail"));
      else if (!r.accounts.length) setErr(r.error || t("ch.settings.ghNotLogin"));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setGhBusy(false);
    }
  }

  async function refreshGh(): Promise<void> {
    setGhBusy(true);
    try { await ghRefresh(); } catch { /* ignore */ }
    setGh(null);
    setGhBusy(false);
    await detectGh();
  }

  async function test(): Promise<void> {
    if (!current) return;
    setBusy("test");
    setErr(null);
    try {
      const r = await testAuth(current.id);
      toast(t("ch.settings.testOk", { name: r.account?.displayName || r.account?.username || "OK" }));
      await load();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function doLogout(): Promise<void> {
    if (!current) return;
    setBusy("logout");
    try {
      await logout(current.id);
      await load();
      toast(t("ch.settings.loggedOut"));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function oauthLogin(): Promise<void> {
    if (!current) return;
    setBusy("oauth");
    setErr(null);
    try {
      const callbackMode = (form.callbackMode as "default" | "page" | "custom") || "default";
      const r = await startOAuth(current.id, {
        callbackMode,
        ...(callbackMode === "custom" && form.customBase ? { customBase: String(form.customBase) } : {}),
      });
      setOauthWaiting(current.id);
      if (r.mode === "device-code") {
        setDevice(r.device);
        try { window.open(r.device.verificationUriComplete || r.device.verificationUri, "_blank", "noopener,noreferrer"); } catch { /* blocked */ }
        toast(t("ch.settings.devicePageOpened"));
      } else {
        try { window.open(r.url, "_blank", "noopener,noreferrer"); } catch { /* blocked */ }
        toast(t("ch.settings.oauthPageOpened"));
      }
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancelDeviceFlow(): Promise<void> {
    if (!current) return;
    try { await cancelDevice(current.id); } catch { /* ignore */ }
    setDevice(null);
    setOauthWaiting(null);
  }

  /** Manual/automatic check of the server-side device poll (no client polling). */
  async function checkDevice(): Promise<void> {
    if (!current) return;
    try {
      const s: any = await deviceStatus(current.id);
      if (s.state === "pending") {
        setDevice((d: any) => ({ ...(d || {}), ...s }));
        setOauthWaiting(current.id);
        return;
      }
      setDevice(null);
      setOauthWaiting(null);
      if (s.state === "success") {
        toast(t("ch.settings.oauthDone"));
        await load();
      } else if (s.state === "error" || s.state === "expired") {
        setErr(s.error === "device_code_expired" ? t("ch.settings.deviceExpired") : t("ch.settings.oauthFail", { err: friendlyError(s.error) || t("ch.settings.unknownErr") }));
        await load();
      } else {
        await load();
      }
    } catch (e) {
      setErr(friendlyError(e));
    }
  }

  // Returning from the browser (mobile app switch / new tab) refreshes once.
  useEffect(() => {
    const onVisible = () => {
      if (!current) return;
      if (!device && !oauthWaiting && !current.status.needsLogin) return;
      void checkDevice();
    };
    const onVis = () => { if (document.visibilityState === "visible") onVisible(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [device, oauthWaiting, current?.id, current?.status.needsLogin]);

  async function saveGlobal(): Promise<void> {
    setBusy("global");
    setErr(null);
    try {
      await saveConfig({
        global: {
          defaultInstance: globalForm.defaultInstance || undefined,
          pageSize: Number(globalForm.pageSize) || 50,
          excludeClosed: !!globalForm.excludeClosed,
          localRoots: Array.isArray(globalForm.localRoots) ? globalForm.localRoots : undefined,
          templates: {
            paste: String(globalForm.templates?.paste || ""),
            ai: String(globalForm.templates?.ai || ""),
            branch: String(globalForm.templates?.branch || ""),
          },
        },
      });
      await load();
      toast(t("ch.settings.globalSaved"));
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

  if (loading && !config) return <div style={{ padding: 16 }}><Spinner /></div>;
  if (err && !config) return <div style={{ padding: 12 }}><ErrBox text={err} onRetry={() => void load()} /></div>;

  /** Platform display name with alias-shaped fallback (server label). */
  function platformDisplay(x: ProviderInfo): string {
    return String(x.platformLabel || x.label || x.platform || x.id);
  }
  /** PAT field copy: translate by platform+fieldKey+role; the server descriptor value is the fallback. */
  function fieldText(platform: string, f: { key: string; label?: string; placeholder?: string; helpText?: string }, role: "label" | "placeholder" | "helpText"): string {
    const fb = role === "label" ? String(f.label ?? f.key) : role === "placeholder" ? String(f.placeholder ?? "") : String(f.helpText ?? "");
    return tf(`ch.prov.${platform}.field.${f.key}.${role}`, fb);
  }

  const integrations = [
    { name: t("ch.settings.integ.gitops.name"), ok: true, hint: t("ch.settings.integ.gitops.hint") },
    { name: t("ch.settings.integ.folderCommit.name"), ok: !!extSvc("aiti-folder.commit"), hint: t("ch.settings.integ.folderCommit.hint") },
    { name: t("ch.settings.integ.folderPick.name"), ok: !!extSvc("aiti-folder.pick"), hint: t("ch.settings.integ.folderPick.hint") },
    { name: t("ch.settings.integ.quickstart.name"), ok: !!extSvc("aiti-quickstart.open"), hint: t("ch.settings.integ.quickstart.hint") },
    { name: t("ch.settings.integ.eventBus.name"), ok: !!extSvc("aiti-event-bus.subscribe-topics"), hint: t("ch.settings.integ.eventBus.hint") },
    { name: t("ch.settings.integ.composer.name"), ok: !!extSvc("pi-web.composer"), hint: t("ch.settings.integ.composer.hint") },
  ];

  return (
    <div style={{ ...S.panel, height: "100%" }}>
      <div style={S.bar}>
        <span style={{ ...S.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {current
            ? (current.alias && current.alias !== (current.platformLabel || current.label)
              ? `${current.platformLabel || current.label} · ${current.alias}`
              : (current.platformLabel || current.label))
            : t("ch.settings.account")}
        </span>
        {current ? <span style={{ ...S.dim, whiteSpace: "nowrap" }}>{instanceStatusText(current)}</span> : null}
        <span style={{ flex: 1 }} />
        <Btn small onClick={() => void load()} title={t("ch.settings.refreshStatus")}>{t("ch.common.refresh")}</Btn>
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ width: 220, flexShrink: 0, overflowY: "auto", borderRight: "1px solid var(--border, #3a3a3a)", padding: "8px 6px" }}>
          <InstanceTree
            instances={instances}
            value={current?.id || ""}
            onSelect={(id) => { switchProvider(id); setConfirmDelete(false); }}
            onAdd={(platform) => {
              const pl = platforms.find((x) => String(x.id) === platform);
              setCreating({ platform, label: String(pl?.label || platform) });
              setNewAlias("");
            }}
            onRename={(it) => { switchProvider(it.id); toast(t("ch.settings.renameHint")); }}
            onDelete={(it) => { switchProvider(it.id); setConfirmDelete(true); }}
          />
        </div>
        <div style={{ ...S.body, flex: 1, minWidth: 0, padding: "10px 12px" }}>
        {err ? <ErrBox text={err} /> : null}

        {creating ? (
          <Section title={t("ch.settings.addAccountTitle", { platform: creating.label })}>
            <div style={{ ...S.muted, marginBottom: 8 }}>
              {t("ch.settings.addAccountHint")}
            </div>
            <label style={S.label}>{t("ch.settings.alias")}</label>
            <Input value={newAlias} onChange={setNewAlias} placeholder={t("ch.settings.aliasPh", { platform: creating.label })} />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <Btn primary small onClick={() => void addAccount()} disabled={busy === "create"}>{t("ch.settings.createConfig")}</Btn>
              <Btn small onClick={() => { setCreating(null); setNewAlias(""); }}>{t("ch.common.cancel")}</Btn>
            </div>
          </Section>
        ) : null}

        {current ? (
          <>
            <Section title={`${platformDisplay(current)}${current.alias && current.alias !== (current.platformLabel || current.label) ? " · " + current.alias : ""} · ${t("ch.settings.accountAuth")}`}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 10 }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <label style={S.label}>{t("ch.settings.aliasDisplay")}</label>
                  <Input value={String(form.alias || "")} onChange={(v) => setForm({ ...form, alias: v })} placeholder={platformDisplay(current)} />
                </div>
                <Btn small onClick={() => void saveProvider()} disabled={busy === "save"}>{t("ch.settings.saveAlias")}</Btn>
                <Btn small onClick={() => void setDefaultAccount()} disabled={busy === "default" || (globalForm.defaultInstance || "") === current.id}>
                  {(globalForm.defaultInstance || "") === current.id ? t("ch.settings.isDefault") : t("ch.settings.makeDefault")}
                </Btn>
                {confirmDelete ? (
                  <>
                    <Btn small primary onClick={() => void removeAccount()} disabled={busy === "delete"}>{t("ch.settings.confirmDelete")}</Btn>
                    <Btn small onClick={() => setConfirmDelete(false)}>{t("ch.common.cancel")}</Btn>
                  </>
                ) : (
                  <Btn small onClick={() => setConfirmDelete(true)} title={t("ch.settings.deleteHint")}>{t("ch.settings.deleteAccount")}</Btn>
                )}
              </div>
              <div style={{ ...S.muted, marginBottom: 8 }}>
                {current.virtual ? t("ch.settings.virtualHint") : ""}
                {current.status.account
                  ? t("ch.settings.loggedInAs", { name: current.status.account.displayName || current.status.account.username || "OK" }) + (current.status.orgId ? t("ch.settings.orgSuffix", { org: current.status.orgId }) : "")
                  : current.status.hasToken
                    ? t("ch.settings.loggedIn") + (current.status.accountError ? t("ch.settings.accountReadFail", { err: current.status.accountError }) : t("ch.settings.canTestHint"))
                    : t("ch.settings.notConfigured")}
                {current.status.needsLogin ? t("ch.settings.reloginNeeded") : ""}
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                {current.auth.pat ? (
                  <Btn small primary={form.authType === "pat"} onClick={() => setForm({ ...form, authType: "pat" })}>PAT</Btn>
                ) : null}
                {current.auth.oauth ? (
                  <Btn small primary={form.authType === "oauth"} onClick={() => setForm({ ...form, authType: "oauth" })}>OAuth</Btn>
                ) : null}
                {current.auth.gh ? (
                  <Btn small primary={form.authType === "gh"} onClick={() => { setForm({ ...form, authType: "gh", ghHost: form.ghHost || "github.com" }); void detectGh(); }}>{current.auth.gh.label || "gh CLI"}</Btn>
                ) : null}
                <span style={{ flex: 1 }} />
                {current.status.hasToken ? <Btn small onClick={() => void doLogout()} disabled={busy === "logout"}>{t("ch.settings.logout")}</Btn> : null}
                <Btn small onClick={() => void test()} disabled={busy === "test" || (!current.status.hasToken && form.authType !== "gh")}>
                  {busy === "test" ? t("ch.settings.testing") : t("ch.settings.testConn")}
                </Btn>
              </div>

              {form.authType === "pat" && current.auth.pat ? (
                <>
                  {current.auth.pat.fields.map((f) => (
                    <div key={f.key} style={{ marginBottom: 8 }}>
                      <label style={S.label}>
                        {fieldText(currentPlatform, f, "label")}{f.required ? " *" : ""}
                        {f.helpUrl ? (
                          <a href={f.helpUrl} target="_blank" rel="noreferrer" style={{ marginLeft: 8, color: "var(--accent, #2563eb)" }}>{t("ch.prov.getLink")}</a>
                        ) : null}
                      </label>
                      <Input
                        type={f.kind === "password" ? "password" : "text"}
                        value={String(form[f.key] ?? "")}
                        onChange={(v) => setForm({ ...form, [f.key]: v })}
                        placeholder={f.kind === "password" && current.status.hasToken ? t("ch.settings.savedKeepHint") : fieldText(currentPlatform, f, "placeholder")}
                      />
                      {f.helpText ? <div style={{ ...S.dim, marginTop: 3 }}>{fieldText(currentPlatform, f, "helpText")}</div> : null}
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn primary small onClick={() => void saveProvider()} disabled={busy === "save"}>{t("ch.settings.saveBtn")}</Btn>
                    <Btn small onClick={() => void test()} disabled={busy === "test" || !current.status.hasToken}>{t("ch.settings.testBtn")}</Btn>
                  </div>
                </>
              ) : null}

              {form.authType === "gh" && current.auth.gh ? (
                <>
                  <div style={{ ...S.muted, marginBottom: 8 }}>
                    <span dangerouslySetInnerHTML={{ __html: t("ch.settings.ghIntro") }} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                    <Btn small onClick={() => void detectGh()} disabled={ghBusy}>{ghBusy ? t("ch.settings.detecting") : t("ch.settings.detectGh")}</Btn>
                    <Btn small onClick={() => void refreshGh()} disabled={ghBusy}>{t("ch.settings.refreshGhCache")}</Btn>
                    {current.auth.gh.helpUrl ? <a href={current.auth.gh.helpUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent, #2563eb)" }}>{t("ch.settings.installGh")}</a> : null}
                  </div>
                  {gh ? (
                    !gh.available ? (
                      <div style={{ ...S.dim, marginBottom: 8 }}>{gh.error || t("ch.settings.ghNoAvailHint")}</div>
                    ) : gh.accounts.length === 0 ? (
                      <div style={{ ...S.dim, marginBottom: 8 }}>{gh.error || t("ch.settings.ghNoLoginHint")}</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
                        {gh.accounts.map((a) => {
                          const selected = (form.ghHost || "github.com") === a.host && (form.ghUser || "") === a.login;
                          return (
                            <div key={a.host + "/" + a.login} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 8px", border: "1px solid " + (selected ? "var(--accent, #2563eb)" : "var(--border, #3a3a3a)"), borderRadius: 8 }}>
                              <b>{a.login}</b>
                              <span style={S.dim}>{a.host}{a.active ? " · active" : ""}</span>
                              <span style={{ ...S.dim, flex: 1, minWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.scopes}>{a.scopes}</span>
                              <Btn small primary={selected} onClick={() => setForm({ ...form, authType: "gh", ghHost: a.host, ghUser: a.login })}>{selected ? t("ch.settings.ghUsed") : t("ch.settings.ghUse")}</Btn>
                            </div>
                          );
                        })}
                      </div>
                    )
                  ) : null}
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Btn primary small onClick={async () => { const ok = await saveProvider(); if (ok) void test(); }} disabled={busy === "save"}>{t("ch.settings.saveAndUse")}</Btn>
                    <span style={S.dim}>{t("ch.settings.saveTestHint")}</span>
                  </div>
                </>
              ) : null}

              {form.authType === "oauth" && current.auth.oauth ? (
                <>
                  <div style={{ ...S.muted, marginBottom: 8 }}>
                    {current.auth.oauth.mode === "dcr-pkce"
                      ? t("ch.settings.oauthDcrHint")
                      : current.auth.oauth.mode === "device-code"
                        ? t("ch.settings.oauthDeviceHint")
                        : t("ch.settings.oauthAppHint")}
                  </div>

                  {current.auth.oauth.refresh === false ? (
                    <div style={{ ...S.muted, marginBottom: 8, color: "var(--warn, #fbbf24)" }}>
                      {t("ch.settings.oauthNoRefresh")}
                    </div>
                  ) : null}

                  {current.auth.oauth.mode === "dcr-pkce" ? (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        <label style={S.label}>{t("ch.settings.callbackMode")}</label>
                        <Select
                          value={String(form.callbackMode || "default")}
                          onChange={(v) => setForm({ ...form, callbackMode: v })}
                          options={[
                            { value: "default", label: t("ch.settings.cbDefault") },
                            { value: "page", label: t("ch.settings.cbPage") },
                            { value: "custom", label: t("ch.settings.cbCustom") },
                          ]}
                        />
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <label style={S.label}>{t("ch.settings.cbBaseLabel")}</label>
                        <Input value={String(globalForm.oauthCallbackBase || "")} onChange={(v) => setGlobalForm({ ...globalForm, oauthCallbackBase: v })} placeholder="http://127.0.0.1:30141" />
                        <div style={{ ...S.dim, marginTop: 3 }}>{t("ch.settings.cbBaseHint")}</div>
                      </div>
                      {form.callbackMode === "custom" ? (
                        <div style={{ marginBottom: 8 }}>
                          <label style={S.label}>{t("ch.settings.cbCustomLabel")}</label>
                          <Input value={String(form.customBase || "")} onChange={(v) => setForm({ ...form, customBase: v })} placeholder="http://127.0.0.1:30141/dev" />
                        </div>
                      ) : null}
                      <div style={{ marginBottom: 8 }}>
                        <label style={S.label}>{t("ch.settings.cbActualLabel")}</label>
                        {(["default", "page"] as const).map((k) => {
                          const uri = current.redirectUris?.[k];
                          if (!uri) return null;
                          return (
                            <div key={k} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                              <code style={{ flex: 1, minWidth: 0, padding: "4px 6px", fontSize: 10.5, background: "var(--bg-panel, #141414)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{uri}</code>
                              <Btn small onClick={() => void navigator.clipboard.writeText(uri).then(() => toast(t("ch.common.copied")))}>{t("ch.common.copy")}</Btn>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : null}

                  {current.auth.oauth.mode === "client-credentials" ? (
                    <>
                      <div style={{ marginBottom: 8 }}>
                        <label style={S.label}>{t("ch.settings.clientId")}</label>
                        <Input value={String(form.clientId || "")} onChange={(v) => setForm({ ...form, clientId: v })} />
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <label style={S.label}>{t("ch.settings.clientSecret")}</label>
                        <Input
                          type="password"
                          value={String(form.clientSecret || "")}
                          onChange={(v) => setForm({ ...form, clientSecret: v })}
                          placeholder={current.status.hasClientSecret ? t("ch.settings.savedKeepHint") : ""}
                        />
                      </div>
                    </>
                  ) : null}

                  {current.auth.oauth.mode === "device-code" ? (
                    <div style={{ marginBottom: 8 }}>
                      <label style={S.label}>{t("ch.settings.sharedClientId")}</label>
                      <Input value={String(form.clientId || "")} onChange={(v) => setForm({ ...form, clientId: v })} placeholder={current.auth.oauth.defaultClientId ? t("ch.settings.sharedAppBuiltin", { id: current.auth.oauth.defaultClientId }) : t("ch.settings.clientIdPh")} />
                      <div style={{ ...S.dim, marginTop: 3 }}>
                        {current.auth.oauth.defaultClientId
                          ? t("ch.settings.sharedAppBuiltin", { id: current.auth.oauth.defaultClientId })
                          : t("ch.settings.sharedAppHint")}
                        {currentPlatform === "gitlab" ? t("ch.settings.gitlabNonConfidential") : ""}
                      </div>
                    </div>
                  ) : null}

                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Btn primary small onClick={() => void oauthLogin()} disabled={busy === "oauth"}>
                      {current.status.hasToken ? t("ch.settings.relogin") : t("ch.settings.oauthLogin")}
                    </Btn>
                    {current.auth.oauth.mode === "client-credentials" ? (
                      <Btn small onClick={() => void saveProvider()} disabled={busy === "save"}>{t("ch.settings.saveAppCreds")}</Btn>
                    ) : null}
                    {current.auth.oauth.mode === "device-code" ? (
                      <Btn small onClick={() => void saveProvider()} disabled={busy === "save"}>{t("ch.settings.saveClientId")}</Btn>
                    ) : null}
                    {oauthWaiting ? <span style={S.muted}>{t("ch.settings.waitingOAuth")}</span> : null}
                  </div>

                  {device ? (
                    <div style={{ marginTop: 8, padding: "8px 10px", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8 }}>
                      <div style={{ ...S.label }}>{t("ch.settings.deviceCode")}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <code style={{ fontSize: 16, letterSpacing: 2, padding: "3px 8px", border: "1px dashed var(--accent, #2563eb)", borderRadius: 6 }}>{device.userCode}</code>
                        <a href={device.verificationUriComplete || device.verificationUri} target="_blank" rel="noreferrer" style={{ color: "var(--accent, #2563eb)" }}>{t("ch.settings.openAuthPage")}</a>
                        <Btn small primary onClick={() => void checkDevice()}>{t("ch.settings.authorizedRefresh")}</Btn>
                        <Btn small onClick={() => void cancelDeviceFlow()}>{t("ch.common.cancel")}</Btn>
                      </div>
                      <div style={{ ...S.dim, marginTop: 4 }}>{t("ch.settings.deviceAutoHint")}</div>
                    </div>
                  ) : current.status.needsLogin && form.authType === "oauth" ? (
                    <div style={{ marginTop: 8, padding: "8px 10px", border: "1px solid var(--warn, #b45309)", borderRadius: 8 }}>
                      <div style={{ ...S.label }}>{t("ch.settings.incompleteAuth")}</div>
                      <div style={{ ...S.dim, marginTop: 3 }}>{t("ch.settings.incompleteAuthHint")}</div>
                      <div style={{ marginTop: 6 }}><Btn small primary onClick={() => void oauthLogin()}>{t("ch.settings.regetDeviceCode")}</Btn></div>
                    </div>
                  ) : null}
                </>
              ) : null}

              <div style={{ marginTop: 10 }}>
                <label style={S.label}>{t("ch.settings.apiBaseLabel")}</label>
                <Input
                  value={String(form.baseUrl || "")}
                  onChange={(v) => setForm({ ...form, baseUrl: v })}
                  placeholder={current.defaultBaseUrl || ""}
                />
                {currentPlatform === "yunxiao" ? (
                  <div style={{ ...S.dim, marginTop: 3 }}>{t("ch.settings.yunxiaoApiHint")}</div>
                ) : null}
                <div style={{ marginTop: 6 }}>
                  <Btn small onClick={() => void saveProvider()} disabled={busy === "save"}>{t("ch.settings.saveBtn")}</Btn>
                </div>
              </div>
            </Section>

            {current.auth.oauth ? (
              <Section title={t("ch.settings.oauthGuide")}>
                <div style={{ ...S.muted, lineHeight: 1.7 }}>
                  {currentPlatform === "yunxiao" ? (
                    <span dangerouslySetInnerHTML={{ __html: t("ch.settings.guideYunxiao") }} />
                  ) : currentPlatform === "github" ? (
                    <span dangerouslySetInnerHTML={{ __html: t("ch.settings.guideGithub") }} />
                  ) : currentPlatform === "gitee" ? (
                    <span dangerouslySetInnerHTML={{ __html: t("ch.settings.guideGitee") }} />
                  ) : (
                    <span dangerouslySetInnerHTML={{ __html: t("ch.settings.guideGitlab") }} />
                  )}
                </div>
                <div style={{ ...S.dim, marginTop: 6 }}>
                  {t("ch.settings.docsLine")}
                </div>
              </Section>
            ) : null}
          </>
        ) : null}

        <Section title={t("ch.settings.globalDefaults")}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            <div>
              <label style={S.label}>{t("ch.settings.defaultAccount")}</label>
              <Select
                value={String(globalForm.defaultInstance || globalForm.defaultProvider || "")}
                onChange={(v) => setGlobalForm({ ...globalForm, defaultInstance: v })}
                options={[{ value: "", label: t("ch.settings.autoFirst") }, ...instances.map((x) => ({ value: x.id, label: instanceTitle(x.id) }))]}
              />
            </div>
            <div>
              <label style={S.label}>{t("ch.settings.pageSize")}</label>
              <Input
                type="number"
                value={String(globalForm.pageSize ?? 50)}
                onChange={(v) => setGlobalForm({ ...globalForm, pageSize: Number(v) || 50 })}
              />
            </div>
            <div>
              <label style={S.label}>{t("ch.settings.excludeClosed")}</label>
              <Select
                value={globalForm.excludeClosed === false ? "0" : "1"}
                onChange={(v) => setGlobalForm({ ...globalForm, excludeClosed: v === "1" })}
                options={[{ value: "1", label: t("ch.common.yes") }, { value: "0", label: t("ch.common.no") }]}
              />
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={S.label}>{t("ch.settings.pasteTemplate")}</label>
            <Input
              value={String(globalForm.templates?.paste || "")}
              onChange={(v) => setGlobalForm({ ...globalForm, templates: { ...(globalForm.templates || {}), paste: v } })}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={S.label}>{t("ch.settings.aiTemplate")}</label>
            <Input
              value={String(globalForm.templates?.ai || "")}
              onChange={(v) => setGlobalForm({ ...globalForm, templates: { ...(globalForm.templates || {}), ai: v } })}
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={S.label}>{t("ch.settings.localRoots")}</label>
            <Input
              value={Array.isArray(globalForm.localRoots) ? globalForm.localRoots.join("\n") : "~/workspace"}
              onChange={(v) => setGlobalForm({ ...globalForm, localRoots: v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) })}
              placeholder="~/workspace"
            />
          </div>
          <div style={{ marginTop: 8 }}>
            <label style={S.label}>{t("ch.settings.branchTemplate")}</label>
            <Input
              value={String(globalForm.templates?.branch || "")}
              onChange={(v) => setGlobalForm({ ...globalForm, templates: { ...(globalForm.templates || {}), branch: v } })}
            />
            <div style={{ ...S.dim, marginTop: 3 }}>{t("ch.settings.branchVarsHint")}</div>
          </div>
          <div style={{ marginTop: 8 }}>
            <Btn primary small onClick={() => void saveGlobal()} disabled={busy === "global"}>{t("ch.settings.saveGlobalBtn")}</Btn>
          </div>
        </Section>

        <Section title={t("ch.settings.integrationsTitle")}>
          {integrations.map((i) => (
            <div key={i.name} style={{ display: "flex", gap: 8, alignItems: "center", padding: "3px 0", fontSize: 11.5 }}>
              <span style={{ color: i.ok ? "var(--ok, #22c55e)" : "var(--text-dim, #888)" }}>{i.ok ? "✓" : "○"}</span>
              <span style={{ flex: 1 }}>{i.name}</span>
              <span style={S.dim}>{i.hint}</span>
            </div>
          ))}
        </Section>
        </div>
      </div>
    </div>
  );
}

export function SettingsFace(props: { onClose: () => void }) {
  return <SettingsPanel compact />;
}
