import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { apiUrl, BASE_PATH } from "@/lib/base-path";
import { copyText } from "@/lib/clipboard";
import type { ParamSpec } from "service-tunnels";

export interface ServicePortInfo {
  port: number;
  pid: number;
  process: string;
  cmdline: string;
  /** Every concrete address the port is listening on (wildcards expanded). */
  addresses: string[];
}

interface TunnelInfo {
  name: string;
  cmd: string;
  running: boolean;
  pid: number | null;
  url: string | null;
  lastOutput: string;
}

interface ExposeInfo {
  name: string;
  port: number;
  tunnelType?: string;
  provider?: string;
  loginUrl?: string;
  protocol?: string;
  url: string | null;
  running: boolean;
  pid: number | null;
  accessLog: string | null;
  errorLog: string | null;
  site?: string;
  label?: string;
  localUrl?: string;
  baseUrl?: string;
  domainUrl?: string;
  mode?: string;
}

interface ServicesResponse {
  services: ServicePortInfo[];
  serviceHostSuffix: string;
  serviceHostSuffixes: string[];
  tunnels: TunnelInfo[];
  exposes: ExposeInfo[];
  platform: string;
  allowToolDownload?: boolean;
  toolStatus?: Array<{ name: string; path: string | null; source: "toolPaths" | "path" | "cache" | null }>;
}

interface SelfState {
  exposing: boolean;
  allowLocal: boolean;
  allowLocalPending: { pending: boolean; expiresAt: number };
  allowHosts: string[];
  port: number;
  mode: string | null;
  auth: string | null;
  tunnel: string | null;
  config: Record<string, unknown> | null;
  urls: Array<{ label: string; url: string; gated?: boolean; authEntry?: boolean }>;
}

function formatAddrForUrl(addr: string): string {
  return addr.includes(":") ? `[${addr}]` : addr;
}

