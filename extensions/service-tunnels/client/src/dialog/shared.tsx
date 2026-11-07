/**
 * dialog/shared — ServicesDialog 拆壳（M2）共享展示组件。
 * （自 ServicesDialog.tsx 原位迁出，逻辑零改动；全部 export 供各 tab 消费。）
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIsMobile, apiUrl, extSvc } from "../host-shim";
import { dismissOnBack } from "../../../../_shared/overlay-back-client";
import type { ParamSpec } from "../types-shim";
import type { ExposeInfo } from "./types";
import { ddnsBadge, modeOf, fmtAddr } from "../lib-shared";

/** 无认证（auth-none / tcp）入口的红色 ⚠ 徽标 —— 与 Ports 页活动暴露列表一致。 */
export function NoAuthBadge({ t }: { t: (key: string) => string }) {
  return (
    <span title={t("services.noAuthWarnHint")}
      style={{ padding: "1px 7px", background: "color-mix(in srgb, var(--danger, #f87171) 15%, transparent)", border: "1px solid color-mix(in srgb, var(--danger, #f87171) 45%, transparent)", borderRadius: 4, color: "var(--danger, #f87171)", fontWeight: 600, flexShrink: 0, fontSize: 10 }}>
      ⚠ {t("services.exposeProviderNone")}
    </span>
  );
}


/** Generic schema-driven param form (labels, descriptions, links, defaults,
 *  password/number/select inputs). Rendered for every tunnel type / auth
 *  provider from service-tunnels' ParamSpec — adding a provider or tunnel
 *  type needs NO dialog changes. */
/** provider 显示名:pi-web i18n key(services.provider.*) → 库 authMetas label
 *  (如 "GitHub OAuth") → 原始 id(如 oauth2-github)。绝不显示 i18n key。 */
export function providerDisplayLabel(
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
export function BooleanToggle({ spec, value, onChange, t }: {
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

export function SchemaForm({ specs, values, onChange, t }: {
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
export function ExposeDetailModal({ ex, t, onClose, onOpen, onCopy, copiedKey, onStop, onOpenFile, userManagers = [] }: {
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
  const links = [ex.url, ex.localUrl, ex.baseUrl, ex.domainUrl, ex.loginUrl, ...(ex.altUrls ?? [])].filter((u): u is string => Boolean(u));
  // 双端单源（方案 E6/F-2）：modeOf 替换旧三态推断（portmap/ipv6 记录此前显示错档）
  const mode: string = modeOf(ex) || ((ex.name ?? "").startsWith("proxy:") ? "proxy" : ex.localUrl !== undefined ? "both" : "tunnel");
  // P3a 详情补齐（与库 UI showExposeDetail 同语义）
  const pm = mode === "portmap" ? (ex as ExposeInfo & { portmap?: { externalIp?: string; externalPort?: number; backend?: string; gateway?: string; leaseSeconds?: number } }).portmap : null;
  const ip6 = mode === "ipv6" ? (ex as ExposeInfo & { ipv6?: { address?: string; transportPort?: number } }).ipv6 : null;
  const startedAt = typeof ex.startedAt === "number" ? new Date(ex.startedAt) : null;
  const params = ex.params ?? null;

  // 小屏系统返回 = 关闭详情弹窗（与点遮罩/✕ 同款；仅 open 时挂载）
  useEffect(() => dismissOnBack(() => extSvc("pi-web.overlayBack"), onClose), []);

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
            <span style={{ color: "var(--danger, #f87171)", fontWeight: 600 }} title={t("services.noAuthWarnHint")}>⚠ {t("services.exposeProviderNone")}</span>
          ))}
          {/* proxy 模式无隧道（tunnelType 是创建时传的默认值，实际未建隧道） */}
          {(mode === "tunnel" || mode === "both") && field(t("services.exposeTunnelTool"), ex.tunnelType ?? "—")}
          {userManagers.includes(ex.provider ?? "") && field(t("services.exposeSite"), ex.site && ex.site !== "" ? ex.site : "default")}
          {field(t("services.exposeProtocol"), ex.protocol ?? "http")}
          {pm && pm.externalIp && field(t("ui.detail.portmap"), (
            <span style={{ fontFamily: "var(--font-mono)" }}>
              {fmtAddr(pm.externalIp)}:{pm.externalPort ?? "—"}
              {pm.backend ? ` (${pm.backend})` : ""}
            </span>
          ))}
          {pm && !!pm.leaseSeconds && field(t("ui.detail.leaseLeft"), `${pm.leaseSeconds}s`)}
          {ip6 && ip6.address && field(t("ui.detail.ipv6Entry"), (
            <span style={{ fontFamily: "var(--font-mono)" }}>[{ip6.address}]:{ip6.transportPort ?? "—"}</span>
          ))}
          {(() => {
            // DDNS 注册结果（共享层 ddnsBadge 单源；无绑定不渲染）
            const b = ddnsBadge((ex as ExposeInfo & { ddns?: { profile?: string; actions?: Array<{ type: string; ok: boolean }> } }).ddns);
            if (!b) return null;
            return field("DDNS", (
              <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {b.profile && <span style={{ fontFamily: "var(--font-mono)" }}>{b.profile}:</span>}
                {b.items.map((a, i) => (
                  <span key={i} style={{ color: a.ok ? "#16a34a" : "var(--danger, #f87171)" }}>{a.type}{a.ok ? " ✓" : " ✗"}</span>
                ))}
              </span>
            ));
          })()}
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
          <button onClick={onStop} style={{ flexShrink: 0, padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--danger, #f87171)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{t("services.exposeStop")}</button>
        </div>
      </div>
    </div>
  );
}

/** 详情页日志区:列出该暴露的全部日志文件(nginx access/error × 各 host),
 *  点击在 pi-web 文件窗口打开(/api/files 经 allowFileRoot 已放行日志目录)。 */
export function LogFilesSection({ exposeName, t, onOpenFile }: {
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
        <div style={{ fontSize: 10, color: "var(--danger, #f87171)" }}>{err}</div>
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
export function InfoModal({ kind, t, currentDomainSuffix, pagePort, basePath, onClose }: {
  kind: "access" | "auth";
  t: (key: string, params?: Record<string, string>) => string;
  currentDomainSuffix: string | null;
  pagePort: string;
  basePath: string;
  onClose: () => void;
}) {
  const isMobile = useIsMobile();
  // 小屏系统返回 = 关闭信息弹窗
  useEffect(() => dismissOnBack(() => extSvc("pi-web.overlayBack"), onClose), []);
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
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // 小屏系统返回 = 取消（与点遮罩/取消同款）
  useEffect(() => dismissOnBack(() => extSvc("pi-web.overlayBack"), onCancel), []);
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 440, maxWidth: "calc(100vw - 32px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, padding: "14px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.2)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--danger, #f87171)", marginBottom: 8 }}>⚠ {title}</div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.7 }}>{body}</div>
        <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={onCancel} style={{ padding: "5px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>{cancelLabel}</button>
          <button onClick={onConfirm} style={{ padding: "5px 14px", background: "#dc2626", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function UrlRow({ url, label, copied, onCopy, onOpen, isMobile }: { url: string; label: string; copied: boolean; onCopy: () => void; onOpen: () => void; isMobile: boolean }) {
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
export function BasePathSection({ port, entry, t, onSave }: {
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
