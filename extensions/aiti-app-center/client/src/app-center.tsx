/**
 * aiti-app-center · app-center —— 应用中心 UI（spacer 填充物；方案 docs/aiti-app-center-refactor-plan.md）。
 *
 * 渲染契约：本组件经 aiti-app-center.api 服务交付 session-manager 编排器，渲染进
 * DockStack 的 spacer（全部区块折叠时才存在——任一展开自动让位，零显隐状态）。
 * React 原语 = 宿主单实例（host-shim 委托 ctx；跨 bundle 组件工厂与 DockStack 服务同模式）。
 *
 * 布局（v2 视图分置，不占行）：
 *   搜索行 = 搜索框（flex:1）+ ✏️ 编辑 / ＋ 扩展管理 / ⇄ 视图切换（28px 方形图标按钮）
 *   · 应用视图（默认）：可执行入口（action/panel/manage）
 *       flat（可见应用 ≤ FLAT_MODE_THRESHOLD）按分类平铺；否则「常用（钉住序）+ 更多（分类 chips + 网格）」
 *     开关视图：toggle 按来源扩展分组的行式开关（不钉不隐藏）
 *   卡片操作：非编辑态 hover（触屏常显）= ☆ 快捷钉拔 + ? 信息页；编辑态追加 ✕ 隐藏、钉住区 ▲▼
 *   信息页：来源扩展（名/id/版本/描述）+ 功能说明 + 钉住/隐藏 + 该扩展开关直切 + 一键禁用（状态机）+ 打开扩展管理
 */
import { useState, useEffect, useMemo, useRef, apiUrl, t } from "./host-shim";
import {
  buildApps, matchApp, viewMode, moreExpandedDefault, categoryLabel, categorySortKey,
  splitByKind, extensionToggleGroups, hardDependents, disableExtension, isToggleId,
  readPinned, readHidden, togglePinned, toggleHidden, hideApp, movePinned, pruneToggleIds,
  setBooleanFeature, APP_STORE_EVENT,
  type AppDescriptor, type ToggleGroup,
} from "./app-registry";
import { present, presentState, dockPref } from "../../../_shared/ext-float-dock-core";

/** 触屏（无 hover）：卡片右上角 ☆/? 常显（方案 §5.2）。 */
const IS_TOUCH = typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

/** 信息页不提供「一键禁用」的扩展：自身（请在管理器管理）与管理器本身。 */
const DISABLE_PROTECT: Record<string, string> = {
  "aiti-app-center": "info.disableSelf",
  "aiti-extman": "info.disableManager",
};

/** 面板打开原语：已停靠 → 原位激活（ACTIVATE 置前）；有偏好 → 落偏好位；否则右栏 tab（dock 面板的宿命位）。 */
function openPanel(key: string): void {
  try {
    const cur = presentState(key);
    if (cur.startsWith("docked:")) {
      const zone = cur.slice("docked:".length);
      if (zone) { present(key, `dock:${zone}`); return; }
    }
    const pref = dockPref(key);
    if (pref && pref !== "float") { present(key, `dock:${pref}`); return; }
    present(key, "dock:right-panel");
  } catch { /* ignore */ }
}

/** manifest 一次拉取（304 缓存同宿主）；refresh = 禁用后重拉（nonce 变更触发 effect，非轮询）。 */
function useManifestExts(): { exts: Array<Record<string, any>>; refresh: () => void } {
  const [exts, setExts] = useState<Array<Record<string, any>>>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch(apiUrl("/api/extensions/manifest"))
      .then((r) => r.json())
      .then((d) => { if (alive && d && Array.isArray(d.extensions)) setExts(d.extensions); })
      .catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, [nonce]);
  return { exts, refresh: () => setNonce((n) => n + 1) };
}

/** feature 态本地覆盖层：extman 广播（含本扩展自己 set-feature 后补发的同款事件）→ 原地 patch，不重拉 manifest。 */
function useFeatureOverlay(): { overlay: Record<string, boolean>; dropExt: (extId: string) => void } {
  const [overlay, setOverlay] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ extId?: string; featureId?: string; enabled?: boolean; value?: string }>).detail;
      if (!d?.extId || !d?.featureId) return;
      setOverlay((m) => ({ ...m, [`${d.extId}:${d.featureId}`]: d.value !== undefined ? d.value !== "" : d.enabled !== false }));
    };
    window.addEventListener("pi-web:ext-features-changed", on);
    return () => window.removeEventListener("pi-web:ext-features-changed", on);
  }, []);
  // 禁用后须丢该扩展的覆盖键：残留值会在 extman 重新启用时把旧状态错误地盖回声明默认值上。
  const dropExt = (extId: string) => setOverlay((m) => {
    let changed = false;
    const next: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(m)) {
      if (k.startsWith(`${extId}:`)) { changed = true; continue; }
      next[k] = v;
    }
    return changed ? next : m;
  });
  return { overlay, dropExt };
}