function isLikelyIp(hostname: string): boolean {
  if (hostname.includes(":")) return true; // IPv6 literal
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

export function ServicesDialog({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [data, setData] = useState<ServicesResponse | null>(null);
  const [allowDownload, setAllowDownload] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logsData, setLogsData] = useState<{ access: string; error: string } | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [tab, setTab] = useState<"ports" | "self" | "users">("ports");
  const [self, setSelf] = useState<SelfState | null>(null);
  const [infoModal, setInfoModal] = useState<"access" | "auth" | null>(null);

  const refresh = useCallback((force = false) => {
    if (!force) setLoading(false);
    fetch(apiUrl(`/api/services${force ? "?refresh=1" : ""}`))
      .then((r) => r.json())
      .then((d: ServicesResponse) => {
        setData(d);
        setError(null);
      })
      .catch(() => setError(String(t("services.error"))))
      .finally(() => setLoading(false));
    // exposes (live, from service-tunnels) — merge into data so the
    // "Active exposes" section at the top shows them.
    fetch(apiUrl("/api/service-tunnels"))
      .then((r) => r.json())
      .then((d: { exposes?: ExposeInfo[]; allowToolDownload?: boolean; toolStatus?: ServicesResponse["toolStatus"]; self?: SelfState }) => {
        if (d.exposes) {
          const ex = d.exposes;
          setData((prev) => (prev ? { ...prev, exposes: ex } : prev));
        }
        if (typeof d.allowToolDownload === "boolean") setAllowDownload(d.allowToolDownload);
        if (d.toolStatus) {
          setData((prev) => (prev ? { ...prev, toolStatus: d.toolStatus } : prev));
        }
        if (d.self) setSelf(d.self);
      })
      .catch(() => {});
  }, [t]);

  useEffect(() => {
    refresh(true);
    const id = setInterval(() => refresh(), 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const scheme = typeof window !== "undefined" ? window.location.protocol : "http:";
  const pagePort = typeof window !== "undefined" && window.location.port
    ? `:${window.location.port}`
    : "";
  const hostname = typeof window !== "undefined" ? window.location.hostname.toLowerCase() : "";

  // Suffixes in display priority: current page domain first (so a deployment at
  // example.com proposes <port>.example.com:<page-port>), then the configured ones.
  const suffixes = data?.serviceHostSuffixes ?? [".pi.localhost"];
  const currentDomainSuffix = hostname && !isLikelyIp(hostname) && hostname !== "localhost"
      ? `.${hostname}`
      : null;

  // REAL registered proxy virtual hosts / tunnels — no default URL is
  // synthesized for un-exposed ports (the old pi-web "port.basehost" default
  // reverse-proxy display is removed; only actually-exposed URLs show).
  const directUrl = (port: number, addr: string) => `http://${formatAddrForUrl(addr)}:${port}/`;

  // Open in a new browser TAB: window.open without size features opens a tab,
  // and the button click is a user gesture so popup blockers allow it.
  // so popup blockers allow it.
  const openInNewTab = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const copy = (key: string, url: string) => {
    copyText(url).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
    }).catch(() => {});
  };

  const revealPort = useCallback((port: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(port);
      return next;
    });
    // Wait for the expanded drawer to render, then scroll the card into view.
    setTimeout(() => {
      document.getElementById(`port-card-${port}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, []);

  const stopExpose = useCallback((name: string) => {
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "tunnel-stop", name }),
    })
      .then(() => {
        setData((prev) =>
          prev ? { ...prev, exposes: (prev.exposes ?? []).filter((e) => e.name !== name) } : prev,
        );
        refresh(false);
      })
      .catch(() => {});
  }, [refresh]);

  const toggleExpand = (port: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(port)) next.delete(port);
      else next.add(port);
      return next;
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{
        width: isMobile ? "calc(100vw - 16px)" : 760,
        maxWidth: "calc(100vw - 16px)",
        height: isMobile ? "calc(100dvh - 16px)" : "min(620px, 82vh)",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{t("services.title")}</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("services.auto")}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => refresh(true)} disabled={loading} title={t("services.refresh")} aria-label={t("services.refresh")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: loading ? "default" : "pointer", padding: 4, display: "flex" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: loading ? "spin 0.8s linear infinite" : undefined }}>
                <path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" />
              </svg>
            </button>
            <button onClick={onClose} title={t("services.close")} aria-label={t("services.close")} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs: ports | users */}
        <div style={{ display: "flex", gap: 2, padding: "6px 14px 0", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          {(["ports", "self", "users"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              style={{
                padding: "6px 14px",
                background: "none",
                border: "none",
                borderBottom: tab === k ? "2px solid var(--accent)" : "2px solid transparent",
                color: tab === k ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: tab === k ? 600 : 400,
              }}
            >
              {k === "ports" ? t("services.tabPorts") : k === "self" ? t("services.tabSelf") : t("services.tabUsers")}
            </button>
          ))}
        </div>

        {tab === "ports" && (
          <>
            {/* Safety toggle — allow on-demand tool downloads */}
        {allowDownload !== null && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 18px", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text)", cursor: "pointer", flexShrink: 0 }} title={t("services.allowToolDownloadHint")}>
            <input
              type="checkbox"
              checked={allowDownload}
              onChange={(e) => {
                const next = e.target.checked;
                setAllowDownload(next);
                fetch(apiUrl("/api/service-tunnels"), {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "set-allow-tool-download", allowDownload: next }),
                }).catch(() => setAllowDownload(!next));
              }}
              style={{ accentColor: "var(--accent)", cursor: "pointer" }}
            />
            <span>{t("services.allowToolDownload")}</span>
            {(data?.toolStatus ?? []).filter((x) => x.source === null).length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                ({t("services.toolsMissing")}: {(data?.toolStatus ?? []).filter((x) => x.source === null).map((x) => x.name).join(", ")})
              </span>
            )}
          </label>
        )}

        {/* List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
          {(data?.exposes ?? []).length > 0 && (
            <div style={{ padding: "8px 10px", border: "1px solid var(--accent)", borderRadius: 8, background: "var(--bg-panel)", marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>{t("services.activeExposes")}</div>
              {(data?.exposes ?? []).map((ex) => (
                <div key={ex.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap", fontSize: 11 }}>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", flexShrink: 0 }}>127.0.0.1:{ex.port}</span>
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }}>{ex.localUrl && !ex.url ? "proxy" : (ex.tunnelType ?? "?")}</span>
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-dim)", flexShrink: 0 }}>{ex.protocol ?? "http"}</span>
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }}>{ex.provider ? `auth: ${ex.provider}` : "no auth"}</span>
                  <span style={{ fontSize: 10, color: ex.running ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }}>{ex.running ? t("services.tunnelRunning") : t("services.tunnelStopped")}</span>
                  {ex.running && (ex.url || ex.localUrl) && (
                    <div style={{ flex: 1, minWidth: 120, display: "flex", flexDirection: "column", gap: 2 }}>
                      {[ex.url, ex.localUrl, ex.baseUrl, ex.domainUrl].filter((x): x is string => Boolean(x)).map((u) => (
                        <button key={u} onClick={() => openInNewTab(u!)}
                          style={{ textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u}>
                          {u}
                        </button>
                      ))}
                    </div>
                  )}
                  {ex.running && (
                    <button onClick={() => stopExpose(ex.name)} style={{ flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{t("services.exposeStop")}</button>
                  )}
                  {ex.accessLog && (
                    <button onClick={() => { setLogsFor(logsFor === ex.name ? null : ex.name); if (logsFor !== ex.name) { setLogsLoading(true); fetch(apiUrl(`/api/service-tunnels?logs=${encodeURIComponent(ex.name)}`)).then((r) => r.json()).then((d: { access?: string; error?: string }) => { setLogsData({ access: d.access ?? "", error: d.error ?? "" }); setLogsLoading(false); }).catch(() => { setLogsLoading(false); setLogsData({ access: "(failed to read logs)", error: "" }); }); } }} style={{ flexShrink: 0, padding: "3px 10px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}>{logsFor === ex.name ? t("services.exposeLogsHide") : t("services.exposeLogs")}</button>
                  )}
                </div>
              ))}
              {logsFor && logsData && (
                <div style={{ marginTop: 6, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>access log{logsLoading ? " …" : ""}</div>
                  <pre style={{ maxHeight: 120, overflow: "auto", margin: 0, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 9, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text)" }}>{logsData.access || "(empty)"}</pre>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", margin: "6px 0 4px" }}>error log</div>
                  <pre style={{ maxHeight: 120, overflow: "auto", margin: 0, padding: "4px 6px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, fontSize: 9, fontFamily: "var(--font-mono)", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#f87171" }}>{logsData.error || "(empty)"}</pre>
                </div>
              )}
            </div>
          )}
          {error ? (
            <div style={{ fontSize: 13, color: "#f87171", padding: 12 }}>{error}</div>
          ) : loading && !data ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)", padding: 12 }}>{t("services.loading")}</div>
          ) : !data || data.services.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--text-dim)", padding: 20, textAlign: "center" }}>
              {t("services.none")}
            </div>
          ) : (
            data.services.map((s) => {
              const isOpen = expanded.has(s.port);
              const directUrls = s.addresses.map((addr) => ({ addr, url: directUrl(s.port, addr) }));
              // REAL proxy addresses from service-tunnels exposes (mode
              // proxy/both) — the old default "port.basehost" display is gone.
              const proxyExposes = (data?.exposes ?? []).filter((e) => e.port === s.port && (e.localUrl || e.baseUrl || e.domainUrl));
              const proxyUrls = proxyExposes.flatMap((e) => [
                ...(e.localUrl ? [{ url: e.localUrl, label: e.site && e.site !== "default" ? e.site : t("services.proxyLocal") }] : []),
                ...(e.baseUrl ? [{ url: e.baseUrl, label: t("services.proxyDomain") }] : []),
                ...(e.domainUrl ? [{ url: e.domainUrl, label: t("services.proxyDomain") }] : []),
              ]);
              // Deployment entry: <port>.<page-domain><basePath> — served by
              // pi-web's own virtual-host proxy (deployment domain from
              // PI_WEB_BASE_DOMAIN / page host + PI_WEB_BASE_PATH), only for
              // actually-exposed ports.
              if (proxyExposes.length > 0 && currentDomainSuffix && !currentDomainSuffix.startsWith(".localhost") && currentDomainSuffix !== ".pi.localhost") {
                proxyUrls.push({ url: `${scheme}//${s.port}${currentDomainSuffix}${pagePort}${BASE_PATH}`, label: t("services.proxyDeploy") });
              }
              const primaryUrl = proxyUrls[0]?.url ?? directUrls[0]?.url ?? "";
              return (
                <div key={s.port} id={`port-card-${s.port}`} style={{ marginBottom: 6, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                  {/* Collapsed row — click to expand */}
                  <div
                    onClick={() => toggleExpand(s.port)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isOpen}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpand(s.port); } }}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", cursor: "pointer", background: isOpen ? "var(--bg-panel)" : "none" }}
                    onMouseEnter={(e) => { if (!isOpen) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isOpen) e.currentTarget.style.background = "none"; }}
                  >
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--accent)", minWidth: 52 }}>{s.port}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.cmdline || s.process || `pid ${s.pid}`}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {t("services.listenOn")} {s.addresses.join(", ")} · pid {s.pid}
                      </div>
                    </div>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ flexShrink: 0, color: "var(--text-dim)", transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>

                  {/* Expanded area — access methods */}
                  {isOpen && (
                    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 12px", background: "var(--bg-panel)" }}>
                      {directUrls.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }}>{t("services.direct")}</div>
                          {directUrls.map(({ addr, url }) => (
                            <UrlRow key={url} url={url} label={addr === "127.0.0.1" || addr === "::1" ? "localhost" : addr}
                              isMobile={isMobile}
                              copied={copiedKey === url} onCopy={() => copy(url, url)} onOpen={() => openInNewTab(url)} />
                          ))}
                        </>
                      )}
                      {proxyUrls.length > 0 && (
                        <>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "10px 0 6px" }}>{t("services.viaProxy")}</div>
                          {proxyUrls.map(({ url, label }) => (
                            <UrlRow key={url} url={url}
                              isMobile={isMobile}
                              label={label}
                              copied={copiedKey === url} onCopy={() => copy(url, url)} onOpen={() => openInNewTab(url)} />
                          ))}
                        </>
                      )}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                        <button
                          onClick={() => openInNewTab(primaryUrl)}
                          style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, flexShrink: 0 }}
                        >
                          {t("services.open")}
                        </button>
                        <span style={{ fontSize: 11, color: "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{primaryUrl}</span>
                      </div>
                      <AuthExposeSection port={s.port} t={t} isMobile={isMobile} openInNewTab={openInNewTab} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Bottom: configured tunnels + info entries (open modals) */}
        <div style={{ padding: "8px 14px 10px", borderTop: "1px solid var(--border)", flexShrink: 0, background: "var(--bg-panel)", maxHeight: "34%", overflowY: "auto" }}>
                    <div style={{ display: "flex", gap: 16, padding: "4px 0", flexWrap: "wrap" }}>
            <button onClick={() => setInfoModal("access")}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontSize: 11, textAlign: "left" }}>
              {t("services.infoAccess")} ›
            </button>
            <button onClick={() => setInfoModal("auth")}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--accent)", fontSize: 11, textAlign: "left" }}>
              {(data?.exposes ?? []).length > 0 ? "⚠ " : "🔒 "}
              {t("services.infoAuth")} ›
            </button>
          </div>
        </div>
          </>
        )}

        {/* Pi-web tab — self-exposure + direct-access gate */}
        {tab === "self" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            <SelfTab self={self} t={t} openInNewTab={openInNewTab} copy={copy} copiedKey={copiedKey} onChanged={refresh} />
          </div>
        )}

        {/* Users tab — auth user management (library UserManager) */}
        {tab === "users" && (
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 10 }}>
              {t("services.authUsers")}
            </div>
            <AuthUsersSection t={t} />
          </div>
        )}

        {infoModal && (
          <InfoModal
            kind={infoModal}
            t={t}
            currentDomainSuffix={currentDomainSuffix}
            pagePort={pagePort}
            basePath={BASE_PATH}
            onClose={() => setInfoModal(null)}
          />
        )}
      </div>
    </div>
  );
}

