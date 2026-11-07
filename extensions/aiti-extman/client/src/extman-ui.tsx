/**
 * aiti-extman · 安全 UI 渲染层（JSX 版，自手写 h() 迁移，结构一比一）。
 *
 * 状态与操作在 extman-core.ts（模块级单例 + listener 强刷）；本文件只负责视图。
 * 宿主能力经 host-shim：useState/useEffect/useRef 委托宿主，t/apiUrl 同理。
 */
import { useState, useEffect, useRef } from "react";
import {
  state, setState, subscribe, currentSessionVal, setCurrentSession, setHostCaps,
  SELF_ID, AITI_REGISTRY_PAGE, SOURCE_LABELS, SOURCE_COLORS, btnStyle, chipStyle,
  shortenPath, statusDotColor, statusDotTitle, looksLikeSource, publisherTrusted,
  publisherSourceLabel, findButtonByLabel, openSlotItem, dropToBack,
  refreshTrusted, refreshStatus, sortedLocalIds, loadRegistry, runOp, runInstallZip,
  localMatches, onlineMatches, registryDocUrl, registryInstallSource, onlinePublisher, syncLoader,
  extDisplayName, subscribeAll, dependentsOf, execOp, depEdges, hardDependents, clientDependents,
  invokeHelper,
  EXTMAN_KEY,
} from "./extman-core";
import { t, apiUrl } from "./host-shim";
import { MdDesc, extDescVars } from "./md-desc";
// aiti-float dock v3（P1 批）：渲染门控 useGate + 停靠容器 DockBody（extman-core 的 setState
// 已把 patch.open 路由到 openFloat/closePanel，本文件所有 setState({open:…}) 调用点零改动）
import { useGate, DockBody, seedDockDefault } from "../../../_shared/ext-float-dock";
import { uiConfirm } from "../../../_shared/ui-dialogs";

// ---------- 扩展协议徽标 / AI 升级（docs/pi-web-ext-protocol.md） ----------

/** 协议状态 → chip 规格（ok 无 minorAhead 时返回 null；状态由服务端 withProtocol 富化到 status.extensions[id].protocol）。 */
function protocolChipSpec(proto: any): { icon: string; label: string; color: string; bg: string } | null {
  const state = proto?.state;
  if (!state) return null;
  if (state === "ok") {
    // 增项不 bump；minorAhead 仅扩展手工声明更高 minor 时出现（罕见）——仅作信息提示
    return proto.minorAhead
      ? { icon: "ℹ", label: t("ext.protocolMinorAhead"), color: "#0ea5e9", bg: "rgba(14,165,233,0.12)" }
      : null;
  }
  const warn = { color: "#d97706", bg: "rgba(217,119,6,0.12)" };
  switch (state) {
    case "incompatible": return { icon: "⛔", label: t("ext.protocolIncompatible"), color: "var(--danger, #ef4444)", bg: "rgba(239,68,68,0.12)" };
    case "too_new": return { icon: "↑", label: t("ext.protocolTooNew"), ...warn };
    case "missing": return { icon: "⚠", label: t("ext.protocolMissing"), ...warn };
    case "invalid": return { icon: "⚠", label: t("ext.protocolInvalid"), ...warn };
    case "stale": return { icon: "⚠", label: t("ext.protocolStale"), ...warn };
    default: return { icon: "⚠", label: String(state), ...warn };
  }
}

/** 🤖 协议升级：唤起 aiti-helper 预选 ext-protocol-upgrade skill，带扩展 id 与迁移手册路由。 */
function askAiProtocolUpgrade(id: string, proto: any) {
  const refs = (proto?.upgradeRefs || []).join(" → ");
  const from = proto?.declared ?? "(未声明/legacy)";
  const msg = `【扩展协议升级】把 pi-web 扩展 ${id} 从协议 ${from} 升级到当前 ${proto?.current}。\n` +
    `请走 ext-protocol-upgrade skill：先读 docs/pi-web-ext-protocol.md；本扩展按顺序读迁移手册 ${refs || "（无跳数）"}，` +
    `改 pi-web-ext/${id}/ 源码并更新 package.json 的 aitiExtProtocol，构建/测试/deploy 后回报。` +
    (proto?.detail ? `\n现状：${proto.detail}` : "");
  invokeHelper({ helperId: "ext-protocol-upgrade", extId: SELF_ID, extName: "aiti-extman", message: msg, contextLabel: "扩展协议升级：" + id });
}

/**
 * 虚空创建：离屏挂载目标插槽的注册组件（同一宿主 React 实例，事件正常接线），
 * 挂载后自动点击其内部按钮。传入 virtual:true——组件应据此绕过自身显隐门控
 * （如 feature 关闭）渲染出真实可点控件；条目不在 DOM 时也能触发原点击行为。
 */
function VirtualClick({ vc }: { vc: { render: (props?: any) => any; key: number } }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const btn = ref.current?.querySelector<HTMLElement>("button, [role='button']");
    if (btn) btn.click();
    const timer = setTimeout(() => setState({ virtualClick: null }), 80);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div ref={ref} aria-hidden style={{ position: "fixed", left: -99999, top: -99999, width: 1, height: 1, overflow: "hidden", pointerEvents: "none" }}>
      {vc.render({ menu: false, virtual: true })}
    </div>
  );
}

/** 扩展图标渲染：icon 是相对扩展目录的图标文件（如 icon.svg）→ 资产 URL + CSS mask（颜色跟随 currentColor）；否则按 emoji/文本显示 */
function extIconSpan(ext: any, size: number, id?: string) {
  const extId = id || (ext && ext.id);
  if (ext && typeof ext.icon === "string" && ext.icon.endsWith(".svg") && extId) {
    const url = apiUrl("/api/extensions/" + extId + "/assets/" + ext.icon);
    return (
      <span aria-hidden style={{
        display: "inline-block", width: size, height: size, flexShrink: 0, verticalAlign: "middle",
        background: "currentColor", maskImage: "url(" + url + ")", WebkitMaskImage: "url(" + url + ")",
        maskRepeat: "no-repeat", maskPosition: "center", maskSize: "contain",
      }} />
    );
  }
  return (ext && ext.icon) || "📦";
}

// ---------- 小组件 ----------
function SourceTag({ source }: { source?: string }) {
  if (!source) return null;
  return (
    <span style={{ ...chipStyle(SOURCE_COLORS[source] || "var(--text-dim)", "rgba(120,120,120,0.12)"), fontFamily: "var(--font-mono)" }}>
      {SOURCE_LABELS[source] || source}
    </span>
  );
}

/** Chevron 线稿图标（导航按钮用；lucide 图形、stroke=2、currentColor——与 dock 图标规范一致）。 */
function ChevronIcon({ dir, size = 14 }: { dir: "left" | "right"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
      {dir === "left" ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
    </svg>
  );
}

/** 详情工具条 ‹ › 前一/后一导航：按左列表当前顺序（启停优先 + 字典序；有搜索时按过滤结果）在扩展详情间循环切换。根 marginLeft:auto → 在详情工具条内右对齐。 */
function ExtNav({ ids, index }: { ids: string[]; index: number }) {
  if (index < 0 || ids.length < 2) return null;
  const go = (dir: 1 | -1) => {
    const next = ids[(index + dir + ids.length) % ids.length];
    setState({ selected: { kind: "local", id: next }, error: null, message: null, mobileView: state.isMobile ? "detail" : state.mobileView });
  };
  const targetName = (dir: 1 | -1) => {
    const id = ids[(index + dir + ids.length) % ids.length];
    const entry = state.status && state.status.extensions[id];
    return entry ? extDisplayName(id, entry.name) : id;
  };
  const navBtn = { ...btnStyle, padding: "5px 9px", fontSize: 13, lineHeight: 1, display: "inline-flex", alignItems: "center" } as React.CSSProperties;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0, marginLeft: "auto" }}>
      <button type="button" onClick={() => go(-1)} title={t("ext.prevExt") + ": " + targetName(-1)} aria-label={t("ext.prevExt")} style={navBtn}><ChevronIcon dir="left" /></button>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", minWidth: 34, textAlign: "center", userSelect: "none" } as React.CSSProperties}>{index + 1}/{ids.length}</span>
      <button type="button" onClick={() => go(1)} title={t("ext.nextExt") + ": " + targetName(1)} aria-label={t("ext.nextExt")} style={navBtn}><ChevronIcon dir="right" /></button>
    </div>
  );
}

/** 开关旋钮：loading 时变旋转环（处理中反馈），否则是普通滑块。size=旋钮直径。 */
function ToggleKnob({ enabled, loading, size }: { enabled: boolean; loading: boolean; size: number }) {
  const left = enabled ? size + 5 : 3;
  if (loading) {
    return (
      <span className="extman-spin" style={{
        position: "absolute", top: 3, left, width: size, height: size,
        borderRadius: "50%", border: "2px solid var(--bg)", borderTopColor: "rgba(255,255,255,0.45)",
        boxSizing: "border-box",
      }} />
    );
  }
  return (
    <span style={{
      position: "absolute", top: 3, left, width: size, height: size,
      borderRadius: "50%", background: "var(--bg)", boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
      transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
    }} />
  );
}

function Toggle({ enabled, loading, onToggle, label }: { enabled: boolean; loading: boolean; onToggle: (e: any) => void; label: string }) {
  return (
    <button type="button" onClick={onToggle} disabled={loading} title={label} aria-label={label}
      style={{
        flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: "none", padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative", transition: "background 0.18s", outline: "none",
        opacity: loading ? 0.65 : 1,
      } as React.CSSProperties}>
      <ToggleKnob enabled={enabled} loading={loading} size={16} />
    </button>
  );
}

/** 列表行内的小号启停开关（悬停卡片时出现；设计同 Toggle，尺寸更紧凑）。 */
function MiniToggle({ enabled, loading, onToggle, label }: { enabled: boolean; loading: boolean; onToggle: (e: any) => void; label: string }) {
  return (
    <button type="button" onClick={onToggle} disabled={loading} title={label} aria-label={label}
      style={{
        flexShrink: 0, width: 36, height: 20, borderRadius: 10, border: "none", padding: 0,
        cursor: loading ? "wait" : "pointer",
        background: enabled ? "var(--accent)" : "var(--border)",
        position: "relative", transition: "background 0.18s", outline: "none",
        opacity: loading ? 0.65 : 1,
      } as React.CSSProperties}>
      <ToggleKnob enabled={enabled} loading={loading} size={14} />
    </button>
  );
}

