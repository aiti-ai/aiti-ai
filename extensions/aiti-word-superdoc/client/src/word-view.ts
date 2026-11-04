/**
 * aiti-word-superdoc · 视图（provider.render 挂载回调，纯 DOM 无 JSX）。
 *
 * 数据流（方案 §2.3）：
 *   打开 → host.readFile（票据流式字节）→ SuperDoc（viewing=预览 / editing=编辑）
 *   保存 → sd.export({ exportType: DOCX }) → host.save(ArrayBuffer)
 *        → ContentProvider.write（本扩展 save-blob route，409 冲突沿用 aiti-editor 范式）
 * 引擎（superdoc + npm 全家）走 vite 动态 chunk，打开文件才拉取。
 */
import { uiConfirm, uiPrompt } from "../../../_shared/ui-dialogs";

/**
 * 引擎（superdoc + npm 全家）一律**动态** import——静态 import 会把它并进入口图，
 * 每次开页白拉 ~13.8MB（解码）。首次打开 .docx 才拉取；失败可重试。
 * （样式注入提前到 import 之前，与 chunk 并行下载。）
 */
type SuperdocVendor = typeof import("./superdoc-vendor");

/** sd.export() 的 exportType（2.12 只收短名 "docx"，不是 MIME 常量） */
const EXPORT_TYPE_DOCX = ["docx"];

/** 引擎样式文件（vite lib 产物 css 资产，与入口同目录 dist/） */
const ENGINE_CSS_FILE = "aiti-word-superdoc-aiti-word-superdoc.css";
let cssInjected = false;
function injectEngineCss(): void {
  if (cssInjected) return;
  // 支持 assets/dist 与 assets/client 两种部署目录（历史上两处都拷过）
  const m = import.meta.url.match(/^(.*\/assets\/)(?:dist|client)\//);
  if (!m) return;
  cssInjected = true;
  const link = document.createElement("link");
  link.id = "aiti-word-superdoc-css";
  link.rel = "stylesheet";
  link.href = m[1] + "dist/" + ENGINE_CSS_FILE;
  document.head.appendChild(link);
}

let vendorPromise: Promise<SuperdocVendor> | null = null;
function loadSuperdocVendor(): Promise<SuperdocVendor> {
  if (!vendorPromise) {
    injectEngineCss();
    vendorPromise = import("./superdoc-vendor");
    vendorPromise.catch(() => { vendorPromise = null; }); // 失败可重试
  }
  return vendorPromise;
}

/** 活动实例表：filePath → 当前视图（ContentProvider.write / ⋯菜单保存用） */
const activeInstances = new Map<string, { exportBytes: () => Promise<ArrayBuffer>; mtimeRef: { current: number } }>();

/** 加载占位（vendor 首拉 ~11MB 未压缩 / gzip ~2.5MB 期间给反馈，不白屏） */
function loadingPane(text: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-word-loading", "1");
  el.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--text-muted,#888);font-size:13px;background:var(--bg,#fff);z-index:5;";
  const spinner = document.createElement("div");
  spinner.style.cssText = "width:22px;height:22px;border-radius:50%;border:2.5px solid var(--border,#e0e0e0);border-top-color:var(--primary,#6366f1);animation:aiti-word-spin 0.8s linear infinite;";
  const label = document.createElement("div");
  label.textContent = text;
  el.append(spinner, label);
  if (!document.getElementById("aiti-word-spin-style")) {
    const style = document.createElement("style");
    style.id = "aiti-word-spin-style";
    style.textContent = "@keyframes aiti-word-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
  }
  return el;
}

function clearLoading(container: HTMLElement): void {
  container.querySelectorAll("[data-word-loading]").forEach((n) => n.remove());
}

/** 错误态（含「尝试其他编辑器」提示位——打开方式菜单在宿主工具条 ▦） */
function errorPane(title: string, detail: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:#f87171;font-size:13px;padding:16px;text-align:center;";
  const t = document.createElement("div"); t.textContent = title;
  const d = document.createElement("div"); d.style.cssText = "color:var(--text-dim,#888);font-size:12px;word-break:break-all;max-width:80%;"; d.textContent = detail;
  const hint = document.createElement("div"); hint.style.cssText = "color:var(--text-dim,#888);font-size:12px;";
  hint.textContent = "可用工具条「▦ 打开方式」切换其他编辑器";
  el.append(t, d, hint);
  return el;
}

/** ContentProvider.write：持久化字节到 save-blob（409 冲突原样抛给上层） */
async function persistBytes(filePath: string, buf: ArrayBuffer, baseMtimeMs: number, cwd?: string): Promise<{ ok: true; mtimeMs: number; size: number }> {
  const apiUrl = (window as any).__aitiWordSuperdocApiUrl || ((p: string) => p);
  const r = await fetch(apiUrl("/api/extensions/aiti-word-superdoc/save-blob"), {
    method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
    body: JSON.stringify({ filePath, dataBase64: arrayBufferToBase64(buf), baseMtimeMs, cwd }),
  });
  const d = await r.json().catch(() => ({} as any));
  if (r.status === 409 && d.conflict) {
    const err: any = new Error("conflict"); err.conflict = true; err.diskMtimeMs = d.diskMtimeMs;
    throw err;
  }
  if (!r.ok) throw new Error(d.error || "保存失败 (" + r.status + ")");
  return d;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as any);
  }
  return btoa(bin);
}

