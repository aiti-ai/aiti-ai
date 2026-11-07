/**
 * aiti-editor · 编辑器注册表（window.__aitiEditor 模块级单例）+ 内置注册。
 * 自手写版原样搬运：providers/languages/services/actions、编辑缓存（内存+服务端 diff）、
 * 跨 tab BroadcastChannel、session 墓碑制、confirmClose 阻止机制。
 */
import { getBase, editorRefHolder } from "./env";
import { LANG_EXT, detectFileType, isViewableBinary, isTextFile, matches, formatToml, formatCsv, loadVendorGlobal } from "./lib";
import { ensureEditorTicket, apiUrl } from "./host-shim";
import { fetchSofficeStatus, buildSofficeMissingPanel } from "../../../_shared/soffice-panel";
import { extOf, sortChain, resolveFenceChain, defaultCapabilityOf, shouldTakeover, type EditorCapability } from "./arbiter";
import { isFenceLang } from "./markdown";
import { mermaidRenderer } from "./md-mermaid";
import { getRootSessionId } from "./session-svc";

export function setupRegistry(ctx: Record<string, any>): void {
  const base = getBase();

  // ── 编辑器注册表（模块级单例，跨 materialize 保持）──
  if (!(window as any).__aitiEditor) {
    const w = window as any;
    const providers: any[] = [];
    const languages: Record<string, string> = {};
    const services: Record<string, any> = {};
    const actions: any[] = [];
    const mdRenderers: any[] = []; // md 围栏渲染器（md-plugins M0）：数组序 = 注册序（裁决平局用）
    const dirtyMap: Record<string, boolean> = {}; // filePath -> boolean（关闭/切换 tab 守卫用）
    const editorCache: Record<string, any> = {}; // path -> {content, original, baseMtimeMs, language, size}（切回继续编辑）
    const cacheWriteBlock: Record<string, number> = {}; // path -> timestamp（用户选择关闭丢弃/保存后，卸载写回忽略）
    const pinnedPaths = new Set<string>(); // 钉住：不受容量逐出 / 批量关闭影响
    // EditorApp 关闭确认 UI 注册表（confirmClose 挂起等它）。keep-alive 多实例下不能用单例槽：
    // 激活与逐出分处两个 React commit，「后挂载者注册 → 被逐出者卸载置 null」会打穿注册，
    // 脏关闭走 resolve(true) 被静默放行（docs/aiti-editor-right-dock-keepalive-plan.md §9.3）。
    // 改属主 Map——keyed by handler 引用，卸载只删自己的注册（compare-and-clear），互不误伤。
    const askCloseHandlers = new Map<any, { path: string; handle: any; isVisible?: () => boolean }>();
    // 跨 tab 缓存通知监听器（同病同修：旧单例槽在多实例下只有最后一个挂载的编辑器收得到）
    const cacheUpdateListeners = new Set<(msg: any) => void>();
    const _serverHasOriginal: Record<string, boolean> = {}; // 服务端已存 original 基线标记
    const _cacheGet = (p: string) => editorCache[String(p)] || null;

    // ── 多编辑器仲裁状态（docs/aiti-editor-office-plan.md §1.2/§1.4a）──
    const contentProviders: Record<string, any> = {}; // id -> ContentProviderRegistration（read/write 管线）
    let prefs: Record<string, string> = {};           // { ".docx": "providerId" } 用户默认偏好（服务端持久化）
    let prefsReady = false;                            // 服务端偏好已加载（加载前按 priority 语义渲染）
    const activeProviderOverride: Record<string, string> = {}; // filePath -> providerId（「打开方式」仅本次切换）
    const activeCapability: Record<string, EditorCapability> = {}; // filePath -> 当前能力（预览/编辑态）
    const activeChangeCbs = new Set<() => void>();     // provider/偏好/能力变化订阅（EditorApp 重渲染 + 右键菜单同步）
    const fireActiveChange = () => { for (const cb of [...activeChangeCbs]) { try { cb(); } catch { /* 订阅方异常不扩散 */ } } };

    // 偏好持久化：服务端 configDir/editor-prefs.json 为权威；localStorage 仅降级镜像（§1.4a）
    const PREFS_MIRROR_KEY = "aiti-editor:prefs";
    const prefsMirrorRead = () => { try { const raw = localStorage.getItem(PREFS_MIRROR_KEY); if (raw) prefs = JSON.parse(raw) || {}; } catch { /* 镜像坏 → 忽略 */ } };
    const prefsMirrorWrite = () => { try { localStorage.setItem(PREFS_MIRROR_KEY, JSON.stringify(prefs)); } catch { /* 隐私模式等 */ } };
    /** 设为默认（★）：立即写镜像 + PUT 服务端 + 广播其他 tab + 通知订阅者。失败静默降级（镜像兜底）。 */
    const setDefaultProvider = (ext: string, providerId: string) => {
      if (!ext || !providerId || prefs[ext] === providerId) return;
      prefs = { ...prefs, [ext]: providerId };
      prefsMirrorWrite();
      try {
        fetch(getBase() + "/prefs?t=" + Date.now(), {
          method: "PUT", cache: "no-store", headers: { "content-type": "application/json" },
          body: JSON.stringify({ [ext]: providerId }),
        }).catch(() => { /* 服务端失败：镜像已写，下次启动先读镜像再被服务端覆盖 */ });
      } catch { /* 忽略 */ }
      if (_bc) { try { _bc.postMessage({ type: "prefs", prefs }); } catch { /* 忽略 */ } }
      fireActiveChange();
    };
    /** 启动异步加载服务端偏好：未就绪期间按无偏好队列渲染（priority 语义），就绪后重排生效 */
    const initPrefs = () => {
      prefsMirrorRead();
      try {
        fetch(getBase() + "/prefs?t=" + Date.now(), { cache: "no-store" })
          .then((r) => r.json())
          .then((d: any) => {
            if (d && d.ok && d.prefs && typeof d.prefs === "object") {
              prefs = d.prefs; prefsReady = true;
              prefsMirrorWrite();
              fireActiveChange();
            }
          })
          .catch(() => { prefsReady = true; /* 服务端不可达：镜像顶上 */ });
      } catch { prefsReady = true; }
    };

// 加载 diff-match-patch（自带 vendor，版本比对/传输压缩用）
let _dmpPromise: Promise<any> | null = null;
const loadDmp = (): Promise<any> => {
  if ((window as any).__aitiEditor_dmp) return Promise.resolve((window as any).__aitiEditor_dmp);
  if (_dmpPromise) return _dmpPromise;
  _dmpPromise = loadVendorGlobal(base + '/assets/vendor/diff-match-patch.js', 'diff_match_patch')
    .then((Cls) => {
      const inst = new Cls();
      (window as any).__aitiEditor_dmp = inst;
      return inst;
    });
  return _dmpPromise;
};
    // 内容哈希（FNV-1a，快速低碰撞，版本比对用）
    const _hashContent = (s: string): string => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(36);
    };
    // 跨 tab 通知（多开版本同步）
    const _bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('aiti-editor-cache') : null;
    if (_bc) {
      _bc.onmessage = (ev: any) => {
        const msg = ev.data;
        // 偏好同步（多 tab 一致性）：其他 tab 设默认 → 本 tab 重排生效
        if (msg && msg.type === 'prefs' && msg.prefs && typeof msg.prefs === 'object') {
          prefs = msg.prefs; prefsReady = true; fireActiveChange(); return;
        }
        if (msg && cacheUpdateListeners.size > 0) {
          for (const fn of [...cacheUpdateListeners]) { try { fn(msg); } catch { /* 单编辑器异常不扩散 */ } }
        }
      };
    }

    // pi-web 统一事件通道（host↔extension 惯例：window CustomEvent "pi-web:*"）
    const _dispatchFileEvent = (type: string, detail: any) => {
      try { window.dispatchEvent(new CustomEvent("pi-web:file-changed", { detail: { type, ...detail } })); } catch {}
    };
    const _writeServerCache = async (p: string, keepalive?: boolean): Promise<void> => {
      const entry = editorCache[String(p)];
      if (!entry) return;
      const newHash = _hashContent(entry.content);
      // 内容变了 → 记录历史版本（所有哈希，不设上限，版本比对用）
      if (entry.contentHash && entry.contentHash !== newHash && entry.content !== entry.original) {
        if (!entry.history) entry.history = [];
        entry.history.push(entry.contentHash);
      }
      entry.contentHash = newHash;
      const body: any = { filePath: p, baseMtimeMs: entry.baseMtimeMs, contentHash: newHash, history: entry.history || [] };
      if (!_serverHasOriginal[String(p)]) {
        // 首次：传完整内容 + original（建基线；server 存 original）
        body.strategy = "content";
        body.content = entry.content;
        body.original = entry.original;
        _serverHasOriginal[String(p)] = true;
      } else {
        // 后续：传 diff 或 content 中小的那个（不传 original，server 保留基线）
        try {
          const dmp = await loadDmp();
          const patchText = dmp.patch_toText(dmp.patch_make(entry.original, entry.content));
          if (patchText && patchText.length < entry.content.length) { body.strategy = "diff"; body.diff = patchText; }
          else {
            body.strategy = "content"; body.content = entry.content; body.original = entry.original;
          }
        } catch {
          body.strategy = "content"; body.content = entry.content; body.original = entry.original;
        }
      }
      fetch(base + "/cache-write?t=" + Date.now(), {
        method: "POST", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(keepalive ? { keepalive: true } : {}), // flush 场景（pagehide/切后台）：卸载后请求仍可完成
      }).catch(() => {});
      // 广播通知其他 tab（只传哈希，不传内容）+ pi-web 宿主通道
      if (_bc) {
        _bc.postMessage({ type: 'update', filePath: p, contentHash: newHash, historyHashes: entry.history || [] });
      }
      _dispatchFileEvent("cache-update", { filePath: p, contentHash: newHash });
    };
    const _cacheSet = (p: string, v: any) => {
      v.contentHash = v.contentHash || _hashContent(v.content || '');
      v.history = v.history || [];
      editorCache[String(p)] = v;
      delete cacheWriteBlock[String(p)];
      setTimeout(() => { _writeServerCache(p); }, 0);
    };
    const _cacheDrop = (p: string) => {
      delete editorCache[String(p)];
      cacheWriteBlock[String(p)] = Date.now();
      delete _serverHasOriginal[String(p)]; // 服务端基线已删，下次重建
      // 删服务端缓存 + 广播通知其他 tab
      try { fetch(base + "/cache-delete?t=" + Date.now(), { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ filePath: p }) }).catch(() => {}); } catch {}
      if (_bc) { _bc.postMessage({ type: 'delete', filePath: p }); }
      _dispatchFileEvent("cache-delete", { filePath: p });
    };
    const _cacheWriteBlockAt = (p: string) => cacheWriteBlock[String(p)] || 0;
    // 从服务端拉取缓存（刷新页面后恢复编辑内容）；force=true 强制拉服务端（忽略内存，多开恢复用）
    const _cacheFetchFromServer = async (p: string, force?: boolean) => {
      if (!force && editorCache[String(p)]) return editorCache[String(p)]; // 内存已有，优先
      try {
        const ticket = await ensureEditorTicket(p);
        const r = await fetch(base + "/t/" + ticket + "/cache-read?t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) return null;
        const d = await r.json();
        if (!d.ok || !(d.content || d.diff)) return null;
        let content = d.content;
        const original = d.original || d.content;
        // 存的是 diff → 用基线 original 还原
        if (d.strategy === "diff" && d.diff) {
          try {
            const dmp = await loadDmp();
            const patches = dmp.patch_fromText(d.diff);
            const [res] = dmp.patch_apply(patches, original);
            content = typeof res === "string" ? res : d.content;
          } catch { content = d.content; }
        }
        const entry = { content, original, baseMtimeMs: d.baseMtimeMs || 0, language: "text", size: content.length, contentHash: d.contentHash || _hashContent(content), history: d.history || [] };
        editorCache[String(p)] = entry;
        _serverHasOriginal[String(p)] = true; // 服务端已有基线，后续只传 diff
        _dispatchFileEvent("cache-restore", { filePath: p, contentHash: entry.contentHash });
        return entry;
      } catch { return null; }
    };
    // 自动保存（afterDelay 防抖策略，对齐 VS Code files.autoSave: afterDelay / Helix
    // auto-save.after-delay）：编辑脏文件后停手 2s 写回服务端缓存；pagehide /
    // 切后台兜底 flush。不再固定 30s 盲扫。
    const AUTO_SAVE_DELAY_MS = 2000;
    let _autoSaveTimers: Record<string, any> = {}; // path -> timer（每文件独立防抖）
    function _autoSaveSchedule(p: string): void {
      if (_autoSaveTimers[p]) clearTimeout(_autoSaveTimers[p]);
      _autoSaveTimers[p] = setTimeout(() => {
        delete _autoSaveTimers[p];
        if (dirtyMap[String(p)]) { _writeServerCache(String(p), true); }
      }, AUTO_SAVE_DELAY_MS);
    }
    function _flushAllDirty(): void {
      for (const p of Object.keys(_autoSaveTimers)) { clearTimeout(_autoSaveTimers[p]); delete _autoSaveTimers[p]; }
      for (const path of Object.keys(editorCache)) {
        if (dirtyMap[path]) { _writeServerCache(path, true); } // keepalive：卸载后请求仍可完成
      }
    }
    const _onPageHide = () => { _flushAllDirty(); };
    const _onVisChange = () => { if (document.visibilityState === 'hidden') _flushAllDirty(); };
    function _startAutoSave(): void {
      window.addEventListener('pagehide', _onPageHide);
      document.addEventListener('visibilitychange', _onVisChange);
    }
    function _stopAutoSave(): void {
      _flushAllDirty(); // 卸载前把未落的防抖保存落盘
      window.removeEventListener('pagehide', _onPageHide);
      document.removeEventListener('visibilitychange', _onVisChange);
    }

    /** 命中队列（§1.2）：所有 selector 命中的 providers，偏好 > priority > 注册序。
     *  preview-only / edit-only 均收——能力分离注册由仲裁层消费。 */
    function resolveProviders(filePath: string) {
      const isText = isTextFile(filePath);
      const matched = providers.filter((p: any) => {
        if (!matches(filePath, p.selector)) return false;
        // 内建文本 provider 不进非文本文件的队列：Monaco 打开 docx/xlsx 只会乱码，
        // 「打开方式」菜单也不该出现它；文本文件链路零变化（仍由它接管）
        if (p.id === "aiti-editor.text" && !isText) return false;
        return true;
      });
      return sortChain(matched, prefs, extOf(filePath));
    }
    /** 单选解析（兼容旧语义）：队列首 + 语言推断 */
    function resolve(filePath: string) {
      const matched = resolveProviders(filePath)[0];
      if (matched) {
        // 语言：provider 指定 > 扩展名 > 默认
        let lang = matched.languageId || "";
        if (!lang) {
          const ext = filePath.split(".").pop()?.toLowerCase() || "";
          lang = languages[ext] || ext; // 查注册表，fallback 扩展名
        }
        return { provider: matched, languageId: lang || "plaintext" };
      }
      return null;
    }

    w.__aitiEditor = {
      registerEditorProvider(reg: any) {
        providers.push(reg);
        // 晚到注册（懒加载 / 状态探测后才注册的 provider，如 aiti-onlyoffice）也要让
        // 当前打开的文件重新仲裁——否则已渲染的兜底 provider 不会切换。
        if (reg && typeof reg.render === "function") fireActiveChange();
        return () => { const i = providers.indexOf(reg); if (i >= 0) providers.splice(i, 1); };
      },
      registerLanguage(reg: any) {
        if (reg.extensions) reg.extensions.forEach((e: string) => { languages[e.replace(/^\./, "")] = reg.id; });
        return () => {};
      },
      registerLanguageService(reg: any) {
        services[reg.languageId] = { ...(services[reg.languageId] || {}), ...reg };
        return () => {};
      },
      registerAction(reg: any) {
        actions.push(reg);
        return () => { const i = actions.indexOf(reg); if (i >= 0) actions.splice(i, 1); };
      },
      /**
       * md 围栏渲染器注册（md-plugins M0 §3.1）：`lang` = 接管的围栏语言（```<lang>）。
       * 同 lang 多声明**不阻断**，裁决取队列首（§5.1）。同 id 重复注册原地替换：
       * 扩展热重载换新代码，又不失「内置先注册 = 平局内置赢」的注册序位。
       */
      registerMdRenderer(reg: any) {
        if (!reg || !isFenceLang(reg.lang) || typeof reg.render !== "function") {
          console.warn("[aiti-editor] registerMdRenderer 已忽略（lang 须 [\\w-]+ 且 render 为函数）:", reg && reg.id);
          return () => {};
        }
        const at = reg.id ? mdRenderers.findIndex((r: any) => r && r.id === reg.id) : -1;
        if (at >= 0) mdRenderers[at] = reg;
        else mdRenderers.push(reg);
        return () => { const i = mdRenderers.indexOf(reg); if (i >= 0) mdRenderers.splice(i, 1); };
      },
      /** 某围栏语言的裁决队列（priority > 注册序；首项 = 生效者，预览 iframe 运行时经 parent 直调） */
      resolveMdRenderers(lang: string) { return resolveFenceChain(mdRenderers, String(lang || "")); },
      /** 构建期描述符：每语言取生效者，css 按主题求值后烤进 srcdoc（render 函数留在父页） */
      mdFenceDescriptors(dark: boolean) {
        const out: Array<{ lang: string; css: string }> = [];
        const seen: Record<string, boolean> = {};
        for (const r of mdRenderers) {
          if (!r || seen[r.lang]) continue;
          seen[r.lang] = true;
          const win = resolveFenceChain(mdRenderers, r.lang)[0] || r;
          out.push({ lang: win.lang, css: typeof win.css === "function" ? String(win.css(dark) || "") : String(win.css || "") });
        }
        return out;
      },
      // ── 多编辑器仲裁 API（M0，§1.3 契约；向后兼容：旧三参数注册不需要任何改动）──
      /** 内容管线（形态 B）：read/write 自定义持久化。id 与 editor provider 对应
       *  （provider.contentProvider 指定 id，缺省取 provider.id）。 */
      registerContentProvider(reg: any) {
        if (reg && reg.id) contentProviders[String(reg.id)] = reg;
        return () => { delete contentProviders[String(reg?.id)]; };
      },
      /** 命中队列全列（「打开方式」菜单数据源）：偏好 > priority > 注册序 */
      resolveProviders(fp: string) { return resolveProviders(fp); },
      /** 当前生效 provider（仅本次 override > 队列首）；不在队列内的 override 视为失效 */
      getActiveProvider(fp: string) {
        const chain = resolveProviders(fp);
        const want = activeProviderOverride[String(fp)];
        return (want && chain.find((p: any) => p.id === want)) || chain[0] || null;
      },
      /** 切换生效 provider：opts.makeDefault = 同时设为该扩展名的默认（服务端持久化）；
       *  不设 = 仅本次。切换后能力态重置为新 provider 的 defaultCapability。 */
      setActiveProvider(fp: string, providerId: string, opts?: { makeDefault?: boolean }) {
        if (providerId) activeProviderOverride[String(fp)] = providerId;
        else delete activeProviderOverride[String(fp)];
        delete activeCapability[String(fp)]; // 新 provider 从自己的默认能力起步
        if (opts && opts.makeDefault && providerId) setDefaultProvider(extOf(fp), providerId);
        fireActiveChange();
      },
      /** 当前能力（预览/编辑态）：未显式切换时取当前 provider 的 defaultCapability */
      getActiveCapability(fp: string): EditorCapability {
        const stored = activeCapability[String(fp)];
        if (stored) return stored;
        const p = (window as any).__aitiEditor.getActiveProvider(fp);
        return p ? defaultCapabilityOf(p) : "preview";
      },
      setActiveCapability(fp: string, cap: EditorCapability) {
        activeCapability[String(fp)] = cap;
        fireActiveChange();
      },
      /** provider/偏好/能力变化订阅（跨 tab 偏好同步也走这里）；返回退订函数 */
      onActiveProviderChange(cb: () => void) {
        activeChangeCbs.add(cb);
        return () => { activeChangeCbs.delete(cb); };
      },
      /** 设为默认偏好（★；服务端持久化 + 多 tab 同步） */
      setEditorDefault(ext: string, providerId: string) { setDefaultProvider(ext, providerId); },
      /** 当前偏好快照（调试/菜单展示用） */
      getEditorPrefs() { return { ...prefs, ready: prefsReady }; },
      _getContentProvider: (id: string) => contentProviders[String(id)] || null,
      openFile(fp: string, opts?: any) { ctx.openFile?.(fp, opts?.fileName); },
      /** 文件是否 dirty（内部/调试用） */
      isFileDirty(p: string) { return !!dirtyMap[String(p)]; },
      /** path -> true（用户确认真正关闭该 tab，卸载时从 session 移除）——存单例 */
      _sessionRemoveMark: {} as Record<string, boolean>,
      /**
       * 关闭/切换 tab 异步问询（通用阻止机制）：core 只问询不管原因。
       * 收集该文件的 blockers（dirty / 未来其他场景各自 push），无 blocker → 放行；
       * 有 → 挂起 Promise 交给 EditorApp 自绘确认浮层（用户选择后 resolve 是否放行）。
       */
      confirmClose(p: string, opts?: any) {
        const isSwitch = !!(opts && opts.isSwitch);
        const blockers: any[] = [];
        // dirty blocker：切换 tab 时跳过——编辑内容由 editorCache 保留，切回可继续；
        // 仅真正关闭（丢弃）时需要确认
        if (dirtyMap[String(p)] && !isSwitch) blockers.push({
          id: "unsaved",
          title: "文件有未保存的修改",
          actions: ["save", "discard"], // 保存并关闭 / 不保存关闭 / 取消（cancel 总是有）
          onSave: () => { _cacheDrop(String(p)); },   // 保存并关闭：已持久化，丢弃缓存
          onDiscard: () => { _cacheDrop(String(p)); }, // 不保存关闭：丢弃缓存
        });
        if (blockers.length === 0) {
          // 真正关闭（非切换）→ 标记：卸载时从 session 移除；切换（isSwitch）不标记
          if (!isSwitch) (w.__aitiEditor._sessionRemoveMark as any)[String(p)] = true;
          return true;
        }
        return new Promise((resolve) => {
          const pStr = String(p);
          const list = [...askCloseHandlers.values()];
          // 派发优先级：该 path 且可见 > 任一可见 > 该 path（隐藏）> 任意——
          // 弹层尽量落在用户看得见的编辑器（keep-alive 下挂载着的编辑器大多是隐藏态）
          const target =
            list.find((r) => r.path === pStr && (!r.isVisible || r.isVisible())) ??
            list.find((r) => !r.isVisible || r.isVisible()) ??
            list.find((r) => r.path === pStr) ??
            list[0];
          if (!target) resolve(true); // 无编辑器 UI 时放行（由宿主兜底，不阻塞）
          else target.handle(pStr, blockers, resolve);
        });
      },
      /** 内部：真正关闭放行后标记（EditorApp 在 closeAsk(true) 调用）；切换不标记 */
      _markSessionRealClose(p: string) { (w.__aitiEditor._sessionRemoveMark as any)[String(p)] = true; },
      _isSessionRealClose(p: string) { return !!(w.__aitiEditor._sessionRemoveMark as any)[String(p)]; },
      /** 内部：dirty 状态上报（EditorApp 维护） */
      _setDirty(p: string, d: boolean) { if (d) { dirtyMap[String(p)] = true; _autoSaveSchedule(String(p)); } else delete dirtyMap[String(p)]; },
      /** 内部：EditorApp 注册自绘确认 UI（关闭问答在 editor 内展示）；卸载必须走 _clearAskCloseHandler 只删自己 */
      _setAskCloseHandler(h: any, meta?: { path?: string; isVisible?: () => boolean }) {
        askCloseHandlers.set(h, { path: meta?.path ?? "", handle: h, isVisible: meta?.isVisible });
      },
      /** 内部：属主注销——只删自己这份注册，不碰其他编辑器（修单例误清，§9.3） */
      _clearAskCloseHandler(h: any) { askCloseHandlers.delete(h); },
      /** 内部：编辑内容缓存（切回继续编辑 / 磁盘变更检测） */
      _cacheGet,
      _cacheSet, _writeServerCache, _hashContent, loadDmp,
      _cacheFetchFromServer,
      /** 重置服务端基线标记（缓存被删后，下次写用完整内容） */
      _resetServerBaseline(p: string) { delete _serverHasOriginal[String(p)]; },
      /** 钉住（不受容量逐出/批量关闭影响）：toggle 返回新状态 */
      isTabPinned(p: string) { return pinnedPaths.has(String(p)); },
      togglePin(p: string) {
        const s = String(p);
        if (pinnedPaths.has(s)) pinnedPaths.delete(s); else pinnedPaths.add(s);
        return pinnedPaths.has(s);
      },
      /** 保存某个已打开文件（从缓存内容写盘）——批量关闭时的「保存并关闭」用；返回是否成功 */
      async saveOpenFile(p: string): Promise<boolean> {
        const c = editorCache[String(p)];
        if (!c || typeof c.content !== "string") return false;
        try {
          const r = await fetch(getBase() + "/save", {
            method: "POST", cache: "no-store",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              filePath: String(p), content: c.content,
              encoding: c.encoding || "utf-8", hasBOM: c.hasBOM === true,
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return false;
          c.baseMtimeMs = d.mtimeMs || Date.now();
          c.original = c.content; // 保存即新基线
          delete dirtyMap[String(p)];
          return true;
        } catch { return false; }
      },
      _startAutoSave, _stopAutoSave,
      _cacheWriteBlockAt,
      _registerCacheListener(fn: (msg: any) => void) { cacheUpdateListeners.add(fn); },
      _unregisterCacheListener(fn: (msg: any) => void) { cacheUpdateListeners.delete(fn); },
      // 内部使用
      _resolve: resolve,
      _resolveProviders: resolveProviders,
      _isText: isTextFile,
      _isViewableBinary: isViewableBinary,
      _detectFileType: detectFileType,
      _getEditor: () => editorRefHolder.ref && editorRefHolder.ref.current,
      _getActions: () => [...actions],
      _getServices: (lang: string) => services[lang] || null,
    };
    // 暴露 _bc 供跨 tab 广播（'delete' 重建缓存后通知）——必须在 window.__aitiEditor
    // 赋值之后（此前 defineProperty 目标是 undefined → 抛错导致整个 register 中断）
    Object.defineProperty(w.__aitiEditor, '_bc', { get: () => _bc, configurable: true });

    // 服务端偏好异步加载（事件驱动，无轮询）：就绪后 fireActiveChange 驱动重排
    initPrefs();
  }

  // ── session 墓碑制：记录 sessionId（供 EditorApp 记录打开/关闭文件用）──
  const STORAGE_KEY = "aiti-editor:session-id";
  // 统一会话服务（pi-web.session）：active 时取 root/canonical id 并回写墓碑；
  // 未确立/失效时退回墓碑/anon——不再直读 URL ?session=（未验证 id 会对已删除会话
  // 产生幻影请求）。getter 形式：服务晚到时（materialize 早于 active）自动跟随。
  function currentSid(): string {
    const svcId = getRootSessionId();
    if (svcId) {
      try { localStorage.setItem(STORAGE_KEY, svcId); } catch { /* ignore */ }
      return svcId;
    }
    let stored: string | null = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
    if (stored) return stored;
    const anon = "anon-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
    try { localStorage.setItem(STORAGE_KEY, anon); } catch { /* ignore */ }
    return anon;
  }
  const w2 = window as any;
  Object.defineProperty(w2.__aitiEditor, '_sessionId', { get: () => currentSid(), configurable: true });
  // 对外暴露 session 恢复方法（供 AppShell 打开文件区时调用）
  w2.__aitiEditor._restoreSession = async () => {
    if (w2.__aitiEditor._sessionRestored) return;
    w2.__aitiEditor._sessionRestored = true;
    try {
      const r = await fetch(base + "/session-files?sessionId=" + encodeURIComponent(currentSid()) + "&t=" + Date.now(), { cache: "no-store" });
      const d = await r.json();
      if (d.ok && d.files && d.files.length > 0) {
        for (let i = 0; i < d.files.length; i++) {
          const entry = d.files[i];
          const p = typeof entry === "string" ? entry : entry?.path;
          const kind = typeof entry === "string" ? "file" : (entry?.kind || "file");
          if (!p) continue;
          setTimeout(() => {
            try {
              // 一律后台打开：调用时机是用户刚显式打开某个文件/文件夹 tab，
              // 焦点必须留给它，不能被历史列表第一个（i===0 select:true）抢走
              if (kind === "folder") ctx.openFolder?.(p, undefined, { select: false });
              else ctx.openFile?.(p, undefined, { select: false });
            } catch {}
          }, 50 + i * 30);
        }
      }
    } catch { /* session 恢复失败不阻塞 */ }
  };

  // ── 内置注册：语言表 + 文本 provider ──
  for (const [ext, id] of Object.entries(LANG_EXT)) {
    w2.__aitiEditor.registerLanguage({ id, extensions: [ext] });
  }
  // 文本 provider（通用，priority default，匹配所有非二进制）
  w2.__aitiEditor.registerEditorProvider({
    id: "aiti-editor.text",
    displayName: "Text Editor",
    selector: ["**"], // ** 匹配所有路径（含 /）
    priority: "default",
    supportsEdit: true,
    about: {
      summary: "Monaco 在线文本/代码编辑器（含 Markdown 双模式）",
      capabilities: [
        "语法高亮与补全（40+ 语言，TS/JS 智能提示、JSON 大纲、CSV 彩虹列）",
        "Markdown 编辑 / 分栏 / 预览（GFM、TOC、滚动同步、变更块定位、导出 HTML/PDF）",
        "HTML 编辑 / 分栏 / 预览（快速态看缓冲、真预览态走目录级预览路由；视口预设、报错回传、相对链接改道 dock）",
        "多编码打开与保存（UTF-8 / UTF-16 / GBK / Latin-1，含 BOM）",
        "保存冲突检测（外部修改 → 409 → 合并或覆盖）",
        "git 变更视图（工作区 vs HEAD：行级标注 / 左右 / 合并 / 大纲）",
        "未保存内容自动缓存（停手 2s + 页面关闭兜底，刷新后恢复）",
        "AI 选区（问 AI / 解释 / 重构 / 新会话）、@ 提及、同目录 ‹› 遍历",
        "YAML / TOML / SQL 一键格式化",
      ],
      limits: [
        "单文件超过 1MB 只读",
        "二进制文件不接管（交给对应查看器 / 编辑器扩展）",
      ],
      vendor: "Monaco Editor (MIT)",
    },
  });

  // ── 语言服务桥示例（M4）：JSON 大纲（顶层键树）+ 空值补全 ──
  w2.__aitiEditor.registerLanguageService({
    languageId: "json",
    triggerCharacters: ["."],
    outline: (model: any) => {
      const text = model.getValue();
      const symbols: any[] = [];
      for (let i = 0; i < text.split("\n").length; i++) {
        const ln = text.split("\n")[i];
        const trimmed = ln.trim();
        if (!trimmed || trimmed === "{" || trimmed === "[" || trimmed === "}" || trimmed === "]") continue;
        const keyMatch = trimmed.match(/^"([^"]+)"\s*:/);
        if (!keyMatch) continue;
        symbols.push({
          name: keyMatch[1],
          kind: "Property",
          range: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: ln.length + 1 },
          selectionRange: { startLineNumber: i + 1, startColumn: 1, endLineNumber: i + 1, endColumn: ln.length + 1 },
        });
      }
      return symbols;
    },
    completion: (text: string, line: number, col: number) => {
      const lineText = text.split("\n")[line - 1] || "";
      const prefix = lineText.slice(0, col - 1);
      if (/"[a-zA-Z_]*$/.test(prefix)) {
        return [
          { label: "key", kind: "Property", insertText: "\"key\": \"\"", detail: "JSON 键" },
          { label: "value", kind: "Value", insertText: "\"value\"", detail: "JSON 值" },
        ];
      }
      return [];
    },
  });

  // ── 语言服务注册：TOML / CSV / YAML（js-yaml vendor 懒加载）/ SQL（sql-formatter vendor 懒加载）──
  w2.__aitiEditor.registerLanguageService({ languageId: "toml", format: (text: string) => formatToml(text) });
  w2.__aitiEditor.registerLanguageService({ languageId: "csv", format: (text: string) => formatCsv(text) });

  w2.__aitiEditor.registerLanguageService({
    languageId: "yaml",
    format: (text: string) => {
      // 首次调用触发懒加载（后续格式化生效），首次直接返回原文本
      if (!(window as any).jsyaml) { loadJsYaml(); return text; }
      try {
        const doc = (window as any).jsyaml.load(text);
        if (doc === undefined || doc === null) return text;
        return (window as any).jsyaml.dump(doc, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: true });
      } catch { return text; }
    },
  });

  let _sqlFmtPromise: Promise<any> | null = null;
  const loadSqlFormatter = (): Promise<any> => {
    if ((window as any).sqlFormatter) return Promise.resolve((window as any).sqlFormatter);
    if (_sqlFmtPromise) return _sqlFmtPromise;
    _sqlFmtPromise = loadVendorGlobal(base + '/assets/vendor/sql-formatter.min.js', 'sqlFormatter');
    return _sqlFmtPromise;
  };
  w2.__aitiEditor.registerLanguageService({
    languageId: "sql",
    format: (text: string) => {
      if (!(window as any).sqlFormatter) { loadSqlFormatter(); return text; }
      try {
        return (window as any).sqlFormatter.format(text, { language: 'sql', tabWidth: 2 });
      } catch { return text; }
    },
  });

  // ── 注册内置二进制文件渲染 provider（图片/视频/音频/PDF/压缩包）──
  const BINARY_PROVIDERS = [
    {
      id: "aiti-editor.image",
      displayName: "Image Viewer",
      selector: { extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".heic", ".svg"] },
      priority: "default",
      supportsEdit: false,
      about: {
        summary: "原生图片查看器",
        capabilities: ["缩放 / 平移 / 100% 复位", "EXIF 信息读取"],
        limits: ["仅浏览器可解码的格式", "只读"],
        vendor: "浏览器原生 <img>",
      },
    },
    {
      id: "aiti-editor.video",
      displayName: "Video Player",
      selector: { extensions: [".mp4", ".webm", ".avi", ".mov", ".mkv"] },
      priority: "default",
      supportsEdit: false,
      about: {
        summary: "原生视频播放器",
        capabilities: ["Range 流式播放（拖进度条不整载）", "时长显示", "文件变化实时跟随（watch）"],
        limits: ["取决于浏览器解码器（mp4/webm/ogg 系友好；部分 .avi/.mkv 可能无法解码）", "只读"],
        vendor: "浏览器原生 <video>",
      },
    },
    {
      id: "aiti-editor.audio",
      displayName: "Audio Player",
      selector: { extensions: [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".mid"] },
      priority: "default",
      supportsEdit: false,
      about: {
        summary: "原生音频播放器",
        capabilities: ["流式播放", "时长显示", "文件变化实时跟随（watch）"],
        limits: ["取决于浏览器解码器（.mid 多数浏览器不可播）", "只读"],
        vendor: "浏览器原生 <audio>",
      },
    },
    {
      id: "aiti-editor.pdf",
      displayName: "PDF Viewer",
      selector: { extensions: [".pdf"] },
      priority: "default",
      supportsEdit: false,
      about: {
        summary: "PDF 只读预览",
        capabilities: ["浏览器内置 PDF 引擎渲染"],
        limits: ["只读（编辑 / 批注请用专业 PDF 工具）"],
        vendor: "浏览器原生 <iframe>",
      },
    },
    {
      id: "aiti-editor.archive",
      displayName: "Archive Viewer",
      selector: { extensions: [".zip", ".tar", ".tgz", ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".7z", ".rar", ".cab", ".iso", ".wim", ".dmg"] },
      priority: "default",
      supportsEdit: false,
      about: {
        summary: "压缩包浏览（纯 JS 优先 + 7-Zip 兜底）",
        capabilities: ["zip/tar/7z/rar/cab/iso 等列出清单", "压缩包内文件点击提取并打开", "7za 缺失时自动下载 portable 版（客户机零安装）"],
        limits: ["加密 / 带密码压缩包不支持", "只读（解包请用命令行）"],
        vendor: "yauzl / tar-stream / 7-Zip (LGPL)",
      },
    },
  ];
  for (const bp of BINARY_PROVIDERS) {
    w2.__aitiEditor.registerEditorProvider(bp);
  }

  // ── 内建：老格式（.doc/.ppt/odt/odp）→ soffice 转 PDF 只读预览（方案矩阵：读 ✅ 写 ❌，编辑引导 docx 化）──
  w2.__aitiEditor.registerEditorProvider({
    id: "aiti-editor.doc-pdf",
    displayName: "旧格式转 PDF 预览",
    sourceExt: "aiti-editor",
    selector: { extensions: [".doc", ".ppt", ".pptx", ".odt", ".odp"] },
    priority: "default",
    capabilities: ["preview"],
    supportsEdit: false,
    about: {
      summary: "老格式（.doc / .ppt / .pptx / .odt / .odp）经 soffice 转 PDF 只读预览",
      capabilities: ["PDF 只读预览（浏览器原生渲染，可缩放 / 打印 / 下载）", "转换结果按 mtime 键控缓存——二次打开秒开", "单文件上限 50MB"],
      limits: [
        "只读：编辑请先另存 / 转换为 .docx（Word）",
        "首次打开需数秒（soffice 无头转换）；排版保真取决于 LibreOffice 对原格式的还原度",
        "并发转换时会提示稍后重试",
      ],
      vendor: "LibreOffice headless (MPL-2.0)",
    },
    render(host: any, ctx: { filePath: string }) {
      const el = document.createElement("div");
      el.style.cssText = "position:relative;display:flex;flex-direction:column;height:100%;background:var(--bg,#fff);overflow:hidden;";
      let panelEl: HTMLElement | null = null;
      const showSofficePanel = () => {
        if (panelEl) return;
        panelEl = buildSofficeMissingPanel({
          apiUrl: (p: string) => apiUrl(p),
          filePath: ctx.filePath,
          targetLabel: "PDF",
          onClose: () => { try { panelEl?.remove(); } catch { /* 忽略 */ } panelEl = null; },
        });
        el.appendChild(panelEl);
      };
      // soffice 预检：缺失 → 降级面板（安装/配置指引 + 下载/虚拟环境替代），不进转换流程
      fetchSofficeStatus((p) => apiUrl(p)).then((st) => {
        if (st && st.available === false) showSofficePanel();
      }).catch(() => { /* 状态不可达：保持原流程，失败时同样降级 */ });
      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;color:var(--text-dim,#888);border-bottom:1px solid var(--border,#e0e0e0);flex-shrink:0;";
      const tipSpan = document.createElement("span");
      tipSpan.style.flex = "1 1 auto";
      tipSpan.textContent = "旧格式只读预览（soffice 转 PDF）";
      bar.appendChild(tipSpan);
      const convBtn = document.createElement("button");
      convBtn.type = "button";
      const isDoc = /\.doc$/i.test(ctx.filePath);
      if (isDoc) {
        convBtn.textContent = "转为 .docx 并打开";
        convBtn.title = "后台转换为同名 -fromdoc.docx 副本（不覆盖原文件与已有文件）并自动打开";
        convBtn.style.cssText = "padding:2px 10px;font-size:11px;font-weight:600;border:1px solid var(--border,#d0d0d0);border-radius:6px;background:var(--bg,#fff);cursor:pointer;color:var(--text,#1a1a1a);font-family:inherit;";
        convBtn.onclick = async () => {
          convBtn.disabled = true;
          convBtn.textContent = "转换中…";
          try {
            const r = await fetch(getBase() + "/convert-saveas", {
              method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
              body: JSON.stringify({ filePath: ctx.filePath }),
            }).then((x: any) => x.json());
            if (!r.ok) throw new Error(r.error || "转换失败");
            tipSpan.textContent = "已创建 " + String(r.newPath || "").split("/").pop() + "，正在打开…";
            try { (window as any).__aitiEditor?.openFile(r.newPath); } catch { /* 打开失败静默 */ }
          } catch (e: any) {
            convBtn.disabled = false;
            convBtn.textContent = "转为 .docx 并打开";
            tipSpan.textContent = "转换失败：" + String((e && e.message) || e);
            showSofficePanel();
          }
        };
        bar.appendChild(convBtn);
      }
      const wrap = document.createElement("div");
      wrap.style.cssText = "flex:1;min-height:0;position:relative;";
      const loading = document.createElement("div");
      loading.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--text-muted,#888);font-size:13px;background:var(--bg,#fff);";
      loading.textContent = "正在转换（soffice）…首次约需数秒";
      const frame = document.createElement("iframe");
      frame.title = "doc-pdf-preview";
      frame.style.cssText = "width:100%;height:100%;border:none;opacity:0;";
      frame.onload = () => { frame.style.opacity = "1"; try { loading.remove(); } catch { /* 忽略 */ } };
      wrap.append(loading, frame);
      el.append(bar, wrap);
      let dead = false;
      let blobUrl = "";
      (async () => {
        try {
          const ticket = await ensureEditorTicket(ctx.filePath);
          const r = await fetch(getBase() + "/t/" + ticket + "/doc-pdf", { cache: "no-store" });
          if (dead) return;
          if (!r.ok) {
            const d = await r.json().catch(() => ({} as any));
            loading.textContent = d.error || "转换失败 (" + r.status + ")";
            loading.style.color = "var(--danger, #f87171)";
            return;
          }
          const ct = r.headers.get("content-type") || "";
          if (!ct.includes("pdf")) { loading.textContent = "转换结果异常（非 PDF）"; loading.style.color = "var(--danger, #f87171)"; return; }
          blobUrl = URL.createObjectURL(await r.blob());
          frame.src = blobUrl;
        } catch (e: any) {
          if (!dead) { loading.textContent = String((e && e.message) || e); loading.style.color = "var(--danger, #f87171)"; }
        }
      })();
      return {
        el,
        dispose() {
          dead = true;
          if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* 忽略 */ } }
        },
      };
    },
  });

  // ── 内置注册：md 围栏渲染器（md-plugins M0）——mermaid 降级为第一个经点注册的消费者（dogfood）。
  //    必须早于晚到队列 flush：内置恒 priority:"default" 且占首位 ⇒ 同优先级平局内置赢。 ──
  w2.__aitiEditor.registerMdRenderer(mermaidRenderer);

  // ── 晚到 provider 缓冲重放（§1.5）：aiti-editor 晚于实现扩展加载时，实现扩展把
  //    注册函数推进 __aitiEditorQueue；这里注册表就绪后排空队列，再广播 registry-ready。
  //    必须在内置注册之后 flush：第三方 provider 同 priority 时排在内置之后（注册序）。 ──
  const lateQueue = (w2 as any).__aitiEditorQueue;
  if (Array.isArray(lateQueue)) {
    (w2 as any).__aitiEditorQueue = [];
    for (const fn of lateQueue) {
      if (typeof fn !== "function") continue;
      try { fn(); } catch (e) { console.error("[aiti-editor] 队列注册失败:", e); }
    }
  }
  try { window.dispatchEvent(new CustomEvent("aiti-editor:registry-ready")); } catch { /* 忽略 */ }
}

