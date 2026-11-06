/**
 * ServicesDialog — 服务端口弹窗壳（M2 拆壳）：
 *   壳 = 状态（轮询/enroll/详情弹窗）+ header + tab 栏（registry 能力门控）
 *        + 活动.tab 组件 + 弹窗。
 *   tab 体在 tabs/（Ports/Self/Users/Ddns/Doctor），共享组件在 dialog/shared。
 */
import { useCallback, useEffect, useState } from "react";
import { useI18n, useIsMobile, apiUrl, BASE_PATH, copyText } from "./host-shim";

/** dock v3 itemKey（= rightFileDock 注册复合 id "service-tunnels:ports"） */
export const ST_KEY = "service-tunnels:ports";
import { ExposeDetailModal, InfoModal } from "./dialog/shared";
import {
  normInjectEntries,
  normalizeExposeUrls,
  normalizeVhostScheme,
  isLikelyIp,
  type ExposeInfo,
  type SelfState,
  type ServicesResponse,
} from "./dialog/types";
import { PortsTab } from "./tabs/PortsTab";
import { SelfTab } from "./tabs/SelfTab";
import { UsersTab } from "./tabs/UsersTab";
import { DdnsTab } from "./tabs/DdnsTab";
import { DoctorTab } from "./tabs/DoctorTab";
import { visibleTabs, type StCapabilities, type TabId } from "./tabs/registry";

