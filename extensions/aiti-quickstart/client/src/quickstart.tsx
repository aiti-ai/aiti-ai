/**
 * aiti-quickstart · quickstart —— 组件层（JSX，宿主渲染原语经 host-shim）。
 *
 * 四个渲染面 + 一个导航动作：
 *   - GuideWidget / ShortcutsWidget / ExamplesWidget：宿主 newSessionWidgets 插槽
 *     的 widget 内容（extra 只读数据 { cwd, isMobile, area }，动作走宿主服务）；
 *   - QuickstartFiller：侧栏 DockStack 全折叠空白引导卡（aiti-quickstart.api 交付，
 *     session-manager 编排器 filler 消费；✕ 关闭持久化，关闭后回退纯应用中心）；
 *   - QuickstartFooterButton：侧栏底部「快速上手」按钮（sidebarFooter 注册条目，
 *     与内置 模型/技能/设置 同排同款样式，照 extman SidebarFooterButton）；
 *   - openQuickstart：?cwd → home 兜底 → toast 放弃；导航 = 宿主服务
 *     pi-web.newSession.setCwd（handleNewSession 落空白欢迎页，widget 即现）。
 */
import { useState, t, extSvc } from "./host-shim";
import { readSidebarDismissed, writeSidebarDismissed, resolveQuickstartCwd } from "./quickstart-logic";

/* ── 公共样式（CSS vars 带兜底，照 app-center 卡片写法） ── */
const cardStyle: Record<string, unknown> = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px",
  border: "1px solid var(--border, #3a3a3a)",
  borderRadius: 10,
  boxSizing: "border-box",
  overflow: "hidden",
  fontFamily: "inherit",
};
const titleStyle: Record<string, unknown> = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text, #ddd)",
  flexShrink: 0,
};
const chipBase: Record<string, unknown> = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  border: "1px solid var(--border, #3a3a3a)",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 11.5,
  color: "var(--text-muted, #999)",
  background: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "border-color 0.12s, color 0.12s, background 0.12s",
};

function RocketIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: "var(--accent, #2563eb)", flexShrink: 0 }}>
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  );
}

/* ── 导航动作 ── */

/** 重返快速上手页（footer 按钮 / 引导卡按钮 / 应用中心卡共用）。
 *  cwd 解析链见 quickstart-logic.resolveQuickstartCwd；导航走宿主服务，失败静默（toast 兜底）。 */
export async function openQuickstart(): Promise<void> {
  let sessionCwd: string | null = null;
  try {
    // 会话视图里点「重返」→ 落当前项目的快速上手页（快照同步读，session 摘要含 cwd）
    const sessSvc = extSvc<{ get: () => { session?: { cwd?: string } | null } | null }>("pi-web.session");
    sessionCwd = sessSvc?.get?.()?.session?.cwd ?? null;
  } catch { /* ignore */ }
  let home: string | null = null;
  try {
    const homeSvc = extSvc<{ ensure: () => Promise<string | null> }>("pi-web.home");
    if (homeSvc?.ensure) home = await homeSvc.ensure();
  } catch { /* ignore */ }
  const search = typeof window !== "undefined" ? window.location.search : "";
  const cwd = resolveQuickstartCwd(search, home, sessionCwd);
  if (!cwd) {
    try { extSvc<{ show: (msg: string) => void }>("pi-web.toast")?.show?.(t("qs.toast.noCwd")); } catch { /* ignore */ }
    return;
  }
  try { extSvc<{ setCwd: (p: string) => void }>("pi-web.newSession")?.setCwd?.(cwd); } catch { /* ignore */ }
}

/* ── 欢迎页 widget ── */

const GUIDE_STEP_KEYS = ["qs.step1", "qs.step2", "qs.step3", "qs.step4"] as const;
const SHORTCUT_KEYS = ["qs.sc.newSession", "qs.sc.at", "qs.sc.slash", "qs.sc.enter"] as const;
const EXAMPLE_KEYS = ["qs.ex.1", "qs.ex.2", "qs.ex.3", "qs.ex.4"] as const;