/* ── 图标（声明式三形态 + 字母兜底；语义同宿主 renderExtItemIcon）── */

function IconGlyph(props: { icon?: string | { svg: string } | null; extId: string; label: string; size?: number }) {
  const { icon, extId, label, size = 20 } = props;
  if (icon && typeof icon === "object" && "svg" in icon) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon.svg }} />
    );
  }
  if (typeof icon === "string" && icon.endsWith(".svg")) {
    const url = apiUrl(`/api/extensions/${extId}/assets/${icon}`);
    return (
      <span aria-hidden style={{
        display: "inline-block", width: size, height: size, flexShrink: 0, background: "currentColor",
        WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")`,
        WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
        WebkitMaskPosition: "center", maskPosition: "center",
        WebkitMaskSize: "contain", maskSize: "contain",
      }} />
    );
  }
  if (typeof icon === "string" && icon) {
    return <span aria-hidden style={{ fontSize: size - 4, lineHeight: 1 }}>{icon}</span>;
  }
  return <span aria-hidden style={{ fontSize: size - 6, fontWeight: 600, lineHeight: 1 }}>{label.slice(0, 1)}</span>;
}

const iconProps = {
  width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true,
} as const;

const EditIcon = () => (
  <svg {...iconProps}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const PlusIcon = () => (
  <svg {...iconProps}>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);
/** 切换按钮图标恒指向另一侧：应用视图给开关（sliders），开关视图给应用（grid）。 */
const SlidersIcon = () => (
  <svg {...iconProps}>
    <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3" />
    <path d="M14 2v4M8 10v4M16 18v4" />
  </svg>
);
const GridIcon = () => (
  <svg {...iconProps}>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </svg>
);

const miniBtn = (active?: boolean, danger?: boolean) => ({
  width: 26, height: 26, display: "inline-flex", alignItems: "center", justifyContent: "center",
  border: "none", borderRadius: 6, padding: 0, cursor: "pointer", fontFamily: "inherit", fontSize: 12, lineHeight: 1,
  background: active ? "var(--bg-selected, #2a2a2a)" : "none",
  color: danger ? "var(--text-dim, #888)" : active ? "var(--accent, #2563eb)" : "var(--text-muted, #888)",
} as const);

/** 搜索行右侧紧凑图标按钮（28px 方形，不占额外行）。 */
function HeaderButton(props: { title: string; onClick: () => void; active?: boolean; children: any }) {
  const { title, onClick, active, children } = props;
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={active} onClick={onClick}
      style={{
        width: 28, height: 28, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
        border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: 0, cursor: "pointer",
        background: active ? "var(--bg-selected, #2a2a2a)" : "none",
        color: active ? "var(--accent, #2563eb)" : "var(--text-muted, #999)",
      }}>
      {children}
    </button>
  );
}