export function ServicesDialog({ onClose, onOpenFile, initialTab = "ports", embedded = false }: {
  onClose: () => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  /** 打开时停靠的标签页：从顶栏无认证告警进入时传 "self"。 */
  initialTab?: TabId;
  /** dock v3（P3 批）：右栏停靠 face 内嵌形态——无遮罩、无浮窗契约、铺满 DockBody、无自身 ✕（TabBar ✕ 关闭） */
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t, locale } = useI18n();
  // 多语:GET /api/extensions/service-tunnels/status 显式带 ?lang=,与 pi-web 内切换的语言一致
  const [data, setData] = useState<ServicesResponse | null>(null);
  const [userManagers, setUserManagers] = useState<string[]>([]);
  const [allowDownload, setAllowDownload] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logsData, setLogsData] = useState<{ access: string; error: string } | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [detailFor, setDetailFor] = useState<ExposeInfo | null>(null);
  const [tab, setTab] = useState<TabId>(initialTab);
  const [self, setSelf] = useState<SelfState | null>(null);
  const [infoModal, setInfoModal] = useState<"access" | "auth" | null>(null);
  // M1 capabilities（/status capabilities 段；tab/表单声明式门控）
  const [caps, setCaps] = useState<StCapabilities | null>(null);
  const [injectEntries, setInjectEntries] = useState<Array<{ port: number; basePath?: string }> | null>(null);
  const [injectSources, setInjectSources] = useState<Array<{ id: string; label: string; description?: string; enabled?: boolean }>>([]);

  const refresh = useCallback((force = false) => {
    if (!force) setLoading(false);
    fetch(apiUrl(`/api/extensions/service-tunnels/services${force ? "?refresh=1" : ""}`))
      .then((r) => r.json())
      .then((d: ServicesResponse) => {
        // services 响应不含 exposes —— 合并保留（vhost 行停止按钮依赖）
        setData((prev) => ({ ...(prev ?? {}), ...d, exposes: prev?.exposes ?? [] }));
        setError(null);
      })
      .catch(() => setError(String(t("services.error"))))
      .finally(() => setLoading(false));
    fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(locale)}`)
      .then((r) => r.json())
      .then((d: { exposes?: ExposeInfo[]; allowToolDownload?: boolean; toolStatus?: ServicesResponse["toolStatus"]; self?: SelfState; userManagers?: string[]; injectSources?: Array<{ id: string; label: string; description?: string; enabled?: boolean }>; capabilities?: StCapabilities }) => {
        // 无条件合并（两个请求并行）——详见 dialog/types 注释
        if (d.exposes) {
          const ex = d.exposes.map(normalizeExposeUrls);
          setData((prev) => ({ ...(prev ?? ({} as ServicesResponse)), exposes: ex, services: prev?.services ?? [] }));
        }
        if (d.userManagers) setUserManagers(d.userManagers);
        if (d.injectSources) setInjectSources(d.injectSources);
        if (typeof d.allowToolDownload === "boolean") setAllowDownload(d.allowToolDownload);
        if (d.toolStatus) {
          setData((prev) => ({ ...(prev ?? ({} as ServicesResponse)), toolStatus: d.toolStatus, services: prev?.services ?? [] }));
        }
        if (d.self) {
          setSelf(d.self && { ...d.self, urls: (d.self.urls ?? []).map((u) => ({ ...u, url: normalizeVhostScheme(u.url) })) });
        }
        if (d.capabilities) setCaps(d.capabilities);
      })
      .catch(() => {});
    fetch(apiUrl("/api/extensions/service-tunnels/enroll"))
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { ports?: Array<{ port: number; serviceBasePath?: string }> } | null) => {
        setInjectEntries(d ? normInjectEntries(d.ports) : null);
      })
      .catch(() => {
        setInjectEntries((p) => p ?? null);
      });
  }, [t, locale]);

  useEffect(() => {
    refresh(true);
    if (!autoRefresh) return;
    const id = setInterval(() => refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh, autoRefresh]);

  const scheme = typeof window !== "undefined" ? window.location.protocol : "http:";
  const pagePort = typeof window !== "undefined" && window.location.port ? `:${window.location.port}` : "";
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const suffixes = data?.serviceHostSuffixes ?? [".pi.localhost"];
  const currentDomainSuffix = hostname && !isLikelyIp(hostname) && hostname !== "localhost" ? `.${hostname}` : null;

  const openInNewTab = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const copy = (key: string, url: string) => {
    copyText(url).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    }).catch(() => {});
  };

  const stopExpose = useCallback((name: string) => {
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tunnel-stop", name }),
    })
      .then(() => {
        setData((prev) => (prev ? { ...prev, exposes: (prev.exposes ?? []).filter((e) => e.name !== name) } : prev));
        refresh(false);
      })
      .catch(() => {});
  }, [refresh]);

  const toggleInject = useCallback((port: number, on: boolean, basePath?: string) => {
    const cur = injectEntries ?? [];
    const existing = cur.find((e) => e.port === port);
    const entry = { port, ...(basePath !== undefined ? (basePath ? { basePath } : {}) : existing?.basePath ? { basePath: existing.basePath } : {}) };
    const next = on ? [...cur.filter((e) => e.port !== port), entry] : cur.filter((e) => e.port !== port);
    setInjectEntries(next); // optimistic
    fetch(apiUrl("/api/extensions/service-tunnels/enroll"), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port, ...(on ? (basePath !== undefined ? { basePath } : {}) : { remove: true }) }),
    })
      .then((r) => r.json())
      .then((d: { ports?: Array<{ port: number; serviceBasePath?: string }> }) => { if (d && Array.isArray(d.ports)) setInjectEntries(normInjectEntries(d.ports)); })
      .catch(() => refresh(false));
  }, [injectEntries, refresh]);

  const toggleExpand = (port: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
  };

  // registry 能力门控：initialTab 不可见（如 deep-link doctor 无能力）→ 落回首 tab
  const tabs = visibleTabs(caps);
  const activeTab = tabs.some((d) => d.id === tab) ? tab : tabs[0]?.id;

  // 自动刷新 + 手动刷新控件（浮窗在 Header 行、embedded 并入 Tabs 行——v3.1 工具条收敛：
  // 右栏停靠时不渲染整条 Header，只留 TabBar 页签 + Tabs 行两层）
  const refreshControls = (
    <>
      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)", cursor: "pointer" }}>
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)}
          style={{ accentColor: "var(--accent)", cursor: "pointer", margin: 0 }} />
        {autoRefresh ? t("services.auto") : t("services.autoOff")}
      </label>
      <button onClick={() => refresh(true)} disabled={loading} title={t("services.refresh")} aria-label={t("services.refresh")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: loading ? "default" : "pointer", padding: 4, display: "flex" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: loading ? "spin 0.8s linear infinite" : undefined }}>
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" />
        </svg>
      </button>
    </>
  );

  return (
    <div style={embedded
      ? { width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", overflow: "hidden", minHeight: 0 }
      : { position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div {...(embedded ? {} : { "data-ext-float": "1", "data-ext-float-key": ST_KEY, "data-ext-float-dock": "right-panel", "data-ext-float-dock-default": "right-panel", "data-ext-float-w": 760, "data-ext-float-h": 620, "data-ext-float-full": "1" })} style={embedded
        ? { width: "100%", flex: 1, minHeight: 0, background: "var(--bg)", display: "flex", flexDirection: "column", overflow: "hidden" }
        : {
        width: 760, maxWidth: "calc(100vw - 16px)", height: "min(620px, 82vh)", background: "var(--bg)",
        border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden",
      }}>
        {/* Header（仅浮窗；embedded 时控件并入下方 Tabs 行，标题/版本与页签重复） */}
        {!embedded && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("services.title")}</span>
            {caps?.libVersion && <span title="service-tunnels lib" style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>v{caps.libVersion}</span>}
            {refreshControls}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={onClose} title={t("services.close")} aria-label={t("services.close")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        )}

        {/* Tabs（registry 声明式 + capabilities 门控）；embedded 时右端挂刷新控件 */}
        <div style={{ display: "flex", gap: 2, padding: "6px 14px 0", borderBottom: "1px solid var(--border)", flexShrink: 0, alignItems: "center" }}>
          {tabs.map((d) => (
            <button key={d.id} onClick={() => setTab(d.id)}
              role="tab" aria-selected={activeTab === d.id}
              style={{
                padding: "6px 14px", background: "none",
                borderLeft: "none", borderRight: "none", borderTop: "none",
                borderBottom: activeTab === d.id ? "2px solid var(--accent)" : "2px solid transparent",
                color: activeTab === d.id ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer", fontSize: 13, fontWeight: activeTab === d.id ? 600 : 400,
              }}>
              {t(d.labelKey)}
            </button>
          ))}
          {embedded && <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, paddingBottom: 4 }}>{refreshControls}</div>}
        </div>

        {activeTab === "ports" && (
          <PortsTab
            t={t} isMobile={isMobile} data={data} self={self} error={error} loading={loading}
            allowDownload={allowDownload} setAllowDownload={setAllowDownload}
            expanded={expanded} toggleExpand={toggleExpand}
            copy={copy} copiedKey={copiedKey} openInNewTab={openInNewTab}
            stopExpose={stopExpose} setDetailFor={setDetailFor}
            logsFor={logsFor} setLogsFor={setLogsFor} logsData={logsData} setLogsData={setLogsData}
            logsLoading={logsLoading} setLogsLoading={setLogsLoading}
            injectEntries={injectEntries} toggleInject={toggleInject}
            suffixes={suffixes} currentDomainSuffix={currentDomainSuffix}
            scheme={scheme} pagePort={pagePort}
            injectSources={injectSources} caps={caps}
            onGoManageUsers={() => setTab("users")} refresh={refresh}
          />
        )}
        {activeTab === "self" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            <SelfTab self={self} t={t} openInNewTab={openInNewTab} copy={copy} copiedKey={copiedKey} onChanged={() => refresh(false)}
              onGoManageUsers={() => setTab("users")}
              exposes={data?.exposes ?? []}
              onShowDetail={setDetailFor}
              onStopExpose={stopExpose}
              injectSources={injectSources} caps={caps} />
          </div>
        )}
        {activeTab === "users" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            <UsersTab t={t} isMobile={isMobile} />
          </div>
        )}
        {activeTab === "ddns" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            <DdnsTab t={t} />
          </div>
        )}
        {activeTab === "doctor" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            <DoctorTab t={t} />
          </div>
        )}

        {infoModal && (
          <InfoModal kind={infoModal} t={t} currentDomainSuffix={currentDomainSuffix} pagePort={pagePort}
            basePath={BASE_PATH} onClose={() => setInfoModal(null)} />
        )}
        {detailFor && (
          <ExposeDetailModal
            ex={detailFor} t={t}
            onClose={() => setDetailFor(null)}
            onOpen={openInNewTab}
            onCopy={copy}
            copiedKey={copiedKey}
            onStop={() => { stopExpose(detailFor.name); setDetailFor(null); }}
            onOpenFile={onOpenFile}
            userManagers={userManagers}
          />
        )}
      </div>
    </div>
  );
}
<<<<<<< Updated upstream
=======

/** Generic schema-driven param form (labels, descriptions, links, defaults,
 *  password/number/select inputs). Rendered for every tunnel type / auth
 *  provider from service-tunnels' ParamSpec — adding a provider or tunnel
 *  type needs NO dialog changes. */
/** provider 显示名:pi-web i18n key(services.provider.*) → 库 authMetas label
 *  (如 "GitHub OAuth") → 原始 id(如 oauth2-github)。绝不显示 i18n key。 */
function providerDisplayLabel(
  p: string,
  t: (key: string) => string,
  authMetas?: Record<string, { label?: string }> | null,
): string {
  if (p === "none") return t("services.exposeProviderNone");
  const k = `services.provider.${p}`;
  const tr = t(k);
  if (tr !== k) return tr;
  return authMetas?.[p]?.label ?? p;
}

/** boolean 字段开关：初始显示 spec.default（未显式设置时），点击切换 "true"/"false"。
 * 提交时值随 providerParams 走；服务端 normalizeProviderParams 兜底未设置 → 默认开。 */
function BooleanToggle({ spec, value, onChange, t }: {
  spec: ParamSpec;
  value: string | undefined;
  onChange: (v: string) => void;
  t: (key: string) => string;
}) {
  const on = value === undefined ? Boolean(spec.default) : value === "true";
  return (
    <button
      type="button"
      onClick={() => onChange(on ? "false" : "true")}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "3px 10px", borderRadius: 999, border: "1px solid var(--border)",
        background: on ? "#16a34a" : "var(--bg)",
        color: on ? "#fff" : "var(--text-muted)",
        fontSize: 11, cursor: "pointer", lineHeight: 1.4,
      }}
    >
      <span style={{ width: 13, height: 13, borderRadius: 7, background: on ? "#fff" : "#8a8a8a", display: "inline-block", flexShrink: 0 }} />
      {on ? t("services.on") : t("services.off")}
    </button>
  );
}

function SchemaForm({ specs, values, onChange, t }: {
  specs: ParamSpec[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  t: (key: string) => string;
}) {
  if (!specs.length) return null;
  const inputStyle = {
    width: "100%",
    padding: "3px 6px",
    border: "1px solid var(--border)",
    borderRadius: 5,
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
  } as const;
  return (
    <div style={{ marginTop: 6 }}>
      {specs.map((s) => {
        // 预定义固定参数(变体 provider/scope/端点):只读展示,默认值已填入
        const fixed = (s as ParamSpec & { fixed?: boolean }).fixed === true;
        return (
        <div key={s.key}>
          <label style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 5 }}>
            {s.label ?? s.key}{s.required ? " *" : ""}{fixed ? " 🔒" : ""}
            {s.link && (
              <a href={s.link} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", marginLeft: 6, fontSize: 9 }}>
                {s.linkTitle ?? t("services.docs")}
              </a>
            )}
          </label>
          {fixed ? (
            <input
              type="text"
              value={String((s as ParamSpec & { value?: string }).value ?? s.default ?? "")}
              disabled
              title={t("services.fixedParamHint")}
              style={{ ...inputStyle, opacity: 0.75, cursor: "not-allowed" }}
            />
          ) : s.type === "boolean" ? (
            <BooleanToggle
              spec={s}
              value={values[s.key]}
              onChange={(v) => onChange(s.key, v)}
              t={t}
            />
          ) : s.options ? (
            <select
              value={values[s.key] ?? String(s.default ?? "")}
              onChange={(e) => onChange(s.key, e.target.value)}
              style={inputStyle}
            >
              {s.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
            </select>
          ) : (
            <input
              type={s.type === "password" ? "password" : s.type === "number" ? "number" : "text"}
              value={values[s.key] ?? String(s.default ?? "")}
              placeholder={s.placeholder}
              onChange={(e) => onChange(s.key, e.target.value)}
              style={inputStyle}
            />
          )}
          {s.description && (
            <div style={{ fontSize: 9, color: "var(--text-dim)", marginTop: 1 }}>{s.description}</div>
          )}
        </div>
        );
      })}
    </div>
  );
}


/** 暴露详情弹窗 —— 活动暴露的链接点击后先看来源详情(mode / auth / 隧道 /
 *  参数 / 链接 / 开启时间),确认后再点链接才新窗口打开;停止按钮只停该条
 *  通道(同端口其他暴露不受影响)。 */
function ExposeDetailModal({ ex, t, onClose, onOpen, onCopy, copiedKey, onStop, onOpenFile, userManagers = [] }: {
  ex: ExposeInfo;
  t: (key: string, params?: Record<string, string>) => string;
  onClose: () => void;
  onOpen: (url: string) => void;
  onCopy: (key: string, url: string) => void;
  copiedKey: string | null;
  onStop: () => void;
  onOpenFile?: (filePath: string, fileName: string) => void;
  /** 有本地用户库的 provider（basic/authelia/portal）——站点字段仅对它们展示。 */
  userManagers?: string[];
}) {
  const isMobile = useIsMobile();
  const links = [ex.url, ex.localUrl, ex.baseUrl, ex.domainUrl, ex.loginUrl].filter((u): u is string => Boolean(u));
  const mode: string = (ex.name ?? "").startsWith("proxy:")
    ? "proxy"
    : ex.localUrl !== undefined
      ? "both"
      : "tunnel";
  const startedAt = typeof ex.startedAt === "number" ? new Date(ex.startedAt) : null;
  const params = ex.params ?? null;

  const field = (label: string, value: ReactNode) => (
    <div style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
      <span style={{ flexShrink: 0, width: 68, color: "var(--text-dim)", fontSize: 11, paddingTop: 2 }}>{label}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: isMobile ? "calc(100vw - 32px)" : 520, maxWidth: "calc(100vw - 32px)", maxHeight: "min(620px, 82vh)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            <span style={{ fontFamily: "var(--font-mono)" }}>127.0.0.1:{ex.port}</span>
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: ex.running ? "#16a34a" : "var(--text-dim)" }}>● {ex.running ? t("services.tunnelRunning") : t("services.tunnelStopped")}</span>
          </span>
          <button onClick={onClose} title={t("services.close")} aria-label={t("services.close")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 16px" }}>
          {field(t("services.exposeMode"), mode)}
          {field(
            t("services.exposeBasePath"),
            ex.serviceBasePath != null && ex.serviceBasePath !== ""
              ? ex.serviceBasePath
              : "—",
          )}
          {field(t("services.exposeProvider"), ex.provider ? ex.provider : (
            /* auth=none → 标红告警(与列表行一致) */
            <span style={{ color: "#f87171", fontWeight: 600 }} title={t("services.noAuthWarnHint")}>⚠ {t("services.exposeProviderNone")}</span>
          ))}
          {/* proxy 模式无隧道（tunnelType 是创建时传的默认值，实际未建隧道） */}
          {mode !== "proxy" && field(t("services.exposeTunnelTool"), ex.tunnelType ?? "—")}
          {userManagers.includes(ex.provider ?? "") && field(t("services.exposeSite"), ex.site && ex.site !== "" ? ex.site : "default")}
          {field(t("services.exposeProtocol"), ex.protocol ?? "http")}
          {field(t("services.exposeStartedAt"), startedAt ? startedAt.toLocaleString() : "—")}
          {field(t("services.exposeParams"), !params || Object.keys(params).length === 0 ? "—" : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {Object.entries(params).map(([k, v]) => (
                <div key={k} style={{ fontFamily: "var(--font-mono)" }}>
                  <span style={{ color: "var(--text-dim)" }}>{k}</span>: {v}
                </div>
              ))}
            </div>
          ))}
          {field(t("services.exposeResult"), links.length === 0 ? "—" : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {links.map((u) => (
                <div key={u} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button onClick={() => onOpen(u)} title={u}
                    style={{ flex: 1, minWidth: 0, textAlign: "left", padding: "4px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u}
                  </button>
                  <button onClick={() => onCopy(`expose-detail-${u}`, u)}
                    style={{ flexShrink: 0, width: 28, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: copiedKey === `expose-detail-${u}` ? "#16a34a" : "var(--text-dim)", cursor: "pointer", fontSize: 11 }}>
                    {copiedKey === `expose-detail-${u}` ? "✓" : "⧉"}
                  </button>
                </div>
              ))}
            </div>
          ))}
          <LogFilesSection
            exposeName={ex.name}
            t={t}
            onOpenFile={onOpenFile}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)", flex: 1 }}>{t("services.exposeDetailHint")}</span>
          <button onClick={onStop} style={{ flexShrink: 0, padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "#f87171", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{t("services.exposeStop")}</button>
        </div>
      </div>
    </div>
  );
}

/** 详情页日志区:列出该暴露的全部日志文件(nginx access/error × 各 host),
 *  点击在 pi-web 文件窗口打开(/api/files 经 allowFileRoot 已放行日志目录)。 */
function LogFilesSection({ exposeName, t, onOpenFile }: {
  exposeName: string;
  t: (key: string, params?: Record<string, string>) => string;
  onOpenFile?: (filePath: string, fileName: string) => void;
}) {
  const [files, setFiles] = useState<Array<{ name: string; path: string; size: number; mtime: number }> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl(`/api/extensions/service-tunnels/status?logs-list=${encodeURIComponent(exposeName)}`))
      .then((r) => r.json())
      .then((d: { files?: Array<{ name: string; path: string; size: number; mtime: number }>; error?: string }) => {
        if (!alive) return;
        if (d.error) setErr(d.error);
        else setFiles(d.files ?? []);
      })
      .catch(() => { if (alive) setErr("(failed to load logs)"); });
    return () => { alive = false; };
  }, [exposeName]);
  return (
    <div style={{ padding: "5px 0" }}>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{t("services.exposeLogFiles")}</div>
      {files === null ? (
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeLogFilesLoading")}</div>
      ) : err ? (
        <div style={{ fontSize: 10, color: "#f87171" }}>{err}</div>
      ) : files.length === 0 ? (
        <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeNoLogs")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {files.map((f) => (
            <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {onOpenFile ? (
                <button
                  onClick={() => onOpenFile(f.path, f.name)}
                  title={f.path}
                  style={{ flex: 1, minWidth: 0, textAlign: "left", padding: "3px 8px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {f.name}
                </button>
              ) : (
                <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              )}
              <span style={{ flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>
                {f.size >= 1024 * 1024 ? `${(f.size / 1024 / 1024).toFixed(1)} MB` : f.size >= 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Productized info modal — “how other devices reach these services” (DNS /
 *  wildcard domain / tunnels) and “authentication guide” (what's built in,
 *  what you can add yourself). Opened from the small text entries at the
 *  bottom of the Ports tab; keeps the dialog itself free of docs. */
function InfoModal({ kind, t, currentDomainSuffix, pagePort, basePath, onClose }: {
  kind: "access" | "auth";
  t: (key: string, params?: Record<string, string>) => string;
  currentDomainSuffix: string | null;
  pagePort: string;
  basePath: string;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: isMobile ? "calc(100vw - 32px)" : 470, maxWidth: "calc(100vw - 32px)", maxHeight: "min(620px, 82vh)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
            {kind === "access" ? t("services.infoAccess") : t("services.infoAuth")}
          </span>
          <button onClick={onClose} title={t("services.close")} aria-label={t("services.close")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
          {kind === "access" ? (
            <>
              <div>• {t("services.exposeLocal")}</div>
              <div>• {t("services.exposeLan")}</div>
              <div>• {t("services.exposePublic")}</div>
              {currentDomainSuffix && (
                <div>• {t("services.configCurrent", { host: currentDomainSuffix.replace(/^\./, ""), pagePort, basePath })}</div>
              )}
              <div style={{ marginTop: 6 }}>• {t("services.exposeTunnel")}</div>
            </>
          ) : (
            <>
              <div style={{ color: "#d97706", background: "rgba(217,119,6,0.08)", border: "1px solid rgba(217,119,6,0.3)", borderRadius: 6, padding: "6px 8px", marginBottom: 6 }}>
                {t("services.authHint")}
              </div>
              <div style={{ fontWeight: 600, color: "var(--text-muted)", margin: "8px 0 4px" }}>{t("services.authBuiltinTitle")}</div>
              <div>• {t("services.authBuiltinPortal")}</div>
              <div>• {t("services.authBuiltinBasic")}</div>
              <div>• {t("services.authBuiltinAuthelia")}</div>
              <div style={{ fontWeight: 600, color: "var(--text-muted)", margin: "12px 0 4px" }}>{t("services.authExtendTitle")}</div>
              {t("services.authExtendList").split("\n").map((line, i) => (
                <div key={i}>• {line}</div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 通用确认窗 —— 泄露风险确认 / 无用户提示 / 用户可登录确认,服务端口与
 *  pi-web 自暴露共用。body 可为任意节点(如用户名列表)。 */
function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#f87171", marginBottom: 8 }}>⚠ {title}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>{body}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={onCancel} style={{ padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>{cancelLabel}</button>
          <button onClick={onConfirm} style={{ padding: "5px 14px", background: "#dc2626", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function UrlRow({ url, label, copied, onCopy, onOpen, isMobile }: { url: string; label: string; copied: boolean; onCopy: () => void; onOpen: () => void; isMobile: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderRadius: 6, background: "var(--bg)" }}>
      <span style={{ fontSize: 10, color: "var(--text-dim)", minWidth: isMobile ? 66 : 92, flexShrink: 0 }}>{label}</span>
      <button onClick={onOpen} title={url}
        style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {url}
      </button>
      <button onClick={onCopy} title={copied ? "✓" : "⧉"} style={{ flexShrink: 0, width: 24, height: 24, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: 5, color: copied ? "#16a34a" : "var(--text-dim)", cursor: "pointer", fontSize: 12 }}>
        {copied ? "✓" : "⧉"}
      </button>
    </div>
  );
}

/** 注入 JS（AITI 调试器）开关 —— 端口卡（variant="port"）与 Pi-web 页
 *  （variant="self"）共用。注入按端口启用（aiti-devtools 扩展 inject-ports
 *  API）：端口出现在列表后，经该端口访问通道返回的 HTML 自动注入
 *  aiti-launcher.js。执行侧：proxy 模式（服务虚拟主机）已生效；tunnel 模式
 *  的响应注入由 service-tunnels 开发中（界面已就绪）。 */
/** BasePath（公开、与注入无关）：端口真实部署前缀。vhost 转发剥部署前缀后接回
 *  它（如 vite base=/dev/ 填 dev）——base 应用不接回会 302 死循环。独立行展示，
 *  与注入开关状态无关。保存 = 重新 enroll binding（即时生效）。 */
function BasePathSection({ port, entry, t, onSave }: {
  port: number;
  entry: { port: number; basePath?: string } | undefined;
  t: (key: string, params?: Record<string, string>) => string;
  onSave: (port: number, on: boolean, basePath?: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cur = entry?.basePath ?? "";
  const value = draft ?? cur;
  const dirty = draft !== null && draft.replace(/^\/+/, "").replace(/\/+$/, "") !== cur;
  return (
    <div style={{ borderTop: "1px solid var(--border)", marginTop: 10, paddingTop: 10, display: "flex", alignItems: "center", gap: 6 }} title={t("services.injectJsBasePathHint")}>
      <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", flexShrink: 0 }}>Base Path</span>
      {/* 失焦自动保存：Base Path 是端口属性，公开/另存方案时依赖它已落盘。
          用户填了值不点 ✓（直接点公开/另存按钮）曾导致 serviceBasePath 丢失 →
          方案/上次使用缺 basePath。Enter 与 blur 都立即保存。点公开按钮时
          浏览器先触发本输入框 blur（保存 + 父组件乐观 setState）→ doExpose
          读到的 prop 已是最新值。 */}
      <input
        type="text"
        value={value}
        placeholder={t("services.injectJsBasePathPlaceholder")}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (dirty) { onSave(port, true, value); setDraft(null); } }}
        onKeyDown={(e) => { if (e.key === "Enter") { onSave(port, true, value); setDraft(null); (e.target as HTMLInputElement).blur(); } }}
        style={{ flex: 1, minWidth: 0, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)" }}
      />
    </div>
  );
}

/**
 * Public access with auth — pick a provider, optionally require sign-in,
 * and open the tunnel through the service-tunnels nginx gateway.
 */
function AuthExposeSection({ port, t, openInNewTab, exposes, onStopExpose, onChanged, onGoManageUsers, serviceBasePath, onSetBasePath, injectSources }: {
  port: number;
  t: (key: string, params?: Record<string, string>) => string;
  openInNewTab: (url: string) => void;
  /** This port's exposes (running or not) — decides the button state. */
  exposes: ExposeInfo[];
  /** Stop ONE expose by name (the currently-selected combo's channel). */
  onStopExpose: (name: string) => void;
  /** 端口通用属性 serviceBasePath：expose 时写入 open binding（跟端口走） */
  serviceBasePath?: string;
  /** 方案回填时同步端口的 Base Path（写入 inject-ports 登记，与手改 Base Path 行等效）。 */
  onSetBasePath?: (port: number, basePath: string) => void;
  /** 注入源清单（公开表单勾选用） */
  injectSources: Array<{ id: string; label: string; description?: string }>;
  /** Re-fetch exposes after a successful expose (so the button flips to stop). */
  onChanged: () => void;
  /** Switch to the Users tab (no users for the selected auth combo). */
  onGoManageUsers: () => void;
}) {
  // 多语:子组件独立拿 locale(与服务页一致,?lang= 与切换同步)
  const { locale: secLocale } = useI18n();
  const [provider, setProvider] = useState<string | null>(null);
  // Provider list arrives from the server (library-computed); empty until then.
  const [providers, setProviders] = useState<string[]>([]);
  const [tunnel, setTunnel] = useState("cloudflared");
  const [protocol, setProtocol] = useState<"http" | "https" | "tcp">("http");
  const [mode, setMode] = useState<"tunnel" | "proxy" | "both">("tunnel");
  const [site, setSite] = useState("");
  const [sites, setSites] = useState<string[]>([]);
  const [tcpTunnels, setTcpTunnels] = useState<string[]>([]);
  const [tunnelSchemas, setTunnelSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  const [tunnelMetas, setTunnelMetas] = useState<Record<string, { favorite?: boolean; dangerous?: boolean }> | null>(null);
  const [authSchemas, setAuthSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  // provider 页面元数据(label/已配置)来自库——picker 显示友好名称用
  const [authMetas, setAuthMetas] = useState<Record<string, { label?: string }> | null>(null);
  const [tunnelParams, setTunnelParams] = useState<Record<string, string>>({});
  const [providerParams, setProviderParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string | null; loginUrl?: string; localUrl?: string; baseUrl?: string; domainUrl?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // auth=none / tcp 裸隧道(无网关认证)→ 公开前需要泄露风险确认
  const [confirmNone, setConfirmNone] = useState(false);
  // 有本地用户库的 provider(portal/basic/authelia…)——公开前检查该组合是否有用户
  const [userManagers, setUserManagers] = useState<string[]>([]);
  // userManagers 清单是否已就绪(schema 拉取失败 → fail-closed,阻止直接公开)
  const [userManagersReady, setUserManagersReady] = useState(false);
  const [checking, setChecking] = useState(false);
  // 该 provider+site 无用户 → 提示去管理用户
  const [noUsers, setNoUsers] = useState<{ provider: string; site: string } | null>(null);
  // 有用户 → 列出用户名,让用户确认自己可登录
  const [userConfirm, setUserConfirm] = useState<{ provider: string; site: string; users: string[] } | null>(null);

  // ---- 公开方案（preset）+「上次使用」自动回填 ----
  const [presets, setPresets] = useState<Array<{ id: string; name: string; updatedAt: number }>>([]);
  const [lastUsedAt, setLastUsedAt] = useState<number | null>(null);
  const [presetId, setPresetId] = useState("__last__");
  const [presetName, setPresetName] = useState("");
  const [saveOpen, setSaveOpen] = useState(false);
  // 另存为：方案应用后自动执行的动作（一键启用调试）
  const [presetActions, setPresetActions] = useState<{ enroll?: boolean; expose?: boolean }>({ enroll: false, expose: false });
  // Base Path 表单字段草稿（并入公开表单：编辑后随公开提交 + 失焦/回车落盘 binding）
  const [bpDraft, setBpDraft] = useState<string | null>(null);
  // 注入源勾选（公开配置的一部分：本通道页面注入哪些源）——注入与端口/全局无关
  const [injectSel, setInjectSel] = useState<string[]>([]);
  // 登录信息按钮（库内置注入：FAB 显示登录用户名 + 退出登录，可拖动四边停靠）
  const [loginInfoButton, setLoginInfoButton] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  // 预填（上次使用/方案）后，端口协议探测不再覆盖表单——用户保存的选优先生效
  const prefilledRef = useRef(false);

  /** 把一份方案配置回填进表单。 */
  const applyPresetConfig = (cfg: {
    provider: string | null;
    tunnel: string;
    protocol: "http" | "https" | "tcp";
    mode: "tunnel" | "proxy" | "both";
    site: string;
    serviceBasePath?: string;
    inject?: string[];
    loginInfoButton?: boolean;
    tunnelParams: Record<string, string>;
    providerParams: Record<string, string>;
  }) => {
    prefilledRef.current = true;
    setProvider(cfg.provider ?? "none");
    setInjectSel(Array.isArray(cfg.inject) ? cfg.inject.filter((s) => typeof s === "string") : []);
    setLoginInfoButton(cfg.loginInfoButton === true);
    setTunnel(cfg.tunnel || "cloudflared");
    setProtocol(cfg.protocol ?? "http");
    setMode(cfg.protocol === "tcp" ? "tunnel" : (cfg.mode ?? "tunnel"));
    setSite(cfg.site ?? "");
    setTunnelParams({ ...(cfg.tunnelParams ?? {}) });
    setProviderParams({ ...(cfg.providerParams ?? {}) });
    // Base Path 是端口属性（存 aiti 扩展 inject-ports 登记，不在本组件 state）——与当前值
    // 不同才写，避免每次回填都发一次 PUT。方案未存该字段（旧方案）则不动。
    if (cfg.serviceBasePath !== undefined && cfg.serviceBasePath !== (serviceBasePath ?? "")) {
      onSetBasePath?.(port, cfg.serviceBasePath);
    }
  };

  /** 拉取一份方案（id 或 "__last__"）解密回填；失败提示不阻断手填。 */
  const loadPresetIntoForm = (id: string) => {
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-load", id }),
    })
      .then((r) => r.json())
      .then((d: { config?: Parameters<typeof applyPresetConfig>[0] & { actions?: { enroll?: boolean; expose?: boolean } }; error?: string }) => {
        if (d.error || !d.config) {
          if (id !== "__last__") setError(d.error ?? t("services.presetLoadFailed"));
          return;
        }
        setError(null);
        applyPresetConfig(d.config);
        // 一键动作（enroll/expose/开启注入源）——仅手动选择方案时执行；
        // 上次使用（__last__）是打开对话框的自动回填，不自动公开（避免误伤）。
        // 传整个 config：动作参数直接用方案值（表单 state 异步，闭包滞后）。
        if (id !== "__last__") applyPresetActions(d.config);
      })
      .catch(() => { if (id !== "__last__") setError(t("services.presetLoadFailed")); })
      .finally(() => setPresetBusy(false));
  };

  /** 执行方案的 actions：enroll 登记端口 → expose 立即公开 → inject 开启注入源。
   *  全部用方案 config 的参数（不经表单 state——setState 异步，闭包值滞后）。
   *  串行执行（enroll 先落盘 serviceBasePath，公开依赖它）。失败静默。 */
  const applyPresetActions = (cfg: Parameters<typeof applyPresetConfig>[0] & { actions?: { enroll?: boolean; expose?: boolean } }) => {
    const actions = cfg.actions;
    if (!actions) return;
    if (actions.enroll) {
      // 方案无 basePath → 只登记端口，保留现有 serviceBasePath（不清除）
      const body = { port, ...(cfg.serviceBasePath ? { basePath: cfg.serviceBasePath } : {}) };
      fetch(apiUrl("/api/extensions/service-tunnels/enroll"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {});
    }
    if (actions.expose) {
      // 走完整安全链（go → confirmNone/checkUsers 确认弹窗）——方案一键公开
      // 不裸奔：auth=none 无认证确认、带认证检查用户库，与手动公开同保护。
      go({
        provider: cfg.provider ?? (cfg.protocol === "tcp" ? null : "none"),
        tunnel: cfg.tunnel || "cloudflared",
        protocol: cfg.protocol,
        mode: cfg.mode,
        site: cfg.site ?? "",
        tunnelParams: cfg.tunnelParams,
        providerParams: cfg.providerParams,
        ...(cfg.serviceBasePath ? { serviceBasePath: cfg.serviceBasePath } : {}),
      });
    }
  };

  // Tunnel types + provider params come from service-tunnels schemas
  // (data-driven — adding a tunnel type / auth provider needs NO dialog
  // changes). Provider order/default come from the library too.
  // Mount-once fetch: secLocale only selects the server-side response language;
  // re-fetching on language switch would reset the dialog mid-interaction.
  // status 与「上次使用」preset 并行拉（原先串行：status 完成后才发 preset 请求，
  // 打开对话框多等一个 RTT）。preset 请求在无记录时返回 error，静默忽略。
  useEffect(() => {
    setPresetBusy(true);
    const statusP = fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(secLocale)}`)
      .then((r) => r.json())
      .catch(() => null);
    const presetP = fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-load", id: "__last__" }),
    })
      .then((r) => r.json())
      .catch(() => null);
    Promise.all([statusP, presetP]).then(([d, presetD]) => {
      if (!d) return;
      {
        // providerOrder/defaultProvider come from the library — no provider
        // names hardcoded here (authelia availability, Windows fallback etc.
        // are decided in service-tunnels).
        const order = d.providerOrder ?? ["portal", "basic"];
        setProviders(["none", ...order]);
        const preferred = d.defaultProvider ?? order[0] ?? "portal";
        setProvider((cur) => (cur === null ? (order.includes(preferred) ? preferred : (order[0] ?? "portal")) : cur));
        if (d.tunnelSchemas) setTunnelSchemas(d.tunnelSchemas);
        if (d.tunnelMetas) setTunnelMetas(d.tunnelMetas);
        if (d.authProviderSchemas) setAuthSchemas(d.authProviderSchemas);
        if (d.authMetas) setAuthMetas(d.authMetas);
        // Skip dangerous tunnel types (TunnelMeta.dangerous — e.g. "command",
        // which runs a raw shell command) when picking a tcp-capable default;
        // name fallback covers service-tunnels versions without the flag.
        if (d.tunnelTcpSupport) setTcpTunnels(d.tunnelTcpSupport.filter((k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command"));
        if (d.sites) setSites(d.sites.filter((s) => s.name !== "default").map((s) => s.name));
        if (d.userManagers) setUserManagers(d.userManagers);
        setUserManagersReady(true);
        // 方案清单 + 「上次使用」自动回填（省去每次重复选择；没有记录则保持默认）
        // presetD 是并行拉取的 __last__ 结果——直接应用（无需再发一次 preset 请求）
        if (d.exposePresets) {
          setPresets(d.exposePresets.presets ?? []);
          setLastUsedAt(d.exposePresets.lastUsedAt ?? null);
          if (d.exposePresets.lastUsedAt && presetD?.config) applyPresetConfig(presetD.config);
        }
      }
    }).finally(() => setPresetBusy(false));
  // Mount-once: secLocale only selects the server-side response language.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-detect the port's protocol (http/https/tcp) so the user sees it up
  // front and the tunnel options adjust (tcp → only tcp-capable tunnels).
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    fetch(apiUrl(`/api/extensions/service-tunnels/status?detect=${port}`))
      .then((r) => r.json())
      .then((d: { protocol?: "http" | "https" | "tcp" }) => {
        // 预填过方案/上次使用 → 用户保存的选择优先，探测不覆盖
        if (!cancelled && d.protocol && !prefilledRef.current) setProtocol(d.protocol);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [port]);

  /** 公开（公开按钮 / 方案 actions.expose 共用）。overrides 由方案提供——
   *  直接传 config 参数，不依赖表单 state（setState 异步，闭包值滞后会按旧值公开）。 */
  const doExpose = (overrides?: Partial<{
    provider: string | null;
    tunnel: string;
    protocol: "http" | "https" | "tcp";
    mode: "tunnel" | "proxy" | "both";
    site: string;
    tunnelParams: Record<string, string>;
    providerParams: Record<string, string>;
    serviceBasePath?: string;
  }>) => {
    const p = overrides?.provider ?? (protocol === "tcp" ? null : provider);
    const t = overrides?.tunnel ?? tunnel;
    const proto = overrides?.protocol ?? protocol;
    const m = overrides?.mode ?? (proto === "tcp" ? "tunnel" : mode);
    const s = overrides?.site ?? site;
    const tp = overrides?.tunnelParams ?? tunnelParams;
    const pp = overrides?.providerParams ?? providerParams;
    const bp = overrides && "serviceBasePath" in overrides ? overrides.serviceBasePath : serviceBasePath;
    setBusy(true);
    setError(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "expose",
        port,
        auth: p !== "none" && proto !== "tcp",
        // tcp exposes never carry gateway auth — the library's expose tcp
        // path ignores the provider; send it as-is (no name hardcoding here).
        provider: p,
        tunnel: t,
        protocol: proto,
        mode: m,
        site: s || undefined,
        tunnelParams: tp,
        providerParams: pp,
        ...(bp ? { serviceBasePath: bp } : {}),
        ...(injectSel.length ? { inject: injectSel } : {}),
        ...(loginInfoButton ? { loginInfoButton: true } : {}),
      }),
    })
      .then((r) => r.json())
      .then((d: { url?: string | null; loginUrl?: string; localUrl?: string; baseUrl?: string; domainUrl?: string; error?: string }) => {
        if (d.error) {
          setError(d.error);
          setResult(null);
        } else {
          setResult({ url: d.url ?? null, loginUrl: d.loginUrl, localUrl: d.localUrl, baseUrl: d.baseUrl, domainUrl: d.domainUrl });
          // 服务端已把本次选项记为「上次使用」——本地时间同步（下拉显示用）
          setLastUsedAt(Date.now());
          setPresetId("__last__");
          onChanged();
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const checkUsers = (overrides?: Parameters<typeof doExpose>[0]) => {
    const p = overrides ? (overrides.provider ?? "none") : (protocol === "tcp" ? null : provider);
    const s = overrides ? (overrides.site ?? "") : site;
    // 用户库清单未就绪(schema 拉取失败/进行中)→ fail-closed,提示重试而非静默公开
    if (!userManagersReady) {
      setError(t("services.userCheckUnavailable"));
      return;
    }
    // 无本地用户库的 provider(oauth2-proxy 等)→ 无可检查,直接公开
    if (!p || !userManagers.includes(p)) { doExpose(overrides); return; }
    setChecking(true);
    setError(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-list", provider: p, site: s || undefined }),
    })
      .then((r) => r.json())
      .then((d: { users?: { provider: string; users: { name: string; displayName: string }[] }[]; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        const entry = (d.users ?? []).find((x) => x.provider === provider);
        const users = entry?.users ?? [];
        if (users.length === 0) { setNoUsers({ provider, site: site || "default" }); return; }
        setUserConfirm({
          provider,
          site: site || "default",
          users: users.map((u) => u.displayName || u.name),
        });
      })
      .catch(() => setError(String(t("services.error"))))
      .finally(() => setChecking(false));
  };

  /** 待确认的公开参数（方案 actions.expose 传入；确认弹窗确认后执行）。 */
  const exposeOverrideRef = useRef<Parameters<typeof doExpose>[0] | null>(null);

  const go = (overrides?: Parameters<typeof doExpose>[0]) => {
    // 参数用 overrides ?? 表单 state（方案一键公开同样走完整安全链）
    exposeOverrideRef.current = overrides ?? null;
    const p = overrides ? (overrides.provider ?? "none") : (protocol === "tcp" ? null : provider);
    const proto = overrides ? (overrides.protocol ?? "http") : protocol;
    // auth=none(或 tcp 裸隧道,无网关认证)→ 直接公开有泄露风险,先确认
    if (p === "none" || proto === "tcp") {
      setConfirmNone(true);
      return;
    }
    // 带认证 → 检查对应 site+provider 是否有可登录用户,再公开
    checkUsers(overrides);
  };

  // 当前表单选择是否已经有一条 RUNNING 的暴露:端口 + 模式 + provider + 隧道
  // + 协议 + 站点全部一致才算“已暴露”→ 按钮变“停止”(只停这一条,同端口
  // 其他通道不受影响);其他情况按钮为“公开”——同一端口可同时开多条通道
  // (不同隧道 / 不同 provider)互为备份,一条挂了不至于掉线。
  const effectiveMode: "tunnel" | "proxy" | "both" = protocol === "tcp" ? "tunnel" : mode;
  const selectedProvider = protocol === "tcp" ? undefined : provider === "none" ? undefined : provider;
  const normSite = (s?: string) => (s === undefined || s === "" ? "default" : s);
  const existing = exposes.find((e) => {
    if (e.port !== port || !e.running) return false;
    const m: "tunnel" | "proxy" | "both" = (e.name ?? "").startsWith("proxy:")
      ? "proxy"
      : // both-mode records carry localUrl ("" when transport is in-process,
        // i.e. pi-web's middleware); tunnel-only records have none.
        e.localUrl !== undefined
        ? "both"
        : "tunnel";
    if (m !== effectiveMode) return false;
    if (effectiveMode !== "proxy") {
      if (e.tunnelType !== tunnel) return false;
      if (e.protocol && e.protocol !== protocol) return false;
    }
    if ((e.provider ?? undefined) !== (selectedProvider ?? undefined)) return false;
    if (normSite(e.site) !== normSite(site || undefined)) return false;
    return true;
  });

  const stop = () => {
    if (!existing) return;
    setResult(null);
    setError(null);
    onStopExpose(existing.name);
  };

  const select = { padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flexShrink: 0 };

  /** 当前表单选项 → 方案配置（保存/另存共用一份果照）。Base Path 跟端口走
   *  （inject-ports 登记），一并入方案，加载时同步回写。 */
  const currentConfig = () => ({
    provider: protocol === "tcp" ? null : (provider ?? null),
    tunnel: tunnel || "cloudflared",
    protocol,
    mode: protocol === "tcp" ? "tunnel" : mode,
    site: site || "",
    serviceBasePath: serviceBasePath ?? "",
    tunnelParams: { ...tunnelParams },
    providerParams: { ...providerParams },
    inject: [...injectSel],
    loginInfoButton,
    // 一键动作：方案应用后自动执行（enroll/expose/开启注入源）
    actions: {
      ...(presetActions.enroll ? { enroll: true } : {}),
      ...(presetActions.expose ? { expose: true } : {}),
    },
  });

  /** 方案名自动生成：【模式】+【auth】@站点（tcp 无 auth 段；站点空不挂）。 */
  const suggestPresetName = () => {
    const modePart = protocol === "tcp" ? "tunnel" : mode;
    const authPart = protocol === "tcp" || !provider || provider === "none" ? "none" : provider;
    const sitePart = site || "default";
    return `${modePart}+${authPart}@${sitePart}`;
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-save", name, presetConfig: currentConfig() }),
    })
      .then((r) => r.json())
      .then((d: { saved?: { id: string }; presets?: { presets: Array<{ id: string; name: string; updatedAt: number }> }; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        if (d.presets) setPresets(d.presets.presets ?? []);
        if (d.saved?.id) setPresetId(d.saved.id);
        setSaveOpen(false);
        setPresetName("");
        // 动作勾选重置为默认——避免下次另存时残留「立即公开」等误触发
        setPresetActions({ enroll: false, expose: false });
      })
      .catch(() => setError(t("services.error")))
      .finally(() => setPresetBusy(false));
  };

  const deletePreset = () => {
    if (presetId === "__last__") return;
    setPresetBusy(true);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preset-delete", id: presetId }),
    })
      .then((r) => r.json())
      .then((d: { presets?: { presets: Array<{ id: string; name: string; updatedAt: number }> }; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        if (d.presets) setPresets(d.presets.presets ?? []);
        setPresetId("__last__");
      })
      .catch(() => setError(t("services.error")))
      .finally(() => setPresetBusy(false));
  };


  // 表单就绪门控：首次加载（providerOrder/方案/探测回填完成）前不渲染表单——
  // 避免用户看到硬编码默认值 → 异步回填逐个跳变（provider/tunnel/mode/protocol
  // 依次替换，“精分”）。readyRef 保证只在首帧骨架后一次到位。
  // 就绪条件：providers 已拉回（providerOrder 决定默认 provider）且「上次使用」
  // 回填流程已决定（有记录 → 回填完；无记录 → 保持默认）。
  // 表单就绪门控：providers 已拉回 **且** 预设回填已决定（lastUsed 异步加载完成/
  // 无预设/fetch 失败）前不渲染表单——避免用户看到默认值→异步回填逐个跳变
  // （provider/tunnel/mode 依次替换，“精分”）。
  // forceReady：3s 兜底——预设 fetch 异常挂起时不至于永远空白。
  const [formReady, setFormReady] = useState(false);
  const [forceReady, setForceReady] = useState(false);
  const presetsSettled = !presetBusy;
  useEffect(() => {
    if (providers.length > 0 && (presetsSettled || forceReady) && !formReady) {
      const t = setTimeout(() => setFormReady(true), 0);
      return () => clearTimeout(t);
    }
  }, [providers, presetsSettled, forceReady, formReady]);
  useEffect(() => {
    const t = setTimeout(() => setForceReady(true), 3000);
    return () => clearTimeout(t);
  }, []);

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 0 0", marginTop: 10, background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }}>
        {t("services.exposeSection")}
      </div>
      {!formReady ? (
        /* 骨架：加载中占位（高度近似，避免跳动） */
        <div style={{ padding: "14px 0", fontSize: 11, color: "var(--text-dim)" }}>⏳ {t("services.exposeLoading")}</div>
      ) : (
      <Fragment>
      {/* 方案：下拉选已存方案/上次使用；另存当前选项为方案 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.preset")}</span>
        <select
          value={presetId}
          onChange={(e) => { setPresetId(e.target.value); loadPresetIntoForm(e.target.value); }}
          disabled={presetBusy}
          style={select}
          title={t("services.presetHint")}
        >
          <option value="__last__">
            {lastUsedAt ? `${t("services.presetLastUsed")}（${new Date(lastUsedAt).toLocaleString()}）` : t("services.presetLastUsedNone")}
          </option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {presetId !== "__last__" && (
          <button onClick={deletePreset} disabled={presetBusy} title={t("services.presetDeleteHint")}
            style={{ flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "#f87171", cursor: "pointer", fontSize: 11 }}>
            {t("services.presetDelete")}
          </button>
        )}
        {!saveOpen ? (
          <button onClick={() => { setSaveOpen(true); setPresetName(suggestPresetName()); }}
            title={t("services.presetSaveAsHint")}
            style={{ flexShrink: 0, padding: "3px 10px", background: "var(--bg-hover)", border: "1px solid var(--accent)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 11 }}>
            ＋ {t("services.presetSaveAs")}
          </button>
        ) : (
          <>
            <input
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") savePreset(); if (e.key === "Escape") { setSaveOpen(false); setPresetName(""); } }}
              placeholder={t("services.presetNamePlaceholder")}
              autoFocus
              style={{ padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, width: 120 }}
            />
            <button onClick={savePreset} disabled={presetBusy || !presetName.trim()}
              style={{ flexShrink: 0, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 5, color: "#fff", cursor: presetBusy || !presetName.trim() ? "default" : "pointer", fontSize: 11 }}>
              {t("services.presetSave")}
            </button>
            {/* 一键动作：应用方案时自动执行（登记/公开/开启注入源） */}
            <div style={{ width: "100%", display: "flex", gap: 10, flexWrap: "wrap", padding: "2px 0 0", fontSize: 10, color: "var(--text-dim)" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title={t("services.presetActionsEnrollHint")}>
                <input type="checkbox" checked={!!presetActions.enroll} onChange={(e) => setPresetActions((p) => ({ ...p, enroll: e.target.checked }))} style={{ accentColor: "var(--accent)" }} />
                {t("services.presetActionsEnroll")}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }} title={t("services.presetActionsExposeHint")}>
                <input type="checkbox" checked={!!presetActions.expose} onChange={(e) => setPresetActions((p) => ({ ...p, expose: e.target.checked }))} style={{ accentColor: "var(--accent)" }} />
                {t("services.presetActionsExpose")}
              </label>
            </div>
            <button onClick={() => { setSaveOpen(false); setPresetName(""); }}
              style={{ flexShrink: 0, padding: "3px 10px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>
              {t("services.exposeAbort")}
            </button>
          </>
        )}
      </div>
      {/* 模式（tcp 仅 tunnel） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeMode")}</span>
        <select value={protocol === "tcp" ? "tunnel" : mode} onChange={(e) => setMode(e.target.value as "tunnel" | "proxy" | "both")} disabled={protocol === "tcp"} style={select}>
          <option value="tunnel">{t("services.exposeModeTunnel")}</option>
          <option value="proxy">{t("services.exposeModeProxy")}</option>
          <option value="both">{t("services.exposeModeBoth")}</option>
        </select>
        {/* 站点（认证域）只对有本地用户库的 provider（basic/authelia/portal，
            库的 userManagers）有意义——none/oauth2 系无用户库，站点字段不适用，
            不渲染。 */}
        {(provider ?? "") !== "none" && userManagers.includes(provider ?? "") && (
          <>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeSite")}</span>
            <select value={site} onChange={(e) => setSite(e.target.value)} style={select}>
              <option value="">{t("services.exposeSiteDefault")}</option>
              {sites.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </>
        )}
      </div>
      {/* tunnel 选项 + 协议（proxy 模式无隧道） */}
      {mode !== "proxy" && (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeProtocol")}</span>
        <select value={protocol} onChange={(e) => { const p = e.target.value as "http" | "https" | "tcp"; setProtocol(p); if (p === "tcp") setTunnel((cur) => (tcpTunnels.includes(cur) ? cur : (tcpTunnels[0] ?? cur))); if (p === "tcp") setMode("tunnel"); }} style={select}>
          <option value="http">http</option>
          <option value="https">https</option>
          <option value="tcp">tcp</option>
        </select>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeTunnelTool")}</span>
        <select value={tunnel} onChange={(e) => setTunnel(e.target.value)} style={select}>
          {[...Object.entries(tunnelSchemas ?? {})]
            // dangerous types (library TunnelMeta.dangerous — "command" runs a
            // raw shell command) are hidden from the one-click picker; name
            // fallback keeps older service-tunnels versions safe too.
            .filter(([p]) => !tunnelMetas?.[p]?.dangerous && p !== "command")
            .filter(([p]) => protocol !== "tcp" || tcpTunnels.includes(p))
            // 推荐(零账号/参数少)优先, 再按参数数量少在前
            .sort((a, b) => {
              const fa = tunnelMetas?.[a[0]]?.favorite ? 1 : 0;
              const fb = tunnelMetas?.[b[0]]?.favorite ? 1 : 0;
              if (fa !== fb) return fb - fa;
              return a[1].length - b[1].length;
            })
            .map(([k]) => (
              <option key={k} value={k}>{k}{tunnelMetas?.[k]?.favorite ? " ★" : ""}</option>
            ))}
        </select>
      </div>
      )}
      {/* tunnel 参数 */}
      {mode !== "proxy" && tunnelSchemas?.[tunnel] && (
        <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>
            {t("services.tunnelParams")}
            {tunnelMetas?.[tunnel]?.favorite && (
              <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "var(--accent)", color: "#fff", fontSize: 9, fontWeight: 600 }}>
                {t("services.recommended")}
              </span>
            )}
          </div>
          <SchemaForm specs={tunnelSchemas[tunnel]} values={tunnelParams} onChange={(k, v) => setTunnelParams((prev) => ({ ...prev, [k]: v }))} t={t} />
        </div>
      )}
      {/* Base Path：公开表单字段（端口真实服务前缀，如 vite base=/dev → dev）。
          编辑失焦/回车即写 binding（持久化）；公开/另存方案也带上。 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>Base Path</span>
        <input
          type="text"
          value={bpDraft ?? serviceBasePath ?? ""}
          placeholder={t("services.injectJsBasePathPlaceholder")}
          onChange={(e) => setBpDraft(e.target.value)}
          onBlur={() => { if (bpDraft !== null) { onSetBasePath?.(port, bpDraft); setBpDraft(null); } }}
          onKeyDown={(e) => { if (e.key === "Enter") { onSetBasePath?.(port, bpDraft ?? serviceBasePath ?? ""); setBpDraft(null); (e.target as HTMLInputElement).blur(); } }}
          title={t("services.injectJsBasePathHint")}
          style={{ width: 90, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, fontFamily: "var(--font-mono)" }}
        />
      </div>
      {/* 登录信息按钮（库内置注入）：FAB 显示登录用户名 + 退出登录——仅带认证 provider */}
      {provider && provider !== "none" && protocol !== "tcp" && (
        <label style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8, fontSize: 10, cursor: "pointer", color: loginInfoButton ? "var(--text)" : "var(--text-dim)" }} title={t("services.loginInfoButtonHint")}>
          <input
            type="checkbox"
            checked={loginInfoButton}
            onChange={(e) => setLoginInfoButton(e.target.checked)}
            style={{ accentColor: "var(--accent)", cursor: "pointer" }}
          />
          👤 {t("services.loginInfoButton")}
        </label>
      )}
      {/* 注入源勾选：公开配置的一部分（本通道页面注入哪些源）——随公开提交 */}
      {injectSources.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>🧰 {t("services.injectJs")}</span>
          {injectSources.map((s) => {
            const on = injectSel.includes(s.id);
            return (
              <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, cursor: "pointer", color: on ? "var(--text)" : "var(--text-dim)" }} title={s.description ?? ""}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => setInjectSel((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))}
                  style={{ accentColor: "var(--accent)", cursor: "pointer" }}
                />
                {s.label}
              </label>
            );
          })}
        </div>
      )}
      {/* auth 选项 + 立即公开（认证 provider 在站点之前——站点仅对
          basic/authelia/portal 适用，跟认证联动） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeProvider")}</span>
        <select value={provider ?? ""} onChange={(e) => {
          const next = e.target.value;
          setProvider(next);
          // 切到无本地用户库的 provider（none/oauth2 系）→ 站点不适用，清空
          if (!userManagers.includes(next)) setSite("");
        }} style={select}>
          <option value="" disabled>{t("services.selectProvider")}</option>
          {providers.map((p) => <option key={p} value={p}>{providerDisplayLabel(p, t, authMetas)}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        {existing ? (
          <button
            onClick={stop}
            title={t("services.exposeStopHint")}
            style={{ flexShrink: 0, padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}
          >
            {t("services.exposeStop")}
          </button>
        ) : (
          <button
            onClick={go}
            disabled={busy || checking}
            style={{ flexShrink: 0, padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: busy || checking ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
          >
            {busy ? t("services.exposing") : t("services.exposeGo")}
          </button>
        )}
      </div>
      {/* auth 参数 */}
      {provider && provider !== "none" && authSchemas?.[provider] && authSchemas[provider].length > 0 && (
        <div style={{ marginTop: 6, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>{t("services.authParams")}</div>
          <SchemaForm specs={authSchemas[provider]} values={providerParams} onChange={(k, v) => setProviderParams((prev) => ({ ...prev, [k]: v }))} t={t} />
        </div>
      )}
      {error && <div style={{ fontSize: 11, color: "#f87171", marginTop: 6 }}>{t("services.exposeFailed")}: {error}</div>}
      {result && (result.url || result.localUrl) && (
        <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeResult")}</div>
          {[result.url, result.localUrl, result.baseUrl, result.domainUrl].filter(Boolean).map((u) => (
            <button key={u} onClick={() => openInNewTab(u!)}
              style={{ display: "block", maxWidth: "100%", marginTop: 2, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", textAlign: "left", overflowWrap: "anywhere", wordBreak: "break-all" }}>
              {u}
            </button>
          ))}
          {result.loginUrl && (
            <button onClick={() => openInNewTab(result.loginUrl!)}
              style={{ marginTop: 6, padding: "4px 12px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 }}>
              {t("services.openLogin")}
            </button>
          )}
        </div>
      )}
      {confirmNone && (
        <ConfirmDialog
          title={t("services.confirmNoAuthTitle")}
          body={t("services.confirmNoAuthBodyPort", { port: String(port) })}
          confirmLabel={t("services.exposeConfirm")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setConfirmNone(false); doExpose(exposeOverrideRef.current); exposeOverrideRef.current = null;; }}
          onCancel={() => setConfirmNone(false)}
        />
      )}
      {noUsers && (
        <ConfirmDialog
          title={t("services.confirmNoUsersTitle")}
          body={t("services.confirmNoUsersBody", { provider: noUsers.provider, site: noUsers.site })}
          confirmLabel={t("services.confirmNoUsersGo")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setNoUsers(null); onGoManageUsers(); }}
          onCancel={() => setNoUsers(null)}
        />
      )}
      {userConfirm && (
        <ConfirmDialog
          title={t("services.confirmUsersTitle")}
          body={
            <div>
              <div style={{ fontSize: 11, lineHeight: 1.7 }}>{t("services.confirmUsersBody", { provider: userConfirm.provider, site: userConfirm.site })}</div>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text)" }}>
                {userConfirm.users.map((u) => <li key={u}>{u}</li>)}
              </ul>
            </div>
          }
          confirmLabel={t("services.confirmUsersConfirm")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setUserConfirm(null); doExpose(exposeOverrideRef.current); exposeOverrideRef.current = null;; }}
          onCancel={() => setUserConfirm(null)}
        />
      )}
      </Fragment>
      )}
    </div>
  );
}

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
  const btn = { padding: "4px 12px", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 };

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
              style={{ ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600, width: isMobile ? "100%" : undefined, textAlign: "center" }}>
              {busy ? t("services.adding") : t("services.sitesAdd")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AuthUsersSection({ t, isMobile }: { t: (key: string, params?: Record<string, string>) => string; isMobile: boolean }) {
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
  const btn = { padding: "4px 12px", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, flexShrink: 0 };

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
          <div style={{ background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(90vw, 360px)" }} onClick={(e) => e.stopPropagation()}>
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
                <button onClick={() => { const n = captureDone.name; setCaptureDone(null); setFaceCapture({ name: n, mode: "verify" }); }} style={{ ...btn, background: "var(--accent, #4f7cff)", borderStyle: "none", color: "#fff", fontWeight: 600 }}>
                  {t("services.bioFaceVerify")}
                </button>
              )}
              <button onClick={() => { const n = captureDone.name; setCaptureDone(null); setFaceCapture({ name: n, mode: "enroll" }); }} style={btn}>
                {t("services.bioFaceRerecord")}
              </button>
              <button onClick={() => setCaptureDone(null)} style={btn}>{t("services.close")}</button>
            </div>
          </div>
        </div>
      )}
      {pendingAction && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10001 }} onClick={() => setPendingAction(null)}>
          <div style={{ background: "var(--bg-panel, #1c1c24)", borderRadius: 12, padding: 18, width: "min(90vw, 360px)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text, #eee)", marginBottom: 6 }}>🙂 {t("services.bioFacePending")}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim, #999)", lineHeight: 1.6, marginBottom: 12 }}>{t("services.bioFacePendingHint")}</div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => { const n = pendingAction.name; setPendingAction(null); setFaceCapture({ name: n, mode: "verify" }); }} style={{ ...btn, background: "var(--accent, #4f7cff)", borderStyle: "none", color: "#fff", fontWeight: 600 }}>
                {t("services.bioFaceVerify")}
              </button>
              <button onClick={() => { const n = pendingAction.name; setPendingAction(null); setFaceCapture({ name: n, mode: "enroll" }); }} style={btn}>
                {t("services.bioFaceRerecord")}
              </button>
              <button onClick={() => setPendingAction(null)} style={btn}>{t("services.close")}</button>
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
            style={{ ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600, width: isMobile ? "100%" : undefined, textAlign: "center" }}>
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
                style={{ ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 }}>
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
                <button onClick={() => updateUserPassword(u.name)} disabled={busy || !newPw} style={{ ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 }}>
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
                  style={{ ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 }}>
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

