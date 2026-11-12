/**
 * aiti-quickstart · quickstart —— 组件层（JSX，宿主渲染原语经 host-shim）。
 *
 * 渲染面 + 动作（v2，方案 docs/aiti-quickstart-hub-plan.md §4）：
 *   - GuideWidget：状态机开始卡——fresh（无 cwd 无历史）= 获取工作区/配置模型大按钮流；
 *     hasWorkspace（有工作区无模型）= 上次工作区 chips + 配置模型引导；full = v1 四步卡。
 *     id 不变（"guide"）保住宿主 widget 偏好。
 *   - ShortcutsWidget：快捷键卡（8 项：新建会话/发送/换行/停止 + @/斜杠/历史召回）。
 *   - RuntimeWidget：任务运行时概念卡（fork/侧聊/插队/排队/继续，图标复刻宿主流式按钮）。
 *   - ExamplesWidget：照 v1。
 *   - QuickstartFiller：DockStack 全折叠空白引导卡 v2——无 cwd 态出「获取工作区 +
 *     配置模型」两按钮；有 cwd → 原 3 步 + 打开快速上手页。
 *   - QuickstartFooterButton / WorkspacePickerAcquireEntry：底部行 / Workspace 下拉
 *     动作区入口（footer=重返欢迎页；acquire=开 Hub）。
 *   - openQuickstart：[URL 规范] cwd 不进 URL——来源链 tab-session →
 *     window.__piWebCwd → 最近项目（/api/sessions 派生）→ home；导航 = pi-web.newSession.setCwd。
 *   - openWorkspaceHub / openModelConfig：Hub 与模型配置深链（wizard 服务 → window
 *     全局 → pi-web.ui setSettingsSection 半私有兜底 → toast）。
 *
 * extra 只读数据（slot-extra 红线）：widget 收 { cwd, isMobile, area }；动作全走服务。
 */
import { useState, useEffect, t, extSvc, apiUrl, onExtServiceChange } from "./host-shim";
import { readSidebarDismissed, writeSidebarDismissed, resolveQuickstartCwd, topRecentRoot, deriveOnboardingState, splitKbdHint, RUNTIME_ROWS, type OnboardingState } from "./quickstart-logic";

/* ── 公共样式（CSS vars 带兜底，照 app-center 卡片写法；紧凑化 2026-11-12——
 *   三张 top 卡合计须 ≤ 宿主顶区上限 min(300px,38vh)，矮窗口不内滚） ── */
const cardStyle: Record<string, unknown> = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "6px 10px",
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
  fontSize: 12,
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
  padding: "1px 8px",
  fontSize: 10.5,
  color: "var(--text-muted, #999)",
  background: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "border-color 0.12s, color 0.12s, background 0.12s",
};
const primaryBtn: Record<string, unknown> = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
  border: "1px solid var(--accent, #2563eb)", borderRadius: 8, padding: "6px 12px",
  background: "none", color: "var(--accent, #2563eb)", cursor: "pointer",
  fontSize: 12, fontFamily: "inherit", transition: "background 0.12s",
};

/** lucide folder-plus——与宿主「添加文件夹到侧栏」同款（系统图标语言：获取/添加一个工作区；
 *  rocket 保留 guide 标题/footer 的品牌位，「获取工作区」动作统一用本图标）。 */
function FolderPlusIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <line x1="12" y1="10" x2="12" y2="16" />
      <line x1="9" y1="13" x2="15" y2="13" />
    </svg>
  );
}

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

/* ── cwd 源采集（[URL 规范] 无 URL 源） ── */

function readTabCwd(): string | null {
  try {
    const raw = window.sessionStorage.getItem("pi-web:tab-open-session");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kind?: string; cwd?: string };
    return parsed?.kind === "new" && typeof parsed.cwd === "string" ? parsed.cwd : null;
  } catch {
    return null;
  }
}