/** 另存为：导出写为新 .docx（默认 <名>-副本.docx；已存在确认覆盖），成功后打开新文件 */
async function saveAsWord(host: any, filePath: string, notify: (msg: string, kind: "ok" | "err") => void): Promise<void> {
  const inst = activeInstances.get(filePath);
  if (!inst) throw new Error("编辑器实例未就绪");
  const dir = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
  const name = filePath.split("/").pop() || "doc.docx";
  const suggested = dir + "/" + name.replace(/(\.[^.]*)$/, "") + "-副本" + (name.match(/\.[^.]*$/)?.[0] || ".docx");
  const input = await uiPrompt({ message: "另存为（输入完整路径或当前目录下的文件名）：", value: suggested });
  if (!input || input.trim() === filePath) return;
  const newPath = input.trim();
  // 目标已存在 → 确认覆盖
  const apiUrl = (window as any).__aitiWordSuperdocApiUrl || ((p: string) => p);
  const existsR = await (async () => {
    try {
      const t = await fetch(apiUrl("/api/extensions/aiti-editor/ticket"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filePath: newPath }),
      }).then((x) => x.json());
      const st = await fetch(apiUrl("/api/extensions/aiti-editor/t/" + t.ticket + "/stat")).then((x) => x.json());
      return !!st.ok;
    } catch { return false; }
  })();
  if (existsR && !(await uiConfirm({ message: "目标文件已存在：\n" + newPath + "\n覆盖？", danger: true }))) {
    notify("已取消另存", "err");
    return;
  }
  const buf = await inst.exportBytes();
  const save = await fetch(apiUrl("/api/extensions/aiti-word-superdoc/save-blob"), {
    method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
    body: JSON.stringify({ filePath: newPath, dataBase64: arrayBufferToBase64(buf) }),
  }).then((x) => x.json());
  if (!save.ok) throw new Error(save.error || "另存失败");
  notify("已另存为 " + (newPath.split("/").pop() || newPath));
  try { (window as any).__aitiEditor?.openFile(newPath); } catch { /* 打开失败静默 */ }
}

/**
 * .docx 主视图（SuperDoc：preview=viewing 只读 / edit=editing + 内建工具栏）。
 * 返回 { el, dispose }（provider.render 契约）。
 */
