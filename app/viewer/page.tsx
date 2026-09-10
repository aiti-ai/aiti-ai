"use client";

/**
 * /viewer —— 独立文件查看窗口（薄组合页，零业务逻辑）。
 *
 * 「在新窗口打开」的落地页：一个只含文件查看器的浏览器窗口，无侧栏/顶栏/聊天区。
 * 打开方式：opener 先 window.open("/viewer") 开空白窗，子窗 ready 后 postMessage 交接目标
 * （aiti-viewer 握手协议）；目标持久化在 sessionStorage——刷新可恢复，且路径不落 URL/
 * 浏览器历史/隧道代理 access log。
 *
 * 复用主界面同一条渲染链：<ExtSlotsProvider> 加载扩展 client → aiti-editor /
 * aiti-folder 经 fileViewer slot 接管 <FileViewer>——独立窗口与主面板视图 100% 同源。
 *
 * 与主面板同款的文件名 tab 结构：复用核心 TabBar + file-tab-state 纯函数
 * （openFileTab/openFolderTab/saveFileViewerState）。文件夹树里点文件/子目录
 * 开成 tab（已开则激活），‹› 深度遍历、每 tab 查看状态恢复等行为与主面板一致。
 */

import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExtSlotsProvider, ensureExtSlotMaterialized } from "@/components/ExtSlots";
import { FileViewer } from "@/components/FileViewer";
import { TabBar, type Tab } from "@/components/TabBar";
import { openFileTab, openFolderTab, saveFileViewerState } from "@/components/file-tab-state";
import { I18nProvider, useI18n } from "@/hooks/useI18n";
import { withBasePath } from "@/lib/base-path";
import { registerHostApi } from "@/lib/ext/host-api";
import { getExtUiItems, subscribeExtUi, hasExtRender } from "@/lib/ext-ui-store";

type ViewerTarget = { path: string; kind: "file" | "folder"; cwd?: string; /** 显式换根（如「打开文件夹」）：强制把 cwd 切到目标目录 */ setRoot?: boolean };

/** pathPicker 槽稳定空快照（SSR/未注册时不接管；getServerSnapshot 必须返回缓存引用）。 */
const PATH_PICKER_NO_ITEMS: import("@/lib/ext-ui-store").ExtUiItemRegistered[] = [];

// 独立 viewer 窗口标志（模块层设置，早于 ExtSlotsProvider 加载任何扩展 client 的
// register/sendReady）：
//   1) 扩展 composer 动作（@ 提及 / @到新session / 选区 AI）走 postMessage 回 opener
//      （forwardComposerToOpener），不在本窗内找聊天面；
//   2) host-protocol 豁免：本窗虽带 opener，但不是 AI 弹窗——不向 opener 发
//      dbg_ai_ready/元信息心跳，否则主面板 launcher 的孤儿弹窗清理会把本窗口直接
//      close 掉（新窗口秒关）。
if (typeof window !== "undefined") {
  (window as unknown as { __aitiViewerStandalone?: boolean }).__aitiViewerStandalone = true;
}

