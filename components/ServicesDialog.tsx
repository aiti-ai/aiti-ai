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
  const [tab, setTab] = useState<"ports" | "users">("ports");
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
      .then((d: { exposes?: ExposeInfo[]; allowToolDownload?: boolean; toolStatus?: ServicesResponse["toolStatus"] }) => {
        if (d.exposes) {
          const ex = d.exposes;
          setData((prev) => (prev ? { ...prev, exposes: ex } : prev));
        }
        if (typeof d.allowToolDownload === "boolean") setAllowDownload(d.allowToolDownload);
        if (d.toolStatus) {
          setData((prev) => (prev ? { ...prev, toolStatus: d.toolStatus } : prev));
        }
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
  const currentDomainSuffix =
    hostname && !isLikelyIp(hostname) && hostname !== "localhost"
      ? `.${hostname}`
      : null;
  const orderedSuffixes = currentDomainSuffix
    ? [currentDomainSuffix, ...suffixes.filter((s) => s !== currentDomainSuffix)]
    : suffixes;

  // Service URLs carry pi-web's basePath (e.g. /dev) so reverse proxies that
  // path-route pi-web (nginx `location /dev/`) forward them here; proxy.ts
  // strips the basePath before reaching the service. No trailing slash: with a
  // basePath, ".../dev/" triggers Next's basePath 308 redirect.
  const proxyUrl = (port: number, suffix: string) => `${scheme}//${port}${suffix}${pagePort}${BASE_PATH}`;
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
        width: isMobile ? "calc(100vw - 16px)" : 600,
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
          {(["ports", "users"] as const).map((k) => (
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
              {k === "ports" ? t("services.tabPorts") : t("services.tabUsers")}
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
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }}>{ex.tunnelType ?? "?"}</span>
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-dim)", flexShrink: 0 }}>{ex.protocol ?? "http"}</span>
                  <span style={{ padding: "1px 6px", background: "var(--bg-hover)", borderRadius: 4, color: "var(--text-muted)", flexShrink: 0 }}>{ex.provider ? `auth: ${ex.provider}` : "no auth"}</span>
                  <span style={{ fontSize: 10, color: ex.running ? "#16a34a" : "var(--text-dim)", flexShrink: 0 }}>{ex.running ? t("services.tunnelRunning") : t("services.tunnelStopped")}</span>
                  {ex.url && ex.running && (
                    <button onClick={() => openInNewTab(ex.url!)} style={{ flex: 1, minWidth: 120, textAlign: "left", padding: "3px 6px", background: "none", border: "1px solid var(--border)", borderRadius: 5, color: "var(--accent)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={ex.url}>{ex.url}</button>
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
              const proxyUrls = orderedSuffixes.map((suffix) => ({ suffix, url: proxyUrl(s.port, suffix) }));
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
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", margin: "10px 0 6px" }}>{t("services.viaProxy")}</div>
                      {proxyUrls.map(({ suffix, url }) => (
                        <UrlRow key={url} url={url}
                          isMobile={isMobile}
                          label={suffix === currentDomainSuffix ? t("services.currentDomain") : suffix === ".pi.localhost" ? t("services.sameMachine") : suffix}
                          copied={copiedKey === url} onCopy={() => copy(url, url)} onOpen={() => openInNewTab(url)} />
                      ))}
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
  const [tunnelMetas, setTunnelMetas] = useState<Record<string, { favorite?: boolean }> | null>(null);
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
      .then((d: { providerOrder?: string[]; defaultProvider?: string; tunnelSchemas?: Record<string, ParamSpec[]>; tunnelMetas?: Record<string, { favorite?: boolean }>; authProviderSchemas?: Record<string, ParamSpec[]>; tunnelTcpSupport?: string[]; sites?: { name: string }[] }) => {
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
        if (d.tunnelTcpSupport) setTcpTunnels(d.tunnelTcpSupport);
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

  const post = (action: string, extra: Record<string, unknown> = {}) =>
    fetch(apiUrl("/api/service-tunnels"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, provider, ...extra }),
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
  }, [provider]);

  useEffect(() => {
    fetch(apiUrl("/api/service-tunnels"))
      .then((r) => r.json())
      .then((d: { userManagers?: string[]; defaultProvider?: string; totpProviders?: string[] }) => {
        // User-management providers come from the library's userManagers()
        // (providers with a local user db — oauth2-proxy etc. excluded there,
        // not hardcoded here).
        const ps = d.userManagers ?? ["portal", "basic"];
        setProviders(ps.length ? ps : ["portal", "basic"]);
        const preferred = d.defaultProvider ?? ps[0] ?? "portal";
        setProvider((cur) => (cur === null ? (ps.includes(preferred) ? preferred : (ps[0] ?? "portal")) : cur));
        if (d.totpProviders) setTotpProviders(d.totpProviders);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { if (provider) loadUsers(); }, [provider]);

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
