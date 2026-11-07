/**
 * aiti-sheet-univer · 视图（provider.render 挂载回调，纯 DOM 无 JSX）。
 *
 * 数据流（§2.1）：
 *   打开 → host.readFile（票据流式字节）→ exceljs load → 转换桥 → Univer IWorkbookData → 渲染
 *   保存 → Univer getSnapshot → 转换桥回 exceljs writeBuffer → host.save(ArrayBuffer)
 *        → ContentProvider.write（本扩展 save-blob route，409 冲突沿用 aiti-editor 范式）
 * .xls/.ods 只读链：@e965/xlsx 解析 → HTML 表格只读预览（编辑引导「另存 .xlsx」）。
 */
import { toUniverSnapshot, fromUniverSnapshot } from "./bridge";
import { loadExcelJS, loadXlsx, createSheetEditor, type SheetEditorInstance } from "./sheet-vendor";
import { buildSofficeMissingPanel } from "../../../_shared/soffice-panel";
import { uiConfirm, uiPrompt } from "../../../_shared/ui-dialogs";

/** 活动实例表：filePath → 当前视图的快照/时间戳（ContentProvider.write 持久化时查） */
const activeInstances = new Map<string, { getSnapshot: () => any; mtimeRef: { current: number } }>();

/** ContentProvider.write：持久化字节到 save-blob（409 冲突原样抛给上层） */
async function persistBytes(filePath: string, buf: ArrayBuffer, baseMtimeMs: number, cwd?: string): Promise<{ ok: true; mtimeMs: number; size: number }> {
  const apiUrl = (window as any).__aitiSheetUniverApiUrl || ((p: string) => p);
  const r = await fetch(apiUrl("/api/extensions/aiti-sheet-univer/save-blob"), {
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

/** 剥离警告条（可关闭；方案：不支持项保存前明示） */
function warningStrip(messages: string[]): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;color:#92400e;background:#fef3c7;border-bottom:1px solid #fde68a;flex-shrink:0;";
  const text = document.createElement("span");
  text.style.flex = "1 1 auto";
  text.textContent = "⚠ " + [...messages].join("；") + "（保存将剥离这些内容）";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "✕";
  close.title = "关闭提示";
  close.style.cssText = "border:none;background:transparent;cursor:pointer;color:inherit;font-size:12px;";
  close.onclick = () => el.remove();
  el.append(text, close);
  return el;
}

/** 错误态（含「尝试其他编辑器」提示位——打开方式菜单在宿主工具条 ▦） */
function errorPane(title: string, detail: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--danger, #f87171);font-size:13px;padding:16px;text-align:center;";
  const t = document.createElement("div"); t.textContent = title;
  const d = document.createElement("div"); d.style.cssText = "color:var(--text-dim,#888);font-size:12px;word-break:break-all;max-width:80%;"; d.textContent = detail;
  const hint = document.createElement("div"); hint.style.cssText = "color:var(--text-dim,#888);font-size:12px;";
  hint.textContent = "可用工具条「▦ 打开方式」切换其他编辑器";
  el.append(t, d, hint);
  return el;
}

const basename = (fp: string) => fp.split("/").pop() || fp;

/** 加载占位（M1a 收尾：vendor/chunk 首拉 ~2MB gzip 期间给反馈，不再白屏） */
function loadingPane(text: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-sheet-loading", "1");
  el.style.cssText = "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--text-muted,#888);font-size:13px;background:var(--bg,#fff);z-index:5;";
  const spinner = document.createElement("div");
  spinner.style.cssText = "width:22px;height:22px;border-radius:50%;border:2.5px solid var(--border,#e0e0e0);border-top-color:var(--primary,#6366f1);animation:aiti-sheet-spin 0.8s linear infinite;";
  const label = document.createElement("div");
  label.textContent = text;
  el.append(spinner, label);
  if (!document.getElementById("aiti-sheet-spin-style")) {
    const style = document.createElement("style");
    style.id = "aiti-sheet-spin-style";
    style.textContent = "@keyframes aiti-sheet-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
  }
  return el;
}
function clearLoading(container: HTMLElement): void {
  container.querySelectorAll('[data-sheet-loading]').forEach((n) => n.remove());
}

/** 另存为：快照写为新 .xlsx（默认 <名>-副本.xlsx；已存在确认覆盖），成功后打开新文件 */
async function saveAsSheet(host: any, filePath: string, notify: (msg: string, kind: "ok" | "err") => void): Promise<void> {
  const inst = activeInstances.get(filePath);
  if (!inst) throw new Error("编辑器实例未就绪");
  const snap = inst.getSnapshot();
  if (!snap) throw new Error("快照不可用");
  const dir = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
  const name = filePath.split("/").pop() || "book.xlsx";
  const suggested = dir + "/" + name.replace(/(\.[^.]*)$/, "") + "-副本" + (name.match(/\.[^.]*$/)?.[0] || ".xlsx");
  const input = await uiPrompt({ message: "另存为（输入完整路径或当前目录下的文件名）：", value: suggested });
  if (!input || input.trim() === filePath) return;
  const newPath = input.trim();
  const ExcelJS = await loadExcelJS();
  const wb = fromUniverSnapshot(ExcelJS, snap);
  const buf = await wb.xlsx.writeBuffer();
  // 目标已存在 → 确认覆盖
  const apiUrl = (window as any).__aitiSheetUniverApiUrl || ((p: string) => p);
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
  const save = await fetch(apiUrl("/api/extensions/aiti-sheet-univer/save-blob"), {
    method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
    body: JSON.stringify({ filePath: newPath, dataBase64: arrayBufferToBase64(buf) }),
  }).then((x) => x.json());
  if (!save.ok) throw new Error(save.error || "另存失败");
  notify("已另存为 " + (newPath.split("/").pop() || newPath));
  try { (window as any).__aitiEditor?.openFile(newPath); } catch { /* 打开失败静默 */ }
}

/** 保存：Univer snapshot → exceljs → host.save（走 ContentProvider 管线）；冲突 409 → 确认后覆盖 */
async function saveCurrent(host: any, filePath: string, notify: (msg: string, kind: "ok" | "err") => void): Promise<void> {
  const inst = activeInstances.get(filePath);
  if (!inst) throw new Error("编辑器实例未就绪");
  const snap = inst.getSnapshot();
  if (!snap) throw new Error("快照不可用");
  const ExcelJS = await loadExcelJS();
  const wb = fromUniverSnapshot(ExcelJS, snap);
  const buf = await wb.xlsx.writeBuffer();
  try {
    await host.save(buf);
    notify("已保存", "ok");
  } catch (e: any) {
    if (e && e.conflict) {
      if (await uiConfirm({ message: "文件已被外部修改，用当前内容覆盖磁盘版本？", danger: true })) {
        await host.save(buf, { force: true });
        notify("已覆盖外部修改", "ok");
        return;
      }
      notify("已取消覆盖，文件保持未保存", "err");
      return;
    }
    throw e;
  }
}

/**
 * .xlsx/.xlsm 主视图（preview=Univer 只读态 / edit=编辑态）。
 * 返回 { el, dispose }（provider.render 契约）。
 */
export function renderSheetView(host: any, ctx: { filePath: string; capability: "preview" | "edit"; cwd?: string }): { el: HTMLElement; dispose(): void } {
  const filePath = ctx.filePath;
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;background:#fff;position:relative;";
  const viewport = document.createElement("div");
  viewport.style.cssText = "flex:1;min-height:0;position:relative;";
  el.appendChild(viewport);

  let inst: SheetEditorInstance | null = null;
  const mtimeRef = { current: 0 };
  let dead = false;
  // 剥离警告重复显示防抖（同一实例只弹一次）
  let warned = false;

  // 首拉占位（exceljs vendor → Univer chunk，两段加载期间有反馈）
  viewport.appendChild(loadingPane("加载表格引擎…"));

  // 瞬时 toast + Ctrl+S 保存（能力为 edit 时）
  const toast = (msg: string, kind: "ok" | "err") => {
    const t = document.createElement("div");
    t.style.cssText = "position:absolute;top:38px;left:50%;transform:translateX(-50%);z-index:60;pointer-events:none;max-width:70%;padding:6px 14px;border-radius:999px;color:#fff;font-size:12px;box-shadow:0 4px 14px rgba(0,0,0,0.25);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:" + (kind === "err" ? "rgba(220,38,38,0.92)" : "rgba(22,101,52,0.92)") + ";";
    t.textContent = msg;
    el.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s")) return;
    if (ctx.capability !== "edit") return; // 预览态无保存
    e.preventDefault();
    e.stopPropagation();
    saveCurrent(host, filePath, toast).catch((err) => toast(String((err && err.message) || err), "err"));
  };
  window.addEventListener("keydown", onKey, true);

  (async () => {
    const read = await host.readFile();
    if (dead) return;
    mtimeRef.current = read.mtimeMs;
    const ExcelJS = await loadExcelJS();
    if (dead) return;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(read.data);
    if (dead) return;
    const { snapshot, warnings } = toUniverSnapshot(wb, { fileName: basename(filePath) });
    if (warnings.length && !warned) {
      warned = true;
      el.insertBefore(warningStrip(warnings), viewport);
    }
    inst = await createSheetEditor(viewport, snapshot, {
      editable: ctx.capability === "edit",
      onMutation: () => { try { host.markDirty(true); } catch { /* 忽略 */ } },
    });
    if (dead) { inst.dispose(); inst = null; return; }
    clearLoading(viewport);
    activeInstances.set(filePath, {
      getSnapshot: () => { try { return inst ? inst.snapshot() : null; } catch { return null; } },
      mtimeRef,
    });
    // ⋯ 菜单「保存 / 另存为」接线（provider-host → host 契约）
    try {
      host.registerSaveHandler?.(async (mode: "save" | "saveAs") => {
        if (mode === "save") {
          await saveCurrent(host, filePath, toast);
          return;
        }
        await saveAsSheet(host, filePath, toast);
      });
    } catch { /* 契约缺席（旧 aiti-editor）→ 菜单不显示也无碍 */ }
    try { host.markDirty(false); } catch { /* 忽略 */ }
  })().catch((e) => {
    if (dead) return;
    clearLoading(viewport);
    viewport.innerHTML = "";
    viewport.appendChild(errorPane("Excel 文件解析失败", String((e && e.message) || e)));
  });

  return {
    el,
    dispose() {
      dead = true;
      window.removeEventListener("keydown", onKey, true);
      if (activeInstances.get(filePath)) activeInstances.delete(filePath);
      try { inst?.dispose(); } catch { /* 忽略 */ }
      inst = null;
    },
  };
}

/**
 * .xls/.ods 只读视图（@e965/xlsx 解析 → HTML 表格；无编辑——能力联动自动引导 xlsx）。
 */
export function renderLegacySheetView(host: any, ctx: { filePath: string }): { el: HTMLElement; dispose(): void } {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;background:#fff;";
  const viewport = document.createElement("div");
  viewport.style.cssText = "flex:1;min-height:0;overflow:auto;position:relative;";
  el.appendChild(viewport);
  let dead = false;

  // 首拉占位（@e965/xlsx vendor ~930K 期间有反馈）
  viewport.style.position = "relative";
  viewport.appendChild(loadingPane("解析旧格式…"));

  (async () => {
    const read = await host.readFile();
    if (dead) return;
    const XLSX = await loadXlsx();
    if (dead) return;
    clearLoading(viewport);
    const wb = XLSX.read(read.data, { type: "array" });
    let html = "";
    for (const name of wb.SheetNames) {
      html += '<div style="padding:6px 12px;font-weight:600;font-size:12px;color:#888;border-bottom:1px solid #eee;">' + name + "</div>";
      html += XLSX.utils.sheet_to_html(wb.Sheets[name], { header: "", footer: "" });
    }
    viewport.innerHTML = html || '<div style="padding:40px;text-align:center;color:#888;">空工作簿</div>';
    // 表格样式
    const style = document.createElement("style");
    style.textContent = "table.xlstable{border-collapse:collapse;font-size:12px;}table.xlstable td{border:1px solid #e5e7eb;padding:3px 8px;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;}";
    viewport.appendChild(style);
    viewport.querySelectorAll("table").forEach((t) => t.classList.add("xlstable"));
    appendLegacyTip();
    function appendLegacyTip(btnText?: string) {
      const old = el.querySelector("[data-legacy-tip]");
      if (old) old.remove();
      const tip = document.createElement("div");
      tip.setAttribute("data-legacy-tip", "1");
      tip.style.cssText = "position:sticky;bottom:0;display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;color:#92400e;background:#fef3c7;border-top:1px solid #fde68a;flex-shrink:0;";
      const txt = document.createElement("span");
      txt.style.flex = "1 1 auto";
      txt.textContent = btnText ? undefined : "旧格式只读预览；编辑请先另存 .xlsx（或点右侧一键转换）";
      if (btnText) txt.textContent = btnText;
      tip.appendChild(txt);
      tip.appendChild(makeConvertButton());
      el.appendChild(tip);
    }
    function makeConvertButton(): HTMLButtonElement {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "转为 .xlsx 并打开";
      btn.title = "后台转换为同名 -fromxls.xlsx 副本（不覆盖原文件与已有文件）并自动打开";
      btn.style.cssText = "flex-shrink:0;padding:2px 10px;font-size:11px;font-weight:600;border:1px solid var(--warn, #f59e0b);border-radius:6px;background:#fff;cursor:pointer;color:#92400e;";
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "转换中…";
        try {
          const apiUrl = (window as any).__aitiSheetUniverApiUrl || ((p: string) => p);
          const resp = await fetch(apiUrl("/api/extensions/aiti-sheet-univer/convert-saveas"), {
            method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
            body: JSON.stringify({ filePath }),
          });
          const r = await resp.json();
          if (!resp.ok && r.code === "soffice-missing") {
            // soffice 缺失：降级面板（安装/配置指引 + 下载/虚拟环境替代）；可关闭
            const pane = document.createElement("div");
            pane.style.cssText = "position:absolute;inset:0;z-index:20;overflow:hidden;background:var(--bg,#fff);";
            pane.appendChild(buildSofficeMissingPanel({
              apiUrl: (p: string) => apiUrl(p),
              filePath,
              targetLabel: ".xlsx",
              onClose: () => { try { pane.remove(); } catch { /* 忽略 */ } btn.disabled = false; btn.textContent = "转为 .xlsx 并打开"; },
              onRetry: () => { try { pane.remove(); } catch { /* 忽略 */ } btn.disabled = false; btn.click(); },
            }));
            viewport.appendChild(pane);
            return;
          }
          if (!r.ok) throw new Error(r.error || "转换失败");
          appendLegacyTip("已创建 " + (r.newPath || "").split("/").pop() + "，正在打开…");
          try { (window as any).__aitiEditor?.openFile(r.newPath); } catch { /* 打开失败静默 */ }
        } catch (e: any) {
          appendLegacyTip();
          btn.disabled = false;
          btn.textContent = "转为 .xlsx 并打开";
          btn.title = String((e && e.message) || e);
        }
      };
      return btn;
    }
  })().catch((e) => {
    if (dead) return;
    clearLoading(viewport);
    viewport.innerHTML = "";
    viewport.appendChild(errorPane("旧格式解析失败", String((e && e.message) || e)));
  });

  return { el, dispose() { dead = true; } };
}

export { persistBytes, activeInstances, saveCurrent };