/** 发行者信息单元（名称 + 可点击网站 + 信任状态 + 信任/撤销操作）。 */
function PublisherCell({ publisher }: { publisher: any }) {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  if (!publisher) return null;
  const name = (publisher.name && publisher.name.trim()) || t("ext.publisherUnknown");
  const url = publisher.url || null;
  const trusted = publisherTrusted(publisher);
  const busy = state.busyKey === "trust:" + name || state.busyKey === "untrust:" + name;
  const keyName = (publisher.name && publisher.name.trim()) || publisher.fingerprint || "";
  const linkStyle = { color: "var(--accent)", textDecoration: "none", fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" title={url} style={linkStyle}>
            {name}{" "}
            <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ verticalAlign: "middle" }}>
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1={10} y1={14} x2={21} y2={3} />
            </svg>
          </a>
        ) : (
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{name}</span>
        )}
        <span style={chipStyle("var(--text-muted)", "var(--bg-hover)")}>{publisherSourceLabel(publisher.source)}</span>
        {trusted
          ? <span style={chipStyle("rgba(16,185,129,0.9)", "rgba(16,185,129,0.12)")}>✓ {t("ext.trusted")}</span>
          : <span style={chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)")}>⚠ {t("ext.notTrusted")}</span>}
      </div>
      {!publisher.name && publisher.fingerprint && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
          {t("ext.fingerprint")}: {publisher.fingerprint}
        </div>
      )}
      {trusted ? (
        <button type="button" disabled={busy}
          onClick={() => void runOp("untrust", { name: keyName })}
          style={{ ...btnStyle, alignSelf: "flex-start", padding: "3px 10px", fontSize: 11 } as React.CSSProperties}>
          {busy ? "…" : t("ext.untrustPublisher")}
        </button>
      ) : keyName ? (
        <button type="button" disabled={busy}
          onClick={() => void runOp("trust", { name: (publisher.name && publisher.name.trim()) || "", fingerprint: keyName, url, source: publisher.source })}
          style={{ ...btnStyle, alignSelf: "flex-start", padding: "3px 10px", fontSize: 11 } as React.CSSProperties}>
          {busy ? "…" : t("ext.trustPublisher")}
        </button>
      ) : null}
    </div>
  );
}