/** Pi-web tab: self-exposure control + direct-access gate (allowlocal). */
function SelfTab({ self, t, openInNewTab, copy, copiedKey, onChanged, onGoManageUsers, exposes, onShowDetail, onStopExpose, injectSources }: {
  self: SelfState | null;
  t: (k: string, params?: Record<string, string>) => string;
  openInNewTab: (url: string) => void;
  copy: (key: string, url: string) => void;
  copiedKey: string | null;
  onChanged: () => void;
  /** Switch to the Users tab (no users for the selected auth combo). */
  onGoManageUsers: () => void;
  /** All exposes — to find the one behind a tunnel/vhost URL for the detail modal. */
  exposes: ExposeInfo[];
  /** Open the expose detail modal (link open + stop live there). */
  onShowDetail: (ex: ExposeInfo) => void;
  /** Stop ONE expose by name (proxy vhost rows — removes binding + record). */
  onStopExpose: (name: string) => void;
  /** 注入源清单（公开配置勾选用） */
  injectSources: Array<{ id: string; label: string; description?: string }>;
}) {
  // 多语:SelfTab 自身组件,单独拿 locale(与 ServicesDialog 的 stApi 一致)
  const { locale: selfLocale } = useI18n();
  // 暴露地址(tunnel / proxy vhost)点击 → 先弹详情,详情里可打开/停止;
  // 直连(回环/局域网)与例外域名仍直接打开。
  /** 暴露条目定位:tunnel 行按隧道名,vhost 行按 URL 匹配。 */
  const exposeFor = (u: { url: string; tunnel?: string }): ExposeInfo | undefined =>
    u.tunnel
      ? exposes.find((e) => e.name === u.tunnel)
      : exposes.find((e) => e.localUrl === u.url || e.baseUrl === u.url || e.domainUrl === u.url);

  const openOrDetail = (u: { url: string; tunnel?: string; authEntry?: boolean; label?: string }) => {
    if (!u.authEntry || (u.label ?? "").includes("allowHost")) { openInNewTab(u.url); return; }
    const ex = exposeFor(u);
    if (ex) onShowDetail(ex);
    else openInNewTab(u.url);
  };

  // proxy 虚拟主机行的停止目标(与 tunnel 行的红色停止一致):proxy 模式 →
  // 移除 binding + 记录;tunnel 行用各自的 doStopTunnel。
  const vhostStopName = (u: { url: string; tunnel?: string; authEntry?: boolean; label?: string; exposeName?: string }): string | undefined => {
    if (u.tunnel || !u.authEntry || (u.label ?? "").includes("allowHost")) return undefined;
    // exposeName 由服务端随 URL 条目下发(加载即有,不等 exposes 异步就绪)
    if (u.exposeName && (u.exposeName ?? "").startsWith("proxy:")) return u.exposeName;
    // fallback:先按 URL 匹配;URL 拼接不一致(basePath 来源不同等)时按 端口+site 兜底:
    // 自暴露的 proxy binding 一定是 site "pi-web" 的 proxy: 记录。
    const ex = exposeFor(u) ?? exposes.find((e) =>
      e.port === self?.port && (e.site === "pi-web" || (e.name ?? "").startsWith("expose-self-"))
      && (e.name ?? "").startsWith("proxy:"),
    );
    return ex && (ex.name ?? "").startsWith("proxy:") ? ex.name : undefined;
  };
  const [mode, setMode] = useState("tunnel");
  const [auth, setAuth] = useState("portal");
  // provider 列表来自库(数据驱动,与 Ports 页同源):oauth2-proxy / oauth2 变体 /
  // 插件 provider 自动出现——不硬编码 portal/basic/authelia
  const [providers, setProviders] = useState<string[] | null>(null);
  const [tunnel, setTunnel] = useState("cloudflared");
  // 隧道类型 schema 驱动(与 Ports 页同一数据源):serveo/bore/natapp/自定义
  // 类型都会出现,command 等 dangerous 类型隐藏——不再硬编码 4 项
  const [tunnelSchemas, setTunnelSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  const [tunnelMetas, setTunnelMetas] = useState<Record<string, { favorite?: boolean; dangerous?: boolean }> | null>(null);
  // 隧道/provider 参数(schema 驱动,与 Ports 页同款)——ngrok 等类型需要 token/domain
  const [tunnelParams, setTunnelParams] = useState<Record<string, string>>({});
  const [providerParams, setProviderParams] = useState<Record<string, string>>({});
  const [authSchemas, setAuthSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  // provider 页面元数据(label/已配置)来自库——picker 显示友好名称用
  const [authMetas, setAuthMetas] = useState<Record<string, { label?: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [allowHostsInput, setAllowHostsInput] = useState("");
  // 用户是否编辑过 allowHosts 输入框:未编辑时用当前生效值预填(输入即同步预览),
  // 一旦编辑就不再被轮询刷新覆盖
  const [allowHostsTouched, setAllowHostsTouched] = useState(false);
  // auth=none(无认证直接公开 pi-web)→ 泄露风险确认
  const [confirmNone, setConfirmNone] = useState(false);
  // 有本地用户库的 provider(portal/basic/authelia…)——公开前检查 site "pi-web" 是否有用户
  const [userManagers, setUserManagers] = useState<string[]>([]);
  // userManagers 清单是否已就绪(schema 拉取失败 → fail-closed,阻止直接公开)
  const [userManagersReady, setUserManagersReady] = useState(false);
  const [checking, setChecking] = useState(false);
  // 该 provider+site 无用户 → 提示去管理用户
  const [noUsers, setNoUsers] = useState<{ provider: string; site: string } | null>(null);
  // 有用户 → 列出用户名,让用户确认自己可登录
  const [userConfirm, setUserConfirm] = useState<{ provider: string; site: string; users: string[] } | null>(null);

  const exposing = self?.exposing ?? false;
  const allowLocal = self?.allowLocal ?? true;
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";
  const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
  const warnNonLoopback = exposing && !loopback;

  const btn: React.CSSProperties = {
    padding: "5px 12px",
    borderRadius: 5,
    cursor: "pointer",
    fontSize: 12,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "var(--border)",
    background: "none",
    color: "var(--text)",
  };
  const select: React.CSSProperties = {
    padding: "4px 6px",
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "var(--bg-panel)",
    color: "var(--text)",
    fontSize: 12,
  };

  // 隧道类型 schema 来自库(与 Ports 页同一数据源),默认 cloudflared;
  // 不可用时回退到第一个非危险类型
  // Mount-once (same rationale as the schemas fetch above); self.auth is read
  // through the closure and only used to prefill the provider select.
  useEffect(() => {
    fetch(`${apiUrl("/api/extensions/service-tunnels/status")}?lang=${encodeURIComponent(selfLocale)}`)
      .then((r) => r.json())
      .then((d: { providerOrder?: string[]; defaultProvider?: string; tunnelSchemas?: Record<string, ParamSpec[]>; tunnelMetas?: Record<string, { favorite?: boolean; dangerous?: boolean }>; authProviderSchemas?: Record<string, ParamSpec[]>; authMetas?: Record<string, { label?: string }>; userManagers?: string[] }) => {
        // provider 顺序/默认值由库下发(authelia 可用性、Windows 回退等都在
        // service-tunnels 内决定)——oauth2-proxy 等在此出现,无硬编码
        const order = d.providerOrder ?? ["portal", "basic"];
        setProviders(["none", ...order]);
        // 预填当前生效的 provider(self.auth = 正在暴露的 provider / env 配置)
        if (self?.auth && order.includes(self.auth)) setAuth(self.auth);
        if (d.tunnelSchemas) setTunnelSchemas(d.tunnelSchemas);
        if (d.tunnelMetas) setTunnelMetas(d.tunnelMetas);
        if (d.authProviderSchemas) setAuthSchemas(d.authProviderSchemas);
        if (d.authMetas) setAuthMetas(d.authMetas);
        if (d.userManagers) setUserManagers(d.userManagers);
        setUserManagersReady(true);
        if (d.tunnelSchemas && d.tunnelMetas) {
          const available = Object.keys(d.tunnelSchemas).filter(
            (k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command",
          );
          if (!available.includes("cloudflared")) setTunnel(available[0] ?? "cloudflared");
        }
      })
      .catch(() => {});
  // Mount-once (same rationale as the schemas fetch); self.auth is read
  // through the closure only to prefill the provider select.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleAllowLocal = (v: boolean) => {
    if (v === false) {
      // 关闭期间仍可访问的认证入口/例外域名(authEntries 含 allowHost 白名单)
      // 为空 → 弹窗提示并拒绝,不进入临时关闭——没有任何方式可访问,临时 30s 无意义
      if (authEntries.length === 0) {
        setRejectDialog(true);
        return;
      }
      // 第一阶段:服务端临时关闭(TTL 自动恢复),随即进入 30s 二次确认窗口
      setErr(null);
      setRestoredNotice(false);
      fetch(apiUrl("/api/extensions/service-tunnels/status"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "self-allowlocal", allowLocal: false, ttlMs: TTL_MS }),
      })
        .then((r) => r.json())
        .then((d: { error?: string }) => {
          if (d.error) { setErr(d.error); onChanged(); }
          else { setConfirmCountdown(CONFIRM_WINDOW); onChanged(); }
        })
        .catch(() => setErr(String(t("services.error"))))
        .finally(() => {});
      return;
    }
    // 开启/恢复:立即生效(安全操作)
    setErr(null);
    setRestoredNotice(false);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: true, confirm: true }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))));
  };

  // 第二阶段:二次确认 → 永久关闭
  const confirmDisableNow = () => {
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: false, confirm: true }),
    })
      .then(async (r) => {
        if (r.status === 403) { setBlockedHint(true); return null; } // 裸直连已被屏蔽:等自动恢复
        return r.json();
      })
      .then((d: { error?: string } | null) => { if (d === null) return; if (d.error) setErr(d.error); else { setConfirmCountdown(null); onChanged(); } })
      .catch(() => setErr(String(t("services.error"))));
  };

  // 取消/立即恢复(不等 TTL)
  const restoreNow = () => {
    setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowlocal", allowLocal: true, confirm: true }),
    })
      .then(async (r) => {
        if (r.status === 403) { setBlockedHint(true); return null; } // 裸直连已被屏蔽:等自动恢复
        return r.json();
      })
      .then((d: { error?: string } | null) => { if (d === null) return; if (d.error) setErr(d.error); else { setConfirmCountdown(null); setRestoredNotice(true); onChanged(); } })
      .catch(() => setErr(String(t("services.error"))));
  };

  // 两阶段关闭(Windows 分辨率式):第一阶段临时关闭(服务端 TTL 60s 自动恢复),
  // 30s 倒计时内二次确认才永久;超时/被锁点不了 → 服务端自动恢复,不会锁死
  const [confirmCountdown, setConfirmCountdown] = useState<number | null>(null); // null=未在确认
  const [restoredNotice, setRestoredNotice] = useState(false); // 超时自动恢复提示
  const [blockedHint, setBlockedHint] = useState(false); // 屏蔽期间按钮被 403 的温和提示
  const [rejectDialog, setRejectDialog] = useState(false); // 无可访问入口时拒绝关闭的弹窗
  const CONFIRM_WINDOW = 30; // 二次确认窗口(秒)
  const TTL_MS = 30_000; // 服务端临时关闭 TTL(与确认窗口一致,到期自动恢复)
  useEffect(() => {
    if (confirmCountdown === null) return;
    if (confirmCountdown <= 0) {
      // 窗口结束未确认 → 服务端 TTL 已自动恢复;关窗 + 提示
      setConfirmCountdown(null);
      setRestoredNotice(true);
      onChanged();
      return;
    }
    const t = setTimeout(() => setConfirmCountdown((c) => (c ?? 1) - 1), 1000);
    return () => clearTimeout(t);
  }, [confirmCountdown, onChanged]);
  // 关闭后仍可用的认证入口(虚拟主机/隧道 — 走代理认证,不受直连门禁影响)
  // 关闭期间仍可访问的认证入口:仅虚拟主机/隧道(authEntry),回环与局域网裸
  // 直连在 allowlocal=false 时同样 403,绝不列入
  const authEntries = (self?.urls ?? []).filter((u) => u.authEntry === true);
  // 暴露区地址:仅隧道/虚拟主机入口(排除 allowHost 例外域名)
  const exposeUrls = (self?.urls ?? []).filter((u) => u.authEntry === true && !u.label.includes("allowHost"));

  // allowHosts 输入框预填当前生效值(仅首次/未编辑时)
  useEffect(() => {
    if (!allowHostsTouched && (self?.allowHosts ?? []).length > 0) {
      setAllowHostsInput(self!.allowHosts.join(" "));
    }
  }, [self, allowHostsTouched]);

  const saveAllowHosts = () => {
    setErr(null);
    const hosts = allowHostsInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowhosts", hosts }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))));
  };

  const [injectSel, setInjectSel] = useState<string[]>([]);
  const doExpose = () => {
    setBusy(true); setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "self-expose",
        mode,
        provider: auth, // "none" 必须保留字符串,exposeSelf 判断 opts.auth === "none";传 undefined 会走默认 portal
        tunnel,
        tunnelParams,
        providerParams,
        ...(injectSel.length ? { inject: injectSel } : {}),
        ...(loginInfoButton ? { loginInfoButton: true } : {}),
      }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))))
      .finally(() => setBusy(false));
  };

  const checkUsers = () => {
    // 用户库清单未就绪(schema 拉取失败/进行中)→ fail-closed,提示重试而非静默公开
    if (!userManagersReady) {
      setErr(t("services.userCheckUnavailable"));
      return;
    }
    // 无本地用户库的 provider(oauth2-proxy 等)→ 无可检查,直接公开
    if (!userManagers.includes(auth)) { doExpose(); return; }
    setChecking(true); setErr(null);
    // pi-web 自暴露的认证域是 site "pi-web"(独立用户库,与 dev 服务分开)
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "user-list", provider: auth, site: "pi-web" }),
    })
      .then((r) => r.json())
      .then((d: { users?: { provider: string; users: { name: string; displayName: string }[] }[]; error?: string }) => {
        if (d.error) { setErr(d.error); return; }
        const entry = (d.users ?? []).find((x) => x.provider === auth);
        const users = entry?.users ?? [];
        if (users.length === 0) { setNoUsers({ provider: auth, site: "pi-web" }); return; }
        setUserConfirm({ provider: auth, site: "pi-web", users: users.map((u) => u.displayName || u.name) });
      })
      .catch(() => setErr(String(t("services.error"))))
      .finally(() => setChecking(false));
  };

  const startExpose = () => {
    // auth=none → pi-web 无认证直接公开,泄露风险确认
    if (auth === "none") { setConfirmNone(true); return; }
    // 带认证 → 检查 site "pi-web" 下该 provider 是否有可登录用户,再公开
    checkUsers();
  };

  // 单渠道停止:只停该隧道进程(如 localtunnel),vhost 绑定保留
  const doStopTunnel = (name: string) => {
    setBusy(true); setErr(null);
    fetch(apiUrl("/api/extensions/service-tunnels/status"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-stop-tunnel", name }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))))
      .finally(() => setBusy(false));
  };

  // 永久配置文本:allowHost 用输入框**实时值**(输入即同步,不等保存);tunnel/
  // provider 参数按 PI_WEB_EXPOSE 的 tunnel./provider. 前缀嵌套键序列化
  const liveAllowHosts = allowHostsInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
  const tunnelParamStr = Object.entries(tunnelParams).map(([k, v]) => `tunnel.${k}=${v}`).join(",");
  const providerParamStr = Object.entries(providerParams).map(([k, v]) => `provider.${k}=${v}`).join(",");
  const envSnippet = `PI_WEB_EXPOSE="mode=${mode},auth=${auth}${mode !== "proxy" ? `,tunnel=${tunnel}` : ""}${tunnelParamStr ? `,${tunnelParamStr}` : ""}${providerParamStr ? `,${providerParamStr}` : ""}${liveAllowHosts.length ? `,allowHost=${liveAllowHosts.join(",allowHost=")}` : ""}"`;
  const copyEnv = () => {
    copyText(envSnippet).then(() => {
      setCopiedEnv(true);
      setTimeout(() => setCopiedEnv(false), 1500);
    }).catch(() => {});
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Access URLs */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 8 }}>
          {t("services.selfAccessUrls")} <span style={{ fontWeight: 400, color: "var(--text-dim)" }}>· port {self?.port ?? "?"}</span>
        </div>
        {!self?.urls?.length ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("services.none")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {self.urls.map((u) => {
              // allowlocal=false 时,局域网直连入口被门禁拒绝 → 标灰不可打开
              const gated = !allowLocal && u.gated === true;
              return (
                <div key={u.url} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: gated ? 0.45 : 1 }}>
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", width: 110 }}>{u.labelKey ? t(u.labelKey, u.labelParams) : u.label}</span>
                  {u.noAuth && <NoAuthBadge t={t} />}
                  <button onClick={() => { if (!gated) openOrDetail(u); }}
                    title={gated ? t("services.selfGatedHint") : u.url}
                    disabled={gated}
                    style={{ flex: 1, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: gated ? "var(--text-dim)" : "var(--accent)", cursor: gated ? "not-allowed" : "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: gated ? "line-through" : "none" }}>
                    {u.url}
                  </button>
                  <button onClick={() => copy(`self-${u.url}`, u.url)} style={{ ...btn, padding: "3px 8px", flexShrink: 0 }}>
                    {copiedKey === `self-${u.url}` ? "✓" : t("services.copy")}
                  </button>
                  {u.tunnel && (
                    <button onClick={() => doStopTunnel(u.tunnel!)} disabled={busy} title={t("services.selfStopTunnelHint")}
                      style={{ ...btn, padding: "3px 8px", flexShrink: 0, color: "#f87171" }}>
                      {t("services.selfStopTunnel")}
                    </button>
                  )}
                  {vhostStopName(u) && (
                    /* proxy 虚拟主机行:与 tunnel 行一致,外面直接可停止(移除 binding) */
                    <button onClick={() => onStopExpose(vhostStopName(u)!)} disabled={busy} title={t("services.selfStopVhostHint")}
                      style={{ ...btn, padding: "3px 8px", flexShrink: 0, color: "#f87171" }}>
                      {t("services.exposeStop")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 无认证暴露 → 红色告警框（与页面顶部 🔴 条幅同源） */}
      {self?.unauthenticated && (
        <div style={{ border: "1px solid #f87171", borderRadius: 8, padding: "8px 10px", background: "rgba(248,113,113,0.08)", fontSize: 12, color: "#f87171" }}>
          🔴 {t("services.selfNoAuth")} — {t("services.selfNoAuthSummary")}
        </div>
      )}

      {warnNonLoopback && (
        <div style={{ border: "1px solid #f87171", borderRadius: 8, padding: "8px 10px", background: "rgba(248,113,113,0.08)", fontSize: 12, color: "#f87171" }}>
          ⚠ {t("services.selfWarning")}
        </div>
      )}

      {/* Expose controls */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
          {t("services.selfExpose")}
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: exposing ? (self?.unauthenticated ? "#f87171" : "#16a34a") : "var(--text-dim)" }}>
            ● {exposing ? t("services.selfExposing") : t("services.selfNotExposing")}
          </span>
        </div>
        {exposing && exposeUrls.length > 0 && (
          <div style={{ border: self?.unauthenticated ? "1px solid rgba(248,113,113,0.45)" : "1px solid rgba(22,163,74,0.3)", background: self?.unauthenticated ? "rgba(248,113,113,0.06)" : "rgba(22,163,74,0.06)", borderRadius: 6, padding: "8px 10px", marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: self?.unauthenticated ? "#f87171" : "#16a34a", marginBottom: 5 }}>{t("services.selfExposeUrls")}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {exposeUrls.map((u) => (
                <div key={u.url} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", width: 96 }}>{u.labelKey ? t(u.labelKey, u.labelParams) : u.label}</span>
                  {u.noAuth && <NoAuthBadge t={t} />}
                  <button onClick={() => openOrDetail(u)} title={u.url}
                    style={{ flex: 1, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.url}
                  </button>
                  <button onClick={() => copy(`self-expose-${u.url}`, u.url)} style={{ ...btn, padding: "3px 8px", flexShrink: 0 }}>
                    {copiedKey === `self-expose-${u.url}` ? "✓" : t("services.copy")}
                  </button>
                  {vhostStopName(u) && (
                    <button onClick={() => onStopExpose(vhostStopName(u)!)} disabled={busy} title={t("services.selfStopVhostHint")}
                      style={{ ...btn, padding: "3px 8px", flexShrink: 0, color: "#f87171" }}>
                      {t("services.exposeStop")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>{t("services.selfExposeHint")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("services.selfMode")}:
            <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ ...select, marginLeft: 4 }}>
              <option value="proxy">proxy</option>
              <option value="both">both</option>
              <option value="tunnel">tunnel</option>
            </select>
          </label>
          <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {t("services.selfAuth")}:
            <select value={auth} onChange={(e) => setAuth(e.target.value)} style={{ ...select, marginLeft: 4 }}>
              {/* 数据驱动:与 Ports 页同一 provider 列表(schema 拉取失败时回退 4 项) */}
              {(providers ?? ["none", "portal", "basic", "authelia"]).map((p) => (
                <option key={p} value={p}>{providerDisplayLabel(p, t, authMetas)}</option>
              ))}
            </select>
          </label>
          {mode !== "proxy" && (
            <label style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {t("services.selfTunnel")}:
              <select value={tunnel} onChange={(e) => setTunnel(e.target.value)} style={{ ...select, marginLeft: 4 }}>
                {[...Object.entries(tunnelSchemas ?? {})]
                  // 与 Ports 页同一过滤:dangerous 类型(纯 command 等)不出现
                  .filter(([p]) => !tunnelMetas?.[p]?.dangerous && p !== "command")
                  .sort((a, b) => {
                    const fa = tunnelMetas?.[a[0]]?.favorite ? 1 : 0;
                    const fb = tunnelMetas?.[b[0]]?.favorite ? 1 : 0;
                    if (fa !== fb) return fb - fa;
                    return a[1].length - b[1].length;
                  })
                  .map(([k]) => (
                    <option key={k} value={k}>{k}{tunnelMetas?.[k]?.favorite ? " ★" : ""}</option>
                  ))}
              </select>
            </label>
          )}
          {/* 注入源勾选（公开配置的一部分，随 self-expose 提交） */}
          {injectSources.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>🧰 {t("services.injectJs")}</span>
              {injectSources.map((s) => {
                const on = injectSel.includes(s.id);
                return (
                  <label key={s.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, cursor: "pointer", color: on ? "var(--text)" : "var(--text-dim)" }} title={s.description ?? ""}>
                    <input type="checkbox" checked={on} onChange={(e) => setInjectSel((prev) => (e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id)))} style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                    {s.label}
                  </label>
                );
              })}
            </div>
          )}
          {/* 始终显示"暴露"按钮——可同时启用多个渠道(隧道/虚拟主机);
              单个渠道在地址行用各自的红色"停止"按钮,不再提供"停止全部" */}
          <button onClick={startExpose} disabled={busy || checking} style={{ ...btn, background: "var(--accent)", borderStyle: "none", color: "#fff", fontWeight: 600 }}>
            {busy ? "…" : t("services.selfExposeBtn")}
          </button>
        </div>
        {/* 隧道参数(schema 驱动,同 Ports 页):ngrok 的 token/domain、frpc 的
            server/token 等随所选隧道类型出现 */}
        {mode !== "proxy" && tunnelSchemas?.[tunnel] && (
          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>
              {t("services.tunnelParams")}
              {tunnelMetas?.[tunnel]?.favorite && (
                <span style={{ marginLeft: 6, padding: "1px 6px", borderRadius: 8, background: "var(--accent)", color: "#fff", fontSize: 9, fontWeight: 600 }}>
                  {t("services.recommended")}
                </span>
              )}
            </div>
            <SchemaForm specs={tunnelSchemas[tunnel]} values={tunnelParams} onChange={(k, v) => setTunnelParams((prev) => ({ ...prev, [k]: v }))} t={t} />
          </div>
        )}
        {/* auth provider 参数(schema 驱动) */}
        {auth && auth !== "none" && authSchemas?.[auth] && authSchemas[auth].length > 0 && (
          <div style={{ marginTop: 8, padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600 }}>{t("services.authParams")}</div>
            <SchemaForm specs={authSchemas[auth]} values={providerParams} onChange={(k, v) => setProviderParams((prev) => ({ ...prev, [k]: v }))} t={t} />
          </div>
        )}
        {err && <div style={{ fontSize: 12, color: "#f87171", marginTop: 8 }}>{err}</div>}
      </div>


      {/* allowlocal — 放暴露控制下方（selfExposeHint 提示“直连 127/局域网由下方 allowlocal 开关控制”） */}
      <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }} title={t("services.selfAllowLocalHint")}>
        <input
          type="checkbox"
          checked={allowLocal}
          onChange={(e) => toggleAllowLocal(e.target.checked)}
          style={{ accentColor: "var(--accent)", cursor: "pointer", marginTop: 2 }}
        />
        <span style={{ fontSize: 12, color: "var(--text)" }}>
          <b>{t("services.selfAllowLocal")}</b>
          <span style={{ display: "block", color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>{t("services.selfAllowLocalHint")}</span>
          {!exposing && !allowLocal && (
            <span style={{ display: "block", color: "#d97706", fontSize: 11, marginTop: 4 }}>⚠ {t("services.selfNotExposingHint")}</span>
          )}
        </span>
      </label>

      {/* allowHosts — operator-protected front domains kept reachable when allowlocal=false */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>
          {t("services.selfAllowHosts")}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>{t("services.selfAllowHostsHint")}</div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={allowHostsInput}
            onChange={(e) => { setAllowHostsInput(e.target.value); setAllowHostsTouched(true); }}
            placeholder="backup.example.com vpn.example.com"
            style={{ flex: 1, padding: "4px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)" }}
          />
          <button onClick={saveAllowHosts} style={{ ...btn, flexShrink: 0 }}>{t("services.selfAllowHostsSave")}</button>
        </div>
        {(self?.allowHosts ?? []).length > 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
            {t("services.selfAllowHostsCurrent")}: <span style={{ fontFamily: "var(--font-mono)" }}>{self!.allowHosts.join(", ")}</span>
          </div>
        )}
      </div>

      {/* env snippet */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>{t("services.selfEnvHint")}</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <code style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, padding: "5px 8px", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{envSnippet}</code>
          <button onClick={copyEnv} style={{ ...btn, flexShrink: 0 }}>{copiedEnv ? "✓" : t("services.copy")}</button>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>{t("services.selfEnvNote")}</div>
      </div>

      {/* 两阶段关闭确认窗:已临时关闭,30s 内二次确认才永久;超时自动恢复 */}
      {confirmCountdown !== null && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: 520, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#f87171", marginBottom: 8 }}>⚠ {t("services.lockoutTitle", { ttl: String(TTL_MS / 1000) })}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>
              {t("services.lockoutCountdown", { window: String(CONFIRM_WINDOW), ttl: String(TTL_MS / 1000) })}
            </div>
            {/* 倒计时 + 进度条 */}
            <div style={{ marginTop: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: confirmCountdown <= 10 ? "#f87171" : "var(--text)", fontVariantNumeric: "tabular-nums", minWidth: 40 }}>{confirmCountdown}s</span>
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--bg-hover)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(confirmCountdown / CONFIRM_WINDOW) * 100}%`, background: confirmCountdown <= 10 ? "#f87171" : "var(--accent)", transition: "width 1s linear" }} />
                </div>
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.lockoutAutoRestore")}</div>
            </div>
            {blockedHint && (
              <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, background: "rgba(217,119,6,0.1)", border: "1px solid rgba(217,119,6,0.35)", fontSize: 11, color: "#d97706" }}>
                {t("services.lockoutBlockedHint", { ttl: String(TTL_MS / 1000) })}
              </div>
            )}
            {/* 仍可用入口:可点开验证 */}
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 4 }}>{t("services.lockoutStillWorks")}</div>
              {authEntries.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 6 }}>
                  {authEntries.map((u) => (
                    <div key={u.url} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
                      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{u.labelKey ? t(u.labelKey, u.labelParams) : u.label}</span>
                      <span style={{ flex: 1, fontFamily: "var(--font-mono)", overflowWrap: "anywhere", color: "var(--text)" }}>{u.url}</span>
                      <button onClick={() => openInNewTab(u.url)} style={{ ...btn, padding: "3px 10px", flexShrink: 0, color: "var(--accent)" }}>
                        {t("services.lockoutVerify")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button onClick={restoreNow} style={{ ...btn, flexShrink: 0 }}>{t("services.lockoutRestore")}</button>
              <span style={{ flex: 1 }} />
              <button
                onClick={confirmDisableNow}
                style={{ ...btn, background: "#f87171", borderStyle: "none", color: "#fff", fontWeight: 600 }}
              >
                {t("services.lockoutConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 无可访问入口:拒绝关闭的弹窗提示 */}
      {rejectDialog && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setRejectDialog(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#f87171", marginBottom: 8 }}>⚠ {t("services.lockoutNoEntryTitle")}</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>{t("services.lockoutNoEntry")}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button onClick={() => setRejectDialog(false)} style={{ ...btn }}>{t("services.close")}</button>
            </div>
          </div>
        </div>
      )}
      {restoredNotice && (
        <div style={{ marginTop: 6, padding: "6px 10px", borderRadius: 6, background: "rgba(22,163,74,0.1)", border: "1px solid rgba(22,163,74,0.35)", fontSize: 11, color: "#16a34a" }}>
          ✓ {t("services.lockoutRestored")}
        </div>
      )}
      {confirmNone && (
        <ConfirmDialog
          title={t("services.confirmNoAuthTitle")}
          body={t("services.confirmNoAuthBodySelf")}
          confirmLabel={t("services.exposeConfirm")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setConfirmNone(false); doExpose(exposeOverrideRef.current); exposeOverrideRef.current = null;; }}
          onCancel={() => setConfirmNone(false)}
        />
      )}
      {noUsers && (
        <ConfirmDialog
          title={t("services.confirmNoUsersTitle")}
          body={t("services.confirmNoUsersBody", { provider: noUsers.provider, site: noUsers.site })}
          confirmLabel={t("services.confirmNoUsersGo")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setNoUsers(null); onGoManageUsers(); }}
          onCancel={() => setNoUsers(null)}
        />
      )}
      {userConfirm && (
        <ConfirmDialog
          title={t("services.confirmUsersTitle")}
          body={
            <div>
              <div style={{ fontSize: 11, lineHeight: 1.7 }}>{t("services.confirmUsersBody", { provider: userConfirm.provider, site: userConfirm.site })}</div>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text)" }}>
                {userConfirm.users.map((u) => <li key={u}>{u}</li>)}
              </ul>
            </div>
          }
          confirmLabel={t("services.confirmUsersConfirm")}
          cancelLabel={t("services.exposeAbort")}
          onConfirm={() => { setUserConfirm(null); doExpose(exposeOverrideRef.current); exposeOverrideRef.current = null;; }}
          onCancel={() => setUserConfirm(null)}
        />
      )}
    </div>
  );
}
>>>>>>> Stashed changes