/** 应用卡（应用视图专用）。edit = 常显完整操作组；非编辑态 hover/触屏出 ☆ 与 ?。 */
function AppCard(props: {
  app: AppDescriptor; edit: boolean; pinned: boolean; infoActive: boolean;
  onRun: (app: AppDescriptor) => void;
  onInfo: (app: AppDescriptor) => void;
  onMove?: (appId: string, delta: number) => void;
}) {
  const { app, edit, pinned, infoActive, onRun, onInfo, onMove } = props;
  const [hover, setHover] = useState(false);
  const showOps = edit || hover || IS_TOUCH;
  return (
    <div
      data-app-card={app.id}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 5, minWidth: 0 }}
    >
      <button
        type="button"
        title={`${app.label}${app.extName ? ` · ${app.extName}` : ""}`}
        aria-label={app.label}
        onClick={() => onRun(app)}
        style={{
          width: 52, height: 52, display: "flex", alignItems: "center", justifyContent: "center",
          gap: 0, background: "var(--bg-hover, #232323)", border: "1px solid var(--border, #3a3a3a)",
          borderRadius: 13, color: "var(--text-muted, #999)", cursor: "pointer", padding: 0,
          position: "relative", transition: "background 0.12s, color 0.12s, border-color 0.12s",
        }}
        onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected, #2a2a2a)"; e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
        onMouseLeave={(e: any) => { e.currentTarget.style.background = "var(--bg-hover, #232323)"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}
      >
        <IconGlyph icon={app.icon} extId={app.extId} label={app.label} />
      </button>
      <span style={{ fontSize: 10, lineHeight: 1.3, color: "var(--text-muted, #999)", textAlign: "center", width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", userSelect: "none" }}>
        {app.label}
      </span>
      {showOps ? (
        <span style={{ position: "absolute", top: -6, right: -2, display: "flex", gap: 2, zIndex: 2 }}>
          <button type="button" title={pinned ? t("app.unpin") : t("app.pin")} aria-label={pinned ? t("app.unpin") : t("app.pin")}
            style={miniBtn(pinned)}
            onClick={() => togglePinned(app.id)}>{pinned ? "★" : "☆"}</button>
          {edit ? (
            <button type="button" title={t("app.hide")} aria-label={t("app.hide")} style={miniBtn(false, true)}
              onClick={() => hideApp(app.id)}>✕</button>
          ) : null}
          <button type="button" title={t("info.title")} aria-label={t("info.title")} style={miniBtn(infoActive)}
            onClick={() => onInfo(app)}>?</button>
        </span>
      ) : null}
      {edit && pinned && onMove ? (
        <span style={{ position: "absolute", top: -6, left: -2, display: "flex", gap: 2, zIndex: 2 }}>
          <button type="button" title={t("app.up")} aria-label={t("app.up")} style={miniBtn()} onClick={() => onMove(app.id, -1)}>▲</button>
          <button type="button" title={t("app.down")} aria-label={t("app.down")} style={miniBtn()} onClick={() => onMove(app.id, 1)}>▼</button>
        </span>
      ) : null}
    </div>
  );
}

const sectionHead = { fontSize: 10, fontWeight: 600, color: "var(--text-dim, #888)", letterSpacing: "0.05em", textTransform: "uppercase" as const, padding: "2px 2px 0", userSelect: "none" as const };
const gridStyle = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: "10px 6px", width: "100%" } as const;
const chipBtn = {
  display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start",
  background: "none", border: "1px solid var(--border, #3a3a3a)", borderRadius: 7,
  padding: "3px 9px", fontSize: 11, fontFamily: "inherit", cursor: "pointer",
} as const;

/** 分类分区（分类头 + 卡片网格）。 */
function CategorySection(props: {
  id: string; apps: AppDescriptor[]; edit: boolean; pinnedSet: Set<string>; infoId: string;
  onRun: (app: AppDescriptor) => void; onInfo: (app: AppDescriptor) => void; onMove?: (appId: string, delta: number) => void;
}) {
  const { id, apps, edit, pinnedSet, infoId, onRun, onInfo, onMove } = props;
  return (
    <div data-app-category={id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={sectionHead}>{categoryLabel(id, t)}（{apps.length}）</span>
      <div style={gridStyle}>
        {apps.map((a) => (
          <AppCard key={a.id} app={a} edit={edit} pinned={pinnedSet.has(a.id)} infoActive={infoId === a.id}
            onRun={onRun} onInfo={onInfo} onMove={onMove} />
        ))}
      </div>
    </div>
  );
}

/** 行式开关（开关视图与信息页共用；点击即切，不涉钉住/隐藏）。 */
function ToggleRow(props: { app: AppDescriptor; onToggle: (app: AppDescriptor) => void }) {
  const { app, onToggle } = props;
  const on = app.on === true;
  const flip = () => onToggle(app);
  return (
    <div
      role="switch" aria-checked={on} tabIndex={0} data-app-toggle-row={app.id}
      title={app.featureDescription ? `${app.label} · ${app.featureDescription}` : app.label}
      onClick={flip}
      onKeyDown={(e: any) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } }}
      style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 2px", cursor: "pointer",
        borderTop: "1px solid var(--border, #2f2f2f)",
      }}
    >
      <span aria-hidden style={{
        width: 7, height: 7, flexShrink: 0, borderRadius: "50%",
        background: on ? "#4ade80" : "var(--text-dim, #666)", boxShadow: on ? "0 0 0 2px rgba(74,222,128,0.18)" : "none",
      }} />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontSize: 12, color: "var(--text, #ddd)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.label}</span>
        {app.featureDescription ? (
          <span style={{ fontSize: 10, color: "var(--text-dim, #888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{app.featureDescription}</span>
        ) : null}
      </span>
      <span aria-hidden style={{
        width: 30, height: 17, flexShrink: 0, borderRadius: 999, position: "relative",
        background: on ? "var(--accent, #2563eb)" : "var(--bg-selected, #2a2a2a)",
        border: "1px solid var(--border, #3a3a3a)", transition: "background 0.12s",
      }}>
        <span style={{
          position: "absolute", top: 2, left: on ? 15 : 2, width: 11, height: 11, borderRadius: "50%",
          background: on ? "#fff" : "var(--text-dim, #888)", transition: "left 0.12s",
        }} />
      </span>
    </div>
  );
}

