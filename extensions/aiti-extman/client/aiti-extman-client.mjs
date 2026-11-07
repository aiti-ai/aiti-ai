/**
 * aiti-extman client bundle — prebuilt ESM（与 aiti-prompts 同模式：host 传 h/useState/useEffect/t/apiUrl）
 *
 * UI（参考 VS Code 扩展面板）：
 *   - toolbar：🧩 扩展按钮 → 打开管理面板（唯一入口）
 *   - 左列表上方：搜索框。空搜索 = 本地扩展（启用在前、禁用排后）；
 *     有搜索 = 合并结果：本地命中（已安装标记）在前 + 在线注册表命中（直接安装按钮）在后；
 *     搜索内容形如来源（git:/npm:/https://…）时，首行给「从来源安装」快捷项。
 *   - 右详情：本地扩展（启停/版本/目录/插入点/依赖/能力/来源地址/卸载）
 *             或在线条目（描述/版本/类型/文档链接/安装按钮）
 *   - 变更后 ctx.reloadExtensions() 刷新宿主 manifest + client bundles（optional 兼容旧宿主）
 */

// ---------- 模块级状态（跨组件共享；listener 模式） ----------
const state = {
  open: false,
  status: null,        // /status 载荷 { extensions: {id: entry}, extensionsRoot, ... }
  loader: { materialized: [], prefetched: [] },
  selected: null,      // { kind: "local"|"online"|"source"|"add", id }
  hoverLocal: null,    // 本地列表悬停行 id（悬停显示启停开关）
  q: "",               // 搜索词（空 = 只显示本地）
  busyKey: null,       // `${action}:${id}` | "*"
  error: null,
  message: null,
  registryData: null,  // aiti.pw /extensions.json
  registryError: null,
  registryLoaded: false,
  isMobile: false,
  // VSCode 式 trust：待确认的发行者（{kind:"source"|"zip", source, docsUrl?, id?, publisher, file?, zipName?}）
  pendingTrust: null,
  // 已信任发行者列表 [{name,url,source,trustedAt}]（管理 UI + 信任状态展示）
  trustedPublishers: [],
  trustedLoaded: false,
  // 功能打开提示（打开/定位结果；自动消失）
  openHint: null,
  // 小屏面板行为：listCollapsed=扩展列表折叠（给详情区让空间）；maximized=全屏展开（小屏打开默认开）。
  // mobileView：小屏导航视图——list=列表，detail=详情（点击扩展时切换，带返回按钮）
  listCollapsed: false,
  maximized: false,
  mobileView: "list",
  // 层级管理：打开其他弹窗后把自己降到后面（新弹窗置前），zBack=true 时面板 z-index 降到 300；可手动置顶恢复
  zBack: false,
};
const listeners = new Set();
function notify() { for (const l of listeners) l(); }
function setState(patch) { Object.assign(state, patch); notify(); }

// register 时绑定的宿主能力。
let H = null, useState_, useEffect_, useRef_, T = null, API = null, ctxReload = null, ctxLoaderState = null;
// 当前会话（dialogs 插槽经 ExtRenderProps.currentSession 传入，渲染时顺手记下；context 插槽打开时的上下文）
let currentSessionVal = null;

// lucide 渲染（与系统内建线条图标同风格）：扩展自声明 icon（index.ts 存 path 数组）→ SVG
// 扩展图标渲染：icon 是相对扩展目录的图标文件（如 icon.svg，扩展自声明）→ 资产 URL + CSS mask（颜色跟随 currentColor）；否则按 emoji/文本显示
function extIconSpan(ext, size, id) {
  const extId = id || (ext && ext.id);
  if (ext && typeof ext.icon === "string" && ext.icon.endsWith(".svg") && extId) {
    const url = API("/api/extensions/" + extId + "/assets/" + ext.icon);
    return H("span", { "aria-hidden": true, style: { display: "inline-block", width: size, height: size, flexShrink: 0, verticalAlign: "middle", background: "currentColor", maskImage: "url(" + url + ")", WebkitMaskImage: "url(" + url + ")", maskRepeat: "no-repeat", maskPosition: "center", maskSize: "contain" } });
  }
  return ext && ext.icon ? ext.icon : "📦";
}

// 自我保护：管理器不允许禁用/卸载自己（服务端 ops 同样拒绝）。
const SELF_ID = "aiti-extman";

const AITI_DOCS_BASE = "https://aiti.pw";
const AITI_REGISTRY_PAGE = AITI_DOCS_BASE + "/extensions/";

const SOURCE_LABELS = { user: "user", extra: "extra", dev: "dev", bundled: "bundled" };
const SOURCE_COLORS = {
  user: "rgba(99,102,241,0.85)",
  extra: "rgba(14,165,233,0.85)",
  dev: "rgba(217,119,6,0.85)",
  bundled: "rgba(120,120,120,0.9)",
};

const btnStyle = {
  padding: "5px 12px", background: "var(--bg-hover)", borderWidth: "1px", borderStyle: "solid", borderColor: "var(--border)",
  borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
};
const chipStyle = (color, bg) => ({
  fontSize: 10, padding: "1px 6px", borderRadius: 8, background: bg, color, whiteSpace: "nowrap", flexShrink: 0,
});

function shortenPath(p) { return String(p ?? "").replace(/^\/(?:Users|home)\/[^/]+/, "~"); }

function statusDotColor(e) {
  if (e.error) return "var(--danger, #ef4444)";
  if (e.enabled === false) return "var(--text-dim)";
  if (!e.loaded) return "var(--warn, #f59e0b)";
  return "var(--accent)";
}

/** 状态点悬浮提示（与 statusDotColor 对应）。 */
function statusDotTitle(e) {
  if (e.error) return "状态：异常";
  if (e.enabled === false) return "状态：已停用";
  if (!e.loaded) return "状态：未加载";
  return "状态：运行中";
}

/** 搜索词是否像一个安装来源（git: / npm: / https git / git@ / 本地路径 / @scope/pkg）。 */
function looksLikeSource(q) {
  const s = q.trim();
  if (!s) return false;
  if (/^(git:|npm:|https?:\/\/|git@)/i.test(s)) return true;
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || /^[A-Za-z]:[\\/]/.test(s)) return true;
  if (/^@[A-Za-z0-9-][\w.-]*\//.test(s)) return true; // @scope/pkg
  return false;
}

/** 发行者是否已信任（有名按 name，未知按 fingerprint）。 */
function publisherTrusted(pub) {
  if (!pub) return false;
  const k = (pub.name && pub.name.trim()) || pub.fingerprint;
  return (state.trustedPublishers || []).some((t) => ((t.name && t.name.trim()) || t.fingerprint) === k);
}

