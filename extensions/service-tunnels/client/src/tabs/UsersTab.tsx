/**
 * tabs/UsersTab — 认证用户/站点管理 tab（M2 拆壳；自 ServicesDialog.tsx 原位迁出，逻辑零改动）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, useIsMobile, apiUrl } from "../host-shim";
import { FaceCaptureModal } from "../face-capture";
import type { SiteInfo } from "../dialog/types";

/** 明显是 IP/本机回环的 host：TOTP 标识不直接用（退回 pi-web 部署域名）。 */
function isIpLikeHost(h: string): boolean {
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true; // IPv4
  return h.includes(":"); // IPv6
}

/** 公开隧道服务的随机子域（bore/ngrok/cloudflared/localtunnel/…）。 */
const TUNNEL_HOST_SUFFIXES = [
  ".bore.pub", ".loca.lt", ".localhost.run", ".ngrok.io", ".ngrok-free.app", ".ngrok.app",
  ".trycloudflare.com", ".serveo.net", ".tunnelmole.net", ".sharedwithexpose.com",
  ".natappfree.cc", ".natapp.cc",
];

/** TOTP 标识的默认 host：浏览器当前域名；明显是 IP 或隧道随机域名时
 *  用 pi-web 预定义部署域名（PI_WEB_BASE_DOMAIN 等环境变量）。 */
function pickTotpHost(browserHost: string | undefined, piWebHost: string): string {
  const h = (browserHost ?? "").toLowerCase();
  if (isIpLikeHost(h)) return piWebHost;
  if (TUNNEL_HOST_SUFFIXES.some((s) => h.endsWith(s))) return piWebHost;
  return h || piWebHost;
}

/**
 * Auth user management — pick a provider with a local user database, list
 * users, add / set-password / remove, and toggle TOTP 2FA (portal provider).
 */
/** 站点（认证域）管理：增删站点。受保护站点（default 隐式 / pi-web = self 页
 *  默认认证域）锁死不可删（🔒 徽标 + 按钮禁用）；删除两步确认。
 *  布局参考 service-tunnels 自带 UI 的 sites 页签（名称/provider/状态/删）。 */