/** VSCode 式信任弹窗：发行者未信任时安装前弹出（显示发行者 + 可点击网站）。 */
function TrustDialog() {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  const pt = state.pendingTrust;
  if (!pt) return null;
  const pub = pt.publisher || {};
  const name = (pub.name && pub.name.trim()) || t("ext.publisherUnknown");
  const url = pub.url || null;
  const busy = state.busyKey !== null;
  const confirm = () => {
    const p = state.pendingTrust;
    setState({ pendingTrust: null });
    if (p.kind === "zip") void runInstallZip(p.file, true);
    else void runOp("install", { source: p.source, docsUrl: p.docsUrl, trust: true, publisher: p.publisher, publisherHint: p.publisherHint });
  };
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2147483645,
      background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) setState({ pendingTrust: null }); }}>
      <div style={{
        width: 420, maxWidth: "100%",
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: "18px 20px",
        display: "flex", flexDirection: "column", gap: 14,
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, display: "inline-flex" }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 8h1a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4h1" />
              <path d="M7 8V6a5 5 0 0 1 10 0v2" />
              <path d="M12 13v4" />
            </svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("ext.trustDialogTitle")}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.publisher")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {url
              ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none", fontSize: 13, fontWeight: 600 }}>{name} ↗</a>
              : <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{name}</span>}
            <span style={chipStyle("var(--text-muted)", "var(--bg-hover)")}>{publisherSourceLabel(pub.source)}</span>
          </div>
          {!pub.name && pub.fingerprint && (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>{t("ext.fingerprint")}: {pub.fingerprint}</div>
          )}
          {pt.zipName && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>zip: {pt.zipName}</div>}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{t("ext.trustDialogBody")}</div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button type="button" onClick={() => setState({ pendingTrust: null })} disabled={busy} style={btnStyle as React.CSSProperties}>
            {t("ext.cancel")}
          </button>
          <button type="button" onClick={confirm} disabled={busy}
            style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", fontWeight: 600 } as React.CSSProperties}>
            {busy ? "…" : t("ext.trustAndInstall")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 依赖影响确认弹窗（TrustDialog 同风格）：禁用/卸载仍被已启用扩展声明依赖（clientDependsOn）
 * 时由 runOp 拦截触发（state.pendingDependents）；确认后直调 execOp 绕过拦截。
 */
function DependentsDialog() {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  const pd = state.pendingDependents;
  if (!pd) return null;
  const busy = state.busyKey !== null;
  const isRemove = pd.action === "remove";
  const confirm = () => {
    const p = state.pendingDependents;
    setState({ pendingDependents: null });
    if (p) void execOp(p.action, { id: p.id });
  };
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 2147483645,
      background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}
      onClick={(e) => { if (e.target === e.currentTarget) setState({ pendingDependents: null }); }}>
      <div style={{
        width: 420, maxWidth: "100%",
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: "18px 20px",
        display: "flex", flexDirection: "column", gap: 14,
      }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16, color: "rgba(217,119,6,0.9)", display: "inline-flex" }}>
            <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("ext.dependentsTitle")}</span>
        </div>
        {(pd.clientDeps as string[]).length > 0 && (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              {t(isRemove ? "ext.dependentsBodyRemove" : "ext.dependentsBodyDisable", { id: pd.id })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(pd.clientDeps as string[]).map((d) => (
                <div key={d} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>{d}</div>
              ))}
            </div>
          </>
        )}
        {(pd.hardDeps as Array<{ id: string; via?: string }>).length > 0 && (
          <>
            <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
              {t(isRemove ? "ext.dependentsHardRemove" : "ext.dependentsHardDisable", { id: pd.id })}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {(pd.hardDeps as Array<{ id: string; via?: string }>).map((d) => (
                <div key={d.id} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text)" }}>
                  {d.id}{d.via ? <span style={{ color: "var(--text-dim)" }}> · {d.via}</span> : null}
                </div>
              ))}
            </div>
          </>
        )}
        {/* 硬依赖（dependsOn hard 边）→ 硬阻止（sidebar 统一 dock 方案评审 5：确认弹窗升级硬阻止）；
            仅 client 预取边（软）→ 维持原「仍要禁用」确认。 */}
        {(pd.hardDeps as Array<{ id: string; via?: string }>).length > 0 ? (
          <div style={{
            fontSize: 12, color: "var(--text)", background: "rgba(217,119,6,0.12)",
            border: "1px solid rgba(217,119,6,0.4)", borderRadius: 8, padding: "8px 12px", lineHeight: 1.6,
          }}>
            {t("ext.dependentsHardBlocked")}
          </div>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button type="button" onClick={() => setState({ pendingDependents: null })} disabled={busy} style={btnStyle as React.CSSProperties}>
            {t("ext.cancel")}
          </button>
          {(pd.hardDeps as Array<{ id: string; via?: string }>).length === 0 && (
            <button type="button" onClick={confirm} disabled={busy}
              style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", fontWeight: 600 } as React.CSSProperties}>
              {busy ? "…" : t(isRemove ? "ext.dependentsConfirmRemove" : "ext.dependentsConfirmDisable")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 能力视图 / 冲突视图（依赖与能力模型 P1/P2） ----------

/** 能力列表（左栏）：能力名分组；missing（无提供者）标红；pin 标注。 */
function CapList({ q }: { q: string }) {
  const caps = (state.status && state.status.capabilities) || {};
  const needle = q.trim().toLowerCase();
  const names = Object.keys(caps).filter((n) => !needle || n.toLowerCase().includes(needle)).sort();
  if (names.length === 0) {
    return <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("ext.cap.none")}</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {names.map((name) => {
        const c = caps[name];
        const missing = !c.providers || c.providers.length === 0;
        const isSel = state.selCap === name;
        return (
          <div key={name} onClick={() => setState({ selCap: name })}
            style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 8px", borderRadius: 5, cursor: "pointer", background: isSel ? "var(--bg-selected)" : "none" }}
            onMouseEnter={(ev) => { if (!isSel) ev.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(ev) => { if (!isSel) ev.currentTarget.style.background = "none"; }}>
            <span title={missing ? t("ext.depMissing") : t("ext.cap.effective") + ": " + (c.effective || "—")}
              style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: missing ? "var(--danger, #ef4444)" : "var(--accent)" }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div title={name} style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: isSel ? 600 : 500, color: missing ? "var(--text-dim)" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                {missing
                  ? "✗ " + t("ext.depMissing")
                  : (c.effective || "") + (c.consumers && c.consumers.length > 0 ? " · " + c.consumers.length + " consumer" + (c.consumers.length > 1 ? "s" : "") : "")}
              </div>
            </div>
            {c.pinnedTo && <span style={chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)")}>pin</span>}
          </div>
        );
      })}
    </div>
  );
}

/** 能力详情（右栏）：提供者列表（生效高亮 + pin 下拉）+ 消费方。takeover 冲突详情复用。 */
function CapDetail({ name }: { name: string }) {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  const c = state.status && state.status.capabilities && state.status.capabilities[name];
  if (!c) return <div style={{ color: "var(--text-dim)", fontSize: 13 }}>…</div>;
  const missing = !c.providers || c.providers.length === 0;
  const busy = state.busyKey !== null;
  const jumpTo = (extId: string) => setState({ view: "exts", selected: { kind: "local", id: extId }, selCap: null, selConflict: null, mobileView: state.isMobile ? "detail" : state.mobileView });
  const sorted = [...(c.providers || [])].sort((a: any, b: any) => (b.id === c.effective ? 1 : 0) - (a.id === c.effective ? 1 : 0) || a.id.localeCompare(b.id));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{name}</span>
        {missing
          ? <span style={chipStyle("var(--danger, #ef4444)", "rgba(239,68,68,0.12)")}>✗ {t("ext.depMissing")}</span>
          : <span style={chipStyle("rgba(16,185,129,0.9)", "rgba(16,185,129,0.12)")}>✓ {t("ext.cap.effective")}: {c.effective}</span>}
        {c.pinnedTo && <span style={chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)")}>{t("ext.depViaPin")}: {c.pinnedTo}</span>}
      </div>
      {!missing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("ext.cap.providers")} ({c.providers.length})</div>
            <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)", marginLeft: "auto", flexWrap: "wrap" }}>
              {t("ext.cap.pick")}
              <select value={c.pinnedTo || ""} disabled={busy}
                onChange={(e) => void runOp("set-pin", { scope: "capability", key: name, value: e.target.value || null })}
                style={{ fontSize: 11, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", outline: "none" }}>
                <option value="">{t("ext.pin.auto")}</option>
                {(c.providers || []).map((p: any) => (
                  <option key={p.id} value={p.id}>{extDisplayName(p.id, p.id)}{p.version ? " v" + p.version : ""}{p.takeover ? " · takeover" : ""}</option>
                ))}
              </select>
            </label>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {sorted.map((p: any) => (
              <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--border)", background: p.id === c.effective ? "var(--bg-selected)" : "var(--bg-panel)", flexWrap: "wrap" }}>
                <span role="button" tabIndex={0} onClick={() => jumpTo(p.id)}
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: p.id === c.effective ? 600 : 400, color: "var(--text)", cursor: "pointer", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{extDisplayName(p.id, p.id)}</span>
                {p.version && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>v{p.version}</span>}
                <SourceTag source={p.source} />
                {p.takeover && <span style={chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)")}>takeover</span>}
                {p.id === c.effective && <span style={{ marginLeft: "auto", flexShrink: 0, ...chipStyle("rgba(16,185,129,0.9)", "rgba(16,185,129,0.12)") } as React.CSSProperties}>✓ {t("ext.cap.effective")}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {c.consumers && c.consumers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("ext.cap.consumers")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {c.consumers.map((cons: any) => (
              <div key={cons.extId} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span role="button" tabIndex={0} onClick={() => jumpTo(cons.extId)}
                  style={{ ...chipStyle("var(--text-muted)", "var(--bg-hover)"), fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer", whiteSpace: "normal" }}>{cons.extId}</span>
                <span style={cons.hard ? chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)") : chipStyle("var(--text-dim)", "var(--bg-hover)")}>{cons.hard ? "hard" : "·optional"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {missing && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
          {t("ext.depMissing")}: {t("ext.cap.providers")} = 0
        </div>
      )}
    </div>
  );
}

/** 冲突/版本管理列表（左栏）：同 id 多来源组 + takeover 冲突组。 */
function ConflictList({ q }: { q: string }) {
  const st = state.status;
  const multi = (st && st.multiSource) || {};
  const caps = (st && st.capabilities) || {};
  // takeover 冲突：同能力 ≥2 个 takeover 声明者（独占语义冲突）；或单 takeover 者被多实现/pin 环绕（取代提示）
  const takeovers = Object.keys(caps).filter((n) => {
    const ps = caps[n].providers || [];
    const takers = ps.filter((p: any) => p.takeover);
    return takers.length > 1 || (takers.length === 1 && ps.length > 1);
  }).sort();
  const needle = q.trim().toLowerCase();
  const multiIds = Object.keys(multi).filter((id) => !needle || id.toLowerCase().includes(needle)).sort();
  const tks = takeovers.filter((n) => !needle || n.toLowerCase().includes(needle));
  if (multiIds.length === 0 && tks.length === 0) {
    return <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("ext.conflict.none")}</div>;
  }
  const rowStyle = (key: string) => ({
    display: "flex", alignItems: "center", gap: 7, padding: "8px 8px", borderRadius: 5, cursor: "pointer",
    background: state.selConflict === key ? "var(--bg-selected)" : "none",
  } as React.CSSProperties);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {multiIds.length > 0 && (
        <div style={{ padding: "4px 8px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase" }}>{t("ext.conflict.multiSource")}</div>
      )}
      {multiIds.map((id) => {
        const g = multi[id];
        const winner = (g.candidates || []).find((c: any) => c.winner);
        return (
          <div key={"m:" + id} onClick={() => setState({ selConflict: "multi:" + id })} style={rowStyle("multi:" + id)}
            onMouseEnter={(ev) => { if (state.selConflict !== "multi:" + id) ev.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(ev) => { if (state.selConflict !== "multi:" + id) ev.currentTarget.style.background = "none"; }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: state.selConflict === "multi:" + id ? 600 : 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{id}</div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 1 }}>
                {(g.candidates || []).length} sources{winner ? " · " + (SOURCE_LABELS[winner.source] || winner.source) + (winner.version ? " v" + winner.version : "") : ""}
              </div>
            </div>
          </div>
        );
      })}
      {tks.length > 0 && (
        <div style={{ padding: "8px 8px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", borderTop: multiIds.length > 0 ? "1px solid var(--border)" : "none", marginTop: multiIds.length > 0 ? 6 : 0 }}>{t("ext.conflict.takeover")}</div>
      )}
      {tks.map((n) => {
        const c = caps[n];
        const conflict = (c.providers || []).filter((p: any) => p.takeover).length > 1;
        return (
          <div key={"t:" + n} onClick={() => setState({ selConflict: "takeover:" + n })} style={rowStyle("takeover:" + n)}
            onMouseEnter={(ev) => { if (state.selConflict !== "takeover:" + n) ev.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(ev) => { if (state.selConflict !== "takeover:" + n) ev.currentTarget.style.background = "none"; }}>
            <span title={conflict ? "conflict" : "superseded"} style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: conflict ? "#d97706" : "var(--text-dim)" }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n}</div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 1 }}>{t("ext.cap.effective")}: {c.effective || "—"}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 冲突详情（右栏）：顶部 dev 优先开关；multi 组 = 候选列表 + 来源 pin；takeover 组复用能力详情。 */
function ConflictDetail() {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  const st = state.status;
  const sel = state.selConflict;
  if (!st || !sel) return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>{t("ext.select")}</div>;
  if (sel.startsWith("takeover:")) return <CapDetail name={sel.slice(9)} />;
  const id = sel.slice(6);
  const group = st.multiSource && st.multiSource[id];
  if (!group) return <div style={{ color: "var(--text-dim)", fontSize: 13 }}>…</div>;
  const busy = state.busyKey !== null;
  const devOn = !!(st.pins && st.pins.devPriority === true);
  const pinned = st.pins && st.pins.pins ? st.pins.pins["source:" + id] : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-mono)" }}>{id}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.conflict.multiSource")} · {(group.candidates || []).length}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)" }}>
        <Toggle enabled={devOn} loading={busy} onToggle={() => void runOp("set-dev-priority", { value: !devOn })} label={t("ext.devPriorityHint")} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{t("ext.devPriority")}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.devPriorityHint")}</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("ext.conflict.pick")}</div>
          <select value={pinned || ""} disabled={busy}
            onChange={(e) => void runOp("set-pin", { scope: "source", key: id, value: e.target.value || null })}
            style={{ fontSize: 11, padding: "3px 6px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", outline: "none", maxWidth: "100%" }}>
            <option value="">{t("ext.pin.auto")}（pin &gt; dev &gt; version &gt; root）</option>
            {(group.candidates || []).map((c: any) => (
              <option key={c.dir} value={c.dir}>{SOURCE_LABELS[c.source] || c.source}{c.version ? " v" + c.version : ""} · {shortenPath(c.dir)}</option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {[...(group.candidates || [])].sort((a: any, b: any) => (b.winner ? 1 : 0) - (a.winner ? 1 : 0)).map((c: any) => (
            <div key={c.dir} style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--border)", background: c.winner ? "var(--bg-selected)" : "var(--bg-panel)", flexWrap: "wrap" }}>
              <SourceTag source={c.source} />
              {c.version && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>v{c.version}</span>}
              <span title={c.dir} style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{shortenPath(c.dir)}</span>
              {c.winner
                ? <span style={chipStyle("rgba(16,185,129,0.9)", "rgba(16,185,129,0.12)")}>✓ {t("ext.conflict.winner")}</span>
                : <span style={chipStyle("var(--text-dim)", "var(--bg-hover)")}>{t("ext.conflict.shadowed")}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function summaryOf(status: any) {
  return t("ext.summary", {
    total: Object.keys(status.extensions || {}).length,
    on: Object.values<any>(status.extensions || {}).filter((e) => e.enabled !== false).length,
    off: Object.values<any>(status.extensions || {}).filter((e) => e.enabled === false).length,
  });
}

const IconClose = () => (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
  </svg>
);
const IconPlus = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <line x1={12} y1={5} x2={12} y2={19} /><line x1={5} y1={12} x2={19} y2={12} />
  </svg>
);

// ---------- 主面板（dialogs 插槽） ----------
export function ExtManPanel(props: any) {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  // dock v3：显隐门控走状态机（setState({open:…}) 已在 extman-core 路由 openFloat/closePanel）
  const open = useGate(EXTMAN_KEY, "float");
  // Esc 关闭：弹窗可能被 AI 调试窗（z-index 21亿）盖住关闭按钮——键盘兜底出口，防死锁
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setState({ open: false }); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  // 面板关闭时清掉待确认的依赖弹窗状态：重开面板不再残留旧弹窗
  useEffect(() => {
    if (!open && state.pendingDependents) setState({ pendingDependents: null });
  }, [open]);

  // spinner keyframes 注入（一次；开关旋钮与「处理中」横幅的旋转动画共用）
  useEffect(() => {
    if (document.getElementById("extman-spin-style")) return;
    const el = document.createElement("style");
    el.id = "extman-spin-style";
    el.textContent = "@keyframes extman-rotate{to{transform:rotate(360deg)}}.extman-spin{animation:extman-rotate .8s linear infinite}";
    document.head.appendChild(el);
  }, []);

  // 捕获宿主传入的当前会话（dialogs 插槽 ExtRenderProps.currentSession）——context 插槽打开时的上下文
  setCurrentSession(props ? props.currentSession : null);

  if (!open) return null;

  return (
    <div style={{
      position: "fixed", inset: 0,
      // z 默认抬到 AI 调试窗（2147483642）之上：本弹窗是 aiti 家族 UI，必须随时可关——
      // 打开其他扩展弹窗后自动降到后面（zBack=true → 300，新弹窗置前）；头部「置于顶层」可恢复
      zIndex: state.zBack ? 300 : 2147483644,
      background: "rgba(0,0,0,0.35)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}
      onClick={(e) => { if (e.target === e.currentTarget) setState({ open: false }); }}>
      <div
        data-ext-float="1" data-ext-float-w={900} data-ext-float-h={660} data-ext-float-full="1"
        data-ext-float-key={EXTMAN_KEY}
        data-ext-float-dock="right-panel"
        data-ext-float-dock-default="right-panel"
        /* 小屏全屏与最大化按钮都由 aiti-float 托管（自动注入 ⛶/❐，盒子 !important 接管） */
        style={{
          width: 900,
          maxWidth: "calc(100vw - 16px)",
          height: "78vh",
          maxHeight: "calc(100dvh - 16px)",
          borderRadius: 8,
          display: "flex", flexDirection: "column", background: "var(--bg)",
          border: "1px solid var(--border)",
          boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}>

        <ExtManContent />
      </div>
    </div>
  );
}

/** 面板内容（头行 + 列表/详情体）：浮窗/停靠两面共用（dock v3 P1） */
function ExtManContent(): any {
  // 派生量（原在 ExtManPanel——拆分后随内容走，两面共用同一份计算）
  const status = state.status;
  const isMobile = state.isMobile;
  const q = state.q;
  const hasQuery = q.trim().length > 0;
  const localIds = sortedLocalIds(status).filter((id) => !hasQuery || localMatches(id, status.extensions[id], q.trim()));

  // 在线命中（排除已安装——已安装的在本地区显示标记；同 id 时保留本地视图）。
  const regExts = (state.registryData && state.registryData.extensions) || [];
  const onlineHits = hasQuery
    ? regExts.filter((ext: any) => onlineMatches(ext, q.trim()) && !(status && status.extensions[ext.id]))
    : [];
  // 本地已安装且注册表里有新版本 → 更新标记。
  const registryById: Record<string, any> = {};
  for (const ext of regExts) registryById[ext.id] = ext;

  const busyAny = state.busyKey !== null;
  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;

  // 选中有效性：在线条目可能因安装成功变成本地——保持原样即可（local 优先校正）。
  const sel = state.selected;
  const selLocal = sel && sel.kind === "local" && status && status.extensions[sel.id];
  const selOnline = sel && sel.kind === "online" && registryById[sel.id];

  // 详情顶部 ‹ › 导航：本地扩展详情时显示；顺序 = 左列表当前顺序（localIds，有搜索时为过滤结果）
  const navIds = localIds;
  const navIndex = sel && sel.kind === "local" && selLocal ? navIds.indexOf(sel.id) : -1;

  function rowSelected(kind: string, id: string) {
    return sel && sel.kind === kind && sel.id === id;
  }

  return (
    <>
  {/* header（小屏拆两行；宽屏单行） */}
  {isMobile ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px 10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flex: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {extIconSpan({ id: SELF_ID, icon: "icon.svg" }, 14)}{t("ext.title")}
                </span>
                {status && <span style={{ fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summaryOf(status)}</span>}
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                {state.zBack && (
                  <button type="button" onClick={() => setState({ zBack: false })} title={t("ext.raiseToTop")}
                    style={{ ...btnStyle, padding: "5px 9px", fontSize: 12, lineHeight: 1 } as React.CSSProperties}>⤒</button>
                )}
                <button type="button" onClick={() => setState({ open: false })} title={t("ext.close")} aria-label={t("ext.close")}
                  style={{ ...btnStyle, padding: "5px 9px", fontSize: 13, lineHeight: 1 } as React.CSSProperties}><IconClose /></button>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" disabled={busyAny}
                onClick={() => { setState({ selected: { kind: "add", id: "" }, q: "", error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView }); void loadRegistry(); void refreshTrusted(); }}
                title={t("ext.add")}
                style={{ ...btnStyle, flex: 1, background: "var(--accent)", color: "white", borderColor: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 } as React.CSSProperties}>
                <IconPlus />{t("ext.add")}
              </button>
              <button type="button" disabled={busyAny} onClick={() => void runOp("reload", {})} style={{ ...btnStyle, flex: 1 } as React.CSSProperties}>
                {state.busyKey === "reload:" ? "…" : t("ext.reload")}
              </button>
              <button type="button" disabled={busyAny} onClick={() => void refreshStatus()} style={{ ...btnStyle, flex: 1 } as React.CSSProperties}>{t("ext.refresh")}</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                {extIconSpan({ id: SELF_ID, icon: "icon.svg" }, 15)}{t("ext.title")}
              </span>
              {status && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{summaryOf(status)}</span>}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {state.zBack && (
                <button type="button" onClick={() => setState({ zBack: false })} title={t("ext.raiseToTop")} style={btnStyle as React.CSSProperties}>{t("ext.raiseToTop")}</button>
              )}
              <button type="button" disabled={busyAny}
                onClick={() => { setState({ selected: { kind: "add", id: "" }, q: "", error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView }); void loadRegistry(); void refreshTrusted(); }}
                title={t("ext.add")}
                style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", display: "flex", alignItems: "center", gap: 5 } as React.CSSProperties}>
                <IconPlus />{t("ext.add")}
              </button>
              <button type="button" disabled={busyAny} onClick={() => void runOp("reload", {})} style={btnStyle as React.CSSProperties}>
                {state.busyKey === "reload:" ? "…" : t("ext.reload")}
              </button>
              <button type="button" disabled={busyAny} onClick={() => void refreshStatus()} style={btnStyle as React.CSSProperties}>{t("ext.refresh")}</button>
              <button type="button" onClick={() => setState({ open: false })} title={t("ext.close")} aria-label={t("ext.close")} style={btnStyle as React.CSSProperties}><IconClose /></button>
            </div>
          </div>
        )}

        {state.error && <div style={{ padding: "8px 18px", fontSize: 12, color: "var(--danger, #ef4444)", background: "rgba(239,68,68,0.06)", borderBottom: "1px solid var(--border)" }}>{state.error}</div>}
        {/* 处理中反馈：启停/安装/重载都是服务端全量重载扩展（秒级），banner + spinner 让用户知道点击已生效 */}
        {state.applying && (
          <div style={{ padding: "8px 18px", fontSize: 12, color: "var(--accent)", background: "rgba(99,102,241,0.07)", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="extman-spin" style={{ width: 12, height: 12, borderRadius: "50%", border: "2px solid var(--accent)", borderTopColor: "transparent", display: "inline-block", boxSizing: "border-box", flexShrink: 0 }} />
            {state.applying}
          </div>
        )}
        {state.message && <div style={{ padding: "8px 18px", fontSize: 12, color: "#16a34a", background: "rgba(22,163,74,0.06)", borderBottom: "1px solid var(--border)" }}>{state.message}</div>}
        {state.openHint && <div style={{ padding: "8px 18px", fontSize: 12, color: "#d97706", background: "rgba(217,119,6,0.08)", borderBottom: "1px solid var(--border)" }}>{state.openHint.text}</div>}

        {/* 虚空创建：离屏挂载目标插槽组件并自动触发其 click（条目已注册但不在 DOM，如被 feature 隐藏） */}
        {state.virtualClick && <VirtualClick key={state.virtualClick.key} vc={state.virtualClick} />}

        {/* body */}
        <div style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>
          {/* ── 左：搜索 + 结果列表 ── */}
          <div style={{
            display: isMobile && state.mobileView === "detail" ? "none" : "flex",
            width: isMobile ? "100%" : 290,
            flex: isMobile ? (state.listCollapsed ? 0 : 1) : undefined,
            minHeight: isMobile ? 0 : undefined,
            borderRight: isMobile ? "none" : "1px solid var(--border)",
            borderBottom: "none",
            flexDirection: "column", flexShrink: 0, background: "var(--bg-panel)",
          }}>
            {/* 小屏：列表折叠条 */}
            {isMobile && (
              <button type="button" onClick={() => setState({ listCollapsed: !state.listCollapsed })}
                title={state.listCollapsed ? t("ext.expandList") : t("ext.collapseList")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
                  padding: "8px 12px", border: "none", background: "var(--bg-panel)",
                  cursor: "pointer", flexShrink: 0, color: "var(--text-muted)",
                }}>
                <span style={{ fontSize: 11, fontWeight: 600 }}>
                  {extIconSpan({ id: SELF_ID, icon: "icon.svg" }, 13)}{t("ext.list")} ({status ? Object.keys(status.extensions).length : 0})
                </span>
                <span style={{ fontSize: 11 }}>{state.listCollapsed ? "▾ " + t("ext.expand") : "▴ " + t("ext.collapse")}</span>
              </button>
            )}
            {/* 搜索框 + 结果（小屏折叠时整块隐藏） */}
            {(!isMobile || !state.listCollapsed) && [
              <div key="viewtabs" style={{ display: "flex", gap: 4, padding: "8px 8px 0", flexShrink: 0 }}>
                {([["exts", t("ext.view.exts")], ["caps", t("ext.view.caps")], ["conflicts", t("ext.view.conflicts")]] as const).map(([v, label]) => (
                  <button key={v} type="button" onClick={() => setState({ view: v as any, selCap: null, selConflict: null })}
                    style={{
                      flex: 1, padding: "4px 6px", fontSize: 11, fontWeight: state.view === v ? 600 : 400,
                      borderRadius: 6, cursor: "pointer", outline: "none",
                      border: "1px solid " + (state.view === v ? "var(--accent)" : "var(--border)"),
                      background: state.view === v ? "rgba(99,102,241,0.10)" : "var(--bg)",
                      color: state.view === v ? "var(--accent)" : "var(--text-muted)",
                    }}>{label}</button>
                ))}
              </div>,
              <div key="search" style={{ padding: "8px 8px 6px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                <div style={{ position: "relative", width: "100%" }}>
                  <span style={{
                    position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)",
                    pointerEvents: "none", color: "var(--text-dim)", display: "flex", alignItems: "center",
                  }}>
                    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx={11} cy={11} r={8} />
                      <line x1={21} y1={21} x2={16.65} y2={16.65} />
                    </svg>
                  </span>
                  <input value={q}
                    onChange={(e) => { setState({ q: e.target.value }); if (e.target.value.trim()) void loadRegistry(); }}
                    placeholder={t("ext.searchHint")}
                    style={{
                      width: "100%", height: 28, padding: q ? "0 26px 0 26px" : "0 10px 0 26px",
                      border: "1px solid var(--border)", borderRadius: 6,
                      background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
                      boxSizing: "border-box",
                    }} />
                  {q && (
                    <button onClick={() => setState({ q: "" })} title={t("ext.clearSearch")}
                      style={{
                        position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                        background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer",
                        fontSize: 13, lineHeight: 1, padding: "2px 4px", display: "flex", alignItems: "center",
                      }}>×</button>
                  )}
                </div>
              </div>,
              <div key="results" style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
                {state.view === "caps" ? <CapList q={q} />
                : state.view === "conflicts" ? <ConflictList q={q} />
                : !status ? (
                  <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>…</div>
                ) : [
                  /* ① 来源快捷安装 */
                  hasQuery && looksLikeSource(q) && (
                    <div key="src-row"
                      onClick={() => setState({ selected: { kind: "source", id: q.trim() }, error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView })}
                      style={{
                        display: "flex", alignItems: "center", gap: 7, padding: "8px 8px", marginBottom: 6,
                        borderRadius: 5, cursor: "pointer",
                        border: "1px dashed var(--border)",
                        background: rowSelected("source", q.trim()) ? "var(--bg-selected)" : "none",
                      }}>
                      <span style={{ fontSize: 11, flexShrink: 0 }}>⬇</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)" }}>{t("ext.installFromSource")}</div>
                        <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{q.trim()}</div>
                      </div>
                      <button type="button" disabled={!!installBusy}
                        onClick={(e) => { e.stopPropagation(); void runOp("install", { source: q.trim() }); }}
                        style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", flexShrink: 0 } as React.CSSProperties}>
                        {installBusy ? "…" : t("ext.install")}
                      </button>
                    </div>
                  ),
                  /* ② 本地 */
                  ...localIds.map((id, i) => {
                    const e = status.extensions[id];
                    const isSel = rowSelected("local", id);
                    const reg = registryById[id];
                    const updatable = reg && reg.version && e.version && reg.version !== e.version;
                    const protoChip = protocolChipSpec(e.protocol);
                    const showDivider = !hasQuery && e.enabled === false && (i === 0 || status.extensions[localIds[i - 1]].enabled !== false);
                    const hovered = state.hoverLocal === id;
                    const rowBusy = state.busyKey === "enable:" + id || state.busyKey === "disable:" + id;
                    return (
                      <div key={"l:" + id}>
                        {showDivider && <div style={{ padding: "8px 8px 3px", fontSize: 10, fontWeight: 700, color: "var(--danger, #ef4444)", textTransform: "uppercase", borderTop: "1px solid var(--border)", marginTop: 6 }}>{t("ext.disabled")}</div>}
                        <div onClick={() => setState({ selected: { kind: "local", id }, error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView })}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "9px 10px",
                            borderRadius: 5, cursor: "pointer",
                            background: isSel ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "none",
                            boxShadow: e.enabled === false ? "inset 2px 0 0 rgba(239,68,68,0.55)" : undefined,
                          }}
                          onMouseEnter={() => { if (state.hoverLocal !== id) setState({ hoverLocal: id }); }}
                          onMouseLeave={() => { if (state.hoverLocal === id) setState({ hoverLocal: null }); }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            {/* 第一行：名字（中英文展示名优先，按界面语言切换；缺省回退包名） */}
                            <div title={id} style={{
                              fontSize: 12, fontWeight: isSel ? 600 : 500,
                              color: e.enabled === false ? "var(--text-dim)" : "var(--text)",
                              display: "flex", alignItems: "center", gap: 5, minWidth: 0,
                            }}>
                              <span title={statusDotTitle(e)} style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: statusDotColor(e) }} />
                              {extIconSpan(e, 12, id)}
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{extDisplayName(id, e.name) + (e.version ? " · v" + e.version : "")}</span>
                            {protoChip && <span key="proto" title={e.protocol?.detail || ""} style={chipStyle(protoChip.color, protoChip.bg)}>{protoChip.icon} {protoChip.label}</span>}
                            {e.enabled === false && <span key="off-chip" style={chipStyle("var(--danger, #ef4444)", "rgba(239,68,68,0.14)")}>{t("ext.disabled")}</span>}
                            </div>
                            {/* 第二行：纯英文包名（名字与包名相同时不重复显示） */}
                            <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                              {e.error
                                ? "⚠ " + String(e.error).slice(0, 60)
                                : extDisplayName(id, e.name) !== id
                                  ? <span style={{ fontFamily: "var(--font-mono)" }}>{id}</span>
                                  : null}
                            </div>
                          </div>
                          {hovered && id !== SELF_ID ? (
                            <MiniToggle enabled={e.enabled !== false} loading={rowBusy}
                              onToggle={(ev) => { ev.stopPropagation(); void runOp(e.enabled === false ? "enable" : "disable", { id }); }}
                              label={(e.enabled === false ? t("ext.enable") : t("ext.disable")) + " " + id} />
                          ) : [
                            hasQuery && <span key="inst" style={chipStyle("rgba(99,102,241,0.9)", "rgba(99,102,241,0.12)")}>{t("ext.installed")}</span>,
                            updatable && <span key="up" style={chipStyle("#d97706", "rgba(217,119,6,0.12)")}>↑{reg.version}</span>,
                            !hasQuery && <SourceTag key="src" source={e.source} />,
                          ]}
                        </div>
                      </div>
                    );
                  }),
                  /* ③ 在线（搜索命中且未安装） */
                  hasQuery && ((state.registryError && !state.registryData) ? (
                    <div key="reg-err" style={{ padding: "8px 8px", fontSize: 11, color: "#d97706" }}>
                      {t("ext.registryFailed")}: {state.registryError}
                    </div>
                  ) : !state.registryData ? (
                    <div key="reg-loading" style={{ padding: "8px 8px", fontSize: 11, color: "var(--text-muted)" }}>…</div>
                  ) : [
                    onlineHits.length > 0 && (
                      <div key="online-h" style={{ padding: "10px 8px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", borderTop: "1px solid var(--border)", marginTop: 6 }}>{t("ext.onlineResults")}</div>
                    ),
                    ...onlineHits.map((ext: any) => {
                      const isSel = rowSelected("online", ext.id);
                      const src = registryInstallSource(ext);
                      return (
                        <div key={"o:" + ext.id}
                          onClick={() => setState({ selected: { kind: "online", id: ext.id }, error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView })}
                          style={{
                            display: "flex", alignItems: "center", gap: 8, padding: "9px 10px",
                            borderRadius: 5, cursor: "pointer",
                            background: isSel ? "var(--bg-selected)" : "none",
                          }}
                          onMouseEnter={(ev) => { if (!isSel) ev.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(ev) => { if (!isSel) ev.currentTarget.style.background = "none"; }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            {/* 第一行：名字（中英文展示名优先，按界面语言切换；缺省回退包名） */}
                            <div title={ext.description || ext.id} style={{
                              fontSize: 12, fontWeight: isSel ? 600 : 500, color: "var(--text)",
                              display: "flex", alignItems: "center", gap: 5, minWidth: 0,
                            }}>
                              <span title="状态：未安装" style={{ flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: "var(--border)" }} />
                              {extIconSpan(ext, 12)}
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 }}>{extDisplayName(ext.id, ext.name) + (ext.version ? " · v" + ext.version : "")}</span>
                            </div>
                            {/* 第二行：纯英文包名（+描述；名字与包名相同时不重复显示包名） */}
                            <div style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 }}>
                              {[
                                extDisplayName(ext.id, ext.name) !== ext.id ? <span key="pkg" style={{ fontFamily: "var(--font-mono)" }}>{ext.id}</span> : null,
                                ext.description
                                  ? (extDisplayName(ext.id, ext.name) !== ext.id ? " · " + ext.description : ext.description)
                                  : null,
                              ]}
                            </div>
                          </div>
                          {src ? (
                            <button type="button" disabled={!!installBusy}
                              onClick={(e) => { e.stopPropagation(); void runOp("install", { source: src, docsUrl: registryDocUrl(ext), publisherHint: ext.publisher || ext.author }); }}
                              style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", flexShrink: 0 } as React.CSSProperties}>
                              {installBusy ? "…" : t("ext.install")}
                            </button>
                          ) : (
                            <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0 }}>{t("ext.noSource")}</span>
                          )}
                        </div>
                      );
                    }),
                  ]),
                ]}
              </div>,
            ]}
          </div>

          {/* ── 右：详情（工具条固定顶部，不随内容滚动：小屏=返回+名称；‹ › 前后导航右对齐） ── */}
          <div style={{ display: isMobile && state.mobileView === "list" ? "none" : "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", padding: isMobile ? 12 : 20 }}>
            {(isMobile ? state.mobileView === "detail" : navIndex >= 0) && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexShrink: 0 }}>
                {isMobile && (
                  <>
                    <button type="button" onClick={() => setState({ mobileView: "list" })}
                      style={{ ...btnStyle, display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: 12 } as React.CSSProperties}>← {t("ext.back")}</button>
                    {sel && (
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {selLocal ? extDisplayName(sel.id, selLocal.name) : selOnline ? extDisplayName(sel.id, selOnline.name) : sel.id}
                      </span>
                    )}
                  </>
                )}
                <ExtNav ids={navIds} index={navIndex} />
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
            {!status ? null
              : state.view === "caps" ? (state.selCap ? <CapDetail name={state.selCap} />
                : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>{t("ext.select")}</div>)
              : state.view === "conflicts" ? <ConflictDetail />
              : sel && sel.kind === "add" ? <AddPane />
              : sel && sel.kind === "source" ? <SourceDetail source={sel.id} />
              : selLocal ? <LocalDetail id={sel.id} entry={selLocal} />
              : selOnline ? <OnlineDetail ext={registryById[sel.id]} />
              : <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 }}>{t("ext.select")}</div>}
            </div>
          </div>
        </div>

        {/* footer: roots */}
        {status && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
            padding: "8px 18px", borderTop: "1px solid var(--border)", flexShrink: 0,
          }}>
            <div style={{ minWidth: 0, flex: 1, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: 1.5, overflow: "hidden" }}
              title={[
                "user: " + shortenPath(status.extensionsRoot),
                ...(status.extraExtensionsRoots && status.extraExtensionsRoots.length ? ["extra: " + status.extraExtensionsRoots.map(shortenPath).join(", ")] : []),
                ...(status.devExtensionsRoot ? ["dev: " + shortenPath(status.devExtensionsRoot)] : []),
                "bundled: " + shortenPath(status.bundledExtensionsRoot),
                "data: " + shortenPath(status.dataRoot),
              ].join("\n")}>
              {isMobile
                ? <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>user: {shortenPath(status.extensionsRoot)}</div>
                : [
                  <div key="user">user: {shortenPath(status.extensionsRoot)}</div>,
                  status.extraExtensionsRoots && status.extraExtensionsRoots.length > 0 && <div key="extra">extra: {status.extraExtensionsRoots.map(shortenPath).join(", ")}</div>,
                  status.devExtensionsRoot && <div key="dev">dev: {shortenPath(status.devExtensionsRoot)}</div>,
                  <div key="bundled">bundled: {shortenPath(status.bundledExtensionsRoot)}</div>,
                  <div key="data">data: {shortenPath(status.dataRoot)}</div>,
                ]}
            </div>
            <a href={AITI_REGISTRY_PAGE} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 11, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 }}>
              aiti.pw/extensions
            </a>
          </div>
        )}
      <TrustDialog />
      <DependentsDialog />
    </>
  );
}

// ---------- 本地详情 ----------
function InfoRow({ label, children }: { label: string; children?: React.ReactNode }) {
  return [
    <div key="l" style={{ color: "var(--text-dim)" }}>{label}</div>,
    <div key="v" style={{ color: "var(--text-muted)", minWidth: 0, overflowWrap: "anywhere" }}>{children}</div>,
  ];
}

/** 依赖 chip（硬/可选通用）：ext 边 = 目标扩展名 + 状态点；cap 边 = 解析链（cap.x → 生效提供者 / missing ✗）。 */
function DepChip({ d, optional }: { d: any; optional: boolean }) {
  const jump = (extId: string) => setState({ selected: { kind: "local", id: extId }, error: null, message: null, view: "exts", mobileView: state.isMobile ? "detail" : state.mobileView });
  const ok = d.status === "ok";
  const inactive = d.status === "inactive";
  const color = d.status === "missing" ? "var(--text-dim)" : inactive ? "rgba(217,119,6,0.9)" : "var(--text-muted)";
  const bg = d.status === "missing" ? "var(--bg-hover)" : inactive ? "rgba(217,119,6,0.12)" : "var(--bg-hover)";
  const label = d.kind === "ext"
    ? (extDisplayName(d.target, d.target) + (d.target !== d.name ? " (" + d.name + ")" : ""))
    : d.name + " → " + (d.target ? extDisplayName(d.target, d.target) : "✗ " + t("ext.depMissing"));
  return (
    <span role="button" tabIndex={0}
      onClick={() => { if (d.target) jump(d.target); }}
      onKeyDown={(e) => { if (e.key === "Enter" && d.target) jump(d.target); }}
      title={d.name + " [" + d.kind + (d.viaPin ? " ·pin" : "") + "] " + d.status}
      style={{
        ...chipStyle(color, bg), fontFamily: "var(--font-mono)", fontSize: 11,
        cursor: d.target ? "pointer" : "default", textDecoration: d.status === "missing" ? "line-through" : "none",
      }}>
      {ok ? "✓ " : inactive ? "⚠ " : "✗ "}{label}{d.viaPin ? " ·" + t("ext.depViaPin") : ""}{optional ? " ·optional" : ""}
    </span>
  );
}

function LocalDetail({ id, entry }: { id: string; entry: any }) {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);

  const enabled = entry.enabled !== false;
  const busy = state.busyKey === "enable:" + id || state.busyKey === "disable:" + id || state.busyKey === "remove:" + id;
  const rawSlots = entry.slots || {};
  const slotEntries = Object.entries(rawSlots) as [string, any[]][];
  const slotItems = slotEntries.reduce((s, [, items]) => s + items.length, 0);
  // 插槽条目详情（label/title/context/where）；旧宿主无 slotsDetail 时回退 id 列表。
  const slotDetailOf = (slot: string) => {
    const detail = (entry.slotsDetail && entry.slotsDetail[slot]) || [];
    if (detail.length) return detail;
    return (rawSlots[slot] || []).map((itId: string) => ({ id: itId, label: itId, context: "global", where: "" }));
  };
  const pkg = entry.packageInfo || {};
  // 「被依赖」反向列表（全边类型，含禁用依赖者灰显）+ 每个依赖者的边类型标注（依赖与能力模型）
  const allDependents = dependentsOf(id, { includeDisabled: true, allKinds: true });
  const dependentEdgeKinds: Record<string, string[]> = {};
  for (const e of depEdges()) {
    if (e.to !== id || e.from === id) continue;
    (dependentEdgeKinds[e.from] = dependentEdgeKinds[e.from] || []).push(
      e.kind === "client" ? "·client"
        : (e.kind === "optional-ext" || e.kind === "optional-cap") ? "·optional"
        : e.kind === "hard-cap" ? "·cap." + (e.cap || "")
        : "hard");
  }
  const loader = state.loader;
  const clientState = !entry.client ? t("ext.noClient")
    : loader.materialized.includes(id) ? t("ext.clientLoaded")
    : loader.prefetched.includes(id) ? t("ext.prefetched")
    : t("ext.notLoaded");

  const gridStyle: React.CSSProperties = {
    display: "grid", gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
    gap: "9px 14px", fontSize: 12, lineHeight: 1.45,
  };
  const sectionTitle = { fontSize: 12, fontWeight: 700, color: "var(--text)" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minWidth: 0, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          {id === SELF_ID
            ? <span title={t("ext.selfProtected")} style={chipStyle("rgba(16,185,129,0.9)", "rgba(16,185,129,0.12)")}>🔒 {t("ext.selfProtected")}</span>
            : <Toggle enabled={enabled} loading={busy}
                onToggle={() => void runOp(enabled ? "disable" : "enable", { id })}
                label={enabled ? t("ext.disable") : t("ext.enable")} />}
          <SourceTag source={entry.source} />
          {!enabled && <span style={chipStyle("var(--danger, #ef4444)", "rgba(239,68,68,0.14)")}>{t("ext.disabled")}</span>}
          {entry.error && <span style={chipStyle("var(--danger, #ef4444)", "rgba(239,68,68,0.12)")}>error</span>}
          <span title={id} style={{
            fontSize: 13, fontWeight: 600, color: "var(--text)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{extDisplayName(id, entry.name)}</span>
          {extDisplayName(id, entry.name) !== id && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>{id}</span>
          )}
        </div>
        {entry.source === "user" && entry.dir && id !== SELF_ID && (
          <button type="button" disabled={busy} style={{ ...btnStyle, color: "var(--danger, #ef4444)", background: "rgba(239,68,68,0.08)" } as React.CSSProperties}
            onClick={async () => { if (dependentsOf(id).length > 0 || (await uiConfirm({ message: t("ext.removeConfirm"), danger: true }))) void runOp("remove", { id }); }}>
            {t("ext.remove")}
          </button>
        )}
      </div>

      {pkg.soul && <div style={{ fontSize: 12, fontStyle: "italic", color: "var(--text)", borderLeft: "3px solid var(--accent)", paddingLeft: 10, opacity: 0.92 } as React.CSSProperties}>❝ {pkg.soul} ❞</div>}

      {/* markdown 描述（DESC.md 约定；支持 {{aiti-url}} 等约定变量） */}
      {entry.descriptionMd && <MdDesc text={entry.descriptionMd} vars={extDescVars(id, entry)} />}

      <div style={gridStyle}>
        <InfoRow label={t("ext.status")}>
          <span style={{ color: statusDotColor(entry) }}>{entry.error ? "error" : !enabled ? t("ext.disabled") : entry.loaded ? "loaded" : "—"}</span>
        </InfoRow>
        <InfoRow label={t("ext.name")}><span>{extDisplayName(id, entry.name)}</span></InfoRow>
        <InfoRow label={t("ext.version")}>
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {entry.version || "—"}{pkg.version && pkg.version !== entry.version ? " (package " + pkg.version + ")" : ""}
          </span>
        </InfoRow>
        {entry.protocol && (() => {
          const c = protocolChipSpec(entry.protocol);
          return (
            <InfoRow label={t("ext.protocol")}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  {(entry.protocol.declared ?? "—") + " / " + t("ext.protocolCurrent") + " " + entry.protocol.current}
                </span>
                {c
                  ? <span style={chipStyle(c.color, c.bg)} title={entry.protocol.detail || ""}>{c.icon} {c.label}</span>
                  : <span style={chipStyle("#10b981", "rgba(16,185,129,0.12)")} title={entry.protocol.detail || ""}>✓ {t("ext.protocolOk")}</span>}
                {entry.protocol.needsUpgrade && (
                  <button type="button" style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" } as React.CSSProperties}
                    title={t("ext.protocolUpgradeTitle", { id, from: entry.protocol.declared ?? "legacy", to: entry.protocol.current })}
                    onClick={() => askAiProtocolUpgrade(id, entry.protocol)}>
                    🤖 {t("ext.protocolUpgradeAi")}
                  </button>
                )}
              </span>
            </InfoRow>
          );
        })()}
        <InfoRow label={t("ext.slots")}>
          {slotEntries.length ? t("ext.slotSummary", { slots: slotEntries.length, items: slotItems }) : t("ext.noSlots")}
        </InfoRow>
        <InfoRow label={t("ext.clientBundle")}>
          <span style={{ fontFamily: "var(--font-mono)" }}>
            {entry.client ? entry.client.file + (entry.client.hash ? " @" + entry.client.hash.slice(0, 8) : "") : "—"}
          </span>
        </InfoRow>
        <InfoRow label={t("ext.clientState")}>{clientState}</InfoRow>
        {pkg.homepage && (
          <InfoRow label={t("ext.sourceUrl")}>
            <a href={pkg.homepage} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}>{pkg.homepage}</a>
          </InfoRow>
        )}
        <InfoRow label={t("ext.publisher")}><PublisherCell publisher={entry.publisher} /></InfoRow>
        <InfoRow label={t("ext.dir")}><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{entry.dir ? shortenPath(entry.dir) : "—"}</span></InfoRow>
        <InfoRow label={t("ext.configDir")}><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{entry.configDir ? shortenPath(entry.configDir) : "—"}</span></InfoRow>
        {pkg.name && <InfoRow label="npm"><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{pkg.name}</span></InfoRow>}
        {entry.i18nLocales && entry.i18nLocales.length > 0 && (
          <InfoRow label="i18n"><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{entry.i18nLocales.join(", ")}</span></InfoRow>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={sectionTitle}>{t("ext.slots")}{slotEntries.length ? " · " + t("ext.slotsOpenHint") : ""}</div>
        {slotEntries.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("ext.noSlots")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {slotEntries.map(([slot, ids]) => {
              const items = slotDetailOf(slot);
              const isContext = items.some((it: any) => it.context === "context");
              return (
                <div key={slot} style={{ display: "flex", flexDirection: "column", gap: 4, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--bg-panel)", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: "var(--text-muted)" }}>{slot}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>×{ids.length}</span>
                    {isContext
                      ? <span style={chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)")}>⚠ {t("ext.context")}</span>
                      : <span style={chipStyle("rgba(16,185,129,0.9)", "rgba(16,185,129,0.12)")}>{t("ext.global")}</span>}
                  </div>
                  {items.map((it: any) => {
                    const label = (it.label || it.title || it.id) + "";
                    const where = it.where || "";
                    return (
                      <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span style={{ flex: 1, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                        {where && <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, maxWidth: "38%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{where}</span>}
                        <button type="button"
                          onClick={() => openSlotItem(id, slot, it, currentSessionVal)}
                          title={t("ext.open") + ": " + label + (where ? " · " + where : "")}
                          style={{ ...btnStyle, padding: "2px 9px", fontSize: 10, flexShrink: 0 } as React.CSSProperties}>
                          {t("ext.open")}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={sectionTitle}>{t("ext.deps")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
          {/* 依赖（硬）：depsResolved hard 边——id 命中显示目标扩展；能力名显示解析链（cap.x → 生效提供者 / missing） */}
          {Array.isArray(entry.depsResolved) && entry.depsResolved.some((d: any) => d.hard) && (
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: 110 }}>{t("ext.deps.hard")}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {entry.depsResolved.filter((d: any) => d.hard).map((d: any) => <DepChip key={d.name} d={d} optional={false} />)}
              </span>
            </div>
          )}
          {/* 可选依赖：缺席不影响（missing 灰显）；点击跳目标/生效提供者 */}
          {Array.isArray(entry.depsResolved) && entry.depsResolved.some((d: any) => !d.hard) && (
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: 110 }}>{t("ext.deps.optional")}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {entry.depsResolved.filter((d: any) => !d.hard).map((d: any) => <DepChip key={d.name} d={d} optional={true} />)}
              </span>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: 110 }}>{t("ext.clientDeps")}</span>
            {entry.clientDependsOn && entry.clientDependsOn.length
              ? <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{entry.clientDependsOn.join(" · ")}</span>
              : <span style={{ color: "var(--text-dim)" }}>{t("ext.noDeps")}</span>}
          </div>
          {/* 能力提供 / 独占接管（声明维度，与 ui.provides 内置接管区分） */}
          {(Array.isArray(entry.capsProvides) && entry.capsProvides.length > 0) && (
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: 110 }}>{t("ext.capProvide")}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {entry.capsProvides.map((n: string) => (
                  <span key={n} role="button" tabIndex={0}
                    onClick={() => setState({ view: "caps", selCap: n, selected: null, mobileView: state.isMobile ? "detail" : state.mobileView })}
                    style={{ ...chipStyle("rgba(99,102,241,0.9)", "rgba(99,102,241,0.12)"), fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer" }}>{n}</span>
                ))}
              </span>
            </div>
          )}
          {(Array.isArray(entry.capsTakeover) && entry.capsTakeover.length > 0) && (
            <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: 110 }}>{t("ext.takeoverCaps")}</span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {entry.capsTakeover.map((n: string) => {
                  const tr = Array.isArray(entry.takeoverResolved) ? entry.takeoverResolved.find((x: any) => x.name === n) : null;
                  const effective = tr ? tr.effective : true;
                  return (
                    <span key={n} role="button" tabIndex={0}
                      onClick={() => setState({ view: "conflicts", selConflict: "takeover:" + n, selected: null, mobileView: state.isMobile ? "detail" : state.mobileView })}
                      style={{ ...chipStyle(effective ? "rgba(16,185,129,0.9)" : "var(--text-dim)", effective ? "rgba(16,185,129,0.12)" : "var(--bg-hover)"), fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer" }}>
                      {n} · {effective ? t("ext.takeoverEffective") : t("ext.takeoverShadowed")}
                    </span>
                  );
                })}
              </span>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }} title={t("ext.depsByHint")}>
            <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: 110 }}>{t("ext.depsBy")}</span>
            {allDependents.length
              ? <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {allDependents.map((d: string) => {
                    const off = state.status && state.status.extensions && state.status.extensions[d] && state.status.extensions[d].enabled === false;
                    const kinds = dependentEdgeKinds[d] || [];
                    return <span key={d} role="button" tabIndex={0}
                      onClick={() => setState({ selected: { kind: "local", id: d }, error: null, message: null, view: "exts", mobileView: state.isMobile ? "detail" : state.mobileView })}
                      onKeyDown={(e) => { if (e.key === "Enter") setState({ selected: { kind: "local", id: d }, error: null, message: null, view: "exts", mobileView: state.isMobile ? "detail" : state.mobileView }); }}
                      title={off ? d + "（已禁用）" : d + (kinds.length ? " [" + kinds.join(" ") + "]" : "")}
                      style={{
                        ...chipStyle(off ? "var(--text-dim)" : "var(--text-muted)", "var(--bg-hover)"),
                        fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer", textDecoration: off ? "line-through" : "none",
                      }}>{d}{off ? " ·off" : ""}{kinds.length ? <span style={{ color: "var(--text-dim)" }}> {kinds.join(" ")}</span> : null}</span>;
                  })}
                </span>
              : <span style={{ color: "var(--text-dim)" }}>{t("ext.noDeps")}</span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
            <span style={{ color: "var(--text-dim)", flexShrink: 0, minWidth: 110 }} title={state.status?.sharedDeps ? t("ext.sharedDepsRoot") + ": " + state.status.sharedDeps.nodeModules : undefined}>{t("ext.pkgDeps")}</span>
            {pkg.dependencies && pkg.dependencies.length
              ? <span style={{ display: "flex", gap: 8, flexWrap: "wrap", fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>
                  {pkg.dependencies.map((d: string) => {
                    // npmDepStates（服务端文件级探测，就近优先）：shared=共享根命中 / local=扩展本地 / missing=两边都没有
                    const st = entry.npmDepStates?.[d];
                    const mark = st === "shared" ? "✓" : st === "local" ? "●" : st === "missing" ? "✗" : "";
                    const color = st === "shared" ? "rgba(16,185,129,0.9)" : st === "missing" ? "rgba(239,68,68,0.9)" : "var(--text-dim)";
                    const stateText = st === "shared" ? t("ext.depShared") : st === "local" ? t("ext.depLocal") : st === "missing" ? t("ext.depMissing") : "";
                    return <span key={d} style={{ color, whiteSpace: "nowrap" }} title={stateText ? d + " · " + stateText : d}>{mark ? mark + " " : ""}{d}</span>;
                  })}
                </span>
              : <span style={{ color: "var(--text-dim)" }}>{t("ext.noDeps")}</span>}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={sectionTitle}>{t("ext.serverCaps")}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(entry.serverHooks || []).map((hk: string) => <span key={hk} style={{ ...chipStyle("var(--text-muted)", "var(--bg-hover)"), fontFamily: "var(--font-mono)" }}>{hk}()</span>)}
          {(entry.agentHooks || []).map((hk: string) => <span key={"a:" + hk} style={{ ...chipStyle("rgba(16,185,129,0.9)", "rgba(16,185,129,0.12)"), fontFamily: "var(--font-mono)" }}>agent:{hk}()</span>)}
          {!(entry.serverHooks || []).length && !(entry.agentHooks || []).length && <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("ext.noDeps")}</span>}
        </div>
        {entry.provides && entry.provides.length > 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.provides")}</span>
            {entry.provides.map((p: string) => <span key={p} style={{ ...chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)"), fontFamily: "var(--font-mono)" }}>{p}</span>)}
          </div>
        )}
        {/* 服务出口（DI 方案 P3 §7-7）：本扩展经 ctx.services.provide 注册的存活服务（statusPayload.services） */}
        {(() => {
          const svcs = ((state.status?.services ?? []) as Array<{ key: string; extId: string }>).filter((x) => x.extId === id);
          if (!svcs.length) return null;
          return (
            <div style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.services")}</span>
              {svcs.map((x) => <span key={x.key} style={{ ...chipStyle("rgba(16,120,185,0.9)", "rgba(16,120,185,0.12)"), fontFamily: "var(--font-mono)" }}>{x.key}</span>)}
            </div>
          );
        })()}
      </div>

      {/* 功能管理（扩展声明了 features 才显示） */}
      {entry.features && entry.features.length > 0 ? <FeaturePanel id={id} features={entry.features} /> : null}

      {entry.error && (
        <div style={{
          fontSize: 12, color: "var(--danger, #ef4444)", whiteSpace: "pre-wrap",
          background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.25)",
          borderRadius: 6, padding: "8px 10px", fontFamily: "var(--font-mono)",
        }}>{entry.error}</div>
      )}
    </div>
  );
}

/** string feature 的受控输入框：本地 draft 跟随外部值变更同步（未聚焦时），聚焦时不被外部改动覆写。 */
/** 多行文本 feature（type: "textlist"，一行一条如环境变量列表）：textarea、Enter 换行、blur 提交 */
function TextlistFeatureInput({ f, id, busy, onSave }: { f: any; id: string; busy: boolean; onSave: (v: string) => void }) {
  const cur = typeof f.value === "string" ? f.value : "";
  const [draft, setDraft] = useState(cur);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // 外部改值（AI/ops/其他标签页）→ 输入未聚焦时实时回显
    if (document.activeElement !== ref.current && draft !== cur) setDraft(cur);
  }, [cur]);
  const commit = () => {
    const v = draft;
    if (v === cur) return;
    onSave(v);
  };
  const lines = Math.max(4, draft.split("\n").length + 1);
  return (
    <textarea ref={ref} value={draft} placeholder={f.placeholder || ""} disabled={busy} rows={lines}
      onBlur={commit}
      onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
      style={{ width: "100%", marginTop: 2, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", font: "12px/1.6 var(--font-mono), monospace", outline: "none", boxSizing: "border-box", resize: "vertical", whiteSpace: "pre" }} />
  );
}

function StringFeatureInput({ f, id, busy, onSave }: { f: any; id: string; busy: boolean; onSave: (v: string) => void }) {
  const cur = typeof f.value === "string" ? f.value : "";
  const [draft, setDraft] = useState(cur);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // 外部改值（AI/ops/其他标签页）→ 输入未聚焦时实时回显
    if (document.activeElement !== ref.current && draft !== cur) setDraft(cur);
  }, [cur]);
  const commit = () => {
    const v = draft;
    if (v === cur) return;
    onSave(v);
  };
  return (
    <input ref={ref} value={draft} placeholder={f.placeholder || ""} disabled={busy}
      onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      style={{ width: "100%", marginTop: 2, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", font: "12px/1.5 var(--font-mono), monospace", outline: "none", boxSizing: "border-box" }} />
  );
}

/** 功能管理区块：按 group 分组的 feature 开关列表（声明了 features 才渲染）。 */
function FeaturePanel({ id, features }: { id: string; features: any[] }) {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  const sectionTitle = { fontSize: 12, fontWeight: 700, color: "var(--text)" };
  const on = features.filter((f) => f.enabled !== false).length;
  const off = features.length - on;
  const groups: { group: string; items: any[] }[] = [];
  for (const f of features) {
    const g = f.group || "";
    const last = groups[groups.length - 1];
    if (last && last.group === g) last.items.push(f);
    else groups.push({ group: g, items: [f] });
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={sectionTitle}>{t("ext.features")}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.featuresOn", { on })} · {t("ext.featuresOff", { off })}</span>
      </div>
      <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>{t("ext.featuresHint")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {groups.map((g, gi) => (
          <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {g.group && <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginTop: gi > 0 ? 6 : 0 }}>{g.group}</div>}
            {g.items.map((f) => {
              const key = "set-feature:" + id + ":" + f.id;
              const busy = state.busyKey === key;
              const isString = f.type === "string" || f.type === "textlist";
              return (
                <div key={f.id} style={{
                  display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 8px",
                  borderRadius: 6, background: "var(--bg-panel)", border: "1px solid var(--border)",
                }}>
                  {isString
                    ? <div style={{ width: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 13, lineHeight: 1.4, flexShrink: 0 }}>✎</div>
                    : <Toggle enabled={f.enabled !== false} loading={busy}
                        onToggle={() => void runOp("set-feature", { id, busyId: f.id, featureId: f.id, enabled: f.enabled === false })}
                        label={(f.enabled === false ? t("ext.enable") : t("ext.disable")) + " " + f.id} />}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{f.label}</span>
                      {isString && <span style={chipStyle("#2563eb", "rgba(37,99,235,0.12)")}>{f.type === "textlist" ? "环境变量" : "文本"}</span>}
                      {!isString && f.default === false && <span style={chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)")}>默认关</span>}
                      {!isString && f.enabled === false && <span style={chipStyle("var(--danger, #ef4444)", "rgba(239,68,68,0.12)")}>{t("ext.disabled")}</span>}
                    </div>
                    {f.description && <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 }}>{f.description}</div>}
                    {isString
                      ? (f.type === "textlist"
                        ? <TextlistFeatureInput key={f.id + "-input"} f={f} id={id} busy={busy}
                          onSave={(v) => void runOp("set-feature", { id, busyId: f.id, featureId: f.id, value: v })} />
                        : <StringFeatureInput key={f.id + "-input"} f={f} id={id} busy={busy}
                          onSave={(v) => void runOp("set-feature", { id, busyId: f.id, featureId: f.id, value: v })} />)
                      : <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{f.id}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 在线详情 ----------
function OnlineDetail({ ext }: { ext: any }) {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);

  const installed = state.status && state.status.extensions[ext.id];
  const src = registryInstallSource(ext);
  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;
  const gridStyle: React.CSSProperties = {
    display: "grid", gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
    gap: "9px 14px", fontSize: 12, lineHeight: 1.45,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 }}>
          <span style={{ fontSize: 20, flexShrink: 0, display: "inline-flex" }}>{extIconSpan(ext, 20)}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{extDisplayName(ext.id, ext.name)}</span>
          {extDisplayName(ext.id, ext.name) !== ext.id && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>{ext.id}</span>
          )}
          {installed && <span style={chipStyle("rgba(99,102,241,0.9)", "rgba(99,102,241,0.12)")}>{t("ext.installed")}</span>}
        </div>
        {src && (
          <button type="button" disabled={!!installBusy}
            onClick={() => void runOp("install", { source: src, docsUrl: registryDocUrl(ext), publisherHint: ext.publisher || ext.author })}
            style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" } as React.CSSProperties}>
            {installBusy ? t("ext.installing") : installed ? t("ext.update") : t("ext.install")}
          </button>
        )}
      </div>

      {ext.description && <div style={{ fontSize: 13, color: "var(--text)" }}>{ext.description}</div>}
      {ext.soul && <div style={{ fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>❝ {ext.soul} ❞</div>}

      {/* 在线注册表若提供 markdown 描述（descriptionMd），同样渲染（变量表不含目录类） */}
      {ext.descriptionMd && <MdDesc text={ext.descriptionMd} vars={extDescVars(ext.id)} />}

      <div style={gridStyle}>
        {ext.name && <InfoRow label={t("ext.name")}><span>{extDisplayName(ext.id, ext.name)}</span></InfoRow>}
        {ext.version && <InfoRow label={t("ext.version")}><span style={{ fontFamily: "var(--font-mono)" }}>v{ext.version}</span></InfoRow>}
        {ext.type && <InfoRow label={t("ext.type")}>{ext.type}</InfoRow>}
        {ext.category && <InfoRow label={t("ext.category")}>{ext.category}</InfoRow>}
        <InfoRow label={t("ext.publisher")}><PublisherCell publisher={onlinePublisher(ext)} /></InfoRow>
        {ext.license && <InfoRow label={t("ext.license")}>{ext.license}</InfoRow>}
        {ext.npm && <InfoRow label="npm"><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{ext.npm}</span></InfoRow>}
        {ext.repo && (
          <InfoRow label="repo">
            <a href={/^https?:\/\//.test(ext.repo) ? ext.repo : "https://github.com/" + ext.repo} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}>{ext.repo}</a>
          </InfoRow>
        )}
        <InfoRow label={t("ext.docs")}>
          <a href={registryDocUrl(ext)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}>{registryDocUrl(ext)}</a>
        </InfoRow>
      </div>

      {ext.tags && ext.tags.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {ext.tags.map((tag: string) => <span key={tag} style={chipStyle("var(--text-muted)", "var(--bg-hover)")}>{tag}</span>)}
        </div>
      )}

      {!src && <div style={{ fontSize: 12, color: "#d97706" }}>{t("ext.noSource")} — {t("ext.docs")}: {registryDocUrl(ext)}</div>}
    </div>
  );
}

// ---------- 添加面板（顶栏「添加」→ 右栏；原来源安装界面） ----------
function AddPane() {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);

  const [source, setSource] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null); // File | null
  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;
  const reg = state.registryData;
  const regList = reg && reg.extensions
    ? [...reg.extensions].sort((a: any, b: any) => ((a.type === "pi-web-ext" ? 0 : 1) - (b.type === "pi-web-ext" ? 0 : 1)) || a.id.localeCompare(b.id))
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 680, minHeight: "100%" }}>
      {/* 标题 + 在线注册表链接 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("ext.add")}</div>
          <a href={AITI_REGISTRY_PAGE} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--accent)", fontSize: 12, textDecoration: "none", whiteSpace: "nowrap" }}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1={10} y1={14} x2={21} y2={3} />
            </svg>
            aiti.pw/extensions
          </a>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {t("ext.installTo")}: {state.status ? shortenPath(state.status.extensionsRoot) + "/<id>" : "~/.pi/web/extensions/<id>"}
        </div>
      </div>

      {/* 来源安装：git: / npm: / 本地路径 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <label htmlFor="extman-install-source" style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{t("ext.fromSource")}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="extman-install-source" value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="git:https://… · npm:@scope/pkg · /path/to/ext"
            style={{
              flex: 1, height: 34, padding: "0 11px", border: "1px solid var(--border)", borderRadius: 6,
              background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", minWidth: 0,
            }}
            onKeyDown={(e) => { if (e.key === "Enter" && source.trim() && !installBusy) void runOp("install", { source: source.trim() }); }} />
          <button type="button" disabled={!!installBusy || !source.trim()}
            onClick={() => void runOp("install", { source: source.trim() })}
            style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" } as React.CSSProperties}>
            {installBusy ? t("ext.installing") : t("ext.install")}
          </button>
        </div>
      </div>

      {/* zip 上传安装 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)" }}>{t("ext.uploadZip")}</div>
        <input id="extman-zip-file" type="file" accept=".zip"
          onChange={(e) => { setZipFile((e.target.files && e.target.files[0]) || null); }}
          style={{ display: "none" }} />
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <label htmlFor="extman-zip-file"
            style={{ ...btnStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", flexShrink: 0 } as React.CSSProperties}>
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1={12} y1={3} x2={12} y2={15} />
            </svg>
            {t("ext.chooseZip")}
          </label>
          {zipFile && (
            <span title={zipFile.name}
              style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
              {zipFile.name + " (" + Math.round(zipFile.size / 1024) + " KB)"}
            </span>
          )}
          {zipFile && (
            <button type="button" disabled={!!installBusy}
              onClick={() => void runInstallZip(zipFile)}
              style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", flexShrink: 0 } as React.CSSProperties}>
              {installBusy ? t("ext.installing") : t("ext.install")}
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.zipHint")}</div>
      </div>

      {/* 在线注册表浏览 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{t("ext.registry")}</div>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("ext.registryHint")}</span>
        </div>
        {!reg && !state.registryError && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>…</div>}
        {state.registryError && !reg && <div style={{ fontSize: 12, color: "#d97706" }}>{t("ext.registryFailed")}: {state.registryError}</div>}
        {reg && regList.length === 0 && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("ext.registryEmpty")}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "42vh", overflowY: "auto", paddingRight: 2 }}>
          {regList.map((ext: any) => {
            const installed = state.status && state.status.extensions[ext.id];
            const installedVersion = installed && installed.version;
            const updatable = installed && ext.version && installedVersion && ext.version !== installedVersion;
            const src = registryInstallSource(ext);
            return (
              <div key={ext.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-panel)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 5 }} title={ext.id}>{extIconSpan(ext, 12)}{extDisplayName(ext.id, ext.name)}</span>
                    <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{ext.id}</span>
                    {ext.version && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>v{ext.version}</span>}
                    {ext.type && <span style={chipStyle("var(--text-muted)", "var(--bg-hover)")}>{ext.type}</span>}
                    {installed && <span style={chipStyle("rgba(99,102,241,0.9)", "rgba(99,102,241,0.12)")}>{t("ext.installed")}</span>}
                    {updatable && <span style={chipStyle("#d97706", "rgba(217,119,6,0.12)")}>{t("ext.updateTo", { version: ext.version })}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ext.description || ext.name || ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                  <a href={registryDocUrl(ext)} target="_blank" rel="noopener noreferrer"
                    style={{ ...btnStyle, textDecoration: "none", display: "inline-block", lineHeight: "22px" } as React.CSSProperties}>
                    {t("ext.docs")}
                  </a>
                  {src ? (
                    <button type="button" disabled={!!installBusy}
                      onClick={() => void runOp("install", { source: src, docsUrl: registryDocUrl(ext), publisherHint: ext.publisher || ext.author })}
                      style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" } as React.CSSProperties}>
                      {installBusy ? "…" : installed ? t("ext.update") : t("ext.install")}
                    </button>
                  ) : (
                    <span style={{ fontSize: 10, color: "var(--text-dim)", maxWidth: 120, textAlign: "right" }}>{t("ext.noSource")}</span>
                  )}
                  {installed && (
                    <button type="button" onClick={() => setState({ selected: { kind: "local", id: ext.id }, error: null, message: null })}
                      style={btnStyle as React.CSSProperties}>
                      {t("ext.detail")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 已信任发行者管理 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>🤝 {t("ext.trustedPublishers")}</div>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>({(state.trustedPublishers || []).length})</span>
          <button type="button" onClick={() => void refreshTrusted()}
            style={{ ...btnStyle, padding: "3px 10px", fontSize: 11, marginLeft: "auto" } as React.CSSProperties}>↻</button>
        </div>
        {(state.trustedPublishers || []).length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("ext.trustedEmpty")}</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 240, overflowY: "auto" }}>
            {state.trustedPublishers.map((x: any) => {
              const key = (x.name && x.name.trim()) || x.fingerprint || "?";
              const label = (x.name && x.name.trim()) || (x.fingerprint ? t("ext.publisherUnknown") + " · " + x.fingerprint : "?");
              const busy = state.busyKey === "untrust:" + key;
              return (
                <div key={key + ":" + x.trustedAt} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                  borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)",
                }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
                  <span style={chipStyle("var(--text-muted)", "var(--bg-hover)")}>{publisherSourceLabel(x.source)}</span>
                  {x.url && <a href={x.url} target="_blank" rel="noopener noreferrer" title={x.url} style={{ color: "var(--accent)", fontSize: 11, textDecoration: "none", flexShrink: 0 }}>↗</a>}
                  <button type="button" disabled={busy}
                    onClick={() => void runOp("untrust", { name: key })}
                    style={{ ...btnStyle, padding: "3px 10px", fontSize: 11, color: "var(--danger, #ef4444)", flexShrink: 0 } as React.CSSProperties}>
                    {busy ? "…" : t("ext.untrustPublisher")}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** 停靠 face（rightFileDock item "panel" → 复合 id = EXTMAN_KEY）：仅 docked:right-panel 渲染 */
export function ExtManDockFace(props: any) {
  const docked = useGate(EXTMAN_KEY, { dock: "right-panel" });
  // 停靠面同样需要订阅核心状态强刷：ExtManContent 直接读模块级 state 且自身不订阅，
  // 浮窗面（ExtManPanel）有 subscribeAll 而这里漏了 → 停靠态点列表行 setState 后无人重渲染，「选中」永远不生效
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);
  setCurrentSession(props ? props.currentSession : null);
  // 挂载即拉数据（SidebarFooterButton 入口外的路径——如偏好直达停靠——也有数据）
  useEffect(() => { if (docked) { void refreshStatus(); void refreshTrusted(); syncLoader(); } }, [docked]);
  if (!docked) return null;
  return (
    <DockBody itemKey={EXTMAN_KEY} zone="right-panel" title="扩展管理" chrome="tab"
      zones={["right-panel"]} defaultZone="right-panel">
      <ExtManContent />
    </DockBody>
  );
}

function SourceDetail({ source }: { source: string }) {
  const [, force] = useState(0);
  useEffect(() => subscribeAll(() => force((v) => v + 1)), []);

  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;
  const kind = /^(git:|git@|https?:\/\/)/i.test(source) ? "git"
    : /^(npm:|@)/i.test(source) ? "npm" : "path";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 18 }}>⬇</span>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{t("ext.installFromSource")}</div>
      </div>
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)",
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6,
        padding: "10px 12px", overflowWrap: "anywhere",
      }}>{source}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ ...chipStyle("var(--text-muted)", "var(--bg-hover)"), fontFamily: "var(--font-mono)" }}>{kind}</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
          {t("ext.installTo")}: {state.status ? shortenPath(state.status.extensionsRoot) + "/<id>" : "~/.pi/web/extensions/<id>"}
        </span>
        <button type="button" disabled={!!installBusy}
          onClick={() => void runOp("install", { source })}
          style={{ ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" } as React.CSSProperties}>
          {installBusy ? t("ext.installing") : t("ext.install")}
        </button>
      </div>
    </div>
  );
}

/* sidebarFooter：侧栏底部快捷操作行按钮（与内置 模型/技能/插件 同一排、同风格） */
/** 打开扩展管理面板（SidebarFooterButton 与懒加载静态入口 meta.onClick 共用；
 *  模块级 store 驱动，物化前调用同样生效）。 */
export function openExtmanPanel(): void {
  // 打开即重置最大化：小屏全屏由 aiti-float 的 data-ext-float-full 标记自动接管；
  // 列表折叠保持用户上次选择
  setState({ open: true, maximized: false, error: null, message: null, zBack: false });
  void refreshStatus();
  void refreshTrusted();
  syncLoader();
}

export function SidebarFooterButton() {
  return (
    <button title={t("ext.title")}
      onClick={() => openExtmanPanel()}
      style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        height: 32, padding: 0, background: "none", border: "none",
        borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
        fontSize: 12, transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        <circle cx={12} cy={12} r={4} />
      </svg>
      {t("ext.shortLabel")}
    </button>
  );
}