async function refreshTrusted() {
  try {
    const r = await fetch(API("/api/extensions/aiti-extman/publishers"), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    setState({ trustedPublishers: d.trusted || [], trustedLoaded: true });
  } catch (e) {
    setState({ trustedPublishers: state.trustedPublishers || [], trustedLoaded: true });
  }
}

/** 发行者来源中文标签。 */
function publisherSourceLabel(src) {
  const map = { npm: "npm", github: "GitHub", gitlab: "GitLab", git: "git", "package.json": "package.json", registry: "registry", manual: "manual", unknown: "?" };
  return map[src] || src || "package.json";
}

/** 显示一条自动消失的提示（功能打开结果 / 上下文提示）。 */
function showOpenHint(text, ms) {
  setState({ openHint: { text, at: Date.now() } });
  setTimeout(() => {
    // 只清掉自己那条（并发提示不互相误删）
    if (state.openHint && state.openHint.text === text) setState({ openHint: null });
  }, ms || 2600);
}

/** 按 label/title/文本找页面上可点击元素（通用 fallback 触发；contains 宽松匹配）。 */
function findButtonByLabel(label, { contains = false } = {}) {
  if (!label) return null;
  const norm = String(label).trim();
  const normL = norm.toLowerCase();
  const nodes = [...document.querySelectorAll("button, [role=button], [data-topbar-id]")];
  const exact = nodes.find((b) =>
    (b.getAttribute("title") || "") === norm ||
    (b.getAttribute("aria-label") || "") === norm ||
    (b.textContent || "").trim() === norm ||
    (b.getAttribute("data-topbar-id") || "").split(":").pop() === norm,
  );
  if (exact) return exact;
  if (!contains) return null;
  return nodes.find((b) =>
    ((b.getAttribute("title") || "") + " " + (b.getAttribute("aria-label") || "") + " " +
      (b.textContent || "") + " " + (b.getAttribute("data-topbar-id") || ""))
      .toLowerCase().includes(normL),
  ) || null;
}

/** 点击宿主顶栏条目（data-topbar-id 容器或其内 button）。 */
function clickTopbarEntry(el) {
  const btn = el.matches("button") ? el : el.querySelector("button") || el;
  btn.click();
}

/** 读宿主客户端注册表（window.__piWebExtUI）某扩展在某插槽的注册条目（含 meta.label/title，比 manifest 声明准确）。 */
function regItemsOf(slot, extId) {
  const store = typeof window !== "undefined" ? window.__piWebExtUI : undefined;
  const items = (store && store.items && store.items[slot]) || [];
  return items.filter((it) => it.extId === extId || (typeof it.id === "string" && it.id.indexOf(extId + ":") === 0));
}

function topbarRegs(extId) {
  return [...regItemsOf("toolbar", extId), ...regItemsOf("sessionTopbar", extId)];
}

/** 在元素上打短暂高亮并滚动到可见（定位"打开"结果的视觉反馈）。 */
function flashElement(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return;
  const prev = {
    outline: el.style.outline, outlineOffset: el.style.outlineOffset,
    boxShadow: el.style.boxShadow, transition: el.style.transition,
  };
  el.style.transition = "outline 0.15s, box-shadow 0.15s";
  el.style.outline = "2px solid rgba(217,119,6,0.9)";
  el.style.outlineOffset = "2px";
  el.style.boxShadow = "0 0 0 4px rgba(217,119,6,0.25)";
  try { el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch {}
  setTimeout(() => {
    el.style.outline = prev.outline;
    el.style.outlineOffset = prev.outlineOffset;
    el.style.boxShadow = prev.boxShadow;
    el.style.transition = prev.transition;
  }, 2200);
}

/** 会话级插槽的常驻 UI 定位元素（chatInputTop→输入区；sessionRowActions→当前会话行）。 */
function locateContextElement(slot, currentSession) {
  if (slot === "chatInputTop") {
    const input = document.querySelector("[data-chat-input]");
    if (input) return input.closest("div") || input;
    return null;
  }
  if (slot === "sessionRowActions") {
    if (!currentSession || !currentSession.cwd) return null;
    const cwd = currentSession.cwd;
    const short = cwd.replace(/^\/home\/[^/]+/, "~");
    const base = cwd.split("/").pop();
    const cands = [...document.querySelectorAll("div")].filter((d) => {
      const t = (d.textContent || "").replace(/\s+/g, " ");
      if (t.indexOf(cwd) === -1 && t.indexOf(short) === -1 && !(base && t.indexOf(base) !== -1)) return false;
      if (d.querySelectorAll("button").length === 0) return false;
      const r = d.getBoundingClientRect();
      return r.width > 30 && r.width < 420 && r.height > 10 && r.height < 200;
    });
    if (!cands.length) return null;
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    return cands[0];
  }
  return null;
}

/** 常驻插槽（pages/banners）的宿主渲染容器定位。 */
function locateSlotHost(slot) {
  if (slot === "banners") {
    const b = document.querySelector("[class*='banner'], [class*='Banner']");
    return b || null;
  }
  if (slot === "pages") {
    const main = document.querySelector("main, [class*='main'], [class*='Main']");
    return main || document.body;
  }
  return null;
}

/** 打开 ⋯ 溢出菜单并点扩展注册条目；命中调 onHit、失败调 onMiss（异步 120ms 后执行）。 */
function openTopbarOverflow(regs, label, where, onHit, onMiss) {
  const more = [...document.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "更多" || b.getAttribute("title") === "更多",
  );
  if (!more) { onMiss(); return; }
  const wasOpen = !!document.querySelector("[data-topbar-dropdown]");
  if (!wasOpen) more.click();
  setTimeout(() => {
    const menu = document.querySelector("[data-topbar-dropdown]");
    if (!menu) { if (!wasOpen) more.click(); onMiss(); return; }
    const keys = [label];
    for (const r of regs) {
      if (r && r.meta) {
        if (r.meta.title) keys.push(String(r.meta.title));
        if (r.meta.label) keys.push(String(r.meta.label));
      }
      if (r && r.id) keys.push(String(r.id).split(":").pop());
    }
    const hit = [...menu.querySelectorAll("[role=menuitem]")].find((mi) => {
      const btn = mi.querySelector("button");
      const hay = ((btn && (btn.getAttribute("title") || btn.getAttribute("aria-label") || "")) || "") +
        " " + (mi.textContent || "").replace(/\s+/g, " ");
      return keys.some((k) => k && hay.indexOf(k) !== -1);
    });
    const btn = hit && (hit.querySelector("button") || hit);
    if (btn) { btn.click(); onHit(); return; }
    if (!wasOpen) more.click();
    onMiss();
  }, 120);
}

/** 触发扩展顶栏入口：精确 data-topbar-id → 注册项同后缀优先 → 目标在 ⋯ 溢出则异步开菜单点它。
 *  所有路径自带反馈提示；返回是否已触发（溢出异步发起也视为触发）。 */
function openTopbarEntry(extId, item, label, where) {
  let el = document.querySelector('[data-topbar-id="' + (extId + ":" + item.id) + '"]');
  if (el) { clickTopbarEntry(el); showOpenHint(T("ext.slotOpened", { label })); dropToBack(); return true; }
  const regs = topbarRegs(extId);
  const want = item && item.id;
  // 优先注册 id 与声明 id 同后缀的项（声明↔注册可能不一致，同后缀才最可能是目标）
  const preferred = want ? regs.find((r) => String(r.id).split(":").pop() === want) : null;
  const target = preferred || regs[0];
  if (target) {
    el = document.querySelector('[data-topbar-id="' + target.id + '"]');
    if (el) { clickTopbarEntry(el); showOpenHint(T("ext.slotOpened", { label })); dropToBack(); return true; }
    // 目标在 ⋯ 溢出：异步开菜单点它
    openTopbarOverflow([target], label, where,
      () => { showOpenHint(T("ext.slotOpened", { label })); dropToBack(); },
      () => showOpenHint(T("ext.slotNoDirect", { where })),
    );
    return true;
  }
  return false;
}

/** 打开其他弹窗后把自己降到后面（新弹窗置前；面板头部「置于顶层」可恢复）。 */
function dropToBack() {
  if (!state.zBack) setState({ zBack: true });
}

/** 打开扩展的某个插槽功能：global 直接触发；context 以当前会话为上下文定位（滚动+高亮）。 */
function openSlotItem(extId, slot, item, currentSession) {
  const label = (item && (item.label || item.title || item.id)) || "";
  const where = (item && item.where) || slot;

  // 会话级插槽（chatInputTop / sessionRowActions 等）：无开关，是当前会话内的常驻 UI。
  // 打开 = 以当前会话为上下文，定位到功能实际位置（滚动 + 高亮），不再是死胡同提示。
  if (item && item.context === "context") {
    if (!currentSession) {
      showOpenHint(T("ext.slotNeedSession", { where }) + "：" + label);
      return;
    }
    const el = locateContextElement(slot, currentSession);
    if (el) {
      flashElement(el);
      showOpenHint(T("ext.slotLocated", { where }) + "：" + label);
    } else {
      showOpenHint(T("ext.slotNeedSession", { where }) + "：" + label);
    }
    return;
  }

  // toolbar / sessionTopbar：顶栏入口（行内 data-topbar-id → 注册项 → ⋯ 溢出）。
  if (slot === "toolbar" || slot === "sessionTopbar") {
    if (openTopbarEntry(extId, item, label, where)) return;
    const btn = findButtonByLabel(label, { contains: true });
    if (btn) { btn.click(); showOpenHint(T("ext.slotOpened", { label })); dropToBack(); return; }
    showOpenHint(T("ext.slotNoDirect", { where }));
    return;
  }

  // dialogs：弹窗由扩展入口按钮（通常是顶栏）开关——触发该入口打开面板。
  if (slot === "dialogs") {
    if (openTopbarEntry(extId, item, label, where)) return;
    const btn = findButtonByLabel(label, { contains: true });
    if (btn) { btn.click(); showOpenHint(T("ext.slotOpened", { label })); dropToBack(); return; }
    showOpenHint(T("ext.slotNoDirect", { where }));
    return;
  }

  // sidebar / sidebarFooter / 其他 global：按 label/title 找按钮点击。
  const btn = findButtonByLabel(label, { contains: true });
  if (btn) { btn.click(); showOpenHint(T("ext.slotOpened", { label })); return; }
  if (openTopbarEntry(extId, item, label, where)) return;

  // 常驻渲染（pages/banners）或无独立入口：定位到渲染位置（滚动 + 高亮）。
  const host = locateSlotHost(slot);
  if (host) {
    flashElement(host);
    showOpenHint(T("ext.slotLocated", { where }) + "：" + label);
    return;
  }
  showOpenHint(T("ext.slotNoDirect", { where }));
}

// ---------- 数据操作 ----------
async function refreshStatus() {
  try {
    const r = await fetch(API("/api/extensions/aiti-extman/status"), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    let sel = state.selected;
    if (!sel || sel.kind !== "local" || !d.extensions[sel.id]) {
      if (!sel || sel.kind !== "online") {
        const ids = Object.keys(d.extensions || {})
          .filter((id) => d.extensions[id].enabled !== false)
          .sort();
        sel = ids[0] || { kind: "local", id: Object.keys(d.extensions || {}).sort()[0] };
        if (sel) sel = { kind: "local", id: sel };
        else sel = null;
      }
    }
    setState({ status: d, selected: sel });
  } catch (e) {
    setState({ error: String(e && e.message || e) });
  }
}

function sortedLocalIds(status) {
  const exts = (status && status.extensions) || {};
  return Object.keys(exts).sort((a, b) => {
    const da = exts[a].enabled === false ? 1 : 0;
    const db = exts[b].enabled === false ? 1 : 0;
    return da - db || a.localeCompare(b);
  });
}

async function loadRegistry() {
  if (state.registryLoaded) return;
  try {
    const r = await fetch(API("/api/extensions/aiti-extman/registry"), { cache: "no-store" });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || "HTTP " + r.status);
    setState({ registryData: d, registryError: null, registryLoaded: true });
  } catch (e) {
    setState({ registryError: String(e && e.message || e), registryLoaded: true });
  }
}

async function runOp(action, extra) {
  const key = action + ":" + (extra && (extra.busyId || extra.id || extra.source) || "");
  setState({ busyKey: key, error: null, message: null });
  try {
    const r = await fetch(API("/api/extensions/aiti-extman/ops"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const d = await r.json();
    if (!r.ok && !d.needsTrust) throw new Error(d.error || "HTTP " + r.status);
    // VSCode 式 trust：发行者未信任 → 弹信任确认（不视为错误），确认后带 trust:true 重发。
    if (d.needsTrust) {
      setState({
        pendingTrust: {
          kind: "source",
          source: d.source || extra.source,
          docsUrl: d.docsUrl || extra.docsUrl,
          id: d.id,
          publisher: d.publisher,
          publisherHint: extra.publisherHint,
          zipName: d.zipName,
        },
        busyKey: null, error: null, message: null,
      });
      return;
    }
    if (d.error) throw new Error(d.error);
    // 响应带全量状态则直接采用（enable/disable 旧响应不带时退回主动拉取）。
    if (d.extensions) {
      let sel = state.selected;
      if (action === "install" && d.id) sel = { kind: "local", id: d.id };
      else if ((action === "remove" || action === "enable" || action === "disable") && d.id) sel = { kind: "local", id: d.id };
      if (!sel || (sel.kind === "local" && !d.extensions[sel.id])) {
        const ids = Object.keys(d.extensions || {}).filter((id) => d.extensions[id].enabled !== false).sort();
        sel = ids[0] ? { kind: "local", id: ids[0] } : null;
      }
      setState({ status: d, selected: sel });
    } else {
      await refreshStatus();
    }
    // 功能管理变更 → 经统一通知管道（window CustomEvent 总线）广播，扩展客户端监听后按 detail 更新（不轮询）
    if (action === "set-feature" && d && d.id && d.featureId) {
      const detail = (d.value !== undefined && typeof d.value === "string")
        ? { extId: d.id, featureId: d.featureId, value: d.value }
        : { extId: d.id, featureId: d.featureId, enabled: d.enabled !== false };
      try { window.dispatchEvent(new CustomEvent("pi-web:ext-features-changed", { detail })); } catch (e) {}
    }
    await syncClient();
    const msgs = {
      install: "ext.msgInstalled", remove: "ext.msgRemoved",
      enable: "ext.msgEnabled", disable: "ext.msgDisabled", reload: "ext.msgReloaded",
      "set-feature": "ext.msgFeatureSet",
      trust: "ext.msgTrusted", untrust: "ext.msgUntrusted",
    };
    setState({ message: T(msgs[action] || "ext.msgReloaded"), busyKey: null });
    if (action === "trust" || action === "untrust" || action === "install") void refreshTrusted();
  } catch (e) {
    setState({ error: String(e && e.message || e), busyKey: null });
  }
}

async function syncClient() {
  try { if (ctxReload) await ctxReload(); } catch {}
  if (ctxLoaderState) setState({ loader: ctxLoaderState() });
}

/** zip 上传安装：multipart POST install-zip（与 runOp 同响应处理）。trust=true 表示已确认信任发行者。 */
async function runInstallZip(file, trust) {
  setState({ busyKey: "install:zip:" + file.name, error: null, message: null });
  try {
    const fd = new FormData();
    fd.append("file", file, file.name);
    if (trust) fd.append("trust", "1");
    const r = await fetch(API("/api/extensions/aiti-extman/install-zip"), { method: "POST", body: fd });
    const d = await r.json();
    if (!r.ok && !d.needsTrust) throw new Error(d.error || "HTTP " + r.status);
    // 发行者未信任 → 弹信任确认（保留 File 以便确认后重发）。
    if (d.needsTrust) {
      setState({
        pendingTrust: { kind: "zip", file, id: d.id, publisher: d.publisher, zipName: d.zipName },
        busyKey: null, error: null, message: null,
      });
      return;
    }
    if (d.error) throw new Error(d.error);
    if (d.extensions) {
      let sel = state.selected;
      if (d.id) sel = { kind: "local", id: d.id };
      if (!sel || (sel.kind === "local" && !d.extensions[sel.id])) {
        const ids = Object.keys(d.extensions).filter((id) => d.extensions[id].enabled !== false).sort();
        sel = ids[0] ? { kind: "local", id: ids[0] } : null;
      }
      setState({ status: d, selected: sel });
    } else {
      await refreshStatus();
    }
    await syncClient();
    setState({ message: T("ext.msgInstalled"), busyKey: null });
    void refreshTrusted();
  } catch (e) {
    setState({ error: String(e && e.message || e), busyKey: null });
  }
}

/** 本地条目是否命中搜索（id / name / 描述字段）。 */
function localMatches(id, e, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return (id + " " + (e.name || "") + " " + ((e.packageInfo && e.packageInfo.name) || "")).toLowerCase().includes(s);
}

/** 在线条目是否命中搜索。 */
function onlineMatches(ext, q) {
  if (!q) return false; // 空搜索只显示本地
  const s = q.toLowerCase();
  return [ext.id, ext.name, ext.description, ext.category, (ext.tags || []).join(" ")]
    .filter(Boolean).join(" ").toLowerCase().includes(s);
}

// ---------- 小组件 ----------
function SourceTag({ source }) {
  if (!source) return null;
  return H("span", { style: { ...chipStyle(SOURCE_COLORS[source] || "var(--text-dim)", "rgba(120,120,120,0.12)"), fontFamily: "var(--font-mono)" } },
    SOURCE_LABELS[source] || source);
}

function Toggle({ enabled, loading, onToggle, label }) {
  return H("button", {
    type: "button", onClick: onToggle, disabled: loading, title: label, "aria-label": label,
    style: {
      flexShrink: 0, width: 40, height: 22, borderRadius: 11, border: "none", padding: 0,
      cursor: loading ? "wait" : "pointer",
      background: enabled ? "var(--accent)" : "var(--border)",
      position: "relative", transition: "background 0.18s", outline: "none",
      opacity: loading ? 0.65 : 1,
    },
  },
    H("span", {
      style: {
        position: "absolute", top: 3, left: enabled ? 21 : 3, width: 16, height: 16,
        borderRadius: "50%", background: "var(--bg)", boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
        transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
      },
    }));
}

/** 列表行内的小号启停开关（悬停卡片时出现；设计同 Toggle，尺寸更紧凑）。 */
function MiniToggle({ enabled, loading, onToggle, label }) {
  return H("button", {
    type: "button", onClick: onToggle, disabled: loading, title: label, "aria-label": label,
    style: {
      flexShrink: 0, width: 36, height: 20, borderRadius: 10, border: "none", padding: 0,
      cursor: loading ? "wait" : "pointer",
      background: enabled ? "var(--accent)" : "var(--border)",
      position: "relative", transition: "background 0.18s", outline: "none",
      opacity: loading ? 0.65 : 1,
    },
  },
    H("span", {
      style: {
        position: "absolute", top: 3, left: enabled ? 19 : 3, width: 14, height: 14,
        borderRadius: "50%", background: "var(--bg)", boxShadow: "0 1px 4px rgba(0,0,0,0.22)",
        transition: "left 0.18s cubic-bezier(.4,0,.2,1)",
      },
    }));
}

/** 发行者信息单元（名称 + 可点击网站 + 信任状态 + 信任/撤销操作）。 */
function PublisherCell({ publisher }) {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  if (!publisher) return null;
  const name = (publisher.name && publisher.name.trim()) || T("ext.publisherUnknown");
  const url = publisher.url || null;
  const trusted = publisherTrusted(publisher);
  const busy = state.busyKey === "trust:" + name || state.busyKey === "untrust:" + name;
  const keyName = (publisher.name && publisher.name.trim()) || publisher.fingerprint || "";
  const linkStyle = { color: "var(--accent)", textDecoration: "none", fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" };
  return H("div", { style: { display: "flex", flexDirection: "column", gap: 5, minWidth: 0 } },
    H("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
      url
        ? H("a", { href: url, target: "_blank", rel: "noopener noreferrer", title: url, style: linkStyle },
            name, " ", H("svg", { width: 10, height: 10, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, style: { verticalAlign: "middle" } },
              H("path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }),
              H("polyline", { points: "15 3 21 3 21 9" }),
              H("line", { x1: 10, y1: 14, x2: 21, y2: 3 })))
        : H("span", { style: { fontSize: 12, fontWeight: 600, color: "var(--text)" } }, name),
      H("span", { style: chipStyle("var(--text-muted)", "var(--bg-hover)") }, publisherSourceLabel(publisher.source)),
      trusted
        ? H("span", { style: chipStyle("color-mix(in srgb, var(--ok, var(--ok, #10b981)) 90%, transparent)", "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 12%, transparent)") }, "✓ " + T("ext.trusted"))
        : H("span", { style: chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)") }, "⚠ " + T("ext.notTrusted")),
    ),
    !publisher.name && publisher.fingerprint && H("div", { style: { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" } },
      T("ext.fingerprint") + ": " + publisher.fingerprint),
    trusted
      ? H("button", {
          type: "button", disabled: busy,
          onClick: () => void runOp("untrust", { name: keyName }),
          style: { ...btnStyle, alignSelf: "flex-start", padding: "3px 10px", fontSize: 11 },
        }, busy ? "…" : T("ext.untrustPublisher"))
      : keyName && H("button", {
          type: "button", disabled: busy,
          onClick: () => void runOp("trust", { name: (publisher.name && publisher.name.trim()) || "", fingerprint: keyName, url, source: publisher.source }),
          style: { ...btnStyle, alignSelf: "flex-start", padding: "3px 10px", fontSize: 11 },
        }, busy ? "…" : T("ext.trustPublisher")),
  );
}

/** VSCode 式信任弹窗：发行者未信任时安装前弹出（显示发行者 + 可点击网站）。 */
function TrustDialog() {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  const pt = state.pendingTrust;
  if (!pt) return null;
  const pub = pt.publisher || {};
  const name = (pub.name && pub.name.trim()) || T("ext.publisherUnknown");
  const url = pub.url || null;
  const busy = state.busyKey !== null;
  const confirm = () => {
    const p = state.pendingTrust;
    setState({ pendingTrust: null });
    if (p.kind === "zip") void runInstallZip(p.file, true);
    else void runOp("install", { source: p.source, docsUrl: p.docsUrl, trust: true, publisher: p.publisher, publisherHint: p.publisherHint });
  };
  return H("div", {
    style: {
      position: "fixed", inset: 0, zIndex: 2147483645,
      background: "rgba(0,0,0,0.45)",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    },
    onClick: (e) => { if (e.target === e.currentTarget) setState({ pendingTrust: null }); },
  },
    H("div", {
      style: {
        width: 420, maxWidth: "100%",
        background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10,
        boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: "18px 20px",
        display: "flex", flexDirection: "column", gap: 14,
      },
      onClick: (e) => e.stopPropagation(),
    },
      H("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
        H("span", { style: { fontSize: 16, display: "inline-flex" } }, H("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [H("path", { key: "p1", d: "M18 8h1a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4v-8a4 4 0 0 1 4-4h1" }), H("path", { key: "p2", d: "M7 8V6a5 5 0 0 1 10 0v2" }), H("path", { key: "p3", d: "M12 13v4" })])),
        H("span", { style: { fontSize: 14, fontWeight: 700, color: "var(--text)" } }, T("ext.trustDialogTitle")),
      ),
      H("div", { style: { display: "flex", flexDirection: "column", gap: 5 } },
        H("div", { style: { fontSize: 11, color: "var(--text-dim)" } }, T("ext.publisher")),
        H("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
          url
            ? H("a", { href: url, target: "_blank", rel: "noopener noreferrer", style: { color: "var(--accent)", textDecoration: "none", fontSize: 13, fontWeight: 600 } },
                name, " ↗")
            : H("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text)" } }, name),
          H("span", { style: chipStyle("var(--text-muted)", "var(--bg-hover)") }, publisherSourceLabel(pub.source)),
        ),
        !pub.name && pub.fingerprint && H("div", { style: { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" } },
          T("ext.fingerprint") + ": " + pub.fingerprint),
        pt.zipName && H("div", { style: { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" } }, "zip: " + pt.zipName),
      ),
      H("div", { style: { fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 } }, T("ext.trustDialogBody")),
      H("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 } },
        H("button", {
          type: "button", onClick: () => setState({ pendingTrust: null }), disabled: busy,
          style: btnStyle,
        }, T("ext.cancel")),
        H("button", {
          type: "button", onClick: confirm, disabled: busy,
          style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", fontWeight: 600 },
        }, busy ? "…" : T("ext.trustAndInstall")),
      ),
    ),
  );
}

// ---------- 主面板（dialogs 插槽） ----------
function ExtManPanel(props) {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  // Esc 关闭：弹窗可能被 AI 调试窗（z-index 21亿）盖住关闭按钮——键盘兜底出口，防死锁
  useEffect_(() => {
    if (!state.open) return;
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setState({ open: false }); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state.open]);

  // 捕获宿主传入的当前会话（dialogs 插槽 ExtRenderProps.currentSession）——context 插槽打开时的上下文
  currentSessionVal = props ? props.currentSession : null;

  if (!state.open) return null;

  const { status, isMobile, q } = state;
  const hasQuery = q.trim().length > 0;
  const localIds = sortedLocalIds(status).filter((id) => !hasQuery || localMatches(id, status.extensions[id], q.trim()));

  // 在线命中（排除已安装——已安装的在本地区显示标记；同 id 时保留本地视图）。
  const regExts = (state.registryData && state.registryData.extensions) || [];
  const onlineHits = hasQuery
    ? regExts.filter((ext) => onlineMatches(ext, q.trim()) && !(status && status.extensions[ext.id]))
    : [];
  // 本地已安装且注册表里有新版本 → 更新标记。
  const registryById = {};
  for (const ext of regExts) registryById[ext.id] = ext;

  const busyAny = state.busyKey !== null;
  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;

  // 选中有效性：在线条目可能因安装成功变成本地——保持原样即可（local 优先校正）。
  const sel = state.selected;
  const selLocal = sel && sel.kind === "local" && status && status.extensions[sel.id];
  const selOnline = sel && sel.kind === "online" && registryById[sel.id];

  function rowSelected(kind, id) {
    return sel && sel.kind === kind && sel.id === id;
  }

  return H("div", {
    style: {
      position: "fixed", inset: 0,
      // z 默认抬到 AI 调试窗（2147483642）之上：本弹窗是 aiti 家族 UI，必须随时可关——
      // 曾因低于 AI 窗，关闭按钮被 AI 窗遮挡 + 全页遮罩吃掉宿主点击，用户被锁死（“更多菜单点不开”）
      // 打开其他扩展弹窗后自动降到后面（zBack=true → 300，新弹窗置前）；头部「置于顶层」可恢复
      zIndex: state.zBack ? 300 : 2147483644,
      background: "rgba(0,0,0,0.35)",
      display: "flex", alignItems: "center", justifyContent: "center",
    },
    onClick: (e) => { if (e.target === e.currentTarget) setState({ open: false }); },
  },
    H("div", {
      style: {
        width: isMobile ? (state.maximized ? "100vw" : "calc(100vw - 16px)") : 900,
        maxWidth: isMobile && state.maximized ? "100vw" : "calc(100vw - 16px)",
        height: isMobile ? (state.maximized ? "100dvh" : "calc(100dvh - 16px)") : "78vh",
        maxHeight: isMobile && state.maximized ? "100dvh" : "calc(100dvh - 16px)",
        borderRadius: isMobile && state.maximized ? 0 : 8,
        display: "flex", flexDirection: "column", background: "var(--bg)",
        border: "1px solid var(--border)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden",
      },
      onClick: (e) => e.stopPropagation(),
    },
      // header（小屏拆两行：标题+窗口控制 / 操作按钮均分；宽屏保持单行，避免窄屏按钮溢出屏外）
      isMobile ? H("div", { style: { display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px 10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 } },
        H("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minWidth: 0 } },
          H("div", { style: { display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, flex: 1 } },
            H("span", { style: { fontSize: 14, fontWeight: 700, color: "var(--text)", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 6 } }, extIconSpan({ id: SELF_ID, icon: "icon.svg" }, 14), T("ext.title")),
            status && H("span", { style: { fontSize: 10, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              T("ext.summary", {
                total: Object.keys(status.extensions || {}).length,
                on: Object.values(status.extensions || {}).filter((e) => e.enabled !== false).length,
                off: Object.values(status.extensions || {}).filter((e) => e.enabled === false).length,
              })),
          ),
          H("div", { style: { display: "flex", gap: 6, flexShrink: 0 } },
            state.zBack && H("button", {
              type: "button",
              onClick: () => setState({ zBack: false }),
              title: T("ext.raiseToTop"),
              style: { ...btnStyle, padding: "5px 9px", fontSize: 12, lineHeight: 1 },
            }, "⤒"),
            H("button", {
              type: "button",
              onClick: () => setState({ maximized: !state.maximized }),
              title: state.maximized ? T("ext.restore") : T("ext.maximize"),
              style: { ...btnStyle, padding: "5px 9px", fontSize: 13, lineHeight: 1 },
            }, state.maximized ? H("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [H("path", { d: "M8 3v3a2 2 0 0 1-2 2H3" }), H("path", { d: "M21 8h-3a2 2 0 0 1-2-2V3" }), H("path", { d: "M3 16h3a2 2 0 0 1 2 2v3" }), H("path", { d: "M16 21v-3a2 2 0 0 1 2-2h3" })]) : H("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [H("path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }), H("path", { d: "M21 8V5a2 2 0 0 0-2-2h-3" }), H("path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }), H("path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" })])),
            H("button", { type: "button", onClick: () => setState({ open: false }), title: T("ext.close"), style: { ...btnStyle, padding: "5px 9px", fontSize: 13, lineHeight: 1 } }, H("svg", { width: 11, height: 11, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, [H("path", { d: "M18 6 6 18" }), H("path", { d: "m6 6 12 12" })])),
          ),
        ),
        H("div", { style: { display: "flex", gap: 6 } },
          H("button", {
            type: "button", disabled: busyAny, onClick: () => { setState({ selected: { kind: "add", id: "" }, q: "", error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView }); void loadRegistry(); void refreshTrusted(); },
            title: T("ext.add"),
            style: { ...btnStyle, flex: 1, background: "var(--accent)", color: "white", borderColor: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 },
          },
            H("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
              H("line", { x1: 12, y1: 5, x2: 12, y2: 19 }), H("line", { x1: 5, y1: 12, x2: 19, y2: 12 })),
            T("ext.add")),
          H("button", { type: "button", disabled: busyAny, onClick: () => void runOp("reload", {}), style: { ...btnStyle, flex: 1 } },
            state.busyKey === "reload:" ? "…" : T("ext.reload")),
          H("button", { type: "button", disabled: busyAny, onClick: () => void refreshStatus(), style: { ...btnStyle, flex: 1 } }, T("ext.refresh")),
        ),
      )
      : H("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 } },
        H("div", { style: { display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 } },
          H("span", { style: { fontSize: 15, fontWeight: 700, color: "var(--text)", display: "inline-flex", alignItems: "center", gap: 6 } }, extIconSpan({ id: SELF_ID, icon: "icon.svg" }, 15), T("ext.title")),
          status && H("span", { style: { fontSize: 11, color: "var(--text-dim)" } },
            T("ext.summary", {
              total: Object.keys(status.extensions || {}).length,
              on: Object.values(status.extensions || {}).filter((e) => e.enabled !== false).length,
              off: Object.values(status.extensions || {}).filter((e) => e.enabled === false).length,
            })),
        ),
        H("div", { style: { display: "flex", gap: 8, flexShrink: 0 } },
          state.zBack && H("button", {
            type: "button", onClick: () => setState({ zBack: false }), title: T("ext.raiseToTop"),
            style: btnStyle,
          }, T("ext.raiseToTop")),
          H("button", {
            type: "button", disabled: busyAny, onClick: () => { setState({ selected: { kind: "add", id: "" }, q: "", error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView }); void loadRegistry(); void refreshTrusted(); },
            title: T("ext.add"),
            style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", display: "flex", alignItems: "center", gap: 5 },
          },
            H("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
              H("line", { x1: 12, y1: 5, x2: 12, y2: 19 }), H("line", { x1: 5, y1: 12, x2: 19, y2: 12 })),
            T("ext.add")),
          H("button", { type: "button", disabled: busyAny, onClick: () => void runOp("reload", {}), style: btnStyle },
            state.busyKey === "reload:" ? "…" : T("ext.reload")),
          H("button", { type: "button", disabled: busyAny, onClick: () => void refreshStatus(), style: btnStyle }, T("ext.refresh")),
          H("button", { type: "button", onClick: () => setState({ open: false }), style: btnStyle }, T("ext.close")),
        ),
      ),
      state.error && H("div", { style: { padding: "8px 18px", fontSize: 12, color: "var(--danger, #ef4444)", background: "color-mix(in srgb, var(--danger, #ef4444) 6%, transparent)", borderBottom: "1px solid var(--border)" } }, state.error),
      state.message && H("div", { style: { padding: "8px 18px", fontSize: 12, color: "#16a34a", background: "rgba(22,163,74,0.06)", borderBottom: "1px solid var(--border)" } }, state.message),
      state.openHint && H("div", { style: { padding: "8px 18px", fontSize: 12, color: "#d97706", background: "rgba(217,119,6,0.08)", borderBottom: "1px solid var(--border)" } }, state.openHint.text),

      // body
      H("div", { style: { flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" } },
        // ── 左：搜索 + 结果列表（本地已安装 + 在线） ──
        // 小屏详情视图时隐藏列表，让位给详情
        H("div", {
          style: {
            display: isMobile && state.mobileView === "detail" ? "none" : "flex",
            width: isMobile ? "100%" : 290,
            // 小屏导航视图（list/detail 二选一）：列表视图时铺满 body 高度（内部滚动），
            // 折叠时仅留折叠条——不再用 42vh 上限（避免只占一半、底部空着）
            flex: isMobile ? (state.listCollapsed ? 0 : 1) : undefined,
            minHeight: isMobile ? 0 : undefined,
            borderRight: isMobile ? "none" : "1px solid var(--border)",
            borderBottom: "none",
            flexDirection: "column", flexShrink: 0, background: "var(--bg-panel)",
          },
        },
          // 小屏：列表折叠条（点击展开/收起扩展列表，给详情区让空间；折叠时详情区占满 body）
          isMobile && H("button", {
            type: "button",
            onClick: () => setState({ listCollapsed: !state.listCollapsed }),
            title: state.listCollapsed ? T("ext.expandList") : T("ext.collapseList"),
            style: {
              display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%",
              padding: "8px 12px", border: "none", background: "var(--bg-panel)",
              cursor: "pointer", flexShrink: 0, color: "var(--text-muted)",
            },
          },
            H("span", { style: { fontSize: 11, fontWeight: 600 } },
              [extIconSpan({ id: SELF_ID, icon: "icon.svg" }, 13), T("ext.list") + " (" + (status ? Object.keys(status.extensions).length : 0) + ")"]),
            H("span", { style: { fontSize: 11 } }, state.listCollapsed ? "▾ " + T("ext.expand") : "▴ " + T("ext.collapse")),
          ),
          // 搜索框 + 结果（小屏折叠时整块隐藏）
          (!isMobile || !state.listCollapsed) && [
          // 搜索框（列表上方；图标在输入框内左侧，清空钮在框内右侧，输入框占满整行）
          H("div", { key: "search", style: { padding: "8px 8px 6px", borderBottom: "1px solid var(--border)", flexShrink: 0 } },
            H("div", { style: { position: "relative", width: "100%" } },
              H("span", {
                style: {
                  position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)",
                  pointerEvents: "none", color: "var(--text-dim)", display: "flex", alignItems: "center",
                },
              },
                H("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
                  H("circle", { cx: 11, cy: 11, r: 8 }),
                  H("line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }))),
              H("input", {
                value: q,
                onChange: (e) => {
                  setState({ q: e.target.value });
                  if (e.target.value.trim()) void loadRegistry();
                },
                placeholder: T("ext.searchHint"),
                style: {
                  width: "100%", height: 28, padding: q ? "0 26px 0 26px" : "0 10px 0 26px",
                  border: "1px solid var(--border)", borderRadius: 6,
                  background: "var(--bg)", color: "var(--text)", fontSize: 12, outline: "none",
                  boxSizing: "border-box",
                },
              }),
              q && H("button", {
                onClick: () => setState({ q: "" }),
                title: T("ext.clearSearch"),
                style: {
                  position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)",
                  background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer",
                  fontSize: 13, lineHeight: 1, padding: "2px 4px", display: "flex", alignItems: "center",
                },
              }, "×"),
            ),
          ),
          // 结果
          H("div", { key: "results", style: { flex: 1, overflowY: "auto", padding: "8px 6px" } },
            !status ? H("div", { style: { padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" } }, "…") : [

              // ① 来源快捷安装（搜索词像 git:/npm:/https://… 时）
              hasQuery && looksLikeSource(q) && H("div", {
                key: "src-row",
                onClick: () => setState({ selected: { kind: "source", id: q.trim() }, error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView }),
                style: {
                  display: "flex", alignItems: "center", gap: 7, padding: "8px 8px", marginBottom: 6,
                  borderRadius: 5, cursor: "pointer",
                  border: "1px dashed var(--border)",
                  background: rowSelected("source", q.trim()) ? "var(--bg-selected)" : "none",
                },
              },
                H("span", { style: { fontSize: 11, flexShrink: 0 } }, "⬇"),
                H("div", { style: { minWidth: 0, flex: 1 } },
                  H("div", { style: { fontSize: 11, fontWeight: 600, color: "var(--text)" } }, T("ext.installFromSource")),
                  H("div", { style: { fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, q.trim())),
                H("button", {
                  type: "button", disabled: installBusy,
                  onClick: (e) => { e.stopPropagation(); void runOp("install", { source: q.trim() }); },
                  style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", flexShrink: 0 },
                }, installBusy ? "…" : T("ext.install")),
              ),

              // ② 本地（空搜索 = 全部；有搜索 = 命中的，带已安装标记）
              localIds.map((id, i) => {
                const e = status.extensions[id];
                const isSel = rowSelected("local", id);
                const reg = registryById[id];
                const updatable = reg && reg.version && e.version && reg.version !== e.version;
                const showDivider = !hasQuery && e.enabled === false && (i === 0 || status.extensions[localIds[i - 1]].enabled !== false);
                // 悬停显示启停开关（自保护扩展除外）；背景跟随 React 状态渲染，避免与
                // 模块级 state 重渲染覆盖内联背景产生闪烁。
                const hovered = state.hoverLocal === id;
                const rowBusy = state.busyKey === "enable:" + id || state.busyKey === "disable:" + id;
                return H("div", { key: "l:" + id },
                  showDivider && H("div", { style: { padding: "8px 8px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", borderTop: "1px solid var(--border)", marginTop: 6 } }, T("ext.disabled")),
                  H("div", {
                    onClick: () => setState({ selected: { kind: "local", id }, error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView }),
                    style: {
                      display: "flex", alignItems: "center", gap: 8, padding: "9px 10px",
                      borderRadius: 5, cursor: "pointer",
                      background: isSel ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "none",
                    },
                    onMouseEnter: () => { if (state.hoverLocal !== id) setState({ hoverLocal: id }); },
                    onMouseLeave: () => { if (state.hoverLocal === id) setState({ hoverLocal: null }); },
                  },
                    H("div", { style: { minWidth: 0, flex: 1 } },
                      H("div", {
                        title: id,
                        style: {
                          fontSize: 12, fontWeight: isSel ? 600 : 400,
                          color: e.enabled === false ? "var(--text-dim)" : "var(--text)",
                          fontFamily: "var(--font-mono)",
                          display: "flex", alignItems: "center", gap: 5, minWidth: 0,
                        },
                      }, H("span", { title: statusDotTitle(e), style: { flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: statusDotColor(e) } }),
                        extIconSpan(e, 12, id),
                        H("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 } }, id)),
                      H("div", { style: { fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 } },
                        e.error ? "⚠ " + String(e.error).slice(0, 60) : (e.name || id) + (e.version ? " · v" + e.version : "")),
                    ),
                    // 悬停 → 启停开关（替换标记区）；自保护扩展（aiti-extman）不显示
                    hovered && id !== SELF_ID
                      ? H(MiniToggle, {
                          enabled: e.enabled !== false,
                          loading: rowBusy,
                          onToggle: (ev) => { ev.stopPropagation(); void runOp(e.enabled === false ? "enable" : "disable", { id }); },
                          label: (e.enabled === false ? T("ext.enable") : T("ext.disable")) + " " + id,
                        })
                      : [
                          hasQuery && H("span", { key: "inst", style: chipStyle("rgba(99,102,241,0.9)", "rgba(99,102,241,0.12)") }, T("ext.installed")),
                          updatable && H("span", { key: "up", style: chipStyle("#d97706", "rgba(217,119,6,0.12)") }, "↑" + reg.version),
                          !hasQuery && H(SourceTag, { key: "src", source: e.source }),
                        ],
                  ),
                );
              }),

              // ③ 在线（搜索命中且未安装）—— 直接安装按钮
              hasQuery && (state.registryError && !state.registryData
                ? H("div", { key: "reg-err", style: { padding: "8px 8px", fontSize: 11, color: "#d97706" } },
                    T("ext.registryFailed") + ": " + state.registryError)
                : !state.registryData
                  ? H("div", { key: "reg-loading", style: { padding: "8px 8px", fontSize: 11, color: "var(--text-muted)" } }, "…")
                  : [
                      onlineHits.length > 0 && H("div", { key: "online-h", style: { padding: "10px 8px 3px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", borderTop: "1px solid var(--border)", marginTop: 6 } }, T("ext.onlineResults")),
                      ...onlineHits.map((ext) => {
                        const isSel = rowSelected("online", ext.id);
                        const src = registryInstallSource(ext);
                        return H("div", {
                          key: "o:" + ext.id,
                          onClick: () => setState({ selected: { kind: "online", id: ext.id }, error: null, message: null, mobileView: isMobile ? "detail" : state.mobileView }),
                          style: {
                            display: "flex", alignItems: "center", gap: 8, padding: "9px 10px",
                            borderRadius: 5, cursor: "pointer",
                            background: isSel ? "var(--bg-selected)" : "none",
                          },
                          onMouseEnter: (ev) => { if (!isSel) ev.currentTarget.style.background = "var(--bg-hover)"; },
                          onMouseLeave: (ev) => { if (!isSel) ev.currentTarget.style.background = "none"; },
                        },
                          H("div", { style: { minWidth: 0, flex: 1 } },
                            H("div", {
                              title: ext.id,
                              style: {
                                fontSize: 12, fontWeight: isSel ? 600 : 400, color: "var(--text)",
                                fontFamily: "var(--font-mono)",
                                display: "flex", alignItems: "center", gap: 5, minWidth: 0,
                              },
                            }, H("span", { title: "状态：未安装", style: { flexShrink: 0, width: 7, height: 7, borderRadius: "50%", background: "var(--border)" } }),
                              extIconSpan(ext, 12),
                              H("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: 1 } }, ext.id)),
                            H("div", { style: { fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 2 } },
                              (ext.description || ext.name || "") + (ext.version ? " · v" + ext.version : "")),
                          ),
                          src ? H("button", {
                            type: "button", disabled: installBusy,
                            onClick: (e) => { e.stopPropagation(); void runOp("install", { source: src, docsUrl: registryDocUrl(ext), publisherHint: ext.publisher || ext.author }); },
                            style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", flexShrink: 0 },
                          }, installBusy ? "…" : T("ext.install"))
                          : H("span", { style: { fontSize: 10, color: "var(--text-dim)", flexShrink: 0 } }, T("ext.noSource")),
                        );
                      }),
                    ]),
            ],
          ),
          ],
        ),
        // ── 右：详情（小屏列表视图时隐藏） ──
        H("div", { style: { display: isMobile && state.mobileView === "list" ? "none" : "block", flex: 1, overflowY: "auto", padding: isMobile ? 12 : 20 } },
          // 小屏详情视图：顶部返回按钮
          isMobile && state.mobileView === "detail" && H("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexShrink: 0 } },
            H("button", {
              type: "button",
              onClick: () => setState({ mobileView: "list" }),
              style: { ...btnStyle, display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", fontSize: 12 },
            }, "← " + T("ext.back")),
            sel && H("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              selLocal ? (selLocal.name || sel.id) : selOnline ? (selOnline.name || sel.id) : sel.id),
          ),
          !status ? null
          : sel && sel.kind === "add" ? H(AddPane)
          : sel && sel.kind === "source" ? H(SourceDetail, { source: sel.id })
          : selLocal ? H(LocalDetail, { id: sel.id, entry: selLocal })
          : selOnline ? H(OnlineDetail, { ext: registryById[sel.id] })
          : H("div", { style: { height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 13 } }, T("ext.select")),
        ),
      ),

      // footer: roots
      status && H("div", {
        style: {
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          padding: "8px 18px", borderTop: "1px solid var(--border)", flexShrink: 0,
        },
      },
        H("div", {
          style: { minWidth: 0, flex: 1, fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", lineHeight: 1.5, overflow: "hidden" },
          // 小屏只显示一行（其余路径 hover 查看完整）；宽屏保留五行
          title: [
            "user: " + shortenPath(status.extensionsRoot),
            ...(status.extraExtensionsRoots && status.extraExtensionsRoots.length ? ["extra: " + status.extraExtensionsRoots.map(shortenPath).join(", ")] : []),
            ...(status.devExtensionsRoot ? ["dev: " + shortenPath(status.devExtensionsRoot)] : []),
            "bundled: " + shortenPath(status.bundledExtensionsRoot),
            "data: " + shortenPath(status.dataRoot),
          ].join("\n"),
        },
          isMobile
            ? H("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, "user: " + shortenPath(status.extensionsRoot))
            : [
                H("div", { key: "user", }, "user: " + shortenPath(status.extensionsRoot)),
                status.extraExtensionsRoots && status.extraExtensionsRoots.length > 0 && H("div", { key: "extra" }, "extra: " + status.extraExtensionsRoots.map(shortenPath).join(", ")),
                status.devExtensionsRoot && H("div", { key: "dev" }, "dev: " + shortenPath(status.devExtensionsRoot)),
                H("div", { key: "bundled" }, "bundled: " + shortenPath(status.bundledExtensionsRoot)),
                H("div", { key: "data" }, "data: " + shortenPath(status.dataRoot)),
              ],
        ),
        H("a", {
          href: AITI_REGISTRY_PAGE, target: "_blank", rel: "noopener noreferrer",
          style: { fontSize: 11, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap", flexShrink: 0 },
        }, "aiti.pw/extensions"),
      ),
    ),
    H(TrustDialog),
  );
}

// ---------- 本地详情 ----------
function InfoRow({ label, children }) {
  return [
    H("div", { key: "l", style: { color: "var(--text-dim)" } }, label),
    H("div", { key: "v", style: { color: "var(--text-muted)", minWidth: 0, overflowWrap: "anywhere" } }, children),
  ];
}

function LocalDetail({ id, entry }) {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);

  const enabled = entry.enabled !== false;
  const busy = state.busyKey === "enable:" + id || state.busyKey === "disable:" + id || state.busyKey === "remove:" + id;
  const rawSlots = entry.slots || {};
  const slotEntries = Object.entries(rawSlots);
  const slotItems = slotEntries.reduce((s, [, items]) => s + items.length, 0);
  // 插槽条目详情（label/title/context/where）；旧宿主无 slotsDetail 时回退 id 列表。
  const slotDetailOf = (slot) => {
    const detail = (entry.slotsDetail && entry.slotsDetail[slot]) || [];
    if (detail.length) return detail;
    return (rawSlots[slot] || []).map((itId) => ({ id: itId, label: itId, context: "global", where: "" }));
  };
  const pkg = entry.packageInfo || {};
  const loader = state.loader;
  const clientState = !entry.client ? T("ext.noClient")
    : loader.materialized.includes(id) ? T("ext.clientLoaded")
    : loader.prefetched.includes(id) ? T("ext.prefetched")
    : T("ext.notLoaded");

  const gridStyle = {
    display: "grid", gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
    gap: "9px 14px", fontSize: 12, lineHeight: 1.45,
  };
  const sectionTitle = { fontSize: 12, fontWeight: 700, color: "var(--text)" };

  return H("div", { style: { display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 } },
    H("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, minWidth: 0, flexWrap: "wrap" } },
      H("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 } },
        id === SELF_ID
          ? H("span", { title: T("ext.selfProtected"), style: chipStyle("color-mix(in srgb, var(--ok, var(--ok, #10b981)) 90%, transparent)", "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 12%, transparent)") }, "🔒 " + T("ext.selfProtected"))
          : H(Toggle, {
              enabled, loading: busy,
              onToggle: () => void runOp(enabled ? "disable" : "enable", { id }),
              label: enabled ? T("ext.disable") : T("ext.enable"),
            }),
        H(SourceTag, { source: entry.source }),
        !enabled && H("span", { style: chipStyle("var(--text-dim)", "rgba(120,120,120,0.12)") }, T("ext.disabled")),
        entry.error && H("span", { style: chipStyle("var(--danger, #ef4444)", "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)") }, "error"),
        H("span", {
          title: id,
          style: { fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
        }, id),
      ),
      entry.source === "user" && entry.dir && id !== SELF_ID && H("button", {
        type: "button", disabled: busy, style: { ...btnStyle, color: "var(--danger, #ef4444)", background: "color-mix(in srgb, var(--danger, #ef4444) 8%, transparent)" },
        onClick: () => { if (window.confirm(T("ext.removeConfirm"))) void runOp("remove", { id }); },
      }, T("ext.remove")),
    ),

    H("div", { style: gridStyle },
      H(InfoRow, { label: T("ext.status") },
        H("span", { style: { color: statusDotColor(entry) } }, entry.error ? "error" : !enabled ? T("ext.disabled") : entry.loaded ? "loaded" : "—")),
      H(InfoRow, { label: T("ext.name") }, H("span", { style: { fontFamily: "var(--font-mono)" } }, entry.name || id)),
      H(InfoRow, { label: T("ext.version") },
        H("span", { style: { fontFamily: "var(--font-mono)" } },
          entry.version || "—",
          pkg.version && pkg.version !== entry.version ? " (package " + pkg.version + ")" : "")),
      H(InfoRow, { label: T("ext.slots") },
        slotEntries.length ? T("ext.slotSummary", { slots: slotEntries.length, items: slotItems }) : T("ext.noSlots")),
      H(InfoRow, { label: T("ext.clientBundle") },
        H("span", { style: { fontFamily: "var(--font-mono)" } },
          entry.client ? entry.client.file + (entry.client.hash ? " @" + entry.client.hash.slice(0, 8) : "") : "—")),
      H(InfoRow, { label: T("ext.clientState") }, clientState),
      pkg.homepage && H(InfoRow, { label: T("ext.sourceUrl") },
        H("a", { href: pkg.homepage, target: "_blank", rel: "noopener noreferrer", style: { color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 } }, pkg.homepage)),
      H(InfoRow, { label: T("ext.publisher") }, H(PublisherCell, { publisher: entry.publisher })),
      H(InfoRow, { label: T("ext.dir") },
        H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 11 } }, entry.dir ? shortenPath(entry.dir) : "—")),
      H(InfoRow, { label: T("ext.dataDir") },
        H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 11 } }, entry.dataDir ? shortenPath(entry.dataDir) : "—")),
      pkg.name && H(InfoRow, { label: "npm" }, H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 11 } }, pkg.name)),
      entry.i18nLocales && entry.i18nLocales.length ? H(InfoRow, { label: "i18n" },
        H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 11 } }, entry.i18nLocales.join(", "))) : null,
    ),

    H("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      H("div", { style: sectionTitle }, T("ext.slots") + (slotEntries.length ? " · " + T("ext.slotsOpenHint") : "")),
      slotEntries.length === 0 ? H("div", { style: { fontSize: 12, color: "var(--text-dim)" } }, T("ext.noSlots"))
      : H("div", { style: { display: "flex", flexDirection: "column", gap: 6 } },
          slotEntries.map(([slot, ids]) => {
            const items = slotDetailOf(slot);
            const isContext = items.some((it) => it.context === "context");
            return H("div", {
              key: slot,
              style: { display: "flex", flexDirection: "column", gap: 4, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--bg-panel)", minWidth: 0 },
            },
              H("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
                H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: "var(--text-muted)" } }, slot),
                H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" } }, "×" + ids.length),
                isContext
                  ? H("span", { style: chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)") }, "⚠ " + T("ext.context"))
                  : H("span", { style: chipStyle("color-mix(in srgb, var(--ok, var(--ok, #10b981)) 90%, transparent)", "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 12%, transparent)") }, T("ext.global")),
              ),
              items.map((it) => {
                const label = (it.label || it.title || it.id) + "";
                const where = it.where || "";
                return H("div", { key: it.id, style: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
                  H("span", { style: { flex: 1, fontSize: 11, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label),
                  where && H("span", { style: { fontSize: 10, color: "var(--text-dim)", flexShrink: 0, maxWidth: "38%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, where),
                  H("button", {
                    type: "button",
                    onClick: () => openSlotItem(id, slot, it, currentSessionVal),
                    title: T("ext.open") + ": " + label + (where ? " · " + where : ""),
                    style: { ...btnStyle, padding: "2px 9px", fontSize: 10, flexShrink: 0 },
                  }, T("ext.open")),
                );
              }),
            );
          })),
    ),

    H("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      H("div", { style: sectionTitle }, T("ext.deps")),
      H("div", { style: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12 } },
        H("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
          H("span", { style: { color: "var(--text-dim)", flexShrink: 0, minWidth: 110 } }, T("ext.clientDeps")),
          entry.clientDependsOn && entry.clientDependsOn.length
            ? H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" } }, entry.clientDependsOn.join(" · "))
            : H("span", { style: { color: "var(--text-dim)" } }, T("ext.noDeps"))),
        H("div", { style: { display: "flex", gap: 8, alignItems: "baseline" } },
          H("span", { style: { color: "var(--text-dim)", flexShrink: 0, minWidth: 110 } }, T("ext.pkgDeps")),
          pkg.dependencies && pkg.dependencies.length
            ? H("span", { title: pkg.dependencies.join("\n"), style: { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", overflowWrap: "anywhere" } },
                pkg.dependencies.length + ": " + pkg.dependencies.join(" · "))
            : H("span", { style: { color: "var(--text-dim)" } }, T("ext.noDeps"))),
      ),
    ),

    H("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      H("div", { style: sectionTitle }, T("ext.serverCaps")),
      H("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
        (entry.serverHooks || []).map((hk) => H("span", { key: hk, style: { ...chipStyle("var(--text-muted)", "var(--bg-hover)"), fontFamily: "var(--font-mono)" } }, hk + "()")),
        (entry.agentHooks || []).map((hk) => H("span", { key: "a:" + hk, style: { ...chipStyle("color-mix(in srgb, var(--ok, var(--ok, #10b981)) 90%, transparent)", "color-mix(in srgb, var(--ok, var(--ok, #10b981)) 12%, transparent)"), fontFamily: "var(--font-mono)" } }, "agent:" + hk + "()")),
        !(entry.serverHooks || []).length && !(entry.agentHooks || []).length && H("span", { style: { fontSize: 12, color: "var(--text-dim)" } }, T("ext.noDeps"))),
      entry.provides && entry.provides.length ? H("div", { style: { display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" } },
        H("span", { style: { fontSize: 11, color: "var(--text-dim)" } }, T("ext.provides")),
        entry.provides.map((p) => H("span", { key: p, style: { ...chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)"), fontFamily: "var(--font-mono)" } }, p))) : null,
    ),

    // 功能管理（扩展声明了 features 才显示）
    entry.features && entry.features.length > 0
      ? H(FeaturePanel, { id, features: entry.features })
      : null,

    entry.error && H("div", {
      style: {
        fontSize: 12, color: "var(--danger, #ef4444)", whiteSpace: "pre-wrap",
        background: "color-mix(in srgb, var(--danger, #ef4444) 6%, transparent)", border: "1px solid color-mix(in srgb, var(--danger, #ef4444) 25%, transparent)",
        borderRadius: 6, padding: "8px 10px", fontFamily: "var(--font-mono)",
      },
    }, entry.error),
  );
}

/** 功能管理区块：按 group 分组的 feature 开关列表（声明了 features 才渲染）。 */
/** string feature 的受控输入框：本地 draft 跟随外部值变更同步（未聚焦时），聚焦时不被外部改动覆写。 */
function StringFeatureInput({ f, id, busy, onSave }) {
  const cur = typeof f.value === "string" ? f.value : "";
  const [draft, setDraft] = useState_(cur);
  const ref = useRef_(null);
  useEffect_(() => {
    // 外部改值（AI/ops/其他标签页）→ 输入未聚焦时实时回显
    if (document.activeElement !== ref.current && draft !== cur) setDraft(cur);
  }, [cur]);
  const commit = () => {
    const v = draft;
    if (v === cur) return;
    onSave(v);
  };
  return H("input", {
    ref,
    value: draft,
    placeholder: f.placeholder || "",
    disabled: busy,
    onInput: (e) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } },
    style: { width: "100%", marginTop: 2, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)", font: "12px/1.5 var(--font-mono), monospace", outline: "none", boxSizing: "border-box" },
  });
}

function FeaturePanel({ id, features }) {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  const sectionTitle = { fontSize: 12, fontWeight: 700, color: "var(--text)" };
  const on = features.filter((f) => f.enabled !== false).length;
  const off = features.length - on;
  const groups = [];
  for (const f of features) {
    const g = f.group || "";
    const last = groups[groups.length - 1];
    if (last && last.group === g) last.items.push(f);
    else groups.push({ group: g, items: [f] });
  }
  return H("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
    H("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
      H("span", { style: sectionTitle }, T("ext.features")),
      H("span", { style: { fontSize: 11, color: "var(--text-dim)" } }, T("ext.featuresOn", { on }) + " · " + T("ext.featuresOff", { off })),
    ),
    H("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 } }, T("ext.featuresHint")),
    H("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
      groups.map((g, gi) =>
        H("div", { key: gi, style: { display: "flex", flexDirection: "column", gap: 2 } },
          g.group && H("div", { style: { fontSize: 11, fontWeight: 700, color: "var(--text-muted)", marginTop: gi > 0 ? 6 : 0 } }, g.group),
          g.items.map((f) => {
            const key = "set-feature:" + id + ":" + f.id;
            const busy = state.busyKey === key;
            const isString = f.type === "string";
            return H("div", {
              key: f.id,
              style: {
                display: "flex", alignItems: "flex-start", gap: 8, padding: "5px 8px",
                borderRadius: 6, background: "var(--bg-panel)", border: "1px solid var(--border)",
              },
            },
              isString ? H("div", { style: { width: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 13, lineHeight: 1.4, flexShrink: 0 } }, "✎")
              : H(Toggle, {
                enabled: f.enabled !== false, loading: busy,
                onToggle: () => void runOp("set-feature", { id, busyId: f.id, featureId: f.id, enabled: f.enabled === false }),
                label: (f.enabled === false ? T("ext.enable") : T("ext.disable")) + " " + f.id,
              }),
              H("div", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 } },
                H("div", { style: { display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" } },
                  H("span", { style: { fontSize: 12, fontWeight: 600, color: "var(--text)" } }, f.label),
                  isString ? H("span", { style: chipStyle("#2563eb", "rgba(37,99,235,0.12)") }, "文本") : null,
                  !isString && f.default === false && H("span", { style: chipStyle("rgba(217,119,6,0.9)", "rgba(217,119,6,0.12)") }, "默认关"),
                  !isString && f.enabled === false && H("span", { style: chipStyle("var(--danger, #ef4444)", "color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)") }, T("ext.disabled")),
                ),
                f.description && H("div", { style: { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.45 } }, f.description),
                isString
                  ? H(StringFeatureInput, {
                      key: f.id + "-input",
                      f, id, busy,
                      onSave: (v) => void runOp("set-feature", { id, busyId: f.id, featureId: f.id, value: v }),
                    })
                  : H("div", { style: { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" } }, f.id),
              ),
            );
          }),
        ),
      ),
    ),
  );
}

// ---------- 在线详情 ----------
function registryDocUrl(ext) {
  return ext.docs ? AITI_DOCS_BASE + ext.docs : AITI_REGISTRY_PAGE + ext.id + ".html";
}

function registryInstallSource(ext) {
  if (ext.npm && ext.npm.trim()) return "npm:" + ext.npm.trim();
  if (ext.repo && ext.repo.trim()) {
    const repo = ext.repo.trim();
    return /^https?:\/\//.test(repo) ? repo : "git:https://github.com/" + repo;
  }
  return null;
}

/** 在线条目 → 发行者（优先注册表 publisher/website 元数据，回退 author + repo/npm 推导）。 */
function onlinePublisher(ext) {
  // 注册表显式 publisher/website（aiti-docs frontmatter 元数据）优先。
  if (ext.publisher && ext.publisher.trim()) {
    return {
      name: ext.publisher.trim(),
      url: (ext.website && ext.website.trim()) || null,
      source: "registry",
      fingerprint: ext.publisher.trim(),
    };
  }
  const name = (ext.author && ext.author.trim()) || null;
  let url = null;
  let source = "registry";
  if (ext.repo && ext.repo.trim()) {
    url = /^https?:\/\//.test(ext.repo) ? ext.repo.trim() : "https://github.com/" + ext.repo.trim();
    source = "github";
  } else if (ext.npm && ext.npm.trim()) {
    url = "https://www.npmjs.com/package/" + ext.npm.trim();
    source = "npm";
  }
  return { name, url, source, fingerprint: name || url || ext.id };
}

function OnlineDetail({ ext }) {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);

  const installed = state.status && state.status.extensions[ext.id];
  const src = registryInstallSource(ext);
  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;
  const gridStyle = {
    display: "grid", gridTemplateColumns: "minmax(96px, 130px) minmax(0, 1fr)",
    gap: "9px 14px", fontSize: 12, lineHeight: 1.45,
  };

  return H("div", { style: { display: "flex", flexDirection: "column", gap: 20, maxWidth: 720 } },
    H("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
      H("div", { style: { display: "flex", alignItems: "center", gap: 8, minWidth: 180, flex: 1 } },
        H("span", { style: { fontSize: 20, flexShrink: 0, display: "inline-flex" } }, extIconSpan(ext, 20)),
        H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--text)" } }, ext.id),
        installed && H("span", { style: chipStyle("rgba(99,102,241,0.9)", "rgba(99,102,241,0.12)") }, T("ext.installed")),
      ),
      src && H("button", {
        type: "button", disabled: installBusy,
        onClick: () => void runOp("install", { source: src, docsUrl: registryDocUrl(ext), publisherHint: ext.publisher || ext.author }),
        style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" },
      }, installBusy ? T("ext.installing") : installed ? T("ext.update") : T("ext.install")),
    ),

    ext.description && H("div", { style: { fontSize: 13, color: "var(--text)" } }, ext.description),
    ext.soul && H("div", { style: { fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" } }, "❝ " + ext.soul + " ❞"),

    H("div", { style: gridStyle },
      ext.name && H(InfoRow, { label: T("ext.name") }, H("span", { style: { fontFamily: "var(--font-mono)" } }, ext.name)),
      ext.version && H(InfoRow, { label: T("ext.version") }, H("span", { style: { fontFamily: "var(--font-mono)" } }, "v" + ext.version)),
      ext.type && H(InfoRow, { label: T("ext.type") }, ext.type),
      ext.category && H(InfoRow, { label: T("ext.category") }, ext.category),
      H(InfoRow, { label: T("ext.publisher") }, H(PublisherCell, { publisher: onlinePublisher(ext) })),
      ext.license && H(InfoRow, { label: T("ext.license") }, ext.license),
      ext.npm && H(InfoRow, { label: "npm" }, H("span", { style: { fontFamily: "var(--font-mono)", fontSize: 11 } }, ext.npm)),
      ext.repo && H(InfoRow, { label: "repo" },
        H("a", { href: /^https?:\/\//.test(ext.repo) ? ext.repo : "https://github.com/" + ext.repo, target: "_blank", rel: "noopener noreferrer", style: { color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 } }, ext.repo)),
      H(InfoRow, { label: T("ext.docs") },
        H("a", { href: registryDocUrl(ext), target: "_blank", rel: "noopener noreferrer", style: { color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 } }, registryDocUrl(ext))),
    ),

    ext.tags && ext.tags.length > 0 && H("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
      ext.tags.map((tag) => H("span", { key: tag, style: chipStyle("var(--text-muted)", "var(--bg-hover)") }, tag))),

    !src && H("div", { style: { fontSize: 12, color: "#d97706" } }, T("ext.noSource") + " — " + T("ext.docs") + ": " + registryDocUrl(ext)),
  );
}

// ---------- 来源安装详情 ----------
// ---------- 添加面板（顶栏「添加」→ 右栏；原来源安装界面） ----------
function AddPane() {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);

  const [source, setSource] = useState_("");
  const [zipFile, setZipFile] = useState_(null); // File | null
  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;
  const reg = state.registryData;
  const regList = reg && reg.extensions
    ? [...reg.extensions].sort((a, b) => (a.type === "pi-web-ext" ? 0 : 1) - (b.type === "pi-web-ext" ? 0 : 1) || a.id.localeCompare(b.id))
    : [];

  return H("div", { style: { display: "flex", flexDirection: "column", gap: 18, maxWidth: 680, minHeight: "100%" } },
    // 标题 + 在线注册表链接
    H("div", { style: { display: "flex", flexDirection: "column", gap: 5 } },
      H("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" } },
        H("div", { style: { fontSize: 14, fontWeight: 700, color: "var(--text)" } }, T("ext.add")),
        H("a", {
          href: AITI_REGISTRY_PAGE, target: "_blank", rel: "noopener noreferrer",
          style: { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--accent)", fontSize: 12, textDecoration: "none", whiteSpace: "nowrap" },
        },
          H("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
            H("path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }),
            H("polyline", { points: "15 3 21 3 21 9" }),
            H("line", { x1: 10, y1: 14, x2: 21, y2: 3 })),
          "aiti.pw/extensions"),
      ),
      H("div", { style: { fontSize: 12, color: "var(--text-dim)", fontFamily: "var(--font-mono)" } },
        T("ext.installTo") + ": " + (state.status ? shortenPath(state.status.extensionsRoot) + "/<id>" : "~/.pi/web/extensions/<id>")),
    ),

    // 来源安装：git: / npm: / 本地路径（与 pi 插件 install 同语法）
    H("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
      H("label", { htmlFor: "extman-install-source", style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)" } }, T("ext.fromSource")),
      H("div", { style: { display: "flex", gap: 8 } },
        H("input", {
          id: "extman-install-source", value: source,
          onChange: (e) => setSource(e.target.value),
          placeholder: "git:https://… · npm:@scope/pkg · /path/to/ext",
          style: {
            flex: 1, height: 34, padding: "0 11px", border: "1px solid var(--border)", borderRadius: 6,
            background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 13, outline: "none", minWidth: 0,
          },
          onKeyDown: (e) => { if (e.key === "Enter" && source.trim() && !installBusy) void runOp("install", { source: source.trim() }); },
        }),
        H("button", {
          type: "button", disabled: installBusy || !source.trim(),
          onClick: () => void runOp("install", { source: source.trim() }),
          style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" },
        }, installBusy ? T("ext.installing") : T("ext.install")),
      ),

    // zip 上传安装（把扩展目录打包成 zip 上传；入口在根或单层子目录均可）
    H("div", { style: { display: "flex", flexDirection: "column", gap: 7 } },
      H("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--text-muted)" } }, T("ext.uploadZip")),
      H("input", {
        id: "extman-zip-file", type: "file", accept: ".zip",
        onChange: (e) => { setZipFile(e.target.files && e.target.files[0] || null); },
        style: { display: "none" },
      }),
      H("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
        H("label", {
          htmlFor: "extman-zip-file",
          style: {
            ...btnStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
            flexShrink: 0,
          },
        },
          H("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
            H("path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }),
            H("polyline", { points: "17 8 12 3 7 8" }),
            H("line", { x1: 12, y1: 3, x2: 12, y2: 15 })),
          T("ext.chooseZip")),
        zipFile && H("span", {
          title: zipFile.name,
          style: { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 },
        }, zipFile.name + " (" + Math.round(zipFile.size / 1024) + " KB)"),
        zipFile && H("button", {
          type: "button", disabled: installBusy,
          onClick: () => void runInstallZip(zipFile),
          style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", flexShrink: 0 },
        }, installBusy ? T("ext.installing") : T("ext.install")),
      ),
      H("div", { style: { fontSize: 11, color: "var(--text-dim)" } }, T("ext.zipHint")),
    ),

    // 在线注册表浏览（安装/更新/文档）
    H("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      H("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
        H("div", { style: { fontSize: 12, fontWeight: 700, color: "var(--text)" } }, T("ext.registry")),
        H("span", { style: { fontSize: 11, color: "var(--text-dim)" } }, T("ext.registryHint")),
      ),
      !reg && !state.registryError && H("div", { style: { fontSize: 12, color: "var(--text-muted)" } }, "…"),
      state.registryError && !reg && H("div", { style: { fontSize: 12, color: "#d97706" } }, T("ext.registryFailed") + ": " + state.registryError),
      reg && regList.length === 0 && H("div", { style: { fontSize: 12, color: "var(--text-dim)" } }, T("ext.registryEmpty")),
      H("div", { style: { display: "flex", flexDirection: "column", gap: 6, maxHeight: "42vh", overflowY: "auto", paddingRight: 2 } },
        regList.map((ext) => {
          const installed = state.status && state.status.extensions[ext.id];
          const installedVersion = installed && installed.version;
          const updatable = installed && ext.version && installedVersion && ext.version !== installedVersion;
          const src = registryInstallSource(ext);
          return H("div", {
            key: ext.id,
            style: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-panel)" },
          },
            H("div", { style: { flex: 1, minWidth: 0 } },
              H("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
                H("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--text)", fontFamily: "var(--font-mono)", display: "inline-flex", alignItems: "center", gap: 5 } }, extIconSpan(ext, 12), ext.id),
                ext.version && H("span", { style: { fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" } }, "v" + ext.version),
                ext.type && H("span", { style: chipStyle("var(--text-muted)", "var(--bg-hover)") }, ext.type),
                installed && H("span", { style: chipStyle("rgba(99,102,241,0.9)", "rgba(99,102,241,0.12)") }, T("ext.installed")),
                updatable && H("span", { style: chipStyle("#d97706", "rgba(217,119,6,0.12)") }, T("ext.updateTo", { version: ext.version }))),
              H("div", { style: { fontSize: 11, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                ext.description || ext.name || "")),
            H("div", { style: { display: "flex", gap: 6, flexShrink: 0, alignItems: "center" } },
              H("a", {
                href: registryDocUrl(ext), target: "_blank", rel: "noopener noreferrer",
                style: { ...btnStyle, textDecoration: "none", display: "inline-block", lineHeight: "22px" },
              }, T("ext.docs")),
              src ? H("button", {
                type: "button", disabled: installBusy,
                onClick: () => void runOp("install", { source: src, docsUrl: registryDocUrl(ext), publisherHint: ext.publisher || ext.author }),
                style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" },
              }, installBusy ? "…" : installed ? T("ext.update") : T("ext.install"))
              : H("span", { style: { fontSize: 10, color: "var(--text-dim)", maxWidth: 120, textAlign: "right" } }, T("ext.noSource")),
              installed && H("button", {
                type: "button", onClick: () => setState({ selected: { kind: "local", id: ext.id }, error: null, message: null }),
                style: btnStyle,
              }, T("ext.detail")),
            ),
          );
        })),
      ),
    ),

    // 已信任发行者管理（VSCode 式信任名单：列出 + 撤销）。
    H("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      H("div", { style: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" } },
        H("div", { style: { fontSize: 12, fontWeight: 700, color: "var(--text)" } }, "🤝 " + T("ext.trustedPublishers")),
        H("span", { style: { fontSize: 11, color: "var(--text-dim)" } }, "(" + (state.trustedPublishers || []).length + ")"),
        H("button", {
          type: "button",
          onClick: () => void refreshTrusted(),
          style: { ...btnStyle, padding: "3px 10px", fontSize: 11, marginLeft: "auto" },
        }, "↻"),
      ),
      (state.trustedPublishers || []).length === 0
        ? H("div", { style: { fontSize: 12, color: "var(--text-dim)" } }, T("ext.trustedEmpty"))
        : H("div", { style: { display: "flex", flexDirection: "column", gap: 5, maxHeight: 240, overflowY: "auto" } },
            state.trustedPublishers.map((t) => {
              const key = (t.name && t.name.trim()) || t.fingerprint || "?";
              const label = (t.name && t.name.trim()) || (t.fingerprint ? T("ext.publisherUnknown") + " · " + t.fingerprint : "?");
              const busy = state.busyKey === "untrust:" + key;
              return H("div", {
                key: key + ":" + t.trustedAt,
                style: {
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 10px",
                  borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-panel)",
                },
              },
                H("span", { style: { fontSize: 12, fontWeight: 600, color: "var(--text)", minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, label),
                H("span", { style: chipStyle("var(--text-muted)", "var(--bg-hover)") }, publisherSourceLabel(t.source)),
                t.url && H("a", { href: t.url, target: "_blank", rel: "noopener noreferrer", title: t.url, style: { color: "var(--accent)", fontSize: 11, textDecoration: "none", flexShrink: 0 } }, "↗"),
                H("button", {
                  type: "button", disabled: busy,
                  onClick: () => void runOp("untrust", { name: key }),
                  style: { ...btnStyle, padding: "3px 10px", fontSize: 11, color: "var(--danger, #ef4444)", flexShrink: 0 },
                }, busy ? "…" : T("ext.untrustPublisher")),
              );
            })),
    ),
  );
}

function SourceDetail({ source }) {
  const [, force] = useState_(0);
  useEffect_(() => {
    const l = () => force((v) => v + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);

  const installBusy = state.busyKey && state.busyKey.indexOf("install:") === 0;
  const kind = /^(git:|git@|https?:\/\/)/i.test(source) ? "git"
    : /^(npm:|@)/i.test(source) ? "npm" : "path";

  return H("div", { style: { display: "flex", flexDirection: "column", gap: 18, maxWidth: 680 } },
    H("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
      H("span", { style: { fontSize: 18 } }, "⬇"),
      H("div", { style: { fontSize: 14, fontWeight: 700, color: "var(--text)" } }, T("ext.installFromSource")),
    ),
    H("div", {
      style: {
        fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text)",
        background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6,
        padding: "10px 12px", overflowWrap: "anywhere",
      },
    }, source),
    H("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
      H("span", { style: { ...chipStyle("var(--text-muted)", "var(--bg-hover)"), fontFamily: "var(--font-mono)" } }, kind),
      H("span", { style: { fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" } },
        T("ext.installTo") + ": " + (state.status ? shortenPath(state.status.extensionsRoot) + "/<id>" : "~/.pi/web/extensions/<id>")),
      H("button", {
        type: "button", disabled: installBusy,
        onClick: () => void runOp("install", { source }),
        style: { ...btnStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" },
      }, installBusy ? T("ext.installing") : T("ext.install")),
    ),
  );
}

// ---------- 注册 ----------
export default function register(ctx) {
  const { h, useState, useEffect, useRef, t, apiUrl } = ctx;
  H = h; useState_ = useState; useEffect_ = useEffect; useRef_ = useRef; T = t; API = apiUrl;
  ctxReload = typeof ctx.reloadExtensions === "function" ? ctx.reloadExtensions : null;
  ctxLoaderState = typeof ctx.extLoaderState === "function" ? ctx.extLoaderState : null;

  // 小屏跟踪
  const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)") : null;
  if (mq) {
    const apply = () => setState({ isMobile: mq.matches });
    apply();
    if (mq.addEventListener) mq.addEventListener("change", apply);
  }

  /* sidebarFooter：侧栏底部快捷操作行按钮（与内置 模型/技能/插件 同一排、同风格） */
  function SidebarFooterButton() {
    return H("button", {
      title: t("ext.title"),
      onClick: () => {
        // 小屏打开默认全屏展开（可 🗗 还原小窗）；列表折叠保持用户上次选择
        setState({ open: true, maximized: state.isMobile, error: null, message: null, zBack: false });
        void refreshStatus();
        void refreshTrusted();
        if (ctxLoaderState) setState({ loader: ctxLoaderState() });
      },
      style: {
        flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        height: 32, padding: 0, background: "none", border: "none",
        borderRadius: 9, color: "var(--text-muted)", cursor: "pointer",
        fontSize: 12, transition: "background 0.12s, color 0.12s",
      },
      onMouseEnter: (e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; },
      onMouseLeave: (e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; },
    },
      H("svg", { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
        H("path", { d: "M12 2v4M12 18v4M2 12h4M18 12h4" }),
        H("circle", { cx: 12, cy: 12, r: 4 })),
      t("ext.shortLabel"));
  }

  ctx.registerItems("sidebarFooter", [{ id: "aiti-extman-open", render: SidebarFooterButton }]);
  ctx.registerItems("dialogs", [{ id: "aiti-extman-panel", render: ExtManPanel }]);
}