// ── js-yaml vendor 懒加载（模块级单例；YAML 诊断/格式化共用）──
let _jsyamlPromise: Promise<any> | null = null;
export function loadJsYaml(): Promise<any> {
  if ((window as any).jsyaml) return Promise.resolve((window as any).jsyaml);
  if (_jsyamlPromise) return _jsyamlPromise;
  _jsyamlPromise = loadVendorGlobal(getBase() + '/assets/vendor/js-yaml.min.js', 'jsyaml');
  return _jsyamlPromise;
}

/**
 * 围栏渲染器描述符（预览 srcdoc 构建期用：每语言生效者的 lang + 已按主题求值的 css）。
 * markdown.ts 自身零 window 依赖（node --test 可直测），故单例读取集中在这里。
 */
export function mdFenceDescriptors(dark: boolean): Array<{ lang: string; css: string }> {
  const we: any = (window as any).__aitiEditor;
  try { return typeof we?.mdFenceDescriptors === "function" ? we.mdFenceDescriptors(dark) : []; } catch { return []; }
}

// 语言推断（从注册表查）
export function detectLanguage(fp: string): string {
  const we: any = (window as any).__aitiEditor;
  const resolved = we?._resolve?.(fp);
  if (resolved && resolved.languageId) return resolved.languageId;
  const ext = fp.split(".").pop()?.toLowerCase() || "";
  return LANG_EXT[ext] || "plaintext";
}

// 接管判定：命中队列非空即接管（§1.6）；文本 / 可渲染二进制兑底。纯逻辑在 arbiter.shouldTakeover
export function canTakeover(fp: string): boolean {
  const we: any = (window as any).__aitiEditor;
  return shouldTakeover({
    chainLength: (we?._resolveProviders?.(fp) || []).length,
    isText: we._isText(fp),
    isViewableBinary: we._isViewableBinary(fp),
  });
}
