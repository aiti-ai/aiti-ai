/**
 * Draft Keeper（aiti-draft-keeper）client 薄壳。
 *
 * 职责只剩装配：window/localStorage 适配、hydration 门控、ctx 接线、
 * DraftApi 注册。全部草稿语义在 ./core.mjs 的状态机（唯一所有者）——
 * core（pi-web）只发意图（applyIntent）或经 enhancement 回调喂快照，
 * 不再直接 clearDraft/rekeyDraft（竞态源头已收敛进状态机）。
 *
 * 兼容：DraftApi 保留 v1 方法（saveDraft/clearDraft/rekeyDraft/restoreSubmission，
 * 标记 deprecated）——部署顺序无关：旧 core + 新 keeper 仍可工作；新 core 的
 * applyDraftIntent 检测 applyIntent 存在即走新路径。
 */

import { createKeeperCore } from "./core.mjs";

const PREFIX = "crashrestore-";

function dbg(msg) {
  try {
    if (localStorage.getItem("__keeperDebugOn") !== "1") return;
    const logArr = JSON.parse(localStorage.getItem("__keeperDebug") || "[]");
    logArr.push({ at: Math.round(performance.now()), msg: String(msg).slice(0, 140) });
    localStorage.setItem("__keeperDebug", JSON.stringify(logArr.slice(-40)));
  } catch { /* ignore */ }
}

/** 等宿主水合完成（pi-web AppShell 挂载后置 __piWebHydrated + 派发事件）。
 *  水合前恢复进框会被 hydration 重渲染按服务端 HTML（空框）抹掉。8s 兜底放行。 */
function whenHydrated(cb) {
  if (typeof window === "undefined") { cb(); return; }
  if (window.__piWebHydrated) { cb(); return; }
  const h = () => { window.removeEventListener("pi-web:hydrated", h); cb(); };
  window.addEventListener("pi-web:hydrated", h);
  setTimeout(() => { window.removeEventListener("pi-web:hydrated", h); cb(); }, 8000);
}

export default function register(ctx) {
  // 契约防御：宿主 core 缺少 composer 契约（未同步的旧 core）→ 不启用，避免崩溃
  if (typeof ctx.registerComposerEnhancement !== "function") return;
  // 接管语义：hydration 失配后扩展客户端会重新执行 → 旧实例状态过期。新实例先
  // 解散旧实例，以全新状态接管；ChatInput 的增强器集合变化补发会让新实例追上。
  if (typeof window !== "undefined" && window.__draftKeeperDisposer) {
    try { window.__draftKeeperDisposer(); } catch { /* ignore */ }
    window.__draftKeeperDisposer = null;
  }
  return setup(ctx);
}

function setup(ctx) {
  const storage = {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
    keys: () => {
      const out = [];
      for (let i = localStorage.length - 1; i >= 0; i--) out.push(localStorage.key(i));
      return out;
    },
  };

  // 写框（hydration 门控内）：优先受控恢复（含图片），退化为纯文本写值
  let hydrated = typeof window !== "undefined" && !!window.__piWebHydrated;
  const writeBox = (draft) => {
    let ok = false;
    if (typeof ctx.restoreComposerDraft === "function") {
      ok = ctx.restoreComposerDraft({ value: draft.value, images: draft.images }) === true;
    } else if (typeof ctx.writeComposerValue === "function") {
      ok = ctx.writeComposerValue(draft.value) === true;
    }
    return ok;
  };
  const onRestore = (draft) => {
    if (hydrated) return writeBox(draft);
    whenHydrated(() => { hydrated = true; writeBox(draft); });
    return true; // 已受理（挂起等水合），staged 补偿由状态机经 onChange 快照负责
  };

  const core = createKeeperCore({ storage, onRestore, log: dbg });
  core.pruneStale(); // 启动时一次性清理过期残留（非轮询）

  // 页面关闭/隐藏前强制落盘未 debounce（300ms 内）的草稿
  const flush = () => core.flushAll();
  const onVisibility = () => { if (document.visibilityState === "hidden") flush(); };
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
  }

  const dispose = () => {
    core.dispose();
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    }
    if (typeof ctx.registerDraftApi === "function") ctx.registerDraftApi(null);
  };

  const offEnh = ctx.registerComposerEnhancement({
    id: "aiti-draft-keeper",
    onChange: (snap) => {
      try { core.onChange(snap); } catch (e) { console.error("[draft-keeper] onChange error:", e); }
    },
    onKeyChange: (prev, next) => {
      try { core.onKeyChange(prev, next); } catch (e) { console.error("[draft-keeper] onKeyChange error:", e); }
    },
  });

  // 草稿存储 API：core 经 getDraftApi() 访问。applyIntent 是唯一写入口；
  // v1 方法 deprecated（部署顺序兼容，仅未升级的旧 core 会调）。
  if (typeof ctx.registerDraftApi === "function") {
    ctx.registerDraftApi({
      getDraft: (key) => core.getDraft(key),
      clearAllDrafts: (sid) => core.clearAllDrafts(sid),
      flushAll: () => core.flushAll(),
      applyIntent: (intent) => core.applyIntent(intent),
      // ---- deprecated v1 ----
      saveDraft: (key, draft) => core.saveDraft(key, draft),
      clearDraft: (key) => core.clearDraft(key),
      rekeyDraft: (prev, next, currentDraft) => core.rekeyDraft(prev, next, currentDraft),
      restoreSubmission: (key, text, images) => core.restoreSubmission(key, text, images),
    });
  }

  if (typeof window !== "undefined") window.__draftKeeperDisposer = dispose;
  return dispose;
}
