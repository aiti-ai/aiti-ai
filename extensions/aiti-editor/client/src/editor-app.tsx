/**
 * aiti-editor · 接管主组件（fileViewer slot）—— JSX 版（自手写 h() 版迁移，功能一比一）。
 *
 * M1：文本文件接管（Monaco 编辑 + 保存 + 冲突检测）
 * M2：Markdown 双模式（编辑/预览 tab + Ctrl+B/I） + 注册表开放（window.__aitiEditor）
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { apiUrl, editorBase, ensureEditorTicket, ticketedEditorPath, extSvc } from "./host-shim";
import { getCtx, editorRefHolder } from "./env";
import { ENCODINGS, encDisplay, formatSize, mdSlug, sourceLinesForText, isDarkTheme, describeMonacoError } from "./lib";
import { detectLanguage, mdFenceDescriptors } from "./registry";
import { markdownPreviewHtml, markdownRenderHtml } from "./markdown";
import { previewKindOf, defaultViewModeOf, previewModeItems } from "./preview";
import { getPopover, previewClickInfo, closePreviewPopover, mdSmartEnabled } from "./md-smart";
import { openViewerWindow } from "../../../_shared/open-viewer-window";
import { openNewSessionWithExtSvc } from "../../../_shared/new-session-cwd";
import { uiConfirm, uiPrompt } from "../../../_shared/ui-dialogs";
import { ImageViewer } from "./image-viewer";
import { HtmlPreviewPane } from "./html-preview";
import { FileToolbar, type MenuAction, MiFileText, MiPin, MiChevronL, MiChevronR } from "./file-toolbar";
import { MoveToDialog } from "./move-dialog";
import { ThirdPartyProviderHost } from "./provider-host";
import {
  loadMonaco, loadContribution, registerSiblingLibs,
  setupCsvDecorations, setupModelDiagnostics, applyLanguageServices, formatTable, detectTable,
  ensureMonacoExtras,
} from "./monaco-setup";

const api = (p: string, init?: RequestInit) => ticketedEditorPath(p).then((pp) => fetch(editorBase() + pp, { cache: "no-store", ...init }));

// 实时徽标脉冲动画（注入一次）
if (typeof document !== "undefined" && !document.getElementById("aiti-live-pulse-style")) {
  const st = document.createElement("style");
  st.id = "aiti-live-pulse-style";
  st.textContent = "@keyframes aitiLivePulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.8); } }";
  document.head.appendChild(st);
}

/** 媒体时长格式化：秒 → m:ss / h:mm:ss（非法/未知返回空串） */
function fmtMediaDuration(s: number): string {
  if (typeof s !== "number" || !isFinite(s) || s < 0) return "";
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export function EditorApp(props: Record<string, any>) {
  const filePath = props.filePath;
  const cwd = props.cwd;
  const sourceSessionId = props.sourceSessionId;
  // dock face 态（file-dock.tsx 三面渲染；方案 docs/file-dock-face-plan.md）：
  // onFaceClose = FileToolbar「关闭」自我重路由 + 容量逐出跳过 + 钉住项隐藏的开关。
  const faceMode = typeof props.onFaceClose === "function";

  const containerRef = useRef<any>(null);
  const previewRef = useRef<any>(null);
  const previewWrapRef = useRef<any>(null);
  const lastSelSrcRef = useRef<string>("monaco"); // @ 提及：选区来源（monaco / preview）
  const lastSelLocRef = useRef<any>(null);   // 预览选区来源行区间 {start,end}（mouseup 时捕获，避免点击 @ 时丢失）
  const lastSelTextRef = useRef("");         // 预览选区文本（mouseup 时捕获，同上）
  const [status, setStatus] = useState<{ phase: string; error: any }>({ phase: "loading", error: null });

  // ── 多编辑器仲裁（M0）：命中队列 + 当前生效 provider；带 render 的第三方 → 接管渲染。
  //    重渲染触发源：provider/偏好/能力变化（onActiveProviderChange，含跨 tab 广播）
  //    + 晚到注册（aiti-editor:registry-ready 事件）。零轮询。 ──
  const [arbTick, setArbTick] = useState(0);
  useEffect(() => {
    const we = (window as any).__aitiEditor;
    if (!we?.onActiveProviderChange) return;
    const un = we.onActiveProviderChange(() => setArbTick((t: number) => t + 1));
    const onReady = () => setArbTick((t: number) => t + 1);
    window.addEventListener("aiti-editor:registry-ready", onReady);
    return () => { un(); window.removeEventListener("aiti-editor:registry-ready", onReady); };
  }, []);
  const arbChain: any[] = useMemo(() => {
    void arbTick; // 订阅翻转 tick 驱动重算
    const we = (window as any).__aitiEditor;
    return (we?._resolveProviders?.(filePath) || []) as any[];
  }, [filePath, arbTick]);
  const activeProvider = useMemo(() => {
    const we = (window as any).__aitiEditor;
    return (we?.getActiveProvider?.(filePath) || arbChain[0] || null) as any;
  }, [filePath, arbChain]);
  // 第三方渲染 provider（内建 provider 无 render → 走原有分支零回归）
  const thirdParty = activeProvider && typeof (activeProvider as any).render === "function" ? activeProvider : null;
  // 「关于编辑器」数据源：当前生效 provider 的 about 元数据
  const aboutProp = useMemo(() => {
    const p: any = activeProvider;
    if (!p) return undefined;
    return { name: p.displayName || p.id, id: p.id, source: p.sourceExt, ...(p.about || {}) };
  }, [activeProvider]);
  const thirdPartyRef = useRef<any>(null);
  thirdPartyRef.current = thirdParty; // 渲染期同步（loadContent 等闭包内读取，避免依赖锿变）

  const [monacoErr, setMonacoErr] = useState<string | null>(null); // Monaco 加载失败（可重试）
  const [monacoRetry, setMonacoRetry] = useState(0); // 点重试 +1 → 重新触发 mount effect
  const [meta, setMeta] = useState<any>(null);
  const [openEncoding, setOpenEncoding] = useState("auto"); // 以指定编码重新打开
  const [showEnc, setShowEnc] = useState(false); // 编码菜单
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<any>(null);
  // 瞬时反馈（@ 提及等）走 toast：自动消失、不占标题栏
  const [toast, setToast] = useState<any>(null);
  const toastTimerRef = useRef<any>(null);
  const showToast = useCallback((kind: string, text: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ kind, text });
    toastTimerRef.current = setTimeout(() => { toastTimerRef.current = null; setToast(null); }, 2400);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);
  // 编辑内容变化 → 防抖重算 git 变更行标注/大纲（大文件跳过实时重算，仅关键节点重算）
  // （声明在组件前部：Monaco mount effect 的 deps 引用它，必须早于该 effect 声明）
  const [chgTick, setChgTick] = useState(0);
  const chgTimerRef = useRef<any>(null);
  const bumpChg = useCallback(() => {
    if (chgTimerRef.current) clearTimeout(chgTimerRef.current);
    chgTimerRef.current = setTimeout(() => { chgTimerRef.current = null; setChgTick((t) => t + 1); }, 400);
  }, []);
  useEffect(() => () => { if (chgTimerRef.current) clearTimeout(chgTimerRef.current); }, []);
  // 视图模式：有预览面的文件（markdown/html）默认「预览」，其余默认「编辑」（判据见 ./preview.ts）
  //   （用户切换后在本 tab 内保持，换文件再按新文件默认重置）
  const [viewMode, setViewMode] = useState<string>(() => defaultViewModeOf(filePath, detectLanguage(filePath)));
  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  // 同 tab 内切换文件（‹ › 导航 / 重开另一文件）→ 按新文件类型重置默认模式（首挂载值相同，setState bail-out 无额外渲染）
  useEffect(() => { setViewMode(defaultViewModeOf(filePath, detectLanguage(filePath))); }, [filePath]);
  const [previewTick, setPreviewTick] = useState(0);
  const previewDebounceRef = useRef<any>(null);
  const previewTickRef = useRef(0);
  const bumpPreview = useCallback(() => {
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    previewDebounceRef.current = setTimeout(() => {
      previewTickRef.current += 1;
      setPreviewTick(previewTickRef.current);
    }, 300); // debounce 300ms
  }, []);
  const editorRef = useRef<any>(null);
  const baseMtimeRef = useRef<any>(null);
  const initialContentRef = useRef<any>(null);   // 打开时内容，dirty 判定基准

  const language = meta ? meta.language : detectLanguage(filePath);
  const fileType = (window as any).__aitiEditor._detectFileType(filePath);
  const isBinaryView = fileType !== "text";

  // ── 媒体实时监听（视频/音频）：/watch SSE 事件驱动，文件变化 → 换缓存指纹重载 ──
  //   场景：agent 流式写媒体文件时，预览自动跟随增长（对齐核心 VideoViewer 的 watch 能力）
  const [mediaBust, setMediaBust] = useState(0);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const isMediaFile = fileType === "video" || fileType === "audio";
  // 路径票据：媒体/下载等同步拼 URL 的场景先换票（路径不进 URL，安全基线）
  const [pathTicket, setPathTicket] = useState<string | null>(null);
  const [watchLive, setWatchLive] = useState(false); // ed-watch 帧订阅中（实时同步徽标）
  // 媒体加载失败自动恢复：连接池饥饿/瞬时空响应/票据过期（1h 闲置或扩展 reload 失效）时
  // 强制换新票据重试（上限 3 次，换到新票即复位——成功与否由下一次加载结果判定）
  const mediaErrRef = useRef(0);
  const recoverMedia = () => {
    if (mediaErrRef.current >= 3) return false;
    mediaErrRef.current += 1;
    setPathTicket(null);
    ensureEditorTicket(filePath, undefined, true).then((t) => { mediaErrRef.current = 0; setPathTicket(t); }).catch(() => { /* noop */ });
    return true; // 已接手自愈，调用方不进失败态
  };
  useEffect(() => {
    setPathTicket(null);
    let alive = true;
    ensureEditorTicket(filePath).then((t) => { if (alive) setPathTicket(t); }).catch(() => { /* 签发失败：各端点自行报错 */ });
    return () => { alive = false; };
  }, [filePath]);
  // watch 走 pi-web 页面事件流（globalThis.__piPageEvents 广播的 ed-watch 帧，帧带
  // 随机 watchId，浏览器按 id 过滤；路径/句柄不进 URL）。仅播放中启用（连接池保护）；
  // 页面事件流客户端缺席（core 过旧）→ 静态预览降级。
  useEffect(() => {
    setMediaBust(0);
    setMediaDuration(null);
    if (!isMediaFile || props.watchEnabled === false) return; // 总线共享连接，不占额外 socket——媒体打开期间常开
    let dead = false;
    let unsub: (() => void) | null = null;
    let watchId: string | null = null;
    const stop = () => { if (watchId) { void fetch(editorBase() + "/watch-stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ watchId }) }).catch(() => {}); watchId = null; } };
    const open = async () => {
      try {
        // 事件总线 topics 唯一（2026-09-09 拍板）：白名单 ed-watch；禁止任何兑底（全帧/core route 均已删）。
        // topics 服务缺席（event-bus 未启用）→ watch 不可用，静态预览（现有降级语义不变）。
        const client = (() => {
          const topicsSvc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
          return topicsSvc ? { subscribePageFrames: (h: (f: any) => void) => topicsSvc(h, ["ed-watch"]).off } : null;
        })();
        if (!client?.subscribePageFrames) return; // 无总线 → 静态预览降级
        const res = await fetch(editorBase() + "/ticket", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ filePath, wantWatch: true }),
        }).then((r) => r.json());
        if (dead) return;
        watchId = res.watchId || null;
        if (!watchId) return;
        unsub = client.subscribePageFrames((frame: any) => {
          if (dead || frame.type !== "ed-watch" || frame.id !== watchId) return;
          setMediaBust((v: number) => v + 1);
        });
        setWatchLive(true);
      } catch { /* 静默降级为静态预览 */ }
    };
    open();
    return () => { dead = true; setWatchLive(false); stop(); try { unsub?.(); } catch { /* noop */ } };
  }, [filePath, isMediaFile, props.watchEnabled]);
  const isMarkdown = language === "markdown";
  // 预览面能力判定（方案 §3.1）：`isMarkdown` 此后只管 markdown 专属功能（md-smart 弹层、TOC
  // 滚动同步、表格格式化、导出 HTML/PDF），预览壳/分栏/模式切换器一律看 canPreview
  const previewKind = previewKindOf(filePath, language);
  const canPreview = previewKind !== null;
  // 压缩文件状态（顶层声明，遵守 Hooks 规则）
  const [archiveFiles, setArchiveFiles] = useState<any>(null);
  const [archiveErr, setArchiveErr] = useState<string | null>(null);
  useEffect(() => {
    if (fileType !== "archive") return;
    api("/archive?filePath=" + encodeURIComponent(filePath))
      .then((r) => r.json())
      .then((d) => { if (d.ok) setArchiveFiles(d.files); else setArchiveErr(d.error || "解析失败"); })
      .catch((e) => setArchiveErr(String(e)));
  }, [filePath, fileType]);

  // ── 同目录文件遍历（‹ ›）：服务端深度遍历（DFS、按名排序），仅文件不含文件夹 ──
  // 遍历根：优先项目根 cwd（子树走到头自然接上父级的下一个子树，不会卡在叶节点）；
  // 文件不在清单（如位于 node_modules 等被排除目录）时按路径序找插入点，prev/next 仍可用
  const siblingsRootOf = useCallback((fp: string) => {
    try {
      if (typeof cwd === "string" && cwd) {
        const root = cwd.replace(/[\\/]+$/, "");
        if (root && (fp === root || fp.startsWith(root + "/"))) return root;
      }
    } catch {}
    return fp.slice(0, fp.lastIndexOf("/")) || "/";
  }, [cwd]);
  const [siblings, setSiblings] = useState<string[] | null>(null);
  const siblingsCacheRef = useRef<Map<string, string[]>>(new Map()); // 按遍历根缓存清单，切 tab 不重复拉
  useEffect(() => {
    const root = siblingsRootOf(filePath);
    const hit = siblingsCacheRef.current.get(root);
    if (hit) setSiblings(hit);
    let cancelled = false;
    api("/siblings?filePath=" + encodeURIComponent(filePath), { method: "POST", body: JSON.stringify({ root }) })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d && d.ok && Array.isArray(d.files)) {
          siblingsCacheRef.current.set(d.dir || root, d.files);
          setSiblings(d.files);
        }
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [filePath, siblingsRootOf]);
  const sibIndex = siblings ? siblings.indexOf(filePath) : -1;
  // 不在清单内 → 路径序插入点（next=插入位首个、prev=插入位前一个）
  let navIndex = sibIndex;
  if (navIndex < 0 && siblings && siblings.length > 0) {
    let lo = 0, hi = siblings.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (siblings[mid] < filePath) lo = mid + 1; else hi = mid; }
    navIndex = lo;
  }
  // 容量控制：文件 tab 数（含即将新开的 extra 个）超 MAX 时，逐出最老 且 未钉住 且 未修改 的文件
  // （定义在 stepSibling/stepImage 之前，二者依赖它做逐出）
  const MAX_FILE_TABS = 5;
  const applyTabCap = useCallback((extra = 1) => {
    if (faceMode) return; // dock face 不占宿主 tab 容量，也不得为 face 逐出宿主 tab
    const ctx = getCtx();
    if (!ctx || typeof ctx.getFileTabs !== "function" || typeof ctx.closeFileTabs !== "function") return;
    const tabs = ctx.getFileTabs() || [];
    const fileTabs = tabs.filter((t: any) => t.kind !== "folder");
    if (fileTabs.length + extra <= MAX_FILE_TABS) return;
    const we = window as any;
    const toClose: string[] = [];
    for (const t of tabs) {
      if (t.kind === "folder") continue;
      if (we.__aitiEditor?.isTabPinned?.(t.filePath)) continue;
      if (we.__aitiEditor?.isFileDirty?.(t.filePath)) continue;
      toClose.push(t.id);
      if (fileTabs.length - toClose.length + extra <= MAX_FILE_TABS) break;
    }
    if (toClose.length) ctx.closeFileTabs(toClose);
  }, []);
  const stepSibling = useCallback((delta: number) => {
    if (!siblings || siblings.length === 0 || navIndex < 0) return;
    const n = siblings.length;
    const nextPath = siblings[((navIndex + delta) % n + n) % n];
    const ctx = getCtx();
    const tabs = (ctx && typeof ctx.getFileTabs === "function") ? (ctx.getFileTabs() || []) : [];
    const wasOpen = tabs.some((t: any) => t.filePath === nextPath); // 重访已开文件不触发逐出
    try { ctx?.openFile?.(nextPath, undefined, { select: true }); } catch {}
    if (!wasOpen) applyTabCap(); // 新开文件后做容量控制（FIFO 逐出未修改/未钉住）
  }, [siblings, navIndex, applyTabCap]);
  // 图片预览前后翻：仅在图片文件间导航（过滤 siblings 里的非图片）
  const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico|tiff?)$/i;
  const imgSiblings = siblings ? siblings.filter((p) => IMG_RE.test(p)) : null;
  const imgIndex = imgSiblings ? imgSiblings.indexOf(filePath) : -1;
  const stepImage = useCallback((delta: number) => {
    if (!imgSiblings || imgSiblings.length <= 1 || imgIndex < 0) return;
    const n = imgSiblings.length;
    const nextPath = imgSiblings[((imgIndex + delta) % n + n) % n];
    const ctx = getCtx();
    const tabs = (ctx && typeof ctx.getFileTabs === "function") ? (ctx.getFileTabs() || []) : [];
    const wasOpen = tabs.some((t: any) => t.filePath === nextPath);
    try { ctx?.openFile?.(nextPath, undefined, { select: true }); } catch {}
    if (!wasOpen) applyTabCap();
  }, [imgSiblings, imgIndex, applyTabCap]);

  const loadContent = useCallback(() => {
    // 第三方渲染 provider 接管：内容读取/缓存链由 provider 自理（EditorHost.readFile），
    // 不走文本 /raw + 编辑缓存链（docx/xlsx 等二进制进文本链只会产生乱码/报错）
    if (thirdPartyRef.current) { setStatus({ phase: "ready", error: null }); return; }
    setStatus({ phase: "loading", error: null });
    // 二进制可渲染（图片/视频/音频/PDF）：不按文本解码，交给原生 viewer 展示
    const _binType = (window as any).__aitiEditor._detectFileType(filePath);
    if (_binType !== "text") {
      setMeta({ language: _binType, size: 0 });
      api("/stat?filePath=" + encodeURIComponent(filePath))
        .then((r) => r.json())
        .then((m) => { if (m && m.ok) setMeta((prev: any) => ({ ...(prev || {}), size: m.size, mtimeMs: m.mtimeMs })); })
        .catch(() => {});
      setStatus({ phase: "ready", error: null });
      return;
    }
    const cache = (window as any).__aitiEditor._cacheGet(filePath) || null;
    // 有缓存（内存或服务端）：直接用缓存继续编辑；否则从磁盘读
    if (cache) {
      // 异步从服务端拉取（如果服务端有更新版本，覆盖内存缓存）
      (window as any).__aitiEditor._cacheFetchFromServer(filePath).then((srv: any) => {
        if (srv && srv.baseMtimeMs > cache.baseMtimeMs) {
          const ed = editorRef.current;
          if (ed) { ed.setValue(srv.content); }
          const ec = (window as any).__aitiEditor._cacheGet(filePath);
          if (ec) { ec.content = srv.content; ec.original = srv.original; ec.baseMtimeMs = srv.baseMtimeMs; }
          initialContentRef.current = srv.original;
          setDirty(srv.content !== srv.original);
          (window as any).__aitiEditor._setDirty(filePath, srv.content !== srv.original);
        }
      }).catch(() => {});

      setMeta({ language: cache.language || language, size: cache.size || 0, content: cache.content, encoding: cache.encoding || "utf-8", hasBOM: cache.hasBOM === true });
      initialContentRef.current = cache.original; // dirty 基线 = 离开前保存点
      setStatus({ phase: "ready", error: null });
      setDirty(cache.content !== cache.original);
      (window as any).__aitiEditor._setDirty(filePath, cache.content !== cache.original);
      // 磁盘变更检测：mtime 变了 → 静默三路合并（original vs local vs disk）
      api("/stat?filePath=" + encodeURIComponent(filePath), { method: "GET" })
        .then((r) => r.json())
        .then((m) => {
          if (m && m.ok && typeof m.mtimeMs === "number") {
            baseMtimeRef.current = m.mtimeMs;
            if (Math.abs(m.mtimeMs - cache.baseMtimeMs) > 1) {
              // 磁盘变了，静默合并
              const original = cache.original || "";
              const local = editorRef.current ? editorRef.current.getValue() : (cache.content || "");
              if (!original || !local || original === local) {
                // 无本地编辑：直接加载磁盘版
                const encU = meta && meta.encoding ? "&encoding=" + encodeURIComponent(meta.encoding) : "";
                api("/raw?filePath=" + encodeURIComponent(filePath) + encU).then((r) => r.json()).then((d) => {
                  if (d.error) { setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: m.size }); return; }
                  const content = d.content || "";
                  const ed = editorRef.current;
                  if (ed) ed.setValue(content);
                  initialContentRef.current = content;
                  const c = (window as any).__aitiEditor._cacheGet(filePath);
                  if (c) { c.content = content; c.original = content; c.baseMtimeMs = m.mtimeMs; }
                  setDirty(false); (window as any).__aitiEditor._setDirty(filePath, false);
                }).catch(() => setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: m.size }));
              } else {
                // 有本地编辑：三路合并
                const encU = meta && meta.encoding ? "&encoding=" + encodeURIComponent(meta.encoding) : "";
                api("/raw?filePath=" + encodeURIComponent(filePath) + encU).then((r) => r.json()).then(async (d) => {
                  if (d.error) { setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: m.size }); return; }
                  const disk = d.content || "";
                  try {
                    const dmp = await (window as any).__aitiEditor.loadDmp();
                    const patches = dmp.patch_make(original, local);
                    const [merged, results] = dmp.patch_apply(patches, disk);
                    const failCount = Array.isArray(results) ? results.filter(Boolean).length : 0;
                    if (failCount === 0) {
                      // 合并成功，静默应用
                      const ed = editorRef.current;
                      if (ed) ed.setValue(merged);
                      initialContentRef.current = merged;
                      const c = (window as any).__aitiEditor._cacheGet(filePath);
                      if (c) { c.content = merged; c.original = merged; c.baseMtimeMs = m.mtimeMs; }
                      setDirty(false); (window as any).__aitiEditor._setDirty(filePath, false);
                    } else {
                      setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: m.size });
                    }
                  } catch {
                    setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: m.size });
                  }
                }).catch(() => setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: m.size }));
              }
            }
          }
        })
        .catch(() => {});
      return;
    }
    const u = new URLSearchParams({ encoding: openEncoding });
    api("/raw?filePath=" + encodeURIComponent(filePath) + "&" + u.toString())
      .then((r) => r.json())
      .then((d) => {
        if (d.error) { setStatus({ phase: "error", error: d.error }); return; }
        const next = { language: d.language || language, size: d.size || 0, content: d.content || "", encoding: d.encoding || "utf-8", hasBOM: d.hasBOM === true };
        // 先检查服务端缓存（多开恢复）：必须早于 setMeta/setStatus——否则 Monaco create
        // 触发 onDidChangeModelContent 写回原版覆盖服务端编辑
        let _recoveredSrv: any = null;
        (window as any).__aitiEditor._cacheFetchFromServer(filePath, true).then((srv: any) => {
          _recoveredSrv = srv;
          if (srv && srv.contentHash && srv.contentHash !== (window as any).__aitiEditor._hashContent(next.content)) {
            next.content = srv.content;
            next.encoding = srv.encoding || next.encoding;
          }
        }).finally(() => {
          const isRecovered = _recoveredSrv && _recoveredSrv.contentHash && _recoveredSrv.contentHash !== (window as any).__aitiEditor._hashContent(d.content || "");
          const baseline = isRecovered ? (_recoveredSrv.original || _recoveredSrv.content) : next.content;
          initialContentRef.current = baseline;
          setMeta(next);
          setStatus({ phase: "ready", error: null });
          (window as any).__aitiEditor._setDirty(filePath, isRecovered);
          setDirty(isRecovered);
          // 建缓存：恢复时 original=服务端基线（磁盘原版）→ dirty 判定正确
          (window as any).__aitiEditor._cacheSet(filePath, {
            content: next.content, original: baseline,
            baseMtimeMs: Date.now(), language: next.language, size: next.size,
            encoding: next.encoding, hasBOM: next.hasBOM,
          });
          if (isRecovered) {
            setNotice({ kind: "warn", text: "已恢复未保存编辑" });
          }
        });
        api("/stat?filePath=" + encodeURIComponent(filePath), { method: "GET" })
          .then((r) => r.json())
          .then((m) => {
            const mtimeMs = m && m.ok && typeof m.mtimeMs === "number" ? m.mtimeMs : Date.now();
            baseMtimeRef.current = mtimeMs;
            // 缓存已建 → 只更新 baseMtime，不覆盖 content/original
            const ec = (window as any).__aitiEditor._cacheGet(filePath);
            if (ec) { ec.baseMtimeMs = mtimeMs; }
          })
          .catch(() => {});
      })
      .catch((e) => setStatus({ phase: "error", error: String(e) }));
  }, [filePath, sourceSessionId, detectLanguage, language, openEncoding]);

  useEffect(() => {
    loadContent();
    // 记录 session 文件打开（墓碑制：刷新后恢复）
    const _sid = (window as any).__aitiEditor?._sessionId;
    if (_sid) {
      fetch(apiUrl("/api/extensions/aiti-editor") + "/session-files?t=" + Date.now(), {
        method: "POST", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: _sid, filePath, action: "add" }),
      }).catch(() => {});
      // 首次打开文件时，恢复 session 中其他文件（延迟，不阻塞当前文件）
      if (!(window as any).__aitiEditor._sessionRestored) {
        (window as any).__aitiEditor._sessionRestored = true;
        fetch(apiUrl("/api/extensions/aiti-editor") + "/session-files?sessionId=" + encodeURIComponent(_sid) + "&t=" + Date.now(), { cache: "no-store" })
          .then((r) => r.json())
          .then((d) => {
            if (d.ok && d.files && d.files.length > 0) {
              for (let i = 0; i < d.files.length; i++) {
                const entry = d.files[i];
                const p = typeof entry === "string" ? entry : entry?.path;
                const kind = typeof entry === "string" ? "file" : (entry?.kind || "file");
                if (!p || p === filePath) continue;
                setTimeout(() => {
                  try {
                    // 恢复的历史文件/文件夹一律后台打开（select:false）：焦点留给用户
                    // 直接打开的文件——原先 i===0 带 select:true，会在 200ms 后把
                    // active tab 抢到第一个历史文件（独立新窗口/刷新后首开尤其明显）
                    if (kind === "folder") getCtx()?.openFolder?.(p, undefined, { select: false });
                    else getCtx()?.openFile?.(p, undefined, { select: false });
                  } catch {}
                }, 200 + i * 100);
              }
            }
          }).catch(() => {});
      }
    }
    // 启动 auto-save 定时器（每 30s 写 dirty 文件到服务端缓存）
    (window as any).__aitiEditor._startAutoSave();
    return () => {
      (window as any).__aitiEditor._stopAutoSave();
      // 仅「用户真正关闭该 tab」时才从 session 移除（confirmClose 已标记）
      const _sid2 = (window as any).__aitiEditor?._sessionId;
      if (_sid2 && (window as any).__aitiEditor._isSessionRealClose(filePath)) {
        fetch(apiUrl("/api/extensions/aiti-editor") + "/session-files?t=" + Date.now(), {
          method: "POST", cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: _sid2, filePath, action: "remove" }),
        }).catch(() => {});
        delete (window as any).__aitiEditor._sessionRemoveMark[filePath]; // 已标记消费，防残留误删同名文件
      }
    };
  }, [loadContent, sourceSessionId, filePath]);

  // Mount Monaco
  useEffect(() => {
    if (status.phase !== "ready" || !meta || !containerRef.current) return;
    let cancelled = false;
    // 模型语言以客户端注册表推断为准（provider/扩展名表是权威来源）：meta.language 可能被
    // 缓存恢复路径的 language:"text" 或异步竞态污染 → 偶发模型建成 plaintext、
    // CSV 彩虹列/诊断等语言专属功能全部失效。detect 为 plaintext 时才回退 meta.language
    //（兼容服务端独有、客户端未注册的语言）。
    let modelLang = language;
    try {
      const det = detectLanguage(filePath);
      if (det && det !== "plaintext") modelLang = det;
    } catch {}
    loadMonaco().then((monaco: any) => {
      if (cancelled || !containerRef.current) return;
      // 无论 monaco 由谁加载（本链 / git-review 预热快速通道），确保额外语言已注册
      ensureMonacoExtras(monaco);
      // 标记“本 tab 已用过编辑器”：下次 register 直接空闲预热（近零等待），见 entry.tsx warmMonacoOnIdle
      try { sessionStorage.setItem("aiti-editor:opened", "1"); } catch { /* noop */ }
      // 已有编辑器：内容与语言都没变则复用；否则先 dispose 再重建
      const prev = editorRef.current;
      if (prev) {
        try {
          const m = prev.getModel();
          const same = m && m.getLanguageId() === modelLang && m.getValue() === meta.content;
          if (same) {
            editorRefHolder.ref = editorRef;
            return;
          }
          prev.dispose();
          // 显式释放模型（外部 createModel 创建，editor.dispose 不会回收）
          if (m) { try { m.dispose(); } catch {}
          }
        } catch {}
        editorRef.current = null;
      }
      // 防御：清掉容器残留的 Monaco 内部属性
      containerRef.current.removeAttribute?.("data-keybinding-context");
      return loadContribution(language).then(() => {
        // 异步竞态防御①：链发起后依赖又变了（旧链已 cancel）→ 不能再往容器里建编辑器
        if (cancelled || !containerRef.current) return;
        // 同目录兄弟文件注册 extraLib（fire-and-forget 不阻塞渲染）
        if (language === "typescript" || language === "javascript") {
          registerSiblingLibs(monaco, filePath).catch(() => {});
        }
        // 模型带真实扩展名 URI：TS 语言服务依 URI 后缀判定 ScriptKind（.tsx→TSX / .jsx→JSX）。
        // 语言以客户端注册表推断为准（provider/扩展名表是权威来源）：meta.language 可能被
        // 缓存恢复路径的 language:"text" 或异步竞态污染 → 偶发模型建成 plaintext、
        // CSV 彩虹列/诊断等语言专属功能全部失效。detect 为 plaintext 时才回退 meta.language
        //（兼容服务端独有、客户端未注册的语言）。
        // 异步竞态防御②：旧链已被 cancel 但编辑器已挂进容器（editorRef 未指向它）
        // → 孤儿 DOM 自带 data-keybinding-context，本次 create 会抛
        // "Element already has context attribute"。清掉孤儿再建。
        if (!editorRef.current && containerRef.current.firstChild) {
          try { containerRef.current.innerHTML = ""; } catch {}
          containerRef.current.removeAttribute?.("data-keybinding-context");
        }
        const content0 = ((window as any).__aitiEditor._cacheGet(filePath) || {}).content || meta.content;
        let model: any;
        try {
          const uri = /^[a-zA-Z]:[\\/]|\//.test(filePath)
            ? monaco.Uri.file(filePath)
            : monaco.Uri.parse("inmemory://aiti-editor/" + encodeURIComponent(filePath.split("/").pop() || "untitled"));
          model = monaco.editor.createModel(content0, modelLang, uri);
        } catch { model = monaco.editor.createModel(content0, modelLang); }
        // 自愈保险：无论上游哪条异步路径污染了语言，创建后强制对齐推断结果
        //（否则 CSV 彩虹列/YAML 诊断/Markdown 预览等语言专属功能全部失效且难恢复）
        try {
          if (model.getLanguageId() !== modelLang) monaco.editor.setModelLanguage(model, modelLang);
        } catch {}
        const editor = monaco.editor.create(containerRef.current, {
          model,
          theme: document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
          fontSize: 13,
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: modelLang === "markdown" ? "on" : "off", // markdown 自动换行
          automaticLayout: true,
          tabSize: 2,
          readOnly: meta.size > 1024 * 1024,
          renderLineHighlight: "line",
        });
        editor.onDidChangeModelContent(() => {
          const isDirty = editor.getValue() !== initialContentRef.current;
          setDirty(isDirty);
          (window as any).__aitiEditor._setDirty(filePath, isDirty);
          // 编辑内容变化 → 写服务端缓存（不丢）
          const cache = (window as any).__aitiEditor._cacheGet(filePath);
          if (cache) { cache.content = editor.getValue(); (window as any).__aitiEditor._writeServerCache(filePath); }
          bumpPreview();
          if (editor.getValue().length <= 300000) bumpChg(); // 变更行标注/大纲防抖重算（大文件跳过实时）
        });
        // 分栏滚动同步：编辑器滚动 → 预览按比例连续滚动
        let _scrollT: any = null;
        editor.onDidScrollChange(() => {
          if (viewModeRef.current !== "split") return;
          if (Date.now() < scrollLockRef.current) return; // 预览回写防环
          if (_scrollT) clearTimeout(_scrollT);
          _scrollT = setTimeout(() => {
            const ifr = previewRef.current;
            const w = ifr && ifr.contentWindow;
            if (!w || !w.document.scrollingElement) return;
            const sTop = editor.getScrollTop();
            const sH = editor.getScrollHeight();
            const cH = editor.getLayoutInfo().height;
            const pct = sH - cH > 0 ? sTop / (sH - cH) : 0;
            const doc = w.document.scrollingElement;
            const pMax = Math.max(0, doc.scrollHeight - w.innerHeight);
            scrollLockRef.current = Date.now() + 300;
            w.__aitiSuppressScroll = true;
            w.scrollTo(0, pct * pMax);
            setTimeout(() => { w.__aitiSuppressScroll = false; }, 320);
          }, 60);
        });
        editorRef.current = editor;
        editorRefHolder.ref = editorRef; // 同步模块级引用（_getEditor）
        setEditorTick((n) => n + 1); // 新实例 → 触发选区监听 effect 重挂到新编辑器
        // 语言服务桥 + 语言专属功能：按模型【实际】语言门控（而非 meta 推导值）
        const actualLang = model.getLanguageId();
        try { applyLanguageServices(monaco, actualLang, model); } catch {}
        if (actualLang === 'csv') {
          try { setupCsvDecorations(monaco, editor); } catch {}
        }
        if (actualLang === 'yaml' || actualLang === 'toml') {
          try { setupModelDiagnostics(monaco, editor); } catch {}
        }
      });
    }).catch((e: any) => {
      // Monaco 加载失败 → 独立错误态 + 可重试（describeMonacoError 把 AMD loader 的
      // "[object Event]" 类不可读错误转成可读文案，2026-09-25）
      if (!cancelled) setMonacoErr(describeMonacoError(e));
    });
    return () => { cancelled = true; };
  }, [status.phase, meta, language, bumpPreview, bumpChg, monacoRetry]);

  // 文件切换/加载时检查磁盘变更（每次渲染都检查，但防抖 3s）
  const _lastDiskCheckRef = useRef(0);
  useEffect(() => {
    if (status.phase !== "ready" || !meta || !editorRef.current) return;
    const now = Date.now();
    if (now - _lastDiskCheckRef.current < 3000) return;
    _lastDiskCheckRef.current = now;
    api("/stat?filePath=" + encodeURIComponent(filePath), { method: "GET" })
      .then((r) => r.json())
      .then((m) => {
        if (m && m.ok && typeof m.mtimeMs === "number" && baseMtimeRef.current && Math.abs(m.mtimeMs - baseMtimeRef.current) > 1) {
          baseMtimeRef.current = m.mtimeMs;
          const cache = (window as any).__aitiEditor._cacheGet(filePath);
          if (!cache) return;
          const original = cache.original || "";
          const local = editorRef.current ? editorRef.current.getValue() : (cache.content || "");
          if (!original || !local) return;
          if (original === local) {
            // 无本地编辑：直接加载磁盘版
            const encU = meta && meta.encoding ? "&encoding=" + encodeURIComponent(meta.encoding) : "";
            api("/raw?filePath=" + encodeURIComponent(filePath) + encU)
              .then((r) => r.json())
              .then((d) => {
                if (d.error) return;
                const content = d.content || "";
                const ed = editorRef.current;
                if (ed) ed.setValue(content);
                initialContentRef.current = content;
                const c = (window as any).__aitiEditor._cacheGet(filePath);
                if (c) { c.content = content; c.original = content; c.baseMtimeMs = m.mtimeMs; }
                setDirty(false); (window as any).__aitiEditor._setDirty(filePath, false);
              }).catch(() => {});
          } else {
            // 有本地编辑：三路合并
            const encU = meta && meta.encoding ? "&encoding=" + encodeURIComponent(meta.encoding) : "";
            api("/raw?filePath=" + encodeURIComponent(filePath) + encU)
              .then((r) => r.json())
              .then(async (d) => {
                if (d.error) return;
                const disk = d.content || "";
                try {
                  const dmp = await (window as any).__aitiEditor.loadDmp();
                  const patches = dmp.patch_make(original, local);
                  const [merged, results] = dmp.patch_apply(patches, disk);
                  if (Array.isArray(results) && results.filter(Boolean).length === 0) {
                    // 合并成功，静默应用
                    const ed = editorRef.current;
                    if (ed) ed.setValue(merged);
                    initialContentRef.current = merged;
                    const c = (window as any).__aitiEditor._cacheGet(filePath);
                    if (c) { c.content = merged; c.original = merged; c.baseMtimeMs = m.mtimeMs; }
                    setDirty(false); (window as any).__aitiEditor._setDirty(filePath, false);
                  } else {
                    setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: d.size || 0 });
                  }
                } catch {
                  setExtChange({ diskMtimeMs: m.mtimeMs, diskSize: d.size || 0 });
                }
              }).catch(() => {});
          }
        }
      }).catch(() => {});
  });

  // 卸载清理：编辑内容写回缓存（内存+服务端）；「丢弃/保存后关闭」已 block 不重建缓存
  useEffect(() => () => {
    const ed = editorRef.current;
    if (ed) {
      const val = ed.getValue();
      const cache = (window as any).__aitiEditor._cacheGet(filePath);
      if (cache) {
        cache.content = val; // 正常编辑（含切走）：写回，切回继续编辑
      } else if (!(window as any).__aitiEditor._cacheWriteBlockAt(filePath)) {
        // 无缓存且未被丢弃/保存 block：首次进入建缓存
        (window as any).__aitiEditor._cacheSet(filePath, { content: val, original: val, baseMtimeMs: baseMtimeRef.current || Date.now(), language, size: val.length });
      }
      // 确保服务端缓存已写入（刷新页面后恢复）
      const cache2 = (window as any).__aitiEditor._cacheGet(filePath);
      if (cache2 && cache2.content) {
        fetch(apiUrl("/api/extensions/aiti-editor") + "/cache-write?t=" + Date.now(), {
          method: "POST", cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filePath, content: cache2.content, original: cache2.original, baseMtimeMs: cache2.baseMtimeMs }),
        }).catch(() => {});
      }
    }
    const _m = ed && ed.getModel();
    ed?.dispose();
    if (_m) { try { _m.dispose(); } catch {} }
    editorRef.current = null;
  }, []);

  // 自绘关闭问答 + 跨 tab 版本比对
  const [askState, setAskState] = useState<any>(null); // { path, blockers, resolve }
  const [extChange, setExtChange] = useState<any>(null); // 磁盘已修改（切回时检测）
  const askResolveRef = useRef<any>(null);
  const scrollLockRef = useRef(0); // 分栏滚动同步防环锁
  useEffect(() => {
    const A = (window as any).__aitiEditor;
    // 属主注册（keyed by 函数引用）：卸载只删自己——keep-alive 池下激活与逐出分处两个 commit，
    // 单例槽会被「后挂载者注册 → 被逐出者卸载置 null」打穿，脏关闭走 resolve(true) 静默放行
    //（方案 docs/aiti-editor-right-dock-keepalive-plan.md §9.3）
    const askCloseHandler = (path: string, blockers: any, resolve: any) => {
      askResolveRef.current = resolve;
      setAskState({ path, blockers });
    };
    const isVisible = () => !!containerRef.current && !(containerRef.current as any).closest?.("[hidden]");
    A?._setAskCloseHandler(askCloseHandler, { path: filePath, isVisible });
    // 注册跨 tab 版本比对
    const cacheListener = (msg: any) => {
      if (msg.filePath !== filePath) return;
      if (msg.type === 'delete') {
        // 另一窗口关闭时删了缓存 → 本窗口直接写完整内容重建缓存
        const cache = (window as any).__aitiEditor._cacheGet(filePath);
        if (cache && cache.content) {
          (window as any).__aitiEditor._resetServerBaseline(filePath);
          fetch(apiUrl("/api/extensions/aiti-editor") + "/cache-write?t=" + Date.now(), {
            method: "POST", cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              filePath, strategy: "content",
              content: cache.content, original: cache.original || cache.content,
              contentHash: cache.contentHash || "",
              history: cache.history || [],
              baseMtimeMs: cache.baseMtimeMs || 0,
            }),
          }).then(() => {
            if ((window as any).__aitiEditor._bc) {
              (window as any).__aitiEditor._bc.postMessage({
                type: 'update', filePath,
                contentHash: cache.contentHash || "",
                historyHashes: cache.history || [],
              });
            }
          }).catch(() => {});
        }
        return;
      }
      if (msg.type === 'update') {
        const ed = editorRef.current;
        if (!ed) return;
        const myContent = ed.getValue();
        const myHash = (window as any).__aitiEditor._hashContent(myContent);
        if (myHash === msg.contentHash) return; // 已是最新
        if (msg.historyHashes && msg.historyHashes.includes(myHash)) {
          // 无冲突：当前版本是历史版本，直接从服务端拉最新
          (window as any).__aitiEditor._cacheFetchFromServer(filePath, true).then((srv: any) => {
            if (srv && srv.content && srv.content !== myContent) {
              ed.setValue(srv.content);
              const cache = (window as any).__aitiEditor._cacheGet(filePath);
              if (cache) { cache.content = srv.content; cache.contentHash = srv.contentHash; }
              const syncBaseline = srv.original || srv.content;
              initialContentRef.current = syncBaseline;
              const isDirty = srv.content !== syncBaseline;
              setDirty(isDirty);
              (window as any).__aitiEditor._setDirty(filePath, isDirty);
              setNotice({ kind: "warn", text: "\u5DF2\u540C\u6B65\u5230\u6700\u65B0\u7F16\u8F91\u5185\u5BB9" });
            }
          }).catch(() => {});
        } else {
          // 有冲突：提示手动合并
          setNotice({ kind: "warn", text: "\u53E6\u4E00\u4E2A\u7A97\u53E3\u5DF2\u66F4\u65B0\u6587\u4EF6\uFF0C\u8BF7\u624B\u52A8\u5408\u5E76" });
        }
      }
    };
    return () => {
      A?._clearAskCloseHandler(askCloseHandler);
      A._unregisterCacheListener(cacheListener);
    };
  }, [filePath]);
  const closeAsk = (result: boolean) => {
    // 用户确认真正关闭 → 标记：卸载时从 session 移除；取消不标记
    if (result && askState) (window as any).__aitiEditor._markSessionRealClose(askState.path);
    const r = askResolveRef.current; askResolveRef.current = null; setAskState(null); if (r) r(result);
  };

  // ── git 变更视图（工作区 vs HEAD；选项与 aiti-git-review 一致：最新/左右/合并/大纲）──
  // 服务端只做变更探测与基线文本；hunk 清单由 dmp 行级 diff 实时计算——最新视图变更行标注、大纲、
  // 徽标计数共用同一数据源（合并侧 = 当前编辑内容，含未保存编辑）。默认「最新」= 最终版，零打扰。
  const [gitInfo, setGitInfo] = useState<any>(null);   // /git-changes 结果 { changed, status, adds, dels, label }
  const [gitView, setGitView] = useState("latest");    // latest | side | inline | outline（默认最新 = 最终版）
  const [gitBase, setGitBase] = useState<any>(null);   // /git-base 结果 { original } | { error }（有变更即拉）
  const [dmpHunks, setDmpHunks] = useState<any[]>([]); // dmp 行级 diff hunk（标注/大纲/计数共用）
  const gitHunks = dmpHunks; // 大纲 JSX 沿用旧名
  const diffContainerRef = useRef<any>(null);
  const diffEditorRef = useRef<any>(null);
  const diffModelsRef = useRef<any>(null); // { original, modified }
  const [gitTick, setGitTick] = useState(0);           // 事件驱动重探（保存后）
  const refreshGitInfo = useCallback(() => setGitTick((t) => t + 1), []);
  // 窄屏左右并排不可读（左侧只剩行号列，内容 0 宽——实测 398px 窗口）→ 宽度不足时左右退化为合并渲染
  // （git-review 同款策略：小屏默认合并）；监听 resize，拖宽窗口自动恢复并排
  const [wideEnough, setWideEnough] = useState(() => (typeof window !== "undefined" ? window.innerWidth >= 640 : true));
  useEffect(() => {
    const onR = () => setWideEnough(window.innerWidth >= 640);
    window.addEventListener("resize", onR);
    return () => window.removeEventListener("resize", onR);
  }, []);
  const sideEffective = gitView === "side" && wideEnough;
  // 非 repo（gitInfo.isRepo === false）不提供 diff：没有 HEAD 基线可对比
  const gitHasDelta = !!(gitInfo && gitInfo.isRepo !== false && (gitInfo.changed || dirty));
  // 新文件（git 新增/未跟踪，status=A）：相对 HEAD 无基线、整篇即新增——UI 显示「新文件」而非「N 处改动」
  const gitIsNewFile = !!(gitInfo && gitInfo.isRepo !== false && gitInfo.status === "A");
  const gitSwitchShow = !isBinaryView && status.phase === "ready" && gitHasDelta;
  const gitViewActive = gitSwitchShow && gitView !== "latest";
  // 切换文件即重置：每个文件默认以最新（最终版）打开
  useEffect(() => {
    setGitView("latest"); setGitInfo(null); setGitBase(null); setDmpHunks([]);
  }, [filePath]);
  // 变更探测：ready / 保存后（事件驱动，零轮询）
  useEffect(() => {
    if (isBinaryView || status.phase !== "ready") return;
    let cancelled = false;
    api("/git-changes?filePath=" + encodeURIComponent(filePath))
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setGitInfo(d && d.ok ? d : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [filePath, isBinaryView, status.phase, gitTick]);
  // 基线文本：有变更（或含未保存编辑）即拉——最新视图标注与 diff 视图共用（干净文件零传输）
  useEffect(() => {
    if (!gitHasDelta || gitBase) return;
    let cancelled = false;
    api("/git-base?filePath=" + encodeURIComponent(filePath))
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setGitBase(d && d.ok ? d : { error: (d && d.error) || "无法获取 HEAD 基线" }); })
      .catch(() => { if (!cancelled) setGitBase({ error: "网络错误" }); });
    return () => { cancelled = true; };
  }, [gitHasDelta, gitBase, filePath]);
  // hunk 计算：dmp 行级 diff（HEAD 基线 vs 当前编辑内容）——标注/大纲/徽标计数单一数据源
  useEffect(() => {
    if (!gitHasDelta || !gitBase || (gitBase as any).error) { setDmpHunks((h) => (h.length ? [] : h)); return; }
    let cancelled = false;
    (async () => {
      try {
        const dmp = await (window as any).__aitiEditor.loadDmp();
        const cur = editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : "");
        const orig = gitBase.original || "";
        if (orig.length > 600000 || cur.length > 600000) { if (!cancelled) setDmpHunks((h) => (h.length ? [] : h)); return; } // 大文件跳过 dmp 计算（徽标退回 numstat，避免卡 UI）
        // vendored dmp 方法名带下划线后缀（diff_linesToChars_）；兼容无后缀变体
        const toChars = dmp.diff_linesToChars_ || dmp.diff_linesToChars;
        const toLines = dmp.diff_charsToLines_ || dmp.diff_charsToLines;
        const a = toChars.call(dmp, orig, cur);
        const diffs = dmp.diff_main(a.chars1, a.chars2, false);
        toLines.call(dmp, diffs, a.lineArray);
        const lineCount = (t: string) => (t ? (t.match(/\n/g) || []).length + (t.endsWith("\n") ? 0 : 1) : 0);
        let oldLine = 1, newLine = 1;
        const hunks: any[] = [];
        let cur2: any = null;
        for (const [op, text] of diffs as [number, string][]) {
          const n = lineCount(text);
          if (op === 0) {
            if (cur2) { hunks.push(cur2); cur2 = null; }
            oldLine += n; newLine += n;
          } else {
            if (!cur2) cur2 = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, adds: 0, dels: 0, preview: "" };
            if (op === -1) { cur2.oldLines += n; cur2.dels += n; oldLine += n; }
            else {
              cur2.newLines += n; cur2.adds += n; newLine += n;
              if (!cur2.preview) cur2.preview = String(text.split("\n")[0] || "").slice(0, 80);
            }
          }
        }
        if (cur2) hunks.push(cur2);
        if (!cancelled) setDmpHunks(hunks);
      } catch { if (!cancelled) setDmpHunks([]); }
    })();
    return () => { cancelled = true; };
  }, [gitHasDelta, gitBase, chgTick, filePath, meta]);
  // diff 编辑器创建（首次进 diff 视图 / 切文件；gitView/sideEffective 不在 deps——后续切换走 updateOptions）
  useEffect(() => {
    if (!gitViewActive || !gitBase || (gitBase as any).error || !diffContainerRef.current) return;
    let cancelled = false;
    let dEd: any = null, oM: any = null, mM: any = null;
    loadMonaco().then((monaco: any) => {
      if (cancelled || !diffContainerRef.current) return;
      const c = diffContainerRef.current;
      if (c._aitiDiffEd) { try { c._aitiDiffEd.dispose(); } catch { /* 忽略 */ } c._aitiDiffEd = null; }
      c.removeAttribute?.("data-keybinding-context");
      let dl = detectLanguage(filePath);
      if (!dl || dl === "plaintext") dl = language;
      const curText = editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : "");
      try {
        oM = monaco.editor.createModel(gitBase.original || "", dl);
        mM = monaco.editor.createModel(curText, dl);
        dEd = monaco.editor.createDiffEditor(c, {
          renderSideBySide: sideEffective,
          readOnly: true, automaticLayout: true, fontSize: 12.5,
          minimap: { enabled: false }, scrollBeyondLastLine: false,
          theme: document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
        });
        dEd.setModel({ original: oM, modified: mM });
        diffEditorRef.current = dEd;
        diffModelsRef.current = { original: oM, modified: mM };
        c._aitiDiffEd = dEd;
      } catch (e) {
        try { if (oM) oM.dispose(); } catch { /* 忽略 */ }
        try { if (mM) mM.dispose(); } catch { /* 忽略 */ }
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
      try { if (dEd) dEd.dispose(); } catch { /* 忽略 */ }
      try { if (oM) oM.dispose(); } catch { /* 忽略 */ }
      try { if (mM) mM.dispose(); } catch { /* 忽略 */ }
      diffEditorRef.current = null; diffModelsRef.current = null;
      if (diffContainerRef.current) diffContainerRef.current._aitiDiffEd = null;
    };
  }, [gitViewActive, gitBase, filePath]);
  // 视图切换 / 窗口宽度变化：左右 = 并排（窄屏自动退化合并）；合并/大纲 = inline（同一实例 updateOptions，不重建）
  useEffect(() => {
    const dEd = diffEditorRef.current;
    if (dEd) try { dEd.updateOptions({ renderSideBySide: sideEffective }); } catch { /* 忽略 */ }
  }, [gitView, gitViewActive, sideEffective]);
  // 窄屏进左右视图：提示已退化为合并
  useEffect(() => {
    if (gitViewActive && gitView === "side" && !wideEnough) showToast("warn", "窗口太窄，并排不可读，已用合并视图展示（拉宽窗口恢复并排）");
  }, [gitViewActive, gitView, wideEnough]);
  // 重入 diff 视图或 dirty 变化（保存/合并）时刷新合并侧，保证与当前编辑内容一致
  useEffect(() => {
    if (!gitViewActive) return;
    const mM = diffModelsRef.current && diffModelsRef.current.modified;
    const ed = editorRef.current;
    if (mM && ed) try { if (mM.getValue() !== ed.getValue()) mM.setValue(ed.getValue()); } catch { /* 忽略 */ }
  }, [gitViewActive, gitView, dirty]);
  const jumpHunk = (hk: any) => {
    const dEd = diffEditorRef.current;
    if (!dEd) return;
    const med = dEd.getModifiedEditor ? dEd.getModifiedEditor() : dEd;
    try { med.revealLineInCenter(Math.max(1, hk.newStart)); med.setPosition({ lineNumber: Math.max(1, hk.newStart), column: 1 }); } catch { /* 忽略 */ }
  };

  const doSave = useCallback((force?: boolean, onSaved?: () => void, encOverride?: { encoding: string; hasBOM: boolean }) => {
    const editor = editorRef.current;
    if (!editor) return;
    setSaving(true);
    setNotice(null);
    // 保存前若有格式化器则自动格式化（format-on-save）
    const formatPromise = (window as any).monaco && !force
      ? editor.getAction("editor.action.formatDocument")?.run()?.then(() => {}) || Promise.resolve()
      : Promise.resolve();
    formatPromise.then(() => {
      const enc = encOverride || (meta ? { encoding: meta.encoding, hasBOM: meta.hasBOM === true } : { encoding: "utf-8", hasBOM: false });
      const body = {
        filePath, cwd: cwd || undefined, content: editor.getValue(),
        baseMtimeMs: force ? undefined : baseMtimeRef.current ?? undefined,
        encoding: enc.encoding || "utf-8",
        hasBOM: enc.hasBOM === true,
      };
      api("/save", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (r.status === 409 && d.conflict) {
            if (await uiConfirm({ message: "文件已被外部修改，用当前内容覆盖磁盘版本？", danger: true })) return doSave(true);
            setNotice({ kind: "warn", text: "\u5DF2\u53D6\u6D88\u8986\u76D6\uFF0C\u6587\u4EF6\u4FDD\u6301\u672A\u4FDD\u5B58" });
            return;
          }
          if (!r.ok) { setNotice({ kind: "err", text: d.error || "\u4FDD\u5B58\u5931\u8D25 (" + r.status + ")" }); return; }
          baseMtimeRef.current = d.mtimeMs;
          if (encOverride) {
            const c2 = (window as any).__aitiEditor._cacheGet(filePath);
            if (c2) { c2.encoding = encOverride.encoding; c2.hasBOM = encOverride.hasBOM === true; }
            setMeta((m: any) => (m ? { ...m, encoding: encOverride.encoding, hasBOM: encOverride.hasBOM === true } : m));
          }
          setDirty(false);
          (window as any).__aitiEditor._setDirty(filePath, false);
          initialContentRef.current = editor.getValue(); // 保存即新基线
          (window as any).__aitiEditor._cacheSet(filePath, {
            content: initialContentRef.current, original: initialContentRef.current,
            baseMtimeMs: d.mtimeMs, language, size: initialContentRef.current.length,
          });
          if (typeof onSaved === "function") onSaved();
          refreshGitInfo(); // 磁盘已更新 → 重探 git 变更（保存后可能已与 HEAD 一致，切换器自动消失）
          setNotice({ kind: "ok", text: "\u5DF2\u4FDD\u5B58" });
        })
        .catch((e) => setNotice({ kind: "err", text: String(e) }))
        .finally(() => setSaving(false));
    });
  }, [filePath, cwd]);

  // ⋯ 菜单：保存 / 另存为（文本编辑器）
  const doSaveAsText = useCallback(async () => {
    const editor = editorRef.current;
    if (!editor) return;
    const dir = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
    const name0 = filePath.split("/").pop() || "untitled.txt";
    const suggested = name0.replace(/(\.[^.]*)$/, "") + "-副本" + (name0.match(/\.[^.]*$/)?.[0] || "");
    const input = await uiPrompt({ message: "另存为（输入完整路径或当前目录下的文件名）：", value: dir + "/" + suggested });
    if (!input) return;
    const newPath = input.trim();
    if (!newPath || newPath === filePath) return;
    setSaving(true);
    // 目标已存在 → 确认覆盖（新文件无冲突基线，直接写）
    const encU = meta && meta.encoding ? "&encoding=" + encodeURIComponent(meta.encoding) : "";
    api("/stat?filePath=" + encodeURIComponent(newPath) + encU)
      .then((r) => r.json())
      .then(async (st) => {
        if (st && st.ok) {
          if (!(await uiConfirm({ message: "目标文件已存在：\n" + newPath + "\n覆盖？", danger: true }))) { setSaving(false); return; }
        }
        const enc = meta ? { encoding: meta.encoding, hasBOM: meta.hasBOM === true } : { encoding: "utf-8", hasBOM: false };
        return api("/save", {
          method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
          body: JSON.stringify({ filePath: newPath, content: editor.getValue(), encoding: enc.encoding, hasBOM: enc.hasBOM }),
        }).then(async (r) => {
          const d = await r.json().catch(() => ({} as any));
          if (!r.ok) { setNotice({ kind: "err", text: d.error || "另存失败 (" + r.status + ")" }); return; }
          setNotice({ kind: "ok", text: "已另存为 " + (newPath.split("/").pop() || newPath) });
          try { getCtx()?.openFile?.(newPath); } catch { /* 打开失败静默 */ }
        });
      })
      .catch((e) => setNotice({ kind: "err", text: String(e) }))
      .finally(() => setSaving(false));
  }, [filePath, meta]);

  // Ctrl+S save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && editorRef.current) {
        e.preventDefault();
        doSave(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doSave]);

  // Ctrl+B/I markdown editing shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMarkdown || !editorRef.current) return;
      const isCtrl = e.metaKey || e.ctrlKey;
      if (!isCtrl || (e.key.toLowerCase() !== "b" && e.key.toLowerCase() !== "i")) return;
      const editor = editorRef.current;
      const sel = editor.getSelection();
      if (!sel || sel.isEmpty()) return;
      const model = editor.getModel();
      if (!model) return;
      e.preventDefault();
      const txt = model.getValueInRange(sel);
      const wrap = e.key.toLowerCase() === "b" ? ["**", "**"] : ["*", "*"];
      const wrapped = wrap[0] + txt + wrap[1];
      editor.executeEdits("md-format", [{ range: sel, text: wrapped }]);
      editor.setSelection({
        startLineNumber: sel.startLineNumber, startColumn: sel.startColumn,
        endLineNumber: sel.startLineNumber, endColumn: sel.startColumn + wrapped.length,
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMarkdown]);

  // Markdown list continuation on Enter
  useEffect(() => {
    if (!isMarkdown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const editor = editorRef.current;
      if (!editor || !editor.hasTextFocus()) return;
      const model = editor.getModel();
      if (!model) return;
      const pos = editor.getPosition();
      if (!pos) return;
      const line = model.getLineContent(pos.lineNumber);
      const m = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
      if (!m) return;
      e.preventDefault();
      const prefix = m[0];
      // 空列表项（只剩前缀）→ 结束列表：删除整行内容
      if (line.trim().length <= prefix.trim().length) {
        editor.executeEdits("md-list", [{
          range: { startLineNumber: pos.lineNumber, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: line.length + 1 },
          text: "",
        }]);
        editor.setPosition({ lineNumber: pos.lineNumber, column: 1 });
      } else {
        // 续新行 + 带前缀
        editor.executeEdits("md-list", [{
          range: { startLineNumber: pos.lineNumber, startColumn: line.length + 1, endLineNumber: pos.lineNumber, endColumn: line.length + 1 },
          text: "\n" + prefix,
        }]);
        editor.setPosition({ lineNumber: pos.lineNumber + 1, column: prefix.length + 1 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMarkdown]);

  // Ctrl+Shift+S 另存为（弹编码菜单）；Alt+Shift+F 表格对齐
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCtrl = e.metaKey || e.ctrlKey;
      if (isCtrl && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setShowEnc(true); // 编码菜单含「以编码保存」区
        return;
      }
      if (!isCtrl && e.altKey && e.shiftKey && e.key.toLowerCase() === "f") {
        if (editorRef.current && isMarkdown) { e.preventDefault(); formatTable(editorRef.current); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMarkdown]);
    // 预览内 git 变更块高亮（markdown）：dmpHunks → 源码行区间传给预览 iframe（memo 稳定引用防 iframe 反复重载）
  const mdChgRanges = useMemo(() => dmpHunks
    .filter((h: any) => h.newLines > 0)
    .map((h: any) => ({ start: h.newStart, end: h.newStart + h.newLines - 1 })), [dmpHunks]);
  const chgGotoRef = useRef(0); // 定位循环游标（无需重渲染）
  const gotoMdChg = useCallback(() => {
    if (!mdChgRanges.length) return;
    chgGotoRef.current += 1;
    try { previewRef.current?.contentWindow?.postMessage({ type: "aiti-editor-chg-goto", idx: chgGotoRef.current - 1 }, "*"); } catch { /* 忽略 */ }
  }, [mdChgRanges]);

useEffect(() => {
    if (previewKind !== "markdown") return;
    const ifr = previewRef.current;
    if (!ifr) return;
    // 重建前先收掉预览里的弹层：srcdoc 重赋值会整体销毁 iframe 文档，弹层/监听随之消失
    // （不显式关 → msg-smart 的 state.opening 残留，下次点同段被判为 toggle 直接关闭）
    closePreviewPopover();
    const content = editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : "");
    const dark = isDarkTheme();
    ifr.srcdoc = markdownPreviewHtml(content, dark, mdChgRanges.length ? mdChgRanges : undefined, mdSmartEnabled(), mdFenceDescriptors(dark));
  }, [viewMode, meta, previewKind, previewTick, mdChgRanges]);

  // 预览滚动消息 → 编辑器联动（分栏双向）
  useEffect(() => {
    if (!isMarkdown || viewMode !== "split") return;
    const onMsg = (e: MessageEvent) => {
      if (!e.data || !e.data.type || !e.data.type.startsWith("aiti-editor-scroll")) return;
      const ifr = previewRef.current;
      if (!ifr || !ifr.contentWindow || e.source !== ifr.contentWindow) return;
      const ed = editorRef.current;
      if (!ed) return;
      if (e.data.type === "aiti-editor-scroll-pct" && typeof e.data.pct === "number") {
        const sH = ed.getScrollHeight();
        const cH = ed.getLayoutInfo().height;
        scrollLockRef.current = Date.now() + 300;
        ed.setScrollTop(e.data.pct * Math.max(0, sH - cH));
        return;
      }
      if (e.data.type === "aiti-editor-scroll" && e.data.anchor) {
        // TOC/标题锚点点击：精确跳到对应源码行
        const model = ed.getModel();
        if (!model) return;
        for (let l = 1; l <= model.getLineCount(); l++) {
          const m = model.getLineContent(l).match(/^(#{1,6})\s+(.+)/);
          if (m && mdSlug(m[2].trim()) === e.data.anchor) {
            ed.revealLineInCenter(Math.max(l, 1));
            return;
          }
        }
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [isMarkdown, viewMode]);

  // 预览 iframe 内交互 → 标记 @ 选区来源为 preview，并缓存选区文本/来源行区间
  // （后续 buildMentionRef 用缓存值：点击 @ 时 iframe 已失焦，getSelection() 常为空）
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data && e.data.type === "aiti-editor-preview-sel"
          && e.source === (previewRef.current && previewRef.current.contentWindow)) {
        lastSelSrcRef.current = "preview";
        lastSelLocRef.current = (e.data && e.data.loc) || null;
        lastSelTextRef.current = (e.data && e.data.text) || "";
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // 预览内点击语义块/代码行 → 交 aiti-msg-smart 弹层引擎（弹层渲染在 iframe 内，见 md-smart.ts）
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      const ifr = previewRef.current;
      if (!d || d.type !== "aiti-editor-preview-click") return;
      if (!ifr || !ifr.contentWindow || e.source !== ifr.contentWindow) return;
      const api = getPopover();
      if (!api) return; // msg-smart 未装/禁用 → 静默降级，预览照常
      const info = previewClickInfo(d, {
        doc: ifr.contentDocument,
        win: ifr.contentWindow,
        filePath,
      });
      if (info) api.open(info);
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [filePath]);

  // 离开预览/卸载时收掉弹层（视图切换后 iframe 不在，残留 state 会让下次点击被判 toggle）
  useEffect(() => () => { closePreviewPopover(); }, []);
  useEffect(() => {
    if (!(isMarkdown && (viewMode === "preview" || viewMode === "split"))) closePreviewPopover();
  }, [isMarkdown, viewMode]);

  // 显式撑满 preview iframe（CSS 环境兜底）
  useEffect(() => {
    const fit = () => {
      const wrap = previewWrapRef.current;
      const ifr = previewRef.current;
      if (!wrap || !ifr) return;
      const r = wrap.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { ifr.style.width = r.width + "px"; ifr.style.height = r.height + "px"; }
    };
    fit();
    window.addEventListener("resize", fit);
    let ro: any = null;
    if (typeof ResizeObserver !== "undefined" && previewWrapRef.current) {
      ro = new ResizeObserver(fit); ro.observe(previewWrapRef.current);
    }
    return () => { window.removeEventListener("resize", fit); if (ro) ro.disconnect(); };
  }, [viewMode, isMarkdown, previewTick]);

  // 模式切换后强制 Monaco resize（含 diff 视图退出后编辑器重排）
  useEffect(() => { editorRef.current?.layout(); }, [viewMode, canPreview, gitViewActive]);

  // ── AI Inline 编辑：选区跟踪 + 浮动弹窗 ──
  const [aiPop, setAiPop] = useState<any>(null);
  const [selText, setSelText] = useState("");
  const [editorTick, setEditorTick] = useState(0); // 编辑器实例版本（重建后重挂选区监听）

  // 最新视图变更行标注（VSCode 风格）：绿色行号槽条 + 浅底色 + 概览标尺；
  // diff 视图期间编辑器隐藏不画（切回最新自动恢复）。依赖 editorTick：编辑器重建后重挂
  const chgCollRef = useRef<any>(null); // { ed, coll }
  useEffect(() => {
    if (document.getElementById("aiti-editor-chg-css")) return;
    const s = document.createElement("style");
    s.id = "aiti-editor-chg-css";
    s.textContent = ".aiti-ed-chg-bar{background:var(--ok, #22c55e);width:3px!important;border-radius:2px;margin-left:3px;}"
      + ".aiti-ed-chg-line{background:rgba(34,197,94,.08)!important;}";
    document.head.appendChild(s);
  }, []);
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || typeof ed.createDecorationsCollection !== "function") return;
    const deco: any[] = [];
    if (gitHasDelta && !gitViewActive) {
      const model = ed.getModel();
      const max = model ? model.getLineCount() : 0;
      for (const hk of dmpHunks) {
        const start = Math.max(1, hk.newStart);
        const end = Math.min(max, hk.newStart + Math.max(0, hk.newLines - 1));
        if (end < start) continue; // 纯删除块（新侧无行）不标
        deco.push({
          range: { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: "aiti-ed-chg-line",
            linesDecorationsClassName: "aiti-ed-chg-bar",
            overviewRuler: { color: "rgba(34,197,94,0.7)", position: ((window as any).monaco && (window as any).monaco.editor && (window as any).monaco.editor.OverviewRulerLane.Full) || 7 },
          },
        });
      }
    }
    // 编辑器重建（切文件/重挂）后旧 collection 失效 → 重建
    if (!chgCollRef.current || chgCollRef.current.ed !== ed) {
      chgCollRef.current = { ed, coll: ed.createDecorationsCollection() };
    }
    chgCollRef.current.coll.set(deco);
  }, [dmpHunks, gitHasDelta, gitViewActive, editorTick]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const dispose = editor.onDidChangeCursorSelection((e: any) => {
      lastSelSrcRef.current = "monaco";
      const sel = e.selection;
      if (!sel || sel.isEmpty()) { setAiPop(null); setSelText(""); return; }
      const model = editor.getModel();
      if (!model) return;
      const txt = model.getValueInRange(sel);
      if (!txt || txt.length > 8000) { setAiPop(null); setSelText(""); return; }
      setSelText(txt);
      // 计算弹窗位置（基于编辑器可视区域）
      const pos = editor.getScrolledVisiblePosition({ lineNumber: sel.startLineNumber, column: sel.startColumn });
      if (pos) setAiPop({ top: Math.max(0, pos.top - 36), left: pos.left });
    });
    return () => dispose.dispose();
  }, [status.phase, editorTick]);

  const lineNum = editorRef.current?.getSelection()?.startLineNumber;
  // 独立 viewer 窗口（__aitiViewerStandalone，viewer 页打标）：本窗无聊天面，composer 类动作
  // postMessage 回 opener（主面板 AppShell 接收端）执行。无 opener（复制链接新开）返回 false。
  const forwardComposer = (action: string, text: string): boolean => {
    try {
      if (!(window as any).__aitiViewerStandalone) return false;
      const opener = window.opener as Window | null;
      if (!opener || opener.closed) return false;
      opener.postMessage({ source: "aiti-viewer", type: "composer", action, text, cwd }, location.origin);
      return true;
    } catch { return false; }
  };
  // 写 pending composer 预填文本并切新建会话页（宿主 ChatInput 挂载后消费插入，不自动发送）；
  // cwd 缺省回退到文件所在目录，保证新建会话页有项目上下文；独立窗口则转发回主面板执行
  // 不随便切 CWD：目标文件在当前 CWD 或其关注路径（git-trace watchPaths）内 → 保持当前；
  // 只在目标属于别的仓库时才切过去（doc-center 同款判定，见 docs/pi-web-at-new-session-cwd-plan.md；
  // 能力收口 session-manager.mention 服务，缺席降级 _shared 同源实现）
  const sendToNewSession = async (text: string) => {
    if (forwardComposer("newSession", text)) return;
    if ((window as any).__aitiViewerStandalone) {
      showToast("err", "主面板已关闭，无法写入输入框");
      return;
    }
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    await openNewSessionWithExtSvc({ text, targetDir: dir, targetPath: filePath, currentCwd: cwd, apiUrl, extSvc });
  };
  // 立即发送类 AI 动作（解释）：选区组装成代码块 steer 到当前会话；独立窗口转发主面板
  const aiAction = (prompt: string) => {
    if (!selText) return;
    const msg = prompt + "\n```" + language + "\n" + selText + "\n```\nFile: " + filePath + (lineNum ? " line " + lineNum : "");
    if (forwardComposer("steer", msg)) {
      // 独立窗口：转发主面板对当前会话 steer
    } else if ((window as any).__aitiViewerStandalone) {
      showToast("err", "主面板已关闭，无法发送");
    } else {
      getCtx()?.sendChatMessage?.(msg, "steer");
    }
    setAiPop(null);
  };
  // 仅插入不发送类 AI 动作（重构）：prompt+选区写入当前会话输入框，用户自主决定是否发送；
  // 独立窗口转发主面板 append 动作；无输入框能力时退化为剪贴板复制
  const aiInsert = (prompt: string) => {
    if (!selText) return;
    const msg = prompt + "\n```" + language + "\n" + selText + "\n```\nFile: " + filePath + (lineNum ? " line " + lineNum : "");
    if (forwardComposer("append", msg)) {
      // 独立窗口：已转发主面板插入当前输入框
    } else if ((window as any).__aitiViewerStandalone) {
      showToast("err", "主面板已关闭，无法写入输入框");
    } else if (typeof getCtx()?.appendText === "function") {
      getCtx()!.appendText(msg + " ");
      showToast("ok", "已插入输入框，未发送");
    } else {
      navigator.clipboard.writeText(msg).then(() => showToast("ok", "已复制到剪贴板")).catch(() => showToast("err", "写入剪贴板失败"));
    }
    setAiPop(null);
  };

  const isReadOnly = isBinaryView ? true : (meta ? meta.size > 1024 * 1024 : false);

  // Export functions
  const fileName = filePath.split("/").pop() || "export";
  function doExportHtml(): void {
    const content = editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : "");
    if (!content) return;
    markdownRenderHtml(content, isDarkTheme(), fileName).then((html) => {
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = (filePath.split("/").pop() || "export") + ".html";
      a.click(); URL.revokeObjectURL(url);
    }).catch(() => {});
  }
  function doExportPdf(): void {
    const content = editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : "");
    if (!content) return;
    markdownRenderHtml(content, isDarkTheme(), fileName).then((html) => {
      const w = window.open("", "_blank", "width=1000,height=800");
      if (w) {
        w.document.write(html); w.document.close();
        setTimeout(() => { w.focus(); w.print(); }, 600);
      } else {
        // 弹窗被拦截：退化为下载 .html
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = fileName + ".html";
        a.click(); URL.revokeObjectURL(url);
      }
    }).catch(() => {});
  }

  const T: Record<string, any> = {
    bar: { display: "flex", alignItems: "center", gap: 8, padding: "5px 12px",
      borderBottom: "1px solid var(--border,#e0e0e0)", fontSize: 11,
      color: "var(--text-dim,#666)", background: "var(--bg,#fff)", flexShrink: 0 },
    path: { fontFamily: "var(--font-mono, ui-monospace, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    btn: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px",
      border: "1px solid var(--border,#d0d0d0)", borderRadius: 7, cursor: "pointer",
      background: "var(--bg-selected,#eef2ff)", color: "var(--text,#1a1a1a)",
      fontSize: 11, fontWeight: 500, fontFamily: "inherit" },
  };
  T.btnD = { ...T.btn, opacity: 0.5, cursor: "not-allowed", background: "var(--bg,#fff)" };

  // markdown 模式切换：交给 FileToolbar 的 modes（普通宽度内联 tabs，很小屏自动变下拉，见 file-toolbar.tsx）
  // 在独立窗口打开（pi-web /viewer：只含文件查看器的浏览器窗口）。
  // 换票+ready 握手+窗口尺寸全部收敛在 _shared/open-viewer-window（aiti-editor 与 aiti-folder 同用）。
  const openInNewWindow = () => {
    openViewerWindow(apiUrl, { path: filePath, kind: "file", cwd });
  };

  // 文件操作
  const copyPath = () => {
    const text = filePath;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => setNotice({ kind: "ok", text: "已复制路径" })).catch(() => setNotice({ kind: "err", text: "复制失败" }));
    } else {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove(); setNotice({ kind: "ok", text: "已复制路径" });
    }
  };
  // 复制内容（⋯ 菜单项，仅文本视图）：把当前文件全部文本写入剪贴板。
  // 上限 1MB（与服务端 MAX_EDIT_BYTES 同档）：过大的字符串既拖慢页面又易撑爆目标应用，直接拒绝。
  const COPY_CONTENT_LIMIT = 1024 * 1024;
  const copyContent = () => {
    const content = editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : "");
    if (content == null) { setNotice({ kind: "err", text: "内容未加载" }); return; }
    if (content.length > COPY_CONTENT_LIMIT) { setNotice({ kind: "err", text: "内容太大，无法复制（超过 1MB）" }); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(content).then(() => setNotice({ kind: "ok", text: "已复制内容" })).catch(() => setNotice({ kind: "err", text: "复制失败" }));
    } else {
      const ta = document.createElement("textarea"); ta.value = content; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); ta.remove(); setNotice({ kind: "ok", text: "已复制内容" });
    }
  };
  // 打开终端：独立查看窗（无 aiti-cmd 面板）→ postMessage 请主窗口（opener）代开，等回执；
  // 主窗口本地有 __aitiCmd.openShell 直接用（CWD=当前文件父目录）；都没有回退服务端端点。
  const openTerminal = () => {
    const parentDir = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
    const openerWin: any = (window as any).opener;
    if (openerWin && !openerWin.closed) {
      const reqId = "ot-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const onMsg = (ev: MessageEvent) => {
        if (ev.origin !== location.origin || ev.source !== openerWin) return;
        const m: any = ev.data;
        if (!m || m.source !== "aiti-cmd" || m.type !== "open-shell-result" || m.reqId !== reqId) return;
        window.removeEventListener("message", onMsg);
        if (!m.ok) setNotice({ kind: "err", text: m.error || "创建终端失败" });
      };
      window.addEventListener("message", onMsg);
      try {
        openerWin.postMessage({ source: "aiti-ext", type: "open-shell", reqId, cwd: parentDir, name: filePath.split("/").pop() || "bash" }, location.origin);
      } catch (e:any) {
        window.removeEventListener("message", onMsg);
        setNotice({ kind: "err", text: e && e.message ? e.message : String(e) });
        return;
      }
      setTimeout(() => {
        window.removeEventListener("message", onMsg);
        setNotice({ kind: "err", text: "主窗口未响应（aiti-cmd 未启用？）" });
      }, 4000);
      return;
    }
    const bridge = (window as any).__aitiCmd;
    if (bridge && typeof bridge.openShell === "function") {
      bridge.openShell(parentDir, filePath.split("/").pop() || "bash")
        .then((r: any) => { if (!r || !r.ok) setNotice({ kind: "err", text: (r && r.error) || "创建终端失败" }); });
      return;
    }
    fetch(apiUrl("/api/extensions/aiti-folder/open-terminal"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: filePath }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({} as any));
        if (!r.ok || !d.ok) setNotice({ kind: "err", text: d.error || "打开终端失败 (" + r.status + ")" });
      })
      .catch((e) => setNotice({ kind: "err", text: String(e) }));
  };
  const doRename = async () => {
    const oldName = filePath.split("/").pop() || "";
    const newName = await uiPrompt({ message: "输入新文件名", value: oldName });
    if (!newName || newName === oldName) return;
    setSaving(true);
    api("/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filePath, newName }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { setNotice({ kind: "err", text: d.error || "重命名失败" }); return; }
        setNotice({ kind: "ok", text: "已重命名为 " + newName });
        getCtx()?.openFile?.(d.newPath || (filePath.slice(0, filePath.lastIndexOf("/") + 1) + newName), newName);
      })
      .finally(() => setSaving(false));
  };
  // 移动到：弹 MoveToDialog（两级选择 workspace → 目录）；成功后 openFile 打开新路径并提示
  const [moveOpen, setMoveOpen] = useState(false);
  const doMove = () => { setMoveOpen(true); };
  const onMoveDone = (newPath: string) => {
    setMoveOpen(false);
    const name = newPath.split("/").pop() || "";
    setNotice({ kind: "ok", text: "已移动到 " + (filePath.split("/").pop() || "") + " → " + newPath.slice(0, newPath.lastIndexOf("/")) });
    // 打开新路径（新内容由 openFile 重新加载；与重命名行为一致）
    getCtx()?.openFile?.(newPath, name);
  };
  // 在目录打开：打开父目录 folder tab 并派发定位事件
  const openDir = () => {
    const dir = filePath.slice(0, filePath.lastIndexOf("/"));
    getCtx()?.openFolder?.(dir);
    const detail = { root: dir, target: filePath };
    try {
      window.dispatchEvent(new CustomEvent("pi-web:folder-reveal", { detail }));
      (window as any).__piFolderRevealLast = { ...detail, ts: Date.now() };
    } catch { /* 忽略写入失败 */ }
  };
  // 下载文件（同源 file 接口，a[download] 触发）
  const doDownload = () => {
    if (!pathTicket) return; // 票据未就绪（挂载瞬间）；下一帧即可用
    const url = editorBase() + "/t/" + pathTicket + "/file";
    const a = document.createElement("a");
    a.href = url;
    a.download = filePath.split("/").pop() || "download";
    document.body.appendChild(a); a.click(); a.remove();
  };
  // @ 提及：构造 @ 引用串（选中区/预览选区/光标行定位）。
  // 返回 { ref, selOut, clip }：selOut=随引用带走的选中文本（预览态）；clip=需进剪贴板的选中文本（非预览态）
  const buildMentionRef = (): { ref: string; selOut: string; clip: string } => {
    let ref = "";
    let selOut = "";
    let clip = "";
    const ed = editorRef.current;
    // @ 用完整路径（AI 才能定位文件）；basename 仅提示用
    const fp = filePath;
    const inPrev = isMarkdown && (viewMode === "preview" || viewMode === "split");
    const usePreviewSel = inPrev && lastSelSrcRef.current === "preview";
    if (usePreviewSel && previewRef.current && previewRef.current.contentWindow
        && typeof previewRef.current.contentWindow.getSelection === "function") {
      // 选区文本/行区间优先用 mouseup 时捕获的缓存值（点击 @ 时 iframe 焦点已丢）；
      // 只有缓存仍为空才现读 iframe（sourceLinesForText 文本反推作兜底）
      let wt = (lastSelTextRef.current || "").trim();
      if (!wt) {
        const ws = previewRef.current.contentWindow.getSelection();
        wt = (ws && ws.toString ? ws.toString() : "").trim();
      }
      if (wt) {
        const source = (ed && typeof ed.getValue === "function") ? ed.getValue() : (meta ? meta.content : "");
        const loc = lastSelLocRef.current || sourceLinesForText(source || "", wt);
        selOut = wt;
        ref = "\u0040" + fp + (loc ? (loc.start === loc.end ? "#L" + loc.start : "#L" + loc.start + "-L" + loc.end) : "");
      } else {
        ref = "\u0040" + fp;
      }
    } else if (ed) {
      const sel = ed.getSelection();
      const m = ed.getModel();
      if (sel && !sel.isEmpty() && m && viewMode !== "preview") {
        const start = sel.startLineNumber;
        const end = sel.endLineNumber;
        const selText = m.getValueInRange(sel);
        ref = start === end ? "\u0040" + fp + "#L" + start
          : "\u0040" + fp + "#L" + start + "-L" + end;
        if (inPrev) {
          selOut = selText;
        } else {
          clip = selText;
        }
      } else {
        const pos = ed.getPosition && ed.getPosition();
        ref = "\u0040" + fp + (pos && pos.lineNumber ? "#L" + pos.lineNumber : "");
      }
    } else {
      ref = "\u0040" + fp;
    }
    return { ref, selOut, clip };
  };
  // @ 提及：选中文本/光标行写聊天输入框（无编辑器的二进制视图自动退化为整文件引用）
  const doMention = () => {
    try {
      const { ref, selOut, clip } = buildMentionRef();
      const fbase = filePath.split("/").pop();
      if (clip && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(clip).catch(() => {});
      }
      const out = selOut ? (ref + " " + selOut) : ref;
      if (typeof getCtx()?.appendText === "function") {
        getCtx()!.appendText(out + " ");
        showToast("ok", "\u5DF2\u63D2\u5165 @" + fbase);
      } else {
        navigator.clipboard.writeText(out).then(() => showToast("ok", "\u5DF2\u590D\u5236 " + out)).catch(() => showToast("err", "\u5199\u5165\u526A\u8D34\u677F\u5931\u8D25"));
      }
    } catch (e) { showToast("err", String(e)); }
  };
  // @ 到新会话：同款 @ 引用写 pending composer 预填文本，再切新建会话页
  // （收口 _shared/openNewSession——pendingComposer + pi-web:new-session；宿主 ChatInput 挂载后消费插入，不自动发送）
  const doMentionNewSession = () => {
    try {
      const { ref, selOut } = buildMentionRef();
      const out = selOut ? (ref + " " + selOut) : ref;
      sendToNewSession(out + " ");
      showToast("ok", "\u5DF2\u5728\u65B0\u4F1A\u8BDD\u63D2\u5165 @" + (filePath.split("/").pop() || ""));
    } catch (e) { showToast("err", String(e)); }
  };

  // 文件信息弹窗（⋯ 菜单「文件信息」）：现拉 /stat 取大小/修改时间，叠加 meta 的类型/编码/行数
  const [fileInfo, setFileInfo] = useState<any>(null);
  const doFileInfo = () => {
    setFileInfo({ loading: true, size: meta ? meta.size : 0, mtimeMs: 0 });
    api("/stat?filePath=" + encodeURIComponent(filePath))
      .then((r) => r.json())
      .then((m) => { setFileInfo(m && m.ok ? { size: m.size, mtimeMs: m.mtimeMs } : { size: meta ? meta.size : 0, mtimeMs: 0 }); })
      .catch(() => setFileInfo({ size: meta ? meta.size : 0, mtimeMs: 0 }));
  };
  const binaryTypeLabel = (({ image: "图片", video: "视频", audio: "音频", pdf: "PDF", archive: "压缩包" } as Record<string, string>)[fileType] || "文件");
  const fmtTime = (ms: any) => { try { return ms ? new Date(ms).toLocaleString() : "—"; } catch { return "—"; } };
  const infoRow = (k: string, v: any, mono?: boolean) => (
    <div key={k} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
      <span style={{ flexShrink: 0, width: 62, color: "var(--text-dim,#888)" }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, wordBreak: "break-all", fontFamily: mono ? "var(--font-mono,ui-monospace,monospace)" : undefined }}>{v}</span>
    </div>
  );
  // 目录行可点击：点击打开对应目录（复用在目录打开的 openFolder + folder-reveal 链路）
  const parentDir = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
  const infoRowDir = () => (
    <div key="dir" style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
      <span style={{ flexShrink: 0, width: 62, color: "var(--text-dim,#888)" }}>目录</span>
      <button type="button" title="点击打开该目录" onClick={() => { setFileInfo(null); openDir(); }}
        style={{ flex: 1, minWidth: 0, wordBreak: "break-all", textAlign: "left", padding: 0, border: "none", background: "transparent", cursor: "pointer",
          color: "var(--accent,#4f8ef7)", fontFamily: "var(--font-mono,ui-monospace,monospace)", textDecoration: "underline", textDecorationStyle: "dotted", textUnderlineOffset: 3 }}>{parentDir}</button>
    </div>
  );
  const fileInfoModal = fileInfo ? (
    <div onClick={(e) => { if (e.target === e.currentTarget) setFileInfo(null); }}
      style={{ position: "fixed", inset: 0, zIndex: 800, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}>
      <div style={{ width: 400, maxWidth: "92vw", padding: "16px 18px", borderRadius: 12, background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontSize: 13 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10 }}>文件信息</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 7, fontSize: 12 }}>
          {infoRow("文件名", filePath.split("/").pop() || "—", true)}
          {infoRowDir()}
          {infoRow("类型", isBinaryView ? binaryTypeLabel : language)}
          {infoRow("大小", formatSize(fileInfo.size || 0))}
          {infoRow("修改时间", fmtTime(fileInfo.mtimeMs))}
          {!isBinaryView && infoRow("编码", meta ? encDisplay(meta.encoding, meta.hasBOM) : "UTF-8", true)}
          {!isBinaryView && meta && meta.content && infoRow("行数", String(meta.content.split("\n").length))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button type="button" onClick={() => setFileInfo(null)} style={T.btn}>关闭</button>
        </div>
      </div>
    </div>
  ) : null;

  // ── 公共顶栏（file-toolbar.tsx）：文本/二进制视图共用同一套能力 ──
  const navProps = { siblings, index: sibIndex, insertPos: navIndex, onStep: stepSibling };

  // git 变更视图切换器（文本视图有变更时显示；选项与 aiti-git-review 一致）+ 变更徽标（点击在 最新/左右 间切换）
  const gitLeading = gitSwitchShow ? (() => {
    const stLabel = (gitInfo && gitInfo.label) || "有变更";
    // 计数优先用 dmpHunks（实时，含未保存编辑）；基线未加载时退回 numstat（仅干净文件）
    const counts = dmpHunks.length
      ? "+" + dmpHunks.reduce((s: number, h: any) => s + h.adds, 0) + " −" + dmpHunks.reduce((s: number, h: any) => s + h.dels, 0)
      : (!dirty && gitInfo && typeof gitInfo.adds === "number" ? "+" + gitInfo.adds + " −" + (gitInfo.dels || 0) : "");
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
        <button type="button"
          title={gitIsNewFile
            ? "新文件（相对 HEAD 无基线，整篇均为新增" + (dirty ? "，含未保存编辑" : "") + "）；点击在 最新/左右 视图间切换"
            : "工作区 vs HEAD 有未提交变更（" + stLabel + (dirty ? "，含未保存编辑" : "") + "）；点击在 最新/左右 视图间切换"}
          onClick={() => setGitView(gitView === "latest" ? "side" : "latest")}
          style={{ fontSize: 10, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: gitIsNewFile ? "#16a34a" : "#7c3aed",
            border: "1px solid " + (gitIsNewFile ? "rgba(22,163,74,.35)" : "rgba(124,58,237,.35)"), borderRadius: 4, padding: "1px 6px",
            background: gitViewActive ? (gitIsNewFile ? "rgba(22,163,74,.12)" : "rgba(124,58,237,.12)") : "transparent", cursor: "pointer", whiteSpace: "nowrap" }}>
          {gitIsNewFile ? "新文件" : "⇋ HEAD" + (counts ? " " + counts : "")}
        </button>
        <select value={gitView} onChange={(e) => setGitView(e.target.value)}
          title="git 变更视图（工作区 vs HEAD；默认「最新」显示最终版）"
          style={{ fontSize: 11, padding: "2px 4px", height: 24, border: "1px solid var(--border,#d0d0d0)",
            borderRadius: 6, background: "var(--bg,#fff)", color: "var(--text,#1a1a1a)", fontFamily: "inherit", cursor: "pointer" }}>
          <option value="latest">最新</option>
          <option value="side">左右</option>
          <option value="inline">合并</option>
          <option value="outline">大纲</option>
        </select>
      </div>
    );
  })() : undefined;

  // ── 钉住 + 批量关闭（容量控制 applyTabCap 已提升至组件顶部 hooks 区，stepSibling/stepImage 依赖它）──
  const [, setUiTick] = useState(0); // 钉住状态存在 window.__aitiEditor（非 React state），翻转后强刷让菜单文案同步
  const isPinnedNow = () => !!(window as any).__aitiEditor?.isTabPinned?.(filePath);
  const togglePinNow = () => {
    const on = !!(window as any).__aitiEditor?.togglePin?.(filePath);
    setUiTick((n) => n + 1);
    showToast("ok", on ? "已钉住（不受批量关闭/容量逐出影响）" : "已取消钉住");
  };
  // 批量关闭时未保存文件的逐个确认（保存/丢弃/取消）
  const [batchAsk, setBatchAsk] = useState<any>(null); // { path, resolve(choice) }
  // 关闭当前文件：脏→复用现有自绘确认（保存并关闭/不保存关闭/取消）
  const closeCurrentTab = async () => {
    const ok = await (window as any).__aitiEditor.confirmClose(filePath);
    if (ok) getCtx()?.closeFileTabs?.(["file:" + filePath]);
  };
  // 批量关闭：all/left/right；钉住与文件夹 tab 不受影响；当前文件用「关闭」单独处理
  const batchClose = async (mode: "all" | "left" | "right") => {
    const ctx = getCtx();
    const tabs = (ctx && typeof ctx.getFileTabs === "function") ? (ctx.getFileTabs() || []) : [];
    const we = window as any;
    const activeId = "file:" + filePath;
    const activeIdx = tabs.findIndex((t: any) => t.id === activeId);
    const targets = tabs.filter((t: any, i: number) => {
      if (t.kind === "folder") return false;
      if (we.__aitiEditor?.isTabPinned?.(t.filePath)) return false; // 钉住不受批量关闭影响
      if (t.id === activeId) return false; // 当前用「关闭」单独处理
      if (mode === "all") return true;
      if (mode === "left") return i < activeIdx;
      if (mode === "right") return i > activeIdx;
      return false;
    });
    if (targets.length === 0) return;
    for (const t of targets) {
      if (we.__aitiEditor?.isFileDirty?.(t.filePath)) {
        const choice = await new Promise<string>((resolve) => setBatchAsk({ path: t.filePath, resolve }));
        if (choice === "cancel") return;
        if (choice === "save") { const saved = await we.__aitiEditor.saveOpenFile(t.filePath); if (!saved) return; }
      }
    }
    getCtx()?.closeFileTabs?.(targets.map((t: any) => t.id));
  };
  // 扩展注册动作（aiti-git-review「👁️ 审此文件」等）→ 收进 ⋯ 菜单（原为工具条独立按钮）：
  // 按 match 过滤；菜单文案用 title（label 多为纯图标，菜单里不可读），icon-only label 回退 title/id
  const extMenuTop: MenuAction[] = (() => {
    try {
      const we: any = window as any;
      const acts = (we.__aitiEditor && typeof we.__aitiEditor._getActions === "function")
        ? we.__aitiEditor._getActions() : [];
      const hasText = (s: any) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(String(s || ""));
      return acts.filter((a: any) => !a.match || a.match(filePath, meta)).map((a: any) => ({
        label: hasText(a.label) ? a.label : (a.title || a.label || a.id),
        title: a.title,
        icon: a.icon, // 统一图标透传（如 aiti-git-review 的 GrEyeIcon）
        onClick: () => { try { a.onClick && a.onClick(filePath, meta); } catch (e) { setNotice({ kind: "err", text: String(e) }); } },
      }));
    } catch { return []; }
  })();
  // ⋯ 菜单顶部追加项（钉住 + 关闭族）；文本视图再叠加 markdown 导出
  // 关闭族（关闭/左侧/右侧/全部）已收编为「关闭」图标排（2026-09-15）：FileToolbar
  // closeActions 传入——大屏工具条右端常驻 4 图标，compact 收进 ⋯ 菜单同款一行图标排。
  // dock face 态：钉住隐藏（pinnedPaths 是宿主 tab 体系概念，face 无容量逐出/批量关闭）。
  const menuTopExtra: MenuAction[] = faceMode ? [] : [
    { label: isPinnedNow() ? "取消钉住" : "钉住", icon: <MiPin />, onClick: togglePinNow },
  ];
  // dock face 态：关闭族只留「关闭」自我，且重路由 face 关闭链（confirmClose → 移除实例；
  // 原实现关 "file:<path>" 宿主 tab——face 态该 tab 不存在，会 no-op 漏关）。
  const closeActions = faceMode ? {
    self: () => { void (props.onFaceClose as () => void)(); },
  } : {
    left: () => { void batchClose("left"); },
    self: () => { void closeCurrentTab(); },
    right: () => { void batchClose("right"); },
    all: () => { void batchClose("all"); },
  };
  // 批量关闭未保存确认浮层（fixed 居中，任意视图可用）
  const batchAskModal = batchAsk ? (
    <div style={{ position: "fixed", inset: 0, zIndex: 900, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}>
      <div style={{ width: 360, padding: "16px 18px", borderRadius: 12, background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)", boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontSize: 13 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>关闭未保存的文件</div>
        <div style={{ fontFamily: "var(--font-mono,ui-monospace,monospace)", color: "var(--text-dim,#888)", fontSize: 12, marginBottom: 14, wordBreak: "break-all" }}>{batchAsk.path}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={() => { const r = batchAsk.resolve; setBatchAsk(null); r && r("save"); }} style={T.btn}>保存并关闭</button>
          <button type="button" onClick={() => { const r = batchAsk.resolve; setBatchAsk(null); r && r("discard"); }} style={T.btn}>不保存关闭</button>
          <button type="button" onClick={() => { const r = batchAsk.resolve; setBatchAsk(null); r && r("cancel"); }} style={{ ...T.btn, border: "none", background: "transparent" }}>取消</button>
        </div>
      </div>
    </div>
  ) : null;

  const renderBinaryBar = (typeLabel: string) => {
    const live = isMediaFile && watchLive;
    const info = (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, flexShrink: 1, overflow: "hidden",
        color: "var(--text-dim,#888)", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
        <span style={{ flexShrink: 0 }}>{typeLabel}</span>
        <span>·</span><span style={{ flexShrink: 0 }}>{formatSize(meta ? meta.size : 0)}</span>
        {isMediaFile && mediaDuration != null && isFinite(mediaDuration) ? (<><span>·</span><span style={{ flexShrink: 0 }}>{fmtMediaDuration(mediaDuration)}</span></>) : null}
        {live ? (
          <span title="文件变化实时同步中——agent 追写内容会自动刷新预览"
            style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, color: "var(--ok, #4ade80)" }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok, #4ade80)", animation: "aitiLivePulse 1.6s ease-in-out infinite" }} />
            <span>实时</span>
          </span>
        ) : null}
      </span>
    );
    return (
      <FileToolbar
        filePath={filePath}
        dot={{ title: "二进制文件（只读预览）", color: "var(--border,#e0e0e0)" }}
        nav={navProps}
        closeActions={closeActions}
        about={aboutProp}
        notice={notice}
        onMention={doMention}
        onMentionNewSession={doMentionNewSession}
        onFileInfo={doFileInfo}
        downloadBtn
        onDownload={doDownload} onCopyPath={copyPath} onRename={doRename} onOpenDir={openDir}
        onMove={doMove}
        onNewWindow={openInNewWindow}
        onTerminal={openTerminal}
        menuTop={[...extMenuTop, ...menuTopExtra]}
        infoAfterNav={info}
      />
    );
  };

  // ── 第三方渲染 provider 接管（M0 多编辑器仲裁）：render 返回的视图全权接管内容区，
  //    工具条复用 FileToolbar（▦ 打开方式 + 预览/编辑能力联动 + ⋯ 全套文件动作）。──
  if (thirdParty) {
    return (
      <>
        <ThirdPartyProviderHost
          key={thirdParty.id}
          provider={thirdParty}
          filePath={filePath}
          cwd={cwd}
          chain={arbChain}
          actions={{
            doMention, doMentionNewSession, doFileInfo, doDownload, copyPath,
            doRename, doMove, openDir, openTerminal, openInNewWindow,
          }}
          extMenuTop={extMenuTop}
          menuTopExtra={menuTopExtra}
          nav={navProps}
          showToast={showToast}
          watchEnabled={props.watchEnabled !== false}
        />
        {/* 能力联动 toast（第三方分支提前 return，主 return 的 toast 不可达） */}
        {toast && (
          <div style={{ position: "fixed", top: 40, left: "50%", transform: "translateX(-50%)", zIndex: 700,
            pointerEvents: "none", maxWidth: "70%", padding: "6px 14px", borderRadius: 999,
            background: toast.kind === "err" ? "rgba(220,38,38,0.92)" : toast.kind === "warn" ? "rgba(217,119,6,0.92)" : "rgba(22,101,52,0.92)",
            color: "#fff", fontSize: 12, lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            boxShadow: "0 4px 14px rgba(0,0,0,0.25)" }}>{toast.text}</div>
        )}
      </>
    );
  }

  // ── 二进制可渲染（压缩包）：内部文件列表 ──
  if (isBinaryView) {
    const fileUrl = pathTicket ? editorBase() + "/t/" + pathTicket + "/file" : "";
    const mediaSrc = fileUrl && mediaBust > 0 ? fileUrl + "&v=" + mediaBust : fileUrl;
    const typeLabel = ({ image: "图片", video: "视频", audio: "音频", pdf: "PDF", archive: "压缩包" } as Record<string, string>)[fileType] || "文件";
    let body: any;
    if (fileType === "archive") {
      body = archiveErr
        ? <div style={{ color: "var(--danger, #f87171)", fontSize: 13, padding: 20 }}>{archiveErr}</div>
        : !archiveFiles
          ? <div style={{ color: "var(--text-dim,#888)", fontSize: 13, textAlign: "center", padding: 40 }}>正在加载压缩包内容…</div>
          : archiveFiles.length === 0
            ? <div style={{ color: "var(--text-dim,#888)", fontSize: 13, textAlign: "center", padding: 40 }}>压缩包为空</div>
            : (
              <div style={{ width: "100%", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12 }}>
                <div style={{ display: "flex", padding: "6px 12px", borderBottom: "1px solid var(--border,#e0e0e0)", color: "var(--text-dim,#888)", fontWeight: 600, fontSize: 11 }}>
                  <span style={{ flex: "1 1 auto", minWidth: 0 }}>文件名</span>
                  <span style={{ flex: "0 0 80px", textAlign: "right" }}>大小</span>
                  <span style={{ flex: "0 0 140px", textAlign: "right", paddingRight: 8 }}>时间</span>
                </div>
                {archiveFiles.map((f: any, i: number) => (
                  <div key={i} title={"点击打开 " + f.name}
                    style={{ display: "flex", padding: "4px 12px", borderBottom: "1px solid var(--border,#f0f0f0)", cursor: "pointer",
                      background: i % 2 === 0 ? "transparent" : "rgba(0,0,0,0.02)" }}
                    onClick={() => {
                      // 提取压缩包内文件到临时缓存，然后用 ctx.openFile 打开
                      const innerName = f.name.split("/").pop() || f.name;
                      api("/archive-extract?archivePath=" + encodeURIComponent(filePath) + "&innerPath=" + encodeURIComponent(f.name))
                        .then((r) => r.json())
                        .then((d) => {
                          if (d.ok && d.extractPath) {
                            getCtx()?.openFile?.(d.extractPath, innerName);
                          } else {
                            setArchiveErr(d.error || "提取失败");
                          }
                        })
                        .catch((e) => setArchiveErr(String(e)));
                    }}>
                    <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: f.name.endsWith("/") ? "var(--text-dim,#888)" : "inherit" }}>
                      {f.name.endsWith("/") ? (f.name.slice(0, -1) + "/") : f.name}
                    </span>
                    <span style={{ flex: "0 0 80px", textAlign: "right", color: "var(--text-dim,#888)" }}>{f.size > 0 ? formatSize(f.size) : ""}</span>
                    <span style={{ flex: "0 0 140px", textAlign: "right", color: "var(--text-dim,#888)", paddingRight: 8 }}>{f.date || ""}</span>
                  </div>
                ))}
                <div style={{ padding: "6px 12px", color: "var(--text-dim,#888)", fontSize: 11, borderTop: "1px solid var(--border,#e0e0e0)" }}>
                  {"共 " + archiveFiles.length + " 个文件" + (archiveFiles.filter((f: any) => f.name.endsWith("/")).length > 0 ? "，" + archiveFiles.filter((f: any) => f.name.endsWith("/")).length + " 个目录" : "")}
                </div>
              </div>
            );
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "var(--bg,#fff)", position: "relative" }}>
          {renderBinaryBar(typeLabel)}
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "auto" }}>{body}</div>
          {batchAskModal}
          {fileInfoModal}
        </div>
      );
    }
    // 图片：独立查看器布局（缩放/平移/信息等，见 image-viewer.tsx）——不进通用居中容器；加 ‹ › 前后导航
    if (fileType === "image") {
      const hasNav = !!imgSiblings && imgSiblings.length > 1;
      const arrowBtn = { ...T.btn, padding: "9px 13px", fontSize: 18, opacity: 0.8 };
      const navLabel = (hasNav && imgIndex >= 0) ? ((imgIndex + 1) + "/" + imgSiblings.length) : "";
      return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "var(--bg,#fff)", position: "relative" }}>
          {renderBinaryBar(typeLabel)}
          <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
            {fileUrl
              ? <ImageViewer src={fileUrl} filePath={filePath} fileSize={meta ? meta.size : undefined} mtimeMs={meta ? meta.mtimeMs : undefined} onSrcError={recoverMedia} />
              : <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim,#888)", fontSize: 13 }}>正在加载…</div>}
            {hasNav && (
              <>
                <button type="button" onClick={() => stepImage(-1)} title="上一个图片" style={{ ...arrowBtn, position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", display: "inline-flex", alignItems: "center" }}><MiChevronL size={20} /></button>
                <button type="button" onClick={() => stepImage(1)} title="下一个图片" style={{ ...arrowBtn, position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", display: "inline-flex", alignItems: "center" }}><MiChevronR size={20} /></button>
                {navLabel && <span style={{ position: "absolute", right: 16, bottom: 14, color: "rgba(255,255,255,0.75)", fontSize: 11, fontFamily: "var(--font-mono,ui-monospace,monospace)", background: "rgba(0,0,0,0.35)", padding: "2px 8px", borderRadius: 10 }}>{navLabel}</span>}
              </>
            )}
          </div>
          {batchAskModal}
          {fileInfoModal}
        </div>
      );
    }
    body =
      !fileUrl ? <div style={{ color: "var(--text-dim,#888)", fontSize: 13, textAlign: "center", padding: 40 }}>正在加载…</div>
      // 注意：不要调 setMediaActive —— 该状态从未声明也无人消费（纯写不读），
      // 调用会抛 ReferenceError 使整个视频/音频预览崩溃（2026-09-06 实测）。
      : fileType === "video" ? <video key={mediaSrc} src={mediaSrc} controls playsInline preload="metadata" onPlay={() => { mediaErrRef.current = 0; }} onLoadedMetadata={(e: any) => { mediaErrRef.current = 0; setMediaDuration(e.currentTarget.duration); }} onError={recoverMedia} style={{ maxWidth: "100%", maxHeight: "100%" }} />
      : fileType === "audio" ? <audio key={mediaSrc} src={mediaSrc} controls preload="metadata" onPlay={() => { mediaErrRef.current = 0; }} onLoadedMetadata={(e: any) => { mediaErrRef.current = 0; setMediaDuration(e.currentTarget.duration); }} onError={recoverMedia} style={{ width: "90%", maxWidth: 480 }} />
      : fileType === "pdf" ? <iframe src={fileUrl} style={{ width: "100%", height: "100%", border: "none" }} />
      : <div style={{ color: "var(--text-dim,#888)", fontSize: 14, textAlign: "center", padding: 40 }}>暂不支持预览此类型文件</div>;
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "var(--bg,#fff)", position: "relative" }}>
        {renderBinaryBar(typeLabel)}
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 12,
          background: fileType === "pdf" ? "var(--bg,#fff)" : "repeating-conic-gradient(#26262b 0% 25%, #2e2e33 0% 50%) 50% / 22px 22px" }}>
          {/* width 给 pdf/audio 定 100%：audio 无 intrinsic 尺寸且 width:90% 引用本层，
              本层 auto（flex item 由内容决定）→ 百分比循环解析为 0 → 控件不可见不可点（2026-09-06 实测） */}
          <div style={{ display: "flex", width: fileType === "pdf" || fileType === "audio" ? "100%" : "auto", height: fileType === "pdf" ? "100%" : "auto", alignItems: "center", justifyContent: "center" }}>{body}</div>
        </div>
        {batchAskModal}
        {fileInfoModal}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