function readSessionCwd(): string | null {
  try {
    const v = (window as unknown as { __piWebCwd?: string | null }).__piWebCwd;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

async function fetchHome(): Promise<string | null> {
  try {
    const svc = extSvc<{ ensure: () => Promise<string | null> }>("pi-web.home");
    if (svc?.ensure) return await svc.ensure();
  } catch { /* ignore */ }
  try {
    const res = await fetch(apiUrl("/api/home"));
    const d = (await res.json()) as { home?: string };
    return typeof d.home === "string" ? d.home : null;
  } catch {
    return null;
  }
}

/** 最近项目根 top1（/api/sessions → topRecentRoot；失败 null）。 */
async function fetchRecentRoot(): Promise<string | null> {
  try {
    const res = await fetch(apiUrl("/api/sessions"), { headers: { accept: "application/json" } });
    const d = (await res.json()) as { sessions?: Array<{ cwd?: string; projectRoot?: string | null; modified?: string }> };
    return topRecentRoot(d.sessions ?? []);
  } catch {
    return null;
  }
}

/* ── 导航动作 ── */

/** 重返快速上手页（footer 按钮 / 引导卡按钮 / 常用区卡共用）。
 *  cwd 解析链见 resolveQuickstartCwd；导航走宿主服务，失败静默（toast 兜底）。 */
export async function openQuickstart(): Promise<void> {
  const tabCwd = readTabCwd();
  const sessionCwd = readSessionCwd();
  let recentRoot: string | null = null;
  let home: string | null = null;
  if (!tabCwd && !sessionCwd) {
    recentRoot = await fetchRecentRoot();
    if (!recentRoot) home = await fetchHome();
  }
  const cwd = resolveQuickstartCwd({ tabCwd, sessionCwd, recentRoot, home });
  if (!cwd) {
    try { extSvc<{ show: (msg: string) => void }>("pi-web.toast")?.show?.(t("qs.toast.noCwd")); } catch { /* ignore */ }
    return;
  }
  try { extSvc<{ setCwd: (p: string) => void }>("pi-web.newSession")?.setCwd?.(cwd); } catch { /* ignore */ }
}

/** 打开 Workspace Hub（开始卡/filler/下拉动作区共用；entry.tsx 注册为 aiti-quickstart.open 服务）。 */
export function openWorkspaceHub(): void {
  try { window.dispatchEvent(new CustomEvent("aiti-quickstart:open-hub")); } catch { /* ignore */ }
}

/** 配置模型深链：wizard openTab("add") → window.__aitiModelWizardOpenTab →
 *  pi-web.ui.get("setSettingsSection")("models")（宿主运行时集合在册但未列入
 *  HOST_UI_FIELDS 文档契约——半私有兜底，宿主如收窄需回退 toast 提示）→ toast。 */
export function openModelConfig(): void {
  try {
    const wizard = extSvc<(tab?: string) => void>("aiti-model-wizard.openTab");
    if (typeof wizard === "function") { wizard("add"); return; }
  } catch { /* ignore */ }
  try {
    const g = (window as unknown as { __aitiModelWizardOpenTab?: (tab?: string) => void }).__aitiModelWizardOpenTab;
    if (typeof g === "function") { g("add"); return; }
  } catch { /* ignore */ }
  try {
    const ui = extSvc<{ get: (name: string) => unknown }>("pi-web.ui");
    const setSection = ui?.get?.("setSettingsSection") as ((s: string) => void) | undefined;
    if (typeof setSection === "function") { setSection("models"); return; }
  } catch { /* ignore */ }
  try { extSvc<{ show: (msg: string) => void }>("pi-web.toast")?.show?.(t("qs.start.modelMissing")); } catch { /* ignore */ }
}

/* ── 状态采集 hook（开始卡 / filler v2 共用） ── */

interface Vitals { cwd: string | null; recentRootCount: number; modelCount: number; ready: boolean; modelsOk: boolean }

function useVitals(cwdFromExtra?: string | null): Vitals {
  const [vitals, setVitals] = useState<Vitals>({ cwd: cwdFromExtra ?? null, recentRootCount: 0, modelCount: 0, ready: false, modelsOk: false });
  useEffect(() => {
    let alive = true;
    const scan = async () => {
      // cwd：slot extra（欢迎页实时）优先，缺则 tab-session / 会话 cwd
      const cwd = (cwdFromExtra && cwdFromExtra.trim()) || readTabCwd() || readSessionCwd();
      let recentRootCount = 0;
      let modelCount = 0;
      let modelsOk = false;
      try {
        const res = await fetch(apiUrl("/api/sessions"), { headers: { accept: "application/json" } });
        const d = (await res.json()) as { sessions?: Array<{ cwd?: string; projectRoot?: string | null }> };
        const roots = new Set<string>();
        for (const s of d.sessions ?? []) {
          const r = (s.projectRoot && String(s.projectRoot).trim()) || (s.cwd && String(s.cwd).trim()) || "";
          if (r) roots.add(r);
        }
        recentRootCount = roots.size;
      } catch { /* ignore */ }
      try {
        const res = await fetch(apiUrl("/api/models"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cwd ?? undefined }) });
        const d = (await res.json()) as { modelList?: unknown[] };
        // modelsOk = 检测成功（响应含 modelList 数组）——失败时 UI 不得断言「尚未配置」
        // （2026-11-07 用户抓包：裸相对 fetch 在无尾斜杠 /dev 下 404 → 恒 0 → 瞎说；已改 apiUrl）
        if (res.ok && Array.isArray(d.modelList)) {
          modelCount = d.modelList.length;
          modelsOk = true;
        }
      } catch { /* ignore */ }
      if (alive) setVitals({ cwd: cwd ?? null, recentRootCount, modelCount, ready: true, modelsOk });
    };
    void scan();
    const refresh = () => { void scan(); };
    try {
      window.addEventListener("pi-web:models-changed", refresh);
      window.addEventListener("pi-web:sessions-changed", refresh);
      document.addEventListener("visibilitychange", refresh);
    } catch { /* ignore */ }
    return () => {
      alive = false;
      try {
        window.removeEventListener("pi-web:models-changed", refresh);
        window.removeEventListener("pi-web:sessions-changed", refresh);
        document.removeEventListener("visibilitychange", refresh);
      } catch { /* ignore */ }
    };
  }, [cwdFromExtra]);
  return vitals;
}