function lastSeg(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function parentDir(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : s;
}

// 目标持久化（sessionStorage，按标签页隔离）：替代旧「参数进地址栏」方案——
// 路径不落 URL/历史/日志，刷新仍可恢复。
const VIEWER_TARGET_KEY = "aiti-viewer-target";

function readStoredTarget(): ViewerTarget | null {
  try {
    const raw = sessionStorage.getItem(VIEWER_TARGET_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as ViewerTarget;
    if (!t || typeof t.path !== "string" || !t.path) return null;
    return { path: t.path, kind: t.kind === "folder" ? "folder" : "file", cwd: t.cwd || undefined };
  } catch { return null; }
}

function persistTarget(target: { path: string; kind?: string; cwd?: string }): void {
  try {
    sessionStorage.setItem(VIEWER_TARGET_KEY, JSON.stringify({
      path: target.path,
      kind: target.kind === "folder" ? "folder" : "file",
      cwd: target.cwd,
    }));
  } catch { /* noop */ }
}

// —— 独立窗口 composer 请求转发（aiti-viewer 协议复用）——
// 本窗口无聊天面（composer/会话），扩展的 @ 提及 / @到新session / 选区 AI 等动作经
// postMessage 回 opener（主面板）执行。消息形状：
//   { source: "aiti-viewer", type: "composer", action: "append" | "newSession" | "steer", text, cwd? }
// 接收端在主面板 AppShell（origin 校验 + source/type 门）。无 opener（复制链接新开）时返回 false，
// 调用方自行提示。
// 注意：不可 export——Next page 文件只允许 default/特定字段导出，额外导出会让生产 build 的类型检查失败。
function forwardComposerToOpener(action: string, text: string, cwd?: string): boolean {
  try {
    const opener = window.opener as Window | null;
    if (!opener || opener.closed) return false;
    opener.postMessage({ source: "aiti-viewer", type: "composer", action, text, cwd }, window.location.origin);
    return true;
  } catch { return false; }
}

export default function ViewerPage() {
  return (
    <Suspense fallback={<div style={{ height: "100dvh" }} />}>
      <I18nProvider>
        <ExtSlotsProvider>
          <ViewerBody />
        </ExtSlotsProvider>
      </I18nProvider>
    </Suspense>
  );
}

function ViewerBody() {
  const { t } = useI18n();

  // 初始 tabs 恒为空（hydration 首帧必须与服务端 HTML 一致）：sessionStorage 是客户端可变
  // 数据，在 useState 初始化器里读取会让「刷新恢复」场景的 hydration 渲染长出 tab（服务端
  // 渲染的是空态）→ React hydration mismatch。恢复挪到 mount 后 effect，语义不变。
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // 启动期：sessionStorage 恢复 / opener 握手兑票尚未落定。SSR 与 hydration 首帧都渲染
  // 中性 loading（两端一致，无 mismatch）；落定后切内容或空态——避免等待期闪现误导性的
  // 「No file open」空态（2026-09-10：刷新恢复必经此态，观感像丢了文件）。
  const [booted, setBooted] = useState(false);
  // 工作目录（深度遍历根 / git 徽标）：存储 cwd 优先；开文件夹 tab 时补齐
  const [cwd, setCwd] = useState<string | undefined>(undefined);

  // —— sessionStorage 恢复（刷新场景；mount 后一次，先于握手 effect 声明）——
  // 有存储目标时握手 effect 会因 readStoredTarget() 命中而跳过，二者不叠加。
  useEffect(() => {
    const init = readStoredTarget();
    if (!init) return;
    const restored = init.kind === "folder"
      ? openFolderTab([], { folderName: lastSeg(init.path), folderPath: init.path, tabId: `folder:${init.path}` })
      : openFileTab([], { fileName: lastSeg(init.path), filePath: init.path, sourceSessionId: null, tabId: `file:${init.path}` });
    setTabs(restored);
    setActiveTabId(restored[0]?.id ?? null);
    if (init.cwd) setCwd(init.cwd);
    setBooted(true);
  }, []);

  const activeTab = tabs.find((tb) => tb.id === activeTabId) ?? null;
  // 兜底遍历根：URL 未带 cwd 时，文件用其父目录、文件夹用自身（‹ › 深度遍历 / git 徽标可用）
  const effCwd = cwd
    ?? (activeTab ? (activeTab.kind === "folder" ? activeTab.filePath : parentDir(activeTab.filePath)) : undefined);
  // 「打开文件夹」能力（aiti-folder 扩展的 FolderSwitcher，与主界面文件区同构）：选任意目录开成 tab。
  const pathPickerItems = useSyncExternalStore(
    subscribeExtUi,
    () => getExtUiItems("pathPicker"),
    () => PATH_PICKER_NO_ITEMS,
  );
  // render 可选化（toolbar 声明式条目）后统一收窄：只消费带 render 的 pathPicker 项
  const pathPicker = pathPickerItems.find(hasExtRender) ?? null;
  // [懒加载 v2] viewer 页打开 = 交互时刻——声明 pathPicker 的懒扩展（folder）一次性物化；
  // 未到位时兜底按钮在，物化后 store bump → FolderSwitcher 接管生效。
  useEffect(() => {
    void ensureExtSlotMaterialized("pathPicker");
  }, []);

  // —— 宿主原语最新态 ref（registerHostApi 是模块级单例，闭包不能过期）——
  const stateRef = useRef({ tabs, activeTabId, cwd: effCwd });
  stateRef.current = { tabs, activeTabId, cwd: effCwd };
  const openTargetRef = useRef<(target: ViewerTarget, push: boolean, select?: boolean) => void>(() => {});

  // 注册宿主公共接口（AppShell 同款）：扩展经 ctx.openFile/openFolder/getFileTabs/
  // closeFileTabs 调用的能力全部接到本窗口的 tab 状态——aiti-editor 的 ‹› 深度遍历、
  // 压缩包内文件打开、重命名后跳转等都依赖这些原语。
  useEffect(() => {
    registerHostApi({
      openFile: (filePath, _fileName, options) => {
        const select = options?.select !== false;
        // 后台打开（select:false）不入历史栈——地址栏始终跟随激活 tab
        openTargetRef.current({ path: filePath, kind: "file", cwd: stateRef.current.cwd }, select, select);
      },
      openFolder: (folderPath, _folderName, options) => {
        const select = options?.select !== false;
        // 第三参必须显式传 select：openTarget 的 select 形参缺省 true，漏传会变回
        // 「文件夹恢复恒激活」——session 恢复的 workspace folder 抢走焦点（openFile 同型）
        openTargetRef.current({ path: folderPath, kind: "folder", cwd: stateRef.current.cwd }, select, select);
      },
      // 本窗口无聊天输入框：@ 提及的写入动作转发给 opener（主面板）的 composer
      appendText: (text) => { forwardComposerToOpener("append", text); },
      getFileTabs: () => stateRef.current.tabs.map((tb) => ({ id: tb.id, filePath: tb.filePath, kind: (tb.kind === "terminal" ? "file" : tb.kind) ?? "file", pinned: tb.pinned })),
      closeFileTabs: (ids) => {
        setTabs((prev) => {
          const next = prev.filter((tb) => !ids.includes(tb.id));
          setActiveTabId((cur) => {
            if (!ids.includes(cur ?? "")) return cur;
            if (next.length === 0) return null;
            // 激活位重排：取被关集合中序号最小的存活邻居（主面板同款语义）
            const firstClosed = Math.min(...ids.map((id) => prev.findIndex((tb) => tb.id === id)).filter((i) => i >= 0));
            return next[Math.min(firstClosed, next.length - 1)].id;
          });
          return next;
        });
      },
    });
  }, []);

  // —— 导航原语：开文件/文件夹 tab；push=是否写入历史；select=false 只加 tab 不激活 —— //
  const openTarget = useCallback((target: ViewerTarget, push: boolean, select = true) => {
    const navCwd = target.cwd ?? (target.kind === "folder" ? target.path : undefined);
    if (navCwd && (!target.cwd || target.setRoot)) setCwd(navCwd);
    const tabId = target.kind === "folder" ? `folder:${target.path}` : `file:${target.path}`;
    setTabs((prev) => (
      target.kind === "folder"
        ? openFolderTab(prev, { folderName: lastSeg(target.path), folderPath: target.path, tabId })
        : openFileTab(prev, { fileName: lastSeg(target.path), filePath: target.path, sourceSessionId: null, tabId })
    ));
    if (select) setActiveTabId(tabId);
    // 持久化到 sessionStorage（替代旧 pushState/replaceState 地址栏同步）——刷新可恢复，路径不进 URL
    if (push || select) persistTarget({ ...target, cwd: navCwd });
  }, []);
  openTargetRef.current = openTarget;

  // —— aiti-viewer 握手（子窗拉取式）：加载后向 opener 发 ready 拿 ticket，再自行兑付目标 ——
  // 票据里才有路径，postMessage 只传不透明 token；刷新恢复走 sessionStorage，不再找 opener 重拉。
  useEffect(() => {
    if (readStoredTarget()) return; // 刷新恢复场景：已有目标，跳过握手（booting 由恢复 effect 落定）
    const opener = window.opener as Window | null;
    if (!opener || opener.closed) { setBooted(true); return; } // 直开无上下文：直接进空态
    let dead = false;
    const finish = () => { if (!dead) setBooted(true); };
    const onMsg = async (ev: MessageEvent) => {
      if (ev.origin !== location.origin || ev.source !== window.opener) return;
      const d = ev.data as { source?: string; type?: string; ticket?: string } | null;
      if (!d || d.source !== "aiti-viewer" || d.type !== "init" || typeof d.ticket !== "string" || !d.ticket) return;
      window.removeEventListener("message", onMsg);
      try {
        const r = await fetch(withBasePath("/api/files/ticket"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: d.ticket }),
        });
        const data = await r.json() as { path?: string; kind?: string; cwd?: string | null };
        if (!dead && r.ok && data?.path) {
          openTargetRef.current({ path: data.path, kind: data.kind === "folder" ? "folder" : "file", cwd: data.cwd || undefined }, true);
        }
      } catch { /* opener 已关/网络失败 */ }
      finish(); // 无论兑付成败，启动期结束（失败落空态）
    };
    window.addEventListener("message", onMsg);
    try { opener.postMessage({ source: "aiti-viewer", type: "ready" }, location.origin); } catch { finish(); }
    // 兜底死线：opener 在但永不回复（旧标签/异常态）时不至于永远停在 loading——一次性
    // 定时器（非轮询）3s 后自动落定空态，回复晚到仍会正常开文件。
    const deadline = window.setTimeout(finish, 3000);
    return () => { dead = true; window.clearTimeout(deadline); window.removeEventListener("message", onMsg); };
  }, []);

  // 窗口标题跟随当前 tab
  useEffect(() => {
    document.title = activeTab ? `${activeTab.label} · Pi Web` : "Pi Web";
  }, [activeTab]);

  const handleSelectTab = useCallback((id: string) => {
    setActiveTabId(id);
    const tb = tabs.find((x) => x.id === id);
    if (tb) persistTarget({ path: tb.filePath, kind: tb.kind, cwd });
  }, [tabs, cwd]);

  const handleClose = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const next = prev.filter((x) => x.id !== id);
      setActiveTabId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        return next[Math.min(idx, next.length - 1)].id;
      });
      return next;
    });
  }, []);

  if (!booted) {
    // 启动期：中性 loading 占位（SSR 同形；恢复/兑票落定后切内容或空态）
    return (
      <div
        role="status"
        aria-label={t("sidebar.loading")}
        style={{ height: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}
      >
        <span
          style={{
            width: 18, height: 18, borderRadius: "50%",
            border: "2px solid var(--border)", borderTopColor: "var(--accent)",
            animation: "spin 0.8s linear infinite",
          }}
        />
      </div>
    );
  }

  if (!tabs.length || !activeTab) {
    // 全部 tab 已关闭（或确无上下文）：居中空态 + 「打开文件夹」入口（复用 pathPicker 槽）
    return (
      <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          <span style={{ color: "var(--text-dim)", fontSize: 13 }}>{t("files.noneOpen")}</span>
          {pathPicker ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {pathPicker.render({
                path: "",
                compact: true,
                onSelect: (p: string) => openTarget({ path: p, kind: "folder", setRoot: true }, true),
              })}
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {t("viewer.openFolderHint")}
              </span>
            </div>
          ) : null}
          <a href={withBasePath("/")} style={{ fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
            {t("viewer.backToApp")}
          </a>
        </div>
      </div>
    );
  }

  const iconBtn = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 26, height: 24, padding: 0,
    background: "transparent", border: "none", borderRadius: 4,
    color: "var(--text-dim)", cursor: "pointer", fontSize: 14,
    textDecoration: "none", flexShrink: 0,
  } as const;

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
      {/* 文件 tab 行：返回 · 刷新 · tabs · 打开文件夹 */}
      <div style={{ display: "flex", alignItems: "stretch", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "0 2px 0 6px" }}>
          <a href={withBasePath("/")} title={t("viewer.backToApp")} aria-label={t("viewer.backToApp")} style={iconBtn}>←</a>
          <button type="button" onClick={() => window.location.reload()} title={t("viewer.reload")} aria-label={t("viewer.reload")} style={iconBtn}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <TabBar
            tabs={tabs}
            activeTabId={activeTab.id}
            onSelectTab={handleSelectTab}
            onCloseTab={handleClose}
          />
        </div>
        {pathPicker
          ? pathPicker.render({
              path: effCwd ?? "",
              compact: true,
              onSelect: (p: string) => openTarget({ path: p, kind: "folder", setRoot: true }, true),
            })
          : null}
      </div>

      {/* 当前 tab 的查看器（与主面板同构：仅挂载激活项，状态随 revision 恢复） */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {activeTab.kind === "folder" ? (
          <FileViewer
            key={activeTab.id}
            kind="folder"
            filePath={activeTab.filePath}
            cwd={effCwd}
            watchEnabled
            onOpenFile={(p) => openTarget({ path: p, kind: "file", cwd: effCwd }, true)}
            onOpenFolder={(p) => openTarget({ path: p, kind: "folder", cwd: effCwd }, true)}
          />
        ) : (
          <FileViewer
            key={`${activeTab.id}:${activeTab.viewerRevision ?? 0}`}
            filePath={activeTab.filePath}
            cwd={effCwd}
            sourceSessionId={activeTab.sourceSessionId ?? null}
            initialDisplayMode={activeTab.initialDisplayMode}
            initialState={activeTab.viewerState}
            watchEnabled
            onStateChange={(vs) => setTabs((prev) => saveFileViewerState(prev, activeTab.id, activeTab.viewerRevision ?? 0, vs))}
            onOpenFile={(p) => openTarget({ path: p, kind: "file", cwd: effCwd }, true)}
            onOpenFolder={(p) => openTarget({ path: p, kind: "folder", cwd: effCwd }, true)}
          />
        )}
      </div>
      {/* 底部状态栏：当前路径 */}
      <div style={{ display: "flex", alignItems: "center", height: 22, padding: "0 10px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--text-dim)" }} title={activeTab.filePath}>
          {activeTab.filePath}
        </span>
      </div>
    </div>
  );
}