<FileToolbar
        filePath={filePath}
        about={aboutProp}
        onSave={!isReadOnly ? () => doSave(false) : undefined}
        onSaveAs={!isReadOnly ? () => doSaveAsText() : undefined}
        dot={{ title: dirty ? "\u6709\u672A\u4FDD\u5B58\u4FEE\u6539" : "\u5DF2\u540C\u6B65", color: dirty ? "var(--warn, #f59e0b)" : "var(--border,#e0e0e0)" }}
        nav={navProps}
        closeActions={closeActions}
        notice={notice}
        leading={gitLeading}
        modes={canPreview ? {
          items: previewModeItems(previewKind),
          value: viewMode,
          // 切预览模式时退出 git diff 视图（两个切换器不叠加）
          onChange: (v: string) => { setViewMode(v); setGitView("latest"); },
        } : undefined}
        onMention={doMention}
        onMentionNewSession={doMentionNewSession}
        onFileInfo={doFileInfo}
        mentionTitle={"\u63D0\u53CA\u6587\u4EF6\u2014\u2014\u5C06\u5F53\u524D\u9009\u533A\u6216\u884C\u5199\u5165\u804A\u5929\u8F93\u5165\u6846"}
        rightExtra={(
          <>
            {/* 保存（仅 dirty / 只读时显示）；编码徽标已移至底部状态栏 */}
            {(isReadOnly || saving || dirty) && (
              <button
                type="button" disabled={saving || isReadOnly}
                onClick={() => doSave(false)}
                style={{ ...((saving || isReadOnly) ? T.btnD : T.btn), flexShrink: 0 }}
              >{saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58 \u25CF"}</button>
            )}
            {/* 扩展注册的工具条按钮已收进 ⋯ 菜单（extMenuTop） */}
          </>
        )}
        menuTop={[
          ...extMenuTop,
          ...(isMarkdown ? [
            { label: "导出 HTML", icon: <MiFileText />, onClick: () => doExportHtml() },
            { label: "导出 PDF", icon: <MiFileText />, onClick: () => doExportPdf() },
          ] : []),
          ...menuTopExtra,
        ]}
        onNewWindow={openInNewWindow}
        onDownload={doDownload} onCopyPath={copyPath} onCopyContent={copyContent} onRename={doRename} onOpenDir={openDir}
        onMove={doMove}
        onTerminal={openTerminal}
      />
      {status.phase === "loading" && (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, color: "var(--text-muted,#888)", fontSize: 14 }}>
          <div style={{ width: 30, height: 30, border: "3px solid var(--border,#e0e0e0)", borderTopColor: "#4f8ef7", borderRightColor: "#4f8ef7", borderRadius: "50%", animation: "aiti-spin 0.6s linear infinite" }} />
          正在加载文件内容…
        </div>
      )}
      {status.phase === "error" && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--danger, #f87171)", fontSize: 13, padding: 16, textAlign: "center" }}>
          <div>
            {"aiti-editor \u63A5\u7BA1\u5931\u8D25"}<br />{String(status.error)}
            <div style={{ marginTop: 10 }}>
              <button type="button" onClick={loadContent} style={T.btn}>重试</button>
            </div>
          </div>
        </div>
      )}
      {status.phase === "ready" && (
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden" }}>
          {/* ── 文本文件：Monaco 编辑器容器 ── */}
          {!isBinaryView && (
            <div ref={containerRef} style={{
              position: "absolute", top: 0, bottom: 0, left: 0,
              right: canPreview && viewMode === "split" ? "50%" : 0,
              display: (canPreview && viewMode === "preview") || gitViewActive ? "none" : "block",
              overflow: "hidden",
            }} />
          )}
          {/* Monaco 加载失败遮罩（loadMonaco 已退避重试 3 次 → 手动兜底） */}
          {!isBinaryView && monacoErr && (
            <div style={{ position: "absolute", inset: 0, zIndex: 600,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12,
                background: "rgba(0,0,0,0.35)", color: "var(--danger, #f87171)", fontSize: 13, padding: 16, textAlign: "center" }}>
              <div>Monaco 编辑器加载失败<br />{monacoErr}</div>
              <div style={{ color: "var(--text-dim,#888)", fontSize: 12 }}>重试会自动清除加载缓存；若反复失败请刷新页面（或检查网络）</div>
              <button
                type="button"
                onClick={() => { setMonacoErr(null); setMonacoRetry((n) => n + 1); }}
                style={T.btn}
              >重试加载</button>
            </div>
          )}
          {/* preview/split 共用一个 wrap（split 占右半，preview 全屏）；git diff 视图激活时一并隐藏。
              预览面按 kind 分派：markdown = srcdoc iframe（本层 ref，fit 效果撑尺寸）；
              html = HtmlPreviewPane（自带 iframe 与预览条，两态切换，见 ./html-preview.tsx） */}
          {!isBinaryView && canPreview && !gitViewActive && (viewMode === "split" || viewMode === "preview") && (
            <div style={{
              position: "absolute", top: 0, bottom: 0,
              left: viewMode === "split" ? "50%" : 0, right: 0,
              display: "flex", overflow: "hidden", borderLeft: viewMode === "split" ? "1px solid var(--border,#d0d0d0)" : "none",
            }}>
              {previewKind === "markdown" ? (
                <div ref={previewWrapRef} style={{ display: "flex", flex: 1, minWidth: 0, overflow: "hidden" }}>
                  <iframe ref={previewRef} title="markdown preview" style={{ width: "100%", height: "100%", border: "none", display: "block" }} />
                </div>
              ) : (
                <HtmlPreviewPane
                  filePath={filePath}
                  ticket={pathTicket}
                  previewTick={previewTick}
                  dirty={dirty}
                  dark={isDarkTheme()}
                  getBufferText={() => (editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : ""))}
                  onSave={() => doSave(false)}
                  showToast={showToast}
                  onOpenPath={(p: string) => { try { getCtx()?.openFile?.(p, undefined, { select: true }); } catch { /* 宿主不接受打开 */ } }}
                />
              )}
            </div>
          )}
          {/* ── git 变更视图（左右/合并/大纲）：Monaco diff，基线 = HEAD，合并侧 = 当前编辑内容 ── */}
          {gitViewActive && (
            <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "var(--bg,#fff)" }}>
              <div ref={diffContainerRef} style={{ position: "absolute", inset: 0 }} />
              {!gitBase && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted,#888)", fontSize: 12 }}>
                  正在获取 HEAD 基线…
                </div>
              )}
              {gitBase && (gitBase as any).error && (
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--danger, #f87171)", fontSize: 12, padding: 16, textAlign: "center" }}>
                  {(gitBase as any).error}
                </div>
              )}
              {/* 大纲：git-review 同款变更区浮层，点击跳到对应变更行 */}
              {gitView === "outline" && gitBase && !(gitBase as any).error && (
                <div style={{ position: "absolute", top: 6, left: 6, bottom: 6, width: 240, overflowY: "auto",
                  background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)", borderRadius: 8,
                  boxShadow: "0 4px 16px rgba(0,0,0,.12)", zIndex: 20, padding: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-dim,#888)", padding: "4px 6px" }}>
                    {"大纲 · " + gitHunks.length + " 个变更区"}
                  </div>
                  {gitHunks.length === 0 && (
                    <div style={{ color: "var(--text-muted,#999)", fontSize: 12, padding: 8 }}>
                      无变更行（工作区与 HEAD 一致，或基线尚未加载）
                    </div>
                  )}
                  {gitHunks.map((hk: any, i: number) => (
                    <div key={i} onClick={() => jumpHunk(hk)}
                      style={{ padding: "5px 8px", borderRadius: 6, cursor: "pointer", fontSize: 11, marginBottom: 2,
                        fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "var(--text,#333)" }}>
                      <div style={{ fontWeight: 700 }}>{"@@ +" + hk.newStart + "," + (hk.newLines || 0) + " @@"}</div>
                      {hk.preview ? (
                        <div style={{ color: "var(--text-dim,#888)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hk.preview}</div>
                      ) : null}
                      <div style={{ color: "var(--text-dim,#888)", fontSize: 10 }}>{hk.adds + "+ / " + hk.dels + "-"}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* git 变更定位钮（markdown 预览/分栏 + 有变更时）：循环滚动到下一个变更块并闪烁；
              新文件无 HEAD 基线、整篇即新增 → 只显示「新文件」徽标（定位无意义） */}
          {!isBinaryView && isMarkdown && !gitViewActive && (viewMode === "split" || viewMode === "preview") && (gitIsNewFile || mdChgRanges.length > 0) && (
            gitIsNewFile ? (
              <span
                title="新文件：相对 HEAD 无基线，整篇均为新增"
                style={{ position: "absolute", right: 16, bottom: 14, zIndex: 30,
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "#16a34a",
                  border: "1px solid rgba(22,163,74,.4)", borderRadius: 999, padding: "4px 12px",
                  background: "var(--bg,#fff)", boxShadow: "0 3px 10px rgba(0,0,0,.15)" }}>
                {"新文件"}
              </span>
            ) : (
              <button type="button" onClick={gotoMdChg}
                title="定位到下一个 git 变更块（循环）"
                style={{ position: "absolute", right: 16, bottom: 14, zIndex: 30,
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)", color: "#7c3aed",
                  border: "1px solid rgba(124,58,237,.4)", borderRadius: 999, padding: "4px 12px",
                  background: "var(--bg,#fff)", cursor: "pointer", boxShadow: "0 3px 10px rgba(0,0,0,.15)" }}>
                {"⇋ " + mdChgRanges.length + " 处改动 · 定位"}
              </button>
            )
          )}
          {askState && (
            <div style={{ position: "absolute", inset: 0, zIndex: 500,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(0,0,0,0.35)" }}>
              <div style={{ width: 360, padding: "16px 18px", borderRadius: 12,
                background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)",
                boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontSize: 13 }}>
                {/* blockers 标题列表 */}
                <div style={{ marginBottom: 10 }}>
                  {(askState.blockers || []).map((b: any, bi: number) => (
                    <div key={bi} style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{b.title}</div>
                  ))}
                </div>
                <div style={{ fontFamily: "var(--font-mono,ui-monospace,monospace)", color: "var(--text-dim,#888)", fontSize: 12, marginBottom: 14, wordBreak: "break-all" }}>{askState.path}</div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  {/* 按 blockers 声明的 actions 渲染按钮（save/discard 专属 dirty；cancel 恒有） */}
                  {(askState.blockers || []).some((b: any) => b.actions.includes("save")) && (
                    <button
                      type="button"
                      onClick={() => { doSave(false, () => { const b0 = (askState.blockers || [])[0]; if (b0 && b0.onSave) b0.onSave(); (window as any).__aitiEditor._setDirty(askState.path, false); closeAsk(true); }); }}
                      style={T.btn}
                    >保存并关闭</button>
                  )}
                  {(askState.blockers || []).some((b: any) => b.actions.includes("discard")) && (
                    <button
                      type="button"
                      onClick={() => { const b0 = (askState.blockers || [])[0]; if (b0 && b0.onDiscard) b0.onDiscard(); (window as any).__aitiEditor._setDirty(askState.path, false); closeAsk(true); }}
                      style={T.btn}
                    >不保存关闭</button>
                  )}
                  <button
                    type="button"
                    onClick={() => closeAsk(false)}
                    style={{ ...T.btn, border: "none", background: "transparent" }}
                  >取消</button>
                </div>
              </div>
            </div>
          )}
          {/* 磁盘已修改提示（切回时检测到 mtime 变化） */}
          {extChange && (
            <div style={{ position: "absolute", inset: 0, zIndex: 500,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(0,0,0,0.35)" }}>
              <div style={{ width: 360, padding: "16px 18px", borderRadius: 12,
                background: "var(--bg,#fff)", border: "1px solid var(--border,#ddd)",
                boxShadow: "0 12px 40px rgba(0,0,0,0.25)", fontSize: 13 }}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>磁盘上的文件已被修改</div>
                <div style={{ color: "var(--text-dim,#888)", fontSize: 12, marginBottom: 14, wordBreak: "break-all" }}>{filePath}</div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={async () => {
                      const cache = (window as any).__aitiEditor._cacheGet(filePath);
                      const original = cache ? cache.original : "";
                      const local = editorRef.current ? editorRef.current.getValue() : (meta ? meta.content : "");
                      if (!original || !local) { setNotice({ kind: "err", text: "\u7F3A\u5C11\u539F\u59CB\u5185\u5BB9\uFF0C\u65E0\u6CD5\u5408\u5E76" }); return; }
                      const encU = meta && meta.encoding ? "&encoding=" + encodeURIComponent(meta.encoding) : "";
                      try {
                        const r = await api("/raw?filePath=" + encodeURIComponent(filePath) + encU);
                        const d = await r.json();
                        if (d.error) { setNotice({ kind: "err", text: d.error }); return; }
                        const disk = d.content || "";
                        const dmp = await (window as any).__aitiEditor.loadDmp();
                        const patches = dmp.patch_make(original, local);
                        const [merged, results] = dmp.patch_apply(patches, disk);
                        const failCount = Array.isArray(results) ? results.filter(Boolean).length : 0;
                        const ed = editorRef.current;
                        if (ed) ed.setValue(merged);
                        initialContentRef.current = merged;
                        const c = (window as any).__aitiEditor._cacheGet(filePath);
                        if (c) { c.content = merged; c.original = merged; c.baseMtimeMs = (extChange && extChange.diskMtimeMs) || Date.now(); }
                        baseMtimeRef.current = (extChange && extChange.diskMtimeMs) || Date.now();
                        setDirty(false); (window as any).__aitiEditor._setDirty(filePath, false);
                        setExtChange(null);
                        const msg = failCount > 0 ? "\u5408\u5E76\u5B8C\u6210\uFF08" + (results.length - failCount) + "/" + results.length + " \u6210\u529F\uFF09" : "\u5DF2\u5408\u5E76\uFF08\u7528\u6237\u6539\u52A8\u5DF2\u5E94\u7528\u4E8E\u65B0\u7248\u672C\uFF09";
                        setNotice({ kind: "ok", text: msg });
                      } catch (e: any) { setNotice({ kind: "err", text: "\u5408\u5E76\u5931\u8D25\uFF1A" + (e && e.message || e) }); }
                    }}
                    style={T.btn}
                  >合并</button>
                  <button
                    type="button"
                    onClick={() => {
                      const encU = meta && meta.encoding ? "&encoding=" + encodeURIComponent(meta.encoding) : "";
                      api("/raw?filePath=" + encodeURIComponent(filePath) + encU)
                        .then((r) => r.json())
                        .then((d) => {
                          if (d.error) { setNotice({ kind: "err", text: d.error }); return; }
                          const content = d.content || "";
                          const ed = editorRef.current;
                          if (ed) ed.setValue(content);
                          initialContentRef.current = content;
                          const cache = (window as any).__aitiEditor._cacheGet(filePath);
                          if (cache) { cache.content = content; cache.original = content; cache.baseMtimeMs = (extChange && extChange.diskMtimeMs) || Date.now(); }
                          baseMtimeRef.current = (extChange && extChange.diskMtimeMs) || Date.now();
                          setDirty(false); (window as any).__aitiEditor._setDirty(filePath, false);
                          setExtChange(null); setNotice({ kind: "ok", text: "\u5DF2\u52A0\u8F7D\u78C1\u76D8\u7248\u672C" });
                        })
                        .catch((e) => setNotice({ kind: "err", text: String(e) }));
                    }}
                    style={T.btn}
                  >加载磁盘</button>
                  <button
                    type="button"
                    onClick={() => { setExtChange(null); setNotice({ kind: "warn", text: "\u4FDD\u7559\u5F53\u524D\u7F16\u8F91\uFF08\u4FDD\u5B58\u65F6\u5C06\u68C0\u6D4B\u51B2\u7A81\uFF09" }); }}
                    style={T.btn}
                  >保留当前</button>
                </div>
              </div>
            </div>
          )}
          {aiPop && (
            <div style={{ position: "absolute", top: aiPop.top, left: aiPop.left, zIndex: 100,
              display: "flex", gap: 4, padding: "4px 8px",
              background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)",
              borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 11 }}>
              <button title="插入 @文件#行 引用到当前会话输入框（不发送）" onClick={() => { doMention(); setAiPop(null); }} style={{ ...T.btn, padding: "2px 8px", gap: 4 }}>@</button>
              <button title="插入 @引用到新会话输入框（不发送）" onClick={() => { doMentionNewSession(); setAiPop(null); }} style={{ ...T.btn, padding: "2px 8px", gap: 4 }}>@到新会话</button>
              <button title="选区写入当前会话输入框，自主决定是否发送" onClick={() => aiInsert("重构这段代码：\n")} style={{ ...T.btn, padding: "2px 8px", gap: 4 }}>重构</button>
              <button title="立即以 steer 发送到当前会话" onClick={() => aiAction("解释这段代码：\n")} style={{ ...T.btn, padding: "2px 8px", gap: 4 }}>解释</button>
              {isMarkdown && detectTable(editorRef.current) && (
                <button title="按列宽对齐光标所在 Markdown 表格（Alt+Shift+F 同款）" onClick={() => { formatTable(editorRef.current); setAiPop(null); }} style={{ ...T.btn, padding: "2px 8px", gap: 4 }}>表格优化</button>
              )}
            </div>
          )}
        </div>
      )}
      {/* 底部状态栏：编码（点击弹菜单）· 行数 · 文件大小 · 只读提示——统计信息集中在此，顶部工具栏只留高频操作 */}
      {!isBinaryView && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "3px 12px",
          borderTop: "1px solid var(--border,#e0e0e0)", fontSize: 11,
          color: "var(--text-dim,#888)", background: "var(--bg,#fff)", flexShrink: 0 }}>
          <span style={{ flexShrink: 0, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
            {meta && meta.content ? meta.content.split("\n").length + " 行" : ""}
          </span>
          <span style={{ flexShrink: 0, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}
            title={meta ? meta.size + " 字节" : ""}>{formatSize(meta ? meta.size : 0)}</span>
          {isReadOnly && <span style={{ color: "var(--warn, #f59e0b)", flexShrink: 0 }}>超 1MB 只读</span>}
          <span style={{ flex: "1 1 auto" }} />
          <span style={{ flexShrink: 0 }}>{language}</span>
          {/* 编码徽标（点击弹编码菜单；向上弹出） */}
          <div style={{ position: "relative", flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setShowEnc(!showEnc)}
              style={{ ...T.btn, padding: "2px 7px", fontSize: 11, fontFamily: "var(--font-mono, ui-monospace, monospace)",
                color: (meta && meta.encoding && meta.encoding !== "utf-8") ? "var(--warn, #f59e0b)" : "var(--text-dim,#888)" }}
              title={"\u7F16\u7801\uFF1A" + ((meta && encDisplay(meta.encoding, meta.hasBOM)) || "UTF-8") + "\uFF08\u70B9\u51FB\u4EE5\u7F16\u7801\u91CD\u65B0\u6253\u5F00 / \u4FDD\u5B58\uFF09"}
            >{(meta && encDisplay(meta.encoding, meta.hasBOM)) || "UTF-8"}</button>
            {showEnc && (
              <div style={{ position: "absolute", bottom: "100%", right: 0, zIndex: 110,
                display: "flex", flexDirection: "column", gap: 1, padding: 6, minWidth: 210,
                background: "var(--bg,#fff)", border: "1px solid var(--border,#d0d0d0)", borderRadius: 10,
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)", fontSize: 12 }}>
                <div style={{ padding: "4px 10px", fontWeight: 600, fontSize: 11, color: "var(--text-dim,#888)" }}>以编码重新打开（不保存当前改动）</div>
                {ENCODINGS.map((e) => {
                  const cur = !e.id.startsWith("utf-8-bom") && ((meta && meta.encoding === e.id) || (e.id === "utf-8" && (!meta || meta.encoding !== "gbk") && !(meta && meta.hasBOM))) && e.id !== "auto";
                  const bomCur = e.id === "utf-8-bom" && meta && meta.hasBOM;
                  return (
                    <button
                      type="button" key={e.id}
                      onClick={() => { setShowEnc(false); setOpenEncoding(e.id === "auto" ? "auto" : (e.id === "utf-8-bom" ? "utf-8" : e.id)); }}
                      style={{ ...T.btn, justifyContent: "flex-start", textAlign: "left", background: "transparent", border: "none", padding: "5px 10px", fontSize: 12,
                        color: (cur || bomCur) ? "#4f8ef7" : "inherit", fontWeight: (cur || bomCur) ? 600 : 400 }}
                    >{e.label + ((cur || bomCur) ? "  \u2713" : "")}</button>
                  );
                })}
                <div style={{ height: 1, background: "var(--border,#eee)", margin: "3px 2px" }} />
                <div style={{ padding: "4px 10px", fontWeight: 600, fontSize: 11, color: "var(--text-dim,#888)" }}>以编码保存（另存为新编码）</div>
                {ENCODINGS.filter((e) => e.id !== "auto").map((e) => (
                  <button
                    type="button" key={"s-" + e.id}
                    onClick={() => {
                      setShowEnc(false);
                      const enc = e.id === "utf-8-bom" ? { encoding: "utf-8", hasBOM: true } : { encoding: e.id, hasBOM: meta ? meta.hasBOM === true : false };
                      doSave(false, undefined, enc);
                    }}
                    style={{ ...T.btn, justifyContent: "flex-start", textAlign: "left", background: "transparent", border: "none", padding: "5px 10px", fontSize: 12 }}
                  >{e.label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* 批量关闭未保存确认浮层（任意 phase 可见） */}
      {batchAskModal}
      {/* 文件信息弹窗（⋯ 菜单） */}
      {fileInfoModal}
      {/* 移动到弹窗（⋯ 菜单「移动到...」） */}
      {moveOpen ? <MoveToDialog filePath={filePath} root={cwd || filePath.slice(0, filePath.lastIndexOf("/")) || "/"} onClose={() => setMoveOpen(false)} onMoved={onMoveDone} /> : null}
      {/* 瞬时反馈 toast：挂在根容器（任意 phase 可见） */}
      {toast && (
        <div style={{ position: "absolute", top: 40, left: "50%", transform: "translateX(-50%)", zIndex: 700,
          pointerEvents: "none", maxWidth: "70%", padding: "6px 14px", borderRadius: 999,
          background: toast.kind === "err" ? "rgba(220,38,38,0.92)" : toast.kind === "warn" ? "rgba(217,119,6,0.92)" : "rgba(22,101,52,0.92)",
          color: "#fff", fontSize: 12, lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          boxShadow: "0 4px 14px rgba(0,0,0,0.25)" }}>{toast.text}</div>
      )}
    </div>
  );
}