/* ── 欢迎页 widget ── */

const FULL_STEP_KEYS = ["qs.step1", "qs.step2", "qs.step3", "qs.step4"] as const;
/** 快捷操作卡 8 项（桌面 4 列 ×2 行、手机 2 列）：基础行（会话/发送/换行/停止）
 *  + 输入行（@、/、历史召回）。语义对照宿主 ChatInput handleKeyDown。 */
const SHORTCUT_KEYS = [
  "qs.sc.newSession", "qs.sc.enter", "qs.sc.shiftEnter", "qs.sc.escStop",
  "qs.sc.at", "qs.sc.slash", "qs.sc.upRecall", "qs.sc.upHistory",
] as const;
const EXAMPLE_KEYS = ["qs.ex.1", "qs.ex.2", "qs.ex.3", "qs.ex.4"] as const;

/** 「上次工作区」chips 数据：/api/sessions distinct projectRoot（modified 降序 top3）。 */
function useRecentRoots(): Array<{ root: string; name: string }> {
  const [roots, setRoots] = useState<Array<{ root: string; name: string }>>([]);
  useEffect(() => {
    let alive = true;
    const scan = async () => {
      try {
        const res = await fetch(apiUrl("/api/sessions"), { headers: { accept: "application/json" } });
        const d = (await res.json()) as { sessions?: Array<{ cwd?: string; projectRoot?: string | null; modified?: string }> };
        const best = new Map<string, number>();
        for (const s of d.sessions ?? []) {
          const r = (s.projectRoot && String(s.projectRoot).trim()) || (s.cwd && String(s.cwd).trim()) || "";
          if (!r) continue;
          const tm = s.modified ? Date.parse(s.modified) : 0;
          if ((best.get(r) ?? -1) < tm) best.set(r, tm);
        }
        const list = [...best.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
          .map(([root]) => ({ root, name: root.split(/[\\/]/).filter(Boolean).pop() ?? root }));
        if (alive) setRoots(list);
      } catch { /* ignore */ }
    };
    void scan();
    const refresh = () => { void scan(); };
    try { window.addEventListener("pi-web:sessions-changed", refresh); } catch { /* ignore */ }
    return () => { alive = false; try { window.removeEventListener("pi-web:sessions-changed", refresh); } catch { /* ignore */ } };
  }, []);
  return roots;
}

function StepChip({ label }: { label: string }) {
  return <span style={{ ...chipBase, cursor: "default" }}>{label}</span>;
}

/** 上手步骤卡（top，w8 h2）：状态机三态。id 不变（"guide"）保宿主偏好。 */
export function GuideWidget(props: { cwd?: string | null; isMobile?: boolean; area?: string }) {
  const isMobile = props.isMobile === true;
  const vitals = useVitals(props.cwd ?? null);
  const recents = useRecentRoots(); // hooks 顶层调用（hasWorkspace 分支内用）
  const importReady = useImportServiceReady();
  const state: OnboardingState = vitals.ready
    ? deriveOnboardingState({ cwd: vitals.cwd, recentRootCount: vitals.recentRootCount, modelCount: vitals.modelCount })
    : "full"; // 数据未到先渲染 full（v1 形态），到位后切换——零闪烁成本可接受

  const head = (
    <div style={{ ...titleStyle, justifyContent: "space-between" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <RocketIcon />{t("qs.guideTitle")}
      </span>
      <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-dim, #888)" }}>{t("qs.guideHint")}</span>
    </div>
  );

  if (state === "fresh") {
    return (
      <div style={cardStyle}>
        {head}
        <div style={{ fontSize: 12, color: "var(--text-muted, #999)", flexShrink: 0 }}>{t("qs.start.subtitle")}</div>
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: isMobile ? "column" : "row", gap: 8, alignItems: "center", justifyContent: "center" }}>
          <button type="button" style={{ ...primaryBtn, flex: isMobile ? undefined : 1, maxWidth: 280 }} onClick={openWorkspaceHub}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected, #2a2a2a)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; }}>
            <RocketIcon size={12} />
            <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.3 }}>
              <span>{t("qs.start.acquire")}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim, #888)" }}>{t("qs.start.acquireHint")}</span>
            </span>
          </button>
          <button type="button" style={{ ...primaryBtn, flex: isMobile ? undefined : 1, maxWidth: 280 }} onClick={openModelConfig}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected, #2a2a2a)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; }}>
            <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.3 }}>
              <span>{t("qs.start.configureModel")}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim, #888)" }}>{t("qs.start.modelMissing")}</span>
            </span>
          </button>
          {importReady ? (
            <button type="button" style={{ ...primaryBtn, flex: isMobile ? undefined : 1, maxWidth: 280 }} onClick={openModelsImport} title={t("qs.start.importModelsTitle")}
              onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected, #2a2a2a)"; }}
              onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; }}>
              <ImportIcon />
              <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.3 }}>
                <span>{t("qs.start.importModels")}</span>
                <span style={{ fontSize: 10, color: "var(--text-dim, #888)" }}>{t("qs.start.importModelsHint")}</span>
              </span>
            </button>
          ) : null}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flexShrink: 0 }}>
          <StepChip label={t("qs.start.step.workspace")} />
          <StepChip label={t("qs.start.step.model")} />
          <StepChip label={t("qs.start.step.msg")} />
        </div>
      </div>
    );
  }

  if (state === "hasWorkspace") {
    return (
      <div style={cardStyle}>
        {head}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexShrink: 0 }}>
          <span style={{ fontSize: 11.5, color: "var(--text-dim, #888)" }}>{t("qs.start.recent")}</span>
          {recents.map((r) => (
            <button key={r.root} type="button" style={chipBase}
              onClick={() => { try { extSvc<{ setCwd: (p: string) => void }>("pi-web.newSession")?.setCwd?.(r.root); } catch { /* ignore */ } }}
              onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #2563eb)"; e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
              onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border, #3a3a3a)"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
              {r.name}
            </button>
          ))}
          {vitals.modelsOk && vitals.modelCount === 0 ? (
            <>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--text-dim, #888)" }}>
                ● {t("qs.start.modelMissing")}
              </span>
              <button type="button" style={{ ...chipBase, borderColor: "var(--accent, #2563eb)", color: "var(--accent, #2563eb)" }} onClick={openModelConfig}>
                {t("qs.start.configureModel")}
              </button>
              {importReady ? (
                <button type="button" style={{ ...chipBase, borderColor: "var(--accent, #2563eb)", color: "var(--accent, #2563eb)" }} onClick={openModelsImport} title={t("qs.start.importModelsTitle")}>
                  <ImportIcon />
                  <span>{t("qs.start.importModels")}</span>
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "3px 12px", alignContent: "center" }}>
          {FULL_STEP_KEYS.slice(2).map((key, i) => (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 16, height: 16, borderRadius: 999, fontSize: 10.5, fontWeight: 600, color: "var(--accent, #2563eb)", border: "1px solid var(--accent, #2563eb)" }}>{i + 3}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted, #999)", lineHeight: 1.45, minWidth: 0 }}>{t(key)}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // full：四步卡 + 初始化动作行（工作区/模型齐备后仍保留一键入口——重开 Hub / 配置模型）
  const actionChip = (icon: unknown, label: string, onClick: () => void, key: string) => (
    <button key={key} type="button" style={{ ...chipBase, color: "var(--text-muted, #999)" }} onClick={onClick}
      onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #2563eb)"; e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border, #3a3a3a)"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <div style={cardStyle}>
      {head}
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "3px 12px", alignContent: "center" }}>
        {FULL_STEP_KEYS.map((key, i) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
              width: 16, height: 16, borderRadius: 999, fontSize: 10.5, fontWeight: 600,
              color: "var(--accent, #2563eb)", border: "1px solid var(--accent, #2563eb)",
            }}>{i + 1}</span>
            <span style={{ fontSize: 11, color: "var(--text-muted, #999)", lineHeight: 1.45, minWidth: 0 }}>{t(key)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, flexShrink: 0, paddingTop: 2, borderTop: "1px dashed var(--border, #3a3a3a)" }}>
        {actionChip(<FolderPlusIcon />, t("qs.open.hub"), openWorkspaceHub, "hub")}
        {actionChip(<GearIcon />, t("qs.start.configureModel"), openModelConfig, "model")}
        {importReady ? actionChip(<ImportIcon />, t("qs.start.importModels"), openModelsImport, "import") : null}
      </div>
    </div>
  );
}