function SitesManageSection({ t, isMobile, sites, protectedSites, providers, onAdd, onRemove }: {
  t: (key: string, params?: Record<string, string>) => string;
  isMobile: boolean;
  sites: SiteInfo[] | null;
  protectedSites: string[];
  /** 可选 provider 清单（库 providerOrder）；选 "auto" = 平台默认。 */
  providers: string[];
  onAdd: (name: string, provider: string) => Promise<{ error?: string }>;
  onRemove: (name: string) => Promise<{ error?: string }>;
}) {
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 两步确认：首点记住待删站点名，再点「确认删除」才执行
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const input = { padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flex: 1, minWidth: 0, boxSizing: "border-box" as const };
  const btn = { padding: "4px 12px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 };

  const add = async () => {
    const n = name.trim().toLowerCase();
    if (!n || busy) return;
    setBusy(true);
    setError(null);
    const res = await onAdd(n, provider);
    setBusy(false);
    if (res.error) setError(res.error);
    else setName("");
  };

  const remove = async (n: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await onRemove(n);
    setBusy(false);
    setConfirmDel(null);
    if (res.error) setError(res.error);
  };

  return (
    <div style={{ margin: "0 0 14px", padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{t("services.sitesManage")}</div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", margin: "2px 0 6px" }}>{t("services.sitesManageHint")}</div>
      {error && <div style={{ fontSize: 11, color: "#f87171", margin: "4px 0" }}>{error}</div>}
      {sites === null ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "4px 0" }}>{t("services.loading")}</div>
      ) : (
        <>
          {sites.map((s) => {
            const isProtected = protectedSites.includes(s.name);
            return (
              <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", flexShrink: 0 }}>{s.name}</span>
                <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", fontSize: 10, flexShrink: 0 }}>{s.provider || "auto"}</span>
                {s.policy && <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-dim)", fontSize: 10, flexShrink: 0 }}>{s.policy}</span>}
                {/* 站点是认证域配置（惰性启动：有暴露时 provider 进程才跑）。
                 * 未运行是常态——不显示任何状态，避免误读为“已停止/故障”；
                 * 运行中（当前有暴露）才显示“● 运行中”。 */}
                {s.running && <span style={{ fontSize: 10, color: "#16a34a", flexShrink: 0 }}>● {t("services.tunnelRunning")}</span>}
                {isProtected && (
                  <span title={t("services.sitesProtectedHint")}
                    style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--accent)", fontSize: 10, flexShrink: 0, cursor: "help" }}>
                    🔒 {t("services.sitesProtected")}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  disabled={isProtected || busy}
                  title={isProtected ? t("services.sitesProtectedHint") : t("services.sitesRemoveHint")}
                  onClick={() => { setConfirmDel(confirmDel === s.name ? null : s.name); setError(null); }}
                  style={{ ...btn, color: isProtected ? "var(--text-dim)" : "#f87171", cursor: isProtected ? "not-allowed" : "pointer", opacity: isProtected ? 0.5 : 1 }}
                >
                  {t("services.sitesRemove")}
                </button>
                {confirmDel === s.name && !isProtected && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", width: isMobile ? "100%" : undefined }}>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", flex: 1, minWidth: 120 }}>{t("services.sitesRemoveConfirm", { name: s.name })}</span>
                    <button onClick={() => remove(s.name)} disabled={busy} style={{ ...btn, color: "#f87171", fontWeight: 600 }}>{busy ? t("services.updating") : t("services.sitesRemoveConfirmGo")}</button>
                    <button onClick={() => setConfirmDel(null)} style={btn}>{t("services.exposeAbort")}</button>
                  </span>
                )}
              </div>
            );
          })}
          {/* 添加站点：名称 + provider（auto = 平台默认）；名称规则 [a-z0-9-] */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
            <input placeholder={t("services.sitesNamePlaceholder")} value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") add(); }}
              style={{ ...input, flex: 1, width: isMobile ? "100%" : undefined }} />
            <select value={provider} onChange={(e) => setProvider(e.target.value)}
              style={{ ...input, flex: "0 0 auto", width: isMobile ? "100%" : undefined }}>
              <option value="auto">{t("services.sitesProviderAuto")}</option>
              {providers.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button onClick={add} disabled={busy || !name.trim()}
              style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600, width: isMobile ? "100%" : undefined, textAlign: "center" }}>
              {busy ? t("services.adding") : t("services.sitesAdd")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function AuthUsersSection({ t, isMobile }: { t: (key: string, params?: Record<string, string>) => string; isMobile: boolean }) {
  // 多语:子组件独立拿 locale(与服务页一致,?lang= 与切换同步)
  const { locale: usersLocale } = useI18n();
  // 两级视图:总表(站点 × provider 计数)→ 点某行 → 该组合的用户管理页
  // (带返回按钮)。添加用户只有 3 个输入,site/provider 由点选的行决定。
  const [rows, setRows] = useState<{ site: string; provider: string; count: number; totp: number }[] | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ site: string; provider: string } | null>(null);
  const [totpProviders, setTotpProviders] = useState<string[]>([]);
  const [biometricProviders, setBiometricProviders] = useState<string[]>([]);
  // 人脸采集弹窗（管理端直接采集：浏览器 face-api → 描述子直写模板，不启动门户）
  const [faceCapture, setFaceCapture] = useState<{ name: string; mode: "enroll" | "verify" } | null>(null);
  // 采集完成 → “记录完成待验证”弹窗（现在验证 / 重新记录）
  const [captureDone, setCaptureDone] = useState<{ name: string } | null>(null);
  // 待验证（pending）点击 → 两选项弹窗（现在验证 / 重新记录）
  const [pendingAction, setPendingAction] = useState<{ name: string } | null>(null);
  const [verifyMsg, setVerifyMsg] = useState<string>(""); // verify 结果反馈
  const stateRef = useRef({ eyeClosed: false, blinked: false, vectors: [] as number[][], done: false });
  const [users, setUsers] = useState<{ name: string; displayName: string; biometrics?: { face: boolean; facePending: boolean; voice: boolean; voicePending: boolean } }[]>([]);
  const [totpState, setTotpState] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  // 显示名（nickname）行内编辑：null=未编辑；{name, draft}=编辑草稿
  const [dnEdit, setDnEdit] = useState<{ name: string; draft: string } | null>(null);
  const [pwUser, setPwUser] = useState<string | null>(null);
  const [newPw, setNewPw] = useState("");
  const [totpEnrolled, setTotpEnrolled] = useState<{ name: string; label: string; secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  // 登记前的标识确认步骤：点「开启 2FA」先取默认标识预填，用户可改，确认后才生成密钥
  const [enrollTarget, setEnrollTarget] = useState<string | null>(null);
  const [totpLabel, setTotpLabel] = useState("");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 站点（认证域）清单 + 受保护名单 + 可选 provider（同一次 /status 拉回）
  const [sitesList, setSitesList] = useState<SiteInfo[] | null>(null);
  const [protectedSites, setProtectedSites] = useState<string[]>(["default", "pi-web"]);
  const [siteProviders, setSiteProviders] = useState<string[]>([]);

  // 详情页内所有操作都作用于所选组合(site/provider 由点选的行确定)
  const post = (action: string, extra: Record<string, unknown> = {}) => {
    const s = selected;
    if (!s) return Promise.resolve({ error: "no combo selected" }) as Promise<Record<string, unknown>>;
    return fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, provider: s.provider, site: s.site === "default" ? undefined : s.site, ...extra }),
    }).then((r) => r.json());
  };

  /** 汇总表格:每个 site × userManager provider 一行(用户数 + TOTP 数)。 */
  const loadSummary = useCallback(() => {
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-summary" }),
    })
      .then((r) => r.json())
      .then((d: { rows?: { site: string; provider: string; count: number; totp: number }[]; error?: string }) => {
        if (d.error) { setSummaryError(d.error); return; }
        setRows(d.rows ?? []);
        setSummaryError(null);
      })
      .catch(() => setSummaryError(String(t("services.error"))));
  }, [t]);

  // 所选组合的用户列表 + TOTP 状态
  // post/t are per-render helpers; listing them would re-create loadUsers on
  // every render and re-trigger the [selected] effect. Their values are read
  // through the closure, and loadUsers is only re-created when the selection
  // changes (selected/totpProviders).
  const loadUsers = useCallback(() => {
    if (!selected) return;
    post("user-list", { provider: selected.provider })
      .then((d: { users?: { provider: string; users: { name: string; displayName: string; biometrics?: { face: boolean; facePending: boolean; voice: boolean; voicePending: boolean } }[] }[]; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        const entry = (d.users ?? []).find((x) => x.provider === selected.provider);
        setUsers(entry?.users ?? []);
        if (totpProviders.includes(selected.provider)) {
          for (const u of entry?.users ?? []) {
            post("totp-status", { provider: selected.provider, name: u.name })
              .then((s: { enrolled?: boolean }) => setTotpState((prev) => ({ ...prev, [u.name]: Boolean(s.enrolled) })))
              .catch(() => {});
          }
        }
      })
      .catch(() => setError(String(t("services.error"))));
  // post/t are per-render helpers; loadUsers is re-created only when the
  // selection changes (its deps), so the [selected] effect below stays stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, totpProviders, biometricProviders]);

  // usersLocale is mount-once (same rationale as the schemas fetch above).
  useEffect(() => {
    fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(usersLocale)}`)
      .then((r) => r.json())
      .then((d: { totpProviders?: string[]; biometricProviders?: string[]; sites?: SiteInfo[]; protectedSites?: string[]; providerOrder?: string[] }) => {
        if (d.totpProviders) setTotpProviders(d.totpProviders);
        if (d.biometricProviders) setBiometricProviders(d.biometricProviders);
        if (d.sites) setSitesList(d.sites);
        if (d.protectedSites) setProtectedSites(d.protectedSites);
        if (d.providerOrder) setSiteProviders(d.providerOrder);
      })
      .catch(() => {});
    loadSummary();
  // usersLocale is mount-once; loadSummary identity is stable via its deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadSummary]);

  // 点选/返回时加载或清空用户 — loadUsers identity follows selected via its
  // own useCallback deps, so [selected] alone re-runs it on selection change.
  // loadUsers identity follows selected via its own useCallback deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (selected) loadUsers(); }, [selected]);

  const selectCombo = (r: { site: string; provider: string }) => {
    setSelected({ site: r.site, provider: r.provider });
    setError(null);
    setPwUser(null);
    setTotpEnrolled(null);
    setQrUrl(null);
    setTotpCode("");
    setEnrollTarget(null);
    setTotpLabel("");
    setUsers([]);
    setTotpState({});
  };

  const back = () => {
    setSelected(null);
    setUsers([]);
    setTotpState({});
    setError(null);
    setPwUser(null);
    setTotpEnrolled(null);
    setQrUrl(null);
    setTotpCode("");
    setEnrollTarget(null);
    setTotpLabel("");
    loadSummary();
  };

  const addUser = () => {
    if (!name || !password) return;
    setBusy(true);
    setError(null);
    post("user-add", { name, password, displayName: displayName || undefined })
      .then((d: { error?: string }) => { if (d.error) setError(d.error); else { setName(""); setPassword(""); setDisplayName(""); loadUsers(); loadSummary(); } })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const updateUserPassword = (uname: string) => {
    if (!newPw) return;
    setBusy(true);
    post("user-set-password", { name: uname, password: newPw })
      .catch((e) => setError(String(e)))
      .finally(() => { setBusy(false); setPwUser(null); setNewPw(""); });
  };

  /** 保存显示名（nickname）编辑。 */
  const saveDisplayName = () => {
    if (!dnEdit || !dnEdit.draft.trim()) return;
    const prev = users.find((u) => u.name === dnEdit.name)?.displayName ?? "";
    if (dnEdit.draft.trim() === prev) { setDnEdit(null); return; }
    post("user-set-displayname", { provider: selected?.provider, name: dnEdit.name, displayName: dnEdit.draft.trim() })
      .then((d: { error?: string }) => {
        if (d.error) { setError(d.error); return; }
        loadUsers();
        setDnEdit(null);
      })
      .catch(() => setError(String(t("services.error"))));
  };

  /** 生物 2FA 开启：
   *  - face：管理端直接采集（内嵌弹窗：加载 face-assets 的 face-api → 摄像头
   *    → 眨眼检测 3 帧描述子 → biometric-enroll-face 直写模板 pending）。
   *    纯数据层操作，不启动门户进程。
   *  - voice：暂走门户采集页（后续同样内嵌化）。 */
  const enrollBiometric = (name: string, method: "face" | "voice") => {
    if (method === "face") {
      setFaceCapture({ name, mode: "enroll" });
      return;
    }
    post("biometric-enroll-url", { provider: selected?.provider, name, method })
      .then((d: { url?: string | null; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        if (!d.url) { setError(t("services.bioPortalNotRunning")); return; }
        window.open(d.url, "_blank", "noopener,noreferrer");
      })
      .catch(() => setError(String(t("services.error"))));
  };
  /** 关闭生物 2FA（移除模板）。 */
  const disableBiometric = (name: string, method: "face" | "voice") => {
    post("biometric-disable", { provider: selected?.provider, name, method })
      .then((d: { error?: string }) => {
        if (d.error) { setError(d.error); return; }
        loadUsers();
      })
      .catch(() => setError(String(t("services.error"))));
  };

  const removeUser = (uname: string) => {
    setBusy(true);
    post("user-remove", { name: uname })
      .catch((e) => setError(String(e)))
      .finally(() => { setBusy(false); loadUsers(); loadSummary(); });
  };

  /** 点「开启 2FA」：先取默认标识预填，用户确认/修改后再真正登记——避免直接
   *  生成无法改名的密钥。默认标识 `<name>-<auth>-<site>@<host>`：host 取
   *  浏览器当前域名，若明显是 IP/隧道随机域名则用 pi-web 预定义部署域名。 */
  const startTotpEnroll = (uname: string) => {
    const s = selected;
    if (!s) return;
    setBusy(true);
    setError(null);
    post("totp-default-label", { name: uname })
      .then((d: { label?: string; piWebHost?: string; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        const host = pickTotpHost(typeof window !== "undefined" ? window.location.hostname : undefined, d.piWebHost ?? "");
        const base = `${uname}-${s.provider}-${s.site}`;
        setEnrollTarget(uname);
        setTotpLabel(host ? `${base}@${host}` : (d.label ?? base));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const confirmTotpEnroll = () => {
    if (!enrollTarget) return;
    setBusy(true);
    setTotpEnrolled(null);
    setQrUrl(null);
    setTotpCode("");
    post("totp-enroll", { name: enrollTarget, label: totpLabel })
      .then((d: { secret?: string; label?: string; otpauthUrl?: string; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        if (d.secret) {
          setTotpEnrolled({ name: enrollTarget, label: d.label ?? totpLabel, secret: d.secret, otpauthUrl: d.otpauthUrl ?? "" });
          setEnrollTarget(null);
          loadUsers();
          loadSummary();
        } else {
          setError(d.error ?? t("services.totpEnrollFailed"));
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const activateTotp = () => {
    if (!totpCode || !totpEnrolled) return;
    setBusy(true);
    post("totp-activate", { name: totpEnrolled.name, code: totpCode })
      .then((d: { activated?: boolean; error?: string }) => {
        if (d.activated) {
          setTotpEnrolled(null);
          setQrUrl(null);
          setTotpCode("");
          loadUsers();
          loadSummary();
        } else {
          setError(d.error ?? t("services.totpActivateFailed"));
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const disableTotp = (uname: string) => {
    setBusy(true);
    post("totp-disable", { name: uname })
      .catch((e) => setError(String(e)))
      .finally(() => { setBusy(false); loadUsers(); loadSummary(); });
  };

  // QR for the otpauth URL — generated client-side (offline, no external API).
  useEffect(() => {
    let alive = true;
    setQrUrl(null);
    const url = totpEnrolled?.otpauthUrl;
    if (!url) return;
    import("qrcode").then((mod) => {
      const qr = (mod as { toDataURL?: (t: string, o?: object) => Promise<string>; default?: { toDataURL?: (t: string, o?: object) => Promise<string> } }).default ?? mod;
      const toDataURL = qr.toDataURL;
      if (!toDataURL) return;
      toDataURL(url, { width: 176, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
        .then((u) => { if (alive) setQrUrl(u); })
        .catch(() => {});
    }).catch(() => {});
    return () => { alive = false; };
  }, [totpEnrolled?.otpauthUrl]);

  const input = { padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flex: 1, minWidth: 0, boxSizing: "border-box" as const };
  const btn = { padding: "4px 12px", border: "1px solid var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 };

  // ── 详情视图:所选组合的用户管理(带返回按钮) ─────────────────────
  if (selected) {
    return (
      <div style={{ padding: "6px 0" }}>
      {faceCapture && (
        <FaceCaptureModal
          name={faceCapture.name}
          provider={selected.provider}
          site={selected.site === "default" ? undefined : selected.site}
          t={t}
          mode={faceCapture.mode}
          onClose={() => { setFaceCapture(null); }}
          onDone={() => {
            const n = faceCapture.name;
            setFaceCapture(null);
            loadUsers();
            if (faceCapture.mode === "enroll") {
              // 注册完成 → 记录完成待验证弹窗（现在验证 / 重新记录）
              setCaptureDone({ name: n });
            } else {
              // 验证完成 → 反馈（matched 由服务端决定；失败时 verify 弹窗内显示）
              setVerifyMsg(t("services.bioFaceVerified"));
              setCaptureDone({ name: n, verified: true } as { name: string });
              setTimeout(() => setVerifyMsg(""), 3000);
            }
          }}
        />
      )}
      {captureDone && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10001 }} onClick={() => setCaptureDone(null)}>
          <div style={{ position: "relative", background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(90vw, 360px)" }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setCaptureDone(null)} aria-label={t("services.close")} title={t("services.close")}
              style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: "var(--text-muted, #aaa)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 6 }}>
              {(captureDone as { verified?: boolean }).verified ? "✅ " : "🙂 "}
              {(captureDone as { verified?: boolean }).verified ? t("services.bioFaceVerified") : t("services.bioFaceRecorded")}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim, #999)", lineHeight: 1.6, marginBottom: 12 }}>
              {(captureDone as { verified?: boolean }).verified
                ? t("services.bioFaceActiveHint")
                : t("services.bioFacePendingHint")}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              {!(captureDone as { verified?: boolean }).verified && (
                <button onClick={() => { const n = captureDone.name; setCaptureDone(null); setFaceCapture({ name: n, mode: "verify" }); }} style={{ ...btn, background: "var(--accent, #4f7cff)", border: "none", color: "#fff", fontWeight: 600 }}>
                  {t("services.bioFaceVerify")}
                </button>
              )}
              <button onClick={() => { const n = captureDone.name; setCaptureDone(null); setFaceCapture({ name: n, mode: "enroll" }); }} style={btn}>
                {t("services.bioFaceRerecord")}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingAction && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10001 }} onClick={() => setPendingAction(null)}>
          <div style={{ position: "relative", background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(90vw, 360px)" }} onClick={(e) => e.stopPropagation()}>
              <button onClick={() => setPendingAction(null)} aria-label={t("services.close")} title={t("services.close")}
                style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", color: "var(--text-muted, #aaa)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "2px 6px" }}>✕</button>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 6 }}>🙂 {t("services.bioFacePending")}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim, #999)", lineHeight: 1.6, marginBottom: 12 }}>{t("services.bioFacePendingHint")}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { const n = pendingAction.name; setPendingAction(null); setFaceCapture({ name: n, mode: "verify" }); }} style={{ ...btn, background: "var(--accent, #4f7cff)", border: "none", color: "#fff", fontWeight: 600 }}>
                {t("services.bioFaceVerify")}
              </button>
              <button onClick={() => { const n = pendingAction.name; setPendingAction(null); setFaceCapture({ name: n, mode: "enroll" }); }} style={btn}>
                {t("services.bioFaceRerecord")}
              </button>
            </div>
          </div>
        </div>
      )}
      {verifyMsg && (
        <div style={{ position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", background: "#16a34a", color: "#fff", padding: "8px 16px", borderRadius: 8, fontSize: 12, zIndex: 10002 }}>
          {verifyMsg}
        </div>
      )}
        <button onClick={back} style={{ ...btn, marginBottom: 10, display: "inline-flex", alignItems: "center", gap: 4 }}>
          ← {t("services.usersBack")}
        </button>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
          {t("services.usersEditing")} · <span style={{ fontFamily: "var(--font-mono)" }}>{selected.site}</span> / <span style={{ fontFamily: "var(--font-mono)" }}>{selected.provider}</span>
          <span style={{ marginLeft: 6, color: "var(--text-dim)", fontWeight: 400 }}>({users.length})</span>
        </div>
        {error && <div style={{ fontSize: 11, color: "#f87171", margin: "6px 0" }}>{error}</div>}

        {/* 添加用户:3 个输入即可,site/provider 由点选的行确定;小屏纵向堆叠 */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "10px 0 10px", flexWrap: "wrap", flexDirection: isMobile ? "column" : "row" }}>
          <input placeholder={t("services.userName")} value={name} onChange={(e) => setName(e.target.value)} style={{ ...input, flex: 1, width: isMobile ? "100%" : undefined, boxSizing: "border-box" }} />
          <input placeholder={t("services.userPassword")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...input, flex: 1, width: isMobile ? "100%" : undefined, boxSizing: "border-box" }} />
          <input placeholder={t("services.userDisplayName")} value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={{ ...input, flex: 1, width: isMobile ? "100%" : undefined, boxSizing: "border-box" }} />
          <button onClick={addUser} disabled={busy || !name || !password}
            style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600, width: isMobile ? "100%" : undefined, textAlign: "center" }}>
            {busy ? t("services.adding") : t("services.addUser")}
          </button>
        </div>

        {/* 登记前确认标识：默认 <name>-<auth>-<site>@<host>，用户可改 */}
        {enrollTarget && (
          <div style={{ margin: "8px 0", padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid #f0c36d" }}>
            <div style={{ fontSize: 10, color: "#8a6d1a", marginBottom: 4 }}>
              {t("services.totpLabelHint")} · <span style={{ fontFamily: "var(--font-mono)" }}>{enrollTarget}</span>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <input value={totpLabel} onChange={(e) => setTotpLabel(e.target.value)}
                placeholder={t("services.totpLabelPlaceholder")}
                style={{ ...input, fontFamily: "var(--font-mono)" }} />
              <button onClick={confirmTotpEnroll} disabled={busy || !totpLabel.trim()}
                style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }}>
                {busy ? t("services.adding") : t("services.totpEnrollConfirm")}
              </button>
              <button onClick={() => { setEnrollTarget(null); setTotpLabel(""); }} style={btn}>{t("services.close")}</button>
            </div>
          </div>
        )}

        {/* 用户列表 */}
        {users.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("services.noUsers")}</div>
        ) : users.map((u) => (
          <div key={u.name} style={{ padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {dnEdit?.name === u.name ? (
                <span style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  <input
                    autoFocus
                    value={dnEdit.draft}
                    onChange={(e) => setDnEdit({ name: u.name, draft: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveDisplayName();
                      if (e.key === "Escape") setDnEdit(null);
                    }}
                    maxLength={64}
                    style={{ padding: "1px 6px", border: "1px solid var(--accent)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", fontSize: 12, fontWeight: 600, width: 110 }}
                  />
                  <button onClick={saveDisplayName} title={t("services.save")} style={{ ...btn, padding: "2px 8px" }}>✓</button>
                  <button onClick={() => setDnEdit(null)} title={t("services.cancel")} style={{ ...btn, padding: "2px 8px" }}>✕</button>
                </span>
              ) : (
                <span
                  onClick={() => setDnEdit({ name: u.name, draft: u.displayName })}
                  title={t("services.displayNameEditHint")}
                  style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flexShrink: 0, cursor: "pointer", borderBottom: "1px dashed var(--border)" }}
                >
                  {u.displayName} ✎
                </span>
              )}
              <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{u.name}</span>
              <span style={{ fontSize: 10, color: totpState[u.name] ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }}>
                {totpState[u.name] ? t("services.totpEnrolled") : t("services.totpOff")}
              </span>
              {u.biometrics?.face && (
                <span style={{ fontSize: 10, color: "#16a34a", flexShrink: 0 }} title={t("services.bioFaceOn")}>🙂 {t("services.bioFaceOn")}</span>
              )}
              {u.biometrics?.facePending && !u.biometrics?.face && (
                <span style={{ fontSize: 10, color: "#f59e0b", flexShrink: 0 }} title={t("services.bioFacePendingHint")}>🙂 {t("services.bioFacePending")}</span>
              )}
              {u.biometrics?.voice && (
                <span style={{ fontSize: 10, color: "#16a34a", flexShrink: 0 }} title={t("services.bioVoiceOn")}>🎙 {t("services.bioVoiceOn")}</span>
              )}
              {u.biometrics?.voicePending && !u.biometrics?.voice && (
                <span style={{ fontSize: 10, color: "#f59e0b", flexShrink: 0 }} title={t("services.bioVoicePendingHint")}>🎙 {t("services.bioVoicePending")}</span>
              )}
              <span style={{ flex: 1 }} />
              {totpProviders.includes(selected.provider) && (
                totpState[u.name] ? (
                  <button onClick={() => disableTotp(u.name)} style={btn}>{t("services.totpDisable")}</button>
                ) : (
                  <button onClick={() => startTotpEnroll(u.name)} style={btn}>{t("services.totpEnroll")}</button>
                )
              )}
              {biometricProviders.includes(selected.provider) && (
                <>
                  {u.biometrics?.face ? (
                    <>
                      <button onClick={() => enrollBiometric(u.name, "face")} style={btn} title={t("services.bioFaceRerecordHint")}>{t("services.bioFaceRerecordFace")}</button>
                      <button onClick={() => disableBiometric(u.name, "face")} style={{ ...btn, color: "#f87171" }} title={t("services.bioFaceOffHint")}>{t("services.bioFaceOff")}</button>
                    </>
                  ) : u.biometrics?.facePending ? (
                    <button onClick={() => setPendingAction({ name: u.name })} style={{ ...btn, borderColor: "#f59e0b", color: "#f59e0b" }} title={t("services.bioFacePendingHint")}>{t("services.bioFacePending")}</button>
                  ) : (
                    <button onClick={() => enrollBiometric(u.name, "face")} style={btn} title={t("services.bioFaceHint")}>{t("services.bioFaceEnroll")}</button>
                  )}
                  {u.biometrics?.voice ? (
                    <button onClick={() => disableBiometric(u.name, "voice")} style={btn} title={t("services.bioVoiceOffHint")}>{t("services.bioVoiceOff")}</button>
                  ) : u.biometrics?.voicePending ? (
                    <button disabled style={{ ...btn, opacity: 0.6, cursor: "not-allowed" }} title={t("services.bioVoicePendingHint")}>{t("services.bioVoicePending")}</button>
                  ) : (
                    <button onClick={() => enrollBiometric(u.name, "voice")} style={btn} title={t("services.bioVoiceHint")}>{t("services.bioVoiceEnroll")}</button>
                  )}
                </>
              )}
              <button onClick={() => setPwUser(pwUser === u.name ? null : u.name)} style={btn}>{t("services.userSetPassword")}</button>
              <button onClick={() => removeUser(u.name)} style={{ ...btn, color: "#f87171" }}>{t("services.userRemove")}</button>
            </div>
            {pwUser === u.name && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                <input type="password" placeholder={t("services.newPassword")} value={newPw} onChange={(e) => setNewPw(e.target.value)} style={input} />
                <button onClick={() => updateUserPassword(u.name)} disabled={busy || !newPw} style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }}>
                  {t("services.update")}
                </button>
              </div>
            )}
          </div>
        ))}

        {totpEnrolled && (
          <div style={{ marginTop: 8, padding: "10px", borderRadius: 6, background: "var(--bg)", border: "1px solid #f0c36d" }}>
            <div style={{ fontSize: 10, color: "#8a6d1a" }}>{t("services.totpSecret")} ({totpEnrolled.label})</div>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginTop: 6, flexWrap: "wrap" }}>
              {qrUrl && (
                // TOTP QR is a server-provided data URL — next/image cannot
                // optimize it (no loader, dynamic base64).
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrUrl} alt="TOTP QR" width={176} height={176}
                  style={{ border: "1px solid var(--border)", borderRadius: 6, flexShrink: 0, background: "#fff" }} />
              )}
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.totpManual")}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", marginTop: 2, overflowWrap: "anywhere", wordBreak: "break-all", letterSpacing: 1 }}>{totpEnrolled.secret}</div>
                {totpEnrolled.otpauthUrl && (
                  <a href={totpEnrolled.otpauthUrl} style={{ display: "inline-block", marginTop: 4, fontSize: 11, color: "var(--accent)" }}>
                    {t("services.otpauthOpen")}
                  </a>
                )}
                <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 8, fontWeight: 600 }}>{t("services.totpApps")}</div>
                <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--text)", lineHeight: 1.7 }}>
                  <li>
                    {t("services.totpAppMs")}{" "}
                    <a href="https://www.microsoft.com/security/mobile-authenticator-app" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{t("services.officialSite")}</a>
                    {" · "}
                    <a href="https://apps.apple.com/cn/app/microsoft-authenticator/id983156458" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{t("services.appStore")}</a>
                    {" · "}
                    {t("services.totpAppCnStore")}
                  </li>
                  <li>{t("services.totpAppTencent")}{" "}{t("services.totpAppCnStore")}</li>
                  <li>
                    {t("services.totpAppGoogle")}{" "}
                    <a href="https://gitee.com/justdb-mirrors/downloads/releases/download/google-authenticator-6.0/GoogleAuthenticator-6.0.apk" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                      {t("services.totpApkMirror")}
                    </a>
                  </li>
                </ul>
              </div>
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>{t("services.totpActivateHint")}</div>
              <div style={{ display: "flex", gap: 6 }}>
                <input type="text" placeholder={t("services.totpCode")} value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  style={input} />
                <button onClick={() => activateTotp()} disabled={busy || !totpCode}
                  style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }}>
                  {busy ? t("services.activating") : t("services.totpActivate")}
                </button>
              </div>
            </div>
            <button onClick={() => { setTotpEnrolled(null); setQrUrl(null); setTotpCode(""); }} style={{ ...btn, marginTop: 8, display: "block" }}>{t("services.close")}</button>
          </div>
        )}
      </div>
    );
  }

  // ── 站点增删（POST site-add / site-remove；响应带回最新 sites 列表）──
  const addSite = (n: string, p: string): Promise<{ error?: string }> =>
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "site-add", name: n, ...(p && p !== "auto" ? { provider: p } : {}) }),
    })
      .then((r) => r.json())
      .then((d: { sites?: SiteInfo[]; protectedSites?: string[]; error?: string }) => {
        if (d.error) return { error: d.error };
        if (d.sites) setSitesList(d.sites);
        if (d.protectedSites) setProtectedSites(d.protectedSites);
        loadSummary();
        return {};
      })
      .catch((e) => ({ error: String(e) }));

  const removeSite = (n: string): Promise<{ error?: string }> =>
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "site-remove", name: n }),
    })
      .then((r) => r.json())
      .then((d: { sites?: SiteInfo[]; protectedSites?: string[]; error?: string }) => {
        if (d.error) return { error: d.error };
        if (d.sites) setSitesList(d.sites);
        if (d.protectedSites) setProtectedSites(d.protectedSites);
        loadSummary();
        return {};
      })
      .catch((e) => ({ error: String(e) }));

  // ── 总表视图:站点 × provider 计数,点行进入详情 ──────────────────
  return (
    <div style={{ padding: "6px 0" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>{t("services.authUsers")}</div>
      {/* 站点管理：先建/删认证域，再按 站点×认证 维护用户 */}
      <SitesManageSection t={t} isMobile={isMobile} sites={sitesList} protectedSites={protectedSites} providers={siteProviders} onAdd={addSite} onRemove={removeSite} />
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{t("services.usersPickCombo")}</div>
      {summaryError && <div style={{ fontSize: 11, color: "#f87171", margin: "0 0 6px" }}>{summaryError}</div>}
      {rows === null ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "8px 4px" }}>{t("services.loading")}</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)", padding: "8px 4px" }}>{t("services.noUserCombos")}</div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }}>{t("services.usersSite")}</th>
              <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }}>{t("services.usersAuth")}</th>
              <th style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }}>{t("services.usersCount")}</th>
              <th style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontWeight: 600 }}>{t("services.usersTotpCount")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.site}:${r.provider}`}
                onClick={() => selectCombo(r)}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                style={{ cursor: "pointer" }}>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{r.site}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text)", fontSize: 11 }}>{r.provider}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", color: "var(--text)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.count}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", color: r.totp > 0 ? "#16a34a" : "var(--text-dim)", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.totp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
export { AuthUsersSection as UsersTab };