/** 开关视图分组块（组头 = 扩展图标 + 名 + 计数）。 */
function ToggleGroupBlock(props: { group: ToggleGroup; onToggle: (app: AppDescriptor) => void }) {
  const { group, onToggle } = props;
  return (
    <div data-toggle-group={group.extId} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ ...sectionHead, display: "flex", alignItems: "center", gap: 5, textTransform: "none", fontSize: 11 }}>
        <IconGlyph icon={group.extIcon} extId={group.extId} label={group.extName ?? group.extId} size={13} />
        {group.extName ?? group.extId}
        <span style={{ opacity: 0.65, fontWeight: 400 }}>（{group.apps.length}）</span>
      </span>
      {group.apps.map((a) => <ToggleRow key={a.id} app={a} onToggle={onToggle} />)}
    </div>
  );
}

/** 信息页浮层（absolute 贴根节点，不随内容滚动；内容区内部滚动）。 */
function InfoSheet(props: {
  app: AppDescriptor;
  toggles: AppDescriptor[];
  dependents: string[];
  pinned: boolean;
  canDisable: boolean;
  protectKey?: string;
  confirm: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onPin: (app: AppDescriptor) => void;
  onHide: (app: AppDescriptor) => void;
  onToggleFeature: (app: AppDescriptor) => void;
  onAskDisable: () => void;
  onConfirmDisable: () => void;
  onOpenExtman: () => void;
}) {
  const { app, toggles, dependents, pinned, canDisable, protectKey, confirm, busy, error } = props;
  const bodyRow = { fontSize: 11, color: "var(--text-dim, #888)", lineHeight: 1.5, wordBreak: "break-all" as const };
  return (
    <div
      data-app-info-sheet={app.id}
      style={{
        position: "absolute", left: 8, right: 8, top: 48, bottom: 8, zIndex: 5,
        display: "flex", flexDirection: "column", gap: 8,
        background: "var(--bg-panel, #1b1b1b)", border: "1px solid var(--border, #3a3a3a)",
        borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,0.45)", padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <IconGlyph icon={app.icon} extId={app.extId} label={app.label} size={16} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "var(--text, #ddd)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {app.label}
        </span>
        <button type="button" title={t("info.close")} aria-label={t("info.close")} style={miniBtn()} onClick={props.onClose}>✕</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={sectionHead}>{t("info.source")}</span>
          <span style={bodyRow}>{app.extName ?? app.extId} · {app.extId}{app.extVersion ? ` · ${app.extVersion}` : ""}</span>
          <span style={{ ...bodyRow, color: "var(--text-muted, #999)" }}>{app.extDescription || t("info.noDesc")}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={sectionHead}>{t("info.function")}</span>
          <span style={bodyRow}>{t(`kind.${app.kind}`)} · {app.label}</span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={{ ...chipBtn, color: pinned ? "var(--accent, #2563eb)" : "var(--text-muted, #999)" }}
            onClick={() => props.onPin(app)}>{pinned ? `★ ${t("app.unpin")}` : `☆ ${t("app.pin")}`}</button>
          <button type="button" style={{ ...chipBtn, color: "var(--text-dim, #888)" }}
            onClick={() => props.onHide(app)}>{t("info.hide")}</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={sectionHead}>{t("info.switches")}</span>
          {toggles.length === 0 ? (
            <span style={bodyRow}>{t("info.noSwitches")}</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {toggles.map((a) => <ToggleRow key={a.id} app={a} onToggle={props.onToggleFeature} />)}
            </div>
          )}
        </div>

        {canDisable && !protectKey ? (
          <div style={{ borderTop: "1px solid var(--border, #2f2f2f)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {dependents.length > 0 ? (
              /* 硬依赖者非空 = 置灰不开洞（与 extman 硬阻止同口径），引导去扩展管理 */
              <>
                <button type="button" disabled style={{ ...chipBtn, color: "#ef4444", opacity: 0.5, cursor: "not-allowed" }}>{t("info.disable")}</button>
                <span style={bodyRow}>{t("info.disableBlocked", { deps: dependents.join("、") })}</span>
              </>
            ) : busy ? (
              <button type="button" disabled style={{ ...chipBtn, color: "#ef4444", opacity: 0.6 }}>{t("info.disableBusy")}</button>
            ) : confirm ? (
              <>
                <span style={bodyRow}>{t("info.disableConfirm", { ext: app.extName ?? app.extId })}</span>
                <span style={{ ...bodyRow, color: "var(--text-dim, #888)" }}>{t("info.disableHint")}</span>
                <span style={{ display: "flex", gap: 6 }}>
                  <button type="button" style={{ ...chipBtn, color: "#ef4444", borderColor: "rgba(239,68,68,0.5)" }} onClick={props.onConfirmDisable}>{t("info.disableYes")}</button>
                  <button type="button" style={chipBtn} onClick={props.onAskDisable}>{t("info.disableNo")}</button>
                </span>
              </>
            ) : (
              <button type="button" style={{ ...chipBtn, color: "#ef4444", borderColor: "rgba(239,68,68,0.35)" }} onClick={props.onAskDisable}>{t("info.disable")}</button>
            )}
            {error ? <span style={{ ...bodyRow, color: "#ef4444" }}>{error}</span> : null}
            <button type="button" style={chipBtn} onClick={props.onOpenExtman}>{t("info.openExtman")}</button>
          </div>
        ) : (
          <div style={{ borderTop: "1px solid var(--border, #2f2f2f)", paddingTop: 8 }}>
            {protectKey ? <span style={bodyRow}>{t(protectKey)}</span> : null}
            {!canDisable ? <span style={bodyRow}>{t("info.disableNoManager")}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** 应用中心主组件（ctx = 宿主扩展 ctx；useSlotItems 为宿主真 hook，须在渲染体内调用）。 */
export function AppCenter(props: { ctx: Record<string, any> }) {
  const { ctx } = props;
  // 插槽枚举（三槽均非交互槽——宿主 AppShell 启动即读，懒扩展以静态条目+转发器出现，零额外拉取）
  const toolbarItems = (ctx.useSlotItems as (s: string) => any[])?.("toolbar") ?? [];
  const footerItems = (ctx.useSlotItems as (s: string) => any[])?.("sidebarFooter") ?? [];
  const rightDockItems = (ctx.useSlotItems as (s: string) => any[])?.("rightFileDock") ?? [];
  const { exts, refresh: refreshManifest } = useManifestExts();
  const { overlay: featureOverlay, dropExt: dropFeatureOverlay } = useFeatureOverlay();
  // 一次性本地迁移（P0-2）：prune 必须先于两个数组的读取——useState 初始化器按声明序在首帧执行。
  const [pinned, setPinned] = useState<string[]>(() => { pruneToggleIds(); return readPinned(); });
  const [hidden, setHidden] = useState<string[]>(() => readHidden());
  useEffect(() => {
    const sync = () => { setPinned(readPinned()); setHidden(readHidden()); };
    window.addEventListener(APP_STORE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(APP_STORE_EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState(false);
  const [view, setView] = useState<"apps" | "toggles">("apps");
  const [moreOpen, setMoreOpen] = useState<boolean>(() => moreExpandedDefault(readPinned().length));
  const [selectedCat, setSelectedCat] = useState<string>("__all");
  const [infoId, setInfoId] = useState<string | null>(null);
  const [disable, setDisable] = useState<{ confirm: boolean; busy: boolean; error: string | null }>({ confirm: false, busy: false, error: null });
  const [removedExts, setRemovedExts] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const featureState = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const e of exts) for (const f of e.features ?? []) m[`${e.id}:${f.id}`] = featureOverlay[`${e.id}:${f.id}`] ?? f.enabled !== false;
    return m;
  }, [exts, featureOverlay]);

  const builtApps = useMemo(() => buildApps({
    exts: exts as any,
    slotItems: [
      ...toolbarItems.map((it: any) => ({ ...it, slot: "toolbar" as const })),
      ...footerItems.map((it: any) => ({ ...it, slot: "sidebarFooter" as const })),
      ...rightDockItems.map((it: any) => ({ ...it, slot: "rightFileDock" as const })),
    ],
    featureState,
    openPanel,
  }), [toolbarItems, footerItems, rightDockItems, exts, featureState]);

  // 禁用成功 = 乐观移除该扩展全部四类卡（不依赖宿主 store 更新时序；reload 后插槽卡自然消失）
  const apps = useMemo(() => (removedExts.length === 0 ? builtApps : builtApps.filter((a) => !removedExts.includes(a.extId))), [builtApps, removedExts]);
  const { entries, toggles } = useMemo(() => splitByKind(apps), [apps]);
  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const visibleEntries = useMemo(() => entries.filter((a) => !hiddenSet.has(a.id)), [entries, hiddenSet]);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const pinnedApps = useMemo(() => pinned
    .map((id) => (isToggleId(id) ? undefined : visibleEntries.find((a) => a.id === id)))
    .filter((a): a is AppDescriptor => Boolean(a)), [pinned, visibleEntries]);
  const extmanApp = useMemo(() => apps.find((a) => a.extId === "aiti-extman" && a.kind === "manage") ?? null, [apps]);
  const infoApp = useMemo(() => (infoId ? apps.find((a) => a.id === infoId) ?? null : null), [apps, infoId]);
  const infoToggles = useMemo(() => (infoApp ? toggles.filter((a) => a.extId === infoApp.extId) : []), [infoApp, toggles]);
  const infoDependents = useMemo(() => (infoApp ? hardDependents(exts as any, infoApp.extId) : []), [infoApp, exts]);

  // 形态判断用「实际可见钉住数」（P0-2 双保险）：钉住数组可能含已隐藏/已消失的 id。
  // 只在此处「展开」修正（数据迟到后才发现无可见钉住）——收起只发生在下次打开，
  // 用户当场 hover 钉住不打断「更多」浏览（§2）。
  const pinnedSeenRef = useRef(pinnedApps.length > 0);
  useEffect(() => {
    if (apps.length === 0) return;
    const has = pinnedApps.length > 0;
    if (has === pinnedSeenRef.current) return;
    pinnedSeenRef.current = has;
    if (!has) setMoreOpen(true);
  }, [pinnedApps.length, apps.length]);

  const searching = query.trim().length > 0;
  const entryResults = useMemo(() => (searching ? visibleEntries.filter((a) => matchApp(a, query)) : []), [searching, visibleEntries, query]);
  const toggleGroups = useMemo(() => extensionToggleGroups(searching ? toggles.filter((a) => matchApp(a, query)) : toggles), [searching, toggles, query]);

  // 分类分组（内部分类声明序在前、自定义按名排后；空分类不出现；常用区已显示的去重）
  const byCategory = useMemo(() => {
    const groups = new Map<string, AppDescriptor[]>();
    const pinnedVisible = new Set(pinnedApps.map((a) => a.id));
    for (const a of visibleEntries) {
      if (pinnedVisible.has(a.id) && !searching) continue;
      (groups.get(a.category) ?? groups.set(a.category, []).get(a.category)!).push(a);
    }
    return [...groups.entries()].sort((x, y) => categorySortKey(x[0]).localeCompare(categorySortKey(y[0])));
  }, [visibleEntries, pinnedApps, searching]);

  const mode = viewMode(visibleEntries.length);
  if (apps.length === 0) return null; // 无可收录入口 → spacer 保持空白（行为同未装）

  const onToggleFeature = (app: AppDescriptor) => {
    const featureId = app.id.slice(`toggle:${app.extId}:`.length);
    void setBooleanFeature(apiUrl, app.extId, featureId, app.on !== true);
  };
  const onRun = (app: AppDescriptor) => {
    if (app.kind === "toggle") { onToggleFeature(app); return; }
    app.run();
  };
  const closeInfo = () => { setInfoId(null); setDisable({ confirm: false, busy: false, error: null }); };
  const openInfo = (app: AppDescriptor) => {
    if (infoId === app.id) { closeInfo(); return; }
    setInfoId(app.id);
    setDisable({ confirm: false, busy: false, error: null });
    scrollRef.current?.scrollTo?.(0, 0);
  };
  const switchView = () => {
    setView((v) => (v === "apps" ? "toggles" : "apps"));
    setEdit(false); // 编辑模式仅作用于应用视图（§1.2）
    setQuery("");
    closeInfo();
  };
  const openExtman = () => { if (extmanApp) { closeInfo(); extmanApp.run(); } };
  const askDisable = () => setDisable((d) => ({ confirm: !d.confirm, busy: false, error: d.error }));
  const confirmDisable = () => {
    if (!infoApp || disable.busy) return;
    const target = infoApp;
    setDisable({ confirm: true, busy: true, error: null });
    void disableExtension(apiUrl, target.extId).then((r) => {
      if (!r.ok) {
        setDisable({ confirm: true, busy: false, error: r.error ?? t("info.disableFailed", { ext: target.extId }) });
        return;
      }
      setRemovedExts((cur) => (cur.includes(target.extId) ? cur : [...cur, target.extId]));
      dropFeatureOverlay(target.extId);
      refreshManifest();
      closeInfo();
      setNotice(t("info.disabled", { ext: target.extName ?? target.extId }));
    });
  };

  const renderCards = (list: AppDescriptor[], withMove: boolean) => (
    <div style={gridStyle}>
      {list.map((a) => (
        <AppCard key={a.id} app={a} edit={edit} pinned={pinnedSet.has(a.id)} infoActive={infoId === a.id}
          onRun={onRun} onInfo={openInfo} onMove={withMove ? (id, d) => { movePinned(id, d); } : undefined} />
      ))}
    </div>
  );
  const renderSection = (cat: string, list: AppDescriptor[]) => (
    <CategorySection key={cat} id={cat} apps={list} edit={edit} pinnedSet={pinnedSet} infoId={infoId ?? ""}
      onRun={onRun} onInfo={openInfo} onMove={(id, d) => { movePinned(id, d); }} />
  );

  return (
    <div data-aiti-app-center="1" style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
      {/* 搜索行：搜索框吸收挤压 + 三枚方形图标按钮（不额外占行） */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, padding: "10px 12px 0" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, background: "var(--bg-hover, #232323)", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: "5px 9px" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" style={{ color: "var(--text-dim, #888)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e: any) => setQuery(e.target.value)}
            placeholder={t(view === "apps" ? "app.search" : "app.searchToggles")}
            aria-label={t(view === "apps" ? "app.search" : "app.searchToggles")}
            style={{ flex: 1, minWidth: 0, background: "none", border: "none", outline: "none", color: "var(--text, #ddd)", fontSize: 12, fontFamily: "inherit" }}
          />
        </div>
        {view === "apps" ? (
          <HeaderButton title={edit ? t("app.done") : t("app.edit")} active={edit} onClick={() => setEdit((v) => !v)}>
            <EditIcon />
          </HeaderButton>
        ) : null}
        {extmanApp ? (
          <HeaderButton title={t("view.extman")} onClick={openExtman}><PlusIcon /></HeaderButton>
        ) : null}
        <HeaderButton title={t(view === "apps" ? "view.toToggles" : "view.toApps")} onClick={switchView}>
          {view === "apps" ? <SlidersIcon /> : <GridIcon />}
        </HeaderButton>
      </div>

      {notice ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 12px 0", padding: "5px 8px", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, fontSize: 11, color: "var(--text-muted, #999)" }}>
          <span style={{ flex: 1, minWidth: 0 }}>{notice}</span>
          <button type="button" style={miniBtn()} title={t("info.close")} aria-label={t("info.close")} onClick={() => setNotice(null)}>✕</button>
        </div>
      ) : null}

      <div ref={scrollRef} data-app-center-body="1" style={{ flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "10px 12px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
        {view === "toggles" ? (
          toggleGroups.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-dim, #888)", textAlign: "center", padding: "12px 0" }}>{t("app.noResults")}</div>
          ) : (
            toggleGroups.map((g) => <ToggleGroupBlock key={g.extId} group={g} onToggle={onToggleFeature} />)
          )
        ) : searching ? (
          entryResults.length > 0 ? renderCards(entryResults, true) : (
            <div style={{ fontSize: 12, color: "var(--text-dim, #888)", textAlign: "center", padding: "12px 0" }}>{t("app.noResults")}</div>
          )
        ) : mode === "flat" ? (
          /* flat：按分类平铺全部 */
          byCategory.map(([cat, list]) => renderSection(cat, list))
        ) : (
          /* two-segment：常用 + 更多 */
          <>
            {pinnedApps.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={sectionHead}>{t("app.pinned")}（{pinnedApps.length}）</span>
                {renderCards(pinnedApps, true)}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: "var(--text-dim, #888)", padding: "2px 2px" }}>{t("app.pinHint")}</div>
            )}
            {/* 更多（首次态默认展开；钉过默认收起；编辑态强制展开——hover 快捷钉不打断展开） */}
            {moreOpen || edit ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div role="tablist" aria-label={t("app.more")} style={{ display: "flex", flexWrap: "wrap", gap: "5px 6px", flexShrink: 0 }}>
                  {[["__all", t("app.all"), visibleEntries.length - pinnedApps.length] as const,
                    ...byCategory.map(([cat, list]) => [cat, categoryLabel(cat, t), list.length] as const)].map(([key, label, count]) => {
                    const active = selectedCat === key;
                    return (
                      <button key={key} type="button" role="tab" aria-selected={active}
                        onClick={() => setSelectedCat(key)}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border, #3a3a3a)",
                          borderRadius: 999, padding: "3px 10px", fontSize: 11, fontFamily: "inherit", cursor: "pointer",
                          background: active ? "var(--bg-selected, #2a2a2a)" : "none",
                          color: active ? "var(--accent, #2563eb)" : "var(--text-muted, #999)",
                        }}>
                        {label}
                        <span style={{ opacity: 0.65 }}>{count}</span>
                      </button>
                    );
                  })}
                </div>
                {(selectedCat === "__all" ? byCategory : byCategory.filter(([cat]) => cat === selectedCat)).map(([cat, list]) => renderSection(cat, list))}
              </div>
            ) : (
              <button type="button" onClick={() => { setMoreOpen(true); setSelectedCat("__all"); }}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, alignSelf: "center",
                  background: "none", border: "1px solid var(--border, #3a3a3a)", borderRadius: 8, padding: "5px 14px",
                  color: "var(--text-muted, #999)", cursor: "pointer", fontSize: 12, fontFamily: "inherit",
                }}>
                ⌄ {t("app.more")}（{visibleEntries.length - pinnedApps.length}）
              </button>
            )}
          </>
        )}

        {/* 编辑态：已隐藏项恢复区（应用视图专属） */}
        {edit && view === "apps" && hidden.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--border, #3a3a3a)", paddingTop: 10 }}>
            <span style={sectionHead}>{t("app.hidden")}（{hidden.length}）</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {hidden.map((id) => {
                const app = entries.find((a) => a.id === id);
                return (
                  <button key={id} type="button" onClick={() => toggleHidden(id)}
                    title={t("app.restore")} aria-label={`${t("app.restore")} ${app?.label ?? id}`}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "1px dashed var(--border, #3a3a3a)", borderRadius: 7, padding: "3px 8px", color: "var(--text-dim, #888)", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                    {app ? <IconGlyph icon={app.icon} extId={app.extId} label={app.label} size={12} /> : null}
                    {app?.label ?? id} ⟳
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {infoApp ? (
        <InfoSheet
          app={infoApp}
          toggles={infoToggles}
          dependents={infoDependents}
          pinned={pinnedSet.has(infoApp.id)}
          canDisable={Boolean(extmanApp)}
          protectKey={DISABLE_PROTECT[infoApp.extId]}
          confirm={disable.confirm}
          busy={disable.busy}
          error={disable.error}
          onClose={closeInfo}
          onPin={(a) => { togglePinned(a.id); }}
          onHide={(a) => { hideApp(a.id); closeInfo(); }}
          onToggleFeature={onToggleFeature}
          onAskDisable={askDisable}
          onConfirmDisable={confirmDisable}
          onOpenExtman={openExtman}
        />
      ) : null}
    </div>
  );
}

/** 服务 API（aiti-app-center.api）：跨 bundle 组件工厂，session-manager 编排器作 DockStack filler 消费。 */
export function createAppCenterApi(ctx: Record<string, any>) {
  return {
    renderAppCenter: () => <AppCenter ctx={ctx} />,
  };
}
