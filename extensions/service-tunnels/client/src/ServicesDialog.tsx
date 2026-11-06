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