/** Generic schema-driven param form (labels, descriptions, links, defaults,
 *  password/number/select inputs). Rendered for every tunnel type / auth
 *  provider from service-tunnels' ParamSpec — adding a provider or tunnel
 *  type needs NO dialog changes. */
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
      {specs.map((s) => (
        <div key={s.key}>
          <label style={{ fontSize: 10, color: "var(--text-muted)", display: "block", marginTop: 5 }}>
            {s.label ?? s.key}{s.required ? " *" : ""}
            {s.link && (
              <a href={s.link} target="_blank" rel="noreferrer" style={{ color: "var(--accent)", marginLeft: 6, fontSize: 9 }}>
                {s.linkTitle ?? t("services.docs")}
              </a>
            )}
          </label>
          {s.options ? (
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
      ))}
    </div>
  );
}


function SummarySection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid var(--border)", padding: "6px 0" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: "3px 0", cursor: "pointer", color: "var(--text-muted)", fontSize: 11, fontWeight: 600, textAlign: "left" }}
      >
        <span style={{ flex: 1 }}>{title}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && <div style={{ marginTop: 4 }}>{children}</div>}
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

/**
 * Public access with auth — pick a provider, optionally require sign-in,
 * and open the tunnel through the service-tunnels nginx gateway.
 */