export function renderSuperdocView(host: any, ctx: { filePath: string; capability: "preview" | "edit"; cwd?: string }): { el: HTMLElement; dispose(): void } {
  const filePath = ctx.filePath;
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg,#fff);position:relative;";
  // SuperDoc 内建工具栏挂载点（编辑态；viewing 态隐藏）
  const toolbarHost = document.createElement("div");
  toolbarHost.style.cssText = "flex-shrink:0;border-bottom:1px solid var(--border,#e0e0e0);display:none;";
  const viewport = document.createElement("div");
  viewport.style.cssText = "flex:1;min-height:0;position:relative;overflow:hidden;";
  const mount = document.createElement("div");
  mount.style.cssText = "position:absolute;inset:0;overflow:auto;";
  viewport.appendChild(mount);
  el.append(toolbarHost, viewport);
  viewport.appendChild(loadingPane("加载 Word 引擎…（首次约需拉取数 MB）"));

  let dead = false;
  let sd: any = null;
  const mtimeRef = { current: 0 };
  /** 当前实例导出 docx 字节（保存/另存共用） */
  const exportBytes = async (): Promise<ArrayBuffer> => {
    const blob = await sd.export({ exportType: EXPORT_TYPE_DOCX, triggerDownload: false });
    return await blob.arrayBuffer();
  };

  // 瞬时 toast + Ctrl+S 保存（能力为 edit 时）
  const toast = (msg: string, kind: "ok" | "err") => {
    const t = document.createElement("div");
    t.style.cssText = "position:absolute;top:44px;left:50%;transform:translateX(-50%);z-index:600;pointer-events:none;max-width:70%;padding:6px 14px;border-radius:999px;color:#fff;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,0.25);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:" + (kind === "err" ? "rgba(220,38,38,0.92)" : "rgba(22,101,52,0.92)") + ";";
    t.textContent = msg;
    el.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  };
  const saveCurrent = async (): Promise<void> => {
    if (!sd) throw new Error("编辑器实例未就绪");
    const buf = await exportBytes();
    const notifySaved = () => { try { host.markDirty(false); } catch { /* 忽略 */ } toast("已保存", "ok"); };
    try {
      await host.save(buf);
      notifySaved();
    } catch (e: any) {
      if (e && e.conflict) {
        if (await uiConfirm({ message: "文件已被外部修改，用当前内容覆盖磁盘版本？", danger: true })) {
          await host.save(buf, { force: true });
          notifySaved();
          return;
        }
        toast("已取消覆盖，文件保持未保存", "err");
        return;
      }
      throw e;
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s")) return;
    if (ctx.capability !== "edit") return; // 预览态无保存
    e.preventDefault();
    e.stopPropagation();
    saveCurrent().catch((err) => toast(String((err && err.message) || err), "err"));
  };
  window.addEventListener("keydown", onKey, true);

  (async () => {
    // 引擎与文件字节并行拉取（首拉多 MB，别串行等）
    const [vendor, read] = await Promise.all([loadSuperdocVendor(), host.readFile() as Promise<{ data: ArrayBuffer; mtimeMs: number }>]);
    if (dead) return;
    mtimeRef.current = read.mtimeMs;
    const editable = ctx.capability === "edit";
    const inst = await vendor.createSuperdoc(mount, editable ? toolbarHost : null, read.data, {
      editable,
      onUpdate: () => { try { host.markDirty(true); } catch { /* 忽略 */ } },
    });
    if (dead) { try { inst.sd.destroy(); } catch { /* 忽略 */ } return; }
    sd = inst.sd;
    await inst.ready;
    if (dead) return;
    clearLoading(viewport);
    if (editable) toolbarHost.style.display = "block";
    activeInstances.set(filePath, {
      exportBytes,
      mtimeRef,
    });
    // ⋯ 菜单「保存 / 另存为」接线（provider-host → host 契约）
    try {
      host.registerSaveHandler?.(async (mode: "save" | "saveAs") => {
        if (mode === "save") { await saveCurrent(); return; }
        await saveAsWord(host, filePath, toast);
      });
    } catch { /* 契约缺席（旧 aiti-editor）→ 菜单不显示也无碍 */ }
  })().catch((e) => {
    if (dead) return;
    clearLoading(viewport);
    viewport.innerHTML = "";
    viewport.appendChild(errorPane("Word 文档加载失败", String((e && e.message) || e)));
  });

  return {
    el,
    dispose() {
      dead = true;
      window.removeEventListener("keydown", onKey, true);
      if (activeInstances.get(filePath)) activeInstances.delete(filePath);
      try { sd?.destroy(); } catch { /* 忽略 */ }
      sd = null;
    },
  };
}

export { persistBytes, activeInstances };