/** 上手步骤卡（top，w8 h2）：4 步骤 2×2（手机单列）；纯指引无动作。 */
export function GuideWidget(props: { cwd?: string | null; isMobile?: boolean; area?: string }) {
  const isMobile = props.isMobile === true;
  return (
    <div style={cardStyle}>
      <div style={{ ...titleStyle, justifyContent: "space-between" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <RocketIcon />{t("qs.guideTitle")}
        </span>
        <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-dim, #888)" }}>{t("qs.guideHint")}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "6px 14px", alignContent: "center" }}>
        {GUIDE_STEP_KEYS.map((key, i) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              width: 18, height: 18, borderRadius: 999, fontSize: 11, fontWeight: 600,
              color: "var(--accent, #2563eb)", border: "1px solid var(--accent, #2563eb)",
            }}>{i + 1}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted, #999)", lineHeight: 1.5, minWidth: 0 }}>{t(key)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 快捷操作卡（top，w4 h1）：kbd 芯片换行排布（行高 minmax(64px,auto)，内容可撑高）。 */
export function ShortcutsWidget() {
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>{t("qs.shortcutsTitle")}</div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexWrap: "wrap", gap: 6, alignContent: "center" }}>
        {SHORTCUT_KEYS.map((key) => (
          <span key={key} style={{ ...chipBase, cursor: "default", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 11 }}>
            {t(key)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 示例提示词卡（bottom，w8 h1）：chip 点击写入 composer 并聚焦（pi-web.composer 服务）。
 *  服务形 = 字段访问式 { get(name), names() }（ChatInput composerUiRef 契约），非平铺对象。 */
export function ExamplesWidget() {
  const fill = (text: string) => {
    try {
      const composer = extSvc<{ get: (name: string) => unknown }>("pi-web.composer");
      const setInputValue = composer?.get?.("setInputValue") as ((v: string) => void) | undefined;
      const focusComposer = composer?.get?.("focusComposer") as (() => void) | undefined;
      setInputValue?.(text);
      focusComposer?.();
    } catch { /* ignore */ }
  };
  return (
    <div style={{ ...cardStyle, height: "auto", minHeight: "100%" }}>
      <div style={titleStyle}>{t("qs.examplesTitle")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {EXAMPLE_KEYS.map((key) => (
          <button key={key} type="button" style={chipBase} onClick={() => fill(t(key))}
            onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #2563eb)"; e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border, #3a3a3a)"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
            {t(key)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** widget 渲染分发（entry.tsx registerItems 用；id = 注册裸 id）。 */
export function renderWidget(id: string, props: Record<string, unknown>): unknown {
  switch (id) {
    case "guide": return <GuideWidget {...(props as any)} />;
    case "shortcuts": return <ShortcutsWidget {...(props as any)} />;
    case "examples": return <ExamplesWidget {...(props as any)} />;
    default: return null;
  }
}

/* ── 侧栏空白引导卡（DockStack filler） ── */

const FILLER_STEP_KEYS = ["qs.filler.step1", "qs.filler.step2", "qs.filler.step3"] as const;

/** 全折叠空白引导卡：在上、应用中心在下（spacer flex column，本卡 flexShrink 0）。
 *  ✕ 关闭持久化（pi:quickstart:sidebar-dismissed），关闭后返回 null = 回退现状。 */
export function QuickstartFiller() {
  const [dismissed, setDismissed] = useState(() => readSidebarDismissed());
  if (dismissed) return null;
  return (
    <div style={{
      flexShrink: 0, margin: "10px 12px 8px", padding: "10px 12px",
      border: "1px solid var(--border, #3a3a3a)", borderRadius: 10,
      display: "flex", flexDirection: "column", gap: 8, fontFamily: "inherit",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <RocketIcon size={13} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text, #ddd)" }}>{t("qs.filler.title")}</span>
        <button type="button" title={t("qs.filler.dismiss")} aria-label={t("qs.filler.dismiss")}
          onClick={() => { writeSidebarDismissed(true); setDismissed(true); }}
          style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 20, height: 20, padding: 0, background: "none", border: "none", borderRadius: 5,
            color: "var(--text-dim, #888)", cursor: "pointer", fontSize: 12, lineHeight: 1,
          }}
          onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover, #232323)"; e.currentTarget.style.color = "var(--text, #ddd)"; }}
          onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-dim, #888)"; }}>
          ✕
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {FILLER_STEP_KEYS.map((key, i) => (
          <div key={key} style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
            <span style={{ fontSize: 11, color: "var(--text-dim, #888)", flexShrink: 0 }}>{i + 1}.</span>
            <span style={{ fontSize: 12, color: "var(--text-muted, #999)", lineHeight: 1.6, minWidth: 0 }}>{t(key)}</span>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => { void openQuickstart(); }}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
          border: "1px solid var(--accent, #2563eb)", borderRadius: 8, padding: "5px 10px",
          background: "none", color: "var(--accent, #2563eb)", cursor: "pointer",
          fontSize: 12, fontFamily: "inherit", transition: "background 0.12s",
        }}
        onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected, #2a2a2a)"; }}
        onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; }}>
        <RocketIcon size={12} />{t("qs.filler.open")}
      </button>
    </div>
  );
}

/* ── 侧栏底部按钮（sidebarFooter 注册条目；与内置 模型/技能/设置 同排同款） ── */

/** 照 extman SidebarFooterButton 的标准形（flex:1 / height 32 / hover 反色）。 */
export function QuickstartFooterButton() {
  return (
    <button type="button" title={t("qs.footer.title")} aria-label={t("qs.footer.label")}
      onClick={() => { void openQuickstart(); }}
      style={{
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        height: 32, padding: 0, background: "none", border: "none",
        borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
        fontSize: 12, transition: "background 0.12s, color 0.12s", fontFamily: "inherit",
      }}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}>
      <RocketIcon size={14} />
      <span>{t("qs.footer.label")}</span>
    </button>
  );
}