/** lucide import（托盘+下箭头）——与 aiti-models-import toolbar 同款（从其他 Agent 导入模型配置）。 */
function ImportIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

/** aiti-models-import.open 服务探测（缺席 → null，入口不渲染）。 */
function modelsImportService(): { open: () => void } | null {
  try {
    const svc = extSvc<{ open?: unknown }>("aiti-models-import.open");
    if (svc && typeof svc.open === "function") return svc as { open: () => void };
  } catch { /* ignore */ }
  return null;
}

/** 导入服务在位 hook：渲染时现查 + 上/下线事件驱动重渲染——懒扩展物化时序竞争
 *  （aiti-models-import 物化可能晚于 filler/卡片首渲染，无监听则探测定格 null 永不出现）。 */
function useImportServiceReady(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const off = onExtServiceChange((k) => { if (k === "aiti-models-import.open") force((v) => v + 1); });
    return () => { try { off?.(); } catch { /* ignore */ } };
  }, []);
  return modelsImportService() !== null;
}

/** 从其他 Agent 导入模型配置（aiti-models-import 的 ImportDialog，零重实现）。 */
function openModelsImport(): void {
  try { modelsImportService()?.open(); } catch { /* ignore */ }
}

/** lucide settings-2 风格齿轮（配置模型动作 chip；不引图库，内联同款线图）。 */
function GearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M20 7h-9" />
      <path d="M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </svg>
  );
}