function AuthExposeSection({ port, t, isMobile, openInNewTab }: {
  port: number;
  t: (key: string, params?: Record<string, string>) => string;
  isMobile: boolean;
  openInNewTab: (url: string) => void;
}) {
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
  const [tunnelParams, setTunnelParams] = useState<Record<string, string>>({});
  const [providerParams, setProviderParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ url?: string | null; loginUrl?: string; localUrl?: string; baseUrl?: string; domainUrl?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tunnel types + provider params come from service-tunnels schemas
  // (data-driven — adding a tunnel type / auth provider needs NO dialog
  // changes). Provider order/default come from the library too.
  useEffect(() => {
    fetch(apiUrl("/api/service-tunnels"))
      .then((r) => r.json())
      .then((d: { providerOrder?: string[]; defaultProvider?: string; tunnelSchemas?: Record<string, ParamSpec[]>; tunnelMetas?: Record<string, { favorite?: boolean; dangerous?: boolean }>; authProviderSchemas?: Record<string, ParamSpec[]>; tunnelTcpSupport?: string[]; sites?: { name: string }[] }) => {
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
        // Skip dangerous tunnel types (TunnelMeta.dangerous — e.g. "command",
        // which runs a raw shell command) when picking a tcp-capable default;
        // name fallback covers service-tunnels versions without the flag.
        if (d.tunnelTcpSupport) setTcpTunnels(d.tunnelTcpSupport.filter((k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command"));
        if (d.sites) setSites(d.sites.filter((s) => s.name !== "default").map((s) => s.name));
      })
      .catch(() => {});
  }, []);

  // Auto-detect the port's protocol (http/https/tcp) so the user sees it up
  // front and the tunnel options adjust (tcp → only tcp-capable tunnels).
  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    fetch(apiUrl(`/api/service-tunnels?detect=${port}`))
      .then((r) => r.json())
      .then((d: { protocol?: "http" | "https" | "tcp" }) => {
        if (!cancelled && d.protocol) setProtocol(d.protocol);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [port]);

  const go = () => {
    setBusy(true);
    setError(null);
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "expose",
        port,
        auth: provider !== "none" && protocol !== "tcp",
        // tcp exposes never carry gateway auth — the library's expose tcp
        // path ignores the provider; send it as-is (no name hardcoding here).
        provider,
        tunnel,
        protocol,
        mode: protocol === "tcp" ? "tunnel" : mode,
        site: site || undefined,
        tunnelParams,
        providerParams,
      }),
    })
      .then((r) => r.json())
      .then((d: { url?: string | null; loginUrl?: string; localUrl?: string; baseUrl?: string; domainUrl?: string; error?: string }) => {
        if (d.error) {
          setError(d.error);
          setResult(null);
        } else {
          setResult({ url: d.url ?? null, loginUrl: d.loginUrl, localUrl: d.localUrl, baseUrl: d.baseUrl, domainUrl: d.domainUrl });
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const select = { padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11, flexShrink: 0 };

  return (
    <div style={{ borderTop: "1px solid var(--border)", padding: "10px 0 0", marginTop: 10, background: "var(--bg-panel)" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "4px 0 6px" }}>
        {t("services.exposeSection")}
      </div>
      {/* 模式 + 站点（tcp 仅 tunnel） */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeMode")}</span>
        <select value={protocol === "tcp" ? "tunnel" : mode} onChange={(e) => setMode(e.target.value as "tunnel" | "proxy" | "both")} disabled={protocol === "tcp"} style={select}>
          <option value="tunnel">{t("services.exposeModeTunnel")}</option>
          <option value="proxy">{t("services.exposeModeProxy")}</option>
          <option value="both">{t("services.exposeModeBoth")}</option>
        </select>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeSite")}</span>
        <select value={site} onChange={(e) => setSite(e.target.value)} style={select}>
          <option value="">{t("services.exposeSiteDefault")}</option>
          {sites.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
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
      {/* auth 选项 + 立即公开 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeProvider")}</span>
        <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value)} style={select}>
          <option value="" disabled>{t("services.selectProvider")}</option>
          {providers.map((p) => <option key={p} value={p}>{p === "none" ? t("services.exposeProviderNone") : p}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <button
          onClick={go}
          disabled={busy}
          style={{ flexShrink: 0, padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: busy ? "default" : "pointer", fontSize: 11, fontWeight: 600 }}
        >
          {busy ? t("services.exposing") : t("services.exposeGo")}
        </button>
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
    </div>
  );
}

/**
 * Auth user management — pick a provider with a local user database, list
 * users, add / set-password / remove, and toggle TOTP 2FA (portal provider).
 */
function AuthUsersSection({ t }: { t: (key: string, params?: Record<string, string>) => string }) {
  const [providers, setProviders] = useState<string[]>(["portal"]);
  const [provider, setProvider] = useState<string | null>(null);
  const [totpProviders, setTotpProviders] = useState<string[]>([]);
  const [users, setUsers] = useState<{ name: string; displayName: string; totp?: boolean }[]>([]);
  const [totpState, setTotpState] = useState<Record<string, boolean>>({});
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pwUser, setPwUser] = useState<string | null>(null);
  const [newPw, setNewPw] = useState("");
  const [totpEnrolled, setTotpEnrolled] = useState<{ name: string; secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState("");
  const [sites, setSites] = useState<string[]>([]);

  const post = (action: string, extra: Record<string, unknown> = {}) =>
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, provider, site: site || undefined, ...extra }),
    }).then((r) => r.json());

  const loadUsers = useCallback((prov: string = provider ?? "") => {
    post("user-list", { provider: prov }).then((d: { users?: { provider: string; users: { name: string; displayName: string }[] }[] }) => {
      const entry = (d.users ?? []).find((x) => x.provider === prov);
      setUsers((entry?.users ?? []).map((u) => ({ ...u, totp: Boolean(totpState[u.name]) })));
      // TOTP status for each provider that supports it (portal + authelia)
      if (totpProviders.includes(prov)) {
        for (const u of entry?.users ?? []) {
          post("totp-status", { provider: prov, name: u.name }).then((s: { enrolled?: boolean }) => {
            setTotpState((prev) => ({ ...prev, [u.name]: Boolean(s.enrolled) }));
          }).catch(() => {});
        }
      }
    }).catch(() => setError(String(t("services.error"))));
    // site must be a dep: the post closure captures it — the user list is
    // per auth realm, switching the site must reload that realm's users.
  }, [provider, site]);

  useEffect(() => {
    fetch(apiUrl("/api/service-tunnels"))
      .then((r) => r.json())
      .then((d: { userManagers?: string[]; defaultProvider?: string; totpProviders?: string[]; sites?: { name: string }[] }) => {
        // User-management providers come from the library's userManagers()
        // (providers with a local user db — oauth2-proxy etc. excluded there,
        // not hardcoded here).
        const ps = d.userManagers ?? ["portal", "basic"];
        setProviders(ps.length ? ps : ["portal", "basic"]);
        const preferred = d.defaultProvider ?? ps[0] ?? "portal";
        setProvider((cur) => (cur === null ? (ps.includes(preferred) ? preferred : (ps[0] ?? "portal")) : cur));
        if (d.totpProviders) setTotpProviders(d.totpProviders);
        if (d.sites) setSites(d.sites.filter((s) => s.name !== "default").map((s) => s.name));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { if (provider) loadUsers(); }, [provider, site]);

  const addUser = () => {
    if (!name || !password) return;
    setBusy(true);
    setError(null);
    post("user-add", { name, password, displayName: displayName || undefined })
      .then(() => { setName(""); setPassword(""); setDisplayName(""); loadUsers(); })
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

  const removeUser = (uname: string) => {
    setBusy(true);
    post("user-remove", { name: uname })
      .catch((e) => setError(String(e)))
      .finally(() => { setBusy(false); loadUsers(); });
  };

  const enrollTotp = (uname: string) => {
    setBusy(true);
    setTotpEnrolled(null);
    setQrUrl(null);
    setTotpCode("");
    post("totp-enroll", { provider: provider ?? undefined, name: uname })
      .then((d: { secret?: string; otpauthUrl?: string }) => {
        setTotpEnrolled(d.secret ? { name: uname, secret: d.secret, otpauthUrl: d.otpauthUrl ?? "" } : null);
        loadUsers();
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const activateTotp = (uname: string) => {
    if (!totpCode) return;
    setBusy(true);
    post("totp-activate", { provider: provider ?? undefined, name: uname, code: totpCode })
      .then((d: { activated?: boolean; error?: string }) => {
        if (d.activated) {
          setTotpEnrolled(null);
          setQrUrl(null);
          setTotpCode("");
          loadUsers();
        } else {
          setError(d.error ?? t("services.totpActivateFailed"));
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };

  const disableTotp = (uname: string) => {
    setBusy(true);
    post("totp-disable", { provider: provider ?? undefined, name: uname })
      .catch((e) => setError(String(e)))
      .finally(() => { setBusy(false); loadUsers(); });
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

  return (
    <div style={{ padding: "6px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeProvider")}</span>
        <select value={provider ?? ""} onChange={(e) => setProvider(e.target.value)}
          style={{ padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11 }}>
          <option value="" disabled>{t("services.selectProvider")}</option>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{t("services.exposeSite")}</span>
        <select value={site} onChange={(e) => setSite(e.target.value)}
          style={{ padding: "4px 6px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 11 }}>
          <option value="">{t("services.exposeSiteDefault")}</option>
          {sites.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {error && <div style={{ fontSize: 11, color: "#f87171", margin: "0 0 6px" }}>{error}</div>}

      {/* add user */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <input placeholder={t("services.userName")} value={name} onChange={(e) => setName(e.target.value)} style={{ ...input, flex: 1 }} />
        <input placeholder={t("services.userPassword")} type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ ...input, flex: 1 }} />
        <input placeholder={t("services.userDisplayName")} value={displayName} onChange={(e) => setDisplayName(e.target.value)} style={{ ...input, flex: 1 }} />
        <button onClick={addUser} disabled={busy || !name || !password}
          style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }}>
          {busy ? t("services.adding") : t("services.addUser")}
        </button>
      </div>

      {/* user list */}
      {users.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("services.noUsers")}</div>
      ) : users.map((u) => (
        <div key={u.name} style={{ padding: "6px 8px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flexShrink: 0 }}>{u.displayName}</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{u.name}</span>
            <span style={{ fontSize: 10, color: totpState[u.name] ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }}>
              {totpState[u.name] ? t("services.totpEnrolled") : t("services.totpOff")}
            </span>
            <span style={{ flex: 1 }} />
            {provider && totpProviders.includes(provider) && (
              totpState[u.name] ? (
                <button onClick={() => disableTotp(u.name)} style={btn}>{t("services.totpDisable")}</button>
              ) : (
                <button onClick={() => enrollTotp(u.name)} style={btn}>{t("services.totpEnroll")}</button>
              )
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
          <div style={{ fontSize: 10, color: "#8a6d1a" }}>{t("services.totpSecret")} ({totpEnrolled.name})</div>
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginTop: 6, flexWrap: "wrap" }}>
            {qrUrl && (
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
              <button onClick={() => activateTotp(totpEnrolled.name)} disabled={busy || !totpCode}
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

/** Pi-web tab: self-exposure control + direct-access gate (allowlocal). */
function SelfTab({ self, t, openInNewTab, copy, copiedKey, onChanged }: {
  self: SelfState | null;
  t: (k: string, params?: Record<string, string>) => string;
  openInNewTab: (url: string) => void;
  copy: (key: string, url: string) => void;
  copiedKey: string | null;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState("proxy");
  const [auth, setAuth] = useState("portal");
  const [tunnel, setTunnel] = useState("cloudflared");
  // 隧道类型 schema 驱动(与 Ports 页同一数据源):serveo/bore/natapp/自定义
  // 类型都会出现,command 等 dangerous 类型隐藏——不再硬编码 4 项
  const [tunnelSchemas, setTunnelSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  const [tunnelMetas, setTunnelMetas] = useState<Record<string, { favorite?: boolean; dangerous?: boolean }> | null>(null);
  // 隧道/provider 参数(schema 驱动,与 Ports 页同款)——ngrok 等类型需要 token/domain
  const [tunnelParams, setTunnelParams] = useState<Record<string, string>>({});
  const [providerParams, setProviderParams] = useState<Record<string, string>>({});
  const [authSchemas, setAuthSchemas] = useState<Record<string, ParamSpec[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [allowHostsInput, setAllowHostsInput] = useState("");
  // 用户是否编辑过 allowHosts 输入框:未编辑时用当前生效值预填(输入即同步预览),
  // 一旦编辑就不再被轮询刷新覆盖
  const [allowHostsTouched, setAllowHostsTouched] = useState(false);

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
    border: "1px solid var(--border)",
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
  useEffect(() => {
    fetch(apiUrl("/api/service-tunnels"))
      .then((r) => r.json())
      .then((d: { tunnelSchemas?: Record<string, ParamSpec[]>; tunnelMetas?: Record<string, { favorite?: boolean; dangerous?: boolean }>; authProviderSchemas?: Record<string, ParamSpec[]> }) => {
        if (d.tunnelSchemas) setTunnelSchemas(d.tunnelSchemas);
        if (d.tunnelMetas) setTunnelMetas(d.tunnelMetas);
        if (d.authProviderSchemas) setAuthSchemas(d.authProviderSchemas);
        if (d.tunnelSchemas && d.tunnelMetas) {
          const available = Object.keys(d.tunnelSchemas).filter(
            (k) => !d.tunnelMetas?.[k]?.dangerous && k !== "command",
          );
          if (!available.includes("cloudflared")) setTunnel(available[0] ?? "cloudflared");
        }
      })
      .catch(() => {});
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
      fetch(apiUrl("/api/service-tunnels"), {
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
    fetch(apiUrl("/api/service-tunnels"), {
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
    fetch(apiUrl("/api/service-tunnels"), {
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
    fetch(apiUrl("/api/service-tunnels"), {
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

  // allowHosts 输入框预填当前生效值(仅首次/未编辑时)
  useEffect(() => {
    if (!allowHostsTouched && (self?.allowHosts ?? []).length > 0) {
      setAllowHostsInput(self!.allowHosts.join(" "));
    }
  }, [self, allowHostsTouched]);

  const saveAllowHosts = () => {
    setErr(null);
    const hosts = allowHostsInput.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-allowhosts", hosts }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))));
  };

  const doExpose = () => {
    setBusy(true); setErr(null);
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "self-expose",
        mode,
        provider: auth === "none" ? undefined : auth,
        tunnel,
        tunnelParams,
        providerParams,
      }),
    })
      .then((r) => r.json())
      .then((d: { error?: string }) => { if (d.error) setErr(d.error); else onChanged(); })
      .catch(() => setErr(String(t("services.error"))))
      .finally(() => setBusy(false));
  };

  const doStop = () => {
    setBusy(true); setErr(null);
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "self-stop" }),
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
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", width: 110 }}>{u.label}</span>
                  <button onClick={() => { if (!gated) openInNewTab(u.url); }}
                    title={gated ? t("services.selfGatedHint") : u.url}
                    disabled={gated}
                    style={{ flex: 1, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: gated ? "var(--text-dim)" : "var(--accent)", cursor: gated ? "not-allowed" : "pointer", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: gated ? "line-through" : "none" }}>
                    {u.url}
                  </button>
                  <button onClick={() => copy(`self-${u.url}`, u.url)} style={{ ...btn, padding: "3px 8px", flexShrink: 0 }}>
                    {copiedKey === `self-${u.url}` ? "✓" : t("services.copy")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {warnNonLoopback && (
        <div style={{ border: "1px solid #f87171", borderRadius: 8, padding: "8px 10px", background: "rgba(248,113,113,0.08)", fontSize: 12, color: "#f87171" }}>
          ⚠ {t("services.selfWarning")}
        </div>
      )}

      {/* allowlocal */}
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

      {/* Expose controls */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)" }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>
          {t("services.selfExpose")}
          <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: exposing ? "#16a34a" : "var(--text-dim)" }}>
            ● {exposing ? t("services.selfExposing") : t("services.selfNotExposing")}
          </span>
        </div>
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
              <option value="portal">portal</option>
              <option value="basic">basic</option>
              <option value="authelia">authelia</option>
              <option value="none">none</option>
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
          {!exposing ? (
            <button onClick={doExpose} disabled={busy} style={{ ...btn, background: "var(--accent)", border: "none", color: "#fff", fontWeight: 600 }}>
              {busy ? "…" : t("services.selfExposeBtn")}
            </button>
          ) : (
            <button onClick={doStop} disabled={busy} style={{ ...btn }}>
              {busy ? "…" : t("services.selfStopBtn")}
            </button>
          )}
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
                      <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{u.label}</span>
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
                style={{ ...btn, background: "#f87171", border: "none", color: "#fff", fontWeight: 600 }}
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
    </div>
  );
}
