/**
 * aiti-editor · 第三方 provider 渲染宿主（M0 多编辑器仲裁，docs/aiti-editor-office-plan.md §1.3）。
 *
 * provider.render(host, { filePath, capability, cwd }) 返回 { el, dispose }：
 *   - el 挂进本组件容器；capability 变化 / 换 provider → dispose 后重挂（key 已含两者）。
 *   - host 提供 EditorHost 契约：readFile / save / markDirty / setCapability /
 *     onFileChanged / darkTheme。
 *     · save(string) 走默认链（aiti-editor /save，baseMtime 冲突 409 原样抛出）；
 *     · save(ArrayBuffer) 走 ContentProvider.write（provider.contentProvider 指定 id，
 *       缺省 provider.id；未注册 → fail-loud 抛错——二进制编辑必须自带管线）。
 *   - 工具条复用 FileToolbar：▦ 打开方式（位置 A）+ 预览/编辑段控件（能力联动经仲裁器）。
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { editorBase, ensureEditorTicket, extSvc } from "./host-shim";
import { isDarkTheme } from "./lib";
import { hasCapability, capabilityBadge, type EditorCapability, type ProviderLike } from "./arbiter";
import { FileToolbar, type MenuAction } from "./file-toolbar";

type Disposable = { dispose(): void };

export interface HostActions {
  doMention: () => void;
  doMentionNewSession?: () => void;
  doFileInfo?: () => void;
  doDownload?: () => void;
  copyPath?: () => void;
  doRename?: () => void;
  doMove?: () => void;
  openDir?: () => void;
  openTerminal?: () => void;
  openInNewWindow?: () => void;
}

export function ThirdPartyProviderHost(props: {
  provider: ProviderLike;
  filePath: string;
  cwd?: string;
  chain: ProviderLike[];
  actions: HostActions;
  extMenuTop: MenuAction[];
  menuTopExtra: MenuAction[];
  /** 钉住动作（⋯ 窗口图标排；null = face 态不渲染） */
  pin?: { isPinned: () => boolean; toggle: () => void } | null;
  nav: { siblings: string[] | null; index: number; insertPos?: number; onStep: (d: number) => void };
  showToast: (kind: string, text: string) => void;
  watchEnabled?: boolean;
}) {
  const { provider, filePath, cwd, chain, actions, extMenuTop, menuTopExtra, pin, nav, showToast, watchEnabled } = props;
  const we: any = () => (window as any).__aitiEditor;

  const [capability, setCapability] = useState<EditorCapability>(() =>
    (window as any).__aitiEditor.getActiveCapability(filePath));
  const [dirty, setDirty] = useState(false);
  const [hostErr, setHostErr] = useState<string | null>(null);
  const containerRef = useRef<any>(null);
  const mtimeRef = useRef<number>(0);
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

  // 能力/偏好/provider 变化（含跨 tab 广播）→ 同步本组件能力态
  useEffect(() => {
    const w = we();
    if (!w?.onActiveProviderChange) return;
    return w.onActiveProviderChange(() => {
      setCapability(w.getActiveCapability(filePath));
    });
  }, [filePath]);

  // 能力路由（§1.2 能力联动）：当前 provider 具备 → 直接切；不具备 → 队列下一个具备者
  //（跨 provider 联动 + toast）；全队列无 → 提示。
  const routeCapability = useCallback((cap: EditorCapability) => {
    const w = we();
    if (!w) return;
    const active = w.getActiveProvider(filePath);
    if (active && hasCapability(active, cap)) {
      w.setActiveCapability(filePath, cap);
      setCapability(cap);
      return;
    }
    const next = chain.find((p) => hasCapability(p, cap)) || null;
    if (next) {
      w.setActiveProvider(filePath, next.id); // 换 provider → EditorApp 重渲染换宿主（key 变）
      w.setActiveCapability(filePath, cap);
      showToast("ok", "已切换到 " + (next.displayName || next.id) + (cap === "edit" ? " 编辑" : " 预览"));
    } else {
      showToast("warn", "未安装可" + (cap === "edit" ? "编辑" : "预览") + " ." + ext.replace(/^\./, "") + " 的扩展");
    }
  }, [filePath, chain, ext, showToast]);

  // 编辑器注册的保存处理器（save / saveAs），⋯ 菜单触发
  const saveHandlerRef = useRef<((mode: "save" | "saveAs") => Promise<void>) | null>(null);

  // EditorHost（§1.3 契约）：render 拿到的宿主能力
  const makeHost = useCallback(() => {
    const w = we();
    return {
      /** 编辑器视图注册保存处理器（host.save 已封装管线；菜单「保存/另存为」经此触发） */
      registerSaveHandler(fn: (mode: "save" | "saveAs") => Promise<void>) {
        saveHandlerRef.current = fn;
      },
      async readFile(): Promise<{ data: ArrayBuffer; mtimeMs: number }> {
        const ticket = await ensureEditorTicket(filePath);
        const [st, buf] = await Promise.all([
          fetch(editorBase() + "/t/" + ticket + "/stat?t=" + Date.now(), { cache: "no-store" }).then((r) => r.json()).catch(() => null),
          fetch(editorBase() + "/t/" + ticket + "/file?t=" + Date.now(), { cache: "no-store" }).then((r) => {
            if (!r.ok) throw new Error("readFile 失败 (" + r.status + ")");
            return r.arrayBuffer();
          }),
        ]);
        if (st && st.ok && typeof st.mtimeMs === "number") mtimeRef.current = st.mtimeMs;
        return { data: buf, mtimeMs: mtimeRef.current || Date.now() };
      },
      /** opts.force = 跳过乐观锁（409 冲突后用户确认覆盖用） */
      async save(data: ArrayBuffer | string, opts?: { force?: boolean }) {
        if (typeof data === "string") {
          const r = await fetch(editorBase() + "/t/" + await ensureEditorTicket(filePath) + "/save", {
            method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
            body: JSON.stringify({ filePath, content: data, baseMtimeMs: opts?.force ? undefined : (mtimeRef.current || undefined) }),
          });
          const d = await r.json().catch(() => ({} as any));
          if (r.status === 409 && d.conflict) {
            const err: any = new Error("conflict"); err.conflict = true; err.diskMtimeMs = d.diskMtimeMs;
            throw err;
          }
          if (!r.ok) throw new Error(d.error || "保存失败 (" + r.status + ")");
          mtimeRef.current = d.mtimeMs || Date.now();
          return { ok: true as const, mtimeMs: mtimeRef.current, size: d.size };
        }
        // 二进制：ContentProvider.write 管线（fail-loud：未注册即抛错）
        const cpId = (provider as any).contentProvider || provider.id;
        const cp = w?._getContentProvider ? w._getContentProvider(cpId) : null;
        if (!cp || typeof cp.write !== "function") {
          throw new Error("编辑器「" + (provider.displayName || provider.id) + "」未注册内容管线（ContentProvider.write），无法保存");
        }
        const res = await cp.write(filePath, data, opts?.force ? 0 : (mtimeRef.current || 0));
        if (res && typeof res.mtimeMs === "number") mtimeRef.current = res.mtimeMs;
        return res;
      },
      markDirty(d: boolean) {
        setDirty(d);
        we()?._setDirty(filePath, d);
      },
      setCapability: (cap: EditorCapability) => routeCapability(cap),
      onFileChanged(cb: () => void): Disposable {
        // watch live：wantWatch 票据 + 页面事件流帧（与媒体实时预览同一机制，零轮询）。
        // 页面事件流客户端缺席（core 过旧）→ 静默退化为无 watch。
        let dead = false;
        let watchId: string | null = null;
        let unsub: (() => void) | null = null;
        const stop = () => {
          if (watchId) {
            void fetch(editorBase() + "/watch-stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ watchId }) }).catch(() => {});
            watchId = null;
          }
        };
        (async () => {
          try {
            if (watchEnabled === false) return;
            // 事件总线 topics 唯一（2026-09-09 拍板）：白名单 ed-watch；禁止任何兑底（全帧/core route 均已删）。
            // topics 服务缺席（event-bus 未启用）→ watch 不可用（静默，无 watch 能力）。
            const client = (() => {
              const topicsSvc = extSvc<((h: (f: any) => void, types: string[]) => { off: () => void }) | undefined>("aiti-event-bus.subscribe-topics");
              return topicsSvc ? { subscribePageFrames: (h: (f: any) => void) => topicsSvc(h, ["ed-watch"]).off } : null;
            })();
            if (!client?.subscribePageFrames) return;
            const res = await fetch(editorBase() + "/ticket", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ filePath, wantWatch: true }),
            }).then((r) => r.json());
            if (dead) { stop(); return; }
            watchId = res.watchId || null;
            if (!watchId) return;
            unsub = client.subscribePageFrames((frame: any) => {
              if (dead || frame.type !== "ed-watch" || frame.id !== watchId) return;
              try { cb(); } catch { /* provider 回调异常不扩散 */ }
            });
          } catch { /* 静默：无 watch 能力 */ }
        })();
        return { dispose: () => { dead = true; stop(); try { unsub?.(); } catch { /* noop */ } } };
      },
      darkTheme() { return isDarkTheme(); },
    };
  }, [provider, filePath, routeCapability, watchEnabled]);

  // 挂载 provider 视图：capability/provider 变化 → dispose 旧实例重挂
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let inst: { el?: any; dispose?: () => void } | null = null;
    setHostErr(null);
    try {
      inst = (provider as any).render(makeHost(), { filePath, capability, cwd }) || null;
      if (inst && inst.el) {
        inst.el.style && (inst.el.style.height = "100%");
        container.appendChild(inst.el);
      } else if (!inst || !inst.el) {
        setHostErr("编辑器未返回视图（render 需返回 { el, dispose }）");
      }
    } catch (e: any) {
      setHostErr(String((e && e.message) || e));
    }
    return () => {
      try { inst?.dispose?.(); } catch { /* provider dispose 异常忽略 */ }
      try { container.innerHTML = ""; } catch { /* noop */ }
    };
  }, [provider, capability, filePath, cwd, makeHost]);

  const chainHasEdit = chain.some((p) => hasCapability(p, "edit"));

  // 「打开方式」菜单数据源（§1.4 位置 A）：队列全列 + 能力标注 + 当前 ✓ + 默认 ★
  const prefs: Record<string, string> = ((window as any).__aitiEditor.getEditorPrefs?.() || {}) as any;
  const openWithItems = chain.map((p) => ({
    id: p.id,
    displayName: p.displayName || p.id,
    source: (p as any).sourceExt,
    badge: capabilityBadge(p),
    active: p.id === provider.id,
    isDefault: prefs[ext] === p.id,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative", background: "var(--bg,#fff)" }}>
      <FileToolbar
        filePath={filePath}
        about={{ name: provider.displayName || provider.id, id: provider.id, source: (provider as any).sourceExt, ...((provider as any).about || {}) }}
        onSave={capability === "edit" ? () => {
          if (!saveHandlerRef.current) { showToast("warn", "编辑器实例未就绪，请稍后再试"); return; }
          void saveHandlerRef.current("save");
        } : undefined}
        onSaveAs={capability === "edit" ? () => {
          if (!saveHandlerRef.current) { showToast("warn", "编辑器实例未就绪，请稍后再试"); return; }
          void saveHandlerRef.current("saveAs");
        } : undefined}
        dot={{ title: dirty ? "有未保存修改" : "已同步", color: dirty ? "var(--warn, #f59e0b)" : "var(--border,#e0e0e0)" }}
        nav={nav}
        modes={{
          items: [
            { label: "预览", value: "preview", title: "预览模式（" + (provider.displayName || provider.id) + "）" },
            chainHasEdit
              ? { label: "编辑", value: "edit", title: "编辑模式（当前编辑器具备编辑能力）" }
              : { label: "编辑", value: "edit", disabled: true, disabledTitle: "未安装可编辑 ." + ext.replace(/^\./, "") + " 的扩展" },
          ],
          value: capability,
          onChange: (v: string) => routeCapability(v as EditorCapability),
        }}
        openWith={{ items: openWithItems, onPick: (id) => (window as any).__aitiEditor.setActiveProvider(filePath, id), onSetDefault: (id) => (window as any).__aitiEditor.setActiveProvider(filePath, id, { makeDefault: true }) }}
        onMention={actions.doMention}
        mentionTitle={"提及文件——将当前文件写入聊天输入框"}
        onMentionNewSession={actions.doMentionNewSession}
        onFileInfo={actions.doFileInfo}
        downloadBtn={!!actions.doDownload}
        onDownload={actions.doDownload}
        onCopyPath={actions.copyPath}
        onRename={actions.doRename}
        onOpenDir={actions.openDir}
        onMove={actions.doMove}
        onNewWindow={actions.openInNewWindow}
        onTerminal={actions.openTerminal}
        pin={pin ?? null}
        menuTop={[...extMenuTop, ...menuTopExtra]}
      />
      <div style={{ flex: "1 1 auto", minHeight: 0, minWidth: 0, position: "relative", overflow: "hidden" }}>
        <div ref={containerRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }} />
        {hostErr && (
          <div style={{ position: "absolute", inset: 0, zIndex: 300, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, background: "var(--bg,#fff)", color: "var(--danger, #f87171)", fontSize: 13, padding: 16, textAlign: "center" }}>
            <div>{"编辑器渲染失败"}<br />{hostErr}</div>
            {chain.length > 1 && (
              <button type="button" onClick={() => {
                const w = (window as any).__aitiEditor;
                const next = chain.find((p) => p.id !== provider.id);
                if (next) { w.setActiveProvider(filePath, next.id); showToast("ok", "已切换到 " + (next.displayName || next.id)); }
              }} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", border: "1px solid var(--border,#d0d0d0)", borderRadius: 7, cursor: "pointer", background: "var(--bg-selected,#eef2ff)", color: "var(--text,#1a1a1a)", fontSize: 11, fontWeight: 500, fontFamily: "inherit" }}>
                尝试其他编辑器
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