/** kbd 胶囊（mono 紧凑，快捷键语义）。 */
const kbdStyle: Record<string, unknown> = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
  border: "1px solid var(--border, #3a3a3a)", borderRadius: 6, padding: "1px 5px",
  fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 10,
  color: "var(--text, #ddd)", background: "var(--bg-hover, #232323)", lineHeight: 1.6,
};

/** 快捷操作卡（w8 全宽，与快速上手同行宽——2026-11-07 用户拍板）：kbd 胶囊 + 描述行式；
 *  桌面 4 列 ×2 行（8 项）、手机 2 列（8 行过长）。与 guide 步骤行同节奏。 */
export function ShortcutsWidget(props: { cwd?: string | null; isMobile?: boolean; area?: string }) {
  const isMobile = props.isMobile === true;
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>{t("qs.shortcutsTitle")}</div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4, minmax(0, 1fr))", gap: "3px 12px", alignContent: "center" }}>
        {SHORTCUT_KEYS.map((key) => {
          const { kbd, desc } = splitKbdHint(t(key));
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <kbd style={kbdStyle}>{kbd}</kbd>
              <span style={{ fontSize: 10.5, color: "var(--text-muted, #999)", lineHeight: 1.45, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{desc}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── 任务运行时概念卡（streaming widget）：图标/配色复刻宿主 ChatInput 流式按钮区——
 *   卡片即按钮图例（用户在欢迎页看到的图标 = 运行中真实按钮的样子）。 */

/** 与宿主流式按钮同款 fg 色（ChatInput.tsx StreamingActionButton 同值）。 */
const RT_COLOR = {
  fork: "rgba(37,99,235,1)",
  sideChat: "rgba(37,99,235,0.9)",
  steer: "rgba(180,130,0,1)",
  followUp: "rgba(99,102,241,1)",
  continue: "rgba(5,150,105,1)",
} as const;

/** 新会话（宿主 ForkNewIcon 同款路径）。 */
function RtForkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </svg>
  );
}

/** 侧聊（宿主流式按钮区同款气泡+）。 */
function RtSideChatIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M21 12a8 8 0 0 1-8 8H5.5a2 2 0 0 1-1.4-3.4A8 8 0 1 1 21 12z" />
      <path d="M13 8.5v7M9.5 12h7" />
    </svg>
  );
}

/** 插队（宿主流式按钮区同款箭头）。 */
function RtSteerIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M5 1 L9 5 L5 9" />
      <line x1="1" y1="5" x2="9" y2="5" />
    </svg>
  );
}

/** 排队（宿主流式按钮区同款双箭头流）。 */
function RtFollowUpIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <line x1="2" y1="1.5" x2="8" y2="1.5" />
      <path d="M2 1.5 L2 2.5 L5 5 L2 7.5 L2 8.5" />
      <path d="M8 1.5 L8 2.5 L5 5 L8 7.5 L8 8.5" />
      <line x1="2" y1="8.5" x2="8" y2="8.5" />
    </svg>
  );
}

/** 继续（宿主 Continue 按钮同款双 V）。 */
function RtContinueIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polyline points="1.5 2.5 5.5 6 1.5 9.5" />
      <polyline points="6.5 2.5 10.5 6 6.5 9.5" />
    </svg>
  );
}

/** 运行时行（key/descKey 见 quickstart-logic RUNTIME_ROWS；行序 = 流式按钮出现序 + 继续）。 */
const RUNTIME_ROW_META: Record<string, { color: string; Icon: (p: { size?: number }) => unknown }> = {
  "qs.rt.fork": { color: RT_COLOR.fork, Icon: RtForkIcon },
  "qs.rt.sideChat": { color: RT_COLOR.sideChat, Icon: RtSideChatIcon },
  "qs.rt.steer": { color: RT_COLOR.steer, Icon: RtSteerIcon },
  "qs.rt.followUp": { color: RT_COLOR.followUp, Icon: RtFollowUpIcon },
  "qs.rt.continue": { color: RT_COLOR.continue, Icon: RtContinueIcon },
};

/** 任务运行时卡（top，w8，p15）：排队/插队/侧聊/fork/继续概念行——图标与配色与
 *  宿主流式按钮一致；桌面 3 列 ×2 行（5 项）、手机 1 列。 */
export function RuntimeWidget(props: { isMobile?: boolean; area?: string }) {
  const isMobile = props.isMobile === true;
  return (
    <div style={cardStyle}>
      <div style={titleStyle}>{t("qs.rt.title")}</div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: "3px 16px", alignContent: "center" }}>
        {RUNTIME_ROWS.map((row) => {
          const meta = RUNTIME_ROW_META[row.key];
          const Icon = meta.Icon;
          return (
            <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
              <span style={{ color: meta.color, display: "inline-flex", flexShrink: 0 }}><Icon size={12} /></span>
              <span style={{ fontSize: 11, fontWeight: 600, color: meta.color, flexShrink: 0 }}>{t(row.key)}</span>
              <span style={{ fontSize: 10.5, color: "var(--text-muted, #999)", lineHeight: 1.45, minWidth: 0 }}>{t(row.descKey)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 示例提示词卡（bottom，w8 h1）：chip 点击写入 composer 并聚焦。
 *  pi-web.composer 是字段访问式 { get(name), names() } 服务（ChatInput composerUiRef 契约）。 */
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
    case "streaming": return <RuntimeWidget {...(props as any)} />;
    case "examples": return <ExamplesWidget {...(props as any)} />;
    default: return null;
  }
}

/* ── 主区 fresh 首屏（宿主 noWorkspaceGuide 插槽；替代「开始使用」装饰占位） ── */

/** 全新首屏引导（无 cwd 无会话）：标题 + 三大按钮（获取工作区/配置模型/从 Agent 导入）
 *  + ①②③ 步骤。无 cwd 态 widget 区不存在（宿主占位无 composer），本组件即 fresh 首屏主体。 */
export function FreshGuidePage(props: { isMobile?: boolean }) {
  const isMobile = props.isMobile === true;
  const vitals = useVitals(null);
  const importReady = useImportServiceReady();
  const recents = useRecentRoots();
  const bigBtn = (icon: unknown, label: string, hint: string, onClick: () => void, key: string, accent = false) => (
    <button key={key} type="button"
      style={{
        display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6,
        flex: isMobile ? undefined : 1, minWidth: isMobile ? undefined : 160,
        padding: "12px 14px", border: `1px solid var(--border, #3a3a3a)`, borderRadius: 12,
        background: accent ? "var(--bg-hover, #232323)" : "none",
        color: "var(--text, #ddd)", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
        transition: "border-color 0.12s, background 0.12s",
      }}
      onClick={onClick}
      onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #2563eb)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border, #3a3a3a)"; }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 600 }}>
        {icon}{label}
      </span>
      <span style={{ fontSize: 11, color: "var(--text-dim, #888)", lineHeight: 1.5 }}>{hint}</span>
    </button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "8px 4px", fontFamily: "inherit" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20, fontWeight: 600, color: "var(--text, #ddd)" }}>
          <RocketIcon size={22} />{t("qs.start.title")}
        </div>
        <div style={{ fontSize: 13, color: "var(--text-muted, #999)" }}>{t("qs.start.subtitle")}</div>
      </div>
      <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 10 }}>
        {bigBtn(<FolderPlusIcon size={16} />, t("qs.start.acquire"), t("qs.start.acquireHint"), openWorkspaceHub, "hub", true)}
        {bigBtn(<GearIcon />, t("qs.start.configureModel"), vitals.modelsOk && vitals.modelCount > 0 ? t("qs.start.modelOk") : t("qs.start.modelMissing"), openModelConfig, "model")}
        {importReady ? bigBtn(<ImportIcon size={16} />, t("qs.start.importModels"), t("qs.start.importModelsHint"), openModelsImport, "import") : null}
      </div>
      {recents.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontSize: 11, color: "var(--text-dim, #888)" }}>{t("qs.start.recent")}</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {recents.map((r) => (
              <button key={r.root} type="button" title={r.root} style={chipBase}
                onClick={() => { try { extSvc<{ setCwd: (p: string) => void }>("pi-web.newSession")?.setCwd?.(r.root); } catch { /* ignore */ } }}
                onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #2563eb)"; e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
                onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border, #3a3a3a)"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
                {r.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {[t("qs.start.step.workspace"), t("qs.start.step.model"), t("qs.start.step.msg")].map((label, i) => (
          <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-muted, #999)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 999, fontSize: 11, fontWeight: 600, color: "var(--accent, #2563eb)", border: "1px solid var(--accent, #2563eb)" }}>{i + 1}</span>
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── 侧栏空白引导卡（DockStack filler v2） ── */

const FILLER_STEP_KEYS = ["qs.filler.step1", "qs.filler.step2", "qs.filler.step3"] as const;

/** 全折叠空白引导卡 v2：无 cwd 态 =「获取工作区 + 配置模型」两按钮流；
 *  有 cwd → 原 3 步 + 打开快速上手页。✕ 关闭持久化，关闭后返回 null = 回退现状。 */
export function QuickstartFiller() {
  const [dismissed, setDismissed] = useState(() => readSidebarDismissed());
  const vitals = useVitals(null);
  const importReady = useImportServiceReady();
  if (dismissed) return null;

  const noWorkspace = !vitals.ready
    ? false
    : deriveOnboardingState({ cwd: vitals.cwd, recentRootCount: vitals.recentRootCount, modelCount: vitals.modelCount }) === "fresh";

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
      {noWorkspace ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button type="button" style={primaryBtn} onClick={openWorkspaceHub}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected, #2a2a2a)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; }}>
            <FolderPlusIcon size={12} />{t("qs.open.hub")}
          </button>
          <button type="button" style={chipBase} onClick={openModelConfig}
            onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #2563eb)"; e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border, #3a3a3a)"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
            {t("qs.start.configureModel")}
          </button>
          {importReady ? (
            <button type="button" style={chipBase} onClick={openModelsImport} title={t("qs.start.importModelsTitle")}
              onMouseEnter={(e: any) => { e.currentTarget.style.borderColor = "var(--accent, #2563eb)"; e.currentTarget.style.color = "var(--accent, #2563eb)"; }}
              onMouseLeave={(e: any) => { e.currentTarget.style.borderColor = "var(--border, #3a3a3a)"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
              <ImportIcon />
              <span>{t("qs.start.importModels")}</span>
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {FILLER_STEP_KEYS.map((key, i) => (
              <div key={key} style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-dim, #888)", flexShrink: 0 }}>{i + 1}.</span>
                <span style={{ fontSize: 12, color: "var(--text-muted, #999)", lineHeight: 1.6, minWidth: 0 }}>{t(key)}</span>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => { void openQuickstart(); }} style={primaryBtn}
            onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-selected, #2a2a2a)"; }}
            onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; }}>
            <RocketIcon size={12} />{t("qs.filler.open")}
          </button>
        </>
      )}
    </div>
  );
}

/* ── Workspace 下拉动作区入口（workspacePickerActions 注册条目） ── */

/** WorkspacePickerActionsProps（宿主 lib/ext/types.ts:506-520）：extra 数据只读；点击开 Hub。 */
export function WorkspacePickerAcquireEntry() {
  return (
    <button type="button" title={t("qs.open.hub")} onClick={openWorkspaceHub}
      style={{
        display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "5px 8px",
        background: "none", border: "none", borderRadius: 7, cursor: "pointer",
        color: "var(--text-muted, #999)", fontSize: 12, fontFamily: "inherit",
        transition: "background 0.12s, color 0.12s",
      }}
      onMouseEnter={(e: any) => { e.currentTarget.style.background = "var(--bg-hover, #232323)"; e.currentTarget.style.color = "var(--text, #ddd)"; }}
      onMouseLeave={(e: any) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted, #999)"; }}>
      <FolderPlusIcon size={13} />
      <span>{t("qs.open.hub")}</span>
    </button>
  );
}
